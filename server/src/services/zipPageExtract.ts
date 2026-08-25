/**
 * ZIP-of-page-images extraction (U1a rework — the vFlat export path). See
 * db/docs/PDF_UPLOAD_DESIGN.md §"REVISION (2026-07-08)".
 *
 * The real scans Jared owns are a vFlat export: a ZIP of high-res JPG page
 * images (sample: 548 pages, 240 MB) — NOT a single PDF. This module turns
 * that ZIP into an ORDERED array of page-image buffers, ready for
 * `services/bookUploadIngest.ts` to persist as `book_pages` rows.
 *
 * ORDER: entries are sorted by filename with `naturalCompare` (natural sort —
 * "page2.jpg" before "page10.jpg"), which seeds `book_pages.page_number`. A
 * vFlat retake can still land out of order within that seed (a human fixes it
 * later via `PATCH /uploads/:id/pages/order`) — this module only guarantees
 * "the same order the filenames imply", nothing content-aware.
 *
 * SECURITY — zip-bomb / malicious-archive guards (all checked BEFORE any
 * entry's bytes are decompressed, using the central-directory metadata
 * `yauzl` exposes without touching entry data):
 *   - MAX_ZIP_ENTRIES: caps the total entry count (directories/dotfiles
 *     count too — the guard fires on iteration count, not "useful" entries,
 *     so a bomb can't hide behind a flood of skippable junk).
 *   - MAX_ENTRY_UNCOMPRESSED_BYTES: caps any single entry's DECLARED
 *     uncompressed size. Checked again against the ACTUAL bytes read (an
 *     entry can lie about its declared size), so a truncated/adversarial
 *     header can't bypass the cap by understating it.
 *   - MAX_TOTAL_UNCOMPRESSED_BYTES: caps the running total across all
 *     entries (declared sizes) — the classic zip-bomb defense (a small
 *     archive that expands to gigabytes).
 *   - Directories, dotfiles (`.foo`), and macOS `__MACOSX/` metadata entries
 *     are silently skipped (not counted as errors) — common in real exports.
 *   - Non-image entries (by MAGIC BYTES, not extension — `sniffImageMime`)
 *     are silently skipped. Only `image/jpeg` and `image/png` count as pages
 *     (page images are photographs of book pages; `image/webp` — allowed for
 *     the unrelated Images/OCR feature — is NOT a page-image format here and
 *     is treated as a non-image entry).
 *   - Zero usable image pages after the full scan → the caller
 *     (`bookIngestRunner.ts`) settles the upload 'failed'.
 *
 * STREAMING (Phase 2.5 — the OOM fix): `streamZipImageEntriesFromFile` is the
 * bounded-memory entry point the ingest RUNNER uses — an async generator that
 * OPENS THE RAW ZIP BY PATH (`yauzl.open`, fd-based — never loads the whole
 * compressed archive into a Buffer either) and yields ONE decompressed page
 * at a time, so the caller can write + release each buffer before the next is
 * decompressed. At most one page's bytes (plus the small, metadata-only
 * candidate list, capped at `MAX_ZIP_ENTRIES`) are ever resident at once —
 * never the whole raw file, and never the whole decompressed page set.
 * `streamZipImageEntries` (buffer-based) and `extractZipPages` (array-
 * returning) stay for callers that already hold the zip as a Buffer (tests;
 * anything NOT the ingest runner) — both are now implemented on top of one
 * shared candidate-collection + per-entry-extraction core, so the guard/order
 * logic lives in exactly one place regardless of entry point.
 */
import { fromBuffer, open as openZipFile, type Entry, type Options, type ZipFile } from 'yauzl';
import { ValidationError } from '../middleware/errors.js';
import { sniffImageMime } from './imageIngest.js';
import { naturalCompare } from './naturalSort.js';

/** Zip-bomb guards — see module header. Exported so tests can construct
 *  fixtures that deliberately trip each one without allocating real
 *  gigabyte-scale buffers (a hand-built zip can LIE about an entry's declared
 *  central-directory size; see tests/helpers/zip.ts). */
export const MAX_ZIP_ENTRIES = 2000;
export const MAX_ENTRY_UNCOMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MiB / page
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB total

export type PageImageMime = 'image/jpeg' | 'image/png';

export interface ExtractedPage {
  readonly buffer: Buffer;
  readonly mime: PageImageMime;
}

