/**
 * Public API for the Claude proxy module.
 *
 * Everything outside `services/claude/**` imports from this file and
 * NOTHING ELSE. (Enforced by eslint no-restricted-imports for the
 * subpaths.) This file is the only contract B3 depends on; internal
 * structure can refactor freely without rippling.
 *
 * Architecture:
 *   request
 *     → public function (this file)
 *     → Zod input parse
 *     → sanitize (prompt-injection check)
 *     → rate limit
 *     → cache lookup (Postgres)
 *           hit  → Zod output parse → usage row (cache=true) → return
 *           miss → SDK call (via retry wrapper) → Zod output parse
 *                    → cache write → usage row (cache=false) → return
 *
 * Errors bubble up as typed `ClaudeProxyError` subclasses — the route
 * handler maps their `httpStatus` and `code` to the HTTP response. The
 * route handler does not need to know which error subclass it received,
 * only the contract on the base class.
 */

import { type Pool } from 'pg';
import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import { z, type ZodSchema } from 'zod';

import {
  PostgresCacheStore,
  type CacheKey,
  type CacheStore,
} from './cache';
import { ClaudeClient, type SdkLike } from './client';
import {
  type ClaudeModelId,
  loadConfig,
  type PublicClaudeConfig,
  type RouteName,
} from './config';
import {
  ClaudeInputValidationError,
  ClaudeOutputSchemaError,
  type ClaudeProxyError,
} from './errors';
import { getLogger } from './logger';
import {
  CallMetadataSchema,
  ConversationInputSchema,
  ConversationTurnSchema,
  DiagnosticItemInputSchema,
  DiagnosticItemResultSchema,
  EnrichmentInputSchema,
  EnrichmentResultSchema,
  GradeInputSchema,
  GradeResultSchema,
  GrammarRecognitionInputSchema,
  PatternResultSchema,
  type CallMetadata,
  type ConversationInput,
  type ConversationStreamEvent,
  type ConversationTurn,
  type DiagnosticItemInput,
  type DiagnosticItemResult,
  type EnrichmentInput,
  type EnrichmentResult,
  type GradeInput,
  type GradeResult,
  type GrammarRecognitionInput,
  type PatternResult,
  type ProxyResult,
} from './models';
import { buildConversationRequest } from './prompts/conversation';
import { buildDiagnosticItemRequest } from './prompts/diagnostic_item';
import { buildEnrichRequest } from './prompts/enrich';
import { buildGradeWritingRequest } from './prompts/grade_writing';
import { buildRecognizeGrammarRequest } from './prompts/recognize_grammar';
import { sanitizeUserInput } from './prompts/sanitize';
import { TokenBucketLimiter, type RateLimiter } from './rate_limit';
import { withRetry } from './retry';
import {
  PostgresUsageStore,
  computeCostUsd,
  type UsageStore,
} from './usage';

// Re-export the types B3 needs.
export type {
  CallMetadata,
  ConversationInput,
  ConversationStreamEvent,
  ConversationTurn,
  DiagnosticItemInput,
  DiagnosticItemResult,
  DiagnosticTargetLevel,
  EnrichmentInput,
  EnrichmentResult,
  GradeInput,
  GradeResult,
  GrammarRecognitionInput,
  PatternResult,
  ProficiencyLevel,
  ProxyResult,
} from './models';
export type { ClaudeModelId, RouteName } from './config';

export {
  ClaudeAuthError,
  ClaudeInputValidationError,
  ClaudeOutputSchemaError,
  ClaudePersistenceError,
  ClaudeProxyError,
  ClaudeRateLimitError,
  ClaudeUnavailableError,
  PromptInjectionRejectedError,
} from './errors';

// ---- Construction ---------------------------------------------------------

export interface ClaudeProxyDeps {
  /** Postgres pool — required for cache + usage tables. */
  readonly pool: Pool;
  /** Parent logger; we child-bind to it. Falls back to a standalone instance. */
  readonly logger?: Logger;
  /** Override the SDK (tests). */
  readonly sdk?: SdkLike;
  /** Override cache store (tests). */
  readonly cache?: CacheStore;
  /** Override usage store (tests). */
  readonly usage?: UsageStore;
  /** Override rate limiter (tests). */
  readonly rateLimiter?: RateLimiter;
}

