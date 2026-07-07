/**
 * Review screen — FSRS flashcard session + vocab lists + bank browser.
 *
 * Sub-tabs (per design README §5):
 *   - `session` — Active-list strip, progress bar, Flashcard with flip,
 *                 4 FSRS rating buttons. Spacebar reveals.
 *   - `lists`   — My lists (custom) + From sources (textbook). Opens
 *                 ListDetailSheet on row tap; New list opens CreateListSheet.
 *   - `all`     — Searchable flat list of every banked vocab item.
 *
 * Data (Pass 3 wired):
 *   useEndpointOrMock('review:due',   loadVocabMock,        getDueCards)   → Vocab[]
 *   useEndpointOrMock('review:lists', loadVocabListsMock,   listLists)     → VocabListBundle
 *   useEndpointOrMock('review:all:Q', ALL_MOCK_FROM_BANK,   searchEntries) → Vocab[]
 *
 * Mock ↔ wire shape adapters live below: `dueCardsToVocab`, `listsToBundle`,
 * `entriesToVocab`. They preserve the Pass-2 UI contract (Vocab/VocabListBundle)
 * while the network surface speaks the server's wire types (DueCard,
 * ServerVocabList, VocabEntry). The original mock fixtures are still loaded as
 * fallback when realFn rejects — `useEndpointOrMock` handles that swap.
 *
 * Threat model:
 *   - **Rendered text is escaped.** Vocab text (`kr`, `en`, `ex_kr`, `ex_en`,
 *     `notes`) renders as React children, so a server-injected `<script>` in
 *     any field becomes literal text. Never wire dangerouslySetInnerHTML here.
 *   - **submitReview is per-card state-mutating.** Server-side idempotency
 *     comes from (a) the `cardId` URL parameter (one card, one review row per
 *     submit) and (b) the `expected_version` field — a double-tap that races
 *     two submits in flight resolves on the server as: the first wins, the
 *     second 409s on stale version. Client retries on 409 by re-fetching the
 *     card and replaying the rating. For Pass 3 we surface the failure to
 *     the user and bounce the card back into the queue rather than auto-replay
 *     (auto-replay = Pass 7+). Scheduling itself is SERVER-owned: the client
 *     sends only the rating; the server derives the FSRS transition + due_at
 *     (see buildReviewSubmission).
 *   - **Optimistic UI.** `onRate` advances the index immediately so the next
 *     card paints without a network round-trip. On submitReview failure we
 *     rewind (`setIdx(prev)`) and surface a status line so the user can retry.
 *     Rollback is per-rating, not per-batch — partial session progress is OK.
 *   - **AbortController on every action call.** Sheet mounts/unmounts wire
 *     fresh controllers; closing the sheet mid-fetch aborts. The list/due
 *     refetches go through `useEndpointOrMock` which already manages abort.
 *   - **List CRUD validation.** Server enforces shape with Zod; the client
 *     trusts the TS types here. Confirm-before-delete blocks accidental
 *     destruction; no soft-undo for Pass 3 (Pass 5+ once we have a toast layer).
 *   - **PII in study log.** `logStudy` carries minutes + activity string only.
 *     No KR text, no card ids — the row is a daily roll-up keyed on user+date.
 *     Server upserts so a duplicate fire-and-forget on unmount is safe-ish
 *     (the second call doubles the minutes, which is the documented hazard in
 *     `progress.ts`'s threat model). We fire-and-forget exactly once, in the
 *     unmount cleanup.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { Topbar } from '../components/Topbar';
import { Card } from '../components/Card';
import { Pill } from '../components/Pill';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { SealStamp } from '../components/SealStamp';
import { Flashcard } from '../components/Flashcard';
import { Sheet } from '../components/Sheet';
import { MockBadge } from '../components/MockBadge';
import { ErrorCard } from '../components/ErrorCard';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import {
  loadVocabMock,
  loadVocabListsMock,
  VOCAB_FIXTURE,
} from '../data/mocks/review';
import * as vocabService from '../services/vocab';
import * as progressService from '../services/progress';
import { defineEntry } from '../services/define';
import { ApiError } from '../services/api';
import { buildReviewSubmission } from '../lib/reviewSubmission';
import { errorMessageFor } from '../lib/errorCopy';
import type {
  CreateListBody,
  CreateListResponse,
  CustomVocabList,
  DefineExample,
  DueCard,
  FsrsRating,
  ServerVocabList,
  SourceVocabGroup,
  SourceVocabListItem,
  Vocab,
  VocabCorpus,
  VocabEntry,
  VocabListBundle,
  VocabListKind,
} from '../types/domain';

type Tab = 'session' | 'lists' | 'all';
type RatingId = FsrsRating;

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'session', label: 'Session' },
  { id: 'lists', label: 'Lists' },
  { id: 'all', label: 'All cards' },
];

const SEARCH_DEBOUNCE_MS = 200;

/**
 * B-013: the two vocab corpora `/vocab/cards/init` accepts. There is no
 * server-side notion of "seed from THIS list" — `cards/init` seeds
 * recognition cards from a raw `vocab_entries` slice keyed on `corpus`
 * (+ optional `proficiency`), independent of `vocab_lists` membership. A
 * per-list "Study this list" button would therefore have to lie about which
 * words it adds (custom + source lists carry no `corpus` field — see
 * `VocabListBundle`), so the seed action lives at the Lists-tab level and
 * seeds across every known corpus in one gesture rather than pretending to
 * scope to whichever list sheet happens to be open.
 */
const SEED_CORPORA: readonly VocabCorpus[] = [
  'vocab_2000_beginner',
  'vocab_2000_intermediate',
];

/**
 * Cards inserted per corpus per click. Comfortably under the server's
 * `InitBodySchema` max (500) — big enough that a fresh user clears most of
 * their backlog in one or two clicks, small enough that a single click can't
 * flood the FSRS due queue with the entire corpus at once (the due-cards
 * fetch itself pages at 20, so accumulation is fine; this just bounds how
 * much one click commits to the `vocab_cards` table).
 */
const SEED_LIMIT = 100;

/** Result of the last "Add to review" click — success tally or error text. */
interface SeedStatus {
  kind: 'success' | 'error';
  text: string;
}

// ─────────────────────────────────────────────────────────────
// Wire ↔ UI adapters
// ─────────────────────────────────────────────────────────────

/** Encode a server numeric id as the UI's string id space. */
function encodeId(prefix: 'd' | 'e', id: number): string {
  return `${prefix}:${String(id)}`;
}

