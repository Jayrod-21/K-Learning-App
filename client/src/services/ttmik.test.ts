/**
 * ttmik service — URL construction, envelope unwrap, and audio-src build.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAudioSrc,
  buildStoryImageSrc,
  getIyagiEpisode,
  getIyagiEpisodes,
  getTtmikLesson,
  getTtmikLessons,
} from './ttmik';
import { api, ApiError } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getTtmikLessons', () => {
  it('GETs /ttmik/lessons and unwraps the lessons array', async () => {
    const lessons = [
      { level: 1, number: 1, title: 'Hello / Thank you', hasAudio: true },
      { level: 2, number: 21, title: 'More / -(으)ㄴ 것 같다', hasAudio: false },
    ];
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ lessons });

    const got = await getTtmikLessons();

    expect(spy).toHaveBeenCalledWith('/ttmik/lessons', undefined);
    expect(got).toBe(lessons);
    expect(got).toHaveLength(2);
    expect(got[1]?.hasAudio).toBe(false);
  });

  it('forwards an AbortSignal to the request config', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ lessons: [] });
    const ctrl = new AbortController();

    await getTtmikLessons(ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/ttmik/lessons', {
      signal: ctrl.signal,
    });
  });

  it('rethrows ApiError on a failed request', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('network unreachable', { status: 0, code: 'network' }),
    );

    await expect(getTtmikLessons()).rejects.toMatchObject({ code: 'network' });
  });
});

describe('getTtmikLesson', () => {
  it('constructs /ttmik/lessons/:level/:number and returns the detail', async () => {
    const detail = {
      meta: { level: 2, number: 21, title: 'More', hasAudio: true },
      sentences: [
        {
          id: 7,
          ordinal: 1,
          korean: '안녕하세요.',
          english: 'Hello.',
          romanization: 'annyeonghaseyo',
          speaker: null,
          is_dialog: false,
        },
      ],
      audioUrl: '/ttmik/lessons/2/21/audio',
    };
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(detail);

    const got = await getTtmikLesson(2, 21);

    expect(spy).toHaveBeenCalledWith('/ttmik/lessons/2/21', undefined);
    expect(got).toBe(detail);
    expect(got.audioUrl).toBe('/ttmik/lessons/2/21/audio');
  });

  it('surfaces ApiError(404) for an unknown lesson', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('not found', { status: 404, code: 'not_found' }),
    );

    await expect(getTtmikLesson(9, 999)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('getIyagiEpisodes', () => {
  it('GETs /iyagi/episodes and unwraps the episodes array', async () => {
    const episodes = [
      { number: 1, title: '서울의 겨울', hasAudio: true },
      { number: 143, title: '한국의 카페 문화', hasAudio: true },
    ];
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ episodes });

    const got = await getIyagiEpisodes();

    expect(spy).toHaveBeenCalledWith('/iyagi/episodes', undefined);
    expect(got).toBe(episodes);
  });

  it('rethrows ApiError on a failed request', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('server error', { status: 500, code: 'server_error' }),
    );

    await expect(getIyagiEpisodes()).rejects.toMatchObject({ status: 500 });
  });
});

describe('getIyagiEpisode', () => {
  it('constructs /iyagi/episodes/:number and returns the detail', async () => {
    const detail = {
      meta: {
        number: 143,
        title: '한국의 카페 문화',
        hosts: ['경화', '석진'],
        hasAudio: true,
      },
      sentences: [],
      audioUrl: '/iyagi/episodes/143/audio',
    };
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(detail);

    const got = await getIyagiEpisode(143);

    expect(spy).toHaveBeenCalledWith('/iyagi/episodes/143', undefined);
    expect(got).toBe(detail);
    expect(got.meta.hosts).toEqual(['경화', '석진']);
  });

  it('surfaces ApiError on network failure', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('network unreachable', { status: 0, code: 'network' }),
    );

    await expect(getIyagiEpisode(1)).rejects.toMatchObject({
      code: 'network',
    });
  });
});

describe('buildAudioSrc', () => {
  it('returns null for a null audioUrl (no audio mapped)', () => {
    expect(buildAudioSrc(null, '')).toBeNull();
    expect(buildAudioSrc(null, 'http://localhost:4000')).toBeNull();
  });

  it('returns the app-relative path verbatim on an empty base (prod same-origin)', () => {
    expect(buildAudioSrc('/ttmik/lessons/2/21/audio', '')).toBe(
      '/ttmik/lessons/2/21/audio',
    );
  });

  it('prefixes the API base when one is configured (dev split-origin)', () => {
    expect(
      buildAudioSrc('/iyagi/episodes/143/audio', 'http://localhost:4000'),
    ).toBe('http://localhost:4000/iyagi/episodes/143/audio');
  });

  it('rejects a non-app-relative audioUrl (absolute or protocol-relative)', () => {
    expect(buildAudioSrc('https://evil.example/a.mp3', '')).toBeNull();
    expect(buildAudioSrc('//evil.example/a.mp3', '')).toBeNull();
    expect(buildAudioSrc('evil.example/a.mp3', '')).toBeNull();
    // Normalization bypass (F-012 R3 BLOCKER): a leading backslash or an embedded
    // tab/newline normalizes to `//` in the browser/URL parser, so the old prefix
    // heuristic let these resolve off-origin. The strict allow-list rejects them.
    expect(buildAudioSrc('/\\evil.example/a.mp3', '')).toBeNull();
    expect(buildAudioSrc('/\tevil.example/a.mp3', '')).toBeNull();
    expect(buildAudioSrc('/\nevil.example/a.mp3', '')).toBeNull();
    // Right prefix but wrong shape (extra segments / traversal / missing id) — rejected.
    expect(buildAudioSrc('/ttmik/lessons/2/21/audio/../../x', '')).toBeNull();
    expect(buildAudioSrc('/ttmik/lessons/2/audio', '')).toBeNull();
    expect(buildAudioSrc('/ttmik/lessons/2/21/audiox', '')).toBeNull();
  });

  // Track A A-4b — My Audio track streams join the allow-list.
  it('accepts the My Audio track stream shape (/audio/tracks/:id/stream)', () => {
    expect(buildAudioSrc('/audio/tracks/1/stream', '')).toBe(
      '/audio/tracks/1/stream',
    );
    expect(buildAudioSrc('/audio/tracks/427/stream', 'http://localhost:4000')).toBe(
      'http://localhost:4000/audio/tracks/427/stream',
    );
  });

  it('rejects near-misses of the My Audio stream shape (the anchor holds)', () => {
    // Trailing junk / a lookalike suffix.
    expect(buildAudioSrc('/audio/tracks/1/streamx', '')).toBeNull();
    expect(buildAudioSrc('/audio/tracks/1/stream/', '')).toBeNull();
    expect(buildAudioSrc('/audio/tracks/1/stream?x=1', '')).toBeNull();
    // Traversal past the anchored tail.
    expect(buildAudioSrc('/audio/tracks/1/stream/../x', '')).toBeNull();
    // Protocol-relative / missing leading slash / non-numeric id.
    expect(buildAudioSrc('//audio/tracks/1/stream', '')).toBeNull();
    expect(buildAudioSrc('audio/tracks/1/stream', '')).toBeNull();
    expect(buildAudioSrc('/audio/tracks//stream', '')).toBeNull();
    expect(buildAudioSrc('/audio/tracks/abc/stream', '')).toBeNull();
    // The bare route family without the stream tail is NOT playable media.
    expect(buildAudioSrc('/audio/tracks/1', '')).toBeNull();
    expect(buildAudioSrc('/audio', '')).toBeNull();
    // Whitespace near-misses (R3-N3): the unflagged `$` must not tolerate a
    // trailing newline (it would in Python / with the `m` flag), and
    // embedded whitespace must not slip past the digit/literal segments.
    expect(buildAudioSrc('/audio/tracks/1/stream\n', '')).toBeNull();
    expect(buildAudioSrc('/audio/tracks/1/stream ', '')).toBeNull();
    expect(buildAudioSrc('/audio/tracks/1\t/stream', '')).toBeNull();
  });

  // F-119 — the TOPIK mock exam's whole-section audio joins the allow-list.
  it('accepts the TOPIK exam audio shape (/topik/audio/:testNumber/:level)', () => {
    expect(buildAudioSrc('/topik/audio/60/2', '')).toBe('/topik/audio/60/2');
    expect(buildAudioSrc('/topik/audio/35/1', 'http://localhost:4000')).toBe(
      'http://localhost:4000/topik/audio/35/1',
    );
  });

  it('rejects near-misses of the TOPIK exam audio shape (the anchor holds)', () => {
    // The level segment is EXACTLY 1 or 2 (the GET /topik/audio contract).
    expect(buildAudioSrc('/topik/audio/60/3', '')).toBeNull();
    expect(buildAudioSrc('/topik/audio/60/0', '')).toBeNull();
    expect(buildAudioSrc('/topik/audio/60/12', '')).toBeNull();
    // Non-numeric test number / missing segments.
    expect(buildAudioSrc('/topik/audio/x/2', '')).toBeNull();
    expect(buildAudioSrc('/topik/audio/2', '')).toBeNull();
    expect(buildAudioSrc('/topik/audio//2', '')).toBeNull();
    // Trailing junk / traversal past the anchored tail.
    expect(buildAudioSrc('/topik/audio/60/2/', '')).toBeNull();
    expect(buildAudioSrc('/topik/audio/60/2/extra', '')).toBeNull();
    expect(buildAudioSrc('/topik/audio/60/2/../1', '')).toBeNull();
    expect(buildAudioSrc('/topik/audio/60/2?x=1', '')).toBeNull();
    // Off-origin variants (protocol-relative / absolute / normalization
    // bypass — the same F-012 R3 family the other shapes reject).
    expect(buildAudioSrc('//topik/audio/60/2', '')).toBeNull();
    expect(buildAudioSrc('topik/audio/60/2', '')).toBeNull();
    expect(buildAudioSrc('https://evil.example/topik/audio/60/2', '')).toBeNull();
    expect(buildAudioSrc('/\\evil.example/topik/audio/60/2', '')).toBeNull();
    expect(buildAudioSrc('/topik/audio/60/2\n', '')).toBeNull();
  });
});

// F-211 — story-illustration blobs get their own strict resolver.
describe('buildStoryImageSrc', () => {
  it('returns the app-relative path verbatim on an empty base (prod same-origin)', () => {
    expect(buildStoryImageSrc('/reading/generated/7/image/1/blob', '')).toBe(
      '/reading/generated/7/image/1/blob',
    );
  });

  it('prefixes the API base when one is configured (dev split-origin)', () => {
    expect(
      buildStoryImageSrc(
        '/reading/generated/123/image/4/blob',
        'http://localhost:4000',
      ),
    ).toBe('http://localhost:4000/reading/generated/123/image/4/blob');
  });

  it('rejects a non-app-relative blobUrl (absolute / protocol-relative / normalization bypass)', () => {
    expect(buildStoryImageSrc('https://evil.example/x.png', '')).toBeNull();
    expect(buildStoryImageSrc('//evil.example/x.png', '')).toBeNull();
    expect(buildStoryImageSrc('evil.example/x.png', '')).toBeNull();
    // The F-012 R3 family: leading backslash / embedded whitespace
    // normalizes to `//` in the browser's URL parser.
    expect(
      buildStoryImageSrc('/\\evil.example/reading/generated/7/image/1/blob', ''),
    ).toBeNull();
    expect(
      buildStoryImageSrc('/\tevil.example/image/1/blob', ''),
    ).toBeNull();
    expect(
      buildStoryImageSrc('/\nevil.example/image/1/blob', ''),
    ).toBeNull();
  });

  it('rejects near-misses of the blob shape (the anchor holds)', () => {
    // Trailing junk / a lookalike suffix / query smuggling.
    expect(buildStoryImageSrc('/reading/generated/7/image/1/blobx', '')).toBeNull();
    expect(buildStoryImageSrc('/reading/generated/7/image/1/blob/', '')).toBeNull();
    expect(buildStoryImageSrc('/reading/generated/7/image/1/blob?x=1', '')).toBeNull();
    // Traversal past the anchored tail.
    expect(
      buildStoryImageSrc('/reading/generated/7/image/1/blob/../x', ''),
    ).toBeNull();
    // Non-numeric / missing ids.
    expect(buildStoryImageSrc('/reading/generated/x/image/1/blob', '')).toBeNull();
    expect(buildStoryImageSrc('/reading/generated/7/image//blob', '')).toBeNull();
    expect(buildStoryImageSrc('/reading/generated/7/image/blob', '')).toBeNull();
    // A different (even legitimate) route family is NOT an image blob.
    expect(buildStoryImageSrc('/reading/generated/7/images', '')).toBeNull();
    expect(buildStoryImageSrc('/audio/tracks/1/stream', '')).toBeNull();
    // Whitespace near-misses (the unflagged `$` must not tolerate a
    // trailing newline).
    expect(buildStoryImageSrc('/reading/generated/7/image/1/blob\n', '')).toBeNull();
    expect(buildStoryImageSrc('/reading/generated/7/image/1/blob ', '')).toBeNull();
  });
});
