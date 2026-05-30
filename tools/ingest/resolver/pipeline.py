"""
Resolver pipeline — orchestrates one corpus from start to finish.

Stages: enumerate source entries → extract refs → normalize → resolve → write.

WHY split into a pipeline class instead of one big function: each stage is
independently testable, the pipeline composes them with explicit boundaries,
and the BrokenRefReport accumulator is a single place to add broken refs
without threading a list through every layer.

The pipeline is "soft-async" — it runs inside a single connection from the
pool. Throughput is dominated by extraction/normalization (CPU), not DB I/O,
so multi-connection concurrency would mostly buy contention. If we ever need
more throughput we can shard at the corpus level (one task per corpus).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import structlog
from psycopg_pool import AsyncConnectionPool

from .extractor import extract_kgiu_refs, extract_vocab_refs
from .lookup import LookupIndex, resolve
from .models import (
    KGIU_CORPORA,
    KGIU_RELATION_KINDS,
    VOCAB_CORPORA,
    VOCAB_RELATION_KINDS,
    BrokenRefRow,
    CorpusKind,
    RelationRow,
    ResolverCounters,
    corpus_kind,
)
from .normalize import normalize_target
from .writer import (
    checkpoint_resolver_progress,
    get_or_create_resolver_state,
    mark_resolver_complete,
    mark_resolver_failed,
    mark_resolver_in_progress,
    write_relations,
)

logger = structlog.get_logger(__name__)


_CORPUS_TO_JSON: dict[str, str] = {
    "kgiu_beginner": "grammar_kgiu_beginner.json",
    "kgiu_intermediate": "grammar_kgiu_intermediate.json",
    "kgiu_advanced": "grammar_kgiu_advanced.json",
    "vocab_2000_beginner": "vocab_2000_beginner.json",
    "vocab_2000_intermediate": "vocab_2000_intermediate.json",
}


class ResolverPrerequisiteError(RuntimeError):
    """Raised when the resolver is asked to run before the corpora are loaded."""


class ResolverConfig:
    """Tiny config object — pulled out so callers can override per-test."""

    def __init__(
        self,
        *,
        database_url: str,
        output_root: Path,
        dry_run: bool = False,
        resume: bool = False,
        batch_size: int = 100,
        application_name: str = "korean-master-resolver",
    ) -> None:
        self.database_url = database_url
        self.output_root = output_root
        self.dry_run = dry_run
        self.resume = resume
        self.batch_size = batch_size
        self.application_name = application_name


@dataclass
class _CorpusResult:
    corpus: str
    counters: ResolverCounters = field(default_factory=ResolverCounters)
    # Truly-broken refs (couldn't normalize, unsupported relation_kind,
    # self-reference). NOT a place to dump text-only successes — those are
    # legitimate DB rows that just lack an FK target.
    broken: list[BrokenRefRow] = field(default_factory=list)
    # Successful-but-unresolved refs (resolution_status='text_only') reported
    # alongside broken refs in the unresolved CSV so QA can see them, but
    # tracked separately so the broken counter isn't inflated. ADR-022 D2
    # ("counters: resolved | text_only | broken") is honoured by this split.
    text_only_reports: list[BrokenRefRow] = field(default_factory=list)


# -----------------------------------------------------------------------------
# Source-entry enumeration
# -----------------------------------------------------------------------------


def _load_source_json(path: Path) -> list[dict[str, Any]]:
    """Load and return `items[]` from a Darakwon JSON. Validates only the top shape."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"Expected object at {path}, got {type(raw).__name__}")
    items = raw.get("items")
    if not isinstance(items, list):
        raise ValueError(f"Expected items[] in {path}, got {type(items).__name__}")
    return items


