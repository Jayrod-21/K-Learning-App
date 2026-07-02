-- 031 (down): no-op.
-- PostgreSQL cannot DROP a value from an enum type without recreating the type
-- and rewriting every dependent column (claude_cache.route, claude_usage.route)
-- — disproportionate and unsafe for a rollback. The added values are harmless
-- if unused. Intentionally a no-op (same posture as 028's down for its
-- vocab_entry_type ADD VALUEs).
SELECT 1;
