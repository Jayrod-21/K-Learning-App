"""Migration 090 (audio_transcription_jobs_running_index, audit Phase 0.1)
— real-chain tests.

WHY THIS FILE EXISTS:
    090 adds a PARTIAL INDEX `ix_audio_transcription_jobs_running` on
    `audio_transcription_jobs (started_at) WHERE status = 'running'` — the
    exact predicate the A1 worker's stale-job reaper (`tools/audio_stt/
    worker.py` `reap_stale`) runs on every claim poll. The tests pin the
    contract: the index exists after up (with the exact partial predicate),
    the planner is willing to use it for the reaper's query shape, a manual
    re-apply of the up body is a no-op (`CREATE INDEX IF NOT EXISTS`), and
    the down migration drops it cleanly with no data loss (a pure index
    drop touches zero rows).

DETERMINISM:
    Mirrors test_migration_089.py — the real migration files are copied
    into a tmp_path-scoped directory and the runner is pointed at it via
    ``--migrations-dir``; the ``dsn`` fixture gives each test a fresh schema.
"""

from __future__ import annotations

import pathlib
import shutil

import psycopg
import pytest
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

# The migration immediately before 090. `down --target PRE_090` rolls back
# ONLY 090.
PRE_090 = "089"

FAKE_HASH = "$argon2id$" + "x" * 70

INDEX_NAME = "ix_audio_transcription_jobs_running"


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
# Seed helpers
# ---------------------------------------------------------------------------

def _seed_user(conn: psycopg.Connection, email: str = "reaper-090@test.local") -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id",
            (email, FAKE_HASH),
        )
        return cur.fetchone()[0]


def _seed_running_job(
    conn: psycopg.Connection, user_id: int, minutes_ago: int = 60
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO audio_transcription_jobs
                (user_id, status, charged_bytes, started_at)
            VALUES (%s, 'running'::audio_transcription_status, 1024,
                    now() - make_interval(mins => %s))
            RETURNING id
            """,
            (user_id, minutes_ago),
        )
        return cur.fetchone()[0]


def _index_definition(conn: psycopg.Connection, index_name: str) -> str | None:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute("SELECT indexdef FROM pg_indexes WHERE indexname = %s", (index_name,))
        row = cur.fetchone()
        return row[0] if row else None


# ---------------------------------------------------------------------------
# 1. UP — index exists, partial predicate is exactly status = 'running'
# ---------------------------------------------------------------------------

def test_090_index_created_with_exact_partial_predicate(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        indexdef = _index_definition(conn, INDEX_NAME)
        assert indexdef is not None
        assert "started_at" in indexdef
        assert "status = 'running'" in indexdef.replace('"', "")


def test_090_planner_can_use_the_index_for_the_reaper_predicate(
    env, dsn: str, full_dir
) -> None:
    """Mirrors the exact WHERE clause tools/audio_stt/worker.py reap_stale
    runs on every claim poll — the query this index exists to serve."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        # A tiny handful of rows would let a Seq Scan win on cost alone
        # regardless of any index — expected, correct planner behavior, not
        # evidence the index is unusable. To actually exercise the index's
        # SHAPE (keyed on started_at, so a range predicate can seek instead
        # of scanning every 'running' row), seed a wider spread: most rows
        # are RECENT (started_at within the last 5 minutes -- healthy,
        # in-flight jobs the reaper's threshold must skip), and only a
        # handful are STALE (started_at over an hour ago -- what the reaper
        # is actually looking for). A range-ordered scan on started_at can
        # seek straight past the recent majority; audio_transcription_jobs'
        # OTHER partial index (uq_audio_transcription_jobs_track_live, 076,
        # keyed on track_id, no ordering on started_at) cannot -- it would
        # have to scan+filter every 'running' row. This selectivity, not a
        # forced planner setting, is what makes this migration's index the
        # genuinely cheaper choice, matching the real reaper's workload
        # (mostly-healthy running jobs, a rare stale one).
        for _ in range(300):
            _seed_running_job(conn, user_id, minutes_ago=1)
        for _ in range(5):
            _seed_running_job(conn, user_id, minutes_ago=120)
        with conn.cursor() as cur:
            cur.execute("ANALYZE audio_transcription_jobs")

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                EXPLAIN
                SELECT id FROM audio_transcription_jobs
                 WHERE status = 'running'
                   AND started_at < now() - make_interval(mins => 60)
                """
            )
            plan = "\n".join(row[0] for row in cur.fetchall())
        assert INDEX_NAME in plan, f"planner did not choose the index:\n{plan}"


# ---------------------------------------------------------------------------
# 2. UP — manual re-apply of the up body is a no-op (CREATE INDEX IF NOT EXISTS)
# ---------------------------------------------------------------------------

def test_090_reapply_up_body_is_noop(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    up_sql = (
        REAL_MIGRATIONS_DIR / "090_audio_transcription_jobs_running_index.up.sql"
    ).read_text(encoding="utf-8")

    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(up_sql)  # must not raise on a live index
        assert _index_definition(conn, INDEX_NAME) is not None


# ---------------------------------------------------------------------------
# 3. DOWN — drops the index cleanly (no data loss), then a clean re-up
# ---------------------------------------------------------------------------

def test_090_down_drops_index_then_reups(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        job_id = _seed_running_job(conn, user_id)

    rc = migrate.main(
        [
            "--migrations-dir",
            str(full_dir),
            "--target",
            PRE_090,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_090} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _index_definition(conn, INDEX_NAME) is None
        # A pure index drop touches zero rows — the job row survives intact.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT status FROM audio_transcription_jobs WHERE id = %s", (job_id,)
            )
            row = cur.fetchone()
            assert row is not None
            assert row[0] == "running"

    # Re-up: 090 re-applies cleanly, the index is back.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _index_definition(conn, INDEX_NAME) is not None