async def _entry_id_to_db_id(
    conn, *, corpus: str
) -> dict[str, int]:
    """Build a {source_id: db_id} map for ONE corpus.

    We don't reuse the LookupIndex here — that one is built once across all
    corpora. This one maps source_ids back to DB ids for the corpus being
    processed (the resolver's "where do I attach this row?" need).
    """
    out: dict[str, int] = {}
    async with conn.cursor() as cur:
        if corpus in KGIU_CORPORA:
            await cur.execute(
                "SELECT source_id, id FROM kgiu_entries WHERE corpus = %s::corpus",
                (corpus,),
            )
        elif corpus in VOCAB_CORPORA:
            await cur.execute(
                "SELECT source_id, id FROM vocab_entries WHERE corpus = %s::corpus",
                (corpus,),
            )
        else:
            raise ValueError(f"Unknown corpus {corpus!r}")
        async for row in cur:
            out[str(row[0])] = int(row[1])
    return out


# -----------------------------------------------------------------------------
# Per-entry processing
# -----------------------------------------------------------------------------


def _process_entry(
    *,
    entry: dict[str, Any],
    source_corpus: str,
    source_entry_db_id: int,
    index: LookupIndex,
) -> tuple[list[RelationRow], list[BrokenRefRow], list[BrokenRefRow]]:
    """Pure function: extract → normalize → resolve → assemble RelationRow list.

    Returns ``(rows_to_write, broken_reports, text_only_reports)``.

    The three outputs are MUTUALLY EXCLUSIVE per ref. This is load-bearing:
    the counter-accounting in ``_flush_batch`` depends on it. Specifically:

      * ``rows_to_write`` — RelationRows that will be UPSERTed into the DB.
        Includes BOTH resolved (target_entry_id set) and text_only
        (target_entry_id NULL, target_korean populated) outcomes. Per
        ADR-022 D2 both are legitimate stored rows.
      * ``broken_reports`` — refs that were dropped entirely (unsupported
        relation_kind, self-reference, normalize failure). NO DB row was
        written for these. They appear only in the CSV report.
      * ``text_only_reports`` — refs that DID land in the DB as text_only
        rows but are surfaced in the CSV alongside broken ones so QA can
        triage. These are NOT counted in ``refs_broken`` — they're
        successful unresolved writes, tallied in ``refs_text_only``.

    Caller is responsible for writing the rows. The pre-fix bug was
    appending text-only refs to BOTH ``rows`` and ``broken``, which made
    ``len(rows) + len(broken)`` double-count them; the fix is to keep the
    text-only-report ledger separate and never derive counts from list
    lengths in ``_flush_batch``.
    """
    rows: list[RelationRow] = []
    broken: list[BrokenRefRow] = []
    text_only_reports: list[BrokenRefRow] = []

    kind = corpus_kind(source_corpus)
    if kind is CorpusKind.KGIU:
        raw_refs = extract_kgiu_refs(entry)
        allowed_kinds = KGIU_RELATION_KINDS
    else:
        raw_refs = extract_vocab_refs(entry)
        allowed_kinds = VOCAB_RELATION_KINDS

    for ref in raw_refs:
        if ref.relation_kind not in allowed_kinds:
            broken.append(
                BrokenRefRow(
                    source_corpus=source_corpus,
                    source_entry_id=source_entry_db_id,
                    source_pattern=_source_pattern(entry),
                    relation_type=ref.relation_kind,
                    target_text=ref.text,
                    reason=f"unsupported relation_kind for {kind.value}",
                )
            )
            continue

        norm = normalize_target(ref.text)
        outcome = resolve(
            norm,
            index=index,
            source_corpus=source_corpus,
            parsed_target_source_id=ref.parsed_target_source_id,
            fallback_page=ref.page,
        )

        # Don't write a self-loop — would violate ck_*_no_self. This is a
        # genuine drop (no DB row), so it belongs in `broken`.
        if outcome.target_entry_id == source_entry_db_id:
            broken.append(
                BrokenRefRow(
                    source_corpus=source_corpus,
                    source_entry_id=source_entry_db_id,
                    source_pattern=_source_pattern(entry),
                    relation_type=ref.relation_kind,
                    target_text=ref.text,
                    reason="self-reference; skipped",
                )
            )
            continue

        if outcome.status == "broken":
            broken.append(
                BrokenRefRow(
                    source_corpus=source_corpus,
                    source_entry_id=source_entry_db_id,
                    source_pattern=_source_pattern(entry),
                    relation_type=ref.relation_kind,
                    target_text=ref.text,
                    reason=outcome.reason or "normalize failed",
                )
            )
            continue

        # text_only AND resolved both produce a relation row written to DB.
        # We surface text_only in the report ledger but DO NOT mix it into
        # `broken` — keeping the two ledgers disjoint is what keeps the
        # counter contract honest.
        if outcome.status == "text_only":
            text_only_reports.append(
                BrokenRefRow(
                    source_corpus=source_corpus,
                    source_entry_id=source_entry_db_id,
                    source_pattern=_source_pattern(entry),
                    relation_type=ref.relation_kind,
                    target_text=norm.canonical if norm else ref.text,
                    reason=outcome.reason or "no matching entry",
                )
            )

        rows.append(
            RelationRow(
                source_entry_id=source_entry_db_id,
                source_corpus=source_corpus,
                relation_kind=ref.relation_kind,
                target_entry_id=outcome.target_entry_id,
                target_korean=(norm.canonical if norm else None) or ref.text,
                target_english=outcome.target_english or ref.english,
                target_page=outcome.target_page or ref.page,
                target_source_id=outcome.target_source_id,
                note=ref.note,
                resolution_status=outcome.status,
            )
        )

    return rows, broken, text_only_reports


