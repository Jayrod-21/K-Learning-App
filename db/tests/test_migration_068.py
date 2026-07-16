"""Migration 068 (grammar_entries.source_upload_id, ticket F-107) — real-chain
tests.

WHY THIS FILE EXISTS:
    068 adds a nullable `source_upload_id` FK on `grammar_entries` — the
    user-saved upload-provenance dimension for the grammar save path
    (`POST /grammar/bank`), mirroring the column migration 040 put on
    `vocab_entries`/`kgiu_entries` for the vocab side. The route layer owns
    the ownership validation ("the upload must belong to the saving user")
    and its own test coverage (server/tests/routes/grammar.test.ts); this
    file proves the DATABASE-level contract those routes depend on: the
    column shape, the FK actually rejecting a dangling upload id, ON DELETE
    SET NULL un-tagging (not deleting) banked patterns when the upload goes
    away, and the F-088 marker classification on both SQL files.

SCOPE:
    - up: source_upload_id is a nullable BIGINT FK -> book_uploads(id); NULL
      is valid (every pre-068 row / non-upload save); a dangling id is a
      ForeignKeyViolation; deleting the referenced upload SET-NULLs the tag
      while the grammar row survives; the up file classifies as
      non-destructive via the F-088 marker.
    - down: DROP COLUMN removes source_upload_id (+ the FK + partial index
      with it); the down file classifies as destructive via the F-088 marker
      (the DROP COLUMN shape the legacy sniff would NOT catch — same shape
      as 063/066's own downs); existing grammar rows survive; re-up is clean
      even with rows present (nullable column, no NOT NULL to trip on a
      populated table).

DETERMINISM:
    Mirrors test_migration_066.py — real migration files copied into a
    tmp_path-scoped dir, runner pointed at it via --migrations-dir, fresh
    schema per test.
"""

from __future__ import annotations

import pathlib
import shutil
from typing import Iterable

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

FAKE_HASH = "$argon2id$" + "x" * 70

# The migration immediately before 068 in this file's minimal chain — the
# down-target that rolls back exactly 068 and nothing else. 040 creates
# book_uploads (the FK target); 001 creates grammar_entries itself.
PRE_068 = "040"


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


def _copy_real_migrations(dest: pathlib.Path, versions: Iterable[str]) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    wanted = set(versions)
    copied: set[str] = set()
    for src in REAL_MIGRATIONS_DIR.iterdir():
        if src.suffix != ".sql" or not src.is_file():
            continue
        version_prefix = src.name.split("_", 1)[0]
        if version_prefix in wanted:
            shutil.copy2(src, dest / src.name)
            copied.add(version_prefix)
    missing = wanted - copied
    if missing:
        raise FileNotFoundError(
            f"expected real migration files for versions {sorted(missing)} "
            f"under {REAL_MIGRATIONS_DIR}, found none"
        )


@pytest.fixture()
def provenance_dir(tmp_path: pathlib.Path) -> pathlib.Path:
    """001 (users, grammar_entries, set_updated_at()) + 002 (vocab_entries /
    kgiu_entries — 040 ALTERs both, so 002 must precede it) + 040
    (book_uploads, the FK target) + 068 (the column under test)."""
    d = tmp_path / "migrations_grammar_provenance"
    _copy_real_migrations(d, versions={"001", "002", "040", "068"})
    return d


def _seed_user(conn: psycopg.Connection, email: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id",
            (email, FAKE_HASH),
        )
        return cur.fetchone()[0]


def _seed_upload(conn: psycopg.Connection, user_id: int, title: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO book_uploads (user_id, title, type, blob_ref, byte_size)
            VALUES (%s, %s, 'grammar'::book_upload_type, %s, 1024)
            RETURNING id
            """,
            (user_id, title, f"{user_id}/test.pdf"),
        )
        return cur.fetchone()[0]


def _seed_grammar_entry(
    conn: psycopg.Connection, user_id: int, pattern_key: str, source_upload_id
) -> int:
    # 'ending' satisfies 001's own category CHECK (this minimal chain predates
    # 034's relaxation, which is a different migration's concern).
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO grammar_entries
                    (user_id, pattern_key, pattern_display, summary_en,
                     proficiency, category, source_upload_id)
            VALUES (%s, %s, '-은걸', 'mild exclamation',
                    'L3'::proficiency_level, 'ending', %s)
            RETURNING id
            """,
            (user_id, pattern_key, source_upload_id),
        )
        return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# 1. F-088 marker: 068's up is non-destructive, down is destructive.
# ---------------------------------------------------------------------------

def test_068_marker_classification() -> None:
    up_sql = (
        REAL_MIGRATIONS_DIR / "068_grammar_entries_source_upload.up.sql"
    ).read_text(encoding="utf-8")
    down_sql = (
        REAL_MIGRATIONS_DIR / "068_grammar_entries_source_upload.down.sql"
    ).read_text(encoding="utf-8")
    assert migrate.explicit_destructiveness(up_sql) is False
    assert not migrate.contains_destructive(up_sql)
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


