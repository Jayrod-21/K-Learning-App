# Review: A1 — Core schema port

## Summary verdict

**PASS WITH CONDITIONS.** The migration is one of the cleanest first-cut
schema drops I've reviewed in a long time — types, audit columns, FK
policies, naming, comments, indexes-with-justifications, and ADR coverage
all hit the SENIOR_ENGINEER_BAR. The conditions are real but small:
one latent FK/CHECK interaction on `vocab_cards`, a too-loose lower bound
on the Argon2id hash length, and a documentation drift between
`register_level` (the actual type name) and `register` (the name promised
in ADR-001 §D8).

---

## Bar checklist (SENIOR_ENGINEER_BAR.md §5 — "Bar checks before declaring done")

The §5 list is 13 items. Verdicts below.

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Lint passes (no warnings) | N/A | SQL-only migration; lint applies once migrator/CI ships under A3. |
| 2 | Type-check passes (strict) | N/A | SQL-only migration. |
| 3 | All tests pass (unit + integration) | N/A (deferred) | Test harness owned by A3; `README.md` lines 38–53 specifies the test cycle. Not yet executed. |
| 4 | Every public function tested | N/A | SQL-only migration; no functions outside `set_updated_at()`. |
| 5 | `EXPLAIN ANALYZE` on every non-trivial query, indexes confirmed | PARTIAL | Every index has a `COMMENT ON INDEX` naming the query (`up.sql:213,293,301,308,396,468,521,608,614,749,756,763,827,833`). EXPLAIN ANALYZE itself can't be run until 002 + seed data exist; acceptable for migration code. |
| 6 | `SECURITY.md` written, attack vectors enumerated | PASS | `SECURITY.md` "Core schema (migration 001) — A1" enumerates 10 attack vectors (SQLi, credential stuffing, timing, password DB compromise, session hijack, CSRF, mass assignment, exfiltration, soft-delete bypass, JSONB injection) with both DB-layer and app-layer defenses. |
| 7 | `README.md` written, includes "how to test this" | PASS | `README.md:121–151` gives a concrete psql cycle: fresh DB → up → smoke → idempotency → down → re-up. |
| 8 | ADR written for any contestable decision | PASS | ADR-001 (foundation), ADR-002 (auth), ADR-003 (FSRS), ADR-004 (deferred FKs). Every "a reasonable engineer would have picked the other thing" decision is named and the alternative-and-why-not is on the page. |
| 9 | Migrations reversible AND tested both directions | PARTIAL | `down.sql` is well-ordered (reverse-create); A1 has not yet executed the up→down→up cycle (A3 owns CI). The shape is correct; the proof is deferred. |
| 10 | No `TODO` / `FIXME` without a ticket number | PASS | `grep -nE 'TODO\|FIXME'` returns zero hits in all A1 artifacts. |
| 11 | No `console.log` / `print()` in committed code | PASS | N/A — SQL. |
| 12 | No commented-out code | PASS | Every commented-out line is documentation (rationales, lookup patterns), not dead code. |
| 13 | No hardcoded secrets, URLs, or paths | PASS | No secrets / no URLs / no paths in the SQL. |

Net: PASS on every item that can be evaluated from the artifacts; PARTIAL
on the two items (integration testing, up/down cycle execution) that are
explicitly deferred to A3 by design.

---

## Findings

### BLOCKER (must fix before this code is acceptable)

None.

### SHOULD-FIX (real issues, fix before production)

- **F1.** `vocab_cards.grammar_entry_id` FK is `ON DELETE SET NULL` while
  the table also enforces an XOR CHECK that exactly one of the four
  target IDs is non-NULL. Hard-deleting a `grammar_entries` row that has
  dependent cards will attempt to NULL the FK and trip the XOR check,
  failing the DELETE. Not a corruption risk — the DB refuses the bad
  state — but it's a buried foot-gun for any future cleanup script.
  (`001_core_schema.up.sql:688–697`)

- **F2.** `ck_users_password_hash_length` accepts hashes from 32 chars
  upward. Argon2id PHC strings are ≥ ~95 chars in any realistic
  parameterization. A 32-char `password_hash` is by construction not a
  valid Argon2id encoded string, so this CHECK can't catch a regressed
  hasher (e.g., someone accidentally storing a bcrypt or raw-hex hash).
  Raise the lower bound to something like 80, or replace the range with
  a regex matching `^\$argon2id\$`. (`001_core_schema.up.sql:177`)

