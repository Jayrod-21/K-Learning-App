# Review — F-UP-010 (full fix): alternation-aware expansion for the strategy_c matcher

**Reviewer:** independent senior review (read-only), Python + Postgres + Korean linguistics.
Did not write this code, the interim fix, or either prior review.
**Branch:** `fix/fup010-full-fup011`. **Scope:** `git show HEAD` (commit `deae0f7`,
"fix(ingest): alternation-aware expansion for strategy_c matcher (F-UP-010 full)"),
plus a secondary look at `0216f81` (F-UP-011, test isolation), per the task brief.
This is the **third** iteration of F-UP-010: strip-everything (rejected, 26 FPs) →
safe-union (shipped, skipped the 2-syllable case) → this full alternation-expansion.

All verification below was run against read-only `rsync` copies of the repository
under `/tmp/fup010_review/` (`repo_ro`, plus a hand-patched `repo_reverted` for the
revert-catcher experiments) inside throwaway `python:3.12-slim` containers with a
testcontainers Postgres — the real working tree was never edited, staged, or
committed to.

## Verdict

**BLOCKER.** The alternation expander (`_pattern_alternant_forms`) is well-built —
the `(X)` optional / `X/Y` alternation / POS-prefix / sense-marker handling is
correct in the common case, the two recall tests are genuine, reproducible
revert-catchers, and `ruff`/`mypy`/the full suite (17 tests, 5 `pytest-randomly`
seeds) are clean. But the commit's own headline validation claim — **"11
cross-links … most CORRECT … only ~1 genuinely spurious"** — does not hold up
under independent re-validation. I reproduced the exact **11** (directed) /
**8** (unordered) cross-link count using the same methodology the author
evidently used, then **independently classified all 8** rather than accepting
the FOLLOW_UPS.md characterization, and found **2 genuinely spurious families
(3 of the 8 pairs)**, not 1: alongside the acknowledged `만하다` collision, the
connective **`-(으)ㄴ/는데`** ("but/while") and the nominalizer **`-는 데`**
("the place/fact/way that…") — two grammar points Korean textbooks explicitly
warn learners not to confuse — collapse onto the identical reduced form `는데`
and cross-link. FOLLOW_UPS.md waves this off as a "defensible `대로`/`는데`-family
link"; it is not a family link, it is two different parts of speech (a
connective ending vs. a nominalizing bound noun) that happen to share syllables
after punctuation is stripped. **I demonstrated this fires end-to-end through
the real `strategy_c_claude` code path, on the fix's own headline example**
(Claude returning `"-는데"` for the connective) — see Real-corpus re-validation
below. That is a demonstrated false-positive category worse than the interim
shipped union's 2 (this fix has 3, one of them on far more common/consequential
grammar than the interim's obscure modifier-reference collisions), which is the
task's own BLOCKER bar.

