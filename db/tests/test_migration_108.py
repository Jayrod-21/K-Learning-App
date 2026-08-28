"""Migration 108 (generated_writing_items, F-220 P4 — writing-item bank)
— real-chain tests.

WHY THIS FILE EXISTS:
    108 is the app-owned bank table behind F-220's generated, copyright-clean
    TOPIK II WRITING items (server/src/scripts/generate-item-bank.ts's
    --section=writing --ingest mode writes here; server/src/services/
    diagnostic/generatedBank.ts's pickGeneratedWritingItem reads here). It is
    a SEPARATE table from generated_items (migration 101) — writing items are
    constructed-response (no choices/answer_index) — so this file mirrors
    test_migration_101.py's structure exactly, but for the writing-shaped
    columns (prompt/stimulus/rubric/model_answer/min_words/max_words)
    instead of choices/answer_index. The constraints below are what keeps a
    malformed row (wrong level, a non-object rubric, an inverted word-count
    band, a bad status/prompt_hash) from EVER landing — the ingest CLI's Zod
    validation is the primary guard, but these CHECKs are defense-in-depth
    against any future second writer, proven here against a real
    Postgres-16 testcontainer via ``migrate.main()``.

SCOPE:
    - markers: up is non-destructive, down destructive (F-088 classification).
    - up: applies on the full real chain; re-driving the body is a no-op
      (IF NOT EXISTS everywhere).
    - constraints: section/level/status closed sets, rubric object-ness +
      criteria-array presence, prompt/stimulus/model_answer length bounds,
      min_words/max_words
      positivity + ordering, prompt_hash shape, UNIQUE(prompt_hash)
      (positive AND negative probe — the idempotency key).
    - down: refused without --allow-destructive; with it, the table is gone;
      re-up is clean.

DETERMINISM:
    Mirrors test_migration_101.py — the real migration files are copied into
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

MIGRATION_NUM = "108"


def _pre_108_target(full_dir: pathlib.Path) -> str:
    """The version immediately before 108 in the chain actually present
    (numbering may have gaps while sibling branches are in flight)."""
    versions = sorted(
        {f.name[:3] for f in full_dir.iterdir() if f.suffix == ".sql"}
    )
    idx = versions.index(MIGRATION_NUM)
    assert idx > 0, "108 cannot be the first migration"
    return versions[idx - 1]


def _up(directory: pathlib.Path) -> None:
    rc = migrate.main(["--migrations-dir", str(directory), "--allow-destructive", "up"])
    assert rc == 0, f"up returned {rc}"


def _hash(seed: str) -> str:
    """A syntactically valid 64-hex-char prompt_hash (mirrors the CLI's
    hashCacheKey shape — SHA-256 hex digest)."""
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()


GOOD_RUBRIC = {
    "kind": "essay",
    "maxScore": 50,
    "criteria": [
        {"name": "content", "maxScore": 20, "descriptor": "addresses the prompt fully"},
        {"name": "organization", "maxScore": 20, "descriptor": "clear structure"},
        {"name": "languageUse", "maxScore": 10, "descriptor": "accurate grammar/vocab"},
    ],
}


def _insert_item(
    conn: psycopg.Connection,
    *,
    level: str = "L4",
    kind: str = "essay",
    prompt: str = "다음 주제에 대해 600~700자로 자신의 의견을 쓰십시오.",
    stimulus: str | None = None,
    rubric: dict | None = None,
    model_answer: str | None = None,
    min_words: int | None = 600,
    max_words: int | None = 700,
    status: str = "draft",
    created_by: str = "claude-batch",
    prompt_hash: str | None = None,
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO generated_writing_items
                (level, kind, prompt, stimulus, rubric, model_answer,
                 min_words, max_words, status, created_by, prompt_hash)
            VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                level,
                kind,
                prompt,
                stimulus,
                psycopg.types.json.Json(rubric if rubric is not None else GOOD_RUBRIC),
                model_answer,
                min_words,
                max_words,
                status,
                created_by,
                prompt_hash if prompt_hash is not None else _hash(f"{level}:{kind}:{prompt}"),
            ),
        )
        return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# 1. F-088 marker classification.
# ---------------------------------------------------------------------------


def test_108_marker_classification() -> None:
    up_sql = (REAL_MIGRATIONS_DIR / "108_generated_writing_items.up.sql").read_text(
        encoding="utf-8"
    )
    down_sql = (REAL_MIGRATIONS_DIR / "108_generated_writing_items.down.sql").read_text(
        encoding="utf-8"
    )
    assert migrate.explicit_destructiveness(up_sql) is False
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — applies on the real chain; re-driving the body is a no-op.
# ---------------------------------------------------------------------------


def test_108_up_applies_and_reapply_is_idempotent(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)

    up_sql = (REAL_MIGRATIONS_DIR / "108_generated_writing_items.up.sql").read_text(
        encoding="utf-8"
    )
    with psycopg.connect(dsn, autocommit=True) as conn:
        # Drive the body a second time directly (the runner skips an applied
        # version): CREATE TABLE IF NOT EXISTS must be re-runnable.
        with conn.cursor() as cur:
            cur.execute(up_sql)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM generated_writing_items")
            assert cur.fetchone()[0] == 0
            cur.execute(
                """
                SELECT column_name, is_nullable
                  FROM information_schema.columns
                 WHERE table_name = 'generated_writing_items'
                 ORDER BY column_name
                """
            )
            cols = {row[0]: row[1] for row in cur.fetchall()}
            assert cols == {
                "id": "NO",
                "section": "NO",
                "level": "NO",
                "kind": "NO",
                "prompt": "NO",
                "stimulus": "YES",
                "rubric": "NO",
                "model_answer": "YES",
                "min_words": "YES",
                "max_words": "YES",
                "status": "NO",
                "created_by": "NO",
                "model_id": "YES",
                "source_ref": "YES",
                "prompt_hash": "NO",
                "created_at": "NO",
                "updated_at": "NO",
                "version": "NO",
            }
            # No user_id — app-owned shared reference content (mirrors 101).
            assert "user_id" not in cols
            # Draw-path index exists.
            cur.execute(
                "SELECT indexname FROM pg_indexes "
                "WHERE tablename = 'generated_writing_items' AND indexname = 'ix_generated_writing_items_draw'"
            )
            assert cur.fetchone() is not None
            # UNIQUE(prompt_hash) exists.
            cur.execute(
                "SELECT conname FROM pg_constraint "
                "WHERE conname = 'uq_generated_writing_items_prompt_hash'"
            )
            assert cur.fetchone() is not None


# ---------------------------------------------------------------------------
# 3. Constraints — each guard proven by the write it rejects.
# ---------------------------------------------------------------------------


def test_108_positive_insert_and_defaults(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        item_id = _insert_item(conn)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT section, status, stimulus, model_answer, model_id, source_ref "
                "FROM generated_writing_items WHERE id = %s",
                (item_id,),
            )
            row = cur.fetchone()
            assert row[0] == "writing"  # default
            assert row[1] == "draft"  # default
            assert row[2] is None
            assert row[3] is None
            assert row[4] is None
            assert row[5] is None


def test_108_section_level_status_closed_sets(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        # ck_generated_writing_items_section — the column defaults to
        # 'writing'; an explicit bogus value is still rejected.
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO generated_writing_items
                        (section, level, kind, prompt, rubric, min_words, max_words,
                         created_by, prompt_hash)
                    VALUES ('reading', 'L4', 'essay', 'p', %s::jsonb, 600, 700,
                            'claude-batch', %s)
                    """,
                    (psycopg.types.json.Json(GOOD_RUBRIC), _hash("bad-section")),
                )

        # ck_generated_writing_items_level — TOPIK II only.
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, level="L1", prompt_hash=_hash("bad-level-l1"))
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, level="L9", prompt_hash=_hash("bad-level-l9"))
        for level in ("L3", "L4", "L5+"):
            _insert_item(conn, level=level, prompt_hash=_hash(f"level-{level}"))

        # ck_generated_writing_items_status
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, status="pending-review", prompt_hash=_hash("bad-status"))
        for status in ("draft", "approved", "rejected"):
            _insert_item(conn, status=status, prompt_hash=_hash(f"status-{status}"))


