/**
 * `pickGeneratedItem` (F-220 slice 1 draw path) — real Postgres via
 * testcontainers (full migration chain, including migration 101's
 * `generated_items`). Route-level wiring (the DIAGNOSTIC_USE_GENERATED_BANK
 * gate) is covered separately in
 * tests/routes/diagnosticGeneratedBank.test.ts; this file exercises
 * `pickGeneratedItem` directly against the table.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../../helpers/pg.js';
import type { Querier } from '../../../src/db/pool.js';
import { pickGeneratedItem } from '../../../src/services/diagnostic/generatedBank.js';

let pg: PgHandle;
let exec: Querier;

/** Adapts a `Pool` into the `Querier` shape `pickGeneratedItem` expects —
 *  mirrors `src/db/pool.ts`'s `clientQuerier` (same adaptation for a
 *  transaction-bound `PoolClient`). Lets this suite exercise the real
 *  `pg.pool` from `startPostgres()` without installing it as the global
 *  pool. */
function poolQuerier(pool: Pool): Querier {
  return async (text, params = []) => {
    const result = await pool.query(text, params as unknown[]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  };
}

beforeAll(async () => {
  pg = await startPostgres();
  exec = poolQuerier(pg.pool);
});

afterAll(async () => {
  await stopPostgres(pg);
});

beforeEach(async () => {
  await pg.pool.query(`DELETE FROM generated_items`);
});

let hashSeq = 0;
function nextHash(): string {
  hashSeq += 1;
  return `${hashSeq.toString(16).padStart(8, '0')}${'b'.repeat(56)}`;
}

async function insertItem(overrides: {
  section?: 'vocab' | 'grammar' | 'reading' | 'listening';
  level?: string;
  kind?: string;
  status?: 'draft' | 'approved' | 'retired';
  stem?: string;
  passage?: string | null;
  choices?: readonly { kr: string; en?: string }[];
  answerIndex?: number;
  explain?: string | null;
  /** F-220 slice 3 — set to make a listening row audio-ready. */
  audioSourceId?: number | null;
  audioStartMs?: number | null;
  audioEndMs?: number | null;
}): Promise<number> {
  const section = overrides.section ?? 'vocab';
  const kind =
    overrides.kind ??
    (section === 'grammar'
      ? 'pattern'
      : section === 'reading'
        ? 'passage-mc'
        : section === 'listening'
          ? 'audio-mc'
          : 'synonym');
  const choices = overrides.choices ?? [
    { kr: '정답', en: 'correct' },
    { kr: '오답1' },
    { kr: '오답2' },
    { kr: '오답3' },
  ];
  const passage = overrides.passage ?? (section === 'reading' ? '지문 텍스트입니다.' : null);
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO generated_items
       (section, level, kind, stem, passage, choices, answer_index, explain, source_ref,
        status, created_by, model_id, prompt_hash, audio_source_id, audio_start_ms, audio_end_ms)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'test-seed-ref',
             $9, 'test-fixture', 'claude-sonnet-4-6', $10, $11, $12, $13)
     RETURNING id`,
    [
      section,
      overrides.level ?? 'L3',
      kind,
      overrides.stem ?? 'mock stem',
      passage,
      JSON.stringify(choices),
      overrides.answerIndex ?? 0,
      overrides.explain ?? 'mock explain',
      overrides.status ?? 'approved',
      nextHash(),
      overrides.audioSourceId ?? null,
      overrides.audioStartMs ?? null,
      overrides.audioEndMs ?? null,
    ],
  );
  return Number(rows[0]!.id);
}

let listeningFixtureUserId: number | null = null;
let audioSlugSeq = 0;

/** F-220 slice 3 — one real audio_sources + audio_tracks pair (mirrors the
 *  synthesize-listening-audio CLI's own INSERT shape) so a listening
 *  `pickGeneratedItem` draw can prove the returned audioUrl/offsets. Creates
 *  a fixture "system owner" user lazily (once per test file run — TRUNCATEd
 *  away between files, not between tests in this file, since no test here
 *  mutates `users`). */
async function seedAudioTrack(
  pool: Pool,
  opts: { durationMs?: number } = {},
): Promise<{ sourceId: number; trackId: number }> {
  if (listeningFixtureUserId === null) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash)
       VALUES ('bank-listening-fixture@test.dev', '$argon2id$' || repeat('x', 70))
       RETURNING id`,
    );
    listeningFixtureUserId = Number(rows[0]!.id);
  }
  audioSlugSeq += 1;
  const src = await pool.query<{ id: string }>(
    `INSERT INTO audio_sources (user_id, slug, title, kind, status, is_shared)
     VALUES ($1, $2, 'mock listening audio', 'generated_listening', 'ready', true)
     RETURNING id`,
    [listeningFixtureUserId, `bank-listening-${String(audioSlugSeq)}`],
  );
  const sourceId = Number(src.rows[0]!.id);
  const trk = await pool.query<{ id: string }>(
    `INSERT INTO audio_tracks (source_id, user_id, track_number, title, blob_ref, byte_size, duration_ms, transcript_status)
     VALUES ($1, $2, 1, 'mock', $3, 100, $4, 'done')
     RETURNING id`,
    [sourceId, listeningFixtureUserId, `${String(listeningFixtureUserId)}/mock-${String(audioSlugSeq)}.mp3`, opts.durationMs ?? 4000],
  );
  return { sourceId, trackId: Number(trk.rows[0]!.id) };
}

