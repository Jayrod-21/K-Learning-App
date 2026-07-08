/**
 * uploads service (U1b) — multipart upload config, envelope unwrap, wire →
 * domain mapping (page_count null → pageCount absent, snake→camel byte
 * size/created-at), the `pdfFileUrl` base-join contract (mirrors images.ts's
 * `blobUrlFor`), the client pre-check, signal threading, and error re-throw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkPdfFile,
  deleteUpload,
  getUpload,
  listUploads,
  pdfFileUrl,
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

  it('omits pageCount when the wire page_count is null (U1 — always null pre-U2)', async () => {
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

describe('pdfFileUrl', () => {
  it('stays a relative same-origin path when the API base is empty (prod)', () => {
    expect(pdfFileUrl('9', '')).toBe('/uploads/9/file');
  });

  it('joins the API base in dev so pdf.js hits the API, not the Vite SPA fallback', () => {
    expect(pdfFileUrl('9', 'http://localhost:4000')).toBe(
      'http://localhost:4000/uploads/9/file',
    );
  });
});

describe('checkPdfFile', () => {
  it('accepts a same-declared-mime PDF under the size cap', () => {
    expect(checkPdfFile(makePdfFile('book.pdf', 1024))).toBeNull();
  });

  it('accepts a .pdf-named file even with a missing/odd declared mime (extension fallback)', () => {
    const file = new File([new Uint8Array(10)], 'book.PDF', { type: '' });
    expect(checkPdfFile(file)).toBeNull();
  });

  it('rejects a non-PDF file with fixed copy', () => {
    const file = new File([new Uint8Array(10)], 'photo.jpg', {
      type: 'image/jpeg',
    });
    expect(checkPdfFile(file)).toMatch(/isn.t a PDF/);
  });

  it('rejects an oversize PDF (>15MB) with fixed copy', () => {
    const bigFile = new File([new Uint8Array(15 * 1024 * 1024 + 1)], 'big.pdf', {
      type: 'application/pdf',
    });
    expect(checkPdfFile(bigFile)).toMatch(/too large/);
  });
});
