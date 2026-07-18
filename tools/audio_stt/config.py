"""Worker configuration from environment variables.

Mirrors tools/ingest/loaders/runtime.py's ``config_from_env`` conventions:
a frozen dataclass, values read once at startup, and a fail-fast
``SystemExit`` with an actionable message when a REQUIRED variable is
missing — a worker that boots with a half-configured environment would
otherwise fail minutes later mid-job (after claiming a row), which is
strictly worse than refusing to start.

Knobs:
    DATABASE_URL              (required) postgres://user:pass@host:5432/db
    AUDIO_UPLOAD_STORAGE_DIR  (required) root the tracks' relative blob_refs
                              resolve under (074's contract). Its ABSENCE on
                              disk is a startup WARNING, not an exit — the
                              server lazy-creates it on first write.
    AUDIO_STALE_RUN_MINUTES   default 60 — the stale-'running' reap threshold
                              (076 header). Sized well past the longest
                              plausible GPU transcription so a genuinely
                              live job is never reaped out from under a
                              slow-but-healthy worker.
    WHISPER_MODEL             default 'large-v3'
    WHISPER_DEVICE            default 'auto' (cuda if available, else cpu)
    WHISPER_COMPUTE_TYPE      default 'auto' (float16 on cuda, int8 on cpu)
    POLL_INTERVAL_SEC         default 5 — idle sleep between empty polls
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from pathlib import Path

import structlog

logger = structlog.get_logger(__name__)


@dataclass(frozen=True)
class WorkerConfig:
    database_url: str
    audio_storage_dir: Path
    stale_run_minutes: int = 60
    whisper_model: str = "large-v3"
    whisper_device: str = "auto"
    whisper_compute_type: str = "auto"
    poll_interval_sec: float = 5.0
    application_name: str = "korean-master-audio-stt"


def _require(name: str, hint: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"{name} is required ({hint})")
    return value


def _positive_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        raise SystemExit(f"{name} must be an integer, got {raw!r}") from None
    if value <= 0:
        raise SystemExit(f"{name} must be positive, got {value}")
    return value


def _positive_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = float(raw)
    except ValueError:
        raise SystemExit(f"{name} must be a number, got {raw!r}") from None
    # isfinite: float() happily parses 'nan' (every comparison False — it
    # would sail past a <= 0 check) and 'inf' (a poll interval that never
    # wakes). Both are misconfigurations; refuse to boot.
    if not math.isfinite(value) or value <= 0:
        raise SystemExit(f"{name} must be a positive finite number, got {value}")
    return value


def config_from_env() -> WorkerConfig:
    """Read worker config from environment variables (fail-fast on required)."""
    database_url = _require(
        "DATABASE_URL", "postgres://user:pass@host:5432/db"
    )
    storage_dir = _require(
        "AUDIO_UPLOAD_STORAGE_DIR",
        "the root audio_tracks.blob_ref paths resolve under",
    )
    audio_storage_dir = Path(storage_dir)
    if not audio_storage_dir.is_dir():
        # WARN, don't SystemExit: uploadStore lazy-creates the root on first
        # write, so a read-only worker may legitimately boot before the
        # first upload exists. But a TYPO'd path would otherwise boot clean
        # and then settle EVERY job 'failed' ("audio blob missing") —
        # poisoning the whole queue before anyone notices. Loud at startup.
        logger.warning(
            "AUDIO_UPLOAD_STORAGE_DIR does not exist (yet) — every job will "
            "fail 'audio blob missing' until it does; check for a typo",
            audio_storage_dir=str(audio_storage_dir),
        )
    return WorkerConfig(
        database_url=database_url,
        audio_storage_dir=audio_storage_dir,
        stale_run_minutes=_positive_int("AUDIO_STALE_RUN_MINUTES", 60),
        whisper_model=os.environ.get("WHISPER_MODEL") or "large-v3",
        whisper_device=os.environ.get("WHISPER_DEVICE") or "auto",
        whisper_compute_type=os.environ.get("WHISPER_COMPUTE_TYPE") or "auto",
        poll_interval_sec=_positive_float("POLL_INTERVAL_SEC", 5.0),
    )
