"""
KRDICT loader — XML/JSON → Postgres.

Producer: krdict_parser.iter_entries
Consumer: this module, batched + transactional + idempotent + resumable.

CLI
---
    python -m load_krdict --source /path/to/krdict[.xml|/dir] [options]

Options
-------
    --source PATH        XML file or directory of XML files (required).
    --source-label LBL   Provenance label (default: "KRDICT").
    --batch-size N       Entries per transaction (default 1000).
    --resume             Resume from last checkpoint for this source label.
    --dry-run            Parse + validate; never connect to the DB.
    --database-url URL   Postgres DSN (else read DATABASE_URL env var).
    --log-format json|text (default text for tty, json otherwise)

Design contract
---------------
* Idempotent — upsert by (source_id, homograph_index). Re-running on the
  same archive is a no-op for unchanged entries.
* Resumable — checkpoint table `krdict_import_state` tracks the last
  durably-processed source_id; --resume skips past it.
* Transactional per batch — each batch is wrapped in a single
  transaction with the checkpoint update, so a crash mid-batch leaves
  the checkpoint exactly at the last committed batch.
* Parameterized queries everywhere — no string interpolation in SQL.
* Structured logging — JSON when not on a TTY.
* Graceful failure — a malformed entry is skipped and logged, never crashes.

ADR references: ADR-013 (loader does NOT own transactions in migrations —
that's about migrate.py; here the loader DOES own each batch tx);
ADR-001 §"Idempotency & retries", §"Logging & observability".
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator, Optional

import psycopg
from psycopg.rows import dict_row

from krdict_models import (
    KrdictEntryModel,
    KrdictSourceMetadata,
)
from krdict_parser import SkipReason, iter_entries


# -----------------------------------------------------------------------------
# Domain exceptions (SENIOR_ENGINEER_BAR §"Error handling": typed errors).
# -----------------------------------------------------------------------------
class KrdictLoaderError(Exception):
    """Base loader exception."""


class KrdictSourceMissingError(KrdictLoaderError):
    """The source path doesn't exist."""


class KrdictResumeWithoutCheckpointError(KrdictLoaderError):
    """--resume requested but no krdict_import_state row exists."""


class KrdictResumeMarkerMissingError(KrdictLoaderError):
    """--resume marker source_id was not found in the input stream.

    Raised by ``_filter_resumable`` when seeking completes without ever
    observing the recorded last-processed source_id. Prevents the silent
    "zero progress, success" failure mode where the loader iterates the
    entire archive while never flipping ``state.seeking`` and then writes
    ``completed_at`` on top of a no-op run. See REVIEW_B2.md SF1.
    """


# -----------------------------------------------------------------------------
# Logging setup — structured JSON when stdout isn't a TTY.
# -----------------------------------------------------------------------------
class _JsonFormatter(logging.Formatter):
    """Minimal structlog-equivalent. Stdlib only, deliberately."""

    def format(self, record: logging.LogRecord) -> str:
        # Standard log envelope.
        payload = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        # extra={} fields land on the record as attributes; copy them in.
        for key, value in record.__dict__.items():
            if key in (
                "name", "msg", "args", "levelname", "levelno", "pathname",
                "filename", "module", "exc_info", "exc_text", "stack_info",
                "lineno", "funcName", "created", "msecs", "relativeCreated",
                "thread", "threadName", "processName", "process",
                "getMessage",
            ):
                continue
            try:
                json.dumps(value)
                payload[key] = value
            except (TypeError, ValueError):
                payload[key] = repr(value)
        return json.dumps(payload, ensure_ascii=False)


def _configure_logging(fmt: str) -> None:
    handler = logging.StreamHandler(stream=sys.stderr)
    if fmt == "json":
        handler.setFormatter(_JsonFormatter())
    else:
        handler.setFormatter(
            logging.Formatter(
                "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
            )
        )
    root = logging.getLogger()
    # Replace handlers so re-invocations (tests) don't double-log.
    root.handlers = [handler]
    root.setLevel(logging.INFO)


