/**
 * ReviewVocab — `/review/vocab`, the Review library's vocabulary page.
 *
 * P3B redesign (pre-beta) — the page is now ONE stacked surface, top to
 * bottom (the old Browse/My-lists tab switch is gone):
 *
 *   1. My Lists (F-052) — the canonical list manager (components/
 *      MyVocabLists), moved to the TOP of the page. The `?tab=lists` deep
 *      link (LEARN flashcards still emits it) simply lands here — lists are
 *      the first thing on the page, so the param needs no handling.
 *   2. My Uploads (F-053) — vocab saved from the user's book uploads,
 *      grouped by source upload; rendered ONLY when such items exist (see
 *      `SavedFromUploads` — wired to `GET /vocab/saved-from-uploads`,
 *      F-107).
 *   3. This Week — the suggest-only strip, VOCAB ONLY (F-047: grammar
 *      content left this page; the library has a Grammar tab).
 *   4. Browse — the curated corpus. Genre + difficulty DROPDOWN filters
 *      (F-049, FilterSelect) sit above the list; the list windows 15 rows
 *      with show-more to 30 (F-051, usePagination + ShowMore), and the
 *      server pager appears once the window is fully expanded. Each row
 *      keeps its add-to-list picker, which now also offers "create a list"
 *      inline (F-048 — create + add in one round-trip via seed_entry_ids).
 *
 * F-024: a BackButton to the library index tops the page (nested sub-page).
 *
 * F-128 reskin ("Seoul Day & Night") — the shared `PageHubHeader` (devices
 * #4/#2, `components/PageHubHeader.tsx`, batch-2 fix-pass BLOCKER-2) instead
 * of a bare `Topbar`, and My Lists is now a `CollapsibleTile` signboard
 * (F-146, device #1/#2).
 *
 * F-144 — this page's own loading-state divs used to borrow
 * `.km-grammar__state` (a rule literally named after `pages/Grammar.tsx`,
 * reused ad hoc by several unrelated screens); they now use this page's own
 * `.km-vocab__state` (ReviewVocab.css), identical styling, no "grammar" in
 * the classname of a page that must never surface grammar UI. Batch-2
 * fix-pass: F-144's REAL bug was that `MyVocabLists`' own inline "New list"
 * card put a live "Grammar · 문법" radio option on this page by default
 * (`REVIEW_batch2-vocab.md` BLOCKER B-1) — fixed at the source by giving
 * `MyVocabLists` a `kinds` prop; this page passes `kinds={['vocab']}` so the
 * kind picker never renders (a single-kind mount skips it entirely — see
 * MyVocabLists.tsx). `WeeklySuggestions` (shared, out-of-scope for this
 * pass) still renders its OWN loading state through the shared
 * `.km-grammar__state` rule — flagged for a follow-up there.
 *
 * Batch-3 fix-pass — the `kinds` prop above only ever scoped what a NEW
 * list could be CREATED as; `MyVocabLists`' own "My lists" tile still
 * rendered every one of the user's lists exactly as `GET /vocab/lists`
 * returned them, unfiltered by kind. That's the actual, still-live root
 * cause of "grammar keeps showing on the Vocab page" after the two prior
 * fixes above: a pre-existing `kind: 'grammar'` list (or one made through
 * any other kind-creating surface) rendered right here regardless of this
 * page's `kinds={['vocab']}`. `MyVocabLists` now filters its fetched rows
 * by `kinds` before rendering — see that file's header doc — and its two
 * remaining `.km-grammar__state` loading-state divs (cosmetic classname
 * only, not the bug above) are renamed to `.km-vocab__state` for the same
 * reason F-144 renamed this page's own.
 *
 * F-148 — "This Week" is now a `Sheet` popup (a small trigger button opens
 * it) instead of an always-inline card, so the page reads as My Lists →
 * Browse with the suggestion strip tucked behind a tap, matching the
 * Create-list / add-to-list popups already on this page.
 *
 * F-147 — BOTH create-list entry points are now `Sheet` popups: the
 * word-picker's create-a-list flow (`AddToListSheet` below) already was one
 * and is already vocab-only (hardcoded `kind: 'vocab'`, no kind picker); and
 * `MyVocabLists`' own create card (previously an always-visible inline form)
 * is now ALSO a `Sheet` popup behind a "New list" trigger button, scoped to
 * `kinds={['vocab']}` on this page (see MyVocabLists.tsx and this build's
 * fixpass report).
 *
 * Threat model: the search box is user-controlled — the server Zod-validates
 * `q` and parameterises the SQL; strings render through React text children;
 * the client's defence is RATE (debounce + per-fetch abort). List mutations
 * ride the `SameSite=Strict` session cookie (services/api.ts). The filter
 * dropdowns are closed vocabularies validated at the select boundary
 * (`toDomainFilter` / `toLevelFilter`) — an out-of-vocabulary value
 * degrades to 'all', never reaches the wire.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { BackButton } from '../../components/BackButton';
import { Bilingual } from '../../components/Bilingual';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { CollapsibleTile } from '../../components/CollapsibleTile';
import { ErrorCard } from '../../components/ErrorCard';
import { Eyebrow } from '../../components/Eyebrow';
import {
  FilterSelect,
  type FilterSelectOption,
} from '../../components/FilterSelect';
import { Icon } from '../../components/Icon';
import { Pager, SearchBox } from '../../components/LibraryControls';
import { LibrarySubnav } from '../../components/LibrarySubnav';
import { MyVocabLists } from '../../components/MyVocabLists';
import { PageHubHeader } from '../../components/PageHubHeader';
import { Sheet } from '../../components/Sheet';
import { ShowMore } from '../../components/ShowMore';
import { ALL_SOURCES, SourceFilterRow } from '../../components/SourceFilterRow';
import { WeeklySuggestions } from '../../components/WeeklySuggestions';
import { useToast } from '../../components/useToast';
import { useDebouncedSearch } from '../../hooks/useDebouncedSearch';
import { usePagination } from '../../hooks/usePagination';
import {
  DOMAIN_FILTERS,
  PAGE_SIZE,
  type DomainFilter,
  type LevelFilter,
} from '../../lib/libraryFilters';
import { errorMessageFor } from '../../lib/errorCopy';
import { navItem } from '../../lib/nav';
import * as vocabService from '../../services/vocab';
import { ApiError } from '../../services/api';
import type {
  BookLevel,
  ContentDomain,
  SavedFromUploadsGroup,
  ServerVocabList,
  VocabEntry,
} from '../../types/domain';
import './ReviewVocab.css';

/** Parent-tab name source — nav.ts owns the en/kr pair (F-043 renamed the
 *  tab to "Library"), so the eyebrow and back label can never go stale. */
