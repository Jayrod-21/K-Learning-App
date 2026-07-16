# REVIEW — F-199 vocab route + security changes (independent review)

**Scope:** `server/src/routes/vocab.ts` diff, `server/tests/routes/vocab.test.ts` diff, with `docs/BUILD_f199_per_user_provenance.md` and migration 070 read for context.
**Branch:** `feature/f199-per-user-provenance` vs `origin/rebuild`.
**Reviewer stance:** did not write this code; did not run tests (shared test DB in use; orchestrator holds the green server gate).

---

## Summary verdict

**PASS — 0 BLOCKERS, 1 SHOULD-FIX, 4 NITs.** The core goal is met and proven: user-saved
upload provenance now lives on the caller's own `vocab_cards` row, `POST /vocab/mine` never
writes the shared `vocab_entries.source_upload_id` again, and the headline A/B regression
test genuinely exercises two distinct users mining the same lemma and would fail under any
revert combination (write-side, read-side, or both). Ownership is validated before any tag
write, every read leg is session-user-scoped, all SQL is parameterized, and the F-108
extracted-corpus browse is provably untouched. The one SHOULD-FIX is a legacy-data /
documentation-invariant gap, not a defect in the new code paths.

---

## Bar checklist

| Bar item | Verdict | Evidence |
|---|---|---|
| CORE GOAL: 2nd user keeps their tag; A/B test proves both users see their word in their own `saved-from-uploads`; test fails on revert | **PASS** | `server/tests/routes/vocab.test.ts:1498-1555` — two `registerUser` calls, shared entry asserted (`rb.body.entryId === ra.body.entryId`), per-card tags asserted, entry tag asserted NULL, and BOTH users' `GET /vocab/saved-from-uploads` groups asserted. Revert analysis below (Detailed finding P-1). |
| User-scoped everything: tag/read own cards + own uploads only; foreign upload → 404 before any write | **PASS** | Write: step-0 ownership check inside the transaction, `vocab.ts:718-737` (combined id+ownership predicate, 404 identical for nonexistent/unowned). Read: `c.user_id = $1` (`vocab.ts:940`), `vl.user_id = $1` (`vocab.ts:954`), `bu.user_id = $1` on the provenance join (`vocab.ts:991`). |
| Parameterized SQL only | **PASS** | Every client value is bound (`vocab.ts:732, 783, 803, 824, 836, 996`). The only SQL string composition is `sourceUploadFenceSql`, which takes server-owned literals only (`server/src/db/corpusFences.ts:48-56`), and it is not part of this diff. |
| `POST /vocab/mine` idempotency preserved; re-mine-from-different-upload policy documented | **PASS** | Existing card returned unchanged (`vocab.ts:791-828`); same-upload re-mine is a true no-op (no UPDATE issued — `card.source_upload_id === null` gate at `vocab.ts:815-818`); different-upload re-mine keeps the first tag, documented at the code site (`vocab.ts:807-814`), in `docs/BUILD_f199_per_user_provenance.md:68-75`, and pinned by tests (`vocab.test.ts:1421-1466`). |
| CRITICAL: F-108 `GET /vocab/entries?source_upload_id=` untouched, still reads the shared column | **PASS** | The browse handler (`vocab.ts:96-174`) appears in no diff hunk; it still filters `source_upload_id = $7` with the owned-upload EXISTS guard (`vocab.ts:149-153`) and the `sourceUploadFenceSql` fence (`vocab.ts:159`). `server/src/services/uploadExtract.ts:382,406` still writes `vocab_entries.source_upload_id` and is not on this branch's diff. A repo-wide grep confirms the only remaining writers of that column are `uploadExtract.ts` and the test seed helper (`server/tests/helpers/seed.ts:74-118`). |
| No swallowed errors; typed AppErrors; FK race (23503) handled | **PASS** | `NotFoundError` for ownership failures (`vocab.ts:735`); 23503 mapped to 404 only when `constraint === 'fk_vocab_cards_source_upload'` (`vocab.ts:856-863`) — correctly re-pointed from the old `vocab_entries_source_upload_id_fkey`, scoped so unrelated integrity errors still surface; everything else falls through to `next(err)`. The catch covers BOTH the card INSERT and the fill UPDATE. |

---

## Findings by category

