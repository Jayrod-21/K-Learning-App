# Review — F-UP-010: strategy_c Hangul-syllable normalization matcher

**Reviewer:** independent senior review (read-only), Python + Postgres + Korean-text processing
**Branch:** `fix/fup010-matcher-normalization`
**Scope:** `git diff HEAD~1` — `tools/ingest/link_topik_dependencies.py`,
`tools/ingest/tests/test_link_topik_dependencies.py`

## Verdict

**SHOULD-FIX, not blocked on the revert test — but ship this with the false-positive
gap open and you are trading one demonstrated bug (missed links) for another
(wrong links) that has zero test coverage.**

The new test genuinely catches a revert (empirically verified below — it fails
with `got 0` against the pre-fix matcher and passes against the fix). The
normalization-range asymmetry is real but inert for actual Hangul-syllable data.
The TRUNCATE isolation is safe today but couples the test's correctness to file
position and the absence of `pytest-randomly`/xdist. The precision cost is the
substantial finding: using the project's own real KGIU corpus
(`tools/ingest/output/grammar_kgiu_*.json`, 285 grammar patterns), I found 26
concrete pattern pairs where the new normalized-substring match links an item to
an **unrelated** grammar entry that the pre-fix matcher would **not** have
linked — e.g. `-다가` (interruption) now also candidates against `-아/어다가`,
`-았/었다가`, `-(으)려다가`, and `-(으)ㄴ/는 데다가` (four distinct, differently-
glossed grammar points); `(으)로` (the particle) now candidates against
`-(으)ㅁ으로써` ("by means of"); seven different `-(으)ㄴ/는 X` intermediate
patterns (모양이다/반면에/탓에/데다가/대신에/대로/편이다/척하다) now all additionally
candidate-match a generic `관형형 -(으)ㄴ/-는/-(으)ㄹ N` reference entry. None of
this is covered by any test — the suite only proves the recall fix works, not
that it doesn't also regress precision. See Finding SF-1.

## Findings

### BLOCKER
None. (SF-1 below is a real correctness concern but does not meet the bar for
BLOCKER only because it doesn't break the stated acceptance criteria — the new
test passes, is a genuine revert-catcher, and ships no crash/injection/isolation
failure. It is, however, the single most important thing to fix next.)

### SHOULD-FIX

**SF-1 — Normalization creates real, demonstrated false-positive links between
distinct grammar entries (precision regression, untested).**
`tools/ingest/link_topik_dependencies.py:447` (the `regexp_replace(pattern,
'[^가-힣]', '', 'g')` match) strips *all* punctuation from *every* stored
pattern before compare, which erases morpheme boundaries that previously kept
unrelated-but-similar patterns apart. I verified this against the project's own
real KGIU data (`tools/ingest/output/grammar_kgiu_{beginner,intermediate,advanced}.json`,
285 grammar-type entries) by simulating, for every pattern's own Hangul-ish
fragment, whether the OLD raw-substring rule (`fragment in other_pattern`) vs.
the NEW normalized rule (`normalize(fragment) in normalize(other_pattern)`)
matches a *different* entry. Result: **26 new-only false-positive pairs**,
none of them existing pre-fix. Representative examples (all real KGIU entries):

  | Source pattern (category) | New-only spurious match (category) |
  |---|---|
  | `-다가` (interruption) | `-아/어다가` (time), `-았/었다가` (completion), `-(으)려다가` (intention), `-(으)ㄴ/는 데다가` (addition) |
  | `(으)로` (particle) | `-(으)ㅁ으로써` (reason) |
  | `-듯이` (conjecture) | `-는 듯이`, `-(느)ㄴ다는 듯이` (both conjecture, but distinct forms) |
  | `-데요` (ending) | `-던데요` (recollection) |
  | 7× `-(으)ㄴ/는 {모양이다,반면에,탓에,데다가,대신에,대로,편이다,척하다}` | `관형형 -(으)ㄴ/-는/-(으)ㄹ N` (generic modifier-form reference entry, not a usable grammar point) |

  This is exactly the tradeoff the code's own comment at
  `link_topik_dependencies.py:677-681` already flags as a known, accepted risk
  for 2-syllable fragments (`으면`, `는데`) — the normalization does not
  introduce a new *category* of risk, it materially *widens* an already-accepted
  one, because stripping `-`/`(`/`)`/`/` uniformly means any pattern built as
  "common 2-syllable connective + auxiliary/particle" (a very productive
  pattern family in Korean — `V-아/어 주다/보다/있다/놓다/두다/버리다/대다/내다...`)
  now collapses toward the same normalized root as its siblings.
  Reproduction script (read-only, no repo files touched) available on request;
  the core comparison was:
  ```python
  HANGUL_RE = re.compile(r'[㄰-㆏가-힯\-\(\)/]+')
  def norm(s): return re.sub(r'[^가-힣]', '', s)
  # for every (pid, pattern): frag_old = HANGUL_RE.search(pattern).group(0)
  # frag_new = norm(frag_old); flag pairs where frag_new in norm(other) but
  # frag_old NOT in other (raw).
  ```
  **Recommendation (pick one, in order of preference):**
  1. Anchor the match instead of a bare substring — require the normalized
     fragment to align with a pattern *boundary* (start of pattern, or
     immediately after a normalized morpheme-separator retained as a sentinel
     character rather than deleted) instead of an unanchored `%frag%`.
  2. Raise `_STRATEGY_C_MIN_FRAGMENT_HANGUL_CHARS` from 2 to 3 specifically for
     the *normalized* path (keep 2 as the too-short rejection for the
     evidence/logging fragment, but require ≥3 syllables before hitting the DB)
     — the code comment at line 677-681 already accepted that 3 drops some
     legitimate 2-syllable matches (으면/는데); re-weigh that tradeoff now that
     the empirical cost of keeping 2 is quantified above.
  3. At minimum, add a regression test asserting that a *short, common*
     fragment (e.g. `다가` or `으로`) does **not** produce a dependency against
     an unrelated stored pattern in a fixture seeded with several
     `X-다가`-family entries — today there is no test in either direction for
     precision, only for recall.

