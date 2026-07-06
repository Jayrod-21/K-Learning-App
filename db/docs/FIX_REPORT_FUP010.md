# Fix report — F-UP-010 review (`REVIEW_FUP010.md`)

Independent review verdict was **SHOULD-FIX** (not blocked): the naive
"strip all punctuation from every fragment" match recovered real format-variant
links but introduced a precision regression — **26 spurious cross-links** on the
real KGIU corpus (285 grammar patterns), all driven by 2-syllable normalized
fragments (`다가`↔`아/어다가`, `으로`↔`(으)ㅁ으로써`, `데요`↔`던데요` …), with zero
test coverage in the precision direction.

## Disposition

| Finding | Severity | Disposition |
|---|---|---|
| SF-1 — normalization creates false-positive links (precision regression, untested) | SHOULD-FIX | **FIXED** |
| SF-2 — `TRUNCATE kgiu_entries CASCADE` couples the test to execution order | SHOULD-FIX | **FIXED** |
| N-1 — `가-힯` (Python) vs `가-힣` (SQL) range asymmetry | NIT | **FIXED** |
| N-2 — docstring cross-reference to this review | NIT | **FIXED** |

### SF-1 — precision regression → FIXED (safe union match, gated at 3 syllables)

Root cause: substring matching **cannot** distinguish a true 2-syllable variant
(`는데` → `-(으)ㄴ/는데`) from a false one (`다가` → `-아/어다가`) — both are a
2-syllable fragment that is a substring of the longer stored form after stripping.
So the fix does not try to. `grammar_candidates_by_pattern_substring` now OR's two
arms:

1. **Raw** `pattern ILIKE '%<fragment>%'` — the original punctuation-exact match,
   for **all** fragments (baseline behavior, accepted precision).
2. **Syllable-normalized** `regexp_replace(pattern,'[^가-힣]','') ILIKE '%<syllables>%'`
   — applied **only** when the fragment has `>= _STRATEGY_C_MIN_NORMALIZED_HANGUL_CHARS`
   (3) syllables, where the punctuation-strip is safe.

**Validated on the real corpus** (`tools/ingest/output/grammar_kgiu_*.json`, 285
patterns) with the reviewer's own methodology (raw-vs-new cross-match diff):

| Match rule | New spurious cross-links vs raw |
|---|---|
| strip-all (rejected) | **26** |
| raw + normalized≥3 (shipped) | **2** (both borderline: modifier-form patterns matching a modifier reference — arguably legitimate) |

Cost: the 2-syllable headline case (`는데`) is **intentionally not** recovered —
a missed link is safer than a wrong one for a prerequisite graph. FOLLOW_UPS
F-UP-010 now tracks the proper fix (alternation-aware expansion of `(으)`/`ㄴ/는`
into surface forms), which is the only way to safely handle the 2-syllable case.

Two tests replace the old single `는데` test, **both empirically proven
revert-catchers** (patched the gate constant in the real file and ran):
- `test_grammar_matcher_normalizes_long_fragment_across_punctuation` — `으려고`
  (3 syl) → `-(으)려고 하다`. Fails with the normalized arm disabled (MIN=99).
- `test_grammar_matcher_does_not_normalize_short_fragment` — `다가` (2 syl) must
  NOT match `-아/어다가`. Fails when 2-syllable normalization is re-enabled (MIN=2)
  — i.e. it catches exactly the 26-false-positive regression.

### SF-2 — test isolation → FIXED

Dropped the blanket `TRUNCATE kgiu_entries CASCADE`. Both new tests now assert on
**only the id they seeded** (`eid in / not in {c.id for c in cands}`), so they are
order-independent on the shared module-scoped DB and safe under `pytest-randomly`.
They also test the matcher directly (not through `strategy_c_claude`), so the
per-item cap can't hide or fabricate a result.

### N-1 — range asymmetry → FIXED

The caller's `hangul_only` comprehension now uses `"가" <= ch <= "힣"`
(U+AC00–U+D7A3, the assigned-syllable range) to match the SQL `[^가-힣]` strip,
with a comment. (Inert before — the gap U+D7A4–D7AF is unassigned — but no longer
a latent inconsistency.)

### N-2 — docstring cross-reference → FIXED

The matcher docstring now carries the full F-UP-010 rationale + the corpus
numbers, and the `_HANGUL_RE` extraction keeps the punctuated fragment for the
evidence trail (explained inline), so a future reader diffing `_HANGUL_RE` against
the SQL strip sees the design intent.

