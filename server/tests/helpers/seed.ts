/**
 * Small, deterministic data-seeding helpers for route tests.
 *
 * Each helper assumes a clean state — callers should TRUNCATE the relevant
 * tables in beforeEach. We avoid coupling to specific id values: helpers
 * return the freshly-inserted ids so tests can chain.
 */
import type { Pool } from 'pg';
import { createHash, randomUUID } from 'node:crypto';

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
    exampleKorean?: string;
    exampleEnglish?: string;
    sourceBook?: string;
    proficiency?: 'basic' | 'L3' | 'L4' | 'L5+';
    /**
     * U2/U3 source tag — the `book_uploads.id` this entry was extracted from
     * (nullable FK, defaults to NULL for the ordinary curated-corpus rows).
     * Pass it to exercise the U3a source-book filter.
     */
    sourceUploadId?: number;
  } = {},
): Promise<number> {
  const corpus = opts.corpus ?? 'vocab_2000_intermediate';
  const corpusSourceId = await ensureCorpusSource(pool, corpus);
  const sourceId = `vocab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO vocab_entries (
        corpus_source_id, corpus, source_id, book_level, entry_type,
        source_book, korean, english, example_korean, example_english, proficiency,
        source_upload_id)
     VALUES ($1, $2::corpus, $3, 'intermediate'::book_level, 'word'::vocab_entry_type,
             $4, $5, $6, $7, $8, $9::proficiency_level, $10)
     RETURNING id`,
    [
      corpusSourceId,
      corpus,
      sourceId,
      opts.sourceBook ?? 'test-book',
      opts.korean ?? '먹다',
      opts.english ?? 'to eat',
      opts.exampleKorean ?? null,
      opts.exampleEnglish ?? null,
      opts.proficiency ?? 'L3',
      opts.sourceUploadId ?? null,
    ],
  );
  return Number(rows[0]!.id);
}

/**
 * Seed a single kgiu_entries grammar row. Returns its id.
 *
 * `pattern` defaults to a real grammar form. Pass `pattern: ''` together with a
 * structural `category` (e.g. 'unit_intro' / 'reference' / 'introduction') to
 * seed the empty-pattern, non-pattern rows the Reference list + weekly picks
 * must exclude — these are `entry_type='grammar'` rows whose `pattern` is blank
 * (an empty string passes the migration-027 CHECK, which only forbids NULL).
 * `sourceId` can be pinned to assert a deterministic key downstream.
 */