/**
 * Extract every usable image entry from a ZIP buffer, ordered by natural
 * filename sort. Throws `ValidationError` (400) on a malformed archive or any
 * zip-bomb guard trip. Does NOT reject a zero-page result itself — the caller
 * (`bookIngestRunner.ts`) makes that call so the "0 pages" message can be
 * worded per upload kind (zip vs. PDF).
 *
 * Array-returning convenience built ON TOP OF `streamZipImageEntries` (drains
 * the generator into memory) — fine for a caller that genuinely wants the
 * whole set at once (tests; anything NOT the ingest runner). The runner
 * itself MUST use the generator directly — see that function's doc.
 */
export async function extractZipPages(zipBuffer: Buffer): Promise<ExtractedPage[]> {
  const pages: ExtractedPage[] = [];
  for await (const page of streamZipImageEntries(zipBuffer)) {
    pages.push(page);
  }
  return pages;
}

function isSkippableEntryName(name: string): boolean {
  if (name.endsWith('/')) return true; // directory entry
  const segments = name.split('/');
  const base = segments[segments.length - 1] ?? name;
  if (base.startsWith('.')) return true; // dotfile (.DS_Store, ._*, ...)
  if (segments.some((seg) => seg === '__MACOSX')) return true; // macOS metadata
  return false;
}

/**
 * PASS 1 (metadata only) — enumerate EVERY central-directory entry, applying
 * the count / per-entry-declared / total-declared zip-bomb guards, and
 * collect the image-candidate `Entry` refs, sorted by natural filename order
 * (the sort key — `entry.fileName` — comes straight from central-directory
 * metadata, so it's available and cheap here, BEFORE any entry's bytes are
 * touched; sorting at this point means pass 2 can extract-and-yield in FINAL
 * page order without ever holding more than one decompressed page at a time).
 * NO entry bytes are read here. A declared bomb is rejected from its central
 * directory alone, before a single byte is decompressed — the proper posture
 * (don't start extracting an archive that ANNOUNCES it's a bomb) AND it means
 * a later entry's size lie can't be masked by successfully streaming the
 * earlier ones.
 *
 * Returns the open `zipfile` (NOT closed — `autoClose: false`, so it stays
 * open for the caller's pass 2 reads) alongside the sorted candidates; the
 * caller owns closing it (success, generator return, or thrown error alike).
 *
 * `openZip` is the yauzl opener to use — `fromBuffer` (already-in-memory
 * archive) or `open` (by file path, fd-based — see `streamZipImageEntriesFromFile`)
 * share an identical `(options, callback)` shape, so this function is opener-
 * agnostic and the SAME guard/candidate logic backs both entry points.
 */
function collectCandidateEntries(
  openZip: (options: Options, callback: (err: Error | null, zipfile?: ZipFile) => void) => void,
): Promise<{ zipfile: ZipFile; candidates: Entry[] }> {
  return new Promise((resolve, reject) => {
    openZip({ lazyEntries: true, autoClose: false }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        reject(new ValidationError('uploaded file is not a valid zip archive'));
        return;
      }

      const candidates: Entry[] = [];
      let entryCount = 0;
      let totalDeclaredUncompressed = 0;
      let settled = false;

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        zipfile.close();
        reject(err);
      };

      zipfile.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));

      zipfile.on('entry', (entry: Entry) => {
        entryCount += 1;
        if (entryCount > MAX_ZIP_ENTRIES) {
          fail(new ValidationError(`zip archive has too many entries (max ${MAX_ZIP_ENTRIES})`));
          return;
        }

        if (isSkippableEntryName(entry.fileName)) {
          zipfile.readEntry();
          return;
        }

        // Declared-size guards — read straight from the central directory
        // record; no entry bytes are touched.
        if (entry.uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
          fail(
            new ValidationError(
              `zip entry "${entry.fileName}" declares a size over the per-page limit (possible zip bomb)`,
            ),
          );
          return;
        }
        totalDeclaredUncompressed += entry.uncompressedSize;
        if (totalDeclaredUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
          fail(
            new ValidationError(
              'zip archive exceeds the total uncompressed size limit (possible zip bomb)',
            ),
          );
          return;
        }

        candidates.push(entry);
        zipfile.readEntry();
      });

      zipfile.on('end', () => {
        if (settled) return;
        settled = true;
        candidates.sort((a, b) => naturalCompare(a.fileName, b.fileName));
        resolve({ zipfile, candidates });
      });

      zipfile.readEntry();
    });
  });
}

