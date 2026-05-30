"""
Cross-reference resolver — CLI entry point.

Walks every loaded Darakwon entry's text-form cross-references and writes
FK links to `kgiu_entry_relations` / `vocab_entry_relations`. Idempotent
(natural-key upsert), resumable (per-corpus checkpoint), and produces a CSV
broken-ref report.

Usage:
    DATABASE_URL=postgresql://user:pass@host/db \\
    python -m tools.ingest.resolve_cross_references \\
        --corpus all \\
        --report-broken-refs

    DATABASE_URL=... \\
    python -m tools.ingest.resolve_cross_references \\
        --corpus kgiu_advanced --dry-run

Exit codes:
    0  — success (all corpora completed)
    1  — runtime error
    2  — prerequisites not met (corpora not loaded yet)
    3  — invalid CLI arguments

WHY a thin CLI on top of the package: the package is library-shaped so the
QA / dev-cycle harness can call it directly without re-parsing argv. The CLI
just handles argparse + logging + exit codes.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import os
import sys
from pathlib import Path
from typing import Sequence

import structlog

# Make `from resolver import ...` work when run as a script or `-m`.
_INGEST_DIR = Path(__file__).resolve().parent
if str(_INGEST_DIR) not in sys.path:
    sys.path.insert(0, str(_INGEST_DIR))

from psycopg_pool import AsyncConnectionPool  # noqa: E402

from resolver.models import ALL_CORPORA  # noqa: E402
from resolver.pipeline import (  # noqa: E402
    ResolverConfig,
    ResolverPrerequisiteError,
    run_all,
)

# Pull configure_logging from the existing loaders.runtime — same JSON
# structlog setup the rest of the ingest tools use.
from loaders.runtime import configure_logging  # noqa: E402

logger = structlog.get_logger(__name__)


_DEFAULT_REPO_ROOT = _INGEST_DIR.parents[1]  # …/Repository/
_DEFAULT_OUTPUT_ROOT = _INGEST_DIR / "output"
# Renamed from `broken_cross_references.csv` to `unresolved_cross_references.csv`
# (REVIEW_C2 F2): the CSV legitimately covers BOTH broken refs (dropped, no DB
# row) and text-only successes (written to DB without an FK target). A
# `report_type` column distinguishes them so QA can filter without re-running
# the resolver.
_DEFAULT_BROKEN_REF_CSV = _INGEST_DIR / "unresolved_cross_references.csv"


def _parse_args(argv: Sequence[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="resolve_cross_references",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "--corpus",
        action="append",
        default=None,
        help="Corpus to resolve (repeatable). 'all' (default) means every "
             "loaded corpus.",
    )
    p.add_argument("--dry-run", action="store_true",
                   help="Resolve and tally, but don't write rows.")
    p.add_argument("--resume", action="store_true",
                   help="Continue from the per-corpus checkpoint instead of "
                        "starting over.")
    p.add_argument("--report-broken-refs", action="store_true",
                   help=f"Emit unresolved refs (broken + text-only) to "
                        f"{_DEFAULT_BROKEN_REF_CSV.relative_to(_DEFAULT_REPO_ROOT)} "
                        f"(or --unresolved-ref-out / legacy --broken-ref-out). "
                        f"The CSV's `report_type` column distinguishes "
                        f"`broken` (dropped, not in DB) from `text_only` "
                        f"(in DB without an FK target).")
    # New canonical flag (REVIEW_C2 F2).
    p.add_argument("--unresolved-ref-out", type=Path, default=None,
                   help="CSV path for the unresolved-refs report (broken + "
                        "text-only). Takes precedence over --broken-ref-out "
                        "if both are given.")
    # Legacy flag kept for backwards compatibility with the dev-cycle harness.
    p.add_argument("--broken-ref-out", type=Path, default=_DEFAULT_BROKEN_REF_CSV,
                   help="DEPRECATED — use --unresolved-ref-out. CSV path for "
                        "the unresolved-refs report (kept for back-compat).")
    p.add_argument("--log-level", default="info",
                   choices=("debug", "info", "warning", "error"))
    p.add_argument("--output-root", type=Path, default=_DEFAULT_OUTPUT_ROOT,
                   help="Directory containing Darakwon JSON files.")
    p.add_argument("--batch-size", type=int, default=100,
                   help="Per-batch flush size (default 100).")
    return p.parse_args(argv)


def _resolve_corpora(arg: list[str] | None) -> list[str]:
    if not arg or arg == ["all"]:
        return sorted(ALL_CORPORA)
    out: list[str] = []
    invalid: list[str] = []
    for c in arg:
        if c == "all":
            continue
        if c not in ALL_CORPORA:
            invalid.append(c)
        else:
            out.append(c)
    if invalid:
        raise ValueError(
            f"Unknown corpus value(s): {invalid}. "
            f"Allowed: {sorted(ALL_CORPORA)} (or 'all')"
        )
    return sorted(set(out))


def _write_unresolved_ref_csv(path: Path, results: dict) -> tuple[int, int]:
    """Write the unresolved-refs CSV.

    Returns ``(broken_rows, text_only_rows)`` so the caller can log a
    breakdown. The CSV's first column is ``report_type`` which is either
    ``"broken"`` (the ref was dropped — no DB row written) or
    ``"text_only"`` (the ref is in the DB without an FK target).

    REVIEW_C2 F2: previously these were conflated under a "broken" name and
    every text-only success was reported as broken. The split is structural
    (in ``_process_entry``) and surfaced here in the report.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    broken_rows = 0
    text_only_rows = 0
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        header = (
            "report_type",
            "source_corpus",
            "source_entry_id",
            "source_pattern",
            "relation_type",
            "target_text",
            "reason",
        )
        writer.writerow(header)
        for corpus, result in sorted(results.items()):
            for br in result.broken:
                writer.writerow(("broken",) + br.csv_row())
                broken_rows += 1
            for to in result.text_only_reports:
                writer.writerow(("text_only",) + to.csv_row())
                text_only_rows += 1
    return broken_rows, text_only_rows