/** Decode a UI id back to a server numeric id; returns null if not server-shaped. */
function decodeId(uiId: string): number | null {
  const m = /^[de]:(\d+)$/.exec(uiId);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * FU-NF-42: a grammar production card surfaced from the due queue. Reviewing
 * one means DRILLING it (no self-rate UX) — the row deep-links into the
 * Grammar Drill tab. We carry the `patternKey` (the drill's generate key,
 * sourced from the card's `grammar_entry_id`), the Korean display, and the EN
 * summary. The numeric `cardId` is retained for keys + future use.
 */
interface GrammarProductionCard {
  cardId: number;
  /** Server dedup key for the drill — the grammar entry id, stringified. */
  patternKey: string;
  /** Korean pattern display ("-더라도"). */
  display: string;
  /** EN summary of the pattern. */
  summary: string;
}

/**
 * A due card is a grammar production card iff its face is 'production' AND the
 * due query JOINed a grammar pattern display onto it. Both conditions guard the
 * branch so a malformed row (production face but no JOINed display, or vice
 * versa) falls through to the vocab path rather than rendering a blank drill
 * row — failure-safe over the wire contract.
 */
function isGrammarProductionCard(d: DueCard): boolean {
  return (
    d.face === 'production' &&
    d.grammar_entry_id !== null &&
    typeof d.grammarPatternDisplay === 'string' &&
    d.grammarPatternDisplay.length > 0
  );
}

/** DueCard → GrammarProductionCard. Caller has already gated on the predicate. */
function dueCardToGrammar(d: DueCard): GrammarProductionCard {
  return {
    cardId: d.id,
    // The drill's generate route resolves-or-creates a grammar_entry on
    // `(user, pattern_key)`, so the deep-link MUST hand back the original
    // `pattern_key` to advance the SAME production card. Prefer the server's
    // `grammarPatternKey` when present (A4 must alias it — see DueCard JSDoc);
    // fall back to the display string so the deep-link still navigates against
    // a pre-bump server, with the round-trip becoming exact once A4 ships.
    patternKey: d.grammarPatternKey ?? d.grammarPatternDisplay ?? '',
    display: d.grammarPatternDisplay ?? '',
    summary: d.grammarSummaryEn ?? '',
  };
}

/**
 * Shallow value-equality for two grammar-card lists, so a refetch that returns
 * the same cards preserves the state identity (no needless re-render). Compares
 * cardId + patternKey positionally — enough to detect a real change without a
 * deep walk of the summary strings.
 */
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

/**
 * DueCard → Vocab (UI).
 *
 * B-009: the card front/back must come from the JOINed vocab-entry fields —
 * `d.face` is the card_face ENUM ('recognition' | 'production' | 'cloze'),
 * NOT the word, so rendering it put English-ish text on both sides of the
 * flashcard with an empty gloss/example/source. Front = the entry's Korean
 * headword; back = English gloss + example pair + source book. The `face`
 * fallback only fires for a non-vocab card that slipped past the grammar
 * branch (sentence/topik — nothing better is on the wire yet), preserving the
 * old degraded rendering rather than a blank card.
 */
function dueCardToVocab(d: DueCard): Vocab {
  return {
    id: encodeId('d', d.id),
    kr: d.vocabKorean ?? d.face,
    pos: 'n.',
    en: d.vocabEnglish ?? '',
    ex_kr: d.vocabExampleKorean ?? '',
    ex_en: d.vocabExampleEnglish ?? '',
    mined_in: d.vocabSourceBook,
  };
}

/** VocabEntry → Vocab (UI). Used by the All panel's search results. */
function vocabEntryToVocab(e: VocabEntry): Vocab {
  return {
    id: encodeId('e', e.id),
    kr: e.korean ?? '',
    // VocabEntry doesn't carry POS; UI's closed PoS set is display polish only.
    pos: 'n.',
    en: e.english ?? '',
    ex_kr: '',
    ex_en: '',
    mined_in: e.theme ?? undefined,
  };
}

/** ServerVocabList[] → VocabListBundle. Sources stay empty for Pass 3 (Pass 4+). */
function serverListsToBundle(rows: ServerVocabList[]): VocabListBundle {
  const custom: CustomVocabList[] = rows.map((r) => ({
    id: encodeId('e', r.id),
    name: r.name_kr,
    en: r.name_en ?? '',
    kind: r.kind,
    count: r.entry_count,
    mature: 0,
    due: 0,
    lastStudied: '',
    preview: [],
  }));
  return {
    active: custom[0]?.id ?? '',
    custom,
    sources: [],
  };
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

/** Hanji-styled inline empty state (no error, just "nothing yet"). */
function EmptyCard({
  message,
  hint,
}: {
  message: string;
  hint?: string;
}): JSX.Element {
  return (
    <Card variant="flat" role="status">
      <div className="km-eyebrow" style={{ marginBottom: 6 }}>
        Nothing here yet
      </div>
      <div style={{ fontSize: 14, color: 'var(--paper-dim)' }}>
        {message}
      </div>
      {hint ? (
        <div
          style={{
            fontSize: 12,
            color: 'var(--paper-mute)',
            marginTop: 8,
          }}
        >
          {hint}
        </div>
      ) : null}
    </Card>
  );
}

/** Resolve the active list across both custom + source list buckets. */
function findActiveList(
  bundle: VocabListBundle,
): CustomVocabList | SourceVocabListItem | null {
  const custom = bundle.custom.find((l) => l.id === bundle.active);
  if (custom) return custom;
  for (const s of bundle.sources) {
    const found = s.lists.find((l) => l.id === bundle.active);
    if (found) return found;
  }
  return bundle.custom[0] ?? null;
}

// ─────────────────────────────────────────────────────────────
// Stable mock-fallback loaders
// ─────────────────────────────────────────────────────────────
// Defined at module scope so the hook's effect doesn't churn on every render.

/**
 * Mock-fallback for the All panel — client-side filter over the bank fixture.
 * Real searchEntries() runs server-side; this returns the fixture filtered by
 * a case-insensitive substring match across KR/EN so the demo still feels
 * like a search box.
 */
function makeLoadAllMock(query: string): () => Promise<Vocab[]> {
  return async (): Promise<Vocab[]> => {
    const norm = query.trim().toLowerCase();
    if (!norm) return VOCAB_FIXTURE;
    return VOCAB_FIXTURE.filter(
      (c) =>
        c.kr.includes(query.trim()) || c.en.toLowerCase().includes(norm),
    );
  };
}

// ─────────────────────────────────────────────────────────────
// Review root
// ─────────────────────────────────────────────────────────────

export function Review(): JSX.Element {
  const navigate = useNavigate();

  // Track DueCard snapshots keyed by their UI-encoded id so the rate handler
  // can reach the wire payload it needs for submitReview. Populated by the
  // realFn adapter on each successful fetch. Stable across renders.
  const dueCardIndex = useRef<Map<string, DueCard>>(new Map());

  // FU-NF-42: grammar production cards split out of the due queue. These render
  // as a distinct Review section and deep-link into the Grammar Drill tab
  // (reviewing = drilling), so they never enter the vocab flashcard deck. The
  // realFn below populates this from the latest fetch; the mock fallback never
  // sets it, so 🅂/mock parity is preserved (the section simply stays empty).
  const [grammarCards, setGrammarCards] = useState<readonly GrammarProductionCard[]>(
    [],
  );

  // Capture session start so logStudy on unmount can report duration. We
  // use `useState`'s lazy initializer (allowed by `react-hooks/purity` —
  // refs initialized with impure calls are not). The value never changes
  // after mount so no setter is needed.
  const [sessionStart] = useState<number>(() => Date.now());

  // realFn: GET /vocab/cards/due → Vocab[] (UI shape) + side-effect populates
  // the dueCardIndex so onRate can resolve cardId + wire snapshot.
  const dueRealFn = useCallback(async (): Promise<Vocab[]> => {
    const rows = await vocabService.getDueCards();
    const next = new Map<string, DueCard>();
    const grammar: GrammarProductionCard[] = [];
    const ui: Vocab[] = [];
    for (const d of rows) {
      // FU-NF-42: route grammar production cards to their own section so the
      // vocab flashcard deck stays exactly as it was. Everything else (vocab,
      // sentence, topik recognition cards) flows through the existing path.
      if (isGrammarProductionCard(d)) {
        grammar.push(dueCardToGrammar(d));
        continue;
      }
      const v = dueCardToVocab(d);
      next.set(v.id, d);
      ui.push(v);
    }
    dueCardIndex.current = next;
    // Setting state from the realFn mirrors the existing `dueCardIndex` ref
    // population — both are side effects of a successful fetch that the hook
    // drives from its effect. Identity-stable when nothing changed so a
    // refetch returning the same grammar set doesn't churn the section.
    setGrammarCards((prev) => (sameGrammarCards(prev, grammar) ? prev : grammar));
    return ui;
  }, []);

  // realFn: GET /vocab/lists → VocabListBundle.
  const listsRealFn = useCallback(async (): Promise<VocabListBundle> => {
    const rows = await vocabService.listLists();
    return serverListsToBundle(rows);
  }, []);

  const vocab = useEndpointOrMock<Vocab[]>('review:due', loadVocabMock, {
    realFn: dueRealFn,
  });
  const lists = useEndpointOrMock<VocabListBundle>(
    'review:lists',
    loadVocabListsMock,
    { realFn: listsRealFn },
  );

  const [tab, setTab] = useState<Tab>('session');
  const [idx, setIdx] = useState<number>(0);
  const [flipped, setFlipped] = useState<boolean>(false);
  const [drawer, setDrawer] = useState<boolean>(false);
  const [openListId, setOpenListId] = useState<string | null>(null);
  const [creating, setCreating] = useState<boolean>(false);
  // Two-tier search state. `searchInput` mirrors the live <input>; `searchQ`
  // is the 200ms-debounced value that drives the keyed network fetch.
  const [searchInput, setSearchInput] = useState<string>('');
  const [searchQ, setSearchQ] = useState<string>('');
  // Pass-2 FSRS-shape rating storage. Map keyed by UI card id; surfaces the
  // most recent rating to render "Last rating: Good" hints.
  const [ratings, setRatings] = useState<ReadonlyMap<string, RatingId>>(
    () => new Map(),
  );
  // Surface submitReview failures inline so the gesture isn't silently lost.
  // Cleared on the next successful rating.
  const [rateError, setRateError] = useState<string | null>(null);

  // B-013 "Add to review": in-flight guard + last-result banner for the
  // Lists-tab seed action. `seeding` disables the button so a second click
  // mid-request can't double-fire (cards/init is idempotent server-side, so
  // a double-fire wouldn't corrupt data, but it would burn a redundant round
  // trip and briefly show a stale count).
  const [seeding, setSeeding] = useState<boolean>(false);
  const [seedStatus, setSeedStatus] = useState<SeedStatus | null>(null);

  // Debounce the All-panel query — matches Reference/Settings pattern.
  useEffect(() => {
    const handle = setTimeout(() => {
      setSearchQ(searchInput);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [searchInput]);

  const cards = vocab.data ?? [];
  // D-B2 fix: no modulo wrap. When idx exceeds the deck, the SessionPanel
  // renders a "Session complete" terminal state. Clamping progressPct keeps
  // the progressbar's ARIA contract (aria-valuenow ≤ aria-valuemax).
  const sessionComplete = cards.length > 0 && idx >= cards.length;
  const card = sessionComplete ? null : (cards[idx] ?? null);
  const progressPct = cards.length > 0
    ? Math.min(100, (idx / cards.length) * 100)
    : 0;

  // Spacebar reveals the flashcard back. Only active on session tab + when a
  // card is loaded. Listener scoped to window; ignored when an input/textarea
  // has focus AND when any Sheet is open (the Sheet's modal trap shouldn't
  // bleed reveal keystrokes back to the underlying card).
  const anySheetOpen = openListId !== null || creating;
  useEffect(() => {
    if (tab !== 'session' || !card || anySheetOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== ' ' && e.key !== 'Spacebar') return;
      const active = document.activeElement;
      const tag = active?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      setFlipped((f) => !f);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [tab, card, anySheetOpen]);

  // Fire-and-forget study log on unmount. The duration is wall-clock since
  // mount, not active-engagement time — Pass 7+ can refine with a focus/blur
  // gate. Defensive: only log if at least one card was rated (otherwise we
  // bias the daily roll-up with idle opens).
  const ratingsRef = useRef<ReadonlyMap<string, RatingId>>(ratings);
  // Sync the latest ratings snapshot into a ref from an effect (per
  // useEndpointOrMock's ref-swap pattern) — keeps a render-time assignment
  // from tripping `react-hooks/refs`.
  useEffect(() => {
    ratingsRef.current = ratings;
  });
  useEffect(() => {
    // Capture session start at effect time so the cleanup closes over a
    // stable value, sidestepping `react-hooks/exhaustive-deps`'s warning
    // about reading `ref.current` in cleanup.
    const startedAt = sessionStart;
    return () => {
      const ratingCount = ratingsRef.current.size;
      if (ratingCount === 0) return;
      const elapsedMs = Date.now() - startedAt;
      const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
      void progressService
        .logStudy({ minutes, activity: 'review' })
        .catch(() => {
          // Best-effort. Failure to log study time isn't actionable here.
        });
    };
  }, [sessionStart]);

  const rate = useCallback(
    (id: RatingId): void => {
      if (!card) return;
      const prevIdx = idx;
      const prevRatings = ratings;
      // Optimistic: record the rating + advance immediately so the next card
      // paints without waiting on the server.
      setRatings((prev) => {
        const next = new Map(prev);
        next.set(card.id, id);
        return next;
      });
      setFlipped(false);
      setDrawer(false);
      setIdx((i) => i + 1);
      setRateError(null);

      // Resolve the wire payload. If this card was sourced from the mock
      // fallback (no DueCard snapshot in the index), there's nothing to send;
      // we still count it locally — the screen is functional offline.
      const snapshot = dueCardIndex.current.get(card.id);
      const numericId = decodeId(card.id);
      if (!snapshot || numericId === null) return;

      // submitReview is fire-and-forget from the user's perspective — the
      // optimistic advance has already happened. We don't pass an
      // AbortController because the underlying axios call is short-lived
      // and idempotent (server keys on cardId + expected_version); a
      // late-arriving 200 is harmless.
      const payload = buildReviewSubmission(snapshot, id);
      // Snapshot the in-flight position so the failure path can detect a
      // double-tap race: if the user has rated another card before this
      // promise settled, the right behaviour is to surface the error
      // inline but NOT roll back to a stale position (that would erase
      // their newer progress).
      const ratedCardId = card.id;
      vocabService
        .submitReview(numericId, payload)
        .catch((err: unknown) => {
          const msg =
            errorMessageFor(err, 'Could not save the rating. Try again.');
          setRateError(msg);
          // Only roll back if no rating has landed for a later card since.
          // The simplest detector: the most-recent rating in the Map is
          // still keyed by `ratedCardId`. If a later card was rated, the
          // user's view of "current card" has moved past us.
          setIdx((cur) => (cur === prevIdx + 1 ? prevIdx : cur));
          setRatings((cur) => {
            const lastKey = Array.from(cur.keys()).pop();
            if (lastKey !== ratedCardId) return cur;
            return prevRatings;
          });
        });
    },
    [card, idx, ratings],
  );

  // FU-NF-42: activating a grammar production card = drilling it. Deep-link
  // into the Grammar Drill tab with the pattern in router state; the Grammar
  // screen reads `location.state.drillTarget`, opens the Drill tab focused on
  // it, generates a drill, and on submit the server re-schedules the card —
  // which drops it from this queue on the next fetch. No self-rate UX here.
  const drillGrammarCard = useCallback(
    (gc: GrammarProductionCard): void => {
      navigate('/grammar', {
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

  // Retry routes through both fetches' refetch — both are needed by
  // the session, and either failing should block render.
  const retry = useCallback((): void => {
    vocab.refetch();
    lists.refetch();
  }, [vocab, lists]);

  const refetchLists = lists.refetch;
  const refetchDue = vocab.refetch;

  // B-013 "Add to review": seed recognition cards from every known vocab
  // corpus, then refetch the due queue so the Session tab picks the new
  // cards up without a manual "Start new session" tap. Sequential (not
  // Promise.all) — each call opens its own server-side transaction, and
  // running them one at a time keeps the summed `inserted` count trivially
  // correct without worrying about concurrent-request ordering.
  const seedReview = useCallback((): void => {
    if (seeding) return;
    setSeeding(true);
    setSeedStatus(null);
    void (async (): Promise<void> => {
      try {
        let insertedTotal = 0;
        for (const corpus of SEED_CORPORA) {
          const res = await vocabService.initCards({
            corpus,
            limit: SEED_LIMIT,
          });
          insertedTotal += res.inserted;
        }
        // `cards/init` is idempotent (NOT EXISTS on user+entry+face) — a
        // fully-seeded user gets `inserted: 0` back, not an error. Word the
        // banner accordingly rather than reporting a false "Added 0 cards".
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
          text:
            errorMessageFor(err, 'Could not add cards to review. Try again.'),
        });
      } finally {
        setSeeding(false);
      }
    })();
  }, [seeding, refetchDue]);

  const isMock = vocab.isMock || lists.isMock;
  const lastRating: RatingId | null = card ? ratings.get(card.id) ?? null : null;

  return (
    <section
      className="screen km-review"
      aria-labelledby="review-title"
      style={{ position: 'relative', padding: '0 18px 32px' }}
    >
      {isMock ? <MockBadge /> : null}

      <Topbar
        krTitle={<span id="review-title">복습 · Review</span>}
        eyebrow="SRS · FSRS-style scheduling"
      />

      {/* Tabs ─────────────────────────────────────────────── */}
      <div
        className="km-review__tabs"
        role="tablist"
        aria-label="Review section"
      >
        {TABS.map((t) => {
          const selected = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={`km-review__tab focusring${selected ? ' km-review__tab--active' : ''}`}
              onClick={() => {
                setTab(t.id);
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Tab body ──────────────────────────────────────────── */}
      {tab === 'session' ? (
        <SessionPanel
          loading={vocab.loading || lists.loading}
          // Distinguish four states post-load:
          //   - fetch errored → ErrorCard with Retry.
          //   - fetch succeeded but bank is empty → EmptyCard, no retry.
          //   - happy path → flashcard.
          //   - all cards rated → "Session complete" + Start-new-session CTA.
          fetchErrored={
            (!vocab.data && vocab.error !== null) ||
            (!lists.data && lists.error !== null)
          }
          bankEmpty={
            !vocab.loading && !lists.loading && cards.length === 0 &&
            vocab.error === null && lists.error === null
          }
          sessionComplete={sessionComplete}
          onStartNewSession={() => {
            // Reset the cursor + clear the per-session ratings hint so the
            // next session starts clean. Refetching the due-cards hook
            // pulls a fresh page from the server.
            setIdx(0);
            setFlipped(false);
            setDrawer(false);
            setRatings(new Map());
            setRateError(null);
            vocab.refetch();
          }}
          card={card}
          cards={cards}
          idx={idx}
          progressPct={progressPct}
          flipped={flipped}
          drawer={drawer}
          lastRating={lastRating}
          rateError={rateError}
          grammarCards={grammarCards}
          onDrillGrammar={drillGrammarCard}
          activeList={lists.data ? findActiveList(lists.data) : null}
          onFlip={() => {
            setFlipped((f) => !f);
          }}
          onToggleDrawer={() => {
            setDrawer((d) => !d);
          }}
          onRate={rate}
          onRetry={retry}
        />
      ) : null}

      {tab === 'lists' ? (
        <ListsPanel
          loading={lists.loading}
          bundle={lists.data}
          onOpenList={(id) => {
            setOpenListId(id);
          }}
          onCreate={() => {
            setCreating(true);
          }}
          onRetry={retry}
          onSeedReview={seedReview}
          seeding={seeding}
          seedStatus={seedStatus}
        />
      ) : null}

      {tab === 'all' ? (
        <AllPanel
          query={searchInput}
          debouncedQuery={searchQ}
          onQuery={setSearchInput}
        />
      ) : null}

      {/* Sheets ────────────────────────────────────────────── */}
      <ListDetailSheet
        open={openListId !== null}
        listId={openListId}
        bundle={lists.data}
        onClose={() => {
          setOpenListId(null);
        }}
        onDeleted={() => {
          setOpenListId(null);
          refetchLists();
        }}
        onRenamed={refetchLists}
      />
      <CreateListSheet
        open={creating}
        onClose={() => {
          setCreating(false);
        }}
        onCreated={() => {
          setCreating(false);
          refetchLists();
        }}
      />
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Session sub-panel
// ─────────────────────────────────────────────────────────────

interface SessionPanelProps {
  loading: boolean;
  /** True iff the fetch errored AND we have no data to show. */
  fetchErrored: boolean;
  /** True iff the fetch succeeded but the bank has zero cards. */
  bankEmpty: boolean;
  /** True iff every card in the loaded session has been rated. */
  sessionComplete: boolean;
  /** Reset cursor + refetch the due-cards hook for a new session. */
  onStartNewSession: () => void;
  card: Vocab | null;
  cards: ReadonlyArray<Vocab>;
  idx: number;
  progressPct: number;
  flipped: boolean;
  drawer: boolean;
  /** Most recent rating recorded for the current card. */
  lastRating: RatingId | null;
  /** Inline error from the last submitReview attempt; null when none. */
  rateError: string | null;
  /** FU-NF-42: grammar production cards due — rendered as a distinct section. */
  grammarCards: readonly GrammarProductionCard[];
  /** Activate a grammar production card → deep-link into the Grammar Drill tab. */
  onDrillGrammar: (gc: GrammarProductionCard) => void;
  activeList: CustomVocabList | SourceVocabListItem | null;
  onFlip: () => void;
  onToggleDrawer: () => void;
  onRate: (id: RatingId) => void;
  onRetry: () => void;
}

interface RatingDef {
  id: RatingId;
  label: string;
  sub: string;
  className: string;
}

const RATINGS: ReadonlyArray<RatingDef> = [
  { id: 'again', label: 'Again', sub: '<1m', className: 'km-review__rating--again' },
  { id: 'hard', label: 'Hard', sub: '6m', className: 'km-review__rating--hard' },
  { id: 'good', label: 'Good', sub: '1d', className: 'km-review__rating--good' },
  { id: 'easy', label: 'Easy', sub: '4d', className: 'km-review__rating--easy' },
];

function SessionPanel(props: SessionPanelProps): JSX.Element {
  const {
    loading,
    fetchErrored,
    bankEmpty,
    card,
    cards,
    idx,
    progressPct,
    flipped,
    drawer,
    lastRating,
    rateError,
    grammarCards,
    onDrillGrammar,
    activeList,
    onFlip,
    onToggleDrawer,
    onRate,
    onRetry,
  } = props;

  // F-UP-008: the "More examples" drawer used to be a dead affordance (`extra`
  // is always []). Lazily fetch KRDICT example sentences for the current word
  // when the drawer OPENS — lazy so we never load examples for the many cards a
  // user rates without drilling into.
  //
  // The fetch is kicked off from the drawer button's CLICK handler
  // (`loadExamplesForOpen`), not from an effect: React allows synchronous
  // setState in event handlers but not in effect bodies
  // (react-hooks/set-state-in-effect — a synchronous set in an effect triggers a
  // cascading render). The effect below holds only the abort cleanup (no
  // setState in its body), keyed on `cardKr` so advancing the deck aborts an
  // in-flight fetch; unmount aborts too.
  const cardKr = card?.kr ?? null;
  const [krdictExamples, setKrdictExamples] = useState<DefineExample[] | null>(
    null,
  );
  const [examplesLoading, setExamplesLoading] = useState(false);
  const examplesCtrl = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      examplesCtrl.current?.abort();
    };
  }, [cardKr]);

  const loadExamplesForOpen = (): void => {
    if (cardKr === null) {
      return;
    }
    examplesCtrl.current?.abort();
    const ctrl = new AbortController();
    examplesCtrl.current = ctrl;
    setExamplesLoading(true);
    setKrdictExamples(null);
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
        setKrdictExamples([]); // degrade to "no additional examples"
        setExamplesLoading(false);
      });
  };

  if (loading) return <SkeletonCard height={360} />;
  if (fetchErrored) {
    return (
      <ErrorCard
        message="The review session couldn't be loaded."
        onRetry={onRetry}
      />
    );
  }
  const hasGrammar = grammarCards.length > 0;
  // The grammar production section renders above the vocab flashcard whenever
  // any grammar card is due — independent of the vocab deck's state.
  const grammarSection = hasGrammar ? (
    <GrammarReviewSection cards={grammarCards} onDrill={onDrillGrammar} />
  ) : null;

  // When the vocab deck is empty/exhausted BUT grammar cards remain, show the
  // grammar section rather than the "0 cards in your bank" empty state — the
  // session still has work to do. Only fall to the empty state when BOTH the
  // vocab deck and the grammar section are empty.
  if (bankEmpty || !card) {
    if (hasGrammar) return <>{grammarSection}</>;
    return (
      <EmptyCard
        message="0 cards in your bank yet."
        hint="Tap a word on the Listen screen to mine it, or open Lists → New list to seed one."
      />
    );
  }
  // Label for the most recent rating, surfaced as a small hint above
  // the flashcard so the gesture's effect is visible.
  const lastRatingLabel = lastRating
    ? RATINGS.find((r) => r.id === lastRating)?.label
    : null;

  return (
    <>
      {grammarSection}
      {/* Active list strip */}
      <Card variant="default" className="km-review__strip">
        <SealStamp char="復" size="sm" />
        <div className="km-review__stripBody">
          <div className="km-eyebrow">Active list</div>
          <div className="kr km-review__stripName">
            {activeList ? activeList.name : 'All banked cards'}
          </div>
        </div>
        <Pill>{cards.length} cards</Pill>
      </Card>

      {/* Progress */}
      <div className="km-review__progress" aria-label="Session progress">
        <div className="km-review__progressMeta">
          <span>
            {idx + 1} / {cards.length}
          </span>
          <span>~{(cards.length - idx) * 8}s left</span>
        </div>
        <div
          className="km-review__progressBar"
          role="progressbar"
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
        onFlip={onFlip}
        front={
          <div className="km-review__front">
            <div className="km-eyebrow">{card.pos} · L3</div>
            <div className="kr-display km-review__word">{card.kr}</div>
            <Button variant="ghost" size="sm">
              Reveal · spacebar
            </Button>
          </div>
        }
        back={
          // B-014: mount the answer face only while `flipped`. When a rating
          // advances the deck `flipped` goes true->false and the content swaps
          // to the next card in the SAME commit; if the answer face were always
          // mounted, the next card's English would sit in the back face and
          // flash through during the 480ms flip-back rotation (its angle sweeps
          // through the front-facing range). Rendering null when not flipped
          // leaves nothing to leak — and keeps the answer out of the a11y tree
          // until the user reveals it.
          flipped ? (
          <div className="km-review__back">
            <div className="km-review__backHead">
              <div className="kr-display km-review__backWord">{card.kr}</div>
              <Pill>{card.pos}</Pill>
            </div>
            <div className="km-review__en">{card.en}</div>
            <hr className="hr" />
            <div>
              <div className="km-eyebrow">Source · seen in</div>
              <div className="km-review__source">{card.mined_in ?? '—'}</div>
            </div>
            <div>
              <div className="kr km-review__ex">{card.ex_kr}</div>
              <div className="km-review__exEn">{card.ex_en}</div>
            </div>
            <button
              type="button"
              onClick={(e) => {
                // Stop bubbling so the flashcard's outer onClick doesn't
                // flip the card when the user clicks the drawer toggle.
                e.stopPropagation();
                const willOpen = !drawer;
                onToggleDrawer();
                // Fetch KRDICT examples only on the OPEN transition (F-UP-008).
                if (willOpen) loadExamplesForOpen();
              }}
              className="km-btn km-btn--ghost km-btn--sm focusring km-review__drawerBtn"
              aria-expanded={drawer}
            >
              <Icon name="info" size={14} /> {drawer ? 'Hide' : 'More'} examples
            </button>
            {drawer ? (
              <div className="km-review__drawer">
                {examplesLoading ? (
                  <div className="km-review__drawerEn">Loading examples…</div>
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
                    No additional examples.
                  </div>
                )}
                {card.notes ? (
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
                onRate(r.id);
              }}
              className={`km-review__rating focusring ${r.className}`}
            >
              <span className="km-review__ratingLabel">{r.label}</span>
              <span className="km-review__ratingSub">{r.sub}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="km-review__hint">
          {lastRatingLabel ? (
            <>
              Last rating: <strong>{lastRatingLabel}</strong>. Tap card or
              press <kbd className="km-review__kbd">space</kbd> to reveal.
            </>
          ) : (
            <>
              Tap card or press{' '}
              <kbd className="km-review__kbd">space</kbd> to reveal.
            </>
          )}
        </div>
      )}
      {rateError ? (
        <div role="alert" className="km-review__rateError" style={{ marginTop: 12 }}>
          {rateError}
        </div>
      ) : null}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Grammar production section (FU-NF-42)
// ─────────────────────────────────────────────────────────────

/**
 * Distinct Review section for due grammar PRODUCTION cards. Reviewing one =
 * drilling it, so each row deep-links into the Grammar Drill tab (no in-place
 * self-rate buttons). The section is its own labelled region so AT announces
 * "Grammar production · N due" separately from the vocab flashcard.
 *
 * Threat model: `display` + `summary` render as React text children (escaped);
 * a compromised pattern row can't inject HTML here. The `patternKey` only ever
 * flows into router state for the drill deep-link, never into markup.
 */
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
      style={{ marginBottom: 16 }}
    >
      <div className="km-eyebrow" id="review-grammar-head" style={{ marginBottom: 8 }}>
        Grammar production · {cards.length} due
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
            <span className="km-pill km-pill--gold">Drill</span>
            <Icon name="chevron-right" size={16} />
          </button>
        ))}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Lists sub-panel
// ─────────────────────────────────────────────────────────────

interface ListsPanelProps {
  loading: boolean;
  bundle: VocabListBundle | null;
  onOpenList: (id: string) => void;
  onCreate: () => void;
  onRetry: () => void;
  /** B-013: seed recognition cards from the loaded vocab corpus. */
  onSeedReview: () => void;
  /** True while a seed request is in flight — disables the button. */
  seeding: boolean;
  /** Result banner from the last seed click; null before the first click. */
  seedStatus: SeedStatus | null;
}

function ListsPanel({
  loading,
  bundle,
  onOpenList,
  onCreate,
  onRetry,
  onSeedReview,
  seeding,
  seedStatus,
}: ListsPanelProps): JSX.Element {
  if (loading) return <SkeletonCard height={300} />;
  if (!bundle) {
    return (
      <ErrorCard
        message="Vocab lists couldn't be loaded."
        onRetry={onRetry}
      />
    );
  }

  const totalSourceLists = bundle.sources.reduce(
    (n, s) => n + s.lists.length,
    0,
  );

  return (
    <div className="km-review__lists">
      {/* Add to review — seeds recognition cards from the loaded vocab
          corpus (B-013). Lives above the list rows rather than inside a
          specific list's detail sheet: `/vocab/cards/init` seeds by corpus,
          not by list membership, so a per-list button here would either lie
          about scope or require an endpoint that doesn't exist yet. */}
      <section aria-labelledby="review-seed-head">
        <Card variant="flat">
          <div className="km-eyebrow" id="review-seed-head" style={{ marginBottom: 4 }}>
            내 단어장에 추가 · Add to review
          </div>
          <div style={{ fontSize: 14, color: 'var(--paper-dim)', marginBottom: 10 }}>
            Seed FSRS review cards from the loaded vocab corpus so they show
            up in your Session queue.
          </div>
          <Button
            variant="gold"
            size="md"
            leadingIcon={<Icon name="plus" size={14} />}
            onClick={onSeedReview}
            disabled={seeding}
          >
            {seeding ? 'Adding…' : 'Add to review'}
          </Button>
          {seedStatus ? (
            <div
              role={seedStatus.kind === 'error' ? 'alert' : 'status'}
              className={seedStatus.kind === 'error' ? 'km-review__rateError' : undefined}
              style={{ marginTop: 8, fontSize: 13 }}
            >
              {seedStatus.text}
            </div>
          ) : null}
        </Card>
      </section>

      {/* My lists */}
      <section>
        <header className="km-review__listsHead">
          <div>
            <div className="km-eyebrow">내 단어장</div>
            <div className="km-review__sectionTitle">My lists</div>
          </div>
          <Button
            variant="gold"
            size="sm"
            onClick={onCreate}
            leadingIcon={<Icon name="plus" size={14} />}
          >
            New list
          </Button>
        </header>
        <div className="km-review__listsCol">
          {bundle.custom.map((l) => (
            <CustomListRow
              key={l.id}
              list={l}
              active={bundle.active === l.id}
              onOpen={() => {
                onOpenList(l.id);
              }}
            />
          ))}
        </div>
      </section>

      {/* From sources */}
      <section>
        <header className="km-review__listsHead">
          <div>
            <div className="km-eyebrow">교재 단어장</div>
            <div className="km-review__sectionTitle">From sources</div>
          </div>
          <span className="km-review__sourcesMeta">
            {totalSourceLists} lists · {bundle.sources.length} sources
          </span>
        </header>
        <div className="km-review__listsCol">
          {bundle.sources.map((s) => (
            <SourceGroupRow key={s.source} group={s} onOpen={onOpenList} />
          ))}
        </div>
      </section>
    </div>
  );
}

function CustomListRow({
  list,
  active,
  onOpen,
}: {
  list: CustomVocabList;
  active: boolean;
  onOpen: () => void;
}): JSX.Element {
  const pctMature = list.count > 0 ? Math.round((list.mature / list.count) * 100) : 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`km-review__listRow km-card km-card--default focusring${active ? ' km-review__listRow--active' : ''}`}
    >
      <div
        className={`km-review__thumb${active ? ' km-review__thumb--active' : ''}`}
        aria-hidden="true"
      >
        {list.name.charAt(0)}
      </div>
      <div className="km-review__listBody">
        <div className="km-review__listHead">
          <span className="kr km-review__listName">{list.name}</span>
          {active ? <Pill tone="gold">Active</Pill> : null}
        </div>
        <div className="km-review__listMeta">
          {list.en} · {list.lastStudied}
        </div>
        <div className="km-review__listStats">
          <span>
            {list.count} ·{' '}
            <span className="km-review__due">{list.due} due</span>
          </span>
          <div className="km-review__maturityBar">
            <div
              className="km-review__maturityFill"
              style={{ width: `${String(pctMature)}%` }}
            />
          </div>
          <span className="km-review__pct">{pctMature}%</span>
        </div>
      </div>
      <Icon name="chevron-right" size={16} />
    </button>
  );
}

function SourceGroupRow({
  group,
  onOpen,
}: {
  group: SourceVocabGroup;
  onOpen: (id: string) => void;
}): JSX.Element {
  const pillTone =
    group.kind === 'grammar' ? 'red'
    : group.kind === 'mixed' ? 'ochre'
    : 'gold';
  return (
    <div className="km-review__source">
      <header className="km-review__sourceHead">
        <div
          className={`km-review__cover km-review__cover--${group.kind}`}
          aria-hidden="true"
        >
          {group.cover}
        </div>
        <div className="km-review__sourceMeta">
          <div className="kr km-review__sourceName">{group.source}</div>
          <div className="km-review__sourcePub">{group.publisher}</div>
        </div>
        <Pill tone={pillTone}>{group.kind}</Pill>
      </header>
      <div>
        {group.lists.map((l, i) => (
          <SourceListRow
            key={l.id}
            list={l}
            last={i === group.lists.length - 1}
            onOpen={() => {
              onOpen(l.id);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function SourceListRow({
  list,
  last,
  onOpen,
}: {
  list: SourceVocabListItem;
  last: boolean;
  onOpen: () => void;
}): JSX.Element {
  const pct = list.count > 0 ? Math.round((list.added / list.count) * 100) : 0;
  const status = list.complete
    ? 'Banked'
    : list.added === 0
      ? 'Not added'
      : `${list.added}/${list.count} added`;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`km-review__sourceRow focusring${last ? ' km-review__sourceRow--last' : ''}`}
    >
      <div className="km-review__sourceRowBody">
        <div>
          <span className="kr km-review__sourceListName">{list.name}</span>
          <span className="km-review__sourceListEn">· {list.en}</span>
        </div>
        <div className="km-review__sourceListMeta">
          <span>{list.level}</span>
          <span>· {list.count} items</span>
          <span
            className={
              list.complete
                ? 'km-review__sourceStatus--complete'
                : list.added > 0
                  ? 'km-review__sourceStatus--partial'
                  : 'km-review__sourceStatus--none'
            }
          >
            · {status}
          </span>
        </div>
      </div>
      <div className="km-review__sourcePctBar">
        <div
          className={`km-review__sourcePctFill${list.complete ? ' km-review__sourcePctFill--complete' : ''}`}
          style={{ width: `${String(pct)}%` }}
        />
      </div>
      <Icon name="chevron-right" size={14} />
    </button>
  );
}

// ─────────────────────────────────────────────────────────────
// All cards sub-panel
// ─────────────────────────────────────────────────────────────

interface AllPanelProps {
  /** Live <input> value. */
  query: string;
  /** 200ms-debounced value driving the keyed network search. */
  debouncedQuery: string;
  onQuery: (q: string) => void;
}

function AllPanel({
  query,
  debouncedQuery,
  onQuery,
}: AllPanelProps): JSX.Element {
  // Stable realFn + mockFn — both close over `debouncedQuery` via the dep
  // list so the hook's ref-swap picks up the latest closure between key
  // changes. The key embeds the query so the hook actually triggers a new
  // fetch on debounce; ref-only swaps wouldn't.
  const realFn = useCallback(async (): Promise<Vocab[]> => {
    const trimmed = debouncedQuery.trim();
    const opts = trimmed ? { q: trimmed } : {};
    const entries = await vocabService.searchEntries(opts);
    return entries.map(vocabEntryToVocab);
  }, [debouncedQuery]);
  const mockFn = useMemo(() => makeLoadAllMock(debouncedQuery), [debouncedQuery]);

  const key = `review:all:${debouncedQuery}`;
  const { data, loading, error } = useEndpointOrMock<Vocab[]>(key, mockFn, {
    realFn,
  });

  const results = data ?? [];

  if (loading) return <SkeletonCard height={280} />;
  // True fetch error wins over empty — distinguish from "empty bank".
  if (!data && error !== null) {
    return (
      <ErrorCard
        message="Search couldn't reach the bank."
        onRetry={() => {
          // The All panel re-keys on `debouncedQuery`; nudging the input is
          // the cleanest retry. Falling back to the parent's debounce avoids
          // a duplicate refetch path.
          onQuery(query);
        }}
      />
    );
  }
  if (results.length === 0 && !debouncedQuery.trim()) {
    // Empty bank — not an error, no Retry button.
    return (
      <div className="km-review__all">
        <SearchRow query={query} onQuery={onQuery} />
        <EmptyCard
          message="0 banked cards."
          hint="Mine a word from the Listen screen or import a list from the Lists tab."
        />
      </div>
    );
  }

  return (
    <div className="km-review__all">
      <SearchRow query={query} onQuery={onQuery} />
      <div className="km-eyebrow km-review__allCount">
        {results.length} card{results.length === 1 ? '' : 's'}
      </div>
      <div className="km-card km-card--flat km-review__allList">
        <div className="km-review__allHead">
          <span>Word · 단어</span>
          <span>Meaning</span>
          <span className="km-review__allMat">Maturity</span>
        </div>
        {results.length === 0 ? (
          <div className="km-review__allRow km-review__allRow--last">
            <div className="km-review__en">No matches for &ldquo;{debouncedQuery}&rdquo;.</div>
          </div>
        ) : (
          results.map((c, i) => (
            <div
              key={c.id}
              className={`km-review__allRow${i === results.length - 1 ? ' km-review__allRow--last' : ''}`}
            >
              <div>
                <span className="kr km-review__allWord">{c.kr}</span>
                <span className="km-review__allPos">{c.pos}</span>
              </div>
              <div className="km-review__allEn">{c.en}</div>
              <MaturityBar level={(i % 4) + 1} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function SearchRow({
  query,
  onQuery,
}: {
  query: string;
  onQuery: (q: string) => void;
}): JSX.Element {
  return (
    <div className="km-card km-card--flat km-review__searchRow">
      <Icon name="search" size={18} />
      <input
        type="search"
        className="kr focusring km-review__searchInput"
        value={query}
        onChange={(e) => {
          onQuery(e.target.value);
        }}
        placeholder="Search Korean or English"
        aria-label="Search banked vocab"
      />
      {query ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onQuery('');
          }}
        >
          <Icon name="close" size={14} />
        </Button>
      ) : null}
    </div>
  );
}

function MaturityBar({ level }: { level: number }): JSX.Element {
  return (
    <div
      className="km-review__matBar"
      aria-label={`Maturity level ${String(level)} of 4`}
    >
      {[1, 2, 3, 4].map((l) => (
        <span
          key={l}
          className={`km-review__matCell${l <= level ? ' km-review__matCell--on' : ''}`}
        />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Sheets
// ─────────────────────────────────────────────────────────────

interface ListDetailSheetProps {
  open: boolean;
  listId: string | null;
  bundle: VocabListBundle | null;
  onClose: () => void;
  /** Parent-side hook to refetch the lists collection after a delete. */
  onDeleted: () => void;
  /** Parent-side hook to refetch the lists collection after a rename. */
  onRenamed: () => void;
}

function ListDetailSheet({
  open,
  listId,
  bundle,
  onClose,
  onDeleted,
  onRenamed,
}: ListDetailSheetProps): JSX.Element {
  // Local "details fetched from server" state, in addition to the cached
  // bundle row. The bundle covers row metadata; getList() returns the same
  // shape (for now) but lets us refresh stale entry_count after a mutation.
  const [detail, setDetail] = useState<ServerVocabList | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'rename' | 'delete' | null>(null);
  const [renaming, setRenaming] = useState<boolean>(false);
  const [renameValue, setRenameValue] = useState<string>('');
  const ctrlRef = useRef<AbortController | null>(null);

  // Resolve the bundle row for header fallback when the network detail
  // hasn't landed yet.
  let bundleList: CustomVocabList | SourceVocabListItem | null = null;
  let bundleSource: SourceVocabGroup | null = null;
  if (bundle && listId) {
    const custom = bundle.custom.find((l) => l.id === listId);
    if (custom) bundleList = custom;
    else {
      for (const s of bundle.sources) {
        const found = s.lists.find((l) => l.id === listId);
        if (found) {
          bundleList = found;
          bundleSource = s;
          break;
        }
      }
    }
  }

  const numericId = listId ? decodeId(listId) : null;
  // Only fetch detail for user-mutable (custom) lists. Source lists come
  // from textbook fixtures and have no server detail endpoint yet (Pass 4+).
  const isCustom = bundleList !== null && bundleSource === null;

  // Fetch detail on open. Aborts in-flight on close/unmount.
  // Sync-to-external-system case — same exception the hook uses.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open || numericId === null || !isCustom) {
      setDetail(null);
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    vocabService
      .getListDetail(numericId)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setDetail(res.list);
        setRenameValue(res.list.name_kr);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setLoading(false);
        setError(
          errorMessageFor(err, 'Could not load list.'),
        );
      });
    return () => {
      ctrl.abort();
    };
  }, [open, numericId, isCustom]);

  // Reset transient UI state on close so the next open is fresh.
  const handleClose = useCallback((): void => {
    ctrlRef.current?.abort();
    setDetail(null);
    setError(null);
    setBusy(null);
    setRenaming(false);
    setRenameValue('');
    onClose();
  }, [onClose]);

  const handleRenameSubmit = useCallback((): void => {
    if (numericId === null) return;
    const next = renameValue.trim();
    if (!next || next === detail?.name_kr) {
      setRenaming(false);
      return;
    }
    setBusy('rename');
    setError(null);
    vocabService
      .patchList(numericId, { name_kr: next })
      .then((res) => {
        setDetail(res.list);
        setRenameValue(res.list.name_kr);
        setBusy(null);
        setRenaming(false);
        onRenamed();
      })
      .catch((err: unknown) => {
        setBusy(null);
        setError(
          errorMessageFor(err, 'Rename failed.'),
        );
      });
  }, [numericId, renameValue, detail, onRenamed]);

  const handleDelete = useCallback((): void => {
    if (numericId === null) return;
    // Window.confirm is the cheapest "are you sure?" — a richer modal lands
    // in Pass 5 with the toast layer. Skipping confirmation entirely is the
    // wrong default for a destructive op.
    const ok =
      typeof window !== 'undefined'
        ? window.confirm('Delete this list? This cannot be undone.')
        : true;
    if (!ok) return;
    setBusy('delete');
    setError(null);
    vocabService
      .deleteList(numericId)
      .then(() => {
        setBusy(null);
        onDeleted();
      })
      .catch((err: unknown) => {
        setBusy(null);
        setError(
          errorMessageFor(err, 'Delete failed.'),
        );
      });
  }, [numericId, onDeleted]);

  // Header preview — server detail wins, bundle row falls back.
  const displayName = detail?.name_kr ?? bundleList?.name ?? 'List';
  const displayEn =
    detail?.name_en ?? (bundleList && 'en' in bundleList ? bundleList.en : '');
  const total = detail?.entry_count ?? bundleList?.count ?? 0;
  const preview =
    bundleList && 'preview' in bundleList ? bundleList.preview : [];

  return (
    <Sheet open={open} onClose={handleClose} ariaLabel="List detail">
      <div className="km-review__sheetBody">
        {bundleSource ? (
          <div className="km-eyebrow">{bundleSource.source}</div>
        ) : null}
        <div className="km-review__sheetHead">
          <div>
            {renaming ? (
              <input
                className="kr-display km-review__input"
                value={renameValue}
                onChange={(e) => {
                  setRenameValue(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleRenameSubmit();
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setRenaming(false);
                    setRenameValue(detail?.name_kr ?? '');
                  }
                }}
                aria-label="List name"
                disabled={busy === 'rename'}
              />
            ) : (
              <div className="kr-display km-review__sheetTitle">
                {displayName}
              </div>
            )}
            <div className="km-review__sheetMeta">
              {displayEn ? `${displayEn} · ` : ''}
              {total} items
              {bundleList && 'level' in bundleList && bundleList.level
                ? ` · ${bundleList.level}`
                : ''}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClose}
            aria-label="Close list detail"
          >
            <Icon name="close" size={14} />
          </Button>
        </div>

        {loading ? <SkeletonCard height={80} /> : null}
        {error ? (
          <div role="alert" className="km-review__rateError">
            {error}
          </div>
        ) : null}

        <div className="km-review__sheetActions">
          {/* Per-list seeding isn't wired yet: `/vocab/cards/init` seeds by
              corpus, and list types carry no corpus field (B-013 review). Disable
              rather than ship a live-looking no-op; use the corpus-level "Add to
              review" on the Lists tab to seed cards for now. */}
          <Button
            variant="gold"
            size="md"
            leadingIcon={<Icon name="play" size={14} />}
            disabled
            title="Coming soon — use “Add to review” on the Lists tab to seed review cards"
          >
            Study this list
          </Button>
          {bundleSource ? (
            <Button
              variant="ghost"
              size="md"
              leadingIcon={<Icon name="plus" size={14} />}
              disabled
              title="Coming soon — use “Add to review” on the Lists tab to seed review cards"
            >
              Add all to my bank
            </Button>
          ) : isCustom ? (
            <>
              {renaming ? (
                <Button
                  variant="ghost"
                  size="md"
                  onClick={handleRenameSubmit}
                  disabled={busy === 'rename'}
                >
                  Save name
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="md"
                  leadingIcon={<Icon name="pen" size={14} />}
                  onClick={() => {
                    setRenameValue(detail?.name_kr ?? bundleList?.name ?? '');
                    setRenaming(true);
                  }}
                  disabled={detail === null}
                >
                  Rename
                </Button>
              )}
              <Button
                variant="ghost"
                size="md"
                onClick={handleDelete}
                disabled={busy !== null}
              >
                Delete
              </Button>
            </>
          ) : null}
        </div>

        <hr className="hr-double km-review__sheetRule" />

        <div className="km-eyebrow km-review__previewHead">
          Preview · {preview.length} of {total}
        </div>
        <div className="km-review__previewCol">
          {preview.map((w, i) => (
            <div
              key={i}
              className={`km-review__previewRow${i === preview.length - 1 ? ' km-review__previewRow--last' : ''}`}
            >
              <span className="kr km-review__previewWord">{w}</span>
              <MaturityBar level={(i % 4) + 1} />
            </div>
          ))}
          {total > preview.length ? (
            <div className="km-review__previewMore">
              + {total - preview.length} more
            </div>
          ) : null}
        </div>
      </div>
    </Sheet>
  );
}

interface CreateListSheetProps {
  open: boolean;
  onClose: () => void;
  /** Fires after the server returns 201; parent refetches the lists collection. */
  onCreated: (created: CreateListResponse) => void;
}

const KIND_OPTIONS: ReadonlyArray<VocabListKind> = [
  'vocab',
  'grammar',
  'hanja',
  'mixed',
];

function CreateListSheet({
  open,
  onClose,
  onCreated,
}: CreateListSheetProps): JSX.Element {
  const [name, setName] = useState<string>('');
  const [en, setEn] = useState<string>('');
  const [kind, setKind] = useState<VocabListKind>('vocab');
  const [seed, setSeed] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  // Reset form on close — without this, reopening shows stale partial input.
  const resetAndClose = useCallback((): void => {
    ctrlRef.current?.abort();
    setName('');
    setEn('');
    setKind('vocab');
    setSeed('');
    setSubmitting(false);
    setError(null);
    onClose();
  }, [onClose]);

  // Abort any in-flight create when the sheet closes (parent flips `open`).
  useEffect(() => {
    if (!open) {
      ctrlRef.current?.abort();
    }
  }, [open]);

  const handleCreate = useCallback((): void => {
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    const body: CreateListBody = {
      name_kr: trimmed,
      kind,
    };
    const trimmedEn = en.trim();
    if (trimmedEn) body.name_en = trimmedEn;
    // NOTE: `seed` words are captured in the UI but not wired into the
    // create call — `CreateListBody` doesn't accept seed entry ids. Pass 4+
    // adds a "lookup-then-addListEntries" two-step here so the user's seed
    // lines actually populate the list.
    vocabService
      .createList(body)
      .then((created) => {
        if (ctrl.signal.aborted) return;
        setSubmitting(false);
        // Reset locally before bubbling — `onCreated` will close the sheet
        // upstream, and we don't want a frame of stale fields visible mid-
        // close animation.
        setName('');
        setEn('');
        setKind('vocab');
        setSeed('');
        onCreated(created);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setSubmitting(false);
        setError(
          errorMessageFor(err, 'Could not create list.'),
        );
      });
  }, [name, en, kind, submitting, onCreated]);

  // Submit-on-Enter is fine for the name field — the textarea (seed) keeps
  // newline semantics because Enter inside <textarea> doesn't bubble here.
  const onEnterFromName = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && name.trim() && !submitting) {
      e.preventDefault();
      handleCreate();
    }
  };

  return (
    <Sheet open={open} onClose={resetAndClose} ariaLabel="Create custom list">
      <div className="km-review__sheetBody">
        <div className="km-eyebrow">새 단어장 · New list</div>
        <div className="kr-display km-review__sheetTitle">
          Create a custom list
        </div>
        <div className="km-review__sheetMeta">
          Group words by topic, source, or drama. Add as you mine.
        </div>

        <div className="km-review__formCol">
          <label className="km-review__field">
            <span className="km-eyebrow">List name · 이름</span>
            <input
              className="kr focusring km-review__input"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              onKeyDown={onEnterFromName}
              placeholder="병원 어휘"
              aria-label="List name"
              disabled={submitting}
            />
          </label>
          <label className="km-review__field">
            <span className="km-eyebrow">English label · optional</span>
            <input
              className="focusring km-review__input"
              value={en}
              onChange={(e) => {
                setEn(e.target.value);
              }}
              placeholder="Hospital vocabulary"
              aria-label="English label"
              disabled={submitting}
            />
          </label>
          <fieldset className="km-review__field km-review__kindRow">
            <legend className="km-eyebrow">Kind</legend>
            <div role="radiogroup" aria-label="List kind" className="km-review__kindOpts">
              {KIND_OPTIONS.map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={kind === k}
                  onClick={() => {
                    setKind(k);
                  }}
                  className={`km-review__kindOpt focusring${kind === k ? ' km-review__kindOpt--on' : ''}`}
                  disabled={submitting}
                >
                  {k}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="km-review__field">
            <span className="km-eyebrow">Seed words · one per line, optional</span>
            <textarea
              className="kr focusring km-review__textarea"
              value={seed}
              onChange={(e) => {
                setSeed(e.target.value);
              }}
              placeholder={'진료\n처방전\n증상'}
              aria-label="Seed words"
              disabled={submitting}
            />
          </label>
          {error ? (
            <div role="alert" className="km-review__rateError">
              {error}
            </div>
          ) : null}
        </div>

        <div className="km-review__sheetFoot">
          <Button
            variant="ghost"
            size="md"
            onClick={resetAndClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant="gold"
            size="md"
            disabled={!name.trim() || submitting}
            onClick={handleCreate}
          >
            {submitting ? 'Creating…' : 'Create list'}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

export default Review;
