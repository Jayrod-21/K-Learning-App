"""
TTMIK loader — ADR-019 §D10 property tests.

Mirrors the kgiu property suite (see ``test_load_kgiu_properties.py``) and
adapts it to the TTMIK loader API:

    1. Resume: mark load_state in_progress with last_item_id at the first
       lesson, re-run, assert convergence + no dup sentences.
    2. Idempotency: a clean second run reports ``status="skipped"`` (sha
       match short-circuit) and leaves the row counts unchanged.
    3. SHA-256 change detection: mutate the source JSON, re-run without
       ``force``, assert the new sentence is written.
    4. Malformed-skip / fail-loud: corrupt one sentence (drop a required
       field), assert the loader raises and that no partial rows survive.

Tested against a real Postgres in Docker (testcontainers). See
SENIOR_ENGINEER_BAR.md §"Testing".
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
from loaders import load_ttmik  # type: ignore  # noqa: E402


logger = structlog.get_logger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
FIXTURE = Path(__file__).parent / "fixtures" / "ttmik_mini.json"


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
    """Truncate TTMIK tables, corpus_sources, and load_state so each test
    starts from a clean slate. CASCADE handles the FK chain."""
    async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "TRUNCATE TABLE ttmik_sentences, ttmik_lessons, "
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
            return await load_ttmik.load(pool, fixture_path, cfg)
        finally:
            await pool.close()

    return asyncio.run(_run())


def _total_sentences(fixture: dict) -> int:
    return sum(len(u["sentences"]) for u in fixture["units"])


# =============================================================================
# Property: Idempotency — a no-op re-run is observably no-op.
# =============================================================================
def test_ttmik_loader_idempotent_on_rerun(schema):
    """Loading the same fixture twice leaves both ttmik_lessons and
    ttmik_sentences row counts unchanged. The second run short-circuits
    on the sha256-match guard and returns status='skipped'."""
    url = schema
    asyncio.run(_wipe(url))
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    expected_sentences = _total_sentences(fixture)
    expected_lessons = len(fixture["units"])

    first = _load(url, FIXTURE)
    assert first["status"] == "complete", first
    assert first["actual"] == expected_sentences

    second = _load(url, FIXTURE)
    assert second["status"] == "skipped", second
    assert second["loaded"] == 0

    assert asyncio.run(_count(url, "SELECT COUNT(*) FROM ttmik_sentences")) == expected_sentences
    assert asyncio.run(_count(url, "SELECT COUNT(*) FROM ttmik_lessons")) == expected_lessons

    # version churn check: a re-upsert would bump version. After idempotent
    # short-circuit, no lesson row should have version > 1.
    max_version = asyncio.run(
        _count(url, "SELECT COALESCE(MAX(version), 0) FROM ttmik_lessons")
    )
    assert max_version == 1, f"idempotent rerun bumped lesson versions (max={max_version})"


# =============================================================================
# Property: Resume — pick up where we left off.
# =============================================================================
def test_ttmik_loader_resume_from_checkpoint(schema):
    """Simulate "crashed after lesson 1" by rewriting load_state to
    in_progress + last_item_id=<L1-01 source_id>, then re-run. The
    loader must skip lesson 1 (already-present rows untouched), load
    lesson 2, and converge on the same final sentence count as a clean
    full load. No duplicates."""
    url = schema
    asyncio.run(_wipe(url))
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    expected_sentences = _total_sentences(fixture)
    assert len(fixture["units"]) >= 2, "fixture must have >= 2 lessons for resume test"

    # 1. Full load so all rows are present.
    first = _load(url, FIXTURE)
    assert first["actual"] == expected_sentences

    # 2. Rewind checkpoint to look like "crashed after the first lesson".
    #    NULL the sha to bust the skip-complete short-circuit.
    first_unit = fixture["units"][0]
    first_lesson_source_id = f"ttmik-L{first_unit['level']}-{first_unit['lesson']:02d}"

    async def _rewind() -> None:
        async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    UPDATE load_state
                       SET status = 'in_progress',
                           last_item_id = %s,
                           items_loaded = %s,
                           source_sha256 = NULL
                     WHERE source_path = %s
                    """,
                    (
                        first_lesson_source_id,
                        len(first_unit["sentences"]),
                        str(FIXTURE),
                    ),
                )

    asyncio.run(_rewind())

    # 3. Re-run. Lesson 1 is skipped by the resume guard; lesson 2 is
    #    re-upserted (idempotent on (lesson_id, content_hash)).
    second = _load(url, FIXTURE)
    assert second["status"] == "complete", second

    # No duplicates: row count unchanged.
    assert asyncio.run(_count(url, "SELECT COUNT(*) FROM ttmik_sentences")) == expected_sentences
    assert asyncio.run(_count(url, "SELECT COUNT(*) FROM ttmik_lessons")) == len(fixture["units"])

    state = asyncio.run(_fetch_load_state(url, source_path=str(FIXTURE)))
    assert state["status"] == "complete"
    assert state["source_sha256"] is not None


