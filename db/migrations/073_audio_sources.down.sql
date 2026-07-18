-- migrate: destructive
-- 073 (down): drop audio_sources.
--
-- LOSSY but self-contained: every audio-set row (per-set metadata, lifecycle,
-- book pairing) is discarded. The set metadata is re-derivable by re-running
-- the Track A loader over the corpus manifest, so nothing irreplaceable is
-- lost — but the drop is still gated (explicit destructive marker + DROP
-- TABLE sniff; migrate.py requires --allow-destructive).
--
-- In the merged chain this down only ever runs AFTER 074's (the runner rolls
-- back in reverse numeric order), so no audio_tracks rows still FK this
-- table by the time it drops (uq_audio_sources_id_user — 074's composite-FK
-- backing — drops with the table too). book_uploads is untouched — 073 added
-- no columns or constraints to it: the composite fk_audio_sources_upload
-- lives on THIS table and goes down with it, and the uq_book_uploads_id_user
-- it rode belongs to (and stays with) 044.
--
-- ADR-013: no top-level BEGIN/COMMIT — the runner owns the transaction.

DROP TABLE IF EXISTS audio_sources;

-- End of 073_audio_sources.down.sql
