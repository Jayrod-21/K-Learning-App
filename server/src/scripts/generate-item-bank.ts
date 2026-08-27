/**
 * generate-item-bank CLI — F-220 slice 1: $0 emit->ingest batch generation
 * of the generated, copyright-clean assessment-item bank (`generated_items`,
 * migration 101).
 *
 * WHY THIS EXISTS
 * The live diagnostic authors ONE vocab/grammar item per Claude call, at
 * request time, never persisted (routes/diagnostic.ts `buildGeneratedItem`).
 * F-220 wants a standing, reviewable BANK of such items so the diagnostic can
 * eventually serve from curated, approved rows instead of a fresh paid call
 * every time. This tool builds that bank offline, at $0, using the F-209
 * emit->fill->ingest pattern (scripts/preseed-definitions.ts): --emit-batch
 * writes the EXACT prompts a subscription Claude session should run (zero
 * API spend); the operator/session fills each entry's `response`; --ingest
 * validates + writes rows (zero API spend either way — nothing in this file
 * ever calls the Claude proxy).
 *
 * REUSE, NOT REIMPLEMENTATION
 * Every item is built from the SAME prompt/schema/guards the live diagnostic
 * uses, unmodified:
 *   - `buildDiagnosticItemRequest` (services/claude/prompts/diagnostic_item)
 *     builds the exact request a subscription session should send.
 *   - `DiagnosticItemResultSchema` (services/claude/models) validates the
 *     filled response at ingest.
 *   - `shuffleGeneratedChoices` (routes/diagnostic.ts) applies the SAME
 *     choice-shuffle the live path uses (the model biases the correct
 *     answer toward index 0 — un-shuffled items would be gameable).
 *   - The section<->kind contract (vocab -> synonym|cloze, grammar ->
 *     pattern) is re-checked at ingest exactly as the live path checks it.
 * No prompt is hand-written here.
 *
 * COPYRIGHT — THE ENTIRE POINT OF F-220
 * Seeds come from copyright-clean sources ONLY:
 *   - vocab: `vocab_entries` (korean headword + english gloss) — the same
 *     seed source the LIVE diagnostic path already uses
 *     (`routes/diagnostic.ts` `pickVocabSeed`). RECON.md lists vocab_entries
 *     among the app's already-clean corpora (copyright-safe OCR); individual
 *     words + short glosses are not protectable expression the way the
 *     source book's prose is.
 *   - grammar: DELIBERATELY DOES NOT reuse the live diagnostic's
 *     `pickGrammarSeed` — that helper seeds from `kgiu_entries` (pattern +
 *     title_en + explanation), and `explanation`/`title_en` are Darakwon
 *     KGIU-book PROSE (db/migrations/002_darakwon_corpora.up.sql — the exact
 *     corpus RECON.md's copyright-blocker list names). This CLI seeds
 *     grammar generation from `canonical_grammar.canonical_pattern` ONLY —
 *     the corpus-agnostic dedup layer's PATTERN STRING (e.g. "-(으)면"), never
 *     its prose. A grammar pattern form is a linguistic fact reproduced in
 *     every Korean grammar reference, not original Darakwon expression.
 *     `kgiu_entries` is touched ONLY to find which `canonical_grammar` rows
 *     have a member at a given proficiency level (a level TAG, not text) —
 *     no prose column is ever read. See `pickGrammarPatternSeeds` below.
 *     FLAGGED per the build brief: no `seedEnglish`/`seedGloss` is sent for
 *     grammar items (the only clean English name would come from KGIU
 *     prose) — grammar items are seeded from the bare pattern string alone.
 *   - reading (F-220 SLICE 2): seeded from `server/src/scripts/
 *     readingTopics.ts`'s static, app-owned, hand-picked list of BARE neutral
 *     topic words (e.g. '날씨') — not a DB table at all, and never derived
 *     from any ingested corpus. Claude receives ONLY the bare topic and
 *     authors the passage 100% FRESH (prompts/diagnostic_reading_item.ts) —
 *     it is never given, and therefore can never summarize/paraphrase, any
 *     existing text. This is the first F-220 slice that generates the
 *     PASSAGE itself, not just a question about existing content.
 *   - listening (F-220 SLICE 3): seeds from the SAME `readingTopics.ts` list
 *     — a bare neutral topic is exactly as safe a seed for a spoken dialogue
 *     as it is for a printed passage, and reusing the list (rather than
 *     forking a parallel one) keeps the "every entry is a bare concept"
 *     copyright claim in ONE reviewable place. Claude authors an ORIGINAL
 *     multi-turn dialogue 100% FRESH from the bare topic
 *     (prompts/diagnostic_listening_item.ts) — never from an existing
 *     transcript or conversation. This CLI writes the SCRIPT only (`turns`
 *     JSONB + the question) at $0; the audio itself is a SEPARATE, METERED
 *     step (`scripts/synthesize-listening-audio.ts`, run later by an
 *     operator) — see that file's header for why script authoring and paid
 *     ElevenLabs synthesis are split into two tools.
 *
 * MODES (— COUNT IS THE DEFAULT; nothing in this file ever spends money)
 *   --count / --dry-run   Enumerate the grid (SECTIONS x LEVELS) and how many
 *                         seed entries are available per cell. ZERO writes.
 *   --emit-batch --out=<file> [--per-cell=N] [--section=vocab|grammar|reading|
 *                         listening|paired-reading|paired-listening]
 *                         [--level=L1..L5+]
 *                         For each cell, pick up to N (default 25) DISTINCT
 *                         seed entries and build the EXACT
 *                         `generateDiagnosticItem` request for each. Writes a
 *                         JSON work-order. ZERO API spend, ZERO writes. A
 *                         subscription Claude session fills each entry's
 *                         `response` with the model's raw JSON reply.
 *   --ingest --in=<file>  Read the FILLED work-order, Zod-validate each
 *                         `response` against `DiagnosticItemResultSchema`,
 *                         apply the section<->kind contract +
 *                         `shuffleGeneratedChoices`, recompute + verify
 *                         `prompt_hash` (drift -> skip), and INSERT into
 *                         `generated_items` (`status='draft'`,
 *                         `ON CONFLICT (prompt_hash) DO NOTHING` — the
 *                         idempotency key). Invalid/malformed items are
 *                         REJECTED and reported, never written. A run that
 *                         writes NOTHING and finds nothing already cached is
 *                         non-zero — an unfilled work-order must never look
 *                         green (mirrors preseed-definitions.ts).
 *
 * REVIEW GATE — every row lands `status='draft'`. Only an operator flipping
 * a row to `status='approved'` (a later admin-surface slice) makes it
 * eligible for the draw path (`services/diagnostic/generatedBank.ts`
 * `pickGeneratedItem`), which itself only runs when
 * `DIAGNOSTIC_USE_GENERATED_BANK=true` (default false).
 *
 * SECURITY / SAFETY
 *   - Read-only against vocab_entries/canonical_grammar/kgiu_entries; the
 *     only writes are --ingest's INSERTs into generated_items.
 *   - Every query is a static string + $n parameters (no interpolation).
 *   - Seeds route through the SAME `sanitizeUserInput` + injection guard the
 *     live path applies before being wrapped in `<user_input>` — a
 *     corpus row that somehow contained injection markers is skipped, not
 *     embedded.
 *
 * Exit codes: 0 ok · 1 failure · 2 bad input.
 *
 * Run inside the ACTIVE color's server container, e.g.:
 *   docker exec km-server-<active> node dist/scripts/generate-item-bank.js --count
 *   docker exec km-server-<active> node dist/scripts/generate-item-bank.js \
 *     --emit-batch --out=/tmp/batch.json --per-cell=25
 *   docker exec km-server-<active> node dist/scripts/generate-item-bank.js \
 *     --ingest --in=/tmp/batch-filled.json
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { z } from 'zod';

import { closePool, getPool } from '../db/pool.js';
import { getLogger } from '../logging.js';
import {
  DiagnosticItemInputSchema,
  DiagnosticItemResultSchema,
  DiagnosticReadingItemInputSchema,
  DiagnosticReadingItemResultSchema,
  DiagnosticListeningItemInputSchema,
  DiagnosticListeningItemResultSchema,
  DiagnosticPairedReadingItemInputSchema,
  DiagnosticPairedReadingItemResultSchema,
  DiagnosticPairedListeningItemInputSchema,
  DiagnosticPairedListeningItemResultSchema,
  type DiagnosticItemResult,
  type DiagnosticReadingItemResult,
  type DiagnosticListeningItemResult,
  type DiagnosticPairedReadingItemResult,
  type DiagnosticPairedListeningItemResult,
  type DiagnosticTargetLevel,
} from '../services/claude/models.js';
import {
  hashCacheKey,
  type CacheKey,
} from '../services/claude/cache.js';
import { loadConfig, type ClaudeModelId, type PublicClaudeConfig } from '../services/claude/config.js';
import { serializeMessages, stringifySystem } from '../services/claude/index.js';
import { buildDiagnosticItemRequest } from '../services/claude/prompts/diagnostic_item.js';
import { buildDiagnosticReadingItemRequest } from '../services/claude/prompts/diagnostic_reading_item.js';
import { buildDiagnosticListeningItemRequest } from '../services/claude/prompts/diagnostic_listening_item.js';
import { buildDiagnosticPairedReadingItemRequest } from '../services/claude/prompts/diagnostic_paired_reading_item.js';
import { buildDiagnosticPairedListeningItemRequest } from '../services/claude/prompts/diagnostic_paired_listening_item.js';
import { sanitizeUserInput } from '../services/claude/prompts/sanitize.js';
import type { MessageRequest } from '../services/claude/client.js';
import { shuffleGeneratedChoices } from '../routes/diagnostic.js';
import type { GeneratedBankSection } from '../services/diagnostic/generatedBank.js';
import { READING_TOPICS, pickReadingTopics } from './readingTopics.js';

const READING_TOPIC_COUNT = READING_TOPICS.length;

// ---- CLI contract -----------------------------------------------------------

// F-220 slice 2 adds 'reading': a generated, copyright-clean PASSAGE +
// comprehension MC item, seeded from the static, app-owned topic list
// (readingTopics.ts) instead of a DB table — see pickReadingSeeds below.
// F-220 slice 3 adds 'listening': a generated, copyright-clean DIALOGUE
// (turns[]) + comprehension MC item, seeded from the SAME topic list —
// script only, at $0; audio synthesis is a separate metered CLI.
// F-220 P1 adds 'paired-reading'/'paired-listening': the SAME topic seeding,
// but ONE call authors a whole shared-stimulus BLOCK (one passage/dialogue +
// 2-3 independent questions) instead of a single question — see
// `ItemBankSection` below. These are CLI-level section flags only; the DB
// `generated_items.section` column a paired row lands under is still plain
// 'reading'/'listening' (`kind` distinguishes the paired shape —
// 'paired-passage-mc'/'paired-audio-mc' — from the singular one), so
// `GeneratedBankSection` (the DRAW-path type) is deliberately left
// unchanged: `pickGeneratedItem` never serves a paired row, only
// `pickGeneratedStimulusGroup` does.
export type ItemBankSection = GeneratedBankSection | 'paired-reading' | 'paired-listening';

export const SECTIONS: readonly ItemBankSection[] = [
  'vocab',
  'grammar',
  'reading',
  'listening',
  'paired-reading',
  'paired-listening',
];
export const LEVELS: readonly DiagnosticTargetLevel[] = ['L1', 'L2', 'L3', 'L4', 'L5+'];
export const DEFAULT_PER_CELL = 25;

/** Sections whose stimulus is a bare topic word from the static
 *  `readingTopics.ts` list (never a scarce DB pool) — reading/listening's
 *  singular items AND both paired sections. */
