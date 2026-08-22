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
 *   GET  /audio   → the caller's own PRIVATE audio sources (newest first,
 *                   bounded to the most recent 50 — the repo's GET-listing
 *                   precedent; A-4 can add real pagination), each with its
 *                   tracks' transcript_status (the progress-polling surface
 *                   A-4's Listen UI will read). Shared sets are excluded
 *                   (is_shared = false) — a set the operator has flagged into
 *                   the curated corpus moves to GET /audio/shared, even for
 *                   its owner (F-207 decision #2: "My Audio" = private
 *                   uploads only). The raw audio_sources.status column
 *                   is deliberately NOT exposed: nothing settles it after
 *                   enqueue (the A-2 worker settles the JOB and the tracks'
 *                   transcript_status, never the source row), so it would pin
 *                   to 'processing' forever — per-track transcript_status is
 *                   the truthful progress signal.
 *
 * F-207 phase 1 (shared curated corpus — READ access only):
 *   GET /audio/shared → the curated shared sets (audio_sources.is_shared =
 *                   true), NON-user-scoped by design: every authenticated
 *                   account sees the same curated list (the Listen tiles'
 *                   data source). Same DTO shape as GET /audio, and — load
 *                   bearing — NO owner identity in it: no user_id, no email,
 *                   nothing that says whose rows these are (they are served
 *                   cross-account). is_shared is OPERATOR-SET ONLY (the
 *                   phase-2 cutover script); no route writes it, so a user
 *                   can neither share their own arbitrary content nor
 *                   un-share/steal someone else's.
 *                   The track read routes below widen the same way: a track
 *                   is readable/streamable when the caller OWNS it OR its
 *                   SOURCE is shared. Every MUTATION stays owner-only —
 *                   sharing is a read-access flag, never a transfer of
 *                   control.
 *
 * A-4a (the Listen playback surface — server side only, client is A-4b):
 *   GET /audio/tracks/:id         → one readable (owned or shared-source,
 *                   F-207) track + its ORDERED transcript
 *                   segments: { track: { id, title, transcriptStatus,
 *                   durationMs, streamUrl }, segments: [{ segmentNumber,
 *                   startMs, endMs, body }] }. `streamUrl` is the
 *                   app-relative sibling stream path (the client hands it to
 *                   an <audio> tag; the session cookie rides same-origin).
 *                   A not-yet-transcribed track returns segments: [] — a
 *                   normal state, never an error.
 *   GET /audio/tracks/:id/stream  → the track's audio bytes, Range-capable
 *                   (RFC 9110 single range: 206/Content-Range/Accept-Ranges,
 *                   416 unsatisfiable, malformed → full 200) via the shared
 *                   services/rangeStream.ts streamer (extracted from
 *                   ttmik.ts's corpus streamer so the two can't drift).
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
 *   - IDOR: every read is scoped WHERE user_id = getUserId(req), widened
 *     ONLY by `OR audio_sources.is_shared = true` (F-207 — the operator-set
 *     curated-corpus flag). A private row of another user is simply absent
 *     from every response, never distinguishable from a nonexistent one; a
 *     SHARED row is deliberately readable by every account and its reads
 *     carry no owner identity. Every WRITE keeps the strict owner scope.
 *   - MASS ASSIGNMENT: `title` is the only writable body field, validated by
 *     a `.strict()` Zod schema — an extra field is REJECTED, not ignored.
 *     kind/status/slug/source_upload_id are server-assigned constants.
 *   - AUTH: `router.use(requireAuth)` — no anonymous surface at all.
 *   - STREAMING (A-4a, mirrors routes/uploads.ts GET /uploads/:id/page/:n):
 *     the track probe is WHERE id = $1 AND user_id = $2 (no join —
 *     migration 074's composite FK structurally pins the denormalized
 *     user_id, so a drifted row can't exist); a miss for ANY reason (no such
 *     track / another user's track / poisoned blob_ref / blob file gone) is
 *     a UNIFORM 404 that never confirms existence. blob_ref resolves through
 *     audioStore.resolveUnderRoot (traversal-checked under
 *     AUDIO_UPLOAD_STORAGE_DIR — never a hand-rolled join). Content-Type is
 *     derived from the SERVER-written blob_ref extension (saveBlob's sniffed
 *     ext — never a client string) and X-Content-Type-Options: nosniff is
 *     set so the browser can never re-sniff the bytes (A-3's m4a sniff
 *     accepts generic MP4 brands, so an uploaded video-ish MP4 must be
 *     locked to its declared audio type, not sniffed into a playable
 *     document).
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
import { stat } from 'node:fs/promises';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter, expensiveLimiter, mediaLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { query, withTransaction } from '../db/pool.js';
import { NotFoundError, ValidationError } from '../middleware/errors.js';
import { loadConfig } from '../config/index.js';
import { deleteBlob, resolveUnderRoot, saveBlob } from '../services/audioStore.js';
import { streamFileWithRange } from '../services/rangeStream.js';
import { sweepAudioTranscriptionJobs } from '../services/jobRetention.js';
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

/** IDs are BIGINT IDENTITY values but always well inside Number.MAX_SAFE_INTEGER
 *  (routes/uploads.ts's exact stance). */
const MAX_ID = Number.MAX_SAFE_INTEGER;

/** Path params for the /tracks/:id routes — coerced positive int, anything
 *  else (text, 0, negative, fractional, overflow) → 400 before any query. */
const TrackParamsSchema = z.object({
  id: z.coerce.number().int().positive().max(MAX_ID),
});

// ---------------------------------------------------------------------------
// Row types + projections
// ---------------------------------------------------------------------------

/** GET /audio's joined projection — one row per (source, track) pair; tracks
 *  NULL for a (corpus edge case) trackless source. The int8 parser (db/pool)
 *  returns IDENTITY ids as numbers; byte_size is a genuinely-large int8 count
 *  so it keeps the defensive number|string (safe-integer guard may return a
 *  string), normalized by Number() at the DTO boundary. */
interface SourceTrackRow {
  source_id: number;
  slug: string;
  title: string;
  kind: 'paired_reader' | 'standalone_listening' | 'topik';
  source_created_at: Date;
  track_id: number | null;
  track_number: number | null;
  track_title: string | null;
  byte_size: number | string | null;
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
        // SUM/COUNT arrive as strings because of the ::text casts above (the
        // int8 parser never sees them); Number() is exact while the ledger
        // stays under 2^53 (~9 PB/day of bytes) — far beyond any real cap
        // value.
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
        const src = await client.query<{ id: number }>(
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
        const trk = await client.query<{ id: number }>(
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
        const job = await client.query<{ id: number }>(
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
// GET /audio — the caller's own PRIVATE audio sources + per-track transcript
// status. GET /audio/shared — the curated shared sets (F-207).
// ---------------------------------------------------------------------------

/** Bound on the source listings — the repo's GET-listing precedent
 *  (GET /uploads/:id/extract caps at 50): the polling surface wants recent
 *  history, not an unbounded scroll, and without a bound a flood of uploads
 *  turns this join + in-memory grouping into an amplifier. A-4 can add real
 *  pagination (cursor/offset) when the Listen UI needs deeper history. The
 *  same bound caps /shared (the curated corpus is ~21 sets — the cap is
 *  headroom, not a pagination stand-in). */
const GET_SOURCES_LIMIT = 50;

/** Group the flat (source × track) join into source DTOs. Rows MUST arrive
 *  source-contiguous (the callers' ORDER BY leads with the source sort
 *  keys). Shared by GET /audio and GET /audio/shared — one grouping, one
 *  DTO shape, so the two listings cannot drift (and neither can leak a
 *  column the projection doesn't carry: SourceTrackRow has no user_id/email,
 *  so no owner identity can reach either response). */
function groupSourceRows(rows: SourceTrackRow[]): AudioSourceDTO[] {
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
  return sources;
}

/** The shared shape of both listing queries — everything except the inner
 *  subquery's WHERE + parameter slots, which is exactly where the two
 *  listings differ (owner-private vs curated-shared). Both arguments are
 *  SERVER-SIDE STRING CONSTANTS (see the two call sites) — no request data
 *  ever reaches this interpolation; row values still bind via $n. */
function sourceListingSql(where: string, limitPlaceholder: string): string {
  return `
  SELECT s.id          AS source_id,
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
           WHERE ${where}
           ORDER BY created_at DESC, id DESC
           LIMIT ${limitPlaceholder}) s
    LEFT JOIN audio_tracks t ON t.source_id = s.id
   ORDER BY s.created_at DESC, s.id DESC, t.track_number ASC`;
}

router.get('/', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    // Retention (audit §1.4): sweep this user's stale terminal transcription
    // jobs before listing. Best-effort and user-scoped — the "My Audio" read
    // is the natural sweep trigger (no cron in this repo); a failure here is
    // logged and swallowed inside the service, so it never fails the listing.
    await sweepAudioTranscriptionJobs(userId, req.log);
    // One user-scoped join, sources newest first, tracks in play order. The
    // LIMIT is applied to SOURCES (inner subquery) before the track join —
    // a LIMIT on the joined rows would truncate a source's track list. LEFT
    // JOIN so a (corpus edge case) trackless source still lists. The scoping
    // is on audio_sources.user_id — audio_tracks.user_id is pinned equal by
    // 074's composite FK, so no second predicate is needed; another user's
    // rows are simply absent (IDOR-safe: nothing here confirms existence).
    // AND is_shared = false (F-207 decision #2): a set the operator flagged
    // into the curated corpus leaves "My Audio" — even for its owner — and
    // lists on /audio/shared instead; this listing is private uploads only.
    // audio_sources.status is deliberately not selected (see AudioSourceDTO).
    const { rows } = await query<SourceTrackRow>(
      sourceListingSql('user_id = $1 AND is_shared = false', '$2'),
      [userId, GET_SOURCES_LIMIT],
    );
    res.status(200).json({ sources: groupSourceRows(rows) });
  } catch (err) {
    next(err);
  }
});

// Registered as a LITERAL path. This router has no sibling `/:id` route
// today, so nothing can shadow it — but keep it declared ABOVE the
// `/tracks/:id*` routes (and above any future `/:id`) so Express's
// first-match ordering can never turn "shared" into a param value.
router.get('/shared', cheapLimiter(), async (_req, res, next) => {
  try {
    // F-207: the curated shared listing. DELIBERATELY NON-user-scoped —
    // every authenticated account (router.use(requireAuth) above) gets the
    // same curated sets; is_shared = true is the entire filter, so a private
    // row (any owner's) can never appear here. The projection is the SAME
    // SourceTrackRow as GET /audio: no user_id, no email — these are another
    // account's rows served cross-account, and the owner's identity is not
    // the client's business (no-owner-PII is asserted by the route tests).
    const { rows } = await query<SourceTrackRow>(
      sourceListingSql('is_shared = true', '$1'),
      [GET_SOURCES_LIMIT],
    );
    res.status(200).json({ sources: groupSourceRows(rows) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /audio/tracks/:id/stream — the track's audio bytes (owned or
// shared-source per F-207, Range-capable). A-4b's <audio> element points here.
// ---------------------------------------------------------------------------

/**
 * Content-Type from the SERVER-written blob_ref extension. saveBlob writes
 * exactly `{userId}/{uuid}.{mp3|m4a}` from the SNIFFED mime (never a client
 * string), so the extension is server-controlled; the octet-stream fallback
 * is defense in depth for an impossible row, chosen because it is the one
 * type a browser will never interpret (mirrors uploads.ts's mimeForBlobRef).
 */
function mimeForAudioBlobRef(blobRef: string): string {
  const lower = blobRef.toLowerCase();
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  return 'application/octet-stream';
}

/** True when the error is a filesystem "no such file" error. */
function isEnoent(err: unknown): boolean {
  return err !== null && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT';
}

router.get(
  '/tracks/:id/stream',
  mediaLimiter(),
  validateParams(TrackParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = (req as Request & { validatedParams: z.infer<typeof TrackParamsSchema> })
        .validatedParams;

      // IDOR guard, widened for F-207: a track streams when the caller OWNS
      // it OR its SOURCE is in the shared curated corpus. is_shared lives on
      // audio_sources, so the probe joins the parent set (source_id is NOT
      // NULL + composite-FK-pinned, 074 — the join can neither miss nor
      // cross owners; the owner arm still rides the denormalized
      // audio_tracks.user_id exactly as before). READ-ONLY widening: a miss
      // (no such track OR another user's PRIVATE track) stays a uniform
      // 404 — never confirm a foreign track exists.
      const { rows } = await query<{ blob_ref: string }>(
        `SELECT t.blob_ref
           FROM audio_tracks t
           JOIN audio_sources s ON s.id = t.source_id
          WHERE t.id = $1
            AND (t.user_id = $2 OR s.is_shared = true)`,
        [id, userId],
      );
      const row = rows[0];
      if (!row) {
        throw new NotFoundError('track not found');
      }

      let absPath: string;
      try {
        absPath = resolveUnderRoot(row.blob_ref);
      } catch {
        // A poisoned/corrupt blob_ref (defense in depth — saveBlob only ever
        // writes safe relative paths). Uniform 404, never confirm what the
        // traversal attempt would have hit; log the true reason server-side.
        req.log.warn({ trackId: id }, 'audio: blob_ref failed root resolution — served 404');
        throw new NotFoundError('track audio not found');
      }

      let size: number;
      try {
        size = (await stat(absPath)).size;
      } catch (err) {
        // Row exists but the bytes are gone (e.g. a partial restore) — 404,
        // not 500 (uploads.ts's page-stream posture).
        if (isEnoent(err)) {
          throw new NotFoundError('track audio not found');
        }
        throw err;
      }

      // Range mechanics live in the shared streamer (also used by the ttmik
      // corpus routes). Content-Type comes from the server-written extension;
      // the streamer always sets X-Content-Type-Options: nosniff (required
      // here — A-3's m4a sniff admits generic MP4 brands, so the browser
      // must never re-sniff these bytes into anything but audio). Uploaded
      // blobs are immutable (a blob_ref is written once, never replaced), so
      // a day of private caching is safe (ttmik's corpus policy).
      streamFileWithRange(req, res, next, absPath, size, {
        contentType: mimeForAudioBlobRef(row.blob_ref),
        cacheControl: 'private, max-age=86400',
        logContext: 'audio track',
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /audio/tracks/:id — one readable (owned or shared-source, F-207) track
// + its ordered transcript segments (the Listen UI's transcript render;
// mirrors reading.ts's GET /reading/chapters/:chapterId
// detail-with-children shape).
// ---------------------------------------------------------------------------

/** A transcript segment as served (BIGINT ids never leave the DB here — the
 *  segment's own id is an internal key the client has no use for; the
 *  [startMs, endMs] window is what drives the play-position highlight). */
interface SegmentDTO {
  segmentNumber: number;
  startMs: number;
  endMs: number;
  body: string;
}

router.get(
  '/tracks/:id',
  cheapLimiter(),
  validateParams(TrackParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = (req as Request & { validatedParams: z.infer<typeof TrackParamsSchema> })
        .validatedParams;

      // Access assert + the track's own fields, one probe — owned OR
      // shared-source, the same F-207 widening (and the same join
      // reasoning + uniform 404 on any miss) as the stream route above.
      const trackRes = await query<{
        title: string | null;
        duration_ms: number | null;
        transcript_status: 'pending' | 'running' | 'done' | 'failed';
      }>(
        `SELECT t.title, t.duration_ms, t.transcript_status
           FROM audio_tracks t
           JOIN audio_sources s ON s.id = t.source_id
          WHERE t.id = $1
            AND (t.user_id = $2 OR s.is_shared = true)`,
        [id, userId],
      );
      const track = trackRes.rows[0];
      if (!track) {
        throw new NotFoundError('track not found');
      }

      // Ordered segments. READ access (owned or shared) was just confirmed
      // and segments CASCADE from their track (075 — no user_id of their
      // own, always reached THROUGH the track), so scoping on track_id
      // alone is safe. A
      // not-yet-transcribed track simply has no rows → segments: [] — a
      // normal state the client polls through, never an error.
      const segRes = await query<{
        segment_number: number;
        start_ms: number;
        end_ms: number;
        body: string;
      }>(
        `SELECT segment_number, start_ms, end_ms, body
           FROM audio_transcript_segments
          WHERE track_id = $1
          ORDER BY segment_number`,
        [id],
      );
      const segments: SegmentDTO[] = segRes.rows.map((s) => ({
        segmentNumber: s.segment_number,
        startMs: s.start_ms,
        endMs: s.end_ms,
        body: s.body,
      }));

      res.status(200).json({
        track: {
          id,
          title: track.title,
          transcriptStatus: track.transcript_status,
          durationMs: track.duration_ms,
          // App-relative sibling stream path — A-4b hands it straight to an
          // <audio> element (same-origin, session cookie rides along).
          streamUrl: `/audio/tracks/${id}/stream`,
        },
        segments,
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
