"""Migration 094 (password_reset_tokens, Phase 2.1 account recovery) —
real-chain tests.

WHY THIS FILE EXISTS:
    094 is the storage behind self-service password reset: the hashed-at-rest,
    expiring, single-use token table backing "forgot password". It mirrors
    071 (email_verification_tokens) minus the address-attestation column (a
    reset token attests a USER, not an address — see the up header). The
    token-hygiene constraints below are SECURITY-LOAD-BEARING and proven here
    against a real Postgres-16 testcontainer via ``migrate.main()``.

SCOPE:
    - markers: up is non-destructive, down destructive (F-088 classification).
    - up: applies on the full real chain; re-driving the body is a no-op
      (IF NOT EXISTS everywhere).
    - constraints: token_hash shape/uniqueness, expiry CHECK, FK CASCADE.
    - down: refused without --allow-destructive; with it, the table is gone;
      re-up is clean.

DETERMINISM:
    Mirrors test_migration_071.py — the real migration files are copied into
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

MIGRATION_NUM = "094"

# A well-formed (shape-wise) SHA-256 hex token hash.
HASH_A = "a" * 64
HASH_B = "b" * 64


def _pre_094_target(full_dir: pathlib.Path) -> str:
    """The version immediately before 094 in the chain actually present
    (numbering may have gaps while sibling branches are in flight)."""
    versions = sorted(
        {f.name[:3] for f in full_dir.iterdir() if f.suffix == ".sql"}
    )
    idx = versions.index(MIGRATION_NUM)
    assert idx > 0, "094 cannot be the first migration"
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


def _insert_token(
    conn: psycopg.Connection,
    user_id: int,
    token_hash: str = HASH_A,
    expires_sql: str = "now() + interval '1 hour'",
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) "
            f"VALUES (%s, %s, {expires_sql}) RETURNING id",
            (user_id, token_hash),
        )
        return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# 1. F-088 marker classification.
# ---------------------------------------------------------------------------


def test_094_marker_classification() -> None:
    up_sql = (
        REAL_MIGRATIONS_DIR / "094_password_reset_tokens.up.sql"
    ).read_text(encoding="utf-8")
    down_sql = (
        REAL_MIGRATIONS_DIR / "094_password_reset_tokens.down.sql"
    ).read_text(encoding="utf-8")
    assert migrate.explicit_destructiveness(up_sql) is False
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — applies on the real chain; re-driving the body is a no-op.
# ---------------------------------------------------------------------------


def test_094_up_applies_and_reapply_is_idempotent(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)

    up_sql = (
        REAL_MIGRATIONS_DIR / "094_password_reset_tokens.up.sql"
    ).read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        # Drive the body a second time directly (the runner skips an applied
        # version): CREATE TABLE/INDEX IF NOT EXISTS must all be re-runnable.
        with conn.cursor() as cur:
            cur.execute(up_sql)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM password_reset_tokens")
            assert cur.fetchone()[0] == 0
            for index_name in (
                "ix_password_reset_user",
                "ix_password_reset_expires",
            ):
                cur.execute(
                    """
                    SELECT count(*) FROM pg_indexes
                     WHERE tablename = 'password_reset_tokens'
                       AND indexname = %s
                    """,
                    (index_name,),
                )
                assert cur.fetchone()[0] == 1, f"missing index {index_name}"
            # No address-attestation column — unlike email_verification_tokens,
            # a reset token attests a USER (see the up header). Guard against
            # regression accidentally reintroducing one.
            cur.execute(
                """
                SELECT count(*) FROM information_schema.columns
                 WHERE table_name = 'password_reset_tokens'
                   AND column_name = 'email'
                """
            )
            assert cur.fetchone()[0] == 0, (
                "password_reset_tokens must NOT carry an email column — a "
                "reset token attests a user, not an address"
            )


# ---------------------------------------------------------------------------
# 3. Token-hygiene constraints — each guard proven by the write it rejects.
# ---------------------------------------------------------------------------


def test_094_token_constraints(env, dsn: str, full_dir: pathlib.Path) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "reset@test.dev")

        # Well-formed insert passes.
        _insert_token(conn, user_id, HASH_A)

        # ck_password_reset_token_shape: only SHA-256 hex ever lands at rest —
        # a raw (base64url) token accidentally stored verbatim is rejected.
        with pytest.raises(errors.CheckViolation):
            _insert_token(conn, user_id, "NotAHexHash_" + "x" * 52)

        # uq_password_reset_token_hash: token hashes are globally unique.
        with pytest.raises(errors.UniqueViolation):
            _insert_token(conn, user_id, HASH_A)

        # ck_password_reset_expiry: a token can never be born expired.
        with pytest.raises(errors.CheckViolation):
            _insert_token(conn, user_id, HASH_B, expires_sql="now() - interval '1 hour'")

        # FK CASCADE: tokens are transient — a deleted user takes them along.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (user_id,))
            cur.execute("SELECT count(*) FROM password_reset_tokens")
            assert cur.fetchone()[0] == 0


# ---------------------------------------------------------------------------
# 4. DOWN — destructive gate; table gone; re-up clean.
# ---------------------------------------------------------------------------


def test_094_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    target = _pre_094_target(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "down@test.dev")
        _insert_token(conn, user_id, HASH_A)

    # Refused without the flag (DROP TABLE + explicit destructive marker).
    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", target, "down"])
    assert rc != 0, "094.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", target, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {target} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT to_regclass('public.password_reset_tokens')")
            assert cur.fetchone()[0] is None, "table must be gone after down"

    # Round trip: re-up rebuilds the table cleanly.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM password_reset_tokens")
            assert cur.fetchone()[0] == 0