function isTopicSeededSection(section: ItemBankSection): boolean {
  return (
    section === 'reading' ||
    section === 'listening' ||
    section === 'paired-reading' ||
    section === 'paired-listening'
  );
}

export type ItemBankMode = 'count' | 'emit-batch' | 'ingest';

export interface ItemBankOptions {
  readonly mode: ItemBankMode;
  readonly sections: readonly ItemBankSection[];
  readonly levels: readonly DiagnosticTargetLevel[];
  /** emit-batch: how many DISTINCT seeds to draw per (section, level) cell. */
  readonly perCell: number;
  /** emit-batch: path the JSON work-order is written to. */
  readonly outFile: string | undefined;
  /** ingest: path of the FILLED work-order to read. */
  readonly inFile: string | undefined;
}

/** Bad CLI input / bad work-order file → exit 2. */
export class ItemBankInputError extends Error {}

export function exitCodeFor(err: unknown): 1 | 2 {
  return err instanceof ItemBankInputError ? 2 : 1;
}

/** Pure so TS's control-flow analysis sees the assignment at the call site. */
function setMode(prev: ItemBankMode | null, m: ItemBankMode): ItemBankMode {
  if (prev !== null && prev !== m) {
    throw new ItemBankInputError(`conflicting modes: --${prev} and --${m}`);
  }
  return m;
}

function assignOnce(alreadySet: boolean, flag: string): void {
  if (alreadySet) {
    throw new ItemBankInputError(`${flag} given more than once`);
  }
}

function parsePositiveInt(arg: string, flag: string): number {
  const raw = arg.slice(flag.length + 1);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ItemBankInputError(`${flag} must be a positive integer, got "${raw}"`);
  }
  return n;
}

function parseNonEmptyString(arg: string, flag: string): string {
  const raw = arg.slice(flag.length + 1);
  if (raw === '') {
    throw new ItemBankInputError(`${flag} needs a non-empty value`);
  }
  return raw;
}

/**
 * Parse `process.argv.slice(2)`. Strict: unknown flags, malformed values,
 * and conflicting modes throw ItemBankInputError (exit 2) — a typo'd flag
 * must fail loudly, never be silently ignored (mirrors preseed-definitions).
 */
export function parseCliArgs(argv: readonly string[]): ItemBankOptions {
  let mode: ItemBankMode | null = null;
  let section: ItemBankSection | undefined;
  let level: DiagnosticTargetLevel | undefined;
  let perCell: number | undefined;
  let outFile: string | undefined;
  let inFile: string | undefined;

  for (const arg of argv) {
    if (arg === '--count' || arg === '--dry-run') {
      mode = setMode(mode, 'count');
    } else if (arg === '--emit-batch') {
      mode = setMode(mode, 'emit-batch');
    } else if (arg === '--ingest') {
      mode = setMode(mode, 'ingest');
    } else if (arg.startsWith('--ingest=')) {
      // Shorthand: --ingest=<file> ≡ --ingest --in=<file>.
      mode = setMode(mode, 'ingest');
      assignOnce(inFile !== undefined, '--in/--ingest=<file>');
      inFile = parseNonEmptyString(arg, '--ingest');
    } else if (arg.startsWith('--out=')) {
      assignOnce(outFile !== undefined, '--out');
      outFile = parseNonEmptyString(arg, '--out');
    } else if (arg.startsWith('--in=')) {
      assignOnce(inFile !== undefined, '--in/--ingest=<file>');
      inFile = parseNonEmptyString(arg, '--in');
    } else if (arg.startsWith('--per-cell=')) {
      assignOnce(perCell !== undefined, '--per-cell');
      perCell = parsePositiveInt(arg, '--per-cell');
    } else if (arg.startsWith('--section=')) {
      assignOnce(section !== undefined, '--section');
      const raw = arg.slice('--section='.length);
      if (!(SECTIONS as readonly string[]).includes(raw)) {
        throw new ItemBankInputError(
          `unknown --section "${raw}" (valid: ${SECTIONS.join(', ')})`,
        );
      }
      section = raw as ItemBankSection;
    } else if (arg.startsWith('--level=')) {
      assignOnce(level !== undefined, '--level');
      const raw = arg.slice('--level='.length);
      if (!(LEVELS as readonly string[]).includes(raw)) {
        throw new ItemBankInputError(`unknown --level "${raw}" (valid: ${LEVELS.join(', ')})`);
      }
      level = raw as DiagnosticTargetLevel;
    } else {
      throw new ItemBankInputError(`unknown argument "${arg}"`);
    }
  }

  const resolvedMode: ItemBankMode = mode ?? 'count';

  if (resolvedMode === 'emit-batch' && outFile === undefined) {
    throw new ItemBankInputError('--emit-batch requires --out=<file>');
  }
  if (resolvedMode !== 'emit-batch' && outFile !== undefined) {
    throw new ItemBankInputError('--out only applies to --emit-batch');
  }
  if (resolvedMode === 'ingest' && inFile === undefined) {
    throw new ItemBankInputError('--ingest requires --in=<file> (or --ingest=<file>)');
  }
  if (resolvedMode !== 'ingest' && inFile !== undefined) {
    throw new ItemBankInputError('--in only applies to --ingest');
  }
  if (resolvedMode === 'ingest' && (section !== undefined || level !== undefined || perCell !== undefined)) {
    throw new ItemBankInputError(
      '--section/--level/--per-cell do not apply to --ingest (the work-order file is replayed verbatim)',
    );
  }

  return {
    mode: resolvedMode,
    sections: section !== undefined ? [section] : SECTIONS,
    levels: level !== undefined ? [level] : LEVELS,
    perCell: perCell ?? DEFAULT_PER_CELL,
    outFile,
    inFile,
  };
}

// ---- Copyright-clean seed enumeration ---------------------------------------

export interface SeedCandidate {
  readonly seedRef: string;
  readonly seedKorean: string;
  /** Vocab only — vocab_entries.english (copyright-safe short gloss).
   *  NEVER set for grammar (see the header's COPYRIGHT section). */
  readonly seedEnglish?: string;
}

/** No corpus rows are proficiency-tagged 'L1'/'L2' — beginner content is
 *  tagged 'basic' (mirrors routes/diagnostic.ts `seedProficiencyForTarget`,
 *  reproduced here rather than imported since that helper is private to the
 *  route module). L3/L4/L5+ pass through unchanged. */
function seedProficiencyForLevel(level: DiagnosticTargetLevel): string {
  return level === 'L1' || level === 'L2' ? 'basic' : level;
}

/** How many DISTINCT copyright-clean seed rows exist for a cell — the
 *  --count report. `targeted` = rows tagged at this level's proficiency;
 *  `total` = the whole eligible pool (the fallback pass --emit-batch draws
 *  from once the targeted pool is exhausted). */
export interface SeedAvailability {
  readonly targeted: number;
  readonly total: number;
}

export async function countVocabSeeds(
  pool: Pool,
  level: DiagnosticTargetLevel,
): Promise<SeedAvailability> {
  const proficiency = seedProficiencyForLevel(level);
  const [targeted, total] = await Promise.all([
    pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM vocab_entries
        WHERE korean IS NOT NULL AND length(korean) >= 1
          AND source_upload_id IS NULL
          AND proficiency = $1::proficiency_level`,
      [proficiency],
    ),
    pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM vocab_entries
        WHERE korean IS NOT NULL AND length(korean) >= 1
          AND source_upload_id IS NULL`,
    ),
  ]);
  return { targeted: Number(targeted.rows[0]?.n ?? '0'), total: Number(total.rows[0]?.n ?? '0') };
}

/** Mirrors `countVocabSeeds` but counts `canonical_grammar` rows that have a
 *  member at the target proficiency — see the header's COPYRIGHT section for
 *  why this joins `kgiu_entries` for a TAG only, never for prose. */
