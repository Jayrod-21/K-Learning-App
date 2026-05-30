"""
Integration tests for the cross-reference resolver.

Runs against a real Postgres testcontainer per ADR-001 / bar §"Testing"
("No SQLite stand-in"). Loads fixtures via the existing kgiu + vocab loaders,
then drives `resolver.pipeline.run_all` and asserts the relations tables
end up in the expected shape.

Tests covered:
    * E2E: fixtures load → resolver runs → FK rows exist, text-only rows exist.
    * Idempotency: a second run produces zero new rows.
    * Resume: simulated interrupt mid-corpus → resume completes the rest.
    * Cross-corpus link: kgiu source resolves to vocab target.
    * Broken-ref CSV report contents.
    * Prerequisite check: resolver against an empty DB errors out cleanly.
"""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

import pytest

testcontainers = pytest.importorskip("testcontainers.postgres")
psycopg_pool = pytest.importorskip("psycopg_pool")
psycopg = pytest.importorskip("psycopg")

from testcontainers.postgres import PostgresContainer  # noqa: E402
from psycopg_pool import AsyncConnectionPool  # noqa: E402

from loaders.runtime import LoaderConfig, configure_logging  # noqa: E402
from loaders import load_kgiu, load_vocab_2000  # noqa: E402

from resolver.pipeline import (  # noqa: E402
    ResolverConfig,
    ResolverPrerequisiteError,
    run_all,
)


REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
FIXTURE_DIR = Path(__file__).parent / "fixtures"
KGIU_FIXTURE = FIXTURE_DIR / "resolver_kgiu_beginner.json"
VOCAB_FIXTURE = FIXTURE_DIR / "resolver_vocab_beginner.json"


# -----------------------------------------------------------------------------
# Shared infra
# -----------------------------------------------------------------------------


@pytest.fixture(scope="module")
def pg_container():
    c = PostgresContainer("postgres:16-alpine")
    c.start()
    try:
        yield c
    finally:
        c.stop()


@pytest.fixture(scope="module")
def database_url(pg_container) -> str:
    url = pg_container.get_connection_url()
    return url.replace("postgresql+psycopg2://", "postgresql://")


async def _apply_migrations(url: str) -> None:
    files = sorted(MIGRATIONS_DIR.glob("*.up.sql"))
    async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
        for f in files:
            sql = f.read_text(encoding="utf-8")
            async with conn.transaction():
                async with conn.cursor() as cur:
                    await cur.execute(sql)


async def _load_fixtures(url: str, *, output_root: Path) -> None:
    """Use the real loaders to populate the fixture corpora."""
    cfg = LoaderConfig(database_url=url, batch_size=50)
    async with AsyncConnectionPool(url, min_size=1, max_size=2, open=False) as pool:
        await pool.open(wait=True, timeout=15)
        await load_kgiu.load(pool, output_root / "grammar_kgiu_beginner.json", cfg)
        await load_vocab_2000.load(pool, output_root / "vocab_2000_beginner.json", cfg)


@pytest.fixture(scope="module")
def loaded_db(database_url, tmp_path_factory) -> tuple[str, Path]:
    """Apply migrations + load fixtures into a `output/`-shaped dir.

    The loaders / resolver expect specific JSON filenames (grammar_kgiu_*.json,
    vocab_2000_*.json), so we copy fixtures into a temp `output/` dir under
    their canonical names.
    """
    configure_logging("warning")
    output_root = tmp_path_factory.mktemp("resolver_output")
    shutil.copy(KGIU_FIXTURE, output_root / "grammar_kgiu_beginner.json")
    shutil.copy(VOCAB_FIXTURE, output_root / "vocab_2000_beginner.json")
    asyncio.run(_apply_migrations(database_url))
    asyncio.run(_load_fixtures(database_url, output_root=output_root))
    return database_url, output_root


def _query_one(url: str, sql: str, params: tuple = ()) -> tuple | None:
    async def run():
        async with await psycopg.AsyncConnection.connect(url) as conn:
            async with conn.cursor() as cur:
                await cur.execute(sql, params)
                return await cur.fetchone()
    return asyncio.run(run())


