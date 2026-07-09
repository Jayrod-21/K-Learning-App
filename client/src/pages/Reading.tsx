/**
 * Reading — `/learn/reading`, the U3b digitized chapter reader
 * (`db/docs/U3_READER_DESIGN.md` §U3b). Replaces the P1.1 placeholder now
 * that literature books have a real content store (`reading_chapters` /
 * `reading_passages`, migration 044) and a real server surface
 * (`routes/reading.ts`).
 *
 * Three-level drill-down, all client-side state (no URL params — mirrors
 * `Ttmik.tsx`'s browse→detail `Selection` state, not React Router):
 *   1. Book picker — the user's READY `literature`-typed uploads
 *      (`listUploads` filtered client-side, same filter
 *      `SourceFilterRow` applies: `status === 'ready'`; only literature
 *      uploads populate chapters, so `type === 'literature'` narrows
 *      further).
 *   2. Chapter picker — `GET /reading/chapters?source_upload_id=` for the
 *      chosen book.
 *   3. Chapter reader — `GET /reading/chapters/:id`'s ordered passages,
 *      rendered as tappable Korean text (`tokeniseKorean` → `Tapword`,
 *      the `TapKorean` pattern shared with `Ttmik.tsx`) wired to
 *      `useTapWord` → `WordPopover`. "View original scan" deep-links to
 *      the page-image viewer at the chapter's own scan page
 *      (`/uploads/:sourceUploadId?page={startPage}` — U3c; `startPage` IS
 *      `book_pages.page_number`, the loader wrote it as such, so no offset
 *      correction applies). A null `startPage` (chapter not yet linked to
 *      its scan pages) falls back to the bare route → page 1.
 *
 * Read-only consumption: no editing surface here. Tap-to-define reuses the
 * shared stack as-is (`lib/tapChain`, `components/Tapword`,
 * `components/WordPopover`) — no new lookup logic. "Add to bank" reuses
 * `services/vocab.mineWord` with the same optimistic-flip + rollback +
 * fixed-copy-toast contract `Ttmik.tsx`'s `DetailView` uses (kept
 * page-local rather than folded into `useTapWord` — see that hook's header
 * for why), INCLUDING the abort contract: `ChapterReader` keeps its own
 * `addCtrlRef` (the same page-local controller `Ttmik.tsx`'s `DetailView`
 * keeps post-U3c, since `useTapWord` deliberately doesn't expose its
 * internal controller) so closing the popover — or unmounting mid-request —
 * aborts an in-flight "Add to bank" POST too, not just the
 * lemmatize→define→enrich chain.
 *
 * Threat model:
 *   - All data (book titles, chapter titles, passage bodies) is server
 *     corpus/OCR text rendered through React text children — escaped, no
 *     `dangerouslySetInnerHTML` anywhere on this screen. The tap chain's
 *     popover fields go through the same contract (see `lib/tapChain`).
 *   - IDOR: every read (`listUploads`, `listChapters`, `getChapter`) is
 *     scoped server-side to the session `user_id`; a foreign/missing id
 *     just 404s as an `ApiError`, surfaced through `errorMessageFor`'s
 *     fixed-copy lookup — server prose is never echoed.
 *   - Every fetch threads its own `AbortController`, checked before every
 *     post-await state write, and is aborted on unmount / on re-fetch /
 *     on drilling into a different book or chapter — mirrors every other
 *     list+detail screen in the app (`Ttmik.tsx`, `UploadViewer.tsx`).
 *   - GET-only data surface plus `POST /vocab/mine` on Add — that POST
 *     rides the `SameSite=Strict` cookie posture owned by
 *     `services/api.ts` (ADR-002), and is itself abortable (see the
 *     `addCtrlRef` note above) so a closed popover can't leak a late
 *     resolve into an unmounted `WordPopover`.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { Bilingual } from '../components/Bilingual';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ErrorCard } from '../components/ErrorCard';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { Tapword } from '../components/Tapword';
import { Topbar } from '../components/Topbar';
import { WordPopover } from '../components/WordPopover';
import type { WordPopoverData } from '../components/WordPopover';
import { useToast } from '../components/useToast';
import { useTapWord } from '../hooks/useTapWord';
import {
  GLOSS_DICTIONARY_ENTRY,
  GLOSS_UNAVAILABLE,
  tokeniseKorean,
} from '../lib/tapChain';
import { errorMessageFor } from '../lib/errorCopy';
import { navItem } from '../lib/nav';
import { ApiError } from '../services/api';
import { getChapter, listChapters } from '../services/reading';
import { listUploads } from '../services/uploads';
import { mineWord } from '../services/vocab';
import type {
  BookUpload,
  ReadingChapter,
  ReadingChapterSummary,
  ReadingPassage,
} from '../types/domain';

/** Page eyebrow source — nav.ts owns the en/kr pair (P3b Batch A). */
const READING_NAV = navItem('reading');