describe('pickGeneratedItem', () => {
  it('returns null when the bank is empty for the cell', async () => {
    const result = await pickGeneratedItem('vocab', 'L3', exec);
    expect(result).toBeNull();
  });

  it('returns null when only OTHER cells / OTHER statuses are populated', async () => {
    await insertItem({ section: 'vocab', level: 'L4', status: 'approved' }); // wrong level
    await insertItem({ section: 'grammar', level: 'L3', status: 'approved' }); // wrong section
    await insertItem({ section: 'vocab', level: 'L3', status: 'draft' }); // wrong status
    await insertItem({ section: 'vocab', level: 'L3', status: 'retired' }); // wrong status

    const result = await pickGeneratedItem('vocab', 'L3', exec);
    expect(result).toBeNull();
  });

  it('draws an approved row matching section+level, mapped to the ServerItem-compatible shape', async () => {
    const id = await insertItem({
      section: 'vocab',
      level: 'L3',
      kind: 'synonym',
      stem: '다음 중 뜻이 가장 비슷한 것은?',
      choices: [
        { kr: '학교', en: 'school' },
        { kr: '병원' },
        { kr: '공원', en: 'park' },
        { kr: '도서관' },
      ],
      answerIndex: 2,
      explain: 'because reasons',
    });

    const result = await pickGeneratedItem('vocab', 'L3', exec);
    expect(result).not.toBeNull();
    expect(result!.sourceRef).toBe(`bank:${String(id)}`);
    expect(result!.kind).toBe('synonym');
    expect(result!.level).toBe('L3');
    expect(result!.prompt).toBe('다음 중 뜻이 가장 비슷한 것은?');
    expect(result!.explain).toBe('because reasons');
    expect(result!.choices).toEqual([
      { id: 'a', kr: '학교', en: 'school' },
      { id: 'b', kr: '병원', en: '' }, // missing `en` coerced to ''
      { id: 'c', kr: '공원', en: 'park' },
      { id: 'd', kr: '도서관', en: '' },
    ]);
    // answerIndex 2 -> choice 'c'.
    expect(result!.correctAnswer).toBe('c');
  });

  it('vocab draw excludes a mismatched kind="pattern" row even if approved for the cell (defense-in-depth)', async () => {
    await insertItem({ section: 'vocab', level: 'L3', kind: 'pattern', status: 'approved' });
    const result = await pickGeneratedItem('vocab', 'L3', exec);
    expect(result).toBeNull();
  });

  it('grammar draw only matches kind="pattern" rows (never synonym/cloze)', async () => {
    await insertItem({ section: 'grammar', level: 'L3', kind: 'synonym', status: 'approved' });
    const miss = await pickGeneratedItem('grammar', 'L3', exec);
    expect(miss).toBeNull();

    const id = await insertItem({ section: 'grammar', level: 'L3', kind: 'pattern', status: 'approved' });
    const hit = await pickGeneratedItem('grammar', 'L3', exec);
    expect(hit).not.toBeNull();
    expect(hit!.sourceRef).toBe(`bank:${String(id)}`);
  });

  it('draws only from the requested (section, level) cell when multiple cells are populated', async () => {
    const wantedId = await insertItem({ section: 'vocab', level: 'L1', status: 'approved' });
    await insertItem({ section: 'vocab', level: 'L2', status: 'approved' });
    await insertItem({ section: 'vocab', level: 'L5+', status: 'approved' });
    await insertItem({ section: 'grammar', level: 'L1', kind: 'pattern', status: 'approved' });

    for (let i = 0; i < 5; i += 1) {
      const result = await pickGeneratedItem('vocab', 'L1', exec);
      expect(result).not.toBeNull();
      expect(result!.sourceRef).toBe(`bank:${String(wantedId)}`);
    }
  });
});