Independently of that, I found a second, orthogonal, high-value bug: the
**entry gate that decides whether `strategy_c_claude` even calls the matcher is
still based on the pre-existing, unchanged `_HANGUL_RE`-extracted, space-
truncated FIRST WORD** of Claude's `patternKey` — not the full multi-word
pattern the new arm-2 logic is built around. A legitimate, correctly-formatted,
multi-word Claude key whose first word is short (e.g. the nominalizer's own
canonical form, `"-는 데"`) is silently dropped **before arm-2 ever runs**,
contradicting the diff's own docstring claim ("Uses the FULL claude_pattern …
so multi-word keys match by their whole form"). I reproduced this live through
`strategy_c_claude` (0 deps for a legitimate, seeded-distinct pattern) and then
proved the underlying alternation logic is fine once the gate is bypassed.
None of the three new tests exercise this — all three call
`grammar_candidates_by_pattern_substring` directly with hand-picked
`fragment`/`hangul_fragment` values, never through the real extraction path in
`strategy_c_claude`. This is a SHOULD-FIX (a missed link, not a wrong one — the
project's own accepted risk tolerance), but it materially overstates what the
fix actually delivers, and it silently and unpredictably **also blocks some of
the "good" sense-variant merges** the fix is supposed to enable (`-(으)ㄹ
거예요 ①/②` is gated too) while occasionally letting through the genuinely
spurious `는데` case (not gated) — i.e. the gate's effect on precision/recall
is essentially arbitrary with respect to the fix's design intent, not a
deliberate tradeoff.

## Findings

### BLOCKER

**B-1 — The shipped alternation matcher produces a demonstrated, end-to-end
false-positive link between two grammatically distinct patterns
(connective `-(으)ㄴ/는데` vs. nominalizer `-는 데`), on the fix's own headline
example, undercounted by the shipping validation.**
`tools/ingest/link_topik_dependencies.py:538-540` (`expand = category !=
"irregular" and bool(frag_forms & _pattern_alternant_forms(pattern))`).

Both the KGIU corpus's `kgiu-beginner-039`/`075` (`'A/V-(으)ㄴ/는데 ①'`/`'②'`,
category `connective` — "it's raining, **but**…") and `kgiu-advanced-010`
(`'-는 데'`, category `nominalization` — "**the place/situation** where…") reduce
to the identical syllable string `는데` once `_pattern_alternant_forms` strips
punctuation and the POS/space structure. These are not senses of the same
headword (unlike the `①②③`-numbered pairs elsewhere in the 11) — they are two
different parts of the Korean grammar system (a clause-final/medial connective
ending vs. a bound-noun nominalizer), and this exact confusion is common enough
that Korean grammar references call it out by name. I reproduced this live
through the real `strategy_c_claude` call (seeded both entries with their real
corpus text/category, `FakeProxyClient` returns the fix's own docstring example
`patternKey = "-는데"` for a stem that tests the connective):

```
deps: [(1, '-는데'), (2, '-는데')]
Correctly linked the CONNECTIVE (1)? True
Spuriously ALSO linked the DISTINCT NOMINALIZER (2)? True
```

This means a real TOPIK item testing the connective `는데` would, under
`--use-claude`, acquire a spurious `topik_dependencies` row claiming it also
depends on the unrelated nominalizer grammar point — corrupting exactly the
prerequisite graph this linker exists to build, and doing so on ordinary,
high-frequency grammar (`는데` is one of the most common connectives tested on
TOPIK), not an edge case.

**Recommendation:** don't rely on syllable-string equality alone as "same
grammar." At minimum, require the two patterns' **word-count** (space-
delimited segment count after POS-prefix stripping) to match before accepting a
form-intersection as a link — a nominalizer's `데` is its own word/bound noun,
the connective's `는데` is not — which would separate this pair without
re-introducing the recall loss for genuine single-word variants (`-는데` vs
`-(으)ㄴ/는데` are both 1-word). Re-run the corpus validation with that rule and
confirm it removes this pair while keeping the `①②③` sense-variant merges.

**B-2 (supports B-1) — The corpus-vs-corpus validation FOLLOW_UPS.md and the
commit rely on ("11 cross-links … only ~1 genuinely spurious") undercounts real
false positives by hand-waving the exact case the task asked me to check for.**
`FOLLOW_UPS.md:144-146` characterizes the `는데` collision as a "defensible
`대로`/`는데`-family link," in the same breath as the legitimate `①②③`
sense-variant merges. It is not defensible — see B-1. Independently
reclassifying all 8 unordered cross-link pairs I found (methodology and full
listing below): **2 spurious families (3 pairs)**, not "~1." The doc and the
`_pattern_alternant_forms` docstring (`link_topik_dependencies.py:467-470`)
should be corrected regardless of what code fix is chosen, since they currently
overstate the fix's precision to the next engineer who trusts the number.

### SHOULD-FIX

