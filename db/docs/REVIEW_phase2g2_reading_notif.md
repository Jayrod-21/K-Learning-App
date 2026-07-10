# REVIEW — Phase 2 Group 2: reading-resume (F-069/051) + notification schedules (F-040/052)

- **Branch:** `feat/phase2-g2-new-tables` (HEAD `7d8a2f4`)
- **Reviewer:** independent senior review — did not author this code
- **Scope:** `db/migrations/051_reading_positions.{up,down}.sql`,
  `db/migrations/052_notification_schedules.{up,down}.sql`,
  `db/tests/test_migration_051.py`, `db/tests/test_migration_052.py`,
  `server/src/routes/reading.ts`, `server/src/routes/notifications.ts`,
  `server/tests/routes/reading.test.ts`, `server/tests/routes/notifications.test.ts`
- **Gate run:** `npx vitest run tests/routes/reading.test.ts tests/routes/notifications.test.ts`
  → **2 files passed, 56/56 tests passed** (100s). Full suite deliberately not run (OOM policy).

## Verdict: **APPROVE — 0 BLOCKERS, 3 SHOULD-FIX, 5 NIT, coordination items below**

Both features are structurally sound. The 051 owner-guard composite FK is a
faithful and correct reuse of the 044 pattern; the 052 schedule model's
constraint set is exact and fully proven by tests. No IDOR hole, no
data-integrity gap, no irreversibility problem was found. The SHOULD-FIXes are
a convention miss (optimistic-lock `version` never bumps on the position
upsert) and two stale/imprecise rollback-target constants in the db tests that
the Group-1 merge invalidated.

---

## Feature 1 — F-069 reading-resume (migration 051 + `/reading/position`)

### Verified correct

- **Owner-guard composite FK** — `db/migrations/051_reading_positions.up.sql:115-118`
  declares `FOREIGN KEY (source_upload_id, user_id) REFERENCES book_uploads(id, user_id)
  ON DELETE CASCADE`. Column pairing is correct (`source_upload_id→id`,
  `user_id→user_id`), riding 044's `uq_book_uploads_id_user`
  (`044_reading_chapters.up.sql:76-83`). A `(user B, user A's upload)` row is
  structurally impossible; proven by a real cross-user insert bouncing off the
  FK in `db/tests/test_migration_051.py:272-290`
  (`test_051_up_owner_guard_rejects_foreign_upload`) and shape-asserted against
  `pg_constraint` (confdeltype `c`, confupdtype `r`) at
  `test_migration_051.py:236-248`.
- **Chapter composite FK + column-list SET NULL** —
  `051_reading_positions.up.sql:123-126`:
  `FOREIGN KEY (chapter_id, source_upload_id) REFERENCES reading_chapters(id, source_upload_id)
  ON DELETE SET NULL (chapter_id)`, backed by the new
  `uq_reading_chapters_id_upload` (`051…up.sql:74-82`, guarded `DO $$` per the
  044/002 idempotency pattern). This is the right call twice over: the
  composite pins a position's chapter to the *same* upload (proven at
  `test_migration_051.py:310-311`), and the PG-15+ column-list form nulls only
  `chapter_id` — plain `SET NULL` would try to null `source_upload_id`, a
  NOT NULL PK member, and abort every chapter delete. The test asserts
  `confdelsetcols == ['chapter_id']` (`test_migration_051.py:253-269`) —
  exactly the assertion that matters.
- **Graceful degradation on book re-load** — the design note at
  `051…up.sql:50-59` (semantic invariants deliberately NOT table CHECKs,
  because Postgres re-checks CHECKs on the referential-action UPDATE and would
  turn a chapter DELETE into a 23514) is analytically correct and — rarer —
  *proven*: `test_migration_051.py:376-392` deletes the chapter under a
  chapter-only position and asserts the row survives fully degraded. The API
  side then normalizes: `server/src/routes/reading.ts:285-289` filters
  `(chapter_id IS NOT NULL OR page_number IS NOT NULL)` so a
  points-nowhere row reads as `{ position: null }` instead of pushing the
  judgment onto clients (route test `reading.test.ts:265-286`).
