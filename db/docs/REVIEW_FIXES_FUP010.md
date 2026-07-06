# Review: fix-pass for F-UP-010

**Reviewer:** independent re-reviewer (read-only), Python + Postgres + Korean-text processing.
Did not write the fix, did not write the original review.
**Branch:** `fix/loader-durable-fixes`; fix-pass commit under review: `HEAD~1` = `b33bea8`
("fix(ingest): safe punctuation-tolerant strategy_c match (F-UP-010)").
**Scope:** `tools/ingest/link_topik_dependencies.py`, `tools/ingest/tests/test_link_topik_dependencies.py`,
`FOLLOW_UPS.md`, `db/docs/FIX_REPORT_FUP010.md`, checked against `db/docs/REVIEW_FUP010.md`.

All verification below was run against an isolated `rsync` copy of the repository at
`/tmp/fup010_review/repo_copy` (and, for the pre-existing-bug check, a `git archive` of
`b33bea8^` at `/tmp/fup010_review/parent_copy`) — the real working tree was never
edited, staged, or committed to.

## Verdict

**PASS WITH CONDITIONS.**

SF-1 and N-1 are genuinely, independently reproduced as fixed — I do not just believe
the FIX_REPORT's numbers, I regenerated them from scratch with my own script against
the same real KGIU corpus and got the same 26 → 2. SF-2 is fixed for the two tests it
was written against: both are demonstrably order-independent in isolation. But while
verifying SF-2's underlying claim (order-independence "under `pytest-randomly`") I
found a live, reproducible test-order-dependency in this same file that the fix-pass
did not touch and did not introduce — `test_strategy_a_writes_grammar_dep_per_matched_kgiu_entry`
(`tools/ingest/tests/test_link_topik_dependencies.py:358`) fails with `15 != 3` if
`test_strategy_c_caps_deps_per_item_and_rejects_short_fragments` runs before it,
and I confirmed this same failure occurs identically on the pre-fix parent commit
(`b33bea8^`), so it predates this fix-pass and is not a regression it caused. It does,
however, mean the fix-pass's implicit claim that this test file is now safe for
`pytest-randomly` is **false at the file level**, even though **true for the two new
tests specifically**. See New Finding NF-1. Nothing here blocks merge of `b33bea8`
itself — the diff under review does what it says — but NF-1 should be filed before
anyone flips on `pytest-randomly` per SENIOR_ENGINEER_BAR §5.5, or the next engineer
will spend an afternoon debugging a "flaky" test that is actually deterministic given
a fixed root cause.

## Finding-by-finding

### SF-1 — normalization creates false-positive links (precision regression) → **FIXED**

Independent evidence, not just re-reading the report: I wrote my own simulation
script (`/tmp/fup010_review/sim.py`, methodology below) against the real corpus
(`tools/ingest/output/grammar_kgiu_{beginner,intermediate,advanced}.json`, 285
grammar-type entries confirmed) and mirrored the *actual shipped* matcher logic
read from `link_topik_dependencies.py:420-465` — not a paraphrase of it:

- raw arm: `fragment in other_pattern` (unconditional, all fragment lengths)
- normalized arm: `hangul_only(fragment) in strip_non_hangul(other_pattern)`,
  gated by `len(hangul_only(fragment)) >= 3` — matching
  `_STRATEGY_C_MIN_NORMALIZED_HANGUL_CHARS = 3` at `link_topik_dependencies.py:714`

Result, counting only pairs that are new under a rule but were **not** already a
raw match (i.e., "new-only" cross-links, same methodology the original reviewer
used):

| Match rule | New-only spurious cross-links (my independent count) |
|---|---|
| naive strip-all, unconditional (rejected) | **26** |
| shipped: raw + normalized(≥3 syllables) | **2** |

