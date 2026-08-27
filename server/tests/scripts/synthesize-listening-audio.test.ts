/**
 * Integration tests for the F-220 slice 3 METERED audio-synth CLI
 * (src/scripts/synthesize-listening-audio.ts).
 *
 * Real Postgres via testcontainers (full migration chain, including
 * migration 103's generated_items audio columns/FK), a throwaway blob-store
 * temp dir (mirrors storyAudio.test.ts), and INJECTED TtsProvider/
 * Mp3ConcatHelper mocks — this file NEVER dials a real ElevenLabs endpoint or
 * shells out to ffmpeg/ffprobe, proving the build-time $0 guarantee for the
 * synth step exactly the way storyAudio.test.ts proves it for story audio.
 *
 * Coverage:
 *   - THE $0-IN-TESTS GUARANTEE: every `--synth` test injects a mock
 *     TtsProvider/Mp3ConcatHelper (never a real network call).
 *   - parseCliArgs: count is the default; --limit/--max-cost only apply to
 *     --synth; conflicting modes / unknown flags throw (exit 2).
 *   - runCount: ZERO synth calls, char-count + cost estimate math, an
 *     unparseable-turns row is excluded from the estimate.
 *   - runSynth happy path: assignVoices-driven per-turn synthesis, ONE
 *     concatenated blob on disk, ONE audio_sources (kind='generated_listening',
 *     owner = the SAME share-corpus.ts owner account, is_shared=true) + ONE
 *     audio_tracks row, generated_items settled with audio_source_id/
 *     audio_start_ms=0/audio_end_ms/audio_cost_estimate_usd/
 *     audio_synthesized_at all in the SAME UPDATE.
 *   - idempotent: a re-run after a successful synth finds an empty backlog.
 *   - --limit caps how many items a run processes.
 *   - --max-cost stops a run before exceeding the per-run budget (graceful,
 *     not a failure).
 *   - the global spend ceiling stops a run before any spend (graceful, not a
 *     failure) when hit before the first item.
 *   - TTS unconfigured -> every item FAILS LOUDLY (no partial/bad row
 *     written), and a run where every attempted item failed exits non-zero.
 *   - a malformed/unparseable turns value is skipped (no row written, no
 *     crash) while other items in the same run still succeed.
 *   - missing system-owner account -> SynthesizeListeningAudioInputError
 *     (exit 2), nothing written.
 */