**SF-1 — The entry gate in `strategy_c_claude` still truncates to the first
space-delimited word, silently defeating the new arm's own "match by the
whole multi-word form" design for any pattern whose first word is short.**
`link_topik_dependencies.py:829-846`. `fragment = _HANGUL_RE.search(pattern_text)`
extracts only the first contiguous Hangul-ish run (stops at the first space);
`hangul_only` is the syllable-filtered version of THAT fragment; if
`len(hangul_only) < _STRATEGY_C_MIN_FRAGMENT_HANGUL_CHARS` (2), the function
`continue`s — the matcher is **never even called**, so arm-2's use of the FULL
`claude_pattern` (documented at `link_topik_dependencies.py:512-516` as the
whole point: *"Uses the FULL claude_pattern (not the space-truncated
fragment)"*) never gets a chance to run. This code path (`_HANGUL_RE`, the
gate, `_STRATEGY_C_MIN_FRAGMENT_HANGUL_CHARS = 2`) is **unchanged** by this
diff (confirmed via `git show HEAD -- ...`) — it predates F-UP-010 — but this
diff's own docstring makes a claim about "whole multi-word form" matching that
this unchanged gate can silently prevent from ever being exercised.

Demonstrated live: seeded a distinct nominalizer entry `-는 데`, had
`FakeProxyClient` return the legitimate, correctly-canonical-per-the-system-
prompt key `"-는 데"` (server's own `recognize_grammar.ts` system prompt
instructs Claude to use exactly this ASCII-hyphen style), and got:

```
proxy was called with: ['하는 데']
deps produced: 0
Did the legitimate multi-word patternKey '-는 데' link the SEEDED distinct entry 1? False
```

Then proved the underlying form logic is fine once the gate is bypassed
(hand-supplied a non-truncated `hangul_fragment`): `matched=True`. So the bug is
specifically in the caller's fragment-length gate, not in
`_pattern_alternant_forms`.

Practical impact: this doesn't just affect the nominalizer case — I checked
several of the 8 cross-link pairs found above (`-(으)ㄹ 거예요`, `-(으)ㄹ 만하다`,
`만 하다`) and their first-word-only fragments are ALSO under 2 syllables, so
they'd be gated out too. The net effect is that this gate's interaction with
the new arm is essentially arbitrary — it happens to block two of the
legitimate `①②③` sense-merges (`거예요`) and one of the two spurious families
(`만하다`), while letting through the more dangerous `는데` spurious family and
the `대로`/`까요`/`으니까` legitimate merges (their first words are ≥ 2
syllables). None of this is by design; it's an accident of which pattern's
first word happens to clear an unrelated threshold.

None of the three new F-UP-010 tests exercise this real path — all three
(`test_pattern_alternant_forms_expansion`, `test_grammar_matcher_links_two_syllable_variant`,
`test_grammar_matcher_links_multiword_variant_by_full_key`,
`test_grammar_matcher_rejects_false_two_syllable_match`) call
`grammar_candidates_by_pattern_substring` directly with hand-picked
`fragment`/`hangul_fragment` values (e.g. `"-으려고", "으려고", "-으려고 하다"`),
never through `strategy_c_claude`'s real `_HANGUL_RE`-based extraction — so the
integration between the caller's gate and the new arm is untested in either
direction.

**Recommendation:** compute the length-gate check from the FULL
`claude_pattern`'s alternant forms (or from `hangul_only` of the whole pattern
text, not just its first space-delimited word) so the gate's threshold applies
to what arm-2 actually uses, and add an integration test that drives a
short-first-word multi-word key through `strategy_c_claude` end-to-end (not
just the isolated matcher function).

