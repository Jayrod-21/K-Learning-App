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
 *     (`bookUploadIngest.ingestUpload`) rejects with 400.
 */
import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
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

interface RawEntry {
  readonly name: string;
  readonly buffer: Buffer;
  readonly mime: PageImageMime;
}

/**
 * Extract every usable image entry from a ZIP buffer, ordered by natural
 * filename sort. Throws `ValidationError` (400) on a malformed archive or any
 * zip-bomb guard trip. Does NOT reject a zero-page result itself — the caller
 * (`ingestUpload`) makes that call so the "0 pages" message can be worded per
 * upload kind (zip vs. PDF).
 */
export async function extractZipPages(zipBuffer: Buffer): Promise<ExtractedPage[]> {
  const raw = await readZipImageEntries(zipBuffer);
  const ordered = [...raw].sort((a, b) => naturalCompare(a.name, b.name));
  return ordered.map((e) => ({ buffer: e.buffer, mime: e.mime }));
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
 * Two passes, deliberately:
 *   PASS 1 (metadata only) — enumerate EVERY central-directory entry, applying
 *     the count / per-entry-declared / total-declared zip-bomb guards, and
 *     collect the image-candidate `Entry` refs. NO entry bytes are read here.
 *     A declared bomb is rejected from its central directory alone, before a
 *     single byte is decompressed — the proper posture (don't start extracting
 *     an archive that ANNOUNCES it's a bomb) AND it means a later entry's
 *     size lie can't be masked by successfully streaming the earlier ones.
 *   PASS 2 (extract) — only once every guard has passed, open a read stream
 *     per candidate, sequentially, enforcing the ACTUAL-bytes cap (an entry
 *     that under-declares its size in the header can't sneak past — the
 *     streamed byte count is re-checked), sniff the magic bytes, keep the
 *     jpg/png pages.
 *
 * `autoClose: false` so the zipfile stays open for pass 2's streams after the
 * enumerate pass's 'end' fires; it's closed explicitly once both passes are
 * done (or on any failure).
 */
function readZipImageEntries(zipBuffer: Buffer): Promise<RawEntry[]> {
  return new Promise((resolve, reject) => {
    fromBuffer(zipBuffer, { lazyEntries: true, autoClose: false }, (openErr, zipfile) => {
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

      // PASS 1: metadata-only enumeration + guards.
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

      // PASS 2: all metadata validated — now extract the candidates' bytes.
      zipfile.on('end', () => {
        if (settled) return;
        void (async () => {
          try {
            const results: RawEntry[] = [];
            for (const entry of candidates) {
              const buffer = await readEntryBuffer(zipfile, entry);
              const mime = sniffImageMime(buffer);
              // Page images are jpg/png only (photographs of book pages) —
              // webp (a valid mime for the unrelated Images/OCR feature) and
              // anything else are silently skipped, not errors.
              if (mime === 'image/jpeg' || mime === 'image/png') {
                results.push({ name: entry.fileName, buffer, mime });
              }
            }
            if (settled) return;
            settled = true;
            zipfile.close();
            resolve(results);
          } catch (err) {
            fail(err instanceof Error ? err : new Error(String(err)));
          }
        })();
      });

      zipfile.readEntry();
    });
  });
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
