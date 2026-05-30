"""
Hanja corpus loader.

Writes the reproducible ``hanja.json`` build (``tools/ingest/build_hanja.py``)
into the migration-016 tables:

  * ``hanja_characters``  — one row per Korean hanja (upserted ``ON CONFLICT
    (char)`` — idempotent reload, retire-by-overwrite).
  * ``hanja_compounds``   — words containing each character (replaced wholesale
    per character on every reload: delete-then-insert keyed on ``character_id``,
    so a word dropped from the source disappears instead of lingering).

The corpus enum value is ``hanja`` (added by migration 016). The loader reuses
the shared ``upsert_corpus_source`` / checkpoint helpers, both of which cast the
corpus name ``::corpus`` — hence the enum value must exist before this runs.

Offline: reads only the committed ``hanja.json`` (no network). The build script
fetches Unihan; this loader does not.

Source-shape gaps (v1, intentional): ``gloss_kr`` (훈) and ``etymology`` have no
primary source and arrive as ``""``. We store them verbatim (the schema makes
both columns nullable; an empty string is a valid, distinct "known-empty" value
and round-trips to the client's ``''`` default).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import structlog
from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel, ConfigDict, Field

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

# The corpus enum value (migration 016) + the canonical source_path the
# orchestrator discovers. One file, one corpus.
_CORPUS = "hanja"


# ---------------------------------------------------------------------------
# Source models — the hanja.json shape (see build_hanja.py).
#
# Tolerant base (mirrors loaders/models.py StrictBase): ignore extra keys so a
# future build that adds metadata does not break the loader.
# ---------------------------------------------------------------------------


class _HanjaBase(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)


class HanjaCompoundModel(_HanjaBase):
    kr: str
    han: str
    en: str | None = None
    with_chars: str = Field(alias="with")


class HanjaCharacterModel(_HanjaBase):
    char: str
    sound: str
    gloss_kr: str = ""
    gloss_en: str
    strokes: int
    frequency: int = 0
    level: str
    etymology: str = ""
    compounds: list[HanjaCompoundModel] = Field(default_factory=list)


class HanjaSourceModel(_HanjaBase):
    corpus: str = _CORPUS
    built_by: str | None = None
    method: str | None = None
    scope: str | None = None
    gaps: str | None = None


class HanjaDocumentModel(_HanjaBase):
    source: HanjaSourceModel
    characters: list[HanjaCharacterModel]


async def load(pool: AsyncConnectionPool, source_path: Path, cfg: LoaderConfig) -> dict:
    """Load ``hanja.json`` into hanja_characters + hanja_compounds.

    Idempotent: characters upsert ``ON CONFLICT (char)``; each character's
    compounds are replaced wholesale (delete-by-character_id then insert) so a
    re-run converges on exactly the source's contents. Checkpoints per batch so a
    crashed run resumes from the last committed character.

    Returns a result dict (loaded / skipped / expected / actual / status).
    Raises on any failure (after marking the load_state row ``failed``).
    """
    raw = source_path.read_bytes()
    doc = HanjaDocumentModel.model_validate_json(raw)
    sha = sha256_of_file(source_path)
    total_items = len(doc.characters)

    log = logger.bind(corpus=_CORPUS, source_path=str(source_path))

    async with pool.connection() as conn:
        async with conn.transaction():
            cp = await get_or_create_checkpoint(
                conn, corpus=_CORPUS, source_path=str(source_path)
            )
            if cp.status == "complete" and cp.source_sha256 == sha and not cfg.force:
                log.info("skip_complete", sha256=sha)
                return {"loaded": 0, "skipped": total_items, "status": "skipped"}
            await mark_in_progress(
                conn,
                corpus=_CORPUS,
                source_path=str(source_path),
                source_sha256=sha,
                items_in_source=total_items,
            )
            # Catalog the source in corpus_sources for provenance. hanja's
            # downstream tables (hanja_characters/_compounds) do NOT carry a
            # corpus_source_id FK — they are shared reference data identified by
            # the natural `char` key, not fanned out per source — so we record
            # the catalog row for its side effect and discard the returned id.
            await upsert_corpus_source(
                conn,
                corpus=_CORPUS,
                # The hanja corpus has no printed book; describe its provenance.
                title="Hanja (vocab-grounded + Unihan enrichment)",
                publisher=None,
                authors=None,
                # Spans multiple levels (L2..L4 today) — no single book_level.
                level=None,
                # No single proficiency band — characters carry their own tier.
                default_proficiency=None,
                extracted_by=doc.source.built_by,
                extracted_at=None,
                source_path=str(source_path),
                source_sha256=sha,
                item_count=total_items,
                notes=doc.source.gaps,
            )

        loaded_running = 0
        skipped_running = 0
        try:
            # Sort by `char` for a stable, resumable order (last_item_id is the
            # char string; a batch resumes by skipping chars <= the checkpoint).
            chars_sorted = sorted(doc.characters, key=lambda c: c.char)
            for batch in batched(chars_sorted, cfg.batch_size):
                if cp.status == "in_progress" and cp.last_item_id:
                    original_size = len(batch)
                    batch = [c for c in batch if c.char > cp.last_item_id]
                    if not batch:
                        skipped_running += original_size
                        continue

                async with pool.connection() as conn:
                    async with conn.transaction():
                        await _upsert_character_batch(conn, batch=batch)
                        last_char = batch[-1].char
                        await checkpoint_progress(
                            conn,
                            corpus=_CORPUS,
                            source_path=str(source_path),
                            last_item_id=last_char,
                            items_loaded_delta=len(batch),
                        )
                loaded_running += len(batch)
                log.info(
                    "characters_batch_loaded",
                    batch_size=len(batch),
                    total_loaded=loaded_running,
                )

            async with pool.connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute("SELECT COUNT(*)::int FROM hanja_characters")
                    row = await cur.fetchone()
                    actual = int(row[0]) if row else 0
            if actual != total_items:
                # A reload can legitimately leave MORE rows than this source has
                # (an earlier build with extra characters); warn rather than fail.
                log.warning(
                    "count_assertion_mismatch", expected=total_items, actual=actual
                )

            async with pool.connection() as conn:
                async with conn.transaction():
                    await mark_complete(
                        conn, corpus=_CORPUS, source_path=str(source_path)
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
            async with pool.connection() as conn:
                async with conn.transaction():
                    await mark_failed(
                        conn,
                        corpus=_CORPUS,
                        source_path=str(source_path),
                        error=repr(err),
                    )
            raise


async def _upsert_character_batch(
    conn: AsyncConnection,
    *,
    batch: list[HanjaCharacterModel],
) -> None:
    """Upsert a batch of characters, then replace each one's compounds.

    Runs inside the caller's transaction. Two phases:

      1. Upsert every character ``ON CONFLICT (char) DO UPDATE`` and capture the
         resulting (char -> id) mapping via RETURNING.
      2. Delete the compounds of exactly those character ids, then re-insert from
         the source. Delete-then-insert (rather than per-row upsert) guarantees a
         word removed from a character in a new build is removed from the DB too,
         not merely left stale — the source is the single source of truth.
    """
    if not batch:
        return

    char_values: list[tuple[Any, ...]] = [
        (
            c.char,
            c.sound,
            c.gloss_kr,
            c.gloss_en,
            c.strokes,
            c.frequency,
            c.level,
            c.etymology,
        )
        for c in batch
    ]

    char_id_by_char: dict[str, int] = {}
    async with conn.cursor() as cur:
        # executemany cannot RETURNING-collect across rows portably, so upsert
        # one character at a time and read back its id. The batch is small
        # (default 200) and this runs inside one transaction, so the round-trips
        # are cheap relative to the correctness of having the id for compounds.
        for values in char_values:
            await cur.execute(
                """
                INSERT INTO hanja_characters (
                    char, sound, gloss_kr, gloss_en, strokes, frequency, level, etymology)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (char) DO UPDATE
                  SET sound     = EXCLUDED.sound,
                      gloss_kr  = EXCLUDED.gloss_kr,
                      gloss_en  = EXCLUDED.gloss_en,
                      strokes   = EXCLUDED.strokes,
                      frequency = EXCLUDED.frequency,
                      level     = EXCLUDED.level,
                      etymology = EXCLUDED.etymology,
                      version   = hanja_characters.version + 1
                RETURNING id, char
                """,
                values,
            )
            row = await cur.fetchone()
            assert row is not None, "upsert ... RETURNING must return a row"
            char_id_by_char[str(row[1])] = int(row[0])

        # Phase 2: replace compounds for exactly the characters in this batch.
        character_ids = list(char_id_by_char.values())
        await cur.execute(
            "DELETE FROM hanja_compounds WHERE character_id = ANY(%s)",
            (character_ids,),
        )

        compound_values: list[tuple[Any, ...]] = []
        for c in batch:
            character_id = char_id_by_char[c.char]
            seen_words: set[str] = set()
            for comp in c.compounds:
                # The (character_id, word_kr) UNIQUE means a source that lists the
                # same word twice for one character would fail the batch insert.
                # Dedup defensively (keep the first) — the build should not emit
                # dups, but the loader must not be brittle to a bad source row.
                if comp.kr in seen_words:
                    continue
                seen_words.add(comp.kr)
                compound_values.append(
                    (character_id, comp.kr, comp.han, comp.en, comp.with_chars)
                )

        if compound_values:
            await cur.executemany(
                """
                INSERT INTO hanja_compounds (
                    character_id, word_kr, word_hanja, gloss_en, with_chars)
                VALUES (%s, %s, %s, %s, %s)
                """,
                compound_values,
            )
