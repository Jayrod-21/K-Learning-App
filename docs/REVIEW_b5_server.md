# Review — Batch 5 server + DB half (F-107 upload provenance)

Reviewer: independent senior review (server/DB scope only).
Branch: `feat/b5-uploads-provenance` @ worktree, diffed vs `origin/rebuild`.
Files reviewed: `server/src/routes/vocab.ts`, `server/src/routes/grammar.ts`,
`db/migrations/068_grammar_entries_source_upload.{up,down}.sql`,
`db/tests/test_migration_068.py`, `server/tests/routes/vocab.test.ts`,
`server/tests/routes/grammar.test.ts`. Supporting code read to verify claims:
`server/src/db/pool.ts` (withTransaction), `db/migrations/040_book_uploads.up.sql`
(FK naming), `db/migrations/012_vocab_lists.up.sql` (list-entry hard-delete),
`server/tests/helpers/seed.ts`. Static review; suites not executed here.

## Summary verdict: PASS WITH CONDITIONS

No blockers. The security-sensitive surface — ownership gating on the write
paths, the no-oracle 404, the user-scoped read join, the FK race window — is
handled correctly and is covered by real cross-user tests. Two SHOULD-FIX
items to track (neither merge-blocking for a single-user deployment): the
cross-user first-write-wins semantics on the shared `vocab_entries` row
silently drop a legitimate second user's provenance, and the 500-row cap on
`GET /vocab/saved-from-uploads` truncates without any signal.

## Bar checklist

| Bar item | Status | Evidence |
|---|---|---|
| Parameterized SQL, no interpolation of user input | PASS | All new queries bind params: vocab.ts:690-696, 724-756, 852-896; grammar.ts bank upsert. The only template literals in vocab SQL are server-side constants (`ISO_WEEK_SQL`, `BUCKET_CASE`), pre-existing and never client input. |
| New queries user-scoped; unowned upload id → identical 404, no tag, no leak | PASS | vocab.ts:689-701, grammar.ts ownership check (same `SELECT 1 … WHERE id=$1 AND user_id=$2`); both throw `NotFoundError('upload not found')` for unowned and nonexistent alike. Read path ownership on the join: vocab.ts:891-893. |
| In-transaction ownership check | PASS | Both checks run inside `withTransaction` (vocab.ts:681-701; grammar.ts wraps the whole bank upsert). `withTransaction` (pool.ts:128-171) rolls back on throw and rethrows the original error. |
| No swallowed errors; typed AppErrors | PASS | `NotFoundError` for 404s; all other errors flow to `next(err)`. The 23503 guards are constraint-name-scoped so unrelated integrity errors stay loud (vocab.ts:799-806; grammar.ts:270-277). |
| Race safety on the FK (23503) | PASS | Concurrent upload hard-delete between check and write maps to the same 404 via constraint-scoped 23503 handling in both routes. COALESCE first-write-wins is itself race-safe: `ON CONFLICT DO UPDATE` locks and re-evaluates against the latest committed row version. |
| GET grouping correctness (cards ∪ lists, dedup earliest save, ownership on join, row cap) | PASS | vocab.ts:852-896 — `UNION ALL` + `MIN` in `first_saves` dedups to the earliest save; `bu.user_id = $1` lives on the join; cap bound as `$2`. `vocab_list_entries` is hard-deleted (012_vocab_lists.up.sql:133-136), so no missing soft-delete predicate on that leg; the lists leg does filter `vl.deleted_at IS NULL`. Cap is silent — see SF-2. |
| Strict TS / zod at boundaries | PASS | Body fields `z.number().int().positive().max(MAX_ID)` without coerce (JSON body — correct; vocab.ts:624, grammar.ts BankBodySchema), matching the coerced query-param variant. `MineBodySchema` remains `.strict()`. Garbage-value 400s tested in both suites. |
| Migration additive + reversible + idempotent | PASS | Up is `ADD COLUMN IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` only (068 up:39-57); down is `DROP INDEX IF EXISTS` + `DROP COLUMN IF EXISTS` (068 down:14-18); no BEGIN/COMMIT (ADR-013 respected). Re-up over a populated table proven by test. |
| F-088 markers present + correct | PASS | Up line 1 `-- migrate: non-destructive`, down line 1 `-- migrate: destructive`; both asserted via `migrate.explicit_destructiveness` (test_migration_068.py:168-178) and the gate-refusal path is exercised (down without `--allow-destructive` must fail, :270-273). |
| Named FK + partial index | PASS | `CONSTRAINT fk_grammar_entries_source_upload` (068 up:41), `ix_grammar_entries_source_upload … WHERE source_upload_id IS NOT NULL` (068 up:55-57). |
| Both migration directions tested | PASS | Up-applies-without-flag, FK rejects dangling id, ON DELETE SET NULL untags but keeps the row, gated down drops the column with rows present, clean re-up (test_migration_068.py:181-339). Real runner, real files, testcontainer Postgres. |
| Tests exercise real behavior, not tautologies | PASS | Cross-user attack tests assert both the 404 AND rollback via row counts (grammar.test.ts "no row persists"; vocab.test.ts "nothing persists"); the leak test has user B holding a card on an entry tagged to A's upload and asserts B gets `[]`. Each would fail if the corresponding check were removed. |
| Backward compat (save with no source_upload_id still succeeds) | PASS | Explicit tests: "a bank without source_upload_id stays untagged", "a mine without source_upload_id stays untagged" — both 201, NULL provenance. |

