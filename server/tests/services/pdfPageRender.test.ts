/**
 * pdfPageRender — REAL `pdftoppm` smoke test (U1a rework, PDF upload path).
 *
 * `server/tests/routes/uploads.test.ts` covers the route's PDF path against a
 * MOCK of this module (`renderPdfPagesToJpeg`) — the project's verify
 * container (`node:22-slim`, per the repo's documented verify command) does
 * not have `poppler-utils` installed, so a route-level integration test can't
 * assume a real `pdftoppm` binary is on PATH. This file is the complement:
 * it exercises the REAL binary directly, but SELF-SKIPS (not fails) when
 * `pdftoppm` isn't found — so the suite stays green in the documented verify
 * environment while still giving real coverage on any machine/CI stage that
 * DOES have poppler-utils (e.g. the production image, which installs it —
 * see server/Dockerfile).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { renderPdfPagesToJpeg } from '../../src/services/pdfPageRender.js';

const execFileAsync = promisify(execFile);

/** A minimal but VALID (parseable) 1-page PDF — same fixture shape as
 *  uploads.test.ts's TINY_PDF. */
const TINY_PDF = Buffer.from(
  '%PDF-1.4\n' +
    '1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n' +
    '2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n' +
    '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>endobj\n' +
    'trailer<< /Size 4 /Root 1 0 R >>\n' +
    '%%EOF',
  'utf8',
);

const NOT_A_PDF = Buffer.from('this is definitely not a pdf', 'utf8');

async function hasPdftoppm(): Promise<boolean> {
  try {
    await execFileAsync('pdftoppm', ['-v']);
    return true;
  } catch {
    return false;
  }
}

describe('renderPdfPagesToJpeg (real pdftoppm)', () => {
  it('renders a 1-page PDF to exactly one real JPEG buffer, or self-skips if poppler-utils is absent', async () => {
    if (!(await hasPdftoppm())) {
      // Documented, not silent: the verify container doesn't ship poppler —
      // see this file's header and services/pdfPageRender.ts's module doc.
      // eslint-disable-next-line no-console
      console.warn('pdftoppm not found on PATH — skipping real-poppler smoke test');
      return;
    }
    const pages = await renderPdfPagesToJpeg(TINY_PDF);
    expect(pages.length).toBe(1);
    // A real JPEG starts with the FF D8 FF magic bytes.
    expect(pages[0]![0]).toBe(0xff);
    expect(pages[0]![1]).toBe(0xd8);
    expect(pages[0]![2]).toBe(0xff);
  });

  it('rejects a corrupt/non-PDF buffer with a ValidationError, or self-skips if poppler-utils is absent', async () => {
    if (!(await hasPdftoppm())) {
      // eslint-disable-next-line no-console
      console.warn('pdftoppm not found on PATH — skipping real-poppler smoke test');
      return;
    }
    await expect(renderPdfPagesToJpeg(NOT_A_PDF)).rejects.toThrow(/could not be read/);
  });
});