- **F3.** ADR-001 §D8 lists the enum as `register` (`반말 / 해요체 / ...`),
  but A1 named the type `register_level` and added a code comment about
  the rename (`up.sql:79–84`). Decision is fine — `register` collides
  with SQL syntax in tooling — but ADR-001 was not updated. A future
  agent reading ADR-001 will write `register` and break. Either update
  ADR-001 §D8 to say `register_level`, or add a one-paragraph
  rectification in ADR-002.

### NIT (cosmetic / preference)

- **F4.** `sessions.user_agent` is unbounded `TEXT`. UA strings from
  hostile clients can be megabytes. A `CHECK (length(user_agent) <= 1024)`
  costs nothing and bounds the row width. (`up.sql:236`)

- **F5.** `ON UPDATE RESTRICT` on FKs whose parent is an
  `IDENTITY` PK is mechanically redundant — identity values never change.
  Including it is consistent and harmless, and the bar (ADR-001 §D9)
  asks for an explicit `ON UPDATE` clause, so this is a "the rule earned
  this verbosity" pattern, not a bug. Calling it out so it's not later
  removed as "dead code".

- **F6.** `study_log.minutes_studied NUMERIC(6, 2)` accepts up to
  9 999.99 minutes (~166 hours) in a day. `ck_study_log_minutes_nonneg`
  enforces ≥ 0 only. Tightening to `<= 1440` (one day) would catch loader
  bugs. (`up.sql:325, 340`)

- **F7.** `pgcrypto` is loaded for "session tokens generated server-side"
  (`up.sql:41`), but token generation actually happens at the app layer
  (per ADR-002 §D2). `pgcrypto` IS used here — for `digest(token, 'sha256')`
  in the lookup query — but the comment misattributes its role. One-line
  edit to the extension comment.

### PRAISE (specifically excellent choices worth keeping)

- **F8.** The append-only `card_reviews` design that snapshots
  BEFORE-and-AFTER FSRS state (`up.sql:782–793`) is exactly right and
  ADR-003 §D2 walks through the reasoning. The "we don't have to
  reconstruct state by forward-replay" argument is the senior move.

- **F9.** XOR CHECK constraint on the polymorphic `vocab_cards` target
  (`up.sql:692–697`) using the `CASE … = 1` pattern is the cleanest way
  to express "exactly one of these is non-NULL" in standard SQL.
  Combined with per-target FK columns (vs. a `target_type/target_id`
  pair), FK integrity is preserved for every target type. ADR-003 §D3
  explicitly enumerates and rejects the two worse alternatives.

- **F10.** Partial indexes consistently mirror the live-row filter:
  `ix_users_live`, `ix_sessions_active_lookup`,
  `ix_diagnostic_snapshots_user_time`, `ix_conversations_user_updated`,
  `ix_grammar_entries_user_proficiency`, `ix_vocab_cards_due_queue`
  (`up.sql:210, 290, 465, 518, 605, 746`). The hot-path indexes stay
  compact as soft-deleted rows accumulate.

- **F11.** Token storage as the SHA-256 of the raw token, with the raw
  token never persisted, and an explicit per-column comment to that
  effect (`up.sql:271–273`). SECURITY.md §5 ties the design back to the
  "DB-compromise" threat model. This is what good auth schema looks like.

- **F12.** Constraint-name reservation across migration boundaries
  (ADR-004 + README.md:97–106 + per-column comments on
  `vocab_cards.vocab_entry_id` etc.). A1 has done the work so A2 can land
  the FKs by name without runtime coordination. This is the kind of
  cross-agent contract that usually goes missing.

- **F13.** Every `COMMENT ON INDEX` names the actual query pattern the
  index serves. "Hot path:" / "Lookup pattern:" / "Supports …" prefixes
  make the intent legible. New reviewers can verify the index fits the
  query without grepping the codebase.

- **F14.** `set_updated_at()` defined once with `CREATE OR REPLACE`
  (`up.sql:51–59`) and reused by every trigger (`trg_*_updated_at`),
  matching ADR-001 §D6. No business logic in triggers; mechanical
  maintenance only.

---

## Detailed findings

