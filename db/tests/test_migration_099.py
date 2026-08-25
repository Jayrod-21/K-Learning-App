"""Migrations 099/100 (book_uploads async ingest, Phase 2.5 OOM fix) —
real-chain tests.

WHY THIS FILE EXISTS:
    099 turns `book_uploads` into the queue for its own ingest job (adds the
    'pending' status value + started_at/finished_at/error/raw_blob_ref); 100
    adds the partial claim index the runner's poll depends on. They are two
    migration FILES (not one) because a newly ADDed enum value cannot be USED
    — including in an index predicate — in the same transaction that added
    it (the exact gotcha 072/021/016 document for their own enum adds); 100
    exercises that 'pending' really is usable once 099 has committed. Both are
    proven together here, against a real Postgres-16 testcontainer via
    ``migrate.main()``, mirroring test_migration_098.py's shape.

SCOPE:
    - markers: 099.up/100.up non-destructive, 099.down destructive,
      100.down non-destructive (F-088 classification).
    - up: applies on the full real chain; re-driving each body is a no-op
      (IF NOT EXISTS everywhere).
    - new columns + the partial index exist after up; the index is usable
      with a real 'pending' row (proves the enum-gotcha split actually works,
      not just that the DDL ran).
    - constraints: error-length CHECK, raw_blob_ref-length CHECK.
    - down: refused without --allow-destructive; with it, 099's columns are
      gone (100's index already down first since it targets a later state);
      re-up is clean. The 'pending' enum value is NOT removed by down (no
      DROP VALUE in Postgres) — documented, not a bug.

DETERMINISM:
    Mirrors test_migration_098.py — the real migration files are copied into
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

MIGRATION_099 = "099"
MIGRATION_100 = "100"


def _pre_target(full_dir: pathlib.Path, migration_num: str) -> str:
    """The version immediately before `migration_num` in the chain actually
    present (numbering may have gaps while sibling branches are in flight)."""
    versions = sorted(
        {f.name[:3] for f in full_dir.iterdir() if f.suffix == ".sql"}
    )
    idx = versions.index(migration_num)
    assert idx > 0, f"{migration_num} cannot be the first migration"
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


def _seed_pending_upload(conn: psycopg.Connection, user_id: int, title: str = "My Book") -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO book_uploads (user_id, title, type, status, byte_size, raw_blob_ref)
            VALUES (%s, %s, 'vocab', 'pending', 1024, %s)
            RETURNING id
            """,
            (user_id, title, f"raw/{user_id}/00000000-0000-0000-0000-000000000000.bin"),
        )
        return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# 1. F-088 marker classification.
# ---------------------------------------------------------------------------


def test_099_100_marker_classification() -> None:
    up_099 = (REAL_MIGRATIONS_DIR / "099_book_upload_async_ingest.up.sql").read_text(
        encoding="utf-8"
    )
    down_099 = (REAL_MIGRATIONS_DIR / "099_book_upload_async_ingest.down.sql").read_text(
        encoding="utf-8"
    )
    up_100 = (REAL_MIGRATIONS_DIR / "100_book_upload_pending_claim_index.up.sql").read_text(
        encoding="utf-8"
    )
    down_100 = (REAL_MIGRATIONS_DIR / "100_book_upload_pending_claim_index.down.sql").read_text(
        encoding="utf-8"
    )
    assert migrate.explicit_destructiveness(up_099) is False
    assert migrate.explicit_destructiveness(down_099) is True
    assert migrate.contains_destructive(down_099)
    assert migrate.explicit_destructiveness(up_100) is False
    assert migrate.explicit_destructiveness(down_100) is False
    assert not migrate.contains_destructive(down_100)


# ---------------------------------------------------------------------------
# 2. UP — applies on the real chain; re-driving each body is a no-op; the
#    partial index actually works with a real 'pending' row (proves the
#    099/100 split resolved the enum-gotcha, not just that DDL ran clean).
# ---------------------------------------------------------------------------