export interface CallContext {
  /** Correlation ID propagated from the Express edge. */
  readonly requestId?: string;
  /** Authenticated user, if any. NULL = system call. */
  readonly userId?: number | null;
  /** Bucket key for rate limiting. Defaults to userId or 'anon'. */
  readonly bucketKey?: string;
  /**
   * Caller-controlled abort handle. When a route's client disconnects
   * mid-stream, the route aborts this signal; the proxy stops consuming
   * upstream tokens, the Anthropic SDK call rejects with an AbortError, and
   * the worker coroutine surfaces that as a terminal `error` event on the
   * queue + `final` rejection. Without this thread, a closed client never
   * stops the upstream spend — a real cost-amplification surface.
   */
  readonly signal?: AbortSignal;
}

export interface ClaudeProxy {
  enrich(input: EnrichmentInput, ctx?: CallContext): Promise<ProxyResult<EnrichmentResult>>;
  recognizeGrammarPattern(
    input: GrammarRecognitionInput,
    ctx?: CallContext,
  ): Promise<ProxyResult<PatternResult>>;
  gradeWriting(input: GradeInput, ctx?: CallContext): Promise<ProxyResult<GradeResult>>;
  /**
   * Author ONE multiple-choice diagnostic item (vocab or grammar) at a target
   * band. reading/listening items come from `topik_items`, not this method.
   */
  generateDiagnosticItem(
    input: DiagnosticItemInput,
    ctx?: CallContext,
  ): Promise<ProxyResult<DiagnosticItemResult>>;
  generateConversation(
    input: ConversationInput,
    ctx?: CallContext,
  ): {
    events: AsyncIterable<ConversationStreamEvent>;
    final: Promise<ProxyResult<ConversationTurn>>;
  };
  /** Periodic eviction. Idempotent; safe to call from a cron handler. */
  evictExpiredCache(): Promise<number>;
}

/** Factory. Single source of construction; B3 calls this once at boot. */
export function createClaudeProxy(deps: ClaudeProxyDeps): ClaudeProxy {
  // Loaded ONCE, at construction. Then injected into the impl. Per-method
  // re-reads (the previous pattern) coupled every method to the module-level
  // memoized config and made it possible for stale cached config to leak
  // between tests. See REVIEW_B4.md §S-3.
  const cfg = loadConfig();
  const logger = getLogger(deps.logger);
  const client = new ClaudeClient({ logger, ...(deps.sdk ? { sdk: deps.sdk } : {}) });
  const cache: CacheStore = deps.cache ?? new PostgresCacheStore(deps.pool, logger);
  const usage: UsageStore = deps.usage ?? new PostgresUsageStore(deps.pool, logger);
  const rateLimiter: RateLimiter =
    deps.rateLimiter ?? new TokenBucketLimiter(cfg.rateLimitPerMinute);

  return new ClaudeProxyImpl(cfg, client, cache, usage, rateLimiter, logger);
}

// ---- Implementation -------------------------------------------------------

const MODEL_ALIAS: Record<'haiku' | 'sonnet' | 'opus', ClaudeModelId> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
};

class ClaudeProxyImpl implements ClaudeProxy {
  constructor(
    private readonly cfg: PublicClaudeConfig,
    private readonly client: ClaudeClient,
    private readonly cache: CacheStore,
    private readonly usage: UsageStore,
    private readonly rateLimiter: RateLimiter,
    private readonly logger: Logger,
  ) {}

  async enrich(
    rawInput: EnrichmentInput,
    ctx: CallContext = {},
  ): Promise<ProxyResult<EnrichmentResult>> {
    const cfg = this.cfg;
    const route: RouteName = 'enrich';
    const input = parseInput(EnrichmentInputSchema, rawInput, route);
    const sanitizedSentence = sanitizeUserInput(input.sourceSentence, {
      maxLength: cfg.inputCaps.enrich,
    });
    const sanitizedContext = input.context
      ? sanitizeUserInput(input.context, { maxLength: cfg.inputCaps.enrich })
      : undefined;
    const cleaned: EnrichmentInput = {
      ...input,
      sourceSentence: sanitizedSentence,
      ...(sanitizedContext !== undefined ? { context: sanitizedContext } : {}),
    };
    const model = resolveModel(cfg, route, input.model);
    const req = buildEnrichRequest(cleaned, model);

    return this.runJsonRoute({
      route,
      model,
      ctx,
      request: req,
      cacheTtl: cfg.cacheTtlSeconds.enrich,
      outputSchema: EnrichmentResultSchema,
      parser: parseJsonContent,
    });
  }

