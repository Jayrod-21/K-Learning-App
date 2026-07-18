"""Migration 074 (audio_tracks, Track A A-1) — real-chain tests.

WHY THIS FILE EXISTS:
    074 is the per-file half of the Listen content store (the book_pages
    analog): blob pointer, display order, per-track transcript lifecycle,
    and the soft chapter-alignment link into the paired reader. Its value is
    in the FK topology — both parent links are COMPOSITE owner guards (044's
    maneuver): (source_id, user_id) -> audio_sources(id, user_id) CASCADEs
    (a track dies with its set; a drifted user_id — the no-join streaming
    probe's IDOR primitive — is structurally impossible), and — the
    load-bearing carve-out — (chapter_id, user_id) ->
    reading_chapters(id, user_id) with the PG 15+ column-list
    ``ON DELETE SET NULL (chapter_id)`` (051's mechanism) so a
    reading-chapter re-load can NEVER erase or block a Whisper-transcribed
    track (061's corpus-reload reasoning) while cross-user alignment stays
    impossible. These tests apply the REAL migration chain against a real
    Postgres-16 testcontainer via ``migrate.main()`` and PROVE each guard by
    attempting the write (or delete) it must reject or survive.

SCOPE:
    - markers: up is non-destructive, down destructive (F-088 classification).
    - up: shape — composite source FK CASCADEs, direct user FK CASCADEs,
      composite chapter FK column-list SET NULLs; uq_reading_chapters_id_user
      (the §0 backing UNIQUE) exists; the partial alignment index exists;
      UNIQUE (source_id, track_number) rejects a duplicate display position.
    - CHECKs: track_number > 0; blob_ref/title length bounds (both ends);
      duration_ms lower bound; byte_size strictly positive; transcript_status
      closed set.
    - owner guards: a cross-user (source, user) pair and a cross-user
      (chapter, user) alignment are both REJECTED (23503).
    - lifecycle: chapter delete degrades ONLY chapter_id to NULL keeping the
      track; set delete CASCADEs its tracks; user delete CASCADEs;
      updated_at trigger bumps.
    - down: refused without --allow-destructive; with it, the table is gone,
      uq_reading_chapters_id_user removed with it, neighbors untouched;
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

# The migration immediately before 074. `down --target PRE_074` rolls back
# 077..074 (all destructive downs — DROP TABLE / DROP COLUMN).
PRE_074 = "073"

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


def _seed_book_upload(conn: psycopg.Connection, user_id: int, title: str = "짝꿍 책") -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO book_uploads (user_id, title, type, status, byte_size)
            VALUES (%s, %s, 'literature'::book_upload_type, 'ready'::book_upload_status, 1024)
            RETURNING id
            """,
            (user_id, title),
        )
        return cur.fetchone()[0]


def _seed_chapter(
    conn: psycopg.Connection, upload_id: int, user_id: int, number: int = 1
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO reading_chapters (source_upload_id, user_id, chapter_number, title)
            VALUES (%s, %s, %s, '챕터')
            RETURNING id
            """,
            (upload_id, user_id, number),
        )
        return cur.fetchone()[0]


def _seed_source(
    conn: psycopg.Connection, user_id: int, slug: str = "easy-korean-reading"
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO audio_sources (user_id, slug, title, kind)
            VALUES (%s, %s, '오디오 세트', 'paired_reader')
            RETURNING id
            """,
            (user_id, slug),
        )
        return cur.fetchone()[0]


