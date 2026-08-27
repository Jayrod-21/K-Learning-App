/**
 * synthesize-listening-audio CLI — F-220 slice 3: the METERED, OPERATOR-RUN
 * audio step for generated LISTENING items.
 *
 * WHY A SEPARATE TOOL FROM generate-item-bank.ts
 * generate-item-bank.ts's `--emit-batch`/`--ingest` pair is the F-209
 * emit->fill->ingest pattern: $0, subscription-Claude-driven, no network call
 * this repo's own process ever makes. Turning a listening item's dialogue
 * script into AUDIO is a fundamentally different kind of call — a metered
 * ElevenLabs API request that costs real money per character synthesized —
 * so it gets its OWN tool with its OWN explicit `--synth` flag, run by an
 * operator who has reviewed the `--dry-run`/`--count` estimate first. This is
 * the split the F-220 slice-3 brief locks: script authoring is $0 and can run
 * in any build/CI context; audio synthesis is deliberate, operator-triggered
 * spend, exactly like `scripts/share-corpus.ts`'s dry-run-by-default posture
 * (and unlike it, this tool actually spends money on `--synth`, so nothing
 * here EVER runs implicitly — see `require.main === module` at the bottom).
 *
 * REUSE, NOT REIMPLEMENTATION — the synth CORE
 * Turning `turns` into ONE mp3 is byte-for-byte the SAME work
 * `services/storyAudio.ts`'s multi-voice v2 path already does for generated
 * stories: {@link synthesizeMultiVoice} (per-turn `getTtsProvider().synthesize`
 * with `assignVoices`-assigned voices, ffprobe per-part durations, one
 * `getMp3Concat().concatMp3` join). This script imports and calls that EXACT
 * exported function — it does NOT reimplement synthesis, and it does NOT
 * touch `story_audio_jobs` or the in-server polling runner at all (this is a
 * one-shot CLI, not a queue — there is no "listening_audio_jobs" table by
 * design, per RECON_slice3.md's "smallest scope" call: no job-runner, no
 * live per-user trigger).
 *
 * STORAGE — SHARED, SYSTEM-OWNED (mirrors share-corpus.ts's owner mechanism)
 * A listening item's audio is APP-OWNED reference content (like the item
 * itself, `generated_items` has no `user_id`) — every learner served this
 * item hears the SAME blob. It is stored exactly like every other audio
 * asset — one `audio_sources` row (kind = 'generated_listening') + one
 * `audio_tracks` row (the mp3, offsets [0, fullDuration] — one blob per item,
 * no sub-window) — under the SAME curated-corpus owner account
 * `share-corpus.ts` already uses (`DEFAULT_OWNER_EMAIL`, imported from that
 * module rather than duplicated), with `is_shared = true` set AT CREATION
 * (not flipped later by a cutover script — this tool IS the writer, so there
 * is no "existing private row to later share" step the way share-corpus.ts's
 * one-time migration has). `is_shared = true` is what lets
 * `GET /audio/tracks/:id/stream` serve the blob to every learner regardless
 * of who is logged in (routes/audio.ts's `OR audio_sources.is_shared = true`
 * clause, F-207) — no client change, no new streaming surface.
 *
 * SPEND GATE + LEDGER
 * Per item, BEFORE synthesizing: `assertUnderSpendCeiling()` (the SAME global
 * daily circuit breaker every other metered route uses) and the `--max-cost`
 * per-RUN budget (if given) — either one stops the run for later items,
 * cleanly, mid-batch; nothing already written is undone. On success, the
 * SAME UPDATE that sets `generated_items.audio_source_id` also sets
 * `audio_cost_estimate_usd` (char_count / 1000 * ELEVENLABS_USD_PER_1K_CHARS,
 * `services/storyAudio.ts`'s exact formula) and `audio_synthesized_at`
 * (`now()`) — the settle-only contract `services/spendCeiling.ts`'s 4th sum
 * source relies on (migration 103's design note).
 *
 * $0 IN THE BUILD — the hard constraint
 * `--count`/`--dry-run` NEVER call the TTS provider (pure char-count math over
 * `turns`, ZERO synth, ZERO spend) and this file is NEVER imported/invoked by
 * any build step, test, or the live server — every test that exercises
 * `--synth` injects a mock `TtsProvider`/`Mp3ConcatHelper` (`setTtsProvider`/
 * `setMp3Concat`, tts.ts/audioConcat.ts's existing test-injection points), so
 * the build itself never dials ElevenLabs. Real synthesis happens ONLY when
 * an operator runs `--synth` by hand against a live deploy with
 * ELEVENLABS_API_KEY configured.
 *
 * FAILS LOUDLY WHEN TTS IS UNCONFIGURED
 * With no ELEVENLABS_API_KEY, `getTtsProvider()` returns
 * `UnconfiguredTtsProvider` (tts.ts) and every `synthesizeMultiVoice` call
 * rejects with `TtsNotConfiguredError` — this script catches that PER ITEM,
 * prints a loud, item-identified failure line, counts it as a failure, and
 * moves on (never silently skips, never writes a partial/bad row). A run
 * that fails every item this way exits non-zero (`exitCodeFor`) — it can
 * never look green.
 *
 * IDEMPOTENT
 * The backlog query (`section = 'listening' AND audio_source_id IS NULL AND
 * turns IS NOT NULL`) naturally excludes any item this tool has already
 * synthesized (its `audio_source_id` is no longer NULL) — re-running finds
 * fewer items each time, converging to zero, exactly like
 * generate-item-bank.ts's `ON CONFLICT DO NOTHING` idempotency but via the
 * WHERE clause instead (there is no unique-constraint race to arbitrate: one
 * synth run per item, guarded by a status-checked UPDATE at persist time).
 *
 * F-220 P1 — PAIRED-AUDIO groups (`generated_items.stimulus_group_id`,
 * migration 105): several rows sharing one group id carry the SAME `turns`
 * (one shared dialogue) and must get the SAME synthesized audio, billed
 * ONCE — never once per row. `fetchBacklog` enumerates ONE representative
 * row per group (the `stimulus_group_ordinal = 1` row); `runSynth` then
 * UPDATEs `audio_source_id`/offsets/`audio_synthesized_at` onto EVERY row
 * sharing that `stimulus_group_id` in the SAME transaction, but sets
 * `audio_cost_estimate_usd` ONLY on the ordinal=1 row — so
 * `services/spendCeiling.ts`'s `SUM(audio_cost_estimate_usd)` sees the
 * group's spend exactly once, not multiplied by its question count. The
 * pre-existing single-item path (`kind = 'audio-mc'`, no group) is
 * completely unchanged.
 *
 * Exit codes: 0 ok (including "0 items in backlog" — a clean no-op) · 1
 * failure (a bad flag, or every attempted item failed) · 2 bad input.
 *
 * Run inside the ACTIVE color's server container, e.g.:
 *   docker exec km-server-<active> node dist/scripts/synthesize-listening-audio.js --count
 *   docker exec km-server-<active> node dist/scripts/synthesize-listening-audio.js \
 *     --synth --limit=20 --max-cost=5.00
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { closePool, query, withTransaction } from '../db/pool.js';
import { getLogger } from '../logging.js';
import { loadConfig } from '../config/index.js';
import { SpendCeilingExceededError } from '../middleware/errors.js';
import { assertUnderSpendCeiling } from '../services/spendCeiling.js';
import { saveBlob, deleteBlob } from '../services/audioStore.js';
import { synthesizeMultiVoice } from '../services/storyAudio.js';
import { TtsNotConfiguredError, TtsUpstreamError } from '../services/tts.js';
import { DEFAULT_OWNER_EMAIL } from './share-corpus.js';

// ---- CLI contract -----------------------------------------------------------

export type SynthesizeMode = 'count' | 'synth';

export interface SynthesizeOptions {
  readonly mode: SynthesizeMode;
  /** --synth only: cap the number of items this run processes. Undefined =
   *  unbounded (process the whole backlog, subject to the spend gates). */
  readonly limit: number | undefined;
  /** --synth only: cap this RUN's total spend in USD (a per-invocation
   *  budget, distinct from the global daily SPEND_CEILING_DAILY_USD — an
   *  operator can run several bounded batches across a day without touching
   *  the global ceiling knob). Undefined = no per-run cap. */
  readonly maxCostUsd: number | undefined;
}

