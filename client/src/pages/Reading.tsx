/**
 * Reading — `/learn/reading`, the Learn → Reading home (Phase 3C-2).
 *
 * Grew out of the U3b digitized chapter reader (`db/docs/U3_READER_DESIGN.md`
 * §U3b; `reading_chapters`/`reading_passages`, migration 044) into the full
 * reading surface:
 *
 *   Root — two `Tabs` (F-032 primitive):
 *     Books (F-067)   — the user's READY uploads, grouped into typed
 *                       sections: Literature (문학), Dialogue (대화), and
 *                       Documents (문서 — the vocab/grammar/both scans;
 *                       "this is also where uploaded documents live").
 *                       Sections window through `usePagination`+`ShowMore`.
 *                       F-217 appends a "Shared Library" section below the
 *                       typed sections: the operator-curated shared books
 *                       (GET /uploads/shared), minus any the user already
 *                       owns, openable cross-account (comics → viewer,
 *                       others → chapter picker; the owner-only resume
 *                       position degrades to "no resume" for a non-owner).
 *     AI stories (F-068) — `StoryGenerator` (POST /reading/generate: Claude
 *                       authors a short story at a chosen level, optional
 *                       topic) above the generated-story library
 *                       (GET /reading/generated); a fresh story opens
 *                       immediately.
 *
 *   Nested views ride SEARCH PARAMS (the Hanja/Grammar F-024 convention —
 *   each is deep-linkable and carries a real `BackButton` with a
 *   deterministic `to`, so a deep link can never history-back out of the
 *   PWA):
 *     ?book=ID              — chapter picker for one upload (GET
 *                             /reading/chapters + GET /uploads/:id + the
 *                             F-069 resume position, fetched together).
 *     ?book=ID&chapter=N    — the chapter reader (tappable passages).
 *     ?chapter=N (no book)  — F-183: Today's Reading-tile deep link opens
 *                             the SAME chapter reader directly, with no book
 *                             context (the reader only ever needs its own
 *                             chapter id — see `ChapterReader`/`getChapter`).
 *                             Back goes to the Reading root, not a picker
 *                             for an unknown book.
 *     ?story=N              — one generated story, same tappable treatment.
 *
 *   F-069 (resume, `reading_positions`/051): opening a chapter IS the
 *   position — the reader PUTs /reading/position/:uploadId after the chapter
 *   loads (chapter granularity; passage-level tracking would need scroll
 *   telemetry this phase doesn't add). The chapter picker surfaces the saved
 *   spot as a "Resume" button when one exists AND still points at a listed
 *   chapter. A failed save toasts once — reading continues regardless.
 *
 *   F-070/F-116 (passage translation): every passage (and story paragraph)
 *   carries a "Translate" action that opens `TranslateSheet` — a popup that
 *   fetches `POST /reading/translate` (F-116) for the selected passage and
 *   renders Claude's natural-English translation. Abortable (a re-open or
 *   unmount cancels the in-flight call); a failure renders `ErrorCard` with a
 *   working Retry, using the app's fixed-copy `errorMessageFor` (429 renders
 *   its structured retry-after copy — this is an EXPENSIVE route). Single-word
 *   tap-to-define is untouched.
 *
 *   F-210 (story TTS + read-along): the story reader carries an audio card
 *   driven by the `GET /reading/generated/:id/audio` envelope — "Generate
 *   audio" POSTs the enqueue, a ~2s poll rides pending/running, `done`
 *   mounts a real streaming `<audio>` (the MyAudioDetail recipe:
 *   `buildAudioSrc` allow-list, Range-enabled `/audio/tracks/:id/stream`,
 *   onError alert) and re-renders the body from the voiced SEGMENTS — one
 *   tappable/translatable line per sentence, the line whose `[startMs,
 *   endMs)` window contains the playhead highlighted via a binary search on
 *   `timeupdate`. No audio, or a track with all-zero timing, keeps the
 *   plain `bodyKo` paragraph rendering (and the latter still plays). The
 *   story DTO's `turns` field is LATENT groundwork — no UI reads it.
 *
 *   F-211 (story illustrations): the story reader shows the 2–4
 *   Korean-webtoon scene images the server batch-generates at story creation
 *   (when the image key is configured), driven by the
 *   `GET /reading/generated/:id/images` envelope through `useStoryImages` —
 *   the same request/poll state machine as F-210's audio. `done` renders a
 *   hero-plus-grid gallery above the reader card (every `<img src>` resolves
 *   through the strict `buildStoryImageSrc` allow-list; a tampered/foreign
 *   blobUrl renders nothing, and a per-image load error hides just that
 *   image); `pending`/`running` shows a subtle "Illustrating…" status (a
 *   fresh story lands here with no click — batch-at-create); `none` (an old
 *   story) offers "Generate illustrations"; `failed` shows the
 *   server-authored whitelisted copy verbatim with a retry. A dormant deploy
 *   (`imageGenConfigured: false`) renders NO illustration UI at all — the
 *   F-210 `ttsConfigured` posture; only an explicit false hides.
 *
 * Tap-to-define reuses the shared stack as-is (`lib/tapChain`,
 * `components/Tapword`, `components/WordPopover`) via the page-local
 * `useMineable` hook below — the same optimistic-flip + rollback +
 * fixed-copy-toast + ABORTABLE "Add to bank" contract `Ttmik.tsx`'s
 * `DetailView` uses (kept page-local rather than folded into `useTapWord` —
 * see that hook's header for why), now shared by the chapter reader AND the
 * story reader instead of duplicated.
 *
 * Threat model:
 *   - All display data (book/chapter/story titles, passage/story bodies,
 *     topics) is server corpus/OCR/Claude text rendered through React text
 *     children — escaped, no `dangerouslySetInnerHTML` anywhere on this
 *     screen. Claude-authored story text is untrusted display data like any
 *     other. The tap chain's popover fields go through the same contract
 *     (see `lib/tapChain`).
 *   - IDOR: every read/write is scoped server-side to the session `user_id`;
 *     a foreign/missing id just 404s as an `ApiError`, surfaced through
 *     `errorMessageFor`'s fixed-copy lookup — server prose is never echoed.
 *   - URL params are validated here (`/^\d+$/` / positive-int parse) before
 *     use; a garbage deep link renders the root, not a malformed fetch.
 *   - Every fetch threads its own `AbortController`, checked before every
 *     post-await state write, and is aborted on unmount / re-fetch / view
 *     change. The writes (position PUT, generate POST, vocab-mine POST) ride
 *     the `SameSite=Strict` cookie posture owned by `services/api.ts`
 *     (ADR-002) and are themselves abortable.
 *   - POST /reading/generate and POST /reading/translate both sit in the
 *     server's EXPENSIVE rate-limit bucket: 429 (with structured
 *     `retryAfter`) renders via `errorMessageFor`; the Generate button stays
 *     enabled as the retry, and the translate sheet's error state carries its
 *     own Retry button.
 *
 * F-128 reskin ("Seoul Day & Night") — the shared `PageHubHeader` (devices
 * #4 skyline + #2 rail, `components/PageHubHeader.tsx`) replaces the bare
 * `Topbar`, matching every other reskinned page's hub-header recipe. The
 * chapter/story reader body is a `CityCard` signboard/hanji-paper surface
 * (device #1) with a leading `DancheongRail` (device #2, via the card's
 * `rail` prop) instead of a plain `Card` — this is the page's primary
 * text-heavy surface, so the passage copy itself additionally gets the
 * doc's Day editorial-serif treatment (`.km-reading__passage-text`,
 * Reading.css) capped at a legible ~65ch measure; Night stays on the app's
 * rounded body face — glow is reserved for the card edge and headings, never
 * the paragraph copy, so the reading surface itself stays calm in both
 * worlds. The F-069 Resume callout is a `blue`-tone CityCard (mirrors the
 * design mock's "Resume" signboard) and the F-068 story generator is a
 * `mint`-tone, `feat` CityCard — the page's one hero CTA, so it is also the
 * "sparing jewel" spot for the mother-of-pearl `.km-najeon` shimmer (device
 * #9) on its spark glyph. The page root carries the ambient `.km-rain-sheen`
 * (device #8, Night-only per its own CSS gate); every genuine empty state
 * (no ready uploads, no chapters, no passages, no stories) carries
 * `.km-giwa`/`.km-hangul-watermark` (devices #3/#6), matching the
 * Progress/Uploads/Mistakes/ReviewGrammar precedent. No shared file needed
 * changing — every device consumed here already exists post-foundation.
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
import { CityCard } from '../components/CityCard';
import { ErrorCard } from '../components/ErrorCard';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { PageHubHeader } from '../components/PageHubHeader';
import { Pill } from '../components/Pill';
import { Sheet } from '../components/Sheet';
import { ShowMore } from '../components/ShowMore';
import { Tabs } from '../components/Tabs';
import { Tapword } from '../components/Tapword';
import { WordPopover } from '../components/WordPopover';
import type { WordPopoverData } from '../components/WordPopover';
import { AskAboutThisButton } from '../components/AskAboutThisButton';
import { StoryGenerator } from '../components/StoryGenerator';
import { useToast } from '../components/useToast';
import { usePagination } from '../hooks/usePagination';
import {
  AUDIO_FAILED_FALLBACK_COPY,
  useStoryAudio,
} from '../hooks/useStoryAudio';
import { useTapWord } from '../hooks/useTapWord';
import {
  GLOSS_DICTIONARY_ENTRY,
  GLOSS_UNAVAILABLE,
  tokeniseKorean,
} from '../lib/tapChain';
import { cn } from '../lib/cn';
import { errorMessageFor } from '../lib/errorCopy';
import { activeSegmentNumberAt } from '../lib/readAlong';
import { navItem } from '../lib/nav';
import { ApiError } from '../services/api';
import {
  generateChapterQuestions,
  getChapter,
  getChapterQuestions,
  getGeneratedStory,
  getReadingPosition,
  getStoryImages,
  listChapters,
  listGeneratedStories,
  logReadingAttempt,
  requestStoryExperience,
  requestStoryImages,
  saveReadingPosition,
  translatePassage,
} from '../services/reading';
import type {
  AssetStatus,
  GeneratedStory,
  GeneratedStorySummary,
  ReadingPosition,
  ReadingQuestion,
  StoryImage,
  StoryImagesEnvelope,
} from '../services/reading';
import { buildAudioSrc, buildStoryImageSrc } from '../services/ttmik';
import {
  getUpload,
  listSharedUploads,
  listUploads,
} from '../services/uploads';
import { mineWord } from '../services/vocab';
import type {
  BookUpload,
  BookUploadType,
  ReadingChapter,
  ReadingChapterSummary,
  ReadingPassage,
} from '../types/domain';
import './Reading.css';

/** Page eyebrow source — nav.ts owns the en/kr pair (P3b Batch A). */
const READING_NAV = navItem('reading');

/** Canonical route — sub-view links + BackButton targets build on this. */
const READING_PATH = '/learn/reading';

/** Signature every tap surface funnels into: raw word + its source line. */
type TapWordHandler = (raw: string, sentenceText: string) => void;

/** Strict positive-int parse for numeric search params; anything else
 *  (missing, signed, decimal, overlong garbage) is null → root view. */