describe('pickGeneratedItem — reading (F-220 slice 2)', () => {
  it('draws an approved reading row, mapped WITH a non-null passage', async () => {
    const id = await insertItem({
      section: 'reading',
      level: 'L3',
      kind: 'passage-mc',
      stem: '이 글의 중심 내용은 무엇입니까?',
      passage: '오늘은 날씨가 맑고 따뜻합니다. 사람들이 공원에서 산책을 합니다.',
      choices: [
        { kr: '날씨', en: 'weather' },
        { kr: '음식' },
        { kr: '교통' },
        { kr: '건강' },
      ],
      answerIndex: 0,
      explain: 'the passage is about the weather',
    });

    const result = await pickGeneratedItem('reading', 'L3', exec);
    expect(result).not.toBeNull();
    expect(result!.sourceRef).toBe(`bank:${String(id)}`);
    expect(result!.kind).toBe('passage-mc');
    expect(result!.prompt).toBe('이 글의 중심 내용은 무엇입니까?');
    expect(result!.passage).toBe('오늘은 날씨가 맑고 따뜻합니다. 사람들이 공원에서 산책을 합니다.');
    expect(result!.correctAnswer).toBe('a');
  });

  it('vocab/grammar draws never carry a passage (undefined, not null)', async () => {
    await insertItem({ section: 'vocab', level: 'L3', kind: 'synonym' });
    const result = await pickGeneratedItem('vocab', 'L3', exec);
    expect(result).not.toBeNull();
    expect(result!.passage).toBeUndefined();
  });

  it('reading draw only matches kind="passage-mc" rows (never synonym/cloze/pattern)', async () => {
    // Defense-in-depth: a stray non-passage-mc row under section='reading'
    // (should never happen via the ingest CLI) must not surface.
    await insertItem({ section: 'reading', level: 'L3', kind: 'synonym', status: 'approved' });
    const miss = await pickGeneratedItem('reading', 'L3', exec);
    expect(miss).toBeNull();
  });

  it('draws only from the requested (section=reading, level) cell, never a vocab/grammar cell', async () => {
    const wantedId = await insertItem({ section: 'reading', level: 'L4', status: 'approved' });
    await insertItem({ section: 'reading', level: 'L3', status: 'approved' });
    await insertItem({ section: 'vocab', level: 'L4', status: 'approved' });
    await insertItem({ section: 'grammar', level: 'L4', kind: 'pattern', status: 'approved' });

    const result = await pickGeneratedItem('reading', 'L4', exec);
    expect(result).not.toBeNull();
    expect(result!.sourceRef).toBe(`bank:${String(wantedId)}`);
  });

  it('returns null when the reading bank is empty for the cell (falls through to pickTopikRow)', async () => {
    const result = await pickGeneratedItem('reading', 'L2', exec);
    expect(result).toBeNull();
  });
});

