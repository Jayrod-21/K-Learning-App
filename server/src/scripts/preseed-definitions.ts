/**
 * preseed-definitions CLI — F-209 Phase 2: batch pre-seed of in-context
 * definitions for the STATIC tappable corpus by warming `claude_cache`.
 *
 * WHY THIS EXISTS
 * A tap on a word runs lemmatize → GET /define → POST /enrich; the enrich leg
 * is a live Claude call (~1-2 s cold) behind a 30-day write-through cache
 * (`claude_cache`, migration 004). For content whose sentences are known ahead
 * of time, pre-warming that cache makes even the FIRST tap instant. This tool
 * enumerates every (lemma, sentence) pair the client could produce from the
 * static corpus and warms the cache for the not-yet-cached ones.
 *
 * THE MAKE-OR-BREAK CONSTRAINT — prompt-hash identity
 * `claude_cache` is keyed by sha256(route|model|systemText|userText) computed
 * in services/claude (cache.ts `hashCacheKey` over the request that
 * prompts/enrich.ts builds). A pre-seeded row is only ever read back if a live
 * tap builds the BYTE-IDENTICAL request. Two guarantees enforce that here:
 *   1. The warm path calls the REAL `proxy.enrich(body)` — the same method
 *      routes/enrich.ts calls — so the write goes through the identical
 *      sanitize → buildEnrichRequest → hashCacheKey pipeline.
 *   2. The `body` is constructed EXACTLY as the client sends it. The live tap
 *      (client/src/lib/tapChain.ts `resolveEnrichment`) posts
 *      `{ lemma, sourceSentence }` and NOTHING else — no `context`, no
 *      `krdictGloss`, no `model`. `buildClientEnrichBody` mirrors that
 *      two-field shape and the tests pin it field-for-field.
 * `--validate` (and the apply-mode self-check) PROVE the identity end-to-end
 * before any bulk spend: seed one pair, then show a second client-shaped call
 * is served from cache.
 *
 * WHAT COUNTS AS "STATIC TAPPABLE CORPUS" (scout-verified against the client)
 *   reading — reading_passages.body (migration 044; book chapter reader,
 *             pages/Reading.tsx). The client splits a body on newlines
 *             (\r\n normalized first) and taps each LINE against its own text
 *             as the source sentence (PassageBody → TapKorean).
 *   ttmik   — ttmik_sentences.korean (lesson highlights) AND
 *             ttmik_transcript_lines.korean for kinds 'prose'|'pair'|'dialog'
 *             (migration 036; 'header' renders untappable text and
 *             'romanization' is dropped — pages/Ttmik.tsx TranscriptLine).
 *   iyagi   — iyagi_sentences.korean (podcast transcripts, same Ttmik page).
 *   topik   — topik_items.stem. OPT-IN ONLY (not in the default source set):
 *             the TOPIK surfaces render passages/stems as PLAIN text
 *             (components/TopikPassage.tsx — "an exam passage is plain text"),
 *             so no tap can ever read these cache rows today. Included as a
 *             source so the operator can pre-warm ahead of a future tappable
 *             TOPIK surface, but excluded by default to avoid unreadable spend.
 * EXCLUDED (dynamic, sentence unknown ahead of time): chat, image OCR,
 * per-user generated_stories, audio_transcript_segments (Listen renders no
 * tappable transcript today).
 *
 * TOKEN SELECTION mirrors the client: `tokeniseKorean` makes EVERY non-space
 * run a tap target; we additionally require at least one Hangul character
 * (deliberate cost filter — taps on stray Latin/number tokens stay on the
 * existing lazy write-through path). The lemma comes from the SAME Kiwi
 * service the client's /lemmatize route proxies to, with the client's exact
 * fallback: first token's lemma, else the raw surface form.
 *
 * MODES (— COUNT IS THE DEFAULT; only --apply spends money)
 *   --count / --dry-run  Enumerate + dedupe by cache key, subtract pairs whose
 *                        prompt_hash is already in claude_cache, and report:
 *                        exact call count, estimated cost (assumptions
 *                        printed), estimated wall-clock. ZERO Claude calls,
 *                        ZERO cache writes. This report is what gets approved
 *                        before an --apply run.
 *   --validate           Prove prompt-hash identity on ONE pair (≤ 1 paid
 *                        call): seed it via proxy.enrich, verify the row landed
 *                        at OUR independently computed hash, then show the
 *                        client-shaped repeat call is a cache hit. Hard gate
 *                        before --apply.
 *   --apply              The real spend. Idempotent (cached pairs are
 *                        subtracted up front, so a re-run resumes where the
 *                        last one stopped), rate-paced (--rate calls/min,
 *                        default 30 — under the proxy's own 60/min enrich
 *                        bucket), budget-capped (--max-calls / --max-cost,
 *                        stops cleanly and reports the remainder), and
 *                        self-checking (the first fresh pair re-runs the
 *                        validate proof; failure aborts before further spend).
 *   --emit-batch=N       SUBSCRIPTION workflow, step 1 (no API spend): order
 *                        the uncached pairs by priority (reading first, then
 *                        ttmik, then iyagi; corpus/reading order within a
 *                        source, so whole passages complete together), take the
 *                        first N, and write a
 *                        JSON work-order to --out=<file> (with a best-effort
 *                        krdictGloss hint per item). ZERO Claude calls, ZERO
 *                        cache writes. An operator (or a subscription Claude
 *                        session) fills each item with an `enrichment` object
 *                        matching EnrichmentResultSchema.
 *   --ingest             SUBSCRIPTION workflow, step 2 (no API spend): read
 *                        the FILLED work-order from --in=<file> (or
 *                        --ingest=<file>), re-probe each item's cache key,
 *                        Zod-validate its enrichment, and write it into
 *                        claude_cache at the exact key a live tap computes
 *                        (--ttl-days, default 365). Idempotent + resumable
 *                        (already-cached hashes are skipped); hash drift
 *                        between emit and ingest is skipped, not written; the
 *                        first write is round-trip verified (put → get →
 *                        re-validate) and the run ABORTS if that proof fails.
 *                        A run that writes NOTHING (and nothing was already
 *                        cached) exits non-zero — an unfilled work-order must
 *                        never look green.
 *
 * SECURITY / SAFETY
 *   - Read-only against the corpus tables; the only writes are proxy.enrich's
 *     own claude_cache/claude_usage side effects.
 *   - System-initiated usage: every call passes userId null, so claude_usage
 *     rows carry user_id NULL (the migration-004 "system pre-warm" contract).
 *   - Never logs secrets (no key material ever passes through this module; the
 *     proxy reads ANTHROPIC_API_KEY internally).
 *   - Pairs whose input the proxy would REJECT (over-length line, prompt-
 *     injection marker) are skipped and counted — a live tap on those fails
 *     the same way, so a cache row could never be read back anyway.
 *
 * Exit codes: 0 ok · 1 failure (incl. a failed validate proof) · 2 bad input.
 *
 * Run inside the ACTIVE color's server container (it holds DATABASE_URL,
 * ANTHROPIC_API_KEY and KIWI_URL on km-internal), e.g.:
 *   docker exec km-server-<active> node dist/scripts/preseed-definitions.js --count
 *   docker exec km-server-<active> node dist/scripts/preseed-definitions.js --validate
 *   docker exec km-server-<active> node dist/scripts/preseed-definitions.js \
 *     --apply --max-cost=25 --rate=30
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { z } from 'zod';

import { closePool, getPool } from '../db/pool.js';
import { getLogger } from '../logging.js';
import { ValidationError } from '../middleware/errors.js';
import { lemmatize as kiwiLemmatize } from '../services/kiwi.js';
import {
  PostgresCacheStore,
  hashCacheKey,
  type CacheKey,
  type CacheStore,
} from '../services/claude/cache.js';
import {
  loadConfig,
  type ClaudeModelId,
  type PublicClaudeConfig,
} from '../services/claude/config.js';
import {
  ClaudeRateLimitError,
  createClaudeProxy,
  serializeMessages,
  stringifySystem,
  type ClaudeProxy,
  type EnrichmentInput,
} from '../services/claude/index.js';
import {
  EnrichmentInputSchema,
  EnrichmentResultSchema,
  type EnrichmentResult,
} from '../services/claude/models.js';
import { buildEnrichRequest } from '../services/claude/prompts/enrich.js';
import { sanitizeUserInput } from '../services/claude/prompts/sanitize.js';
import { computeCostUsd } from '../services/claude/usage.js';

// ---- CLI contract ----------------------------------------------------------

export const PRESEED_SOURCES = ['reading', 'ttmik', 'iyagi', 'topik'] as const;
export type PreseedSource = (typeof PRESEED_SOURCES)[number];

/** topik excluded by default — its stems are not tappable in the client today
 *  (components/TopikPassage.tsx renders exam text as plain, untappable text),
 *  so pre-warming them is spend no tap can ever read back. Opt in explicitly
 *  with --sources=…,topik if a tappable TOPIK surface ships. */
