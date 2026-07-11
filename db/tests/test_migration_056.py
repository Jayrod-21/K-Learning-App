"""Migration 056 (writing rubric taxonomy widen, F-117) — real-data tests.

WHY THIS FILE EXISTS:
    056 ALTERS TWO EXISTING CHECK CONSTRAINTS on tables that already carry
    seed/user data: `ck_writing_prompts_rubric` and `ck_writing_attempts_rubric`
    (both installed by 038) widen from a closed two-value set
    (topik_ii_53 / topik_ii_54) to a three-value set that also accepts
    'free_write'. The synthetic harness tests (test_migrations.py) and the
    foundation round-trips (test_migrations_real.py, 001+002 only) cannot
    prove that pre-056 rows survive untouched, that the widened CHECK
    actually accepts 'free_write' end to end on both tables, that the old
    two values are still enforced (never silently opened up further than
    intended), or that the DOWN migration behaves HONESTLY when a
    'free_write' row already exists (it must fail loudly via a Postgres
    CheckViolation, never silently delete graded work). These tests apply
    the REAL migration chain against a Postgres-16 testcontainer via
    `migrate.main()`.

SCOPE:
    - up: the pre-existing 038-seeded TOPIK II bank rows (topik_ii_53 /
      topik_ii_54) survive untouched; 'free_write' is now insertable on both
      writing_prompts and writing_attempts; a bogus rubric value is still
      rejected; the CHECK constraints keep their original names (038's ADD
      CONSTRAINT name is reused, not replaced by a differently-named one, so
      no other migration or app code that references the constraint by name
      breaks).
    - down (clean path): with no 'free_write' rows present, the down
      restores the narrow 038 CHECKs; 'free_write' is rejected again;
      topik_ii_53/54 still insert cleanly; a clean re-up is then possible.
    - down (honest-gate path): with a 'free_write' row already persisted on
      EITHER table, the down FAILS (CheckViolation, migrate.main() returns
      exit code 2 per its own documented contract) instead of silently
      discarding the row — this is the "handle honestly" requirement for a
      CHECK-narrow whose widened value may already be in use.

DETERMINISM:
    Mirrors test_migration_049.py / test_migration_046.py — the real
    migration files are copied into a tmp_path-scoped directory and the
    runner is pointed at it via `--migrations-dir`; the `dsn` fixture gives
    each test a fresh schema.

NB: the chain up to 055 traverses 045 (hygiene_cleanup, DROP TABLE), so every
    `up` here — including the seed-stage one — passes --allow-destructive,
    matching the 046/049 precedent. 056's OWN up/down bodies contain no
    DROP TABLE / DROP SCHEMA / DROP DATABASE / TRUNCATE, so migrate.py's
    DESTRUCTIVE_PATTERNS gate never fires on 056 itself — the honest-gate
    test below asserts a *CheckViolation*, not a `DestructiveBlocked`.
"""

from __future__ import annotations

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

# The seed target: the migration immediately before 056 in the chain, i.e.
# the pre-056 (038-shaped) two-value rubric CHECKs.
PRE_056 = "055"

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
# Seed helpers — raw SQL, no app layer involved
# ---------------------------------------------------------------------------

def _seed_user(conn: psycopg.Connection, email: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id",
            (email, FAKE_HASH),
        )
        return cur.fetchone()[0]


def _constraint_names(conn: psycopg.Connection, table: str) -> set[str]:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT conname FROM pg_constraint WHERE conrelid = %s::regclass",
            (table,),
        )
        return {r[0] for r in cur.fetchall()}


def _check_definition(conn: psycopg.Connection, conname: str) -> str:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = %s",
            (conname,),
        )
        row = cur.fetchone()
        assert row is not None, f"constraint {conname} missing"
        return row[0]


def _insert_prompt(conn: psycopg.Connection, rubric: str | None, source_id: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO writing_prompts
                (source_id, title, prompt_kr, prompt_en, level, rubric)
            VALUES (%s, 'test prompt', '테스트 프롬프트입니다.', 'test prompt',
                    'L4'::proficiency_level, %s)
            RETURNING id
            """,
            (source_id, rubric),
        )
        return cur.fetchone()[0]


def _insert_attempt(conn: psycopg.Connection, user_id: int, rubric: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO writing_attempts
                (user_id, rubric, prompt_kr, sample, total_score, max_total, result)
            VALUES (%s, %s, '테스트 프롬프트', '테스트 답안입니다.', 20, 30, '{}'::jsonb)
            RETURNING id
            """,
            (user_id, rubric),
        )
        return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# 1. UP — pre-056 rows survive; 'free_write' now accepted on both tables;
