"""Migration 084 (ability_evidence view, F-212 Phase 1) — real-chain tests.

WHY THIS FILE EXISTS:
    084 is the storage half of the unified ability-evidence stream: a
    READ-ONLY view that UNION ALLs the six append-only graded logs
    (topik_responses, card_reviews, grammar_drill_attempts, writing_attempts,
    hanja_attempts, diagnostic_responses) into one normalized 13-column
    response history. Its value is in the mapping topology, and every lossy
    corner of that topology is a scoring bug waiting to happen: the per-leg
    source/dimension/item_key/raw-signal projection, the hanja DEDUP rule
    (cardReview.ts dual-writes a hanja review into BOTH card_reviews and
    hanja_attempts — the view must surface it ONCE, as source='hanja'), the
    completed-evidence exclusions (unscored drills, unanswered diagnostic
    items), and per-user isolation. These tests apply the REAL migration
    chain against a real Postgres-16 testcontainer via ``migrate.main()`` and
    PROVE each rule by seeding real rows and reading the view.

SCOPE:
    - up: view exists; empty DB → 0 rows; one seeded row per source →
      exactly-expected view rows (source, dimension, item_key, occurred_at,
      raw outcome + difficulty columns); hanja dedup; tenant isolation;
      grammar_drill's all-NULL difficulty columns; exclusion of unscored
      grammar drills and unanswered diagnostic responses.
    - down: view dropped (destructive gate) — all six base tables untouched;
      re-up clean.

DETERMINISM:
    Mirrors test_migration_060.py — the real migration files are copied into
    a tmp_path-scoped directory and the runner is pointed at it via
    ``--migrations-dir``; the ``dsn`` fixture gives each test a fresh schema.
"""

from __future__ import annotations

import pathlib
import shutil

import psycopg
import pytest
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

# The migration immediately before 084. `down --target PRE_084` rolls back
# ONLY 084 (its DROP VIEW down is destructive-marked by convention).
PRE_084 = "083"

# A syntactically valid argon2id-shaped hash satisfying
# ck_users_password_hash_argon2id (LIKE '$argon2id$%', length 80..255).
FAKE_HASH = "$argon2id$" + "x" * 70

# The 13 view columns, in the exact leg-pinned order (leg 1 names them).
VIEW_COLUMNS = [
    "user_id",
    "dimension",
    "source",
    "source_id",
    "item_key",
    "occurred_at",
    "outcome_raw_correct",
    "outcome_raw_rating",
    "outcome_raw_score",
    "outcome_raw_max",
    "diff_served",
    "diff_topik_paper",
    "diff_proficiency",
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


# ---------------------------------------------------------------------------
# Seed helpers — raw SQL, no app layer involved. One helper per producing log.
# ---------------------------------------------------------------------------

def _seed_user(conn: psycopg.Connection, email: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id",
            (email, FAKE_HASH),
        )
        return cur.fetchone()[0]


def _seed_topik_item(conn: psycopg.Connection) -> int:
    """corpus_sources → topik_tests → topik_items chain; returns the item id."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO corpus_sources (corpus, title, source_path)
            VALUES ('topik', 'TOPIK test corpus', '/f212/topik.json')
            ON CONFLICT (corpus) DO UPDATE SET title = EXCLUDED.title
            RETURNING id
            """
        )
        source_id = cur.fetchone()[0]
        cur.execute(
            """
            INSERT INTO topik_tests (corpus_source_id, test_number, topik_level, section)
            VALUES (%s, 36, 'TOPIK I', 'reading'::topik_section)
            RETURNING id
            """,
            (source_id,),
        )
        test_id = cur.fetchone()[0]
        cur.execute(
            """
            INSERT INTO topik_items
                (topik_test_id, corpus_source_id, source_id, item_number, section,
                 item_type, proficiency, stem, options, answer)
            VALUES (%s, %s, 'f212-topik36-read-001', 1, 'reading'::topik_section,
                    'multiple_choice'::topik_item_type, 'L2'::proficiency_level,
                    '문장을 고르십시오.', '["a","b","c","d"]'::jsonb, '1'::jsonb)
            RETURNING id
            """,
            (test_id, source_id),
        )
        return cur.fetchone()[0]


