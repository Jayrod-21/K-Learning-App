"""
pytest config for KRDICT tests.

Adds the parent `tools/ingest/` directory to sys.path so the test modules
can `import krdict_parser` etc. without a package install.
"""

from __future__ import annotations

import sys
from pathlib import Path

INGEST_DIR = Path(__file__).resolve().parents[1]
if str(INGEST_DIR) not in sys.path:
    sys.path.insert(0, str(INGEST_DIR))