/** Bad CLI input → exit 2 (mirrors generate-item-bank.ts's ItemBankInputError). */
export class SynthesizeListeningAudioInputError extends Error {}

export function exitCodeFor(err: unknown): 1 | 2 {
  return err instanceof SynthesizeListeningAudioInputError ? 2 : 1;
}

function parsePositiveInt(arg: string, flag: string): number {
  const raw = arg.slice(flag.length + 1);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new SynthesizeListeningAudioInputError(`${flag} must be a positive integer, got "${raw}"`);
  }
  return n;
}

function parsePositiveFloat(arg: string, flag: string): number {
  const raw = arg.slice(flag.length + 1);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new SynthesizeListeningAudioInputError(`${flag} must be a positive number, got "${raw}"`);
  }
  return n;
}

/** Parse `process.argv.slice(2)`. Strict: unknown flags fail loudly (exit 2),
 *  mirrors generate-item-bank.ts's parseCliArgs. `--limit`/`--max-cost` only
 *  apply to `--synth`. Default mode (no flag) is `count` — the SAME
 *  never-spend-by-accident default posture as generate-item-bank.ts's
 *  `--count`. */
export function parseCliArgs(argv: readonly string[]): SynthesizeOptions {
  let mode: SynthesizeMode | null = null;
  let limit: number | undefined;
  let maxCostUsd: number | undefined;

  for (const arg of argv) {
    if (arg === '--count' || arg === '--dry-run') {
      if (mode !== null && mode !== 'count') {
        throw new SynthesizeListeningAudioInputError(`conflicting modes: --${mode} and --count`);
      }
      mode = 'count';
    } else if (arg === '--synth') {
      if (mode !== null && mode !== 'synth') {
        throw new SynthesizeListeningAudioInputError(`conflicting modes: --${mode} and --synth`);
      }
      mode = 'synth';
    } else if (arg.startsWith('--limit=')) {
      if (limit !== undefined) throw new SynthesizeListeningAudioInputError('--limit given more than once');
      limit = parsePositiveInt(arg, '--limit');
    } else if (arg.startsWith('--max-cost=')) {
      if (maxCostUsd !== undefined) {
        throw new SynthesizeListeningAudioInputError('--max-cost given more than once');
      }
      maxCostUsd = parsePositiveFloat(arg, '--max-cost');
    } else {
      throw new SynthesizeListeningAudioInputError(`unknown argument "${arg}"`);
    }
  }

  const resolvedMode: SynthesizeMode = mode ?? 'count';
  if (resolvedMode === 'count' && (limit !== undefined || maxCostUsd !== undefined)) {
    throw new SynthesizeListeningAudioInputError(
      '--limit/--max-cost only apply to --synth',
    );
  }

  return { mode: resolvedMode, limit, maxCostUsd };
}