### F1 — `ON DELETE SET NULL` on `grammar_entry_id` conflicts with the XOR CHECK

**Where:** `001_core_schema.up.sql:688–697`

```sql
CONSTRAINT fk_vocab_cards_grammar_entry
    FOREIGN KEY (grammar_entry_id) REFERENCES grammar_entries(id)
    ON DELETE SET NULL ON UPDATE RESTRICT,

CONSTRAINT ck_vocab_cards_target_xor CHECK (
    (CASE WHEN vocab_entry_id     IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN grammar_entry_id   IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN source_sentence_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN topik_item_id      IS NOT NULL THEN 1 ELSE 0 END) = 1
),
```

**What's wrong.** If a `grammar_entries` row is hard-deleted while a
`vocab_cards` row references it, `ON DELETE SET NULL` tries to set
`vocab_cards.grammar_entry_id = NULL`. The XOR CHECK then sees zero
non-NULL targets on that row and rejects the update. The DELETE on
`grammar_entries` fails with a constraint violation.

**Why it matters.** ADR-004's matching FK for `source_sentence_id` is
also `SET NULL`. The intent is "card outlives source." For grammar, the
intent (per ADR-003 §D3 and the column comment) is "grammar entries are
user-banked, so they're soft-deleted." That's true today — the only
deletes will be soft. But:

1. The schema doesn't tell the operator that. The FK says "if I'm hard-
   deleted, NULL my dependents." Someone running an admin purge will
   trip the CHECK and get a confusing error.
2. The asymmetry vs. `source_sentence_id` is not principled — they have
   the same SET-NULL policy but different lifecycle contracts.

