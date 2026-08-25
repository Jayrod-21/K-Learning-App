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
 * OCR / "Extract text" (F-059, wired to the F-108/U2 backend): the toolbar
 * button POSTs `/uploads/:id/extract` with NO body — omitting the optional
 * page range asks the server for its own "resume after the last done run"
 * default slice (a bounded 10-page bite, half the 20-page per-run ceiling),
 * so the zero-config tap never scans the whole book and never spends the
 * daily Vision budget in one go. The POST is SYNCHRONOUS server-side (the
 * response IS the settled run, done/failed with counts), so the button's
 * own lifecycle is: disabled + "Extracting…" while the POST is in flight →
 * the settled run prepends the local history and renders in the status
 * strip below the toolbar. `GET /uploads/:id/extract` (fetched when the
 * viewer becomes viewable, best-effort) seeds that history: if ITS latest
 * run is still live (a run triggered from another tab, or one orphaned by a
 * server restart until the stale-reap settles it), the button is disabled
 * with an honest "already running" state and a manual "Refresh status"
 * re-reads the GET — a poll loop was deliberately NOT added: runs settle
 * within the triggering request in this synchronous design, so the only
 * observable-live case is the cross-tab/orphan one above, which a manual
 * refresh covers without a background timer to leak or test around.
 * Every documented error maps to FIXED copy (never echoed server prose,
 * including the run row's own `error` column): 409 → already running,
 * 429 → daily limit (surfacing the structured numeric retry hint when the
 * server provides one), 400 → bad page range, 404 → not found.
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
 *
 * F-128 "Seoul Day & Night" reskin: the header adopts the shared
 * `PageHubHeader` (devices #4/#2, `components/PageHubHeader.tsx`, batch-2
 * fix-pass BLOCKER-2) instead of a bare `Topbar`, and the page-image box is
 * wrapped in a `CityCard` (device #1, `tone="plain"` + `rail`) — the "PDF
 * signboard/paper" surface from the design mock. The root also carries
 * `.km-rain-sheen` (device #8, Night ambient) — the one thing this page was
 * missing (`REVIEW_batch2-fidelity.md` S1). Purely visual; none of the
 * load/zoom/rotate/reorder logic above changes.
 *
 * F-155 mobile swipe (paired with F-130): the toolbar's Prev/Next buttons
 * were the ONLY way to turn a page — touch swipe never worked because
 * nothing listened for it. `onPagePointerDown/Move/Up/Cancel/Leave` below
 * arm a horizontal-swipe-to-turn-page gesture on `.km-upload-viewer__page`,
 * reusing `components/SwipeCarousel.tsx`'s exact Pointer Events model
 * (unifying mouse/pen in one handler set — touch is a SEPARATE path now,
 * see "F-155 second real-device fix" below) and its documented gotchas: an
 * 8px axis lock decides swipe-vs-scroll on the first move, a vertical-
 * dominant gesture is surrendered immediately (so the page still scrolls),
 * `setPointerCapture` is deferred until the axis locks 'h' (so it can't
 * break interactive content under an undecided gesture), and
 * `pointerleave`/`lostpointercapture` end an unfinished gesture so a stuck
 * ref can never swallow a future swipe (see SwipeCarousel's header for the
 * full "stuck-drag safety" rationale — identical reasoning applies here).
 *
 * One deliberate difference from `SwipeCarousel`: there is no sliding
 * "track" of adjacent pages. The lazy-mount contract above (only the
 * CURRENT page's `<img>` ever exists in the DOM) is load-bearing for a
 * 500-page book, and a live cross-fade/slide between two pages would need
 * the next page's image mounted mid-drag, which breaks that invariant. The
 * gesture instead nudges the CURRENT page a few px toward the drag (a
 * lightweight "this is draggable" affordance, damped 3:1 past the first/
 * last page same as the carousel) and, past a snap threshold on release,
 * commits a discrete page change — `goPrev`/`goNext`, the same functions the
 * arrow buttons call, so keyboard/click paging is untouched. The gesture is
 * only armed when `zoom <= FIT_ZOOM` (`swipeEligible` below): above fit-
 * width the page image itself overflows the box horizontally, and a
 * horizontal drag there is a legitimate pan over the zoomed-in page, not a
 * page-turn — `touchAction` on the box switches to the browser's native
 * `'auto'` panning in that state instead of the swipe-reserving `'pan-y'`.
 *
 * F-155 real-device follow-up #1 (the `preventDefault`/`touch-action`/
 * `overscroll-behavior-x` trio above was ported from `SwipeCarousel` but
 * swipe STILL failed on a real phone): the missing piece was never the
 * scroll/tap-replay race those three defend against — it's that this
 * gesture's content is a literal `<img>`, and `SwipeCarousel` never drags
 * across one. An `<img>` is an implicit native DRAG SOURCE
 * (`draggable` defaults to `true` for `img`/`a`) and, on iOS, a native
 * long-press "Save/Copy/Open" callout target. Both are a SEPARATE browser
 * subsystem from scroll/pan arbitration — `touch-action` only governs
 * panning/scrolling and `preventDefault()` inside `pointermove` only vetoes
 * that same panning/scrolling — neither one has any say over whether the
 * engine decides this touch is "dragging an image" or "long-pressing an
 * image" instead of "a custom pointer gesture." Fixed at the `<img>` itself
 * (`.km-upload-viewer__img` below): `draggable={false}` + an `onDragStart`
 * veto turn off the native drag source, and `-webkit-touch-callout: none`
 * turns off iOS's long-press menu.
 *
 * F-155 real-device follow-up #2 (swipe STILL failed after #1 — the actual
 * root cause): #1 was real, but it wasn't the whole story, because it never
 * explained why `SwipeCarousel` (Today's carousel, ported gesture-for-
 * gesture) works while this page's identical logic didn't. The structural
 * difference is `.km-upload-viewer__page` — unlike `.km-carousel__viewport`
 * (`overflow: hidden`, nothing ever scrolls inside it), this box is a REAL
 * `overflow: auto` scroll container, because a book scan at fit-width is
 * routinely taller than the viewport. `touch-action: pan-y` on a
 * genuinely-scrollable element is a much bigger grant than it looks:
 * browsers use it as a license to let the COMPOSITOR thread commit to a
 * native vertical pan for a touch, using the engine's OWN (coarser, faster)
 * direction heuristic, WITHOUT first round-tripping through the main
 * thread — that round-trip guarantee only exists for a genuinely
 * non-passive TOUCH event listener (it's the literal reason passive
 * listeners were invented: so the compositor can skip asking JS). Pointer
 * Events, though not passive here (confirmed against `react-dom`'s
 * `addTrappedEventListener` — it only force-passives `touchstart`/
 * `touchmove`/`wheel`, never pointer events), are a newer, thinner layer on
 * top of that same native touch/scroll pipeline and don't reliably carry
 * the same "JS gets first refusal on every sample" guarantee on every
 * engine. On `SwipeCarousel`'s non-scrollable viewport `pan-y` is a dead
 * letter (nothing to pan), so every sample reaches JS uncontested; on this
 * page's genuinely-tall box it competes with a real native gesture, and a
 * real thumb swipe is never perfectly axis-pure — the sliver of vertical
 * drift is enough for the compositor to occasionally win the race before
 * this component's 8px axis lock (or its `preventDefault()`) ever runs.
 * That reads as "no console error, nothing happens" — exactly the reported
 * symptom.
 *
 * Fix: touch is no longer driven through React's Pointer Events at all.
 * `onPagePointerDown/Move/Up/Cancel/Leave` below now open with
 * `if (e.pointerType === 'touch') return;` and exist ONLY for mouse/pen
 * (still exercised by every existing mouse-drag test). A dedicated
 * `useEffect` attaches real `touchstart`/`touchmove`/`touchend`/
 * `touchcancel` listeners directly via `addEventListener`, with `touchmove`
 * explicitly `{ passive: false }` — the one guarantee that actually forces
 * the browser to ask this handler before the compositor commits to a
 * native scroll. (JSX `onTouchMove` was deliberately NOT used instead: React
 * registers its own delegated `touchmove` listener as passive by default —
 * confirmed in the same `addTrappedEventListener` — so wiring this through
 * JSX props would silently reintroduce the exact bug being fixed here.) The
 * same axis-lock/threshold/damping constants and logic are reused verbatim
 * (`runSwipeMove`/`runSwipeEnd` below), so touch and mouse/pen feel
 * identical; only the event source differs.
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
import { CityCard } from '../components/CityCard';
import { ErrorCard } from '../components/ErrorCard';
import { Icon } from '../components/Icon';
import { PageHubHeader } from '../components/PageHubHeader';
import { useToast } from '../components/useToast';
import { errorMessageFor } from '../lib/errorCopy';
import { ApiError } from '../services/api';
import {
  getUpload,
  listExtractions,
  listPages,
  pageUrl,
  reorderPages,
  startExtraction,
} from '../services/uploads';
import type { BookUpload, ExtractionRun, Page } from '../types/domain';
import './UploadViewer.css';

/** Poll cadence while this upload is `pending`/`processing` (Phase 2.5 —
 *  the async ingest runner decodes off the request path). Matches
 *  Uploads.tsx's UNSETTLED_UPLOAD_POLL_MS. */
const UPLOAD_META_POLL_MS = 3000;

/** Zoom is a multiplier of the container width — 1 = exact fit-width. */
const FIT_ZOOM = 1;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.25;

/**
 * F-155 swipe-to-turn-page thresholds — mirrors
 * `components/SwipeCarousel.tsx`'s tuned constants (same feel across the
 * app's two hand-rolled pointer-drag gestures). Not imported from there:
 * they're module-private consts, not exported, and the two gestures commit
 * differently (a discrete page change here vs. an index snap there) so
 * duplicating four small numbers is simpler than threading a shared config
 * object across an unrelated component boundary.
 */
/** Movement (px) before a gesture commits to an axis. */
const SWIPE_AXIS_LOCK_PX = 8;
/** Snap threshold floor (px) when the box's measured width is unknown/small. */
const SWIPE_MIN_SNAP_PX = 48;
/** Snap threshold as a fraction of the page box's width. */
const SWIPE_SNAP_FRACTION = 0.2;
/** Overscroll damping divisor at the first/last page. */
const SWIPE_EDGE_DAMPING = 3;

/** One in-progress swipe gesture's bookkeeping (mouse/pen pointer OR touch —
 * both paths below share this shape and this ref). */
interface SwipeDrag {
  /** `PointerEvent.pointerId` for mouse/pen; `Touch.identifier` for touch —
   * either way, the stable id that ties a stream of move samples back to
   * the gesture that armed them. */
  pointerId: number;
  startX: number;
  startY: number;
  /** 'none' until the 8px lock decides; 'v' means surrendered to scroll. */
  axis: 'none' | 'h' | 'v';
}

/**
 * Axis decision for one drag sample — pure, and the SINGLE source of truth
 * for the 8px lock shared by the mouse/pen pointer path
 * (`onPagePointerMove`) and the native touch path (the `useEffect` below,
 * module header §"F-155 second real-device fix"). Returns the axis
 * unchanged once already decided ('h' or 'v') — the lock never re-opens
 * mid-gesture.
 */
function swipeAxisFor(
  priorAxis: SwipeDrag['axis'],
  startX: number,
  startY: number,
  clientX: number,
  clientY: number,
): SwipeDrag['axis'] {
  if (priorAxis !== 'none') return priorAxis;
  const dx = clientX - startX;
  const dy = clientY - startY;
  if (Math.abs(dx) < SWIPE_AXIS_LOCK_PX && Math.abs(dy) < SWIPE_AXIS_LOCK_PX) return 'none';
  return Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
}

/** Find a `Touch` by `identifier` in a `TouchList` (`touches`/
 * `changedTouches`) — a multi-touch page can carry fingers this gesture
 * doesn't own; every touch handler below must ignore those, not just take
 * `[0]`. Null when no touch in the list matches (e.g. a DIFFERENT finger
 * lifted while ours is still down). */
function touchById(list: TouchList, id: number): Touch | null {
  // Indexed access (`list[i]`), not `.item(i)`: both are valid per the
  // `TouchList` spec on a real device, but happy-dom's `TouchEvent` (this
  // component's test suite) stores whatever array-like value the test
  // handed it verbatim rather than constructing a real `TouchList` — `[i]`
  // reads correctly from a genuine `TouchList` AND a plain test array.
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i];
    if (t && t.identifier === id) return t;
  }
  return null;
}

