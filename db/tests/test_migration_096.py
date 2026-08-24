"""Migration 096 (metered-spend cost columns, Phase 2.6 spend ceiling) —
real-chain tests.

WHY THIS FILE EXISTS:
    096 is the storage half of the global daily spend-ceiling circuit
    breaker (server/src/services/spendCeiling.ts): a nullable
    `cost_estimate_usd NUMERIC(12,6)` on `story_audio_jobs` (081) and
    `story_image_jobs` (083), mirroring `claude_usage.cost_estimate_usd`
    (004). Proven here against a real Postgres-16 testcontainer via
    ``migrate.main()``: the columns exist with the right type/nullability,
    a settle-to-done write lands correctly, the nonneg CHECK holds, and the
    down migration cleanly removes both columns.

SCOPE:
    - markers: up is non-destructive, down destructive (F-088 classification).
    - up: both columns exist, NULLABLE, NUMERIC(12,6); a pre-existing
      pending job (inserted before 096 runs) reads NULL, not 0; a settle-to-
      done UPDATE can write a computed cost; the nonneg CHECK rejects a
      negative value on both tables; re-driving the body is a no-op.
    - down: refused without --allow-destructive; with it, both columns are
      gone on both tables; re-up is clean.

DETERMINISM:
    Mirrors test_migration_095.py — the real migration files are copied into
    tmp_path-scoped directories and the runner is pointed at them via
    ``--migrations-dir``; the ``dsn`` fixture gives each test a fresh schema.
"""

from __future__ import annotations

import pathlib

import psycopg
import pytest
from psycopg import errors
from psycopg.rows import tuple_row

from db import migrate  # type: ignore[import-not-found]
from db.tests._helpers import FAKE_HASH  # type: ignore[import-not-found]

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

MIGRATION_NUM = "096"


def _pre_096_target(full_dir: pathlib.Path) -> str:
    """The version immediately before 096 in the chain actually present
    (numbering may have gaps while sibling branches are in flight)."""
    versions = sorted(
        {f.name[:3] for f in full_dir.iterdir() if f.suffix == ".sql"}
    )
    idx = versions.index(MIGRATION_NUM)
    assert idx > 0, "096 cannot be the first migration"
    return versions[idx - 1]


def _up(directory: pathlib.Path, target: str | None = None) -> None:
    # --allow-destructive: migration 045 (hygiene_cleanup, DROP TABLE) sits
    # in the chain, so a full `up` trips migrate.py's destructive gate
    # without it (mirrors db/tests/_helpers.py's _full_up).
    args = ["--migrations-dir", str(directory), "--allow-destructive"]
    if target is not None:
        args += ["--target", target]
    args.append("up")
    rc = migrate.main(args)
    assert rc == 0, f"up returned {rc}"


def _seed_user(conn: psycopg.Connection, email: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id",
            (email, FAKE_HASH),
        )
        return cur.fetchone()[0]


def _seed_story(conn: psycopg.Connection, user_id: int) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO generated_stories (user_id, title, body_ko, level)
            VALUES (%s, '모의 이야기', '옛날 옛적에 이야기가 있었습니다.', 'L3'::proficiency_level)
            RETURNING id
            """,
            (user_id,),
        )
        return cur.fetchone()[0]


def _insert_audio_job(
    conn: psycopg.Connection, story_id: int, user_id: int, *, status: str = "pending"
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO story_audio_jobs (generated_story_id, user_id, status, char_count)
            VALUES (%s, %s, %s, 100)
            RETURNING id
            """,
            (story_id, user_id, status),
        )
        return cur.fetchone()[0]


