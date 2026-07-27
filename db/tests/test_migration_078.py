"""Migration 078 (TOPIK listening audio, F-119) — real-chain tests.

WHY THIS FILE EXISTS:
    078 is the schema half of the whole-file + offsets model: the paper's
    whole-section MP3 maps onto topik_tests.audio_path (035's relative-key
    contract) and each question carries an (audio_start_ms, audio_end_ms)
    window on topik_items, guarded by ck_topik_items_audio_span. The
    load-bearing behavior is the BOTH-OR-NEITHER span CHECK: the plan's
    shorthand `(start >= 0 AND end > start)` alone would ACCEPT a half-span
    through NULL-propagation (one bound NULL makes the arm NULL, and a CHECK
    accepts NULL), so the migration spells out the IS NOT NULL conjuncts —
    these tests PROVE a half-written window is impossible at rest, on INSERT
    and on the loader's own write shape (UPDATE). They apply the REAL
    migration chain against a real Postgres-16 testcontainer via
    ``migrate.main()``.

SCOPE:
    - markers: up is non-destructive, down destructive (the DROP COLUMN
      shape the legacy sniff misses — F-088's point).
    - up: applies on the full real chain; all three columns exist, nullable,
      with the declared types; the CHECK exists (conrelid-scoped);
      re-driving the body is a no-op (ADD COLUMN IF NOT EXISTS + the
      DO-guarded ADD CONSTRAINT).
    - populated-table upgrade: up to 077, seed a listening paper + items,
      apply 078 over them — every pre-existing row survives with all three
      new columns NULL.
    - span CHECK: both-NULL and a valid span (including start = 0) are
      accepted; a half-span (either bound alone) is rejected on INSERT and
      on UPDATE; end <= start and a negative start are rejected.
    - paired questions: two items of the same paper carrying IDENTICAL
      spans both insert (the deliberate denormalization, plan §3).
    - down: refused without --allow-destructive; with it, the constraint and
      all three columns are gone, the pre-down item ROWS survive (only the
      mapping is lossy — 035's posture), and re-up restores span writes.

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

# The migration immediately before 078. `down --target PRE_078` rolls back
# ONLY 078 (its DROP COLUMN down is what requires --allow-destructive).
PRE_078 = "077"

AUDIO_PATH = "TOPIK TEST/60 - 60th TOPIK/TOPIK-II/60th-TOPIK-II-Listening-Audio.mp3"


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


def _seed_topik_test(
    conn: psycopg.Connection,
    test_number: int = 60,
    audio_path: str | None = None,
) -> int:
    corpus_source_id = _ensure_corpus_source(conn, "topik")
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO topik_tests
                (corpus_source_id, test_number, topik_level, section, audio_path)
            VALUES (%s, %s, 'TOPIK II', 'listening'::topik_section, %s)
            RETURNING id
            """,
            (corpus_source_id, test_number, audio_path),
        )
        return cur.fetchone()[0]


def _seed_pre078_topik_test(conn: psycopg.Connection, test_number: int = 60) -> int:
    """The same paper row, minus the columns 078 has not added yet."""
    corpus_source_id = _ensure_corpus_source(conn, "topik")
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO topik_tests (corpus_source_id, test_number, topik_level, section)
            VALUES (%s, %s, 'TOPIK II', 'listening'::topik_section)
            RETURNING id
            """,
            (corpus_source_id, test_number),
        )
        return cur.fetchone()[0]


def _seed_item(
    conn: psycopg.Connection,
    test_id: int,
    item_number: int,
    start_ms: int | None = None,
    end_ms: int | None = None,
) -> int:
    corpus_source_id = _ensure_corpus_source(conn, "topik")
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO topik_items
                (topik_test_id, corpus_source_id, source_id, item_number,
                 section, item_type, stem, audio_start_ms, audio_end_ms)
            VALUES (%s, %s, %s, %s, 'listening'::topik_section,
                    'multiple_choice'::topik_item_type, '듣기 지문', %s, %s)
            RETURNING id
            """,
            (
                test_id,
                corpus_source_id,
                f"topik60-listen-{item_number:03d}",
                item_number,
                start_ms,
                end_ms,
            ),
        )
        return cur.fetchone()[0]


def _column_shape(
    conn: psycopg.Connection, table: str, column: str
) -> tuple[str, str] | None:
    """(data_type, is_nullable) from information_schema, or None if absent."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT data_type, is_nullable FROM information_schema.columns
             WHERE table_schema='public' AND table_name=%s AND column_name=%s
            """,
            (table, column),
        )
        row = cur.fetchone()
        return (row[0], row[1]) if row is not None else None


