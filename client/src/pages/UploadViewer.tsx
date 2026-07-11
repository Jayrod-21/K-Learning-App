/**
 * UploadViewer — `/uploads/:id`, the U1b VIEW-ONLY PAGE-IMAGE viewer
 * (`db/docs/PDF_UPLOAD_DESIGN.md` §"REVISION" — authoritative). Renders the
 * uploaded book page-by-page as plain `<img>` bitmaps fetched from
 * `GET /uploads/:id/page/:n`; NO pdf.js, NO canvas rasterization — the
 * server already normalized the zip/PDF into ordered page images at upload
 * time, so the viewer's only job is "show page N of M, lazily."
 *
 * Initial-page deep-link (U3c): an optional `?page=N` query seeds the
 * page the viewer opens at — the reader's "view original scan" link
 * (`pages/Reading.tsx`) threads the chapter's `start_page` through it, so
 * a chapter opens at its own scan page instead of page 1. The param is
 * strictly validated (`parseInitialPage`): absent / non-integer / < 1 →
 * page 1; an overshoot is clamped to `page_count` once meta arrives (no
 * page `<img>` mounts before then, so an out-of-range seed never requests
 * a nonexistent page). Plain `/uploads/:id` callers (the Uploads list) are
 * untouched — no param, page 1, exactly as before.
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
 * Zoom + fit model (F-057): the viewer opens AUTO FIT-WIDTH — `zoom` is a
 * multiplier of the CONTAINER width (1 = the page exactly fills the scroll
 * box; the old model's 1 = "natural pixel size" is gone, since a 2271-px-wide
 * vFlat scan at natural size was unusable on any phone). Zoom is implemented
 * as a real CSS `width`, NOT `transform: scale()` — a transform never grows
 * the element's layout box, so the old transform-based zoom could paint
 * pixels the `overflow: auto` container refused to scroll to. A width-based
 * zoom keeps layout geometry and scroll extent honest at every level.
 *
 * Rotation (F-057): a single "Rotate" control cycles 0° → 90° → 180° → 270°
 * clockwise and persists across page navigation (a book scanned sideways is
 * sideways on every page — per-page rotation would mean 500 taps). 180° keeps
 * the element's box (a center rotation is box-preserving) so it's a bare
 * `transform`. 90°/270° swap the visual axes, and a bare transform would
 * leave a portrait-sized layout box behind a landscape-looking page — so the
 * sideways branch in `PageImage` sizes an explicit wrapper box to the
 * ROTATED dimensions (from the image's `naturalWidth/Height` + the measured
 * container width) and centers the rotated `<img>` inside it; layout,
 * scrolling, and fit-width all stay correct. Before the natural dimensions
 * are known (image still loading) a plain in-place rotation renders as a
 * best-effort fallback and self-corrects on `load`.
 *
 * OCR / "Extract text" (F-059): the control is rendered DISABLED with
 * explicit "coming soon" copy — no OCR backend exists yet (U2 is a later,
 * separate phase; `server/src/routes/uploads.ts` header is authoritative:
 * "NO extraction/OCR happens here"). Deliberately honest: a live-looking
 * button POSTing to a nonexistent endpoint would be a fabricated feature.
 * When U2 lands, wire this button to its trigger route and drop `disabled`.
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
 * Back control (F-024): the viewer is reached from BOTH the Uploads list and
 * the reader's "view original scan" deep-link, so there is no single
 * canonical parent — `BackButton` runs in history-back mode (`to` omitted)
 * with `/uploads` as the guarded deep-link fallback.
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
  type SyntheticEvent,
} from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { BackButton } from '../components/BackButton';
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
import './UploadViewer.css';

/** Zoom is a multiplier of the container width — 1 = exact fit-width. */
const FIT_ZOOM = 1;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.25;

/** Clockwise page rotation, degrees. Only quarter turns make sense for scans. */
type Rotation = 0 | 90 | 180 | 270;

