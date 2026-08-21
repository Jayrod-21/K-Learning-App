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
 *   GET  /diagnostic/history          → full snapshot history (DTO per attempt)
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
 *     answer-tampering defense and THE security property of this pass. A
 *     writing item's `referenceModelKr`/`referenceModelEn` (diagnostic-upgrade
 *     Phase B) are the same kind of secret as `correct_answer` — stored in
 *     `item_payload` but never spread onto a `ClientItem` (see
 *     `pendingClientItem`/`toClientItem`'s explicit field allow-lists).
 *   - Out-of-order / double answers are rejected 409 (replay defense).
 *   - Item generation (vocab/grammar/writing via Claude) is behind
 *     diagnosticLimiter on the routes that can generate (/diagnostic,
 *     /:runId/next) — the diagnostic run's OWN rate-limit bucket
 *     (middleware/rateLimits.ts), sized for a full run's route-entry count
 *     rather than sharing the app-wide expensiveLimiter bucket with every
 *     other paid-upstream route. Genuine GENERATION calls are bounded to
 *     ≤ (4 vocab + 4 grammar + 2 writing) = 10 per run by the fixed 22-item,
 *     WEIGHTS-driven schedule plus /next's re-serve-pending idempotency.
 *     Grading (/answer) never calls Claude for MC items, so it sits behind
 *     cheapLimiter — a limiter 429 can no longer withhold a reveal the user
 *     already earned. A WRITING /answer is the one exception (Phase B): it
 *     DOES make one `scoreGrammarDrill` Claude call to grade the learner's
 *     free-text sentence. This is DELIBERATELY still cheapLimiter, not
 *     diagnosticLimiter: the call is bounded to at most 2/run (the fixed
 *     writing weight, not user-controllable — the single-shot `answered_at
 *     IS NULL` gate makes a re-answer of the same item impossible, and the
 *     schedule caps total writing slots at 2), so the worst case is 2 extra
 *     cheap-bucket-gated Claude calls per run — negligible next to the 10
 *     generation calls already riding diagnosticLimiter, and moving it to
 *     diagnosticLimiter would let a limiter 429 withhold a writing reveal the
 *     user already earned, the exact harm cheapLimiter exists to avoid for
 *     the other four gradeable dimensions.
 *
 * Reading/listening items come from the real topik_items pool (no Claude);
 * vocab/grammar items are authored by the Claude proxy from a corpus seed;
 * writing items (diagnostic-upgrade Phase B) reuse that SAME generate+grade
 * Claude pipeline (`generateGrammarDrill`/`scoreGrammarDrill`, Pass 9's
 * grammar-production-drill route) rather than a new Claude route — see
 * `buildWritingItem` and the /answer handler's writing branch.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter, diagnosticLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { query, withTransaction } from '../db/pool.js';
import { ConflictError, NotFoundError, UpstreamError, mapClaudeError } from '../middleware/errors.js';
import { getClaudeProxy } from '../services/claudeProxy.js';
import { NO_TRANSCRIPT_STEM_PREFIX } from './topik.js';
import type {
  DiagnosticTargetLevel,
  DrillVerdict,
  GrammarDrillItem,
  ProficiencyLevel,
} from '../services/claude/index.js';
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
  resultsByDimension,
  type DiagnosticDimensionKey,
  type ScoredResponse,
} from '../services/diagnostic/scoring.js';
import { sharedPassageFor } from '../services/topik/passages.js';
import { getLogger } from '../logging.js';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Types + constants
// ---------------------------------------------------------------------------

/**
 * Items served per dimension (diagnostic-upgrade Phase B: a per-dimension
 * WEIGHTS map, replacing the old uniform `ITEMS_PER_DIMENSION = 4`). Five
 * dimensions keep the original 4: reading/listening/vocab/grammar cost one
 * Claude generation call each (topik-sourced reading/listening cost none),
 * hanja costs none (corpus-only, see `buildHanjaItem`). `writing` is
 * deliberately WEIGHTED DOWN to 2 — each writing item costs TWO Claude calls
 * (one `generateGrammarDrill` at serve time, one `scoreGrammarDrill` at grade
 * time) versus one for vocab/grammar, so 4 would roughly double the run's
 * total Claude spend for one dimension. 2 is enough signal to move θ a
 * couple of steps without that cost (the user's locked "Claude-graded short
 * response" ask never specified a count; 2 was chosen as the cheap end of
 * "more than one, not four").
 */
const WEIGHTS: Record<DiagnosticDimensionKey, number> = {
  reading: 4,
  listening: 4,
  vocab: 4,
  grammar: 4,
  hanja: 4,
  writing: 2,
};

/**
 * Fixed serve schedule. The five WEIGHTS=4 dimensions round-robin-interleave
 * across 4 full rounds — EXACTLY the pre-Phase-B schedule (reading,
 * listening, vocab, grammar, hanja, reading, …, 20 slots) — then writing's 2
 * slots are appended at the very end (ordinals 21, 22).
 *
 * Why appended, not interleaved mid-run: the locked design only requires
 * writing's two items not BOTH land at the very start ("a strong writing
 * signal needs the θ to have moved") — it does not mandate even spacing.
 * Appending both after the full core round-robin (a) trivially satisfies
 * that constraint (θ has had the MAXIMUM possible evidence — 20 answers —
 * behind it by the time either writing item serves, which is strictly
 * BETTER signal quality than a mid-run placement, not just adequate), and
 * (b) leaves every existing reading/listening/vocab/grammar/hanja ordinal
 * (1, 6, 11, 16, …) byte-for-byte unchanged, so the CAT interleave the other
 * five dimensions rely on — and every test asserting on it — is undisturbed
 * by this change.
 */
const CORE_ROUND_ROBIN_DIMENSIONS: readonly DiagnosticDimensionKey[] = DIMENSION_ORDER.filter(
  (d) => d !== 'writing',
);
const CORE_ROUNDS = 4; // WEIGHTS value shared by every core-round-robin dimension.
const SCHEDULE: readonly DiagnosticDimensionKey[] = [
  ...Array.from({ length: CORE_ROUNDS }, () => CORE_ROUND_ROBIN_DIMENSIONS).flat(),
  ...(Array.from({ length: WEIGHTS.writing }, () => 'writing') as DiagnosticDimensionKey[]),
];

const TARGET_ITEM_COUNT = SCHEDULE.length; // 22 (4×5 core dims + 2 writing)

type ChoiceId = 'a' | 'b' | 'c' | 'd';
const CHOICE_IDS: readonly ChoiceId[] = ['a', 'b', 'c', 'd'];

/**
 * `diagnostic_responses.correct_answer` is NOT NULL, but a writing item
 * (diagnostic-upgrade Phase B) has no MC choice to record there — it is
 * graded by `scoreGrammarDrill`'s verdict, not a `picked === correct_answer`
 * compare. This sentinel satisfies the NOT NULL constraint without being a
 * value that could ever collide with a real choice id ('a'..'d').
 */