def _span_check_count(conn: psycopg.Connection) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT count(*) FROM pg_constraint
             WHERE conname = 'ck_topik_items_audio_span'
               AND conrelid = 'topik_items'::regclass
               AND contype = 'c'
            """
        )
        return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# 1. F-088 marker classification.
# ---------------------------------------------------------------------------

def test_078_marker_classification() -> None:
    up_sql = (
        REAL_MIGRATIONS_DIR / "078_topik_listening_audio.up.sql"
    ).read_text(encoding="utf-8")
    down_sql = (
        REAL_MIGRATIONS_DIR / "078_topik_listening_audio.down.sql"
    ).read_text(encoding="utf-8")
    assert migrate.explicit_destructiveness(up_sql) is False
    # The down's data drop is a DROP COLUMN — the exact shape the legacy
    # keyword-sniff misses, so the explicit marker must carry it.
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — shape (types + nullability), the CHECK, re-runnable body.
# ---------------------------------------------------------------------------

def test_078_up_shape_and_reapply_is_idempotent(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    up_sql = (
        REAL_MIGRATIONS_DIR / "078_topik_listening_audio.up.sql"
    ).read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        # All three columns, nullable (NULL = unmapped, 035's contract), with
        # the declared types.
        assert _column_shape(conn, "topik_tests", "audio_path") == ("text", "YES")
        assert _column_shape(conn, "topik_items", "audio_start_ms") == (
            "integer", "YES",
        )
        assert _column_shape(conn, "topik_items", "audio_end_ms") == (
            "integer", "YES",
        )
        assert _span_check_count(conn) == 1, "ck_topik_items_audio_span missing"

        # Drive the body a second time directly (the runner skips an applied
        # version): ADD COLUMN IF NOT EXISTS and the DO-guarded ADD
        # CONSTRAINT must all be re-runnable without error or duplication.
        with conn.cursor() as cur:
            cur.execute(up_sql)

        assert _column_shape(conn, "topik_tests", "audio_path") == ("text", "YES")
        assert _span_check_count(conn) == 1, (
            "re-driving the body must not duplicate (or drop) the span CHECK"
        )


# ---------------------------------------------------------------------------
# 3. UP over POPULATED topik tables — the real upgrade path: km-db has 12
#    papers x 2 levels and ~960 listening items before 078 lands. ADD COLUMN
#    and the CHECK's validation scan must both pass over real rows, all of
#    which land in the both-NULL (unmapped) state.
# ---------------------------------------------------------------------------

def test_078_up_applies_over_populated_topik_tables(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    # Stop the chain at 077 — topik_tests/topik_items still have their
    # pre-078 shape.
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_078,
         "--allow-destructive", "up"]
    )
    assert rc == 0, f"up --target {PRE_078} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _column_shape(conn, "topik_tests", "audio_path") is None
        test_id = _seed_pre078_topik_test(conn)
        with conn.cursor(row_factory=tuple_row) as cur:
            ids = []
            for n in (1, 2):
                cur.execute(
                    """
                    INSERT INTO topik_items
                        (topik_test_id, corpus_source_id, source_id, item_number,
                         section, item_type, stem)
                    VALUES (%s, %s, %s, %s, 'listening'::topik_section,
                            'multiple_choice'::topik_item_type, '듣기 지문')
                    RETURNING id
                    """,
                    (
                        test_id,
                        _ensure_corpus_source(conn, "topik"),
                        f"topik60-listen-{n:03d}",
                        n,
                    ),
                )
                ids.append(cur.fetchone()[0])

    # Apply 078 OVER the populated tables.
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT audio_path FROM topik_tests WHERE id = %s", (test_id,)
            )
            assert cur.fetchone()[0] is None, (
                "audio_path must be NULL (unmapped) on every pre-078 paper"
            )
            cur.execute(
                """
                SELECT id, audio_start_ms, audio_end_ms FROM topik_items
                 WHERE id = ANY(%s) ORDER BY id
                """,
                (ids,),
            )
            rows = cur.fetchall()
            assert [r[0] for r in rows] == sorted(ids), (
                "every pre-078 item must survive the widen"
            )
            assert all(r[1] is None and r[2] is None for r in rows), (
                "both span bounds must be NULL on every pre-existing item"
            )
        # And the widened tables accept the loader's writes immediately —
        # its exact shape: keyed UPDATEs, not INSERTs.
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE topik_tests SET audio_path = %s WHERE id = %s",
                (AUDIO_PATH, test_id),
            )
            cur.execute(
                """
                UPDATE topik_items SET audio_start_ms = 12300, audio_end_ms = 45100
                 WHERE id = %s
                """,
                (ids[0],),
            )


# ---------------------------------------------------------------------------
# 4. The span CHECK — both-or-neither, proven on data. THE guard this
#    migration exists for: the shorthand CHECK without IS NOT NULL would
#    accept every "rejected" case below through NULL-propagation.
# ---------------------------------------------------------------------------

def test_078_span_check_accepts_none_or_complete_valid_windows(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        test_id = _seed_topik_test(conn, audio_path=AUDIO_PATH)

        # Accepted: no mapping at all (every item's state until the loader
        # runs) and a complete valid window — including start = 0 (a paper
        # whose first question opens the tape).
        _seed_item(conn, test_id, 1)
        _seed_item(conn, test_id, 2, start_ms=12300, end_ms=45100)
        _seed_item(conn, test_id, 3, start_ms=0, end_ms=1)

        # Rejected: a half-span, either way round — the NULL-propagation trap
        # the explicit IS NOT NULL conjuncts exist to close.
        with pytest.raises(errors.CheckViolation):
            _seed_item(conn, test_id, 4, start_ms=12300, end_ms=None)
        with pytest.raises(errors.CheckViolation):
            _seed_item(conn, test_id, 5, start_ms=None, end_ms=45100)

        # Rejected: zero-length, inverted, and negative-start windows.
        with pytest.raises(errors.CheckViolation):
            _seed_item(conn, test_id, 6, start_ms=45100, end_ms=45100)
        with pytest.raises(errors.CheckViolation):
            _seed_item(conn, test_id, 7, start_ms=45100, end_ms=12300)
        with pytest.raises(errors.CheckViolation):
            _seed_item(conn, test_id, 8, start_ms=-1, end_ms=45100)


def test_078_span_check_fires_on_update_too(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    """The loader writes spans via keyed UPDATE (plan §6) — the CHECK must
    hold on that path as well, so a partial/bugged loader write can never
    strand a half-span."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        test_id = _seed_topik_test(conn, audio_path=AUDIO_PATH)
        item = _seed_item(conn, test_id, 1, start_ms=12300, end_ms=45100)

        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE topik_items SET audio_end_ms = NULL WHERE id = %s",
                    (item,),
                )

        # A boundary correction — the model's whole point: a two-integer
        # UPDATE, never a re-cut — still passes.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                UPDATE topik_items SET audio_start_ms = 12000, audio_end_ms = 45500
                 WHERE id = %s
                """,
                (item,),
            )
            cur.execute(
                "SELECT audio_start_ms, audio_end_ms FROM topik_items WHERE id = %s",
                (item,),
            )
            assert cur.fetchone() == (12000, 45500)


def test_078_span_check_fires_on_update_start_null_too(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    """The NULL-propagation trap is symmetric: nulling the START while the
    end stays set is the same half-span as the end-side case above, and must
    be rejected on the loader's UPDATE path too. This raise also pins the
    constraint IDENTITY — a future second CHECK on these columns must not
    silently absorb the assertion."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        test_id = _seed_topik_test(conn, audio_path=AUDIO_PATH)
        item = _seed_item(conn, test_id, 1, start_ms=12300, end_ms=45100)

        with pytest.raises(errors.CheckViolation) as excinfo:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE topik_items SET audio_start_ms = NULL WHERE id = %s",
                    (item,),
                )
        assert (
            excinfo.value.diag.constraint_name == "ck_topik_items_audio_span"
        ), "the half-span must be rejected by the span CHECK itself"

        # The rejected UPDATE left the row untouched — still a complete,
        # valid window.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT audio_start_ms, audio_end_ms FROM topik_items WHERE id = %s",
                (item,),
            )
            assert cur.fetchone() == (12300, 45100)