def test_108_kind_is_open_text_with_length_check(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        # Any of the 3 known kinds — and, since `kind` is deliberately open
        # TEXT (mirrors generated_items.kind), an as-yet-unused kind string
        # too, as long as it respects the length CHECK.
        for kind in ("short-answer-blanks", "chart-description", "essay", "future-kind"):
            _insert_item(conn, kind=kind, prompt_hash=_hash(f"kind-{kind}"))
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, kind="", prompt_hash=_hash("empty-kind"))
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, kind="x" * 51, prompt_hash=_hash("too-long-kind"))


def test_108_prompt_stimulus_model_answer_length_bounds(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        # prompt: NOT NULL, 1..1000.
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, prompt="", prompt_hash=_hash("empty-prompt"))
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, prompt="x" * 1001, prompt_hash=_hash("too-long-prompt"))

        # stimulus: NULL is fine (essay's shape); an empty string is not.
        _insert_item(conn, stimulus=None, prompt_hash=_hash("null-stimulus"))
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, stimulus="", prompt_hash=_hash("empty-stimulus"))
        _insert_item(
            conn,
            kind="chart-description",
            stimulus="설문조사 결과: 2020년 40%, 2021년 55%, 2022년 68% (가상 통계)",
            min_words=200,
            max_words=300,
            prompt_hash=_hash("good-stimulus"),
        )

        # model_answer: NULL is fine; an empty string is not.
        _insert_item(conn, model_answer=None, prompt_hash=_hash("null-model-answer"))
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, model_answer="", prompt_hash=_hash("empty-model-answer"))
        _insert_item(
            conn,
            kind="short-answer-blanks",
            stimulus="안녕하세요. ( ㉠ ) 내일 회의는 오후 3시로 변경되었습니다. ( ㉡ ).",
            model_answer="㉠: 알려 드립니다 / ㉡: 참고 부탁드립니다",
            min_words=None,
            max_words=None,
            prompt_hash=_hash("good-model-answer"),
        )


