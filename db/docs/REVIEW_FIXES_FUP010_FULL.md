# Review: fix-pass for F-UP-010 full (alternation-aware expansion) + F-UP-011

**Reviewer:** independent re-reviewer (read-only), Python + Postgres + Korean
linguistics. Fresh eyes — did not write this code, either prior fix, or either
prior review. Branch `fix/fup010-full-fup011`, HEAD `78198a2`.

All corpus/collision numbers below were computed **independently**: I copied
`_pattern_alternant_forms`, `_expand_parens`, `_KGIU_POS_PREFIX_RE`,
`_KGIU_NOISE_RE`, `_KGIU_FORM_SEP`, and `_HANGUL_RE` verbatim into standalone
scripts (`/tmp/kmreview/probe_crosslinks.py` and inline probes), loaded the
real `tools/ingest/output/grammar_kgiu_{beginner,intermediate,advanced}.json`
(285 grammar entries), and re-ran the full corpus-vs-corpus cross-link
simulation from scratch — I did not import or trust the shipped module's own
counts, and I did not accept `FIX_REPORT_FUP010.md`'s claims without
re-deriving them. Test execution (ruff, mypy, pytest, revert-catchers) was run
in throwaway Docker containers (`python:3.12-slim` + testcontainers Postgres,
`--network host`, Docker socket mounted); the real working tree was never
edited, staged, or committed to — all patch experiments ran against scratch
copies (`/tmp/scratch_repo{,2,3}`) inside ephemeral `--rm` containers.

## Verdict

**PASS WITH CONDITIONS.**

Both BLOCKERs from `REVIEW_FUP010_FULL.md` are genuinely fixed, and I
independently reproduced the evidence rather than trusting the fix report:

- **B-1 (nominalizer/만하다 false positives):** independently re-ran the
  285-entry corpus cross-link simulation from scratch and got **6 directed /
  5 unordered new-only pairs**, matching the commit's claimed "6" exactly. I
  classified all 5 unordered pairs myself (not from the doc) and confirmed
  **all 5 are legitimate** same-headword sense/POS variants (`-(으)니까
  ①/②`, `-(으)ㄹ 거예요 ①/②`, `-(으)ㄹ까요? ①/②/③` cross terms, and the
  `대로` N-attaching/V-attaching pair) — **zero genuinely-distinct false
  positives**. I directly computed the forms for the two specific pairs the
  prior review demonstrated as live false positives and confirmed both are
  now disjoint: `-(으)ㄴ/는데` → `{는데}` vs `-는 데` → `{는␟데}`
  (`intersect: frozenset()`), and `-(으)ㄹ 만하다` → `{으␟만하다, 만하다}`
  vs `만 하다` → `{만␟하다}` (`intersect: frozenset()`). I also diffed the
  concat-vs-structured join directly (built both versions from the same
  corpus in one script) and confirmed the **only** 3 unordered pairs lost
  between concat (8) and structured (5) are exactly the nominalizer pair
  (counted twice, for both sense markers ①②) and the `만하다` pair — i.e.
  the fix removed *exactly* the false positives and nothing else (zero new
  pairs gained, zero legitimate pairs collaterally lost).
- **B-1's live-code claim** (gate fix): re-verified via `git diff b33bea8
  78198a2` that the caller's gate in `strategy_c_claude` is no longer the
  unconditional `if len(hangul_only) < 2: continue` — it's now `if
  len(hangul_only) < 2 and not _pattern_alternant_forms(pattern_text):
  continue`, so a multi-word key with a short first Hangul run (`-(으)ㄹ
  만하다` → first run `으`, 1 syllable) still reaches the form arm because
  the full key yields a form. I proved this two ways in a scratch container:
  (1) reverting *only* the matcher's `expand` computation to `False` makes
  the two matcher-level recall tests fail (`assert 1 in set()`) but the new
  end-to-end test *also* fails independently; (2) reverting *only* the
  caller's gate back to the old unconditional check (matcher untouched)
  leaves the two matcher-level tests passing (they call the matcher
  directly, bypassing the caller) but makes
  `test_strategy_c_end_to_end_multiword_key_through_gate` fail on its own —
  proving that test is a genuine, independent revert-catcher specifically
  for the gate fix, not just a duplicate of the matcher tests. This directly
  answers the prior review's complaint that "none of the three new tests
  exercise this real path."
- **BLOCKER-regression-catcher genuinely fires:** I additionally simulated
  the *old concat* expander (join with `""` instead of `_KGIU_FORM_SEP`) in
  a scratch copy and confirmed `test_grammar_matcher_rejects_nominalizer_collision`
  **fails** against it (`assert 1 not in {1}` → `1 in {1}`), i.e. the new
  precision test is a real, demonstrated catcher for the exact BLOCKER the
  prior review found — not a test that merely passes because the raw arm
  also happens to reject it.

CI gates and the full suite are green, reproduced independently, not just
trusted from the commit message:

- `ruff check` on both changed files: **all checks passed**.
- `mypy link_topik_dependencies.py`: **Success, no issues found**.
- `pytest tests/test_link_topik_dependencies.py -q`: **19 passed**, and again
  under `pytest-randomly --randomly-seed={1,2,3}`: **19 passed** every seed.
- Full ingest suite (`pytest tests -q
  --ignore=tests/test_resolve_cross_references_integration.py`): **329
  passed, 4 skipped**.
- Fixture #5 (F-UP-011 gate on `"schema" in request.fixturenames`): ran the 6
  pure-unit tests in isolation (`-k "test_item_sort_key_is_monotone... or
  test_pattern_alternant_forms_expansion or ..."`) — **6 passed in 0.23s**,
  no container spun up despite the Docker socket being mounted and available,
  confirming the gate genuinely skips DB setup for tests that don't request
  `schema`. I also confirmed every DB-touching test in this file (all 15
  integration tests) explicitly takes `schema` as a parameter — none reaches
  the DB transitively through some other un-named fixture — and the
  `_isolate_tables` fixture is defined locally in this test module (not
  `conftest.py`), so it cannot silently affect other ingest test files.

