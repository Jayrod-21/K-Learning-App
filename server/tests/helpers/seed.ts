/**
 * Small, deterministic data-seeding helpers for route tests.
 *
 * Each helper assumes a clean state — callers should TRUNCATE the relevant
 * tables in beforeEach. We avoid coupling to specific id values: helpers
 * return the freshly-inserted ids so tests can chain.
 */
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';

/** Register a user via the app, then return the supertest agent + user id. */
import request from 'supertest';
import type { Express } from 'express';

/** Deterministic 64-char lowercase hex from any string. */
function hex64(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

let _emailCounter = 0;
function nextEmail(): string {
  _emailCounter += 1;
  return `u${_emailCounter}-${Date.now()}@example.com`;
}

export interface RegisteredAgent {
  agent: ReturnType<typeof request.agent>;
  email: string;
  userId: number;
}

/**
 * Register a new user via /auth/register and return a session-bound
 * supertest agent. The password is fixed-length to satisfy the auth schema.
 */
export async function registerUser(app: Express, pool: Pool): Promise<RegisteredAgent> {
  const agent = request.agent(app);
  const email = nextEmail();
  const password = 'correct horse battery staple';
  const res = await agent.post('/auth/register').send({ email, password });
  if (res.status !== 201) {
    throw new Error(`registerUser failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const userId = (res.body as { user: { id: number } }).user.id;
  // pool param is reserved for callers that need it; explicitly mark used.
  void pool;
  return { agent, email, userId };
}

/**
 * Insert a corpus_sources row for the given corpus. Returns the new id.
 * Idempotent on (corpus); reuses an existing row if one exists.
 */
export async function ensureCorpusSource(
  pool: Pool,
  corpus: string,
  level: 'beginner' | 'intermediate' | 'advanced' = 'intermediate',
): Promise<number> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM corpus_sources WHERE corpus = $1::corpus LIMIT 1`,
    [corpus],
  );
  if (existing.rows[0]) return Number(existing.rows[0].id);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO corpus_sources (corpus, title, level, source_path, default_proficiency)
     VALUES ($1::corpus, $2, $3::book_level, $4, 'L3'::proficiency_level)
     RETURNING id`,
    [corpus, `test-${corpus}`, level, `test/${corpus}-${Date.now()}.json`],
  );
  return Number(rows[0]!.id);
}

/** Seed a single vocab_entries word row. Returns its id. */
export async function seedVocabEntry(
  pool: Pool,
  opts: {
    corpus?: string;
    korean?: string;
    english?: string;
    proficiency?: 'basic' | 'L3' | 'L4' | 'L5+';
  } = {},
): Promise<number> {
  const corpus = opts.corpus ?? 'vocab_2000_intermediate';
  const corpusSourceId = await ensureCorpusSource(pool, corpus);
  const sourceId = `vocab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO vocab_entries (
        corpus_source_id, corpus, source_id, book_level, entry_type,
        source_book, korean, english, proficiency)
     VALUES ($1, $2::corpus, $3, 'intermediate'::book_level, 'word'::vocab_entry_type,
             'test-book', $4, $5, $6::proficiency_level)
     RETURNING id`,
    [
      corpusSourceId,
      corpus,
      sourceId,
      opts.korean ?? '먹다',
      opts.english ?? 'to eat',
      opts.proficiency ?? 'L3',
    ],
  );
  return Number(rows[0]!.id);
}

/** Seed a single kgiu_entries grammar row. Returns its id. */
export async function seedKgiuEntry(
  pool: Pool,
  opts: { corpus?: string; pattern?: string; proficiency?: 'basic' | 'L3' | 'L4' | 'L5+' } = {},
): Promise<number> {
  const corpus = opts.corpus ?? 'kgiu_intermediate';
  const corpusSourceId = await ensureCorpusSource(pool, corpus);
  const sourceId = `kgiu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO kgiu_entries (
        corpus_source_id, corpus, source_id, book_level, entry_type,
        source_book, pattern, title_en, category, proficiency)
     VALUES ($1, $2::corpus, $3, 'intermediate'::book_level, 'grammar'::kgiu_entry_type,
             'test-book', $4, 'mock title', 'mock category', $5::proficiency_level)
     RETURNING id`,
    [
      corpusSourceId,
      corpus,
      sourceId,
      opts.pattern ?? '-아/어 보이다',
      opts.proficiency ?? 'L3',
    ],
  );
  return Number(rows[0]!.id);
}

/**
 * Seed a TTMIK lesson + 2 sentences. Returns the lesson id.
 *
 * `bookLevel` controls the lesson's `book_level` (defaults to 'beginner' for
 * backward-compatibility with existing callers); pass it to exercise the
 * /plan/today reading band-preference path.
 */
export async function seedTtmikLesson(
  pool: Pool,
  opts: {
    level?: number;
    number?: number;
    bookLevel?: 'beginner' | 'intermediate' | 'advanced';
    title?: string;
  } = {},
): Promise<number> {
  const bookLevel = opts.bookLevel ?? 'beginner';
  const corpusSourceId = await ensureCorpusSource(pool, 'ttmik', bookLevel);
  const lessonLevel = opts.level ?? 1;
  const lessonNumber = opts.number ?? Math.floor(Math.random() * 999_998) + 1;
  const sourceId = `ttmik-L${lessonLevel}-${lessonNumber}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO ttmik_lessons (
        corpus_source_id, corpus, source_id, book_level,
        lesson_level, lesson_number, ordinal, title)
     VALUES ($1, 'ttmik'::corpus, $2, $5::book_level,
             $3, $4, 1, $6)
     RETURNING id`,
    [corpusSourceId, sourceId, lessonLevel, lessonNumber, bookLevel, opts.title ?? 'mock lesson'],
  );
  const lessonId = Number(rows[0]!.id);
  await pool.query(
    `INSERT INTO ttmik_sentences (lesson_id, ordinal, korean, english, content_hash)
     VALUES ($1, 1, '안녕하세요', 'hello', $2),
            ($1, 2, '감사합니다', 'thank you', $3)`,
    [lessonId, hex64(`ta-${lessonId}`), hex64(`tb-${lessonId}`)],
  );
  return lessonId;
}

/** Seed an Iyagi episode + 2 sentences. Returns the episode id. */
export async function seedIyagiEpisode(
  pool: Pool,
  opts: { number?: number } = {},
): Promise<number> {
  const corpusSourceId = await ensureCorpusSource(pool, 'iyagi', 'intermediate');
  const episodeNumber = opts.number ?? Math.floor(Math.random() * 999_998) + 1;
  const sourceId = `iyagi-${episodeNumber}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO iyagi_episodes (
        corpus_source_id, corpus, source_id, episode_number, ordinal, title)
     VALUES ($1, 'iyagi'::corpus, $2, $3, 1, 'mock episode')
     RETURNING id`,
    [corpusSourceId, sourceId, episodeNumber],
  );
  const episodeId = Number(rows[0]!.id);
  await pool.query(
    `INSERT INTO iyagi_sentences (episode_id, ordinal, korean, english, content_hash)
     VALUES ($1, 1, '안녕', 'hi', $2),
            ($1, 2, '잘 지내요', 'doing well', $3)`,
    [episodeId, hex64(`ia-${episodeId}`), hex64(`ib-${episodeId}`)],
  );
  return episodeId;
}

/**
 * Seed a single vocab_card for a user. Creates a backing vocab_entry (the XOR
 * target constraint requires exactly one target id) and a card with a
 * controllable `due_at`. Returns the card id.
 *
 * `dueOffsetMs` shifts due_at relative to now(): negative = already due
 * (counts toward /plan/today dueCount), positive = future. `suspended` and
 * `deleted` exercise the dueCount filters.
 */
export async function seedVocabCard(
  pool: Pool,
  userId: number,
  opts: { dueOffsetMs?: number; suspended?: boolean; deleted?: boolean } = {},
): Promise<number> {
  const entryId = await seedVocabEntry(pool);
  const dueOffsetMs = opts.dueOffsetMs ?? -60_000; // default: due 1 min ago
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO vocab_cards (
        user_id, face, vocab_entry_id, due_at, suspended_at, deleted_at)
     VALUES ($1, 'recognition'::card_face, $2,
             now() + ($3::double precision * interval '1 millisecond'),
             CASE WHEN $4 THEN now() ELSE NULL END,
             CASE WHEN $5 THEN now() ELSE NULL END)
     RETURNING id`,
    [userId, entryId, dueOffsetMs, opts.suspended ?? false, opts.deleted ?? false],
  );
  return Number(rows[0]!.id);
}

/**
 * Seed a diagnostic_snapshots row for a user. Estimates are on the 0–6 TOPIK
 * scale; pass null to leave a dimension unexercised. Returns the snapshot id.
 * `evidence` and `rubric_version` are minimal valid values (the route never
 * reads them).
 */
export async function seedDiagnosticSnapshot(
  pool: Pool,
  userId: number,
  opts: {
    reading?: number | null;
    listening?: number | null;
    writing?: number | null;
    grammar?: number | null;
    vocab?: number | null;
  } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO diagnostic_snapshots (
        user_id, reading_estimate, listening_estimate, writing_estimate,
        grammar_estimate, vocab_estimate, evidence, rubric_version)
     VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, 'v1.0.0')
     RETURNING id`,
    [
      userId,
      opts.reading ?? null,
      opts.listening ?? null,
      opts.writing ?? null,
      opts.grammar ?? null,
      opts.vocab ?? null,
    ],
  );
  return Number(rows[0]!.id);
}

/**
 * Seed a single writing_prompts row. Returns its id.
 *
 * The shared writing_prompts bank is migration-013 reference data and is NOT
 * truncated by the per-test `beforeEach`. A test that needs to control the bank
 * exactly (e.g. to assert the Writing band-preference, or the empty-bank
 * branch) must `TRUNCATE writing_prompts` itself and then seed via this helper.
 * Such a test must run LAST in its file: the `beforeEach` does not restore the
 * migration's 8 rows, so any earlier test that relies on the seeded bank would
 * otherwise find it empty.
 */
export async function seedWritingPrompt(
  pool: Pool,
  opts: {
    level?: 'L3' | 'L4' | 'L5+';
    title?: string;
    estMinutes?: number;
    isActive?: boolean;
  } = {},
): Promise<number> {
  const sourceId = `wp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO writing_prompts (
        source_id, title, prompt_kr, prompt_en, level, est_minutes, is_active)
     VALUES ($1, $2, '테스트 작문 프롬프트', 'test writing prompt',
             $3::proficiency_level, $4, $5)
     RETURNING id`,
    [
      sourceId,
      opts.title ?? 'mock writing prompt',
      opts.level ?? 'L4',
      opts.estMinutes ?? 8,
      opts.isActive ?? true,
    ],
  );
  return Number(rows[0]!.id);
}

/**
 * Seed a single topik_items row (with its required topik_tests parent +
 * corpus_source). Returns the item id.
 *
 * Diagnostic reading/listening items are drawn from this pool. `options` is a
 * Korean string array; `answer` is the 1-based correct index (matches the
 * corpus convention: multiple_choice answer = int 1..4). A topik_tests row is
 * created per call with a unique (test_number, section) so repeated seeds in
 * one test don't collide on the natural-key UNIQUE.
 */
export async function seedTopikItem(
  pool: Pool,
  opts: {
    section?: 'reading' | 'listening' | 'writing';
    proficiency?: 'basic' | 'L3' | 'L4' | 'L5+' | null;
    options?: string[];
    answer?: number;
    /** Pass an object (or any non-int) to exercise the "no usable answer" skip. */
    rawAnswer?: unknown;
    stem?: string | null;
    prompt?: string | null;
    underline?: string | null;
    itemType?: string;
    extra?: Record<string, unknown>;
    /**
     * Pin the parent test's `test_number` (the `source_test` / `sourceTest`
     * filter key). Defaults to a random unique value. Pass the SAME number across
     * calls (with distinct `itemNumber`) to assemble a multi-item test, e.g. to
     * exercise POST /topik/mock's original-order assembly.
     */
    testNumber?: number;
    /** Pin the item's `item_number` (the mock-order key). Defaults to 1. */
    itemNumber?: number;
  } = {},
): Promise<number> {
  const section = opts.section ?? 'reading';
  const corpusSourceId = await ensureCorpusSource(pool, 'topik', 'intermediate');
  // Unique test_number per call by default (natural key is (test_number,
  // section)); callers building a multi-item test pin it via opts.testNumber.
  const testNumber = opts.testNumber ?? Math.floor(Math.random() * 2_000_000) + 1;
  // A (test_number, section) is the test's natural key — reuse the existing test
  // when the caller pins testNumber so multiple items land under one test.
  const existingTest = await pool.query<{ id: string }>(
    `SELECT id FROM topik_tests WHERE test_number = $1 AND section = $2::topik_section`,
    [testNumber, section],
  );
  let testId: number;
  if (existingTest.rows[0]) {
    testId = Number(existingTest.rows[0].id);
  } else {
    const testRes = await pool.query<{ id: string }>(
      `INSERT INTO topik_tests (corpus_source_id, corpus, test_number, topik_level, section)
       VALUES ($1, 'topik'::corpus, $2, 'TOPIK II', $3::topik_section)
       RETURNING id`,
      [corpusSourceId, testNumber, section],
    );
    testId = Number(testRes.rows[0]!.id);
  }

  const options = opts.options ?? ['보기 1', '보기 2', '보기 3', '보기 4'];
  // `answer` is stored as JSONB; `rawAnswer` (if given) overrides it so tests can
  // store an object/string and exercise the ungradeable-skip path.
  const answerJson =
    opts.rawAnswer !== undefined ? opts.rawAnswer : (opts.answer ?? 1);
  const itemType = opts.itemType ?? 'multiple_choice';
  const itemNumber = opts.itemNumber ?? 1;
  const sourceId = `topik-${testNumber}-${itemNumber}-${Math.random().toString(36).slice(2, 8)}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO topik_items (
        topik_test_id, corpus_source_id, corpus, source_id, item_number,
        section, item_type, proficiency, stem, prompt, underline,
        options, answer, extra)
     VALUES ($1, $2, 'topik'::corpus, $3, $13,
             $4::topik_section, $5::topik_item_type,
             $6::proficiency_level, $7, $8, $9,
             $10::jsonb, $11::jsonb, $12::jsonb)
     RETURNING id`,
    [
      testId,
      corpusSourceId,
      sourceId,
      section,
      itemType,
      opts.proficiency === undefined ? 'L4' : opts.proficiency,
      opts.stem === undefined ? '다음 글을 읽고 물음에 답하십시오.' : opts.stem,
      opts.prompt === undefined ? '알맞은 것을 고르십시오.' : opts.prompt,
      opts.underline ?? null,
      JSON.stringify(options),
      JSON.stringify(answerJson),
      JSON.stringify(opts.extra ?? {}),
      itemNumber,
    ],
  );
  return Number(rows[0]!.id);
}

/**
 * Seed a single topik_responses row (Pass 6 answer log). Returns its id.
 *
 * The answer log is append-only and user-scoped; pass the user id and the
 * topik_items id explicitly so the helper stays decoupled from how either was
 * created. Defaults model a correct study-mode answer of choice 'a'.
 */
export async function seedTopikResponse(
  pool: Pool,
  userId: number,
  topikItemId: number,
  opts: {
    picked?: 'a' | 'b' | 'c' | 'd';
    isCorrect?: boolean;
    mode?: 'study' | 'mock';
    timeMs?: number | null;
  } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO topik_responses (user_id, topik_item_id, picked, is_correct, mode, time_ms)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      userId,
      topikItemId,
      opts.picked ?? 'a',
      opts.isCorrect ?? true,
      opts.mode ?? 'study',
      opts.timeMs ?? null,
    ],
  );
  return Number(rows[0]!.id);
}

/**
 * Seed a single hanja_characters row (+ its compounds). Returns the new id.
 *
 * `hanja_characters` is shared reference data (migration 016) and is NOT
 * truncated by a per-test `beforeEach` that only clears user-scoped tables — a
 * test that needs a known corpus must `TRUNCATE hanja_characters CASCADE`
 * itself (CASCADE clears hanja_compounds via the FK). `char` is the natural
 * key; pass a distinct one per call within a test.
 */
export async function seedHanjaCharacter(
  pool: Pool,
  opts: {
    char?: string;
    sound?: string;
    glossKr?: string | null;
    glossEn?: string;
    strokes?: number;
    level?: 'L2' | 'L3' | 'L4' | 'L5';
    frequency?: number;
    etymology?: string | null;
    compounds?: Array<{ kr: string; han: string; en?: string | null; with: string }>;
  } = {},
): Promise<number> {
  const char = opts.char ?? '學';
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO hanja_characters (
        char, sound, gloss_kr, gloss_en, strokes, frequency, level, etymology)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      char,
      opts.sound ?? '학',
      opts.glossKr ?? '',
      opts.glossEn ?? 'learning, knowledge; school',
      opts.strokes ?? 16,
      opts.frequency ?? 0,
      opts.level ?? 'L3',
      opts.etymology ?? '',
    ],
  );
  const characterId = Number(rows[0]!.id);
  const compounds = opts.compounds ?? [];
  for (const c of compounds) {
    await pool.query(
      `INSERT INTO hanja_compounds (character_id, word_kr, word_hanja, gloss_en, with_chars)
       VALUES ($1, $2, $3, $4, $5)`,
      [characterId, c.kr, c.han, c.en ?? null, c.with],
    );
  }
  return characterId;
}

/**
 * Seed a single hanja_progress row for a user. Returns its id.
 *
 * Per-user state (migration 016); the route upserts on (user_id, char). Pass the
 * char explicitly so the helper stays decoupled from how the character was
 * seeded (progress is intentionally NOT a FK to hanja_characters).
 */
export async function seedHanjaProgress(
  pool: Pool,
  userId: number,
  opts: { char?: string; state?: 'new' | 'practicing' | 'banked' } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO hanja_progress (user_id, char, state)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [userId, opts.char ?? '學', opts.state ?? 'new'],
  );
  return Number(rows[0]!.id);
}

/**
 * Seed a single image_captures row (+ its image_words) for a user. Returns the
 * new capture id.
 *
 * Per-user mining history (migration 017); the route scopes every read to
 * user_id. Pass `deleted: true` to exercise the soft-delete exclusion, and
 * `blobPath` to point at a real on-disk blob if a test wants to exercise
 * GET /:id/blob (otherwise the default path won't resolve to a file). `words`
 * are inserted in array order as ordinals 0..n-1.
 */
export async function seedImageCapture(
  pool: Pool,
  userId: number,
  opts: {
    originalFilename?: string | null;
    mime?: 'image/jpeg' | 'image/png' | 'image/webp';
    byteSize?: number;
    blobPath?: string;
    captionKr?: string;
    captionEn?: string;
    deleted?: boolean;
    words?: Array<{ kr: string; en?: string; gloss?: string; pos?: string | null }>;
  } = {},
): Promise<number> {
  const mime = opts.mime ?? 'image/png';
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  const blobPath =
    opts.blobPath ??
    `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO image_captures
       (user_id, original_filename, mime, byte_size, blob_path,
        caption_kr, caption_en, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             CASE WHEN $8 THEN now() ELSE NULL END)
     RETURNING id`,
    [
      userId,
      opts.originalFilename === undefined ? 'seed.png' : opts.originalFilename,
      mime,
      opts.byteSize ?? 1024,
      blobPath,
      opts.captionKr ?? '책상 위의 메뉴판',
      opts.captionEn ?? 'a menu on the desk',
      opts.deleted ?? false,
    ],
  );
  const captureId = Number(rows[0]!.id);
  const words = opts.words ?? [{ kr: '메뉴', en: 'menu', gloss: 'a menu', pos: 'n.' }];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!;
    await pool.query(
      `INSERT INTO image_words (capture_id, ordinal, kr, en, gloss, pos)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [captureId, i, w.kr, w.en ?? '', w.gloss ?? '', w.pos ?? null],
    );
  }
  return captureId;
}

/** Insert a minimal krdict entry. Returns id. */
export async function seedKrdictEntry(
  pool: Pool,
  opts: { headword?: string; definitionEn?: string; definitionKo?: string } = {},
): Promise<number> {
  const headword = opts.headword ?? '먹다';
  // krdict requires a krdict_source — seed one if absent.
  const src = await pool.query<{ id: string }>(
    `SELECT id FROM krdict_source LIMIT 1`,
  );
  let sourceRowId: number;
  if (src.rows[0]) {
    sourceRowId = Number(src.rows[0].id);
  } else {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO krdict_source (source_label, source_path)
       VALUES ('test-krdict', 'test/krdict.json')
       RETURNING id`,
    );
    sourceRowId = Number(rows[0]!.id);
  }
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO krdict_entries (
        krdict_source_id, source_id, homograph_index, headword,
        definition_korean, definition_english)
     VALUES ($1, $2, 0, $3, $4, $5)
     RETURNING id`,
    [
      sourceRowId,
      `kr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      headword,
      opts.definitionKo ?? '먹어서 배를 채우다',
      opts.definitionEn ?? 'to eat',
    ],
  );
  return Number(rows[0]!.id);
}
