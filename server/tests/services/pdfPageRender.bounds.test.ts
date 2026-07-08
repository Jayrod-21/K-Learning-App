/**
 * pdfPageRender — resource-exhaustion GUARD unit tests (U1a rework, PDF
 * upload path). See db/docs/REVIEW_uploads_u1a_rework.md "B1" for the gap
 * these guards close: the PDF path previously had no page-count cap, no
 * subprocess timeout, and buffered every rendered page into memory at once.
 *
 * These tests exercise the REAL `renderPdfPagesToJpeg` implementation (not a
 * stub — contrast with tests/routes/uploads.test.ts, which mocks this whole
 * module away for its route-level PDF coverage) but with `node:child_process`
 * and `node:fs/promises` fully mocked, since the verify container
 * (`node:20-slim`) doesn't ship poppler-utils (see
 * tests/services/pdfPageRender.test.ts's self-skipping real-poppler smoke
 * test for the complementary real-binary coverage). Mocking the two node
 * builtins — rather than the module under test — is what lets us prove the
 * cap/timeout/cleanup LOGIC actually works without a real pdfinfo/pdftoppm on
 * PATH.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock, fsMocks, calls } = vi.hoisted(() => {
  return {
    execFileMock: vi.fn(),
    fsMocks: {
      mkdtemp: vi.fn(),
      writeFile: vi.fn(),
      readdir: vi.fn(),
      readFile: vi.fn(),
      unlink: vi.fn(),
      rm: vi.fn(),
    },
    // Ordered log of read/unlink calls (by path) — used to prove pages are
    // processed ONE AT A TIME (read, then immediately unlink, then move to
    // the next file) rather than "read every file into an array, then
    // bulk-delete everything at the end".
    calls: [] as string[],
  };
});

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('node:fs/promises', () => ({
  mkdtemp: fsMocks.mkdtemp,
  writeFile: fsMocks.writeFile,
  readdir: fsMocks.readdir,
  readFile: fsMocks.readFile,
  unlink: fsMocks.unlink,
  rm: fsMocks.rm,
}));

import { MAX_PDF_PAGES, renderPdfPagesToJpeg } from '../../src/services/pdfPageRender.js';

type ExecCallback = (err: unknown, result?: { stdout: string; stderr: string }) => void;

const WORK_DIR = '/tmp/km-pdf-pages-fake';

function pdfinfoStdout(pages: number): string {
  return `Title:          Fake\nPages:          ${pages}\nPage size:      612 x 792 pts\n`;
}

/** Configure the `execFile` mock's behavior per invoked command. */
function setExecBehavior(opts: {
  pdfinfo: 'ok' | 'missing' | 'timeout';
  pdfinfoPages?: number;
  pdftoppm: 'ok' | 'timeout' | 'corrupt';
}): void {
  execFileMock.mockImplementation(
    (cmd: string, _args: string[], _options: unknown, callback: ExecCallback) => {
      if (cmd === 'pdfinfo') {
        if (opts.pdfinfo === 'ok') {
          callback(null, { stdout: pdfinfoStdout(opts.pdfinfoPages ?? 1), stderr: '' });
        } else if (opts.pdfinfo === 'timeout') {
          callback(Object.assign(new Error('pdfinfo timed out'), { killed: true, signal: 'SIGKILL' }));
        } else {
          callback(new Error('pdfinfo: command not found'));
        }
        return;
      }
      if (cmd === 'pdftoppm') {
        if (opts.pdftoppm === 'ok') {
          callback(null, { stdout: '', stderr: '' });
        } else if (opts.pdftoppm === 'timeout') {
          callback(Object.assign(new Error('pdftoppm timed out'), { killed: true, signal: 'SIGKILL' }));
        } else {
          callback(new Error('pdftoppm: corrupt PDF'));
        }
        return;
      }
      callback(new Error(`unexpected command in test: ${cmd}`));
    },
  );
}

