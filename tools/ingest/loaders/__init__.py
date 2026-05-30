"""
Loader package.

One module per corpus family — see ADR-019.

The orchestrator (``load_to_postgres.py``) imports the ``load`` coroutine
from each module and dispatches based on the ``--corpus`` CLI flag.
"""
