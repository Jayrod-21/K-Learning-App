/**
 * PDF → page-image rendering (U1a rework — the PDF upload path). See
 * db/docs/PDF_UPLOAD_DESIGN.md §"REVISION (2026-07-08)".
 *
 * Jared can also upload a plain PDF (not just the vFlat zip-of-images
 * export). This shells out to `pdftoppm` (poppler-utils — already a known
 * dependency of this codebase's ingest tooling, see
 * Deploy/loader.Dockerfile's header comment) to rasterize every page to a
 * JPEG, then reads them back in page order.
 *
 * WHY a subprocess and not a pure-JS PDF library: poppler is the same
 * battle-tested renderer the design doc's own precedent (tools/ingest) leans
 * on, and rasterizing an arbitrary (possibly hostile) PDF is exactly the kind
 * of parsing you want a hardened, sandboxed-by-the-OS external process doing,
 * not an in-process pure-JS parser sharing the Node event loop and memory
 * space with the rest of the API.
 *
 * DEPLOYMENT: `poppler-utils` must be present in the SERVER RUNTIME image
 * (server/Dockerfile) — added alongside this feature. A missing binary
 * surfaces as `ENOENT` from `execFile`, mapped below to the same 400 as a
 * corrupt PDF (a Jared-facing message, not an operator-facing stack trace).
 *
 * TESTING: this module is NOT exercised with a real `pdftoppm` in the unit
 * suite (server/tests/routes/uploads.test.ts) — the test container
 * (`node:20-slim`, per the project's verify command) doesn't have
 * poppler-utils installed, so the PDF-path route test mocks this entire
 * module (`vi.mock('../../src/services/pdfPageRender.js')`) rather than
 * skipping PDF-path coverage. A real, unmocked exercise of `pdftoppm` itself
 * happens only in a self-skipping smoke test — see
 * tests/services/pdfPageRender.test.ts, which detects whether `pdftoppm` is
 * on PATH and skips (not fails) when it isn't.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ValidationError } from '../middleware/errors.js';
import { naturalCompare } from './naturalSort.js';

const execFileAsync = promisify(execFile);

/** Render resolution — legible for on-screen reading of a scanned book page
 *  without ballooning per-page file size (a 150dpi JPEG of a typical
 *  book-page-sized PDF page runs a few hundred KB, not several MB). */
const RENDER_DPI = 150;

/**
 * Rasterize every page of a PDF (given as a buffer, per the memory-storage
 * upload path — see bookUploadIngest.ts) to JPEG, in page order.
 *
 * Throws `ValidationError` (400) if `pdftoppm` fails (corrupt/encrypted/not a
 * real PDF, or the binary itself is missing) or the PDF has zero pages.
 */
export async function renderPdfPagesToJpeg(pdfBuffer: Buffer): Promise<Buffer[]> {
  const workDir = await mkdtemp(join(tmpdir(), 'km-pdf-pages-'));
  try {
    const inputPath = join(workDir, 'input.pdf');
    await writeFile(inputPath, pdfBuffer);
    const outputPrefix = join(workDir, 'page');

    try {
      await execFileAsync('pdftoppm', ['-jpeg', '-r', String(RENDER_DPI), inputPath, outputPrefix]);
    } catch {
      // Covers: pdftoppm missing (ENOENT), a corrupt/encrypted/non-PDF input,
      // or any other renderer failure — all surface to the client the same
      // way ("this PDF couldn't be read"), never a raw stack/ENOENT.
      throw new ValidationError('PDF could not be read (corrupt, encrypted, or not a valid PDF)');
    }

    const files = (await readdir(workDir)).filter(
      (f) => f.startsWith('page') && (f.endsWith('.jpg') || f.endsWith('.jpeg')),
    );
    if (files.length === 0) {
      throw new ValidationError('PDF contains no pages');
    }
    files.sort(naturalCompare);

    const buffers: Buffer[] = [];
    for (const file of files) {
      buffers.push(await readFile(join(workDir, file)));
    }
    return buffers;
  } finally {
    // Best-effort scratch cleanup — this is a temp dir under the OS tmp root,
    // never the durable blob store; a failed rm here leaks scratch disk, not
    // anything user-visible or security-relevant.
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