export const DEFAULT_SOURCES: readonly PreseedSource[] = ['reading', 'ttmik', 'iyagi'];

export type PreseedMode = 'count' | 'validate' | 'apply' | 'emit-batch' | 'ingest';

export interface PreseedOptions {
  readonly mode: PreseedMode;
  readonly sources: readonly PreseedSource[];
  /** Apply pacing, calls per minute. Also feeds --count's wall-clock estimate. */
  readonly ratePerMin: number;
  /** Apply budget caps. undefined = uncapped on that axis. */
  readonly maxCalls: number | undefined;
  readonly maxCostUsd: number | undefined;
  /** emit-batch: how many uncached pairs to put in the work-order. */
  readonly emitBatch: number | undefined;
  /** emit-batch: path the JSON work-order is written to. */
  readonly outFile: string | undefined;
  /** ingest: path of the FILLED work-order to read. */
  readonly inFile: string | undefined;
  /** ingest: claude_cache TTL for pre-seeded rows, in days. */
  readonly ttlDays: number;
}

/** Bad CLI input → exit 2 (share-corpus's bad-input contract). */
export class PreseedInputError extends Error {}

/** The apply-mode identity self-check failed → abort before further spend. */
export class PreseedSelfCheckError extends Error {}

export function exitCodeFor(err: unknown): 1 | 2 {
  return err instanceof PreseedInputError ? 2 : 1;
}

const DEFAULT_RATE_PER_MIN = 30;
/** Default claude_cache TTL for --ingest rows. Long-lived on purpose: the
 *  corpus is static and subscription-generated content costs nothing to keep. */
export const DEFAULT_INGEST_TTL_DAYS = 365;
/** Hard ceiling on --ttl-days (100 years). An absurd value (e.g. 2e8 days)
 *  converts to a millisecond epoch beyond Date's range → Invalid Date → an
 *  opaque pg error mid-run. Reject at parse time instead. */
export const MAX_TTL_DAYS = 36_500;

/**
 * Parse `process.argv.slice(2)`. Strict: unknown flags, malformed values,
 * conflicting modes, and apply-only caps outside --apply all throw
 * PreseedInputError (exit 2) rather than being silently ignored — a typo'd
 * flag on a run that spends real money must fail loudly, not run uncapped.
 */
export function parseCliArgs(argv: readonly string[]): PreseedOptions {
  let mode: PreseedMode | null = null;
  let sources: readonly PreseedSource[] | null = null;
  let ratePerMin: number | null = null;
  let maxCalls: number | undefined;
  let maxCostUsd: number | undefined;
  let emitBatch: number | undefined;
  let outFile: string | undefined;
  let inFile: string | undefined;
  let ttlDays: number | undefined;

  // Pure so TS's control-flow analysis sees the assignment at the call site
  // (a closure-captured `mode = m` stays narrowed to `null` at later reads).
  const setMode = (prev: PreseedMode | null, m: PreseedMode): PreseedMode => {
    if (prev !== null && prev !== m) {
      throw new PreseedInputError(`conflicting modes: --${prev} and --${m}`);
    }
    return m;
  };

  // Value flags are assign-once. A lax parser would let `--x=a --x=b`
  // silently last-write-win; on a tool that spends real money that masks a
  // typo'd intent, so re-assignment fails as loudly as everything else here.
  const assignOnce = (alreadySet: boolean, flag: string): void => {
    if (alreadySet) {
      throw new PreseedInputError(`${flag} given more than once`);
    }
  };

  for (const arg of argv) {
    if (arg === '--count' || arg === '--dry-run') {
      mode = setMode(mode, 'count');
    } else if (arg === '--validate') {
      mode = setMode(mode, 'validate');
    } else if (arg === '--apply') {
      mode = setMode(mode, 'apply');
    } else if (arg.startsWith('--sources=')) {
      assignOnce(sources !== null, '--sources');
      const names = arg
        .slice('--sources='.length)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      if (names.length === 0) {
        throw new PreseedInputError('--sources= needs at least one source');
      }
      const parsed: PreseedSource[] = [];
      for (const name of names) {
        if (name === 'all') {
          parsed.push(...PRESEED_SOURCES);
          continue;
        }
        if (!(PRESEED_SOURCES as readonly string[]).includes(name)) {
          throw new PreseedInputError(
            `unknown source "${name}" (valid: ${PRESEED_SOURCES.join(', ')}, all)`,
          );
        }
        parsed.push(name as PreseedSource);
      }
      // De-dupe, preserve first-seen order.
      sources = [...new Set(parsed)];
    } else if (arg.startsWith('--emit-batch=')) {
      mode = setMode(mode, 'emit-batch');
      assignOnce(emitBatch !== undefined, '--emit-batch');
      emitBatch = parsePositiveInt(arg, '--emit-batch');
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
    } else if (arg.startsWith('--ttl-days=')) {
      assignOnce(ttlDays !== undefined, '--ttl-days');
      ttlDays = parsePositiveInt(arg, '--ttl-days');
      if (ttlDays > MAX_TTL_DAYS) {
        throw new PreseedInputError(
          `--ttl-days must be ≤ ${String(MAX_TTL_DAYS)} (100 years), got ${String(ttlDays)}`,
        );
      }
    } else if (arg.startsWith('--rate=')) {
      assignOnce(ratePerMin !== null, '--rate');
      ratePerMin = parsePositiveInt(arg, '--rate');
    } else if (arg.startsWith('--max-calls=')) {
      assignOnce(maxCalls !== undefined, '--max-calls');
      maxCalls = parsePositiveInt(arg, '--max-calls');
    } else if (arg.startsWith('--max-cost=')) {
      assignOnce(maxCostUsd !== undefined, '--max-cost');
      const raw = arg.slice('--max-cost='.length);
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        throw new PreseedInputError(`--max-cost must be a positive number, got "${raw}"`);
      }
      maxCostUsd = n;
    } else {
      throw new PreseedInputError(`unknown argument "${arg}"`);
    }
  }

  const resolvedMode: PreseedMode = mode ?? 'count';
  if (resolvedMode !== 'apply' && (maxCalls !== undefined || maxCostUsd !== undefined)) {
    throw new PreseedInputError('--max-calls/--max-cost only apply to --apply');
  }
  if (resolvedMode === 'emit-batch' && outFile === undefined) {
    throw new PreseedInputError('--emit-batch requires --out=<file>');
  }
  if (resolvedMode !== 'emit-batch' && outFile !== undefined) {
    throw new PreseedInputError('--out only applies to --emit-batch');
  }
  if (resolvedMode === 'ingest' && inFile === undefined) {
    throw new PreseedInputError('--ingest requires --in=<file> (or --ingest=<file>)');
  }
  if (resolvedMode !== 'ingest' && (inFile !== undefined || ttlDays !== undefined)) {
    throw new PreseedInputError('--in/--ttl-days only apply to --ingest');
  }
  // --ingest replays a work-order file verbatim: enumeration knobs are
  // meaningless there and a silently ignored flag would mask a typo'd intent.
  if (resolvedMode === 'ingest' && (sources !== null || ratePerMin !== null)) {
    throw new PreseedInputError('--sources/--rate do not apply to --ingest');
  }
  // --emit-batch makes zero Claude calls, so there is nothing to pace: a
  // silently ignored --rate would mask "I meant --apply" — fail loudly.
  if (resolvedMode === 'emit-batch' && ratePerMin !== null) {
    throw new PreseedInputError('--rate does not apply to --emit-batch (nothing is paced)');
  }

  return {
    mode: resolvedMode,
    sources: sources ?? DEFAULT_SOURCES,
    ratePerMin: ratePerMin ?? DEFAULT_RATE_PER_MIN,
    maxCalls,
    maxCostUsd,
    emitBatch,
    outFile,
    inFile,
    ttlDays: ttlDays ?? DEFAULT_INGEST_TTL_DAYS,
  };
}

function parsePositiveInt(arg: string, flag: string): number {
  const raw = arg.slice(flag.length + 1);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new PreseedInputError(`${flag} must be a positive integer, got "${raw}"`);
  }
  return n;
}

function parseNonEmptyString(arg: string, flag: string): string {
  const raw = arg.slice(flag.length + 1);
  if (raw === '') {
    throw new PreseedInputError(`${flag} needs a non-empty value`);
  }
  return raw;
}

// ---- Client-behavior replicas ----------------------------------------------
// Each helper mirrors ONE specific client code path, cited inline. If the
// client changes, these must follow — the test suite pins today's contract.

