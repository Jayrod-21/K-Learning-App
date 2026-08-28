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
import {
  pickGeneratedItem,
  pickGeneratedItemOfKind,
  pickGeneratedStimulusGroup,
  pickGeneratedStimulusGroupExcludingGroups,
  pickGeneratedWritingItem,
} from '../../../src/services/diagnostic/generatedBank.js';
import type { WritingItemKind, WritingItemRubric } from '../../../src/services/claude/models.js';

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
  await pg.pool.query(`DELETE FROM generated_writing_items`);
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
  /** F-220 P1 — set to make this row part of a stimulus group. */
  stimulusGroupId?: string | null;
  stimulusGroupOrdinal?: number | null;
  /** F-220 P1 — the shared dialogue script (paired-listening no-leak test
   *  fixture); NEVER selected by pickGeneratedStimulusGroup. */
  turns?: readonly { speaker: string; gender: string; text: string }[] | null;
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
        status, created_by, model_id, prompt_hash, audio_source_id, audio_start_ms, audio_end_ms,
        stimulus_group_id, stimulus_group_ordinal, turns)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'test-seed-ref',
             $9, 'test-fixture', 'claude-sonnet-4-6', $10, $11, $12, $13, $14, $15, $16::jsonb)
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
      overrides.stimulusGroupId ?? null,
      overrides.stimulusGroupOrdinal ?? null,
      overrides.turns !== undefined ? JSON.stringify(overrides.turns) : null,
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

describe('pickGeneratedStimulusGroup — paired-reading (F-220 P1)', () => {
  it('draws a complete approved group: shared passage + ordered questions', async () => {
    const gid = 'grp-reading-1';
    const passage = '오늘은 날씨가 맑고 따뜻합니다. 사람들이 공원에서 산책을 합니다. 어떤 사람들은 자전거를 탑니다.';
    await insertItem({
      section: 'reading',
      level: 'L3',
      kind: 'paired-passage-mc',
      stem: '이 글의 중심 내용은 무엇입니까?',
      passage,
      choices: [
        { kr: '날씨', en: 'weather' },
        { kr: '음식' },
        { kr: '교통' },
        { kr: '건강' },
      ],
      answerIndex: 0,
      explain: 'main idea explain',
      stimulusGroupId: gid,
      stimulusGroupOrdinal: 1,
    });
    await insertItem({
      section: 'reading',
      level: 'L3',
      kind: 'paired-passage-mc',
      stem: '사람들이 공원에서 하지 않는 것은 무엇입니까?',
      passage,
      choices: [
        { kr: '수영' },
        { kr: '산책' },
        { kr: '자전거 타기' },
        { kr: '독서' },
      ],
      answerIndex: 0,
      explain: 'detail explain',
      stimulusGroupId: gid,
      stimulusGroupOrdinal: 2,
    });

    const result = await pickGeneratedStimulusGroup('reading', 'L3', exec);
    expect(result).not.toBeNull();
    expect(result!.groupId).toBe(gid);
    expect(result!.section).toBe('reading');
    expect(result!.passage).toBe(passage);
    expect(result!.audioUrl).toBeUndefined();
    expect(result!.questions).toHaveLength(2);
    expect(result!.questions[0]!.prompt).toBe('이 글의 중심 내용은 무엇입니까?');
    expect(result!.questions[0]!.explain).toBe('main idea explain');
    expect(result!.questions[1]!.prompt).toBe('사람들이 공원에서 하지 않는 것은 무엇입니까?');
    expect(result!.questions[0]!.correctAnswer).toBe('a');
  });

  it('excludes a group where NOT every row is approved (mixed status)', async () => {
    const gid = 'grp-reading-mixed';
    await insertItem({
      section: 'reading',
      kind: 'paired-passage-mc',
      status: 'approved',
      stimulusGroupId: gid,
      stimulusGroupOrdinal: 1,
    });
    await insertItem({
      section: 'reading',
      kind: 'paired-passage-mc',
      status: 'draft',
      stimulusGroupId: gid,
      stimulusGroupOrdinal: 2,
    });
    const result = await pickGeneratedStimulusGroup('reading', 'L3', exec);
    expect(result).toBeNull();
  });

  it('excludes a standalone (non-grouped) passage-mc row — only paired-passage-mc groups are drawn', async () => {
    await insertItem({ section: 'reading', kind: 'passage-mc', status: 'approved' });
    const result = await pickGeneratedStimulusGroup('reading', 'L3', exec);
    expect(result).toBeNull();
  });

  it('draws only from the requested level, never a group at a different level', async () => {
    const gid = 'grp-reading-l4';
    await insertItem({
      section: 'reading',
      level: 'L4',
      kind: 'paired-passage-mc',
      stimulusGroupId: gid,
      stimulusGroupOrdinal: 1,
    });
    await insertItem({
      section: 'reading',
      level: 'L4',
      kind: 'paired-passage-mc',
      stimulusGroupId: gid,
      stimulusGroupOrdinal: 2,
    });
    const missL3 = await pickGeneratedStimulusGroup('reading', 'L3', exec);
    expect(missL3).toBeNull();
    const hitL4 = await pickGeneratedStimulusGroup('reading', 'L4', exec);
    expect(hitL4).not.toBeNull();
    expect(hitL4!.groupId).toBe(gid);
  });

  it('returns null when no paired-reading group exists for the cell', async () => {
    const result = await pickGeneratedStimulusGroup('reading', 'L2', exec);
    expect(result).toBeNull();
  });
});

