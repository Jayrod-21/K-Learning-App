-- 036 (down): drop ttmik_transcript_lines.
--
-- Lossy by design: rolling back discards the full-lesson transcripts. The
-- Lesson Scripts PDFs on the corpus mount are the system of record — after a
-- re-up, re-running tools/ingest/loaders/load_ttmik_transcript.py rebuilds
-- the table in full. ttmik_lessons / ttmik_sentences (the highlights) are
-- untouched. The trigger and the unique-constraint index are owned by the
-- table and go with it; set_updated_at() is shared (001) and must remain.

DROP TABLE IF EXISTS ttmik_transcript_lines;
