/**
 * Book-ingest pipeline (Phase 2.5 — async book-upload OOM fix). THE runner
 * that turns a raw zip/PDF, already written to disk by `POST /uploads`, into
 * `book_pages` rows — mirroring `services/storyAudio.ts`'s in-process runner
 * shape exactly: unref'd poll interval, `FOR UPDATE SKIP LOCKED` claim in a
 * short tx, heavy work OUTSIDE any tx, status-guarded settle, stale-run reap,
 * blue/green gate.
 *
 * THE OOM THIS FIXES (RECON.md): `POST /uploads` used to decode an entire
 * book SYNCHRONOUSLY in the request — every page (up to 2 GiB of zip
 * entries, or up to 2000 rendered PDF pages) resident in one array together,
 * on top of the raw upload already buffered in heap. km-server's 1 GiB
 * cgroup limit OOM-killed the whole process. This runner is the other half
 * of the fix (the route half is `routes/uploads.ts` + `bookUploadIngest.ts`):
 *
 *   BOUNDED MEMORY — the runner NEVER accumulates all of a book's pages in
 *   memory. It drives `zipPageExtract.ts`'s `streamZipImageEntriesFromFile`
 *   or `pdfPageRender.ts`'s `streamPdfPagesToJpegFromFile` — both async
 *   generators that yield ONE page at a time, reading straight off the raw
 *   file on disk (never loading the whole raw archive into a Buffer either,
 *   see those modules' headers) — and for EACH yielded page: write its blob
 *   (`uploadStore.saveBlob`), insert its `book_pages` row, then let the
 *   buffer go out of scope before pulling the next page. At any instant, at
 *   most one page's decompressed bytes are alive.
 *
 * PIPELINE (one tick, one upload):
 *   reap (time-based, every color) → blue/green gate → claim (short tx:
 *   pending → processing) → sniff the raw file's real kind (magic bytes, not
 *   a stored column — never drifts from the actual bytes) → clear any
 *   existing book_pages ROWS AND BLOB FILES for this upload (idempotency,
 *   see below) → stream pages, persisting each one as it's yielded →
 *   settle 'ready' (page_count, finished_at, raw_blob_ref cleared) + delete
 *   the raw file; ANY failure anywhere in that sequence → settle 'failed'
 *   (bounded error message, finished_at) + clear any partial book_pages
 *   (rows AND blob files) + delete the raw file.
 *
 * IDEMPOTENCY ON RE-RUN (a stale-reaped 'processing' row later reclaimed, OR
 * a same-title replace reset to 'pending' — see routes/uploads.ts): the
 * runner ALWAYS runs `clearPagesAndBlobs` (`DELETE FROM book_pages WHERE
 * upload_id = $1 RETURNING blob_ref`, then best-effort unlinks each returned
 * blob file) immediately after claim, BEFORE decoding a single page. This is
 * the ONE mechanism that makes every re-run safe — a crashed run's partial
 * page set (or a replaced book's OLD page set), rows AND files, is wiped
 * before the fresh decode begins, so re-decoding can never DUPLICATE
 * `book_pages` rows (no per-page upsert/dedup logic needed anywhere else)
 * NOR leak the prior run's page-image files to disk. The same helper backs
 * the stale-reap clear and the settle-race no-op clear below, so all three
 * "discard this upload's current pages" sites share one correct
 * rows-and-files implementation. The trade-off: an upload that is reclaimed
 * mid-decode restarts from page 1 rather than resuming — acceptable for a
 * personal/duo-user app's book uploads (rare, and a full re-decode of even a
 * large book is seconds-to-low-minutes, not an expensive resource).
 *
 * SECURITY:
 *   - Every value written is server-derived: `user_id` comes from the claimed
 *     row (itself written by the route from the SESSION user, never client
 *     input); the raw file's path is resolved through `uploadStore.ts`'s
 *     `resolveUnderRoot` (the same traversal guard page blobs use); page blob
 *     paths come from `uploadStore.saveBlob` (server UUID, never client
 *     input); the settle `error` column is a bounded, server-authored message
 *     (`failureMessage`), never raw library/provider text.
 *   - Blue/green: only the ACTIVE color's runner claims+processes
 *     (`isRunnerActiveColor`) — the idle color's runner still reaps (time-
 *     based, harmless everywhere) but never claims 'pending' work with
 *     possibly-stale code. A book enqueued on one color and left mid-flight
 *     through a promotion is safely picked up (or reaped-then-retried) by
 *     whichever color is active — the DB and the km_book_uploads volume are
 *     shared across both.
 */
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import type { Logger } from 'pino';
import { isRunnerActiveColor, loadConfig } from '../config/index.js';
import { query, withTransaction } from '../db/pool.js';
import { ValidationError } from '../middleware/errors.js';
import {
  extForMime,
  readFileHead,
  sniffUploadKind,
  UPLOAD_HEAD_SNIFF_BYTES,
  type UploadKind,
} from './bookUploadIngest.js';
import { streamPdfPagesToJpegFromFile } from './pdfPageRender.js';
import { deleteBlob, resolveUnderRoot, saveBlob } from './uploadStore.js';
import { streamZipImageEntriesFromFile, type ExtractedPage } from './zipPageExtract.js';

