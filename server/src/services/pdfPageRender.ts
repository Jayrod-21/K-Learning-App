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
 * RESOURCE-EXHAUSTION GUARDS (mirrors the zip path's bomb guards in
 * services/zipPageExtract.ts — see B1 of db/docs/REVIEW_uploads_u1a_rework.md,
 * which flagged this module for having none of these before this revision):
 *   - MAX_PDF_PAGES caps how many pages a single PDF can ever render to,
 *     mirroring zipPageExtract's MAX_ZIP_ENTRIES. A crafted "PDF bomb" (a tiny
 *     file whose /Pages tree's /Kids balloon the effective page count into
 *     the tens of thousands, e.g. by repeating a handful of content objects)
 *     is REJECTED outright (400) rather than rendered — never silently
 *     truncated, so a real book over the cap gets a clear error instead of a
 *     partial, silently-incomplete import. This is enforced TWICE:
 *       1. `pdfinfo`'s reported `/Count` is checked BEFORE `pdftoppm` ever
 *          runs (cheap — no rendering), so a bomb never reaches the renderer.
 *       2. `pdftoppm -l MAX_PDF_PAGES` is passed on every invocation as an
 *          execution-time fence, in case `pdfinfo` was unavailable/inconclusive
 *          or a malformed page tree makes the rendered count diverge from the
 *          declared `/Count`. If the fence actually had to truncate (hit
 *          exactly MAX_PDF_PAGES) and we couldn't independently confirm via
 *          `pdfinfo` that the true count was within the cap, we reject rather
 *          than hand back a partial book with no way to tell the caller it
 *          was cut short.
 *   - RENDER_TIMEOUT_MS bounds how long `pdfinfo`/`pdftoppm` may run before
 *     being killed (`execFile`'s `timeout`/`killSignal` options) — a hung or
 *     adversarially slow renderer can no longer hold a request (and the
 *     `expensiveLimiter` budget behind it) open indefinitely.
 *   - BOUNDED SCRATCH DISK / MEMORY: rendered pages are read back and their
 *     temp files deleted ONE AT A TIME (not "render everything, then read
 *     everything into one big array, then bulk-delete at the end") — combined
 *     with the page cap above, this keeps scratch-disk use bounded rather
 *     than proportional to an attacker-chosen page count.
 *
 * TESTING: this module is NOT exercised with a real `pdftoppm` in the unit
 * suite (server/tests/routes/uploads.test.ts) — the test container
 * (`node:22-slim`, per the project's verify command) doesn't have
 * poppler-utils installed, so the PDF-path route test mocks this entire
 * module (`vi.mock('../../src/services/pdfPageRender.js')`) rather than
 * skipping PDF-path coverage. A real, unmocked exercise of `pdftoppm` itself
 * happens only in a self-skipping smoke test — see
 * tests/services/pdfPageRender.test.ts, which detects whether `pdftoppm` is
 * on PATH and skips (not fails) when it isn't. The page-cap/timeout/cleanup
 * guards added here are covered with `node:child_process`/`node:fs/promises`
 * mocked (no real poppler needed to exercise the guard logic itself) — see
 * tests/services/pdfPageRender.bounds.test.ts.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
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
 * Page-count cap — mirrors zipPageExtract.ts's `MAX_ZIP_ENTRIES` (same value)
 * so neither upload path can force unbounded work. Exported so tests (and the
 * `routes/uploads.ts` doc comment referencing "the zip/PDF page-count
 * guards") can point at a real, checkable constant rather than an assumed
 * number. See module header "RESOURCE-EXHAUSTION GUARDS" for how this is
 * enforced (pre-render `pdfinfo` check + `pdftoppm -l` execution fence).
 */
export const MAX_PDF_PAGES = 2000;

/**
 * Hard ceiling on how long a single `pdfinfo`/`pdftoppm` invocation may run
 * before it's killed as hung/adversarial. A legitimate few-hundred-page scan
 * at 150dpi renders in low single-digit seconds on modest hardware, so this
 * is generous headroom, not a tight fit.
 */
const RENDER_TIMEOUT_MS = 120_000;
const KILL_SIGNAL = 'SIGKILL';

/** True iff `err` is the error `execFile` throws when it kills a child on
 *  `timeout` (as opposed to a normal non-zero-exit/parse failure). */
function isTimeoutError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (('killed' in err && (err as { killed?: unknown }).killed === true) ||
      ('signal' in err && (err as { signal?: unknown }).signal === KILL_SIGNAL))
  );
}

/**
 * Best-effort read of the PDF's REAL page count via `pdfinfo` (same
 * poppler-utils package as `pdftoppm` — installed alongside it, see
 * server/Dockerfile). Returns `null` if `pdfinfo` is missing, times out, or
 * its output doesn't parse — callers must NOT treat `null` as "0 pages"; it
 * means "count unknown", and the `pdftoppm -l MAX_PDF_PAGES` execution fence
 * is the fallback guard for that case (see `renderPdfPagesToJpeg`).
 */
async function readPdfPageCount(inputPath: string): Promise<number | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('pdfinfo', [inputPath], {
      timeout: RENDER_TIMEOUT_MS,
      killSignal: KILL_SIGNAL,
    }));
  } catch {
    return null;
  }
  const match = /^Pages:\s+(\d+)\s*$/m.exec(stdout);
  if (!match || !match[1]) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Rasterize every page of a PDF (given as a buffer, per the memory-storage
 * upload path — see bookUploadIngest.ts) to JPEG, in page order.
 *
 * Throws `ValidationError` (400) if:
 *   - `pdftoppm` fails (corrupt/encrypted/not a real PDF, or the binary
 *     itself is missing),
 *   - the PDF has zero pages,
 *   - the PDF's real page count exceeds `MAX_PDF_PAGES` (rejected BEFORE
 *     rendering, whenever `pdfinfo` could determine the true count),
 *   - rendering hit the `MAX_PDF_PAGES` fence and the true count couldn't be
 *     independently verified as within the cap (i.e. we can't rule out that
 *     the result was silently truncated), or
 *   - `pdfinfo`/`pdftoppm` timed out (treated as an unreadable/hostile PDF,
 *     not a hang).
 */
