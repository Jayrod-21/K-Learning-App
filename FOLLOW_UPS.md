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
- **F-UP-009 (P3) — data quality — ⚠️ live-fixed, loader root-cause deferred:**
  L6L12 was the ONLY lesson with duplicate `ordinal`s — its grammar block and an
  appended "Word Builder 과" Hanja block both started ordinals at 1. Re-sequenced
  live (16 unique ordinals, grammar then Word Builder). **Durable fix deferred:**
  the loader assigns per-sub-section ordinals that collide when sub-sections merge
  into one lesson; it should assign a single unique sequence per lesson (else a
  re-ingest reintroduces the collision). L9L5 (content-empty) got a real title
  from the TTMIK syllabus in the F-UP-006 titles work. No `(lesson_id, ordinal)`
  unique index exists on `ttmik_sentences` — consider adding one.

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

### F-UP-011 · test_link_topik_dependencies order-dependence — ✅ resolved 2026-07-06
- Surfaced by the F-UP-010 re-review (pre-existing — `git archive` confirmed it
  predates F-UP-010). `test_strategy_a` (and, found via `pytest-randomly`,
  `test_strategy_b`) asserted exact dep counts / matched-id sets that were
  contaminated by rows other tests seeded into the module-scoped shared DB.
- **Fixed at the root:** an autouse `_isolate_tables` fixture TRUNCATEs the seeded
  tables (topik_dependencies/items/tests, kgiu_entries, vocab_entries,
  corpus_sources) before EVERY test, so the whole file is order-independent.
  Verified: 15 passed on normal order + all of `pytest-randomly` seeds 1–10 (was
  failing seed 1 before). No per-test assertion changes needed.
- **Deferred:** actually turning ON `pytest-randomly` for the ingest suite in CI —
  that needs the OTHER ingest test files audited for the same coupling first; this
  fix only hardens `test_link_topik_dependencies.py`.

### F-UP-010 · strategy_c pattern match brittleness — ⚠️ partially resolved 2026-07-06
- **Shipped (safe variant):** `grammar_candidates_by_pattern_substring` now OR's a
  raw punctuation-exact match (all fragments) with a syllable-normalized match
  applied ONLY to fragments of `>= 3` Hangul syllables. This recovers 3+ syllable
  format-variant links (e.g. `-으려고` → `-(으)려고 하다`) safely. Validated on the
  real KGIU corpus: strip-everything gave **26** spurious cross-links, the ≥3 gate
  gives **2** (borderline). See `db/docs/FIX_REPORT_FUP010.md`.
- **Still open (the harder half):** the 2-syllable case (`는데` → `-(으)ㄴ/는데`) is
  deliberately NOT handled — substring matching cannot tell it apart from a false
  2-syllable match (`다가` → `-아/어다가`), and a missed link is safer than a wrong
  one for a prerequisite graph. The proper fix is **alternation-aware expansion**:
  parse the TTMIK/KGIU notation (`(으)` optional, `X/Y` alternation, `ㄴ/는` jamo)
  into the set of surface forms and match the fragment against those (e.g.
  `-(으)ㄴ/는데` → {ㄴ데, 은데, 는데}, so `는데` matches but `다가` doesn't match
  `-아/어다가`'s {아다가, 어다가}). Non-trivial (notation is grammar-specific +
  ambiguous); deferred until the linker's recall is a felt problem.

### F-UP-003 · ingest CI exclusions — ⚠️ mostly resolved 2026-07-05
- **Original premise was wrong.** Re-checked on a clean checkout: `test_topik_item_type_validation`
  and `test_hanja_hunmeum` run clean (28 passed / 1 skipped — hanja `skipif`s its
  single output-dependent test), so they are now **un-ignored** in the ingest-checks
  job (CI 292 → 320 tests).
- **Residual (P3):** only `test_resolve_cross_references_integration` stays excluded,
  and NOT for an `output/` reason — it uses committed fixtures. Its
  `test_prerequisite_error_when_corpus_not_loaded` TRUNCATEs the shared module-scoped
  testcontainer to assert the "corpus not loaded" error, so it fails when run
  alongside its `schema`-fixture module-mates (passes in isolation). Fix = give that
  one test an isolated DB/schema, then drop the last `--ignore`.
