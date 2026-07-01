import type { KgiuEntrySummary } from '../types/domain';

/**
 * Stable bank key for a grammar suggestion.
 *
 * The server's `POST /grammar/bank` requires `pattern_key` to match
 * `/^GR-[a-z0-9_-]{1,64}$/`. The raw fallback chain (`source_id ?? pattern`)
 * does NOT satisfy that: KGIU `source_id`s are not GR-shaped, and a Korean
 * `pattern` string never matches the ASCII pattern at all — so banking a weekly
 * grammar pick 400'd. We therefore ALWAYS derive a valid key here: slugify the
 * source_id (or an `kgiu-${id}` fallback when there's no source_id) to the
 * allowed alphabet, then prefix `GR-`.
 *
 * Slugify: lowercase, replace every char outside `[a-z0-9_-]` with `-`, collapse
 * runs of `-`, trim leading/trailing `-`, cap at 64 chars (the regex's upper
 * bound). If the slug collapses to empty (e.g. an all-Korean source_id), fall
 * back to `kgiu-${id}` so the key is still unique + valid.
 */
export function grammarKey(p: KgiuEntrySummary): string {
  const raw = p.source_id ?? `kgiu-${String(p.id)}`;
  const slug = slugifyKey(raw) || `kgiu-${String(p.id)}`;
  return `GR-${slug}`;
}

/** Lowercase → allowed-alphabet → collapse → trim → truncate(64). */
function slugifyKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
