/**
 * Anthropic SDK wrapper.
 *
 * This is the ONLY file in the codebase that imports `@anthropic-ai/sdk`.
 * Enforced by an eslint no-restricted-imports rule (see server/eslint.config).
 *
 * The wrapper:
 *   - Constructs the SDK client lazily, reading the API key from
 *     `config.ts` (never logs it, never exposes it).
 *   - Provides two methods: `createMessage` (non-streaming) and
 *     `streamMessage` (SSE-style async iteration).
 *   - Surfaces a minimal, internal type vocabulary (`MessageRequest`,
 *     `ContentBlock`, `Tool`, `ToolChoice`) so the prompt files don't
 *     transitively depend on the SDK's exported types — that gives us a
 *     clean upgrade path when Anthropic ships a v1 with renames.
 *
 * The constructor accepts an optional `sdkOverride` to make it trivially
 * mockable in unit tests. Tests pass a stub conforming to the same
 * interface; production passes nothing and gets the real SDK.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';

import { getApiKey, loadConfig } from './config';

// ---- Internal type vocabulary ---------------------------------------------

export interface CacheControl {
  readonly type: 'ephemeral';
  /** Optional Anthropic prompt-cache TTL; defaults to 5m on their side. */
  readonly ttl?: '5m' | '1h';
}

/**
 * Image content block — mirrors the Anthropic SDK `ImageBlockParam`
 * base64-source shape. The OCR route (`image_ocr`) carries an image as the
 * first element of a user message's `content` array; every existing route
 * uses only `text` blocks. We model only the base64 source (not the URL or
 * Files-API variants) because the proxy never has a public URL for an
 * uploaded blob — it has the bytes. `media_type` is restricted to the upload
 * allowlist the route enforces (jpeg/png/webp); `data` is the base64-encoded
 * image, NOT logged and NOT part of the cache key (image_ocr runs with
 * cacheTtl 0 and `serializeMessages` skips image-block data).
 */
export interface ImageSourceBase64 {
  readonly type: 'base64';
  readonly media_type: 'image/jpeg' | 'image/png' | 'image/webp';
  readonly data: string;
}

export type ContentBlock =
  | { type: 'text'; text: string; cache_control?: CacheControl }
  | { type: 'image'; source: ImageSourceBase64; cache_control?: CacheControl }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface MessageRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly temperature?: number;
  readonly system?: ContentBlock[];
  readonly messages: ReadonlyArray<{
    readonly role: 'user' | 'assistant';
    readonly content: ContentBlock[];
  }>;
  readonly tools?: Tool[];
  readonly tool_choice?: ToolChoice;
}

export interface Tool {
  readonly name: string;
  readonly description?: string;
  readonly input_schema: Record<string, unknown>;
}

export type ToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string };

export interface MessageResponse {
  readonly id: string;
  readonly model: string;
  readonly stopReason: string | null;
  /** Text content blocks (concatenated). */
  readonly text: string;
  /** Tool use blocks (e.g., grade rubric). */
  readonly toolUses: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }>;
  readonly usage: TokenUsage;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Tokens read from Anthropic's server-side prompt cache. */
  readonly cachedInputTokens: number;
  /** Tokens written to Anthropic's server-side prompt cache (for cost,
   *  these are billed at the input rate; not surfaced separately to
   *  the DB schema today but available for future use). */
  readonly cacheCreationInputTokens: number;
}

export interface StreamEvent {
  /** 'start' | 'delta' | 'stop' | 'message' (final assembled). */
  readonly kind: 'start' | 'delta' | 'stop' | 'message';
  readonly text?: string;
  readonly finalText?: string;
  readonly usage?: TokenUsage;
}

// ---- SDK-shaped types we lean on (subset) ---------------------------------

interface SdkMessagesAPI {
  create(
    req: unknown,
  ): Promise<{
    id: string;
    model: string;
    stop_reason: string | null;
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown }
    >;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  }>;
  stream(req: unknown): AsyncIterable<unknown> & {
    finalMessage(): Promise<{
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: unknown }
      >;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      stop_reason: string | null;
      id: string;
      model: string;
    }>;
  };
}

