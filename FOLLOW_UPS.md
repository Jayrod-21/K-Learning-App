# Follow-ups — Korean Master (local M deploy)

Tracked deferrals from the local stand-up + `/fixpass` cycles. None block the
running stack; each is a real improvement to schedule.

## Corpus ingest — blocked sources (need OCR or source acquisition)
The local ingest loaded **TTMIK lessons (232 lessons / 2,742 sentences)** and
**TTMIK Iyagi (139 episodes / 11,162 turns)** — the only sources with a usable
PDF text layer. Still to do, each requiring work beyond a re-run:
- **Darakwon KGIU grammar (Beginner/Intermediate/Advanced)** — PDFs have a bad
  Adobe OCR layer; needs re-OCR before `parse` + `load_kgiu` can run.
- **Darakwon 2000 Essential Words (Beginner/Intermediate)** — image-only PDFs
  (no text layer); needs OCR, then `load_vocab_2000`.
- **TOPIK practice papers** — image-only PDFs; needs OCR, then `load_topik`.
- **KRDICT (국립국어원 dictionary)** — loader is ready (`load_krdict.py`) but the
  bulk XML source is not on this box; acquire it, then `Deploy/load-krdict.sh`.
- **HTSLANS** — audio only, no text/PDF source; out of scope until a script exists.

## Dependency advisories (soft gates — bar §3.11 wants these addressed)
The `local-test.sh` soft gates report advisories (non-blocking, mirrors CI's
`|| true`): `npm audit --audit-level=high` (client + server) and `pip-audit`
(ingest loader deps + kiwi).

**DONE (2026-07-01, non-breaking):** `npm audit fix` in client + server.
- **client → 0 vulnerabilities** (react-router, vite, postcss patched in-range).
- **server 12 → 7** (protobufjs etc. patched).
- `pip-audit`: only `pip` the installer is flagged (not a shipped dep) — noise.

**REMAINING (7, server) — all need a BREAKING major bump; do each as its own tested change:**
- `vitest` / `esbuild` / `vite` / `vite-node` (moderate) — **dev+test tooling only**, not in
  the prod image. Fix = `vitest@4` (major); verify the whole suite still passes after.
- `@anthropic-ai/sdk` 0.79→**0.109** (moderate) — the advisory is the SDK *Memory Tool*
  path/permissions issue; this app doesn't use that feature, so low real exposure. The SDK
  API changed a lot across that range — bump carefully and re-run the claude-service tests.
- `uuid`→**14** (moderate) — flaw is `v3/v5/v6` with a provided buffer (not our usage).
Consider promoting the audits to HARD gates once these are clean (bar wants SCA to fail on HIGH/CRITICAL).

## Loader cosmetics
- `count_assertion_mismatch` warnings during multi-file loads: the per-file count
  assertion compares one file's expected count against the *cumulative* table
  total, so it warns whenever >1 file loads into the same table even though every
  file reports `loaded == expected`, `skipped: 0`, `status: complete`. Cosmetic;
  worth making the assertion cumulative-aware.

## Commit hygiene
- New untracked file `client/src/lib/grammarKey.ts` must be `git add`ed together
  with the modified `Reference.tsx` / `Reference.test.tsx` or the client build
  breaks (flagged by the fixpass re-review).

## Test-suite polish (from /fixpass reviews — deferred nits)
- Move the `grammarKey` unit tests out of `Reference.test.tsx` into a dedicated
  file (R3 nit).
- `local-test.sh`: pin `node:20-slim` / `python:3.12` by digest; make `db_suite`'s
  inlined pin set track a manifest (N1, N6).

## CI ingest test-gate (surfaced 2026-07-05 when the gate was added)

The `ingest-checks` CI job now runs `pytest tests/` (272 green). Two sets of tests
are `--ignore`d in that job; both are tracked here.

### F-UP-002 · `topik_dependencies` ON CONFLICT has no matching unique index (13 tests red)
- **Severity:** real bug (loader idempotency / data-integrity), P2.
- **What:** `tools/ingest/link_topik_dependencies.py` (~line 488) and the
  canonical-grammar apply path upsert with an EXPRESSION conflict target —
  `ON CONFLICT (topik_item_id, dep_type, COALESCE(grammar_entry_id,0), COALESCE(vocab_entry_id,0))`.
  No migration creates a UNIQUE INDEX on that exact expression, so Postgres raises
  `InvalidColumnReference: there is no unique or exclusion constraint matching the
  ON CONFLICT specification`. The loaders' idempotency contract ("re-run writes no
  new rows") is broken against a real schema.
- **Evidence:** 13 tests fail — all of `tests/test_link_topik_dependencies.py` and
  `tests/test_canonical_grammar_db.py`. Hidden until now because CI never ran the
  ingest suite (the gap this gate closed).
- **Fix:** add a reversible migration creating the matching expression-based unique
  index (`CREATE UNIQUE INDEX … ON topik_dependencies (topik_item_id, dep_type,
  COALESCE(grammar_entry_id,0), COALESCE(vocab_entry_id,0))`) and the equivalent for
  the canonical-grammar target; verify no existing rows would violate it; then drop
  the two `--ignore` lines and confirm 13 → green.

### F-UP-003 · 3 ingest tests scan the gitignored generated `output/*.json`
- **Severity:** test-infra, P3.
- **What:** `test_topik_item_type_validation`, `test_hanja_hunmeum`, and
  `test_resolve_cross_references_integration` read `tools/ingest/output/*.json`,
  which is generated + gitignored, so they cannot run on a clean checkout (same
  class as db/tests' excluded `test_discriminator_coverage.py`).
- **Fix options:** commit tiny golden fixtures under `tests/fixtures/` and retarget
  these tests, OR add a CI step that regenerates the needed `output/` artifacts
  first. Until then they run only locally.
