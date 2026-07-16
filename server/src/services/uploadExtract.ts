/**
 * Upload-extraction service (F-108 — U2 extraction/OCR pipeline).
 *
 * Turns a bounded page range of an uploaded book (`book_pages` images, U1a)
 * into tagged corpus content: each page is pushed through the EXISTING Claude
 * Vision OCR route (`ClaudeProxy.ocrImage` — the same call the Images screen
 * uses; no new OCR engine, no tesseract), and the OCR'd words are curated and
 * persisted into `vocab_entries` / `kgiu_entries` under the existing
 * `user_mined` corpus with `source_upload_id = uploadId`. That column is what
 * F-056's grammar-from-upload view and the U3a source filters (routes/vocab.ts
 * + routes/grammar.ts, already shipped with owner-EXISTS guards) read — this
 * service is the writer they have been waiting for.
 *
 * Execution model — SYNCHRONOUS, RANGE-BOUNDED runs:
 *   A full book (~500 pages) would be ~500 Vision calls; running it blind
 *   would blow the daily Vision budget and hold a request open for an hour.
 *   Instead a run covers at most MAX_EXTRACT_PAGES_PER_RUN pages and executes
 *   synchronously inside the request (same stance as U1a's synchronous
 *   normalization — no job runner exists in this codebase, and inventing one
 *   for a personal app is over-build). Resumability comes from the run table:
 *   the next run defaults to starting after the highest page a 'done' run
 *   reached, so a book is worked through in bounded slices.
 *
 * Transaction shape (Bar §Concurrency — NO external I/O inside an open tx;
 * mirrors imageIngest.ts's ocr-outside/persist-inside split):
 *
 *   tx1 (CLAIM)   — ownership check (404 on mismatch), range resolution +
 *                   validation, daily Vision-page cap (429 BEFORE any
 *                   upstream call), INSERT the run row as 'running'. The
 *                   partial-unique index uq_upload_extractions_upload_live
 *                   makes this INSERT the concurrency arbiter: a concurrent
 *                   second trigger gets 23505 → 409, never a double charge.
 *   OCR (no tx)   — one ocrImage call per page. A single page's failure
 *                   (missing blob, oversize, Vision error) marks THAT page
 *                   failed and continues — one bad scan must not waste the
 *                   budget already spent on its siblings.
 *   CURATION      — pure in-memory boundary (curateOcrWords): sanitize every
 *                   OCR'd field through the shared prompt-injection guard,
 *                   dedup by headword, classify vocab vs grammar-candidate.
 *                   This is the "populate at curation" step the F-108 ticket
 *                   names: only curated output — never raw OCR — reaches the
 *                   corpus tables.
 *   tx2 (PERSIST) — all curated rows + the run's 'done' settlement commit
 *                   atomically. A mid-persist failure rolls back EVERYTHING
 *                   (no half-tagged corpus), and the run is then settled
 *                   'failed' by a separate best-effort UPDATE.
 *
 * SECURITY (each threat → its defense; user standing rule):
 *   - IDOR: the claim tx re-checks the upload belongs to the requesting user;
 *     a foreign/missing id → 404 (not 403 — don't confirm existence),
 *     mirroring every other /uploads route.
 *   - PATH TRAVERSAL: page bytes are read ONLY via uploadStore.readBlob,
 *     which resolves the DB-stored relative blob_ref under the configured
 *     root and rejects anything that escapes it. No client string is ever
 *     part of a filesystem path in this module.
 *   - COST/DoS: (1) range span capped at MAX_EXTRACT_PAGES_PER_RUN; (2) the
 *     per-user DAILY page cap (config UPLOAD_EXTRACT_DAILY_PAGE_CAP) is
 *     enforced inside the claim tx BEFORE any Vision call and counts failed
 *     runs (cost control, not usage metering); (3) the one-live-run-per-upload
 *     unique claim stops concurrent double-spends; (4) per-page images are
 *     bounded by the same 8 MiB limit as the Images screen before base64.
 *   - PROMPT INJECTION: OCR'd text is PERSISTED content that later re-enters
 *     Claude prompts (grammar drills, enrich, diagnostics read these tables).
 *     Every field passes through the shared sanitizeUserInput guard at the
 *     curation boundary; a word that trips the injection markers is SKIPPED
 *     (counted in words_skipped) rather than stored — same posture as
 *     docAttach.ts, applied per-word so one poisoned line cannot veto a page.
 *   - IDEMPOTENCY / double-insert: corpus rows carry deterministic source_ids
 *     (`upload-{uploadId}-{headword}`) arbitrated by the tables' existing
 *     UNIQUE (corpus, source_id) via ON CONFLICT DO NOTHING — re-running a
 *     range re-charges Vision (the user asked it to) but can never duplicate
 *     content rows, and existing rows are never clobbered.
 */
