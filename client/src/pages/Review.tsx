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
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BackButton } from '../components/BackButton';
import { Bilingual } from '../components/Bilingual';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { CollapsibleTile } from '../components/CollapsibleTile';
import { ErrorCard } from '../components/ErrorCard';
import { Flashcard } from '../components/Flashcard';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { Pill } from '../components/Pill';
import { SealStamp } from '../components/SealStamp';
import { ShowMore } from '../components/ShowMore';
import { Topbar } from '../components/Topbar';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { usePagination } from '../hooks/usePagination';
import { loadVocabMock, loadVocabListsMock } from '../data/mocks/review';
import * as vocabService from '../services/vocab';
import * as progressService from '../services/progress';
import { defineEntry } from '../services/define';
import { ApiError } from '../services/api';
import { buildReviewSubmission } from '../lib/reviewSubmission';
import { errorMessageFor } from '../lib/errorCopy';
import { isInteractiveElement } from '../lib/interactiveElement';
import type {
  DefineExample,
  DueCard,
  FsrsRating,
  ReviewResult,
  ServerVocabList,
  Vocab,
  VocabCorpus,
  VocabListEntryRow,
} from '../types/domain';
import './Review.css';

// ─────────────────────────────────────────────────────────────
// Study-deck model
// ─────────────────────────────────────────────────────────────

/**
 * How a rating on this card persists. `due` cards carry their wire snapshot
 * (id + version for the optimistic-concurrency echo); `entry` cards persist
 * via the idempotent bank-then-review pair; `local` cards are dev fixture
 * data — the rating counts locally and is honestly reported as unsaved.
 */
export type StudyCardWire =
  | { kind: 'due'; snapshot: DueCard }
  | { kind: 'entry'; entryId: number }
  | { kind: 'local' };

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

/** VocabListEntryRow → StudyCard. Rows with no Korean headword are skipped —
 *  a blank card front is unstudyable and would just burn a rating. */
