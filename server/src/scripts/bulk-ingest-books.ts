/**
 * bulk-ingest-books CLI — operator bulk load of scanned-book archives.
 *
 * Loads every archive in the corpus manifest (src/scripts/
 * corpus-books.manifest.ts) from an on-disk directory into the app as
 * `book_uploads` + `book_pages` rows for one user, reusing the EXACT
 * normalization + persistence pipeline the HTTP upload route uses
 * (services/bookUploadIngest.ts, services/zipPageExtract.ts,
 * services/pdfPageRender.ts) — no bespoke ingest logic, zero drift risk.
 *
 * WHY a CLI instead of the route: `POST /uploads` enforces a per-user DAILY
 * cap (BOOK_UPLOAD_DAILY_CAP, default 10) via `ingestUpload`, which would
 * block a 17-book batch. The cap is an anti-runaway backstop for the HTTP
 * surface, not a business rule — so this operator path deliberately SKIPS
 * `ingestUpload` (whose only job beyond what this script already does —
 * presence check, magic-byte sniff, normalization — is that cap check) and
 * calls `persistUpload` directly. Like the sibling CLIs (seed-user.ts,
 * mfa-reset.ts): possession of shell + DB access IS the authorization
 * boundary; there is no network auth here.
 *
 * IDEMPOTENT — safe to re-run. `persistUpload` UPSERTs `book_uploads` on
 * (user_id, title) and REPLACES the book's `book_pages` outright, so
 * re-running with the same manifest replaces each book's pages in place —
 * never duplicates a book. A changed `type` in the manifest re-tags the
 * existing book on re-run. (Renaming a TITLE creates a NEW book — the title
 * is the idempotency key; see corpus-books.manifest.ts.)
 *
 * Per-book flow (all file/CPU work happens BEFORE the transaction opens —
 * Bar §"Concurrency": no external I/O inside an open tx):
 *   1. read `<dir>/<file>` into a buffer (a MISSING file warns + skips the
 *      entry; the rest of the batch continues);
 *   2. magic-byte sniff (zip `PK\x03\x04` vs. PDF `%PDF-`) → normalize to
 *      ordered page images (`extractZipPages` / `renderPdfPagesToJpeg`);
 *   3. BEGIN → `persistUpload` (page blobs + book_uploads UPSERT +
 *      book_pages rows) → COMMIT; ROLLBACK + record the failure on error;
 *   4. after commit, best-effort unlink the REPLACED pages' prior blobs
 *      (mirrors routes/uploads.ts POST: cleanup only after the commit, and a
 *      delete failure only warns — an orphan file is harmless/GC-able,
 *      never worth failing a book that already committed).
 *
 * Failure policy: each book is its own transaction; one bad archive rolls
 * back ONLY that book. Failures are collected and reported at the end, and
 * the process exits non-zero if ANY book failed (so a driving script can't
 * mistake a partial batch for success).
 *
 * Usage:
 *   node dist/scripts/bulk-ingest-books.js --dir /path/to/zips [--user 1]
 *        [--dry-run] [--only <title-substring>]
 *
 *   --dir      REQUIRED. Directory holding the manifest's archive files.
 *   --user     Target user id (default 1 — the single seeded account).
 *   --dry-run  Normalize + report page counts only; NO database writes, no
 *              blob writes, no DB connection ever opened (DATABASE_URL must
 *              still be set — config validates at load — but is never dialed).
 *   --only     Case-insensitive title substring filter — process just the
 *              matching manifest entries (for testing one book).
 */
import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { PoolClient } from 'pg';
import { getPool, closePool } from '../db/pool.js';
import {
  BOOK_UPLOAD_TYPES,
  persistUpload,
  sniffPdfMagicBytes,
  sniffZipMagicBytes,
  type IngestedPage,
  type IngestedUpload,
} from '../services/bookUploadIngest.js';
import { extractZipPages } from '../services/zipPageExtract.js';
import { renderPdfPagesToJpeg } from '../services/pdfPageRender.js';
import { deleteBlob } from '../services/uploadStore.js';
import { getLogger } from '../logging.js';
import { CORPUS_MANIFEST, type CorpusBookEntry } from './corpus-books.manifest.js';

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

