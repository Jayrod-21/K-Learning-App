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

/** Result of rendering a PDF's pages to disk: the scratch dir (caller owns
 *  cleanup — see `renderToWorkDir`'s doc) + the page filenames, ALREADY
 *  naturally sorted and validated against every count/cap guard. No page
 *  BYTES are read yet — this step only shells out to pdftoppm and lists the
 *  resulting temp files, so it costs scratch disk, never heap proportional to
 *  page count. */
interface RenderedPdfPages {
  readonly workDir: string;
  readonly files: readonly string[];
}

/**
 * Shared core for EVERY entry point below: probe the real page count, invoke
 * `pdftoppm` against `inputPath` (with the `-l MAX_PDF_PAGES` execution
 * fence) writing output pages into `workDir`, and validate the resulting file
 * list against every guard. Throws `ValidationError` (400) if:
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
 *
 * Deliberately does NOT touch `inputPath` beyond reading it (no write, no
 * unlink) — `inputPath` may be a scratch copy this module owns
 * (`renderToWorkDir`, below) OR the CALLER's own raw file on a different
 * volume entirely (`renderToWorkDirFromFile`, the ingest runner's raw
 * upload) — only the caller that CREATED `inputPath` may delete it.
 */
async function probeRenderAndList(
  inputPath: string,
  workDir: string,
): Promise<readonly string[]> {
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

  const files = (await readdir(workDir)).filter(
    (f) => f.startsWith('page') && (f.endsWith('.jpg') || f.endsWith('.jpeg')),
  );
  if (files.length === 0) {
    throw new ValidationError('PDF contains no pages');
  }
  const sorted = [...files].sort(naturalCompare);

  // Defense in depth: `-l` above should make this unreachable, but never
  // trust that in isolation — explicitly refuse to hand back more than the
  // cap however we got here.
  if (sorted.length > MAX_PDF_PAGES) {
    throw new ValidationError(
      `PDF rendered ${sorted.length} pages, over the ${MAX_PDF_PAGES}-page limit for a single upload`,
    );
  }
  // If rendering hit the cap EXACTLY and we could not independently verify
  // (via pdfinfo) that the true page count was within it, we cannot tell a
  // legitimately-exactly-at-the-cap book apart from a book that was
  // silently truncated by `-l`. Per the design intent (a real book over the
  // cap must ERROR, never partially import), refuse rather than guess.
  if (sorted.length === MAX_PDF_PAGES && declaredPages === null) {
    throw new ValidationError(
      `PDF could not be verified as within the ${MAX_PDF_PAGES}-page limit (page count unknown); ` +
        'rendering was capped and may have been truncated',
    );
  }

  return sorted;
}

/**
 * Scratch-copy variant: write the buffer to a FRESH temp dir as `input.pdf`,
 * render it there, and return that same dir as `workDir` (this function OWNS
 * both the input copy and the outputs, so it unlinks the input copy itself
 * once rendering is done — shrinking scratch-disk footprint before the
 * page-file read loop the caller runs next). Used by the two buffer-based
 * entry points below (`renderPdfPagesToJpeg`, `streamPdfPagesToJpeg`).
 *
 * On SUCCESS, the caller now OWNS `workDir` and MUST remove it once done
 * reading pages. On FAILURE this function cleans the scratch dir itself
 * before rejecting — there is no caller to hand cleanup ownership to.
 */