## Verification

Ingest container (`python:3.12-slim`, testcontainers Postgres): `ruff check` clean,
`mypy link_topik_dependencies.py` → Success, `pytest tests/test_link_topik_dependencies.py`
→ **15 passed**. Both revert-catchers proven to fail on the reverted matcher.

---

# Addendum — F-UP-010 FULL fix (alternation expansion) + its fixpass

The safe-union above was later superseded by alternation-aware expansion
(`_pattern_alternant_forms`), so the 2-syllable case (`는데` → `-(으)ㄴ/는데`) is now
handled. That change went through its OWN fixpass (`REVIEW_FUP010_FULL.md`), which
returned **BLOCKER**. Disposition:

| Finding | Disposition |
|---|---|
| BLOCKER — the concat expander collapsed the two-word nominalizer `-는 데` onto the one-word connective `-(으)ㄴ/는데` (both → `는데`), plus `-(으)ㄹ 만하다`↔`만 하다` (both → `만하다`) — 2 spurious families, not the claimed ~1 | **FIXED** |
| BLOCKER — the caller gate rejected a multi-word key on its short FIRST word before the form arm ran (proved `-는 데` → 0 deps), undercutting the "matches by whole form" claim; no test exercised the real `strategy_c_claude` path | **FIXED** |
| SHOULD-FIX — candidate fetch had no `ORDER BY` + a Python cap-and-break → non-deterministic drop | **FIXED** |
| SHOULD-FIX — expander mangled 3/285 patterns whose `(…)` spans a space (garbage forms) | **FIXED** |
| SHOULD-FIX — the F-UP-011 autouse fixture forced Postgres/Docker onto pure-unit tests (0.32s→4.95s) | **FIXED** |

**Structure-aware forms (the BLOCKER fix).** Per-word syllable parts are now joined
with `_KGIU_FORM_SEP` instead of concatenated, so a form encodes WORD STRUCTURE: one
word `는데` (`는데`) ≠ two words `는 데` (`는␟데`). And `(X)` optionals are expanded on
the whole sub-string BEFORE the space split, so a `(…)` group spanning a space is
resolved as a unit (fixes the garbage-form finding too). Re-validated on the real
corpus with the reviewer's methodology: **26 (strip) → 11 (concat) → 6 (this)**, and
all 6 are CORRECT (same-grammar sense/POS variants + `대로` family) — **zero
genuinely-distinct false positives**, including the nominalizer and `만하다` pairs
now gone.

**Gate fix.** The raw arm stays gated at 2 syllables (a 1-syllable raw substring
over-matches), but the form arm runs whenever the FULL key yields any surface form,
so a multi-word key with a short first word (`-(으)ㄹ 만하다` → first run `으`) reaches
it. Added `test_strategy_c_end_to_end_multiword_key_through_gate` — the first test to
drive the real `strategy_c_claude` path (not the matcher directly).

**Fixture fix.** `_isolate_tables` now truncates only when the test requests `schema`,
so pure-unit tests run container-free (measured 0.31s).

Verification (ingest container): `ruff` + `mypy` clean; linker suite **19 passed** on
normal order + `pytest-randomly` seeds 1–3; the two recall tests proven to fail with
the form arm disabled; full ingest suite **329 passed**; corpus re-validation = 6
all-correct cross-links; unit test 0.31s (no container).

## Re-review (`REVIEW_FIXES_FUP010_FULL.md`) → PASS WITH CONDITIONS

The re-reviewer independently re-derived the corpus count (6 cross-links, all
same-headword sense/POS variants — nominalizer + 만하다 pairs confirmed gone) and
proved each BLOCKER half has its OWN revert-catcher. Three new SHOULD-FIX:
- **Empty jamo-only word parts were dropped** from the join, collapsing ~25% of
  `-(으)ㄹ/ㄴ X` patterns back toward concat-form (same bug class this fixpass
  targets, though not live-colliding) → **FIXED** here: the join now keeps empty
  slots as boundaries (`␟만하다`). Re-validated: still 6 all-correct cross-links.
- **Parenthetical-alternative parens** (`안 A/V (A/V-지 않다)`, 3 patterns) still
  produce garbage forms → **DEFERRED** (F-UP-012; recall-only, no collision).
- **Raw-arm candidate cap (25) hit** by `kgiu-advanced-049` → **DEFERRED** (F-UP-012;
  pre-existing raw-arm imprecision, not a regression from this diff).
