# Review: A3 — Docker + migration tooling

Reviewer: independent senior (30y), did not author the code under review.
Date: 2026-05-28.

## Summary verdict

**REQUEST CHANGES.** This is a competent, well-organised harness — the writing
is the best of any agent so far, the ADRs do real work, and the SECURITY.md
goes well past boilerplate. But there is **one BLOCKER**: the runner's
"one-transaction-per-migration" guarantee is *broken in practice* because both
A1's and A2's migration files contain explicit `BEGIN; ... COMMIT;` wrappers,
and the runner does nothing to handle that collision. The bookkeeping INSERT
will land in a *separate* transaction from the migration body, defeating the
atomic-application guarantee the docstring explicitly promises.

There are also several SHOULD-FIX items (statement_timeout not actually
disabled for the migration session despite the comment, ADR number collisions
left as a hand-wave, port still mapped to the host even though the
"internal-only" defence is the headline T4 control, `db-reset` `down -v`
semantics, `applied_versions` orderless dict in Python <3.7 territory). None
of those alone would block; together with the BLOCKER they justify a
"changes requested" verdict.

When the BLOCKER and SHOULD-FIXes are addressed, this is **ship-quality
infrastructure**. The bones are right.

---

## Bar checklist

| SENIOR_ENGINEER_BAR item | Pass? | Note |
|---|---|---|
| §1 PG 16+ pinned image | YES | `postgres:16-alpine`, digest slot reserved (ADR-005) |
| §1 Migrations forward+reverse, numbered, tested | YES | runner + tests; A1/A2 files conform |
| §1 Destructive ops gated | YES | `--allow-destructive` + comment-stripping detection |
| §1 Migrations idempotent | YES | re-run is a no-op (test covers it) |
| §1 Per-migration transaction | **NO** | broken by `BEGIN;/COMMIT;` in A1/A2 bodies — see BLOCKER-1 |
| §1 `application_name` set | YES | `korean-master-db`, `-server`, `-migrate` |
| §1 Statement timeout per role | PARTIAL | server side set; migrate.py *says* it overrides but doesn't — see SF-1 |
| §1 Idle-in-tx timeout | YES | 60s on server |
| §2 Pydantic at I/O boundary | N/A | no I/O boundary in this harness besides CLI args; argparse acceptable |
| §2 Type hints | YES | full hints; `from __future__ import annotations` |
| §2 Specific exception hierarchy | YES | `MigrationError` + 3 subclasses |
| §2 Never swallow exceptions | YES | structured catch + non-zero exits |
| §2 Tests against real Postgres | YES | testcontainers; no SQLite |
| §2 Public functions tested | YES | discover/destructive/full-cycle/checksum/dry-run/fail-rollback |
| §2 No print() in committed code | PARTIAL | `cmd_status` and `cmd_migrate` dry-run use `print()` — see NIT-1 (acceptable for explicitly user-facing CLI output but undocumented) |
| §2 Structured logging | YES | structlog JSONRenderer |
| §2 Parameterized SQL | YES | metadata writes parameterised; migration bodies are trusted content |
| §2 Secrets via env | YES | `.env.example` only, gitignore noted |
| §2 SECURITY.md with specific vectors | YES | 10 enumerated threats with defences, not generic |
| §3 README per module | YES | clear, includes troubleshooting table |
| §3 ADRs with alternatives | YES | runner-vs-Alembic ADR is well-argued |
| §4 Reversible by default | YES | discovery enforces up+down pair existence |
| §4 Idempotent by default | YES | checksum guard + IF NOT EXISTS pattern |
| §5 Tab indentation in Makefile | YES | verified (recipes use tabs) |
| §5 No TODO/FIXME without ticket | PARTIAL | SECURITY.md "TODOs to promote to tickets" lists 4 items — explicitly marked, acceptable |

---

## Findings

### BLOCKER

**B1.** *`migrate.py` "one-transaction-per-migration" guarantee is silently
broken by `BEGIN;/COMMIT;` in A1/A2 migration bodies.*