log = logging.getLogger("load_krdict")


# -----------------------------------------------------------------------------
# Provenance — SHA-256 of the source, gathered before parsing.
# -----------------------------------------------------------------------------
def compute_source_sha256(source: Path) -> str:
    """SHA-256 of a single file, or of a deterministic concat of every XML
    under a directory (sorted filename order)."""
    h = hashlib.sha256()
    if source.is_dir():
        files = sorted(p for p in source.rglob("*.xml") if p.is_file())
        for f in files:
            # Mix in the relative path so two archives that share files but
            # differ in layout still hash distinctly.
            h.update(str(f.relative_to(source)).encode("utf-8"))
            h.update(b"\0")
            with f.open("rb") as fp:
                for chunk in iter(lambda: fp.read(65536), b""):
                    h.update(chunk)
    elif source.is_file():
        with source.open("rb") as fp:
            for chunk in iter(lambda: fp.read(65536), b""):
                h.update(chunk)
    else:
        raise KrdictSourceMissingError(f"source does not exist: {source}")
    return h.hexdigest()


def count_xml_entries(source: Path) -> int:
    """Cheap pre-scan for sanity-checking. Counts `<entry>` substrings,
    NOT an XML parse — purely defensive (avoid blowing memory on a count)."""
    total = 0
    files: list[Path]
    if source.is_dir():
        files = sorted(p for p in source.rglob("*.xml") if p.is_file())
    else:
        files = [source]
    for f in files:
        # Process line-by-line so even a multi-GB file is fine. Counting
        # `<entry>` open tags is a heuristic — not a parse.
        with f.open("rb") as fp:
            for line in fp:
                total += line.count(b"<entry>") + line.count(b"<entry ")
    return total


# -----------------------------------------------------------------------------
# SQL statements — parameterized, named for clarity. All SQL lives here so
# the rest of the module never builds query strings dynamically.
# -----------------------------------------------------------------------------

SQL_UPSERT_SOURCE = """
INSERT INTO krdict_source (
    source_label, source_path, source_sha256, license, license_url,
    publisher, publisher_url, item_count, extracted_at, notes
) VALUES (
    %(source_label)s, %(source_path)s, %(source_sha256)s, %(license)s,
    %(license_url)s, %(publisher)s, %(publisher_url)s, %(item_count)s,
    %(extracted_at)s, %(notes)s
)
ON CONFLICT (source_label) DO UPDATE SET
    source_path   = EXCLUDED.source_path,
    source_sha256 = EXCLUDED.source_sha256,
    license       = EXCLUDED.license,
    license_url   = EXCLUDED.license_url,
    publisher     = EXCLUDED.publisher,
    publisher_url = EXCLUDED.publisher_url,
    item_count    = EXCLUDED.item_count,
    extracted_at  = EXCLUDED.extracted_at,
    notes         = EXCLUDED.notes,
    updated_at    = now(),
    version       = krdict_source.version + 1
WHERE
    krdict_source.source_path   IS DISTINCT FROM EXCLUDED.source_path
 OR krdict_source.source_sha256 IS DISTINCT FROM EXCLUDED.source_sha256
 OR krdict_source.license       IS DISTINCT FROM EXCLUDED.license
 OR krdict_source.license_url   IS DISTINCT FROM EXCLUDED.license_url
 OR krdict_source.item_count    IS DISTINCT FROM EXCLUDED.item_count
 OR krdict_source.extracted_at  IS DISTINCT FROM EXCLUDED.extracted_at
 OR krdict_source.notes         IS DISTINCT FROM EXCLUDED.notes
RETURNING id;
"""

SQL_FETCH_SOURCE_ID = "SELECT id FROM krdict_source WHERE source_label = %(label)s;"