/**
 * Reading passage → the per-line "source sentence" strings the client taps
 * against. Mirrors pages/Reading.tsx `PassageBody`:
 *   body.replace(/\r\n/g, '\n').split('\n')  → one TapKorean per line, each
 * tapped with its OWN line text as the sentence. Blank lines yield no tokens
 * downstream, so they are dropped here.
 */
export function splitReadingLines(body: string): string[] {
  return body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

/** At least one Hangul character (jamo, compat jamo, or syllable block). */
const HANGUL_RE = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힣ힰ-퟿]/;

/**
 * The tappable tokens of a sentence. Mirrors client tapChain `tokeniseKorean`:
 * split into runs of whitespace / non-whitespace (`/\s+|\S+/g`); every
 * non-space run is a tap target, punctuation riding along verbatim (the raw
 * token — punctuation included — is what the client lemmatizes).
 *
 * Deliberate narrowing vs the client: tokens with NO Hangul at all (stray
 * Latin words, bare numbers/punctuation in mixed lines) are dropped — they
 * are technically tappable but not worth pre-paying Claude for; such taps
 * keep today's lazy write-through behavior.
 */
export function tappableTokens(sentence: string): string[] {
  const parts = sentence.match(/\s+|\S+/g) ?? [];
  return parts.filter((p) => !/^\s+$/.test(p) && HANGUL_RE.test(p));
}

/**
 * The EXACT `/enrich` request body the client sends for a tapped word —
 * client/src/lib/tapChain.ts `resolveEnrichment`:
 *     enrich({ lemma, sourceSentence }, signal)
 * Two fields, nothing else: no `context`, no `krdictGloss`, no `model`.
 * (The server schema accepts those as optionals, but the prompt builder maps
 * an ABSENT field to JSON null exactly as it maps an absent client field, so
 * shape-identity here is what makes the cache keys collide.) Pinned
 * field-for-field by the tests.
 */
export function buildClientEnrichBody(lemma: string, sourceSentence: string): EnrichmentInput {
  return { lemma, sourceSentence };
}

// ---- Cache-key mirror ------------------------------------------------------

export interface EnrichCacheProbe {
  /** The claude_cache.prompt_hash the live enrich path computes for `body`. */
  readonly hash: string;
  /** Full cache key (tests use it to pre-seed rows via PostgresCacheStore). */
  readonly key: CacheKey;
  /** The complete user-message text — feeds the cost estimator. */
  readonly userMessageText: string;
}

/**
 * Compute the cache key/hash for a client-shaped enrich body EXACTLY as
 * `ClaudeProxyImpl.enrich` + `runJsonRoute` do (services/claude/index.ts):
 * Zod-parse → sanitizeUserInput(sourceSentence) → buildEnrichRequest →
 * hashCacheKey({route, model, stringifySystem(system), serializeMessages}).
 * Every step is the proxy's own exported building block — nothing is
 * re-implemented, so the two computations cannot drift.
 *
 * Returns null when the proxy itself would REJECT the input (over-length
 * sentence, prompt-injection marker, empty lemma): a live tap on that pair
 * fails identically, so it can never produce a readable cache row and the
 * pre-seed must skip it rather than crash.
 */
export function probeEnrichCacheKey(
  body: EnrichmentInput,
  cfg: PublicClaudeConfig,
): EnrichCacheProbe | null {
  const parsed = EnrichmentInputSchema.safeParse(body);
  if (!parsed.success) return null;
  const input = parsed.data;

  let sanitizedSentence: string;
  try {
    sanitizedSentence = sanitizeUserInput(input.sourceSentence, {
      maxLength: cfg.inputCaps.enrich,
    });
  } catch {
    return null;
  }

  // Mirrors enrich()'s `cleaned` construction: context is omitted when absent
  // (our client-shaped body never carries one).
  const cleaned: EnrichmentInput = { ...input, sourceSentence: sanitizedSentence };
  const model = cfg.modelDefaults.enrich;
  const req = buildEnrichRequest(cleaned, model);

  const key: CacheKey = {
    route: 'enrich',
    model,
    systemText: stringifySystem(req.system),
    userText: serializeMessages(req.messages),
  };
  const firstBlock = req.messages[0]?.content[0];
  const userMessageText = firstBlock !== undefined && firstBlock.type === 'text' ? firstBlock.text : '';
  return { hash: hashCacheKey(key), key, userMessageText };
}

// ---- Enumeration -----------------------------------------------------------

export interface PreseedPair {
  readonly lemma: string;
  readonly sourceSentence: string;
  readonly hash: string;
  /** The corpus source this pair was FIRST seen in (dedupe keeps the first). */
  readonly source: PreseedSource;
  /**
   * Monotonic enumeration index (0-based, assigned at FIRST insertion). Because
   * `enumeratePairs` walks reading passages by id, lines in order, and tokens
   * left-to-right, `seq` IS corpus/reading order — the axis emit-batch seeds on
   * so whole passages complete together (see `orderByPriority`).
   */
  readonly seq: number;
  /** Estimated user-message tokens (cost model — see estimator constants). */
  readonly userTokensEst: number;
}

export interface SourceStats {
  rows: number;
  sentences: number;
  tokens: number;
}

export interface Enumeration {
  /** Unique pairs keyed by prompt_hash (the dedupe axis that matters). */
  readonly pairs: Map<string, PreseedPair>;
  readonly perSource: ReadonlyMap<PreseedSource, SourceStats>;
  readonly uniqueSurfaceForms: number;
  /** Pairs the proxy would reject (over-length / injection marker) — skipped. */
  readonly skippedInvalid: number;
}

/**
 * token → lemma, replicating the client fallback chain. Implementations MUST
 * mirror client tapChain `resolveBasePopover`: first Kiwi token's lemma when
 * truthy, else the raw surface form.
 */
export type Lemmatizer = (token: string) => Promise<string>;

/**
 * Production lemmatizer: the same services/kiwi.ts `lemmatize` the client's
 * POST /lemmatize route proxies to, memoized per surface form (the corpus
 * re-uses forms heavily — ~50k unique forms over ~300k tokens).
 *
 * Failure semantics (deliberately asymmetric):
 *   - ValidationError (Kiwi judged THIS input bad → the client's call 400s
 *     and it falls back to the raw form): fall back to the raw form. Parity.
 *   - Anything else (Kiwi down/unreachable): THROW and abort the run. If we
 *     mirrored the client fallback here, a Kiwi outage would silently seed
 *     the whole corpus under raw-form keys that no healthy-Kiwi tap ever
 *     computes — 100% wasted spend. Abort loudly instead.
 */
export function makeKiwiLemmatizer(correlationId: string): Lemmatizer {
  const memo = new Map<string, Promise<string>>();
  return (token: string): Promise<string> => {
    const hit = memo.get(token);
    if (hit !== undefined) return hit;
    const p = (async (): Promise<string> => {
      try {
        const res = await kiwiLemmatize({ text: token }, correlationId);
        const first = res.tokens[0];
        // Client parity (tapChain): `if (first && first.lemma) lemma = first.lemma`.
        if (first !== undefined && first.lemma !== '') return first.lemma;
        return token;
      } catch (err) {
        if (err instanceof ValidationError) return token;
        throw err;
      }
    })();
    memo.set(token, p);
    return p;
  };
}

interface SentenceBatch {
  readonly rows: number;
  readonly sentences: readonly string[];
  readonly lastId: number;
}

const PAGE_SIZE = 500;

/** Keyset-paged fetch of one source's sentence strings. */
async function fetchSourcePage(
  pool: Pool,
  source: PreseedSource,
  afterId: number,
): Promise<SentenceBatch> {
  // NOTE: every query is a static string + $n parameters (no interpolation).
  let sql: string;
  switch (source) {
    case 'reading':
      sql = `SELECT id, body AS text FROM reading_passages
              WHERE id > $1 ORDER BY id LIMIT $2`;
      break;
    case 'ttmik':
      // Handled specially below (two tables); this branch is unreachable.
      throw new Error('ttmik pages are fetched via fetchTtmikPages');
    case 'iyagi':
      sql = `SELECT id, korean AS text FROM iyagi_sentences
              WHERE id > $1 ORDER BY id LIMIT $2`;
      break;
    case 'topik':
      sql = `SELECT id, stem AS text FROM topik_items
              WHERE stem IS NOT NULL AND stem <> '' AND id > $1
              ORDER BY id LIMIT $2`;
      break;
  }
  const res = await pool.query<{ id: number; text: string }>(sql, [afterId, PAGE_SIZE]);
  const last = res.rows.length > 0 ? Number(res.rows[res.rows.length - 1]!.id) : afterId;
  return { rows: res.rows.length, sentences: res.rows.map((r) => r.text), lastId: last };
}

/**
 * Enumerate one source's sentence strings (paged), invoking `onSentence` per
 * raw sentence. reading yields per-LINE strings (client parity); ttmik spans
 * two tables (highlights + tappable transcript kinds).
 */
