"""Migration 103 (generated_items audio columns, F-220 slice 3 — generated
LISTENING items) — real-chain tests.

WHY THIS FILE EXISTS:
    103 extends `generated_items` (101) with the columns the LISTENING slice
    needs: a transient `turns` dialogue script, a per-item ElevenLabs spend
    ledger (`audio_cost_estimate_usd` / `audio_synthesized_at`), and a REAL
    foreign key from `audio_source_id` into `audio_sources(id)` (101 left
    that column unconstrained). It also widens `audio_sources.kind`'s CHECK
    to admit `'generated_listening'` — the kind the METERED
    `synthesize-listening-audio` CLI stamps on the shared blob it creates per
    item. Proven here against a real Postgres-16 testcontainer via
    ``migrate.main()``.

SCOPE:
    - markers: up is non-destructive, down destructive (F-088 classification).
    - up: applies on the full real chain; re-driving the body is a no-op
      (IF NOT EXISTS / DO-guarded everywhere).
    - constraints: turns array-ness, audio_cost_estimate_usd nonneg, the
      audio_source_id FK (a bogus id is rejected; a real audio_sources id is
      accepted; deleting the referenced audio_sources row SETs NULL, never
      blocks the delete), the widened audio_sources.kind CHECK admits
      'generated_listening' (positive) while still rejecting a bogus kind
      (negative).
    - down: refused without --allow-destructive; with it, the columns/FK are
      gone, the kind CHECK narrows back to 081's 4-value set, and any
      'generated_listening' audio_sources rows are removed so the narrowed
      CHECK validates; re-up is clean.

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
from db.tests._helpers import FAKE_HASH, _seed_user  # type: ignore[import-not-found]

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

MIGRATION_NUM = "103"


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

GOOD_TURNS = [
    {"speaker": "narrator", "gender": "narrator", "text": "두 사람이 카페에서 이야기합니다."},
    {"speaker": "민수", "gender": "male", "text": "오늘 날씨가 참 좋네요."},
]


def _insert_listening_item(
    conn: psycopg.Connection,
    *,
    turns: list | None = GOOD_TURNS,
    audio_source_id: int | None = None,
    audio_cost_estimate_usd: str | None = None,
    audio_synthesized_at_now: bool = False,
    prompt_hash: str | None = None,
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            f"""
            INSERT INTO generated_items
                (section, level, kind, stem, choices, answer_index, status,
                 created_by, prompt_hash, turns, audio_source_id,
                 audio_cost_estimate_usd, audio_synthesized_at)
            VALUES ('listening', 'L2', 'audio-mc', 'stem', %s::jsonb, 0,
                    'draft', 'claude-batch', %s, %s::jsonb, %s, %s,
                    {"now()" if audio_synthesized_at_now else "NULL"})
            RETURNING id
            """,
            (
                psycopg.types.json.Json(GOOD_CHOICES),
                prompt_hash if prompt_hash is not None else _hash(f"listening:{turns}:{audio_source_id}"),
                psycopg.types.json.Json(turns) if turns is not None else None,
                audio_source_id,
                audio_cost_estimate_usd,
            ),
        )
        return cur.fetchone()[0]


def _insert_audio_source(
    conn: psycopg.Connection, user_id: int, *, kind: str = "generated_listening", slug: str = "gen-listen-1"
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO audio_sources (user_id, slug, title, kind, status, is_shared)
            VALUES (%s, %s, 'mock listening item', %s, 'ready', true)
            RETURNING id
            """,
            (user_id, slug, kind),
        )
        return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# 1. F-088 marker classification.
# ---------------------------------------------------------------------------


def test_103_marker_classification() -> None:
    up_sql = (REAL_MIGRATIONS_DIR / "103_generated_items_audio.up.sql").read_text(
        encoding="utf-8"
    )
    down_sql = (REAL_MIGRATIONS_DIR / "103_generated_items_audio.down.sql").read_text(
        encoding="utf-8"
    )
    assert migrate.explicit_destructiveness(up_sql) is False
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — new columns exist; re-driving the body is a no-op.
# ---------------------------------------------------------------------------


