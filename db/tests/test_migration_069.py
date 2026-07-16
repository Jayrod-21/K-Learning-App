"""Migration 069 (upload_extractions, ticket F-108) — real-chain tests.

WHY THIS FILE EXISTS:
    069 is the U2 extraction pipeline's storage: the `upload_extractions` run
    table (status lifecycle, page range, result counts, bounded error) plus
    the two kgiu_entries CHECK relaxations that admit 'user_mined' grammar
    rows. Its value is in the lifecycle + cost topology, and one behavior is
    SECURITY-LOAD-BEARING (fixpass b8 BLOCKER-1): the run row is the per-user
    daily Vision-page COST LEDGER, so `fk_upload_extractions_upload` must be
    ON DELETE SET NULL — a CASCADE would let `DELETE /uploads/:id` erase
    today's charged pages and reset the cap on demand. These tests apply the
    REAL migration chain against a real Postgres-16 testcontainer via
    ``migrate.main()`` and PROVE each guard by attempting the write (or
    delete) it must reject or survive.

SCOPE:
    - markers: up is non-destructive, down destructive (F-088 classification).
    - up: applies on the full real chain; re-applying the body is a no-op
      (enum DO-block, IF NOT EXISTS, CREATE OR REPLACE TRIGGER, DROP+ADD
      CONSTRAINT are all re-runnable).
    - relaxed CHECKs: a live pipeline-shaped 'user_mined' kgiu INSERT passes
      (any book_level — the sentinel convention), while a non-user_mined
      corpus/level mismatch still fails.
    - BLOCKER-1 pin: deleting the parent book_uploads row keeps the ledger
      row, nulls upload_id, and the partial-unique live-run claim still
      arbitrates (a second live run 23505s; orphaned NULL rows never block).
    - down: refused without --allow-destructive; with it, reverses cleanly on
      an EMPTY user_mined kgiu corpus (table + enum gone, original CHECKs
      restored verbatim so a user_mined kgiu INSERT is rejected again); FAILS
      LOUDLY when user_mined kgiu rows exist (ADD CONSTRAINT validates
      existing rows — 022's documented posture); re-up is clean.

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
from psycopg import errors
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

# The migration immediately before 069. `down --target PRE_069` rolls back
# ONLY 069 (its DROP TABLE down is what requires --allow-destructive).
PRE_069 = "067"

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


def _seed_book_upload(conn: psycopg.Connection, user_id: int, title: str = "테스트 책") -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO book_uploads (user_id, title, type, status, byte_size)
            VALUES (%s, %s, 'grammar'::book_upload_type, 'ready'::book_upload_status, 1024)
            RETURNING id
            """,
            (user_id, title),
        )
        return cur.fetchone()[0]


