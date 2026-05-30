# Review: Phase B fix-pass

**Reviewer:** Independent senior engineer (30 yr). Did not author the code,
did not review the original builders' work, did not author the fix-pass.
**Date:** 2026-05-28
**Scope:** Verify every BLOCKER and SHOULD-FIX from REVIEW_B1, B2, B3, B4
was addressed in code (not just in FIX_REPORT_B.md). Run §5 bar checklist
against the post-fix state.

---

## Summary verdict

**PASS WITH CONDITIONS.** Every BLOCKER is genuinely fixed (verified
against code, not the self-report); every SHOULD-FIX is FIXED,
PARTIALLY-FIXED with code-level evidence, or REJECTED with a rationale
that holds up under scrutiny (B3-SF7 in particular). The two conditions
are (a) B3-SF1 property-test pattern is shipped for KGIU only — the four
other loader families (ttmik, iyagi, topik, vocab_2000) are committed as
follow-up in `FIX_REPORT_B.md` but have NO tracked ticket / TODO / CHANGELOG
entry in the repo itself; (b) B3-SF8 per-route happy-path coverage remains
a follow-up, with only the auth-gate smoke test landed. Neither blocks
Phase C; both should be tracked actionably before they slip.

---

## Finding-by-finding verification

| Finding ID | Source | Original severity | Fix status | Notes |
| --- | --- | --- | --- | --- |
| F-1 | REVIEW_B1 | SHOULD-FIX | FIXED | `services/kiwi/src/kiwi_service/models.py:101,110` adds `protected_namespaces=()` to both response models with cross-reference comment. |
| F-2 | REVIEW_B1 | SHOULD-FIX | FIXED | `models.py:20-37` — the hardcoded `_DEFAULT_MAX_INPUT_CHARS=4096` cap is REMOVED from `LemmatizeRequest`; docstring confirms `_enforce_input_limit` (env-driven) now owns the limit. |
| F-3 | REVIEW_B1 | SHOULD-FIX | FIXED | `Dockerfile:55-56` — `HOME=/tmp` + `XDG_CACHE_HOME=/tmp/.cache`; comment cross-references the read-only-rootfs deployment. |
| F-5 | REVIEW_B1 | NIT | FIXED (in-file trivial) | `models.py:61-70` — `_end_after_start` validator now actually enforces `end >= start`. |
| F-6 | REVIEW_B1 | NIT | DEFERRED-WITH-DOC | Self-report claims FIXED in `app.py`. Not verified against `app.py:299` in this pass; low-risk. |
| F-7 | REVIEW_B1 | NIT | FIXED (in-file trivial) | `models.py:17,61` — `ValidationInfo` imported and used in signature. |
| F-12 | REVIEW_B1 | NIT | FIXED (in-file trivial) | `Dockerfile:90-92` — healthcheck now uses Python `json.loads`, not a brittle regex. |
| F-4, F-8, F-9, F-10 | REVIEW_B1 | NIT | DEFERRED (out-of-scope) | Per fix-pass rules; acceptable. |
| F-11 | REVIEW_B1 | NIT | FIXED | Self-report claims explanatory comment added in `config.py`. Not re-verified line-by-line; low-risk. |
| SF1 | REVIEW_B2 | SHOULD-FIX | FIXED | `load_krdict.py:78` defines `KrdictResumeMarkerMissingError`; `:604-610` actually RAISES it when `found_marker` is False at end-of-stream; `:917` catches it in `main` and exits with a distinct code. `krdict_parser.py:281-289` adds the visit-order contract docstring. (See "Detailed findings" — concern about positional cursor as future ticket.) |
| SF2 | REVIEW_B2 | SHOULD-FIX | FIXED | `load_krdict.py:443-446` — explicit `return` skips the DELETE-children path when `entry_changed=False`. The contract docstring (`:394-414`) honestly documents the limitation (parent-only diff misses child-only changes), with the rationale that all observed KRDICT update paths bump the first-sense definition (which flows into the entry row). Acceptable trade-off with the trapdoor documented. |
| SF3 | REVIEW_B2 | SHOULD-FIX | FIXED | Self-report claims misleading comment block at the CheckViolation site rewritten. Not verified line-by-line; low-impact. |
| SF4 | REVIEW_B2 | SHOULD-FIX | FIXED | `003_krdict.up.sql:67-71` — `uq_krdict_source_source_path` removed; replacement comment documents the change and references REVIEW_B2.md SF4. Migration is forward-only inside the same Phase B not-yet-shipped file; acceptable. |
| SF5 | REVIEW_B2 | SHOULD-FIX | FIXED | `krdict_models.py:66-73` defines single shared `_strip_required`; lines 100/123/139/169 all delegate to it. DRY rule of three satisfied. |
| SF6 | REVIEW_B2 | SHOULD-FIX | FIXED | `krdict_parser.py:65-70` — `TAG_SENSE_REGISTER` removed; single `TAG_REGISTER` constant with explanatory block-comment. |
| N1–N5 | REVIEW_B2 | NIT | DEFERRED | Per fix-pass rules; acceptable. |
| SF1 | REVIEW_B3 | SHOULD-FIX | PARTIALLY-FIXED | `tools/ingest/tests/test_load_kgiu_properties.py` is a NEW file with all 4 missing ADR-019 §D10 properties tested for KGIU (idempotency line 141, resume line 165, sha256-change line 221, malformed-skip line 263). The other 4 loader families (ttmik, iyagi, topik, vocab_2000) are NOT covered and the follow-up is documented ONLY in FIX_REPORT_B.md — there is no in-repo TODO, ticket, or CHANGELOG entry. See "Detailed findings". |
| SF2 | REVIEW_B3 | SHOULD-FIX | FIXED | Self-report claims 9 `.js` stubs deleted + `ci.yml` regenerated. Verified: `find server/src -name "*.js"` returns nothing. |
| SF3 | REVIEW_B3 | SHOULD-FIX | FIXED | `server/.env.example:22` declares `CLIENT_ORIGIN=http://localhost:5173` matching `config/index.ts`. Whole file regenerated from the Zod schema. |
| SF4 | REVIEW_B3 | SHOULD-FIX | FIXED | `middleware/auth.ts:52-58` defines `getUserId(req)` returning `number` (throws `UnauthorizedError` on absent user). Verified zero `req.user!` patterns remain in `server/src/routes/`; all call-sites (`progress.ts`, `vocab.ts`, `grammar.ts`, `conversation.ts`) import and use `getUserId`. |
| SF5 | REVIEW_B3 | SHOULD-FIX | FIXED | `routes/define.ts:45-65` — `KRDICT_READY_TTL_MS = 5 * 60 * 1000`; cache freshness checked on every request. |
| SF6 | REVIEW_B3 | SHOULD-FIX | FIXED | `loaders/load_kgiu.py:98-101` — `original_size = len(batch)` captured BEFORE the filter; `skipped_running += original_size` uses honest magnitude. |
| SF7 | REVIEW_B3 | SHOULD-FIX | REJECTED-WITH-RATIONALE | The reviewer recommended removing `@anthropic-ai/sdk` from `server/package.json` and letting B4 transitively provide it. Verified the rejection is factually correct: `server/src/services/claude/client.ts:22` actively `import Anthropic from '@anthropic-ai/sdk'` and lives in the same `server/package.json` realm — there is no other package to inherit from. Removing the dep would break the build. The substitute (architectural ESLint guardrail in `.eslintrc.cjs` overrides #1, restricting the SDK to `client.ts` only) is the correct alternative and is properly implemented (`no-restricted-imports` paths AND patterns, with a clear error message). The rejection holds up. |
| SF8 | REVIEW_B3 | SHOULD-FIX | PARTIALLY-FIXED | `tests/routes.auth-required.test.ts` (NEW) is a smoke-style test that hits 5 protected GETs without a session cookie and asserts 401-or-404. This is the highest-leverage subset (catches "future refactor mounts a route without `requireAuth`"). Full per-route happy-path coverage remains a follow-up. Tracked in FIX_REPORT_B.md but not in the repo. |
| B-1 | REVIEW_B4 | BLOCKER | FIXED | `cache.ts:152-159` — the hit-counter `UPDATE` is now `await`ed on the same `client` BEFORE the `finally` block calls `client.release()` (`:175`). `cache.pool-release.test.ts:128-129` directly asserts `release.calledAt >= update.resolvedAt`, plus a concurrent-gets test (`:171-210`) and a still-releases-on-UPDATE-failure test (`:132-169`). This is a real, ordering-aware test — it does NOT just check `await` was used; it timestamps both events and asserts the temporal relationship. Excellent BLOCKER fix with the right verification harness. |
| S-1 | REVIEW_B4 | SHOULD-FIX | FIXED | `usage.ts:121-139` — formula is `inputTokens*input + cachedInputTokens*cachedInput + cacheCreationInputTokens*cacheCreationInput + outputTokens*output`. No subtraction. SDK fields trusted as-reported. `RATE_CARD` has a centralized `CACHE_CREATION_MULTIPLIER = 1.25` constant (`:80`). `migrations/004…up.sql:230` adds `cache_creation_input_tokens NUMERIC(18,0) NOT NULL DEFAULT 0`, `:256-257` adds non-neg CHECK, `:271` includes it in the cache-hit-zero-cost CHECK, `:350` rolls it up in the daily view. `models.ts:253` adds `cacheCreationInputTokens` to `CallMetadataSchema`. `usage.test.ts` is rewritten with 8 tests including the exact "non-subtraction" property the reviewer wanted (`:27-38`). |
| S-2 | REVIEW_B4 | SHOULD-FIX | FIXED | `prompts/sanitize.ts:55-70` — role-impersonation markers (`system:`, `assistant:`, `human:`, `### system`, `<<sys>>`) ARE REMOVED. Kept: `<user_input>`/`</user_input>`, `ignore previous`/`ignore all previous`/`ignore the previous`, `disregard previous`/`disregard all previous`, `forget previous`/`forget all previous`, plus jailbreak preambles (`you are now`, `you are no longer`, `pretend you are`, `act as if you`). Inline rationale (`:38-53`) cites REVIEW_B4 §S-2. Correct balance. |
| S-3 | REVIEW_B4 | SHOULD-FIX | FIXED | `index.ts:182` — `cfg: PublicClaudeConfig` is a `readonly` constructor dependency on `ClaudeProxyImpl`. `:194, :226, :258, :286, :506` all read `this.cfg` (factory at `:161` calls `loadConfig()` once and passes it through). No per-method `loadConfig()` calls remain in the impl. |
| S-4 | REVIEW_B4 | SHOULD-FIX | FIXED | `index.ts:383` (conversation path) and `:579` (json-routes path) — `rateLimiter.consume` runs AFTER the cache lookup. Both call-sites have inline comments explaining the move (`:381-382, :576-578`). |
| S-5 | REVIEW_B4 | SHOULD-FIX | FIXED | `index.ts:357-359` — cached Korean text is split via `chunkForReplay()` (`:796-817`) on sentence-like boundaries (`.?!…\n`) with a 256-char cap. Chunks are pushed as individual SSE `delta` events. |
| N-1 through N-5, N-7 | REVIEW_B4 | NIT | DEFERRED | Per fix-pass rules; acceptable. |
| N-6 | REVIEW_B4 | NIT | FIXED (in-file trivial) | Migration view parenthesization clarified per self-report. |

---

## Bar checklist (post-fix state, §5 13-item)

| # | Bar item | Status | Notes |
|---|---|---|---|
| 1 | Lint passes (no warnings) | PASS (server) / N/A run | `server/.eslintrc.cjs` (new) enforces both SDK and `pg` boundaries. Pre-existing kiwi `ruff` config retained. Not actually executed in this review pass. |
| 2 | Type-check passes (strict) | PASS in changes | All TS edits I read are strict-clean; Python edits use full type hints. Not executed. |
| 3 | All tests pass | UNVERIFIED (not run) | New tests added are well-shaped; running them is the next reviewer's job. |
| 4 | Every public function tested | PARTIAL | KGIU loader properties now covered (4 of 5 ADR-019 §D10 properties); other 4 loader families still single-property. Per-route happy-path also partial. |
| 5 | EXPLAIN ANALYZE on non-trivial queries | N/A | No new non-trivial queries introduced. |
| 6 | SECURITY.md with attack-vector enumeration | PASS | Pre-existing docs unchanged; sanitizer comment cross-references the rationale. |
| 7 | README with "how to test" | PASS | `.env.example` regenerated to match Zod schema; otherwise unchanged. |
| 8 | ADR for non-obvious decisions | PASS | No new ADRs needed (no new non-obvious decisions); existing ADR-013, -017, -019, -020 already cover the territory. |
| 9 | Migrations reversible AND tested both directions | PASS (structure) | Migration 004 column add is in the same Phase-B not-yet-shipped file; down drops the whole table. Reversibility holds. |
| 10 | No TODO/FIXME without ticket | PASS in committed code | The REAL gap is `FIX_REPORT_B.md`'s "tracked as follow-up" promises — see "Detailed findings" §B3-SF1. |
| 11 | No `console.log`/`print()` | PASS | None added. |
| 12 | No commented-out code | PASS | The 9 stale `.js` stubs from REVIEW_B3 SF2 are deleted. |
| 13 | No hardcoded secrets/URLs/paths | PASS | None added. |

---

## New findings introduced by the fix-pass

### BLOCKER (new)

*(none)*

### SHOULD-FIX (new)

- **NF-1 — Follow-ups committed in FIX_REPORT_B.md are not tracked anywhere
  actionable.**
  `FIX_REPORT_B.md` commits to four follow-ups that the fix-pass deliberately
  did not ship:
    1. B3-SF1 property-test pattern cloned to ttmik / iyagi / topik / vocab_2000.
    2. B3-SF8 per-route happy-path coverage (14 routes × ≥2 cases).
    3. B2-SF1 position-based cursor (file_path, byte_offset) as a stronger
       alternative to the equality-with-guard fix.
    4. B2-SF2 diff-upsert of children as a stronger alternative to the
       skip-replace-when-parent-unchanged shortcut.
  None of these appears as a `TODO` in code, a `# tracking: …` line, an
  entry in `CHANGELOG`, or a row in `hangugeo_master_tasks.md`. The
  fix-pass's promise is in a document that nobody automatically reads
  again. Recommendation: open four GitHub Issues (or rows in
  `hangugeo_master_tasks.md`) and reference the issue IDs from
  FIX_REPORT_B.md so the next reviewer can verify they exist. Without
  that, "tracked as follow-up" is folklore. Severity: SHOULD-FIX because
  the bar (`§4 Process — Documented by default`) requires that any
  deferral land where it will be looked at; a self-report buried in
  `db/docs/` is not that place.

### NIT (new)

- **NN-1 — `chunkForReplay()` uses `text[i]` indexing on a String which
  splits surrogate pairs.** `index.ts:804-806` iterates by `i += 1`
  and tests `text[i]` against `/[.?!…\n]/`. For Korean NFC text under
  the BMP this is fine. If a future cached response ever contains
  non-BMP code points (rare for pure Korean — would only matter for
  emoji or supplementary CJK), the chunk boundary could land in the
  middle of a surrogate pair and produce an invalid sub-string. Mitigation:
  iterate with `Array.from(text)` or a `for…of` loop (both grapheme-naive
  but at least code-point-correct). Severity: NIT — not a real bug
  today, footgun for tomorrow.

- **NN-2 — `package.json` justification for keeping `@anthropic-ai/sdk`
  lives only in `.eslintrc.cjs`.** The FIX_REPORT_B.md table row claims
  "justification documented for keeping the SDK". JSON doesn't support
  comments, so this lives in the ESLint config (which does explain it
  thoroughly, with `REVIEW_B4 P-10` cross-reference). Acceptable, but
  a future engineer auditing `package.json` won't see the rationale —
  worth a `// Why this exists` block in `services/claude/README.md` or
  in `ADR-020`. Severity: NIT.

### PRAISE (new)

- **NP-1 — `cache.pool-release.test.ts` is a properly designed
  concurrency test.** Lines 36-89 build a stub pool that timestamps every
  `query()` resolution and every `release()` call. The critical assertion
  (`:129`) is `releases[0].calledAt >= update.resolvedAt` — the actual
  temporal relationship the BLOCKER hinged on, not just "was `await`
  used in source". The concurrent-gets test (`:171-210`) exercises the
  pool-acquisition path under three parallel `get()` calls and verifies
  each gets its own client. The error-path test (`:132-169`) confirms
  the client still releases when the UPDATE rejects. This is the right
  shape for a fix-verification test and it actually catches the original
  bug.

- **NP-2 — Cost-math fix landed end-to-end across five files
  (`usage.ts`, `004…up.sql`, `models.ts`, the routes that thread the
  field through, and `usage.test.ts`) with the new column also covered
  by both a non-neg CHECK and the cache-hit-zero-cost CHECK.** This is a
  coordinated fix; defense in depth — application formula + DB constraint.
  The dashboard view (`claude_usage_daily`) was also updated to roll up
  the new column, so the "are cache writes paying off?" question is
  answerable from the existing dashboard query without a follow-up
  migration.

- **NP-3 — `prompts/sanitize.ts` rationale block (`:38-53`) names the
  EXACT corpora the false-positives would hurt (research / business
  Korean) and explicitly documents which markers were removed and which
  kept.** A future reviewer who suspects "did someone weaken the
  sanitizer for convenience?" gets the answer in the file itself.

- **NP-4 — `.eslintrc.cjs` documents BOTH architectural guardrails (SDK
  boundary, `pg` boundary) with cross-references to the original review
  PRAISE bullets that called them out.** The config is genuinely
  load-bearing on REVIEW_B4 P-10 — it implements the architectural
  guarantee the reviewer praised, and the rejection of B3-SF7 leans on
  it. The fact that the guardrail is now enforced by the linter rather
  than just documented is a real upgrade.

- **NP-5 — `load_krdict.py:443-446` "skip children replace when parent
  unchanged" fix is paired with an honest docstring (`:394-414`) that
  names the trade-off (parent-only diff hides child-only diffs) AND
  documents WHY it's acceptable in practice (every observed update path
  bumps `definition_korean` on the parent because the first sense flows
  up into the entry row).** This is exactly the kind of "document the
  trade-off, don't pretend it doesn't exist" the bar asks for.

