"""
Integration tests for the KGIU loader.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

testcontainers = pytest.importorskip("testcontainers.postgres")
psycopg_pool = pytest.importorskip("psycopg_pool")
psycopg = pytest.importorskip("psycopg")

from testcontainers.postgres import PostgresContainer  # noqa: E402
from psycopg_pool import AsyncConnectionPool  # noqa: E402

from loaders.runtime import LoaderConfig, configure_logging  # type: ignore  # noqa: E402
from loaders import load_kgiu  # type: ignore  # noqa: E402


REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
FIXTURES = Path(__file__).parent / "fixtures"
FIXTURE = FIXTURES / "kgiu_mini_beginner.json"
FIXTURE_DUP_IDS = FIXTURES / "kgiu_mini_dup_ids.json"


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


@pytest.fixture(scope="module")
def schema(database_url):
    configure_logging("warning")
    asyncio.run(_apply_migrations(database_url))
    return database_url


async def _count(url: str, sql: str) -> int:
    async with await psycopg.AsyncConnection.connect(url) as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql)
            row = await cur.fetchone()
    return int(row[0]) if row else 0


async def _scalar(url: str, sql: str, params: tuple = ()):
    """First column of the first row (or None)."""
    async with await psycopg.AsyncConnection.connect(url) as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql, params)
            row = await cur.fetchone()
    return row[0] if row else None


def test_kgiu_loader_writes_expected_counts(schema):
    url = schema
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    expected = len(fixture["items"])

    cfg = LoaderConfig(database_url=url, batch_size=50)

    async def run() -> dict:
        async with AsyncConnectionPool(url, min_size=1, max_size=2, open=False) as pool:
            await pool.open(wait=True, timeout=15)
            return await load_kgiu.load(pool, FIXTURE, cfg)

    result = asyncio.run(run())
    assert result["status"] == "complete"
    assert result["actual"] == expected
    # Scoped to this fixture's corpus so the assertion is order-independent in a
    # module-scoped shared container (other tests load into other kgiu corpora).
    assert (
        asyncio.run(_count(url, "SELECT COUNT(*) FROM kgiu_entries WHERE corpus = 'kgiu_beginner'"))
        == expected
    )


def test_kgiu_count_mismatch_marks_failed_not_complete(schema):
    """Regression guard (ADR-019 D8): a post-load row-count mismatch must FAIL
    the load — raise + record ``failed`` — not warn-and-``complete``.

    The fixture ships two items sharing a ``source_id``; the
    ``ON CONFLICT (corpus, source_id)`` upsert collapses them, so 3 source items
    yield only 2 rows. Under the old code that was a ``log.warning`` followed by
    ``mark_complete`` (which the sha skip-guard then made permanently invisible);
    now it must raise ``CountAssertionError`` and leave ``load_state`` ``failed``.
    """
    url = schema
    cfg = LoaderConfig(database_url=url, batch_size=50, force=True)

    async def run() -> None:
        async with AsyncConnectionPool(url, min_size=1, max_size=2, open=False) as pool:
            await pool.open(wait=True, timeout=15)
            await load_kgiu.load(pool, FIXTURE_DUP_IDS, cfg)

    with pytest.raises(load_kgiu.CountAssertionError):
        asyncio.run(run())

    # The source is recorded failed (not complete) so it is retried, not skipped.
    status = asyncio.run(
        _scalar(
            url,
            "SELECT status FROM load_state WHERE corpus = 'kgiu_advanced' AND source_path = %s",
            (str(FIXTURE_DUP_IDS),),
        )
    )
    assert status == "failed"
    # The two distinct ids that did load are present (the collapse left 2, not 3).
    assert (
        asyncio.run(_count(url, "SELECT COUNT(*) FROM kgiu_entries WHERE corpus = 'kgiu_advanced'"))
        == 2
    )