  async recognizeGrammarPattern(
    rawInput: GrammarRecognitionInput,
    ctx: CallContext = {},
  ): Promise<ProxyResult<PatternResult>> {
    const cfg = this.cfg;
    const route: RouteName = 'recognize_grammar';
    const input = parseInput(GrammarRecognitionInputSchema, rawInput, route);
    const sentence = sanitizeUserInput(input.fullSentence, {
      maxLength: cfg.inputCaps.recognize_grammar,
    });
    const span = sanitizeUserInput(input.highlightSpan, {
      maxLength: cfg.inputCaps.recognize_grammar,
    });
    const cleaned: GrammarRecognitionInput = {
      ...input,
      fullSentence: sentence,
      highlightSpan: span,
    };
    const model = resolveModel(cfg, route, input.model);
    const req = buildRecognizeGrammarRequest(cleaned, model);

    return this.runJsonRoute({
      route,
      model,
      ctx,
      request: req,
      cacheTtl: cfg.cacheTtlSeconds.recognize_grammar,
      outputSchema: PatternResultSchema,
      parser: parseJsonContent,
    });
  }

  async gradeWriting(
    rawInput: GradeInput,
    ctx: CallContext = {},
  ): Promise<ProxyResult<GradeResult>> {
    const cfg = this.cfg;
    const route: RouteName = 'grade_writing';
    const input = parseInput(GradeInputSchema, rawInput, route);
    const sample = sanitizeUserInput(input.sample, {
      maxLength: cfg.inputCaps.grade_writing,
    });
    const cleaned: GradeInput = { ...input, sample };
    const model = resolveModel(cfg, route, input.model);
    const { request } = buildGradeWritingRequest(cleaned, model);

    return this.runJsonRoute({
      route,
      model,
      ctx,
      request,
      cacheTtl: cfg.cacheTtlSeconds.grade_writing,
      outputSchema: GradeResultSchema,
      parser: parseGradeToolResult,
    });
  }

  async generateDiagnosticItem(
    rawInput: DiagnosticItemInput,
    ctx: CallContext = {},
  ): Promise<ProxyResult<DiagnosticItemResult>> {
    const cfg = this.cfg;
    const route: RouteName = 'diagnostic_item';
    const input = parseInput(DiagnosticItemInputSchema, rawInput, route);
    // Sanitize every free-text seed field through the shared injection guard +
    // length cap. Seeds are corpus rows, not raw user text, but the wrapping is
    // defense-in-depth and the cap bounds prompt size.
    const seedKorean = sanitizeUserInput(input.seedKorean, {
      maxLength: cfg.inputCaps.diagnostic_item,
    });
    const seedEnglish =
      input.seedEnglish !== undefined
        ? sanitizeUserInput(input.seedEnglish, { maxLength: cfg.inputCaps.diagnostic_item })
        : undefined;
    const seedGloss =
      input.seedGloss !== undefined
        ? sanitizeUserInput(input.seedGloss, { maxLength: cfg.inputCaps.diagnostic_item })
        : undefined;
    const cleaned: DiagnosticItemInput = {
      ...input,
      seedKorean,
      ...(seedEnglish !== undefined ? { seedEnglish } : {}),
      ...(seedGloss !== undefined ? { seedGloss } : {}),
    };
    const model = resolveModel(cfg, route, input.model);
    const req = buildDiagnosticItemRequest(cleaned, model);

    return this.runJsonRoute({
      route,
      model,
      ctx,
      request: req,
      cacheTtl: cfg.cacheTtlSeconds.diagnostic_item,
      outputSchema: DiagnosticItemResultSchema,
      parser: parseJsonContent,
    });
  }

