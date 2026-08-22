"""Migration 089 (diagnostic_dimension_estimates, diagnostic-upgrade Phase C)
— real-chain tests.

WHY THIS FILE EXISTS:
    089 adds `diagnostic_runs.dimension_estimates JSONB NOT NULL DEFAULT
    '{}'::jsonb` with a `jsonb_typeof(...) = 'object'` CHECK — the per-run,
    per-dimension adaptive theta SERVING CACHE the per-category ladder build
    reads/writes (server/src/routes/diagnostic.ts). The tests pin exactly the
    contract the ADD COLUMN promises: every existing row backfills to '{}'
    (never NULL), a non-object JSONB value (array, scalar) is rejected by the
    CHECK, an object value round-trips including a `jsonb_set` per-key update
    (the shape the /answer handler writes), a manual re-apply of the up body
    is a no-op, and the down migration drops the column cleanly (a pure
    column drop — unlike 087/088's CHECK-narrow downs, there is no "blocked
    rollback" case here: dropping a column can never fail on live data the
    way narrowing a CHECK can).

DETERMINISM:
    Mirrors test_migration_088.py / test_migration_087.py — the real
    migration files are copied into a tmp_path-scoped directory and the
    runner is pointed at it via ``--migrations-dir``; the ``dsn`` fixture
    gives each test a fresh schema.
"""

from __future__ import annotations

import pathlib
import shutil

import psycopg
import pytest
from psycopg import errors
from psycopg.rows import tuple_row

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

# The migration immediately before 089. `down --target PRE_089` rolls back
# ONLY 089.
PRE_089 = "088"

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


def _full_up(full_dir: pathlib.Path) -> None:
    # --allow-destructive: migration 045 (hygiene_cleanup, DROP TABLE) sits in
    # the chain, so a full `up` trips migrate.py's destructive gate without it.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0, f"full up returned {rc}"


# ---------------------------------------------------------------------------
# Seed helpers
# ---------------------------------------------------------------------------

def _seed_user(conn: psycopg.Connection, email: str = "diag-089@test.local") -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id",
            (email, FAKE_HASH),
        )
        return cur.fetchone()[0]


def _seed_run(conn: psycopg.Connection, user_id: int) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO diagnostic_runs (user_id) VALUES (%s) RETURNING id",
            (user_id,),
        )
        return cur.fetchone()[0]


def _dimension_estimates_check_definition(conn: psycopg.Connection) -> str | None:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT pg_get_constraintdef(oid)
              FROM pg_constraint
             WHERE conname = 'ck_diagnostic_runs_dimension_estimates_object'
            """
        )
        row = cur.fetchone()
        return row[0] if row else None


def _column_exists(conn: psycopg.Connection, table: str, column: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT 1 FROM information_schema.columns
             WHERE table_name = %s AND column_name = %s
            """,
            (table, column),
        )
        return cur.fetchone() is not None


# ---------------------------------------------------------------------------
# 1. UP — column exists, defaults to '{}', CHECK rejects non-object values
# ---------------------------------------------------------------------------

def test_089_column_backfills_empty_object(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        run_id = _seed_run(conn, user_id)

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT dimension_estimates FROM diagnostic_runs WHERE id = %s",
                (run_id,),
            )
            row = cur.fetchone()
            assert row is not None
            assert row[0] == {}


def test_089_check_accepts_object_and_rejects_non_object(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        run_id = _seed_run(conn, user_id)

        # A real object value (theta cache shape) — accepted.
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE diagnostic_runs SET dimension_estimates = %s::jsonb WHERE id = %s",
                ('{"reading": 2.40, "listening": 1.85}', run_id),
            )

        # A JSON array — rejected.
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE diagnostic_runs SET dimension_estimates = %s::jsonb WHERE id = %s",
                    ("[]", run_id),
                )

    with psycopg.connect(dsn, autocommit=True) as conn:
        # A bare JSON scalar — also rejected.
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE diagnostic_runs SET dimension_estimates = %s::jsonb WHERE id = %s",
                    ("5", run_id),
                )