def _seed_run(
    conn: psycopg.Connection,
    upload_id: int,
    user_id: int,
    status: str = "done",
    pages_requested: int = 10,
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO upload_extractions
                (upload_id, user_id, status, page_from, page_to, pages_requested,
                 started_at)
            VALUES (%s, %s, %s::upload_extraction_status, 1, %s, %s, now())
            RETURNING id
            """,
            (upload_id, user_id, status, pages_requested, pages_requested),
        )
        return cur.fetchone()[0]


def _user_mined_corpus_source_id(conn: psycopg.Connection) -> int:
    """The corpus_sources row migration 022 seeds — the pipeline's provenance
    anchor for every extracted row."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute("SELECT id FROM corpus_sources WHERE corpus = 'user_mined'::corpus")
        row = cur.fetchone()
        assert row is not None, "022's user_mined corpus_sources seed row is missing"
        return row[0]


def _insert_user_mined_kgiu(
    conn: psycopg.Connection,
    source_id: str,
    book_level: str = "beginner",
) -> int:
    """A pipeline-shaped 'user_mined' kgiu INSERT — mirrors
    services/uploadExtract.ts persistExtraction's column choices."""
    csid = _user_mined_corpus_source_id(conn)
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO kgiu_entries (
                corpus_source_id, corpus, source_id, book_level, entry_type,
                source_book, source_pages, pattern, title_en, explanation,
                category, proficiency, domain)
            VALUES (%s, 'user_mined'::corpus, %s, %s::book_level,
                    'grammar'::kgiu_entry_type, 'book-upload', %s,
                    '-았/었더니', 'having done X', 'result of a past action',
                    'uploaded', 'L3'::proficiency_level, 'general'::content_domain)
            RETURNING id
            """,
            (csid, source_id, book_level, [3, 7]),
        )
        return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# 1. F-088 marker classification.
# ---------------------------------------------------------------------------

def test_069_marker_classification() -> None:
    up_sql = (REAL_MIGRATIONS_DIR / "069_upload_extractions.up.sql").read_text(
        encoding="utf-8"
    )
    down_sql = (REAL_MIGRATIONS_DIR / "069_upload_extractions.down.sql").read_text(
        encoding="utf-8"
    )
    assert migrate.explicit_destructiveness(up_sql) is False
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — applies on the real chain; the body is idempotent; the relaxed
#    CHECKs admit a live user_mined kgiu row (and ONLY widen — a curated-
#    corpus mismatch still fails).
# ---------------------------------------------------------------------------

def test_069_up_applies_and_reapply_is_idempotent(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    up_sql = (REAL_MIGRATIONS_DIR / "069_upload_extractions.up.sql").read_text(
        encoding="utf-8"
    )
    with psycopg.connect(dsn, autocommit=True) as conn:
        # Drive the body a second time directly (the runner skips an applied
        # version): enum DO-block, IF NOT EXISTS, CREATE OR REPLACE TRIGGER,
        # DROP CONSTRAINT IF EXISTS + ADD must all be re-runnable.
        with conn.cursor() as cur:
            cur.execute(up_sql)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM upload_extractions")
            assert cur.fetchone()[0] == 0
            cur.execute(
                """
                SELECT count(*) FROM pg_indexes
                 WHERE tablename = 'upload_extractions'
                   AND indexname = 'uq_upload_extractions_upload_live'
                """
            )
            assert cur.fetchone()[0] == 1


def test_069_relaxed_checks_admit_live_user_mined_kgiu_rows(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        # The pipeline's exact shape (book_level 'beginner' sentinel) passes…
        _insert_user_mined_kgiu(conn, "upload-1-았었더니", book_level="beginner")
        # …and the level CHECK's user_mined branch is level-agnostic (any
        # book_level satisfies it — the sentinel carries no meaning).
        _insert_user_mined_kgiu(conn, "upload-1-거든요", book_level="advanced")
        # Strictly-more-permissive only: a curated corpus still binds level.
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                csid = _user_mined_corpus_source_id(conn)
                cur.execute(
                    """
                    INSERT INTO kgiu_entries (
                        corpus_source_id, corpus, source_id, book_level,
                        entry_type, source_book, pattern, proficiency)
                    VALUES (%s, 'kgiu_beginner'::corpus, 'bad-level-row',
                            'advanced'::book_level, 'grammar'::kgiu_entry_type,
                            'x', '-지만', 'L3'::proficiency_level)
                    """,
                    (csid,),
                )


# ---------------------------------------------------------------------------
# 3. BLOCKER-1 pin — the cost ledger survives its upload's deletion.
# ---------------------------------------------------------------------------

def test_069_upload_delete_keeps_ledger_row_and_nulls_upload_id(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "ledger@test.dev")
        upload_id = _seed_book_upload(conn, user_id)
        run_id = _seed_run(conn, upload_id, user_id, status="done", pages_requested=50)

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("DELETE FROM book_uploads WHERE id = %s", (upload_id,))
            # The run row SURVIVED (ON DELETE SET NULL, not CASCADE) — under a
            # CASCADE this SELECT returns nothing and the daily Vision-page
            # cap would be resettable by DELETE /uploads/:id.
            cur.execute(
                """
                SELECT upload_id, user_id, pages_requested
                  FROM upload_extractions WHERE id = %s
                """,
                (run_id,),
            )
            row = cur.fetchone()
            assert row is not None, "ledger row must survive its upload's deletion"
            assert row[0] is None, "upload_id must be SET NULL, not kept dangling"
            assert row[1] == user_id
            assert row[2] == 50, "the charged pages stay on the user's ledger"

            # …and the per-user cap SUM (the query the claim tx runs) still
            # counts the orphaned row.
            cur.execute(
                """
                SELECT COALESCE(SUM(pages_requested), 0)::int
                  FROM upload_extractions
                 WHERE user_id = %s AND created_at >= date_trunc('day', now())
                """,
                (user_id,),
            )
            assert cur.fetchone()[0] == 50


def test_069_live_run_claim_still_arbitrates_after_set_null(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "claims@test.dev")
        upload_a = _seed_book_upload(conn, user_id, "책 A")
        upload_b = _seed_book_upload(conn, user_id, "책 B")

        # One live run per upload: the partial unique still rejects a second
        # live claim for the SAME upload…
        _seed_run(conn, upload_a, user_id, status="running")
        with pytest.raises(errors.UniqueViolation):
            _seed_run(conn, upload_a, user_id, status="running")

        # …a SETTLED run never blocks a new claim…
        _seed_run(conn, upload_b, user_id, status="failed")
        _seed_run(conn, upload_b, user_id, status="running")

        # …and orphaned (upload deleted → NULL upload_id) live rows are
        # outside the arbiter: NULLs never collide, so two can coexist and
        # block nothing (they are ledger rows, not claims, once orphaned).
        with conn.cursor() as cur:
            cur.execute("DELETE FROM book_uploads WHERE id = %s", (upload_a,))
            cur.execute("DELETE FROM book_uploads WHERE id = %s", (upload_b,))
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                SELECT count(*) FROM upload_extractions
                 WHERE upload_id IS NULL AND status = 'running'
                """
            )
            assert cur.fetchone()[0] == 2
        upload_c = _seed_book_upload(conn, user_id, "책 C")
        _seed_run(conn, upload_c, user_id, status="running")  # not blocked