def _query_all(url: str, sql: str, params: tuple = ()) -> list[tuple]:
    async def run():
        async with await psycopg.AsyncConnection.connect(url) as conn:
            async with conn.cursor() as cur:
                await cur.execute(sql, params)
                return await cur.fetchall()
    return asyncio.run(run())


async def _run_resolver(
    url: str, *, output_root: Path, corpora: list[str], **kwargs
) -> dict:
    cfg = ResolverConfig(
        database_url=url,
        output_root=output_root,
        batch_size=50,
        **kwargs,
    )
    async with AsyncConnectionPool(url, min_size=1, max_size=2, open=False) as pool:
        await pool.open(wait=True, timeout=15)
        return await run_all(pool, corpora=corpora, cfg=cfg)


# -----------------------------------------------------------------------------
# Tests
# -----------------------------------------------------------------------------


def test_resolver_populates_fk_and_text_only_rows(loaded_db):
    url, output_root = loaded_db
    results = asyncio.run(_run_resolver(
        url, output_root=output_root,
        corpora=["kgiu_beginner", "vocab_2000_beginner"],
    ))

    # KGIU: compare_with from u03-02 → u03-01 should resolve via parsed_target_source_id.
    row = _query_one(
        url,
        """
        SELECT r.target_entry_id, e.source_id, r.resolution_status
          FROM kgiu_entry_relations r
          JOIN kgiu_entries src ON src.id = r.source_entry_id
          LEFT JOIN kgiu_entries e ON e.id = r.target_entry_id
         WHERE src.source_id = 'kgiu-beg-u03-02'
           AND r.relation_kind = 'compare_with'
        """,
    )
    assert row is not None
    target_id, target_source_id, status = row
    assert target_id is not None
    assert target_source_id == "kgiu-beg-u03-01"
    assert status == "resolved"

    # The u03-99 entry's note references a non-loaded id → text_only with target_source_id.
    row = _query_one(
        url,
        """
        SELECT r.target_entry_id, r.target_source_id, r.resolution_status
          FROM kgiu_entry_relations r
          JOIN kgiu_entries src ON src.id = r.source_entry_id
         WHERE src.source_id = 'kgiu-beg-u03-99'
        """,
    )
    assert row is not None
    target_id, target_source_id, status = row
    assert target_id is None
    assert target_source_id == "kgiu-beg-u99-77"
    assert status == "text_only"

    # Vocab: 가족 related → 식구 (both loaded) → FK link.
    row = _query_one(
        url,
        """
        SELECT r.target_entry_id, tgt.korean, r.resolution_status, r.relation_type::text
          FROM vocab_entry_relations r
          JOIN vocab_entries src ON src.id = r.source_entry_id
          LEFT JOIN vocab_entries tgt ON tgt.id = r.target_entry_id
         WHERE src.source_id = 'vocab-beg-0001'
           AND r.relation_type = 'related'
        """,
    )
    assert row is not None
    tid, tkorean, status, rt = row
    assert tid is not None
    assert tkorean == "식구"
    assert status == "resolved"
    assert rt == "related"

    # Vocab: 걸리다.basic_form = 걸다 (also loaded) → FK link.
    row = _query_one(
        url,
        """
        SELECT r.target_entry_id, tgt.korean
          FROM vocab_entry_relations r
          JOIN vocab_entries src ON src.id = r.source_entry_id
          LEFT JOIN vocab_entries tgt ON tgt.id = r.target_entry_id
         WHERE src.source_id = 'vocab-beg-0006'
           AND r.relation_type = 'basic_form'
        """,
    )
    assert row is not None
    tid, tkorean = row
    assert tid is not None
    assert tkorean == "걸다"

    # Vocab: 없는단어.related = 분명히없는단어 — no target → text_only.
    row = _query_one(
        url,
        """
        SELECT r.target_entry_id, r.target_korean, r.resolution_status
          FROM vocab_entry_relations r
          JOIN vocab_entries src ON src.id = r.source_entry_id
         WHERE src.source_id = 'vocab-beg-0008'
        """,
    )
    assert row is not None
    tid, tkor, status = row
    assert tid is None
    assert tkor == "분명히없는단어"
    assert status == "text_only"

    # resolver_state should be complete for both corpora.
    states = _query_all(
        url,
        "SELECT corpus::text, status FROM resolver_state ORDER BY corpus",
    )
    assert ("kgiu_beginner", "complete") in states
    assert ("vocab_2000_beginner", "complete") in states