**Suggested fix.** Either:
- Switch to `ON DELETE RESTRICT` for the grammar FK (matches ADR-001 §D9
  "RESTRICT for reference-data-like behavior; force the caller to
  cascade-soft-delete the dependents"), OR
- Keep `SET NULL` and relax the XOR check to allow the all-NULL state
  (then add `ck_vocab_cards_orphan_disposition` requiring soft-delete
  when all targets are NULL).

The first is simpler and matches grammar-entries' soft-delete contract.

---

### F2 — `password_hash` length floor of 32 is too permissive

**Where:** `001_core_schema.up.sql:177`

```sql
CONSTRAINT ck_users_password_hash_length CHECK (length(password_hash) BETWEEN 32 AND 255),
```

**What's wrong.** ADR-002 §D1 commits to Argon2id with the PHC encoding.
That encoding is `$argon2id$v=19$m=<int>,t=<int>,p=<int>$<base64-salt>$<base64-hash>`
— always ≥ ~95 characters in any realistic parameter set
(64 MiB / t=3 / p=1 baseline produces ~96–112 chars). A 32-char string
cannot be a valid Argon2id PHC encoding. The current CHECK lets an
accidentally-bcrypt'd hash through (`$2b$12$…` = 60 chars), or a raw hex
SHA-256 (64 chars), or any other regression.

**Why it matters.** The CHECK is the last line of defense if the hasher
regresses. Set the floor high enough to catch a real regression.

**Suggested fix.** Either of:
- `CHECK (length(password_hash) BETWEEN 80 AND 255)`
- `CHECK (password_hash LIKE '$argon2id$%' AND length(password_hash) <= 255)`

The regex variant is more specific but couples the schema to the hasher
choice; the length variant is loose enough to allow Argon2id parameter
upgrades but tight enough to reject everything that isn't Argon2id.

---

### F3 — Type rename `register` → `register_level` is undocumented in ADR-001

**Where:**
- `001_core_schema.up.sql:79–84` creates `register_level`
- ADR-001-database-choices.md:100 lists the type as `register`

**What's wrong.** ADR-001 §D8 is the contract every later migration
checks against. It promises a type named `register`. A1 renamed it,
documented the reason in the SQL ("REGISTER is a SQL reserved-ish word
and a Postgres column/type named exactly 'register' can produce
surprising parser behavior in tooling"), but did not update the ADR. A2
followed the SQL (it would have to — that's the actual type name), but
a future agent who reads ADR-001 first will write `register` and waste
30 minutes debugging.

**Why it matters.** ADRs decay when implementation drifts away from them
quietly. The fix is one paragraph.

**Suggested fix.** Either:
- Update ADR-001 §D8 in place: change `register` → `register_level` and
  add a parenthetical "(renamed from `register` to avoid SQL keyword
  collisions in tooling — see migration 001 line 79)".
- Or, since ADR-001 is "Accepted," supersede the type-name decision in
  ADR-002 with a short §D8a entry.

The in-place fix is cleaner.

---

### F4 — `sessions.user_agent` is unbounded TEXT

**Where:** `001_core_schema.up.sql:236`

UA strings from hostile clients can be arbitrary length. Adding
`CHECK (length(user_agent) <= 1024)` (or 2048) prevents row-width
pathologies in `pg_stat_activity` snapshots and in any future telemetry
export. Same logic applies to `sessions.revoked_reason`. NIT.

---

### F5 — `ON UPDATE RESTRICT` on FK to IDENTITY PK

**Where:** every FK declaration in `001_core_schema.up.sql`.

Identity columns never change, so `ON UPDATE` is moot. The bar (ADR-001
§D9) asks for explicit `ON UPDATE` anyway — verbosity is the rule, not
a bug. Calling it out so a future reviewer doesn't strip it as "dead
ceremony."

---

### F6 — `study_log.minutes_studied` upper bound is "physically impossible"

**Where:** `001_core_schema.up.sql:325, 340`

`NUMERIC(6, 2)` allows up to 9 999.99 minutes (~166 hours/day).
`ck_study_log_minutes_nonneg` only enforces ≥ 0. Tightening to
`<= 1440` (24 h × 60 min) would catch the loader bug where a duration
gets stored in milliseconds.

---

### F7 — `pgcrypto` extension comment misattributes its role

**Where:** `001_core_schema.up.sql:41`

The comment says `pgcrypto` is for "gen_random_bytes() for opaque
session tokens generated server-side." ADR-002 §D2 has token generation
happen in the app layer (`crypto.randomBytes` / `os.urandom`).
`pgcrypto` IS still needed — for `digest(raw_token, 'sha256')` in the
lookup query (line 273) — but the comment misnames its purpose. One-
line edit: "pgcrypto: digest() for SHA-256-hashing the raw session
token at lookup time."

---

## Coordination observations

Issues that affect other agents' work:

1. **Type-name drift between ADR-001 and migration 001 (F3 above).** A2
   was already exposed to this — the README.md note "Reuses A1's enums
   `proficiency_level`, `corpus`, `book_level`, `register_level`"
   (line 203) silently uses the renamed name. Update ADR-001 §D8 so the
   contract matches reality.

2. **Hard-delete contract for `grammar_entries` (F1 above).** A2's
   loaders won't touch `grammar_entries` (it's user-owned), so this
   doesn't affect A2 directly. But the future "admin purge" job
   (mentioned in `users.deleted_at` comment, line 201–204) needs to know
   that cascading a user purge through `grammar_entries` → `vocab_cards`
   requires either soft-deleting children first or RESTRICT-ing the FK.
   Document the contract before the purge job is written.

3. **Constraint-name reservation for A2 (well done).** ADR-004 + the
   per-column comments on `vocab_cards.vocab_entry_id`,
   `vocab_cards.source_sentence_id`, `vocab_cards.topik_item_id`
   (`up.sql:725–731`) tell A2 the constraint names and ON DELETE policies
   to use. Migration 002's README confirms A2 followed the contract.
   This is the model for cross-migration coordination.

4. **`set_updated_at()` ownership (well done).** A1 defined it
   `CREATE OR REPLACE` so A2 can rely on it without redefining.
   README.md "Known gotchas" §1 calls this out explicitly. Good.

5. **Down-migration drop order across 001↔002 (well done).** A1's
   `down.sql:10–15` comment correctly states that 002 must be rolled
   back first, and that running 001 down while 002 FKs exist will fail
   at `DROP TABLE vocab_cards` — "the correct, loud failure." This is
   the right design.

---

## Summary

A1's submission clears the SENIOR_ENGINEER_BAR on every check that the
artifacts permit. The three SHOULD-FIX items are catchable, fixable, and
do not invalidate any of the core design decisions. The ADR set is
unusually complete — every contestable decision has its alternatives-
considered section, and ADR-004's deferred-FK protocol is the kind of
explicit cross-agent contract that prevents the next reviewer from
having to re-derive it. Recommend approval contingent on F1–F3.