async function forEachSourceSentence(
  pool: Pool,
  source: PreseedSource,
  stats: SourceStats,
  onSentence: (sentence: string) => Promise<void>,
): Promise<void> {
  const tables: Array<(afterId: number) => Promise<SentenceBatch>> =
    source === 'ttmik'
      ? [
          async (afterId) => {
            const res = await pool.query<{ id: number; text: string }>(
              `SELECT id, korean AS text FROM ttmik_sentences
                WHERE id > $1 ORDER BY id LIMIT $2`,
              [afterId, PAGE_SIZE],
            );
            const last = res.rows.length > 0 ? Number(res.rows[res.rows.length - 1]!.id) : afterId;
            return { rows: res.rows.length, sentences: res.rows.map((r) => r.text), lastId: last };
          },
          async (afterId) => {
            // Only the transcript kinds the client renders through TapKorean
            // (pages/Ttmik.tsx TranscriptLine): prose, pair, dialog. 'header'
            // renders as plain text and 'romanization' is dropped.
            const res = await pool.query<{ id: number; text: string }>(
              `SELECT id, korean AS text FROM ttmik_transcript_lines
                WHERE kind IN ('prose', 'pair', 'dialog')
                  AND korean IS NOT NULL AND korean <> ''
                  AND id > $1
                ORDER BY id LIMIT $2`,
              [afterId, PAGE_SIZE],
            );
            const last = res.rows.length > 0 ? Number(res.rows[res.rows.length - 1]!.id) : afterId;
            return { rows: res.rows.length, sentences: res.rows.map((r) => r.text), lastId: last };
          },
        ]
      : [(afterId): Promise<SentenceBatch> => fetchSourcePage(pool, source, afterId)];

  for (const fetchPage of tables) {
    let afterId = 0;
    for (;;) {
      const batch = await fetchPage(afterId);
      if (batch.rows === 0) break;
      stats.rows += batch.rows;
      for (const raw of batch.sentences) {
        const sentences = source === 'reading' ? splitReadingLines(raw) : [raw];
        for (const sentence of sentences) {
          stats.sentences += 1;
          await onSentence(sentence);
        }
      }
      afterId = batch.lastId;
      if (batch.rows < PAGE_SIZE) break;
    }
  }
}

/**
 * Walk the selected sources and build the deduped (lemma, sentence) pair set,
 * keyed by the live enrich path's prompt_hash. Identical sentences (repeated
 * lines across lessons) are processed once; identical (lemma, sentence) pairs
 * collapse on the hash key.
 */
export async function enumeratePairs(
  pool: Pool,
  cfg: PublicClaudeConfig,
  sources: readonly PreseedSource[],
  lemmatize: Lemmatizer,
  print: (line: string) => void,
): Promise<Enumeration> {
  const pairs = new Map<string, PreseedPair>();
  const perSource = new Map<PreseedSource, SourceStats>();
  const seenSentences = new Set<string>();
  const surfaceForms = new Set<string>();
  let skippedInvalid = 0;
  // Monotonic corpus-order index. Incremented per NEWLY-inserted pair, so it
  // records the first-seen reading order (see PreseedPair.seq).
  let seq = 0;

  for (const source of sources) {
    const stats: SourceStats = { rows: 0, sentences: 0, tokens: 0 };
    perSource.set(source, stats);

    await forEachSourceSentence(pool, source, stats, async (sentence) => {
      if (seenSentences.has(sentence)) return;
      seenSentences.add(sentence);

      for (const token of tappableTokens(sentence)) {
        stats.tokens += 1;
        surfaceForms.add(token);
        const lemma = await lemmatize(token);
        const body = buildClientEnrichBody(lemma, sentence);
        const probe = probeEnrichCacheKey(body, cfg);
        if (probe === null) {
          skippedInvalid += 1;
          continue;
        }
        if (!pairs.has(probe.hash)) {
          pairs.set(probe.hash, {
            lemma,
            sourceSentence: sentence,
            hash: probe.hash,
            source,
            seq: seq++,
            userTokensEst: estimateTokens(probe.userMessageText),
          });
        }
      }
    });

    print(
      `preseed: enumerated ${source} — ${String(stats.rows)} rows, ` +
        `${String(stats.sentences)} sentences, ${String(stats.tokens)} tappable tokens`,
    );
  }

  return { pairs, perSource, uniqueSurfaceForms: surfaceForms.size, skippedInvalid };
}

/**
 * The prompt_hashes of live (unexpired) enrich rows already in claude_cache
 * for the configured enrich model — the subtraction set for count/apply.
 * Mirrors the cache read predicate (cache.ts SELECT_SQL): NULL-expiry rows
 * are legacy poison and never served, so they do NOT count as cached.
 */
export async function fetchCachedEnrichHashes(
  pool: Pool,
  model: ClaudeModelId,
): Promise<Set<string>> {
  const res = await pool.query<{ prompt_hash: string }>(
    `SELECT prompt_hash FROM claude_cache
      WHERE route = 'enrich'::claude_route
        AND model = $1::claude_model
        AND expires_at IS NOT NULL
        AND expires_at > now()`,
    [model],
  );
  return new Set(res.rows.map((r) => r.prompt_hash));
}

// ---- Priority ordering -----------------------------------------------------

/** Source rank for --emit-batch: reading exhausts first, then ttmik, then
 *  iyagi. topik (opt-in, untappable today) sorts last on purpose. */
const SOURCE_RANK: Readonly<Record<PreseedSource, number>> = {
  reading: 0,
  ttmik: 1,
  iyagi: 2,
  topik: 3,
};

/**
 * Deterministic priority order for emit-batch:
 *   1. source rank ascending (reading → ttmik → iyagi → topik);
 *   2. corpus/reading order within a source (`seq` ascending) — so a batch
 *      seeds WHOLE passages front-to-back and a chapter becomes fully instant
 *      once covered. This deliberately supersedes an earlier frequency-first
 *      policy: frequency-first spent entire batches on one ultra-common lemma
 *      (있다 ×N) — words a learner already knows and rarely taps — while the
 *      rarer content words they DO look up stayed cold. Reading order covers
 *      the actual vocabulary of the text, in context, as it is read.
 * `seq` is unique per enumeration, so (source, seq) is a total order — no
 * tiebreak needed. Pure: does not mutate the input. No Date/random anywhere.
 */
export function orderByPriority(pairs: readonly PreseedPair[]): PreseedPair[] {
  return [...pairs].sort((a, b) => {
    const bySource = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
    if (bySource !== 0) return bySource;
    return a.seq - b.seq;
  });
}

// ---- Cost model ------------------------------------------------------------
// Every constant is an ASSUMPTION, stated in the --count report. The rates
// themselves come from usage.ts computeCostUsd (the shared RATE_CARD), so a
// price update there flows through here automatically.

/** Claude tokenizes Hangul densely; ~1.5 tokens per Hangul char is a
 *  deliberately conservative (high) planning figure. */
const HANGUL_TOKENS_PER_CHAR = 1.5;
/** ASCII/JSON scaffolding averages ~3.5-4 chars per token; use 3.5 (high). */
const NON_HANGUL_CHARS_PER_TOKEN = 3.5;
/** Enrich responses are schema-bound (max_tokens 800); observed payloads run
 *  ~350-500 output tokens. Budget the high end. */
const EST_OUTPUT_TOKENS_PER_CALL = 500;
/** The system prompt carries cache_control ephemeral (5-min TTL at Anthropic);
 *  a steadily-paced run re-creates it roughly once per TTL window. */
const ANTHROPIC_PROMPT_CACHE_TTL_MIN = 5;

export function estimateTokens(text: string): number {
  let hangul = 0;
  let other = 0;
  for (const ch of text) {
    if (HANGUL_RE.test(ch)) hangul += 1;
    else other += 1;
  }
  return Math.ceil(hangul * HANGUL_TOKENS_PER_CHAR + other / NON_HANGUL_CHARS_PER_TOKEN);
}

export interface SpendEstimate {
  readonly callsNeeded: number;
  readonly model: ClaudeModelId;
  readonly systemTokensEst: number;
  readonly avgUserTokensEst: number;
  /** With Anthropic prompt caching on the system block (the expected case). */
  readonly estCostUsd: number;
  /** If prompt caching bought nothing (every call full-priced) — the ceiling. */
  readonly worstCaseCostUsd: number;
  readonly estWallClockMin: number;
  readonly ratePerMin: number;
}