/**
 * F-059 — fixed user-facing copy for a failed extract trigger, keyed on the
 * STRUCTURED `ApiError` status only (lib/errorCopy.ts's contract: server
 * prose — including the run row's own `error` column — is never echoed into
 * the UI). Every error the extract route documents gets its own honest
 * message; the 429 branch interpolates the structured NUMERIC retry hint
 * when the server provides one — a number, not prose.
 */
function extractErrorCopy(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) {
      return 'An extraction is already running for this book — give it a minute, then refresh the status below.';
    }
    if (err.status === 429) {
      return err.retryAfter !== undefined
        ? `Daily extraction limit reached. Try again in about ${String(Math.ceil(err.retryAfter))} seconds.`
        : 'Daily extraction limit reached — try again tomorrow.';
    }
    if (err.status === 400 && err.code === 'validation_error') {
      // The trigger always POSTs an EMPTY body (services/uploads.ts), so the
      // route's range validations (inverted/oversized range) can't fire —
      // the only validation_error left is the server's "no pages in the
      // resume-default range" (uploadExtract.ts), i.e. nothing unscanned
      // remains. A 400 with any OTHER code is an upstream Vision rejection
      // passed through by mapClaudeError, which is NOT a "fully scanned"
      // situation — it falls through to the generic fixed fallback below.
      return 'Nothing left to extract — this book may already be fully scanned.';
    }
    if (err.status === 404) {
      return 'This book could not be found — it may have been deleted.';
    }
  }
  return errorMessageFor(err, 'Could not extract text. Try again.');
}