  generateConversation(
    rawInput: ConversationInput,
    ctx: CallContext = {},
  ): {
    events: AsyncIterable<ConversationStreamEvent>;
    final: Promise<ProxyResult<ConversationTurn>>;
  } {
    const cfg = this.cfg;
    const route: RouteName = 'generate_conversation';
    const input = parseInput(ConversationInputSchema, rawInput, route);
    const bucketKey =
      ctx.bucketKey ??
      (ctx.userId !== undefined && ctx.userId !== null ? String(ctx.userId) : 'anon');
    // NOTE: rate-limit is consumed AFTER the cache lookup below, so cache
    // hits don't burn the per-route Anthropic budget. The bucket name +
    // bucketKey are computed here so the worker coroutine can reference
    // them without a re-derive.

    const cleanedScenario = sanitizeUserInput(input.scenario, {
      maxLength: cfg.inputCaps.generate_conversation,
    });
    const cleanedHistory = input.history.map((h) => ({
      role: h.role,
      content: sanitizeUserInput(h.content, {
        maxLength: cfg.inputCaps.generate_conversation,
      }),
    }));
    const cleaned: ConversationInput = {
      ...input,
      scenario: cleanedScenario,
      history: cleanedHistory,
    };
    const model = resolveModel(cfg, route, input.model);
    const req = buildConversationRequest(cleaned, model);

    const requestId = ctx.requestId ?? randomUUID();
    const start = Date.now();

    const cacheKey: CacheKey = {
      route,
      model,
      systemText: stringifySystem(req.system),
      userText: JSON.stringify({
        scenario: cleaned.scenario,
        history: cleaned.history,
        vocabFocus: cleaned.vocabFocus,
        mode: cleaned.mode,
        registerTarget: cleaned.registerTarget,
      }),
    };

    // Shared mutable state between the event stream and the final promise.
    // The worker coroutine writes here; the consumer drains via a queue.
    const queue = new AsyncQueue<ConversationStreamEvent>();
    type WorkerOutcome =
      | { ok: true; turn: ConversationTurn; meta: Omit<CallMetadata, 'requestId' | 'model'> }
      | { ok: false; error: unknown };
    let outcomeResolver: (o: WorkerOutcome) => void = () => undefined;
    const outcomePromise = new Promise<WorkerOutcome>((res) => {
      outcomeResolver = res;
    });

    const self = this;
    void (async (): Promise<void> => {
      try {
        // Cache lookup first.
        const hit = await self.cache.get(cacheKey).catch((e) => {
          self.logger.warn({ errMsg: errMsg(e) }, 'conversation cache lookup failed');
          return null;
        });
        if (hit) {
          const parsed = safeParse(ConversationTurnSchema, hit.response);
          if (parsed.ok) {
            queue.push({ type: 'start', register: parsed.value.register });
            // Chunk the cached Korean output into pseudo-deltas so the SSE
            // consumer sees a streaming UX even on cache hits. Avoids the
            // proxy-buffer-overflow risk of a single multi-KB SSE frame
            // and matches the frontend's progressive-render expectation.
            for (const chunk of chunkForReplay(parsed.value.korean)) {
              queue.push({ type: 'delta', text: chunk });
            }
            queue.push({ type: 'complete', turn: parsed.value });
            queue.end();
            const latencyMs = Date.now() - start;
            outcomeResolver({
              ok: true,
              turn: parsed.value,
              meta: {
                cacheHit: true,
                latencyMs,
                inputTokens: 0,
                outputTokens: 0,
                cachedInputTokens: 0,
                cacheCreationInputTokens: 0,
                costEstimateUsd: 0,
              },
            });
            return;
          }
          self.logger.warn({ route }, 'conversation cache row failed schema; refreshing');
        }

        // Cache miss — consume the rate-limit budget BEFORE calling the SDK.
        // (Hits intentionally skip the limiter; see ADR-020 §5.)
        self.rateLimiter.consume(route, bucketKey);

        // Go to the SDK. Stream returns events + final. Threads the
        // caller's abort signal so a closed client stops the upstream
        // spend immediately (REVIEW_P3A BL-1, A-B1 fix).
        const { events: sdkEvents, final: sdkFinal } = self.client.stream(
          req,
          ctx.signal,
        );
        queue.push({ type: 'start', register: cleaned.registerTarget });
        for await (const ev of sdkEvents) {
          if (ev.kind === 'delta' && typeof ev.text === 'string' && ev.text.length > 0) {
            queue.push({ type: 'delta', text: ev.text });
          }
        }
        const finalResp = await sdkFinal;
        const parsed = safeParse(
          ConversationTurnSchema,
          parseJsonContent(finalResp),
        );
        if (!parsed.ok) {
          throw new ClaudeOutputSchemaError(
            `conversation output failed schema: ${parsed.errors}`,
          );
        }
        queue.push({ type: 'complete', turn: parsed.value });
        queue.end();

        // Cache write — soft failure.
        try {
          await self.cache.put(
            cacheKey,
            parsed.value,
            cfg.cacheTtlSeconds.generate_conversation,
          );
        } catch (e) {
          self.logger.warn({ errMsg: errMsg(e) }, 'conversation cache write failed');
        }

        const latencyMs = Date.now() - start;
        const cost = computeCostUsd(
          model,
          finalResp.usage.inputTokens,
          finalResp.usage.cachedInputTokens,
          finalResp.usage.cacheCreationInputTokens,
          finalResp.usage.outputTokens,
        );
        outcomeResolver({
          ok: true,
          turn: parsed.value,
          meta: {
            cacheHit: false,
            latencyMs,
            inputTokens: finalResp.usage.inputTokens,
            outputTokens: finalResp.usage.outputTokens,
            cachedInputTokens: finalResp.usage.cachedInputTokens,
            cacheCreationInputTokens: finalResp.usage.cacheCreationInputTokens,
            costEstimateUsd: cost,
          },
        });
      } catch (e) {
        const proxyErr = e as ClaudeProxyError;
        const code = typeof proxyErr?.code === 'string' ? proxyErr.code : 'UnknownError';
        const message = e instanceof Error ? e.message : String(e);
        queue.push({ type: 'error', code, message });
        queue.end();
        outcomeResolver({ ok: false, error: e });
      }
    })();

    const finalPromise: Promise<ProxyResult<ConversationTurn>> = (async () => {
      const outcome = await outcomePromise;
      if (!outcome.ok) {
        // Bubble the original error type.
        throw outcome.error;
      }
      // Best-effort usage write.
      await self.recordUsageSoft({
        requestId,
        userId: ctx.userId ?? null,
        route,
        model,
        wasCacheHit: outcome.meta.cacheHit,
        inputTokens: outcome.meta.inputTokens,
        outputTokens: outcome.meta.outputTokens,
        cachedInputTokens: outcome.meta.cachedInputTokens,
        cacheCreationInputTokens: outcome.meta.cacheCreationInputTokens,
        latencyMs: outcome.meta.latencyMs,
        costEstimateUsd: outcome.meta.costEstimateUsd,
      });
      self.logger.info(
        {
          requestId,
          route,
          model,
          cacheHit: outcome.meta.cacheHit,
          latencyMs: outcome.meta.latencyMs,
          costEstimateUsd: outcome.meta.costEstimateUsd,
        },
        'conversation call complete',
      );
      return {
        result: outcome.turn,
        metadata: CallMetadataSchema.parse({
          requestId,
          model,
          ...outcome.meta,
        }),
      };
    })();

    return { events: queue.iter(), final: finalPromise };
  }

