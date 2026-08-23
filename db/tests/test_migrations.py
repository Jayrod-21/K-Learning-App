"""Integration tests for the migration runner.

These tests spin up a real Postgres 16 container via testcontainers so we
exercise the SAME engine production uses. SQLite is explicitly forbidden by
SENIOR_ENGINEER_BAR §2.testing — it lies about FKs, enums, JSONB, and
triggers.

WHAT THESE TESTS COVER:
    * Discovery: filenames matching the contract; missing pairs raise.
    * Bookkeeping: schema_migrations table is created and populated.
    * Forward: applies all migrations, idempotent on re-run.
    * Reverse: rolls back each migration, ending with an empty schema
      (only schema_migrations + the trigger function may remain).
    * Checksum guarding: editing an applied migration raises ChecksumMismatch.
    * Destructive guarding: DROP TABLE without --allow-destructive raises.

WHAT THESE TESTS DO NOT COVER:
    * The CONTENTS of A1's and A2's migrations. Their tests verify schema
      shape; this file verifies the harness. We use synthetic migrations
      written into a temp dir per test for that reason.

RUNNING:
    make db-test
"""

from __future__ import annotations

import os
import pathlib
import textwrap

import psycopg
import pytest

from db import migrate  # type: ignore[import-not-found]

try:
    from testcontainers.postgres import PostgresContainer  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    PostgresContainer = None  # type: ignore[assignment]


