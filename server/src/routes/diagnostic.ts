/**
 * /diagnostic routes — live, server-graded, CAT-lite diagnostic (Pass 5).
 *
 * Flow:
 *   POST /diagnostic                  → start a run, serve item #1
 *   POST /diagnostic/:runId/answer    → grade the current item (reveal only)
 *   POST /diagnostic/:runId/next      → serve the next item (may hit Claude)
 *   POST /diagnostic/:runId/finish    → score the run, write a snapshot
 *   GET  /diagnostic/latest           → the user's latest snapshot (or empty)
 *   GET  /diagnostic/trajectory       → snapshot history as score points
 *
 * Grading and item generation are DELIBERATELY split (B-006). Grading is a
 * cheap, local DB operation; generation for vocab/grammar is a multi-second
 * Claude call. When both lived in /answer, the reveal was withheld behind
 * Claude latency and the UI froze after every pick. /answer now returns the
 * graded reveal immediately; the client fetches the next item via /next
 * during the reveal dwell. /next is idempotent: if an unanswered item is
 * already pending it re-serves that item (answer-stripped) instead of
 * generating a new one, which also gives lost-response recovery for free.
 *
 * SECURITY (see SECURITY.md §13):
 *   - Every query is user-scoped via getUserId(req). A runId or responseId is
 *     NEVER trusted for ownership without the user_id predicate — IDOR defense.
 *   - The correct answer + explanation are COLUMN-PRIVATE. A ClientItem sent to
 *     the client NEVER contains correct_answer or explain; grading is
 *     server-side; the verdict + correct choice + explain are revealed only in
 *     the /answer response, after the user has committed a pick. This is the
 *     answer-tampering defense and THE security property of this pass.
 *   - Out-of-order / double answers are rejected 409 (replay defense).
 *   - Item generation (vocab/grammar via Claude) is behind expensiveLimiter on
 *     the routes that can generate (/diagnostic, /:runId/next) and bounded to
 *     ≤4 calls per run by the fixed 8-item, 2-each schedule plus /next's
 *     re-serve-pending idempotency. Grading (/answer) never calls Claude, so
 *     it sits behind cheapLimiter — a limiter 429 can no longer withhold a
 *     reveal the user already earned.
 *
 * Reading/listening items come from the real topik_items pool (no Claude);
 * vocab/grammar items are authored by the Claude proxy from a corpus seed.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter, expensiveLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { query, withTransaction } from '../db/pool.js';
import { ConflictError, NotFoundError, UpstreamError } from '../middleware/errors.js';
import { getClaudeProxy } from '../services/claudeProxy.js';
import type { DiagnosticTargetLevel } from '../services/claude/index.js';
import {
  SEED_THETA,
  bandForTheta,
  nextTheta,
  proficiencyToNumber,
  targetLevelForTheta,
  thetaToNumeric,
  type DiagnosticBand,
} from '../services/diagnostic/cat.js';
import {
  DIMENSION_ORDER,
  RUBRIC_VERSION,
  estimateToScore,
  estimatesByDimension,
  type DiagnosticDimensionKey,
  type ScoredResponse,
} from '../services/diagnostic/scoring.js';
import { sharedPassageFor } from '../services/topik/passages.js';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Types + constants
// ---------------------------------------------------------------------------

/** Fixed, interleaved serve schedule (ordinals 1..8). Interleaving spreads the
 *  adaptivity across all four skills. */
const SCHEDULE: readonly DiagnosticDimensionKey[] = [
  'reading',
  'listening',
  'vocab',
  'grammar',
  'reading',
  'listening',
  'vocab',
  'grammar',
];

const TARGET_ITEM_COUNT = SCHEDULE.length;

type ChoiceId = 'a' | 'b' | 'c' | 'd';
const CHOICE_IDS: readonly ChoiceId[] = ['a', 'b', 'c', 'd'];

interface ChoiceDTO {
  readonly id: ChoiceId;
  readonly kr: string;
  readonly en: string;
}

/** Full server-side item payload (stored as item_payload JSONB). The client
 *  view is an answer-stripped subset built by `toClientItem`. */
interface ServerItem {
  readonly section: DiagnosticDimensionKey;
  readonly sourceKind: 'topik' | 'generated';
  readonly sourceRef: string | null;
  readonly difficulty: number;
  readonly kind: string;
  readonly level: DiagnosticTargetLevel;
  readonly prompt: string;
  readonly hint?: string;
  readonly passage?: string;
  readonly underline?: string;
  readonly audio?: { readonly duration: number; readonly transcript: string };
  readonly choices: readonly ChoiceDTO[];
  /** Correct choice id — NEVER serialized to the client before reveal. */
  readonly correctAnswer: ChoiceId;
  /** Explanation — NEVER serialized to the client before reveal. */
  readonly explain: string;
}

/** Answer-stripped item the client receives. */
interface ClientItem {
  readonly responseId: number;
  readonly ordinal: number;
  readonly section: DiagnosticDimensionKey;
  readonly level: DiagnosticTargetLevel;
  readonly kind: string;
  readonly prompt: string;
  readonly hint?: string;
  readonly passage?: string;
  readonly underline?: string;
  readonly audio?: { duration: number; transcript: string };
  readonly choices: ChoiceDTO[];
}

