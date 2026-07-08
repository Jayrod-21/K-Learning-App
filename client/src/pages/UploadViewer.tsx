/**
 * UploadViewer — `/uploads/:id`, the U1b VIEW-ONLY PAGE-IMAGE viewer
 * (`db/docs/PDF_UPLOAD_DESIGN.md` §"REVISION" — authoritative). Renders the
 * uploaded book page-by-page as plain `<img>` bitmaps fetched from
 * `GET /uploads/:id/page/:n`; NO pdf.js, NO canvas rasterization — the
 * server already normalized the zip/PDF into ordered page images at upload
 * time, so the viewer's only job is "show page N of M, lazily."
 *
 * Why an `<img>`, not pdf.js (the model this replaces): pdf.js needed a
 * bundled worker + `withCredentials` fetch + its own render-cancellation
 * discipline because it was rasterizing PDF bytes client-side. A page image
 * is already a JPEG — the browser's native image loader does all of that for
 * free. A same-origin `<img src>` sends the session cookie automatically (no
 * `withCredentials` equivalent needed — that flag only matters for
 * fetch/XHR), and there is nothing to cancel: reassigning/removing an `<img>`
 * lets the browser abandon the in-flight request on its own.
 *
 * Lazy by construction: only the CURRENT page's `<img>` is ever mounted (plus
 * a fire-and-forget prefetch of the next page, matching Jared's "500-page
 * book" sample) — a 500-page book therefore costs ~1-2 image fetches per nav
 * tap, never all 500 at once. Per-page load/error state is owned by
 * `PageImage` below and keyed by `${pageNum}-${retryToken}`, so a page
 * navigation OR a retry both cleanly remount a fresh `<img>` (fresh
 * `loading` state, fresh network request) rather than needing an effect to
 * reset anything. A retry ALSO threads `retryToken` into `pageUrl`'s
 * `cacheBust` param (never on plain navigation), so a retry forces a fresh
 * network fetch instead of remounting onto the byte-identical URL — the page
 * route is deliberately cache-friendly, so a same-URL retry could otherwise
 * just replay a cached bad response forever.
 *
 * Reorder tool (Jared: vFlat retakes can land out of order — design doc
 * REVISION): a "Reorder pages" mode with a numeric "move page N to position"
 * control (keyboard-operable by construction — a plain labelled
 * `<input type="number">` + button, no pointer-only drag required to operate
 * it). Optimistic: the local page order updates immediately (so the viewer
 * reflects the move without waiting on the network), then
 * `PATCH /uploads/:id/pages/order` confirms it; a failure rolls the local
 * order back and toasts fixed copy (never echoed server prose).
 *
 * Reorder tool dependency: the panel's initial "load current order" step
 * calls `listPages` (`GET /uploads/:id/pages`), which needs each page's
 * stable DB id (not just its display number) to submit a valid full-order
 * PATCH. That route is implemented server-side (see `services/uploads.ts`'s
 * header) — the reorder UI below is live, not blocked on a pending contract.
 *
 * Abort discipline: `getUpload` (meta), `listPages` (reorder's page-id list),
 * and `reorderPages` (the PATCH) are the only network calls this component
 * makes directly, and each threads its own `AbortController` + checks
 * `signal.aborted` before every state write after an `await`/`.then` —
 * mirrors `pages/Uploads.tsx`'s pattern. The per-page `<img>` itself needs no
 * such guard (see above — nothing to leak once the DOM node is gone).
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type JSX,
} from 'react';
import { useParams } from 'react-router-dom';
import { Bilingual } from '../components/Bilingual';
import { Button } from '../components/Button';
import { ErrorCard } from '../components/ErrorCard';
import { Icon } from '../components/Icon';
import { Topbar } from '../components/Topbar';
import { useToast } from '../components/useToast';
import { errorMessageFor } from '../lib/errorCopy';
import { ApiError } from '../services/api';
import { getUpload, listPages, pageUrl, reorderPages } from '../services/uploads';
import type { BookUpload, Page } from '../types/domain';

const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;
const SCALE_STEP = 0.25;
const DEFAULT_SCALE = 1;

type MetaState = 'loading' | 'ready' | 'error';
type PagesState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * One page's `<img>`, own load/error/retry state. Keyed by the parent on
 * `${pageNumber}-${retryToken}` — a page nav OR a retry both remount this
 * component fresh, so `status` always starts at `'loading'` for whatever is
 * currently being requested; no effect needed to "reset" anything.
 */
