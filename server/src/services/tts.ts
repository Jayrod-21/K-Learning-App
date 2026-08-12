/**
 * Text-to-speech provider (F-210 — story audio).
 *
 * A narrow, injectable `TtsProvider` interface plus the one real
 * implementation (ElevenLabs). Everything downstream (the story-audio runner,
 * routes, tests) depends ONLY on the interface: the wire details of the
 * ElevenLabs API live in `ElevenLabsTtsProvider` and nowhere else, so if the
 * real API's shape differs from what is encoded here, exactly one
 * request/response mapping needs correcting (see the WIRE CONTRACT note on
 * the class).
 *
 * SECURITY:
 *   - The API key is server-side only. It is read from config, placed in the
 *     `xi-api-key` request header, and NEVER logged, NEVER echoed into error
 *     messages, NEVER part of a URL (query-string keys end up in proxy logs).
 *   - Upstream failures map to WHITELISTED, server-authored messages
 *     (`TtsUpstreamError` carries only the HTTP status — never provider
 *     response text), mirroring middleware/errors.ts's mapClaudeError
 *     posture: no upstream prose ever reaches a client-visible field
 *     (story_audio_jobs.error is shown to the user).
 *   - Only the story body (already persisted, server-held text) is sent
 *     upstream — no user PII rides the request.
 *
 * TESTABILITY / NO-KEY OPERATION:
 *   - `setTtsProvider` injects a mock so tests never touch the network.
 *   - With no ELEVENLABS_API_KEY configured (dev/test — config makes it
 *     optional outside production), `getTtsProvider` returns a provider whose
 *     `synthesize` rejects with `TtsNotConfiguredError`: the app boots, the
 *     routes work, and a claimed job settles 'failed' with a clear message
 *     instead of anything crashing.
 */
import { loadConfig } from '../config/index.js';
import { z } from 'zod';

/** Per-character timing of the synthesized speech: `char` is one character of
 *  the INPUT text (in order), voiced during [startMs, endMs]. */
export interface TtsCharAlignment {
  char: string;
  startMs: number;
  endMs: number;
}

export interface TtsSynthesis {
  /** The synthesized audio bytes. */
  audio: Buffer;
  /** Mime of `audio` — 'audio/mpeg' for the mp3 output we request. */
  mimeType: string;
  /** Per-character timings over the input text (read-along source data). */
  charAlignments: TtsCharAlignment[];
}

export interface TtsProvider {
  /**
   * Synthesize `text` to spoken audio with per-character timestamps.
   * @throws TtsNotConfiguredError when no provider credentials exist
   * @throws TtsUpstreamError on an upstream API failure (whitelisted message)
   */
  synthesize(text: string, opts?: { voiceId?: string }): Promise<TtsSynthesis>;
}

/** Thrown when TTS is invoked but no API key is configured (dev/test without
 *  ELEVENLABS_API_KEY). The message is user-visible via the failed job. */
export class TtsNotConfiguredError extends Error {
  public constructor() {
    super('text-to-speech is not configured on this server (missing ELEVENLABS_API_KEY)');
    this.name = 'TtsNotConfiguredError';
  }
}

/**
 * An upstream TTS API failure. `message` is ALWAYS server-authored (status
 * code only, never provider response text) because it flows into
 * story_audio_jobs.error, which the client displays.
 */
export class TtsUpstreamError extends Error {
  public readonly status: number | null;
  public constructor(status: number | null, message: string) {
    super(message);
    this.name = 'TtsUpstreamError';
    this.status = status;
  }
}

/**
 * Input ceiling per synthesis call. ElevenLabs' multilingual model caps a
 * single request's text length (10k chars on paid tiers); our story bodies
 * are schema-capped at 6000 chars so this is headroom, not a working limit —
 * it exists so a pathological body fails FAST with our own message instead
 * of an opaque upstream 4xx.
 */
export const TTS_MAX_INPUT_CHARS = 9500;

/**
 * The subset of the ElevenLabs with-timestamps response we consume, validated
 * before use so a surprise upstream shape is a clean TtsUpstreamError, never
 * an undefined-deref half-state. `alignment` covers the RAW input text
 * (index-aligned with what we sent); `normalized_alignment` covers the
 * provider's normalized text and is deliberately ignored (its indexes do not
 * map back to our stored body, which the segments must offset into).
 */
const ElevenLabsWithTimestampsSchema = z.object({
  audio_base64: z.string().min(1),
  alignment: z
    .object({
      characters: z.array(z.string()),
      character_start_times_seconds: z.array(z.number()),
      character_end_times_seconds: z.array(z.number()),
    })
    .nullable(),
});

