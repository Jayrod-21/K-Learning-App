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
 *     filter), but the U2 extraction pipeline (ticket F-108) does not yet
 *     populate `kgiu_entries.source_upload_id`, so every group is empty
 *     today and the view renders its honest empty state until F-108 lands.
 *     (USER-SAVED grammar provenance — the F-053 twin — is the separate
 *     ticket F-107.)
 *
 * Mastery semantics (F-152 — "Bank/banked" copy retired, action renamed
 * "Mastered"; the underlying model/endpoints are untouched, F-063 already
 * reworked those):
 *   - Body built by `kgiuBankBody` (lib/grammarBank) — the single choke
 *     point that coerces messy corpus rows into a schema-valid body, so a
 *     data quirk can never turn the tap into a 400.
 *   - Optimistic flip; a 409 means "already mastered" → the post-condition
 *     holds, keep the flip. A real failure rewinds and surfaces fixed copy.
 *   - The mastered set loads from `GET /grammar/bank` so already-mastered
 *     rows render as "Mastered" (reconciles with the LEARN screen's bank).
 *
 * F-128 reskin — each pattern is its own `CityCard` signboard/hanji-paper
 * row (device #1) with a `DancheongRail` leading edge (device #2, via the
 * card's `rail` prop) instead of one flat list `Card`; a mastered row's
 * action carries a milestone `SealStamp` (device #7 — "a mastered item" is
 * one of the doc's own named seal-stamp use cases). The page root gets the
 * ambient `.km-rain-sheen` (device #8, Night-only per its own CSS gate) and
 * the Uploads empty state carries `.km-giwa`/`.km-hangul-watermark`
 * (devices #3/#6), matching Progress's precedent.
 *
 * F-153 — the browse list (and each Uploads group) windows 15 rows at a
 * time via the shared `usePagination` + `ShowMore` primitives, uncapped
 * (`max: Infinity`) so "Show more" keeps revealing the small (~370-row)
 * corpus instead of hard-stopping at the primitives' default 30-row ceiling
 * built for larger corpora. A filter change resets the window to 15.
 *
 * Threat model: no free-text input remains on this page (the search box is
 * gone); filter values are closed vocabularies from our own constants, and
 * upload ids originate from a prior authenticated server response — the
 * server re-validates and ownership-guards both. Strings render through
 * React text children (a hostile corpus row or upload title cannot escape
 * into the DOM); mastery POSTs ride the `SameSite=Strict` session cookie;
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
import { CityCard } from '../../components/CityCard';
import { ErrorCard } from '../../components/ErrorCard';
import { Eyebrow } from '../../components/Eyebrow';
import { FilterSelect } from '../../components/FilterSelect';
import { Icon } from '../../components/Icon';
import { KgiuDetailBody } from '../../components/KgiuDetailBody';
import { SealStamp } from '../../components/SealStamp';
import { Sheet } from '../../components/Sheet';
import { ShowMore } from '../../components/ShowMore';
import { ALL_SOURCES, SourceFilterRow } from '../../components/SourceFilterRow';
import { Tabs } from '../../components/Tabs';
import { Topbar } from '../../components/Topbar';
import { usePagination } from '../../hooks/usePagination';
import {
  GRAMMAR_LEVEL_FILTERS,
  GRAMMAR_PAGE_SIZE,
  type LevelFilter,
} from '../../lib/libraryFilters';
import { errorMessageFor } from '../../lib/errorCopy';
import { navItem } from '../../lib/nav';
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

/** Parent-tab name source — nav.ts owns the en/kr pair (F-043 renamed the
 *  tab to "Library"), so the eyebrow and back label can never go stale. */
const LIBRARY_NAV = navItem('review');

/** A pattern is renderable/bankable only if its display string is non-blank. */
function hasPattern(p: KgiuEntrySummary): boolean {
  return p.pattern.trim().length > 0;
}

/** Fixed copy — ErrorCard's contract forbids echoing server message text. */
const MASTERY_ERROR_COPY = "Couldn't mark that pattern mastered. Try again.";

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

  // Mastered pattern keys (server view + optimistic adds merged into one
  // set). Loads best-effort: a failed fetch leaves every row markable — the
  // server's idempotent bank path (409 → already mastered) keeps a
  // duplicate tap harmless.
  const [mastered, setMastered] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [masteryError, setMasteryError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void grammarService
      .listBanked()
      .then((res) => {
        if (!alive) return;
        setMastered((prev) => {
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
   * Mark a pattern mastered (F-152 — the action the LEARN Grammar list tab
   * used to own, and used to call "Bank"). Optimistic: the chip flips
   * immediately; a 409 (already mastered) keeps the flip — the
   * post-condition holds; any other failure rewinds + surfaces fixed copy.
   */
  const markMastered = useCallback(
    async (row: KgiuEntrySummary): Promise<void> => {
      const key = grammarKey(row);
      if (mastered.has(key)) return;
      setPendingKey(key);
      setMasteryError(null);
      setMastered((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      try {
        await grammarService.bankPattern(kgiuBankBody(row));
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // Already mastered — keep the optimistic flip.
        } else {
          setMastered((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
          setMasteryError(MASTERY_ERROR_COPY);
        }
      } finally {
        setPendingKey(null);
      }
    },
    [mastered],
  );

  const openKey = openRow ? grammarKey(openRow) : null;

  return (
    <section
      className="screen km-reference km-resources km-rain-sheen"
      aria-labelledby="km-review-grammar-title"
    >
      <Topbar
        krTitle="문법"
        title="Grammar"
        titleId="km-review-grammar-title"
        eyebrow={<Bilingual en={LIBRARY_NAV.label} kr={LIBRARY_NAV.kr} />}
      />

      {/* F-024 — the section strip (Vocabulary/Dictionary links) is gone
          (F-054), so this nested sub-page's way back up to the library
          index is an explicit, deterministic BackButton. */}
      <BackButton
        to="/review"
        label={LIBRARY_NAV.label}
        className="km-review-grammar__back"
      />

      {/* Mastery failures surface page-level (the action exists in BOTH
          views and in the detail Sheet), above the tabbed area so the
          re-keyed tabpanel never unmounts the message mid-read. */}
      {masteryError ? <ErrorCard message={masteryError} /> : null}

      {/* Browse/Uploads switch — the shared Tabs primitive (F-032), which
          delivers the full W3C APG tabs contract (roving tabindex, Arrow/
          Home/End keys, labelled tabpanel) that a hand-rolled
          role="tablist" strip would only promise. Controlled: `view` stays
          page state so the detail Sheet + bank state sit above both views. */}
      <Tabs
        tabs={VIEWS.map((v) => ({
          id: v.id,
          label: <Bilingual en={v.label} kr={v.kr} compact />,
        }))}
        ariaLabel="Grammar section"
        active={view}
        onChange={(id) => {
          // Narrow the callback string onto the closed View vocabulary.
          if (id === 'browse' || id === 'uploads') setView(id);
        }}
      >
        {(activeId) =>
          activeId === 'uploads' ? (
            <GrammarUploads
              mastered={mastered}
              pendingKey={pendingKey}
              onOpen={openDetail}
              onMastered={markMastered}
            />
          ) : (
            <GrammarBrowse
              mastered={mastered}
              pendingKey={pendingKey}
              onOpen={openDetail}
              onMastered={markMastered}
            />
          )
        }
      </Tabs>

      <GrammarDetailSheet
        row={openRow}
        detail={detail}
        loading={detailLoading}
        error={detailError}
        mastered={openKey !== null && mastered.has(openKey)}
        pending={openKey !== null && pendingKey === openKey}
        onMastered={() => {
          if (openRow) void markMastered(openRow);
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
// Shared row + mastery-action props (Browse and Uploads render the
// same row anatomy against the page-level mastery/detail state)
// ─────────────────────────────────────────────────────────────

interface RowActionProps {
  mastered: ReadonlySet<string>;
  pendingKey: string | null;
  onOpen: (row: KgiuEntrySummary) => Promise<void>;
  onMastered: (row: KgiuEntrySummary) => Promise<void>;
}

interface PatternRowProps extends RowActionProps {
  row: KgiuEntrySummary;
}

/**
 * F-128 device #1/#2 — each pattern is its own `CityCard` signboard/paper
 * row with a leading-edge `DancheongRail` (the card's `rail` prop). Tone
 * reads the row's own mastery state (F-152): `mint` — the app's
 * success/correct semantic (jade Day / mint Night) — for a mastered
 * pattern, `plain` (quiet neutral edge) otherwise, so the row itself
 * telegraphs mastery at a glance, not just its action button.
 */
function PatternRow({
  row,
  mastered,
  pendingKey,
  onOpen,
  onMastered,
}: PatternRowProps): JSX.Element {
  const key = grammarKey(row);
  const isMastered = mastered.has(key);
  const pending = pendingKey === key;
  return (
    <li className="km-review-grammar__rowItem">
      <CityCard
        tone={isMastered ? 'mint' : 'plain'}
        rail
        className="km-review-grammar__row"
      >
        <button
          type="button"
          className="km-review-grammar__row-open focusring"
          onClick={() => {
            void onOpen(row);
          }}
          aria-label={`${row.pattern} ${row.title_en ?? row.pattern}`}
        >
          <span className="kr km-review-grammar__row-kr">{row.pattern}</span>
          <span className="km-review-grammar__row-en">
            {row.title_en ?? row.pattern}
          </span>
          <span className="km-pill km-pill--default km-review-grammar__row-level">
            {row.proficiency ?? '—'}
          </span>
        </button>
        <Button
          variant={isMastered ? 'ghost' : 'gold'}
          size="sm"
          className="km-review-grammar__row-action"
          onClick={() => {
            void onMastered(row);
          }}
          disabled={isMastered || pending}
          aria-pressed={isMastered}
          aria-label={
            isMastered ? 'Already mastered' : `Mark ${row.pattern} mastered`
          }
        >
          {isMastered ? (
            // F-128 device #7 — the doc names "a mastered item" as one of
            // the seal stamp's own milestone use cases; SealStamp's own
            // `label` slot carries the caption (real content, badge stays
            // aria-hidden).
            <SealStamp
              milestone
              size="sm"
              tone="mint"
              label={<Bilingual en="Mastered" kr="숙달" compact />}
            />
          ) : pending ? (
            <Bilingual en="Marking…" kr="표시하는 중…" compact />
          ) : (
            <Bilingual en="Mark mastered" kr="숙달로 표시" compact />
          )}
        </Button>
      </CityCard>
    </li>
  );
}

/**
 * F-153 — the shared windowed row list: 15 patterns at a time, `ShowMore`
 * reveals 15 more, uncapped (the corpus is small; nothing should be
 * permanently hidden behind the primitives' default 30-row ceiling). Used by
 * both the Browse view and each Uploads group so the pagination behaviour
 * (and its tests) live in one place.
 */
function PatternList({
  rows,
  ...actions
}: RowActionProps & { rows: KgiuEntrySummary[] }): JSX.Element {
  const { visible, canShowMore, showMore, remaining } = usePagination(rows, {
    initial: 15,
    step: 15,
    max: Infinity,
  });
  return (
    <>
      <ul className="km-review-grammar__rows">
        {visible.map((p) => (
          <PatternRow key={`grammar:${String(p.id)}`} row={p} {...actions} />
        ))}
      </ul>
      <ShowMore
        canShowMore={canShowMore}
        onShowMore={showMore}
        remaining={remaining}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Browse — the KGIU corpus, difficulty dropdown (F-055) + the U1
// sort-by-source row. Search + genre are gone (F-054).
// ─────────────────────────────────────────────────────────────

function GrammarBrowse({
  mastered,
  pendingKey,
  onOpen,
  onMastered,
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
  // doc). Inert until the U2 extraction pipeline (F-108) tags kgiu_entries
  // with source_upload_id.
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
        // F-153 — keyed by the filter pair so a level/source change mounts a
        // FRESH pagination window (back to 15) instead of carrying over a
        // previously expanded count onto an unrelated result set.
        <PatternList
          key={`${level}:${source}`}
          rows={rows}
          mastered={mastered}
          pendingKey={pendingKey}
          onOpen={onOpen}
          onMastered={onMastered}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Uploads (F-056) — the user's grammar-from-uploads, grouped by
// source book. Real endpoints; empty until the U2 extraction
// pipeline (F-108) tags kgiu_entries.source_upload_id (see the
// file header).
// ─────────────────────────────────────────────────────────────

interface UploadGrammarGroup {
  upload: BookUpload;
  rows: KgiuEntrySummary[];
}

function GrammarUploads({
  mastered,
  pendingKey,
  onOpen,
  onMastered,
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
        // F-128 devices #3/#6 — a faint giwa texture + a giant "문법"
        // hangul watermark behind the empty state, matching Progress's
        // empty-state precedent.
        <p
          className="km-reference__empty km-giwa km-hangul-watermark"
          data-glyph="문법"
        >
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
            <PatternList
              rows={group.rows}
              mastered={mastered}
              pendingKey={pendingKey}
              onOpen={onOpen}
              onMastered={onMastered}
            />
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
  mastered: boolean;
  pending: boolean;
  onMastered: () => void;
  onRetry: () => void;
  onClose: () => void;
}

/**
 * Pattern-detail Sheet (F-004) — the shared `KgiuDetailBody` detail surface
 * (explanation, formation rules, examples, dialogues, unit from
 * `GET /grammar/kgiu/:id` — F-018), plus the F-152 Mastered action this page
 * owns now that it is the single browse (D3). All strings render through
 * React text children — a hostile corpus row cannot escape into the DOM.
 */
function GrammarDetailSheet({
  row,
  detail,
  loading,
  error,
  mastered,
  pending,
  onMastered,
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
            variant={mastered ? 'ghost' : 'gold'}
            size="md"
            onClick={onMastered}
            disabled={mastered || pending || row === null}
            aria-pressed={mastered}
            leadingIcon={mastered ? undefined : <Icon name="plus" size={14} />}
          >
            {mastered ? (
              // F-128 device #9 — the Sheet is modal (one open at a time), so
              // this is the "sparing jewel" spot for the mother-of-pearl
              // sheen, not a per-row repeat.
              <SealStamp
                milestone
                size="sm"
                tone="mint"
                label={<Bilingual en="Already mastered" kr="이미 숙달됨" />}
                className="km-najeon"
              />
            ) : pending ? (
              <Bilingual en="Marking mastered…" kr="숙달로 표시하는 중…" />
            ) : (
              <Bilingual en="Mark mastered" kr="숙달로 표시" />
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