export function estimateSpend(
  todo: readonly PreseedPair[],
  cfg: PublicClaudeConfig,
  ratePerMin: number,
): SpendEstimate {
  const model = cfg.modelDefaults.enrich;
  // Representative request → the system prompt's real text length.
  const sampleReq = buildEnrichRequest({ lemma: '가다', sourceSentence: '학교에 가요.' }, model);
  const systemTokensEst = estimateTokens(stringifySystem(sampleReq.system));

  const callsNeeded = todo.length;
  const estWallClockMin = callsNeeded === 0 ? 0 : callsNeeded / ratePerMin;
  const cacheCreations =
    callsNeeded === 0 ? 0 : Math.max(1, Math.ceil(estWallClockMin / ANTHROPIC_PROMPT_CACHE_TTL_MIN));

  let variableCost = 0;
  let worstCase = 0;
  let userTokensSum = 0;
  for (const pair of todo) {
    userTokensSum += pair.userTokensEst;
    // Expected: system block read from Anthropic's prompt cache.
    variableCost += computeCostUsd(
      model,
      pair.userTokensEst,
      systemTokensEst,
      0,
      EST_OUTPUT_TOKENS_PER_CALL,
    );
    // Ceiling: no prompt-cache benefit at all.
    worstCase += computeCostUsd(
      model,
      pair.userTokensEst + systemTokensEst,
      0,
      0,
      EST_OUTPUT_TOKENS_PER_CALL,
    );
  }
  // Surcharge for the periodic cache re-creations: creation-rate minus the
  // cached-read already counted for those calls.
  const creationSurcharge =
    cacheCreations *
    (computeCostUsd(model, 0, 0, systemTokensEst, 0) -
      computeCostUsd(model, 0, systemTokensEst, 0, 0));

  return {
    callsNeeded,
    model,
    systemTokensEst,
    avgUserTokensEst: callsNeeded === 0 ? 0 : Math.round(userTokensSum / callsNeeded),
    estCostUsd: variableCost + creationSurcharge,
    worstCaseCostUsd: worstCase,
    estWallClockMin,
    ratePerMin,
  };
}

// ---- Run plumbing ----------------------------------------------------------

export interface PreseedDeps {
  readonly pool: Pool;
  /** The REAL proxy in production; tests inject a stub-SDK-backed real proxy. */
  readonly proxy: Pick<ClaudeProxy, 'enrich'>;
  readonly lemmatize: Lemmatizer;
  readonly opts: PreseedOptions;
  /** Direct cache writes for --ingest (the production PostgresCacheStore in
   *  main(); tests may inject an in-memory/fake store). Only ingest uses it —
   *  every other mode writes via proxy.enrich's own side effects or not at all. */
  readonly cacheStore: Pick<CacheStore, 'put' | 'get'>;
  /** Operator-facing reporter (stderr in the CLI, capture array in tests). */
  readonly print: (line: string) => void;
  /** Pacing sleep — injectable so tests run instantly. */
  readonly sleep: (ms: number) => Promise<void>;
}

/** Shared preamble: enumerate, subtract cached, split into todo/cached. */
async function prepare(deps: PreseedDeps): Promise<{
  enumeration: Enumeration;
  cachedHashes: Set<string>;
  todo: PreseedPair[];
  model: ClaudeModelId;
  cfg: PublicClaudeConfig;
}> {
  const cfg = loadConfig();
  const model = cfg.modelDefaults.enrich;
  const enumeration = await enumeratePairs(
    deps.pool,
    cfg,
    deps.opts.sources,
    deps.lemmatize,
    deps.print,
  );
  const cachedHashes = await fetchCachedEnrichHashes(deps.pool, model);
  const todo = [...enumeration.pairs.values()].filter((p) => !cachedHashes.has(p.hash));
  return { enumeration, cachedHashes, todo, model, cfg };
}

// ---- count -----------------------------------------------------------------

export interface CountSummary {
  readonly sources: readonly PreseedSource[];
  readonly uniquePairs: number;
  readonly alreadyCached: number;
  readonly skippedInvalid: number;
  readonly uniqueSurfaceForms: number;
  readonly estimate: SpendEstimate;
}

export async function runCount(deps: PreseedDeps): Promise<CountSummary> {
  const { enumeration, todo } = await prepare(deps);
  const estimate = estimateSpend(todo, loadConfig(), deps.opts.ratePerMin);

  const summary: CountSummary = {
    sources: deps.opts.sources,
    uniquePairs: enumeration.pairs.size,
    alreadyCached: enumeration.pairs.size - todo.length,
    skippedInvalid: enumeration.skippedInvalid,
    uniqueSurfaceForms: enumeration.uniqueSurfaceForms,
    estimate,
  };
  reportCount(summary, deps.print);
  return summary;
}

function reportCount(s: CountSummary, print: (line: string) => void): void {
  const e = s.estimate;
  print(`preseed [COUNT]: sources = ${s.sources.join(', ')}`);
  print(
    `preseed [COUNT]: ${String(s.uniquePairs)} unique (lemma, sentence) pairs ` +
      `(${String(s.uniqueSurfaceForms)} unique surface forms; ` +
      `${String(s.skippedInvalid)} skipped as proxy-rejectable)`,
  );
  print(
    `preseed [COUNT]: ${String(s.alreadyCached)} already cached → ` +
      `${String(e.callsNeeded)} Claude calls needed (model ${e.model})`,
  );
  print(
    `preseed [COUNT]: estimated cost ≈ $${e.estCostUsd.toFixed(2)} ` +
      `(worst case, no Anthropic prompt-cache benefit: $${e.worstCaseCostUsd.toFixed(2)})`,
  );
  print(
    `preseed [COUNT]: assumptions — output ${String(EST_OUTPUT_TOKENS_PER_CALL)} tok/call ` +
      `(schema max_tokens 800); user msg avg ${String(e.avgUserTokensEst)} tok ` +
      `(Hangul ${String(HANGUL_TOKENS_PER_CHAR)} tok/char, other 1 tok per ` +
      `${String(NON_HANGUL_CHARS_PER_TOKEN)} chars); system prompt ≈${String(e.systemTokensEst)} tok ` +
      `served from Anthropic's 5-min ephemeral prompt cache; ` +
      `prices from services/claude/usage.ts RATE_CARD via computeCostUsd`,
  );
  const hours = e.estWallClockMin / 60;
  print(
    `preseed [COUNT]: estimated wall-clock ≈ ${e.estWallClockMin.toFixed(0)} min ` +
      `(${hours.toFixed(1)} h) at --rate=${String(e.ratePerMin)} calls/min`,
  );
  print('preseed [COUNT]: DRY RUN — no Claude calls made, no cache rows written.');
}

// ---- validate --------------------------------------------------------------

export interface ValidateSummary {
  readonly passed: boolean;
  /** 'fresh' = seeded one new pair (≤1 paid call); 'already-cached' = proven
   *  against an existing row (zero spend). */
  readonly path: 'fresh' | 'already-cached';
  readonly lemma: string;
  readonly sourceSentence: string;
  readonly promptHash: string;
  readonly spendUsd: number;
}

/**
 * Prove prompt-hash identity end-to-end on ONE pair:
 *   1. compute the hash INDEPENDENTLY (probeEnrichCacheKey);
 *   2. warm via the real proxy.enrich with the client-shaped body;
 *   3. assert the claude_cache row landed at exactly that hash;
 *   4. assert a repeat client-shaped call reports cacheHit.
 * If the pair was already cached, step 2's FIRST call must already be a
 * cache hit — the proof holds with zero spend.
 */
