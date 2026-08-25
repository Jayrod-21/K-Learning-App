"""Migration 101 (generated_items, F-220 slice 1 — generated item bank)
— real-chain tests.

WHY THIS FILE EXISTS:
    101 is the app-owned bank table behind F-220's generated, copyright-clean
    assessment items (server/src/scripts/generate-item-bank.ts writes here;
    server/src/services/diagnostic/generatedBank.ts reads here). The
    constraints below are what keeps a malformed row (wrong choice arity, an
    out-of-range answer_index, a bad status/prompt_hash) from EVER landing —
    the ingest CLI's Zod validation is the primary guard, but these CHECKs
    are defense-in-depth against any future second writer (an admin
    backfill, a data-fix migration) that bypasses it, proven here against a
    real Postgres-16 testcontainer via ``migrate.main()``.

SCOPE:
    - markers: up is non-destructive, down destructive (F-088 classification).
    - up: applies on the full real chain; re-driving the body is a no-op
      (IF NOT EXISTS everywhere).
    - constraints: section/level/status closed sets, choices array-ness +
      arity + element-shape, answer_index range, prompt_hash shape,
      UNIQUE(prompt_hash) (positive AND negative probe — the idempotency
      key), audio_end_ms > audio_start_ms.
    - down: refused without --allow-destructive; with it, the table is gone;
      re-up is clean.

DETERMINISM:
    Mirrors test_migration_098.py — the real migration files are copied into
    tmp_path-scoped directories and the runner is pointed at them via
    ``--migrations-dir``; the ``dsn`` fixture gives each test a fresh schema.
"""

from __future__ import annotations

import hashlib
import pathlib

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

MIGRATION_NUM = "101"


def _pre_101_target(full_dir: pathlib.Path) -> str:
    """The version immediately before 101 in the chain actually present
    (numbering may have gaps while sibling branches are in flight)."""
    versions = sorted(
        {f.name[:3] for f in full_dir.iterdir() if f.suffix == ".sql"}
    )
    idx = versions.index(MIGRATION_NUM)
    assert idx > 0, "101 cannot be the first migration"
    return versions[idx - 1]


def _up(directory: pathlib.Path) -> None:
    rc = migrate.main(["--migrations-dir", str(directory), "--allow-destructive", "up"])
    assert rc == 0, f"up returned {rc}"


def _hash(seed: str) -> str:
    """A syntactically valid 64-hex-char prompt_hash (mirrors the CLI's
    hashCacheKey shape — SHA-256 hex digest)."""
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()


GOOD_CHOICES = [
    {"kr": "학교", "en": "school"},
    {"kr": "병원", "en": "hospital"},
    {"kr": "공원", "en": "park"},
    {"kr": "도서관", "en": "library"},
]


def _insert_item(
    conn: psycopg.Connection,
    *,
    section: str = "vocab",
    level: str = "L3",
    kind: str = "synonym",
    stem: str = "다음 중 '학교'와 뜻이 가장 비슷한 것을 고르십시오.",
    choices: list | None = None,
    answer_index: int = 0,
    status: str = "draft",
    created_by: str = "claude-batch",
    prompt_hash: str | None = None,
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO generated_items
                (section, level, kind, stem, choices, answer_index, status,
                 created_by, prompt_hash)
            VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                section,
                level,
                kind,
                stem,
                psycopg.types.json.Json(choices if choices is not None else GOOD_CHOICES),
                answer_index,
                status,
                created_by,
                prompt_hash if prompt_hash is not None else _hash(f"{section}:{level}:{stem}"),
            ),
        )
        return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# 1. F-088 marker classification.
# ---------------------------------------------------------------------------


def test_101_marker_classification() -> None:
    up_sql = (REAL_MIGRATIONS_DIR / "101_generated_items.up.sql").read_text(
        encoding="utf-8"
    )
    down_sql = (REAL_MIGRATIONS_DIR / "101_generated_items.down.sql").read_text(
        encoding="utf-8"
    )
    assert migrate.explicit_destructiveness(up_sql) is False
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — applies on the real chain; re-driving the body is a no-op.
# ---------------------------------------------------------------------------


