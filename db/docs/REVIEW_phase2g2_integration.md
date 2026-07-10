# REVIEW — Phase-2 Group 2 (migrations 048–052) cross-cutting integration + deploy story

**Reviewer:** independent senior integration/deploy reviewer (did not write this code)
**Branch:** `feat/phase2-g2-new-tables` @ `7d8a2f4` vs `rebuild`
**Date:** 2026-07-10
**Scope:** the five migrations as a *group* (chain application, ordering, interactions),
the server route mounts, the nginx allow-list, and — the key ruling — whether Group 2
can ship through the standard zero-downtime blue/green flow.

---

## Verdict

**BLOCKED — 1 BLOCKER.** The code and schema are in good shape: the full migration
chain 001→052 applies and rolls back cleanly under test, all three full suites pass at
their expected counts, mounts and allow-lists are complete and ordered correctly.
The blocker is the **deploy story**: Group 2 **requires a Group-1-style brief-downtime
release** (migration 049 is not expand/contract), and `Deploy/README.md` not only lacks
a Group-2 runbook — it affirmatively promises the opposite. Unlike Group 1, **no
mechanical gate will stop an operator** this time, because 049's breaking change is a
column RENAME, which `migrate.py`'s destructive gate cannot see. Documentation is the
only line of defense, and it currently points the wrong way.

---

## Full-suite gate (I own this; real counts)

| Suite | Command (abridged) | Result | Expected |
|---|---|---|---|
| DB migration chain | dockerized `pytest db/tests --ignore=db/tests/test_discriminator_coverage.py` | **44 passed** in 68.95s | 44 ✅ |
| Server (vitest) | `npm ci && npx vitest run` | **1100 passed / 0 failed / 4 skipped (54 files)** | ~1100 / 0 failed ✅ |
| Ingest (CI-equivalent) | dockerized `pytest tests -q --ignore=tests/test_resolve_cross_references_integration.py` | **342 passed, 3 skipped, 1 failed** in 106.59s | pass modulo known non-issue ✅ |

The single ingest failure is `tests/test_hanja_hunmeum.py::test_built_corpus_has_full_hun_coverage`
— the pre-declared KNOWN non-issue: it only runs when the gitignored local
`tools/ingest/output/hanja.json` exists (CI skips it). Not a Group-2 regression; the
Group-2 diff touches nothing under `tools/ingest/`.

The 44 db tests include the five new per-migration suites
(`db/tests/test_migration_048.py` … `test_migration_052.py`), each of which applies the
**full merged chain** 001→052 in a disposable Postgres 16 testcontainer — this is the
proof that the chain applies cleanly with 048–052 present together, not just each
migration in isolation.

---

## BLOCKER

### B-1 — Group 2 needs a brief-downtime release; `Deploy/README.md` says the opposite and the scripted deploy will not stop you

**The ruling: yes, Group 2 requires the same brief-downtime protocol as Group 1**, and
it is currently **undocumented in the runbook that operators actually follow**.

The chain of facts:

1. **049 renames a live column.** `db/migrations/049_vocab_list_entries_multitype.up.sql:79`
   — `ALTER TABLE vocab_list_entries RENAME COLUMN entry_id TO vocab_entry_id`. The
   migration's own header is honest about the consequence
   (`049_...up.sql:59-62`): *"DEPLOYMENT: NOT expand/contract — the rename breaks
   pre-049 server code that reads `entry_id`. Apply together with the matching server
   release (046-style brief-downtime window), not while an old color is still serving."*

2. **The old color demonstrably breaks.** On `rebuild`, `server/src/routes/vocabLists.ts`
   reads and writes the old name: `INSERT INTO vocab_list_entries (list_id, entry_id, position)`
   (rebuild line 189) and `SELECT e.entry_id ... ORDER BY e.position, e.added_at, e.entry_id`
   (rebuild lines 276–285). From the moment 049 applies, every list-detail read and
   create-with-seeds on the still-serving old color 500s with Postgres `42703`
   (undefined column). That is the half-bricked window the blue/green
   migrate-then-flip overlap is supposed to prevent.

3. **The scripted deploy sails straight through.** None of the 048–052 *up* bodies
   contains a gated keyword (`DROP TABLE`/`DROP SCHEMA`/`DROP DATABASE`/`TRUNCATE` —
   verified by grep across all five ups), so `azure-deploy-inactive.sh`'s
   `run_migrate --dry-run up` gate (`Deploy/azure-deploy-inactive.sh:127`) **passes**
   and the unflagged apply (`:137`) runs 048–052 against the shared DB while the
   active color is still serving. This is *worse* than Group 1, where 045's
   `DROP TABLE` at least forced the script to abort (`DestructiveBlocked`) before any
   damage. A rename is invisible to the destructive gate by design
   (`db/migrate.py:74-86` — the gate targets data loss, not shape changes), so for
   Group 2 **documentation is the only gate, and it currently points the wrong way**:

4. **`Deploy/README.md` affirmatively promises zero-downtime is back.**
   `Deploy/README.md:218-227` ("After this release"): *"Subsequent releases return to
   the normal zero-downtime blue/green flow … migrations are expand/contract again …
   and rollback-by-flip is valid again."* For Group 2 every clause of that sentence is
   false: 049 is not expand/contract, and — exactly as with 046
   (`Deploy/README.md:149-153`) — **rollback-by-flip is invalid once 049 applies**
   (flipping back lands old `entry_id` code on the renamed schema).

**Required fix (docs, no code):** add a *"Shipping Phase-2 Group 2 (migrations
048–052)"* section to `Deploy/README.md`, mirroring the Group-1 §"Shipping Phase-2
Group 1" structure (`Deploy/README.md:127-227`), with these Group-2-specific deltas:

- **Procedure:** stop active color → `run_migrate up` (**no `--allow-destructive`
  needed** — unlike Group 1, no up is gated; state this explicitly so nobody
  cargo-cults the flag) → `azure-deploy-inactive.sh "$DEPLOY_TAG"` (now a migration
  no-op) → `azure-switch-production.sh` → downtime ends. No
  `set-km-app-password.sh` step this time (047 already shipped; 047's
  `ALTER DEFAULT PRIVILEGES` auto-grants km_app DML on the five new tables because
  the defaults attach to the migration-runner role — verified in
  `db/migrations/047_km_app_role.up.sql:133-161`).
- **Pre-deploy backup:** keep step 2 (`db-backup.sh`) — the manual flow must not skip
  the safety net the scripted flow takes at `azure-deploy-inactive.sh` step 1.
- **Rollback:** `run_migrate --allow-destructive --target 047 down` (052/051/048 downs
  are genuine `DROP TABLE`s; 050/049 downs are DELETE + DROP COLUMN — lossy but not
  gate-matched, see S-1). Warn that rolling back 049 discards grammar/hanja list
  memberships and 050 discards all hanja cards + their FSRS review history.
- **Restore-reconciliation caveat:** extend `Deploy/README.md:290-294` caveat (b) —
  forward-migrating a restored dump *through 049* has the same
  old-code-unsafe property as 046 (serving color must be stopped or already
  running post-049 code).

Severity justification per the review rubric: an operator following the current
documented flow produces a deploy that half-bricks the running color and silently
invalidates the documented rollback path — "undocumented required step" + "deploy
that breaks". Single-user app, so the blast radius is one user — but the runbook is
the product here, and it is wrong.

---

## SHOULD-FIX

### S-1 — README rows for 049/050 misstate their downs as gate-matched