function PageImage({
  src,
  alt,
  style,
  onRetry,
}: {
  src: string;
  alt: string;
  style: CSSProperties;
  onRetry: () => void;
}): JSX.Element {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');

  if (status === 'error') {
    return (
      <ErrorCard
        message="Couldn’t load this page. Try again."
        onRetry={onRetry}
      />
    );
  }

  return (
    <>
      {status === 'loading' ? (
        <div className="km-grammar__state" role="status">
          <Bilingual en="Loading this page…" kr="이 페이지를 불러오는 중…" />
        </div>
      ) : null}
      <img
        src={src}
        alt={alt}
        style={{ ...style, display: status === 'loaded' ? style.display ?? 'block' : 'none' }}
        onLoad={() => {
          setStatus('loaded');
        }}
        onError={() => {
          setStatus('error');
        }}
      />
    </>
  );
}

export default function UploadViewer(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();

  const [meta, setMeta] = useState<BookUpload | null>(null);
  const [metaState, setMetaState] = useState<MetaState>('loading');
  const [pageNum, setPageNum] = useState(1);
  const [jumpValue, setJumpValue] = useState('');
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [fit, setFit] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  const [reorderOpen, setReorderOpen] = useState(false);
  const [pages, setPages] = useState<Page[] | null>(null);
  const [pagesState, setPagesState] = useState<PagesState>('idle');
  const [moveTarget, setMoveTarget] = useState('');
  const [moveError, setMoveError] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);

  const metaCtrlRef = useRef<AbortController | null>(null);
  const pagesCtrlRef = useRef<AbortController | null>(null);
  const reorderCtrlRef = useRef<AbortController | null>(null);

  const pageCount = meta?.pageCount;

  const loadMeta = useCallback((): void => {
    if (!id) {
      setMetaState('error');
      return;
    }
    const ctrl = new AbortController();
    metaCtrlRef.current?.abort();
    metaCtrlRef.current = ctrl;
    setMetaState('loading');
    setPageNum(1);
    getUpload(id, ctrl.signal)
      .then((upload) => {
        if (ctrl.signal.aborted) return;
        setMeta(upload);
        setMetaState('ready');
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setMetaState('error');
      });
  }, [id]);

  useEffect(() => {
    // Sync-to-external-system case (mirrors the old pdf.js viewer's mount
    // effect, and Uploads.tsx's own `load` effect): there's no way to know
    // this upload's metadata without asking the server, so kicking off the
    // fetch from an effect keyed on `id` is the correct place, not something
    // to hoist out of an effect.
    //
    // `eslint-plugin-react-hooks`'s `set-state-in-effect` rule fires here
    // (confirmed real, not stale, via `--report-unused-disable-directives`)
    // on the SYNCHRONOUS `setMetaState('loading')` + `setPageNum(1)` that
    // `loadMeta` runs BEFORE its `await` (plus the no-`id` early
    // `setMetaState('error')` branch) — NOT on anything after the await,
    // which is a separate concern already covered by the `ctrl.signal.
    // aborted` guards below. Those synchronous writes are safe: on first
    // mount they're redundant no-ops (state is already at those initial
    // values, so React bails without a re-render); on an `id` change
    // without unmount (navigating from one book straight to another via the
    // same route) they're an intentional, correct "reset prop-derived state
    // when the identity prop changes," and nothing downstream can race
    // because `loadMeta`'s only dep is `id` and every write after its await
    // is itself guarded. The rule does not trip on the
    // structurally-identical `load()` effect in Uploads.tsx — a same-file
    // quirk of the rule's heuristic (confirmed by lint), not evidence the
    // hazard differs there.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadMeta();
    return () => {
      metaCtrlRef.current?.abort();
    };
  }, [loadMeta]);

  // Abort any still-pending reorder-related requests on unmount.
  useEffect(() => {
    return () => {
      pagesCtrlRef.current?.abort();
      reorderCtrlRef.current?.abort();
    };
  }, []);

  // Fire-and-forget prefetch of the NEXT page image only — never the whole
  // book. No state is written here, so there is nothing to guard against a
  // stale settle; the browser simply warms its own cache (or doesn't, if the
  // component unmounts first — harmless either way).
  useEffect(() => {
    if (!id || !pageCount || pageNum >= pageCount) return;
    const img = new Image();
    img.src = pageUrl(id, pageNum + 1);
  }, [id, pageNum, pageCount]);

  const goToPage = (n: number): void => {
    if (!pageCount) return;
    const clamped = Math.max(1, Math.min(pageCount, n));
    setPageNum(clamped);
    setRetryToken(0);
  };

  const goPrev = (): void => goToPage(pageNum - 1);
  const goNext = (): void => goToPage(pageNum + 1);

  const submitJump = (): void => {
    const n = Number(jumpValue);
    if (!Number.isInteger(n)) return;
    goToPage(n);
    setJumpValue('');
  };

  const zoomIn = (): void => {
    setFit(false);
    setScale((s) => Math.min(MAX_SCALE, Number((s + SCALE_STEP).toFixed(2))));
  };
  const zoomOut = (): void => {
    setFit(false);
    setScale((s) => Math.max(MIN_SCALE, Number((s - SCALE_STEP).toFixed(2))));
  };
  const fitWidth = (): void => {
    setFit(true);
  };

  const loadPages = useCallback((): void => {
    if (!id) return;
    const ctrl = new AbortController();
    pagesCtrlRef.current?.abort();
    pagesCtrlRef.current = ctrl;
    setPagesState('loading');
    listPages(id, ctrl.signal)
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        setPages(rows);
        setPagesState('ready');
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setPagesState('error');
      });
  }, [id]);

  const openReorder = (): void => {
    setReorderOpen(true);
    setMoveError(null);
    if (pagesState === 'idle' || pagesState === 'error') {
      loadPages();
    }
  };
  const closeReorder = (): void => {
    setReorderOpen(false);
    setMoveTarget('');
    setMoveError(null);
  };

  const submitMove = (): void => {
    // Explicit in-flight guard — the Move BUTTON is disabled while
    // `reordering` (`disabled={reordering || ...}` below), but the
    // move-target input's Enter-key handler calls submitMove() directly and
    // does not consult that disabled state, so without this guard two Enter
    // presses dispatched before React commits the post-move re-render could
    // both read a still-valid `moveTarget` from the same render and both
    // proceed — a second in-flight PATCH racing the first, with its
    // `previousPages` rollback snapshot capturing the FIRST move's
    // unconfirmed optimistic order instead of the true last-known-good one.
    // One guard at the top covers both the button and the Enter path.
    if (reordering) return;
    if (!id || !pages) return;
    const total = pages.length;
    const target = Number(moveTarget);
    if (!Number.isInteger(target) || target < 1 || target > total) {
      setMoveError(`Enter a page number between 1 and ${String(total)}.`);
      return;
    }
    const currentIndex = pageNum - 1;
    const targetIndex = target - 1;
    if (currentIndex < 0 || currentIndex >= total) return;
    if (targetIndex === currentIndex) {
      setMoveError(null);
      setMoveTarget('');
      return;
    }

    const previousPages = pages;
    const previousPageNum = pageNum;

    const reordered = [...pages];
    const [moved] = reordered.splice(currentIndex, 1);
    if (!moved) return;
    reordered.splice(targetIndex, 0, moved);
    const optimistic = reordered.map((p, i) => ({ id: p.id, pageNumber: i + 1 }));

    // Optimistic: reflect the new order + jump to the moved page's new
    // position immediately, before the server confirms.
    setPages(optimistic);
    setPageNum(targetIndex + 1);
    setRetryToken(0);
    setMoveTarget('');
    setMoveError(null);
    setReordering(true);

    const ctrl = new AbortController();
    reorderCtrlRef.current?.abort();
    reorderCtrlRef.current = ctrl;

    reorderPages(
      id,
      optimistic.map((p) => p.id),
      ctrl.signal,
    )
      .then((serverPages) => {
        if (ctrl.signal.aborted) return;
        setPages(serverPages);
        setReordering(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        // Rollback — the optimistic move didn't stick server-side.
        setPages(previousPages);
        setPageNum(previousPageNum);
        setReordering(false);
        toast({
          message: errorMessageFor(err, 'Could not move that page. Try again.'),
          tone: 'error',
        });
      });
  };

  const title = meta?.title ?? 'Book';
  const canView = metaState === 'ready' && meta?.status === 'ready' && !!pageCount && pageCount > 0;

  const imgStyle: CSSProperties = fit
    ? { width: '100%', height: 'auto', maxWidth: '100%' }
    : { width: 'auto', height: 'auto', maxWidth: 'none', transform: `scale(${String(scale)})`, transformOrigin: 'top left' };

  return (
    <section
      className="screen km-upload-viewer"
      aria-labelledby="km-upload-viewer-title"
    >
      <Topbar
        krTitle={title}
        title={title}
        titleId="km-upload-viewer-title"
        eyebrow={<Bilingual en="View-only" kr="보기 전용" />}
      />

      {metaState === 'loading' ? (
        <div className="km-grammar__state" role="status">
          <Bilingual en="Loading this book…" kr="책 정보를 불러오는 중…" />
        </div>
      ) : metaState === 'error' ? (
        <ErrorCard message="Couldn’t load this book. Try again." onRetry={loadMeta} />
      ) : !canView ? (
        <ErrorCard
          message={
            meta?.status === 'failed'
              ? 'This upload failed to process and has no viewable pages.'
              : 'This upload is still processing — check back shortly.'
          }
          onRetry={loadMeta}
        />
      ) : (
        <>
          <div
            className="km-upload-viewer__toolbar"
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 8,
              padding: '8px 0',
            }}
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={goPrev}
              disabled={pageNum <= 1}
              aria-label="Previous page"
            >
              <Icon name="chevron-left" size={14} />
            </Button>
            <span className="km-resources__pager-count" aria-live="polite">
              {pageNum} / {pageCount}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={goNext}
              disabled={!pageCount || pageNum >= pageCount}
              aria-label="Next page"
            >
              <Icon name="chevron-right" size={14} />
            </Button>

            <input
              id="km-upload-jump"
              type="number"
              min={1}
              max={pageCount}
              value={jumpValue}
              placeholder="Page #"
              className="km-field__input"
              style={{ width: 84 }}
              aria-label="Jump to page"
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setJumpValue(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitJump();
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={submitJump}
              disabled={jumpValue.trim() === ''}
              aria-label="Go"
            >
              <Bilingual en="Go" kr="이동" compact />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={zoomOut}
              disabled={fit || scale <= MIN_SCALE}
              aria-label="Zoom out"
            >
              −
            </Button>
            <span className="km-resources__pager-count">
              {fit ? 'Fit' : `${String(Math.round(scale * 100))}%`}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={zoomIn}
              disabled={fit || scale >= MAX_SCALE}
              aria-label="Zoom in"
            >
              +
            </Button>
            <Button variant="ghost" size="sm" onClick={fitWidth}>
              <Bilingual en="Fit width" kr="너비 맞춤" compact />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={reorderOpen ? closeReorder : openReorder}
              aria-pressed={reorderOpen}
              aria-label={reorderOpen ? 'Done reordering' : 'Reorder pages'}
            >
              <Bilingual
                en={reorderOpen ? 'Done reordering' : 'Reorder pages'}
                kr={reorderOpen ? '순서 편집 완료' : '페이지 순서 편집'}
                compact
              />
            </Button>
          </div>

          {reorderOpen ? (
            <div
              className="km-upload-viewer__reorder"
              role="group"
              aria-label="Reorder pages controls"
              style={{ padding: '8px 0' }}
            >
              {pagesState === 'loading' ? (
                <div role="status">
                  <Bilingual en="Loading page order…" kr="페이지 순서를 불러오는 중…" />
                </div>
              ) : pagesState === 'error' ? (
                <ErrorCard message="Could not load page order. Try again." onRetry={loadPages} />
              ) : pages ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <label htmlFor="km-move-to-page">
                    <Bilingual
                      en={`Move page ${String(pageNum)} to position`}
                      kr={`${String(pageNum)}페이지를 다음 위치로 이동`}
                      compact
                    />
                  </label>
                  <input
                    id="km-move-to-page"
                    type="number"
                    min={1}
                    max={pages.length}
                    value={moveTarget}
                    className="km-field__input"
                    style={{ width: 84 }}
                    aria-label={`Move page ${String(pageNum)} to position`}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      setMoveTarget(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitMove();
                    }}
                  />
                  <Button
                    variant="gold"
                    size="sm"
                    onClick={submitMove}
                    disabled={reordering || moveTarget.trim() === ''}
                    aria-busy={reordering}
                    aria-label="Move"
                  >
                    <Bilingual en="Move" kr="이동" compact />
                  </Button>
                  {moveError ? <ErrorCard message={moveError} /> : null}
                </div>
              ) : null}
            </div>
          ) : null}

          <div
            className="km-upload-viewer__page"
            style={{ overflow: 'auto', width: '100%' }}
          >
            <PageImage
              key={`${String(pageNum)}-${String(retryToken)}`}
              src={id ? pageUrl(id, pageNum, undefined, retryToken) : ''}
              alt={`Page ${String(pageNum)} of ${title}`}
              style={imgStyle}
              onRetry={() => {
                setRetryToken((t) => t + 1);
              }}
            />
          </div>
        </>
      )}
    </section>
  );
}