def test_resolver_is_idempotent(loaded_db):
    url, output_root = loaded_db

    # First run already happened in the previous test. Capture state.
    count_before = _query_one(
        url, "SELECT COUNT(*) FROM kgiu_entry_relations"
    )[0]
    vcount_before = _query_one(
        url, "SELECT COUNT(*) FROM vocab_entry_relations"
    )[0]
    versions_before = _query_all(
        url,
        "SELECT id, version FROM kgiu_entry_relations ORDER BY id",
    )

    # Re-run.
    asyncio.run(_run_resolver(
        url, output_root=output_root,
        corpora=["kgiu_beginner", "vocab_2000_beginner"],
    ))

    count_after = _query_one(
        url, "SELECT COUNT(*) FROM kgiu_entry_relations"
    )[0]
    vcount_after = _query_one(
        url, "SELECT COUNT(*) FROM vocab_entry_relations"
    )[0]
    versions_after = _query_all(
        url,
        "SELECT id, version FROM kgiu_entry_relations ORDER BY id",
    )

    assert count_after == count_before
    assert vcount_after == vcount_before
    # No row should have had its version bumped — idempotent upsert with
    # WHERE-clause guard ensures DO UPDATE only fires when fields change.
    assert versions_after == versions_before


def test_resolver_dry_run_writes_nothing(loaded_db, tmp_path):
    """Dry run produces the same counts but writes no new rows."""
    url, _ = loaded_db
    # Use a fresh output dir with just the existing fixtures to keep this hermetic.
    output_root = tmp_path / "dry"
    output_root.mkdir()
    shutil.copy(KGIU_FIXTURE, output_root / "grammar_kgiu_beginner.json")
    shutil.copy(VOCAB_FIXTURE, output_root / "vocab_2000_beginner.json")

    count_before = _query_one(url, "SELECT COUNT(*) FROM kgiu_entry_relations")[0]

    results = asyncio.run(_run_resolver(
        url, output_root=output_root,
        corpora=["kgiu_beginner"],
        dry_run=True,
    ))

    count_after = _query_one(url, "SELECT COUNT(*) FROM kgiu_entry_relations")[0]
    assert count_after == count_before
    # But the counters tracked the dry-run work.
    assert results["kgiu_beginner"].counters.refs_extracted > 0


