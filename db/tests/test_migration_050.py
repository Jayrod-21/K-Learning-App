"""Migration 050 (hanja cards on the vocab_cards FSRS XOR, F-075) — real-data tests.

WHY THIS FILE EXISTS:
    050 ALTERs an EXISTING, populated table: it adds a fifth leg
    (hanja_character_id) to vocab_cards' exactly-one-non-null target XOR,
    a FK to hanja_characters(id) (ON DELETE CASCADE), and a partial UNIQUE
    on (user_id, hanja_character_id, face). The synthetic harness tests
    (test_migrations.py) cannot prove that PRE-050 rows — real vocab- and
    grammar-target cards — survive the constraint swap untouched, that the
    new leg's constraints actually bite, or that the down migration's
    deliberate hanja-card DELETE restores the exact 001 four-leg shape.
    These tests apply the REAL migration chain against a Postgres-16
    testcontainer via `migrate.main()`, seed pre-050 rows in the pre-050
    shape, and assert the transform — and its reverse — on actual data.

SCOPE:
    - up: column + FK (CASCADE/RESTRICT asserted from pg_constraint, not
      prose), five-leg XOR (zero-target and two-target inserts rejected,
      hanja-only accepted), partial unique (duplicate live (user, char,
      face) rejected; another face and a soft-deleted duplicate allowed),
      both indexes present, existing vocab/grammar cards untouched, FK
      CASCADE removes a purged character's cards + their card_reviews.
    - down: hanja cards (and their card_reviews) deleted, vocab/grammar
      cards survive, column/FK/indexes gone, four-leg XOR restored
      (definition asserted from pg_get_constraintdef); re-up is clean.

DETERMINISM:
    Mirrors test_migration_046.py — the real migration files are copied
    into a tmp_path-scoped directory and the runner is pointed at it via
    `--migrations-dir`; the `dsn` fixture gives each test a fresh schema.
    Every `up` (full or --target 049) traverses migration 045
    (hygiene_cleanup, DROP TABLE) and therefore needs --allow-destructive.
    The 050 down's own data loss is a DELETE + DROP COLUMN (which the
    destructive gate deliberately does not match — see 050.down), but a
    `down --target 049` in the merged chain first traverses 052's and 051's
    gated DROP TABLE downs, so the flag is required there in practice.
"""

from __future__ import annotations

import pathlib

import psycopg
import pytest
from psycopg.errors import CheckViolation, ForeignKeyViolation, UniqueViolation
from psycopg.rows import dict_row, tuple_row

from db import migrate  # type: ignore[import-not-found]
from db.tests._helpers import _seed_user  # type: ignore[import-not-found]

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

# The seed target: the migration immediately before 050 in the merged Group-2
# chain (049_vocab_list_entries_multitype), so `down --target PRE_050` peels
# back exactly 052/051/050 and the seed stage stops on the true pre-050
# schema. Neither 048 nor 049 touches vocab_cards, so the table under test is
# in its pre-050 shape here regardless. Unlike test_migration_046.py's
# PRE_046=044, stopping here cannot dodge --allow-destructive: 045
# (hygiene_cleanup, DROP TABLE) already sits below 049, so the seed-stage up
# passes the flag too.
PRE_050 = "049"


# ---------------------------------------------------------------------------
# Seed helpers — pre/post-050 rows in raw SQL (no app layer involved)
# ---------------------------------------------------------------------------


def _seed_grammar_card(conn: psycopg.Connection, user_id: int, key: str) -> int:
    """A grammar-target production card (the 001-native XOR leg)."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO grammar_entries
                (user_id, pattern_key, pattern_display, summary_en,
                 proficiency, category)
            VALUES (%s, %s, %s, 'test summary', 'L3'::proficiency_level, 'ending')
            RETURNING id
            """,
            (user_id, key, key),
        )
        entry_id = cur.fetchone()[0]
        cur.execute(
            """
            INSERT INTO vocab_cards (user_id, face, grammar_entry_id)
            VALUES (%s, 'production'::card_face, %s)
            RETURNING id
            """,
            (user_id, entry_id),
        )
        return cur.fetchone()[0]


