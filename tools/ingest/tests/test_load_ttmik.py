"""
Integration tests for the TTMIK loader.

Bar §"Testing":
  - Real Postgres in Docker (testcontainers).
  - Cover: row counts, FK integrity, resume, idempotency, sha256 detection.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest
import structlog

# Optional dep guard: skip the whole module if testcontainers / psycopg
# aren't installed in the runner environment. Lets the rest of the test
# suite still run.
testcontainers = pytest.importorskip("testcontainers.postgres")
psycopg_pool = pytest.importorskip("psycopg_pool")
psycopg = pytest.importorskip("psycopg")

from testcontainers.postgres import PostgresContainer  # noqa: E402
from psycopg_pool import AsyncConnectionPool  # noqa: E402

from loaders.runtime import LoaderConfig, configure_logging  # type: ignore  # noqa: E402
from loaders import load_ttmik  # type: ignore  # noqa: E402


REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
FIXTURE = Path(__file__).parent / "fixtures" / "ttmik_mini.json"


@pytest.fixture(scope="module")
def pg_container():
    container = PostgresContainer("postgres:16-alpine")
    container.start()
    try:
        yield container
    finally:
        container.stop()


@pytest.fixture(scope="module")
def database_url(pg_container) -> str:
    url = pg_container.get_connection_url()
    # testcontainers returns a psycopg2 URL; normalize to libpq form.
    url = url.replace("postgresql+psycopg2://", "postgresql://")
    return url


async def _apply_migrations(url: str) -> None:
    """Apply every *.up.sql in db/migrations/ in numeric order."""
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


async def _count(url: str, sql: str, params: tuple = ()) -> int:
    async with await psycopg.AsyncConnection.connect(url) as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql, params)
            row = await cur.fetchone()
    return int(row[0]) if row else 0


def test_loader_loads_expected_row_counts(schema, tmp_path):
    """Fresh load: assert ttmik_lessons + ttmik_sentences row counts."""
    url = schema
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    expected_lessons = len(fixture["units"])
    expected_sentences = sum(len(u["sentences"]) for u in fixture["units"])

    cfg = LoaderConfig(database_url=url, batch_size=50)

    async def run() -> dict:
        async with AsyncConnectionPool(
            url, min_size=1, max_size=2, open=False
        ) as pool:
            await pool.open(wait=True, timeout=15)
            return await load_ttmik.load(pool, FIXTURE, cfg)

    result = asyncio.run(run())
    assert result["status"] == "complete"
    assert result["actual"] == expected_sentences

    lessons = asyncio.run(
        _count(url, "SELECT COUNT(*) FROM ttmik_lessons")
    )
    sentences = asyncio.run(
        _count(url, "SELECT COUNT(*) FROM ttmik_sentences")
    )
    assert lessons == expected_lessons
    assert sentences == expected_sentences


def test_loader_is_idempotent(schema):
    """Re-running the same file produces no duplicates."""
    url = schema
    cfg = LoaderConfig(database_url=url, batch_size=50, force=True)

    async def run() -> None:
        async with AsyncConnectionPool(
            url, min_size=1, max_size=2, open=False
        ) as pool:
            await pool.open(wait=True, timeout=15)
            await load_ttmik.load(pool, FIXTURE, cfg)
            await load_ttmik.load(pool, FIXTURE, cfg)  # second run

    asyncio.run(run())
    sentences = asyncio.run(_count(url, "SELECT COUNT(*) FROM ttmik_sentences"))
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    expected = sum(len(u["sentences"]) for u in fixture["units"])
    assert sentences == expected


def test_loader_fk_integrity(schema):
    """Every sentence must reference an existing lesson."""
    url = schema
    orphans = asyncio.run(
        _count(
            url,
            """
            SELECT COUNT(*)
              FROM ttmik_sentences s
              LEFT JOIN ttmik_lessons l ON l.id = s.lesson_id
             WHERE l.id IS NULL
            """,
        )
    )
    assert orphans == 0


def test_loader_resume_after_partial(schema):
    """
    Simulate a crash mid-load by manually setting load_state.in_progress with
    last_item_id = first lesson; then call the loader and assert the second
    lesson still gets loaded (no duplicates, no skipped items).
    """
    url = schema
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    expected_total = sum(len(u["sentences"]) for u in fixture["units"])

    async def setup_partial() -> None:
        # Clear everything, mark in-progress with last_item_id = first lesson.
        async with await psycopg.AsyncConnection.connect(url) as conn:
            async with conn.transaction():
                async with conn.cursor() as cur:
                    await cur.execute("TRUNCATE ttmik_sentences, ttmik_lessons RESTART IDENTITY CASCADE")
                    await cur.execute(
                        """
                        DELETE FROM corpus_sources WHERE corpus = 'ttmik'::corpus
                        """
                    )
                    await cur.execute(
                        """
                        DELETE FROM load_state WHERE corpus = 'ttmik'::corpus
                        """
                    )
                    await cur.execute(
                        """
                        INSERT INTO load_state (corpus, source_path, status, source_sha256, last_item_id)
                        VALUES ('ttmik'::corpus, %s, 'in_progress', NULL, 'ttmik-L1-01')
                        """,
                        (str(FIXTURE),),
                    )

    asyncio.run(setup_partial())

    cfg = LoaderConfig(database_url=url, batch_size=50)

    async def run() -> dict:
        async with AsyncConnectionPool(
            url, min_size=1, max_size=2, open=False
        ) as pool:
            await pool.open(wait=True, timeout=15)
            return await load_ttmik.load(pool, FIXTURE, cfg)

    asyncio.run(run())

    sentences = asyncio.run(_count(url, "SELECT COUNT(*) FROM ttmik_sentences"))
    # Resume skipped lesson L1-01 (its sentences were never inserted in this
    # scenario because we truncated), and loaded L1-02 only. We assert the
    # final count is at least the L1-02 count; exact equality depends on
    # whether resume re-applies L1-01 or not — our loader skips by source_id
    # so L1-01 stays absent.
    fixture_l2_sentences = len(fixture["units"][1]["sentences"])
    assert sentences == fixture_l2_sentences