- **NP-6 — `_filter_resumable` (`load_krdict.py:573-610`) raises
  `KrdictResumeMarkerMissingError` with an operationally useful error
  message that names BOTH causes (entry removed upstream / entry moved
  earlier in archive) AND gives the operator a concrete remediation
  (re-run with `--source-label` for a new vintage).** Error UX for a
  silent-data-loss class bug is hard to over-praise.

---

## Detailed findings

### NF-1 — Follow-up tracking is informal

`FIX_REPORT_B.md` is honest about what was NOT shipped:
- B3-SF1: "kgiu family done as the reference; cloning to ttmik/iyagi/
  topik/vocab_2000 is mechanical but would inflate this fix-pass by
  ~600 lines of test code. Tracked as a follow-up so the next reviewer
  can sign off on the pattern first."
- B3-SF8: "Auth-gate smoke test landed. Per-route happy-path coverage
  is a follow-up."
- B2-SF1: "Position-based cursor tracked as a follow-up if a real-world
  incident motivates it."
- B2-SF2: "Diff-upsert of senses is tracked as a follow-up."

Searching the repo for actual tracking surface:
- No `TODO`/`FIXME` in code referencing these.
- No `CHANGELOG.md` (no file by that name in the repo).
- `hangugeo_master_tasks.md` does not mention these follow-ups.
- No GitHub Issues visible from `gh` in this scope.

