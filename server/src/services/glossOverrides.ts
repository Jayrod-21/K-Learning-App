/**
 * glossOverrides — Phase 2.8 user-scoped gloss override.
 *
 * Lets a learner replace the English gloss of a Korean word FOR THEMSELVES,
 * keyed on `(user_id, lemma)` in `user_gloss_overrides` (migration 098).
 * NEVER writes the shared `vocab_entries.english` / `krdict_entries.
 * definition_english` columns — that is the F-199 lesson (see the migration
 * header): a per-user preference on a SHARED row lets one user's edit
 * clobber what every other user sees. This table exists specifically so a
 * gloss override never repeats that mistake.
 *
 * The read side of the feature (the `LEFT JOIN user_gloss_overrides ugo ON
 * ugo.user_id = $u AND ugo.lemma = <lemma col>` + `COALESCE(ugo.gloss,
 * <default>)` overlay) is added per-route across routes/vocab.ts,
 * routes/vocabLists.ts, routes/krdict.ts, and routes/define.ts — there is no
 * shared server-side gloss helper (mirrors the existing per-route
 * `LEFT JOIN vocab_entries` pattern those routes already hand-write). This
 * module owns only the WRITE side (upsert/delete) plus the normalization
 * both sides must agree on.
 *
 * SECURITY: every function here takes `userId` as an explicit parameter.
 * Callers (routes/vocab.ts's PUT/DELETE /vocab/gloss-override) MUST source
 * it from `getUserId(req)` — never from the request body/query — so a user
 * can only ever read/write their OWN overrides (IDOR-proof by construction,
 * same posture as every other per-user table in this codebase).
 */
import { query, type Querier } from '../db/pool.js';
import { ValidationError } from '../middleware/errors.js';

/** Mirrors `ck_user_gloss_overrides_lemma_len` (migration 098) — kept as a
 *  named constant so the route's zod schema and this module's own guard can
 *  never drift from the DB CHECK independently. */
export const GLOSS_OVERRIDE_LEMMA_MAX = 100;
/** Mirrors `ck_user_gloss_overrides_gloss_len` (migration 098). */
export const GLOSS_OVERRIDE_GLOSS_MAX = 2000;

/**
 * Normalize a lemma for the override key: trim surrounding whitespace, then
 * Unicode-NFC-normalize.
 *
 * WHY THIS MATTERS (read this before touching either side of the join):
 * `user_gloss_overrides.lemma` is matched against `vocab_entries.korean` /
 * `krdict_entries.headword` / the client-supplied `WordPopoverData.kr` by
 * exact string equality (`ugo.lemma = <lemma col>` — see the migration 098
 * header and every route's overlay JOIN). Korean text can be represented in
 * either NFC (precomposed Hangul syllables — what every corpus table and
 * every real KRDICT/vocab_entries row uses) or NFD (decomposed jamo
 * sequences — the same visible glyph, a DIFFERENT byte sequence, and one a
 * copy-paste from certain macOS text fields or an IME can produce). Two
 * byte-different-but-visually-identical strings compare UNEQUAL in SQL, so
 * an override written against an NFD lemma would silently never match the
 * NFC corpus column the read-overlay joins against — no error, just a join
 * that quietly returns nothing. Calling this SAME function on both the write
 * path (`upsertGlossOverride`/`deleteGlossOverride` below) and the read path
 * (any route accepting a client-supplied lemma to look up, e.g. GET
 * /define's `word` query param) is what keeps the two sides comparable.
 * Corpus columns themselves (`vocab_entries.korean`, `krdict_entries.
 * headword`) are ALREADY NFC at rest (standard for loaded Korean corpora,
 * confirmed by the recon behind this feature) — those columns are read
 * as-is in the overlay JOIN, not re-normalized per-row, since normalizing a
 * DB column on every read would be needless per-row work for data that is
 * already in the canonical form.
 */
export function normalizeLemma(raw: string): string {
  return raw.trim().normalize('NFC');
}

export interface GlossOverride {
  lemma: string;
  gloss: string;
}

/**
 * Upsert a user's gloss override. `user_id` MUST be the caller's own id
 * (see module header) — this function does not itself re-verify identity,
 * that's the route's contract via `getUserId(req)`.
 *
 * `lemma` is normalized (see {@link normalizeLemma}) before the write so the
 * stored key always matches what the read-overlay will look up. `gloss` is
 * validated non-empty + length-bounded here as a defense-in-depth belt
 * alongside the route's zod schema (services should never trust that every
 * future caller remembers to validate at the boundary).
 *
 * `ON CONFLICT (user_id, lemma) DO UPDATE` — last-write-wins, single owner,
 * no COALESCE needed (unlike the SHARED vocab_entries upsert in
 * `POST /vocab/mine`, where a re-mine must never clobber another user's
 * gloss — this row has exactly one owner, so overwriting IS the intent).
 */
export async function upsertGlossOverride(
  userId: number,
  lemma: string,
  gloss: string,
  exec: Querier = query,
): Promise<GlossOverride> {
  const normalizedLemma = normalizeLemma(lemma);
  const trimmedGloss = gloss.trim();
  if (normalizedLemma.length < 1 || normalizedLemma.length > GLOSS_OVERRIDE_LEMMA_MAX) {
    throw new ValidationError('lemma must be 1..100 characters');
  }
  if (trimmedGloss.length < 1 || trimmedGloss.length > GLOSS_OVERRIDE_GLOSS_MAX) {
    throw new ValidationError('gloss must be 1..2000 characters');
  }
  await exec(
    `INSERT INTO user_gloss_overrides (user_id, lemma, gloss)
          VALUES ($1, $2, $3)
     ON CONFLICT (user_id, lemma) DO UPDATE
        SET gloss = EXCLUDED.gloss,
            updated_at = now()`,
    [userId, normalizedLemma, trimmedGloss],
  );
  return { lemma: normalizedLemma, gloss: trimmedGloss };
}

/**
 * Delete a user's gloss override (revert to the shared default gloss).
 * User-scoped in the WHERE clause — `userId` MUST be the caller's own id
 * (see module header). Returns whether a row was actually removed, so the
 * route can answer `{ cleared: boolean }` instead of a bare 200.
 */
export async function deleteGlossOverride(
  userId: number,
  lemma: string,
  exec: Querier = query,
): Promise<boolean> {
  const normalizedLemma = normalizeLemma(lemma);
  const { rowCount } = await exec(
    `DELETE FROM user_gloss_overrides WHERE user_id = $1 AND lemma = $2`,
    [userId, normalizedLemma],
  );
  return rowCount > 0;
}

/**
 * Look up a single user's override for a lemma, or null. Not used by the
 * bulk read-overlay routes (those overlay via a SQL JOIN so they never pay
 * an N+1), but useful for a single-lemma surface (e.g. GET /define, whose
 * `overridden` flag this backs) and for tests.
 */
export async function getGlossOverride(
  userId: number,
  lemma: string,
  exec: Querier = query,
): Promise<GlossOverride | null> {
  const normalizedLemma = normalizeLemma(lemma);
  const { rows } = await exec<{ lemma: string; gloss: string }>(
    `SELECT lemma, gloss FROM user_gloss_overrides WHERE user_id = $1 AND lemma = $2`,
    [userId, normalizedLemma],
  );
  const row = rows[0];
  return row ? { lemma: row.lemma, gloss: row.gloss } : null;
}
