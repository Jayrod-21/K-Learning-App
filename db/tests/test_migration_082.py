"""Migration 082 (TOPIK 83rd I 읽기 Q42 stem fix, B-031) — real-chain tests.

WHY THIS FILE EXISTS:
    082 is a one-row, content-addressed data fix: the 83rd TOPIK I reading
    item 42 stem gains the photo description its ingest transcription
    dropped (the SNS post's photo shows 수미 at '제주공항' — the fact that
    makes option ① true under the "맞지 않는 것" task). The load-bearing
    behaviors are the guard semantics: ONLY the exact glitched row is
    rewritten, everything else — including near-miss rows and already-fixed
    rows — is untouched, and the change round-trips exactly through down.

SCOPE:
    - markers: up AND down both `-- migrate: non-destructive` (a guarded
      single-row UPDATE each way — no drops, no mass deletes).
    - up on an EMPTY corpus: applies cleanly as a no-op (fresh DBs and the
      server test harness apply every migration against empty tables).
    - up on a seeded corpus: the glitched row's stem is rewritten to the
      photo-context text; options/answer untouched; a control row with the
      same option-① text but a different stem is untouched.
    - idempotency: re-running the up body is a no-op (0 rows match).
    - down: restores the original stem on the same guard; re-up round-trips.

DETERMINISM:
    Mirrors test_migration_081.py — real migration files copied into a
    tmp_path dir, runner pointed via --migrations-dir, fresh schema per test.
"""

from __future__ import annotations

import json
import pathlib

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

# The migration immediately before 082 — `up --target PRE_082` stops there so
# tests can seed the glitched row BEFORE 082 runs against it.
PRE_082 = "081"

OLD_STEM = (
    "[SNS 게시물 — 수미: 저는 지금 제주도예요. 여기 날씨가 정말 좋아요. / "
    "민희: 와! 저도 가고 싶어요. / 수미: 네. 우리 다음에 같이 와요.♥]"
)
NEW_STEM = (
    "[SNS 게시물 — 사진: 수미가 '제주공항' 표지판 앞에서 찍은 사진 / "
    "수미: 저는 지금 제주도예요. 여기 날씨가 정말 좋아요. / "
    "민희: 와! 저도 가고 싶어요. / 수미: 네. 우리 다음에 같이 와요.♥]"
)
OPTIONS = [
    "수미 씨는 공항에 왔습니다.",
    "수미 씨는 제주도에 있습니다.",
    "지금 제주도는 날씨가 좋습니다.",
    "민희 씨는 수미 씨와 같이 있습니다.",
]


def _up(full_dir: pathlib.Path, target: str | None = None) -> None:
    args = ["--migrations-dir", str(full_dir), "--allow-destructive"]
    if target is not None:
        args += ["--target", target]
    rc = migrate.main(args + ["up"])
    assert rc == 0, f"up (target={target}) returned {rc}"


def _down_to(full_dir: pathlib.Path, target: str) -> None:
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--allow-destructive",
         "--target", target, "down"]
    )
    assert rc == 0, f"down --target {target} returned {rc}"


# ---------------------------------------------------------------------------
# Seed helpers — raw SQL, no app layer involved
# ---------------------------------------------------------------------------

