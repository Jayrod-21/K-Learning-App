# REVIEW — Phase 2 G2: Beta Ticketing System (F-023, migration 048)

**Reviewer:** independent senior review (security-focused), 2026-07-10
**Branch:** `feat/phase2-g2-new-tables`
**Scope:** `db/migrations/048_tickets.{up,down}.sql`, `db/tests/test_migration_048.py`,
`server/src/routes/tickets.ts`, `server/tests/routes/tickets.test.ts`,
mount in `server/src/app.ts`, nginx allow-list in `Deploy/nginx-{blue,green}-active.conf`
**Standards applied:** ADR-013 (migration tx ownership), F-023 anonymity contract,
IDOR/404-shape parity, optimistic concurrency, parameterized SQL, strict Zod.

---

## Summary verdict: **PASS — no blockers**

The anonymity contract holds at the SQL level, not just the response shape: no
community-facing SELECT list contains `user_id`, `email`, or a join to `users`.
IDOR posture is correct with byte-identical 404s for foreign vs. absent
tickets. The migration is ADR-013-compliant, idempotent, reversible, and
catalog-verified by its test. Targeted gate: **28/28 route tests pass**
(real Postgres testcontainer, 32.8s). 0 BLOCKER · 1 SHOULD-FIX · 5 NIT.

---

## Gate evidence (run by this reviewer)

```
cd server && npx vitest run tests/routes/tickets.test.ts
Test Files  1 passed (1)
Tests       28 passed (28)
Duration    32.80s
```

No OOM/worker crashes. The db migration suite was not re-run here per review
coordination (parent-confirmed db 44/44; integration reviewer re-verifies the
merged chain).

---

## Focus area 1 — Anonymization (the F-023 contract): VERIFIED

Checked every SELECT that can reach a non-owner caller:

- `GET /tickets/community` — `server/src/routes/tickets.ts:184-194`. SELECT
  list is `t.id, t.type, t.title, t.body, t.status, comment_count, is_mine,
  t.created_at, t.updated_at`. `user_id` appears only inside the boolean
  expression `(t.user_id = $1) AS is_mine` (line 186), where `$1` is the
  **caller's** session id (`getUserId(req)`, line 165). The projection never
  emits the raw column and there is no join to `users`, so no email/name can
  reach the wire from this query under any parameter value.
- `GET /tickets/:id/comments` — `tickets.ts:365-371`. Same pattern:
  `c.id, c.body, (c.user_id = $2) AS is_mine, c.created_at`. No `users` join.
- `POST /tickets` RETURNING (`tickets.ts:111`), `GET /tickets/mine`
  (`tickets.ts:138-148`), PATCH RETURNING (`tickets.ts:259`), comment INSERT
  RETURNING (`tickets.ts:314`) — all owner-facing, and even these exclude
  `user_id`/email. Nothing anywhere in the router serializes an identity
  column, so there is no owner-only field for a future refactor to
  accidentally promote into a community response.
- `is_mine` leaks nothing about other authors: it is a comparison against the
  caller's own id only. A caller learns "mine / not mine," which they already
  know. Test coverage asserts this cross-user (`tickets.test.ts:202-209`,
  `347-349`).
- Structural payload assertion: `assertAnonymized()`
  (`tickets.test.ts:41-46`) scans the entire serialized response for
  `user_id` / `userId` / `email` on create (99), community feed (200),
  comment create (332), and thread read (346).
- Defense in depth at the schema level: `048_tickets.up.sql:26-30` documents
  that anonymity is a route-layer contract and deliberately provides **no
  display-name column** — there is nothing identity-shaped in the table to
  tempt a future SELECT.
- Error paths cannot leak either: Zod rejects before SQL, and DB errors route
  through the central `errorHandler` (`app.ts:128`, generic 500 + correlation
  id only — `middleware/errors.ts` header comment).

Residual (inherent, not a defect): in a very small beta, `is_mine=false` plus
writing style is a weak deanonymization side channel. That is intrinsic to any
anonymized feed among a handful of users; no code change can remove it.

## Focus area 2 — IDOR: VERIFIED

- `PATCH /tickets/:id` pre-read is scoped `WHERE id = $1 AND user_id = $2`
  (`tickets.ts:237`), and the UPDATE re-scopes `id AND user_id AND version`
  (`tickets.ts:258`). A foreign ticket and an absent ticket both throw
  `NotFoundError('ticket not found')` (`tickets.ts:241`) — same class, same
  message, same code (`middleware/errors.ts:46-51`), so the JSON shape is
  byte-identical. Both cases execute the **same single SELECT**, so there is
  no timing side channel distinguishing them either.
- Test proves shape parity, not just status: `tickets.test.ts:263-281`
  compares `error.code` **and** `error.message` across foreign vs. absent.