#    invalid values still rejected; constraint names unchanged.
# ---------------------------------------------------------------------------

def test_056_up_preserves_rows_and_widens_both_checks(env, dsn: str, full_dir) -> None:
    # --allow-destructive: the chain to 055 traverses 045 (DROP TABLE), so
    # even the seed-stage up trips migrate.py's gate — same as the 046/049
    # precedent.
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_056, "--allow-destructive", "up"]
    )
    assert rc == 0, f"up --target {PRE_056} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        # Sanity: the pre-056 CHECKs are the narrow 038 shape.
        prompt_def = _check_definition(conn, "ck_writing_prompts_rubric")
        assert "free_write" not in prompt_def
        attempt_def = _check_definition(conn, "ck_writing_attempts_rubric")
        assert "free_write" not in attempt_def

        user = _seed_user(conn, "056-up@example.com")
        pre_prompt_id = _insert_prompt(conn, "topik_ii_53", "056-pre-prompt")
        pre_attempt_id = _insert_attempt(conn, user, "topik_ii_54")

    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0, f"up (through 056) returned {rc}"

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        # Constraint NAMES are unchanged (038's names reused, not replaced) —
        # any other code that references them by name keeps working.
        assert "ck_writing_prompts_rubric" in _constraint_names(conn, "writing_prompts")
        assert "ck_writing_attempts_rubric" in _constraint_names(conn, "writing_attempts")

        # Widened definitions now mention free_write.
        assert "free_write" in _check_definition(conn, "ck_writing_prompts_rubric")
        assert "free_write" in _check_definition(conn, "ck_writing_attempts_rubric")

        # Pre-056 rows survived untouched.
        with conn.cursor() as cur:
            cur.execute(
                "SELECT rubric FROM writing_prompts WHERE id = %s", (pre_prompt_id,)
            )
            assert cur.fetchone()["rubric"] == "topik_ii_53"
            cur.execute(
                "SELECT rubric FROM writing_attempts WHERE id = %s", (pre_attempt_id,)
            )
            assert cur.fetchone()["rubric"] == "topik_ii_54"

        # 'free_write' is now insertable on BOTH tables.
        fw_prompt_id = _insert_prompt(conn, "free_write", "056-fw-prompt")
        with conn.cursor() as cur:
            cur.execute(
                "SELECT rubric FROM writing_prompts WHERE id = %s", (fw_prompt_id,)
            )
            assert cur.fetchone()["rubric"] == "free_write"

        user2 = _seed_user(conn, "056-up-fw@example.com")
        fw_attempt_id = _insert_attempt(conn, user2, "free_write")
        with conn.cursor() as cur:
            cur.execute(
                "SELECT rubric FROM writing_attempts WHERE id = %s", (fw_attempt_id,)
            )
            assert cur.fetchone()["rubric"] == "free_write"

        # NULL is still allowed on writing_prompts (legacy register-drill rows).
        null_prompt_id = _insert_prompt(conn, None, "056-null-prompt")
        with conn.cursor() as cur:
            cur.execute(
                "SELECT rubric FROM writing_prompts WHERE id = %s", (null_prompt_id,)
            )
            assert cur.fetchone()["rubric"] is None

        # An out-of-set value is STILL rejected on both tables — the widen
        # opened exactly one new value, not the column.
        with pytest.raises(psycopg.errors.CheckViolation) as exc:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO writing_prompts "
                    "(source_id, title, prompt_kr, prompt_en, level, rubric) "
                    "VALUES ('056-bogus', 't', 'p', 'p', 'L4'::proficiency_level, 'bogus')"
                )
        assert exc.value.diag.constraint_name == "ck_writing_prompts_rubric"

        with pytest.raises(psycopg.errors.CheckViolation) as exc:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO writing_attempts "
                    "(user_id, rubric, prompt_kr, sample, total_score, max_total, result) "
                    "VALUES (%s, 'bogus', 'p', 's', 1, 1, '{}'::jsonb)",
                    (user,),
                )
        assert exc.value.diag.constraint_name == "ck_writing_attempts_rubric"


