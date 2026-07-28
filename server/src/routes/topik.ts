/**
 * /topik routes — TOPIK Prep (Study mode live + Mock-Test server route, Pass 6).
 *
 * Flow:
 *   GET  /topik/items          → paginated browse of the item pool (filters)
 *   POST /topik/mock           → a section's items, ANSWER-STRIPPED, for a timed mock
 *   POST /topik/mock/submit    → bulk server-graded mock scoring (one tx, append log)
 *   POST /topik/study          → a shuffled cross-test draw matching a filter
 *   POST /topik/:itemId/answer → grade a pick, log the attempt, reveal the answer
 *   GET  /topik/audio/:testNumber/:level → a paper's official listening MP3
 *                                (Range-capable stream — F-119 Phase 4)
 *
 * SECURITY (see SECURITY.md §14):
 *   - TOPIK items are PUBLIC reference data. This is a study tool, not a secured
 *     exam, so STUDY mode serves the `correct` flag + explanation INLINE in every
 *     TopikItemDTO — by design (contract §B / locked decisions). MOCK mode is the
 *     OPPOSITE (FU-NF-39, the diagnostic pattern): `POST /topik/mock` returns an
 *     answer-stripped DTO (`toMockItemDTO` Omits `options[].correct` + the
 *     `explanation` field — the strip is TYPE-LEVEL, so the wire type literally
 *     has nowhere to carry the answer), and grading happens server-side on
 *     `POST /topik/mock/submit` from the DB answer (never a client-asserted flag).
 *     Writing-section mock is deferred (FU-NF-47); mock is reading/listening only.
 *   - IDOR: `topik_responses` rows are stamped with the SESSION user
 *     (`getUserId(req)`), NEVER a client-supplied id. `topik_items` is reference
 *     data, not user-owned, so an itemId carries no ownership to check — but the
 *     logged response is always the caller's.
 *   - SQL injection: every query is parameterized; section/level inputs are
 *     normalized to enums by zod (Korean labels mapped) and bound, never
 *     concatenated.
 *   - DoS: cheapLimiter on every route; the study draw is `ORDER BY random()
 *     LIMIT n` with a bounded n.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter, mediaLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { query, withTransaction } from '../db/pool.js';
import { NotFoundError } from '../middleware/errors.js';
import { sharedPassageFor } from '../services/topik/passages.js';
import { streamCorpusAudio } from '../services/corpusAudio.js';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Domain constants + section/level normalization
// ---------------------------------------------------------------------------

/** Stable choice ids, in display order. Index i ⇄ the 0-based options slot. */
type ChoiceId = 'a' | 'b' | 'c' | 'd';
const CHOICE_IDS: readonly ChoiceId[] = ['a', 'b', 'c', 'd'];

/** topik_section enum values, as stored in Postgres. */
type SectionEnum = 'reading' | 'listening' | 'writing';

/** The Korean section labels the client `TopikSection` uses. */
type SectionKr = '읽기' | '듣기' | '쓰기';

/** proficiency_level enum values, as stored in Postgres. */
type ProficiencyEnum = 'basic' | 'L3' | 'L4' | 'L5+';

/**
 * topik_tests.topik_level values (migration 005, CHECK-constrained). Migration
 * 029 widened the tests natural key to (test_number, topik_level, section)
 * because TOPIK I and TOPIK II sittings SHARE every test_number — any query that
 * selects a test by test_number alone merges two different exams (D-1).
 */
type TopikLevel = 'TOPIK I' | 'TOPIK II';

/** Level discriminator for the mock/browse wire (optional — see resolveMockTest). */
const TopikLevelSchema = z.enum(['TOPIK I', 'TOPIK II']);

// Postgres INTEGER (int4) upper bound. Any zod number that binds to an INTEGER
// column (test_number / source_test / current_idx / remaining_ms) must reject
// values above this at the boundary (400) rather than let them reach SQL and
// overflow (pg error 22003 → 500). See the project's grammar-Bank incident: a
// validation schema looser than the DB constraint behind it turns bad input
// into a 500. BIGINT id params are capped at Number.MAX_SAFE_INTEGER instead
// (the gradeWriting pattern) — ids beyond 2^53 can't be represented exactly in
// a JS number anyway, and MAX_SAFE_INTEGER < int8 max so pg never overflows.
const INT4_MAX = 2_147_483_647;

// ---------------------------------------------------------------------------
// Served-but-unanswerable corpus placeholders (data sweep D-2 / D-5).
//
// Two confirmed classes of topik_items pass the structural survivor guard
// (>=2 options, non-null answer) yet are unanswerable because their QUESTION
// content is a curator placeholder, not real content:
//   D-2: 28 TOPIK-I listening items whose stem is
//        "[듣기 지문 없음 — 대화/담화가 오디오로만 제공됨(전사 파일 없음)]" —
//        the audio was never transcribed, so the only "question" is a note
//        saying the content does not exist.
//   D-5: 8 reading comprehension items whose shared passage (topik_tests.
//        passages) is the copyright-withholding notice
//        "[저작권 관련 법령에 따라 본 문항의 지문은 공개하지 않습니다…]" —
//        the text the question asks about is deliberately not stored.
// Both prefixes are curator markers (real stems/passages are prose and never
// start with these bracketed notices), so a startsWith match is safe. D-2 is
// excluded in SQL (ANSWERABLE_ITEM_SQL — the marker lives in a plain column)
// so /items total stays exact; D-5 can only be resolved per-item from the
// passages JSONB range keys, so it is excluded in mapRowToDTO (the same
// render-time guard that already drops non-int answers). The D-5 residual:
// GET /topik/items `total` (a pure SQL count) still counts these 8 rows while
// the page excludes them — the documented residual class for guards SQL cannot
// express.
// ---------------------------------------------------------------------------
const NO_TRANSCRIPT_STEM_PREFIX = '[듣기 지문 없음';
const WITHHELD_PASSAGE_PREFIX = '[저작권';

const SECTION_ENUM_TO_KR: Record<SectionEnum, SectionKr> = {
  reading: '읽기',
  listening: '듣기',
  writing: '쓰기',
};

const SECTION_KR_TO_ENUM: Record<SectionKr, SectionEnum> = {
  읽기: 'reading',
  듣기: 'listening',
  쓰기: 'writing',
};

/**
 * Map the row's proficiency enum to the client's numeric level.
 *   basic → 2, L3 → 3, L4 → 4, L5+ → 5; null → 4 (the design's centre band).
 * (Per contract §B: "level=proficiency→number … default 4 if null".)
 */
function proficiencyToLevel(proficiency: ProficiencyEnum | null): number {
  switch (proficiency) {
    case 'basic':
      return 2;
    case 'L3':
      return 3;
    case 'L4':
      return 4;
    case 'L5+':
      return 5;
    default:
      return 4;
  }
}

/**
 * Zod transform that accepts EITHER a topik_section enum value
 * ('reading'|'listening'|'writing') OR its Korean label ('읽기'|'듣기'|'쓰기')
 * and normalizes to the enum, so callers can pass either and the SQL only ever
 * binds the enum (cast `::topik_section`). An unrecognized value fails
 * validation (400) rather than reaching SQL.
 */
const SectionSchema = z
  .enum(['reading', 'listening', 'writing', '읽기', '듣기', '쓰기'])
  .transform((v): SectionEnum => (v in SECTION_KR_TO_ENUM ? SECTION_KR_TO_ENUM[v as SectionKr] : (v as SectionEnum)));

/** Level filter — the client surfaces L3/L4/L5+ as the draw filter. */
const LevelSchema = z.enum(['L3', 'L4', 'L5+']);

// ---------------------------------------------------------------------------
// TopikItemDTO + row → DTO mapping
// ---------------------------------------------------------------------------

interface TopikChoiceDTO {
  readonly id: ChoiceId;
  readonly kr: string;
  readonly en: string;
  readonly correct: boolean;
}

/**
 * The study-mode item shape the client `TopikItem` maps from. Answers are
 * INLINE (`options[].correct` + `explanation`) — see the security note above.
 */
interface TopikItemDTO {
  readonly id: string;
  readonly section: SectionKr;
  readonly number: number;
  readonly level: number;
  readonly prompt: string;
  readonly passageRef?: string;
  /**
   * The shared reading passage this item is asked about (B-008). Reading tests
   * store one passage per item-number range in `topik_tests.passages`
   * (migration 005) and the covered items carry only the question in `stem` —
   * without this text a fill-blank ㉠ or "윗글의 주제…" item is unanswerable.
   * QUESTION content, not answer data — it is deliberately kept on the mock
   * wire (see `toMockItemDTO`). Omitted when no passage covers the item.
   */
  readonly passage?: string;
  readonly options: readonly TopikChoiceDTO[];
  readonly explanation: string;
  /**
   * True when the source PDF item shows one or more images the corpus does not
   * store as assets (145 rows in the live pool). The client uses this to render
   * the item's bracketed text description of the image prominently instead of
   * leaving the item looking broken. NOT answer data — safe on the mock wire.
   */
  readonly hasImage: boolean;
  /** Curated text description of the image(s), when the corpus captured one. */
  readonly imageText?: string;
}

/** A topik_items row as selected for the DTO mapping. */
interface TopikItemRow {
  id: string;
  section: SectionEnum;
  item_number: number;
  proficiency: ProficiencyEnum | null;
  stem: string | null;
  prompt: string | null;
  options: unknown;
  answer: unknown;
  has_image: boolean;
  image_text: string | null;
  extra: Record<string, unknown> | null;
  /**
   * The parent test's `passages` JSONB (migration 005): an object keyed by
   * item-number range ("19-20", "21-22", …) carrying the reading passage shared
   * by those items. Selected via the topik_tests JOIN in every item query so
   * mapRowToDTO can resolve the passage covering `item_number` (B-008).
   */
  test_passages: Record<string, unknown> | null;
}

/**
 * Coerce a topik_items `answer` JSONB (a 1-based int for multiple-choice items)
 * into a 0-based choice index, bounded to the available choice count. Returns
 * null when the answer is unusable (not an int in 1..choiceCount) — e.g. writing
 * items whose `answer` is an object, not an int. Mirrors diagnostic's
 * `topikCorrectChoice` (1-based → 0-based) so the two item sources agree.
 */
function answerToChoiceIndex(answer: unknown, choiceCount: number): number | null {
  const n = typeof answer === 'number' ? answer : Number(answer);
  if (!Number.isInteger(n) || n < 1 || n > choiceCount) return null;
  return n - 1;
}

