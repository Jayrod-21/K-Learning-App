"""Migration 065 (one recognition card per (user, vocab entry), F-113
fix-pass SHOULD-FIX #1) — real-data tests.

WHY THIS FILE EXISTS:
    065 adds a partial UNIQUE index on `vocab_cards (user_id, vocab_entry_id)`
    scoped to `face = 'recognition' AND vocab_entry_id IS NOT NULL AND
    deleted_at IS NULL` — but unlike 020/050 (which land on a table with no
    pre-existing violations of their own new constraint), 065's whole reason
    for existing is that the constraint it adds may ALREADY be violated on a
    live database: `POST /vocab/lists/:id/cards/seed`, `POST /vocab/cards/
    init`, and `POST /vocab/entries/:id/bank` have all shipped with a bare
    NOT-EXISTS-then-INSERT (not atomic under concurrent transactions), so a
    live table MAY already hold duplicate (user, vocab_entry, recognition)
    rows. A bare `CREATE UNIQUE INDEX` over such data would FAIL and abort
    the whole migration/deploy. These tests apply the REAL migration chain
    against a Postgres-16 testcontainer, seed duplicate rows in the pre-065
    shape (exactly what a real gap-affected production table could hold),
    and prove the de-dupe-then-index up path succeeds on a POPULATED table —
    not just an empty one — keeping the earliest row and soft-deleting the
    rest, then indexing cleanly.

SCOPE:
    - up (populated table): 3 duplicate live recognition cards for the same
      (user, vocab_entry) collapse to 1 survivor (the lowest id) + 2
      soft-deleted rows; an unrelated (different user / different entry /
      different face / already-soft-deleted) row is untouched; the index
      exists afterward and rejects a fresh duplicate insert.
    - up (clean table, no duplicates): a no-op de-dupe, index still created,
      existing single cards untouched byte-for-byte.
    - down: drops the index only; the soft-deleted duplicates from the
      up-migration's de-dupe step are NOT un-deleted (documented, one-way
      data cleanup — matches 065.down's own header).

DETERMINISM:
    Mirrors test_migration_050.py / test_migration_064.py: real migration
    files copied into a tmp_path-scoped dir, runner pointed at it via
    --migrations-dir, fresh schema per test.
"""

from __future__ import annotations

import pathlib
import shutil

import psycopg
import pytest
from psycopg.errors import UniqueViolation
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

# The migration immediately before 065 — seeding here reproduces the exact
# pre-065 schema (no unique index yet), so duplicate INSERTs succeed exactly
# as they would have on a real pre-fix production table.
PRE_065 = "064"

FAKE_HASH = "$argon2id$" + "x" * 70


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
    d = tmp_path / "migrations_full"
    d.mkdir(parents=True)
    copied = 0
    for src in REAL_MIGRATIONS_DIR.iterdir():
        if src.suffix == ".sql" and src.is_file():
            shutil.copy2(src, d / src.name)
            copied += 1
    assert copied > 0, f"no migration files found under {REAL_MIGRATIONS_DIR}"
    return d


def _up_to(dir_: pathlib.Path, target: str | None = None) -> None:
    args = ["--migrations-dir", str(dir_), "--allow-destructive"]
    if target is not None:
        args += ["--target", target]
    args.append("up")
    rc = migrate.main(args)
    assert rc == 0, f"up (target={target}) returned {rc}"


# ---------------------------------------------------------------------------
# Seed helpers — pre-065 rows in raw SQL (mirrors test_migration_050.py)
# ---------------------------------------------------------------------------

def _seed_user(conn: psycopg.Connection, email: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id",
            (email, FAKE_HASH),
        )
        return cur.fetchone()[0]


def _corpus_source_id(conn: psycopg.Connection) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute("SELECT id FROM corpus_sources WHERE corpus = 'vocab_2000_intermediate'")
        row = cur.fetchone()
        if row is not None:
            return row[0]
        cur.execute(
            """
            INSERT INTO corpus_sources
                (corpus, title, level, source_path, default_proficiency)
            VALUES ('vocab_2000_intermediate', 'test corpus',
                    'intermediate'::book_level, 'test/test.json',
                    'L3'::proficiency_level)
            RETURNING id
            """
        )
        return cur.fetchone()[0]