describe('pickGeneratedStimulusGroup — paired-listening (F-220 P1) + NO-LEAK proof', () => {
  const SECRET_TRANSCRIPT_MARKER = '민수가 몰래 말하는 비밀 대사 절대 유출 금지';

  it('draws a complete, audio-ready group: shared audioUrl/offsets + ordered questions, NEVER the transcript', async () => {
    const { sourceId, trackId } = await seedAudioTrack(pg.pool, { durationMs: 6100 });
    const gid = 'grp-listening-1';
    const sharedTurns = [
      { speaker: 'narrator', gender: 'narrator', text: SECRET_TRANSCRIPT_MARKER },
      { speaker: '민수', gender: 'male', text: '오늘 날씨가 참 좋네요.' },
    ];
    await insertItem({
      section: 'listening',
      level: 'L3',
      kind: 'paired-audio-mc',
      stem: '두 사람은 무엇에 대해 이야기합니까?',
      choices: [{ kr: '날씨' }, { kr: '음식' }, { kr: '교통' }, { kr: '건강' }],
      answerIndex: 0,
      explain: 'topic explain',
      audioSourceId: sourceId,
      audioStartMs: 0,
      audioEndMs: 6100,
      stimulusGroupId: gid,
      stimulusGroupOrdinal: 1,
      turns: sharedTurns,
    });
    await insertItem({
      section: 'listening',
      level: 'L3',
      kind: 'paired-audio-mc',
      stem: '민수는 오늘 날씨를 어떻게 생각합니까?',
      choices: [{ kr: '좋다' }, { kr: '나쁘다' }, { kr: '모르겠다' }, { kr: '춥다' }],
      answerIndex: 0,
      explain: 'attitude explain',
      audioSourceId: sourceId,
      audioStartMs: 0,
      audioEndMs: 6100,
      stimulusGroupId: gid,
      stimulusGroupOrdinal: 2,
      turns: sharedTurns,
    });

    const result = await pickGeneratedStimulusGroup('listening', 'L3', exec);
    expect(result).not.toBeNull();
    expect(result!.groupId).toBe(gid);
    expect(result!.section).toBe('listening');
    expect(result!.audioUrl).toBe(`/audio/tracks/${String(trackId)}/stream`);
    expect(result!.audioStartMs).toBe(0);
    expect(result!.audioEndMs).toBe(6100);
    expect(result!.passage).toBeUndefined();
    expect(result!.questions).toHaveLength(2);
    expect(result!.questions[0]!.prompt).toBe('두 사람은 무엇에 대해 이야기합니까?');
    expect(result!.questions[1]!.prompt).toBe('민수는 오늘 날씨를 어떻게 생각합니까?');

    // NO-LEAK: the transcript text must not appear ANYWHERE in the drawn
    // result — not as a top-level field, not nested inside a question, not
    // stringified. This is the load-bearing assertion for F-220 P1's
    // "paired-audio must never expose the transcript as readable text"
    // hard constraint.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_TRANSCRIPT_MARKER);
    expect(serialized).not.toContain('narrator');
    expect(Object.keys(result as object)).not.toContain('turns');
  });

  it('excludes a listening group where audio is NOT yet synthesized on every row (draft-or-silent)', async () => {
    const { sourceId } = await seedAudioTrack(pg.pool);
    const gid = 'grp-listening-partial-audio';
    await insertItem({
      section: 'listening',
      kind: 'paired-audio-mc',
      status: 'approved',
      audioSourceId: sourceId,
      audioStartMs: 0,
      audioEndMs: 4000,
      stimulusGroupId: gid,
      stimulusGroupOrdinal: 1,
    });
    // Sibling row has NO audio yet — the group is not "complete".
    await insertItem({
      section: 'listening',
      kind: 'paired-audio-mc',
      status: 'approved',
      audioSourceId: null,
      stimulusGroupId: gid,
      stimulusGroupOrdinal: 2,
    });
    const result = await pickGeneratedStimulusGroup('listening', 'L3', exec);
    expect(result).toBeNull();
  });

  it('excludes a listening group where not every row is approved', async () => {
    const { sourceId } = await seedAudioTrack(pg.pool);
    const gid = 'grp-listening-mixed-status';
    await insertItem({
      section: 'listening',
      kind: 'paired-audio-mc',
      status: 'approved',
      audioSourceId: sourceId,
      audioStartMs: 0,
      audioEndMs: 4000,
      stimulusGroupId: gid,
      stimulusGroupOrdinal: 1,
    });
    await insertItem({
      section: 'listening',
      kind: 'paired-audio-mc',
      status: 'draft',
      audioSourceId: sourceId,
      audioStartMs: 0,
      audioEndMs: 4000,
      stimulusGroupId: gid,
      stimulusGroupOrdinal: 2,
    });
    const result = await pickGeneratedStimulusGroup('listening', 'L3', exec);
    expect(result).toBeNull();
  });

  it('excludes a standalone (non-grouped) audio-mc row — only paired-audio-mc groups are drawn', async () => {
    const { sourceId } = await seedAudioTrack(pg.pool);
    await insertItem({
      section: 'listening',
      kind: 'audio-mc',
      status: 'approved',
      audioSourceId: sourceId,
      audioStartMs: 0,
      audioEndMs: 4000,
    });
    const result = await pickGeneratedStimulusGroup('listening', 'L3', exec);
    expect(result).toBeNull();
  });

  it('returns null when no paired-listening group exists for the cell', async () => {
    const result = await pickGeneratedStimulusGroup('listening', 'L1', exec);
    expect(result).toBeNull();
  });
});

