"""Out-of-band GPU Whisper transcription worker (Track A, A-2a).

Drains the ``audio_transcription_jobs`` queue (migration 076): claims
'pending' jobs FIFO with FOR UPDATE SKIP LOCKED, transcribes the claimed
track's audio blob via faster-whisper, persists timed segments into
``audio_transcript_segments`` (075), and settles the job + the track's
``transcript_status`` (074). Pure Python — packaging (CUDA image, compose)
is a separate sub-phase (A-2b).

Modules:
    config             — env-driven WorkerConfig (fail-fast on required vars)
    blobstore          — traversal-safe blob resolution under
                         AUDIO_UPLOAD_STORAGE_DIR (uploadStore.ts port)
    whisper_transcribe — faster-whisper wrapper mapping engine output to the
                         075 segment schema (lazy import: tests never need it)
    worker             — the claim/settle/reap loop (uploadExtract.ts's arc,
                         out-of-band)
"""
