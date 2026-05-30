/**
 * /conversation — AI tutor sessions (Claude).
 *
 * Threat model:
 *   - Auth required. Server scopes by user; client cannot forge a target.
 *   - Optimistic concurrency: `appendMessage` sends `expected_version`. A
 *     409 means a concurrent reader-or-writer updated the row; UI must
 *     refresh the conversation and replay.
 *   - SSE streaming: `streamMessage` carries the cookie via
 *     `credentials: 'include'`. Same-origin posture in prod (see
 *     `services/api.ts` header) — cross-origin SSE doesn't work with
 *     SameSite=Strict cookies.
 *   - Expensive bucket on the server. Repeated streaming starts are rate-
 *     limited per user; UI should disable the send button while a stream
 *     is in-flight.
 *   - Cancellation: every streaming caller must pass an `AbortSignal`.
 *     Dropping the controller without abort holds the TCP connection open
 *     until server EOF; a leaky tab is a resource hog.
 *
 * P3A note: `streamMessage` targets the streaming endpoint that lands with
 * P3A — either `/conversation/:id/messages/stream` or
 * `/conversation/:id/messages?stream=1` (P3A picks one). Default is the
 * dedicated `/stream` path; pass `streamPath: 'query'` to use the query
 * flag instead.
 */
import { ApiError, api, getApiBaseUrl } from './api';
import { streamSse, type SseEvent } from './sseStream';
import type {
  AppendMessageBody,
  AppendMessageResult,
  ConversationsList,
  StartConversationBody,
  StartConversationResult,
} from '../types/domain';

/** POST /conversation — start a new session. */
export async function startConversation(
  body: StartConversationBody,
): Promise<StartConversationResult> {
  return api.post<StartConversationResult>('/conversation', body);
}

/** POST /conversation/:id/messages — non-streaming append. */
export async function appendMessage(
  conversationId: number,
  body: AppendMessageBody,
): Promise<AppendMessageResult> {
  return api.post<AppendMessageResult>(
    `/conversation/${String(conversationId)}/messages`,
    body,
  );
}

/** GET /conversation — recent sessions for the current user. */
export async function listConversations(): Promise<ConversationsList> {
  return api.get<ConversationsList>('/conversation');
}

/** Options for `streamMessage`. */
export interface StreamMessageOptions {
  /** Required — caller's abort handle. */
  signal: AbortSignal;
  /** Fires for every assistant delta (`event: delta`, `data: <chunk>`). */
  onDelta: (chunk: string) => void;
  /** Fires once when the server closes the stream cleanly. */
  onDone?: () => void;
  /**
   * Fires on any error (transport, HTTP, parse, or in-band `event: error`)
   * AT MOST ONCE per stream. An in-band error frame is treated as terminal:
   * onError fires with an `ApiError` whose `code === 'stream_error'`, the
   * read loop is aborted, and the subsequent transport rejection is
   * suppressed so consumers don't see a double-fire. Transport errors
   * surface as `ApiError` with `code` in `network | timeout | canceled |
   * stream_parse | http_error | server_error`.
   */
  onError?: (err: ApiError) => void;
  /**
   * Which streaming endpoint shape the server exposes. Defaults to a
   * dedicated `/stream` suffix; pass `'query'` to use `?stream=1` instead.
   */
  streamPath?: 'suffix' | 'query';
  /**
   * Optional caller-generated id (UUID) forwarded as `X-Request-Id`. Lets
   * the server short-circuit a retried streaming turn back to the already-
   * persisted assistant reply instead of running a second Claude call (see
   * server route §"Idempotency-by-request-id"). Callers should generate one
   * via `crypto.randomUUID()` per user submit and reuse it on retry of the
   * same turn — never on a different turn.
   */
  requestId?: string;
}

/**
 * POST /conversation/:id/messages/stream — SSE streaming append.
 *
 * Event protocol (P3A contract):
 *   - `event: delta`  `data: <chunk>`     — incremental assistant text
 *   - `event: done`   `data: <final json>` — terminal envelope
 *   - `event: error`  `data: <json>`       — server-side failure mid-stream
 *
 * Unknown events are ignored so the protocol can grow without breaking
 * old clients.
 */
export async function streamMessage(
  conversationId: number,
  body: AppendMessageBody,
  opts: StreamMessageOptions,
): Promise<void> {
  const path =
    opts.streamPath === 'query'
      ? `/conversation/${String(conversationId)}/messages?stream=1`
      : `/conversation/${String(conversationId)}/messages/stream`;

  // Single source of truth — see `services/api.ts` for the cross-origin
  // tripwire that fires on `VITE_API_URL` misconfiguration.
  const base = getApiBaseUrl();
  const url = base === '' ? path : `${base}${path}`;

  // SF-2 contract: an in-band `event: error` SSE frame is terminal. We fire
  // onError ONCE and abort the stream so sseStream's transport-error path
  // doesn't ALSO call onError. The local controller chains the caller's
  // signal so external aborts still work, but we own a private abort lever
  // for the terminal-error path.
  const localCtrl = new AbortController();
  const forwardAbort = (): void => {
    localCtrl.abort();
  };
  if (opts.signal.aborted) {
    localCtrl.abort();
  } else {
    opts.signal.addEventListener('abort', forwardAbort, { once: true });
  }

  let errorFired = false;
  const fireErrorOnce = (err: ApiError): void => {
    if (errorFired) return;
    errorFired = true;
    opts.onError?.(err);
  };

  try {
    await streamSse(
      url,
      {
        onEvent: (ev: SseEvent): void => {
          if (ev.event === 'delta') {
            opts.onDelta(ev.data);
          } else if (ev.event === 'error') {
            // Terminal in-band error: fire onError once with an ApiError,
            // then abort so sseStream's loop exits and its own onError path
            // doesn't fire a SECOND time on the same logical failure.
            const apiErr = new ApiError(ev.data || 'stream error', {
              status: 0,
              code: 'stream_error',
            });
            fireErrorOnce(apiErr);
            localCtrl.abort();
          }
          // `done` is signalled by stream EOF + onDone callback below.
        },
        onDone: opts.onDone,
        // Transport / parse errors come through here. We dedupe so an
        // in-band error followed by sseStream's canceled-rejection doesn't
        // double-fire from the consumer's perspective.
        onError: (err) => {
          fireErrorOnce(err);
        },
      },
      {
        signal: localCtrl.signal,
        body,
        method: 'POST',
        headers: opts.requestId
          ? { 'X-Request-Id': opts.requestId }
          : undefined,
      },
    );
  } finally {
    opts.signal.removeEventListener('abort', forwardAbort);
  }
}