SQL_UPSERT_ENTRY = """
INSERT INTO krdict_entries (
    krdict_source_id, source_id, homograph_index,
    headword, pronunciation, part_of_speech, hanja, register, vocabulary_level,
    definition_korean, definition_english
) VALUES (
    %(krdict_source_id)s, %(source_id)s, %(homograph_index)s,
    %(headword)s, %(pronunciation)s, %(part_of_speech)s, %(hanja)s, %(register)s,
    %(vocabulary_level)s,
    %(definition_korean)s, %(definition_english)s
)
ON CONFLICT (source_id, homograph_index) DO UPDATE SET
    krdict_source_id    = EXCLUDED.krdict_source_id,
    headword            = EXCLUDED.headword,
    pronunciation       = EXCLUDED.pronunciation,
    part_of_speech      = EXCLUDED.part_of_speech,
    hanja               = EXCLUDED.hanja,
    register            = EXCLUDED.register,
    vocabulary_level    = EXCLUDED.vocabulary_level,
    definition_korean   = EXCLUDED.definition_korean,
    definition_english  = EXCLUDED.definition_english,
    updated_at          = now(),
    version             = krdict_entries.version + 1
WHERE
    krdict_entries.headword           IS DISTINCT FROM EXCLUDED.headword
 OR krdict_entries.pronunciation      IS DISTINCT FROM EXCLUDED.pronunciation
 OR krdict_entries.part_of_speech     IS DISTINCT FROM EXCLUDED.part_of_speech
 OR krdict_entries.hanja              IS DISTINCT FROM EXCLUDED.hanja
 OR krdict_entries.register           IS DISTINCT FROM EXCLUDED.register
 OR krdict_entries.vocabulary_level   IS DISTINCT FROM EXCLUDED.vocabulary_level
 OR krdict_entries.definition_korean  IS DISTINCT FROM EXCLUDED.definition_korean
 OR krdict_entries.definition_english IS DISTINCT FROM EXCLUDED.definition_english
RETURNING id;
"""

SQL_FETCH_ENTRY_ID = """
SELECT id FROM krdict_entries
 WHERE source_id = %(source_id)s AND homograph_index = %(homograph_index)s;
"""

# Replace-all for senses + examples + inflections per entry. Simpler than
# upserting each sense in place because KRDICT senses can reorder upstream;
# a single re-source is cleanest. CASCADE on FKs makes the delete safe.
SQL_DELETE_SENSES_FOR_ENTRY = (
    "DELETE FROM krdict_senses WHERE krdict_entry_id = %(entry_id)s;"
)
SQL_DELETE_INFLECTIONS_FOR_ENTRY = (
    "DELETE FROM krdict_inflections WHERE krdict_entry_id = %(entry_id)s;"
)

SQL_INSERT_SENSE = """
INSERT INTO krdict_senses (
    krdict_entry_id, sense_index, definition_korean, definition_english,
    sense_domain, sense_register
) VALUES (
    %(krdict_entry_id)s, %(sense_index)s, %(definition_korean)s,
    %(definition_english)s, %(sense_domain)s, %(sense_register)s
)
RETURNING id;
"""

SQL_INSERT_EXAMPLE = """
INSERT INTO krdict_examples (
    krdict_sense_id, example_index, korean, english, example_type
) VALUES (
    %(krdict_sense_id)s, %(example_index)s, %(korean)s, %(english)s,
    %(example_type)s
);
"""

SQL_INSERT_INFLECTION = """
INSERT INTO krdict_inflections (
    krdict_entry_id, order_index, surface_form, inflection_label
) VALUES (
    %(krdict_entry_id)s, %(order_index)s, %(surface_form)s,
    %(inflection_label)s
);
"""

