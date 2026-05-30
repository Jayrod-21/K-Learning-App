/**
 * /conversation routes — AI tutor sessions (Claude proxy).
 *
 * The Claude call delegates to B4. Persistence is the standard "append to a
 * JSONB array" pattern; optimistic-concurrency on the session row via the
 * `version` column.
 *
 * Threat model (extends Repository/server/SECURITY.md):
 *   - Streaming-DoS: SSE keeps a connection open. The route honors client
 *     disconnect via AbortSignal and propagates abort to the upstream B4
 *     call — see `streamMessage` below. `expensiveLimiter` per-user bucket
 *     bounds concurrent attempts.
 *   - Prompt injection: B4 already sanitizes content via `sanitizeUserInput`
 *     before building the request (see services/claude/prompts/sanitize.ts).
 *     We rely on that boundary; the route does not re-sanitize.
 *   - Idempotent retry under network blips: the optional `X-Request-Id`
 *     header lets a client retry a streamed turn. If we have a persisted
 *     message with that request id for that conversation, we return it
 *     verbatim (200) rather than re-streaming a second Claude call.
 *   - Persisted-half-turn under stream failure: assistant turn is written
 *     ONLY after the upstream stream completes successfully. A mid-stream
 *     abort or upstream error persists nothing — the next attempt is a
 *     fresh turn (Bar §"Idempotency & retries": "no half-states").
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { expensiveLimiter, cheapLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { query, withTransaction } from '../db/pool.js';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../middleware/errors.js';
import { getClaudeProxy } from '../services/claudeProxy.js';
import type {
  ConversationInput,
  ConversationTurn,
} from '../services/claude/index.js';

// Shape: a user turn or assistant turn appended to conversations.messages
// JSONB array. `request_id` is recorded on assistant turns to enable retry-
// idempotency (see streamMessage below).
interface StoredTurn {
  role: 'user' | 'assistant';
  content: string;
  sent_at: string;
  request_id?: string;
}

// Inbound idempotency-id shape: same alphabet as our correlation id. Caps
// length to defend against pathological headers.
const REQUEST_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

const router = Router();
router.use(requireAuth);

const ModeEnum = z.enum(['casual', 'business', 'research', 'topik_prep', 'register_drill']);
const RegisterEnum = z.enum(['반말', '해요체', '합쇼체', '문어체', '하오체', '하게체']);

const StartBodySchema = z.object({
  mode: ModeEnum,
  target_register: RegisterEnum.nullish(),
});

router.post(
  '/',
  cheapLimiter(),
  validateBody(StartBodySchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof StartBodySchema>;
      const userId = getUserId(req);
      const { rows } = await query<{ id: number }>(
        `INSERT INTO conversations (user_id, mode, target_register)
         VALUES ($1, $2::conversation_mode, $3::register_level)
         RETURNING id`,
        [userId, body.mode, body.target_register ?? null],
      );
      res.status(201).json({ conversation: rows[0] });
    } catch (err) {
      next(err);
    }
  },
);

const MessageParamsSchema = z.object({
  conversationId: z.coerce.number().int().positive(),
});

const MessageBodySchema = z.object({
  content: z.string().min(1).max(4_000),
  expected_version: z.number().int().positive(),
});

interface ConversationRow {
  version: number;
  mode: string;
  target_register: string | null;
  messages: unknown;
}

interface RawTurn {
  role?: unknown;
  content?: unknown;
  request_id?: unknown;
}

/**
 * Project the persisted messages JSONB into the shape B4's `ConversationInput`
 * expects (history of `{role, content}` items). Defensive against schema drift
 * — a malformed row drops bad entries rather than 500.
 */