def _seed_track(
    conn: psycopg.Connection,
    source_id: int,
    user_id: int,
    track_number: int = 1,
    chapter_id: int | None = None,
    blob_ref: str = "1/track.mp3",
    byte_size: int = 4096,
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO audio_tracks
                (source_id, user_id, track_number, blob_ref, byte_size, chapter_id)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (source_id, user_id, track_number, blob_ref, byte_size, chapter_id),
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

def test_074_marker_classification() -> None:
    up_sql = (REAL_MIGRATIONS_DIR / "074_audio_tracks.up.sql").read_text(
        encoding="utf-8"
    )
    down_sql = (REAL_MIGRATIONS_DIR / "074_audio_tracks.down.sql").read_text(
        encoding="utf-8"
    )
    assert migrate.explicit_destructiveness(up_sql) is False
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — schema shape.
# ---------------------------------------------------------------------------

def test_074_up_schema_shape(env, dsn: str, full_dir: pathlib.Path) -> None:
    """Full-chain up: the table exists; the composite source FK CASCADEs and
    the composite chapter FK column-list SET NULLs (the corpus-reload
    carve-out); the §0 backing UNIQUE and the partial alignment index
    exist."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        assert _table_exists(conn, "audio_tracks")

        with conn.cursor() as cur:
            for conname, target, deltype, ncols, nsetcols in (
                ("fk_audio_tracks_source", "audio_sources", "c", 2, 0),
                ("fk_audio_tracks_user", "users", "c", 1, 0),
                ("fk_audio_tracks_chapter", "reading_chapters", "n", 2, 1),
            ):
                cur.execute(
                    """
                    SELECT confrelid::regclass::text AS target, confdeltype,
                           cardinality(conkey) AS ncols,
                           coalesce(cardinality(confdelsetcols), 0) AS nsetcols
                      FROM pg_constraint
                     WHERE conname = %s AND conrelid = 'audio_tracks'::regclass
                    """,
                    (conname,),
                )
                fk = cur.fetchone()
                assert fk is not None, f"{conname} missing"
                assert fk["target"] == target
                assert fk["confdeltype"] == deltype, (
                    f"{conname}: expected ON DELETE {deltype!r}"
                )
                assert fk["ncols"] == ncols, f"{conname}: FK arity {fk['ncols']}"
                assert fk["nsetcols"] == nsetcols, (
                    f"{conname}: SET NULL column-list arity {fk['nsetcols']}"
                )

            # The §0 backing UNIQUE the composite chapter FK rides.
            cur.execute(
                """
                SELECT 1 FROM pg_constraint
                 WHERE conname = 'uq_reading_chapters_id_user'
                   AND conrelid = 'reading_chapters'::regclass
                   AND contype = 'u'
                """
            )
            assert cur.fetchone() is not None, "uq_reading_chapters_id_user missing"

            cur.execute(
                """
                SELECT indexdef FROM pg_indexes
                 WHERE indexname = 'ix_audio_tracks_chapter'
                """
            )
            idx = cur.fetchone()
            assert idx is not None, "alignment index missing"
            assert "chapter_id IS NOT NULL" in idx["indexdef"], "index must be partial"


# ---------------------------------------------------------------------------
# 3. UP — CHECKs + the per-set display-position key.
# ---------------------------------------------------------------------------

def test_074_up_checks_and_position_key(env, dsn: str, full_dir: pathlib.Path) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "a1-tracks@example.com")
        source = _seed_source(conn, user)

        # track_number is 1-based.
        with pytest.raises(errors.CheckViolation):
            _seed_track(conn, source, user, track_number=0)

        # blob_ref length bounds (both ends).
        with pytest.raises(errors.CheckViolation):
            _seed_track(conn, source, user, blob_ref="")
        with pytest.raises(errors.CheckViolation):
            _seed_track(conn, source, user, blob_ref="x" * 1025)

        # byte_size is strictly positive (a 0-byte audio file is never a
        # valid upload — 040's stance).
        with pytest.raises(errors.CheckViolation):
            _seed_track(conn, source, user, byte_size=-1)
        with pytest.raises(errors.CheckViolation):
            _seed_track(conn, source, user, byte_size=0)

        # duration_ms lower bound (NULL is fine — informational column).
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO audio_tracks
                        (source_id, user_id, track_number, blob_ref, byte_size, duration_ms)
                    VALUES (%s, %s, 7, '1/x.mp3', 1, -1)
                    """,
                    (source, user),
                )

        # transcript_status is a closed set.
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO audio_tracks
                        (source_id, user_id, track_number, blob_ref, byte_size, transcript_status)
                    VALUES (%s, %s, 8, '1/x.mp3', 1, 'bogus')
                    """,
                    (source, user),
                )

        # title bounds, both ends (NULL legal — number-only tracks).
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO audio_tracks
                        (source_id, user_id, track_number, blob_ref, byte_size, title)
                    VALUES (%s, %s, 9, '1/x.mp3', 1, '')
                    """,
                    (source, user),
                )
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO audio_tracks
                        (source_id, user_id, track_number, blob_ref, byte_size, title)
                    VALUES (%s, %s, 10, '1/x.mp3', 1, %s)
                    """,
                    (source, user, "가" * 501),
                )

        # One display position per set.
        _seed_track(conn, source, user, track_number=1)
        with pytest.raises(errors.UniqueViolation):
            _seed_track(conn, source, user, track_number=1, blob_ref="1/other.mp3")

        # updated_at trigger fires on UPDATE.
        track = _seed_track(conn, source, user, track_number=2)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT updated_at FROM audio_tracks WHERE id = %s", (track,))
            before = cur.fetchone()[0]
            cur.execute(
                "UPDATE audio_tracks SET transcript_status = 'done' WHERE id = %s",
                (track,),
            )
            cur.execute("SELECT updated_at FROM audio_tracks WHERE id = %s", (track,))
            after = cur.fetchone()[0]
        assert after > before, "set_updated_at trigger must bump updated_at"


# ---------------------------------------------------------------------------
# 4. UP — the composite owner guards: cross-user writes are structurally
#    rejected (23503) on BOTH parent links.
# ---------------------------------------------------------------------------

def test_074_cross_user_source_and_chapter_pairs_are_rejected(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    """The 044 bar on both FKs: a raw SQL write (bugged or bypassed loader)
    can neither tag a track with a user who doesn't own its set (the
    streaming probe's IDOR primitive) nor align a track to another user's
    reading chapter."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_a = _seed_user(conn, "a1-guard-a@example.com")
        user_b = _seed_user(conn, "a1-guard-b@example.com")
        source_a = _seed_source(conn, user_a)
        book_b = _seed_book_upload(conn, user_b)
        chapter_b = _seed_chapter(conn, book_b, user_b)

        # A track in user_a's set tagged with user_b: no (source_a, user_b)
        # pair in audio_sources -> 23503.
        with pytest.raises(errors.ForeignKeyViolation):
            _seed_track(conn, source_a, user_b)

        # user_a's track aligned to user_b's chapter: no (chapter_b, user_a)
        # pair in reading_chapters -> 23503.
        with pytest.raises(errors.ForeignKeyViolation):
            _seed_track(conn, source_a, user_a, chapter_id=chapter_b)

        # The honest same-owner write still passes.
        _seed_track(conn, source_a, user_a)


