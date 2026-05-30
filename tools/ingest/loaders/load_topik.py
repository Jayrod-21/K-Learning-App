"""
TOPIK item-pool loader.

One JSON file = one (test_number, section) pair (e.g. topik_36_reading.json).
We upsert one ``topik_tests`` row and N ``topik_items`` rows. Multiple test
numbers share the same corpus enum ``topik``; per ADR-019 the natural key
``(test_number, section)`` separates them.

Note: ``corpus_sources`` is keyed UNIQUE on ``corpus`` (one row per enum
value). For TOPIK we have many source files mapped to one corpus row.
Strategy: the corpus_sources row is upserted on EVERY topik file load, with
the most-recent file's metadata winning. The per-file detail lives in
``load_state`` (one row per source_path). This matches the design intent:
``corpus_sources`` is a catalog of the corpus, not of individual files.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import structlog
from psycopg_pool import AsyncConnectionPool

from .models import TopikDocumentModel, TopikItemModel
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

CORPUS = "topik"


# Map every accepted writing-section discriminator (after the model's
# hyphen→underscore normalization) onto a canonical Postgres
# ``topik_item_type`` enum value. The DB enum has only four members:
# ``multiple_choice``, ``short_answer_blanks``, ``chart_description``,
# ``essay`` (migration 005). The richer variant set comes from
# Claude-vision JSONs and is collapsed here.
#
# FU-NF-7 regression-fix (REVIEW_FIXES_FU_NF.md B1, 2026-05-29): the
# ``Literal`` in ``TopikItemModel.type`` now accepts the union of all
# distinct values found in ``output/topik_*_writing.json``; this map
# keeps the DB cast safe by collapsing each variant onto an enum member.
_TYPE_TO_DB_ENUM: dict[str, str] = {
    # Fill-in-the-blank writing items (#51-52)
    "short_answer_blanks": "short_answer_blanks",
    "short_answer_cloze": "short_answer_blanks",
    "blank_fill": "short_answer_blanks",
    "sentence_completion": "short_answer_blanks",
    "complete_the_sentence": "short_answer_blanks",
    # Chart / data paragraph (#53)
    "chart_description": "chart_description",
    "data_description": "chart_description",
    # Argumentative essay (#54)
    "essay": "essay",
}


def _resolve_item_type(raw_type: str | None, options: list[str]) -> str:
    """Map source-JSON ``type`` to the ``topik_item_type`` Postgres enum.

    Writing JSONs use a small zoo of discriminators (canonicalized by
    ``TopikItemModel`` to underscored forms via a ``mode='before'``
    field validator). This function collapses them onto the four DB enum
    values. When ``raw_type`` is absent (typical MCQ items), we infer
    ``multiple_choice`` from the presence of options.

    ``options`` is accepted for the inference contract — kept as a
    parameter so future callers can branch on it (e.g. distinguishing an
    MCQ with no options vs. an essay), though today we only use it
    implicitly via the source's ``type`` field.

    FU-NF-7 (FOLLOW_UPS.md, 2026-05-29): the model constrains
    ``raw_type`` to a ``Literal``. Regression-fix (REVIEW_FIXES_FU_NF.md
    B1, 2026-05-29): that Literal now covers all distinct values
    observed in the ``output/topik_*_writing.json`` corpus.
    """
    if raw_type is not None:
        mapped = _TYPE_TO_DB_ENUM.get(raw_type)
        if mapped is not None:
            return mapped
        # Unrecognized — should be unreachable because the model's
        # Literal would have rejected at parse time. If we ever loosen
        # the Literal again, fall through to the MCQ default rather
        # than crash the loader.
    _ = options  # reserved for future inference; see docstring.
    return "multiple_choice"


async def load(pool: AsyncConnectionPool, source_path: Path, cfg: LoaderConfig) -> dict:
    log = logger.bind(corpus=CORPUS, source_path=str(source_path))

    raw = source_path.read_bytes()
    doc = TopikDocumentModel.model_validate_json(raw)
    sha = sha256_of_file(source_path)
    total_items = len(doc.items)

    test_number = int(doc.source.test)
    section = doc.source.section  # validated via app-layer enum below

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
            corpus_source_id = await upsert_corpus_source(
                conn,
                corpus=CORPUS,
                title=f"TOPIK item pool ({doc.source.level})",
                publisher=doc.source.origin,
                authors=None,
                level=None,
                default_proficiency=None,
                extracted_by=doc.source.extracted_by,
                extracted_at=doc.source.extracted_at,
                source_path=str(source_path),
                source_sha256=sha,
                item_count=None,  # cross-file count is tracked in load_state
                notes=None,
            )

            # Upsert topik_tests row (one per test+section).
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    INSERT INTO topik_tests (
                        corpus_source_id, corpus, test_number, topik_level,
                        section, form, origin, total_questions, passages)
                    VALUES (%s, %s::corpus, %s, %s, %s::topik_section, %s, %s, %s, %s::jsonb)
                    ON CONFLICT (test_number, section) DO UPDATE
                      SET form            = EXCLUDED.form,
                          origin          = EXCLUDED.origin,
                          total_questions = EXCLUDED.total_questions,
                          passages        = EXCLUDED.passages,
                          version         = topik_tests.version + 1
                    RETURNING id
                    """,
                    (
                        corpus_source_id,
                        CORPUS,
                        test_number,
                        doc.source.level,
                        section,
                        doc.source.form,
                        doc.source.origin,
                        doc.source.total_questions,
                        json.dumps(doc.passages),
                    ),
                )
                row = await cur.fetchone()
                assert row is not None
                topik_test_id = int(row[0])

        loaded_running = 0
        skipped_running = 0
        try:
            # Process items in source-id order so resume-via-last_item_id is
            # well-defined.
            items_sorted = sorted(doc.items, key=lambda x: x.id)
            for batch in batched(items_sorted, cfg.batch_size):
                # Skip already-loaded items on resume.
                if cp.status == "in_progress" and cp.last_item_id:
                    # Capture pre-filter size — the final batch is often
                    # short, so adding ``cfg.batch_size`` would overcount.
                    # See FU-NF-3 (FOLLOW_UPS.md, 2026-05-29) — mirrors the
                    # kgiu loader's fix for the same pattern.
                    original_size = len(batch)
                    batch = [b for b in batch if b.id > cp.last_item_id]
                    if not batch:
                        skipped_running += original_size
                        continue

                async with pool.connection() as conn:
                    async with conn.transaction():
                        await _insert_item_batch(
                            conn,
                            topik_test_id=topik_test_id,
                            corpus_source_id=corpus_source_id,
                            section=section,
                            batch=batch,
                        )
                        last_id = batch[-1].id
                        await checkpoint_progress(
                            conn,
                            corpus=CORPUS,
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

            # Counts assertion.
            async with pool.connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "SELECT COUNT(*)::int FROM topik_items WHERE topik_test_id = %s",
                        (topik_test_id,),
                    )
                    row = await cur.fetchone()
                    actual = int(row[0]) if row else 0
            if actual != total_items:
                log.warning(
                    "count_assertion_mismatch",
                    expected=total_items,
                    actual=actual,
                )

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
                        conn,
                        corpus=CORPUS,
                        source_path=str(source_path),
                        error=repr(err),
                    )
            raise