/**
 * Persist ONE page's blob then insert its `book_pages` row, via a plain
 * pooled query — NOT `bookUploadIngest.ts`'s `persistOnePage`, which takes a
 * `PoolClient` bound to an OPEN transaction (right for the CLI's whole-book
 * `persistUpload`, wrong here: the runner deliberately holds NO transaction
 * open across a page-by-page decode that can run minutes — see this module's
 * header, "heavy work OUTSIDE any tx", storyAudio.ts's exact posture). A
 * crash between the blob write and this INSERT leaves at most an orphan
 * FILE, never a DB row pointing at missing bytes — same ordering guarantee
 * `persistOnePage` gives, just over a standalone connection instead of a
 * shared transaction client.
 */
async function persistOnePageDirect(
  userId: number,
  uploadId: number,
  pageNumber: number,
  page: ExtractedPage,
): Promise<void> {
  const blobRef = await saveBlob(userId, randomUUID(), extForMime(page.mime), page.buffer);
  await query(`INSERT INTO book_pages (upload_id, page_number, blob_ref) VALUES ($1, $2, $3)`, [
    uploadId,
    pageNumber,
    blobRef,
  ]);
}

/** Adapt `streamPdfPagesToJpegFromFile`'s bare-`Buffer` yields to the same
 *  `{ buffer, mime }` shape the zip stream yields, so the runner's decode
 *  loop below is kind-agnostic. Every PDF page is rendered as JPEG
 *  (pdftoppm's `-jpeg` flag) — see pdfPageRender.ts. */
async function* asExtractedPages(
  pages: AsyncGenerator<Buffer, void, void>,
): AsyncGenerator<ExtractedPage, void, void> {
  for await (const buffer of pages) {
    yield { buffer, mime: 'image/jpeg' };
  }
}

export type BookIngestTickResult = 'idle' | 'done' | 'failed';

interface ClaimedUpload {
  uploadId: number;
  userId: number;
  rawBlobRef: string;
}

/** Bounded, user-visible failure copy. `ValidationError`s raised by the
 *  streaming extractors (zip-bomb/PDF-bomb guards, corrupt archive, 0 usable
 *  pages) are OUR OWN authored, whitelisted messages (never provider/library
 *  text) — safe to show verbatim, exactly as the pre-Phase-2.5 synchronous
 *  route surfaced them as 400 bodies. Anything else (fs errors, a DB hiccup,
 *  an unexpected yauzl/pdftoppm throw) gets a generic line; the real detail
 *  stays in the server log via the caller's `log.error`. */
function failureMessage(err: unknown): string {
  if (err instanceof ValidationError) {
    return err.message.slice(0, 2000);
  }
  return 'book processing failed unexpectedly — try re-uploading the file';
}

/** Best-effort raw-file delete — a leftover raw file is harmless disk
 *  clutter (GC-able, never user-visible or security-relevant), so a delete
 *  failure here must never mask the real settle outcome. */
async function deleteRawFileBestEffort(
  rawBlobRef: string,
  uploadId: number,
  log: Logger,
): Promise<void> {
  try {
    await unlink(resolveUnderRoot(rawBlobRef));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return; // already gone — fine
    log.warn(
      { uploadId, rawBlobRef, err: String(err) },
      'bookIngestRunner: failed to delete raw upload file (orphaned, non-fatal)',
    );
  }
}

