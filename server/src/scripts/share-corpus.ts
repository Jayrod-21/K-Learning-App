/**
 * share-corpus CLI — the ONE-TIME F-207 phase-2 cutover (plan §2/§6).
 *
 * Flips `is_shared = true` (migration 079) on the corpus OWNER's CURRENT
 * `audio_sources` and `book_uploads` rows: "everything the owner has now
 * becomes the shared curated library; future uploads stay private" (locked
 * decision, LISTEN_SHARED_CORPUS_PLAN.md §2). This is a data UPDATE only —
 * no schema change, no re-owning (`user_id` is untouched, so every composite
 * owner FK stays intact).
 *
 * NOTE — SCOPE IS DELIBERATELY "EVERYTHING": this flips ALL of the owner's
 * current sets/books, including e.g. the topik-mock audio sets. That is
 * intentional per the locked "everything I have now" decision; the operator
 * reviews the dry-run enumeration before applying.
 *
 * Inputs (env):
 *   SHARE_CORPUS_OWNER_EMAIL — the corpus owner's account email. Trimmed +
 *                              lowercased. Default: jaredmwilliams.me@gmail.com
 *                              (the seed-admin default). No such user → exit 2.
 *   SHARE_CORPUS_APPLY       — 'true' to WRITE. Anything else (or unset) is a
 *                              DRY RUN: enumerate + report, ZERO writes.
 *
 * DRY-RUN BY DEFAULT: without SHARE_CORPUS_APPLY=true the script only SELECTs
 * (no UPDATE is ever issued) and prints every audio set (slug + title) and
 * book (title) that WOULD flip, plus already-shared counts, with a prominent
 * "DRY RUN — no changes written" warning.
 *
 * APPLY: the same enumeration, then two parameterized UPDATEs
 * (`... SET is_shared = true WHERE user_id = $1 AND is_shared = false`) in a
 * SINGLE transaction with the enumeration; the actual rowcounts are reported
 * and cross-checked against the enumerated candidates (a mismatch — e.g. a
 * concurrent insert racing the cutover — rolls the whole transaction back).
 * Accepted limitation: that audit invariant compares row COUNTS, not id-SETS,
 * which is sufficient for this one-time single-operator cutover.
 *
 * Idempotent: re-running after apply finds nothing with is_shared = false →
 * "0 to share, K already shared", zero rows written, exit 0.
 *
 * Security / safety:
 *   - Scoped to the resolved owner's rows ONLY (every statement carries
 *     `user_id = $1`); no other user's content can be flipped.
 *   - Everything is $n-parameterized; no string interpolation into SQL.
 *   - Logs the owner email, per-row slugs/titles, and counts — never any
 *     secret (this script never touches passwords or tokens at all).
 *   - `is_shared` is operator-set only (no user endpoint writes it — plan §5
 *     "share-flag hijack"); this script is the single sanctioned writer.
 *
 * Exit codes: 0 ok · 1 failure · 2 bad input (unknown/empty owner email).
 * 0/1 follow seed-user.ts; the exit-2 bad-input path is share-corpus's own
 * contract — seed-user has no equivalent.
 *
 * Run inside the ACTIVE color's server container (it already holds
 * DATABASE_URL on km-internal — same posture as Deploy/seed-admin.sh).
 * The active color is ACTIVE_ENVIRONMENT in Deploy/.env (or run
 * Deploy/check-active-env.sh --get-active):
 *   dry-run: docker exec km-server-<active> node dist/scripts/share-corpus.js
 *   apply:   docker exec -e SHARE_CORPUS_APPLY=true km-server-<active> \
 *              node dist/scripts/share-corpus.js
 */
import { closePool, withTransaction } from '../db/pool.js';
import { getLogger } from '../logging.js';

export const DEFAULT_OWNER_EMAIL = 'jaredmwilliams.me@gmail.com';

/** Bad-input failure (unknown/empty owner email) → exit 2, not 1. */
export class ShareCorpusInputError extends Error {}