function parsePositiveInt(raw: string | null): number | null {
  if (raw === null || !/^\d{1,15}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

export default function Reading(): JSX.Element {
  const [params, setParams] = useSearchParams();

  // Upload ids are wire STRINGS (BIGINT — see services/uploads.ts), so the
  // book param stays a string; digits-only or it's ignored.
  const rawBook = params.get('book');
  const bookId = rawBook !== null && /^\d{1,19}$/.test(rawBook) ? rawBook : null;
  const chapterId = parsePositiveInt(params.get('chapter'));
  const storyId = parsePositiveInt(params.get('story'));
  const tab = params.get('tab') === 'stories' ? 'stories' : 'books';

  const openBook = useCallback(
    (id: string): void => {
      setParams({ book: id });
    },
    [setParams],
  );
  const openStory = useCallback(
    (id: number): void => {
      setParams({ story: String(id) });
    },
    [setParams],
  );
  const onTabChange = useCallback(
    (id: string): void => {
      // `books` is the default — keep the canonical URL bare for it.
      setParams(id === 'stories' ? { tab: 'stories' } : {});
    },
    [setParams],
  );

  // Resolve the active view + its BackButton target (F-024: every nested
  // view gets a deterministic `to`, never a raw history back).
  let back: { to: string; label: string } | null = null;
  let view: JSX.Element;
  if (bookId !== null && chapterId !== null) {
    back = { to: `${READING_PATH}?book=${bookId}`, label: 'Chapters' };
    view = <ChapterReader key={chapterId} chapterId={chapterId} />;
  } else if (chapterId !== null) {
    // F-183 (Today's Reading-tile deep link, `?chapter=<id>` with no
    // `?book=`): `ChapterReader` only ever needs the chapter's OWN id —
    // it fetches by `chapterId` alone, and "View original scan" reads
    // `sourceUploadId` off the FETCHED chapter, never a route param — so a
    // bare `?chapter=` opens the reader directly. There's no book context
    // to link Back to (Today doesn't know/send it), so Back goes to the
    // Reading root rather than a chapter-picker for an unknown book.
    back = { to: READING_PATH, label: 'Reading' };
    view = <ChapterReader key={chapterId} chapterId={chapterId} />;
  } else if (bookId !== null) {
    back = { to: READING_PATH, label: 'Reading' };
    view = (
      <ChapterPicker
        key={bookId}
        bookId={bookId}
        onOpenChapter={(cid) => {
          setParams({ book: bookId, chapter: String(cid) });
        }}
      />
    );
  } else if (storyId !== null) {
    back = { to: `${READING_PATH}?tab=stories`, label: 'Stories' };
    view = <StoryReader key={storyId} storyId={storyId} />;
  } else {
    view = (
      <Tabs
        tabs={[
          { id: 'books', label: <Bilingual en="Books" kr="책" compact /> },
          {
            id: 'stories',
            label: <Bilingual en="AI stories" kr="AI 이야기" compact />,
          },
        ]}
        ariaLabel="Reading sections"
        active={tab}
        onChange={onTabChange}
      >
        {(active) =>
          active === 'stories' ? (
            <StoriesSection onOpenStory={openStory} />
          ) : (
            <BookShelf onOpenBook={openBook} />
          )
        }
      </Tabs>
    );
  }

  return (
    <section
      className="screen km-reading km-rain-sheen"
      aria-labelledby="reading-title"
    >
      {back !== null ? <BackButton to={back.to} label={back.label} /> : null}
      <PageHubHeader
        titleId="reading-title"
        eyebrow={
          <Bilingual en={READING_NAV.eyebrow} kr={READING_NAV.krEyebrow} />
        }
        heading={<Bilingual en="Reading" kr="읽기" />}
      />
      {view}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Books tab — typed sections (F-067)
// ─────────────────────────────────────────────────────────────

/**
 * The typed sections, in display order. Literature and dialogue are the
 * reader-first types; Comics & Picture Books (Track P's 'comic') are
 * display-only page-image books — `opensViewer` routes their rows straight
 * to the upload viewer (`/uploads/:id`), never the chapter picker (comics
 * have no `reading_chapters`, so `?book=ID` would dead-end on "no chapters
 * yet"); Documents is where the other uploaded scans (vocab/grammar/both)
 * live per F-067 — they rarely have chapters, so opening one lands on the
 * honest "no chapters yet" state with the original-scan link, never a
 * fabricated reader.
 */
const BOOK_SECTIONS: ReadonlyArray<{
  key: string;
  en: string;
  kr: string;
  types: ReadonlyArray<BookUploadType>;
  /** Rows open the page-image viewer directly instead of the chapter picker. */
  opensViewer?: true;
}> = [
  { key: 'literature', en: 'Literature', kr: '문학', types: ['literature'] },
  {
    key: 'comics',
    en: 'Comics & Picture Books',
    kr: '만화 · 그림책',
    types: ['comic'],
    opensViewer: true,
  },
  { key: 'dialogue', en: 'Dialogue', kr: '대화', types: ['dialogue'] },
  {
    key: 'documents',
    en: 'Documents',
    kr: '문서',
    types: ['vocab', 'grammar', 'both'],
  },
];

function BookShelf({
  onOpenBook,
}: {
  onOpenBook: (id: string) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const [books, setBooks] = useState<BookUpload[]>([]);
  const [shared, setShared] = useState<BookUpload[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Monotonic reload trigger so Retry re-runs the fetch effect.
  const [reloadTick, setReloadTick] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    // Sync-to-external-system (network fetch) — same documented exception
    // Ttmik.tsx's browse tabs use for their kickoff setState.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    // The owner's own list keeps sole custody of the shelf's loading/error
    // fate, exactly as before F-217. The shared curated listing rides
    // alongside but DEGRADES to empty on failure — a broken discovery
    // surface must never take the user's own library down with it (the
    // aborted-signal check below already guards the cancelled-unmount case,
    // so collapsing every shared-fetch rejection to [] loses nothing).
    Promise.all([
      listUploads(ctrl.signal),
      listSharedUploads(ctrl.signal).catch(() => [] as BookUpload[]),
    ])
      .then(([rows, sharedRows]) => {
        if (ctrl.signal.aborted) return;
        // Only READY uploads are openable (mirrors `SourceFilterRow`'s
        // `status === 'ready'` filter); the type split happens per-section.
        setBooks(rows.filter((u) => u.status === 'ready'));
        setShared(sharedRows.filter((u) => u.status === 'ready'));
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(errorMessageFor(err, 'Could not load your books.'));
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  // Track P: comic rows bypass the chapter picker entirely — a comic is a
  // display-only page-image book with no `reading_chapters`, so it opens
  // the upload viewer (`/uploads/:id`, App.tsx's UploadViewer route)
  // directly instead of setting `?book=ID`.
  const openViewer = useCallback(
    (id: string) => {
      navigate(`/uploads/${id}`);
    },
    [navigate],
  );

  // F-217 de-dupe: a book the user OWNS that is also shared already sits in
  // its typed section above — the Shared Library lists only books the caller
  // does NOT own, so nothing ever renders twice.
  const sharedOnly = useMemo(() => {
    const ownedIds = new Set(books.map((b) => b.id));
    return shared.filter((b) => !ownedIds.has(b.id));
  }, [books, shared]);

  // The Shared Library mixes types in one flat section, so the comic split
  // happens per row: comics open the page-image viewer directly (Track P —
  // no `reading_chapters`, the `?book=ID` picker would dead-end), everything
  // else opens the chapter picker. Same two handlers the typed sections use.
  const openShared = useCallback(
    (id: string) => {
      const row = shared.find((b) => b.id === id);
      if (row !== undefined && row.type === 'comic') {
        openViewer(id);
      } else {
        onOpenBook(id);
      }
    },
    [shared, onOpenBook, openViewer],
  );

  if (loading) {
    return (
      <div className="km-grammar__state" role="status">
        <Bilingual en="Loading your books…" kr="책을 불러오는 중…" />
      </div>
    );
  }
  if (error !== null) {
    return <ErrorCard message={error} onRetry={refetch} />;
  }
  if (books.length === 0 && sharedOnly.length === 0) {
    return (
      // Devices #3/#6 (giwa texture + hangul watermark) on the genuine
      // empty state — matches the Progress/Uploads/Mistakes/ReviewGrammar
      // precedent (never applied to a loading/error state). F-217: the
      // prompt only shows when the SHARED library is empty too — a
      // non-owner account with zero uploads of its own must land on the
      // shared shelf (the entire point of the browse surface), not a
      // dead-end upload nudge.
      <Card
        variant="flat"
        className="km-reading__empty km-giwa km-hangul-watermark"
        data-glyph="책"
      >
        <p className="km-reading__empty-copy">
          <Bilingual
            en="Upload a book to start reading."
            kr="읽기를 시작하려면 책을 업로드하세요."
          />
        </p>
        <Button
          variant="gold"
          size="md"
          leadingIcon={<Icon name="upload" size={14} />}
          onClick={() => {
            navigate('/uploads');
          }}
        >
          <Bilingual en="Upload a book" kr="책 업로드" />
        </Button>
      </Card>
    );
  }

  return (
    <div data-tour="reading-shelf">
      {BOOK_SECTIONS.map((section) => {
        const rows = books.filter((b) => section.types.includes(b.type));
        if (rows.length === 0) return null; // empty sections stay out of the way
        return (
          <BookSection
            key={section.key}
            en={section.en}
            kr={section.kr}
            books={rows}
            onOpenBook={section.opensViewer === true ? openViewer : onOpenBook}
          />
        );
      })}
      {/* F-217: the shared curated library, BELOW the owner's typed
          sections — additive; renders nothing when empty (nothing shared,
          or everything shared is already owned/listed above). */}
      {sharedOnly.length > 0 ? (
        <BookSection
          en="Shared Library"
          kr="공유 서재"
          books={sharedOnly}
          onOpenBook={openShared}
        />
      ) : null}
    </div>
  );
}

/** One typed shelf: heading + windowed rows (`usePagination` + `ShowMore` —
 *  a big Documents backlog can't flood the screen).
 *
 *  `max: 200` — `GET /uploads` (server/src/routes/uploads.ts:216) carries
 *  no `LIMIT`, so unlike the Stories window below there is no server cap
 *  to mirror exactly. Documents accretes indefinitely by design (this is
 *  also where uploaded documents live), so 200 is a deliberately generous
 *  fixed ceiling — comfortably above any realistic personal-upload count
 *  — chosen to match the sibling Stories section's window rather than an
 *  arbitrary smaller number a real shelf could outgrow. */
function BookSection({
  en,
  kr,
  books,
  onOpenBook,
}: {
  en: string;
  kr: string;
  books: BookUpload[];
  onOpenBook: (id: string) => void;
}): JSX.Element {
  const pag = usePagination(books, { initial: 8, step: 8, max: 200 });
  return (
    <section className="km-reading__section" aria-label={en}>
      <h2 className="km-reading__section-title">
        <Bilingual en={en} kr={kr} />
      </h2>
      <Card className="km-reference__list" variant="flat">
        <ul>
          {pag.visible.map((book) => (
            <li key={book.id} className="km-reference__row">
              <button
                type="button"
                className="km-resources__list-open focusring"
                onClick={() => {
                  onOpenBook(book.id);
                }}
                aria-label={`Open ${book.title}`}
              >
                <span className="kr km-reference__row-kr">{book.title}</span>
                {book.pageCount !== undefined ? (
                  <span className="km-resources__pager-count">
                    {book.pageCount} pp
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <ShowMore
        canShowMore={pag.canShowMore}
        onShowMore={pag.showMore}
        remaining={pag.remaining}
      />
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Chapter picker (?book=ID) — chapters + F-069 resume
// ─────────────────────────────────────────────────────────────

function ChapterPicker({
  bookId,
  onOpenChapter,
}: {
  bookId: string;
  onOpenChapter: (chapterId: number) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const [book, setBook] = useState<BookUpload | null>(null);
  const [chapters, setChapters] = useState<ReadingChapterSummary[]>([]);
  const [position, setPosition] = useState<ReadingPosition | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    // One fate for the whole view: the three reads are cheap same-server
    // GETs against the same upload — a partial paint (chapters without the
    // book title, or a silently missing resume spot) would be a lie, so a
    // single failure funnels into the one ErrorCard + Retry.
    Promise.all([
      getUpload(bookId, ctrl.signal),
      listChapters(bookId, ctrl.signal),
      getReadingPosition(bookId, ctrl.signal),
    ])
      .then(([b, ch, pos]) => {
        if (ctrl.signal.aborted) return;
        setBook(b);
        setChapters(ch);
        setPosition(pos);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(errorMessageFor(err, 'Could not load this book.'));
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [bookId, reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  // Defensive order — the server already orders by chapter_number.
  const ordered = useMemo(
    () => [...chapters].sort((a, b) => a.chapterNumber - b.chapterNumber),
    [chapters],
  );

  // F-069: the saved spot, but only when it still points at a LISTED
  // chapter — a stale id (book re-loaded since) offers no resume rather
  // than a dead button.
  const resumeChapter = useMemo(() => {
    if (position === null || position.chapterId === null) return null;
    return ordered.find((c) => c.id === position.chapterId) ?? null;
  }, [ordered, position]);

  if (loading) {
    return (
      <div className="km-grammar__state" role="status">
        <Bilingual en="Loading chapters…" kr="목차를 불러오는 중…" />
      </div>
    );
  }
  if (error !== null || book === null) {
    return (
      <ErrorCard
        message={error ?? 'Could not load this book.'}
        onRetry={refetch}
      />
    );
  }

  return (
    <div>
      <Eyebrow>
        <Bilingual en="Book" kr="책" compact />
      </Eyebrow>
      <h2 className="kr kr-display" style={{ margin: '4px 0 6px' }}>
        {book.title}
      </h2>
      <div style={{ margin: '0 0 16px' }}>
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<Icon name="book" size={12} />}
          onClick={() => {
            navigate(`/uploads/${book.id}`);
          }}
        >
          <Bilingual en="View original scan" kr="원본 스캔 보기" compact />
        </Button>
      </div>

      {resumeChapter !== null ? (
        // F-069 resume callout as a `blue`-tone CityCard signboard/hanji-paper
        // card (device #1/#2) — mirrors the design mock's dedicated "Resume"
        // sign, distinct from the plain chapter-list rows below it.
        <CityCard tone="blue" rail className="km-reading__resume">
          <Button
            variant="gold"
            size="md"
            leadingIcon={<Icon name="play" size={14} />}
            onClick={() => {
              onOpenChapter(resumeChapter.id);
            }}
          >
            <Bilingual
              en={`Resume — Chapter ${String(resumeChapter.chapterNumber)}`}
              kr="이어서 읽기"
            />
          </Button>
        </CityCard>
      ) : null}

      {ordered.length === 0 ? (
        <p
          className="km-reference__empty km-giwa km-hangul-watermark"
          data-glyph="목차"
        >
          <Bilingual
            en="No chapters yet for this book."
            kr="아직 이 책의 목차가 없어요."
          />
        </p>
      ) : (
        <Card className="km-reference__list" variant="flat">
          <ul>
            {ordered.map((chapter) => {
              const label =
                chapter.title ?? `Chapter ${String(chapter.chapterNumber)}`;
              return (
                <li key={chapter.id} className="km-reference__row">
                  <button
                    type="button"
                    className="km-resources__list-open focusring"
                    onClick={() => {
                      onOpenChapter(chapter.id);
                    }}
                    aria-label={`Open ${label}`}
                  >
                    <span className="km-reference__row-en">
                      {chapter.chapterNumber}.
                    </span>
                    <span className="kr km-reference__row-kr">{label}</span>
                    {chapter.startPage !== null && chapter.endPage !== null ? (
                      <span className="km-resources__pager-count">
                        pp. {chapter.startPage}–{chapter.endPage}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Tap-to-define + add-to-bank (shared by both readers)
// ─────────────────────────────────────────────────────────────

/**
 * Page-local mineable-text wiring: `useTapWord`'s lemmatize→define→enrich
 * chain plus the "Add to bank" optimistic-flip + rollback + fixed-copy-toast
 * contract from `Ttmik.tsx`'s `DetailView` — INCLUDING the abort contract:
 * this hook keeps its own `addCtrlRef` (the same page-local controller
 * `Ttmik.tsx` keeps post-U3c, since `useTapWord` deliberately doesn't expose
 * its internal controller) so closing the popover — or unmounting
 * mid-request — aborts an in-flight "Add to bank" POST too, not just the
 * tap chain. Shared here because the chapter reader and the story reader
 * both need the identical stack.
 */
function useMineable(): {
  minedIds: ReadonlySet<string>;
  onTapWord: TapWordHandler;
  popover: JSX.Element | null;
} {
  const { toast } = useToast();
  const [minedIds, setMinedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const addCtrlRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      addCtrlRef.current?.abort();
    },
    [],
  );

  const isMined = useCallback(
    (word: string) => minedIds.has(word),
    [minedIds],
  );
  const { popData, popLoading, popEnriching, onTapWord, onClose } = useTapWord({
    isMined,
  });

  /** Close the popover AND abort any in-flight "Add to bank" request. */
  const handleClose = useCallback((): void => {
    addCtrlRef.current?.abort();
    addCtrlRef.current = null;
    onClose();
  }, [onClose]);

  /**
   * Add-to-bank — a fresh `AbortController` per add, aborted by
   * `handleClose` (popover close) or the unmount effect above, so a
   * closed/unmounted popover can never land a late `setMinedIds`/`toast` or
   * re-throw into `WordPopover`'s already-unmounted rollback handler.
   */
  const handleAdd = useCallback(
    (d: WordPopoverData): void | Promise<void> => {
      const lemma = d.kr;
      setMinedIds((prev) => {
        const next = new Set(prev);
        next.add(lemma);
        return next;
      });

      addCtrlRef.current?.abort();
      const ctrl = new AbortController();
      addCtrlRef.current = ctrl;

      return mineWord(
        {
          lemma,
          ...(d.en && d.en !== GLOSS_DICTIONARY_ENTRY && d.en !== GLOSS_UNAVAILABLE
            ? { english: d.en }
            : {}),
          ...(d.pos && d.pos !== 'word' ? { pos: d.pos } : {}),
          ...(d.krdictEntryId !== undefined
            ? { krdictEntryId: d.krdictEntryId }
            : {}),
        },
        ctrl.signal,
      ).then(
        () => undefined,
        (err: unknown) => {
          if (err instanceof ApiError && err.code === 'canceled') return;
          setMinedIds((prev) => {
            if (!prev.has(lemma)) return prev;
            const next = new Set(prev);
            next.delete(lemma);
            return next;
          });
          toast({ message: "Couldn't bank — try again", tone: 'error' });
          // Re-throw so WordPopover rolls its "Added" button back too.
          throw err instanceof Error ? err : new Error('bank failed');
        },
      );
    },
    [toast],
  );

  const popover = popData ? (
    <WordPopover
      data={popData}
      onClose={handleClose}
      onAdd={handleAdd}
      isLoading={popLoading}
      isEnriching={popEnriching}
    />
  ) : null;

  return { minedIds, onTapWord, popover };
}

// ─────────────────────────────────────────────────────────────
// Tappable text rendering (shared by both readers)
// ─────────────────────────────────────────────────────────────

/**
 * Render a Korean string through the shared tokeniser (`tokeniseKorean`) as
 * inline `Tapword`s — the exact `Ttmik.tsx` `TapKorean` pattern, duplicated
 * locally here rather than extracted: only the tap-handler STATE MACHINE
 * (`useTapWord`) was pulled out, not this small render helper (see that
 * hook's header for the scope note).
 */
function TapKorean({
  text,
  minedIds,
  onTapWord,
}: {
  text: string;
  minedIds: ReadonlySet<string>;
  onTapWord: TapWordHandler;
}): JSX.Element {
  const tokens = useMemo(() => tokeniseKorean(text), [text]);
  return (
    <>
      {tokens.map((tk, i) =>
        tk.gloss ? (
          <Tapword
            key={`${String(i)}:${tk.w}`}
            mined={minedIds.has(tk.w)}
            onTap={() => {
              onTapWord(tk.w, text);
            }}
          >
            {tk.w}
          </Tapword>
        ) : (
          <span key={`${String(i)}:sp`}>{tk.w}</span>
        ),
      )}
    </>
  );
}

/**
 * One passage's body, tappable. `tokeniseKorean` treats all whitespace
 * (including `\n`) as a single collapsible token, so a naive single-pass
 * render would flatten a passage's internal line breaks (verse, dialogue
 * turns) into one run-on line — this splits on `\n` first and re-inserts
 * each break as a `<br/>`, tapping each line against its own text as the
 * "source sentence" (the natural sentence unit for the tap chain, mirroring
 * Ttmik's per-line `TapKorean` calls). Normalizes `\r\n` to `\n` first so a
 * Windows-line-ended OCR body doesn't leave a trailing `\r` glued to each
 * line's last token (the loader's own normalization is out of this
 * component's control — defend here regardless).
 */
function PassageBody({
  body,
  minedIds,
  onTapWord,
}: {
  body: string;
  minedIds: ReadonlySet<string>;
  onTapWord: TapWordHandler;
}): JSX.Element {
  const lines = useMemo(
    () => body.replace(/\r\n/g, '\n').split('\n'),
    [body],
  );
  return (
    // `km-reading__passage-text` (Reading.css) carries the doc's Day
    // editorial-serif intent + a ~65ch legibility cap for this page's
    // primary text-heavy surface — layered on TOP of the shared
    // `.km-reference__row-kr` sizing/color so no other consumer of that
    // shared class is affected.
    <p className="kr km-reference__row-kr km-reading__passage-text">
      {lines.map((line, i) => (
        <span key={i}>
          {i > 0 ? <br /> : null}
          <TapKorean text={line} minedIds={minedIds} onTapWord={onTapWord} />
        </span>
      ))}
    </p>
  );
}

/**
 * One passage block: tappable body + the F-070 "Translate" action beneath
 * it. `ariaContext` disambiguates the repeated buttons for screen readers
 * ("Translate passage 3", "Translate paragraph 2").
 */
function TranslatablePassage({
  body,
  ariaContext,
  minedIds,
  onTapWord,
  onTranslate,
}: {
  body: string;
  ariaContext: string;
  minedIds: ReadonlySet<string>;
  onTapWord: TapWordHandler;
  onTranslate: (body: string) => void;
}): JSX.Element {
  return (
    <div className="km-reading__passage">
      <PassageBody body={body} minedIds={minedIds} onTapWord={onTapWord} />
      <div className="km-reading__passage-tools">
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<Icon name="translate" size={12} />}
          aria-label={`Translate ${ariaContext}`}
          onClick={() => {
            onTranslate(body);
          }}
        >
          <Bilingual en="Translate" kr="번역" compact />
        </Button>
      </div>
    </div>
  );
}

/** `TranslateSheet`'s fetch lifecycle — one state at a time, no boolean soup
 *  (mirrors StoryGenerator's `GenState`). No 'idle' phase: the sheet only mounts once a
 *  passage is selected, so it always starts loading immediately. */
type TranslateSheetState =
  | { phase: 'loading' }
  | { phase: 'success'; translation: string }
  | { phase: 'error'; message: string };

/** Fixed fallback copy for a failed translation (errorCopy contract). */
const TRANSLATE_FAILED_COPY = 'Could not translate this passage. Try again.';

/**
 * F-070/F-116 — the whole-passage translation popup (Google-Translate style
 * shell). Fetches `POST /reading/translate` for the selected passage and
 * renders Claude's translation. Abortable: closing/re-opening the sheet
 * (parent re-keys via `text`) or unmounting cancels any in-flight call, and a
 * failure never leaves a stale/half-drawn result — `reloadTick` drives an
 * explicit Retry rather than a silent background re-poll.
 */
function TranslateSheet({
  text,
  onClose,
}: {
  text: string;
  onClose: () => void;
}): JSX.Element {
  const [state, setState] = useState<TranslateSheetState>({ phase: 'loading' });
  const [reloadTick, setReloadTick] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    // Sync-to-external-system (network fetch) — same documented exception the
    // other fetch effects on this page use for their kickoff setState.
    /* eslint-disable react-hooks/set-state-in-effect */
    setState({ phase: 'loading' });
    /* eslint-enable react-hooks/set-state-in-effect */
    translatePassage(text, ctrl.signal)
      .then((translation) => {
        if (ctrl.signal.aborted) return;
        setState({ phase: 'success', translation });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setState({
          phase: 'error',
          message: errorMessageFor(err, TRANSLATE_FAILED_COPY),
        });
      });
    return () => {
      ctrl.abort();
    };
  }, [text, reloadTick]);

  const retry = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  return (
    <Sheet open onClose={onClose} ariaLabel="Passage translation">
      {/* Batch-2 fix-pass precedent (Mistakes/ReviewGrammar) — the shared
          `.km-review__sheet*` classes (index.css) drive the head layout +
          body padding here too, instead of a hand-rolled duplicate. The
          Close action moves to this top-right head row (every other Sheet
          on the app puts dismissal there); `.km-reading__translate-sheet`
          rides as an EXTRA class for the one Reading-specific need (the
          flex-column stack of src/result blocks below it). */}
      <div className="km-review__sheet-body km-reading__translate-sheet">
        <div className="km-review__sheet-head">
          <Eyebrow>
            <Bilingual en="Translation" kr="번역" compact />
          </Eyebrow>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <p className="kr km-reading__translate-src">{text}</p>
        {state.phase === 'loading' ? (
          <div className="km-reading__translate-stub" role="status">
            <Bilingual en="Translating…" kr="번역 중…" compact />
          </div>
        ) : state.phase === 'error' ? (
          <ErrorCard message={state.message} onRetry={retry} />
        ) : (
          <p className="km-reading__translate-result">{state.translation}</p>
        )}
      </div>
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────
// Chapter reader (?book=ID&chapter=N)
// ─────────────────────────────────────────────────────────────

/** Skeleton placeholder while a chapter/story loads (mirrors Ttmik's). */
function SkeletonCard(): JSX.Element {
  return (
    <Card
      variant="default"
      aria-busy="true"
      style={{ minHeight: 240, opacity: 0.55 }}
    >
      <></>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// Mark-as-read/finished (F-172 — reading_attempts, migration 060)
// ─────────────────────────────────────────────────────────────

/**
 * The completion-log POST's lifecycle. No 'idle' → 'saving' → 'done' loop
 * back to 'idle': once logged, the button stays in its done state for the
 * rest of this reader's mount (re-opening the chapter/story remounts fresh,
 * per the `key={chapterId}`/`key={storyId}` on the parent's view branch) —
 * a second mark against the SAME open session would just be a duplicate log
 * row for no user-visible benefit.
 */
type MarkReadState =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'done' }
  | { phase: 'error'; message: string };

/** Fixed fallback copy for a failed completion-log POST (errorCopy contract). */
const MARK_READ_FAILED_COPY = "Couldn't save — try again.";

/**
 * The explicit "I finished this" affordance shared by the chapter reader and
 * the story reader (F-172; there is no scroll- or position-derived
 * auto-completion signal this phase — see the scoping doc's own note that a
 * generated story has no passage/position tracking at all). `aria-disabled`
 * (not `disabled`) while saving/done, matching the shared `StoryGenerator`
 * busy-button convention — the hard attribute would drop keyboard focus.
 */
function MarkCompleteButton({
  state,
  onMark,
  labelEn,
  labelKr,
  doneLabelEn,
  doneLabelKr,
}: {
  state: MarkReadState;
  onMark: () => void;
  labelEn: string;
  labelKr: string;
  doneLabelEn: string;
  doneLabelKr: string;
}): JSX.Element {
  const busy = state.phase === 'saving';
  const done = state.phase === 'done';
  return (
    <div style={{ margin: '16px 0' }}>
      <Button
        variant={done ? 'ghost' : 'gold'}
        size="sm"
        leadingIcon={<Icon name="check" size={14} />}
        aria-disabled={busy || done || undefined}
        onClick={() => {
          if (busy || done) return; // aria-disabled doesn't block clicks — we do.
          onMark();
        }}
      >
        {done ? (
          <Bilingual en={doneLabelEn} kr={doneLabelKr} compact />
        ) : busy ? (
          <Bilingual en="Saving…" kr="저장 중…" compact />
        ) : (
          <Bilingual en={labelEn} kr={labelKr} compact />
        )}
      </Button>
      {state.phase === 'error' ? (
        <span role="alert" style={{ marginLeft: 8 }}>
          {state.message}
        </span>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Comprehension check (F-205 — reading_questions, migration 086)
// ─────────────────────────────────────────────────────────────

/** ①②③④ — the Diagnostic/TOPIK marker idiom, reused verbatim so a picked
 *  option reads consistently across every MC surface in the app. */
const QUESTION_MARKERS = ['①', '②', '③', '④'] as const;

/**
 * Fetch/generation lifecycle for one chapter's comprehension check.
 *   - `loading`    — the mount GET is in flight.
 *   - `error`      — the GET failed (fixed-copy message; retry re-fetches).
 *   - `empty`      — GET succeeded with zero stored questions (the normal
 *                    not-generated-yet state) — the explicit generate
 *                    button lives here.
 *   - `generating` — the POST is in flight (button shows a busy state).
 *   - `ready`      — questions to render, whether they arrived via the GET
 *                    or a fresh POST.
 */
type ComprehensionState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'empty' }
  | { phase: 'generating' }
  | { phase: 'ready'; questions: ReadingQuestion[] };

/** Fixed fallback copy (errorCopy contract — server prose is never echoed). */
const QUESTIONS_LOAD_FAILED_COPY = 'Could not load the comprehension check.';
const QUESTIONS_GENERATE_FAILED_COPY =
  'Could not generate the comprehension check.';

/** correct/answered tally over the current picks, in question order. */
function tallyScore(
  questions: ReadingQuestion[],
  picks: Readonly<Record<number, number>>,
): { correct: number; answered: number } {
  let correct = 0;
  let answered = 0;
  for (const q of questions) {
    const pickedIndex = picks[q.id];
    if (pickedIndex === undefined) continue;
    answered += 1;
    if (q.options[pickedIndex]?.correct === true) correct += 1;
  }
  return { correct, answered };
}

/**
 * One MC question card — the Diagnostic reveal idiom verbatim (`Diagnostic.
 * tsx` ~817-855): pick a ①②③④ option → immediate reveal (correctness is
 * already known client-side, no server round trip to grade — the DTO holds
 * `correct` deliberately, see services/reading.ts) → correct/not-quite
 * eyebrow + the bilingual explanation + an `AskAboutThisButton` tutor
 * handoff seeded with this question's own context. Self-contained (does
 * NOT reuse Diagnostic's own `ChoiceList`/`Card` — additive per F-205's
 * scope, that component is not built to take an externally-supplied
 * options array).
 */
function ComprehensionQuestion({
  question,
  pickedIndex,
  onPick,
  passage,
}: {
  question: ReadingQuestion;
  pickedIndex: number | undefined;
  onPick: (index: number) => void;
  passage: string;
}): JSX.Element {
  const revealed = pickedIndex !== undefined;
  const isCorrect = revealed && question.options[pickedIndex]?.correct === true;
  const correctOption = question.options.find((o) => o.correct);
  const pickedOption = revealed ? question.options[pickedIndex] : undefined;

  return (
    <Card variant="flat" className="km-reading__q">
      <p className="kr km-reading__q-prompt">
        {String(question.questionNumber)}. {question.questionText}
      </p>
      <div
        className="km-reading__q-choices"
        role="radiogroup"
        aria-label={`Question ${String(question.questionNumber)} answer choices`}
      >
        {question.options.map((opt, i) => {
          const isPicked = pickedIndex === i;
          const showCorrect = revealed && opt.correct;
          const showWrong = revealed && isPicked && !opt.correct;
          return (
            <button
              key={`${String(question.id)}-${String(i)}`}
              type="button"
              role="radio"
              aria-checked={isPicked}
              disabled={revealed}
              className={cn(
                'km-reading__q-choice focusring',
                isPicked && !revealed && 'km-reading__q-choice--picked',
                showCorrect && 'km-reading__q-choice--correct',
                showWrong && 'km-reading__q-choice--wrong',
              )}
              onClick={() => {
                if (!revealed) onPick(i);
              }}
            >
              <span className="km-reading__q-marker">
                {QUESTION_MARKERS[i] ?? String(i + 1)}
              </span>
              <span className="kr km-reading__q-choice-text">{opt.text}</span>
              {showCorrect ? <Icon name="check" size={16} /> : null}
            </button>
          );
        })}
      </div>

      {revealed ? (
        <Card variant="default" className="km-reading__q-reveal">
          <Eyebrow>
            {isCorrect ? (
              <Bilingual en="Correct" kr="정답" />
            ) : (
              <Bilingual en="Not quite" kr="아쉬워요" />
            )}
          </Eyebrow>
          <p className="km-reading__q-explain">{question.explanation}</p>
          <div style={{ marginTop: 10 }}>
            <AskAboutThisButton
              prompt={question.questionText}
              correctText={correctOption?.text ?? ''}
              explanation={question.explanation}
              passage={passage}
              userPick={!isCorrect ? pickedOption?.text : undefined}
            />
          </div>
        </Card>
      ) : null}
    </Card>
  );
}

/**
 * "Check your understanding" — the chapter's AI-generated MC comprehension
 * check (F-205 Phase 1). ADDITIVE: mounted at the end of `ChapterReader`,
 * never touches the passage reader above it. Ships EMPTY-safe — a chapter
 * with no stored questions shows an explicit "Generate comprehension check"
 * button (never auto-generates on load, the F-216 posture) rather than a
 * silent metered call.
 */
function ComprehensionCheckCard({
  chapterId,
  passage,
}: {
  chapterId: number;
  /** The chapter's own prose, joined — handed to `AskAboutThisButton` as the
   *  tutor's shared-passage context (truncated by `buildAskSeed` itself). */
  passage: string;
}): JSX.Element {
  const [state, setState] = useState<ComprehensionState>({ phase: 'loading' });
  const [genError, setGenError] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<number, number>>({});
  const [reloadTick, setReloadTick] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);

  // The mount/retry fetch — inlined directly in the effect (not behind a
  // separately-invoked callback) and `retry` just bumps `reloadTick`,
  // matching `ChapterReader`'s and `TranslateSheet`'s own fetch-effect shape
  // on this page.
  useEffect(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    /* eslint-disable react-hooks/set-state-in-effect */
    setState({ phase: 'loading' });
    setGenError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    getChapterQuestions(chapterId, ctrl.signal).then(
      (qs) => {
        if (ctrl.signal.aborted) return;
        setPicks({});
        setState(
          qs.length > 0 ? { phase: 'ready', questions: qs } : { phase: 'empty' },
        );
      },
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setState({
          phase: 'error',
          message: errorMessageFor(err, QUESTIONS_LOAD_FAILED_COPY),
        });
      },
    );
    return () => {
      ctrl.abort();
    };
  }, [chapterId, reloadTick]);

  const retry = useCallback((): void => {
    setReloadTick((t) => t + 1);
  }, []);

  const generate = useCallback((): void => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setState({ phase: 'generating' });
    setGenError(null);
    generateChapterQuestions(chapterId, ctrl.signal).then(
      (qs) => {
        if (ctrl.signal.aborted) return;
        setPicks({});
        setState(
          qs.length > 0 ? { phase: 'ready', questions: qs } : { phase: 'empty' },
        );
      },
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setState({ phase: 'empty' });
        if (
          err instanceof ApiError &&
          err.status === 429 &&
          err.retryAfter === undefined
        ) {
          // The per-user DAILY generation cap — server-authored whitelisted
          // copy, shown verbatim (the F-210/F-211 daily-cap posture); the
          // button stays available for tomorrow. A short-window 429 carries
          // `retryAfter` and falls through to errorMessageFor below instead.
          setGenError(err.message);
          return;
        }
        setGenError(errorMessageFor(err, QUESTIONS_GENERATE_FAILED_COPY));
      },
    );
  }, [chapterId]);

  const onPick = useCallback((questionId: number, index: number): void => {
    setPicks((prev) =>
      prev[questionId] !== undefined ? prev : { ...prev, [questionId]: index },
    );
  }, []);

  return (
    <CityCard tone="crimson" rail className="km-reading__comprehension">
      <Eyebrow>
        <Bilingual en="Check your understanding" kr="이해도 확인" compact />
      </Eyebrow>

      {state.phase === 'loading' ? (
        <p className="km-reading__comprehension-busy" role="status">
          <Bilingual en="Loading…" kr="불러오는 중…" compact />
        </p>
      ) : state.phase === 'error' ? (
        <ErrorCard message={state.message} onRetry={retry} />
      ) : state.phase === 'empty' ? (
        <>
          <p className="km-reading__comprehension-copy">
            <Bilingual
              en="No comprehension check yet for this chapter."
              kr="아직 이 장의 이해도 확인 문제가 없어요."
              compact
            />
          </p>
          {genError !== null ? (
            <p className="km-reading__comprehension-error" role="alert">
              {genError}
            </p>
          ) : null}
          <Button
            variant="gold"
            size="sm"
            leadingIcon={<Icon name="spark" size={14} />}
            onClick={generate}
          >
            <Bilingual en="Generate comprehension check" kr="이해도 확인 생성" compact />
          </Button>
        </>
      ) : state.phase === 'generating' ? (
        <p className="km-reading__comprehension-busy" role="status">
          <Bilingual en="Generating…" kr="생성 중…" compact />
        </p>
      ) : (
        <>
          {state.questions.map((q) => (
            <ComprehensionQuestion
              key={q.id}
              question={q}
              pickedIndex={picks[q.id]}
              onPick={(index) => {
                onPick(q.id, index);
              }}
              passage={passage}
            />
          ))}
          {(() => {
            const { correct, answered } = tallyScore(state.questions, picks);
            return answered === state.questions.length ? (
              <p className="km-reading__comprehension-score" role="status">
                <Bilingual
                  en={`Score: ${String(correct)} / ${String(state.questions.length)}`}
                  kr={`점수: ${String(correct)} / ${String(state.questions.length)}`}
                  compact
                />
              </p>
            ) : null;
          })()}
        </>
      )}
    </CityCard>
  );
}

function ChapterReader({ chapterId }: { chapterId: number }): JSX.Element {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [chapter, setChapter] = useState<ReadingChapter | null>(null);
  const [passages, setPassages] = useState<ReadingPassage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [translateText, setTranslateText] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  const { minedIds, onTapWord, popover } = useMineable();

  useEffect(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    getChapter(chapterId, ctrl.signal)
      .then(({ chapter: ch, passages: ps }) => {
        if (ctrl.signal.aborted) return;
        setChapter(ch);
        setPassages(ps);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(errorMessageFor(err, 'Could not load this chapter.'));
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [chapterId, reloadTick]);

  // F-069: opening a chapter IS the resume position — one PUT per loaded
  // chapter (chapter granularity; `page_number` carries the chapter's scan
  // start so the position survives a future chapter re-number). A failed
  // save gets ONE error toast — never blocks reading, never retries in a
  // loop; the next chapter open writes fresh anyway.
  useEffect(() => {
    if (chapter === null) return;
    const ctrl = new AbortController();
    saveReadingPosition(
      String(chapter.sourceUploadId),
      { chapterId: chapter.id, pageNumber: chapter.startPage },
      ctrl.signal,
    ).catch((err: unknown) => {
      if (ctrl.signal.aborted) return;
      if (err instanceof ApiError && err.code === 'canceled') return;
      // F-217: the position routes are owner-ONLY (051's composite FK —
      // widening needs a migration), so a NON-owner reading a SHARED book
      // 404s on this PUT every time. That's the expected can't-save state
      // for a borrowed book, not a failure — skip silently rather than
      // toast an "error" on every chapter open. This also silences the one
      // other 404 shape: an OWNED book deleted mid-read (the position save
      // is moot for a book that no longer exists, so no toast there either).
      // Genuine save failures on an owned, live book (5xx, network) are not
      // 404s, so the toast below still fires for those.
      if (err instanceof ApiError && err.status === 404) return;
      toast({
        message: "Couldn't save your reading position",
        tone: 'error',
      });
    });
    return () => {
      ctrl.abort();
    };
  }, [chapter, toast]);

  const refetch = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  // Defensive order — the server already orders by passage_number.
  const orderedPassages = useMemo(
    () => [...passages].sort((a, b) => a.passageNumber - b.passageNumber),
    [passages],
  );

  // F-172 — "Mark chapter as read" (reading_attempts, migration 060). A NEW
  // explicit completion trigger (this reader has no scroll-position telemetry
  // to derive completion from); passageNumber records the LAST passage
  // rendered, when any exist, so the log carries "how far" alongside "which
  // chapter". Aborted on unmount so a closed reader never lands a late
  // setState.
  const [markState, setMarkState] = useState<MarkReadState>({ phase: 'idle' });
  const markCtrlRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      markCtrlRef.current?.abort();
    },
    [],
  );
  const markChapterRead = useCallback((): void => {
    if (chapter === null) return;
    markCtrlRef.current?.abort();
    const ctrl = new AbortController();
    markCtrlRef.current = ctrl;
    setMarkState({ phase: 'saving' });
    const lastPassage = orderedPassages[orderedPassages.length - 1];
    logReadingAttempt(
      {
        sourceKind: 'chapter',
        chapterId: chapter.id,
        ...(lastPassage !== undefined
          ? { passageNumber: lastPassage.passageNumber }
          : {}),
      },
      ctrl.signal,
    ).then(
      () => {
        if (ctrl.signal.aborted) return;
        setMarkState({ phase: 'done' });
      },
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setMarkState({
          phase: 'error',
          message: errorMessageFor(err, MARK_READ_FAILED_COPY),
        });
      },
    );
  }, [chapter, orderedPassages]);

  if (loading) return <SkeletonCard />;
  if (error !== null || chapter === null) {
    return (
      <ErrorCard
        message={error ?? 'Could not load this chapter.'}
        onRetry={refetch}
      />
    );
  }

  const chapterLabel = chapter.title ?? `Chapter ${String(chapter.chapterNumber)}`;

  return (
    <div>
      <Eyebrow>
        <Bilingual
          en={`Chapter ${String(chapter.chapterNumber)}`}
          kr={`${String(chapter.chapterNumber)}장`}
        />
      </Eyebrow>
      <h2 className="kr kr-display" style={{ margin: '4px 0 6px' }}>
        {chapterLabel}
      </h2>
      <div style={{ margin: '0 0 18px' }}>
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<Icon name="book" size={12} />}
          onClick={() => {
            // U3c deep-link: open the scan at this chapter's own start page
            // (`startPage` IS `book_pages.page_number` — the loader wrote it
            // as such, no offset correction). Null startPage → bare route →
            // page 1, exactly the pre-U3c behavior.
            navigate(
              chapter.startPage !== null
                ? `/uploads/${String(chapter.sourceUploadId)}?page=${String(chapter.startPage)}`
                : `/uploads/${String(chapter.sourceUploadId)}`,
            );
          }}
        >
          <Bilingual en="View original scan" kr="원본 스캔 보기" compact />
        </Button>
      </div>

      {orderedPassages.length === 0 ? (
        <p
          className="km-reference__empty km-giwa km-hangul-watermark"
          data-glyph="본문"
        >
          <Bilingual
            en="No passages yet for this chapter."
            kr="아직 이 장의 본문이 없어요."
          />
        </p>
      ) : (
        // The chapter's reading surface: a CityCard signboard (Night) /
        // hanji-paper (Day) card (device #1) with a leading DancheongRail
        // (device #2). `tone="accent"` matches the design mock's default
        // (unmodified) passage sign — the accent glow lives on the CARD
        // EDGE only; the body copy itself stays calm via
        // `.km-reading__passage-text` (PassageBody, above).
        <CityCard tone="accent" rail className="km-reading__reader-card">
          {orderedPassages.map((passage) => (
            <TranslatablePassage
              key={passage.id}
              body={passage.body}
              ariaContext={`passage ${String(passage.passageNumber)}`}
              minedIds={minedIds}
              onTapWord={onTapWord}
              onTranslate={setTranslateText}
            />
          ))}
        </CityCard>
      )}

      {/* F-205 — the AI-generated MC comprehension check. Additive, at the
          very end of the reader: only offered once there is prose to
          generate FROM (an empty chapter has nothing to check). */}
      {orderedPassages.length > 0 ? (
        <ComprehensionCheckCard
          chapterId={chapter.id}
          passage={orderedPassages.map((p) => p.body).join('\n\n')}
        />
      ) : null}

      <MarkCompleteButton
        state={markState}
        onMark={markChapterRead}
        labelEn="Mark chapter as read"
        labelKr="장 읽음으로 표시"
        doneLabelEn="Chapter read"
        doneLabelKr="읽음"
      />

      {popover}
      {translateText !== null ? (
        <TranslateSheet
          text={translateText}
          onClose={() => {
            setTranslateText(null);
          }}
        />
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Stories tab — generator + library (F-068)
// ─────────────────────────────────────────────────────────────
// The `StoryGenerator` panel moved to `components/StoryGenerator.tsx`
// (shared with the Listen landing's story creator); this page imports it
// and keeps its original wiring — `onCreated` opens the fresh story.

/** Library date — short, locale-fixed (the app's copy is en-first), and
 *  silent on an unparseable server timestamp rather than "Invalid Date". */
function formatStoryDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * F-216 — pip color per aggregate asset status, on the app's existing
 * token vocabulary (the `--km-mastery-*` precedent: moss = settled-good,
 * ochre-ink = in progress, danger = failed, paper-mute = nothing yet).
 * Total by construction — an unknown value (a defensive impossibility once
 * the wire is typed) degrades to the muted "nothing yet" tone.
 */
function assetPipColor(status: AssetStatus): string {
  switch (status) {
    case 'done':
      return 'var(--moss)';
    case 'pending':
    case 'running':
      return 'var(--ochre-ink)';
    case 'failed':
      return 'var(--danger)';
    case 'none':
      return 'var(--paper-mute)';
  }
}

/**
 * F-216 — one compact per-row asset-status pip (audio = headphones glyph,
 * image = picture glyph; the registry's `currentColor` strokes take the
 * status color directly). `role="img"` + a plain-English `aria-label`
 * ("audio: done") make the glyph-only status legible to AT; `title` gives
 * pointer users the same reading. Rendered inside the row button's middle
 * grid cell (next to the level Pill) so the existing title/level/date
 * three-column layout is untouched.
 */
function AssetStatusPip({
  kind,
  status,
}: {
  kind: 'audio' | 'image';
  status: AssetStatus;
}): JSX.Element {
  const label = `${kind}: ${status}`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="km-reading__asset-pip"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        color: assetPipColor(status),
      }}
    >
      <Icon name={kind === 'audio' ? 'headphones' : 'image'} size={12} />
    </span>
  );
}

function StoriesSection({
  onOpenStory,
}: {
  onOpenStory: (id: number) => void;
}): JSX.Element {
  const [stories, setStories] = useState<GeneratedStorySummary[]>([]);
  // F-216 — the library envelope's capability flags gate the badge pips.
  // Default-TRUE (only an explicit false hides — the ttsConfigured posture)
  // so an older server that omits the flags keeps both pips visible.
  const [showAudioPips, setShowAudioPips] = useState(true);
  const [showImagePips, setShowImagePips] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    listGeneratedStories(ctrl.signal)
      .then((library) => {
        if (ctrl.signal.aborted) return;
        setStories(library.stories);
        setShowAudioPips(library.ttsConfigured !== false);
        setShowImagePips(library.imageGenConfigured !== false);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(errorMessageFor(err, 'Could not load your stories.'));
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  // Window the library (server caps the list at 200; match that ceiling so
  // "Show more" can eventually reach everything the server sent).
  const pag = usePagination(stories, { initial: 10, step: 10, max: 200 });

  return (
    <div>
      <StoryGenerator
        onCreated={(story) => {
          onOpenStory(story.id);
        }}
      />

      <h2 className="km-reading__section-title" style={{ marginTop: 22 }}>
        <Bilingual en="Your stories" kr="내 이야기" />
      </h2>
      {loading ? (
        <div className="km-grammar__state" role="status">
          <Bilingual en="Loading stories…" kr="이야기를 불러오는 중…" />
        </div>
      ) : error !== null ? (
        <ErrorCard message={error} onRetry={refetch} />
      ) : stories.length === 0 ? (
        <p
          className="km-reference__empty km-giwa km-hangul-watermark"
          data-glyph="이야기"
        >
          <Bilingual
            en="No stories yet — generate your first one above."
            kr="아직 이야기가 없어요. 위에서 첫 이야기를 만들어 보세요."
          />
        </p>
      ) : (
        <>
          <Card className="km-reference__list" variant="flat">
            <ul>
              {pag.visible.map((story) => (
                <li key={story.id} className="km-reference__row">
                  <button
                    type="button"
                    className="km-resources__list-open focusring"
                    onClick={() => {
                      onOpenStory(story.id);
                    }}
                    aria-label={`Open ${story.title}`}
                  >
                    <span className="kr km-reference__row-kr">
                      {story.title}
                    </span>
                    {/* Level + the F-216 asset pips share the middle grid
                        cell (an inline-flex wrapper), preserving the row's
                        original title/level/date three-column layout. A
                        dormant capability (explicit false) drops its pip
                        entirely — absence, not a dead muted glyph. */}
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <Pill tone="gold">{story.level}</Pill>
                      {showAudioPips ? (
                        <AssetStatusPip
                          kind="audio"
                          status={story.audioStatus}
                        />
                      ) : null}
                      {showImagePips ? (
                        <AssetStatusPip
                          kind="image"
                          status={story.imageStatus}
                        />
                      ) : null}
                    </span>
                    <span className="km-resources__pager-count">
                      {formatStoryDate(story.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          <ShowMore
            canShowMore={pag.canShowMore}
            onShowMore={pag.showMore}
            remaining={pag.remaining}
          />
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Story TTS audio (F-210) — request / poll / read-along
// ─────────────────────────────────────────────────────────────
// The `useStoryAudio` state machine (and its poll constants) moved to
// `hooks/useStoryAudio.ts` (shared with the Listen landing's story creator
// card), and `activeSegmentNumberAt` to `lib/readAlong.ts` (shared with the
// Listen track player's read-along); the ref/listener wiring below stays
// reader-only.

// ─────────────────────────────────────────────────────────────
// Story illustrations (F-211) — request / poll / gallery
// ─────────────────────────────────────────────────────────────

/** Poll cadence while an illustration job is pending/running (server
 *  contract: "poll every ~2–3s until done or failed" — image batches take
 *  longer than TTS, so the cadence sits a touch above F-210's 2s). */
const STORY_IMAGES_POLL_MS = 2500;

/**
 * Poll attempt ceiling — bounded churn for a never-settling job (the
 * useStoryAudio precedent). 120 ticks × 2.5s = 5 minutes, generous against
 * a 2–4-image batch's real generation time; the last known status stays on
 * screen and a reopen restarts the budget.
 */
const STORY_IMAGES_POLL_MAX_TICKS = 120;

/** Fixed fallback copy for a failed illustration REQUEST (errorCopy
 *  contract). */
const IMAGES_REQUEST_FAILED_COPY =
  'Could not request illustrations. Try again.';

/** Fixed fallback shown for a `failed` envelope whose `error` is null
 *  (defensive — the server settles a failure with copy, but never trust
 *  a nullable field to be populated). */
const IMAGES_FAILED_FALLBACK_COPY =
  'Illustration generation failed. Try again.';

/** The empty envelope — what a hydrate failure degrades to (the button
 *  shows; the POST is idempotent, so a tap on an already-illustrated story
 *  just returns the done envelope — self-healing). */
const NO_STORY_IMAGES: StoryImagesEnvelope = {
  status: 'none',
  jobId: null,
  error: null,
  images: [],
};

/**
 * F-211 story-images state machine — the useStoryAudio recipe verbatim:
 * hydrate once on mount (a batch-at-create story is usually pending or
 * already done), POST on demand (old stories), poll the GET every
 * `STORY_IMAGES_POLL_MS` while a job is pending/running, and stop on settle
 * (done/failed), unmount, a terminal mid-poll 404, or the tick ceiling.
 * Every request is abortable; cleanup aborts in-flight calls so a closed
 * reader never lands a late setState (the page-wide contract).
 *
 * Error copy: the daily-cap 429 (no `retryAfter`) and a `failed` envelope's
 * `error` are server-authored WHITELISTED copy shown verbatim — the same
 * sanctioned exception to the fixed-copy rule as F-210 (see
 * services/reading.ts `requestStoryImages`). Everything else routes through
 * `errorMessageFor` as usual.
 */
function useStoryImages(storyId: number): {
  /** Latest envelope, or null while the mount hydrate is in flight. */
  images: StoryImagesEnvelope | null;
  /** True while the POST itself is in flight (pre-202 button busy state). */
  requesting: boolean;
  /** Request failure copy (429 cap verbatim / fixed copy), or null. */
  requestError: string | null;
  requestImages: () => void;
  /** F-216 — imperatively land a fresh envelope from OUTSIDE this hook's
   *  own request path (the combined-experience POST's images half). Pure
   *  setState: a pending/running envelope flips `polling` and starts the
   *  bounded poll exactly as `requestImages`'s 202 would; a settled one
   *  renders directly. The hydrate/poll/abort lifecycle is untouched. */
  seed: (env: StoryImagesEnvelope) => void;
} {
  const [images, setImages] = useState<StoryImagesEnvelope | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const hydrateCtrlRef = useRef<AbortController | null>(null);
  const pollTickCtrlRef = useRef<AbortController | null>(null);
  const requestCtrlRef = useRef<AbortController | null>(null);

  // Hydrate once per story: `done` shows the gallery with no click; a
  // `pending`/`running` (the batch-at-create job, or one requested in an
  // earlier session) resumes polling.
  useEffect(() => {
    const ctrl = new AbortController();
    hydrateCtrlRef.current?.abort();
    hydrateCtrlRef.current = ctrl;
    getStoryImages(storyId, ctrl.signal)
      .then((env) => {
        if (ctrl.signal.aborted) return;
        setImages(env);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        // Degrade to 'none' rather than blocking the reader behind an image
        // status probe: the button renders, and the idempotent POST
        // self-heals (an already-illustrated story answers 200 done).
        setImages(NO_STORY_IMAGES);
      });
    return () => {
      ctrl.abort();
    };
  }, [storyId]);

  // Poll while a job is unsettled — per-tick abort-before-fetch, transient
  // failures retried next tick, terminal 404 (story deleted mid-poll) stops
  // immediately, and the interval + in-flight tick both die on unmount
  // (useStoryAudio's exact posture).
  const status = images?.status;
  const polling = status === 'pending' || status === 'running';
  useEffect(() => {
    if (!polling) return;
    let ticks = 0; // effect-local — every (re)start gets a fresh budget
    const id = window.setInterval(() => {
      ticks += 1;
      if (ticks > STORY_IMAGES_POLL_MAX_TICKS) {
        window.clearInterval(id);
        return;
      }
      pollTickCtrlRef.current?.abort();
      const ctrl = new AbortController();
      pollTickCtrlRef.current = ctrl;
      getStoryImages(storyId, ctrl.signal)
        .then((env) => {
          if (ctrl.signal.aborted) return;
          // Settling to done/failed flips `polling` false → effect teardown
          // clears this interval.
          setImages(env);
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return;
          if (err instanceof ApiError && err.code === 'canceled') return;
          if (err instanceof ApiError && err.status === 404) {
            // Story gone mid-poll — terminal: stop NOW rather than hammer a
            // route that can only 404 again.
            window.clearInterval(id);
            return;
          }
          // Transient poll failure — next tick retries.
        });
    }, STORY_IMAGES_POLL_MS);
    return () => {
      window.clearInterval(id);
      pollTickCtrlRef.current?.abort();
      pollTickCtrlRef.current = null;
    };
  }, [polling, storyId]);

  // Abort an in-flight POST on unmount (the hydrate/poll effects own their
  // own cleanup above).
  useEffect(
    () => () => {
      requestCtrlRef.current?.abort();
    },
    [],
  );

  const requestImages = useCallback((): void => {
    requestCtrlRef.current?.abort();
    const ctrl = new AbortController();
    requestCtrlRef.current = ctrl;
    setRequesting(true);
    setRequestError(null);
    requestStoryImages(storyId, ctrl.signal).then(
      (env) => {
        if (ctrl.signal.aborted) return;
        setRequesting(false);
        // 202 lands a pending/running envelope (polling starts via the
        // effect above); 200 lands `done` directly (already illustrated).
        setImages(env);
      },
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setRequesting(false);
        if (
          err instanceof ApiError &&
          err.status === 429 &&
          err.retryAfter === undefined
        ) {
          // The DAILY image cap — server-authored whitelisted copy, shown
          // verbatim (the F-210 daily-TTS-cap posture); the button stays
          // available. A short-window 429 carries `retryAfter` and falls
          // through to errorMessageFor's structured copy instead.
          setRequestError(err.message);
          return;
        }
        setRequestError(errorMessageFor(err, IMAGES_REQUEST_FAILED_COPY));
      },
    );
  }, [storyId]);

  const seed = useCallback((env: StoryImagesEnvelope): void => {
    // A seeded envelope supersedes any earlier per-asset failure — clear the
    // stale error so a capped experience half doesn't render two alerts.
    setRequestError(null);
    setImages(env);
  }, []);

  return { images, requesting, requestError, requestImages, seed };
}

/**
 * One scene illustration. Owns its own load-failure state so a broken blob
 * degrades to ABSENCE (no broken-image glyph, no dead frame) without
 * touching its siblings. `src` has already passed `buildStoryImageSrc`'s
 * allow-list — this component never sees a raw wire value. `alt` stays a
 * generic ordinal: the envelope's `prompt` is English generation
 * scaffolding, not user-facing copy, so it never reaches the DOM.
 * `width`/`height` reserve layout space before the lazy bytes arrive.
 */
function StoryIllustration({
  src,
  imageNumber,
  width,
  height,
}: {
  src: string;
  imageNumber: number;
  width: number;
  height: number;
}): JSX.Element | null {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <figure className="km-reading__images-item">
      <img
        src={src}
        alt={`Story illustration ${String(imageNumber)}`}
        loading="lazy"
        width={width}
        height={height}
        onError={() => {
          setFailed(true);
        }}
      />
    </figure>
  );
}

// ─────────────────────────────────────────────────────────────
// Unified story experience (F-216) — one-tap audio + illustrations
// ─────────────────────────────────────────────────────────────

/** Fixed fallback copy for a failed combined-experience REQUEST (errorCopy
 *  contract — per-half daily caps arrive as `enqueueBlocked`, never as a
 *  throw, so this covers only whole-call failures). */
const EXPERIENCE_REQUEST_FAILED_COPY =
  'Could not start the full experience. Try again.';

/** Fixed per-half daily-cap notices. Unlike the per-asset POSTs (whose 429
 *  carries server-authored copy), the experience route reports a capped
 *  half as the `'daily_cap'` discriminator — so the copy here is
 *  client-fixed, per the app's errorCopy stance. */
const EXPERIENCE_AUDIO_CAPPED_COPY =
  'Audio: daily limit reached — try tomorrow.';
const EXPERIENCE_IMAGES_CAPPED_COPY =
  'Illustrations: daily limit reached — try tomorrow.';

// ─────────────────────────────────────────────────────────────
// Story reader (?story=N)
// ─────────────────────────────────────────────────────────────

function StoryReader({ storyId }: { storyId: number }): JSX.Element {
  const [story, setStory] = useState<GeneratedStory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [translateText, setTranslateText] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  const { minedIds, onTapWord, popover } = useMineable();

  useEffect(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    getGeneratedStory(storyId, ctrl.signal)
      .then((s) => {
        if (ctrl.signal.aborted) return;
        setStory(s);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(errorMessageFor(err, 'Could not load this story.'));
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [storyId, reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  // Paragraph blocks: blank-line separated (Claude authors prose with
  // paragraph breaks); single `\n`s inside a block are preserved by
  // `PassageBody`. `\r\n` normalized first — same defense as PassageBody's.
  const paragraphs = useMemo(() => {
    if (story === null) return [];
    return story.bodyKo
      .replace(/\r\n/g, '\n')
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter((block) => block !== '');
  }, [story]);

  // ── F-210: story TTS audio + read-along highlighting ──
  const { audio, requesting, requestError, requestAudio, seed: seedAudio } =
    useStoryAudio(storyId);

  // ── F-211: story illustrations ──
  const {
    images,
    requesting: requestingImages,
    requestError: imagesRequestError,
    requestImages,
    seed: seedImages,
  } = useStoryImages(storyId);

  // ── F-216: one-tap combined generation (audio + illustrations) ──
  // One POST attempts both enqueues server-side; the response carries both
  // asset envelopes, which SEED the two hooks above — a pending/running
  // half starts its own bounded poll exactly as its dedicated button's 202
  // would, and a dormant half's capability flag hides its card outright.
  const [expRequesting, setExpRequesting] = useState(false);
  const [expError, setExpError] = useState<string | null>(null);
  const [expAudioCapped, setExpAudioCapped] = useState(false);
  const [expImagesCapped, setExpImagesCapped] = useState(false);
  const expCtrlRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      expCtrlRef.current?.abort();
    },
    [],
  );
  const requestExperience = useCallback((): void => {
    expCtrlRef.current?.abort();
    const ctrl = new AbortController();
    expCtrlRef.current = ctrl;
    setExpRequesting(true);
    setExpError(null);
    setExpAudioCapped(false);
    setExpImagesCapped(false);
    requestStoryExperience(storyId, ctrl.signal).then(
      (exp) => {
        if (ctrl.signal.aborted) return;
        setExpRequesting(false);
        // Strip the wrapper-only discriminator before seeding so the hooks
        // hold exactly the DTO shape their own routes return.
        const { enqueueBlocked: audioBlocked, ...audioEnv } = exp.audio;
        const { enqueueBlocked: imagesBlocked, ...imagesEnv } = exp.images;
        seedAudio(audioEnv);
        seedImages(imagesEnv);
        // daily_cap surfaces an inline notice for that half; 'dormant' is
        // deliberately silent — the seeded envelope's capability flag
        // already hides the whole surface (absence, not an apology).
        setExpAudioCapped(audioBlocked === 'daily_cap');
        setExpImagesCapped(imagesBlocked === 'daily_cap');
      },
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setExpRequesting(false);
        setExpError(errorMessageFor(err, EXPERIENCE_REQUEST_FAILED_COPY));
      },
    );
  }, [storyId, seedAudio, seedImages]);

  // Visibility: only once BOTH hydrates have landed (the button must never
  // pop in ahead of the state it summarizes), when at least one half is
  // not-yet-done AND that half's capability is on (only an explicit false
  // is dormant). Both-done and both-dormant both collapse to absence.
  const audioHalfWanted =
    audio !== null && audio.ttsConfigured !== false && audio.status !== 'done';
  const imagesHalfWanted =
    images !== null &&
    images.imageGenConfigured !== false &&
    images.status !== 'done';
  const showExperienceButton =
    audio !== null && images !== null && (audioHalfWanted || imagesHalfWanted);

  // Every candidate resolves through the strict allow-list; a tampered or
  // off-origin blobUrl drops out here, so the gallery below never touches a
  // raw wire value. Defensive ordinal sort (the orderedSegments stance —
  // the server already orders by image_number).
  const displayableImages = useMemo(() => {
    if (images === null || images.status !== 'done') return [];
    return [...images.images]
      .sort((a, b) => a.imageNumber - b.imageNumber)
      .map((img) => ({ img, src: buildStoryImageSrc(img.blobUrl) }))
      .filter((x): x is { img: StoryImage; src: string } => x.src !== null);
  }, [images]);

  // Defensive ordinal sort (MyAudioDetail's stance — the server already
  // orders by segment_number).
  const orderedSegments = useMemo(
    () =>
      audio !== null && audio.status === 'done'
        ? [...audio.segments].sort((a, b) => a.segmentNumber - b.segmentNumber)
        : [],
    [audio],
  );

  // Degrade gracefully: all-zero windows mean the provider returned no
  // usable timing — play audio, skip highlighting (and keep the plain
  // paragraph rendering, since segment lines exist only to be highlighted).
  const hasTiming = orderedSegments.some(
    (s) => s.startMs !== 0 || s.endMs !== 0,
  );
  // `track !== null` rides along defensively: segment lines exist to follow
  // a player — a malformed done-envelope with no track must fall back to the
  // plain paragraphs rather than render highlight lines nothing can drive.
  // `ttsConfigured !== false` matches the audio-card gate below: when the
  // card (and so the player) is hidden on a dormant deploy, the body keeps
  // its plain paragraph rendering too.
  const readAlong =
    audio !== null &&
    audio.ttsConfigured !== false &&
    audio.status === 'done' &&
    audio.track !== null &&
    orderedSegments.length > 0 &&
    hasTiming;

  // Runtime playback failure (the F-160 device, via MyAudioDetail) —
  // distinct from a fetch error: the element stays mounted, an alert
  // renders alongside it. A fresh envelope gives the player a fresh chance.
  const [playbackError, setPlaybackError] = useState(false);
  const onPlaybackError = useCallback((): void => {
    setPlaybackError(true);
  }, []);

  // Read-along: highlight the segment whose [startMs, endMs) contains the
  // playhead. Listeners attach only while a timed track is rendered and are
  // removed on unmount / when the player leaves the tree (browsers don't
  // fire `timeupdate` while paused, so pause needs no extra teardown).
  // `seeked` re-syncs after a scrub; `ended` clears the highlight.
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const activeLineRef = useRef<HTMLDivElement | null>(null);
  const [activeSegmentNumber, setActiveSegmentNumber] = useState<
    number | null
  >(null);
  useEffect(() => {
    if (!readAlong) return;
    const el = audioElRef.current;
    if (el === null) return;
    const sync = (): void => {
      setActiveSegmentNumber(
        activeSegmentNumberAt(orderedSegments, el.currentTime * 1000),
      );
    };
    const clear = (): void => {
      setActiveSegmentNumber(null);
    };
    el.addEventListener('timeupdate', sync);
    el.addEventListener('seeked', sync);
    el.addEventListener('ended', clear);
    return () => {
      el.removeEventListener('timeupdate', sync);
      el.removeEventListener('seeked', sync);
      el.removeEventListener('ended', clear);
    };
  }, [readAlong, orderedSegments]);

  // Gentle auto-follow (nice-to-have): keep the active line in view while
  // actually playing — never on a paused scrub, and `nearest` so the page
  // doesn't lurch. Guarded: happy-dom/test environments may not implement
  // scrollIntoView.
  useEffect(() => {
    if (activeSegmentNumber === null) return;
    const line = activeLineRef.current;
    const player = audioElRef.current;
    if (line === null || player === null || player.paused) return;
    if (typeof line.scrollIntoView === 'function') {
      line.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [activeSegmentNumber]);

  // F-172 — "Mark story as finished" (reading_attempts, migration 060). A
  // generated story has no passage/position tracking at all (unlike a
  // chapter), so this is the ONLY completion signal for this reader —
  // storyId alone, no passageNumber. Aborted on unmount so a closed reader
  // never lands a late setState.
  const [markState, setMarkState] = useState<MarkReadState>({ phase: 'idle' });
  const markCtrlRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      markCtrlRef.current?.abort();
    },
    [],
  );
  const markStoryFinished = useCallback((): void => {
    if (story === null) return;
    markCtrlRef.current?.abort();
    const ctrl = new AbortController();
    markCtrlRef.current = ctrl;
    setMarkState({ phase: 'saving' });
    logReadingAttempt({ sourceKind: 'story', storyId: story.id }, ctrl.signal).then(
      () => {
        if (ctrl.signal.aborted) return;
        setMarkState({ phase: 'done' });
      },
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setMarkState({
          phase: 'error',
          message: errorMessageFor(err, MARK_READ_FAILED_COPY),
        });
      },
    );
  }, [story]);

  if (loading) return <SkeletonCard />;
  if (error !== null || story === null) {
    return (
      <ErrorCard
        message={error ?? 'Could not load this story.'}
        onRetry={refetch}
      />
    );
  }

  return (
    <div>
      <div className="km-reading__story-meta">
        <Eyebrow>
          <Bilingual en="AI story" kr="AI 이야기" compact />
        </Eyebrow>
        <Pill tone="gold">{story.level}</Pill>
      </div>
      <h2 className="kr kr-display" style={{ margin: '4px 0 6px' }}>
        {story.title}
      </h2>
      {story.prompt !== null ? (
        <p className="km-reading__story-topic">
          <Bilingual en="Topic" kr="주제" compact />
          {': '}
          <span className="kr">{story.prompt}</span>
        </p>
      ) : null}

      {/* F-216 — one-tap combined generation, ABOVE both asset cards: one
          POST enqueues whatever is still missing (audio and/or
          illustrations) and seeds both state machines from its response.
          Hidden while either hydrate is in flight, when both halves are
          done, and when both are dormant — the per-asset buttons below
          remain the single-asset paths either way. */}
      {showExperienceButton ? (
        <div className="km-reading__experience">
          <Button
            variant="gold"
            size="sm"
            // aria-disabled, NOT disabled: the hard attribute would drop
            // keyboard focus to <body> the instant the call starts (the
            // asset cards' exact pattern).
            aria-disabled={expRequesting || undefined}
            leadingIcon={<Icon name="spark" size={14} />}
            onClick={() => {
              if (expRequesting) return; // aria-disabled doesn't block clicks
              requestExperience();
            }}
          >
            {expRequesting ? (
              <Bilingual en="Requesting…" kr="요청 중…" compact />
            ) : (
              <Bilingual
                en="Generate full experience"
                kr="오디오·삽화 한 번에 생성"
                compact
              />
            )}
          </Button>
          {expError !== null ? (
            <div role="alert" className="km-reading__audio-error">
              {expError}
            </div>
          ) : null}
          {expAudioCapped ? (
            <p role="alert" className="km-reading__audio-error">
              {EXPERIENCE_AUDIO_CAPPED_COPY}
            </p>
          ) : null}
          {expImagesCapped ? (
            <p role="alert" className="km-reading__images-error">
              {EXPERIENCE_IMAGES_CAPPED_COPY}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* F-210 — the story-audio section, driven by the envelope status.
          Nothing renders while the mount hydrate is in flight (the story
          body never waits on the audio probe), and NOTHING renders when the
          server says it cannot synthesize (`ttsConfigured: false` — a
          dormant deploy without a TTS key): absence, not a dead affordance.
          Only an explicit `false` hides — a missing flag (older server)
          keeps the feature visible, forward-compat. Same blue-signboard
          player card as the Listen surfaces (MyAudioDetail). */}
      {audio !== null && audio.ttsConfigured !== false ? (
        <CityCard tone="blue" className="km-reading__audio">
          {audio.status === 'done' && audio.track !== null ? (
            (() => {
              // The strict allow-list resolver — the ONLY path to the
              // <audio> src. A tampered streamUrl resolves to null and the
              // player simply doesn't render (MyAudioDetail's stance).
              const audioSrc = buildAudioSrc(audio.track.streamUrl);
              return audioSrc !== null ? (
                <>
                  {/* Real streaming player (HTTP Range server-side, so
                      seeking works); the read-along transcript below is the
                      caption surface — same a11y exemption as the Listen
                      players. */}
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <audio
                    ref={audioElRef}
                    controls
                    preload="metadata"
                    src={audioSrc}
                    aria-label={`Audio for ${story.title}`}
                    onError={onPlaybackError}
                    style={{ width: '100%' }}
                  />
                  {playbackError ? (
                    <p className="km-reading__audio-error" role="alert">
                      <Bilingual
                        en="Audio couldn't load — try again later."
                        kr="오디오를 불러올 수 없어요 — 나중에 다시 시도해 주세요."
                      />
                    </p>
                  ) : null}
                </>
              ) : (
                // Defensive only: reachable solely if a tampered streamUrl
                // was rejected by the allow-list.
                <p className="km-reference__empty" role="note">
                  <Bilingual
                    en="No audio yet — check back soon."
                    kr="아직 오디오가 없어요 — 잠시 후 다시 확인해 주세요."
                  />
                </p>
              );
            })()
          ) : audio.status === 'pending' || audio.status === 'running' ? (
            // In flight — the poll above lands the settle; role=status so AT
            // hears the eventual flip via the re-render.
            <p className="km-reading__audio-busy" role="status">
              <Bilingual en="Generating audio…" kr="오디오 생성 중…" />
            </p>
          ) : (
            // 'none' | 'failed' — the request affordance.
            <>
              {audio.status === 'failed' ? (
                // Server-authored whitelisted failure copy — verbatim per
                // the F-210 contract (see services/reading.ts).
                <p className="km-reading__audio-error" role="alert">
                  {audio.error ?? AUDIO_FAILED_FALLBACK_COPY}
                </p>
              ) : null}
              <div>
                <Button
                  variant="gold"
                  size="sm"
                  // aria-disabled, NOT disabled: the hard attribute would
                  // drop keyboard focus to <body> the instant the call
                  // starts (StoryGenerator's exact pattern).
                  aria-disabled={requesting || undefined}
                  leadingIcon={<Icon name="headphones" size={14} />}
                  onClick={() => {
                    if (requesting) return; // aria-disabled doesn't block clicks
                    requestAudio();
                  }}
                >
                  {requesting ? (
                    <Bilingual en="Requesting…" kr="요청 중…" compact />
                  ) : audio.status === 'failed' ? (
                    <Bilingual en="Try again" kr="다시 시도" compact />
                  ) : (
                    <Bilingual en="Generate audio" kr="오디오 생성" compact />
                  )}
                </Button>
              </div>
              {requestError !== null ? (
                <div role="alert" className="km-reading__audio-error">
                  {requestError}
                </div>
              ) : null}
            </>
          )}
        </CityCard>
      ) : null}

      {/* F-211 — the story-illustration surface, driven by the envelope
          status. Nothing renders while the mount hydrate is in flight (the
          story body never waits on the image probe), and NOTHING renders on
          a dormant deploy (`imageGenConfigured: false` — no image key):
          absence, not a dead affordance. Only an explicit `false` hides —
          a missing flag keeps the feature visible, forward-compat (the
          F-210 audio-card gate, exactly). */}
      {images !== null && images.imageGenConfigured !== false ? (
        images.status === 'done' ? (
          displayableImages.length > 0 ? (
            // Hero-plus-grid gallery: CSS promotes the first surviving
            // figure to a full-width hero, the rest share a two-up grid.
            // Each figure owns its load-failure fallback (absence, no
            // broken-image glyph) — see StoryIllustration.
            <div
              className="km-reading__images"
              role="group"
              aria-label={`Illustrations for ${story.title}`}
            >
              {displayableImages.map(({ img, src }) => (
                <StoryIllustration
                  // storyId in the key: image numbers restart at 1 per
                  // story, and a stale `failed` flag must not survive a
                  // story switch.
                  key={`${String(storyId)}-${String(img.imageNumber)}`}
                  src={src}
                  imageNumber={img.imageNumber}
                  width={img.width}
                  height={img.height}
                />
              ))}
            </div>
          ) : // Done but nothing displayable (every blobUrl rejected by the
          // allow-list — tampered response): render nothing rather than an
          // empty frame.
          null
        ) : images.status === 'pending' || images.status === 'running' ? (
          // In flight — batch-at-create lands a fresh story here with no
          // click; the poll above fills the gallery in. role=status so AT
          // hears the eventual flip via the re-render.
          <p className="km-reading__images-busy" role="status">
            <Bilingual en="Illustrating…" kr="삽화 생성 중…" />
          </p>
        ) : (
          // 'none' | 'failed' — the request affordance (old/pre-F-211
          // stories have no batch job; this is their on-demand path).
          <div className="km-reading__images-request">
            {images.status === 'failed' ? (
              // Server-authored whitelisted failure copy — verbatim per the
              // same contract as F-210 (see services/reading.ts).
              <p className="km-reading__images-error" role="alert">
                {images.error ?? IMAGES_FAILED_FALLBACK_COPY}
              </p>
            ) : null}
            <div>
              <Button
                variant="gold"
                size="sm"
                // aria-disabled, NOT disabled: the hard attribute would
                // drop keyboard focus to <body> the instant the call
                // starts (the audio card's exact pattern).
                aria-disabled={requestingImages || undefined}
                leadingIcon={<Icon name="image" size={14} />}
                onClick={() => {
                  if (requestingImages) return; // aria-disabled doesn't block clicks
                  requestImages();
                }}
              >
                {requestingImages ? (
                  <Bilingual en="Requesting…" kr="요청 중…" compact />
                ) : images.status === 'failed' ? (
                  <Bilingual en="Try again" kr="다시 시도" compact />
                ) : (
                  <Bilingual en="Generate illustrations" kr="삽화 생성" compact />
                )}
              </Button>
            </div>
            {imagesRequestError !== null ? (
              <div role="alert" className="km-reading__images-error">
                {imagesRequestError}
              </div>
            ) : null}
          </div>
        )
      ) : null}

      {/* Same reading-surface treatment as the chapter reader's CityCard
          (device #1/#2) — one consistent "reading surface" identity across
          both the uploaded-book and AI-story readers. */}
      <CityCard
        tone="accent"
        rail
        className="km-reading__reader-card km-reading__reader-card--story"
      >
        {readAlong
          ? // F-210 read-along: the body re-renders from the ordered voiced
            // segments — one tappable line per sentence, so the highlight
            // window and the rendered line are the SAME unit (exact
            // alignment by construction) and tap-to-define + translate keep
            // working per line. Falls back to the paragraph rendering below
            // whenever there's no audio or no usable timing.
            orderedSegments.map((seg) => {
              const active = seg.segmentNumber === activeSegmentNumber;
              return (
                <div
                  key={seg.segmentNumber}
                  ref={active ? activeLineRef : null}
                  className={cn(
                    'km-reading__readalong-line',
                    active && 'km-reading__readalong-line--active',
                  )}
                  {...(active ? { 'aria-current': 'true' } : {})}
                >
                  <TranslatablePassage
                    body={seg.body}
                    ariaContext={`sentence ${String(seg.segmentNumber)}`}
                    minedIds={minedIds}
                    onTapWord={onTapWord}
                    onTranslate={setTranslateText}
                  />
                </div>
              );
            })
          : paragraphs.map((block, i) => (
              <TranslatablePassage
                // Index keys are safe here: the list is derived, static per
                // loaded story, and never reordered.
                key={i}
                body={block}
                ariaContext={`paragraph ${String(i + 1)}`}
                minedIds={minedIds}
                onTapWord={onTapWord}
                onTranslate={setTranslateText}
              />
            ))}
      </CityCard>

      <MarkCompleteButton
        state={markState}
        onMark={markStoryFinished}
        labelEn="Mark story as finished"
        labelKr="이야기 완료로 표시"
        doneLabelEn="Story finished"
        doneLabelKr="완료"
      />

      {popover}
      {translateText !== null ? (
        <TranslateSheet
          text={translateText}
          onClose={() => {
            setTranslateText(null);
          }}
        />
      ) : null}
    </div>
  );
}