const LIBRARY_NAV = navItem('review');

// ─────────────────────────────────────────────────────────────
// F-049 filter vocabularies — closed lists mirroring the server enums
// ─────────────────────────────────────────────────────────────

/**
 * Genre dropdown options — every genre (`content_domain`), minus the 'all'
 * sentinel (FilterSelect's placeholder `''` IS the "all" state).
 *
 * F-151 ("more genres"): `content_domain` is a real 3-value Postgres enum
 * (`general`/`research`/`business` — migration 002; confirmed live,
 * 2026-07-13: 3071/108/12 rows) shared by `lib/libraryFilters.ts` — also
 * consumed by the Grammar library pages, which another agent is reworking in
 * parallel this pass, so it's out of this ticket's edit scope. Expanding the
 * genre SET (not just this list) needs a schema/enum change + a server
 * filter param, not a client tweak.
 *
 * F-176 (done): the richer real data sitting on `vocab_entries.theme`
 * (per-book chapter categories — People, Education, Economy, Health, …, ~31
 * real values on ~3,188 rows) is now ALSO a filterable facet, separate from
 * the Genre dropdown above — see the "Theme" `FilterSelect` in `VocabBrowse`
 * below, fed by the new `GET /vocab/themes` values route
 * (`server/src/routes/vocab.ts`) rather than a hardcoded list (themes are
 * free text lifted per-book from the source extraction, not a designed
 * taxonomy — two different corpora can carry a similar-looking "01 …" label
 * that means something different, so the values must come from the live
 * corpus, never be guessed client-side).
 */
const GENRE_OPTIONS: ReadonlyArray<FilterSelectOption> = DOMAIN_FILTERS.filter(
  (f) => f.id !== 'all',
).map((f) => ({ value: f.id, label: f.label }));

/**
 * Difficulty dropdown options — all 3 `book_level` bands (F-049). The
 * curated corpus carries only beginner/intermediate rows today, so
 * 'advanced' returns an honest empty state rather than a 400 — the server
 * enum accepts all three.
 */
