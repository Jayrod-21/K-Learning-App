/**
 * ReadingPicker — a bottom Sheet for choosing which reading passage to load.
 *
 * The Reading screen used to hard-load the first TTMIK lesson and nothing
 * else, stranding 2,742 TTMIK + 11,162 Iyagi sentences behind a wall. This
 * picker opens the whole corpus: a corpus segmented control (TTMIK lessons ‖
 * Iyagi episodes), a paginated unit list, and a Prev/Next pager driven by the
 * server's real `total`. Tapping a unit fires `onSelect({ corpus, unitId })`
 * and closes — the parent then refetches the passage and persists the pick.
 *
 * Why a Sheet, not an always-visible panel: the passage is the screen's
 * focus; the picker is an occasional act ("read something else"). Mirroring
 * `ListDetailSheet` / `AddToListSheet` keeps the drawer language consistent.
 *
 * State model:
 *   - `corpus` — which corpus tab is active. Resets the unit list + pager.
 *   - `offset` — page offset into the active corpus; reset to 0 on a corpus
 *     switch so the pager never points past a shorter corpus.
 *   - The fetch is its own keyed effect (corpus + offset + a reload tick),
 *     aborting the previous in-flight call so a fast corpus toggle never
 *     paints a stale page over a newer one — the same abort discipline the
 *     Resources tabs use.
 *
 * A11y: the corpus control is a `radiogroup` of segmented buttons (mirrors
 * the Review tabs); each unit is a full-width button with an accessible name
 * that includes its level/episode so a screen-reader user can tell rows apart.
 *
 * Threat model:
 *   - Unit titles are server-owned corpus text, rendered as React children
 *     (escaped) — never `innerHTML`. A hostile corpus row can't escape the DOM.
 *   - The list call is GET (no CSRF surface); the parent owns the session
 *     cookie. We never echo server error text raw beyond a fixed fallback.
 *   - `unitId` flows back to the parent as a number only — no free-form path
 *     concatenation here or downstream in `fetchSentences`.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Sheet } from './Sheet';
import { Card } from './Card';
import { Button } from './Button';
import { Eyebrow } from './Eyebrow';
import { Icon } from './Icon';
import { ErrorCard } from './ErrorCard';
import { fetchUnitsPage } from '../services/reading';
import { ApiError } from '../services/api';
import { DEFAULT_READING_CORPUS } from '../lib/readingSelection';
import type {
  ReadingCorpus,
  ReadingSelection,
  ReadingUnit,
} from '../types/domain';

/** Page size for the unit list. One screenful of rows without a tall sheet. */
const PAGE_SIZE = 20;

// Iyagi first — it is the default corpus (B-001), so the default tab leads.
const CORPORA: ReadonlyArray<{ id: ReadingCorpus; label: string }> = [
  { id: 'iyagi', label: 'Iyagi' },
  { id: 'ttmik', label: 'TTMIK' },
];

export interface ReadingPickerProps {
  /** Whether the picker sheet is open. */
  open: boolean;
  /** Fires when Esc / backdrop / Cancel closes the sheet. */
  onClose: () => void;
  /** The currently-loaded selection, so the open tab + active row reflect it. */
  current: ReadingSelection | null;
  /** Fires with the chosen unit; the parent loads + persists it, then closes. */
  onSelect: (selection: ReadingSelection) => void;
}

/**
 * A human label for a unit row — `Lesson 3 · Level 1` for TTMIK, `Episode 12`
 * for Iyagi, falling back to nothing when the metadata is absent so the row
 * still renders its title.
 */
function unitMeta(unit: ReadingUnit): string {
  if (unit.lesson_number !== undefined) {
    const level =
      unit.lesson_level !== undefined ? ` · Level ${String(unit.lesson_level)}` : '';
    return `Lesson ${String(unit.lesson_number)}${level}`;
  }
  if (unit.episode_number !== undefined) {
    return `Episode ${String(unit.episode_number)}`;
  }
  return '';
}

