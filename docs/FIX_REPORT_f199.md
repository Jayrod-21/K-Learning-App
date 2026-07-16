# FIX REPORT — F-199 fix-pass (per-user upload provenance)

Fix-pass agent: independent of both the builder and the two reviewers.
Branch: `feature/f199-per-user-provenance`. Input reviews:
`docs/REVIEW_f199_migration.md` (0 BLOCKER / 1 SHOULD-FIX) and
`docs/REVIEW_f199_route.md` (0 BLOCKER / 1 SHOULD-FIX). Scope was the two
SHOULD-FIX items only; no PRAISE-covered code was touched (ownership-join
backfill, A/B regression test, and the F-108 browse are byte-identical).

## Dispositions

| Finding | Source | Disposition | What was done |
|---|---|---|---|
| SF-1 — fill-only/no-overwrite guard never exercised non-vacuously (every re-up followed a `down` that reset the column) | migration review | **FIXED** | New test `test_070_backfill_rerun_never_overwrites_an_existing_card_tag` in `db/tests/test_migration_070.py`: applies the chain, seeds a card already route-tagged to upload X on an entry tagged to same-owner upload Y (the exact state a broken guard would flip X→Y), then executes the real up file's body **directly via psycopg** (not a down/up cycle) and asserts the tag is still X. An untagged control card on a Y-tagged entry is asserted to get filled with Y, proving the UPDATE genuinely ran and only the guard protected the tag. Suite: 9 → 10 tests. Module docstring + BUILD-doc test inventory updated to match. |
| SF-2 — legacy pre-070 mine-written tags survive on `vocab_entries.source_upload_id`, so the documented "F-108 provenance ONLY" invariant is false for legacy rows | route review | **DEFERRED with ticket F-200** — invariant wording softened everywhere it was overclaimed; targeted clear rejected as unsafe (analysis below) | Honest wording in `server/src/routes/vocab.ts` (mine upsert comment + saved-from-uploads leg-2 doc comment), `db/migrations/070_vocab_cards_source_upload.up.sql` (header + `COMMENT ON COLUMN`), `docs/BUILD_f199_per_user_provenance.md` ("What stayed for F-108" + honest-limit paragraph), and the `BUGS_AND_FEATURES.md` F-199 resolution. New ticket **F-200** (P4, data hygiene) files the cleanup with the full distinguishability analysis and the safe two-step fix order. |

## SF-2 — distinguishability analysis and why the clear was NOT attempted

**Are legacy mine-written tags distinguishable from F-108 extracted tags?**
Yes, by key-space convention — but that is not what decided the outcome.
Both writers use `corpus='user_mined'` (mine: `routes/vocab.ts`; U2
extraction: `services/uploadExtract.ts:383,407`), so corpus alone cannot
discriminate. The `source_id` key spaces, however, are disjoint by
construction and can never collide under `UNIQUE (corpus, source_id)`:

- mine writes `source_id = 'krdict-{id}' | 'lemma-{lemma}'`, `source_book = 'user-mined'`;
- extraction writes `source_id = 'upload-{uploadId}-{kr}'` (`sourceIdFor`, `uploadExtract.ts:432-434`), `source_book = 'book-upload'`.

Mine's upsert conflicts only on its own key space, so it could never have
tagged an `upload-*` row, and extraction (`ON CONFLICT DO NOTHING`) never
touches `krdict-*`/`lemma-*` rows. A clear scoped to
`corpus='user_mined' AND (source_id LIKE 'krdict-%' OR source_id LIKE 'lemma-%')`
would therefore not false-clear any F-108 row. Caveat: this is a string
convention, not a schema constraint — "provable" only by code archaeology
of every historical writer, which is why F-200 demands the
extracted-rows-keep-their-tag test.

**Why the clear is unsafe anyway (the decisive reason):** the retention is
**load-bearing**, a fact the route reviewer themself flagged. Leg 2 of
`GET /vocab/saved-from-uploads` (`vocab.ts`, the
`COALESCE(fs.card_upload_id, ve.source_upload_id)` join) is the ONLY
provenance path for pre-070 **list-only** saves of mined words: no card
exists for those saves, so migration 070's backfill had nothing to copy
onto, and the legacy entry tag is the sole record. A perfectly targeted
clear would silently drop those words from the owner's saved-from-uploads —
real, user-visible data loss, strictly worse than the cosmetic U3a browse
fork the clear would fix. A safe cleanup must FIRST move list-only-save
provenance to a user-scoped store (e.g. `vocab_list_entries.source_upload_id`
with a 070-style ownership-guarded backfill) and only THEN clear — a schema
design task, out of fix-pass scope. Cost of retention meanwhile: owner-only
browse fork + corpusFences privatizing legacy shared rows (pre-existing
quirk); no tag crosses users either way; single-user deployment → zero
present harm. Hence: soften + F-200, exactly option (b) of the review.

## Files changed

- `db/tests/test_migration_070.py` — SF-1 test (+ docstring)
- `db/migrations/070_vocab_cards_source_upload.up.sql` — comments only (header honest-limit paragraph, softened `COMMENT ON COLUMN`); no executable statement changed — behavior byte-identical (branch unmerged, so the checksum change is safe: 070 is not applied to any persistent DB)
- `server/src/routes/vocab.ts` — comments only (upsert F-199 note, leg-2 doc)
- `docs/BUILD_f199_per_user_provenance.md` — honest-limit paragraph + test inventory 9→10
- `BUGS_AND_FEATURES.md` — softened F-199 resolution; new ticket F-200
- `docs/FIX_REPORT_f199.md` — this report

## Gates (run 2026-07-16, this worktree)

- `server npm ci` — clean, 0 vulnerabilities
- `server npm run typecheck` — 0 errors
- `server npm run lint` — exit 0, 0 errors (82 pre-existing `no-non-null-assertion` warnings, all untouched code; this fix-pass changed only comments in .ts files)
- `server npx vitest run tests/routes/vocab.test.ts` (testcontainer) — 114 passed, 0 failed
- `db/tests/test_migration_070.py` (pinned `python:3.12` container per `Deploy/local-test.sh` `db_suite` recipe, testcontainers `postgres:16-alpine`) — **10 passed** (9 original + the new SF-1 no-overwrite test), 0 failed

Full-suite runs were not required: no executable schema or route code
changed (SF-1 = new test; SF-2 = comments/docs/ticket), matching the
tests-and-docs-only gate tier.

## Self-assessment

Both SHOULD-FIX items are closed at the level the reviews asked for: SF-1's
guard is now proven against the only state where it can matter, with a
positive control ruling out a vacuous pass; SF-2 takes the safe branch of
the decision the orchestrator delegated, with the distinguishability
question answered concretely (disjoint `source_id` key spaces) and the real
blocker (leg-2 load-bearing retention) documented at every site that
previously overclaimed the invariant, plus an actionable two-step ticket.
Risk of this fix-pass itself: near zero — one new test, comment/doc edits,
one ticket; no production statement altered. Residual known issues are the
four NITs from each review (out of scope, none load-bearing) and F-200.
