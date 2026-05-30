"""
Persistent writes for the cross-reference resolver.

Two upsert paths — one per relations table. Both use the natural-key UNIQUE
indexes added in migration 009 so re-running is idempotent.

ON CONFLICT strategy:
    * `uq_*_relations_fk`   — partial UNIQUE when target_entry_id IS NOT NULL.
    * `uq_*_relations_text` — partial UNIQUE when target_entry_id IS NULL and
                              target_korean IS NOT NULL.

A row with target_entry_id IS NULL must use the text index, so the writer
splits the call sites at the resolved/text-only boundary.

WHY two SQL paths instead of one universal upsert: Postgres ON CONFLICT
takes a single conflict target. Mixing partial-index conflicts at insert
time would require a manual lookup-then-insert pattern, which races. Two
SQL statements with the right target each are correct and faster.
"""

from __future__ import annotations

from typing import Sequence

import structlog
from psycopg import AsyncConnection

from .models import CorpusKind, RelationRow, corpus_kind

logger = structlog.get_logger(__name__)


_KGIU_INSERT_FK = """
INSERT INTO kgiu_entry_relations
    (source_entry_id, relation_kind, target_entry_id, target_korean,
     target_english, target_page, target_source_id, source_corpus,
     resolution_status, note)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s::corpus, %s, %s)
ON CONFLICT (source_entry_id, relation_kind, target_entry_id)
WHERE target_entry_id IS NOT NULL
DO UPDATE SET
    target_korean     = EXCLUDED.target_korean,
    target_english    = EXCLUDED.target_english,
    target_page       = EXCLUDED.target_page,
    target_source_id  = EXCLUDED.target_source_id,
    source_corpus     = EXCLUDED.source_corpus,
    resolution_status = EXCLUDED.resolution_status,
    note              = EXCLUDED.note,
    version           = kgiu_entry_relations.version + 1
WHERE kgiu_entry_relations.target_korean     IS DISTINCT FROM EXCLUDED.target_korean
   OR kgiu_entry_relations.target_english    IS DISTINCT FROM EXCLUDED.target_english
   OR kgiu_entry_relations.target_page       IS DISTINCT FROM EXCLUDED.target_page
   OR kgiu_entry_relations.target_source_id  IS DISTINCT FROM EXCLUDED.target_source_id
   OR kgiu_entry_relations.source_corpus     IS DISTINCT FROM EXCLUDED.source_corpus
   OR kgiu_entry_relations.resolution_status IS DISTINCT FROM EXCLUDED.resolution_status
   OR kgiu_entry_relations.note              IS DISTINCT FROM EXCLUDED.note
RETURNING (xmax = 0) AS inserted, version
"""


_KGIU_INSERT_TEXT = """
INSERT INTO kgiu_entry_relations
    (source_entry_id, relation_kind, target_entry_id, target_korean,
     target_english, target_page, target_source_id, source_corpus,
     resolution_status, note)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s::corpus, %s, %s)
ON CONFLICT (source_entry_id, relation_kind, (lower(target_korean)))
WHERE target_entry_id IS NULL AND target_korean IS NOT NULL
DO UPDATE SET
    target_english    = EXCLUDED.target_english,
    target_page       = EXCLUDED.target_page,
    target_source_id  = EXCLUDED.target_source_id,
    source_corpus     = EXCLUDED.source_corpus,
    resolution_status = EXCLUDED.resolution_status,
    note              = EXCLUDED.note,
    version           = kgiu_entry_relations.version + 1
WHERE kgiu_entry_relations.target_english    IS DISTINCT FROM EXCLUDED.target_english
   OR kgiu_entry_relations.target_page       IS DISTINCT FROM EXCLUDED.target_page
   OR kgiu_entry_relations.target_source_id  IS DISTINCT FROM EXCLUDED.target_source_id
   OR kgiu_entry_relations.source_corpus     IS DISTINCT FROM EXCLUDED.source_corpus
   OR kgiu_entry_relations.resolution_status IS DISTINCT FROM EXCLUDED.resolution_status
   OR kgiu_entry_relations.note              IS DISTINCT FROM EXCLUDED.note
RETURNING (xmax = 0) AS inserted, version
"""


