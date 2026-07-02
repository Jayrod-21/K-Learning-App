"""
Integration tests for the TOPIK loader.
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
from loaders import load_topik  # type: ignore  # noqa: E402


REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
FIXTURES = Path(__file__).parent / "fixtures"
FIXTURE = FIXTURES / "topik_mini_reading.json"
FIXTURE_I_LISTENING = FIXTURES / "topik_mini_I_listening.json"
FIXTURE_II_LISTENING = FIXTURES / "topik_mini_II_listening.json"
FIXTURE_II_WRITING = FIXTURES / "topik_mini_II_writing.json"
FIXTURE_DUP_IDS = FIXTURES / "topik_mini_dup_ids.json"


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


def test_topik_loader_writes_test_and_items(schema):
    url = schema
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    expected = len(fixture["items"])

    cfg = LoaderConfig(database_url=url, batch_size=50)

    async def run() -> dict:
        async with AsyncConnectionPool(url, min_size=1, max_size=2, open=False) as pool:
            await pool.open(wait=True, timeout=15)
            return await load_topik.load(pool, FIXTURE, cfg)

    result = asyncio.run(run())
    assert result["status"] == "complete"
    assert result["actual"] == expected
    # Scope to this fixture's sitting (test 99): the module-scoped container is
    # shared with the other tests, which load their own sittings (97, 98), so a
    # global COUNT(*) is order-coupled. See REVIEW_TOPIK_LOAD_C SHOULD-FIX 1.
    assert (
        asyncio.run(_count(url, "SELECT COUNT(*) FROM topik_tests WHERE test_number = 99"))
        == 1
    )
    assert (
        asyncio.run(
            _count(
                url,
                "SELECT COUNT(*) FROM topik_items i "
                "JOIN topik_tests t ON t.id = i.topik_test_id "
                "WHERE t.test_number = 99",
            )
        )
        == expected
    )


def test_topik_loader_idempotent(schema):
    url = schema
    cfg = LoaderConfig(database_url=url, batch_size=50, force=True)

    async def run() -> None:
        async with AsyncConnectionPool(url, min_size=1, max_size=2, open=False) as pool:
            await pool.open(wait=True, timeout=15)
            await load_topik.load(pool, FIXTURE, cfg)
            await load_topik.load(pool, FIXTURE, cfg)

    asyncio.run(run())
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    # Scoped to sitting 99 (see test 1) so it is order-independent of the
    # test-97/98 rows the other tests insert into the shared container.
    assert (
        asyncio.run(
            _count(
                url,
                "SELECT COUNT(*) FROM topik_items i "
                "JOIN topik_tests t ON t.id = i.topik_test_id "
                "WHERE t.test_number = 99",
            )
        )
        == len(fixture["items"])
    )


def test_topik_same_sitting_both_levels_coexist(schema):
    """Regression guard: both TOPIK-I and TOPIK-II items for the SAME sitting
    survive a load — neither level overwrites the other.

    A sitting has both a TOPIK-I and a TOPIK-II listening paper, each numbering
    its questions from 1. Before the level was encoded in the item id, the two
    files shared source_ids (e.g. ``topik98-listen-001``) and the loader's
    ``ON CONFLICT (corpus, source_id)`` made the second load silently clobber
    the first. Migration 029 + the level-qualified id scheme fix this at the
    test and item grain; this test locks that in.
    """
    url = schema
    cfg = LoaderConfig(database_url=url, batch_size=50, force=True)

    async def run() -> None:
        async with AsyncConnectionPool(url, min_size=1, max_size=2, open=False) as pool:
            await pool.open(wait=True, timeout=15)
            await load_topik.load(pool, FIXTURE_I_LISTENING, cfg)
            await load_topik.load(pool, FIXTURE_II_LISTENING, cfg)

    asyncio.run(run())

    # Two distinct test rows for sitting 98 — one per level.
    assert asyncio.run(_count(url, "SELECT COUNT(*) FROM topik_tests WHERE test_number = 98")) == 2
    # All four items survive (2 per level); nothing was overwritten.
    assert (
        asyncio.run(
            _count(
                url,
                "SELECT COUNT(*) FROM topik_items i "
                "JOIN topik_tests t ON t.id = i.topik_test_id "
                "WHERE t.test_number = 98 AND t.section = 'listening'",
            )
        )
        == 4
    )
    # Listening item #1 exists once per level under DISTINCT source_ids — this is
    # exactly the pair that collided under the old id scheme.
    assert (
        asyncio.run(
            _count(
                url,
                "SELECT COUNT(DISTINCT i.source_id) FROM topik_items i "
                "JOIN topik_tests t ON t.id = i.topik_test_id "
                "WHERE t.test_number = 98 AND t.section = 'listening' "
                "AND i.item_number = 1",
            )
        )
        == 2
    )
    # Source provenance from the TOPIK-II file is persisted (migration 030).
    prov = asyncio.run(
        _scalar(
            url,
            "SELECT provenance->>'transcript_available' FROM topik_tests "
            "WHERE test_number = 98 AND topik_level = 'TOPIK II' AND section = 'listening'",
        )
    )
    assert prov == "true"
    # answers_verified_against is also carried into provenance (REVIEW_TOPIK_LOAD_B
    # S1 — it was modeled but previously dropped by the loader).
    verified = asyncio.run(
        _scalar(
            url,
            "SELECT provenance->>'answers_verified_against' FROM topik_tests "
            "WHERE test_number = 98 AND topik_level = 'TOPIK II' AND section = 'listening'",
        )
    )
    assert verified == "Fixture: official NIIED answer key"


def test_topik_writing_short_answer_and_char_range(schema):
    """Writing items load: ``short_answer`` maps to the DB enum
    ``short_answer_blanks`` and ``char_range`` is preserved in ``extra``.

    The writing files previously failed to load entirely — ``short_answer`` was
    absent from the model's ``type`` Literal, so Pydantic rejected the whole
    document. ``char_range`` (the #53/#54 answer-length range) was silently
    dropped by ``extra='ignore'``. This guards both fixes.
    """
    url = schema
    cfg = LoaderConfig(database_url=url, batch_size=50, force=True)

    async def run() -> dict:
        async with AsyncConnectionPool(url, min_size=1, max_size=2, open=False) as pool:
            await pool.open(wait=True, timeout=15)
            return await load_topik.load(pool, FIXTURE_II_WRITING, cfg)

    result = asyncio.run(run())
    assert result["status"] == "complete"

    # #51 short_answer collapses onto the canonical DB enum.
    item_type_51 = asyncio.run(
        _scalar(
            url,
            "SELECT item_type FROM topik_items i JOIN topik_tests t ON t.id = i.topik_test_id "
            "WHERE t.test_number = 98 AND t.section = 'writing' AND i.item_number = 51",
        )
    )
    assert item_type_51 == "short_answer_blanks"

    # #53/#54 keep their own discriminators and both carry char_range in extra.
    assert (
        asyncio.run(
            _count(
                url,
                "SELECT COUNT(*) FROM topik_items i JOIN topik_tests t ON t.id = i.topik_test_id "
                "WHERE t.test_number = 98 AND t.section = 'writing' AND i.extra ? 'char_range'",
            )
        )
        == 2
    )
    char_range_53 = asyncio.run(
        _scalar(
            url,
            "SELECT extra->>'char_range' FROM topik_items i JOIN topik_tests t ON t.id = i.topik_test_id "
            "WHERE t.test_number = 98 AND t.section = 'writing' AND i.item_number = 53",
        )
    )
    assert char_range_53 == "200~300"


def test_topik_count_mismatch_marks_failed_not_complete(schema):
    """Regression guard (REVIEW_TOPIK_LOAD_B B1): a loaded-vs-source count
    mismatch must mark the source ``failed`` and raise — never ``complete``.

    Before the fix, a mismatch was a ``log.warning`` and the loader called
    ``mark_complete`` anyway, so a partial/deduped load was recorded as success
    and then permanently skipped on every future non-``--force`` run (the
    sha-based skip guard). This fixture has two items sharing ONE source_id, so
    they collapse under the ``(corpus, source_id)`` upsert: one row lands while
    the source declares two. Per ADR-019 D8 the loader must fail loud.
    """
    url = schema
    # batch_size=1 so the two duplicate-id rows land in SEPARATE INSERT commands.
    # A single executemany with two conflicting rows would instead raise a
    # cardinality error ("ON CONFLICT DO UPDATE command cannot affect row a
    # second time") before the count assertion is reached — a different failure.
    cfg = LoaderConfig(database_url=url, batch_size=1, force=True)

    async def run() -> None:
        async with AsyncConnectionPool(url, min_size=1, max_size=2, open=False) as pool:
            await pool.open(wait=True, timeout=15)
            await load_topik.load(pool, FIXTURE_DUP_IDS, cfg)

    with pytest.raises(load_topik.CountAssertionError):
        asyncio.run(run())

    # The source is recorded ``failed`` (NOT ``complete``) with an error message.
    status = asyncio.run(
        _scalar(
            url,
            "SELECT status FROM load_state WHERE corpus = 'topik'::corpus AND source_path = %s",
            (str(FIXTURE_DUP_IDS),),
        )
    )
    assert status == "failed"
    last_error = asyncio.run(
        _scalar(
            url,
            "SELECT last_error FROM load_state WHERE corpus = 'topik'::corpus AND source_path = %s",
            (str(FIXTURE_DUP_IDS),),
        )
    )
    assert last_error is not None
