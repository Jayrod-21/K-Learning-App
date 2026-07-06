"""
Build canonical-grammar clusters from the 3 KGIU level JSONs and (optionally)
populate the `canonical_grammar` table + back-fill `kgiu_entries.canonical_grammar_id`.

Run modes:

    # Just compute the cluster file, no DB:
    python -m tools.ingest.cluster_canonical_grammar build \\
        --output Repository/tools/ingest/canonical_grammar_clusters.json

    # Compute + populate Postgres (idempotent):
    DATABASE_URL=postgres://... python -m tools.ingest.cluster_canonical_grammar apply \\
        --output Repository/tools/ingest/canonical_grammar_clusters.json

WHY split build vs apply: the cluster file is a reviewable artefact (a
senior reviewer can audit it before the data lands in the DB). `apply`
reads from a precomputed cluster file by default so what lands in the DB
exactly matches what was reviewed; `--regenerate` rebuilds from source.

CONTRACT:
    * Both modes are idempotent. Re-running `apply` doesn't create
      duplicates: canonical rows upsert on `pattern_key` UNIQUE, and the
      `kgiu_entries.canonical_grammar_id` set-pass is `UPDATE … WHERE
      canonical_grammar_id IS DISTINCT FROM new_id`.
    * Parameterised queries everywhere. No string-format SQL.
    * Structured logging via `structlog`.
    * Connects via `application_name = korean-master-canonical-grammar` for
      `pg_stat_activity` observability.
    * Reads `DATABASE_URL` from the environment. Bails loudly if it isn't
      set in `apply` mode.

WHAT THIS SCRIPT DOES NOT DO:
    * Resolve cross-references between `kgiu_entries` rows (C2 owns).
    * Touch `topik_dependencies` (C4 owns).
    * Override existing senior-reviewer-set semantic families. The
      `apply` upsert uses `ON CONFLICT … DO UPDATE` on the *display*
      columns only (canonical_pattern, aliases, members_per_level);
      `semantic_family` is left as the existing value if a row already
      exists, so a reviewer's manual override is preserved across reruns.
"""

from __future__ import annotations

import argparse
import collections
import datetime as _dt
import json
import logging
import os
import pathlib
import re
import sys
from typing import Any

import structlog

# When run as a script (python path/to/script.py) the sibling module isn't
# importable without sys.path help. We support both:
#   (a) script invocation:  python tools/ingest/cluster_canonical_grammar.py …
#   (b) module invocation:  python -m tools.ingest.cluster_canonical_grammar …
#   (c) import from tests:  import cluster_canonical_grammar as ccg
# by adding our own directory (the sibling module's home) to sys.path BEFORE
# the local import, then falling back to bare-name import.
_HERE = pathlib.Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
_REPO_ROOT = _HERE.parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# Local imports (after sys.path tweak). Import the BARE module name FIRST: the
# rest of the ingest suite resolves it that way (conftest puts tools/ingest/ on
# sys.path; every test + sibling loader imports `canonical_grammar` bare), and
# _HERE is on sys.path under all three invocation modes above, so the bare import
# always succeeds. Preferring the package form here loaded canonical_grammar
# under TWO module identities (bare in the tests, tools.ingest.* here) whose
# distinct PatternOccurrence classes then failed pydantic's isinstance check on
# CanonicalCluster.members — a module-identity split. The package form stays as a
# fallback for any context where the bare name is not importable.
try:  # pragma: no cover — import-mode plumbing
    from canonical_grammar import (  # noqa: E402
        CanonicalCluster,
        ClusterDocument,
        PatternOccurrence,
        classify_semantic_family,
        normalize_pattern,
        pick_canonical_surface,
        split_compound_pattern,
    )
except ImportError:  # pragma: no cover
    from tools.ingest.canonical_grammar import (  # type: ignore[no-redef,import-not-found]  # noqa: E402
        CanonicalCluster,
        ClusterDocument,
        PatternOccurrence,
        classify_semantic_family,
        normalize_pattern,
        pick_canonical_surface,
        split_compound_pattern,
    )


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


def _configure_logging(level: str) -> structlog.stdlib.BoundLogger:
    """Configure structlog → stdlib logging at the requested level."""
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stderr,
        level=getattr(logging, level.upper(), logging.INFO),
    )
    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, level.upper(), logging.INFO)
        ),
    )
    return structlog.get_logger("canonical_grammar")


