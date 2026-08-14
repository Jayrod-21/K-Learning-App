/**
 * Image-generation provider (F-211 — AI illustrations for generated stories).
 *
 * A narrow, injectable `ImageGenProvider` interface plus the one real
 * implementation (OpenAI gpt-image-1). Everything downstream (the story-image
 * runner, routes, tests) depends ONLY on the interface: the wire details of
 * the OpenAI Images API live in `OpenAIImageGenProvider` and nowhere else, so
 * if the real API's shape differs from what is encoded here, exactly one
 * request/response mapping needs correcting (see the WIRE CONTRACT note on
 * the class). Mirrors services/tts.ts (F-210) exactly.
 *
 * SECURITY:
 *   - The API key is server-side only. It is read from config, placed in the
 *     `Authorization: Bearer` request header, and NEVER logged, NEVER echoed
 *     into error messages, NEVER part of a URL (query-string keys end up in
 *     proxy logs).
 *   - Upstream failures map to WHITELISTED, server-authored messages
 *     (`ImageGenUpstreamError` carries only the HTTP status — never provider
 *     response text), mirroring tts.ts / middleware/errors.ts's mapClaudeError
 *     posture: no upstream prose ever reaches a client-visible field
 *     (story_image_jobs.error is shown to the user).
 *   - Only the server-derived scene prompt (Claude-proxy output, already
 *     Zod-bounded) is sent upstream — no user PII rides the request.
 *
 * TESTABILITY / NO-KEY OPERATION:
 *   - `setImageGenProvider` injects a mock so tests never touch the network.
 *   - With no OPENAI_API_KEY configured (the key is optional in EVERY
 *     environment — production ships dormant until the operator sets it),
 *     `getImageGenProvider` returns a provider whose `generate` rejects with
 *     `ImageGenNotConfiguredError`: the app boots, the routes work, and a
 *     claimed job settles 'failed' with a clear message instead of anything
 *     crashing. `isImageGenConfigured()` is the capability probe the routes
 *     use to refuse enqueues (503) and to tell the client whether to offer
 *     the feature at all (`imageGenConfigured` on the status envelope).
 */
import { loadConfig } from '../config/index.js';
import { z } from 'zod';

/** The generatable output sizes (the OpenAI gpt-image-1 size grid). F-211
 *  uses the square default; the union exists so a future aspect-ratio choice
 *  is a call-site change, not a provider change. */
export type ImageGenSize = '1024x1024' | '1024x1536' | '1536x1024';

export interface ImageGenResult {
  /** The generated image bytes. */
  image: Buffer;
  /** Mime of `image` — 'image/png' for the default output we request. */
  mimeType: string;
  /** Pixel dimensions of the generated image. */
  width: number;
  height: number;
}

export interface ImageGenProvider {
  /**
   * Generate ONE image from an English prompt.
   * @throws ImageGenNotConfiguredError when no provider credentials exist
   * @throws ImageGenUpstreamError on an upstream API failure (whitelisted
   *         message)
   */
  generate(prompt: string, opts?: { size?: ImageGenSize }): Promise<ImageGenResult>;
}

/** Thrown when image generation is invoked but no API key is configured
 *  (dev/test without OPENAI_API_KEY). The message is user-visible via the
 *  failed job. */
export class ImageGenNotConfiguredError extends Error {
  public constructor() {
    super('image generation is not configured on this server (missing OPENAI_API_KEY)');
    this.name = 'ImageGenNotConfiguredError';
  }
}

/**
 * An upstream image-API failure. `message` is ALWAYS server-authored (status
 * code only, never provider response text) because it flows into
 * story_image_jobs.error, which the client displays.
 */
export class ImageGenUpstreamError extends Error {
  public readonly status: number | null;
  public constructor(status: number | null, message: string) {
    super(message);
    this.name = 'ImageGenUpstreamError';
    this.status = status;
  }
}

/**
 * Input ceiling per generation call. DALL·E 3 caps prompts at 4000 chars
 * (gpt-image-1 allows far more); our scene prompts are schema-capped at 3800
 * (models.ts) so this is headroom, not a working limit — it exists so a
 * pathological prompt fails FAST with our own message instead of an opaque
 * upstream 4xx.
 */
export const IMAGE_GEN_MAX_PROMPT_CHARS = 4000;

/**
 * The subset of the OpenAI image-generation response we consume, validated
 * before use so a surprise upstream shape is a clean ImageGenUpstreamError,
 * never an undefined-deref half-state.
 */
const OpenAIImageResponseSchema = z.object({
  data: z
    .array(
      z.object({
        b64_json: z.string().min(1),
      }),
    )
    .min(1),
});

/**
 * OpenAI image-generation implementation (gpt-image-1).
 *
 * WIRE CONTRACT (isolated here on purpose — verify against the live API when
 * a real key lands; nothing outside this class depends on these details):
 *   POST {baseUrl}/v1/images/generations
 *   headers: Authorization: Bearer <key>, content-type: application/json
 *   body:    { "model": "gpt-image-1", "prompt": "...", "n": 1,
 *              "size": "1024x1024" }
 *   200 →    { "created": 1710000000,
 *              "data": [ { "b64_json": "<base64 png>" } ],
 *              "usage": { … } }
 *   Notes to verify when the key lands:
 *   - gpt-image-1 ALWAYS returns base64 (`b64_json`) — no `response_format`
 *     param exists for it (that param is a DALL·E 2/3 concept). If the
 *     operator swaps `model` to 'dall-e-3', add "response_format":
 *     "b64_json" to the body or `data[0].b64_json` will be absent (the API
 *     defaults DALL·E to hosted `url` responses).
 *   - gpt-image-1's default output_format is png → mimeType 'image/png'.
 *   - The returned dimensions equal the requested `size`; we report the
 *     requested size rather than decoding the image header.
 */
