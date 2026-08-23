"""Migration 093 (job_retention_covering_index, audit follow-up B-043) —
real-chain tests.

093 adds a PARTIAL INDEX to each of the three job-ledger tables
(audio_transcription_jobs, story_audio_jobs, story_image_jobs) matching the
retention sweep's predicate: `(user_id, finished_at) WHERE status IN
('done','failed')`. The tests pin the contract: each index exists after up
with the exact partial predicate, a re-applied up body is a no-op
(CREATE INDEX IF NOT EXISTS), and the down drops all three cleanly (a pure
index drop touches zero rows).

Shared fixtures (pg_container/dsn/env/full_dir) come from db/tests/conftest.py.
"""

from __future__ import annotations

import psycopg
from psycopg.rows import tuple_row

from db import migrate  # type: ignore[import-not-found]

PRE_093 = "092"

INDEXES = [
    "ix_audio_transcription_jobs_retention",
    "ix_story_audio_jobs_retention",
    "ix_story_image_jobs_retention",
]


def _full_up(full_dir) -> None:
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0, f"full up returned {rc}"


def _indexdef(conn: psycopg.Connection, name: str) -> str | None:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute("SELECT indexdef FROM pg_indexes WHERE indexname = %s", (name,))
        row = cur.fetchone()
        return row[0] if row else None


def test_093_creates_partial_indexes_with_exact_predicate(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        for name in INDEXES:
            indexdef = _indexdef(conn, name)
            assert indexdef is not None, f"{name} not created"
            # Keyed on user_id + finished_at, partial on the terminal statuses.
            assert "user_id" in indexdef
            assert "finished_at" in indexdef
            normalized = indexdef.replace('"', "").replace(" ", "")
            assert "WHERE(status=ANY" in normalized or "status IN" in indexdef, indexdef
            assert "'done'" in indexdef and "'failed'" in indexdef


def test_093_reapply_up_body_is_noop(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)
    from pathlib import Path

    up_sql = (
        Path(__file__).resolve().parents[1]
        / "migrations"
        / "093_job_retention_covering_index.up.sql"
    ).read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(up_sql)  # must not raise on live indexes
        for name in INDEXES:
            assert _indexdef(conn, name) is not None


def test_093_down_drops_all_three_then_reups(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_093, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {PRE_093} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        for name in INDEXES:
            assert _indexdef(conn, name) is None, f"{name} not dropped"

    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        for name in INDEXES:
            assert _indexdef(conn, name) is not None, f"{name} not restored on re-up"
