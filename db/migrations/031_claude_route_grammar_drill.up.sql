-- 031 (up): add 'generate_grammar_drill' and 'score_grammar_drill' to claude_route.
--
-- The grammar Drill feature (Pass 9, server/src/routes/grammarDrill.ts) calls
-- the Claude proxy with two routes that were never added to the claude_route
-- enum (004 defined only enrich/recognize_grammar/grade_writing/
-- generate_conversation):
--   * generate_grammar_drill — POST /grammar-drill (drill generation)
--   * score_grammar_drill    — drill submit/grade path
-- Every drill call succeeded against Anthropic but then failed the
-- claude_cache write and claude_usage insert with `invalid input value for
-- enum claude_route`, so drill responses were never cached (every drill a
-- full paid call) and drill spend was invisible to the cost tracker. This is
-- exactly the "intentional friction" 004 promised — new Claude-touching
-- routes require a reviewed migration — the migration just never happened.
--
-- ADD VALUE is safe inside migrate.py's per-migration transaction on PG12+:
-- the value just cannot be USED until commit. Nothing here uses it; the
-- server (separate runtime transactions) does. Mirrors 028's ADD VALUE.

ALTER TYPE claude_route ADD VALUE IF NOT EXISTS 'generate_grammar_drill';
ALTER TYPE claude_route ADD VALUE IF NOT EXISTS 'score_grammar_drill';