def _seed_vocab_card(conn: psycopg.Connection, user_id: int, source_id: str) -> int:
    """A vocab-target recognition card (the 002 XOR leg)."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute("SELECT id FROM corpus_sources WHERE corpus = 'vocab_2000_intermediate'")
        row = cur.fetchone()
        if row is None:
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
            row = cur.fetchone()
        corpus_source_id = row[0]
        cur.execute(
            """
            INSERT INTO vocab_entries
                (corpus_source_id, corpus, source_id, book_level, entry_type,
                 source_book, korean, english, proficiency)
            VALUES (%s, 'vocab_2000_intermediate'::corpus, %s,
                    'intermediate'::book_level, 'word'::vocab_entry_type,
                    'test-book', '먹다', 'to eat', 'L3'::proficiency_level)
            RETURNING id
            """,
            (corpus_source_id, source_id),
        )
        entry_id = cur.fetchone()[0]
        cur.execute(
            """
            INSERT INTO vocab_cards (user_id, face, vocab_entry_id)
            VALUES (%s, 'recognition'::card_face, %s)
            RETURNING id
            """,
            (user_id, entry_id),
        )
        return cur.fetchone()[0]


def _seed_hanja_character(conn: psycopg.Connection, char: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO hanja_characters (char, sound, gloss_en, strokes, level)
            VALUES (%s, '학', 'learning', 16, 'L3')
            RETURNING id
            """,
            (char,),
        )
        return cur.fetchone()[0]


def _seed_hanja_card(
    conn: psycopg.Connection, user_id: int, character_id: int, face: str = "recognition"
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO vocab_cards (user_id, face, hanja_character_id)
            VALUES (%s, %s::card_face, %s)
            RETURNING id
            """,
            (user_id, face, character_id),
        )
        return cur.fetchone()[0]


def _seed_review(conn: psycopg.Connection, card_id: int, user_id: int) -> int:
    """A minimal, constraint-valid card_reviews row for the card."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO card_reviews
                (card_id, user_id, rating,
                 state_before, stability_before, difficulty_before,
                 elapsed_days_before,
                 state_after, stability_after, difficulty_after,
                 scheduled_days_after)
            VALUES (%s, %s, 'good'::fsrs_rating,
                    'new'::fsrs_state, 0, 5.0, -1,
                    'learning'::fsrs_state, 3, 5.0, 3)
            RETURNING id
            """,
            (card_id, user_id),
        )
        return cur.fetchone()[0]


def _has_column(conn: psycopg.Connection, table: str, column: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name=%s AND column_name=%s
            """,
            (table, column),
        )
        return cur.fetchone() is not None


def _index_names(conn: psycopg.Connection, table: str) -> set[str]:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=%s",
            (table,),
        )
        return {r[0] for r in cur.fetchall()}


def _xor_constraint_def(conn: psycopg.Connection) -> str:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT pg_get_constraintdef(oid) FROM pg_constraint
             WHERE conname = 'ck_vocab_cards_target_xor'
            """
        )
        row = cur.fetchone()
        assert row is not None, "ck_vocab_cards_target_xor missing"
        return row[0]


def _card_snapshot(conn: psycopg.Connection, card_id: int) -> dict:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            SELECT face, vocab_entry_id, grammar_entry_id, source_sentence_id,
                   topik_item_id, fsrs_state, version
              FROM vocab_cards WHERE id = %s
            """,
            (card_id,),
        )
        row = cur.fetchone()
        assert row is not None, f"vocab_cards row {card_id} missing"
        return row


# ---------------------------------------------------------------------------
# 1. UP — the XOR gains the hanja leg; pre-050 cards survive untouched
# ---------------------------------------------------------------------------