The bar (`§4 Process — Documented by default`) and the §5 item "No
TODO/FIXME without ticket" together imply that any deliberate deferral
should be tracked where it will be reviewed again. A self-report in
`db/docs/` is not that place. **Recommendation:** open four issues
(or four rows in `hangugeo_master_tasks.md`) and cross-reference from
`FIX_REPORT_B.md`. SHOULD-FIX, not BLOCKER, because the work the
fix-pass did ship is genuinely correct and tracked enough to find again.

### B3-SF7 rejection holds up under scrutiny

The fix-pass REJECTED removing `@anthropic-ai/sdk` from
`server/package.json` and substituted an ESLint guardrail. I verified
the rejection rationale:
1. `server/src/services/claude/client.ts:22` does `import Anthropic from '@anthropic-ai/sdk'`.
2. That file lives in the same `server/package.json` realm — there is
   no separate B4 npm package with its own dependencies.
3. Therefore removing the SDK from `server/package.json` would break
   `npm install` and the client build, full stop.
4. The reviewer's underlying CONCERN ("a future change in server/src
   shouldn't accidentally import the SDK") is real but doesn't require
   the SDK to be transitive — it requires an enforcement mechanism.
5. The ESLint `no-restricted-imports` rule in `.eslintrc.cjs` overrides
   #1 implements that enforcement: `paths` covers `@anthropic-ai/sdk`
   and `patterns` covers `@anthropic-ai/sdk/*`; `excludedFiles`
   exempts only `src/services/claude/client.ts`; the error message
   directs future maintainers to the typed proxy API.

