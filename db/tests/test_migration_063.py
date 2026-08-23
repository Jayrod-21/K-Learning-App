"""Migration 063 (notification_deliveries claim key, ticket F-092) —
real-chain tests.

WHY THIS FILE EXISTS:
    063 adds `notification_deliveries.window_start` (NOT NULL, no default)
    and `UNIQUE (schedule_id, window_start)` — the real idempotency claim key
    a future sender's `INSERT ... ON CONFLICT DO NOTHING` arbiters on
    (server/src/services/notificationDelivery.ts owns the application-level
    claim/settle logic and its own concurrency test; this file proves the
    DATABASE-level contract those primitives depend on: the column shape, the
    UNIQUE constraint actually rejecting a duplicate (schedule_id,
    window_start) pair, and the F-088 marker classification on both SQL
    files).

SCOPE:
    - up: window_start is NOT NULL; a duplicate (schedule_id, window_start)
      INSERT is rejected by the UNIQUE constraint; a different window_start
      for the same schedule inserts fine; the up file classifies as
      non-destructive via the F-088 marker.
    - down: DROP COLUMN removes window_start (and the constraint with it);
      the down file classifies as destructive via the F-088 marker (the
      mass-DROP-COLUMN shape the legacy sniff would NOT have caught); a clean
      re-up afterward.

DETERMINISM:
    Mirrors test_migration_062.py / test_migration_052.py — real migration
    files copied into a tmp_path-scoped dir, runner pointed at it via
    --migrations-dir, fresh schema per test.
"""

from __future__ import annotations

import pathlib
import shutil
from typing import Iterable

import psycopg
import pytest
from psycopg import errors
from psycopg.rows import tuple_row

from db import migrate  # type: ignore[import-not-found]
from db.tests._helpers import _seed_user  # type: ignore[import-not-found]

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


# The migration immediately before 063 — the down-target that rolls back
# exactly 063 and nothing else.
PRE_063 = "052"


def _copy_real_migrations(dest: pathlib.Path, versions: Iterable[str]) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    wanted = set(versions)
    copied: set[str] = set()
    for src in REAL_MIGRATIONS_DIR.iterdir():
        if src.suffix != ".sql" or not src.is_file():
            continue
        version_prefix = src.name.split("_", 1)[0]
        if version_prefix in wanted:
            shutil.copy2(src, dest / src.name)
            copied.add(version_prefix)
    missing = wanted - copied
    if missing:
        raise FileNotFoundError(
            f"expected real migration files for versions {sorted(missing)} "
            f"under {REAL_MIGRATIONS_DIR}, found none"
        )


@pytest.fixture()
def claim_key_dir(tmp_path: pathlib.Path) -> pathlib.Path:
    """001 (users) + 052 (notification_schedules/deliveries) + 063 (claim key)."""
    d = tmp_path / "migrations_claim_key"
    _copy_real_migrations(d, versions={"001", "052", "063"})
    return d