SQL_UPSERT_IMPORT_STATE = """
INSERT INTO krdict_import_state (
    source_label, source_sha256, last_processed_source_id,
    entries_processed, entries_skipped, started_at, last_checkpoint_at,
    completed_at, notes
) VALUES (
    %(source_label)s, %(source_sha256)s, %(last_processed_source_id)s,
    %(entries_processed)s, %(entries_skipped)s, %(started_at)s,
    %(last_checkpoint_at)s, %(completed_at)s, %(notes)s
)
ON CONFLICT (source_label, source_sha256) DO UPDATE SET
    last_processed_source_id = EXCLUDED.last_processed_source_id,
    entries_processed        = EXCLUDED.entries_processed,
    entries_skipped          = EXCLUDED.entries_skipped,
    last_checkpoint_at       = EXCLUDED.last_checkpoint_at,
    completed_at             = EXCLUDED.completed_at,
    notes                    = EXCLUDED.notes,
    updated_at               = now(),
    version                  = krdict_import_state.version + 1;
"""

SQL_FETCH_IMPORT_STATE = """
SELECT last_processed_source_id, entries_processed, entries_skipped, started_at
  FROM krdict_import_state
 WHERE source_label = %(source_label)s
   AND source_sha256 = %(source_sha256)s;
"""


# -----------------------------------------------------------------------------
# Resume cursor — equality-based "skip until we observe this source_id".
#
# Why equality (not lexicographic): the parser visits files in sorted path
# order and entries in within-file document order, but NEITHER ordering is by
# source_id. Homograph entries share a source_id with different homograph_index
# and KRDICT vintages routinely intermix new entries among old ones, so a
# lexicographic skip would silently drop entries that sort earlier than the
# marker but appear later in document order.
#
# Defense: _filter_resumable raises KrdictResumeMarkerMissingError if the
# marker source_id is never observed, so a stale checkpoint surfaces loudly
# instead of as a zero-progress "completed" run. See REVIEW_B2.md SF1.
# -----------------------------------------------------------------------------
@dataclass
class ResumeState:
    """Where to resume from, plus a tracking flag."""

    last_processed: Optional[str]
    entries_processed: int = 0
    entries_skipped: int = 0
    # When `last_processed` is set, we skip until we see that ID; after
    # that, this flag flips to False and the loader processes normally.
    seeking: bool = field(init=False)

    def __post_init__(self) -> None:
        self.seeking = self.last_processed is not None


# -----------------------------------------------------------------------------
# Loader core — batched, transactional, idempotent.
# -----------------------------------------------------------------------------
@dataclass
class LoadStats:
    entries_inserted_or_updated: int = 0
    entries_skipped: int = 0
    batches_committed: int = 0
    started_at: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc)
    )

    def to_dict(self) -> dict:
        return {
            "entries_inserted_or_updated": self.entries_inserted_or_updated,
            "entries_skipped": self.entries_skipped,
            "batches_committed": self.batches_committed,
            "started_at": self.started_at.isoformat(),
        }


def _entry_params(model: KrdictEntryModel, source_pk: int) -> dict:
    first_sense = model.senses[0]
    return {
        "krdict_source_id": source_pk,
        "source_id": model.source_id,
        "homograph_index": model.homograph_index,
        "headword": model.headword,
        "pronunciation": model.pronunciation,
        "part_of_speech": model.part_of_speech,
        "hanja": model.hanja,
        "register": model.register.value if model.register else None,
        "vocabulary_level": (
            model.vocabulary_level.value if model.vocabulary_level else None
        ),
        "definition_korean": first_sense.definition_korean,
        "definition_english": first_sense.definition_english,
    }