- **BLOCKER:** none.
- **SHOULD-FIX:** SF-1 — legacy `user_mined` tags survive on `vocab_entries.source_upload_id`, contradicting the newly documented "F-108 extracted-corpus provenance ONLY" invariant for pre-070 rows.
- **NIT:** N-1 comment overclaims a one-tagged-card invariant; N-2 fill UPDATE neither bumps `version` nor carries a redundant `user_id` predicate (both defensible, one comment line would lock it in); N-3 pre-existing unhandled 23505 on concurrent first-mine; N-4 BUILD doc gate numbers don't match the orchestrator's gate.
- **PRAISE:** P-1 revert-proof headline test; P-2 read-side fence pinned by direct seeding; P-3 clean no-op/no-churn re-mine semantics; P-4 correct FK-race re-scope.

---

## Detailed findings

### SHOULD-FIX

**SF-1 — Legacy shared-row tags are never cleaned up, so the stated invariant only holds for new writes.**
`vocab.ts:776-777` ("vocab_entries.source_upload_id is F-108 extracted-corpus provenance only"),
`docs/BUILD_f199_per_user_provenance.md:99-105`, and the BUGS_AND_FEATURES.md resolution all state
the shared column now carries ONLY extracted-corpus provenance. That is true of writes going forward,
but migration 070's backfill deliberately does not modify `vocab_entries`
(`db/migrations/070_vocab_cards_source_upload.up.sql:102-110`), so every pre-070 mine-written tag on a
shared `user_mined` row survives. Consequences:

1. **U3a browse inconsistency:** `GET /vocab/entries?source_upload_id=X` (`vocab.ts:149-153`) will keep
   returning words the user mined-while-reading before 070, while words mined after 070 never appear
   there — a silent behavior fork inside one endpoint, invisible to tests because fixtures create
   fresh data.
2. **The corpusFences fence still privatizes legacy shared `user_mined` rows:** a shared entry tagged
   pre-070 to user A's upload remains invisible/404 to user B in the fenced detail/bank/browse reads
   (`corpusFences.ts` rule), even though B may hold a card on it via the mine upsert (which is
   deliberately unfenced on `(corpus, source_id)`). This quirk is pre-existing, not introduced here —
   but the new "ONLY" wording implies it is gone, and for legacy rows it is not.

The retention is partially load-bearing: leg 2 of `saved-from-uploads` (`vocab.ts:990`) needs entry
tags for pre-070 **list-only** saves of mined words (no card exists for the backfill to fill), so a
blind cleanup would lose that provenance. Recommend a follow-up ticket that either (a) clears
`user_mined`-corpus tags in a later migration after folding any list-only-save provenance somewhere
user-scoped, or (b) softens the "ONLY" claims in `vocab.ts`, the BUILD doc, and BUGS_AND_FEATURES.md
to "only, for new writes; legacy user_mined tags remain until cleaned". Single-user deployment means
no user harm today — this is invariant hygiene, not a merge blocker.

### NIT

**N-1 — Comment overstates an invariant** (`vocab.ts:933-935`): "mine only ever tags the single
recognition card, so at most one card per (user, entry) carries a tag". True today (vocab entries only
ever get `face='recognition'` cards — the only `'production'::card_face` writer is
`grammarDrill.ts:409`, which sets `grammar_entry_id`, and the 070 backfill copies one identical value
regardless of face). But the guarantee is incidental, not enforced. If a second tagged face ever
appears with a different upload id, `MIN(c.source_upload_id)` (`vocab.ts:938`) silently picks the
lowest id — both would still be the caller's own uploads (no security impact), but the pick is
arbitrary. Worth one clause acknowledging MIN is a tie-break, not just NULL-folding.

**N-2 — Fill UPDATE** (`vocab.ts:819-825`): (a) it does not bump `version`, while the column's own
comment (`db/migrations/001_core_schema.up.sql:221`) says "bump on write". Not bumping is actually the
better behavior here — a provenance fill must not invalidate an in-flight review's
`expected_version` — but that reasoning lives nowhere; a future sweep could "fix" it into a bug. One
comment line. (b) `WHERE id = $1` carries no `user_id` predicate; `card.id` comes from the
user-scoped SELECT in the same transaction (`vocab.ts:796-803`) so it is safe, but `AND user_id = $3`
would be free belt-and-braces consistent with the file's defense-in-depth posture.

