"""Migration 088 (diagnostic_writing_section, diagnostic-upgrade Phase B) —
real-chain tests.

WHY THIS FILE EXISTS:
    088 widens `ck_diagnostic_responses_section` (014, 087) to add 'writing'
    — the sixth diagnostic dimension, and unlike hanja (087) a FULL LEVELED
    one: a writing response bumps the run's global θ ladder and consumes a
    step-ordinal slot (server/src/routes/diagnostic.ts buildWritingItem draws
    from kgiu_entries, graded via the existing generateGrammarDrill/
    scoreGrammarDrill Claude pipeline). The tests pin exactly the contract the
    CHECK widen promises: 'writing' now inserts cleanly, an unrelated unknown
    value is still rejected, the original five section values (vocab/grammar/
    reading/listening/hanja) still insert (the widen is additive, never a
    behavior change for existing rows), `source_kind` is UNTOUCHED (writing
    reuses the already-valid 'generated' value — no widen needed there), a
    manual re-apply of the up body is a no-op, and the down migration
    re-narrows the CHECK — succeeding when no 'writing' row exists, but
    FAILING (blocked rollback, exit code 2, no partial effect) when one does,
    exactly mirroring 087's hanja rollback posture (a widen-then-narrow while
    the widened value is in use is a data-shape conflict the operator must
    resolve deliberately, never a silent data loss).

DETERMINISM:
    Mirrors test_migration_087.py / test_migration_086.py — the real
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

# The migration immediately before 088. `down --target PRE_088` rolls back
# ONLY 088 (its CHECK-narrow down is destructive-marked).
PRE_088 = "087"

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
# Seed helpers — users → diagnostic_runs → diagnostic_responses (raw SQL)
# ---------------------------------------------------------------------------

def _seed_user(conn: psycopg.Connection, email: str = "diag-088@test.local") -> int:
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
    source_ref: str = "kgiu-042",
) -> int:
    """Insert a diagnostic_responses row shaped exactly like buildWritingItem's
    output for a writing row (source_kind='generated', reused — see 088's
    up.sql header) or like any other served-but-unanswered item otherwise."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO diagnostic_responses
                (run_id, ordinal, section, source_kind, source_ref, difficulty,
                 kind, item_payload, correct_answer)
            VALUES (%s, %s, %s, %s, %s, 3.00,
                    'writing-production',
                    '{"prompt": "Rewrite using -는 것 같다.", "passage": "그는 학생이다."}'::jsonb,
                    'writing')
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
# 1. UP — 'writing' now inserts; the original five values still do too
# ---------------------------------------------------------------------------

def test_088_section_check_accepts_writing(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        run_id = _seed_run(conn, user_id)

        response_id = _insert_response(conn, run_id, 1, "writing")
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT section, source_kind, source_ref FROM diagnostic_responses WHERE id = %s",
                (response_id,),
            )
            row = cur.fetchone()
            assert row == ("writing", "generated", "kgiu-042")


def test_088_original_five_sections_still_accepted(env, dsn: str, full_dir) -> None:
    """Additive widen — no existing behavior regresses."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        run_id = _seed_run(conn, user_id)

        for i, section in enumerate(
            ["vocab", "grammar", "reading", "listening", "hanja"], start=1
        ):
            _insert_response(
                conn,
                run_id,
                i,
                section,
                source_kind="topik" if section in ("reading", "listening") else "generated",
            )
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT count(*) FROM diagnostic_responses WHERE run_id = %s", (run_id,)
            )
            assert cur.fetchone()[0] == 5


def test_088_section_check_still_rejects_unknown_value(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        run_id = _seed_run(conn, user_id)

        with pytest.raises(errors.CheckViolation):
            _insert_response(conn, run_id, 1, "speaking")  # not yet a served dimension


def test_088_source_kind_check_untouched(env, dsn: str, full_dir) -> None:
    """088 deliberately does NOT widen ck_diagnostic_responses_source_kind —
    writing reuses 'generated'. Pin that the two-value CHECK (topik/generated)
    is unchanged: a third value is still rejected."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        run_id = _seed_run(conn, user_id)

        with pytest.raises(errors.CheckViolation):
            _insert_response(conn, run_id, 1, "writing", source_kind="corpus")
        # The reused value still works.
        _insert_response(conn, run_id, 1, "writing", source_kind="generated")