def _insert_image_job(
    conn: psycopg.Connection, story_id: int, user_id: int, *, status: str = "pending"
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO story_image_jobs (generated_story_id, user_id, status, image_count)
            VALUES (%s, %s, %s, 3)
            RETURNING id
            """,
            (story_id, user_id, status),
        )
        return cur.fetchone()[0]


def _column_shape(
    conn: psycopg.Connection, table: str, column: str
) -> tuple[str, int | None, int | None]:
    """(is_nullable, numeric_precision, numeric_scale)."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT is_nullable, numeric_precision, numeric_scale
              FROM information_schema.columns
             WHERE table_name = %s AND column_name = %s
            """,
            (table, column),
        )
        row = cur.fetchone()
        assert row is not None, f"{table}.{column} must exist"
        return row


# ---------------------------------------------------------------------------
# 1. F-088 marker classification.
# ---------------------------------------------------------------------------


def test_096_marker_classification() -> None:
    up_sql = (REAL_MIGRATIONS_DIR / "096_metered_spend_cost.up.sql").read_text(encoding="utf-8")
    down_sql = (REAL_MIGRATIONS_DIR / "096_metered_spend_cost.down.sql").read_text(encoding="utf-8")
    assert migrate.explicit_destructiveness(up_sql) is False
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — columns exist, NULLABLE NUMERIC(12,6); pre-existing rows stay NULL;
#    settle-to-done can write a cost; nonneg CHECK holds; re-driving is a
#    no-op.
# ---------------------------------------------------------------------------


def test_096_up_adds_nullable_numeric_cost_columns(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    # Seed a pending job on the migration immediately prior, so the "stays
    # NULL, not backfilled 0" behavior is actually exercised (not just a
    # fresh insert after the column already exists).
    pre_target = _pre_096_target(full_dir)
    _up(full_dir, target=pre_target)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "pre-096@test.dev")
        story_id = _seed_story(conn, user_id)
        pre_audio_job = _insert_audio_job(conn, story_id, user_id, status="pending")
        pre_image_job = _insert_image_job(conn, story_id, user_id, status="pending")

    _up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        # Shape: NULLABLE, NUMERIC(12,6) — mirrors claude_usage.cost_estimate_usd.
        for table in ("story_audio_jobs", "story_image_jobs"):
            is_nullable, precision, scale = _column_shape(conn, table, "cost_estimate_usd")
            assert is_nullable == "YES", f"{table}.cost_estimate_usd must be nullable"
            assert precision == 12
            assert scale == 6

        # The pre-existing pending rows were NOT backfilled 0 — they read NULL
        # (a pending job has spent nothing YET, which is distinct from "spent
        # exactly $0" — see the migration's design note).
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT cost_estimate_usd FROM story_audio_jobs WHERE id = %s",
                (pre_audio_job,),
            )
            assert cur.fetchone()[0] is None
            cur.execute(
                "SELECT cost_estimate_usd FROM story_image_jobs WHERE id = %s",
                (pre_image_job,),
            )
            assert cur.fetchone()[0] is None

        # A settle-to-done UPDATE (the runners' actual write shape) lands the
        # computed cost precisely at 6 decimal places.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                UPDATE story_audio_jobs
                   SET status = 'done', cost_estimate_usd = %s
                 WHERE id = %s
                """,
                ("0.030000", pre_audio_job),
            )
            cur.execute(
                "SELECT cost_estimate_usd FROM story_audio_jobs WHERE id = %s",
                (pre_audio_job,),
            )
            assert str(cur.fetchone()[0]) == "0.030000"

            cur.execute(
                """
                UPDATE story_image_jobs
                   SET status = 'done', cost_estimate_usd = %s
                 WHERE id = %s
                """,
                ("0.120000", pre_image_job),
            )
            cur.execute(
                "SELECT cost_estimate_usd FROM story_image_jobs WHERE id = %s",
                (pre_image_job,),
            )
            assert str(cur.fetchone()[0]) == "0.120000"

        # Re-driving the up body directly (the runner skips an applied
        # version): the ADD COLUMN IF NOT EXISTS + DO-block CHECK guards must
        # both be re-runnable.
        up_sql = (REAL_MIGRATIONS_DIR / "096_metered_spend_cost.up.sql").read_text(
            encoding="utf-8"
        )
        with conn.cursor() as cur:
            cur.execute(up_sql)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT cost_estimate_usd FROM story_audio_jobs WHERE id = %s",
                (pre_audio_job,),
            )
            assert str(cur.fetchone()[0]) == "0.030000"

        # A fresh job with no explicit cost also reads NULL.
        new_audio_job = _insert_audio_job(conn, story_id, user_id, status="pending")
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT cost_estimate_usd FROM story_audio_jobs WHERE id = %s",
                (new_audio_job,),
            )
            assert cur.fetchone()[0] is None


def test_096_nonneg_check_rejects_negative_cost(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "096-nonneg@test.dev")
        story_id = _seed_story(conn, user_id)
        audio_job = _insert_audio_job(conn, story_id, user_id)
        image_job = _insert_image_job(conn, story_id, user_id)

        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE story_audio_jobs SET cost_estimate_usd = -0.01 WHERE id = %s",
                    (audio_job,),
                )
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE story_image_jobs SET cost_estimate_usd = -0.01 WHERE id = %s",
                    (image_job,),
                )
        # 0 is legal — a settled job can legitimately cost nothing.
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE story_audio_jobs SET cost_estimate_usd = 0 WHERE id = %s",
                (audio_job,),
            )


# ---------------------------------------------------------------------------
# 3. DOWN — destructive gate; both columns gone; re-up clean.
# ---------------------------------------------------------------------------


def test_096_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    target = _pre_096_target(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "096-down@test.dev")
        story_id = _seed_story(conn, user_id)
        _insert_audio_job(conn, story_id, user_id)
        _insert_image_job(conn, story_id, user_id)

    # Refused without the flag (destructive marker on the down file).
    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", target, "down"])
    assert rc != 0, "096.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", target, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {target} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            for table in ("story_audio_jobs", "story_image_jobs"):
                cur.execute(
                    """
                    SELECT count(*) FROM information_schema.columns
                     WHERE table_name = %s AND column_name = 'cost_estimate_usd'
                    """,
                    (table,),
                )
                assert cur.fetchone()[0] == 0, f"{table}.cost_estimate_usd must be gone after down"

    # Round trip: re-up rebuilds both cleanly.
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            for table in ("story_audio_jobs", "story_image_jobs"):
                cur.execute(
                    """
                    SELECT count(*) FROM information_schema.columns
                     WHERE table_name = %s AND column_name = 'cost_estimate_usd'
                    """,
                    (table,),
                )
                assert cur.fetchone()[0] == 1