**SF-2 — No `ORDER BY` on the candidate fetch + Python-side cap-and-break is a
latent non-determinism risk for the module's own idempotency guarantee.**
`link_topik_dependencies.py:527-532`: `SELECT id, pattern, category,
book_level::text FROM kgiu_entries WHERE entry_type = 'grammar'` has no
`ORDER BY`; row order for a bare heap scan is not guaranteed stable by Postgres
across runs (autovacuum, HOT updates, or a future index on `entry_type`
changing the planner's chosen path could all reorder it). Combined with the
Python-side `if len(out) >= _STRATEGY_C_MATCHER_CANDIDATE_CAP: break`
(`link_topik_dependencies.py:550-551`), if a single fragment's true match count
ever exceeds 25 (unlikely today at 285 total grammar rows, but the caps test
already seeds 12 and the corpus grows), which 25 rows get kept is not
guaranteed identical across two runs of the same linker over the same data —
directly in tension with the module's own docstring promise ("Idempotency:
re-running with the same inputs is a no-op," `link_topik_dependencies.py:32`).
This is pre-existing behavior (the prior `LIMIT 25` in SQL had the same gap),
but it's worth fixing now since this diff is already touching this exact
function. **Recommendation:** add `ORDER BY id` (or `pattern`) to the SELECT.

**SF-3 — `_pattern_alternant_forms` mangles patterns whose optional-morpheme
parenthesized group spans a space, producing garbage concatenations (not yet a
demonstrated cross-link, but a latent one).**
`link_topik_dependencies.py:433-443` (`_expand_parens`) operates PER WORD, after
`sub.split(" ")` has already broken the pattern into space-delimited tokens
(`link_topik_dependencies.py:475`). Three real corpus patterns have a `(...)`
group that spans a space — `'안 A/V (A/V-지 않다)'` (short vs. long-form
negation, kgiu-beginner-014), `'못 V (V-지 못하다)'` (kgiu-beginner-015), and
`'A/V-지 않아도 되다 (안 A/V-아/어도 되다)'` (kgiu-beginner-057). For all three, the
paren group is split across two "words" with unbalanced parens in each
(`'(A/V-지'`, `'않다)'`), so `_expand_parens` never fires on either half (its
`re.search(r"\(([^)]*)\)", ...)` finds no matching pair in either fragment), the
POS-prefix strip doesn't apply either (it requires the word to *start* with
`A/V`/`N`, not to contain it after a stray `(`), and the leftover `(`/`)`
literal characters get silently dropped later by the final Hangul-only filter
— producing forms like `안않다`/`안지않다` (kgiu-beginner-014) and
`못지못하다` (kgiu-beginner-015) that are **not the correct surface forms of
either alternative** the notation intends (the short-form `안 V` and the
long-form `V-지 않다` are two separate, valid 2-syllable-or-shorter forms that
get fused into one wrong compound instead). I confirmed these three specific
garbage forms do **not** currently collide with any other of the 285 corpus
patterns (no live false positive today), but this is a real defect in the
expander that will silently misclassify the next KGIU/TTMIK pattern added with
this shape, and it's exactly the kind of thing the task asked me to hunt for.
**Recommendation:** either (a) expand parens on the whole comma-segment BEFORE
splitting on spaces (so a paren group spanning a space is expanded as one
unit), or (b) detect and reject/warn on unbalanced-paren tokens per word rather
than silently emitting a corrupted form.

