"""
TTMIK lesson-series loader.

Reads ``ttmik_*.json`` from the parser output, writes to ``ttmik_lessons``
and ``ttmik_sentences`` per migration 004. Idempotent via the
``(corpus, source_id)`` and ``(lesson_id, content_hash)`` natural keys.

A single source JSON typically contains 3 levels × ~25 lessons × ~30 sentences
= ~2,250 rows; well within the default batch size (200) handling.
"""

from __future__ import annotations

import json
from pathlib import Path

import structlog
from psycopg_pool import AsyncConnectionPool

from .models import TtmikDocumentModel, TtmikUnitModel
from .runtime import (
    CheckpointRow,
    LoaderConfig,
    batched,
    checkpoint_progress,
    get_or_create_checkpoint,
    mark_complete,
    mark_failed,
    mark_in_progress,
    sha256_of_file,
    upsert_corpus_source,
)

logger = structlog.get_logger(__name__)

CORPUS = "ttmik"


def _lesson_source_id(unit: TtmikUnitModel) -> str:
    """Stable per-(level, lesson) id. Used by uq_ttmik_lessons_corpus_source_id."""
    return f"ttmik-L{unit.level}-{unit.lesson:02d}"


async def load(pool: AsyncConnectionPool, source_path: Path, cfg: LoaderConfig) -> dict:
    """
    Load one TTMIK JSON file. Returns a summary dict with counts.

    Idempotency:
      - corpus_sources upserted on ``corpus`` natural key.
      - ttmik_lessons upserted on ``(corpus, source_id)``.
      - ttmik_sentences upserted on ``(lesson_id, content_hash)`` — the
        loader's batch INSERT uses ON CONFLICT DO UPDATE.

    Resume:
      - get_or_create_checkpoint reads/creates the load_state row.
      - On status=in_progress, we skip lessons whose source_id <= last_item_id
        AND continue from the next lesson. Within a lesson we always do a
        full upsert (cheap because of hash dedup).
    """
    log = logger.bind(corpus=CORPUS, source_path=str(source_path))

    raw = source_path.read_bytes()
    doc = TtmikDocumentModel.model_validate_json(raw)
    sha = sha256_of_file(source_path)
    total_items = sum(len(u.sentences) for u in doc.units)

    async with pool.connection() as conn:
        # All checkpoint reads + writes inside one transaction with the data
        # batch ensures atomicity.
        async with conn.transaction():
            cp = await get_or_create_checkpoint(
                conn, corpus=CORPUS, source_path=str(source_path)
            )

            # Fast-path: complete + sha matches + not forced.
            if cp.status == "complete" and cp.source_sha256 == sha and not cfg.force:
                log.info("skip_complete", reason="sha256-matches", sha256=sha)
                return {"loaded": 0, "skipped": total_items, "status": "skipped"}

            await mark_in_progress(
                conn,
                corpus=CORPUS,
                source_path=str(source_path),
                source_sha256=sha,
                items_in_source=total_items,
            )

            source_id = await upsert_corpus_source(
                conn,
                corpus=CORPUS,
                title=doc.source.title,
                publisher=doc.source.publisher,
                authors=None,
                level=None,  # TTMIK file spans levels
                default_proficiency=None,
                extracted_by=None,
                extracted_at=None,
                source_path=str(source_path),
                source_sha256=sha,
                item_count=total_items,
                notes=None,
            )

        # Process unit by unit. Each lesson's sentence-batches commit
        # independently so resume can pick up between lessons.
        loaded_running = 0
        skipped_running = 0
        try:
            for unit in doc.units:
                lesson_source_id = _lesson_source_id(unit)

                # Resume guard: skip lessons we've already finished.
                if (
                    cp.status == "in_progress"
                    and cp.last_item_id
                    and lesson_source_id <= cp.last_item_id
                ):
                    skipped_running += len(unit.sentences)
                    continue

                async with pool.connection() as conn:
                    async with conn.transaction():
                        # Upsert the lesson row.
                        async with conn.cursor() as cur:
                            await cur.execute(
                                """
                                INSERT INTO ttmik_lessons (
                                    corpus_source_id, corpus, source_id,
                                    book_level, lesson_level, lesson_number,
                                    ordinal, title)
                                VALUES (%s, %s::corpus, %s,
                                        NULL::book_level, %s, %s, %s, %s)
                                ON CONFLICT (corpus, source_id) DO UPDATE
                                  SET lesson_level  = EXCLUDED.lesson_level,
                                      lesson_number = EXCLUDED.lesson_number,
                                      ordinal       = EXCLUDED.ordinal,
                                      title         = EXCLUDED.title,
                                      version       = ttmik_lessons.version + 1
                                RETURNING id
                                """,
                                (
                                    source_id,
                                    CORPUS,
                                    lesson_source_id,
                                    unit.level,
                                    unit.lesson,
                                    unit.ordinal,
                                    unit.title,
                                ),
                            )
                            row = await cur.fetchone()
                            assert row is not None
                            lesson_id = int(row[0])

                        # Sentence batches.
                        for batch in batched(unit.sentences, cfg.batch_size):
                            await _insert_sentence_batch(conn, lesson_id, batch)
                            loaded_running += len(batch)

                        await checkpoint_progress(
                            conn,
                            corpus=CORPUS,
                            source_path=str(source_path),
                            last_item_id=lesson_source_id,
                            items_loaded_delta=len(unit.sentences),
                        )
                log.info(
                    "lesson_loaded",
                    lesson_source_id=lesson_source_id,
                    sentences=len(unit.sentences),
                    total_loaded=loaded_running,
                )

            # Counts assertion.
            async with pool.connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        """
                        SELECT COUNT(*)::int
                          FROM ttmik_sentences s
                          JOIN ttmik_lessons l ON l.id = s.lesson_id
                         WHERE l.corpus_source_id = %s
                        """,
                        (source_id,),
                    )
                    row = await cur.fetchone()
                    actual = int(row[0]) if row else 0

            expected = total_items
            if actual != expected:
                log.warning(
                    "count_assertion_mismatch", expected=expected, actual=actual
                )

            async with pool.connection() as conn:
                async with conn.transaction():
                    await mark_complete(
                        conn, corpus=CORPUS, source_path=str(source_path)
                    )
            return {
                "loaded": loaded_running,
                "skipped": skipped_running,
                "expected": expected,
                "actual": actual,
                "status": "complete",
            }

        except Exception as err:
            log.error("loader_failed", error=str(err))
            async with pool.connection() as conn:
                async with conn.transaction():
                    await mark_failed(
                        conn,
                        corpus=CORPUS,
                        source_path=str(source_path),
                        error=repr(err),
                    )
            raise


async def _insert_sentence_batch(conn, lesson_id: int, batch: list) -> None:
    """Insert one batch of sentences as a single multi-row INSERT."""
    if not batch:
        return
    # Build value tuples.
    values = [
        (
            lesson_id,
            s.ordinal,
            s.korean,
            s.english,
            s.romanization,
            s.speaker,
            s.is_dialog,
            s.content_hash,
        )
        for s in batch
    ]
    async with conn.cursor() as cur:
        await cur.executemany(
            """
            INSERT INTO ttmik_sentences (
                lesson_id, ordinal, korean, english, romanization,
                speaker, is_dialog, content_hash)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (lesson_id, content_hash) DO UPDATE
              SET ordinal      = EXCLUDED.ordinal,
                  korean       = EXCLUDED.korean,
                  english      = EXCLUDED.english,
                  romanization = EXCLUDED.romanization,
                  speaker      = EXCLUDED.speaker,
                  is_dialog    = EXCLUDED.is_dialog,
                  version      = ttmik_sentences.version + 1
            """,
            values,
        )