/** Strip the answer + explanation from a server item for the wire. */
function toClientItem(responseId: number, ordinal: number, item: ServerItem): ClientItem {
  return {
    responseId,
    ordinal,
    section: item.section,
    level: item.level,
    kind: item.kind,
    prompt: item.prompt,
    ...(item.hint !== undefined ? { hint: item.hint } : {}),
    ...(item.passage !== undefined ? { passage: item.passage } : {}),
    ...(item.underline !== undefined ? { underline: item.underline } : {}),
    ...(item.audio !== undefined ? { audio: { ...item.audio } } : {}),
    choices: item.choices.map((c) => ({ id: c.id, kr: c.kr, en: c.en })),
  };
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const DEFAULT_AUDIO_DURATION_S = 40;

/** A topik_items row, as selected for a diagnostic. */
interface TopikRow {
  id: string;
  section: string;
  proficiency: string | null;
  stem: string | null;
  prompt: string | null;
  underline: string | null;
  options: unknown;
  answer: unknown;
  extra: Record<string, unknown> | null;
  /** This item's number within its test — used to resolve a shared passage. */
  item_number: number;
  /**
   * The parent test's `passages` JSONB (migration 005): an object keyed by
   * item-number range ("19-20", "21-22", …) carrying the reading passage shared
   * by those items. Reading items whose own `stem` is empty depend on this; the
   * diagnostic resolves the covering range so the question text isn't blank.
   */
  test_passages: Record<string, unknown> | null;
}

/**
 * Pick one topik_items row for `section` near `band`, excluding ids already
 * served in this run. Widens band → any band if the targeted band is empty.
 * Returns null only when the section pool is genuinely empty.
 *
 * Band → proficiency mapping: we filter on the row's `proficiency` enum, but
 * because the corpus tagging is sparse, an unmatched band falls through to "any
 * proficiency" rather than returning nothing.
 */
async function pickTopikRow(
  section: 'reading' | 'listening',
  band: DiagnosticBand,
  excludeIds: readonly string[],
): Promise<TopikRow | null> {
  const bandProf = band === 'basic' ? 'L3' : band; // topik proficiency has no 'basic' target separate from L3 use
  // 1) Try the targeted band, then 2) any band. Each excludes already-served ids.
  const attempts: ReadonlyArray<{ readonly proficiency: string | null }> = [
    { proficiency: bandProf },
    { proficiency: null },
  ];
  for (const attempt of attempts) {
    const params: unknown[] = [section];
    // JOIN topik_tests to carry the test's `passages` JSONB (shared reading
    // passages keyed by item-number range, migration 005) so buildTopikItem can
    // resolve the passage covering this item's `item_number`. Columns are
    // qualified with the `i` alias because the join introduces a second `id`.
    let sql = `SELECT i.id::text AS id, i.section::text AS section,
                      i.proficiency::text AS proficiency,
                      i.stem, i.prompt, i.underline, i.options, i.answer, i.extra,
                      i.item_number, t.passages AS test_passages
                 FROM topik_items i
                 JOIN topik_tests t ON t.id = i.topik_test_id
                WHERE i.section = $1::topik_section
                  AND i.options IS NOT NULL
                  AND jsonb_array_length(i.options) >= 2
                  AND i.answer IS NOT NULL`;
    if (attempt.proficiency !== null) {
      params.push(attempt.proficiency);
      sql += ` AND i.proficiency = $${params.length}::proficiency_level`;
    }
    if (excludeIds.length > 0) {
      params.push(excludeIds);
      sql += ` AND i.id::text <> ALL($${params.length}::text[])`;
    }
    sql += ` ORDER BY random() LIMIT 1`;
    const { rows } = await query<TopikRow>(sql, params);
    if (rows[0]) return rows[0];
  }
  return null;
}

/** Coerce a topik_items `options` JSONB array into 4 (or fewer) typed choices. */
function topikChoices(options: unknown): ChoiceDTO[] {
  if (!Array.isArray(options)) return [];
  return options
    .slice(0, CHOICE_IDS.length)
    .map((opt, i) => ({
      id: CHOICE_IDS[i]!,
      kr: typeof opt === 'string' ? opt : String(opt ?? ''),
      en: '',
    }));
}

/** Map a topik_items `answer` (int 1..4) to a choice id, bounded to the
 *  available choices. Returns null when the answer is unusable. */
function topikCorrectChoice(answer: unknown, choiceCount: number): ChoiceId | null {
  const n = typeof answer === 'number' ? answer : Number(answer);
  if (!Number.isInteger(n) || n < 1 || n > choiceCount) return null;
  return CHOICE_IDS[n - 1] ?? null;
}

/**
 * Build a reading/listening ServerItem from a topik row. Returns null if the
 * row cannot yield a valid MC item (no usable answer / too few choices).
 *
 * Listening items carry a best-effort `audio` block: the corpus has NO audio
 * files, so we surface the transcript text only (stem / extra.transcript) and a
 * default duration. This is a known limitation, documented in SECURITY.md §13.
 */
function buildTopikItem(
  section: 'reading' | 'listening',
  row: TopikRow,
  band: DiagnosticBand,
): ServerItem | null {
  const choices = topikChoices(row.options);
  if (choices.length < 2) return null;
  const correct = topikCorrectChoice(row.answer, choices.length);
  if (correct === null) return null;

  const difficulty =
    row.proficiency !== null
      ? proficiencyToNumber(row.proficiency as 'basic' | 'L3' | 'L4' | 'L5+')
      : proficiencyToNumber(band === 'basic' ? 'L3' : band);
  const level: DiagnosticTargetLevel = band === 'basic' ? 'L3' : band;
  const prompt = (row.prompt ?? row.stem ?? '').trim() || '다음 질문에 답하세요.';

  // The passage text the item depends on: its OWN `stem` first, else the shared
  // passage from the parent test keyed by this item's number range (migration
  // 005 `topik_tests.passages`). Without this, items that share a passage —
  // whose own `stem` is empty because the body lives in the test's `passages` —
  // rendered with only the instruction + options and NO question text. (B1 fix.)
  const ownStem = row.stem !== null && row.stem.trim().length > 0 ? row.stem : null;
  const passageText = ownStem ?? sharedPassageFor(row.test_passages, row.item_number);

  const base: ServerItem = {
    section,
    sourceKind: 'topik',
    sourceRef: row.id,
    difficulty,
    kind:
      section === 'listening'
        ? 'audio-mc'
        : passageText !== null
          ? 'passage-mc'
          : 'inference',
    level,
    prompt,
    choices,
    correctAnswer: correct,
    explain: '', // topik items ship no explanation; reveal shows the correct choice only
  };

  if (section === 'reading' && passageText !== null) {
    return { ...base, passage: passageText, ...(row.underline ? { underline: row.underline } : {}) };
  }
  if (section === 'listening') {
    const extra = row.extra ?? {};
    const durationRaw = extra['duration'];
    const duration =
      typeof durationRaw === 'number' && durationRaw > 0 ? durationRaw : DEFAULT_AUDIO_DURATION_S;
    // Transcript fallback chain: explicit extra.transcript, then the item's own
    // stem, then the shared passage (a dialogue body shared across listening
    // items lives in the test's passages too).
    const transcript =
      (typeof extra['transcript'] === 'string' ? extra['transcript'] : '') ||
      passageText ||
      '';
    return { ...base, audio: { duration, transcript } };
  }
  return base;
}

/** A corpus seed for a generated (vocab/grammar) item. */
interface GenSeed {
  readonly sourceRef: string;
  readonly seedKorean: string;
  readonly seedEnglish?: string;
  readonly seedGloss?: string;
}

/** Pick a vocab_entries seed near the target band. Falls back to any band. */
async function pickVocabSeed(target: DiagnosticTargetLevel): Promise<GenSeed | null> {
  for (const proficiency of [target, null] as const) {
    const params: unknown[] = [];
    let sql = `SELECT id::text AS id, korean, english
                 FROM vocab_entries
                WHERE korean IS NOT NULL AND length(korean) >= 1`;
    if (proficiency !== null) {
      params.push(proficiency);
      sql += ` AND proficiency = $${params.length}::proficiency_level`;
    }
    sql += ` ORDER BY random() LIMIT 1`;
    const { rows } = await query<{ id: string; korean: string; english: string | null }>(sql, params);
    const row = rows[0];
    if (row) {
      return {
        sourceRef: row.id,
        seedKorean: row.korean,
        ...(row.english ? { seedEnglish: row.english } : {}),
      };
    }
  }
  return null;
}

/** Pick a kgiu_entries grammar seed near the target band. Falls back to any. */
async function pickGrammarSeed(target: DiagnosticTargetLevel): Promise<GenSeed | null> {
  for (const proficiency of [target, null] as const) {
    const params: unknown[] = [];
    let sql = `SELECT id::text AS id, pattern, title_en, explanation
                 FROM kgiu_entries
                WHERE pattern IS NOT NULL AND length(pattern) >= 1`;
    if (proficiency !== null) {
      params.push(proficiency);
      sql += ` AND proficiency = $${params.length}::proficiency_level`;
    }
    sql += ` ORDER BY random() LIMIT 1`;
    const { rows } = await query<{
      id: string;
      pattern: string;
      title_en: string | null;
      explanation: string | null;
    }>(sql, params);
    const row = rows[0];
    if (row) {
      return {
        sourceRef: row.id,
        seedKorean: row.pattern,
        ...(row.title_en ? { seedEnglish: row.title_en } : {}),
        ...(row.explanation ? { seedGloss: row.explanation.slice(0, 500) } : {}),
      };
    }
  }
  return null;
}

/**
 * Build a generated (vocab/grammar) ServerItem via the Claude proxy. Returns
 * null when no seed exists for the section (empty corpus) — the caller then
 * skips this ordinal. Claude errors surface as UpstreamError to the route.
 */
async function buildGeneratedItem(
  section: 'vocab' | 'grammar',
  theta: number,
  correlationId: string | undefined,
  userId: number,
): Promise<ServerItem | null> {
  const target = targetLevelForTheta(theta);
  const seed = section === 'vocab' ? await pickVocabSeed(target) : await pickGrammarSeed(target);
  if (seed === null) return null;

  const proxy = getClaudeProxy();
  const { result } = await proxy.generateDiagnosticItem(
    {
      section,
      targetLevel: target,
      seedKorean: seed.seedKorean,
      ...(seed.seedEnglish !== undefined ? { seedEnglish: seed.seedEnglish } : {}),
      ...(seed.seedGloss !== undefined ? { seedGloss: seed.seedGloss } : {}),
    },
    { ...(correlationId !== undefined ? { requestId: correlationId } : {}), userId },
  );

  // The model's `kind` is schema-valid against the full generable union
  // (synonym|cloze|pattern) regardless of section, so we enforce the
  // section↔kind contract here (contract §B): vocab items are synonym/cloze,
  // grammar items are pattern. A mismatch means the model ignored the prompt's
  // rule #4 — reject it as an upstream error rather than serve a mislabeled
  // item to the learner (the pill would show the wrong skill).
  const kindOk =
    section === 'grammar' ? result.kind === 'pattern' : result.kind !== 'pattern';
  if (!kindOk) {
    throw new UpstreamError(
      `generated ${section} item has mismatched kind '${result.kind}'`,
    );
  }

  // For GENERATED items we drop the per-choice English gloss (en: ''). On a
  // synonym item the correct choice's gloss is, by construction, the seed word's
  // meaning — surfacing it would hand the learner the answer without reading the
  // Korean, inflating the vocab estimate (measurement-validity leak,
  // REVIEW_P5_logic SF-2). The Korean choice text IS the question; the gloss is
  // a decorative oracle we don't need. This mirrors topik items, whose choices
  // already carry en:'' (see topikChoices), keeping both item sources
  // consistent. The dropped gloss is not load-bearing anywhere server-side:
  // grading uses correct_answer and scoring uses difficulty, neither of which
  // touches `en`.
  const choices: ChoiceDTO[] = result.choices.map((c, i) => ({
    id: CHOICE_IDS[i]!,
    kr: c.kr,
    en: '',
  }));
  const correct = CHOICE_IDS[result.answerIndex];
  if (correct === undefined) {
    // answerIndex is schema-bounded 0..3 with exactly 4 choices; this is a
    // belt-and-suspenders guard so a future schema relaxation can't ship an
    // out-of-range index silently.
    throw new UpstreamError('generated item answerIndex out of range');
  }

  return {
    section,
    sourceKind: 'generated',
    sourceRef: seed.sourceRef,
    difficulty: proficiencyToNumber(target),
    kind: result.kind,
    level: target,
    prompt: result.prompt,
    choices,
    correctAnswer: correct,
    explain: result.explain,
  };
}

/**
 * Build the next ServerItem for `section` at the current θ, excluding topik ids
 * already served. Returns null when the section pool/seed is empty (the caller
 * serves fewer items and scores only answered dims).
 */
async function buildItemForSection(
  section: DiagnosticDimensionKey,
  theta: number,
  excludeTopikIds: readonly string[],
  correlationId: string | undefined,
  userId: number,
): Promise<ServerItem | null> {
  const band = bandForTheta(theta);
  if (section === 'reading' || section === 'listening') {
    // Try the band, widening inside pickTopikRow; then try building. If a row
    // can't yield a valid MC item, treat as empty (rare — guarded selection).
    const row = await pickTopikRow(section, band, excludeTopikIds);
    if (row === null) return null;
    return buildTopikItem(section, row, band);
  }
  return buildGeneratedItem(section, theta, correlationId, userId);
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

interface RunRow {
  id: string;
  user_id: string;
  status: string;
  ability_estimate: string | null;
  target_item_count: number;
  snapshot_id: string | null;
}

interface ResponseRow {
  id: string;
  ordinal: number;
  section: DiagnosticDimensionKey;
  source_kind: 'topik' | 'generated';
  source_ref: string | null;
  difficulty: string;
  kind: string;
  correct_answer: string;
  picked: string | null;
  is_correct: boolean | null;
  answered_at: Date | null;
}

/** Load a run scoped to the user. Throws NotFound if it isn't theirs. */
async function loadUserRun(runId: number, userId: number): Promise<RunRow> {
  const { rows } = await query<RunRow>(
    `SELECT id::text AS id, user_id::text AS user_id, status,
            ability_estimate, target_item_count, snapshot_id::text AS snapshot_id
       FROM diagnostic_runs
      WHERE id = $1 AND user_id = $2`,
    [runId, userId],
  );
  const run = rows[0];
  if (!run) throw new NotFoundError('diagnostic run not found');
  return run;
}

/** Persist a served item as a diagnostic_responses row; return its id. */
async function insertResponse(
  runId: number,
  ordinal: number,
  item: ServerItem,
): Promise<number> {
  const payload = {
    section: item.section,
    kind: item.kind,
    level: item.level,
    prompt: item.prompt,
    ...(item.hint !== undefined ? { hint: item.hint } : {}),
    ...(item.passage !== undefined ? { passage: item.passage } : {}),
    ...(item.underline !== undefined ? { underline: item.underline } : {}),
    ...(item.audio !== undefined ? { audio: item.audio } : {}),
    choices: item.choices,
    explain: item.explain,
  };
  const { rows } = await query<{ id: string }>(
    `INSERT INTO diagnostic_responses (
        run_id, ordinal, section, source_kind, source_ref,
        difficulty, kind, item_payload, correct_answer)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     RETURNING id::text AS id`,
    [
      runId,
      ordinal,
      item.section,
      item.sourceKind,
      item.sourceRef,
      item.difficulty,
      item.kind,
      JSON.stringify(payload),
      item.correctAnswer,
    ],
  );
  return Number(rows[0]!.id);
}

/** topik source_refs already served in this run (to avoid repeats). */
async function servedTopikIds(runId: number): Promise<string[]> {
  const { rows } = await query<{ source_ref: string }>(
    `SELECT source_ref FROM diagnostic_responses
      WHERE run_id = $1 AND source_kind = 'topik' AND source_ref IS NOT NULL`,
    [runId],
  );
  return rows.map((r) => r.source_ref);
}

/**
 * Serve items for ordinals [fromOrdinal..target], advancing through the
 * SCHEDULE, until one is successfully served (returns it) or the run is
 * exhausted (returns null — finish will score only answered dims).
 *
 * Skips ordinals whose section pool is empty: we record nothing for them and
 * move on, so the run can serve fewer items without ever 500-ing.
 */
async function serveNextItem(
  runId: number,
  fromOrdinal: number,
  theta: number,
  correlationId: string | undefined,
  userId: number,
): Promise<{ responseId: number; ordinal: number; item: ServerItem } | null> {
  for (let ordinal = fromOrdinal; ordinal <= TARGET_ITEM_COUNT; ordinal += 1) {
    const section = SCHEDULE[ordinal - 1]!;
    const exclude = await servedTopikIds(runId);
    const item = await buildItemForSection(section, theta, exclude, correlationId, userId);
    if (item === null) continue; // empty pool — skip this ordinal
    const responseId = await insertResponse(runId, ordinal, item);
    return { responseId, ordinal, item };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Snapshot DTO
// ---------------------------------------------------------------------------

interface SnapshotDimensionDTO {
  readonly key: DiagnosticDimensionKey;
  readonly label: string;
  readonly kr: string;
  readonly score: number;
  readonly note: string;
}

interface SnapshotDTO {
  readonly dimensions: SnapshotDimensionDTO[];
  readonly references: ReadonlyArray<{ id: string; label: string; kr: string; value: number }>;
  readonly defaultRef: string;
  readonly goals: string[];
}

const DIMENSION_LABELS: Record<DiagnosticDimensionKey, { label: string; kr: string }> = {
  reading: { label: 'Reading', kr: '읽기' },
  listening: { label: 'Listening', kr: '듣기' },
  vocab: { label: 'Vocabulary', kr: '어휘' },
  grammar: { label: 'Grammar', kr: '문법' },
};

const REFERENCES: SnapshotDTO['references'] = [
  { id: 'L3', label: 'TOPIK 3', kr: '3급', value: 40 },
  { id: 'L4', label: 'TOPIK 4', kr: '4급', value: 55 },
  { id: 'L5', label: 'TOPIK 5', kr: '5급', value: 70 },
  { id: 'L6', label: 'TOPIK 6', kr: '6급', value: 85 },
  { id: 'native', label: 'Native', kr: '원어민', value: 100 },
];

/** Templated, deterministic note per score band. */
function noteForScore(score: number): string {
  if (score < 50) return 'Below TOPIK 4 — focus here';
  if (score < 70) return 'Approaching TOPIK 4–5';
  return 'Strong';
}

/** The empty snapshot returned by /latest when the user has no run yet.
 *  Matches the client's DIAGNOSTIC_SNAPSHOT_FIXTURE (dimensions:[]). */
function emptySnapshot(): SnapshotDTO {
  return { dimensions: [], references: REFERENCES, defaultRef: 'L4', goals: [] };
}

/** Build the SnapshotDTO from the four stored estimates. */
function buildSnapshotDTO(
  estimates: Partial<Record<DiagnosticDimensionKey, number | null>>,
): SnapshotDTO {
  const dimensions: SnapshotDimensionDTO[] = [];
  for (const key of DIMENSION_ORDER) {
    const est = estimates[key];
    if (est === undefined || est === null) continue;
    const score = estimateToScore(est);
    const labels = DIMENSION_LABELS[key];
    dimensions.push({ key, label: labels.label, kr: labels.kr, score, note: noteForScore(score) });
  }
  const goals: string[] = [];
  if (dimensions.length > 0) {
    const weakest = dimensions.reduce((min, d) => (d.score < min.score ? d : min), dimensions[0]!);
    if (weakest.score < 70) {
      goals.push(`Build ${weakest.label.toLowerCase()} with daily focused drills.`);
    }
  }
  return { dimensions, references: REFERENCES, defaultRef: 'L4', goals };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const EmptyBodySchema = z.object({}).strict();
const RunParamsSchema = z.object({
  runId: z.coerce.number().int().positive(),
});
const AnswerBodySchema = z.object({
  responseId: z.number().int().positive(),
  picked: z.union([z.enum(['a', 'b', 'c', 'd']), z.null()]),
  timeMs: z.number().int().nonnegative().max(60 * 60 * 1000).optional(),
});

/**
 * POST /diagnostic — start a run and serve item #1.
 * expensiveLimiter: may trigger a Claude generation for the first item.
 */
router.post('/', expensiveLimiter(), validateBody(EmptyBodySchema), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const theta = SEED_THETA;

    // Create the run first (its own row), then serve ordinal 1. Serving touches
    // Claude (external I/O), so it is deliberately OUTSIDE any DB transaction
    // (Bar §"Transactions": no external I/O in an open tx).
    const { rows } = await query<{ id: string }>(
      `INSERT INTO diagnostic_runs (user_id, target_item_count)
       VALUES ($1, $2)
       RETURNING id::text AS id`,
      [userId, TARGET_ITEM_COUNT],
    );
    const runId = Number(rows[0]!.id);

    const served = await serveNextItem(runId, 1, theta, req.correlationId, userId);
    if (served === null) {
      // No section pool could produce even one item. Rather than a dead run,
      // surface a clear error — the corpora are required reference data.
      throw new UpstreamError('no diagnostic items available');
    }

    res.status(201).json({
      runId,
      item: toClientItem(served.responseId, served.ordinal, served.item),
      progress: { ordinal: served.ordinal, total: TARGET_ITEM_COUNT },
    });
  } catch (err) {
    next(mapClaudeError(err));
  }
});

/**
 * POST /diagnostic/:runId/answer — grade the current item and return the
 * reveal. Does NOT serve the next item: grading is cheap local DB work and
 * must never block on Claude (B-006) — the client calls /:runId/next for the
 * following item during the reveal dwell. cheapLimiter for the same reason:
 * nothing here is expensive, and an expensive-bucket 429 must not be able to
 * withhold the reveal for an answer the user already committed.
 */
router.post(
  '/:runId/answer',
  cheapLimiter(),
  validateParams(RunParamsSchema),
  validateBody(AnswerBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const params = (req as typeof req & {
        validatedParams: z.infer<typeof RunParamsSchema>;
      }).validatedParams;
      const body = req.body as z.infer<typeof AnswerBodySchema>;

      // Confirm the run is the caller's before we touch anything (IDOR → 404).
      // The authoritative status/θ/single-shot checks happen under FOR UPDATE
      // inside the transaction below; we keep `target_item_count` from this read
      // (it is immutable for the run's lifetime) to decide when to stop serving.
      const run = await loadUserRun(params.runId, userId);

      // Grade + θ-bump + the single-shot transition all happen inside ONE
      // transaction that locks the run row FOR UPDATE. This closes the
      // concurrent-double-answer race (B1): two simultaneous /answer calls for
      // the same item serialize on the lock; the first commits the answer + θ,
      // the second re-reads `answered_at IS NULL`, finds the item already
      // answered, and throws 409 WITHOUT a second θ bump or a second served
      // item. The FOR UPDATE re-check of `status` also closes the answer-vs-
      // finish TOCTOU (S3), and deriving the answer ordinal under the lock
      // makes the staircase step number deterministic under concurrency (S4).
      const graded = await withTransaction(async (client) => {
        const { rows: lockRows } = await client.query<{
          status: string;
          ability_estimate: string | null;
        }>(
          `SELECT status, ability_estimate
             FROM diagnostic_runs
            WHERE id = $1
            FOR UPDATE`,
          [params.runId],
        );
        const locked = lockRows[0];
        // loadUserRun already proved ownership; the row must exist here.
        if (!locked) throw new NotFoundError('diagnostic run not found');
        if (locked.status !== 'in_progress') {
          throw new ConflictError('diagnostic run is not in progress');
        }

        // The "current unanswered item" is the lowest-ordinal response with no
        // answered_at. Re-read it UNDER THE LOCK so the grade and the single-
        // shot UPDATE see the same row. The client must answer exactly this one.
        const { rows: pendingRows } = await client.query<ResponseRow>(
          `SELECT id::text AS id, ordinal, section, source_kind,
                  source_ref, difficulty::text AS difficulty, kind,
                  correct_answer, picked, is_correct, answered_at
             FROM diagnostic_responses
            WHERE run_id = $1 AND answered_at IS NULL
            ORDER BY ordinal ASC
            LIMIT 1`,
          [params.runId],
        );
        const current = pendingRows[0];
        if (!current) {
          throw new ConflictError('no unanswered item to answer');
        }
        if (Number(current.id) !== body.responseId) {
          // Out-of-order or double-answer — replay defense.
          throw new ConflictError('responseId does not match the current item');
        }

        // Grade server-side. A skip (picked null) is is_correct=false.
        const isCorrect = body.picked !== null && body.picked === current.correct_answer;

        // CAT step number = (answers already recorded) + 1, counted UNDER THE
        // LOCK so a racing request can't inflate it (S4).
        const { rows: answeredCountRows } = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM diagnostic_responses
            WHERE run_id = $1 AND answered_at IS NOT NULL`,
          [params.runId],
        );
        const answerNumber = Number(answeredCountRows[0]!.n) + 1;
        const priorTheta =
          locked.ability_estimate !== null ? Number(locked.ability_estimate) : SEED_THETA;
        const updatedTheta = nextTheta(priorTheta, isCorrect, answerNumber);

        // Single-shot transition. If a concurrent request already answered this
        // item, rowCount is 0 — abort with 409 and DO NOT bump θ or serve next.
        const upd = await client.query(
          `UPDATE diagnostic_responses
              SET picked = $2, is_correct = $3, time_ms = $4, answered_at = now()
            WHERE id = $1 AND run_id = $5 AND answered_at IS NULL`,
          [body.responseId, body.picked, isCorrect, body.timeMs ?? null, params.runId],
        );
        if (upd.rowCount !== 1) {
          throw new ConflictError('responseId does not match the current item');
        }
        await client.query(
          `UPDATE diagnostic_runs
              SET ability_estimate = $2, version = version + 1
            WHERE id = $1`,
          [params.runId, thetaToNumeric(updatedTheta)],
        );

        return {
          isCorrect,
          correctAnswer: current.correct_answer,
          ordinal: current.ordinal,
        };
      });

      const result = {
        correct: graded.isCorrect,
        correctAnswer: graded.correctAnswer,
        explain: await explainFor(params.runId, body.responseId),
      };

      // `done` = the graded item's ordinal was the last SCHEDULED slot, so no
      // /next call is needed. Based on the just-answered item's ordinal (the
      // highest served, since exactly one item is in flight at a time) — NOT
      // on the answered count, because serving may skip empty-pool ordinals,
      // so served ordinals are not necessarily contiguous. Note the run can
      // also end EARLY (remaining pools empty): the client discovers that when
      // /next returns `next: null`.
      const done = graded.ordinal + 1 > run.target_item_count;
      res.status(200).json({
        result,
        done,
        progress: { ordinal: graded.ordinal, total: run.target_item_count },
      });
    } catch (err) {
      next(mapClaudeError(err));
    }
  },
);

/** Server-authored item payload as persisted by `insertResponse` — the source
 *  of truth /next re-serves a pending item from. `explain` is stored in the
 *  payload but NEVER copied onto the ClientItem (answer-stripping); the
 *  correct answer lives in a separate column and is never here at all. */
interface StoredItemPayload {
  readonly section: DiagnosticDimensionKey;
  readonly kind: string;
  readonly level: DiagnosticTargetLevel;
  readonly prompt: string;
  readonly hint?: string;
  readonly passage?: string;
  readonly underline?: string;
  readonly audio?: { readonly duration: number; readonly transcript: string };
  readonly choices: readonly ChoiceDTO[];
}

/**
 * The lowest-ordinal unanswered response of a run, rebuilt as an
 * answer-stripped ClientItem — or null when nothing is pending. Used by /next
 * for idempotent re-serves (double /next calls, or a client that lost the
 * /next response and retries).
 */
async function pendingClientItem(runId: number): Promise<ClientItem | null> {
  const { rows } = await query<{ id: string; ordinal: number; item_payload: StoredItemPayload }>(
    `SELECT id::text AS id, ordinal, item_payload
       FROM diagnostic_responses
      WHERE run_id = $1 AND answered_at IS NULL
      ORDER BY ordinal ASC
      LIMIT 1`,
    [runId],
  );
  const row = rows[0];
  if (!row) return null;
  // item_payload is server-authored by insertResponse (never client input), so
  // a typed read is safe; optional fields are re-spread exactly like
  // toClientItem so both serve paths produce the same wire shape.
  const p = row.item_payload;
  return {
    responseId: Number(row.id),
    ordinal: row.ordinal,
    section: p.section,
    level: p.level,
    kind: p.kind,
    prompt: p.prompt,
    ...(p.hint !== undefined ? { hint: p.hint } : {}),
    ...(p.passage !== undefined ? { passage: p.passage } : {}),
    ...(p.underline !== undefined ? { underline: p.underline } : {}),
    ...(p.audio !== undefined ? { audio: { ...p.audio } } : {}),
    choices: p.choices.map((c) => ({ id: c.id, kr: c.kr, en: c.en })),
  };
}

/** True for a Postgres unique-constraint violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505'
  );
}

/**
 * POST /diagnostic/:runId/next — serve the run's next item.
 *
 * This is the (possibly) EXPENSIVE half of the answer→next split (B-006):
 * vocab/grammar ordinals generate via Claude, so this route sits behind
 * expensiveLimiter, and the client calls it during the reveal dwell so the
 * latency overlaps reading the explanation instead of blocking the reveal.
 *
 * Contract:
 *   - An unanswered item is already pending → re-serve it (idempotent; no new
 *     row, no Claude call). Covers double-clicks and lost-response retries.
 *   - All served items answered and slots remain → serve the next scheduled
 *     item at the run's current θ.
 *   - Schedule exhausted, or every remaining pool empty → `next: null` (the
 *     client then calls /finish).
 *
 * Concurrency: two racing /next calls can both pass the pending-check and try
 * to insert the same (run_id, ordinal). `uq_diagnostic_responses_run_ordinal`
 * makes the loser's INSERT fail with 23505; we catch that and re-serve the
 * winner's row, so a race can never leave two items in flight (the CAT state
 * machine's one-item invariant holds).
 */
router.post(
  '/:runId/next',
  expensiveLimiter(),
  validateParams(RunParamsSchema),
  validateBody(EmptyBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const params = (req as typeof req & {
        validatedParams: z.infer<typeof RunParamsSchema>;
      }).validatedParams;

      // Ownership first (IDOR → 404), then state: a finished/abandoned run
      // serves nothing more.
      const run = await loadUserRun(params.runId, userId);
      if (run.status !== 'in_progress') {
        throw new ConflictError('diagnostic run is not in progress');
      }
      const total = run.target_item_count;

      // Idempotent re-serve: the current unanswered item, if one exists.
      const pending = await pendingClientItem(params.runId);
      if (pending !== null) {
        res.status(200).json({
          next: pending,
          progress: { ordinal: pending.ordinal, total },
        });
        return;
      }

      // Everything served is answered — advance past the highest served
      // ordinal (ordinals may be non-contiguous when empty pools were skipped).
      const { rows: maxRows } = await query<{ max_ordinal: number | null }>(
        `SELECT max(ordinal) AS max_ordinal FROM diagnostic_responses WHERE run_id = $1`,
        [params.runId],
      );
      const maxServed = maxRows[0]?.max_ordinal ?? 0;
      const nextOrdinal = maxServed + 1;
      if (nextOrdinal > total) {
        res.status(200).json({ next: null, progress: { ordinal: total, total } });
        return;
      }

      // θ as persisted by the last /answer (2-dp NUMERIC, same rounding the
      // /finish trajectory reconstruction assumes). The CAT update itself
      // happened in /answer; this route only READS the estimate to pick the
      // next item's band — scoring/θ logic is untouched by the B-006 split.
      const theta =
        run.ability_estimate !== null ? Number(run.ability_estimate) : SEED_THETA;

      let served: Awaited<ReturnType<typeof serveNextItem>>;
      try {
        served = await serveNextItem(
          params.runId,
          nextOrdinal,
          theta,
          req.correlationId,
          userId,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          // A concurrent /next won the insert race — serve its row instead.
          const raced = await pendingClientItem(params.runId);
          if (raced !== null) {
            res.status(200).json({
              next: raced,
              progress: { ordinal: raced.ordinal, total },
            });
            return;
          }
        }
        throw err;
      }

      if (served === null) {
        // Remaining pools all empty — the run ends early; /finish scores the
        // answered dimensions only.
        res.status(200).json({ next: null, progress: { ordinal: maxServed, total } });
        return;
      }
      res.status(200).json({
        next: toClientItem(served.responseId, served.ordinal, served.item),
        progress: { ordinal: served.ordinal, total },
      });
    } catch (err) {
      next(mapClaudeError(err));
    }
  },
);

/** Read the (server-private) explanation for a just-answered response. */
async function explainFor(runId: number, responseId: number): Promise<string> {
  const { rows } = await query<{ explain: string | null }>(
    `SELECT (item_payload->>'explain') AS explain
       FROM diagnostic_responses
      WHERE id = $1 AND run_id = $2`,
    [responseId, runId],
  );
  return rows[0]?.explain ?? '';
}

/**
 * POST /diagnostic/:runId/finish — score the run, write a snapshot (idempotent).
 */
router.post(
  '/:runId/finish',
  cheapLimiter(),
  validateParams(RunParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const params = (req as typeof req & {
        validatedParams: z.infer<typeof RunParamsSchema>;
      }).validatedParams;

      const run = await loadUserRun(params.runId, userId);

      // Idempotent: a finished run returns its existing snapshot.
      if (run.status === 'finished' && run.snapshot_id !== null) {
        const dto = await loadSnapshotDTO(Number(run.snapshot_id), userId);
        if (dto !== null) {
          res.status(200).json({ snapshot: dto });
          return;
        }
      }

      // All served items must be answered (skips count as answered).
      const { rows: unansweredRows } = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM diagnostic_responses
          WHERE run_id = $1 AND answered_at IS NULL`,
        [params.runId],
      );
      if (Number(unansweredRows[0]!.n) > 0) {
        throw new ConflictError('cannot finish: served items remain unanswered');
      }

      // Gather graded responses for scoring + evidence.
      const { rows: respRows } = await query<ResponseRow>(
        `SELECT id::text AS id, ordinal, section, source_kind, source_ref,
                difficulty::text AS difficulty, kind, correct_answer,
                picked, is_correct, answered_at
           FROM diagnostic_responses
          WHERE run_id = $1
          ORDER BY ordinal ASC`,
        [params.runId],
      );

      const scored: ScoredResponse[] = respRows.map((r) => ({
        section: r.section,
        difficulty: Number(r.difficulty),
        isCorrect: r.is_correct === true,
      }));
      const estimates = estimatesByDimension(scored);

      // Reconstruct the per-answer θ trajectory from the ordered responses.
      // The single `ability_estimate` column only persists the LATEST θ, so the
      // sequence is recomputed deterministically here: fold the CAT update over
      // the answered responses in ordinal order, seeding at SEED_THETA and using
      // the same `nextTheta` staircase the live /answer handler applied. The
      // result is the θ AFTER each answer (length = number of answered items),
      // which is the real evidence the contract asks for — not a one-element
      // array of the final value. The final element equals `ability_estimate`
      // (modulo the 2-dp rounding the column stores) by construction.
      let runningTheta = SEED_THETA;
      const thetaTrajectory = respRows.map((r, idx) => {
        runningTheta = nextTheta(runningTheta, r.is_correct === true, idx + 1);
        return thetaToNumeric(runningTheta);
      });

      const evidence = {
        items: respRows.map((r) => ({
          ordinal: r.ordinal,
          section: r.section,
          kind: r.kind,
          difficulty: Number(r.difficulty),
          picked: r.picked,
          correct: r.is_correct === true,
          source_kind: r.source_kind,
          source_ref: r.source_ref,
        })),
        theta_trajectory: thetaTrajectory,
        schedule: SCHEDULE,
      };

      // Write the snapshot + flip the run to finished in one short transaction.
      // We lock the run row FOR UPDATE and re-check its status inside the tx so
      // two concurrent /finish calls can't each insert a snapshot: the loser
      // sees status='finished' under the lock and reuses the winner's snapshot.
      const snapshotId = await withTransaction(async (client) => {
        const { rows: lockRows } = await client.query<{
          status: string;
          snapshot_id: string | null;
        }>(
          `SELECT status, snapshot_id::text AS snapshot_id
             FROM diagnostic_runs
            WHERE id = $1
            FOR UPDATE`,
          [params.runId],
        );
        const locked = lockRows[0];
        if (locked && locked.status === 'finished' && locked.snapshot_id !== null) {
          return Number(locked.snapshot_id);
        }
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO diagnostic_snapshots (
              user_id, reading_estimate, listening_estimate, writing_estimate,
              grammar_estimate, vocab_estimate, register_estimate,
              evidence, rubric_version)
           VALUES ($1, $2, $3, NULL, $4, $5, NULL, $6::jsonb, $7)
           RETURNING id::text AS id`,
          [
            userId,
            estimates.reading,
            estimates.listening,
            estimates.grammar,
            estimates.vocab,
            JSON.stringify(evidence),
            RUBRIC_VERSION,
          ],
        );
        const newSnapshotId = Number(rows[0]!.id);
        await client.query(
          `UPDATE diagnostic_runs
              SET status = 'finished', snapshot_id = $2, finished_at = now(),
                  version = version + 1
            WHERE id = $1`,
          [params.runId, newSnapshotId],
        );
        return newSnapshotId;
      });

      // Build the DTO from the snapshot we just wrote (or the one the race
      // winner wrote — reload it user-scoped to be safe).
      const dto = (await loadSnapshotDTO(snapshotId, userId)) ?? buildSnapshotDTO(estimates);
      res.status(200).json({ snapshot: dto });
    } catch (err) {
      next(mapClaudeError(err));
    }
  },
);

/** Load a stored snapshot (user-scoped) and rebuild its DTO. */
async function loadSnapshotDTO(snapshotId: number, userId: number): Promise<SnapshotDTO | null> {
  const { rows } = await query<{
    reading_estimate: string | null;
    listening_estimate: string | null;
    grammar_estimate: string | null;
    vocab_estimate: string | null;
  }>(
    `SELECT reading_estimate, listening_estimate, grammar_estimate, vocab_estimate
       FROM diagnostic_snapshots
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [snapshotId, userId],
  );
  const row = rows[0];
  if (!row) return null;
  return buildSnapshotDTO({
    reading: row.reading_estimate !== null ? Number(row.reading_estimate) : null,
    listening: row.listening_estimate !== null ? Number(row.listening_estimate) : null,
    grammar: row.grammar_estimate !== null ? Number(row.grammar_estimate) : null,
    vocab: row.vocab_estimate !== null ? Number(row.vocab_estimate) : null,
  });
}

/**
 * GET /diagnostic/latest — the user's latest snapshot, or an empty snapshot
 * (200, dimensions:[]) when they have none. We intentionally do NOT 404 here:
 * the client's mock fixture treats empty dimensions as "no run yet" and routes
 * to the intro. (Deviation from the plan's "404 → intro" — see SECURITY.md/§C.)
 */
router.get('/latest', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { rows } = await query<{ id: string }>(
      `SELECT id::text AS id FROM diagnostic_snapshots
        WHERE user_id = $1 AND deleted_at IS NULL
        ORDER BY captured_at DESC, id DESC
        LIMIT 1`,
      [userId],
    );
    const row = rows[0];
    if (!row) {
      res.status(200).json(emptySnapshot());
      return;
    }
    const dto = await loadSnapshotDTO(Number(row.id), userId);
    res.status(200).json(dto ?? emptySnapshot());
  } catch (err) {
    next(err);
  }
});

/**
 * GET /diagnostic/trajectory — snapshot history as score points, oldest→newest.
 */
router.get('/trajectory', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { rows } = await query<{
      captured_at: Date;
      reading_estimate: string | null;
      listening_estimate: string | null;
      grammar_estimate: string | null;
      vocab_estimate: string | null;
    }>(
      `SELECT captured_at, reading_estimate, listening_estimate,
              grammar_estimate, vocab_estimate
         FROM diagnostic_snapshots
        WHERE user_id = $1 AND deleted_at IS NULL
        ORDER BY captured_at ASC, id ASC`,
      [userId],
    );
    const points = rows.map((r) => {
      const point: {
        capturedAt: string;
        reading?: number;
        listening?: number;
        vocab?: number;
        grammar?: number;
      } = { capturedAt: r.captured_at.toISOString() };
      if (r.reading_estimate !== null) point.reading = estimateToScore(Number(r.reading_estimate));
      if (r.listening_estimate !== null) {
        point.listening = estimateToScore(Number(r.listening_estimate));
      }
      if (r.vocab_estimate !== null) point.vocab = estimateToScore(Number(r.vocab_estimate));
      if (r.grammar_estimate !== null) point.grammar = estimateToScore(Number(r.grammar_estimate));
      return point;
    });
    res.status(200).json({ points });
  } catch (err) {
    next(err);
  }
});

/**
 * Map a Claude proxy error (which carries httpStatus/code) into our UpstreamError
 * so the error handler returns a clean 502. Non-proxy errors pass through.
 *
 * We deliberately do NOT forward the upstream's HTTP status: UpstreamError is
 * always 502 by design (the route's posture is "Claude failed, that's a bad
 * gateway, period"), and surfacing the upstream's raw status to the client
 * would leak information about our provider integration (SECURITY.md §13.7).
 * The upstream `code`/`message` are folded into the message for our own logs;
 * `UpstreamError`'s `details` is intentionally left undefined so nothing
 * provider-specific reaches the wire.
 */
function mapClaudeError(err: unknown): unknown {
  if (err && typeof err === 'object' && 'httpStatus' in err) {
    const code = (err as { code?: string }).code ?? 'upstream_error';
    const message = (err as { message?: string }).message ?? 'claude error';
    return new UpstreamError(`${code}: ${message}`);
  }
  return err;
}

export default router;
