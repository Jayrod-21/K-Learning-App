/**
 * `assembleGeneratedMock` (F-220 P3 — the generated mock-exam assembler) —
 * real Postgres via testcontainers (full migration chain). Proves:
 *   - blueprint composition ORDER (single-item kind blocks in sequence,
 *     paired-stimulus blocks flattened contiguously at their position);
 *   - thin-bank graceful degradation (a slot the bank can't fill is skipped,
 *     never a crash, never padded);
 *   - tier level pooling (tier I draws only L1/L2, tier II only L3/L4/L5+);
 *   - NO-LEAK on the assembled snapshot (a listening question never carries
 *     a transcript field, whether drawn singly or from a paired group);
 *   - `toClientMockItem`'s type-level answer strip.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../../helpers/pg.js';
import type { Querier } from '../../../src/db/pool.js';
import {
  assembleGeneratedMock,
  toClientMockItem,
  MOCK_BLUEPRINT,
} from '../../../src/services/topik/generatedMock.js';

let pg: PgHandle;
let exec: Querier;

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
  return `${hashSeq.toString(16).padStart(8, '0')}${'c'.repeat(56)}`;
}

async function insertItem(overrides: {
  section?: 'reading' | 'listening';
  level?: string;
  kind?: string;
  status?: 'draft' | 'approved' | 'retired';
  stem?: string;
  passage?: string | null;
  answerIndex?: number;
  audioSourceId?: number | null;
  audioStartMs?: number | null;
  audioEndMs?: number | null;
  stimulusGroupId?: string | null;
  stimulusGroupOrdinal?: number | null;
  turns?: readonly { speaker: string; gender: string; text: string }[] | null;
}): Promise<number> {
  const section = overrides.section ?? 'reading';
  const kind = overrides.kind ?? (section === 'reading' ? 'passage-mc' : 'audio-mc');
  const choices = [{ kr: '정답' }, { kr: '오답1' }, { kr: '오답2' }, { kr: '오답3' }];
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO generated_items
       (section, level, kind, stem, passage, choices, answer_index, explain, source_ref,
        status, created_by, model_id, prompt_hash, audio_source_id, audio_start_ms, audio_end_ms,
        stimulus_group_id, stimulus_group_ordinal, turns)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'explain', 'test-seed-ref',
             $8, 'test-fixture', 'claude-sonnet-4-6', $9, $10, $11, $12, $13, $14, $15::jsonb)
     RETURNING id`,
    [
      section,
      overrides.level ?? 'L3',
      kind,
      overrides.stem ?? `stem-${nextHash().slice(0, 8)}`,
      overrides.passage ?? (section === 'reading' ? '지문' : null),
      JSON.stringify(choices),
      overrides.answerIndex ?? 0,
      overrides.status ?? 'approved',
      nextHash(),
      overrides.audioSourceId ?? null,
      overrides.audioStartMs ?? null,
      overrides.audioEndMs ?? null,
      overrides.stimulusGroupId ?? null,
      overrides.stimulusGroupOrdinal ?? null,
      overrides.turns !== undefined ? JSON.stringify(overrides.turns) : null,
    ],
  );
  return Number(rows[0]!.id);
}

let listeningFixtureUserId: number | null = null;
let audioSlugSeq = 0;

async function seedAudioTrack(
  pool: Pool,
  opts: { durationMs?: number } = {},
): Promise<{ sourceId: number; trackId: number }> {
  if (listeningFixtureUserId === null) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash)
       VALUES ('mock-assembler-fixture@test.dev', '$argon2id$' || repeat('x', 70))
       RETURNING id`,
    );
    listeningFixtureUserId = Number(rows[0]!.id);
  }
  audioSlugSeq += 1;
  const src = await pool.query<{ id: string }>(
    `INSERT INTO audio_sources (user_id, slug, title, kind, status, is_shared)
     VALUES ($1, $2, 'mock listening audio', 'generated_listening', 'ready', true)
     RETURNING id`,
    [listeningFixtureUserId, `assembler-listening-${String(audioSlugSeq)}`],
  );
  const sourceId = Number(src.rows[0]!.id);
  const trk = await pool.query<{ id: string }>(
    `INSERT INTO audio_tracks (source_id, user_id, track_number, title, blob_ref, byte_size, duration_ms, transcript_status)
     VALUES ($1, $2, 1, 'mock', $3, 100, $4, 'done')
     RETURNING id`,
    [sourceId, listeningFixtureUserId, `${String(listeningFixtureUserId)}/assembler-${String(audioSlugSeq)}.mp3`, opts.durationMs ?? 4000],
  );
  return { sourceId, trackId: Number(trk.rows[0]!.id) };
}

describe('assembleGeneratedMock — thin/empty bank never crashes', () => {
  it('returns an empty item set (never throws) when the bank has nothing at all', async () => {
    const result = await assembleGeneratedMock('II', 'reading', exec);
    expect(result.items).toEqual([]);
    expect(result.requestedCount).toBeGreaterThan(0);
  });

  it('fills only the slots the bank actually has, skipping unfillable ones, in blueprint order', async () => {
    // Only fund the FIRST single-item kind block of TOPIK II reading
    // (fill-blank, count 2) — every other slot (match-content, sentence-order,
    // …, the paired block) stays empty.
    const id1 = await insertItem({ section: 'reading', level: 'L3', kind: 'fill-blank' });
    const id2 = await insertItem({ section: 'reading', level: 'L4', kind: 'fill-blank' });

    const result = await assembleGeneratedMock('II', 'reading', exec);
    expect(result.items).toHaveLength(2);
    expect(result.items.every((it) => it.kind === 'fill-blank')).toBe(true);
    expect(new Set(result.items.map((it) => it.id))).toEqual(
      new Set([`single:${String(id1)}`, `single:${String(id2)}`]),
    );
    expect(result.requestedCount).toBeGreaterThan(2);
  });
});

describe('assembleGeneratedMock — composition ORDER (TOPIK_STRUCTURE_ANALYSIS §3/§6)', () => {
  it('TOPIK II reading: single-item kind blocks appear in blueprint order, ahead of the paired block', async () => {
    const blueprint = MOCK_BLUEPRINT.II.reading;
    // Fund every single-item kind slot with exactly enough approved rows
    // (across the tier's pool levels so the ramp always finds something),
    // and fund the paired block too — proves the FULL declared order.
    for (const slot of blueprint) {
      if ('kind' in slot) {
        for (let i = 0; i < slot.count; i += 1) {
          await insertItem({ section: 'reading', level: 'L4', kind: slot.kind });
        }
      } else {
        // Two 2-question paired groups — enough to prove the block lands
        // as a contiguous run at the END, without needing to fully hit
        // targetItems (thin-bank posture covers the "less than target" case
        // separately below).
        for (const gid of ['ord-grp-a', 'ord-grp-b']) {
          await insertItem({
            section: 'reading',
            level: 'L4',
            kind: 'paired-passage-mc',
            passage: `공유 지문 ${gid}`,
            stimulusGroupId: gid,
            stimulusGroupOrdinal: 1,
          });
          await insertItem({
            section: 'reading',
            level: 'L4',
            kind: 'paired-passage-mc',
            passage: `공유 지문 ${gid}`,
            stimulusGroupId: gid,
            stimulusGroupOrdinal: 2,
          });
        }
      }
    }

    const result = await assembleGeneratedMock('II', 'reading', exec);

    // Walk the result in lockstep with the blueprint's declared kind
    // sequence: every single-item slot's kind block occupies a contiguous
    // run of the right length, in order.
    let cursor = 0;
    for (const slot of blueprint) {
      if ('kind' in slot) {
        const run = result.items.slice(cursor, cursor + slot.count);
        expect(run).toHaveLength(slot.count);
        expect(run.every((it) => it.kind === slot.kind)).toBe(true);
        cursor += slot.count;
      }
    }
    // Everything from `cursor` onward is the paired block (2 groups x 2
    // questions = 4 items), and it is the LAST thing in the array.
    const tail = result.items.slice(cursor);
    expect(tail).toHaveLength(4);
    expect(tail.every((it) => it.kind === 'paired-passage-mc')).toBe(true);
    expect(cursor + tail.length).toBe(result.items.length);
  });

  it('a paired group\'s questions stay adjacent and share the group\'s passage', async () => {
    const gid = 'adjacency-grp';
    await insertItem({
      section: 'reading',
      level: 'L4',
      kind: 'paired-passage-mc',
      passage: '인접성 테스트 지문',
      stimulusGroupId: gid,
      stimulusGroupOrdinal: 1,
    });
    await insertItem({
      section: 'reading',
      level: 'L4',
      kind: 'paired-passage-mc',
      passage: '인접성 테스트 지문',
      stimulusGroupId: gid,
      stimulusGroupOrdinal: 2,
    });
    const result = await assembleGeneratedMock('II', 'reading', exec);
    const groupItems = result.items.filter((it) => it.id.startsWith(`group:${gid}:`));
    expect(groupItems).toHaveLength(2);
    // Adjacent in the final array.
    const indices = groupItems.map((it) => result.items.indexOf(it)).sort((a, b) => a - b);
    expect(indices[1]).toBe(indices[0]! + 1);
    for (const it of groupItems) expect(it.passage).toBe('인접성 테스트 지문');
  });
});

describe('assembleGeneratedMock — tier level pooling', () => {
  it('tier I never draws an L3+ row; tier II never draws an L1/L2 row', async () => {
    await insertItem({ section: 'reading', level: 'L4', kind: 'topic-id' }); // tier II pool only
    await insertItem({ section: 'reading', level: 'L1', kind: 'main-idea' }); // tier I pool only

    const tierI = await assembleGeneratedMock('I', 'reading', exec);
    // topic-id IS in tier I's blueprint (count 3) but the only topic-id row
    // is L4 (outside tier I's [L1,L2] pool) — must not appear.
    expect(tierI.items.some((it) => it.kind === 'topic-id')).toBe(false);
    // main-idea IS in tier I's blueprint and the L1 row is in-pool — must appear.
    expect(tierI.items.some((it) => it.kind === 'main-idea')).toBe(true);

    const tierII = await assembleGeneratedMock('II', 'reading', exec);
    // main-idea IS in tier II's blueprint (count 4) but the only main-idea
    // row is L1 (outside tier II's [L3,L4,L5+] pool) — must not appear.
    expect(tierII.items.some((it) => it.kind === 'main-idea')).toBe(false);
  });
});

describe('assembleGeneratedMock — NO-LEAK on the assembled snapshot', () => {
  const SECRET = '조립기 스냅샷에 절대 남으면 안 되는 리스닝 대본';

  it('a singly-drawn listening item never carries a transcript field', async () => {
    const { sourceId } = await seedAudioTrack(pg.pool, { durationMs: 5000 });
    // TOPIK II listening blueprint's first slot is kind='whats-next'.
    await insertItem({
      section: 'listening',
      level: 'L4',
      kind: 'whats-next',
      audioSourceId: sourceId,
      audioStartMs: 0,
      audioEndMs: 5000,
      turns: [{ speaker: 'narrator', gender: 'narrator', text: SECRET }],
    });
    const result = await assembleGeneratedMock('II', 'listening', exec);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    for (const item of result.items) {
      expect(Object.keys(item)).not.toContain('turns');
    }
  });

  it('a paired-listening group\'s flattened questions never carry a transcript field', async () => {
    const { sourceId, trackId } = await seedAudioTrack(pg.pool, { durationMs: 6000 });
    const gid = 'no-leak-grp';
    await insertItem({
      section: 'listening',
      level: 'L4',
      kind: 'paired-audio-mc',
      audioSourceId: sourceId,
      audioStartMs: 0,
      audioEndMs: 6000,
      stimulusGroupId: gid,
      stimulusGroupOrdinal: 1,
      turns: [{ speaker: 'narrator', gender: 'narrator', text: SECRET }],
    });
    await insertItem({
      section: 'listening',
      level: 'L4',
      kind: 'paired-audio-mc',
      audioSourceId: sourceId,
      audioStartMs: 0,
      audioEndMs: 6000,
      stimulusGroupId: gid,
      stimulusGroupOrdinal: 2,
      turns: [{ speaker: 'narrator', gender: 'narrator', text: SECRET }],
    });
    const result = await assembleGeneratedMock('II', 'listening', exec);
    const groupItems = result.items.filter((it) => it.id.startsWith(`group:${gid}:`));
    expect(groupItems.length).toBeGreaterThan(0);
    for (const it of groupItems) {
      expect(it.audioUrl).toBe(`/audio/tracks/${String(trackId)}/stream`);
      expect(Object.keys(it)).not.toContain('turns');
    }
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe('toClientMockItem — the type-level answer strip', () => {
  it('drops correctChoiceId and explanation; keeps every client-safe field', async () => {
    await insertItem({ section: 'reading', level: 'L4', kind: 'fill-blank', answerIndex: 2 });
    const result = await assembleGeneratedMock('II', 'reading', exec);
    const server = result.items[0]!;
    expect(server.correctChoiceId).toBeDefined();
    expect(server.explanation).toBeDefined();

    const client = toClientMockItem(server);
    expect(client).not.toHaveProperty('correctChoiceId');
    expect(client).not.toHaveProperty('explanation');
    expect(client.id).toBe(server.id);
    expect(client.kind).toBe(server.kind);
    expect(client.prompt).toBe(server.prompt);
    expect(client.choices).toEqual(server.choices);
  });
});
