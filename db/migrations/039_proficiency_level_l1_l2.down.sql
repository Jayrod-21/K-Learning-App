-- 039_proficiency_level_l1_l2.down.sql
--
-- Deliberate NO-OP. PostgreSQL cannot drop enum values (`ALTER TYPE … DROP
-- VALUE` does not exist), so the 'L1' / 'L2' additions to `proficiency_level`
-- are irreversible — the same posture as 016/021/028/031/032 take for their
-- own ADD VALUE additions. The values are inert if unused: nothing references
-- them until application code writes them, and re-applying the up migration
-- is a no-op (ADD VALUE IF NOT EXISTS).

SELECT 1; -- intentional no-op so the runner records the down as applied
