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
import { z } from 'zod';

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
  GrammarDrillGenInputSchema,
  GrammarDrillItemSchema,
  GrammarDrillScoreInputSchema,
  GrammarDrillScoreSchema,
  GrammarRecognitionInputSchema,
  ImageOcrInputSchema,
  ImageOcrResultSchema,
  NameConversationInputSchema,
  ConversationTitleSchema,
  PatternResultSchema,
  ReadingComprehensionInputSchema,
  ReadingComprehensionResultSchema,
  StoryGenInputSchema,
  StoryImagePromptsInputSchema,
  StoryImagePromptsResultSchema,
  StoryResultSchema,
  TranslatePassageInputSchema,
  TranslatePassageResultSchema,
  WritingPromptGenInputSchema,
  WritingPromptResultSchema,
  type CallMetadata,
  type ConversationInput,
  type ConversationStreamEvent,
  type ConversationTitle,
  type ConversationTurn,
  type DiagnosticItemInput,
  type DiagnosticItemResult,
  type EnrichmentInput,
  type EnrichmentResult,
  type GradeInput,
  type GradeResult,
  type GrammarDrillGenInput,
  type GrammarDrillItem,
  type GrammarDrillScore,
  type GrammarDrillScoreInput,
  type GrammarRecognitionInput,
  type ImageOcrInput,
  type ImageOcrResult,
  type NameConversationInput,
  type PatternResult,
  type ProxyResult,
  type ReadingComprehensionInput,
  type ReadingComprehensionResult,
  type StoryGenInput,
  type StoryImagePromptsInput,
  type StoryImagePromptsResult,
  type StoryResult,
  type TranslatePassageInput,
  type TranslatePassageResult,
  type WritingPromptGenInput,
  type WritingPromptResult,
} from './models';
import { buildConversationRequest } from './prompts/conversation';
import { buildNameConversationRequest } from './prompts/name_conversation';
import { buildDiagnosticItemRequest } from './prompts/diagnostic_item';
import { buildEnrichRequest } from './prompts/enrich';
import { buildGradeWritingRequest } from './prompts/grade_writing';
import {
  buildGrammarDrillGenRequest,
  buildGrammarDrillScoreRequest,
} from './prompts/grammar_drill';
import { buildStoryRequest, buildWritingPromptRequest } from './prompts/generation';
import { buildStoryImagePromptsRequest } from './prompts/story_image_prompts';
import { buildImageOcrRequest } from './prompts/image_ocr';
import { buildReadingComprehensionRequest } from './prompts/reading_comprehension';
import { buildRecognizeGrammarRequest } from './prompts/recognize_grammar';
import { buildTranslatePassageRequest } from './prompts/translate_passage';
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
  ConversationTitle,
  ConversationTurn,
  DiagnosticItemInput,
  DiagnosticItemResult,
  DiagnosticTargetLevel,
  EnrichmentInput,
  EnrichmentResult,
  GradeInput,
  GradeResult,
  GrammarDrillGenInput,
  GrammarDrillItem,
  GrammarDrillScore,
  GrammarDrillScoreInput,
  DrillType,
  DrillVerdict,
  GrammarRecognitionInput,
  ImageOcrInput,
  ImageOcrResult,
  ImageOcrWord,
  NameConversationInput,
  PatternResult,
  ProficiencyLevel,
  ProxyResult,
  ReadingComprehensionInput,
  ReadingComprehensionQuestion,
  ReadingComprehensionResult,
  ReadingQuestionOption,
  StoryGenInput,
  StoryImageCharacter,
  StoryImagePromptsInput,
  StoryImagePromptsResult,
  StoryLevel,
  StoryResult,
  StoryTurn,
  TranslatePassageInput,
  TranslatePassageResult,
  WritingPromptGenInput,
  WritingPromptMode,
  WritingPromptResult,
} from './models';
export type { ClaudeModelId, RouteName } from './config';
// Shared prompt-injection guard — exported so route layers that PERSIST
// user-supplied text into future Claude history (e.g. the chat document-attach
// path) can reject poisoned content at the boundary instead of storing a turn
// that would make every later generateConversation call fail its sanitize.
export { sanitizeUserInput } from './prompts/sanitize';

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
  /**
   * Run OCR + vocab-mining on ONE uploaded photo. The user message carries an
   * IMAGE content block (base64). Returns a caption + the distinct content
   * words (NO bounding boxes — locked decision). Not cached (cacheTtl 0): image
   * bytes make a poor cache key and the same photo is rarely re-uploaded.
   */
  ocrImage(input: ImageOcrInput, ctx?: CallContext): Promise<ProxyResult<ImageOcrResult>>;
  /**
   * Author ONE grammar PRODUCTION drill of an explicit type (the route picks the
   * type from attempt history — rotation — and passes it; the model never
   * chooses). Tool-use forced; the returned item INCLUDES the reference model
   * answer, which the route strips before responding (answer-stripping).
   */
  generateGrammarDrill(
    input: GrammarDrillGenInput,
    ctx?: CallContext,
  ): Promise<ProxyResult<GrammarDrillItem>>;
  /**
   * Score a learner's grammar production against the target pattern + reference
   * model. Tool-use forced; reproducible (temperature 0).
   */
  scoreGrammarDrill(
    input: GrammarDrillScoreInput,
    ctx?: CallContext,
  ): Promise<ProxyResult<GrammarDrillScore>>;
  /**
   * Author ONE writing prompt (F-027/F-073): TOPIK II Q53/Q54-style when
   * mode='topik' (per the rubric), else a general free-write prompt. Tool-use
   * forced; EPHEMERAL — the caller returns it inline and persists nothing (the
   * learner's response persists later via writing_attempts).
   */
  generateWritingPrompt(
    input: WritingPromptGenInput,
    ctx?: CallContext,
  ): Promise<ProxyResult<WritingPromptResult>>;
  /**
   * Author ONE short Korean story at a proficiency band, optionally about a
   * user-supplied topic (F-068). Tool-use forced; the ROUTE persists the
   * result to generated_stories (migration 054) — this method only generates.
   */
  generateStory(
    input: StoryGenInput,
    ctx?: CallContext,
  ): Promise<ProxyResult<StoryResult>>;
  /**
   * F-116: translate ONE Korean passage/paragraph into natural English
   * (Reading.tsx's `TranslateSheet`). Tool-use forced; STATELESS — the route
   * persists nothing. Unlike `generateStory` (deliberate variety), this
   * runs at low temperature and IS cached (long TTL) — translating the same
   * given passage twice should return the same answer, not a fresh roll.
   */
  translatePassage(
    input: TranslatePassageInput,
    ctx?: CallContext,
  ): Promise<ProxyResult<TranslatePassageResult>>;
  /**
   * F-211: author the illustration prompt set for ONE generated story — a
   * fixed Korean-webtoon style directive, a shared character sheet, and 2-4
   * self-contained key-scene prompts (style + characters + copyright-clean
   * guardrails baked into each). Tool-use forced; low temperature and CACHED
   * with a long TTL (deterministic per story — a retry after an
   * image-provider failure reuses the same scenes at $0). The story-image
   * runner is the only caller.
   */
  generateStoryImagePrompts(
    input: StoryImagePromptsInput,
    ctx?: CallContext,
  ): Promise<ProxyResult<StoryImagePromptsResult>>;
  /**
   * F-205: author 3-5 multiple-choice comprehension questions from a reading
   * chapter's Korean prose — Korean stem, exactly 4 options with exactly one
   * correct (Zod refine — a violating reply is a 502, never a row), bilingual
   * explanation. Tool-use forced; the ROUTE persists the set to
   * reading_questions (migration 086) — that table is the generate-once
   * cache, so this route's proxy cacheTtl is 0 (a regenerate rolls fresh).
   */
  generateReadingComprehension(
    input: ReadingComprehensionInput,
    ctx?: CallContext,
  ): Promise<ProxyResult<ReadingComprehensionResult>>;
  generateConversation(
    input: ConversationInput,
    ctx?: CallContext,
  ): {
    events: AsyncIterable<ConversationStreamEvent>;
    final: Promise<ProxyResult<ConversationTurn>>;
  };
  /**
   * F-036: derive a concise, content-based title for a conversation from its
   * opening exchange (Claude-web style). Non-streaming, haiku-tier default,
   * not cached (unique key per conversation; the route's title-IS-NULL guard
   * makes repeats free).
   */
  nameConversation(
    input: NameConversationInput,
    ctx?: CallContext,
  ): Promise<ProxyResult<ConversationTitle>>;
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

  async ocrImage(
    rawInput: ImageOcrInput,
    ctx: CallContext = {},
  ): Promise<ProxyResult<ImageOcrResult>> {
    const cfg = this.cfg;
    const route: RouteName = 'image_ocr';
    // The only user-controlled input is the image BYTES (validated upstream by
    // the route's magic-byte sniff + size cap) plus the media type. There is no
    // free TEXT to run through the prompt-injection sanitizer; the instruction
    // is entirely static. We still validate the base64/mediaType shape here so a
    // malformed call fails as a 400 (ClaudeInputValidationError), not deep in
    // the SDK. The cap on imageBase64 length is the schema's secondary ceiling.
    const input = parseInput(ImageOcrInputSchema, rawInput, route);
    const model = resolveModel(cfg, route, input.model);
    const req = buildImageOcrRequest(
      { imageBase64: input.imageBase64, mediaType: input.mediaType },
      model,
    );

    // cacheTtl 0 (image bytes are a useless cache key). runJsonRoute still
    // computes a cache key, but serializeMessages substitutes a placeholder for
    // the base64 payload, and a 0 TTL write is effectively a no-op / immediate
    // expiry — the lookup never returns a hit for a fresh image.
    return this.runJsonRoute({
      route,
      model,
      ctx,
      request: req,
      cacheTtl: cfg.cacheTtlSeconds.image_ocr,
      outputSchema: ImageOcrResultSchema,
      parser: parseJsonContent,
    });
  }

  async generateGrammarDrill(
    rawInput: GrammarDrillGenInput,
    ctx: CallContext = {},
  ): Promise<ProxyResult<GrammarDrillItem>> {
    const cfg = this.cfg;
    const route: RouteName = 'generate_grammar_drill';
    const input = parseInput(GrammarDrillGenInputSchema, rawInput, route);
    // Sanitize every free-text field through the shared injection guard + length
    // cap. patternKey/patternDisplay are corpus rows, but meaning/example are
    // closer to free text; wrapping ALL of them is defense-in-depth and the cap
    // bounds the prompt. drillType is a closed enum (not sanitized).
    const cap = cfg.inputCaps.generate_grammar_drill;
    const patternKey = sanitizeUserInput(input.patternKey, { maxLength: cap });
    const patternDisplay = sanitizeUserInput(input.patternDisplay, { maxLength: cap });
    const meaning =
      input.meaning !== undefined
        ? sanitizeUserInput(input.meaning, { maxLength: cap })
        : undefined;
    const exampleKr =
      input.exampleKr !== undefined
        ? sanitizeUserInput(input.exampleKr, { maxLength: cap })
        : undefined;
    const exampleEn =
      input.exampleEn !== undefined
        ? sanitizeUserInput(input.exampleEn, { maxLength: cap })
        : undefined;
    const cleaned: GrammarDrillGenInput = {
      ...input,
      patternKey,
      patternDisplay,
      ...(meaning !== undefined ? { meaning } : {}),
      ...(exampleKr !== undefined ? { exampleKr } : {}),
      ...(exampleEn !== undefined ? { exampleEn } : {}),
    };
    const model = resolveModel(cfg, route, input.model);
    const { request } = buildGrammarDrillGenRequest(cleaned, model);

    return this.runJsonRoute({
      route,
      model,
      ctx,
      request,
      cacheTtl: cfg.cacheTtlSeconds.generate_grammar_drill,
      outputSchema: GrammarDrillItemSchema,
      parser: parseToolResult('submit_drill'),
    });
  }

  async scoreGrammarDrill(
    rawInput: GrammarDrillScoreInput,
    ctx: CallContext = {},
  ): Promise<ProxyResult<GrammarDrillScore>> {
    const cfg = this.cfg;
    const route: RouteName = 'score_grammar_drill';
    const input = parseInput(GrammarDrillScoreInputSchema, rawInput, route);
    const cap = cfg.inputCaps.score_grammar_drill;
    // The learner's answer + the rendered task + the reference are all free text;
    // sanitize each (the answer is the highest-risk field — it is raw user text).
    const patternDisplay = sanitizeUserInput(input.patternDisplay, { maxLength: cap });
    const promptText = sanitizeUserInput(input.promptText, { maxLength: cap });
    const referenceModelKr = sanitizeUserInput(input.referenceModelKr, { maxLength: cap });
    const userAnswer = sanitizeUserInput(input.userAnswer, { maxLength: cap });
    const cleaned: GrammarDrillScoreInput = {
      ...input,
      patternDisplay,
      promptText,
      referenceModelKr,
      userAnswer,
    };
    const model = resolveModel(cfg, route, input.model);
    const { request } = buildGrammarDrillScoreRequest(cleaned, model);

    return this.runJsonRoute({
      route,
      model,
      ctx,
      request,
      cacheTtl: cfg.cacheTtlSeconds.score_grammar_drill,
      outputSchema: GrammarDrillScoreSchema,
      parser: parseToolResult('submit_drill_score'),
    });
  }

  async generateWritingPrompt(
    rawInput: WritingPromptGenInput,
    ctx: CallContext = {},
  ): Promise<ProxyResult<WritingPromptResult>> {
    const cfg = this.cfg;
    const route: RouteName = 'generate_writing_prompt';
    // mode/rubric are closed enums — the Zod parse IS the sanitization (no
    // free-text field rides this input, so nothing to run through
    // sanitizeUserInput; the inputCap exists for a hypothetical future field).
    const input = parseInput(WritingPromptGenInputSchema, rawInput, route);
    const model = resolveModel(cfg, route, input.model);
    const request = buildWritingPromptRequest(input, model);

    return this.runJsonRoute({
      route,
      model,
      ctx,
      request,
      cacheTtl: cfg.cacheTtlSeconds.generate_writing_prompt,
      outputSchema: WritingPromptResultSchema,
      parser: parseToolResult('submit_writing_prompt'),
    });
  }

  async generateStory(
    rawInput: StoryGenInput,
    ctx: CallContext = {},
  ): Promise<ProxyResult<StoryResult>> {
    const cfg = this.cfg;
    const route: RouteName = 'generate_story';
    const input = parseInput(StoryGenInputSchema, rawInput, route);
    // The topic is the only free-text (user-controlled) field — run it through
    // the shared injection guard + length cap. level is a closed enum.
    const topic =
      input.topic !== undefined
        ? sanitizeUserInput(input.topic, { maxLength: cfg.inputCaps.generate_story })
        : undefined;
    const cleaned: StoryGenInput = {
      ...input,
      ...(topic !== undefined ? { topic } : {}),
    };
    const model = resolveModel(cfg, route, input.model);
    const request = buildStoryRequest(cleaned, model);

    return this.runJsonRoute({
      route,
      model,
      ctx,
      request,
      cacheTtl: cfg.cacheTtlSeconds.generate_story,
      outputSchema: StoryResultSchema,
      parser: parseToolResult('submit_story'),
    });
  }

  async translatePassage(
    rawInput: TranslatePassageInput,
    ctx: CallContext = {},
  ): Promise<ProxyResult<TranslatePassageResult>> {
    const cfg = this.cfg;
    const route: RouteName = 'translate_passage';
    const input = parseInput(TranslatePassageInputSchema, rawInput, route);
    // The passage is the only free text — run it through the shared
    // injection guard + length cap.
    const passage = sanitizeUserInput(input.passage, {
      maxLength: cfg.inputCaps.translate_passage,
    });
    const cleaned: TranslatePassageInput = { ...input, passage };
    const model = resolveModel(cfg, route, input.model);
    const request = buildTranslatePassageRequest(cleaned, model);

    return this.runJsonRoute({
      route,
      model,
      ctx,
      request,
      cacheTtl: cfg.cacheTtlSeconds.translate_passage,
      outputSchema: TranslatePassageResultSchema,
      parser: parseToolResult('submit_translation'),
    });
  }

  async generateStoryImagePrompts(
    rawInput: StoryImagePromptsInput,
    ctx: CallContext = {},
  ): Promise<ProxyResult<StoryImagePromptsResult>> {
    const cfg = this.cfg;
    const route: RouteName = 'story_image_prompts';
    const input = parseInput(StoryImagePromptsInputSchema, rawInput, route);
    const cap = cfg.inputCaps.story_image_prompts;
    // The title/body are model-generated but user-STEERED text (the story
    // topic is user free text) — run both through the shared injection
    // guard + length cap, exactly like translate_passage's passage. Speaker
    // names (the only turn field the builder renders) get the same
    // treatment; turn TEXT never rides the request.
    const title = sanitizeUserInput(input.title, { maxLength: cap });
    const bodyKo = sanitizeUserInput(input.bodyKo, { maxLength: cap });
    const turns = input.turns?.map((t) => ({
      ...t,
      speaker: sanitizeUserInput(t.speaker, { maxLength: cap }),
    }));
    const cleaned: StoryImagePromptsInput = {
      ...input,
      title,
      bodyKo,
      ...(turns !== undefined ? { turns } : {}),
    };
    const model = resolveModel(cfg, route, input.model);
    const request = buildStoryImagePromptsRequest(cleaned, model);

    return this.runJsonRoute({
      route,
      model,
      ctx,
      request,
      cacheTtl: cfg.cacheTtlSeconds.story_image_prompts,
      outputSchema: StoryImagePromptsResultSchema,
      parser: parseToolResult('submit_image_prompts'),
    });
  }

  async generateReadingComprehension(
    rawInput: ReadingComprehensionInput,
    ctx: CallContext = {},
  ): Promise<ProxyResult<ReadingComprehensionResult>> {
    const cfg = this.cfg;
    const route: RouteName = 'reading_comprehension';
    const input = parseInput(ReadingComprehensionInputSchema, rawInput, route);
    const cap = cfg.inputCaps.reading_comprehension;
    // The prose (and optional title) are OCR'd + curated book content — not
    // raw user free text, but attacker-influenceable in principle (a
    // poisoned upload), so both get translate_passage's exact treatment:
    // shared injection guard + length cap here, <user_input> wrap in the
    // builder. questionCount is a bounded integer (not sanitized).
    const prose = sanitizeUserInput(input.prose, { maxLength: cap });
    const chapterTitle =
      input.chapterTitle !== undefined
        ? sanitizeUserInput(input.chapterTitle, { maxLength: cap })
        : undefined;
    const cleaned: ReadingComprehensionInput = {
      ...input,
      prose,
      ...(chapterTitle !== undefined ? { chapterTitle } : {}),
    };
    const model = resolveModel(cfg, route, input.model);
    const request = buildReadingComprehensionRequest(cleaned, model);

    return this.runJsonRoute({
      route,
      model,
      ctx,
      request,
      cacheTtl: cfg.cacheTtlSeconds.reading_comprehension,
      outputSchema: ReadingComprehensionResultSchema,
      parser: parseToolResult('submit_comprehension_questions'),
    });
  }

  async nameConversation(
    rawInput: NameConversationInput,
    ctx: CallContext = {},
  ): Promise<ProxyResult<ConversationTitle>> {
    const cfg = this.cfg;
    const route: RouteName = 'name_conversation';
    const input = parseInput(NameConversationInputSchema, rawInput, route);
    // Every turn is free user/assistant text — run each through the shared
    // injection guard + length cap. The route truncates before calling, so the
    // cap here is the hard ceiling, not the working size.
    const cleanedHistory = input.history.map((h) => ({
      role: h.role,
      content: sanitizeUserInput(h.content, {
        maxLength: cfg.inputCaps.name_conversation,
      }),
    }));
    const cleaned: NameConversationInput = {
      ...input,
      history: cleanedHistory,
    };
    const model = resolveModel(cfg, route, input.model);
    const req = buildNameConversationRequest(cleaned, model);

    return this.runJsonRoute({
      route,
      model,
      ctx,
      request: req,
      cacheTtl: cfg.cacheTtlSeconds.name_conversation,
      outputSchema: ConversationTitleSchema,
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

    // Arrow IIFE — `this` is captured lexically, no `self` alias needed.
    void (async (): Promise<void> => {
      try {
        // Cache lookup first.
        const hit = await this.cache.get(cacheKey).catch((e) => {
          this.logger.warn({ errMsg: errMsg(e) }, 'conversation cache lookup failed');
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
          this.logger.warn({ route }, 'conversation cache row failed schema; refreshing');
        }

        // Cache miss — consume the rate-limit budget BEFORE calling the SDK.
        // (Hits intentionally skip the limiter; see ADR-020 §5.)
        this.rateLimiter.consume(route, bucketKey);

        // Go to the SDK. Stream returns events + final. Threads the
        // caller's abort signal so a closed client stops the upstream
        // spend immediately (REVIEW_P3A BL-1, A-B1 fix).
        const { events: sdkEvents, final: sdkFinal } = this.client.stream(
          req,
          ctx.signal,
        );
        // Observe sdkFinal immediately (SWEEP_server_services #1). When the
        // stream drops mid-flight (network reset, upstream overloaded_error,
        // client abort), the SDK rejects BOTH the event iterator and the
        // final-message promise. The for-await below then throws straight to
        // the catch block WITHOUT ever awaiting sdkFinal, leaving its
        // rejection unobserved — which escalates to the process-level
        // unhandledRejection handler and kills the whole server. This no-op
        // catch marks the rejection as handled; it derives a new promise, so
        // the happy-path `await sdkFinal` below still sees the original
        // value or rejection unchanged.
        void sdkFinal.catch(() => undefined);
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
          await this.cache.put(
            cacheKey,
            parsed.value,
            cfg.cacheTtlSeconds.generate_conversation,
          );
        } catch (e) {
          this.logger.warn({ errMsg: errMsg(e) }, 'conversation cache write failed');
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
        // F-UP-018 (SSE redaction, services scope): the raw message may carry
        // upstream SDK/driver detail (API error bodies, schema diffs, header
        // names). The route forwards this event frame verbatim to the client,
        // so only a FIXED message rides the queue; the raw detail goes to the
        // log here — the route's `final.catch` sink logs at debug only, so
        // without this line the detail would be lost on the event path.
        const detail = e instanceof Error ? e.message : String(e);
        this.logger.error(
          { route, requestId, code, errMsg: detail },
          'conversation stream failed',
        );
        queue.push({ type: 'error', code, message: 'conversation stream failed' });
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
      await this.recordUsageSoft({
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
      this.logger.info(
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
    // Bind TResult to the schema's OUTPUT type (post-`.default()`), accepting
    // any input. `ZodSchema<T>` would pin input === output === T, so for schemas
    // with `.default()` fields TS infers T from the optional input side and the
    // return type loses the defaulted-required fields. See parseInput/safeParse.
    outputSchema: z.ZodType<TResult, z.ZodTypeDef, unknown>;
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

function parseInput<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  raw: unknown,
  route: RouteName,
): T {
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

// Exported for the F-209 pre-seed tool (scripts/preseed-definitions.ts): the
// batch must compute the SAME `claude_cache.prompt_hash` this proxy computes
// (route|model|systemText|userText — see runJsonRoute's cacheKey) to subtract
// already-cached pairs without spending a call. Re-implementing this join in
// the script would let the two silently drift and quietly zero the pre-seed's
// value; exporting the single source of truth cannot.
export function stringifySystem(
  system: import('./client').ContentBlock[] | undefined,
): string {
  if (!system) return '';
  return system.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

// Exported for unit testing: the image-block placeholder behavior is the most
// load-bearing security property of the image_ocr route (a regression that
// dropped the placeholder would put multi-MB base64 into every cache key and
// any logged cache key). A unit test pins it. See tests/services/claude.
export function serializeMessages(
  messages: import('./client').MessageRequest['messages'],
): string {
  return JSON.stringify(
    messages.map((m) => ({
      role: m.role,
      content: m.content.map((c) => {
        if (c.type === 'text') return { type: 'text', text: c.text };
        // Image blocks carry a (potentially multi-MB) base64 payload. Embedding
        // it in the cache key would bloat the key and is pointless — image_ocr
        // runs with cacheTtl 0, so the row is never read back. We serialize a
        // stable placeholder that records the media type + payload length only,
        // never the raw bytes (also keeps base64 image data out of any logged
        // cache key). See PASS8_CONTRACT §B.
        if (c.type === 'image') {
          return {
            type: 'image',
            media_type: c.source.media_type,
            dataLength: c.source.data.length,
          };
        }
        return c;
      }),
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
function safeParse<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  raw: unknown,
): ParseOk<T> | ParseErr {
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
  // Convert the tool's snake_case fields into the Zod schema's camelCase —
  // INCLUDING the nested dimension objects, whose `max_score` must become
  // `maxScore` (DimensionScoreSchema requires it). Remapping only the
  // top-level fields leaves content/organization/languageUse carrying
  // snake_case `max_score`, which fails the schema → ClaudeOutputSchemaError
  // on every real call. Pinned by the gradeWriting tool-use test, which only
  // started running once LOG_LEVEL='silent' was accepted by the config enum.
  return {
    rubric: input.rubric,
    content: mapGradeDimension(input.content),
    organization: mapGradeDimension(input.organization),
    languageUse: mapGradeDimension(input.language_use),
    totalScore: input.total_score,
    maxTotal: input.max_total,
    estimatedLevel: input.estimated_level,
    overallComment: input.overall_comment,
  };
}

/**
 * Remap one rubric dimension from the tool's snake_case (`max_score`) to the
 * Zod schema's camelCase (`maxScore`). Non-object inputs pass through untouched
 * so `safeParse` remains the single authority that rejects a malformed shape.
 */
function mapGradeDimension(dimension: unknown): unknown {
  if (dimension === null || typeof dimension !== 'object') return dimension;
  const d = dimension as Record<string, unknown>;
  return {
    score: d.score,
    maxScore: d.max_score,
    evidence: d.evidence,
    improvements: d.improvements,
  };
}

/**
 * Generalized tool-result parser factory. Returns a parser that extracts the
 * named tool's `input` verbatim — used by routes whose tool input_schema already
 * matches the Zod output schema field-for-field (camelCase), so no snake_case
 * remapping like `parseGradeToolResult` is needed.
 *
 * On a missing tool call (the model returned prose despite a forced
 * tool_choice), returns a `__parse_error__` sentinel so the downstream
 * `safeParse` fails → ClaudeOutputSchemaError, exactly as the JSON path does.
 * The grammar-drill routes (generate_grammar_drill / score_grammar_drill) use
 * this; their tool fields are authored to mirror GrammarDrillItem /
 * GrammarDrillScore one-to-one.
 */
function parseToolResult(
  toolName: string,
): (resp: import('./client').MessageResponse) => unknown {
  return (resp) => {
    const submit = resp.toolUses.find((t) => t.name === toolName);
    if (!submit) {
      return { __parse_error__: `response did not call ${toolName} tool` };
    }
    // The tool input is already shaped to the Zod schema (camelCase fields);
    // hand it straight to safeParse, which is the authority on the shape.
    return submit.input;
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
    // The returned iterator uses object-literal method shorthand, where `this`
    // is the iterator object, not the queue — so a captured reference is needed.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
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