def test_089_jsonb_set_per_key_update_round_trips(env, dsn: str, full_dir) -> None:
    """Mirrors the /answer handler's write:
    jsonb_set(dimension_estimates, '{section}', to_jsonb(theta))."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        run_id = _seed_run(conn, user_id)

        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE diagnostic_runs
                   SET dimension_estimates =
                       jsonb_set(dimension_estimates, '{reading}', to_jsonb(2.40::numeric))
                 WHERE id = %s
                """,
                (run_id,),
            )
            cur.execute(
                """
                UPDATE diagnostic_runs
                   SET dimension_estimates =
                       jsonb_set(dimension_estimates, '{listening}', to_jsonb(1.85::numeric))
                 WHERE id = %s
                """,
                (run_id,),
            )

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT dimension_estimates FROM diagnostic_runs WHERE id = %s", (run_id,)
            )
            value = cur.fetchone()[0]
            assert value == {"reading": 2.40, "listening": 1.85}


def test_089_ability_estimate_untouched(env, dsn: str, full_dir) -> None:
    """089 adds a column alongside ability_estimate — it must not change that
    column's own CHECK/behavior."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        run_id = _seed_run(conn, user_id)

        with conn.cursor() as cur:
            cur.execute(
                "UPDATE diagnostic_runs SET ability_estimate = %s WHERE id = %s",
                (2.60, run_id),
            )
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT ability_estimate, dimension_estimates FROM diagnostic_runs WHERE id = %s",
                (run_id,),
            )
            row = cur.fetchone()
            assert float(row[0]) == 2.60
            assert row[1] == {}

        # ability_estimate's own range CHECK is still enforced (0..6).
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE diagnostic_runs SET ability_estimate = %s WHERE id = %s",
                    (7.00, run_id),
                )


# ---------------------------------------------------------------------------
# 2. UP — manual re-apply of the up body is a no-op
# ---------------------------------------------------------------------------

def test_089_reapply_up_body_is_noop(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    up_sql = (
        REAL_MIGRATIONS_DIR / "089_diagnostic_dimension_estimates.up.sql"
    ).read_text(encoding="utf-8")

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        run_id = _seed_run(conn, user_id)
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE diagnostic_runs SET dimension_estimates = %s::jsonb WHERE id = %s",
                ('{"vocab": 3.10}', run_id),
            )

        with conn.cursor() as cur:
            cur.execute(up_sql)

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT dimension_estimates FROM diagnostic_runs WHERE id = %s", (run_id,)
            )
            assert cur.fetchone()[0] == {"vocab": 3.10}
        assert _dimension_estimates_check_definition(conn) is not None


# ---------------------------------------------------------------------------
# 3. DOWN — drops the column cleanly, then a clean re-up
# ---------------------------------------------------------------------------

def test_089_down_drops_column_then_reups(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        run_id = _seed_run(conn, user_id)
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE diagnostic_runs SET dimension_estimates = %s::jsonb WHERE id = %s",
                ('{"reading": 2.40}', run_id),
            )

    rc = migrate.main(
        [
            "--migrations-dir",
            str(full_dir),
            "--target",
            PRE_089,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_089} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert not _column_exists(conn, "diagnostic_runs", "dimension_estimates")
        assert _dimension_estimates_check_definition(conn) is None
        # The run row itself, and its ability_estimate/other columns, survive
        # a pure column drop untouched.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT count(*) FROM diagnostic_runs WHERE id = %s", (run_id,)
            )
            assert cur.fetchone()[0] == 1

    # Re-up: 089 re-applies cleanly, the column + default + CHECK are all back.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _column_exists(conn, "diagnostic_runs", "dimension_estimates")
        assert _dimension_estimates_check_definition(conn) is not None
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT dimension_estimates FROM diagnostic_runs WHERE id = %s", (run_id,)
            )
            # Backfilled fresh on re-add — the prior JSON value was genuinely
            # dropped with the column (this is the destructive-down contract).
            assert cur.fetchone()[0] == {}


def test_089_is_the_latest_migration(full_dir) -> None:
    """Confirm 089 is next after 088 — no gap, no later migration shadows it."""
    versions = sorted(
        p.name[:3]
        for p in REAL_MIGRATIONS_DIR.iterdir()
        if p.suffix == ".sql" and p.name[:3].isdigit() and p.name.endswith(".up.sql")
    )
    assert versions[-1] == "089"
    assert "088" in versions