export async function seedKgiuEntry(
  pool: Pool,
  opts: {
    corpus?: string;
    pattern?: string;
    proficiency?: 'basic' | 'L3' | 'L4' | 'L5+';
    category?: string;
    sourceId?: string;
    /** Chapter/unit label (nullable TEXT column; defaults to NULL). */
    unit?: string;
    /**
     * U2/U3 source tag — the `book_uploads.id` this pattern was extracted from
     * (nullable FK, defaults to NULL). Pass it to exercise the U3a source-book
     * filter on the grammar route.
     */
    sourceUploadId?: number;
  } = {},
): Promise<number> {
  const corpus = opts.corpus ?? 'kgiu_intermediate';
  const corpusSourceId = await ensureCorpusSource(pool, corpus);
  const sourceId =
    opts.sourceId ?? `kgiu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO kgiu_entries (
        corpus_source_id, corpus, source_id, book_level, entry_type,
        source_book, pattern, title_en, category, proficiency, unit,
        source_upload_id)
     VALUES ($1, $2::corpus, $3, 'intermediate'::book_level, 'grammar'::kgiu_entry_type,
             'test-book', $4, 'mock title', $6, $5::proficiency_level, $7, $8)
     RETURNING id`,
    [
      corpusSourceId,
      corpus,
      sourceId,
      opts.pattern ?? '-아/어 보이다',
      opts.proficiency ?? 'L3',
      opts.category ?? 'mock category',
      opts.unit ?? null,
      opts.sourceUploadId ?? null,
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

/** One transcript line to seed via seedTtmikTranscript. */
export interface TranscriptLineSeed {
  ordinal: number;
  korean: string | null;
  english: string | null;
  kind: 'header' | 'pair' | 'romanization' | 'prose' | 'dialog';
}

/**
 * Seed full-transcript lines (ttmik_transcript_lines, migration 036) for a
 * lesson created by seedTtmikLesson.
 */
export async function seedTtmikTranscript(
  pool: Pool,
  lessonId: number,
  lines: TranscriptLineSeed[],
): Promise<void> {
  for (const line of lines) {
    await pool.query(
      `INSERT INTO ttmik_transcript_lines (lesson_id, ordinal, korean, english, kind)
       VALUES ($1, $2, $3, $4, $5)`,
      [lessonId, line.ordinal, line.korean, line.english, line.kind],
    );
  }
}

/**
 * Seed an Iyagi episode + 2 sentences. Returns the episode id.
 *
 * `hosts` mirrors production data: a plain TEXT column holding a string like
 * "최경은 & 진석진" (the detail endpoint splits it into string[]).
 */
export async function seedIyagiEpisode(
  pool: Pool,
  opts: { number?: number; hosts?: string | null } = {},
): Promise<number> {
  const corpusSourceId = await ensureCorpusSource(pool, 'iyagi', 'intermediate');
  const episodeNumber = opts.number ?? Math.floor(Math.random() * 999_998) + 1;
  const sourceId = `iyagi-${episodeNumber}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO iyagi_episodes (
        corpus_source_id, corpus, source_id, episode_number, ordinal, title, hosts)
     VALUES ($1, 'iyagi'::corpus, $2, $3, 1, 'mock episode', $4)
     RETURNING id`,
    [corpusSourceId, sourceId, episodeNumber, opts.hosts ?? null],
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
 * The shared writing_prompts bank is migration-013 reference data (retagged +
 * extended by migration 038, F-014) and is NOT truncated by the per-test
 * `beforeEach`. A test that needs to control the bank exactly (e.g. to assert
 * the Writing band-preference, or the empty-bank branch) must
 * `TRUNCATE writing_prompts ... CASCADE` itself and then seed via this helper —
 * CASCADE is required because writing_attempts.prompt_id now FKs
 * writing_prompts(id), so a bare TRUNCATE is refused even when writing_attempts
 * is empty. Such a test must run LAST in its file: the `beforeEach` does not
 * restore the migration seed rows, so any earlier test that relies on the
 * seeded bank would otherwise find it empty.
 *
 * `rubric` defaults to NULL — a rubric-NULL row mirrors the retired pre-F-014
 * legacy shape and is invisible to BOTH `GET /writing/prompts` and the
 * `/plan/today` writing pick (each filters `rubric IS NOT NULL`). A test that
 * needs the row to be servable/advertisable must pass an explicit rubric.
 */
export async function seedWritingPrompt(
  pool: Pool,
  opts: {
    level?: 'L3' | 'L4' | 'L5+';
    title?: string;
    estMinutes?: number;
    isActive?: boolean;
    rubric?: 'topik_ii_53' | 'topik_ii_54' | null;
  } = {},
): Promise<number> {
  const sourceId = `wp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO writing_prompts (
        source_id, title, prompt_kr, prompt_en, level, est_minutes, is_active,
        rubric)
     VALUES ($1, $2, '테스트 작문 프롬프트', 'test writing prompt',
             $3::proficiency_level, $4, $5, $6)
     RETURNING id`,
    [
      sourceId,
      opts.title ?? 'mock writing prompt',
      opts.level ?? 'L4',
      opts.estMinutes ?? 8,
      opts.isActive ?? true,
      opts.rubric ?? null,
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
    /** Mark the item image-dependent (topik_items.has_image). Default false. */
    hasImage?: boolean;
    /** Curated image description (topik_items.image_text). Default NULL. */
    imageText?: string | null;
    /**
     * Pin the parent test's `test_number` (the `source_test` / `sourceTest`
     * filter key). Defaults to a random unique value. Pass the SAME number across
     * calls (with distinct `itemNumber`) to assemble a multi-item test, e.g. to
     * exercise POST /topik/mock's original-order assembly.
     */
    testNumber?: number;
    /** Pin the item's `item_number` (the mock-order key). Defaults to 1. */
    itemNumber?: number;
    /**
     * The parent test's paper ('TOPIK I' beginner / 'TOPIK II' the default).
     * F-002: the diagnostic's L1/L2 bands prefer items from 'TOPIK I' tests.
     */
    topikLevel?: 'TOPIK I' | 'TOPIK II';
  } = {},
): Promise<number> {
  const section = opts.section ?? 'reading';
  const topikLevel = opts.topikLevel ?? 'TOPIK II';
  const corpusSourceId = await ensureCorpusSource(pool, 'topik', 'intermediate');
  // Unique test_number per call by default (natural key is (test_number,
  // topik_level, section) since migration 029); callers building a multi-item
  // test pin it via opts.testNumber.
  const testNumber = opts.testNumber ?? Math.floor(Math.random() * 2_000_000) + 1;
  // Reuse the existing test when the caller pins testNumber so multiple items
  // land under one test.
  const existingTest = await pool.query<{ id: string }>(
    `SELECT id FROM topik_tests
      WHERE test_number = $1 AND topik_level = $2 AND section = $3::topik_section`,
    [testNumber, topikLevel, section],
  );
  let testId: number;
  if (existingTest.rows[0]) {
    testId = Number(existingTest.rows[0].id);
  } else {
    const testRes = await pool.query<{ id: string }>(
      `INSERT INTO topik_tests (corpus_source_id, corpus, test_number, topik_level, section)
       VALUES ($1, 'topik'::corpus, $2, $4, $3::topik_section)
       RETURNING id`,
      [corpusSourceId, testNumber, section, topikLevel],
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
        options, answer, extra, has_image, image_text)
     VALUES ($1, $2, 'topik'::corpus, $3, $13,
             $4::topik_section, $5::topik_item_type,
             $6::proficiency_level, $7, $8, $9,
             $10::jsonb, $11::jsonb, $12::jsonb, $14, $15)
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
      opts.hasImage ?? false,
      opts.imageText ?? null,
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

/**
 * Seed a single book_uploads row directly (U1a — book-upload feature, page-
 * image model). Returns the new upload id. Bypasses the upload route
 * entirely (no page rows/blob files are written) — useful for tests that
 * only need the `book_uploads` row to exist (e.g. the daily-cap test, which
 * needs many distinct-titled rows fast) and don't touch page-serving routes.
 * A test exercising `GET /uploads/:id/page/:n` needs actual `book_pages` rows
 * too — see `seedBookPage` below, or upload via the real route.
 */
export async function seedBookUpload(
  pool: Pool,
  userId: number,
  opts: {
    title?: string;
    type?: 'vocab' | 'grammar' | 'both' | 'dialogue' | 'literature' | 'comic';
    status?: 'processing' | 'ready' | 'failed';
    byteSize?: number;
    pageCount?: number | null;
    createdAt?: Date;
  } = {},
): Promise<number> {
  const title = opts.title ?? `seed-book-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO book_uploads
       (user_id, title, type, status, byte_size, page_count, created_at)
     VALUES ($1, $2, $3::book_upload_type, $4::book_upload_status, $5, $6,
             COALESCE($7, now()))
     RETURNING id`,
    [
      userId,
      title,
      opts.type ?? 'vocab',
      opts.status ?? 'processing',
      opts.byteSize ?? 1024,
      opts.pageCount ?? null,
      opts.createdAt ?? null,
    ],
  );
  return Number(rows[0]!.id);
}

/**
 * Seed a single book_pages row directly. Returns the new page id. Bypasses
 * the upload route entirely (no blob file is written unless `blobRef` points
 * at one a test has actually created) — a test exercising
 * `GET /uploads/:id/page/:n`'s byte-streaming needs a REAL file at the
 * returned blob path (write one under `process.env.BOOK_UPLOAD_STORAGE_DIR`
 * first, or upload via the real route instead).
 */
export async function seedBookPage(
  pool: Pool,
  uploadId: number,
  pageNumber: number,
  opts: { blobRef?: string } = {},
): Promise<number> {
  const blobRef =
    opts.blobRef ?? `seed/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO book_pages (upload_id, page_number, blob_ref)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [uploadId, pageNumber, blobRef],
  );
  return Number(rows[0]!.id);
}

/**
 * Seed a single audio_transcription_jobs row directly (Track A — migration
 * 076). Returns the new job id. Bypasses the upload route entirely: the
 * per-user daily transcription-bytes cap sums `charged_bytes` by user_id +
 * created_at ALONE (never a join back to the track — 076's SET-NULL ledger
 * contract), so a cap test can seed spend with `track_id` NULL (a legal
 * "track deleted after the fact" ledger row) without building a
 * source/track pair first. Defaults to a settled 'done' row so the seeded
 * spend can never collide with the one-live-job-per-track partial unique
 * (NULL track_id never collides there anyway — belt and braces).
 */
export async function seedAudioTranscriptionJob(
  pool: Pool,
  userId: number,
  opts: {
    chargedBytes: number;
    status?: 'pending' | 'running' | 'done' | 'failed';
    createdAt?: Date;
  },
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO audio_transcription_jobs (track_id, user_id, status, charged_bytes, created_at)
     VALUES (NULL, $1, $2::audio_transcription_status, $3, COALESCE($4, now()))
     RETURNING id`,
    [userId, opts.status ?? 'done', opts.chargedBytes, opts.createdAt ?? null],
  );
  return Number(rows[0]!.id);
}

/**
 * Seed a single audio_transcript_segments row (Track A — migration 075).
 * Returns the new segment id. `trackId` must reference a REAL audio_tracks
 * row (FK, CASCADE) — create one via the real POST /audio route or a direct
 * insert first. Windows default to a contiguous 2-second slot derived from
 * the segment number so multi-segment seeds are ordered and non-degenerate
 * without every caller spelling out timestamps.
 */
export async function seedAudioSegment(
  pool: Pool,
  trackId: number,
  segmentNumber: number,
  opts: { startMs?: number; endMs?: number; body?: string } = {},
): Promise<number> {
  const startMs = opts.startMs ?? (segmentNumber - 1) * 2000;
  const endMs = opts.endMs ?? startMs + 2000;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO audio_transcript_segments (track_id, segment_number, start_ms, end_ms, body)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [trackId, segmentNumber, startMs, endMs, opts.body ?? `세그먼트 ${segmentNumber}`],
  );
  return Number(rows[0]!.id);
}

/**
 * Seed a single reading_chapters row (U3b, digitized chapter reader —
 * migration 044). Returns the new chapter id. `userId` MUST be the owner of
 * `uploadId` (the migration-044 composite FK rejects any other user_id), so
 * pass the same userId you seeded the book_upload with.
 */
export async function seedReadingChapter(
  pool: Pool,
  userId: number,
  uploadId: number,
  opts: {
    chapterNumber?: number;
    title?: string | null;
    startPage?: number | null;
    endPage?: number | null;
  } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO reading_chapters
       (source_upload_id, user_id, chapter_number, title, start_page, end_page)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      uploadId,
      userId,
      opts.chapterNumber ?? 1,
      opts.title === undefined ? 'Chapter' : opts.title,
      opts.startPage ?? null,
      opts.endPage ?? null,
    ],
  );
  return Number(rows[0]!.id);
}