// ---- Backlog enumeration -----------------------------------------------------

/** A loose, defensive shape for reading BACK a stored `turns` JSONB value —
 *  NOT the generation schema (DiagnosticListeningItemResultSchema's turns
 *  array lives in services/claude/models.ts and is what WROTE this column;
 *  this is just "enough to synthesize/count", tolerant of a hand-edited row)
 *  so a malformed turns value fails this parse (loud skip) rather than
 *  crashing the whole run. */
const StoredTurnSchema = z.object({
  speaker: z.string().min(1),
  gender: z.enum(['male', 'female', 'narrator']),
  text: z.string().min(1),
});
const StoredTurnsSchema = z.array(StoredTurnSchema).min(1);

export interface BacklogItem {
  readonly id: number;
  readonly level: string;
  /** Raw JSONB — validated by `parseStoredTurns` before use. */
  readonly turns: unknown;
  /** F-220 P1: non-null for a paired-audio GROUP's ordinal-1 (representative)
   *  row — the id whose SIBLINGS (every row sharing this `stimulus_group_id`,
   *  migration 105) must all be stamped with the SAME synthesized audio in
   *  one pass. Null for a standalone single listening item (kind='audio-mc',
   *  no group). See `runSynth`'s branch on this field. */
  readonly stimulusGroupId: string | null;
}