import os from 'node:os';
import path from 'node:path';
import { readdir, readFile, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import {
  charCountOf,
  exitCodeFor,
  parseCliArgs,
  parseStoredTurns,
  runCount,
  runSynth,
  SynthesizeListeningAudioInputError,
} from '../../src/scripts/synthesize-listening-audio.js';
import { DEFAULT_OWNER_EMAIL } from '../../src/scripts/share-corpus.js';
import {
  resetTtsProviderForTesting,
  setTtsProvider,
  TtsUpstreamError,
  UnconfiguredTtsProvider,
  type TtsProvider,
} from '../../src/services/tts.js';
import {
  resetMp3ConcatForTesting,
  setMp3Concat,
  type Mp3ConcatHelper,
} from '../../src/services/audioConcat.js';
import { MALE_VOICE_POOL, FEMALE_VOICE_POOL } from '../../src/services/voicePalette.js';
import { _setConfigForTesting, loadConfig } from '../../src/config/index.js';
import { _resetSpendCeilingCacheForTesting } from '../../src/services/spendCeiling.js';

let pg: PgHandle;
let t: TestApp;

const silent = (): void => undefined;

const TURNS = [
  { speaker: 'narrator', gender: 'narrator', text: '두 사람이 카페에서 이야기합니다.' },
  { speaker: '민수', gender: 'male', text: '오늘 날씨가 참 좋네요.' },
  { speaker: '지은', gender: 'female', text: '네, 산책하기 좋은 날씨예요.' },
] as const;

const GOOD_CHOICES = [
  { kr: '정답', en: '' },
  { kr: '오답1', en: '' },
  { kr: '오답2', en: '' },
  { kr: '오답3', en: '' },
];

let hashSeq = 0;
function nextHash(): string {
  hashSeq += 1;
  return `${hashSeq.toString(16).padStart(8, '0')}${'d'.repeat(56)}`;
}

/** Insert a draft (or approved) listening item with `turns` and no audio yet
 *  — the exact shape the $0 generate-item-bank ingest leaves behind. */
async function seedListeningDraft(
  turns: unknown = TURNS,
  opts: { status?: 'draft' | 'approved'; level?: string } = {},
): Promise<number> {
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO generated_items
       (section, level, kind, stem, choices, answer_index, explain, status,
        created_by, model_id, prompt_hash, turns)
     VALUES ('listening', $1, 'audio-mc', 'mock listening stem', $2::jsonb, 0,
             'mock explain', $3, 'test-fixture', 'claude-sonnet-4-6', $4, $5::jsonb)
     RETURNING id`,
    [
      opts.level ?? 'L3',
      JSON.stringify(GOOD_CHOICES),
      opts.status ?? 'draft',
      nextHash(),
      turns === undefined ? null : JSON.stringify(turns),
    ],
  );
  return Number(rows[0]!.id);
}

/** F-220 P1 — insert a paired-listening GROUP: `n` rows (default 2) sharing
 *  ONE `stimulus_group_id`, the SAME `turns`, `kind='paired-audio-mc'`, no
 *  audio yet — the exact shape the paired-reading/paired-listening ingest
 *  branch of generate-item-bank.ts leaves behind. Returns the ids in ordinal
 *  order (`ids[0]` is the ordinal=1 "primary"/cost-bearing row). */
async function seedPairedListeningGroup(
  groupId: string,
  turns: unknown = TURNS,
  opts: { n?: number; status?: 'draft' | 'approved'; level?: string } = {},
): Promise<number[]> {
  const n = opts.n ?? 2;
  const ids: number[] = [];
  for (let ordinal = 1; ordinal <= n; ordinal += 1) {
    const { rows } = await pg.pool.query<{ id: string }>(
      `INSERT INTO generated_items
         (section, level, kind, stem, choices, answer_index, explain, status,
          created_by, model_id, prompt_hash, turns, stimulus_group_id, stimulus_group_ordinal)
       VALUES ('listening', $1, 'paired-audio-mc', $2, $3::jsonb, 0,
               'mock explain', $4, 'test-fixture', 'claude-sonnet-4-6', $5, $6::jsonb, $7, $8)
       RETURNING id`,
      [
        opts.level ?? 'L3',
        `mock paired listening stem ${String(ordinal)}`,
        JSON.stringify(GOOD_CHOICES),
        opts.status ?? 'approved',
        nextHash(),
        JSON.stringify(turns),
        groupId,
        ordinal,
      ],
    );
    ids.push(Number(rows[0]!.id));
  }
  return ids;
}

/** Seed the SAME account share-corpus.ts's DEFAULT_OWNER_EMAIL names — the
 *  synth CLI resolves this exact user as its "system owner". Direct SQL
 *  (mirrors generatedBank.test.ts's fixture-user pattern) since registerUser
 *  auto-generates its own email and this test needs the SPECIFIC one. */
async function seedSystemOwner(): Promise<number> {
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, '$argon2id$' || repeat('x', 70))
     RETURNING id`,
    [DEFAULT_OWNER_EMAIL],
  );
  return Number(rows[0]!.id);
}

/** Records every (text, voiceId) call; `failAtCall` (1-based) makes exactly
 *  that call throw a whitelisted upstream error. Mirrors storyAudio.test.ts's
 *  recordingProvider. */
function recordingProvider(
  calls: Array<{ text: string; voiceId: string | undefined }>,
  failAtCall?: number,
): TtsProvider {
  let n = 0;
  return {
    synthesize: async (text, opts) => {
      n++;
      if (n === failAtCall) {
        throw new TtsUpstreamError(500, 'the speech service rejected the request (HTTP 500)');
      }
      calls.push({ text, voiceId: opts?.voiceId });
      return { audio: Buffer.from(text, 'utf8'), mimeType: 'audio/mpeg', charAlignments: [] };
    },
  };
}

/** Deterministic concat/probe mock — mirrors storyAudio.test.ts's mockConcat:
 *  duration = byteLength × 10 ms; concat = Buffer.concat. */
function mockConcat(): { helper: Mp3ConcatHelper; concatCalls: Buffer[][] } {
  const concatCalls: Buffer[][] = [];
  const helper: Mp3ConcatHelper = {
    concatMp3: async (buffers) => {
      concatCalls.push([...buffers]);
      return Buffer.concat(buffers);
    },
    probeDurationMs: async (buffer) => buffer.length * 10,
  };
  return { helper, concatCalls };
}

function turnDurMs(text: string): number {
  return Buffer.byteLength(text, 'utf8') * 10;
}
const TOTAL_DUR_MS = TURNS.reduce((sum, tn) => sum + turnDurMs(tn.text), 0);
const TOTAL_CHARS = TURNS.reduce((sum, tn) => sum + tn.text.length, 0);

async function userBlobFiles(userId: number): Promise<string[]> {
  try {
    return await readdir(path.join(process.env.AUDIO_UPLOAD_STORAGE_DIR!, String(userId)));
  } catch {
    return [];
  }
}

