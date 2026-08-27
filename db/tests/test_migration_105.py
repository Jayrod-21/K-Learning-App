"""Migration 105 (generated_items stimulus-group columns, F-220 P1 —
paired-stimulus reading/listening items) — real-chain tests.

WHY THIS FILE EXISTS:
    105 adds the ONE genuine schema gap F-220 P1 needs: a way for 2-3
    `generated_items` rows to declare "we share one generated passage/audio
    clip" (`stimulus_group_id` + `stimulus_group_ordinal`). The constraints
    below are what keeps a malformed group (an ordinal with no group id, a
    non-positive ordinal, an over-length group id) from ever landing —
    defense-in-depth behind the ingest CLI's own construction, proven here
    against a real Postgres-16 testcontainer via ``migrate.main()``.

SCOPE:
    - markers: up is non-destructive, down destructive (F-088 classification).
    - up: applies on the full real chain; re-driving the body is a no-op
      (IF NOT EXISTS / DO-guarded everywhere).
    - constraints: stimulus_group_id length bound, stimulus_group_ordinal
      positivity, the both-null-or-both-set pairing CHECK, the partial index.
    - down: refused without --allow-destructive; with it, the columns/index
      are gone; re-up is clean.

DETERMINISM:
    Mirrors test_migration_103.py — the real migration files are copied into
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

MIGRATION_NUM = "105"


def _pre_target(full_dir: pathlib.Path, num: str) -> str:
    """The version immediately before `num` in the chain actually present
    (numbering may have gaps while sibling branches are in flight)."""
    versions = sorted(
        {f.name[:3] for f in full_dir.iterdir() if f.suffix == ".sql"}
    )
    idx = versions.index(num)
    assert idx > 0, f"{num} cannot be the first migration"
    return versions[idx - 1]


def _up(directory: pathlib.Path, target: str | None = None) -> None:
    args = ["--migrations-dir", str(directory), "--allow-destructive"]
    if target is not None:
        args += ["--target", target]
    args.append("up")
    rc = migrate.main(args)
    assert rc == 0, f"up returned {rc}"


def _hash(seed: str) -> str:
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
    section: str = "reading",
    kind: str = "paired-passage-mc",
    passage: str | None = "지문 텍스트입니다.",
    stimulus_group_id: str | None = None,
    stimulus_group_ordinal: int | None = None,
    prompt_hash: str | None = None,
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO generated_items
                (section, level, kind, stem, passage, choices, answer_index, status,
                 created_by, prompt_hash, stimulus_group_id, stimulus_group_ordinal)
            VALUES (%s, 'L3', %s, 'stem', %s, %s::jsonb, 0,
                    'draft', 'claude-batch', %s, %s, %s)
            RETURNING id
            """,
            (
                section,
                kind,
                passage,
                psycopg.types.json.Json(GOOD_CHOICES),
                prompt_hash
                if prompt_hash is not None
                else _hash(f"item:{stimulus_group_id}:{stimulus_group_ordinal}"),
                stimulus_group_id,
                stimulus_group_ordinal,
            ),
        )
        return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# 1. F-088 marker classification.
# ---------------------------------------------------------------------------


def test_105_marker_classification() -> None:
    up_sql = (
        REAL_MIGRATIONS_DIR / "105_generated_items_stimulus_group.up.sql"
    ).read_text(encoding="utf-8")
    down_sql = (
        REAL_MIGRATIONS_DIR / "105_generated_items_stimulus_group.down.sql"
    ).read_text(encoding="utf-8")
    assert migrate.explicit_destructiveness(up_sql) is False
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — columns + index exist; re-driving the body is a no-op.
# ---------------------------------------------------------------------------


