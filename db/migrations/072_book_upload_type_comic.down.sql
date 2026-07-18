-- 072 (down): no-op.
-- PostgreSQL cannot DROP a value from an enum type without recreating the type
-- and rewriting every dependent column — disproportionate and unsafe for a
-- rollback. The added value is harmless if unused. Intentionally a no-op
-- (same posture as 028's ADD VALUEs for vocab_entry_type and 002's ADD VALUE
-- for 'reference', which are also not reversed).
SELECT 1;
