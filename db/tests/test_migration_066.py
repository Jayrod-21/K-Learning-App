"""Migration 066 (topik_attempts.topik_level, ticket F-122) — real-chain
tests.

WHY THIS FILE EXISTS:
    066 adds a nullable `topik_level` column (CHECK-constrained to the same
    'TOPIK I'/'TOPIK II' set as `topik_tests.topik_level`) to `topik_attempts`
    so an attempt row can record the EXACT paper it was served from / graded
    against, instead of the pre-existing best-effort tie-break guess the
    route layer (`resolveServedTotal`) has to fall back on for rows this
    column cannot know (server/src/routes/topik.ts owns that application-
    level fallback logic and its own test coverage; this file proves the
    DATABASE-level contract those routes depend on: the column shape, the
    CHECK constraint actually rejecting a bogus level, NULL still being a
    valid/expected value for pre-066 rows, and the F-088 marker
    classification on both SQL files).

SCOPE:
    - up: topik_level is nullable TEXT; the CHECK constraint accepts NULL,
      'TOPIK I', and 'TOPIK II', and rejects any other value; the up file
      classifies as non-destructive via the F-088 marker.
    - down: DROP COLUMN removes topik_level (and the constraint with it);
      the down file classifies as destructive via the F-088 marker (the
      mass-DROP-COLUMN shape the legacy sniff would NOT have caught, same
      shape as 063's own down); existing rows survive (only the column is
      dropped); re-up is clean even with existing rows present (unlike 063,
      this column is NULLable with no NOT NULL to trip on a populated
      table — re-up must succeed regardless of row count).

DETERMINISM:
    Mirrors test_migration_063.py — real migration files copied into a
    tmp_path-scoped dir, runner pointed at it via --migrations-dir, fresh
    schema per test.
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


# The migration immediately before 066 in THIS worktree's chain — the
# down-target that rolls back exactly 066 and nothing else. (065 is reserved
# by a concurrent batch and is not present here; 037 is topik_attempts'
# own creating migration, so 037 is the schema this column layers onto.)
PRE_066 = "037"


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
def topik_level_dir(tmp_path: pathlib.Path) -> pathlib.Path:
    """001 (users, topik_section enum, set_updated_at()) + 037 (topik_attempts)
    + 066 (topik_level). No FK from topik_attempts to topik_tests/topik_items
    exists, so neither corpus table is needed for this column's own tests."""
    d = tmp_path / "migrations_topik_level"
    _copy_real_migrations(d, versions={"001", "037", "066"})
    return d


