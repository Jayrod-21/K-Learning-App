"""Migration 081 (story audio, F-210) — real-chain tests.

WHY THIS FILE EXISTS:
    081 wires generated_stories into the Track-A audio stack for TTS
    narration: `generated_stories.turns` (latent multi-voice JSONB) + a
    UNIQUE(id, user_id) backing two new composite owner FKs; audio_sources
    gains kind 'generated_story' + an owner-pinned, CASCADEing
    generated_story_id link with a one-set-per-story partial unique; and
    `story_audio_jobs` — the in-server TTS runner's claim/settle/ledger
    table (one live job per story, per-user daily char_count cap). The
    load-bearing behaviors are the integrity rails the routes and runner
    lean on: the owner guards (cross-user job/set rows must be impossible),
    the bidirectional kind<->link CHECK, voice-once (the partial unique),
    the live-job partial unique, and the CASCADE lifecycles.

SCOPE:
    - markers: up non-destructive, down destructive (DROP TABLE + DELETE +
      DROP COLUMN — the explicit-marker posture, F-088).
    - up: full-chain apply; new columns/tables have the expected shapes;
      well-formed rows insert.
    - CHECKs: turns array-ness; job status; job char_count >= 0; the
      story kind<->link CHECK in BOTH directions; the widened kind CHECK
      accepts 'generated_story'.
    - UNIQUEs: one live (pending|running) job per story — settled rows
      don't collide; one audio set per story.
    - Owner guards: a job or set pairing story A's id with user B is
      rejected (composite FK).
    - Lifecycles: deleting a story CASCADE-deletes its jobs AND its audio
      set (tracks/segments transitively); deleting an audio set SET-NULLs
      job.audio_source_id (the job row survives).
    - down: refused without --allow-destructive; with it, the table/column/
      link are gone, the 3-value kind CHECK is restored (a
      'generated_story' insert then fails), stories survive; re-up
      round-trips.

DETERMINISM:
    Mirrors test_migration_080.py — real migration files copied into a
    tmp_path dir, runner pointed via --migrations-dir, fresh schema per test.
"""

from __future__ import annotations

import json
import pathlib

import psycopg
import pytest
from psycopg.rows import tuple_row

from db import migrate  # type: ignore[import-not-found]
from db.tests._helpers import _seed_user, _full_up  # type: ignore[import-not-found]

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

# The migration immediately before 081. `down --target PRE_081` rolls back
# ONLY 081 (its DROP TABLE/DELETE/DROP COLUMN down requires the flag).
PRE_081 = "080"


EXPECTED_JOB_COLUMNS = {
    "id",
    "generated_story_id",
    "user_id",
    "status",
    "char_count",
    "cost_estimate_usd",
    "audio_source_id",
    "error",
    "started_at",
    "finished_at",
    "created_at",
    "updated_at",
    "version",
}


# ---------------------------------------------------------------------------
# Seed helpers — raw SQL, no app layer involved
# ---------------------------------------------------------------------------


def _seed_story(conn: psycopg.Connection, user_id: int, title: str = "모의 이야기") -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO generated_stories (user_id, title, body_ko, level)
            VALUES (%s, %s, '옛날 옛적에 이야기가 있었습니다.', 'L3'::proficiency_level)
            RETURNING id
            """,
            (user_id, title),
        )
        return cur.fetchone()[0]


def _insert_job(
    conn: psycopg.Connection,
    story_id: int,
    user_id: int,
    *,
    status: str = "pending",
    char_count: int = 100,
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO story_audio_jobs (generated_story_id, user_id, status, char_count)
            VALUES (%s, %s, %s, %s)
            RETURNING id
            """,
            (story_id, user_id, status, char_count),
        )
        return cur.fetchone()[0]


def _insert_story_source(
    conn: psycopg.Connection, story_id: int, user_id: int, slug: str
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO audio_sources
                    (user_id, slug, title, kind, source_upload_id,
                     generated_story_id, status)
            VALUES (%s, %s, '이야기 낭독', 'generated_story', NULL, %s, 'ready')
            RETURNING id
            """,
            (user_id, slug, story_id),
        )
        return cur.fetchone()[0]


def _insert_track(conn: psycopg.Connection, source_id: int, user_id: int) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO audio_tracks
                    (source_id, user_id, track_number, blob_ref, byte_size,
                     transcript_status)
            VALUES (%s, %s, 1, %s, 3, 'done')
            RETURNING id
            """,
            (source_id, user_id, f"{user_id}/00000000-0000-4000-8000-000000000081.mp3"),
        )
        return cur.fetchone()[0]


