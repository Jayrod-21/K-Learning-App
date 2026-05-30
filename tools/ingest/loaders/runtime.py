"""
Loader shared infrastructure.

  * Async psycopg connection pool (ADR-001 §D13).
  * Checkpoint helpers around the ``load_state`` table.
  * Batch-commit context manager.

WHY a separate module: every loader needs the same plumbing, and we want
ONE place that knows how to start/commit a batch. If we change the
checkpoint contract, we change it here, once.
"""

from __future__ import annotations

import hashlib
import logging
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator

import structlog
from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool

logger = structlog.get_logger(__name__)


class MalformedEntryError(ValueError):
    """Raised when a source entry violates the loader's domain contract
    (e.g. an unknown discriminator value) and cannot be safely coerced.

    Per ADR-019 §D10 (fail-loud principle), loaders prefer raising this
    over silently rewriting a malformed value into something the schema
    will accept. The caller's exception handler marks the load as failed
    so a re-run after fixing the source data is observable.
    """


@dataclass(frozen=True)
class LoaderConfig:
    database_url: str
    batch_size: int = 200
    dry_run: bool = False
    force: bool = False  # re-load even if sha256 matches
    application_name: str = "korean-master-loader"


def config_from_env() -> LoaderConfig:
    """Read loader config from environment variables."""
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL is required (postgres://user:pass@host:5432/db)")
    return LoaderConfig(
        database_url=url,
        batch_size=int(os.environ.get("LOADER_BATCH_SIZE", "200")),
    )


@asynccontextmanager
async def open_pool(cfg: LoaderConfig) -> AsyncIterator[AsyncConnectionPool]:
    """Open an async connection pool with sensible loader defaults."""
    pool = AsyncConnectionPool(
        cfg.database_url,
        min_size=1,
        max_size=4,
        kwargs={"application_name": cfg.application_name},
        open=False,
    )
    await pool.open(wait=True, timeout=30)
    try:
        yield pool
    finally:
        await pool.close()


def sha256_of_file(path: Path) -> str:
    """Stream-hash a file (avoids loading huge JSONs into memory twice)."""
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


@dataclass
class CheckpointRow:
    id: int
    status: str
    source_sha256: str | None
    items_in_source: int | None
    items_loaded: int
    last_item_id: str | None


async def get_or_create_checkpoint(
    conn: AsyncConnection, *, corpus: str, source_path: str
) -> CheckpointRow:
    """Fetch (or insert) the load_state row for this corpus+file."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO load_state (corpus, source_path, status)
            VALUES (%s::corpus, %s, 'pending')
            ON CONFLICT (corpus, source_path) DO NOTHING
            """,
            (corpus, source_path),
        )
        await cur.execute(
            """
            SELECT id, status, source_sha256, items_in_source, items_loaded, last_item_id
              FROM load_state
             WHERE corpus = %s::corpus AND source_path = %s
            """,
            (corpus, source_path),
        )
        row = await cur.fetchone()
        assert row is not None, "load_state insert+select should always return a row"
        return CheckpointRow(*row)


async def mark_in_progress(
    conn: AsyncConnection,
    *,
    corpus: str,
    source_path: str,
    source_sha256: str,
    items_in_source: int,
) -> None:
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE load_state
               SET status         = 'in_progress',
                   source_sha256  = %s,
                   items_in_source= %s,
                   started_at     = COALESCE(started_at, now()),
                   last_error     = NULL,
                   version        = version + 1
             WHERE corpus = %s::corpus AND source_path = %s
            """,
            (source_sha256, items_in_source, corpus, source_path),
        )


async def checkpoint_progress(
    conn: AsyncConnection,
    *,
    corpus: str,
    source_path: str,
    last_item_id: str,
    items_loaded_delta: int,
) -> None:
    """Bump items_loaded and last_item_id INSIDE the same tx as the batch."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE load_state
               SET items_loaded = items_loaded + %s,
                   last_item_id = %s,
                   updated_at   = now()
             WHERE corpus = %s::corpus AND source_path = %s
            """,
            (items_loaded_delta, last_item_id, corpus, source_path),
        )


async def mark_complete(
    conn: AsyncConnection, *, corpus: str, source_path: str
) -> None:
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE load_state
               SET status       = 'complete',
                   completed_at = now()
             WHERE corpus = %s::corpus AND source_path = %s
            """,
            (corpus, source_path),
        )


