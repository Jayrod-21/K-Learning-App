"""config_from_env — fail-fast on required vars, defaults, validation."""

from __future__ import annotations

from pathlib import Path

import pytest
import structlog

from tools.audio_stt.config import config_from_env

REQUIRED = {
    "DATABASE_URL": "postgres://u:p@localhost:5432/km",
    "AUDIO_UPLOAD_STORAGE_DIR": "/data/audio",
}

OPTIONAL = [
    "AUDIO_STALE_RUN_MINUTES",
    "WHISPER_MODEL",
    "WHISPER_DEVICE",
    "WHISPER_COMPUTE_TYPE",
    "POLL_INTERVAL_SEC",
]


def set_required(monkeypatch) -> None:
    for k, v in REQUIRED.items():
        monkeypatch.setenv(k, v)
    for k in OPTIONAL:
        monkeypatch.delenv(k, raising=False)


def test_defaults(monkeypatch) -> None:
    set_required(monkeypatch)
    cfg = config_from_env()
    assert cfg.database_url == REQUIRED["DATABASE_URL"]
    assert cfg.audio_storage_dir == Path("/data/audio")
    assert cfg.stale_run_minutes == 60
    assert cfg.whisper_model == "large-v3"
    assert cfg.whisper_device == "auto"
    assert cfg.whisper_compute_type == "auto"
    assert cfg.poll_interval_sec == 5.0


def test_overrides(monkeypatch) -> None:
    set_required(monkeypatch)
    monkeypatch.setenv("AUDIO_STALE_RUN_MINUTES", "120")
    monkeypatch.setenv("WHISPER_MODEL", "medium")
    monkeypatch.setenv("WHISPER_DEVICE", "cuda")
    monkeypatch.setenv("WHISPER_COMPUTE_TYPE", "float16")
    monkeypatch.setenv("POLL_INTERVAL_SEC", "0.5")
    cfg = config_from_env()
    assert cfg.stale_run_minutes == 120
    assert cfg.whisper_model == "medium"
    assert cfg.whisper_device == "cuda"
    assert cfg.whisper_compute_type == "float16"
    assert cfg.poll_interval_sec == 0.5


@pytest.mark.parametrize("missing", sorted(REQUIRED))
def test_missing_required_fails_fast(monkeypatch, missing: str) -> None:
    set_required(monkeypatch)
    monkeypatch.delenv(missing)
    with pytest.raises(SystemExit, match=missing):
        config_from_env()


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("AUDIO_STALE_RUN_MINUTES", "abc"),
        ("AUDIO_STALE_RUN_MINUTES", "0"),
        ("AUDIO_STALE_RUN_MINUTES", "-5"),
        ("POLL_INTERVAL_SEC", "nope"),
        ("POLL_INTERVAL_SEC", "0"),
        # float() parses these happily; nan sails past a <= 0 check (every
        # comparison is False) and inf never wakes — both must refuse boot.
        ("POLL_INTERVAL_SEC", "nan"),
        ("POLL_INTERVAL_SEC", "inf"),
        ("POLL_INTERVAL_SEC", "-inf"),
    ],
)
def test_invalid_numeric_fails_fast(monkeypatch, name: str, value: str) -> None:
    set_required(monkeypatch)
    monkeypatch.setenv(name, value)
    with pytest.raises(SystemExit, match=name):
        config_from_env()


def test_missing_storage_dir_warns_but_still_boots(monkeypatch, tmp_path) -> None:
    """S-SF2: a nonexistent AUDIO_UPLOAD_STORAGE_DIR is a startup WARNING,
    not an exit — the server lazy-creates it on first write, so a read-only
    worker may boot first. But a typo'd dir would poison the whole queue
    ('audio blob missing' on every job), so it must be loud."""
    set_required(monkeypatch)
    missing = tmp_path / "does-not-exist"
    monkeypatch.setenv("AUDIO_UPLOAD_STORAGE_DIR", str(missing))
    with structlog.testing.capture_logs() as logs:
        cfg = config_from_env()
    assert cfg.audio_storage_dir == missing
    warnings = [e for e in logs if e["log_level"] == "warning"]
    assert warnings, "a missing storage dir must warn at startup"
    assert any(
        "AUDIO_UPLOAD_STORAGE_DIR" in e["event"]
        and e["audio_storage_dir"] == str(missing)
        for e in warnings
    )


def test_existing_storage_dir_boots_quietly(monkeypatch, tmp_path) -> None:
    set_required(monkeypatch)
    monkeypatch.setenv("AUDIO_UPLOAD_STORAGE_DIR", str(tmp_path))
    with structlog.testing.capture_logs() as logs:
        cfg = config_from_env()
    assert cfg.audio_storage_dir == tmp_path
    assert logs == []
