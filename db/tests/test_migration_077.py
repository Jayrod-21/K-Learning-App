"""Migration 077 (listening_attempts 'audio_track' target, Track A A-1) —
real-chain tests.

WHY THIS FILE EXISTS:
    077 widens 061's listening_attempts discriminator to a third target:
    source_kind gains 'audio_track' and a soft SET-NULL track_id FK lands
    next to lesson_id/episode_id, so the existing "listened today" plumbing
    counts corpus-audio listens. The load-bearing behaviors: both CHECKs are
    recreated under their 061 NAMES strictly MORE permissively (no existing
    row invalidated), target_not_both stays AT-MOST-one (never XOR — a track
    prune's SET NULL is an UPDATE that must not abort), and the down
    restores the 2-value 061 definitions VERBATIM, failing LOUDLY if
    audio_track history rows exist (069's populated-corpus posture). These
    tests apply the REAL migration chain against a real Postgres-16
    testcontainer via ``migrate.main()`` and PROVE each guard by attempting
    the write (or delete) it must reject or survive.

SCOPE:
    - markers: up is non-destructive, down destructive (the DROP COLUMN
      shape the legacy sniff misses — F-088's point).
    - up: applies on the full real chain; re-applying the body is a no-op
      (ADD COLUMN IF NOT EXISTS, DO-guarded FK, DROP+ADD CONSTRAINT); the
      track FK is SET NULL; the two CHECKs keep their 061 names.
    - populated-table upgrade (THE regression 077 exists to survive): up to
      076, seed lesson + episode + degraded 061-shaped attempt rows, then
      apply 077 over them — ADD COLUMN + both ADD CONSTRAINTs validate
      against real pre-existing rows; all survive with track_id NULL.
    - widened CHECKs: an 'audio_track' attempt INSERTs; a bogus source_kind
      still fails; every two-of-three target pairing is rejected; single
      targets pass.
    - degraded row: pruning the track SET NULLs track_id without tripping
      target_not_both; title_snapshot survives.
    - down: refused without --allow-destructive; with it (no audio rows),
      track_id is gone and the 2-value CHECK rejects 'audio_track' again
      while a lesson attempt still inserts; FAILS LOUDLY when audio_track
      rows exist (ADD CONSTRAINT validates existing rows) AND the failed
      down leaves 077 fully intact — track_id still present, the audio
      attempt row untouched (the runner's single transaction is
      all-or-nothing); re-up clean.

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

# The migration immediately before 077. `down --target PRE_077` rolls back
# ONLY 077 (its DROP COLUMN down is what requires --allow-destructive).
PRE_077 = "076"

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


def _seed_source(conn: psycopg.Connection, user_id: int, slug: str = "folktales") -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO audio_sources (user_id, slug, title, kind)
            VALUES (%s, %s, '전래동화', 'standalone_listening')
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


def _ensure_corpus_source(conn: psycopg.Connection, corpus: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT id FROM corpus_sources WHERE corpus = %s::corpus LIMIT 1", (corpus,)
        )
        row = cur.fetchone()
        if row is not None:
            return row[0]
        cur.execute(
            """
            INSERT INTO corpus_sources (corpus, title, level, source_path, default_proficiency)
            VALUES (%s::corpus, %s, 'intermediate'::book_level, %s, 'L3'::proficiency_level)
            RETURNING id
            """,
            (corpus, f"test-{corpus}", f"test/{corpus}.json"),
        )
        return cur.fetchone()[0]


def _seed_lesson(conn: psycopg.Connection) -> int:
    corpus_source_id = _ensure_corpus_source(conn, "ttmik")
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO ttmik_lessons
                (corpus_source_id, corpus, source_id, lesson_level, lesson_number, ordinal, title)
            VALUES (%s, 'ttmik'::corpus, 'ttmik-L1-1', 1, 1, 1, '레슨')
            RETURNING id
            """,
            (corpus_source_id,),
        )
        return cur.fetchone()[0]