function pageFiles(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `page-${i + 1}.jpg`);
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  fsMocks.mkdtemp.mockResolvedValue(WORK_DIR);
  fsMocks.writeFile.mockResolvedValue(undefined);
  fsMocks.rm.mockResolvedValue(undefined);
  fsMocks.unlink.mockImplementation((path: string) => {
    calls.push(`unlink:${path}`);
    return Promise.resolve(undefined);
  });
  fsMocks.readFile.mockImplementation((path: string) => {
    calls.push(`read:${path}`);
    return Promise.resolve(Buffer.from(`content-of-${path}`));
  });
  fsMocks.readdir.mockResolvedValue([]);
});

const FAKE_PDF = Buffer.from('%PDF-1.4 fake bytes, never actually parsed (execFile is mocked)');

describe('renderPdfPagesToJpeg — page-count cap (MAX_PDF_PAGES)', () => {
  it(`is set to a real, exported bound (${2000})`, () => {
    expect(MAX_PDF_PAGES).toBe(2000);
  });

  it('rejects (400-mapped ValidationError) a PDF whose real page count exceeds the cap, BEFORE ever invoking pdftoppm', async () => {
    setExecBehavior({ pdfinfo: 'ok', pdfinfoPages: MAX_PDF_PAGES + 500, pdftoppm: 'ok' });

    await expect(renderPdfPagesToJpeg(FAKE_PDF)).rejects.toThrow(
      new RegExp(`${MAX_PDF_PAGES + 500} pages.*over.*${MAX_PDF_PAGES}`),
    );

    // pdftoppm must never have been reached — the bomb was rejected on the
    // cheap pdfinfo probe alone, before any rendering work happened.
    const commandsInvoked = execFileMock.mock.calls.map((c) => c[0]);
    expect(commandsInvoked).toEqual(['pdfinfo']);

    // Scratch dir is still cleaned up even on this early rejection.
    expect(fsMocks.rm).toHaveBeenCalledWith(WORK_DIR, expect.objectContaining({ recursive: true, force: true }));
  });

  it('passes `-l MAX_PDF_PAGES` to pdftoppm as an execution-time fence on every render', async () => {
    setExecBehavior({ pdfinfo: 'ok', pdfinfoPages: 3, pdftoppm: 'ok' });
    fsMocks.readdir.mockResolvedValue(pageFiles(3));

    await renderPdfPagesToJpeg(FAKE_PDF);

    const pdftoppmCall = execFileMock.mock.calls.find((c) => c[0] === 'pdftoppm');
    expect(pdftoppmCall).toBeDefined();
    const argv = pdftoppmCall![1] as string[];
    const lIndex = argv.indexOf('-l');
    expect(lIndex).toBeGreaterThanOrEqual(0);
    expect(argv[lIndex + 1]).toBe(String(MAX_PDF_PAGES));
  });

  it('rejects when rendering hits the cap exactly and pdfinfo could not verify the true count was within it (possible silent truncation)', async () => {
    setExecBehavior({ pdfinfo: 'missing', pdftoppm: 'ok' });
    fsMocks.readdir.mockResolvedValue(pageFiles(MAX_PDF_PAGES));

    await expect(renderPdfPagesToJpeg(FAKE_PDF)).rejects.toThrow(/could not be verified|truncated/);

    // Must not have started reading page files — this is a reject-before-use
    // guard, not a "read them anyway" fallback.
    expect(fsMocks.readFile).not.toHaveBeenCalled();
  });

  it('does NOT reject when rendering lands under the cap even if pdfinfo could not verify the count', async () => {
    setExecBehavior({ pdfinfo: 'missing', pdftoppm: 'ok' });
    fsMocks.readdir.mockResolvedValue(pageFiles(5));

    const pages = await renderPdfPagesToJpeg(FAKE_PDF);
    expect(pages.length).toBe(5);
  });
});

