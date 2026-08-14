/**
 * Tests for src/services/imageGen.ts (F-211 — the OpenAI image provider's
 * wire mapping + the injectable/dormant provider plumbing). Mirrors
 * tts.test.ts: a mock fetchImpl pins the exact request we send and the exact
 * response shape we consume, so when a real OPENAI_API_KEY lands, any
 * upstream-contract surprise is a ONE-CLASS fix verified by these pins.
 * No network, no Postgres.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  IMAGE_GEN_MAX_PROMPT_CHARS,
  ImageGenNotConfiguredError,
  ImageGenUpstreamError,
  isImageGenConfigured,
  OpenAIImageGenProvider,
  resetImageGenProviderForTesting,
  setImageGenProvider,
  UnconfiguredImageGenProvider,
  type ImageGenProvider,
} from '../../src/services/imageGen.js';

const PNG_BYTES = Buffer.from('fake-png-bytes-for-image-gen-test');

/** A fetch mock recording every call and returning the queued response. */
function mockFetch(
  responses: Array<{ status?: number; json?: unknown; reject?: boolean }>,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetchImpl = (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    const spec = responses[Math.min(i++, responses.length - 1)]!;
    if (spec.reject === true) throw new Error('ECONNREFUSED api.openai.com super-secret');
    return {
      ok: (spec.status ?? 200) < 400,
      status: spec.status ?? 200,
      json: async () => spec.json,
    } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function okResponse(bytes: Buffer = PNG_BYTES): unknown {
  return { created: 1710000000, data: [{ b64_json: bytes.toString('base64') }] };
}

afterEach(() => {
  resetImageGenProviderForTesting();
});

describe('OpenAIImageGenProvider — wire contract', () => {
  it('POSTs /v1/images/generations with the key in the Authorization header ONLY', async () => {
    const { fetchImpl, calls } = mockFetch([{ json: okResponse() }]);
    const provider = new OpenAIImageGenProvider({ apiKey: 'sk-test-key', fetchImpl });

    const result = await provider.generate('a cat in a hanok courtyard');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/images/generations');
    // The key rides the header and NEVER the URL (query-string keys end up
    // in proxy logs).
    expect(calls[0]!.url).not.toContain('sk-test-key');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test-key');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      model: 'gpt-image-1',
      prompt: 'a cat in a hanok courtyard',
      n: 1,
      size: '1024x1024',
    });
    // b64_json decodes to the exact bytes; dimensions echo the requested size.
    expect(Buffer.compare(result.image, PNG_BYTES)).toBe(0);
    expect(result.mimeType).toBe('image/png');
    expect(result.width).toBe(1024);
    expect(result.height).toBe(1024);
  });

  it('honors an explicit size and reports its dimensions', async () => {
    const { fetchImpl, calls } = mockFetch([{ json: okResponse() }]);
    const provider = new OpenAIImageGenProvider({ apiKey: 'k', fetchImpl });
    const result = await provider.generate('p', { size: '1536x1024' });
    const body = JSON.parse(String(calls[0]!.init.body)) as { size: string };
    expect(body.size).toBe('1536x1024');
    expect(result.width).toBe(1536);
    expect(result.height).toBe(1024);
  });

  it('strips a trailing slash from a baseUrl override', async () => {
    const { fetchImpl, calls } = mockFetch([{ json: okResponse() }]);
    const provider = new OpenAIImageGenProvider({
      apiKey: 'k',
      baseUrl: 'http://proxy.local/',
      fetchImpl,
    });
    await provider.generate('p');
    expect(calls[0]!.url).toBe('http://proxy.local/v1/images/generations');
  });

  it('a non-OK status → whitelisted ImageGenUpstreamError (status only, no body text)', async () => {
    const { fetchImpl } = mockFetch([
      { status: 429, json: { error: { message: 'SECRET upstream detail' } } },
    ]);
    const provider = new OpenAIImageGenProvider({ apiKey: 'k', fetchImpl });
    const err = await provider.generate('p').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageGenUpstreamError);
    expect((err as ImageGenUpstreamError).status).toBe(429);
    expect((err as Error).message).toBe('the image service rejected the request (HTTP 429)');
    expect((err as Error).message).not.toContain('SECRET');
  });

  it('a network failure → whitelisted message (no URL, no internals)', async () => {
    const { fetchImpl } = mockFetch([{ reject: true }]);
    const provider = new OpenAIImageGenProvider({ apiKey: 'k', fetchImpl });
    const err = await provider.generate('p').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageGenUpstreamError);
    expect((err as ImageGenUpstreamError).status).toBeNull();
    expect((err as Error).message).toBe(
      'the image service could not be reached — try again later',
    );
    expect((err as Error).message).not.toContain('openai');
  });

  it.each([
    ['missing data array', { created: 1 }],
    ['empty data array', { data: [] }],
    ['url-style item (dall-e default) instead of b64_json', { data: [{ url: 'https://x' }] }],
  ])('an unexpected response shape (%s) → whitelisted upstream error', async (_name, json) => {
    const { fetchImpl } = mockFetch([{ json }]);
    const provider = new OpenAIImageGenProvider({ apiKey: 'k', fetchImpl });
    const err = await provider.generate('p').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageGenUpstreamError);
    expect((err as Error).message).toBe('the image service returned an unexpected response');
  });

  it('base64 that decodes to zero bytes → "empty image" upstream error', async () => {
    // '====' is non-empty as a string but decodes to an empty buffer.
    const { fetchImpl } = mockFetch([{ json: { data: [{ b64_json: '====' }] } }]);
    const provider = new OpenAIImageGenProvider({ apiKey: 'k', fetchImpl });
    const err = await provider.generate('p').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageGenUpstreamError);
    expect((err as Error).message).toBe('the image service returned an empty image');
  });

  it('an over-length prompt fails FAST with our own message — no fetch fired', async () => {
    const { fetchImpl, calls } = mockFetch([{ json: okResponse() }]);
    const provider = new OpenAIImageGenProvider({ apiKey: 'k', fetchImpl });
    const err = await provider
      .generate('x'.repeat(IMAGE_GEN_MAX_PROMPT_CHARS + 1))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageGenUpstreamError);
    expect((err as Error).message).toContain('too long');
    expect(calls).toHaveLength(0);
  });

  it('an empty prompt is a programming error, not an upstream error', async () => {
    const { fetchImpl } = mockFetch([{ json: okResponse() }]);
    const provider = new OpenAIImageGenProvider({ apiKey: 'k', fetchImpl });
    await expect(provider.generate('')).rejects.toThrow('prompt must not be empty');
  });
});

describe('provider plumbing — injection + dormant posture', () => {
  it('UnconfiguredImageGenProvider rejects with ImageGenNotConfiguredError', async () => {
    const provider = new UnconfiguredImageGenProvider();
    await expect(provider.generate()).rejects.toBeInstanceOf(ImageGenNotConfiguredError);
    // The message is user-visible via the failed job — it must name the fix.
    await expect(provider.generate()).rejects.toThrow('OPENAI_API_KEY');
  });

  it('isImageGenConfigured derives from the ACTIVE provider, not the raw env key', () => {
    setImageGenProvider(new UnconfiguredImageGenProvider());
    expect(isImageGenConfigured()).toBe(false);

    const mock: ImageGenProvider = {
      generate: async () => ({ image: PNG_BYTES, mimeType: 'image/png', width: 1024, height: 1024 }),
    };
    setImageGenProvider(mock);
    expect(isImageGenConfigured()).toBe(true);
  });
});