**SF-4 (F-UP-011, secondary per the task) — the autouse `_isolate_tables`
fixture forces every test in the file onto Postgres/Docker, including the
tests the file's own docstring says need neither.**
`tools/ingest/tests/test_link_topik_dependencies.py:143-153`. The fixture is
`autouse=True` and depends on the module-scoped `schema` fixture (Postgres
container + migrations). Because autouse fixtures apply regardless of whether
the test function itself requests `schema`, this now forces Postgres startup
for tests the file's own top-of-file docstring explicitly promises are
"Pure-function unit tests … Run anywhere, no Postgres required"
(`test_link_topik_dependencies.py:5-6`) — e.g.
`test_item_sort_key_is_monotone_with_sql_ordering`, which takes no DB
parameter at all. I measured this directly: the same test, run in isolation via
`-k`, took **0.32s** at the parent commit (`b33bea8`, before F-UP-011) and
**4.95s** at `HEAD` (after F-UP-011) — a ~15x slowdown purely from the autouse
fixture pulling in the container it doesn't need. This doesn't matter much for
a full-file run (the container is amortized across all 17 tests either way),
but it does mean this file can no longer be used as a fast, Docker-free smoke
check for its pure-function logic (e.g. a quick local check of
`_pattern_alternant_forms` while iterating), which contradicts the file's own
documented two-tier design and is a real, if secondary, regression from the
F-UP-011 fix. This does NOT mask a correctness bug — I confirmed the fixture's
actual isolation logic (TRUNCATE before each test) is sound and the 5
`pytest-randomly` seeds I ran all pass — it's purely a test-suite-design
regression.
**Recommendation:** either scope `_isolate_tables` to only the tests that
actually request `schema` (autouse fixtures can still be conditional by
checking `request.node`/markers), or accept the tradeoff explicitly and update
the file's docstring to stop promising Docker-free execution.

### NIT

**N-1 — `_HANGUL_RE`'s "first Hangul run" extraction breaks (produces a
1-character garbage fragment) if a source pattern-shaped string ever contains
a literal `"A/V"`/`"N"` POS-prefix before its first real Hangul character.**
`link_topik_dependencies.py:759`. E.g. `_HANGUL_RE.search("A/V-(스)ㅂ니다")`
returns `"/"` (the regex finds the leftmost match, which is the lone `/` in
`A/V`, before the `-` run starts). This does **not** currently affect
production `strategy_c_claude` calls, because Claude is explicitly instructed
(`server/src/services/claude/prompts/recognize_grammar.ts:19-25`) to return
canonical forms WITHOUT the `A/V`/`N` prefix (its own examples: `"-아/어
버리다"`, `"-(으)면"`, `"은/는"`) — the prefix convention is a KGIU-corpus-only
authoring artifact, never something Claude is asked to emit. I'm noting this
as a NIT rather than a SHOULD-FIX because the defense (the system prompt) is
real and explicit, but it's worth a comment at `_HANGUL_RE`'s definition
flagging that a model deviating from its own instructions (LLMs do drift back
toward the training-corpus-dominant notation, especially in a domain this
textbook-saturated) would silently produce zero candidates with no
distinguishing log message from "genuinely no grammar match." Given
SENIOR_ENGINEER_BAR §7.1's "treat model output as untrusted," a defensive log
line when `_HANGUL_RE.search` yields a fragment that is entirely
punctuation/POS-marker (no Hangul at all) would make this failure mode
observable instead of silent.

**N-2 — the `_pattern_alternant_forms` docstring's "11 cross-links … ~1
genuinely spurious" claim (also duplicated in `FOLLOW_UPS.md`) should be
corrected alongside whatever code change addresses B-1/B-2,** so the next
engineer doesn't inherit a validated-sounding number that undercounts.

### PRAISE

- **The core expander logic is correct and well-tested for the common case.**
  `test_pattern_alternant_forms_expansion` covers `(X)` optional-expansion,
  in-word `/`-alternation, POS-prefix stripping, and the "no shared-suffix
  guessing" precision property — I re-ran it and traced the logic by hand
  against `(으)ㄴ/는데`, `은/는 대로`, `-아/어다가`/`-아/어요`; all consistent with
  the code.
- **Both new recall tests are genuine, independently-reproduced revert-
  catchers**, not just per the FIX_REPORT's claim. I hand-patched a copy of the
  real file (`expand = False and category != "irregular" and ...`) and ran the
  suite: `test_grammar_matcher_links_two_syllable_variant` and
  `test_grammar_matcher_links_multiword_variant_by_full_key` both fail with
  `assert 1 in set()` against the reverted code, and pass against the shipped
  code. `test_grammar_matcher_rejects_false_two_syllable_match` (precision)
  passes either way, as expected — it's a precision guard, not a revert-catcher
  on its own, and the two recall tests cover that role.