describe('pickGeneratedItemOfKind (F-220 P3 — the mock assembler kind-aware draw)', () => {
  it('draws an EXACT kind match, unlike pickGeneratedItem\'s fixed section<->kind contract', async () => {
    const id = await insertItem({
      section: 'reading',
      level: 'L3',
      kind: 'fill-blank',
      stem: '빈칸에 알맞은 것을 고르십시오.',
      answerIndex: 1,
      explain: 'fill-blank explain',
    });
    // pickGeneratedItem('reading', ...) would NEVER return this row — it only
    // ever matches kind='passage-mc' for section='reading'.
    const viaFixedContract = await pickGeneratedItem('reading', 'L3', exec);
    expect(viaFixedContract).toBeNull();

    const result = await pickGeneratedItemOfKind('reading', 'L3', 'fill-blank', [], exec);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(id);
    expect(result!.kind).toBe('fill-blank');
    expect(result!.explain).toBe('fill-blank explain');
    expect(result!.correctAnswer).toBe('b');
  });

  it('only matches approved rows, and only the requested (section, level, kind) cell', async () => {
    await insertItem({ section: 'reading', level: 'L3', kind: 'fill-blank', status: 'draft' });
    await insertItem({ section: 'reading', level: 'L4', kind: 'fill-blank', status: 'approved' }); // wrong level
    await insertItem({ section: 'listening', level: 'L3', kind: 'fill-blank', status: 'approved' }); // wrong section
    await insertItem({ section: 'reading', level: 'L3', kind: 'topic-id', status: 'approved' }); // wrong kind
    const miss = await pickGeneratedItemOfKind('reading', 'L3', 'fill-blank', [], exec);
    expect(miss).toBeNull();

    const id = await insertItem({ section: 'reading', level: 'L3', kind: 'fill-blank', status: 'approved' });
    const hit = await pickGeneratedItemOfKind('reading', 'L3', 'fill-blank', [], exec);
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe(id);
  });

  it('excludeIds keeps repeated draws of the SAME kind within one assembly distinct', async () => {
    const id1 = await insertItem({ section: 'reading', level: 'L3', kind: 'match-content' });
    const id2 = await insertItem({ section: 'reading', level: 'L3', kind: 'match-content' });

    const first = await pickGeneratedItemOfKind('reading', 'L3', 'match-content', [], exec);
    expect(first).not.toBeNull();
    const drawnIds = new Set<number>([first!.id]);

    const second = await pickGeneratedItemOfKind('reading', 'L3', 'match-content', [...drawnIds], exec);
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first!.id);
    drawnIds.add(second!.id);
    expect(drawnIds).toEqual(new Set([id1, id2]));

    // Every row now excluded — the cell is exhausted, not an error.
    const third = await pickGeneratedItemOfKind('reading', 'L3', 'match-content', [...drawnIds], exec);
    expect(third).toBeNull();
  });

  it('excludes a paired-stimulus-group MEMBER row even if its kind matches — groups are drawn only via the group functions', async () => {
    const gid = 'grp-fillblank-exclusion';
    await insertItem({
      section: 'reading',
      level: 'L3',
      kind: 'paired-passage-mc',
      status: 'approved',
      stimulusGroupId: gid,
      stimulusGroupOrdinal: 1,
    });
    const result = await pickGeneratedItemOfKind('reading', 'L3', 'paired-passage-mc', [], exec);
    expect(result).toBeNull();
  });

  it('listening kind draw requires synthesized audio (audio_source_id NOT NULL), NEVER returns the transcript', async () => {
    const SECRET = '절대 유출되면 안 되는 리스닝 대본';
    await insertItem({
      section: 'listening',
      level: 'L3',
      kind: 'whats-next',
      status: 'approved',
      audioSourceId: null, // not synthesized yet
      turns: [{ speaker: 'narrator', gender: 'narrator', text: SECRET }],
    });
    const notReady = await pickGeneratedItemOfKind('listening', 'L3', 'whats-next', [], exec);
    expect(notReady).toBeNull();

    const { sourceId, trackId } = await seedAudioTrack(pg.pool, { durationMs: 5000 });
    const id = await insertItem({
      section: 'listening',
      level: 'L3',
      kind: 'whats-next',
      status: 'approved',
      audioSourceId: sourceId,
      audioStartMs: 0,
      audioEndMs: 5000,
      turns: [{ speaker: 'narrator', gender: 'narrator', text: SECRET }],
    });
    const ready = await pickGeneratedItemOfKind('listening', 'L3', 'whats-next', [], exec);
    expect(ready).not.toBeNull();
    expect(ready!.id).toBe(id);
    expect(ready!.audioUrl).toBe(`/audio/tracks/${String(trackId)}/stream`);

    const serialized = JSON.stringify(ready);
    expect(serialized).not.toContain(SECRET);
    expect(Object.keys(ready as object)).not.toContain('turns');
  });
});