  async evictExpiredCache(): Promise<number> {
    return this.cache.evictExpired();
  }

  /** Internal: cache-then-call wrapper for non-streaming JSON routes. */
  private async runJsonRoute<TResult>(p: {
    route: RouteName;
    model: ClaudeModelId;
    ctx: CallContext;
    request: import('./client').MessageRequest;
    cacheTtl: number;
    outputSchema: ZodSchema<TResult>;
    parser: (raw: import('./client').MessageResponse) => unknown;
  }): Promise<ProxyResult<TResult>> {
    const cfg = this.cfg;
    const requestId = p.ctx.requestId ?? randomUUID();
    const bucketKey =
      p.ctx.bucketKey ??
      (p.ctx.userId !== undefined && p.ctx.userId !== null ? String(p.ctx.userId) : 'anon');
    // NOTE: rate-limit is consumed AFTER the cache lookup below so cache
    // hits don't burn the per-route budget. See ADR-020 §5.

    const cacheKey: CacheKey = {
      route: p.route,
      model: p.model,
      systemText: stringifySystem(p.request.system),
      userText: serializeMessages(p.request.messages),
    };

    const start = Date.now();

    // ---- Cache lookup ----
    try {
      const hit = await this.cache.get(cacheKey);
      if (hit) {
        const parsed = safeParse(p.outputSchema, hit.response);
        if (parsed.ok) {
          const latencyMs = Date.now() - start;
          await this.recordUsageSoft({
            requestId,
            userId: p.ctx.userId ?? null,
            route: p.route,
            model: p.model,
            wasCacheHit: true,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 0,
            latencyMs,
          });
          this.logger.info(
            {
              requestId,
              route: p.route,
              model: p.model,
              cacheHit: true,
              latencyMs,
            },
            'claude call served from cache',
          );
          return {
            result: parsed.value,
            metadata: CallMetadataSchema.parse({
              requestId,
              model: p.model,
              cacheHit: true,
              latencyMs,
              inputTokens: 0,
              outputTokens: 0,
              cachedInputTokens: 0,
              cacheCreationInputTokens: 0,
              costEstimateUsd: 0,
            }),
          };
        }
        this.logger.warn(
          { route: p.route },
          'cache row failed schema parse; falling back to API',
        );
      }
    } catch (e) {
      this.logger.warn({ errMsg: errMsg(e) }, 'cache lookup raised; falling back to API');
    }

    // ---- Rate-limit (cache miss only) ----
    // Consumed here, AFTER the cache lookup, so a flood of repeated taps
    // on the same lemma doesn't exhaust the per-route Anthropic budget.
    this.rateLimiter.consume(p.route, bucketKey);

    // ---- Anthropic call (with retry) ----
    const response = await withRetry(() => this.client.createMessage(p.request), {
      maxAttempts: cfg.retry.maxAttempts,
      baseMs: cfg.retry.baseMs,
      maxDelayMs: cfg.retry.maxDelayMs,
      logger: this.logger,
      route: p.route,
    });

    const rawParsed = p.parser(response);
    const parsed = safeParse(p.outputSchema, rawParsed);
    if (!parsed.ok) {
      this.logger.error(
        { route: p.route, model: p.model, errs: parsed.errors },
        'claude output failed Zod parse',
      );
      throw new ClaudeOutputSchemaError(
        `${p.route} output failed schema: ${parsed.errors}`,
      );
    }

    // ---- Cache write (soft failure) ----
    try {
      await this.cache.put(cacheKey, parsed.value, p.cacheTtl);
    } catch (e) {
      this.logger.warn(
        { errMsg: errMsg(e), route: p.route },
        'cache write failed; continuing',
      );
    }

    const latencyMs = Date.now() - start;
    const cost = computeCostUsd(
      p.model,
      response.usage.inputTokens,
      response.usage.cachedInputTokens,
      response.usage.cacheCreationInputTokens,
      response.usage.outputTokens,
    );

    await this.recordUsageSoft({
      requestId,
      userId: p.ctx.userId ?? null,
      route: p.route,
      model: p.model,
      wasCacheHit: false,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
      cacheCreationInputTokens: response.usage.cacheCreationInputTokens,
      latencyMs,
      costEstimateUsd: cost,
    });

    this.logger.info(
      {
        requestId,
        route: p.route,
        model: p.model,
        cacheHit: false,
        latencyMs,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cachedInputTokens: response.usage.cachedInputTokens,
        cacheCreationInputTokens: response.usage.cacheCreationInputTokens,
        costEstimateUsd: cost,
      },
      'claude call complete',
    );

    return {
      result: parsed.value,
      metadata: CallMetadataSchema.parse({
        requestId,
        model: p.model,
        cacheHit: false,
        latencyMs,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cachedInputTokens: response.usage.cachedInputTokens,
        cacheCreationInputTokens: response.usage.cacheCreationInputTokens,
        costEstimateUsd: cost,
      }),
    };
  }

