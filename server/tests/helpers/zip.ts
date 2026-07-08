/**
 * A minimal, hand-built ZIP archive constructor for tests — STORED
 * (uncompressed) entries only, no external zip-writer dependency (the
 * project doesn't have one; adding a whole zip-writing library just for test
 * fixtures would be a heavier dependency than the ~120 lines here).
 *
 * WHY hand-built rather than mocked: `services/zipPageExtract.ts`'s tests
 * (server/tests/routes/uploads.test.ts) need a REAL zip archive that the REAL
 * `yauzl` parser reads — a mocked zip-reader would only prove the ingest code
 * calls a function named `extractZipPages`, not that it can actually parse a
 * genuine vFlat-style export. This builds a byte-for-byte valid (if minimal)
 * ZIP: local file headers + STORED (method 0) entry data + a central
 * directory + an end-of-central-directory record, per the PKZIP APPNOTE
 * format yauzl implements.
 *
 * `declaredUncompressedSize` (and `declaredCompressedSize`, defaulting to the
 * same value) let a test LIE about an entry's size in the CENTRAL DIRECTORY
 * record specifically — used by the zip-bomb-guard tests to trip
 * `MAX_ENTRY_UNCOMPRESSED_BYTES` / `MAX_TOTAL_UNCOMPRESSED_BYTES` without
 * allocating a real 100MB+/2GB+ buffer. This is safe to do because
 * `zipPageExtract.ts`'s guards read `entry.uncompressedSize` straight from
 * yauzl's parsed CENTRAL DIRECTORY record and reject BEFORE ever opening the
 * entry's read stream — so the (deliberately real, tiny) local-header bytes
 * for that entry are never actually read when the guard fires.
 */

interface ZipEntrySpec {
  readonly name: string;
  readonly data: Buffer;
  /** Lie about this entry's declared uncompressed size in the CENTRAL
   *  DIRECTORY record only (local header + physical bytes stay real/tiny). */
  readonly declaredUncompressedSize?: number;
}

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0; // midnight
const DOS_DATE = 0x21; // 1980-01-01 — a fixed, valid-enough DOS date/time.

/**
 * Build a valid, minimal ZIP archive (STORED method — no compression)
 * containing the given entries, in the order provided (callers control
 * ordering via filenames to test `naturalCompare`-based re-sorting).
 */
export function buildStoredZip(entries: readonly ZipEntrySpec[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const realSize = entry.data.length;
    const declaredSize = entry.declaredUncompressedSize ?? realSize;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(0, 6); // general purpose bit flag
    localHeader.writeUInt16LE(0, 8); // compression method (0 = stored)
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(realSize, 18); // compressed size (real bytes)
    localHeader.writeUInt32LE(realSize, 22); // uncompressed size (real bytes)
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    const localRecord = Buffer.concat([localHeader, nameBuf, entry.data]);
    localParts.push(localRecord);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central directory signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(0, 8); // general purpose bit flag
    centralHeader.writeUInt16LE(0, 10); // compression method
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    // These two fields carry the (possibly LYING) declared size — see header.
    centralHeader.writeUInt32LE(declaredSize, 20); // compressed size
    centralHeader.writeUInt32LE(declaredSize, 24); // uncompressed size
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(0, 38); // external file attributes
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header

    centralParts.push(Buffer.concat([centralHeader, nameBuf]));
    offset += localRecord.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralDirectoryOffset = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk where central directory starts
  eocd.writeUInt16LE(entries.length, 8); // central directory records on this disk
  eocd.writeUInt16LE(entries.length, 10); // total central directory records
  eocd.writeUInt32LE(centralDirectory.length, 12); // size of central directory
  eocd.writeUInt32LE(centralDirectoryOffset, 16); // offset of start of central directory
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}
