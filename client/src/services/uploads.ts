/**
 * /uploads — U1b client, PAGE-IMAGE book-upload feature (see
 * `db/docs/PDF_UPLOAD_DESIGN.md` §"REVISION" — authoritative). Talks to
 * U1a's reworked server routes: list, single-meta (incl. `page_count`),
 * multipart upload (zip-of-images OR PDF, normalized server-side into
 * ordered page images), delete, and the per-page image URL the viewer's
 * `<img>` pulls from. The old single-blob `GET /uploads/:id/file` (and this
 * module's `pdfFileUrl`) is REMOVED — a book is no longer one PDF blob, it's
 * an ordered sequence of page images (`book_pages`, migration 041).
 *
 * Threat model — mirrors `services/images.ts`'s posture (the design doc asks
 * U1a's server to reuse the images blob mechanism, and this client wiring
 * follows the same shape deliberately, not by accident):
 *   - Auth + session: every route is `requireAuth` server-side; the session
 *     cookie rides via `withCredentials` on the shared axios instance
 *     (services/api.ts) for the axios-driven calls (list/meta/upload/
 *     delete/reorder). The per-page `<img src={pageUrl(...)}>` is a plain
 *     same-origin image request, NOT axios — a browser always attaches
 *     same-origin cookies to an `<img>` load with no equivalent of
 *     `withCredentials` needed (that flag only matters for fetch/XHR, which
 *     is why the old pdf.js path needed it and this one doesn't).
 *   - CSRF: `uploadBook`/`deleteUpload`/`reorderPages` are state-changing
 *     POST/PATCH/DELETE → a CSRF surface, defended by the `SameSite=Strict`
 *     session cookie. The GETs (list/meta/page image) are read-only — no
 *     CSRF surface of their own.
 *   - IDOR: every row, page, and blob is scoped server-side to the session
 *     `user_id` (uniform 404 for "not mine" vs. "doesn't exist" —
 *     routes/uploads.ts). The client never has to reason about ownership; a
 *     foreign `id` or out-of-range page `n` just 404s and surfaces as an
 *     `ApiError`.
 *   - Upload validation is server-authoritative. `checkBookFile` below is a
 *     CONVENIENCE pre-check only — it saves the user a slow round-trip for
 *     an obviously-wrong file, but the server's ~300 MiB cap AND magic-byte
 *     (`PK\x03\x04` zip / `%PDF-` pdf) sniff are the real defence and run on
 *     every request regardless (never trusts the client-declared mime). We
 *     send the raw `File` and let those defences run; we do NOT pre-process
 *     or transcode the bytes.
 *   - Multipart boundary: `uploadBook` reuses `buildMultipartConfig` from
 *     services/images.ts (clears the per-request `Content-Type` so the
 *     browser sets `multipart/form-data; boundary=…` itself — see that
 *     module's header for why a manually-set Content-Type breaks multer).
 *   - The page viewer (pages/UploadViewer.tsx) renders VIEW-ONLY — a plain
 *     `<img>` bitmap, nothing selectable/editable/scriptable. Unlike the old
 *     pdf.js path there is no embedded-script surface to worry about at all:
 *     an image has no executable content, and the server sends
 *     `X-Content-Type-Options: nosniff` with a content-type derived from the
 *     stored extension (never client input), so the browser can't be
 *     tricked into rendering the bytes as anything other than an image.
 *
 * Signal note: every call takes an optional `AbortSignal` so callers (the
 * Uploads list, the upload modal, the viewer, the reorder tool) can cancel on
 * unmount — mirrors every other service in this module.
 *
 * KNOWN CROSS-AGENT CONTRACT GAP (flag, do not silently paper over): the
 * reorder tool's `PATCH /uploads/:id/pages/order` requires the FULL current
 * set of `book_pages.id` values (routes/uploads.ts validates the submitted
 * set matches exactly). As of the committed server rework (commit
 * `82ea4c2`), no route returns that id list — `GET /uploads/:id` returns
 * only `page_count`, and `GET /uploads/:id/page/:n` returns image bytes, not
 * an id. `listPages` below calls `GET /uploads/:id/pages`, which does NOT
 * exist on that server commit — this is a genuine, unresolved dependency on
 * the parallel server work (out of scope for this client-only pass to add).
 * Until the server exposes an equivalent page-id-list route, the reorder
 * tool's initial load will 404 in the running app even though this client
 * code, the reorder UI, and its tests are otherwise complete and correct
 * against the documented `page_ids` contract.
 */