def _seed_episode(conn: psycopg.Connection) -> int:
    corpus_source_id = _ensure_corpus_source(conn, "iyagi")
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO iyagi_episodes
                (corpus_source_id, corpus, source_id, episode_number, ordinal, title)
            VALUES (%s, 'iyagi'::corpus, 'iyagi-1', 1, 1, '에피소드')
            RETURNING id
            """,
            (corpus_source_id,),
        )
        return cur.fetchone()[0]


def _insert_track_attempt(
    conn: psycopg.Connection,
    user_id: int,
    track_id: int | None,
    title_snapshot: str = "전래동화 1번 트랙",
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO listening_attempts (user_id, source_kind, track_id, title_snapshot)
            VALUES (%s, 'audio_track', %s, %s)
            RETURNING id
            """,
            (user_id, track_id, title_snapshot),
        )
        return cur.fetchone()[0]


def _column_exists(conn: psycopg.Connection, table: str, column: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name=%s AND column_name=%s
            """,
            (table, column),
        )
        return cur.fetchone() is not None


# ---------------------------------------------------------------------------
# 1. F-088 marker classification.
# ---------------------------------------------------------------------------

def test_077_marker_classification() -> None:
    up_sql = (
        REAL_MIGRATIONS_DIR / "077_listening_source_kind_audio_track.up.sql"
    ).read_text(encoding="utf-8")
    down_sql = (
        REAL_MIGRATIONS_DIR / "077_listening_source_kind_audio_track.down.sql"
    ).read_text(encoding="utf-8")
    assert migrate.explicit_destructiveness(up_sql) is False
    # The down's data drop is a DROP COLUMN — the exact shape the legacy
    # keyword-sniff misses, so the explicit marker must carry it.
    assert migrate.explicit_destructiveness(down_sql) is True


# ---------------------------------------------------------------------------
# 2. UP — shape; the body is re-runnable; the FK is soft.
# ---------------------------------------------------------------------------

def test_077_up_shape_and_reapply_is_idempotent(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    up_sql = (
        REAL_MIGRATIONS_DIR / "077_listening_source_kind_audio_track.up.sql"
    ).read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        assert _column_exists(conn, "listening_attempts", "track_id")

        # Drive the body a second time directly (the runner skips an applied
        # version): ADD COLUMN IF NOT EXISTS, the DO-guarded FK, and DROP
        # CONSTRAINT IF EXISTS + ADD must all be re-runnable.
        with conn.cursor() as cur:
            cur.execute(up_sql)

        with conn.cursor() as cur:
            # Lookups scoped by conrelid so a same-named constraint on
            # another table can never satisfy (or shadow) these asserts.
            cur.execute(
                """
                SELECT confrelid::regclass::text AS target, confdeltype
                  FROM pg_constraint
                 WHERE conname = 'fk_listening_attempts_track'
                   AND conrelid = 'listening_attempts'::regclass
                """
            )
            fk = cur.fetchone()
            assert fk is not None, "track FK missing"
            assert fk["target"] == "audio_tracks"
            assert fk["confdeltype"] == "n", "track FK must be ON DELETE SET NULL"

            # Both CHECKs kept their 061 names (069's same-name relaxation
            # maneuver).
            for conname in (
                "ck_listening_attempts_source_kind",
                "ck_listening_attempts_target_not_both",
            ):
                cur.execute(
                    """
                    SELECT 1 FROM pg_constraint
                     WHERE conname = %s
                       AND conrelid = 'listening_attempts'::regclass
                    """,
                    (conname,),
                )
                assert cur.fetchone() is not None, f"{conname} missing after 077"


# ---------------------------------------------------------------------------
# 3. UP over a POPULATED table — THE regression scenario 077 exists to
#    survive: ADD COLUMN lands on real rows, and both same-name ADD
#    CONSTRAINTs re-validate every pre-existing row against the relaxed
#    definitions ("strictly more permissive" proven on data, not argued).
# ---------------------------------------------------------------------------

def test_077_up_applies_over_populated_listening_attempts(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    # Stop the chain at 076 — listening_attempts still has its 061 shape.
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_077,
         "--allow-destructive", "up"]
    )
    assert rc == 0, f"up --target {PRE_077} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert not _column_exists(conn, "listening_attempts", "track_id")
        user = _seed_user(conn, "a1-populated-up@example.com")
        lesson = _seed_lesson(conn)
        episode = _seed_episode(conn)
        with conn.cursor(row_factory=tuple_row) as cur:
            # One of each pre-077 row shape: lesson-target, episode-target,
            # and a fully-degraded row (all targets NULL — legal at rest
            # after a corpus prune, 061's contract).
            cur.execute(
                """
                INSERT INTO listening_attempts
                    (user_id, source_kind, lesson_id, title_snapshot)
                VALUES (%s, 'ttmik_lesson', %s, '레슨')
                RETURNING id
                """,
                (user, lesson),
            )
            ids = [cur.fetchone()[0]]
            cur.execute(
                """
                INSERT INTO listening_attempts
                    (user_id, source_kind, episode_id, title_snapshot)
                VALUES (%s, 'iyagi_episode', %s, '에피소드')
                RETURNING id
                """,
                (user, episode),
            )
            ids.append(cur.fetchone()[0])
            cur.execute(
                """
                INSERT INTO listening_attempts (user_id, source_kind, title_snapshot)
                VALUES (%s, 'ttmik_lesson', '프룬된 레슨')
                RETURNING id
                """,
                (user,),
            )
            ids.append(cur.fetchone()[0])

    # Apply 077 OVER the populated table.
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _column_exists(conn, "listening_attempts", "track_id")
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                SELECT id, track_id FROM listening_attempts
                 WHERE id = ANY(%s) ORDER BY id
                """,
                (ids,),
            )
            rows = cur.fetchall()
            assert [r[0] for r in rows] == sorted(ids), (
                "every pre-077 row must survive the widen"
            )
            assert all(r[1] is None for r in rows), (
                "the new track_id must be NULL on every pre-existing row"
            )
        # And the widened table accepts the third kind immediately.
        user2 = _seed_user(conn, "a1-populated-up-2@example.com")
        source = _seed_source(conn, user2)
        track = _seed_track(conn, source, user2)
        _insert_track_attempt(conn, user2, track)


