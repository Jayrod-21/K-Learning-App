/**
 * /audio routes — Track A, A-3: the server-side audio upload path. Stores an
 * owned audio blob (audioStore) and ENQUEUES a transcription job for the A-2
 * km-worker (tools/audio_stt — polls `audio_transcription_jobs` WHERE
 * status='pending' FOR UPDATE SKIP LOCKED, runs Whisper, settles the row and
 * writes `audio_transcript_segments`). This phase is server-only: NO client
 * UI and NO streaming/Listen wiring (both A-4).
 *
 * Flow:
 *   POST /audio   → upload one mp3/m4a (multipart `file` + optional `title`):
 *                   sniff + size cap, then ONE transaction = daily-bytes cap
 *                   (advisory-locked) → audio_sources row → blob write →
 *                   audio_tracks row → audio_transcription_jobs row. 201 with
 *                   { sourceId, trackId, jobId, transcriptStatus }.
 *   GET  /audio   → the caller's own audio sources (newest first, bounded to
 *                   the most recent 50 — the repo's GET-listing precedent;
 *                   A-4 can add real pagination), each with its tracks'
 *                   transcript_status (the progress-polling surface A-4's
 *                   Listen UI will read). The raw audio_sources.status column
 *                   is deliberately NOT exposed: nothing settles it after
 *                   enqueue (the A-2 worker settles the JOB and the tracks'
 *                   transcript_status, never the source row), so it would pin
 *                   to 'processing' forever — per-track transcript_status is
 *                   the truthful progress signal.
 *
 * MODEL — one source per upload: each user upload creates its OWN
 * audio_sources row (kind='standalone_listening', source_upload_id NULL — the
 * migration-073 kind↔link CHECK requires NULL for non-paired kinds) holding a
 * single track_number=1 track. Multi-track sets and paired_reader sets are
 * the OFFLINE loader's shape (A-2's corpus path); the upload surface stays
 * one-file-one-set, which keeps the route free of "which set do I append to"
 * state. The slug is server-derived ('upload-' + a fresh UUID) so the
 * UNIQUE(user_id, slug) key can never collide.
 *
 * SECURITY (mirrors routes/uploads.ts + services/bookUploadIngest.ts —
 * reused reasoning, restated for this surface):
 *   - UPLOAD: multer MEMORY storage, single `file` field, config-driven size
 *     cap (AUDIO_UPLOAD_MAX_BYTES → 413), declared-mime fileFilter as an
 *     early reject, magic-byte sniff (ID3 / MPEG frame sync for mp3; ftyp
 *     box + audio brand for m4a) as the AUTHORITY — a `.mp3`-named text/PNG
 *     payload is rejected by CONTENT (400), never accepted by name.
 *   - PATH TRAVERSAL: the blob path is `{sessionUserId}/{serverUUID}.{sniffed
 *     ext}` (audioStore.saveBlob) — no client string (filename included) ever
 *     enters a filesystem path; every later read resolves under the
 *     configured root or is rejected (audioStore.resolveUnderRoot).
 *   - COST/ABUSE (DoS + Whisper-CPU control): THREE caps. Per FILE:
 *     AUDIO_UPLOAD_MAX_BYTES (413, enforced by multer before buffering past
 *     it). Per USER PER DAY, both from ONE advisory-locked SELECT over
 *     TODAY's audio_transcription_jobs (two concurrent uploads for one user
 *     serialize on a per-user pg_advisory_xact_lock rather than both reading
 *     the pre-spend totals under READ COMMITTED — uploadExtract.ts's exact
 *     pattern), rejecting 429 BEFORE any row or blob is written:
 *     AUDIO_TRANSCRIBE_DAILY_BYTES_CAP (SUM of charged_bytes — every enqueued
 *     byte is a Whisper-CPU commitment) and AUDIO_UPLOAD_DAILY_COUNT_CAP
 *     (COUNT of jobs — a tiny-file flood would otherwise grow rows/blobs/
 *     pending worker jobs without denting the bytes budget; the book route's
 *     BOOK_UPLOAD_DAILY_CAP posture). The ledger survives track deletion
 *     (076: track_id SET NULL, cap sums by user_id alone), so
 *     upload→delete→re-upload can never reset either budget.
 *   - IDOR: every read is scoped WHERE user_id = getUserId(req) — another
 *     user's rows are simply absent from GET /audio, never distinguishable.
 *   - MASS ASSIGNMENT: `title` is the only writable body field, validated by
 *     a `.strict()` Zod schema — an extra field is REJECTED, not ignored.
 *     kind/status/slug/source_upload_id are server-assigned constants.
 *   - AUTH: `router.use(requireAuth)` — no anonymous surface at all.
 *   - ATOMICITY: cap check → audio_sources INSERT → blob write → audio_tracks
 *     INSERT → job INSERT, all inside ONE transaction, blob-before-its-row
 *     (bookUploadIngest.persistUpload's ordering): a DB failure after the
 *     blob write can only orphan a FILE (harmless — and we best-effort unlink
 *     it on rollback below, so not even that in practice), never commit a row
 *     pointing at a missing file; a blob-write failure aborts the transaction
 *     so the source row never commits. There is no partial state in which a
 *     track exists without its job or its bytes.
 */