def _persist_entry(cur, model: KrdictEntryModel, source_pk: int) -> None:
    """Upsert one entry + replace its sense / example / inflection rows.

    Idempotency contract (SF2, REVIEW_B2.md):
      When the entry-row IS DISTINCT FROM guard suppresses the parent
      update (i.e. the canonical entry-row content is unchanged), we ALSO
      skip the children replace-all. A no-op re-run on an unchanged
      archive must NOT churn senses / examples / inflections — that
      would burn ``updated_at`` and ``version`` on hundreds of thousands
      of child rows for zero net change and would invalidate the
      "idempotent re-run" claim made in the README and ADR-015.

      The cost of this shortcut: if a future change introduces a
      child-only diff (e.g. an example's English gloss is rewritten but
      the parent entry row stays identical), it would be missed. That
      is an explicit trade-off — diff-upsert of senses is the proper
      fix for that case and is tracked as a follow-up. Today, every
      observed KRDICT update path that changes children ALSO changes
      ``definition_korean`` on the parent (the first sense flows up
      into the entry row), so this shortcut is correct in practice.
    """

    # 1. Upsert the entry row.
    cur.execute(SQL_UPSERT_ENTRY, _entry_params(model, source_pk))
    row = cur.fetchone()
    if row is not None:
        # The row was inserted or updated; RETURNING gives us the PK.
        entry_pk = row["id"]
        entry_changed = True
    else:
        # ON CONFLICT … WHERE clause filtered out the update (no change).
        # Fetch the existing id via the natural key.
        cur.execute(
            SQL_FETCH_ENTRY_ID,
            {
                "source_id": model.source_id,
                "homograph_index": model.homograph_index,
            },
        )
        existing = cur.fetchone()
        if existing is None:
            # Should be unreachable — upsert without RETURNING means the row
            # existed and was unchanged.
            raise KrdictLoaderError(
                f"entry vanished after upsert: source_id={model.source_id}"
            )
        entry_pk = existing["id"]
        entry_changed = False

    if not entry_changed:
        # Idempotency: skip the children replace-all when the parent didn't
        # change. See the contract block at the top of this function.
        return

    # 2. Replace senses (CASCADE drops examples too).
    cur.execute(SQL_DELETE_SENSES_FOR_ENTRY, {"entry_id": entry_pk})
    for sense in model.senses:
        cur.execute(
            SQL_INSERT_SENSE,
            {
                "krdict_entry_id": entry_pk,
                "sense_index": sense.sense_index,
                "definition_korean": sense.definition_korean,
                "definition_english": sense.definition_english,
                "sense_domain": sense.sense_domain,
                "sense_register": sense.sense_register,
            },
        )
        sense_pk = cur.fetchone()["id"]
        for example in sense.examples:
            cur.execute(
                SQL_INSERT_EXAMPLE,
                {
                    "krdict_sense_id": sense_pk,
                    "example_index": example.example_index,
                    "korean": example.korean,
                    "english": example.english,
                    "example_type": example.example_type,
                },
            )

    # 3. Replace inflections.
    cur.execute(SQL_DELETE_INFLECTIONS_FOR_ENTRY, {"entry_id": entry_pk})
    for infl in model.inflections:
        cur.execute(
            SQL_INSERT_INFLECTION,
            {
                "krdict_entry_id": entry_pk,
                "order_index": infl.order_index,
                "surface_form": infl.surface_form,
                "inflection_label": infl.inflection_label,
            },
        )


def _checkpoint(
    cur,
    metadata: KrdictSourceMetadata,
    state: ResumeState,
    stats: LoadStats,
    *,
    completed: bool,
) -> None:
    cur.execute(
        SQL_UPSERT_IMPORT_STATE,
        {
            "source_label": metadata.source_label,
            "source_sha256": metadata.source_sha256,
            "last_processed_source_id": state.last_processed,
            "entries_processed": stats.entries_inserted_or_updated,
            "entries_skipped": stats.entries_skipped,
            "started_at": stats.started_at,
            "last_checkpoint_at": datetime.now(timezone.utc),
            "completed_at": (
                datetime.now(timezone.utc) if completed else None
            ),
            "notes": metadata.notes,
        },
    )


