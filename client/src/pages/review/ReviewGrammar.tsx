/**
 * ReviewGrammar — `/review/grammar`, the Review library's grammar page.
 *
 * Overhaul P1.2, decision D3: this is the SINGLE grammar browse. It merges
 * the two pre-P1.2 browse surfaces:
 *   - the Reference page's Grammar tab (search + F-005 `domain`/`book_level`
 *     filters + the F-004 detail Sheet via the shared `KgiuDetailBody`), and
 *   - the LEARN Grammar screen's `list` tab, whose per-row **Bank** action
 *     moves here (that screen now drills only — banked + drill tabs).
 * So browsing AND banking live here; drilling/graduating stay on
 * `/learn/grammar`.
 *
 * Bank semantics (ported intact):
 *   - Body built by `kgiuBankBody` (lib/grammarBank) — the single choke
 *     point that coerces messy corpus rows into a schema-valid body, so a
 *     data quirk can never turn the tap into a 400.
 *   - Optimistic flip; a 409 means "already banked" → the post-condition
 *     holds, keep the flip. A real failure rewinds and surfaces fixed copy.
 *   - The banked set loads from `GET /grammar/bank` so already-banked rows
 *     render as "Banked" (reconciles with the LEARN screen's bank).
 *
 * Threat model: search input is user-controlled — server Zod-validates and
 * parameterises; strings render through React text children (a hostile
 * corpus row cannot escape into the DOM); bank POSTs ride the
 * `SameSite=Strict` session cookie; server prose is never echoed.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { Bilingual } from '../../components/Bilingual';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ErrorCard } from '../../components/ErrorCard';
import { Eyebrow } from '../../components/Eyebrow';
import { Icon } from '../../components/Icon';
import { KgiuDetailBody } from '../../components/KgiuDetailBody';
import { FilterGroup, SearchBox } from '../../components/LibraryControls';
import { LibrarySubnav } from '../../components/LibrarySubnav';
import { Sheet } from '../../components/Sheet';
import { Topbar } from '../../components/Topbar';
import { useDebouncedSearch } from '../../hooks/useDebouncedSearch';
import {
  DOMAIN_FILTERS,
  GRAMMAR_LEVEL_FILTERS,
  GRAMMAR_PAGE_SIZE,
  type DomainFilter,
  type LevelFilter,
} from '../../lib/libraryFilters';
import { errorMessageFor } from '../../lib/errorCopy';
import { grammarKey } from '../../lib/grammarKey';
import { kgiuBankBody } from '../../lib/grammarBank';
import * as grammarService from '../../services/grammar';
import { ApiError } from '../../services/api';
import type {
  KgiuEntryDetail,
  KgiuEntrySummary,
} from '../../types/domain';

/** A pattern is renderable/bankable only if its display string is non-blank. */
function hasPattern(p: KgiuEntrySummary): boolean {
  return p.pattern.trim().length > 0;
}

/** Fixed copy — ErrorCard's contract forbids echoing server message text. */
const BANK_ERROR_COPY = "Couldn't bank that pattern. Try again.";

