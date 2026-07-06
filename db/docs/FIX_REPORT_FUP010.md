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