def test_050_up_extends_xor_and_preserves_existing_cards(env, dsn: str, full_dir) -> None:
    """Seed real pre-050 vocab- and grammar-target cards, apply 050, and
    assert: the cards are byte-identical on every target/FSRS field, the
    five-leg XOR + partial unique + FK actually bite, and a character purge
    CASCADEs its cards and their card_reviews."""
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_050, "--allow-destructive", "up"]
    )
    assert rc == 0, f"up --target {PRE_050} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        # Sanity: the pre-050 shape.
        assert not _has_column(conn, "vocab_cards", "hanja_character_id")
        assert "hanja_character_id" not in _xor_constraint_def(conn)

        user = _seed_user(conn, "f075-up@example.com")
        grammar_card = _seed_grammar_card(conn, user, "GR-test-050")
        vocab_card = _seed_vocab_card(conn, user, "pre-050-word")
        grammar_before = _card_snapshot(conn, grammar_card)
        vocab_before = _card_snapshot(conn, vocab_card)

    # --allow-destructive: 045 (hygiene_cleanup, DROP TABLE) sits in the chain.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0, f"full up (through 050) returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        # New column, NULL on every pre-050 row; the rows are otherwise untouched.
        assert _has_column(conn, "vocab_cards", "hanja_character_id")
        assert _card_snapshot(conn, grammar_card) == grammar_before
        assert _card_snapshot(conn, vocab_card) == vocab_before
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT count(*) FROM vocab_cards WHERE hanja_character_id IS NOT NULL"
            )
            assert cur.fetchone()[0] == 0

        # FK posture from pg_constraint: ON DELETE CASCADE / ON UPDATE RESTRICT.
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT confdeltype, confupdtype FROM pg_constraint
                 WHERE conname = 'fk_vocab_cards_hanja_character'
                """
            )
            fk = cur.fetchone()
        assert fk is not None, "fk_vocab_cards_hanja_character missing"
        assert fk["confdeltype"] == "c", "hanja FK must be ON DELETE CASCADE"
        assert fk["confupdtype"] == "r", "hanja FK must be ON UPDATE RESTRICT"

        # Both 050 indexes exist.
        names = _index_names(conn, "vocab_cards")
        assert "uq_vocab_cards_user_hanja_face" in names
        assert "ix_vocab_cards_hanja_character" in names

        user = _seed_user(conn, "f075-up-2@example.com")
        character = _seed_hanja_character(conn, "學")

        # XOR leg 5 works: a hanja-only card inserts cleanly.
        hanja_card = _seed_hanja_card(conn, user, character)

        # XOR still rejects zero targets…
        with pytest.raises(CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO vocab_cards (user_id, face) VALUES (%s, 'recognition'::card_face)",
                    (user,),
                )
        # …and two targets (hanja + vocab).
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT vocab_entry_id FROM vocab_cards WHERE id = %s", (vocab_card,))
            vocab_entry_id = cur.fetchone()[0]
        with pytest.raises(CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO vocab_cards
                        (user_id, face, vocab_entry_id, hanja_character_id)
                    VALUES (%s, 'recognition'::card_face, %s, %s)
                    """,
                    (user, vocab_entry_id, character),
                )

        # Partial unique: a second LIVE (user, character, face) card is rejected…
        with pytest.raises(UniqueViolation):
            _seed_hanja_card(conn, user, character)
        # …another face is fine (per-face invariant, not per-character)…
        _seed_hanja_card(conn, user, character, face="production")
        # …and a soft-deleted card frees its slot.
        with conn.cursor() as cur:
            cur.execute("UPDATE vocab_cards SET deleted_at = now() WHERE id = %s", (hanja_card,))
        replacement = _seed_hanja_card(conn, user, character)

        # FK integrity: a card cannot reference a purged/unknown character…
        with pytest.raises(ForeignKeyViolation):
            _seed_hanja_card(conn, user, character_id=999_999)
        # …and purging a character CASCADEs its cards AND their card_reviews.
        _seed_review(conn, replacement, user)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("DELETE FROM hanja_characters WHERE id = %s", (character,))
            cur.execute(
                "SELECT count(*) FROM vocab_cards WHERE hanja_character_id IS NOT NULL"
            )
            assert cur.fetchone()[0] == 0, "character purge must CASCADE its cards"
            cur.execute("SELECT count(*) FROM card_reviews WHERE card_id = %s", (replacement,))
            assert cur.fetchone()[0] == 0, "cascaded card must take its reviews with it"
            # The pre-050 cards are collateral-free.
            cur.execute("SELECT count(*) FROM vocab_cards")
            assert cur.fetchone()[0] == 2  # grammar_card + vocab_card


