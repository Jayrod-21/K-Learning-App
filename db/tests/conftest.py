"""Pytest config: make `db/migrate.py` importable as `db.migrate`."""

from __future__ import annotations

import pathlib
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# Also expose `db` itself as a package by giving it an __init__.py at import time
# if one doesn't exist. We don't write to disk here — sys.path covers it.