/** Sum of every turn's Korean text length — the ElevenLabs billing unit
 *  (character count), mirrors storyAudio.ts's `actualCharCount` accounting. */
export function parseStoredTurns(raw: unknown): z.infer<typeof StoredTurnsSchema> | null {
  const parsed = StoredTurnsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function charCountOf(turns: readonly { readonly text: string }[]): number {
  return turns.reduce((sum, t) => sum + t.text.length, 0);
}

/** The exact backlog predicate the brief specifies: an authored listening
 *  item (turns present) with no audio yet. No status filter — a draft OR an
 *  already-approved-but-silent row both need audio; the draw path
 *  (`pickGeneratedItem`/`pickGeneratedStimulusGroup`) separately requires
 *  `status = 'approved'` before ever serving it, regardless of audio
 *  readiness.
 *
 * F-220 P1 — PAIRED-AUDIO groups: a paired-listening group (migration 105)
 * is several `generated_items` rows (kind='paired-audio-mc') sharing ONE
 * `stimulus_group_id` and the SAME `turns` (denormalized onto every row at
 * ingest — see generate-item-bank.ts). Synthesizing per-ROW here would (a)
 * pay for and store the SAME dialogue audio 2-3x per group, and (b) give
 * each question its own distinct clip instead of one shared recording — both
 * wrong. So this backlog is a UNION of two disjoint queries:
 *   (1) standalone items: kind='audio-mc', stimulus_group_id IS NULL — the
 *       pre-P1 shape, completely unchanged, one row = one synth.
 *   (2) paired GROUPS: kind='paired-audio-mc', stimulus_group_id IS NOT
 *       NULL, stimulus_group_ordinal = 1 — exactly ONE representative row
 *       per group (its `turns` is identical to every sibling row's, by
 *       construction), carrying `stimulus_group_id` so `runSynth` can stamp
 *       the resulting audio onto every row in the group afterward.
 * `stimulus_group_id IS NULL` in query (1) is the critical exclusion: without
 * it, every paired row would ALSO match the old single-item shape and get
 * synthesized (and billed) individually, defeating the whole "one shared
 * clip per group" point of P1.
 */
async function fetchBacklog(limit: number | undefined): Promise<BacklogItem[]> {
  const { rows } = await query<{
    id: string;
    level: string;
    turns: unknown;
    stimulus_group_id: string | null;
  }>(
    `(SELECT id, level, turns, NULL::text AS stimulus_group_id
        FROM generated_items
       WHERE section = 'listening'
         AND kind = 'audio-mc'
         AND stimulus_group_id IS NULL
         AND audio_source_id IS NULL
         AND turns IS NOT NULL)
     UNION ALL
     (SELECT id, level, turns, stimulus_group_id
        FROM generated_items
       WHERE section = 'listening'
         AND kind = 'paired-audio-mc'
         AND stimulus_group_id IS NOT NULL
         AND stimulus_group_ordinal = 1
         AND audio_source_id IS NULL
         AND turns IS NOT NULL)
     ORDER BY id
     ${limit !== undefined ? 'LIMIT $1' : ''}`,
    limit !== undefined ? [limit] : [],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    level: r.level,
    turns: r.turns,
    stimulusGroupId: r.stimulus_group_id,
  }));
}

// ---- count / dry-run (ZERO synth, ZERO spend) -------------------------------

export interface CountSummary {
  readonly backlogCount: number;
  readonly totalCharCount: number;
  readonly estimatedCostUsd: number;
  readonly unparseableCount: number;
}

export async function runCount(print: (line: string) => void): Promise<CountSummary> {
  const cfg = loadConfig();
  const backlog = await fetchBacklog(undefined);

  let totalCharCount = 0;
  let unparseableCount = 0;
  for (const item of backlog) {
    const turns = parseStoredTurns(item.turns);
    if (turns === null) {
      unparseableCount += 1;
      print(
        `synthesize-listening-audio [COUNT]: item ${String(item.id)} has unparseable turns — ` +
          `excluded from the estimate (would be skipped, not synthesized, by --synth)`,
      );
      continue;
    }
    totalCharCount += charCountOf(turns);
  }
  const estimatedCostUsd = (totalCharCount / 1000) * cfg.ELEVENLABS_USD_PER_1K_CHARS;

  print(
    `synthesize-listening-audio [COUNT]: ${String(backlog.length)} listening item(s) need audio ` +
      `(${String(unparseableCount)} unparseable) — ${String(totalCharCount)} total chars, ` +
      `estimated cost $${estimatedCostUsd.toFixed(4)} at $${String(cfg.ELEVENLABS_USD_PER_1K_CHARS)}/1k chars. ` +
      `ZERO synth calls, ZERO spend.`,
  );
  return { backlogCount: backlog.length, totalCharCount, estimatedCostUsd, unparseableCount };
}

