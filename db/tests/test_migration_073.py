"""Migration 073 (audio_sources, Track A A-1) — real-chain tests.

WHY THIS FILE EXISTS:
    073 is the Listen surface's set/collection table — the book_uploads
    analog for Track A audio. Its value is in the lifecycle + ownership
    topology, and one behavior is DESIGN-LOAD-BEARING: source_upload_id (the
    paired-reader book link) rides 044's COMPOSITE owner FK —
    (source_upload_id, user_id) -> book_uploads(id, user_id) — with the
    PG 15+ COLUMN-LIST action ``ON DELETE SET NULL (source_upload_id)``
    (051's exact mechanism), so cross-user pairing is structurally
    impossible AND the audio set SURVIVES its paired book's deletion with
    only the link nulled (the NOT NULL user_id untouched). These tests apply
    the REAL migration chain against a real Postgres-16 testcontainer via
    ``migrate.main()`` and PROVE each guard by attempting the write (or
    delete) it must reject or survive.

SCOPE:
    - markers: up is non-destructive, down destructive (F-088 classification).
    - up: applies on the full real chain; re-applying the body is a no-op
      (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, CREATE OR
      REPLACE TRIGGER are all re-runnable).
    - shape: users FK CASCADEs; the book FK is COMPOSITE (2 columns) with a
      1-column SET NULL list (never RESTRICT/CASCADE); uq_audio_sources_id_user
      (074's composite-FK backing) exists; the listing index + the partial
      paired-link index exist.
    - CHECKs: kind/status closed sets reject non-members; slug/title length
      bounds (both ends); the one-directional kind<->link CHECK rejects a
      standalone set carrying a book link; UNIQUE (user_id, slug) rejects a
      same-user duplicate but admits the same slug for another user (the
      loader upsert key is per-user).
    - the composite owner-FK pin: a cross-user (book, user) pair is REJECTED
      (23503); deleting the paired book keeps the audio set and nulls ONLY
      source_upload_id; deleting the user CASCADEs their sets.
    - down: refused without --allow-destructive; with it, the table is gone
      and neighbors (book_uploads, users) untouched; re-up clean.

DETERMINISM:
    Mirrors test_migration_069.py — the real migration files are copied into
    a tmp_path-scoped directory and the runner is pointed at it via
    ``--migrations-dir``; the ``dsn`` fixture gives each test a fresh schema.
"""

from __future__ import annotations

import pathlib

import psycopg
import pytest
from psycopg import errors
from psycopg.rows import dict_row, tuple_row

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

# The migration immediately before 073. `down --target PRE_073` rolls back
# ONLY 073 (its DROP TABLE down is what requires --allow-destructive).
PRE_073 = "072"


# ---------------------------------------------------------------------------
# Seed helpers — raw SQL, no app layer involved
# ---------------------------------------------------------------------------


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


