# Review — F-UP-002 `strategy_c` quarantined-test greening

**Scope:** `git diff HEAD~1` on branch `fix/fup002-strategy-c-filter` —
`tools/ingest/link_topik_dependencies.py` (`_STRATEGY_C_MIN_FRAGMENT_HANGUL_CHARS`
3→2), `tools/ingest/tests/test_link_topik_dependencies.py` (FakeProxy fixture for
the caps test), `.github/workflows/ci.yml` (the two `--deselect` lines removed).
Read-only review — no code changed.

## Verdict

**BLOCKER — do not merge as "resolved."** Both quarantined tests now pass, and the
`min=2` threshold change is correct on its own terms. But the fixture fix is a
**dodge, not a fix**: it makes `FakeProxyClient` return exactly the (already
wrong) key shape `strategy_c_claude` expects, instead of the shape the real B3
`/grammar/identify` endpoint actually returns. Tracing the real endpoint
(`server/src/routes/grammar.ts` → `server/src/services/claude/index.ts`
`recognizeGrammarPattern` → `server/src/services/claude/models.ts`
`PatternResultSchema`) shows the production HTTP response body is
`{"result": {"patternKey": ..., "confidence": ..., ...}, "metadata": {...}}`
(`ProxyResult<PatternResult>`, `models.ts:506-509`). `strategy_c_claude` reads
`result.get("pattern")`, `result.get("patternDisplay")`, and
`result.get("confidence", 0.65)` at the **top level**
(`link_topik_dependencies.py:712-713`) — none of those keys exist there, and
`patternKey` is one level down under `"result"`. Against the real proxy,
`pattern_text` is always `""`, `_HANGUL_RE.search("")` always returns `None`, and
**Strategy C silently produces zero dependencies in production, every time,
regardless of the min-length threshold.** FOLLOW_UPS.md marks F-UP-002
"✅ RESOLVED 2026-07-05" — it is not; the title symptom ("produces no dependency
for a matching kgiu_entry") is still fully reproducible against real infra, and
no test in the suite would catch it, because both tests go through
`FakeProxyClient`, which bypasses the HTTP/JSON layer entirely and hands back a
dict shaped like the code's (wrong) expectation rather than like B3's real
response envelope.

## Findings

### BLOCKER — production field-shape mismatch means Strategy C never fires; the fixture fix hides it, doesn't fix it
See "Verdict." This is the actual root cause of the bug F-UP-002 was opened to
track. The two code changes in this diff (min 3→2, fixture `오는데`→`는데`) are
each independently defensible (see PRAISE/detailed notes below) but neither one
touches the `result.get("pattern")` / `result.get("patternDisplay")` /
`result.get("confidence", 0.65)` lines, which are reading keys that do not exist
in the real API contract. Closing F-UP-002 as resolved and re-including these
tests in CI removes the only visible signal (the `--deselect`) that Strategy C
was known-broken, while leaving the actual break in place. This is the same
failure mode as the standing house rule "test with real corpus data, not
placeholders" — the fixture was corrected to match the code under test instead
of the code being corrected to match the real upstream contract, and there is
no contract/integration test anywhere that calls the real
`/grammar/identify` route (or even asserts against `PatternResultSchema`) from
the Python side.

### SHOULD-FIX — no contract test between the Python ingest client and the TS `/grammar/identify` schema
Nothing in `tools/ingest/tests/` or `server/tests/routes/grammar.test.ts` cross-
checks that `ClaudeProxyClient.identify_pattern`'s consumer
(`strategy_c_claude`) parses a shape that `PatternResultSchema` can actually
produce. A cheap regression-proof fix: change `FakeProxyClient` to return the
literal `ProxyResult<PatternResult>` envelope (`{"result": {"patternKey": ...,
"confidence": ...}, "metadata": {...}}`) and fix
`strategy_c_claude` to read `result["result"]["patternKey"]` /
`result["result"]["confidence"]`. Both currently-green tests would immediately
go red under that corrected fixture, which is the regression test F-UP-002
actually needs (SENIOR_ENGINEER_BAR §5.2: "every bug fix ships with a
regression test that fails on the old code" — this bug fix does not).

### SHOULD-FIX — dash/slash/paren canonical-form brittleness in the substring match (new ticket, not a blocker on this diff)
`_HANGUL_RE` (`link_topik_dependencies.py:653`) intentionally keeps `-`, `(`,
`)`, `/` in the extracted fragment so patterns like `-(으)면` retain their
disambiguator. That works when Claude's returned canonical form and the KGIU
`pattern` column agree on where the hyphen sits relative to the Hangul core.
They do not always. The production system prompt
(`server/src/services/claude/prompts/recognize_grammar.ts:12-25`) instructs
Claude to prefix attachment slots with an ASCII hyphen ("Use ASCII hyphens for
attachment slots"). For a verb-only span like `오는데`, a plausible — arguably
more correct per the prompt's own rules — canonical return is `-는데` (verbs
take `-는데` uniformly; no `(으)` alternation applies), not the bare `는데` this
fixture now uses. If Claude returns `-는데`, the extracted fragment is `-는데`
(hyphen included, per `_HANGUL_RE`), and `grammar_candidates_by_pattern_substring`
does `pattern ILIKE '%-는데%'`. The seeded/real KGIU entry for this family is
stored as `-(으)ㄴ/는데` (see the fixture's own seed calls,
`pattern=f"-(으)ㄴ/는데 #{i}"`, line ~740) — the literal substring `-는데` does
**not** occur in `-(으)ㄴ/는데` (the hyphen is immediately followed by `(`, not
`는`), so the match fails and the dependency is silently dropped. The sibling
test's `-(으)면` case only passes because that pattern has no other prefix
material between the hyphen and the parenthesis, so the whole canonical string
is self-matching. This is a real, pre-existing limitation of the "trim to a
Hangul-ish regex, substring-match" design (not introduced or worsened by this
diff), but the fixture change quietly picks the one span shape (bare `는데`,
no hyphen) that dodges it rather than exercising it. Recommend: open a new
follow-up (distinct from F-UP-002, which should be reopened per the BLOCKER
above) to either (a) normalize both sides before matching — strip leading
`-`/alternation-parens from both the extracted fragment and the KGIU
`pattern` column before `ILIKE`, or (b) require only the trailing/core Hangul
run (drop the leading hyphen from the fragment used in the `ILIKE`, keep it
only for the min-length count) — and add a test that forces a `-는데`-shaped
proxy return against a `-(으)ㄴ/는데`-shaped seed to prove the fix.

### NIT — `_STRATEGY_C_MIN_FRAGMENT_HANGUL_CHARS` 3→2 is itself correct and low-risk
Verified: `len("오") == 1` (still rejected), `len("으면") == len("는데") == 2`
(now kept). The worry that 2 lets more noise through is real in the abstract
(a common 2-syllable substring can appear inside unrelated multi-syllable
patterns) but is adequately bounded by three existing, independent controls
that this diff didn't touch: `grammar_candidates_by_pattern_substring`'s own
`len(fragment) < 2: return []` guard (`link_topik_dependencies.py:428`, so a
1-char fragment is double-rejected even if the syllable filter were removed),
the 25-row `LIMIT` per query, and `_STRATEGY_C_MAX_DEPS_PER_ITEM = 10` capping
total blast radius per item. No other call site reads
`_STRATEGY_C_MIN_FRAGMENT_HANGUL_CHARS` (grepped the whole `tools/ingest/`
tree) so there's no cross-cutting regression risk from the constant change
alone.

### PRAISE — CI change is honest and correctly scoped
The `.github/workflows/ci.yml` diff only removes the two `--deselect` lines
and updates the adjacent comment; it does not touch the still-valid F-UP-003
`--ignore`s or their rationale. Good hygiene, assuming the BLOCKER above is
addressed before this is actually merged as "green."

## Detailed

### 1. Is `min 3 → 2` correct?
Yes, as isolated code. `hangul_only` strips everything except `가`–`힯`
(`link_topik_dependencies.py:723`), so `-(으)면` → `으면` (2), `는데` → `는데`
(2), `오` → `오` (1). Threshold 2 keeps both real 2-syllable grammar cores and
still drops the 1-syllable noise case the comment names. The DB substring
match is a second, independent gate — a 2-char fragment that isn't a genuine
grammar-pattern substring simply returns 0 rows from
`grammar_candidates_by_pattern_substring`, so the "filter" work is really done
by two layers together, and lowering the syllable-count layer's floor by one
doesn't remove the DB layer. No other caller of the constant exists.

### 2. Is the fixture fix legitimate or a dodge?
**Both, in different senses.** In isolation, correcting the FakeProxy to
return an abstract grammar core (`는데`) instead of a raw conjugated surface
form (`오는데`) is legitimate — the sibling test already does this correctly
(`"오면": {"pattern": "-(으)면", ...}`), and the production system prompt
(`recognize_grammar.ts:12-17`) explicitly instructs Claude to return "the
CANONICAL form of the grammar pattern," never the raw inflected span. So
`오는데` genuinely was unrealistic test data, and the comment added
(lines 761-767 of the test file) accurately describes the *intent*.

But the fixture fix is graded on the wrong axis: it makes `FakeProxyClient`
agree with what `strategy_c_claude` **already, incorrectly, expects**
(`result["pattern"]` / `result["confidence"]` at the top level) rather than
with what B3 **actually returns** (`result["result"]["patternKey"]` /
`result["result"]["confidence"]`, nested under `ProxyResult`). Because
`FakeProxyClient.identify_pattern` (test file `:77-87`) returns the table
value verbatim with no HTTP/JSON round-trip, this discrepancy is
structurally invisible to every test in this file — there is no way for
this test suite, as written, to ever exercise the real envelope. Verdict:
**masking**, not fixing, the underlying F-UP-002 defect; it only fixes the
narrower, secondary bug (min-length threshold) that was layered on top of
the real one.

### 3. The deeper smell — dash/slash/paren brittleness
Confirmed as a real, separate, pre-existing risk (see SHOULD-FIX above). Not
a reason to reject the min-2 change or the CI re-inclusion by itself, but it
is a second reason the two tests going green should not be read as "Strategy
C works end-to-end" — they exercise a narrow, hyphen-free happy path that
happens to dodge both the envelope bug (issue 2) and the dash-position
brittleness (issue 3) simultaneously.

### 4. Verify green
Ran both tests in a clean `python:3.12-slim` container (Testcontainers, real
`postgres:16-alpine`, no host Python env):

```
pip install -r tools/ingest/requirements-dev.txt
cd tools/ingest && python -m pytest tests/test_link_topik_dependencies.py -k strategy_c -v
```

```
tests/test_link_topik_dependencies.py::test_strategy_c_caps_deps_per_item_and_rejects_short_fragments PASSED
tests/test_link_topik_dependencies.py::test_strategy_c_uses_proxy_only_when_uncovered PASSED
2 passed, 11 deselected in 4.70s
```

Confirmed non-trivial: the caps test asserts
`len(deps) == ltd._STRATEGY_C_MAX_DEPS_PER_ITEM` (an exact-equality assertion
against the constant `10`, not `>= 1`/truthiness) — this would fail outright
if the fragment match had silently degenerated to 0 deps, so the pass
genuinely proves 10 rows were produced and capped, not a trivial "false pass
on empty output."

## Recommendation

1. Reopen F-UP-002 (or open a new linked ticket) — do not mark it resolved.
   The actual defect (envelope/field-name mismatch between
   `strategy_c_claude` and `PatternResultSchema`/`ProxyResult`) is unfixed
   and unguarded by any test.
2. Fix `strategy_c_claude` to read `result["result"]["patternKey"]` (falling
   back to nothing else — there is no `patternDisplay` in the real schema)
   and `result["result"]["confidence"]`.
3. Change `FakeProxyClient`'s return shape (or add a second, envelope-
   accurate fixture) so at least one test fails against the *current* code
   and passes only after step 2 — this is the missing regression test.