**SF-2 — `TRUNCATE kgiu_entries CASCADE` couples this test's correctness to
execution order and to the absence of `pytest-randomly`/xdist, violating the
SENIOR_ENGINEER_BAR §5.3 P0 ("isolated... no ordering dependence — passes
alone, any order, in parallel").**
`tools/ingest/tests/test_link_topik_dependencies.py:828`. The `schema` fixture
is `module`-scoped (`test_link_topik_dependencies.py:134-138`) and shared by
14 tests in this file, 6 of which seed `kgiu_entries` rows
(`test_strategy_a_writes_grammar_dep_per_matched_kgiu_entry`,
`test_idempotent_rerun_produces_no_new_rows`,
`test_strategy_precedence_higher_confidence_wins`,
`test_xor_constraint_rejected_at_db_level`,
`test_strategy_c_caps_deps_per_item_and_rejects_short_fragments`, and the new
`test_strategy_c_matches_across_pattern_punctuation_variants` itself). I
traced every other test in the file and confirmed each seeds its **own**
`kgiu_entries` row(s) fresh via `_seed_kgiu_entry`'s `ON CONFLICT DO UPDATE`
before asserting, so under the current CI config (no `pytest-randomly`, no
xdist — confirmed absent from `tools/ingest/requirements-dev.txt` and
`.github/workflows/ci.yml`) the blanket `TRUNCATE ... CASCADE` is safe in
practice: it only erases rows from tests that already ran and already
asserted. But this is safety-by-accident-of-current-config, not
safety-by-design: the moment `pytest-randomly` is added (which
SENIOR_ENGINEER_BAR §5.5 explicitly recommends: *"pytest-randomly to surface
order coupling"*), a worker could run this test before
`test_strategy_a_writes_grammar_dep_per_matched_kgiu_entry` (say), truncating
mid-run and only working by luck of `ON CONFLICT DO UPDATE` reseeding. More
concretely, `CASCADE` also wipes any `topik_item_dependencies` rows whose
`grammar_entry_id` FKs to a truncated `kgiu_entries` row — currently no test
depends on those surviving across test boundaries, but the blast radius of
`CASCADE` is silently larger than "just this table," and nothing documents
which tables that reaches today. Precedent for `TRUNCATE` exists elsewhere in
this suite (`test_load_kgiu_properties.py`, `test_resolve_cross_references_integration.py`),
but those are single-purpose files exercising one loader/resolver — this file
has 14 heterogeneous tests sharing one container, which is a materially
different risk profile.
**Recommendation:** scope the isolation with a `SAVEPOINT`/rollback around just
this test's assertions, or (simpler) query only rows the test itself seeded
(filter by `source_id = 'kgiu-fup010'` or a category unique to the fixture)
instead of truncating the shared table, so the test's correctness doesn't
depend on what ran before it.

### NIT

**N-1 — Hangul-syllable range asymmetry between the Python filter and the SQL
filter is a latent inconsistency, though currently inert.**
`link_topik_dependencies.py:741` computes `hangul_only` with
`"가" <= ch <= "힯"` (U+AC00–U+D7AF, the full official "Hangul Syllables"
*block* range), while the SQL side at `link_topik_dependencies.py:447` uses
`regexp_replace(pattern, '[^가-힣]', '', 'g')` (U+AC00–U+D7A3, the range of
*assigned* syllables). The gap, U+D7A4–U+D7AF, is unassigned in Unicode (no
character exists there), so no real KGIU pattern or Claude `patternKey` can
ever produce a code point in that gap — the asymmetry cannot cause a miss or
a false hit with real data today. Still, one filter is "the block" and the
other is "the assigned range," which reads as unintentional and will confuse
the next person who diffs them. Align both to `가-힣` (U+AC00–D7A3) for
consistency, since that's the range that's actually reachable.

**N-2 — Docstring line 663 references "REVIEW_C4 NIT F8" for the slash-preservation
rationale; worth a comment cross-reference forward to this review (F-UP-010)
now that the slash's role has changed (it's stripped on the SQL side but still
kept in the Python-side `_HANGUL_RE` extraction for the evidence trail) — a
future reader diffing `_HANGUL_RE` against the SQL regex without this review in
hand could reasonably conclude they've drifted out of sync by accident rather
than by design.

### PRAISE

- **Revert-catcher genuinely works.** I copied the two changed files to a
  scratch directory, mechanically reverted both the `grammar_candidates_by_pattern_substring`
  signature/query and the `strategy_c_claude` caller to their pre-fix form, and
  ran only the new test against that reverted copy in the ingest container. It
  failed exactly as the test's own docstring predicts:
  `AssertionError: ... got 0 == 1`. Run against the actual (fixed) code, the
  full suite passes 14/14. This is exactly what SENIOR_ENGINEER_BAR §5.2 P0
  requires ("every bug fix ships with a regression test that fails on the old
  code") and it is not a coincidence — the test's own docstring shows the
  author reasoned through the old-code failure mode before writing the
  assertion, and it holds up under actual execution.
- **No SQL injection.** `link_topik_dependencies.py:447` — the character class
  `[^가-힣]` inside `regexp_replace` is a hardcoded literal in the SQL string,
  never derived from user/model input; the only variable component
  (`hangul_fragment`, wrapped as `%{hangul_fragment}%`) is passed through
  psycopg's `%s` parameter binding (`link_topik_dependencies.py:449`), not
  string-concatenated into the query. Standard, correct parameterization.
- **Caps test continues to pass for the right reason.**
  `test_strategy_c_caps_deps_per_item_and_rejects_short_fragments` seeds
  `-(으)ㄴ/는데 #{i}`; I traced both the pre-fix and post-fix matcher against
  this exact fixture: pre-fix, the raw fragment `-(으)ㄴ/는데` (the *same*
  surface form the seeded rows use) already substring-matches
  `-(으)ㄴ/는데 #{i}` directly, so the cap-hits-at-10 assertion was never
  actually exercising the new normalization path. Post-fix, `hangul_only`
  reduces to `으는데`, and `regexp_replace('...#{i}')` reduces to `으는데{i}`-ish
  (digits stripped too), so the substring match still holds — same 12-row hit,
  same cap-of-10 result, for a consistent (if incidental) reason. No
  regression, and the test's assertions remain meaningful.
- **`hangul_only`/fragment separation for the evidence trail is a good call.**
  Keeping the punctuated `fragment` in `evidence["matched_fragment"]`
  (`link_topik_dependencies.py:768`) while using the normalized `hangul_only`
  for the actual DB lookup preserves debuggability — an operator inspecting a
  wrong/right dependency later can see exactly what Claude returned, not just
  the stripped form used for matching.
- Removal of the unused `AsyncConnectionPool` import
  (`tests/test_link_topik_dependencies.py:34`, pre-diff) is confirmed dead —
  `grep` finds zero other references to it in the file. Legitimate,
  unrelated-but-harmless cleanup.

## Detailed

- `tools/ingest/link_topik_dependencies.py:420-457` —
  `grammar_candidates_by_pattern_substring` signature renamed
  `fragment`→`hangul_fragment`; query changed from
  `pattern ILIKE %s` to `regexp_replace(pattern, '[^가-힣]', '', 'g') ILIKE %s`.
  Parameterization preserved correctly (no injection). Full-table-scan +
  per-row `regexp_replace` on `kgiu_entries` (documented as acceptable given
  table size — confirmed: 285 grammar entries in the real corpus dumps).
- `tools/ingest/link_topik_dependencies.py:741-753` — caller now passes
  `hangul_only` (already computed above at line 741 for the length-guard
  check) instead of the punctuated `fragment` into the matcher; `fragment`
  itself is retained only for the evidence dict at line 768. This reuse is
  clean — no duplicate normalization logic.
- `tools/ingest/tests/test_link_topik_dependencies.py:811-864` — new test.
  Verified empirically (see PRAISE) that it fails against a hand-reverted
  pre-fix copy of the matcher with `got 0`, and passes against the actual
  fixed code. `TRUNCATE kgiu_entries CASCADE` at line 828 — see SF-2.
- `tools/ingest/tests/test_link_topik_dependencies.py:34` (removed) — dead
  `AsyncConnectionPool` import, confirmed unused elsewhere in file.
- CI gates run clean against the actual fixed code in the ingest container
  (`python:3.12-slim`, network-host, docker-socket-mounted for testcontainers):
  `ruff check` → all checks passed; `mypy link_topik_dependencies.py` →
  Success, no issues found; `pytest tests/test_link_topik_dependencies.py -q`
  → **14 passed**.