export async function runValidate(deps: PreseedDeps): Promise<ValidateSummary> {
  const { enumeration, todo, model, cfg } = await prepare(deps);
  if (enumeration.pairs.size === 0) {
    throw new Error('no (lemma, sentence) pairs enumerated — is the corpus loaded?');
  }
  const pair = todo[0] ?? [...enumeration.pairs.values()][0]!;
  const alreadyCached = todo[0] === undefined;
  const body = buildClientEnrichBody(pair.lemma, pair.sourceSentence);
  const probe = probeEnrichCacheKey(body, cfg);
  if (probe === null) {
    // Unreachable: enumeration only admits probeable pairs. Belt-and-braces.
    throw new Error('validate pair failed cache-key probe');
  }

  deps.print(
    `preseed [VALIDATE]: pair lemma="${pair.lemma}" ` +
      `sentence="${truncate(pair.sourceSentence, 60)}" hash=${probe.hash.slice(0, 16)}…`,
  );

  let spendUsd = 0;
  const first = await deps.proxy.enrich(body, {
    requestId: `preseed-validate-${randomUUID()}`,
    userId: null,
    bucketKey: 'preseed',
  });
  spendUsd += first.metadata.costEstimateUsd;

  // The row must exist at OUR independently computed hash — this is the
  // byte-identity proof (the proxy computed the same key we did).
  const row = await deps.pool.query(
    `SELECT 1 FROM claude_cache
      WHERE prompt_hash = $1 AND model = $2::claude_model AND route = 'enrich'::claude_route`,
    [probe.hash, model],
  );
  const rowLanded = (row.rowCount ?? 0) > 0;

  const second = await deps.proxy.enrich(body, {
    requestId: `preseed-validate-${randomUUID()}`,
    userId: null,
    bucketKey: 'preseed',
  });
  spendUsd += second.metadata.costEstimateUsd;

  const passed = rowLanded && second.metadata.cacheHit && (!alreadyCached || first.metadata.cacheHit);
  const summary: ValidateSummary = {
    passed,
    path: alreadyCached ? 'already-cached' : 'fresh',
    lemma: pair.lemma,
    sourceSentence: pair.sourceSentence,
    promptHash: probe.hash,
    spendUsd,
  };

  if (passed) {
    deps.print(
      `preseed [VALIDATE]: PASS — row landed at the computed hash and the ` +
        `client-shaped repeat call was a cache hit (${summary.path}; ` +
        `spend $${spendUsd.toFixed(4)}). Safe to --apply.`,
    );
  } else {
    deps.print(
      `preseed [VALIDATE]: FAIL — rowAtComputedHash=${String(rowLanded)} ` +
        `repeatCacheHit=${String(second.metadata.cacheHit)} ` +
        `firstCallCacheHit=${String(first.metadata.cacheHit)} (${summary.path}). ` +
        `DO NOT --apply: pre-seeded rows would never be read back.`,
    );
  }
  return summary;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/**
 * Operator-log hygiene for values echoed from a work-order FILE: a hostile or
 * corrupted file could embed ANSI escapes / \r in a lemma to forge or garble
 * the ingest report (terminal-escape injection). Strip ASCII control chars,
 * then truncate via the shared helper.
 */
function sanitizeForLog(s: string, n = 40): string {
  // Matching control chars is the point — see sanitize.ts CONTROL_CHARS_REGEX.
  // eslint-disable-next-line no-control-regex
  return truncate(s.replace(/[\x00-\x1f\x7f]/g, ''), n);
}

// ---- apply -----------------------------------------------------------------

export interface ApplySummary {
  readonly todoAtStart: number;
  readonly alreadyCached: number;
  /** Fresh Claude calls made (== rows seeded). */
  readonly calls: number;
  /** Pairs that turned out cached mid-run (raced by a live tap). */
  readonly unexpectedCacheHits: number;
  readonly failures: number;
  readonly spendUsd: number;
  readonly remaining: number;
  readonly stoppedBy: 'complete' | 'max-calls' | 'max-cost';
}

/** Abort the run after this many CONSECUTIVE failures — a broken pipeline
 *  (expired key, model outage) must not burn budget pair by pair. */
const MAX_CONSECUTIVE_FAILURES = 5;
/** Local token-bucket rejection → back off one bucket-refill-ish interval. */
const RATE_LIMIT_BACKOFF_MS = 10_000;
const PROGRESS_EVERY = 25;

export async function runApply(deps: PreseedDeps): Promise<ApplySummary> {
  const { enumeration, todo, model } = await prepare(deps);
  const opts = deps.opts;
  const interCallMs = Math.ceil(60_000 / opts.ratePerMin);
  const runId = randomUUID();

  // The cache key embeds THIS process's enrich model, so the operator must see
  // it matches the live-serving color's model before the run spends money —
  // rows seeded under a mismatched model are never read back by live taps.
  deps.print(
    `preseed [APPLY]: ${String(todo.length)} pairs to seed ` +
      `(${String(enumeration.pairs.size - todo.length)} already cached), ` +
      `model ${model}, ` +
      `rate ${String(opts.ratePerMin)}/min` +
      (opts.maxCalls !== undefined ? `, max-calls ${String(opts.maxCalls)}` : '') +
      (opts.maxCostUsd !== undefined ? `, max-cost $${opts.maxCostUsd.toFixed(2)}` : ''),
  );

  let calls = 0;
  let unexpectedCacheHits = 0;
  let failures = 0;
  let consecutiveFailures = 0;
  let spendUsd = 0;
  let selfCheckDone = false;
  let stoppedBy: ApplySummary['stoppedBy'] = 'complete';
  let processed = 0;

  let i = 0;
  while (i < todo.length) {
    if (opts.maxCalls !== undefined && calls >= opts.maxCalls) {
      stoppedBy = 'max-calls';
      break;
    }
    if (opts.maxCostUsd !== undefined && spendUsd >= opts.maxCostUsd) {
      stoppedBy = 'max-cost';
      break;
    }

    const pair = todo[i]!;
    const body = buildClientEnrichBody(pair.lemma, pair.sourceSentence);
    try {
      const res = await deps.proxy.enrich(body, {
        requestId: `preseed-${runId}-${String(i)}`,
        userId: null, // system-initiated → claude_usage.user_id NULL
        bucketKey: 'preseed',
      });
      consecutiveFailures = 0;
      if (res.metadata.cacheHit) {
        // Raced by a live tap since our subtraction snapshot — free, move on.
        unexpectedCacheHits += 1;
      } else {
        calls += 1;
        spendUsd += res.metadata.costEstimateUsd;

        if (!selfCheckDone) {
          // Identity self-check on the FIRST fresh pair: the repeat
          // client-shaped call must be served from cache, or every further
          // dollar would be wasted. The repeat is a cache read — no spend.
          const again = await deps.proxy.enrich(body, {
            requestId: `preseed-${runId}-selfcheck`,
            userId: null,
            bucketKey: 'preseed',
          });
          if (!again.metadata.cacheHit) {
            throw new PreseedSelfCheckError(
              'prompt-hash identity self-check FAILED on the first seeded pair — ' +
                'aborting before further spend (run --validate and fix the drift)',
            );
          }
          selfCheckDone = true;
          deps.print('preseed [APPLY]: identity self-check PASS (first pair re-read from cache)');
        }
        await deps.sleep(interCallMs);
      }
      i += 1;
      processed += 1;
    } catch (err) {
      if (err instanceof PreseedSelfCheckError) throw err;
      if (err instanceof ClaudeRateLimitError) {
        // Our own token bucket (or upstream) said slow down — back off and
        // RETRY the same pair; this is pacing, not failure.
        deps.print(
          `preseed [APPLY]: rate-limited at pair ${String(i)} — backing off ` +
            `${String(RATE_LIMIT_BACKOFF_MS)} ms`,
        );
        await deps.sleep(RATE_LIMIT_BACKOFF_MS);
        continue;
      }
      failures += 1;
      consecutiveFailures += 1;
      deps.print(
        `preseed [APPLY]: pair ${String(i)} (lemma="${pair.lemma}") failed — ` +
          `${err instanceof Error ? err.constructor.name : 'unknown'}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error(
          `aborting after ${String(MAX_CONSECUTIVE_FAILURES)} consecutive failures — ` +
            `${String(calls)} calls made ($${spendUsd.toFixed(2)}); ` +
            `the run is resumable (re-run --apply to continue)`,
        );
      }
      i += 1; // skip the failed pair; a re-run retries it (still uncached)
      processed += 1;
    }

    if (processed % PROGRESS_EVERY === 0 && processed > 0) {
      deps.print(
        `preseed [APPLY]: ${String(processed)}/${String(todo.length)} processed — ` +
          `${String(calls)} calls, ${String(unexpectedCacheHits)} cache hits, ` +
          `${String(failures)} failures, spend $${spendUsd.toFixed(2)}`,
      );
    }
  }

  const summary: ApplySummary = {
    todoAtStart: todo.length,
    alreadyCached: enumeration.pairs.size - todo.length,
    calls,
    unexpectedCacheHits,
    failures,
    spendUsd,
    remaining: todo.length - i,
    stoppedBy,
  };

  deps.print(
    `preseed [APPLY]: ${summary.stoppedBy === 'complete' ? 'COMPLETE' : `STOPPED (${summary.stoppedBy})`} — ` +
      `${String(summary.calls)} calls ($${summary.spendUsd.toFixed(2)}), ` +
      `${String(summary.unexpectedCacheHits)} unexpected cache hits, ` +
      `${String(summary.failures)} failures, ${String(summary.remaining)} remaining` +
      (summary.remaining > 0 ? ' (re-run --apply to resume)' : ''),
  );
  return summary;
}

// ---- emit-batch (subscription workflow, step 1 — no spend) ------------------

/** Work-order ordering contract stamped into meta (consumers can assert it). */
const EMIT_ORDER = 'reading-first-corpus' as const;

export interface EmitItem {
  readonly hash: string;
  readonly lemma: string;
  readonly sourceSentence: string;
  readonly source: PreseedSource;
  /** Best-effort KRDICT primary gloss (definition_english of the lowest-id
   *  krdict_entries row for the lemma, mirroring /define's first entry).
   *  null when no entry exists or the krdict tables are unavailable. A HINT
   *  for the content generator only — it does NOT affect the cache key. */
  readonly krdictGloss: string | null;
}

export interface EmitBatchFile {
  readonly meta: {
    readonly model: ClaudeModelId;
    readonly order: typeof EMIT_ORDER;
    readonly emitted: number;
    readonly remainingAfter: number;
    readonly ttlDaysDefault: number;
  };
  readonly items: readonly EmitItem[];
}

export interface EmitBatchSummary {
  readonly emitted: number;
  readonly remainingAfter: number;
  readonly outFile: string;
  readonly model: ClaudeModelId;
}

/**
 * Best-effort batched KRDICT primary-gloss lookup (ONE query for the whole
 * batch). Mirrors routes/define.ts: entries match on headword, /define's
 * primary entry is the lowest id (ORDER BY id ASC LIMIT 10 → first row).
 * Any failure (tables absent pre-migration-003, permissions, …) degrades to
 * an empty map — the gloss is a generator hint, never a correctness input.
 */
async function fetchKrdictGlosses(
  pool: Pool,
  lemmas: readonly string[],
  print: (line: string) => void,
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(lemmas)];
  if (unique.length === 0) return new Map();
  try {
    const res = await pool.query<{ headword: string; gloss: string | null }>(
      `SELECT DISTINCT ON (headword) headword, definition_english AS gloss
         FROM krdict_entries
        WHERE headword = ANY($1::text[])
        ORDER BY headword, id ASC`,
      [unique],
    );
    const map = new Map<string, string>();
    for (const row of res.rows) {
      if (row.gloss !== null && row.gloss.trim() !== '') map.set(row.headword, row.gloss);
    }
    return map;
  } catch (err) {
    print(
      `preseed [EMIT]: krdict gloss lookup unavailable ` +
        `(${err instanceof Error ? err.message : String(err)}) — emitting krdictGloss: null`,
    );
    return new Map();
  }
}

/**
 * Write a JSON work-order of the top-priority N uncached pairs to --out.
 * ZERO Claude calls, ZERO cache writes — the file is filled offline (e.g. by
 * a subscription Claude session) and fed back through --ingest.
 */
export async function runEmitBatch(deps: PreseedDeps): Promise<EmitBatchSummary> {
  const { emitBatch, outFile } = deps.opts;
  if (emitBatch === undefined || outFile === undefined) {
    // parseCliArgs guarantees both; direct callers get the same loud failure.
    throw new PreseedInputError('--emit-batch requires a batch size and --out=<file>');
  }
  // Prove --out is writable BEFORE the (long) enumeration + Kiwi pass: an
  // unwritable path is bad input (exit 2, same contract as ingest's --in)
  // and must fail in seconds, not with a raw ENOENT after minutes of work.
  // The placeholder is overwritten with the real work-order below.
  try {
    await writeFile(outFile, '', 'utf8');
  } catch (err) {
    throw new PreseedInputError(
      `cannot write --out "${outFile}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const { todo, model } = await prepare(deps);

  const batch = orderByPriority(todo).slice(0, emitBatch);
  const glosses = await fetchKrdictGlosses(
    deps.pool,
    batch.map((p) => p.lemma),
    deps.print,
  );

  const file: EmitBatchFile = {
    meta: {
      model,
      order: EMIT_ORDER,
      emitted: batch.length,
      remainingAfter: todo.length - batch.length,
      ttlDaysDefault: DEFAULT_INGEST_TTL_DAYS,
    },
    items: batch.map((p) => ({
      hash: p.hash,
      lemma: p.lemma,
      sourceSentence: p.sourceSentence,
      source: p.source,
      krdictGloss: glosses.get(p.lemma) ?? null,
    })),
  };
  try {
    await writeFile(outFile, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  } catch (err) {
    // The pre-flight passed but the volume vanished mid-run — still the
    // bad-input contract (exit 2), never a raw ENOENT stack.
    throw new PreseedInputError(
      `cannot write --out "${outFile}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const summary: EmitBatchSummary = {
    emitted: batch.length,
    remainingAfter: todo.length - batch.length,
    outFile,
    model,
  };
  if (summary.emitted === 0) {
    // Symmetry with ingest: an items:[] work-order is a legal clean no-op.
    deps.print('preseed [EMIT]: nothing to emit — corpus fully cached (work-order written with 0 items)');
  }
  deps.print(
    `preseed [EMIT]: wrote ${String(summary.emitted)} items to ${outFile} ` +
      `(order ${EMIT_ORDER}, model ${model}, ${String(summary.remainingAfter)} uncached ` +
      `pairs remain after this batch). No Claude calls, no cache writes.`,
  );
  return summary;
}

// ---- ingest (subscription workflow, step 2 — no spend) ----------------------

/** Minimal shape of a FILLED work-order. Extra keys (meta echoes, notes) are
 *  ignored; each item's `enrichment` is validated separately against
 *  EnrichmentResultSchema so ONE bad item skips, not aborts. */
const IngestItemSchema = z.object({
  hash: z.string().min(1),
  lemma: z.string().min(1),
  sourceSentence: z.string().min(1),
  // `z.unknown()` alone makes the key OPTIONAL in zod 3 — an UNFILLED
  // work-order (emit output fed straight back, no `enrichment` keys) would
  // parse, every item would then fail enrichment validation, and the run
  // would print "0 written" yet exit 0. A weekly cron would mark that GREEN
  // with zero definitions landed. Require the key to be present.
  enrichment: z.unknown().refine((v) => v !== undefined, {
    message: 'item.enrichment missing — work-order not filled',
  }),
});
const IngestFileSchema = z.object({
  // Empty is legal: emit against a fully-cached corpus writes items: [] and
  // ingesting that back is a clean no-op (exit 0) — see runEmitBatch.
  items: z.array(IngestItemSchema),
  // Optional meta echo (hand-built files may omit it). `model` feeds the
  // model-drift warning below; anything else rides along ignored.
  meta: z.object({ model: z.string().min(1).optional() }).passthrough().optional(),
});

export interface IngestSummary {
  readonly total: number;
  readonly written: number;
  readonly skippedAlreadyCached: number;
  readonly skippedHashDrift: number;
  readonly skippedInvalid: number;
  readonly skippedProxyReject: number;
  readonly ttlDays: number;
}

/** Cap on per-item skip diagnostics so a wholly bad file can't flood stderr. */
const MAX_INVALID_LOGS = 5;

/**
 * Ingest a filled work-order into claude_cache at the exact keys live taps
 * compute. Per item: re-probe the key (proxy-reject → skip), compare the
 * probed hash to the emitted one (corpus drift → skip), skip already-cached
 * hashes (idempotent/resumable), Zod-validate the enrichment (bad content →
 * skip), then write. The FIRST write is round-trip verified (put → get →
 * EnrichmentResultSchema re-parse — the same read routes/enrich.ts performs);
 * failure ABORTS the whole ingest before any further writes, mirroring
 * --validate's guarantee.
 *
 * NOTE: run --validate after any proxy/prompt/model change before trusting a
 * large ingest — the self-check proves store round-trip, not probe↔live-proxy
 * key fidelity.
 */
export async function runIngest(deps: PreseedDeps): Promise<IngestSummary> {
  const { inFile, ttlDays } = deps.opts;
  if (inFile === undefined) {
    throw new PreseedInputError('--ingest requires --in=<file> (or --ingest=<file>)');
  }

  let rawText: string;
  try {
    rawText = await readFile(inFile, 'utf8');
  } catch (err) {
    throw new PreseedInputError(
      `cannot read work-order "${inFile}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawText);
  } catch (err) {
    throw new PreseedInputError(
      `work-order "${inFile}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsedFile = IngestFileSchema.safeParse(rawJson);
  if (!parsedFile.success) {
    throw new PreseedInputError(
      `work-order "${inFile}" does not match the emit-batch shape: ` +
        parsedFile.error.issues
          .slice(0, MAX_INVALID_LOGS)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
    );
  }
  const items = parsedFile.data.items;

  const cfg = loadConfig();
  const ttlSeconds = ttlDays * 86_400;
  // A model-config change between emit and ingest re-keys EVERY hash: without
  // this warning the run would just show 100% hash-drift skips and look like
  // silent corpus drift. WARN loudly so the operator knows why.
  const emitModel = parsedFile.data.meta?.model;
  if (emitModel !== undefined && emitModel !== cfg.modelDefaults.enrich) {
    deps.print(
      `preseed [INGEST]: WARN — work-order meta.model "${sanitizeForLog(emitModel)}" != ` +
        `configured enrich model "${cfg.modelDefaults.enrich}"; every item will ` +
        `hash-drift unless the model config matches the emit-time one`,
    );
  }
  // Idempotency snapshot: hashes already live in claude_cache are skipped.
  const cachedHashes = await fetchCachedEnrichHashes(deps.pool, cfg.modelDefaults.enrich);

  deps.print(
    `preseed [INGEST]: ${String(items.length)} items from ${inFile} ` +
      `(model ${cfg.modelDefaults.enrich}, ttl ${String(ttlDays)} days, ` +
      `${String(cachedHashes.size)} enrich hashes already cached)`,
  );
  if (items.length === 0) {
    deps.print('preseed [INGEST]: work-order has 0 items — nothing to ingest (clean no-op).');
  }

  let written = 0;
  let skippedAlreadyCached = 0;
  let skippedHashDrift = 0;
  let skippedInvalid = 0;
  let skippedProxyReject = 0;
  let invalidLogs = 0;
  let proxyRejectLogs = 0;
  let driftLogs = 0;
  let selfCheckDone = false;

  for (const [i, item] of items.entries()) {
    // Operator-facing item label: 1-based (operators count file items from 1).
    const itemNo = String(i + 1);
    // a. The proxy must accept this pair TODAY — same gate as enumeration.
    const probe = probeEnrichCacheKey(
      buildClientEnrichBody(item.lemma, item.sourceSentence),
      cfg,
    );
    if (probe === null) {
      skippedProxyReject += 1;
      if (proxyRejectLogs < MAX_INVALID_LOGS) {
        proxyRejectLogs += 1;
        deps.print(
          `preseed [INGEST]: item ${itemNo} (lemma="${sanitizeForLog(item.lemma)}") ` +
            `proxy-rejectable (over-length sentence or injection marker) — skipped ` +
            `(hash ${sanitizeForLog(item.hash, 16)})`,
        );
      }
      continue;
    }
    // b. Emit-time hash must still be the live hash (guards corpus/prompt
    //    drift between emit and ingest — a drifted row would never be read).
    if (probe.hash !== item.hash) {
      skippedHashDrift += 1;
      if (driftLogs < MAX_INVALID_LOGS) {
        driftLogs += 1;
        deps.print(
          `preseed [INGEST]: item ${itemNo} (lemma="${sanitizeForLog(item.lemma)}") hash drift — ` +
            `emitted ${sanitizeForLog(item.hash, 16)} vs live ${probe.hash.slice(0, 16)}… — skipped`,
        );
      }
      continue;
    }
    // c. Idempotent/resumable — and duplicate items within one file collapse.
    if (cachedHashes.has(probe.hash)) {
      skippedAlreadyCached += 1;
      continue;
    }
    // d. The generated content must match what the app schema-validates on
    //    cache read-back (services/claude/index.ts safeParse on hit).
    const parsed = EnrichmentResultSchema.safeParse(item.enrichment);
    if (!parsed.success) {
      skippedInvalid += 1;
      if (invalidLogs < MAX_INVALID_LOGS) {
        invalidLogs += 1;
        deps.print(
          `preseed [INGEST]: item ${itemNo} (lemma="${sanitizeForLog(item.lemma)}") enrichment invalid — ` +
            parsed.error.issues
              .slice(0, 3)
              .map((iss) => `${iss.path.join('.')}: ${iss.message}`)
              .join('; '),
        );
      }
      continue;
    }
    const enrichment: EnrichmentResult = parsed.data;

    await deps.cacheStore.put(probe.key, enrichment, ttlSeconds);

    if (!selfCheckDone) {
      // e. SELF-VALIDATION GATE on the first written item: the row must read
      //    back at the SAME key and re-validate, exactly as a live cache hit
      //    does. Otherwise every further write would be unreadable — abort.
      const back = await deps.cacheStore.get(probe.key);
      const reparsed = back === null ? null : EnrichmentResultSchema.safeParse(back.response);
      if (reparsed === null || !reparsed.success) {
        throw new PreseedSelfCheckError(
          'ingest self-validation FAILED on the first written item — put→get round-trip ' +
            `${back === null ? 'returned no row' : 'failed schema re-validation'}; ` +
            'aborting before any further writes (check TTL, store wiring, and model identity). ' +
            `The lingering bad row is at prompt_hash ${probe.hash} — clean it up manually.`,
        );
      }
      selfCheckDone = true;
      deps.print('preseed [INGEST]: self-validation PASS (first row read back and re-validated)');
    }

    written += 1;
    cachedHashes.add(probe.hash);
  }

  // A run that skipped EVERYTHING — and not because it was already cached —
  // is an unfilled or wholly-invalid work-order. Exiting 0 here would let a
  // weekly cron mark GREEN with zero definitions landed, which is exactly the
  // failure this tool exists to prevent. All-already-cached re-runs (the
  // legit resume/no-op case) still exit 0.
  if (items.length > 0 && written === 0 && skippedAlreadyCached === 0) {
    throw new PreseedInputError(
      `work-order "${inFile}" appears unfilled or wholly invalid — 0 written ` +
        `(${String(skippedInvalid)} invalid enrichment, ${String(skippedHashDrift)} hash drift, ` +
        `${String(skippedProxyReject)} proxy-rejectable)`,
    );
  }

  const summary: IngestSummary = {
    total: items.length,
    written,
    skippedAlreadyCached,
    skippedHashDrift,
    skippedInvalid,
    skippedProxyReject,
    ttlDays,
  };
  deps.print(
    `preseed [INGEST]: COMPLETE — ${String(written)} written, ` +
      `${String(skippedAlreadyCached)} already cached, ` +
      `${String(skippedHashDrift)} hash drift, ` +
      `${String(skippedInvalid)} invalid enrichment, ` +
      `${String(skippedProxyReject)} proxy-rejectable ` +
      `(ttl ${String(ttlDays)} days)`,
  );
  return summary;
}

// ---- CLI entry -------------------------------------------------------------

async function main(): Promise<void> {
  const log = getLogger();
  const opts = parseCliArgs(process.argv.slice(2));
  const pool = getPool();
  // eslint-disable-next-line no-console
  const print = (line: string): void => console.error(line);
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const deps: PreseedDeps = {
    pool,
    // The REAL proxy — the whole point (see the header's identity constraint).
    proxy: createClaudeProxy({ pool }),
    lemmatize: makeKiwiLemmatizer(`preseed-${randomUUID()}`),
    opts,
    // The production store — ingest writes land in the same claude_cache the
    // live proxy reads (same hashCacheKey, same upsert).
    cacheStore: new PostgresCacheStore(pool, log),
    print,
    sleep,
  };

  if (opts.mode === 'count') {
    const s = await runCount(deps);
    log.info(
      {
        mode: 'count',
        sources: opts.sources,
        uniquePairs: s.uniquePairs,
        alreadyCached: s.alreadyCached,
        callsNeeded: s.estimate.callsNeeded,
        estCostUsd: s.estimate.estCostUsd,
      },
      'preseed-definitions: count complete',
    );
  } else if (opts.mode === 'validate') {
    const s = await runValidate(deps);
    log.info(
      { mode: 'validate', passed: s.passed, path: s.path, spendUsd: s.spendUsd },
      'preseed-definitions: validate complete',
    );
    if (!s.passed) {
      throw new Error('validate proof FAILED — see report above');
    }
  } else if (opts.mode === 'emit-batch') {
    const s = await runEmitBatch(deps);
    log.info(
      {
        mode: 'emit-batch',
        sources: opts.sources,
        emitted: s.emitted,
        remainingAfter: s.remainingAfter,
        outFile: s.outFile,
        model: s.model,
      },
      'preseed-definitions: emit-batch complete',
    );
  } else if (opts.mode === 'ingest') {
    const s = await runIngest(deps);
    log.info(
      {
        mode: 'ingest',
        inFile: opts.inFile,
        total: s.total,
        written: s.written,
        skippedAlreadyCached: s.skippedAlreadyCached,
        skippedHashDrift: s.skippedHashDrift,
        skippedInvalid: s.skippedInvalid,
        skippedProxyReject: s.skippedProxyReject,
        ttlDays: s.ttlDays,
      },
      'preseed-definitions: ingest complete',
    );
  } else {
    const s = await runApply(deps);
    log.info(
      {
        mode: 'apply',
        calls: s.calls,
        spendUsd: s.spendUsd,
        failures: s.failures,
        remaining: s.remaining,
        stoppedBy: s.stoppedBy,
      },
      'preseed-definitions: apply complete',
    );
  }
}

// Run only when invoked directly as a CLI, NOT when imported — importing this
// file must never execute DB/network I/O. Mirrors seed-user.ts/share-corpus.ts.
if (require.main === module) {
  main()
    .then(async () => {
      await closePool();
      process.exit(0);
    })
    .catch(async (err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`preseed-definitions: FAILED — ${(err as Error).message}`);
      await closePool().catch(() => undefined);
      process.exit(exitCodeFor(err));
    });
}
