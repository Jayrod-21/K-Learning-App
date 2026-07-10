"""Migration 049 (vocab_list_entries multi-type XOR, F-048/F-060/F-061) — real-data tests.

WHY THIS FILE EXISTS:
    049 ALTERS AN EXISTING TABLE that already carries user data. It is an
    ADD-ONLY EXPAND: `entry_id` keeps its 012 name (deliberately NOT renamed —
    a live-column rename would break the still-serving old color, see the up
    header), its NOT NULL is dropped, the grammar/hanja target columns are
    added, per-target partial UNIQUE indexes cover the new columns (the 012
    UNIQUE (list_id, entry_id) is KEPT as the vocab leg's guarantee), and the
    exactly-one-target CHECK is installed. The synthetic harness tests
    (test_migrations.py) and the foundation round-trips
    (test_migrations_real.py) cannot prove that pre-049 vocab memberships
    survive the reshape, that the new invariants hold on a real chain, or that
    PRE-049 SERVER SQL keeps working on the post-049 schema (the expand/
    contract property the blue/green deploy depends on). These tests apply the
    REAL migration chain against a Postgres-16 testcontainer via
    `migrate.main()`, seed rows in the pre-049 shape, and assert the reshape —
    and its best-effort reverse — on actual data.

SCOPE:
    - up: existing vocab rows survive untouched (values + positions in place,
      new columns NULL); the XOR CHECK rejects two-target and zero-target
      rows; per-target uniqueness enforces one membership per (list, target)
      while allowing the same target in different lists and different types
      in one list; FK postures asserted from pg_constraint (vocab RESTRICT
      kept from 012 under its original name; kgiu/hanja CASCADE per the
      F-048 spec); the reverse-lookup indexes exist.
    - old-color contract: the exact SQL shapes the pre-049 server runs
      (vocab-only INSERT, INNER-JOIN detail SELECT, entry_id dup-check)
      still work on the post-049 schema, including with grammar/hanja rows
      present — the zero-downtime guarantee, proven not asserted.
    - down: grammar/hanja memberships (no pre-049 representation) are
      removed; vocab memberships round-trip losslessly; `entry_id` NOT NULL
      returns; the untouched 012 UNIQUE + FK are still there; re-up is clean.

DETERMINISM:
    Mirrors test_migration_046.py — the real migration files are copied into
    a tmp_path-scoped directory and the runner is pointed at it via
    `--migrations-dir`; the `dsn` fixture gives each test a fresh schema.

NB: the pre-049 target is 048, which is PAST the destructive 045 — so every
    `up` here, including the seed-stage one, passes --allow-destructive.
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

# The seed target: the migration immediately before 049 in the merged Group-2
# chain (048_tickets), i.e. the pre-049 vocab-only shape of vocab_list_entries.
PRE_049 = "048"

# A syntactically valid argon2id-shaped hash satisfying
# ck_users_password_hash_argon2id (LIKE '$argon2id$%', length 80..255).
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


def _seed_corpus_source(conn: psycopg.Connection, corpus: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute("SELECT id FROM corpus_sources WHERE corpus = %s::corpus", (corpus,))
        row = cur.fetchone()
        if row:
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


def _seed_vocab_entry(conn: psycopg.Connection, korean: str) -> int:
    corpus = "vocab_2000_intermediate"
    cs = _seed_corpus_source(conn, corpus)
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO vocab_entries (
                corpus_source_id, corpus, source_id, book_level, entry_type,
                source_book, korean, english, proficiency)
            VALUES (%s, %s::corpus, %s, 'intermediate'::book_level,
                    'word'::vocab_entry_type, 'test-book', %s, 'gloss',
                    'L3'::proficiency_level)
            RETURNING id
            """,
            (cs, corpus, f"vocab-{korean}", korean),
        )
        return cur.fetchone()[0]