async def _async_main(args: argparse.Namespace) -> int:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        logger.error("missing_database_url")
        print("ERROR: DATABASE_URL env var is required.", file=sys.stderr)
        return 2

    try:
        corpora = _resolve_corpora(args.corpus)
    except ValueError as ex:
        print(f"ERROR: {ex}", file=sys.stderr)
        return 3

    cfg = ResolverConfig(
        database_url=database_url,
        output_root=args.output_root,
        dry_run=args.dry_run,
        resume=args.resume,
        batch_size=args.batch_size,
    )

    pool = AsyncConnectionPool(
        cfg.database_url,
        min_size=1,
        max_size=4,
        kwargs={"application_name": cfg.application_name},
        open=False,
    )
    await pool.open(wait=True, timeout=30)
    try:
        try:
            results = await run_all(pool, corpora=corpora, cfg=cfg)
        except ResolverPrerequisiteError as ex:
            logger.error("prerequisite_not_met", error=str(ex))
            print(f"ERROR: {ex}", file=sys.stderr)
            return 2

        # Summarize.
        totals = {"extracted": 0, "resolved": 0, "text_only": 0, "broken": 0,
                  "rows_written": 0, "rows_unchanged": 0}
        for corpus, r in results.items():
            c = r.counters
            totals["extracted"] += c.refs_extracted
            totals["resolved"] += c.refs_resolved
            totals["text_only"] += c.refs_text_only
            totals["broken"] += c.refs_broken
            totals["rows_written"] += c.rows_written
            totals["rows_unchanged"] += c.rows_unchanged
            logger.info(
                "summary_per_corpus",
                corpus=corpus,
                **c.model_dump(),
                broken_count=len(r.broken),
            )

        logger.info("summary_totals", **totals, corpora_count=len(results))

        if args.report_broken_refs:
            # `--unresolved-ref-out` is the canonical flag; fall back to the
            # legacy `--broken-ref-out` so older harness invocations keep
            # working (REVIEW_C2 F2).
            out_path = args.unresolved_ref_out or args.broken_ref_out
            broken_rows, text_only_rows = _write_unresolved_ref_csv(
                out_path, results
            )
            logger.info(
                "unresolved_ref_report_written",
                path=str(out_path),
                broken_rows=broken_rows,
                text_only_rows=text_only_rows,
                total=broken_rows + text_only_rows,
            )

        return 0
    finally:
        await pool.close()


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(list(sys.argv[1:]) if argv is None else list(argv))
    configure_logging(args.log_level)
    try:
        return asyncio.run(_async_main(args))
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        return 130
    except Exception as ex:  # noqa: BLE001 — top-level CLI guard logs+exits
        logger.exception("resolver_unhandled_exception", error=str(ex))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
