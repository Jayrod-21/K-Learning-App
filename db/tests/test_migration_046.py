"""Migration 046 (topik_attempts history model, ticket A1) — real-data tests.

WHY THIS FILE EXISTS:
    046 is the first migration in this repo that MIGRATES DATA, not just
    schema: rows whose `picks` JSONB carries the F-UP-014 '__closed__'
    tombstone must become status='completed' with the key STRIPPED, live
    rows must stay status='active', and the one-row-ever unique on user_id
    must become a partial unique on the active row only. The synthetic
    harness tests (test_migrations.py) and the foundation round-trips
    (test_migrations_real.py, 001+002 only) cannot catch a bug in that
    transform. These tests apply the REAL migration chain against a real
    Postgres-16 testcontainer via `migrate.main()`, seed pre-046 rows in
    the pre-046 shape, and assert the transform — and its best-effort
    reverse — on actual data.

SCOPE:
    - up: tombstone → completed + key stripped (updated_at preserved);
      live row → active; index swap; topik_responses.attempt_id + FK
      (ON DELETE SET NULL — asserted from pg_constraint, not prose).
    - down: history collapses to one row per user (active outranks
      closed, then recency); the surviving closed row is re-encoded as
      the pre-046 tombstone; schema restored (uq_topik_attempts_user
      back, status/attempt_id gone); re-up is clean.
    The 0-row case is exercised implicitly: the full `up` in the down
    test applies 046 to an empty topik_attempts first.

DETERMINISM:
    Mirrors test_migrations_real.py — the real migration files are copied
    into a tmp_path-scoped directory and the runner is pointed at it via
    `--migrations-dir`; the `dsn` fixture gives each test a fresh schema.
"""

from __future__ import annotations

import json
import pathlib
import shutil

import psycopg
import pytest
from psycopg.rows import dict_row, tuple_row

from db import migrate  # type: ignore[import-not-found]

try:
    from testcontainers.postgres import PostgresContainer  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    PostgresContainer = None  # type: ignore[assignment]


pytestmark = pytest.mark.skipif(
    PostgresContainer is None,
    reason="testcontainers not installed — `pip install testcontainers[postgres]`",
)

REAL_MIGRATIONS_DIR: pathlib.Path = (
    pathlib.Path(__file__).resolve().parents[1] / "migrations"
)

# The seed target: `up --target PRE_046` builds the schema the data-transform
# assertions seed against. 044 is the last migration before 045 — stopping
# there (rather than at 045) is deliberate: 045 (hygiene_cleanup) contains
# DROP TABLE, so including it would force --allow-destructive onto the
# seed-stage up, and 045 touches neither topik_attempts nor topik_responses,
# so for everything 046 transforms the 044 schema IS the pre-046 shape.
# (The full-chain applies below DO traverse 045 and pass the flag.)
PRE_046 = "044"

# A syntactically valid argon2id-shaped hash satisfying
# ck_users_password_hash_argon2id (LIKE '$argon2id$%', length 80..255).
FAKE_HASH = "$argon2id$" + "x" * 70


# ---------------------------------------------------------------------------
# Fixtures — one container per session, a fresh DB + full migration dir per test
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def pg_container():
    with PostgresContainer("postgres:16-alpine") as pg:
        yield pg


@pytest.fixture()
def dsn(pg_container) -> str:
    raw = pg_container.get_connection_url()
    raw = raw.replace("postgresql+psycopg2://", "postgres://")
    raw = raw.replace("postgresql://", "postgres://")
    with psycopg.connect(raw, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute("DROP SCHEMA public CASCADE")
        cur.execute("CREATE SCHEMA public")
    return raw


@pytest.fixture()
def env(monkeypatch, dsn) -> None:
    monkeypatch.setenv("DATABASE_URL", dsn)


@pytest.fixture()
def full_dir(tmp_path: pathlib.Path) -> pathlib.Path:
    """A tmp directory containing EVERY production migration file."""
    d = tmp_path / "migrations_full"
    d.mkdir(parents=True)
    copied = 0
    for src in REAL_MIGRATIONS_DIR.iterdir():
        if src.suffix == ".sql" and src.is_file():
            shutil.copy2(src, d / src.name)
            copied += 1
    assert copied > 0, f"no migration files found under {REAL_MIGRATIONS_DIR}"
    return d


# ---------------------------------------------------------------------------
# Seed helpers — pre/post-046 rows in raw SQL (no app layer involved)
# ---------------------------------------------------------------------------

def _seed_user(conn: psycopg.Connection, email: str) -> int:
    # tuple_row pinned: helpers must work on dict_row connections too.
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id",
            (email, FAKE_HASH),
        )
        return cur.fetchone()[0]


