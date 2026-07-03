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
FIXTURES = Path(__file__).parent / "fixtures"
FIXTURE = FIXTURES / "vocab_mini_beginner.json"
FIXTURE_DUP_IDS = FIXTURES / "vocab_mini_dup_ids.json"
# Same beginner corpus + same source_ids as FIXTURE (so the beginner-corpus row
# count stays 4 and the count-scoped tests above are unaffected), but the source
# header's default_proficiency is BLANK -> the word-row proficiency fallback is
# the LEVEL-AWARE terminal branch, not the source default. See SF-1 test below.
FIXTURE_FALLBACK = FIXTURES / "vocab_mini_beginner_fallback.json"


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


def _load(url: str, fixture_path: Path, *, force: bool = False) -> dict:
    cfg = LoaderConfig(database_url=url, batch_size=50, force=force)

    async def run() -> dict:
        async with AsyncConnectionPool(url, min_size=1, max_size=2, open=False) as pool:
            await pool.open(wait=True, timeout=15)
            return await load_vocab_2000.load(pool, fixture_path, cfg)

    return asyncio.run(run())


def test_vocab_loader_writes_expected_counts(schema):
    url = schema
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    expected = len(fixture["items"])

    result = _load(url, FIXTURE)
    assert result["status"] == "complete"
    assert result["actual"] == expected
    # Scoped to this fixture's corpus so the assertion is order-independent in a
    # module-scoped shared container (the dup-ids test loads the intermediate corpus).
    assert (
        asyncio.run(
            _count(
                url,
                "SELECT COUNT(*) FROM vocab_entries WHERE corpus = 'vocab_2000_beginner'",
            )
        )
        == expected
    )


def test_vocab_word_rows_get_proficiency_filled_in(schema):
    """The schema requires non-null proficiency on word rows; loader must fill it."""
    url = schema
    # Idempotent re-load so the test also passes when run in isolation
    # (status is 'skipped' if the counts test already loaded this sha).
    _load(url, FIXTURE)
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


def test_vocab_word_missing_proficiency_gets_source_default(schema):
    """Regression guard for ck_vocab_entries_proficiency_required (the exact
    class of the grammar Bank category 500): a ``word`` entry whose OCR output
    omits ``proficiency`` must be backfilled from the source header's
    default_proficiency ("basic" for the Beginner book), NOT inserted as NULL
    (CHECK violation) and NOT tagged with the flat "L3" fallback."""
    url = schema
    _load(url, FIXTURE)
    prof = asyncio.run(
        _scalar(
            url,
            "SELECT proficiency::text FROM vocab_entries "
            "WHERE corpus = 'vocab_2000_beginner' AND source_id = %s",
            ("vocab-fix-0004",),
        )
    )
    assert prof == "basic", f"expected source-default proficiency 'basic', got {prof!r}"


def test_vocab_word_missing_proficiency_uses_level_fallback_when_source_default_blank(
    schema,
):
    """SF-1 regression: exercises the LEVEL-AWARE *terminal* proficiency fallback
    (``_LEVEL_TO_FALLBACK_PROFICIENCY``), the branch the source-default test
    (``test_vocab_word_missing_proficiency_gets_source_default``) can never reach
    because a present ``default_proficiency`` short-circuits the ``or``.

    Here BOTH operands that precede the fallback are None: the WORD row
    (``vocab-fix-0004``) ships no ``proficiency`` AND the source header's
    ``default_proficiency`` is blank, so ``normalize_proficiency`` returns None
    for each. The loader must then apply the level-aware fallback — beginner
    corpus -> ``basic`` (a flat ``L3`` fallback would mis-tag a Beginner word
    into the intermediate SRS queue) — and NOT insert NULL (which would violate
    ``ck_vocab_entries_proficiency_required``).
    """
    url = schema
    # force=True so the load actually runs even if the beginner corpus was
    # already populated by a sibling fixture (same source_ids); the last write
    # is therefore THIS blank-default file, so vocab-fix-0004's proficiency
    # provably comes from the fallback branch, not a leftover source-default row.
    result = _load(url, FIXTURE_FALLBACK, force=True)
    assert result["status"] == "complete"
    # Count stays 4 (same source_ids as the sibling beginner fixture), so the
    # loader's own count assertion passes and no other beginner test is disturbed.
    assert result["actual"] == 4

    prof = asyncio.run(
        _scalar(
            url,
            "SELECT proficiency::text FROM vocab_entries "
            "WHERE corpus = 'vocab_2000_beginner' AND source_id = %s",
            ("vocab-fix-0004",),
        )
    )
    assert prof == "basic", (
        f"expected level-aware fallback 'basic' for a beginner word, got {prof!r}"
    )


def test_vocab_count_mismatch_marks_failed_not_complete(schema):
    """Regression guard (ADR-019 D8): a post-load row-count mismatch must FAIL
    the load — raise + record ``failed`` — not warn-and-``complete``.

    The fixture ships two items sharing a ``source_id``; the
    ``ON CONFLICT (corpus, source_id)`` upsert collapses them, so 3 source items
    yield only 2 rows. Under the old code that was a ``log.warning`` followed by
    ``mark_complete`` (which the sha skip-guard then made permanently invisible);
    now it must raise ``CountAssertionError`` and leave ``load_state`` ``failed``.
    """
    url = schema

    with pytest.raises(load_vocab_2000.CountAssertionError):
        _load(url, FIXTURE_DUP_IDS, force=True)

    # The source is recorded failed (not complete) so it is retried, not skipped.
    status = asyncio.run(
        _scalar(
            url,
            "SELECT status FROM load_state "
            "WHERE corpus = 'vocab_2000_intermediate' AND source_path = %s",
            (str(FIXTURE_DUP_IDS),),
        )
    )
    assert status == "failed"
    # The two distinct ids that did load are present (the collapse left 2, not 3).
    assert (
        asyncio.run(
            _count(
                url,
                "SELECT COUNT(*) FROM vocab_entries WHERE corpus = 'vocab_2000_intermediate'",
            )
        )
        == 2
    )
