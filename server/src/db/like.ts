/**
 * Helpers for safely building `LIKE` / `ILIKE` operands from user input.
 *
 * Parameterized queries stop SQL injection, but they do NOT stop the
 * *pattern metacharacters* `%`, `_`, and the escape character `\` from being
 * interpreted by `LIKE`/`ILIKE`. A search box that passes the raw term into a
 * `%<term>%` pattern therefore lets a user:
 *   - match unintended rows (`a_c` matches `abc`, `axc`, …), corrupting results;
 *   - degrade performance with a pathological all-wildcard pattern (`%%%…`),
 *     a mild DoS vector on a large reference table.
 *
 * `escapeLikePattern` escapes those metacharacters so the term matches
 * literally. Callers still wrap the result in `%…%` (substring) or append `%`
 * (prefix) themselves, and MUST pair the query with an explicit
 * `ESCAPE '\'` clause so Postgres uses backslash as the escape character
 * (the SQL-standard default has no escape character).
 */

/**
 * Escape the `LIKE`/`ILIKE` metacharacters in `input` so it matches literally.
 *
 * Order matters: the backslash is escaped FIRST so we don't double-escape the
 * backslashes we then introduce for `%` and `_`.
 *
 * @example
 *   `korean ILIKE '%' || $1 || '%' ESCAPE '\\'`  with  escapeLikePattern('100%')
 *   → matches the literal substring "100%", not "100<anything>".
 */
export function escapeLikePattern(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}