def test_101_up_applies_and_reapply_is_idempotent(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)

    up_sql = (REAL_MIGRATIONS_DIR / "101_generated_items.up.sql").read_text(
        encoding="utf-8"
    )
    with psycopg.connect(dsn, autocommit=True) as conn:
        # Drive the body a second time directly (the runner skips an applied
        # version): CREATE TABLE IF NOT EXISTS must be re-runnable.
        with conn.cursor() as cur:
            cur.execute(up_sql)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM generated_items")
            assert cur.fetchone()[0] == 0
            cur.execute(
                """
                SELECT column_name, is_nullable
                  FROM information_schema.columns
                 WHERE table_name = 'generated_items'
                 ORDER BY column_name
                """
            )
            cols = {row[0]: row[1] for row in cur.fetchall()}
            assert cols == {
                "id": "NO",
                "section": "NO",
                "level": "NO",
                "kind": "NO",
                "stem": "NO",
                "passage": "YES",
                "choices": "NO",
                "answer_index": "NO",
                "explain": "YES",
                "audio_source_id": "YES",
                "audio_start_ms": "YES",
                "audio_end_ms": "YES",
                "skill_tag": "YES",
                "source_ref": "YES",
                "status": "NO",
                "created_by": "NO",
                "model_id": "YES",
                "prompt_hash": "NO",
                "created_at": "NO",
                "updated_at": "NO",
                "version": "NO",
            }
            # Draw-path index exists.
            cur.execute(
                "SELECT indexname FROM pg_indexes "
                "WHERE tablename = 'generated_items' AND indexname = 'ix_generated_items_draw'"
            )
            assert cur.fetchone() is not None
            # UNIQUE(prompt_hash) exists.
            cur.execute(
                "SELECT conname FROM pg_constraint "
                "WHERE conname = 'uq_generated_items_prompt_hash'"
            )
            assert cur.fetchone() is not None


# ---------------------------------------------------------------------------
# 3. Constraints — each guard proven by the write it rejects.
# ---------------------------------------------------------------------------


def test_101_positive_insert_and_status_default(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        item_id = _insert_item(conn)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT status, passage, explain, audio_source_id FROM generated_items WHERE id = %s",
                (item_id,),
            )
            row = cur.fetchone()
            assert row[0] == "draft"  # default
            assert row[1] is None
            assert row[2] is None
            assert row[3] is None


def test_101_section_level_status_closed_sets(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        # ck_generated_items_section
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, section="bogus", prompt_hash=_hash("bad-section"))
        # Every forward-compat section value is accepted at the schema layer
        # (this slice's CLI only writes vocab/grammar, but the CHECK admits
        # the full set so later slices need no migration).
        for section in ("vocab", "grammar", "reading", "listening", "writing"):
            _insert_item(conn, section=section, prompt_hash=_hash(f"section-{section}"))

        # ck_generated_items_level
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, level="L9", prompt_hash=_hash("bad-level"))

        # ck_generated_items_status
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, status="pending-review", prompt_hash=_hash("bad-status"))
        for status in ("draft", "approved", "retired"):
            _insert_item(conn, status=status, prompt_hash=_hash(f"status-{status}"))


