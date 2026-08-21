/**
 * API client.
 *
 * Talks to the Express server (ADR-002 cookie sessions). All requests carry
 * the session cookie via `withCredentials: true`. No bearer token interceptor
 * — the cookie is `HttpOnly` and never visible to JS.
 *
 * Deploy contract (locked) — see `client/SECURITY.md` §1, §2:
 *   The production deploy MUST be **same-origin**: a reverse proxy in front
 *   of the server routes `/auth/*`, `/vocab/*`, etc. on the same hostname the
 *   SPA is served from. `VITE_API_URL` is therefore the empty string in prod
 *   (`baseURL: ''` → axios uses the page origin). The dev override
 *   (`http://localhost:4000` paired with Vite on `localhost:5173`) is still
 *   same-site because cookie *site* is eTLD+1 (`localhost`), so
 *   `SameSite=Strict` works in dev.
 *
 *   Shipping a cross-site `VITE_API_URL` in prod (e.g. `api.example.com` from
 *   `app.example.com`) silently breaks every authenticated request: the
 *   `Set-Cookie` lands on the response, but `SameSite=Strict` then forbids
 *   the browser from sending it on the next request. The dev-mode warning
 *   below is the runtime tripwire; the production posture is locked by
 *   keeping `VITE_API_URL` empty.
 *
 *   If we ever need a cross-origin deploy (OAuth callbacks, multi-team
 *   subdomains), ADR-002 D3/D4 must be reopened: cookies relax to
 *   `SameSite=Lax` or `None; Secure`, and a CSRF double-submit token is
 *   added at this layer.
 *
 * Threat model — what this client defends against, and what it relies on:
 *   - CSRF: the session cookie is set by the server as `SameSite=Strict`, so
 *     the browser refuses to attach it to cross-site requests. This module
 *     does NOT need to send an `X-CSRF-Token` header. If the cookie is ever
 *     loosened to `SameSite=Lax` (e.g. to support OAuth callbacks), a CSRF
 *     token MUST be added here at the same time.
 *   - Token theft via XSS: the cookie is `HttpOnly`, so a successful XSS
 *     cannot exfiltrate the session. That's why we resist any temptation to
 *     read or echo the token from JS.
 *   - Session hijack via mixed content: the cookie is `Secure` in prod, so it
 *     never rides plaintext HTTP. The dev origin must be HTTPS or `localhost`
 *     (Chrome treats localhost as secure).
 *   - Open-redirect on logout: logout returns 204, the client never follows a
 *     redirect from this layer.
 *   - Error info leakage: domain errors (`{ error: { code, message } }`) are
 *     surfaced as `ApiError`. Network/parse errors are normalised to a single
 *     `ApiError` (with discriminated `code`: `timeout` | `canceled` |
 *     `network`) so call sites don't have to branch across axios internals.
 */
import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
} from 'axios';

/** Domain error surfaced to callers. */
export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  /**
   * Seconds until a rate-limited / locked-out operation may be retried, when the
   * server supplies it (e.g. the 423 `account_locked` lockout body carries
   * `{ error: { code: 'account_locked', retry_after } }`). `undefined` when the
   * server did not provide one. This is a STRUCTURED NUMERIC field — not echoed
   * server prose — so surfacing it does not violate the fixed-error-string rule.
   */
  public readonly retryAfter?: number;
  /**
   * Assistant text recovered from a stream whose persistence failed AFTER the
   * reply fully streamed (the server's `persistence_error` SSE frame carries
   * it as `recovered_text` — see services/conversation.ts). Present ONLY on
   * that failure; consumers can offer the recovered reply instead of
   * discarding a full Claude turn. This is model output the user already
   * watched stream in, not server error prose.
   */
  public readonly recoveredText?: string;

  public constructor(
    message: string,
    opts: {
      status: number;
      code: string;
      retryAfter?: number;
      recoveredText?: string;
    },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.retryAfter = opts.retryAfter;
    this.recoveredText = opts.recoveredText;
  }
}

interface ServerErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    retry_after?: unknown;
  };
}

function isServerErrorBody(value: unknown): value is ServerErrorBody {
  return typeof value === 'object' && value !== null && 'error' in value;
}

function normaliseError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof AxiosError) {
    const status = err.response?.status ?? 0;
    const body: unknown = err.response?.data;
    if (isServerErrorBody(body) && body.error) {
      const code =
        typeof body.error.code === 'string' ? body.error.code : 'server_error';
      const message =
        typeof body.error.message === 'string'
          ? body.error.message
          : err.message;
      // Preserve a structured numeric `retry_after` (seconds) when present — the
      // 423 lockout body carries it so the UI can render "wait N minutes" with a
      // real N. Only accept a finite positive number; anything else is dropped.
      const retryAfterRaw = body.error.retry_after;
      const retryAfter =
        typeof retryAfterRaw === 'number' && Number.isFinite(retryAfterRaw) && retryAfterRaw > 0
          ? retryAfterRaw
          : undefined;
      return new ApiError(message, { status, code, retryAfter });
    }
    if (status === 0) {
      // Discriminate the three "no response" cases — axios collapses them
      // into a single AxiosError with `response === undefined`, but the
      // user-facing message and the right retry policy differ:
      //   - `ECONNABORTED`: server reachable but didn't answer in time.
      //   - `ERR_CANCELED`: caller aborted via `AbortController` (e.g. a
      //     re-entrant probe, an unmount). Callers usually want to swallow.
      //   - anything else: actual network failure / CORS preflight reject /
      //     DNS / TLS — call it "network".
      if (err.code === 'ECONNABORTED') {
        return new ApiError('request timed out', {
          status: 0,
          code: 'timeout',
        });
      }
      if (err.code === 'ERR_CANCELED') {
        return new ApiError('request canceled', {
          status: 0,
          code: 'canceled',
        });
      }
      return new ApiError('network unreachable', {
        status: 0,
        code: 'network',
      });
    }
    return new ApiError(err.message, { status, code: 'http_error' });
  }
  if (err instanceof Error) {
    return new ApiError(err.message, { status: 0, code: 'unknown' });
  }
  return new ApiError('unknown error', { status: 0, code: 'unknown' });
}