// ---- synth (METERED — real ElevenLabs spend) --------------------------------

export interface SynthSummary {
  readonly attempted: number;
  readonly synthesized: number;
  readonly failed: number;
  readonly skippedUnparseable: number;
  readonly stoppedEarly: 'spend-ceiling' | 'max-cost' | null;
  readonly totalCostUsd: number;
}

/** Resolve the shared, system/curated-corpus owner (mirrors
 *  share-corpus.ts's `runShareCorpus` owner lookup — the SAME account, so an
 *  operator who already ran share-corpus.ts's cutover sees this tool's
 *  synthesized listening audio land under the identical owner as every
 *  other shared set). Bad/missing owner → exit 2 (bad input, not a runtime
 *  failure — the operator must seed that account first). */
async function resolveSystemOwnerId(): Promise<number> {
  const { rows } = await query<{ id: number }>('SELECT id FROM users WHERE email = $1', [
    DEFAULT_OWNER_EMAIL,
  ]);
  const row = rows[0];
  if (row === undefined) {
    throw new SynthesizeListeningAudioInputError(
      `no user with email ${DEFAULT_OWNER_EMAIL} (the system/curated-corpus owner) — ` +
        `seed that account first; nothing was synthesized`,
    );
  }
  return Number(row.id);
}

/** Bounded, whitelisted failure text — mirrors storyAudio.ts's
 *  `failureMessage`: TTS-layer errors carry OUR own server-authored messages
 *  (never provider response text), so they pass through; anything else gets
 *  a generic line (full detail stays server-side in the log call site). */
function failureMessage(err: unknown): string {
  if (err instanceof TtsNotConfiguredError || err instanceof TtsUpstreamError) {
    return err.message.slice(0, 2000);
  }
  return err instanceof Error ? err.message.slice(0, 2000) : 'synthesis failed unexpectedly';
}

