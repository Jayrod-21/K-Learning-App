"""Migration 071 (email_verification_tokens, ticket F-006) — real-chain tests.

WHY THIS FILE EXISTS:
    071 is the storage behind email verification (F-006): the hashed-at-rest,
    expiring, single-use token table plus the ONE-WAY grandfathering backfill
    of users.email_verified_at (a column 001 created but nothing wrote until
    now). Two behaviors are SECURITY-LOAD-BEARING and proven here against a
    real Postgres-16 testcontainer via ``migrate.main()``:
      * the token-hygiene constraints (hash shape, expiry sanity, uniqueness,
        user-CASCADE) reject the writes they must reject; and
      * the backfill stamps ONLY the pre-existing NULL rows (it can never
        overwrite a real verification timestamp), because without it the
        login gate this feature ships (EMAIL_VERIFICATION_REQUIRED, default
        ON) would lock every pre-F-006 account out at its next login.

SCOPE:
    - markers: up is non-destructive, down destructive (F-088 classification).
    - up: applies on the full real chain; re-driving the body is a no-op
      (IF NOT EXISTS everywhere; the backfill UPDATE only fills NULLs).
    - constraints: token_hash shape/uniqueness, expiry CHECK, FK CASCADE.
    - backfill: chain-to-070 → seed a NULL-stamp user and a pre-stamped user →
      apply 071 → the NULL row is stamped with created_at, the pre-stamped
      row is UNTOUCHED.
    - down: refused without --allow-destructive; with it, the table is gone
      but the backfilled stamps REMAIN (documented one-way decision — the up
      header explains why un-stamping would be data loss); re-up is clean.

DETERMINISM:
    Mirrors test_migration_069.py — the real migration files are copied into
    tmp_path-scoped directories and the runner is pointed at them via
    ``--migrations-dir``; the ``dsn`` fixture gives each test a fresh schema.
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

MIGRATION_NUM = "071"

# A syntactically valid argon2id-shaped hash satisfying
# ck_users_password_hash_argon2id (LIKE '$argon2id$%', length 80..255).
FAKE_HASH = "$argon2id$" + "x" * 70

# A well-formed (shape-wise) SHA-256 hex token hash.
HASH_A = "a" * 64
HASH_B = "b" * 64


# ---------------------------------------------------------------------------
# Fixtures — one container per session, a fresh DB + migration dirs per test
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


@pytest.fixture()
def pre_071_dir(tmp_path: pathlib.Path) -> pathlib.Path:
    """Every migration BEFORE 071 — the backfill test seeds users on this
    chain state, then applies the full dir so 071 (alone) runs on top."""
    d = tmp_path / "migrations_pre_071"
    d.mkdir(parents=True)
    for src in REAL_MIGRATIONS_DIR.iterdir():
        if src.suffix == ".sql" and src.is_file() and src.name[:3] < MIGRATION_NUM:
            shutil.copy2(src, d / src.name)
    return d


def _pre_071_target(full_dir: pathlib.Path) -> str:
    """The version immediately before 071 in the chain actually present
    (numbering may have gaps while sibling branches are in flight)."""
    versions = sorted(
        {f.name[:3] for f in full_dir.iterdir() if f.suffix == ".sql"}
    )
    idx = versions.index(MIGRATION_NUM)
    assert idx > 0, "071 cannot be the first migration"
    return versions[idx - 1]


def _up(directory: pathlib.Path) -> None:
    # --allow-destructive: migration 045 (hygiene_cleanup, DROP TABLE) sits in
    # the chain, so a full `up` trips migrate.py's destructive gate without it.
    rc = migrate.main(["--migrations-dir", str(directory), "--allow-destructive", "up"])
    assert rc == 0, f"up returned {rc}"


def _seed_user(
    conn: psycopg.Connection, email: str, *, verified_at_sql: str | None = None
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO users (email, password_hash, email_verified_at) "
            "VALUES (%s, %s, "
            + (verified_at_sql if verified_at_sql is not None else "NULL")
            + ") RETURNING id",
            (email, FAKE_HASH),
        )
        return cur.fetchone()[0]


def _insert_token(
    conn: psycopg.Connection,
    user_id: int,
    token_hash: str = HASH_A,
    expires_sql: str = "now() + interval '24 hours'",
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) "
            f"VALUES (%s, %s, {expires_sql}) RETURNING id",
            (user_id, token_hash),
        )
        return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# 1. F-088 marker classification.
# ---------------------------------------------------------------------------

def test_071_marker_classification() -> None:
    up_sql = (
        REAL_MIGRATIONS_DIR / "071_email_verification_tokens.up.sql"
    ).read_text(encoding="utf-8")
    down_sql = (
        REAL_MIGRATIONS_DIR / "071_email_verification_tokens.down.sql"
    ).read_text(encoding="utf-8")
    assert migrate.explicit_destructiveness(up_sql) is False
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — applies on the real chain; re-driving the body is a no-op.
# ---------------------------------------------------------------------------

def test_071_up_applies_and_reapply_is_idempotent(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)

    up_sql = (
        REAL_MIGRATIONS_DIR / "071_email_verification_tokens.up.sql"
    ).read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        # Drive the body a second time directly (the runner skips an applied
        # version): CREATE TABLE/INDEX IF NOT EXISTS + the fills-NULLs-only
        # UPDATE must all be re-runnable.
        with conn.cursor() as cur:
            cur.execute(up_sql)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM email_verification_tokens")
            assert cur.fetchone()[0] == 0
            for index_name in (
                "ix_email_verif_active_lookup",
                "ix_email_verif_user",
                "ix_email_verif_expires",
            ):
                cur.execute(
                    """
                    SELECT count(*) FROM pg_indexes
                     WHERE tablename = 'email_verification_tokens'
                       AND indexname = %s
                    """,
                    (index_name,),
                )
                assert cur.fetchone()[0] == 1, f"missing index {index_name}"
            # The active-lookup index is PARTIAL (live tokens only).
            cur.execute(
                """
                SELECT indexdef FROM pg_indexes
                 WHERE indexname = 'ix_email_verif_active_lookup'
                """
            )
            indexdef = cur.fetchone()[0]
            assert "consumed_at IS NULL" in indexdef
            assert "invalidated_at IS NULL" in indexdef


# ---------------------------------------------------------------------------
# 3. Token-hygiene constraints — each guard proven by the write it rejects.
# ---------------------------------------------------------------------------

def test_071_token_constraints(env, dsn: str, full_dir: pathlib.Path) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "tokens@test.dev")

        # Well-formed insert passes.
        _insert_token(conn, user_id, HASH_A)

        # ck_email_verif_token_shape: only SHA-256 hex ever lands at rest —
        # a raw (base64url) token accidentally stored verbatim is rejected.
        with pytest.raises(errors.CheckViolation):
            _insert_token(conn, user_id, "NotAHexHash_" + "x" * 52)

        # uq_email_verif_token_hash: token hashes are globally unique.
        with pytest.raises(errors.UniqueViolation):
            _insert_token(conn, user_id, HASH_A)

        # ck_email_verif_expiry: a token can never be born expired.
        with pytest.raises(errors.CheckViolation):
            _insert_token(conn, user_id, HASH_B, expires_sql="now() - interval '1 hour'")

        # FK CASCADE: tokens are transient — a deleted user takes them along.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (user_id,))
            cur.execute("SELECT count(*) FROM email_verification_tokens")
            assert cur.fetchone()[0] == 0


# ---------------------------------------------------------------------------
# 4. Backfill — pre-existing NULL rows are grandfathered; real stamps are
#    never overwritten.
# ---------------------------------------------------------------------------

def test_071_backfill_grandfathers_nulls_and_preserves_existing_stamps(
    env, dsn: str, full_dir: pathlib.Path, pre_071_dir: pathlib.Path
) -> None:
    # Chain state BEFORE 071 — this is what a live deploy looks like.
    _up(pre_071_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        legacy_id = _seed_user(conn, "legacy@test.dev")  # NULL stamp
        stamped_id = _seed_user(
            conn,
            "stamped@test.dev",
            verified_at_sql="'2020-01-02T03:04:05Z'::timestamptz",
        )

    # Apply the rest of the chain (071 runs on top of the seeded rows).
    _up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                SELECT email_verified_at IS NOT NULL,
                       email_verified_at = created_at
                  FROM users WHERE id = %s
                """,
                (legacy_id,),
            )
            is_stamped, equals_created = cur.fetchone()
            assert is_stamped, "pre-existing account must be grandfathered"
            assert equals_created, "backfill stamps with created_at (provisioning time)"

            cur.execute(
                "SELECT email_verified_at::text FROM users WHERE id = %s",
                (stamped_id,),
            )
            assert cur.fetchone()[0].startswith("2020-01-02"), (
                "an existing verification stamp must NEVER be overwritten"
            )