- **IDOR posture** — both position routes gate through `assertOwnedUpload`
  (`reading.ts:77-85`, user-scoped, uniform 404); the chapter gate on PUT
  additionally requires `(id, source_upload_id, user_id)` to line up
  (`reading.ts:352-359`), so a foreign chapter and a same-user-wrong-book
  chapter both 404 without confirming existence. Route tests cover foreign
  upload read (`reading.test.ts:243-257`), foreign upload write **with a
  no-row-written assertion** (`reading.test.ts:403-420`), foreign chapter
  (`:422-444`), and wrong-book chapter (`:446-463`). Defense in depth is real,
  not rhetorical: even a bypassed handler cannot produce a cross-user row.
- **Parameterization / validation** — every id coerced, positive, upper-bounded
  (`MAX_ID` at `reading.ts:64`, `MAX_INT4` at `:69` matching the int4 columns);
  body schema `.strict()` with both semantic refinements
  (`reading.ts:311-323`); all SQL bound parameters. The 400-matrix test
  (`reading.test.ts:477-500`) exercises empty body, passage-without-chapter,
  int4 overflow, float, and unknown-key cases.
- **Reversibility (ADR-013)** — no top-level tx control in either file; the
  `DO $$` guard is PL/pgSQL and passes the detector by design. `051….down.sql`
  drops dependents-first (`:20` table, then `:24` the backing UNIQUE), restoring
  reading_chapters to its exact 044 shape; `DROP TABLE` correctly trips the
  destructive gate (documented `051….down.sql:9-11`; `migrate.py:83-86`
  confirms the pattern matches). Down + clean re-up proven at
  `test_migration_051.py:409-448`.

### Findings

- **SHOULD-FIX (F1-1): position upsert never bumps `version`** —
  `server/src/routes/reading.ts:380-383`: the `DO UPDATE` arm sets the three
  pointer columns but not `version`. ADR-001 §D6 defines `version` as the
  optimistic-concurrency counter the *app* increments on write, and every other
  mutating route on this branch honors it — including this PR's own sibling
  (`notifications.ts:243 version = notification_schedules.version + 1`), plus
  `tickets.ts:257`, `grammar.ts:202`, `vocabLists.ts:415`. As shipped,
  `reading_positions.version` is frozen at 1 forever (the 001 trigger only
  touches `updated_at` — `001_core_schema.up.sql:59-67`), making the column
  dead weight and the table an inconsistency the next reader will trip on.
  One-line fix: add `version = reading_positions.version + 1` to the SET list.
  Not a blocker — nothing consumes the column today.
- **SHOULD-FIX (F1-2): stale rollback target + false comment in the 051 db test** —
  `db/tests/test_migration_051.py:60-62`: `PRE_051 = "047"` with the comment
  "048–050 are unassigned gaps … rolls back exactly 051". That was true when
  authored but the Group-1 merge (`2e09aab`) landed real 048/049/050, so
  `down --target 047` now rolls back **048 through 052 — five migrations**, and
  the test no longer isolates 051's down (its `--allow-destructive` is now also
  satisfying 052's DROP TABLE, per the same discovery that forced commit
  `7d8a2f4` on test_050). The assertions still pass — the test is not wrong,
  just unfocused and mislabeled. Fix: `PRE_051 = "050"` + correct the comment.
- **NIT (F1-3): TOCTOU on chapter delete mid-PUT → 500, not 404** — the race is
  explicitly documented (`reading.ts:345-350`): a chapter deleted between the
  route check and the INSERT surfaces as an FK violation (500) rather than 404.
  Never a cross-book row, occurrence requires a concurrent re-load; acceptable
  for a single-user app. Mapping 23503 to 409/404 would be polish only.
- **NIT (F1-4): no index leading on `chapter_id`** — the chapter FK's SET NULL
  scan during a re-load's chapter deletes has no supporting index (the PK leads
  `user_id`). At ≤1 row per (user, book) this is a seq scan over a tiny table;
  correctly not over-engineered, noting for the record.
