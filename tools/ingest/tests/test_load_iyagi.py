"""
Integration tests for the Iyagi loader.

Counts + idempotency only — the resume + sha256 paths are exercised by
test_load_ttmik.py and the implementation is shared via the runtime helpers.
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
from loaders import load_iyagi  # type: ignore  # noqa: E402


REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
FIXTURE = Path(__file__).parent / "fixtures" / "iyagi_mini.json"


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


def test_iyagi_loader_writes_expected_counts(schema):
    url = schema
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    expected_episodes = len(fixture["units"])
    expected_sentences = sum(len(u["sentences"]) for u in fixture["units"])

    cfg = LoaderConfig(database_url=url, batch_size=50)

    async def run() -> dict:
        async with AsyncConnectionPool(url, min_size=1, max_size=2, open=False) as pool:
            await pool.open(wait=True, timeout=15)
            return await load_iyagi.load(pool, FIXTURE, cfg)

    result = asyncio.run(run())
    assert result["status"] == "complete"

    assert asyncio.run(_count(url, "SELECT COUNT(*) FROM iyagi_episodes")) == expected_episodes
    assert asyncio.run(_count(url, "SELECT COUNT(*) FROM iyagi_sentences")) == expected_sentences


def test_iyagi_loader_idempotent(schema):
    url = schema
    cfg = LoaderConfig(database_url=url, batch_size=50, force=True)

    async def run() -> None:
        async with AsyncConnectionPool(url, min_size=1, max_size=2, open=False) as pool:
            await pool.open(wait=True, timeout=15)
            await load_iyagi.load(pool, FIXTURE, cfg)
            await load_iyagi.load(pool, FIXTURE, cfg)

    asyncio.run(run())
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    expected_sentences = sum(len(u["sentences"]) for u in fixture["units"])
    assert asyncio.run(_count(url, "SELECT COUNT(*) FROM iyagi_sentences")) == expected_sentences