def _seed_attempt(
    conn: psycopg.Connection,
    user_id: int,
    source_test: int,
    picks: dict,
    status: str | None = None,
) -> int:
    """Insert a topik_attempts row. `status=None` targets the pre-046 shape
    (no status column); a value targets the post-046 shape."""
    cols = "user_id, section, source_test, current_idx, picks, remaining_ms"
    vals = "%s, 'reading'::topik_section, %s, 0, %s::jsonb, 1000"
    params: list = [user_id, source_test, json.dumps(picks)]
    if status is not None:
        cols += ", status"
        vals += ", %s"
        params.append(status)
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            f"INSERT INTO topik_attempts ({cols}) VALUES ({vals}) RETURNING id",
            params,
        )
        return cur.fetchone()[0]


def _index_names(conn: psycopg.Connection, table: str) -> set[str]:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=%s",
            (table,),
        )
        return {r[0] for r in cur.fetchall()}


def _has_column(conn: psycopg.Connection, table: str, column: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name=%s AND column_name=%s
            """,
            (table, column),
        )
        return cur.fetchone() is not None


# ---------------------------------------------------------------------------
# 1. UP — the data transform on real pre-046 rows
# ---------------------------------------------------------------------------

def test_046_up_migrates_tombstone_and_live_rows(env, dsn: str, full_dir) -> None:
    """Seed the two real pre-046 row shapes (a submitted-attempt tombstone and
    a live in-progress attempt), apply 046, and assert the transform:
    tombstone → status='completed' with the '__closed__' key stripped and
    updated_at PRESERVED; live → status='active', payload untouched. Also
    asserts the index swap and the topik_responses grouping column + FK."""
    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", PRE_046, "up"])
    assert rc == 0, f"up --target {PRE_046} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        # Sanity: the pre-046 shape is what 037 shipped.
        assert not _has_column(conn, "topik_attempts", "status")
        assert "uq_topik_attempts_user" in _index_names(conn, "topik_attempts")

        user_closed = _seed_user(conn, "a1-closed@example.com")
        user_live = _seed_user(conn, "a1-live@example.com")
        # The tombstone /mock/submit wrote was exactly {"__closed__": true};
        # an extra pick key is included to prove the strip is SURGICAL (only
        # the tombstone key goes), per the ticket's "STRIP the tombstone key".
        _seed_attempt(conn, user_closed, 91, {"__closed__": True, "123": "a"})
        _seed_attempt(conn, user_live, 92, {"55": "c"})
        with conn.cursor() as cur:
            cur.execute(
                "SELECT updated_at FROM topik_attempts WHERE user_id = %s",
                (user_closed,),
            )
            closed_updated_at_before = cur.fetchone()[0]

    # --allow-destructive: migration 045 (hygiene_cleanup, DROP TABLE) sits in
    # the chain ahead of 046, so a full `up` traverses it and trips migrate.py's
    # destructive gate without the flag.
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--allow-destructive", "up"]
    )
    assert rc == 0, f"up (through 046) returned {rc}"

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT user_id, status, picks, updated_at
                  FROM topik_attempts ORDER BY user_id
                """
            )
            rows = {r["user_id"]: r for r in cur.fetchall()}

        closed = rows[user_closed]
        assert closed["status"] == "completed"
        assert closed["picks"] == {"123": "a"}, (
            f"tombstone key must be stripped, other picks kept; got {closed['picks']}"
        )
        assert closed["updated_at"] == closed_updated_at_before, (
            "the data migration must preserve the submit-time updated_at "
            "(trigger disabled around the UPDATE)"
        )
        live = rows[user_live]
        assert live["status"] == "active"
        assert live["picks"] == {"55": "c"}

        # Index swap: one-row-EVER unique replaced by one-ACTIVE-row partial.
        names = _index_names(conn, "topik_attempts")
        assert "uq_topik_attempts_user" not in names
        assert "uq_topik_attempts_user_active" in names
        with conn.cursor() as cur:
            cur.execute(
                "SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_topik_attempts_user_active'"
            )
            indexdef = cur.fetchone()["indexdef"]
        assert "UNIQUE" in indexdef and "status = 'active'" in indexdef.replace(
            "::text", ""
        ), f"expected a partial UNIQUE on status='active'; got: {indexdef}"

        # Response grouping: nullable attempt_id + FK with ON DELETE SET NULL
        # (confdeltype 'n') / ON UPDATE RESTRICT (confupdtype 'r').
        assert _has_column(conn, "topik_responses", "attempt_id")
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT confdeltype, confupdtype FROM pg_constraint
                 WHERE conname = 'fk_topik_responses_attempt'
                """
            )
            fk = cur.fetchone()
        assert fk is not None, "fk_topik_responses_attempt missing"
        assert fk["confdeltype"] == "n", "attempt_id FK must be ON DELETE SET NULL"
        assert fk["confupdtype"] == "r", "attempt_id FK must be ON UPDATE RESTRICT"
        assert "ix_topik_responses_attempt" in _index_names(conn, "topik_responses")


# ---------------------------------------------------------------------------
# 2. DOWN — best-effort reverse: collapse history, re-encode the tombstone,
#    restore the 037 schema; then a clean re-up
# ---------------------------------------------------------------------------

def test_046_down_collapses_history_and_reencodes_then_reups(
    env, dsn: str, full_dir
) -> None:
    """With post-046 history rows in place (N per user), rolling back 046
    must collapse to the pre-046 single slot — the ACTIVE row wins when
    present, else the newest closed row re-encoded as the F-UP-014
    tombstone — and restore the 037 schema exactly. A subsequent `up`
    must apply 046 cleanly again."""
    # Full up applies 046 against EMPTY topik_attempts — the 0-row case.
    # --allow-destructive: migration 045 (hygiene_cleanup, DROP TABLE) sits in
    # the chain ahead of 046, so a full `up` traverses it and trips migrate.py's
    # destructive gate without the flag.
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--allow-destructive", "up"]
    )
    assert rc == 0, f"initial full up returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        # User C: history (completed + abandoned) alongside an active attempt.
        user_c = _seed_user(conn, "a1-history@example.com")
        _seed_attempt(conn, user_c, 10, {"1": "a"}, status="completed")
        _seed_attempt(conn, user_c, 11, {"2": "b"}, status="abandoned")
        _seed_attempt(conn, user_c, 12, {"3": "c"}, status="active")
        # User D: closed history only (no in-progress attempt).
        user_d = _seed_user(conn, "a1-closed-only@example.com")
        _seed_attempt(conn, user_d, 20, {"4": "d"}, status="completed")

    # --allow-destructive on the down is not strictly required by the gate
    # today: 047/046/045's down bodies contain no DESTRUCTIVE_PATTERNS token —
    # 046.down's data loss is via DELETE + DROP COLUMN, which the gate does not
    # match (see the warning in 046.down's header). The flag is passed anyway
    # to match the documented rollback procedure (Deploy/README.md §"Shipping
    # Phase-2 Group 1"), which treats every 046 rollback as deliberate loss of
    # attempt history.
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_046, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {PRE_046} returned {rc}"

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        # Schema restored to the 037 shape.
        assert not _has_column(conn, "topik_attempts", "status")
        assert not _has_column(conn, "topik_responses", "attempt_id")
        names = _index_names(conn, "topik_attempts")
        assert "uq_topik_attempts_user" in names
        assert "uq_topik_attempts_user_active" not in names

        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT user_id, source_test, current_idx, picks, remaining_ms
                  FROM topik_attempts ORDER BY user_id
                """
            )
            rows = {r["user_id"]: r for r in cur.fetchall()}
        assert set(rows) == {user_c, user_d}, "down must leave ONE row per user"

        # C's survivor is the ACTIVE attempt (resumable beats history) —
        # round-tripped losslessly.
        c = rows[user_c]
        assert c["source_test"] == 12
        assert c["picks"] == {"3": "c"}

        # D's survivor is the closed row, re-encoded exactly as the pre-046
        # /mock/submit tombstone.
        d = rows[user_d]
        assert d["source_test"] == 20
        assert d["picks"] == {"__closed__": True}
        assert d["current_idx"] == 0
        assert d["remaining_ms"] == 0

    # Re-up: 046 applies cleanly on the collapsed state and re-derives status.
    # --allow-destructive: migration 045 (hygiene_cleanup, DROP TABLE) sits in
    # the chain ahead of 046, so a full `up` traverses it and trips migrate.py's
    # destructive gate without the flag.
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--allow-destructive", "up"]
    )
    assert rc == 0, f"re-apply of 046 after rollback returned {rc}"

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT user_id, status, picks FROM topik_attempts")
            rows = {r["user_id"]: r for r in cur.fetchall()}
        assert rows[user_c]["status"] == "active"
        assert rows[user_d]["status"] == "completed"
        assert rows[user_d]["picks"] == {}, (
            "re-applying 046 must strip the re-encoded tombstone key again"
        )
