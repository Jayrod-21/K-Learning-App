/**
 * /uploads routes — U1a, book-upload feature, reworked to the PAGE-IMAGE
 * model (see db/docs/PDF_UPLOAD_DESIGN.md §"REVISION (2026-07-08)",
 * authoritative). Jared's real scans are a vFlat export — a ZIP of ~500
 * high-res JPG page images (240 MB) — or, for other sources, a plain PDF.
 * Either is normalized at upload time into an ORDERED SEQUENCE OF PAGE
 * IMAGES (`book_pages`, migration 041); the original zip/PDF is never
 * retained. NO extraction/OCR happens here — U2 (a later, separate phase) is
 * what turns a book's pages into tagged vocab/grammar/reading content via
 * `source_upload_id` (migration 040). This phase only needs each page to
 * exist and be viewable, in the right order.
 *
 * Flow (Phase 2.5 — ASYNC ingest, the OOM fix; see services/
 * bookIngestRunner.ts's header for the full design):
 *   POST   /uploads                  → enqueue a zip-of-images or PDF
 *                                       (multipart `file` + `title` + `type`)
 *                                       for async ingest — writes the raw
 *                                       file to disk + a 'pending' row,
 *                                       returns 202 IMMEDIATELY (no decode in
 *                                       the request; idempotent replace by
 *                                       (user, title) for a TERMINAL row —
 *                                       a live pending/processing row 409s)
 *   GET    /uploads                  → this user's uploads, newest first —
 *                                       poll GET /uploads/:id for a pending/
 *                                       processing upload's status
 *   GET    /uploads/shared           → the shared curated library (F-217) —
 *                                       every is_shared book, all accounts
 *   GET    /uploads/:id              → one upload's metadata (incl. page_count)
 *   GET    /uploads/:id/page/:n      → page n's image bytes (user-scoped)
 *   GET    /uploads/:id/pages        → the ordered list of {id, page_number}
 *                                       for every page (the client's reorder
 *                                       tool needs the stable `book_pages.id`
 *                                       set BEFORE it can submit a valid
 *                                       PATCH .../pages/order body — the same
 *                                       ids that route validates against)
 *   PATCH  /uploads/:id/pages/order  → reorder pages (vFlat retakes can land
 *                                       out of order — see migration 041)
 *   POST   /uploads/:id/extract      → F-108 (U2): run OCR extraction over a
 *                                       bounded page range (default: resume
 *                                       after the last done run) — see
 *                                       services/uploadExtract.ts for the
 *                                       claim/OCR/curate/persist shape, the
 *                                       daily Vision-page cap (429), and the
 *                                       one-live-run-per-upload claim (409)
 *   GET    /uploads/:id/extract      → this upload's extraction runs, newest
 *                                       first (the status surface)
 *   DELETE /uploads/:id              → remove the row + all its pages' blobs
 *
 * SECURITY (mirrors routes/images.ts + services/imageIngest.ts's posture,
 * reused rather than reinvented — see services/bookUploadIngest.ts's header
 * for the upload-side rationale, services/zipPageExtract.ts's header for the
 * zip-bomb guards):
 *   - UPLOAD: multer DISK storage (Phase 2.5 — was memory storage; the raw
 *     upload never touches Node heap), single field `file`, ~300 MiB
 *     fileSize cap, declared-mime fileFilter as an early reject, magic-byte
 *     (`PK\x03\x04` zip / `%PDF-` pdf) sniff as the authority (never trust
 *     the client-declared mime) — run against the file ON DISK, never the
 *     whole thing loaded into memory to check it.
 *   - PATH TRAVERSAL: every page's blob filename is a SERVER-generated UUID +
 *     the session user id (services/uploadStore.ts); no client string
 *     (including a zip entry's filename — used ONLY for sort order) ever
 *     enters a filesystem path. Every read/stream/delete resolves the stored
 *     relative path and asserts it stays under the configured root.
 *   - IDOR: every row/page/blob query is scoped to `getUserId(req)`, widened
 *     ONLY by `OR book_uploads.is_shared = true` on the two pure READ paths
 *     (F-207 phase 3a — the operator-set curated-corpus flag, mirroring
 *     routes/audio.ts's F-207 phase-1 widening exactly): GET /uploads/:id
 *     (meta) and GET /uploads/:id/page/:n (page bytes). A private row of
 *     another user's :id → 404 (not 403 — don't confirm existence), identical
 *     to a missing id so probing id-space reveals nothing. `GET .../page/:n`
 *     folds "not your upload" and "n out of range" into the SAME 404. A
 *     SHARED book is deliberately readable by every account and its reads
 *     carry no owner identity (UploadRow has no user_id/email). Every WRITE
 *     — delete, reorder, extract — keeps the strict owner scope, as does the
 *     /pages id-listing (it exists solely to feed the owner-only reorder
 *     PATCH) and the extract-runs status read. is_shared is OPERATOR-SET
 *     ONLY (the phase-2 cutover script); no route writes it, so a user can
 *     neither share their own arbitrary content nor un-share/steal someone
 *     else's. GET /uploads ("Books" list) lists the caller's OWN books,
 *     shared or not (`WHERE user_id = $1`): sharing is a read-access flag for
 *     OTHER accounts and must never hide an owner's own library from them
 *     (the F-207 cutover shared all of Jared's books, and an earlier
 *     `AND is_shared = false` decision-#2 filter then made his whole Reading
 *     page vanish — books, unlike audio, have no Listen-tile surface). A
 *     NON-owner still sees only their own here; browsing the shared library
 *     as a non-owner is GET /uploads/shared (F-217), which serves the same
 *     no-owner-PII projection filtered to `is_shared = true AND status =
 *     'ready'` (a non-owner never sees a processing/failed book's metadata).
 *   - MASS ASSIGNMENT: `title`/`type` (POST) and `page_ids` (PATCH order) are
 *     the only writable body fields, all validated by a `.strict()` Zod
 *     schema — an extra field is REJECTED, not ignored.
 *   - COST/ABUSE: a per-user DAILY cap (config BOOK_UPLOAD_DAILY_CAP) on NEW
 *     titles → 429 BEFORE any write; a same-title re-upload (idempotent
 *     replace, of a TERMINAL ready/failed row) is exempt (see
 *     bookUploadIngest.ts). A same-title upload while a PRIOR one is still
 *     pending/processing → 409, not a cap consumption (the second request
 *     never wrote anything).
 *   - ATOMICITY (Phase 2.5): POST's enqueue is one short transaction (row
 *     lock -> cap check / conflict check -> insert-or-reset to 'pending')
 *     that never touches a page or a blob — the actual decode is the
 *     runner's job, entirely outside the request (bookIngestRunner.ts). Any
 *     failure AFTER multer wrote the raw file — the inline `UploadBodySchema`
 *     parse (blank title, bad `type`, `.strict()` mass-assignment), the
 *     magic-byte sniff, the daily cap, or the 409 conflict — deletes the
 *     just-written raw file before responding, so nothing orphans on disk
 *     for a request that never got as far as a DB row. Body validation is
 *     done INLINE in the handler rather than via the `validateBody(...)`
 *     middleware every other route here uses, specifically so a validation
 *     failure lands in the SAME try/catch as every other post-multer
 *     failure (BUG FIX: `validateBody` calls `next(err)` directly, which
 *     bypasses the handler entirely — under the old memoryStorage this was
 *     harmless, but diskStorage means it used to leak the raw file on every
 *     validation rejection). DELETE (unchanged) reads every page's blob_ref
 *     inside the same transaction as the row delete (which CASCADEs
 *     `book_pages`, migration 041), then unlinks the files best-effort
 *     after commit.
 *   - REORDER CONCURRENCY: `PATCH .../pages/order` renumbers through a
 *     temporary out-of-range placeholder (see the handler) so the two-phase
 *     bulk UPDATE never trips the NOT DEFERRABLE `UNIQUE(upload_id,
 *     page_number)` constraint mid-permutation.
 *   - PAGE SERVING: authed, `X-Content-Type-Options: nosniff`, content-type
 *     derived from the stored extension (jpg/png — never client-influenced),
 *     a moderate private cache TTL (the URL's referent can change on reorder
 *     or replace-by-title, so this deliberately isn't a long/immutable cache).
 */
