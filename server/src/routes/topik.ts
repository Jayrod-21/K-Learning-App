/**
 * /topik routes — TOPIK Prep (Study mode live + Mock-Test server route, Pass 6).
 *
 * Flow:
 *   GET  /topik/items          → paginated browse of the item pool (filters)
 *   POST /topik/mock           → a section's items, ANSWER-STRIPPED, for a timed mock
 *   POST /topik/mock/submit    → bulk server-graded mock scoring (one tx, append log)
 *   POST /topik/study          → a shuffled cross-test draw matching a filter
 *   POST /topik/:itemId/answer → grade a pick, log the attempt, reveal the answer
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
import { cheapLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { query, withTransaction } from '../db/pool.js';
import { NotFoundError } from '../middleware/errors.js';
import { sharedPassageFor } from '../services/topik/passages.js';

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
 */
const ANSWERABLE_ITEM_SQL =
  "jsonb_array_length(i.options) >= 2 AND i.answer IS NOT NULL " +
  "AND i.options->>0 NOT IN ('①','②','③','④')";

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
  source_test: z.coerce.number().int().positive().optional(),
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
        ORDER BY t.test_number, i.item_number
        LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      pageParams,
    );

    res.status(200).json({ items: mapRows(rows), total });
  } catch (err) {
    next(err);
  }
});

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
    sourceTest: z.number().int().positive().optional(),
    section: MockSectionSchema,
  })
  .strict();

/**
 * Resolve the `sourceTest` for a mock: if the client supplied one, use it;
 * otherwise the server PICKS deterministically — the HIGHEST `topik_tests`
 * `test_number` that has at least one gradeable item in the section. "Highest"
 * makes the pick stable and intuitively "the newest test" without the client
 * needing to know test numbers. The same survivor guard the rest of the file
 * uses (`>=2 options AND answer NOT NULL`) restricts the candidates to gradeable
 * items, so the picked test always yields a usable mock. Returns null when no
 * test has a gradeable item in the section (empty corpus for that section).
 */
async function resolveMockSourceTest(
  section: SectionEnum,
  requested: number | undefined,
): Promise<number | null> {
  if (requested !== undefined) return requested;
  const { rows } = await query<{ test_number: number }>(
    `SELECT t.test_number
       FROM topik_tests t
       JOIN topik_items i ON i.topik_test_id = t.id
      WHERE i.section = $1::topik_section
        AND ${ANSWERABLE_ITEM_SQL}
      ORDER BY t.test_number DESC
      LIMIT 1`,
    [section],
  );
  return rows[0]?.test_number ?? null;
}

/**
 * POST /topik/mock — a section's items for `sourceTest` (server-picked when
 * omitted) in original `item_number` order, ANSWER-STRIPPED for a timed mock.
 *
 * Body: `{ section: 'reading'|'listening' (or 읽기/듣기), sourceTest?: number }`.
 * Returns `{ sourceTest, section, items: TopikMockItemDTO[] }` — `sourceTest` is
 * echoed so `/topik/mock/submit` can reference the same test; `section` is the
 * normalized enum. Items are stripped via `toMockItemDTO` (no `correct`, no
 * `explanation` — type-level, see above + SECURITY.md §14.1).
 *
 * Writing section → 400 (MockSectionSchema; FU-NF-47). An empty result (unknown
 * or empty test/section) is a valid 200 with `items: []` — same posture as the
 * other read routes; the client surfaces "no items".
 */
router.post('/mock', cheapLimiter(), validateBody(MockBodySchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof MockBodySchema>;

    const sourceTest = await resolveMockSourceTest(body.section, body.sourceTest);
    if (sourceTest === null) {
      // No test has a gradeable item in this section — no mock to assemble.
      res.status(200).json({ sourceTest: null, section: body.section, items: [] });
      return;
    }

    const { rows } = await query<TopikItemRow>(
      `SELECT ${ITEM_COLUMNS}
         FROM topik_items i
         JOIN topik_tests t ON t.id = i.topik_test_id
        WHERE t.test_number = $1
          AND i.section = $2::topik_section
          AND ${ANSWERABLE_ITEM_SQL}
        ORDER BY i.item_number
        LIMIT ${OFFICIAL_MOCK_SECTION_SIZE}`,
      [sourceTest, body.section],
    );

    res.status(200).json({
      sourceTest,
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
    itemId: z.number().int().positive(),
    picked: z.enum(['a', 'b', 'c', 'd']),
    timeMs: z.number().int().nonnegative().max(60 * 60 * 1000).optional(),
  })
  .strict();

const MockSubmitBodySchema = z
  .object({
    sourceTest: z.number().int().positive(),
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
 * Body (`.strict()`): `{ sourceTest, section, answers:[{itemId,picked,timeMs?}],
 * durationMs? }`. Loads the section's gradeable items for `sourceTest` (the same
 * assembly `/topik/mock` served) and grades each item against the DB answer —
 * the client never had the answer (A1), so grading is purely server-side. Items
 * the user did not answer (in the served set but absent from `answers`) count as
 * incorrect/unanswered (`picked: null`).
 *
 * Persistence: in ONE transaction, INSERT a `topik_responses` row per graded
 * answer (mode='mock', `user_id` from the SESSION — never client-supplied,
 * `is_correct` server-computed). Append-only, mirroring the per-item route.
 *
 * Returns `200 { sourceTest, section, totalItems, answered, correct, percentage,
 * band, items: MockRevealDTO[] }`. `percentage` = correct/totalItems*100 (1-dp);
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

    // Load the section's gradeable items for this test — the authoritative set
    // of items the mock comprised. mapRowToDTO drops ungradeable rows, so the
    // grading universe is exactly the items `/topik/mock` would have served.
    const { rows } = await query<TopikItemRow>(
      `SELECT ${ITEM_COLUMNS}
         FROM topik_items i
         JOIN topik_tests t ON t.id = i.topik_test_id
        WHERE t.test_number = $1
          AND i.section = $2::topik_section
          AND ${ANSWERABLE_ITEM_SQL}
        ORDER BY i.item_number
        LIMIT ${OFFICIAL_MOCK_SECTION_SIZE}`,
      [body.sourceTest, body.section],
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
      for (const row of toInsert) {
        await client.query(
          `INSERT INTO topik_responses (user_id, topik_item_id, picked, is_correct, mode, time_ms)
           VALUES ($1, $2, $3, $4, 'mock', $5)`,
          [userId, row.itemId, row.picked, row.isCorrect, row.timeMs],
        );
      }
    });

    const totalItems = reveals.length;
    const answered = toInsert.length;
    // 1-dp percentage; totalItems > 0 here (the empty case 404'd above).
    const percentage = Math.round((correct / totalItems) * 1000) / 10;

    res.status(200).json({
      sourceTest: body.sourceTest,
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
  itemId: z.coerce.number().int().positive(),
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