export async function runSynth(
  opts: SynthesizeOptions,
  print: (line: string) => void,
): Promise<SynthSummary> {
  const cfg = loadConfig();
  const log = getLogger();
  const systemOwnerId = await resolveSystemOwnerId();
  const backlog = await fetchBacklog(opts.limit);

  print(
    `synthesize-listening-audio [SYNTH]: ${String(backlog.length)} item(s) queued ` +
      `(owner id=${String(systemOwnerId)}${opts.maxCostUsd !== undefined ? `, run cap $${String(opts.maxCostUsd)}` : ''}).`,
  );

  let attempted = 0;
  let synthesized = 0;
  let failed = 0;
  let skippedUnparseable = 0;
  let totalCostUsd = 0;
  let stoppedEarly: SynthSummary['stoppedEarly'] = null;

  for (const item of backlog) {
    const turns = parseStoredTurns(item.turns);
    if (turns === null) {
      skippedUnparseable += 1;
      print(
        `synthesize-listening-audio [SYNTH]: item ${String(item.id)} has unparseable turns — ` +
          `skipped (no row written)`,
      );
      continue;
    }
    const charCount = charCountOf(turns);
    const estimatedCost = (charCount / 1000) * cfg.ELEVENLABS_USD_PER_1K_CHARS;

    // Per-run budget, checked BEFORE spend (mirrors the global ceiling's
    // before-spend posture) — a graceful stop, not a failure: whatever
    // already synthesized in this run stays written.
    if (opts.maxCostUsd !== undefined && totalCostUsd + estimatedCost > opts.maxCostUsd) {
      print(
        `synthesize-listening-audio [SYNTH]: stopping — item ${String(item.id)}'s estimated ` +
          `$${estimatedCost.toFixed(4)} would exceed the run cap ($${String(opts.maxCostUsd)}, ` +
          `$${totalCostUsd.toFixed(4)} spent so far)`,
      );
      stoppedEarly = 'max-cost';
      break;
    }

    // The SAME global daily circuit breaker every other metered route uses.
    // A refusal here stops the WHOLE run (later items would refuse too) —
    // graceful, not a failure.
    try {
      await assertUnderSpendCeiling();
    } catch (err) {
      if (err instanceof SpendCeilingExceededError) {
        print(
          `synthesize-listening-audio [SYNTH]: stopping — global daily spend ceiling reached ` +
            `before item ${String(item.id)}`,
        );
        stoppedEarly = 'spend-ceiling';
        break;
      }
      throw err;
    }

    attempted += 1;
    let blobRef: string | null = null;
    try {
      // THE SYNTH CORE — reused verbatim from storyAudio.ts, no
      // story_audio_jobs coupling (see the module header).
      const result = await synthesizeMultiVoice(turns, cfg.ELEVENLABS_VOICE_ID, log, item.id);
      const durationMs = result.durationMs ?? 0;

      blobRef = await saveBlob(systemOwnerId, randomUUID(), 'mp3', result.audio);

      const settled = await withTransaction(async (client) => {
        const src = await client.query<{ id: number }>(
          `INSERT INTO audio_sources (user_id, slug, title, kind, status, is_shared)
           VALUES ($1, $2, $3, 'generated_listening', 'ready', true)
           RETURNING id`,
          [systemOwnerId, `generated-listening-${String(item.id)}`, `Generated listening item ${String(item.id)}`],
        );
        const sourceId = src.rows[0]!.id;

        await client.query(
          `INSERT INTO audio_tracks
             (source_id, user_id, track_number, title, blob_ref, byte_size, duration_ms,
              transcript_status)
           VALUES ($1, $2, 1, $3, $4, $5, $6, 'done')`,
          [
            sourceId,
            systemOwnerId,
            `Generated listening item ${String(item.id)}`,
            blobRef,
            result.audio.length,
            durationMs,
          ],
        );

        if (item.stimulusGroupId === null) {
          // Standalone single item — the pre-P1 shape, unchanged.
          // Status-guarded (audio_source_id IS NULL): if a concurrent run
          // already synthesized this item since fetchBacklog snapshotted it,
          // this UPDATE affects 0 rows — the caller below rolls back rather
          // than leaving a second, orphaned audio_sources row referenced by
          // nothing.
          const upd = await client.query(
            `UPDATE generated_items
                SET audio_source_id = $2, audio_start_ms = 0, audio_end_ms = $3,
                    audio_cost_estimate_usd = $4, audio_synthesized_at = now()
              WHERE id = $1 AND audio_source_id IS NULL`,
            [item.id, sourceId, durationMs, estimatedCost],
          );
          if (upd.rowCount === 0) {
            throw new Error(
              `item ${String(item.id)} was synthesized by a concurrent run — discarding this result`,
            );
          }
          return true;
        }

        // F-220 P1 — paired-audio GROUP: stamp the SAME audio_source_id/
        // offsets/timestamp onto EVERY row sharing this stimulus_group_id
        // (status-guarded exactly like the single-item branch — a concurrent
        // run that already synthesized the group makes this UPDATE affect 0
        // rows and the whole transaction rolls back). The COST is charged
        // ONCE: only the ordinal=1 row (this group's `item.id`, by
        // `fetchBacklog`'s query) gets `audio_cost_estimate_usd` set — every
        // other row in the group keeps it NULL — so
        // `services/spendCeiling.ts`'s `SUM(audio_cost_estimate_usd)` never
        // double- or triple-counts one group's single shared synthesis (see
        // migration 105's up header + this file's module doc).
        const updGroup = await client.query(
          `UPDATE generated_items
              SET audio_source_id = $2, audio_start_ms = 0, audio_end_ms = $3,
                  audio_synthesized_at = now()
            WHERE stimulus_group_id = $1 AND audio_source_id IS NULL`,
          [item.stimulusGroupId, sourceId, durationMs],
        );
        if (updGroup.rowCount === 0) {
          throw new Error(
            `group ${item.stimulusGroupId} was synthesized by a concurrent run — discarding this result`,
          );
        }
        const updCost = await client.query(
          `UPDATE generated_items
              SET audio_cost_estimate_usd = $2
            WHERE stimulus_group_id = $1 AND stimulus_group_ordinal = 1`,
          [item.stimulusGroupId, estimatedCost],
        );
        if (updCost.rowCount === 0) {
          throw new Error(
            `group ${item.stimulusGroupId} has no ordinal=1 row to charge the shared synthesis cost to`,
          );
        }
        return true;
      });
      if (settled) {
        synthesized += 1;
        totalCostUsd += estimatedCost;
        print(
          `synthesize-listening-audio [SYNTH]: item ${String(item.id)}` +
            `${item.stimulusGroupId !== null ? ` (group ${item.stimulusGroupId})` : ''} done — ` +
            `${String(charCount)} chars, ${String(durationMs)}ms, $${estimatedCost.toFixed(4)}`,
        );
      }
    } catch (err) {
      // Persist failed (or the concurrent-run race above) — clean up an
      // orphaned blob best-effort; a cleanup failure must never mask the
      // real error (mirrors storyAudio.ts's exact posture).
      if (blobRef !== null) {
        try {
          await deleteBlob(blobRef);
        } catch (cleanupErr) {
          log.warn(
            { itemId: item.id, blobRef, err: String(cleanupErr) },
            'synthesize-listening-audio: failed to delete blob after a failed persist (orphaned, non-fatal)',
          );
        }
      }
      failed += 1;
      const message = failureMessage(err);
      log.error({ itemId: item.id, err: String(err) }, 'synthesize-listening-audio: item failed');
      print(`synthesize-listening-audio [SYNTH]: item ${String(item.id)} FAILED — ${message}`);
    }
  }

  print(
    `synthesize-listening-audio [SYNTH]: COMPLETE — ${String(synthesized)}/${String(attempted)} synthesized, ` +
      `${String(failed)} failed, ${String(skippedUnparseable)} unparseable, ` +
      `$${totalCostUsd.toFixed(4)} spent${stoppedEarly !== null ? ` (stopped early: ${stoppedEarly})` : ''}.`,
  );

  return { attempted, synthesized, failed, skippedUnparseable, stoppedEarly, totalCostUsd };
}

