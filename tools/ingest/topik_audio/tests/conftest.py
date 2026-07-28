"""pytest config for the TOPIK audio segmenter tests.

Adds the repo root to sys.path so ``tools.ingest.topik_audio`` imports
without a package install (tools/audio_stt/tests/conftest.py's stance).

Everything here is engine-free: no faster-whisper, no GPU, no DB, no
pdftotext — the transcribe tests monkeypatch ``sys.modules``, the alignment
tests use synthetic transcripts, and the PDF tests parse text fixtures.
"""

from __future__ import annotations

import pathlib
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[4]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