/** Map a main() rejection to the CLI exit code: 2 bad input, 1 anything else. */
export function exitCodeFor(err: unknown): 1 | 2 {
  return err instanceof ShareCorpusInputError ? 2 : 1;
}

export interface ShareCorpusOptions {
  ownerEmail: string;
  apply: boolean;
}

/** Parse the SHARE_CORPUS_* env inputs (seed-user's env-flag style). */
export function parseEnv(env: NodeJS.ProcessEnv): ShareCorpusOptions {
  return {
    ownerEmail: (env.SHARE_CORPUS_OWNER_EMAIL ?? DEFAULT_OWNER_EMAIL).trim().toLowerCase(),
    apply: (env.SHARE_CORPUS_APPLY ?? '').trim().toLowerCase() === 'true',
  };
}

export interface AudioSetLine {
  id: number;
  slug: string;
  title: string;
}

export interface BookLine {
  id: number;
  title: string;
}

export interface ShareCorpusSummary {
  apply: boolean;
  ownerEmail: string;
  ownerId: number;
  /** Enumerated candidates (is_shared = false at snapshot time). */
  audioToShare: AudioSetLine[];
  booksToShare: BookLine[];
  /** Owner rows that were already is_shared = true (prior run / idempotence). */
  audioAlreadyShared: number;
  booksAlreadyShared: number;
  /** Actual UPDATE rowcounts. Always 0 on a dry run (no UPDATE is issued). */
  audioFlipped: number;
  booksFlipped: number;
}

interface OwnedFlagRow {
  id: number; // BIGINT IDENTITY — the int8 parser returns a number
  slug?: string;
  title: string;
  is_shared: boolean;
}

/**
 * Resolve the owner, enumerate their un-shared sets/books, and (apply only)
 * flip them — all on ONE connection in ONE transaction, so the reported
 * enumeration and the UPDATE rowcounts describe the same snapshot. On a dry
 * run no UPDATE is ever issued (the transaction contains only SELECTs).
 */
export async function runShareCorpus(opts: ShareCorpusOptions): Promise<ShareCorpusSummary> {
  const ownerEmail = opts.ownerEmail.trim().toLowerCase();
  if (ownerEmail === '') {
    throw new ShareCorpusInputError('SHARE_CORPUS_OWNER_EMAIL is empty');
  }

  return withTransaction(async (client) => {
    const owner = await client.query<{ id: number }>('SELECT id FROM users WHERE email = $1', [
      ownerEmail,
    ]);
    if (owner.rows[0] === undefined) {
      throw new ShareCorpusInputError(
        `no user with email ${ownerEmail} — check SHARE_CORPUS_OWNER_EMAIL; nothing was changed`,
      );
    }
    const ownerId = Number(owner.rows[0].id);

    // Enumerate the owner's CURRENT rows (deterministic order for the
    // operator's review). Owner-scoped: user_id = $1 on every statement.
    const audio = await client.query<OwnedFlagRow>(
      `SELECT id, slug, title, is_shared
         FROM audio_sources
        WHERE user_id = $1
        ORDER BY slug`,
      [ownerId],
    );
    const books = await client.query<OwnedFlagRow>(
      `SELECT id, title, is_shared
         FROM book_uploads
        WHERE user_id = $1
        ORDER BY title`,
      [ownerId],
    );

    const audioToShare: AudioSetLine[] = audio.rows
      .filter((r) => !r.is_shared)
      .map((r) => ({ id: Number(r.id), slug: r.slug ?? '', title: r.title }));
    const booksToShare: BookLine[] = books.rows
      .filter((r) => !r.is_shared)
      .map((r) => ({ id: Number(r.id), title: r.title }));
    const audioAlreadyShared = audio.rows.length - audioToShare.length;
    const booksAlreadyShared = books.rows.length - booksToShare.length;

    let audioFlipped = 0;
    let booksFlipped = 0;
    if (opts.apply) {
      const audioUpdate = await client.query(
        `UPDATE audio_sources
            SET is_shared = true
          WHERE user_id = $1 AND is_shared = false`,
        [ownerId],
      );
      audioFlipped = audioUpdate.rowCount ?? 0;
      const bookUpdate = await client.query(
        `UPDATE book_uploads
            SET is_shared = true
          WHERE user_id = $1 AND is_shared = false`,
        [ownerId],
      );
      booksFlipped = bookUpdate.rowCount ?? 0;

      // Audit invariant: what we flip must be exactly what we enumerated. A
      // mismatch means something raced the cutover (e.g. an upload landing
      // mid-run under READ COMMITTED) — abort and roll EVERYTHING back rather
      // than commit a set of rows the operator never reviewed.
      if (audioFlipped !== audioToShare.length || booksFlipped !== booksToShare.length) {
        throw new Error(
          `flip count diverged from the reviewed enumeration ` +
            `(audio ${String(audioFlipped)} != ${String(audioToShare.length)} or ` +
            `books ${String(booksFlipped)} != ${String(booksToShare.length)}) — ` +
            `rolled back; re-run the dry-run and review again`,
        );
      }
    }

    return {
      apply: opts.apply,
      ownerEmail,
      ownerId,
      audioToShare,
      booksToShare,
      audioAlreadyShared,
      booksAlreadyShared,
      audioFlipped,
      booksFlipped,
    };
  });
}