def _ensure_source_row(conn, metadata: KrdictSourceMetadata) -> int:
    """Upsert the krdict_source row, return its id. Own transaction."""
    with conn.transaction(), conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            SQL_UPSERT_SOURCE,
            {
                "source_label": metadata.source_label,
                "source_path": metadata.source_path,
                "source_sha256": metadata.source_sha256,
                "license": metadata.license,
                "license_url": metadata.license_url,
                "publisher": metadata.publisher,
                "publisher_url": metadata.publisher_url,
                "item_count": metadata.item_count,
                "extracted_at": date.today(),
                "notes": metadata.notes,
            },
        )
        row = cur.fetchone()
        if row is not None:
            return row["id"]
        # No change — fetch existing.
        cur.execute(SQL_FETCH_SOURCE_ID, {"label": metadata.source_label})
        existing = cur.fetchone()
        if existing is None:
            raise KrdictLoaderError("krdict_source upsert vanished")
        return existing["id"]


def _fetch_resume_state(
    conn, metadata: KrdictSourceMetadata, *, requested: bool
) -> ResumeState:
    """Build the resume cursor. When --resume requested but no checkpoint
    row exists, raise — silent restart-from-zero is a footgun."""
    if not requested:
        return ResumeState(last_processed=None)

    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            SQL_FETCH_IMPORT_STATE,
            {
                "source_label": metadata.source_label,
                "source_sha256": metadata.source_sha256,
            },
        )
        row = cur.fetchone()
    if row is None:
        raise KrdictResumeWithoutCheckpointError(
            f"--resume requested but no checkpoint exists for "
            f"label={metadata.source_label} sha256={metadata.source_sha256}"
        )
    return ResumeState(
        last_processed=row["last_processed_source_id"],
        entries_processed=row["entries_processed"] or 0,
        entries_skipped=row["entries_skipped"] or 0,
    )


def _filter_resumable(
    entries: Iterable[KrdictEntryModel], state: ResumeState
) -> Iterator[KrdictEntryModel]:
    """When seeking, skip until we pass the last-processed source_id.

    Failure mode defended (SF1, REVIEW_B2.md): if the marker source_id is
    not found in the stream (deleted upstream, or moved earlier in a new
    vintage), the previous implementation silently skipped every remaining
    entry and reported zero-progress success. We now require that the
    marker be observed; otherwise we raise so the operator can either
    reset the checkpoint (``--source-label`` for a new vintage) or
    investigate.
    """
    if not state.seeking or state.last_processed is None:
        yield from entries
        return

    target = state.last_processed
    found_marker = False
    for entry in entries:
        if state.seeking:
            if entry.source_id == target:
                # We've found the marker. Skip IT (it's already persisted)
                # and continue.
                state.seeking = False
                found_marker = True
                continue
            # Skipping past prior work.
            continue
        yield entry

    if not found_marker:
        raise KrdictResumeMarkerMissingError(
            f"resume marker source_id={target!r} not found in input stream. "
            "This means the entry that was last processed has been removed or "
            "moved earlier in the source archive. Re-run with a new "
            "--source-label (treat this as a fresh vintage) or investigate."
        )


def _batched(
    entries: Iterable[KrdictEntryModel], size: int
) -> Iterator[list[KrdictEntryModel]]:
    """Group an iterator into lists of `size`. The last batch may be short."""
    if size < 1:
        raise ValueError(f"batch size must be >= 1, got {size}")
    batch: list[KrdictEntryModel] = []
    for entry in entries:
        batch.append(entry)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


@contextmanager
def _connect(dsn: str):
    """Open a psycopg connection with conservative settings."""
    conn = psycopg.connect(
        dsn,
        application_name="korean-master-krdict-loader",
        autocommit=False,
    )
    try:
        # Loaders may run long — disable statement timeout for this session.
        with conn.cursor() as cur:
            cur.execute("SET statement_timeout = 0;")
        yield conn
    finally:
        conn.close()


