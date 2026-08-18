"""
TOPIK question-image loader (F-120, Phase 1).

Consumes the per-paper-section extraction manifests produced by the (future)
``tools/ingest/topik_images`` crop tool — or hand-authored for the proof set —
(``topik_<N>_<I|II>_<section>.json``) and writes migration 085's column:

  * ``topik_items.image_ref`` ← each item's ``image_ref`` (the question's
    cropped exam figure, as a corpus-RELATIVE POSIX key under
    CORPUS_IMAGE_DIR — 035/078's contract, verbatim; never host-absolute).

Modeled on ``load_topik_audio.py``: a keyed-UPDATE mapper, one shared
transaction, parse-everything-up-front fail-loud posture.

MANIFEST SCHEMA (one JSON object per paper section):
    {
      "test_number": 60,
      "topik_level": "TOPIK II",
      "section": "listening",
      "source_pdf": "TOPIK TEST/60 - 60th TOPIK/TOPIK-II/listening.pdf",
      "pdf_sha256": "<64-hex of the source PDF>",
      "extractor_version": "1.0.0",
      "items": [
        {"number": 1,
         "image_ref": "TOPIK IMAGES/60/TOPIK-II/listening/q01.png",
         "width": 800, "height": 600, "kind": "picture_choice",
         "sha256": "<64-hex of the crop file>"},
        ...
      ]
    }
``width``/``height``/``kind``/``sha256``/``source_pdf``/``pdf_sha256``/
``extractor_version`` are provenance — validated at parse time (a manifest
missing them was not minted by the extractor) but not stored in Phase 1
(085 is a single TEXT column; a provenance JSONB ride-along is a Phase 2
decision once the real extractor exists).

KEYING: the ``topik_tests`` row is resolved by the migration-029 natural key
``(test_number, topik_level, section)`` — the SECTION is part of the key here
(unlike the audio loader's listening-pinned lookup) because reading AND
listening items carry figures — and each item by ``(topik_test_id,
item_number)`` (``uq_topik_items_test_number``). A manifest whose test has no
DB row is counted (``tests_without_row``) and skipped; an item whose number
has no DB row is counted (``items_without_matching_row``) without failing the
paper.

GUARDS:
  * ABSOLUTE / TRAVERSING image_ref REJECTED AT PARSE TIME
    (:class:`ManifestError`) — the same relative-POSIX-key gate as
    ``load_topik_audio``'s ``source_mp3`` (no leading ``/``, no backslash
    anywhere, no ``..`` segment, no ``:`` drive/scheme token). A tampered
    manifest cannot plant a key that escapes the corpus root; the serving
    route enforces containment again at read time (defense in depth).
  * DUPLICATE ITEM NUMBERS within one manifest are rejected at parse time —
    letting the last write silently win would hide the corruption.
  * A manifest with ZERO items is skipped (``manifests_skipped_empty``) —
    nothing to map is a benign state, not an error.

IDEMPOTENCY + CONVERGENCE (``load_topik_audio``'s exact posture): each
admitted paper section is a full CLEAR-then-write — inside the shared
transaction, every item of that (test, section) has its ``image_ref`` NULLed
first, then the manifest's current mappings land. Rows the manifest no longer
covers therefore converge back to NULL ("unmapped rows stay NULL" is
guaranteed, not assumed), and a normal re-run clears-then-rewrites identical
values (a no-op in effect). ONE transaction for the whole pass: a failure
anywhere leaves every ``image_ref`` exactly as it was. ``--dry-run`` plans
against the real DB, then rolls back.

EXIT CODES (:func:`main`):
  * 0 — clean run: every manifest either mapped or was a benign empty skip.
  * 1 — the run must not read as clean: any ``tests_without_row`` (the paper
    is unseeded — run load_topik.py first) or ``manifests_without_rows``
    (an admitted manifest landed ZERO items — every number unseeded), or any
    runtime failure. Good manifests ARE still loaded before the non-zero exit.
  * 2 — usage error: invalid CLI arguments or no ``--database-url``/
    ``$DATABASE_URL``.

RUNNING: km-db is NOT host-exposed — run inside the ingest/deploy container
context (the ``Deploy/load-corpora.sh`` environment). psycopg is imported
lazily so the pure manifest parsing/validation helpers stay importable
host-side without DB deps.

SECURITY: every value is bound via psycopg ``%s`` placeholders — no manifest
string is ever concatenated into SQL (LOADERS_SECURITY.md §1).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any

import structlog

if TYPE_CHECKING:  # pragma: no cover - typing only; psycopg stays lazy
    from psycopg import AsyncConnection
    from psycopg_pool import AsyncConnectionPool

    from .runtime import LoaderConfig

logger = structlog.get_logger(__name__)

# Manifest filename contract (`topik_<N>_<I|II>_<section>.json`).
MANIFEST_GLOB = "topik_*.json"

# Where the (future) tools/ingest/topik_images crop tool writes manifests by
# default — kept in lockstep by convention, exactly like the audio loader's
# DEFAULT_ARTIFACTS_DIR ↔ tools/ingest/topik_audio pairing.
DEFAULT_MANIFESTS_DIR = Path(__file__).resolve().parents[1] / "output" / "topik_images"

# Closed sets enforced by the DB enums/constraints (005).
_TOPIK_LEVELS = frozenset({"TOPIK I", "TOPIK II"})
_SECTIONS = frozenset({"reading", "listening", "writing"})

_SHA256_RE = re.compile(r"[0-9a-f]{64}")


class ManifestError(ValueError):
    """A manifest is structurally malformed (bad JSON, wrong types, an
    absolute/traversing ``image_ref``, a duplicate item number, …).

    Raised at PARSE time, before any DB work — the loader fails loud on a
    broken manifest rather than guessing its way past it (ADR-019 §D10,
    ``load_topik_audio``'s ArtifactError posture).
    """


@dataclass(frozen=True)
class ImageItem:
    """One question's crop mapping."""

    number: int
    image_ref: str
    width: int
    height: int
    kind: str
    sha256: str


@dataclass(frozen=True)
class ImageManifest:
    """One parsed ``topik_<N>_<lvl>_<section>.json`` manifest."""

    path: Path
    test_number: int
    topik_level: str
    section: str
    source_pdf: str
    pdf_sha256: str
    extractor_version: str
    items: tuple[ImageItem, ...]


def _require(condition: bool, path: Path, message: str) -> None:
    if not condition:
        raise ManifestError(f"{path.name}: {message}")


def _as_int(value: Any, path: Path, field_name: str) -> int:
    # bool is an int subclass — a JSON `true` must not sneak in as 1.
    _require(
        isinstance(value, int) and not isinstance(value, bool),
        path,
        f"{field_name} must be an integer, got {value!r}",
    )
    return int(value)


def _as_nonempty_str(value: Any, path: Path, field_name: str) -> str:
    _require(
        isinstance(value, str) and bool(value),
        path,
        f"{field_name} must be a non-empty string, got {value!r}",
    )
    return str(value)


def _as_sha256(value: Any, path: Path, field_name: str) -> str:
    _require(
        isinstance(value, str) and _SHA256_RE.fullmatch(value) is not None,
        path,
        f"{field_name} must be a 64-char lowercase hex sha256, got {value!r}",
    )
    return str(value)


def validate_image_ref(value: Any, path: Path, field_name: str) -> str:
    """The 035/078 relative-POSIX-key gate, verbatim from the audio loader's
    ``_validate_source_mp3`` (a tampered manifest must not plant a key that
    escapes the corpus root — the serving route re-checks at read time)."""
    ref = _as_nonempty_str(value, path, field_name)
    # POSIX-only: any backslash (leading OR mid-string — `a\..\b`,
    # `C:\x.png`) is rejected outright rather than trusting POSIX parsing to
    # see through Windows separators.
    _require(
        "\\" not in ref,
        path,
        f"{field_name} must be a POSIX key with no backslashes, got {ref!r}",
    )
    rel = PurePosixPath(ref)
    _require(
        not rel.is_absolute(),
        path,
        f"{field_name} must be corpus-relative, got absolute path {ref!r}",
    )
    _require(
        ".." not in rel.parts,
        path,
        f"{field_name} must not traverse ('..'), got {ref!r}",
    )
    # No colon ANYWHERE (`C:/x.png`, `file:/…`, even mid-key) — a drive/scheme
    # token in any segment means the key was not minted by the extractor.
    _require(
        bool(rel.parts) and ":" not in ref,
        path,
        f"{field_name} must not contain a drive/scheme segment (':'), got {ref!r}",
    )
    return ref


def _parse_item(raw: Any, path: Path, index: int) -> ImageItem:
    _require(isinstance(raw, dict), path, f"items[{index}] must be an object")
    number = _as_int(raw.get("number"), path, f"items[{index}].number")
    _require(
        number >= 1,
        path,
        f"items[{index}].number must be >= 1 (ck_topik_items_item_number_pos)",
    )
    width = _as_int(raw.get("width"), path, f"items[{index}].width")
    height = _as_int(raw.get("height"), path, f"items[{index}].height")
    _require(
        width >= 1 and height >= 1,
        path,
        f"items[{index}] width/height must be >= 1, got {width}x{height}",
    )
    return ImageItem(
        number=number,
        image_ref=validate_image_ref(
            raw.get("image_ref"), path, f"items[{index}].image_ref"
        ),
        width=width,
        height=height,
        kind=_as_nonempty_str(raw.get("kind"), path, f"items[{index}].kind"),
        sha256=_as_sha256(raw.get("sha256"), path, f"items[{index}].sha256"),
    )


def parse_manifest(path: Path) -> ImageManifest:
    """Parse + structurally validate one extraction manifest.

    Pure (filesystem read only, no DB) — unit-tested standalone. Raises
    :class:`ManifestError` with the offending file + field named on any
    contract violation.
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        raise ManifestError(f"{path.name}: unreadable or invalid JSON: {err}") from err
    _require(isinstance(data, dict), path, "top level must be a JSON object")

    test_number = _as_int(data.get("test_number"), path, "test_number")
    _require(test_number >= 1, path, "test_number must be >= 1")

    topik_level = data.get("topik_level")
    _require(
        topik_level in _TOPIK_LEVELS,
        path,
        f"topik_level must be one of {sorted(_TOPIK_LEVELS)}, got {topik_level!r}",
    )
    section = data.get("section")
    _require(
        section in _SECTIONS,
        path,
        f"section must be one of {sorted(_SECTIONS)}, got {section!r}",
    )

    items_raw = data.get("items")
    _require(isinstance(items_raw, list), path, "items must be an array")
    items = tuple(_parse_item(raw, path, i) for i, raw in enumerate(items_raw))

    # One crop per question within a manifest — a duplicate number would make
    # the last write silently win at load time; fail loud instead.
    seen: set[int] = set()
    for item in items:
        _require(
            item.number not in seen,
            path,
            f"item {item.number} appears more than once — items must be unique",
        )
        seen.add(item.number)

    return ImageManifest(
        path=path,
        test_number=test_number,
        topik_level=str(topik_level),
        section=str(section),
        source_pdf=validate_image_ref(data.get("source_pdf"), path, "source_pdf"),
        pdf_sha256=_as_sha256(data.get("pdf_sha256"), path, "pdf_sha256"),
        extractor_version=_as_nonempty_str(
            data.get("extractor_version"), path, "extractor_version"
        ),
        items=items,
    )


def discover_manifests(manifests_dir: Path) -> list[Path]:
    """Every ``topik_*.json`` under ``manifests_dir``, sorted.

    Raises FileNotFoundError on a missing directory OR zero matches — a
    mispointed ``--manifests-dir`` must fail loudly, never "0 papers mapped,
    exit 0" (``discover_artifacts``'s posture)."""
    if not manifests_dir.is_dir():
        raise FileNotFoundError(
            f"{manifests_dir} is not a directory — --manifests-dir must point "
            "at the topik_images manifest directory "
            f"(default: {DEFAULT_MANIFESTS_DIR})"
        )
    paths = sorted(manifests_dir.glob(MANIFEST_GLOB))
    if not paths:
        raise FileNotFoundError(
            f"{manifests_dir} contains no {MANIFEST_GLOB} manifests — "
            "author/extract them first, or fix --manifests-dir"
        )
    return paths


@dataclass
class _Report:
    """Mutable run counters — finalized into the report dict by :func:`load`."""

    manifests_total: int = 0
    manifests_mapped: int = 0
    manifests_skipped_empty: int = 0
    # Admitted manifests (test row resolved) where ZERO items landed — every
    # number absent from the DB. Gates the non-zero exit.
    manifests_without_rows: int = 0
    tests_without_row: int = 0
    items_updated: int = 0
    # Counted per missing item number — a seeding gap, warned but the rest of
    # the manifest still maps (the audio loader's stance on missing items).
    items_without_matching_row: int = 0


async def _resolve_test_id(
    conn: AsyncConnection, *, test_number: int, topik_level: str, section: str
) -> int | None:
    """Resolve the paper section's topik_tests.id by the 029 natural key —
    section INCLUDED (both reading and listening papers carry figures)."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT id FROM topik_tests
             WHERE test_number = %s AND topik_level = %s
               AND section = %s::topik_section
            """,
            (test_number, topik_level, section),
        )
        row = await cur.fetchone()
    return int(row[0]) if row else None