def _seed_vocab_entry(conn: psycopg.Connection, source_id: str, korean: str = "먹다") -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        corpus_source_id = _corpus_source_id(conn)
        cur.execute(
            """
            INSERT INTO vocab_entries
                (corpus_source_id, corpus, source_id, book_level, entry_type,
                 source_book, korean, english, proficiency)
            VALUES (%s, 'vocab_2000_intermediate'::corpus, %s,
                    'intermediate'::book_level, 'word'::vocab_entry_type,
                    'test-book', %s, 'to eat', 'L3'::proficiency_level)
            RETURNING id
            """,
            (corpus_source_id, source_id, korean),
        )
        return cur.fetchone()[0]


def _seed_recognition_card(
    conn: psycopg.Connection,
    user_id: int,
    vocab_entry_id: int,
    deleted: bool = False,
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO vocab_cards (user_id, face, vocab_entry_id, deleted_at)
            VALUES (%s, 'recognition'::card_face, %s, CASE WHEN %s THEN now() ELSE NULL END)
            RETURNING id
            """,
            (user_id, vocab_entry_id, deleted),
        )
        return cur.fetchone()[0]


def _index_names(conn: psycopg.Connection, table: str) -> set[str]:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=%s",
            (table,),
        )
        return {r[0] for r in cur.fetchall()}


def _live_cards(conn: psycopg.Connection, user_id: int, vocab_entry_id: int) -> list[dict]:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            SELECT id, deleted_at FROM vocab_cards
             WHERE user_id = %s AND vocab_entry_id = %s AND face = 'recognition'
             ORDER BY id
            """,
            (user_id, vocab_entry_id),
        )
        return cur.fetchall()


# ---------------------------------------------------------------------------
# 1. UP on a POPULATED table with real duplicates — the crux of this migration
# ---------------------------------------------------------------------------