export function ReadingPicker({
  open,
  onClose,
  current,
  onSelect,
}: ReadingPickerProps): JSX.Element {
  // The active corpus tab. Seeds from the current selection so reopening the
  // picker lands on the corpus the user is reading, defaulting to the same
  // prose corpus the screen itself defaults to (B-001).
  const [corpus, setCorpus] = useState<ReadingCorpus>(
    current?.corpus ?? DEFAULT_READING_CORPUS,
  );
  const [offset, setOffset] = useState(0);
  const [units, setUnits] = useState<ReadingUnit[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Monotonic reload trigger so Retry re-runs the fetch without a corpus or
  // offset change.
  const [reloadTick, setReloadTick] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);

  // Reset to the first page whenever the corpus changes so the pager never
  // points past a shorter corpus. Sync-to-derived-state on a key change — the
  // documented exception the Resources tabs use.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOffset(0);
  }, [corpus]);

  // Fetch a page of units. Only runs while the sheet is open so a closed
  // picker holds no network cost; the abort guard drops a stale page.
  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    // Sync-to-external-system (network fetch) — same exception the Resources
    // tabs document for their kickoff setState.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    fetchUnitsPage({ corpus, limit: PAGE_SIZE, offset })
      .then((page) => {
        if (ctrl.signal.aborted) return;
        setUnits(page.units);
        setTotal(page.total);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(
          err instanceof ApiError ? err.message : 'Could not load lessons.',
        );
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [open, corpus, offset, reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  const from = total === 0 ? 0 : offset + 1;
  const to = offset + units.length;
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <Sheet open={open} onClose={onClose} ariaLabel="Choose a reading passage">
      <div className="km-review__sheetBody">
        <div className="km-review__sheetHead">
          <div>
            <Eyebrow>읽기 · Passages</Eyebrow>
            <div className="kr-display km-review__sheetTitle">Choose a passage</div>
            <div className="km-review__sheetMeta">
              {total > 0 ? `${String(from)}–${String(to)} of ${String(total)}` : ''}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close passage picker"
          >
            <Icon name="close" size={14} />
          </Button>
        </div>

        <div
          className="km-review__tabs"
          role="radiogroup"
          aria-label="Corpus"
        >
          {CORPORA.map((c) => {
            const selected = corpus === c.id;
            return (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`km-review__tab focusring${selected ? ' km-review__tab--active' : ''}`}
                onClick={() => {
                  setCorpus(c.id);
                }}
              >
                {c.label}
              </button>
            );
          })}
        </div>

        <hr className="hr-double km-review__sheetRule" />

        {loading && units.length === 0 ? (
          <div className="km-grammar__state" role="status">
            Loading lessons…
          </div>
        ) : error && units.length === 0 ? (
          <ErrorCard message={error} onRetry={refetch} />
        ) : units.length === 0 ? (
          <p className="km-reference__empty">No lessons available yet.</p>
        ) : (
          <>
            <Card className="km-reference__list" variant="flat">
              <ul>
                {units.map((unit) => {
                  const meta = unitMeta(unit);
                  const active =
                    current?.corpus === corpus && current.unitId === unit.id;
                  return (
                    <li
                      key={`unit:${corpus}:${String(unit.id)}`}
                      className="km-reference__row"
                    >
                      <button
                        type="button"
                        className="km-resources__list-open focusring"
                        aria-current={active ? 'true' : undefined}
                        aria-label={
                          meta ? `${unit.title} — ${meta}` : unit.title
                        }
                        onClick={() => {
                          onSelect({
                            corpus,
                            unitId: unit.id,
                            title: unit.title,
                          });
                        }}
                      >
                        <span className="kr km-reference__row-kr">
                          {unit.title}
                        </span>
                        {meta ? (
                          <span className="km-reference__row-en">{meta}</span>
                        ) : (
                          <span className="km-reference__row-en" />
                        )}
                        {active ? (
                          <span className="km-pill km-pill--default">
                            Current
                          </span>
                        ) : (
                          <Icon name="chevron-right" size={16} />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Card>
            <div className="km-resources__pager">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOffset((o) => Math.max(0, o - PAGE_SIZE));
                }}
                disabled={!hasPrev}
              >
                Prev
              </Button>
              <span className="km-resources__pager-count">
                {String(from)}–{String(to)} of {String(total)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOffset((o) => o + PAGE_SIZE);
                }}
                disabled={!hasNext}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