  private async recordUsageSoft(rec: Parameters<UsageStore['record']>[0]): Promise<void> {
    try {
      await this.usage.record(rec);
    } catch (e) {
      this.logger.warn(
        { errMsg: errMsg(e), route: rec.route, requestId: rec.requestId },
        'usage row write failed; call result is still returned',
      );
    }
  }
}

// ---- Helpers ---------------------------------------------------------------

function parseInput<T>(schema: ZodSchema<T>, raw: unknown, route: RouteName): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ClaudeInputValidationError(
      `${route} input failed validation: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}=${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

function resolveModel(
  cfg: PublicClaudeConfig,
  route: RouteName,
  override: 'haiku' | 'sonnet' | 'opus' | undefined,
): ClaudeModelId {
  if (override !== undefined) {
    return MODEL_ALIAS[override];
  }
  return cfg.modelDefaults[route];
}

function stringifySystem(
  system: import('./client').ContentBlock[] | undefined,
): string {
  if (!system) return '';
  return system.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

function serializeMessages(
  messages: import('./client').MessageRequest['messages'],
): string {
  return JSON.stringify(
    messages.map((m) => ({
      role: m.role,
      content: m.content.map((c) =>
        c.type === 'text' ? { type: 'text', text: c.text } : c,
      ),
    })),
  );
}

interface ParseOk<T> {
  readonly ok: true;
  readonly value: T;
}
interface ParseErr {
  readonly ok: false;
  readonly errors: string;
}
function safeParse<T>(schema: ZodSchema<T>, raw: unknown): ParseOk<T> | ParseErr {
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.join('.')}=${i.message}`).join('; '),
  };
}