# ---------------------------------------------------------------------------
# Source-file map
# ---------------------------------------------------------------------------

# Path → (corpus, level). Resolved relative to the repo root at runtime so
# the script works whether invoked from / or from Repository/.
_DEFAULT_INPUTS: list[tuple[str, str, str]] = [
    ("Repository/tools/ingest/output/grammar_kgiu_beginner.json",
     "kgiu_beginner", "beginner"),
    ("Repository/tools/ingest/output/grammar_kgiu_intermediate.json",
     "kgiu_intermediate", "intermediate"),
    ("Repository/tools/ingest/output/grammar_kgiu_advanced.json",
     "kgiu_advanced", "advanced"),
]


def _resolve_input(path: str) -> pathlib.Path:
    """Resolve a possibly-relative source path.

    Tries (in order):
        1. absolute path, if given.
        2. cwd-relative (the operator's natural invocation).
        3. relative to the repo root (Repository/...).
        4. relative to the directory ABOVE the repo root (when the operator
           starts the command from outside Repository/).
    """
    p = pathlib.Path(path)
    if p.is_absolute():
        return p
    for base in (pathlib.Path.cwd(), _REPO_ROOT, _REPO_ROOT.parent):
        candidate = base / p
        if candidate.exists():
            return candidate
    # Fall through — caller's FileNotFoundError will report the relative path.
    return _REPO_ROOT / p


# ---------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------


def _load_occurrences(log: structlog.stdlib.BoundLogger) -> tuple[list[PatternOccurrence], int]:
    """Read the 3 KGIU JSONs and emit one PatternOccurrence per pattern-bearing row.

    Compound patterns ("N와/과, N(이)랑, N하고") are split: each component
    is its own occurrence so all three feed into their respective
    canonical clusters. The raw row's full string is preserved as
    `pattern_raw` on each emitted occurrence; the SUB-pattern that was
    extracted is stored in `pattern_normalized` (after normalization).

    Returns `(occurrences, total_rows_seen)`.
    """
    occurrences: list[PatternOccurrence] = []
    total_rows_seen = 0
    for rel, corpus, level in _DEFAULT_INPUTS:
        src = _resolve_input(rel)
        if not src.exists():
            raise FileNotFoundError(f"Source not found: {src}")
        log.info("read_source", path=str(src), corpus=corpus)
        with src.open(encoding="utf-8") as fh:
            doc = json.load(fh)
        items = doc.get("items", [])
        total_rows_seen += len(items)
        for item in items:
            pattern_raw = item.get("pattern")
            if not pattern_raw:
                continue
            sub_keys = split_compound_pattern(pattern_raw)
            if not sub_keys:
                # Pattern present but normalized to empty (e.g. "—" only).
                log.warning(
                    "empty_normalized_pattern",
                    corpus=corpus,
                    source_id=item.get("id"),
                    pattern_raw=pattern_raw,
                )
                continue
            for key in sub_keys:
                occurrences.append(
                    PatternOccurrence(
                        corpus=corpus,                # type: ignore[arg-type]
                        source_id=item["id"],
                        pattern_raw=pattern_raw,
                        pattern_normalized=key,
                        level=level,                  # type: ignore[arg-type]
                        title_en=item.get("title_en"),
                        category=item.get("category"),
                    )
                )
    log.info(
        "occurrences_extracted",
        total_rows_seen=total_rows_seen,
        occurrence_count=len(occurrences),
    )
    return occurrences, total_rows_seen


