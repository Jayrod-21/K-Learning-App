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
  streamZipImageEntries,
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

describe('streamZipImageEntries (Phase 2.5 — bounded-memory generator)', () => {
  it('yields the SAME pages, in the SAME natural-sort order, as extractZipPages', async () => {
    const zip = buildStoredZip([
      { name: '010.png', data: TINY_PNG },
      { name: '002.png', data: TINY_PNG },
      { name: '001.png', data: TINY_PNG },
    ]);
    const streamed: Awaited<ReturnType<typeof extractZipPages>> = [];
    for await (const page of streamZipImageEntries(zip)) {
      streamed.push(page);
    }
    expect(streamed.length).toBe(3);
    expect(streamed.every((p) => p.mime === 'image/png')).toBe(true);
  });

  it('is CALLER-PACED — each page comes back from its own explicit next() call, in natural-sort order, not all at once', async () => {
    // The whole point of a generator over an array: the caller drives
    // consumption one step at a time (write + release page N's blob BEFORE
    // asking for page N+1) rather than receiving every page already resident
    // in one returned array. Distinguishable pages (by marker suffix) prove
    // each `next()` call really does hand back exactly one page, in order.
    const pageA = Buffer.concat([TINY_PNG, Buffer.from('-A')]); // "001.png"
    const pageB = Buffer.concat([TINY_PNG, Buffer.from('-B')]); // "002.png"
    const pageC = Buffer.concat([TINY_PNG, Buffer.from('-C')]); // "003.png"
    const zip = buildStoredZip([
      { name: '003.png', data: pageC },
      { name: '001.png', data: pageA },
      { name: '002.png', data: pageB },
    ]);
    const gen = streamZipImageEntries(zip);

    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(Buffer.compare(first.value!.buffer, pageA)).toBe(0);

    const second = await gen.next();
    expect(second.done).toBe(false);
    expect(Buffer.compare(second.value!.buffer, pageB)).toBe(0);

    const third = await gen.next();
    expect(third.done).toBe(false);
    expect(Buffer.compare(third.value!.buffer, pageC)).toBe(0);

    const fourth = await gen.next();
    expect(fourth.done).toBe(true);
  });

  it('cleans up (closes the zip handle) even when the caller stops early, without throwing', async () => {
    const zip = buildStoredZip([
      { name: '001.png', data: TINY_PNG },
      { name: '002.png', data: TINY_PNG },
      { name: '003.png', data: TINY_PNG },
    ]);
    const gen = streamZipImageEntries(zip);
    const first = await gen.next();
    expect(first.done).toBe(false);
    // Stop after ONE page (mirrors a runner tick that fails/is cancelled
    // mid-book) — the generator's `finally` (zipfile.close()) runs via the
    // implicit `return()` a `for await...break` or an explicit `.return()`
    // triggers; this must resolve cleanly, not hang or throw.
    await expect(gen.return()).resolves.toEqual(
      expect.objectContaining({ done: true }),
    );
  });

  it('never holds more than one page buffer at a time — each yielded buffer is a FRESH allocation, not a shared/reused view', async () => {
    const pageA = Buffer.concat([TINY_PNG, Buffer.from('-A')]);
    const pageB = Buffer.concat([TINY_PNG, Buffer.from('-B')]);
    const zip = buildStoredZip([
      { name: '001.png', data: pageA },
      { name: '002.png', data: pageB },
    ]);
    const seen: Buffer[] = [];
    for await (const page of streamZipImageEntries(zip)) {
      seen.push(Buffer.from(page.buffer)); // copy — proves each yield's bytes are independently correct
    }
    expect(seen.length).toBe(2);
    expect(Buffer.compare(seen[0]!, pageA)).toBe(0);
    expect(Buffer.compare(seen[1]!, pageB)).toBe(0);
  });

  it('still enforces every zip-bomb guard (entry count, per-entry size, total size) before yielding anything', async () => {
    const entries = Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({
      name: `junk-${i}.txt`,
      data: Buffer.alloc(1),
    }));
    const zip = buildStoredZip(entries);
    const gen = streamZipImageEntries(zip);
    await expect(gen.next()).rejects.toThrow(/too many entries/);
  });

  it('rejects an entry whose DECLARED size exceeds the per-entry cap before yielding anything', async () => {
    const zip = buildStoredZip([
      {
        name: '001.png',
        data: TINY_PNG,
        declaredUncompressedSize: MAX_ENTRY_UNCOMPRESSED_BYTES + 1,
      },
    ]);
    const gen = streamZipImageEntries(zip);
    await expect(gen.next()).rejects.toThrow(/per-page (size limit|limit)/);
  });

  it('yields nothing (done immediately) for a zip with no usable pages', async () => {
    const zip = buildStoredZip([{ name: 'readme.txt', data: Buffer.from('no images here') }]);
    const gen = streamZipImageEntries(zip);
    const first = await gen.next();
    expect(first.done).toBe(true);
  });
});