def _seed_source(
    conn: psycopg.Connection,
    user_id: int,
    slug: str = "korean-folktales",
    kind: str = "standalone_listening",
    source_upload_id: int | None = None,
    title: str = "전래동화",
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO audio_sources (user_id, slug, title, kind, source_upload_id)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id
            """,
            (user_id, slug, title, kind, source_upload_id),
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

def test_073_marker_classification() -> None:
    up_sql = (REAL_MIGRATIONS_DIR / "073_audio_sources.up.sql").read_text(
        encoding="utf-8"
    )
    down_sql = (REAL_MIGRATIONS_DIR / "073_audio_sources.down.sql").read_text(
        encoding="utf-8"
    )
    assert migrate.explicit_destructiveness(up_sql) is False
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — schema shape; the body is re-runnable.
# ---------------------------------------------------------------------------

def test_073_up_schema_shape_and_reapply_is_idempotent(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    up_sql = (REAL_MIGRATIONS_DIR / "073_audio_sources.up.sql").read_text(
        encoding="utf-8"
    )
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        assert _table_exists(conn, "audio_sources")

        # Drive the body a second time directly (the runner skips an applied
        # version): CREATE TABLE/INDEX IF NOT EXISTS + CREATE OR REPLACE
        # TRIGGER must all be re-runnable.
        with conn.cursor() as cur:
            cur.execute(up_sql)

        with conn.cursor() as cur:
            # users FK is single-column CASCADE; the book FK is the COMPOSITE
            # owner guard (2 referencing columns) with a 1-column SET NULL
            # list — column-list form nulls ONLY source_upload_id (051's
            # mechanism), never RESTRICT or CASCADE.
            for conname, target, deltype, ncols, nsetcols in (
                ("fk_audio_sources_user", "users", "c", 1, 0),
                ("fk_audio_sources_upload", "book_uploads", "n", 2, 1),
            ):
                cur.execute(
                    """
                    SELECT confrelid::regclass::text AS target, confdeltype,
                           cardinality(conkey) AS ncols,
                           coalesce(cardinality(confdelsetcols), 0) AS nsetcols
                      FROM pg_constraint
                     WHERE conname = %s AND conrelid = 'audio_sources'::regclass
                    """,
                    (conname,),
                )
                fk = cur.fetchone()
                assert fk is not None, f"{conname} missing"
                assert fk["target"] == target
                assert fk["confdeltype"] == deltype
                assert fk["ncols"] == ncols, f"{conname}: FK arity {fk['ncols']}"
                assert fk["nsetcols"] == nsetcols, (
                    f"{conname}: SET NULL column-list arity {fk['nsetcols']}"
                )

            # 074's composite-FK backing: UNIQUE (id, user_id) exists.
            cur.execute(
                """
                SELECT 1 FROM pg_constraint
                 WHERE conname = 'uq_audio_sources_id_user'
                   AND conrelid = 'audio_sources'::regclass
                   AND contype = 'u'
                """
            )
            assert cur.fetchone() is not None, "uq_audio_sources_id_user missing"

            cur.execute(
                """
                SELECT indexdef FROM pg_indexes
                 WHERE indexname = 'ix_audio_sources_user_created'
                """
            )
            idx = cur.fetchone()
            assert idx is not None, "listing index missing"
            assert "user_id" in idx["indexdef"] and "created_at DESC" in idx["indexdef"]

            # The paired-link reverse-lookup / FK-scan index is partial.
            cur.execute(
                """
                SELECT indexdef FROM pg_indexes
                 WHERE indexname = 'ix_audio_sources_upload'
                """
            )
            idx = cur.fetchone()
            assert idx is not None, "paired-link index missing"
            assert "source_upload_id IS NOT NULL" in idx["indexdef"], (
                "index must be partial"
            )


# ---------------------------------------------------------------------------
# 3. UP — CHECKs + the per-user upsert key.
# ---------------------------------------------------------------------------

def test_073_up_checks_and_upsert_key(env, dsn: str, full_dir: pathlib.Path) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_a = _seed_user(conn, "a1-sources-a@example.com")
        user_b = _seed_user(conn, "a1-sources-b@example.com")

        # kind is a closed set.
        with pytest.raises(errors.CheckViolation):
            _seed_source(conn, user_a, slug="bad-kind", kind="bogus")

        # status is a closed set.
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO audio_sources (user_id, slug, title, kind, status)
                    VALUES (%s, 'bad-status', 'x', 'topik', 'bogus')
                    """,
                    (user_a,),
                )

        # slug/title length bounds (both ends — mirrors 075's stance).
        with pytest.raises(errors.CheckViolation):
            _seed_source(conn, user_a, slug="")
        with pytest.raises(errors.CheckViolation):
            _seed_source(conn, user_a, slug="s" * 201)
        with pytest.raises(errors.CheckViolation):
            _seed_source(conn, user_a, slug="empty-title", title="")
        with pytest.raises(errors.CheckViolation):
            _seed_source(conn, user_a, slug="long-title", title="가" * 501)

        # The kind<->link CHECK: a standalone/topik set may not carry a book
        # link (one-directional — NULL always passes, so the FK's SET NULL
        # degradation can never trip it).
        book_a = _seed_book_upload(conn, user_a, title="체크용 책")
        with pytest.raises(errors.CheckViolation):
            _seed_source(
                conn, user_a, slug="standalone-with-link",
                kind="standalone_listening", source_upload_id=book_a,
            )

        # The loader upsert key: same (user, slug) rejected; the same slug is
        # fine for a DIFFERENT user (the key is per-user, mirroring 040's
        # UNIQUE (user_id, title)).
        _seed_source(conn, user_a, slug="ttmik-grammar-audio")
        with pytest.raises(errors.UniqueViolation):
            _seed_source(conn, user_a, slug="ttmik-grammar-audio")
        _seed_source(conn, user_b, slug="ttmik-grammar-audio")

        # updated_at trigger fires on UPDATE.
        source = _seed_source(conn, user_a, slug="trigger-check")
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT updated_at FROM audio_sources WHERE id = %s", (source,))
            before = cur.fetchone()[0]
            cur.execute(
                "UPDATE audio_sources SET status = 'ready' WHERE id = %s", (source,)
            )
            cur.execute("SELECT updated_at FROM audio_sources WHERE id = %s", (source,))
            after = cur.fetchone()[0]
        assert after > before, "set_updated_at trigger must bump updated_at"


