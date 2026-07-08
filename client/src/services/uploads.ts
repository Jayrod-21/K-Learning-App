/**
 * /uploads — U1b client, PDF book-upload feature (see
 * `db/docs/PDF_UPLOAD_DESIGN.md` §"U1 → U1b client"). Talks to U1a's server
 * routes: list, single-meta, multipart upload, delete, and the streamed PDF
 * file URL the viewer's `<canvas>` render pulls from.
 *
 * Threat model — mirrors `services/images.ts`'s posture (the design doc asks
 * U1a's server to reuse the images blob mechanism, and this client wiring
 * follows the same shape deliberately, not by accident):
 *   - Auth + session: every route is `requireAuth` server-side; the session
 *     cookie rides via `withCredentials` on the shared axios instance
 *     (services/api.ts). No bearer token ever touches JS.
 *   - CSRF: `uploadBook`/`deleteUpload` are state-changing POST/DELETE → a
 *     CSRF surface, defended by the `SameSite=Strict` session cookie. The
 *     two GETs are read-only — no CSRF surface of their own.
 *   - IDOR: every row and the blob bytes are scoped server-side to the
 *     session `user_id` (uniform 404 for "not mine" vs. "doesn't exist" —
 *     routes/uploads.ts). The client never has to reason about ownership; a
 *     foreign `id` just 404s and surfaces as an `ApiError`.
 *   - Upload validation is server-authoritative. `checkPdfFile` below is a
 *     CONVENIENCE pre-check only — it saves the user a slow round-trip for
 *     an obviously-wrong file, but the server's ~15 MiB cap AND magic-byte
 *     (`%PDF-`) sniff are the real defence and run on every request
 *     regardless (never trusts the client-declared mime/extension). We send
 *     the raw `File` and let those defences run; we do NOT pre-process or
 *     transcode the bytes.
 *   - Multipart boundary: `uploadBook` reuses `buildMultipartConfig` from
 *     services/images.ts (clears the per-request `Content-Type` so the
 *     browser sets `multipart/form-data; boundary=…` itself — see that
 *     module's header for why a manually-set Content-Type breaks multer).
 *   - The PDF viewer (pages/UploadViewer.tsx) renders VIEW-ONLY — no text or
 *     annotation layer is mounted, only the page's `<canvas>` bitmap — so a
 *     hostile scanned PDF has nothing to select/edit, and pdf.js's default
 *     `isEvalSupported: false` posture (never overridden here) keeps any
 *     PDF-embedded JavaScript from running.
 *
 * Signal note: every call takes an optional `AbortSignal` so callers (the
 * Uploads list, the upload modal, the type popup) can cancel on unmount —
 * mirrors every other service in this module.
 */
import { api, getApiBaseUrl } from './api';
import { buildMultipartConfig } from './images';
import type { BookUpload, BookUploadType } from '../types/domain';

/**
 * Max upload size the client pre-checks before ever touching the network —
 * mirrors the server's ~15 MiB cap (server/src/services/bookUploadIngest.ts).
 * The server remains authoritative; this only avoids a doomed slow upload.
 */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

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

/**
 * Build the URL to an upload's PDF bytes, joined onto the API base like
 * `services/images.ts`'s `blobUrlFor` does for image blobs and
 * `services/ttmik.ts` does for audio. In prod the base is `''` (same-origin
 * reverse proxy), so the session cookie rides automatically; in dev
 * (`VITE_API_URL` set, no dev proxy) the base MUST be joined or the request
 * resolves against the Vite dev server and gets the SPA fallback instead of
 * the PDF bytes. `id` always originates from a prior server response
 * (digits) — never client free-form text — so this is injection-free.
 */
export function pdfFileUrl(id: string, base: string = getApiBaseUrl()): string {
  const path = `/uploads/${id}/file`;
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

/** GET /uploads/:id — one upload's metadata. 404s (as `ApiError`) if it isn't the caller's. */
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
 * POST /uploads — upload a PDF (multipart `file` + `title` + `type`).
 * Idempotent replace server-side: re-uploading the same (user, title) pair
 * replaces the blob + row rather than creating a duplicate.
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

/** DELETE /uploads/:id — removes the row + its blob (server: 204, best-effort blob cleanup). */
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
 */
export function checkPdfFile(file: File): string | null {
  const looksLikePdf =
    file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!looksLikePdf) {
    return 'That file isn’t a PDF. Choose a .pdf file.';
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return 'That PDF is too large. Pick one under 15 MB.';
  }
  return null;
}