type MetaState = 'loading' | 'ready' | 'error';
type PagesState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Parse the optional `?page=N` deep-link (see module header). Returns a
 * positive integer, or null for absent/invalid input (non-numeric,
 * fractional, zero, negative) — null means "no seed, open at page 1".
 * Upper-bound clamping happens in `loadMeta`, where `page_count` is known.
 */
function parseInitialPage(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** The image's intrinsic bitmap dimensions, captured on `load`. */
interface NaturalSize {
  w: number;
  h: number;
}

interface PageLayout {
  /** Explicit rotated-box wrapper — only for 90°/270° with known geometry. */
  wrapperStyle: CSSProperties | null;
  imgStyle: CSSProperties;
}

/** Pixel length, rounded to 2 decimals (sub-hundredth px is render noise). */
function px(n: number): string {
  return `${String(Math.round(n * 100) / 100)}px`;
}

/**
 * Compute the page image's layout for the current zoom/rotation (module
 * header §"Zoom + fit model" / §"Rotation" explains WHY each branch exists).
 * Pure — trivially unit-reasonable, and keeps `PageImage`'s render lean.
 */
function pageLayout(
  zoom: number,
  rotation: Rotation,
  containerWidth: number,
  natural: NaturalSize | null,
): PageLayout {
  const sideways = rotation === 90 || rotation === 270;

  if (!sideways) {
    // 0°/180°: the box is axis-aligned either way (a 180° center rotation
    // preserves the layout box), so a percentage width is all that's needed
    // — no measurements, works before the image has even loaded.
    return {
      wrapperStyle: null,
      imgStyle: {
        width: `${String(zoom * 100)}%`,
        height: 'auto',
        maxWidth: 'none',
        ...(rotation === 180 ? { transform: 'rotate(180deg)' } : {}),
      },
    };
  }

  if (natural !== null && containerWidth > 0) {
    // 90°/270°: the visual axes swap, so size an explicit wrapper box to the
    // ROTATED dimensions and center the rotated <img> inside it. The <img>'s
    // CSS height becomes the visual WIDTH after a quarter turn — set it to
    // the target display width and let `width: auto` preserve the aspect.
    const displayW = containerWidth * zoom;
    const displayH = (displayW * natural.w) / natural.h;
    return {
      wrapperStyle: {
        position: 'relative',
        width: px(displayW),
        height: px(displayH),
      },
      imgStyle: {
        position: 'absolute',
        top: '50%',
        left: '50%',
        height: px(displayW),
        width: 'auto',
        maxWidth: 'none',
        transform: `translate(-50%, -50%) rotate(${String(rotation)}deg)`,
      },
    };
  }

  // Sideways but geometry not yet known (image still loading, or a zero-width
  // measurement): rotate in place as a best-effort preview. The box is wrong
  // for a beat; the `load` handler records the natural size and the next
  // render takes the exact branch above.
  return {
    wrapperStyle: null,
    imgStyle: {
      width: `${String(zoom * 100)}%`,
      height: 'auto',
      maxWidth: 'none',
      transform: `rotate(${String(rotation)}deg)`,
    },
  };
}

/**
 * One page's `<img>`, own load/error/retry state. Keyed by the parent on
 * `${pageNumber}-${retryToken}` — a page nav OR a retry both remount this
 * component fresh, so `status` always starts at `'loading'` for whatever is
 * currently being requested; no effect needed to "reset" anything. The
 * natural size is captured per-instance on `load` (the `src` never changes
 * within one instance, so it can't go stale).
 */
function PageImage({
  src,
  alt,
  zoom,
  rotation,
  containerWidth,
  onRetry,
}: {
  src: string;
  alt: string;
  zoom: number;
  rotation: Rotation;
  containerWidth: number;
  onRetry: () => void;
}): JSX.Element {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [natural, setNatural] = useState<NaturalSize | null>(null);

  if (status === 'error') {
    return (
      <ErrorCard
        message="Couldn’t load this page. Try again."
        onRetry={onRetry}
      />
    );
  }

  const { wrapperStyle, imgStyle } = pageLayout(
    zoom,
    rotation,
    containerWidth,
    natural,
  );

  const img = (
    <img
      src={src}
      alt={alt}
      style={{
        ...imgStyle,
        ...(status === 'loaded' ? {} : { display: 'none' }),
      }}
      onLoad={(e: SyntheticEvent<HTMLImageElement>) => {
        const el = e.currentTarget;
        // Guard 0×0 (a decode that reported no dimensions — never divide by
        // it in `pageLayout`); the sideways fallback branch covers that case.
        if (el.naturalWidth > 0 && el.naturalHeight > 0) {
          setNatural({ w: el.naturalWidth, h: el.naturalHeight });
        }
        setStatus('loaded');
      }}
      onError={() => {
        setStatus('error');
      }}
    />
  );

  return (
    <>
      {status === 'loading' ? (
        <div className="km-grammar__state" role="status">
          <Bilingual en="Loading this page…" kr="이 페이지를 불러오는 중…" />
        </div>
      ) : null}
      {wrapperStyle !== null ? (
        <div className="km-upload-viewer__rotated" style={wrapperStyle}>
          {img}
        </div>
      ) : (
        img
      )}
    </>
  );
}

export default function UploadViewer(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();

  // The `?page=N` deep-link seed — null when absent/invalid (→ page 1).
  const requestedPage = parseInitialPage(searchParams.get('page'));

  const [meta, setMeta] = useState<BookUpload | null>(null);
  const [metaState, setMetaState] = useState<MetaState>('loading');
  const [pageNum, setPageNum] = useState(1);
  const [jumpValue, setJumpValue] = useState('');
  const [zoom, setZoom] = useState(FIT_ZOOM);
  const [rotation, setRotation] = useState<Rotation>(0);
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

  // Measured width of the page scroll box — the sideways-rotation branch of
  // `pageLayout` needs real pixels (a quarter-turned page can't be sized
  // with percentages; see the module header). Captured via callback ref
  // (the box only mounts once `canView`, so a mount-time effect would
  // measure nothing) + re-measured on window resize. Scrollbar-width drift
  // after a zoom is deliberately ignored — a ~15 px error on a fit
  // calculation is invisible, and chasing it needs a ResizeObserver loop.
  const pageBoxRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const attachPageBox = useCallback((el: HTMLDivElement | null): void => {
    pageBoxRef.current = el;
    if (el !== null) {
      setContainerWidth(el.clientWidth);
    }
  }, []);
  useEffect(() => {
    const onResize = (): void => {
      const el = pageBoxRef.current;
      if (el !== null) {
        setContainerWidth(el.clientWidth);
      }
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

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
    // Seed from the deep-link when present (upper-bound clamp happens on
    // meta arrival below — `page_count` isn't known yet, and no page <img>
    // mounts before `canView`, so an overshoot never requests a page).
    setPageNum(requestedPage ?? 1);
    getUpload(id, ctrl.signal)
      .then((upload) => {
        if (ctrl.signal.aborted) return;
        setMeta(upload);
        setMetaState('ready');
        // Clamp the deep-linked seed to the real page count. Batched with
        // the `setMetaState('ready')` above (same promise handler), so the
        // viewer never paints an out-of-range page number.
        if (requestedPage !== null && upload.pageCount && upload.pageCount > 0) {
          setPageNum(Math.min(requestedPage, upload.pageCount));
        }
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setMetaState('error');
      });
    // `requestedPage` is a dep so navigating to the SAME upload with a
    // different `?page=` (e.g. two chapters of one book, back-to-back via
    // the reader's scan link) re-runs the load and re-seeds the page —
    // otherwise the second navigation would silently keep the first's page.
  }, [id, requestedPage]);

  useEffect(() => {
    // Sync-to-external-system case (mirrors the old pdf.js viewer's mount
    // effect, and Uploads.tsx's own `load` effect): there's no way to know
    // this upload's metadata without asking the server, so kicking off the
    // fetch from an effect keyed on `id` is the correct place, not something
    // to hoist out of an effect.
    //
    // `eslint-plugin-react-hooks`'s `set-state-in-effect` rule fires here
    // (confirmed real, not stale, via `--report-unused-disable-directives`)
    // on the SYNCHRONOUS `setMetaState('loading')` + seed `setPageNum` that
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
    setZoom((z) => Math.min(MAX_ZOOM, Number((z + ZOOM_STEP).toFixed(2))));
  };
  const zoomOut = (): void => {
    setZoom((z) => Math.max(MIN_ZOOM, Number((z - ZOOM_STEP).toFixed(2))));
  };
  const fitWidth = (): void => {
    setZoom(FIT_ZOOM);
  };
  const rotate = (): void => {
    setRotation((r) => ((r + 90) % 360) as Rotation);
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

  return (
    <section
      className="screen km-upload-viewer"
      aria-labelledby="km-upload-viewer-title"
    >
      {/* F-024 — no single canonical parent (Uploads list OR the reader's
          scan deep-link), so history-back with a guarded /uploads fallback. */}
      <BackButton fallbackTo="/uploads" />
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
          <div className="km-upload-viewer__toolbar">
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
              className="km-field__input km-upload-viewer__jump"
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
              disabled={zoom <= MIN_ZOOM}
              aria-label="Zoom out"
            >
              −
            </Button>
            <span className="km-resources__pager-count">
              {zoom === FIT_ZOOM ? 'Fit' : `${String(Math.round(zoom * 100))}%`}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={zoomIn}
              disabled={zoom >= MAX_ZOOM}
              aria-label="Zoom in"
            >
              +
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={fitWidth}
              disabled={zoom === FIT_ZOOM}
              aria-label="Fit width"
            >
              <Bilingual en="Fit width" kr="너비 맞춤" compact />
            </Button>

            {/* F-057 rotation — the accessible name carries the CURRENT
                angle so a screen-reader user gets the same "where am I"
                feedback the visual readout beside it provides. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={rotate}
              aria-label={
                rotation === 0
                  ? 'Rotate page'
                  : `Rotate page (rotated ${String(rotation)}°)`
              }
            >
              <Bilingual en="Rotate" kr="회전" compact />
            </Button>
            {rotation !== 0 ? (
              <span className="km-resources__pager-count">
                {rotation}°
              </span>
            ) : null}

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

            {/* F-059 — honestly disabled until the U2 OCR pipeline exists
                server-side (module header §"OCR"). The "coming soon" is in
                the VISIBLE label, not a hover-only tooltip, so keyboard and
                touch users get the same information. */}
            <Button
              variant="ghost"
              size="sm"
              disabled
              aria-label="Extract text (OCR) — coming soon"
            >
              <Bilingual
                en="Extract text (coming soon)"
                kr="텍스트 추출 (준비 중)"
                compact
              />
            </Button>
          </div>

          {reorderOpen ? (
            <div
              className="km-upload-viewer__reorder"
              role="group"
              aria-label="Reorder pages controls"
            >
              {pagesState === 'loading' ? (
                <div role="status">
                  <Bilingual en="Loading page order…" kr="페이지 순서를 불러오는 중…" />
                </div>
              ) : pagesState === 'error' ? (
                <ErrorCard message="Could not load page order. Try again." onRetry={loadPages} />
              ) : pages ? (
                <div className="km-upload-viewer__reorder-controls">
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
                    className="km-field__input km-upload-viewer__jump"
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

          <div className="km-upload-viewer__page" ref={attachPageBox}>
            <PageImage
              key={`${String(pageNum)}-${String(retryToken)}`}
              src={id ? pageUrl(id, pageNum, undefined, retryToken) : ''}
              alt={`Page ${String(pageNum)} of ${title}`}
              zoom={zoom}
              rotation={rotation}
              containerWidth={containerWidth}
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