def _seed_topik_response(
    conn: psycopg.Connection, user_id: int, item_id: int, is_correct: bool = True
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO topik_responses (user_id, topik_item_id, picked, is_correct)
            VALUES (%s, %s, 'a', %s)
            RETURNING id
            """,
            (user_id, item_id, is_correct),
        )
        return cur.fetchone()[0]


def _seed_grammar_entry(conn: psycopg.Connection, user_id: int, key: str = "GR-f212-eo-yo") -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO grammar_entries
                (user_id, pattern_key, pattern_display, summary_en, proficiency, category)
            VALUES (%s, %s, '-어요', 'Polite present ending.', 'L3'::proficiency_level,
                    'ending')
            RETURNING id
            """,
            (user_id, key),
        )
        return cur.fetchone()[0]


def _seed_grammar_card(conn: psycopg.Connection, user_id: int, grammar_entry_id: int) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO vocab_cards (user_id, face, grammar_entry_id, proficiency)
            VALUES (%s, 'production'::card_face, %s, 'L4'::proficiency_level)
            RETURNING id
            """,
            (user_id, grammar_entry_id),
        )
        return cur.fetchone()[0]


def _seed_hanja_character(conn: psycopg.Connection, char: str = "水") -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO hanja_characters (char, sound, gloss_en, strokes, level)
            VALUES (%s, '수', 'water', 4, 'L3')
            ON CONFLICT (char) DO UPDATE SET sound = EXCLUDED.sound
            RETURNING id
            """,
            (char,),
        )
        return cur.fetchone()[0]


def _seed_hanja_card(conn: psycopg.Connection, user_id: int, hanja_character_id: int) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO vocab_cards (user_id, face, hanja_character_id, proficiency)
            VALUES (%s, 'recognition'::card_face, %s, 'L3'::proficiency_level)
            RETURNING id
            """,
            (user_id, hanja_character_id),
        )
        return cur.fetchone()[0]


def _seed_card_review(
    conn: psycopg.Connection, user_id: int, card_id: int, rating: str = "good"
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO card_reviews
                (card_id, user_id, rating,
                 state_before, stability_before, difficulty_before, elapsed_days_before,
                 state_after, stability_after, difficulty_after, scheduled_days_after)
            VALUES (%s, %s, %s::fsrs_rating,
                    'new'::fsrs_state, 0, 5.0, -1,
                    'learning'::fsrs_state, 1.2, 5.0, 1)
            RETURNING id
            """,
            (card_id, user_id, rating),
        )
        return cur.fetchone()[0]


def _seed_hanja_attempt(
    conn: psycopg.Connection,
    user_id: int,
    card_id: int | None,
    char: str = "水",
    rating: str = "good",
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO hanja_attempts (user_id, card_id, char, rating, correct)
            VALUES (%s, %s, %s, %s::fsrs_rating, %s)
            RETURNING id
            """,
            (user_id, card_id, char, rating, rating != "again"),
        )
        return cur.fetchone()[0]


def _seed_grammar_drill_attempt(
    conn: psycopg.Connection, user_id: int, scored: bool, score: int | None = 73
) -> int:
    """A scored (score + scored_at set) or unscored (both NULL) drill row."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO grammar_drill_attempts
                (user_id, pattern_key, pattern_display, drill_type, item,
                 user_answer, score, verdict, scored_at)
            VALUES (%s, 'GR-f212-eo-yo', '-어요', 'transformation',
                    '{"prompt": "바꾸세요"}'::jsonb,
                    CASE WHEN %s THEN '했어요' END,
                    CASE WHEN %s THEN %s::int END,
                    CASE WHEN %s THEN 'good' END,
                    CASE WHEN %s THEN now() END)
            RETURNING id
            """,
            (user_id, scored, scored, score, scored, scored),
        )
        return cur.fetchone()[0]


def _seed_writing_prompt(conn: psycopg.Connection, level: str = "L5+") -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO writing_prompts
                (source_id, title, prompt_kr, prompt_en, level, rubric)
            VALUES ('f212-q54-test', '에세이', '글을 쓰십시오.', 'Write an essay.',
                    %s::proficiency_level, 'topik_ii_54')
            ON CONFLICT (source_id) DO UPDATE SET title = EXCLUDED.title
            RETURNING id
            """,
            (level,),
        )
        return cur.fetchone()[0]