def _build_clusters(occurrences: list[PatternOccurrence]) -> list[CanonicalCluster]:
    """Group occurrences by `pattern_normalized` and build CanonicalClusters.

    Output order is by (pattern_key) for stable diffs across runs.

    `needs_review` is True when at least two members of the cluster have
    distinct ordinal markers (e.g. -(으)니까 ① and -(으)니까 ②) — that's
    the signal Darakwon uses for "same surface, different sense", and a
    human reviewer should decide whether to split the canonical row.
    """
    by_key: dict[str, list[PatternOccurrence]] = collections.defaultdict(list)
    for occ in occurrences:
        by_key[occ.pattern_normalized].append(occ)

    clusters: list[CanonicalCluster] = []
    for key, members in sorted(by_key.items()):
        # Aliases = distinct raw surfaces actually seen.
        aliases = sorted({m.pattern_raw for m in members})
        canonical_surface = pick_canonical_surface(aliases)

        # Vote for semantic family. Each member casts a heuristic guess;
        # we take the mode. "uncategorized" is only chosen if every member
        # was uncategorized.
        family_votes = collections.Counter(
            classify_semantic_family(
                category=m.category, title_en=m.title_en, pattern=m.pattern_raw
            )
            for m in members
        )
        non_uncat = {k: v for k, v in family_votes.items() if k != "uncategorized"}
        family = max(non_uncat.items(), key=lambda kv: (kv[1], kv[0]))[0] if non_uncat \
            else "uncategorized"

        per_level = collections.Counter(m.level for m in members)

        # Polysemy review flag.
        #
        # Two trigger cases (REVIEW_C1 SHOULD-FIX-2):
        #   (a) Two or more DISTINCT ordinal markers across members —
        #       e.g., "-(으)니까 ①" and "-(으)니까 ②". Same surface key,
        #       Darakwon's own signal that the senses differ.
        #   (b) At least one member has an ordinal AND at least one member
        #       does NOT — e.g., "-(으)니까 ②" alongside "-(으)니까" (bare).
        #       The bare form usually represents the IMPLICIT first sense
        #       (①); pairing it with an explicit ordinal almost always
        #       means polysemy and the cluster should be reviewed.
        #
        # The original implementation only fired on case (a), missing the
        # common "one ordinal + one bare" case.
        ordinals = {
            _extract_ordinal(m.pattern_raw)
            for m in members
        } - {None}
        bare_count = sum(
            1 for m in members if _extract_ordinal(m.pattern_raw) is None
        )
        needs_review = len(ordinals) >= 2 or (
            len(ordinals) >= 1 and bare_count >= 1
        )
        review_reason: str | None = None
        if needs_review:
            if len(ordinals) >= 2:
                review_reason = (
                    f"Polysemy: distinct ordinal markers {sorted(ordinals)} share "
                    f"key '{key}'. Review whether to split the canonical row."
                )
            else:
                review_reason = (
                    f"Polysemy: ordinal marker {sorted(ordinals)} coexists with "
                    f"a bare (implicit-①) member on key '{key}'. The bare form "
                    f"is most likely sense ① while the marked form is a "
                    f"different sense; review whether to split."
                )

        clusters.append(CanonicalCluster(
            pattern_key=key,
            canonical_pattern=canonical_surface,
            semantic_family=family,
            aliases=aliases,
            members=sorted(
                members,
                key=lambda m: (m.level, m.corpus, m.source_id),
            ),
            members_per_level={lvl: per_level.get(lvl, 0) for lvl in
                               ("beginner", "intermediate", "advanced")
                               if per_level.get(lvl, 0) > 0},
            needs_review=needs_review,
            review_reason=review_reason,
        ))
    return clusters


# Mirrors the upper bound of canonical_grammar._CIRCLED_DIGITS_RE so the
# polysemy detector recognises every ordinal the normaliser strips
# (REVIEW_C1 NIT-1). Keep the two regexes in sync if either is ever extended.
_ORDINAL_RE_LOCAL = re.compile(r"[①-⑳㉑-㉟㊱-㊿]")


def _extract_ordinal(raw: str) -> str | None:
    """Return the (first) circled-digit ordinal in `raw`, or None."""
    if not raw:
        return None
    m = _ORDINAL_RE_LOCAL.search(raw)
    return m.group(0) if m else None


# ---------------------------------------------------------------------------
# `build` subcommand — produce the JSON cluster file.
# ---------------------------------------------------------------------------


