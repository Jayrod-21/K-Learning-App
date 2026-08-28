"""Migration 107 (generated_mock_attempts, F-220 P3 — generated mock-exam
surface) — real-chain tests.

WHY THIS FILE EXISTS:
    107 is the persistence behind the generated-bank mock-exam surface (the
    default-off TOPIK_MOCK_USE_GENERATED_BANK flag's 3 routes, server/src/
    routes/topik.ts) — one row per learner sitting, snapshotting the
    assembled item set (server answers + client-safe fields) so resume and
    grading are stable regardless of later generated_items edits. The
    constraints below are what keeps a malformed row (bad tier/section/status,
    a non-array item_set, a completed row missing its score) from EVER
    landing, proven here against a real Postgres-16 testcontainer via
    ``migrate.main()`` — mirrors test_migration_101.py's structure.

SCOPE:
    - markers: up is non-destructive, down destructive (F-088 classification).
    - up: applies on the full real chain; re-driving the body is a no-op
      (IF NOT EXISTS everywhere).
    - constraints: tier/section/status closed sets, item_set array-ness,
      picks object-ness, current_index/remaining_ms non-negative,
      score_percentage range, the completion-fields CHECK (positive AND
      negative probe both directions), user FK CASCADE.
    - the partial unique (one in_progress row per (user, tier, section)):
      a second in_progress row for the SAME (user, tier, section) is
      rejected; a different tier, section, or user is NOT; a second row for
      the same (user, tier, section) IS allowed once the first is completed.
    - down: refused without --allow-destructive; with it, the table is gone;
      re-up is clean.

DETERMINISM:
    Mirrors test_migration_101.py — the real migration files are copied into
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

MIGRATION_NUM = "107"


def _pre_107_target(full_dir: pathlib.Path) -> str:
    """The version immediately before 107 in the chain actually present
    (numbering may have gaps while sibling branches are in flight)."""
    versions = sorted(
        {f.name[:3] for f in full_dir.iterdir() if f.suffix == ".sql"}
    )
    idx = versions.index(MIGRATION_NUM)
    assert idx > 0, "107 cannot be the first migration"
    return versions[idx - 1]


def _up(directory: pathlib.Path) -> None:
    rc = migrate.main(["--migrations-dir", str(directory), "--allow-destructive", "up"])
    assert rc == 0, f"up returned {rc}"


def _seed_user(conn: psycopg.Connection, email: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id",
            (email, FAKE_HASH),
        )
        return cur.fetchone()[0]


GOOD_ITEM_SET = [
    {
        "id": "single:1",
        "kind": "fill-blank",
        "prompt": "다음 빈칸에 알맞은 것을 고르십시오.",
        "choices": [
            {"id": "a", "kr": "은/는", "en": ""},
            {"id": "b", "kr": "이/가", "en": ""},
            {"id": "c", "kr": "을/를", "en": ""},
            {"id": "d", "kr": "에서", "en": ""},
        ],
        "correctChoiceId": "a",
        "explanation": "mock explanation",
    },
]


def _insert_attempt(
    conn: psycopg.Connection,
    user_id: int,
    *,
    tier: str = "II",
    section: str = "reading",
    item_set: list | None = None,
    picks: dict | None = None,
    current_index: int = 0,
    remaining_ms: int = 4_200_000,
    status: str = "in_progress",
    score_percentage: float | None = None,
    band: str | None = None,
    finished_at_sql: str | None = None,
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            f"""
            INSERT INTO generated_mock_attempts
                (user_id, tier, section, item_set, picks, current_index,
                 remaining_ms, status, score_percentage, band, finished_at)
            VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s, %s, %s,
                    {finished_at_sql if finished_at_sql is not None else "%s"})
            RETURNING id
            """,
            (
                user_id,
                tier,
                section,
                psycopg.types.json.Json(item_set if item_set is not None else GOOD_ITEM_SET),
                psycopg.types.json.Json(picks if picks is not None else {}),
                current_index,
                remaining_ms,
                status,
                score_percentage,
                band,
            )
            + (() if finished_at_sql is not None else (None,)),
        )
        return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# 1. F-088 marker classification.
# ---------------------------------------------------------------------------


def test_107_marker_classification() -> None:
    up_sql = (REAL_MIGRATIONS_DIR / "107_generated_mock_attempts.up.sql").read_text(
        encoding="utf-8"
    )
    down_sql = (REAL_MIGRATIONS_DIR / "107_generated_mock_attempts.down.sql").read_text(
        encoding="utf-8"
    )
    assert migrate.explicit_destructiveness(up_sql) is False
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — applies on the real chain; re-driving the body is a no-op.
# ---------------------------------------------------------------------------


def test_107_up_applies_and_reapply_is_idempotent(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)

    up_sql = (REAL_MIGRATIONS_DIR / "107_generated_mock_attempts.up.sql").read_text(
        encoding="utf-8"
    )
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(up_sql)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM generated_mock_attempts")
            assert cur.fetchone()[0] == 0
            cur.execute(
                """
                SELECT column_name, is_nullable
                  FROM information_schema.columns
                 WHERE table_name = 'generated_mock_attempts'
                 ORDER BY column_name
                """
            )
            cols = {row[0]: row[1] for row in cur.fetchall()}
            assert cols == {
                "id": "NO",
                "user_id": "NO",
                "tier": "NO",
                "section": "NO",
                "item_set": "NO",
                "picks": "NO",
                "current_index": "NO",
                "remaining_ms": "NO",
                "status": "NO",
                "score_percentage": "YES",
                "band": "YES",
                "started_at": "NO",
                "finished_at": "YES",
                "created_at": "NO",
                "updated_at": "NO",
                "version": "NO",
            }
            # Partial unique + status lookup index exist.
            cur.execute(
                "SELECT indexname FROM pg_indexes WHERE tablename = 'generated_mock_attempts' "
                "AND indexname = 'uq_generated_mock_attempts_active'"
            )
            assert cur.fetchone() is not None
            cur.execute(
                "SELECT indexname FROM pg_indexes WHERE tablename = 'generated_mock_attempts' "
                "AND indexname = 'ix_generated_mock_attempts_user_status'"
            )
            assert cur.fetchone() is not None


# ---------------------------------------------------------------------------
# 3. Constraints — each guard proven by the write it rejects.
# ---------------------------------------------------------------------------


def test_107_positive_insert_and_defaults(env, dsn: str, full_dir: pathlib.Path) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "learner-107a@example.com")
        attempt_id = _insert_attempt(conn, user_id)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT status, picks, current_index, score_percentage, band, finished_at "
                "FROM generated_mock_attempts WHERE id = %s",
                (attempt_id,),
            )
            row = cur.fetchone()
            assert row[0] == "in_progress"
            assert row[1] == {}
            assert row[2] == 0
            assert row[3] is None
            assert row[4] is None
            assert row[5] is None


def test_107_tier_section_status_closed_sets(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "learner-107b@example.com")

        with pytest.raises(errors.CheckViolation):
            _insert_attempt(conn, user_id, tier="TOPIK II")
        # Every (tier, section) combo probed below is DISTINCT so none trips
        # the partial-unique arbiter (uq_generated_mock_attempts_active) —
        # this test is only proving the CHECK closed sets, not the unique.
        _insert_attempt(conn, user_id, tier="I", section="listening")
        _insert_attempt(conn, user_id, tier="II", section="listening")

        with pytest.raises(errors.CheckViolation):
            _insert_attempt(conn, user_id, section="writing")
        _insert_attempt(conn, user_id, tier="I", section="reading")
        _insert_attempt(conn, user_id, tier="II", section="reading")

        with pytest.raises(errors.CheckViolation):
            _insert_attempt(conn, user_id, status="abandoned")


def test_107_item_set_must_be_array_picks_must_be_object(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "learner-107c@example.com")

        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO generated_mock_attempts
                        (user_id, tier, section, item_set, picks, remaining_ms)
                    VALUES (%s, 'II', 'reading', '{"not": "an array"}'::jsonb,
                            '{}'::jsonb, 100)
                    """,
                    (user_id,),
                )

        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO generated_mock_attempts
                        (user_id, tier, section, item_set, picks, remaining_ms)
                    VALUES (%s, 'II', 'reading', '[]'::jsonb,
                            '["not", "an", "object"]'::jsonb, 100)
                    """,
                    (user_id,),
                )


def test_107_nonneg_and_score_range(env, dsn: str, full_dir: pathlib.Path) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "learner-107d@example.com")

        with pytest.raises(errors.CheckViolation):
            _insert_attempt(conn, user_id, current_index=-1)
        with pytest.raises(errors.CheckViolation):
            _insert_attempt(conn, user_id, remaining_ms=-1)

        # score_percentage is only writable alongside a completed row (the
        # completion-fields CHECK below), so probe its range CHECK via a
        # well-formed completed row.
        with pytest.raises(errors.CheckViolation):
            _insert_attempt(
                conn,
                user_id,
                status="completed",
                score_percentage=100.1,
                band="On track for L5+",
                finished_at_sql="now()",
            )
        with pytest.raises(errors.CheckViolation):
            _insert_attempt(
                conn,
                user_id,
                status="completed",
                score_percentage=-0.1,
                band="Below L3",
                finished_at_sql="now()",
            )
        _insert_attempt(
            conn,
            user_id,
            status="completed",
            score_percentage=87.5,
            band="On track for L5+",
            finished_at_sql="now()",
        )


def test_107_completion_fields_check_both_directions(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "learner-107e@example.com")

        # in_progress row carrying a score → rejected.
        with pytest.raises(errors.CheckViolation):
            _insert_attempt(conn, user_id, status="in_progress", score_percentage=50.0)
        # in_progress row carrying a band → rejected.
        with pytest.raises(errors.CheckViolation):
            _insert_attempt(conn, user_id, status="in_progress", band="L4 range")
        # in_progress row carrying finished_at → rejected.
        with pytest.raises(errors.CheckViolation):
            _insert_attempt(conn, user_id, status="in_progress", finished_at_sql="now()")

        # completed row missing score_percentage → rejected.
        with pytest.raises(errors.CheckViolation):
            _insert_attempt(
                conn, user_id, status="completed", band="L4 range", finished_at_sql="now()"
            )
        # completed row missing band → rejected.
        with pytest.raises(errors.CheckViolation):
            _insert_attempt(
                conn,
                user_id,
                status="completed",
                score_percentage=60.0,
                finished_at_sql="now()",
            )
        # completed row missing finished_at → rejected.
        with pytest.raises(errors.CheckViolation):
            _insert_attempt(
                conn, user_id, status="completed", score_percentage=60.0, band="L4 range"
            )

        # A fully well-formed completed row passes.
        _insert_attempt(
            conn,
            user_id,
            status="completed",
            score_percentage=60.0,
            band="L4 range",
            finished_at_sql="now()",
        )


def test_107_user_fk_cascade(env, dsn: str, full_dir: pathlib.Path) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "learner-107f@example.com")
        _insert_attempt(conn, user_id)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (user_id,))
            cur.execute("SELECT count(*) FROM generated_mock_attempts WHERE user_id = %s", (user_id,))
            assert cur.fetchone()[0] == 0


# ---------------------------------------------------------------------------
# 4. One in_progress attempt per (user, tier, section) — partial unique.
# ---------------------------------------------------------------------------


def test_107_one_in_progress_per_user_tier_section(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "learner-107g@example.com")

        _insert_attempt(conn, user_id, tier="II", section="reading")

        # A second in_progress row for the IDENTICAL (user, tier, section) —
        # rejected by the partial unique.
        with pytest.raises(errors.UniqueViolation):
            _insert_attempt(conn, user_id, tier="II", section="reading")

        # A DIFFERENT section for the same user/tier — allowed (unrelated sitting).
        _insert_attempt(conn, user_id, tier="II", section="listening")
        # A DIFFERENT tier for the same user/section — allowed.
        _insert_attempt(conn, user_id, tier="I", section="reading")

        # A different user, same (tier, section) — allowed (no cross-user collision).
        other_user_id = _seed_user(conn, "learner-107h@example.com")
        _insert_attempt(conn, other_user_id, tier="II", section="reading")

        # Once the original (user_id, II, reading) row is completed, a fresh
        # in_progress sitting for the SAME (user, tier, section) is allowed
        # again — the partial index no longer arbiters a completed row.
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE generated_mock_attempts
                   SET status = 'completed', score_percentage = 50.0, band = 'L4 range',
                       finished_at = now()
                 WHERE user_id = %s AND tier = 'II' AND section = 'reading'
                """,
                (user_id,),
            )
        _insert_attempt(conn, user_id, tier="II", section="reading")


# ---------------------------------------------------------------------------
# 5. DOWN — destructive gate; table gone; re-up clean.
# ---------------------------------------------------------------------------


def test_107_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    target = _pre_107_target(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "learner-107i@example.com")
        _insert_attempt(conn, user_id)

    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", target, "down"])
    assert rc != 0, "107.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", target, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {target} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT to_regclass('public.generated_mock_attempts')")
            assert cur.fetchone()[0] is None, "generated_mock_attempts must be gone after down"

    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM generated_mock_attempts")
            assert cur.fetchone()[0] == 0
