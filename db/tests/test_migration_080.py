"""Migration 080 (cloze prompts, F-208 phase 1) — real-chain tests.

WHY THIS FILE EXISTS:
    080 creates `cloze_prompts` — one pre-computed cloze presentation per
    vocab entry, holding the ANSWER (`answer_surface`) that the due-queue
    read must never serve. The load-bearing behaviors are the integrity
    rails the seeder and routes lean on: the span CHECK (a non-positive or
    negative blank span would render a garbled/empty blank), the closed
    `source` vocabulary, the one-prompt-per-entry UNIQUE (the due-queue
    LEFT JOIN's no-row-multiplication guarantee), and the ON DELETE CASCADE
    (a corpus re-ingest must not leave an orphaned prompt pointing at a
    recycled entry id). These tests apply the REAL migration chain against
    a real Postgres-16 testcontainer via ``migrate.main()``.

SCOPE:
    - markers: up is non-destructive, down destructive (DROP TABLE — the
      explicit-marker posture, F-088).
    - up: applies on the full real chain; `cloze_prompts` exists with the
      expected columns; a well-formed row inserts.
    - CHECK constraints: `ck_cloze_prompts_span` rejects
      blank_end <= blank_start and a negative blank_start;
      `ck_cloze_prompts_source_known` rejects an unknown `source`.
    - UNIQUE: `uq_cloze_prompts_vocab_entry` rejects a second prompt for
      the same entry (v1: one prompt per entry).
    - FK: deleting the vocab entry CASCADE-deletes its prompt.
    - down: refused without --allow-destructive; with it, the table is gone
      (the underlying vocab entry survives); re-up restores the empty table
      (prompts are derived data — the idempotent seeder rebuilds them).

DETERMINISM:
    Mirrors test_migration_079.py — the real migration files are copied into
    a tmp_path-scoped directory and the runner is pointed at it via
    ``--migrations-dir``; the ``dsn`` fixture gives each test a fresh schema.
"""

from __future__ import annotations

import pathlib

import psycopg
import pytest
from psycopg.rows import tuple_row

from db import migrate  # type: ignore[import-not-found]
from db.tests._helpers import _full_up  # type: ignore[import-not-found]

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

# The migration immediately before 080. `down --target PRE_080` rolls back
# ONLY 080 (its DROP TABLE down is what requires --allow-destructive).
PRE_080 = "079"

EXPECTED_COLUMNS = {
    "id",
    "vocab_entry_id",
    "korean",
    "english",
    "blank_start",
    "blank_end",
    "answer_surface",
    "source",
    "created_at",
}

# Test sentence: '저는 매일 커피를 마셔요.' — 마셔요 occupies UTF-16 span [10, 13).
SENTENCE = "저는 매일 커피를 마셔요."
ANSWER = "마셔요"


# ---------------------------------------------------------------------------
# Seed helpers — raw SQL, no app layer involved
# ---------------------------------------------------------------------------

def _ensure_corpus_source(conn: psycopg.Connection) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT id FROM corpus_sources "
            "WHERE corpus = 'vocab_2000_intermediate'::corpus LIMIT 1"
        )
        row = cur.fetchone()
        if row is not None:
            return row[0]
        cur.execute(
            """
            INSERT INTO corpus_sources
                    (corpus, title, level, source_path, default_proficiency)
            VALUES ('vocab_2000_intermediate'::corpus, 'F-208 test seed',
                    'intermediate'::book_level, 'test://seed',
                    'L3'::proficiency_level)
            RETURNING id
            """
        )
        return cur.fetchone()[0]


def _seed_vocab_entry(conn: psycopg.Connection, source_id: str) -> int:
    corpus_source_id = _ensure_corpus_source(conn)
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO vocab_entries
                    (corpus_source_id, corpus, source_id, book_level,
                     entry_type, source_book, korean, english, proficiency)
            VALUES (%s, 'vocab_2000_intermediate'::corpus, %s,
                    'intermediate'::book_level, 'word'::vocab_entry_type,
                    'test-seed', '마시다', 'to drink', 'L3'::proficiency_level)
            RETURNING id
            """,
            (corpus_source_id, source_id),
        )
        return cur.fetchone()[0]


def _insert_prompt(
    conn: psycopg.Connection,
    entry_id: int,
    *,
    blank_start: int = 10,
    blank_end: int = 13,
    source: str = "vocab_example",
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO cloze_prompts
                    (vocab_entry_id, korean, english, blank_start, blank_end,
                     answer_surface, source)
            VALUES (%s, %s, 'I drink coffee every day.', %s, %s, %s, %s)
            RETURNING id
            """,
            (entry_id, SENTENCE, blank_start, blank_end, ANSWER, source),
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