def _source_pattern(entry: dict[str, Any]) -> str | None:
    """Return the user-facing label of an entry for logging."""
    return entry.get("pattern") or entry.get("korean") or entry.get("id")


# -----------------------------------------------------------------------------
# Per-corpus pipeline
# -----------------------------------------------------------------------------


async def _check_corpora_loaded(conn) -> set[str]:
    """Return the set of corpora that have at least one entry loaded.

    We need this before extracting refs — running the resolver against an
    empty corpus is almost always a misconfiguration (user forgot to run the
    loader). The CLI surfaces this with a clear error rather than producing
    an empty output and exiting 0.
    """
    loaded: set[str] = set()
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT DISTINCT corpus::text FROM kgiu_entries"
        )
        async for row in cur:
            loaded.add(str(row[0]))
        await cur.execute(
            "SELECT DISTINCT corpus::text FROM vocab_entries"
        )
        async for row in cur:
            loaded.add(str(row[0]))
    return loaded


async def run_one(
    pool: AsyncConnectionPool,
    *,
    corpus: str,
    index: LookupIndex,
    cfg: ResolverConfig,
) -> _CorpusResult:
    """Resolve cross-refs for one corpus."""
    log = logger.bind(corpus=corpus)

    source_json = cfg.output_root / _CORPUS_TO_JSON[corpus]
    if not source_json.exists():
        raise FileNotFoundError(f"Source JSON not found: {source_json}")
    items = _load_source_json(source_json)

    result = _CorpusResult(corpus=corpus)

    async with pool.connection() as conn:
        async with conn.transaction():
            await get_or_create_resolver_state(conn, corpus=corpus)
            await mark_resolver_in_progress(
                conn, corpus=corpus, reset_counters=not cfg.resume
            )
            state = await get_or_create_resolver_state(conn, corpus=corpus)

        # Build the source_id → db_id mapping for THIS corpus.
        async with pool.connection() as conn:
            id_map = await _entry_id_to_db_id(conn, corpus=corpus)
        log.info("entry_id_map_built", size=len(id_map))

        last_source_id = state["last_source_id"] if cfg.resume else None

        # Process in source_id-sorted order so the checkpoint cursor is monotone.
        items_sorted = sorted(items, key=lambda x: str(x.get("id") or ""))

        try:
            batch_rows: list[RelationRow] = []
            batch_broken: list[BrokenRefRow] = []
            batch_text_only_reports: list[BrokenRefRow] = []
            # batch_meta tracks (source_id, refs_extracted_for_this_entry)
            # where refs_extracted is the count of refs we actually attempted
            # to process — equals len(rows-for-this-entry) + len(broken-for-this-entry).
            # text_only refs are already counted inside rows (they are written),
            # so they MUST NOT be added separately.
            batch_meta: list[tuple[str, int]] = []

            for entry in items_sorted:
                source_id = str(entry.get("id") or "")
                if not source_id:
                    log.warning("entry_missing_id", entry_preview=str(entry)[:160])
                    continue

                # --resume: skip already-processed source_ids.
                if last_source_id and source_id <= last_source_id:
                    continue

                db_id = id_map.get(source_id)
                if db_id is None:
                    # The source JSON has an entry but the DB doesn't. Could be
                    # a navigational row the loader didn't write, or a stale
                    # JSON. Skip with a warning, don't crash.
                    log.warning(
                        "entry_in_json_not_in_db",
                        source_id=source_id,
                    )
                    continue

                rows, broken, text_only_reports = _process_entry(
                    entry=entry,
                    source_corpus=corpus,
                    source_entry_db_id=db_id,
                    index=index,
                )

                batch_rows.extend(rows)
                batch_broken.extend(broken)
                batch_text_only_reports.extend(text_only_reports)
                # entry-level refs_extracted = rows written + broken dropped.
                # text_only is a SUBSET of rows (resolution_status='text_only'),
                # so do NOT add len(text_only_reports) here — that would
                # double-count.
                batch_meta.append((source_id, len(rows) + len(broken)))

                if len(batch_meta) >= cfg.batch_size:
                    await _flush_batch(
                        pool,
                        corpus=corpus,
                        rows=batch_rows,
                        broken=batch_broken,
                        text_only_reports=batch_text_only_reports,
                        last_source_id=batch_meta[-1][0],
                        result=result,
                        dry_run=cfg.dry_run,
                    )
                    batch_rows.clear()
                    batch_broken.clear()
                    batch_text_only_reports.clear()
                    batch_meta.clear()

            if batch_meta:
                await _flush_batch(
                    pool,
                    corpus=corpus,
                    rows=batch_rows,
                    broken=batch_broken,
                    text_only_reports=batch_text_only_reports,
                    last_source_id=batch_meta[-1][0],
                    result=result,
                    dry_run=cfg.dry_run,
                )

            async with pool.connection() as conn:
                async with conn.transaction():
                    await mark_resolver_complete(conn, corpus=corpus)

        except Exception as err:
            log.error("resolver_failed", error=str(err))
            async with pool.connection() as conn:
                async with conn.transaction():
                    await mark_resolver_failed(
                        conn, corpus=corpus, error=repr(err)
                    )
            raise

    log.info(
        "corpus_complete",
        **result.counters.model_dump(),
        broken_count=len(result.broken),
    )
    return result