describe('pickGeneratedStimulusGroupExcludingGroups (F-220 P3 — repeated paired-block draws)', () => {
  it('excludeGroupIds keeps repeated paired-block draws within one assembly distinct', async () => {
    const gidA = 'grp-exclude-a';
    const gidB = 'grp-exclude-b';
    for (const gid of [gidA, gidB]) {
      await insertItem({
        section: 'reading',
        level: 'L4',
        kind: 'paired-passage-mc',
        stimulusGroupId: gid,
        stimulusGroupOrdinal: 1,
      });
      await insertItem({
        section: 'reading',
        level: 'L4',
        kind: 'paired-passage-mc',
        stimulusGroupId: gid,
        stimulusGroupOrdinal: 2,
      });
    }

    const first = await pickGeneratedStimulusGroupExcludingGroups('reading', 'L4', [], exec);
    expect(first).not.toBeNull();
    const drawnGroupIds = new Set<string>([first!.groupId]);

    const second = await pickGeneratedStimulusGroupExcludingGroups(
      'reading',
      'L4',
      [...drawnGroupIds],
      exec,
    );
    expect(second).not.toBeNull();
    expect(second!.groupId).not.toBe(first!.groupId);
    drawnGroupIds.add(second!.groupId);
    expect(drawnGroupIds).toEqual(new Set([gidA, gidB]));

    // Both groups now excluded — the cell is exhausted, not an error.
    const third = await pickGeneratedStimulusGroupExcludingGroups(
      'reading',
      'L4',
      [...drawnGroupIds],
      exec,
    );
    expect(third).toBeNull();
  });

  it('excludeGroupIds=[] behaves exactly like pickGeneratedStimulusGroup for a single available group', async () => {
    const gid = 'grp-exclude-parity';
    await insertItem({
      section: 'reading',
      level: 'L2',
      kind: 'paired-passage-mc',
      passage: '패리티 테스트용 지문입니다.',
      stimulusGroupId: gid,
      stimulusGroupOrdinal: 1,
    });
    await insertItem({
      section: 'reading',
      level: 'L2',
      kind: 'paired-passage-mc',
      passage: '패리티 테스트용 지문입니다.',
      stimulusGroupId: gid,
      stimulusGroupOrdinal: 2,
    });
    const viaExisting = await pickGeneratedStimulusGroup('reading', 'L2', exec);
    const viaExcluding = await pickGeneratedStimulusGroupExcludingGroups('reading', 'L2', [], exec);
    expect(viaExcluding).not.toBeNull();
    expect(viaExcluding!.groupId).toBe(viaExisting!.groupId);
    expect(viaExcluding!.questions).toHaveLength(viaExisting!.questions.length);
  });
});