# ---------------------------------------------------------------------------
# 4. The composite owner guard: cross-user pairing is structurally rejected.
# ---------------------------------------------------------------------------

def test_073_cross_user_book_pairing_is_rejected(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    """The 044/051 bar: (source_upload_id, user_id) must be a real
    book_uploads(id, user_id) pair, so even a raw SQL write (a bugged or
    bypassed route) cannot pair an audio set with ANOTHER user's book."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_a = _seed_user(conn, "a1-owner-a@example.com")
        user_b = _seed_user(conn, "a1-owner-b@example.com")
        book_a = _seed_book_upload(conn, user_a)

        # user_b tries to pair a set with user_a's book: the composite FK
        # finds no (book_a, user_b) pair in book_uploads -> 23503.
        with pytest.raises(errors.ForeignKeyViolation):
            _seed_source(
                conn, user_b, slug="stolen-pairing", kind="paired_reader",
                source_upload_id=book_a,
            )

        # The true owner pairs it fine.
        _seed_source(
            conn, user_a, slug="honest-pairing", kind="paired_reader",
            source_upload_id=book_a,
        )


# ---------------------------------------------------------------------------
# 5. The column-list SET NULL pin: a paired set survives its book's deletion
#    (only the link nulled), and CASCADEs with its user.
# ---------------------------------------------------------------------------

def test_073_book_delete_unpairs_but_keeps_the_set(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "a1-unpair@example.com")
        book = _seed_book_upload(conn, user)
        source = _seed_source(
            conn, user, slug="easy-korean-reading", kind="paired_reader",
            source_upload_id=book,
        )

        with conn.cursor(row_factory=tuple_row) as cur:
            # Deleting the paired book must succeed (no RESTRICT) and must
            # NOT take the audio set with it (no CASCADE): the composite
            # FK's COLUMN-LIST action — ON DELETE SET NULL (source_upload_id),
            # PG 15+, 051's mechanism — nulls ONLY the link. A plain SET NULL
            # on this composite would instead abort here trying to null the
            # NOT NULL user_id.
            cur.execute("DELETE FROM book_uploads WHERE id = %s", (book,))
            cur.execute(
                "SELECT source_upload_id, user_id FROM audio_sources WHERE id = %s",
                (source,),
            )
            row = cur.fetchone()
            assert row is not None, "the audio set must survive its book's deletion"
            assert row[0] is None, "source_upload_id must be SET NULL, not dangle"
            assert row[1] == user, "the owner column is untouched by the un-pair"

        # A deleted USER takes their sets with them.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (user,))
            cur.execute("SELECT count(*) FROM audio_sources WHERE id = %s", (source,))
            assert cur.fetchone()[0] == 0, "sets must CASCADE with their user"


# ---------------------------------------------------------------------------
# 6. DOWN — destructive gate; table gone, neighbors untouched; re-up clean.
# ---------------------------------------------------------------------------

def test_073_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    # Refused without the flag (DROP TABLE + explicit marker). NOTE: the
    # rollback path 077..073 is all-destructive, so the gate trips on 077
    # first — the point stands: nothing is applied without the flag.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", PRE_073, "down"])
    assert rc != 0, "073.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_073, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {PRE_073} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert not _table_exists(conn, "audio_sources")
        # Neighbors untouched.
        assert _table_exists(conn, "book_uploads")
        assert _table_exists(conn, "users")

    # Re-up: the whole 073..077 block applies cleanly again.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_exists(conn, "audio_sources")
        user = _seed_user(conn, "a1-reup@example.com")
        _seed_source(conn, user, slug="post-reup")