export default function ReviewGrammar(): JSX.Element {
  const { input, q, setInput, clear } = useDebouncedSearch();
  const [rows, setRows] = useState<KgiuEntrySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // F-005 filters: genre (content_domain) + difficulty (book_level).
  const [domain, setDomain] = useState<DomainFilter>('all');
  const [level, setLevel] = useState<LevelFilter>('all');
  // F-004 detail Sheet: the tapped row paints the header immediately while
  // the full `GET /grammar/kgiu/:id` detail resolves underneath.
  const [openRow, setOpenRow] = useState<KgiuEntrySummary | null>(null);
  const [detail, setDetail] = useState<KgiuEntryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  // Id of the row whose detail fetch is authoritative — a slow settle for a
  // previously tapped row must not paint over the currently open one.
  const detailIdRef = useRef<number | null>(null);

  // Banked pattern keys (server view + optimistic adds merged into one set).
  // Loads best-effort: a failed bank-list fetch leaves every row bankable —
  // the server's idempotent bank path (409 → already banked) keeps a
  // duplicate tap harmless.
  const [banked, setBanked] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [bankError, setBankError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void grammarService
      .listBanked()
      .then((res) => {
        if (!alive) return;
        setBanked((prev) => {
          const merged = new Set(prev);
          for (const e of res.entries) merged.add(e.pattern_key);
          return merged;
        });
      })
      .catch(() => {
        // Best-effort — see note above.
      });
    return () => {
      alive = false;
    };
  }, []);

  const load = useCallback(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    setLoading(true);
    setError(null);
    grammarService
      .listPatterns(
        {
          ...(q ? { q } : {}),
          ...(domain !== 'all' ? { domain } : {}),
          ...(level !== 'all' ? { book_level: level } : {}),
          limit: GRAMMAR_PAGE_SIZE,
        },
        ctrl.signal,
      )
      .then((entries) => {
        if (ctrl.signal.aborted) return;
        // Defensive: skip blank-pattern rows (post-F1 the server already
        // excludes them; a blank row would render an empty Korean cell).
        setRows(entries.filter(hasPattern));
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(errorMessageFor(err, 'Could not load grammar.'));
        setLoading(false);
      });
  }, [q, domain, level]);

  useEffect(() => {
    // Fetch on mount / query change. The set-state-in-effect rule only flags
    // a DIRECT setState in an effect body; `load()` is a function call (its
    // setState runs inside the async fetch), so no disable directive needed.
    load();
    return () => {
      ctrlRef.current?.abort();
    };
  }, [load]);

  // F-004: open the detail Sheet for a tapped pattern. The header renders
  // from the row while the detail loads, and a failure surfaces an inline
  // ErrorCard with Retry rather than closing the Sheet.
  const openDetail = useCallback(async (row: KgiuEntrySummary): Promise<void> => {
    detailIdRef.current = row.id;
    setOpenRow(row);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const d = await grammarService.getPattern(row.id);
      if (detailIdRef.current !== row.id) return; // superseded by a newer tap
      setDetail(d);
    } catch (err) {
      if (detailIdRef.current !== row.id) return;
      setDetailError(errorMessageFor(err, 'Detail unavailable'));
    } finally {
      if (detailIdRef.current === row.id) setDetailLoading(false);
    }
  }, []);

  const closeDetail = useCallback((): void => {
    detailIdRef.current = null;
    setOpenRow(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  }, []);

  /**
   * Bank a pattern (the action the LEARN Grammar list tab used to own).
   * Optimistic: the chip flips immediately; a 409 (already banked) keeps the
   * flip — the post-condition holds; any other failure rewinds + surfaces
   * fixed copy.
   */
  const bank = useCallback(
    async (row: KgiuEntrySummary): Promise<void> => {
      const key = grammarKey(row);
      if (banked.has(key)) return;
      setPendingKey(key);
      setBankError(null);
      setBanked((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      try {
        await grammarService.bankPattern(kgiuBankBody(row));
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // Already banked — keep the optimistic flip.
        } else {
          setBanked((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
          setBankError(BANK_ERROR_COPY);
        }
      } finally {
        setPendingKey(null);
      }
    },
    [banked],
  );

  const openKey = openRow ? grammarKey(openRow) : null;

  return (
    <section
      className="screen km-reference km-resources"
      aria-labelledby="km-review-grammar-title"
    >
      <Topbar
        krTitle="문법"
        title="Grammar"
        titleId="km-review-grammar-title"
        eyebrow={<Bilingual en="Review library" kr="복습 자료실" />}
      />

      <LibrarySubnav />

      <div className="km-resources__panel">
        <SearchBox
          value={input}
          onChange={setInput}
          onClear={clear}
          placeholder="Search all grammar patterns"
          ariaLabel="Search grammar"
        />
        <FilterGroup
          ariaLabel="Filter grammar by topic"
          options={DOMAIN_FILTERS}
          value={domain}
          onChange={setDomain}
        />
        <FilterGroup
          ariaLabel="Filter grammar by level"
          options={GRAMMAR_LEVEL_FILTERS}
          value={level}
          onChange={setLevel}
        />
        {/* Hidden while the last fetch errored — the count would otherwise
            describe the STALE row set under the new filter/search. */}
        {error === null ? (
          <div className="km-reference__count">
            <Bilingual
              en={`${String(rows.length)} pattern${rows.length === 1 ? '' : 's'}`}
              kr={`문형 ${String(rows.length)}개`}
              compact
            />
          </div>
        ) : null}
        {bankError ? <ErrorCard message={bankError} /> : null}
        {loading && rows.length === 0 ? (
          <div className="km-grammar__state" role="status">
            <Bilingual en="Loading patterns…" kr="문형을 불러오는 중…" />
          </div>
        ) : error ? (
          // Always surface a failed fetch — a filter/search change that
          // errors must not leave the previous rows rendering as if they
          // matched the new filter.
          <ErrorCard message={error} onRetry={load} />
        ) : rows.length === 0 ? (
          <p className="km-reference__empty">
            <Bilingual en="No patterns match." kr="맞는 문형이 없어요." />
          </p>
        ) : (
          <Card className="km-reference__list" variant="flat">
            <ul>
              {rows.map((p) => {
                const key = grammarKey(p);
                const isBanked = banked.has(key);
                const pending = pendingKey === key;
                return (
                  <li key={`grammar:${String(p.id)}`} className="km-reference__row">
                    <div className="km-resources__list-row">
                      <button
                        type="button"
                        className="km-resources__list-open focusring"
                        onClick={() => {
                          void openDetail(p);
                        }}
                        aria-label={`${p.pattern} ${p.title_en ?? p.pattern}`}
                      >
                        <span className="kr km-reference__row-kr">{p.pattern}</span>
                        <span className="km-reference__row-en">
                          {p.title_en ?? p.pattern}
                        </span>
                        <span className="km-pill km-pill--default km-reference__row-level">
                          {p.proficiency ?? '—'}
                        </span>
                      </button>
                      <Button
                        variant={isBanked ? 'ghost' : 'gold'}
                        size="sm"
                        onClick={() => {
                          void bank(p);
                        }}
                        disabled={isBanked || pending}
                        aria-pressed={isBanked}
                        aria-label={
                          isBanked ? 'Already banked' : `Bank ${p.pattern}`
                        }
                      >
                        {isBanked ? (
                          <Bilingual en="Banked" kr="담김" compact />
                        ) : pending ? (
                          <Bilingual en="Banking…" kr="담는 중…" compact />
                        ) : (
                          <Bilingual en="Bank" kr="담기" compact />
                        )}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        <GrammarDetailSheet
          row={openRow}
          detail={detail}
          loading={detailLoading}
          error={detailError}
          banked={openKey !== null && banked.has(openKey)}
          pending={openKey !== null && pendingKey === openKey}
          onBank={() => {
            if (openRow) void bank(openRow);
          }}
          onRetry={() => {
            if (openRow) void openDetail(openRow);
          }}
          onClose={closeDetail}
        />
      </div>
    </section>
  );
}

interface GrammarDetailSheetProps {
  /** The tapped list row (paints the header instantly); null = closed. */
  row: KgiuEntrySummary | null;
  detail: KgiuEntryDetail | null;
  loading: boolean;
  error: string | null;
  banked: boolean;
  pending: boolean;
  onBank: () => void;
  onRetry: () => void;
  onClose: () => void;
}

/**
 * Pattern-detail Sheet (F-004) — the shared `KgiuDetailBody` detail surface
 * (explanation, formation rules, examples, dialogues, unit from
 * `GET /grammar/kgiu/:id` — F-018), plus the Bank action this page owns now
 * that it is the single browse (D3). All strings render through React text
 * children — a hostile corpus row cannot escape into the DOM.
 */
function GrammarDetailSheet({
  row,
  detail,
  loading,
  error,
  banked,
  pending,
  onBank,
  onRetry,
  onClose,
}: GrammarDetailSheetProps): JSX.Element {
  return (
    <Sheet open={row !== null} onClose={onClose} ariaLabel="Grammar pattern detail">
      <div className="km-review__sheetBody">
        <div className="km-review__sheetHead">
          <div>
            <Eyebrow>
              <Bilingual en="Pattern" kr="문형" />
            </Eyebrow>
            <div className="kr-display km-review__sheetTitle">
              {row?.pattern ?? ''}
            </div>
            <div className="km-review__sheetMeta">
              {row?.title_en ?? row?.pattern ?? ''}
              {row?.proficiency ? ` · ${row.proficiency}` : ''}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close pattern detail"
          >
            <Icon name="close" size={14} />
          </Button>
        </div>

        <div className="km-review__sheetActions">
          <Button
            variant={banked ? 'ghost' : 'gold'}
            size="md"
            onClick={onBank}
            disabled={banked || pending || row === null}
            aria-pressed={banked}
            leadingIcon={<Icon name="plus" size={14} />}
          >
            {banked ? (
              <Bilingual en="Already banked" kr="이미 담김" />
            ) : pending ? (
              <Bilingual en="Banking…" kr="담는 중…" />
            ) : (
              <Bilingual en="Bank pattern" kr="문형 담기" />
            )}
          </Button>
        </div>

        <hr className="hr-double km-review__sheetRule" />

        {loading ? (
          <div className="km-grammar__state" role="status">
            <Bilingual en="Loading detail…" kr="상세 정보를 불러오는 중…" />
          </div>
        ) : null}
        {error ? <ErrorCard message={error} onRetry={onRetry} /> : null}
        {detail && !loading ? <KgiuDetailBody detail={detail} /> : null}
      </div>
    </Sheet>
  );
}