import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter, expensiveLimiter } from '../middleware/rateLimits.js';
import { validateBody } from '../middleware/validate.js';
import { query, withTransaction } from '../db/pool.js';
import { ValidationError } from '../middleware/errors.js';
import { loadConfig } from '../config/index.js';
import { deleteBlob, saveBlob } from '../services/audioStore.js';
import {
  AudioDailyCapError,
  AudioDailyCountCapError,
  extForAudioKind,
  multerAudioUpload,
  sniffAudioKind,
  type AudioMimeRejection,
} from '../services/audioUploadIngest.js';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * The one optional multipart TEXT field alongside the `file` part. `.strict()`
 * rejects any extra field (mass-assignment defense — a client cannot smuggle
 * `status`/`kind`/`slug`/`user_id` onto the rows). Bounded to the DB CHECKs
 * (073/074: title length BETWEEN 1 AND 500).
 */
const AudioUploadBodySchema = z
  .object({
    title: z.string().trim().min(1, 'title must not be blank').max(500).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Row types + projections
// ---------------------------------------------------------------------------

/** GET /audio's joined projection — one row per (source, track) pair; tracks
 *  NULL for a (corpus edge case) trackless source. pg returns BIGINTs as
 *  strings; Number() at the DTO boundary (ids are IDENTITY values well inside
 *  Number.MAX_SAFE_INTEGER). */
interface SourceTrackRow {
  source_id: string;
  slug: string;
  title: string;
  kind: 'paired_reader' | 'standalone_listening' | 'topik';
  source_created_at: Date;
  track_id: string | null;
  track_number: number | null;
  track_title: string | null;
  byte_size: string | null;
  duration_ms: number | null;
  transcript_status: 'pending' | 'running' | 'done' | 'failed' | null;
}

interface AudioTrackDTO {
  id: number;
  track_number: number;
  title: string | null;
  byte_size: number;
  duration_ms: number | null;
  transcript_status: 'pending' | 'running' | 'done' | 'failed';
}

/** NOTE: no source-level `status` field — the raw audio_sources.status column
 *  pins to 'processing' for uploads (nothing settles it after enqueue; the
 *  worker settles jobs + per-track transcript_status), so exposing it would
 *  ship a value that is always wrong. Clients derive any set-level rollup they
 *  need from `tracks[].transcript_status` (the truthful signal). */
interface AudioSourceDTO {
  id: number;
  slug: string;
  title: string;
  kind: 'paired_reader' | 'standalone_listening' | 'topik';
  created_at: string;
  tracks: AudioTrackDTO[];
}

// ---------------------------------------------------------------------------
// POST /audio — upload one audio file + enqueue its transcription job.
// ---------------------------------------------------------------------------

router.post(
  '/',
  expensiveLimiter(),
  multerAudioUpload,
  validateBody(AudioUploadBodySchema),
  async (req, res, next) => {
    // Written blob's relative path, captured OUTSIDE the transaction closure
    // so the catch below can best-effort unlink it if the transaction that
    // wrote it rolls back after the write (never leave an orphan blob).
    let writtenBlobRef: string | null = null;
    try {
      const userId = getUserId(req);
      const file = (req as Request & { file?: Express.Multer.File }).file;
      const body = (req as Request & { body: z.infer<typeof AudioUploadBodySchema> }).body;
      const cfg = loadConfig();

      // 1. File present + non-empty + magic-byte verified (the authority —
      //    the declared mime only got it past the fileFilter's early reject).
      //    A fileFilter DROP (disallowed declared mime) also lands here with
      //    no req.file — name that reason instead of the misleading "file is
      //    required" (the filter stamped the rejected mime on the request).
      if (!file || file.buffer.length === 0) {
        const rejectedMime = (req as Request & AudioMimeRejection).audioRejectedMime;
        throw new ValidationError(
          rejectedMime !== undefined
            ? `declared Content-Type "${rejectedMime}" is not an accepted audio type — ` +
              'expected an mp3/m4a mime (e.g. audio/mpeg, audio/mp4)'
            : 'an mp3 or m4a audio file is required in the "file" field',
        );
      }
      const kind = sniffAudioKind(file.buffer);
      if (kind === null) {
        throw new ValidationError(
          'uploaded file is not recognizable audio — expected mp3 (ID3 tag or MPEG ' +
            'frame sync) or m4a (ftyp box with an audio brand)',
        );
      }
      const fileBytes = file.buffer.length;

      // Display title: the validated body field, else a server-side fallback.
      // NEVER the client filename — a filename is untrusted display-adjacent
      // input we have no need for (the body field is the sanctioned channel).
      const title = body.title ?? `Audio upload ${new Date().toISOString().slice(0, 10)}`;

      // 2. ONE transaction: cap → source → blob → track → job (see header
      //    "ATOMICITY" for why the blob write sits between its parent's and
      //    its own row's INSERTs).
      const created = await withTransaction(async (client) => {
        // 2a. Per-user daily caps (bytes + upload count), BEFORE any write.
        //     Advisory xact lock: two concurrent uploads by one user would
        //     otherwise both read the pre-spend totals under READ COMMITTED
        //     and both pass a cap only one fits under (uploadExtract.ts's
        //     exact reasoning; hashtextextended namespaces the key, the
        //     single BIGINT form avoids int4 truncation). Released at
        //     commit/rollback.
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('audio_transcribe_daily_cap:' || $1::text, 0))`,
          [userId],
        );
        // ONE query, both totals, under the same lock (no second read that
        // could race): SUM of charged_bytes + COUNT of jobs over ALL of
        // today's jobs (failed included — cost control; a failed run spent
        // CPU too), by user_id alone — rows whose track was deleted
        // (track_id SET NULL, migration 076) still count, so
        // upload→delete→re-upload can never reset either budget.
        const cap = await client.query<{ used_bytes: string; used_count: string }>(
          `SELECT COALESCE(SUM(charged_bytes), 0)::text AS used_bytes,
                  count(*)::text                        AS used_count
             FROM audio_transcription_jobs
            WHERE user_id = $1
              AND created_at >= date_trunc('day', now())`,
          [userId],
        );
        // BIGINT SUM/COUNT arrive as strings; Number() is exact while the
        // ledger stays under 2^53 (~9 PB/day of bytes) — far beyond any real
        // cap value.
        const usedToday = Number(cap.rows[0]?.used_bytes ?? '0');
        const countToday = Number(cap.rows[0]?.used_count ?? '0');
        // COUNT cap first (the coarser bound): a tiny-file flood would grow
        // rows/blobs/pending worker jobs while barely denting the bytes cap.
        if (countToday >= cfg.AUDIO_UPLOAD_DAILY_COUNT_CAP) {
          req.log.warn(
            { userId, countToday, cap: cfg.AUDIO_UPLOAD_DAILY_COUNT_CAP },
            'audio: daily upload-count cap hit — upload refused before any write',
          );
          throw new AudioDailyCountCapError(cfg.AUDIO_UPLOAD_DAILY_COUNT_CAP, countToday);
        }
        if (usedToday + fileBytes > cfg.AUDIO_TRANSCRIBE_DAILY_BYTES_CAP) {
          req.log.warn(
            {
              userId,
              usedToday,
              fileBytes,
              cap: cfg.AUDIO_TRANSCRIBE_DAILY_BYTES_CAP,
            },
            'audio: daily transcription-bytes cap hit — upload refused before any write',
          );
          throw new AudioDailyCapError(cfg.AUDIO_TRANSCRIBE_DAILY_BYTES_CAP, usedToday, fileBytes);
        }

        // 2b. The set row — one per upload (see header "MODEL"). The slug is
        //     server-derived from a fresh UUID, so UNIQUE(user_id, slug) can
        //     never collide; kind/status/source_upload_id are constants
        //     (source_upload_id NULL satisfies 073's kind↔link CHECK for
        //     'standalone_listening'). status='processing' until the worker's
        //     transcription settles (the A-4 surface flips its display off
        //     the tracks' transcript_status either way).
        const src = await client.query<{ id: string }>(
          `INSERT INTO audio_sources (user_id, slug, title, kind, source_upload_id, status)
           VALUES ($1, $2, $3, 'standalone_listening', NULL, 'processing')
           RETURNING id`,
          [userId, `upload-${randomUUID()}`, title],
        );
        const sourceId = src.rows[0]!.id;

        // 2c. The blob — written INSIDE the tx boundary, before its row
        //     (persistUpload's ordering): a failure from here on can only
        //     orphan a FILE (cleaned up best-effort in the catch below),
        //     never commit a row pointing at missing bytes. The path is built
        //     entirely from server-trusted values.
        writtenBlobRef = await saveBlob(userId, randomUUID(), extForAudioKind(kind), file.buffer);

        // 2d. The track. user_id is denormalized from the session (the same
        //     value that owns the source row two statements up — 074's
        //     composite (source_id, user_id) FK structurally rejects any
        //     drift). byte_size > 0 is guaranteed by the non-empty check.
        const trk = await client.query<{ id: string }>(
          `INSERT INTO audio_tracks
             (source_id, user_id, track_number, title, blob_ref, byte_size, transcript_status)
           VALUES ($1, $2, 1, $3, $4, $5, 'pending')
           RETURNING id`,
          [sourceId, userId, title, writtenBlobRef, fileBytes],
        );
        const trackId = trk.rows[0]!.id;

        // 2e. The enqueue — the row the km-worker claims. charged_bytes is
        //     the cap ledger's cost snapshot (mirrors 069's pages_requested);
        //     it equals the track's byte_size at enqueue and is never
        //     recomputed. The one-live-job-per-track partial unique
        //     (uq_audio_transcription_jobs_track_live) cannot fire here: the
        //     track was created in THIS transaction, so no other live job for
        //     it can exist.
        const job = await client.query<{ id: string }>(
          `INSERT INTO audio_transcription_jobs (track_id, user_id, status, charged_bytes)
           VALUES ($1, $2, 'pending', $3)
           RETURNING id`,
          [trackId, userId, fileBytes],
        );
        return { sourceId, trackId, jobId: job.rows[0]!.id };
      });

      // The transaction COMMITTED: committed rows now reference the blob, so
      // it must never be unlinked. Null the cleanup ref BEFORE the response
      // write — if res.json (or any future post-commit step in this try)
      // throws, the catch below must not delete a blob that
      // audio_tracks.blob_ref points at (that would recreate exactly the
      // dangling-row state the write ordering exists to prevent).
      writtenBlobRef = null;

      res.status(201).json({
        sourceId: Number(created.sourceId),
        trackId: Number(created.trackId),
        jobId: Number(created.jobId),
        transcriptStatus: 'pending',
      });
    } catch (err) {
      // Rollback cleanup: if the blob hit disk but the transaction failed
      // afterwards, unlink it best-effort — a leftover orphan would be
      // harmless (no row references it) but there is no reason to keep it.
      // Best-effort only: a cleanup failure must never mask the real error.
      if (writtenBlobRef !== null) {
        try {
          await deleteBlob(writtenBlobRef);
        } catch (cleanupErr) {
          req.log.warn(
            { err: String(cleanupErr), blobRef: writtenBlobRef },
            'audio: failed to delete blob after rolled-back upload (orphaned, non-fatal)',
          );
        }
      }
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /audio — the caller's own audio sources + per-track transcript status.
// ---------------------------------------------------------------------------

/** Bound on GET /audio's source listing — the repo's GET-listing precedent
 *  (GET /uploads/:id/extract caps at 50): the polling surface wants recent
 *  history, not an unbounded scroll, and without a bound a flood of uploads
 *  turns this join + in-memory grouping into an amplifier. A-4 can add real
 *  pagination (cursor/offset) when the Listen UI needs deeper history. */
const GET_SOURCES_LIMIT = 50;

router.get('/', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    // One user-scoped join, sources newest first, tracks in play order. The
    // LIMIT is applied to SOURCES (inner subquery) before the track join —
    // a LIMIT on the joined rows would truncate a source's track list. LEFT
    // JOIN so a (corpus edge case) trackless source still lists. The scoping
    // is on audio_sources.user_id — audio_tracks.user_id is pinned equal by
    // 074's composite FK, so no second predicate is needed; another user's
    // rows are simply absent (IDOR-safe: nothing here confirms existence).
    // audio_sources.status is deliberately not selected (see AudioSourceDTO).
    const { rows } = await query<SourceTrackRow>(
      `SELECT s.id          AS source_id,
              s.slug,
              s.title,
              s.kind,
              s.created_at  AS source_created_at,
              t.id          AS track_id,
              t.track_number,
              t.title       AS track_title,
              t.byte_size,
              t.duration_ms,
              t.transcript_status
         FROM (SELECT id, slug, title, kind, created_at
                 FROM audio_sources
                WHERE user_id = $1
                ORDER BY created_at DESC, id DESC
                LIMIT $2) s
         LEFT JOIN audio_tracks t ON t.source_id = s.id
        ORDER BY s.created_at DESC, s.id DESC, t.track_number ASC`,
      [userId, GET_SOURCES_LIMIT],
    );

    // Group the flat join into source DTOs (rows arrive source-contiguous
    // because the ORDER BY leads with the source sort keys).
    const sources: AudioSourceDTO[] = [];
    let current: AudioSourceDTO | null = null;
    for (const row of rows) {
      if (current === null || current.id !== Number(row.source_id)) {
        current = {
          id: Number(row.source_id),
          slug: row.slug,
          title: row.title,
          kind: row.kind,
          created_at: row.source_created_at.toISOString(),
          tracks: [],
        };
        sources.push(current);
      }
      if (row.track_id !== null) {
        current.tracks.push({
          id: Number(row.track_id),
          track_number: row.track_number!,
          title: row.track_title,
          byte_size: Number(row.byte_size),
          duration_ms: row.duration_ms,
          transcript_status: row.transcript_status!,
        });
      }
    }

    res.status(200).json({ sources });
  } catch (err) {
    next(err);
  }
});

export default router;