beforeAll(async () => {
  process.env.AUDIO_UPLOAD_STORAGE_DIR = path.join(
    os.tmpdir(),
    `km-listening-audio-test-${process.pid}-${Date.now()}`,
  );
  pg = await startPostgres();
  t = buildTestApp({ connectionString: pg.connectionString });
});

afterAll(async () => {
  await teardownTestApp(t);
  await stopPostgres(pg);
  delete process.env.AUDIO_UPLOAD_STORAGE_DIR;
});

beforeEach(async () => {
  await pg.pool.query(
    `TRUNCATE TABLE generated_items, audio_tracks, audio_sources, claude_usage, sessions, users
     RESTART IDENTITY CASCADE`,
  );
  await rm(process.env.AUDIO_UPLOAD_STORAGE_DIR!, { recursive: true, force: true });
  _resetSpendCeilingCacheForTesting();
});

afterEach(() => {
  resetTtsProviderForTesting();
  resetMp3ConcatForTesting();
  _setConfigForTesting({ SPEND_CEILING_DAILY_USD: 0 });
});

// ---------------------------------------------------------------------------
// parseCliArgs
// ---------------------------------------------------------------------------

describe('parseCliArgs', () => {
  it('defaults to count mode with no flags', () => {
    expect(parseCliArgs([])).toEqual({ mode: 'count', limit: undefined, maxCostUsd: undefined });
  });

  it('--synth with --limit/--max-cost', () => {
    expect(parseCliArgs(['--synth', '--limit=5', '--max-cost=2.50'])).toEqual({
      mode: 'synth',
      limit: 5,
      maxCostUsd: 2.5,
    });
  });

  it('--limit/--max-cost outside --synth throws (exit 2)', () => {
    expect(() => parseCliArgs(['--limit=5'])).toThrow(SynthesizeListeningAudioInputError);
    expect(() => parseCliArgs(['--count', '--max-cost=1'])).toThrow(SynthesizeListeningAudioInputError);
  });

  it('conflicting modes throw', () => {
    expect(() => parseCliArgs(['--count', '--synth'])).toThrow(SynthesizeListeningAudioInputError);
  });

  it('an unknown flag throws', () => {
    expect(() => parseCliArgs(['--bogus'])).toThrow(SynthesizeListeningAudioInputError);
  });

  it('exitCodeFor maps input errors to 2, everything else to 1', () => {
    expect(exitCodeFor(new SynthesizeListeningAudioInputError('x'))).toBe(2);
    expect(exitCodeFor(new Error('x'))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parseStoredTurns / charCountOf', () => {
  it('parses a well-formed turns array and sums char counts', () => {
    const parsed = parseStoredTurns(TURNS);
    expect(parsed).not.toBeNull();
    expect(charCountOf(parsed!)).toBe(TOTAL_CHARS);
  });

  it('rejects a malformed value (missing gender)', () => {
    expect(parseStoredTurns([{ speaker: 'x', text: 'y' }])).toBeNull();
  });

  it('rejects a non-array value', () => {
    expect(parseStoredTurns({ speaker: 'x' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runCount — ZERO synth calls, ZERO spend
// ---------------------------------------------------------------------------

describe('runCount', () => {
  it('an empty backlog counts 0, $0', async () => {
    const summary = await runCount(silent);
    expect(summary).toEqual({
      backlogCount: 0,
      totalCharCount: 0,
      estimatedCostUsd: 0,
      unparseableCount: 0,
    });
  });

  it('sums char counts across the backlog and estimates cost at the configured rate; never touches the TTS provider', async () => {
    // A throwing provider proves --count never calls it.
    setTtsProvider({
      synthesize: () => {
        throw new Error('runCount must NEVER call the TTS provider');
      },
    });
    await seedListeningDraft(TURNS);
    await seedListeningDraft(TURNS);

    const summary = await runCount(silent);
    const cfg = loadConfig();
    expect(summary.backlogCount).toBe(2);
    expect(summary.totalCharCount).toBe(TOTAL_CHARS * 2);
    expect(summary.estimatedCostUsd).toBeCloseTo(
      ((TOTAL_CHARS * 2) / 1000) * cfg.ELEVENLABS_USD_PER_1K_CHARS,
      6,
    );
    expect(summary.unparseableCount).toBe(0);
  });

  it('excludes an unparseable-turns row from the char/cost estimate but still counts it in the backlog', async () => {
    await pg.pool.query(
      `INSERT INTO generated_items
         (section, level, kind, stem, choices, answer_index, status, created_by,
          model_id, prompt_hash, turns)
       VALUES ('listening', 'L2', 'audio-mc', 'stem', $1::jsonb, 0, 'draft',
               'test-fixture', 'claude-sonnet-4-6', $2, '[{"speaker":"x"}]'::jsonb)`,
      [JSON.stringify(GOOD_CHOICES), nextHash()],
    );
    const summary = await runCount(silent);
    expect(summary.backlogCount).toBe(1);
    expect(summary.unparseableCount).toBe(1);
    expect(summary.totalCharCount).toBe(0);
    expect(summary.estimatedCostUsd).toBe(0);
  });

  it('a row that already has audio (audio_source_id set) is NOT in the backlog', async () => {
    const ownerId = await seedSystemOwner();
    const src = await pg.pool.query<{ id: string }>(
      `INSERT INTO audio_sources (user_id, slug, title, kind, status, is_shared)
       VALUES ($1, 'already-synth', 't', 'generated_listening', 'ready', true) RETURNING id`,
      [ownerId],
    );
    await pg.pool.query(
      `INSERT INTO generated_items
         (section, level, kind, stem, choices, answer_index, status, created_by,
          model_id, prompt_hash, turns, audio_source_id, audio_start_ms, audio_end_ms)
       VALUES ('listening', 'L2', 'audio-mc', 'stem', $1::jsonb, 0, 'draft',
               'test-fixture', 'claude-sonnet-4-6', $2, $3::jsonb, $4, 0, 4000)`,
      [JSON.stringify(GOOD_CHOICES), nextHash(), JSON.stringify(TURNS), src.rows[0]!.id],
    );
    const summary = await runCount(silent);
    expect(summary.backlogCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runSynth — METERED, but $0 in this test file (mocked provider/concat)
// ---------------------------------------------------------------------------

describe('runSynth — happy path', () => {
  it('synthesizes per-turn with palette voices, ONE concatenated blob, ONE audio_sources(kind=generated_listening, owner=share-corpus DEFAULT_OWNER_EMAIL, is_shared=true) + audio_tracks, and settles generated_items in one UPDATE', async () => {
    const ownerId = await seedSystemOwner();
    const itemId = await seedListeningDraft(TURNS, { status: 'approved', level: 'L3' });

    const synthCalls: Array<{ text: string; voiceId: string | undefined }> = [];
    setTtsProvider(recordingProvider(synthCalls));
    const { helper, concatCalls } = mockConcat();
    setMp3Concat(helper);

    const summary = await runSynth({ mode: 'synth', limit: undefined, maxCostUsd: undefined }, silent);
    expect(summary.attempted).toBe(1);
    expect(summary.synthesized).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.stoppedEarly).toBeNull();

    // Per-turn synth in order, with the palette's voices (narrator → env
    // voice; 민수 → 1st male; 지은 → 1st female).
    const narratorVoice = loadConfig().ELEVENLABS_VOICE_ID;
    expect(synthCalls.map((c) => c.text)).toEqual(TURNS.map((tn) => tn.text));
    expect(synthCalls.map((c) => c.voiceId)).toEqual([narratorVoice, MALE_VOICE_POOL[0], FEMALE_VOICE_POOL[0]]);
    expect(concatCalls).toHaveLength(1);

    // ONE blob on disk under the SYSTEM OWNER's directory.
    const files = await userBlobFiles(ownerId);
    expect(files).toHaveLength(1);
    const expectedBlob = Buffer.concat(TURNS.map((tn) => Buffer.from(tn.text, 'utf8')));
    const onDisk = await readFile(path.join(process.env.AUDIO_UPLOAD_STORAGE_DIR!, String(ownerId), files[0]!));
    expect(Buffer.compare(onDisk, expectedBlob)).toBe(0);

    const src = await pg.pool.query<{
      user_id: string;
      kind: string;
      status: string;
      is_shared: boolean;
    }>(`SELECT user_id, kind, status, is_shared FROM audio_sources`);
    expect(src.rows).toHaveLength(1);
    expect(Number(src.rows[0]!.user_id)).toBe(ownerId);
    expect(src.rows[0]!.kind).toBe('generated_listening');
    expect(src.rows[0]!.is_shared).toBe(true);

    const trk = await pg.pool.query<{ duration_ms: number; byte_size: string }>(
      `SELECT duration_ms, byte_size::text AS byte_size FROM audio_tracks`,
    );
    expect(trk.rows).toHaveLength(1);
    expect(trk.rows[0]!.duration_ms).toBe(TOTAL_DUR_MS);
    expect(Number(trk.rows[0]!.byte_size)).toBe(expectedBlob.length);

    const item = await pg.pool.query<{
      audio_source_id: string;
      audio_start_ms: number;
      audio_end_ms: number;
      audio_cost_estimate_usd: string;
      audio_synthesized_at: string | null;
    }>(
      `SELECT audio_source_id, audio_start_ms, audio_end_ms, audio_cost_estimate_usd,
              audio_synthesized_at
         FROM generated_items WHERE id = $1`,
      [itemId],
    );
    const cfg = loadConfig();
    expect(item.rows[0]!.audio_start_ms).toBe(0);
    expect(item.rows[0]!.audio_end_ms).toBe(TOTAL_DUR_MS);
    expect(Number(item.rows[0]!.audio_cost_estimate_usd)).toBeCloseTo(
      (TOTAL_CHARS / 1000) * cfg.ELEVENLABS_USD_PER_1K_CHARS,
      6,
    );
    expect(item.rows[0]!.audio_synthesized_at).not.toBeNull();
  });

  it('is idempotent: a re-run after a successful synth finds an EMPTY backlog', async () => {
    await seedSystemOwner();
    await seedListeningDraft(TURNS);
    setTtsProvider(recordingProvider([]));
    setMp3Concat(mockConcat().helper);

    const first = await runSynth({ mode: 'synth', limit: undefined, maxCostUsd: undefined }, silent);
    expect(first.synthesized).toBe(1);

    const second = await runSynth({ mode: 'synth', limit: undefined, maxCostUsd: undefined }, silent);
    expect(second.attempted).toBe(0);
    expect(second.synthesized).toBe(0);

    const sources = await pg.pool.query(`SELECT count(*)::int AS n FROM audio_sources`);
    expect(sources.rows[0]!.n).toBe(1); // still just the one from the first run
  });

  it('--limit caps how many items a run processes', async () => {
    await seedSystemOwner();
    await seedListeningDraft(TURNS);
    await seedListeningDraft(TURNS);
    await seedListeningDraft(TURNS);
    setTtsProvider(recordingProvider([]));
    setMp3Concat(mockConcat().helper);

    const summary = await runSynth({ mode: 'synth', limit: 2, maxCostUsd: undefined }, silent);
    expect(summary.attempted).toBe(2);
    expect(summary.synthesized).toBe(2);

    const remaining = await runCount(silent);
    expect(remaining.backlogCount).toBe(1);
  });

  it('--max-cost stops the run before exceeding the per-run budget (graceful, not a failure)', async () => {
    await seedSystemOwner();
    await seedListeningDraft(TURNS);
    await seedListeningDraft(TURNS);
    setTtsProvider(recordingProvider([]));
    setMp3Concat(mockConcat().helper);

    const cfg = loadConfig();
    const perItemCost = (TOTAL_CHARS / 1000) * cfg.ELEVENLABS_USD_PER_1K_CHARS;
    // Budget for exactly one item, not two.
    const summary = await runSynth(
      { mode: 'synth', limit: undefined, maxCostUsd: perItemCost * 1.5 },
      silent,
    );
    expect(summary.synthesized).toBe(1);
    expect(summary.stoppedEarly).toBe('max-cost');

    const remaining = await runCount(silent);
    expect(remaining.backlogCount).toBe(1); // the second item was never touched
  });

  it('the global spend ceiling stops a run BEFORE any spend when already at/over it (graceful, not a failure)', async () => {
    await seedSystemOwner();
    await seedListeningDraft(TURNS);
    setTtsProvider(recordingProvider([]));
    setMp3Concat(mockConcat().helper);
    // A ceiling of a tiny positive number with zero recorded spend still lets
    // the FIRST check pass (0 < ceiling); simulate "already over" by seeding
    // prior claude_usage spend that meets/exceeds a low ceiling.
    await pg.pool.query(
      `INSERT INTO claude_usage (request_id, route, model, cost_estimate_usd, latency_ms)
       VALUES ('ceiling-seed', 'enrich'::claude_route, 'claude-haiku-4-5'::claude_model, 100, 5)`,
    );
    _setConfigForTesting({ SPEND_CEILING_DAILY_USD: 1, SPEND_CEILING_CACHE_TTL_MS: 0 });

    const summary = await runSynth({ mode: 'synth', limit: undefined, maxCostUsd: undefined }, silent);
    expect(summary.attempted).toBe(0);
    expect(summary.synthesized).toBe(0);
    expect(summary.stoppedEarly).toBe('spend-ceiling');

    const remaining = await runCount(silent);
    expect(remaining.backlogCount).toBe(1); // untouched — no spend happened
  });
});

describe('runSynth — failure modes', () => {
  it('TTS unconfigured: every item FAILS LOUDLY, no row is written, and the run reports every attempt failed', async () => {
    await seedSystemOwner();
    await seedListeningDraft(TURNS);
    setTtsProvider(new UnconfiguredTtsProvider());
    setMp3Concat(mockConcat().helper);

    const printed: string[] = [];
    const summary = await runSynth(
      { mode: 'synth', limit: undefined, maxCostUsd: undefined },
      (line) => printed.push(line),
    );
    expect(summary.attempted).toBe(1);
    expect(summary.synthesized).toBe(0);
    expect(summary.failed).toBe(1);
    expect(printed.some((l) => l.includes('FAILED'))).toBe(true);

    const remaining = await runCount(silent);
    expect(remaining.backlogCount).toBe(1); // NOT consumed — no bad row written

    const sources = await pg.pool.query(`SELECT count(*)::int AS n FROM audio_sources`);
    expect(sources.rows[0]!.n).toBe(0);
  });

  it('a malformed/unparseable turns value is skipped without crashing the run; other items still succeed', async () => {
    await seedSystemOwner();
    await pg.pool.query(
      `INSERT INTO generated_items
         (section, level, kind, stem, choices, answer_index, status, created_by,
          model_id, prompt_hash, turns)
       VALUES ('listening', 'L2', 'audio-mc', 'stem', $1::jsonb, 0, 'draft',
               'test-fixture', 'claude-sonnet-4-6', $2, '[{"speaker":"x"}]'::jsonb)`,
      [JSON.stringify(GOOD_CHOICES), nextHash()],
    );
    await seedListeningDraft(TURNS);
    setTtsProvider(recordingProvider([]));
    setMp3Concat(mockConcat().helper);

    const summary = await runSynth({ mode: 'synth', limit: undefined, maxCostUsd: undefined }, silent);
    expect(summary.skippedUnparseable).toBe(1);
    expect(summary.synthesized).toBe(1);
    expect(summary.attempted).toBe(1); // the unparseable row never even counts as "attempted"
  });

  it('a per-turn ElevenLabs failure fails that item loudly; no orphaned audio_sources row, no blob left behind', async () => {
    await seedSystemOwner();
    await seedListeningDraft(TURNS);
    setTtsProvider(recordingProvider([], 2)); // the 2nd of 3 turns fails
    setMp3Concat(mockConcat().helper);

    const summary = await runSynth({ mode: 'synth', limit: undefined, maxCostUsd: undefined }, silent);
    expect(summary.failed).toBe(1);
    expect(summary.synthesized).toBe(0);

    const sources = await pg.pool.query(`SELECT count(*)::int AS n FROM audio_sources`);
    expect(sources.rows[0]!.n).toBe(0);
    const remaining = await runCount(silent);
    expect(remaining.backlogCount).toBe(1);
  });

  it('missing system-owner account -> SynthesizeListeningAudioInputError, nothing written', async () => {
    // Deliberately do NOT seed the DEFAULT_OWNER_EMAIL user.
    await seedListeningDraft(TURNS);
    setTtsProvider(recordingProvider([]));
    setMp3Concat(mockConcat().helper);

    await expect(
      runSynth({ mode: 'synth', limit: undefined, maxCostUsd: undefined }, silent),
    ).rejects.toBeInstanceOf(SynthesizeListeningAudioInputError);

    const sources = await pg.pool.query(`SELECT count(*)::int AS n FROM audio_sources`);
    expect(sources.rows[0]!.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F-220 P1 — paired-audio GROUPS: one shared clip synthesized ONCE per
// group, stamped onto every row in the group, billed ONCE (never
// double-counted). The pre-existing single-item path above is unaffected.
// ---------------------------------------------------------------------------

describe('runCount — paired-audio groups counted ONCE, not once per row', () => {
  it('a 3-row paired group contributes its char/cost estimate exactly ONCE (not x3), and counts as ONE backlog entry', async () => {
    await seedPairedListeningGroup('grp-count-1', TURNS, { n: 3 });
    const summary = await runCount(silent);
    const cfg = loadConfig();
    expect(summary.backlogCount).toBe(1); // ONE representative row, not 3
    expect(summary.totalCharCount).toBe(TOTAL_CHARS); // NOT TOTAL_CHARS * 3
    expect(summary.estimatedCostUsd).toBeCloseTo((TOTAL_CHARS / 1000) * cfg.ELEVENLABS_USD_PER_1K_CHARS, 6);
  });

  it('a mix of one standalone item + one 2-row paired group counts as 2 backlog entries, chars summed once per group', async () => {
    await seedListeningDraft(TURNS, { status: 'approved' });
    await seedPairedListeningGroup('grp-count-mix', TURNS, { n: 2 });
    const summary = await runCount(silent);
    expect(summary.backlogCount).toBe(2);
    expect(summary.totalCharCount).toBe(TOTAL_CHARS * 2); // 1 standalone + 1 group-once
  });

  it('a group row that already has audio (audio_source_id set on the ordinal=1 row) is NOT in the backlog', async () => {
    const seededOwnerId = await seedSystemOwner();
    const src = await pg.pool.query<{ id: string }>(
      `INSERT INTO audio_sources (user_id, slug, title, kind, status, is_shared)
       VALUES ($1, 'x', 'x', 'generated_listening', 'ready', true) RETURNING id`,
      [seededOwnerId],
    );
    const sourceId = Number(src.rows[0]!.id);
    const ids = await seedPairedListeningGroup('grp-count-done', TURNS, { n: 2 });
    await pg.pool.query(
      `UPDATE generated_items SET audio_source_id = $2, audio_start_ms = 0, audio_end_ms = 100
        WHERE id = $1`,
      [ids[0], sourceId],
    );
    const summary = await runCount(silent);
    expect(summary.backlogCount).toBe(0);
  });
});

describe('runSynth — paired-audio groups (happy path)', () => {
  it('synthesizes the shared dialogue ONCE, stamps the SAME audio_source_id/offsets on EVERY row in the group, and charges audio_cost_estimate_usd ONLY on the ordinal=1 row', async () => {
    await seedSystemOwner();
    await seedPairedListeningGroup('grp-synth-1', TURNS, { n: 2, level: 'L3' });

    const synthCalls: Array<{ text: string; voiceId: string | undefined }> = [];
    setTtsProvider(recordingProvider(synthCalls));
    const { helper, concatCalls } = mockConcat();
    setMp3Concat(helper);

    const summary = await runSynth({ mode: 'synth', limit: undefined, maxCostUsd: undefined }, silent);
    expect(summary.attempted).toBe(1); // ONE group = ONE synth attempt
    expect(summary.synthesized).toBe(1);
    expect(summary.failed).toBe(0);

    // Exactly ONE synth pass over the shared turns (not once per row).
    expect(synthCalls.map((c) => c.text)).toEqual(TURNS.map((tn) => tn.text));
    expect(concatCalls).toHaveLength(1);

    // Exactly ONE audio_sources + audio_tracks pair for the whole group.
    const src = await pg.pool.query<{ id: string; kind: string; is_shared: boolean }>(
      `SELECT id, kind, is_shared FROM audio_sources`,
    );
    expect(src.rows).toHaveLength(1);
    expect(src.rows[0]!.kind).toBe('generated_listening');
    expect(src.rows[0]!.is_shared).toBe(true);
    const tracks = await pg.pool.query(`SELECT count(*)::int AS n FROM audio_tracks`);
    expect(tracks.rows[0]!.n).toBe(1);

    const rows = await pg.pool.query<{
      id: string;
      audio_source_id: string | null;
      audio_start_ms: number | null;
      audio_end_ms: number | null;
      audio_cost_estimate_usd: string | null;
      audio_synthesized_at: string | null;
      stimulus_group_ordinal: number;
    }>(
      `SELECT id, audio_source_id, audio_start_ms, audio_end_ms, audio_cost_estimate_usd,
              audio_synthesized_at, stimulus_group_ordinal
         FROM generated_items WHERE stimulus_group_id = 'grp-synth-1'
        ORDER BY stimulus_group_ordinal`,
    );
    expect(rows.rows).toHaveLength(2);

    // EVERY row in the group got the SAME audio_source_id/offsets/timestamp.
    const sourceIds = new Set(rows.rows.map((r) => r.audio_source_id));
    expect(sourceIds.size).toBe(1);
    expect([...sourceIds][0]).toBe(src.rows[0]!.id);
    for (const row of rows.rows) {
      expect(row.audio_start_ms).toBe(0);
      expect(row.audio_end_ms).toBe(TOTAL_DUR_MS);
      expect(row.audio_synthesized_at).not.toBeNull();
    }

    // The COST is charged EXACTLY ONCE — only the ordinal=1 row.
    const ordinal1 = rows.rows.find((r) => r.stimulus_group_ordinal === 1)!;
    const ordinal2 = rows.rows.find((r) => r.stimulus_group_ordinal === 2)!;
    expect(ordinal1.audio_cost_estimate_usd).not.toBeNull();
    expect(ordinal2.audio_cost_estimate_usd).toBeNull();
    const cfg = loadConfig();
    expect(Number(ordinal1.audio_cost_estimate_usd)).toBeCloseTo(
      (TOTAL_CHARS / 1000) * cfg.ELEVENLABS_USD_PER_1K_CHARS,
      6,
    );

    // NO DOUBLE-COUNT: spendCeiling.ts's SUM(audio_cost_estimate_usd) sees
    // the group's spend exactly once, not once per row.
    const sum = await pg.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(audio_cost_estimate_usd), 0)::text AS total FROM generated_items`,
    );
    expect(Number(sum.rows[0]!.total)).toBeCloseTo(Number(ordinal1.audio_cost_estimate_usd), 6);
  });

  it('is idempotent: a re-run after a successful group synth finds an EMPTY backlog for that group', async () => {
    await seedSystemOwner();
    await seedPairedListeningGroup('grp-synth-idem', TURNS, { n: 2 });
    setTtsProvider(recordingProvider([]));
    setMp3Concat(mockConcat().helper);

    const first = await runSynth({ mode: 'synth', limit: undefined, maxCostUsd: undefined }, silent);
    expect(first.synthesized).toBe(1);

    const second = await runSynth({ mode: 'synth', limit: undefined, maxCostUsd: undefined }, silent);
    expect(second.attempted).toBe(0);
    expect(second.synthesized).toBe(0);

    const sources = await pg.pool.query(`SELECT count(*)::int AS n FROM audio_sources`);
    expect(sources.rows[0]!.n).toBe(1); // still just the one from the first run
  });

  it('a mix of one standalone item + one paired group in the SAME run: both synthesize, each gets its OWN audio_sources row, and the standalone item is completely unaffected (regression)', async () => {
    await seedSystemOwner();
    const standaloneId = await seedListeningDraft(TURNS, { status: 'approved' });
    await seedPairedListeningGroup('grp-synth-mixed', TURNS, { n: 2 });
    setTtsProvider(recordingProvider([]));
    setMp3Concat(mockConcat().helper);

    const summary = await runSynth({ mode: 'synth', limit: undefined, maxCostUsd: undefined }, silent);
    expect(summary.attempted).toBe(2); // 1 standalone + 1 group
    expect(summary.synthesized).toBe(2);

    const sources = await pg.pool.query(`SELECT count(*)::int AS n FROM audio_sources`);
    expect(sources.rows[0]!.n).toBe(2); // one per unit, not shared across them

    const standalone = await pg.pool.query<{
      audio_source_id: string | null;
      audio_cost_estimate_usd: string | null;
    }>(`SELECT audio_source_id, audio_cost_estimate_usd FROM generated_items WHERE id = $1`, [standaloneId]);
    expect(standalone.rows[0]!.audio_source_id).not.toBeNull();
    expect(standalone.rows[0]!.audio_cost_estimate_usd).not.toBeNull(); // standalone path unchanged: cost IS set on it

    const groupRows = await pg.pool.query<{ audio_source_id: string | null }>(
      `SELECT audio_source_id FROM generated_items WHERE stimulus_group_id = 'grp-synth-mixed'`,
    );
    expect(groupRows.rows.every((r) => r.audio_source_id !== null)).toBe(true);
    const standaloneSourceId = standalone.rows[0]!.audio_source_id;
    expect(groupRows.rows.every((r) => r.audio_source_id !== standaloneSourceId)).toBe(true);
  });

  it('--limit counts a paired GROUP as one unit toward the cap', async () => {
    await seedSystemOwner();
    await seedPairedListeningGroup('grp-synth-limit-a', TURNS, { n: 2 });
    await seedPairedListeningGroup('grp-synth-limit-b', TURNS, { n: 2 });
    setTtsProvider(recordingProvider([]));
    setMp3Concat(mockConcat().helper);

    const summary = await runSynth({ mode: 'synth', limit: 1, maxCostUsd: undefined }, silent);
    expect(summary.attempted).toBe(1);
    expect(summary.synthesized).toBe(1);

    const remaining = await runCount(silent);
    expect(remaining.backlogCount).toBe(1); // the second group untouched
  });

  it('a per-turn ElevenLabs failure fails the WHOLE group loudly; no row in the group gets partial audio', async () => {
    await seedSystemOwner();
    await seedPairedListeningGroup('grp-synth-fail', TURNS, { n: 2 });
    setTtsProvider(recordingProvider([], 2)); // the 2nd of 3 turns fails
    setMp3Concat(mockConcat().helper);

    const summary = await runSynth({ mode: 'synth', limit: undefined, maxCostUsd: undefined }, silent);
    expect(summary.failed).toBe(1);
    expect(summary.synthesized).toBe(0);

    const sources = await pg.pool.query(`SELECT count(*)::int AS n FROM audio_sources`);
    expect(sources.rows[0]!.n).toBe(0);
    const groupRows = await pg.pool.query<{ audio_source_id: string | null }>(
      `SELECT audio_source_id FROM generated_items WHERE stimulus_group_id = 'grp-synth-fail'`,
    );
    expect(groupRows.rows.every((r) => r.audio_source_id === null)).toBe(true);
  });
});
