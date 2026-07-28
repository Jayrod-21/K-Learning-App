"""TOPIK listening-audio segmenter (Phase 2b of docs/TOPIK_MOCK_AUDIO_PLAN.md).

Turns each official whole-section listening MP3 + its question structure into
per-question audio offset windows, emitted as one JSON artifact per paper
under ``tools/ingest/output/topik_audio_segments/``. The Phase-3 loader
(``load_topik_audio.py``) consumes those artifacts; this package never
touches the DB schema and never writes to the DB (the runner only READS the
question structure when no ``--structure`` file is given).

Modules (import side-effect free — no engine, no GPU at import time):
  - ``transcribe``     tuned faster-whisper transcription, cached by the
                       MP3's sha256 (lazy engine import, pure mapping helper)
  - ``segment``        the PURE alignment core — spoken "N번" anchors +
                       validation-text fallback -> per-unit spans
  - ``transcript_pdf`` official Listening-Transcript PDF -> per-item spoken
                       text (the confidence validation target; QA-only)
  - ``run``            per-paper CLI orchestration + QA report
"""