describe('pickGeneratedItem — listening (F-220 slice 3)', () => {
  it('draws an approved, audio-ready listening row with audioUrl/offsets, NEVER a passage', async () => {
    const { sourceId, trackId } = await seedAudioTrack(pg.pool, { durationMs: 5230 });
    const id = await insertItem({
      section: 'listening',
      level: 'L3',
      kind: 'audio-mc',
      stem: '두 사람은 무엇에 대해 이야기합니까?',
      choices: [
        { kr: '날씨', en: 'weather' },
        { kr: '음식' },
        { kr: '교통' },
        { kr: '건강' },
      ],
      answerIndex: 0,
      explain: 'the dialogue is about the weather',
      audioSourceId: sourceId,
      audioStartMs: 0,
      audioEndMs: 5230,
    });

    const result = await pickGeneratedItem('listening', 'L3', exec);
    expect(result).not.toBeNull();
    expect(result!.sourceRef).toBe(`bank:${String(id)}`);
    expect(result!.kind).toBe('audio-mc');
    expect(result!.prompt).toBe('두 사람은 무엇에 대해 이야기합니까?');
    expect(result!.passage).toBeUndefined();
    expect(result!.audioUrl).toBe(`/audio/tracks/${String(trackId)}/stream`);
    expect(result!.audioStartMs).toBe(0);
    expect(result!.audioEndMs).toBe(5230);
    expect(result!.correctAnswer).toBe('a');
  });

  it('excludes a listening row with NO audio yet (audio_source_id NULL), even if approved', async () => {
    await insertItem({ section: 'listening', level: 'L2', status: 'approved', audioSourceId: null });
    const result = await pickGeneratedItem('listening', 'L2', exec);
    expect(result).toBeNull();
  });

  it('excludes a listening row that is only draft, even with audio attached', async () => {
    const { sourceId } = await seedAudioTrack(pg.pool);
    await insertItem({
      section: 'listening',
      level: 'L2',
      status: 'draft',
      audioSourceId: sourceId,
      audioStartMs: 0,
      audioEndMs: 4000,
    });
    const result = await pickGeneratedItem('listening', 'L2', exec);
    expect(result).toBeNull();
  });

  it('listening draw only matches kind="audio-mc" rows (never synonym/cloze/pattern/passage-mc)', async () => {
    const { sourceId } = await seedAudioTrack(pg.pool);
    await insertItem({
      section: 'listening',
      level: 'L3',
      kind: 'passage-mc',
      status: 'approved',
      audioSourceId: sourceId,
      audioStartMs: 0,
      audioEndMs: 4000,
    });
    const miss = await pickGeneratedItem('listening', 'L3', exec);
    expect(miss).toBeNull();
  });

  it('draws only from the requested (section=listening, level) cell, never a reading/vocab/grammar cell', async () => {
    const { sourceId: wantedSourceId } = await seedAudioTrack(pg.pool);
    const wantedId = await insertItem({
      section: 'listening',
      level: 'L4',
      status: 'approved',
      audioSourceId: wantedSourceId,
      audioStartMs: 0,
      audioEndMs: 4000,
    });
    const { sourceId: otherSourceId } = await seedAudioTrack(pg.pool);
    await insertItem({
      section: 'listening',
      level: 'L3',
      status: 'approved',
      audioSourceId: otherSourceId,
      audioStartMs: 0,
      audioEndMs: 4000,
    });
    await insertItem({ section: 'reading', level: 'L4', status: 'approved' });
    await insertItem({ section: 'vocab', level: 'L4', status: 'approved' });

    const result = await pickGeneratedItem('listening', 'L4', exec);
    expect(result).not.toBeNull();
    expect(result!.sourceRef).toBe(`bank:${String(wantedId)}`);
  });

  it('returns null when the listening bank is empty for the cell (falls through to pickTopikRow)', async () => {
    const result = await pickGeneratedItem('listening', 'L1', exec);
    expect(result).toBeNull();
  });
});