async function renderToWorkDir(pdfBuffer: Buffer): Promise<RenderedPdfPages> {
  const workDir = await mkdtemp(join(tmpdir(), 'km-pdf-pages-'));
  try {
    const inputPath = join(workDir, 'input.pdf');
    await writeFile(inputPath, pdfBuffer);
    const files = await probeRenderAndList(inputPath, workDir);
    // The input PDF is no longer needed once rendering has completed —
    // dropping it early shrinks the scratch-disk footprint before the
    // (bounded, but still nonzero) page-file read loop below. Safe to do
    // here (unlike renderToWorkDirFromFile) because THIS function wrote
    // `inputPath` itself — it is a scratch copy, not the caller's file.
    await unlink(inputPath).catch(() => undefined);
    return { workDir, files };
  } catch (err) {
    // No caller exists yet to own cleanup on a failed setup — do it here
    // (mirrors the success-path callers' own `finally`, just inlined since
    // there's no work dir handoff to make).
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * File-path variant (Phase 2.5 — the OOM fix, the runner's entry point):
 * render DIRECTLY from `inputPath` — the caller's own raw upload file,
 * already on the km_book_uploads volume — into a FRESH, otherwise-empty
 * output-only work dir. NEVER writes or deletes `inputPath` itself (unlike
 * `renderToWorkDir` above, which owns a scratch COPY it made): the raw file
 * belongs to `bookIngestRunner.ts`, which deletes it itself only once the
 * ENTIRE book has decoded successfully — this function's only responsibility
 * is the rendered-page outputs it created. Avoids ever materializing the raw
 * PDF (up to 300 MiB) as an in-memory Buffer at all, unlike the buffer-based
 * entry points — `pdftoppm` reads straight off disk.
 */
async function renderToWorkDirFromFile(inputPath: string): Promise<RenderedPdfPages> {
  const workDir = await mkdtemp(join(tmpdir(), 'km-pdf-pages-'));
  try {
    const files = await probeRenderAndList(inputPath, workDir);
    return { workDir, files };
  } catch (err) {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Read each rendered page's file, deleting it immediately after reading
 * (freeing scratch disk before the NEXT page is even read) and yielding it —
 * so at most one page's buffer is alive at once (plus the small, filename-
 * only `files` list, already bounded by `MAX_PDF_PAGES`). Shared by every
 * streaming entry point; `renderPdfPagesToJpeg`'s array variant drains this
 * instead of duplicating the read/delete loop.
 *
 * Cleanup is a `finally` so `workDir` is removed whether the generator runs
 * to completion, the caller stops early (`break`/`return` out of a
 * `for await`), or a read fails mid-stream.
 */
async function* readPagesAndCleanup(
  workDir: string,
  files: readonly string[],
): AsyncGenerator<Buffer, void, void> {
  try {
    for (const file of files) {
      const filePath = join(workDir, file);
      const buffer = await readFile(filePath);
      await unlink(filePath).catch(() => undefined);
      yield buffer;
      // `buffer` is eligible for GC once the caller's `await`/iteration on
      // this yielded value moves on — nothing in this function retains it
      // past this point.
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Rasterize every page of a PDF (given as a buffer) to JPEG, in page order,
 * as an ARRAY — every page resident in memory at once. Kept for callers that
 * genuinely want the whole set (tests; anything NOT the ingest runner). The
 * ingest runner MUST use `streamPdfPagesToJpegFromFile` instead — see its doc
 * for why.
 */
export async function renderPdfPagesToJpeg(pdfBuffer: Buffer): Promise<Buffer[]> {
  const { workDir, files } = await renderToWorkDir(pdfBuffer);
  const buffers: Buffer[] = [];
  for await (const buffer of readPagesAndCleanup(workDir, files)) {
    buffers.push(buffer);
  }
  return buffers;
}

/**
 * BOUNDED-MEMORY streaming rasterization from an in-memory buffer — see
 * `streamPdfPagesToJpegFromFile` for the TRUE bounded-memory runner variant
 * (which never materializes the PDF as a Buffer either). This one exists for
 * callers that already hold the PDF in memory (tests; anything NOT the
 * runner) but still want the one-page-at-a-time yield contract.
 */
export async function* streamPdfPagesToJpeg(
  pdfBuffer: Buffer,
): AsyncGenerator<Buffer, void, void> {
  const { workDir, files } = await renderToWorkDir(pdfBuffer);
  yield* readPagesAndCleanup(workDir, files);
}

/**
 * THE ingest runner's entry point (Phase 2.5 — the OOM fix): renders
 * directly from the raw upload FILE on the km_book_uploads volume — never
 * loading the PDF into a Buffer (`renderToWorkDirFromFile` passes the path
 * straight to `pdftoppm`) and never holding more than one rendered page's
 * bytes at once (`readPagesAndCleanup`). `server/src/services/
 * bookIngestRunner.ts` is the only production caller; it owns `inputPath`
 * (the raw upload) and deletes it itself only after the whole book has
 * decoded successfully — this function never touches that file beyond
 * reading it.
 */
export async function* streamPdfPagesToJpegFromFile(
  inputPath: string,
): AsyncGenerator<Buffer, void, void> {
  const { workDir, files } = await renderToWorkDirFromFile(inputPath);
  yield* readPagesAndCleanup(workDir, files);
}