## Findings by category

- BLOCKER: none.
- SHOULD-FIX: 2 (SF-1, SF-2).
- NIT: 4 (N-1 … N-4).
- PRAISE: 4 (P-1 … P-4).

## Detailed findings

### SF-1 — Cross-user first-write-wins on the shared `vocab_entries` row silently loses a legitimate user's provenance
`server/src/routes/vocab.ts:745-747` (the `COALESCE(vocab_entries.source_upload_id, EXCLUDED.source_upload_id)` upsert), codified by the test "a shared entry already tagged by another user is NOT re-tagged" (`server/tests/routes/vocab.test.ts`).

User-saved provenance is stored on a SHARED table keyed by `(corpus, source_id)`. Consequences:

1. If user A mines 사과 tagged to A's upload, and user B later genuinely mines the same lemma from B's own upload, B gets a 201 but B's tag is silently discarded — and B's `GET /vocab/saved-from-uploads` will never show the word, even though B did save it from B's upload. The write succeeds while the requested provenance is dropped with no signal in the response.
2. Weak inference oracle: B can detect that *someone* tagged the entry first (mine with own upload id → word absent from saved-from-uploads), though never *whose* upload or its title.

The no-clobber rule is the right call for the shared gloss, and the ownership check does guarantee no cross-user *tagging* attack — the leak/integrity bar is met. But the feature's semantics ("what I saved from MY uploads") are only approximated by a shared-row column. The correct model is per-user provenance — a `source_upload_id` on `vocab_cards` (the user-scoped save artifact, exactly as 068 did for user-scoped `grammar_entries`) or a `(user, entry, upload)` association. Grammar has no such problem precisely because `grammar_entries` is user-scoped.

Mitigation: deliberate, documented in code comments, and tested; the deployment is single-user (personal scope), so the cross-user window is theoretical today. Track it — do not let the shared-row shortcut ossify if the app ever gains real multi-user use.

### SF-2 — `GET /vocab/saved-from-uploads` truncates silently at 500 rows, and can split the last group
`server/src/routes/vocab.ts:839` (`SAVED_FROM_UPLOADS_ROW_CAP = 500`), `:895` (`LIMIT $2`).

