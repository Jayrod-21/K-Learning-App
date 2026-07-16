/**
 * F-108 corpus visibility fence — the ONE audit surface for "who may read a
 * `vocab_entries` / `kgiu_entries` row".
 *
 * Both tables are shared reference data EXCEPT rows the U2 extraction
 * pipeline writes: those carry `source_upload_id` and derive from a user's
 * PRIVATE book upload (services/uploadExtract.ts), so they must be invisible
 * to everyone but that upload's owner. The rule, everywhere:
 *
 *     row is readable  ⇔  source_upload_id IS NULL            (shared corpus)
 *                          OR the requesting user owns the upload
 *
 * THE CLASS OF BUG THIS MODULE EXISTS TO KILL (fixpass b8, BLOCKER-2/B-1..3):
 * the fence was originally applied only where corpus rows are LISTED or
 * DISPLAYED — but any route that merely ACCEPTS a vocab/kgiu id from the
 * client (bank-a-card, add-to-list, …) and later re-surfaces the row's
 * content through its own reads is the same leak: a stranger probing
 * sequential ids gets an existence oracle plus full content exfiltration.
 *
 * RULE FOR FUTURE ROUTES: if a query touches `vocab_entries` or
 * `kgiu_entries` and either (a) returns row content, or (b) validates a
 * client-supplied id (existence checks included — a 201-vs-404 differential
 * IS a read), it MUST include this predicate. Compose it via
 * `sourceUploadFenceSql` so the shape can't drift.
 *
 * Current fence sites (keep this list in sync — it IS the audit):
 *   - routes/vocab.ts      GET /vocab/entries (browse), GET /vocab/entries/:id
 *                          (detail), POST /vocab/entries/:id/bank (existence
 *                          check)
 *   - routes/grammar.ts    GET /grammar/kgiu (browse), GET /grammar/kgiu/:id
 *                          (detail)
 *   - routes/vocabLists.ts POST /vocab/lists (seed validation), POST
 *                          /vocab/lists/:id/entries (typed-add validation —
 *                          vocab AND grammar target types)
 *   - Unconditional `source_upload_id IS NULL` (no user context / curated
 *     pools only — stricter than this predicate, NOT built from it):
 *     routes/grammar.ts /grammar/suggestions/weekly, routes/diagnostic.ts
 *     pickVocabSeed + pickGrammarSeed.
 *   - Safe WITHOUT the fence (verified fixpass b8): POST /vocab/cards/init +
 *     /vocab/suggestions/weekly (closed curated-corpus allow-lists),
 *     hanja.ts (joins through the user's own cards), GET /vocab/cards/due
 *     (joins the user's own cards — safe as long as banking is fenced).
 */

/**
 * SQL fragment: the requesting user may read this corpus row.
 *
 * @param column        The `source_upload_id` column reference, correctly
 *                      qualified for the calling query (e.g.
 *                      `'source_upload_id'`, `'v.source_upload_id'`). A
 *                      server-owned literal — NEVER client input.
 * @param userIdParam   The placeholder already bound to the session user's id
 *                      in the calling query (e.g. `'$2'`). Server-owned.
 *
 * The subquery alias `bo_fence` is deliberately distinct from the `bu` / `bo`
 * aliases pre-existing queries use, so the fragment composes anywhere.
 */
export function sourceUploadFenceSql(column: string, userIdParam: string): string {
  return `(${column} IS NULL
                 OR EXISTS (SELECT 1 FROM book_uploads bo_fence
                             WHERE bo_fence.id = ${column}
                               AND bo_fence.user_id = ${userIdParam}))`;
}