def _seed_writing_attempt(
    conn: psycopg.Connection,
    user_id: int,
    prompt_id: int | None,
    rubric: str = "topik_ii_54",
    total_score: int = 42,
    max_total: int = 50,
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO writing_attempts
                (user_id, prompt_id, rubric, prompt_kr, sample,
                 total_score, max_total, result)
            VALUES (%s, %s, %s, '글을 쓰십시오.', '제 생각에는 그렇습니다.',
                    %s, %s, '{"overallComment": "좋아요"}'::jsonb)
            RETURNING id
            """,
            (user_id, prompt_id, rubric, total_score, max_total),
        )
        return cur.fetchone()[0]


def _seed_diagnostic_response(
    conn: psycopg.Connection, user_id: int, answered: bool, ordinal: int = 1
) -> int:
    """diagnostic_runs → diagnostic_responses; answered=False leaves the row
    served-only (picked/is_correct/answered_at all NULL)."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO diagnostic_runs (user_id) VALUES (%s) RETURNING id",
            (user_id,),
        )
        run_id = cur.fetchone()[0]
        cur.execute(
            """
            INSERT INTO diagnostic_responses
                (run_id, ordinal, section, source_kind, source_ref, difficulty,
                 kind, item_payload, correct_answer, picked, is_correct, answered_at)
            VALUES (%s, %s, 'listening', 'topik', 'f212-diag-ref', 3.50,
                    'audio-mc', '{"prompt": "들으세요"}'::jsonb, 'b',
                    CASE WHEN %s THEN 'b' END,
                    CASE WHEN %s THEN TRUE END,
                    CASE WHEN %s THEN now() END)
            RETURNING id
            """,
            (run_id, ordinal, answered, answered, answered),
        )
        return cur.fetchone()[0]


def _view_exists(conn: psycopg.Connection) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT 1 FROM information_schema.views
             WHERE table_schema='public' AND table_name='ability_evidence'
            """
        )
        return cur.fetchone() is not None


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


def _evidence_for(conn: psycopg.Connection, user_id: int) -> list[dict]:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            "SELECT * FROM ability_evidence WHERE user_id = %s ORDER BY source, source_id",
            (user_id,),
        )
        return cur.fetchall()


# ---------------------------------------------------------------------------
# 1. UP — the view exists with the pinned column order; empty DB → 0 rows
# ---------------------------------------------------------------------------

def test_084_up_view_exists_and_is_empty(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        assert _view_exists(conn)

        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT column_name FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='ability_evidence'
                 ORDER BY ordinal_position
                """
            )
            columns = [row["column_name"] for row in cur.fetchall()]
        assert columns == VIEW_COLUMNS, "view column order is the 13-column contract"

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM ability_evidence")
            assert cur.fetchone()[0] == 0, "no base rows → no evidence"

        # Belt-and-braces: the app role (047's km_app, via its DEFAULT
        # PRIVILEGES) can read the view — the TS read API connects as km_app.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT has_table_privilege('km_app', 'ability_evidence', 'SELECT')"
            )
            assert cur.fetchone()[0] is True, "km_app must hold SELECT on the view"


# ---------------------------------------------------------------------------
# 2. UP — one seeded row per source surfaces with the right projection
# ---------------------------------------------------------------------------