import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter, expensiveLimiter, mediaLimiter } from '../middleware/rateLimits.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { clientQuerier, query, withTransaction, type Querier } from '../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../middleware/errors.js';
import { deleteBlob, resolveUnderRoot } from '../services/uploadStore.js';
import {
  assertUnderDailyCap,
  BOOK_UPLOAD_TYPES,
  bookUploadRawRelPath,
  multerBookUpload,
  sniffUploadedFileKind,
  type BookUploadDTO,
  type BookUploadType,
} from '../services/bookUploadIngest.js';
import {
  MAX_EXTRACT_PAGES_PER_RUN,
  RUN_COLUMNS,
  runExtraction,
  toExtractionRunDTO,
  type ExtractionRunRow,
} from '../services/uploadExtract.js';
import { sweepFailedBookUploads } from '../services/jobRetention.js';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** BIGINT identity ids (upload id, page NUMBER, and reorder page ids) are all
 *  coerced + upper-bounded the same way: a garbage id is a 400 (not a SQL
 *  cast error), and Number.isInteger(1e20) is true, so an unbounded 20-digit
 *  id would otherwise pass Zod and overflow int8 in pg (mirrors
 *  routes/images.ts's IdParamsSchema). */
const MAX_ID = Number.MAX_SAFE_INTEGER;

const IdParamsSchema = z.object({
  id: z.coerce.number().int().positive().max(MAX_ID),
});

/** :n is the 1-based DISPLAY page number (book_pages.page_number), not a
 *  book_pages.id — matches how a viewer paginates ("page 3 of 250"). */
const PageParamsSchema = z.object({
  id: z.coerce.number().int().positive().max(MAX_ID),
  n: z.coerce.number().int().positive().max(MAX_ID),
});

/**
 * The two multipart TEXT fields alongside the `file` part. `.strict()`
 * rejects any extra field (mass-assignment defense — a client cannot smuggle
 * `status`/`user_id`/etc. onto the row). `title` is trimmed + bounded to match
 * the DB CHECK (migration 040: length BETWEEN 1 AND 200).
 */
const UploadBodySchema = z
  .object({
    title: z.string().trim().min(1, 'title must not be blank').max(200),
    type: z.enum(BOOK_UPLOAD_TYPES),
  })
  .strict();

/**
 * `PATCH /uploads/:id/pages/order` body: the FULL new page order, as an array
 * of `book_pages.id` values. Must be exactly the upload's current page-id set
 * (no partial reorders, no ids from another upload) — validated in the
 * handler, where the DB has the current set to compare against. Capped at
 * 3000 (comfortably above `MAX_ZIP_ENTRIES` in services/zipPageExtract.ts and
 * `MAX_PDF_PAGES` in services/pdfPageRender.ts — both 2000 — which bound how
 * many pages an upload can ever have).
 */
const PageOrderBodySchema = z
  .object({
    page_ids: z.array(z.coerce.number().int().positive().max(MAX_ID)).min(1).max(3000),
  })
  .strict();

/**
 * `POST /uploads/:id/extract` body — an OPTIONAL 1-based inclusive page range.
 * Both fields omitted = "resume": start after the last done run's page_to,
 * covering the default slice (services/uploadExtract.ts owns the defaulting +
 * the span ceiling — the range logic needs the DB's view of prior runs, so it
 * lives in the claim transaction, not here). `.strict()` rejects any extra
 * field (mass-assignment defense — counts/status/user_id can't be smuggled).
 */
const ExtractBodySchema = z
  .object({
    page_from: z.coerce.number().int().positive().max(MAX_ID).optional(),
    page_to: z.coerce.number().int().positive().max(MAX_ID).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Row types + projections
// ---------------------------------------------------------------------------

interface UploadRow {
  id: number;
  title: string;
  type: (typeof BOOK_UPLOAD_TYPES)[number];
  status: 'pending' | 'processing' | 'ready' | 'failed';
  page_count: number | null;
  byte_size: number;
  error: string | null;
  created_at: Date;
}

function toDTO(row: UploadRow): BookUploadDTO {
  return {
    // Wire contract: upload ids are emitted as STRINGS (pre-int8-parser
    // behavior, pinned). Shared by GET /uploads, /uploads/shared and
    // GET /uploads/:id, so all three lists stay in lockstep.
    id: String(row.id),
    title: row.title,
    type: row.type,
    status: row.status,
    page_count: row.page_count,
    byte_size: row.byte_size,
    error: row.error,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * The enqueue transaction (Phase 2.5 — mirrors reading.ts's
 * `enqueueStoryAudio` shape): row-lock any existing (user, title) upload
 * FIRST — serializing this against a concurrent second POST for the SAME
 * title — then either INSERT a brand-new 'pending' row (daily cap applies)
 * or, for a terminal (ready/failed) existing row, RESET it to 'pending' with
 * a fresh raw file (idempotent replace — unchanged posture from the sync-era
 * `ingestUpload`'s "PER-USER CAP" note: a same-title re-upload never spends
 * budget). A 'pending'/'processing' existing row 409s rather than being
 * clobbered — see the module header IDOR/ATOMICITY note for why: overwriting
 * `raw_blob_ref` on a row the runner might be mid-decode of would let its
 * eventual status-guarded settle UPDATE (`WHERE status = 'processing'`)
 * silently no-op, stranding freshly-decoded book_pages under a row that had
 * already moved back to 'pending' out from under it.
 *
 * The OLD book_pages for a replaced title are deliberately NOT deleted here
 * — the runner clears them itself, immediately before it starts the new
 * decode (bookIngestRunner.ts's idempotency step), so the prior version
 * stays viewable for as long as the new one is still queued/decoding.
 */
async function enqueueBookUpload(
  db: Querier,
  userId: number,
  body: { title: string; type: BookUploadType },
  byteSize: number,
  rawBlobRef: string,
): Promise<BookUploadDTO> {
  const existing = await db<{ id: number; status: UploadRow['status'] }>(
    `SELECT id, status FROM book_uploads WHERE user_id = $1 AND title = $2 FOR UPDATE`,
    [userId, body.title],
  );
  const row = existing.rows[0];

  if (row !== undefined) {
    if (row.status === 'pending' || row.status === 'processing') {
      throw new ConflictError(
        'an upload is already processing for this title — wait for it to finish or fail, or use a different title',
      );
    }
    const { rows } = await db<UploadRow>(
      `UPDATE book_uploads
          SET type = $2::book_upload_type, status = 'pending', byte_size = $3,
              page_count = NULL, error = NULL, started_at = NULL, finished_at = NULL,
              raw_blob_ref = $4, version = version + 1
        WHERE id = $1
        RETURNING id, title, type, status, page_count, byte_size, error, created_at`,
      [row.id, body.type, byteSize, rawBlobRef],
    );
    return toDTO(rows[0]!);
  }

  // Brand-new title — the per-user daily cap applies BEFORE the INSERT.
  await assertUnderDailyCap(db, userId);
  const { rows } = await db<UploadRow>(
    `INSERT INTO book_uploads (user_id, title, type, status, byte_size, raw_blob_ref)
     VALUES ($1, $2, $3::book_upload_type, 'pending', $4, $5)
     RETURNING id, title, type, status, page_count, byte_size, error, created_at`,
    [userId, body.title, body.type, byteSize, rawBlobRef],
  );
  return toDTO(rows[0]!);
}

// ---------------------------------------------------------------------------
// POST /uploads — enqueue a zip-of-images or PDF for ASYNC ingest (Phase 2.5
// — the OOM fix). NO decode happens in the request: multer has already
// written the raw file to disk (diskStorage, never Node heap — see
// bookUploadIngest.ts); this handler validates (magic-byte sniff, daily cap)
// and enqueues a 'pending' book_uploads row, returning 202 immediately. The
// in-process ingest runner (bookIngestRunner.ts) does the actual streaming
// decode; the client polls GET /uploads/:id for status.
// ---------------------------------------------------------------------------

router.post('/', expensiveLimiter(), multerBookUpload, async (req, res, next) => {
  const file = (req as Request & { file?: Express.Multer.File }).file;
  try {
    const userId = getUserId(req);

    // BODY VALIDATION — deliberately done HERE, inline, rather than via the
    // `validateBody(UploadBodySchema)` middleware every other route in this
    // file uses (BUG FIX, Phase 2.5 diskStorage regression: `validateBody`
    // calls `next(err)` directly on a Zod failure, which skips straight to
    // the error handler and NEVER reaches this handler's own try/catch below
    // — so the raw file multer had already written to disk (diskStorage,
    // unlike the old memoryStorage) would leak on every blank-title/
    // bad-type/`.strict()`-mass-assignment rejection, with no `book_uploads`
    // row ever written to let `jobRetention.ts`'s sweep reach it later. Doing
    // the parse inline means a schema failure throws INTO this handler's own
    // catch, which already unlinks `file.path` on any post-multer failure —
    // one cleanup path for every rejection, not two.
    const parsedBody = UploadBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError('invalid request body', parsedBody.error.issues);
    }
    const body = parsedBody.data;

    if (!file || file.size === 0) {
      throw new ValidationError('a zip (vFlat export) or PDF file is required in the "file" field');
    }

    // Magic-byte sniff — never trust the client-declared mime (multer's
    // fileFilter was only an early reject). Reads a handful of bytes off
    // disk, never the whole (possibly 300 MiB) file. Throws ValidationError
    // (400) for a file that's neither a real zip nor a real PDF.
    await sniffUploadedFileKind(file.path);

    const rawBlobRef = bookUploadRawRelPath(userId, file.filename);
    const dto = await withTransaction((client) =>
      enqueueBookUpload(clientQuerier(client), userId, body, file.size, rawBlobRef),
    );

    res.status(202).json({ upload: dto });
  } catch (err) {
    // Any failure AFTER multer already wrote the raw file (a blank/invalid
    // body per the inline UploadBodySchema parse above, bad magic bytes,
    // over the daily cap, a live 409 conflict) must not orphan it on disk —
    // delete best-effort before propagating (module header "On a validation
    // failure, delete the just-written raw file").
    if (file) {
      await unlink(file.path).catch((unlinkErr: unknown) => {
        req.log.warn(
          { err: String(unlinkErr), path: file.path },
          'uploads: failed to delete raw upload file after a failed enqueue (orphaned, non-fatal)',
        );
      });
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /uploads — this user's OWN uploads (shared or not), newest first.
// ---------------------------------------------------------------------------

router.get('/', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    // Retention (Phase 2.5): sweep this user's stale terminal-'failed' book
    // uploads before listing — the "My Uploads" read is the natural sweep
    // trigger (no cron in this repo, jobRetention.ts's established pattern).
    // Best-effort and user-scoped; a failure here is logged and swallowed
    // inside the service, so it never fails the listing.
    await sweepFailedBookUploads(userId, req.log);
    // The owner ALWAYS sees their own books here, whether or not they are
    // shared. (Reverses the earlier F-207 decision-#2 exclusion, which was
    // wrong for books: unlike audio — whose curated sets all live on the
    // Listen swipe tiles — most books have no other surface, so flagging
    // them shared made the owner's entire scanned library vanish from the
    // Reading page. Sharing is a READ-access flag for OTHER accounts; it must
    // never hide an owner's own content from them.) Cross-account read of a
    // shared book is handled by GET /uploads/:id + the reading routes;
    // browsing the shared library as a NON-owner is GET /uploads/shared
    // (F-217, below).
    const { rows } = await query<UploadRow>(
      `SELECT id, title, type, status, page_count, byte_size, error, created_at
         FROM book_uploads
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC`,
      [userId],
    );
    res.status(200).json({ uploads: rows.map(toDTO) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /uploads/shared — the shared curated library (F-217), every account.
// ---------------------------------------------------------------------------

/**
 * Upper bound on the shared listing (audio.ts's GET_SOURCES_LIMIT posture):
 * the curated corpus is operator-sized (the F-207 cutover flipped 18 books),
 * so 200 is a generous fixed ceiling against a runaway listing — not a
 * pagination scheme. Matches the client shelf's `usePagination` max.
 */
const GET_SHARED_UPLOADS_LIMIT = 200;

// Registered as a LITERAL path ABOVE `/:id` — Express matches in declaration
// order, so declared below it "shared" would be captured as an :id param
// value (IdParamsSchema's numeric coercion would 400 and this handler could
// never run). Mirrors routes/audio.ts's GET /audio/shared ordering note.
router.get('/shared', cheapLimiter(), async (_req, res, next) => {
  try {
    // F-217 (the F-207 phase-3 follow-up): the shared-books browse surface.
    // DELIBERATELY NON-user-scoped — every authenticated account
    // (router.use(requireAuth) above) sees the same curated library;
    // `is_shared = true` scopes it, so a private row (any owner's) can
    // never appear here, and `status = 'ready'` keeps the server
    // authoritative: a processing/failed shared book's title/metadata is
    // never exposed cross-account (the client filters to ready too, but a
    // list served to non-owners must not rely on client-side filtering).
    // The projection is the SAME UploadRow →
    // toDTO as GET /uploads: no user_id, no email, no blob_ref — these are
    // another account's rows served cross-account, and the owner's identity
    // is not the client's business (no-owner-PII is asserted by the route
    // tests). READ-only surface; every write route keeps its strict owner
    // scope, and is_shared itself stays operator-set only.
    const { rows } = await query<UploadRow>(
      `SELECT id, title, type, status, page_count, byte_size, error, created_at
         FROM book_uploads
        WHERE is_shared = true AND status = 'ready'
        ORDER BY created_at DESC, id DESC
        LIMIT $1`,
      [GET_SHARED_UPLOADS_LIMIT],
    );
    res.status(200).json({ uploads: rows.map(toDTO) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /uploads/:id — one readable (owned or shared, F-207 phase 3a) upload's
// metadata.
// ---------------------------------------------------------------------------

router.get('/:id', cheapLimiter(), validateParams(IdParamsSchema), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { id } = (req as Request & { validatedParams: z.infer<typeof IdParamsSchema> })
      .validatedParams;

    // READ-ONLY widening (F-207 phase 3a, audio.ts's exact shape): a book is
    // readable when the caller OWNS it OR it is in the shared curated corpus.
    // A miss (missing OR another user's PRIVATE book) stays a uniform 404 —
    // never confirm a foreign book exists. UploadRow carries no user_id/
    // email, so a shared read leaks no owner identity.
    const { rows } = await query<UploadRow>(
      `SELECT id, title, type, status, page_count, byte_size, error, created_at
         FROM book_uploads
        WHERE id = $1 AND (user_id = $2 OR is_shared = true)`,
      [id, userId],
    );
    const row = rows[0];
    if (!row) {
      // Not theirs / missing → 404 (don't confirm existence).
      throw new NotFoundError('upload not found');
    }
    res.status(200).json({ upload: toDTO(row) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /uploads/:id/page/:n — stream page n's image bytes (owned or shared,
// F-207 phase 3a).
// ---------------------------------------------------------------------------

router.get(
  '/:id/page/:n',
  mediaLimiter(),
  validateParams(PageParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id, n } = (req as Request & { validatedParams: z.infer<typeof PageParamsSchema> })
        .validatedParams;

      // A single access-scoped join covers "not your (private) upload" and
      // "n out of range" with the same 404 — no row means neither reason is
      // distinguishable to the caller (don't confirm the upload's existence
      // to a non-owner probing page numbers). Widened for F-207 phase 3a
      // (audio.ts's stream-probe shape): a page streams when the caller OWNS
      // the book OR the book is in the shared curated corpus. is_shared
      // lives on book_uploads (the parent), so the existing join carries the
      // check; the pages themselves have no owner column and are only ever
      // reached THROUGH the book. READ-ONLY widening — a private book of
      // another user still 404s uniformly.
      const { rows } = await query<{ blob_ref: string }>(
        `SELECT bp.blob_ref
           FROM book_pages bp
           JOIN book_uploads bu ON bu.id = bp.upload_id
          WHERE bu.id = $1
            AND (bu.user_id = $2 OR bu.is_shared = true)
            AND bp.page_number = $3`,
        [id, userId, n],
      );
      const row = rows[0];
      if (!row) {
        throw new NotFoundError('page not found');
      }

      let absPath: string;
      try {
        absPath = resolveUnderRoot(row.blob_ref);
      } catch {
        // A poisoned/corrupt blob_ref (defense in depth — should never
        // happen given the row is always written by saveBlob). Uniform 404,
        // never confirm what the traversal attempt would have hit.
        throw new NotFoundError('page bytes not found');
      }

      let size: number;
      try {
        size = (await stat(absPath)).size;
      } catch (err) {
        // Missing file on disk (ENOENT) — the row exists but the bytes are
        // gone (e.g. a partial restore). Treat as 404, not 500.
        if (isEnoent(err)) {
          throw new NotFoundError('page bytes not found');
        }
        throw err;
      }

      res.setHeader('Content-Type', mimeForBlobRef(row.blob_ref));
      // nosniff: the browser must honor our content-type, never sniff the
      // bytes into an executable type.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Authed, per-user content: a moderate TTL, not "forever" — the URL's
      // referent can change (reorder renumbers which page is "n"; a
      // same-title re-upload replaces the whole page set), so an aggressive/
      // immutable cache would risk showing a stale page after either.
      res.setHeader('Cache-Control', 'private, max-age=3600, must-revalidate');
      res.setHeader('Content-Length', size);

      const stream = createReadStream(absPath);
      stream.on('error', (err) => {
        req.log.error({ err, absPath }, 'uploads: page stream error');
        stream.destroy();
        if (res.headersSent) {
          res.destroy();
        } else {
          next(err);
        }
      });
      // Client disconnect: stop reading the file (backpressure would
      // eventually, but destroying promptly frees the fd).
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /uploads/:id/pages — the ordered list of every page's stable id
// (user-scoped). Closes the cross-agent contract gap: the client's reorder
// tool (services/uploads.ts `listPages`) needs each page's `book_pages.id`
// BEFORE it can submit `PATCH .../pages/order`, which validates the
// submitted `page_ids` set against the upload's CURRENT id set exactly (see
// that handler below) — this route is where that current set comes from.
// Response shape is deliberately IDENTICAL to the PATCH's response
// (`{ pages: [{ id, page_number }] }`) so the ids this route hands back are
// literally the same ids — and the same wire shape — the PATCH accepts.
// ---------------------------------------------------------------------------

router.get(
  '/:id/pages',
  cheapLimiter(),
  validateParams(IdParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = (req as Request & { validatedParams: z.infer<typeof IdParamsSchema> })
        .validatedParams;

      // Ownership check FIRST, separate from the page query: an owned upload
      // that's still `processing` (or a corpus edge case) can legitimately
      // have zero pages, which must be a 200 with an empty list — not folded
      // into the same 404 the way page/:n's single-query IDOR check is,
      // since that route only ever needs "does page n exist for me".
      const owner = await query<{ id: number }>(
        `SELECT id FROM book_uploads WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );
      if (!owner.rows[0]) {
        // Not theirs / missing → 404 (don't confirm existence).
        throw new NotFoundError('upload not found');
      }

      const { rows } = await query<{ id: number; page_number: number }>(
        `SELECT id, page_number FROM book_pages WHERE upload_id = $1 ORDER BY page_number`,
        [id],
      );
      res.status(200).json({
        // Wire contract: page ids are emitted as STRINGS (pre-int8-parser
        // behavior, pinned by uploads.test.ts).
        pages: rows.map((r) => ({ id: String(r.id), page_number: r.page_number })),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /uploads/:id/pages/order — reorder pages (user-scoped, transactional).
// ---------------------------------------------------------------------------

router.patch(
  '/:id/pages/order',
  cheapLimiter(),
  validateParams(IdParamsSchema),
  validateBody(PageOrderBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = (req as Request & { validatedParams: z.infer<typeof IdParamsSchema> })
        .validatedParams;
      const body = (req as Request & { body: z.infer<typeof PageOrderBodySchema> }).body;

      const uniqueIds = new Set<number>(body.page_ids);
      if (uniqueIds.size !== body.page_ids.length) {
        throw new ValidationError('page_ids must not contain duplicates');
      }

      const pages = await withTransaction(async (client) => {
        const owner = await client.query<{ id: number }>(
          `SELECT id FROM book_uploads WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [id, userId],
        );
        if (!owner.rows[0]) {
          // Not theirs / missing → 404 (don't confirm existence).
          throw new NotFoundError('upload not found');
        }

        const current = await client.query<{ id: number }>(
          `SELECT id FROM book_pages WHERE upload_id = $1 FOR UPDATE`,
          [id],
        );
        const currentIds = new Set(current.rows.map((r) => r.id));
        const submittedMatchesCurrent =
          currentIds.size === uniqueIds.size &&
          [...uniqueIds].every((pid) => currentIds.has(pid));
        if (!submittedMatchesCurrent) {
          throw new ValidationError(
            "page_ids must be exactly this upload's current set of page ids (no partial reorders, no foreign ids)",
          );
        }

        // Two-phase renumber: UNIQUE(upload_id, page_number) is NOT
        // DEFERRABLE, so jumping straight to final positions in one bulk
        // UPDATE can spuriously 23505 (a row can momentarily need the number
        // a not-yet-updated sibling still holds, mid-permutation). Phase 1
        // moves EVERY row in this upload to a placeholder far above any
        // realistic page count (PLACEHOLDER_BASE + a per-row index, so each
        // placeholder is unique too) — NOT a negative number: `page_number`
        // has its own `CHECK (page_number > 0)` (migration 041), which a
        // negative placeholder would violate immediately (Postgres checks
        // CHECK constraints per-row, during the statement, not deferred to
        // the end). Once every row holds a placeholder, no row holds any of
        // the target values 1..N, so phase 2's assignment of the final
        // sequence from body.page_ids is collision-free — no other row in
        // the set can already hold a given target.
        const PLACEHOLDER_BASE = 1_000_000_000; // « any realistic page count; well inside int4
        const currentIdsOrdered = current.rows.map((r) => r.id);
        await client.query(
          `UPDATE book_pages AS bp
              SET page_number = v.pos
             FROM (SELECT * FROM unnest($1::bigint[], $2::int[]) AS t(page_id, pos)) AS v
            WHERE bp.id = v.page_id AND bp.upload_id = $3`,
          [currentIdsOrdered, currentIdsOrdered.map((_: number, i: number) => PLACEHOLDER_BASE + i), id],
        );
        await client.query(
          `UPDATE book_pages AS bp
              SET page_number = v.pos
             FROM (SELECT * FROM unnest($1::bigint[], $2::int[]) AS t(page_id, pos)) AS v
            WHERE bp.id = v.page_id AND bp.upload_id = $3`,
          [body.page_ids, body.page_ids.map((_: number, i: number) => i + 1), id],
        );

        const { rows } = await client.query<{ id: number; page_number: number }>(
          `SELECT id, page_number FROM book_pages WHERE upload_id = $1 ORDER BY page_number`,
          [id],
        );
        return rows;
      });

      res.status(200).json({
        pages: pages.map((r) => ({ id: String(r.id), page_number: r.page_number })),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /uploads/:id/extract — F-108 (U2): run OCR extraction over a bounded
// page range. Synchronous: the response IS the settled run (done/failed with
// counts). Everything security-load-bearing (ownership 404, range validation,
// daily Vision-page cap 429 BEFORE upstream, one-live-run claim 409, the
// OCR-outside-tx / persist-inside-tx split, per-word injection screening)
// lives in services/uploadExtract.ts — see its header.
// ---------------------------------------------------------------------------

router.post(
  '/:id/extract',
  expensiveLimiter(),
  validateParams(IdParamsSchema),
  validateBody(ExtractBodySchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = (req as Request & { validatedParams: z.infer<typeof IdParamsSchema> })
        .validatedParams;
      const body = (req as Request & { body: z.infer<typeof ExtractBodySchema> }).body;

      const run = await runExtraction(id, userId, body, req.log, req.correlationId);
      res.status(201).json({ run });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /uploads/:id/extract — this upload's extraction runs, newest first
// (the status surface for F-059's button + progress view). User-scoped: an
// unowned/missing :id → 404 before any run row is read.
// ---------------------------------------------------------------------------

router.get(
  '/:id/extract',
  cheapLimiter(),
  validateParams(IdParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = (req as Request & { validatedParams: z.infer<typeof IdParamsSchema> })
        .validatedParams;

      const owner = await query<{ id: number }>(
        `SELECT id FROM book_uploads WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );
      if (!owner.rows[0]) {
        // Not theirs / missing → 404 (don't confirm existence).
        throw new NotFoundError('upload not found');
      }

      // Newest first; bounded — the status view wants recent history, not an
      // unbounded scroll (a book at 20 pages/run tops out around 25 runs; 50
      // covers retries without an unbounded payload).
      const { rows } = await query<ExtractionRunRow>(
        `SELECT ${RUN_COLUMNS}
           FROM upload_extractions
          WHERE upload_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 50`,
        [id],
      );
      res.status(200).json({
        runs: rows.map(toExtractionRunDTO),
        max_pages_per_run: MAX_EXTRACT_PAGES_PER_RUN,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /uploads/:id — remove the row + every page's blob (user-scoped).
// ---------------------------------------------------------------------------

router.delete(
  '/:id',
  cheapLimiter(),
  validateParams(IdParamsSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = (req as Request & { validatedParams: z.infer<typeof IdParamsSchema> })
        .validatedParams;

      // Capture every page's blob_ref + the RAW upload file's ref (Phase
      // 2.5 — a 'pending'/'processing' row still points at one; a settled
      // 'ready'/'failed' row's is already NULL) BEFORE deleting (the DELETE
      // below CASCADEs book_pages at the DB level, migration 041 — the rows
      // are gone the instant this commits, but the FILES are cleaned up
      // separately below since file deletion isn't transactional). Deleting
      // an upload the runner hasn't claimed yet (still 'pending') would
      // otherwise strand its raw file on the km_book_uploads volume forever
      // — nothing would ever claim (and therefore never clean up) a row that
      // no longer exists. Any content U2 has tagged via source_upload_id is
      // un-tagged, not deleted (ON DELETE SET NULL, migration 040), and the
      // upload's extraction-run rows likewise survive with upload_id nulled
      // (ON DELETE SET NULL, migration 069): they are the daily Vision-page
      // cost ledger, and deleting a book must never refund its budget
      // (fixpass b8 BLOCKER-1).
      const { blobRefs, rawBlobRef } = await withTransaction(async (client) => {
        const owner = await client.query<{ id: number; raw_blob_ref: string | null }>(
          `SELECT id, raw_blob_ref FROM book_uploads WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [id, userId],
        );
        const row = owner.rows[0];
        if (!row) {
          // Not theirs / missing → 404 (IDOR-safe — same response whether the
          // id belongs to another user or doesn't exist).
          throw new NotFoundError('upload not found');
        }
        const pages = await client.query<{ blob_ref: string }>(
          `SELECT blob_ref FROM book_pages WHERE upload_id = $1`,
          [id],
        );
        await client.query(`DELETE FROM book_uploads WHERE id = $1`, [id]);
        return { blobRefs: pages.rows.map((r) => r.blob_ref), rawBlobRef: row.raw_blob_ref };
      });

      // Best-effort blob cleanup — the rows are already gone; a failed unlink
      // leaves a harmless orphan file rather than failing a delete the user
      // already sees as successful. A row deleted while still 'processing'
      // can race the runner (it holds no lock across its decode loop — see
      // bookIngestRunner.ts's header): the runner's own page-INSERTs will
      // then fail their FK (the parent row is gone) and its settle UPDATE
      // will no-op (0 rows matched), so any page blobs it wrote before
      // hitting that FK error are ALSO orphaned — acceptable, same "harmless
      // GC-able orphan" posture as every other best-effort delete in this
      // module; nothing user-visible or security-relevant.
      await Promise.all(
        [...blobRefs, ...(rawBlobRef !== null ? [rawBlobRef] : [])].map(async (blobRef) => {
          try {
            await deleteBlob(blobRef);
          } catch (err) {
            req.log.warn(
              { err: String(err), blobRef },
              'uploads: failed to delete blob on DELETE (orphaned, non-fatal)',
            );
          }
        }),
      );

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive Content-Type from the stored extension — never client-influenced;
 *  every blob_ref is server-written by saveBlob with a 'jpg' or 'png'
 *  extension (bookUploadIngest.ts's extForMime). */
function mimeForBlobRef(blobRef: string): string {
  return blobRef.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
}

/** True when the error is a filesystem "no such file" error. */
function isEnoent(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

export default router;
