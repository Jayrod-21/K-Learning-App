"""Migration 067 (writing-prompt content depth, ticket F-096) — real-chain
tests.

WHY THIS FILE EXISTS:
    067 is a pure content seed: 24 additional rubric-tagged TOPIK II writing
    prompts (12 x Q53, 12 x Q54) INSERTed into `writing_prompts`, deepening
    the bank from 3 to 15 active prompts per rubric so the B-027 server-side
    random draw has a real rotation. The server routes (`GET /writing/
    prompts*`, `GET /plan/today`) own their behavioral coverage; this file
    proves the DATABASE-level contract they depend on: the seeded rows'
    shape (active, rubric-tagged, CHECK-conformant), the up's idempotency
    (ON CONFLICT (source_id) DO NOTHING), the down being a true round trip
    (the 24 rows -- and ONLY those 24 -- removed), and the F-088 marker
    classification on both SQL files.

SCOPE:
    - up: +24 rows, all is_active, rubric in (topik_ii_53, topik_ii_54),
      12 per rubric, every text column inside the 013 CHECK ceilings; the
      pre-067 (038) seed rows are untouched. Classifies non-destructive.
    - re-up (apply up twice): no duplicates -- ON CONFLICT keeps it at 15
      active rows per rubric.
    - down: requires --allow-destructive (explicit F-088 marker on a mass
      DELETE the legacy keyword sniff would NOT catch); removes exactly the
      067 rows, restoring the 038 bank (3 active per rubric); the 038 rows
      survive.

DETERMINISM:
    Mirrors test_migration_066.py -- real migration files copied into a
    tmp_path-scoped dir, runner pointed at it via --migrations-dir, fresh
    schema per test.
"""

from __future__ import annotations

import pathlib
import shutil
from typing import Iterable

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

# The migration immediately before 067 in this minimal chain — the down-target
# that rolls back exactly 067 and nothing else. 038 is the migration whose
# seed state (3 active prompts per rubric) the down must restore.
PRE_067 = "038"

# 067's own seed contract (mirrors the up file's header).
SEEDED_PER_RUBRIC = 12
ACTIVE_PER_RUBRIC_AFTER_067 = 15  # 3 (038) + 12 (067)
SEEDED_SOURCE_IDS = [
    f"wp-topik53-{n:02d}" for n in range(4, 16)
] + [f"wp-topik54-{n:02d}" for n in range(4, 16)]


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
def prompts_dir(tmp_path: pathlib.Path) -> pathlib.Path:
    """001 (users, enums, set_updated_at()) + 013 (writing_prompts + its own
    8 legacy seed rows) + 038 (rubric column/CHECK, legacy-row retirement,
    the 6 TOPIK II seed rows, writing_attempts) + 067 (the 24 depth rows).
    056 only widens the writing_attempts CHECK and is not a 067 dependency."""
    d = tmp_path / "migrations_prompt_depth"
    _copy_real_migrations(d, versions={"001", "013", "038", "067"})
    return d


