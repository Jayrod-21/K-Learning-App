#!/usr/bin/env python3
"""
DEPRECATED — Supabase ingest path. See _deprecated/load_to_supabase.py.

This stub exists because the harness cannot delete the file; the original
content has been preserved at _deprecated/load_to_supabase.py and this
shim ensures no one accidentally re-runs the old loader.
"""
import sys

print(
    "load_to_supabase.py is deprecated. Use load_to_postgres.py "
    "(see ADR-019 for the new orchestrator).",
    file=sys.stderr,
)
sys.exit(2)
