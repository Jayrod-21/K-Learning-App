/**
 * /images — OCR mining (Pass 8).
 *
 * Three surfaces, all behind the cookie session:
 *   POST /images/ocr      → upload one photo (multipart) → Claude Vision →
 *                            an `ImageCapture` (caption + detected words).
 *   GET  /images          → the user's capture history, newest first, WITHOUT
 *                            words (list view). Each summary's `blobUrl` is
 *                            derived as `/images/:id/blob`.
 *   GET  /images/:id      → a single capture WITH its detected words.
 *
 * Shape note: the server soft-deletes captures and stamps `created_at`; the
 * client domain type (`ImageCapture`) speaks `capturedAt`. The list summary
 * the server sends omits `words` (and `blobUrl` — the client derives it from
 * `id`), so `fetchImages` fills `words: []` and synthesises `blobUrl`. The
 * single-capture and upload responses carry `words` field-for-field. This
 * service is the one place that bridges wire ↔ domain so the screen stays on
 * the domain type.
 *
 * Threat model — what this client defends against, and what it relies on:
 *   - **Auth + session.** Every route is `requireAuth` + a limiter server-side;
 *     the session cookie rides via `withCredentials` on the shared axios
 *     instance. No bearer token is read or echoed from JS. The `<img src>` that
 *     consumes `blobUrl` is same-origin, so the cookie rides automatically.
 *   - **CSRF.** `uploadImage` is a state-changing POST → a CSRF surface,
 *     defended by the `SameSite=Strict` session cookie. If the cookie ever
 *     relaxes to `Lax` (e.g. OAuth callbacks), a CSRF double-submit token MUST
 *     be added at the api layer (see `services/api.ts`). The two GETs are
 *     read-only — no CSRF surface of their own.
 *   - **IDOR.** `image_captures` / `image_words` and the blob bytes are all
 *     user-scoped server-side via the session `user_id` (404 if not theirs),
 *     so a client cannot read another user's capture, words, or image
 *     regardless of the `id` it sends. `id` is interpolated into the path but
 *     only ever a value that originated from a prior server response; the
 *     server re-validates it and parameterises all SQL.
 *   - **Upload validation is server-authoritative.** The browser's `accept`
 *     filter and any client-side size check are convenience only — the server
 *     enforces the 8 MB cap, the jpeg/png/webp mime allowlist, AND a
 *     magic-byte sniff of the buffer (never trusting the client mime). The
 *     daily Vision cap (cost control) is enforced server-side and surfaces as
 *     a 429 `ApiError` the screen renders inline. We send the raw `File` and
 *     let those defences run; we do NOT pre-process or transcode the bytes.
 *   - **Multipart boundary.** `uploadImage` posts `FormData` and explicitly
 *     clears the per-request `Content-Type` so axios/the browser sets
 *     `multipart/form-data; boundary=…` itself. Setting it manually would emit
 *     a boundary-less header and the server's `multer` parser would reject the
 *     body — see `buildMultipartConfig` below.
 *   - **Rendered text is escaped.** Caption + every detected word renders as
 *     React children, so a malicious server payload becomes literal text, not
 *     markup. The `blobUrl` is built from the server `id` (digits), never
 *     interpolated from free-form text.
 *
 * Signal note: the optional `signal` lets a caller cancel an in-flight
 * request. `fetchImages` is consumed through `useEndpointOrMock` (no-arg
 * `realFn`, owns its own cancellation); `uploadImage` is called directly by
 * the screen, which may pass a signal to abort a slow Vision round-trip. The
 * param is kept on all three for symmetry and future direct callers.
 */
import type { AxiosRequestConfig } from 'axios';
import { api, getApiBaseUrl } from './api';
import type { ImageCapture, OcrWord } from '../types/domain';

/**
 * Raw single-word row as the server projects it (`ImageWordDTO` in
 * routes/images.ts): `kr/en/gloss/pos` ONLY — there is NO `id` on the wire
 * (`image_words` rows are projected without one). Matches `OcrWord`
 * field-for-field today; kept as a distinct wire interface so a future
 * server-side field rename is absorbed here, not leaked to the screen.
 */
interface ImageWordWire {
  kr: string;
  en: string;
  pos: OcrWord['pos'];
  gloss: string;
}

/** Raw single-capture body as `POST /images/ocr` and `GET /images/:id` send it. */
interface ImageCaptureWire {
  id: string;
  name: string;
  caption_kr: string;
  caption_en: string;
  words: ImageWordWire[];
  /** Server timestamp. Mapped onto the domain `capturedAt`. */
  createdAt: string;
}

/** Raw list-summary body as `GET /images` sends it — no `words`. */
interface ImageSummaryWire {
  id: string;
  name: string;
  caption_kr: string;
  caption_en: string;
  createdAt: string;
}

/** Envelope returned by `GET /images`. */
interface ImagesListEnvelope {
  captures: ImageSummaryWire[];
}

/** Envelope returned by `GET /images/:id` and `POST /images/ocr`. */
interface ImageCaptureEnvelope {
  capture: ImageCaptureWire;
}