export interface SdkLike {
  readonly messages: SdkMessagesAPI;
}

// ---- ClaudeClient ---------------------------------------------------------

export interface ClaudeClientDeps {
  readonly logger: Logger;
  /** Override the SDK constructor for tests. */
  readonly sdk?: SdkLike;
}

export class ClaudeClient {
  private readonly sdk: SdkLike;
  private readonly logger: Logger;

  constructor(deps: ClaudeClientDeps) {
    this.logger = deps.logger;
    if (deps.sdk) {
      this.sdk = deps.sdk;
    } else {
      const cfg = loadConfig();
      const apiKey = getApiKey();
      // Anthropic SDK accepts undefined baseURL; pass through only if set.
      const client = new Anthropic({
        apiKey,
        timeout: cfg.timeoutMs,
        ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
      });
      this.sdk = client as unknown as SdkLike;
    }
  }

  /** Non-streaming create. */
  async createMessage(req: MessageRequest): Promise<MessageResponse> {
    const raw = await this.sdk.messages.create(req);
    return normalizeResponse(raw);
  }

  /**
   * Streaming create. Returns an async iterable of `StreamEvent`s and,
   * via the `final` promise, the assembled final message.
   *
   * Consumers (the conversation route) wire deltas into SSE and use
   * the final message to write the cache + usage rows.
   *
   * `signal` is the upstream-abort lever. When the route's client
   * disconnects mid-stream, the route aborts this signal — the Anthropic
   * SDK call rejects with an AbortError, our iterator surfaces it, and the
   * `final` promise rejects so the worker coroutine can clean up. Without
   * threading this signal, a closed client never stops the upstream spend
   * (the cost-amplification surface flagged in REVIEW_P3A BL-1).
   */
  stream(
    req: MessageRequest,
    signal?: AbortSignal,
  ): {
    events: AsyncIterable<StreamEvent>;
    final: Promise<MessageResponse>;
  } {
    // The Anthropic SDK's `messages.stream` accepts request options as a
    // second argument, including `signal`. We pass it through opaquely so a
    // future SDK upgrade that renames the option only requires touching this
    // one site. `SdkLike` types `stream(req)` as single-arg for backward
    // compat with existing tests; the real SDK accepts the options object
    // shape used here.
    const stream =
      signal !== undefined
        ? (
            this.sdk.messages.stream as unknown as (
              req: unknown,
              opts: { signal: AbortSignal },
            ) => ReturnType<SdkMessagesAPI['stream']>
          )(req, { signal })
        : this.sdk.messages.stream(req);
    const self = this;

    async function* iterate(): AsyncIterable<StreamEvent> {
      yield { kind: 'start' };
      try {
        for await (const ev of stream) {
          // Re-check the signal between events — even if the SDK didn't
          // reject the iterator, we stop emitting deltas the moment the
          // caller aborts.
          if (signal?.aborted) {
            break;
          }
          const e = ev as Record<string, unknown>;
          const type = typeof e.type === 'string' ? e.type : '';
          if (type === 'content_block_delta') {
            const delta = e.delta as { type?: string; text?: string } | undefined;
            if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
              yield { kind: 'delta', text: delta.text };
            }
          } else if (type === 'message_stop') {
            yield { kind: 'stop' };
          }
        }
      } catch (err) {
        self.logger.error({ errMsg: errStr(err) }, 'claude stream iteration failed');
        throw err;
      }
    }

    const events = iterate();
    const final = stream.finalMessage().then(normalizeResponse);
    return { events, final };
  }
}

function normalizeResponse(raw: {
  id: string;
  model: string;
  stop_reason: string | null;
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
  >;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}): MessageResponse {
  let text = '';
  const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
  for (const block of raw.content) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      toolUses.push({ id: block.id, name: block.name, input: block.input });
    }
  }
  return {
    id: raw.id,
    model: raw.model,
    stopReason: raw.stop_reason,
    text,
    toolUses,
    usage: {
      inputTokens: raw.usage.input_tokens,
      outputTokens: raw.usage.output_tokens,
      cachedInputTokens: raw.usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: raw.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

function errStr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
