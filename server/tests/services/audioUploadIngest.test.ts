/**
 * Unit tests for the audio magic-byte sniff (Track A, A-3 —
 * services/audioUploadIngest.ts). Pure functions, no DB/app: the sniff is the
 * upload route's content AUTHORITY (the declared mime and filename are never
 * trusted), so its accept/reject edges are pinned here; the route-level
 * integration (a `.mp3`-named text payload → 400, no writes) lives in
 * tests/routes/audio.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  extForAudioKind,
  sniffAudioKind,
  sniffM4aMagicBytes,
  sniffMp3MagicBytes,
} from '../../src/services/audioUploadIngest.js';

function m4a(brand: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x20]),
    Buffer.from('ftyp', 'latin1'),
    Buffer.from(brand, 'latin1'),
    Buffer.alloc(8),
  ]);
}

describe('sniffMp3MagicBytes', () => {
  it('accepts an ID3v2-tagged file', () => {
    expect(sniffMp3MagicBytes(Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'latin1'))).toBe(true);
  });

  it('accepts a bare MPEG frame header (0xFF + 3 sync bits, real layer)', () => {
    // 0xFFFB = MPEG-1 Layer III; 0xFFF3 = MPEG-2 Layer III; 0xFFE2 = MPEG-2.5.
    for (const b1 of [0xfb, 0xf3, 0xe2]) {
      expect(sniffMp3MagicBytes(Buffer.from([0xff, b1, 0x90, 0x00]))).toBe(true);
    }
  });

  it('rejects a sync-looking pair whose layer bits are the reserved 00', () => {
    // 0xFFE1: sync bits present but layer = 00 (reserved) — not a real frame.
    expect(sniffMp3MagicBytes(Buffer.from([0xff, 0xe1, 0x90, 0x00]))).toBe(false);
  });

  it('rejects a sync-looking pair whose MPEG version bits are the reserved 01', () => {
    // 0xFFEA = 1110 1010: valid sync + valid layer (01 = Layer III) but the
    // version bits ((b1 >> 3) & 0b11) are 01 — the reserved MPEG version, so
    // this is not a real frame header and must not sniff as mp3.
    expect(sniffMp3MagicBytes(Buffer.from([0xff, 0xea, 0x90, 0x00]))).toBe(false);
    expect(sniffAudioKind(Buffer.from([0xff, 0xea, 0x90, 0x00]))).toBeNull();
  });

  it('rejects non-audio content (text, PNG, zip, empty, 1 byte)', () => {
    expect(sniffMp3MagicBytes(Buffer.from('hello world'))).toBe(false);
    expect(sniffMp3MagicBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false); // PNG
    expect(sniffMp3MagicBytes(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(false); // zip
    expect(sniffMp3MagicBytes(Buffer.alloc(0))).toBe(false);
    expect(sniffMp3MagicBytes(Buffer.from([0xff]))).toBe(false);
  });
});

describe('sniffM4aMagicBytes', () => {
  it('accepts the audio-bearing major brands', () => {
    for (const brand of ['M4A ', 'M4B ', 'mp42', 'isom', 'iso2']) {
      expect(sniffM4aMagicBytes(m4a(brand))).toBe(true);
    }
  });

  it('rejects a non-audio brand, a missing ftyp box, and short buffers', () => {
    expect(sniffM4aMagicBytes(m4a('qt  '))).toBe(false); // QuickTime video brand
    expect(sniffM4aMagicBytes(Buffer.from('notftypM4A here', 'latin1'))).toBe(false);
    expect(sniffM4aMagicBytes(Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74]))).toBe(false);
    expect(sniffM4aMagicBytes(Buffer.alloc(0))).toBe(false);
  });
});

describe('sniffAudioKind + extForAudioKind', () => {
  it('classifies by content and maps kind → stored extension 1:1', () => {
    expect(sniffAudioKind(Buffer.from('ID3\x03\x00', 'latin1'))).toBe('mp3');
    expect(sniffAudioKind(m4a('M4A '))).toBe('m4a');
    expect(sniffAudioKind(Buffer.from('plain text'))).toBeNull();
    expect(extForAudioKind('mp3')).toBe('mp3');
    expect(extForAudioKind('m4a')).toBe('m4a');
  });
});
