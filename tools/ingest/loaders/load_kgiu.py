"""
KGIU (Korean Grammar in Use) loader.

One JSON per level; the corpus enum value is one of
``kgiu_beginner | kgiu_intermediate | kgiu_advanced``. Writes to the unified
``kgiu_entries`` table (migration 002).

The CHECK constraint ``ck_kgiu_entries_level_matches_corpus`` enforces
``corpus``↔``book_level`` agreement, so we derive the corpus tag from the
file's ``source.level`` rather than trusting the filename.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import structlog
from psycopg_pool import AsyncConnectionPool

from .models import KgiuDocumentModel, KgiuItemModel
from .runtime import (
    LoaderConfig,
    batched,
    checkpoint_progress,
    get_or_create_checkpoint,
    mark_complete,
    mark_failed,
    mark_in_progress,
    normalize_proficiency,
    sha256_of_file,
    upsert_corpus_source,
)

logger = structlog.get_logger(__name__)


_LEVEL_TO_CORPUS = {
    "beginner": "kgiu_beginner",
    "intermediate": "kgiu_intermediate",
    "advanced": "kgiu_advanced",
}


class CountAssertionError(RuntimeError):
    """Raised when the post-load ``kgiu_entries`` row count for a file does not
    equal the source item count.

    Per ADR-019 §D8 the loader must fail loud on a counts mismatch and exit
    non-zero so CI/the orchestrator sees drift. The alternative (log a warning
    and mark the source ``complete``) records a partial or silently-deduped load
    — e.g. two items sharing a ``source_id`` collapsing under the
    ``ON CONFLICT (corpus, source_id)`` upsert — as success, which the sha-based
    skip guard then makes permanently invisible on every future non-``--force``
    run. Raising routes through the loader's ``except`` so the source is recorded
    ``failed`` with ``last_error`` and is retried, not skipped.
    """


async def load(pool: AsyncConnectionPool, source_path: Path, cfg: LoaderConfig) -> dict:
    log = logger.bind(source_path=str(source_path))
    # Resolved from the file's declared level inside the try. Stays None until
    # then so the except can tell "we never got far enough to know the corpus"
    # (nothing to record under) from "we know the (corpus, source_path) key".
    corpus: str | None = None

    # The try spans validation + the first (checkpoint + corpus_sources) tx as
    # well as the item batches, so ANY failure — bad JSON, an unknown level, the
    # corpus_sources upsert, a batch INSERT, or a post-load count mismatch — is
    # recorded ``failed`` in load_state for operator triage (ADR-019 D4). The
    # first transaction still owns its own atomic boundary below; the except only
    # records the failure, in a fresh transaction, after that rollback.
    try:
        raw = source_path.read_bytes()
        doc = KgiuDocumentModel.model_validate_json(raw)
        sha = sha256_of_file(source_path)
        total_items = len(doc.items)

        corpus = _LEVEL_TO_CORPUS.get(doc.source.level)
        if corpus is None:
            raise ValueError(f"Unknown KGIU level: {doc.source.level!r}")
        log = logger.bind(corpus=corpus, source_path=str(source_path))

        async with pool.connection() as conn:
            async with conn.transaction():
                cp = await get_or_create_checkpoint(
                    conn, corpus=corpus, source_path=str(source_path)
                )
                if cp.status == "complete" and cp.source_sha256 == sha and not cfg.force:
                    log.info("skip_complete", sha256=sha)
                    return {"loaded": 0, "skipped": total_items, "status": "skipped"}
                await mark_in_progress(
                    conn,
                    corpus=corpus,
                    source_path=str(source_path),
                    source_sha256=sha,
                    items_in_source=total_items,
                )
                corpus_source_id = await upsert_corpus_source(
                    conn,
                    corpus=corpus,
                    title=doc.source.book,
                    publisher=doc.source.publisher,
                    authors=doc.source.authors,
                    level=doc.source.level,
                    default_proficiency=normalize_proficiency(doc.source.default_proficiency),
                    extracted_by=doc.source.extracted_by,
                    extracted_at=doc.source.extracted_at,
                    source_path=str(source_path),
                    source_sha256=sha,
                    item_count=total_items,
                    notes=doc.source.note,
                )

        loaded_running = 0
        skipped_running = 0
        # Process in source-id order so resume-via-last_item_id is well-defined.
        items_sorted = sorted(doc.items, key=lambda x: x.id)
        for batch in batched(items_sorted, cfg.batch_size):
            if cp.status == "in_progress" and cp.last_item_id:
                # Capture pre-filter size — the final batch is often short, so
                # adding ``cfg.batch_size`` would lie about how many items were
                # actually skipped. See REVIEW_B3 SF6.
                original_size = len(batch)
                batch = [b for b in batch if b.id > cp.last_item_id]
                if not batch:
                    skipped_running += original_size
                    continue

            async with pool.connection() as conn:
                async with conn.transaction():
                    await _insert_item_batch(
                        conn,
                        corpus=corpus,
                        corpus_source_id=corpus_source_id,
                        book_level=doc.source.level,
                        default_proficiency=doc.source.default_proficiency,
                        batch=batch,
                    )
                    last_id = batch[-1].id
                    await checkpoint_progress(
                        conn,
                        corpus=corpus,
                        source_path=str(source_path),
                        last_item_id=last_id,
                        items_loaded_delta=len(batch),
                    )
            loaded_running += len(batch)
            log.info(
                "items_batch_loaded",
                batch_size=len(batch),
                total_loaded=loaded_running,
            )

        async with pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT COUNT(*)::int FROM kgiu_entries WHERE corpus_source_id = %s",
                    (corpus_source_id,),
                )
                row = await cur.fetchone()
                actual = int(row[0]) if row else 0
        if actual != total_items:
            # Fail loud (ADR-019 D8): do NOT mark_complete. Raising routes to the
            # except below, which records the source ``failed`` so the drift is
            # visible and the file is retried (not silently skipped) next run. A
            # mismatch here means real data loss — typically duplicate source_ids
            # in one file collapsing under the ON CONFLICT (corpus, source_id)
            # upsert, or a batch that failed to insert.
            raise CountAssertionError(
                f"kgiu {corpus} {source_path.name}: expected {total_items} rows, "
                f"loaded {actual} (duplicate source_ids or a dropped batch?)"
            )

        async with pool.connection() as conn:
            async with conn.transaction():
                await mark_complete(conn, corpus=corpus, source_path=str(source_path))
        return {
            "loaded": loaded_running,
            "skipped": skipped_running,
            "expected": total_items,
            "actual": actual,
            "status": "complete",
        }
    except Exception as err:
        log.error("loader_failed", error=str(err))
        # Record the failure under (corpus, source_path) for triage (ADR-019 D4).
        # If the failure preceded level resolution (corpus is None — bad JSON or
        # an unknown level), there is no load_state key to write under, so we
        # only log + re-raise. Guarded so a secondary failure while recording
        # cannot mask the original error.
        if corpus is not None:
            try:
                async with pool.connection() as conn:
                    async with conn.transaction():
                        await get_or_create_checkpoint(
                            conn, corpus=corpus, source_path=str(source_path)
                        )
                        await mark_failed(
                            conn,
                            corpus=corpus,
                            source_path=str(source_path),
                            error=repr(err),
                        )
            except Exception as rec_err:
                log.error("failed_to_record_failure", error=str(rec_err))
        raise


async def _insert_item_batch(
    conn,
    *,
    corpus: str,
    corpus_source_id: int,
    book_level: str,
    default_proficiency: str,
    batch: list[KgiuItemModel],
) -> None:
    if not batch:
        return
    values: list[tuple[Any, ...]] = []
    for it in batch:
        prof = normalize_proficiency(it.proficiency) or normalize_proficiency(
            default_proficiency
        ) or "basic"
        values.append(
            (
                corpus_source_id,
                corpus,
                it.id,
                book_level,
                it.type,
                it.unit,
                it.audio_track,
                it.source_book,
                it.source_pages,
                it.pattern,
                it.title_en,
                it.category,
                it.explanation,
                prof,
                it.register,
                it.domain,
                json.dumps(it.formation_rules),
                json.dumps(it.examples),
                json.dumps(it.dialogues),
                json.dumps(it.vocabulary),
                json.dumps(it.tips),
                json.dumps(it.compare_with),
                json.dumps(it.exercises),
                json.dumps(it.cultural_notes),
                it.notes,
            )
        )
    async with conn.cursor() as cur:
        await cur.executemany(
            """
            INSERT INTO kgiu_entries (
                corpus_source_id, corpus, source_id, book_level,
                entry_type, unit, audio_track, source_book, source_pages,
                pattern, title_en, category, explanation,
                proficiency, register, domain,
                formation_rules, examples, dialogues, vocabulary,
                tips, compare_with, exercises, cultural_notes, notes)
            VALUES (
                %s, %s::corpus, %s, %s::book_level,
                %s::kgiu_entry_type, %s, %s, %s, %s,
                %s, %s, %s, %s,
                %s::proficiency_level, %s, %s::content_domain,
                %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb,
                %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s)
            ON CONFLICT (corpus, source_id) DO UPDATE
              SET entry_type      = EXCLUDED.entry_type,
                  unit            = EXCLUDED.unit,
                  audio_track     = EXCLUDED.audio_track,
                  source_pages    = EXCLUDED.source_pages,
                  pattern         = EXCLUDED.pattern,
                  title_en        = EXCLUDED.title_en,
                  category        = EXCLUDED.category,
                  explanation     = EXCLUDED.explanation,
                  proficiency     = EXCLUDED.proficiency,
                  register        = EXCLUDED.register,
                  domain          = EXCLUDED.domain,
                  formation_rules = EXCLUDED.formation_rules,
                  examples        = EXCLUDED.examples,
                  dialogues       = EXCLUDED.dialogues,
                  vocabulary      = EXCLUDED.vocabulary,
                  tips            = EXCLUDED.tips,
                  compare_with    = EXCLUDED.compare_with,
                  exercises       = EXCLUDED.exercises,
                  cultural_notes  = EXCLUDED.cultural_notes,
                  notes           = EXCLUDED.notes,
                  version         = kgiu_entries.version + 1
            """,
            values,
        )