def test_080_marker_classification() -> None:
    up_sql = (
        REAL_MIGRATIONS_DIR / "080_cloze_prompts.up.sql"
    ).read_text(encoding="utf-8")
    down_sql = (
        REAL_MIGRATIONS_DIR / "080_cloze_prompts.down.sql"
    ).read_text(encoding="utf-8")
    assert migrate.explicit_destructiveness(up_sql) is False
    # The down's DROP TABLE is a data drop — the explicit marker must carry it.
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — table shape on the full chain; a well-formed row inserts.
# ---------------------------------------------------------------------------

def test_080_up_creates_cloze_prompts_with_expected_columns(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_columns(conn, "cloze_prompts") == EXPECTED_COLUMNS

        entry_id = _seed_vocab_entry(conn, "f208-shape")
        prompt_id = _insert_prompt(conn, entry_id)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                SELECT vocab_entry_id, korean, blank_start, blank_end,
                       answer_surface, source
                  FROM cloze_prompts WHERE id = %s
                """,
                (prompt_id,),
            )
            assert cur.fetchone() == (
                entry_id, SENTENCE, 10, 13, ANSWER, "vocab_example",
            )


# ---------------------------------------------------------------------------
# 3. Integrity rails — span CHECK, source CHECK, one-prompt-per-entry UNIQUE.
# ---------------------------------------------------------------------------

def test_080_span_check_rejects_empty_inverted_and_negative_spans(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        entry_id = _seed_vocab_entry(conn, "f208-span")
        # blank_end == blank_start (empty span) → rejected.
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_prompt(conn, entry_id, blank_start=10, blank_end=10)
        # blank_end < blank_start (inverted) → rejected.
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_prompt(conn, entry_id, blank_start=13, blank_end=10)
        # Negative blank_start → rejected.
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_prompt(conn, entry_id, blank_start=-1, blank_end=3)
        # Sanity: the failed inserts left nothing behind and a valid span
        # still lands.
        _insert_prompt(conn, entry_id)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT count(*) FROM cloze_prompts WHERE vocab_entry_id = %s",
                (entry_id,),
            )
            assert cur.fetchone()[0] == 1


def test_080_source_check_rejects_unknown_source(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        entry_id = _seed_vocab_entry(conn, "f208-source")
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_prompt(conn, entry_id, source="claude_generated")
        # Both closed-vocabulary values are accepted ('vocab_example' is
        # exercised elsewhere; 'krdict' here).
        _insert_prompt(conn, entry_id, source="krdict")


def test_080_unique_rejects_second_prompt_for_same_entry(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        entry_id = _seed_vocab_entry(conn, "f208-uniq")
        _insert_prompt(conn, entry_id)
        with pytest.raises(psycopg.errors.UniqueViolation):
            _insert_prompt(conn, entry_id)
        # A DIFFERENT entry is unaffected (the constraint is per-entry).
        other_id = _seed_vocab_entry(conn, "f208-uniq-2")
        _insert_prompt(conn, other_id)


# ---------------------------------------------------------------------------
# 4. FK — deleting the entry CASCADE-deletes its prompt (no orphans after a
#    corpus re-ingest).
# ---------------------------------------------------------------------------

def test_080_entry_delete_cascades_to_prompt(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        entry_id = _seed_vocab_entry(conn, "f208-cascade")
        prompt_id = _insert_prompt(conn, entry_id)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("DELETE FROM vocab_entries WHERE id = %s", (entry_id,))
            cur.execute(
                "SELECT 1 FROM cloze_prompts WHERE id = %s", (prompt_id,)
            )
            assert cur.fetchone() is None, (
                "deleting the vocab entry must CASCADE-delete its cloze prompt"
            )


# ---------------------------------------------------------------------------
# 5. DOWN — destructive gate; table gone, entry survives; re-up restores.
# ---------------------------------------------------------------------------

def test_080_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        entry_id = _seed_vocab_entry(conn, "f208-down")
        _insert_prompt(conn, entry_id)

    # Refused without the flag (DROP TABLE + explicit marker).
    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", PRE_080, "down"])
    assert rc != 0, "080.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_080,
         "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {PRE_080} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_columns(conn, "cloze_prompts") == set(), (
            "cloze_prompts must be gone after the down"
        )
        # Lossy on DERIVED data only: the vocab entry survives — the
        # idempotent seeder rebuilds prompts after a re-up.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT 1 FROM vocab_entries WHERE id = %s", (entry_id,))
            assert cur.fetchone() is not None, (
                "vocab entries must survive the rollback"
            )

    # Round trip: re-up restores the (empty) table with the full shape.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_columns(conn, "cloze_prompts") == EXPECTED_COLUMNS
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM cloze_prompts")
            assert cur.fetchone()[0] == 0, (
                "prompts are derived data — a re-up starts empty until the "
                "seeder repopulates"
            )
        # And the restored constraints still hold (spot-check the span rail).
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_prompt(conn, entry_id, blank_start=5, blank_end=5)