def _seed_item(conn: psycopg.Connection, stem: str, item_number: int) -> int:
    """A corpus_sources + topik_tests parent chain and one topik_items row
    carrying the given stem and the real Q42 options/answer."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO corpus_sources (corpus, title, source_path)
            VALUES ('topik', '테스트 소스', '/test/topik')
            ON CONFLICT (corpus) DO NOTHING
            """
        )
        cur.execute("SELECT id FROM corpus_sources WHERE corpus = 'topik' LIMIT 1")
        source_id = cur.fetchone()[0]
        cur.execute(
            """
            INSERT INTO topik_tests
                    (corpus_source_id, test_number, topik_level, section)
            VALUES (%s, 83, 'TOPIK I', 'reading'::topik_section)
            ON CONFLICT (test_number, topik_level, section) DO UPDATE
                SET updated_at = now()
            RETURNING id
            """,
            (source_id,),
        )
        test_id = cur.fetchone()[0]
        cur.execute(
            """
            INSERT INTO topik_items
                    (topik_test_id, corpus_source_id, source_id, item_number,
                     section, item_type, stem, options, answer)
            VALUES (%s, %s, %s, %s, 'reading'::topik_section,
                    'multiple_choice'::topik_item_type, %s, %s::jsonb, '4'::jsonb)
            RETURNING id
            """,
            (
                test_id,
                source_id,
                f"topik83-I-read-{item_number:03d}",
                item_number,
                stem,
                json.dumps(OPTIONS, ensure_ascii=False),
            ),
        )
        return cur.fetchone()[0]


def _stem_of(conn: psycopg.Connection, item_id: int) -> str:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute("SELECT stem FROM topik_items WHERE id = %s", (item_id,))
        return cur.fetchone()[0]


def _apply_082_body(conn: psycopg.Connection, full_dir: pathlib.Path) -> None:
    """Re-run the up body raw (idempotency probe — the runner itself refuses
    to re-apply an already-recorded version)."""
    sql = (full_dir / "082_fix_topik_222_stem.up.sql").read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_markers_both_non_destructive() -> None:
    up = (REAL_MIGRATIONS_DIR / "082_fix_topik_222_stem.up.sql").read_text(
        encoding="utf-8"
    )
    down = (REAL_MIGRATIONS_DIR / "082_fix_topik_222_stem.down.sql").read_text(
        encoding="utf-8"
    )
    assert "-- migrate: non-destructive" in up
    assert "-- migrate: destructive" not in up.replace("non-destructive", "")
    assert "-- migrate: non-destructive" in down


def test_up_on_empty_corpus_is_clean_noop(env, dsn, full_dir) -> None:
    _up(full_dir)  # full chain incl. 082 against empty tables
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM topik_items")
            assert cur.fetchone()[0] == 0


def test_up_rewrites_only_the_glitched_row(env, dsn, full_dir) -> None:
    _up(full_dir, target=PRE_082)
    with psycopg.connect(dsn, autocommit=True) as conn:
        glitched = _seed_item(conn, OLD_STEM, item_number=42)
        # Control: same options (incl. option ①) but a DIFFERENT stem — the
        # content-addressed guard must not touch it.
        control = _seed_item(conn, "[다른 지문]", item_number=43)
    _up(full_dir)  # applies 082
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _stem_of(conn, glitched) == NEW_STEM
        assert _stem_of(conn, control) == "[다른 지문]"
        # Options and answer untouched.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT options->>0, answer FROM topik_items WHERE id = %s",
                (glitched,),
            )
            opt0, answer = cur.fetchone()
            assert opt0 == OPTIONS[0]
            assert answer == 4


def test_up_body_is_idempotent(env, dsn, full_dir) -> None:
    _up(full_dir, target=PRE_082)
    with psycopg.connect(dsn, autocommit=True) as conn:
        glitched = _seed_item(conn, OLD_STEM, item_number=42)
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _stem_of(conn, glitched) == NEW_STEM
        # Raw re-apply of the body: 0 rows match the guard now — no change,
        # no error.
        _apply_082_body(conn, full_dir)
        assert _stem_of(conn, glitched) == NEW_STEM


def test_down_round_trips(env, dsn, full_dir) -> None:
    _up(full_dir, target=PRE_082)
    with psycopg.connect(dsn, autocommit=True) as conn:
        glitched = _seed_item(conn, OLD_STEM, item_number=42)
    _up(full_dir)
    _down_to(full_dir, PRE_082)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _stem_of(conn, glitched) == OLD_STEM
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _stem_of(conn, glitched) == NEW_STEM