def _table_columns(conn: psycopg.Connection, table: str) -> set[str]:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT column_name
              FROM information_schema.columns
             WHERE table_schema='public' AND table_name=%s
            """,
            (table,),
        )
        return {r[0] for r in cur.fetchall()}


# ---------------------------------------------------------------------------
# 1. F-088 marker classification.
# ---------------------------------------------------------------------------

def test_081_marker_classification() -> None:
    up_sql = (REAL_MIGRATIONS_DIR / "081_story_audio.up.sql").read_text(encoding="utf-8")
    down_sql = (REAL_MIGRATIONS_DIR / "081_story_audio.down.sql").read_text(encoding="utf-8")
    assert migrate.explicit_destructiveness(up_sql) is False
    # The down's DROP TABLE / DELETE / DROP COLUMN is a data drop.
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — shapes on the full chain; well-formed rows insert.
# ---------------------------------------------------------------------------

def test_081_up_shapes_and_happy_path(env, dsn: str, full_dir: pathlib.Path) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_columns(conn, "story_audio_jobs") == EXPECTED_JOB_COLUMNS
        assert "turns" in _table_columns(conn, "generated_stories")
        assert "generated_story_id" in _table_columns(conn, "audio_sources")

        user_id = _seed_user(conn, "f210-shape@example.com")
        story_id = _seed_story(conn, user_id)

        # turns JSONB accepts an array (and NULL by default — the seed above).
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "UPDATE generated_stories SET turns = %s::jsonb WHERE id = %s",
                (json.dumps([{"speaker": "narrator", "text": "옛날 옛적에."}]), story_id),
            )
            cur.execute("SELECT turns FROM generated_stories WHERE id = %s", (story_id,))
            assert cur.fetchone()[0] == [{"speaker": "narrator", "text": "옛날 옛적에."}]

        # The whole voiced shape lands: job → set (kind generated_story) →
        # track; the job links the set on settle.
        job_id = _insert_job(conn, story_id, user_id, char_count=27)
        source_id = _insert_story_source(conn, story_id, user_id, "generated-story-shape")
        _insert_track(conn, source_id, user_id)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                UPDATE story_audio_jobs
                   SET status = 'done', audio_source_id = %s
                 WHERE id = %s
                """,
                (source_id, job_id),
            )
            cur.execute(
                "SELECT status, char_count, audio_source_id FROM story_audio_jobs WHERE id = %s",
                (job_id,),
            )
            assert cur.fetchone() == ("done", 27, source_id)


# ---------------------------------------------------------------------------
# 3. Integrity rails — CHECKs.
# ---------------------------------------------------------------------------

def test_081_turns_check_rejects_non_array(env, dsn: str, full_dir: pathlib.Path) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f210-turns@example.com")
        story_id = _seed_story(conn, user_id)
        with conn.cursor() as cur:
            for bad in ('{"speaker": "narrator"}', '"text"', "42"):
                with pytest.raises(psycopg.errors.CheckViolation):
                    cur.execute(
                        "UPDATE generated_stories SET turns = %s::jsonb WHERE id = %s",
                        (bad, story_id),
                    )


def test_081_job_status_and_char_count_checks(env, dsn: str, full_dir: pathlib.Path) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f210-jobck@example.com")
        story_id = _seed_story(conn, user_id)
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_job(conn, story_id, user_id, status="queued")
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_job(conn, story_id, user_id, char_count=-1)
        # Boundary: 0 is legal (ledger floor decoupled — 076's stance).
        _insert_job(conn, story_id, user_id, char_count=0)