- Comments on foreign tickets are intentionally allowed (community surface);
  ticket existence is already public via `/community`, so the existence check
  at `tickets.ts:311-314` discloses nothing new. Documented in the threat
  model (`tickets.ts:26-28`) and in the route comment (`tickets.ts:302-305`).
- Mass assignment: every body schema is `.strict()` (`tickets.ts:98, 213,
  287`); `user_id`/`version` smuggling is 400'd before SQL
  (tests at `tickets.test.ts:129-138, 388-391`).

## Focus area 3 — Migration 048 (ADR-013, reversibility): VERIFIED

- **ADR-013:** no top-level `BEGIN`/`COMMIT`/`ROLLBACK` in either file
  (verified by read; explicit notes at `048_tickets.up.sql:36-38` and
  `048_tickets.down.sql:12-14`). The discovery-time detector would reject the
  files otherwise; they load and run in the test chain.
- **Idempotent up:** `CREATE TABLE IF NOT EXISTS` (44, 118),
  `CREATE INDEX IF NOT EXISTS` (98, 105, 147), and — notably —
  `CREATE OR REPLACE TRIGGER` (111), which is exactly the fix for the prior
  production incident where a non-idempotent `CREATE TRIGGER` failed a
  re-deploy (see memory: never hand-apply migrations to km-db). PG16 pin
  (ADR-012) makes `CREATE OR REPLACE TRIGGER` (PG14+) safe.
- **Reversible down:** child table dropped before parent
  (`048_tickets.down.sql:21-22`), both `IF EXISTS`; destructive gate
  documented (down:16-18) and exercised — the test passes
  `--allow-destructive` for the down in its own right
  (`test_migration_048.py:319-323`). Re-up after rollback verified
  (`test_migration_048.py:340-346`). README row present
  (`db/migrations/README.md:61`).
- **FKs:** all three CASCADE / ON UPDATE RESTRICT, asserted from
  `pg_constraint` catalogs rather than prose (`test_migration_048.py:204-221`),
  and both cascade paths exercised on real rows: ticket-delete takes exactly
  its own thread (276-281); user-delete takes their tickets AND their comments
  on others' tickets (283-289) — the correct GDPR-ish posture the up-file
  documents (up.sql:18-21, 31-34).
- **Indexes:** `(user_id, updated_at DESC)` matches `/mine`'s WHERE+ORDER BY;
  `(status, updated_at DESC)` matches the filtered community feed;
  `(ticket_id, created_at)` matches the thread ORDER BY. Sane; see NIT-4 for
  the unfiltered-feed caveat.
- **CHECKs mirror Zod exactly** (type/status sets, 1–200 title, 1–5000 body,
  1–2000 comment, version ≥ 1; up.sql:67-78, 135-136) and every one is
  rejection-tested against a live DB (`test_migration_048.py:227-248`) — real
  corpus-style verification, not mocked, per the "DB constraint is the floor"
  lesson.

## Focus area 4 — Optimistic concurrency, validation, injection: VERIFIED

- **Concurrency:** PATCH requires `expected_version` (Zod-mandatory,
  `tickets.ts:211`); pre-read mismatch → 409 (`tickets.ts:242-244`); the
  UPDATE re-checks `version = $3` so a writer that sneaks between pre-read and
  UPDATE still loses cleanly (rowCount 0 → 409, `tickets.ts:258, 272-273`).
  `version = version + 1` on every UPDATE. Tested at
  `tickets.test.ts:246-261`. `expected_version` is bounded at INT4 max
  (`tickets.ts:64-65, 211`) matching the INTEGER column.
- **Bounds:** ids and offsets capped at `Number.MAX_SAFE_INTEGER`
  (`tickets.ts:63, 68, 73`) so a 20-digit id is a 400, not a pg 22003 → 500;
  tested (`tickets.test.ts:66-81`). Zod `.trim()` transforms are written back
  into `req.body` by `validateBody` (`middleware/validate.ts:20-21`), so the
  DB receives sanitized values; Zod's UTF-16 length is ≤ pg `length()` chars,
  so the API is never looser than the CHECK — the correct direction.
- **Injection:** every statement is parameterized (`$n` placeholders
  throughout `tickets.ts`; no template interpolation anywhere in the file).
- **Rate limiting:** all six endpoints sit behind `cheapLimiter()`
  (`tickets.ts:102, 127, 162, 222, 291, 336`), matching house convention for
  DB-backed CRUD (cf. `vocab.ts`). `requireAuth` is router-wide
  (`tickets.ts:54`); 401s tested for all six endpoints
  (`tickets.test.ts:48-64`).
- **Plumbing:** mounted before the 404 fallthrough and error handler
  (`server/src/app.ts:117-128`); nginx allow-list carries `tickets` in BOTH
  `Deploy/nginx-blue-active.conf` (lines 82, 144) and
  `Deploy/nginx-green-active.conf` (lines 82, 144) — both server blocks, so
  the SPA cannot shadow the API (the F-012 lesson applied).