export async function renderPdfPagesToJpeg(pdfBuffer: Buffer): Promise<Buffer[]> {
  const workDir = await mkdtemp(join(tmpdir(), 'km-pdf-pages-'));
  try {
    const inputPath = join(workDir, 'input.pdf');
    await writeFile(inputPath, pdfBuffer);
    const outputPrefix = join(workDir, 'page');

    // Probe the REAL page count first — cheap (no rendering) and lets us
    // reject a page-count bomb before pdftoppm ever touches it. `null` means
    // "couldn't determine" (pdfinfo missing/timed out/unparseable output),
    // handled defensively below via the -l fence + post-render check.
    const declaredPages = await readPdfPageCount(inputPath);
    if (declaredPages !== null && declaredPages > MAX_PDF_PAGES) {
      throw new ValidationError(
        `PDF has ${declaredPages} pages, over the ${MAX_PDF_PAGES}-page limit for a single upload`,
      );
    }

    try {
      // `-l MAX_PDF_PAGES`: an execution-time fence so pdftoppm itself never
      // renders more than the cap, even if the pdfinfo probe above was
      // inconclusive (declaredPages === null) or a malformed page tree makes
      // the actually-rendered count diverge from the declared /Count.
      await execFileAsync(
        'pdftoppm',
        ['-jpeg', '-r', String(RENDER_DPI), '-l', String(MAX_PDF_PAGES), inputPath, outputPrefix],
        { timeout: RENDER_TIMEOUT_MS, killSignal: KILL_SIGNAL },
      );
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new ValidationError(
          'PDF rendering timed out (file may be malformed or adversarially constructed)',
        );
      }
      // Covers: pdftoppm missing (ENOENT), a corrupt/encrypted/non-PDF input,
      // or any other renderer failure — all surface to the client the same
      // way ("this PDF couldn't be read"), never a raw stack/ENOENT.
      throw new ValidationError('PDF could not be read (corrupt, encrypted, or not a valid PDF)');
    }

    // The input PDF is no longer needed once rendering has completed —
    // dropping it early shrinks the scratch-disk footprint before the
    // (bounded, but still nonzero) page-file read loop below.
    await unlink(inputPath).catch(() => undefined);

    const files = (await readdir(workDir)).filter(
      (f) => f.startsWith('page') && (f.endsWith('.jpg') || f.endsWith('.jpeg')),
    );
    if (files.length === 0) {
      throw new ValidationError('PDF contains no pages');
    }
    files.sort(naturalCompare);

    // Defense in depth: `-l` above should make this unreachable, but never
    // trust that in isolation — explicitly refuse to hand back more than the
    // cap however we got here.
    if (files.length > MAX_PDF_PAGES) {
      throw new ValidationError(
        `PDF rendered ${files.length} pages, over the ${MAX_PDF_PAGES}-page limit for a single upload`,
      );
    }
    // If rendering hit the cap EXACTLY and we could not independently verify
    // (via pdfinfo) that the true page count was within it, we cannot tell a
    // legitimately-exactly-at-the-cap book apart from a book that was
    // silently truncated by `-l`. Per the design intent (a real book over the
    // cap must ERROR, never partially import), refuse rather than guess.
    if (files.length === MAX_PDF_PAGES && declaredPages === null) {
      throw new ValidationError(
        `PDF could not be verified as within the ${MAX_PDF_PAGES}-page limit (page count unknown); ` +
          'rendering was capped and may have been truncated',
      );
    }

    // BOUNDED MEMORY/DISK: read and delete each rendered page's temp file ONE
    // AT A TIME, rather than reading every file into memory first and
    // bulk-deleting the whole directory only at the very end — the prior
    // version's `readdir` + loop-of-`readFile`-into-a-shared-array pattern
    // left every page's temp file sitting on disk simultaneously for the
    // entire read pass. Combined with MAX_PDF_PAGES above, both scratch-disk
    // and in-flight memory are now bounded by the cap instead of by
    // whatever page count an attacker's PDF declares.
    const buffers: Buffer[] = [];
    for (const file of files) {
      const filePath = join(workDir, file);
      const buffer = await readFile(filePath);
      buffers.push(buffer);
      await unlink(filePath).catch(() => undefined);
    }
    return buffers;
  } finally {
    // Best-effort scratch cleanup — covers anything the per-file unlinks
    // above didn't get to (e.g. an early throw before the read loop started)
    // and removes the now-empty temp dir itself. This is a temp dir under the
    // OS tmp root, never the durable blob store; a failed rm here leaks
    // scratch disk, not anything user-visible or security-relevant. Runs on
    // BOTH the success path and every throw above (page-cap rejection,
    // timeout, corrupt PDF, zero pages).
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
