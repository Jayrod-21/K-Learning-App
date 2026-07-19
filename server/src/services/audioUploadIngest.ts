/**
 * Audio-upload ingest helpers (Track A, A-3 — the server-side audio upload
 * path). Owns the multer middleware and the magic-byte audio sniff the
 * `POST /audio` route (routes/audio.ts) builds on — the exact split
 * `services/bookUploadIngest.ts` uses for the book-upload route (see its
 * header for the fuller rationale; here restated for this surface).
 *
 * SECURITY (mirrors bookUploadIngest.ts's posture):
 *   - UPLOAD: multer MEMORY storage, single `file` field, a config-driven
 *     fileSize cap (AUDIO_UPLOAD_MAX_BYTES → 413), declared-mime `fileFilter`
 *     as an EARLY reject only — the magic-byte sniff (`sniffAudioKind`) after
 *     multer is the authority (never trust the client-declared mime or the
 *     filename extension). A `.mp3`-named text/PNG payload is rejected by
 *     CONTENT, not accepted by name.
 *   - The sniffed kind — never the client filename — decides the stored
 *     extension (audioStore.saveBlob's `ext`), so no client string ever
 *     reaches a filesystem path.
 *   - COST/ABUSE: the per-user daily transcription-bytes cap (429, enforced by
 *     the route inside its claim transaction under an advisory lock) uses
 *     `AudioDailyCapError` below — every enqueued byte is a Whisper-CPU
 *     commitment, so the cap is checked BEFORE anything is written.
 */
import multer, { MulterError } from 'multer';
import type { NextFunction, Request, Response } from 'express';
import { AppError, PayloadTooLargeError, ValidationError } from '../middleware/errors.js';
import { loadConfig } from '../config/index.js';
import type { AudioBlobExt } from './audioStore.js';

// ---------------------------------------------------------------------------
// Upload constraints + multer
// ---------------------------------------------------------------------------

/**
 * Declared-mime allowlist for the fileFilter's EARLY reject only — never the
 * authority (the magic-byte sniff below is). Audio arrives under several
 * declared mimes depending on OS/browser (mp3 = `audio/mpeg`, sometimes the
 * nonstandard `audio/mp3`; m4a = `audio/mp4` / `audio/x-m4a` / `audio/m4a`;
 * and some browsers fall back to the generic `application/octet-stream` for
 * any binary they don't recognize), so this list is intentionally permissive —
 * being wrong here just means the request buffers and is sniff-rejected a
 * little later instead of at the fileFilter, never a security gap.
 */
export const ALLOWED_AUDIO_MIMES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/aac',
  'application/octet-stream',
] as const;

/**
 * Run multer (memory storage, single `file` field, config-driven size cap)
 * and translate its errors into our typed 4xx — a raw `MulterError` would
 * otherwise reach the error handler as a generic 500. `LIMIT_FILE_SIZE` maps
 * to 413 Payload Too Large; every other MulterError (unexpected field, too
 * many files/parts) maps to 400. Mirrors `multerBookUpload`.
 *
 * The multer instance is built PER REQUEST from the current config (rather
 * than once at module load, as bookUploadIngest does with its constant cap)
 * because the cap here is a config knob (AUDIO_UPLOAD_MAX_BYTES) that tests
 * override per suite; `loadConfig()` is memoized and `multer()` construction
 * is trivial, so this costs nothing on the hot path.
 *
 * `limits.fields: 2` leaves room for the optional `title` text field
 * alongside the file part (an extra body field is also rejected by the
 * route's `.strict()` Zod schema — belt and braces).
 */
/**
 * Marker the fileFilter stamps on the request when it DROPS the file for a
 * disallowed declared mime (`cb(null, false)` surfaces as "no req.file", which
 * the route would otherwise report as the misleading "file is required"). The
 * route reads this to name the real reason. We keep the drop-don't-error
 * fileFilter shape (matching multerBookUpload) rather than `cb(err)` so multer
 * still drains the multipart stream normally instead of aborting mid-body.
 */
export interface AudioMimeRejection {
  audioRejectedMime?: string;
}

export function multerAudioUpload(req: Request, res: Response, next: NextFunction): void {
  const cfg = loadConfig();
  const uploadSingle = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: cfg.AUDIO_UPLOAD_MAX_BYTES, files: 1, fields: 2 },
    fileFilter: (filterReq, file, cb) => {
      if ((ALLOWED_AUDIO_MIMES as readonly string[]).includes(file.mimetype)) {
        cb(null, true);
      } else {
        // Reject without throwing — surfaces as no `req.file`, mapped to 400
        // by the route's presence check. Record the declared mime (bounded —
        // it is a client-controlled header echoed back in the error message)
        // so that 400 can say WHY instead of "file is required".
        (filterReq as Request & AudioMimeRejection).audioRejectedMime = file.mimetype.slice(
          0,
          100,
        );
        cb(null, false);
      }
    },
  }).single('file');
  uploadSingle(req, res, (err: unknown) => {
    if (err instanceof MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        next(
          new PayloadTooLargeError(
            `upload exceeds the ${Math.floor(cfg.AUDIO_UPLOAD_MAX_BYTES / (1024 * 1024))} MB limit`,
          ),
        );
        return;
      }
      next(new ValidationError(`invalid upload: ${err.code}`));
      return;
    }
    if (err) {
      next(err);
      return;
    }
    next();
  });
}

// ---------------------------------------------------------------------------
// Magic-byte sniff — the mime AUTHORITY (never the declared mime / filename)
// ---------------------------------------------------------------------------

/** The sniffed audio container kinds this route accepts. Maps 1:1 onto the
 *  stored extension (audioStore's AudioBlobExt). */