**N-3 — Pre-existing, not an F-199 regression:** two concurrent FIRST mines of the same lemma by one
user both pass the existence SELECT (`vocab.ts:796-803`, no FOR UPDATE) and both INSERT
(`vocab.ts:829-837`); the loser hits `uq_vocab_cards_user_vocab_recognition` (migration 065) and the
unhandled 23505 surfaces as a 500 instead of the idempotent 201. The bank route
(`vocab.ts:586-608`) has the identical shape, and `vocabLists.ts:905-919` shows the fix pattern
(`ON CONFLICT ... DO NOTHING`). File separately; do not fold into F-199.

**N-4 — BUILD doc gate figures don't match the orchestrator gate:** `docs/BUILD_f199_per_user_provenance.md:138`
reports 1354 server tests passed; the orchestrator's stated green gate is 1456. Likely different
suite scopes/dates, but a doc that will be cited as the gate record should say which run it reports.

### PRAISE

**P-1 — The headline test is genuinely revert-proof** (`vocab.test.ts:1498-1555`). It registers two
distinct users, proves the entry is shared, asserts each card's tag, asserts the shared entry stays
NULL, and asserts BOTH users' `saved-from-uploads` payloads (group shape, title, entry id). Revert
analysis: (a) write reverts to shared-row first-write-wins → B's card tag NULL, fallback leg hits
`bu.user_id = B` fence → `resB.groups` empty → fails; (b) read reverts to `ve.source_upload_id`
only → entry tag NULL → `resA.groups` empty → fails; (c) both revert → entry tagged to A's upload →
B fenced out → fails. Exactly the test the ticket demanded.

**P-2 — Read-side fence pinned independently of the write path** (`vocab.test.ts:1671-1706`): seeding
B's card directly on an entry extracted from A's upload (bypassing the route fences that would block
it) proves the `bu.user_id = $1` predicate on `vocab.ts:989-991` is a real fence, not dead
defense-in-depth. The foreign-upload write test (`vocab.test.ts:1468-1489`) likewise asserts full
transactional rollback — no entry row, no card row — not just the 404.

**P-3 — Re-mine semantics are precise:** same-upload re-mine issues no UPDATE at all (no
`updated_at` churn on the FSRS row), and the fill's `source_upload_id IS NULL` predicate re-evaluated
under the UPDATE's row lock (`vocab.ts:820-823`) is a correct READ COMMITTED double-fill guard.
Keep-first is documented at the code site, in the BUILD doc, and pinned by a dedicated test
(`vocab.test.ts:1446-1466`).

**P-4 — FK race guard correctly migrated** (`vocab.ts:856-863`): re-pointed to
`fk_vocab_cards_source_upload` (matching `070_vocab_cards_source_upload.up.sql:49`), still
constraint-name-scoped so unrelated 23503s stay loud, and the comment correctly notes it now covers
both the INSERT and the fill UPDATE. 404 parity between nonexistent and unowned upload ids is
preserved (`vocab.test.ts:1491-1497`).

---

## Coordination observations

- **Migration 070** (reviewed for context only — defer to the migration reviewer): up marker
  non-destructive / down explicitly destructive (F-088) both look right; the backfill's ownership
  join (`bu.user_id = c.user_id AND c.source_upload_id IS NULL`,
  `070_vocab_cards_source_upload.up.sql:102-110`) matches the route's write-side invariant exactly,
  so the route comment "card tags are invariantly the caller's own uploads" (`vocab.ts:983-985`)
  holds across both writers. The backfill has no `face` filter — harmless today (see N-1) but the
  migration reviewer may want the same acknowledgment.
- **SF-1 spans files outside my scope** (migration + BUILD doc + BUGS_AND_FEATURES.md wording); if
  the aggregate goes with option (b) (soften the "ONLY" claims), the fix touches
  `vocab.ts:776-777`, `docs/BUILD_f199_per_user_provenance.md:99-105`, and the BUGS entry together.
- `BUGS_AND_FEATURES.md` F-199 flipped to done with a resolution paragraph that accurately matches
  the implemented design (modulo the SF-1 wording).
- The `{ groups, total, truncated }` envelope, 500-row cap, whole-group truncation logic, and the
  over-fetch sentinel (`vocab.ts:994-1021`) are byte-compatible with pre-F-199 behavior — only the
  join key changed — and the existing truncation tests still exercise them through the new query.
