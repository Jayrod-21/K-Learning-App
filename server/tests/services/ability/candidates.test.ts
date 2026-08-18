/**
 * candidates — per-dimension recommendation candidate generators over real
 * Postgres (F-212 P4). The generators' value is query correctness against the
 * real content tables (reading UNION reuse, iyagi shape, the /vocab/cards/due
 * predicate, the grammar bank read), so only a real engine running the real
 * migration chain proves: per-dimension row sourcing, due-first ordering, the
 * band fallbacks, deep-link construction, b anchoring, and tenant scoping.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../../helpers/pg.js';
import { setPoolForTesting } from '../../../src/db/pool.js';
import {
  fetchCandidates,
  type CandidateTargets,
} from '../../../src/services/ability/candidates.js';
import {
  seedBookUpload,
  seedGeneratedStory,
  seedIyagiEpisode,
  seedReadingChapter,
  seedReadingPassage,
  seedVocabEntry,
} from '../../helpers/seed.js';

let pg: PgHandle;

const FAKE_HASH = `$argon2id$${'x'.repeat(70)}`;

/** Every dimension probing mid-scale unless a test narrows it. */
const MID_TARGETS: CandidateTargets = {
  reading: 3.5,
  listening: 3.5,
  vocab: 3.5,
  grammar: 3.5,
};

beforeAll(async () => {
  pg = await startPostgres();
  setPoolForTesting(pg.pool);
});

afterAll(async () => {
  await stopPostgres(pg);
});

beforeEach(async () => {
  // users CASCADE clears vocab_cards, grammar_entries, reading_chapters,
  // generated_stories, book_uploads; the public corpora are cleared explicitly.
  await pg.pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
  await pg.pool.query('TRUNCATE TABLE iyagi_episodes, corpus_sources RESTART IDENTITY CASCADE');
});

async function seedUser(email: string): Promise<number> {
  const { rows } = await pg.pool.query<{ id: number }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
    [email, FAKE_HASH],
  );
  return rows[0]!.id;
}

/** A live vocab card over an entry with a controlled band + due offset. */
async function seedCard(
  userId: number,
  opts: {
    proficiency?: 'basic' | 'L3' | 'L4' | 'L5+';
    korean?: string;
    dueOffsetMs?: number;
    suspended?: boolean;
    deleted?: boolean;
  } = {},
): Promise<number> {
  const entryId = await seedVocabEntry(pg.pool, {
    proficiency: opts.proficiency ?? 'L3',
    korean: opts.korean ?? '먹다',
  });
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO vocab_cards (user_id, face, vocab_entry_id, due_at, suspended_at, deleted_at)
     VALUES ($1, 'recognition'::card_face, $2,
             now() + ($3::double precision * interval '1 millisecond'),
             CASE WHEN $4 THEN now() ELSE NULL END,
             CASE WHEN $5 THEN now() ELSE NULL END)
     RETURNING id`,
    [userId, entryId, opts.dueOffsetMs ?? -60_000, opts.suspended ?? false, opts.deleted ?? false],
  );
  return Number(rows[0]!.id);
}

/** A banked grammar_entries row (the POST /grammar/bank shape). */
async function seedGrammarEntry(
  userId: number,
  opts: {
    patternKey?: string;
    display?: string;
    proficiency?: 'basic' | 'L3' | 'L4' | 'L5+';
    graduated?: boolean;
  } = {},
): Promise<number> {
  const key = opts.patternKey ?? `GR-test-${Math.random().toString(36).slice(2, 10)}`;
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO grammar_entries
        (user_id, pattern_key, pattern_display, summary_en, proficiency,
         category, discovered_via, graduated_at)
     VALUES ($1, $2, $3, 'test summary', $4::proficiency_level,
             'test', 'manual', CASE WHEN $5 THEN now() ELSE NULL END)
     RETURNING id`,
    [userId, key, opts.display ?? '-어 보다', opts.proficiency ?? 'L3', opts.graduated ?? false],
  );
  return Number(rows[0]!.id);
}