export type AudioKind = 'mp3' | 'm4a';

/**
 * Sniff the leading bytes for MPEG audio (mp3). Two valid openings:
 *   - an ID3v2 metadata tag: the literal ASCII `ID3` (0x49 0x44 0x33) — how
 *     virtually every tagged mp3 begins;
 *   - a bare MPEG frame header: 11 sync bits, i.e. 0xFF then the top 3 bits of
 *     the next byte set (0xFFEx). We additionally require BOTH reserved-value
 *     header fields to be non-reserved: the version bits ((b1 >> 3) & 0b11)
 *     must not be `01` (the reserved MPEG version) and the layer bits
 *     ((b1 >> 1) & 0b11) must not be `00` (the reserved layer) — so a
 *     0xFF-then-high-bits byte pair from a random binary (e.g. 0xFF 0xEA,
 *     which has valid sync + layer but the reserved version) does not pass.
 *     (A full parse is deliberately out of scope: the sniff gates entry;
 *     Whisper/ffmpeg downstream is what actually decodes and will fail a
 *     corrupt file into a settled 'failed' job, never a crash.)
 */
export function sniffMp3MagicBytes(buf: Buffer): boolean {
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    return true; // "ID3"
  }
  return (
    buf.length >= 2 &&
    buf[0] === 0xff &&
    ((buf[1]! & 0xe0) === 0xe0) && // 11-bit frame sync
    ((buf[1]! >> 3) & 0x03) !== 0x01 && // version bits ≠ reserved 01
    ((buf[1]! >> 1) & 0x03) !== 0 // layer bits ≠ reserved 00
  );
}

/** ISO-BMFF major brands we accept for `.m4a` storage (bytes 8–11, after the
 *  box size + `ftyp`). 'M4A '/'M4B ' are the canonical iTunes AUDIO brands;
 *  'mp42'/'isom'/'iso2' are GENERIC MPEG-4 brands that real-world m4a audio
 *  encoders stamp — and that MP4 VIDEO files also carry. Accepting the
 *  generic brands is a deliberate trade-off: dropping them would reject
 *  legitimate m4a audio from common encoders, while an MP4 video that passes
 *  the sniff is harmless in A-3 — the stored blob only ever reaches
 *  ffmpeg/Whisper on the worker (video-with-audio has its audio track
 *  transcribed; video-without-audio settles the job 'failed'), and A-3 never
 *  serves the bytes to a browser.
 *  // A-4 must serve these blobs with an explicit audio Content-Type +
 *  // X-Content-Type-Options: nosniff — a generic-brand MP4 stored as .m4a
 *  // must never be left browser-sniffable. */
const M4A_BRANDS = ['M4A ', 'M4B ', 'mp42', 'isom', 'iso2'] as const;

/**
 * Sniff the leading bytes for an ISO-BMFF (MPEG-4) container we store as m4a:
 * bytes 4–7 are the literal ASCII `ftyp` box type (bytes 0–3 are the box's
 * big-endian size — any value), and the major brand at bytes 8–11 is one of
 * M4A_BRANDS above. Brands outside that list (e.g. QuickTime's 'qt  ') and
 * non-ftyp-leading files are rejected; note the generic MPEG-4 brands in the
 * list are shared with MP4 video BY DESIGN — see the M4A_BRANDS comment for
 * why that is accepted and what A-4 must do about it.
 */
export function sniffM4aMagicBytes(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf.toString('latin1', 4, 8) !== 'ftyp') return false;
  const brand = buf.toString('latin1', 8, 12);
  return (M4A_BRANDS as readonly string[]).includes(brand);
}

/** Classify the upload by magic bytes only — never the client-declared mime
 *  or filename. Returns null for anything that is not real mp3/m4a audio. */
export function sniffAudioKind(buf: Buffer): AudioKind | null {
  if (sniffMp3MagicBytes(buf)) return 'mp3';
  if (sniffM4aMagicBytes(buf)) return 'm4a';
  return null;
}

/** Sniffed kind → the on-disk extension audioStore writes. Total by
 *  construction (AudioKind and AudioBlobExt are the same closed set). */
export function extForAudioKind(kind: AudioKind): AudioBlobExt {
  return kind;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * 429 for the per-user daily transcription-bytes cap (mirrors
 * bookUploadIngest's DailyCapError / uploadExtract's ExtractionDailyCapError).
 * Names the numbers so the client can render a useful message; the route
 * raises it BEFORE any row or blob is written.
 */
export class AudioDailyCapError extends AppError {
  public constructor(capBytes: number, usedBytes: number, requestedBytes: number) {
    super(
      429,
      'rate_limited',
      `daily audio-transcription limit reached: ${usedBytes} of ${capBytes} bytes used today; ` +
        `this file (${requestedBytes} bytes) would exceed it. Try again tomorrow.`,
    );
    this.name = 'AudioDailyCapError';
  }
}

/**
 * 429 for the per-user daily upload-COUNT cap (AUDIO_UPLOAD_DAILY_COUNT_CAP —
 * mirrors bookUploadIngest's DailyCapError). The bytes cap above is the
 * Whisper-CPU cost lever; this one bounds ROW/JOB volume, which a tiny-file
 * flood would otherwise grow without meaningfully spending bytes. Checked in
 * the same advisory-locked SELECT as the bytes cap, BEFORE any write.
 */
export class AudioDailyCountCapError extends AppError {
  public constructor(cap: number, usedToday: number) {
    super(
      429,
      'rate_limited',
      `daily audio-upload limit reached (${usedToday} of ${cap} uploads today). Try again tomorrow.`,
    );
    this.name = 'AudioDailyCountCapError';
  }
}