async def _insert_item_batch(
    conn,
    *,
    topik_test_id: int,
    corpus_source_id: int,
    section: str,
    batch: list[TopikItemModel],
) -> None:
    if not batch:
        return
    values: list[tuple[Any, ...]] = []
    for it in batch:
        item_type = _resolve_item_type(it.type, it.options)
        prof = normalize_proficiency(it.proficiency)
        # Pack anything the model carries without a column into `extra`.
        extra = {
            k: v
            for k, v in {"skill_tag_raw": it.skill_tag_raw}.items()
            if v is not None
        }
        values.append(
            (
                topik_test_id,
                corpus_source_id,
                it.id,
                it.number,
                section,
                item_type,
                it.instruction_group,
                it.instruction,
                it.skill_tag,
                it.skill_tag_raw,
                prof,
                it.points,
                it.stem,
                it.underline,
                it.prompt,
                json.dumps(it.options),
                json.dumps(it.answer) if it.answer is not None else None,
                json.dumps(it.model_answer) if it.model_answer is not None else None,
                it.has_image,
                it.image_text,
                json.dumps(extra),
            )
        )
    async with conn.cursor() as cur:
        await cur.executemany(
            """
            INSERT INTO topik_items (
                topik_test_id, corpus_source_id, corpus, source_id, item_number,
                section, item_type, instruction_group, instruction,
                skill_tag, skill_tag_raw, proficiency, points,
                stem, underline, prompt, options, answer, model_answer,
                has_image, image_text, extra)
            VALUES (
                %s, %s, 'topik'::corpus, %s, %s,
                %s::topik_section, %s::topik_item_type, %s, %s,
                %s, %s, %s::proficiency_level, %s,
                %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb,
                %s, %s, %s::jsonb)
            ON CONFLICT (corpus, source_id) DO UPDATE
              SET item_number       = EXCLUDED.item_number,
                  instruction_group = EXCLUDED.instruction_group,
                  instruction       = EXCLUDED.instruction,
                  skill_tag         = EXCLUDED.skill_tag,
                  skill_tag_raw     = EXCLUDED.skill_tag_raw,
                  proficiency       = EXCLUDED.proficiency,
                  points            = EXCLUDED.points,
                  stem              = EXCLUDED.stem,
                  underline         = EXCLUDED.underline,
                  prompt            = EXCLUDED.prompt,
                  options           = EXCLUDED.options,
                  answer            = EXCLUDED.answer,
                  model_answer      = EXCLUDED.model_answer,
                  has_image         = EXCLUDED.has_image,
                  image_text        = EXCLUDED.image_text,
                  extra             = EXCLUDED.extra,
                  item_type         = EXCLUDED.item_type,
                  version           = topik_items.version + 1
            """,
            values,
        )