/**
 * Map one topik_items row to a TopikItemDTO, or null when the row cannot yield a
 * usable study item (<2 options, or no usable answer). Per contract §B:
 *   - id        = id::text
 *   - section   = enum → Korean label
 *   - number    = item_number
 *   - level     = proficiency → number (basic 2 / L3 3 / L4 4 / L5+ 5; null → 4)
 *   - prompt    = prompt when non-empty, else stem. (B-008: prompt and stem are
 *                 no longer collapsed with `??` — when a row carries BOTH, the
 *                 stem text is surfaced as the `passage` below instead of being
 *                 silently masked behind the prompt.)
 *   - passage   = the shared reading passage covering `item_number` from the
 *                 parent test's `passages` JSONB (B-008); falls back to the
 *                 stem when a non-empty prompt already occupies the prompt
 *                 slot. Omitted when neither exists.
 *   - options   = options JSONB array → a..d choices (en:''), `correct` flag set
 *                 on the (answer − 1) index
 *   - explanation = extra->>'explanation' ?? ''   (no `explanation` column exists)
 *   - hasImage    = has_image; imageText = image_text (only when non-empty)
 *   - passageRef = omitted (optional; reading-passage range key is a future
 *                  enrichment — see contract §B)
 */
function mapRowToDTO(row: TopikItemRow): TopikItemDTO | null {
  if (!Array.isArray(row.options)) return null;
  const rawOptions = row.options.slice(0, CHOICE_IDS.length);
  if (rawOptions.length < 2) return null;

  const correctIndex = answerToChoiceIndex(row.answer, rawOptions.length);
  if (correctIndex === null) return null;

  const options: TopikChoiceDTO[] = rawOptions.map((opt, i) => ({
    id: CHOICE_IDS[i]!,
    // Only strings render as option text; a non-string (e.g. an object from a
    // malformed corpus row) collapses to '' rather than coercing to junk like
    // "[object Object]". The item still grades correctly — the index math is
    // independent of the text.
    kr: typeof opt === 'string' ? opt : '',
    en: '',
    correct: i === correctIndex,
  }));

  const explanationRaw = row.extra?.['explanation'];
  const explanation = typeof explanationRaw === 'string' ? explanationRaw : '';

  const imageText = (row.image_text ?? '').trim();

  // B-008: resolve the item's question text WITHOUT masking data. The prompt
  // slot takes `prompt` when present, else `stem`. The shared reading passage
  // covering this item_number (topik_tests.passages) rides in `passage`; when
  // a row carries BOTH a prompt and a stem and no shared passage covers it,
  // the stem is surfaced as the passage rather than dropped.
  const promptText = (row.prompt ?? '').trim();
  const stemText = (row.stem ?? '').trim();
  const shared = (sharedPassageFor(row.test_passages, row.item_number) ?? '').trim();

  // Served-but-unanswerable guards (D-2 / D-5 — see the placeholder constants):
  //   - a stem that is the no-transcript curator note (D-2; also excluded in
  //     SQL via ANSWERABLE_ITEM_SQL — this is the render-time belt to that
  //     suspender, and the only guard on surfaces that fetch by id, like
  //     /:itemId/answer and /mistakes),
  //   - a shared passage that is the copyright-withholding notice (D-5; the
  //     comprehension question asks about text that is deliberately absent).
  // Either way the item cannot be answered on its merits — drop it exactly
  // like a structurally ungradeable row.
  if (stemText.startsWith(NO_TRANSCRIPT_STEM_PREFIX)) return null;
  if (shared.startsWith(WITHHELD_PASSAGE_PREFIX)) return null;

  const passage =
    shared !== '' ? shared : promptText !== '' && stemText !== '' ? stemText : '';

  return {
    id: row.id,
    section: SECTION_ENUM_TO_KR[row.section],
    number: row.item_number,
    level: proficiencyToLevel(row.proficiency),
    prompt: promptText !== '' ? promptText : stemText,
    ...(passage !== '' ? { passage } : {}),
    options,
    explanation,
    hasImage: row.has_image,
    ...(imageText !== '' ? { imageText } : {}),
  };
}