const DIFFICULTY_OPTIONS: ReadonlyArray<FilterSelectOption> = [
  { value: 'beginner', label: 'Beginner' },
  { value: 'intermediate', label: 'Intermediate' },
  { value: 'advanced', label: 'Advanced' },
];

const BOOK_LEVELS: ReadonlyArray<BookLevel> = [
  'beginner',
  'intermediate',
  'advanced',
];

/** Select-boundary guard: FilterSelect emits a raw string ('' = placeholder).
 *  Anything outside the closed genre vocabulary collapses to 'all'. */
function toDomainFilter(value: string): DomainFilter {
  return DOMAIN_FILTERS.some((f) => f.id !== 'all' && f.id === value)
    ? (value as ContentDomain)
    : 'all';
}

/** Select-boundary guard for the difficulty dropdown — same contract. */
function toLevelFilter(value: string): LevelFilter {
  return BOOK_LEVELS.some((l) => l === value)
    ? (value as BookLevel)
    : 'all';
}

// ─────────────────────────────────────────────────────────────
// F-061 — "add words to this list" hand-off from the flashcards page
// ─────────────────────────────────────────────────────────────

/** The flashcards page's list-edit flow lands here with the open list in
 *  router state, so a tapped word files into THAT list without re-picking. */
export interface AddToListTarget {
  id: number;
  name: string;
}

/**
 * Router state is an untyped I/O boundary (a stale history entry or another
 * page's state shape can arrive here) — validate structurally and degrade to
 * null (normal browse mode) rather than trusting a cast.
 */
function toAddToListTarget(state: unknown): AddToListTarget | null {
  if (typeof state !== 'object' || state === null) return null;
  const raw = (state as { addToList?: unknown }).addToList;
  if (typeof raw !== 'object' || raw === null) return null;
  const { id, name } = raw as { id?: unknown; name?: unknown };
  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof name !== 'string' ||
    name === ''
  ) {
    return null;
  }
  return { id, name };
}