# ---------------------------------------------------------------------------
# 5. UP — lifecycle: the chapter carve-out, set CASCADE, user CASCADE.
# ---------------------------------------------------------------------------

def test_074_chapter_delete_degrades_without_erasing_the_track(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "a1-align@example.com")
        book = _seed_book_upload(conn, user)
        chapter = _seed_chapter(conn, book, user)
        source = _seed_source(conn, user)
        track = _seed_track(conn, source, user, chapter_id=chapter)

        # A book re-load prunes the chapter — must succeed (no RESTRICT) and
        # must NOT erase the transcribed track (no CASCADE): the alignment
        # degrades to NULL.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("DELETE FROM reading_chapters WHERE id = %s", (chapter,))
            cur.execute(
                "SELECT chapter_id, blob_ref FROM audio_tracks WHERE id = %s", (track,)
            )
            row = cur.fetchone()
            assert row is not None, "the track must survive its chapter's removal"
            assert row[0] is None, "chapter_id must SET NULL, not block the delete"
            assert row[1] == "1/track.mp3"


def test_074_set_and_user_deletes_cascade(env, dsn: str, full_dir: pathlib.Path) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "a1-cascade@example.com")
        source_a = _seed_source(conn, user, slug="set-a")
        source_b = _seed_source(conn, user, slug="set-b")
        track_a = _seed_track(conn, source_a, user)
        track_b = _seed_track(conn, source_b, user)

        with conn.cursor(row_factory=tuple_row) as cur:
            # Deleting a set deletes its track rows (blob files are the
            # route/loader's post-commit problem — 041's posture).
            cur.execute("DELETE FROM audio_sources WHERE id = %s", (source_a,))
            cur.execute("SELECT count(*) FROM audio_tracks WHERE id = %s", (track_a,))
            assert cur.fetchone()[0] == 0, "tracks must CASCADE with their set"

            # Deleting the user takes everything.
            cur.execute("DELETE FROM users WHERE id = %s", (user,))
            cur.execute("SELECT count(*) FROM audio_tracks WHERE id = %s", (track_b,))
            assert cur.fetchone()[0] == 0, "tracks must CASCADE with their user"
            cur.execute("SELECT count(*) FROM audio_sources WHERE id = %s", (source_b,))
            assert cur.fetchone()[0] == 0


# ---------------------------------------------------------------------------
# 6. DOWN — destructive gate; table + its §0 backing UNIQUE gone, neighbors
#    untouched; re-up clean.
# ---------------------------------------------------------------------------

def test_074_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", PRE_074, "down"])
    assert rc != 0, "074.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_074, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {PRE_074} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert not _table_exists(conn, "audio_tracks")
        # The §0 backing UNIQUE goes down with 074 (044's-down posture for
        # uq_book_uploads_id_user) — the round-trip must leave
        # reading_chapters byte-identical to its pre-074 shape.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                SELECT count(*) FROM pg_constraint
                 WHERE conname = 'uq_reading_chapters_id_user'
                   AND conrelid = 'reading_chapters'::regclass
                """
            )
            assert cur.fetchone()[0] == 0, (
                "uq_reading_chapters_id_user must drop with 074"
            )
        # Neighbors untouched (073, one level below the target, included).
        assert _table_exists(conn, "audio_sources")
        assert _table_exists(conn, "reading_chapters")
        assert _table_exists(conn, "users")

    # Re-up: 074..077 apply cleanly again.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_exists(conn, "audio_tracks")