async def _load_manifest(
    conn: AsyncConnection,
    manifest: ImageManifest,
    *,
    test_id: int,
    report: _Report,
) -> int:
    """Write one manifest's image_refs; returns how many actually LANDED
    (UPDATE rowcount hits). Runs inside the caller's shared transaction.

    Full CLEAR-then-write: every item of this (test, section) is NULLed
    first, then the manifest's current mappings land — rows the manifest no
    longer covers converge back to NULL, and a re-run is a no-op in effect
    (idempotent). The clear's rowcount is deliberately not counted:
    ``items_updated`` means refs WRITTEN, never refs cleared.
    """
    log = logger.bind(
        manifest=manifest.path.name,
        test_number=manifest.test_number,
        topik_level=manifest.topik_level,
        section=manifest.section,
    )
    landed = 0
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE topik_items
               SET image_ref = NULL
             WHERE topik_test_id = %s
            """,
            (test_id,),
        )
        for item in manifest.items:
            await cur.execute(
                """
                UPDATE topik_items
                   SET image_ref = %s
                 WHERE topik_test_id = %s AND item_number = %s
                """,
                (item.image_ref, test_id, item.number),
            )
            if cur.rowcount == 1:
                landed += 1
                report.items_updated += 1
            else:
                report.items_without_matching_row += 1
                log.warning("manifest_item_without_db_row", item_number=item.number)
    return landed


async def load(
    pool: AsyncConnectionPool,
    source_path: Path,
    cfg: LoaderConfig,
) -> dict:
    """Map every extraction manifest under ``source_path`` into migration 085.

    All manifests are parsed UP FRONT (fail loud before any DB write on a
    structurally broken file); then every admitted manifest's UPDATEs run in
    ONE shared transaction (``load_topik_audio``'s posture); ``cfg.dry_run``
    rolls it back after planning. Returns the report dict described in the
    module docstring.
    """
    log = logger.bind(source_path=str(source_path), dry_run=cfg.dry_run)
    manifests = [parse_manifest(p) for p in discover_manifests(source_path)]
    report = _Report(manifests_total=len(manifests))
    log.info("manifests_discovered", manifests=len(manifests))

    async with (
        pool.connection() as conn,
        conn.transaction(force_rollback=cfg.dry_run),
    ):
        for manifest in manifests:
            mlog = log.bind(
                manifest=manifest.path.name,
                test_number=manifest.test_number,
                topik_level=manifest.topik_level,
                section=manifest.section,
            )
            if not manifest.items:
                report.manifests_skipped_empty += 1
                mlog.warning("manifest_has_no_items_skipped")
                continue
            test_id = await _resolve_test_id(
                conn,
                test_number=manifest.test_number,
                topik_level=manifest.topik_level,
                section=manifest.section,
            )
            if test_id is None:
                report.tests_without_row += 1
                mlog.warning("test_row_not_found")
                continue
            landed = await _load_manifest(
                conn, manifest, test_id=test_id, report=report
            )
            if landed:
                report.manifests_mapped += 1
            else:
                report.manifests_without_rows += 1
                mlog.warning("manifest_admitted_but_no_rows_landed")

    had_refusals = bool(report.tests_without_row or report.manifests_without_rows)
    result = {
        "status": "complete_with_refusals" if had_refusals else "complete",
        "dry_run": cfg.dry_run,
        "manifests_total": report.manifests_total,
        "manifests_mapped": report.manifests_mapped,
        "manifests_skipped_empty": report.manifests_skipped_empty,
        "manifests_without_rows": report.manifests_without_rows,
        "tests_without_row": report.tests_without_row,
        "items_updated": report.items_updated,
        "items_without_matching_row": report.items_without_matching_row,
    }
    log.info("load_complete", **result)
    return result


# ---------------------------------------------------------------------------
# Standalone CLI — like load_topik_audio.py, deliberately NOT wired into
# load_to_postgres.py's ALL_CORPORA dispatch (the `corpus` enum has no member
# for this pass). Deploy/load-corpora.sh invokes it alongside the others.
# ---------------------------------------------------------------------------


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=(
            "Load TOPIK question-image extraction manifests into migration "
            "085's topik_items.image_ref column."
        )
    )
    p.add_argument(
        "--manifests-dir",
        type=Path,
        default=DEFAULT_MANIFESTS_DIR,
        help=f"Directory of {MANIFEST_GLOB} manifests "
        f"(default: {DEFAULT_MANIFESTS_DIR}).",
    )
    p.add_argument(
        "--database-url",
        default=None,
        help="Postgres URL; falls back to $DATABASE_URL.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Plan against the real DB (full report), then roll back — "
        "writes nothing.",
    )
    p.add_argument(
        "--log-level", default="info", choices=("debug", "info", "warning", "error")
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    # Lazy: .runtime imports psycopg at module load; deferring it keeps the
    # pure parse/validate helpers importable without DB deps (see RUNNING).
    from .runtime import LoaderConfig, configure_logging, open_pool

    configure_logging(args.log_level)

    database_url = args.database_url or os.environ.get("DATABASE_URL")
    if not database_url:
        logger.error("database_url_missing")
        print(
            "error: --database-url or $DATABASE_URL is required "
            "(postgres://user:pass@host:5432/db)",
            file=sys.stderr,
        )
        return 2
    cfg = LoaderConfig(database_url=database_url, dry_run=args.dry_run)

    async def _run() -> dict:
        async with open_pool(cfg) as pool:
            return await load(pool, args.manifests_dir, cfg)

    try:
        result = asyncio.run(_run())
    except Exception as err:  # noqa: BLE001 - CLI boundary: any failure → exit 1
        logger.error("topik_image_loader_failed", error=str(err))
        return 1
    logger.info("topik_image_loader_done", **result)
    # A missing expected test row means the environment is wrong
    # (load_topik.py has not seeded this paper); an admitted manifest that
    # landed ZERO rows means every one of its items is unseeded. Good
    # manifests are loaded, but the run must not read as clean (fail-loud —
    # the full contract is in EXIT CODES above).
    environment_wrong = result["tests_without_row"] or result["manifests_without_rows"]
    return 1 if environment_wrong else 0


if __name__ == "__main__":
    sys.exit(main())