_VOCAB_INSERT_FK = """
INSERT INTO vocab_entry_relations
    (source_entry_id, relation_type, target_entry_id, target_korean,
     target_english, target_page, target_source_id, source_corpus,
     resolution_status, note)
VALUES (%s, %s::vocab_relation_type, %s, %s, %s, %s, %s, %s::corpus, %s, %s)
ON CONFLICT (source_entry_id, relation_type, target_entry_id)
WHERE target_entry_id IS NOT NULL
DO UPDATE SET
    target_korean     = EXCLUDED.target_korean,
    target_english    = EXCLUDED.target_english,
    target_page       = EXCLUDED.target_page,
    target_source_id  = EXCLUDED.target_source_id,
    source_corpus     = EXCLUDED.source_corpus,
    resolution_status = EXCLUDED.resolution_status,
    note              = EXCLUDED.note,
    version           = vocab_entry_relations.version + 1
WHERE vocab_entry_relations.target_korean     IS DISTINCT FROM EXCLUDED.target_korean
   OR vocab_entry_relations.target_english    IS DISTINCT FROM EXCLUDED.target_english
   OR vocab_entry_relations.target_page       IS DISTINCT FROM EXCLUDED.target_page
   OR vocab_entry_relations.target_source_id  IS DISTINCT FROM EXCLUDED.target_source_id
   OR vocab_entry_relations.source_corpus     IS DISTINCT FROM EXCLUDED.source_corpus
   OR vocab_entry_relations.resolution_status IS DISTINCT FROM EXCLUDED.resolution_status
   OR vocab_entry_relations.note              IS DISTINCT FROM EXCLUDED.note
RETURNING (xmax = 0) AS inserted, version
"""


_VOCAB_INSERT_TEXT = """
INSERT INTO vocab_entry_relations
    (source_entry_id, relation_type, target_entry_id, target_korean,
     target_english, target_page, target_source_id, source_corpus,
     resolution_status, note)
VALUES (%s, %s::vocab_relation_type, %s, %s, %s, %s, %s, %s::corpus, %s, %s)
ON CONFLICT (source_entry_id, relation_type, (lower(target_korean)))
WHERE target_entry_id IS NULL AND target_korean IS NOT NULL
DO UPDATE SET
    target_english    = EXCLUDED.target_english,
    target_page       = EXCLUDED.target_page,
    target_source_id  = EXCLUDED.target_source_id,
    source_corpus     = EXCLUDED.source_corpus,
    resolution_status = EXCLUDED.resolution_status,
    note              = EXCLUDED.note,
    version           = vocab_entry_relations.version + 1
WHERE vocab_entry_relations.target_english    IS DISTINCT FROM EXCLUDED.target_english
   OR vocab_entry_relations.target_page       IS DISTINCT FROM EXCLUDED.target_page
   OR vocab_entry_relations.target_source_id  IS DISTINCT FROM EXCLUDED.target_source_id
   OR vocab_entry_relations.source_corpus     IS DISTINCT FROM EXCLUDED.source_corpus
   OR vocab_entry_relations.resolution_status IS DISTINCT FROM EXCLUDED.resolution_status
   OR vocab_entry_relations.note              IS DISTINCT FROM EXCLUDED.note
RETURNING (xmax = 0) AS inserted, version
"""


async def write_relations(
    conn: AsyncConnection,
    rows: Sequence[RelationRow],
) -> tuple[int, int]:
    """Upsert relation rows. Returns (rows_written, rows_unchanged).

    Caller owns the transaction. Mixing kgiu and vocab rows in one call is
    allowed; we route by `source_corpus`.
    """
    written = 0
    unchanged = 0
    for row in rows:
        kind = corpus_kind(row.source_corpus)
        if kind is CorpusKind.KGIU:
            insert_sql = _KGIU_INSERT_FK if row.target_entry_id is not None else _KGIU_INSERT_TEXT
        else:
            insert_sql = _VOCAB_INSERT_FK if row.target_entry_id is not None else _VOCAB_INSERT_TEXT

        params = (
            row.source_entry_id,
            row.relation_kind,
            row.target_entry_id,
            row.target_korean,
            row.target_english,
            row.target_page,
            row.target_source_id,
            row.source_corpus,
            row.resolution_status,
            row.note,
        )
        async with conn.cursor() as cur:
            await cur.execute(insert_sql, params)
            result = await cur.fetchone()
            if result is None:
                # DO UPDATE … WHERE filtered the row → nothing changed.
                unchanged += 1
            else:
                inserted = bool(result[0])
                # inserted = True → new row; inserted = False → modified.
                # Both count as "written" (touched the table); the
                # distinction matters only for logging at INFO level.
                written += 1
                if not inserted:
                    logger.debug(
                        "row_updated",
                        source_entry_id=row.source_entry_id,
                        relation_kind=row.relation_kind,
                        version=result[1],
                    )
    return written, unchanged


