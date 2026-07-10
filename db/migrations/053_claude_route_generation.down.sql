-- 053 (down): no-op.
-- PostgreSQL cannot DROP a value from an enum type without recreating the type
-- and rewriting every dependent column (claude_cache.route, claude_usage.route)
-- — disproportionate and unsafe for a rollback. The added values are harmless
-- if unused. Intentionally a no-op (same posture as 031/032/028's downs).
SELECT 1;
