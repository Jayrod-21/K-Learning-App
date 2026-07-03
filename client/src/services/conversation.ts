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
  /**
   * Fires for every assistant delta frame
   * (`data: {"event":"delta","text":<chunk>}`) with the chunk text.
   */
  onDelta: (chunk: string) => void;
  /** Fires once when the server closes the stream cleanly. */
  onDone?: () => void;
  /**
   * Fires on any error (transport, HTTP, parse, or in-band error frame)
   * AT MOST ONCE per stream. An in-band `{"event":"error"}` frame is
   * treated as terminal: onError fires with an `ApiError` carrying the
   * server's `code` (fallback `'stream_error'`), the read loop is aborted,
   * and the promise REJECTS with that same error (not the synthetic
   * `canceled` from the internal abort) so callers' catch paths see the
   * real failure. Transport errors surface as `ApiError` with `code` in
   * `network | timeout | canceled | stream_parse | http_error |
   * server_error`.
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
 * Wire protocol (matches `server/src/routes/conversation.ts`
 * `writeSseFrame`): the server emits DATA-ONLY SSE frames — every frame is
 * `data: <json>\n\n` with the discriminator INSIDE the JSON payload; it
 * never writes an SSE-level `event:` line, so the SSE-level event name is
 * always the spec default `'message'`. The inner `.event` field is the
 * protocol:
 *   - `{"event":"start","register":…}`                     — session opener
 *   - `{"event":"delta","text":…}`                          — assistant text
 *   - `{"event":"error","code":…,"message":…}`             — terminal error
 *   - `{"event":"done","version":…,"messages":…}`          — terminal
 *     envelope, immediately followed by EOF (which fires `onDone`)
 *
 * Unknown inner events are ignored so the protocol can grow without
 * breaking old clients. A frame that is not a JSON object or lacks a
 * string `event` field is a wire-shape violation and fails the stream
 * loudly (`stream_parse`) — silently dropping frames is exactly the
 * failure mode of bug B-010.
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

  // Set when an in-band terminal `error` frame (or a malformed frame)
  // arrives. The private abort makes `streamSse` reject with a synthetic
  // `canceled` ApiError; we rethrow THIS error instead so the caller's
  // catch sees the real failure — consumers treat a `canceled` rejection
  // as the silent unmount path (see Chat.tsx), which would swallow the
  // error entirely (B-010's "no error surfaces" half).
  let terminalError: ApiError | null = null;
  const failStream = (err: ApiError): void => {
    terminalError = err;
    fireErrorOnce(err);
    // Abort so sseStream's loop exits and its own onError path doesn't
    // fire a SECOND time on the same logical failure (deduped anyway).
    localCtrl.abort();
  };

  try {
    await streamSse(
      url,
      {
        onEvent: (ev: SseEvent): void => {
          // Frames may still drain from the parser's buffer after a
          // terminal in-band error aborted the stream — drop them.
          if (terminalError) return;
          // B-010 fix: dispatch on the INNER `.event` discriminator of the
          // data-only frame, not the SSE-level `ev.event` (which is always
          // 'message' because the server never writes `event:` lines).
          const frame = parseFramePayload(ev.data);
          if (frame === null || typeof frame.event !== 'string') {
            // Wire-shape violation — fail loud rather than render a
            // silently empty tutor turn.
            failStream(
              new ApiError('malformed stream frame', {
                status: 0,
                code: 'stream_parse',
              }),
            );
            return;
          }
          switch (frame.event) {
            case 'delta': {
              if (typeof frame.text !== 'string') {
                failStream(
                  new ApiError('delta frame missing text', {
                    status: 0,
                    code: 'stream_parse',
                  }),
                );
                return;
              }
              opts.onDelta(frame.text);
              return;
            }
            case 'error': {
              // Terminal in-band error. Carry the server's code/message
              // through so the UI can render an actionable failure.
              const message =
                typeof frame.message === 'string' && frame.message !== ''
                  ? frame.message
                  : 'stream error';
              const code =
                typeof frame.code === 'string' && frame.code !== ''
                  ? frame.code
                  : 'stream_error';
              failStream(new ApiError(message, { status: 0, code }));
              return;
            }
            case 'start':
            case 'done':
              // `start` carries the register (no client use yet). `done`
              // carries the terminal envelope and is immediately followed
              // by server EOF, which fires `onDone` below — nothing to do
              // per-frame.
              return;
            default:
              // Unknown inner events ignored so the protocol can grow.
              return;
          }
        },
        onDone: (): void => {
          // Suppress the clean-EOF callback when the stream ended on an
          // in-band error (the tail-flush path can deliver the error frame
          // at EOF, which otherwise resolves as a "clean" close).
          if (!terminalError) opts.onDone?.();
        },
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
  } catch (err) {
    // Prefer the in-band terminal error over the synthetic abort/transport
    // rejection triggered by our own failStream() abort.
    throw terminalError ?? err;
  } finally {
    opts.signal.removeEventListener('abort', forwardAbort);
  }
  // Belt-and-braces: if the error frame arrived in the EOF tail-flush the
  // stream resolves normally — still surface the failure to the caller.
  if (terminalError) throw terminalError;
}

/**
 * Parse one data-only SSE frame payload into a plain object, or `null`
 * when the payload is not a JSON object. Field types are narrowed at the
 * dispatch site; this only guarantees the container shape.
 */
function parseFramePayload(data: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  // Safe narrow: verified above to be a non-null, non-array object.
  return parsed as Record<string, unknown>;
}