async def _flush_batch(
    pool: AsyncConnectionPool,
    *,
    corpus: str,
    rows: list[RelationRow],
    broken: list[BrokenRefRow],
    text_only_reports: list[BrokenRefRow],
    last_source_id: str,
    result: _CorpusResult,
    dry_run: bool,
) -> None:
    """Write one batch's rows + broken-ref tallies inside a single transaction.

    Counter accounting (load-bearing — see ADR-022 D2):

      * ``refs_resolved`` and ``refs_text_only`` partition ``rows`` by
        ``resolution_status``. ``rows`` contains BOTH outcomes.
      * ``refs_broken`` = ``len(broken)`` only. ``broken`` is disjoint
        from ``rows`` by construction in ``_process_entry`` (unsupported
        kind, self-reference, normalize failure — none of these became a
        DB row).
      * ``refs_extracted`` = ``resolved + text_only + broken`` — i.e.,
        every ref we attempted to process. The pre-fix bug computed it
        as ``len(rows) + len(broken)`` while ALSO appending text_only
        outcomes to ``broken`` — inflating the broken counter by every
        text_only and double-counting them in extracted.

    ``text_only_reports`` is a SUBSET-VIEW of the text_only rows for
    CSV reporting only; we extend the result ledger with it but never
    derive a counter from its length.
    """
    resolved = sum(1 for r in rows if r.resolution_status == "resolved")
    text_only = sum(1 for r in rows if r.resolution_status == "text_only")
    broken_count = len(broken)
    extracted = resolved + text_only + broken_count
    # Invariant: rows partitions into resolved + text_only (every row is
    # one or the other). If this assertion ever fires, _process_entry has
    # added a new resolution_status without updating the counters here.
    assert resolved + text_only == len(rows), (
        "RelationRow.resolution_status must be 'resolved' or 'text_only'; "
        f"saw {set(r.resolution_status for r in rows)}"
    )

    if dry_run:
        # No DB writes; update counters only.
        result.counters.refs_extracted += extracted
        result.counters.refs_resolved += resolved
        result.counters.refs_text_only += text_only
        result.counters.refs_broken += broken_count
        result.broken.extend(broken)
        result.text_only_reports.extend(text_only_reports)
        return

    async with pool.connection() as conn:
        async with conn.transaction():
            written, unchanged = await write_relations(conn, rows)
            await checkpoint_resolver_progress(
                conn,
                corpus=corpus,
                last_source_id=last_source_id,
                entries_delta=0,  # entries are counted per-iteration; this is per-batch flush
                refs_extracted_delta=extracted,
                refs_resolved_delta=resolved,
                refs_text_only_delta=text_only,
                refs_broken_delta=broken_count,
            )
    result.counters.refs_extracted += extracted
    result.counters.refs_resolved += resolved
    result.counters.refs_text_only += text_only
    result.counters.refs_broken += broken_count
    result.counters.rows_written += written
    result.counters.rows_unchanged += unchanged
    result.broken.extend(broken)
    result.text_only_reports.extend(text_only_reports)