- **The headline example genuinely works end-to-end**, independent of B-1:
  I drove `strategy_c_claude` with `FakeProxyClient` returning `"-는데"` against
  a seeded `-(으)ㄴ/는데` connective entry and a seeded `-아/어다가` distinct entry —
  the connective link fires, the `다가` family does not, confirming the
  precision property holds for the pair it was designed around, independent of
  the B-1 finding about the *third* entry (the nominalizer) that also happens
  to share the form.
- **The `-으려고 하다` multi-word case genuinely works end-to-end** when the
  first word clears the (unrelated) length gate — confirmed via a full
  `strategy_c_claude` call, not just the isolated matcher function.
- **`irregular`-category exclusion is correct and well-justified.** I verified
  independently that 5 of the corpus's 7 `'X' 불규칙` entries (`ㄹ`, `ㅂ`, `ㄷ`,
  `ㅎ`, `ㅅ` irregular conjugation references) all reduce to the identical form
  `불규칙` once their single distinguishing jamo is stripped by the Hangul-only
  filter — without the `category != "irregular"` guard, that alone would
  produce at least 10 additional spurious cross-links among clearly distinct
  conjugation rules. The guard is necessary and correctly scoped (only excludes
  when the *stored/candidate* row is irregular, matching how the real function
  is actually invoked — Claude never emits an irregular-conjugation patternKey).
- **`ruff check`, `mypy link_topik_dependencies.py`, and the full suite are all
  clean**, and stable under `pytest-randomly` across 5 seeds (1–5) — I ran all
  of this myself in an isolated `python:3.12-slim` container, not just trusted
  the commit message.
- **No SQL injection**: the `WHERE entry_type = 'grammar'` clause is a
  hardcoded literal with no interpolated variables; the whole candidate
  comparison moved from SQL into Python, so there's no parameterization
  surface to get wrong here at all (an incidental but real simplification of
  the injection-review surface vs. the interim `regexp_replace`/`ILIKE`
  version).