`migrate.py` lines 14-30 and ADR-003 §"Feature subset" both promise that
each migration body and its bookkeeping row commit atomically. The
implementation wraps the body in `with conn.transaction():` and `INSERT INTO
schema_migrations` inside the same context. That is correct *in isolation*.

But both currently-shipped migrations contain explicit transaction control:

- `001_core_schema.up.sql:35` opens with `BEGIN;` and `:839` closes with `COMMIT;`
- `001_core_schema.down.sql:18` `BEGIN;` / `:64` `COMMIT;`
- `002_darakwon_corpora.up.sql:46` `BEGIN;` / `:957` `COMMIT;`
- `002_darakwon_corpora.down.sql:22` `BEGIN;` / `:57` `COMMIT;`

Behaviour when `cur.execute(body)` runs that string inside an already-open
transaction (psycopg3, autocommit=False, transaction context entered):

1. `BEGIN;` → Postgres emits `WARNING: there is already a transaction in
   progress`. Outer tx continues.
2. body DDL runs in the outer tx.
3. `COMMIT;` → commits the outer transaction immediately. The
   `conn.transaction()` context now has no active tx.
4. The subsequent `cur.execute("SELECT clock_timestamp()")` causes psycopg to
   *implicitly start a new transaction* (autocommit=False default).
5. The `INSERT INTO schema_migrations (...)` runs in that new tx.
6. `with conn.transaction()` exits → commits the new tx (just the bookkeeping
   row), or if `apply_one` raises after step 3 but before step 6, you have a
   committed schema change with **no bookkeeping row** — the exact scenario
   the docstring promises is impossible.

This is not a theoretical concern: A1's down migration would, on failure
between its `COMMIT;` and the runner's `DELETE FROM schema_migrations` for
rollback, leave the DB in a state where the `schema_migrations` row still
says the migration is applied but the tables are gone.

It's also not testable by the current suite because the synthetic migrations
in `test_migrations.py` do **not** include `BEGIN;/COMMIT;`. The harness
passes its own tests while breaking when it meets real migrations.

**Required fix (pick one and document):**

- **Strip outer `BEGIN;/COMMIT;` in the runner** before executing the body
  (cheap and aligns with the "runner owns the transaction" contract). Reject
  inner `SAVEPOINT`/`ROLLBACK` similarly or accept they happen inside the
  outer tx.
- **OR**: document a contract that migration bodies MUST NOT contain
  `BEGIN/COMMIT/ROLLBACK/SAVEPOINT` and enforce it in `discover_migrations`,
  then require A1/A2 to remove those wrappers.

Either is fine; the current "trust the runner's transaction" message in
ADR-003 + the "be safe even alone" pattern in the migration files cannot
both be right. Coordinate before merging.

---

### SHOULD-FIX

**SF1.** *Migration session does NOT override `statement_timeout`, contradicting
the explicit claim in compose and the comment in `migrate.py`.*

`docker-compose.yml:60` says "NB: migrate.py overrides statement_timeout=0
on its connection." `migrate.py:396` says "No statement timeout for
migrations — large indexes can take a while." Neither is true:
`connect_from_env` (lines 381-397) opens a psycopg connection with no
`SET statement_timeout = 0`, so the role-level `statement_timeout = 30000`
applies. A CREATE INDEX or backfill exceeding 30 s will be killed mid-
migration. A1's `001_core_schema.up.sql` is 41 KB and creates many indexes;
on a populated DB, this *will* bite.

**Fix:** after connect, `conn.execute("SET statement_timeout = 0; SET
idle_in_transaction_session_timeout = 0")`. Add a test that asserts both
are 0 on the migration connection.

---

**SF2.** *Postgres host port is bound to `127.0.0.1`, but ADR/SECURITY claim
"DB on internal-only network" — these are not the same defence and the
network config doesn't actually isolate the DB.*

`docker-compose.yml:152-155`:
```yaml
internal:
  driver: bridge
  internal: false   # `db` exposes a host port for migrate.py / psql; flip to
                    # true once we move tooling inside containers.
```