# ---------------------------------------------------------------------------
# 2. DOWN — clean path: no free_write rows in play, narrow CHECK restored,
#    re-up is clean.
# ---------------------------------------------------------------------------

def test_056_down_restores_narrow_check_when_no_free_write_rows(
    env, dsn: str, full_dir
) -> None:
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0, f"initial full up returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "056-down-clean@example.com")
        # Only pre-existing-shape rows — no free_write anywhere.
        _insert_prompt(conn, "topik_ii_54", "056-down-clean-prompt")
        _insert_attempt(conn, user, "topik_ii_53")

    # 056's own down body has no DROP TABLE/SCHEMA/DATABASE/TRUNCATE, so this
    # rollback of JUST 056 (target 055) needs no --allow-destructive on its
    # own account — passed anyway for parity with the up calls above.
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_056, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {PRE_056} returned {rc}"

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        # CHECKs restored to the narrow 038 shape.
        assert "free_write" not in _check_definition(conn, "ck_writing_prompts_rubric")
        assert "free_write" not in _check_definition(conn, "ck_writing_attempts_rubric")

        # free_write is rejected again on both tables.
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_prompt(conn, "free_write", "056-down-clean-fw-prompt")
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_attempt(conn, user, "free_write")

    # topik_ii_53/54 still insert cleanly post-rollback (conn above is left in
    # an aborted tx state after the CheckViolations — open a fresh one).
    with psycopg.connect(dsn, autocommit=True) as conn:
        ok_prompt_id = _insert_prompt(conn, "topik_ii_53", "056-down-clean-ok-prompt")
        assert ok_prompt_id > 0
        ok_attempt_id = _insert_attempt(conn, user, "topik_ii_54")
        assert ok_attempt_id > 0

    # Clean re-up: 056 re-applies without incident.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0, f"re-apply of 056 after rollback returned {rc}"
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert "free_write" in _check_definition(conn, "ck_writing_prompts_rubric")
        assert "free_write" in _check_definition(conn, "ck_writing_attempts_rubric")


# ---------------------------------------------------------------------------
# 3. DOWN — honest-gate path: a 'free_write' row already exists → the down
#    must FAIL LOUDLY (CheckViolation → migrate.main() exit code 2), never
#    silently discard the row.
# ---------------------------------------------------------------------------

def test_056_down_fails_loudly_when_a_free_write_prompt_row_exists(
    env, dsn: str, full_dir
) -> None:
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0, f"initial full up returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        fw_prompt_id = _insert_prompt(conn, "free_write", "056-gate-prompt")

    # The rollback must fail — not silently narrow the CHECK past a row that
    # violates it. migrate.py's own contract: a psycopg.Error during apply/
    # rollback returns exit code 2 (SQL execution failure), never a partial
    # commit (ADR-013: body + bookkeeping DELETE share one transaction).
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_056, "--allow-destructive", "down"]
    )
    assert rc == 2, f"expected the CheckViolation to surface as exit 2, got {rc}"

    # Nothing rolled back: bookkeeping still shows 056 applied, the widened
    # CHECK is still in place, and the free_write row is untouched — the
    # failed rollback left NO partial state (single-transaction guarantee).
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM schema_migrations WHERE version = %s", ("056",)
            )
            assert cur.fetchone() is not None, "056 must still be recorded as applied"
        assert "free_write" in _check_definition(conn, "ck_writing_prompts_rubric")
        with conn.cursor() as cur:
            cur.execute(
                "SELECT rubric FROM writing_prompts WHERE id = %s", (fw_prompt_id,)
            )
            assert cur.fetchone()["rubric"] == "free_write"


def test_056_down_fails_loudly_when_a_free_write_attempt_row_exists(
    env, dsn: str, full_dir
) -> None:
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0, f"initial full up returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "056-gate-attempt@example.com")
        fw_attempt_id = _insert_attempt(conn, user, "free_write")

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_056, "--allow-destructive", "down"]
    )
    assert rc == 2, f"expected the CheckViolation to surface as exit 2, got {rc}"

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM schema_migrations WHERE version = %s", ("056",)
            )
            assert cur.fetchone() is not None, "056 must still be recorded as applied"
        with conn.cursor() as cur:
            cur.execute(
                "SELECT rubric FROM writing_attempts WHERE id = %s", (fw_attempt_id,)
            )
            assert cur.fetchone()["rubric"] == "free_write"