- `lru_cache`/perf are non-issues at the actual scale: `kgiu_entries` is
  bounded by a finite pair of print textbooks (285 grammar rows today, will
  never approach thousands), the linker is an offline batch CLI (fresh process
  per invocation, so cache staleness across a re-ingest isn't a real scenario),
  and the candidate fetch is a full scan of a few hundred rows run at most a
  few thousand times per full-corpus pass — cheap by any measure.

## Real-corpus re-validation (independent numbers + FP classification)

**Corpus:** `tools/ingest/output/grammar_kgiu_{beginner,intermediate,advanced}.json`
— confirmed **285** entries with `type == "grammar"` and a non-null `pattern`
(mirrors the SQL `WHERE entry_type = 'grammar' AND pattern IS NOT NULL`
filter), **0** duplicate pattern strings across distinct ids, **7** entries
with `category == "irregular"` (matches the commit's claim exactly).

**Methodology:** I copied `_pattern_alternant_forms`, `_expand_parens`,
`_KGIU_POS_PREFIX_RE`, `_KGIU_NOISE_RE` **verbatim** from
`link_topik_dependencies.py` (no paraphrase) into a standalone script (no
import of the real module, to avoid pulling in `httpx`/`psycopg`/`structlog`
just to run pure functions). For each ordered pair of distinct corpus entries
`(A, B)`, I computed:
  - `raw = fragment(A) in pattern(B)`, where `fragment(A) =
    _HANGUL_RE.search(pattern(A)).group(0)` (the real raw-arm definition,
    corpus pattern standing in for a Claude-returned key — the same
    approximation both prior reviews used, and the one that reproduces the
    author's claimed count, see below).
  - `expand = category(B) != "irregular" and bool(forms(A) & forms(B))`
    (the real arm-2 definition).
  - "new-only" = `expand and not raw`.

This reproduced **exactly 11** directed new-only pairs (**8** distinct
unordered pairs — 3 of the 11 are bidirectional), matching the commit's claimed
11 exactly. (I also checked what happens if the `strategy_c_claude` entry gate,
`len(hangul_only(fragment(A))) < 2`, is applied to this same corpus-vs-corpus
simulation — as SF-1 describes, that gate wipes out 113/285 sources as
candidates entirely and drops the "new-only" count to 2 directed / 1 unordered
pair; I'm reporting the **ungated 11/8** as the correct number for "does the
alternation logic itself over-match," since the gate's own brokenness is a
separate finding (SF-1), not a property of `_pattern_alternant_forms`.)

**Full listing and independent classification of the 8 unordered pairs**
(the author's implicit classification in FOLLOW_UPS.md is in parentheses):

| # | Pair | My classification | Author's claim |
|---|---|---|---|
| 1 | `-(으)ㄴ/는데 ①` (connective) ↔ `-는 데` (nominalization) | **SPURIOUS** — distinct part of speech, textbook-famous confusion pair; demonstrated live via `strategy_c_claude` (B-1) | "defensible `는데`-family" |
| 2 | `-(으)ㄴ/는데 ②` (connective) ↔ `-는 데` (nominalization) | **SPURIOUS** — same as #1, other sense marker | "defensible `는데`-family" |
| 3 | `-(으)니까 ①` ↔ `-(으)니까 ②` | Legitimate — same headword, sense variants | Same-grammar sense variant ✓ |
| 4 | `-(으)ㄹ 거예요 ①` ↔ `-(으)ㄹ 거예요 ②` | Legitimate — same headword, sense variants | (not individually named, grouped as "same-grammar") |
| 5 | `-(으)ㄹ까요? ①` ↔ `-(으)ㄹ까요? ③` | Legitimate — same headword, sense variants | Same-grammar sense variant ✓ |
| 6 | `-(으)ㄹ까요? ②` ↔ `-(으)ㄹ까요? ③` | Legitimate — same headword, sense variants | Same-grammar sense variant ✓ |
| 7 | `-(으)ㄹ 만하다` (recommendation) ↔ `만 하다` (degree) | **SPURIOUS** — distinct grammar, shared surface string only | "~1 genuinely spurious" ✓ (agrees) |
| 8 | `-(으)ㄴ/는 대로` (state) ↔ `은/는 대로` (manner) | Borderline/defensible — same core meaning "as/according to," but N-attaching vs. V-attaching forms, taught together | "defensible `대로`-family" ✓ (reasonable) |

**Bottom line: 2 spurious families / 3 of 8 pairs, not "~1."** Pairs #1–#2 are
the same false-positive family (connective vs. nominalizer) counted twice
because they hit both sense-numbered variants of the connective; treating that
as one family, the corrected picture is **2 spurious families out of 6 total
families** (4 legitimate sense-variant families + 1 borderline + 2 spurious —
note families #3–#6 collapse to 3 "families" by headword: `으니까`, `거예요`,
`까요`). Either way you count it, it's worse than "~1," and one of the two
spurious families is demonstrated to fire on common, high-stakes grammar via
the real code path (B-1), not a rare or academic corner case.

## Detailed

- `link_topik_dependencies.py:422-492` — `_KGIU_POS_PREFIX_RE`, `_KGIU_NOISE_RE`,
  `_expand_parens`, `_pattern_alternant_forms`: new in this diff. Correct for
  single-space-scoped optional groups and in-word alternation; incorrect for
  parenthesized groups spanning a space (SF-3, 3/285 patterns currently
  affected, no live collision yet).
- `link_topik_dependencies.py:495-552` — `grammar_candidates_by_pattern_substring`:
  signature gained `claude_pattern`; two-arm OR logic confirmed correct in
  isolation (matches its own docstring); the `irregular`-category exclusion is
  confirmed necessary and correctly scoped (PRAISE). Candidate fetch has no
  `ORDER BY` (SF-2); cap-and-break is otherwise sound.
- `link_topik_dependencies.py:829-853` (`strategy_c_claude`) — unchanged
  `_HANGUL_RE`/gate wiring (SF-1, N-1) now sits upstream of a matcher it was not
  updated alongside; this is the single most consequential gap in the diff,
  because it silently changes both what recall the new arm can deliver and
  which of the 8 cross-link pairs above can ever reach production.
- `tools/ingest/tests/test_link_topik_dependencies.py:834-938` — the 4 new
  tests (`test_pattern_alternant_forms_expansion`,
  `test_grammar_matcher_links_two_syllable_variant`,
  `test_grammar_matcher_links_multiword_variant_by_full_key`,
  `test_grammar_matcher_rejects_false_two_syllable_match`) are well-written unit
  tests of the matcher function in isolation; none integration-test through
  `strategy_c_claude`'s real fragment extraction (gap noted in SF-1). All 4
  pass; both recall tests are genuine revert-catchers (PRAISE, independently
  verified).
- `tools/ingest/tests/test_link_topik_dependencies.py:134-153` (F-UP-011,
  `0216f81`) — `_isolate_tables` autouse fixture: TRUNCATE logic itself is
  sound (verified no test-order coupling across 5 `pytest-randomly` seeds), but
  forces Docker/Postgres onto tests that don't need it (SF-4), a documented
  regression against the file's own stated two-tier design.
- CI gates, run against the actual `HEAD` code in an isolated
  `python:3.12-slim` + testcontainers-Postgres container (`--network host`,
  Docker socket mounted, real repo never touched): `ruff check` → all checks
  passed; `mypy link_topik_dependencies.py` → Success, no issues found;
  `pytest tests/test_link_topik_dependencies.py -q` → **17 passed**; same suite
  under `pytest-randomly --randomly-seed={1,2,3,4,5}` → **17 passed** every
  seed.
- Revert-catcher: patched `expand = category != "irregular" and bool(...)` →
  `expand = False and category != "irregular" and bool(...)` in an isolated
  copy → `test_grammar_matcher_links_two_syllable_variant` and
  `test_grammar_matcher_links_multiword_variant_by_full_key` both **FAIL**
  (`assert 1 in set()`); restored, confirmed byte-identical to the original.
- B-1 reproduction script: `/tmp/fup010_review/probe_nunde_fp.py` (seeds the
  real connective + nominalizer patterns/categories, drives
  `strategy_c_claude` with the fix's own headline `patternKey`). SF-1
  reproduction: `/tmp/fup010_review/probe_gate.py`,
  `/tmp/fup010_review/probe_gate2.py`, `/tmp/fup010_review/probe_gate3.py`.
  SF-4 timing: isolated `-k test_item_sort_key_is_monotone_with_sql_ordering`
  run at `b33bea8` (0.32s) vs. `HEAD` (4.95s). All under `/tmp/fup010_review/`
  (scratch, not part of the repo).

## Recommendation

Do not ship as-is. Fix B-1 (add a structural discriminator — e.g. word-count
parity — to arm-2's match condition, not just syllable-string equality) and
correct the FOLLOW_UPS.md/docstring precision claim (B-2) before merging.
SF-1 (entry-gate truncation) should be fixed in the same pass since it's
directly entangled with B-1's fix (whatever discriminator you add for B-1
needs to actually be reachable, which requires SF-1's gate to look at the full
pattern too). SF-2 and SF-3 are real but lower urgency — track in
`FOLLOW_UPS.md` if not fixed now. SF-4 is secondary per the task; fix or
consciously accept and update the file's docstring.