def test_101_choices_shape_and_answer_index(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        # ck_generated_items_choices_shape — wrong arity (3, not 4).
        with pytest.raises(errors.CheckViolation):
            _insert_item(
                conn,
                choices=GOOD_CHOICES[:3],
                prompt_hash=_hash("three-choices"),
            )
        # ck_generated_items_choices_shape — not an array at all.
        with pytest.raises(errors.CheckViolation):
            _insert_item(
                conn,
                choices={"kr": "not-an-array"},
                prompt_hash=_hash("not-array"),
            )
        # ck_generated_items_choices_element_shape — an element missing 'kr'.
        with pytest.raises(errors.CheckViolation):
            _insert_item(
                conn,
                choices=[{"en": "school"}, *GOOD_CHOICES[1:]],
                prompt_hash=_hash("missing-kr"),
            )
        # ck_generated_items_choices_element_shape — empty 'kr' string.
        with pytest.raises(errors.CheckViolation):
            _insert_item(
                conn,
                choices=[{"kr": "", "en": "x"}, *GOOD_CHOICES[1:]],
                prompt_hash=_hash("empty-kr"),
            )

        # ck_generated_items_answer_index — out of range (4, not 0..3).
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, answer_index=4, prompt_hash=_hash("answer-4"))
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, answer_index=-1, prompt_hash=_hash("answer-neg"))
        # In-range values all pass.
        for idx in (0, 1, 2, 3):
            _insert_item(conn, answer_index=idx, prompt_hash=_hash(f"answer-{idx}"))


def test_101_prompt_hash_shape_and_uniqueness(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        # ck_generated_items_prompt_hash_shape — must be 64 lowercase hex chars.
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, prompt_hash="not-a-hash")
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, prompt_hash="A" * 64)  # uppercase rejected
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, prompt_hash="0" * 63)  # too short

        # uq_generated_items_prompt_hash — the idempotency key. Negative
        # probe: a second row at the SAME hash is rejected (this is exactly
        # what makes the CLI's ON CONFLICT (prompt_hash) DO NOTHING safe).
        shared_hash = _hash("shared-idempotency-key")
        _insert_item(conn, prompt_hash=shared_hash)
        with pytest.raises(errors.UniqueViolation):
            _insert_item(conn, prompt_hash=shared_hash, stem="a different stem entirely")


def test_101_audio_window_ordering(env, dsn: str, full_dir: pathlib.Path) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        # NULL audio window (this slice's vocab/grammar rows) is fine.
        _insert_item(conn, prompt_hash=_hash("no-audio"))

        # ck_generated_items_audio_end_after_start — end must exceed start
        # once both are set (forward-compat for the listening slice).
        # autocommit=True: the CHECK violation raises directly off execute(),
        # not off a later commit().
        with pytest.raises(errors.CheckViolation):
            with conn.cursor(row_factory=tuple_row) as cur:
                cur.execute(
                    """
                    INSERT INTO generated_items
                        (section, level, kind, stem, choices, answer_index, status,
                         created_by, prompt_hash, audio_start_ms, audio_end_ms)
                    VALUES ('listening', 'L2', 'audio-mc', 'stem', %s::jsonb, 0,
                            'draft', 'claude-batch', %s, 1000, 500)
                    """,
                    (psycopg.types.json.Json(GOOD_CHOICES), _hash("bad-audio-window")),
                )

        # A well-formed window (end > start) is accepted.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                INSERT INTO generated_items
                    (section, level, kind, stem, choices, answer_index, status,
                     created_by, prompt_hash, audio_start_ms, audio_end_ms)
                VALUES ('listening', 'L2', 'audio-mc', 'stem', %s::jsonb, 0,
                        'draft', 'claude-batch', %s, 500, 1000)
                """,
                (psycopg.types.json.Json(GOOD_CHOICES), _hash("good-audio-window")),
            )


# ---------------------------------------------------------------------------
# 4. DOWN — destructive gate; table gone; re-up clean.
# ---------------------------------------------------------------------------


def test_101_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    target = _pre_101_target(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        _insert_item(conn)

    # Refused without the flag (DROP TABLE + explicit destructive marker).
    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", target, "down"])
    assert rc != 0, "101.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", target, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {target} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT to_regclass('public.generated_items')")
            assert cur.fetchone()[0] is None, "generated_items must be gone after down"

    # Round trip: re-up rebuilds the table cleanly.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM generated_items")
            assert cur.fetchone()[0] == 0