/** Base URL of the API server. Empty string means same-origin. */
const baseURL: string = import.meta.env.VITE_API_URL ?? '';

/**
 * Resolve the API base URL — the single source of truth for every surface
 * that needs to talk to the server. The axios instance below uses this, and
 * fetch-based callers (e.g. `services/sseStream.ts` consumers) MUST import
 * this helper instead of re-reading `VITE_API_URL` directly so:
 *   1. The dev-mode cross-origin tripwire (below) fires uniformly.
 *   2. Future relocations of the env knob (e.g. runtime config) need to
 *      change one place, not every caller.
 *
 * Returns the empty string in same-origin deployments — callers should treat
 * a falsy result as "use page origin" and concatenate the path with no
 * leading slash on the base.
 */
export function getApiBaseUrl(): string {
  return baseURL;
}

/**
 * Dev-mode tripwire for the cross-origin cookie posture documented above.
 *
 * Triggers when:
 *   1. The bundle was built with a non-empty `VITE_API_URL` (cross-origin in
 *      use), AND
 *   2. The host is not `localhost` / `127.0.0.1` / `[::1]` (the only hosts
 *      Chrome exempts from the `Secure` requirement for `SameSite` cookies),
 *      AND
 *   3. The page is served over plain HTTP.
 *
 * In that combination, Chrome silently drops the session cookie on every
 * request — login appears to work (cookie lands on the response) but every
 * subsequent request 401s. Surfacing this loudly in the console is cheap
 * insurance against the "works on my machine" failure mode this fix-pass is
 * designed to prevent. Skipped under `import.meta.env.PROD` so it never ships
 * to end-users in a built bundle.
 */
function warnInsecureCrossOriginCookiePosture(): void {
  if (typeof window === 'undefined') return;
  if (import.meta.env.PROD) return;
  if (baseURL === '') return;

  let apiHostname: string;
  try {
    apiHostname = new URL(baseURL, window.location.href).hostname;
  } catch {
    return;
  }
  const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  if (LOOPBACK.has(apiHostname)) return;
  if (window.location.protocol === 'https:') return;

  console.warn(
    '[api] VITE_API_URL points to a non-loopback host over HTTP. ' +
      'The session cookie is `Secure`+`SameSite=Strict` in prod and may be ' +
      'silently dropped by the browser. Use empty `VITE_API_URL` (same-origin ' +
      'reverse proxy) for production. See client/SECURITY.md §2.',
  );
}
warnInsecureCrossOriginCookiePosture();

const instance: AxiosInstance = axios.create({
  baseURL,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
  // 10 s is a **request-level** timeout in axios (time-to-completion of the
  // whole request, not idle-timeout between bytes). This default is sized for
  // synchronous JSON endpoints. Routes that wrap Claude (e.g. `/enrich`,
  // `/conversation/*/messages`, future streaming endpoints) MUST pass their
  // own `timeout` per call; otherwise a cold Claude start will surface as a
  // misleading `ECONNABORTED` "timeout" error here. SECURITY.md §10 tracks
  // the per-call override pattern in the Deferred section.
  timeout: 10_000,
});

/**
 * Timeout (ms) for synchronous endpoints that block the response on a FULL
 * Claude authoring pass — story generation, passage translation, and
 * comprehension-question generation. These routes hold the connection open
 * until the model finishes (typically 15–60 s), which far exceeds the 10 s
 * default above; without a per-call override the client aborts mid-generation
 * and shows a misleading "request timed out" even though the server usually
 * completes and persists the result. Callers pass `{ timeout:
 * GENERATION_TIMEOUT_MS }`.
 *
 * Upstream ceilings to keep in mind: the load balancer's nginx
 * `proxy_read_timeout` is set ABOVE this (210 s) so the client is the first to
 * give up; requests reaching the origin through Cloudflare (the public domain)
 * are additionally capped at Cloudflare's ~100 s edge limit regardless of this
 * value — real generations finish well within that, but a pathological >100 s
 * generation would need an async enqueue-and-poll flow (as images/audio use).
 */
export const GENERATION_TIMEOUT_MS = 200_000;

/**
 * Thin wrapper that strips axios internals from call sites and always raises
 * `ApiError` on failure. Returns the JSON body directly.
 */
export async function apiRequest<T>(config: AxiosRequestConfig): Promise<T> {
  try {
    const res = await instance.request<T>(config);
    return res.data;
  } catch (err) {
    throw normaliseError(err);
  }
}

export const api = {
  get: <T>(url: string, config?: AxiosRequestConfig): Promise<T> =>
    apiRequest<T>({ ...config, method: 'GET', url }),
  post: <T>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<T> => apiRequest<T>({ ...config, method: 'POST', url, data }),
  put: <T>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<T> => apiRequest<T>({ ...config, method: 'PUT', url, data }),
  patch: <T>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<T> => apiRequest<T>({ ...config, method: 'PATCH', url, data }),
  delete: <T>(url: string, config?: AxiosRequestConfig): Promise<T> =>
    apiRequest<T>({ ...config, method: 'DELETE', url }),
};

export default api;
