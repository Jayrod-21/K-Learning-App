"""Migration 076 (audio_transcription_jobs, Track A A-1) — real-chain tests.

WHY THIS FILE EXISTS:
    076 is the claim/settle/reap jobs table for the A1 Whisper worker — a
    direct adaptation of 069's upload_extractions shape, with ONE deliberate
    departure: 'pending' is a REAL queue state a worker claims (069 reserved
    it). Two behaviors are load-bearing and mirror 069's fixpass BLOCKER-1
    pin: `fk_audio_transcription_jobs_track` must be ON DELETE SET NULL (a
    CASCADE would let deleting an audio set erase today's charged jobs and
    reset the per-user daily transcription cap on demand), and the partial
    UNIQUE claim index must admit at most ONE live job per track while
    letting orphaned (NULL track_id) rows neither block nor be blocked.
    These tests apply the REAL migration chain against a real Postgres-16
    testcontainer via ``migrate.main()`` and PROVE each guard by attempting
    the write (or delete) it must reject or survive.

SCOPE:
    - markers: up is non-destructive, down destructive (F-088 classification).
    - up: applies on the full real chain; re-applying the body is a no-op
      (enum DO-block, IF NOT EXISTS, CREATE OR REPLACE TRIGGER); the three
      indexes exist (live-claim partial UNIQUE, user/created ledger index,
      pending-slice worker index); rows default to a REAL 'pending' state.
    - claim arbitration: a second live (pending/running) job for the SAME
      track 23505s; a settled (done/failed) job never blocks a new claim.
    - ledger pin: deleting the track keeps the job row, nulls track_id, the
      per-user cap SUM (of charged_bytes — the enqueue-time cost snapshot,
      069's pages_requested analog) still counts it, and orphaned live rows
      coexist without blocking new claims (NULLs never equal).
    - bounds: charged_bytes NOT NULL + >= 0; error length CHECK; user delete
      CASCADEs the ledger.
    - down: refused without --allow-destructive; with it, table + enum gone;
      re-up clean.

DETERMINISM:
    Mirrors test_migration_069.py — the real migration files are copied into
    a tmp_path-scoped directory and the runner is pointed at it via
    ``--migrations-dir``; the ``dsn`` fixture gives each test a fresh schema.
"""

from __future__ import annotations

import pathlib
import shutil

import psycopg
import pytest
from psycopg import errors
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

# The migration immediately before 076. `down --target PRE_076` rolls back
# 077 then 076 (both destructive downs).
PRE_076 = "075"

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
# Seed helpers — raw SQL, no app layer involved
# ---------------------------------------------------------------------------

def _seed_user(conn: psycopg.Connection, email: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id",
            (email, FAKE_HASH),
        )
        return cur.fetchone()[0]


def _seed_source(conn: psycopg.Connection, user_id: int, slug: str = "news-in-korean") -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO audio_sources (user_id, slug, title, kind)
            VALUES (%s, %s, '뉴스', 'standalone_listening')
            RETURNING id
            """,
            (user_id, slug),
        )
        return cur.fetchone()[0]


def _seed_track(conn: psycopg.Connection, source_id: int, user_id: int, n: int = 1) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO audio_tracks (source_id, user_id, track_number, blob_ref, byte_size)
            VALUES (%s, %s, %s, '1/track.mp3', 4096)
            RETURNING id
            """,
            (source_id, user_id, n),
        )
        return cur.fetchone()[0]


def _seed_job(
    conn: psycopg.Connection,
    track_id: int | None,
    user_id: int,
    status: str = "pending",
    charged_bytes: int = 4096,
) -> int:
    # charged_bytes mirrors what the enqueue route snapshots from the
    # track's byte_size (the _seed_track default) at claim time.
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO audio_transcription_jobs
                (track_id, user_id, status, charged_bytes)
            VALUES (%s, %s, %s::audio_transcription_status, %s)
            RETURNING id
            """,
            (track_id, user_id, status, charged_bytes),
        )
        return cur.fetchone()[0]


def _table_exists(conn: psycopg.Connection, table: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name=%s
            """,
            (table,),
        )
        return cur.fetchone() is not None