/**
 * Validate the whole manifest BEFORE any file is read or row written, so a
 * hand-edit typo (the manifest is meant to be edited) fails the run up front
 * rather than after N books have already been ingested:
 *   - every `type` must be a member of BOOK_UPLOAD_TYPES (the DB enum — a bad
 *     value would otherwise surface as a mid-batch Postgres cast error);
 *   - `file`/`title` non-empty;
 *   - titles unique (duplicate titles would silently UPSERT-overwrite each
 *     other within one run — always an editing mistake, never intended).
 */
export function assertValidManifest(entries: readonly CorpusBookEntry[]): void {
  const seenTitles = new Set<string>();
  for (const entry of entries) {
    if (!entry.file || entry.file.trim() === '') {
      throw new Error(`manifest entry "${entry.title}" has an empty file name`);
    }
    if (!entry.title || entry.title.trim() === '') {
      throw new Error(`manifest entry "${entry.file}" has an empty title`);
    }
    if (!(BOOK_UPLOAD_TYPES as readonly string[]).includes(entry.type)) {
      throw new Error(
        `manifest entry "${entry.title}" has invalid type "${String(entry.type)}" ` +
          `(must be one of: ${BOOK_UPLOAD_TYPES.join(', ')})`,
      );
    }
    if (seenTitles.has(entry.title)) {
      throw new Error(`manifest has duplicate title "${entry.title}" — titles are the idempotency key`);
    }
    seenTitles.add(entry.title);
  }
}

// ---------------------------------------------------------------------------
// Per-entry ingest (the testable seam)
// ---------------------------------------------------------------------------

/**
 * Read `<dir>/<entry.file>` and normalize it to an `IngestedUpload` (ordered
 * page images + metadata) WITHOUT touching the database — the shared
 * pre-transaction half. Used directly by `--dry-run`.
 *
 * Throws on: an invalid manifest type (checked here so no caller can reach a
 * write with a bad type), an unreadable file, bytes that are neither zip nor
 * PDF, a zip-bomb guard trip, or an archive with zero usable pages.
 */
export async function loadAndNormalize(
  dir: string,
  entry: CorpusBookEntry,
): Promise<IngestedUpload> {
  // Re-validate this entry's type even though runBulkIngest validates the whole
  // manifest — ingestOne is exported and must be safe to call standalone.
  assertValidManifest([entry]);

  const filePath = join(dir, entry.file);
  const buffer = await readFile(filePath);
  if (buffer.length === 0) {
    throw new Error(`"${entry.file}" is empty (0 bytes)`);
  }

  let pages: IngestedPage[];
  if (sniffZipMagicBytes(buffer)) {
    pages = await extractZipPages(buffer);
  } else if (sniffPdfMagicBytes(buffer)) {
    pages = (await renderPdfPagesToJpeg(buffer)).map((pageBuffer) => ({
      buffer: pageBuffer,
      mime: 'image/jpeg' as const,
    }));
  } else {
    throw new Error(
      `"${entry.file}" is neither a zip archive (PK\\x03\\x04) nor a PDF (%PDF-)`,
    );
  }
  if (pages.length === 0) {
    throw new Error(`"${entry.file}" contained no usable image pages (jpg/png)`);
  }

  return {
    pages,
    byteSize: buffer.length,
    title: entry.title,
    type: entry.type,
  };
}

/** Outcome of ingesting one manifest entry (post-commit). */
export interface IngestOneResult {
  readonly uploadId: string;
  readonly title: string;
  readonly type: CorpusBookEntry['type'];
  readonly pageCount: number;
  readonly wasNew: boolean;
  /** Prior pages' blob refs this run replaced (already best-effort unlinked). */
  readonly priorBlobRefs: readonly string[];
  /** How many of `priorBlobRefs` failed to unlink (left as harmless orphans). */
  readonly priorBlobUnlinkFailures: number;
}

/**
 * Ingest ONE manifest entry on the given client: normalize (before the tx
 * opens), then BEGIN → `persistUpload` → COMMIT (ROLLBACK + rethrow on any
 * error), then best-effort unlink the replaced pages' prior blobs.
 *
 * The client is caller-owned (connect/release stays with the caller) so tests
 * can drive this seam directly with a testcontainer client — no CLI, no
 * global pool.
 *
 * Explicit BEGIN/COMMIT rather than `withTransaction` because that helper
 * owns the connect/release lifecycle of a pool-drawn client, and this seam
 * deliberately accepts an EXTERNAL client. The rollback path mirrors
 * withTransaction's contract: rollback, surface a rollback failure without
 * masking the original error, rethrow the original.
 */