I did **not** find any BLOCKER. I found three new SHOULD-FIX-level gaps the
fix's own claims overstate or leave open — none demonstrated as a live
false-positive on the real, current 285-entry corpus, but all worth fixing or
explicitly tracking before the corpus (or this matcher's reuse) grows.

## BLOCKER finding-by-finding (independent re-verification)

### B-1 — alternation matcher false positives (nominalizer, 만하다)

**Status: FIXED, independently confirmed.** See Verdict above for full
methodology and numbers. Full listing of my independently-derived 5 unordered
pairs:

| # | Pair | Shared form(s) | My classification |
|---|---|---|---|
| 1 | `은/는 대로` (manner) ↔ `-(으)ㄴ/는 대로` (state) | `는␟대로` | Legitimate — N/V-attaching variants of the same core meaning |
| 2 | `V-(으)ㄹ 거예요 ①` ↔ `A/V-(으)ㄹ 거예요 ②` | `으␟거예요`, `거예요` | Legitimate — same headword sense variants |
| 3 | `A/V-(으)니까 ①` ↔ `V-(으)니까 ②` | `으니까`, `니까` | Legitimate — same headword sense variants |
| 4 | `V-(으)ㄹ까요? ①` ↔ `A/V-(으)ㄹ까요? ③` | `으까요`, `까요` | Legitimate — same headword sense variants |
| 5 | `V-(으)ㄹ까요? ②` ↔ `A/V-(으)ㄹ까요? ③` | `으까요`, `까요` | Legitimate — same headword sense variants |

Zero genuinely-distinct false positives. The nominalizer and `만하다` pairs
that drove the prior BLOCKER are gone, confirmed by direct computation (not
by absence from the list alone).

### B-1 (gate) — caller truncating multi-word keys on a short first word

**Status: FIXED, independently confirmed.** See Verdict above. The gate now
consults `_pattern_alternant_forms(pattern_text)` (the FULL key) before
deciding to skip, so a legitimate multi-word key reaches the form arm even
when its first space-delimited word is short. Both halves of the fix (matcher
`expand` logic and caller gate) were shown, via two *independent* revert
experiments, to each have their own dedicated failing test.

### B-2 — FOLLOW_UPS.md / docstring precision claim

**Status: FIXED.** `FOLLOW_UPS.md:128-156` now states "6 cross-links total,
all 6 correct," which matches my independently-derived count exactly. The
`_pattern_alternant_forms` docstring (`link_topik_dependencies.py:481-483`)
makes the same claim and is likewise accurate against my re-derivation.

## New findings

None of the following are demonstrated live false positives on the current
285-entry corpus (I exhaustively checked); they're residual design gaps or
overclaims worth tracking, in descending order of how directly they touch
this diff's own stated design goals.

### SF-A — the "structure-aware" join silently collapses back to concat-like behavior for ~25% of the corpus, because empty (jamo-only) word parts are dropped before joining

`link_topik_dependencies.py:497-501`:
```python
parts = ["".join(ch for ch in w if "가" <= ch <= "힣") for w in combo]
if sum(len(p) for p in parts) >= 2:
    forms.add(_KGIU_FORM_SEP.join(p for p in parts if p))
```
`_KGIU_FORM_SEP.join(p for p in parts if p)` — the `if p` filters out any
word whose Hangul-only reduction is empty. This happens whenever a
space-delimited word is a **bare modifier-tense jamo** left over after the
POS-prefix strip — e.g. `"-(으)ㄹ"` → after paren-expansion and prefix strip
becomes the bare consonant `"ㄹ"`, which is *not* one of the literal
`A/V`/`N` POS-prefix strings the regex strips, so it stays in `word_alts` as
a real "word" (`{"ㄹ"}`), but its Hangul-syllable filter is empty (ㄹ is a
jamo, not a syllable in U+AC00–U+D7A3), so it silently vanishes from the
joined form with **no separator marking its absence**.

I scanned all 285 entries for this: **71/285 (25%)** produce at least one
form where a word vanishes this way — every KGIU pattern of the extremely
common shape `-(으)ㄹ/ㄴ + bound noun` (`-(으)ㄹ 만하다`, `-(으)ㄴ 후에`,
`-(으)ㄹ 수 있다`, `-(으)ㄴ/는 대로`, `-(으)ㄹ 셈이다`, etc.). For all of
these, the joined form is **indistinguishable from a hypothetical genuinely
single-word pattern with the same trailing syllables** — e.g.
`"-(으)ㄹ 만하다"` produces the bare form `"만하다"` (no `_KGIU_FORM_SEP`
at all), identical to what a one-word pattern literally spelled `"만하다"`
would produce. This is exactly the class of bug the fix's own BLOCKER was
about (structure collapsing two different word-counts onto the same
string) — it's just not triggered by this diff's OWN test cases, and not
live today: I checked every one of the 71 collapsed bare-forms against the
other 284 entries and found only 2 collisions, both already-known-benign
(the legitimate `거예요 ①/②` sense pair, and the `irregular`-category
`불규칙` family, which is excluded from the form arm by the `category !=
"irregular"` guard regardless). **No genuinely-distinct false positive
today**, but this is a latent landmine: any future single-word grammar entry
(a new KGIU edition, or reusing this matcher for TTMIK/another corpus) whose
trailing syllables match one of these 71 collapsed forms (`만하다`, `거예요`,
`후에`, `때`, `지`, `수`, `줄`, `것`, `대로`, `셈이다`, `뻔하다`, `척하다`,
`뿐이다`, …) would silently and wrongly link, exactly reproducing this diff's
own BLOCKER via a path its tests don't cover. Given `kgiu_entries` is
described in this same commit as "bounded by a finite pair of print
textbooks… will never approach thousands" the practical risk is low right
now, but the claim that the fix makes the matcher "structure-aware" is
overstated for this entire word-shape.

**Recommendation:** don't drop empty parts silently — either (a) keep a
placeholder for a vanished word so the separator count still reflects true
word count (e.g. join ALL parts including empties with the separator, then
strip only a leading/trailing separator), or (b) explicitly special-case
bare single-jamo tense/modifier markers (`ㄹ`, `ㄴ`, `ㅆ`, `ㅂ`) as "not a
word" the same way the `A/V`/`N` POS-prefix strip already does, so the
design decision is intentional and documented rather than an accidental
side effect of the `if p` filter. Either way, re-run the corpus scan
afterward to confirm it doesn't reintroduce a live collision.

### SF-B — the fix's "parens spanning a space is resolved as a unit" claim doesn't actually produce correct forms for the 3 patterns it names, though it does fix the earlier *literal-character-leak* symptom

`link_topik_dependencies.py:433-443`, `_expand_parens`, combined with the
docstring's own worked example. I traced the exact 3 patterns the prior
review's SF-3 flagged (`안 A/V (A/V-지 않다)`, `못 V (V-지 못하다)`,
`A/V-지 않아도 되다 (안 A/V-아/어도 되다)`) by hand and confirmed:

- `_expand_parens` concatenates `pre + inner` for the "present" branch. That
  is correct for a true optional-morpheme pattern like `-(으)면` (the `(으)`
  is genuinely part of the SAME word, either attached or not). It is
  **wrong** for this specific KGIU authoring convention, where `X (Y)` means
  "two alternative, mutually-exclusive FULL patterns" (short-form vs.
  long-form negation), not "X with an optional Y stuck on the end."
- Concretely, `"안 A/V (A/V-지 않다)"` now produces exactly **one** form:
  `"안␟지␟않다"` — a three-word garbage compound that combines the short
  form's `안` with the long form's `지 않다`, which is not a real Korean
  string either alternative describes. Its *correct* short form (`안`
  alone) never produces a form at all (it's a single 1-character syllable,
  below the `>= 2` length threshold, so it's silently dropped — a small
  recall gap for this headword's own short-form self-reference), and its
  correct long form (`지␟않다`, 2 words) never appears standalone either —
  only the wrong 3-word fusion does. Same pattern for `"못 V (V-지
  못하다)"` → only `"못␟지␟못하다"` (garbage), and for the 되다 pattern,
  which produces one correct form (`지␟않아도␟되다`) alongside **two**
  garbage forms combining both alternatives (`지␟않아도␟되다␟안␟아␟되다`,
  `...␟어도␟되다`).
- I confirmed none of these 4 garbage forms collide with any other of the
  285 corpus entries today (checked exhaustively), so this is not a live
  regression — but the commit message and docstring claim this class of
  pattern is now "resolved as a unit," which overstates what actually
  happens: the prior review's specific symptom (stray literal `(`/`)`
  characters leaking through as `안않다`/`안지않다`) is gone, but it's
  replaced with a different wrong compound, not a correct expansion.

