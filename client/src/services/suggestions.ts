/**
 * Weekly suggestions — the Resources "This Week" section.
 *
 *   GET /vocab/suggestions/weekly   → ≈15 vocab entries, deterministic per
 *                                     (user, ISO week), excluding words the
 *                                     user has already banked.
 *   GET /grammar/suggestions/weekly → grammar patterns, same mechanism over
 *                                     the KGIU corpus minus already-banked.
 *
 * These are SUGGEST-ONLY: the server never auto-banks. The UI renders each
 * suggestion with an [Add] affordance that calls the EXISTING bank path
 * (`vocab.bankEntry` / `grammar.bankPattern`) — this service only fetches the
 * picks.
 *
 * Threat model:
 *   - GET endpoints → no CSRF surface. Cookie session required; the server
 *     scopes the "already banked" exclusion to the session `user_id`, so a
 *     client cannot request another user's suggestions.
 *   - The response rows render through React text children downstream, so a
 *     hostile corpus row cannot escape into the DOM.
 *   - Determinism is a server property (ORDER BY a per-week hash); the client
 *     makes no stability assumption beyond "the same week returns the same
 *     set", which it does not depend on for correctness.
 */
import { api } from './api';
import type {
  GrammarSuggestionsResponse,
  KgiuEntrySummary,
  VocabEntry,
  VocabSuggestionsResponse,
} from '../types/domain';

/** GET /vocab/suggestions/weekly → this week's vocab picks (≈15). */
export async function fetchWeeklyVocabSuggestions(
  signal?: AbortSignal,
): Promise<VocabEntry[]> {
  const res = await api.get<VocabSuggestionsResponse>(
    '/vocab/suggestions/weekly',
    signal !== undefined ? { signal } : undefined,
  );
  return res.entries;
}

/** GET /grammar/suggestions/weekly → this week's grammar pattern picks. */
export async function fetchWeeklyGrammarSuggestions(
  signal?: AbortSignal,
): Promise<KgiuEntrySummary[]> {
  const res = await api.get<GrammarSuggestionsResponse>(
    '/grammar/suggestions/weekly',
    signal !== undefined ? { signal } : undefined,
  );
  return res.patterns;
}