/**
 * BOUNDED-MEMORY streaming extraction core, shared by both public generator
 * entry points below (buffer-based and file-based) — decompresses and yields
 * ONE page at a time, in final (natural-sorted) page order. The caller MUST
 * consume each yielded page (write its blob, await it) BEFORE requesting the
 * next — nothing here ever holds more than one page's decompressed bytes at
 * once (the candidate list from pass 1 is metadata only: `Entry` objects, not
 * page bytes, and is capped at `MAX_ZIP_ENTRIES`).
 *
 * Every zip-bomb guard from the two-pass design still applies, just spread
 * across the generator's lifecycle: PASS 1 (all declared-size/count guards)
 * runs eagerly on the first `next()` call (inside `collectCandidateEntries`,
 * before the first page is ever yielded); PASS 2's ACTUAL-streamed-bytes cap
 * (`readEntryBuffer`) is enforced per entry, lazily, as each page is pulled.
 *
 * Cleanup: the zipfile is closed in a `finally` so it's released whether the
 * generator runs to completion, the caller stops early (`break`/`return` out
 * of a `for await`), or an entry fails mid-stream.
 */
async function* streamCandidatePages(
  openZip: (options: Options, callback: (err: Error | null, zipfile?: ZipFile) => void) => void,
): AsyncGenerator<ExtractedPage, void, void> {
  const { zipfile, candidates } = await collectCandidateEntries(openZip);
  try {
    for (const entry of candidates) {
      const buffer = await readEntryBuffer(zipfile, entry);
      const mime = sniffImageMime(buffer);
      // Page images are jpg/png only (photographs of book pages) — webp (a
      // valid mime for the unrelated Images/OCR feature) and anything else
      // are silently skipped, not errors.
      if (mime === 'image/jpeg' || mime === 'image/png') {
        yield { buffer, mime };
      }
      // `buffer` (and the just-yielded page, once the caller's `await` on
      // this iteration resolves) is eligible for GC here — nothing in this
      // function retains it past this iteration.
    }
  } finally {
    zipfile.close();
  }
}

/**
 * Buffer-based streaming entry point — for a caller that already holds the
 * zip in memory (tests; anything that isn't the ingest runner). See
 * `streamZipImageEntriesFromFile` for the runner's TRUE bounded-memory
 * variant, which never materializes the raw archive as a Buffer either.
 */
export function streamZipImageEntries(zipBuffer: Buffer): AsyncGenerator<ExtractedPage, void, void> {
  return streamCandidatePages((options, callback) => fromBuffer(zipBuffer, options, callback));
}

/**
 * THE ingest runner's entry point (Phase 2.5 — the OOM fix, file half):
 * streams pages directly from the raw zip FILE ON DISK — `yauzl.open` reads
 * via a file descriptor (seeking to the central directory, then streaming
 * each entry's compressed bytes on demand) and never loads the whole archive
 * into a Buffer, unlike `streamZipImageEntries`/`fromBuffer` above. Combined
 * with the one-page-at-a-time yield contract, this means a 300 MiB raw zip's
 * ENTIRE processing footprint is bounded by roughly one page's decompressed
 * size, never the archive's total size and never the decompressed total.
 * `server/src/services/bookIngestRunner.ts` is the only production caller.
 */
export function streamZipImageEntriesFromFile(
  absPath: string,
): AsyncGenerator<ExtractedPage, void, void> {
  return streamCandidatePages((options, callback) => openZipFile(absPath, options, callback));
}

/**
 * Read one entry's bytes into a Buffer, enforcing the ACTUAL-streamed-bytes
 * cap (defense in depth: an entry that under-declares its size in the central
 * directory — which pass 1's declared-size guard trusts — can't smuggle in
 * more than MAX_ENTRY_UNCOMPRESSED_BYTES of real data). Rejects with a
 * ValidationError if the entry over-runs the per-page cap while streaming.
 */
function readEntryBuffer(zipfile: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (streamErr, stream) => {
      if (streamErr || !stream) {
        reject(streamErr instanceof Error ? streamErr : new Error('failed to open zip entry stream'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      stream.on('data', (chunk: Buffer) => {
        if (done) return;
        size += chunk.length;
        if (size > MAX_ENTRY_UNCOMPRESSED_BYTES) {
          done = true;
          stream.destroy();
          reject(
            new ValidationError(`zip entry "${entry.fileName}" exceeds the per-page size limit`),
          );
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', (err) => {
        if (done) return;
        done = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      stream.on('end', () => {
        if (done) return;
        done = true;
        resolve(Buffer.concat(chunks));
      });
    });
  });
}