/**
 * Seed a single reading_passages row under a chapter (migration 044). Returns
 * the new passage id.
 */
export async function seedReadingPassage(
  pool: Pool,
  chapterId: number,
  opts: { passageNumber?: number; body?: string; pageNumber?: number | null } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO reading_passages
       (chapter_id, passage_number, body, page_number)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      chapterId,
      opts.passageNumber ?? 1,
      opts.body ?? '안녕하세요. 반갑습니다.',
      opts.pageNumber ?? null,
    ],
  );
  return Number(rows[0]!.id);
}

/**
 * Seed a single generated_stories row (F-068, migration 054) directly —
 * bypasses POST /reading/generate (no Claude call). Returns the new story id.
 * Used by F-172 reading_attempts tests to seed a story-sourced attempt target.
 */
export async function seedGeneratedStory(
  pool: Pool,
  userId: number,
  opts: {
    title?: string;
    bodyKo?: string;
    level?: 'L1' | 'L2' | 'L3' | 'L4' | 'L5+';
    prompt?: string | null;
  } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO generated_stories (user_id, title, body_ko, level, prompt)
     VALUES ($1, $2, $3, $4::proficiency_level, $5)
     RETURNING id`,
    [
      userId,
      opts.title ?? '모의 이야기',
      opts.bodyKo ?? '옛날 옛적에 이야기가 있었습니다.',
      opts.level ?? 'L3',
      opts.prompt ?? null,
    ],
  );
  return Number(rows[0]!.id);
}

/**
 * Seed a single story_audio_jobs row (F-210, migration 081) directly —
 * bypasses POST /reading/generated/:id/audio. Returns the new job id.
 * `userId` MUST own `storyId` (081's composite owner FK rejects any other
 * pairing). Defaults to a settled 'failed' row so cap tests can stack many
 * rows on ONE story without tripping the one-live-job partial unique.
 */
export async function seedStoryAudioJob(
  pool: Pool,
  userId: number,
  storyId: number,
  opts: {
    status?: 'pending' | 'running' | 'done' | 'failed';
    charCount?: number;
    error?: string | null;
    createdAt?: Date;
    startedAt?: Date;
  } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO story_audio_jobs
       (generated_story_id, user_id, status, char_count, error, created_at, started_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7)
     RETURNING id`,
    [
      storyId,
      userId,
      opts.status ?? 'failed',
      opts.charCount ?? 100,
      opts.error ?? null,
      opts.createdAt ?? null,
      opts.startedAt ?? null,
    ],
  );
  return Number(rows[0]!.id);
}

