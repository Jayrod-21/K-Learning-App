/**
 * /topik routes — TOPIK Prep (Study mode live + Mock-Test server route, Pass 6).
 *
 * Flow:
 *   GET  /topik/items          → paginated browse of the item pool (filters)
 *   POST /topik/mock           → ALL items of a test (+section) in original order
 *   POST /topik/study          → a shuffled cross-test draw matching a filter
 *   POST /topik/:itemId/answer → grade a pick, log the attempt, reveal the answer
 *
 * SECURITY (see SECURITY.md §14):
 *   - TOPIK items are PUBLIC reference data. This is a study tool, not a secured
 *     exam, so STUDY mode serves the `correct` flag + explanation INLINE in every
 *     TopikItemDTO — by design (contract §B / locked decisions). The Mock-mode
 *     answer-strip is deferred to FU-NF-39; this pass does NOT strip mock answers.
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
import { query } from '../db/pool.js';
import { NotFoundError } from '../middleware/errors.js';

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
  readonly options: readonly TopikChoiceDTO[];
  readonly explanation: string;
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
  extra: Record<string, unknown> | null;
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
 *   - prompt    = prompt ?? stem ?? ''
 *   - options   = options JSONB array → a..d choices (en:''), `correct` flag set
 *                 on the (answer − 1) index
 *   - explanation = extra->>'explanation' ?? ''   (no `explanation` column exists)
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

  return {
    id: row.id,
    section: SECTION_ENUM_TO_KR[row.section],
    number: row.item_number,
    level: proficiencyToLevel(row.proficiency),
    prompt: (row.prompt ?? row.stem ?? '').trim(),
    options,
    explanation,
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

/** The SELECT column list shared by every item-fetching query. */
const ITEM_COLUMNS = `id::text AS id,
                      section::text AS section,
                      item_number,
                      proficiency::text AS proficiency,
                      stem, prompt, options, answer, extra`;

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
    const filters: string[] = ['jsonb_array_length(i.options) >= 2', 'i.answer IS NOT NULL'];
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

const MockBodySchema = z
  .object({
    sourceTest: z.number().int().positive(),
    section: SectionSchema.optional(),
  })
  .strict();

/**
 * POST /topik/mock — the full test for `sourceTest` (+optional section) in
 * original `item_number` order (the original assembly). Returns `{ items }`.
 *
 * Server route only — the Mock-Test taking UI is deferred to FU-NF-39. Answers
 * are NOT stripped here (FU-NF-39 owns the answer-strip); the DTOs carry the
 * same inline `correct`/`explanation` as study (see SECURITY.md §14.1).
 */
router.post('/mock', cheapLimiter(), validateBody(MockBodySchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof MockBodySchema>;

    const params: unknown[] = [body.sourceTest];
    let sectionClause = '';
    if (body.section !== undefined) {
      params.push(body.section);
      sectionClause = ` AND i.section = $${params.length}::topik_section`;
    }
    const { rows } = await query<TopikItemRow>(
      `SELECT ${ITEM_COLUMNS}
         FROM topik_items i
         JOIN topik_tests t ON t.id = i.topik_test_id
        WHERE t.test_number = $1${sectionClause}
        ORDER BY i.item_number`,
      params,
    );

    res.status(200).json({ items: mapRows(rows) });
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
    const filters: string[] = [];
    if (body.section !== undefined) {
      params.push(body.section);
      filters.push(`section = $${params.length}::topik_section`);
    }
    if (body.level !== undefined) {
      params.push(body.level);
      filters.push(`proficiency = $${params.length}::proficiency_level`);
    }
    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    params.push(body.limit);
    const { rows } = await query<TopikItemRow>(
      `SELECT ${ITEM_COLUMNS}
         FROM topik_items
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
           FROM topik_items
          WHERE id = $1`,
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
