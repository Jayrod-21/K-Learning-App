"""Migration 087 (diagnostic_hanja_section, diagnostic-upgrade Phase A) —
real-chain tests.

WHY THIS FILE EXISTS:
    087 widens `ck_diagnostic_responses_section` (014) to add 'hanja' — the
    fifth, coverage-only diagnostic dimension (server/src/routes/diagnostic.ts
    buildHanjaItem draws from hanja_characters, migration 016). The tests pin
    exactly the contract the CHECK widen promises: 'hanja' now inserts
    cleanly, an unrelated unknown value is still rejected, the four original
    section values still insert (the widen is additive, never a behavior
    change for existing rows), `source_kind` is UNTOUCHED (hanja reuses the
    already-valid 'generated' value — no widen needed there), a manual
    re-apply of the up body is a no-op, and the down migration re-narrows the
    CHECK — succeeding when no 'hanja' row exists, but FAILING (blocked
    rollback, exit code 2, no partial effect) when one does, exactly mirroring
    056's writing_attempts.rubric rollback posture (a widen-then-narrow while
    the widened value is in use is a data-shape conflict the operator must
    resolve deliberately, never a silent data loss).

DETERMINISM:
    Mirrors test_migration_086.py / test_migration_084.py — the real
    migration files are copied into a tmp_path-scoped directory and the
    runner is pointed at it via ``--migrations-dir``; the ``dsn`` fixture
    gives each test a fresh schema.
"""

from __future__ import annotations

import pathlib

import psycopg
import pytest
from psycopg import errors
from psycopg.rows import tuple_row

from db import migrate  # type: ignore[import-not-found]
from db.tests._helpers import FAKE_HASH, _full_up  # type: ignore[import-not-found]

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

# The migration immediately before 087. `down --target PRE_087` rolls back
# ONLY 087 (its CHECK-narrow down is destructive-marked).
PRE_087 = "086"


# ---------------------------------------------------------------------------
# Seed helpers — users → diagnostic_runs → diagnostic_responses (raw SQL)
# ---------------------------------------------------------------------------

def _seed_user(conn: psycopg.Connection, email: str = "diag-087@test.local") -> int:
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


def _insert_response(
    conn: psycopg.Connection,
    run_id: int,
    ordinal: int,
    section: str,
    source_kind: str = "generated",
    source_ref: str = "學",
) -> int:
    """Insert a diagnostic_responses row shaped exactly like buildHanjaItem's
    output for a hanja row (source_kind='generated', reused — see 087's
    up.sql header) or like any other served-but-unanswered item otherwise."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO diagnostic_responses
                (run_id, ordinal, section, source_kind, source_ref, difficulty,
                 kind, item_payload, correct_answer)
            VALUES (%s, %s, %s, %s, %s, 2.00,
                    'hanja-reading', '{"prompt": "학의 음은?"}'::jsonb, 'a')
            RETURNING id
            """,
            (run_id, ordinal, section, source_kind, source_ref),
        )
        return cur.fetchone()[0]


def _section_check_definition(conn: psycopg.Connection) -> str:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT pg_get_constraintdef(oid)
              FROM pg_constraint
             WHERE conname = 'ck_diagnostic_responses_section'
            """
        )
        row = cur.fetchone()
        assert row is not None, "ck_diagnostic_responses_section must exist"
        return row[0]


# ---------------------------------------------------------------------------
# 1. UP — 'hanja' now inserts; the four original values still do too
# ---------------------------------------------------------------------------

def test_087_section_check_accepts_hanja(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        run_id = _seed_run(conn, user_id)

        response_id = _insert_response(conn, run_id, 1, "hanja")
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT section, source_kind, source_ref FROM diagnostic_responses WHERE id = %s",
                (response_id,),
            )
            row = cur.fetchone()
            assert row == ("hanja", "generated", "學")


def test_087_original_four_sections_still_accepted(env, dsn: str, full_dir) -> None:
    """Additive widen — no existing behavior regresses."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        run_id = _seed_run(conn, user_id)

        for i, section in enumerate(["vocab", "grammar", "reading", "listening"], start=1):
            _insert_response(conn, run_id, i, section, source_kind="topik" if section in ("reading", "listening") else "generated")
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT count(*) FROM diagnostic_responses WHERE run_id = %s", (run_id,)
            )
            assert cur.fetchone()[0] == 4


