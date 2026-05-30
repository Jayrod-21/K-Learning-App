"""
KGIU loader — ADR-019 §D10 property tests.

ADR-019 commits every loader to FIVE properties; B3's original test suite
covered only one (correct row counts). This file adds the missing four:

    1. Resume: kill mid-load, restart, assert final count = fixture.
    2. Idempotency: load twice in a row, assert row count and load_state
       both stable.
    3. SHA-256 change detection: modify the fixture, re-run without --force,
       assert the loader detects the change and reloads.
    4. Malformed-entry skip / fail-loud: invalid input MUST not write
       partial data; the loader either raises at parse time or marks the
       run failed and leaves no dangling rows.

Tested against a real Postgres in Docker (testcontainers). SQLite is not
Postgres and would mask the issues these tests catch (FK semantics,
ENUMs, transaction isolation). See SENIOR_ENGINEER_BAR.md §"Testing".

See FIX_REPORT_B.md §B3-SF1.
"""

from __future__ import annotations

import asyncio
import json
import shutil
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
FIXTURE = Path(__file__).parent / "fixtures" / "kgiu_mini_beginner.json"


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


async def _wipe_kgiu(url: str) -> None:
    """Truncate the KGIU tables between tests so we get a clean slate.
    Cascades to children and resets the load_state row."""
    async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "TRUNCATE TABLE kgiu_entries, corpus_sources, load_state "
                "RESTART IDENTITY CASCADE"
            )


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


async def _fetch_load_state(url: str, *, source_path: str) -> dict:
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
            return await load_kgiu.load(pool, fixture_path, cfg)
        finally:
            await pool.close()

    return asyncio.run(_run())


# =============================================================================
# Property 2: Idempotency — a no-op re-run is observably no-op.
# =============================================================================
def test_kgiu_loader_idempotent_on_rerun(schema):
    """Loading the same fixture twice must leave row count unchanged and
    must report 'skipped' (sha256 unchanged) on the second pass."""
    url = schema
    asyncio.run(_wipe_kgiu(url))
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    expected = len(fixture["items"])

    first = _load(url, FIXTURE)
    assert first["status"] == "complete", first
    assert first["actual"] == expected

    second = _load(url, FIXTURE)
    # Second run must short-circuit on the sha256-match guard. status
    # 'skipped' is the loader's contract for "I noticed; I did nothing".
    assert second["status"] == "skipped", second
    assert second["loaded"] == 0
    # Row count is unchanged.
    assert asyncio.run(_count(url, "SELECT COUNT(*) FROM kgiu_entries")) == expected