---

## Findings

### BLOCKER

None.

### SHOULD-FIX

1. **PATCH after concurrent ticket deletion returns 409 instead of 404**
   — `server/src/routes/tickets.ts:252-273`. If the ticket row vanishes
   between the pre-read (line 236) and the UPDATE (line 252) — today only
   possible via a cascading `DELETE FROM users` — the UPDATE affects 0 rows
   and the handler throws `ConflictError('stale ticket version')`
   (line 273), telling the client to refetch-and-retry a ticket that no longer
   exists (the refetch will 404, so the client self-corrects after one wasted
   round trip). Low severity now, but the ambiguity becomes user-visible the
   day a `DELETE /tickets/:id` endpoint is added. Cheap fix: when
   `rows[0]` is absent, re-probe existence (scoped to the owner) and throw
   `NotFoundError` vs `ConflictError` accordingly. Fine to defer; do not ship
   a future delete endpoint without it.

### NIT

1. **Doc/code drift on status transitions** —
   `db/migrations/048_tickets.up.sql:90-91` says lifecycle "transitions are
   route-layer policy, not a DB state machine," but the route enforces no
   transition policy at all: any owner may move any status to any status,
   including `closed → open` (`tickets.ts:206-218` allows any
   `TICKET_STATUS`). Harmless for a single-author-moderated beta (the up-file
   itself notes there is no admin role, line 57), but either implement the
   forward-only policy or soften the comment so a future reader doesn't
   assume a guarantee that isn't there.
2. **`assertAnonymized` is substring-based** —
   `server/tests/routes/tickets.test.ts:41-46` scans
   `JSON.stringify(payload)` for `user_id`/`userId`/`email`. It would
   false-fail on a ticket whose *body text* legitimately contains the word
   "email" (plausible in real bug reports), and it cannot catch a leak under
   another name (e.g. `author_id`). A key-path walk asserting an allow-list
   of permitted keys would be both stricter and non-brittle.
3. **No moderation/removal path for comments** — there is no
   DELETE/redact endpoint for `ticket_comments` (by design, append-only:
   `048_tickets.up.sql:31-34`). In an anonymized shared feed, the only way to
   remove a regrettable comment is manual SQL. Acceptable at personal-app
   scope; worth a backlog line before the friend-beta widens.
4. **`ix_tickets_status_updated` won't serve the unfiltered feed** — the
   community query's `($2::text IS NULL OR t.status = $2)` pattern
   (`tickets.ts:190`) defeats index use when no status filter is supplied, so
   the default feed is a seq-scan + sort. Irrelevant at beta row counts;
   revisit only if tickets ever exceed ~10^5 rows.
5. **`GET /tickets/:id/comments` existence check is a separate query** —
   `tickets.ts:351-355` then 357-373. A ticket deleted between the two
   returns an empty 200 for a dead ticket instead of a 404. Momentary and
   harmless; the single-statement pattern used by the comment INSERT
   (`tickets.ts:311-314`) shows the team already knows the stronger idiom.

### PRAISE

1. The anonymity contract is enforced where it can actually be audited — in
   the SELECT lists — and the up-file (`048_tickets.up.sql:26-30`) explicitly
   refuses to add a display-name column so the schema itself cannot tempt a
   leak. The threat-model header (`tickets.ts:17-39`) documents each defense
   with the mechanism, not slogans.
2. `CREATE OR REPLACE TRIGGER` (`048_tickets.up.sql:111`) directly encodes the
   prior production trigger-idempotency incident. Institutional memory
   landing in code.
3. The migration test asserts FK delete/update rules from `pg_constraint`
   (`test_migration_048.py:204-221`) and exercises both cascade paths on real
   rows — including the subtle case that a user's comments on *other
   people's* tickets die with the user (283-289).
4. The IDOR test compares 404 code AND message across foreign/absent
   (`tickets.test.ts:274-280`) — testing the actual non-enumeration property,
   not merely the status code.
5. The comment INSERT's `INSERT … SELECT … WHERE EXISTS` (`tickets.ts:311-314`)
   collapses check+insert into one statement, eliminating the TOCTOU FK-500.

---

## Coordination notes

- No changes were made to any file (review-only).
- SHOULD-FIX 1 and all NITs are non-blocking for the G2 merge; SHOULD-FIX 1
  should be tracked and MUST be revisited if/when a ticket-delete endpoint is
  designed (also revisit NIT-3 at that time — deletion and moderation are the
  same design conversation).
- The integration reviewer should confirm 048 sits correctly in the merged
  chain ordering with 047 (`km_app_role`) and 049-052 (it did in this
  reviewer's targeted runs via the route suite's migrated testcontainer).
- Nothing in this slice conflicts with the notifications (052) nginx
  allow-list change — both prefixes coexist in the same regex on all four
  lines checked.