- **PRAISE**: the "why the semantic invariant must NOT be a CHECK" analysis
  (`051…up.sql:50-59`) is subtle, correct, and — the part most authors skip —
  proven by the exact failing scenario (`test_migration_051.py:370-392`). The
  GET-side degraded-row normalization (`reading.ts:271-289`) closes the loop so
  no client ever sees a points-nowhere position.

---

## Feature 2 — F-040 notification schedules (migration 052 + `/notifications/schedules`)

### Verified correct

- **Schedule model** — `052_notification_schedules.up.sql:96-113`:
  `UNIQUE (user_id, kind, channel)` is the right upsert key for "per kind, per
  channel, one timing," and the note that its backing index doubles as the
  per-user list index (so no redundant `(user_id)` index) is correct.
  `time_of_day TIME` + `tz TEXT` is the correct DST-safe decomposition; tz
  validity properly delegated to the route (a CHECK cannot consult
  `pg_timezone_names` — `up.sql:39-43`), with `isValidTimeZone` via
  `Intl.DateTimeFormat` at `notifications.ts:67-74`. The weekday⟷kind CHECK
  (`up.sql:106-111`) enforces both directions (weekly requires 0–6; daily
  forbids), and the db test violates it **both ways plus out-of-range**
  (`test_migration_052.py:192-199`). Zod mirrors every DB rule exactly
  (`notifications.ts:54-109`), so nothing that passes validation can 500 at a
  constraint — the km "distrust schemas looser than the DB constraint" lesson,
  applied.
- **SMS placeholder** — accepted + stored (CHECK blesses `'sms'`,
  `up.sql:101`), never sent (no sender exists in this phase), flagged
  `placeholder: true` in every response (`notifications.ts:173`). Proven
  end-to-end including a stored-row assertion
  (`notifications.test.ts:162-175`). Blessing `sms` in the CHECK now to avoid a
  later CHECK-swap migration is the right cheap call.
- **Deliveries log** — shape is sane for the future sender: FK CASCADE from
  schedules (`up.sql:167-169`; erasure chain users→schedules→deliveries proven
  at `test_migration_052.py:269-287`), status set CHECKed, the
  `sent ⇒ sent_at` invariant (`up.sql:174-175`) proven in both directions
  (`test_migration_052.py:241-258`), and `(schedule_id, created_at DESC)`
  probe index (`up.sql:195-196`). See coordination note F2-2 on the claim
  semantics.
- **PUT upsert atomic + user-scoped** — single multi-row
  `INSERT … SELECT unnest(...) ON CONFLICT ON CONSTRAINT` statement
  (`notifications.ts:230-253`): the batch commits or aborts as one statement,
  no tx plumbing needed. `user_id` comes only from the session ($1); there is
  no `:id` in any path, so cross-user access is structurally inexpressible.
  Row-count abuse is closed twice: `MAX_SCHEDULES = 9` cap plus intra-payload
  duplicate rejection (`notifications.ts:114-135`) — the duplicate check also
  prevents the ON CONFLICT touch-same-row-twice Postgres error, and both are
  tested (`notifications.test.ts:203, 217-224`). IDOR isolation has a
  dedicated two-user test (`notifications.test.ts:227-248`).
- **Supersedes 018 without breaking settings** — `settings.ts` is untouched;
  `NotifPrefsSchema` (`settings.ts:93-100`) still validates the blob's notif
  booleans, so existing stored blobs keep round-tripping. The new API is
  additive on its own tables and its own `/notifications` prefix
  (`server/src/app.ts:105`), which **is present in both active nginx
  allow-lists** (`Deploy/nginx-blue-active.conf:82,144`,
  `Deploy/nginx-green-active.conf:82,144`) — the F-012 /ttmik trap was
  avoided. The blob's booleans becoming dead keys after the client migrates is
  documented in both the migration (`up.sql:22-25`) and route header.