async def mark_failed(
    conn: AsyncConnection,
    *,
    corpus: str,
    source_path: str,
    error: str,
) -> None:
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE load_state
               SET status     = 'failed',
                   last_error = %s
             WHERE corpus = %s::corpus AND source_path = %s
            """,
            (error[:4_000], corpus, source_path),
        )


async def upsert_corpus_source(
    conn: AsyncConnection,
    *,
    corpus: str,
    title: str,
    publisher: str | None,
    authors: str | None,
    level: str | None,
    default_proficiency: str | None,
    extracted_by: str | None,
    extracted_at: str | None,
    source_path: str,
    source_sha256: str,
    item_count: int | None,
    notes: str | None,
) -> int:
    """Upsert a corpus_sources row and return its id."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO corpus_sources (
                corpus, title, publisher, authors, level, default_proficiency,
                extracted_by, extracted_at, source_path, source_sha256, item_count, notes
            ) VALUES (
                %s::corpus, %s, %s, %s,
                %s::book_level, %s::proficiency_level,
                %s, %s::date, %s, %s, %s, %s
            )
            ON CONFLICT (corpus) DO UPDATE
              SET title              = EXCLUDED.title,
                  publisher          = EXCLUDED.publisher,
                  authors            = EXCLUDED.authors,
                  level              = EXCLUDED.level,
                  default_proficiency= EXCLUDED.default_proficiency,
                  extracted_by       = EXCLUDED.extracted_by,
                  extracted_at       = EXCLUDED.extracted_at,
                  source_path        = EXCLUDED.source_path,
                  source_sha256      = EXCLUDED.source_sha256,
                  item_count         = EXCLUDED.item_count,
                  notes              = EXCLUDED.notes,
                  version            = corpus_sources.version + 1
            RETURNING id
            """,
            (
                corpus,
                title,
                publisher,
                authors,
                level,
                default_proficiency,
                extracted_by,
                extracted_at,
                source_path,
                source_sha256,
                item_count,
                notes,
            ),
        )
        row = await cur.fetchone()
        assert row is not None
        return int(row[0])


# ---------------------------------------------------------------------------
# Proficiency normalization
# ---------------------------------------------------------------------------

# Closed set in the DB enum. Source JSON sometimes carries off-spec values
# like "L3/L4" (vocab intermediate). We refuse to invent a value; we map
# known synonyms and return None for "really unknown" so the loader can
# defer to corpus_sources.default_proficiency at the per-row level.

_PROFICIENCY_SYNONYMS: dict[str, str] = {
    "basic": "basic",
    "beginner": "basic",
    "l3": "L3",
    "l4": "L4",
    "l5": "L5+",
    "l5+": "L5+",
    "l3/l4": "L3",  # source's hedge — we pick the lower as a safe default
    "intermediate": "L3",
    "advanced": "L4",
}


def normalize_proficiency(value: str | None) -> str | None:
    if value is None:
        return None
    return _PROFICIENCY_SYNONYMS.get(value.strip().lower())


# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------


def configure_logging(level: str = "info") -> None:
    """One-time structlog configuration; safe to call twice."""
    log_level = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(level=log_level, format="%(message)s")
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(log_level),
        cache_logger_on_first_use=True,
    )


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def batched(iterable: list[Any], size: int) -> list[list[Any]]:
    """Yield successive size-sized chunks."""
    return [iterable[i : i + size] for i in range(0, len(iterable), size)]
