-- 037 (down): drop topik_attempts.
--
-- Lossy by design: rolling back discards any in-progress mock attempts (a user
-- mid-exam would restart from the section-select screen). No graded data is lost
-- — submitted answers live in topik_responses, which is untouched. The trigger
-- and unique index are owned by the table and go with it; set_updated_at() is
-- shared (001) and must remain.
DROP TABLE IF EXISTS topik_attempts;