export async function countGrammarPatternSeeds(
  pool: Pool,
  level: DiagnosticTargetLevel,
): Promise<SeedAvailability> {
  const proficiency = seedProficiencyForLevel(level);
  const [targeted, total] = await Promise.all([
    pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM canonical_grammar cg
        WHERE cg.canonical_pattern IS NOT NULL AND length(cg.canonical_pattern) >= 1
          AND cg.id IN (
            SELECT ke.canonical_grammar_id FROM kgiu_entries ke
             WHERE ke.canonical_grammar_id IS NOT NULL
               AND ke.proficiency = $1::proficiency_level
          )`,
      [proficiency],
    ),
    pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM canonical_grammar
        WHERE canonical_pattern IS NOT NULL AND length(canonical_pattern) >= 1`,
    ),
  ]);
  return { targeted: Number(targeted.rows[0]?.n ?? '0'), total: Number(total.rows[0]?.n ?? '0') };
}

/**
 * Up to `n` DISTINCT copyright-clean vocab seeds for `level`. Two passes,
 * mirroring the live diagnostic's `pickVocabSeed` fallback shape but for a
 * BATCH of distinct rows instead of one: proficiency-targeted first, then
 * top up from the whole eligible pool (excluding rows already picked) if the
 * targeted pool ran short. `english` is included — vocab_entries' short
 * gloss is copyright-safe (see header).
 */
export async function pickVocabSeeds(
  pool: Pool,
  level: DiagnosticTargetLevel,
  n: number,
): Promise<SeedCandidate[]> {
  const proficiency = seedProficiencyForLevel(level);
  const primary = await pool.query<{ id: string; korean: string; english: string | null }>(
    `SELECT id::text AS id, korean, english
       FROM vocab_entries
      WHERE korean IS NOT NULL AND length(korean) >= 1
        AND source_upload_id IS NULL
        AND proficiency = $1::proficiency_level
      ORDER BY random()
      LIMIT $2`,
    [proficiency, n],
  );
  const picked = primary.rows;
  if (picked.length < n) {
    const excludeIds = picked.map((r) => r.id);
    const remaining = n - picked.length;
    const fallback = await pool.query<{ id: string; korean: string; english: string | null }>(
      `SELECT id::text AS id, korean, english
         FROM vocab_entries
        WHERE korean IS NOT NULL AND length(korean) >= 1
          AND source_upload_id IS NULL
          AND NOT (id::text = ANY($1::text[]))
        ORDER BY random()
        LIMIT $2`,
      [excludeIds, remaining],
    );
    picked.push(...fallback.rows);
  }
  return picked.map((r) => ({
    seedRef: r.id,
    seedKorean: r.korean,
    ...(r.english ? { seedEnglish: r.english } : {}),
  }));
}

/**
 * Up to `n` DISTINCT copyright-clean grammar PATTERN seeds for `level` —
 * `canonical_grammar.canonical_pattern` ONLY, never `kgiu_entries` prose.
 * See the header's COPYRIGHT section. No `seedEnglish` is ever attached.
 */
export async function pickGrammarPatternSeeds(
  pool: Pool,
  level: DiagnosticTargetLevel,
  n: number,
): Promise<SeedCandidate[]> {
  const proficiency = seedProficiencyForLevel(level);
  const primary = await pool.query<{ id: string; pattern: string }>(
    `SELECT cg.id::text AS id, cg.canonical_pattern AS pattern
       FROM canonical_grammar cg
      WHERE cg.canonical_pattern IS NOT NULL AND length(cg.canonical_pattern) >= 1
        AND cg.id IN (
          SELECT ke.canonical_grammar_id FROM kgiu_entries ke
           WHERE ke.canonical_grammar_id IS NOT NULL
             AND ke.proficiency = $1::proficiency_level
        )
      ORDER BY random()
      LIMIT $2`,
    [proficiency, n],
  );
  const picked = primary.rows;
  if (picked.length < n) {
    const excludeIds = picked.map((r) => r.id);
    const remaining = n - picked.length;
    const fallback = await pool.query<{ id: string; pattern: string }>(
      `SELECT id::text AS id, canonical_pattern AS pattern
         FROM canonical_grammar
        WHERE canonical_pattern IS NOT NULL AND length(canonical_pattern) >= 1
          AND NOT (id::text = ANY($1::text[]))
        ORDER BY random()
        LIMIT $2`,
      [excludeIds, remaining],
    );
    picked.push(...fallback.rows);
  }
  return picked.map((r) => ({ seedRef: r.id, seedKorean: r.pattern }));
}

/** Reading's/listening's "availability" is the SAME topic list itself
 *  (F-220 slice 2, reused by slice 3) — NOT a DB query. Every topic is
 *  reusable (no per-row exhaustion, unlike vocab/grammar's finite corpus
 *  pools), so `targeted` and `total` are both the list length;
 *  `achievableForCell` (not this) decides how many the CLI will actually
 *  emit for a cell (repetition-unbounded). */
function topicAvailability(): SeedAvailability {
  return { targeted: READING_TOPIC_COUNT, total: READING_TOPIC_COUNT };
}

async function pickSeeds(
  pool: Pool,
  section: ItemBankSection,
  level: DiagnosticTargetLevel,
  n: number,
): Promise<SeedCandidate[]> {
  if (section === 'vocab') return pickVocabSeeds(pool, level, n);
  if (section === 'grammar') return pickGrammarPatternSeeds(pool, level, n);
  // 'reading'/'listening'/'paired-reading'/'paired-listening': topics are a
  // static, app-owned list (readingTopics.ts), never a DB-backed/scarce
  // resource — `pool` is unused for this branch. One topic seeds ONE work-
  // order item regardless of section: a singular item (one question) or a
  // paired GROUP (N questions) both start from one bare topic string.
  return pickReadingTopics(level, n);
}

async function countSeeds(
  pool: Pool,
  section: ItemBankSection,
  level: DiagnosticTargetLevel,
): Promise<SeedAvailability> {
  if (section === 'vocab') return countVocabSeeds(pool, level);
  if (section === 'grammar') return countGrammarPatternSeeds(pool, level);
  return topicAvailability();
}

/** How many the CLI will emit for a cell. vocab/grammar: bounded by the real
 *  DB pool (`min(perCell, total)` — a scarce resource). reading/listening/
 *  paired-reading/paired-listening: `perCell` ALWAYS — the topic list is
 *  reusable via repetition (readingTopics.ts), never a hard ceiling the way
 *  a finite corpus row-count is. For the paired sections, `perCell` counts
 *  GROUPS (work-order items), not individual questions — each group yields
 *  2-3 `generated_items` rows at ingest. */
function achievableForCell(
  section: ItemBankSection,
  perCell: number,
  availability: SeedAvailability,
): number {
  return isTopicSeededSection(section) ? perCell : Math.min(perCell, availability.total);
}

// ---- Request building + prompt_hash (mirrors the live proxy's identity) ----

/** The `route` used for hashing — `generateDiagnosticItem`'s own route name
 *  (services/claude/config.ts RouteName). Reusing the SAME `hashCacheKey`
 *  shape claude_cache/004 uses is deliberate: this is the same
 *  request-identity computation the live proxy performs, applied to a batch
 *  instead of one call. diagnostic_item itself runs with cacheTtl 0 (never
 *  claude_cache-cached) — this hash is `generated_items.prompt_hash`, a
 *  DIFFERENT table with a DIFFERENT purpose (regeneration idempotency, not a
 *  response cache), and never touches claude_cache. */
const DIAGNOSTIC_ITEM_ROUTE = 'diagnostic_item' as const;

export interface BuiltRequest {
  readonly seedRef: string;
  readonly seedKorean: string;
  readonly seedEnglish: string | undefined;
  readonly promptHash: string;
  readonly request: MessageRequest;
}

/**
 * Build the EXACT `generateDiagnosticItem` request for a seed, and its
 * prompt_hash. Mirrors `generateDiagnosticItem`'s own pipeline
 * (services/claude/index.ts): Zod-validate the input shape, sanitize every
 * free-text field through the SAME injection guard + length cap, then
 * `buildDiagnosticItemRequest`. Returns null when the seed fails validation
 * or sanitization (over-length / injection marker) — the same "a live call
 * on this input would also fail" posture `probeEnrichCacheKey` uses in
 * preseed-definitions.ts.
 */
export function buildWorkOrderRequest(
  section: 'vocab' | 'grammar',
  level: DiagnosticTargetLevel,
  seed: SeedCandidate,
  model: ClaudeModelId,
  cfg: PublicClaudeConfig,
): BuiltRequest | null {
  const parsed = DiagnosticItemInputSchema.safeParse({
    section,
    targetLevel: level,
    seedKorean: seed.seedKorean,
    ...(seed.seedEnglish !== undefined ? { seedEnglish: seed.seedEnglish } : {}),
  });
  if (!parsed.success) return null;

  let seedKorean: string;
  let seedEnglish: string | undefined;
  try {
    seedKorean = sanitizeUserInput(parsed.data.seedKorean, {
      maxLength: cfg.inputCaps.diagnostic_item,
    });
    seedEnglish =
      parsed.data.seedEnglish !== undefined
        ? sanitizeUserInput(parsed.data.seedEnglish, { maxLength: cfg.inputCaps.diagnostic_item })
        : undefined;
  } catch {
    return null;
  }

  const cleaned = {
    ...parsed.data,
    seedKorean,
    ...(seedEnglish !== undefined ? { seedEnglish } : {}),
  };
  const req = buildDiagnosticItemRequest(cleaned, model);

  const key: CacheKey = {
    route: DIAGNOSTIC_ITEM_ROUTE,
    model,
    systemText: stringifySystem(req.system),
    userText: serializeMessages(req.messages),
  };

  return {
    seedRef: seed.seedRef,
    seedKorean,
    seedEnglish,
    promptHash: hashCacheKey(key),
    request: req,
  };
}

/** `generate_reading_item`'s own route name (services/claude/config.ts
 *  RouteName) — mirrors DIAGNOSTIC_ITEM_ROUTE's rationale exactly, for the
 *  F-220 slice 2 reading branch. */
const READING_ITEM_ROUTE = 'generate_reading_item' as const;