/** Map a batch of rows, dropping the ones that can't yield a usable item. */
function mapRows(rows: readonly TopikItemRow[]): TopikItemDTO[] {
  const out: TopikItemDTO[] = [];
  for (const row of rows) {
    const dto = mapRowToDTO(row);
    if (dto !== null) out.push(dto);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mock-mode answer-strip (FU-NF-39) — the diagnostic pattern for /topik/mock.
//
// The answer-strip is TYPE-LEVEL, not a runtime delete: the wire DTO is built
// from `Omit`s so it has NO `correct` field on a choice and NO `explanation`
// field at all. A regression that tried to copy `correct`/`explanation` onto a
// mock item would fail to compile, so the answer cannot leak by accident — the
// only field on a mock choice is `{ id, kr, en }`, and the only fields on a mock
// item are id/section/number/level/prompt/passage/passageRef/options plus the
// image metadata (`hasImage`/`imageText`). `passage` is the shared reading text
// the QUESTION is about (B-008) — question content, not answer data, exactly
// like the prompt itself. The `correct` flag + `explanation` are revealed only
// by `POST /topik/mock/submit`, post-exam.
// ---------------------------------------------------------------------------

/** A mock choice — the study choice with `correct` removed (type-level). */
type TopikMockChoiceDTO = Omit<TopikChoiceDTO, 'correct'>;

/** A mock item — the study item with `options[].correct` and `explanation`
 *  removed (type-level). `passageRef` is preserved if present. */
type TopikMockItemDTO = Omit<TopikItemDTO, 'options' | 'explanation'> & {
  readonly options: readonly TopikMockChoiceDTO[];
};

/**
 * Strip a study DTO down to the mock wire DTO. Because the return type Omits
 * `correct`/`explanation`, this function physically cannot emit them — the
 * answer is dropped at the boundary. `explanation` is simply not read here.
 * `hasImage`/`imageText` survive the strip: they describe the QUESTION (an
 * image the exam PDF showed), carry no answer information, and the exam needs
 * them to render image-dependent items answerably. `passage` survives for the
 * same reason (B-008): it is the reading text the question is asked about —
 * without it a shared-passage item is unanswerable in the timed exam.
 */
function toMockItemDTO(item: TopikItemDTO): TopikMockItemDTO {
  return {
    id: item.id,
    section: item.section,
    number: item.number,
    level: item.level,
    prompt: item.prompt,
    ...(item.passage !== undefined ? { passage: item.passage } : {}),
    ...(item.passageRef !== undefined ? { passageRef: item.passageRef } : {}),
    options: item.options.map((o) => ({ id: o.id, kr: o.kr, en: o.en })),
    hasImage: item.hasImage,
    ...(item.imageText !== undefined ? { imageText: item.imageText } : {}),
  };
}

// ---------------------------------------------------------------------------
// Mock readiness band — percentage → a simple readiness label.
//
// No shared percentage→band map exists (the diagnostic's bands are θ-derived,
// not percentage-derived — see services/diagnostic/cat.ts `bandForTheta`), so
// the mock surface owns this percentage→readiness mapping. The thresholds and
// the TOPIK-level vocabulary (L3/L4/L5+) match the contract (§A2):
//   ≥ 80  → 'On track for L5+'
//   60–79 → 'L4 range'
//   40–59 → 'L3 range'
//   < 40  → 'Below L3'
// ---------------------------------------------------------------------------
function bandForPercentage(percentage: number): string {
  if (percentage >= 80) return 'On track for L5+';
  if (percentage >= 60) return 'L4 range';
  if (percentage >= 40) return 'L3 range';
  return 'Below L3';
}

/** The SELECT column list shared by every item-fetching query. */
// Columns are qualified with the `i` alias because every query below JOINs
// topik_tests as `t` (which also has an `id` column) — an unqualified `id` is
// ambiguous (Postgres error 42702). The join is required everywhere since
// B-008: `t.passages` carries the shared reading passages the DTO resolves the
// item's passage from, so every query that uses ITEM_COLUMNS must alias
// topik_items as `i` AND join topik_tests as `t`.
const ITEM_COLUMNS = `i.id::text AS id,
                      i.section::text AS section,
                      i.item_number,
                      i.proficiency::text AS proficiency,
                      i.stem, i.prompt, i.options, i.answer,
                      i.has_image, i.image_text, i.extra,
                      t.passages AS test_passages`;

/**
 * The answerable-item guard, shared by every draw/assembly so they all agree:
 *   - >= 2 options AND a non-null answer (the "survivor guard" — mirrors the
 *     /answer lookup and the diagnostic's pickTopikRow).
 *   - excludes picture-choice listening items: 60 items whose `options` are bare
 *     ①②③④ glyphs with has_image=true but NO image asset and NULL image_text,
 *     so all four choices render identically and the item is unanswerable
 *     (tester sweep P2-1). 900 answerable listening items remain — plenty for a
 *     mock. Assumes topik_items is aliased `i`.
 *   - excludes no-transcript listening items (D-2): 28 items whose stem is the
 *     "[듣기 지문 없음 …]" curator note — real options + answer key, but the
 *     audio content was never transcribed, so the learner would guess blind.
 *     coalesce() keeps a NULL stem from failing the NOT LIKE (NULL-propagation
 *     would silently drop every stem-less row).
 */
const ANSWERABLE_ITEM_SQL =
  "jsonb_array_length(i.options) >= 2 AND i.answer IS NOT NULL " +
  "AND i.options->>0 NOT IN ('①','②','③','④') " +
  `AND coalesce(i.stem, '') NOT LIKE '${NO_TRANSCRIPT_STEM_PREFIX}%'`;

// Official TOPIK II section size (F-UP-007): the corpus tests carry MORE items
// than the real exam, so a mock caps to the first N answerable items per section
// (ORDER BY item_number). Reading and Listening are both 50 on TOPIK II; Writing
// mock is deferred (FU-NF-47). The client's section-select already advertises 50,
// so this makes the served count match the label.
const OFFICIAL_MOCK_SECTION_SIZE = 50;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const ItemsQuerySchema = z.object({
  section: SectionSchema.optional(),
  level: LevelSchema.optional(),
  // .max(INT4_MAX): test_number is an INTEGER column — an unbounded coerce lets
  // 1e20 pass `.int()` (Number.isInteger(1e20) is true) and overflow in pg
  // (22003 → 500) where a garbage id should 400 at the boundary.
  source_test: z.coerce.number().int().positive().max(INT4_MAX).optional(),
  // Optional exam-paper discriminator (D-1): TOPIK I and TOPIK II sittings share
  // every test_number, so a source_test browse without this spans BOTH papers
  // (intentional for browse — "everything from sitting N" — with a stable
  // test_number, topik_level, item_number order); pass it to see one paper.
  topik_level: TopikLevelSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});

/**
 * GET /topik/items — paginated browse of the item pool.
 *
 * Filters (all optional, ANDed): `section` (accepts enum OR Korean label),
 * `level` (proficiency band), `source_test` (topik_tests.test_number). Returns
 * `{ items, total }` where `total` is the count of the browsable (gradeable)
 * pool matching the filter and `items` is the page mapped to DTOs. Stable
 * ORDER BY (test_number, item_number).
 *
 * The survivor guard (`jsonb_array_length(options) >= 2 AND answer IS NOT NULL`)
 * is pushed into the WHERE of BOTH the count and the page query — the same guard
 * the /answer lookup and the diagnostic's pickTopikRow rely on — so `total`
 * equals the browsable pool by construction and no row is silently consumed by
 * an offset slot only to be dropped post-fetch by mapRowToDTO. (mapRowToDTO is
 * still the authoritative render-time guard for the residual case a non-null
 * `answer` is a non-int/object — a writing-item answer — which SQL cannot fully
 * filter; for section-filtered reading/listening browses the two agree exactly.)
 */
router.get('/items', cheapLimiter(), validateQuery(ItemsQuerySchema), async (req, res, next) => {
  try {
    const q = (req as typeof req & {
      validatedQuery: z.infer<typeof ItemsQuerySchema>;
    }).validatedQuery;

    // Build the shared WHERE once so the count and the page agree exactly. The
    // survivor guard restricts both to gradeable rows (>=2 options, non-null
    // answer), mirroring the /answer lookup + pickTopikRow.
    const filters: string[] = [ANSWERABLE_ITEM_SQL];
    const filterParams: unknown[] = [];
    if (q.section !== undefined) {
      filterParams.push(q.section);
      filters.push(`i.section = $${filterParams.length}::topik_section`);
    }
    if (q.level !== undefined) {
      filterParams.push(q.level);
      filters.push(`i.proficiency = $${filterParams.length}::proficiency_level`);
    }
    if (q.source_test !== undefined) {
      filterParams.push(q.source_test);
      filters.push(`t.test_number = $${filterParams.length}`);
    }
    if (q.topik_level !== undefined) {
      filterParams.push(q.topik_level);
      filters.push(`t.topik_level = $${filterParams.length}`);
    }
    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    const countResult = await query<{ total: string }>(
      `SELECT count(*)::text AS total
         FROM topik_items i
         JOIN topik_tests t ON t.id = i.topik_test_id
        ${whereClause}`,
      filterParams,
    );
    const total = Number(countResult.rows[0]?.total ?? '0');

    // Page params follow the filter params so placeholder numbering stays valid.
    const pageParams = [...filterParams, q.limit, q.offset];
    const limitPlaceholder = `$${filterParams.length + 1}`;
    const offsetPlaceholder = `$${filterParams.length + 2}`;
    const { rows } = await query<TopikItemRow>(
      `SELECT ${ITEM_COLUMNS}
         FROM topik_items i
         JOIN topik_tests t ON t.id = i.topik_test_id
        ${whereClause}
        ORDER BY t.test_number, t.topik_level, i.item_number
        LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      pageParams,
    );

    res.status(200).json({ items: mapRows(rows), total });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /topik/tests — enumerate available TOPIK papers (F-118).
//
// Feeds the F-079 Mock exam chooser's per-paper list (today it renders an
// honest-pending note — see MockMode.tsx's `ExamChooser`). Reference data,
// like /items: topik_tests/topik_items carry no ownership, so this is not
// user-scoped — but the route still sits behind `requireAuth` like every
// route in this router.
// ---------------------------------------------------------------------------

const TestsQuerySchema = z.object({
  section: SectionSchema.optional(),
  topik_level: TopikLevelSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

/** One TOPIK paper summary — a (test_number, topik_level, section) group. */
interface TopikTestSummaryDTO {
  testNumber: number;
  topikLevel: TopikLevel;
  section: SectionKr;
  /**
   * The ANSWERABLE item count for this paper's section, capped at
   * `OFFICIAL_MOCK_SECTION_SIZE` — matches EXACTLY what `POST /topik/mock`
   * would serve for this (test_number, topik_level, section), so the chooser
   * never advertises a count the exam itself would not deliver (F-UP-007:
   * the corpus carries more items per test than the official exam).
   */
  itemCount: number;
}

interface TestSummaryRow {
  test_number: number;
  topik_level: TopikLevel;
  section: SectionEnum;
  item_count: number;
}

/**
 * GET /topik/tests — enumerate available TOPIK papers (F-118).
 *
 * Groups `topik_items` by their parent (test_number, topik_level, section) —
 * the natural key migration 029 introduced (D-1: TOPIK I/II sittings share
 * every test_number) — and reports the ANSWERABLE item count for each,
 * capped at `OFFICIAL_MOCK_SECTION_SIZE` (the same survivor guard + cap
 * `/mock` and `/mock/submit` use), so a client browsing papers sees exactly
 * what a mock would serve. A paper with ZERO answerable items is excluded
 * (there is nothing to take — mirrors `/items`' `total == browsable pool`
 * posture). `section`/`topik_level` filters are optional and ANDed; the
 * response `total` is the filtered PAPER count for pagination (not an item
 * count), mirroring `GET /items`'s `{ items, total }` shape.
 */
router.get('/tests', cheapLimiter(), validateQuery(TestsQuerySchema), async (req, res, next) => {
  try {
    const q = (req as typeof req & {
      validatedQuery: z.infer<typeof TestsQuerySchema>;
    }).validatedQuery;

    const filters: string[] = [];
    const params: unknown[] = [];
    if (q.section !== undefined) {
      params.push(q.section);
      filters.push(`i.section = $${params.length}::topik_section`);
    }
    if (q.topik_level !== undefined) {
      params.push(q.topik_level);
      filters.push(`t.topik_level = $${params.length}`);
    }
    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    const countResult = await query<{ total: string }>(
      `SELECT count(*)::text AS total
         FROM (
                SELECT t.test_number, t.topik_level, t.section
                  FROM topik_tests t
                  JOIN topik_items i ON i.topik_test_id = t.id
                 ${whereClause}
                 GROUP BY t.test_number, t.topik_level, t.section
                HAVING count(*) FILTER (WHERE ${ANSWERABLE_ITEM_SQL}) > 0
              ) papers`,
      params,
    );
    const total = Number(countResult.rows[0]?.total ?? '0');

    const pageParams = [...params, q.limit, q.offset];
    const limitPlaceholder = `$${params.length + 1}`;
    const offsetPlaceholder = `$${params.length + 2}`;
    const { rows } = await query<TestSummaryRow>(
      `SELECT t.test_number, t.topik_level, t.section::text AS section,
              LEAST(count(*) FILTER (WHERE ${ANSWERABLE_ITEM_SQL}), ${OFFICIAL_MOCK_SECTION_SIZE})::int AS item_count
         FROM topik_tests t
         JOIN topik_items i ON i.topik_test_id = t.id
        ${whereClause}
        GROUP BY t.test_number, t.topik_level, t.section
       HAVING count(*) FILTER (WHERE ${ANSWERABLE_ITEM_SQL}) > 0
        ORDER BY t.test_number DESC, t.topik_level DESC, t.section
        LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      pageParams,
    );

    const tests: TopikTestSummaryDTO[] = rows.map((r) => ({
      testNumber: r.test_number,
      topikLevel: r.topik_level,
      section: SECTION_ENUM_TO_KR[r.section],
      itemCount: Number(r.item_count),
    }));

    res.status(200).json({ tests, total });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /topik/audio/:testNumber/:level — official listening MP3 (F-119 Phase 4)
// ---------------------------------------------------------------------------

/** URL level discriminator → topik_tests.topik_level. Anything else → 404. */
const TOPIK_AUDIO_LEVELS: Readonly<Record<string, TopikLevel>> = {
  '1': 'TOPIK I',
  '2': 'TOPIK II',
};

/**
 * Resolve a raw `:level` path segment to a topik_level, or undefined (→ the
 * uniform 404). Object.hasOwn first: TOPIK_AUDIO_LEVELS is a plain object
 * literal, so a bare index with a prototype-chain key ('constructor',
 * '__proto__', 'toString') would return a non-undefined INHERITED value and
 * defeat an `=== undefined` guard — pg would then coerce that Function/object
 * to text and the query would (today) just match zero rows, but correctness
 * must not rest on pg's coercion of a prototype object. Exported ONLY for the
 * unit test that pins this hardening (the slip is not observable over HTTP —
 * see topik.audio.test.ts).
 */
export function resolveTopikAudioLevel(level: string | undefined): TopikLevel | undefined {
  const key = level ?? '';
  return Object.hasOwn(TOPIK_AUDIO_LEVELS, key) ? TOPIK_AUDIO_LEVELS[key] : undefined;
}

// Positive int, capped at int4 (test_number is INTEGER — an overflowing path
// value must die at the boundary, never reach pg as a 22003 → 500).
const TopikAudioTestNumberSchema = z.coerce.number().int().positive().max(INT4_MAX);

/**
 * GET /topik/audio/:testNumber/:level — stream a paper's whole-section
 * official listening MP3 (F-119 Phase 4; plan §7). `:level` ∈ {1, 2} maps to
 * 'TOPIK I'/'TOPIK II' (the migration-029 natural key needs it — TOPIK I/II
 * sittings share every test_number, D-1); the section is pinned to
 * 'listening' (the only section with audio).
 *
 * Semantics + posture:
 *   - UNIFORM 404 for everything that isn't a streamable paper: a malformed
 *     testNumber/level, an unknown paper, and a paper with no audio mapped
 *     (audio_path NULL) are all indistinguishable NotFoundErrors — the
 *     message here MUST stay byte-identical to corpusAudio.ts's
 *     ('no audio for this unit') so the wire body never distinguishes a
 *     malformed URL from a missing paper/file — this surface confirms
 *     nothing about what papers/files exist, and a garbage URL can never
 *     produce a 500. (Deliberate deviation from the 400-on-validation
 *     convention: unlike a POST body, a bad path segment here is just a
 *     resource that does not exist.)
 *   - NON-user-scoped BY DESIGN: like /ttmik and /iyagi audio (and unlike
 *     Track A's IDOR-guarded user /audio surface), the official exam MP3s are
 *     shared licensed corpus content — requireAuth (router-level) is the only
 *     gate, there is no per-user ownership to check.
 *   - mediaLimiter, not cheapLimiter: seeking audio legitimately fires bursts
 *     of Range requests (the ttmik/iyagi audio-route precedent).
 *   - Path resolution + traversal/symlink defenses + Range mechanics live in
 *     services/corpusAudio.ts (shared with TTMIK/Iyagi — one hardened
 *     streamer, no drift).
 */
router.get('/audio/:testNumber/:level', mediaLimiter(), async (req, res, next) => {
  try {
    const testNumber = TopikAudioTestNumberSchema.safeParse(req.params.testNumber);
    // noUncheckedIndexedAccess types req.params.level string | undefined; an
    // absent segment can't match a level and falls into the uniform 404.
    // resolveTopikAudioLevel is own-property-guarded (Object.hasOwn) so a
    // prototype-chain key ('constructor', '__proto__', 'toString') 404s here
    // like any other bad level instead of reaching the query.
    const topikLevel = resolveTopikAudioLevel(req.params.level);
    if (!testNumber.success || topikLevel === undefined) {
      throw new NotFoundError('no audio for this unit');
    }
    const { rows } = await query<{ audio_path: string | null }>(
      `SELECT audio_path
         FROM topik_tests
        WHERE test_number = $1 AND topik_level = $2 AND section = 'listening'::topik_section`,
      [testNumber.data, topikLevel],
    );
    // No row and a NULL audio_path collapse to the same uniform 404 inside
    // streamCorpusAudio ("no such paper" vs "no audio mapped" is not leaked).
    await streamCorpusAudio(req, res, next, rows[0]?.audio_path ?? null);
  } catch (err) {
    next(err);
  }
});

const MistakesQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

interface MistakeRow extends TopikItemRow {
  response_id: number;
  picked: string;
  answered_at: Date;
  mode: string;
  /** NULL for a study-mode miss (no attempt) or a pre-046 response. */
  attempt_id: string | null;
}

interface MistakeDTO {
  responseId: string;
  /** The choice id the user picked (wrong). */
  picked: ChoiceId;
  answeredAt: string;
  mode: string;
  /**
   * The `topik_attempts` sitting this mistake was graded under (F-105), or
   * `null` — a study-mode miss belongs to no attempt (mock is the only mode
   * that stamps `attempt_id`, at submit time — see `/mock/submit`), and a
   * pre-046 response predates the column entirely. Lets the client link a
   * mistake back to its exam attempt (F-104's history) — see the route doc.
   */
  attemptId: string | null;
  item: TopikItemDTO;
}

/**
 * GET /topik/mistakes — the caller's recent WRONG answers, for review (F-021).
 *
 * Returns TOPIK items the SESSION user answered incorrectly within the last
 * `days` (default 30 — the rolling window; a query WINDOW, not deletion), newest
 * first, each with the FULL item (options + which is `correct` + `explanation`)
 * plus the user's wrong `picked` choice and when they answered. Serving the
 * answer key here is intentional and safe: these are items the user already
 * attempted (their OWN response log), so this is a review surface, not a browse
 * (like /items and /study, which also carry the inline key for authenticated
 * reads — only the answer-stripped exam flow /mock withholds it until submit).
 * User-scoped to `getUserId(req)` —
 * never a client-supplied id (no IDOR). Backed by
 * ix_topik_responses_user_answered_at (user_id, answered_at DESC).
 *
 * F-105: each row also carries `attemptId` (`topik_responses.attempt_id`,
 * migration 046) — `null` for a study-mode miss (mistakes are logged for
 * both modes; only mock stamps an attempt) or a pre-046 response. Lets the
 * client group/link a mistake back to its true exam sitting instead of the
 * (local-day, mode) heuristic the Mistakes page's session selector uses
 * today (see that page's own doc comment).
 */
router.get(
  '/mistakes',
  cheapLimiter(),
  validateQuery(MistakesQuerySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const q = (
        req as typeof req & { validatedQuery: z.infer<typeof MistakesQuerySchema> }
      ).validatedQuery;
      const { rows } = await query<MistakeRow>(
        `SELECT ${ITEM_COLUMNS},
                r.id AS response_id, r.picked, r.answered_at, r.mode::text AS mode,
                r.attempt_id::text AS attempt_id
           FROM topik_responses r
           JOIN topik_items i ON i.id = r.topik_item_id
           JOIN topik_tests t ON t.id = i.topik_test_id
          WHERE r.user_id = $1
            AND r.is_correct = false
            AND r.answered_at > now() - make_interval(days => $2)
          ORDER BY r.answered_at DESC
          LIMIT $3`,
        [userId, q.days, q.limit],
      );
      const mistakes: MistakeDTO[] = [];
      for (const row of rows) {
        const item = mapRowToDTO(row);
        // Skip a row whose item is no longer a usable MC item (corpus edit).
        if (item === null) continue;
        mistakes.push({
          responseId: String(row.response_id),
          picked: row.picked as ChoiceId,
          answeredAt: row.answered_at.toISOString(),
          mode: row.mode,
          attemptId: row.attempt_id,
          item,
        });
      }
      res.status(200).json({ mistakes });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Per-skill stats time-series (F-017).
// ---------------------------------------------------------------------------

const SeriesQuerySchema = z.object({
  // Same rolling window as /mistakes: 1..90 days, default 30. Out-of-range
  // 400s at the boundary (ValidationError), matching /mistakes.
  days: z.coerce.number().int().min(1).max(90).default(30),
});

/** One daily data point on the F-017 stats chart. */
interface SeriesPointDTO {
  /** UTC day bucket, formatted 'YYYY-MM-DD' in SQL — no client tz reinterpretation. */
  date: string;
  value: number;
}

/**
 * The per-skill series shape the client's stats chart consumes (F-017 locked
 * contract). `points` is ASCENDING by date with one entry per day that has
 * activity — days without activity are absent, not zero-filled.
 */
interface SkillSeriesDTO {
  metric: 'accuracy' | 'count' | 'score';
  unit: string;
  points: SeriesPointDTO[];
}

interface SeriesRow {
  section: 'reading' | 'listening';
  date: string;
  value: number;
}

/**
 * GET /topik/series — daily TOPIK accuracy time-series, split by section (F-017).
 *
 * Buckets the caller's `topik_responses` log by UTC day over the last `days`
 * (default 30) and returns per-day accuracy (round(100 * correct / total)) for
 * the reading and listening sections separately. Days with no answers in a
 * section simply have no point (the chart draws gaps, not zeroes). Writing has
 * no graded MC answers (mock is reading/listening only — FU-NF-47), so it is
 * excluded at the SQL level.
 *
 * User-scoped to `getUserId(req)` — never a client-supplied id (no IDOR).
 * Bucketing pins `AT TIME ZONE 'UTC'` so the day boundary is stable regardless
 * of the DB session TimeZone GUC. Backed by
 * ix_topik_responses_user_answered_at (user_id, answered_at DESC).
 */
router.get(
  '/series',
  cheapLimiter(),
  validateQuery(SeriesQuerySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const q = (
        req as typeof req & { validatedQuery: z.infer<typeof SeriesQuerySchema> }
      ).validatedQuery;
      const { rows } = await query<SeriesRow>(
        `SELECT i.section::text AS section,
                to_char((r.answered_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date,
                round(100.0 * count(*) FILTER (WHERE r.is_correct) / count(*))::int AS value
           FROM topik_responses r
           JOIN topik_items i ON i.id = r.topik_item_id
          WHERE r.user_id = $1
            AND r.answered_at > now() - make_interval(days => $2)
            AND i.section IN ('reading'::topik_section, 'listening'::topik_section)
          GROUP BY i.section, (r.answered_at AT TIME ZONE 'UTC')::date
          ORDER BY (r.answered_at AT TIME ZONE 'UTC')::date`,
        [userId, q.days],
      );
      const skillSeries = (section: SeriesRow['section']): SkillSeriesDTO => ({
        metric: 'accuracy',
        unit: '%',
        points: rows
          .filter((r) => r.section === section)
          .map((r) => ({ date: r.date, value: r.value })),
      });
      res.status(200).json({
        reading: skillSeries('reading'),
        listening: skillSeries('listening'),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Mock-attempt persistence — resume an in-progress test (F-007).
// ---------------------------------------------------------------------------

const AttemptSectionSchema = z.enum(['reading', 'listening']);

// ---------------------------------------------------------------------------
// Attempt lifecycle (migration 046 — A1, TOPIK attempt history).
//
// topik_attempts carries an explicit `status` column:
//   - 'active'    — the in-progress attempt. AT MOST ONE per user, enforced by
//                   the partial unique uq_topik_attempts_user_active; the
//                   resume banner (F-007) reads exactly this row.
//   - 'completed' — submitted + graded via POST /topik/mock/submit. RETAINED
//                   as attempt history (F-078/F-082); its topik_responses rows
//                   are stamped with the attempt's id in the same transaction.
//   - 'abandoned' — discarded via DELETE /topik/attempt. Also retained.
// This replaces the pre-046 single-slot model where "submitted" was a
// '__closed__' tombstone key smuggled inside the picks JSONB (F-UP-014).
//
// The F-UP-014 resurrect race still exists and is still guarded: a progress
// PUT /topik/attempt can be on the wire when the exam submits; the client
// aborts it and fires a clearAttempt() mop-up, but the abort is client-side
// only — a PUT the server processes AFTER the submit would otherwise INSERT a
// fresh 'active' row and resurface a resume banner for a graded test. The
// guard: PUT refuses (silent 204 no-op) to create/overwrite an attempt for a
// (source_test, section) whose COMPLETED attempt is fresher than the grace
// window — exactly the shape of the delayed racing save. A save for a
// DIFFERENT paper (a new mock) always wins; after the window a retake of the
// same paper saves normally (retakes are never permanently blocked); and an
// ABANDONED attempt never blocks anything (abandon + immediately restart the
// same paper is a legitimate flow, not a race artifact).
//
// Grace window: the racing PUT lands within (milli)seconds of the submit —
// 15s is generous for a delayed request while keeping an immediate same-paper
// retake's save-blackout short (each refused save is silently absorbed and the
// next tick after the window lands; picks are re-sent cumulatively).
//
// SERIALIZATION (closes the READ-COMMITTED window the pre-046 tombstone design
// never had): the guard above is an INSERT ... SELECT WHERE NOT EXISTS, and
// under READ COMMITTED a PUT processed while the submit transaction is still
// OPEN takes its snapshot before the submit commits — it sees no fresh
// completed row, and when its speculative insert then blocks on the submit's
// row lock and the committed row no longer satisfies the partial arbiter's
// predicate (status flipped to 'completed'), Postgres retries the insertion
// WITHOUT re-evaluating the NOT EXISTS — resurrecting an active row for a
// just-graded paper. Fix: PUT and /mock/submit both take the same per-user
// transaction-scoped advisory lock (ATTEMPT_LOCK_SQL) before touching
// topik_attempts, so a racing PUT cannot overlap an open submit: it waits for
// the submit to commit and its guard then sees the fresh completed row. The
// lock is xact-scoped (auto-released on commit/rollback — no leak path),
// namespaced by the 'topik_attempt:' prefix so it can never collide with a
// future advisory-lock user keyed on the same id, and hashtextextended handles
// the BIGINT user id without int4 truncation.
// ---------------------------------------------------------------------------
const ATTEMPT_COMPLETED_GRACE_SECONDS = 15;

/**
 * Per-user serialization of attempt-lifecycle writers (PUT /topik/attempt and
 * POST /topik/mock/submit). $1 = the session user id. MUST be the first
 * statement of the caller's transaction (an advisory lock taken outside a
 * transaction would not be xact-scoped; pg_advisory_xact_lock errors outside
 * one, so misuse fails loudly).
 */
const ATTEMPT_LOCK_SQL =
  `SELECT pg_advisory_xact_lock(hashtextextended('topik_attempt:' || $1::text, 0))`;

// source_test / current_idx / remaining_ms are INTEGER columns — INT4-bounded
// at the boundary (INT4_MAX, defined with the domain constants above).
const AttemptBodySchema = z
  .object({
    section: AttemptSectionSchema,
    sourceTest: z.number().int().positive().max(INT4_MAX),
    currentIdx: z.number().int().nonnegative().max(INT4_MAX),
    // { "<topik_item_id>": "a"|"b"|"c"|"d" } — the picks so far. Keys are numeric
    // item-id strings; values are choice ids.
    picks: z.record(z.string().regex(/^\d+$/), z.enum(['a', 'b', 'c', 'd'])),
    remainingMs: z.number().int().nonnegative().max(INT4_MAX),
    // OPTIONAL exam-paper discriminator (F-122 / migration 066). The intended
    // caller only ever echoes a level the SERVER already resolved and
    // returned from a prior POST /topik/mock call — but unlike
    // MockSubmitBodySchema.topikLevel (which is always cross-checked against
    // the corpus by resolveMockTest before grading), this schema alone
    // cannot verify that; the ROUTE HANDLER re-validates it against
    // (sourceTest, section) via resolveMockTest before persisting (batch-2
    // fix-pass SHOULD-FIX 3) rather than trusting this shape-only check.
    // Omitted by pre-F-122 clients (or dropped to NULL by that re-validation
    // when it doesn't match a real paper); the row's persisted topik_level
    // then stays NULL and reads fall back to the pre-066 best-effort
    // re-derivation.
    topikLevel: TopikLevelSchema.optional(),
  })
  // A mock section is <= 50 items (F-UP-007); cap the picks map so a malformed
  // client cannot stuff an unbounded JSONB blob into the row.
  .refine((b) => Object.keys(b.picks).length <= 60, {
    message: 'too many picks for a single mock section',
  });

interface AttemptRow {
  section: string;
  source_test: number;
  current_idx: number;
  picks: Record<string, string>;
  remaining_ms: number;
  updated_at: Date;
  /** F-122 (migration 066) — NULL for a pre-066 row or one saved by a client
   *  that never sent `topikLevel`. */
  topik_level: TopikLevel | null;
}

/**
 * GET /topik/attempt — the caller's single in-progress mock attempt, or null.
 *
 * User-scoped (`getUserId` — no IDOR); feeds the mock-select screen's resume
 * banner (F-007). "In progress" is exactly `status = 'active'` (046): at most
 * one such row exists per user (uq_topik_attempts_user_active), and completed/
 * abandoned history rows never resurface as resumable.
 *
 * F-173: also resolves `totalItems`/`topikLevel` for the resumed attempt so a
 * client can show "answered / total" instead of just a bare answered count.
 * F-122 (migration 066): when the row itself carries a REAL persisted
 * `topik_level` (saved via `PUT /topik/attempt`'s optional `topikLevel`, or
 * stamped by a prior `/mock/submit`), that exact level is used directly —
 * `totalItems` is then computed against that KNOWN paper
 * (`resolveTotalItemsForLevel`), never re-guessed. Only a pre-066 row (or one
 * saved by a client that never sent `topikLevel`) falls back to the ORIGINAL
 * best-effort re-derivation `GET /topik/attempts` also uses for legacy rows
 * (`resolveServedTotal`) — the identical deterministic resolution
 * (`resolveMockTest` with no requestedLevel) and the identical safe fallback:
 * when the backing corpus paper is gone, `totalItems` falls back to the
 * attempt's own answered count — a real, non-fabricated LOWER BOUND, never a
 * guess above what is actually known.
 */
router.get('/attempt', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { rows } = await query<AttemptRow>(
      `SELECT section::text AS section, source_test, current_idx, picks,
              remaining_ms, updated_at, topik_level
         FROM topik_attempts
        WHERE user_id = $1
          AND status = 'active'`,
      [userId],
    );
    const row = rows[0];
    if (!row) {
      res.status(200).json({ attempt: null });
      return;
    }
    const answered = Object.keys(row.picks).length;
    // row.section is only ever 'reading' | 'listening' — AttemptSectionSchema
    // (the PUT body's validator) rejects 'writing' at the boundary, so no
    // topik_attempts row can carry it.
    const section = row.section as Extract<SectionEnum, 'reading' | 'listening'>;
    let topikLevel: TopikLevel | null;
    let totalItems: number;
    if (row.topik_level !== null) {
      // F-122: the row KNOWS its level for certain — resolve totalItems
      // against that exact paper, never a re-guessed one. `Math.max` with
      // `answered` preserves the pre-F-122 "never fabricate BELOW what is
      // actually known" guarantee: if the backing corpus paper has since
      // been edited/removed, resolveTotalItemsForLevel can legitimately
      // return fewer (even 0) answerable items than were actually answered —
      // the real answered count is always a valid lower bound.
      topikLevel = row.topik_level;
      totalItems = Math.max(
        await resolveTotalItemsForLevel(section, row.source_test, row.topik_level),
        answered,
      );
    } else {
      // Pre-066 row (or a topikLevel-less save) — the original best-effort guess.
      const served = await resolveServedTotal(section, row.source_test);
      topikLevel = served?.topikLevel ?? null;
      totalItems = served?.totalItems ?? answered;
    }
    res.status(200).json({
      attempt: {
        section: row.section,
        sourceTest: row.source_test,
        topikLevel,
        currentIdx: row.current_idx,
        picks: row.picks,
        remainingMs: row.remaining_ms,
        answered,
        totalItems,
        updatedAt: row.updated_at.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /topik/attempt — save (upsert) the caller's in-progress mock attempt.
 *
 * ONE ACTIVE row per user: the upsert arbiters on the 046 partial unique via
 * `ON CONFLICT (user_id) WHERE status = 'active'`, so advancing/starting a
 * mock updates the single active attempt in place (completed/abandoned history
 * rows are never touched). `user_id` is the SESSION id, never client-supplied.
 * The client calls this as the user answers + on unmount.
 *
 * F-UP-014 resurrect guard: the INSERT ... SELECT's WHERE refuses to save when
 * a COMPLETED attempt for the SAME (source_test, section) is fresher than the
 * grace window — the exact shape of a racing save the server delayed past the
 * submit (post-submit there is no active row, so the race would otherwise
 * insert a fresh one and resurrect the banner). The refused save is a silent
 * 204 no-op (the attempt it was saving is already graded; there is nothing to
 * keep). Any other save — a different paper, the same paper after the window,
 * or a retake after an ABANDON (abandoned rows never block) — proceeds.
 *
 * The upsert runs in a transaction whose first statement is the per-user
 * advisory lock (ATTEMPT_LOCK_SQL) so it can never overlap /mock/submit's
 * open transaction — see the SERIALIZATION note above ATTEMPT_LOCK_SQL.
 *
 * KNOWN DATA GAP (deliberate 037 parity — revisit before F-078/F-082 build on
 * this data): starting a NEW mock while another paper's attempt is still
 * active repurposes that active row in place via the DO UPDATE, so the
 * displaced unfinished sitting leaves NO abandoned history row (unlike an
 * explicit DELETE /topik/attempt) and the reused row's created_at predates
 * the new sitting. If history surfaces need the displaced sitting, switch to
 * abandon-then-insert here (or have the client abandon first).
 *
 * F-122 (migration 066): body carries an OPTIONAL `topikLevel`, cross-checked
 * against the corpus (`resolveMockTest`, the SAME resolver `/mock` and
 * `/mock/submit` use) before it is persisted, then written verbatim
 * (`topik_level = EXCLUDED.topik_level`, unconditionally — no
 * COALESCE-preserve-if-omitted).
 *
 * Batch-2 fix-pass SHOULD-FIX 3: prior to this cross-check, a client-supplied
 * `topikLevel` was persisted with NO server-side verification that it
 * actually paired with the given `(sourceTest, section)` in the corpus — a
 * client could send e.g. `{ sourceTest: 91, section: 'reading', topikLevel:
 * 'TOPIK I' }` even if test 91's reading section only exists for `'TOPIK
 * II'`. Low blast radius (a mismatched level just makes
 * `resolveTotalItemsForLevel` find 0 rows on a later `GET /topik/attempt`,
 * which gracefully falls back to `Math.max(0, answered) = answered`, and is
 * fully overwritten by `/mock/submit`'s authoritative stamp at completion
 * regardless), but unverified input persisted as if authoritative all the
 * same. `resolveMockTest(section, sourceTest, topikLevel)` returns null when
 * no gradeable paper matches that exact triple; a mismatch is dropped to
 * `NULL` rather than written — NULL is always safe here (the same fallback a
 * pre-F-122/omitted-`topikLevel` client already produces, re-derived at read
 * time by `resolveServedTotal`), so degrading to it on a bad client value has
 * no worse an outcome than the client never having sent one.
 *
 * `resolveMockTest`'s tie-break behavior is otherwise unaffected: this is a
 * verification call (client supplies BOTH `sourceTest` and `topikLevel`, so
 * there's nothing to tie-break — a matching row either exists or it
 * doesn't), not a re-guess.
 *
 * This is deliberate, not an oversight, that the (now-validated) level is
 * persisted unconditionally rather than COALESCE-preserved: a save that
 * repurposes the active row for a DIFFERENT (source_test, section) — the
 * KNOWN DATA GAP above — must never inherit the DISPLACED attempt's level, so
 * "omitted/invalid → NULL" is the only safe default across that repurposing
 * case. The single client call site (`MockMode.tsx`'s `handleSaveProgress`)
 * always has the resolved level in hand (from the `POST /topik/mock`
 * response that started the exam) and always sends a value that matches, so
 * this cross-check is a defense-in-depth measure against a skewed/malicious
 * client, not something the normal flow is expected to ever trip. The one
 * authoritative, NEVER-guessed writer remains `/mock/submit`, which stamps
 * the resolved level on the COMPLETED row regardless of what this route last
 * saved (or validated).
 */
router.put(
  '/attempt',
  cheapLimiter(),
  validateBody(AttemptBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const b = req.body as z.infer<typeof AttemptBodySchema>;

      // Batch-2 fix-pass SHOULD-FIX 3 — re-validate the optional client
      // topikLevel against the corpus before persisting it; see the route
      // doc comment above. A mismatch (or a triple with no gradeable items
      // at all) degrades to NULL rather than being written verbatim.
      let topikLevel: TopikLevel | null = null;
      if (b.topikLevel !== undefined) {
        const resolved = await resolveMockTest(b.section, b.sourceTest, b.topikLevel);
        // resolveMockTest filters on BOTH sourceTest and topikLevel when both
        // are supplied, so a non-null result's fields are guaranteed to echo
        // the request's own (sourceTest, topikLevel) — this is a real-row
        // existence check, not a re-guess.
        topikLevel = resolved?.topikLevel ?? null;
      }

      await withTransaction(async (client) => {
        await client.query(ATTEMPT_LOCK_SQL, [userId]);
        await client.query(
          `INSERT INTO topik_attempts
             (user_id, section, source_test, current_idx, picks, remaining_ms, topik_level)
           SELECT $1, $2::topik_section, $3, $4, $5::jsonb, $6, $8
            WHERE NOT EXISTS (
                  SELECT 1
                    FROM topik_attempts
                   WHERE user_id = $1
                     AND status = 'completed'
                     AND source_test = $3
                     AND section = $2::topik_section
                     AND updated_at > now() - make_interval(secs => $7))
           ON CONFLICT (user_id) WHERE status = 'active' DO UPDATE SET
             section      = EXCLUDED.section,
             source_test  = EXCLUDED.source_test,
             current_idx  = EXCLUDED.current_idx,
             picks        = EXCLUDED.picks,
             remaining_ms = EXCLUDED.remaining_ms,
             topik_level  = EXCLUDED.topik_level,
             version      = topik_attempts.version + 1`,
          [
            userId,
            b.section,
            b.sourceTest,
            b.currentIdx,
            JSON.stringify(b.picks),
            b.remainingMs,
            ATTEMPT_COMPLETED_GRACE_SECONDS,
            topikLevel,
          ],
        );
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

/**
 * DELETE /topik/attempt — abandon the caller's in-progress mock attempt.
 *
 * Used when the user abandons a test / starts fresh. Not a row DELETE since
 * 046: the active attempt is marked `status = 'abandoned'` and RETAINED as
 * attempt history (A1). Idempotent (204 whether or not an active row existed).
 * Submitting a mock closes the attempt separately, inside /mock/submit's
 * transaction (status = 'completed').
 *
 * The post-submit mop-up call the client fires is now a natural no-op — the
 * submit already moved the row out of 'active', and completed rows are never
 * touched here — so the F-UP-014 guard the submit planted (the fresh completed
 * attempt) survives by construction. Abandoned rows never block a resave, so
 * abandoning + immediately restarting a test is unaffected.
 */
router.delete('/attempt', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await query(
      `UPDATE topik_attempts
          SET status = 'abandoned', version = version + 1
        WHERE user_id = $1
          AND status = 'active'`,
      [userId],
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /topik/attempts — completed-attempt history (F-104 / A1).
// ---------------------------------------------------------------------------

const AttemptsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});

/** One completed-attempt history entry, as `GET /topik/attempts` serves it. */
interface TopikAttemptHistoryDTO {
  attemptId: string;
  section: SectionKr;
  sourceTest: number;
  /** Best-effort re-derivation — see `resolveServedTotal`; null if it fails. */
  topikLevel: TopikLevel | null;
  correct: number;
  /** The exam's served item count (capped at OFFICIAL_MOCK_SECTION_SIZE). */
  totalItems: number;
  completedAt: string;
}

interface AttemptHistoryRow {
  attempt_id: string;
  section: SectionEnum;
  source_test: number;
  completed_at: Date;
  correct: string;
  answered: string;
  /** F-122 (migration 066) — NULL for a pre-066 completed attempt. */
  topik_level: TopikLevel | null;
}

/**
 * The served (capped) item count for a KNOWN (section, sourceTest,
 * topikLevel) paper — the exact query `/mock`/`/mock/submit` use to assemble
 * a section, reduced to just its count. Split out of `resolveServedTotal`
 * (F-122) so a caller that already has a REAL, persisted `topik_level` (not
 * a guess) can compute `totalItems` directly against it, without routing
 * through `resolveMockTest`'s tie-break guess at all.
 */
async function resolveTotalItemsForLevel(
  section: SectionEnum,
  sourceTest: number,
  topikLevel: TopikLevel,
): Promise<number> {
  const { rows } = await query<{ total_items: string }>(
    `SELECT count(*)::text AS total_items
       FROM (
              SELECT 1
                FROM topik_items i
                JOIN topik_tests t ON t.id = i.topik_test_id
               WHERE t.test_number = $1
                 AND t.topik_level = $2
                 AND i.section = $3::topik_section
                 AND ${ANSWERABLE_ITEM_SQL}
               ORDER BY i.item_number
               LIMIT ${OFFICIAL_MOCK_SECTION_SIZE}
            ) capped`,
    [sourceTest, topikLevel, section],
  );
  return Number(rows[0]?.total_items ?? '0');
}

/**
 * Best-effort re-derivation of the (topik_level, servedTotal) a completed
 * attempt's mock section was assembled from, for a row with NO persisted
 * `topik_level` (F-104 / A1; F-122 narrowed this to the legacy fallback
 * path — see the callers).
 *
 * Every `topik_attempts` row from BEFORE migration 066 (and any row saved by
 * a pre-F-122 client) carries no real `topik_level` — this reuses the SAME
 * deterministic resolver `POST /topik/mock` and `/mock/submit` used to pick a
 * paper (`resolveMockTest`, with NO requestedLevel) and then
 * `resolveTotalItemsForLevel` for the IDENTICAL LIMIT-`OFFICIAL_MOCK_SECTION_
 * SIZE`-capped total, so the reported total matches EXACTLY what the exam
 * would serve for that (section, sourceTest) today.
 *
 * Returns null when the corpus row backing this paper is gone
 * (`resolveMockTest` → null — e.g. the items were since removed) — there is
 * nothing left to re-derive. The caller falls back to the attempt's actual
 * `topik_responses` answered-count for `totalItems` in that case: a safe,
 * non-fabricated LOWER BOUND, never a guess above what is actually known.
 */
async function resolveServedTotal(
  section: SectionEnum,
  sourceTest: number,
): Promise<{ topikLevel: TopikLevel; totalItems: number } | null> {
  const resolved = await resolveMockTest(section, sourceTest, undefined);
  if (resolved === null) return null;
  const totalItems = await resolveTotalItemsForLevel(section, sourceTest, resolved.topikLevel);
  return { topikLevel: resolved.topikLevel, totalItems };
}

/**
 * GET /topik/attempts — completed mock-attempt history (F-104 / A1).
 *
 * Feeds F-078's daily total, F-079's per-exam completion checkmarks + grade,
 * and F-082's "Previous attempts" review list. User-scoped (`getUserId` — no
 * IDOR), newest-first (`topik_attempts.updated_at` DESC, `id` DESC tiebreak —
 * the moment `status` flipped to 'completed', per the 046 trigger). Only
 * `status = 'completed'` rows are returned — an in-progress ('active') or
 * abandoned attempt is not graded history.
 *
 * `correct`/`answered` are exact aggregates over the attempt's OWN
 * `topik_responses` rows (046 stamps `attempt_id` at submit time — see
 * `/mock/submit`). `totalItems`/`topikLevel` are NOT stored on the attempt
 * row — see `resolveServedTotal` for how they are re-derived. An
 * all-skipped submit writes ZERO `topik_responses` rows (see
 * `/mock/submit`'s doc); `correct`/`answered` are then legitimately 0 — the
 * exam still happened and still enters history, with `totalItems` still
 * resolved from the corpus.
 *
 * Zod-validated paging only (`limit` 1..100 default 20, `offset` >= 0) — no
 * filters, matching the ticket's "optional paging" scope.
 */
router.get(
  '/attempts',
  cheapLimiter(),
  validateQuery(AttemptsQuerySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const q = (req as typeof req & {
        validatedQuery: z.infer<typeof AttemptsQuerySchema>;
      }).validatedQuery;

      const countResult = await query<{ total: string }>(
        `SELECT count(*)::text AS total
           FROM topik_attempts
          WHERE user_id = $1
            AND status = 'completed'`,
        [userId],
      );
      const total = Number(countResult.rows[0]?.total ?? '0');

      // LEFT JOIN LATERAL: one correlated aggregate per attempt (correct /
      // answered from its OWN topik_responses rows), rather than a GROUP BY
      // over a join — a completed attempt with ZERO responses (an
      // all-skipped submit) still yields exactly one row here (coalesced to
      // 0/0), never disappearing from history for lack of answers.
      const { rows } = await query<AttemptHistoryRow>(
        `SELECT a.id::text AS attempt_id,
                a.section::text AS section,
                a.source_test,
                a.updated_at AS completed_at,
                coalesce(r.correct, 0)::text AS correct,
                coalesce(r.answered, 0)::text AS answered,
                a.topik_level
           FROM topik_attempts a
           LEFT JOIN LATERAL (
                  SELECT count(*) FILTER (WHERE is_correct) AS correct,
                         count(*) AS answered
                    FROM topik_responses
                   WHERE attempt_id = a.id
                ) r ON true
          WHERE a.user_id = $1
            AND a.status = 'completed'
          ORDER BY a.updated_at DESC, a.id DESC
          LIMIT $2 OFFSET $3`,
        [userId, q.limit, q.offset],
      );

      // Sequential, not Promise.all: resolveServedTotal/resolveTotalItemsForLevel
      // issue 1-2 small indexed queries per row and a history page is small
      // (<=100, default 20) — this is a personal single-user app (see
      // project_korean_master_personal_scope), so the extra round trips are
      // an acceptable, much simpler alternative to one giant multi-lateral-
      // join query duplicating ANSWERABLE_ITEM_SQL across two aliases.
      const attempts: TopikAttemptHistoryDTO[] = [];
      for (const row of rows) {
        // F-122: a row with a REAL persisted topik_level resolves totalItems
        // against that EXACT paper — never resolveServedTotal's guess, which
        // (via resolveMockTest's tie-break) can name the WRONG level when a
        // test_number hosts both a TOPIK I and a TOPIK II paper. Only a
        // pre-066 row (topik_level NULL) falls back to the legacy guess.
        let topikLevel: TopikLevel | null;
        let totalItems: number;
        if (row.topik_level !== null) {
          topikLevel = row.topik_level;
          // Math.max with the actual answered count: if the backing corpus
          // paper has since been edited/removed, resolveTotalItemsForLevel
          // can legitimately return fewer (even 0) answerable items than
          // were actually answered — the real answered count is always a
          // valid, non-fabricated lower bound (mirrors the legacy branch's
          // own fallback below).
          totalItems = Math.max(
            await resolveTotalItemsForLevel(row.section, row.source_test, row.topik_level),
            Number(row.answered),
          );
        } else {
          const served = await resolveServedTotal(row.section, row.source_test);
          topikLevel = served?.topikLevel ?? null;
          totalItems = served?.totalItems ?? Number(row.answered);
        }
        attempts.push({
          attemptId: row.attempt_id,
          section: SECTION_ENUM_TO_KR[row.section],
          sourceTest: row.source_test,
          topikLevel,
          correct: Number(row.correct),
          totalItems,
          completedAt: row.completed_at.toISOString(),
        });
      }

      res.status(200).json({ attempts, total });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * The mock section schema — like `SectionSchema` (accepts enum OR Korean label),
 * but CONSTRAINED to the MCQ sections. Writing mock (constructed-response, graded
 * by the gradeWriting engine) is deferred to FU-NF-47, so a writing section is
 * rejected at the boundary (400) before it can reach SQL. `refine` runs after the
 * label→enum transform, so both `쓰기` and `writing` are rejected.
 */
const MockSectionSchema = SectionSchema.refine(
  (s): s is Extract<SectionEnum, 'reading' | 'listening'> => s !== 'writing',
  { message: 'mock supports the reading and listening sections only (writing mock is FU-NF-47)' },
);

const MockBodySchema = z
  .object({
    // OPTIONAL — when omitted the server deterministically picks a test for the
    // section (see the route doc). When present it must be a positive int.
    // .max(INT4_MAX): binds to the INTEGER test_number column (overflow → 500
    // without the bound; garbage input must 400 at the boundary).
    sourceTest: z.number().int().positive().max(INT4_MAX).optional(),
    // OPTIONAL exam-paper discriminator (D-1). TOPIK I and TOPIK II sittings
    // share every test_number, so a test_number alone names TWO exams. When
    // omitted the server resolves ONE deterministically (see resolveMockTest);
    // the resolved level is echoed in the response so submit/resume can pin it.
    topikLevel: TopikLevelSchema.optional(),
    section: MockSectionSchema,
  })
  .strict();

/** The single exam paper a mock is assembled from / graded against. */
interface ResolvedMockTest {
  sourceTest: number;
  topikLevel: TopikLevel;
}

/**
 * Resolve the ONE exam paper (test_number + topik_level) a mock draws from.
 *
 * TOPIK I and TOPIK II sittings share every `test_number` (migration 029 widened
 * the natural key to include `topik_level` for exactly this reason), so a mock
 * selected by test_number alone MERGES two different exams — duplicate item
 * numbers, mixed difficulty, and a nondeterministic LIMIT-50 cut (D-1). Every
 * mock surface (assembly AND grading) must therefore resolve to a single
 * (test_number, topik_level) pair before touching topik_items.
 *
 * Resolution is deterministic: among tests with at least one gradeable item in
 * the section (the same survivor guard the rest of the file uses), constrained
 * by whichever of `requestedTest` / `requestedLevel` the client supplied, pick
 * the HIGHEST test_number ("the newest test") and, within it, TOPIK II over
 * TOPIK I (the level with the L3+ prep audience; 'TOPIK II' > 'TOPIK I'
 * lexically, so a plain ORDER BY DESC expresses it). Because /mock and
 * /mock/submit share this resolver, a client that never sends `topikLevel`
 * still grades EXACTLY the paper it was served — and F-007 resume, which
 * replays `POST /topik/mock {sourceTest, section}`, re-fetches the identical
 * paper. Returns null when nothing matches (empty corpus / unknown test).
 */
async function resolveMockTest(
  section: SectionEnum,
  requestedTest: number | undefined,
  requestedLevel: TopikLevel | undefined,
): Promise<ResolvedMockTest | null> {
  const params: unknown[] = [section];
  const filters = [`i.section = $1::topik_section`, ANSWERABLE_ITEM_SQL];
  if (requestedTest !== undefined) {
    params.push(requestedTest);
    filters.push(`t.test_number = $${params.length}`);
  }
  if (requestedLevel !== undefined) {
    params.push(requestedLevel);
    filters.push(`t.topik_level = $${params.length}`);
  }
  const { rows } = await query<{ test_number: number; topik_level: TopikLevel }>(
    `SELECT t.test_number, t.topik_level
       FROM topik_tests t
       JOIN topik_items i ON i.topik_test_id = t.id
      WHERE ${filters.join(' AND ')}
      ORDER BY t.test_number DESC, t.topik_level DESC
      LIMIT 1`,
    params,
  );
  const row = rows[0];
  return row ? { sourceTest: row.test_number, topikLevel: row.topik_level } : null;
}

/**
 * POST /topik/mock — a single exam paper's section items for `sourceTest`
 * (server-picked when omitted) in original `item_number` order, ANSWER-STRIPPED
 * for a timed mock.
 *
 * Body: `{ section: 'reading'|'listening' (or 읽기/듣기), sourceTest?: number,
 * topikLevel?: 'TOPIK I'|'TOPIK II' }`. Returns `{ sourceTest, topikLevel,
 * section, items: TopikMockItemDTO[] }` — `sourceTest` + `topikLevel` name the
 * ONE resolved exam paper (D-1: both levels share every test_number) and are
 * echoed so `/topik/mock/submit` grades the same paper; `section` is the
 * normalized enum. Items are stripped via `toMockItemDTO` (no `correct`, no
 * `explanation` — type-level, see above + SECURITY.md §14.1).
 *
 * Writing section → 400 (MockSectionSchema; FU-NF-47). An empty result (unknown
 * or empty test/section/level) is a valid 200 with `items: []` — same posture as
 * the other read routes; the client surfaces "no items".
 */
router.post('/mock', cheapLimiter(), validateBody(MockBodySchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof MockBodySchema>;

    const resolved = await resolveMockTest(body.section, body.sourceTest, body.topikLevel);
    if (resolved === null) {
      // No paper has a gradeable item matching the request — no mock to assemble.
      res.status(200).json({
        sourceTest: body.sourceTest ?? null,
        topikLevel: body.topikLevel ?? null,
        section: body.section,
        items: [],
      });
      return;
    }

    const { rows } = await query<TopikItemRow>(
      `SELECT ${ITEM_COLUMNS}
         FROM topik_items i
         JOIN topik_tests t ON t.id = i.topik_test_id
        WHERE t.test_number = $1
          AND t.topik_level = $2
          AND i.section = $3::topik_section
          AND ${ANSWERABLE_ITEM_SQL}
        ORDER BY i.item_number
        LIMIT ${OFFICIAL_MOCK_SECTION_SIZE}`,
      [resolved.sourceTest, resolved.topikLevel, body.section],
    );

    res.status(200).json({
      sourceTest: resolved.sourceTest,
      topikLevel: resolved.topikLevel,
      section: body.section,
      items: mapRows(rows).map(toMockItemDTO),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /topik/mock/submit — bulk, server-graded mock scoring (FU-NF-39).
// ---------------------------------------------------------------------------

/** Cap on answers per submit — a real TOPIK section is ≤50 items; 200 is a safe
 *  DoS bound that still tolerates a longer assembled mock. */
const MAX_MOCK_ANSWERS = 200;

const MockSubmitAnswerSchema = z
  .object({
    // topik_items.id is BIGINT — capped at MAX_SAFE_INTEGER (the gradeWriting
    // pattern): above 2^53 a JS number can't hold the id exactly anyway, and the
    // cap keeps any future SQL bind of this value from overflowing int8.
    itemId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    picked: z.enum(['a', 'b', 'c', 'd']),
    timeMs: z.number().int().nonnegative().max(60 * 60 * 1000).optional(),
  })
  .strict();

const MockSubmitBodySchema = z
  .object({
    // .max(INT4_MAX): binds to the INTEGER test_number column (see MockBodySchema).
    sourceTest: z.number().int().positive().max(INT4_MAX),
    // Optional exam-paper discriminator — see MockBodySchema / resolveMockTest.
    topikLevel: TopikLevelSchema.optional(),
    section: MockSectionSchema,
    // min 0: a timed-out exam with nothing answered still submits — every item
    // is then graded as skipped/incorrect and the result reveals the full answer
    // key + explanations so the learner sees what they missed (the exam was
    // already consumed by fetching it). The .max bounds abuse.
    answers: z.array(MockSubmitAnswerSchema).max(MAX_MOCK_ANSWERS),
    durationMs: z.number().int().nonnegative().optional(),
  })
  .strict();

/** A per-item reveal in the submit result — the answer is revealed NOW. */
interface MockRevealDTO {
  readonly itemId: string;
  readonly picked: ChoiceId | null;
  readonly correctChoiceId: ChoiceId;
  readonly isCorrect: boolean;
  readonly explanation: string;
}

/**
 * POST /topik/mock/submit — grade a whole mock section server-side and score it.
 *
 * Body (`.strict()`): `{ sourceTest, topikLevel?, section,
 * answers:[{itemId,picked,timeMs?}], durationMs? }`. Resolves the ONE exam paper
 * (test_number + topik_level — D-1) with the same resolver `/topik/mock` used,
 * loads its gradeable section items (the same assembly `/topik/mock` served)
 * and grades each item against the DB answer —
 * the client never had the answer (A1), so grading is purely server-side. Items
 * the user did not answer (in the served set but absent from `answers`) count as
 * incorrect/unanswered (`picked: null`).
 *
 * Persistence: in ONE transaction, INSERT a `topik_responses` row per graded
 * answer (mode='mock', `user_id` from the SESSION — never client-supplied,
 * `is_correct` server-computed). Append-only, mirroring the per-item route.
 *
 * Returns `200 { sourceTest, topikLevel, section, totalItems, answered, correct,
 * percentage, band, items: MockRevealDTO[] }`. `percentage` = correct/totalItems*100 (1-dp);
 * `band` from `bandForPercentage`. The reveal array carries the correct choice +
 * explanation for EVERY served item (post-exam reveal), in item_number order.
 *
 * Threat model (SECURITY.md §14.1): answers graded from the DB, never a client
 * `correct`; writes user-scoped (no IDOR / mass-assignment — body is `.strict()`
 * and carries no user id); the mock DTO carries no answer (A1). 400 on the
 * writing section (MockSectionSchema). An empty `answers` array is accepted (a
 * timed-out blank exam): every item grades as skipped and the result reveals
 * the answer key the learner missed; no topik_responses rows are written.
 */
router.post('/mock/submit', cheapLimiter(), validateBody(MockSubmitBodySchema), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const body = req.body as z.infer<typeof MockSubmitBodySchema>;

    // Resolve the ONE exam paper to grade — the SAME resolver /topik/mock used
    // to assemble it (D-1), so a client that never sends `topikLevel` still
    // grades exactly the paper it was served, never a merged/other-level set.
    const resolved = await resolveMockTest(body.section, body.sourceTest, body.topikLevel);
    if (resolved === null) {
      throw new NotFoundError('no gradeable mock items for this test and section');
    }

    // Load the paper's gradeable items — the authoritative set of items the
    // mock comprised. mapRowToDTO drops ungradeable rows, so the grading
    // universe is exactly the items `/topik/mock` would have served.
    const { rows } = await query<TopikItemRow>(
      `SELECT ${ITEM_COLUMNS}
         FROM topik_items i
         JOIN topik_tests t ON t.id = i.topik_test_id
        WHERE t.test_number = $1
          AND t.topik_level = $2
          AND i.section = $3::topik_section
          AND ${ANSWERABLE_ITEM_SQL}
        ORDER BY i.item_number
        LIMIT ${OFFICIAL_MOCK_SECTION_SIZE}`,
      [resolved.sourceTest, resolved.topikLevel, body.section],
    );
    const items = mapRows(rows);
    if (items.length === 0) {
      throw new NotFoundError('no gradeable mock items for this test and section');
    }

    // Index the client's picks by itemId (last write wins on a dup id — the
    // schema permits dups but grading is deterministic on the final pick).
    const pickByItemId = new Map<string, z.infer<typeof MockSubmitAnswerSchema>>();
    for (const a of body.answers) pickByItemId.set(String(a.itemId), a);

    // Grade every served item server-side. A skipped item (no pick) is incorrect
    // with picked=null; a pick for an item NOT in the served set is ignored (it
    // is not part of this mock's grading universe).
    const reveals: MockRevealDTO[] = [];
    const toInsert: { itemId: string; picked: ChoiceId; isCorrect: boolean; timeMs: number | null }[] = [];
    let correct = 0;
    for (const item of items) {
      const correctChoice = item.options.find((o) => o.correct);
      // mapRowToDTO guarantees exactly one correct option; guard keeps the type
      // a definite ChoiceId (mirrors the per-item /answer route).
      if (correctChoice === undefined) continue;
      const submitted = pickByItemId.get(item.id);
      const picked = submitted?.picked ?? null;
      const isCorrect = picked !== null && picked === correctChoice.id;
      if (isCorrect) correct += 1;
      reveals.push({
        itemId: item.id,
        picked,
        correctChoiceId: correctChoice.id,
        isCorrect,
        explanation: item.explanation,
      });
      // Only ANSWERED items are logged (a skip is not an attempt). Append-only,
      // mode='mock', stamped with the session user in the transaction below.
      if (picked !== null) {
        toInsert.push({ itemId: item.id, picked, isCorrect, timeMs: submitted?.timeMs ?? null });
      }
    }

    // Persist every graded answer in ONE transaction (all-or-nothing): a mock is
    // scored atomically, so a mid-write failure never logs a partial section.
    await withTransaction(async (client) => {
      // Serialize against PUT /topik/attempt for this user (ATTEMPT_LOCK_SQL,
      // xact-scoped — released automatically at commit/rollback). Without it a
      // racing save processed while THIS transaction is open slips past the
      // F-UP-014 fresh-completed guard under READ COMMITTED and resurrects an
      // active row for the paper being graded here.
      await client.query(ATTEMPT_LOCK_SQL, [userId]);
      // The section is now submitted — close the attempt FIRST so its id can
      // stamp the response rows below (A1: responses group into the attempt
      // that produced them — F-078/F-082). Marking it 'completed' both retains
      // it as history AND arms the F-UP-014 guard: PUT /topik/attempt refuses
      // a delayed racing save for this same paper while the completed row is
      // fresh, and GET only ever reports status='active', so the resume banner
      // never re-offers a finished test (F-007). Same tx as the score write: a
      // graded section and a closed attempt commit together.
      //
      // Only the SAME paper's active attempt is closed — if the user somehow
      // has an active attempt for a different paper, it stays resumable. When
      // no active attempt exists (e.g. a submit before the first progress
      // save ever landed), a completed row is created directly so the sitting
      // still enters history and the responses still have an attempt to group
      // under. The saved picks/current_idx of a closed attempt are left as the
      // last persisted progress; the authoritative graded answers live in the
      // topik_responses rows stamped below.
      // F-122: `resolved.topikLevel` is the AUTHORITATIVE level — the exact
      // paper /mock/submit just graded against (resolveMockTest already ran
      // above) — so it is stamped here unconditionally, overwriting whatever
      // (if anything) the in-progress row's own topik_level said. A
      // completed attempt's level can therefore never be stale, missing, or
      // guessed, regardless of what PUT /topik/attempt last saved.
      const closed = await client.query<{ id: string }>(
        `UPDATE topik_attempts
            SET status = 'completed', topik_level = $4, version = version + 1
          WHERE user_id = $1
            AND status = 'active'
            AND source_test = $2
            AND section = $3::topik_section
          RETURNING id`,
        [userId, resolved.sourceTest, body.section, resolved.topikLevel],
      );
      let attemptId = closed.rows[0]?.id;
      if (attemptId === undefined) {
        const created = await client.query<{ id: string }>(
          `INSERT INTO topik_attempts
             (user_id, section, source_test, current_idx, picks, remaining_ms, status, topik_level)
           VALUES ($1, $2::topik_section, $3, 0, '{}'::jsonb, 0, 'completed', $4)
           RETURNING id`,
          [userId, body.section, resolved.sourceTest, resolved.topikLevel],
        );
        attemptId = created.rows[0]!.id;
      }
      for (const row of toInsert) {
        await client.query(
          `INSERT INTO topik_responses (user_id, topik_item_id, picked, is_correct, mode, time_ms, attempt_id)
           VALUES ($1, $2, $3, $4, 'mock', $5, $6)`,
          [userId, row.itemId, row.picked, row.isCorrect, row.timeMs, attemptId],
        );
      }
    });

    const totalItems = reveals.length;
    const answered = toInsert.length;
    // 1-dp percentage; totalItems > 0 here (the empty case 404'd above).
    const percentage = Math.round((correct / totalItems) * 1000) / 10;

    res.status(200).json({
      sourceTest: resolved.sourceTest,
      topikLevel: resolved.topikLevel,
      section: body.section,
      totalItems,
      answered,
      correct,
      percentage,
      band: bandForPercentage(percentage),
      items: reveals,
    });
  } catch (err) {
    next(err);
  }
});

const StudyBodySchema = z
  .object({
    section: SectionSchema.optional(),
    level: LevelSchema.optional(),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();

/**
 * POST /topik/study — a shuffled cross-test draw matching the filter. Empty
 * filter = the whole pool. `ORDER BY random() LIMIT n` (n bounded ≤50 by the
 * schema). Returns `{ items }`.
 */
router.post('/study', cheapLimiter(), validateBody(StudyBodySchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof StudyBodySchema>;

    const params: unknown[] = [];
    const filters: string[] = [ANSWERABLE_ITEM_SQL];
    if (body.section !== undefined) {
      params.push(body.section);
      filters.push(`i.section = $${params.length}::topik_section`);
    }
    if (body.level !== undefined) {
      params.push(body.level);
      filters.push(`i.proficiency = $${params.length}::proficiency_level`);
    }
    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    params.push(body.limit);
    // JOIN topik_tests to carry t.passages (ITEM_COLUMNS) — B-008.
    const { rows } = await query<TopikItemRow>(
      `SELECT ${ITEM_COLUMNS}
         FROM topik_items i
         JOIN topik_tests t ON t.id = i.topik_test_id
        ${whereClause}
        ORDER BY random()
        LIMIT $${params.length}`,
      params,
    );

    res.status(200).json({ items: mapRows(rows) });
  } catch (err) {
    next(err);
  }
});

const AnswerParamsSchema = z.object({
  // topik_items.id is BIGINT — .max(MAX_SAFE_INTEGER) rejects a garbage id like
  // 1e20 at the boundary (400) instead of overflowing int8 in pg (22003 → 500).
  // No real id is affected: ids beyond 2^53 can't round-trip a JS number anyway.
  itemId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

const AnswerBodySchema = z
  .object({
    picked: z.enum(['a', 'b', 'c', 'd']),
    timeMs: z.number().int().nonnegative().max(60 * 60 * 1000).optional(),
    mode: z.enum(['study', 'mock']).default('study'),
  })
  .strict();

/**
 * POST /topik/:itemId/answer — grade a pick, log the attempt, reveal the answer.
 *
 * Looks up the item (404 if missing), grades `picked` against the item's
 * answer server-side, INSERTs a `topik_responses` row stamped with the SESSION
 * user (append-only — a re-answer is a new row), and returns
 * `{ correct, correctChoiceId, explanation }`.
 *
 * Idempotency: append-only by design — re-answering is a fresh attempt row, so
 * no version gate is needed (contract §B).
 */
router.post(
  '/:itemId/answer',
  cheapLimiter(),
  validateParams(AnswerParamsSchema),
  validateBody(AnswerBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const params = (req as typeof req & {
        validatedParams: z.infer<typeof AnswerParamsSchema>;
      }).validatedParams;
      const body = req.body as z.infer<typeof AnswerBodySchema>;

      // Reference-data lookup — no user scoping (the item is public), but a
      // missing id is a clean 404 rather than a silent insert against nothing.
      const { rows } = await query<TopikItemRow>(
        `SELECT ${ITEM_COLUMNS}
           FROM topik_items i
           JOIN topik_tests t ON t.id = i.topik_test_id
          WHERE i.id = $1`,
        [params.itemId],
      );
      const row = rows[0];
      if (!row) throw new NotFoundError('topik item not found');

      const dto = mapRowToDTO(row);
      if (dto === null) {
        // The item exists but is not a usable multiple-choice study item (e.g. a
        // writing item, or a malformed row). Treat as not-found for the answer
        // surface rather than logging an ungradeable attempt.
        throw new NotFoundError('topik item is not an answerable multiple-choice item');
      }

      const correctChoice = dto.options.find((o) => o.correct);
      // mapRowToDTO guarantees exactly one `correct` option; this is a
      // belt-and-suspenders guard so the type stays a definite ChoiceId.
      if (correctChoice === undefined) {
        throw new NotFoundError('topik item has no gradeable answer');
      }
      const correctChoiceId = correctChoice.id;
      const isCorrect = body.picked === correctChoiceId;

      // Append-only log, stamped with the SESSION user (never client-supplied).
      await query(
        `INSERT INTO topik_responses (user_id, topik_item_id, picked, is_correct, mode, time_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, params.itemId, body.picked, isCorrect, body.mode, body.timeMs ?? null],
      );

      res.status(200).json({
        correct: isCorrect,
        correctChoiceId,
        explanation: dto.explanation,
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