export default function ReviewVocab(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  // F-061: when the flashcards page sent us here to fill a list, every
  // Browse-row add goes straight into that list (no picker sheet), and the
  // banner offers the way back to the list that was originally open.
  const addToList = toAddToListTarget(location.state);
  // F-148 — "This Week" opens as a Sheet popup; the picks fetch is now lazy
  // (WeeklySuggestions only mounts once the sheet opens), which is a nice
  // side benefit but also means the fetch no longer fires on page load.
  const [weekOpen, setWeekOpen] = useState(false);

  return (
    <section
      className="screen km-reference km-resources km-vocab km-rain-sheen"
      aria-labelledby="km-review-vocab-title"
    >
      {/* F-024 — nested library sub-page: deterministic back to the index. */}
      <BackButton to="/review" label={LIBRARY_NAV.label} />

      {/* F-128 devices #4/#2 — the shared hub-header recipe (batch-2
          fix-pass BLOCKER-2, components/PageHubHeader.tsx) instead of a bare
          `Topbar`. */}
      <PageHubHeader
        titleId="km-review-vocab-title"
        eyebrow={<Bilingual en={LIBRARY_NAV.label} kr={LIBRARY_NAV.kr} />}
        heading={<Bilingual en="Vocabulary" kr="단어" />}
      />

      <LibrarySubnav />

      {/* F-061 — add-words mode banner + the return leg of the round-trip. */}
      {addToList !== null ? (
        <Card variant="accent" className="km-vocab__addBanner" role="status">
          <div style={{ flex: 1, minWidth: 0 }}>
            <Eyebrow>
              <Bilingual en="Adding words to" kr="단어 추가 중" />
            </Eyebrow>
            <div className="kr" style={{ fontSize: '0.9375rem', fontWeight: 500 }}>
              {addToList.name}
            </div>
          </div>
          <Button
            variant="gold"
            size="sm"
            onClick={() => {
              void navigate(`/learn/vocab?list=${String(addToList.id)}`);
            }}
          >
            <Bilingual en="Back to the list" kr="목록으로" compact />
          </Button>
        </Card>
      ) : null}

      {/* F-052 — My Lists leads the page. F-146: it's now a CollapsibleTile
          signboard (surface="city", device #1/#2) instead of a bare
          <section>+<h2> — default OPEN (the ticket asks it to fold, not to
          start hidden; this is the page's most-used surface). The disclosure
          button itself carries the accessible name that the old <h2> gave
          this section — see the F-146 test for the query shape that
          replaces the retired heading-role assertion. */}
      <CollapsibleTile
        className="km-vocab__section km-vocab__listsTile"
        surface="city"
        tone="accent"
        rail
        title={<Bilingual en="My lists" kr="내 단어장" />}
      >
        {/* F-144/F-147 — this page's list-kind universe is vocab ONLY: the
            Vocab page must never offer "Grammar · 문법" as a creatable list
            kind (that was the ticket's actual complaint, and the F-147
            "shared component, out of scope" excuse used to leave it live —
            see MyVocabLists.tsx's own doc comment for the fix). `kinds`
            defaults to the full vocab/grammar/hanja/mixed set for any future
            second consumer; this page narrows it to the one kind it owns. */}
        <MyVocabLists kinds={['vocab']} />
      </CollapsibleTile>

      {/* F-053 — saved-from-uploads vocab, grouped by upload (conditional). */}
      <SavedFromUploads />

      {/* F-148 — "This Week" is a popup: a small trigger opens a Sheet
          instead of an always-inline card. F-047: vocab picks only —
          grammar suggestions live on the Grammar tab's side of the library
          now (`showGrammar={false}` unchanged). */}
      <div className="km-vocab__weekTrigger">
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<Icon name="spark" size={14} />}
          onClick={() => {
            setWeekOpen(true);
          }}
        >
          <Bilingual en="This week" kr="이번 주" compact />
        </Button>
      </div>

      <Sheet
        open={weekOpen}
        onClose={() => {
          setWeekOpen(false);
        }}
        ariaLabel="This week's words"
      >
        <div className="km-review__sheetBody">
          <div className="km-review__sheetHead">
            <div>
              <Eyebrow>
                <Bilingual en="This week" kr="이번 주" />
              </Eyebrow>
              <div className="kr-display km-review__sheetTitle">
                <Bilingual en="Suggested picks" kr="추천 단어" />
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setWeekOpen(false);
              }}
              aria-label="Close this week's picks"
            >
              <Icon name="close" size={14} />
            </Button>
          </div>
          <hr className="hr-double km-review__sheetRule" />
          {/* Mounted only while the sheet is open — the fetch inside
              WeeklySuggestions is lazy (no wasted round-trip behind a popup
              the user never opens). */}
          <WeeklySuggestions showGrammar={false} />
        </div>
      </Sheet>

      <section
        className="km-vocab__section"
        aria-labelledby="km-vocab-browse-h"
      >
        <h2 id="km-vocab-browse-h" className="km-review__sectionTitle">
          <Bilingual en="Browse the corpus" kr="말뭉치 둘러보기" />
        </h2>
        <VocabBrowse addToList={addToList} />
      </section>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// F-053 — "My uploads" (saved-from-upload vocab, grouped by upload)
// ─────────────────────────────────────────────────────────────

/**
 * F-053 contract: show vocab the user SAVED from their book uploads (tap a
 * word in an upload → save/list it → it files here), grouped by source
 * upload — and render the section ONLY when such items exist.
 *
 * Wired (F-107) to `GET /vocab/saved-from-uploads`: the save paths now
 * record upload provenance (`POST /vocab/mine` + `POST /grammar/bank`
 * accept `source_upload_id`, ownership-validated server-side), and the read
 * folds both save forms (card banks + list adds of upload-tagged entries)
 * into per-upload groups. Distinct from the U3a
 * `GET /vocab/entries?source_upload_id=` browse (everything a book tagged):
 * this is only what the user chose to keep.
 *
 * Honest empty state = NOTHING renders: F-053 specifies the section is
 * "only shown if such saved items exist", so no groups (and, best-effort,
 * a failed fetch — this is a supplementary shelf, not the page's core
 * surface, same posture as the theme-filter fetch above) yields null
 * rather than an empty shell or an error card.
 *
 * Threat model: upload titles and saved words are the caller's OWN data
 * (server-scoped to the session user); both render through React text
 * children, so a hostile title cannot escape into markup.
 */