# -----------------------------------------------------------------------------
# Checkpoint / state helpers
# -----------------------------------------------------------------------------


async def get_or_create_resolver_state(
    conn: AsyncConnection, *, corpus: str
) -> dict[str, object]:
    """Fetch (or insert) the resolver_state row for this corpus."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO resolver_state (corpus, status)
            VALUES (%s::corpus, 'pending')
            ON CONFLICT (corpus) DO NOTHING
            """,
            (corpus,),
        )
        await cur.execute(
            """
            SELECT id, status, last_source_id,
                   entries_seen, refs_extracted, refs_resolved,
                   refs_text_only, refs_broken
              FROM resolver_state
             WHERE corpus = %s::corpus
            """,
            (corpus,),
        )
        row = await cur.fetchone()
        assert row is not None
        return {
            "id": int(row[0]),
            "status": str(row[1]),
            "last_source_id": row[2],
            "entries_seen": int(row[3]),
            "refs_extracted": int(row[4]),
            "refs_resolved": int(row[5]),
            "refs_text_only": int(row[6]),
            "refs_broken": int(row[7]),
        }


async def mark_resolver_in_progress(
    conn: AsyncConnection, *, corpus: str, reset_counters: bool
) -> None:
    """Move a corpus into 'in_progress'.

    When ``reset_counters`` is True we zero the per-run tallies (full re-run);
    when False we keep them (resume).
    """
    async with conn.cursor() as cur:
        if reset_counters:
            await cur.execute(
                """
                UPDATE resolver_state
                   SET status        = 'in_progress',
                       last_source_id = NULL,
                       entries_seen   = 0,
                       refs_extracted = 0,
                       refs_resolved  = 0,
                       refs_text_only = 0,
                       refs_broken    = 0,
                       started_at     = now(),
                       completed_at   = NULL,
                       last_error     = NULL,
                       version        = version + 1
                 WHERE corpus = %s::corpus
                """,
                (corpus,),
            )
        else:
            await cur.execute(
                """
                UPDATE resolver_state
                   SET status     = 'in_progress',
                       started_at = COALESCE(started_at, now()),
                       completed_at = NULL,
                       last_error = NULL,
                       version    = version + 1
                 WHERE corpus = %s::corpus
                """,
                (corpus,),
            )


async def checkpoint_resolver_progress(
    conn: AsyncConnection,
    *,
    corpus: str,
    last_source_id: str,
    entries_delta: int,
    refs_extracted_delta: int,
    refs_resolved_delta: int,
    refs_text_only_delta: int,
    refs_broken_delta: int,
) -> None:
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE resolver_state
               SET last_source_id  = %s,
                   entries_seen    = entries_seen    + %s,
                   refs_extracted  = refs_extracted  + %s,
                   refs_resolved   = refs_resolved   + %s,
                   refs_text_only  = refs_text_only  + %s,
                   refs_broken     = refs_broken     + %s,
                   updated_at      = now()
             WHERE corpus = %s::corpus
            """,
            (
                last_source_id,
                entries_delta,
                refs_extracted_delta,
                refs_resolved_delta,
                refs_text_only_delta,
                refs_broken_delta,
                corpus,
            ),
        )


async def mark_resolver_complete(
    conn: AsyncConnection, *, corpus: str
) -> None:
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE resolver_state
               SET status       = 'complete',
                   completed_at = now()
             WHERE corpus = %s::corpus
            """,
            (corpus,),
        )


async def mark_resolver_failed(
    conn: AsyncConnection, *, corpus: str, error: str
) -> None:
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE resolver_state
               SET status     = 'failed',
                   last_error = %s
             WHERE corpus = %s::corpus
            """,
            (error[:4_000], corpus),
        )