def _seed_kgiu_entry(conn: psycopg.Connection, pattern: str) -> int:
    corpus = "kgiu_intermediate"
    cs = _seed_corpus_source(conn, corpus)
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO kgiu_entries (
                corpus_source_id, corpus, source_id, book_level, entry_type,
                source_book, pattern, title_en, category, proficiency)
            VALUES (%s, %s::corpus, %s, 'intermediate'::book_level,
                    'grammar'::kgiu_entry_type, 'test-book', %s, 'title',
                    'category', 'L3'::proficiency_level)
            RETURNING id
            """,
            (cs, corpus, f"kgiu-{pattern}", pattern),
        )
        return cur.fetchone()[0]


def _seed_hanja_character(conn: psycopg.Connection, char: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO hanja_characters (char, sound, gloss_en, strokes, level)
            VALUES (%s, %s, 'gloss', 4, 'L3')
            RETURNING id
            """,
            (char, "음"),
        )
        return cur.fetchone()[0]


def _seed_list(conn: psycopg.Connection, user_id: int, name_kr: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO vocab_lists (user_id, name_kr) VALUES (%s, %s) RETURNING id",
            (user_id, name_kr),
        )
        return cur.fetchone()[0]


def _columns(conn: psycopg.Connection, table: str) -> set[str]:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT column_name FROM information_schema.columns
             WHERE table_schema='public' AND table_name=%s
            """,
            (table,),
        )
        return {r[0] for r in cur.fetchall()}


def _index_names(conn: psycopg.Connection, table: str) -> set[str]:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=%s",
            (table,),
        )
        return {r[0] for r in cur.fetchall()}


def _constraint_names(conn: psycopg.Connection, table: str) -> set[str]:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT conname FROM pg_constraint WHERE conrelid = %s::regclass",
            (table,),
        )
        return {r[0] for r in cur.fetchall()}


def _is_nullable(conn: psycopg.Connection, table: str, column: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT is_nullable FROM information_schema.columns
             WHERE table_schema='public' AND table_name=%s AND column_name=%s
            """,
            (table, column),
        )
        row = cur.fetchone()
        assert row is not None, f"{table}.{column} missing"
        return row[0] == "YES"


# ---------------------------------------------------------------------------
# 1. UP — pre-049 vocab rows survive; XOR + per-target uniqueness proven
# ---------------------------------------------------------------------------

