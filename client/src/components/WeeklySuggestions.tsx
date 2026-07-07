/**
 * "This Week" — suggest-only weekly picks (≈15 vocab + a handful of grammar
 * patterns, deterministic per ISO week server-side).
 *
 * Moved out of pages/Reference.tsx when that page dissolved (Overhaul P1.2).
 * TRANSITIONAL HOME: it renders on the Review-library vocabulary page
 * (`/review/vocab`) so the capability survives the dissolution; decision D4
 * relocates the suggestion function into the LEARN vocab + grammar pages in
 * P4 (surface design is an open sub-task there).
 *
 * SUGGEST-ONLY: the server never auto-banks; each card has an [Add] button
 * that banks the pick through the EXISTING per-entry / per-pattern bank path
 * and flips to "✓ Added". The flip is idempotent — a double-tap (or a server
 * 409 "already banked") still lands on the added state rather than surfacing
 * an error.
 *
 * Threat model:
 *   - Korean/English strings render through React text children — a hostile
 *     corpus row cannot escape into the DOM.
 *   - The bank calls are POSTs → CSRF surface, defended by the session
 *     cookie's `SameSite=Strict` (services/api.ts). We never echo server
 *     message text; the flip state derives from our own row ids.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { Button } from './Button';
import { Card } from './Card';
import { Eyebrow } from './Eyebrow';
import * as vocabService from '../services/vocab';
import * as grammarService from '../services/grammar';
import {
  fetchWeeklyGrammarSuggestions,
  fetchWeeklyVocabSuggestions,
} from '../services/suggestions';
import { ApiError } from '../services/api';
import { grammarKey } from '../lib/grammarKey';
import { kgiuBankBody } from '../lib/grammarBank';
import type { KgiuEntrySummary, VocabEntry } from '../types/domain';

/** Outcome of an idempotent add — drives the ✓ flip honestly. */
type AddState = 'idle' | 'adding' | 'added' | 'error';

/** A pattern is renderable/bankable only if its display string is non-blank. */
function hasPattern(p: KgiuEntrySummary): boolean {
  return p.pattern.trim().length > 0;
}

export function WeeklySuggestions(): JSX.Element | null {
  const [vocab, setVocab] = useState<VocabEntry[] | null>(null);
  const [grammar, setGrammar] = useState<KgiuEntrySummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  // Per-pick add state, keyed by a namespaced id so vocab + grammar never
  // collide. The flip is local + idempotent — see `bankVocab` / `bankGrammar`.
  const [adds, setAdds] = useState<Record<string, AddState>>({});

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    // Fetch both picks in parallel; a failure on one leaves the other usable.
    // `allSettled` so one empty/erroring suggestion source doesn't blank the
    // whole strip (suggest-only is a nice-to-have, never a blocker).
    void Promise.allSettled([
      fetchWeeklyVocabSuggestions(ctrl.signal),
      fetchWeeklyGrammarSuggestions(ctrl.signal),
    ]).then(([v, g]) => {
      if (!alive || ctrl.signal.aborted) return;
      setVocab(v.status === 'fulfilled' ? v.value : []);
      // Defensive: drop any pattern with an empty display string. Post-F1 the
      // server already fences these out (kgiu rows whose `pattern` is blank),
      // so this should never fire — but a blank row has no banking key and
      // would render an empty card, so we skip it here too.
      setGrammar(g.status === 'fulfilled' ? g.value.filter(hasPattern) : []);
      setLoading(false);
    });
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, []);

  const setAdd = useCallback((key: string, next: AddState): void => {
    setAdds((prev) => ({ ...prev, [key]: next }));
  }, []);

  const bankVocab = useCallback(
    async (entry: VocabEntry): Promise<void> => {
      const key = `v:${String(entry.id)}`;
      setAdd(key, 'adding');
      try {
        await vocabService.bankEntry(entry.id);
        setAdd(key, 'added');
      } catch (err) {
        // The bank path is idempotent server-side; a 409 means "already
        // banked", which satisfies the post-condition — flip to ✓, not error.
        if (err instanceof ApiError && err.status === 409) {
          setAdd(key, 'added');
          return;
        }
        setAdd(key, 'error');
      }
    },
    [setAdd],
  );

  const bankGrammar = useCallback(
    async (pattern: KgiuEntrySummary): Promise<void> => {
      const key = `g:${grammarKey(pattern)}`;
      setAdd(key, 'adding');
      try {
        await grammarService.bankPattern(kgiuBankBody(pattern));
        setAdd(key, 'added');
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setAdd(key, 'added');
          return;
        }
        setAdd(key, 'error');
      }
    },
    [setAdd],
  );

  // Nothing to suggest (both empty) and not loading → render nothing rather
  // than an empty card.
  const hasAny = (vocab?.length ?? 0) > 0 || (grammar?.length ?? 0) > 0;
  if (!loading && !hasAny) return null;

  return (
    <Card className="km-resources__week" variant="flat">
      <Eyebrow>이번 주 · This Week</Eyebrow>
      <p className="km-resources__week-hint">
        A fresh set every week. Tap Add to bank a card — nothing is added
        automatically.
      </p>
      {loading ? (
        <div className="km-grammar__state" role="status">
          Loading this week’s picks…
        </div>
      ) : (
        <div className="km-resources__week-cols">
          {(vocab?.length ?? 0) > 0 ? (
            <div className="km-resources__week-col">
              <Eyebrow className="km-resources__week-coltitle">Vocabulary</Eyebrow>
              <ul className="km-resources__suggest-list">
                {vocab?.map((entry) => {
                  const key = `v:${String(entry.id)}`;
                  return (
                    <SuggestRow
                      key={key}
                      kr={entry.korean ?? ''}
                      en={entry.english ?? ''}
                      level={entry.proficiency ?? '—'}
                      state={adds[key] ?? 'idle'}
                      onAdd={() => {
                        void bankVocab(entry);
                      }}
                    />
                  );
                })}
              </ul>
            </div>
          ) : null}
          {(grammar?.length ?? 0) > 0 ? (
            <div className="km-resources__week-col">
              <Eyebrow className="km-resources__week-coltitle">Grammar</Eyebrow>
              <ul className="km-resources__suggest-list">
                {grammar?.map((pattern) => {
                  const key = `g:${grammarKey(pattern)}`;
                  return (
                    <SuggestRow
                      key={key}
                      kr={pattern.pattern}
                      en={pattern.title_en ?? pattern.pattern}
                      level={pattern.proficiency ?? '—'}
                      state={adds[key] ?? 'idle'}
                      onAdd={() => {
                        void bankGrammar(pattern);
                      }}
                    />
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

interface SuggestRowProps {
  kr: string;
  en: string;
  level: string;
  state: AddState;
  onAdd: () => void;
}

function SuggestRow({ kr, en, level, state, onAdd }: SuggestRowProps): JSX.Element {
  const added = state === 'added';
  const adding = state === 'adding';
  const label = added
    ? '✓ Added'
    : adding
      ? 'Adding…'
      : state === 'error'
        ? 'Retry'
        : 'Add';
  return (
    <li className="km-resources__suggest-row">
      <span className="kr km-resources__suggest-kr">{kr}</span>
      <span className="km-resources__suggest-en">{en}</span>
      <span className="km-pill km-pill--default km-resources__suggest-level">
        {level}
      </span>
      <Button
        variant={added ? 'ghost' : 'gold'}
        size="sm"
        onClick={onAdd}
        disabled={added || adding}
        aria-pressed={added}
        aria-label={added ? `${kr} added` : `Add ${kr}`}
      >
        {label}
      </Button>
    </li>
  );
}