**Recommendation:** this specific `X (Y)` "short-form (long-form)"
authoring convention needs its own case — expand it as TWO independent
alternative branches (`X` alone, `Y` alone), not one optional-attachment
group, e.g. by detecting when the parenthesized content's own first
non-POS word duplicates the *marker* already present before the parens
(`안`/`못`) and treating the whole thing as a 2-way alternation at the
top level instead of routing it through `_expand_parens`.

### SF-C — the candidate cap (25) is not just a theoretical determinism concern anymore; it is hit exactly at the boundary today, via the pre-existing raw arm

`link_topik_dependencies.py:568` (`_STRATEGY_C_MATCHER_CANDIDATE_CAP = 25`).
I scanned every one of the 285 patterns as a stand-in Claude key and found
`kgiu-advanced-049` (`'-아/어 대다'`, category `habit`) produces exactly
**25** raw-arm matches (uncapped count, confirmed independently) —
`-아/어 내다`, `-아/어요`, `-아/어서`, `-아/어야 되다/하다`, `-아/어도
되다`, `-아/어 주세요`, `-아/어 보다`, `-아/어도`, `-아/어하다`, `-아/어
있다`, `-아/어지다`, `-아/어 보이다`, `-아/어야`, `-아/어 가지고`,
`-아/어다가`, `-아/어 놓다`, `-아/어 두다`, `-아/어 버리다`, `-아/어
봤자`, etc. — **all 25 are entirely distinct connective/aspectual
constructions**, not variants of "-아/어 대다"; they merely share the
common `-아/어` vowel-harmony ending marker as a literal substring. This
is the pre-existing RAW arm (unchanged by this diff, and per its own
docstring "already accepted" precision), so it's not a regression this
commit introduced — but it means the `ORDER BY id` determinism fix (which
is correct and does solve SF-2 as originally scoped) doesn't address the
fact that this cap is now demonstrably being hit by a real corpus pattern,
at zero margin, not just a hypothetical "if the corpus grows" scenario.
If Claude ever legitimately returns a short, common-ending patternKey shape
like this, `strategy_c_claude`'s own separate `_STRATEGY_C_MAX_DEPS_PER_ITEM
= 10` cap (line 795) would additionally truncate before all 25 even get
used, so the practical per-item blast radius is bounded — but the 25
candidates themselves are overwhelmingly noise, not a graph that's merely
"large," and today's exact-boundary hit means the "unlikely at 285 rows"
framing in this diff's own comments is already wrong for at least one row.

**Recommendation:** this is a raw-arm precision issue, not an
alternation-arm one, and out of THIS diff's stated scope — but worth a
FOLLOW_UPS entry now that it's demonstrated live, e.g. requiring the raw
arm's fragment to align on a word boundary (not a mid-word substring) the
same way the form arm already does.

## Recall regression check (did the separator over-correct?)

I directly diffed the **concat** join (the pre-fixpass code, joining with
`""`) against the shipped **structured** join (joining with
`_KGIU_FORM_SEP`) across the full 285×284 pair space in one script. Result:
**zero pairs gained, exactly 3 pairs lost** (the nominalizer pair counted
twice for both sense markers, plus the `만하다` pair) — i.e. every pair the
structured join drops relative to concat is one of the two confirmed false
positives, and no legitimate same-grammar link was collaterally lost. The
fix did not over-correct on the current corpus.

## Recommendation

Ship as-is for this corpus — no BLOCKER, and the two prior BLOCKERs are
solidly fixed with genuine, independently-reproduced revert-catchers on both
halves (matcher + gate). Before the KGIU/TTMIK corpus grows or this matcher
gets reused elsewhere, address SF-A (vanishing jamo-only word parts
undermine the structure-aware guarantee for ~25% of today's shapes) and SF-B
(the `X (Y)` short/long-form negation convention still produces garbage,
just a different garbage than before) — both are exactly the kind of
"structure collapse" bug this fixpass was built to eliminate, just not yet
triggered by the current closed corpus. Track SF-C (raw-arm cap hit at
25/25 today) in `FOLLOW_UPS.md` as a pre-existing, out-of-scope-for-this-diff
issue now that it's demonstrated rather than hypothetical.
