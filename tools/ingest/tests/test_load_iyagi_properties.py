"""
Iyagi loader — ADR-019 §D10 property tests.

Mirrors the kgiu property suite (see ``test_load_kgiu_properties.py``) and
adapts it to the Iyagi loader API. The Iyagi loader has the same shape
as TTMIK (lesson/episode + sentence batches with per-unit checkpointing).

    1. Resume: mark in_progress with last_item_id at the first episode,
       re-run, assert convergence + no duplicates.
    2. Idempotency: second run reports ``status="skipped"``, no churn.
    3. SHA-256 change detection: add a new sentence, re-run without
       force, assert it lands.
    4. Malformed-skip / fail-loud: corrupt one sentence, assert raise +
       no partial rows.
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
from loaders import load_iyagi  # type: ignore  # noqa: E402


logger = structlog.get_logger(__name__)

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


async def _wipe(url: str) -> None:
    async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "TRUNCATE TABLE iyagi_sentences, iyagi_episodes, "
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
            return await load_iyagi.load(pool, fixture_path, cfg)
        finally:
            await pool.close()

    return asyncio.run(_run())


def _total_sentences(fixture: dict) -> int:
    return sum(len(u["sentences"]) for u in fixture["units"])


# =============================================================================
# Property: Idempotency
# =============================================================================
def test_iyagi_loader_idempotent_on_rerun(schema, tmp_path):
    """Second run reports skipped + zero loaded. Row count + episode
    versions are stable (no churn)."""
    url = schema
    asyncio.run(_wipe(url))

    # Use a copy of the shared mini fixture to avoid the iyagi mini only
    # having a single episode in the canonical file affecting other tests.
    fpath = tmp_path / "iyagi_idem.json"
    shutil.copy(FIXTURE, fpath)

    fixture = json.loads(fpath.read_text(encoding="utf-8"))
    expected_sentences = _total_sentences(fixture)
    expected_episodes = len(fixture["units"])

    first = _load(url, fpath)
    assert first["status"] == "complete", first
    assert first["actual"] == expected_sentences

    second = _load(url, fpath)
    assert second["status"] == "skipped", second
    assert second["loaded"] == 0

    assert asyncio.run(_count(url, "SELECT COUNT(*) FROM iyagi_sentences")) == expected_sentences
    assert asyncio.run(_count(url, "SELECT COUNT(*) FROM iyagi_episodes")) == expected_episodes

    max_version = asyncio.run(
        _count(url, "SELECT COALESCE(MAX(version), 0) FROM iyagi_episodes")
    )
    assert max_version == 1, f"idempotent rerun bumped episode versions (max={max_version})"


# =============================================================================
# Property: Resume
# =============================================================================
def test_iyagi_loader_resume_from_checkpoint(schema, tmp_path):
    """Mark load_state in_progress with last_item_id = first episode's
    source_id; re-run; expect lesson 1 skipped, subsequent episodes
    reprocessed via idempotent upsert. Row counts unchanged.

    NOTE: the canonical iyagi_mini fixture has a single episode. We
    extend it inline here so the resume guard has work to do.
    """
    url = schema
    asyncio.run(_wipe(url))

    base = json.loads(FIXTURE.read_text(encoding="utf-8"))
    # Add a second episode so the resume guard has the next-item to load.
    base["units"].append(
        {
            "ordinal": 2,
            "number": 2,
            "hosts": "최경은 & 진석진",
            "title": "이야기 #2",
            "sentences": [
                {
                    "ordinal": 1,
                    "speaker": "최경은",
                    "korean": "오늘은 두 번째 이야기입니다.",
                    "english": None,
                    "romanization": None,
                    "is_dialog": True,
                    "content_hash": "3" * 64,
                },
                {
                    "ordinal": 2,
                    "speaker": "진석진",
                    "korean": "네, 시작합시다.",
                    "english": None,
                    "romanization": None,
                    "is_dialog": True,
                    "content_hash": "4" * 64,
                },
            ],
        }
    )
    fpath = tmp_path / "iyagi_resume.json"
    fpath.write_text(json.dumps(base, ensure_ascii=False, indent=2), encoding="utf-8")

    expected_sentences = _total_sentences(base)
    assert len(base["units"]) >= 2

    # 1. Initial full load.
    first = _load(url, fpath)
    assert first["actual"] == expected_sentences

    # 2. Rewind checkpoint: in_progress, last_item_id = ep 1.
    first_unit = base["units"][0]
    first_ep_source_id = f"iyagi-{first_unit['number']:03d}"

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
                    (first_ep_source_id, len(first_unit["sentences"]), str(fpath)),
                )

    asyncio.run(_rewind())

    # 3. Re-run: episode 1 skipped, episode 2 re-upserted (idempotent).
    second = _load(url, fpath)
    assert second["status"] == "complete", second

    assert asyncio.run(_count(url, "SELECT COUNT(*) FROM iyagi_sentences")) == expected_sentences
    assert asyncio.run(_count(url, "SELECT COUNT(*) FROM iyagi_episodes")) == len(base["units"])

    state = asyncio.run(_fetch_load_state(url, source_path=str(fpath)))
    assert state["status"] == "complete"
    assert state["source_sha256"] is not None


# =============================================================================
# Property: SHA-256 change detection
# =============================================================================
def test_iyagi_loader_detects_sha256_change(schema, tmp_path):
    """Append a new sentence with a unique content_hash, re-run without
    force. The skip-complete path must NOT fire; new row must be present."""
    url = schema
    asyncio.run(_wipe(url))

    f1 = tmp_path / "iyagi_v1.json"
    shutil.copy(FIXTURE, f1)
    base = json.loads(f1.read_text(encoding="utf-8"))
    base_sentence_count = _total_sentences(base)

    first = _load(url, f1)
    assert first["status"] == "complete"
    assert first["actual"] == base_sentence_count

    mutated = json.loads(f1.read_text(encoding="utf-8"))
    probe_hash = "cafebabe" * 8  # 64 chars
    mutated["units"][0]["sentences"].append(
        {
            "ordinal": 99,
            "speaker": "프로브",
            "korean": "이건 SHA-256 변경 감지 테스트입니다.",
            "english": None,
            "romanization": None,
            "is_dialog": True,
            "content_hash": probe_hash,
        }
    )
    f1.write_text(json.dumps(mutated, ensure_ascii=False, indent=2), encoding="utf-8")

    second = _load(url, f1)
    assert second["status"] == "complete", second

    probe_count = asyncio.run(
        _count(
            url,
            "SELECT COUNT(*) FROM iyagi_sentences WHERE content_hash = %s",
            (probe_hash,),
        )
    )
    assert probe_count == 1, "sha-change probe sentence not loaded"
    assert asyncio.run(_count(url, "SELECT COUNT(*) FROM iyagi_sentences")) == base_sentence_count + 1


# =============================================================================
# Property: Malformed input
# =============================================================================
def test_iyagi_loader_malformed_entry_fails_loudly(schema, tmp_path):
    """Sentence missing the required ``korean`` field violates
    IyagiSentenceModel; pydantic raises at parse time so no partial
    rows are written."""
    url = schema
    asyncio.run(_wipe(url))

    bad = tmp_path / "iyagi_bad.json"
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    # Drop the required ``korean`` field on one sentence.
    fixture["units"][0]["sentences"][1].pop("korean", None)
    bad.write_text(json.dumps(fixture, ensure_ascii=False), encoding="utf-8")

    rows_before = asyncio.run(_count(url, "SELECT COUNT(*) FROM iyagi_sentences"))
    eps_before = asyncio.run(_count(url, "SELECT COUNT(*) FROM iyagi_episodes"))

    with pytest.raises(Exception) as exc_info:
        _load(url, bad)
    msg = str(exc_info.value).lower()
    assert "korean" in msg or "validation" in msg or "field required" in msg, (
        f"unexpected error shape: {exc_info.value!r}"
    )

    rows_after = asyncio.run(_count(url, "SELECT COUNT(*) FROM iyagi_sentences"))
    eps_after = asyncio.run(_count(url, "SELECT COUNT(*) FROM iyagi_episodes"))
    assert rows_after == rows_before
    assert eps_after == eps_before

    logger.info(
        "iyagi_malformed_skip_verified",
        rows_before=rows_before,
        rows_after=rows_after,
    )