import { api, getApiBaseUrl } from './api';
import { buildMultipartConfig } from './images';
import type { BookUpload, BookUploadType, Page } from '../types/domain';

/**
 * Max upload size the client pre-checks before ever touching the network —
 * mirrors the server's ~300 MiB cap (server/src/services/bookUploadIngest.ts,
 * bumped from the old ~15 MiB single-PDF cap now that a vFlat zip export of a
 * full scanned book can run ~200-300 MB). The server remains authoritative;
 * this only avoids a doomed slow upload.
 */
export const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

/** Wire shape of one upload row — `BookUploadDTO` in server/src/routes/uploads.ts. */
interface BookUploadWire {
  id: string;
  title: string;
  type: BookUploadType;
  status: BookUpload['status'];
  page_count: number | null;
  byte_size: number;
  created_at: string;
}

/** Envelope returned by `GET /uploads/:id` and `POST /uploads`. */
interface UploadEnvelope {
  upload: BookUploadWire;
}

/** Envelope returned by `GET /uploads`. */
interface UploadsListEnvelope {
  uploads: BookUploadWire[];
}

/** One page's identity within an upload, as the reorder/list-pages wire shape represents it. */
interface PageWire {
  id: string;
  page_number: number;
}

/** Envelope shape for both the (assumed) page-list GET and the reorder PATCH response. */
interface PagesEnvelope {
  pages: PageWire[];
}

function toBookUpload(wire: BookUploadWire): BookUpload {
  return {
    id: wire.id,
    title: wire.title,
    type: wire.type,
    status: wire.status,
    ...(wire.page_count !== null ? { pageCount: wire.page_count } : {}),
    byteSize: wire.byte_size,
    createdAt: wire.created_at,
  };
}

function toPage(wire: PageWire): Page {
  return { id: wire.id, pageNumber: wire.page_number };
}

/**
 * Build the URL to page `n`'s image bytes (1-based, matches
 * `GET /uploads/:id/page/:n`). Joined onto the API base like
 * `services/images.ts`'s `blobUrlFor` does for image blobs. In prod the base
 * is `''` (same-origin reverse proxy), so an `<img src>` pointed at this URL
 * sends the session cookie automatically — no `withCredentials` needed (that
 * flag only applies to fetch/XHR, not native `<img>` loads). In dev
 * (`VITE_API_URL` set, no dev proxy) the base MUST be joined or the request
 * resolves against the Vite dev server and gets the SPA fallback instead of
 * the page bytes. `id` and `n` always originate from a prior server response
 * or a bounded page-count loop — never client free-form text — so this is
 * injection-free.
 */
export function pageUrl(id: string, n: number, base: string = getApiBaseUrl()): string {
  const path = `/uploads/${encodeURIComponent(id)}/page/${String(n)}`;
  return base === '' ? path : `${base}${path}`;
}

/** GET /uploads — this user's uploads, newest first. */
export async function listUploads(signal?: AbortSignal): Promise<BookUpload[]> {
  const res = await api.get<UploadsListEnvelope>(
    '/uploads',
    signal !== undefined ? { signal } : undefined,
  );
  return res.uploads.map(toBookUpload);
}

/** GET /uploads/:id — one upload's metadata, including `pageCount` once the
 *  book has been normalized into pages (synchronous at ingest — see the
 *  design doc's REVISION; `pageCount` is present as soon as `status` is
 *  `ready`). 404s (as `ApiError`) if it isn't the caller's. */
