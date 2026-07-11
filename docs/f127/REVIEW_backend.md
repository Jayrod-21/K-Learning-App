# REVIEW — F-127 backend (migration 058 + `tickets.source_page` threading)

**Reviewer:** independent senior review (report-only, no code modified)
**Branch:** `feat/f127-feedback-fab` vs `rebuild`
**Scope:** `db/migrations/058_ticket_source_page.{up,down}.sql`, `db/tests/test_migration_058.py`, `server/src/routes/tickets.ts`, `server/tests/routes/tickets.test.ts`
**Reference:** `db/docs/ADR-013-migration-tx-ownership.md`, `db/migrations/048_tickets.{up,down}.sql`, `db/migrations/055_conversation_titles.up.sql` (precedent), `db/migrate.py` (`contains_destructive`, `contains_top_level_tx_control`)

## Verdict

**PASS — no blockers.** The migration is genuinely additive/expand-safe, ADR-013-compliant (no top-level tx control; verified against `migrate.py`'s actual detector, not just the file's own claim), and both directions are tested against the real chain including a `down --target 057` run that empirically proves the down is *not* destructive-gate-classified. `source_page` threading is correctly optional/bounded/`.strict()`, user-scoped, and parameterized throughout. Immutability holds: `PatchBodySchema` has no `source_page` key and is `.strict()`, so `validateBody`'s `safeParse` 400s any attempt to slip it into a PATCH — verified structurally (schema + middleware code), though no test exercises this specific case (gap, not a defect). Anonymity is preserved: `source_page` is orthogonal to author identity, the `/community` SELECT still excludes `user_id`/joins to `users`, and the generic `assertAnonymized()` JSON-wide check still passes with the new field present.

2 SHOULD-FIX (both test-coverage gaps, not code defects), 2 NIT, several PRAISE items below.

---

## Migration (ADR-013) checklist

| Check | Status | Evidence |
|---|---|---|
| No top-level `BEGIN`/`COMMIT`/`ROLLBACK`/`START TRANSACTION` | PASS | Only PL/pgSQL `DO $$ BEGIN … END $$` (058.up.sql:45-56), which `migrate.py`'s `contains_top_level_tx_control` explicitly strips/exempts (ADR-013 lines 51-54, `db/migrate.py:316`) |
| Runner owns the transaction | PASS | Both files' footer comments match the documented contract; consistent with 048/055 |
| Additive / expand-safe (zero-downtime) | PASS (column) | `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS source_page TEXT` — nullable, no default, metadata-only, no rewrite (058.up.sql:43) |
| Reversible down, honestly documented | PASS | `.down.sql` drops column + constraint, explicitly documents lossiness in the header (058.down.sql:5-13) |
| Down NOT destructive-gate-classified, correctly | PASS, verified independently | `contains_destructive` regex is `\b(DROP\s+TABLE|DROP\s+SCHEMA|DROP\s+DATABASE|TRUNCATE)\b` (`db/migrate.py:84`) — `DROP COLUMN`/`DROP CONSTRAINT` do not match. `test_058_down_drops_column_then_reups` empirically proves this by calling `migrate.main([..., "down"])` **without** `--allow-destructive` and asserting `rc == 0` (test_migration_058.py:256-259) |
| Idempotent re-apply | PASS | `ADD COLUMN IF NOT EXISTS` + `DO $$ IF NOT EXISTS (pg_constraint) …` guard (058.up.sql:43-56); `test_058_reapply_is_idempotent` re-executes the raw body against an already-migrated DB and asserts no raise |
| CHECK boundary tested both ends + NULL exemption | PASS | `test_058_up_lifecycle_and_check_boundaries` covers empty string (reject), exactly 200 (accept), 201 (reject), and NULL round-trip (exempt) — all assert on `constraint_name == "ck_tickets_source_page_length"`, not just a generic exception |
| Down→re-up cycle, with live data | PASS | `test_058_down_drops_column_then_reups` seeds a row with `source_page` set, downs, asserts column+constraint gone but the **ticket row itself survives**, re-ups, asserts clean restoration |

---

## Anonymity/security checklist

| Check | Status | Evidence |
|---|---|---|
| `source_page` carries no user_id/email-shaped data | PASS | It is a route pathname string (`/learn/writing`), stored and returned verbatim; no identity semantics anywhere in schema or route |
| `/community` SELECT still excludes `user_id`/join to `users` | PASS | `tickets.ts:204-214` — SELECT list unchanged in shape aside from adding `t.source_page`; `is_mine` remains the only identity-adjacent signal, computed against the caller |
| Immutable via PATCH | PASS (by construction) | `PatchBodySchema` (`tickets.ts:226-238`) has no `source_page` key and is `.strict()`; `validateBody`'s `safeParse` (`server/src/middleware/validate.ts`) rejects any unknown key with a 400 before the handler runs — a user cannot rewrite a ticket's filed-from page |
| Bounded / no injection surface | PASS | Zod `.trim().min(1).max(200).optional()` (`tickets.ts:111`) mirrors the DB CHECK; every INSERT/SELECT/UPDATE is parameterized (`$1`…`$n`), no string interpolation anywhere in `tickets.ts` |
| Zod bound never looser than the DB CHECK (no 500 daylight) | PASS, verified by construction | Both are `[1, 200]`; Zod's `.max(200)` counts UTF-16 code units, Postgres `char_length` counts codepoints — since code-unit count ≥ codepoint count for any string, a payload passing Zod's bound can never exceed the DB's codepoint bound. No case where a 201-arg-loose client payload survives past Zod but 500s on the CHECK |
| Test-level anonymity assertion still exercised with the new field present | PASS | `assertAnonymized()` (structural, whole-JSON-payload check for `user_id`/`userId`/`email`) is called on the POST-with-`source_page` test (`tickets.test.ts:154`) |