function projectHistory(messages: unknown): ConversationInput['history'] {
  if (!Array.isArray(messages)) return [];
  const out: ConversationInput['history'] = [];
  for (const m of messages as RawTurn[]) {
    if (
      m &&
      typeof m.content === 'string' &&
      m.content.trim().length > 0 &&
      (m.role === 'user' || m.role === 'assistant')
    ) {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

/**
 * Find a previously-persisted assistant turn whose `request_id` matches the
 * caller's `X-Request-Id`. Used for idempotent retry of streaming turns.
 *
 * Returns the assistant turn body if a match exists, else null.
 */
function findIdempotentTurn(
  messages: unknown,
  requestId: string,
): StoredTurn | null {
  if (!Array.isArray(messages)) return null;
  for (const raw of messages as RawTurn[]) {
    if (
      raw &&
      raw.role === 'assistant' &&
      typeof raw.content === 'string' &&
      typeof raw.request_id === 'string' &&
      raw.request_id === requestId
    ) {
      return {
        role: 'assistant',
        content: raw.content,
        sent_at: '',
        request_id: requestId,
      };
    }
  }
  return null;
}

/**
 * POST /conversation/:conversationId/messages — append a user turn, request
 * an assistant turn from B4, store both. We compute the assistant turn
 * OUTSIDE the transaction (Bar §"Concurrency": no external I/O in tx) and
 * then commit both messages atomically.
 *
 * FU-NF-4 (closed Pass 3): this endpoint now calls B4's `generateConversation`
 * and persists the real assistant turn (no more `[awaiting B4 wiring]`
 * placeholder). The streaming variant lives at POST /:conversationId/
 * messages/stream below.
 */
router.post(
  '/:conversationId/messages',
  expensiveLimiter(),
  validateParams(MessageParamsSchema),
  validateBody(MessageBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const conversationId = (req as typeof req & {
        validatedParams: z.infer<typeof MessageParamsSchema>;
      }).validatedParams.conversationId;
      const body = req.body as z.infer<typeof MessageBodySchema>;

      // Read current state (short read tx).
      const { rows } = await query<ConversationRow>(
        `SELECT version, mode::text AS mode,
                target_register::text AS target_register,
                messages
           FROM conversations
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [conversationId, userId],
      );
      const conv = rows[0];
      if (!conv) throw new NotFoundError('conversation not found');
      if (conv.version !== body.expected_version) {
        throw new ConflictError('stale conversation version');
      }

      const userTurn: StoredTurn = {
        role: 'user',
        content: body.content,
        sent_at: new Date().toISOString(),
      };

      // B4 call OUTSIDE any transaction (Bar §"Concurrency"). If it fails we
      // surface the error and DO NOT persist a half-turn.
      const turn = await generateAssistantTurn({
        history: projectHistory(conv.messages),
        userContent: body.content,
        mode: conv.mode,
        targetRegister: conv.target_register,
        correlationId: req.correlationId,
        userId,
      });

      const assistantTurn: StoredTurn = {
        role: 'assistant',
        content: turn.korean,
        sent_at: new Date().toISOString(),
      };

      const out = await withTransaction(async (client) => {
        const upd = await client.query<{ version: number; messages: unknown }>(
          `UPDATE conversations
              SET messages = messages || $2::jsonb,
                  version  = version + 1
            WHERE id = $1 AND user_id = $3 AND version = $4 AND deleted_at IS NULL
            RETURNING version, messages`,
          [
            conversationId,
            JSON.stringify([userTurn, assistantTurn]),
            userId,
            body.expected_version,
          ],
        );
        if (upd.rowCount === 0) throw new ConflictError('stale conversation version');
        return upd.rows[0]!;
      });
      res.status(200).json({
        version: out.version,
        messages: out.messages,
        register: turn.register,
        english_note: turn.englishNote,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Non-streaming helper: drain B4's stream once and return the assembled turn.
 * Used by the legacy non-streaming endpoint. The streaming endpoint inlines
 * the iteration so it can push deltas to the SSE consumer concurrently.
 */
async function generateAssistantTurn(params: {
  history: ConversationInput['history'];
  userContent: string;
  mode: string;
  targetRegister: string | null;
  correlationId: string;
  userId: number;
}): Promise<ConversationTurn> {
  const proxy = getClaudeProxy();
  // The B4 input requires a scenario. When the client only sent a user
  // message (no scenario brief) we synthesize one from the mode + most recent
  // user turn — same posture the front-end will adopt when the Pass 2
  // Conversation screen lands.
  const scenario = `Continue a ${params.mode} conversation. Latest user message: ${params.userContent.slice(0, 480)}`;
  const input: ConversationInput = {
    scenario,
    registerTarget: (params.targetRegister ?? '해요체') as ConversationInput['registerTarget'],
    vocabFocus: [],
    mode: params.mode as ConversationInput['mode'],
    history: [
      ...params.history,
      { role: 'user', content: params.userContent },
    ],
    maxTokens: 800,
  };
  const { events, final } = proxy.generateConversation(input, {
    requestId: params.correlationId,
    userId: params.userId,
  });
  // No abort plumbing in the non-streaming path — the caller is awaiting
  // the assembled `final`, so a worker abort would surface as that promise
  // rejecting and bubble naturally.
  // Drain the event stream so the underlying worker progresses — we don't
  // use the deltas in the non-streaming path; the `final` promise yields
  // the assembled turn.
  void (async (): Promise<void> => {
    try {
      for await (const _ of events) {
        // discard
      }
    } catch {
      // Errors surface via the `final` promise; swallow iteration noise.
    }
  })();
  const result = await final;
  return result.result;
}

const StreamQuerySchema = z.object({
  // Header-based idempotency is preferred (X-Request-Id), but we accept a
  // query-string fallback so clients on platforms that strip custom headers
  // still get retry-safety. The header wins when both are present.
  request_id: z.string().regex(REQUEST_ID_REGEX).optional(),
});

/**
 * POST /conversation/:conversationId/messages/stream — SSE variant of the
 * messages endpoint. Closes FU-NF-4.
 *
 * Endpoint choice: a dedicated subpath instead of a `?stream=1` query flag.
 * Rationale: the rest of the API uses path verbs (`/cards/init`,
 * `/grammar/identify`, `/grammar/bank`). A flag would require the central
 * error handler to know about the content-type swap (JSON vs text/event-
 * stream) per request, which couples middleware to a route-level concern.
 * Two endpoints, two response contracts.
 *
 * Wire format (Server-Sent Events):
 *   data: {"event":"start","register":"해요체"}\n\n
 *   data: {"event":"delta","text":"안"}\n\n
 *   …
 *   data: {"event":"done","version":4,"messages":[…]}\n\n
 *   data: {"event":"error","message":"upstream timeout"}\n\n   (terminal)
 *
 * Each frame is a single `data:` line carrying compact JSON. We do NOT emit
 * SSE `event:` lines — EventSource fallback parsers handle `data:`-only
 * frames cleanly across every browser version we support.
 *
 * Disconnect handling: `req.on('close', …)` aborts the upstream call via an
 * AbortController. If the abort fires after the upstream resolved, the
 * persisted-message branch below is skipped — the next attempt re-streams.
 */
router.post(
  '/:conversationId/messages/stream',
  expensiveLimiter(),
  validateParams(MessageParamsSchema),
  validateBody(MessageBodySchema),
  validateQueryStream,
  streamMessage,
);

/** Lightweight wrapper that mirrors validateQuery without forcing the global
 *  signature change (kept inline because only this route needs it). */
function validateQueryStream(
  req: Request,
  _res: Response,
  next: (err?: unknown) => void,
): void {
  const result = StreamQuerySchema.safeParse(req.query);
  if (!result.success) {
    next(new ValidationError('invalid stream query', result.error.issues));
    return;
  }
  (req as Request & { validatedStreamQuery: z.infer<typeof StreamQuerySchema> }).validatedStreamQuery =
    result.data;
  next();
}

async function streamMessage(
  req: Request,
  res: Response,
  next: (err?: unknown) => void,
): Promise<void> {
  const userId = getUserId(req);
  const conversationId = (req as typeof req & {
    validatedParams: z.infer<typeof MessageParamsSchema>;
  }).validatedParams.conversationId;
  const body = req.body as z.infer<typeof MessageBodySchema>;
  const streamQuery = (req as Request & {
    validatedStreamQuery?: z.infer<typeof StreamQuerySchema>;
  }).validatedStreamQuery;

  // Header preferred over query (cleaner, harder to leak into logs).
  const rawRequestId = req.header('x-request-id') ?? streamQuery?.request_id;
  const requestId =
    rawRequestId && REQUEST_ID_REGEX.test(rawRequestId) ? rawRequestId : null;

  // Single AbortController gates the upstream worker. We never call abort
  // from the success path; only from `req.on('close', …)`. The B4 stream
  // worker swallows iterator failures and surfaces them through the
  // `final` promise, so the abort manifests as a rejected `final`.
  const abort = new AbortController();
  let closed = false;
  req.on('close', () => {
    if (!res.writableEnded) {
      closed = true;
      abort.abort();
    }
  });

  try {
    // ---- Load conversation + concurrency check ----
    const { rows } = await query<ConversationRow>(
      `SELECT version, mode::text AS mode,
              target_register::text AS target_register,
              messages
         FROM conversations
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [conversationId, userId],
    );
    const conv = rows[0];
    if (!conv) throw new NotFoundError('conversation not found');

    // ---- Idempotency-by-request-id: replay if we already persisted ----
    // Checked BEFORE the version gate on purpose: a retry naturally carries
    // the OLD expected_version (the client recorded it before the first
    // attempt). If we 409'd here, every retry would fail and the
    // idempotency mechanism would be useless. Replay is a read-only
    // response — safe to skip the version check.
    if (requestId) {
      const prior = findIdempotentTurn(conv.messages, requestId);
      if (prior) {
        beginSseResponse(res);
        writeSseFrame(res, {
          event: 'start',
          register: conv.target_register ?? null,
          idempotent_replay: true,
        });
        writeSseFrame(res, { event: 'delta', text: prior.content });
        writeSseFrame(res, {
          event: 'done',
          version: conv.version,
          messages: conv.messages,
          idempotent_replay: true,
        });
        res.end();
        return;
      }
    }

    if (conv.version !== body.expected_version) {
      throw new ConflictError('stale conversation version');
    }

    // ---- Stream from B4 ----
    beginSseResponse(res);
    const userTurn: StoredTurn = {
      role: 'user',
      content: body.content,
      sent_at: new Date().toISOString(),
    };

    const proxy = getClaudeProxy();
    const scenario = `Continue a ${conv.mode} conversation. Latest user message: ${body.content.slice(0, 480)}`;
    const input: ConversationInput = {
      scenario,
      registerTarget: (conv.target_register ?? '해요체') as ConversationInput['registerTarget'],
      vocabFocus: [],
      mode: conv.mode as ConversationInput['mode'],
      history: [
        ...projectHistory(conv.messages),
        { role: 'user', content: body.content },
      ],
      maxTokens: 800,
    };

    const { events, final } = proxy.generateConversation(input, {
      requestId: req.correlationId,
      userId,
      signal: abort.signal,
    });

    // SF-1 fix: leaked `final` promise on disconnect. The for-await loop
    // below breaks on abort without awaiting `final`; a subsequent rejection
    // would surface as an unhandledRejection process event. Attach a
    // no-op catch immediately so the promise has at least one consumer.
    final.catch((err: unknown) => {
      // Log at debug only — the abort path's catch in the outer try/catch
      // is the authoritative error sink.
      req.log.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'conversation final promise rejected (handled by outer catch)',
      );
    });

    // Drain events → SSE deltas. We don't poll the AbortSignal explicitly;
    // a client disconnect calls `abort.abort()`, which causes the B4 worker
    // to surface an error on `final`. We also break out of the loop ASAP
    // when the response has been ended (defensive against double-write).
    let register: string | null = conv.target_register ?? null;
    for await (const ev of events) {
      if (closed || res.writableEnded) break;
      if (ev.type === 'start') {
        register = ev.register;
        writeSseFrame(res, { event: 'start', register });
      } else if (ev.type === 'delta') {
        writeSseFrame(res, { event: 'delta', text: ev.text });
      } else if (ev.type === 'error') {
        writeSseFrame(res, {
          event: 'error',
          code: ev.code,
          message: ev.message,
        });
        res.end();
        return;
      }
      // 'complete' events are handled via the `final` promise so we have a
      // single source of truth on the assembled turn (Bar §"DRY-with-care").
    }

    if (closed || res.writableEnded) {
      // Client gone before stream finished. Don't persist; the next attempt
      // re-runs.
      return;
    }

    const finalResult = await final;
    const turn = finalResult.result;

    const assistantTurn: StoredTurn = {
      role: 'assistant',
      content: turn.korean,
      sent_at: new Date().toISOString(),
      ...(requestId ? { request_id: requestId } : {}),
    };

    // ---- Persist AFTER the stream completes (Bar §"Idempotency"). ----
    let persistedVersion: number;
    let persistedMessages: unknown;
    try {
      const out = await withTransaction(async (client) => {
        const upd = await client.query<{ version: number; messages: unknown }>(
          `UPDATE conversations
              SET messages = messages || $2::jsonb,
                  version  = version + 1
            WHERE id = $1 AND user_id = $3 AND version = $4 AND deleted_at IS NULL
            RETURNING version, messages`,
          [
            conversationId,
            JSON.stringify([userTurn, assistantTurn]),
            userId,
            body.expected_version,
          ],
        );
        if (upd.rowCount === 0) {
          // A concurrent writer beat us to the version bump. Surface as a
          // conflict event over SSE — clients refetch + retry with the new
          // expected_version.
          throw new ConflictError('stale conversation version');
        }
        return upd.rows[0]!;
      });
      persistedVersion = out.version;
      persistedMessages = out.messages;
    } catch (err) {
      // Persistence failed AFTER a successful stream. We have two equally
      // bad choices: lie to the user (claim it saved) or surface the error
      // (lose the streamed bytes). Surface, with the assistant text in
      // the error frame so the client can render it transiently and offer
      // a manual save / retry button.
      const message = err instanceof Error ? err.message : 'persistence failed';
      writeSseFrame(res, {
        event: 'error',
        code: 'persistence_error',
        message,
        recovered_text: turn.korean,
      });
      res.end();
      req.log.error(
        { err: message, conversationId, userId },
        'conversation persistence failed after successful stream',
      );
      return;
    }

    writeSseFrame(res, {
      event: 'done',
      version: persistedVersion,
      messages: persistedMessages,
      register,
      english_note: turn.englishNote,
    });
    res.end();
    req.log.info(
      { conversationId, userId, version: persistedVersion },
      'conversation stream complete',
    );
  } catch (err) {
    if (res.headersSent) {
      // SSE already started — push an error frame and close. Don't call
      // next(err): the central error handler writes JSON, which would
      // corrupt the SSE byte stream.
      const message = err instanceof Error ? err.message : 'stream failed';
      try {
        writeSseFrame(res, { event: 'error', message });
      } catch {
        /* swallow — connection may already be torn down */
      }
      if (!res.writableEnded) res.end();
      req.log.warn({ err: message }, 'streaming conversation errored after headers');
      return;
    }
    next(err);
  }
}

function beginSseResponse(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Disable proxy buffering — Cloudflare, nginx, etc. otherwise batch
  // frames and break the token-by-token UX.
  res.setHeader('X-Accel-Buffering', 'no');
  // Flush the headers so the client sees the response open immediately.
  res.flushHeaders?.();
}

function writeSseFrame(res: Response, payload: unknown): void {
  // SSE frame: `data: <json>\n\n`. JSON is single-line by construction.
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

router.get('/', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { rows } = await query(
      `SELECT id, mode, target_register, version, updated_at,
              jsonb_array_length(messages) AS message_count
         FROM conversations
        WHERE user_id = $1 AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 50`,
      [userId],
    );
    res.status(200).json({ conversations: rows });
  } catch (err) {
    next(err);
  }
});

export default router;
