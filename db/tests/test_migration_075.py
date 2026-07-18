"""Migration 075 (audio_transcript_segments, Track A A-1) — real-chain tests.

WHY THIS FILE EXISTS:
    075 stores the Whisper transcript of an audio track as TIMED SEGMENTS —
    the unit the Listen UI's play-position highlight and the paired-reader
    time alignment both consume. Its value is in the bounds topology: the
    [start_ms, end_ms] window CHECKs (zero-length legal, negative-length
    not), the 1..5000 body bound that stops a malformed Whisper run storing
    a blob, the (track_id, segment_number) upsert key, and the CASCADE from
    the track (a transcript is re-derivable, so it dies with its file).
    These tests apply the REAL migration chain against a real Postgres-16
    testcontainer via ``migrate.main()`` and PROVE each guard by attempting
    the write (or delete) it must reject or survive.

SCOPE:
    - markers: up is non-destructive, down destructive (F-088 classification).
    - up: shape — the track FK CASCADEs; UNIQUE (track_id, segment_number)
      rejects a duplicate position.
    - CHECKs: segment_number > 0; start_ms >= 0; end_ms >= start_ms (equal
      OK — Whisper emits zero-length segments); body length bounds.
    - lifecycle: track delete CASCADEs its segments; updated_at trigger
      bumps.
    - down: refused without --allow-destructive; with it, the table is gone,
      neighbors untouched; re-up clean.

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

# The migration immediately before 075. `down --target PRE_075` rolls back
# 077..075 (all destructive downs).
PRE_075 = "074"

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


def _seed_source(conn: psycopg.Connection, user_id: int) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO audio_sources (user_id, slug, title, kind)
            VALUES (%s, 'folktales', '전래동화', 'standalone_listening')
            RETURNING id
            """,
            (user_id,),
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


def _seed_segment(
    conn: psycopg.Connection,
    track_id: int,
    segment_number: int = 1,
    start_ms: int = 0,
    end_ms: int = 3200,
    body: str = "옛날 옛적에 호랑이가 살았습니다.",
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO audio_transcript_segments
                (track_id, segment_number, start_ms, end_ms, body)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id
            """,
            (track_id, segment_number, start_ms, end_ms, body),
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

def test_075_marker_classification() -> None:
    up_sql = (REAL_MIGRATIONS_DIR / "075_audio_transcript_segments.up.sql").read_text(
        encoding="utf-8"
    )
    down_sql = (REAL_MIGRATIONS_DIR / "075_audio_transcript_segments.down.sql").read_text(
        encoding="utf-8"
    )
    assert migrate.explicit_destructiveness(up_sql) is False
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — schema shape.
# ---------------------------------------------------------------------------

def test_075_up_schema_shape(env, dsn: str, full_dir: pathlib.Path) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        assert _table_exists(conn, "audio_transcript_segments")

        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT confrelid::regclass::text AS target, confdeltype
                  FROM pg_constraint
                 WHERE conname = 'fk_audio_transcript_segments_track'
                """
            )
            fk = cur.fetchone()
            assert fk is not None, "track FK missing"
            assert fk["target"] == "audio_tracks"
            assert fk["confdeltype"] == "c", (
                "segments must CASCADE with their track (re-derivable by "
                "re-running Whisper)"
            )


# ---------------------------------------------------------------------------
# 3. UP — CHECKs + the per-track position key.
# ---------------------------------------------------------------------------

def test_075_up_checks_and_position_key(env, dsn: str, full_dir: pathlib.Path) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "a1-segments@example.com")
        source = _seed_source(conn, user)
        track = _seed_track(conn, source, user)

        # segment_number is 1-based.
        with pytest.raises(errors.CheckViolation):
            _seed_segment(conn, track, segment_number=0)

        # start_ms >= 0.
        with pytest.raises(errors.CheckViolation):
            _seed_segment(conn, track, start_ms=-1, end_ms=100)

        # end_ms >= start_ms: a NEGATIVE-length window is rejected…
        with pytest.raises(errors.CheckViolation):
            _seed_segment(conn, track, start_ms=5000, end_ms=4999)
        # …but a ZERO-length one is legal Whisper output.
        _seed_segment(conn, track, segment_number=1, start_ms=5000, end_ms=5000)

        # body bounds: empty and blob-sized both rejected.
        with pytest.raises(errors.CheckViolation):
            _seed_segment(conn, track, segment_number=2, body="")
        with pytest.raises(errors.CheckViolation):
            _seed_segment(conn, track, segment_number=2, body="가" * 5001)

        # One row per position per track — the loader's upsert key.
        _seed_segment(conn, track, segment_number=2)
        with pytest.raises(errors.UniqueViolation):
            _seed_segment(conn, track, segment_number=2)

        # updated_at trigger fires on UPDATE.
        seg = _seed_segment(conn, track, segment_number=3)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT updated_at FROM audio_transcript_segments WHERE id = %s", (seg,)
            )
            before = cur.fetchone()[0]
            cur.execute(
                "UPDATE audio_transcript_segments SET body = '수정' WHERE id = %s",
                (seg,),
            )
            cur.execute(
                "SELECT updated_at FROM audio_transcript_segments WHERE id = %s", (seg,)
            )
            after = cur.fetchone()[0]
        assert after > before, "set_updated_at trigger must bump updated_at"


# ---------------------------------------------------------------------------
# 4. UP — lifecycle: the transcript dies with its track.
# ---------------------------------------------------------------------------

def test_075_track_delete_cascades_segments(env, dsn: str, full_dir: pathlib.Path) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "a1-seg-cascade@example.com")
        source = _seed_source(conn, user)
        track = _seed_track(conn, source, user)
        seg_1 = _seed_segment(conn, track, segment_number=1, start_ms=0, end_ms=3000)
        seg_2 = _seed_segment(conn, track, segment_number=2, start_ms=3000, end_ms=6100)

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("DELETE FROM audio_tracks WHERE id = %s", (track,))
            cur.execute(
                "SELECT count(*) FROM audio_transcript_segments WHERE id IN (%s, %s)",
                (seg_1, seg_2),
            )
            assert cur.fetchone()[0] == 0, "segments must CASCADE with their track"


# ---------------------------------------------------------------------------
# 5. DOWN — destructive gate; table gone, neighbors untouched; re-up clean.
# ---------------------------------------------------------------------------

def test_075_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", PRE_075, "down"])
    assert rc != 0, "075.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_075, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {PRE_075} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert not _table_exists(conn, "audio_transcript_segments")
        # Neighbors untouched (074, one level below the target, included).
        assert _table_exists(conn, "audio_tracks")
        assert _table_exists(conn, "audio_sources")

    # Re-up: 075..077 apply cleanly again.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_exists(conn, "audio_transcript_segments")