function SavedFromUploads(): JSX.Element | null {
  const [groups, setGroups] = useState<SavedFromUploadsGroup[]>([]);
  // F-107 truncation signal: the server caps the response at 500 rows and
  // only ever returns WHOLE groups (a group the cap would split mid-group is
  // dropped), so this flag — not any visible gap — is the sole sign that
  // more saves exist beyond what renders.
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    vocabService
      .fetchSavedFromUploads(ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setGroups(res.groups);
        setTruncated(res.truncated);
      })
      .catch(() => {
        // Best-effort — see the component doc comment above.
      });
    return () => {
      ctrl.abort();
    };
  }, []);

  if (groups.length === 0) return null;

  return (
    <CollapsibleTile
      className="km-vocab__section km-vocab__savedFromUploads"
      surface="city"
      rail
      title={<Bilingual en="My uploads" kr="내 업로드" />}
    >
      {groups.map((group) => (
        <section
          key={`saved-upload:${String(group.upload.id)}`}
          className="km-vocab__savedUploadGroup"
          aria-label={group.upload.title}
        >
          <Eyebrow>{group.upload.title}</Eyebrow>
          <Card className="km-reference__list" variant="flat">
            <ul>
              {group.entries.map((entry) => (
                <li
                  key={`saved:${String(group.upload.id)}:${String(entry.id)}`}
                  className="km-reference__row"
                >
                  <div className="km-resources__entry-row">
                    <span className="kr km-reference__row-kr">
                      {entry.korean ?? ''}
                    </span>
                    <span className="km-reference__row-en">
                      {entry.english ?? ''}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ))}
      {truncated ? (
        <p className="km-vocab__savedUploadsTruncated">
          <Bilingual
            en="Showing your most recent saves only"
            kr="최근 저장 항목만 표시됩니다"
          />
        </p>
      ) : null}
    </CollapsibleTile>
  );
}

// ─────────────────────────────────────────────────────────────
// Browse — curated corpus, searchable; F-049 dropdown filters + F-051 window
// ─────────────────────────────────────────────────────────────

function VocabBrowse({
  addToList,
}: {
  /** F-061 — when set, row adds go straight into this list (no picker). */
  addToList: AddToListTarget | null;
}): JSX.Element {
  const { toast } = useToast();
  const { input, q, setInput, clear } = useDebouncedSearch();
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<VocabEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Monotonic reload trigger so the Retry button re-runs the fetch effect
  // without changing `q`/`offset`.
  const [reloadTick, setReloadTick] = useState(0);
  // Add-to-list target row — opens the picker Sheet.
  const [addTarget, setAddTarget] = useState<VocabEntry | null>(null);
  // F-061 direct-add mode: the entry currently being appended to the
  // hand-off list (disables that row's button while in flight).
  const [directAddId, setDirectAddId] = useState<number | null>(null);
  // F-049 filters: genre (content_domain) + difficulty (book_level). 'all'
  // omits the param so the endpoint returns every row.
  const [domain, setDomain] = useState<DomainFilter>('all');
  const [level, setLevel] = useState<LevelFilter>('all');
  // F-176 — per-book theme/chapter facet (`vocab_entries.theme`). '' is the
  // FilterSelect placeholder state ("All themes") and omits the param, same
  // convention as `domain`/`level` above. Unlike those two, the value set is
  // corpus-derived data (~31 free-text labels), not a closed enum — fetched
  // once from `GET /vocab/themes` below rather than hardcoded.
  const [theme, setTheme] = useState('');
  const [themeOptions, setThemeOptions] = useState<
    ReadonlyArray<FilterSelectOption>
  >([]);
  // U1/U3a — sort-by-source filter (see SourceFilterRow's header doc).
  const [source, setSource] = useState<string>(ALL_SOURCES);
  const ctrlRef = useRef<AbortController | null>(null);

  // F-176 — load the live theme values once on mount. Best-effort: a failed
  // fetch just leaves the dropdown at "All themes only" (no options to pick
  // beyond the placeholder) rather than blocking or erroring the whole
  // Browse panel over a non-critical filter facet.
  useEffect(() => {
    const ctrl = new AbortController();
    vocabService
      .fetchVocabThemes(ctrl.signal)
      .then((themes) => {
        if (ctrl.signal.aborted) return;
        setThemeOptions(themes.map((t) => ({ value: t, label: t })));
      })
      .catch(() => {
        // Silent — see the effect's doc comment above.
      });
    return () => {
      ctrl.abort();
    };
  }, []);

  // F-051 — client window over the fetched server page: 15 visible, one
  // show-more step to the 30-row cap (= PAGE_SIZE, so a fully expanded
  // window shows exactly the fetched page).
  const {
    visible,
    canShowMore,
    showMore,
    reset: resetWindow,
    remaining,
  } = usePagination<VocabEntry>(rows);

  // Reset to the first page AND collapse the window whenever the query or a
  // filter changes, so neither the pager nor the window points past the new
  // result set. Sync-to-derived-state on a key change — same documented
  // exception the hooks use.
  useEffect(() => {

    setOffset(0);
    resetWindow();
  }, [q, domain, level, theme, source, resetWindow]);

  // Collapse the window on a server-page move too (Prev/Next) — a new page
  // must never open pre-expanded.
  useEffect(() => {
    resetWindow();
  }, [offset, resetWindow]);

  useEffect(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    // Sync-to-external-system (a network fetch) — the same exception
    // useEndpointOrMock documents for its kickoff setState.
     
    setLoading(true);
    setError(null);
     
    vocabService
      .searchEntriesPage(
        {
          ...(q ? { q } : {}),
          ...(domain !== 'all' ? { domain } : {}),
          ...(level !== 'all' ? { book_level: level } : {}),
          ...(theme !== '' ? { theme } : {}),
          ...(source !== ALL_SOURCES ? { source_upload_id: source } : {}),
          limit: PAGE_SIZE,
          offset,
        },
        ctrl.signal,
      )
      .then((page) => {
        if (ctrl.signal.aborted) return;
        setRows(page.entries);
        // `total` is optional (pre-bump server). Fall back to "page length"
        // so the pager degrades to a single page rather than rendering NaN.
        setTotal(page.total ?? offset + page.entries.length);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(errorMessageFor(err, 'Could not load vocabulary.'));
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [q, offset, domain, level, theme, source, reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  // F-061: in add-words mode a tapped row files straight into the hand-off
  // list — no picker sheet. A 409 means "already a member": the user's
  // intent is satisfied, so it reads as gentle info, not an error.
  const directAdd = useCallback(
    async (entry: VocabEntry): Promise<void> => {
      if (addToList === null || directAddId !== null) return;
      setDirectAddId(entry.id);
      try {
        await vocabService.addListEntries(addToList.id, [entry.id]);
        toast({ message: `Added to ${addToList.name}.`, tone: 'success' });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          toast({ message: `Already in ${addToList.name}.`, tone: 'info' });
        } else {
          toast({
            message: errorMessageFor(err, 'Could not add the word.'),
            tone: 'error',
          });
        }
      } finally {
        setDirectAddId(null);
      }
    },
    [addToList, directAddId, toast],
  );

  return (
    <div className="km-resources__panel">
      {/* F-149 — a real visible label above the field (SearchBox itself has
          no <label>/id to associate one via htmlFor — a shared component,
          out of scope here — so the accessible name AND a visible caption
          both carry the same copy). */}
      <Eyebrow className="km-vocab__searchLabel">
        <Bilingual en="Search for a word" kr="단어 검색" />
      </Eyebrow>
      <SearchBox
        value={input}
        onChange={setInput}
        onClear={clear}
        placeholder="Search the 2,000 corpus"
        ariaLabel="Search for a word"
      />
      {/* F-049 — dropdown filters ABOVE the list. FilterSelect is a labelled
          native select; '' (the "All" placeholder) maps to the 'all'
          sentinel through the boundary guards. */}
      <div className="km-vocab__filters">
        <FilterSelect
          label="Genre"
          options={GENRE_OPTIONS}
          value={domain === 'all' ? '' : domain}
          onChange={(v) => {
            setDomain(toDomainFilter(v));
          }}
        />
        <FilterSelect
          label="Difficulty"
          options={DIFFICULTY_OPTIONS}
          value={level === 'all' ? '' : level}
          onChange={(v) => {
            setLevel(toLevelFilter(v));
          }}
        />
        {/* F-176 — theme/chapter facet (`vocab_entries.theme`). Distinct from
            "Genre" (content_domain) above: theme is a per-book chapter label
            (~31 real values, e.g. "01 인간 / People"), not the 3-value genre
            enum. Options come from the live corpus (see the mount effect
            above), never hardcoded. Unlike Genre/Difficulty there is no
            `toXFilter` boundary guard needed: FilterSelect is a native
            `<select>` whose only choosable values are the `themeOptions` it
            was given plus the placeholder, so there is no free-form input
            path for an out-of-vocabulary string to arrive through. */}
        <FilterSelect
          label="Theme"
          options={themeOptions}
          value={theme}
          onChange={setTheme}
          placeholder="All themes"
        />
      </div>
      <SourceFilterRow
        ariaLabel="Filter vocabulary by source book"
        value={source}
        onChange={setSource}
      />
      {loading && rows.length === 0 ? (
        <div className="km-vocab__state" role="status">
          <Bilingual en="Loading vocabulary…" kr="어휘를 불러오는 중…" />
        </div>
      ) : error ? (
        // Render the error whenever the LAST fetch failed — even when stale
        // rows from a previous page/filter are still in state. Gating this on
        // `rows.length === 0` silently swallowed pagination/filter failures:
        // the old rows kept rendering under the NEW pager range (offset had
        // already advanced), with no error and no retry surface.
        <ErrorCard message={error} onRetry={refetch} />
      ) : rows.length === 0 ? (
        <p className="km-reference__empty">
          <Bilingual
            en="No words match. Try a dictionary form."
            kr="맞는 단어가 없어요. 사전형으로 검색해 보세요."
          />
        </p>
      ) : (
        <>
          <Card className="km-reference__list" variant="flat">
            <ul>
              {visible.map((entry) => (
                <li key={`vocab:${String(entry.id)}`} className="km-reference__row">
                  <div className="km-resources__entry-row">
                    <span className="kr km-reference__row-kr">
                      {entry.korean ?? ''}
                    </span>
                    <span className="km-reference__row-en">
                      {entry.english ?? ''}
                    </span>
                    <span className="km-pill km-pill--default km-reference__row-level">
                      {entry.proficiency ?? '—'}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      leadingIcon={<Icon name="plus" size={12} />}
                      onClick={() => {
                        if (addToList !== null) {
                          void directAdd(entry);
                        } else {
                          setAddTarget(entry);
                        }
                      }}
                      disabled={directAddId === entry.id}
                      aria-label={
                        addToList !== null
                          ? `Add ${entry.korean ?? 'word'} to ${addToList.name}`
                          : `Add ${entry.korean ?? 'word'} to a list`
                      }
                    >
                      {addToList !== null ? (
                        <Bilingual en="Add" kr="추가" compact />
                      ) : (
                        <Bilingual en="List" kr="목록" compact />
                      )}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
          {/* F-051 — reveal 16–30 of the fetched page. `remaining` comes from
              the hook (never `total - visible`), so the label never
              over-promises rows the capped window can't reach. */}
          <ShowMore
            canShowMore={canShowMore}
            onShowMore={showMore}
            remaining={remaining}
          />
          {/* The server pager appears only once the window is fully expanded:
              its "N–M of T" range then matches EXACTLY what is on screen
              (a "1–30" readout over 15 visible rows would over-claim). */}
          {!canShowMore ? (
            <Pager
              offset={offset}
              pageSize={PAGE_SIZE}
              total={total}
              onPrev={() => {
                setOffset((o) => Math.max(0, o - PAGE_SIZE));
              }}
              onNext={() => {
                setOffset((o) => o + PAGE_SIZE);
              }}
            />
          ) : null}
        </>
      )}

      <AddToListSheet
        entry={addTarget}
        onClose={() => {
          setAddTarget(null);
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Add-to-list Sheet — pick (or create, F-048) a list for a vocab row
// ─────────────────────────────────────────────────────────────

interface AddToListSheetProps {
  entry: VocabEntry | null;
  onClose: () => void;
}

function AddToListSheet({ entry, onClose }: AddToListSheetProps): JSX.Element {
  const { toast } = useToast();
  const [lists, setLists] = useState<ServerVocabList[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(null);
  // F-048 — inline "create a list" state. Creating from here seeds the list
  // with the tapped entry (`seed_entry_ids`) so create + add is ONE
  // round-trip, not create-then-hunt-for-the-list.
  const [newListName, setNewListName] = useState('');
  const [creating, setCreating] = useState(false);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (entry === null) {
      setLists([]);
      setError(null);
      setNewListName('');
      return;
    }
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    setLoading(true);
    setError(null);
    // BLOCKER fix (`REVIEW_mobile-today-vocab.md`) — this sheet is a
    // vocab-only picker (it seeds a vocab entry into a list, `add`/
    // `createAndAdd` below), but `listLists()` used to fetch every kind,
    // unfiltered, so a pre-existing grammar-kind list rendered here as a
    // legitimate pick target. `kind: 'vocab'` asks the server's own
    // `?kind=` filter (`vocabService.listLists`'s doc comment) to narrow
    // this the same way `MyVocabLists`'s "My Lists" tile on this same page
    // already does — the create flow below already hardcoded `kind:
    // 'vocab'` for what a NEW list becomes; this is the matching fix for
    // the list this sheet DISPLAYS.
    vocabService
      .listLists({ kind: 'vocab' })
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        // Belt-and-suspenders, mirroring `MyVocabLists.tsx`'s `visibleLists`:
        // the server-side `kind` filter above is the real fix, but a second,
        // cheap client-side filter means a server that ever ignored the
        // param (a regression, a proxy that drops query strings, etc.)
        // still can't put a non-vocab list in front of this picker.
        setLists(rows.filter((l) => l.kind === 'vocab'));
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(errorMessageFor(err, 'Could not load your lists.'));
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [entry]);

  const add = useCallback(
    async (list: ServerVocabList): Promise<void> => {
      if (entry === null) return;
      setPendingId(list.id);
      setError(null);
      try {
        await vocabService.addListEntries(list.id, [entry.id]);
        toast({
          message: `Added to ${list.name_kr}.`,
          tone: 'success',
        });
        onClose();
      } catch (err) {
        // 409 → already in this list. The user's intent is satisfied; treat it
        // as a (gentle) success rather than a hard error.
        if (err instanceof ApiError && err.status === 409) {
          toast({
            message: `Already in ${list.name_kr}.`,
            tone: 'info',
          });
          onClose();
          return;
        }
        setError(errorMessageFor(err, 'Could not add the word.'));
      } finally {
        setPendingId(null);
      }
    },
    [entry, onClose, toast],
  );

  // F-048 — create a NEW list seeded with this entry (one POST).
  const createAndAdd = useCallback(async (): Promise<void> => {
    if (entry === null || creating) return;
    const name = newListName.trim();
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const res = await vocabService.createList({
        name_kr: name,
        kind: 'vocab',
        seed_entry_ids: [entry.id],
      });
      toast({
        message: `Created ${res.list.name_kr} — word added.`,
        tone: 'success',
      });
      setNewListName('');
      onClose();
    } catch (err) {
      setError(errorMessageFor(err, 'Could not create the list.'));
    } finally {
      setCreating(false);
    }
  }, [entry, creating, newListName, onClose, toast]);

  return (
    <Sheet open={entry !== null} onClose={onClose} ariaLabel="Add to a list">
      <div className="km-review__sheetBody">
        <div className="km-review__sheetHead">
          <div>
            <Eyebrow>
              <Bilingual en="Add to list" kr="목록에 추가" />
            </Eyebrow>
            <div className="kr-display km-review__sheetTitle">
              {entry?.korean ?? ''}
            </div>
            <div className="km-review__sheetMeta">{entry?.english ?? ''}</div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close add to list"
          >
            <Icon name="close" size={14} />
          </Button>
        </div>

        <hr className="hr-double km-review__sheetRule" />

        {loading ? (
          <div className="km-vocab__state" role="status">
            <Bilingual en="Loading your lists…" kr="목록을 불러오는 중…" />
          </div>
        ) : null}
        {error ? <ErrorCard message={error} /> : null}
        {!loading && lists.length === 0 && !error ? (
          <p className="km-reference__empty">
            <Bilingual
              en="No lists yet — create one below."
              kr="아직 목록이 없어요 — 아래에서 만들어 주세요."
            />
          </p>
        ) : null}
        {lists.length > 0 ? (
          <ul className="km-resources__pick-list">
            {lists.map((list) => (
              <li key={`pick:${String(list.id)}`}>
                <Button
                  variant="ghost"
                  size="md"
                  fullWidth
                  onClick={() => {
                    void add(list);
                  }}
                  disabled={pendingId === list.id}
                  leadingIcon={<Icon name="plus" size={14} />}
                >
                  {pendingId === list.id ? (
                    <Bilingual en="Adding…" kr="추가 중…" />
                  ) : (
                    list.name_kr
                  )}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        {/* F-048 — create a list right here; the new list is seeded with
            this word. */}
        <div className="km-vocab__sheetCreate">
          <input
            type="text"
            value={newListName}
            onChange={(e) => {
              setNewListName(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void createAndAdd();
              }
            }}
            placeholder="New list name (Korean)"
            className="kr focusring km-resources__create-input"
            aria-label="Name for the new list"
            maxLength={120}
            disabled={creating}
          />
          <Button
            variant="gold"
            size="sm"
            onClick={() => {
              void createAndAdd();
            }}
            disabled={newListName.trim().length === 0 || creating}
          >
            {creating ? (
              <Bilingual en="Creating…" kr="만드는 중…" compact />
            ) : (
              <Bilingual en="Create list" kr="목록 만들기" compact />
            )}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