export async function ingestOne(
  client: PoolClient,
  dir: string,
  entry: CorpusBookEntry,
  userId: number,
): Promise<IngestOneResult> {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(`userId must be a positive integer (got ${String(userId)})`);
  }

  // All file/CPU work BEFORE the transaction opens (Bar §"Concurrency").
  const ingested = await loadAndNormalize(dir, entry);

  await client.query('BEGIN');
  let persisted;
  try {
    persisted = await persistUpload(client, userId, ingested);
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      getLogger().error(
        { err: String(rollbackErr), title: entry.title },
        'bulk-ingest: ROLLBACK failed after ingest error',
      );
    }
    throw err;
  }

  // Post-commit cleanup of the REPLACED pages' blobs (same-title re-run).
  // Best-effort by design — mirrors routes/uploads.ts POST: the new rows are
  // already committed, and a leftover orphan file is harmless (GC-able), so a
  // delete failure warns and moves on rather than failing the book.
  let priorBlobUnlinkFailures = 0;
  for (const blobRef of persisted.priorBlobRefs) {
    try {
      await deleteBlob(blobRef);
    } catch (err) {
      priorBlobUnlinkFailures += 1;
      getLogger().warn(
        { err: String(err), blobRef, title: entry.title },
        'bulk-ingest: failed to delete replaced page blob (orphaned, non-fatal)',
      );
    }
  }

  return {
    uploadId: persisted.dto.id,
    title: persisted.dto.title,
    type: persisted.dto.type,
    pageCount: ingested.pages.length,
    wasNew: persisted.wasNew,
    priorBlobRefs: persisted.priorBlobRefs,
    priorBlobUnlinkFailures,
  };
}

// ---------------------------------------------------------------------------
// Batch runner
// ---------------------------------------------------------------------------

export interface BulkIngestOptions {
  /** Directory holding the manifest's archive files. */
  readonly dir: string;
  /** Target user id (`book_uploads.user_id`). */
  readonly userId: number;
  /** Normalize + report only — no DB connection, no writes of any kind. */
  readonly dryRun: boolean;
  /** Case-insensitive title substring filter (process matching entries only). */
  readonly only?: string;
  /** Manifest override (tests). Defaults to CORPUS_MANIFEST. */
  readonly manifest?: readonly CorpusBookEntry[];
}

export interface BulkIngestSummary {
  readonly dryRun: boolean;
  /** Books persisted (or, under --dry-run, successfully normalized). */
  readonly ingested: number;
  readonly created: number;
  readonly replaced: number;
  readonly totalPages: number;
  /** Manifest files not found under --dir (warned + skipped). */
  readonly skippedMissing: readonly string[];
  readonly failures: readonly { title: string; error: string }[];
}

/**
 * Run the batch: validate the manifest up front, then process each entry
 * SEQUENTIALLY (deliberate — each archive can be a ~240 MB buffer plus its
 * decoded pages; one-at-a-time bounds peak memory the way the route's
 * effectively-serial usage does). A missing file warns + skips; any other
 * per-entry error is recorded and the batch continues; the caller decides
 * what a non-empty `failures` means (the CLI exits non-zero).
 */