const WRITING_ANSWER_SENTINEL = 'writing' as const;

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
  /**
   * A real, playable audio window (F-119/F-206 shape): the client streams
   * `audioUrl` and seeks `audioStartMs`→`audioEndMs`. Present only for
   * listening items whose topik row carries a mapped span AND a test-level
   * mp3 — see `buildTopikItem`. `audio.transcript` still ships alongside this
   * (a caption/reveal), so an item can carry both.
   */
  readonly audioUrl?: string;
  readonly audioStartMs?: number;
  readonly audioEndMs?: number;
  readonly choices: readonly ChoiceDTO[];
  /** Correct choice id — NEVER serialized to the client before reveal. A
   *  writing item (diagnostic-upgrade Phase B) has no MC choices to compare
   *  against; it stores the `WRITING_ANSWER_SENTINEL` here instead (the
   *  `correct_answer` column is NOT NULL — grading for writing branches on
   *  `section === 'writing'`, not on this value, so the sentinel is never
   *  actually compared against anything). */
  readonly correctAnswer: ChoiceId | typeof WRITING_ANSWER_SENTINEL;
  /** Explanation — NEVER serialized to the client before reveal. */
  readonly explain: string;
  /**
   * The Claude-authored reference model answer (Korean + English), present
   * ONLY on a writing item. COLUMN-PRIVATE exactly like `correctAnswer`:
   * persisted into `item_payload` by `insertResponse` but never spread onto
   * a `ClientItem` (see `StoredItemPayload`'s narrower field list) — the
   * learner must never see the model sentence before they submit their own.
   */
  readonly referenceModelKr?: string;
  readonly referenceModelEn?: string;
  /** The grammar pattern this writing item drills, echoed back to
   *  `scoreGrammarDrill` at grade time (it requires `patternDisplay`).
   *  COLUMN-PRIVATE for the same reason as `referenceModelKr` — not load-
   *  bearing for the client, no reason to put it on the wire early. */
  readonly patternDisplay?: string;
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
  readonly audioUrl?: string;
  readonly audioStartMs?: number;
  readonly audioEndMs?: number;
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
    ...(item.audioUrl !== undefined ? { audioUrl: item.audioUrl } : {}),
    ...(item.audioStartMs !== undefined ? { audioStartMs: item.audioStartMs } : {}),
    ...(item.audioEndMs !== undefined ? { audioEndMs: item.audioEndMs } : {}),
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
  /**
   * The curator's actual question directive (e.g. "무엇에 대한 내용입니까?
   * <보기>와 같이 알맞은 것을 고르십시오."), distinct from `stem`/passage body.
   * B1 fix: this — not `stem` — is what belongs in the on-screen prompt; `stem`
   * is the passage/transcript the question is ABOUT, and printing it as both
   * the prompt and the passage duplicated the same Korean string on screen.
   */
  instruction: string | null;
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
  /** This item's mapped listening-audio window (migration 078), or null. */
  audio_start_ms: number | null;
  audio_end_ms: number | null;
  /** The parent test's mapped whole-section MP3 path, or null (migration 005
   *  `audio_path`). Column names mirror topik.ts's `test_audio_path` join
   *  alias exactly (F-206) — one shape, no drift between the two callers. */
  test_audio_path: string | null;
  /** The parent test's `test_number` — with `test_topik_level`, resolves the
   *  `/topik/audio/:testNumber/:level` stream URL (same shape as topik.ts). */
  test_number: number;
  test_topik_level: string;
}

/** The two TOPIK papers, as stored in `topik_tests.topik_level` (TEXT with a
 *  CHECK `IN ('TOPIK I','TOPIK II')`, migration 005). Named so a typo cannot
 *  silently become an always-empty filter (review N-2). */
type TopikPaper = 'TOPIK I' | 'TOPIK II';
const TOPIK_PAPER_I: TopikPaper = 'TOPIK I';
const TOPIK_PAPER_II: TopikPaper = 'TOPIK II';

/** The paper a band's targeted attempt prefers: beginners (L1/L2) draw from
 *  the TOPIK I paper, everyone else (L3/L4/L5+) from TOPIK II. One mapping so
 *  both halves of the band targeting stay symmetric (F-002 fixpass SF-2). */
function paperForBand(band: DiagnosticBand): TopikPaper {
  return band === 'L1' || band === 'L2' ? TOPIK_PAPER_I : TOPIK_PAPER_II;
}

/**
 * Pick one topik_items row for `section` near `band`, excluding ids already
 * served in this run. Widens band → any band if the targeted band is empty.
 * Returns null only when the section pool is genuinely empty.
 *
 * Band targeting (band-targeted attempts → any):
 *   - Every band prefers its paper (`paperForBand`): L1/L2 → TOPIK I (the
 *     ~776 answerable beginner items ARE the beginner pool), L3/L4/L5+ →
 *     TOPIK II — otherwise advanced users draw ~40% beginner TOPIK I items
 *     from the "any" pool (F-002 fixpass SF-2).
 *   - L3/L4/L5+ additionally try the row's `proficiency` enum first; the live
 *     corpus has NULL proficiency everywhere, so in production that attempt
 *     falls through to the paper-only attempt. L1/L2 skip it entirely — no
 *     topik_items rows are proficiency-tagged L1/L2 (migration 039 adds the
 *     enum values with no backfill).
 *   - The final attempt is unfiltered ("any"), so an exhausted paper never
 *     starves the run.
 *
 * Answerable-item guard mirrors topik.ts ANSWERABLE_ITEM_SQL: >= 2 options,
 * non-null answer, AND not a picture-choice item whose options are bare
 * ①②③④ glyphs (tester sweep P2-1 / data sweep D-4) — those render four
 * identical choices with no image asset, so the item is unanswerable and must
 * not move θ.
 *
 * B-038: also excludes listening items whose stem is the no-transcript
 * curator placeholder (NO_TRANSCRIPT_STEM_PREFIX, shared with topik.ts) —
 * UNLESS the row carries a real playable audio span, mirroring topik.ts's
 * `ANSWERABLE_ITEM_SQL` RE-ADMIT (F-119: the learner listens instead of
 * reading the stem). This diagnostic now serves real audio playback for any
 * listening item that clears `buildTopikItem`'s `hasRealAudio` gate
 * (`audio_start_ms`/`audio_end_ms`/`test.audio_path` all non-null) — a
 * placeholder-stem row that ALSO clears that gate is a real, playable,
 * answerable listening question, exactly the case topik.ts re-admits. Only a
 * placeholder-stem row with NO mapped audio stays excluded: nothing to read,
 * nothing to play, genuinely unanswerable. The re-admit condition mirrors
 * `hasRealAudio` exactly (not topik.ts's looser `audio_end_ms IS NOT NULL`
 * alone) so a re-admitted row here is always guaranteed to reach the
 * diagnostic's stricter three-column playability gate too — never a
 * placeholder stem re-admitted into the pool only to then fail
 * `hasRealAudio` and render with no audio AND no real stem text.
 */