def _cmd_build(args: argparse.Namespace) -> int:
    log = _configure_logging(args.log_level)
    occurrences, total_rows = _load_occurrences(log)
    clusters = _build_clusters(occurrences)
    doc = ClusterDocument(
        generated_at=_dt.datetime.now(_dt.timezone.utc).isoformat(),
        source_files=[rel for rel, _, _ in _DEFAULT_INPUTS],
        total_rows_in=total_rows,
        total_pattern_rows=len(occurrences),
        total_clusters=len(clusters),
        multi_level_clusters=sum(1 for c in clusters if len(c.members_per_level) > 1),
        clusters=clusters,
    )
    out_path = pathlib.Path(args.output).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        doc.model_dump_json(indent=2) + "\n", encoding="utf-8"
    )
    log.info(
        "wrote_cluster_file",
        path=str(out_path),
        total_clusters=doc.total_clusters,
        multi_level_clusters=doc.multi_level_clusters,
        review_flagged=sum(1 for c in clusters if c.needs_review),
    )
    return 0


# ---------------------------------------------------------------------------
# `apply` subcommand — populate canonical_grammar + back-fill FKs.
# ---------------------------------------------------------------------------


def _cmd_apply(args: argparse.Namespace) -> int:
    log = _configure_logging(args.log_level)

    if args.regenerate or not pathlib.Path(args.output).exists():
        log.info("regenerating_clusters", reason="--regenerate or no cluster file found")
        occurrences, total_rows = _load_occurrences(log)
        clusters = _build_clusters(occurrences)
    else:
        log.info("reading_clusters", path=args.output)
        doc = ClusterDocument.model_validate_json(
            pathlib.Path(args.output).read_text(encoding="utf-8")
        )
        clusters = doc.clusters

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise SystemExit("DATABASE_URL is required in `apply` mode")

    # Import psycopg lazily so `build` works without it installed.
    import psycopg  # noqa: WPS433

    with psycopg.connect(dsn, application_name="korean-master-canonical-grammar") as conn:
        conn.autocommit = False
        with conn.cursor() as cur:
            _ensure_table_exists(cur, log)
            inserted, updated = _upsert_clusters(cur, clusters, log)
            backfilled = _backfill_kgiu_entries(cur, clusters, log)
        conn.commit()

    log.info(
        "apply_complete",
        clusters_inserted=inserted,
        clusters_updated=updated,
        kgiu_rows_backfilled=backfilled,
    )
    return 0


def _ensure_table_exists(cur, log) -> None:
    """Sanity check: refuse to write if migration 006 hasn't been applied."""
    cur.execute(
        """
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'canonical_grammar'
        """
    )
    if cur.fetchone() is None:
        raise SystemExit(
            "Table `canonical_grammar` not found. Run migration 006 first: "
            "python -m db.migrate up"
        )


def _upsert_clusters(cur, clusters, log) -> tuple[int, int]:
    """Upsert one row per cluster into canonical_grammar.

    `semantic_family` only sets on INSERT — see module docstring. Display
    columns and the JSONB `notes` payload sync on every run so the table
    stays consistent with the latest cluster build.
    """
    sql = """
        INSERT INTO canonical_grammar
            (pattern_key, canonical_pattern, semantic_family, notes)
        VALUES
            (%(pattern_key)s, %(canonical_pattern)s, %(semantic_family)s, %(notes)s::jsonb)
        ON CONFLICT (pattern_key) DO UPDATE SET
            canonical_pattern = EXCLUDED.canonical_pattern,
            notes             = EXCLUDED.notes,
            updated_at        = now(),
            version           = canonical_grammar.version + 1
        WHERE
            canonical_grammar.canonical_pattern IS DISTINCT FROM EXCLUDED.canonical_pattern
            OR canonical_grammar.notes          IS DISTINCT FROM EXCLUDED.notes
        RETURNING (xmax = 0) AS inserted
    """
    inserted = updated = 0
    for c in clusters:
        notes_payload = {
            "aliases": c.aliases,
            "members_per_level": c.members_per_level,
            "needs_review": c.needs_review,
            "review_reason": c.review_reason,
            "member_count": len(c.members),
        }
        cur.execute(sql, {
            "pattern_key": c.pattern_key,
            "canonical_pattern": c.canonical_pattern,
            "semantic_family": c.semantic_family,
            "notes": json.dumps(notes_payload, ensure_ascii=False),
        })
        row = cur.fetchone()
        if row is None:
            # ON CONFLICT WHERE clause was false → no change, no return.
            continue
        if row[0]:
            inserted += 1
        else:
            updated += 1
    log.info("upsert_clusters_done", inserted=inserted, updated=updated,
             total=len(clusters))
    return inserted, updated


