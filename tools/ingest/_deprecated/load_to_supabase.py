#!/usr/bin/env python3
"""
DEPRECATED — Supabase ingest path.

Moved here on 2026-05-28 when the project migrated to self-hosted Postgres
(see ADR-001). Replaced by `tools/ingest/load_to_postgres.py` + the
`tools/ingest/loaders/` package.

Kept in version control as a reference for the row shapes the old PostgREST
endpoints accepted. Do NOT add new code paths here.
"""
raise SystemExit(
    "load_to_supabase.py is deprecated. Use load_to_postgres.py "
    "(see ADR-019 for the new orchestrator)."
)
