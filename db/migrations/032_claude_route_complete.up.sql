-- 032 (up): finish aligning claude_route with the code's RouteName union.
--
-- 031 added the two grammar-drill routes. Auditing the full RouteName union
-- (server/src/services/claude/config.ts) against the enum surfaced three MORE
-- routes the proxy assigns that were never added to claude_route:
--   * image_ocr       — LIVE: POST image OCR (server/src/routes/images.ts) sets
--                       route 'image_ocr' (index.ts:402). Every call currently
--                       fails the claude_cache + claude_usage write with
--                       `invalid input value for enum claude_route` — i.e. image
--                       OCR is uncached (full paid call each time) and untracked,
--                       the same defect 031 fixed for the grammar drill.
--   * diagnostic_item — the diagnostic proxy route (index.ts:361).
--   * anon            — the anonymous/base RouteName (config.ts).
-- Adding all three makes the enum mirror RouteName exactly, so no code-declared
-- route can hit the cache/usage-write failure again.
--
-- Same safety as 031/028: ADD VALUE runs inside migrate.py's per-migration
-- transaction on PG12+ because the values are only added here, not used (the
-- server writes them from separate runtime transactions).
--
-- FOLLOW-UP (not code here): add a server test asserting the claude_route enum
-- equals the RouteName union so this drift can't silently recur.

ALTER TYPE claude_route ADD VALUE IF NOT EXISTS 'image_ocr';
ALTER TYPE claude_route ADD VALUE IF NOT EXISTS 'diagnostic_item';
ALTER TYPE claude_route ADD VALUE IF NOT EXISTS 'anon';