def test_068_up_applies_without_allow_destructive(
    env, dsn: str, provenance_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(provenance_dir), "up"])
    assert rc == 0, "068 up must not require --allow-destructive (F-088 marker)"


# ---------------------------------------------------------------------------
# 2. Schema shape: nullable FK — NULL valid, real upload id persists, a
#    dangling id is rejected, and deleting the upload SET-NULLs the tag.
# ---------------------------------------------------------------------------

def test_068_column_accepts_null_and_a_real_owned_upload(
    env, dsn: str, provenance_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(provenance_dir), "up"])
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f107-accepts@example.com")
        upload_id = _seed_upload(conn, user_id, "문법책")
        id_null = _seed_grammar_entry(conn, user_id, "GR-null-tag", None)
        id_tagged = _seed_grammar_entry(conn, user_id, "GR-tagged", upload_id)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT id, source_upload_id FROM grammar_entries "
                "WHERE id IN (%s, %s) ORDER BY id",
                (id_null, id_tagged),
            )
            rows = {r[0]: r[1] for r in cur.fetchall()}
            assert rows[id_null] is None
            assert rows[id_tagged] == upload_id


def test_068_fk_rejects_a_dangling_upload_id(
    env, dsn: str, provenance_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(provenance_dir), "up"])
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f107-dangling@example.com")
        with pytest.raises(errors.ForeignKeyViolation):
            _seed_grammar_entry(conn, user_id, "GR-dangling", 99_999_999)


def test_068_deleting_the_upload_untags_but_keeps_the_pattern(
    env, dsn: str, provenance_dir: pathlib.Path
) -> None:
    """ON DELETE SET NULL — the whole point of mirroring 040's posture: the
    user's banked pattern outlives the source PDF; only the tag clears."""
    rc = migrate.main(["--migrations-dir", str(provenance_dir), "up"])
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f107-setnull@example.com")
        upload_id = _seed_upload(conn, user_id, "삭제될 책")
        entry_id = _seed_grammar_entry(conn, user_id, "GR-survivor", upload_id)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("DELETE FROM book_uploads WHERE id = %s", (upload_id,))
            cur.execute(
                "SELECT source_upload_id FROM grammar_entries WHERE id = %s",
                (entry_id,),
            )
            row = cur.fetchone()
            assert row is not None, "the banked pattern must survive the delete"
            assert row[0] is None, "the tag must clear (ON DELETE SET NULL)"


# ---------------------------------------------------------------------------
# 3. DOWN — DROP COLUMN removes source_upload_id (+ FK + index), requires
#    --allow-destructive (F-088 marker); grammar rows survive; re-up is clean
#    even with rows present.
# ---------------------------------------------------------------------------

def test_068_down_requires_allow_destructive_then_drops_column(
    env, dsn: str, provenance_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(provenance_dir), "up"])
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f107-down@example.com")
        upload_id = _seed_upload(conn, user_id, "롤백 책")
        _seed_grammar_entry(conn, user_id, "GR-rollback", upload_id)

    # The gate must refuse without the flag (F-088 marker declares 068.down
    # destructive even though DROP COLUMN has no keyword the legacy sniff
    # catches — same shape as 063/066's own downs).
    rc = migrate.main(
        ["--migrations-dir", str(provenance_dir), "--target", PRE_068, "down"]
    )
    assert rc != 0, "068.down is marked destructive — the gate must refuse it"

    rc = migrate.main(
        [
            "--migrations-dir",
            str(provenance_dir),
            "--target",
            PRE_068,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_068} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor(
        row_factory=tuple_row
    ) as cur:
        cur.execute(
            """
            SELECT 1 FROM information_schema.columns
             WHERE table_name = 'grammar_entries'
               AND column_name = 'source_upload_id'
            """
        )
        assert cur.fetchone() is None, "source_upload_id must be gone after 068 down"
        # The banked pattern survives (only its provenance column is dropped).
        cur.execute("SELECT count(*) FROM grammar_entries")
        assert cur.fetchone()[0] == 1


def test_068_re_up_is_clean_even_with_existing_rows(
    env, dsn: str, provenance_dir: pathlib.Path
) -> None:
    """The column is NULLable — re-up must succeed with grammar_entries rows
    already present (each backfills source_upload_id = NULL, the honest
    "unknown" for saves that predate the provenance dimension)."""
    rc = migrate.main(["--migrations-dir", str(provenance_dir), "up"])
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f107-reup@example.com")
        _seed_grammar_entry(conn, user_id, "GR-reup", None)

    rc = migrate.main(
        [
            "--migrations-dir",
            str(provenance_dir),
            "--target",
            PRE_068,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0

    rc = migrate.main(["--migrations-dir", str(provenance_dir), "up"])
    assert rc == 0, "068 must re-apply cleanly over grammar_entries with rows"

    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor(
        row_factory=tuple_row
    ) as cur:
        cur.execute(
            "SELECT source_upload_id FROM grammar_entries WHERE pattern_key = 'GR-reup'"
        )
        row = cur.fetchone()
        assert row is not None
        assert row[0] is None
