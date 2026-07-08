/**
 * UploadViewer — `/uploads/:id`, the U1b VIEW-ONLY PDF viewer
 * (`db/docs/PDF_UPLOAD_DESIGN.md` §"U1 → U1b client"). Renders the uploaded
 * PDF page-by-page from `GET /uploads/:id/file` via `pdfjs-dist`, with page
 * navigation and a zoom/fit control. NO text or annotation layer is
 * mounted — only the page's `<canvas>` bitmap renders — so there is nothing
 * to select, highlight, or edit; this is a read surface, not an editor.
 *
 * pdf.js + Vite wiring (the part that has to survive a PRODUCTION build, not
 * just dev — verified via `npm run build`):
 *   - The worker script MUST be bundled, never CDN-fetched: this app runs
 *     behind an offline-capable PWA shell (vite.config.ts's Workbox
 *     precache) and a strict CSP, so a runtime `cdn.jsdelivr.net`/unpkg
 *     fetch would be blocked online and simply absent offline.
 *     `import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'`
 *     is Vite's asset-URL import form — Vite copies the worker file into
 *     `dist/assets/` at build time (content-hashed filename) and resolves
 *     the import to that final same-origin URL string. No network fetch at
 *     import time, no CDN dependency, ever.
 *   - `GlobalWorkerOptions.workerSrc` is set ONCE at module scope (below),
 *     not per-render, so every document load in the app shares the one
 *     worker configuration — matches pdf.js's own recommended pattern.
 *   - We never override pdf.js's safe `isEvalSupported` default — a scanned
 *     PDF's embedded JS (if any) never executes.
 *
 * Progressive rendering (big-PDF judgment call — flag for /fixpass): U1's
 * "a handful of books, 200–300pp, hand-scanned" volume (design doc) makes
 * full virtualized multi-page scroll overkill for v1. We render exactly ONE
 * page's canvas at a time (paged nav, not infinite-scroll): a 300-page PDF
 * therefore costs one page's raster work per nav tap, never blocking the
 * main thread rasterizing the other 299. A virtualized continuous-scroll
 * viewer is a reasonable follow-up if usage shows a preference for that over
 * paged nav.
 *
 * Cancellation: pdf.js's own `RenderTask.cancel()` stops a fast page-flip or
 * zoom drag from racing two renders onto the same canvas (pdf.js throws if a
 * second render starts before the first finishes) — the render-cancellation
 * analogue of the `AbortController` discipline the rest of the app uses for
 * network calls (F-016/Slice-2). The document + loading task are destroyed
 * on unmount / id change / retry so worker-side resources never leak across
 * navigations, and every async continuation is guarded against a stale `id`
 * or an unmounted component before touching state.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useParams } from 'react-router-dom';
import {
  getDocument,
  GlobalWorkerOptions,
  RenderingCancelledException,
} from 'pdfjs-dist';
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from 'pdfjs-dist';
// Vite asset-URL import (`?url`) — see the header doc for why this MUST be
// a bundled file, never a CDN string.
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Bilingual } from '../components/Bilingual';
import { Button } from '../components/Button';
import { ErrorCard } from '../components/ErrorCard';
import { Icon } from '../components/Icon';
import { Topbar } from '../components/Topbar';
import { getUpload, pdfFileUrl } from '../services/uploads';

// Module scope, once — every document load in the app shares this worker.
GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;
const SCALE_STEP = 0.25;
const DEFAULT_SCALE = 1;

type LoadState = 'loading' | 'ready' | 'error';

export default function UploadViewer(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [title, setTitle] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [scale, setScale] = useState(DEFAULT_SCALE);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  // Guards every async settle against a stale `id` (route param changed
  // without unmounting this component instance) or a real unmount.
  const aliveRef = useRef(true);

  /** Tear down whatever pdf.js resources are currently held, if any. Called
   *  both from `load()` (so a manual retry / id-change never leaks the
   *  PREVIOUS attempt's doc/task) and from the mount effect's cleanup. */
  const teardown = useCallback((): void => {
    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;
    loadingTaskRef.current?.destroy();
    loadingTaskRef.current = null;
    const doc = docRef.current;
    docRef.current = null;
    if (doc) void doc.destroy();
  }, []);

  const load = useCallback((): void => {
    teardown();
    if (!id) {
      setState('error');
      return;
    }
    setState('loading');
    setNumPages(0);
    setPageNum(1);
    setTitle(null);

    // Best-effort title fetch — a failure here never blocks the PDF itself
    // (the header just falls back to a generic label).
    getUpload(id)
      .then((upload) => {
        if (!aliveRef.current) return;
        setTitle(upload.title);
      })
      .catch(() => {
        // Fixed fallback title renders in the header; nothing else to do.
      });

    const loadingTask = getDocument({
      url: pdfFileUrl(id),
      // The PDF route is authed via the session cookie, not a bearer token —
      // pdf.js does its own fetch/XHR outside axios, so it needs this flag
      // to actually send the cookie (mirrors `withCredentials: true` on the
      // shared axios instance in services/api.ts).
      withCredentials: true,
    });
    loadingTaskRef.current = loadingTask;

    loadingTask.promise
      .then((doc) => {
        if (!aliveRef.current || loadingTaskRef.current !== loadingTask) {
          void doc.destroy();
          return;
        }
        docRef.current = doc;
        setNumPages(doc.numPages);
        setState('ready');
      })
      .catch(() => {
        if (!aliveRef.current || loadingTaskRef.current !== loadingTask) return;
        setState('error');
      });
  }, [id, teardown]);

  useEffect(() => {
    aliveRef.current = true;
    // Sync-to-external-system case (mirrors AuthProvider's session probe):
    // there's no way to know what's in a given PDF without asking the
    // server for its bytes, so kicking off the load from an effect (keyed on
    // `id`) is the correct place, not something to hoist out of an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => {
      aliveRef.current = false;
      teardown();
    };
  }, [load, teardown]);

  // Render the current page whenever the doc/page/scale changes. Cancels
  // any in-flight render first (see the header doc on why).
  const renderPage = useCallback(async (): Promise<void> => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas) return;

    renderTaskRef.current?.cancel();
    try {
      const page = await doc.getPage(pageNum);
      if (!aliveRef.current || docRef.current !== doc) return;
      const viewport = page.getViewport({ scale });
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      const task = page.render({ canvas, viewport });
      renderTaskRef.current = task;
      await task.promise;
      if (renderTaskRef.current === task) renderTaskRef.current = null;
    } catch (err) {
      if (!aliveRef.current || docRef.current !== doc) return;
      // A cancelled render (fast page-flip / zoom drag) throws pdf.js's own
      // cancellation exception — the EXPECTED result of `.cancel()` above,
      // not a real failure. Only a genuine render error flips to the error
      // state; a cancellation must not blank a perfectly good document.
      if (err instanceof RenderingCancelledException) return;
      setState('error');
    }
  }, [pageNum, scale]);

  useEffect(() => {
    if (state !== 'ready') return;
    // Sync-to-external-system case — same reasoning as the load effect
    // above: rasterizing the current page is a canvas side-effect driven by
    // React state (doc/page/scale), not something to compute inline.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void renderPage();
  }, [state, renderPage]);

  const goPrev = (): void => {
    setPageNum((p) => Math.max(1, p - 1));
  };
  const goNext = (): void => {
    setPageNum((p) => Math.min(numPages, p + 1));
  };
  const zoomIn = (): void => {
    setScale((s) => Math.min(MAX_SCALE, Number((s + SCALE_STEP).toFixed(2))));
  };
  const zoomOut = (): void => {
    setScale((s) => Math.max(MIN_SCALE, Number((s - SCALE_STEP).toFixed(2))));
  };

  /** Fit the page to the container's current width. Best-effort — a failure
   *  just leaves the current zoom level unchanged. */
  const fitWidth = useCallback(async (): Promise<void> => {
    const doc = docRef.current;
    const container = containerRef.current;
    if (!doc || !container || container.clientWidth <= 0) return;
    try {
      const page = await doc.getPage(pageNum);
      if (!aliveRef.current || docRef.current !== doc) return;
      const naturalWidth = page.getViewport({ scale: 1 }).width;
      if (naturalWidth <= 0) return;
      const target = container.clientWidth / naturalWidth;
      setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(target.toFixed(2)))));
    } catch {
      // Best-effort — see doc above.
    }
  }, [pageNum]);

  return (
    <section
      className="screen km-upload-viewer"
      aria-labelledby="km-upload-viewer-title"
    >
      <Topbar
        krTitle="PDF"
        title={title ?? 'PDF'}
        titleId="km-upload-viewer-title"
        eyebrow={<Bilingual en="View-only PDF" kr="PDF 보기 전용" />}
      />

      {state === 'loading' ? (
        <div className="km-grammar__state" role="status">
          <Bilingual en="Loading the PDF…" kr="PDF를 불러오는 중…" />
        </div>
      ) : state === 'error' ? (
        <ErrorCard
          message="Couldn’t load this PDF. Try again."
          onRetry={load}
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
              {pageNum} / {numPages || 1}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={goNext}
              disabled={pageNum >= numPages}
              aria-label="Next page"
            >
              <Icon name="chevron-right" size={14} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={zoomOut}
              disabled={scale <= MIN_SCALE}
              aria-label="Zoom out"
            >
              −
            </Button>
            <span className="km-resources__pager-count">
              {Math.round(scale * 100)}%
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={zoomIn}
              disabled={scale >= MAX_SCALE}
              aria-label="Zoom in"
            >
              +
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void fitWidth();
              }}
            >
              <Bilingual en="Fit width" kr="너비 맞춤" compact />
            </Button>
          </div>
          <div
            ref={containerRef}
            className="km-upload-viewer__page"
            style={{ overflow: 'auto', width: '100%' }}
          >
            {/* View-only: no text/annotation layer is mounted, only the
                rasterized bitmap — nothing here is selectable or editable. */}
            <canvas
              ref={canvasRef}
              aria-label={`Page ${String(pageNum)} of ${title ?? 'this PDF'}`}
            />
          </div>
        </>
      )}
    </section>
  );
}
