/**
 * ReviewGrammar — `/review/grammar`, the Review library's grammar page.
 *
 * Phase 3B rework (F-054/F-055/F-056/F-024) of the P1.2 single grammar
 * browse (decision D3 — browsing AND banking live here; drilling/graduating
 * stay on `/learn/grammar`):
 *   - F-054: the Vocabulary/Dictionary section strip, the search-all box,
 *     and the genre (`domain`) filter are REMOVED — grammar is a small
 *     (~370-row) corpus that has no genre axis, and the old `q` param was an
 *     exact-match, not a search, server-side.
 *   - F-055: difficulty (`book_level`) is the one remaining filter, as a
 *     labelled `FilterSelect` dropdown (native `<select>` a11y contract).
 *   - F-024: a `BackButton` to `/review` replaces the removed section strip
 *     as the way back up to the library index.
 *   - F-056: an "Uploads" view lists the user's grammar-from-uploads,
 *     grouped by source book. Wired to REAL endpoints (`GET /uploads` +
 *     `GET /grammar/kgiu?source_upload_id=` — the U3a ownership-guarded
 *     filter), but U2's extraction does not yet populate
 *     `kgiu_entries.source_upload_id`, so every group is empty today and
 *     the view renders its honest empty state until U2 lands.
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
 * Threat model: no free-text input remains on this page (the search box is
 * gone); filter values are closed vocabularies from our own constants, and
 * upload ids originate from a prior authenticated server response — the
 * server re-validates and ownership-guards both. Strings render through
 * React text children (a hostile corpus row or upload title cannot escape
 * into the DOM); bank POSTs ride the `SameSite=Strict` session cookie;
 * server prose is never echoed.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { BackButton } from '../../components/BackButton';
import { Bilingual } from '../../components/Bilingual';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ErrorCard } from '../../components/ErrorCard';
import { Eyebrow } from '../../components/Eyebrow';
import { FilterSelect } from '../../components/FilterSelect';
import { Icon } from '../../components/Icon';
import { KgiuDetailBody } from '../../components/KgiuDetailBody';
import { Sheet } from '../../components/Sheet';
import { ALL_SOURCES, SourceFilterRow } from '../../components/SourceFilterRow';
import { Topbar } from '../../components/Topbar';
import {
  GRAMMAR_LEVEL_FILTERS,
  GRAMMAR_PAGE_SIZE,
  type LevelFilter,
} from '../../lib/libraryFilters';
import { errorMessageFor } from '../../lib/errorCopy';
import { grammarKey } from '../../lib/grammarKey';
import { kgiuBankBody } from '../../lib/grammarBank';
import * as grammarService from '../../services/grammar';
import { listUploads } from '../../services/uploads';
import { ApiError } from '../../services/api';
import type {
  BookUpload,
  KgiuEntryDetail,
  KgiuEntrySummary,
} from '../../types/domain';
import './ReviewGrammar.css';

/** A pattern is renderable/bankable only if its display string is non-blank. */
function hasPattern(p: KgiuEntrySummary): boolean {
  return p.pattern.trim().length > 0;
}

/** Fixed copy — ErrorCard's contract forbids echoing server message text. */
const BANK_ERROR_COPY = "Couldn't bank that pattern. Try again.";

/**
 * F-055 dropdown options — the shared level vocabulary minus its `'all'`
 * sentinel: `FilterSelect` reserves the empty-string placeholder option for
 * the "everything" state, so `'all'` must not also appear as a real option.
 */
const LEVEL_OPTIONS = GRAMMAR_LEVEL_FILTERS.filter((f) => f.id !== 'all').map(
  (f) => ({ value: f.id, label: f.label }),
);

/**
 * Narrow a `FilterSelect` change value (an arbitrary string at the DOM
 * boundary) back onto the closed `LevelFilter` vocabulary. The placeholder's
 * `''` — and any out-of-vocabulary value — maps to `'all'`, which omits the
 * query param entirely.
 */
function toLevelFilter(value: string): LevelFilter {
  const match = GRAMMAR_LEVEL_FILTERS.find((f) => f.id === value);
  return match ? match.id : 'all';
}

type View = 'browse' | 'uploads';

const VIEWS: ReadonlyArray<{ id: View; label: string; kr: string }> = [
  { id: 'browse', label: 'Browse', kr: '둘러보기' },
  { id: 'uploads', label: 'Uploads', kr: '업로드' },
];