def _backfill_kgiu_entries(cur, clusters, log) -> int:
    """Set kgiu_entries.canonical_grammar_id for every member of every cluster.

    Idempotent: only updates rows where the FK is actually changing. A
    member that no longer matches any cluster (rare — would mean source
    JSON edited between runs) is left untouched.
    """
    # Build a (corpus, source_id) → canonical_id map.
    # First fetch the canonical_id for each pattern_key in one query.
    pattern_keys = [c.pattern_key for c in clusters]
    if not pattern_keys:
        return 0
    cur.execute(
        "SELECT pattern_key, id FROM canonical_grammar WHERE pattern_key = ANY(%s)",
        (pattern_keys,),
    )
    key_to_id: dict[str, int] = dict(cur.fetchall())

    # Build update tuples.
    updates: list[tuple[int, str, str]] = []  # (canonical_id, corpus, source_id)
    for c in clusters:
        cid = key_to_id.get(c.pattern_key)
        if cid is None:
            log.warning("missing_canonical_id_after_upsert",
                        pattern_key=c.pattern_key)
            continue
        for m in c.members:
            updates.append((cid, m.corpus, m.source_id))

    if not updates:
        return 0

    # Batch via executemany with a parameterised UPDATE. `IS DISTINCT FROM`
    # makes the write a no-op when the FK is already correct (idempotent).
    #
    # Manual-override guard (REVIEW_C1 SHOULD-FIX-1 / migration 010):
    #   A reviewer can split a polysemous form into two canonical rows and
    #   manually re-point a kgiu row at the split. They set
    #   `canonical_grammar_id_is_manual_override = TRUE` in the same
    #   transaction. This backfill MUST then skip that row — otherwise the
    #   next `apply` rebuilds the original cluster, sees the kgiu row's
    #   current FK is DISTINCT FROM the auto id, and clobbers the override.
    #
    #   The WHERE clause includes the sentinel check so the override survives
    #   every subsequent `apply`. To re-enable auto-backfill on a row, the
    #   reviewer clears the sentinel.
    sql = """
        UPDATE kgiu_entries
        SET canonical_grammar_id = %s,
            updated_at           = now(),
            version              = version + 1
        WHERE corpus = %s
          AND source_id = %s
          AND canonical_grammar_id IS DISTINCT FROM %s
          AND canonical_grammar_id_is_manual_override = FALSE
    """
    backfilled = 0
    skipped_manual = 0
    for cid, corpus, source_id in updates:
        cur.execute(sql, (cid, corpus, source_id, cid))
        if cur.rowcount > 0:
            backfilled += cur.rowcount
        else:
            # Either the row was already correct (no-op) OR a reviewer flagged
            # it as a manual override. Distinguish the two by re-querying;
            # only worth doing at INFO level when an override is actually in
            # play (rare — counted, not logged per-row).
            cur.execute(
                "SELECT canonical_grammar_id_is_manual_override "
                "FROM kgiu_entries WHERE corpus = %s AND source_id = %s",
                (corpus, source_id),
            )
            row = cur.fetchone()
            if row is not None and row[0]:
                skipped_manual += 1
    log.info(
        "backfill_done",
        attempted=len(updates),
        updated=backfilled,
        skipped_manual_override=skipped_manual,
    )
    return backfilled


# ---------------------------------------------------------------------------
# Argparse
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="cluster_canonical_grammar",
        description="Build canonical-grammar clusters and (optionally) populate Postgres.",
    )
    p.add_argument("--log-level", default="info", choices=["debug", "info", "warning", "error"])
    sub = p.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="Write the cluster JSON; no DB.")
    b.add_argument("--output", required=True, help="Path for cluster JSON.")
    b.set_defaults(func=_cmd_build)

    a = sub.add_parser("apply", help="Populate canonical_grammar + backfill FKs.")
    a.add_argument("--output",
                   default="Repository/tools/ingest/canonical_grammar_clusters.json",
                   help="Cluster JSON to read (or regenerate).")
    a.add_argument("--regenerate", action="store_true",
                   help="Recompute clusters from source JSONs, ignoring the on-disk file.")
    a.set_defaults(func=_cmd_apply)

    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