pytestmark = pytest.mark.skipif(
    PostgresContainer is None,
    reason="testcontainers not installed — `pip install testcontainers[postgres]`",
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def migrations_dir(tmp_path: pathlib.Path) -> pathlib.Path:
    """A fresh migrations directory the test writes synthetic migrations into."""
    d = tmp_path / "migrations"
    d.mkdir()
    return d


def write_pair(
    directory: pathlib.Path,
    version: str,
    name: str,
    up: str,
    down: str,
) -> None:
    (directory / f"{version}_{name}.up.sql").write_text(textwrap.dedent(up), encoding="utf-8")
    (directory / f"{version}_{name}.down.sql").write_text(textwrap.dedent(down), encoding="utf-8")


def list_user_tables(conn: psycopg.Connection) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT tablename
              FROM pg_tables
             WHERE schemaname = 'public'
               AND tablename NOT LIKE 'pg_%'
             ORDER BY tablename
            """
        )
        return [r[0] for r in cur.fetchall()]


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

def test_discover_orders_by_version(migrations_dir: pathlib.Path) -> None:
    write_pair(migrations_dir, "002", "second", "SELECT 1;", "SELECT 1;")
    write_pair(migrations_dir, "001", "first", "SELECT 1;", "SELECT 1;")
    discovered = migrate.discover_migrations(migrations_dir)
    assert [m.version for m in discovered] == ["001", "002"]


def test_discover_missing_down_raises(migrations_dir: pathlib.Path) -> None:
    (migrations_dir / "001_orphan.up.sql").write_text("SELECT 1;")
    with pytest.raises(migrate.MissingPair):
        migrate.discover_migrations(migrations_dir)


def test_discover_bad_filename_raises(migrations_dir: pathlib.Path) -> None:
    (migrations_dir / "weird.sql").write_text("SELECT 1;")
    with pytest.raises(migrate.MigrationError):
        migrate.discover_migrations(migrations_dir)


# ---------------------------------------------------------------------------
# Destructive detection
# ---------------------------------------------------------------------------

def test_destructive_detected() -> None:
    assert migrate.contains_destructive("DROP TABLE foo;")
    assert migrate.contains_destructive("truncate table foo;")
    assert migrate.contains_destructive("ALTER TABLE x;\nDROP   TABLE y;")
    assert migrate.contains_destructive("DROP SCHEMA public CASCADE;")
    assert migrate.contains_destructive("DROP DATABASE kmdb;")


def test_destructive_ignores_recreatable_schema_objects() -> None:
    # Dropping recreatable schema objects is NOT data loss — our forward
    # migrations use the idempotent DROP ... IF EXISTS + recreate pattern to
    # redefine constraints/indexes/enums. These must NOT require
    # --allow-destructive (else every additive migration would be blocked).
    assert not migrate.contains_destructive("DROP INDEX IF EXISTS ix_foo;")
    assert not migrate.contains_destructive("DROP TYPE IF EXISTS my_enum;")
    assert not migrate.contains_destructive(
        "ALTER TABLE t DROP CONSTRAINT IF EXISTS ck_t_shape;"
    )


def test_destructive_ignores_comments() -> None:
    sql = textwrap.dedent(
        """
        -- DROP TABLE foo;
        /* TRUNCATE TABLE bar; */
        CREATE TABLE baz (id BIGINT PRIMARY KEY);
        """
    )
    assert not migrate.contains_destructive(sql)


# ---------------------------------------------------------------------------
# F-088: explicit per-migration destructive marker (vs pattern-sniffing)
# ---------------------------------------------------------------------------

def test_explicit_marker_catches_what_sniffing_misses() -> None:
    # A mass DELETE has no DROP TABLE/TRUNCATE keyword at all — sniffing alone
    # would call this safe (the exact F-088 motivating gap: 046.down's
    # history-DELETE). The explicit marker must still gate it.
    sql = "-- migrate: destructive\nDELETE FROM topik_attempts WHERE true;"
    assert migrate.contains_destructive(sql)
    assert migrate.explicit_destructiveness(sql) is True


def test_explicit_non_destructive_marker_overrides_pattern_sniff() -> None:
    # The declaration is authoritative even where sniffing alone would have
    # blocked (a DROP TABLE the author has reviewed and declared safe in
    # context — e.g. a scratch table with no user data).
    sql = "-- migrate: non-destructive\nDROP TABLE IF EXISTS scratch_only;"
    assert not migrate.contains_destructive(sql)
    assert migrate.explicit_destructiveness(sql) is False


def test_marker_is_case_insensitive_and_whitespace_tolerant() -> None:
    assert migrate.contains_destructive("--   Migrate:   DESTRUCTIVE  \nSELECT 1;")
    assert not migrate.contains_destructive("-- MIGRATE: NON-DESTRUCTIVE\nSELECT 1;")


def test_unmarked_migration_falls_back_to_pattern_sniff() -> None:
    # Backward compat (the ticket's hard requirement): every migration
    # written before F-088 carries no directive and must classify EXACTLY as
    # it did before this feature existed.
    assert migrate.explicit_destructiveness("DROP TABLE foo;") is None
    assert migrate.contains_destructive("DROP TABLE foo;")
    assert not migrate.contains_destructive("DROP INDEX IF EXISTS ix_foo;")


def test_conflicting_markers_raise() -> None:
    sql = "-- migrate: destructive\n-- migrate: non-destructive\nSELECT 1;"
    with pytest.raises(migrate.ConflictingDestructiveMarkers):
        migrate.contains_destructive(sql)
    with pytest.raises(migrate.ConflictingDestructiveMarkers):
        migrate.explicit_destructiveness(sql)


def test_marker_inside_string_literal_is_not_forged() -> None:
    # A documentary string literal containing the marker phrase must not
    # suppress the real DROP TABLE's classification — same "err toward
    # false-positive" posture `strip_sql_noise` documents.
    sql = (
        "DROP TABLE really_gone;\n"
        "COMMENT ON TABLE foo IS '-- migrate: non-destructive, just kidding';\n"
    )
    assert migrate.explicit_destructiveness(sql) is None
    assert migrate.contains_destructive(sql)


# ---------------------------------------------------------------------------
# Full lifecycle: up → down → up
# ---------------------------------------------------------------------------

def test_full_up_down_up_cycle(env, dsn, migrations_dir: pathlib.Path) -> None:
    write_pair(
        migrations_dir,
        "001",
        "alpha",
        up="CREATE TABLE alpha (id BIGINT PRIMARY KEY, name TEXT NOT NULL);",
        down="DROP TABLE alpha;",
    )
    write_pair(
        migrations_dir,
        "002",
        "beta",
        up="CREATE TABLE beta (id BIGINT PRIMARY KEY, alpha_id BIGINT REFERENCES alpha(id));",
        down="DROP TABLE beta;",
    )

    # Up
    rc = migrate.main(["--migrations-dir", str(migrations_dir), "up"])
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        tables = list_user_tables(conn)
        assert "alpha" in tables
        assert "beta" in tables
        assert "schema_migrations" in tables

    # Re-running up is a no-op
    rc = migrate.main(["--migrations-dir", str(migrations_dir), "up"])
    assert rc == 0

    # Down twice
    rc = migrate.main(
        ["--migrations-dir", str(migrations_dir), "--allow-destructive", "down"]
    )
    assert rc == 0
    rc = migrate.main(
        ["--migrations-dir", str(migrations_dir), "--allow-destructive", "down"]
    )
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        tables = list_user_tables(conn)
        # Only the bookkeeping table should remain — alpha + beta gone.
        assert "alpha" not in tables
        assert "beta" not in tables
        assert tables == ["schema_migrations"]

    # Re-apply — should succeed again, proving down was clean.
    rc = migrate.main(["--migrations-dir", str(migrations_dir), "up"])
    assert rc == 0
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert set(list_user_tables(conn)) >= {"alpha", "beta", "schema_migrations"}


# ---------------------------------------------------------------------------
# Guard rails
# ---------------------------------------------------------------------------

def test_checksum_mismatch_after_edit(env, dsn, migrations_dir: pathlib.Path) -> None:
    write_pair(
        migrations_dir,
        "001",
        "alpha",
        up="CREATE TABLE alpha (id BIGINT PRIMARY KEY);",
        down="DROP TABLE alpha;",
    )
    assert migrate.main(["--migrations-dir", str(migrations_dir), "up"]) == 0

    # Edit the file — checksum diverges.
    (migrations_dir / "001_alpha.up.sql").write_text(
        "CREATE TABLE alpha (id BIGINT PRIMARY KEY, extra TEXT);"
    )
    rc = migrate.main(["--migrations-dir", str(migrations_dir), "up"])
    assert rc == 1  # validation failure exit code


def test_destructive_blocked_without_flag(env, dsn, migrations_dir: pathlib.Path) -> None:
    write_pair(
        migrations_dir,
        "001",
        "needs_flag",
        up="CREATE TABLE keepme (id BIGINT PRIMARY KEY); DROP TABLE keepme;",
        down="SELECT 1;",
    )
    rc = migrate.main(["--migrations-dir", str(migrations_dir), "up"])
    assert rc == 1


def test_dry_run_does_not_apply(env, dsn, migrations_dir: pathlib.Path) -> None:
    write_pair(
        migrations_dir,
        "001",
        "alpha",
        up="CREATE TABLE alpha (id BIGINT PRIMARY KEY);",
        down="DROP TABLE alpha;",
    )
    rc = migrate.main(["--migrations-dir", str(migrations_dir), "--dry-run", "up"])
    assert rc == 0
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert "alpha" not in list_user_tables(conn)


def test_dry_run_evaluates_destructive_gate(
    env, dsn, migrations_dir: pathlib.Path
) -> None:
    """The deploy scripts use `--dry-run up` as their expand/contract safety
    gate (azure-deploy-inactive.sh step 4), so the dry-run must FAIL on a
    pending destructive migration — not defer the DestructiveBlocked to the
    apply step (ADR-010 amendment, 2026-07-10; S-1 in
    REVIEW_phase2g1_integration)."""
    write_pair(
        migrations_dir,
        "001",
        "destructive_plan",
        up="CREATE TABLE doomed (id BIGINT PRIMARY KEY); DROP TABLE doomed;",
        down="SELECT 1;",
    )
    # Without the flag: the dry-run itself is blocked (validation exit code),
    # and nothing is applied.
    rc = migrate.main(["--migrations-dir", str(migrations_dir), "--dry-run", "up"])
    assert rc == 1
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert "doomed" not in list_user_tables(conn)

    # With the flag: the dry-run plans cleanly and still applies nothing.
    rc = migrate.main(
        ["--migrations-dir", str(migrations_dir), "--allow-destructive", "--dry-run", "up"]
    )
    assert rc == 0
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert "doomed" not in list_user_tables(conn)


def test_dry_run_down_evaluates_destructive_gate(
    env, dsn, migrations_dir: pathlib.Path
) -> None:
    """Symmetry: a `--dry-run down` whose down body is destructive is blocked
    without the flag, and plans (without executing) with it."""
    write_pair(
        migrations_dir,
        "001",
        "alpha",
        up="CREATE TABLE alpha (id BIGINT PRIMARY KEY);",
        down="DROP TABLE alpha;",
    )
    assert migrate.main(["--migrations-dir", str(migrations_dir), "up"]) == 0

    rc = migrate.main(["--migrations-dir", str(migrations_dir), "--dry-run", "down"])
    assert rc == 1

    rc = migrate.main(
        ["--migrations-dir", str(migrations_dir), "--allow-destructive", "--dry-run", "down"]
    )
    assert rc == 0
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert "alpha" in list_user_tables(conn), "dry-run down must not execute"


def test_failed_migration_rolls_back(env, dsn, migrations_dir: pathlib.Path) -> None:
    """If a migration errors mid-statement, the whole migration is rolled back."""
    write_pair(
        migrations_dir,
        "001",
        "doomed",
        up=(
            "CREATE TABLE survivor (id BIGINT PRIMARY KEY);\n"
            "CREATE TABLE survivor (id BIGINT PRIMARY KEY);"  # duplicate — fails
        ),
        down="DROP TABLE IF EXISTS survivor;",
    )
    rc = migrate.main(["--migrations-dir", str(migrations_dir), "up"])
    assert rc != 0
    with psycopg.connect(dsn, autocommit=True) as conn:
        # The partial table from the first statement must be gone.
        assert "survivor" not in list_user_tables(conn)


# ---------------------------------------------------------------------------
# Atomicity (ADR-013): body + bookkeeping commit or abort together
# ---------------------------------------------------------------------------

def test_atomicity_body_and_bookkeeping_commit_together(
    env, dsn, migrations_dir: pathlib.Path
) -> None:
    """The schema change and the schema_migrations INSERT must commit (or
    abort) in the SAME transaction.

    Fault injection: pre-insert a schema_migrations row with the same
    version that the about-to-run migration will use, then call
    apply_one() DIRECTLY (bypassing cmd_migrate's "already applied,
    skip" path). The body's CREATE TABLE will succeed, but the
    bookkeeping INSERT will fail with PK conflict — the whole tx must
    roll back, leaving NO schema change. This is the exact scenario
    REVIEW_A3 BLOCKER-1 described.
    """
    write_pair(
        migrations_dir,
        "001",
        "atomic_check",
        up="CREATE TABLE atomicity_witness (id BIGINT PRIMARY KEY);",
        down="DROP TABLE IF EXISTS atomicity_witness;",
    )

    # Provision the bookkeeping table and pre-insert the row that will
    # cause apply_one's INSERT to fail with PK conflict.
    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute(migrate.SCHEMA_MIGRATIONS_DDL)
        cur.execute(
            """
            INSERT INTO schema_migrations (version, name, checksum, applied_by, duration_ms)
            VALUES ('001', 'pre-existing', 'deadbeef', 'fault-injection', 0)
            """
        )

    # Discover the migration and apply it directly. apply_one must raise
    # because the bookkeeping INSERT will conflict with the pre-inserted
    # row; the body's DDL must NOT survive that failure.
    migrations = migrate.discover_migrations(migrations_dir)
    assert len(migrations) == 1
    conn = migrate.connect_from_env()
    try:
        with pytest.raises(psycopg.Error):
            migrate.apply_one(conn, migrations[0], allow_destructive=False)
    finally:
        conn.close()

    with psycopg.connect(dsn, autocommit=True) as conn:
        tables = list_user_tables(conn)
        # The schema change must NOT have survived the failed bookkeeping write.
        assert "atomicity_witness" not in tables, (
            "ADR-013 violated: schema change committed without bookkeeping row"
        )
        # And the original (pre-existing) bookkeeping row is still there.
        with conn.cursor() as cur:
            cur.execute(
                "SELECT name FROM schema_migrations WHERE version = '001'"
            )
            row = cur.fetchone()
            assert row is not None
            assert row[0] == "pre-existing"


# ---------------------------------------------------------------------------
# Transaction-control rejection (ADR-013)
# ---------------------------------------------------------------------------

def test_discover_rejects_top_level_begin(migrations_dir: pathlib.Path) -> None:
    write_pair(
        migrations_dir,
        "001",
        "bad_begin",
        up="BEGIN;\nCREATE TABLE x (id BIGINT PRIMARY KEY);\nCOMMIT;",
        down="DROP TABLE x;",
    )
    with pytest.raises(migrate.TxControlInMigration):
        migrate.discover_migrations(migrations_dir)


def test_discover_rejects_top_level_commit(migrations_dir: pathlib.Path) -> None:
    write_pair(
        migrations_dir,
        "001",
        "bad_commit",
        up="CREATE TABLE x (id BIGINT PRIMARY KEY);\nCOMMIT;",
        down="DROP TABLE x;",
    )
    with pytest.raises(migrate.TxControlInMigration):
        migrate.discover_migrations(migrations_dir)


def test_discover_rejects_top_level_savepoint(migrations_dir: pathlib.Path) -> None:
    write_pair(
        migrations_dir,
        "001",
        "bad_savepoint",
        up="SAVEPOINT sp;\nCREATE TABLE x (id BIGINT PRIMARY KEY);\nRELEASE SAVEPOINT sp;",
        down="DROP TABLE x;",
    )
    with pytest.raises(migrate.TxControlInMigration):
        migrate.discover_migrations(migrations_dir)


def test_discover_accepts_pl_pgsql_begin_end(migrations_dir: pathlib.Path) -> None:
    """`BEGIN` / `END` inside a `DO $$ … $$` block are PL/pgSQL keywords,
    not SQL transaction control. The detector must strip dollar-quoted
    strings before matching so these don't trip it."""
    write_pair(
        migrations_dir,
        "001",
        "plpgsql_ok",
        up=(
            "DO $$\n"
            "BEGIN\n"
            "    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'demo_e') THEN\n"
            "        CREATE TYPE demo_e AS ENUM ('a', 'b');\n"
            "    END IF;\n"
            "END $$;"
        ),
        down="DROP TYPE IF EXISTS demo_e;",
    )
    # Must not raise.
    migrate.discover_migrations(migrations_dir)


def test_discover_accepts_comment_begin(migrations_dir: pathlib.Path) -> None:
    """A comment mentioning `BEGIN` (e.g. documentary "legacy BEGIN; was
    removed") must not trip the detector."""
    write_pair(
        migrations_dir,
        "001",
        "comment_begin_ok",
        up=(
            "-- The previous version of this file had BEGIN; here. ADR-013\n"
            "-- removed it.\n"
            "CREATE TABLE comment_demo (id BIGINT PRIMARY KEY);"
        ),
        down="DROP TABLE IF EXISTS comment_demo;",
    )
    migrate.discover_migrations(migrations_dir)


def test_discover_accepts_tx_word_in_string_literal(migrations_dir: pathlib.Path) -> None:
    """A transaction-control keyword appearing only as prose inside a single-
    quoted string literal — e.g. a `COMMENT ON ... IS '... after the DB commit
    ...'` — must not trip the detector. Regression for migration 041, whose
    COMMENT string contained the bare word "commit,"; the runner's noise
    stripper now strips single-quoted literals before matching."""
    write_pair(
        migrations_dir,
        "001",
        "tx_word_in_string_ok",
        up=(
            "CREATE TABLE tx_string_demo (id BIGINT PRIMARY KEY);\n"
            "COMMENT ON TABLE tx_string_demo IS\n"
            "    'Rows are cleaned up after the DB commit, since file deletion '\n"
            "    'is not transactional; a rollback would otherwise orphan them. '\n"
            "    'Levels: beginner, intermediate.';"
        ),
        down="DROP TABLE IF EXISTS tx_string_demo;",
    )
    # Must not raise.
    migrate.discover_migrations(migrations_dir)


def test_discover_still_rejects_real_commit_despite_string_literal(
    migrations_dir: pathlib.Path,
) -> None:
    """Stripping string literals must NOT create a false negative: a genuine
    top-level COMMIT is still rejected even when a string literal elsewhere in
    the file also contains the word "commit"."""
    write_pair(
        migrations_dir,
        "001",
        "real_commit_still_bad",
        up=(
            "CREATE TABLE tx_fn_demo (id BIGINT PRIMARY KEY);\n"
            "COMMENT ON TABLE tx_fn_demo IS 'written on each commit, by design';\n"
            "COMMIT;"
        ),
        down="DROP TABLE IF EXISTS tx_fn_demo;",
    )
    with pytest.raises(migrate.TxControlInMigration):
        migrate.discover_migrations(migrations_dir)


# ---------------------------------------------------------------------------
# Connection settings (SF1)
# ---------------------------------------------------------------------------

def test_migration_session_disables_timeouts(env, dsn) -> None:
    """Connect via connect_from_env and verify statement_timeout +
    idle_in_transaction_session_timeout are both 0 on the session.
    SF1 in REVIEW_A3."""
    conn = migrate.connect_from_env()
    try:
        with conn.cursor() as cur:
            cur.execute("SHOW statement_timeout")
            assert cur.fetchone()[0] == "0"
            cur.execute("SHOW idle_in_transaction_session_timeout")
            assert cur.fetchone()[0] == "0"
    finally:
        conn.close()


def test_connect_fails_clearly_with_no_dsn(monkeypatch) -> None:
    """N2 (REVIEW_A3): missing DATABASE_URL and missing PG* env raises a
    clear MigrationError, not a libpq stack trace."""
    for var in ("DATABASE_URL", "PGHOST", "PGUSER", "PGDATABASE", "PGPASSWORD", "PGPORT"):
        monkeypatch.delenv(var, raising=False)
    with pytest.raises(migrate.MigrationError, match="DATABASE_URL"):
        migrate.connect_from_env()
