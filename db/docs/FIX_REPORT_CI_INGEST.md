# Fix report — CI ingest test-gate

Review: `REVIEW_CI_INGEST.md` — **Approve, 0 BLOCKERs**, 3 SHOULD-FIXes. The gate
was verified genuinely not false-green (reviewer independently reproduced the
clean-checkout run). All 3 SHOULD-FIXes were on the *diagnosis/quarantine*, not
the gate mechanics.

| Finding | Disposition |
|---|---|
| **SF-1** — F-UP-002 misdiagnosed `test_link_topik_dependencies.py`. The real cause is a STALE TEST FIXTURE: its seed SQL used `ON CONFLICT (test_number, section)`, obsoleted by migration 029 which widened the constraint to `(test_number, topik_level, section)`. Production code is fine. | **FIXED** — one-line fixture change (`tests/test_link_topik_dependencies.py:216`). File un-quarantined; 5 of its 7 failures now green. |
| **SF-2** — F-UP-002 misdiagnosed `test_canonical_grammar_db.py`. Real cause is a pure-Python module-identity split: `cluster_canonical_grammar.py` imported `tools.ingest.canonical_grammar` while the tests import bare `canonical_grammar`, creating two distinct `PatternOccurrence` classes → pydantic isinstance rejects. | **FIXED** — flipped `cluster_canonical_grammar.py` to import the bare name first (the suite-wide convention; `_HERE` is always on `sys.path`). File un-quarantined; all 6 green. |
| **SF-3** — `pydantic`/`anthropic` (and the other collection-critical libs) left unpinned despite gating collection; two clean runs days apart already resolved different graphs. | **FIXED** — pinned psycopg_pool, pydantic, httpx, defusedxml, pypdf, PyMuPDF, anthropic to exact versions in `requirements-dev.txt` (testcontainers/pytest stay ranges, matching db-checks). |
| F-UP-002 rewrite | **DONE** — rewritten to the correct, narrow scope: 2 `strategy_c` tests where `strategy_c_claude` yields no dep for a seeded matching `kgiu_entry` (a real linker bug, distinct from the two masking bugs fixed here). Those 2 are `--deselect`ed (not the whole files). |

## Net effect
- CI ingest gate now runs **290 passed, 4 skipped, 2 deselected, 0 failed** on a
  faithful clean checkout (was 272 with 2 whole files quarantined).
- Only genuinely-broken tests remain excluded: 3 output-scanners (F-UP-003) + 2
  strategy_c (F-UP-002), both accurately ticketed.
- No BLOCKERs; gate is blocking (no `|| true`).