# ---------------------------------------------------------------------------
# 1. F-088 marker classification.
# ---------------------------------------------------------------------------

def test_076_marker_classification() -> None:
    up_sql = (REAL_MIGRATIONS_DIR / "076_audio_transcription_jobs.up.sql").read_text(
        encoding="utf-8"
    )
    down_sql = (REAL_MIGRATIONS_DIR / "076_audio_transcription_jobs.down.sql").read_text(
        encoding="utf-8"
    )
    assert migrate.explicit_destructiveness(up_sql) is False
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — shape; body re-runnable; 'pending' is the real default state.
# ---------------------------------------------------------------------------

def test_076_up_shape_and_reapply_is_idempotent(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    up_sql = (REAL_MIGRATIONS_DIR / "076_audio_transcription_jobs.up.sql").read_text(
        encoding="utf-8"
    )
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        # Drive the body a second time directly (the runner skips an applied
        # version): enum DO-block, IF NOT EXISTS, CREATE OR REPLACE TRIGGER
        # must all be re-runnable.
        with conn.cursor() as cur:
            cur.execute(up_sql)

        with conn.cursor() as cur:
            for conname, target, deltype in (
                ("fk_audio_transcription_jobs_track", "audio_tracks", "n"),
                ("fk_audio_transcription_jobs_user", "users", "c"),
            ):
                cur.execute(
                    """
                    SELECT confrelid::regclass::text AS target, confdeltype
                      FROM pg_constraint WHERE conname = %s
                    """,
                    (conname,),
                )
                fk = cur.fetchone()
                assert fk is not None, f"{conname} missing"
                assert fk["target"] == target
                assert fk["confdeltype"] == deltype

            for indexname, needle in (
                ("uq_audio_transcription_jobs_track_live", "status = ANY"),
                ("ix_audio_transcription_jobs_user_created", "created_at DESC"),
                # (created_at, id): the id tiebreak = strict FIFO under
                # equal timestamps.
                ("ix_audio_transcription_jobs_pending", "(created_at, id)"),
            ):
                cur.execute(
                    "SELECT indexdef FROM pg_indexes WHERE indexname = %s",
                    (indexname,),
                )
                idx = cur.fetchone()
                assert idx is not None, f"{indexname} missing"
                assert needle in idx["indexdef"], f"{indexname}: {idx['indexdef']}"

    # A bare enqueue defaults to 'pending' — the REAL worker-queue state
    # (076's deliberate departure from 069, where 'pending' was reserved).
    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "a1-jobs-default@example.com")
        source = _seed_source(conn, user)
        track = _seed_track(conn, source, user)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                INSERT INTO audio_transcription_jobs (track_id, user_id, charged_bytes)
                VALUES (%s, %s, 4096) RETURNING status::text
                """,
                (track, user),
            )
            assert cur.fetchone()[0] == "pending"


# ---------------------------------------------------------------------------
# 3. The claim arbiter: one live job per track.
# ---------------------------------------------------------------------------

def test_076_live_claim_arbitration(env, dsn: str, full_dir: pathlib.Path) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "a1-claims@example.com")
        source = _seed_source(conn, user)
        track_a = _seed_track(conn, source, user, n=1)
        track_b = _seed_track(conn, source, user, n=2)

        # One live job per track: a second live claim (either live status)
        # for the SAME track 23505s…
        _seed_job(conn, track_a, user, status="pending")
        with pytest.raises(errors.UniqueViolation):
            _seed_job(conn, track_a, user, status="pending")
        with pytest.raises(errors.UniqueViolation):
            _seed_job(conn, track_a, user, status="running")

        # …a SETTLED job never blocks a new claim…
        _seed_job(conn, track_b, user, status="failed")
        _seed_job(conn, track_b, user, status="pending")

        # …and the error bound holds (a summary, not a stack dump).
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO audio_transcription_jobs
                        (track_id, user_id, status, error, charged_bytes)
                    VALUES (NULL, %s, 'failed', %s, 4096)
                    """,
                    (user, "x" * 2001),
                )

        # charged_bytes is the cap's cost unit: required at enqueue…
        with pytest.raises(errors.NotNullViolation):
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO audio_transcription_jobs (track_id, user_id, status)
                    VALUES (NULL, %s, 'failed')
                    """,
                    (user,),
                )
        # …and never negative.
        with pytest.raises(errors.CheckViolation):
            _seed_job(conn, None, user, status="failed", charged_bytes=-1)


# ---------------------------------------------------------------------------
# 4. The ledger pin: the job survives its track's deletion; orphans never
#    block; the user delete takes the cost history.
# ---------------------------------------------------------------------------

def test_076_track_delete_keeps_ledger_row_and_nulls_track_id(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "a1-ledger@example.com")
        source = _seed_source(conn, user)
        track = _seed_track(conn, source, user)
        job = _seed_job(conn, track, user, status="done")

        with conn.cursor(row_factory=tuple_row) as cur:
            # Deleting the SET (which CASCADEs the track) must not erase the
            # charged job — under a CASCADE FK, delete-set → re-ingest →
            # re-enqueue would reset the daily transcription cap on demand.
            cur.execute("DELETE FROM audio_sources WHERE id = %s", (source,))
            cur.execute(
                "SELECT track_id, user_id FROM audio_transcription_jobs WHERE id = %s",
                (job,),
            )
            row = cur.fetchone()
            assert row is not None, "ledger row must survive its track's deletion"
            assert row[0] is None, "track_id must be SET NULL, not kept dangling"
            assert row[1] == user

            # The per-user daily cap still charges the orphaned row at FULL
            # magnitude: charged_bytes was snapshot at enqueue, so the cost
            # survives even though the track (and its byte_size) is gone —
            # the whole point of the snapshot (069's pages_requested stance).
            cur.execute(
                """
                SELECT count(*), coalesce(sum(charged_bytes), 0)
                  FROM audio_transcription_jobs
                 WHERE user_id = %s AND created_at >= date_trunc('day', now())
                """,
                (user,),
            )
            n_rows, charged = cur.fetchone()
            assert n_rows == 1
            assert charged == 4096, "cost magnitude must survive track deletion"


def test_076_orphaned_live_jobs_never_block_new_claims(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "a1-orphans@example.com")
        source = _seed_source(conn, user)
        track_a = _seed_track(conn, source, user, n=1)
        track_b = _seed_track(conn, source, user, n=2)
        _seed_job(conn, track_a, user, status="running")
        _seed_job(conn, track_b, user, status="pending")

        with conn.cursor(row_factory=tuple_row) as cur:
            # Orphan both live jobs (track deletes SET NULL them) — two NULL
            # track_ids coexist under the partial UNIQUE (NULLs never equal)…
            cur.execute("DELETE FROM audio_tracks WHERE id IN (%s, %s)", (track_a, track_b))
            cur.execute(
                """
                SELECT count(*) FROM audio_transcription_jobs
                 WHERE track_id IS NULL AND status IN ('pending', 'running')
                """
            )
            assert cur.fetchone()[0] == 2

        # …and block nothing: a fresh track claims freely.
        track_c = _seed_track(conn, source, user, n=3)
        _seed_job(conn, track_c, user, status="pending")

        # A deleted USER takes their cost history with them (correct — the
        # cap protects the user's own budget, not a global one).
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (user,))
            cur.execute("SELECT count(*) FROM audio_transcription_jobs")
            assert cur.fetchone()[0] == 0


# ---------------------------------------------------------------------------
# 5. DOWN — destructive gate; table + enum gone; re-up clean.
# ---------------------------------------------------------------------------

def test_076_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", PRE_076, "down"])
    assert rc != 0, "076.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_076, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {PRE_076} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT to_regclass('public.audio_transcription_jobs')")
            assert cur.fetchone()[0] is None, "table must be gone after down"
            cur.execute(
                "SELECT count(*) FROM pg_type WHERE typname = 'audio_transcription_status'"
            )
            assert cur.fetchone()[0] == 0, "enum must be gone after down"
        # Neighbors untouched (075, one level below the target, included).
        assert _table_exists(conn, "audio_transcript_segments")
        assert _table_exists(conn, "audio_tracks")

    # Re-up: 076..077 apply cleanly again.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_exists(conn, "audio_transcription_jobs")