def test_078_paired_items_carry_identical_spans(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    """One dialogue covering two questions (e.g. Q29-30) writes the SAME span
    on both rows — the deliberate denormalization (plan §3). Nothing about
    the schema may treat the duplicate window as a conflict."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        test_id = _seed_topik_test(conn, audio_path=AUDIO_PATH)
        first = _seed_item(conn, test_id, 29, start_ms=1523000, end_ms=1691000)
        second = _seed_item(conn, test_id, 30, start_ms=1523000, end_ms=1691000)

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                SELECT audio_start_ms, audio_end_ms FROM topik_items
                 WHERE id = ANY(%s)
                """,
                ([first, second],),
            )
            assert cur.fetchall() == [(1523000, 1691000), (1523000, 1691000)]


# ---------------------------------------------------------------------------
# 5. DOWN — destructive gate; constraint + all three columns gone, item rows
#    survive (only the mapping is lossy — 035's posture); re-up clean.
# ---------------------------------------------------------------------------

def test_078_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        test_id = _seed_topik_test(conn, audio_path=AUDIO_PATH)
        item = _seed_item(conn, test_id, 1, start_ms=12300, end_ms=45100)

    # Refused without the flag (DROP COLUMN + explicit marker).
    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", PRE_078, "down"])
    assert rc != 0, "078.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_078, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {PRE_078} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _column_shape(conn, "topik_tests", "audio_path") is None
        assert _column_shape(conn, "topik_items", "audio_start_ms") is None
        assert _column_shape(conn, "topik_items", "audio_end_ms") is None
        assert _span_check_count(conn) == 0, (
            "ck_topik_items_audio_span must drop with 078"
        )
        # Lossy on the MAPPING only: the paper and its items survive — the
        # corpus MP3s + segment JSONs are the system of record and a re-up +
        # loader re-run repopulates everything (035's posture).
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM topik_tests WHERE id = %s", (test_id,))
            assert cur.fetchone()[0] == 1
            cur.execute(
                "SELECT stem FROM topik_items WHERE id = %s", (item,)
            )
            row = cur.fetchone()
            assert row is not None, "item rows must survive the rollback"
            assert row[0] == "듣기 지문"

    # Round trip: re-up restores the columns and span writes work again.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _column_shape(conn, "topik_tests", "audio_path") == ("text", "YES")
        assert _span_check_count(conn) == 1
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE topik_items SET audio_start_ms = 12300, audio_end_ms = 45100
                 WHERE id = %s
                """,
                (item,),
            )