/**
 * Seed a fully VOICED story (F-210): an audio_sources set (kind
 * 'generated_story', linked + owner-pinned to the story), its single
 * audio_tracks row, and `segmentCount` ordered transcript segments — the
 * at-rest state the runner produces, without running TTS or touching the
 * filesystem (blob_ref points at nothing; tests that stream must write the
 * file themselves). Returns the ids.
 */
export async function seedStoryAudio(
  pool: Pool,
  userId: number,
  storyId: number,
  opts: { title?: string; durationMs?: number | null; segmentCount?: number } = {},
): Promise<{ sourceId: number; trackId: number }> {
  const title = opts.title ?? '모의 이야기';
  const src = await pool.query<{ id: string }>(
    `INSERT INTO audio_sources
       (user_id, slug, title, kind, source_upload_id, generated_story_id, status)
     VALUES ($1, $2, $3, 'generated_story', NULL, $4, 'ready')
     RETURNING id`,
    [userId, `generated-story-${storyId}`, title, storyId],
  );
  const sourceId = Number(src.rows[0]!.id);
  const trk = await pool.query<{ id: string }>(
    `INSERT INTO audio_tracks
       (source_id, user_id, track_number, title, blob_ref, byte_size, duration_ms,
        transcript_status)
     VALUES ($1, $2, 1, $3, $4, 3, $5, 'done')
     RETURNING id`,
    [sourceId, userId, title, `${userId}/${randomUUID()}.mp3`, opts.durationMs ?? 4000],
  );
  const trackId = Number(trk.rows[0]!.id);
  const segmentCount = opts.segmentCount ?? 2;
  for (let n = 1; n <= segmentCount; n++) {
    await seedAudioSegment(pool, trackId, n);
  }
  return { sourceId, trackId };
}