/** Operator-facing report on stderr (same channel as seed-user). No secrets. */
export function reportSummary(summary: ShareCorpusSummary): void {
  // eslint-disable-next-line no-console
  const print = (line: string): void => console.error(line);

  const mode = summary.apply ? 'APPLY' : 'DRY RUN';
  print(`share-corpus [${mode}]: owner ${summary.ownerEmail} (id=${String(summary.ownerId)})`);

  const verb = summary.apply ? 'shared' : 'would share';
  for (const set of summary.audioToShare) {
    print(`  audio  ${verb}: ${set.slug} — ${set.title} (id=${String(set.id)})`);
  }
  for (const book of summary.booksToShare) {
    print(`  book   ${verb}: ${book.title} (id=${String(book.id)})`);
  }

  const alreadyShared = summary.audioAlreadyShared + summary.booksAlreadyShared;
  if (summary.apply) {
    print(
      `share-corpus: FLIPPED ${String(summary.audioFlipped)} audio sets, ` +
        `${String(summary.booksFlipped)} books to is_shared = true; ` +
        `${String(alreadyShared)} already shared (untouched).`,
    );
  } else {
    print(
      `share-corpus: ${String(summary.audioToShare.length)} audio sets, ` +
        `${String(summary.booksToShare.length)} books will be shared; ` +
        `${String(alreadyShared)} already shared.`,
    );
    print(
      'share-corpus: DRY RUN — no changes written; set SHARE_CORPUS_APPLY=true to apply.',
    );
  }
}

async function main(): Promise<void> {
  const log = getLogger();
  const opts = parseEnv(process.env);
  const summary = await runShareCorpus(opts);
  reportSummary(summary);
  log.info(
    {
      apply: summary.apply,
      ownerEmail: summary.ownerEmail,
      ownerId: summary.ownerId,
      audioToShare: summary.audioToShare.length,
      booksToShare: summary.booksToShare.length,
      audioAlreadyShared: summary.audioAlreadyShared,
      booksAlreadyShared: summary.booksAlreadyShared,
      audioFlipped: summary.audioFlipped,
      booksFlipped: summary.booksFlipped,
    },
    'share-corpus: run complete',
  );
}

// Run only when invoked directly as a CLI, NOT when imported — importing this
// file must never execute DB I/O. Mirrors seed-user.ts.
if (require.main === module) {
  main()
    .then(async () => {
      await closePool();
      process.exit(0);
    })
    .catch(async (err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`share-corpus: FAILED — ${(err as Error).message}`);
      await closePool().catch(() => undefined);
      process.exit(exitCodeFor(err));
    });
}
