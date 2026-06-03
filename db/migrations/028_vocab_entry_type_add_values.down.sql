-- 028 (down): no-op.
-- PostgreSQL cannot DROP a value from an enum type without recreating the type
-- and rewriting every dependent column — disproportionate and unsafe for a
-- rollback. The added values are harmless if unused. Intentionally a no-op
-- (same posture as 002's ADD VALUE for 'reference', which is also not reversed).
SELECT 1;