/** `generate_listening_item`'s own route name — mirrors READING_ITEM_ROUTE
 *  exactly, for the F-220 slice 3 listening branch. */
const LISTENING_ITEM_ROUTE = 'generate_listening_item' as const;

/** Which model config a section's generation route uses — vocab/grammar ride
 *  `diagnostic_item`; reading rides `generate_reading_item`; listening rides
 *  `generate_listening_item`; the two paired sections ride their OWN routes
 *  (`generate_paired_reading_item`/`generate_paired_listening_item` — F-220
 *  P1). All routes are read from the CURRENT config at both emit AND ingest
 *  time, exactly like `DIAGNOSTIC_ITEM_ROUTE`'s single-model precedent — no
 *  per-item model is stored in the work-order file itself. */
function modelForSection(section: ItemBankSection, cfg: PublicClaudeConfig): ClaudeModelId {
  if (section === 'reading') return cfg.modelDefaults.generate_reading_item;
  if (section === 'listening') return cfg.modelDefaults.generate_listening_item;
  if (section === 'paired-reading') return cfg.modelDefaults.generate_paired_reading_item;
  if (section === 'paired-listening') return cfg.modelDefaults.generate_paired_listening_item;
  return cfg.modelDefaults.diagnostic_item;
}

/**
 * Build the EXACT `generateDiagnosticReadingItem` request for a topic seed,
 * and its prompt_hash. Mirrors `buildWorkOrderRequest` exactly, but for the
 * reading route/schema: `seed.seedKorean` holds the bare TOPIC string (see
 * `readingTopics.ts`'s `ReadingTopicSeed`), never a corpus word/pattern.
 * Returned as the SAME `BuiltRequest` shape as `buildWorkOrderRequest` (the
 * topic rides `seedKorean`, `seedEnglish` is always `undefined`) so callers
 * don't need a second, parallel item-assembly path.
 */
export function buildReadingWorkOrderRequest(
  level: DiagnosticTargetLevel,
  seed: SeedCandidate,
  model: ClaudeModelId,
  cfg: PublicClaudeConfig,
): BuiltRequest | null {
  const parsed = DiagnosticReadingItemInputSchema.safeParse({
    targetLevel: level,
    topic: seed.seedKorean,
  });
  if (!parsed.success) return null;

  let topic: string;
  try {
    topic = sanitizeUserInput(parsed.data.topic, {
      maxLength: cfg.inputCaps.generate_reading_item,
    });
  } catch {
    return null;
  }

  const cleaned = { ...parsed.data, topic };
  const req = buildDiagnosticReadingItemRequest(cleaned, model);

  const key: CacheKey = {
    route: READING_ITEM_ROUTE,
    model,
    systemText: stringifySystem(req.system),
    userText: serializeMessages(req.messages),
  };

  return {
    seedRef: seed.seedRef,
    seedKorean: topic,
    seedEnglish: undefined,
    promptHash: hashCacheKey(key),
    request: req,
  };
}

/**
 * Build the EXACT `generateDiagnosticListeningItem` request for a topic
 * seed, and its prompt_hash. Mirrors `buildReadingWorkOrderRequest` exactly,
 * but for the listening route/schema: `seed.seedKorean` holds the bare TOPIC
 * string (the SAME `readingTopics.ts` list — see the module header). Returns
 * the SAME `BuiltRequest` shape (the topic rides `seedKorean`, `seedEnglish`
 * is always `undefined`) so the ingest path's per-item plumbing stays
 * uniform across all three generated sections.
 */
export function buildListeningWorkOrderRequest(
  level: DiagnosticTargetLevel,
  seed: SeedCandidate,
  model: ClaudeModelId,
  cfg: PublicClaudeConfig,
): BuiltRequest | null {
  const parsed = DiagnosticListeningItemInputSchema.safeParse({
    targetLevel: level,
    topic: seed.seedKorean,
  });
  if (!parsed.success) return null;

  let topic: string;
  try {
    topic = sanitizeUserInput(parsed.data.topic, {
      maxLength: cfg.inputCaps.generate_listening_item,
    });
  } catch {
    return null;
  }

  const cleaned = { ...parsed.data, topic };
  const req = buildDiagnosticListeningItemRequest(cleaned, model);

  const key: CacheKey = {
    route: LISTENING_ITEM_ROUTE,
    model,
    systemText: stringifySystem(req.system),
    userText: serializeMessages(req.messages),
  };

  return {
    seedRef: seed.seedRef,
    seedKorean: topic,
    seedEnglish: undefined,
    promptHash: hashCacheKey(key),
    request: req,
  };
}

/** `generate_paired_reading_item`'s own route name — mirrors
 *  READING_ITEM_ROUTE, for the F-220 P1 paired-reading branch. */
const PAIRED_READING_ITEM_ROUTE = 'generate_paired_reading_item' as const;

/** `generate_paired_listening_item`'s own route name — mirrors
 *  LISTENING_ITEM_ROUTE, for the F-220 P1 paired-listening branch. */
const PAIRED_LISTENING_ITEM_ROUTE = 'generate_paired_listening_item' as const;

/**
 * Build the EXACT `generateDiagnosticPairedReadingItem` request for a topic
 * seed + question count, and its prompt_hash. Mirrors
 * `buildReadingWorkOrderRequest` exactly, but for the paired route/schema:
 * `questionCount` (2 or 3) rides alongside the topic and is PART of the hash
 * (a different question count is a genuinely different request). The
 * returned `promptHash` identifies the whole GROUP's request — one call
 * authors the shared passage + every question in it — NOT a single row's
 * `prompt_hash` (see `rowPromptHash` below, used at ingest to derive each
 * row's own unique hash from this group hash).
 */
export function buildPairedReadingWorkOrderRequest(
  level: DiagnosticTargetLevel,
  seed: SeedCandidate,
  questionCount: number,
  model: ClaudeModelId,
  cfg: PublicClaudeConfig,
): BuiltRequest | null {
  const parsed = DiagnosticPairedReadingItemInputSchema.safeParse({
    targetLevel: level,
    topic: seed.seedKorean,
    questionCount,
  });
  if (!parsed.success) return null;

  let topic: string;
  try {
    topic = sanitizeUserInput(parsed.data.topic, {
      maxLength: cfg.inputCaps.generate_paired_reading_item,
    });
  } catch {
    return null;
  }

  const cleaned = { ...parsed.data, topic };
  const req = buildDiagnosticPairedReadingItemRequest(cleaned, model);

  const key: CacheKey = {
    route: PAIRED_READING_ITEM_ROUTE,
    model,
    systemText: stringifySystem(req.system),
    userText: serializeMessages(req.messages),
  };

  return {
    seedRef: seed.seedRef,
    seedKorean: topic,
    seedEnglish: undefined,
    promptHash: hashCacheKey(key),
    request: req,
  };
}

/**
 * Build the EXACT `generateDiagnosticPairedListeningItem` request for a
 * topic seed, and its prompt_hash. Mirrors `buildPairedReadingWorkOrderRequest`
 * exactly, but for the paired-listening route/schema: `questionCount` is
 * always 2 (`DiagnosticPairedListeningItemInputSchema.questionCount` is a
 * literal), still threaded through for structural symmetry with the reading
 * builder and so the CLI's per-item plumbing stays uniform across all
 * sections.
 */
export function buildPairedListeningWorkOrderRequest(
  level: DiagnosticTargetLevel,
  seed: SeedCandidate,
  questionCount: number,
  model: ClaudeModelId,
  cfg: PublicClaudeConfig,
): BuiltRequest | null {
  const parsed = DiagnosticPairedListeningItemInputSchema.safeParse({
    targetLevel: level,
    topic: seed.seedKorean,
    questionCount,
  });
  if (!parsed.success) return null;

  let topic: string;
  try {
    topic = sanitizeUserInput(parsed.data.topic, {
      maxLength: cfg.inputCaps.generate_paired_listening_item,
    });
  } catch {
    return null;
  }

  const cleaned = { ...parsed.data, topic };
  const req = buildDiagnosticPairedListeningItemRequest(cleaned, model);

  const key: CacheKey = {
    route: PAIRED_LISTENING_ITEM_ROUTE,
    model,
    systemText: stringifySystem(req.system),
    userText: serializeMessages(req.messages),
  };

  return {
    seedRef: seed.seedRef,
    seedKorean: topic,
    seedEnglish: undefined,
    promptHash: hashCacheKey(key),
    request: req,
  };
}

/** How many questions to request for a paired-reading GROUP at a given
 *  1-based position within its (section, level) cell — alternates 2, 3, 2,
 *  3, … so a batch emits a genuine MIX of both real group sizes
 *  (TOPIK_STRUCTURE_ANALYSIS.md §1: real R7 blocks are 2 OR 3 items) rather
 *  than always the same count. Deterministic (no RNG) so `--emit-batch`
 *  output is reproducible for a given seed order. */
export function pairedReadingQuestionCountFor(position: number): 2 | 3 {
  return position % 2 === 0 ? 3 : 2;
}

/** Deterministically derive a stimulus GROUP id from the group's own request
 *  hash (the first 32 hex characters of its `hashCacheKey` value — 128 bits,
 *  plenty unique for a group key). Deterministic-from-the-request (NOT a
 *  fresh `randomUUID()` per ingest run) so retrying the SAME work-order item
 *  (e.g. after a partial failure left some of its rows unwritten) reproduces
 *  the IDENTICAL group id for the rows still missing — see migration 105's
 *  up header. */
export function stimulusGroupIdFromHash(groupPromptHash: string): string {
  return groupPromptHash.slice(0, 32);
}

