/**
 * /hanja routes — Hanja goes live (Pass 7).
 *
 * Flow:
 *   GET  /hanja               → the character pool, with this user's per-char
 *                               state folded in (filterable by state)
 *   GET  /hanja/today         → one featured character, weighted toward the
 *                               user's recently-mined words
 *   GET  /hanja/progress      → the user's banked/practicing/new counts + target
 *   POST /hanja/:char/state   → set this user's state for one character (upsert)
 *
 * FSRS cards (F-075, migration 050 — hanja rides the SAME scheduler + review
 * log as vocab/grammar cards; feeds the Settings hanja-mastery carousel F-041):
 *   POST /hanja/:char/card          → seed a recognition card (idempotent)
 *   GET  /hanja/cards/due           → this user's due hanja cards
 *   POST /hanja/cards/:cardId/reviews → self-rate a due card (shared FSRS
 *                                     engine via services/cardReview.ts);
 *                                     ALSO appends a hanja_attempts row in
 *                                     the SAME transaction (F-171, migration
 *                                     059 — see services/cardReview.ts)
 *   GET  /hanja/attempts            → this user's hanja-attempt history,
 *                                     paged (F-171)
 *
 * DTO — matches the client `Hanja` shape (see client domain types):
 *   { id, characterId, ch, sound, gloss, en, level, strokes, state, note,
 *     compounds }
 *   where compounds = { kr, han, en, with }[]. Field mapping:
 *     id    = char (stable, unique)        ch   = char
 *     characterId = hanja_characters.id (numeric surrogate PK — F-114; the
 *                   id typed list membership targets, so list-add no longer
 *                   needs the card-seed round-trip to learn it)
 *     sound = sound                        gloss= gloss_kr ?? ''   (훈; v1 empty)
 *     en    = gloss_en                     level= level (L2..L5 string)
 *     strokes = strokes                    state= per-user progress.state ?? 'new'
 *     note  = etymology ?? ''  (v1 empty)
 *     compounds[].with = with_chars
 *
 * SECURITY (see SECURITY.md §15):
 *   - hanja_characters / hanja_compounds are PUBLIC reference data (no answer
 *     secret — a hanja's reading/gloss is not a quiz answer). They carry no
 *     user_id and are served to any authenticated user.
 *   - hanja_progress is USER-SCOPED: every read filters `WHERE user_id = $1`
 *     (session-derived via getUserId), every write stamps the session user. The
 *     POST body is `.strict()` and contains only `state` — no client-supplied
 *     user id (mass-assignment closed). UNIQUE(user_id, char) makes the write an
 *     idempotent upsert; a user can never write another user's row.
 *   - `:char` is validated to exactly one hanja codepoint by zod before it ever
 *     reaches SQL; every query is parameterized regardless.
 *   - GET /hanja/today reads ONLY the caller's own vocab_cards → vocab_entries
 *     for the weighting; it never 500s on an empty corpus (returns a null
 *     character + the client shows an empty state).
 *   - cheapLimiter on every route (per-IP); no route calls any upstream (no
 *     Claude), so there is no cost amplification.
 *   - hanja_attempts (F-171) is USER-SCOPED exactly like hanja_progress: every
 *     row is written with the SESSION user_id (never client-supplied, stamped
 *     inside services/cardReview.ts's own transaction), and GET /hanja/attempts
 *     filters `WHERE user_id = $1`. There is no answer-secret to strip (a
 *     rating is the caller's own self-report, not a graded reference), so the
 *     row is served back to its owner unmodified.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { query } from '../db/pool.js';
import { NotFoundError } from '../middleware/errors.js';
import { applyCardReview } from '../services/cardReview.js';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Domain constants + DTO
// ---------------------------------------------------------------------------

/** The per-user learning states (matches the DB CHECK + client HanjaState). */
const HANJA_STATES = ['new', 'practicing', 'banked'] as const;
type HanjaState = (typeof HANJA_STATES)[number];

/** The list filter — 'all' plus each state. */
const LIST_FILTERS = ['all', ...HANJA_STATES] as const;

/** Client `HanjaCompound`. `with` is a JS reserved word; the field is still
 *  named `with` to match the client domain type (it's a valid object key). */
interface HanjaCompoundDTO {
  readonly kr: string;
  readonly han: string;
  readonly en: string;
  readonly with: string;
}