def test_105_up_adds_columns_and_index_and_reapply_is_idempotent(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)

    up_sql = (
        REAL_MIGRATIONS_DIR / "105_generated_items_stimulus_group.up.sql"
    ).read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(up_sql)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                SELECT column_name, is_nullable, data_type
                  FROM information_schema.columns
                 WHERE table_name = 'generated_items'
                   AND column_name IN ('stimulus_group_id', 'stimulus_group_ordinal')
                 ORDER BY column_name
                """
            )
            rows = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
            assert rows["stimulus_group_id"] == ("YES", "text")
            assert rows["stimulus_group_ordinal"] == ("YES", "integer")

            cur.execute(
                "SELECT indexname FROM pg_indexes "
                "WHERE tablename = 'generated_items' "
                "AND indexname = 'ix_generated_items_stimulus_group'"
            )
            assert cur.fetchone() is not None


# ---------------------------------------------------------------------------
# 3. Constraints.
# ---------------------------------------------------------------------------


def test_105_both_null_is_fine(env, dsn: str, full_dir: pathlib.Path) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        item_id = _insert_item(conn, stimulus_group_id=None, stimulus_group_ordinal=None)
        assert item_id > 0


def test_105_both_set_is_fine(env, dsn: str, full_dir: pathlib.Path) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        item_id = _insert_item(
            conn, stimulus_group_id="abc123groupid", stimulus_group_ordinal=1
        )
        assert item_id > 0


def test_105_group_id_without_ordinal_rejected(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, stimulus_group_id="abc123groupid", stimulus_group_ordinal=None)


def test_105_ordinal_without_group_id_rejected(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, stimulus_group_id=None, stimulus_group_ordinal=1)


def test_105_ordinal_must_be_positive(env, dsn: str, full_dir: pathlib.Path) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, stimulus_group_id="group-x", stimulus_group_ordinal=0)
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, stimulus_group_id="group-y", stimulus_group_ordinal=-1)
        # 1, 2, 3 are all fine.
        for n in (1, 2, 3):
            item_id = _insert_item(
                conn, stimulus_group_id=f"group-pos-{n}", stimulus_group_ordinal=n
            )
            assert item_id > 0


def test_105_group_id_length_bound(env, dsn: str, full_dir: pathlib.Path) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, stimulus_group_id="", stimulus_group_ordinal=1)
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, stimulus_group_id="x" * 65, stimulus_group_ordinal=1)
        # 64 chars exactly is fine.
        item_id = _insert_item(
            conn, stimulus_group_id="x" * 64, stimulus_group_ordinal=1
        )
        assert item_id > 0


def test_105_multiple_rows_can_share_one_group_ordered_by_ordinal(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    """The whole point: several rows carry the SAME group id, distinct
    ordinals, and can be fetched back in group order."""
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        gid = "shared-group-1"
        id1 = _insert_item(conn, stimulus_group_id=gid, stimulus_group_ordinal=1)
        id2 = _insert_item(conn, stimulus_group_id=gid, stimulus_group_ordinal=2)
        id3 = _insert_item(conn, stimulus_group_id=gid, stimulus_group_ordinal=3)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT id, stimulus_group_ordinal FROM generated_items "
                "WHERE stimulus_group_id = %s ORDER BY stimulus_group_ordinal",
                (gid,),
            )
            rows = cur.fetchall()
            assert [r[0] for r in rows] == [id1, id2, id3]
            assert [r[1] for r in rows] == [1, 2, 3]


# ---------------------------------------------------------------------------
# 4. DOWN — destructive gate; columns/index gone; re-up clean.
# ---------------------------------------------------------------------------


def test_105_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    target = _pre_target(full_dir, MIGRATION_NUM)

    with psycopg.connect(dsn, autocommit=True) as conn:
        _insert_item(conn, stimulus_group_id="down-group", stimulus_group_ordinal=1)

    # Refused without the flag (destructive marker on the down file).
    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", target, "down"])
    assert rc != 0, "105.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", target, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {target} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                SELECT column_name FROM information_schema.columns
                 WHERE table_name = 'generated_items'
                   AND column_name IN ('stimulus_group_id', 'stimulus_group_ordinal')
                """
            )
            assert cur.fetchall() == []
            cur.execute(
                "SELECT indexname FROM pg_indexes "
                "WHERE tablename = 'generated_items' "
                "AND indexname = 'ix_generated_items_stimulus_group'"
            )
            assert cur.fetchone() is None

    # Re-up rebuilds everything cleanly.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                SELECT count(*) FROM information_schema.columns
                 WHERE table_name = 'generated_items' AND column_name = 'stimulus_group_id'
                """
            )
            assert cur.fetchone()[0] == 1