// ---- CLI entry ---------------------------------------------------------------

async function main(): Promise<void> {
  const log = getLogger();
  const opts = parseCliArgs(process.argv.slice(2));
  // eslint-disable-next-line no-console
  const print = (line: string): void => console.error(line);

  if (opts.mode === 'count') {
    const s = await runCount(print);
    log.info(
      { mode: 'count', backlogCount: s.backlogCount, estimatedCostUsd: s.estimatedCostUsd },
      'synthesize-listening-audio: count complete',
    );
  } else {
    const s = await runSynth(opts, print);
    log.info(
      {
        mode: 'synth',
        attempted: s.attempted,
        synthesized: s.synthesized,
        failed: s.failed,
        skippedUnparseable: s.skippedUnparseable,
        stoppedEarly: s.stoppedEarly,
        totalCostUsd: s.totalCostUsd,
      },
      'synthesize-listening-audio: synth complete',
    );
    // A run that attempted at least one item and synthesized NONE of them is
    // a failed run — must never exit green (mirrors generate-item-bank.ts's
    // "unfilled work-order" guard).
    if (s.attempted > 0 && s.synthesized === 0) {
      throw new Error(
        `every attempted item failed (${String(s.failed)}/${String(s.attempted)}) — see the FAILED lines above`,
      );
    }
  }
}

// Run only when invoked directly as a CLI, NOT when imported — importing this
// file must never execute DB/network I/O or spend money. Mirrors
// generate-item-bank.ts / share-corpus.ts.
if (require.main === module) {
  main()
    .then(async () => {
      await closePool();
      process.exit(0);
    })
    .catch(async (err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`synthesize-listening-audio: FAILED — ${(err as Error).message}`);
      await closePool().catch(() => undefined);
      process.exit(exitCodeFor(err));
    });
}