`db/migrations/README.md:62` and `:63` both end "Down → `--allow-destructive`". For
048/051/052 the equivalent claim is mechanically true (real `DROP TABLE` in the down).
For **049 and 050 it is false as stated**: their downs lose data via `DELETE` +
`DROP COLUMN`, which `migrate.py`'s gate does **not** match — both down files say so
explicitly and correctly (`049_...down.sql:14-17`, `050_...down.sql:13-16`: *"this
down runs without --allow-destructive — the warning lives here instead"*). The 046 row
set the right precedent: *"its down mass-DELETEs attempt history **without tripping
the destructive gate** (see the down header)"* (`db/migrations/README.md:59`).

Reword rows 62/63 to that pattern, adding the merged-chain nuance the fix commit
`7d8a2f4` already encoded in `db/tests/test_migration_050.py:433-439`: any real
`down --target ≤049` traverses 052/051's gated `DROP TABLE` downs first, so the flag
is required *in practice* — but by the later migrations' downs, not these files'.
The current wording teaches an operator the wrong mental model of what the gate
catches (the exact confusion the 046 postmortem documented).

### S-2 — 050's "numbering jumps 047 → 050" header note is stale — fix it BEFORE first prod apply or accept it forever

`db/migrations/050_hanja_cards.up.sql:26-29`: *"NOTE: numbering jumps 047 → 050.
Slots 048/049 are reserved by parallel in-flight tickets on other branches…"* On this
merged branch 048 and 049 exist in the same chain, three lines of `git log` apart.
Harmless today, but this file is **checksummed at apply time**
(`db/migrate.py:467-474`, `ChecksumMismatch`): once 050 is applied to the production
DB, editing the comment triggers the checksum-drift runbook
(`db/migrations/README.md:381+`). The window to fix it cheaply closes at the Group-2
release. Fix now (pre-apply, pre-merge) or consciously never.

---

## NIT

### N-1 — Group-2 release has no entry in `VERIFICATION.md` §8 cross-reference
`Deploy/README.md:368-369` points operators at VERIFICATION.md §8 for the stand-up
checklist; if the Group-2 runbook is added (B-1), mirror whatever verification step
Group 1 got. Fold into the B-1 fix.

---

## Verified clean (integration hygiene)

- **Chain application 001→052**: proven by the 44-test db gate (each
  `test_migration_04x/05x.py` applies the full merged chain in a fresh container);
  rollback through the group proven by
  `test_migration_050.py::test_050_down_deletes_hanja_cards_and_restores_four_leg_xor`
  (post-`7d8a2f4`, correctly flagged for the merged chain).
- **048–052 ordering/interactions**: 048 (new tables, deps 001), 049 (deps 002/012/016
  — all « 048), 050 (deps 001/016/020), 051 (deps 040/044; adds its own
  `uq_reading_chapters_id_upload` backing UNIQUE via guarded DO block,
  `051_...up.sql:70-87`, and its down removes it restoring the exact 044 shape,
  `051_...down.sql:20-24`), 052 (deps 001 only). The only two Group-2 migrations
  touching the same pre-existing surface are 049 (vocab_list_entries) and 050
  (vocab_cards) — disjoint tables, no ordering hazard.
- **ADR-013 compliance**: all five ups and downs carry the transaction-ownership
  header and contain no top-level tx control — enforced mechanically at discovery
  (`db/migrate.py:243-251`) and therefore proven by the passing gate, not just by
  reading.
- **`server/src/app.ts` mounts**: all five features mounted; `/vocab/lists`
  (`app.ts:83`) correctly precedes the greedier `/vocab` (`app.ts:84`); the two NEW
  top-level prefixes (`/notifications` `app.ts:105`, `/tickets` `app.ts:117`) each
  carry the allow-list cross-reference comment.
- **nginx allow-list**: `tickets` + `notifications` added to the API regex in **all
  four** location blocks — prod and test servers in both
  `Deploy/nginx-blue-active.conf:82,144` and `Deploy/nginx-green-active.conf:82,144`;
  the two confs are otherwise identical modulo the expected color swaps. The F-012
  SPA-shadowing lesson is fully applied.
- **db/migrations/README.md rows 61–65**: present, appended (not overwritten), owner
  and purpose accurate; the one wording defect is S-1.
- **km_app privileges on the new tables**: covered by 047's `ALTER DEFAULT PRIVILEGES`
  without `FOR ROLE` (attaches to the migration-runner role;
  `047_km_app_role.up.sql:52-64,133-161`) — no per-migration GRANTs needed in 048–052,
  and correctly none were added.
- **Cold stand-up**: `local-standup.sh --allow-destructive` (already required since
  045) traverses 048–052 with no new flag requirements; ups are gate-clean.

## PRAISE

- **P-1** — 049's up creates the three replacement partial UNIQUE indexes *before*
  dropping the old `uq_vocab_list_entries_list_entry` (`049_...up.sql:147-167`), so
  the uniqueness guarantee never lapses even conceptually. Textbook.
- **P-2** — 049 (`up.sql:59-62`) and both lossy downs (`049/050_...down.sql` headers)
  self-document the exact deploy hazard and gate gap. The migration files are more
  honest than the runbook — the fix for B-1 is largely transcription.
- **P-3** — `7d8a2f4` shows the merged-chain rollback was actually *run*, caught the
  052-gates-050's-target-rollback interaction, and encoded the reason in the test
  comment rather than just adding the flag silently.
- **P-4** — The four-location nginx update in the same commit as the mounts
  (`1d7897a`) institutionalizes the F-012 lesson instead of re-learning it.

---

## Coordination notes for the fix pass

- B-1, N-1: pure documentation, `Deploy/README.md` (+ VERIFICATION.md §8 mirror).
  No code change; no test impact. Highest priority — it gates the release procedure.
- S-1: one-table edit in `db/migrations/README.md` (rows 62–63).
- S-2: comment-only edit in `db/migrations/048_tickets.up.sql`'s sibling
  `050_hanja_cards.up.sql:26-29` — **must land before the release applies 050 to
  prod** (checksum freeze); safe now because no environment has applied 048+.
  Note: editing 050's up changes its checksum — fine pre-apply, and CI/db tests
  re-hash from disk, but coordinate so no shared/dev DB has 050 applied when the
  edit lands (else `make db-reset` there).
- No changes needed to `db/migrate.py`, the migrations' SQL, `server/src/app.ts`,
  or the nginx confs.