def _active_counts_by_rubric(conn: psycopg.Connection) -> dict[str, int]:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT rubric, count(*) FROM writing_prompts
             WHERE is_active AND rubric IS NOT NULL
             GROUP BY rubric
            """
        )
        return {r[0]: r[1] for r in cur.fetchall()}


# ---------------------------------------------------------------------------
# 1. F-088 marker: 067's up is non-destructive, down is destructive.
# ---------------------------------------------------------------------------

def test_067_marker_classification() -> None:
    up_sql = (REAL_MIGRATIONS_DIR / "067_writing_prompts_depth.up.sql").read_text(
        encoding="utf-8"
    )
    down_sql = (REAL_MIGRATIONS_DIR / "067_writing_prompts_depth.down.sql").read_text(
        encoding="utf-8"
    )
    assert migrate.explicit_destructiveness(up_sql) is False
    assert not migrate.contains_destructive(up_sql)
    # The down is a mass DELETE — no DROP TABLE/TRUNCATE keyword for the
    # legacy sniff, so ONLY the explicit marker classifies it destructive.
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


def test_067_up_applies_without_allow_destructive(
    env, dsn: str, prompts_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(prompts_dir), "up"])
    assert rc == 0, "067 up must not require --allow-destructive (F-088 marker)"


# ---------------------------------------------------------------------------
# 2. Seed shape: 15 active prompts per rubric, all CHECK-conformant, the
#    038 rows untouched; re-up is a no-op (ON CONFLICT idempotency).
# ---------------------------------------------------------------------------

def test_067_seeds_12_per_rubric_on_top_of_the_038_bank(
    env, dsn: str, prompts_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(prompts_dir), "up"])
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        counts = _active_counts_by_rubric(conn)
        assert counts == {
            "topik_ii_53": ACTIVE_PER_RUBRIC_AFTER_067,
            "topik_ii_54": ACTIVE_PER_RUBRIC_AFTER_067,
        }
        with conn.cursor(row_factory=tuple_row) as cur:
            # Every 067 row: present, active, tagged, within the 013 CHECK
            # ceilings (the CHECKs would have refused the INSERT, but assert
            # the seam explicitly so a loosened CHECK can't mask oversized
            # content sneaking in later).
            cur.execute(
                """
                SELECT source_id, is_active, rubric,
                       length(title), length(prompt_kr), length(prompt_en),
                       est_minutes, register, level::text
                  FROM writing_prompts
                 WHERE source_id = ANY(%s)
                 ORDER BY source_id
                """,
                (SEEDED_SOURCE_IDS,),
            )
            rows = cur.fetchall()
            assert len(rows) == SEEDED_PER_RUBRIC * 2
            for (
                source_id,
                is_active,
                rubric,
                title_len,
                kr_len,
                en_len,
                est_minutes,
                register,
                level,
            ) in rows:
                assert is_active, f"{source_id} must seed active"
                expected_rubric = (
                    "topik_ii_53" if source_id.startswith("wp-topik53") else "topik_ii_54"
                )
                assert rubric == expected_rubric
                assert 1 <= title_len <= 200
                assert 1 <= kr_len <= 2000
                assert 1 <= en_len <= 2000
                assert est_minutes == (15 if rubric == "topik_ii_53" else 30)
                assert register == "문어체"
                assert level in ("L3", "L4", "L5+")

            # The 038 rows are untouched (still active, still tagged).
            cur.execute(
                """
                SELECT count(*) FROM writing_prompts
                 WHERE source_id IN ('wp-topik53-01', 'wp-topik54-01')
                   AND is_active AND rubric IS NOT NULL
                """
            )
            assert cur.fetchone()[0] == 2

            # The 013 legacy register-drill rows stay retired (067 must not
            # disturb 038's reconciliation).
            cur.execute(
                "SELECT count(*) FROM writing_prompts WHERE is_active AND rubric IS NULL"
            )
            assert cur.fetchone()[0] == 0


def test_067_reseed_is_idempotent(
    env, dsn: str, prompts_dir: pathlib.Path
) -> None:
    """Re-running the up body must not duplicate the seed (ON CONFLICT
    (source_id) DO NOTHING). The runner skips an applied migration, so drive
    the body directly for the second pass."""
    rc = migrate.main(["--migrations-dir", str(prompts_dir), "up"])
    assert rc == 0

    up_sql = (REAL_MIGRATIONS_DIR / "067_writing_prompts_depth.up.sql").read_text(
        encoding="utf-8"
    )
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(up_sql)
        counts = _active_counts_by_rubric(conn)
        assert counts == {
            "topik_ii_53": ACTIVE_PER_RUBRIC_AFTER_067,
            "topik_ii_54": ACTIVE_PER_RUBRIC_AFTER_067,
        }


# ---------------------------------------------------------------------------
# 3. DOWN — requires --allow-destructive (F-088 marker on a mass DELETE);
#    removes exactly the 24 seed rows, restoring the 038 bank; re-up rebuilds
#    the post-067 state (true round trip).
# ---------------------------------------------------------------------------

def test_067_down_requires_allow_destructive_then_restores_the_038_bank(
    env, dsn: str, prompts_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(prompts_dir), "up"])
    assert rc == 0

    # The gate must refuse without the flag (the down's DELETE FROM carries
    # no DROP/TRUNCATE keyword — only the explicit marker protects it).
    rc = migrate.main(
        ["--migrations-dir", str(prompts_dir), "--target", PRE_067, "down"]
    )
    assert rc != 0, "067.down is marked destructive — the gate must refuse it"

    rc = migrate.main(
        [
            "--migrations-dir",
            str(prompts_dir),
            "--target",
            PRE_067,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_067} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        counts = _active_counts_by_rubric(conn)
        assert counts == {"topik_ii_53": 3, "topik_ii_54": 3}
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT count(*) FROM writing_prompts WHERE source_id = ANY(%s)",
                (SEEDED_SOURCE_IDS,),
            )
            assert cur.fetchone()[0] == 0, "every 067 row must be gone after down"

    # Round trip: re-up rebuilds the exact post-067 pool (the down DELETEd —
    # rather than deactivated — its rows precisely so this works; see the
    # down file's header).
    rc = migrate.main(["--migrations-dir", str(prompts_dir), "up"])
    assert rc == 0
    with psycopg.connect(dsn, autocommit=True) as conn:
        counts = _active_counts_by_rubric(conn)
        assert counts == {
            "topik_ii_53": ACTIVE_PER_RUBRIC_AFTER_067,
            "topik_ii_54": ACTIVE_PER_RUBRIC_AFTER_067,
        }