# ---------------------------------------------------------------------------
# 4. UP — the widened discriminator + at-most-one over three targets.
# ---------------------------------------------------------------------------

def test_077_widened_checks(env, dsn: str, full_dir: pathlib.Path) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "a1-widen@example.com")
        source = _seed_source(conn, user)
        track = _seed_track(conn, source, user)
        lesson = _seed_lesson(conn)
        episode = _seed_episode(conn)

        # The third kind is live…
        _insert_track_attempt(conn, user, track)
        # …the pre-077 kinds still are…
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO listening_attempts (user_id, source_kind, lesson_id, title_snapshot)
                VALUES (%s, 'ttmik_lesson', %s, '레슨')
                """,
                (user, lesson),
            )
        # …and a non-member still fails.
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO listening_attempts (user_id, source_kind, track_id, title_snapshot)
                    VALUES (%s, 'bogus', %s, 'x')
                    """,
                    (user, track),
                )

        # At most ONE target: every two-of-three pairing is rejected.
        for cols, vals in (
            ("lesson_id, episode_id", (lesson, episode)),
            ("lesson_id, track_id", (lesson, track)),
            ("episode_id, track_id", (episode, track)),
        ):
            with pytest.raises(errors.CheckViolation):
                with conn.cursor() as cur:
                    cur.execute(
                        f"""
                        INSERT INTO listening_attempts
                            (user_id, source_kind, {cols}, title_snapshot)
                        VALUES (%s, 'ttmik_lesson', %s, %s, 'x')
                        """,
                        (user, *vals),
                    )