# =============================================================================
# Property 3: Resume — pick up where we left off.
# =============================================================================
def test_kgiu_loader_resume_from_checkpoint(schema):
    """If the checkpoint says 'in_progress' with a last_item_id, a re-run
    must skip the already-loaded items and converge on the same final
    row count as a clean run.

    Approach: load fully, manually mark the checkpoint as in_progress with
    last_item_id at item 0, then re-run — it should re-process item 1 only
    (the upsert is idempotent, so the row count stays correct).
    """
    url = schema
    asyncio.run(_wipe_kgiu(url))
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    expected = len(fixture["items"])
    assert expected >= 2, "fixture must have >= 2 items for resume test"
    items_sorted = sorted(fixture["items"], key=lambda x: x["id"])
    first_item_id = items_sorted[0]["id"]

    # 1. Initial full load.
    first = _load(url, FIXTURE)
    assert first["actual"] == expected

    # 2. Simulate "we crashed after item 0" by rewriting load_state in
    #    place. This is the same shape the loader writes mid-batch.
    async def _rewind() -> None:
        async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    UPDATE load_state
                       SET status = 'in_progress',
                           last_item_id = %s,
                           items_loaded = 1,
                           source_sha256 = NULL  -- bust the skip-complete short-circuit
                     WHERE source_path = %s
                    """,
                    (first_item_id, str(FIXTURE)),
                )

    asyncio.run(_rewind())

    # 3. Re-run. The loader must mark in_progress (refreshes sha), skip
    #    item 0 (filtered by last_item_id), and upsert item 1.
    second = _load(url, FIXTURE)
    assert second["status"] == "complete", second
    # Row count converges on expected — upsert is idempotent so the
    # already-present item-0 row is left intact.
    assert asyncio.run(_count(url, "SELECT COUNT(*) FROM kgiu_entries")) == expected
    # Checkpoint should now read complete with the new sha.
    state = asyncio.run(_fetch_load_state(url, source_path=str(FIXTURE)))
    assert state["status"] == "complete"
    assert state["source_sha256"] is not None


# =============================================================================
# Property 4: SHA-256 change detection — modify the input, get a re-load.
# =============================================================================
def test_kgiu_loader_detects_sha256_change(schema, tmp_path):
    """A modified fixture must NOT be short-circuited by the sha-match
    skip path. The loader should re-process and write the new rows."""
    url = schema
    asyncio.run(_wipe_kgiu(url))

    # Make a writable copy of the fixture so we can mutate it.
    f1 = tmp_path / "kgiu_v1.json"
    shutil.copy(FIXTURE, f1)
    base = json.loads(f1.read_text(encoding="utf-8"))
    expected = len(base["items"])

    first = _load(url, f1)
    assert first["status"] == "complete"
    assert first["actual"] == expected

    # Mutate: add a new item. Re-write the file (different sha).
    mutated = json.loads(f1.read_text(encoding="utf-8"))
    new_item = dict(mutated["items"][0])
    new_item["id"] = "kgiu-fix-sha-test-extra"
    new_item["title_en"] = "Sha-change probe entry"
    mutated["items"].append(new_item)
    f1.write_text(
        json.dumps(mutated, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # Re-run WITHOUT --force. The sha differs, so the skip-complete path
    # must not fire.
    second = _load(url, f1)
    assert second["status"] == "complete", second
    # The new row must be present.
    assert asyncio.run(
        _count(
            url,
            "SELECT COUNT(*) FROM kgiu_entries WHERE source_id = 'kgiu-fix-sha-test-extra'",
        )
    ) == 1


# =============================================================================
# Property 5: Malformed input — fail loudly, do not write partial rows.
# =============================================================================
def test_kgiu_loader_malformed_entry_fails_loudly(schema, tmp_path):
    """A KGIU document that violates the model contract must NOT silently
    drop the offender. The loader should raise (pydantic ValidationError
    surfaces at parse time) and leave no partial rows in kgiu_entries.

    This is the malformed-skip / fail-loud property from ADR-019 §D10:
    the contract is "either reject the whole batch or skip-with-log";
    NEVER half-write.
    """
    url = schema
    asyncio.run(_wipe_kgiu(url))

    bad = tmp_path / "kgiu_bad.json"
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    # Corrupt one item: missing the required `id` field. KgiuItemModel
    # has `extra="forbid"` (Pydantic) and id is required.
    fixture["items"][1].pop("id", None)
    bad.write_text(json.dumps(fixture, ensure_ascii=False), encoding="utf-8")

    rows_before = asyncio.run(_count(url, "SELECT COUNT(*) FROM kgiu_entries"))
    with pytest.raises(Exception) as exc_info:
        _load(url, bad)
    # Pydantic ValidationError is the expected shape; allow any subclass.
    assert "id" in str(exc_info.value).lower() or "validation" in str(
        exc_info.value
    ).lower()

    rows_after = asyncio.run(_count(url, "SELECT COUNT(*) FROM kgiu_entries"))
    # The crucial invariant: malformed input did NOT corrupt the DB.
    assert rows_after == rows_before, (
        "loader wrote partial rows on malformed input; "
        f"before={rows_before}, after={rows_after}"
    )
