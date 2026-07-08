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
import { fromBuffer, type Entry } from 'yauzl';
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

function readZipImageEntries(zipBuffer: Buffer): Promise<RawEntry[]> {
  return new Promise((resolve, reject) => {
    fromBuffer(zipBuffer, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        reject(new ValidationError('uploaded file is not a valid zip archive'));
        return;
      }

      const results: RawEntry[] = [];
      let entryCount = 0;
      let totalDeclaredUncompressed = 0;
      let settled = false;

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        zipfile.close();
        reject(err);
      };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve(results);
      };

      zipfile.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
      zipfile.on('end', finish);

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

        // Declared-size guard BEFORE touching any bytes — yauzl reads this
        // straight from the central directory record.
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

        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            fail(streamErr instanceof Error ? streamErr : new Error('failed to open zip entry stream'));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length;
            // Defense in depth: re-check against the ACTUAL bytes streamed,
            // not just the (possibly understated/lying) declared size above.
            if (size > MAX_ENTRY_UNCOMPRESSED_BYTES) {
              stream.destroy();
              fail(
                new ValidationError(
                  `zip entry "${entry.fileName}" exceeds the per-page size limit`,
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          stream.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
          stream.on('end', () => {
            if (settled) return;
            const buffer = Buffer.concat(chunks);
            const mime = sniffImageMime(buffer);
            // Page images are jpg/png only (photographs of book pages) —
            // webp (a valid mime for the unrelated Images/OCR feature) and
            // anything else are silently skipped, not errors.
            if (mime === 'image/jpeg' || mime === 'image/png') {
              results.push({ name: entry.fileName, buffer, mime });
            }
            zipfile.readEntry();
          });
        });
      });

      zipfile.readEntry();
    });
  });
}