- **Reversibility (ADR-013)** — no top-level tx control; down drops
  dependents-first (`052….down.sql:25-26`), is `IF EXISTS`-idempotent, and its
  `DROP TABLE` destructive gating is not just documented but **asserted**: the
  test first proves the runner refuses without `--allow-destructive` and that a
  refused rollback leaves the schema untouched (`test_migration_052.py:314-322`)
  before performing it with the flag and re-upping clean (`:325-346`). That
  refusal-path assertion is above the usual bar.

### Findings

- **SHOULD-FIX (F2-1): stale rollback target + false comment in the 052 db test** —
  `db/tests/test_migration_052.py:56-58`: `PRE_052 = "047"` described as "the
  migration immediately before 052 … rolls back exactly 052 and nothing else."
  Both claims are now false: 051 is immediately before 052, and
  `down --target 047` rolls back 048–052. Consequence beyond staleness: the
  gate-refusal assertion (`:314-318`, "052.down contains DROP TABLE — the gate
  must refuse it") would pass even if 052.down were made non-destructive,
  because 051.down's DROP TABLE is in the same descent — the test does not
  actually isolate 052's gate behavior. Fix: `PRE_052 = "051"`.
- **Coordination (F2-2): delivery "claim" has no uniqueness — future sender must add one** —
  the log's idempotency story is probe-newest-then-insert-pending
  (`up.sql:180-199`). Without a `UNIQUE (schedule_id, <firing-window>)` there
  is a probe→insert race window in which two workers both claim one firing.
  Fine to defer (single-user app, no sender exists, table trivially alterable),
  but the sender phase should add a `window_start` column + unique constraint
  as the real claim rather than trusting the probe. Flagging so it lands in
  that phase's spec, not as a production surprise.
- **Coordination (F2-3): dual notification-intent stores until the client migrates** —
  the Settings screen still writes the 018 blob booleans; nothing on this
  branch moves it to `/notifications/schedules`. Harmless by design
  (documented), but a client follow-up ticket should exist so the blob keys
  actually die instead of drifting as a second source of truth.
- **NIT (F2-4): `Deploy/nginx.conf` allow-list drift** — the base/template conf
  (`Deploy/nginx.conf:82,144`) lacks `tickets|notifications` while both active
  confs carry them. `local-standup.sh:104` seeds the live conf from
  `nginx-{color}-active.conf`, so this file appears vestigial — but
  `docker-compose.shared.yml:59` notes `KM_LIVE_NGINX_CONF` *defaults* to
  `./nginx.conf`, so keeping it in sync (or deleting it) closes a
  foot-gun for a future fresh standup.
- **NIT (F2-5): `weekday` must be omitted, not `null`** — the Zod field is
  `.optional()` not `.nullable()` (`notifications.ts:90`), so a client sending
  `weekday: null` for a daily kind gets a 400 where omitting passes. Ergonomics
  only; the strict posture is defensible. Worth a line in the client-facing DTO
  doc when the Settings UI adopts this API.
- **PRAISE**: exact Zod⟷CHECK mirroring; the single-statement batch upsert; the
  9-row ceiling + duplicate-pair rejection killing an entire error class before
  SQL; and the 052 db test proving *every* declarative rule with a violating
  row rather than asserting catalog metadata alone.

---

## Gate results

| Suite | Result |
|---|---|
| `server tests/routes/reading.test.ts` | pass (part of 56) |
| `server tests/routes/notifications.test.ts` | pass (part of 56) |
| **Total** | **2 files, 56/56 passed, 100s** |

Db migration tests (test_migration_051/052.py) were reviewed by reading, not
executed, per the targeted-gate instruction (testcontainers chain runs are the
OOM-heavy path); their assertions were cross-checked against the actual SQL and
`migrate.py` gate patterns (`db/migrate.py:83-86`).

## Coordination summary (for the merge captain)

1. F1-1 + the two test PRE-target fixes (F1-2, F2-1) are one small commit; no
   schema or API change required for any finding.
2. F2-2 must be copied into the notification-sender phase spec.
3. F2-3 needs a client-side follow-up ticket (Settings → /notifications/schedules).
4. `/notifications` nginx allow-list already handled on both active colors —
   nothing to do at deploy time; optionally sync or retire `Deploy/nginx.conf` (F2-4).
