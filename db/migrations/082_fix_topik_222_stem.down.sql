-- migrate: non-destructive
-- =============================================================================
-- Migration 082 — TOPIK 83rd I 읽기 Q42 stem (DOWN)
--   Reverses 082_fix_topik_222_stem.up.sql: restores the pre-082 stem (the
--   transcription without the photo description) on the same
--   content-addressed guard. Loses nothing — both texts are spelled out in
--   full here and in the up body, so the change round-trips exactly.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this body in its own
--   transaction together with the bookkeeping DELETE.
-- =============================================================================

UPDATE topik_items
   SET stem = '[SNS 게시물 — 수미: 저는 지금 제주도예요. 여기 날씨가 정말 좋아요. / 민희: 와! 저도 가고 싶어요. / 수미: 네. 우리 다음에 같이 와요.♥]'
 WHERE stem = '[SNS 게시물 — 사진: 수미가 ''제주공항'' 표지판 앞에서 찍은 사진 / 수미: 저는 지금 제주도예요. 여기 날씨가 정말 좋아요. / 민희: 와! 저도 가고 싶어요. / 수미: 네. 우리 다음에 같이 와요.♥]'
   AND options->>0 = '수미 씨는 공항에 왔습니다.';

-- End of 082_fix_topik_222_stem.down.sql — runner owns the transaction (ADR-013).
