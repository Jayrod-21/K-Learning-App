/**
 * Unit tests for src/services/tts.ts (F-210 — the TTS provider layer).
 *
 * The ElevenLabs implementation is exercised entirely through an injected
 * fetch stub — NO network, NO real key. Focus:
 *   - request mapping: URL (voice id + with-timestamps + output_format),
 *     headers (xi-api-key; never anywhere else), body ({text, model_id})
 *   - response mapping: base64 audio → Buffer, seconds → rounded ms
 *     alignments, mimeType
 *   - degradation: null alignment block → audio with NO alignments (caller
 *     falls back), mismatched alignment arrays → error
 *   - error whitelisting: non-2xx → TtsUpstreamError carrying ONLY the
 *     status (never response body text, never the key); network failure →
 *     TtsUpstreamError with a generic message; oversized input fails fast
 *   - the unconfigured provider (no key) rejects with TtsNotConfiguredError
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ElevenLabsTtsProvider,
  getTtsProvider,
  resetTtsProviderForTesting,
  setTtsProvider,
  TTS_MAX_INPUT_CHARS,
  TtsNotConfiguredError,
  TtsUpstreamError,
  type TtsProvider,
} from '../../src/services/tts.js';
import { _setConfigForTesting, resetConfig } from '../../src/config/index.js';

// Obviously-fake fixture (kept low-entropy so the gitleaks pre-commit scan
// never flags it) — the assertions only need a distinctive marker string.
const API_KEY = 'fake-test-credential';
const VOICE = 'voice-abc';
const MP3_BYTES = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]); // "ID3" header-ish

/** A minimal Response stand-in (only the fields the provider touches). */
function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function okBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    audio_base64: MP3_BYTES.toString('base64'),
    alignment: {
      characters: ['안', '녕'],
      character_start_times_seconds: [0, 0.5004],
      character_end_times_seconds: [0.5004, 1.2],
    },
    // The provider must IGNORE normalized_alignment (its indexes don't map
    // back to our stored text) — present here to prove it's tolerated.
    normalized_alignment: {
      characters: ['안', '녕'],
      character_start_times_seconds: [0, 0.5],
      character_end_times_seconds: [0.5, 1.2],
    },
    ...overrides,
  };
}

function makeProvider(fetchImpl: typeof fetch): ElevenLabsTtsProvider {
  return new ElevenLabsTtsProvider({
    apiKey: API_KEY,
    defaultVoiceId: VOICE,
    fetchImpl,
  });
}

afterEach(() => {
  resetTtsProviderForTesting();
  resetConfig();
});