import type { PoolClient } from 'pg';
import type { Logger } from 'pino';
import { query, withTransaction } from '../db/pool.js';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
  mapClaudeError,
} from '../middleware/errors.js';
import { loadConfig } from '../config/index.js';
import { getClaudeProxy, sanitizeUserInput } from './claudeProxy.js';
import type { ImageOcrResult, ImageOcrWord } from './claudeProxy.js';
import { MAX_UPLOAD_BYTES } from './imageIngest.js';
import { readBlob } from './uploadStore.js';

// ---------------------------------------------------------------------------
// Run-shape constants
// ---------------------------------------------------------------------------

/** Hard per-run page ceiling — one page = one Vision call, so this bounds a
 *  single request's cost AND wall-clock (each call is seconds; 20 keeps the
 *  synchronous request comfortably inside proxy/browser timeouts). */
export const MAX_EXTRACT_PAGES_PER_RUN = 20;

/** Default span when the client omits the range — a sensible slice, half the
 *  ceiling, so the zero-config "Extract text" button does something useful
 *  without maxing the daily budget in two clicks. */
export const DEFAULT_EXTRACT_PAGES = 10;

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export type ExtractionStatus = 'pending' | 'running' | 'done' | 'failed';

/** Wire shape for one extraction run — what both POST (the created run) and
 *  GET (the run history) return. Timestamps are ISO strings; ids are JSON
 *  numbers (BIGINTs comfortably inside MAX_SAFE_INTEGER, like every other
 *  route in this codebase). */
export interface ExtractionRunDTO {
  readonly id: number;
  readonly upload_id: number;
  readonly status: ExtractionStatus;
  readonly page_from: number;
  readonly page_to: number;
  readonly pages_requested: number;
  readonly pages_ocred: number;
  readonly pages_failed: number;
  readonly vocab_inserted: number;
  readonly grammar_inserted: number;
  readonly words_skipped: number;
  readonly error: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly created_at: string;
}