The response shape is `{ groups }` with no `total`, no `truncated` flag, and no pagination params. Two effects if the cap is ever hit: (a) the client cannot know data is missing; (b) the LIMIT applies to flat rows, so the last upload group returned can be silently incomplete (some of its saved words cut off mid-group) — worse than dropping a whole group, because the group *looks* complete. Cheap fix: `COUNT(*) OVER ()` (the idiom this same file already uses twice) surfaced as `total`, plus a `truncated: boolean`. 500 is far beyond a plausible personal saved set, so this is not urgent — but the contract should say so on the wire, not only in a code comment.

## Nits

- N-1 — `server/src/routes/vocab.ts:802`: the 23503 race guard keys on `'vocab_entries_source_upload_id_fkey'`, which is the Postgres *default-generated* name (migration 040 added that FK without a `CONSTRAINT` clause — 040_book_uploads.up.sql:142-143). Correct today, but nothing pins the name; a future rename/re-create of 040's FK would silently degrade the guard from 404 to 500. Consider a comment in 040 (or a test asserting the constraint name) so the coupling is visible. The grammar side avoided this by naming its FK in 068.
- N-2 — `db/tests/test_migration_068.py`: no assertion that `ix_grammar_entries_source_upload` exists after up (or that it is partial). The column and FK behavior are proven; the index is only proven not to *break* anything. One `pg_indexes` check would close it.
- N-3 — Ownership checks (vocab.ts:690-696, grammar.ts equivalent) ignore `book_uploads.status` — a `processing` or `failed` upload can be tagged. Arguably correct (it is still the user's upload), but worth a deliberate one-line comment since the tests only ever seed `status: 'ready'`.
- N-4 — `POST /grammar/bank` re-bank with a *different* owned upload id returns 201 while COALESCE discards the new tag (first-write-wins, consistent with `discovered_via`). Deliberate and documented, but the response gives no signal of the effective tag; returning `source_upload_id` in the 201 body would make the no-op observable.

## Praise (do not undo)

- P-1 — The race handling is exactly right: in-transaction ownership check, then constraint-scoped 23503 → the *same* 404, keeping the no-existence-oracle property intact across the concurrent-delete window while leaving unrelated FK violations loud (vocab.ts:791-808; grammar.ts:265-277). Both routes, symmetric.
- P-2 — The cross-user tests are genuine attack probes, not tautologies: attacker 404 plus a rollback assertion via row counts, and the saved-from-uploads leak test constructs the actual dangerous state (B holds a card on an entry tagged to A's upload) and asserts B sees nothing (`server/tests/routes/vocab.test.ts`, `grammar.test.ts` F-107 blocks).
- P-3 — Migration 068 is a model citizen: named FK, partial index, F-088 markers on both files, ADR-013 respected, and the pytest suite drives the *real* runner over the *real* files in both directions including the destructive-gate refusal and re-up over a populated table (test_migration_068.py:256-339).
- P-4 — The up.sql header (068 up:10-18) documents *why* grammar_entries and not kgiu_entries carries the column (user-saved vs extracted-corpus provenance) — precisely the kind of decision record that prevents a future migration from "fixing" it wrong.

## Coordination observations

- The BUILD doc's claims check out against the code where I verified them (no pre-existing `source_upload_id` in `MineBodySchema` on this branch; 040 supplied the vocab column so no vocab migration; 068 named its FK). The doc's "first-write-wins … no user can re-tag an entry someone else tagged" framing presents SF-1's behavior as purely a defense; the flip side (a legitimate user's provenance is silently dropped) belongs in any client-facing contract notes.
- The client half (ReviewVocab `SavedFromUploads`, `client/src/services/vocab.ts`) consumes `{ groups }`; if SF-2 is addressed by adding `total`/`truncated`, that DTO and the client types (`client/src/types/domain.ts`) change together.
- `GET /vocab/saved-from-uploads` is a new handler on the existing `/vocab` prefix — no new top-level API prefix, so no km-lb nginx allow-list change is needed (the F-012 class of bug does not apply here).
- Reminder for the fix-pass: `vocab_list_entries` is hard-delete by design (012_vocab_lists.up.sql comment) — do not "fix" the lists leg by adding a `deleted_at` predicate on `le`.
