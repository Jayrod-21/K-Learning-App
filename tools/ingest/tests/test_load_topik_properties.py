"""
TOPIK loader — ADR-019 §D10 property tests.

Mirrors the kgiu property suite (see ``test_load_kgiu_properties.py``) and
adapts to the TOPIK loader: one JSON = one (test_number, section) tuple,
items batched and checkpointed by sorted ``item.id``.

    1. Resume: in_progress + last_item_id at first item id, re-run,
       assert convergence + no duplicates.
    2. Idempotency: second run reports ``skipped``, no churn.
    3. SHA-256 change detection: append a new item, re-run without
       force, assert new row written.
    4. Malformed-skip / fail-loud: drop the required ``id`` field on
       one item, assert raise + no partial rows.
"""

from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path
from typing import Any

import pytest
import structlog

testcontainers = pytest.importorskip("testcontainers.postgres")
psycopg_pool = pytest.importorskip("psycopg_pool")
psycopg = pytest.importorskip("psycopg")

from testcontainers.postgres import PostgresContainer  # noqa: E402
from psycopg_pool import AsyncConnectionPool  # noqa: E402

from loaders.runtime import LoaderConfig, configure_logging  # type: ignore  # noqa: E402
from loaders import load_topik  # type: ignore  # noqa: E402


logger = structlog.get_logger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
FIXTURE = Path(__file__).parent / "fixtures" / "topik_mini_reading.json"


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


async def _wipe(url: str) -> None:
    """Truncate TOPIK + parent tables. CASCADE handles topik_items via
    topik_tests FK."""
    async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "TRUNCATE TABLE topik_items, topik_tests, "
                "corpus_sources, load_state RESTART IDENTITY CASCADE"
            )


@pytest.fixture(scope="module")
def schema(database_url) -> str:
    configure_logging("warning")
    asyncio.run(_apply_migrations(database_url))
    return database_url


async def _count(url: str, sql: str, params: tuple = ()) -> int:
    async with await psycopg.AsyncConnection.connect(url) as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql, params)
            row = await cur.fetchone()
    return int(row[0]) if row else 0


async def _fetch_load_state(url: str, *, source_path: str) -> dict[str, Any]:
    async with await psycopg.AsyncConnection.connect(url) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT status, source_sha256, items_loaded, last_item_id "
                "FROM load_state WHERE source_path = %s",
                (source_path,),
            )
            row = await cur.fetchone()
    if not row:
        return {}
    return {
        "status": row[0],
        "source_sha256": row[1],
        "items_loaded": row[2],
        "last_item_id": row[3],
    }


async def _open_pool(url: str) -> AsyncConnectionPool:
    pool = AsyncConnectionPool(url, min_size=1, max_size=2, open=False)
    await pool.open(wait=True, timeout=15)
    return pool


def _load(url: str, fixture_path: Path, *, batch_size: int = 50, force: bool = False) -> dict:
    cfg = LoaderConfig(database_url=url, batch_size=batch_size, force=force)

    async def _run() -> dict:
        pool = await _open_pool(url)
        try:
            return await load_topik.load(pool, fixture_path, cfg)
        finally:
            await pool.close()

    return asyncio.run(_run())


# =============================================================================
# Property: Idempotency
# =============================================================================
def test_topik_loader_idempotent_on_rerun(schema):
    """Second run on identical input is observably no-op: status=skipped,
    loaded=0, row counts and version stable."""
    url = schema
    asyncio.run(_wipe(url))
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    expected_items = len(fixture["items"])

    first = _load(url, FIXTURE)
    assert first["status"] == "complete", first
    assert first["actual"] == expected_items

    second = _load(url, FIXTURE)
    assert second["status"] == "skipped", second
    assert second["loaded"] == 0

    assert asyncio.run(_count(url, "SELECT COUNT(*) FROM topik_items")) == expected_items
    assert asyncio.run(_count(url, "SELECT COUNT(*) FROM topik_tests")) == 1

    # version churn check on items
    max_version = asyncio.run(
        _count(url, "SELECT COALESCE(MAX(version), 0) FROM topik_items")
    )
    assert max_version == 1, f"idempotent rerun bumped item versions (max={max_version})"