def test_081_story_kind_link_check_both_directions(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f210-kind@example.com")
        story_id = _seed_story(conn, user_id)
        with conn.cursor() as cur:
            # A 'generated_story' set WITHOUT a story link → rejected.
            with pytest.raises(psycopg.errors.CheckViolation):
                cur.execute(
                    """
                    INSERT INTO audio_sources
                            (user_id, slug, title, kind, source_upload_id,
                             generated_story_id, status)
                    VALUES (%s, 'no-link', 't', 'generated_story', NULL, NULL, 'ready')
                    """,
                    (user_id,),
                )
            # A NON-story set WITH a story link → rejected.
            with pytest.raises(psycopg.errors.CheckViolation):
                cur.execute(
                    """
                    INSERT INTO audio_sources
                            (user_id, slug, title, kind, source_upload_id,
                             generated_story_id, status)
                    VALUES (%s, 'bad-link', 't', 'standalone_listening', NULL, %s, 'ready')
                    """,
                    (user_id, story_id),
                )
        # The correct pairing inserts (also proves the widened kind CHECK
        # accepts 'generated_story').
        _insert_story_source(conn, story_id, user_id, "generated-story-kind")


# ---------------------------------------------------------------------------
# 4. UNIQUEs — one live job per story; one audio set per story.
# ---------------------------------------------------------------------------

def test_081_one_live_job_per_story(env, dsn: str, full_dir: pathlib.Path) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f210-live@example.com")
        story_id = _seed_story(conn, user_id)
        _insert_job(conn, story_id, user_id, status="pending")
        with pytest.raises(psycopg.errors.UniqueViolation):
            _insert_job(conn, story_id, user_id, status="pending")
        with pytest.raises(psycopg.errors.UniqueViolation):
            _insert_job(conn, story_id, user_id, status="running")
        # Settled rows never collide — the cap ledger can stack freely.
        _insert_job(conn, story_id, user_id, status="failed")
        _insert_job(conn, story_id, user_id, status="failed")
        # And another STORY's live job is unaffected.
        other_story = _seed_story(conn, user_id, title="다른 이야기")
        _insert_job(conn, other_story, user_id, status="pending")


def test_081_one_audio_set_per_story(env, dsn: str, full_dir: pathlib.Path) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f210-once@example.com")
        story_id = _seed_story(conn, user_id)
        _insert_story_source(conn, story_id, user_id, "generated-story-a")
        with pytest.raises(psycopg.errors.UniqueViolation):
            _insert_story_source(conn, story_id, user_id, "generated-story-b")


# ---------------------------------------------------------------------------
# 5. Owner guards — cross-user job/set rows are structurally impossible.
# ---------------------------------------------------------------------------

def test_081_composite_owner_fks_reject_cross_user_rows(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        owner = _seed_user(conn, "f210-owner@example.com")
        attacker = _seed_user(conn, "f210-attacker@example.com")
        story_id = _seed_story(conn, owner)
        # A job charging the ATTACKER for the OWNER's story → FK violation.
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            _insert_job(conn, story_id, attacker)
        # An audio set voicing the OWNER's story into the ATTACKER's account
        # → FK violation.
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            _insert_story_source(conn, story_id, attacker, "stolen-voice")


# ---------------------------------------------------------------------------
# 6. Lifecycles — CASCADE with the story; job survives set deletion.
# ---------------------------------------------------------------------------

def test_081_story_delete_cascades_jobs_and_audio(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f210-cascade@example.com")
        story_id = _seed_story(conn, user_id)
        job_id = _insert_job(conn, story_id, user_id, status="failed")
        source_id = _insert_story_source(conn, story_id, user_id, "generated-story-cas")
        track_id = _insert_track(conn, source_id, user_id)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                INSERT INTO audio_transcript_segments
                        (track_id, segment_number, start_ms, end_ms, body)
                VALUES (%s, 1, 0, 1000, '옛날 옛적에.')
                """,
                (track_id,),
            )
            cur.execute("DELETE FROM generated_stories WHERE id = %s", (story_id,))
            for table, row_id in (
                ("story_audio_jobs", job_id),
                ("audio_sources", source_id),
                ("audio_tracks", track_id),
            ):
                cur.execute(f"SELECT 1 FROM {table} WHERE id = %s", (row_id,))  # noqa: S608
                assert cur.fetchone() is None, f"{table} row must CASCADE with the story"
            cur.execute(
                "SELECT count(*) FROM audio_transcript_segments WHERE track_id = %s",
                (track_id,),
            )
            assert cur.fetchone()[0] == 0


def test_081_set_delete_set_nulls_job_link(env, dsn: str, full_dir: pathlib.Path) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f210-setnull@example.com")
        story_id = _seed_story(conn, user_id)
        job_id = _insert_job(conn, story_id, user_id, status="pending")
        source_id = _insert_story_source(conn, story_id, user_id, "generated-story-sn")
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "UPDATE story_audio_jobs SET status='done', audio_source_id=%s WHERE id=%s",
                (source_id, job_id),
            )
            cur.execute("DELETE FROM audio_sources WHERE id = %s", (source_id,))
            cur.execute(
                "SELECT status, audio_source_id FROM story_audio_jobs WHERE id = %s",
                (job_id,),
            )
            row = cur.fetchone()
            assert row == ("done", None), (
                "deleting the audio set must SET NULL the job link, never delete the job"
            )


# ---------------------------------------------------------------------------
# 7. DOWN — destructive gate; reversal restores the pre-081 rails; re-up works.
# ---------------------------------------------------------------------------

def test_081_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f210-down@example.com")
        story_id = _seed_story(conn, user_id)
        _insert_job(conn, story_id, user_id, status="failed")
        _insert_story_source(conn, story_id, user_id, "generated-story-down")

    # Refused without the flag.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", PRE_081, "down"])
    assert rc != 0, "081.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_081,
         "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {PRE_081} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_columns(conn, "story_audio_jobs") == set()
        assert "turns" not in _table_columns(conn, "generated_stories")
        assert "generated_story_id" not in _table_columns(conn, "audio_sources")
        with conn.cursor(row_factory=tuple_row) as cur:
            # The story itself survives the rollback (only the AUDIO layer is
            # lossy).
            cur.execute("SELECT 1 FROM generated_stories WHERE id = %s", (story_id,))
            assert cur.fetchone() is not None
            # The voiced set was deleted so the restored 3-value kind CHECK
            # holds — and now rejects 'generated_story' again.
            cur.execute("SELECT count(*) FROM audio_sources")
            assert cur.fetchone()[0] == 0
            with pytest.raises(psycopg.errors.CheckViolation):
                cur.execute(
                    """
                    INSERT INTO audio_sources
                            (user_id, slug, title, kind, source_upload_id, status)
                    VALUES (%s, 'post-down', 't', 'generated_story', NULL, 'ready')
                    """,
                    (user_id,),
                )

    # Round trip: re-up restores the full 081 shape.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_columns(conn, "story_audio_jobs") == EXPECTED_JOB_COLUMNS
        assert "turns" in _table_columns(conn, "generated_stories")
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM story_audio_jobs")
            assert cur.fetchone()[0] == 0