def _seed_attempt(
    conn: psycopg.Connection, user_id: int, source_test: int, topik_level
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO topik_attempts
                    (user_id, section, source_test, current_idx, picks,
                     remaining_ms, topik_level)
            VALUES (%s, 'reading', %s, 0, '{}'::jsonb, 1000, %s)
            RETURNING id
            """,
            (user_id, source_test, topik_level),
        )
        return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# 1. F-088 marker: 066's up is non-destructive, down is destructive.
# ---------------------------------------------------------------------------

def test_066_marker_classification() -> None:
    up_sql = (REAL_MIGRATIONS_DIR / "066_topik_attempts_level.up.sql").read_text(
        encoding="utf-8"
    )
    down_sql = (REAL_MIGRATIONS_DIR / "066_topik_attempts_level.down.sql").read_text(
        encoding="utf-8"
    )
    assert migrate.explicit_destructiveness(up_sql) is False
    assert not migrate.contains_destructive(up_sql)
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


def test_066_up_applies_without_allow_destructive(
    env, dsn: str, topik_level_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(topik_level_dir), "up"])
    assert rc == 0, "066 up must not require --allow-destructive (F-088 marker)"


# ---------------------------------------------------------------------------
# 2. Schema shape: nullable column + CHECK constraint accepts NULL/'TOPIK I'/
#    'TOPIK II' and rejects anything else.
# ---------------------------------------------------------------------------

def test_066_topik_level_accepts_null_and_both_real_levels(
    env, dsn: str, topik_level_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(topik_level_dir), "up"])
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f122-accepts@example.com")
        # NULL — the pre-066 / topikLevel-less-save shape.
        id_null = _seed_attempt(conn, user_id, 1001, None)
        # A real value for each level. A SEPARATE user: this minimal migration
        # set (001+037+066) predates 046's partial-unique swap, so 037's own
        # uq_topik_attempts_user (one row EVER per user) is still in force —
        # a second row for the SAME user would violate it, which is a 037
        # concern, not something this column's own tests need to touch.
        user_id_2 = _seed_user(conn, "f122-accepts-2@example.com")
        id_i = _seed_attempt(conn, user_id_2, 1002, "TOPIK I")
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT id, topik_level FROM topik_attempts WHERE id IN (%s, %s) ORDER BY id",
                (id_null, id_i),
            )
            rows = {r[0]: r[1] for r in cur.fetchall()}
            assert rows[id_null] is None
            assert rows[id_i] == "TOPIK I"


def test_066_topik_level_check_rejects_a_bogus_value(
    env, dsn: str, topik_level_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(topik_level_dir), "up"])
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f122-reject@example.com")
        with conn.cursor() as cur:
            with pytest.raises(errors.CheckViolation):
                cur.execute(
                    """
                    INSERT INTO topik_attempts
                            (user_id, section, source_test, current_idx, picks,
                             remaining_ms, topik_level)
                    VALUES (%s, 'reading', 1003, 0, '{}'::jsonb, 1000, 'TOPIK III')
                    """,
                    (user_id,),
                )


# ---------------------------------------------------------------------------
# 3. DOWN — DROP COLUMN removes topik_level (+ the constraint), requires
#    --allow-destructive (F-088 marker); the attempt ROW itself survives
#    (only the column is dropped); re-up is clean even with rows present.
# ---------------------------------------------------------------------------

def test_066_down_requires_allow_destructive_then_drops_column(
    env, dsn: str, topik_level_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(topik_level_dir), "up"])
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f122-down@example.com")
        _seed_attempt(conn, user_id, 1004, "TOPIK II")

    # The gate must refuse without the flag (F-088 marker declares 066.down
    # destructive even though DROP COLUMN has no DROP TABLE/TRUNCATE keyword
    # for the legacy sniff to catch — same shape as 063's own down).
    rc = migrate.main(
        ["--migrations-dir", str(topik_level_dir), "--target", PRE_066, "down"]
    )
    assert rc != 0, "066.down is marked destructive — the gate must refuse it"

    rc = migrate.main(
        [
            "--migrations-dir",
            str(topik_level_dir),
            "--target",
            PRE_066,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_066} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor(
        row_factory=tuple_row
    ) as cur:
        cur.execute(
            """
            SELECT 1 FROM information_schema.columns
             WHERE table_name = 'topik_attempts' AND column_name = 'topik_level'
            """
        )
        assert cur.fetchone() is None, "topik_level must be gone after 066 down"
        # The attempt row survives (only the column is dropped).
        cur.execute("SELECT count(*) FROM topik_attempts")
        assert cur.fetchone()[0] == 1


def test_066_re_up_is_clean_even_with_existing_rows(
    env, dsn: str, topik_level_dir: pathlib.Path
) -> None:
    """Unlike 063 (NOT NULL, empty-table-only), 066's column is NULLable —
    re-up must succeed even when topik_attempts already holds rows (every
    existing row simply backfills topik_level = NULL, the honest "unknown"
    default per the up file's own header)."""
    rc = migrate.main(["--migrations-dir", str(topik_level_dir), "up"])
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f122-reup@example.com")
        _seed_attempt(conn, user_id, 1005, "TOPIK I")

    rc = migrate.main(
        [
            "--migrations-dir",
            str(topik_level_dir),
            "--target",
            PRE_066,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0

    rc = migrate.main(["--migrations-dir", str(topik_level_dir), "up"])
    assert rc == 0, "066 must re-apply cleanly over a topik_attempts with existing rows"

    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor(
        row_factory=tuple_row
    ) as cur:
        cur.execute(
            "SELECT topik_level FROM topik_attempts WHERE source_test = 1005"
        )
        row = cur.fetchone()
        assert row is not None
        # The pre-existing row's topik_level backfills to NULL — the column
        # gained no NOT NULL/DEFAULT, so nothing invents a value for history
        # this column genuinely cannot know.
        assert row[0] is None
