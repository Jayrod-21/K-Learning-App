/**
 * images service — multipart upload config, envelope unwrap, wire → domain
 * mapping (createdAt → capturedAt, derived blobUrl, no boxes), id encoding,
 * signal threading, and error re-throw. Mirrors the topik/hanja service test
 * style.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blobUrlFor, fetchImage, fetchImages, uploadImage } from './images';
import { api, ApiError } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

// WIRE FIDELITY: the server's `ImageWordDTO` carries kr/en/gloss/pos ONLY —
// no `id` (routes/images.ts). Earlier fixtures invented `id:'w1'…`, which
// masked the added-set-keyed-on-undefined bug in the Images page.
const CAPTURE_WIRE = {
  id: '42',
  name: '카페 메뉴판',
  caption_kr: '카페 메뉴판',
  caption_en: 'Café menu',
  createdAt: '2026-05-28T10:14:00+09:00',
  words: [
    { kr: '음료', en: 'beverage', pos: 'n.', gloss: 'beverage, drink' },
    { kr: '라떼', en: 'latte', pos: 'n.', gloss: 'caffè latte' },
  ],
};

const SUMMARY_WIRE = {
  id: '42',
  name: '카페 메뉴판',
  caption_kr: '카페 메뉴판',
  caption_en: 'Café menu',
  createdAt: '2026-05-28T10:14:00+09:00',
};

function makeFile(): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff])], 'menu.jpg', {
    type: 'image/jpeg',
  });
}

describe('uploadImage', () => {
  it('POSTs /images/ocr with FormData and a boundary-clearing Content-Type', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ capture: CAPTURE_WIRE });

    await uploadImage(makeFile());

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, body, config] = spy.mock.calls[0];
    expect(url).toBe('/images/ocr');
    expect(body).toBeInstanceOf(FormData);
    // The browser/axios must set the multipart boundary — we clear the JSON
    // default so it isn't pinned to a boundary-less value.
    expect(config?.headers).toEqual({ 'Content-Type': undefined });
    // The file rides under the `image` field with its original name.
    const form = body as FormData;
    const sent = form.get('image');
    expect(sent).toBeInstanceOf(File);
    expect((sent as File).name).toBe('menu.jpg');
  });

  it('maps the wire capture onto the domain shape (createdAt → capturedAt, derived blobUrl, no boxes)', async () => {
    vi.spyOn(api, 'post').mockResolvedValueOnce({ capture: CAPTURE_WIRE });

    const cap = await uploadImage(makeFile());

    expect(cap.id).toBe('42');
    expect(cap.capturedAt).toBe('2026-05-28T10:14:00+09:00');
    expect(cap.blobUrl).toBe('/images/42/blob');
    expect(cap.words).toHaveLength(2);
    // Field-for-field wire mapping — and NO fabricated `id`: the wire sends
    // none, and inventing one here previously masked a real keying bug.
    expect(cap.words[0]).toEqual({
      kr: '음료',
      en: 'beverage',
      pos: 'n.',
      gloss: 'beverage, drink',
    });
    expect(cap.words[0]).not.toHaveProperty('id');
    // No bounding box leaks through.
    expect(cap.words[0]).not.toHaveProperty('box');
  });

  it('threads an AbortSignal into the request config alongside the cleared header', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ capture: CAPTURE_WIRE });
    const ctrl = new AbortController();

    await uploadImage(makeFile(), ctrl.signal);

    const config = spy.mock.calls[0][2];
    expect(config?.signal).toBe(ctrl.signal);
    expect(config?.headers).toEqual({ 'Content-Type': undefined });
  });

  it('rethrows ApiError on failure (e.g. daily cap)', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('daily limit reached', { status: 429, code: 'rate_limited' }),
    );

    await expect(uploadImage(makeFile())).rejects.toMatchObject({
      status: 429,
    });
  });
});

describe('fetchImages', () => {
  it('GETs /images and maps summaries (blobUrl derived, words empty)', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ captures: [SUMMARY_WIRE] });

    const list = await fetchImages();

    expect(spy).toHaveBeenCalledWith('/images', undefined);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('42');
    expect(list[0]?.blobUrl).toBe('/images/42/blob');
    expect(list[0]?.capturedAt).toBe('2026-05-28T10:14:00+09:00');
    // List summaries carry no per-word detail.
    expect(list[0]?.words).toEqual([]);
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ captures: [] });
    const ctrl = new AbortController();

    await fetchImages(ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/images', { signal: ctrl.signal });
  });

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    await expect(fetchImages()).rejects.toMatchObject({ status: 500 });
  });
});

describe('fetchImage', () => {
  it('GETs /images/:id (encoded) and maps the capture with words', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ capture: CAPTURE_WIRE });

    const cap = await fetchImage('42');

    expect(spy).toHaveBeenCalledWith('/images/42', undefined);
    expect(cap.blobUrl).toBe('/images/42/blob');
    expect(cap.words).toHaveLength(2);
  });

  it('URL-encodes the id as defence-in-depth', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ capture: { ...CAPTURE_WIRE, id: 'a/b' } });

    await fetchImage('a/b');

    expect(spy).toHaveBeenCalledWith('/images/a%2Fb', undefined);
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ capture: CAPTURE_WIRE });
    const ctrl = new AbortController();

    await fetchImage('42', ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/images/42', { signal: ctrl.signal });
  });

  it('rethrows ApiError on a not-found (other-user) capture', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('not found', { status: 404, code: 'not_found' }),
    );

    await expect(fetchImage('99')).rejects.toMatchObject({ status: 404 });
  });
});

describe('blobUrlFor', () => {
  it('stays a relative same-origin path when the API base is empty (prod)', () => {
    expect(blobUrlFor('42', '')).toBe('/images/42/blob');
  });

  it('joins the API base in dev so the <img> hits the API, not the Vite SPA fallback', () => {
    // Regression: dev posture is VITE_API_URL=http://localhost:4000 with the
    // SPA on :5173 and NO dev proxy — a bare relative path resolved against
    // :5173, where the SPA fallback returns HTML → every capture image broke
    // in dev. Same base-join contract as ttmik's buildAudioSrc.
    expect(blobUrlFor('42', 'http://localhost:4000')).toBe(
      'http://localhost:4000/images/42/blob',
    );
  });
});