export default function ReviewGrammar(): JSX.Element {
  const [view, setView] = useState<View>('browse');

  // F-004 detail Sheet: the tapped row paints the header immediately while
  // the full `GET /grammar/kgiu/:id` detail resolves underneath. Page-level
  // (not per-view) so a row tapped in EITHER view opens the same Sheet.
  const [openRow, setOpenRow] = useState<KgiuEntrySummary | null>(null);
  const [detail, setDetail] = useState<KgiuEntryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
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

      {/* F-024 — the section strip (Vocabulary/Dictionary links) is gone
          (F-054), so this nested sub-page's way back up to the library
          index is an explicit, deterministic BackButton. */}
      <BackButton
        to="/review"
        label="Review library"
        className="km-review-grammar__back"
      />

      <div
        className="km-review__tabs km-resources__tabs"
        role="tablist"
        aria-label="Grammar section"
      >
        {VIEWS.map((v) => {
          const selected = view === v.id;
          return (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={`km-review__tab focusring${selected ? ' km-review__tab--active' : ''}`}
              onClick={() => {
                setView(v.id);
              }}
            >
              <Bilingual en={v.label} kr={v.kr} compact />
            </button>
          );
        })}
      </div>

      {bankError ? <ErrorCard message={bankError} /> : null}

      {view === 'browse' ? (
        <GrammarBrowse
          banked={banked}
          pendingKey={pendingKey}
          onOpen={openDetail}
          onBank={bank}
        />
      ) : (
        <GrammarUploads
          banked={banked}
          pendingKey={pendingKey}
          onOpen={openDetail}
          onBank={bank}
        />
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
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Shared row + bank-action props (Browse and Uploads render the
// same row anatomy against the page-level bank/detail state)
// ─────────────────────────────────────────────────────────────

interface RowActionProps {
  banked: ReadonlySet<string>;
  pendingKey: string | null;
  onOpen: (row: KgiuEntrySummary) => Promise<void>;
  onBank: (row: KgiuEntrySummary) => Promise<void>;
}

interface PatternRowProps extends RowActionProps {
  row: KgiuEntrySummary;
}

function PatternRow({
  row,
  banked,
  pendingKey,
  onOpen,
  onBank,
}: PatternRowProps): JSX.Element {
  const key = grammarKey(row);
  const isBanked = banked.has(key);
  const pending = pendingKey === key;
  return (
    <li className="km-reference__row">
      <div className="km-resources__list-row">
        <button
          type="button"
          className="km-resources__list-open focusring"
          onClick={() => {
            void onOpen(row);
          }}
          aria-label={`${row.pattern} ${row.title_en ?? row.pattern}`}
        >
          <span className="kr km-reference__row-kr">{row.pattern}</span>
          <span className="km-reference__row-en">
            {row.title_en ?? row.pattern}
          </span>
          <span className="km-pill km-pill--default km-reference__row-level">
            {row.proficiency ?? '—'}
          </span>
        </button>
        <Button
          variant={isBanked ? 'ghost' : 'gold'}
          size="sm"
          onClick={() => {
            void onBank(row);
          }}
          disabled={isBanked || pending}
          aria-pressed={isBanked}
          aria-label={isBanked ? 'Already banked' : `Bank ${row.pattern}`}
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
}

// ─────────────────────────────────────────────────────────────
// Browse — the KGIU corpus, difficulty dropdown (F-055) + the U1
// sort-by-source row. Search + genre are gone (F-054).
// ─────────────────────────────────────────────────────────────

function GrammarBrowse({
  banked,
  pendingKey,
  onOpen,
  onBank,
}: RowActionProps): JSX.Element {
  const [rows, setRows] = useState<KgiuEntrySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Monotonic reload trigger so Retry re-runs the fetch effect without
  // changing the filters (same pattern as ReviewVocab's browse).
  const [reloadTick, setReloadTick] = useState(0);
  // F-055: difficulty (book_level) is the single remaining filter.
  const [level, setLevel] = useState<LevelFilter>('all');
  // U1 scaffolding — sort-by-source filter (see SourceFilterRow's header
  // doc). Inert until U2 tags kgiu_entries with source_upload_id.
  const [source, setSource] = useState<string>(ALL_SOURCES);

  useEffect(() => {
    const ctrl = new AbortController();
    // Sync-to-external-system (a network fetch) — the same exception
    // useEndpointOrMock documents for its kickoff setState.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    grammarService
      .listPatterns(
        {
          ...(level !== 'all' ? { book_level: level } : {}),
          ...(source !== ALL_SOURCES ? { source_upload_id: source } : {}),
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
    return () => {
      ctrl.abort();
    };
  }, [level, source, reloadTick]);

  const retry = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  return (
    <div className="km-resources__panel">
      <FilterSelect
        label="Difficulty"
        options={LEVEL_OPTIONS}
        value={level === 'all' ? '' : level}
        onChange={(next) => {
          setLevel(toLevelFilter(next));
        }}
        placeholder="All levels"
        className="km-review-grammar__level"
      />
      <SourceFilterRow
        ariaLabel="Filter grammar by source book"
        value={source}
        onChange={setSource}
      />
      {/* Hidden while the last fetch errored — the count would otherwise
          describe the STALE row set under the new filter. */}
      {error === null ? (
        <div className="km-reference__count">
          <Bilingual
            en={`${String(rows.length)} pattern${rows.length === 1 ? '' : 's'}`}
            kr={`문형 ${String(rows.length)}개`}
            compact
          />
        </div>
      ) : null}
      {loading && rows.length === 0 ? (
        <div className="km-grammar__state" role="status">
          <Bilingual en="Loading patterns…" kr="문형을 불러오는 중…" />
        </div>
      ) : error ? (
        // Always surface a failed fetch — a filter change that errors must
        // not leave the previous rows rendering as if they matched the new
        // filter.
        <ErrorCard message={error} onRetry={retry} />
      ) : rows.length === 0 ? (
        <p className="km-reference__empty">
          <Bilingual en="No patterns match." kr="맞는 문형이 없어요." />
        </p>
      ) : (
        <Card className="km-reference__list" variant="flat">
          <ul>
            {rows.map((p) => (
              <PatternRow
                key={`grammar:${String(p.id)}`}
                row={p}
                banked={banked}
                pendingKey={pendingKey}
                onOpen={onOpen}
                onBank={onBank}
              />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Uploads (F-056) — the user's grammar-from-uploads, grouped by
// source book. Real endpoints; empty until U2's extraction tags
// kgiu_entries.source_upload_id (see the file header).
// ─────────────────────────────────────────────────────────────

interface UploadGrammarGroup {
  upload: BookUpload;
  rows: KgiuEntrySummary[];
}

function GrammarUploads({
  banked,
  pendingKey,
  onOpen,
  onBank,
}: RowActionProps): JSX.Element {
  const [groups, setGroups] = useState<UploadGrammarGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Monotonic reload trigger so Retry re-runs the fetch effect.
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    // Sync-to-external-system (a network fetch) — the same exception
    // useEndpointOrMock documents for its kickoff setState.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    void (async () => {
      // Only READY uploads can carry extracted grammar (processing/failed
      // books have no curated content yet).
      const ready = (await listUploads(ctrl.signal)).filter(
        (u) => u.status === 'ready',
      );
      // One ownership-guarded query per ready upload (U3a). The personal
      // corpus holds a handful of books, so a fan-out here is bounded and
      // keeps the server contract simple. Promise.all (not allSettled): a
      // partial result would silently misrepresent a book as grammar-free,
      // so any failure falls through to the single error+Retry surface.
      const fetched = await Promise.all(
        ready.map(async (upload) => ({
          upload,
          rows: (
            await grammarService.listPatterns(
              { source_upload_id: upload.id, limit: GRAMMAR_PAGE_SIZE },
              ctrl.signal,
            )
          ).filter(hasPattern),
        })),
      );
      if (ctrl.signal.aborted) return;
      // Only grammar-bearing uploads render as groups (F-056).
      setGroups(fetched.filter((g) => g.rows.length > 0));
      setLoading(false);
    })().catch((err: unknown) => {
      if (ctrl.signal.aborted) return;
      if (err instanceof ApiError && err.code === 'canceled') return;
      setError(errorMessageFor(err, 'Could not load your uploads.'));
      setLoading(false);
    });
    return () => {
      ctrl.abort();
    };
  }, [reloadTick]);

  const retry = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  return (
    <div className="km-resources__panel">
      {loading ? (
        <div className="km-grammar__state" role="status">
          <Bilingual en="Loading your uploads…" kr="업로드를 불러오는 중…" />
        </div>
      ) : error ? (
        <ErrorCard message={error} onRetry={retry} />
      ) : groups.length === 0 ? (
        <p className="km-reference__empty">
          <Bilingual
            en="No grammar from your uploads yet. Patterns extracted from your books will appear here, grouped by book."
            kr="아직 업로드에서 추출된 문법이 없어요. 책에서 추출된 문형이 책별로 여기에 표시돼요."
          />
        </p>
      ) : (
        groups.map((group) => (
          <section
            key={`upload:${group.upload.id}`}
            className="km-review-grammar__group"
            aria-labelledby={`km-rg-upload-${group.upload.id}`}
          >
            <h2
              id={`km-rg-upload-${group.upload.id}`}
              className="km-review-grammar__group-title"
            >
              <span className="km-review-grammar__group-name">
                {group.upload.title}
              </span>
              <span className="km-review-grammar__group-count">
                <Bilingual
                  en={`${String(group.rows.length)} pattern${group.rows.length === 1 ? '' : 's'}`}
                  kr={`문형 ${String(group.rows.length)}개`}
                  compact
                />
              </span>
            </h2>
            <Card className="km-reference__list" variant="flat">
              <ul>
                {group.rows.map((p) => (
                  <PatternRow
                    key={`upload:${group.upload.id}:${String(p.id)}`}
                    row={p}
                    banked={banked}
                    pendingKey={pendingKey}
                    onOpen={onOpen}
                    onBank={onBank}
                  />
                ))}
              </ul>
            </Card>
          </section>
        ))
      )}
    </div>
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
