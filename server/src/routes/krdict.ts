/**
 * GET /krdict/search?q=&limit=&offset= — paginated KRDICT dictionary search,
 * OR (when `q` is absent/empty) a browse-all listing of the full 53,978-row
 * KRDICT corpus (migration 003).
 *
 * The Resources "Dictionary" tab opens on the browse-all list (page 1, no query
 * needed) so the user can scroll the dictionary immediately; typing a query
 * switches to search results, and clearing it returns to browse. Both modes
 * page with `offset` + the `total` count.
 *
 * Search match model — "headword first, definitions as fallback":
 *   - A row matches when its `headword` starts with the term (prefix), OR the
 *     term appears as a substring of the Korean or English definition. Prefix
 *     on headword is the primary intent ("type 먹 → 먹다, 먹이, …"); the
 *     definition fallback lets an English-only searcher find a word by gloss
 *     ("type eat → 먹다"). Ranking puts headword-prefix matches first.
 *   - Metacharacters in the term are escaped (escapeLikePattern) so `%`/`_`
 *     match literally and an all-wildcard term can't scan the whole table.
 *
 * F-175: both branches unconditionally exclude grammar-morpheme rows
 * (`part_of_speech IN ('어미', '조사')` — verb/adjective endings and
 * particles) — this is a VOCABULARY dictionary lookup, and those rows belong
 * to the Grammar library's own corpus. The exclusion is NULL-safe (an
 * untagged `part_of_speech` still matches) and folded into the WHERE clause
 * both branches already build their `total` window count from, so the pager
 * total is exact — no separate count query, no client-side adjustment.
 *
 * Sits alongside GET /define (exact-headword tap lookup). Both share the SAME
 * availability cache (krdictAvailable) so there is one information_schema probe
 * budget and one migration-003-rollback degradation path — if the tables aren't
 * present we return an honest 503, not a 500. Read-only, auth-required, cheap
 * limiter; the only SQL inputs are bound parameters.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter } from '../middleware/rateLimits.js';
import { validateQuery } from '../middleware/validate.js';
import { query } from '../db/pool.js';
import { escapeLikePattern } from '../db/like.js';
import {
  krdictAvailable,
  markKrdictUnavailable,
  isUndefinedTableError,
} from './define.js';

const router = Router();
router.use(requireAuth);

// Browse-by-initial-consonant (초성) index. Each base consonant maps to the
// Unicode Hangul-syllable range that begins with it, folding its tense pair in
// (ㄱ covers ㄱ+ㄲ, ㄷ covers ㄷ+ㄸ, ㅂ covers ㅂ+ㅃ, ㅅ covers ㅅ+ㅆ, ㅈ covers ㅈ+ㅉ).
// Ranges are [start, end) under COLLATE "C" (codepoint order == initial-consonant
// order for Hangul syllables), matching the browse ORDER BY. '힤' is one past
// 힣, the last Hangul syllable.
const INITIAL_RANGES: Record<string, { start: string; end: string }> = {
  ㄱ: { start: '가', end: '나' },
  ㄴ: { start: '나', end: '다' },
  ㄷ: { start: '다', end: '라' },
  ㄹ: { start: '라', end: '마' },
  ㅁ: { start: '마', end: '바' },
  ㅂ: { start: '바', end: '사' },
  ㅅ: { start: '사', end: '아' },
  ㅇ: { start: '아', end: '자' },
  ㅈ: { start: '자', end: '차' },
  ㅊ: { start: '차', end: '카' },
  ㅋ: { start: '카', end: '타' },
  ㅌ: { start: '타', end: '파' },
  ㅍ: { start: '파', end: '하' },
  ㅎ: { start: '하', end: '힤' },
};
const INITIALS = Object.keys(INITIAL_RANGES) as [string, ...string[]];

const SearchQuerySchema = z.object({
  // OPTIONAL — absent or empty `q` means "browse the whole dictionary" (see the
  // route doc). When present it's a 1..64 char term; the leading/trailing trim
  // means an all-whitespace query collapses to the browse path, not a search
  // for spaces.
  q: z.string().trim().max(64).optional(),
  // Browse-only 초성 section filter (one of the 14 base consonants). Ignored when
  // `q` is present (search spans the whole dictionary).
  initial: z.enum(INITIALS).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  // OFFSET binds to int8 in pg — unbounded, a 20-digit offset overflows
  // (22003 → 500) instead of 400ing at the boundary (routes sweep #3).
  offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
});

interface KrdictSearchRow {
  id: number;
  headword: string;
  part_of_speech: string | null;
  definition_korean: string | null;
  definition_english: string | null;
  total: string;
}

router.get(
  '/search',
  cheapLimiter(),
  validateQuery(SearchQuerySchema),
  async (req, res, next) => {
    try {
      const q = (
        req as typeof req & { validatedQuery: z.infer<typeof SearchQuerySchema> }
      ).validatedQuery;
      // Phase 2.8 gloss overlay: the router-level requireAuth (top of file)
      // guarantees req.user is populated on every route in this file, so
      // getUserId(req) is safe here without a re-check.
      const userId = getUserId(req);

      if (!(await krdictAvailable())) {
        // Migration 003 not applied — honest 503 rather than a 500 (mirrors
        // GET /define exactly).
        res.status(503).json({
          error: {
            code: 'krdict_unavailable',
            message: 'KRDICT tables are not present. Run migration 003 (B2).',
          },
          correlationId: req.correlationId,
        });
        return;
      }

      // `q` is optional. A non-empty term runs the headword/definition search;
      // an absent/empty term browses the whole dictionary (headword order).
      const term = q.q ?? '';
      const browse = term.length === 0;

      let rows: KrdictSearchRow[];
      try {
        if (browse) {
          // Browse-all: the same projection as search, ordered by headword so
          // the page is deterministic and alphabetical. The corpus is ~53,978
          // rows; COUNT(*) OVER () over the unfiltered scan returns the exact
          // total (no estimated-count idiom exists in this codebase, and an
          // exact count of a single mid-size table is well within budget). The
          // `"C"` collation gives a stable byte-order sort that matches the
          // pager's "N of M" without locale-dependent reordering.
          // An optional 초성 filter narrows the browse to one consonant's
          // Unicode syllable range; without it, browse the whole dictionary.
          // F-175: grammar-morpheme rows (어미 = ending, 조사 = particle) are
          // excluded from this VOCABULARY dictionary browse/search — they
          // belong to the Grammar library tab's corpus, not a word lookup
          // (mirrors ReviewDictionary.tsx's client-side `isGrammarPos`, now
          // made exact server-side so `total`/pager counts stop over-
          // counting the ~1.2% of rows the client was hiding anyway). The
          // NULL-safe form matters: `part_of_speech NOT IN (...)` alone would
          // silently exclude every row with a NULL part_of_speech too (SQL's
          // three-valued logic — `NULL NOT IN (...)` is UNKNOWN, not TRUE),
          // which would wrongly drop untagged vocabulary, not just grammar
          // morphemes. This exclusion is now the leading, UNCONDITIONAL
          // WHERE clause; the optional 초성 range narrows further with AND.
          const range = q.initial ? INITIAL_RANGES[q.initial] : null;
          // Phase 2.8 gloss overlay: the override param slides to $5 when the
          // range's two bounds occupy $3/$4, else $3 — mirrors the existing
          // conditional-arity pattern this query already uses for `range`.
          const userIdParam = range ? 5 : 3;
          const result = await query<KrdictSearchRow>(
            // Aliased (`ke`) so every column is qualified — krdict_entries.id
            // and user_gloss_overrides.id would otherwise be an ambiguous
            // reference the moment the JOIN is added (42702).
            `SELECT ke.id, ke.headword, ke.part_of_speech,
                    ke.definition_korean,
                    COALESCE(ugo.gloss, ke.definition_english) AS definition_english,
                    COUNT(*) OVER ()::text AS total
               FROM krdict_entries ke
               LEFT JOIN user_gloss_overrides ugo
                      ON ugo.user_id = $${userIdParam} AND ugo.lemma = ke.headword
              WHERE (ke.part_of_speech IS NULL OR ke.part_of_speech NOT IN ('어미', '조사'))
              ${range ? 'AND ke.headword COLLATE "C" >= $3 AND ke.headword COLLATE "C" < $4' : ''}
              ORDER BY ke.headword COLLATE "C", ke.id ASC
              LIMIT $1 OFFSET $2`,
            range
              ? [q.limit, q.offset, range.start, range.end, userId]
              : [q.limit, q.offset, userId],
          );
          rows = result.rows;
        } else {
          // Two operands from one term: a prefix pattern (`term%`) for the
          // headword and a substring pattern (`%term%`) for the definition
          // fallback. Both are escaped then bound as parameters — no
          // interpolation of user input.
          const escaped = escapeLikePattern(term);
          const prefixPattern = `${escaped}%`;
          const substringPattern = `%${escaped}%`;
          // ORDER BY puts headword-prefix matches ahead of definition-only
          // matches, then by id for a stable page. COUNT(*) OVER () carries the
          // total matching count so the client paginates in one round-trip.
          //
          // F-175: the grammar-morpheme exclusion (see the browse branch's
          // comment above) is ANDed onto the OUTSIDE of the parenthesized
          // 3-way OR match group. Parenthesization is load-bearing here — a
          // bare `... OR ... OR ... AND part_of_speech NOT IN (...)` would
          // let SQL's AND-binds-tighter-than-OR precedence apply the
          // exclusion to ONLY the last OR arm (definition_english), leaving
          // 어미/조사 rows that match on headword or definition_korean
          // unfiltered — a correctness bug, not a style nit.
          // Phase 2.8 gloss overlay: the search predicate below still
          // matches against the SHARED definition_english (an override is a
          // personal correction, not something that should change what a
          // gloss-text search matches for the searching user); only the
          // SELECTed definition_english value is overlaid.
          const result = await query<KrdictSearchRow>(
            // Aliased (`ke`) — same ambiguous-`id` reasoning as the browse
            // branch above.
            `SELECT ke.id, ke.headword, ke.part_of_speech,
                    ke.definition_korean,
                    COALESCE(ugo.gloss, ke.definition_english) AS definition_english,
                    COUNT(*) OVER ()::text AS total
               FROM krdict_entries ke
               LEFT JOIN user_gloss_overrides ugo
                      ON ugo.user_id = $5 AND ugo.lemma = ke.headword
              WHERE (ke.headword           ILIKE $1 ESCAPE '\\'
                  OR ke.definition_korean  ILIKE $2 ESCAPE '\\'
                  OR ke.definition_english ILIKE $2 ESCAPE '\\')
                AND (ke.part_of_speech IS NULL OR ke.part_of_speech NOT IN ('어미', '조사'))
              ORDER BY (ke.headword ILIKE $1 ESCAPE '\\') DESC, ke.id ASC
              LIMIT $3 OFFSET $4`,
            [prefixPattern, substringPattern, q.limit, q.offset, userId],
          );
          rows = result.rows;
        }
      } catch (err) {
        // Cache symmetry on rollback (FU-NF-5): if the krdict tables were
        // dropped underneath the availability cache, mark it not-ready so the
        // NEXT request degrades cleanly to 503. This first request still
        // surfaces as 500 (we rethrow).
        if (isUndefinedTableError(err)) {
          markKrdictUnavailable();
        }
        throw err;
      }

      // COUNT(*) OVER () is identical on every row; an empty page (no matches,
      // or offset past the end) yields no rows → total 0.
      const total = rows.length > 0 ? Number(rows[0]!.total) : 0;
      // id arrives as a safe-integer number via the int8 parser (db/pool.ts);
      // Number() is an identity op kept as the DTO-boundary normalization. The
      // per-row window `total` is surfaced once at the top level, not on each
      // entry.
      const entries = rows.map(({ total: _total, ...rest }) => ({
        ...rest,
        id: Number(rest.id),
      }));

      // Echo the normalized term ('' in browse mode) so the client can confirm
      // which mode the page reflects.
      res.status(200).json({ q: term, entries, total, limit: q.limit, offset: q.offset });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
