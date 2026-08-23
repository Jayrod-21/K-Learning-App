"""Migration 091 (fts_removal, audit §4.2) — real-chain tests.

WHY THIS FILE EXISTS:
    091 removes the orphaned full-text-search subsystem — for six content
    tables (krdict_entries, kgiu_entries, vocab_entries, ttmik_sentences,
    iyagi_sentences, topik_items) it drops the `search_tsv` tsvector column,
    the GIN index, the BEFORE INSERT/UPDATE trigger, and the trigger function.
    The tests pin the contract in BOTH directions, which is what makes the
    "non-destructive" classification honest:
      * UP removes all 24 objects (4 per table × 6 tables).
      * DOWN restores all 24 objects AND backfills search_tsv on existing rows
        (so the rollback is byte-faithful, not just structurally present).
      * A re-applied UP body is a no-op (every DROP is IF EXISTS).
      * After DOWN the recreated trigger actually maintains search_tsv on write.

DETERMINISM:
    Mirrors test_migration_090.py — the real migration files are copied into a
    tmp_path-scoped directory and the runner is pointed at it via
    ``--migrations-dir``; the ``dsn`` fixture gives each test a fresh schema.
"""

from __future__ import annotations

import hashlib
import pathlib
import re
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

# The migration immediately before 091. `down --target PRE_091` rolls back
# ONLY 091.
PRE_091 = "090"

# (table, gin index, trigger, trigger function) for each FTS-bearing table.
FTS_OBJECTS = [
    ("krdict_entries", "ix_krdict_entries_search_tsv", "trg_krdict_entries_tsv", "krdict_entries_tsv_refresh"),
    ("kgiu_entries", "ix_kgiu_entries_search_tsv", "trg_kgiu_entries_tsv", "kgiu_entries_tsv_refresh"),
    ("vocab_entries", "ix_vocab_entries_search_tsv", "trg_vocab_entries_tsv", "vocab_entries_tsv_refresh"),
    ("ttmik_sentences", "ix_ttmik_sentences_search_tsv", "trg_ttmik_sentences_tsv", "ttmik_sentences_tsv_refresh"),
    ("iyagi_sentences", "ix_iyagi_sentences_search_tsv", "trg_iyagi_sentences_tsv", "iyagi_sentences_tsv_refresh"),
    ("topik_items", "ix_topik_items_search_tsv", "trg_topik_items_tsv", "topik_items_tsv_refresh"),
]


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


def _down_to_pre_091(full_dir: pathlib.Path) -> None:
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_091, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {PRE_091} returned {rc}"


# ---------------------------------------------------------------------------
# Object-presence predicates
# ---------------------------------------------------------------------------

def _column_exists(conn: psycopg.Connection, table: str, column: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = %s AND column_name = %s",
            (table, column),
        )
        return cur.fetchone() is not None