# =============================================================================
# Property: Resume
# =============================================================================
def test_topik_loader_resume_from_checkpoint(schema):
    """Set load_state to in_progress + last_item_id at the first sorted
    item id, re-run. Loader filters out items with id <= last_item_id,
    then re-upserts the rest. Row count must converge."""
    url = schema
    asyncio.run(_wipe(url))
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    expected_items = len(fixture["items"])
    assert expected_items >= 2, "fixture must have >= 2 items for resume test"

    items_sorted = sorted(fixture["items"], key=lambda x: x["id"])
    first_id = items_sorted[0]["id"]

    # 1. Full load.
    first = _load(url, FIXTURE)
    assert first["actual"] == expected_items

    # 2. Rewind checkpoint to "crashed after first item".
    async def _rewind() -> None:
        async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    UPDATE load_state
                       SET status = 'in_progress',
                           last_item_id = %s,
                           items_loaded = 1,
                           source_sha256 = NULL
                     WHERE source_path = %s
                    """,
                    (first_id, str(FIXTURE)),
                )

    asyncio.run(_rewind())

    # 3. Re-run: skip item 1 (filter id > last_item_id), upsert items 2+.
    second = _load(url, FIXTURE)
    assert second["status"] == "complete", second

    # No duplicates.
    assert asyncio.run(_count(url, "SELECT COUNT(*) FROM topik_items")) == expected_items

    state = asyncio.run(_fetch_load_state(url, source_path=str(FIXTURE)))
    assert state["status"] == "complete"
    assert state["source_sha256"] is not None


# =============================================================================
# Property: SHA-256 change detection
# =============================================================================
def test_topik_loader_detects_sha256_change(schema, tmp_path):
    """Mutating the fixture (adding one item) must defeat the skip-
    complete path. New row must land."""
    url = schema
    asyncio.run(_wipe(url))

    f1 = tmp_path / "topik_v1.json"
    shutil.copy(FIXTURE, f1)
    base = json.loads(f1.read_text(encoding="utf-8"))
    base_count = len(base["items"])

    first = _load(url, f1)
    assert first["status"] == "complete"
    assert first["actual"] == base_count

    # Append a probe item (sortable last so it always passes the resume
    # guard in any path).
    mutated = json.loads(f1.read_text(encoding="utf-8"))
    probe = dict(mutated["items"][0])
    probe["id"] = "topik99-read-zzz-probe"
    probe["number"] = 999
    probe["stem"] = "Sha-change probe item"
    mutated["items"].append(probe)
    f1.write_text(json.dumps(mutated, ensure_ascii=False, indent=2), encoding="utf-8")

    second = _load(url, f1)
    assert second["status"] == "complete", second

    probe_rows = asyncio.run(
        _count(
            url,
            "SELECT COUNT(*) FROM topik_items WHERE source_id = %s",
            ("topik99-read-zzz-probe",),
        )
    )
    assert probe_rows == 1, "sha-change probe item not loaded"
    assert asyncio.run(_count(url, "SELECT COUNT(*) FROM topik_items")) == base_count + 1


# =============================================================================
# Property: Malformed input
# =============================================================================
def test_topik_loader_malformed_entry_fails_loudly(schema, tmp_path):
    """Item missing the required ``id`` field violates TopikItemModel.
    Pydantic must raise at parse time, leaving no partial rows."""
    url = schema
    asyncio.run(_wipe(url))

    bad = tmp_path / "topik_bad.json"
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    # Drop required ``id`` on one item.
    fixture["items"][1].pop("id", None)
    bad.write_text(json.dumps(fixture, ensure_ascii=False), encoding="utf-8")

    rows_before = asyncio.run(_count(url, "SELECT COUNT(*) FROM topik_items"))
    tests_before = asyncio.run(_count(url, "SELECT COUNT(*) FROM topik_tests"))

    with pytest.raises(Exception) as exc_info:
        _load(url, bad)
    msg = str(exc_info.value).lower()
    assert "id" in msg or "validation" in msg or "field required" in msg, (
        f"unexpected error shape: {exc_info.value!r}"
    )

    rows_after = asyncio.run(_count(url, "SELECT COUNT(*) FROM topik_items"))
    tests_after = asyncio.run(_count(url, "SELECT COUNT(*) FROM topik_tests"))
    assert rows_after == rows_before
    assert tests_after == tests_before

    logger.info(
        "topik_malformed_skip_verified",
        rows_before=rows_before,
        rows_after=rows_after,
    )


