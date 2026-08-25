"""Migration 097 (invite_codes + invite_redemptions, Phase 2.3 invite-only
self-signup) — real-chain tests.

WHY THIS FILE EXISTS:
    097 is the storage behind admin-issued invite codes gating self-service
    registration (D1): a hashed-at-rest, admin-issued, single- or multi-use
    `invite_codes` table (mirrors 094_password_reset_tokens' token-hygiene
    discipline) plus an append-only `invite_redemptions` audit. The
    constraints below are SECURITY-LOAD-BEARING (they are what makes the
    server-side atomic consume in server/src/auth/inviteCodes.ts safe) and
    are proven here against a real Postgres-16 testcontainer via
    ``migrate.main()``.

SCOPE:
    - markers: up is non-destructive, down destructive (F-088 classification).
    - up: applies on the full real chain; re-driving the body is a no-op
      (IF NOT EXISTS everywhere).
    - constraints: code_hash shape/uniqueness, expiry CHECK, max_uses CHECK,
      the uses<=max_uses CHECK (positive AND negative probe), note-length
      CHECK, issued_by FK RESTRICT, redemption UNIQUE(invite_code_id,
      user_id) + FK CASCADE both ways.
    - down: refused without --allow-destructive; with it, both tables are
      gone; re-up is clean.

DETERMINISM:
    Mirrors test_migration_094.py — the real migration files are copied into
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

MIGRATION_NUM = "097"

# A well-formed (shape-wise) SHA-256 hex code hash.
HASH_A = "a" * 64
HASH_B = "b" * 64
HASH_C = "c" * 64


def _pre_097_target(full_dir: pathlib.Path) -> str:
    """The version immediately before 097 in the chain actually present
    (numbering may have gaps while sibling branches are in flight)."""
    versions = sorted(
        {f.name[:3] for f in full_dir.iterdir() if f.suffix == ".sql"}
    )
    idx = versions.index(MIGRATION_NUM)
    assert idx > 0, "097 cannot be the first migration"
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


def _insert_code(
    conn: psycopg.Connection,
    admin_id: int,
    code_hash: str = HASH_A,
    *,
    max_uses: int = 1,
    uses: int = 0,
    email: str | None = None,
    expires_sql: str | None = None,
) -> int:
    expires_expr = "NULL" if expires_sql is None else expires_sql
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO invite_codes "
            "(code_hash, issued_by_user_id, email, max_uses, uses, expires_at) "
            f"VALUES (%s, %s, %s, %s, %s, {expires_expr}) RETURNING id",
            (code_hash, admin_id, email, max_uses, uses),
        )
        return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# 1. F-088 marker classification.
# ---------------------------------------------------------------------------


def test_097_marker_classification() -> None:
    up_sql = (REAL_MIGRATIONS_DIR / "097_invite_codes.up.sql").read_text(encoding="utf-8")
    down_sql = (REAL_MIGRATIONS_DIR / "097_invite_codes.down.sql").read_text(encoding="utf-8")
    assert migrate.explicit_destructiveness(up_sql) is False
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — applies on the real chain; re-driving the body is a no-op.
# ---------------------------------------------------------------------------


def test_097_up_applies_and_reapply_is_idempotent(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)

    up_sql = (REAL_MIGRATIONS_DIR / "097_invite_codes.up.sql").read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        # Drive the body a second time directly (the runner skips an applied
        # version): CREATE TABLE/INDEX IF NOT EXISTS must all be re-runnable.
        with conn.cursor() as cur:
            cur.execute(up_sql)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM invite_codes")
            assert cur.fetchone()[0] == 0
            cur.execute("SELECT count(*) FROM invite_redemptions")
            assert cur.fetchone()[0] == 0
            for table, index_name in (
                ("invite_codes", "ix_invite_codes_created_at"),
                ("invite_redemptions", "ix_invite_redemptions_code"),
            ):
                cur.execute(
                    """
                    SELECT count(*) FROM pg_indexes
                     WHERE tablename = %s AND indexname = %s
                    """,
                    (table, index_name),
                )
                assert cur.fetchone()[0] == 1, f"missing index {index_name}"


# ---------------------------------------------------------------------------
# 3. invite_codes constraints — each guard proven by the write it rejects.
# ---------------------------------------------------------------------------


def test_097_invite_codes_constraints(env, dsn: str, full_dir: pathlib.Path) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        admin_id = _seed_user(conn, "admin@test.dev")

        # Well-formed insert passes.
        code_id = _insert_code(conn, admin_id, HASH_A)

        # ck_invite_codes_code_hash_shape: only SHA-256 hex ever lands at
        # rest — a raw (base64url) code accidentally stored verbatim is
        # rejected.
        with pytest.raises(errors.CheckViolation):
            _insert_code(conn, admin_id, "NotAHexHash_" + "x" * 52)

        # uq_invite_codes_code_hash: code hashes are globally unique.
        with pytest.raises(errors.UniqueViolation):
            _insert_code(conn, admin_id, HASH_A)

        # ck_invite_codes_expiry: a code can never be born expired.
        with pytest.raises(errors.CheckViolation):
            _insert_code(
                conn, admin_id, HASH_B, expires_sql="now() - interval '1 hour'"
            )

        # ck_invite_codes_max_uses: max_uses must be >= 1.
        with pytest.raises(errors.CheckViolation):
            _insert_code(conn, admin_id, HASH_B, max_uses=0)

        # ck_invite_codes_uses — negative probe: uses can never exceed
        # max_uses, whether set at INSERT time or via a later UPDATE (the
        # shape the server's atomic consume UPDATE would otherwise rely on
        # alone). `code_id` is the default max_uses=1 code seeded above (uses
        # still 0): the first increment (0 -> 1) is legal exhaustion, a
        # SECOND increment (1 -> 2) is what the CHECK must reject.
        with pytest.raises(errors.CheckViolation):
            _insert_code(conn, admin_id, HASH_B, max_uses=1, uses=2)
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE invite_codes SET uses = uses + 1 WHERE id = %s",
                (code_id,),
            )
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE invite_codes SET uses = uses + 1 WHERE id = %s",
                    (code_id,),
                )
        # ck_invite_codes_uses — positive probe: a multi-use code can climb
        # up to (but not past) max_uses.
        multi_id = _insert_code(conn, admin_id, HASH_B, max_uses=3, uses=0)
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE invite_codes SET uses = 3 WHERE id = %s", (multi_id,)
            )
            with pytest.raises(errors.CheckViolation):
                cur.execute(
                    "UPDATE invite_codes SET uses = 4 WHERE id = %s", (multi_id,)
                )

        # ck_invite_codes_note_length: a note over 500 chars is rejected.
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO invite_codes (code_hash, issued_by_user_id, note) "
                    "VALUES (%s, %s, %s)",
                    (HASH_C, admin_id, "x" * 501),
                )

        # email binding: CITEXT case-insensitive comparison is usable by the
        # server's redemption query.
        bound_id = _insert_code(
            conn, admin_id, "d" * 64, email="Jane@Example.com"
        )
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT count(*) FROM invite_codes "
                "WHERE id = %s AND email = %s::citext",
                (bound_id, "jane@example.com"),
            )
            assert cur.fetchone()[0] == 1

        # fk_invite_codes_issued_by ON DELETE RESTRICT: the issuing admin
        # cannot be deleted while they have outstanding issued codes — the
        # issuance audit trail must survive.
        with pytest.raises(errors.ForeignKeyViolation):
            with conn.cursor() as cur:
                cur.execute("DELETE FROM users WHERE id = %s", (admin_id,))


# ---------------------------------------------------------------------------
# 4. invite_redemptions constraints.
# ---------------------------------------------------------------------------


def test_097_invite_redemptions_constraints(env, dsn: str, full_dir: pathlib.Path) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        admin_id = _seed_user(conn, "admin2@test.dev")
        user_id = _seed_user(conn, "redeemer@test.dev")
        code_id = _insert_code(conn, admin_id, HASH_A, max_uses=3)

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "INSERT INTO invite_redemptions (invite_code_id, user_id) "
                "VALUES (%s, %s) RETURNING id",
                (code_id, user_id),
            )
            assert cur.fetchone() is not None

        # uq_invite_redemptions_code_user: the same user cannot redeem the
        # same code twice.
        with pytest.raises(errors.UniqueViolation):
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO invite_redemptions (invite_code_id, user_id) "
                    "VALUES (%s, %s)",
                    (code_id, user_id),
                )

        # FK CASCADE from invite_codes: deleting the code takes its
        # redemption audit rows with it.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("DELETE FROM invite_codes WHERE id = %s", (code_id,))
            cur.execute("SELECT count(*) FROM invite_redemptions")
            assert cur.fetchone()[0] == 0

        # FK CASCADE from users: deleting the redeeming user takes their
        # redemption rows with it too.
        code2_id = _insert_code(conn, admin_id, HASH_B, max_uses=3)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "INSERT INTO invite_redemptions (invite_code_id, user_id) "
                "VALUES (%s, %s)",
                (code2_id, user_id),
            )
            cur.execute("DELETE FROM users WHERE id = %s", (user_id,))
            cur.execute("SELECT count(*) FROM invite_redemptions")
            assert cur.fetchone()[0] == 0


# ---------------------------------------------------------------------------
# 5. DOWN — destructive gate; both tables gone; re-up clean.
# ---------------------------------------------------------------------------


def test_097_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    target = _pre_097_target(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        admin_id = _seed_user(conn, "down-admin@test.dev")
        user_id = _seed_user(conn, "down-user@test.dev")
        code_id = _insert_code(conn, admin_id, HASH_A)
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO invite_redemptions (invite_code_id, user_id) "
                "VALUES (%s, %s)",
                (code_id, user_id),
            )

    # Refused without the flag (DROP TABLE + explicit destructive marker).
    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", target, "down"])
    assert rc != 0, "097.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", target, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {target} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT to_regclass('public.invite_redemptions')")
            assert cur.fetchone()[0] is None, "invite_redemptions must be gone after down"
            cur.execute("SELECT to_regclass('public.invite_codes')")
            assert cur.fetchone()[0] is None, "invite_codes must be gone after down"

    # Round trip: re-up rebuilds both tables cleanly.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM invite_codes")
            assert cur.fetchone()[0] == 0
            cur.execute("SELECT count(*) FROM invite_redemptions")
            assert cur.fetchone()[0] == 0
