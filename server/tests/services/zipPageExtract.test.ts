/**
 * zipPageExtract — REAL zip parsing unit tests (U1a rework, ZIP-of-images/
 * vFlat upload path). Uses `tests/helpers/zip.ts`'s hand-built ZIP archives
 * (real bytes, parsed by the REAL `yauzl` — no mocking) so this exercises the
 * actual archive format, not a stand-in.
 */
import { describe, expect, it } from 'vitest';
import {
  extractZipPages,
  MAX_ENTRY_UNCOMPRESSED_BYTES,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  MAX_ZIP_ENTRIES,
} from '../../src/services/zipPageExtract.js';
import { buildStoredZip } from '../helpers/zip.js';

/** A minimal but VALID (decodable) 1x1 PNG — same fixture used by
 *  tests/routes/images.test.ts's TINY_PNG. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('extractZipPages', () => {
  it('orders entries by NATURAL filename sort, not append order', async () => {
    const zip = buildStoredZip([
      { name: '010.png', data: TINY_PNG },
      { name: '002.png', data: TINY_PNG },
      { name: '001.png', data: TINY_PNG },
    ]);
    const pages = await extractZipPages(zip);
    expect(pages.length).toBe(3);
    expect(pages.every((p) => p.mime === 'image/png')).toBe(true);
  });

  it('ignores directory entries, dotfiles, and __MACOSX metadata', async () => {
    const zip = buildStoredZip([
      { name: 'pages/', data: Buffer.alloc(0) },
      { name: '.DS_Store', data: Buffer.from('junk') },
      { name: '__MACOSX/._001.png', data: Buffer.from('junk') },
      { name: '001.png', data: TINY_PNG },
    ]);
    const pages = await extractZipPages(zip);
    expect(pages.length).toBe(1);
  });

  it('ignores non-image entries (by magic bytes) without erroring', async () => {
    const zip = buildStoredZip([
      { name: 'metadata.json', data: Buffer.from('{"title":"test"}') },
      { name: '001.png', data: TINY_PNG },
    ]);
    const pages = await extractZipPages(zip);
    expect(pages.length).toBe(1);
  });

  it('returns an empty array (caller decides 400) for a zip with no usable pages', async () => {
    const zip = buildStoredZip([{ name: 'readme.txt', data: Buffer.from('no images here') }]);
    const pages = await extractZipPages(zip);
    expect(pages.length).toBe(0);
  });

  it('rejects a zip with more than MAX_ZIP_ENTRIES entries (zip-bomb entry-count guard)', async () => {
    const entries = Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({
      name: `junk-${i}.txt`,
      data: Buffer.alloc(1),
    }));
    const zip = buildStoredZip(entries);
    await expect(extractZipPages(zip)).rejects.toThrow(/too many entries/);
  });

  it('rejects an entry whose DECLARED size exceeds the per-entry cap (declared-size guard)', async () => {
    const zip = buildStoredZip([
      {
        name: '001.png',
        data: TINY_PNG,
        declaredUncompressedSize: MAX_ENTRY_UNCOMPRESSED_BYTES + 1,
      },
    ]);
    await expect(extractZipPages(zip)).rejects.toThrow(/per-page (size limit|limit)/);
  });

  it('rejects when the running total of declared sizes exceeds the total cap, even though no SINGLE entry exceeds the per-entry cap (zip-bomb total-size guard)', async () => {
    // Each entry lies at EXACTLY the per-entry cap (never trips it alone);
    // enough of them push the RUNNING TOTAL past the total cap.
    const entryCount = Math.ceil(MAX_TOTAL_UNCOMPRESSED_BYTES / MAX_ENTRY_UNCOMPRESSED_BYTES) + 1;
    const entries = Array.from({ length: entryCount }, (_, i) => ({
      name: `${String(i).padStart(3, '0')}.png`,
      data: TINY_PNG,
      declaredUncompressedSize: MAX_ENTRY_UNCOMPRESSED_BYTES,
    }));
    const zip = buildStoredZip(entries);
    await expect(extractZipPages(zip)).rejects.toThrow(/total uncompressed size limit/);
  });

  it('rejects a buffer that is not a valid zip archive at all', async () => {
    await expect(extractZipPages(Buffer.from('not a zip'))).rejects.toThrow(/not a valid zip archive/);
  });
});