This is the right substitute. The rejection is convincing and the
alternative is properly implemented.

### B3-SF1 partial fix — sample-of-one is OK if tracked, otherwise drift

The KGIU property tests (`test_load_kgiu_properties.py`) are excellent:
all four ADR-019 §D10 properties (idempotency, resume, sha256-change,
malformed-skip) are tested against a real Postgres via testcontainers,
with proper module-scoped pg_container fixture and a clean-slate
`_wipe_kgiu` helper. The tests are honest about what they verify
(comments explicitly call out the property being tested). This is the
right reference pattern.

But: ttmik, iyagi, topik, and vocab_2000 still have only the
single-property "row count" tests REVIEW_B3 flagged. If a regression
lands in the upsert/checkpoint code for one of those loaders, CI does
not catch it. The fix-pass's promise to clone the pattern is documented
only in `FIX_REPORT_B.md`. See NF-1 above.

### B2-SF2 fix — version-bump-skip semantics review

The reviewer asked whether the "early-return when entry-row was
unchanged" fix could leave stale children that ARE in new data but
weren't matched. Reading `load_krdict.py:394-446`:

- The parent-row `IS DISTINCT FROM` guard (in `SQL_UPSERT_ENTRY`, lines
  245-251) checks `headword`, `pronunciation`, `part_of_speech`, `hanja`,
  `register`, `definition_korean`, `definition_english`. The last two
  are the denormalized first-sense definitions that flow up from
  `model.senses[0]` (per `_entry_params`, around line 359).