`internal: false` means containers on this network can reach the public
internet. The `db` service is on `internal` only (line 76), and the host
port binding is loopback — that's actually fine for ingress, but the
SECURITY.md T6 mitigation "the `db` container does not have outbound
internet access" (lines 113-115) is **false**: `internal: false` lets the
container egress. A `COPY FROM PROGRAM 'curl …'` payload restored from a
malicious dump *would* reach the network.

**Fix:** set `internal: true` (block egress) and move `migrate.py` to run
inside a sidecar container (or use a separate `internal: true` plus an
egress-allowed external interface for whatever genuinely needs it — but the
DB doesn't). At minimum, correct the SECURITY.md claim.

---

**SF3.** *`make db-reset` does `docker compose down -v <service>` — but
`down -v` removes all named project volumes, not just one. The trailing
service arg is silently ignored for `-v`.*

`Makefile:79`:
```make
$(COMPOSE) down -v $(DB_SERVICE) || true
```

`docker compose down [SERVICE...]` stops/removes those services, but `-v`
("remove named volumes declared in the volumes section of the Compose file
and anonymous volumes attached to containers") applies project-wide. For
this stack there is one named volume so the net effect is correct today,
but as soon as a second volume is added (Kiwi index? sqlite for a sidecar?)
this becomes a footgun. The follow-up `docker volume rm korean_master_db_data`
is the right approach; drop the misleading `-v`.

**Fix:** `$(COMPOSE) stop $(DB_SERVICE) && $(COMPOSE) rm -f $(DB_SERVICE)`,
then `docker volume rm korean_master_db_data`.

---

**SF4.** *ADR numbering collision with A1's docs is left as a hand-wave, not
resolved.*

`db/docs/` currently has:
- `ADR-002-auth-and-sessions.md` (A1)
- `ADR-002-compose-layout.md` (A3)
- `ADR-002-stable-cols-vs-jsonb.md` (A1?)
- `ADR-003-fsrs-storage.md` (A1)
- `ADR-003-migration-runner-choice.md` (A3)
- `ADR-003-tsvector-language-config.md` (A1?)
- `ADR-004-backup-strategy.md` (A3)
- `ADR-004-soft-fk-to-corpus.md` (A1)
- `ADR-004-vocab-relations-hybrid-target.md` (A1?)
- `ADR-005-kgiu-vs-grammar-entries.md` (A2?)
- `ADR-005-postgres-version-pin.md` (A3)

README.md line 42 says "(schema ADRs owned by A1 / A2 share the 002–004
range by topic suffix)". This is *not* a numbering scheme; it's three
parallel ADR sequences competing for the same prefix and relying on
filename suffix for disambiguation. ADRs are supposed to be uniquely
numbered. When someone writes ADR-006, which sequence does it extend?

**Fix:** Either (a) renumber so each ADR has a globally unique number
(easiest: collapse all docs into one sequence), or (b) split into
subdirectories (`docs/harness/`, `docs/schema/`) so each sequence is
self-contained. Document the chosen scheme so future agents don't
re-introduce the collision.

---

**SF5.** *`docker compose exec -T pg_restore < "$FILE"` may not behave as
intended on streamed input.*

`restore.sh:53-59` pipes the dump file to `docker compose exec -T pg_restore`.
`pg_restore` with a custom-format dump can do parallel restore, but only
when reading from a *file* (it seeks). When fed via stdin it falls back to
serial restore, silently. That's fine for correctness, but the user reads
`pg_restore` and assumes parallelism.

Worse, large dumps streamed through `docker exec` go through the docker
daemon's stdio buffer, which has caused truncation issues historically.

**Fix:** either (a) copy the dump into the container first
(`docker cp "$FILE" container:/tmp/restore.dump` then exec without stdin),
or (b) mount `$BACKUP_DIR` into the db container (it already is, line 66
of compose), and pass the in-container path to `pg_restore -f`. Option (b)
is the obvious win — we already mounted `/backups`.

---

**SF6.** *`db-shell` target uses `exec` without `-it`; non-interactive shells
won't behave.*

`Makefile:140`:
```make
db-shell:
	$(COMPOSE) exec $(DB_SERVICE) psql -U $(POSTGRES_USER) -d $(POSTGRES_DB)
```

`docker compose exec` defaults to allocating a TTY when stdin is a tty, but
some CI / IDE terminals lie about this. Be explicit.

**Fix:** `$(COMPOSE) exec -it $(DB_SERVICE) psql ...`.

---

**SF7.** *`db_data` volume has no explicit driver or labels.*

`docker-compose.yml:159-161`:
```yaml
volumes:
  db_data:
    name: korean_master_db_data
```

For a production-ish stack you want at minimum `labels:` so backups can
introspect "is this our volume", and a comment on where it physically lives.
NIT-leaning, but for ops hygiene worth a SHOULD-FIX line.

**Fix:** add `labels: { app: "korean-master", component: "db", purpose: "pgdata" }`
and a comment on the bind-mount-vs-named-volume choice.

---

**SF8.** *`schema_migrations.applied_by` defaults to `current_user` — but the
runner connects as `POSTGRES_USER`, which is the superuser today. Audit
value is therefore zero.*

`migrate.py:68`:
```sql
applied_by TEXT NOT NULL DEFAULT current_user
```

When (per SECURITY.md T9 plan) you split into superuser + app role, the
runner will continue connecting as superuser, so this column will always
say `korean_master`. The intent is good; the value is wrong.

**Fix:** drop the default and have `apply_one` insert a more meaningful
value — e.g., `os.environ.get("USER") or current_database()` from the host
side, captured at runner startup. Logs already have this in the structlog
output; pulling it through to the DB lets `pg_stat_activity` cross-reference.

---

### NIT

**N1.** *`cmd_status` and dry-run pathways use `print()` instead of logging.*

Acceptable for explicitly user-facing tabular output (a logger would
JSON-encode the columns and ruin the table). The SENIOR_BAR §5 rule "no
`print()` in committed code" needs a documented exception for CLI output
formatters. Either add a comment justifying the call sites, or route
through `sys.stdout.write` with a `# CLI table output, not logging` comment.

---

**N2.** *`connect_from_env` falls back to `dsn = ""` for libpq's standard
PG* env vars, but never says so in user-facing error text.*

`migrate.py:387-390`:
```python
dsn = os.environ.get("DATABASE_URL")
if not dsn:
    # Fall back to standard libpq env vars (PGHOST, PGUSER, …).
    dsn = ""
```

If both `DATABASE_URL` and `PGHOST/PGUSER/...` are unset, `psycopg.connect("")`
produces a libpq error message that's not super helpful. Surface a checked
error: "set DATABASE_URL or PGHOST + PGUSER + PGDATABASE".

---

**N3.** *`applied_versions` returns a `dict[str, str]` and downstream code
iterates it expecting insertion order. Python 3.7+ guarantees that, but the
fact that it depends on it isn't called out.*

Add a comment that order is preserved by the `ORDER BY version` query AND
the dict ordering guarantee. Or use a `list[tuple[str, str]]` to make order
the type-level contract.

---

**N4.** *`WAIT_HEALTHY` parses JSON output of `docker compose ps` with an
inline Python one-liner. Brittle across compose versions and not what
"developer ergonomics" means.*

Use `docker inspect --format '{{.State.Health.Status}}' korean-master-db`.
Same effect, no JSON parsing, no dependency on `--format json` output
shape (which has churned across compose v2.x).

---

**N5.** *`MIGRATION_PATTERN` allows version `\d{3,}` (3+ digits). That's
fine, but means version "0010" sorts after "0099" but before "01000" only
because string sort on equal-length zero-padded strings happens to work.*

Add a comment that versions MUST be zero-padded to the SAME width, or
parse versions as integers for sorting. Today's `sorted(found)` works only
because everyone uses 3-digit numbers consistently. If someone writes
`1000_foo.up.sql`, it sorts BEFORE `999_bar.up.sql` lexically. Easy to
miss, easy to fix.

---

**N6.** *`backup.sh` retention `find … -mtime +N -delete` doesn't log which
files were pruned in the success path.*

The `-print -delete` does print them — but only to stdout, and the cron
example in README pipes to a single log file. Hard to grep. Use
structured-ish output (`echo ">> pruned: $f"` in a loop) so the operational
log is greppable.

---

**N7.** *`SHELL := /usr/bin/env bash` + `.SHELLFLAGS := -euo pipefail -c`
in the Makefile is good — but the `WAIT_HEALTHY` recipe uses `for i in $$(...)`
with a 60-iteration cap. That's 60s; first-time `initdb` on a slow disk can
take longer. README troubleshooting acknowledges this.*

Bump to 120s, or read the cap from an env var.

---

### PRAISE

**P1.** *SECURITY.md is the strongest piece of this submission.* Ten threats,
each with vector + defence in concrete language ("don't enable
`log_statement = all`", "0700/0600 mode", "internal network membership").
Even the gaps (T9 superuser issue) are honestly enumerated as "known gap"
with a plan, not glossed. This is what the global instruction
"enumerate specific attack vectors" looks like done right. Other agents
should model their SECURITY.md on this file.

**P2.** *ADR-003's rejection of Alembic is sound and well-argued.* "We own
raw SQL on purpose" is the right reason, not "NIH". The migration-out
plan ("the bookkeeping schema maps onto Sqitch/Flyway with a shim") is
the kind of risk-management seniors write but juniors skip.

**P3.** *Per-migration transaction *intent* is exactly right.* Subject to
BLOCKER-1, the apply-and-record-in-one-tx pattern is the textbook answer.
Each migration is durable independently; rollforward after a fix is
straightforward.

**P4.** *Comment-stripped destructive detection.* The `_LINE_COMMENT` and
`_BLOCK_COMMENT` regexes + the test `test_destructive_ignores_comments`
catch the obvious false-positive trap. Many migration tools don't.

**P5.** *Backup atomicity via `.partial` rename* and retention-after-success
ordering. The kind of small-stakes-but-big-payoff detail that distinguishes
careful from sloppy.

**P6.** *Restore validates the dump with `pg_restore --list` BEFORE dropping
the database.* Avoids the "drop + restore fails + we have nothing" disaster.

**P7.** *Resource limits + log caps + no-new-privileges + loopback bind in
the compose file are all present.* Most submissions get 1-2 of those; this
got all four. The blast radius of "a bug in the loader" is genuinely
contained.

**P8.** *Test suite uses real Postgres via testcontainers and explicitly
forbids SQLite.* Matches SENIOR_BAR §2.testing without complaint.

---

## Detailed findings (file:line)

| File | Line(s) | Severity | Note |
|---|---|---|---|
| `db/migrate.py` | 14-30, 215-245 | BLOCKER | Tx-per-migration guarantee defeated by `BEGIN;/COMMIT;` in migration bodies (B1) |
| `docker-compose.yml` | 60; `db/migrate.py` 396 | SHOULD-FIX | Comment claims migrate.py overrides statement_timeout=0; it does not (SF1) |
| `docker-compose.yml` | 153-154 (`internal: false`) vs `db/SECURITY.md` 113-115 | SHOULD-FIX | DB egress not actually blocked (SF2) |
| `Makefile` | 79 | SHOULD-FIX | `down -v <service>` removes project-wide volumes (SF3) |
| `db/docs/` filenames | — | SHOULD-FIX | Three parallel ADR sequences collide on numbering (SF4) |
| `db/scripts/restore.sh` | 53-59 | SHOULD-FIX | Streamed `pg_restore` loses parallelism + risks truncation; use mounted `/backups` path instead (SF5) |
| `Makefile` | 140 | SHOULD-FIX | Use `exec -it` for db-shell (SF6) |
| `docker-compose.yml` | 159-161 | SHOULD-FIX | Add labels + comment on `db_data` volume (SF7) |
| `db/migrate.py` | 68 | SHOULD-FIX | `applied_by` defaults to current_user, will be uninformative (SF8) |
| `db/migrate.py` | 277-289, 322-325, 357-359 | NIT | `print()` in CLI paths — document exception or comment (N1) |
| `db/migrate.py` | 387-397 | NIT | Surface clearer error when no DATABASE_URL or PG* set (N2) |
| `db/migrate.py` | 204-208 | NIT | Document dict-order dependency (N3) |
| `Makefile` | 41-52 | NIT | Replace inline JSON parser with `docker inspect` (N4) |
| `db/migrate.py` | 56 | NIT | Lexical version sort ok with zero-padding; comment or sort numerically (N5) |
| `db/scripts/backup.sh` | 49-51 | NIT | Pruned files not greppably logged (N6) |
| `Makefile` | 43 | NIT | 60s wait may be short on cold initdb (N7) |
| `db/SECURITY.md` | whole file | PRAISE | Best-in-class threat enumeration (P1) |
| `db/docs/ADR-003-migration-runner-choice.md` | whole | PRAISE | Sound rejection of Alembic with migration-out plan (P2) |
| `db/migrate.py` | 230-244 | PRAISE | Apply-and-record-in-one-tx pattern (P3) |
| `db/migrate.py` | 176-186; `db/tests/test_migrations.py` 147-156 | PRAISE | Comment-stripped destructive detection (P4) |
| `db/scripts/backup.sh` | 41-46, 49-51 | PRAISE | Atomic rename + retention-after-success ordering (P5) |
| `db/scripts/restore.sh` | 33-37 | PRAISE | Validates dump before dropping (P6) |
| `docker-compose.yml` | 80-97 | PRAISE | Resource limits + log caps + no-new-privileges + loopback bind (P7) |
| `db/tests/test_migrations.py` | 36-58 | PRAISE | testcontainers Postgres 16, not SQLite (P8) |

---

## Coordination observations

1. **A1/A2 wrote `BEGIN;...COMMIT;` into their migration bodies; A3 wrote a
   runner that wraps each body in its own transaction.** Both choices are
   defensible in isolation; *together* they break the atomicity guarantee
   (BLOCKER-1). This is the kind of bug that surfaces only when the agents
   meet at integration. The runner should either tolerate (strip) or refuse
   (reject) inner transaction control, and the choice should be in an ADR.

2. **ADR numbering scheme is the most visible coordination failure.**
   `docs/` has three ADR-002s, three ADR-003s, three ADR-004s, two ADR-005s.
   A3 acknowledges this in README.md ("topic suffix") but doesn't actually
   resolve it. Next agent to write an ADR has no rule to follow. Pick one
   scheme and renumber, before more accumulate.

3. **`db/migrations/README.md` and `db/migrations/SECURITY.md` exist** (the
   ls output shows them). The runner correctly ignores them because they
   end in `.md` (the `.sql` filter on `migrate.py:137` catches them first).
   That's the right behaviour and matches the criterion "discovery is
   robust"; worth a one-line test asserting it stays true.

4. **A3's SECURITY.md mentions but doesn't gate the T9 superuser gap.** This
   is correctly *not* in A3's scope (it's a schema migration), but A3
   should leave a forcing function so it doesn't get forgotten — e.g., a
   migration test that fails if the role used by the server container is
   superuser. That's a "promote to ticket" item from SECURITY.md §TODOs.

5. **The compose file's `internal: false` directly contradicts
   SECURITY.md T6's claim of no DB egress.** Either fix the network (make
   it `internal: true` and move tooling inside containers) or correct the
   threat-model claim. Pick the right answer per use case; don't ship
   the contradiction.

---

## Re-review trigger

Re-request review when:

1. BLOCKER-1 is resolved (either runner strips/rejects nested tx control,
   or migration bodies have `BEGIN/COMMIT` removed and a test asserts the
   single-tx contract end-to-end against a real migration).
2. SF1 (statement_timeout) and SF2 (network egress / SECURITY.md
   reconciliation) are addressed.
3. ADR numbering is rationalised (SF4).

Remaining SHOULD-FIXes and NITs can be follow-up tickets if explicitly
listed.