# ---------------------------------------------------------------------------
# 2. DOWN — hanja cards deleted, 001 four-leg shape restored, re-up clean
# ---------------------------------------------------------------------------

def test_050_down_deletes_hanja_cards_and_restores_four_leg_xor(
    env, dsn: str, full_dir
) -> None:
    """With post-050 hanja cards (and review history) in place alongside
    vocab/grammar cards, rolling back 050 must delete ONLY the hanja cards
    (+ their card_reviews, via CASCADE), restore the exact 001 four-leg XOR
    and drop the column/FK/indexes. A subsequent full up must apply 050
    cleanly again."""
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0, f"initial full up returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "f075-down@example.com")
        grammar_card = _seed_grammar_card(conn, user, "GR-test-050-down")
        vocab_card = _seed_vocab_card(conn, user, "pre-down-word")
        character = _seed_hanja_character(conn, "水")
        hanja_card = _seed_hanja_card(conn, user, character)
        _seed_review(conn, hanja_card, user)
        vocab_review = _seed_review(conn, vocab_card, user)

    # --allow-destructive: 050.down itself is only a DELETE + DROP COLUMN (not
    # gate-matched), but in the full merged chain this `--target PRE_050 down`
    # rolls back past LATER migrations' destructive downs (052 and 051 both
    # DROP TABLE), which the runner's gate requires the flag to confirm.
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--allow-destructive", "--target", PRE_050, "down"]
    )
    assert rc == 0, f"down --target {PRE_050} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        # Schema restored to the pre-050 shape.
        assert not _has_column(conn, "vocab_cards", "hanja_character_id")
        xor = _xor_constraint_def(conn)
        assert "hanja_character_id" not in xor
        for leg in ("vocab_entry_id", "grammar_entry_id", "source_sentence_id", "topik_item_id"):
            assert leg in xor, f"restored XOR lost the {leg} leg: {xor}"
        names = _index_names(conn, "vocab_cards")
        assert "uq_vocab_cards_user_hanja_face" not in names
        assert "ix_vocab_cards_hanja_character" not in names
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT 1 FROM pg_constraint WHERE conname = 'fk_vocab_cards_hanja_character'"
            )
            assert cur.fetchone() is None, "hanja FK must be dropped"

            # The hanja card and its review history are gone; everything else
            # survives — including the vocab card's OWN review row.
            cur.execute("SELECT id FROM vocab_cards ORDER BY id")
            assert [r[0] for r in cur.fetchall()] == [grammar_card, vocab_card]
            cur.execute("SELECT count(*) FROM card_reviews WHERE card_id = %s", (hanja_card,))
            assert cur.fetchone()[0] == 0
            cur.execute("SELECT count(*) FROM card_reviews WHERE id = %s", (vocab_review,))
            assert cur.fetchone()[0] == 1

            # The character itself is corpus data — the rollback must NOT touch it.
            cur.execute("SELECT count(*) FROM hanja_characters WHERE id = %s", (character,))
            assert cur.fetchone()[0] == 1

    # Re-up: 050 applies cleanly again and the hanja leg works.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0, f"re-apply of 050 after rollback returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _has_column(conn, "vocab_cards", "hanja_character_id")
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT id FROM users WHERE email = 'f075-down@example.com'")
            user = cur.fetchone()[0]
            cur.execute("SELECT id FROM hanja_characters WHERE char = '水'")
            character = cur.fetchone()[0]
        _seed_hanja_card(conn, user, character)