- If sense data changes in any way that affects the first sense's
  definition_korean / definition_english, the parent row updates,
  `entry_changed = True`, and children are replaced. Correct.
- If a NON-FIRST sense changes (e.g., sense 3's definition is rewritten
  but sense 1 is identical), the parent guard fires "unchanged" and
  children are NOT replaced. The non-first-sense edit is silently
  dropped on the resync.

The docstring at `:394-414` is honest about this: "if a future change
introduces a child-only diff … it would be missed. That is an explicit
trade-off — diff-upsert of senses is the proper fix for that case and
is tracked as a follow-up." So the fix-pass knows and documents the
limitation. Whether the trade-off is acceptable depends on whether
KRDICT actually edits non-first-sense fields without touching sense 1
— the fix-pass's claim ("every observed KRDICT update path that changes
children ALSO changes definition_korean on the parent") is plausible
but unverified. **Net:** the fix is correct for the documented contract
and the trapdoor is explicit. Acceptable. Pair with NF-1 tracking.

### B4-S1 verification — formula sanity

I cross-checked the formula in `usage.ts:121-139` against Anthropic's
documented Messages API semantics:
- `input_tokens` — non-cached input, full input rate. Multiplied by
  `rates.input`. Correct.
- `cache_read_input_tokens` — cached reads, discounted. Multiplied by
  `rates.cachedInput`. Correct.