---

## Findings

### BLOCKER
None.

### SHOULD-FIX

**SF-1 — No test asserts `source_page` is rejected/ignored when submitted on PATCH.**
`server/tests/routes/tickets.test.ts`'s `PATCH /tickets/:id` describe block (lines 293-381) has no analog to POST's "rejects extra fields under `.strict()` (mass assignment)" test (lines 129-138). The immutability guarantee is real — verified by reading `PatchBodySchema` (`tickets.ts:226-233`, no `source_page` key, `.strict()`) and `validateBody` (`server/src/middleware/validate.ts`, `safeParse` + strict schema → 400 on unknown key) — but it is currently unverified by the suite. This is exactly the kind of implicit-by-construction guarantee that silently breaks the next time someone touches `PatchBodySchema` (e.g. adding a "re-tag the page" feature) without anyone noticing until it's shipped. Recommend adding:
```ts
it('rejects source_page on PATCH — page context is set once at filing, never rewritten', async () => {
  // ... PATCH /tickets/:id with { source_page: '/hijack', expected_version: 1 } → 400
});
```

**SF-2 — The `source_page`+`/community` round-trip test doesn't re-assert anonymity.**
`tickets.test.ts:188-204` ("a ticket filed with source_page carries it on /mine and /community") checks the value round-trips but does not call `assertAnonymized()` on the `/community` response. The generic anonymity test at line 248 doesn't file a ticket with `source_page` set. So there is no single test that simultaneously (a) has `source_page` present on a community-feed row and (b) asserts the payload is still identity-free. The current code is correct (verified by reading the SELECT), but the two properties ("carries source_page" and "still anonymized") are only ever exercised in separate test bodies — a future regression that leaked identity alongside `source_page` specifically (e.g. a careless `SELECT t.*` refactor) wouldn't necessarily be caught by either existing test in combination. Recommend adding `assertAnonymized(community.body)` to the existing round-trip test.

### NIT

**N-1 — `char_length` (058) vs `length` (048) naming inconsistency.**
048's title/body CHECKs use `length(...)` (`048_tickets.up.sql:74-76`); 058 (and precedent 055) use `char_length(...)`. Both are true synonyms for `text` in Postgres — no functional difference — but a reader diffing constraints across tickets' own migrations sees two spellings for the same operation. Not worth a migration to fix; worth a style note for the next tickets-table CHECK.

**N-2 — Plain `ADD CONSTRAINT ... CHECK` (not `NOT VALID` + `VALIDATE CONSTRAINT`) takes `ACCESS EXCLUSIVE` while scanning existing rows.**
058's CHECK-add (058.up.sql:50-54) is a plain `ADD CONSTRAINT`, which briefly locks the table while validating every existing row — the standard safe pattern for a populated table under load is `ADD CONSTRAINT ... CHECK (...) NOT VALID` followed by a separate `VALIDATE CONSTRAINT` (which only takes `SHARE UPDATE EXCLUSIVE` and doesn't block reads/writes). This is **not new debt introduced by 058** — it's identical to the established house pattern in 055's `conversations.title` CHECK-add, so 058 is consistent with precedent rather than introducing a new risk class. Given the project's confirmed personal/single-user beta scope (a handful of users, a `tickets` table that will never be large), the lock duration is negligible in practice. Flagging only because the migration's own header asserts "Expand/contract-compliant" / "zero-downtime blue/green flow" — technically true for the `ADD COLUMN`, only true-in-practice-not-in-principle for the `ADD CONSTRAINT`, given current scale.

### PRAISE

- **P-1** — The `test_058_down_drops_column_then_reups` test doesn't just assert schema shape after rollback; it seeds a real row with `source_page` set, rolls back, and asserts the **ticket row survives** while only the column is lost — proving the down is lossy exactly where it claims to be and nowhere else.
- **P-2** — Using an actual `migrate.main(["down"])` invocation without `--allow-destructive` as the mechanism to prove "this down isn't gate-classified as destructive" is a genuine regression probe on `contains_destructive`'s classification, not just an assertion about the SQL text — if a future change to the destructive regex accidentally widened it to catch `DROP COLUMN`, this test would fail loudly instead of the gap going unnoticed.
- **P-3** — The route module's header threat-model comment was updated in-place to document the `source_page` addition (`tickets.ts:40-47`) rather than bolting on a separate note — keeps the anonymity contract's documentation single-sourced.
- **P-4** — Choosing to omit `source_page` (undefined) rather than accept empty string for "no context," both in the Zod schema (`.min(1)` with no explicit empty-allowed branch) and in the migration's design notes, avoids the classic NULL-vs-empty-string ambiguity that so often creeps into optional text columns.
