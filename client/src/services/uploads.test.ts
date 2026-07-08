/**
 * uploads service (U1b, page-image rework) — multipart upload config,
 * envelope unwrap, wire → domain mapping (page_count null → pageCount
 * absent, snake→camel byte size/created-at), the `pageUrl` /
 * `listPages` / `reorderPages` contract, the client pre-check (now
 * accepting zip OR pdf, ~300 MB), signal threading, and error re-throw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AxiosProgressEvent } from 'axios';
import {
  checkBookFile,
  deleteUpload,
  getUpload,
  listPages,
  listUploads,
  pageUrl,
  reorderPages,
  uploadBook,
} from './uploads';
import { api, ApiError } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

const UPLOAD_WIRE_READY = {
  id: '9',
  title: '한국어 문법 사전',
  type: 'grammar' as const,
  status: 'ready' as const,
  page_count: 240,
  byte_size: 4_200_000,
  created_at: '2026-07-01T00:00:00Z',
};

const UPLOAD_WIRE_PROCESSING = {
  id: '10',
  title: '읽기 연습',
  type: 'literature' as const,
  status: 'processing' as const,
  page_count: null,
  byte_size: 1_000_000,
  created_at: '2026-07-02T00:00:00Z',
};

function makePdfFile(name = 'book.pdf', size = 1024): File {
  return new File([new Uint8Array(size)], name, { type: 'application/pdf' });
}

function makeZipFile(name = 'book.zip', size = 1024): File {
  return new File([new Uint8Array(size)], name, { type: 'application/zip' });
}

describe('uploadBook', () => {
  it('POSTs /uploads with FormData carrying file+title+type and a boundary-clearing Content-Type', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ upload: UPLOAD_WIRE_READY });

    await uploadBook(makePdfFile(), 'grammar', '한국어 문법 사전');

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, body, config] = spy.mock.calls[0];
    expect(url).toBe('/uploads');
    expect(body).toBeInstanceOf(FormData);
    expect(config?.headers).toEqual({ 'Content-Type': undefined });

    const form = body as FormData;
    const file = form.get('file');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('book.pdf');
    expect(form.get('title')).toBe('한국어 문법 사전');
    expect(form.get('type')).toBe('grammar');
  });

  it('POSTs a zip file the same way as a PDF (server normalizes either)', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ upload: UPLOAD_WIRE_READY });

    await uploadBook(makeZipFile('vflat-export.zip'), 'vocab', 'x');

    const form = spy.mock.calls[0][1] as FormData;
    expect((form.get('file') as File).name).toBe('vflat-export.zip');
  });

  it('maps the wire upload onto the domain shape (page_count present)', async () => {
    vi.spyOn(api, 'post').mockResolvedValueOnce({ upload: UPLOAD_WIRE_READY });

    const upload = await uploadBook(makePdfFile(), 'grammar', 'x');

    expect(upload).toEqual({
      id: '9',
      title: '한국어 문법 사전',
      type: 'grammar',
      status: 'ready',
      pageCount: 240,
      byteSize: 4_200_000,
      createdAt: '2026-07-01T00:00:00Z',
    });
  });

  it('omits pageCount when the wire page_count is null (still processing / failed)', async () => {
    vi.spyOn(api, 'post').mockResolvedValueOnce({
      upload: UPLOAD_WIRE_PROCESSING,
    });

    const upload = await uploadBook(makePdfFile(), 'literature', 'x');

    expect(upload.pageCount).toBeUndefined();
    expect(upload).not.toHaveProperty('page_count');
  });

  it('threads an AbortSignal into the request config alongside the cleared header', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ upload: UPLOAD_WIRE_READY });
    const ctrl = new AbortController();

    await uploadBook(makePdfFile(), 'grammar', 'x', ctrl.signal);

    const config = spy.mock.calls[0][2];
    expect(config?.signal).toBe(ctrl.signal);
    expect(config?.headers).toEqual({ 'Content-Type': undefined });
  });

  it('rethrows ApiError on failure (e.g. daily cap / oversize)', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('too large', { status: 413, code: 'payload_too_large' }),
    );

    await expect(
      uploadBook(makePdfFile(), 'grammar', 'x'),
    ).rejects.toMatchObject({ status: 413 });
  });

  // C-S5 regression: a real (up to ~300 MB) book upload can run minutes on a
  // slow connection. Two things were missing before the fix: (1) the
  // app-wide 10s axios default would misfire as a timeout well before a real
  // transfer completes, and (2) there was no way for a caller to surface
  // progress. Both are per-call config on this one POST — assert both are
  // actually wired, not just documented.
  it('overrides the app-wide 10s timeout with a generous per-call one (a 300 MB transfer would otherwise misfire as a timeout)', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({ upload: UPLOAD_WIRE_READY });

    await uploadBook(makePdfFile(), 'grammar', 'x');

    const [, , config] = spy.mock.calls[0];
    expect(config?.timeout).toBeGreaterThan(10_000);
  });

  it('threads onProgress into axios onUploadProgress, computing an integer percent from real loaded/total bytes', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({ upload: UPLOAD_WIRE_READY });
    const onProgress = vi.fn<(percent: number) => void>();

    await uploadBook(makePdfFile(), 'grammar', 'x', undefined, onProgress);

    const [, , config] = spy.mock.calls[0];
    expect(config?.onUploadProgress).toBeInstanceOf(Function);

    const progress = config?.onUploadProgress as (e: AxiosProgressEvent) => void;
    progress({ loaded: 50, total: 200 } as AxiosProgressEvent);
    expect(onProgress).toHaveBeenCalledWith(25);

    progress({ loaded: 200, total: 200 } as AxiosProgressEvent);
    expect(onProgress).toHaveBeenCalledWith(100);
  });

  it('does not call onProgress when axios cannot report a total (defends divide-by-undefined)', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({ upload: UPLOAD_WIRE_READY });
    const onProgress = vi.fn<(percent: number) => void>();

    await uploadBook(makePdfFile(), 'grammar', 'x', undefined, onProgress);

    const [, , config] = spy.mock.calls[0];
    const progress = config?.onUploadProgress as (e: AxiosProgressEvent) => void;
    progress({ loaded: 50, total: undefined } as unknown as AxiosProgressEvent);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('omitting onProgress leaves onUploadProgress unset (no unconditional callback)', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({ upload: UPLOAD_WIRE_READY });

    await uploadBook(makePdfFile(), 'grammar', 'x');

    const [, , config] = spy.mock.calls[0];
    expect(config?.onUploadProgress).toBeUndefined();
  });
});

describe('listUploads', () => {
  it('GETs /uploads and maps every row', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ uploads: [UPLOAD_WIRE_READY, UPLOAD_WIRE_PROCESSING] });

    const rows = await listUploads();

    expect(spy).toHaveBeenCalledWith('/uploads', undefined);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe('ready');
    expect(rows[1]?.status).toBe('processing');
    expect(rows[1]?.pageCount).toBeUndefined();
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ uploads: [] });
    const ctrl = new AbortController();

    await listUploads(ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/uploads', { signal: ctrl.signal });
  });

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    await expect(listUploads()).rejects.toMatchObject({ status: 500 });
  });
});

describe('getUpload', () => {
  it('GETs /uploads/:id (encoded)', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ upload: { ...UPLOAD_WIRE_READY, id: 'a/b' } });

    await getUpload('a/b');

    expect(spy).toHaveBeenCalledWith('/uploads/a%2Fb', undefined);
  });

  it('rethrows ApiError on a not-found (other-user) upload', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('not found', { status: 404, code: 'not_found' }),
    );

    await expect(getUpload('99')).rejects.toMatchObject({ status: 404 });
  });
});

describe('deleteUpload', () => {
  it('DELETEs /uploads/:id (encoded) and threads a signal', async () => {
    const spy = vi.spyOn(api, 'delete').mockResolvedValueOnce(undefined);
    const ctrl = new AbortController();

    await deleteUpload('a/b', ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/uploads/a%2Fb', { signal: ctrl.signal });
  });

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'delete').mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    await expect(deleteUpload('9')).rejects.toMatchObject({ status: 500 });
  });
});

describe('pageUrl', () => {
  it('stays a relative same-origin path when the API base is empty (prod)', () => {
    expect(pageUrl('9', 3, '')).toBe('/uploads/9/page/3');
  });

  it('joins the API base in dev so the <img> hits the API, not the Vite SPA fallback', () => {
    expect(pageUrl('9', 3, 'http://localhost:4000')).toBe(
      'http://localhost:4000/uploads/9/page/3',
    );
  });

  it('encodes the upload id', () => {
    expect(pageUrl('a/b', 1, '')).toBe('/uploads/a%2Fb/page/1');
  });

  // B-S1 regression: the page route is deliberately cache-friendly, so a
  // plain retry that reissues the byte-identical URL could replay a
  // browser-cached bad-but-200 response forever. `cacheBust` must be opt-in
  // (never on by default — the normal nav path must stay fully cacheable)
  // and must change the URL every time it's bumped.
  describe('cacheBust', () => {
    it('omitting cacheBust (normal navigation) never appends a query param', () => {
      expect(pageUrl('9', 3, '')).toBe('/uploads/9/page/3');
    });

    it('cacheBust=0 (the default) never appends a query param', () => {
      expect(pageUrl('9', 3, '', 0)).toBe('/uploads/9/page/3');
    });

    it('a positive cacheBust appends it as a query param', () => {
      expect(pageUrl('9', 3, '', 1)).toBe('/uploads/9/page/3?r=1');
    });

    it('a different cacheBust value produces a different URL (forces a fresh fetch on repeated retries)', () => {
      expect(pageUrl('9', 3, '', 1)).not.toBe(pageUrl('9', 3, '', 2));
      expect(pageUrl('9', 3, '', 2)).toBe('/uploads/9/page/3?r=2');
    });

    it('appends after a joined dev API base too', () => {
      expect(pageUrl('9', 3, 'http://localhost:4000', 1)).toBe(
        'http://localhost:4000/uploads/9/page/3?r=1',
      );
    });
  });
});

describe('listPages', () => {
  it('GETs /uploads/:id/pages and maps every row (id, pageNumber)', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({
      pages: [
        { id: '101', page_number: 1 },
        { id: '102', page_number: 2 },
      ],
    });

    const pages = await listPages('9');

    expect(spy).toHaveBeenCalledWith('/uploads/9/pages', undefined);
    expect(pages).toEqual([
      { id: '101', pageNumber: 1 },
      { id: '102', pageNumber: 2 },
    ]);
  });

  it('threads an AbortSignal', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ pages: [] });
    const ctrl = new AbortController();

    await listPages('9', ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/uploads/9/pages', { signal: ctrl.signal });
  });

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    await expect(listPages('9')).rejects.toMatchObject({ status: 500 });
  });
});

describe('reorderPages', () => {
  it('PATCHes /uploads/:id/pages/order with the numeric page_ids array in order', async () => {
    const spy = vi.spyOn(api, 'patch').mockResolvedValueOnce({
      pages: [
        { id: '102', page_number: 1 },
        { id: '101', page_number: 2 },
      ],
    });

    const pages = await reorderPages('9', ['102', '101']);

    expect(spy).toHaveBeenCalledWith(
      '/uploads/9/pages/order',
      { page_ids: [102, 101] },
      undefined,
    );
    expect(pages).toEqual([
      { id: '102', pageNumber: 1 },
      { id: '101', pageNumber: 2 },
    ]);
  });

  it('threads an AbortSignal', async () => {
    const spy = vi.spyOn(api, 'patch').mockResolvedValueOnce({ pages: [] });
    const ctrl = new AbortController();

    await reorderPages('9', ['1'], ctrl.signal);

    expect(spy).toHaveBeenCalledWith(
      '/uploads/9/pages/order',
      { page_ids: [1] },
      { signal: ctrl.signal },
    );
  });

  it('rethrows ApiError on failure (e.g. stale/foreign page set)', async () => {
    vi.spyOn(api, 'patch').mockRejectedValueOnce(
      new ApiError('mismatched set', { status: 400, code: 'validation_error' }),
    );

    await expect(reorderPages('9', ['1', '2'])).rejects.toMatchObject({ status: 400 });
  });
});

describe('checkBookFile', () => {
  it('accepts a same-declared-mime PDF under the size cap', () => {
    expect(checkBookFile(makePdfFile('book.pdf', 1024))).toBeNull();
  });

  it('accepts a same-declared-mime zip under the size cap', () => {
    expect(checkBookFile(makeZipFile('book.zip', 1024))).toBeNull();
  });

  it('accepts a .pdf-named file even with a missing/odd declared mime (extension fallback)', () => {
    const file = new File([new Uint8Array(10)], 'book.PDF', { type: '' });
    expect(checkBookFile(file)).toBeNull();
  });

  it('accepts a .zip-named file even with a missing/odd declared mime (extension fallback)', () => {
    const file = new File([new Uint8Array(10)], 'book.ZIP', { type: '' });
    expect(checkBookFile(file)).toBeNull();
  });

  it('rejects a file that is neither a PDF nor a zip, with fixed copy', () => {
    const file = new File([new Uint8Array(10)], 'photo.jpg', {
      type: 'image/jpeg',
    });
    expect(checkBookFile(file)).toMatch(/isn.t a PDF or a zip/);
  });

  it('rejects an oversize file (>300MB) with fixed copy', () => {
    const bigFile = new File([new Uint8Array(300 * 1024 * 1024 + 1)], 'big.pdf', {
      type: 'application/pdf',
    });
    expect(checkBookFile(bigFile)).toMatch(/too large/);
  });
});