def load(
    *,
    source: Path,
    metadata: KrdictSourceMetadata,
    dsn: str,
    batch_size: int = 1000,
    resume: bool = False,
) -> LoadStats:
    """Run the loader. Returns aggregate stats."""

    if not source.exists():
        raise KrdictSourceMissingError(f"source path does not exist: {source}")

    stats = LoadStats()

    with _connect(dsn) as conn:
        # 1. Upsert source-row and resolve PK in its own short tx.
        source_pk = _ensure_source_row(conn, metadata)
        log.info(
            "krdict_loader.source_resolved",
            extra={
                "source_label": metadata.source_label,
                "source_id": source_pk,
                "source_sha256": metadata.source_sha256,
            },
        )

        # 2. Resume state.
        state = _fetch_resume_state(conn, metadata, requested=resume)
        if state.seeking:
            log.info(
                "krdict_loader.resuming",
                extra={
                    "last_processed_source_id": state.last_processed,
                    "previously_processed": state.entries_processed,
                },
            )
            # Carry forward prior counters so the checkpoint stays monotonic.
            stats.entries_inserted_or_updated = state.entries_processed
            stats.entries_skipped = state.entries_skipped

        # 3. Parser → resume filter → batch → persist + checkpoint per batch.
        def _on_skip(reason: SkipReason) -> None:
            stats.entries_skipped += 1
            log.warning(
                "krdict_loader.parser_skip",
                extra={
                    "source_id": reason.source_id,
                    "error": reason.error,
                },
            )

        all_entries = iter_entries(source, on_skip=_on_skip)
        filtered = _filter_resumable(all_entries, state)

        for batch in _batched(filtered, batch_size):
            with conn.transaction(), conn.cursor(row_factory=dict_row) as cur:
                for entry in batch:
                    try:
                        _persist_entry(cur, entry, source_pk)
                        stats.entries_inserted_or_updated += 1
                        state.last_processed = entry.source_id
                    except psycopg.errors.CheckViolation as exc:
                        # FAIL-LOUDLY on schema drift (ADR-017): a CHECK
                        # violation (e.g. unknown POS value) is a
                        # parser-vs-schema drift signal that needs human
                        # attention. We log and re-raise; the enclosing
                        # transaction rolls back the in-flight batch AND
                        # leaves the checkpoint at the end of the PREVIOUS
                        # batch, so --resume will retry from there and
                        # crash at the same entry until the schema is
                        # fixed. This is intentional — silently coercing
                        # the bad row would mask a real drift.
                        log.error(
                            "krdict_loader.check_violation",
                            extra={
                                "source_id": entry.source_id,
                                "error": str(exc),
                            },
                        )
                        raise
                _checkpoint(cur, metadata, state, stats, completed=False)
            stats.batches_committed += 1
            log.info(
                "krdict_loader.batch_committed",
                extra={
                    "batches_committed": stats.batches_committed,
                    "entries_inserted_or_updated": (
                        stats.entries_inserted_or_updated
                    ),
                    "entries_skipped": stats.entries_skipped,
                    "last_processed_source_id": state.last_processed,
                },
            )

        # 4. Final checkpoint with completed_at set.
        with conn.transaction(), conn.cursor(row_factory=dict_row) as cur:
            _checkpoint(cur, metadata, state, stats, completed=True)
        log.info("krdict_loader.completed", extra=stats.to_dict())

    return stats


def dry_run(
    *,
    source: Path,
    metadata: KrdictSourceMetadata,
) -> LoadStats:
    """Parse + validate without touching the DB."""
    stats = LoadStats()

    def _on_skip(reason: SkipReason) -> None:
        stats.entries_skipped += 1
        log.warning(
            "krdict_loader.dry_run_skip",
            extra={"source_id": reason.source_id, "error": reason.error},
        )

    for _ in iter_entries(source, on_skip=_on_skip):
        stats.entries_inserted_or_updated += 1
    log.info(
        "krdict_loader.dry_run_completed",
        extra={
            "source": str(source),
            "source_label": metadata.source_label,
            "stats": stats.to_dict(),
        },
    )
    return stats