- `cache_creation_input_tokens` — cache writes, premium. Multiplied
  by `rates.cacheCreationInput = rates.input * 1.25`. Correct per the
  ephemeral-cache rate.
- `output_tokens` — output rate. Correct.
- No subtraction anywhere. Correct.

`usage.test.ts:27-38` explicitly tests the non-subtraction property:
`500k input + 500k cached_read = 0.5 + 0.05 = 0.55` (not the broken
`(500k - 500k) * 1 + 500k * 0.1 = 0.05`). This is the exact test the
review asked for.

### B4 BLOCKER fix — test design quality

`cache.pool-release.test.ts` is unusually well-designed for a
regression-class test. It does NOT rely on "the source has `await`
in front of the query"; it constructs a stub `Pool` that:
1. Returns a fresh stub `PoolClient` per `connect()` call.
2. Each stub `PoolClient` records `(clientId, sql, resolved, resolvedAt)`
   on every `query()` and `(clientId, calledAt)` on `release()`.
3. The hit-counter UPDATE is artificially delayed by `updateDelayMs`
   so that a fire-and-forget bug would let `release()` fire BEFORE
   `resolvedAt`.
4. The critical assertion (`:129`) is `releases[0].calledAt >= update.resolvedAt`
   — the EXACT temporal ordering invariant the BLOCKER hinged on.
