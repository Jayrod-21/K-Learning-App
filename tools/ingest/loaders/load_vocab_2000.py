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
    "advanced": "vocab_2000_advanced",
}

# Terminal per-row proficiency fallback when BOTH the row value and the source
# header's default_proficiency fail to normalize. Level-aware: the extraction
# guide (docs/_vocab_extraction_guide.md §"Proficiency tagging") defines the
# Beginner book's default as "basic" and the Intermediate book's as "L3" — a
# flat "L3" fallback would mis-tag Beginner words into the intermediate SRS
# queue.
_LEVEL_TO_FALLBACK_PROFICIENCY = {
    "beginner": "basic",
    "intermediate": "L3",
    # Advanced book default (the 2000-series Advanced volume). Mirrors the
    # advanced extraction guide's "L4 default, bump to L5+ when marked" — a flat
    # L3 fallback would mis-tag advanced words into the intermediate SRS queue.
    "advanced": "L4",
}


class CountAssertionError(RuntimeError):
    """Raised when the post-load ``vocab_entries`` row count for a file does not
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
        # Process in source-id order so resume-via-last_item_id is well-defined.
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
                        source_upload_id=doc.source.source_upload_id,
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
            # Fail loud (ADR-019 D8): do NOT mark_complete. Raising routes to the
            # except below, which records the source ``failed`` so the drift is
            # visible and the file is retried (not silently skipped) next run. A
            # mismatch here means real data loss — typically duplicate source_ids
            # in one file collapsing under the ON CONFLICT (corpus, source_id)
            # upsert, or a batch that failed to insert.
            raise CountAssertionError(
                f"vocab-2000 {corpus} {source_path.name}: expected {total_items} rows, "
                f"loaded {actual} (duplicate source_ids or a dropped batch?)"
            )

        async with pool.connection() as conn:
            async with conn.transaction():
                await mark_complete(conn, corpus=corpus, source_path=str(source_path))
                # U2: when this document was extracted from an uploaded book,
                # flip that upload processing -> ready now that its content is
                # loaded (atomic with mark_complete). Idempotent: re-running a
                # completed load re-asserts 'ready'. Guarded so the pre-existing
                # beginner/intermediate corpus files (no upload) are untouched.
                if doc.source.source_upload_id is not None:
                    async with conn.cursor() as cur:
                        await cur.execute(
                            "UPDATE book_uploads "
                            "SET status = 'ready'::book_upload_status "
                            "WHERE id = %s",
                            (doc.source.source_upload_id,),
                        )
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


# Must mirror the Postgres enum ``vocab_entry_type`` exactly (migration 002 +
# 028's lets_check/hanja_extension additions). A value outside this set would
# fail the ``%s::vocab_entry_type`` cast with an opaque batch-level Postgres
# error — the pre-check below fails loud with the offending source_id instead.
_VALID_ENTRY_TYPES = {
    "word",
    "theme_intro",
    "subsection_intro",
    "reference",
    "lets_check",  # "Let's Check" review/exercise pages (non-word section)
    "hanja_extension",  # hanja supplement sections (non-word section)
}

# Must mirror the Postgres enum ``content_domain`` (migration 002).
# VocabItemModel.domain is a free string defaulting to "general" (the vocab
# extraction guide never asks OCR to emit a domain), so an off-enum value can
# only come from OCR drift — same 500-class failure as the grammar Bank
# category bug. Pre-check so the error names the row, not just the batch.
_VALID_DOMAINS = {"general", "research", "business"}


async def _insert_item_batch(
    conn,
    *,
    corpus: str,
    corpus_source_id: int,
    book_level: str,
    default_proficiency: str | None,
    source_upload_id: int | None,
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
        # Same fail-loud rationale for `domain`: an off-enum value would fail
        # the ``%s::content_domain`` cast batch-wide with no row context.
        if it.domain not in _VALID_DOMAINS:
            logger.error(
                "vocab_2000_unknown_domain",
                source_id=it.id,
                received_domain=it.domain,
                valid_domains=sorted(_VALID_DOMAINS),
            )
            raise MalformedEntryError(
                f"vocab-2000 entry {it.id!r} has unknown domain {it.domain!r}; "
                f"expected one of {sorted(_VALID_DOMAINS)}"
            )
        entry_type = it.type
        # ck_vocab_entries_korean_required: word rows must carry a headword.
        # VocabItemModel.korean is Optional (OCR output), so pre-check here —
        # otherwise the CHECK rejects the whole batch with an error that names
        # no row. An empty/whitespace-only headword would pass the DB CHECK
        # but is equally useless to the SRS queue, so treat it as missing too
        # (str_strip_whitespace on the model already collapsed whitespace).
        if entry_type == "word" and not it.korean:
            logger.error(
                "vocab_2000_word_missing_korean",
                source_id=it.id,
                received_korean=it.korean,
            )
            raise MalformedEntryError(
                f"vocab-2000 word entry {it.id!r} is missing its Korean headword "
                f"(korean={it.korean!r}); ck_vocab_entries_korean_required forbids it"
            )
        # Word rows require non-NULL proficiency by schema
        # (ck_vocab_entries_proficiency_required). Source default can be
        # ambiguous ("L3/L4"); the normalizer resolves that. Terminal fallback
        # is level-aware (beginner→basic, intermediate→L3 per the extraction
        # guide) so a garbage source default can't mis-tag a whole book.
        prof = normalize_proficiency(it.proficiency)
        if entry_type == "word" and prof is None:
            prof = default_proficiency or _LEVEL_TO_FALLBACK_PROFICIENCY.get(
                book_level, "L3"
            )
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
                source_upload_id,
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
                tips, cross_refs, notes, proficiency, domain, source_upload_id)
            VALUES (
                %s, %s::corpus, %s, %s::book_level,
                %s::vocab_entry_type, %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s, %s,
                %s, %s,
                %s, %s,
                %s, %s, %s,
                %s, %s, %s,
                %s::jsonb, %s::jsonb, %s::jsonb,
                %s::proficiency_level, %s::content_domain, %s)
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
                  source_upload_id = EXCLUDED.source_upload_id,
                  version         = vocab_entries.version + 1
            """,
            values,
        )