def test_065_up_dedupes_existing_duplicates_before_indexing(env, dsn: str, full_dir) -> None:
    """Seed 3 duplicate live recognition cards for the same (user, vocab
    entry) in the pre-065 shape (no unique index yet — this INSERT sequence
    would be rejected post-065), then apply 065 and prove: exactly 1
    survivor (the lowest id), the other 2 soft-deleted; an unrelated row
    (different user, different entry, different face, already-deleted) is
    left completely alone; the index exists and now rejects a fresh
    duplicate insert."""
    _up_to(full_dir, target=PRE_065)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "dupe-owner@example.com")
        other_user = _seed_user(conn, "other-user@example.com")
        entry = _seed_vocab_entry(conn, "dupe-word-1")
        other_entry = _seed_vocab_entry(conn, "dupe-word-2", korean="가다")

        # The actual pre-existing gap: 3 concurrent-seed-race duplicates for
        # (user, entry, recognition). Card ids increase monotonically, so
        # `first` is guaranteed the lowest id.
        first = _seed_recognition_card(conn, user, entry)
        second = _seed_recognition_card(conn, user, entry)
        third = _seed_recognition_card(conn, user, entry)

        # Give the survivor-candidate SOME review history so we can prove
        # the KEPT row is genuinely the earliest one, not an arbitrary one.
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE vocab_cards SET stability = 12.5 WHERE id = %s", (first,)
            )

        # Unrelated rows that must NOT be touched by the de-dupe:
        different_user_card = _seed_recognition_card(conn, other_user, entry)
        different_entry_card = _seed_recognition_card(conn, user, other_entry)
        already_deleted_card = _seed_recognition_card(conn, user, entry, deleted=True)
        # A production-face card for the SAME (user, entry) — different face,
        # must survive (the index/de-dupe is face-scoped).
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                INSERT INTO vocab_cards (user_id, face, vocab_entry_id)
                VALUES (%s, 'production'::card_face, %s) RETURNING id
                """,
                (user, entry),
            )
            production_card = cur.fetchone()[0]

    # This is the assertion that matters: the de-dupe-then-index path must
    # succeed on a table that ALREADY violates the constraint being added.
    _up_to(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        rows = _live_cards(conn, user, entry)
        live = [r for r in rows if r["deleted_at"] is None]
        soft_deleted = [r for r in rows if r["deleted_at"] is not None]

        assert len(live) == 1, f"expected exactly 1 survivor, got {live}"
        assert live[0]["id"] == first, "the EARLIEST (lowest id) row must survive"
        # `_live_cards` matches on (user, entry, face) regardless of
        # deleted_at, so this set also includes `already_deleted_card` (which
        # was ALREADY soft-deleted before 065 ever ran, on purpose — see
        # below) alongside the two duplicates the migration itself de-duped.
        assert {r["id"] for r in soft_deleted} == {second, third, already_deleted_card}, (
            "the two later duplicates must be soft-deleted, not hard-deleted"
        )

        # The survivor's own data (stability we set) is untouched by the
        # de-dupe — it's a soft-delete of the SIBLINGS, not a merge/rewrite.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT stability FROM vocab_cards WHERE id = %s", (first,))
            assert float(cur.fetchone()[0]) == 12.5

        # Unrelated rows are completely untouched.
        with conn.cursor(row_factory=tuple_row) as cur:
            for card_id in (
                different_user_card,
                different_entry_card,
                production_card,
            ):
                cur.execute(
                    "SELECT deleted_at FROM vocab_cards WHERE id = %s", (card_id,)
                )
                assert cur.fetchone()[0] is None, f"card {card_id} must stay live"
            cur.execute(
                "SELECT deleted_at FROM vocab_cards WHERE id = %s", (already_deleted_card,)
            )
            deleted_at = cur.fetchone()[0]
            assert deleted_at is not None, "the pre-deleted row must remain deleted"

        # The index now exists…
        assert "uq_vocab_cards_user_vocab_recognition" in _index_names(conn, "vocab_cards")

        # …and actually enforces going forward: a fresh duplicate insert for
        # the surviving (user, entry, recognition) triple is rejected.
        with pytest.raises(UniqueViolation):
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO vocab_cards (user_id, face, vocab_entry_id)
                    VALUES (%s, 'recognition'::card_face, %s)
                    """,
                    (user, entry),
                )
        # …while re-carding the SOFT-DELETED duplicate's slot (a fresh card
        # after a real removal) still works — the partial index is
        # deleted_at-aware, matching every other soft-delete guard in this
        # schema (020/050).
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE vocab_cards SET deleted_at = now() WHERE id = %s", (first,)
            )
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                INSERT INTO vocab_cards (user_id, face, vocab_entry_id)
                VALUES (%s, 'recognition'::card_face, %s) RETURNING id
                """,
                (user, entry),
            )
            assert cur.fetchone() is not None


# ---------------------------------------------------------------------------
# 2. UP on a CLEAN table (no duplicates) — de-dupe is a true no-op
# ---------------------------------------------------------------------------

def test_065_up_is_a_noop_on_a_table_with_no_duplicates(env, dsn: str, full_dir) -> None:
    _up_to(full_dir, target=PRE_065)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "clean-table@example.com")
        entry = _seed_vocab_entry(conn, "single-word")
        card = _seed_recognition_card(conn, user, entry)

    _up_to(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        rows = _live_cards(conn, user, entry)
        assert len(rows) == 1
        assert rows[0]["id"] == card
        assert rows[0]["deleted_at"] is None
        assert "uq_vocab_cards_user_vocab_recognition" in _index_names(conn, "vocab_cards")


# ---------------------------------------------------------------------------
# 3. DOWN — drops the index only; does NOT restore the soft-deleted duplicates
# ---------------------------------------------------------------------------

def test_065_down_drops_index_but_leaves_soft_deletes_in_place(env, dsn: str, full_dir) -> None:
    _up_to(full_dir, target=PRE_065)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "down-test@example.com")
        entry = _seed_vocab_entry(conn, "down-word")
        first = _seed_recognition_card(conn, user, entry)
        second = _seed_recognition_card(conn, user, entry)

    _up_to(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        rows = {r["id"]: r["deleted_at"] for r in _live_cards(conn, user, entry)}
        assert rows[first] is None
        assert rows[second] is not None

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_065, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {PRE_065} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert "uq_vocab_cards_user_vocab_recognition" not in _index_names(conn, "vocab_cards")
        # The de-dupe's soft-delete is NOT undone by the down migration
        # (documented, one-way data cleanup — see 065.down's header).
        rows = {r["id"]: r["deleted_at"] for r in _live_cards(conn, user, entry)}
        assert rows[first] is None
        assert rows[second] is not None, (
            "down must not resurrect a de-duped duplicate"
        )

    # Re-up: 065 applies cleanly again (idempotent CREATE UNIQUE INDEX IF NOT
    # EXISTS; the de-dupe UPDATE is a no-op the second time since nothing new
    # violates the predicate).
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0, f"re-apply of 065 after rollback returned {rc}"
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert "uq_vocab_cards_user_vocab_recognition" in _index_names(conn, "vocab_cards")
