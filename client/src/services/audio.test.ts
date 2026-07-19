/**
 * audio service (Track A A-4b) — multipart upload config (boundary-clearing
 * Content-Type, long per-call timeout, real-bytes progress), the optional
 * title field, `GET /audio` wire → domain mapping (snake→camel, `slug`
 * dropped), `GET /audio/tracks/:id` URL construction + camelCase
 * passthrough, the client pre-check, signal threading, and ApiError
 * re-throw. Mirrors uploads.test.ts's conventions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AxiosProgressEvent } from 'axios';
import {
  MAX_AUDIO_UPLOAD_BYTES,
  checkAudioFile,
  getAudioTrack,
  listMyAudio,
  uploadAudio,
} from './audio';
import { api, ApiError } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

const UPLOAD_RESPONSE = {
  sourceId: 12,
  trackId: 34,
  jobId: 56,
  transcriptStatus: 'pending' as const,
};

const SOURCE_WIRE = {
  id: 12,
  slug: 'upload-abc',
  title: '팟캐스트 1화',
  kind: 'standalone_listening' as const,
  created_at: '2026-07-18T00:00:00Z',
  tracks: [
    {
      id: 34,
      track_number: 1,
      title: '팟캐스트 1화',
      byte_size: 2_048_000,
      duration_ms: 180_000,
      transcript_status: 'running' as const,
    },
  ],
};

function makeMp3File(name = 'recording.mp3', size = 1024): File {
  return new File([new Uint8Array(size)], name, { type: 'audio/mpeg' });
}

describe('uploadAudio', () => {
  it('POSTs /audio with FormData carrying the file + title and a boundary-clearing Content-Type', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce(UPLOAD_RESPONSE);

    const got = await uploadAudio(makeMp3File(), { title: '팟캐스트 1화' });

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, body, config] = spy.mock.calls[0];
    expect(url).toBe('/audio');
    expect(body).toBeInstanceOf(FormData);
    expect(config?.headers).toEqual({ 'Content-Type': undefined });

    const form = body as FormData;
    const file = form.get('file');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('recording.mp3');
    expect(form.get('title')).toBe('팟캐스트 1화');

    // Response is camelCase on the wire already — returned as-is.
    expect(got).toEqual(UPLOAD_RESPONSE);
  });

  it('omits the title field entirely when no title is given (server derives its own fallback)', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce(UPLOAD_RESPONSE);

    await uploadAudio(makeMp3File());

    const form = spy.mock.calls[0][1] as FormData;
    expect(form.get('title')).toBeNull();
  });

  it('treats an empty-string title like an omitted one (R1-N1 — server derives its fallback, never receives "")', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce(UPLOAD_RESPONSE);

    await uploadAudio(makeMp3File(), { title: '' });

    const form = spy.mock.calls[0][1] as FormData;
    expect(form.get('title')).toBeNull();
  });

  it('threads an AbortSignal into the request config alongside the cleared header', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce(UPLOAD_RESPONSE);
    const ctrl = new AbortController();

    await uploadAudio(makeMp3File(), { signal: ctrl.signal });

    const config = spy.mock.calls[0][2];
    expect(config?.signal).toBe(ctrl.signal);
    expect(config?.headers).toEqual({ 'Content-Type': undefined });
  });

  it('overrides the app-wide 10s timeout with at least the 10-minute audio floor (a 100 MB transfer would otherwise misfire)', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce(UPLOAD_RESPONSE);

    await uploadAudio(makeMp3File());

    const config = spy.mock.calls[0][2];
    // The floor, not just "bigger than the default" (R3-N2): a regression to
    // e.g. 30 s would still pass a > 10_000 check yet kill real transfers.
    expect(config?.timeout).toBeGreaterThanOrEqual(600_000);
  });

  it('threads onProgress into axios onUploadProgress, computing an integer percent from real loaded/total bytes', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce(UPLOAD_RESPONSE);
    const onProgress = vi.fn();

    await uploadAudio(makeMp3File(), { onProgress });

    const config = spy.mock.calls[0][2];
    expect(config?.onUploadProgress).toBeInstanceOf(Function);
    const progress = config?.onUploadProgress as (e: AxiosProgressEvent) => void;
    progress({ loaded: 333, total: 1000, bytes: 333, lengthComputable: true });
    expect(onProgress).toHaveBeenCalledWith(33);
    // `total` absent (indeterminate length) — never divides by undefined.
    progress({ loaded: 500, bytes: 500, lengthComputable: false });
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('omitting onProgress leaves onUploadProgress unset (no unconditional callback)', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce(UPLOAD_RESPONSE);

    await uploadAudio(makeMp3File());

    const config = spy.mock.calls[0][2];
    expect(config?.onUploadProgress).toBeUndefined();
  });

  it('rethrows ApiError on a failed upload (413 over the per-file cap)', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('payload too large', { status: 413, code: 'payload_too_large' }),
    );

    await expect(uploadAudio(makeMp3File())).rejects.toMatchObject({
      status: 413,
    });
  });
});

describe('listMyAudio', () => {
  it('GETs /audio and maps the wire sources onto the domain shape (snake→camel, slug dropped)', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ sources: [SOURCE_WIRE] });

    const got = await listMyAudio();

    expect(spy).toHaveBeenCalledWith('/audio', undefined);
    expect(got).toEqual([
      {
        id: 12,
        title: '팟캐스트 1화',
        kind: 'standalone_listening',
        createdAt: '2026-07-18T00:00:00Z',
        tracks: [
          {
            id: 34,
            trackNumber: 1,
            title: '팟캐스트 1화',
            byteSize: 2_048_000,
            durationMs: 180_000,
            transcriptStatus: 'running',
          },
        ],
      },
    ]);
    expect(got[0]).not.toHaveProperty('slug');
  });

  it('forwards an AbortSignal to the request config', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ sources: [] });
    const ctrl = new AbortController();

    await listMyAudio(ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/audio', { signal: ctrl.signal });
  });

  it('rethrows ApiError on a failed request', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('network unreachable', { status: 0, code: 'network' }),
    );

    await expect(listMyAudio()).rejects.toMatchObject({ code: 'network' });
  });
});

describe('getAudioTrack', () => {
  it('constructs /audio/tracks/:id and returns the camelCase detail as-is', async () => {
    const detail = {
      track: {
        id: 34,
        title: '팟캐스트 1화',
        transcriptStatus: 'done' as const,
        durationMs: 180_000,
        streamUrl: '/audio/tracks/34/stream',
      },
      segments: [
        { segmentNumber: 1, startMs: 0, endMs: 4200, body: '안녕하세요.' },
      ],
    };
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(detail);

    const got = await getAudioTrack(34);

    expect(spy).toHaveBeenCalledWith('/audio/tracks/34', undefined);
    expect(got).toBe(detail);
  });

  it('forwards an AbortSignal to the request config', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({
      track: {
        id: 1,
        title: null,
        transcriptStatus: 'pending',
        durationMs: null,
        streamUrl: '/audio/tracks/1/stream',
      },
      segments: [],
    });
    const ctrl = new AbortController();

    await getAudioTrack(1, ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/audio/tracks/1', {
      signal: ctrl.signal,
    });
  });

  it('surfaces the uniform 404 (missing OR foreign track) as ApiError', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('track not found', { status: 404, code: 'not_found' }),
    );

    await expect(getAudioTrack(999)).rejects.toMatchObject({ status: 404 });
  });
});

describe('checkAudioFile', () => {
  it('accepts an mp3 by mime and an m4a by extension', () => {
    expect(checkAudioFile(makeMp3File())).toBeNull();
    expect(
      checkAudioFile(
        new File([new Uint8Array(10)], 'note.m4a', { type: '' }),
      ),
    ).toBeNull();
  });

  it('rejects a non-audio file with fixed copy', () => {
    const msg = checkAudioFile(
      new File([new Uint8Array(10)], 'notes.txt', { type: 'text/plain' }),
    );
    expect(msg).toBe('That file isn’t an MP3 or M4A. Choose a .mp3 or .m4a file.');
  });

  it('rejects a file over the 100 MiB cap with fixed copy (without allocating 100 MiB)', () => {
    const file = makeMp3File('big.mp3', 1);
    Object.defineProperty(file, 'size', {
      value: MAX_AUDIO_UPLOAD_BYTES + 1,
    });
    expect(checkAudioFile(file)).toBe(
      'That file is too large. Pick one under 100 MB.',
    );
  });
});