4. File the dash/slash/paren substring-matching brittleness (finding
   SHOULD-FIX #2) as its own follow-up with a test that forces a `-는데`-
   shaped proxy return against a `-(으)ㄴ/는데`-shaped seed.
5. Keep the `min 3→2` change and the CI re-inclusion of the two tests — both
   are correct — but they should land alongside 1-4, not stand alone as "the
   fix."

---

## Re-review (commit `0c0dd44`)

The coordinator addressed the BLOCKER properly rather than papering over it. I
re-traced the real contract, re-ran the suite in a clean container, and ran an
independent revert-proof. **Overall verdict: PASS on the code + tests.** One
non-blocking documentation defect remains (SHOULD-FIX #R1 below).

### (1) Does `strategy_c_claude` now read the envelope correctly, and would it
produce deps against the REAL `/grammar/identify`? — **PASS**
`link_topik_dependencies.py:716-723` now reads `inner = result.get("result")`,
guards `if not isinstance(inner, dict): continue`, then
`pattern_text = str(inner.get("patternKey") or "")` and
`confidence = float(inner.get("confidence", 0.65))`. Traced end-to-end against
the real endpoint: `server/src/routes/grammar.ts:376-380` responds
`res.status(200).json(out)` where `out = await proxy.recognizeGrammarPattern(...)`
returns `Promise<ProxyResult<PatternResult>>` = `{result: PatternResult,
metadata: CallMetadata}` (`models.ts:299-329`, `506-509`). `PatternResult`
carries `patternKey` (required, `models.ts:122`) and `confidence` (required,
`:134`). The Python client returns `resp.json()` verbatim
(`link_topik_dependencies.py:345`), so `result["result"]["patternKey"]` is
exactly the canonical form the substring lookup needs. The keys the code now
reads match the keys the real API actually emits — the field-shape mismatch is
gone. The added `isinstance` guard is a sound fail-safe (skip a malformed/absent
envelope rather than crash — aligns with treating model/proxy output as
untrusted). Note it reads only the two needed keys rather than validating the
full `PatternResultSchema`; acceptable for an ingest tool, and not worth a gate.

### (2) Are the tests now a genuine guard (revert-the-read → fail), not still
mirroring a wrong shape? — **PASS**
The new `_proxy_result(pattern_key, confidence)` helper
(`test_...py:93-103`) builds the REAL envelope
`{"result": {"patternKey": ..., "confidence": ...}, "metadata": {}}`, and both
tests now feed it (`uses_proxy` → `patternKey "-(으)면"`; `caps` →
`"-(으)ㄴ/는데"` for the long span + `"오"` for the short-reject). I independently
reproduced the coordinator's revert-proof in a clean `python:3.12-slim` +
Testcontainers `postgres:16-alpine` container: patching the production read back
to the old top-level `result.get("pattern")` against the new real-envelope
fixtures makes **both** tests fail with `assert 0 >= 1` / `len([]) == 0` (deps
collapse to empty), and reverting the patch makes both pass. The fixtures now
encode the real contract, so the tests fail on the old code and pass on the new —
this is the regression test §5.2 of the bar requires, which the first cut
lacked. (I restored the file afterward — working tree is clean.)

### (3) Is `min=2` sound? — **PASS, and now demonstrably load-bearing**
Verified the syllable arithmetic directly: `-(으)면` → `hangul_only="으면"`
(2 chars), `-(으)ㄴ/는데` → `"으는데"` (3; the compatibility jamo `ㄴ` U+3134 is
outside the `가`–`힯` count, correctly), `오` → `"오"` (1, dropped). At the old
`min=3` the `uses_proxy` case (`으면`, 2) would drop before the DB lookup and
yield 0 deps — so `min=2` is not cosmetic; it is required for the real
2-syllable happy path. Noise risk stays bounded by three untouched controls:
`grammar_candidates_by_pattern_substring`'s own `len(fragment) < 2` guard
(`:428`), the 25-row `LIMIT`, and `_STRATEGY_C_MAX_DEPS_PER_ITEM = 10`. No other
reader of the constant exists.

### (4) Is F-UP-010 the right scope for the residual brittleness, or does it
still block? — **Correct scope, does NOT block.**
Confirmed the brittleness is real and orthogonal to the envelope fix: a
`patternKey` of `-는데` yields fragment `-는데` (2 Hangul, passes `min=2`), but
`pattern ILIKE '%-는데%'` does **not** match a KGIU entry stored as
`-(으)ㄴ/는데` (the literal substring `-는데` is absent — the hyphen is followed
by `(`). It does not block because the production system prompt
(`recognize_grammar.ts:19-25`) instructs Claude to return the FULL canonical
form (`-(으)면`, alternants shown), which is exactly the KGIU stored shape — so
the common case matches and Strategy C produces deps. The brittleness bites only
when Claude returns a punctuation-variant of the canonical key; that is a
precision limitation, not a correctness break, and a tracked P3 is the right
disposition. Filing it separately (not folding it into the F-UP-002 closure) is
the right call.

### Residual findings

**SHOULD-FIX #R1 (documentation, not code) — the `FOLLOW_UPS.md` F-UP-010 entry
has stale dangling body text.** The F-UP-010 heading (`:109`) and its first
bullet correctly describe the `patternKey`↔KGIU ILIKE brittleness. But the
bullets from `**What:**` (`:117`) through `**Status:**` (`:135`) are the *old
F-UP-002 body*, left behind when the F-UP-002 section above it was rewritten.
They describe the abandoned min-3 misdiagnosis ("the
`_STRATEGY_C_MIN_FRAGMENT_HANGUL_CHARS = 3` filter drops it", "Fix direction:
lower the threshold to 2", "the 2 tests are `--deselect`ed") — all of which is
now resolved and directly contradicts both the F-UP-002 "✅ RESOLVED" entry and
F-UP-010's own scope. A future reader will read F-UP-010 as "still open, root
cause is the threshold, tests still deselected," which is wrong on all three
counts. Fix: delete lines `:117-135` (the `**What:**`/`**Root cause…**`/`**Fix
direction:**`/`**History…**`/`**Status:**` bullets) from the F-UP-010 entry,
leaving only the heading + the brittleness bullet. No code impact.

**PRAISE — the fix is now the real fix.** The read targets the actual
`ProxyResult` envelope, the fixtures encode the real contract and provably fail
on the old code, `min=2` is retained with a correct rationale, the residual
brittleness is tracked (F-UP-010) instead of hidden, and the CI re-inclusion is
honest. The clean-checkout run reproduces green (2 passed, 11 deselected). The
original BLOCKER is resolved.

### Re-review verdict
**PASS** — merge-ready on the code and tests. Recommend fixing SHOULD-FIX #R1
(the stale F-UP-010 body text) in the same PR for doc hygiene; it does not gate
the merge.