export async function getUpload(
  id: string,
  signal?: AbortSignal,
): Promise<BookUpload> {
  const res = await api.get<UploadEnvelope>(
    `/uploads/${encodeURIComponent(id)}`,
    signal !== undefined ? { signal } : undefined,
  );
  return toBookUpload(res.upload);
}

/**
 * GET /uploads/:id/pages — the full ordered list of `{ id, pageNumber }`
 * pairs, needed by the reorder tool to submit a valid full-order PATCH (the
 * server validates the submitted id set against the upload's CURRENT id set
 * exactly — a partial or stale list is rejected). See this module's header
 * for the KNOWN CROSS-AGENT CONTRACT GAP: this route is not present on the
 * server commit this client was built against.
 */
export async function listPages(id: string, signal?: AbortSignal): Promise<Page[]> {
  const res = await api.get<PagesEnvelope>(
    `/uploads/${encodeURIComponent(id)}/pages`,
    signal !== undefined ? { signal } : undefined,
  );
  return res.pages.map(toPage);
}

/**
 * PATCH /uploads/:id/pages/order — submit the FULL new page order as an
 * ordered array of page ids (position in the array = new 1-based
 * `pageNumber`). Returns the server's resulting order (should echo the
 * submitted order; the caller reconciles against this rather than assuming).
 * `orderedPageIds[i]` is converted to a number for the wire body (mirrors
 * how every other id already crosses this boundary as a path param —
 * `IdParamsSchema`/`PageOrderBodySchema` both `z.coerce.number()` — safe at
 * this app's scale, ids never approach `Number.MAX_SAFE_INTEGER`).
 */
export async function reorderPages(
  id: string,
  orderedPageIds: readonly string[],
  signal?: AbortSignal,
): Promise<Page[]> {
  const res = await api.patch<PagesEnvelope>(
    `/uploads/${encodeURIComponent(id)}/pages/order`,
    { page_ids: orderedPageIds.map((pid) => Number(pid)) },
    signal !== undefined ? { signal } : undefined,
  );
  return res.pages.map(toPage);
}

/**
 * POST /uploads — upload a zip-of-page-images or a PDF (multipart `file` +
 * `title` + `type`). Idempotent replace server-side: re-uploading the same
 * (user, title) pair replaces the whole page set rather than creating a
 * duplicate.
 */
export async function uploadBook(
  file: File,
  type: BookUploadType,
  title: string,
  signal?: AbortSignal,
): Promise<BookUpload> {
  const form = new FormData();
  // Third arg pins the filename, matching `uploadImage`'s convention.
  form.append('file', file, file.name);
  form.append('title', title);
  form.append('type', type);

  const res = await api.post<UploadEnvelope>(
    '/uploads',
    form,
    buildMultipartConfig(signal),
  );
  return toBookUpload(res.upload);
}

/** DELETE /uploads/:id — removes the row + every page's blob (server: 204, best-effort blob cleanup). */
export async function deleteUpload(id: string, signal?: AbortSignal): Promise<void> {
  await api.delete<void>(
    `/uploads/${encodeURIComponent(id)}`,
    signal !== undefined ? { signal } : undefined,
  );
}

/**
 * Client-side pre-check ONLY — see the module threat model above. Returns
 * fixed copy to show inline BEFORE ever hitting the network for an
 * obviously-wrong file; returns `null` when the file passes the (loose)
 * client check. The server's magic-byte sniff + size cap are the real
 * authority and still run on every request regardless of this result.
 * Accepts EITHER a zip (vFlat page-image export) or a PDF — the server
 * normalizes either into ordered page images (design doc REVISION).
 */
export function checkBookFile(file: File): string | null {
  const name = file.name.toLowerCase();
  const looksLikePdf = file.type === 'application/pdf' || name.endsWith('.pdf');
  const looksLikeZip =
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed' ||
    name.endsWith('.zip');
  if (!looksLikePdf && !looksLikeZip) {
    return 'That file isn’t a PDF or a zip. Choose a .pdf or .zip file.';
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return 'That file is too large. Pick one under 300 MB.';
  }
  return null;
}
