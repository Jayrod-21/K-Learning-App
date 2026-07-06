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

## Tester-sweep deferred items (2026-07-05, see db/docs/SWEEP_*.md)

Batch A (client UX) + Batch B (TOPIK picture-item exclusion + study survivor guard)
shipped. Deferred:

- **F-UP-006 (P2, data) — all 232 TTMIK lesson titles are the placeholder "Level N
  Lesson M"** (`tools/ingest/parse_ttmik.py:127`), never the real name. 100% of
  Listen browse rows + headers. Needs the real titles from the TTMIK source (data
  availability unknown) + a re-ingest; not a code one-liner.
- **F-UP-007 (P3) — Mock section-select advertises a fixed item count** ("50 items"
  in `MockMode.tsx:94-98`) but the mock serves all corpus items for the picked
  test (~80). Product call: cap the mock to the official TOPIK II counts (Reading
  50 / Listening 50) vs. show the real dynamic count. Left as-is pending that call.
- **F-UP-008 (P3) — Review "More examples" drawer is dead** (`extra` hardcoded to
  `[]` when mining a card) — the affordance is already correctly hidden when empty,
  so this is "populate `extra`", a data-plumbing task, not a bug.
- **F-UP-009 (P3) — data quality:** Level 6 Lesson 12 has duplicate `ordinal`s in
  `ttmik_sentences` (no uniqueness constraint there → dupe React keys / jumbled
  order); Level 9 Lesson 5 is content-empty. Both single-lesson corpus issues.

## Rate-limit retry_after (from B-016 review, 2026-07-05)

- **F-UP-004 (P3) — ✅ RESOLVED 2026-07-05:** `message` is now a function
  (`rateLimitedMessage`) that computes `retry_after` from `req.rateLimit.resetTime`
  (precise per-client seconds; falls back to the full window; floored at 1s).
- **F-UP-005 (P3) — ✅ RESOLVED 2026-07-05:** the shared `rateLimitedMessage`
  helper is applied to ALL four limiters (cheap, expensive, auth, media), so every
  429 carries `retry_after` (auth keeps its `too many auth attempts` text). Auth
  429 test strengthened to assert the field.

## CI ingest test-gate (surfaced 2026-07-05 when the gate was added)

The `ingest-checks` CI job now runs `pytest tests/` (272 green). Two sets of tests
are `--ignore`d in that job; both are tracked here.

### F-UP-002 · `strategy_c_claude` produces no dependency for a matching kgiu_entry (2 tests) — ✅ RESOLVED 2026-07-05
- **Root cause (real production bug, caught by the /fixpass review):**
  `strategy_c_claude` read the proxy response as top-level `result["pattern"]` /
  `["confidence"]`, but `/grammar/identify` returns the `ProxyResult` envelope
  `{"result": {"patternKey", "confidence", …}, "metadata": …}`
  (server/src/services/claude/models.ts). So against real infra `pattern_text` was
  ALWAYS `""` → Strategy C silently produced ZERO deps regardless of threshold. The
  originally-quarantined tests' FakeProxy mirrored the same buggy top-level shape,
  so they could never have caught it.
- **Fix:** (1) read `result["result"]["patternKey"]` + `["confidence"]`. (2) both
  tests' FakeProxy now return the REAL envelope (`_proxy_result()` helper), so they
  validate the actual contract — reverting the code read fails them. (3)
  `_STRATEGY_C_MIN_FRAGMENT_HANGUL_CHARS` 3→2 (the filter targets single-SYLLABLE
  fragments per its own comment, but 3 also dropped legit 2-syllable forms like
  `으면`). Ingest suite 290→292; both tests re-included in CI.
- **Severity:** real linker bug, P2.

### F-UP-010 · strategy_c pattern match is brittle to patternKey↔KGIU formatting (P3)
- `grammar_candidates_by_pattern_substring` does `kgiu_entries.pattern ILIKE
  '%<fragment>%'`, and `_HANGUL_RE` includes `-` `(` `)` `/` in the fragment. A
  Claude `patternKey` like `-는데` will NOT substring-match a KGIU entry stored as
  `-(으)ㄴ/는데` (dash vs `/는데`) even though they are the same grammar — so
  Strategy C can miss real links when the returned key's punctuation differs from
  the stored form. Consider normalizing both sides (strip `-()/`, compare on
  syllables) or matching on the KGIU canonical key. Surfaced in the F-UP-002 review.

### F-UP-003 · 3 ingest tests scan the gitignored generated `output/*.json`
- **Severity:** test-infra, P3.
- **What:** `test_topik_item_type_validation`, `test_hanja_hunmeum`, and
  `test_resolve_cross_references_integration` read `tools/ingest/output/*.json`,
  which is generated + gitignored, so they cannot run on a clean checkout (same
  class as db/tests' excluded `test_discriminator_coverage.py`).
- **Fix options:** commit tiny golden fixtures under `tests/fixtures/` and retarget
  these tests, OR add a CI step that regenerates the needed `output/` artifacts
  first. Until then they run only locally.