/** Client `Hanja`. */
interface HanjaDTO {
  readonly id: string;
  /** Numeric `hanja_characters.id` (F-114) — the surrogate PK typed list
   *  membership (`POST /vocab/lists/:id/entries`, migration 049) targets. */
  readonly characterId: number;
  readonly ch: string;
  readonly sound: string;
  readonly gloss: string;
  readonly en: string;
  readonly level: string;
  readonly strokes: number;
  readonly state: HanjaState;
  readonly note: string;
  readonly compounds: readonly HanjaCompoundDTO[];
}

/**
 * One hanja_characters row joined to this user's progress + aggregated
 * compounds, as selected by the list/today queries. `state` is the LEFT-JOINed
 * progress state (null when the user has no row → defaults to 'new'). `compounds`
 * is a json_agg array (never null — COALESCE'd to '[]' in SQL).
 */
interface HanjaRow {
  /** BIGINT PK — node-postgres serialises int8 as a string. */
  id: string;
  char: string;
  sound: string;
  gloss_kr: string | null;
  gloss_en: string;
  level: string;
  strokes: number;
  state: string | null;
  compounds: ReadonlyArray<{
    kr: string | null;
    han: string | null;
    en: string | null;
    with: string | null;
  }>;
  note: string | null;
}

/** Narrow an arbitrary string to a HanjaState, defaulting to 'new'. */
function toHanjaState(value: string | null | undefined): HanjaState {
  return value === 'practicing' || value === 'banked' ? value : 'new';
}

/** Map a joined row to the client `Hanja` DTO. */
function mapRowToDTO(row: HanjaRow): HanjaDTO {
  const compounds: HanjaCompoundDTO[] = row.compounds.map((c) => ({
    kr: c.kr ?? '',
    han: c.han ?? '',
    en: c.en ?? '',
    with: c.with ?? '',
  }));
  return {
    id: row.char,
    // BIGINT → JSON number. hanja_characters ids are sequence-assigned and
    // nowhere near 2^53, so Number() is lossless (same conversion the card
    // routes already apply to `hanja_character_id`).
    characterId: Number(row.id),
    ch: row.char,
    sound: row.sound,
    gloss: row.gloss_kr ?? '',
    en: row.gloss_en,
    level: row.level,
    strokes: row.strokes,
    state: toHanjaState(row.state),
    note: row.note ?? '',
    compounds,
  };
}

/**
 * The SELECT shared by the list + today queries: every hanja_characters column
 * the DTO needs, this user's progress state (LEFT JOIN), and the compounds
 * aggregated as a JSON array. `$1` is always the user id.
 *
 * The compound aggregation is a correlated LATERAL subquery rather than a
 * GROUP BY over a join, so the character columns don't have to appear in a
 * GROUP BY clause and a character with zero compounds still yields '[]' (not a
 * dropped row). `ORDER BY id` inside the agg gives a stable compound order.
 */
const HANJA_SELECT = `
  SELECT hc.id,
         hc.char,
         hc.sound,
         hc.gloss_kr,
         hc.gloss_en,
         hc.level,
         hc.strokes,
         hc.etymology AS note,
         hp.state AS state,
         COALESCE(cmp.compounds, '[]'::json) AS compounds
    FROM hanja_characters hc
    LEFT JOIN hanja_progress hp
      ON hp.char = hc.char AND hp.user_id = $1
    LEFT JOIN LATERAL (
      SELECT json_agg(
               json_build_object(
                 'kr',   c.word_kr,
                 'han',  c.word_hanja,
                 'en',   c.gloss_en,
                 'with', c.with_chars
               )
               ORDER BY c.id
             ) AS compounds
        FROM hanja_compounds c
       WHERE c.character_id = hc.id
    ) cmp ON true`;

// ---------------------------------------------------------------------------
// GET /hanja — the character pool with this user's state folded in.
// ---------------------------------------------------------------------------

const ListQuerySchema = z.object({
  filter: z.enum(LIST_FILTERS).default('all'),
});

/**
 * GET /hanja — `{ characters: Hanja[] }`.
 *
 * Every character, LEFT JOINed to this user's progress (effective state =
 * progress.state ?? 'new'), with its compounds aggregated. `filter` narrows on
 * the EFFECTIVE state: 'new' includes characters with no progress row (the join
 * yields NULL, treated as 'new'); 'banked'/'practicing' require a matching
 * progress row. Ordered by frequency DESC (most-useful first).
 */