# -----------------------------------------------------------------------------
# CLI.
# -----------------------------------------------------------------------------
def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="load_krdict",
        description=(
            "Load KRDICT XML into Postgres. Idempotent, resumable, batched."
        ),
    )
    p.add_argument(
        "--source",
        required=True,
        type=Path,
        help="Path to KRDICT XML file OR directory of XML files.",
    )
    p.add_argument(
        "--source-label",
        default="KRDICT",
        help="Provenance label (default 'KRDICT'). Different labels for "
        "different vintages.",
    )
    p.add_argument(
        "--batch-size",
        type=int,
        default=1000,
        help="Entries per transaction (default 1000).",
    )
    p.add_argument(
        "--resume",
        action="store_true",
        help="Skip past the last-processed source_id for this label.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse + validate; never connect to the DB.",
    )
    p.add_argument(
        "--database-url",
        default=None,
        help="Postgres DSN. Falls back to DATABASE_URL env var.",
    )
    p.add_argument(
        "--license",
        default="KOGL Type 1 (attribution)",
        help="Source license (default KOGL Type 1).",
    )
    p.add_argument(
        "--license-url",
        default="https://www.kogl.or.kr/info/license.do",
        help="Source-license URL.",
    )
    p.add_argument(
        "--notes",
        default=None,
        help="Optional provenance notes.",
    )
    p.add_argument(
        "--log-format",
        choices=("text", "json"),
        default=None,
        help="Log format (default: text on TTY, json otherwise).",
    )
    return p


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    log_fmt = args.log_format or (
        "text" if sys.stderr.isatty() else "json"
    )
    _configure_logging(log_fmt)

    source = args.source.resolve()
    if not source.exists():
        log.error("krdict_loader.source_missing", extra={"path": str(source)})
        return 2

    log.info(
        "krdict_loader.start",
        extra={
            "source": str(source),
            "source_label": args.source_label,
            "batch_size": args.batch_size,
            "resume": args.resume,
            "dry_run": args.dry_run,
        },
    )

    # Hash + count are CPU-bound; do them before touching the DB. For very
    # large archives count_xml_entries is the slow part — it's not strictly
    # required, but the item-count sanity is a nice-to-have.
    sha = compute_source_sha256(source)
    item_count = count_xml_entries(source)
    log.info(
        "krdict_loader.source_hashed",
        extra={
            "sha256": sha,
            "item_count": item_count,
        },
    )

    metadata = KrdictSourceMetadata(
        source_label=args.source_label,
        source_path=str(source),
        source_sha256=sha,
        license=args.license,
        license_url=args.license_url,
        item_count=item_count,
        notes=args.notes,
    )

    if args.dry_run:
        stats = dry_run(source=source, metadata=metadata)
        # Emit a clear summary to stdout for shell consumers.
        print(json.dumps(stats.to_dict(), ensure_ascii=False))
        return 0

    dsn = args.database_url or os.environ.get("DATABASE_URL")
    if not dsn:
        log.error(
            "krdict_loader.missing_dsn",
            extra={"hint": "set --database-url or DATABASE_URL"},
        )
        return 2

    try:
        stats = load(
            source=source,
            metadata=metadata,
            dsn=dsn,
            batch_size=args.batch_size,
            resume=args.resume,
        )
    except KrdictResumeWithoutCheckpointError as exc:
        log.error("krdict_loader.resume_failed", extra={"error": str(exc)})
        return 3
    except KrdictResumeMarkerMissingError as exc:
        # Distinct exit code so ops can wire an alert on "checkpoint became
        # stale" separately from a generic loader crash. See REVIEW_B2.md SF1.
        log.error("krdict_loader.resume_marker_missing", extra={"error": str(exc)})
        return 5
    except KrdictLoaderError as exc:
        log.error("krdict_loader.loader_error", extra={"error": str(exc)})
        return 4

    print(json.dumps(stats.to_dict(), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