def test_087_section_check_still_rejects_unknown_value(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        run_id = _seed_run(conn, user_id)

        with pytest.raises(errors.CheckViolation):
            # A value that is not a valid section under ANY migration — must stay
            # rejected across later widenings of ck_diagnostic_responses_section.
            # (Do NOT use a real future dimension here: 088 added 'writing', which
            # would silently make this assertion pass. See test_migration_088 for
            # the 'writing'-is-now-accepted coverage.)
            _insert_response(conn, run_id, 1, "not_a_section")


def test_087_source_kind_check_untouched(env, dsn: str, full_dir) -> None:
    """087 deliberately does NOT widen ck_diagnostic_responses_source_kind —
    hanja reuses 'generated'. Pin that the two-value CHECK (topik/generated)
    is unchanged: a third value is still rejected."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        run_id = _seed_run(conn, user_id)

        with pytest.raises(errors.CheckViolation):
            _insert_response(conn, run_id, 1, "hanja", source_kind="corpus")
        # The reused value still works.
        _insert_response(conn, run_id, 1, "hanja", source_kind="generated")


# ---------------------------------------------------------------------------
# 2. UP — manual re-apply of the up body is a no-op (DROP+ADD CONSTRAINT is
#         naturally idempotent; nothing here depends on IF NOT EXISTS)
# ---------------------------------------------------------------------------

def test_087_reapply_up_body_is_noop(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    up_sql = (REAL_MIGRATIONS_DIR / "087_diagnostic_hanja_section.up.sql").read_text(
        encoding="utf-8"
    )
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        run_id = _seed_run(conn, user_id)
        response_id = _insert_response(conn, run_id, 1, "hanja")

        with conn.cursor() as cur:
            cur.execute(up_sql)

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT section FROM diagnostic_responses WHERE id = %s", (response_id,)
            )
            assert cur.fetchone()[0] == "hanja"
        assert "'hanja'" in _section_check_definition(conn)


# ---------------------------------------------------------------------------
# 3. DOWN — re-narrows cleanly when no 'hanja' row exists, then a clean re-up
# ---------------------------------------------------------------------------

def test_087_down_renarrows_when_no_hanja_rows_then_reups(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        run_id = _seed_run(conn, user_id)
        # Only ORIGINAL-section rows — nothing for the narrower CHECK to choke on.
        _insert_response(conn, run_id, 1, "vocab")

    rc = migrate.main(
        [
            "--migrations-dir",
            str(full_dir),
            "--target",
            PRE_087,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_087} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert "'hanja'" not in _section_check_definition(conn)
        # The pre-existing vocab row survived the narrow untouched (pure CHECK
        # swap, no data touched).
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM diagnostic_responses WHERE run_id = %s", (run_id,))
            assert cur.fetchone()[0] == 1
        # The narrowed CHECK is live again: 'hanja' is rejected.
        with pytest.raises(errors.CheckViolation):
            _insert_response(conn, run_id, 2, "hanja")

    # Re-up: 087 re-applies cleanly, 'hanja' accepted again.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert "'hanja'" in _section_check_definition(conn)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT id FROM diagnostic_runs WHERE user_id = %s", (user_id,))
            run_id2 = cur.fetchone()[0]
        # ordinal 2, not 1: this is the same run as above (one run for the user),
        # and (run_id, 1) already holds the seeded vocab row — UNIQUE(run_id,
        # ordinal). We only need to prove 'hanja' is accepted again post-re-up.
        _insert_response(conn, run_id2, 2, "hanja")


# ---------------------------------------------------------------------------
# 4. DOWN — blocked (exit 2, no partial effect) when a live 'hanja' row
#           already exists — the HONEST GATE the down.sql header documents.
# ---------------------------------------------------------------------------

def test_087_down_blocked_by_existing_hanja_row(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        run_id = _seed_run(conn, user_id)
        _insert_response(conn, run_id, 1, "hanja")

    # migrate.py's main() catches psycopg.Error (CheckViolation IS a
    # psycopg.Error) and returns rc=2 rather than letting it propagate — see
    # migrate.py main()'s `except (MigrationError, psycopg.Error)` clause.
    rc = migrate.main(
        [
            "--migrations-dir",
            str(full_dir),
            "--target",
            PRE_087,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 2, f"down --target {PRE_087} with a live hanja row should be blocked (rc=2), got {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        # No partial effect: the migration runs in one transaction per the
        # module's own contract, so the failed ALTER rolled back — the WIDE
        # CHECK is still in force and the hanja row is untouched.
        assert "'hanja'" in _section_check_definition(conn)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT count(*) FROM diagnostic_responses WHERE run_id = %s AND section = 'hanja'",
                (run_id,),
            )
            assert cur.fetchone()[0] == 1
        # schema_migrations bookkeeping still shows 087 applied (the rollback
        # never committed).
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT count(*) FROM schema_migrations WHERE version = '087'"
            )
            assert cur.fetchone()[0] == 1