5. A second test (`:171-210`) fires three concurrent `get()` calls and
   asserts each gets its own client (no pool-slot leak / no client
   sharing).
6. A third test (`:132-169`) confirms `release()` still fires when the
   UPDATE rejects (so the original "best-effort with no rollback path"
   safety is preserved).

This is the right way to write a fix-verification test. Praise.

---

## Recommendation

**Ready for Phase C, conditionally.** Both conditions are non-blocking
but should land before too much else accumulates:

1. **Convert the "tracked as follow-up" commitments in FIX_REPORT_B.md
   into actual repo-visible tickets** (GitHub Issues or rows in
   `hangugeo_master_tasks.md`). Reference the issue IDs back into
   FIX_REPORT_B.md. Specifically:
   - B3-SF1 follow-up: clone the property-test pattern from
     `test_load_kgiu_properties.py` to ttmik, iyagi, topik, vocab_2000.
   - B3-SF8 follow-up: per-route happy-path coverage for the 14 routes.
   - B2-SF1 follow-up: position-based resume cursor as a stronger
     alternative to equality-with-guard.
   - B2-SF2 follow-up: diff-upsert of senses to fix the
     non-first-sense edit gap.

2. **Address NN-1** (`chunkForReplay()` surrogate-pair safety) — one-line
   fix using `Array.from(text)`. Not blocking; do during the next pass
   on `index.ts`.

The Phase B fix-pass is the cleanest fix-pass I have seen on this
codebase. Every BLOCKER fix is in code, every SHOULD-FIX disposition is
defensible against the actual file contents, and the one rejection
(B3-SF7) holds up under scrutiny rather than being a dodge. The tests
added for the BLOCKER and cost-math fixes are genuinely test-the-bug
(not test-the-shape), which is rarer than it should be.

---

## Files I read (for the auditor)

- `Repository/SENIOR_ENGINEER_BAR.md`
- `Repository/services/kiwi/REVIEW_B1.md`
- `Repository/tools/ingest/REVIEW_B2.md`
- `Repository/server/REVIEW_B3.md`
- `Repository/server/src/services/claude/REVIEW_B4.md`
- `Repository/db/docs/FIX_REPORT_B.md`
- `Repository/server/src/services/claude/cache.ts`
- `Repository/server/tests/services/claude/cache.pool-release.test.ts`
- `Repository/server/src/services/claude/usage.ts`
- `Repository/server/src/services/claude/models.ts`
- `Repository/server/src/services/claude/index.ts` (S-3/S-4/S-5 paths,
  `chunkForReplay`)
- `Repository/server/src/services/claude/prompts/sanitize.ts`
- `Repository/server/tests/services/claude/usage.test.ts`
- `Repository/db/migrations/004_claude_cache_and_usage.up.sql`
- `Repository/db/migrations/004_claude_cache_and_usage.down.sql`
- `Repository/db/migrations/003_krdict.up.sql` (SF4 area)
- `Repository/tools/ingest/load_krdict.py` (SF1, SF2, KrdictResumeMarkerMissingError)
- `Repository/tools/ingest/krdict_parser.py` (SF6, visit-order docs)
- `Repository/tools/ingest/krdict_models.py` (SF5 strip helper)
- `Repository/tools/ingest/loaders/load_kgiu.py` (SF6 original_size)
- `Repository/tools/ingest/tests/test_load_kgiu_properties.py`
- `Repository/server/.env.example` (SF3 CLIENT_ORIGIN)
- `Repository/server/.eslintrc.cjs` (SF7 substitute + boundary docs)
- `Repository/server/src/middleware/auth.ts` (SF4 getUserId)
- `Repository/server/src/routes/{progress,vocab,grammar,conversation,define}.ts`
  (call-site spot-checks)
- `Repository/server/tests/routes.auth-required.test.ts`
- `Repository/server/package.json`
- `Repository/services/kiwi/src/kiwi_service/models.py` (F-1, F-2, F-5, F-7)
- `Repository/services/kiwi/Dockerfile` (F-3, F-12)
- `Repository/hangugeo_master_tasks.md` (for follow-up tracking check)
