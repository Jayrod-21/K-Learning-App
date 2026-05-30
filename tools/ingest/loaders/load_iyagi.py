"""
TTMIK Iyagi (이야기) podcast loader.

Reads ``iyagi_*.json`` from the parser output, writes to ``iyagi_episodes``
and ``iyagi_sentences`` per migration 004. Same idempotency + resume model
as the TTMIK loader.
"""

from __future__ import annotations

from pathlib import Path

import structlog
from psycopg_pool import AsyncConnectionPool

from .models import IyagiDocumentModel, IyagiUnitModel
from .runtime import (
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

CORPUS = "iyagi"


def _episode_source_id(unit: IyagiUnitModel) -> str:
    return f"iyagi-{unit.number:03d}"


async def load(pool: AsyncConnectionPool, source_path: Path, cfg: LoaderConfig) -> dict:
    log = logger.bind(corpus=CORPUS, source_path=str(source_path))

    raw = source_path.read_bytes()
    doc = IyagiDocumentModel.model_validate_json(raw)
    sha = sha256_of_file(source_path)
    total_items = sum(len(u.sentences) for u in doc.units)

    async with pool.connection() as conn:
        async with conn.transaction():
            cp = await get_or_create_checkpoint(
                conn, corpus=CORPUS, source_path=str(source_path)
            )
            if cp.status == "complete" and cp.source_sha256 == sha and not cfg.force:
                log.info("skip_complete", sha256=sha)
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
                level=None,
                default_proficiency=None,
                extracted_by=None,
                extracted_at=None,
                source_path=str(source_path),
                source_sha256=sha,
                item_count=total_items,
                notes=doc.source.title_korean,
            )

        loaded_running = 0
        skipped_running = 0
        try:
            for unit in doc.units:
                ep_source_id = _episode_source_id(unit)
                if (
                    cp.status == "in_progress"
                    and cp.last_item_id
                    and ep_source_id <= cp.last_item_id
                ):
                    skipped_running += len(unit.sentences)
                    continue

                async with pool.connection() as conn:
                    async with conn.transaction():
                        async with conn.cursor() as cur:
                            await cur.execute(
                                """
                                INSERT INTO iyagi_episodes (
                                    corpus_source_id, corpus, source_id,
                                    episode_number, ordinal, title, hosts)
                                VALUES (%s, %s::corpus, %s, %s, %s, %s, %s)
                                ON CONFLICT (corpus, source_id) DO UPDATE
                                  SET episode_number = EXCLUDED.episode_number,
                                      ordinal        = EXCLUDED.ordinal,
                                      title          = EXCLUDED.title,
                                      hosts          = EXCLUDED.hosts,
                                      version        = iyagi_episodes.version + 1
                                RETURNING id
                                """,
                                (
                                    source_id,
                                    CORPUS,
                                    ep_source_id,
                                    unit.number,
                                    unit.ordinal,
                                    unit.title,
                                    unit.hosts,
                                ),
                            )
                            row = await cur.fetchone()
                            assert row is not None
                            episode_id = int(row[0])

                        for batch in batched(unit.sentences, cfg.batch_size):
                            await _insert_sentence_batch(conn, episode_id, batch)
                            loaded_running += len(batch)

                        await checkpoint_progress(
                            conn,
                            corpus=CORPUS,
                            source_path=str(source_path),
                            last_item_id=ep_source_id,
                            items_loaded_delta=len(unit.sentences),
                        )
                log.info(
                    "episode_loaded",
                    ep_source_id=ep_source_id,
                    sentences=len(unit.sentences),
                    total_loaded=loaded_running,
                )

            async with pool.connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        """
                        SELECT COUNT(*)::int
                          FROM iyagi_sentences s
                          JOIN iyagi_episodes e ON e.id = s.episode_id
                         WHERE e.corpus_source_id = %s
                        """,
                        (source_id,),
                    )
                    row = await cur.fetchone()
                    actual = int(row[0]) if row else 0
            if actual != total_items:
                log.warning("count_assertion_mismatch", expected=total_items, actual=actual)

            async with pool.connection() as conn:
                async with conn.transaction():
                    await mark_complete(conn, corpus=CORPUS, source_path=str(source_path))
            return {
                "loaded": loaded_running,
                "skipped": skipped_running,
                "expected": total_items,
                "actual": actual,
                "status": "complete",
            }
        except Exception as err:
            log.error("loader_failed", error=str(err))
            async with pool.connection() as conn:
                async with conn.transaction():
                    await mark_failed(
                        conn, corpus=CORPUS, source_path=str(source_path), error=repr(err)
                    )
            raise


async def _insert_sentence_batch(conn, episode_id: int, batch: list) -> None:
    if not batch:
        return
    values = [
        (
            episode_id,
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
            INSERT INTO iyagi_sentences (
                episode_id, ordinal, korean, english, romanization,
                speaker, is_dialog, content_hash)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (episode_id, content_hash) DO UPDATE
              SET ordinal      = EXCLUDED.ordinal,
                  korean       = EXCLUDED.korean,
                  english      = EXCLUDED.english,
                  romanization = EXCLUDED.romanization,
                  speaker      = EXCLUDED.speaker,
                  is_dialog    = EXCLUDED.is_dialog,
                  version      = iyagi_sentences.version + 1
            """,
            values,
        )