def _index_exists(conn: psycopg.Connection, index: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute("SELECT 1 FROM pg_indexes WHERE indexname = %s", (index,))
        return cur.fetchone() is not None


def _trigger_exists(conn: psycopg.Connection, trigger: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT 1 FROM pg_trigger WHERE tgname = %s AND NOT tgisinternal", (trigger,)
        )
        return cur.fetchone() is not None


def _function_exists(conn: psycopg.Connection, function: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute("SELECT 1 FROM pg_proc WHERE proname = %s", (function,))
        return cur.fetchone() is not None


# ---------------------------------------------------------------------------
# 1. UP — every FTS object is gone
# ---------------------------------------------------------------------------

def test_091_up_removes_all_fts_objects(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        for table, index, trigger, function in FTS_OBJECTS:
            assert not _column_exists(conn, table, "search_tsv"), f"{table}.search_tsv still present"
            assert not _index_exists(conn, index), f"{index} still present"
            assert not _trigger_exists(conn, trigger), f"{trigger} still present"
            assert not _function_exists(conn, function), f"{function} still present"


# ---------------------------------------------------------------------------
# 2. DOWN — every FTS object is restored
# ---------------------------------------------------------------------------

def test_091_down_restores_all_fts_objects(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)
    _down_to_pre_091(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        for table, index, trigger, function in FTS_OBJECTS:
            assert _column_exists(conn, table, "search_tsv"), f"{table}.search_tsv not restored"
            assert _index_exists(conn, index), f"{index} not restored"
            assert _trigger_exists(conn, trigger), f"{trigger} not restored"
            assert _function_exists(conn, function), f"{function} not restored"

    # Re-up: 091 re-applies cleanly, the objects are gone again.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        for table, _index, _trigger, _function in FTS_OBJECTS:
            assert not _column_exists(conn, table, "search_tsv"), f"{table}.search_tsv back after re-up"


# ---------------------------------------------------------------------------
# 3. UP — re-applying the up body is a no-op (every DROP is IF EXISTS)
# ---------------------------------------------------------------------------

def test_091_reapply_up_body_is_noop(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)
    up_sql = (REAL_MIGRATIONS_DIR / "091_fts_removal.up.sql").read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(up_sql)  # must not raise on already-dropped objects
        for table, _index, _trigger, _function in FTS_OBJECTS:
            assert not _column_exists(conn, table, "search_tsv"), f"{table}.search_tsv reappeared on reapply"


# ---------------------------------------------------------------------------
# 4. DOWN — backfills existing rows AND the recreated trigger maintains writes
# ---------------------------------------------------------------------------

def _seed_ttmik_sentence(conn: psycopg.Connection, korean: str) -> int:
    """Seed the corpus_sources -> ttmik_lessons -> ttmik_sentences chain and
    return the sentence id. Runs while search_tsv is DROPPED (post-up), so the
    insert cannot reference it — exactly the state a real row is in when the
    down migration's backfill has to populate it."""
    with conn.cursor(row_factory=tuple_row) as cur:
        # corpus_sources is UNIQUE per corpus and ttmik_lessons UNIQUE per
        # (corpus, source_id) — so both calls share ONE source + lesson and
        # differ only by the sentence row (unique content_hash below).
        cur.execute(
            "INSERT INTO corpus_sources (corpus, title, level, source_path, default_proficiency) "
            "VALUES ('ttmik', 't', 'beginner'::book_level, 'test/ttmik.json', 'L3'::proficiency_level) "
            "ON CONFLICT (corpus) DO NOTHING"
        )
        cur.execute("SELECT id FROM corpus_sources WHERE corpus = 'ttmik'")
        source_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO ttmik_lessons "
            "(corpus_source_id, source_id, lesson_level, lesson_number, ordinal) "
            "VALUES (%s, 'ttmik-L1-01', 1, 1, 1) ON CONFLICT (corpus, source_id) DO NOTHING",
            (source_id,),
        )
        cur.execute(
            "SELECT id FROM ttmik_lessons WHERE corpus = 'ttmik' AND source_id = 'ttmik-L1-01'"
        )
        lesson_id = cur.fetchone()[0]
        # content_hash must match ^[0-9a-f]{64}$ (ck_ttmik_sentences_content_hash_shape);
        # a real sha256 is both valid-shaped and unique per korean text.
        content_hash = hashlib.sha256(korean.encode("utf-8")).hexdigest()
        cur.execute(
            "INSERT INTO ttmik_sentences (lesson_id, ordinal, korean, content_hash) "
            "VALUES (%s, 1, %s, %s) RETURNING id",
            (lesson_id, korean, content_hash),
        )
        return cur.fetchone()[0]


def _search_tsv(conn: psycopg.Connection, sentence_id: int) -> str | None:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT search_tsv::text FROM ttmik_sentences WHERE id = %s", (sentence_id,)
        )
        row = cur.fetchone()
        return row[0] if row else None


def _has_weighted_lexeme(tsv_text: str, token: str, weight: str) -> bool:
    """True if `token` appears in the tsvector's ::text form tagged with
    `weight` at some position — e.g. `'사과':1A` for token='사과', weight='A'.
    Position number is deliberately not pinned (only the weight letter is),
    since ordinal position is an implementation detail of to_tsvector, not
    of setweight()."""
    return re.search(rf"'{re.escape(token)}':\d+{weight}\b", tsv_text) is not None


def test_091_down_backfills_existing_rows_and_trigger_maintains_writes(
    env, dsn: str, full_dir
) -> None:
    _full_up(full_dir)  # search_tsv dropped

    with psycopg.connect(dsn, autocommit=True) as conn:
        pre_existing_id = _seed_ttmik_sentence(conn, "사과")  # "apple"

    _down_to_pre_091(full_dir)  # re-adds column + trigger + backfills

    with psycopg.connect(dsn, autocommit=True) as conn:
        # Backfill populated the row that existed before the down ran.
        backfilled = _search_tsv(conn, pre_existing_id)
        assert backfilled is not None and backfilled != "", "backfill left search_tsv empty"
        assert "사과" in backfilled, f"backfilled tsv missing the source token: {backfilled}"
        # `korean` is weight A on ttmik_sentences (setweight(..., 'A')) — assert
        # the weight LABEL survived, not just the lexeme, so a regression that
        # dropped setweight() (leaving an unweighted 'D'-default or bare
        # to_tsvector() call) would fail this test instead of hiding behind a
        # substring-only check.
        assert _has_weighted_lexeme(backfilled, "사과", "A"), (
            f"backfilled tsv has the token but not an 'A'-weighted position "
            f"(setweight() may not have run): {backfilled}"
        )

        # The recreated trigger maintains search_tsv on a fresh write.
        new_id = _seed_ttmik_sentence(conn, "바나나")  # "banana"
        maintained = _search_tsv(conn, new_id)
        assert maintained is not None and maintained != "", "trigger did not populate search_tsv"
        assert "바나나" in maintained, f"trigger tsv missing the source token: {maintained}"
        assert _has_weighted_lexeme(maintained, "바나나", "A"), (
            f"trigger-maintained tsv has the token but not an 'A'-weighted "
            f"position (setweight() may not have run): {maintained}"
        )