def test_108_rubric_must_be_jsonb_object(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, rubric=["not", "an", "object"], prompt_hash=_hash("array-rubric"))
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO generated_writing_items
                        (level, kind, prompt, rubric, min_words, max_words,
                         created_by, prompt_hash)
                    VALUES ('L4', 'essay', 'p', '"just a string"'::jsonb, 600, 700,
                            'claude-batch', %s)
                    """,
                    (_hash("string-rubric"),),
                )
        # An object rubric with no `criteria` key at all — e.g. an empty
        # `{}` — is also rejected: ck_generated_writing_items_rubric_object
        # requires jsonb_typeof(rubric->'criteria') = 'array', not merely
        # jsonb_typeof(rubric) = 'object'.
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, rubric={}, prompt_hash=_hash("empty-object-rubric"))
        with pytest.raises(errors.CheckViolation):
            _insert_item(
                conn,
                rubric={"kind": "essay", "maxScore": 50},
                prompt_hash=_hash("no-criteria-key-rubric"),
            )
        # A `criteria` key present but not an array (e.g. a string) is
        # rejected too.
        with pytest.raises(errors.CheckViolation):
            _insert_item(
                conn,
                rubric={"kind": "essay", "maxScore": 50, "criteria": "not-an-array"},
                prompt_hash=_hash("string-criteria-rubric"),
            )
        # A well-formed object rubric with a criteria array passes.
        _insert_item(conn, prompt_hash=_hash("good-rubric"))


def test_108_word_count_positivity_and_ordering(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        # Both NULL — fine (short-answer-blanks' shape).
        _insert_item(conn, min_words=None, max_words=None, prompt_hash=_hash("both-null-words"))

        # min_words must be positive.
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, min_words=0, max_words=700, prompt_hash=_hash("zero-min-words"))
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, min_words=-1, max_words=700, prompt_hash=_hash("neg-min-words"))
        # max_words must be positive.
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, min_words=600, max_words=0, prompt_hash=_hash("zero-max-words"))

        # max_words must be >= min_words once both are set.
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, min_words=700, max_words=600, prompt_hash=_hash("inverted-words"))
        # Equal bounds are allowed (>=, not strict >).
        _insert_item(conn, min_words=300, max_words=300, prompt_hash=_hash("equal-words"))
        # A well-formed band passes.
        _insert_item(conn, min_words=200, max_words=300, prompt_hash=_hash("good-words"))


def test_108_prompt_hash_shape_and_uniqueness(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        # ck_generated_writing_items_prompt_hash_shape — must be 64 lowercase
        # hex chars.
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, prompt_hash="not-a-hash")
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, prompt_hash="A" * 64)  # uppercase rejected
        with pytest.raises(errors.CheckViolation):
            _insert_item(conn, prompt_hash="0" * 63)  # too short

        # uq_generated_writing_items_prompt_hash — the idempotency key.
        # Negative probe: a second row at the SAME hash is rejected (this is
        # exactly what makes the CLI's ON CONFLICT (prompt_hash) DO NOTHING
        # safe).
        shared_hash = _hash("shared-idempotency-key")
        _insert_item(conn, prompt_hash=shared_hash)
        with pytest.raises(errors.UniqueViolation):
            _insert_item(conn, prompt_hash=shared_hash, prompt="a completely different prompt")


# ---------------------------------------------------------------------------
# 4. DOWN — destructive gate; table gone; re-up clean.
# ---------------------------------------------------------------------------


def test_108_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    target = _pre_108_target(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        _insert_item(conn)

    # Refused without the flag (DROP TABLE + explicit destructive marker).
    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", target, "down"])
    assert rc != 0, "108.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", target, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {target} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT to_regclass('public.generated_writing_items')")
            assert cur.fetchone()[0] is None, "generated_writing_items must be gone after down"

    # Round trip: re-up rebuilds the table cleanly.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM generated_writing_items")
            assert cur.fetchone()[0] == 0
