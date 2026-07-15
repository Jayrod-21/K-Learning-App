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
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
  mapClaudeError,
} from '../middleware/errors.js';
import { getClaudeProxy } from '../services/claudeProxy.js';
import type {
  ConversationInput,
  ConversationTurn,
} from '../services/claude/index.js';
import {
  multerImageUpload,
  ocrUploadedImage,
  persistCapture,
  type IngestedImage,
} from '../services/imageIngest.js';
import {
  ingestAttachedDocument,
  multerDocUpload,
} from '../services/docAttach.js';

// Optional image reference on a stored turn (chat rework Slice 1). Present
// when the turn is an uploaded photo that went through the Vision OCR
// pipeline: `content` carries the OCR'd Korean text (so projectHistory feeds
// it to Claude unchanged) and this block carries the capture linkage + the
// translation. All fields are server-authored — never client input.
interface StoredTurnImage {
  /** image_captures.id — joins to GET /images/:id (words) + :id/blob. */
  capture_id: number;
  /** Authed same-origin `<img src>` path (`/images/:id/blob`). */
  blob_url: string;
  /** OCR'd Korean text from the image ('' when the photo had none). */
  caption_kr: string;
  /** English translation of the OCR'd text. */
  caption_en: string;
}

// Optional document reference on a stored turn (F-035 attach backend).
// Present when the turn is an attached text document: `content` carries the
// (bounded) document text — so projectHistory feeds it to Claude unchanged —
// and this block carries display metadata. All fields are server-authored
// (the filename is sanitized display text, never a path).
interface StoredTurnFile {
  /** Sanitized display filename (basename only). */
  name: string;
  /** Declared mime from the docAttach allowlist (bytes verified separately). */
  media_type: string;
  /** Original upload size in bytes. */
  size_bytes: number;
  /** True when the stored text is a truncated excerpt of a longer document. */
  truncated: boolean;
}

// Shape: a user turn or assistant turn appended to conversations.messages
// JSONB array. `request_id` is recorded on assistant turns to enable retry-
// idempotency (see streamMessage below). `image` is present only on turns
// created by POST /:conversationId/image; `file` only on turns created by
// POST /:conversationId/file — plain text turns stay exactly as before
// (all optional ⇒ every pre-existing row remains valid).
interface StoredTurn {
  role: 'user' | 'assistant';
  content: string;
  sent_at: string;
  request_id?: string;
  image?: StoredTurnImage;
  file?: StoredTurnFile;
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
      // pg returns BIGINT (id) as a string; the API contract documents the
      // conversation id as a JSON number. conversations.id fits in
      // Number.MAX_SAFE_INTEGER.
      res.status(201).json({ conversation: { id: Number(rows[0]!.id) } });
    } catch (err) {
      next(err);
    }
  },
);

