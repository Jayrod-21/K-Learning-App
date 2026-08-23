/**
 * Review — the LEARN → Vocab FLASHCARDS page (`/learn/vocab`).
 * (Named `Review` for historical reasons; the Review LIBRARY lives at
 * `/review/*` — see pages/review/.)
 *
 * Phase 3C-1 rework (F-060): the page is LISTS-FIRST. The old three-tab IA
 * (Session / Lists / All cards) is gone — "All cards" browsing lives on the
 * library's Vocabulary page (`/review/vocab`), and a flashcard session is
 * something you LAUNCH from a list rather than the landing state.
 *
 * Views are URL-driven (refresh- and back-button-safe; no router changes —
 * everything rides `/learn/vocab`'s search params):
 *
 *   /learn/vocab                  → landing: create-a-list + ALL lists +
 *                                   the due-review queue + corpus seeding.
 *   /learn/vocab?list=7           → list detail: words, Study button at the
 *                                   top, Edit mode (rename / remove words /
 *                                   add words via the library — F-061).
 *   /learn/vocab?list=7&study=1   → flashcard session over that list.
 *   /learn/vocab?study=due        → flashcard session over the FSRS due queue.
 *
 * Session completion renders an in-place stats page (F-062): cards reviewed,
 * rating breakdown, and a next-due summary derived from the server's
 * `ReviewResult.scheduled_days` responses.
 *
 * Rating persistence (server-authoritative scheduling, ADR-003 amendment):
 *   - due-queue cards  → POST /vocab/cards/:id/reviews with the card's
 *     `expected_version` snapshot (buildReviewSubmission).
 *   - list cards       → POST /vocab/entries/:id/bank (idempotent; returns
 *     the user's recognition card + version) then POST the review against
 *     that card. Two calls, but both existing routes — no invented endpoint.
 *
 * F-061 round-trip: "Add words" navigates to `/review/vocab` with
 * `location.state.addToList = { id, name }`; the library page adds tapped
 * words straight to that list and offers a return link to
 * `/learn/vocab?list=<id>` so the round-trip lands back on the open list.
 *
 * Threat model:
 *   - **Rendered text is escaped.** List names, vocab text, and KRDICT
 *     example sentences render as React text children; server-injected
 *     markup becomes literal text. Never wire dangerouslySetInnerHTML here.
 *   - **URL params are validated at the boundary.** `list` must be a short
 *     positive integer, `study` must be in the closed {'1','due'} set;
 *     anything else degrades to the landing view (never an exception, never
 *     a request with a hostile path segment).
 *   - **Scheduling is server-owned.** The client sends only the rating +
 *     `expected_version`; a tampered client cannot choose `due_at`. A 409
 *     (stale version) surfaces as a save error — the rating is counted
 *     locally but reported "not saved" on the completion page.
 *   - **List CRUD is POST/PATCH/DELETE** → CSRF surface, defended by the
 *     session cookie's SameSite=Strict (services/api.ts). Error copy is
 *     fixed via errorMessageFor — server prose never reaches the DOM.
 *   - **Optimistic mutations roll back.** Entry removal drops the row
 *     immediately and restores it on failure, so the view never lies.
 *   - **AbortController on every raw fetch** (list detail, KRDICT examples);
 *     the two useEndpointOrMock feeds manage their own abort.
 *   - **PII in study log:** `logStudy` carries minutes + activity string
 *     only — no KR text, no card ids (fire-and-forget on session unmount,
 *     only when at least one card was rated).
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BackButton } from '../components/BackButton';
import { Bilingual } from '../components/Bilingual';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { CityCard } from '../components/CityCard';
import { ClozeCard } from '../components/ClozeCard';
import { CollapsibleTile } from '../components/CollapsibleTile';
import { ErrorCard } from '../components/ErrorCard';
import { Eyebrow } from '../components/Eyebrow';
import { Flashcard } from '../components/Flashcard';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { PageHubHeader } from '../components/PageHubHeader';
import { Pill } from '../components/Pill';
import { SealStamp } from '../components/SealStamp';
import { Sheet } from '../components/Sheet';
import { ShowMore } from '../components/ShowMore';
import { SubwayProgress } from '../components/SubwayProgress';
import { Toggle } from '../components/Toggle';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { usePagination } from '../hooks/usePagination';
import { loadVocabMock, loadVocabListsMock } from '../data/mocks/review';
import * as vocabService from '../services/vocab';
import * as progressService from '../services/progress';
import { fetchPrefs, patchClozeEnabled } from '../services/settings';
import { defineEntry } from '../services/define';
import { ApiError } from '../services/api';
import { buildReviewSubmission } from '../lib/reviewSubmission';
import { pickPresentation } from '../lib/clozePresentation';
import { errorMessageFor } from '../lib/errorCopy';
import { isInteractiveElement } from '../lib/interactiveElement';
import { navItem } from '../lib/nav';
import { parseIdParam } from '../lib/urlIdParam';
import type {
  ClozeGradeCommittedResponse,
  DefineExample,
  DueCard,
  DueCardCloze,
  FsrsRating,
  ListEntryItemType,
  ReviewResult,
  ServerVocabList,
  Vocab,
  VocabCorpus,
  VocabListEntryRow,
} from '../types/domain';
import './Review.css';

/** Nav-manifest entry for this screen — the eyebrow the F-128 `PageHubHeader`
 *  renders comes from here (nav.ts owns the en/kr pair), so it can never go
 *  stale against the bottom-nav/LearnMenu label. */
const FLASHCARDS_NAV = navItem('flashcards');

// ─────────────────────────────────────────────────────────────
// Study-deck model
// ─────────────────────────────────────────────────────────────

/**
 * How a rating on this card persists. `due` cards carry their wire snapshot
 * (id + version for the optimistic-concurrency echo) — this is EVERY real
 * card today, due-queue AND per-list study alike (F-113: list study now
 * fetches the list's own due-scoped queue, `GET /vocab/lists/:id/cards/due`,
 * instead of banking+reviewing every entry unconditionally — see
 * `useListDue`). `local` cards are dev fixture data — the rating counts
 * locally and is honestly reported as unsaved.
 */
export type StudyCardWire = { kind: 'due'; snapshot: DueCard } | { kind: 'local' };

/** One flashcard in a study session — UI shape, source-agnostic. */
export interface StudyCard {
  /** Stable render key ('due:101' / 'entry:42' / 'fixture:v1'). */
  key: string;
  kr: string;
  en: string;
  exKr: string;
  exEn: string;
  /** Provenance chrome — source book / mined-from label. */
  source?: string;
  /** Proficiency band ('L3' etc.) when the source row carries one. */
  proficiency?: string;
  notes?: string;
  wire: StudyCardWire;
}

/** DueCard → StudyCard. B-009: content comes from the JOINed entry fields —
 *  `face` is the card_face ENUM, only a last-resort fallback for sentence/
 *  topik rows that carry nothing better on the wire yet. */
function dueCardToStudyCard(d: DueCard): StudyCard {
  return {
    key: `due:${String(d.id)}`,
    kr: d.vocabKorean ?? d.face,
    en: d.vocabEnglish ?? '',
    exKr: d.vocabExampleKorean ?? '',
    exEn: d.vocabExampleEnglish ?? '',
    ...(d.vocabSourceBook !== undefined ? { source: d.vocabSourceBook } : {}),
    wire: { kind: 'due', snapshot: d },
  };
}

/** Dev-fixture Vocab → StudyCard (mock fallback for the due feed). */
function fixtureToStudyCard(v: Vocab): StudyCard {
  return {
    key: `fixture:${v.id}`,
    kr: v.kr,
    en: v.en,
    exKr: v.ex_kr,
    exEn: v.ex_en,
    ...(v.mined_in !== undefined ? { source: v.mined_in } : {}),
    ...(v.notes !== undefined ? { notes: v.notes } : {}),
    wire: { kind: 'local' },
  };
}

// ─────────────────────────────────────────────────────────────
// Grammar production cards (FU-NF-42 — preserved through the rework)
// ─────────────────────────────────────────────────────────────

/** A grammar production card surfaced from the due queue. Reviewing one
 *  means DRILLING it — the row deep-links into the Grammar Drill tab. */
interface GrammarProductionCard {
  cardId: number;
  /** Server dedup key for the drill — the pattern key, falling back to the
   *  display string against a pre-A4 server (see DueCard JSDoc). */
  patternKey: string;
  display: string;
  summary: string;
}

/** Both conditions guard the branch so a malformed row falls through to the
 *  vocab path rather than rendering a blank drill row. */
function isGrammarProductionCard(d: DueCard): boolean {
  return (
    d.face === 'production' &&
    d.grammar_entry_id !== null &&
    typeof d.grammarPatternDisplay === 'string' &&
    d.grammarPatternDisplay.length > 0
  );
}

function dueCardToGrammar(d: DueCard): GrammarProductionCard {
  return {
    cardId: d.id,
    patternKey: d.grammarPatternKey ?? d.grammarPatternDisplay ?? '',
    display: d.grammarPatternDisplay ?? '',
    summary: d.grammarSummaryEn ?? '',
  };
}

/** Shallow value-equality so a refetch returning the same cards preserves
 *  state identity (no needless re-render of the section). */