// -----------------------------------------------------------------------------
// F-220 P4 — pickGeneratedWritingItem (writing-item draw, ships DARK — no
// route wires this yet, see the migration 108 / generatedBank.ts header).
// -----------------------------------------------------------------------------

const GOOD_ESSAY_RUBRIC: WritingItemRubric = {
  kind: 'essay',
  maxScore: 50,
  criteria: [
    { name: 'content', maxScore: 20, descriptor: 'addresses the prompt' },
    { name: 'organization', maxScore: 20, descriptor: 'clear structure' },
    { name: 'languageUse', maxScore: 10, descriptor: 'accurate grammar' },
  ],
};

const GOOD_BLANKS_RUBRIC: WritingItemRubric = {
  kind: 'short-answer-blanks',
  maxScore: 10,
  criteria: [
    { name: 'blank1', maxScore: 5, descriptor: 'appropriate for ㉠' },
    { name: 'blank2', maxScore: 5, descriptor: 'appropriate for ㉡' },
  ],
};

async function insertWritingItem(overrides: {
  level?: string;
  kind?: WritingItemKind;
  prompt?: string;
  stimulus?: string | null;
  rubric?: WritingItemRubric;
  modelAnswer?: string | null;
  minWords?: number | null;
  maxWords?: number | null;
  status?: 'draft' | 'approved' | 'rejected';
}): Promise<number> {
  const kind = overrides.kind ?? 'essay';
  const rubric = overrides.rubric ?? (kind === 'short-answer-blanks' ? GOOD_BLANKS_RUBRIC : GOOD_ESSAY_RUBRIC);
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO generated_writing_items
       (level, kind, prompt, stimulus, rubric, model_answer, min_words, max_words,
        source_ref, status, created_by, model_id, prompt_hash)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8,
             'test-seed-ref', $9, 'test-fixture', 'claude-sonnet-4-6', $10)
     RETURNING id`,
    [
      overrides.level ?? 'L4',
      kind,
      overrides.prompt ?? 'mock writing prompt',
      overrides.stimulus ?? null,
      JSON.stringify(rubric),
      overrides.modelAnswer ?? null,
      overrides.minWords ?? null,
      overrides.maxWords ?? null,
      overrides.status ?? 'approved',
      nextHash(),
    ],
  );
  return Number(rows[0]!.id);
}

describe('pickGeneratedWritingItem', () => {
  it('returns null when the bank is empty for the (level, kind) cell', async () => {
    const result = await pickGeneratedWritingItem('L4', 'essay', [], exec);
    expect(result).toBeNull();
  });

  it('returns null when only OTHER cells / OTHER kinds / OTHER statuses are populated', async () => {
    await insertWritingItem({ level: 'L5+', kind: 'essay', status: 'approved' }); // wrong level
    await insertWritingItem({ level: 'L4', kind: 'chart-description', status: 'approved' }); // wrong kind
    await insertWritingItem({ level: 'L4', kind: 'essay', status: 'draft' }); // wrong status
    await insertWritingItem({ level: 'L4', kind: 'essay', status: 'rejected' }); // wrong status

    const result = await pickGeneratedWritingItem('L4', 'essay', [], exec);
    expect(result).toBeNull();
  });

  it('approved-only: draft/rejected rows are never drawn even when they are the ONLY rows at the cell', async () => {
    await insertWritingItem({ level: 'L4', kind: 'essay', status: 'draft' });
    const miss1 = await pickGeneratedWritingItem('L4', 'essay', [], exec);
    expect(miss1).toBeNull();

    await insertWritingItem({ level: 'L4', kind: 'essay', status: 'rejected' });
    const miss2 = await pickGeneratedWritingItem('L4', 'essay', [], exec);
    expect(miss2).toBeNull();
  });

  it('draws an approved essay row — no stimulus/modelAnswer, minWords/maxWords present', async () => {
    const id = await insertWritingItem({
      level: 'L4',
      kind: 'essay',
      prompt: '다음 주제에 대해 600~700자로 자신의 의견을 쓰십시오.',
      rubric: GOOD_ESSAY_RUBRIC,
      minWords: 600,
      maxWords: 700,
    });

    const result = await pickGeneratedWritingItem('L4', 'essay', [], exec);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(id);
    expect(result!.kind).toBe('essay');
    expect(result!.level).toBe('L4');
    expect(result!.prompt).toBe('다음 주제에 대해 600~700자로 자신의 의견을 쓰십시오.');
    expect(result!.stimulus).toBeUndefined();
    expect(result!.modelAnswer).toBeUndefined();
    expect(result!.minWords).toBe(600);
    expect(result!.maxWords).toBe(700);
    expect(result!.rubric).toEqual(GOOD_ESSAY_RUBRIC);
    expect(result!.sourceRef).toBe(`bank:${String(id)}`);
  });

  it('draws an approved short-answer-blanks row — stimulus + modelAnswer present, minWords/maxWords absent', async () => {
    const id = await insertWritingItem({
      level: 'L3',
      kind: 'short-answer-blanks',
      prompt: '다음을 읽고 ㉠과 ㉡에 들어갈 말을 각각 쓰십시오.',
      stimulus: '안녕하세요. ( ㉠ ) 회의 시간이 변경되었습니다. ( ㉡ ).',
      modelAnswer: '㉠: 알려 드립니다 / ㉡: 참고 부탁드립니다',
      rubric: GOOD_BLANKS_RUBRIC,
    });

    const result = await pickGeneratedWritingItem('L3', 'short-answer-blanks', [], exec);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(id);
    expect(result!.stimulus).toBe('안녕하세요. ( ㉠ ) 회의 시간이 변경되었습니다. ( ㉡ ).');
    expect(result!.modelAnswer).toBe('㉠: 알려 드립니다 / ㉡: 참고 부탁드립니다');
    expect(result!.minWords).toBeUndefined();
    expect(result!.maxWords).toBeUndefined();
  });

  it('excludeIds excludes an already-drawn id, falling through to the other approved row', async () => {
    const id1 = await insertWritingItem({ level: 'L4', kind: 'essay' });
    const id2 = await insertWritingItem({ level: 'L4', kind: 'essay' });

    const first = await pickGeneratedWritingItem('L4', 'essay', [], exec);
    expect(first).not.toBeNull();
    expect([id1, id2]).toContain(first!.id);

    const second = await pickGeneratedWritingItem('L4', 'essay', [first!.id], exec);
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first!.id);
    expect([id1, id2]).toContain(second!.id);

    // Both drawn ids excluded -> nothing left.
    const third = await pickGeneratedWritingItem('L4', 'essay', [id1, id2], exec);
    expect(third).toBeNull();
  });

  it('generated_items (the MCQ bank) is never touched by this draw — cross-table isolation', async () => {
    await insertItem({ section: 'reading', level: 'L4', kind: 'passage-mc', status: 'approved' });
    await insertWritingItem({ level: 'L4', kind: 'essay', status: 'approved' });

    const writingDraw = await pickGeneratedWritingItem('L4', 'essay', [], exec);
    expect(writingDraw).not.toBeNull();

    // pickGeneratedItem must not be able to see the writing row either
    // (different table, different shape entirely).
    const mcqDraw = await pickGeneratedItem('reading', 'L4', exec);
    expect(mcqDraw).not.toBeNull();
    expect(mcqDraw!.kind).toBe('passage-mc');
  });
});