/** Insert a minimal krdict entry. Returns id. */
export async function seedKrdictEntry(
  pool: Pool,
  opts: {
    headword?: string;
    definitionEn?: string;
    definitionKo?: string;
    /** F-175 — KRDICT part-of-speech tag. Omit for the untagged (NULL) case. */
    partOfSpeech?: string;
  } = {},
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
        definition_korean, definition_english, part_of_speech)
     VALUES ($1, $2, 0, $3, $4, $5, $6)
     RETURNING id`,
    [
      sourceRowId,
      `kr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      headword,
      opts.definitionKo ?? '먹어서 배를 채우다',
      opts.definitionEn ?? 'to eat',
      opts.partOfSpeech ?? null,
    ],
  );
  return Number(rows[0]!.id);
}

/**
 * Attach a krdict sense (plus its example sentences) to an existing entry.
 * Returns the new sense id. `senseIndex` defaults to 1 (the sense whose
 * definitions are denormalized onto the entry); pass higher indices to model
 * multi-sense entries. Examples are inserted in array order as
 * example_index 1..n — the order `/define` must echo back.
 */
export async function seedKrdictSense(
  pool: Pool,
  entryId: number,
  opts: {
    senseIndex?: number;
    definitionKo?: string;
    definitionEn?: string | null;
    examples?: Array<{ korean: string; english?: string | null }>;
  } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO krdict_senses (
        krdict_entry_id, sense_index, definition_korean, definition_english)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      entryId,
      opts.senseIndex ?? 1,
      opts.definitionKo ?? '먹어서 배를 채우다',
      opts.definitionEn === undefined ? 'to eat' : opts.definitionEn,
    ],
  );
  const senseId = Number(rows[0]!.id);
  const examples = opts.examples ?? [];
  for (let i = 0; i < examples.length; i += 1) {
    const ex = examples[i]!;
    await pool.query(
      `INSERT INTO krdict_examples (krdict_sense_id, example_index, korean, english)
       VALUES ($1, $2, $3, $4)`,
      [senseId, i + 1, ex.korean, ex.english ?? null],
    );
  }
  return senseId;
}