# ---------------------------------------------------------------------------
# 4. DOWN — destructive gate; clean reverse on an empty extracted corpus;
#    FAILS LOUDLY on a populated one; re-up clean.
# ---------------------------------------------------------------------------

def test_069_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    # Refused without the flag (DROP TABLE + explicit marker).
    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", PRE_069, "down"])
    assert rc != 0, "069.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_069, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {PRE_069} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT to_regclass('public.upload_extractions')")
            assert cur.fetchone()[0] is None, "table must be gone after down"
            cur.execute(
                "SELECT count(*) FROM pg_type WHERE typname = 'upload_extraction_status'"
            )
            assert cur.fetchone()[0] == 0, "enum must be gone after down"
        # The original CHECKs are restored verbatim: a user_mined kgiu row is
        # rejected again (by the corpus CHECK — the pre-069 definition).
        with pytest.raises(errors.CheckViolation):
            _insert_user_mined_kgiu(conn, "upload-1-post-down")

    # Round trip: re-up rebuilds the post-069 state.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0
    with psycopg.connect(dsn, autocommit=True) as conn:
        _insert_user_mined_kgiu(conn, "upload-1-post-reup")


def test_069_down_fails_loudly_on_populated_user_mined_kgiu_corpus(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        _insert_user_mined_kgiu(conn, "upload-9-패턴")

    # ADD CONSTRAINT validates existing rows — the populated extracted corpus
    # must make the down FAIL rather than silently strand invalid rows
    # (mirrors migration 022's documented posture for vocab_entries).
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_069, "--allow-destructive", "down"]
    )
    assert rc != 0, "down must fail loudly while user_mined kgiu rows exist"

    # The operator deliberately removes the extracted rows → down succeeds.
    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM kgiu_entries WHERE corpus = 'user_mined'::corpus")
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_069, "--allow-destructive", "down"]
    )
    assert rc == 0
