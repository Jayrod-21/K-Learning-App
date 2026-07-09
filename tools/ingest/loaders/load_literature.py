"""
Literature chapter+passage loader (U3b, digitized chapter reader).

Writes to ``reading_chapters`` + ``reading_passages`` (migration 044) for
exactly ONE uploaded book per invocation. See
``db/docs/U3_READER_DESIGN.md`` §U3b and
``tools/ingest/docs/_literature_extraction_guide.md`` for the curated-JSON
contract; ``tools/ingest/loaders/models.py`` for the Pydantic models.

WHY THIS LOADER DOES NOT USE ``load_state`` (unlike every sibling in this
package): ADR-019's checkpoint/resume machinery is keyed on the ``corpus``
Postgres enum, and there is no ``corpus`` value for literature — a book is
not one of a handful of curated corpus files, it is the digitized text of a
single ``book_uploads`` row, addressed by ``source_upload_id``. There is
also no ``corpus_sources``-style catalog row: ``reading_chapters`` rows
themselves ARE the catalog. Idempotency is therefore STRUCTURAL rather than
checkpoint-based: the whole load runs in ONE transaction that deletes the
upload's existing chapters (CASCADEs to their passages via
``fk_reading_passages_chapter``) and re-inserts from the source, so re-running
the same (or an updated) curated JSON always converges on exactly its
contents — "test-then-keep", the same idempotency contract the migration's
own comment documents for ``uq_reading_chapters_upload_number``. A crash
mid-load rolls back to the PRIOR complete state rather than leaving a
half-loaded book, because nothing commits until the final ``COMMIT``.

SECURITY — ownership cannot be forged from the source JSON:
  * ``reading_chapters.user_id`` is NEVER read from the curated JSON. The
    loader resolves it by looking up ``book_uploads.user_id WHERE id =
    source.source_upload_id`` (``_resolve_owner``) and uses THAT value. Even
    if a malicious or buggy curation pass put a ``user_id`` in the JSON, this
    loader has no field that would read it.
  * The composite FK ``fk_reading_chapters_upload_owner`` (migration 044)
    makes a mismatched (source_upload_id, user_id) pair structurally
    impossible to insert — this loader's resolve-then-insert is defense in
    depth on top of that DB-level guarantee, not a substitute for it.
  * The upload must be ``type = 'literature'`` — a vocab/grammar/dialogue
    upload is rejected loudly (``SourceUploadNotFoundError``) rather than
    silently accepting chapters onto the wrong kind of book.
  * All values are bound via psycopg ``%s`` placeholders; no source-JSON
    string is ever concatenated into SQL (same defense as every other loader
    in this tree — see ``LOADERS_SECURITY.md`` §1).
  * Content lengths are checked against the exact DB CHECK bounds
    (``ck_reading_passages_body_len`` 1..20000, ``ck_reading_chapters_title_len``
    1..500) BEFORE any write, so a malformed OCR pass fails with a message
    naming the offending chapter/passage instead of an opaque batch-level
    Postgres error.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path
from typing import Any

import structlog
from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool

from .models import LiteratureChapterModel, LiteratureDocumentModel
from .runtime import (
    LoaderConfig,
    MalformedEntryError,
    config_from_env,
    configure_logging,
    open_pool,
    sha256_of_file,
)

logger = structlog.get_logger(__name__)


class SourceUploadNotFoundError(RuntimeError):
    """Raised when ``source.source_upload_id`` has no matching ``book_uploads``
    row, or that row is not ``type = 'literature'``.

    Fail loud rather than attempting the insert and letting the composite FK
    reject it — that would surface as an opaque FK-violation deep inside
    ``_replace_chapters`` instead of an operator-legible message naming the
    upload id and the reason.
    """


class CountAssertionError(RuntimeError):
    """Raised when the post-load ``reading_chapters``/``reading_passages`` row
    counts for this upload don't match the source document's counts.

    Mirrors ``load_vocab_2000.CountAssertionError`` (ADR-019 §D8): fail loud
    on drift rather than flip the upload to ``ready`` over a partial load.
    Because this loader replaces via DELETE-then-INSERT rather than an
    ``ON CONFLICT`` upsert (which can silently collapse two source rows
    sharing a key), a genuine duplicate ``chapter_number``/``passage_number``
    is caught earlier by ``_validate_document`` or by the UNIQUE constraint
    itself — this check is primarily defense in depth.
    """


async def load(pool: AsyncConnectionPool, source_path: Path, cfg: LoaderConfig) -> dict:
    """Load one curated literature JSON into reading_chapters/reading_passages.

    Idempotent + re-runnable: replaces the source upload's chapters/passages
    wholesale inside a single transaction. Raises on any failure (after
    attempting to flip the source ``book_uploads`` row to ``failed`` for
    operator visibility in the Uploads UI).
    """
    log = logger.bind(source_path=str(source_path))
    # Stays None until the JSON parses far enough to know it — lets the
    # except block below tell "never got far enough to know the upload id"
    # (bad JSON / failed Pydantic validation) from "we know it, and the load
    # itself failed" (same pattern as load_vocab_2000's `corpus` sentinel).
    source_upload_id: int | None = None
    try:
        raw = source_path.read_bytes()
        doc = LiteratureDocumentModel.model_validate_json(raw)
        sha = sha256_of_file(source_path)
        source_upload_id = doc.source.source_upload_id
        log = logger.bind(
            source_path=str(source_path),
            source_upload_id=source_upload_id,
            sha256=sha,
        )

        _validate_document(doc)

        total_chapters = len(doc.chapters)
        total_passages = sum(len(c.passages) for c in doc.chapters)
        log.info(
            "literature_load_start", chapters=total_chapters, passages=total_passages
        )

        async with pool.connection() as conn:
            async with conn.transaction():
                user_id = await _resolve_owner(
                    conn, source_upload_id=source_upload_id
                )
                await _replace_chapters(
                    conn,
                    source_upload_id=source_upload_id,
                    user_id=user_id,
                    chapters=doc.chapters,
                )
                actual_chapters, actual_passages = await _count_loaded(
                    conn, source_upload_id=source_upload_id
                )
                if (
                    actual_chapters != total_chapters
                    or actual_passages != total_passages
                ):
                    raise CountAssertionError(
                        f"literature {source_path.name} (upload "
                        f"{source_upload_id}): expected {total_chapters} "
                        f"chapters / {total_passages} passages, loaded "
                        f"{actual_chapters} / {actual_passages}"
                    )
                await _mark_upload_status(
                    conn, source_upload_id=source_upload_id, status="ready"
                )

        log.info(
            "literature_load_complete",
            chapters=actual_chapters,
            passages=actual_passages,
        )
        return {
            "status": "complete",
            "source_upload_id": source_upload_id,
            "user_id": user_id,
            "chapters": actual_chapters,
            "passages": actual_passages,
        }
    except Exception as err:
        log.error("loader_failed", error=str(err))
        # Record the failure on the upload row itself (there is no load_state
        # to write under — see module docstring) so an operator sees it in
        # the Uploads UI. Runs in its OWN transaction, after the load's
        # transaction has already rolled back. Guarded so a secondary
        # failure here (e.g. the upload vanished mid-run) cannot mask the
        # original error.
        if source_upload_id is not None:
            try:
                async with pool.connection() as conn:
                    async with conn.transaction():
                        await _mark_upload_status(
                            conn, source_upload_id=source_upload_id, status="failed"
                        )
            except Exception as rec_err:
                log.error("failed_to_record_failure", error=str(rec_err))
        raise


def _validate_document(doc: LiteratureDocumentModel) -> None:
    """Fail-loud structural checks the DB CHECK/UNIQUE constraints would
    otherwise reject with no row context (mirrors load_vocab_2000's per-item
    pre-checks in ``_insert_item_batch``). Runs BEFORE any DB write.
    """
    seen_chapter_numbers: set[int] = set()
    for chapter in doc.chapters:
        if chapter.chapter_number <= 0:
            raise MalformedEntryError(
                f"literature chapter_number {chapter.chapter_number} must be "
                "> 0 (ck_reading_chapters_number_positive)"
            )
        if chapter.chapter_number in seen_chapter_numbers:
            raise MalformedEntryError(
                f"literature chapter_number {chapter.chapter_number} is "
                "duplicated in this document — "
                "uq_reading_chapters_upload_number requires a unique "
                "chapter_number per book"
            )
        seen_chapter_numbers.add(chapter.chapter_number)

        if chapter.title is not None and not (1 <= len(chapter.title) <= 500):
            raise MalformedEntryError(
                f"literature chapter {chapter.chapter_number}: title length "
                f"{len(chapter.title)} outside 1..500 "
                "(ck_reading_chapters_title_len)"
            )
        if chapter.start_page is not None and chapter.start_page <= 0:
            raise MalformedEntryError(
                f"literature chapter {chapter.chapter_number}: start_page "
                f"{chapter.start_page} must be > 0 "
                "(ck_reading_chapters_start_page_positive)"
            )
        if chapter.end_page is not None and chapter.end_page <= 0:
            raise MalformedEntryError(
                f"literature chapter {chapter.chapter_number}: end_page "
                f"{chapter.end_page} must be > 0 "
                "(ck_reading_chapters_end_page_positive)"
            )
        if (
            chapter.start_page is not None
            and chapter.end_page is not None
            and chapter.end_page < chapter.start_page
        ):
            raise MalformedEntryError(
                f"literature chapter {chapter.chapter_number}: end_page "
                f"{chapter.end_page} < start_page {chapter.start_page} "
                "(ck_reading_chapters_page_span)"
            )

        seen_passage_numbers: set[int] = set()
        for passage in chapter.passages:
            if passage.passage_number <= 0:
                raise MalformedEntryError(
                    f"literature chapter {chapter.chapter_number} passage "
                    f"{passage.passage_number} must be > 0 "
                    "(ck_reading_passages_number_positive)"
                )
            if passage.passage_number in seen_passage_numbers:
                raise MalformedEntryError(
                    f"literature chapter {chapter.chapter_number}: "
                    f"passage_number {passage.passage_number} is duplicated "
                    "— uq_reading_passages_chapter_number requires a unique "
                    "passage_number per chapter"
                )
            seen_passage_numbers.add(passage.passage_number)

            body_len = len(passage.body)
            if not (1 <= body_len <= 20000):
                raise MalformedEntryError(
                    f"literature chapter {chapter.chapter_number} passage "
                    f"{passage.passage_number}: body length {body_len} "
                    "outside 1..20000 (ck_reading_passages_body_len)"
                )
            if passage.page_number is not None and passage.page_number <= 0:
                raise MalformedEntryError(
                    f"literature chapter {chapter.chapter_number} passage "
                    f"{passage.passage_number}: page_number "
                    f"{passage.page_number} must be > 0 "
                    "(ck_reading_passages_page_number_positive)"
                )


async def _resolve_owner(conn: AsyncConnection, *, source_upload_id: int) -> int:
    """Resolve the owning ``user_id`` for ``source_upload_id`` and verify it is
    a ``'literature'`` upload. Locks the row (``FOR UPDATE``) for the rest of
    this transaction so a concurrent delete of the upload can't race the
    chapter insert underneath us — turns that into a clean wait/abort instead
    of a surprising FK-violation deep in ``_replace_chapters``.

    ``user_id`` is NEVER accepted from the source JSON — see module
    docstring's security note.
    """
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT user_id, type::text FROM book_uploads WHERE id = %s FOR UPDATE",
            (source_upload_id,),
        )
        row = await cur.fetchone()
    if row is None:
        raise SourceUploadNotFoundError(
            f"book_uploads row {source_upload_id} does not exist — cannot "
            "load literature chapters without a source upload to own them"
        )
    user_id, upload_type = row
    if upload_type != "literature":
        raise SourceUploadNotFoundError(
            f"book_uploads row {source_upload_id} has type={upload_type!r}, "
            "expected 'literature' — refusing to load chapters onto a "
            "vocab/grammar/dialogue/both upload"
        )
    return int(user_id)


async def _replace_chapters(
    conn: AsyncConnection,
    *,
    source_upload_id: int,
    user_id: int,
    chapters: list[LiteratureChapterModel],
) -> None:
    """DELETE this upload's existing chapters (CASCADEs to their passages via
    ``fk_reading_passages_chapter``) then INSERT fresh from the source.

    Delete-then-insert, not upsert: a chapter or passage dropped from a
    re-extraction disappears from the DB too, rather than lingering — the
    curated JSON is the single source of truth for a book's chapters (same
    rationale as ``load_hanja.py``'s compound replacement). Runs entirely
    inside the caller's transaction.
    """
    async with conn.cursor() as cur:
        await cur.execute(
            "DELETE FROM reading_chapters WHERE source_upload_id = %s",
            (source_upload_id,),
        )
        for chapter in chapters:
            await cur.execute(
                """
                INSERT INTO reading_chapters (
                    source_upload_id, user_id, chapter_number, title,
                    start_page, end_page)
                VALUES (%s, %s, %s, %s, %s, %s)
                RETURNING id
                """,
                (
                    source_upload_id,
                    user_id,
                    chapter.chapter_number,
                    chapter.title,
                    chapter.start_page,
                    chapter.end_page,
                ),
            )
            row = await cur.fetchone()
            assert row is not None, "INSERT ... RETURNING must return a row"
            chapter_id = int(row[0])

            if not chapter.passages:
                continue
            passage_values: list[tuple[Any, ...]] = [
                (chapter_id, p.passage_number, p.body, p.page_number)
                for p in chapter.passages
            ]
            await cur.executemany(
                """
                INSERT INTO reading_passages (
                    chapter_id, passage_number, body, page_number)
                VALUES (%s, %s, %s, %s)
                """,
                passage_values,
            )


async def _count_loaded(
    conn: AsyncConnection, *, source_upload_id: int
) -> tuple[int, int]:
    """Return (chapter_count, passage_count) currently stored for this upload."""
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT COUNT(*)::int FROM reading_chapters WHERE source_upload_id = %s",
            (source_upload_id,),
        )
        row = await cur.fetchone()
        chapters = int(row[0]) if row else 0

        await cur.execute(
            """
            SELECT COUNT(*)::int FROM reading_passages rp
            JOIN reading_chapters rc ON rc.id = rp.chapter_id
            WHERE rc.source_upload_id = %s
            """,
            (source_upload_id,),
        )
        row = await cur.fetchone()
        passages = int(row[0]) if row else 0
    return chapters, passages


async def _mark_upload_status(
    conn: AsyncConnection, *, source_upload_id: int, status: str
) -> None:
    if status not in ("ready", "failed"):
        raise ValueError(f"unexpected book_upload_status {status!r}")
    async with conn.cursor() as cur:
        await cur.execute(
            "UPDATE book_uploads SET status = %s::book_upload_status WHERE id = %s",
            (status, source_upload_id),
        )


# ---------------------------------------------------------------------------
# Standalone CLI
#
# Deliberately NOT wired into load_to_postgres.py's ALL_CORPORA dispatch —
# that orchestrator globs a fixed set of shared corpus files by a `corpus`
# enum name (ADR-019 §D1). Literature has neither: each JSON is one
# operator-chosen book, addressed by source_upload_id, produced ad hoc by a
# subscription Claude-Code OCR/curation pass (see the extraction guide). A
# small standalone CLI — mirroring load_krdict.py's pattern — fits that
# one-book-at-a-time workflow better than forcing it through the
# glob-and-dispatch orchestrator.
# ---------------------------------------------------------------------------


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=(
            "Load a curated literature JSON (chapters + passages) into "
            "reading_chapters / reading_passages for its source book_uploads "
            "row. See tools/ingest/docs/_literature_extraction_guide.md."
        )
    )
    p.add_argument("source", type=Path, help="Path to the curated literature JSON.")
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse + validate only. No DB connection, no writes.",
    )
    p.add_argument(
        "--log-level", default="info", choices=("debug", "info", "warning", "error")
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    configure_logging(args.log_level)

    if args.dry_run:
        # No DB connection at all for --dry-run — lets a curator validate a
        # freshly-produced JSON before any Postgres access is configured.
        try:
            raw = args.source.read_bytes()
            doc = LiteratureDocumentModel.model_validate_json(raw)
            _validate_document(doc)
        except Exception as err:
            logger.error("literature_dry_run_failed", error=str(err))
            return 1
        logger.info(
            "literature_dry_run_ok",
            source_upload_id=doc.source.source_upload_id,
            chapters=len(doc.chapters),
            passages=sum(len(c.passages) for c in doc.chapters),
        )
        return 0

    base = config_from_env()
    cfg = LoaderConfig(database_url=base.database_url)

    async def _run() -> dict:
        async with open_pool(cfg) as pool:
            return await load(pool, args.source, cfg)

    try:
        result = asyncio.run(_run())
    except Exception as err:
        logger.error("literature_loader_failed", error=str(err))
        return 1
    logger.info("literature_loader_done", **result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