/**
 * Delete every `book_pages` row for `uploadId`, capturing each row's
 * `blob_ref` via `RETURNING` (atomic with the row delete — no separate
 * SELECT-then-DELETE window where a concurrent writer could see a
 * different set), then best-effort `deleteBlob()` each one AFTER the row
 * delete has committed. Mirrors `routes/uploads.ts`'s DELETE handler
 * (capture blob_ref, delete rows, unlink after commit) — the single shared
 * implementation for the three sites that need to clear a book's pages:
 * the pre-decode idempotency wipe, the stale-reap clear, and the
 * settle-race no-op clear (BUG FIX: previously these only deleted the DB
 * rows and never touched the blob files, permanently leaking every
 * replaced/reaped/raced decode's page images to disk).
 *
 * The ROW DELETE is authoritative and propagates any failure to the
 * caller — it is the caller's choice whether that's fatal (the
 * idempotency step, which must abort the run rather than decode on top of
 * stale state) or best-effort (`clearPagesBestEffort` below). Blob-file
 * unlinking is ALWAYS best-effort regardless: a missing/already-gone file
 * (`deleteBlob` already treats ENOENT as a no-op) is harmless disk
 * clutter, never a reason to fail a run or mask the real settle outcome.
 */
async function clearPagesAndBlobs(uploadId: number, log: Logger): Promise<void> {
  const { rows } = await query<{ blob_ref: string }>(
    `DELETE FROM book_pages WHERE upload_id = $1 RETURNING blob_ref`,
    [uploadId],
  );
  await Promise.all(
    rows.map(async (row) => {
      try {
        await deleteBlob(row.blob_ref);
      } catch (err) {
        log.warn(
          { uploadId, blobRef: row.blob_ref, err: String(err) },
          'bookIngestRunner: failed to delete page blob file (orphaned, non-fatal)',
        );
      }
    }),
  );
}

/** Clear any book_pages rows (+ their blob files, via `clearPagesAndBlobs`)
 *  for `uploadId` — best-effort at BOTH the row-delete and blob-unlink
 *  level. Used by the reap and settle-failed/settle-race paths: a failed
 *  row must never display a partial page set, but a cleanup failure here
 *  (row delete OR blob unlink) must never mask the real settle outcome —
 *  the row already carries (or is about to carry) a terminal status
 *  regardless. NOT used by the pre-decode idempotency step, which needs the
 *  row-delete failure to propagate — see `clearPagesAndBlobs`'s doc. */
async function clearPagesBestEffort(uploadId: number, log: Logger): Promise<void> {
  try {
    await clearPagesAndBlobs(uploadId, log);
  } catch (err) {
    log.warn(
      { uploadId, err: String(err) },
      'bookIngestRunner: failed to clear partial book_pages (non-fatal)',
    );
  }
}

/** Settle a 'processing' upload as failed. Status-guarded so a row already
 *  reaped/settled by a concurrent tick is never clobbered (the guard losing
 *  the race is fine — the row already carries a terminal state). Also clears
 *  any partial `book_pages` this run may have inserted before failing, and
 *  best-effort deletes the raw file (a failed ingest is not auto-retried —
 *  a retry is a fresh POST with a fresh raw file; see module header). */
async function settleFailed(
  uploadId: number,
  rawBlobRef: string,
  message: string,
  log: Logger,
): Promise<void> {
  const settled = await query(
    `UPDATE book_uploads
        SET status = 'failed', error = $2, finished_at = now(), raw_blob_ref = NULL
      WHERE id = $1 AND status = 'processing'`,
    [uploadId, message],
  );
  if ((settled.rowCount ?? 0) > 0) {
    await clearPagesBestEffort(uploadId, log);
    await deleteRawFileBestEffort(rawBlobRef, uploadId, log);
  }
}

/**
 * Run ONE runner tick: reap stale 'processing' rows, then (if this color is
 * active) claim and fully process at most one pending upload. Exported so
 * tests drive the pipeline deterministically (no timers involved).
 *
 * @returns 'idle' (no pending work, or this color isn't active), 'done' (an
 *          upload settled ready) or 'failed' (an upload settled failed).
 */