/**
 * F-059 — bilingual copy for a DONE run's status line: the page range it
 * covered, the real persisted counts, and (only when non-zero) how many
 * pages the OCR couldn't read. Pure string building — pulled out of the JSX
 * so the nesting stays readable.
 */
function doneRunCopy(run: ExtractionRun): { en: string; kr: string } {
  const range = `${String(run.pageFrom)}–${String(run.pageTo)}`;
  const failedEn =
    run.pagesFailed > 0
      ? ` (${String(run.pagesFailed)} page${run.pagesFailed === 1 ? '' : 's'} could not be read)`
      : '';
  const failedKr =
    run.pagesFailed > 0 ? ` (읽지 못한 페이지 ${String(run.pagesFailed)}개)` : '';
  return {
    en: `Extracted pages ${range}: ${String(run.vocabInserted)} words and ${String(run.grammarInserted)} grammar patterns saved${failedEn}.`,
    kr: `${range}쪽 추출 완료: 단어 ${String(run.vocabInserted)}개 · 문형 ${String(run.grammarInserted)}개 저장${failedKr}.`,
  };
}

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
      className="km-upload-viewer__img"
      // F-155 real-device fix (module header §"real-device follow-up"): an
      // <img> is an implicit native drag source and iOS long-press-callout
      // target — both race the custom pointer-swipe gesture independently
      // of `touch-action`/`preventDefault`, which only govern scroll/pan.
      // `draggable={false}` + the `onDragStart` veto turn off drag; the
      // matching `-webkit-touch-callout: none` (UploadViewer.css) turns off
      // the iOS callout. Together every touch sample reaches only this
      // component's own handlers.
      draggable={false}
      onDragStart={(e) => {
        e.preventDefault();
      }}
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
  // A ref's `.current` is deliberately invisible to React's dependency
  // diffing — that's the whole point of a ref — so the native-touch effect
  // below (which needs to know the MOMENT the box actually mounts, to attach
  // its listeners) cannot depend on `pageBoxRef.current` directly. Mirroring
  // it into state is the standard "DOM node as an effect dependency" pattern
  // — `pageBoxEl` changes from `null` to the real node exactly once (`canView`
  // gates the box's existence), which IS an observable dependency change.
  // (`containerWidth` alone doesn't reliably signal this: it's initialized to
  // 0 and a 0-width measurement — real in a hidden/collapsed layout, and the
  // norm under happy-dom, which does no real layout — would leave the
  // dependency unchanged across the mount, silently skipping the attach.)
  const [pageBoxEl, setPageBoxEl] = useState<HTMLDivElement | null>(null);
  const attachPageBox = useCallback((el: HTMLDivElement | null): void => {
    pageBoxRef.current = el;
    setPageBoxEl(el);
    if (el !== null) {
      setContainerWidth(el.clientWidth);
    }
  }, []);

  // F-155 swipe-to-turn-page drag bookkeeping — mirrors SwipeCarousel's
  // split between a ref (per-gesture identity/axis, mutated only by
  // handlers, never read during render) and state (`dragX`, the live px
  // offset that actually needs to repaint). See the module header for the
  // full interaction-model writeup.
  const swipeRef = useRef<SwipeDrag | null>(null);
  const [swipeDragX, setSwipeDragX] = useState<number | null>(null);
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
    // `eslint-plugin-react-hooks`'s `set-state-in-effect` rule USED to fire
    // here (on the SYNCHRONOUS `setMetaState('loading')` + seed `setPageNum`
    // that `loadMeta` runs BEFORE its `await`, plus the no-`id` early
    // `setMetaState('error')` branch) and carried a suppression with a long
    // safety argument; after the F-059 additions elsewhere in this component
    // the rule's per-file heuristic no longer reports it (flagged as an
    // unused directive by `--report-unused-disable-directives`), so the
    // suppression is gone. The safety reasoning still holds and is kept for
    // the day the heuristic swings back: those synchronous writes are
    // no-ops on first mount (state already at initial values — React bails
    // without a re-render), and on an `id` change without unmount they're
    // the intentional "reset prop-derived state when the identity prop
    // changes"; every write after the await is guarded by
    // `ctrl.signal.aborted`.
    loadMeta();
    return () => {
      metaCtrlRef.current?.abort();
    };
  }, [loadMeta]);

  // Phase 2.5 — async book-upload pipeline: a book navigated to right after
  // upload (or still mid-decode from an earlier session) lands here
  // `pending`/`processing` — poll `loadMeta` until the in-server runner
  // (services/bookIngestRunner.ts) settles it `ready`/`failed`, so the
  // "still processing" card below flips to the real viewer (or the real
  // error) without the user having to tap Retry themselves. Mirrors
  // Uploads.tsx's list-level polling effect.
  const isUnsettled = meta?.status === 'pending' || meta?.status === 'processing';
  useEffect(() => {
    if (!isUnsettled) return;
    const pollId = window.setInterval(() => {
      loadMeta();
    }, UPLOAD_META_POLL_MS);
    return () => {
      window.clearInterval(pollId);
    };
  }, [isUnsettled, loadMeta]);

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

  // F-155 — only fit-width-or-narrower is eligible for the swipe-to-turn
  // gesture (module header explains why: above fit, a horizontal drag is a
  // legitimate pan over the zoomed page, not a page turn).
  const swipeEligible = zoom <= FIT_ZOOM;

  const endSwipe = (): void => {
    swipeRef.current = null;
    setSwipeDragX(null);
  };

  // F-155 second real-device fix (module header) — touch is driven ENTIRELY
  // by the native-`addEventListener` effect below now. Every handler here
  // opens by bailing on `pointerType === 'touch'`, so this family only ever
  // arms/tracks a mouse or pen drag; touch can never reach (or corrupt)
  // `swipeRef` through this path, and vice versa.
  const onPagePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === 'touch') return;
    if (!swipeEligible) return;
    // Only the primary pointer with the left/first button may arm a
    // gesture — same guard as SwipeCarousel, for the same reason (a
    // right-click's pointerup a context menu can suppress; a second pointer
    // must never restart/corrupt an in-progress drag).
    if (!e.isPrimary || e.button !== 0) return;
    if (swipeRef.current !== null) return;
    swipeRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      axis: 'none',
    };
  };

  const onPagePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === 'touch') return;
    const d = swipeRef.current;
    if (d === null || d.pointerId !== e.pointerId) return;

    const wasUndecided = d.axis === 'none';
    d.axis = swipeAxisFor(d.axis, d.startX, d.startY, e.clientX, e.clientY);
    if (d.axis === 'none') return;
    if (d.axis === 'v') {
      // Vertical-dominant: this is a page scroll, not a swipe. Surrender
      // immediately (same "stuck-drag safety" reasoning as SwipeCarousel
      // — an immortal ref here would swallow every future swipe if a
      // mouse released off-box never delivered us a pointerup).
      endSwipe();
      return;
    }

    // Just locked 'h' this sample — claim the pointer so drag samples keep
    // arriving even if the cursor leaves the box mid-drag (mouse has no
    // implicit capture the way touch does).
    if (wasUndecided) {
      const el = pageBoxRef.current;
      if (el && typeof el.setPointerCapture === 'function') {
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // Capture is an enhancement; the drag works without it.
        }
      }
    }

    // Once the axis has locked horizontal, veto whatever native handling
    // this pointer type would otherwise do (a text-selection drag, mostly,
    // for mouse/pen) on every 'h' move, not just the first. Guarded by
    // `cancelable`: some replayed/synthetic events aren't.
    if (e.cancelable) e.preventDefault();

    const dx = e.clientX - d.startX;
    // Damp overscroll at the first/last page so the edge feels solid.
    const overscroll =
      (pageNum <= 1 && dx > 0) || (!!pageCount && pageNum >= pageCount && dx < 0);
    setSwipeDragX(overscroll ? dx / SWIPE_EDGE_DAMPING : dx);
  };

  const onPagePointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === 'touch') return;
    const d = swipeRef.current;
    if (d === null || d.pointerId !== e.pointerId) return;

    if (d.axis === 'h') {
      // Decide off the raw event delta, not the damped state — no staleness.
      const dx = e.clientX - d.startX;
      const width = pageBoxRef.current?.offsetWidth ?? 0;
      const threshold = Math.max(SWIPE_MIN_SNAP_PX, width * SWIPE_SNAP_FRACTION);
      if (dx <= -threshold) goNext();
      else if (dx >= threshold) goPrev();
    }
    endSwipe();
  };

  const onPagePointerCancel = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === 'touch') return;
    const d = swipeRef.current;
    if (d === null || d.pointerId !== e.pointerId) return;
    endSwipe();
  };

  const onPagePointerLeave = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === 'touch') return;
    const d = swipeRef.current;
    if (d === null || d.pointerId !== e.pointerId) return;
    // Once the axis locks 'h' the pointer is captured, so moves keep coming
    // and a leave is not a concern. A gesture still in the capture-less
    // 'none' phase can never complete once the pointer leaves (a mouse
    // pointerup off-element would never reach us) — end it here so it
    // can't permanently block future gestures.
    if (d.axis !== 'h') endSwipe();
  };
  const onPagePointerLost = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === 'touch') return;
    endSwipe();
  };

  // F-155 second real-device fix (module header §"F-155 second real-device
  // fix") — the actual touch path. Wired via real `addEventListener`
  // (`touchmove` explicitly `{ passive: false }`) instead of JSX
  // `onTouchStart`/`onTouchMove`, because React registers ITS OWN delegated
  // `touchmove` listener as passive by default (confirmed against
  // `react-dom`'s `addTrappedEventListener` — it force-passives exactly
  // `touchstart`/`touchmove`/`wheel`), which would silently make
  // `preventDefault()` a no-op if this were wired through JSX props instead.
  // `latestRef` exists because this effect only re-attaches when
  // `swipeEligible` flips — `pageNum`/`pageCount`/`goPrev`/`goNext` change on
  // every page turn (and `goPrev`/`goNext` aren't memoized), so the handlers
  // read them from a ref kept in sync every render rather than closing over
  // stale values or forcing a listener churn on every page turn.
  const swipeLatestRef = useRef({ pageNum, pageCount, goPrev, goNext });
  // `react-hooks/refs` forbids writing `.current` during render (a ref
  // isn't a rendering value) — sync it in an effect instead. This still
  // lands the fresh value before any USER-triggered touch event can read
  // it (an effect commits before the browser can dispatch a new event to
  // this tab), so there is no real staleness window despite running one
  // tick after render rather than synchronously inside it.
  useEffect(() => {
    swipeLatestRef.current = { pageNum, pageCount, goPrev, goNext };
  });

  useEffect(() => {
    const el = pageBoxEl;
    if (!swipeEligible || el === null) return;

    const onTouchStart = (e: TouchEvent): void => {
      // Second finger down while one is already tracked: ignored, not
      // restarted (same "a second touch must never corrupt an in-progress
      // drag" contract as the pointer path).
      if (swipeRef.current !== null) return;
      const t = e.touches[0];
      if (!t) return;
      swipeRef.current = {
        pointerId: t.identifier,
        startX: t.clientX,
        startY: t.clientY,
        axis: 'none',
      };
    };

    const onTouchMove = (e: TouchEvent): void => {
      const d = swipeRef.current;
      if (d === null) return;
      const t = touchById(e.touches, d.pointerId);
      if (!t) return;

      // Known design-limit (capstone review, "Fix 1" S1 — not a bug):
      // while `d.axis` is still 'none' (the first <8px sample) this handler
      // never calls `preventDefault`, so the compositor is still free to
      // decide the gesture under `touch-action: pan-y`. If that very first
      // cancelable touchmove happens to be vertical-dominant enough for the
      // compositor to commit to a native vertical pan, later samples in the
      // SAME gesture get marked non-cancelable — so a near-diagonal onset
      // that only locks 'h' a few samples later can still lose this one
      // page-turn to native scroll (it self-corrects on the next swipe; see
      // the `if (e.cancelable)` guard below). The only way to fully close
      // this is `touch-action: none` while eligible, which would forfeit
      // native vertical scroll of a tall scan — unacceptable, so `pan-y` +
      // this 8px axis-lock window is the correct tradeoff, not an oversight.
      d.axis = swipeAxisFor(d.axis, d.startX, d.startY, t.clientX, t.clientY);
      if (d.axis === 'none') return;
      if (d.axis === 'v') {
        // Vertical-dominant: surrender so the native vertical scroll (still
        // allowed — `touch-action: pan-y`) keeps working uninterrupted.
        endSwipe();
        return;
      }

      // The one line that actually matters (module header): a non-passive
      // listener means the browser MUST ask this handler before it can
      // commit to a native scroll for this touch — unlike a JSX
      // `onTouchMove` (passive) or even a Pointer Events `preventDefault()`
      // on this same genuinely-scrollable box, which don't carry that
      // same-thread guarantee on every engine.
      if (e.cancelable) e.preventDefault();

      const dx = t.clientX - d.startX;
      const { pageNum: curPageNum, pageCount: curPageCount } = swipeLatestRef.current;
      const overscroll =
        (curPageNum <= 1 && dx > 0) || (!!curPageCount && curPageNum >= curPageCount && dx < 0);
      setSwipeDragX(overscroll ? dx / SWIPE_EDGE_DAMPING : dx);
    };

    const onTouchEnd = (e: TouchEvent): void => {
      const d = swipeRef.current;
      if (d === null) return;
      const t = touchById(e.changedTouches, d.pointerId);
      if (!t) return; // a DIFFERENT finger lifted — our gesture is untouched.

      if (d.axis === 'h') {
        // Decide off the raw event delta, not the damped state.
        const dx = t.clientX - d.startX;
        const width = pageBoxRef.current?.offsetWidth ?? 0;
        const threshold = Math.max(SWIPE_MIN_SNAP_PX, width * SWIPE_SNAP_FRACTION);
        const { goNext: next, goPrev: prev } = swipeLatestRef.current;
        if (dx <= -threshold) next();
        else if (dx >= threshold) prev();
      }
      endSwipe();
    };

    const onTouchCancel = (e: TouchEvent): void => {
      const d = swipeRef.current;
      if (d === null) return;
      const t = touchById(e.changedTouches, d.pointerId);
      if (!t) return;
      endSwipe();
    };

    // `touchstart`/`touchend`/`touchcancel` never call `preventDefault` here,
    // so they stay passive (no reason to force the main-thread round-trip
    // for those); `touchmove` is the one that must not be.
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [swipeEligible, pageBoxEl]);

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

  // ── F-059 — OCR extraction trigger + status (module header §"OCR") ──
  // `extractRuns` is the local mirror of the GET's newest-first history:
  // null = never loaded (best-effort — a failed read leaves the trigger
  // usable; the server re-fences every POST anyway), [] = loaded, no runs.
  const [extractRuns, setExtractRuns] = useState<ExtractionRun[] | null>(null);
  const [maxPagesPerRun, setMaxPagesPerRun] = useState<number | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const extractCtrlRef = useRef<AbortController | null>(null);
  const runsCtrlRef = useRef<AbortController | null>(null);

  // Returns a promise (never rejects — best-effort) so `extract()` can AWAIT
  // the re-read on a timeout failure before its `finally` re-enables the
  // trigger; fire-and-forget callers just `void` it.
  const loadRuns = useCallback(async (): Promise<void> => {
    if (!id) return;
    const ctrl = new AbortController();
    runsCtrlRef.current?.abort();
    runsCtrlRef.current = ctrl;
    try {
      const res = await listExtractions(id, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setExtractRuns(res.runs);
      setMaxPagesPerRun(res.maxPagesPerRun);
    } catch {
      // Best-effort — see the state comment above. The status strip is a
      // supplementary surface; a failed history read must not error the
      // whole viewer or brick the trigger.
    }
  }, [id]);

  // Seed the run history once the book is actually viewable (same gate as
  // the page <img> itself — a processing/failed upload can't be extracted,
  // and the GET 404s a foreign id anyway).
  useEffect(() => {
    if (!canView) return;
    void loadRuns();
    return () => {
      runsCtrlRef.current?.abort();
    };
  }, [canView, loadRuns]);

  // Abort a still-pending extract POST on unmount (the server-side run
  // continues and settles regardless — aborting only drops OUR wait on it;
  // the next visit's history read shows the settled result).
  useEffect(() => {
    return () => {
      extractCtrlRef.current?.abort();
    };
  }, []);

  const latestRun = extractRuns?.[0] ?? null;
  // A live run observed via GET (another tab / an orphan the stale-reap
  // hasn't settled yet) — the trigger must stay disabled, honestly.
  const runLive =
    latestRun !== null &&
    (latestRun.status === 'pending' || latestRun.status === 'running');

  const extract = useCallback(async (): Promise<void> => {
    if (!id || extracting) return;
    const ctrl = new AbortController();
    extractCtrlRef.current?.abort();
    extractCtrlRef.current = ctrl;
    setExtracting(true);
    setExtractError(null);
    try {
      // Body deliberately empty — the server's bounded resume-default slice
      // (module header §"OCR"); the response is the SETTLED run.
      const run = await startExtraction(id, ctrl.signal);
      if (ctrl.signal.aborted) return;
      // Prepend — keeps the local history in the GET's newest-first order.
      setExtractRuns((prev) => [run, ...(prev ?? [])]);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      if (err instanceof ApiError && err.code === 'canceled') return;
      setExtractError(extractErrorCopy(err));
      // A 409 means a run IS live server-side; a client TIMEOUT means one
      // MAY still be — the synchronous run keeps going after our 5-minute
      // wait expires (see EXTRACT_TIMEOUT_MS, services/uploads.ts). In both
      // cases re-read the history and AWAIT it, so a still-live run lands in
      // state BEFORE the `finally` clears `extracting` — `runLive` then
      // keeps the trigger honestly disabled (with the live strip + Refresh
      // visible) instead of offering a retry that's doomed to a 409.
      if (
        err instanceof ApiError &&
        (err.status === 409 || err.code === 'timeout')
      ) {
        await loadRuns();
      }
    } finally {
      if (!ctrl.signal.aborted) setExtracting(false);
    }
  }, [id, extracting, loadRuns]);

  return (
    <section
      className="screen km-upload-viewer km-rain-sheen"
      aria-labelledby="km-upload-viewer-title"
    >
      {/* F-024 — no single canonical parent (Uploads list OR the reader's
          scan deep-link), so history-back with a guarded /uploads fallback. */}
      <BackButton fallbackTo="/uploads" />

      {/* F-128 devices #4/#2 — the shared hub-header recipe (batch-2
          fix-pass BLOCKER-2, components/PageHubHeader.tsx). */}
      <PageHubHeader
        titleId="km-upload-viewer-title"
        eyebrow={<Bilingual en="View-only" kr="보기 전용" />}
        heading={title}
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
              ? // Server-authored, bounded, whitelisted copy (Phase 2.5 —
                // bookIngestRunner.ts's `failureMessage`) — safe to show
                // verbatim, same posture as story-audio/-image failures.
                // Falls back to fixed copy defensively (the field is
                // optional on the wire).
                (meta.error ?? 'This upload failed to process and has no viewable pages.')
              : 'Processing your book… this page will update automatically.'
          }
          onRetry={loadMeta}
        />
      ) : (
        <>
          {/* Guided-tour anchor: the whole view toolbar (jump/zoom/fit/
              rotate/reorder) is spotlit as one step. */}
          <div className="km-upload-viewer__toolbar" data-tour="viewer-zoom">
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

            {/* F-059 — the live OCR trigger (module header §"OCR"). Zero-
                config: the POST omits the page range, so the server's own
                bounded resume-default slice runs — never the whole book.
                Disabled while OUR POST is in flight (busy label) or while
                the latest known run is still live (cross-tab/orphan case —
                the server would 409 the tap anyway; disabling is the honest
                surface for the same fact). */}
            <Button
              variant="ghost"
              size="sm"
              data-tour="viewer-extract"
              onClick={() => {
                void extract();
              }}
              disabled={extracting || runLive}
              aria-busy={extracting}
              aria-label={
                runLive && !extracting
                  ? 'Extract text (an extraction is already running)'
                  : 'Extract text from this book'
              }
            >
              {extracting ? (
                <Bilingual en="Extracting…" kr="추출 중…" compact />
              ) : (
                <Bilingual en="Extract text" kr="텍스트 추출" compact />
              )}
            </Button>
          </div>

          {/* F-059 — extraction feedback: fixed-copy errors above, the
              latest run's status below. The status message lives in a
              `role="status"` live region that is ALWAYS rendered — empty
              until a run exists — because most SR/browser pairs only
              announce changes made INSIDE a pre-existing live region;
              mounting the region together with its first message would
              leave the first settled run of a session silent. Only the
              message text sits inside the region — the Refresh control and
              the page-ceiling hint are siblings, so region updates announce
              the status alone. */}
          {extractError !== null ? <ErrorCard message={extractError} /> : null}
          <div
            className={
              latestRun !== null
                ? 'km-upload-viewer__extract'
                : 'km-upload-viewer__extract km-upload-viewer__extract--idle'
            }
          >
            <span role="status" aria-label="Extraction status">
              {latestRun === null ? null : latestRun.status === 'done' ? (
                <Bilingual
                  en={doneRunCopy(latestRun).en}
                  kr={doneRunCopy(latestRun).kr}
                  compact
                />
              ) : latestRun.status === 'failed' ? (
                // Fixed copy — the run row carries a server-side `error`
                // string, but prose is never echoed (lib/errorCopy contract).
                <Bilingual
                  en="The last extraction failed. Try again."
                  kr="마지막 추출이 실패했어요. 다시 시도해 주세요."
                  compact
                />
              ) : (
                <Bilingual
                  en={`An extraction is running (pages ${String(latestRun.pageFrom)}–${String(latestRun.pageTo)})…`}
                  kr={`추출 진행 중 (${String(latestRun.pageFrom)}–${String(latestRun.pageTo)}쪽)…`}
                  compact
                />
              )}
            </span>
            {runLive ? (
              // Manual refresh instead of a poll loop — module header §"OCR"
              // has the rationale (runs settle inside the triggering request;
              // only cross-tab/orphan runs are ever observable here).
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void loadRuns();
                }}
                aria-label="Refresh extraction status"
              >
                <Bilingual en="Refresh status" kr="상태 새로 고침" compact />
              </Button>
            ) : null}
            {latestRun !== null && maxPagesPerRun !== null ? (
              <span className="km-upload-viewer__extract-hint">
                <Bilingual
                  en={`Each run scans up to ${String(maxPagesPerRun)} pages, continuing where the last one stopped.`}
                  kr={`한 번에 최대 ${String(maxPagesPerRun)}쪽씩, 지난 지점부터 이어서 스캔해요.`}
                  compact
                />
              </span>
            ) : null}
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

          {/* F-128 device #1/#2 — the "PDF signboard/paper" surface from the
              design mock: the page image sits on a CityCard, leading-edge
              rail included. */}
          <CityCard tone="plain" rail className="km-upload-viewer__card">
            <div
              className="km-upload-viewer__page"
              ref={attachPageBox}
              style={{ touchAction: swipeEligible ? 'pan-y' : 'auto' }}
              onPointerDown={onPagePointerDown}
              onPointerMove={onPagePointerMove}
              onPointerUp={onPagePointerUp}
              onPointerCancel={onPagePointerCancel}
              onPointerLeave={onPagePointerLeave}
              // Belt-and-braces, mirrors SwipeCarousel: if a captured 'h'
              // drag has its capture revoked externally, drop the gesture
              // rather than stranding `swipeDragX` mid-drag.
              onLostPointerCapture={onPagePointerLost}
            >
              <div
                className={`km-upload-viewer__page-drag${
                  swipeDragX !== null ? ' km-upload-viewer__page-drag--dragging' : ''
                }`}
                style={{ transform: `translateX(${String(swipeDragX ?? 0)}px)` }}
              >
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
            </div>
          </CityCard>

          {/* Task "arrows to the bottom": Prev/Next + the page-N-of-M readout
              used to live in the TOP toolbar above the page image — a real
              reach-stretch on a one-handed phone grip, and the whole reason
              the swipe gesture matters as a fallback. This bar is the
              thumb-reachable primary control, directly under the page
              (normal flow, not fixed-to-viewport: the app's own `BottomNav`
              already owns the true screen bottom — see `components/
              BottomNav.tsx` — so this sits just above it, not on top of it).
              Larger tap targets (`size="lg"`) than the top toolbar's dense
              utility buttons; still real `<button>`s, so Tab/Enter/Space
              keep working exactly as before. */}
          <div
            className="km-upload-viewer__pager"
            role="group"
            aria-label="Page navigation"
          >
            <Button
              variant="ghost"
              size="lg"
              onClick={goPrev}
              disabled={pageNum <= 1}
              aria-label="Previous page"
            >
              <Icon name="chevron-left" size={18} />
            </Button>
            <span className="km-resources__pager-count" aria-live="polite">
              {pageNum} / {pageCount}
            </span>
            <Button
              variant="ghost"
              size="lg"
              onClick={goNext}
              disabled={!pageCount || pageNum >= pageCount}
              aria-label="Next page"
            >
              <Icon name="chevron-right" size={18} />
            </Button>
          </div>
          <p className="km-upload-viewer__hint">
            <Bilingual
              en="Swipe or use the arrows to change page."
              kr="스와이프하거나 화살표로 페이지를 넘기세요."
              compact
            />
          </p>
        </>
      )}
    </section>
  );
}