def _seed_schedule(conn: psycopg.Connection, user_id: int) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO notification_schedules
                    (user_id, kind, channel, time_of_day, tz, enabled)
            VALUES (%s, 'daily_reminder', 'email', '08:00', 'Asia/Seoul', true)
            RETURNING id
            """,
            (user_id,),
        )
        return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# 1. F-088 marker: 063's up is non-destructive, down is destructive.
# ---------------------------------------------------------------------------

def test_063_marker_classification() -> None:
    up_sql = (
        REAL_MIGRATIONS_DIR / "063_notification_deliveries_claim_key.up.sql"
    ).read_text(encoding="utf-8")
    down_sql = (
        REAL_MIGRATIONS_DIR / "063_notification_deliveries_claim_key.down.sql"
    ).read_text(encoding="utf-8")
    assert migrate.explicit_destructiveness(up_sql) is False
    assert not migrate.contains_destructive(up_sql)
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


def test_063_up_applies_without_allow_destructive(
    env, dsn: str, claim_key_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(claim_key_dir), "up"])
    assert rc == 0, "063 up must not require --allow-destructive (F-088 marker)"


# ---------------------------------------------------------------------------
# 2. Schema shape: NOT NULL + the UNIQUE claim key actually rejects a
#    duplicate (schedule_id, window_start) pair.
# ---------------------------------------------------------------------------

def test_063_window_start_not_null(env, dsn: str, claim_key_dir: pathlib.Path) -> None:
    rc = migrate.main(["--migrations-dir", str(claim_key_dir), "up"])
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f092-notnull@example.com")
        schedule_id = _seed_schedule(conn, user_id)

        with conn.cursor() as cur:
            with pytest.raises(errors.NotNullViolation):
                cur.execute(
                    "INSERT INTO notification_deliveries (schedule_id, status) "
                    "VALUES (%s, 'pending')",
                    (schedule_id,),
                )


def test_063_unique_claim_key_rejects_duplicate_firing(
    env, dsn: str, claim_key_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(claim_key_dir), "up"])
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f092-unique@example.com")
        schedule_id = _seed_schedule(conn, user_id)

        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO notification_deliveries (schedule_id, status, window_start)
                VALUES (%s, 'pending', '2026-07-15 08:00:00+00')
                """,
                (schedule_id,),
            )

        # Same (schedule_id, window_start) — the claim key must reject it.
        with conn.cursor() as cur:
            with pytest.raises(errors.UniqueViolation):
                cur.execute(
                    """
                    INSERT INTO notification_deliveries (schedule_id, status, window_start)
                    VALUES (%s, 'pending', '2026-07-15 08:00:00+00')
                    """,
                    (schedule_id,),
                )
        conn.rollback()

        # A DIFFERENT window_start for the same schedule is a distinct claim.
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO notification_deliveries (schedule_id, status, window_start)
                VALUES (%s, 'pending', '2026-07-16 08:00:00+00')
                """,
                (schedule_id,),
            )

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT count(*) FROM notification_deliveries WHERE schedule_id = %s",
                (schedule_id,),
            )
            assert cur.fetchone()[0] == 2


# ---------------------------------------------------------------------------
# 3. DOWN — DROP COLUMN removes window_start (+ the constraint), requires
#    --allow-destructive (F-088 marker); the delivery ROW itself survives
#    (only the column is dropped).
# ---------------------------------------------------------------------------

def test_063_down_requires_allow_destructive_then_drops_column(
    env, dsn: str, claim_key_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(claim_key_dir), "up"])
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f092-down@example.com")
        schedule_id = _seed_schedule(conn, user_id)
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO notification_deliveries (schedule_id, status, window_start)
                VALUES (%s, 'pending', '2026-07-15 08:00:00+00')
                """,
                (schedule_id,),
            )

    # The gate must refuse without the flag (F-088 marker declares 063.down
    # destructive even though it has no DROP TABLE/TRUNCATE for the legacy
    # sniff to catch).
    rc = migrate.main(
        ["--migrations-dir", str(claim_key_dir), "--target", PRE_063, "down"]
    )
    assert rc != 0, "063.down is marked destructive — the gate must refuse it"

    rc = migrate.main(
        [
            "--migrations-dir",
            str(claim_key_dir),
            "--target",
            PRE_063,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_063} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor(
        row_factory=tuple_row
    ) as cur:
        cur.execute(
            """
            SELECT 1 FROM information_schema.columns
             WHERE table_name = 'notification_deliveries' AND column_name = 'window_start'
            """
        )
        assert cur.fetchone() is None, "window_start must be gone after 063 down"
        # The delivery row survives (only the column is dropped).
        cur.execute("SELECT count(*) FROM notification_deliveries")
        assert cur.fetchone()[0] == 1


def test_063_re_up_is_clean_on_an_empty_table(
    env, dsn: str, claim_key_dir: pathlib.Path
) -> None:
    """Re-up must apply cleanly when the table is EMPTY (the real-world
    assumption per 063's header: no sender exists yet, so the table is
    empty in every real environment). Note: `ADD COLUMN ... NOT NULL` with
    no DEFAULT would fail on a table that ALREADY holds a row without
    window_start (Postgres can't backfill a NOT NULL value from nothing) —
    that scenario is deliberately not exercised here; see 063's up-file
    header for why the empty-table assumption is safe today."""
    rc = migrate.main(["--migrations-dir", str(claim_key_dir), "up"])
    assert rc == 0

    rc = migrate.main(
        [
            "--migrations-dir",
            str(claim_key_dir),
            "--target",
            PRE_063,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0

    rc = migrate.main(["--migrations-dir", str(claim_key_dir), "up"])
    assert rc == 0, "063 must re-apply cleanly over an empty notification_deliveries"

    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor(
        row_factory=tuple_row
    ) as cur:
        cur.execute(
            """
            SELECT 1 FROM information_schema.columns
             WHERE table_name = 'notification_deliveries' AND column_name = 'window_start'
            """
        )
        assert cur.fetchone() is not None