def test_049_up_preserves_vocab_rows_and_enforces_xor(env, dsn: str, full_dir) -> None:
    """Seed pre-049 vocab-only memberships, apply 049, and assert the expand:
    entry_id keeps its name and values (add-only — nothing moves), new columns
    NULL, XOR CHECK live, per-target uniqueness enforced (012 UNIQUE for
    vocab, new partial UNIQUEs for grammar/hanja), FK postures correct."""
    # --allow-destructive: the chain to 048 traverses 045 (hygiene_cleanup,
    # DROP TABLE), so even the seed-stage up trips migrate.py's gate.
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_049, "--allow-destructive", "up"]
    )
    assert rc == 0, f"up --target {PRE_049} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        # Sanity: the pre-049 shape is what 012 shipped.
        cols = _columns(conn, "vocab_list_entries")
        assert "entry_id" in cols
        assert not {"kgiu_entry_id", "hanja_character_id"} & cols
        assert not _is_nullable(conn, "vocab_list_entries", "entry_id")
        assert "uq_vocab_list_entries_list_entry" in _constraint_names(
            conn, "vocab_list_entries"
        )

        user = _seed_user(conn, "049-up@example.com")
        v1 = _seed_vocab_entry(conn, "먹다")
        v2 = _seed_vocab_entry(conn, "가다")
        lst = _seed_list(conn, user, "기존 목록")
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO vocab_list_entries (list_id, entry_id, position)
                VALUES (%s, %s, 0), (%s, %s, 1)
                """,
                (lst, v1, lst, v2),
            )

    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0, f"up (through 049) returned {rc}"

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        # Columns expanded: entry_id KEPT (no rename), now nullable; two new
        # target columns added.
        cols = _columns(conn, "vocab_list_entries")
        assert "entry_id" in cols, "049 must NOT rename entry_id (expand/contract)"
        assert "vocab_entry_id" not in cols
        assert {"kgiu_entry_id", "hanja_character_id"} <= cols
        assert _is_nullable(conn, "vocab_list_entries", "entry_id")

        # Existing rows survived untouched, values + positions intact.
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT entry_id, kgiu_entry_id, hanja_character_id, position
                  FROM vocab_list_entries WHERE list_id = %s ORDER BY position
                """,
                (lst,),
            )
            rows = cur.fetchall()
        assert [(r["entry_id"], r["position"]) for r in rows] == [
            (v1, 0),
            (v2, 1),
        ]
        assert all(
            r["kgiu_entry_id"] is None and r["hanja_character_id"] is None for r in rows
        ), "pre-049 rows must be pure vocab memberships after the up"

        # Constraint/index inventory: the 012 UNIQUE is KEPT (it is the vocab
        # leg's per-target guarantee — NULLs-distinct ignores grammar/hanja
        # rows), the XOR CHECK and the new partial uniques + entry-column
        # indexes are present.
        con_names = _constraint_names(conn, "vocab_list_entries")
        assert "uq_vocab_list_entries_list_entry" in con_names
        assert "ck_vocab_list_entries_target_xor" in con_names
        idx = _index_names(conn, "vocab_list_entries")
        assert {
            "uq_vocab_list_entries_list_kgiu",
            "uq_vocab_list_entries_list_hanja",
            "ix_vocab_list_entries_entry",
            "ix_vocab_list_entries_kgiu_entry",
            "ix_vocab_list_entries_hanja_character",
        } <= idx

        # FK postures from pg_constraint, not prose: vocab keeps 012's
        # RESTRICT ('r') under its ORIGINAL constraint name (untouched);
        # the new targets CASCADE ('c') per the F-048 spec.
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT conname, confdeltype FROM pg_constraint
                 WHERE conrelid = 'vocab_list_entries'::regclass
                   AND contype = 'f'
                """
            )
            fk = {r["conname"]: r["confdeltype"] for r in cur.fetchall()}
        assert fk["fk_vocab_list_entries_entry"] == "r"
        assert fk["fk_vocab_list_entries_kgiu_entry"] == "c"
        assert fk["fk_vocab_list_entries_hanja_character"] == "c"

        g1 = _seed_kgiu_entry(conn, "-거든요")
        h1 = _seed_hanja_character(conn, "水")

        # XOR: two targets → CHECK violation.
        with pytest.raises(psycopg.errors.CheckViolation) as exc:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO vocab_list_entries
                            (list_id, entry_id, kgiu_entry_id, position)
                    VALUES (%s, %s, %s, 2)
                    """,
                    (lst, v1, g1),
                )
        assert exc.value.diag.constraint_name == "ck_vocab_list_entries_target_xor"

        # XOR: zero targets → CHECK violation.
        with pytest.raises(psycopg.errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO vocab_list_entries (list_id, position) VALUES (%s, 2)",
                    (lst,),
                )

        # Different types coexist in one list; the same target dedupes per type.
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO vocab_list_entries (list_id, kgiu_entry_id, position)
                VALUES (%s, %s, 2)
                """,
                (lst, g1),
            )
            cur.execute(
                """
                INSERT INTO vocab_list_entries (list_id, hanja_character_id, position)
                VALUES (%s, %s, 3)
                """,
                (lst, h1),
            )
        with pytest.raises(psycopg.errors.UniqueViolation) as exc:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO vocab_list_entries (list_id, entry_id, position)
                    VALUES (%s, %s, 4)
                    """,
                    (lst, v1),
                )
        assert exc.value.diag.constraint_name == "uq_vocab_list_entries_list_entry"
        with pytest.raises(psycopg.errors.UniqueViolation) as exc:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO vocab_list_entries (list_id, kgiu_entry_id, position)
                    VALUES (%s, %s, 4)
                    """,
                    (lst, g1),
                )
        assert exc.value.diag.constraint_name == "uq_vocab_list_entries_list_kgiu"
        with pytest.raises(psycopg.errors.UniqueViolation) as exc:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO vocab_list_entries (list_id, hanja_character_id, position)
                    VALUES (%s, %s, 4)
                    """,
                    (lst, h1),
                )
        assert exc.value.diag.constraint_name == "uq_vocab_list_entries_list_hanja"

        # ...but the SAME target in a DIFFERENT list is fine (uniqueness is
        # per (list, target), not global).
        other = _seed_list(conn, user, "다른 목록")
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO vocab_list_entries (list_id, kgiu_entry_id, position)
                VALUES (%s, %s, 0)
                """,
                (other, g1),
            )

        # CASCADE proven live: deleting the hanja reference row removes its
        # membership (and only its membership).
        with conn.cursor() as cur:
            cur.execute("DELETE FROM hanja_characters WHERE id = %s", (h1,))
            cur.execute(
                "SELECT count(*) AS n FROM vocab_list_entries WHERE list_id = %s",
                (lst,),
            )
            assert cur.fetchone()["n"] == 3  # v1, v2, g1 — hanja row cascaded away


# ---------------------------------------------------------------------------
# 2. Old-color contract — the exact pre-049 server SQL shapes keep working on
#    the post-049 schema (the zero-downtime blue/green guarantee)
# ---------------------------------------------------------------------------

def test_049_up_old_color_contract_still_works(env, dsn: str, full_dir) -> None:
    """049 must be a pure expand: the pre-049 (rebuild) vocabLists.ts only
    ever names `entry_id`, so its INSERT / dup-check / INNER-JOIN detail
    SELECT must all still run — including while grammar/hanja rows written by
    the NEW color coexist in the same list. This is the property that lets
    the old color keep serving while 049 applies (no 42703, no XOR trip)."""
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0, f"full up returned {rc}"

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        user = _seed_user(conn, "049-oldcolor@example.com")
        v1 = _seed_vocab_entry(conn, "학교")
        v2 = _seed_vocab_entry(conn, "친구")
        g1 = _seed_kgiu_entry(conn, "-잖아요")
        lst = _seed_list(conn, user, "구버전 호환")

        with conn.cursor() as cur:
            # New-color write: a grammar membership shares the list.
            cur.execute(
                "INSERT INTO vocab_list_entries (list_id, kgiu_entry_id, position)"
                " VALUES (%s, %s, 0)",
                (lst, g1),
            )

            # OLD-COLOR seed INSERT (verbatim shape from rebuild
            # vocabLists.ts:189-199): names only entry_id; the XOR is
            # satisfied because the new columns default to NULL.
            cur.execute(
                """
                WITH ins AS (
                    INSERT INTO vocab_list_entries (list_id, entry_id, position)
                    SELECT %(list)s, s.entry_id, s.ord - 1
                      FROM unnest(%(ids)s::bigint[]) WITH ORDINALITY AS s(entry_id, ord)
                     WHERE EXISTS (
                              SELECT 1 FROM vocab_entries v WHERE v.id = s.entry_id
                           )
                       AND NOT EXISTS (
                              SELECT 1 FROM vocab_list_entries x
                               WHERE x.list_id = %(list)s AND x.entry_id = s.entry_id
                           )
                    RETURNING 1
                )
                SELECT COUNT(*) AS n FROM ins
                """,
                {"list": lst, "ids": [v1, v2]},
            )
            assert cur.fetchone()["n"] == 2

            # OLD-COLOR dup-check (rebuild vocabLists.ts:461-463): the
            # grammar row's NULL entry_id must not match or error.
            cur.execute(
                "SELECT entry_id FROM vocab_list_entries"
                " WHERE list_id = %s AND entry_id = ANY(%s::bigint[])",
                (lst, [v1]),
            )
            assert [r["entry_id"] for r in cur.fetchall()] == [v1]

            # OLD-COLOR detail SELECT (rebuild vocabLists.ts:276-285): the
            # INNER JOIN silently skips the grammar row — old clients see
            # exactly the vocab memberships, never a half-NULL row.
            cur.execute(
                """
                SELECT e.entry_id, e.position, v.korean
                  FROM vocab_list_entries e
                  JOIN vocab_entries v ON v.id = e.entry_id
                 WHERE e.list_id = %s
                 ORDER BY e.position, e.added_at, e.entry_id
                """,
                (lst,),
            )
            rows = cur.fetchall()
        assert [(r["entry_id"], r["korean"]) for r in rows] == [
            (v1, "학교"),
            (v2, "친구"),
        ]


# ---------------------------------------------------------------------------
# 3. DOWN — best-effort reverse: grammar/hanja memberships removed, vocab
#    rows round-trip in the restored 012 shape; then a clean re-up
# ---------------------------------------------------------------------------

def test_049_down_drops_multitype_rows_and_restores_012_shape(
    env, dsn: str, full_dir
) -> None:
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0, f"initial full up returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "049-down@example.com")
        v1 = _seed_vocab_entry(conn, "보다")
        g1 = _seed_kgiu_entry(conn, "-(으)ㄹ까 하다")
        h1 = _seed_hanja_character(conn, "火")
        lst = _seed_list(conn, user, "혼합 목록")
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO vocab_list_entries
                        (list_id, entry_id, kgiu_entry_id, hanja_character_id, position)
                VALUES (%s, %s,   NULL, NULL, 0),
                       (%s, NULL, %s,   NULL, 1),
                       (%s, NULL, NULL, %s,   2)
                """,
                (lst, v1, lst, g1, lst, h1),
            )

    # --allow-destructive: 049.down's own data loss (DELETE + DROP COLUMN)
    # does not match DESTRUCTIVE_PATTERNS — same caveat as 046.down — but in
    # the merged chain this `down --target 048` first traverses the LATER
    # gated downs (052/051 DROP TABLE), so the runner requires the flag
    # anyway. Either way, rolling back 049 is a deliberate decision to
    # discard grammar/hanja memberships.
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_049, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {PRE_049} returned {rc}"

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        # Schema restored to the 012 shape: NOT NULL back, 049 columns gone,
        # the untouched 012 UNIQUE + FK still in place under their own names.
        cols = _columns(conn, "vocab_list_entries")
        assert "entry_id" in cols
        assert not {"vocab_entry_id", "kgiu_entry_id", "hanja_character_id"} & cols
        assert not _is_nullable(conn, "vocab_list_entries", "entry_id")
        con_names = _constraint_names(conn, "vocab_list_entries")
        assert "uq_vocab_list_entries_list_entry" in con_names
        assert "ck_vocab_list_entries_target_xor" not in con_names
        assert "fk_vocab_list_entries_entry" in con_names
        idx = _index_names(conn, "vocab_list_entries")
        assert not {
            "uq_vocab_list_entries_list_kgiu",
            "uq_vocab_list_entries_list_hanja",
            "ix_vocab_list_entries_entry",
        } & idx

        # Data: only the vocab membership survives, losslessly.
        with conn.cursor() as cur:
            cur.execute(
                "SELECT entry_id, position FROM vocab_list_entries WHERE list_id = %s",
                (lst,),
            )
            rows = cur.fetchall()
        assert [(r["entry_id"], r["position"]) for r in rows] == [(v1, 0)]

        # The reference rows themselves are untouched — only membership went.
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) AS n FROM kgiu_entries WHERE id = %s", (g1,))
            assert cur.fetchone()["n"] == 1
            cur.execute(
                "SELECT count(*) AS n FROM hanja_characters WHERE id = %s", (h1,)
            )
            assert cur.fetchone()["n"] == 1

    # Re-up: 049 applies cleanly on the restored state; the surviving row
    # comes back as a vocab membership.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0, f"re-apply of 049 after rollback returned {rc}"

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT entry_id, kgiu_entry_id, hanja_character_id
                  FROM vocab_list_entries WHERE list_id = %s
                """,
                (lst,),
            )
            rows = cur.fetchall()
        assert len(rows) == 1
        assert rows[0]["entry_id"] == v1
        assert rows[0]["kgiu_entry_id"] is None
        assert rows[0]["hanja_character_id"] is None
