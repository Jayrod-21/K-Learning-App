"""
Integration tests for the 2000 Essential Korean Words loader.
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
from loaders import load_vocab_2000  # type: ignore  # noqa: E402


REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
FIXTURE = Path(__file__).parent / "fixtures" / "vocab_mini_beginner.json"


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


def test_vocab_loader_writes_expected_counts(schema):
    url = schema
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    expected = len(fixture["items"])

    cfg = LoaderConfig(database_url=url, batch_size=50)

    async def run() -> dict:
        async with AsyncConnectionPool(url, min_size=1, max_size=2, open=False) as pool:
            await pool.open(wait=True, timeout=15)
            return await load_vocab_2000.load(pool, FIXTURE, cfg)

    result = asyncio.run(run())
    assert result["status"] == "complete"
    assert result["actual"] == expected
    assert asyncio.run(_count(url, "SELECT COUNT(*) FROM vocab_entries")) == expected


def test_vocab_word_rows_get_proficiency_filled_in(schema):
    """The schema requires non-null proficiency on word rows; loader must fill it."""
    url = schema
    nulls = asyncio.run(
        _count(
            url,
            """
            SELECT COUNT(*) FROM vocab_entries
             WHERE entry_type = 'word' AND proficiency IS NULL
            """,
        )
    )
    assert nulls == 0