/**
 * ElevenLabs text-to-speech implementation.
 *
 * WIRE CONTRACT (isolated here on purpose — verify against the live API when
 * a real key lands; nothing outside this class depends on these details):
 *   POST {baseUrl}/v1/text-to-speech/{voiceId}/with-timestamps?output_format=mp3_44100_128
 *   headers: xi-api-key: <key>, content-type: application/json
 *   body:    { "text": "...", "model_id": "eleven_multilingual_v2" }
 *   200 →    { "audio_base64": "<base64 mp3>",
 *              "alignment": { "characters": ["안","녕",…],
 *                             "character_start_times_seconds": [0, 0.12, …],
 *                             "character_end_times_seconds": [0.12, 0.3, …] },
 *              "normalized_alignment": { … } }
 *   where `alignment.characters` reproduces the INPUT text character-for-
 *   character (index i of the arrays = character i of the request text).
 *   `eleven_multilingual_v2` is the Korean-capable model.
 */
export class ElevenLabsTtsProvider implements TtsProvider {
  private readonly apiKey: string;
  private readonly defaultVoiceId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(opts: {
    apiKey: string;
    defaultVoiceId: string;
    /** Override for tests / a future proxy; default is the public API host. */
    baseUrl?: string;
    /** Injectable fetch so tests never touch the network. */
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.apiKey = opts.apiKey;
    this.defaultVoiceId = opts.defaultVoiceId;
    this.baseUrl = (opts.baseUrl ?? 'https://api.elevenlabs.io').replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    // Generous: a 6000-char body is a few minutes of audio to synthesize.
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  public async synthesize(text: string, opts?: { voiceId?: string }): Promise<TtsSynthesis> {
    if (text.length === 0) {
      throw new Error('tts synthesize: text must not be empty');
    }
    if (text.length > TTS_MAX_INPUT_CHARS) {
      // Our own bound, our own message — never an opaque upstream 4xx. Story
      // bodies are schema-capped well under this; only legacy/pathological
      // rows can reach it.
      throw new TtsUpstreamError(
        null,
        `text is too long to synthesize (${text.length} chars; limit ${TTS_MAX_INPUT_CHARS})`,
      );
    }
    // voiceId is server-config or a server-chosen value — never client input
    // — but encodeURIComponent anyway so a bad config value cannot mangle the
    // path (defense in depth).
    const voiceId = opts?.voiceId ?? this.defaultVoiceId;
    const url =
      `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}` +
      `/with-timestamps?output_format=mp3_44100_128`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          // The ONLY place the key ever appears. Never a URL, never a log.
          'xi-api-key': this.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Network/timeout failure. The caught error can embed the request URL;
      // deliberately not forwarded (whitelisted message only).
      throw new TtsUpstreamError(null, 'the speech service could not be reached — try again later');
    }

    if (!res.ok) {
      // Status only — NEVER the response body (provider prose must not reach
      // the user-visible job error; mirrors mapClaudeError's whitelist).
      throw new TtsUpstreamError(
        res.status,
        `the speech service rejected the request (HTTP ${res.status})`,
      );
    }

    let parsed: z.infer<typeof ElevenLabsWithTimestampsSchema>;
    try {
      parsed = ElevenLabsWithTimestampsSchema.parse(await res.json());
    } catch {
      throw new TtsUpstreamError(null, 'the speech service returned an unexpected response');
    }

    const audio = Buffer.from(parsed.audio_base64, 'base64');
    if (audio.length === 0) {
      throw new TtsUpstreamError(null, 'the speech service returned empty audio');
    }

    // A missing alignment block (nullable upstream) degrades to "no
    // timestamps": the caller falls back to proportional segment windows
    // rather than failing a synthesis that DID produce audio.
    const charAlignments: TtsCharAlignment[] = [];
    if (parsed.alignment !== null) {
      const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } =
        parsed.alignment;
      if (characters.length !== starts.length || characters.length !== ends.length) {
        throw new TtsUpstreamError(null, 'the speech service returned malformed timing data');
      }
      for (let i = 0; i < characters.length; i++) {
        charAlignments.push({
          char: characters[i]!,
          startMs: Math.round(starts[i]! * 1000),
          endMs: Math.round(ends[i]! * 1000),
        });
      }
    }

    return { audio, mimeType: 'audio/mpeg', charAlignments };
  }
}

/** Provider whose every call fails with the "not configured" message —
 *  installed when no API key exists (dev/test) so the pipeline stays
 *  exercisable end-to-end and a claimed job settles with a clear error. */
class UnconfiguredTtsProvider implements TtsProvider {
  public synthesize(): Promise<TtsSynthesis> {
    return Promise.reject(new TtsNotConfiguredError());
  }
}

let _provider: TtsProvider | null = null;

/** The process-wide TTS provider (lazy; config-driven). Tests inject via
 *  setTtsProvider and MUST reset afterwards. */
export function getTtsProvider(): TtsProvider {
  if (_provider) return _provider;
  const cfg = loadConfig();
  _provider =
    cfg.ELEVENLABS_API_KEY !== undefined
      ? new ElevenLabsTtsProvider({
          apiKey: cfg.ELEVENLABS_API_KEY,
          defaultVoiceId: cfg.ELEVENLABS_VOICE_ID,
        })
      : new UnconfiguredTtsProvider();
  return _provider;
}

/** Test-only injection point (also usable by a future provider swap). */
export function setTtsProvider(provider: TtsProvider): void {
  _provider = provider;
}

export function resetTtsProviderForTesting(): void {
  _provider = null;
}