# ---------------------------------------------------------------------------
# 2. UP — manual re-apply of the up body is a no-op (DROP+ADD CONSTRAINT is
#         naturally idempotent; nothing here depends on IF NOT EXISTS)
# ---------------------------------------------------------------------------

def test_088_reapply_up_body_is_noop(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    up_sql = (REAL_MIGRATIONS_DIR / "088_diagnostic_writing_section.up.sql").read_text(
        encoding="utf-8"
    )
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        run_id = _seed_run(conn, user_id)
        response_id = _insert_response(conn, run_id, 1, "writing")

        with conn.cursor() as cur:
            cur.execute(up_sql)

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT section FROM diagnostic_responses WHERE id = %s", (response_id,)
            )
            assert cur.fetchone()[0] == "writing"
        assert "'writing'" in _section_check_definition(conn)


# ---------------------------------------------------------------------------
# 3. DOWN — re-narrows cleanly when no 'writing' row exists, then a clean re-up
# ---------------------------------------------------------------------------

def test_088_down_renarrows_when_no_writing_rows_then_reups(env, dsn: str, full_dir) -> None:
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
            PRE_088,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_088} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert "'writing'" not in _section_check_definition(conn)
        # The pre-existing vocab row survived the narrow untouched (pure CHECK
        # swap, no data touched).
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM diagnostic_responses WHERE run_id = %s", (run_id,))
            assert cur.fetchone()[0] == 1
        # The narrowed CHECK is live again: 'writing' is rejected, but 'hanja'
        # (087, not rolled back by this down) still is not.
        with pytest.raises(errors.CheckViolation):
            _insert_response(conn, run_id, 2, "writing")
        _insert_response(conn, run_id, 3, "hanja")

    # Re-up: 088 re-applies cleanly, 'writing' accepted again.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert "'writing'" in _section_check_definition(conn)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT id FROM diagnostic_runs WHERE user_id = %s", (user_id,))
            run_id2 = cur.fetchone()[0]
        # ordinal 4, not 1: this is the same run as above (one run for the
        # user), and (run_id, 1..3) are already taken — UNIQUE(run_id,
        # ordinal). We only need to prove 'writing' is accepted again post-re-up.
        _insert_response(conn, run_id2, 4, "writing")


# ---------------------------------------------------------------------------
# 4. DOWN — blocked (exit 2, no partial effect) when a live 'writing' row
#           already exists — the HONEST GATE the down.sql header documents.
# ---------------------------------------------------------------------------

def test_088_down_blocked_by_existing_writing_row(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        run_id = _seed_run(conn, user_id)
        _insert_response(conn, run_id, 1, "writing")

    # migrate.py's main() catches psycopg.Error (CheckViolation IS a
    # psycopg.Error) and returns rc=2 rather than letting it propagate — see
    # migrate.py main()'s `except (MigrationError, psycopg.Error)` clause.
    rc = migrate.main(
        [
            "--migrations-dir",
            str(full_dir),
            "--target",
            PRE_088,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 2, f"down --target {PRE_088} with a live writing row should be blocked (rc=2), got {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        # No partial effect: the migration runs in one transaction per the
        # module's own contract, so the failed ALTER rolled back — the WIDE
        # CHECK is still in force and the writing row is untouched.
        assert "'writing'" in _section_check_definition(conn)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT count(*) FROM diagnostic_responses WHERE run_id = %s AND section = 'writing'",
                (run_id,),
            )
            assert cur.fetchone()[0] == 1
        # schema_migrations bookkeeping still shows 088 applied (the rollback
        # never committed).
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT count(*) FROM schema_migrations WHERE version = '088'"
            )
            assert cur.fetchone()[0] == 1