/** Raw row shape (pg returns BIGINT as string, TIMESTAMPTZ as Date). */
export interface ExtractionRunRow {
  id: string;
  upload_id: string;
  status: ExtractionStatus;
  page_from: number;
  page_to: number;
  pages_requested: number;
  pages_ocred: number;
  pages_failed: number;
  vocab_inserted: number;
  grammar_inserted: number;
  words_skipped: number;
  error: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

export function toExtractionRunDTO(row: ExtractionRunRow): ExtractionRunDTO {
  return {
    id: Number(row.id),
    upload_id: Number(row.upload_id),
    status: row.status,
    page_from: row.page_from,
    page_to: row.page_to,
    pages_requested: row.pages_requested,
    pages_ocred: row.pages_ocred,
    pages_failed: row.pages_failed,
    vocab_inserted: row.vocab_inserted,
    grammar_inserted: row.grammar_inserted,
    words_skipped: row.words_skipped,
    error: row.error,
    started_at: row.started_at ? row.started_at.toISOString() : null,
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
  };
}

/** The SELECT list every run read shares (claim INSERT ... RETURNING, the
 *  settle UPDATEs, and the GET listing) so the DTO mapping stays in lockstep
 *  with one column set. */
export const RUN_COLUMNS =
  `id, upload_id, status, page_from, page_to, pages_requested, pages_ocred,
   pages_failed, vocab_inserted, grammar_inserted, words_skipped, error,
   started_at, finished_at, created_at`;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** 429 for the per-user daily Vision-page budget (config
 *  UPLOAD_EXTRACT_DAILY_PAGE_CAP). Named so logs/tests can key off it;
 *  mirrors imageIngest.ts's DailyCapError. */
export class ExtractionDailyCapError extends AppError {
  public constructor(cap: number, usedToday: number, requested: number) {
    super(
      429,
      'rate_limited',
      `daily extraction limit reached (${usedToday}/${cap} pages used today; ` +
        `this run needs ${requested} more). Try a smaller range or come back tomorrow.`,
    );
    this.name = 'ExtractionDailyCapError';
  }
}

// ---------------------------------------------------------------------------
// Curation boundary (pure — no I/O)
// ---------------------------------------------------------------------------

/** One curated word ready to persist, with the pages it appeared on. */
export interface CuratedWord {
  readonly kr: string;
  readonly en: string | null;
  readonly gloss: string | null;
  readonly pos: string | null;
  readonly pages: number[];
}

export interface CuratedBatch {
  readonly vocab: CuratedWord[];
  readonly grammar: CuratedWord[];
  /** Words dropped at this boundary (blank after sanitization, or rejected by
   *  the shared prompt-injection guard). Surfaced on the run row. */
  readonly skipped: number;
}

/** Upload types whose pages are expected to carry grammar-pattern content —
 *  drives the vocab/grammar classification below. */
const GRAMMAR_BEARING_TYPES: ReadonlySet<string> = new Set(['grammar', 'both']);

/**
 * The curation boundary: raw per-page OCR words in, persistence-ready curated
 * rows out. Pure and synchronous so it is trivially unit-testable and can
 * never hold a DB transaction hostage.
 *
 * Rules (v1 — documented in docs/BUILD_b8_f108_ocr.md):
 *   - SANITIZE: kr/en/gloss each pass through sanitizeUserInput (control-char
 *     strip + injection-marker rejection + NFC + length bound at the OCR
 *     schema's own ceilings). A rejected or blank-after-strip word is skipped
 *     and counted — never persisted, never fatal to the page.
 *   - DEDUP: one curated row per distinct headword per run (first occurrence
 *     wins for glosses; page numbers are merged, sorted, deduped) — matches
 *     the deterministic source_id so re-encounters can't fan out rows.
 *   - CLASSIFY: for grammar-bearing uploads ('grammar'/'both'), a word the
 *     OCR model left UNTAGGED for part-of-speech is treated as a grammar
 *     pattern candidate (KGIU-style pattern strings — "-았/었더니" — are not
 *     n./v./adj./adv./pn. and come back untagged); pos-tagged words are
 *     ordinary vocabulary even in a grammar book. Non-grammar uploads send
 *     everything to vocab.
 */
export function curateOcrWords(
  perPage: ReadonlyArray<{ page: number; words: readonly ImageOcrWord[] }>,
  uploadType: string,
): CuratedBatch {
  const grammarBearing = GRAMMAR_BEARING_TYPES.has(uploadType);
  const byHeadword = new Map<string, { word: CuratedWord; grammar: boolean }>();
  let skipped = 0;

  for (const { page, words } of perPage) {
    for (const raw of words) {
      let kr: string;
      let en: string | null;
      let gloss: string | null;
      try {
        // Bounds mirror the OCR result schema's own ceilings (models.ts) —
        // the real proxy validated them upstream; re-checking here means a
        // buggy/mocked proxy still can't push oversized or marker-bearing
        // text into the corpus.
        kr = sanitizeUserInput(raw.kr, { maxLength: 200 }).trim();
        en = raw.en ? sanitizeUserInput(raw.en, { maxLength: 500 }).trim() || null : null;
        gloss = raw.gloss
          ? sanitizeUserInput(raw.gloss, { maxLength: 800 }).trim() || null
          : null;
      } catch {
        // PromptInjectionRejectedError (or over-length): drop THIS word only.
        skipped += 1;
        continue;
      }
      if (kr.length === 0) {
        skipped += 1;
        continue;
      }

      const existing = byHeadword.get(kr);
      if (existing) {
        if (!existing.word.pages.includes(page)) existing.word.pages.push(page);
        continue;
      }
      const pos = raw.pos ?? null;
      byHeadword.set(kr, {
        word: { kr, en, gloss, pos, pages: [page] },
        grammar: grammarBearing && pos === null,
      });
    }
  }

  const vocab: CuratedWord[] = [];
  const grammar: CuratedWord[] = [];
  for (const { word, grammar: isGrammar } of byHeadword.values()) {
    word.pages.sort((a, b) => a - b);
    (isGrammar ? grammar : vocab).push(word);
  }
  return { vocab, grammar, skipped };
}

// ---------------------------------------------------------------------------
// Persist (inside the CALLER's transaction — mirrors imageIngest.persistCapture)
// ---------------------------------------------------------------------------

export interface PersistCounts {
  vocabInserted: number;
  grammarInserted: number;
}

/**
 * Persist a curated batch on the caller's transaction client, tagging every
 * row with source_upload_id. Runs on the SAME transaction that settles the
 * run row, so content + settlement commit-or-roll-back together (no
 * half-tagged corpus, no "done" run whose rows vanished).
 *
 * Idempotency: source_id is deterministic (`upload-{uploadId}-{kr}`), and
 * both tables carry UNIQUE (corpus, source_id) — ON CONFLICT DO NOTHING makes
 * a re-run a no-op per existing row (existing rows are never clobbered; a
 * previously curated gloss is not overwritten by a re-OCR).
 *
 * Column choices (both mirror POST /vocab/mine's user_mined insert, the
 * established route-populated pattern — see routes/vocab.ts):
 *   - corpus 'user_mined' + book_level 'beginner' sentinel + proficiency
 *     'L3' sentinel (migration 022's convention; 068 extends it to kgiu).
 *   - source_pages = the real page numbers the word appeared on (INTEGER[]),
 *     genuine provenance the viewer can deep-link.
 *   - kgiu rows: pattern = the headword (satisfies the pattern-required
 *     CHECK), entry_type 'grammar', category 'uploaded' — they surface ONLY
 *     under the owner-guarded source filter, see routes/grammar.ts.
 */
export async function persistExtraction(
  client: PoolClient,
  uploadId: number,
  batch: CuratedBatch,
): Promise<PersistCounts> {
  // Resolve the shared user_mined corpus source (seeded by migration 022) —
  // a hard dependency; fail loudly rather than mint dangling provenance.
  const src = await client.query<{ id: string }>(
    `SELECT id FROM corpus_sources WHERE corpus = 'user_mined'::corpus LIMIT 1`,
  );
  const srcRow = src.rows[0];
  if (!srcRow) {
    throw new Error('user_mined corpus_sources row missing — run migration 022');
  }
  const corpusSourceId = srcRow.id;

  let vocabInserted = 0;
  for (const w of batch.vocab) {
    const res = await client.query(
      `INSERT INTO vocab_entries (
          corpus_source_id, corpus, source_id, book_level, entry_type,
          source_book, source_pages, korean, english, part_of_speech,
          proficiency, domain, source_upload_id)
        VALUES ($1, 'user_mined'::corpus, $2, 'beginner'::book_level,
                'word'::vocab_entry_type, 'book-upload', $3, $4, $5, $6,
                'L3'::proficiency_level, 'general'::content_domain, $7)
        ON CONFLICT (corpus, source_id) DO NOTHING`,
      [
        corpusSourceId,
        sourceIdFor(uploadId, w.kr),
        w.pages,
        w.kr,
        w.en,
        w.pos,
        uploadId,
      ],
    );
    vocabInserted += res.rowCount ?? 0;
  }

  let grammarInserted = 0;
  for (const w of batch.grammar) {
    const res = await client.query(
      `INSERT INTO kgiu_entries (
          corpus_source_id, corpus, source_id, book_level, entry_type,
          source_book, source_pages, pattern, title_en, explanation,
          category, proficiency, domain, source_upload_id)
        VALUES ($1, 'user_mined'::corpus, $2, 'beginner'::book_level,
                'grammar'::kgiu_entry_type, 'book-upload', $3, $4, $5, $6,
                'uploaded', 'L3'::proficiency_level, 'general'::content_domain,
                $7)
        ON CONFLICT (corpus, source_id) DO NOTHING`,
      [
        corpusSourceId,
        sourceIdFor(uploadId, w.kr),
        w.pages,
        w.kr,
        w.en,
        w.gloss,
        uploadId,
      ],
    );
    grammarInserted += res.rowCount ?? 0;
  }

  return { vocabInserted, grammarInserted };
}

/** Deterministic per-(upload, headword) dedup key — the idempotency anchor
 *  (see module header). The headword is already sanitized/NFC-normalized by
 *  the curation boundary; it is stored as DATA via a parameterized query,
 *  never interpolated into SQL. */
export function sourceIdFor(uploadId: number, kr: string): string {
  return `upload-${uploadId}-${kr}`;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface ExtractRangeRequest {
  readonly page_from?: number;
  readonly page_to?: number;
}

interface PageRow {
  id: string;
  page_number: number;
  blob_ref: string;
}

/**
 * Run one extraction: claim → OCR → curate → persist (see the module header
 * for the transaction shape). Returns the settled run's DTO.
 *
 * Throws:
 *   - NotFoundError (404)  — upload missing or not this user's (same body).
 *   - ValidationError (400) — malformed/oversized range, or no pages in it.
 *   - ConflictError (409)  — a live run already exists for this upload.
 *   - ExtractionDailyCapError (429) — the daily Vision-page budget is spent.
 *   - mapped proxy error   — when EVERY page failed at the Vision call
 *     itself, the first proxy error is mapped through the shared
 *     mapClaudeError (429/400 pass through, 5xx flattens to 502) so the
 *     client sees the same failure classes the Images screen does. Partial
 *     failure (some pages OCR'd) still settles 'done' with pages_failed > 0.
 */
export async function runExtraction(
  uploadId: number,
  userId: number,
  requested: ExtractRangeRequest,
  log: Logger,
  correlationId: string,
): Promise<ExtractionRunDTO> {
  const cfg = loadConfig();

  // ---- tx1: CLAIM -------------------------------------------------------
  const claim = await withTransaction(async (client) => {
    // Ownership (IDOR): foreign/missing id → the same 404. FOR UPDATE holds
    // the parent so a concurrent DELETE /uploads/:id serializes against the
    // claim rather than racing it.
    const owner = await client.query<{ id: string; type: string; page_count: number | null }>(
      `SELECT id, type, page_count FROM book_uploads
        WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
      [uploadId, userId],
    );
    const upload = owner.rows[0];
    if (!upload) {
      throw new NotFoundError('upload not found');
    }

    // Resume default: start after the highest page a 'done' run reached.
    const resume = await client.query<{ last: number }>(
      `SELECT COALESCE(MAX(page_to), 0)::int AS last
         FROM upload_extractions
        WHERE upload_id = $1 AND status = 'done'`,
      [uploadId],
    );
    const lastDone = resume.rows[0]?.last ?? 0;

    const pageFrom = requested.page_from ?? lastDone + 1;
    const pageTo = requested.page_to ?? pageFrom + DEFAULT_EXTRACT_PAGES - 1;
    if (pageTo < pageFrom) {
      throw new ValidationError('page_to must be >= page_from');
    }
    const span = pageTo - pageFrom + 1;
    if (span > MAX_EXTRACT_PAGES_PER_RUN) {
      throw new ValidationError(
        `page range too large — at most ${MAX_EXTRACT_PAGES_PER_RUN} pages per run ` +
          `(requested ${span})`,
      );
    }

    const pageRows = await client.query<PageRow>(
      `SELECT id, page_number, blob_ref
         FROM book_pages
        WHERE upload_id = $1 AND page_number BETWEEN $2 AND $3
        ORDER BY page_number`,
      [uploadId, pageFrom, pageTo],
    );
    if (pageRows.rows.length === 0) {
      throw new ValidationError(
        `no pages in the requested range (${pageFrom}–${pageTo}) — the book may ` +
          'already be fully extracted, or the range is past the last page',
      );
    }

    // Daily Vision-page cap — BEFORE any upstream call, inside the claim tx
    // so two concurrent triggers can't both read a pre-spend total. Sums
    // pages_requested over ALL of today's runs (failed included — cost
    // control; a failed run spent money too).
    const cap = await client.query<{ n: string }>(
      `SELECT COALESCE(SUM(pages_requested), 0)::text AS n
         FROM upload_extractions
        WHERE user_id = $1
          AND created_at >= date_trunc('day', now())`,
      [userId],
    );
    const usedToday = Number(cap.rows[0]?.n ?? '0');
    if (usedToday + pageRows.rows.length > cfg.UPLOAD_EXTRACT_DAILY_PAGE_CAP) {
      log.warn(
        {
          uploadId,
          userId,
          usedToday,
          requestedPages: pageRows.rows.length,
          cap: cfg.UPLOAD_EXTRACT_DAILY_PAGE_CAP,
        },
        'uploadExtract: daily Vision-page cap hit — run refused before upstream',
      );
      throw new ExtractionDailyCapError(
        cfg.UPLOAD_EXTRACT_DAILY_PAGE_CAP,
        usedToday,
        pageRows.rows.length,
      );
    }

    // The claim. uq_upload_extractions_upload_live arbitrates concurrency:
    // a second live run for this upload violates the partial unique → 409.
    let runRow: ExtractionRunRow;
    try {
      const ins = await client.query<ExtractionRunRow>(
        `INSERT INTO upload_extractions
           (upload_id, user_id, status, page_from, page_to, pages_requested,
            started_at)
         VALUES ($1, $2, 'running'::upload_extraction_status, $3, $4, $5, now())
         RETURNING ${RUN_COLUMNS}`,
        [uploadId, userId, pageFrom, pageTo, pageRows.rows.length],
      );
      runRow = ins.rows[0]!;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError('an extraction is already running for this upload');
      }
      throw err;
    }

    return { runRow, pages: pageRows.rows, uploadType: upload.type };
  });

  const runId = Number(claim.runRow.id);

  // ---- OCR loop (NO transaction open) ------------------------------------
  const proxy = getClaudeProxy();
  const perPage: { page: number; words: ImageOcrWord[] }[] = [];
  let pagesOcred = 0;
  let pagesFailed = 0;
  let firstProxyError: unknown = null;

  try {
    for (const page of claim.pages) {
      let buffer: Buffer;
      try {
        // readBlob traversal-checks the stored relative path (uploadStore).
        buffer = await readBlob(page.blob_ref);
      } catch (err) {
        pagesFailed += 1;
        log.warn(
          { runId, uploadId, page: page.page_number, err: String(err) },
          'uploadExtract: page blob unreadable — page skipped',
        );
        continue;
      }
      if (buffer.length > MAX_UPLOAD_BYTES) {
        // Same 8 MiB per-image bound as the Images screen — bounds base64
        // size (the OCR input schema caps at 16M chars) and per-call cost.
        pagesFailed += 1;
        log.warn(
          { runId, uploadId, page: page.page_number, bytes: buffer.length },
          'uploadExtract: page image exceeds the OCR size limit — page skipped',
        );
        continue;
      }

      let ocr: { result: ImageOcrResult };
      try {
        ocr = await proxy.ocrImage(
          {
            imageBase64: buffer.toString('base64'),
            // blob_refs are SERVER-written with a 'jpg'/'png' extension
            // (uploadStore.saveBlob) — never client-influenced.
            mediaType: page.blob_ref.toLowerCase().endsWith('.png')
              ? 'image/png'
              : 'image/jpeg',
          },
          { requestId: correlationId, userId },
        );
      } catch (err) {
        pagesFailed += 1;
        if (firstProxyError === null) firstProxyError = err;
        log.warn(
          { runId, uploadId, page: page.page_number, err: String(err) },
          'uploadExtract: Vision OCR failed for page — page skipped',
        );
        continue;
      }
      pagesOcred += 1;
      perPage.push({ page: page.page_number, words: [...(ocr.result.words ?? [])] });
    }

    if (pagesOcred === 0) {
      // Nothing usable came back. Settle failed; if the failures were the
      // proxy's, surface the same mapped class (429/400/502) the Images
      // screen would — otherwise (all blobs missing/oversize) throw a plain
      // 502-shaped AppError with a run-specific message.
      const summary = `all ${claim.pages.length} pages in the range failed OCR`;
      await settleFailed(runId, summary, pagesOcred, pagesFailed);
      if (firstProxyError !== null) {
        throw mapClaudeError(firstProxyError);
      }
      throw new AppError(502, 'upstream_error', summary);
    }

    // ---- CURATION (pure) + tx2: PERSIST -----------------------------------
    const batch = curateOcrWords(perPage, claim.uploadType);

    const settled = await withTransaction(async (client) => {
      const counts = await persistExtraction(client, uploadId, batch);
      const upd = await client.query<ExtractionRunRow>(
        `UPDATE upload_extractions
            SET status = 'done'::upload_extraction_status,
                pages_ocred = $2,
                pages_failed = $3,
                vocab_inserted = $4,
                grammar_inserted = $5,
                words_skipped = $6,
                finished_at = now()
          WHERE id = $1 AND status = 'running'
          RETURNING ${RUN_COLUMNS}`,
        [
          runId,
          pagesOcred,
          pagesFailed,
          counts.vocabInserted,
          counts.grammarInserted,
          batch.skipped,
        ],
      );
      const row = upd.rows[0];
      if (!row) {
        // The run row is gone or no longer 'running' — the upload (and via
        // CASCADE the run) was deleted mid-OCR. Abort the tx so no orphan
        // content lands (the source_upload_id FK would have rejected the
        // inserts anyway had the parent vanished first).
        throw new NotFoundError('upload was deleted while extraction was in flight');
      }
      return row;
    });

    log.info(
      {
        runId,
        uploadId,
        pagesOcred,
        pagesFailed,
        vocabInserted: settled.vocab_inserted,
        grammarInserted: settled.grammar_inserted,
        wordsSkipped: settled.words_skipped,
      },
      'uploadExtract: run settled done',
    );
    return toExtractionRunDTO(settled);
  } catch (err) {
    // Best-effort failure settlement for anything that escaped after the
    // claim (persist rollback, mid-run deletion, mapped proxy error already
    // settled above is a no-op thanks to the status guard). Never masks the
    // original error.
    await settleFailed(runId, errorSummary(err), pagesOcred, pagesFailed);
    throw err;
  }
}

/** Mark a claimed run failed (best-effort, own statement — runs OUTSIDE any
 *  aborted transaction). The `status = 'running'` guard makes it a no-op if
 *  the run already settled or was CASCADE-deleted. */
async function settleFailed(
  runId: number,
  error: string,
  pagesOcred: number,
  pagesFailed: number,
): Promise<void> {
  try {
    await query(
      `UPDATE upload_extractions
          SET status = 'failed'::upload_extraction_status,
              error = left($2, 2000),
              pages_ocred = $3,
              pages_failed = $4,
              finished_at = now()
        WHERE id = $1 AND status = 'running'`,
      [runId, error, pagesOcred, pagesFailed],
    );
  } catch {
    // Swallow: settlement is diagnostics; the caller is already propagating
    // the real failure and must not have it masked by a bookkeeping error.
  }
}

/** Postgres unique-violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    (err as { code?: string }).code === '23505'
  );
}

/** Bounded, log-safe failure summary for the run row. AppErrors carry curated
 *  messages; anything else is stringified defensively. */
function errorSummary(err: unknown): string {
  if (err instanceof AppError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
