#!/usr/bin/env python3
"""
load_to_postgres.py — orchestrator for the 9 corpus loaders.

See ADR-019 for the design. This file is intentionally small: it discovers
JSON files in the input directory, maps them to a loader module, and
dispatches them. All the real work happens in loaders/*.

Usage:

    export DATABASE_URL=postgres://user:pass@host:5432/db
    python -m tools.ingest.load_to_postgres --corpus all
    python -m tools.ingest.load_to_postgres --corpus ttmik --dry-run
    python -m tools.ingest.load_to_postgres --corpus topik --resume
    python -m tools.ingest.load_to_postgres --corpus ttmik_audio \
        --audio-dir /path/to/corpus   # dir CONTAINING the TTMIK/ mp3 tree

Exits 0 on success, non-zero on any loader failure.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path
from typing import Awaitable, Callable

import structlog

from .loaders import (
    load_hanja,
    load_iyagi,
    load_kgiu,
    load_topik,
    load_ttmik,
    load_ttmik_audio,
    load_vocab_2000,
)
from .loaders.runtime import (
    LoaderConfig,
    config_from_env,
    configure_logging,
    open_pool,
)

logger = structlog.get_logger(__name__)


ALL_CORPORA = (
    "ttmik",
    "iyagi",
    "topik",
    "kgiu_beginner",
    "kgiu_intermediate",
    "kgiu_advanced",
    "vocab_2000_beginner",
    "vocab_2000_intermediate",
    "hanja",
)

# Deliberately OUTSIDE ALL_CORPORA: the audio loader walks the corpus AUDIO
# tree (--audio-dir, the directory CONTAINING TTMIK/), not the parser-output
# JSON directory, and the audio mount is absent in the plain ingest container.
# It must be requested explicitly:
#   python -m tools.ingest.load_to_postgres --corpus ttmik_audio \
#       --audio-dir /path/to/corpus
AUDIO_CORPUS = "ttmik_audio"


def _discover_files(input_dir: Path, corpus: str) -> list[Path]:
    """Return source-JSON files for a given corpus name."""
    if corpus == "ttmik":
        return sorted(input_dir.glob("ttmik_*.json"))
    if corpus == "iyagi":
        return sorted(input_dir.glob("iyagi_*.json"))
    if corpus == "topik":
        return sorted(input_dir.glob("topik_*.json"))
    if corpus == "kgiu_beginner":
        return sorted(input_dir.glob("grammar_kgiu_beginner.json"))
    if corpus == "kgiu_intermediate":
        return sorted(input_dir.glob("grammar_kgiu_intermediate.json"))
    if corpus == "kgiu_advanced":
        return sorted(input_dir.glob("grammar_kgiu_advanced.json"))
    if corpus == "vocab_2000_beginner":
        return sorted(input_dir.glob("vocab_2000_beginner.json"))
    if corpus == "vocab_2000_intermediate":
        return sorted(input_dir.glob("vocab_2000_intermediate.json"))
    if corpus == "hanja":
        # Single committed file (build_hanja.py output); not a glob family.
        path = input_dir / "hanja.json"
        return [path] if path.exists() else []
    raise ValueError(f"Unknown corpus: {corpus!r}")


# Loader module dispatch. Each loader exposes ``load(pool, source_path, cfg)``.
LoaderFn = Callable[..., Awaitable[dict]]

_DISPATCH: dict[str, LoaderFn] = {
    "ttmik": load_ttmik.load,
    "iyagi": load_iyagi.load,
    "topik": load_topik.load,
    "kgiu_beginner": load_kgiu.load,
    "kgiu_intermediate": load_kgiu.load,
    "kgiu_advanced": load_kgiu.load,
    "vocab_2000_beginner": load_vocab_2000.load,
    "vocab_2000_intermediate": load_vocab_2000.load,
    "hanja": load_hanja.load,
    # Not JSON-driven: its "source path" is the corpus audio ROOT (see run()).
    AUDIO_CORPUS: load_ttmik_audio.load,
}


async def run(
    *,
    corpora: tuple[str, ...],
    input_dir: Path,
    cfg: LoaderConfig,
    audio_dir: Path | None = None,
) -> dict[str, list[dict]]:
    """Run the configured loaders. Returns per-corpus result dicts."""
    results: dict[str, list[dict]] = {c: [] for c in corpora}
    async with open_pool(cfg) as pool:
        for corpus in corpora:
            if corpus == AUDIO_CORPUS:
                # The audio loader's "source" is a directory tree, not a JSON
                # file. main() has already validated --audio-dir is present.
                assert audio_dir is not None, "--audio-dir required for ttmik_audio"
                files = [audio_dir]
            else:
                files = _discover_files(input_dir, corpus)
            if not files:
                logger.warning("no_files_found", corpus=corpus)
                continue
            loader = _DISPATCH[corpus]
            for src in files:
                logger.info("loader_start", corpus=corpus, source_path=str(src))
                if cfg.dry_run:
                    logger.info("dry_run_skipped", source_path=str(src))
                    results[corpus].append(
                        {"source_path": str(src), "status": "dry_run"}
                    )
                    continue
                try:
                    result = await loader(pool, src, cfg)
                except Exception as err:
                    logger.error(
                        "loader_failed",
                        corpus=corpus,
                        source_path=str(src),
                        error=str(err),
                    )
                    raise
                results[corpus].append({"source_path": str(src), **result})
    return results


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Korean Master corpus loader")
    p.add_argument(
        "--corpus",
        required=True,
        choices=("all",) + ALL_CORPORA + (AUDIO_CORPUS,),
        help=(
            "Corpus name to load, or 'all' for every known JSON corpus "
            f"('{AUDIO_CORPUS}' is opt-in only; it needs --audio-dir)."
        ),
    )
    p.add_argument(
        "--input-dir",
        type=Path,
        default=Path(__file__).resolve().parent / "output",
        help="Directory containing parser output JSON files.",
    )
    p.add_argument(
        "--audio-dir",
        type=Path,
        default=None,
        help=(
            "Corpus audio ROOT (the directory containing TTMIK/). Required "
            f"when --corpus {AUDIO_CORPUS}; ignored otherwise."
        ),
    )
    p.add_argument(
        "--dry-run", action="store_true", help="Discover and validate; do not write."
    )
    p.add_argument(
        "--resume",
        action="store_true",
        help="(default behavior) Skip already-complete sources whose sha256 matches.",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="Re-load regardless of load_state status / sha256 match.",
    )
    p.add_argument(
        "--batch-size", type=int, default=200, help="Rows per transactional batch."
    )
    p.add_argument(
        "--log-level",
        default="info",
        choices=("debug", "info", "warning", "error"),
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    configure_logging(args.log_level)
    base = config_from_env()
    cfg = LoaderConfig(
        database_url=base.database_url,
        batch_size=args.batch_size,
        dry_run=args.dry_run,
        force=args.force,
        application_name="korean-master-loader",
    )
    corpora = ALL_CORPORA if args.corpus == "all" else (args.corpus,)
    if AUDIO_CORPUS in corpora and args.audio_dir is None:
        logger.error(
            "audio_dir_required",
            hint=f"--corpus {AUDIO_CORPUS} needs --audio-dir <corpus root>",
        )
        return 1
    try:
        results = asyncio.run(
            run(
                corpora=corpora,
                input_dir=args.input_dir,
                cfg=cfg,
                audio_dir=args.audio_dir,
            )
        )
    except Exception as err:
        logger.error("orchestrator_failed", error=str(err))
        return 1
    for corpus, files in results.items():
        for r in files:
            logger.info("loader_done", corpus=corpus, **r)
    return 0


if __name__ == "__main__":
    sys.exit(main())