/** Derive a PER-ROW-unique `prompt_hash` from a group's request hash + the
 *  question's 1-based ordinal within the group — satisfies
 *  `generated_items`'s `UNIQUE(prompt_hash)` (migration 101) while every row
 *  in a group shares the SAME group-level request (and therefore the same
 *  `groupPromptHash`). SHA-256 hex, matching
 *  `ck_generated_items_prompt_hash_shape`'s `^[0-9a-f]{64}$` shape exactly
 *  like `hashCacheKey`'s own output. Deterministic: re-ingesting the same
 *  work-order item reproduces the identical per-row hash for each ordinal,
 *  which is what makes `ON CONFLICT (prompt_hash) DO NOTHING` an idempotent
 *  per-ROW retry, not just a per-group one. */
export function rowPromptHash(groupPromptHash: string, ordinal: number): string {
  return createHash('sha256').update(`${groupPromptHash}:${String(ordinal)}`).digest('hex');
}

// ---- count -------------------------------------------------------------------

export interface CellCount {
  readonly section: ItemBankSection;
  readonly level: DiagnosticTargetLevel;
  readonly availability: SeedAvailability;
  readonly achievable: number;
}

export interface CountSummary {
  readonly perCell: number;
  readonly cells: readonly CellCount[];
  readonly totalAchievable: number;
}

export async function runCount(
  pool: Pool,
  opts: ItemBankOptions,
  print: (line: string) => void,
): Promise<CountSummary> {
  const cells: CellCount[] = [];
  for (const section of opts.sections) {
    for (const level of opts.levels) {
      const availability = await countSeeds(pool, section, level);
      const achievable = achievableForCell(section, opts.perCell, availability);
      cells.push({ section, level, availability, achievable });
      print(
        isTopicSeededSection(section)
          ? `item-bank [COUNT]: ${section}/${level} — ${String(availability.total)} topics available ` +
              `(reusable via repetition, not a scarce pool) — would emit ${String(achievable)}/${String(opts.perCell)} ` +
              `${section === 'paired-reading' || section === 'paired-listening' ? 'stimulus group(s)' : 'item(s)'}`
          : `item-bank [COUNT]: ${section}/${level} — ${String(availability.targeted)} targeted-proficiency ` +
              `seeds, ${String(availability.total)} total eligible — would emit ${String(achievable)}/${String(opts.perCell)}`,
      );
    }
  }
  const totalAchievable = cells.reduce((sum, c) => sum + c.achievable, 0);
  print(
    `item-bank [COUNT]: grid ${String(opts.sections.length)} section(s) x ${String(opts.levels.length)} ` +
      `level(s) x --per-cell=${String(opts.perCell)} — ${String(totalAchievable)} items would be emitted. ` +
      `ZERO API calls, ZERO writes.`,
  );
  return { perCell: opts.perCell, cells, totalAchievable };
}

// ---- emit-batch (subscription workflow, step 1 — no spend) ------------------

export interface WorkOrderItem {
  /** Operator-facing label, e.g. "vocab-L3-0007". Not used for hashing. */
  readonly id: string;
  readonly section: ItemBankSection;
  readonly level: DiagnosticTargetLevel;
  /** Provenance: vocab_entries id (vocab) / canonical_grammar id (grammar) /
   *  synthetic `topic-<level>-<n>` ref (reading/listening/paired-reading/
   *  paired-listening — readingTopics.ts). For a paired section this ref
   *  identifies the GROUP (one topic -> one call -> one stimulus group), not
   *  an individual question. */
  readonly seedRef: string;
  /** The seed WORD/PATTERN for vocab/grammar; the bare TOPIC STRING for
   *  reading/listening/paired-reading/paired-listening (F-220 slices 2-3, P1)
   *  — same field, dual meaning by section, so the work-order/ingest
   *  plumbing doesn't need a parallel path. */
  readonly seedKorean: string;
  readonly seedEnglish?: string;
  /** paired-reading/paired-listening ONLY: how many questions this group's
   *  ONE call was asked to author about its ONE shared passage/dialogue (2
   *  or 3 for paired-reading; always 2 for paired-listening). Required at
   *  ingest to rebuild the EXACT emit-time request (question count is part
   *  of the prompt payload, and therefore part of the request hash) — see
   *  `buildPairedReadingWorkOrderRequest`/`buildPairedListeningWorkOrderRequest`.
   *  Absent/ignored for every non-paired section. */
  readonly questionCount?: number;
  readonly promptHash: string;
  /** The exact request a subscription Claude session should send. */
  readonly request: MessageRequest;
  readonly schema:
    | 'DiagnosticItemResult'
    | 'DiagnosticReadingItemResult'
    | 'DiagnosticListeningItemResult'
    | 'DiagnosticPairedReadingItemResult'
    | 'DiagnosticPairedListeningItemResult';
}

export interface WorkOrderFile {
  readonly meta: {
    /** `diagnostic_item`'s model — governs vocab/grammar items. */
    readonly model: ClaudeModelId;
    /** `generate_reading_item`'s model — governs reading items (F-220 slice
     *  2). Always recorded (even when this file has no reading items) so a
     *  reading-only re-emit of the same file shape stays self-describing. */
    readonly readingModel: ClaudeModelId;
    /** `generate_listening_item`'s model — governs listening items (F-220
     *  slice 3). Always recorded (mirrors `readingModel`'s rationale). */
    readonly listeningModel: ClaudeModelId;
    /** `generate_paired_reading_item`'s model — governs paired-reading
     *  GROUPS (F-220 P1). Always recorded (mirrors `readingModel`'s
     *  rationale). */
    readonly pairedReadingModel: ClaudeModelId;
    /** `generate_paired_listening_item`'s model — governs paired-listening
     *  GROUPS (F-220 P1). Always recorded (mirrors `readingModel`'s
     *  rationale). */
    readonly pairedListeningModel: ClaudeModelId;
    readonly perCell: number;
    readonly sections: readonly ItemBankSection[];
    readonly levels: readonly DiagnosticTargetLevel[];
    readonly emitted: number;
  };
  readonly items: readonly WorkOrderItem[];
}

export interface EmitBatchSummary {
  readonly emitted: number;
  readonly skippedSeedInvalid: number;
  readonly outFile: string;
  readonly model: ClaudeModelId;
}