export async function runBulkIngest(opts: BulkIngestOptions): Promise<BulkIngestSummary> {
  const log = getLogger();
  const manifest = opts.manifest ?? CORPUS_MANIFEST;

  // Fail fast on a bad manifest or a bad --dir before touching anything.
  assertValidManifest(manifest);
  const dirStat = await stat(opts.dir).catch(() => null);
  if (!dirStat?.isDirectory()) {
    throw new Error(`--dir "${opts.dir}" is not a readable directory`);
  }

  let entries = manifest;
  if (opts.only !== undefined) {
    const needle = opts.only.toLowerCase();
    entries = manifest.filter((e) => e.title.toLowerCase().includes(needle));
    if (entries.length === 0) {
      throw new Error(`--only "${opts.only}" matched no manifest titles`);
    }
  }

  let created = 0;
  let replaced = 0;
  let totalPages = 0;
  const skippedMissing: string[] = [];
  const failures: { title: string; error: string }[] = [];

  for (const entry of entries) {
    const filePath = join(opts.dir, entry.file);
    const missing = await access(filePath).then(
      () => false,
      () => true,
    );
    if (missing) {
      log.warn({ file: entry.file, title: entry.title }, 'bulk-ingest: file missing — skipped');
      console.warn(`bulk-ingest: MISSING ${filePath} — skipped ("${entry.title}")`);
      skippedMissing.push(entry.file);
      continue;
    }

    try {
      if (opts.dryRun) {
        const ingested = await loadAndNormalize(opts.dir, entry);
        totalPages += ingested.pages.length;
        created += 1; // counts as "would ingest" under --dry-run
        console.error(
          `bulk-ingest: ${entry.title} | ${entry.type} | ${ingested.pages.length} pages | (dry-run, not written)`,
        );
      } else {
        // getPool() only here — --dry-run must work with no REACHABLE DB at
        // all (config still requires DATABASE_URL to be set, but a dry run
        // never opens a connection; the pool is lazily constructed + cached).
        const client = await getPool().connect();
        let result: IngestOneResult;
        try {
          result = await ingestOne(client, opts.dir, entry, opts.userId);
        } finally {
          client.release();
        }
        totalPages += result.pageCount;
        if (result.wasNew) created += 1;
        else replaced += 1;
        log.info(
          {
            uploadId: result.uploadId,
            title: result.title,
            type: result.type,
            pages: result.pageCount,
            wasNew: result.wasNew,
            priorBlobsReplaced: result.priorBlobRefs.length,
            priorBlobUnlinkFailures: result.priorBlobUnlinkFailures,
          },
          'bulk-ingest: book ingested',
        );
        console.error(
          `bulk-ingest: ${result.title} | ${result.type} | ${result.pageCount} pages | ` +
            `upload ${result.uploadId} | ${result.wasNew ? 'new' : 'replaced'}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ title: entry.title, error: message });
      log.error({ title: entry.title, err: message }, 'bulk-ingest: book failed');
      console.error(`bulk-ingest: FAILED "${entry.title}" — ${message}`);
    }
  }

  const ingested = created + replaced;
  console.error(
    `bulk-ingest: done${opts.dryRun ? ' (dry-run — nothing written)' : ''} — ` +
      `${ingested} ingested (${created} new, ${replaced} replaced), ` +
      `${totalPages} pages total, ${skippedMissing.length} missing-file skip(s), ` +
      `${failures.length} failure(s)`,
  );
  for (const failure of failures) {
    console.error(`bulk-ingest:   failed: "${failure.title}" — ${failure.error}`);
  }

  return { dryRun: opts.dryRun, ingested, created, replaced, totalPages, skippedMissing, failures };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

const USAGE =
  'usage: bulk-ingest-books --dir <path> [--user <id>] [--dry-run] [--only <title-substring>]';

/** Parse + validate argv (exported for tests; throws with USAGE on bad input). */
export function parseCliArgs(argv: readonly string[]): BulkIngestOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      dir: { type: 'string' },
      user: { type: 'string', default: '1' },
      'dry-run': { type: 'boolean', default: false },
      only: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });

  if (!values.dir) {
    throw new Error(`--dir is required. ${USAGE}`);
  }
  const userId = Number(values.user);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(`--user must be a positive integer (got "${String(values.user)}"). ${USAGE}`);
  }

  return {
    dir: values.dir,
    userId,
    dryRun: values['dry-run'] ?? false,
    ...(values.only !== undefined ? { only: values.only } : {}),
  };
}

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2));
  const summary = await runBulkIngest(opts);
  if (summary.failures.length > 0) {
    // Non-zero exit if ANY book errored (the rest were still processed above).
    throw new Error(
      `${summary.failures.length} of ${summary.failures.length + summary.ingested} processed book(s) failed — see log above`,
    );
  }
}

// Run only when invoked directly as a CLI, NOT when the module is imported —
// importing this file must not execute DB I/O. Mirrors the entrypoint guard in
// seed-user.ts / mfa-reset.ts / src/index.ts.
if (require.main === module) {
  main()
    .then(async () => {
      await closePool();
      process.exit(0);
    })
    .catch(async (err: unknown) => {
      console.error(`bulk-ingest: FAILED — ${(err as Error).message}`);
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}