def test_103_up_adds_columns_and_reapply_is_idempotent(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)

    up_sql = (REAL_MIGRATIONS_DIR / "103_generated_items_audio.up.sql").read_text(
        encoding="utf-8"
    )
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(up_sql)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                SELECT column_name, is_nullable, data_type
                  FROM information_schema.columns
                 WHERE table_name = 'generated_items'
                   AND column_name IN ('turns', 'audio_cost_estimate_usd', 'audio_synthesized_at')
                 ORDER BY column_name
                """
            )
            rows = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
            assert rows["turns"] == ("YES", "jsonb")
            assert rows["audio_cost_estimate_usd"] == ("YES", "numeric")
            assert rows["audio_synthesized_at"] == ("YES", "timestamp with time zone")

            # FK exists.
            cur.execute(
                "SELECT conname FROM pg_constraint "
                "WHERE conname = 'fk_generated_items_audio_source' "
                "AND conrelid = 'generated_items'::regclass"
            )
            assert cur.fetchone() is not None


# ---------------------------------------------------------------------------
# 3. Constraints.
# ---------------------------------------------------------------------------


def test_103_turns_must_be_array_or_null(env, dsn: str, full_dir: pathlib.Path) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        # NULL turns (vocab/grammar/reading rows, and an unauthored listening
        # row) is fine.
        _insert_listening_item(conn, turns=None, prompt_hash=_hash("null-turns"))
        # A real array is fine.
        _insert_listening_item(conn, turns=GOOD_TURNS, prompt_hash=_hash("array-turns"))
        # A non-array JSON value violates ck_generated_items_turns_array.
        with pytest.raises(errors.CheckViolation):
            with conn.cursor(row_factory=tuple_row) as cur:
                cur.execute(
                    """
                    INSERT INTO generated_items
                        (section, level, kind, stem, choices, answer_index, status,
                         created_by, prompt_hash, turns)
                    VALUES ('listening', 'L2', 'audio-mc', 'stem', %s::jsonb, 0,
                            'draft', 'claude-batch', %s, %s::jsonb)
                    """,
                    (
                        psycopg.types.json.Json(GOOD_CHOICES),
                        _hash("not-array-turns"),
                        psycopg.types.json.Json({"speaker": "not-an-array"}),
                    ),
                )


def test_103_audio_cost_nonneg(env, dsn: str, full_dir: pathlib.Path) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        item_id = _insert_listening_item(conn, prompt_hash=_hash("cost-item"))
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE generated_items SET audio_cost_estimate_usd = -0.01 WHERE id = %s",
                    (item_id,),
                )
        # 0 and a positive value are both legal.
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE generated_items SET audio_cost_estimate_usd = 0.045000 WHERE id = %s",
                (item_id,),
            )
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT audio_cost_estimate_usd FROM generated_items WHERE id = %s", (item_id,)
            )
            assert str(cur.fetchone()[0]) == "0.045000"


def test_103_audio_source_fk_rejects_bogus_id_and_accepts_real_row(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        # A bogus audio_source_id is rejected by the FK.
        with pytest.raises(errors.ForeignKeyViolation):
            _insert_listening_item(
                conn, audio_source_id=999_999_999, prompt_hash=_hash("bogus-fk")
            )

        # A real audio_sources row (kind = 'generated_listening', the widened
        # CHECK — §4 below) is accepted.
        user_id = _seed_user(conn, "listening-fk@test.dev")
        source_id = _insert_audio_source(conn, user_id)
        item_id = _insert_listening_item(
            conn,
            audio_source_id=source_id,
            audio_cost_estimate_usd="0.012000",
            audio_synthesized_at_now=True,
            prompt_hash=_hash("real-fk"),
        )
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT audio_source_id, audio_cost_estimate_usd, audio_synthesized_at IS NOT NULL "
                "FROM generated_items WHERE id = %s",
                (item_id,),
            )
            row = cur.fetchone()
            assert row[0] == source_id
            assert str(row[1]) == "0.012000"
            assert row[2] is True


def test_103_audio_source_fk_set_null_on_delete(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    """ON DELETE SET NULL — deleting the referenced audio_sources row must
    NOT be blocked (audio can be regenerated), and the item degrades to
    un-servable, not corrupt (see the up migration's header)."""
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "listening-setnull@test.dev")
        source_id = _insert_audio_source(conn, user_id, slug="gen-listen-setnull")
        item_id = _insert_listening_item(
            conn, audio_source_id=source_id, prompt_hash=_hash("set-null-item")
        )
        with conn.cursor() as cur:
            cur.execute("DELETE FROM audio_sources WHERE id = %s", (source_id,))
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT audio_source_id FROM generated_items WHERE id = %s", (item_id,)
            )
            assert cur.fetchone()[0] is None


def test_103_audio_sources_kind_admits_generated_listening_rejects_bogus(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "listening-kind@test.dev")
        # Positive: the new kind is accepted.
        _insert_audio_source(conn, user_id, kind="generated_listening", slug="kind-ok")
        # A pre-existing 081 kind is still accepted (superset widen) —
        # 'standalone_listening' carries no additional link CHECK, unlike
        # 'generated_story' (which requires a non-NULL generated_story_id).
        _insert_audio_source(conn, user_id, kind="standalone_listening", slug="kind-standalone")
        # Negative: a bogus kind is still rejected.
        with pytest.raises(errors.CheckViolation):
            _insert_audio_source(conn, user_id, kind="bogus-kind", slug="kind-bad")


# ---------------------------------------------------------------------------
# 4. DOWN — destructive gate; columns/FK gone; kind CHECK narrows back;
#    'generated_listening' rows removed; re-up clean.
# ---------------------------------------------------------------------------


def test_103_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    target = _pre_target(full_dir, MIGRATION_NUM)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "listening-down@test.dev")
        source_id = _insert_audio_source(conn, user_id, slug="kind-down")
        _insert_listening_item(conn, audio_source_id=source_id, prompt_hash=_hash("down-item"))

    # Refused without the flag (destructive marker on the down file).
    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", target, "down"])
    assert rc != 0, "103.down is destructive — the gate must refuse it without the flag"

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
                   AND column_name IN ('turns', 'audio_cost_estimate_usd', 'audio_synthesized_at')
                """
            )
            assert cur.fetchall() == []
            cur.execute(
                "SELECT conname FROM pg_constraint "
                "WHERE conname = 'fk_generated_items_audio_source' "
                "AND conrelid = 'generated_items'::regclass"
            )
            assert cur.fetchone() is None
            # The 'generated_listening' audio_sources row was removed.
            cur.execute("SELECT count(*) FROM audio_sources WHERE kind = 'generated_listening'")
            assert cur.fetchone()[0] == 0
            # The narrowed CHECK rejects 'generated_listening' again.
            with pytest.raises(errors.CheckViolation):
                cur.execute(
                    """
                    INSERT INTO audio_sources (user_id, slug, title, kind, status)
                    VALUES (
                        (SELECT id FROM users LIMIT 1), 'post-down-kind', 'x',
                        'generated_listening', 'ready'
                    )
                    """
                )

    # Round trip: re-up rebuilds everything cleanly.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                SELECT count(*) FROM information_schema.columns
                 WHERE table_name = 'generated_items' AND column_name = 'turns'
                """
            )
            assert cur.fetchone()[0] == 1