def test_084_each_source_projects_one_normalized_row(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        user = _seed_user(conn, "f212-sources@example.com")

        item = _seed_topik_item(conn)
        _seed_topik_response(conn, user, item, is_correct=True)

        entry = _seed_grammar_entry(conn, user)
        grammar_card = _seed_grammar_card(conn, user, entry)
        _seed_card_review(conn, user, grammar_card, rating="hard")

        _seed_grammar_drill_attempt(conn, user, scored=True, score=73)

        prompt = _seed_writing_prompt(conn, level="L5+")
        _seed_writing_attempt(conn, user, prompt, total_score=42, max_total=50)

        hanja_char = _seed_hanja_character(conn)
        hanja_card = _seed_hanja_card(conn, user, hanja_char)
        _seed_hanja_attempt(conn, user, hanja_card, rating="easy")

        _seed_diagnostic_response(conn, user, answered=True)

        rows = _evidence_for(conn, user)
        by_source = {row["source"]: row for row in rows}
        assert sorted(by_source) == [
            "diagnostic", "fsrs", "grammar_drill", "hanja", "topik", "writing",
        ]
        assert len(rows) == 6, "exactly one row per seeded source"

        topik = by_source["topik"]
        assert topik["dimension"] == "reading"
        assert topik["item_key"] == str(item)
        assert topik["outcome_raw_correct"] is True
        assert topik["outcome_raw_rating"] is None
        assert topik["diff_topik_paper"] == "TOPIK I"
        assert topik["diff_proficiency"] == "L2"
        assert topik["occurred_at"] is not None

        fsrs = by_source["fsrs"]
        assert fsrs["dimension"] == "grammar", "grammar-target card → grammar dimension"
        assert fsrs["item_key"] == f"grammar:{entry}", "leg-prefixed polymorphic key"
        assert fsrs["outcome_raw_rating"] == "hard"
        assert fsrs["outcome_raw_correct"] is None
        assert fsrs["diff_proficiency"] == "L4", "difficulty rides the card's tag"

        drill = by_source["grammar_drill"]
        assert drill["dimension"] == "grammar"
        assert drill["item_key"] == "GR-f212-eo-yo"
        assert drill["outcome_raw_score"] == 73
        assert drill["outcome_raw_max"] == 100, "drill scores are out of a constant 100"

        writing = by_source["writing"]
        assert writing["dimension"] == "writing"
        assert writing["item_key"] == "topik_ii_54", "rubric IS the writing item key"
        assert writing["outcome_raw_score"] == 42
        assert writing["outcome_raw_max"] == 50
        assert writing["diff_proficiency"] == "L5+", "prompt.level via the LEFT JOIN"

        hanja = by_source["hanja"]
        assert hanja["dimension"] == "vocab"
        assert hanja["item_key"] == "水", "the character snapshot is the key"
        assert hanja["outcome_raw_correct"] is True
        assert hanja["outcome_raw_rating"] == "easy", "both raw signals surface"
        assert hanja["diff_proficiency"] == "L3", "card proficiency via the LEFT JOIN"

        diag = by_source["diagnostic"]
        assert diag["dimension"] == "listening"
        assert diag["item_key"] == "f212-diag-ref"
        assert diag["outcome_raw_correct"] is True
        assert diag["diff_served"] is not None and float(diag["diff_served"]) == 3.5
        assert diag["diff_topik_paper"] is None
        assert diag["diff_proficiency"] is None


# ---------------------------------------------------------------------------
# 3. UP — THE dedup proof: a hanja review dual-written to card_reviews AND
#    hanja_attempts (services/cardReview.ts, one transaction) surfaces ONCE,
#    as source='hanja' — the fsrs leg's hanja exclusion is what prevents the
#    double count.
# ---------------------------------------------------------------------------

def test_084_hanja_dual_write_surfaces_once(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        user = _seed_user(conn, "f212-dedup@example.com")
        hanja_char = _seed_hanja_character(conn)
        card = _seed_hanja_card(conn, user, hanja_char)

        # The dual write: cardReview.ts inserts BOTH rows for one review event.
        _seed_card_review(conn, user, card, rating="good")
        _seed_hanja_attempt(conn, user, card, rating="good")

        rows = _evidence_for(conn, user)
        assert len(rows) == 1, "one review event must be ONE evidence row"
        assert rows[0]["source"] == "hanja", "leg 5 owns the hanja copy"
        assert rows[0]["dimension"] == "vocab"

        # Control: a NON-hanja card's review still flows through the fsrs leg
        # (the exclusion is scoped to hanja targets, not to card_reviews).
        entry = _seed_grammar_entry(conn, user, key="GR-f212-dedup-ctl")
        grammar_card = _seed_grammar_card(conn, user, entry)
        _seed_card_review(conn, user, grammar_card, rating="again")

        rows = _evidence_for(conn, user)
        assert {row["source"] for row in rows} == {"hanja", "fsrs"}
        assert len(rows) == 2


# ---------------------------------------------------------------------------
# 4. UP — tenant isolation: user A's evidence never bleeds into user B's read
# ---------------------------------------------------------------------------

def test_084_tenant_isolation(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        user_a = _seed_user(conn, "f212-tenant-a@example.com")
        user_b = _seed_user(conn, "f212-tenant-b@example.com")

        _seed_grammar_drill_attempt(conn, user_a, scored=True, score=90)
        _seed_writing_attempt(conn, user_a, None)
        _seed_diagnostic_response(conn, user_a, answered=True)

        assert len(_evidence_for(conn, user_a)) == 3
        assert _evidence_for(conn, user_b) == [], "user B sees none of user A's rows"


# ---------------------------------------------------------------------------
# 5. UP — NULL-difficulty legs + prompt-less writing degrade cleanly
# ---------------------------------------------------------------------------

def test_084_grammar_drill_has_all_null_difficulty(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        user = _seed_user(conn, "f212-null-b@example.com")
        _seed_grammar_drill_attempt(conn, user, scored=True, score=55)
        # A prompt-less writing attempt (client sent no promptId): the LEFT
        # JOIN leaves diff_proficiency NULL; the raw score survives.
        _seed_writing_attempt(conn, user, None, total_score=20, max_total=30)

        rows = {row["source"]: row for row in _evidence_for(conn, user)}

        drill = rows["grammar_drill"]
        assert drill["diff_served"] is None
        assert drill["diff_topik_paper"] is None
        assert drill["diff_proficiency"] is None, "drills carry NO difficulty signal"

        writing = rows["writing"]
        assert writing["diff_proficiency"] is None, "no prompt → difficulty degrades"
        assert writing["outcome_raw_score"] == 20
        assert writing["outcome_raw_max"] == 30


# ---------------------------------------------------------------------------
# 6. UP — exclusions: incomplete rows are NOT evidence
# ---------------------------------------------------------------------------

def test_084_excludes_unscored_and_unanswered_rows(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        user = _seed_user(conn, "f212-exclusions@example.com")

        # Unscored drill (the generate half of 019's two-phase flow).
        _seed_grammar_drill_attempt(conn, user, scored=False, score=None)
        # Served-but-unanswered diagnostic item.
        _seed_diagnostic_response(conn, user, answered=False)

        assert _evidence_for(conn, user) == [], "incomplete rows are invisible"

        # Completing each flips it into evidence.
        _seed_grammar_drill_attempt(conn, user, scored=True, score=61)
        _seed_diagnostic_response(conn, user, answered=True)

        rows = _evidence_for(conn, user)
        assert {row["source"] for row in rows} == {"grammar_drill", "diagnostic"}
        assert len(rows) == 2


# ---------------------------------------------------------------------------
# 7. DOWN — the view dropped, all six base tables intact, then a clean re-up
# ---------------------------------------------------------------------------

def test_084_down_drops_view_then_reups(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "f212-down@example.com")
        _seed_grammar_drill_attempt(conn, user, scored=True, score=88)

    # --allow-destructive: 084's down contains DROP VIEW (destructive-marked
    # by convention; the base logs — the actual data — are untouched).
    rc = migrate.main(
        [
            "--migrations-dir",
            str(full_dir),
            "--target",
            PRE_084,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_084} returned {rc}"

    with psycopg.connect(dsn, autocommit=True, row_factory=tuple_row) as conn:
        assert not _view_exists(conn)
        # Every base log survives the view's removal.
        for table in (
            "topik_responses",
            "card_reviews",
            "grammar_drill_attempts",
            "writing_attempts",
            "hanja_attempts",
            "diagnostic_responses",
        ):
            assert _table_exists(conn, table), f"{table} must outlive the view"
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM grammar_drill_attempts")
            assert cur.fetchone()[0] == 1, "base data untouched by the down"

    # Re-up: 084 applies cleanly again and the seeded row is evidence again.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        assert _view_exists(conn)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM ability_evidence")
            assert cur.fetchone()[0] == 1