export async function runEmitBatch(
  pool: Pool,
  opts: ItemBankOptions,
  print: (line: string) => void,
): Promise<EmitBatchSummary> {
  const { outFile } = opts;
  if (outFile === undefined) {
    // parseCliArgs guarantees this; direct callers get the same loud failure.
    throw new ItemBankInputError('--emit-batch requires --out=<file>');
  }
  // Prove --out is writable BEFORE the (potentially slow) DB enumeration —
  // an unwritable path is bad input (exit 2), must fail in seconds.
  try {
    await writeFile(outFile, '', 'utf8');
  } catch (err) {
    throw new ItemBankInputError(
      `cannot write --out "${outFile}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const cfg = loadConfig();
  const model = cfg.modelDefaults.diagnostic_item;
  const readingModel = cfg.modelDefaults.generate_reading_item;
  const listeningModel = cfg.modelDefaults.generate_listening_item;
  const pairedReadingModel = cfg.modelDefaults.generate_paired_reading_item;
  const pairedListeningModel = cfg.modelDefaults.generate_paired_listening_item;

  const items: WorkOrderItem[] = [];
  let skippedSeedInvalid = 0;
  for (const section of opts.sections) {
    const sectionModel = modelForSection(section, cfg);
    for (const level of opts.levels) {
      const seeds = await pickSeeds(pool, section, level, opts.perCell);
      let cellIndex = 0;
      let seedPosition = 0;
      for (const seed of seeds) {
        seedPosition += 1;
        const questionCount =
          section === 'paired-reading'
            ? pairedReadingQuestionCountFor(seedPosition)
            : section === 'paired-listening'
              ? 2
              : undefined;
        const built =
          section === 'reading'
            ? buildReadingWorkOrderRequest(level, seed, sectionModel, cfg)
            : section === 'listening'
              ? buildListeningWorkOrderRequest(level, seed, sectionModel, cfg)
              : section === 'paired-reading'
                ? buildPairedReadingWorkOrderRequest(level, seed, questionCount!, sectionModel, cfg)
                : section === 'paired-listening'
                  ? buildPairedListeningWorkOrderRequest(level, seed, questionCount!, sectionModel, cfg)
                  : buildWorkOrderRequest(section, level, seed, sectionModel, cfg);
        if (built === null) {
          skippedSeedInvalid += 1;
          continue;
        }
        cellIndex += 1;
        items.push({
          id: `${section}-${level}-${String(cellIndex).padStart(4, '0')}`,
          section,
          level,
          seedRef: built.seedRef,
          seedKorean: built.seedKorean,
          ...(built.seedEnglish !== undefined ? { seedEnglish: built.seedEnglish } : {}),
          ...(questionCount !== undefined ? { questionCount } : {}),
          promptHash: built.promptHash,
          request: built.request,
          schema:
            section === 'reading'
              ? 'DiagnosticReadingItemResult'
              : section === 'listening'
                ? 'DiagnosticListeningItemResult'
                : section === 'paired-reading'
                  ? 'DiagnosticPairedReadingItemResult'
                  : section === 'paired-listening'
                    ? 'DiagnosticPairedListeningItemResult'
                    : 'DiagnosticItemResult',
        });
      }
      print(
        `item-bank [EMIT]: ${section}/${level} — ${String(seeds.length)} seeds -> ${String(cellIndex)} ` +
          `work-order items`,
      );
    }
  }

  const file: WorkOrderFile = {
    meta: {
      model,
      readingModel,
      listeningModel,
      pairedReadingModel,
      pairedListeningModel,
      perCell: opts.perCell,
      sections: opts.sections,
      levels: opts.levels,
      emitted: items.length,
    },
    items,
  };
  try {
    await writeFile(outFile, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  } catch (err) {
    throw new ItemBankInputError(
      `cannot write --out "${outFile}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const summary: EmitBatchSummary = {
    emitted: items.length,
    skippedSeedInvalid,
    outFile,
    model,
  };
  print(
    `item-bank [EMIT]: wrote ${String(summary.emitted)} items to ${outFile} ` +
      `(model ${model}, ${String(skippedSeedInvalid)} seeds skipped as invalid/unsanitizable). ` +
      `No Claude calls, no DB writes.`,
  );
  return summary;
}

// ---- ingest (subscription workflow, step 2 — no spend) ----------------------

const WorkOrderItemSchema = z.object({
  id: z.string().min(1),
  // F-220 slice 2 added 'reading'; slice 3 adds 'listening'; P1 adds
  // 'paired-reading'/'paired-listening'.
  section: z.enum(['vocab', 'grammar', 'reading', 'listening', 'paired-reading', 'paired-listening']),
  level: z.enum(['L1', 'L2', 'L3', 'L4', 'L5+']),
  seedRef: z.string().min(1),
  seedKorean: z.string().min(1),
  seedEnglish: z.string().optional(),
  // F-220 P1: required (at the ingest branch, not at the schema level, to
  // keep the schema simple) for section='paired-reading'/'paired-listening'
  // — the question count this group's ONE call was asked to author, needed
  // to rebuild the exact emit-time request. Ignored for every other section.
  questionCount: z.number().int().min(2).max(3).optional(),
  promptHash: z.string().min(1),
  // `z.unknown()` alone makes the key OPTIONAL in zod 3 — an UNFILLED
  // work-order (emit output fed straight back, no `response` keys) would
  // parse, every item would then fail response validation, and the run
  // would print "0 written" yet could look like a clean pass. Require the
  // key to be present (mirrors preseed-definitions.ts's `enrichment` guard).
  response: z.unknown().refine((v) => v !== undefined, {
    message: 'item.response missing — work-order not filled',
  }),
});
const WorkOrderFileSchema = z.object({
  items: z.array(WorkOrderItemSchema),
  meta: z
    .object({
      model: z.string().min(1).optional(),
      readingModel: z.string().min(1).optional(),
      listeningModel: z.string().min(1).optional(),
      pairedReadingModel: z.string().min(1).optional(),
      pairedListeningModel: z.string().min(1).optional(),
    })
    .passthrough()
    .optional(),
});

export interface IngestSummary {
  readonly total: number;
  readonly written: number;
  readonly skippedAlreadyCached: number;
  readonly skippedHashDrift: number;
  readonly skippedInvalid: number;
  readonly skippedSeedInvalid: number;
}

/** Cap on per-item skip diagnostics so a wholly bad file can't flood stderr. */
const MAX_INVALID_LOGS = 5;

const CHOICE_IDS = ['a', 'b', 'c', 'd'] as const;

/**
 * Ingest a filled work-order into `generated_items`. Per item: rebuild the
 * request independently from the item's own echoed seed (proves the request
 * a subscription session was actually given, not a mutated one) and compare
 * the recomputed hash to the file's (drift -> skip); Zod-validate `response`
 * against `DiagnosticItemResultSchema` (invalid -> skip); re-check the
 * section<->kind contract the live path enforces (mismatch -> skip); apply
 * `shuffleGeneratedChoices` (the SAME live-path guard); INSERT with
 * `ON CONFLICT (prompt_hash) DO NOTHING` (idempotent — a row already at that
 * hash is `skippedAlreadyCached`, not an error). A row that lands is
 * definitionally schema-valid: Postgres's own CHECK constraints (migration
 * 101) are the write-time proof, so there is no separate round-trip
 * self-check the way preseed's cache writer needs.
 */
export async function runIngest(
  pool: Pool,
  opts: ItemBankOptions,
  print: (line: string) => void,
): Promise<IngestSummary> {
  const { inFile } = opts;
  if (inFile === undefined) {
    throw new ItemBankInputError('--ingest requires --in=<file> (or --ingest=<file>)');
  }

  let rawText: string;
  try {
    rawText = await readFile(inFile, 'utf8');
  } catch (err) {
    throw new ItemBankInputError(
      `cannot read work-order "${inFile}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawText);
  } catch (err) {
    throw new ItemBankInputError(
      `work-order "${inFile}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsedFile = WorkOrderFileSchema.safeParse(rawJson);
  if (!parsedFile.success) {
    throw new ItemBankInputError(
      `work-order "${inFile}" does not match the emit-batch shape: ` +
        parsedFile.error.issues
          .slice(0, MAX_INVALID_LOGS)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
    );
  }
  const items = parsedFile.data.items;

  const cfg = loadConfig();
  const model = cfg.modelDefaults.diagnostic_item;
  const readingModel = cfg.modelDefaults.generate_reading_item;
  const listeningModel = cfg.modelDefaults.generate_listening_item;
  const pairedReadingModel = cfg.modelDefaults.generate_paired_reading_item;
  const pairedListeningModel = cfg.modelDefaults.generate_paired_listening_item;
  const emitModel = parsedFile.data.meta?.model;
  const emitReadingModel = parsedFile.data.meta?.readingModel;
  const emitListeningModel = parsedFile.data.meta?.listeningModel;
  const emitPairedReadingModel = parsedFile.data.meta?.pairedReadingModel;
  const emitPairedListeningModel = parsedFile.data.meta?.pairedListeningModel;
  if (emitModel !== undefined && emitModel !== model) {
    print(
      `item-bank [INGEST]: WARN — work-order meta.model "${sanitizeForLog(emitModel)}" != ` +
        `configured diagnostic_item model "${model}"; every vocab/grammar item will hash-drift ` +
        `unless the model config matches the emit-time one`,
    );
  }
  if (emitReadingModel !== undefined && emitReadingModel !== readingModel) {
    print(
      `item-bank [INGEST]: WARN — work-order meta.readingModel "${sanitizeForLog(emitReadingModel)}" ` +
        `!= configured generate_reading_item model "${readingModel}"; every reading item will ` +
        `hash-drift unless the model config matches the emit-time one`,
    );
  }
  if (emitListeningModel !== undefined && emitListeningModel !== listeningModel) {
    print(
      `item-bank [INGEST]: WARN — work-order meta.listeningModel "${sanitizeForLog(emitListeningModel)}" ` +
        `!= configured generate_listening_item model "${listeningModel}"; every listening item will ` +
        `hash-drift unless the model config matches the emit-time one`,
    );
  }
  if (emitPairedReadingModel !== undefined && emitPairedReadingModel !== pairedReadingModel) {
    print(
      `item-bank [INGEST]: WARN — work-order meta.pairedReadingModel "${sanitizeForLog(emitPairedReadingModel)}" ` +
        `!= configured generate_paired_reading_item model "${pairedReadingModel}"; every paired-reading ` +
        `group will hash-drift unless the model config matches the emit-time one`,
    );
  }
  if (emitPairedListeningModel !== undefined && emitPairedListeningModel !== pairedListeningModel) {
    print(
      `item-bank [INGEST]: WARN — work-order meta.pairedListeningModel "${sanitizeForLog(emitPairedListeningModel)}" ` +
        `!= configured generate_paired_listening_item model "${pairedListeningModel}"; every ` +
        `paired-listening group will hash-drift unless the model config matches the emit-time one`,
    );
  }

  print(`item-bank [INGEST]: ${String(items.length)} items from ${inFile} (model ${model})`);
  if (items.length === 0) {
    print('item-bank [INGEST]: work-order has 0 items — nothing to ingest (clean no-op).');
  }

  let written = 0;
  let skippedAlreadyCached = 0;
  let skippedHashDrift = 0;
  let skippedInvalid = 0;
  let skippedSeedInvalid = 0;
  let invalidLogs = 0;
  let driftLogs = 0;
  let seedInvalidLogs = 0;

  for (const [i, item] of items.entries()) {
    const itemNo = String(i + 1);
    const seed: SeedCandidate = {
      seedRef: item.seedRef,
      seedKorean: item.seedKorean,
      ...(item.seedEnglish !== undefined ? { seedEnglish: item.seedEnglish } : {}),
    };
    const itemModel =
      item.section === 'reading'
        ? readingModel
        : item.section === 'listening'
          ? listeningModel
          : item.section === 'paired-reading'
            ? pairedReadingModel
            : item.section === 'paired-listening'
              ? pairedListeningModel
              : model;
    // Both paired sections REQUIRE questionCount to rebuild the exact
    // emit-time request (it rides the prompt payload — see
    // buildPairedReadingWorkOrderRequest/buildPairedListeningWorkOrderRequest).
    // A work-order item missing it (hand-edited, or from a stale emitter) is
    // a bad seed, not a hash-drift or a response-shape problem — reject the
    // SAME way an unsanitizable seed is rejected, before any hash comparison.
    if (
      (item.section === 'paired-reading' || item.section === 'paired-listening') &&
      item.questionCount === undefined
    ) {
      skippedSeedInvalid += 1;
      if (seedInvalidLogs < MAX_INVALID_LOGS) {
        seedInvalidLogs += 1;
        print(
          `item-bank [INGEST]: item ${itemNo} (id="${sanitizeForLog(item.id)}") is missing ` +
            `questionCount (required for ${item.section}) — skipped`,
        );
      }
      continue;
    }
    const built =
      item.section === 'reading'
        ? buildReadingWorkOrderRequest(item.level, seed, itemModel, cfg)
        : item.section === 'listening'
          ? buildListeningWorkOrderRequest(item.level, seed, itemModel, cfg)
          : item.section === 'paired-reading'
            ? buildPairedReadingWorkOrderRequest(item.level, seed, item.questionCount!, itemModel, cfg)
            : item.section === 'paired-listening'
              ? buildPairedListeningWorkOrderRequest(item.level, seed, item.questionCount!, itemModel, cfg)
              : buildWorkOrderRequest(item.section, item.level, seed, itemModel, cfg);
    if (built === null) {
      skippedSeedInvalid += 1;
      if (seedInvalidLogs < MAX_INVALID_LOGS) {
        seedInvalidLogs += 1;
        print(
          `item-bank [INGEST]: item ${itemNo} (id="${sanitizeForLog(item.id)}") seed no longer ` +
            `sanitizable — skipped`,
        );
      }
      continue;
    }
    if (built.promptHash !== item.promptHash) {
      skippedHashDrift += 1;
      if (driftLogs < MAX_INVALID_LOGS) {
        driftLogs += 1;
        print(
          `item-bank [INGEST]: item ${itemNo} (id="${sanitizeForLog(item.id)}") hash drift — ` +
            `emitted ${sanitizeForLog(item.promptHash, 16)} vs recomputed ${built.promptHash.slice(0, 16)}… — skipped`,
        );
      }
      continue;
    }

    // F-220 P1 — paired-reading: ONE call authored a shared passage + an
    // ARRAY of independent questions (DiagnosticPairedReadingItemResultSchema).
    // Each question becomes its OWN `generated_items` ROW: same `section`
    // ('reading'), same `level`, same `passage` (denormalized onto every
    // row, exactly like a standalone reading row), same `stimulus_group_id`
    // (migration 105, deterministically derived from this group's OWN
    // `built.promptHash` — see `stimulusGroupIdFromHash`); per row:
    // `stimulus_group_ordinal` = 1..N, `kind` = 'paired-passage-mc', and a
    // PER-ROW-unique `prompt_hash` (`rowPromptHash`) so the UNIQUE
    // constraint is satisfied and a retried ingest of this SAME work-order
    // item completes any rows that didn't land last time (idempotent, one
    // ON CONFLICT DO NOTHING INSERT per row — no cross-row transaction, same
    // posture as every other ingest branch in this file).
    if (item.section === 'paired-reading') {
      const parsedPaired = DiagnosticPairedReadingItemResultSchema.safeParse(item.response);
      if (!parsedPaired.success) {
        skippedInvalid += 1;
        if (invalidLogs < MAX_INVALID_LOGS) {
          invalidLogs += 1;
          print(
            `item-bank [INGEST]: item ${itemNo} (id="${sanitizeForLog(item.id)}") response invalid — ` +
              parsedPaired.error.issues
                .slice(0, 3)
                .map((iss) => `${iss.path.join('.')}: ${iss.message}`)
                .join('; '),
          );
        }
        continue;
      }
      const result: DiagnosticPairedReadingItemResult = parsedPaired.data;
      const groupId = stimulusGroupIdFromHash(built.promptHash);
      let groupWritten = 0;
      let groupSkippedInvalid = 0;
      for (const [qi, q] of result.questions.entries()) {
        const ordinal = qi + 1;
        // Belt-and-suspenders range check (schema already enforces 0..3 /
        // length 4) — mirrors every other branch's identical defensive check.
        if (!Number.isInteger(q.answerIndex) || q.answerIndex < 0 || q.answerIndex >= q.choices.length) {
          groupSkippedInvalid += 1;
          continue;
        }
        // SAME guard the live path uses — permute so the correct choice
        // isn't parked at the same index for every question in the group.
        const { choices: shuffled, correctAnswer } = shuffleGeneratedChoices(q.choices, q.answerIndex);
        const rowAnswerIndex = CHOICE_IDS.indexOf(correctAnswer);
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO generated_items
             (section, level, kind, stem, passage, choices, answer_index, explain,
              stimulus_group_id, stimulus_group_ordinal, source_ref, status,
              created_by, model_id, prompt_hash)
           VALUES ('reading', $1, 'paired-passage-mc', $2, $3, $4::jsonb, $5, $6,
                   $7, $8, $9, 'draft', 'claude-batch', $10, $11)
           ON CONFLICT (prompt_hash) DO NOTHING
           RETURNING id`,
          [
            item.level,
            q.prompt,
            result.passage,
            JSON.stringify(shuffled.map((c) => ({ kr: c.kr, en: c.en }))),
            rowAnswerIndex,
            q.explain,
            groupId,
            ordinal,
            item.seedRef,
            emitPairedReadingModel ?? pairedReadingModel,
            rowPromptHash(built.promptHash, ordinal),
          ],
        );
        if (rows.length > 0) {
          groupWritten += 1;
        } else {
          skippedAlreadyCached += 1;
        }
      }
      written += groupWritten;
      skippedInvalid += groupSkippedInvalid;
      if (groupSkippedInvalid > 0 && invalidLogs < MAX_INVALID_LOGS) {
        invalidLogs += 1;
        print(
          `item-bank [INGEST]: item ${itemNo} (id="${sanitizeForLog(item.id)}") group ${groupId} had ` +
            `${String(groupSkippedInvalid)} out-of-range question(s) skipped`,
        );
      }
      continue;
    }

    // F-220 P1 — paired-listening: mirrors the paired-reading branch above,
    // but ONE call authored a shared DIALOGUE (`turns`) + exactly 2
    // independent questions (DiagnosticPairedListeningItemResultSchema).
    // Each question becomes its OWN row: same `turns` JSONB on every row
    // (NO `passage` — the dialogue text must never reach the learner, same
    // posture as the singular listening branch below), same
    // `stimulus_group_id`; `audio_source_id` is left NULL on every row (this
    // CLI is the $0 SCRIPT step — the separate, METERED
    // `synthesize-listening-audio` CLI synthesizes the group's ONE shared
    // clip later and stamps it onto every row in the group at once).
    if (item.section === 'paired-listening') {
      const parsedPaired = DiagnosticPairedListeningItemResultSchema.safeParse(item.response);
      if (!parsedPaired.success) {
        skippedInvalid += 1;
        if (invalidLogs < MAX_INVALID_LOGS) {
          invalidLogs += 1;
          print(
            `item-bank [INGEST]: item ${itemNo} (id="${sanitizeForLog(item.id)}") response invalid — ` +
              parsedPaired.error.issues
                .slice(0, 3)
                .map((iss) => `${iss.path.join('.')}: ${iss.message}`)
                .join('; '),
          );
        }
        continue;
      }
      const result: DiagnosticPairedListeningItemResult = parsedPaired.data;
      const groupId = stimulusGroupIdFromHash(built.promptHash);
      let groupWritten = 0;
      let groupSkippedInvalid = 0;
      for (const [qi, q] of result.questions.entries()) {
        const ordinal = qi + 1;
        if (!Number.isInteger(q.answerIndex) || q.answerIndex < 0 || q.answerIndex >= q.choices.length) {
          groupSkippedInvalid += 1;
          continue;
        }
        // Only the CHOICES are shuffled — `turns` is the dialogue in its
        // fixed speaking order and must never be reordered.
        const { choices: shuffled, correctAnswer } = shuffleGeneratedChoices(q.choices, q.answerIndex);
        const rowAnswerIndex = CHOICE_IDS.indexOf(correctAnswer);
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO generated_items
             (section, level, kind, stem, passage, choices, answer_index, explain,
              turns, audio_source_id, stimulus_group_id, stimulus_group_ordinal,
              source_ref, status, created_by, model_id, prompt_hash)
           VALUES ('listening', $1, 'paired-audio-mc', $2, NULL, $3::jsonb, $4, $5,
                   $6::jsonb, NULL, $7, $8, $9, 'draft', 'claude-batch', $10, $11)
           ON CONFLICT (prompt_hash) DO NOTHING
           RETURNING id`,
          [
            item.level,
            q.prompt,
            JSON.stringify(shuffled.map((c) => ({ kr: c.kr, en: c.en }))),
            rowAnswerIndex,
            q.explain,
            JSON.stringify(result.turns),
            groupId,
            ordinal,
            item.seedRef,
            emitPairedListeningModel ?? pairedListeningModel,
            rowPromptHash(built.promptHash, ordinal),
          ],
        );
        if (rows.length > 0) {
          groupWritten += 1;
        } else {
          skippedAlreadyCached += 1;
        }
      }
      written += groupWritten;
      skippedInvalid += groupSkippedInvalid;
      if (groupSkippedInvalid > 0 && invalidLogs < MAX_INVALID_LOGS) {
        invalidLogs += 1;
        print(
          `item-bank [INGEST]: item ${itemNo} (id="${sanitizeForLog(item.id)}") group ${groupId} had ` +
            `${String(groupSkippedInvalid)} out-of-range question(s) skipped`,
        );
      }
      continue;
    }

    // F-220 slice 2 — reading items validate against a DIFFERENT result
    // schema (DiagnosticReadingItemResultSchema: passage + prompt, no `kind`
    // — a reading item's kind is always the fixed 'passage-mc', never
    // model-chosen) and write the `passage` column; vocab/grammar keep the
    // slice-1 path (DiagnosticItemResultSchema, section<->kind contract,
    // passage always NULL) completely unchanged below.
    if (item.section === 'reading') {
      const parsedReading = DiagnosticReadingItemResultSchema.safeParse(item.response);
      if (!parsedReading.success) {
        skippedInvalid += 1;
        if (invalidLogs < MAX_INVALID_LOGS) {
          invalidLogs += 1;
          print(
            `item-bank [INGEST]: item ${itemNo} (id="${sanitizeForLog(item.id)}") response invalid — ` +
              parsedReading.error.issues
                .slice(0, 3)
                .map((iss) => `${iss.path.join('.')}: ${iss.message}`)
                .join('; '),
          );
        }
        continue;
      }
      const result: DiagnosticReadingItemResult = parsedReading.data;
      // Belt-and-suspenders range check (schema already enforces 0..3 /
      // length 4) — mirrors buildGeneratedItem's own defensive check.
      if (
        !Number.isInteger(result.answerIndex) ||
        result.answerIndex < 0 ||
        result.answerIndex >= result.choices.length
      ) {
        skippedInvalid += 1;
        continue;
      }

      // SAME guard the live path uses — permute so the correct choice isn't
      // parked at index 0 (LLM position bias).
      const { choices: shuffled, correctAnswer } = shuffleGeneratedChoices(
        result.choices,
        result.answerIndex,
      );
      const answerIndex = CHOICE_IDS.indexOf(correctAnswer);

      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO generated_items
           (section, level, kind, stem, passage, choices, answer_index, explain,
            source_ref, status, created_by, model_id, prompt_hash)
         VALUES ($1, $2, 'passage-mc', $3, $4, $5::jsonb, $6, $7, $8, 'draft', 'claude-batch', $9, $10)
         ON CONFLICT (prompt_hash) DO NOTHING
         RETURNING id`,
        [
          item.section,
          item.level,
          result.prompt,
          result.passage,
          JSON.stringify(shuffled.map((c) => ({ kr: c.kr, en: c.en }))),
          answerIndex,
          result.explain,
          item.seedRef,
          emitReadingModel ?? readingModel,
          built.promptHash,
        ],
      );
      if (rows.length > 0) {
        written += 1;
      } else {
        skippedAlreadyCached += 1;
      }
      continue;
    }

    // F-220 slice 3 — listening items validate against a THIRD result schema
    // (DiagnosticListeningItemResultSchema: turns[] + prompt, no `kind` — a
    // listening item's kind is always the fixed 'audio-mc', never
    // model-chosen) and write the `turns` column (NO `passage` — the
    // dialogue text must never reach the learner as readable text, see
    // services/diagnostic/generatedBank.ts's doc); `audio_source_id` is left
    // NULL (this CLI is the $0 SCRIPT step — audio synthesis is the separate,
    // METERED `synthesize-listening-audio` CLI, run later by an operator).
    if (item.section === 'listening') {
      const parsedListening = DiagnosticListeningItemResultSchema.safeParse(item.response);
      if (!parsedListening.success) {
        skippedInvalid += 1;
        if (invalidLogs < MAX_INVALID_LOGS) {
          invalidLogs += 1;
          print(
            `item-bank [INGEST]: item ${itemNo} (id="${sanitizeForLog(item.id)}") response invalid — ` +
              parsedListening.error.issues
                .slice(0, 3)
                .map((iss) => `${iss.path.join('.')}: ${iss.message}`)
                .join('; '),
          );
        }
        continue;
      }
      const result: DiagnosticListeningItemResult = parsedListening.data;
      // Belt-and-suspenders range check (schema already enforces 0..3 /
      // length 4) — mirrors buildGeneratedItem's own defensive check.
      if (
        !Number.isInteger(result.answerIndex) ||
        result.answerIndex < 0 ||
        result.answerIndex >= result.choices.length
      ) {
        skippedInvalid += 1;
        continue;
      }

      // SAME guard the live path uses — permute so the correct choice isn't
      // parked at index 0 (LLM position bias). Only the CHOICES are
      // shuffled — `turns` is the dialogue in its fixed speaking order and
      // must never be reordered.
      const { choices: shuffled, correctAnswer } = shuffleGeneratedChoices(
        result.choices,
        result.answerIndex,
      );
      const answerIndex = CHOICE_IDS.indexOf(correctAnswer);

      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO generated_items
           (section, level, kind, stem, passage, choices, answer_index, explain,
            turns, audio_source_id, source_ref, status, created_by, model_id, prompt_hash)
         VALUES ($1, $2, 'audio-mc', $3, NULL, $4::jsonb, $5, $6,
                 $7::jsonb, NULL, $8, 'draft', 'claude-batch', $9, $10)
         ON CONFLICT (prompt_hash) DO NOTHING
         RETURNING id`,
        [
          item.section,
          item.level,
          result.prompt,
          JSON.stringify(shuffled.map((c) => ({ kr: c.kr, en: c.en }))),
          answerIndex,
          result.explain,
          JSON.stringify(result.turns),
          item.seedRef,
          emitListeningModel ?? listeningModel,
          built.promptHash,
        ],
      );
      if (rows.length > 0) {
        written += 1;
      } else {
        skippedAlreadyCached += 1;
      }
      continue;
    }

    const parsedResult = DiagnosticItemResultSchema.safeParse(item.response);
    if (!parsedResult.success) {
      skippedInvalid += 1;
      if (invalidLogs < MAX_INVALID_LOGS) {
        invalidLogs += 1;
        print(
          `item-bank [INGEST]: item ${itemNo} (id="${sanitizeForLog(item.id)}") response invalid — ` +
            parsedResult.error.issues
              .slice(0, 3)
              .map((iss) => `${iss.path.join('.')}: ${iss.message}`)
              .join('; '),
        );
      }
      continue;
    }
    const result: DiagnosticItemResult = parsedResult.data;

    // The section<->kind contract the live path enforces
    // (routes/diagnostic.ts buildGeneratedItem): vocab items are
    // synonym/cloze, grammar items are pattern. A mismatch means the model
    // ignored the prompt's rule — reject rather than write a mislabeled item.
    const kindOk = item.section === 'grammar' ? result.kind === 'pattern' : result.kind !== 'pattern';
    if (!kindOk) {
      skippedInvalid += 1;
      if (invalidLogs < MAX_INVALID_LOGS) {
        invalidLogs += 1;
        print(
          `item-bank [INGEST]: item ${itemNo} (id="${sanitizeForLog(item.id)}") kind '${result.kind}' ` +
            `mismatched for section '${item.section}' — skipped`,
        );
      }
      continue;
    }
    // Belt-and-suspenders range check (schema already enforces 0..3 / length
    // 4) — mirrors buildGeneratedItem's own defensive check verbatim.
    if (
      !Number.isInteger(result.answerIndex) ||
      result.answerIndex < 0 ||
      result.answerIndex >= result.choices.length
    ) {
      skippedInvalid += 1;
      continue;
    }

    // SAME guard the live path uses — permute so the correct choice isn't
    // parked at index 0 (LLM position bias).
    const { choices: shuffled, correctAnswer } = shuffleGeneratedChoices(
      result.choices,
      result.answerIndex,
    );
    const answerIndex = CHOICE_IDS.indexOf(correctAnswer);

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO generated_items
         (section, level, kind, stem, passage, choices, answer_index, explain,
          source_ref, status, created_by, model_id, prompt_hash)
       VALUES ($1, $2, $3, $4, NULL, $5::jsonb, $6, $7, $8, 'draft', 'claude-batch', $9, $10)
       ON CONFLICT (prompt_hash) DO NOTHING
       RETURNING id`,
      [
        item.section,
        item.level,
        result.kind,
        result.prompt,
        JSON.stringify(shuffled.map((c) => ({ kr: c.kr, en: c.en }))),
        answerIndex,
        result.explain,
        item.seedRef,
        emitModel ?? model,
        built.promptHash,
      ],
    );
    if (rows.length > 0) {
      written += 1;
    } else {
      skippedAlreadyCached += 1;
    }
  }

  // A run that skipped EVERYTHING — and not because it was already
  // written — is an unfilled or wholly-invalid work-order. Exiting 0 would
  // let a weekly cron mark GREEN with zero items landed (mirrors
  // preseed-definitions.ts's identical guard).
  if (items.length > 0 && written === 0 && skippedAlreadyCached === 0) {
    throw new ItemBankInputError(
      `work-order "${inFile}" appears unfilled or wholly invalid — 0 written ` +
        `(${String(skippedInvalid)} invalid response, ${String(skippedHashDrift)} hash drift, ` +
        `${String(skippedSeedInvalid)} seed unsanitizable)`,
    );
  }

  const summary: IngestSummary = {
    total: items.length,
    written,
    skippedAlreadyCached,
    skippedHashDrift,
    skippedInvalid,
    skippedSeedInvalid,
  };
  print(
    `item-bank [INGEST]: COMPLETE — ${String(written)} written, ` +
      `${String(skippedAlreadyCached)} already in bank, ` +
      `${String(skippedHashDrift)} hash drift, ` +
      `${String(skippedInvalid)} invalid response, ` +
      `${String(skippedSeedInvalid)} seed unsanitizable`,
  );
  return summary;
}

/** Operator-log hygiene: a hostile/corrupted file could embed ANSI escapes
 *  / \r in an echoed field to forge or garble the ingest report (terminal-
 *  escape injection). Strip ASCII control chars, then truncate. */
function sanitizeForLog(s: string, n = 60): string {
  // Matching control chars is the point — see sanitize.ts CONTROL_CHARS_REGEX.
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(/[\x00-\x1f\x7f]/g, '');
  return stripped.length <= n ? stripped : `${stripped.slice(0, n)}…`;
}

// ---- CLI entry ---------------------------------------------------------------

async function main(): Promise<void> {
  const log = getLogger();
  const opts = parseCliArgs(process.argv.slice(2));
  const pool = getPool();
  // eslint-disable-next-line no-console
  const print = (line: string): void => console.error(line);

  if (opts.mode === 'count') {
    const s = await runCount(pool, opts, print);
    log.info(
      { mode: 'count', perCell: s.perCell, totalAchievable: s.totalAchievable },
      'generate-item-bank: count complete',
    );
  } else if (opts.mode === 'emit-batch') {
    const s = await runEmitBatch(pool, opts, print);
    log.info(
      { mode: 'emit-batch', emitted: s.emitted, outFile: s.outFile, model: s.model },
      'generate-item-bank: emit-batch complete',
    );
  } else {
    const s = await runIngest(pool, opts, print);
    log.info(
      {
        mode: 'ingest',
        inFile: opts.inFile,
        total: s.total,
        written: s.written,
        skippedAlreadyCached: s.skippedAlreadyCached,
        skippedHashDrift: s.skippedHashDrift,
        skippedInvalid: s.skippedInvalid,
        skippedSeedInvalid: s.skippedSeedInvalid,
      },
      'generate-item-bank: ingest complete',
    );
  }
}

// Run only when invoked directly as a CLI, NOT when imported — importing this
// file must never execute DB/network I/O. Mirrors preseed-definitions.ts.
if (require.main === module) {
  main()
    .then(async () => {
      await closePool();
      process.exit(0);
    })
    .catch(async (err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`generate-item-bank: FAILED — ${(err as Error).message}`);
      await closePool().catch(() => undefined);
      process.exit(exitCodeFor(err));
    });
}