def test_099_100_up_applies_and_reapply_is_idempotent(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)

    up_099 = (REAL_MIGRATIONS_DIR / "099_book_upload_async_ingest.up.sql").read_text(
        encoding="utf-8"
    )
    up_100 = (REAL_MIGRATIONS_DIR / "100_book_upload_pending_claim_index.up.sql").read_text(
        encoding="utf-8"
    )
    with psycopg.connect(dsn, autocommit=True) as conn:
        # Drive each body a second time directly (the runner skips an applied
        # version): every ADD COLUMN/CONSTRAINT/INDEX must be re-runnable.
        with conn.cursor() as cur:
            cur.execute(up_099)
            cur.execute(up_100)

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                SELECT column_name, is_nullable
                  FROM information_schema.columns
                 WHERE table_name = 'book_uploads'
                   AND column_name IN ('started_at', 'finished_at', 'error', 'raw_blob_ref')
                 ORDER BY column_name
                """
            )
            cols = {row[0]: row[1] for row in cur.fetchall()}
            assert cols == {
                "started_at": "YES",
                "finished_at": "YES",
                "error": "YES",
                "raw_blob_ref": "YES",
            }

            # The enum value exists and is usable NOW (099 has fully
            # committed by this point in a later, separate connection).
            cur.execute(
                "SELECT 'pending'::book_upload_status"
            )
            assert cur.fetchone()[0] == "pending"

            # The partial index exists.
            cur.execute(
                "SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_book_uploads_pending_claim'"
            )
            row = cur.fetchone()
            assert row is not None
            assert "status = 'pending'::book_upload_status" in row[0]

        # The index is actually usable for the runner's claim query, not just
        # present: seed a user + a real 'pending' row and drive the exact
        # claim shape bookIngestRunner.ts uses.
        user_id = _seed_user(conn, "claimer@test.dev")
        upload_id = _seed_pending_upload(conn, user_id)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                SELECT id FROM book_uploads
                 WHERE status = 'pending'
                 ORDER BY created_at, id
                 FOR UPDATE SKIP LOCKED
                 LIMIT 1
                """
            )
            claimed = cur.fetchone()
            assert claimed is not None
            assert claimed[0] == upload_id


# ---------------------------------------------------------------------------
# 3. Constraints — each guard proven by the write it rejects.
# ---------------------------------------------------------------------------


def test_099_constraints(env, dsn: str, full_dir: pathlib.Path) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "learner@test.dev")

        # Well-formed pending row passes.
        upload_id = _seed_pending_upload(conn, user_id)
        assert upload_id is not None

        # ck_book_uploads_error_len: error must be <= 2000 chars (NULL is fine).
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE book_uploads SET status = 'failed', error = %s WHERE id = %s",
                ("x" * 2000, upload_id),
            )
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE book_uploads SET error = %s WHERE id = %s",
                    ("x" * 2001, upload_id),
                )

        # ck_book_uploads_raw_blob_ref_len: 1..1024 chars (NULL is fine — the
        # settled row above still carries its original raw_blob_ref; clear it
        # first to prove NULL passes, mirroring the runner's settle-clears-it
        # contract).
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE book_uploads SET raw_blob_ref = NULL WHERE id = %s", (upload_id,)
            )
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE book_uploads SET raw_blob_ref = %s WHERE id = %s",
                    ("", upload_id),
                )
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE book_uploads SET raw_blob_ref = %s WHERE id = %s",
                    ("x" * 1025, upload_id),
                )


# ---------------------------------------------------------------------------
# 4. DOWN — destructive gate on 099; index (100) reverses first; re-up clean.
# ---------------------------------------------------------------------------


def test_100_down_reverses_cleanly_then_099_down_requires_allow_destructive(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    target_before_100 = _pre_target(full_dir, MIGRATION_100)  # == "099"
    target_before_099 = _pre_target(full_dir, MIGRATION_099)

    # `_up` applies the WHOLE real chain, which may include migrations layered
    # ON TOP of 100 (e.g. 101 generated_items, whose down is a destructive
    # DROP TABLE). Bring the chain down to exactly 100 first, with the flag,
    # so the 100->099 assertions below test 100's OWN down in isolation
    # regardless of what later migrations exist — otherwise a later migration's
    # destructive down would refuse the deliberately-un-flagged `down` below and
    # this test would break every time a new migration lands. A no-op (rc 0)
    # when 100 is already the top of the chain.
    rc = migrate.main(
        [
            "--migrations-dir",
            str(full_dir),
            "--target",
            MIGRATION_100,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"pre-step: down to {MIGRATION_100} (dropping any later migrations) returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "down-user@test.dev")
        _seed_pending_upload(conn, user_id)

    # 100's down (index-only) is non-destructive — no flag needed.
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", target_before_100, "down"]
    )
    assert rc == 0, f"down to {target_before_100} (dropping 100) returned {rc}"
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT 1 FROM pg_indexes WHERE indexname = 'ix_book_uploads_pending_claim'"
            )
            assert cur.fetchone() is None

    # 099's down (drops columns) IS destructive — refused without the flag.
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", target_before_099, "down"]
    )
    assert rc != 0, "099.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        [
            "--migrations-dir",
            str(full_dir),
            "--target",
            target_before_099,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {target_before_099} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                SELECT column_name FROM information_schema.columns
                 WHERE table_name = 'book_uploads'
                   AND column_name IN ('started_at', 'finished_at', 'error', 'raw_blob_ref')
                """
            )
            assert cur.fetchall() == []

    # Round trip: re-up rebuilds everything cleanly.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                SELECT count(*) FROM information_schema.columns
                 WHERE table_name = 'book_uploads'
                   AND column_name IN ('started_at', 'finished_at', 'error', 'raw_blob_ref')
                """
            )
            assert cur.fetchone()[0] == 4
