-- migrate: non-destructive
-- =============================================================================
-- Migration 082 — TOPIK 83rd I 읽기 Q42 stem: restore the photo context (B-031)
--   UP — rewrites ONE topik_items row's stem (the 83rd TOPIK I reading
--        item 42, id 222 in production) to include the photo description its
--        transcription dropped.
--   Reverse: 082_fix_topik_222_stem.down.sql
--   Depends on: 005_lesson_podcast_topik (topik_items).
--
-- WHY (B-031, verified against the source scan 2026-08-12)
--   The item was filed as an OCR glitch in option ① ("수미 씨는 공항에
--   왔습니다."). Investigation against the official test paper
--   (83rd-TOPIK-I-Reading-Test-Paper.pdf, booklet p.12) shows the option text
--   matches the paper VERBATIM — the real defect is in the stem's
--   transcription. The original item is an SNS post whose PHOTO shows 수미
--   in front of a '제주공항' (Jeju Airport) sign; that photo is what makes
--   option ① a TRUE statement (the task: "맞지 않는 것을 고르십시오", answer
--   ④). The ingest transcription captured only the comment thread, so in the
--   text-only app option ① reads as false and the item appears to have two
--   wrong answers. This migration adds the photo description to the bracketed
--   curator transcription, restoring the information the item needs to be
--   answerable. No option text or answer key is touched.
--
-- CONTENT-ADDRESSED + IDEMPOTENT
--   The UPDATE keys on the exact current stem AND option-① text — not on a
--   hard-coded id — so it:
--     * touches nothing on a database where the row was already fixed,
--       re-ingested differently, or never loaded (fresh test DBs: 0 rows);
--     * is safe to re-apply (after the first apply, no row matches).
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this body in its own
--   transaction together with the bookkeeping INSERT.
-- =============================================================================

UPDATE topik_items
   SET stem = '[SNS 게시물 — 사진: 수미가 ''제주공항'' 표지판 앞에서 찍은 사진 / 수미: 저는 지금 제주도예요. 여기 날씨가 정말 좋아요. / 민희: 와! 저도 가고 싶어요. / 수미: 네. 우리 다음에 같이 와요.♥]'
 WHERE stem = '[SNS 게시물 — 수미: 저는 지금 제주도예요. 여기 날씨가 정말 좋아요. / 민희: 와! 저도 가고 싶어요. / 수미: 네. 우리 다음에 같이 와요.♥]'
   AND options->>0 = '수미 씨는 공항에 왔습니다.';

-- End of 082_fix_topik_222_stem.up.sql — runner owns the transaction (ADR-013).