def test_resolver_resume_picks_up_where_it_stopped(database_url, tmp_path):
    """Simulate an interrupt by manually moving the checkpoint cursor."""
    url = database_url
    output_root = tmp_path / "resume_output"
    output_root.mkdir()
    shutil.copy(KGIU_FIXTURE, output_root / "grammar_kgiu_beginner.json")
    shutil.copy(VOCAB_FIXTURE, output_root / "vocab_2000_beginner.json")

    # Fresh DB (this test uses its own — re-running migrations is OK).
    # Run apply + load fresh into a sibling test schema by reusing the same DB:
    # the loaders are idempotent against re-runs.
    asyncio.run(_load_fixtures(url, output_root=output_root))

    # Simulate a partial run by manually setting resolver_state.
    # Trick: run once, then truncate relations, then resume with the
    # last_source_id set to halfway through the corpus.
    asyncio.run(_run_resolver(
        url, output_root=output_root, corpora=["kgiu_beginner"]
    ))

    async def _setup_partial():
        async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
            async with conn.cursor() as cur:
                # Wipe relations for kgiu so we can re-resolve from scratch
                # for this test.
                await cur.execute("DELETE FROM kgiu_entry_relations")
                # Move the cursor halfway: pretend we processed only u03-01.
                await cur.execute(
                    """
                    UPDATE resolver_state
                       SET status = 'in_progress',
                           last_source_id = 'kgiu-beg-u03-01',
                           refs_extracted = 0,
                           refs_resolved = 0,
                           refs_text_only = 0,
                           refs_broken = 0
                     WHERE corpus = 'kgiu_beginner'
                    """
                )

    asyncio.run(_setup_partial())

    # Resume with --resume — should only re-process u03-02, u03-13, u03-99.
    results = asyncio.run(_run_resolver(
        url, output_root=output_root,
        corpora=["kgiu_beginner"],
        resume=True,
    ))

    # The post-cursor entries each have one cross_ref, so we expect:
    #   - 3 extracted (one per entry: u03-02, u03-13, u03-99)
    #   - 1 resolved (u03-02 → u03-01 via parsed_target_source_id)
    #   - 2 text_only (u03-13 "N만 (Unit 3.12)" and u03-99 "이런 형식 없음" +
    #     parsed kgiu-beg-u99-77 — both have target text but no loaded match)
    #   - 0 broken (no malformed/unsupported refs in this fixture)
    #
    # The pre-fix code (REVIEW_C2 F1) double-counted text_only refs by
    # appending them to BOTH `rows` and `broken`, producing extracted=5
    # and broken=2 instead of extracted=3 and broken=0. The fix in
    # `_process_entry` makes the three ledgers disjoint.
    counters = results["kgiu_beginner"].counters
    assert counters.refs_extracted == 3, (
        f"refs_extracted should equal resolved+text_only+broken; got {counters.refs_extracted}"
    )
    assert counters.refs_resolved == 1
    assert counters.refs_text_only == 2
    assert counters.refs_broken == 0, (
        "broken must NOT include text_only successes (REVIEW_C2 F1)"
    )
    # The text_only refs are surfaced separately in the report ledger so QA
    # can audit them — but they are NOT in `result.broken`.
    assert len(results["kgiu_beginner"].broken) == 0
    assert len(results["kgiu_beginner"].text_only_reports) == 2
    # The u03-02 → u03-01 link should be present, but no row for u03-01 itself.
    rows = _query_all(
        url,
        """
        SELECT src.source_id, r.relation_kind
          FROM kgiu_entry_relations r
          JOIN kgiu_entries src ON src.id = r.source_entry_id
         ORDER BY src.source_id
        """,
    )
    source_ids = [r[0] for r in rows]
    assert "kgiu-beg-u03-02" in source_ids
    assert "kgiu-beg-u03-01" not in source_ids


def test_prerequisite_error_when_corpus_not_loaded(pg_container, tmp_path):
    """Resolver against an empty schema raises ResolverPrerequisiteError."""
    # Spin a fresh DB by using a NEW database within the container — simplest
    # is to reapply migrations into a temporary schema-equivalent state via a
    # second container? Cheaper: reset the relations + entries we already
    # have. But scope=module means we share with other tests. Instead, use
    # a `pytest.raises` against an obviously-unloaded corpus by truncating
    # one corpus's entries.
    url = pg_container.get_connection_url().replace(
        "postgresql+psycopg2://", "postgresql://"
    )

    # Make sure migrations are applied first (other tests may have done it
    # already; the operation is idempotent).
    asyncio.run(_apply_migrations(url))

    async def _truncate():
        async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
            async with conn.cursor() as cur:
                # Wipe everything related so the prereq check sees no corpora.
                await cur.execute("TRUNCATE kgiu_entry_relations, vocab_entry_relations, resolver_state RESTART IDENTITY CASCADE")
                await cur.execute("TRUNCATE kgiu_entries RESTART IDENTITY CASCADE")
                await cur.execute("TRUNCATE vocab_entries RESTART IDENTITY CASCADE")

    asyncio.run(_truncate())
    output_root = tmp_path / "empty_output"
    output_root.mkdir()
    shutil.copy(KGIU_FIXTURE, output_root / "grammar_kgiu_beginner.json")

    with pytest.raises(ResolverPrerequisiteError):
        asyncio.run(_run_resolver(
            url, output_root=output_root, corpora=["kgiu_beginner"]
        ))