router.get('/', cheapLimiter(), validateQuery(ListQuerySchema), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const q = (req as typeof req & {
      validatedQuery: z.infer<typeof ListQuerySchema>;
    }).validatedQuery;

    // Filter on the effective state. 'new' = no row OR an explicit 'new' row;
    // the other two require the row to exist with that state. The predicate is a
    // fixed literal chosen by the validated enum — never interpolated input.
    let havingClause = '';
    if (q.filter === 'new') {
      havingClause = `WHERE (hp.state IS NULL OR hp.state = 'new')`;
    } else if (q.filter === 'practicing' || q.filter === 'banked') {
      // $2 is the bound state literal; cast is unnecessary (TEXT column).
      havingClause = `WHERE hp.state = $2`;
    }

    const params: unknown[] = [userId];
    if (q.filter === 'practicing' || q.filter === 'banked') params.push(q.filter);

    const { rows } = await query<HanjaRow>(
      `${HANJA_SELECT}
        ${havingClause}
        ORDER BY hc.frequency DESC, hc.char`,
      params,
    );

    res.status(200).json({ characters: rows.map(mapRowToDTO) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /hanja/today — one featured character, weighted toward recent mining.
// ---------------------------------------------------------------------------

/**
 * GET /hanja/today — `{ character: Hanja | null }`.
 *
 * Picks ONE character with this priority:
 *   1. A character that appears in the user's RECENTLY-created vocab_cards
 *      (joined through vocab_entries.hanja), preferring ones not yet 'banked',
 *      most-recent first. This is the "review what you're mining" signal.
 *   2. Otherwise the highest-frequency character the user has not yet banked.
 *   3. Otherwise any character, chosen deterministically-per-day (the md5(user
 *      || seoul_date || char) idiom from /plan/today) so a fully-banked user
 *      still gets a stable daily pick instead of nothing.
 *
 * Returns `{ character: null }` (NOT a 500) when the corpus is empty — the
 * client renders an empty state.
 */
router.get('/today', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const userKey = String(userId);

    // 1. Recently-mined characters. vocab_entries.hanja is a free-text gloss
    //    string that may contain several hanja; we match a character whose
    //    `char` appears anywhere in that string for one of THIS user's recent,
    //    live cards. Prefer not-yet-banked, then most-recent card.
    const mined = await query<{ char: string }>(
      `SELECT hc.char
         FROM hanja_characters hc
         JOIN vocab_entries ve
           ON ve.hanja IS NOT NULL AND position(hc.char IN ve.hanja) > 0
         JOIN vocab_cards vcrd
           ON vcrd.vocab_entry_id = ve.id
          AND vcrd.user_id = $1
          AND vcrd.deleted_at IS NULL
         LEFT JOIN hanja_progress hp
           ON hp.char = hc.char AND hp.user_id = $1
        ORDER BY (CASE WHEN hp.state = 'banked' THEN 1 ELSE 0 END),
                 vcrd.created_at DESC,
                 hc.frequency DESC,
                 hc.char
        LIMIT 1`,
      [userId],
    );

    let picked = mined.rows[0]?.char ?? null;

    // 2. Highest-frequency not-yet-banked character.
    if (picked === null) {
      const fallback = await query<{ char: string }>(
        `SELECT hc.char
           FROM hanja_characters hc
           LEFT JOIN hanja_progress hp
             ON hp.char = hc.char AND hp.user_id = $1
          WHERE hp.state IS DISTINCT FROM 'banked'
          ORDER BY hc.frequency DESC, hc.char
          LIMIT 1`,
        [userId],
      );
      picked = fallback.rows[0]?.char ?? null;
    }

    // 3. Deterministic-per-day pick over the whole corpus (handles the
    //    everything-banked case and guarantees a stable daily character).
    if (picked === null) {
      const anyChar = await query<{ char: string }>(
        `SELECT char
           FROM hanja_characters
          ORDER BY md5($1::text || (now() AT TIME ZONE 'Asia/Seoul')::date::text || char)
          LIMIT 1`,
        [userKey],
      );
      picked = anyChar.rows[0]?.char ?? null;
    }

    // Empty corpus — never 500.
    if (picked === null) {
      res.status(200).json({ character: null });
      return;
    }

    // Hydrate the chosen character into the full DTO (state + compounds).
    const { rows } = await query<HanjaRow>(
      `${HANJA_SELECT}
        WHERE hc.char = $2
        LIMIT 1`,
      [userId, picked],
    );
    const row = rows[0];
    res.status(200).json({ character: row ? mapRowToDTO(row) : null });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /hanja/progress — the user's counts + target band.
// ---------------------------------------------------------------------------

interface HanjaProgressDTO {
  readonly banked: number;
  readonly practicing: number;
  readonly new: number;
  readonly targetL4: number;
  readonly encountered: number;
  readonly note: string;
}

/**
 * GET /hanja/progress — `{ banked, practicing, new, targetL4, encountered, note }`.
 *
 *   banked / practicing = count of THIS user's progress rows in that state
 *   new                 = total characters − banked − practicing (everything the
 *                         user has not actively moved is "new", whether or not a
 *                         row exists)
 *   targetL4            = count of L4 characters (the working target band)
 *   encountered         = how many characters the user has ANY progress row for
 *   note                = a short templated status line
 */
router.get('/progress', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);

    const { rows } = await query<{
      total: number;
      banked: number;
      practicing: number;
      encountered: number;
      target_l4: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM hanja_characters)                         AS total,
         (SELECT count(*)::int FROM hanja_progress
            WHERE user_id = $1 AND state = 'banked')                          AS banked,
         (SELECT count(*)::int FROM hanja_progress
            WHERE user_id = $1 AND state = 'practicing')                      AS practicing,
         (SELECT count(*)::int FROM hanja_progress
            WHERE user_id = $1)                                               AS encountered,
         (SELECT count(*)::int FROM hanja_characters WHERE level = 'L4')      AS target_l4`,
      [userId],
    );

    const r = rows[0] ?? {
      total: 0,
      banked: 0,
      practicing: 0,
      encountered: 0,
      target_l4: 0,
    };
    // "new" is everything not actively moved — clamp at 0 in case progress rows
    // outnumber the current corpus (orphans from a prior, larger build).
    const newCount = Math.max(0, r.total - r.banked - r.practicing);

    const dto: HanjaProgressDTO = {
      banked: r.banked,
      practicing: r.practicing,
      new: newCount,
      targetL4: r.target_l4,
      encountered: r.encountered,
      note: `${r.banked} banked · ${r.practicing} practicing · ${r.encountered}/${r.total} encountered`,
    };
    res.status(200).json(dto);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /hanja/:char/state — set this user's state for one character (upsert).
// ---------------------------------------------------------------------------

/**
 * Exactly one hanja codepoint. We validate the LENGTH at the code-point level
 * ([...str].length === 1) because a single hanja outside the BMP would be two
 * UTF-16 units; today's corpus is all BMP, but the route should accept a single
 * astral codepoint and reject a two-character string regardless. The DB CHECK
 * (`char_length(char) = 1`) is the backstop.
 */
const CharParamsSchema = z.object({
  char: z.string().refine((s) => [...s].length === 1, {
    message: 'char must be exactly one character',
  }),
});

const StateBodySchema = z
  .object({
    state: z.enum(HANJA_STATES),
  })
  .strict();

/**
 * POST /hanja/:char/state — upsert this user's state for one character.
 *
 * Body `{ state }`. Upserts hanja_progress (user, char) → state
 * (`ON CONFLICT (user_id, char) DO UPDATE`, bumping version), stamped with the
 * SESSION user (never client-supplied). Returns `{ char, state }`.
 *
 * Idempotent: setting the same state twice converges on one row. The character
 * is NOT validated against hanja_characters — progress is intentionally
 * decoupled from the corpus (see migration 016) so a user can stamp a character
 * even across a corpus rebuild; the value is still constrained to one codepoint
 * by zod + the DB CHECK.
 */
router.post(
  '/:char/state',
  cheapLimiter(),
  validateParams(CharParamsSchema),
  validateBody(StateBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const params = (req as typeof req & {
        validatedParams: z.infer<typeof CharParamsSchema>;
      }).validatedParams;
      const body = req.body as z.infer<typeof StateBodySchema>;

      const { rows } = await query<{ char: string; state: string }>(
        `INSERT INTO hanja_progress (user_id, char, state)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, char) DO UPDATE
           SET state   = EXCLUDED.state,
               version = hanja_progress.version + 1
         RETURNING char, state`,
        [userId, params.char, body.state],
      );

      const row = rows[0];
      res.status(200).json({
        char: row?.char ?? params.char,
        state: toHanjaState(row?.state),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// FSRS cards (F-075) — hanja recognition cards on the shared scheduler.
//
// SECURITY (same posture as /vocab/cards/*):
//   - Every card read/write is scoped to the SESSION user (getUserId); a
//     cross-user card id 404s (no existence leak — mirrors FU-NF-8).
//   - Scheduling is server-authoritative (ADR-003 amendment 2026-07-02): the
//     client submits only its rating + expected_version; the FSRS transition
//     and due_at are computed in services/cardReview.ts from the locked DB
//     row. A tampered client cannot park or rush a card.
//   - The rate endpoint REQUIRES a hanja-target card (requireHanjaTarget) so
//     this route is not a side door for rating other card families.
//   - Ids are Zod-bounded to MAX_SAFE_INTEGER / INT4 before they bind to
//     BIGINT/INTEGER params (routes sweep #3 — no 22003 → 500 on garbage).
//   - cheapLimiter on every route; no upstream calls (no cost amplification).
// ---------------------------------------------------------------------------

/** Bounds mirroring routes/vocab.ts: ids bind to BIGINT (int8) columns —
 *  MAX_SAFE_INTEGER ≪ int8 max — and version/duration bind to INTEGER. */
const MAX_ID = Number.MAX_SAFE_INTEGER;
const INT4_MAX = 2_147_483_647;

/** Wire shape of one hanja card (due queue + seed response). BIGINT ids are
 *  converted to JSON numbers; NUMERIC stability/difficulty stay strings
 *  (precision-safe — the same convention as /vocab/cards/due). */
interface HanjaCardDTO {
  readonly id: number;
  readonly face: string;
  readonly due_at: Date;
  readonly fsrs_state: string;
  readonly stability: string;
  readonly difficulty: string;
  readonly version: number;
  readonly hanja_character_id: number;
  readonly ch: string;
  readonly sound: string;
  readonly gloss: string;
  readonly en: string;
  readonly level: string;
  readonly strokes: number;
}

interface HanjaCardRow {
  id: string;
  face: string;
  due_at: Date;
  fsrs_state: string;
  stability: string;
  difficulty: string;
  version: number;
  hanja_character_id: string;
  char: string;
  sound: string;
  gloss_kr: string | null;
  gloss_en: string;
  level: string;
  strokes: number;
}

function mapCardRowToDTO(row: HanjaCardRow): HanjaCardDTO {
  return {
    id: Number(row.id),
    face: row.face,
    due_at: row.due_at,
    fsrs_state: row.fsrs_state,
    stability: row.stability,
    difficulty: row.difficulty,
    version: row.version,
    hanja_character_id: Number(row.hanja_character_id),
    ch: row.char,
    sound: row.sound,
    gloss: row.gloss_kr ?? '',
    en: row.gloss_en,
    level: row.level,
    strokes: row.strokes,
  };
}

/**
 * POST /hanja/:char/card — seed a recognition card for one character.
 *
 * Idempotent: `uq_vocab_cards_user_hanja_face` (migration 050) makes the
 * INSERT an `ON CONFLICT … DO NOTHING` upsert, so a double-tap (or a
 * concurrent double-submit) converges on ONE live card per (user, character,
 * face) instead of splitting the FSRS history. 201 + `created: true` on a
 * fresh card; 200 + `created: false` with the existing card otherwise.
 *
 * UNLIKE /hanja/:char/state (which deliberately accepts corpus-unknown
 * characters — see migration 016), the card target is a real FK: an unknown
 * character 404s. A card without a corpus row could never be reviewed.
 */
router.post(
  '/:char/card',
  cheapLimiter(),
  validateParams(CharParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const params = (req as typeof req & {
        validatedParams: z.infer<typeof CharParamsSchema>;
      }).validatedParams;

      const character = await query<{ id: string }>(
        `SELECT id FROM hanja_characters WHERE char = $1`,
        [params.char],
      );
      const characterRow = character.rows[0];
      if (characterRow === undefined) {
        throw new NotFoundError('hanja character not found');
      }
      const characterId = Number(characterRow.id);

      // The conflict target names the partial unique index's columns AND
      // predicate (both required for pg to infer a partial index). due_at
      // defaults to now() — a fresh card is immediately due (same behavior
      // as /vocab/cards/init); proficiency keeps its column DEFAULT ('L3' —
      // the hanja L2..L5 banding is a different axis, see migration 016).
      const ins = await query<{ id: string; version: number; due_at: Date }>(
        `INSERT INTO vocab_cards (user_id, face, hanja_character_id)
         VALUES ($1, 'recognition'::card_face, $2)
         ON CONFLICT (user_id, hanja_character_id, face)
           WHERE hanja_character_id IS NOT NULL AND deleted_at IS NULL
           DO NOTHING
         RETURNING id, version, due_at`,
        [userId, characterId],
      );

      let card = ins.rows[0];
      const created = card !== undefined;
      if (card === undefined) {
        // Conflict path: the live card already exists — return it. (It cannot
        // vanish between the two statements: only this user writes their own
        // cards, and hard deletes don't exist on this path.)
        const existing = await query<{ id: string; version: number; due_at: Date }>(
          `SELECT id, version, due_at
             FROM vocab_cards
            WHERE user_id = $1
              AND hanja_character_id = $2
              AND face = 'recognition'::card_face
              AND deleted_at IS NULL`,
          [userId, characterId],
        );
        card = existing.rows[0];
      }
      if (card === undefined) {
        // Defensive: unreachable unless the card was hard-deleted mid-flight.
        throw new NotFoundError('hanja card not found');
      }

      res.status(created ? 201 : 200).json({
        card_id: Number(card.id),
        character_id: characterId,
        ch: params.char,
        face: 'recognition',
        due_at: card.due_at,
        version: card.version,
        created,
      });
    } catch (err) {
      next(err);
    }
  },
);

const CardsDueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

/**
 * GET /hanja/cards/due — `{ cards: HanjaCardDTO[] }`, oldest-due first.
 *
 * The hanja twin of /vocab/cards/due (same WHERE shape: user-scoped, live,
 * not suspended, due) restricted to hanja-target cards and joined to
 * hanja_characters for the fields the review UI renders. Vocab's due queue
 * excludes hanja cards for exactly this split — no card is served twice.
 * INNER JOIN is safe: hanja_character_id is a real FK, the corpus row must
 * exist. `version` is REQUIRED on the wire — the client echoes it back as
 * `expected_version` (optimistic concurrency), mirroring the vocab queue.
 */
router.get(
  '/cards/due',
  cheapLimiter(),
  validateQuery(CardsDueQuerySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const q = (req as typeof req & {
        validatedQuery: z.infer<typeof CardsDueQuerySchema>;
      }).validatedQuery;

      const { rows } = await query<HanjaCardRow>(
        `SELECT c.id, c.face, c.due_at, c.fsrs_state, c.stability, c.difficulty,
                c.version, c.hanja_character_id,
                hc.char, hc.sound, hc.gloss_kr, hc.gloss_en, hc.level, hc.strokes
           FROM vocab_cards c
           JOIN hanja_characters hc
             ON hc.id = c.hanja_character_id
          WHERE c.user_id = $1
            AND c.hanja_character_id IS NOT NULL
            AND c.deleted_at IS NULL
            AND c.suspended_at IS NULL
            AND c.due_at <= now()
          ORDER BY c.due_at
          LIMIT $2`,
        [userId, q.limit],
      );
      res.status(200).json({ cards: rows.map(mapCardRowToDTO) });
    } catch (err) {
      next(err);
    }
  },
);

const CardReviewParamsSchema = z.object({
  cardId: z.coerce.number().int().positive().max(MAX_ID),
});

// .strict() — unlike vocab's ReviewBodySchema (which tolerates legacy
// pre-cutover snapshot fields by stripping them), this endpoint is NEW with
// no legacy clients: unknown keys are a bug or a probe and 400.
const CardReviewBodySchema = z
  .object({
    rating: z.enum(['again', 'hard', 'good', 'easy']),
    duration_ms: z.number().int().nonnegative().max(INT4_MAX).optional(),
    expected_version: z.number().int().positive().max(INT4_MAX),
  })
  .strict();

/**
 * POST /hanja/cards/:cardId/reviews — self-rate a hanja card.
 *
 * Same contract as POST /vocab/cards/:cardId/reviews — `{ rating,
 * duration_ms?, expected_version }` → `{ version, due_at, scheduled_days }` —
 * because it IS the same write path: services/cardReview.ts locks the row,
 * derives the FSRS transition via the shared engine (services/fsrs.ts),
 * advances the card, and appends the BEFORE/AFTER snapshot to card_reviews.
 * 404 unknown / cross-user / non-hanja card; 409 stale expected_version.
 *
 * F-171: `logHanjaAttempt: true` additionally appends a `hanja_attempts` row
 * INSIDE that same transaction — one completed review, one atomic write of
 * both the FSRS advance and the attempt-log line (see services/cardReview.ts
 * for why this lives there rather than a second call from this handler).
 */
router.post(
  '/cards/:cardId/reviews',
  cheapLimiter(),
  validateParams(CardReviewParamsSchema),
  validateBody(CardReviewBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const cardId = (req as typeof req & {
        validatedParams: z.infer<typeof CardReviewParamsSchema>;
      }).validatedParams.cardId;
      const body = req.body as z.infer<typeof CardReviewBodySchema>;

      const out = await applyCardReview({
        cardId,
        userId,
        rating: body.rating,
        durationMs: body.duration_ms,
        expectedVersion: body.expected_version,
        requireHanjaTarget: true,
        logHanjaAttempt: true,
        cardNoun: 'hanja card',
      });
      res.status(200).json({
        version: out.version,
        due_at: out.dueAt,
        scheduled_days: out.scheduledDays,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /hanja/attempts — this user's hanja-attempt history, paged (F-171).
// ---------------------------------------------------------------------------

// Mirrors grammarDrill.ts's / writing.ts's AttemptsQuerySchema exactly: a
// personal practice-history feed never needs a huge page, and 100 bounds a
// runaway client the same way those routes' ceilings do.
const HanjaAttemptsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
});

interface HanjaAttemptHistoryRow {
  id: string;
  card_id: string | null;
  char: string;
  rating: string;
  correct: boolean;
  created_at: Date;
  total: string;
}

/** One entry in `GET /hanja/attempts`' `attempts` array. */
interface HanjaAttemptDTO {
  readonly id: number;
  readonly cardId: number | null;
  readonly char: string;
  readonly rating: string;
  readonly correct: boolean;
  readonly createdAt: Date;
}

/**
 * GET /hanja/attempts — `{ attempts, total, limit, offset }`.
 *
 * Every row `POST /hanja/cards/:cardId/reviews` wrote for THIS user (F-171),
 * newest first. `COUNT(*) OVER ()` rides along on every row (mirrors
 * GET /grammar-drill/attempts, GET /writing/attempts) so the client can page
 * without a second round trip; `total` is read off row 0 and defaults to 0 on
 * an empty page. A later builder / the Today screen reads this for a daily
 * "drilled today" count (F-171's own stated motivation) by filtering the
 * returned `createdAt`s client-side, or a future date-ranged query param —
 * out of this ticket's scope, the shape here is what that follow-up builds on.
 */
router.get(
  '/attempts',
  cheapLimiter(),
  validateQuery(HanjaAttemptsQuerySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const q = (req as typeof req & {
        validatedQuery: z.infer<typeof HanjaAttemptsQuerySchema>;
      }).validatedQuery;

      const { rows } = await query<HanjaAttemptHistoryRow>(
        `SELECT id::text AS id, card_id::text AS card_id, char, rating, correct,
                created_at, COUNT(*) OVER ()::text AS total
           FROM hanja_attempts
          WHERE user_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2 OFFSET $3`,
        [userId, q.limit, q.offset],
      );
      const total = rows.length > 0 ? Number(rows[0]!.total) : 0;
      const attempts: HanjaAttemptDTO[] = rows.map((r) => ({
        id: Number(r.id),
        cardId: r.card_id === null ? null : Number(r.card_id),
        char: r.char,
        rating: r.rating,
        correct: r.correct,
        createdAt: r.created_at,
      }));
      res.status(200).json({ attempts, total, limit: q.limit, offset: q.offset });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
