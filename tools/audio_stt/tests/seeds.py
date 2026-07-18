"""Raw-SQL seed helpers for the worker tests (db/tests/test_migration_076.py's
helpers, extended with the timestamp overrides the reap tests need). No app
layer involved — the worker's contract is with the SCHEMA."""

from __future__ import annotations

from datetime import datetime

import psycopg
from psycopg.rows import tuple_row

FAKE_HASH = "$argon2id$" + "x" * 70


def seed_user(conn: psycopg.Connection, email: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id",
            (email, FAKE_HASH),
        )
        return cur.fetchone()[0]


def seed_source(
    conn: psycopg.Connection, user_id: int, slug: str = "news-in-korean"
) -> int:
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


def seed_track(
    conn: psycopg.Connection,
    source_id: int,
    user_id: int,
    n: int = 1,
    blob_ref: str = "1/track.mp3",
    byte_size: int = 4096,
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO audio_tracks
                (source_id, user_id, track_number, blob_ref, byte_size)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id
            """,
            (source_id, user_id, n, blob_ref, byte_size),
        )
        return cur.fetchone()[0]


def seed_job(
    conn: psycopg.Connection,
    track_id: int | None,
    user_id: int,
    status: str = "pending",
    charged_bytes: int = 4096,
    started_at: datetime | None = None,
    created_at: datetime | None = None,
) -> int:
    """created_at/started_at overrides let tests age a row for reap checks
    (COALESCE keeps the schema default when None)."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO audio_transcription_jobs
                (track_id, user_id, status, charged_bytes, started_at, created_at)
            VALUES (%s, %s, %s::audio_transcription_status, %s, %s,
                    COALESCE(%s, now()))
            RETURNING id
            """,
            (track_id, user_id, status, charged_bytes, started_at, created_at),
        )
        return cur.fetchone()[0]


def job_row(conn: psycopg.Connection, job_id: int) -> tuple:
    """(status, error, finished_at) for assertions."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT status::text, error, finished_at
              FROM audio_transcription_jobs WHERE id = %s
            """,
            (job_id,),
        )
        return cur.fetchone()


def track_row(conn: psycopg.Connection, track_id: int) -> tuple:
    """(transcript_status, duration_ms) for assertions."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT transcript_status, duration_ms FROM audio_tracks WHERE id = %s",
            (track_id,),
        )
        return cur.fetchone()


def segment_rows(conn: psycopg.Connection, track_id: int) -> list[tuple]:
    """[(segment_number, start_ms, end_ms, body)] in order."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT segment_number, start_ms, end_ms, body
              FROM audio_transcript_segments
             WHERE track_id = %s
             ORDER BY segment_number
            """,
            (track_id,),
        )
        return cur.fetchall()