/**
 * Build the URL to a capture's image bytes, joined onto the API base like
 * `ttmik.ts` does for audio (`buildAudioSrc`). In prod the base is '' →
 * same-origin relative path, so the session cookie rides automatically on
 * the `<img>` request. In dev (`VITE_API_URL=http://localhost:4000`, Vite on
 * :5173, no dev proxy) a bare relative path would resolve against :5173 and
 * the Vite SPA fallback would return HTML — every capture image broken — so
 * the API base MUST be joined here. `id` originates from the server
 * (digits), so this is injection-free.
 *
 * `base` is injectable for tests (mirrors `ttmik.ts` `buildAudioSrc`);
 * production callers use the default.
 */
export function blobUrlFor(id: string, base: string = getApiBaseUrl()): string {
  const path = `/images/${id}/blob`;
  return base === '' ? path : `${base}${path}`;
}

/** Map a full single-capture wire body (with words) onto the domain type. */
function toImageCapture(wire: ImageCaptureWire): ImageCapture {
  return {
    id: wire.id,
    name: wire.name,
    caption_kr: wire.caption_kr,
    caption_en: wire.caption_en,
    blobUrl: blobUrlFor(wire.id),
    // No `id` is mapped — the wire doesn't send one (see ImageWordWire).
    words: wire.words.map((w) => ({
      kr: w.kr,
      en: w.en,
      pos: w.pos,
      gloss: w.gloss,
    })),
    capturedAt: wire.createdAt,
  };
}

/** Map a list-summary wire body (no words) onto the domain type. */
function summaryToImageCapture(wire: ImageSummaryWire): ImageCapture {
  return {
    id: wire.id,
    name: wire.name,
    caption_kr: wire.caption_kr,
    caption_en: wire.caption_en,
    blobUrl: blobUrlFor(wire.id),
    // List view doesn't need the per-word detail — the words land on the
    // single-capture fetch the screen runs when it opens a capture. An empty
    // array keeps the domain type's `words` non-optional without lying about
    // count (the list view reads `caption`, not `words.length`).
    words: [],
    capturedAt: wire.createdAt,
  };
}

/**
 * Compose the per-request axios config for the multipart upload.
 *
 * Critically clears `Content-Type` (sets it to `undefined`) so axios strips
 * its JSON default and lets the browser set `multipart/form-data` WITH the
 * generated boundary. A manually-set `Content-Type` would omit the boundary
 * and the server's `multer` body parser would fail to find the file field.
 *
 * Exported for the other multipart caller (`uploadConversationImage` in
 * services/conversation.ts — image-in-chat, Slice 1) so the boundary-handling
 * subtlety lives in exactly one place.
 */
export function buildMultipartConfig(signal?: AbortSignal): AxiosRequestConfig {
  const config: AxiosRequestConfig = {
    // `undefined` is the documented axios escape hatch: the header default is
    // dropped for this request and the FormData boundary is set by the agent.
    headers: { 'Content-Type': undefined },
  };
  if (signal !== undefined) config.signal = signal;
  return config;
}

/**
 * POST /images/ocr — upload one photo for OCR mining.
 *
 * Sends the raw `File` as `multipart/form-data` under the `image` field and
 * returns the resulting `ImageCapture` (caption + detected words). Validation
 * (size / mime / magic bytes) and the per-user daily Vision cap are enforced
 * server-side; failures surface as `ApiError` (e.g. 400 bad file, 429 cap,
 * 502 Vision upstream) for the screen to render inline. A Vision failure does
 * NOT persist a half-capture server-side, so a retry is safe.
 */
export async function uploadImage(
  file: File,
  signal?: AbortSignal,
): Promise<ImageCapture> {
  const form = new FormData();
  // Third arg pins the filename so the server sees the original name for the
  // `original_filename` column; falling back to `file.name` keeps it honest.
  form.append('image', file, file.name);

  const res = await api.post<ImageCaptureEnvelope>(
    '/images/ocr',
    form,
    buildMultipartConfig(signal),
  );
  return toImageCapture(res.capture);
}

/**
 * GET /images — the user's capture history, newest first, without words.
 *
 * Unwraps the `{ captures }` envelope and maps each summary onto the domain
 * type, synthesising `blobUrl` from the id and leaving `words` empty (the list
 * view never reads them; opening a capture refetches via `fetchImage`).
 */
export async function fetchImages(signal?: AbortSignal): Promise<ImageCapture[]> {
  const res = await api.get<ImagesListEnvelope>(
    '/images',
    signal !== undefined ? { signal } : undefined,
  );
  return res.captures.map(summaryToImageCapture);
}

/**
 * GET /images/:id — a single capture with its detected words.
 *
 * Unwraps the `{ capture }` envelope and maps it onto the domain type. The
 * server scopes the lookup to the session user and 404s if the capture isn't
 * theirs; that surfaces as an `ApiError` for the caller to handle.
 */
export async function fetchImage(
  id: string,
  signal?: AbortSignal,
): Promise<ImageCapture> {
  const res = await api.get<ImageCaptureEnvelope>(
    `/images/${encodeURIComponent(id)}`,
    signal !== undefined ? { signal } : undefined,
  );
  return toImageCapture(res.capture);
}