describe('renderPdfPagesToJpeg — subprocess timeout', () => {
  it('rejects with a clear error (not a hang) when pdftoppm times out, and still cleans up the scratch dir', async () => {
    setExecBehavior({ pdfinfo: 'ok', pdfinfoPages: 1, pdftoppm: 'timeout' });

    await expect(renderPdfPagesToJpeg(FAKE_PDF)).rejects.toThrow(/timed out/);
    expect(fsMocks.rm).toHaveBeenCalledWith(WORK_DIR, expect.objectContaining({ recursive: true, force: true }));
  });

  it('rejects with a clear error when pdfinfo itself times out (falls through to the pdftoppm -l fence, which then fails/times out too)', async () => {
    setExecBehavior({ pdfinfo: 'timeout', pdftoppm: 'timeout' });

    await expect(renderPdfPagesToJpeg(FAKE_PDF)).rejects.toThrow(/timed out/);
  });

  it('passes a bounded `timeout` option to every execFile invocation (no unbounded/hanging subprocess)', async () => {
    setExecBehavior({ pdfinfo: 'ok', pdfinfoPages: 1, pdftoppm: 'ok' });
    fsMocks.readdir.mockResolvedValue(pageFiles(1));

    await renderPdfPagesToJpeg(FAKE_PDF);

    for (const call of execFileMock.mock.calls) {
      const options = call[2] as { timeout?: number; killSignal?: string };
      expect(typeof options.timeout).toBe('number');
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.killSignal).toBeTruthy();
    }
  });
});

describe('renderPdfPagesToJpeg — bounded memory/disk (iterate, not buffer-all)', () => {
  it('reads and deletes each rendered page ONE AT A TIME, in order — never reading every file before deleting any', async () => {
    setExecBehavior({ pdfinfo: 'ok', pdfinfoPages: 3, pdftoppm: 'ok' });
    fsMocks.readdir.mockResolvedValue(pageFiles(3));

    const pages = await renderPdfPagesToJpeg(FAKE_PDF);
    expect(pages.length).toBe(3);

    // Only the per-page read/unlink pairs, in the order they actually
    // happened (filters out the separate input.pdf unlink).
    const pageCalls = calls.filter((c) => c.includes('page-'));
    expect(pageCalls).toEqual([
      `read:${WORK_DIR}/page-1.jpg`,
      `unlink:${WORK_DIR}/page-1.jpg`,
      `read:${WORK_DIR}/page-2.jpg`,
      `unlink:${WORK_DIR}/page-2.jpg`,
      `read:${WORK_DIR}/page-3.jpg`,
      `unlink:${WORK_DIR}/page-3.jpg`,
    ]);
  });

  it('unlinks the input PDF once rendering has finished, before reading any page back', async () => {
    setExecBehavior({ pdfinfo: 'ok', pdfinfoPages: 2, pdftoppm: 'ok' });
    fsMocks.readdir.mockResolvedValue(pageFiles(2));

    await renderPdfPagesToJpeg(FAKE_PDF);

    const inputUnlinkIndex = calls.indexOf(`unlink:${WORK_DIR}/input.pdf`);
    const firstPageReadIndex = calls.indexOf(`read:${WORK_DIR}/page-1.jpg`);
    expect(inputUnlinkIndex).toBeGreaterThanOrEqual(0);
    expect(inputUnlinkIndex).toBeLessThan(firstPageReadIndex);
  });

  it('always cleans up the scratch temp dir in a `finally` — success path', async () => {
    setExecBehavior({ pdfinfo: 'ok', pdfinfoPages: 1, pdftoppm: 'ok' });
    fsMocks.readdir.mockResolvedValue(pageFiles(1));

    await renderPdfPagesToJpeg(FAKE_PDF);

    expect(fsMocks.rm).toHaveBeenCalledTimes(1);
    expect(fsMocks.rm).toHaveBeenCalledWith(WORK_DIR, expect.objectContaining({ recursive: true, force: true }));
  });

  it('always cleans up the scratch temp dir even when pdftoppm fails outright (corrupt PDF)', async () => {
    setExecBehavior({ pdfinfo: 'ok', pdfinfoPages: 1, pdftoppm: 'corrupt' });

    await expect(renderPdfPagesToJpeg(FAKE_PDF)).rejects.toThrow(/could not be read/);
    expect(fsMocks.rm).toHaveBeenCalledTimes(1);
  });
});

describe('renderPdfPagesToJpeg — zero-page rejection (pre-existing behavior, still correct)', () => {
  it('rejects a PDF that renders zero pages', async () => {
    setExecBehavior({ pdfinfo: 'ok', pdfinfoPages: 0, pdftoppm: 'ok' });
    fsMocks.readdir.mockResolvedValue([]);

    await expect(renderPdfPagesToJpeg(FAKE_PDF)).rejects.toThrow(/no pages/);
  });
});