/** A grammar PRODUCTION card over a banked entry, with a due offset. */
async function seedGrammarCard(
  userId: number,
  grammarEntryId: number,
  dueOffsetMs = -60_000,
): Promise<number> {
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO vocab_cards (user_id, face, grammar_entry_id, due_at)
     VALUES ($1, 'production'::card_face, $2,
             now() + ($3::double precision * interval '1 millisecond'))
     RETURNING id`,
    [userId, grammarEntryId, dueOffsetMs],
  );
  return Number(rows[0]!.id);
}

describe('reading candidates', () => {
  it('sources both chapters (b null) and stories (b from level), with deep links', async () => {
    const userId = await seedUser('cand-reading@example.com');
    const uploadId = await seedBookUpload(pg.pool, userId, { type: 'literature' });
    const chapterId = await seedReadingChapter(pg.pool, userId, uploadId, {
      chapterNumber: 2,
      title: null,
    });
    await seedReadingPassage(pg.pool, chapterId, { body: '가'.repeat(240) });
    const storyId = await seedGeneratedStory(pg.pool, userId, {
      level: 'L3',
      title: 'L3 story',
    });

    const { reading } = await fetchCandidates(userId, MID_TARGETS);
    expect(reading).toHaveLength(2);

    const chapter = reading.find((c) => c.sourceKind === 'chapter')!;
    expect(chapter.chapterId).toBe(chapterId);
    expect(chapter.b).toBeNull(); // chapters carry no band
    expect(chapter.deepLink).toBe(`/learn/reading?chapter=${String(chapterId)}`);
    expect(chapter.title).toBe('Chapter 2'); // NULL-title fallback, same as the tile
    expect(chapter.mins).toBe(2); // 240 chars @120/min
    expect(chapter.itemKey).toBe(`reading:chapter:${String(chapterId)}`);

    const story = reading.find((c) => c.sourceKind === 'story')!;
    expect(story.storyId).toBe(storyId);
    expect(story.b).toBe(3); // proficiencyToNumber('L3')
    expect(story.level).toBe('L3');
    expect(story.deepLink).toBe(`/learn/reading?story=${String(storyId)}`);
  });

  it('never surfaces another user’s reading rows; empty library → empty pool', async () => {
    const other = await seedUser('cand-reading-other@example.com');
    const uploadId = await seedBookUpload(pg.pool, other, { type: 'literature' });
    const chapterId = await seedReadingChapter(pg.pool, other, uploadId);
    await seedReadingPassage(pg.pool, chapterId);
    await seedGeneratedStory(pg.pool, other);

    const userId = await seedUser('cand-reading-empty@example.com');
    const { reading } = await fetchCandidates(userId, MID_TARGETS);
    expect(reading).toEqual([]);
  });
});

describe('listening candidates', () => {
  it('returns iyagi episodes, all unplaced, with the episode deep link', async () => {
    const userId = await seedUser('cand-listening@example.com');
    await seedIyagiEpisode(pg.pool, { number: 7 });

    const { listening } = await fetchCandidates(userId, MID_TARGETS);
    expect(listening).toHaveLength(1);
    expect(listening[0]).toMatchObject({
      itemKey: 'listening:iyagi:7',
      b: null,
      deepLink: '/learn/listen?corpus=iyagi&episode=7',
      level: 'L3→L4',
      corpus: 'iyagi',
      episodeNumber: 7,
      mins: 3, // 2 seeded sentences → 3-min floor, same as the tile
    });
  });
});

describe('vocab candidates', () => {
  it('due-first: due cards lead (oldest first) and non-eligible cards are excluded', async () => {
    const userId = await seedUser('cand-vocab-due@example.com');
    const oldest = await seedCard(userId, { korean: '오래', dueOffsetMs: -120_000 });
    const newer = await seedCard(userId, { korean: '최근', dueOffsetMs: -1_000 });
    await seedCard(userId, { dueOffsetMs: 86_400_000 }); // future → not due
    await seedCard(userId, { suspended: true }); // excluded
    await seedCard(userId, { deleted: true }); // excluded
    // A due grammar production card must NOT appear in the vocab dimension.
    const geId = await seedGrammarEntry(userId);
    await seedGrammarCard(userId, geId);

    const { vocab } = await fetchCandidates(userId, MID_TARGETS);
    expect(vocab.map((c) => c.itemKey)).toEqual([
      `vocab:card:${String(oldest)}`,
      `vocab:card:${String(newer)}`,
    ]);
    expect(vocab[0]!.title).toBe('오래');
    expect(vocab[0]!.b).toBe(3); // entry band L3
    expect(vocab[0]!.deepLink).toBe('/learn/vocab');
  });

  it('nothing due → live-deck fallback prefers the target band, then degrades unbanded', async () => {
    const userId = await seedUser('cand-vocab-fallback@example.com');
    await seedCard(userId, { proficiency: 'L3', korean: '기본', dueOffsetMs: 86_400_000 });
    const l4 = await seedCard(userId, { proficiency: 'L4', korean: '중급', dueOffsetMs: 86_400_000 });

    // b* = 4.0 → band L4: only the L4 card qualifies for the banded pass.
    const banded = await fetchCandidates(userId, { ...MID_TARGETS, vocab: 4.0 });
    expect(banded.vocab.map((c) => c.itemKey)).toEqual([`vocab:card:${String(l4)}`]);

    // b* = 5.5 → band L5+: nothing in band → unbanded retry serves the deck
    // rather than reporting the dimension empty-handed.
    const degraded = await fetchCandidates(userId, { ...MID_TARGETS, vocab: 5.5 });
    expect(degraded.vocab).toHaveLength(2);
  });

  it('is user-scoped', async () => {
    const other = await seedUser('cand-vocab-other@example.com');
    await seedCard(other);
    const userId = await seedUser('cand-vocab-scoped@example.com');
    const { vocab } = await fetchCandidates(userId, MID_TARGETS);
    expect(vocab).toEqual([]);
  });
});

describe('grammar candidates', () => {
  it('due grammar production cards lead; graduated patterns are excluded', async () => {
    const userId = await seedUser('cand-grammar-due@example.com');
    const active = await seedGrammarEntry(userId, { display: '-으면서', proficiency: 'L4' });
    const activeCard = await seedGrammarCard(userId, active);
    const graduated = await seedGrammarEntry(userId, { graduated: true });
    await seedGrammarCard(userId, graduated); // due, but pattern is graduated

    const { grammar } = await fetchCandidates(userId, MID_TARGETS);
    expect(grammar.map((c) => c.itemKey)).toEqual([`grammar:card:${String(activeCard)}`]);
    expect(grammar[0]).toMatchObject({
      title: '-으면서',
      b: 4, // proficiencyToNumber('L4')
      level: 'L4',
      deepLink: '/learn/grammar',
    });
  });

  it('nothing due → banked-entries fallback, band-preferred then unbanded', async () => {
    const userId = await seedUser('cand-grammar-fallback@example.com');
    await seedGrammarEntry(userId, { display: 'L3 pattern', proficiency: 'L3' });
    const l4 = await seedGrammarEntry(userId, { display: 'L4 pattern', proficiency: 'L4' });
    await seedGrammarEntry(userId, { display: 'graduated', graduated: true });

    const banded = await fetchCandidates(userId, { ...MID_TARGETS, grammar: 4.0 });
    expect(banded.grammar.map((c) => c.itemKey)).toEqual([`grammar:entry:${String(l4)}`]);

    // No L5+ entries → unbanded retry returns both ACTIVE patterns (the
    // graduated one stays retired from every pool).
    const degraded = await fetchCandidates(userId, { ...MID_TARGETS, grammar: 5.5 });
    expect(degraded.grammar.map((c) => c.title).sort()).toEqual(['L3 pattern', 'L4 pattern']);
  });
});