# =============================================================================
# Property: SHA-256 change detection — modify the input, get a re-load.
# =============================================================================
def test_ttmik_loader_detects_sha256_change(schema, tmp_path):
    """Mutating the fixture (adding a new sentence with a unique
    content_hash) must defeat the skip-complete short-circuit. The new
    row must be present after re-run."""
    url = schema
    asyncio.run(_wipe(url))

    f1 = tmp_path / "ttmik_v1.json"
    shutil.copy(FIXTURE, f1)
    base = json.loads(f1.read_text(encoding="utf-8"))
    base_sentence_count = _total_sentences(base)

    first = _load(url, f1)
    assert first["status"] == "complete"
    assert first["actual"] == base_sentence_count

    # Add a new sentence to lesson 1 with a unique content_hash so the
    # upsert path inserts (does not collide).
    mutated = json.loads(f1.read_text(encoding="utf-8"))
    probe_hash = "deadbeef" * 8  # 64 chars
    mutated["units"][0]["sentences"].append(
        {
            "ordinal": 99,
            "korean": "프로브",
            "english": "Probe sentence",
            "romanization": None,
            "speaker": None,
            "is_dialog": False,
            "content_hash": probe_hash,
        }
    )
    f1.write_text(json.dumps(mutated, ensure_ascii=False, indent=2), encoding="utf-8")

    second = _load(url, f1)
    assert second["status"] == "complete", second

    # Probe row is present.
    probe_count = asyncio.run(
        _count(
            url,
            "SELECT COUNT(*) FROM ttmik_sentences WHERE content_hash = %s",
            (probe_hash,),
        )
    )
    assert probe_count == 1, "sha-change probe sentence not loaded"

    # Total grew by exactly one.
    assert asyncio.run(_count(url, "SELECT COUNT(*) FROM ttmik_sentences")) == base_sentence_count + 1


# =============================================================================
# Property: Malformed input — fail loudly, do not write partial rows.
# =============================================================================
def test_ttmik_loader_malformed_entry_fails_loudly(schema, tmp_path, caplog):
    """A sentence missing a required field (e.g. ``korean``) violates
    the TtmikSentenceModel contract. Pydantic raises at parse time
    BEFORE any rows are written, so the table count stays unchanged.

    Contract per ADR-019 §D10: either reject the whole batch or
    skip-with-log; NEVER half-write."""
    url = schema
    asyncio.run(_wipe(url))

    bad = tmp_path / "ttmik_bad.json"
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    # Corrupt sentence in lesson 2 — drop the required ``korean`` field.
    fixture["units"][1]["sentences"][0].pop("korean", None)
    bad.write_text(json.dumps(fixture, ensure_ascii=False), encoding="utf-8")

    rows_before = asyncio.run(_count(url, "SELECT COUNT(*) FROM ttmik_sentences"))
    lessons_before = asyncio.run(_count(url, "SELECT COUNT(*) FROM ttmik_lessons"))

    with pytest.raises(Exception) as exc_info:
        _load(url, bad)
    msg = str(exc_info.value).lower()
    assert "korean" in msg or "validation" in msg or "field required" in msg, (
        f"unexpected error shape: {exc_info.value!r}"
    )

    rows_after = asyncio.run(_count(url, "SELECT COUNT(*) FROM ttmik_sentences"))
    lessons_after = asyncio.run(_count(url, "SELECT COUNT(*) FROM ttmik_lessons"))
    # The invariant: malformed input wrote no partial rows.
    assert rows_after == rows_before, (
        f"loader wrote partial sentences on malformed input; "
        f"before={rows_before} after={rows_after}"
    )
    assert lessons_after == lessons_before, (
        f"loader wrote partial lessons on malformed input; "
        f"before={lessons_before} after={lessons_after}"
    )

    logger.info(
        "ttmik_malformed_skip_verified",
        rows_before=rows_before,
        rows_after=rows_after,
    )
