/**
 * reading service — F-210 story-audio surface: URL construction for the
 * POST (request) / GET (status) pair, envelope unwrapping (`{ audio }` →
 * the StoryAudio object, untouched — the wire is camelCase already),
 * signal threading, ApiError passthrough (the daily-cap 429's structured
 * fields + server-authored message must survive intact for the UI's
 * verbatim-display contract), and the F-210 groundwork `turns` field
 * riding the story DTO unmodified. Mirrors audio.test.ts's conventions
 * (spy on the shared `api` methods — no network).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getGeneratedStory,
  getStoryAudio,
  requestStoryAudio,
} from './reading';
import type { StoryAudio } from './reading';
import { api, ApiError } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

const DONE_AUDIO: StoryAudio = {
  status: 'done',
  jobId: 11,
  error: null,
  track: {
    id: 9,
    streamUrl: '/audio/tracks/9/stream',
    durationMs: 8000,
  },
  segments: [
    { segmentNumber: 1, startMs: 0, endMs: 4000, body: '소년은 바닷가를 걸었다.' },
    { segmentNumber: 2, startMs: 4000, endMs: 8000, body: '바람이 불었다.' },
  ],
};

const PENDING_AUDIO: StoryAudio = {
  status: 'pending',
  jobId: 12,
  error: null,
  track: null,
  segments: [],
};

describe('requestStoryAudio', () => {
  it('POSTs /reading/generated/:id/audio with no body and unwraps the envelope', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ audio: PENDING_AUDIO });

    const got = await requestStoryAudio(7);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, body] = spy.mock.calls[0];
    expect(url).toBe('/reading/generated/7/audio');
    expect(body).toBeUndefined();
    expect(got).toEqual(PENDING_AUDIO);
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ audio: PENDING_AUDIO });
    const ctrl = new AbortController();

    await requestStoryAudio(7, ctrl.signal);

    expect(spy.mock.calls[0][2]?.signal).toBe(ctrl.signal);
  });

  it('re-throws the daily-cap 429 ApiError with message, code, and status intact (verbatim-display contract)', async () => {
    const capError = new ApiError(
      'daily story-audio limit reached: 3 of 3 generations used today. Try again tomorrow.',
      { status: 429, code: 'rate_limited' },
    );
    vi.spyOn(api, 'post').mockRejectedValueOnce(capError);

    await expect(requestStoryAudio(7)).rejects.toBe(capError);
    // The structured fields the UI discriminates on must be untouched:
    // no retryAfter = the daily cap (verbatim message), status/code intact.
    expect(capError.retryAfter).toBeUndefined();
    expect(capError.status).toBe(429);
    expect(capError.code).toBe('rate_limited');
  });
});

describe('getStoryAudio', () => {
  it('GETs /reading/generated/:id/audio and unwraps the envelope untouched (track + ordered segments)', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ audio: DONE_AUDIO });

    const got = await getStoryAudio(7);

    expect(spy.mock.calls[0][0]).toBe('/reading/generated/7/audio');
    expect(got).toEqual(DONE_AUDIO);
    expect(got.track?.streamUrl).toBe('/audio/tracks/9/stream');
    expect(got.segments).toHaveLength(2);
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ audio: PENDING_AUDIO });
    const ctrl = new AbortController();

    await getStoryAudio(7, ctrl.signal);

    expect(spy.mock.calls[0][1]?.signal).toBe(ctrl.signal);
  });

  it('re-throws a 404 ApiError untouched (uniform missing/foreign story)', async () => {
    const notFound = new ApiError('story not found', {
      status: 404,
      code: 'not_found',
    });
    vi.spyOn(api, 'get').mockRejectedValueOnce(notFound);

    await expect(getStoryAudio(999)).rejects.toBe(notFound);
  });

  it('passes the ttsConfigured capability flag through unmodified (dormant-deploy signal)', async () => {
    const dormant: StoryAudio = {
      status: 'none',
      jobId: null,
      error: null,
      track: null,
      segments: [],
      ttsConfigured: false,
    };
    vi.spyOn(api, 'get').mockResolvedValueOnce({ audio: dormant });

    const got = await getStoryAudio(7);

    expect(got.ttsConfigured).toBe(false);
    // And an envelope WITHOUT the flag (older server) stays undefined — the
    // UI treats that as "shown" (forward-compat default-true).
    vi.spyOn(api, 'get').mockResolvedValueOnce({ audio: PENDING_AUDIO });
    expect((await getStoryAudio(7)).ttsConfigured).toBeUndefined();
  });
});

describe('getGeneratedStory — F-210 turns groundwork', () => {
  it('passes the latent turns array through unmodified (no mapping, no UI consumption here)', async () => {
    const story = {
      id: 7,
      title: '바닷가 마을',
      level: 'L3',
      prompt: null,
      createdAt: '2026-08-01T00:00:00Z',
      bodyKo: '소년은 바닷가를 걸었다.',
      turns: [
        { speaker: 'narrator', text: '소년은 바닷가를 걸었다.' },
      ],
    };
    vi.spyOn(api, 'get').mockResolvedValueOnce({ story });

    const got = await getGeneratedStory(7);

    expect(got.turns).toEqual([
      { speaker: 'narrator', text: '소년은 바닷가를 걸었다.' },
    ]);
  });

  it('leaves a null turns (pre-081 story / no split emitted) as null', async () => {
    const story = {
      id: 8,
      title: '옛 이야기',
      level: 'L2',
      prompt: null,
      createdAt: '2026-06-01T00:00:00Z',
      bodyKo: '옛날 옛적에.',
      turns: null,
    };
    vi.spyOn(api, 'get').mockResolvedValueOnce({ story });

    const got = await getGeneratedStory(8);

    expect(got.turns).toBeNull();
  });
});
