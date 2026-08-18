/**
 * reading service — F-210 story-audio surface: URL construction for the
 * POST (request) / GET (status) pair, envelope unwrapping (`{ audio }` →
 * the StoryAudio object, untouched — the wire is camelCase already),
 * signal threading, ApiError passthrough (the daily-cap 429's structured
 * fields + server-authored message must survive intact for the UI's
 * verbatim-display contract), and the F-210 groundwork `turns` field
 * riding the story DTO unmodified. Mirrors audio.test.ts's conventions
 * (spy on the shared `api` methods — no network).
 *
 * Also the F-211 story-images surface: the same POST (request) / GET
 * (status) pair against `/reading/generated/:id/images`, `{ images }`
 * envelope unwrapping, signal threading, the daily-cap 429 / 404 / 503
 * ApiError passthroughs, and the `imageGenConfigured` dormant-deploy flag
 * riding through unmodified.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getGeneratedStory,
  getReadingPosition,
  getStoryAudio,
  getStoryImages,
  listGeneratedAudio,
  listGeneratedStories,
  requestStoryAudio,
  requestStoryExperience,
  requestStoryImages,
} from './reading';
import type {
  GeneratedStoryLibrary,
  StoryAudio,
  StoryExperienceResult,
  StoryImagesEnvelope,
} from './reading';
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

describe('getReadingPosition (F-069 + the F-217 non-owner 404 tolerance)', () => {
  it('GETs /reading/position/:uploadId and maps the saved position (snake → camel)', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({
      position: {
        source_upload_id: 41,
        chapter_id: 5,
        passage_number: null,
        page_number: 3,
        updated_at: '2026-08-01T00:00:00Z',
      },
    });

    const got = await getReadingPosition('41');

    expect(spy.mock.calls[0][0]).toBe('/reading/position/41');
    expect(got).toEqual({
      sourceUploadId: 41,
      chapterId: 5,
      passageNumber: null,
      pageNumber: 3,
      updatedAt: '2026-08-01T00:00:00Z',
    });
  });

  it('resolves null for a null-position envelope (nothing saved yet)', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({ position: null });

    await expect(getReadingPosition('41')).resolves.toBeNull();
  });

  it('F-217: resolves null on a 404 — the owner-only position route on a SHARED book is "no resume", never a picker-level failure', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('not found', { status: 404, code: 'not_found' }),
    );

    await expect(getReadingPosition('41')).resolves.toBeNull();
  });

  it('still rejects on every NON-404 error (a real failure must surface)', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    await expect(getReadingPosition('41')).rejects.toMatchObject({
      status: 500,
    });
  });
});

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

describe('listGeneratedAudio', () => {
  const VOICED = [
    {
      id: 41,
      title: '겨울 산책',
      level: 'L4',
      streamUrl: '/audio/tracks/900/stream',
      durationMs: 12000,
    },
    {
      id: 7,
      title: '바닷가 이야기',
      level: 'L2',
      streamUrl: '/audio/tracks/901/stream',
      durationMs: null,
    },
  ];

  it('GETs /reading/generated/audio and unwraps the stories envelope untouched', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ stories: VOICED });

    const got = await listGeneratedAudio();

    expect(spy).toHaveBeenCalledTimes(1);
    // The LITERAL list path — never a /generated/:id shape.
    expect(spy.mock.calls[0][0]).toBe('/reading/generated/audio');
    expect(got).toEqual(VOICED);
    expect(got[0]?.streamUrl).toBe('/audio/tracks/900/stream');
  });

  it('an empty list (nothing voiced yet) resolves to [] — a normal state, not an error', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({ stories: [] });
    expect(await listGeneratedAudio()).toEqual([]);
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ stories: [] });
    const ctrl = new AbortController();

    await listGeneratedAudio(ctrl.signal);

    expect(spy.mock.calls[0][1]?.signal).toBe(ctrl.signal);
  });

  it('re-throws an ApiError untouched', async () => {
    const boom = new ApiError('boom internal', {
      status: 500,
      code: 'server_error',
    });
    vi.spyOn(api, 'get').mockRejectedValueOnce(boom);

    await expect(listGeneratedAudio()).rejects.toBe(boom);
  });
});

// ─────────────────────────────────────────────────────────────
// F-211 — story illustrations
// ─────────────────────────────────────────────────────────────

const DONE_IMAGES: StoryImagesEnvelope = {
  status: 'done',
  jobId: 21,
  error: null,
  images: [
    {
      imageNumber: 1,
      blobUrl: '/reading/generated/7/image/1/blob',
      prompt: 'A boy walking along a beach, Korean webtoon style',
      width: 1024,
      height: 1024,
    },
    {
      imageNumber: 2,
      blobUrl: '/reading/generated/7/image/2/blob',
      prompt: 'Wind sweeping over the sea, Korean webtoon style',
      width: 1024,
      height: 1024,
    },
  ],
  imageGenConfigured: true,
};

const PENDING_IMAGES: StoryImagesEnvelope = {
  status: 'pending',
  jobId: 22,
  error: null,
  images: [],
  imageGenConfigured: true,
};

describe('requestStoryImages', () => {
  it('POSTs /reading/generated/:id/images with no body and unwraps the envelope', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ images: PENDING_IMAGES });

    const got = await requestStoryImages(7);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, body] = spy.mock.calls[0];
    expect(url).toBe('/reading/generated/7/images');
    expect(body).toBeUndefined();
    expect(got).toEqual(PENDING_IMAGES);
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ images: PENDING_IMAGES });
    const ctrl = new AbortController();

    await requestStoryImages(7, ctrl.signal);

    expect(spy.mock.calls[0][2]?.signal).toBe(ctrl.signal);
  });

  it('re-throws the daily-cap 429 ApiError with message, code, and status intact (verbatim-display contract)', async () => {
    const capError = new ApiError(
      'daily story-image limit reached. Try again tomorrow.',
      { status: 429, code: 'rate_limited' },
    );
    vi.spyOn(api, 'post').mockRejectedValueOnce(capError);

    await expect(requestStoryImages(7)).rejects.toBe(capError);
    // The structured fields the UI discriminates on must be untouched:
    // no retryAfter = the daily cap (verbatim message), status/code intact.
    expect(capError.retryAfter).toBeUndefined();
    expect(capError.status).toBe(429);
    expect(capError.code).toBe('rate_limited');
  });

  it('re-throws a 503 ApiError untouched (unconfigured deploy — the UI hides the affordance before this can fire)', async () => {
    const unconfigured = new ApiError('image generation is not configured', {
      status: 503,
      code: 'service_unavailable',
    });
    vi.spyOn(api, 'post').mockRejectedValueOnce(unconfigured);

    await expect(requestStoryImages(7)).rejects.toBe(unconfigured);
  });
});

describe('getStoryImages', () => {
  it('GETs /reading/generated/:id/images and unwraps the envelope untouched (ordered image list)', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ images: DONE_IMAGES });

    const got = await getStoryImages(7);

    expect(spy.mock.calls[0][0]).toBe('/reading/generated/7/images');
    expect(got).toEqual(DONE_IMAGES);
    expect(got.images).toHaveLength(2);
    expect(got.images[0]?.blobUrl).toBe('/reading/generated/7/image/1/blob');
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ images: PENDING_IMAGES });
    const ctrl = new AbortController();

    await getStoryImages(7, ctrl.signal);

    expect(spy.mock.calls[0][1]?.signal).toBe(ctrl.signal);
  });

  it('re-throws a 404 ApiError untouched (uniform missing/foreign story)', async () => {
    const notFound = new ApiError('story not found', {
      status: 404,
      code: 'not_found',
    });
    vi.spyOn(api, 'get').mockRejectedValueOnce(notFound);

    await expect(getStoryImages(999)).rejects.toBe(notFound);
  });

  it('passes the imageGenConfigured capability flag through unmodified (dormant-deploy signal)', async () => {
    const dormant: StoryImagesEnvelope = {
      status: 'none',
      jobId: null,
      error: null,
      images: [],
      imageGenConfigured: false,
    };
    vi.spyOn(api, 'get').mockResolvedValueOnce({ images: dormant });

    const got = await getStoryImages(7);

    expect(got.imageGenConfigured).toBe(false);
    // And an envelope WITHOUT the flag stays undefined — the UI treats that
    // as "shown" (forward-compat default-true, the ttsConfigured posture).
    const noFlag: StoryImagesEnvelope = {
      status: 'none',
      jobId: null,
      error: null,
      images: [],
    };
    vi.spyOn(api, 'get').mockResolvedValueOnce({ images: noFlag });
    expect((await getStoryImages(7)).imageGenConfigured).toBeUndefined();
  });

  it('passes a failed envelope (server-authored error copy) through verbatim', async () => {
    const failed: StoryImagesEnvelope = {
      status: 'failed',
      jobId: 23,
      error: 'The image service is unavailable right now. Try again later.',
      images: [],
      imageGenConfigured: true,
    };
    vi.spyOn(api, 'get').mockResolvedValueOnce({ images: failed });

    const got = await getStoryImages(7);

    expect(got.status).toBe('failed');
    expect(got.error).toBe(
      'The image service is unavailable right now. Try again later.',
    );
  });
});

// ─────────────────────────────────────────────────────────────
// F-216 — unified story experience
// ─────────────────────────────────────────────────────────────

const LIBRARY: GeneratedStoryLibrary = {
  stories: [
    {
      id: 7,
      title: '바닷가 마을',
      level: 'L3',
      prompt: null,
      createdAt: '2026-07-08T12:00:00Z',
      audioStatus: 'done',
      imageStatus: 'failed',
    },
    {
      id: 8,
      title: '겨울 산책',
      level: 'L4',
      prompt: '겨울',
      createdAt: '2026-07-01T12:00:00Z',
      audioStatus: 'pending',
      imageStatus: 'none',
    },
  ],
  ttsConfigured: true,
  imageGenConfigured: true,
};

describe('listGeneratedStories — F-216 aggregate library', () => {
  it('GETs /reading/generated and returns the whole envelope (rows + capability flags) untouched', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(LIBRARY);

    const got = await listGeneratedStories();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('/reading/generated');
    expect(got).toEqual(LIBRARY);
    // The per-row aggregate statuses ride through unmodified.
    expect(got.stories[0]?.audioStatus).toBe('done');
    expect(got.stories[0]?.imageStatus).toBe('failed');
    expect(got.stories[1]?.audioStatus).toBe('pending');
    expect(got.stories[1]?.imageStatus).toBe('none');
  });

  it('leaves ABSENT capability flags undefined — the UI treats that as shown (default-true posture)', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({ stories: [] });

    const got = await listGeneratedStories();

    expect(got.stories).toEqual([]);
    expect(got.ttsConfigured).toBeUndefined();
    expect(got.imageGenConfigured).toBeUndefined();
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ stories: [] });
    const ctrl = new AbortController();

    await listGeneratedStories(ctrl.signal);

    expect(spy.mock.calls[0][1]?.signal).toBe(ctrl.signal);
  });

  it('re-throws an ApiError untouched', async () => {
    const boom = new ApiError('boom internal', {
      status: 500,
      code: 'server_error',
    });
    vi.spyOn(api, 'get').mockRejectedValueOnce(boom);

    await expect(listGeneratedStories()).rejects.toBe(boom);
  });
});

describe('requestStoryExperience', () => {
  const EXPERIENCE: StoryExperienceResult = {
    audio: { ...PENDING_AUDIO, enqueueBlocked: null },
    images: { ...PENDING_IMAGES, enqueueBlocked: null },
  };

  it('POSTs /reading/generated/:id/experience with no body and unwraps the envelope', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ experience: EXPERIENCE });

    const got = await requestStoryExperience(7);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, body] = spy.mock.calls[0];
    expect(url).toBe('/reading/generated/7/experience');
    expect(body).toBeUndefined();
    expect(got).toEqual(EXPERIENCE);
  });

  it('passes the per-half enqueueBlocked discriminators through verbatim (dormant / daily_cap)', async () => {
    const blocked: StoryExperienceResult = {
      audio: {
        ...PENDING_AUDIO,
        status: 'none',
        jobId: null,
        ttsConfigured: false,
        enqueueBlocked: 'dormant',
      },
      images: {
        ...PENDING_IMAGES,
        status: 'none',
        jobId: null,
        enqueueBlocked: 'daily_cap',
      },
    };
    vi.spyOn(api, 'post').mockResolvedValueOnce({ experience: blocked });

    const got = await requestStoryExperience(7);

    expect(got.audio.enqueueBlocked).toBe('dormant');
    expect(got.audio.ttsConfigured).toBe(false);
    expect(got.images.enqueueBlocked).toBe('daily_cap');
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ experience: EXPERIENCE });
    const ctrl = new AbortController();

    await requestStoryExperience(7, ctrl.signal);

    expect(spy.mock.calls[0][2]?.signal).toBe(ctrl.signal);
  });

  it('re-throws a short-window 429 ApiError with retryAfter intact (the expensive-route limiter)', async () => {
    const limited = new ApiError('rate limited', {
      status: 429,
      code: 'rate_limited',
      retryAfter: 30,
    });
    vi.spyOn(api, 'post').mockRejectedValueOnce(limited);

    await expect(requestStoryExperience(7)).rejects.toBe(limited);
    expect(limited.retryAfter).toBe(30);
  });

  it('re-throws a 404 ApiError untouched (uniform missing/foreign story)', async () => {
    const notFound = new ApiError('story not found', {
      status: 404,
      code: 'not_found',
    });
    vi.spyOn(api, 'post').mockRejectedValueOnce(notFound);

    await expect(requestStoryExperience(999)).rejects.toBe(notFound);
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