export class OpenAIImageGenProvider implements ImageGenProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(opts: {
    apiKey: string;
    /** Override for a future model swap; default is gpt-image-1. */
    model?: string;
    /** Override for tests / a future proxy; default is the public API host. */
    baseUrl?: string;
    /** Injectable fetch so tests never touch the network. */
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'gpt-image-1';
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com').replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    // Generous: a single gpt-image-1 generation routinely takes 30-90s.
    this.timeoutMs = opts.timeoutMs ?? 180_000;
  }

  public async generate(
    prompt: string,
    opts?: { size?: ImageGenSize },
  ): Promise<ImageGenResult> {
    if (prompt.length === 0) {
      throw new Error('imageGen generate: prompt must not be empty');
    }
    if (prompt.length > IMAGE_GEN_MAX_PROMPT_CHARS) {
      // Our own bound, our own message — never an opaque upstream 4xx. Scene
      // prompts are schema-capped well under this; only a pathological input
      // can reach it.
      throw new ImageGenUpstreamError(
        null,
        `prompt is too long to illustrate (${prompt.length} chars; limit ${IMAGE_GEN_MAX_PROMPT_CHARS})`,
      );
    }
    const size: ImageGenSize = opts?.size ?? '1024x1024';
    const url = `${this.baseUrl}/v1/images/generations`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          // The ONLY place the key ever appears. Never a URL, never a log.
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ model: this.model, prompt, n: 1, size }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Network/timeout failure. The caught error can embed the request URL;
      // deliberately not forwarded (whitelisted message only).
      throw new ImageGenUpstreamError(
        null,
        'the image service could not be reached — try again later',
      );
    }

    if (!res.ok) {
      // Status only — NEVER the response body (provider prose must not reach
      // the user-visible job error; mirrors tts.ts / mapClaudeError).
      throw new ImageGenUpstreamError(
        res.status,
        `the image service rejected the request (HTTP ${res.status})`,
      );
    }

    let parsed: z.infer<typeof OpenAIImageResponseSchema>;
    try {
      parsed = OpenAIImageResponseSchema.parse(await res.json());
    } catch {
      throw new ImageGenUpstreamError(null, 'the image service returned an unexpected response');
    }

    const image = Buffer.from(parsed.data[0]!.b64_json, 'base64');
    if (image.length === 0) {
      throw new ImageGenUpstreamError(null, 'the image service returned an empty image');
    }

    // Dimensions come from the requested size (the API generates exactly the
    // requested geometry); the parse is over our own closed union, so this
    // can never NaN.
    const [width, height] = size.split('x').map(Number) as [number, number];
    return { image, mimeType: 'image/png', width, height };
  }
}

/** Provider whose every call fails with the "not configured" message —
 *  installed when no API key exists (a dormant deploy, dev, or test) so the
 *  pipeline stays exercisable end-to-end and a claimed job settles with a
 *  clear error. Exported so tests can inject the dormant posture explicitly
 *  (setImageGenProvider(new UnconfiguredImageGenProvider())) without
 *  depending on the ambient env; `isImageGenConfigured` keys off this exact
 *  class. */
export class UnconfiguredImageGenProvider implements ImageGenProvider {
  public generate(): Promise<ImageGenResult> {
    return Promise.reject(new ImageGenNotConfiguredError());
  }
}

let _provider: ImageGenProvider | null = null;

/** The process-wide image-generation provider (lazy; config-driven). Tests
 *  inject via setImageGenProvider and MUST reset afterwards. */
export function getImageGenProvider(): ImageGenProvider {
  if (_provider) return _provider;
  const cfg = loadConfig();
  _provider =
    cfg.OPENAI_API_KEY !== undefined
      ? new OpenAIImageGenProvider({ apiKey: cfg.OPENAI_API_KEY })
      : new UnconfiguredImageGenProvider();
  return _provider;
}

/**
 * True when a REAL image provider is available — i.e. the active provider is
 * not the keyless `UnconfiguredImageGenProvider`. Derived from the provider
 * (not the raw config key) so an injected test/mock provider counts as
 * configured, exactly like it does for the runner. The routes use this to
 * (a) refuse a guaranteed-to-fail enqueue with 503 BEFORE burning a
 * daily-cap slot, (b) decide whether POST /reading/generate auto-enqueues
 * the batch-at-creation job, and (c) stamp `imageGenConfigured` on the
 * status envelope so the client can hide the feature on a dormant deploy.
 */
export function isImageGenConfigured(): boolean {
  return !(getImageGenProvider() instanceof UnconfiguredImageGenProvider);
}

/** Test-only injection point (also usable by a future provider swap). */
export function setImageGenProvider(provider: ImageGenProvider): void {
  _provider = provider;
}

export function resetImageGenProviderForTesting(): void {
  _provider = null;
}
