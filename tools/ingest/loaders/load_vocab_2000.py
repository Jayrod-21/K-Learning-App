"""
2000 Essential Korean Words loader (beginner + intermediate).

Writes to the unified ``vocab_entries`` table (migration 002). The corpus
enum value is one of ``vocab_2000_beginner | vocab_2000_intermediate``.

Source rows carry ``type`` ∈ {word, theme_intro, subsection_intro, reference}.
A non-NULL ``proficiency`` is REQUIRED for ``word`` rows by the schema CHECK
``ck_vocab_entries_proficiency_required``; we use ``normalize_proficiency``
and fall back to the source-level default_proficiency for word rows; for
navigational rows we leave proficiency NULL.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import structlog
from psycopg_pool import AsyncConnectionPool

from .models import VocabDocumentModel, VocabItemModel
from .runtime import (
    LoaderConfig,
    MalformedEntryError,
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
    "beginner": "vocab_2000_beginner",
    "intermediate": "vocab_2000_intermediate",
}


async def load(pool: AsyncConnectionPool, source_path: Path, cfg: LoaderConfig) -> dict:
    raw = source_path.read_bytes()
    doc = VocabDocumentModel.model_validate_json(raw)
    sha = sha256_of_file(source_path)
    total_items = len(doc.items)

    corpus = _LEVEL_TO_CORPUS.get(doc.source.level)
    if corpus is None:
        raise ValueError(f"Unknown vocab level: {doc.source.level!r}")

    log = logger.bind(corpus=corpus, source_path=str(source_path))

    # default_proficiency for the corpus row needs to fit the enum, so we
    # normalize "L3/L4" → "L3". For per-row use we keep the raw source value
    # too so the loader can still distinguish.
    default_proficiency_norm = normalize_proficiency(doc.source.default_proficiency)

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
                default_proficiency=default_proficiency_norm,
                extracted_by=doc.source.extracted_by,
                extracted_at=doc.source.extracted_at,
                source_path=str(source_path),
                source_sha256=sha,
                item_count=total_items,
                notes=doc.source.note,
            )

        loaded_running = 0
        skipped_running = 0
        try:
            items_sorted = sorted(doc.items, key=lambda x: x.id)
            for batch in batched(items_sorted, cfg.batch_size):
                if cp.status == "in_progress" and cp.last_item_id:
                    # Pre-filter size; using ``cfg.batch_size`` would
                    # overcount on the (frequently short) final batch.
                    # Same bug class as FU-NF-3 in load_topik.py.
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
                            default_proficiency=default_proficiency_norm,
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
                        "SELECT COUNT(*)::int FROM vocab_entries WHERE corpus_source_id = %s",
                        (corpus_source_id,),
                    )
                    row = await cur.fetchone()
                    actual = int(row[0]) if row else 0
            if actual != total_items:
                log.warning(
                    "count_assertion_mismatch", expected=total_items, actual=actual
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
            async with pool.connection() as conn:
                async with conn.transaction():
                    await mark_failed(
                        conn,
                        corpus=corpus,
                        source_path=str(source_path),
                        error=repr(err),
                    )
            raise


_VALID_ENTRY_TYPES = {
    "word",
    "theme_intro",
    "subsection_intro",
    "reference",
    "lets_check",  # "Let's Check" review/exercise pages (non-word section)
    "hanja_extension",  # hanja supplement sections (non-word section)
}


async def _insert_item_batch(
    conn,
    *,
    corpus: str,
    corpus_source_id: int,
    book_level: str,
    default_proficiency: str | None,
    batch: list[VocabItemModel],
) -> None:
    if not batch:
        return
    values: list[tuple[Any, ...]] = []
    for it in batch:
        # Fail loud per ADR-019 §D10: an unknown `type` in the source means
        # the source data is malformed (typo) or the model has drifted.
        # Silently coercing to "word" would back-fill proficiency to "L3"
        # and write a wrong-class entry — a real bug the operator would
        # never see. Raise instead; the outer mark_failed/log path includes
        # the entry's source_id so the operator can find the offender.
        if it.type not in _VALID_ENTRY_TYPES:
            logger.error(
                "vocab_2000_unknown_entry_type",
                source_id=it.id,
                received_type=it.type,
                valid_types=sorted(_VALID_ENTRY_TYPES),
            )
            raise MalformedEntryError(
                f"vocab-2000 entry {it.id!r} has unknown type {it.type!r}; "
                f"expected one of {sorted(_VALID_ENTRY_TYPES)}"
            )
        entry_type = it.type
        # Word rows require non-NULL proficiency by schema. Source default
        # can be ambiguous ("L3/L4"); the normalizer resolves that.
        prof = normalize_proficiency(it.proficiency)
        if entry_type == "word" and prof is None:
            prof = default_proficiency or "L3"
        # `notes` can be array OR string in source — the schema CHECK accepts
        # both shapes. Preserve the source form.
        if isinstance(it.notes, list):
            notes_json = json.dumps(it.notes)
        elif isinstance(it.notes, str):
            notes_json = json.dumps(it.notes)
        else:
            notes_json = "[]"
        values.append(
            (
                corpus_source_id,
                corpus,
                it.id,
                book_level,
                entry_type,
                it.theme,
                it.subsection,
                it.audio_track,
                it.source_book,
                it.source_pages,
                it.korean,
                it.english,
                it.pronunciation,
                it.hanja,
                it.japanese,
                it.part_of_speech,
                it.case_marker,
                it.irregular_class,
                it.example_korean,
                it.example_english,
                it.passive_form,
                it.causative_form,
                it.basic_form,
                it.honorific_form,
                it.humble_form,
                it.contracted_form,
                json.dumps(it.tips),
                json.dumps(it.cross_refs),
                notes_json,
                prof,
                it.domain,
            )
        )
    async with conn.cursor() as cur:
        await cur.executemany(
            """
            INSERT INTO vocab_entries (
                corpus_source_id, corpus, source_id, book_level,
                entry_type, theme, subsection, audio_track, source_book, source_pages,
                korean, english, pronunciation, hanja, japanese, part_of_speech,
                case_marker, irregular_class,
                example_korean, example_english,
                passive_form, causative_form, basic_form,
                honorific_form, humble_form, contracted_form,
                tips, cross_refs, notes, proficiency, domain)
            VALUES (
                %s, %s::corpus, %s, %s::book_level,
                %s::vocab_entry_type, %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s, %s,
                %s, %s,
                %s, %s,
                %s, %s, %s,
                %s, %s, %s,
                %s::jsonb, %s::jsonb, %s::jsonb,
                %s::proficiency_level, %s::content_domain)
            ON CONFLICT (corpus, source_id) DO UPDATE
              SET entry_type      = EXCLUDED.entry_type,
                  theme           = EXCLUDED.theme,
                  subsection      = EXCLUDED.subsection,
                  audio_track     = EXCLUDED.audio_track,
                  source_pages    = EXCLUDED.source_pages,
                  korean          = EXCLUDED.korean,
                  english         = EXCLUDED.english,
                  pronunciation   = EXCLUDED.pronunciation,
                  hanja           = EXCLUDED.hanja,
                  japanese        = EXCLUDED.japanese,
                  part_of_speech  = EXCLUDED.part_of_speech,
                  case_marker     = EXCLUDED.case_marker,
                  irregular_class = EXCLUDED.irregular_class,
                  example_korean  = EXCLUDED.example_korean,
                  example_english = EXCLUDED.example_english,
                  passive_form    = EXCLUDED.passive_form,
                  causative_form  = EXCLUDED.causative_form,
                  basic_form      = EXCLUDED.basic_form,
                  honorific_form  = EXCLUDED.honorific_form,
                  humble_form     = EXCLUDED.humble_form,
                  contracted_form = EXCLUDED.contracted_form,
                  tips            = EXCLUDED.tips,
                  cross_refs      = EXCLUDED.cross_refs,
                  notes           = EXCLUDED.notes,
                  proficiency     = EXCLUDED.proficiency,
                  domain          = EXCLUDED.domain,
                  version         = vocab_entries.version + 1
            """,
            values,
        )