Both counts match the FIX_REPORT's claimed 26 → 2 exactly. The 2 shipped-arm
survivors are also exactly the pair the FIX_REPORT calls "borderline... modifier-form
patterns matching a modifier reference": `-(으)ㄴ/는/(으)ㄹ 줄 몰랐다(알았다)` and
`-(으)ㄴ/는/(으)ㄹ 만큼`, both spuriously matching the generic
`관형형 -(으)ㄴ/-는/-(으)ㄹ N` reference entry — same target, same category, same
count. This is a real, independently-regenerated confirmation, not a rubber stamp.

One nuance worth recording: the original review's table labeled "7×" patterns as
colliding with the generic modifier-form entry; my own full enumeration under the
**naive** (rejected) rule finds 10 such collisions, not 7 (the review's table was
evidently a representative excerpt, not an exhaustive list — the review's *total*
of 26 and the FIX_REPORT's *total* of 26→2 are both exactly right; only the
per-category breakdown in the review's illustrative table was partial). This does
not change any disposition.

**Confirmed the length gate is Python-side, not SQL-side, as the task asked me to
check:** `link_topik_dependencies.py:459` — `if len(hangul_fragment) >=
_STRATEGY_C_MIN_NORMALIZED_HANGUL_CHARS:` is a plain Python `if` that decides
which of two literal `where_clause` strings gets built before the query is ever
sent; there is no `char_length(...) >= 3` predicate inside the SQL itself. This
matches what I simulated (a Python-side branch controlling which SQL runs) and
matches the FIX_REPORT's description.

### SF-2 — `TRUNCATE kgiu_entries CASCADE` couples the test to execution order → **FIXED for the two tests it targets; a related, pre-existing issue remains open elsewhere in the file (NF-1)**

Confirmed by direct diff read (`git show b33bea8 -- tools/ingest/tests/test_link_topik_dependencies.py`):
the `TRUNCATE` is gone; both new tests
(`test_grammar_matcher_normalizes_long_fragment_across_punctuation:811`,
`test_grammar_matcher_does_not_normalize_short_fragment:843`) seed exactly one
row each under a fixture-unique `source_id` (`kgiu-fup010-recall` /
`kgiu-fup010-precision`) and assert only membership of their own returned `id`
(`eid in {...}` / `eid not in {...}`), never a raw count. I verified this is a
correct, sufficient fix for these two tests specifically by running them, in the
ingest container, in three different relative orders (alone via `-k`, immediately
after each other, and interleaved with `test_strategy_c_caps_deps_per_item_and_rejects_short_fragments`
which seeds 12 unrelated rows into the same table) — both pass every time. They
also call the matcher directly (`ltd.grammar_candidates_by_pattern_substring`),
not through the capped `strategy_c_claude`, so the per-item cap can't mask a
false result — confirmed a fair unit test as the task asked me to check.

**However**, while stress-testing "order independence" for this finding I ran the
suite with an explicit non-file-order node list:

```
pytest tests/test_link_topik_dependencies.py::test_grammar_matcher_does_not_normalize_short_fragment \
       tests/test_link_topik_dependencies.py::test_grammar_matcher_normalizes_long_fragment_across_punctuation \
       tests/test_link_topik_dependencies.py::test_strategy_c_caps_deps_per_item_and_rejects_short_fragments \
       tests/test_link_topik_dependencies.py::test_strategy_a_writes_grammar_dep_per_matched_kgiu_entry
```

`test_strategy_a_writes_grammar_dep_per_matched_kgiu_entry` **fails**: `assert
len(deps) == 3` gets 15, because `test_strategy_c_caps_deps_per_item_and_rejects_short_fragments`
(`test_link_topik_dependencies.py:737`) seeds 12 rows with `category="connective"`,
and `test_strategy_a`'s call into `strategy_a_skill_tag` → `grammar_candidates_by_category`
matches on category across the whole shared table, with no scoping by `source_id`
or item. This is not one of the two new F-UP-010 tests — it is untouched by
`b33bea8` — and I confirmed it is **not a regression**: I built a `git archive` of
the parent commit (`b33bea8^`) into an isolated copy and ran the identical
node-order test against it; it fails identically (`15 != 3`). So this is a
pre-existing latent order-dependency in the shared module-scoped `schema` fixture
(`test_link_topik_dependencies.py:135`, shared by 14+ tests), not something this
fix-pass introduced or made worse. But it directly undercuts the practical value
of SF-2's fix: the original reviewer's own hypothetical ("a worker could run this
test before `test_strategy_a_writes_grammar_dep_per_matched_kgiu_entry`") turns out
to already be true today, via a different mechanism (unscoped category count,
not `TRUNCATE`) than the one that got fixed. See **New Finding NF-1**.

### N-1 — Hangul-syllable range asymmetry (가-힯 vs 가-힣) → **FIXED**

Confirmed by diff: `link_topik_dependencies.py:776` now reads `hangul_only =
"".join(ch for ch in fragment if "가" <= ch <= "힣")` (U+AC00–U+D7A3), matching
the SQL-side `regexp_replace(pattern, '[^가-힣]', '', 'g')` at line 462 exactly,
with an inline comment explicitly citing "N-1". Both ends of the comparison now
use the same range. As the original review noted, this was inert either way
(the U+D7A4–D7AF gap is unassigned Unicode), so there's no behavior change to
verify beyond the textual alignment — confirmed present.

### N-2 — docstring cross-reference to this review → **FIXED**

`grammar_candidates_by_pattern_substring`'s docstring (`link_topik_dependencies.py:423-455`)
now carries the full two-arm rationale, the 26→2 corpus numbers, and an explicit
"F-UP-010" tag; the `_STRATEGY_C_MIN_NORMALIZED_HANGUL_CHARS` constant comment
(`link_topik_dependencies.py:708-713`) cross-references the same function. A
future reader diffing `_HANGUL_RE` against the SQL strip now has the design
intent in both places. Confirmed present and substantive, not a token gesture.

## New findings

**NF-1 (SHOULD-FIX, not introduced by this fix-pass) — file-wide test-order
dependency remains despite SF-2's fix, via a different, pre-existing mechanism.**
`tools/ingest/tests/test_link_topik_dependencies.py:358`,
`test_strategy_a_writes_grammar_dep_per_matched_kgiu_entry`, asserts an unscoped
`len(deps) == 3` from `strategy_a_skill_tag`'s category-based candidate query
against the shared, module-scoped `kgiu_entries` table. Any other test in the
14-test module that seeds a row with `category` in `{connective, condition,
reason}` before this test runs will inflate that count and fail it — empirically
demonstrated with `test_strategy_c_caps_deps_per_item_and_rejects_short_fragments`
(seeds 12 `category="connective"` rows), and confirmed pre-existing (reproduces
identically on `b33bea8^`, before this fix-pass). This directly matters to SF-2
because SF-2's own stated rationale was order-independence "under
`pytest-randomly`" (a tool SENIOR_ENGINEER_BAR §5.5 recommends adopting) — that
guarantee does not hold for the file as a whole today, only for the two tests
this fix-pass touched. **Recommendation:** scope
`test_strategy_a_writes_grammar_dep_per_matched_kgiu_entry`'s assertion to rows
it seeded (filter `deps` to `grammar_entry_id` values returned by its own
`_seed_kgiu_entry` calls, mirroring the pattern the two new F-UP-010 tests now
use) before enabling `pytest-randomly` for this suite. Out of scope for `b33bea8`
itself (it neither introduced nor was asked to fix this), but it should be
tracked — suggest adding it to `FOLLOW_UPS.md` since F-UP-010's own FOLLOW_UPS
entry is the one place in this codebase already discussing this test file's
isolation properties.

No other new findings. SQL construction (`where_clause` f-string,
`link_topik_dependencies.py:460-465`) was checked independently: `where_clause`
is always exactly one of two hardcoded literal strings chosen by the Python `if`
above it, never derived from `fragment`/`hangul_fragment`/any external input; the
two variable operands (`raw_like`, and `f"%{hangul_fragment}%"` when present) are
passed as `%s`-bound `params`, never string-interpolated into the query text. No
injection surface, confirming the original review's PRAISE note and the
FIX_REPORT's claim.

The "caps test still passes for the right reason" claim (original review's
PRAISE) also still holds post-fix: I confirmed via the full-suite run that
`test_strategy_c_caps_deps_per_item_and_rejects_short_fragments` continues to
hit its cap via the **raw** arm (the seeded pattern `-(으)ㄴ/는데 #{i}` already
contains the raw fragment `-(으)ㄴ/는데` as a literal substring), so this test
still does not exercise the new normalized arm at all — not a regression, just
worth recording that precision-path coverage for the ≥3-syllable normalized arm
rests entirely on the one new recall test plus my own out-of-band corpus
simulation, not on any test that seeds a deliberately colliding ≥3-syllable pair.

The intentional 2-syllable scope-narrowing (declining to fix `는데` → `-(으)ㄴ/는데`)
is clearly documented in three places I checked independently: the function
docstring, the `_STRATEGY_C_MIN_NORMALIZED_HANGUL_CHARS` comment, and
`FOLLOW_UPS.md`'s updated F-UP-010 entry (which explicitly names the proper fix —
alternation-aware expansion of `(으)`/`ㄴ/는` — as future work rather than
silently dropping it). This is a defensible, well-documented scope call for a
prerequisite graph, not a silent narrowing.

## Verification log

- `ruff check link_topik_dependencies.py tests/test_link_topik_dependencies.py` → all checks passed (isolated copy).
- `mypy link_topik_dependencies.py` → Success, no issues found.
- `pytest tests/test_link_topik_dependencies.py -q` → **15 passed**.
- Revert-catcher 1: patched `_STRATEGY_C_MIN_NORMALIZED_HANGUL_CHARS` 3→99 in the
  real file (isolated copy) → `test_grammar_matcher_normalizes_long_fragment_across_punctuation`
  **FAILS** (`assert 1 in set()`), other test unaffected. Restored to 3, confirmed
  byte-identical to original and to the untouched real repo file.
- Revert-catcher 2: patched 3→2 → `test_grammar_matcher_does_not_normalize_short_fragment`
  **FAILS** (`assert 2 not in {2}`). Restored to 3, confirmed byte-identical.
- Real-corpus simulation script independently reproduced 26 (naive) → 2 (shipped)
  new-only spurious cross-links against all 285 grammar entries across
  `grammar_kgiu_{beginner,intermediate,advanced}.json`.
- Order-dependency probe: explicit non-file-order pytest node list surfaced
  `test_strategy_a_writes_grammar_dep_per_matched_kgiu_entry` failing at `15 != 3`;
  reproduced identically against a `git archive` of the pre-fix parent commit
  (`b33bea8^`), confirming pre-existing, not a regression from this fix-pass.
- All of the above run in `python:3.12-slim` with `--network host` and the Docker
  socket mounted (testcontainers Postgres), against `rsync`/`git archive` copies
  under `/tmp/fup010_review/` — the actual repository working tree was never
  written to.

## Recommendation

Ship `b33bea8` as-is — SF-1, SF-2 (as scoped), N-1, and N-2 are all genuinely
fixed and I reproduced the evidence myself rather than trusting the FIX_REPORT's
numbers. Before adopting `pytest-randomly` for this test module (a step
SENIOR_ENGINEER_BAR §5.5 recommends and that this very fix-pass's SF-2 rationale
assumed was the target threat model), first land NF-1: scope
`test_strategy_a_writes_grammar_dep_per_matched_kgiu_entry`'s assertions to the
rows it seeded. Track NF-1 in `FOLLOW_UPS.md` alongside the existing F-UP-010
entry so it isn't lost.