def test_077_track_delete_degrades_without_violating_check(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "a1-degrade@example.com")
        source = _seed_source(conn, user)
        track = _seed_track(conn, source, user)
        attempt = _insert_track_attempt(conn, user, track, title_snapshot="사라질 트랙")

        # An audio re-ingest prunes the track — must succeed (not abort on
        # the attempt row's own CHECK, which the SET NULL UPDATE re-fires)
        # and SET NULL track_id on the attempt.
        with conn.cursor() as cur:
            cur.execute("DELETE FROM audio_tracks WHERE id = %s", (track,))

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                SELECT lesson_id, episode_id, track_id, title_snapshot
                  FROM listening_attempts WHERE id = %s
                """,
                (attempt,),
            )
            row = cur.fetchone()
            assert row[0] is None and row[1] is None
            assert row[2] is None, "track_id must SET NULL, not block the delete"
            assert row[3] == "사라질 트랙", "title_snapshot survives the track's removal"


# ---------------------------------------------------------------------------
# 5. DOWN — destructive gate; verbatim 061 restore on clean data; loud
#    failure on populated audio-listen history leaves 077 intact; re-up clean.
# ---------------------------------------------------------------------------

def test_077_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    # Refused without the flag (DROP COLUMN + explicit marker).
    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", PRE_077, "down"])
    assert rc != 0, "077.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_077, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {PRE_077} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert not _column_exists(conn, "listening_attempts", "track_id")

        user = _seed_user(conn, "a1-post-down@example.com")
        lesson = _seed_lesson(conn)

        # The original CHECK is restored verbatim: 'audio_track' is rejected
        # again (source_kind CHECK, pre-077 definition)…
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO listening_attempts (user_id, source_kind, title_snapshot)
                    VALUES (%s, 'audio_track', 'x')
                    """,
                    (user,),
                )
        # …the 2-target guard is back…
        episode = _seed_episode(conn)
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO listening_attempts
                        (user_id, source_kind, lesson_id, episode_id, title_snapshot)
                    VALUES (%s, 'ttmik_lesson', %s, %s, 'x')
                    """,
                    (user, lesson, episode),
                )
        # …and a legal 061-shaped attempt still inserts.
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO listening_attempts (user_id, source_kind, lesson_id, title_snapshot)
                VALUES (%s, 'ttmik_lesson', %s, '레슨')
                """,
                (user, lesson),
            )

    # Round trip: re-up restores the third target.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _column_exists(conn, "listening_attempts", "track_id")
        user2 = _seed_user(conn, "a1-post-reup@example.com")
        source = _seed_source(conn, user2)
        track = _seed_track(conn, source, user2)
        _insert_track_attempt(conn, user2, track)


def test_077_down_fails_loudly_on_populated_audio_listen_history(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "a1-populated-down@example.com")
        source = _seed_source(conn, user)
        track = _seed_track(conn, source, user)
        attempt = _insert_track_attempt(conn, user, track)

    # ADD CONSTRAINT validates existing rows — populated audio-listen
    # history must make the down FAIL rather than silently strand rows whose
    # source_kind the restored CHECK forbids (069's documented posture).
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_077, "--allow-destructive", "down"]
    )
    assert rc != 0, "down must fail loudly while audio_track attempt rows exist"

    # The failed down must be ALL-OR-NOTHING (the down header's promise —
    # the runner wraps the body in one transaction): 077 is fully intact,
    # nothing was half-reverted.
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _column_exists(conn, "listening_attempts", "track_id"), (
            "failed down must leave track_id in place (atomic rollback)"
        )
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                SELECT source_kind, track_id FROM listening_attempts
                 WHERE id = %s
                """,
                (attempt,),
            )
            row = cur.fetchone()
            assert row is not None, "the audio attempt row must survive the failed down"
            assert row[0] == "audio_track" and row[1] == track
        # The widened CHECK is still in force: a fresh audio_track attempt
        # still inserts.
        user_check = _seed_user(conn, "a1-post-failed-down@example.com")
        source_check = _seed_source(conn, user_check, slug="post-failed-down")
        track_check = _seed_track(conn, source_check, user_check)
        _insert_track_attempt(conn, user_check, track_check)

    # The operator deliberately removes the audio-listen rows → down succeeds.
    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM listening_attempts WHERE source_kind = 'audio_track'")
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_077, "--allow-destructive", "down"]
    )
    assert rc == 0