function parseJsonContent(resp: import('./client').MessageResponse): unknown {
  const text = resp.text.trim();
  if (text.length === 0) {
    return { __parse_error__: 'model returned empty text' };
  }
  // Strip ``` fences if the model added them despite the instruction.
  const stripped = text.replace(/^```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {
    return { __parse_error__: 'model returned non-JSON text', raw: stripped.slice(0, 200) };
  }
}

function parseGradeToolResult(resp: import('./client').MessageResponse): unknown {
  const submit = resp.toolUses.find((t) => t.name === 'submit_grade');
  if (!submit) {
    return { __parse_error__: 'grade response did not call submit_grade tool' };
  }
  const input = submit.input as Record<string, unknown>;
  // Convert tool's snake_case fields into the Zod schema's camelCase.
  return {
    rubric: input.rubric,
    content: input.content,
    organization: input.organization,
    languageUse: input.language_use,
    totalScore: input.total_score,
    maxTotal: input.max_total,
    estimatedLevel: input.estimated_level,
    overallComment: input.overall_comment,
  };
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Split a cached Korean response into pseudo-stream chunks for SSE replay.
 *
 * On a cache hit the original token stream is gone, so a naïve replay would
 * push one giant `delta` event containing the full text. That has two
 * downsides:
 *   1. The SSE consumer loses the token-by-token UX promise.
 *   2. A multi-paragraph response could exceed proxy frame buffers (e.g.,
 *      Cloudflare's default 100 KB).
 *
 * We chunk on sentence-like boundaries (Korean punctuation `.`, `?`, `!`,
 * `…`, plus newlines) and cap each chunk at MAX_CHUNK_CHARS to bound frame
 * size. The split is best-effort: short responses become one chunk; long
 * responses become several. We do NOT introduce real-time delays — the
 * frontend can pace its own render if it wants to.
 */
const MAX_CHUNK_CHARS = 256;
export function chunkForReplay(text: string): readonly string[] {
  if (text.length === 0) return [''];
  if (text.length <= MAX_CHUNK_CHARS) return [text];

  const out: string[] = [];
  let buf = '';
  // Walk grapheme-friendly via code units; Korean text under NFC is two
  // bytes per syllable but one code unit, so this is safe for length math.
  for (let i = 0; i < text.length; i += 1) {
    buf += text[i];
    const isBoundary = /[.?!…\n]/.test(text[i]!);
    if (isBoundary && buf.length >= 32) {
      out.push(buf);
      buf = '';
    } else if (buf.length >= MAX_CHUNK_CHARS) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

// ---- AsyncQueue -----------------------------------------------------------
// Simple single-producer, single-consumer queue with async iteration.
// The worker `push`es events; the consumer iterates via `iter()`.
// Calling `end()` signals "no more events" and the iterator drains.

class AsyncQueue<T> {
  private readonly buffer: T[] = [];
  private done = false;
  private resolver: ((v: IteratorResult<T>) => void) | null = null;

  push(value: T): void {
    if (this.done) return;
    if (this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      r({ value, done: false });
      return;
    }
    this.buffer.push(value);
  }

  end(): void {
    this.done = true;
    if (this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      r({ value: undefined as unknown as T, done: true });
    }
  }

  iter(): AsyncIterable<T> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterableIterator<T> {
        return {
          next(): Promise<IteratorResult<T>> {
            if (self.buffer.length > 0) {
              const value = self.buffer.shift()!;
              return Promise.resolve({ value, done: false });
            }
            if (self.done) {
              return Promise.resolve({ value: undefined as unknown as T, done: true });
            }
            return new Promise<IteratorResult<T>>((resolve) => {
              self.resolver = resolve;
            });
          },
          [Symbol.asyncIterator](): AsyncIterableIterator<T> {
            return this;
          },
        };
      },
    };
  }
}

// Suppress unused import warnings for re-exported Zod types.
void z;