/** Signature every tap surface funnels into: raw word + its source line. */
type TapWordHandler = (raw: string, sentenceText: string) => void;

export default function Reading(): JSX.Element {
  const [selectedBook, setSelectedBook] = useState<BookUpload | null>(null);
  const [selectedChapterId, setSelectedChapterId] = useState<number | null>(
    null,
  );

  const backToBooks = useCallback((): void => {
    setSelectedBook(null);
    setSelectedChapterId(null);
  }, []);
  const backToChapters = useCallback((): void => {
    setSelectedChapterId(null);
  }, []);

  const right =
    selectedChapterId !== null ? (
      <Button
        variant="ghost"
        size="sm"
        leadingIcon={<Icon name="list" size={14} />}
        onClick={backToChapters}
        aria-label="Back to the chapter list"
      >
        <Bilingual en="Chapters" kr="목차" compact />
      </Button>
    ) : selectedBook !== null ? (
      <Button
        variant="ghost"
        size="sm"
        leadingIcon={<Icon name="list" size={14} />}
        onClick={backToBooks}
        aria-label="Back to all books"
      >
        <Bilingual en="All books" kr="모든 책" compact />
      </Button>
    ) : undefined;

  return (
    <section
      className="screen km-reading"
      aria-labelledby="reading-title"
      style={{ padding: '0 18px 32px' }}
    >
      <Topbar
        krTitle="읽기"
        title="Reading"
        titleId="reading-title"
        eyebrow={
          <Bilingual en={READING_NAV.eyebrow} kr={READING_NAV.krEyebrow} />
        }
        right={right}
      />
      {selectedChapterId !== null ? (
        <ChapterReader
          key={selectedChapterId}
          chapterId={selectedChapterId}
        />
      ) : selectedBook !== null ? (
        <ChapterPicker
          key={selectedBook.id}
          book={selectedBook}
          onOpenChapter={setSelectedChapterId}
        />
      ) : (
        <BookPicker onOpenBook={setSelectedBook} />
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Level 1 — book picker
// ─────────────────────────────────────────────────────────────

function BookPicker({
  onOpenBook,
}: {
  onOpenBook: (book: BookUpload) => void;
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
        // Only `literature`-typed, `ready` uploads have (or ever will have)
        // chapters — mirrors `SourceFilterRow`'s own `status === 'ready'`
        // filter, narrowed further to the type this reader actually serves.
        setBooks(
          rows.filter((u) => u.type === 'literature' && u.status === 'ready'),
        );
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
      <Card variant="flat" style={{ padding: '20px 22px' }}>
        <p
          style={{
            margin: '0 0 14px',
            fontSize: 14,
            lineHeight: 1.6,
            color: 'var(--paper-dim)',
          }}
        >
          <Bilingual
            en="Upload a literature book to start reading."
            kr="읽기를 시작하려면 문학 도서를 업로드하세요."
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
    <Card className="km-reference__list" variant="flat">
      <ul>
        {books.map((book) => (
          <li key={book.id} className="km-reference__row">
            <button
              type="button"
              className="km-resources__list-open focusring"
              onClick={() => {
                onOpenBook(book);
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
  );
}

// ─────────────────────────────────────────────────────────────
// Level 2 — chapter picker
// ─────────────────────────────────────────────────────────────

function ChapterPicker({
  book,
  onOpenChapter,
}: {
  book: BookUpload;
  onOpenChapter: (chapterId: number) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const [chapters, setChapters] = useState<ReadingChapterSummary[]>([]);
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
    listChapters(book.id, ctrl.signal)
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        setChapters(rows);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(errorMessageFor(err, 'Could not load the chapters.'));
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [book.id, reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  // Defensive order — the server already orders by chapter_number.
  const ordered = useMemo(
    () => [...chapters].sort((a, b) => a.chapterNumber - b.chapterNumber),
    [chapters],
  );

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

      {loading ? (
        <div className="km-grammar__state" role="status">
          <Bilingual en="Loading chapters…" kr="목차를 불러오는 중…" />
        </div>
      ) : error !== null ? (
        <ErrorCard message={error} onRetry={refetch} />
      ) : ordered.length === 0 ? (
        <p className="km-reference__empty">
          <Bilingual
            en="No chapters yet for this book."
            kr="아직 이 책의 목차가 없어요."
          />
        </p>
      ) : (
        <Card className="km-reference__list" variant="flat">
          <ul>
            {ordered.map((chapter) => {
              const label = chapter.title ?? `Chapter ${String(chapter.chapterNumber)}`;
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
// Level 3 — chapter reader (tap-to-define passages)
// ─────────────────────────────────────────────────────────────

/** Skeleton placeholder while a chapter loads (mirrors Ttmik's). */
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
    <p
      className="kr km-reference__row-kr"
      style={{ margin: '0 0 16px', lineHeight: 1.9 }}
    >
      {lines.map((line, i) => (
        <span key={i}>
          {i > 0 ? <br /> : null}
          <TapKorean text={line} minedIds={minedIds} onTapWord={onTapWord} />
        </span>
      ))}
    </p>
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
  const ctrlRef = useRef<AbortController | null>(null);

  // Add-to-bank state — page-local (see module header + useTapWord's own
  // header for why this isn't folded into the hook).
  const [minedIds, setMinedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  // Add-to-bank request controller. `useTapWord` deliberately doesn't expose
  // its internal controller (see the hook's header), so this page keeps its
  // own — aborted on popover close (via `handleClose` below) and on
  // unmount, mirroring `Ttmik.tsx`'s `DetailView.addCtrlRef` so closing the
  // popover cancels an in-flight "Add to bank" POST too, not just the
  // lemmatize→define→enrich chain `useTapWord` already aborts.
  const addCtrlRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      addCtrlRef.current?.abort();
    },
    [],
  );

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

  const refetch = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

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
   * Add-to-bank — same optimistic-flip + rollback + fixed-copy toast
   * contract as `Ttmik.tsx`'s `DetailView.handleAdd`, including the abort
   * wiring: a fresh `AbortController` per add, aborted by `handleClose`
   * (popover close) or the unmount effect above, so a closed/unmounted
   * popover can never land a late `setMinedIds`/`toast` or re-throw into
   * `WordPopover`'s already-unmounted rollback handler.
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

  // Defensive order — the server already orders by passage_number.
  const orderedPassages = useMemo(
    () => [...passages].sort((a, b) => a.passageNumber - b.passageNumber),
    [passages],
  );

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
        <p className="km-reference__empty">
          <Bilingual
            en="No passages yet for this chapter."
            kr="아직 이 장의 본문이 없어요."
          />
        </p>
      ) : (
        <Card variant="default" style={{ padding: '20px 22px' }}>
          {orderedPassages.map((passage) => (
            <PassageBody
              key={passage.id}
              body={passage.body}
              minedIds={minedIds}
              onTapWord={onTapWord}
            />
          ))}
        </Card>
      )}

      {popData ? (
        <WordPopover
          data={popData}
          onClose={handleClose}
          onAdd={handleAdd}
          isLoading={popLoading}
        />
      ) : null}
    </div>
  );
}