function entryToStudyCard(e: VocabListEntryRow): StudyCard | null {
  const kr = e.korean?.trim() ?? '';
  if (kr === '') return null;
  return {
    key: `entry:${String(e.entry_id)}`,
    kr,
    en: e.english ?? '',
    exKr: '',
    exEn: '',
    ...(e.proficiency !== null ? { proficiency: e.proficiency } : {}),
    wire: { kind: 'entry', entryId: e.entry_id },
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

/** `?list=` must be a short positive integer; anything else → null (landing).
 *  Length-capped before parseInt so a hostile mile-long digit string can't
 *  reach Number territory where precision loss lies. */
function parseListIdParam(raw: string | null): number | null {
  if (raw === null || !/^\d{1,15}$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

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
 *  max (500); bounds how much one click commits to `vocab_cards`. */
const SEED_LIMIT = 100;

/** Result of the last "Add to review" click — success tally or error text. */
interface SeedStatus {
  kind: 'success' | 'error';
  text: string;
}

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
    <Card variant="flat" role="status">
      <div className="km-eyebrow" style={{ marginBottom: 6 }}>
        <Bilingual en="Nothing here yet" kr="아직 없어요" />
      </div>
      <div style={{ fontSize: 14, color: 'var(--paper-dim)' }}>
        <Bilingual en={message} kr={krMessage} />
      </div>
      {hint ? (
        <div style={{ fontSize: 12, color: 'var(--paper-mute)', marginTop: 8 }}>
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
// Review root
// ─────────────────────────────────────────────────────────────

export function Review(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // URL → view resolution, validated at the boundary. `study=1` without a
  // valid list id is meaningless and degrades to the landing.
  const listId = parseListIdParam(searchParams.get('list'));
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

  // realFn: GET /vocab/cards/due → StudyCard[] + side-effect partitions
  // grammar production cards into their own section.
  const dueRealFn = useCallback(async (): Promise<StudyCard[]> => {
    const rows = await vocabService.getDueCards();
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
    return ui;
  }, []);

  const listsRealFn = useCallback(
    (): Promise<ServerVocabList[]> => vocabService.listLists(),
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

  // List-study deck derives from the detail fetch (one fetch feeds both the
  // detail view and the session).
  const listDeck = useMemo<StudyCard[]>(
    () =>
      detail.data === null
        ? []
        : detail.data.entries
            .map(entryToStudyCard)
            .filter((c): c is StudyCard => c !== null),
    [detail.data],
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
    body = detail.loading ? (
      <SkeletonCard height={360} />
    ) : detail.error !== null ? (
      <ErrorCard message={detail.error} onRetry={detail.refetch} />
    ) : listDeck.length === 0 ? (
      <EmptyCard
        message="This list has no studyable words yet."
        krMessage="이 목록에는 학습할 단어가 아직 없어요."
        hint="Open the list and use Edit → Add words first."
      />
    ) : (
      <StudySession
        key={`deck:list:${String(listId)}`}
        deck={listDeck}
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
        dueCount={due.data?.length ?? null}
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
      />
    );
  }

  return (
    <section
      className="screen km-review"
      aria-labelledby="review-title"
      style={{ position: 'relative', padding: '0 18px 32px' }}
    >
      {isMock ? <MockBadge /> : null}
      {back}
      <Topbar krTitle="단어 카드" title="Vocab" titleId="review-title" />
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
  } = props;

  const hasDueWork =
    dueErrored || (dueCount !== null && dueCount > 0) || grammarCards.length > 0;

  return (
    <div className="km-review__landing">
      {/* My lists — the page's primary surface (F-060). */}
      <section aria-labelledby="review-mylists-head">
        <div className="km-eyebrow km-review__sectionHead" id="review-mylists-head">
          <Bilingual kr="내 단어장" en="My lists" />
        </div>

        <CreateListCard onCreated={onCreated} />

        {listsLoading ? (
          <SkeletonCard height={160} />
        ) : listsError ? (
          <ErrorCard
            message="Your lists couldn't be loaded."
            onRetry={onRetryLists}
          />
        ) : (lists ?? []).length === 0 ? (
          <EmptyCard
            message="No lists yet."
            krMessage="아직 목록이 없어요."
            hint="Create one above, then add words from the library."
          />
        ) : (
          <div className="km-review__listsCol">
            {(lists ?? []).map((l) => (
              <button
                key={l.id}
                type="button"
                className="km-review__listRow km-card km-card--default focusring"
                onClick={() => {
                  onOpenList(l.id);
                }}
              >
                <span className="km-review__listRowBody">
                  <span className="kr km-review__listRowName">{l.name_kr}</span>
                  {l.name_en !== null && l.name_en !== '' ? (
                    <span className="km-review__listRowEn">{l.name_en}</span>
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
      </section>

      {/* Review queue — the FSRS due loop (Today's CTA lands here). Rendered
          below the lists per F-060's lists-first ordering; hidden entirely
          when there is nothing due and nothing failed. */}
      {dueLoading ? (
        <SkeletonCard height={90} />
      ) : hasDueWork ? (
        <section aria-labelledby="review-due-head">
          <div className="km-eyebrow km-review__sectionHead" id="review-due-head">
            <Bilingual kr="복습 대기열" en="Review queue" />
          </div>
          {dueErrored ? (
            <ErrorCard
              message="The review queue couldn't be loaded."
              onRetry={onRetryDue}
            />
          ) : dueCount !== null && dueCount > 0 ? (
            <Card variant="accent" className="km-review__dueStrip">
              <SealStamp char="復" size="sm" />
              <div className="km-review__dueBody">
                <div className="km-review__dueCount">
                  <Bilingual
                    en={`${String(dueCount)} card${dueCount === 1 ? '' : 's'} due`}
                    kr={`복습할 카드 ${String(dueCount)}장`}
                  />
                </div>
              </div>
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
          {grammarCards.length > 0 ? (
            <GrammarReviewSection cards={grammarCards} onDrill={onDrillGrammar} />
          ) : null}
        </section>
      ) : null}

      {/* B-013 corpus seeding — secondary utility, folded away by default. */}
      <CollapsibleTile
        title={<Bilingual en="Add to review" kr="복습에 추가" />}
        defaultCollapsed
      >
        <div className="km-review__seedBody">
          <div style={{ fontSize: 14, color: 'var(--paper-dim)', marginBottom: 10 }}>
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
                seedStatus.kind === 'error' ? 'km-review__inlineError' : undefined
              }
              style={{ marginTop: 8, fontSize: 13 }}
            >
              {seedStatus.text}
            </div>
          ) : null}
        </div>
      </CollapsibleTile>
    </div>
  );
}

/** Create-a-list card (F-060; shares the POST /vocab/lists plumbing with the
 *  library's F-048 inline create). Korean name required, English optional. */
function CreateListCard({
  onCreated,
}: {
  onCreated: (list: ServerVocabList) => void;
}): JSX.Element {
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
      onCreated(res.list);
    } catch (err) {
      setError(errorMessageFor(err, 'Could not create the list.'));
    } finally {
      setCreating(false);
    }
  }, [nameKr, nameEn, creating, onCreated]);

  return (
    <Card variant="flat" className="km-review__create">
      <div className="km-review__createRow">
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
        <Button
          variant="gold"
          size="sm"
          onClick={() => {
            void create();
          }}
          disabled={nameKr.trim().length === 0 || creating}
        >
          {creating ? (
            <Bilingual en="Creating…" kr="만드는 중…" compact />
          ) : (
            <Bilingual en="Create list" kr="목록 만들기" compact />
          )}
        </Button>
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
        <div role="alert" className="km-review__inlineError">
          {error}
        </div>
      ) : null}
    </Card>
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
      <div className="km-review__grammarCol">
        {cards.map((gc) => (
          <button
            key={gc.cardId}
            type="button"
            onClick={() => {
              onDrill(gc);
            }}
            className="km-review__grammarRow km-card km-card--default focusring"
            aria-label={`Drill ${gc.display}${gc.summary ? ` — ${gc.summary}` : ''}`}
          >
            <div className="km-review__grammarBody">
              <span className="kr km-review__grammarPattern">{gc.display}</span>
              {gc.summary ? (
                <span className="km-review__grammarSummary">{gc.summary}</span>
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
    async (entryId: number): Promise<void> => {
      if (data === null) return;
      setRemovingId(entryId);
      setEditError(null);
      // Optimistic removal — drop the row immediately; restore on failure.
      // (Snapshot the COUNT too: entries may be a page of a larger list, so
      // restoring `entries.length` would corrupt the header count.)
      const prevEntries = data.entries;
      const prevCount = data.list.entry_count;
      detail.mutate((prev) => ({
        ...prev,
        entries: prev.entries.filter((e) => e.entry_id !== entryId),
        list: {
          ...prev.list,
          entry_count: Math.max(0, prev.list.entry_count - 1),
        },
      }));
      try {
        await vocabService.removeListEntry(data.list.id, entryId);
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
      <header className="km-review__detailHead">
        {editing ? (
          <div className="km-review__detailTitleEdit">
            <input
              type="text"
              value={nameKr}
              onChange={(e) => {
                setNameKr(e.target.value);
              }}
              className="kr-display focusring km-review__input km-review__titleInput"
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
            <h2 className="kr-display km-review__detailTitle">
              {data.list.name_kr}
            </h2>
            <div className="km-review__detailMeta">
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
      <div className="km-review__detailActions">
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
      </div>

      {editError ? (
        <div role="alert" className="km-review__inlineError">
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
            <ul className="km-review__entryList">
              {visible.map((e) => (
                <li key={e.entry_id} className="km-review__entryRow">
                  <span className="kr km-review__entryKr">{e.korean ?? ''}</span>
                  <span className="km-review__entryEn">{e.english ?? ''}</span>
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
                        void removeEntry(e.entry_id);
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
                </li>
              ))}
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
            <p className="km-review__entriesNote">
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

  const complete = idx >= deck.length;
  const card = complete ? null : (deck[idx] ?? null);
  const progressPct =
    deck.length > 0 ? Math.min(100, (idx / deck.length) * 100) : 0;

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

  // Flip always resets the tile (B-022).
  const flip = useCallback((): void => {
    setFlipped((f) => !f);
    closeDrawer();
  }, [closeDrawer]);

  // Spacebar reveals — ignored while focus sits on anything interactive.
  // Space must ACTIVATE a focused control (a rating button, the drawer
  // toggle/close, the card itself), not cancel it and flip the card:
  // preventDefault() here used to eat the rating outright when a rating
  // button had focus.
  useEffect(() => {
    if (complete || card === null) return;
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
  }, [complete, card, flip]);

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
        let result: ReviewResult;
        if (wire.kind === 'due') {
          result = await vocabService.submitReview(
            wire.snapshot.id,
            buildReviewSubmission(wire.snapshot, rating),
          );
        } else {
          // List card: resolve-or-create the user's recognition card
          // (idempotent on user+entry), then review it with the fresh
          // version snapshot — both existing routes.
          const banked = await vocabService.bankEntry(wire.entryId);
          result = await vocabService.submitReview(banked.card.id, {
            rating,
            expected_version: banked.card.version,
          });
        }
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
      if (card === null) return;
      setBreakdown((prev) => ({ ...prev, [rating]: prev[rating] + 1 }));
      setFlipped(false);
      closeDrawer();
      setIdx((i) => i + 1);
      setRateError(null);
      persist(card, rating);
    },
    [card, closeDrawer, persist],
  );

  const restart = useCallback((): void => {
    setIdx(0);
    setFlipped(false);
    closeDrawer();
    setBreakdown({ ...EMPTY_BREAKDOWN });
    setResults([]);
    setFailedSaves([]);
    setLocalRatings(0);
    setRateError(null);
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
        <div className="km-review__stripBody">
          <div className="km-eyebrow">
            <Bilingual en="Studying" kr="학습 중" />
          </div>
          <div className="kr km-review__stripName">
            {deckNameKr}
            {deckNameEn ? (
              <span className="km-review__stripEn"> · {deckNameEn}</span>
            ) : null}
          </div>
        </div>
        <Pill>
          <Bilingual
            en={`${String(deck.length)} cards`}
            kr={`카드 ${String(deck.length)}장`}
            compact
          />
        </Pill>
      </Card>

      {/* Progress */}
      <div className="km-review__progress">
        <div className="km-review__progressMeta">
          <span>
            {idx + 1} / {deck.length}
          </span>
        </div>
        {/* The accessible name lives ON the progressbar element — an
            aria-label on the role-less wrapper computes to nothing. */}
        <div
          className="km-review__progressBar"
          role="progressbar"
          aria-label="Session progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progressPct)}
        >
          <div
            className="km-review__progressFill"
            style={{ width: `${String(progressPct)}%` }}
          />
        </div>
      </div>

      {/* Flashcard */}
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
              <div className="km-review__backHead">
                <div className="kr-display km-review__backWord">{card.kr}</div>
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
                    <div className="km-review__sourceLabel">{card.source}</div>
                  </div>
                </>
              ) : null}
              {card.exKr !== '' ? (
                <div>
                  <div className="kr km-review__ex">{card.exKr}</div>
                  <div className="km-review__exEn">{card.exEn}</div>
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
                className="km-btn km-btn--ghost km-btn--sm focusring km-review__drawerBtn"
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
                  <div className="km-review__drawerHead">
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
                    <div className="km-review__drawerEn">
                      <Bilingual en="Loading examples…" kr="예문을 불러오는 중…" />
                    </div>
                  ) : examplesFailed ? (
                    <div role="alert" className="km-review__drawerEn">
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
                      <div key={i} className="km-review__drawerRow">
                        <div className="kr">{ex.korean}</div>
                        {ex.english ? (
                          <div className="km-review__drawerEn">{ex.english}</div>
                        ) : null}
                      </div>
                    ))
                  ) : (
                    <div className="km-review__drawerEn">
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

      {/* FSRS rating buttons */}
      {flipped ? (
        <div className="km-review__ratings" role="group" aria-label="FSRS rating">
          {RATINGS.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => {
                rate(r.id);
              }}
              className={`km-review__rating focusring ${r.className}`}
            >
              <span className="km-review__ratingLabel">
                <Bilingual en={r.label} kr={r.kr} compact />
              </span>
              <span className="km-review__ratingSub">{r.sub}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="km-review__hint">
          Tap card or press <kbd className="km-review__kbd">space</kbd> to
          reveal.
        </div>
      )}
      {rateError ? (
        <div role="alert" className="km-review__inlineError" style={{ marginTop: 12 }}>
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
      <Card variant="default" className="km-review__completeCard">
        <SealStamp char="完" size="sm" />
        <h2 id="review-complete-head" className="km-review__completeTitle">
          <Bilingual en="Session complete" kr="세션 완료" />
        </h2>
        <div className="km-review__completeDeck kr">
          {deckNameKr}
          {deckNameEn ? (
            <span className="km-review__stripEn"> · {deckNameEn}</span>
          ) : null}
        </div>

        <div className="km-review__completeCount">
          <Bilingual
            en={`${String(reviewed)} card${reviewed === 1 ? '' : 's'} reviewed`}
            kr={`카드 ${String(reviewed)}장 복습`}
          />
        </div>

        {/* Rating breakdown */}
        <dl className="km-review__breakdown" aria-label="Rating breakdown">
          {RATINGS.map((r) => (
            <div key={r.id} className={`km-review__breakCell ${r.className}`}>
              <dt className="km-review__ratingLabel">
                <Bilingual en={r.label} kr={r.kr} compact />
              </dt>
              <dd className="km-review__breakCount">{breakdown[r.id]}</dd>
            </div>
          ))}
        </dl>

        {/* Next-due summary */}
        <div className="km-eyebrow" style={{ marginTop: 16, marginBottom: 6 }}>
          <Bilingual en="Next reviews" kr="다음 복습" />
        </div>
        {pendingSaves > 0 ? (
          <div role="status" className="km-review__completeLine">
            <Bilingual en="Saving your ratings…" kr="평가를 저장하는 중…" />
          </div>
        ) : results.length > 0 ? (
          <ul className="km-review__nextDue">
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
          <div className="km-review__completeLine">
            <Bilingual
              en="No saved reviews this session."
              kr="이번 세션에는 저장된 복습이 없어요."
            />
          </div>
        )}
        {failedSaves > 0 ? (
          <>
            <div role="alert" className="km-review__inlineError">
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
          <div className="km-review__completeLine" role="status">
            {`${String(localRatings)} practice rating${localRatings === 1 ? '' : 's'} (sample data — not saved).`}
          </div>
        ) : null}

        <div className="km-review__completeActions">
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
