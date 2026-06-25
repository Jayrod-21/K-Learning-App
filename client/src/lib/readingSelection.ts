/**
 * Persisted passage selection for the Reading screen.
 *
 * The Reading screen lets the learner pick which corpus unit (a TTMIK lesson
 * or an Iyagi episode) to read. We persist the last pick to `localStorage` so
 * returning to the screen — or reloading — reopens the same passage rather
 * than snapping back to the first lesson. `null` means "no pick yet": the
 * screen falls back to the first unit of the default corpus (the historical
 * Pass-3 behaviour), now changeable.
 *
 * Storage key follows the `km.*` convention (`km.settings`, theme key, …).
 *
 * Threat model:
 *   - **Hostile / corrupt storage value.** `localStorage` is writable by any
 *     script in the origin and survives across versions. We never trust the
 *     parsed shape: `parseSelection` validates the corpus against the known
 *     union and coerces `unitId` to a positive integer, returning `null` on
 *     any mismatch so a tampered/garbled value degrades to the default load
 *     rather than driving a malformed `/reading/units/:corpus/:unitId` request.
 *   - **Storage unavailable (private mode / disabled).** Every access is
 *     wrapped so a `DOMException` (quota, disabled storage, SSR with no
 *     `window`) never throws into render — the screen treats selection as
 *     always-readable and falls back to the default on any failure.
 */
import type { ReadingCorpus, ReadingSelection } from '../types/domain';

/** localStorage key; mirrors the `km.<name>` convention used elsewhere. */
export const READING_SELECTION_STORAGE_KEY = 'km.reading.selection';

const KNOWN_CORPORA: readonly ReadingCorpus[] = ['ttmik', 'iyagi'];

/**
 * Validate an untrusted parsed value into a `ReadingSelection`, or `null`.
 * Defends the storage-tamper vector documented in the file header.
 */
function parseSelection(raw: unknown): ReadingSelection | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const corpus = rec.corpus;
  const unitId = rec.unitId;
  const title = rec.title;
  if (
    typeof corpus !== 'string' ||
    !KNOWN_CORPORA.includes(corpus as ReadingCorpus)
  ) {
    return null;
  }
  if (
    typeof unitId !== 'number' ||
    !Number.isInteger(unitId) ||
    unitId <= 0
  ) {
    return null;
  }
  // Title is display-only. A missing/garbled title is non-fatal — coerce to
  // an empty string so the routing-relevant `corpus`/`unitId` still drive the
  // load; the screen falls back to a corpus tag when the title is blank.
  return {
    corpus: corpus as ReadingCorpus,
    unitId,
    title: typeof title === 'string' ? title : '',
  };
}

/**
 * Read the persisted selection. Returns `null` when nothing is stored, the
 * value is corrupt, or storage is unavailable — the screen then defaults to
 * the first unit of the default corpus. Never throws.
 */
export function loadReadingSelection(): ReadingSelection | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(READING_SELECTION_STORAGE_KEY);
    if (!raw) return null;
    return parseSelection(JSON.parse(raw) as unknown);
  } catch {
    // Corrupt JSON, storage disabled (private mode), or DOMException.
    return null;
  }
}

/**
 * Persist a selection. Best-effort — swallows quota / DOMException with a
 * warn so a doomed write never crashes the screen; the in-memory pick still
 * drives the current session.
 */
export function saveReadingSelection(selection: ReadingSelection): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      READING_SELECTION_STORAGE_KEY,
      JSON.stringify(selection),
    );
  } catch (err) {
    console.warn('km.reading.selection: failed to persist selection', err);
  }
}
