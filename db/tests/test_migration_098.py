"""Migration 098 (user_gloss_overrides, Phase 2.8 user-scoped gloss override)
— real-chain tests.

WHY THIS FILE EXISTS:
    098 is the storage behind a learner's own per-(user, lemma) replacement
    English gloss — the F-199 lesson applied up front: the shared
    `vocab_entries.english` / `krdict_entries.definition_english` columns are
    NEVER a write target for this feature, so the override lives in its own
    per-user table instead. The constraints below are what makes the
    read-overlay's `LEFT JOIN ... ON ugo.user_id = $u AND ugo.lemma = <col>`
    (server/src/routes/vocab.ts et al.) safe to COALESCE without fan-out, and
    are proven here against a real Postgres-16 testcontainer via
    ``migrate.main()``.

SCOPE:
    - markers: up is non-destructive, down destructive (F-088 classification).
    - up: applies on the full real chain; re-driving the body is a no-op
      (IF NOT EXISTS everywhere).
    - constraints: lemma-length CHECK, gloss-length CHECK, UNIQUE(user_id,
      lemma) (positive AND negative probe), user FK CASCADE.
    - down: refused without --allow-destructive; with it, the table is gone;
      re-up is clean.

DETERMINISM:
    Mirrors test_migration_097.py — the real migration files are copied into
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

MIGRATION_NUM = "098"


def _pre_098_target(full_dir: pathlib.Path) -> str:
    """The version immediately before 098 in the chain actually present
    (numbering may have gaps while sibling branches are in flight)."""
    versions = sorted(
        {f.name[:3] for f in full_dir.iterdir() if f.suffix == ".sql"}
    )
    idx = versions.index(MIGRATION_NUM)
    assert idx > 0, "098 cannot be the first migration"
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


def _insert_override(
    conn: psycopg.Connection,
    user_id: int,
    lemma: str = "사과",
    gloss: str = "apple (my own note)",
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO user_gloss_overrides (user_id, lemma, gloss) "
            "VALUES (%s, %s, %s) RETURNING id",
            (user_id, lemma, gloss),
        )
        return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# 1. F-088 marker classification.
# ---------------------------------------------------------------------------


def test_098_marker_classification() -> None:
    up_sql = (REAL_MIGRATIONS_DIR / "098_user_gloss_overrides.up.sql").read_text(
        encoding="utf-8"
    )
    down_sql = (REAL_MIGRATIONS_DIR / "098_user_gloss_overrides.down.sql").read_text(
        encoding="utf-8"
    )
    assert migrate.explicit_destructiveness(up_sql) is False
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — applies on the real chain; re-driving the body is a no-op.
# ---------------------------------------------------------------------------


def test_098_up_applies_and_reapply_is_idempotent(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)

    up_sql = (REAL_MIGRATIONS_DIR / "098_user_gloss_overrides.up.sql").read_text(
        encoding="utf-8"
    )
    with psycopg.connect(dsn, autocommit=True) as conn:
        # Drive the body a second time directly (the runner skips an applied
        # version): CREATE TABLE IF NOT EXISTS must be re-runnable.
        with conn.cursor() as cur:
            cur.execute(up_sql)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM user_gloss_overrides")
            assert cur.fetchone()[0] == 0
            cur.execute(
                """
                SELECT column_name, is_nullable
                  FROM information_schema.columns
                 WHERE table_name = 'user_gloss_overrides'
                 ORDER BY column_name
                """
            )
            cols = {row[0]: row[1] for row in cur.fetchall()}
            assert cols == {
                "id": "NO",
                "user_id": "NO",
                "lemma": "NO",
                "gloss": "NO",
                "created_at": "NO",
                "updated_at": "NO",
            }


# ---------------------------------------------------------------------------
# 3. Constraints — each guard proven by the write it rejects.
# ---------------------------------------------------------------------------


def test_098_constraints(env, dsn: str, full_dir: pathlib.Path) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "learner@test.dev")

        # Well-formed insert passes.
        _insert_override(conn, user_id, "사과", "apple")

        # ck_user_gloss_overrides_lemma_len: lemma must be 1..100 chars.
        with pytest.raises(errors.CheckViolation):
            _insert_override(conn, user_id, "", "empty lemma")
        with pytest.raises(errors.CheckViolation):
            _insert_override(conn, user_id, "가" * 101, "too long")

        # ck_user_gloss_overrides_gloss_len: gloss must be 1..2000 chars.
        with pytest.raises(errors.CheckViolation):
            _insert_override(conn, user_id, "바나나", "")
        with pytest.raises(errors.CheckViolation):
            _insert_override(conn, user_id, "바나나", "x" * 2001)

        # uq_user_gloss_overrides_user_lemma — negative probe: the same user
        # cannot hold two overrides for the same lemma (the overlay join
        # depends on at-most-one-row-per-(user, lemma)).
        with pytest.raises(errors.UniqueViolation):
            _insert_override(conn, user_id, "사과", "a second override")

        # uq_user_gloss_overrides_user_lemma — positive probe: the SAME lemma
        # is fine for a DIFFERENT user (per-user isolation, not global).
        other_user_id = _seed_user(conn, "learner2@test.dev")
        second_id = _insert_override(conn, other_user_id, "사과", "apple (user 2)")
        assert second_id is not None

        # fk_user_gloss_overrides_user ON DELETE CASCADE: deleting the owning
        # user removes their override rows — no orphaned per-user prefs.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (other_user_id,))
            cur.execute(
                "SELECT count(*) FROM user_gloss_overrides WHERE user_id = %s",
                (other_user_id,),
            )
            assert cur.fetchone()[0] == 0
        # The first user's override is untouched by the second user's delete.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT count(*) FROM user_gloss_overrides WHERE user_id = %s",
                (user_id,),
            )
            assert cur.fetchone()[0] == 1


# ---------------------------------------------------------------------------
# 4. DOWN — destructive gate; table gone; re-up clean.
# ---------------------------------------------------------------------------


def test_098_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    target = _pre_098_target(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "down-user@test.dev")
        _insert_override(conn, user_id)

    # Refused without the flag (DROP TABLE + explicit destructive marker).
    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", target, "down"])
    assert rc != 0, "098.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", target, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {target} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT to_regclass('public.user_gloss_overrides')")
            assert cur.fetchone()[0] is None, "user_gloss_overrides must be gone after down"

    # Round trip: re-up rebuilds the table cleanly.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM user_gloss_overrides")
            assert cur.fetchone()[0] == 0
