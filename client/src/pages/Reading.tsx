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
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
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
import { useToast } from '../components/useToast';
import { usePagination } from '../hooks/usePagination';
import { useTapWord } from '../hooks/useTapWord';
import {
  GLOSS_DICTIONARY_ENTRY,
  GLOSS_UNAVAILABLE,
  tokeniseKorean,
} from '../lib/tapChain';
import { errorMessageFor } from '../lib/errorCopy';
import { navItem } from '../lib/nav';
import { ApiError } from '../services/api';
import {
  GENERATED_STORY_LEVELS,
  generateStory,
  getChapter,
  getGeneratedStory,
  getReadingPosition,
  listChapters,
  listGeneratedStories,
  logReadingAttempt,
  saveReadingPosition,
  translatePassage,
} from '../services/reading';
import type {
  GeneratedStory,
  GeneratedStoryLevel,
  GeneratedStorySummary,
  ReadingPosition,
} from '../services/reading';
import { getUpload, listUploads } from '../services/uploads';
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
 * reader-first types; Documents is where the other uploaded scans
 * (vocab/grammar/both) live per F-067 — they rarely have chapters, so
 * opening one lands on the honest "no chapters yet" state with the
 * original-scan link, never a fabricated reader.
 */
const BOOK_SECTIONS: ReadonlyArray<{
  key: string;
  en: string;
  kr: string;
  types: ReadonlyArray<BookUploadType>;
}> = [
  { key: 'literature', en: 'Literature', kr: '문학', types: ['literature'] },
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
    listUploads(ctrl.signal)
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        // Only READY uploads are openable (mirrors `SourceFilterRow`'s
        // `status === 'ready'` filter); the type split happens per-section.
        setBooks(rows.filter((u) => u.status === 'ready'));
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
  if (books.length === 0) {
    return (
      // Devices #3/#6 (giwa texture + hangul watermark) on the genuine
      // empty state — matches the Progress/Uploads/Mistakes/ReviewGrammar
      // precedent (never applied to a loading/error state).
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
    <div>
      {BOOK_SECTIONS.map((section) => {
        const rows = books.filter((b) => section.types.includes(b.type));
        if (rows.length === 0) return null; // empty sections stay out of the way
        return (
          <BookSection
            key={section.key}
            en={section.en}
            kr={section.kr}
            books={rows}
            onOpenBook={onOpenBook}
          />
        );
      })}
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
  const { popData, popLoading, onTapWord, onClose } = useTapWord({
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
 *  (mirrors `GenState` above). No 'idle' phase: the sheet only mounts once a
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
      <div className="km-review__sheetBody km-reading__translate-sheet">
        <div className="km-review__sheetHead">
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
 * (not `disabled`) while saving/done, matching this file's `StoryGenerator`
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

/** Generator panel lifecycle — one state at a time, no boolean soup.
 *  No 'done' phase: a successful generation opens the new story. */
type GenState =
  | { phase: 'idle' }
  | { phase: 'busy' }
  | { phase: 'error'; message: string };

/** Fixed fallback copy for a failed generation (errorCopy contract). */
const GENERATE_FAILED_COPY = 'Could not generate a story. Try again.';

/**
 * "New story from Claude" panel — level radiogroup (roving tabindex, arrow
 * keys wrap: the WritingTopicGenerator/ModeToggle segmented pattern),
 * optional topic, and a Generate button that goes `aria-disabled` (NOT
 * `disabled` — the hard attribute would drop keyboard focus to <body>
 * mid-generation, WCAG 2.4.3) while POST /reading/generate is in flight.
 * 429 is a first-class path (expensive route): `errorMessageFor` renders
 * the structured `retryAfter` and the button stays enabled as the retry.
 */
function StoryGenerator({
  onCreated,
}: {
  onCreated: (story: GeneratedStory) => void;
}): JSX.Element {
  const [level, setLevel] = useState<GeneratedStoryLevel>('L3');
  const [topic, setTopic] = useState('');
  const [state, setState] = useState<GenState>({ phase: 'idle' });
  const levelRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const abortRef = useRef<AbortController | null>(null);
  const uid = useId();

  // Abort any in-flight generation on unmount so a late resolve can't set
  // state on a dead component (the catch below drops aborted rejections).
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const generate = async (): Promise<void> => {
    // Supersede: a regenerate while one is in flight cancels the old call —
    // exactly one outcome ever lands.
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ phase: 'busy' });
    try {
      const trimmed = topic.trim();
      const story = await generateStory(
        { level, ...(trimmed !== '' ? { topic: trimmed } : {}) },
        ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      // Open the fresh story — the parent navigates, unmounting this panel.
      onCreated(story);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setState({
        phase: 'error',
        message: errorMessageFor(err, GENERATE_FAILED_COPY),
      });
    }
  };

  // Roving-tabindex arrows on the level radios (WAI-ARIA radiogroup).
  const onLevelKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const current = GENERATED_STORY_LEVELS.indexOf(level);
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      next = (current + 1) % GENERATED_STORY_LEVELS.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      next =
        (current - 1 + GENERATED_STORY_LEVELS.length) %
        GENERATED_STORY_LEVELS.length;
    }
    if (next === null) return;
    e.preventDefault();
    const target = GENERATED_STORY_LEVELS[next];
    if (target === undefined) return;
    setLevel(target);
    levelRefs.current[next]?.focus();
  };

  const busy = state.phase === 'busy';

  return (
    // The page's one hero CTA (F-068 Claude generation) — a `mint`-tone,
    // `feat` CityCard signboard/hanji-paper card (devices #1/#2), mirroring
    // the design mock's dedicated "Generate a short story" sign.
    <CityCard
      tone="mint"
      rail
      feat
      className="km-reading__gen"
      aria-busy={busy || undefined}
    >
      <div className="km-reading__gen-head" id={`${uid}-label`}>
        {/* Device #9 — mother-of-pearl shimmer on the hero CTA's spark
            glyph. Sparing by design: this is the page's ONLY najeon use. */}
        <span className="km-reading__gen-spark km-najeon km-najeon--shimmer">
          <Icon name="spark" size={14} />
        </span>
        <Bilingual en="New story from Claude" kr="새 이야기 만들기" />
      </div>

      <div
        className="km-reading__gen-levels"
        role="radiogroup"
        aria-labelledby={`${uid}-label`}
      >
        {GENERATED_STORY_LEVELS.map((l, i) => {
          const selected = l === level;
          return (
            <button
              key={l}
              ref={(el) => {
                levelRefs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              className={
                selected
                  ? 'km-reading__gen-level km-reading__gen-level--active focusring'
                  : 'km-reading__gen-level focusring'
              }
              onClick={() => {
                setLevel(l);
              }}
              onKeyDown={onLevelKeyDown}
            >
              {l}
            </button>
          );
        })}
      </div>

      <div className="km-reading__gen-topic">
        <label htmlFor={`${uid}-topic`}>
          <Bilingual en="Topic (optional)" kr="주제 (선택)" compact />
        </label>
        <input
          id={`${uid}-topic`}
          type="text"
          value={topic}
          maxLength={500}
          placeholder="e.g. 바닷가 마을"
          onChange={(e) => {
            setTopic(e.target.value);
          }}
        />
      </div>

      <div>
        <Button
          variant="gold"
          size="sm"
          // aria-disabled, NOT disabled: the hard attribute would move
          // keyboard focus to <body> the instant the call starts. The busy
          // guard below is the real re-entry gate.
          aria-disabled={busy || undefined}
          leadingIcon={<Icon name="spark" size={14} />}
          onClick={() => {
            if (busy) return; // aria-disabled doesn't block clicks — we do.
            void generate();
          }}
        >
          {busy ? (
            <Bilingual en="Generating…" kr="생성 중…" compact />
          ) : (
            <Bilingual en="Generate story" kr="이야기 생성" compact />
          )}
        </Button>
      </div>

      {state.phase === 'error' ? (
        <div role="alert" className="km-reading__gen-error">
          {state.message}
        </div>
      ) : null}
    </CityCard>
  );
}

/** Library date — short, locale-fixed (the app's copy is en-first), and
 *  silent on an unparseable server timestamp rather than "Invalid Date". */
function formatStoryDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function StoriesSection({
  onOpenStory,
}: {
  onOpenStory: (id: number) => void;
}): JSX.Element {
  const [stories, setStories] = useState<GeneratedStorySummary[]>([]);
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
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        setStories(rows);
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
                    <Pill tone="gold">{story.level}</Pill>
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

      {/* Same reading-surface treatment as the chapter reader's CityCard
          (device #1/#2) — one consistent "reading surface" identity across
          both the uploaded-book and AI-story readers. */}
      <CityCard
        tone="accent"
        rail
        className="km-reading__reader-card km-reading__reader-card--story"
      >
        {paragraphs.map((block, i) => (
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