function sameGrammarCards(
  a: readonly GrammarProductionCard[],
  b: readonly GrammarProductionCard[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.cardId !== b[i]!.cardId || a[i]!.patternKey !== b[i]!.patternKey) {
      return false;
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────
// URL-boundary validation
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// B-013 corpus seeding (unchanged wiring, re-homed into a CollapsibleTile)
// ─────────────────────────────────────────────────────────────

/** The two vocab corpora `/vocab/cards/init` accepts. `cards/init` seeds
 *  recognition cards from a raw `vocab_entries` slice keyed on `corpus`,
 *  independent of list membership — so the action lives at page level. */
const SEED_CORPORA: readonly VocabCorpus[] = [
  'vocab_2000_beginner',
  'vocab_2000_intermediate',
];

/** Cards inserted per corpus per click — under the server's InitBodySchema
 *  max (500); bounds how much one click commits to `vocab_cards`.
 *  F-156: was 100 (× 2 corpora = 200 cards added per click, the "not 200"
 *  the ticket names) — a single tap silently dumping 200 fresh cards into
 *  the FSRS queue front-loaded the review backlog far past a sane daily
 *  session. 15 (× 2 = 30 max) keeps one click to a batch a user can
 *  actually clear. */
const SEED_LIMIT = 15;

/** Result of the last "Add to review" click — success tally or error text. */
interface SeedStatus {
  kind: 'success' | 'error';
  text: string;
}

/**
 * Cloze auto-seed loop bounds (F-208 follow-up). Enabling the toggle runs
 * `POST /vocab/cloze/seed` until the server reports `remaining: 0` — the
 * seeder is idempotent + resumable, so each call tackles the NEXT batch.
 * 500 is the route's max per run; 20 runs bound the loop at 10,000 entries
 * (far past any personal deck) so a server bug reporting a never-shrinking
 * `remaining` can't spin the client forever.
 */
const CLOZE_SEED_BATCH = 500;
const CLOZE_SEED_MAX_RUNS = 20;

// ─────────────────────────────────────────────────────────────
// Mock-fallback loaders (module scope — stable identity for the hook)
// ─────────────────────────────────────────────────────────────

async function loadDueStudyMock(): Promise<StudyCard[]> {
  const rows = await loadVocabMock();
  return rows.map(fixtureToStudyCard);
}

/** Adapt the Pass-2 bundle fixture onto the server list shape so the mock
 *  path renders through the same landing components as the real one. */
async function loadServerListsMock(): Promise<ServerVocabList[]> {
  const bundle = await loadVocabListsMock();
  return bundle.custom.map((l, i) => ({
    id: i + 1,
    name_kr: l.name,
    name_en: l.en === '' ? null : l.en,
    kind: l.kind,
    version: 1,
    entry_count: l.count,
    created_at: '',
    updated_at: '',
  }));
}

// ─────────────────────────────────────────────────────────────
// Small UI helpers
// ─────────────────────────────────────────────────────────────

/** Skeleton card placeholder. */
function SkeletonCard({ height = 240 }: { height?: number }): JSX.Element {
  return (
    <Card
      variant="default"
      aria-busy="true"
      style={{ minHeight: height, opacity: 0.55 }}
    >
      <></>
    </Card>
  );
}

/** Inline empty state (no error, just "nothing yet"). */
function EmptyCard({
  message,
  krMessage,
  hint,
}: {
  message: string;
  krMessage?: string;
  hint?: string;
}): JSX.Element {
  return (
    // F-128 devices #3/#6 — a faint 기와 roof texture + a giant, near-
    // invisible 한 watermark behind the empty-state copy (never in the a11y
    // tree: giwa is a background-image, the watermark is CSS `content`).
    <Card
      variant="flat"
      role="status"
      className="km-giwa km-hangul-watermark"
      data-glyph="韓"
    >
      <div className="km-eyebrow" style={{ marginBottom: 6 }}>
        <Bilingual en="Nothing here yet" kr="아직 없어요" />
      </div>
      <div style={{ fontSize: '0.875rem', color: 'var(--paper-dim)' }}>
        <Bilingual en={message} kr={krMessage} />
      </div>
      {hint ? (
        <div style={{ fontSize: '0.75rem', color: 'var(--paper-mute)', marginTop: 8 }}>
          {hint}
        </div>
      ) : null}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// List-detail fetch (root-owned so detail AND study derive from one fetch)
// ─────────────────────────────────────────────────────────────

interface ListDetail {
  list: ServerVocabList;
  entries: VocabListEntryRow[];
}

interface UseListDetailResult {
  data: ListDetail | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
  /** Local mutation for optimistic edits (rename header, entry removal). */
  mutate: (fn: (prev: ListDetail) => ListDetail) => void;
}

function useListDetail(listId: number | null): UseListDetailResult {
  // Settled state is tagged with the list id it belongs to; `loading` is
  // DERIVED at render time (`forId !== listId`), so the first render after
  // navigating into a list is already "loading" — no pre-effect frame where
  // a stale/empty state could flash.
  const [state, setState] = useState<{
    forId: number | null;
    data: ListDetail | null;
    error: string | null;
  }>({ forId: null, data: null, error: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (listId === null) return;
    const ctrl = new AbortController();
    vocabService
      .getListDetail(listId, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setState({
          forId: listId,
          data: { list: res.list, entries: res.entries },
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setState({
          forId: listId,
          data: null,
          error: errorMessageFor(err, 'Could not load the list.'),
        });
      });
    return () => {
      ctrl.abort();
    };
  }, [listId, tick]);

  const refetch = useCallback((): void => {
    // Untag the settled state so `loading` derives true for the re-run.
    setState((s) => ({ ...s, forId: null }));
    setTick((t) => t + 1);
  }, []);

  const mutate = useCallback(
    (fn: (prev: ListDetail) => ListDetail): void => {
      setState((s) => (s.data === null ? s : { ...s, data: fn(s.data) }));
    },
    [],
  );

  const settled = state.forId === listId;
  return {
    data: listId !== null && settled ? state.data : null,
    loading: listId !== null && !settled,
    error: listId !== null && settled ? state.error : null,
    refetch,
    mutate,
  };
}

// ─────────────────────────────────────────────────────────────
// F-113 — per-list due-aware study queue
// ─────────────────────────────────────────────────────────────

interface UseListDueResult {
  data: StudyCard[] | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * `GET /vocab/lists/:id/cards/due` — the list-study twin of the global due
 * feed. Same settled/loading shape as `useListDetail` above (tagged state +
 * derived `loading`), and the SAME `dueCardToStudyCard` adapter the global
 * due queue uses, so rating persistence (`persist()` in `StudySession`) needs
 * no per-source branch — every real card here goes through
 * `submitReview(cardId, { rating, expected_version })` exactly like the
 * global due queue.
 *
 * `listId === null` means "not currently studying a list" (the landing and
 * the plain list-detail view never need this fetch) — the effect no-ops.
 */
function useListDue(listId: number | null): UseListDueResult {
  const [state, setState] = useState<{
    forId: number | null;
    data: StudyCard[] | null;
    error: string | null;
  }>({ forId: null, data: null, error: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (listId === null) return;
    const ctrl = new AbortController();
    vocabService
      .getListDueCards(listId, undefined, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setState({
          forId: listId,
          data: res.cards.map(dueCardToStudyCard),
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setState({
          forId: listId,
          data: null,
          error: errorMessageFor(err, 'Could not load the review queue.'),
        });
      });
    return () => {
      ctrl.abort();
    };
  }, [listId, tick]);

  const refetch = useCallback((): void => {
    setState((s) => ({ ...s, forId: null }));
    setTick((t) => t + 1);
  }, []);

  const settled = state.forId === listId;
  return {
    data: listId !== null && settled ? state.data : null,
    loading: listId !== null && !settled,
    error: listId !== null && settled ? state.error : null,
    refetch,
  };
}

// ─────────────────────────────────────────────────────────────
// Review root
// ─────────────────────────────────────────────────────────────

export function Review(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // URL → view resolution, validated at the boundary. `study=1` without a
  // valid list id is meaningless and degrades to the landing.
  const listId = parseIdParam(searchParams.get('list'));
  const studyRaw = searchParams.get('study');
  const study: 'list' | 'due' | null =
    studyRaw === 'due' ? 'due'
    : studyRaw === '1' && listId !== null ? 'list'
    : null;

  // FU-NF-42: grammar production cards split out of the due queue — they
  // deep-link into the Grammar Drill tab instead of entering the vocab deck.
  const [grammarCards, setGrammarCards] = useState<
    readonly GrammarProductionCard[]
  >([]);

  // Count reconciliation (TODAY_NAV_SCOPING Part A / the "665 due" vs "0
  // cards due" bug): `due.data.length` is the LIMIT-capped page's row count
  // (default 20, further split into vocab-vs-grammar below) — it can never
  // reflect a real backlog larger than one page, and a backlog that happens
  // to skew toward grammar-production cards can leave the vocab page's
  // `.length` at literally 0 while hundreds are still due. `dueTotal` holds
  // the server's real, unbounded count (`GET /vocab/cards/due`'s new `total`
  // — the SAME WHERE predicate the page obeys, including the graduated-
  // pattern exclusion) and is the source of truth `dueCount` below reads.
  // Stays null until the real fetch settles — the mock-fallback path (DEV
  // real-call failure, or no realFn) never sets it, so `dueCount` falls back
  // to `due.data?.length` in that case, matching this page's pre-existing
  // mock-fixture behavior exactly.
  const [dueTotal, setDueTotal] = useState<number | null>(null);

  // realFn: GET /vocab/cards/due → StudyCard[] + side-effect partitions
  // grammar production cards into their own section + captures the real total.
  const dueRealFn = useCallback(async (): Promise<StudyCard[]> => {
    const { cards: rows, total } = await vocabService.getDueCardsPage();
    const grammar: GrammarProductionCard[] = [];
    const ui: StudyCard[] = [];
    for (const d of rows) {
      if (isGrammarProductionCard(d)) {
        grammar.push(dueCardToGrammar(d));
        continue;
      }
      ui.push(dueCardToStudyCard(d));
    }
    setGrammarCards((prev) => (sameGrammarCards(prev, grammar) ? prev : grammar));
    setDueTotal(total);
    return ui;
  }, []);

  // The 4th grammar-in-vocab surface (`FIX_REPORT_mobile.md`): this is the
  // Flashcards page's OWN "My lists" fetch (rendered by `LandingView` below),
  // independent of `MyVocabLists`/`ReviewVocab` — and it used to call
  // `listLists()` unfiltered, so a pre-existing grammar-kind list rendered
  // as a study-list row here too. Flashcards study VOCAB, so this surface
  // must be vocab-only like the other three. Same fix shape they got:
  // `kind: 'vocab'` narrows it server-side (`vocabService.listLists`'s doc
  // comment — also avoids the route's `limit:20` truncating a power user's
  // real vocab lists behind mixed-kind rows). The client-side
  // belt-and-suspenders lives in `LandingView`'s render (`visibleLists`),
  // mirroring `MyVocabLists`'s `visibleLists` — so a server/proxy that ever
  // dropped the query param still can't put a non-vocab list on screen.
  const listsRealFn = useCallback(
    (): Promise<ServerVocabList[]> => vocabService.listLists({ kind: 'vocab' }),
    [],
  );

  const due = useEndpointOrMock<StudyCard[]>('review:due', loadDueStudyMock, {
    realFn: dueRealFn,
  });
  const lists = useEndpointOrMock<ServerVocabList[]>(
    'review:lists',
    loadServerListsMock,
    { realFn: listsRealFn },
  );

  const detail = useListDetail(listId);
  // F-113 — only fetch the list's due-scoped queue while actually studying
  // it; the plain list-detail view and the landing never need this call.
  const listDue = useListDue(study === 'list' ? listId : null);

  // B-013 seed state (in-flight guard + last-result banner).
  const [seeding, setSeeding] = useState(false);
  const [seedStatus, setSeedStatus] = useState<SeedStatus | null>(null);
  const refetchDue = due.refetch;
  const seedReview = useCallback((): void => {
    if (seeding) return;
    setSeeding(true);
    setSeedStatus(null);
    void (async (): Promise<void> => {
      try {
        let insertedTotal = 0;
        // Sequential on purpose: each call opens its own server transaction
        // and the summed `inserted` stays trivially correct.
        for (const corpus of SEED_CORPORA) {
          const res = await vocabService.initCards({
            corpus,
            limit: SEED_LIMIT,
          });
          insertedTotal += res.inserted;
        }
        setSeedStatus({
          kind: 'success',
          text:
            insertedTotal > 0
              ? `Added ${String(insertedTotal)} card${insertedTotal === 1 ? '' : 's'} to review.`
              : "You're all caught up — every loaded word already has a review card.",
        });
        if (insertedTotal > 0) refetchDue();
      } catch (err) {
        setSeedStatus({
          kind: 'error',
          text: errorMessageFor(err, 'Could not add cards to review. Try again.'),
        });
      } finally {
        setSeeding(false);
      }
    })();
  }, [seeding, refetchDue]);

  // Clear-the-queue state (remove EVERY vocab card from review; the saved
  // words are kept — the server soft-deletes the cards only). Mirrors the
  // B-013 seed pattern above: in-flight guard + last-result banner. The
  // confirmation UI lives in LandingView (it owns the Sheet); this callback
  // only ever runs AFTER the user confirmed there.
  const [clearing, setClearing] = useState(false);
  const [clearStatus, setClearStatus] = useState<SeedStatus | null>(null);
  const clearQueue = useCallback((): void => {
    if (clearing) return;
    setClearing(true);
    setClearStatus(null);
    void (async (): Promise<void> => {
      try {
        const res = await vocabService.clearDueCards();
        setClearStatus({
          kind: 'success',
          text:
            res.cleared > 0
              ? `Removed ${String(res.cleared)} card${res.cleared === 1 ? '' : 's'} from review. Your saved words are kept.`
              : 'Your review queue was already empty.',
        });
        // Re-fetch so the due count (and the queue section) reflect reality.
        refetchDue();
      } catch (err) {
        setClearStatus({
          kind: 'error',
          text: errorMessageFor(
            err,
            "Couldn't clear the review queue. Nothing was removed — try again.",
          ),
        });
      } finally {
        setClearing(false);
      }
    })();
  }, [clearing, refetchDue]);

  // ── F-208 follow-up — cloze drills enable toggle ─────────────
  //
  // The pref lives server-side (`users.preferences.clozeEnabled`, written via
  // the field-scoped PATCH /settings/prefs/cloze-enabled) because the SERVER
  // gates the due payload on it: when off, no `cloze` object (and no answer
  // material) ships at all and every card is a plain flashcard. The toggle
  // renders on this page's landing — the study start screen — NOT the global
  // Settings page: it is a property of the flashcard study flow.
  //
  //   null  → pref not hydrated yet (initial fetch pending or failed); the
  //           toggle renders disabled so a tap can never race the load or
  //           write over an unknown server state.
  //   bool  → the persisted server value; the toggle reflects it directly.
  //
  // Enabling ALSO auto-seeds the user's cloze prompts (the F-208 seeder) so
  // there is no manual step — see `toggleCloze` for the loop contract.
  const [clozePref, setClozePref] = useState<boolean | null>(null);
  const [clozeBusy, setClozeBusy] = useState(false);
  // True only while the enable-path seed loop is running — drives the
  // "Setting up cloze drills…" line (clozeBusy alone also covers the brief
  // pref PATCH round-trips, where that copy would be wrong).
  const [clozeSeeding, setClozeSeeding] = useState(false);
  const [clozeStatus, setClozeStatus] = useState<SeedStatus | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchPrefs(ctrl.signal)
      .then((prefs) => {
        if (ctrl.signal.aborted) return;
        // `=== true` — a pre-feature server omits the field on GET (rolling
        // deploy); anything but a real true reads as off.
        setClozePref(prefs.clozeEnabled === true);
      })
      .catch(() => {
        // Pref unknown (network blip / server down): leave the toggle
        // disabled rather than render a state that might be a lie. The
        // page's other feeds surface the outage; no extra error UI here.
      });
    return () => {
      ctrl.abort();
    };
  }, []);

  const toggleCloze = useCallback(
    (next: boolean): void => {
      if (clozeBusy || clozePref === null || next === clozePref) return;
      setClozeBusy(true);
      setClozeStatus(null);
      void (async (): Promise<void> => {
        // Set once the pref PATCH lands — from then on any thrown seed run
        // has committed partial progress server-side, so the catch below
        // refetches (mirroring the aborted_upstream path) instead of leaving
        // already-seeded cards invisible until a natural refetch.
        let prefPersisted = false;
        try {
          // Persist the pref FIRST — if the write fails, nothing changed
          // server-side and the toggle stays where it was.
          await patchClozeEnabled(next);
          prefPersisted = true;
          setClozePref(next);
          if (!next) {
            // Disable: the server simply stops serving `cloze`; the prepared
            // prompts persist, so re-enabling is instant. Refetch so the
            // in-memory due page drops its cloze objects too.
            refetchDue();
            return;
          }
          // Enable: auto-seed until done. The pref STAYS true on a partial
          // run (Kiwi outage / mid-loop failure) — the seeder is idempotent
          // and resumable, so toggling off/on later resumes where it left
          // off, and already-seeded cards work meanwhile.
          setClozeSeeding(true);
          let seededTotal = 0;
          let abortedUpstream = false;
          // `remaining` from the LAST completed run — stays > 0 only when the
          // run cap below exhausted with work still outstanding.
          let remainingAfterLast = 0;
          try {
            for (let run = 0; run < CLOZE_SEED_MAX_RUNS; run++) {
              const res = await vocabService.seedClozePrompts(CLOZE_SEED_BATCH);
              // A malformed response (count missing or NaN) must not poison
              // the tally — "NaN drills ready" — so any non-finite count
              // reads as 0. For `remaining` that also EXITS the loop (0 ≤ 0)
              // rather than hammering the seeder on garbage until the cap.
              seededTotal += Number.isFinite(res.seeded) ? res.seeded : 0;
              if (res.aborted_upstream) {
                abortedUpstream = true;
                break;
              }
              remainingAfterLast = Number.isFinite(res.remaining)
                ? res.remaining
                : 0;
              if (remainingAfterLast <= 0) break;
            }
          } finally {
            setClozeSeeding(false);
          }
          // The run cap is the backstop against a server whose `remaining`
          // never shrinks; exhausting it means drills are still unprepared,
          // which deserves the same soft-retry copy as an upstream abort —
          // never the success copy.
          setClozeStatus(
            abortedUpstream || remainingAfterLast > 0
              ? {
                  kind: 'error',
                  text:
                    'Cloze drills are on, but some drills couldn’t be prepared. ' +
                    'Turn the toggle off and on later to finish setting up.',
                }
              : {
                  kind: 'success',
                  text:
                    seededTotal > 0
                      ? `Cloze drills are on — ${String(seededTotal)} drill${seededTotal === 1 ? '' : 's'} ready.`
                      : 'Cloze drills are on — your cards were already prepared.',
                },
          );
          // Refetch so the current due page picks up its cloze presentations.
          refetchDue();
        } catch (err) {
          // Either the pref write failed (state unchanged — the toggle still
          // shows the old value) or a seed call failed mid-loop (pref kept
          // true; partial seeds are committed and a re-enable resumes).
          setClozeStatus({
            kind: 'error',
            text: errorMessageFor(
              err,
              'Could not update cloze drills. Try again.',
            ),
          });
          if (prefPersisted) {
            // Seed threw mid-loop: earlier runs are committed server-side,
            // so surface them now — same as the aborted_upstream path.
            refetchDue();
          }
        } finally {
          setClozeBusy(false);
        }
      })();
    },
    [clozeBusy, clozePref, refetchDue],
  );

  const drillGrammarCard = useCallback(
    (gc: GrammarProductionCard): void => {
      navigate('/learn/grammar', {
        state: {
          drillTarget: {
            patternKey: gc.patternKey,
            display: gc.display,
            meaning: gc.summary,
          },
        },
      });
    },
    [navigate],
  );

  // Navigation helpers — every view transition is a URL change so browser
  // back/refresh behave (see header doc).
  const openList = useCallback(
    (id: number): void => {
      void navigate(`/learn/vocab?list=${String(id)}`);
    },
    [navigate],
  );
  const studyList = useCallback(
    (id: number): void => {
      void navigate(`/learn/vocab?list=${String(id)}&study=1`);
    },
    [navigate],
  );
  const studyDue = useCallback((): void => {
    void navigate('/learn/vocab?study=due');
  }, [navigate]);

  // F-061: hand the library page the open list so a word tapped there files
  // into it; the library offers the return link back to this list's URL.
  const addWordsTo = useCallback(
    (list: ServerVocabList): void => {
      navigate('/review/vocab', {
        state: { addToList: { id: list.id, name: list.name_kr } },
      });
    },
    [navigate],
  );

  const dueDeck = due.data ?? [];

  const isMock = due.isMock || lists.isMock;

  // ── View switch ──────────────────────────────────────────────
  let back: JSX.Element | null = null;
  let body: JSX.Element;

  if (study === 'due') {
    back = <BackButton to="/learn/vocab" label="Vocab lists" />;
    body = due.loading ? (
      <SkeletonCard height={360} />
    ) : due.error !== null && due.data === null ? (
      <ErrorCard
        message="The review queue couldn't be loaded."
        onRetry={due.refetch}
      />
    ) : dueDeck.length === 0 ? (
      <EmptyCard
        message="No cards are due right now."
        krMessage="지금 복습할 카드가 없어요."
        hint="Come back later, or study one of your lists."
      />
    ) : (
      <StudySession
        key="deck:due"
        deck={dueDeck}
        deckNameKr="복습 대기열"
        deckNameEn="Due for review"
        doneTo="/learn/vocab"
      />
    );
  } else if (study === 'list' && listId !== null) {
    const backTo = `/learn/vocab?list=${String(listId)}`;
    back = <BackButton to={backTo} label={detail.data?.list.name_kr ?? 'List'} />;
    // F-113: list study is due-aware now — only cards the list's FSRS due
    // queue actually surfaces, not every word in the list unconditionally.
    body = listDue.loading ? (
      <SkeletonCard height={360} />
    ) : listDue.error !== null ? (
      <ErrorCard message={listDue.error} onRetry={listDue.refetch} />
    ) : (listDue.data ?? []).length === 0 ? (
      <EmptyCard
        message="Nothing in this list is due for review right now."
        krMessage="지금 이 목록에서 복습할 카드가 없어요."
        hint="Use “Add all to review” on the list to seed cards, or check back later."
      />
    ) : (
      <StudySession
        key={`deck:list:${String(listId)}`}
        deck={listDue.data ?? []}
        deckNameKr={detail.data?.list.name_kr ?? ''}
        deckNameEn={detail.data?.list.name_en ?? ''}
        doneTo={backTo}
      />
    );
  } else if (listId !== null) {
    back = <BackButton to="/learn/vocab" label="Vocab lists" />;
    body = (
      <ListDetailView
        detail={detail}
        onStudy={() => {
          studyList(listId);
        }}
        onAddWords={addWordsTo}
        onListsChanged={lists.refetch}
      />
    );
  } else {
    body = (
      <LandingView
        lists={lists.data}
        listsLoading={lists.loading}
        listsError={lists.error !== null && lists.data === null}
        onRetryLists={lists.refetch}
        dueCount={dueTotal ?? due.data?.length ?? null}
        dueLoading={due.loading}
        dueErrored={due.error !== null && due.data === null}
        onRetryDue={due.refetch}
        grammarCards={grammarCards}
        onDrillGrammar={drillGrammarCard}
        onOpenList={openList}
        onStudyDue={studyDue}
        onCreated={(created) => {
          lists.refetch();
          // Land inside the fresh list — its natural next step is Edit →
          // Add words, which lives on the detail view.
          openList(created.id);
        }}
        seeding={seeding}
        seedStatus={seedStatus}
        onSeedReview={seedReview}
        clearing={clearing}
        clearStatus={clearStatus}
        onClearQueue={clearQueue}
        clozeEnabled={clozePref}
        clozeBusy={clozeBusy}
        clozeSeeding={clozeSeeding}
        clozeStatus={clozeStatus}
        onToggleCloze={toggleCloze}
      />
    );
  }

  return (
    // F-128 device #8 — rain-neon sheen (Night only; no-op in Day).
    <section
      className="screen km-review km-rain-sheen"
      aria-labelledby="review-title"
      style={{ position: 'relative' }}
    >
      {isMock ? <MockBadge /> : null}
      {back}
      {/* F-128 devices #4/#2 — the shared hub-header recipe (Namsan skyline
          strip + DancheongRail divider) instead of a bare `Topbar`. */}
      <PageHubHeader
        titleId="review-title"
        eyebrow={
          <Bilingual en={FLASHCARDS_NAV.eyebrow} kr={FLASHCARDS_NAV.krEyebrow} />
        }
        heading={<Bilingual en="Vocab" kr="단어 카드" />}
      />
      {body}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Landing (F-060 — lists-first)
// ─────────────────────────────────────────────────────────────

interface LandingViewProps {
  lists: ServerVocabList[] | null;
  listsLoading: boolean;
  listsError: boolean;
  onRetryLists: () => void;
  /** Vocab cards currently due; null while the feed is loading. */
  dueCount: number | null;
  dueLoading: boolean;
  dueErrored: boolean;
  onRetryDue: () => void;
  grammarCards: readonly GrammarProductionCard[];
  onDrillGrammar: (gc: GrammarProductionCard) => void;
  onOpenList: (id: number) => void;
  onStudyDue: () => void;
  onCreated: (list: ServerVocabList) => void;
  seeding: boolean;
  seedStatus: SeedStatus | null;
  onSeedReview: () => void;
  /** Bulk clear-the-queue (soft delete; words stay saved) — in-flight guard,
   *  last-result banner, and the confirmed action itself. */
  clearing: boolean;
  clearStatus: SeedStatus | null;
  onClearQueue: () => void;
  /** F-208 follow-up — cloze drills toggle. `null` = pref not hydrated yet
   *  (toggle renders disabled); `clozeBusy` spans the whole toggle action
   *  (pref write + any seeding) and disables the switch; `clozeSeeding` is
   *  true only during the enable-path seed loop and drives the "Setting
   *  up…" line; the status line reports the last toggle outcome. */
  clozeEnabled: boolean | null;
  clozeBusy: boolean;
  clozeSeeding: boolean;
  clozeStatus: SeedStatus | null;
  onToggleCloze: (next: boolean) => void;
}

function LandingView(props: LandingViewProps): JSX.Element {
  const {
    lists,
    listsLoading,
    listsError,
    onRetryLists,
    dueCount,
    dueLoading,
    dueErrored,
    onRetryDue,
    grammarCards,
    onDrillGrammar,
    onOpenList,
    onStudyDue,
    onCreated,
    seeding,
    seedStatus,
    onSeedReview,
    clearing,
    clearStatus,
    onClearQueue,
    clozeEnabled,
    clozeBusy,
    clozeSeeding,
    clozeStatus,
    onToggleCloze,
  } = props;

  // `clearStatus` keeps the section mounted after a full clear empties the
  // queue — otherwise the "Removed N cards…" confirmation would unmount with
  // the section it lives in the moment the refetched count hits zero.
  const hasDueWork =
    dueErrored ||
    (dueCount !== null && dueCount > 0) ||
    grammarCards.length > 0 ||
    clearStatus !== null;

  // Belt-and-suspenders for the 4th grammar-in-vocab surface (see the
  // `listsRealFn` doc comment on the `Review` component): the fetch is
  // already narrowed to `kind: 'vocab'` server-side, but this render-level
  // filter — mirroring `MyVocabLists`'s `visibleLists` — guarantees a
  // non-vocab list can never reach a study-list row here even if the server
  // ever ignored the param. Flashcards study vocab; this surface is
  // vocab-only by construction.
  const visibleLists = (lists ?? []).filter((l) => l.kind === 'vocab');

  // F-157 — create-list is a Sheet popup behind a "New list" trigger
  // (mirroring components/MyVocabLists.tsx's CreateListSheet), not an
  // always-visible inline form. `onClose` is stable across renders — see
  // MyVocabLists' doc comment for why an inline arrow here would silently
  // steal focus back out of the name input after the first keystroke
  // (useModalA11y's open/close effect depends on `onClose`'s identity).
  const [createOpen, setCreateOpen] = useState(false);
  const openCreate = useCallback(() => {
    setCreateOpen(true);
  }, []);
  const closeCreate = useCallback(() => {
    setCreateOpen(false);
  }, []);

  // Clear-queue confirmation Sheet. Bulk removal (even a reversible, soft
  // one) never fires off a single tap: the user must confirm a dialog that
  // states plainly that the saved words are kept. Stable callbacks for the
  // same useModalA11y-identity reason as the create sheet above.
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const openConfirmClear = useCallback(() => {
    setConfirmClearOpen(true);
  }, []);
  const closeConfirmClear = useCallback(() => {
    setConfirmClearOpen(false);
  }, []);
  const confirmClear = useCallback(() => {
    setConfirmClearOpen(false);
    onClearQueue();
  }, [onClearQueue]);

  return (
    <div className="km-review__landing">
      {/* My lists — the page's primary surface (F-060). F-128 device #1/#2:
          a CityCard signboard with the leading-edge DancheongRail. */}
      <section aria-labelledby="review-mylists-head" data-tour="vocab-lists">
        <CityCard tone="accent" rail className="km-review__lists-card">
          <div className="km-eyebrow km-review__section-head" id="review-mylists-head">
            <Bilingual kr="내 단어장" en="My lists" />
          </div>

          {/* F-157 — trigger opens the create-list Sheet popup. */}
          <div className="km-review__create-trigger">
            <Button
              variant="gold"
              size="sm"
              leadingIcon={<Icon name="plus" size={14} />}
              onClick={openCreate}
            >
              <Bilingual en="New list" kr="새 목록" compact />
            </Button>
          </div>

          {listsLoading ? (
            <SkeletonCard height={160} />
          ) : listsError ? (
            <ErrorCard
              message="Your lists couldn't be loaded."
              onRetry={onRetryLists}
            />
          ) : visibleLists.length === 0 ? (
            <EmptyCard
              message="No lists yet."
              krMessage="아직 목록이 없어요."
              hint="Tap New list above, then add words from the library."
            />
          ) : (
            <div className="km-review__lists-col">
              {visibleLists.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className="km-review__list-row km-card km-card--default focusring"
                  onClick={() => {
                    onOpenList(l.id);
                  }}
                >
                  <span className="km-review__list-row-body">
                    <span className="kr km-review__list-row-name">{l.name_kr}</span>
                    {l.name_en !== null && l.name_en !== '' ? (
                      <span className="km-review__list-row-en">{l.name_en}</span>
                    ) : null}
                  </span>
                  <Pill>
                    <Bilingual
                      en={`${String(l.entry_count)} word${l.entry_count === 1 ? '' : 's'}`}
                      kr={`단어 ${String(l.entry_count)}개`}
                      compact
                    />
                  </Pill>
                  <Icon name="chevron-right" size={16} />
                </button>
              ))}
            </div>
          )}
        </CityCard>

        <CreateListSheet open={createOpen} onClose={closeCreate} onCreated={onCreated} />
      </section>

      {/* Review queue — the FSRS due loop (Today's CTA lands here). Rendered
          below the lists per F-060's lists-first ordering; hidden entirely
          when there is nothing due and nothing failed. */}
      {dueLoading ? (
        <SkeletonCard height={90} />
      ) : hasDueWork ? (
        <section aria-labelledby="review-due-head" data-tour="vocab-study">
          <div className="km-eyebrow km-review__section-head" id="review-due-head">
            <Bilingual kr="복습 대기열" en="Review queue" />
          </div>
          {dueErrored ? (
            <ErrorCard
              message="The review queue couldn't be loaded."
              onRetry={onRetryDue}
            />
          ) : dueCount !== null && dueCount > 0 ? (
            <Card variant="accent" className="km-review__due-strip">
              <SealStamp char="復" size="sm" />
              <div className="km-review__due-body">
                <div className="km-review__due-count">
                  <Bilingual
                    en={`${String(dueCount)} card${dueCount === 1 ? '' : 's'} due`}
                    kr={`복습할 카드 ${String(dueCount)}장`}
                  />
                </div>
              </div>
              {/* Clear the whole vocab review queue — behind the confirm
                  Sheet below (bulk action, even though the server only ever
                  soft-deletes and the saved words are kept). */}
              <Button
                variant="ghost"
                size="sm"
                onClick={openConfirmClear}
                disabled={clearing}
                aria-label="Clear the review queue"
              >
                {clearing ? (
                  <Bilingual en="Clearing…" kr="비우는 중…" compact />
                ) : (
                  <Bilingual en="Clear" kr="비우기" compact />
                )}
              </Button>
              <Button
                variant="gold"
                size="md"
                leadingIcon={<Icon name="play" size={14} />}
                onClick={onStudyDue}
              >
                <Bilingual en="Study" kr="학습" compact />
              </Button>
            </Card>
          ) : null}
          {/* Clear-queue outcome: the success line doubles as the section's
              post-clear empty state ("Removed N cards … words are kept") and
              an error keeps its recourse honest — nothing was removed. */}
          {clearStatus ? (
            <div
              role={clearStatus.kind === 'error' ? 'alert' : 'status'}
              className={
                clearStatus.kind === 'error'
                  ? 'km-review__inline-error km-review__clear-status'
                  : 'km-review__clear-status'
              }
            >
              {clearStatus.text}
            </div>
          ) : null}
          {grammarCards.length > 0 ? (
            <GrammarReviewSection cards={grammarCards} onDrill={onDrillGrammar} />
          ) : null}

          <Sheet
            open={confirmClearOpen}
            onClose={closeConfirmClear}
            ariaLabel="Clear the review queue?"
          >
            <div className="km-review__sheet-body">
              <div className="km-review__sheet-head">
                <div>
                  <Eyebrow>
                    <Bilingual en="Clear review queue" kr="복습 대기열 비우기" />
                  </Eyebrow>
                  <div className="kr-display km-review__sheet-title">
                    <Bilingual
                      en="Remove all vocab cards?"
                      kr="어휘 카드를 모두 지울까요?"
                    />
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={closeConfirmClear}
                  aria-label="Close clear confirmation"
                >
                  <Icon name="close" size={14} />
                </Button>
              </div>
              <hr className="hr-double km-review__sheet-rule" />
              {/* Accurate scope (server review NIT): only VOCAB cards are
                  cleared — grammar practice cards stay in the due feed by
                  design, so the copy must not promise an empty session. */}
              <p className="km-review__clear-confirm-copy">
                <Bilingual
                  en="This removes your vocab cards from review (grammar practice cards stay) — your saved words and lists are kept, and you can add words back to review any time."
                  kr="복습에서 어휘 카드만 제거돼요 (문법 연습 카드는 남아요) — 저장한 단어와 목록은 그대로 남고, 언제든 다시 복습에 추가할 수 있어요."
                />
              </p>
              <div className="km-review__clear-confirm-actions">
                <Button variant="ghost" size="md" onClick={closeConfirmClear}>
                  <Bilingual en="Cancel" kr="취소" compact />
                </Button>
                <Button
                  variant="gold"
                  size="md"
                  onClick={confirmClear}
                  disabled={clearing}
                >
                  <Bilingual en="Clear the queue" kr="대기열 비우기" compact />
                </Button>
              </div>
            </div>
          </Sheet>
        </section>
      ) : null}

      {/* F-208 follow-up — cloze drills enable toggle. Lives HERE on the
          study start screen (not the global Settings page): it changes what
          the flashcard session serves. Always rendered — the user should be
          able to opt in before anything is due. Enabling auto-seeds the
          user's cloze prompts (busy state below); disabling just flips the
          server gate — prepared drills persist for an instant re-enable. */}
      <section aria-labelledby="review-cloze-head">
        <div className="km-eyebrow km-review__section-head" id="review-cloze-head">
          <Bilingual kr="빈칸 채우기" en="Cloze drills" />
        </div>
        <Card variant="accent" className="km-review__cloze-strip">
          <div className="km-review__cloze-body">
            <div className="km-review__cloze-title">
              <Bilingual en="Cloze drills — fill in the blank" kr="빈칸 채우기 연습" />
            </div>
            <div className="km-review__cloze-hint">
              <Bilingual
                en="Mix typed fill-in-the-blank drills into your flashcard reviews."
                kr="플래시카드 복습에 빈칸 채우기 문제를 섞어요."
                compact
              />
            </div>
          </div>
          <Toggle
            checked={clozeEnabled === true}
            onChange={onToggleCloze}
            disabled={clozeBusy || clozeEnabled === null}
            ariaLabel="Cloze drills — fill in the blank"
          />
        </Card>
        {clozeSeeding ? (
          // Only the ENABLE path seeds — this is the "preparing" busy line.
          // (During a disable, the toggle's disabled state is signal enough.)
          <div role="status" className="km-review__cloze-status">
            <Bilingual en="Setting up cloze drills…" kr="빈칸 채우기 준비 중…" compact />
          </div>
        ) : clozeStatus ? (
          <div
            role={clozeStatus.kind === 'error' ? 'alert' : 'status'}
            className={
              clozeStatus.kind === 'error'
                ? 'km-review__inline-error km-review__cloze-status'
                : 'km-review__cloze-status'
            }
          >
            {clozeStatus.text}
          </div>
        ) : null}
      </section>

      {/* B-013 corpus seeding — secondary utility, folded away by default.
          F-128 device #1/#2: CityCard signboard surface, matching the same
          treatment ReviewVocab gives its own CollapsibleTile sections. */}
      <CollapsibleTile
        title={<Bilingual en="Add to review" kr="복습에 추가" />}
        defaultCollapsed
        surface="city"
        tone="accent"
        rail
      >
        <div className="km-review__seed-body">
          <div style={{ fontSize: '0.875rem', color: 'var(--paper-dim)', marginBottom: 10 }}>
            Seed review cards from the loaded vocab corpus so they show up in
            the review queue.
          </div>
          <Button
            variant="gold"
            size="md"
            leadingIcon={<Icon name="plus" size={14} />}
            onClick={onSeedReview}
            disabled={seeding}
          >
            {seeding ? (
              <Bilingual en="Adding…" kr="추가 중…" />
            ) : (
              <Bilingual en="Add to review" kr="복습에 추가" />
            )}
          </Button>
          {seedStatus ? (
            <div
              role={seedStatus.kind === 'error' ? 'alert' : 'status'}
              className={
                seedStatus.kind === 'error' ? 'km-review__inline-error' : undefined
              }
              style={{ marginTop: 8, fontSize: '0.8125rem' }}
            >
              {seedStatus.text}
            </div>
          ) : null}
        </div>
      </CollapsibleTile>
    </div>
  );
}

/**
 * F-157 — create-a-list Sheet popup (was an always-visible inline
 * `CreateListCard`). Shares the POST /vocab/lists plumbing with the
 * library's F-048 inline create; Korean name required, English optional.
 * Hardcodes `kind: 'vocab'` — the flashcards page only ever studies vocab
 * decks, so (unlike `components/MyVocabLists.tsx`'s multi-kind mount) there
 * is no kind picker to render here at all.
 *
 * Own component, own state (not inlined in `LandingView`): keeping the
 * keystroke state OUT of the component that constructs the `<Sheet>`'s
 * `onClose` matters — see MyVocabLists.tsx's `CreateListSheet` doc comment
 * for the exact focus-stealing bug this split avoids.
 */
interface CreateListSheetProps {
  open: boolean;
  onClose: () => void;
  onCreated: (list: ServerVocabList) => void;
}

function CreateListSheet({
  open,
  onClose,
  onCreated,
}: CreateListSheetProps): JSX.Element {
  const [nameKr, setNameKr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useCallback(async (): Promise<void> => {
    const name = nameKr.trim();
    if (name === '' || creating) return;
    setCreating(true);
    setError(null);
    try {
      const en = nameEn.trim();
      const res = await vocabService.createList({
        name_kr: name,
        kind: 'vocab',
        ...(en !== '' ? { name_en: en } : {}),
      });
      setNameKr('');
      setNameEn('');
      onClose();
      onCreated(res.list);
    } catch (err) {
      setError(errorMessageFor(err, 'Could not create the list.'));
    } finally {
      setCreating(false);
    }
  }, [nameKr, nameEn, creating, onClose, onCreated]);

  return (
    <Sheet open={open} onClose={onClose} ariaLabel="New list">
      <div className="km-review__sheet-body">
        <div className="km-review__sheet-head">
          <div>
            <Eyebrow>
              <Bilingual en="New list" kr="새 목록" />
            </Eyebrow>
            <div className="kr-display km-review__sheet-title">
              <Bilingual en="Create a list" kr="목록 만들기" />
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close new list"
          >
            <Icon name="close" size={14} />
          </Button>
        </div>
        <hr className="hr-double km-review__sheet-rule" />

        <div className="km-review__create-row">
          <input
            type="text"
            value={nameKr}
            onChange={(e) => {
              setNameKr(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void create();
              }
            }}
            placeholder="New list name (Korean)"
            className="kr focusring km-review__input"
            aria-label="New list name"
            maxLength={120}
            disabled={creating}
          />
        </div>
        <input
          type="text"
          value={nameEn}
          onChange={(e) => {
            setNameEn(e.target.value);
          }}
          placeholder="English label (optional)"
          className="focusring km-review__input"
          aria-label="English label for the new list"
          maxLength={120}
          disabled={creating}
        />
        {error ? (
          <div role="alert" className="km-review__inline-error">
            {error}
          </div>
        ) : null}

        <div className="km-review__sheet-actions">
          <Button
            variant="gold"
            size="md"
            onClick={() => {
              void create();
            }}
            disabled={nameKr.trim().length === 0 || creating}
          >
            {creating ? (
              <Bilingual en="Creating…" kr="만드는 중…" />
            ) : (
              <Bilingual en="Create list" kr="목록 만들기" />
            )}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────
// Grammar production section (FU-NF-42)
// ─────────────────────────────────────────────────────────────

function GrammarReviewSection({
  cards,
  onDrill,
}: {
  cards: readonly GrammarProductionCard[];
  onDrill: (gc: GrammarProductionCard) => void;
}): JSX.Element {
  return (
    <section
      className="km-review__grammar"
      aria-labelledby="review-grammar-head"
      style={{ marginTop: 12 }}
    >
      <div
        className="km-eyebrow"
        id="review-grammar-head"
        style={{ marginBottom: 8 }}
      >
        <Bilingual
          en={`Grammar production · ${String(cards.length)} due`}
          kr={`문법 만들기 · 복습 예정 ${String(cards.length)}개`}
        />
      </div>
      <div className="km-review__grammar-col">
        {cards.map((gc) => (
          <button
            key={gc.cardId}
            type="button"
            onClick={() => {
              onDrill(gc);
            }}
            className="km-review__grammar-row km-card km-card--default focusring"
            aria-label={`Drill ${gc.display}${gc.summary ? ` — ${gc.summary}` : ''}`}
          >
            <div className="km-review__grammar-body">
              <span className="kr km-review__grammar-pattern">{gc.display}</span>
              {gc.summary ? (
                <span className="km-review__grammar-summary">{gc.summary}</span>
              ) : null}
            </div>
            <span className="km-pill km-pill--gold">
              <Bilingual en="Drill" kr="연습" compact />
            </span>
            <Icon name="chevron-right" size={16} />
          </button>
        ))}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// List detail (F-060 words + Study; F-061 edit mode)
// ─────────────────────────────────────────────────────────────

interface ListDetailViewProps {
  detail: UseListDetailResult;
  onStudy: () => void;
  onAddWords: (list: ServerVocabList) => void;
  /** Fired after a mutation so the landing's counts refresh on return. */
  onListsChanged: () => void;
}

function ListDetailView({
  detail,
  onStudy,
  onAddWords,
  onListsChanged,
}: ListDetailViewProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [nameKr, setNameKr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);
  // F-113 — bulk "add all to review" state (in-flight guard + last-result
  // banner), mirroring the landing's B-013 corpus-seeding pattern.
  const [seeding, setSeeding] = useState(false);
  const [seedStatus, setSeedStatus] = useState<SeedStatus | null>(null);

  const data = detail.data;

  // F-051-style window over the entries; max matches the server page size
  // (100). getListDetail fetches ONE page, so a list beyond 100 entries is
  // genuinely truncated here — the note below the rows states it honestly
  // instead of letting the header's full entry_count imply otherwise.
  const { visible, canShowMore, showMore, remaining } = usePagination(
    data?.entries ?? [],
    { initial: 15, step: 15, max: 100 },
  );

  const startEditing = useCallback((): void => {
    if (data === null) return;
    setNameKr(data.list.name_kr);
    setNameEn(data.list.name_en ?? '');
    setEditError(null);
    setEditing(true);
  }, [data]);

  const saveTitle = useCallback(async (): Promise<void> => {
    if (data === null || saveBusy) return;
    const nextKr = nameKr.trim();
    if (nextKr === '') {
      setEditError('The list needs a Korean name.');
      return;
    }
    const nextEn = nameEn.trim();
    const unchanged =
      nextKr === data.list.name_kr && nextEn === (data.list.name_en ?? '');
    if (unchanged) return;
    setSaveBusy(true);
    setEditError(null);
    try {
      const res = await vocabService.patchList(data.list.id, {
        name_kr: nextKr,
        // Empty string clears the caption — the PATCH contract takes null.
        name_en: nextEn === '' ? null : nextEn,
      });
      detail.mutate((prev) => ({ ...prev, list: res.list }));
      onListsChanged();
    } catch (err) {
      setEditError(errorMessageFor(err, 'Could not save the title.'));
    } finally {
      setSaveBusy(false);
    }
  }, [data, saveBusy, nameKr, nameEn, detail, onListsChanged]);

  const removeEntry = useCallback(
    async (entryId: number, itemType: ListEntryItemType): Promise<void> => {
      if (data === null) return;
      setRemovingId(entryId);
      setEditError(null);
      // Optimistic removal — drop the row immediately; restore on failure.
      // (Snapshot the COUNT too: entries may be a page of a larger list, so
      // restoring `entries.length` would corrupt the header count.)
      // F-091: match on the (item_type, entry_id) pair — this page's lists
      // are vocab-only today, but the filter is defense-in-depth against the
      // exact ambiguity the ticket names (a grammar/hanja row sharing a
      // vocab row's numeric id).
      const prevEntries = data.entries;
      const prevCount = data.list.entry_count;
      detail.mutate((prev) => ({
        ...prev,
        entries: prev.entries.filter(
          (e) => !(e.entry_id === entryId && (e.item_type ?? 'vocab') === itemType),
        ),
        list: {
          ...prev.list,
          entry_count: Math.max(0, prev.list.entry_count - 1),
        },
      }));
      try {
        await vocabService.removeListEntry(data.list.id, entryId, itemType);
        onListsChanged();
      } catch (err) {
        detail.mutate((prev) => ({
          ...prev,
          entries: prevEntries,
          list: { ...prev.list, entry_count: prevCount },
        }));
        setEditError(errorMessageFor(err, 'Could not remove the word.'));
      } finally {
        setRemovingId(null);
      }
    },
    [data, detail, onListsChanged],
  );

  // F-113 — bulk-seed a recognition card for every vocab word in this list
  // that doesn't already have one (idempotent server-side). Independent of
  // `onStudy`: seeding does not itself navigate into a session — it just
  // makes the words studyable, since `Study` is now due-only (F-113) and a
  // never-carded word is never due.
  const seedAll = useCallback(async (): Promise<void> => {
    if (data === null || seeding) return;
    setSeeding(true);
    setSeedStatus(null);
    try {
      const res = await vocabService.seedListCards(data.list.id);
      setSeedStatus({
        kind: 'success',
        text:
          res.inserted > 0
            ? `Added ${String(res.inserted)} card${res.inserted === 1 ? '' : 's'} to review.`
            : "Every word here is already in review.",
      });
    } catch (err) {
      setSeedStatus({
        kind: 'error',
        text: errorMessageFor(
          err,
          'Could not add these words to review. Try again.',
        ),
      });
    } finally {
      setSeeding(false);
    }
  }, [data, seeding]);

  if (detail.loading) return <SkeletonCard height={300} />;
  if (detail.error !== null) {
    return <ErrorCard message={detail.error} onRetry={detail.refetch} />;
  }
  if (data === null) {
    // A list id that resolved to nothing (deleted elsewhere / bad deep link).
    return (
      <EmptyCard
        message="This list doesn't exist anymore."
        krMessage="이 목록은 더 이상 없어요."
      />
    );
  }

  const studyable = data.entries.some(
    (e) => (e.korean?.trim() ?? '') !== '',
  );

  return (
    <div className="km-review__detail">
      <header className="km-review__detail-head">
        {editing ? (
          <div className="km-review__detail-title-edit">
            <input
              type="text"
              value={nameKr}
              onChange={(e) => {
                setNameKr(e.target.value);
              }}
              className="kr-display focusring km-review__input km-review__title-input"
              aria-label="List name (Korean)"
              maxLength={120}
              disabled={saveBusy}
            />
            <input
              type="text"
              value={nameEn}
              onChange={(e) => {
                setNameEn(e.target.value);
              }}
              placeholder="English label (optional)"
              className="focusring km-review__input"
              aria-label="English label"
              maxLength={120}
              disabled={saveBusy}
            />
            <Button
              variant="gold"
              size="sm"
              onClick={() => {
                void saveTitle();
              }}
              disabled={saveBusy || nameKr.trim().length === 0}
            >
              {saveBusy ? (
                <Bilingual en="Saving…" kr="저장 중…" compact />
              ) : (
                <Bilingual en="Save title" kr="제목 저장" compact />
              )}
            </Button>
          </div>
        ) : (
          <div>
            <h2 className="kr-display km-review__detail-title">
              {data.list.name_kr}
            </h2>
            <div className="km-review__detail-meta">
              {data.list.name_en ? `${data.list.name_en} · ` : ''}
              <Bilingual
                en={`${String(data.list.entry_count)} word${data.list.entry_count === 1 ? '' : 's'}`}
                kr={`단어 ${String(data.list.entry_count)}개`}
                compact
              />
            </div>
          </div>
        )}
      </header>

      {/* F-060: Study sits at the TOP of the list view. */}
      <div className="km-review__detail-actions">
        <Button
          variant="gold"
          size="md"
          leadingIcon={<Icon name="play" size={14} />}
          onClick={onStudy}
          disabled={!studyable}
          title={studyable ? undefined : 'Add words to this list first'}
        >
          <Bilingual en="Study" kr="학습" />
        </Button>
        <Button
          variant="ghost"
          size="md"
          leadingIcon={<Icon name="pen" size={14} />}
          aria-pressed={editing}
          onClick={() => {
            if (editing) {
              setEditing(false);
              setEditError(null);
            } else {
              startEditing();
            }
          }}
        >
          {editing ? (
            <Bilingual en="Done editing" kr="편집 완료" />
          ) : (
            <Bilingual en="Edit list" kr="목록 편집" />
          )}
        </Button>
        {editing ? (
          <Button
            variant="ghost"
            size="md"
            leadingIcon={<Icon name="plus" size={14} />}
            onClick={() => {
              onAddWords(data.list);
            }}
          >
            <Bilingual en="Add words" kr="단어 추가" />
          </Button>
        ) : null}
        {/* F-113 — bulk-seed every word in the list into the review deck.
            Distinct from Study: Study is now due-only, so a freshly-added
            word (no card yet) needs this before it can ever show up there. */}
        <Button
          variant="ghost"
          size="md"
          leadingIcon={<Icon name="cards" size={14} />}
          onClick={() => {
            void seedAll();
          }}
          disabled={seeding || !studyable}
          title={studyable ? undefined : 'Add words to this list first'}
        >
          {seeding ? (
            <Bilingual en="Adding…" kr="추가 중…" />
          ) : (
            <Bilingual en="Add all to review" kr="전체 복습에 추가" />
          )}
        </Button>
      </div>

      {seedStatus ? (
        <div
          role={seedStatus.kind === 'error' ? 'alert' : 'status'}
          className={
            seedStatus.kind === 'error' ? 'km-review__inline-error' : undefined
          }
          style={{ marginTop: 4, marginBottom: 8, fontSize: '0.8125rem' }}
        >
          {seedStatus.text}
        </div>
      ) : null}

      {editError ? (
        <div role="alert" className="km-review__inline-error">
          {editError}
        </div>
      ) : null}

      {data.entries.length === 0 ? (
        <EmptyCard
          message="No words in this list yet."
          krMessage="아직 단어가 없어요."
          hint="Tap Edit list → Add words to fill it from the library."
        />
      ) : (
        <>
          <Card variant="flat" className="km-review__entries">
            <ul className="km-review__entry-list">
              {visible.map((e) => {
                // F-091: default an absent item_type to 'vocab' — every row
                // on THIS page is vocab today, but the fallback matches the
                // server's own pre-049 shape rather than assuming it.
                const itemType = e.item_type ?? 'vocab';
                return (
                  <li
                    key={`${itemType}:${String(e.entry_id)}`}
                    className="km-review__entry-row"
                  >
                    <div className="km-review__entry-main">
                      <span className="kr km-review__entry-kr">
                        {e.korean ?? ''}
                      </span>
                      <span className="km-review__entry-en">{e.english ?? ''}</span>
                      {e.proficiency !== null ? (
                        <span className="km-pill km-pill--default">
                          {e.proficiency}
                        </span>
                      ) : null}
                      {editing ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            void removeEntry(e.entry_id, itemType);
                          }}
                          // ALL rows disable while any removal is in flight: a
                          // second concurrent removal's failure rollback would
                          // restore its own stale entries snapshot and resurrect
                          // the first (already-deleted) row.
                          disabled={removingId !== null}
                          aria-label={`Remove ${e.korean ?? 'word'} from the list`}
                        >
                          <Icon name="close" size={12} />
                        </Button>
                      ) : null}
                    </div>
                    {/* F-112 — the corpus example sentence, when on file. */}
                    {e.example_korean ? (
                      <div className="km-review__entry-example">
                        <span className="kr">{e.example_korean}</span>
                        {e.example_english ? (
                          <span className="km-review__entry-example-en">
                            {' '}
                            · {e.example_english}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </Card>
          <ShowMore
            canShowMore={canShowMore}
            onShowMore={showMore}
            remaining={remaining}
          />
          {/* Honest truncation: the detail fetch returns one server page
              (100 rows). A bigger list would otherwise silently hide words
              101+ from BOTH this view and the study deck while the header
              shows the full count. */}
          {data.list.entry_count > data.entries.length ? (
            <p className="km-review__entries-note">
              {`Showing the first ${String(data.entries.length)} of ${String(data.list.entry_count)} words — a study session covers these ${String(data.entries.length)}.`}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Study session (flashcards + F-062 completion)
// ─────────────────────────────────────────────────────────────

interface RatingDef {
  id: FsrsRating;
  label: string;
  kr: string;
  /** Displayed next-interval copy — pinned to the server FSRS engine's
   *  tuning (B-021): RELEARN_DELAY_MS < 1 min, HARD_STEP_DELAY_MS = 6 min,
   *  Good graduates at 1 day, Easy at 4 days. */
  sub: string;
  className: string;
}

const RATINGS: ReadonlyArray<RatingDef> = [
  { id: 'again', label: 'Again', kr: '다시', sub: '<1m', className: 'km-review__rating--again' },
  { id: 'hard', label: 'Hard', kr: '어려움', sub: '6m', className: 'km-review__rating--hard' },
  { id: 'good', label: 'Good', kr: '좋음', sub: '1d', className: 'km-review__rating--good' },
  { id: 'easy', label: 'Easy', kr: '쉬움', sub: '4d', className: 'km-review__rating--easy' },
];

const EMPTY_BREAKDOWN: Readonly<Record<FsrsRating, number>> = {
  again: 0,
  hard: 0,
  good: 0,
  easy: 0,
};

interface StudySessionProps {
  deck: StudyCard[];
  deckNameKr: string;
  deckNameEn: string;
  /** Where the completion page's Done button returns to. */
  doneTo: string;
}

// F-179 note: the study card deliberately does NOT swipe-advance — a card
// leaves the session only via an FSRS rating (never a skip gesture), and
// F-130's real targets were the carousels + PDF, not this deck. If
// swipe-advance is ever wanted, SwipeCarousel now exposes a settled-index
// `onChange` prop to build it on.
function StudySession({
  deck,
  deckNameKr,
  deckNameEn,
  doneTo,
}: StudySessionProps): JSX.Element {
  const navigate = useNavigate();
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [breakdown, setBreakdown] =
    useState<Record<FsrsRating, number>>({ ...EMPTY_BREAKDOWN });
  // Per-rating persistence bookkeeping for the F-062 completion stats.
  const [results, setResults] = useState<ReviewResult[]>([]);
  const [pendingSaves, setPendingSaves] = useState(0);
  // Failed saves are kept as (card, rating) PAIRS — not a bare counter — so
  // the completion page can re-attempt them: `entry` cards re-resolve a
  // fresh card version via the idempotent bank call, `due` cards replay
  // their snapshot (a genuine version conflict re-fails honestly).
  const [failedSaves, setFailedSaves] = useState<
    { card: StudyCard; rating: FsrsRating }[]
  >([]);
  const [localRatings, setLocalRatings] = useState(0);
  const [rateError, setRateError] = useState<string | null>(null);

  // Remove-from-review (soft delete server-side; the saved word is kept).
  // Removed cards leave the LOCAL deck too — `liveDeck` below is what every
  // count/progress/index reads, so the session never re-presents a card the
  // server already dropped from the queue. NOT optimistic: the card leaves
  // the deck only after the DELETE succeeds, so the UI never claims a
  // removal that didn't happen (`removeError` carries the honest failure).
  const [removedKeys, setRemovedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const liveDeck = deck.filter((c) => !removedKeys.has(c.key));

  const complete = idx >= liveDeck.length;
  const card = complete ? null : (liveDeck[idx] ?? null);

  // ── F-208: flashcard-vs-cloze presentation ───────────────────
  // A due card carrying a `cloze` object is randomly presented as EITHER the
  // normal flashcard OR the typed cloze drill. The coin flip happens ONCE per
  // appearance (cached by card key in a ref — re-rolling every render would
  // flicker the face mid-card); cards without `cloze` never flip. A card
  // whose cloze presentation proved unusable (404 no-prompt, 409 stale
  // version, or the learner bailed from a Kiwi outage) is pinned back to the
  // flashcard face via `clozeFallbackKeys`.
  const presentationRef = useRef<{
    key: string;
    mode: 'flashcard' | 'cloze';
  } | null>(null);
  const [clozeFallbackKeys, setClozeFallbackKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  // Fresh `version` snapshots from committing cloze grades AND saved reviews,
  // keyed by card. A cloze grade bumps the server-side version; without this,
  // a "Study again" restart (same deck prop, stale snapshots) would 409 every
  // re-rated card. A ref (not state): versions are wire bookkeeping, never
  // rendered.
  const versionBumpsRef = useRef(new Map<string, number>());

  let clozeView: {
    cardId: number;
    version: number;
    cloze: DueCardCloze;
  } | null = null;
  if (card !== null && card.wire.kind === 'due') {
    const snap = card.wire.snapshot;
    // `!= null` (not `!== undefined`): belt-and-suspenders against a server
    // ever serializing `cloze: null` — either absent form means "no cloze".
    if (snap.cloze != null && !clozeFallbackKeys.has(card.key)) {
      if (presentationRef.current?.key !== card.key) {
        // First render of this card's appearance — flip the coin and pin it.
        presentationRef.current = {
          key: card.key,
          mode: pickPresentation(snap),
        };
      }
      if (presentationRef.current.mode === 'cloze') {
        clozeView = {
          cardId: snap.id,
          version: versionBumpsRef.current.get(card.key) ?? snap.version,
          cloze: snap.cloze,
        };
      }
    }
  }
  const isCloze = clozeView !== null;

  // ── B-022: "More examples" tile state ────────────────────────
  // The tile expands UNDERNEATH the answer (the co-located CSS grid-stacks
  // the flip faces so growth pushes the rating row down instead of
  // overlaying it), carries its own close button, and auto-closes/resets on
  // any page tap or card flip.
  const cardKr = card?.kr ?? null;
  const [krdictExamples, setKrdictExamples] = useState<DefineExample[] | null>(
    null,
  );
  const [examplesLoading, setExamplesLoading] = useState(false);
  // A failed examples fetch is an ERROR, not "no additional examples" —
  // stating the latter would assert a fact the client doesn't know.
  const [examplesFailed, setExamplesFailed] = useState(false);
  const examplesCtrl = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      examplesCtrl.current?.abort();
    };
  }, [cardKr]);

  const closeDrawer = useCallback((): void => {
    examplesCtrl.current?.abort();
    setDrawer(false);
    setKrdictExamples(null);
    setExamplesLoading(false);
    setExamplesFailed(false);
  }, []);

  // Kicked off from the toggle's CLICK handler (not an effect) — React
  // allows synchronous setState in event handlers, and lazy fetching means
  // we never load examples for cards the user rates without drilling into.
  const openDrawer = (): void => {
    if (cardKr === null) return;
    examplesCtrl.current?.abort();
    const ctrl = new AbortController();
    examplesCtrl.current = ctrl;
    setDrawer(true);
    setExamplesLoading(true);
    setKrdictExamples(null);
    setExamplesFailed(false);
    defineEntry(cardKr, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setKrdictExamples(res.entries.flatMap((e) => e.examples).slice(0, 6));
        setExamplesLoading(false);
      })
      .catch((err: unknown) => {
        if (
          ctrl.signal.aborted ||
          (err instanceof ApiError && err.code === 'canceled')
        ) {
          return;
        }
        // Real error + retry (fixed copy in the drawer) — masking this as
        // "No additional examples" would state a fact we don't know.
        setExamplesFailed(true);
        setExamplesLoading(false);
      });
  };

  // Flip always resets the tile (B-022). While a remove is in flight the
  // card is frozen (no flip via tap OR spacebar) — flipping would expose the
  // rating row for a card the server is concurrently soft-deleting (SF-1).
  const flip = useCallback((): void => {
    if (removingKey !== null) return;
    setFlipped((f) => !f);
    closeDrawer();
  }, [closeDrawer, removingKey]);

  // Spacebar reveals — ignored while focus sits on anything interactive.
  // Space must ACTIVATE a focused control (a rating button, the drawer
  // toggle/close, the card itself), not cancel it and flip the card:
  // preventDefault() here used to eat the rating outright when a rating
  // button had focus.
  useEffect(() => {
    // F-208: no spacebar flip on a cloze face — there is nothing to flip,
    // and a stray Space outside the answer input must not mutate `flipped`
    // (which would surface the rating row alongside the typed drill).
    if (complete || card === null || isCloze) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== ' ' && e.key !== 'Spacebar') return;
      if (isInteractiveElement(document.activeElement)) return;
      e.preventDefault();
      flip();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [complete, card, flip, isCloze]);

  // Fire-and-forget study log on unmount, only when ≥1 card was rated.
  const [sessionStart] = useState<number>(() => Date.now());
  const reviewedRef = useRef(0);
  useEffect(() => {
    reviewedRef.current =
      breakdown.again + breakdown.hard + breakdown.good + breakdown.easy;
  });
  useEffect(() => {
    const startedAt = sessionStart;
    return () => {
      if (reviewedRef.current === 0) return;
      const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000));
      void progressService
        .logStudy({ minutes, activity: 'review' })
        .catch(() => {
          // Best-effort — a failed study log isn't actionable here.
        });
    };
  }, [sessionStart]);

  /** Persist one rating. Optimistic advance already happened; a failure
   *  surfaces inline and is tallied for the completion page rather than
   *  yanking the user back to an already-answered card. */
  const persist = useCallback((target: StudyCard, rating: FsrsRating): void => {
    if (target.wire.kind === 'local') {
      setLocalRatings((n) => n + 1);
      return;
    }
    const wire = target.wire;
    setPendingSaves((p) => p + 1);
    void (async (): Promise<void> => {
      try {
        // F-113: every real card (global due queue AND per-list study alike)
        // now carries its wire snapshot directly — the old list-only
        // bank-then-review path is gone (list study fetches the list's own
        // due-scoped queue, which already IS a real vocab_cards row).
        // F-208: prefer the freshest version snapshot we hold — a committed
        // cloze grade (or an earlier saved review) bumped the server-side
        // version past the deck prop's original snapshot, and replaying the
        // stale one (e.g. a "Study again" restart) would 409.
        const version =
          versionBumpsRef.current.get(target.key) ?? wire.snapshot.version;
        const result = await vocabService.submitReview(
          wire.snapshot.id,
          buildReviewSubmission({ ...wire.snapshot, version }, rating),
        );
        versionBumpsRef.current.set(target.key, result.version);
        setResults((prev) => [...prev, result]);
      } catch (err) {
        setFailedSaves((prev) => [...prev, { card: target, rating }]);
        setRateError(
          errorMessageFor(err, `Couldn't save the rating for “${target.kr}”.`),
        );
      } finally {
        setPendingSaves((p) => p - 1);
      }
    })();
  }, []);

  /** Re-attempt every failed save (completion-page affordance). The pairs
   *  are drained BEFORE re-persisting so a re-failure re-files rather than
   *  duplicating. */
  const retryFailedSaves = useCallback((): void => {
    const pending = failedSaves;
    if (pending.length === 0) return;
    setFailedSaves([]);
    setRateError(null);
    for (const f of pending) {
      persist(f.card, f.rating);
    }
  }, [failedSaves, persist]);

  const rate = useCallback(
    (rating: FsrsRating): void => {
      // SF-1: never rate the card currently being removed. Advancing `idx`
      // here and then losing the card from `liveDeck` when the DELETE
      // resolves would shift every later card down one and silently skip
      // the card that slid into the old index (it would also submit a
      // review against a card the server is concurrently soft-deleting).
      if (card === null || removingKey !== null) return;
      setBreakdown((prev) => ({ ...prev, [rating]: prev[rating] + 1 }));
      setFlipped(false);
      closeDrawer();
      setIdx((i) => i + 1);
      setRateError(null);
      // SF-2: moving on from a card also retires its remove-failure alert —
      // a card-specific "couldn't remove X" banner must not chase the user
      // through the rest of the session.
      setRemoveError(null);
      persist(card, rating);
    },
    [card, closeDrawer, persist, removingKey],
  );

  /**
   * F-208 — a committing cloze grade for the CURRENT card (the learner saw
   * the reveal and tapped Continue). The grade route ALREADY advanced this
   * card's FSRS schedule server-side, so this handler only mirrors the
   * outcome locally — breakdown tally, completion stats, fresh version
   * snapshot — and advances. Deliberately NO `persist()`/`submitReview`:
   * that would double-write FSRS for the same review.
   */
  const clozeCommitted = useCallback(
    (target: StudyCard, res: ClozeGradeCommittedResponse): void => {
      versionBumpsRef.current.set(target.key, res.version);
      setBreakdown((prev) => ({ ...prev, [res.rating]: prev[res.rating] + 1 }));
      setResults((prev) => [
        ...prev,
        {
          version: res.version,
          due_at: res.due_at,
          scheduled_days: res.scheduled_days,
        },
      ]);
      setFlipped(false);
      closeDrawer();
      setIdx((i) => i + 1);
      setRateError(null);
      // Same SF-2 posture as `rate`: moving on retires a stale remove alert.
      setRemoveError(null);
    },
    [closeDrawer],
  );

  /** F-208 — pin a card back to the flashcard face after its cloze
   *  presentation proved unusable (404/409, or bail-out from a 502). */
  const clozeFallback = useCallback((key: string): void => {
    setClozeFallbackKeys((prev) => new Set(prev).add(key));
  }, []);

  /** Remove the CURRENT card from the review queue (soft delete — the word
   *  stays saved; see services/vocab.removeCard). Fixture cards have no
   *  server card to remove and never render the control. On success the card
   *  leaves the local deck (the next card slides into this index — no
   *  setIdx) and, if it was the last one, the session completes. */
  const removeCurrent = useCallback((): void => {
    if (card === null || card.wire.kind !== 'due' || removingKey !== null) {
      return;
    }
    const key = card.key;
    const cardId = card.wire.snapshot.id;
    setRemovingKey(key);
    setRemoveError(null);
    void (async (): Promise<void> => {
      try {
        await vocabService.removeCard(cardId);
        setRemovedKeys((prev) => new Set(prev).add(key));
        setFlipped(false);
        closeDrawer();
      } catch (err) {
        // Honest failure: the card stays in the deck (and in the queue).
        // F-208 leak guard (fix-pass M2): on a cloze face the headword IS the
        // answer and the blank is still on screen — the failure copy must not
        // embed it (same rule as the remove button's accessible name).
        setRemoveError(
          errorMessageFor(
            err,
            isCloze
              ? "Couldn't remove this card from review — it's still in your queue."
              : `Couldn't remove “${card.kr}” from review — it's still in your queue.`,
          ),
        );
      } finally {
        setRemovingKey(null);
      }
    })();
  }, [card, removingKey, closeDrawer, isCloze]);

  const restart = useCallback((): void => {
    setIdx(0);
    setFlipped(false);
    // N1: drop the cached coin flip so "Study again" re-rolls the first
    // card's face instead of inheriting the last appearance's pin.
    presentationRef.current = null;
    closeDrawer();
    setBreakdown({ ...EMPTY_BREAKDOWN });
    setResults([]);
    setFailedSaves([]);
    setLocalRatings(0);
    setRateError(null);
    setRemoveError(null);
    // `removedKeys` deliberately survives a restart: those cards are gone
    // from the server-side queue — re-presenting them would be a lie.
  }, [closeDrawer]);

  if (complete) {
    return (
      <SessionComplete
        deckNameKr={deckNameKr}
        deckNameEn={deckNameEn}
        breakdown={breakdown}
        results={results}
        pendingSaves={pendingSaves}
        failedSaves={failedSaves.length}
        localRatings={localRatings}
        onRetrySaves={retryFailedSaves}
        onStudyAgain={restart}
        onDone={() => {
          void navigate(doneTo);
        }}
      />
    );
  }
  // `complete` is false ⇒ card is non-null; the guard keeps TS honest.
  if (card === null) return <SkeletonCard height={360} />;

  return (
    // B-022: any tap that bubbles here closes/resets the examples tile.
    // Pointer-dismiss convenience only — the tile has its own real close
    // button, so no keyboard handler is required on this wrapper.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div
      className="km-review__session"
      onClick={() => {
        if (drawer) closeDrawer();
      }}
    >
      {/* Deck strip */}
      <Card variant="default" className="km-review__strip">
        <SealStamp char="復" size="sm" />
        <div className="km-review__strip-body">
          <div className="km-eyebrow">
            <Bilingual en="Studying" kr="학습 중" />
          </div>
          <div className="kr km-review__strip-name">
            {deckNameKr}
            {deckNameEn ? (
              <span className="km-review__strip-en"> · {deckNameEn}</span>
            ) : null}
          </div>
        </div>
        <Pill>
          <Bilingual
            en={`${String(liveDeck.length)} cards`}
            kr={`카드 ${String(liveDeck.length)}장`}
            compact
          />
        </Pill>
      </Card>

      {/* Progress — F-128 device #5: the subway-line station-dot metaphor
          replaces the plain fill bar. Counts read the LIVE deck, so a
          removed card shrinks the session honestly instead of leaving a
          phantom station. */}
      <div className="km-review__progress">
        <div className="km-review__progress-meta">
          <span>
            {idx + 1} / {liveDeck.length}
          </span>
        </div>
        <SubwayProgress
          steps={liveDeck.length}
          current={idx}
          tone="accent"
          label="Session progress"
          valueText={`Card ${String(idx + 1)} of ${String(liveDeck.length)}`}
        />
      </div>

      {/* Flashcard — F-128 device #1: a CityCard-tone signboard/hanji-paper
          surface (Review.css overrides `.km-flashcard__face` under this
          scope), flip interaction unchanged.
          F-208: when the coin flip picked the cloze presentation, the typed
          ClozeCard renders INSTEAD of the Flashcard — and none of the card's
          own fields (headword, example pair) may reach the DOM, because the
          blanked sentence is typically derived from that same example and
          rendering it would leak the answer. ClozeCard receives ONLY the
          `cloze` object + card identity. `key` resets its attempt state per
          card. */}
      <div className="km-review__flashcard-wrap km-tone--accent">
        {clozeView !== null ? (
          <ClozeCard
            key={card.key}
            cardId={clozeView.cardId}
            expectedVersion={clozeView.version}
            cloze={clozeView.cloze}
            onCommitted={(res) => {
              clozeCommitted(card, res);
            }}
            onFallback={() => {
              clozeFallback(card.key);
            }}
          />
        ) : (
        <Flashcard
          flipped={flipped}
          onFlip={flip}
          front={
            <div className="km-review__front">
              {card.proficiency !== undefined ? (
                <div className="km-eyebrow">{card.proficiency}</div>
              ) : null}
              <div className="kr-display km-review__word">{card.kr}</div>
              <Button variant="ghost" size="sm">
                <Bilingual
                  en="Reveal · spacebar"
                  kr="정답 보기 · 스페이스바"
                  compact
                />
              </Button>
            </div>
          }
          back={
            // B-014: mount the answer face only while flipped, so the next
            // card's answer can't flash through the flip-back rotation and the
            // answer stays out of the a11y tree until revealed.
            flipped ? (
              <div className="km-review__back">
                <div className="km-review__back-head">
                  <div className="kr-display km-review__back-word">{card.kr}</div>
                  {card.proficiency !== undefined ? (
                    <Pill>{card.proficiency}</Pill>
                  ) : null}
                </div>
                <div className="km-review__en">{card.en}</div>
                {card.source !== undefined ? (
                  <>
                    <hr className="hr" />
                    <div>
                      <div className="km-eyebrow">
                        <Bilingual en="Seen in" kr="출처" />
                      </div>
                      <div className="km-review__source-label">{card.source}</div>
                    </div>
                  </>
                ) : null}
                {card.exKr !== '' ? (
                  <div>
                    <div className="kr km-review__ex">{card.exKr}</div>
                    <div className="km-review__ex-en">{card.exEn}</div>
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={(e) => {
                    // Stop bubbling so neither the flashcard's flip nor the
                    // page-level dismiss swallows the toggle gesture.
                    e.stopPropagation();
                    if (drawer) closeDrawer();
                    else openDrawer();
                  }}
                  className="km-btn km-btn--ghost km-btn--sm focusring km-review__drawer-btn"
                  aria-expanded={drawer}
                >
                  <Icon name="info" size={14} />{' '}
                  {drawer ? (
                    <Bilingual en="Hide examples" kr="예문 접기" compact />
                  ) : (
                    <Bilingual en="More examples" kr="예문 더 보기" compact />
                  )}
                </button>
                {drawer ? (
                  <div className="km-review__drawer">
                    <div className="km-review__drawer-head">
                      <span className="km-eyebrow">
                        <Bilingual en="Examples" kr="예문" compact />
                      </span>
                      <button
                        type="button"
                        className="km-btn km-btn--ghost km-btn--sm focusring"
                        aria-label="Close examples"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeDrawer();
                        }}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </div>
                    {examplesLoading ? (
                      <div className="km-review__drawer-en">
                        <Bilingual en="Loading examples…" kr="예문을 불러오는 중…" />
                      </div>
                    ) : examplesFailed ? (
                      <div role="alert" className="km-review__drawer-en">
                        <Bilingual
                          en="Couldn't load examples."
                          kr="예문을 불러오지 못했어요."
                        />{' '}
                        <button
                          type="button"
                          className="km-btn km-btn--ghost km-btn--sm focusring"
                          onClick={(e) => {
                            // Same bubbling hazard as the toggle: the card-wide
                            // flip and the page-level dismiss both sit above us.
                            e.stopPropagation();
                            openDrawer();
                          }}
                        >
                          <Bilingual en="Try again" kr="다시 시도" compact />
                        </button>
                      </div>
                    ) : (krdictExamples ?? []).length > 0 ? (
                      (krdictExamples ?? []).map((ex, i) => (
                        <div key={i} className="km-review__drawer-row">
                          <div className="kr">{ex.korean}</div>
                          {ex.english ? (
                            <div className="km-review__drawer-en">{ex.english}</div>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <div className="km-review__drawer-en">
                        <Bilingual
                          en="No additional examples."
                          kr="추가 예문이 없어요."
                        />
                      </div>
                    )}
                    {card.notes !== undefined ? (
                      <div className="km-review__notes">{card.notes}</div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null
          }
        />
        )}
      </div>

      {/* FSRS rating buttons — disabled while a remove is in flight (SF-1):
          the `rate` guard is the real race fix; the disabled state makes the
          frozen, pending card visible instead of silently eating taps.
          F-208: a cloze face renders NEITHER the rating row NOR the tap-to-
          reveal hint — grading comes from the typed answer, and the grade
          route already assigns the FSRS rating server-side. */}
      {isCloze ? null : flipped ? (
        <div className="km-review__ratings" role="group" aria-label="FSRS rating">
          {RATINGS.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => {
                rate(r.id);
              }}
              disabled={removingKey !== null}
              className={`km-review__rating focusring ${r.className}`}
            >
              <span className="km-review__rating-label">
                <Bilingual en={r.label} kr={r.kr} compact />
              </span>
              <span className="km-review__rating-sub">{r.sub}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="km-review__hint">
          Tap card or press <kbd className="km-review__kbd">space</kbd> to
          reveal.
        </div>
      )}
      {/* Remove-from-review — only real (due-wire) cards have a server card
          to remove; fixture cards never render the control. The stopPropagation
          keeps the tap from doubling as the page-level drawer dismiss. */}
      {card.wire.kind === 'due' ? (
        <div className="km-review__remove-row">
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<Icon name="close" size={12} />}
            onClick={(e) => {
              e.stopPropagation();
              removeCurrent();
            }}
            disabled={removingKey !== null}
            // F-208 leak guard: on a cloze face the headword IS the answer —
            // it must not surface anywhere, including this accessible name.
            aria-label={
              isCloze
                ? 'Remove this card from review'
                : `Remove ${card.kr} from review`
            }
          >
            {removingKey !== null ? (
              <Bilingual en="Removing…" kr="제거 중…" compact />
            ) : (
              <Bilingual en="Remove from review" kr="복습에서 제거" compact />
            )}
          </Button>
        </div>
      ) : null}
      {removeError ? (
        <div role="alert" className="km-review__inline-error" style={{ marginTop: 12 }}>
          {removeError}
        </div>
      ) : null}
      {rateError ? (
        <div role="alert" className="km-review__inline-error" style={{ marginTop: 12 }}>
          {rateError}
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Completion page (F-062)
// ─────────────────────────────────────────────────────────────

interface SessionCompleteProps {
  deckNameKr: string;
  deckNameEn: string;
  breakdown: Record<FsrsRating, number>;
  results: ReviewResult[];
  pendingSaves: number;
  failedSaves: number;
  localRatings: number;
  /** Re-attempt the failed rating saves (SF-5 recourse). */
  onRetrySaves: () => void;
  onStudyAgain: () => void;
  onDone: () => void;
}

function SessionComplete({
  deckNameKr,
  deckNameEn,
  breakdown,
  results,
  pendingSaves,
  failedSaves,
  localRatings,
  onRetrySaves,
  onStudyAgain,
  onDone,
}: SessionCompleteProps): JSX.Element {
  const reviewed =
    breakdown.again + breakdown.hard + breakdown.good + breakdown.easy;
  // Next-due buckets from the server's scheduled_days: 0 is a minute-scale
  // step (again <1m / hard ~6m), 1 is tomorrow, everything else is later.
  const dueSoon = results.filter((r) => r.scheduled_days === 0).length;
  const dueTomorrow = results.filter((r) => r.scheduled_days === 1).length;
  const dueLater = results.filter((r) => r.scheduled_days >= 2).length;

  return (
    <section className="km-review__complete" aria-labelledby="review-complete-head">
      <Card variant="default" className="km-review__complete-card">
        {/* F-128 device #7 — the milestone (hand-stamped) 印 treatment,
            not the plain section-anchor badge: this IS a completion mark. */}
        <SealStamp milestone char="完" size="lg" tone="accent" />
        <h2 id="review-complete-head" className="km-review__complete-title">
          <Bilingual en="Session complete" kr="세션 완료" />
        </h2>
        <div className="km-review__complete-deck kr">
          {deckNameKr}
          {deckNameEn ? (
            <span className="km-review__strip-en"> · {deckNameEn}</span>
          ) : null}
        </div>

        {/* F-128 device #9 — a mother-of-pearl shimmer accent under the
            session's one hero number (the real achievement here), used
            sparingly as the jewel, not the wallpaper: a purely decorative
            bar, never behind the readable count itself (no contrast risk
            against a moving multi-hue gradient). */}
        <span
          className="km-review__complete-shimmer km-najeon km-najeon--shimmer"
          aria-hidden="true"
        />
        <div className="km-review__complete-count">
          <Bilingual
            en={`${String(reviewed)} card${reviewed === 1 ? '' : 's'} reviewed`}
            kr={`카드 ${String(reviewed)}장 복습`}
          />
        </div>

        {/* Rating breakdown */}
        <dl className="km-review__breakdown" aria-label="Rating breakdown">
          {RATINGS.map((r) => (
            <div key={r.id} className={`km-review__break-cell ${r.className}`}>
              <dt className="km-review__rating-label">
                <Bilingual en={r.label} kr={r.kr} compact />
              </dt>
              <dd className="km-review__break-count">{breakdown[r.id]}</dd>
            </div>
          ))}
        </dl>

        {/* Next-due summary */}
        <div className="km-eyebrow" style={{ marginTop: 16, marginBottom: 6 }}>
          <Bilingual en="Next reviews" kr="다음 복습" />
        </div>
        {pendingSaves > 0 ? (
          <div role="status" className="km-review__complete-line">
            <Bilingual en="Saving your ratings…" kr="평가를 저장하는 중…" />
          </div>
        ) : results.length > 0 ? (
          <ul className="km-review__next-due">
            {dueSoon > 0 ? (
              <li>
                <Bilingual
                  en={`${String(dueSoon)} back within minutes`}
                  kr={`${String(dueSoon)}장 · 몇 분 안에 다시`}
                />
              </li>
            ) : null}
            {dueTomorrow > 0 ? (
              <li>
                <Bilingual
                  en={`${String(dueTomorrow)} due in 1 day`}
                  kr={`${String(dueTomorrow)}장 · 1일 후`}
                />
              </li>
            ) : null}
            {dueLater > 0 ? (
              <li>
                <Bilingual
                  en={`${String(dueLater)} due in 2+ days`}
                  kr={`${String(dueLater)}장 · 2일 이상 후`}
                />
              </li>
            ) : null}
          </ul>
        ) : (
          <div className="km-review__complete-line">
            <Bilingual
              en="No saved reviews this session."
              kr="이번 세션에는 저장된 복습이 없어요."
            />
          </div>
        )}
        {failedSaves > 0 ? (
          <>
            <div role="alert" className="km-review__inline-error">
              {failedSaves === 1
                ? '1 rating couldn’t be saved.'
                : `${String(failedSaves)} ratings couldn’t be saved.`}
            </div>
            <Button variant="ghost" size="sm" onClick={onRetrySaves}>
              <Bilingual en="Retry saving" kr="저장 다시 시도" compact />
            </Button>
          </>
        ) : null}
        {localRatings > 0 ? (
          <div className="km-review__complete-line" role="status">
            {`${String(localRatings)} practice rating${localRatings === 1 ? '' : 's'} (sample data — not saved).`}
          </div>
        ) : null}

        <div className="km-review__complete-actions">
          <Button
            variant="gold"
            size="md"
            leadingIcon={<Icon name="play" size={14} />}
            onClick={onStudyAgain}
          >
            <Bilingual en="Study again" kr="다시 학습" />
          </Button>
          <Button variant="ghost" size="md" onClick={onDone}>
            <Bilingual en="Done" kr="완료" />
          </Button>
        </div>
      </Card>
    </section>
  );
}

export default Review;