# ---------------------------------------------------------------------------
# 5. DOWN — destructive gate; table gone; backfill deliberately NOT reversed;
#    re-up clean.
# ---------------------------------------------------------------------------

def test_071_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    target = _pre_071_target(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "down@test.dev")  # stamped by… nothing: post-071 insert
        with conn.cursor(row_factory=tuple_row) as cur:
            # Grandfather stamp exists only for pre-071 rows; stamp this one
            # explicitly so we can prove the down leaves users untouched.
            cur.execute(
                "UPDATE users SET email_verified_at = now() WHERE id = %s", (user_id,)
            )
        _insert_token(conn, user_id, HASH_A)

    # Refused without the flag (DROP TABLE + explicit destructive marker).
    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", target, "down"])
    assert rc != 0, "071.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", target, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {target} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT to_regclass('public.email_verification_tokens')")
            assert cur.fetchone()[0] is None, "table must be gone after down"
            # ONE-WAY by design: the down never un-stamps users (see the up
            # header — reversing would destroy real verification state).
            cur.execute(
                "SELECT email_verified_at IS NOT NULL FROM users WHERE id = %s",
                (user_id,),
            )
            assert cur.fetchone()[0], "down must not touch users.email_verified_at"

    # Round trip: re-up rebuilds the table (and the backfill no-ops on the
    # already-stamped row).
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM email_verification_tokens")
            assert cur.fetchone()[0] == 0