async function pickTopikRow(
  section: 'reading' | 'listening',
  band: DiagnosticBand,
  excludeIds: readonly string[],
): Promise<TopikRow | null> {
  // Attempts, most→least targeted; each excludes already-served ids.
  const paper = paperForBand(band);
  const bandProficiency = band === 'L1' || band === 'L2' ? null : band;
  const attempts: ReadonlyArray<{
    readonly proficiency: string | null;
    readonly topikLevel: string | null;
  }> = [
    ...(bandProficiency !== null
      ? [{ proficiency: bandProficiency, topikLevel: paper }]
      : []),
    { proficiency: null, topikLevel: paper },
    { proficiency: null, topikLevel: null },
  ];
  for (const attempt of attempts) {
    const params: unknown[] = [section];
    // JOIN topik_tests to carry the test's `passages` JSONB (shared reading
    // passages keyed by item-number range, migration 005) so buildTopikItem can
    // resolve the passage covering this item's `item_number`, PLUS the test's
    // mapped audio path/number/paper (F-119/F-206 shape) so a listening item
    // can name its real playable stream. Columns are qualified with the `i`
    // alias because the join introduces a second `id`.
    let sql = `SELECT i.id::text AS id, i.section::text AS section,
                      i.proficiency::text AS proficiency,
                      i.stem, i.prompt, i.instruction, i.underline, i.options,
                      i.answer, i.extra, i.item_number, t.passages AS test_passages,
                      i.audio_start_ms, i.audio_end_ms,
                      t.audio_path AS test_audio_path,
                      t.test_number, t.topik_level AS test_topik_level
                 FROM topik_items i
                 JOIN topik_tests t ON t.id = i.topik_test_id
                WHERE i.section = $1::topik_section
                  AND i.options IS NOT NULL
                  AND jsonb_array_length(i.options) >= 2
                  AND i.answer IS NOT NULL
                  AND i.options->>0 NOT IN ('①','②','③','④')
                  AND (coalesce(i.stem, '') NOT LIKE '${NO_TRANSCRIPT_STEM_PREFIX}%'
                       OR (i.audio_start_ms IS NOT NULL AND i.audio_end_ms IS NOT NULL
                           AND t.audio_path IS NOT NULL))`;
    if (attempt.proficiency !== null) {
      params.push(attempt.proficiency);
      sql += ` AND i.proficiency = $${params.length}::proficiency_level`;
    }
    if (attempt.topikLevel !== null) {
      params.push(attempt.topikLevel);
      sql += ` AND t.topik_level = $${params.length}`;
    }
    if (excludeIds.length > 0) {
      params.push(excludeIds);
      sql += ` AND i.id::text <> ALL($${params.length}::text[])`;
    }
    // Audio-carrying preference (F-206-shaped playback): among LISTENING
    // candidates, rows with a mapped audio window AND a test-level mp3 sort
    // first (CASE 0), everything else sorts after (CASE 1) — `random()` only
    // breaks ties WITHIN each group. This never shrinks the pool: when the
    // pool has zero audio-carrying rows every candidate lands in the same
    // group and the pick degenerates to the old uniform-random draw, so a
    // band/paper with no mapped audio still serves (transcript-only). The
    // CASE is a no-op for reading (WHERE already pins `i.section = $1`, so
    // every candidate row already has the same section and the `= 'listening'`
    // arm is always false) — one query shape, not two branches.
    sql += ` ORDER BY (CASE WHEN i.section::text = 'listening'
                              AND i.audio_start_ms IS NOT NULL
                              AND i.audio_end_ms IS NOT NULL
                              AND t.audio_path IS NOT NULL
                             THEN 0 ELSE 1 END), random() LIMIT 1`;
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
      ? proficiencyToNumber(row.proficiency as ProficiencyLevel)
      : proficiencyToNumber(band);
  const level: DiagnosticTargetLevel = band;
  // B1 fix: the on-screen QUESTION is `instruction` (the curator's actual
  // directive, e.g. "무엇에 대한 내용입니까? …고르십시오."), never `stem` — `stem`
  // is the passage/transcript body the question is ABOUT and is rendered
  // separately below (`passage` / `audio.transcript`). Serving `stem` as both
  // the prompt AND the passage printed the same Korean string twice on
  // screen; `topik_items.prompt` (the old fallback) is NULL on 100% of the
  // live eligible pool, so it never actually broke the tie in production —
  // `instruction` is populated for the full eligible pool instead.
  const prompt = (row.instruction ?? '').trim() || '다음 질문에 답하세요.';

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
    // Real playable audio (F-119/F-206 shape): only when BOTH the item's
    // window AND the parent test's mp3 are mapped — mirrors topik.ts's own
    // `row.audio_start_ms !== null && row.audio_end_ms !== null &&
    // row.test_audio_path !== null` guard (F-206) and its URL build EXACTLY
    // (`/topik/audio/<testNumber>/<1|2>`, level ternary on 'TOPIK II') so the
    // client's `buildAudioSrc` allow-list — already anchored to that same
    // route shape for the TOPIK study player — accepts it with no change.
    // `audio.transcript` above still ships alongside this as a caption/reveal.
    const hasRealAudio =
      row.audio_start_ms !== null && row.audio_end_ms !== null && row.test_audio_path !== null;
    return {
      ...base,
      audio: { duration, transcript },
      ...(hasRealAudio
        ? {
            audioUrl: `/topik/audio/${String(row.test_number)}/${
              row.test_topik_level === 'TOPIK II' ? '2' : '1'
            }`,
            audioStartMs: row.audio_start_ms!,
            audioEndMs: row.audio_end_ms!,
          }
        : {}),
    };
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

/**
 * The content tag the generator's seed query should match for a target band.
 *
 * No corpus rows are proficiency-tagged 'L1'/'L2' (migration 039 adds the enum
 * values with no backfill) — the beginner content is tagged 'basic' (1716
 * vocab + 114 kgiu rows). Without this mapping the L1/L2 targeted attempt is
 * an always-empty query and every beginner vocab/grammar item is silently
 * seeded from a uniform-random ANY-level row (~46% L3) while being recorded at
 * difficulty 1/2 (F-002 fixpass B-1). L3/L4/L5+ pass through unchanged.
 */
function seedProficiencyForTarget(target: DiagnosticTargetLevel): ProficiencyLevel {
  return target === 'L1' || target === 'L2' ? 'basic' : target;
}

/** Pick a vocab_entries seed near the target band (via
 *  `seedProficiencyForTarget`). Falls back to any band.
 *  Exported for direct fence coverage (tests/routes/uploadExtract.test.ts). */
export async function pickVocabSeed(target: DiagnosticTargetLevel): Promise<GenSeed | null> {
  for (const proficiency of [seedProficiencyForTarget(target), null] as const) {
    const params: unknown[] = [];
    // F-108 fence: seeds draw from the shared curated corpus only. Rows
    // EXTRACTED from a book upload (source_upload_id tagged) are private to
    // the upload's owner AND uncurated OCR candidates — this helper has no
    // user context, so they are excluded outright (mirrors pickGrammarSeed;
    // extracted rows are written proficiency='L3', so without this they'd
    // match the FIRST, proficiency-targeted pass for any user's diagnostic).
    let sql = `SELECT id::text AS id, korean, english
                 FROM vocab_entries
                WHERE korean IS NOT NULL AND length(korean) >= 1
                  AND source_upload_id IS NULL`;
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

/** Pick a kgiu_entries grammar seed near the target band (via
 *  `seedProficiencyForTarget`). Falls back to any.
 *  Exported for direct fence coverage (tests/routes/uploadExtract.test.ts). */
export async function pickGrammarSeed(target: DiagnosticTargetLevel): Promise<GenSeed | null> {
  for (const proficiency of [seedProficiencyForTarget(target), null] as const) {
    const params: unknown[] = [];
    // F-108 fence: seeds draw from the shared curated KGIU corpus only. Rows
    // EXTRACTED from a book upload (source_upload_id tagged) are private to
    // the upload's owner AND uncurated OCR candidates — this helper has no
    // user context, so they are excluded outright.
    let sql = `SELECT id::text AS id, pattern, title_en, explanation
                 FROM kgiu_entries
                WHERE pattern IS NOT NULL AND length(pattern) >= 1
                  AND source_upload_id IS NULL`;
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
 * Fisher–Yates shuffle of a generated item's choices, remapping the correct
 * index to wherever the correct choice lands.
 *
 * The Claude proxy biases the correct choice toward index 0 (LLM position bias)
 * and the generation prompt does not force randomization, so without this,
 * generated vocab/grammar items came back correct='a' almost every time — a
 * diagnostic you could game by always picking the first choice. We permute
 * server-side rather than trust the model to randomize. Topik-sourced items are
 * NOT shuffled: they carry real corpus answer positions, already varied.
 *
 * `rng` is injectable so tests can assert the remap deterministically.
 */
export function shuffleGeneratedChoices(
  choices: readonly { readonly kr: string }[],
  correctIndex: number,
  rng: () => number = Math.random,
): { choices: ChoiceDTO[]; correctAnswer: ChoiceId } {
  const order = choices.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }
  const shuffled: ChoiceDTO[] = order.map((origIdx, newIdx) => ({
    id: CHOICE_IDS[newIdx]!,
    kr: choices[origIdx]!.kr,
    en: '',
  }));
  const correctAnswer = CHOICE_IDS[order.indexOf(correctIndex)]!;
  return { choices: shuffled, correctAnswer };
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
  // The route's posture is "any Claude generation failure is a bad gateway (502),
  // not a 500" (see mapClaudeError). A raw thrown error (network outage / "claude
  // is down") carries no `httpStatus`, so mapClaudeError would pass it through to a
  // generic 500 — wrap it as UpstreamError here so every generation failure maps to
  // 502 (the `.catch` returns `never`, so `result`'s type is unchanged).
  //
  // R2-BLOCKER fix: never embed `err.message` in the client-facing message.
  // `generateDiagnosticItem` can throw either a `ClaudeProxyError` (carries
  // `httpStatus`/`code` — validation/rate-limit/output-schema/etc.) or a raw,
  // unwrapped error that slipped past `retry.ts`'s classification (retry.ts:96-99
  // rethrows a non-retryable error verbatim — this can be a raw Anthropic SDK or
  // Node/undici network error whose `.message` may contain hostnames, ports, or
  // literal SDK text). Route both through the shared `mapClaudeError`: a
  // `ClaudeProxyError` becomes the whitelisted, wire-safe message it already
  // produces for every other route; anything else (no `httpStatus`) is passed
  // through unchanged by `mapClaudeError`, so we log the raw detail server-side
  // only and rethrow a fixed generic message — preserving this route's existing
  // "any generation failure is a 502" contract without ever forwarding raw text.
  const { result } = await proxy
    .generateDiagnosticItem(
      {
        section,
        targetLevel: target,
        seedKorean: seed.seedKorean,
        ...(seed.seedEnglish !== undefined ? { seedEnglish: seed.seedEnglish } : {}),
        ...(seed.seedGloss !== undefined ? { seedGloss: seed.seedGloss } : {}),
      },
      { ...(correlationId !== undefined ? { requestId: correlationId } : {}), userId },
    )
    .catch((err: unknown) => {
      const mapped = mapClaudeError(err);
      if (mapped !== err) {
        // A recognized ClaudeProxyError — `mapped` is already a safe,
        // whitelisted UpstreamError (mapClaudeError logged the raw detail
        // server-side itself). Reuse it rather than re-wrapping.
        throw mapped;
      }
      // Not a ClaudeProxyError (raw network/SDK error — see comment above).
      // Log the raw detail server-side only; the client never sees `err.message`.
      getLogger().error(
        {
          section,
          correlationId,
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : { value: String(err) },
        },
        `diagnostic ${section} item generation failed`,
      );
      throw new UpstreamError(`diagnostic ${section} item generation failed`);
    });

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
  if (
    !Number.isInteger(result.answerIndex) ||
    result.answerIndex < 0 ||
    result.answerIndex >= result.choices.length
  ) {
    // answerIndex is schema-bounded 0..3 with exactly 4 choices; belt-and-suspenders
    // so a future schema relaxation can't ship an out-of-range index silently.
    throw new UpstreamError('generated item answerIndex out of range');
  }
  // Shuffle server-side so the correct choice isn't parked at 'a' (see
  // shuffleGeneratedChoices) — the model's position bias otherwise made generated
  // items gameable. Topik items keep their real, already-varied corpus positions.
  const { choices, correctAnswer: correct } = shuffleGeneratedChoices(
    result.choices,
    result.answerIndex,
  );

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

/** A hanja_characters row, as selected for a diagnostic hanja item. */
interface HanjaRow {
  readonly char: string;
  readonly sound: string;
  readonly gloss_en: string;
}

/** The two hanja_characters `level` values the live corpus actually
 *  populates (migration 016: L2=89 chars, L3=768; the CHECK also allows
 *  L4/L5 but the build has never populated them). */
type HanjaCorpusLevel = 'L2' | 'L3';

/**
 * All hanja_characters rows at `level`, optionally excluding one char. The
 * live corpus is small at both levels the diagnostic can draw from (L2: 89,
 * L3: 768) so fetching the whole level and working in JS is simpler — and
 * just as fast (ix_hanja_characters_level is indexed on `level`) — than a
 * cleverer DISTINCT-ON query, and makes the "never fail on a thin distractor
 * pool" guarantee in `buildHanjaItem` trivial to reason about.
 */
async function hanjaLevelPool(
  level: HanjaCorpusLevel,
  excludeChar?: string,
): Promise<HanjaRow[]> {
  const params: unknown[] = [level];
  let sql = `SELECT char, sound, gloss_en FROM hanja_characters WHERE level = $1`;
  if (excludeChar !== undefined) {
    params.push(excludeChar);
    sql += ` AND char <> $${params.length}`;
  }
  const { rows } = await query<HanjaRow>(sql, params);
  return rows;
}

/**
 * The hanja corpus level the CAT band prefers. The live corpus only has L2
 * and L3 rows (migration 016 — L4/L5 are reserved by the CHECK but
 * unpopulated), so every band maps onto one of the two; `buildHanjaItem`
 * falls back to the other level if the preferred one's pool is ever empty
 * (defensive — never expected against the live corpus).
 */
function preferredHanjaLevel(band: DiagnosticBand): HanjaCorpusLevel {
  return band === 'L1' || band === 'L2' ? 'L2' : 'L3';
}

/**
 * Build a hanja MC ServerItem: a random character at (or near) the CAT band,
 * with 3 same-level distractors, as either a reading-MC ("음 of 學?" → 4
 * `sound` choices) or a meaning-MC ("meaning of 學?" → 4 `gloss_en` choices)
 * — the kind is picked at random per item for variety. `excludeChars` keeps
 * one run from repeating a character across its (up to) 4 hanja slots.
 * Returns null only when the corpus is genuinely too thin to build a
 * 4-choice item — never expected live: L2 alone has 69 distinct sounds / 89
 * distinct glosses, L3 has 297/768.
 *
 * COVERAGE-ONLY (diagnostic-upgrade Phase A): hanja is scored — it gets its
 * own `dimensionStats` entry in the snapshot — but this item's `difficulty`
 * is the CHARACTER'S REAL corpus level (L2→2, L3→3 via `proficiencyToNumber`),
 * NOT the CAT `band` passed in. The band only steers WHICH level pool this
 * item draws from (so a beginner sees L2 hanja, not L3); it never determines
 * the recorded difficulty, and the caller never feeds this item's grade back
 * into θ (see the `/answer` handler's `section !== 'hanja'` guard) — the L3
 * ceiling of the hanja corpus must never drag an advanced learner's overall
 * placement down.
 */
async function buildHanjaItem(
  band: DiagnosticBand,
  excludeChars: readonly string[],
): Promise<ServerItem | null> {
  const preferred = preferredHanjaLevel(band);
  const fallback: HanjaCorpusLevel = preferred === 'L2' ? 'L3' : 'L2';

  let level: HanjaCorpusLevel | null = null;
  let answer: HanjaRow | null = null;
  for (const candidateLevel of [preferred, fallback]) {
    const pool = await hanjaLevelPool(candidateLevel);
    if (pool.length === 0) continue;
    const excludeSet = new Set(excludeChars);
    const fresh = pool.filter((r) => !excludeSet.has(r.char));
    // Prefer a char not yet served this run; if the run has somehow
    // exhausted every distinct char at this level (never expected — 89+
    // chars vs. at most 4 hanja slots/run), reuse from the full pool rather
    // than fail the slot.
    const candidates = fresh.length > 0 ? fresh : pool;
    answer = candidates[Math.floor(Math.random() * candidates.length)]!;
    level = candidateLevel;
    break;
  }
  if (answer === null || level === null) return null;

  const rest = await hanjaLevelPool(level, answer.char);
  const kind: 'hanja-reading' | 'hanja-meaning' =
    Math.random() < 0.5 ? 'hanja-reading' : 'hanja-meaning';
  const field: 'sound' | 'gloss_en' = kind === 'hanja-reading' ? 'sound' : 'gloss_en';

  // 3 distractors from the SAME level: distinct char AND distinct `field`
  // value from the answer and each other, so no two choices ever read
  // identically. Shuffle first so repeated draws aren't alphabetical.
  const shuffled = [...rest].sort(() => Math.random() - 0.5);
  const seenValues = new Set<string>([answer[field]]);
  const distractors: HanjaRow[] = [];
  for (const row of shuffled) {
    if (distractors.length >= 3) break;
    if (seenValues.has(row[field])) continue;
    seenValues.add(row[field]);
    distractors.push(row);
  }
  // Never fail on a pathologically thin distinct-value pool: top up with
  // same-level rows regardless of value collisions rather than serve a
  // <4-choice item. Not expected against the live corpus (see the function
  // doc); a genuine shortfall below 3 total distractors returns null and the
  // caller treats the ordinal as an empty pool, same as every other builder.
  if (distractors.length < 3) {
    // Corpus regression visibility: this path means the level's pool had
    // fewer than 3 distinct-VALUE distractors, so two choices below may
    // share display text — never triggerable against the live corpus (see
    // the function doc), so a live hit means the corpus shrank underneath
    // this run and should be investigated, not silently served.
    getLogger().warn(
      { level, char: answer.char, kind },
      'diagnostic: hanja distractor pool thin on distinct values — topping up with possible value collisions',
    );
    for (const row of shuffled) {
      if (distractors.length >= 3) break;
      if (distractors.some((d) => d.char === row.char)) continue;
      distractors.push(row);
    }
  }
  if (distractors.length < 3) return null;

  const choiceText = (row: HanjaRow): string =>
    kind === 'hanja-reading' ? row.sound : row.gloss_en;
  const { choices, correctAnswer } = shuffleGeneratedChoices(
    [answer, ...distractors].map((row) => ({ kr: choiceText(row) })),
    0,
  );

  const prompt =
    kind === 'hanja-reading'
      ? `What is the reading (음) of ${answer.char}?`
      : `What does ${answer.char} mean?`;
  const explain =
    kind === 'hanja-reading'
      ? `${answer.char} (${answer.gloss_en}) is read "${answer.sound}".`
      : `${answer.char} is read "${answer.sound}" and means "${answer.gloss_en}".`;

  return {
    section: 'hanja',
    // Reuses 'generated' rather than adding a 'corpus' source_kind value —
    // avoids widening ck_diagnostic_responses_source_kind on top of the
    // section CHECK (smaller migration surface). `section` (not source_kind)
    // is what distinguishes a hanja response from a vocab/grammar one; see
    // `servedHanjaChars` below.
    sourceKind: 'generated',
    sourceRef: answer.char,
    difficulty: proficiencyToNumber(level),
    kind,
    level,
    prompt,
    choices,
    correctAnswer,
    explain,
  };
}

/**
 * Build a writing (Claude-graded production) ServerItem via the SAME
 * generate+grade pipeline Pass 9's Grammar screen drill uses
 * (`generateGrammarDrill` / `scoreGrammarDrill`, see the /answer handler's
 * writing branch below) — NO new Claude route (diagnostic-upgrade Phase B,
 * the user's locked "Claude-graded short response" decision). Always
 * requests the 'transformation' drill type (the simplest one-sentence form:
 * rewrite a given base sentence using the target pattern). cloze/conversation
 * exist for the Grammar screen's variety but add nothing the diagnostic
 * needs, and locking the type keeps the served shape — and the grading
 * input it reconstructs from `item_payload` — uniform across both of a run's
 * writing slots.
 *
 * Returns null when no kgiu_entries seed exists for the target band (empty
 * corpus) — the caller then skips this ordinal, same contract as every other
 * builder. Claude errors surface as UpstreamError, mirroring
 * `buildGeneratedItem` exactly (never forward a raw Claude/SDK error message
 * to the client — R2-BLOCKER posture).
 */
async function buildWritingItem(
  theta: number,
  correlationId: string | undefined,
  userId: number,
): Promise<ServerItem | null> {
  const target = targetLevelForTheta(theta);
  const seed = await pickGrammarSeed(target);
  if (seed === null) return null;

  // GrammarDrillGenInputSchema bounds patternKey/patternDisplay to 120 chars.
  // kgiu_entries.pattern is a short pattern string in live data, but slice
  // defensively so a corpus outlier can never fail proxy validation (mirrors
  // lib/grammarBank.ts's client-side patternDisplay trim/slice).
  const patternKey = seed.seedKorean.slice(0, 120);
  const patternDisplay = patternKey;
  const meaning = (seed.seedEnglish ?? seed.seedGloss)?.slice(0, 300);

  const proxy = getClaudeProxy();
  const { result } = await proxy
    .generateGrammarDrill(
      {
        patternKey,
        patternDisplay,
        ...(meaning !== undefined ? { meaning } : {}),
        drillType: 'transformation',
      },
      { ...(correlationId !== undefined ? { requestId: correlationId } : {}), userId },
    )
    .catch((err: unknown) => {
      // Mirrors buildGeneratedItem's mapClaudeError wrap exactly: a
      // recognized ClaudeProxyError is already a safe UpstreamError, reuse
      // it; anything else (raw network/SDK error) is logged server-side only
      // and rethrown as a fixed, wire-safe message.
      const mapped = mapClaudeError(err);
      if (mapped !== err) throw mapped;
      getLogger().error(
        {
          correlationId,
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : { value: String(err) },
        },
        'diagnostic writing item generation failed',
      );
      throw new UpstreamError('diagnostic writing item generation failed');
    });

  // The route always REQUESTS 'transformation' — a different `type` back
  // means the model ignored the forced tool schema, a server-side invariant
  // violation (mirrors grammarDrill.ts POST /'s identical assertion), not a
  // user-facing error.
  if (result.type !== 'transformation') {
    throw new UpstreamError('diagnostic writing item generation returned an unexpected drill type');
  }
  const drill: Extract<GrammarDrillItem, { type: 'transformation' }> = result;

  return {
    section: 'writing',
    sourceKind: 'generated',
    sourceRef: seed.sourceRef,
    // Difficulty recorded = the TARGET level the item was generated at —
    // same convention buildGeneratedItem uses for vocab/grammar (not the
    // learner's actual answer, which is unknown until grading).
    difficulty: proficiencyToNumber(target),
    kind: 'writing-production',
    level: target,
    // The on-screen prompt: Claude's EN task instruction ("Rewrite using
    // -는 것 같다") is the `prompt`; the KR base sentence to transform rides in
    // `passage` (reused — same "Korean text the prompt is about" role a
    // reading passage plays) so the client's existing PassageCard renders it
    // with no new wire field; the EN gloss of that base sentence rides in
    // `hint` (both fields already exist on ServerItem/ClientItem).
    prompt: drill.instruction,
    passage: drill.sourceKr,
    hint: drill.sourceEn,
    choices: [],
    correctAnswer: WRITING_ANSWER_SENTINEL,
    explain: '',
    // COLUMN-PRIVATE — see the ServerItem field docs. Read back by the
    // /answer writing branch, never spread onto a ClientItem.
    referenceModelKr: drill.referenceModelKr,
    referenceModelEn: drill.referenceModelEn,
    patternDisplay,
  };
}

/**
 * Build the next ServerItem for `section` at the current θ, excluding topik
 * ids / hanja chars already served. Returns null when the section pool/seed
 * is empty (the caller serves fewer items and scores only answered dims).
 */
async function buildItemForSection(
  section: DiagnosticDimensionKey,
  theta: number,
  excludeTopikIds: readonly string[],
  excludeHanjaChars: readonly string[],
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
  if (section === 'hanja') {
    return buildHanjaItem(band, excludeHanjaChars);
  }
  if (section === 'writing') {
    return buildWritingItem(theta, correlationId, userId);
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
    ...(item.audioUrl !== undefined ? { audioUrl: item.audioUrl } : {}),
    ...(item.audioStartMs !== undefined ? { audioStartMs: item.audioStartMs } : {}),
    ...(item.audioEndMs !== undefined ? { audioEndMs: item.audioEndMs } : {}),
    choices: item.choices,
    explain: item.explain,
    // COLUMN-PRIVATE (diagnostic-upgrade Phase B): stored so /answer's writing
    // branch and grading can read them back, but deliberately NOT part of
    // `StoredItemPayload`'s narrower field list, so `pendingClientItem`'s
    // explicit allow-list spread can never leak them onto a ClientItem —
    // mirrors `explain` above, which has ridden this same private-payload
    // pattern since Pass 5.
    ...(item.referenceModelKr !== undefined
      ? { referenceModelKr: item.referenceModelKr }
      : {}),
    ...(item.referenceModelEn !== undefined
      ? { referenceModelEn: item.referenceModelEn }
      : {}),
    ...(item.patternDisplay !== undefined ? { patternDisplay: item.patternDisplay } : {}),
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

/** hanja chars already served in this run (to avoid repeats). Scoped by
 *  `section = 'hanja'` rather than `source_kind` — hanja reuses
 *  source_kind='generated' (shared with vocab/grammar; see `buildHanjaItem`),
 *  so section is the discriminator here, mirroring `servedTopikIds`. */
async function servedHanjaChars(runId: number): Promise<string[]> {
  const { rows } = await query<{ source_ref: string }>(
    `SELECT source_ref FROM diagnostic_responses
      WHERE run_id = $1 AND section = 'hanja' AND source_ref IS NOT NULL`,
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
    const excludeTopik = await servedTopikIds(runId);
    const excludeHanja = await servedHanjaChars(runId);
    const item = await buildItemForSection(
      section,
      theta,
      excludeTopik,
      excludeHanja,
      correlationId,
      userId,
    );
    if (item === null) {
      // Empty/short pool — skip this ordinal. Scoring already tolerates a
      // dimension that received < WEIGHTS[dim] items (and omits one that got
      // 0), but a silently shrinking run is a corpus-data problem we want
      // visible in the logs, not swallowed.
      getLogger().warn(
        { runId, ordinal, section, ...(correlationId !== undefined ? { correlationId } : {}) },
        'diagnostic: section pool empty — skipping ordinal',
      );
      continue;
    }
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
  /** Confidence-band floor, 0–100. Equal to `score` (zero-width band) when
   *  the snapshot predates the band (rubric < v1.1.0) or its stats are
   *  missing/malformed — degrade, never crash. */
  readonly scoreLow: number;
  /** Confidence-band ceiling, 0–100. Same degradation rule as `scoreLow`. */
  readonly scoreHigh: number;
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
  hanja: { label: 'Hanja', kr: '한자' },
  writing: { label: 'Writing', kr: '쓰기' },
};

/** Reference lines for the snapshot chart, lowest-first. F-002 fixpass SF-1:
 *  L1/L2 join the ladder (values 10/25 per the scoring anchor table
 *  {1→10, 2→25, 3→40, …}) so a beginner placing at score 10/25 has real
 *  reference lines instead of floating below TOPIK 3 = 40. Must stay in sync
 *  with the client's DIAGNOSTIC_SNAPSHOT_FIXTURE references. */
const REFERENCES: SnapshotDTO['references'] = [
  { id: 'L1', label: 'TOPIK 1', kr: '1급', value: 10 },
  { id: 'L2', label: 'TOPIK 2', kr: '2급', value: 25 },
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

/**
 * Per-dimension scoring stats persisted in the snapshot's `evidence` JSONB
 * under `dimensionStats` (rubric v1.1.0+, F-011). The snapshot table stores
 * only the point-estimate columns, so the band (which needs n/correct) is
 * carried here — no migration needed. Read back by `/latest`, `/history` and
 * the idempotent `/finish` to rebuild `scoreLow`/`scoreHigh`.
 */
interface DimensionStat {
  readonly n: number;
  readonly correct: number;
  readonly estimate: number;
  readonly score: number;
  readonly scoreLow: number;
  readonly scoreHigh: number;
}

const DIMENSION_STAT_FIELDS = [
  'n',
  'correct',
  'estimate',
  'score',
  'scoreLow',
  'scoreHigh',
] as const;

/**
 * Extract the per-dimension band stats from a snapshot's `evidence` JSONB.
 *
 * Deliberately forgiving: legacy rubric v1.0.0 rows ('{}' or no
 * `dimensionStats`), and any malformed/partial entry, simply yield no stat
 * for that dimension — the DTO builder then degrades that dimension to a
 * zero-width band (`scoreLow = scoreHigh = score`). Old snapshots must keep
 * loading forever; this reader must NEVER throw on their shape.
 */
function dimensionStatsFromEvidence(
  evidence: unknown,
): Partial<Record<DiagnosticDimensionKey, DimensionStat>> {
  const out: Partial<Record<DiagnosticDimensionKey, DimensionStat>> = {};
  if (typeof evidence !== 'object' || evidence === null) return out;
  const block = (evidence as Record<string, unknown>)['dimensionStats'];
  if (typeof block !== 'object' || block === null) return out;
  for (const key of DIMENSION_ORDER) {
    const raw = (block as Record<string, unknown>)[key];
    if (typeof raw !== 'object' || raw === null) continue;
    const stat = raw as Record<string, unknown>;
    const valid = DIMENSION_STAT_FIELDS.every((f) => {
      const v = stat[f];
      return typeof v === 'number' && Number.isFinite(v);
    });
    if (!valid) continue; // malformed entry — degrade this dimension to no band
    out[key] = {
      n: stat['n'] as number,
      correct: stat['correct'] as number,
      estimate: stat['estimate'] as number,
      score: stat['score'] as number,
      scoreLow: stat['scoreLow'] as number,
      scoreHigh: stat['scoreHigh'] as number,
    };
  }
  return out;
}

/**
 * Build the SnapshotDTO from the four stored estimates plus (optionally) the
 * per-dimension band stats. A dimension with no stat — every pre-v1.1.0
 * snapshot, or a malformed evidence entry — degrades to a zero-width band
 * (`scoreLow = scoreHigh = score`); it never crashes. When a stat IS present,
 * the band is re-anchored on the freshly computed `score` (min/max) so a
 * corrupt stored band can never invert the `scoreLow ≤ score ≤ scoreHigh`
 * invariant the client renders against.
 */
function buildSnapshotDTO(
  estimates: Partial<Record<DiagnosticDimensionKey, number | null>>,
  stats: Partial<Record<DiagnosticDimensionKey, DimensionStat>> = {},
): SnapshotDTO {
  const dimensions: SnapshotDimensionDTO[] = [];
  for (const key of DIMENSION_ORDER) {
    const stat = stats[key];
    // `estimates` here is whatever the CALLER read back (loadSnapshotDTO only
    // SELECTs reading/listening/grammar/vocab_estimate — the pre-v1.3.0 four
    // — even though `writing_estimate` (diagnostic-upgrade Phase B) IS now a
    // real, populated column; it just has no reason to be re-read here, see
    // below). `hanja` (Phase A) has NO dedicated column at all. Both
    // dimensions' estimates live ONLY in evidence.dimensionStats when read
    // through this path (see DimensionStat below). Prefer the stat's
    // estimate for every dimension when present — it is bit-identical to the
    // fixed-column value for reading/listening/vocab/grammar, both computed
    // from the same `scored` array within the same /finish call, and it is
    // the ONLY source for hanja/writing — and fall back to `estimates[key]`
    // (the fixed columns) only for legacy rows (pre-v1.1.0) that predate
    // dimensionStats entirely, where hanja/writing estimates are moot anyway
    // (neither dimension existed yet).
    const est = stat !== undefined ? stat.estimate : estimates[key];
    if (est === undefined || est === null) continue;
    const score = estimateToScore(est);
    const scoreLow = stat !== undefined ? Math.min(stat.scoreLow, score) : score;
    const scoreHigh = stat !== undefined ? Math.max(stat.scoreHigh, score) : score;
    const labels = DIMENSION_LABELS[key];
    dimensions.push({
      key,
      label: labels.label,
      kr: labels.kr,
      score,
      scoreLow,
      scoreHigh,
      note: noteForScore(score),
    });
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
// BIGINT ids: bounded so a 20-digit id 400s at the boundary instead of
// overflowing int8 in pg (22003 → 500; routes sweep #3).
const RunParamsSchema = z.object({
  runId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const AnswerBodySchema = z.object({
  responseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  // 'a'..'d' for a multiple-choice item; a free-text Korean sentence (bounded
  // like grammar-drill's own `answer` field, GrammarDrillScoreInputSchema.
  // userAnswer max 600) for a writing item (diagnostic-upgrade Phase B); null
  // = skip. The route determines WHICH shape applies from the server-stored
  // item's own `section`, never from this union alone — an MC item with a
  // stray free-text `picked` simply fails the `=== correct_answer` compare
  // (graded wrong), the same as any other wrong guess.
  picked: z.union([z.enum(['a', 'b', 'c', 'd']), z.string().max(600), z.null()]),
  timeMs: z.number().int().nonnegative().max(60 * 60 * 1000).optional(),
});

/**
 * POST /diagnostic — start a run and serve item #1.
 * diagnosticLimiter: may trigger a Claude generation for the first item; the
 * diagnostic run's own bucket, not the shared expensiveLimiter (see the
 * top-of-file SECURITY note).
 */
router.post('/', diagnosticLimiter(), validateBody(EmptyBodySchema), async (req, res, next) => {
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

/** One writing item's item_payload, as `insertResponse` persists it — the
 *  slice the /answer writing branch needs to reconstruct the grading input.
 *  Deliberately narrower than `StoredItemPayload` below: this is read ONLY
 *  server-side, pre-transaction, to decide whether a Claude grading call is
 *  needed — it is never spread onto a ClientItem. */
interface WritingItemPayload {
  readonly passage?: string;
  readonly referenceModelKr?: string;
  readonly referenceModelEn?: string;
  readonly patternDisplay?: string;
}

/** The graded outcome of a writing item's Claude scoring call, resolved
 *  BEFORE the grading transaction opens (external I/O must never happen
 *  inside an open DB tx — mirrors `POST /` and grammarDrill.ts's submit
 *  route). `null` on any non-writing item (the common case). */
interface WritingGrade {
  readonly isCorrect: boolean;
  readonly score: number;
  readonly verdict: DrillVerdict;
  readonly summary: string;
  readonly corrections: ReadonlyArray<{ span: string; issue: string; fix: string }>;
  readonly referenceModelKr: string;
  readonly referenceModelEn: string;
}

/** {excellent,good} → correct (θ up); {needs_work,incorrect} → wrong (θ
 *  down). Binary by design (locked decision) — a needs_work "half credit"
 *  step is a later refinement, not built here. */
function isCorrectVerdict(verdict: DrillVerdict): boolean {
  return verdict === 'excellent' || verdict === 'good';
}

/**
 * Grade a writing item's free-text answer via `scoreGrammarDrill` — the SAME
 * Claude call Pass 9's Grammar screen submit route makes, reused rather than
 * a new route (diagnostic-upgrade Phase B). Called OUTSIDE any DB
 * transaction (external I/O). An empty/whitespace-only answer never reaches
 * Claude at all — it is graded incorrect locally (a real user must type
 * something to submit; this is the server-side graceful path for a client
 * that skips that enforcement or crashes mid-type, never a 400/500 — see
 * spec: "the server must not crash/hang").
 */
async function gradeWritingAnswer(
  payload: WritingItemPayload,
  userAnswer: string,
  correlationId: string | undefined,
  userId: number,
): Promise<WritingGrade> {
  const referenceModelKr = payload.referenceModelKr;
  const referenceModelEn = payload.referenceModelEn ?? '';
  const patternDisplay = payload.patternDisplay;
  if (referenceModelKr === undefined || patternDisplay === undefined) {
    // Server-authored payload must always carry these for a writing item —
    // reaching here means insertResponse/buildWritingItem drifted from this
    // reader. Fail loudly rather than silently mis-grade.
    throw new Error('diagnostic writing item_payload missing referenceModelKr/patternDisplay');
  }
  const trimmed = userAnswer.trim();
  if (trimmed === '') {
    return {
      isCorrect: false,
      score: 0,
      verdict: 'incorrect',
      summary: 'No answer was submitted.',
      corrections: [],
      referenceModelKr,
      referenceModelEn,
    };
  }
  const promptText = payload.passage ?? '';
  const proxy = getClaudeProxy();
  const { result: scored } = await proxy
    .scoreGrammarDrill(
      {
        drillType: 'transformation',
        patternDisplay,
        promptText,
        referenceModelKr,
        userAnswer: trimmed,
      },
      { ...(correlationId !== undefined ? { requestId: correlationId } : {}), userId },
    )
    .catch((err: unknown) => {
      // Mirrors buildWritingItem's / buildGeneratedItem's wrap exactly.
      const mapped = mapClaudeError(err);
      if (mapped !== err) throw mapped;
      getLogger().error(
        {
          correlationId,
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : { value: String(err) },
        },
        'diagnostic writing grading failed',
      );
      throw new UpstreamError('diagnostic writing grading failed');
    });
  return {
    isCorrect: isCorrectVerdict(scored.verdict),
    score: scored.score,
    verdict: scored.verdict,
    summary: scored.summary,
    corrections: scored.corrections,
    referenceModelKr,
    referenceModelEn,
  };
}

/**
 * POST /diagnostic/:runId/answer — grade the current item and return the
 * reveal. Does NOT serve the next item: grading is cheap local DB work and
 * must never block on Claude (B-006) — the client calls /:runId/next for the
 * following item during the reveal dwell. cheapLimiter for the same reason:
 * nothing here is expensive, and an expensive-bucket 429 must not be able to
 * withhold the reveal for an answer the user already committed. A WRITING
 * item is the one exception (diagnostic-upgrade Phase B): grading it DOES
 * make one Claude call (`scoreGrammarDrill`) — see the top-of-file SECURITY
 * note for why this route stays on cheapLimiter anyway (bounded to ≤2/run).
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

      // Pre-transaction, UNLOCKED read: is the item being answered a writing
      // item that still needs grading? Scoped to exactly this responseId
      // (not "the current pending item" — that re-check happens under the
      // lock below) so an out-of-order/wrong responseId simply gets no grade
      // precomputed and falls through to the existing 409 replay defense.
      // Claude I/O must happen HERE, before the transaction opens (mirrors
      // `POST /` and grammarDrill.ts's submit route) — never inside an open
      // DB tx.
      const { rows: preRows } = await query<{
        section: DiagnosticDimensionKey;
        answered_at: Date | null;
        item_payload: WritingItemPayload;
      }>(
        `SELECT section, answered_at, item_payload
           FROM diagnostic_responses
          WHERE id = $1 AND run_id = $2`,
        [body.responseId, params.runId],
      );
      const pre = preRows[0];
      let writingGrade: WritingGrade | null = null;
      if (pre !== undefined && pre.section === 'writing' && pre.answered_at === null) {
        const userAnswer = typeof body.picked === 'string' ? body.picked : '';
        writingGrade = await gradeWritingAnswer(
          pre.item_payload,
          userAnswer,
          req.correlationId,
          userId,
        );
      }

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

        // Grade server-side. A skip (picked null) is is_correct=false. A
        // WRITING item (diagnostic-upgrade Phase B) never compares `picked`
        // against `correct_answer` (the sentinel isn't a real key) — its
        // verdict was already resolved by `gradeWritingAnswer` BEFORE this
        // transaction opened; reuse that result here under the lock.
        const isWriting = current.section === 'writing';
        const isCorrect = isWriting
          ? (writingGrade?.isCorrect ?? false)
          : body.picked !== null && body.picked === current.correct_answer;

        // COVERAGE-ONLY (diagnostic-upgrade Phase A): a hanja answer is
        // graded and recorded exactly like any other item, but it must NEVER
        // bump the run's global θ ladder — the hanja corpus caps at L3 (no
        // L4/L5 rows; see `buildHanjaItem`), so letting it participate would
        // drag an advanced learner's overall placement toward that ceiling.
        // It is therefore ALSO excluded from the θ-step ordinal (the
        // `answerNumber` that drives `stepForAnswer`'s decay): the count
        // below is of non-hanja answers only, so interleaving 4 hanja items
        // through the run never dilutes the other dimensions' staircase —
        // core-skill step N is always "the Nth core-skill answer", regardless
        // of how many hanja items were answered alongside it.
        //
        // FULL LEVELED DIMENSION (diagnostic-upgrade Phase B): writing is
        // DELIBERATELY the opposite of hanja here — a writing answer DOES
        // bump θ and DOES consume a step-ordinal slot. No new branch was
        // needed: the guard below is already `section <> 'hanja'`, not an
        // allow-list of the original four, so writing falls through it
        // exactly like reading/listening/vocab/grammar always have.
        const isHanja = current.section === 'hanja';
        let updatedTheta: number | null = null;
        if (!isHanja) {
          // CAT step number = (non-hanja answers already recorded) + 1,
          // counted UNDER THE LOCK so a racing request can't inflate it (S4).
          const { rows: answeredCountRows } = await client.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM diagnostic_responses
              WHERE run_id = $1 AND answered_at IS NOT NULL AND section <> 'hanja'`,
            [params.runId],
          );
          const answerNumber = Number(answeredCountRows[0]!.n) + 1;
          const priorTheta =
            locked.ability_estimate !== null ? Number(locked.ability_estimate) : SEED_THETA;
          updatedTheta = nextTheta(priorTheta, isCorrect, answerNumber);
        }

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
        // Persist the Claude grade (score/verdict/summary/corrections) into
        // item_payload for the reveal + any later re-read (mirrors
        // grammarDrill.ts's `feedback` JSONB write). A jsonb `||` merge keeps
        // the original referenceModelKr/En/patternDisplay/passage/prompt keys
        // intact — this only ADDS the graded-* keys.
        if (isWriting && writingGrade !== null) {
          await client.query(
            `UPDATE diagnostic_responses
                SET item_payload = item_payload || $2::jsonb
              WHERE id = $1`,
            [
              body.responseId,
              JSON.stringify({
                gradedScore: writingGrade.score,
                gradedVerdict: writingGrade.verdict,
                gradedSummary: writingGrade.summary,
                gradedCorrections: writingGrade.corrections,
              }),
            ],
          );
        }
        if (updatedTheta !== null) {
          await client.query(
            `UPDATE diagnostic_runs
                SET ability_estimate = $2, version = version + 1
              WHERE id = $1`,
            [params.runId, thetaToNumeric(updatedTheta)],
          );
        } else {
          // Hanja: still bump the run's optimistic-concurrency counter (a
          // real state change happened) without touching ability_estimate.
          await client.query(
            `UPDATE diagnostic_runs SET version = version + 1 WHERE id = $1`,
            [params.runId],
          );
        }

        return {
          isCorrect,
          correctAnswer: current.correct_answer,
          ordinal: current.ordinal,
        };
      });

      // For a writing item, the reveal is the Claude verdict/summary/
      // corrections/reference model, not an MC explain string — `explain`
      // still degrades to `writingGrade.summary` so a client that hasn't
      // wired the writing-specific fields yet still shows something
      // meaningful, but the dedicated fields below are what the client
      // actually renders.
      const result = {
        correct: graded.isCorrect,
        correctAnswer: graded.correctAnswer,
        explain:
          writingGrade !== null
            ? writingGrade.summary
            : await explainFor(params.runId, body.responseId),
        ...(writingGrade !== null
          ? {
              verdict: writingGrade.verdict,
              summary: writingGrade.summary,
              corrections: writingGrade.corrections,
              referenceModelKr: writingGrade.referenceModelKr,
              referenceModelEn: writingGrade.referenceModelEn,
            }
          : {}),
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
  readonly audioUrl?: string;
  readonly audioStartMs?: number;
  readonly audioEndMs?: number;
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
    ...(p.audioUrl !== undefined ? { audioUrl: p.audioUrl } : {}),
    ...(p.audioStartMs !== undefined ? { audioStartMs: p.audioStartMs } : {}),
    ...(p.audioEndMs !== undefined ? { audioEndMs: p.audioEndMs } : {}),
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
 * diagnosticLimiter (the diagnostic run's own bucket, not the shared
 * expensiveLimiter — see the top-of-file SECURITY note), and the client
 * calls it during the reveal dwell so the latency overlaps reading the
 * explanation instead of blocking the reveal.
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
  diagnosticLimiter(),
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

      // Per-dimension band stats (F-011). The snapshot table's estimate
      // columns can't reproduce the confidence band on read (it needs n and
      // the correct-count), so the full stats ride in the `evidence` JSONB —
      // `dimensionStatsFromEvidence` reads them back for /latest, /history and
      // the idempotent re-finish. Dimensions that received zero items are
      // omitted, mirroring the estimate columns.
      const results = resultsByDimension(scored);
      const dimensionStats: Partial<Record<DiagnosticDimensionKey, DimensionStat>> = {};
      for (const dim of DIMENSION_ORDER) {
        const result = results[dim];
        if (result === null) continue;
        const correct = scored.filter((r) => r.section === dim && r.isCorrect).length;
        dimensionStats[dim] = {
          n: result.n,
          correct,
          estimate: result.estimate,
          score: result.score,
          scoreLow: result.scoreLow,
          scoreHigh: result.scoreHigh,
        };
      }

      // Reconstruct the per-answer θ trajectory from the ordered responses.
      // The single `ability_estimate` column only persists the LATEST θ, so the
      // sequence is recomputed deterministically here: fold the CAT update over
      // the answered responses in ordinal order, seeding at SEED_THETA and using
      // the same `nextTheta` staircase the live /answer handler applied. The
      // result is the θ AFTER each answer (length = number of answered items),
      // which is the real evidence the contract asks for — not a one-element
      // array of the final value. The final element equals `ability_estimate`
      // (modulo the 2-dp rounding the column stores) by construction.
      //
      // Hanja rows mirror the live /answer handler EXACTLY (coverage-only):
      // they never advance `runningTheta` and never consume a step ordinal —
      // `coreAnswerNumber` counts non-hanja answers only, so a hanja row's
      // trajectory entry simply repeats the θ from the answer before it.
      let runningTheta = SEED_THETA;
      let coreAnswerNumber = 0;
      const thetaTrajectory = respRows.map((r) => {
        if (r.section !== 'hanja') {
          coreAnswerNumber += 1;
          runningTheta = nextTheta(runningTheta, r.is_correct === true, coreAnswerNumber);
        }
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
        dimensionStats,
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
        // writing_estimate (diagnostic-upgrade Phase B): this column has
        // existed since 001_core_schema and `plan.ts`'s /plan/today ALREADY
        // reads it (to band-prefer reading content) — it was hardcoded NULL
        // here only because no rubric version before v1.4.0 ever scored a
        // writing dimension. Wiring `estimates.writing` through activates
        // that pre-existing plan.ts consumer for real, at no cost (same INSERT,
        // one fewer hardcoded NULL). `register_estimate` stays NULL — no
        // dimension here produces a register signal.
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO diagnostic_snapshots (
              user_id, reading_estimate, listening_estimate, writing_estimate,
              grammar_estimate, vocab_estimate, register_estimate,
              evidence, rubric_version)
           VALUES ($1, $2, $3, $4, $5, $6, NULL, $7::jsonb, $8)
           RETURNING id::text AS id`,
          [
            userId,
            estimates.reading,
            estimates.listening,
            estimates.writing,
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
      const dto =
        (await loadSnapshotDTO(snapshotId, userId)) ?? buildSnapshotDTO(estimates, dimensionStats);
      res.status(200).json({ snapshot: dto });
    } catch (err) {
      next(mapClaudeError(err));
    }
  },
);

/** Load a stored snapshot (user-scoped) and rebuild its DTO. The band comes
 *  from `evidence.dimensionStats` (v1.1.0+); legacy v1.0.0 rows have no such
 *  block and degrade to a zero-width band — they must never fail to load. */
async function loadSnapshotDTO(snapshotId: number, userId: number): Promise<SnapshotDTO | null> {
  const { rows } = await query<{
    reading_estimate: string | null;
    listening_estimate: string | null;
    grammar_estimate: string | null;
    vocab_estimate: string | null;
    evidence: unknown;
  }>(
    `SELECT reading_estimate, listening_estimate, grammar_estimate, vocab_estimate,
            evidence
       FROM diagnostic_snapshots
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [snapshotId, userId],
  );
  const row = rows[0];
  if (!row) return null;
  return buildSnapshotDTO(
    {
      reading: row.reading_estimate !== null ? Number(row.reading_estimate) : null,
      listening: row.listening_estimate !== null ? Number(row.listening_estimate) : null,
      grammar: row.grammar_estimate !== null ? Number(row.grammar_estimate) : null,
      vocab: row.vocab_estimate !== null ? Number(row.vocab_estimate) : null,
    },
    dimensionStatsFromEvidence(row.evidence),
  );
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

/** One history entry: the /latest SnapshotDTO shape plus its capture time. */
interface HistorySnapshotDTO extends SnapshotDTO {
  readonly capturedAt: string;
}

/**
 * GET /diagnostic/history — ALL of the user's snapshots, oldest→newest.
 *
 * Returns `{ snapshots: HistorySnapshotDTO[] }` where each entry is the exact
 * SnapshotDTO shape `/latest` returns (dimensions / references / defaultRef /
 * goals) plus `capturedAt` (ISO-8601). Drives the Progress screen's trend
 * chart + attempt-vs-attempt comparison. A user with no finished runs gets a
 * 200 with `snapshots: []` — the same "empty, not 404" posture as `/latest`.
 *
 * SECURITY: user-scoped via getUserId. Defends against: BOLA/IDOR — the query
 * is parameterized and filtered `WHERE user_id = $1`, so one user can never
 * read another user's snapshot history. Soft-deleted rows are excluded.
 * `ORDER BY captured_at ASC, id ASC` — the id tiebreak keeps the order
 * deterministic when two snapshots share a capture timestamp.
 */
router.get('/history', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { rows } = await query<{
      captured_at: Date;
      reading_estimate: string | null;
      listening_estimate: string | null;
      grammar_estimate: string | null;
      vocab_estimate: string | null;
      evidence: unknown;
    }>(
      `SELECT captured_at, reading_estimate, listening_estimate,
              grammar_estimate, vocab_estimate, evidence
         FROM diagnostic_snapshots
        WHERE user_id = $1 AND deleted_at IS NULL
        ORDER BY captured_at ASC, id ASC`,
      [userId],
    );
    const snapshots: HistorySnapshotDTO[] = rows.map((r) => ({
      capturedAt: r.captured_at.toISOString(),
      // Band from evidence.dimensionStats — same reader as /latest, same
      // zero-width degradation for pre-v1.1.0 rows.
      ...buildSnapshotDTO(
        {
          reading: r.reading_estimate !== null ? Number(r.reading_estimate) : null,
          listening: r.listening_estimate !== null ? Number(r.listening_estimate) : null,
          grammar: r.grammar_estimate !== null ? Number(r.grammar_estimate) : null,
          vocab: r.vocab_estimate !== null ? Number(r.vocab_estimate) : null,
        },
        dimensionStatsFromEvidence(r.evidence),
      ),
    }));
    res.status(200).json({ snapshots });
  } catch (err) {
    next(err);
  }
});

export default router;