describe('ElevenLabsTtsProvider — request mapping', () => {
  it('POSTs the with-timestamps endpoint with the key header and {text, model_id} body', async () => {
    const fetchStub = vi.fn(async () => fakeResponse(200, okBody()));
    const provider = makeProvider(fetchStub as unknown as typeof fetch);

    await provider.synthesize('안녕');

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/with-timestamps?output_format=mp3_44100_128`,
    );
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['xi-api-key']).toBe(API_KEY);
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      text: '안녕',
      model_id: 'eleven_multilingual_v2',
    });
    // The key must never leak into the URL (query-string keys end up in
    // proxy/server logs).
    expect(url).not.toContain(API_KEY);
  });

  it('a per-call voiceId override lands in the path (URI-encoded)', async () => {
    const fetchStub = vi.fn(async () => fakeResponse(200, okBody()));
    const provider = makeProvider(fetchStub as unknown as typeof fetch);

    await provider.synthesize('안녕', { voiceId: 'other/voice' });

    const [url] = fetchStub.mock.calls[0]! as unknown as [string];
    expect(url).toContain('/v1/text-to-speech/other%2Fvoice/with-timestamps');
  });

  it('rejects text over TTS_MAX_INPUT_CHARS BEFORE any fetch', async () => {
    const fetchStub = vi.fn(async () => fakeResponse(200, okBody()));
    const provider = makeProvider(fetchStub as unknown as typeof fetch);

    await expect(
      provider.synthesize('가'.repeat(TTS_MAX_INPUT_CHARS + 1)),
    ).rejects.toBeInstanceOf(TtsUpstreamError);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe('ElevenLabsTtsProvider — response mapping', () => {
  it('decodes the base64 audio and converts second-timestamps to rounded ms', async () => {
    const provider = makeProvider((async () =>
      fakeResponse(200, okBody())) as unknown as typeof fetch);

    const out = await provider.synthesize('안녕');

    expect(out.mimeType).toBe('audio/mpeg');
    expect(Buffer.compare(out.audio, MP3_BYTES)).toBe(0);
    expect(out.charAlignments).toEqual([
      { char: '안', startMs: 0, endMs: 500 }, // 0.5004s → 500ms (rounded)
      { char: '녕', startMs: 500, endMs: 1200 },
    ]);
  });

  it('a null alignment block degrades to audio with NO alignments (not an error)', async () => {
    const provider = makeProvider((async () =>
      fakeResponse(200, okBody({ alignment: null }))) as unknown as typeof fetch);

    const out = await provider.synthesize('안녕');
    expect(out.audio.length).toBeGreaterThan(0);
    expect(out.charAlignments).toEqual([]);
  });

  it('mismatched alignment array lengths → TtsUpstreamError', async () => {
    const provider = makeProvider((async () =>
      fakeResponse(
        200,
        okBody({
          alignment: {
            characters: ['안', '녕'],
            character_start_times_seconds: [0],
            character_end_times_seconds: [0.5, 1.2],
          },
        }),
      )) as unknown as typeof fetch);

    await expect(provider.synthesize('안녕')).rejects.toBeInstanceOf(TtsUpstreamError);
  });

  it('an unexpected response shape → TtsUpstreamError (never an undefined deref)', async () => {
    const provider = makeProvider((async () =>
      fakeResponse(200, { detail: 'looks nothing like the contract' })) as unknown as typeof fetch);

    await expect(provider.synthesize('안녕')).rejects.toBeInstanceOf(TtsUpstreamError);
  });

  it('empty decoded audio → TtsUpstreamError', async () => {
    const provider = makeProvider((async () =>
      fakeResponse(200, okBody({ audio_base64: '!!!' }))) as unknown as typeof fetch);

    await expect(provider.synthesize('안녕')).rejects.toBeInstanceOf(TtsUpstreamError);
  });
});

describe('ElevenLabsTtsProvider — error whitelisting', () => {
  it('a non-2xx carries ONLY the status — never the response body, never the key', async () => {
    const provider = makeProvider((async () =>
      fakeResponse(401, {
        detail: { status: 'invalid_api_key', message: 'SECRET-UPSTREAM-PROSE' },
      })) as unknown as typeof fetch);

    const err = await provider.synthesize('안녕').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TtsUpstreamError);
    const upstream = err as TtsUpstreamError;
    expect(upstream.status).toBe(401);
    expect(upstream.message).toContain('401');
    // The message flows into the user-visible job error — it must be OUR
    // copy, never upstream prose or the key.
    expect(upstream.message).not.toContain('SECRET-UPSTREAM-PROSE');
    expect(upstream.message).not.toContain('invalid_api_key');
    expect(upstream.message).not.toContain(API_KEY);
  });

  it('a network/timeout failure maps to a generic TtsUpstreamError (no fetch internals)', async () => {
    const provider = makeProvider((async () => {
      throw new TypeError(`fetch failed https://api.elevenlabs.io/?key=${API_KEY}`);
    }) as unknown as typeof fetch);

    const err = await provider.synthesize('안녕').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TtsUpstreamError);
    expect((err as TtsUpstreamError).status).toBeNull();
    expect((err as TtsUpstreamError).message).not.toContain(API_KEY);
  });
});

describe('provider injection + unconfigured operation', () => {
  it('setTtsProvider installs the injected provider for getTtsProvider', async () => {
    const injected: TtsProvider = {
      synthesize: async () => ({
        audio: MP3_BYTES,
        mimeType: 'audio/mpeg',
        charAlignments: [],
      }),
    };
    setTtsProvider(injected);
    expect(getTtsProvider()).toBe(injected);
  });

  it('with no ELEVENLABS_API_KEY configured, synthesize rejects TtsNotConfiguredError', async () => {
    // Config parses without the key outside production (the optional-in-dev
    // contract this feature relies on for boot + tests).
    delete process.env.ELEVENLABS_API_KEY;
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';
    process.env.KIWI_URL = 'http://kiwi.invalid/';
    process.env.CLIENT_ORIGIN = 'http://localhost:5173';
    _setConfigForTesting({});
    resetTtsProviderForTesting();

    await expect(getTtsProvider().synthesize('안녕')).rejects.toBeInstanceOf(
      TtsNotConfiguredError,
    );
  });
});