const MessageParamsSchema = z.object({
  // BIGINT id: bounded so a 20-digit id 400s at the boundary instead of
  // overflowing int8 in pg (22003 → 500; routes sweep #3).
  conversationId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

const MessageBodySchema = z.object({
  content: z.string().min(1).max(4_000),
  // conversations.version is INTEGER — bound to INT4 so an absurd version
  // 400s instead of overflowing in pg (routes sweep #3).
  expected_version: z.number().int().positive().max(2_147_483_647),
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
      //
      // Only AppError messages ride the wire — they are server-authored and
      // safe (e.g. "stale conversation version"). A raw driver/pg message
      // would leak schema and constraint names to the client, bypassing the
      // central errorHandler's opaque-500 rule (routes sweep #5); those go to
      // the log only.
      const detail = err instanceof Error ? err.message : String(err);
      const message = err instanceof AppError ? err.message : 'persistence failed';
      writeSseFrame(res, {
        event: 'error',
        code: 'persistence_error',
        message,
        recovered_text: turn.korean,
      });
      res.end();
      req.log.error(
        { err: detail, conversationId, userId },
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
      // corrupt the SSE byte stream. Same redaction rule as the persistence
      // catch above: only server-authored AppError messages ride the wire;
      // raw upstream/driver messages stay in the log (routes sweep #5).
      const detail = err instanceof Error ? err.message : String(err);
      const message = err instanceof AppError ? err.message : 'stream failed';
      try {
        writeSseFrame(res, { event: 'error', message });
      } catch {
        /* swallow — connection may already be torn down */
      }
      if (!res.writableEnded) res.end();
      req.log.warn({ err: detail }, 'streaming conversation errored after headers');
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

    // 30-day retention (chat rework Slice 1 — see db/docs/CHAT_REWORK_DESIGN.md
    // §Decisions): soft-delete this user's stale conversations BEFORE listing,
    // then return the still-live set. The list endpoint IS the sweep trigger —
    // this repo has no cron/interval scheduler, and every read route already
    // filters `deleted_at IS NULL`, so setting the stamp both hides and
    // "deletes" with zero new infra. Idempotent (a swept row leaves the
    // predicate) and strictly user-scoped (never touches other users' rows).
    // Note: the BEFORE UPDATE trigger bumps updated_at on the swept rows, but
    // they are already dead to every reader, so that is inert.
    const swept = await query(
      `UPDATE conversations
          SET deleted_at = now()
        WHERE user_id = $1
          AND deleted_at IS NULL
          AND updated_at < now() - interval '30 days'`,
      [userId],
    );
    if (swept.rowCount > 0) {
      req.log.info(
        { userId, swept: swept.rowCount },
        'conversation retention sweep soft-deleted stale conversations',
      );
    }

    const { rows } = await query(
      `SELECT id, title, mode, target_register, version, updated_at,
              jsonb_array_length(messages) AS message_count
         FROM conversations
        WHERE user_id = $1 AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 50`,
      [userId],
    );
    // pg returns BIGINT (id) as a string; the API contract documents the
    // conversation id as a JSON number (matches POST /conversation's shape).
    const conversations = rows.map((c) => ({
      ...c,
      id: Number((c as { id: unknown }).id),
    }));
    res.status(200).json({ conversations });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /conversation/:conversationId — one conversation's FULL message history
 * (chat rework Slice 1: the sidebar's click-to-switch loads this).
 *
 * Returns the JSONB `messages` array verbatim plus the row metadata the
 * client needs to keep streaming against it (`version` for the optimistic-
 * concurrency gate). User-scoped; another user's id, a missing id, or a
 * soft-deleted (retention-swept) row → 404 — never 403, don't confirm
 * existence (same IDOR posture as every read in this file). A non-numeric /
 * out-of-int8 id → 400 at the boundary via MessageParamsSchema.
 */
router.get(
  '/:conversationId',
  cheapLimiter(),
  validateParams(MessageParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const conversationId = (req as typeof req & {
        validatedParams: z.infer<typeof MessageParamsSchema>;
      }).validatedParams.conversationId;

      const { rows } = await query<{
        id: string;
        title: string | null;
        mode: string;
        target_register: string | null;
        version: number;
        messages: unknown;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT id, title, mode::text AS mode,
                target_register::text AS target_register,
                version, messages, created_at, updated_at
           FROM conversations
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [conversationId, userId],
      );
      const conv = rows[0];
      if (!conv) throw new NotFoundError('conversation not found');

      res.status(200).json({
        conversation: {
          // pg returns BIGINT as a string; the API contract documents the
          // conversation id as a JSON number (matches POST + GET list).
          id: Number(conv.id),
          title: conv.title,
          mode: conv.mode,
          target_register: conv.target_register,
          version: conv.version,
          messages: conv.messages,
          created_at: conv.created_at.toISOString(),
          updated_at: conv.updated_at.toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /conversation/:conversationId/image — image-in-chat (Slice 1).
// ---------------------------------------------------------------------------

const ImageBodySchema = z
  .object({
    // Multipart text field, so it arrives as a string — coerce. Bounded to
    // INT4 like MessageBodySchema.expected_version (conversations.version is
    // INTEGER; an absurd value must 400, not overflow in pg).
    expected_version: z.coerce.number().int().positive().max(2_147_483_647),
  })
  .strict();

/**
 * POST /conversation/:conversationId/image — multipart upload of one `image`
 * field (+ `expected_version` text field) onto a conversation.
 *
 * Runs the EXACT pipeline behind POST /images/ocr (services/imageIngest.ts —
 * magic-byte sniff, per-user daily Vision cap, Claude Vision OCR outside any
 * transaction), then appends ONE user turn carrying the OCR'd Korean text as
 * `content` and the capture linkage + English translation in `image` (see
 * StoredTurnImage). The capture also lands in image_captures/image_words, so
 * it shows up on the Images screen and its words are minable as usual.
 *
 * Endpoint choice: a dedicated `/image` subpath rather than teaching
 * POST /:id/messages to speak multipart — that route's JSON contract
 * (content + Claude turn generation) and this one's (file + OCR, NO
 * assistant turn) share almost nothing, and the rest of the API prefers
 * path verbs over content-type switching (see the /messages/stream note).
 *
 * Atomicity: capture persist + turn append commit in ONE transaction — a
 * version conflict rolls the capture back too (no orphan capture row; the
 * already-written blob file is a harmless GC-able orphan, same posture as
 * /images/ocr). The version pre-check runs BEFORE the Vision call so a stale
 * client 409s without spending Vision budget.
 *
 * 201: the request created a durable subresource (the capture + the turn) —
 * matches POST /images/ocr; the envelope mirrors POST /:id/messages
 * (`version` + `messages`) plus the appended `turn`.
 */
router.post(
  '/:conversationId/image',
  expensiveLimiter(),
  validateParams(MessageParamsSchema),
  multerImageUpload,
  validateBody(ImageBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const conversationId = (req as typeof req & {
        validatedParams: z.infer<typeof MessageParamsSchema>;
      }).validatedParams.conversationId;
      const body = req.body as z.infer<typeof ImageBodySchema>;
      const file = (req as Request & { file?: Express.Multer.File }).file;

      // Cheap gates first: the conversation must exist, be the caller's, and
      // be at the expected version BEFORE we spend a Vision call. (404 for
      // other-user/missing/swept — never 403.)
      const { rows } = await query<{ version: number }>(
        `SELECT version
           FROM conversations
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [conversationId, userId],
      );
      const conv = rows[0];
      if (!conv) throw new NotFoundError('conversation not found');
      if (conv.version !== body.expected_version) {
        throw new ConflictError('stale conversation version');
      }

      // Validate file + daily cap + Vision OCR — all OUTSIDE any transaction
      // (Bar §"Concurrency"). Throws 400/429/502; nothing persisted on failure.
      const img = await ocrUploadedImage(file, userId, req.correlationId);

      // ONE transaction: blob + capture + words + the conversation turn. The
      // version gate re-runs inside the UPDATE so a concurrent writer between
      // the pre-check and here rolls the capture back and 409s cleanly.
      const out = await withTransaction(async (client) => {
        const capture = await persistCapture(client, userId, img);
        const imageTurn: StoredTurn = {
          role: 'user',
          content: imageTurnContent(img),
          sent_at: new Date().toISOString(),
          image: {
            // capture.id is pg's BIGINT-as-string; fits MAX_SAFE_INTEGER.
            capture_id: Number(capture.id),
            blob_url: capture.blobUrl,
            caption_kr: capture.caption_kr,
            caption_en: capture.caption_en,
          },
        };
        const upd = await client.query<{ version: number; messages: unknown }>(
          `UPDATE conversations
              SET messages = messages || $2::jsonb,
                  version  = version + 1
            WHERE id = $1 AND user_id = $3 AND version = $4 AND deleted_at IS NULL
            RETURNING version, messages`,
          [
            conversationId,
            JSON.stringify([imageTurn]),
            userId,
            body.expected_version,
          ],
        );
        if (upd.rowCount === 0) {
          throw new ConflictError('stale conversation version');
        }
        return {
          version: upd.rows[0]!.version,
          messages: upd.rows[0]!.messages,
          turn: imageTurn,
        };
      });

      res.status(201).json(out);
      req.log.info(
        { conversationId, userId, version: out.version },
        'conversation image turn appended',
      );
    } catch (err) {
      next(err);
    }
  },
);

/**
 * The `content` of an image turn — what projectHistory feeds Claude and what
 * a text-only renderer falls back to. Prefer the OCR'd Korean text; fall back
 * to the English caption; a photo with no readable text gets a fixed marker
 * so the turn stays non-empty (an empty content would be silently dropped
 * from the Claude history projection).
 */
function imageTurnContent(img: IngestedImage): string {
  const kr = img.captionKr.trim();
  if (kr !== '') return kr;
  const en = img.captionEn.trim();
  if (en !== '') return en;
  return '(이미지)';
}

// ---------------------------------------------------------------------------
// Conversation titles (F-036) — rename + auto-name.
// ---------------------------------------------------------------------------

const TitleBodySchema = z
  .object({
    // App-layer cap is tighter than the DB CHECK (200, migration 055) so a
    // valid request can never trip the constraint. `.strict()` rejects any
    // extra field (mass-assignment guard — title is the ONLY writable field).
    title: z.string().trim().min(1).max(120),
  })
  .strict();

/**
 * PATCH /conversation/:conversationId — user rename. Sets `title`
 * unconditionally (the user's choice always wins, including overwriting an
 * auto-generated title). Deliberately does NOT bump `version`: that column is
 * the MESSAGES optimistic-concurrency token — bumping it here would 409 any
 * in-flight message append for a cosmetic rename.
 *
 * 404 for missing/foreign/swept ids (IDOR posture of every route here).
 */
router.patch(
  '/:conversationId',
  cheapLimiter(),
  validateParams(MessageParamsSchema),
  validateBody(TitleBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const conversationId = (req as typeof req & {
        validatedParams: z.infer<typeof MessageParamsSchema>;
      }).validatedParams.conversationId;
      const body = req.body as z.infer<typeof TitleBodySchema>;

      const { rows } = await query<{ title: string }>(
        `UPDATE conversations
            SET title = $2
          WHERE id = $1 AND user_id = $3 AND deleted_at IS NULL
          RETURNING title`,
        [conversationId, body.title, userId],
      );
      if (rows.length === 0) throw new NotFoundError('conversation not found');
      res.status(200).json({ title: rows[0]!.title });
    } catch (err) {
      next(err);
    }
  },
);

/** How many leading turns feed the namer, and the per-turn excerpt cap. The
 *  OPENING exchange carries the topic; later turns add cost, not signal. */
const NAME_HISTORY_TURNS = 6;
const NAME_TURN_MAX_CHARS = 500;

/**
 * POST /conversation/:conversationId/name — F-036 auto-naming trigger. The
 * client calls this after the first assistant reply lands (Phase-3 wiring);
 * the endpoint derives a concise content-based title via Claude
 * (route=name_conversation) and stores it.
 *
 * Contract:
 *   - Already-named conversation (user rename OR earlier auto-name) → 200
 *     with the EXISTING title, `generated:false`, and NO Claude call —
 *     idempotent, never clobbers (the title-IS-NULL guard is enforced in the
 *     UPDATE itself, so a concurrent rename also wins the race).
 *   - No messages yet → 409 (nothing to derive a title from).
 *   - Missing/foreign/swept id → 404 (IDOR posture; no Claude spend).
 *
 * No `expected_version` gate and no version bump — same rationale as PATCH
 * above: `version` guards the messages array, which this route never touches.
 */
router.post(
  '/:conversationId/name',
  expensiveLimiter(),
  validateParams(MessageParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const conversationId = (req as typeof req & {
        validatedParams: z.infer<typeof MessageParamsSchema>;
      }).validatedParams.conversationId;

      const { rows } = await query<{
        title: string | null;
        mode: string;
        messages: unknown;
      }>(
        `SELECT title, mode::text AS mode, messages
           FROM conversations
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [conversationId, userId],
      );
      const conv = rows[0];
      if (!conv) throw new NotFoundError('conversation not found');
      if (conv.title !== null) {
        res.status(200).json({ title: conv.title, generated: false });
        return;
      }

      // Opening excerpt: first N non-empty turns, each bounded. projectHistory
      // already drops malformed entries, so this is safe against JSONB drift.
      const history = projectHistory(conv.messages)
        .slice(0, NAME_HISTORY_TURNS)
        .map((t) => ({
          role: t.role,
          content: t.content.slice(0, NAME_TURN_MAX_CHARS),
        }));
      if (history.length === 0) {
        throw new ConflictError('conversation has no messages to name');
      }

      // Claude call OUTSIDE any transaction (Bar §"Concurrency").
      const proxy = getClaudeProxy();
      let generatedTitle: string;
      try {
        const out = await proxy.nameConversation(
          {
            history,
            mode: conv.mode as 'casual' | 'business' | 'research' | 'topik_prep' | 'register_drill',
          },
          { requestId: req.correlationId, userId },
        );
        generatedTitle = out.result.title;
      } catch (err) {
        next(mapClaudeError(err));
        return;
      }

      // Store ONLY if still unnamed — a concurrent rename/auto-name between
      // the read above and here wins, and we return the surviving title.
      //
      // F-125: this conditional UPDATE is already exactly-once at the STORAGE
      // layer, not just "usually fine" — two concurrent first-name calls can
      // both pass the read-check and both burn a Claude call (the race this
      // ticket is about), but they cannot both WRITE. Postgres READ COMMITTED
      // guarantees it: both UPDATEs try to lock this row; the first one in
      // commits (title now non-NULL); the second was blocked on the row lock
      // and, once it's released, re-fetches the row and RE-EVALUATES the
      // `title IS NULL` qual against the new committed value (EvalPlanQual) —
      // so it affects 0 rows rather than clobbering the winner's title. The
      // `upd.rows.length === 0` branch below always means "someone else already
      // won" (or the row was swept), never a second write. No advisory lock or
      // schema change needed for this half of the bug.
      //
      // What's NOT fixed here (by design, this pass): the double Claude-call
      // cost when both requests race past the read-check before either
      // commits. Storage never diverges and the window only exists once per
      // conversation (every later call short-circuits above with no Claude
      // spend), bounded further by `expensiveLimiter()`. Closing that cost gap
      // needs either a schema change (a claim-first sentinel/column) or a
      // session-scoped Postgres advisory lock held across the Claude network
      // round-trip (real client-checkout/release lifecycle risk, no existing
      // precedent in this codebase) — BUGS_AND_FEATURES.md's F-125 explicitly
      // recommends deferring whichever of those to a full-suite-gated pass,
      // not a migration-free targeted-test batch. Do not "fix" this into a
      // sentinel-in-the-title-column hack: a crash between claiming and
      // clearing the sentinel would strand the conversation permanently
      // unnamed.
      const upd = await query<{ title: string }>(
        `UPDATE conversations
            SET title = $2
          WHERE id = $1 AND user_id = $3 AND title IS NULL AND deleted_at IS NULL
          RETURNING title`,
        [conversationId, generatedTitle, userId],
      );
      if (upd.rows.length > 0) {
        res.status(200).json({ title: upd.rows[0]!.title, generated: true });
        req.log.info(
          { conversationId, userId },
          'conversation auto-named (F-036)',
        );
        return;
      }
      // Lost the race (or the row was swept mid-flight). Re-read; a swept row
      // is a 404, a concurrently-set title is returned as-is.
      const reread = await query<{ title: string | null }>(
        `SELECT title FROM conversations
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [conversationId, userId],
      );
      const survivor = reread.rows[0];
      if (!survivor || survivor.title === null) {
        throw new NotFoundError('conversation not found');
      }
      res.status(200).json({ title: survivor.title, generated: false });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /conversation/:conversationId/file — document-in-chat (F-035 backend).
// ---------------------------------------------------------------------------

const FileBodySchema = z
  .object({
    // Multipart text field — coerce; bounded to INT4 like ImageBodySchema.
    expected_version: z.coerce.number().int().positive().max(2_147_483_647),
  })
  .strict();

/**
 * POST /conversation/:conversationId/file — multipart upload of one `file`
 * field (+ `expected_version`) attaching a TEXT document to a conversation.
 *
 * The document's (bounded) text becomes the appended user turn's `content` —
 * so projectHistory feeds it to Claude on the NEXT send with zero pipeline
 * changes — and the `file` block carries display metadata (name/size/type/
 * truncated). No blob store, no new table: see services/docAttach.ts's
 * header for the storage rationale and threat model (UTF-8 byte authority,
 * upload-time injection guard, 4000-char excerpt cap matching the proxy's
 * per-turn history limit). Images keep their dedicated /image path (Vision
 * OCR); PDFs are unsupported here by design.
 *
 * Mirrors /image's gates and ordering: ownership + version pre-check first
 * (404 IDOR / 409 stale before reading the payload does any work), document
 * validation next (typed 400/413, nothing persisted on failure), then ONE
 * version-gated UPDATE. No assistant turn is generated — the user sends a
 * message about the document next, exactly like the image flow.
 */
router.post(
  '/:conversationId/file',
  expensiveLimiter(),
  validateParams(MessageParamsSchema),
  multerDocUpload,
  validateBody(FileBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const conversationId = (req as typeof req & {
        validatedParams: z.infer<typeof MessageParamsSchema>;
      }).validatedParams.conversationId;
      const body = req.body as z.infer<typeof FileBodySchema>;
      const file = (req as Request & { file?: Express.Multer.File }).file;

      // Cheap gates first (same order as /image): the conversation must exist,
      // be the caller's, and be at the expected version.
      const { rows } = await query<{ version: number }>(
        `SELECT version
           FROM conversations
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [conversationId, userId],
      );
      const conv = rows[0];
      if (!conv) throw new NotFoundError('conversation not found');
      if (conv.version !== body.expected_version) {
        throw new ConflictError('stale conversation version');
      }

      // Validate + bound + injection-check the document (typed 400s; nothing
      // persisted on failure). Pure CPU — no external I/O, no transaction.
      const doc = ingestAttachedDocument(file);

      const fileTurn: StoredTurn = {
        role: 'user',
        content: doc.text,
        sent_at: new Date().toISOString(),
        file: {
          name: doc.name,
          media_type: doc.mediaType,
          size_bytes: doc.sizeBytes,
          truncated: doc.truncated,
        },
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
            JSON.stringify([fileTurn]),
            userId,
            body.expected_version,
          ],
        );
        if (upd.rowCount === 0) {
          throw new ConflictError('stale conversation version');
        }
        return {
          version: upd.rows[0]!.version,
          messages: upd.rows[0]!.messages,
          turn: fileTurn,
        };
      });

      res.status(201).json(out);
      req.log.info(
        { conversationId, userId, version: out.version, sizeBytes: doc.sizeBytes },
        'conversation file turn appended',
      );
    } catch (err) {
      next(err);
    }
  },
);

export default router;