# -----------------------------------------------------------------------------
# Top-level orchestrator
# -----------------------------------------------------------------------------


async def run_all(
    pool: AsyncConnectionPool,
    *,
    corpora: Iterable[str],
    cfg: ResolverConfig,
) -> dict[str, _CorpusResult]:
    """Resolve cross-refs for each corpus in `corpora`."""

    corpora = list(corpora)

    # Pre-flight: the resolver runs against ALREADY-LOADED data. If the
    # target corpora aren't loaded, fail loud — see ResolverPrerequisiteError.
    async with pool.connection() as conn:
        loaded = await _check_corpora_loaded(conn)
    missing = [c for c in corpora if c not in loaded]
    if missing:
        # Surface which corpora ARE loaded so the user can catch a typo
        # without crawling pg_stat for it (REVIEW_C2 F4).
        raise ResolverPrerequisiteError(
            f"Cross-reference resolver requires the source loader to have "
            f"populated the following corpora first: missing={missing}; "
            f"loaded={sorted(loaded) if loaded else '[]'}. Run "
            f"`python -m tools.ingest.load_to_postgres` against the missing "
            f"JSONs before retrying."
        )

    # Build the lookup index once — covers every corpus regardless of which
    # subset we're resolving (cross-corpus refs need the whole map).
    async with pool.connection() as conn:
        index = await LookupIndex.from_db(conn)

    results: dict[str, _CorpusResult] = {}
    for corpus in corpora:
        results[corpus] = await run_one(pool, corpus=corpus, index=index, cfg=cfg)
    return results