export async function runBookIngestTick(log: Logger): Promise<BookIngestTickResult> {
  const cfg = loadConfig();

  // 1. Reap: a 'processing' row older than the stale threshold is a crashed
  //    run (server restart/OOM mid-decode) that would otherwise brick that
  //    title forever (a same-title re-upload 409s while pending/processing —
  //    see routes/uploads.ts). ONLY 'processing' — 'pending' is the healthy
  //    backlog (storyAudio's exact reap contract). Any partial book_pages a
  //    crashed run left behind are cleared too (a 'failed' row must never
  //    display a partial page set) — RETURNING id + raw_blob_ref (this
  //    statement doesn't touch that column, so RETURNING reflects its
  //    unchanged pre-reap value) so we know which rows to clear, and which
  //    raw files to delete, without a second scan.
  //
  //    RAW-FILE CLEANUP (fix, mirrors settleFailed): a reaped row is a
  //    'failed' terminal state exactly like settleFailed's, and every OTHER
  //    path to 'failed' deletes the raw file + nulls raw_blob_ref — the reap
  //    path used to be the one exception, silently leaking the crashed run's
  //    raw upload file forever (jobRetention.ts's sweepFailedBookUploads
  //    later deletes the row itself with no filesystem cleanup of its own,
  //    trusting — per its own doc comment — that a 'failed' row's
  //    raw_blob_ref is always already NULL; the reap path was the one thing
  //    that broke that invariant).
  const reaped = await query<{ id: number; raw_blob_ref: string | null }>(
    `UPDATE book_uploads
        SET status = 'failed',
            error = 'ingest was interrupted by a server restart — try re-uploading',
            finished_at = now()
      WHERE status = 'processing'
        AND started_at < now() - make_interval(mins => $1)
      RETURNING id, raw_blob_ref`,
    [cfg.BOOK_INGEST_STALE_RUN_MINUTES],
  );
  if (reaped.rows.length > 0) {
    log.warn({ reaped: reaped.rows.length }, 'bookIngestRunner: reaped stale processing row(s)');
    for (const row of reaped.rows) {
      await clearPagesBestEffort(row.id, log);
      if (row.raw_blob_ref !== null) {
        await deleteRawFileBestEffort(row.raw_blob_ref, row.id, log);
        await query(`UPDATE book_uploads SET raw_blob_ref = NULL WHERE id = $1`, [row.id]).catch(
          (err: unknown) => {
            log.warn(
              { uploadId: row.id, err: String(err) },
              'bookIngestRunner: failed to clear raw_blob_ref after reap (non-fatal)',
            );
          },
        );
      }
    }
  }

  // Blue/green gate (mirrors storyAudio.ts's isRunnerActiveColor usage
  // exactly — see config/index.ts's doc for the mechanism): the reap above
  // is time-based and benign in every color; claim+process below must run in
  // only the color nginx is actively routing to.
  if (!cfg.BOOK_INGEST_RUNNERS_ENABLED || !isRunnerActiveColor(cfg)) return 'idle';

  // 2. Claim (its own short tx — the decode must NOT run inside one).
  const claimed = await withTransaction<ClaimedUpload | null>(async (client) => {
    const { rows } = await client.query<{
      id: number;
      user_id: number;
      raw_blob_ref: string | null;
    }>(
      `SELECT id, user_id, raw_blob_ref
         FROM book_uploads
        WHERE status = 'pending'
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    if (row.raw_blob_ref === null) {
      // Defensive: every 'pending' row is written by the route WITH a
      // raw_blob_ref in the same insert — a NULL here means a bug elsewhere,
      // not a real runtime state. Settle it failed immediately rather than
      // leave it spinning as an un-processable 'pending' row forever.
      await client.query(
        `UPDATE book_uploads
            SET status = 'failed', error = $2, finished_at = now()
          WHERE id = $1`,
        [row.id, 'internal error: pending upload has no raw file on record'],
      );
      return null;
    }
    await client.query(
      `UPDATE book_uploads SET status = 'processing', started_at = now() WHERE id = $1`,
      [row.id],
    );
    return { uploadId: Number(row.id), userId: Number(row.user_id), rawBlobRef: row.raw_blob_ref };
  });
  if (claimed === null) return 'idle';

  const { uploadId, userId, rawBlobRef } = claimed;
  log.info({ uploadId, userId }, 'bookIngestRunner: claimed upload');

  // 3. Process (minutes-possible I/O; no tx held). Any failure anywhere in
  //    here — sniff, idempotency clear, or the decode loop itself — settles
  //    the upload failed via the shared catch below.
  try {
    const absRawPath = resolveUnderRoot(rawBlobRef);
    const head = await readFileHead(absRawPath, UPLOAD_HEAD_SNIFF_BYTES);
    const kind: UploadKind | null = sniffUploadKind(head);
    if (kind === null) {
      // Should be unreachable (the route already sniffed this before
      // enqueueing) — defense in depth against a corrupted/truncated raw
      // file, or the file having been swapped out from under the row.
      throw new ValidationError(
        'uploaded file is neither a zip archive (PK\\x03\\x04) nor a PDF (%PDF-)',
      );
    }

    // IDEMPOTENCY (see module header): wipe any pages from a prior partial
    // attempt BEFORE decoding a single new page — the ONE mechanism that
    // makes every re-run (stale-reap-then-reclaim, same-title replace) safe
    // against duplicating book_pages. Also deletes the OLD pages' blob
    // files (best-effort — see clearPagesAndBlobs): the row delete itself
    // stays fatal (propagates to the outer catch -> settleFailed) so a
    // failure here can never let the fresh decode proceed on top of stale
    // rows.
    await clearPagesAndBlobs(uploadId, log);

    const pageStream: AsyncGenerator<ExtractedPage, void, void> =
      kind === 'zip'
        ? streamZipImageEntriesFromFile(absRawPath)
        : asExtractedPages(streamPdfPagesToJpegFromFile(absRawPath));

    let pageCount = 0;
    for await (const page of pageStream) {
      pageCount += 1;
      // Persist THIS page (blob write + book_pages insert) before the
      // generator is asked for the next one — the bounded-memory contract:
      // `page.buffer` is released once this iteration's body returns, and
      // the generator itself never buffers ahead (zipPageExtract.ts /
      // pdfPageRender.ts's streaming contracts).
      await persistOnePageDirect(userId, uploadId, pageCount, page);
    }

    if (pageCount === 0) {
      throw new ValidationError(
        kind === 'zip'
          ? 'zip archive contained no usable image pages (jpg/png)'
          : 'PDF contains no pages',
      );
    }

    // 4. Settle ready. Status-guarded so a concurrently-reaped row (a very
    //    slow decode that outran BOOK_INGEST_STALE_RUN_MINUTES) is never
    //    clobbered back to 'ready' out from under the reaper's 'failed'
    //    verdict — the reaper's verdict stands, and this settle silently
    //    no-ops (0 rows), matching storyAudio's exact race posture.
    const settled = await query(
      `UPDATE book_uploads
          SET status = 'ready', page_count = $2, finished_at = now(),
              error = NULL, raw_blob_ref = NULL
        WHERE id = $1 AND status = 'processing'`,
      [uploadId, pageCount],
    );
    if ((settled.rowCount ?? 0) === 0) {
      log.warn(
        { uploadId },
        'bookIngestRunner: settle-ready no-op — row was reaped mid-decode; leaving the reaper\'s failed verdict in place',
      );
      // The pages this (too-slow) run just wrote are orphaned relative to a
      // 'failed' row — clear them so the failed row never shows a partial/
      // stale page set (mirrors settleFailed's own cleanup).
      await clearPagesBestEffort(uploadId, log);
      return 'failed';
    }

    await deleteRawFileBestEffort(rawBlobRef, uploadId, log);
    log.info({ uploadId, pages: pageCount }, 'bookIngestRunner: upload ready');
    return 'done';
  } catch (err) {
    log.warn({ uploadId, userId, err: String(err) }, 'bookIngestRunner: ingest failed');
    await settleFailed(uploadId, rawBlobRef, failureMessage(err), log);
    return 'failed';
  }
}

/**
 * Start the in-server polling runner. Called once from index.ts after the
 * server binds (NEVER from createApp — tests build apps constantly and must
 * drive ticks explicitly). Mirrors `startStoryAudioRunner`'s exact shape: the
 * interval is unref'd so it can't hold the process open; ticks never overlap
 * (a running drain skips the next fire); each fire DRAINS the queue (loops
 * until 'idle') so a burst of enqueues doesn't wait one interval per book.
 *
 * @returns a stop function for graceful shutdown.
 */
export function startBookIngestRunner(log: Logger): () => void {
  const cfg = loadConfig();
  let draining = false;
  let stopped = false;

  const timer = setInterval(() => {
    if (draining || stopped) return;
    draining = true;
    void (async () => {
      try {
        let result: BookIngestTickResult;
        do {
          result = await runBookIngestTick(log);
        } while (result !== 'idle' && !stopped);
      } catch (err) {
        // A tick throwing (DB outage mid-poll) must never kill the interval —
        // the next fire retries; a claimed-but-unsettled row is the stale
        // reaper's job.
        log.error({ err: String(err) }, 'bookIngestRunner: runner tick threw');
      } finally {
        draining = false;
      }
    })();
  }, cfg.BOOK_INGEST_POLL_INTERVAL_MS);
  timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
