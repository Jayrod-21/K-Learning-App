# Review: C1 — Canonical grammar bank

**Reviewer:** Independent senior reviewer (did not write the code).
**Date:** 2026-05-28
**Scope:** migration 006 (`canonical_grammar`), `tools/ingest/canonical_grammar.py`,
`tools/ingest/cluster_canonical_grammar.py`, ADR-021, the normalizer unit tests,
the DB integration tests, and the two READMEs.

---

## Summary verdict

**Conditional ACCEPT.** The design (Option C "hybrid") is the right call,
ADR-021 walks through A and B with substantive reasons that hold up, the
schema is clean, the normalizer is well-factored and well-tested, and the
upsert correctly preserves the senior-reviewer override on
`semantic_family`. There is **one SHOULD-FIX** that directly contradicts a
workflow the README documents (the kgiu-side backfill silently clobbers a
reviewer's manual polysemy split). A couple of SHOULD-FIXes and several
NITs follow. None of this blocks landing the migration — the data layer is
sound — but the SHOULD-FIXes should land before C1 is declared "done"
under the bar §5 checklist.

- **Blockers:** 0
- **SHOULD-FIX:** 3
- **NITs:** 6
- **Praise:** 5

---

## Bar checklist (§5)

| Item | Status | Note |
|---|---|---|
| Lint passes | NOT VERIFIED IN REVIEW | reviewer didn't run; expectation: ruff clean |
| Type-check passes | NOT VERIFIED IN REVIEW | Pydantic models look strict; no `Any` leaks observed |
| All tests pass | NOT VERIFIED IN REVIEW | normalizer + DB tests look coherent |
| Every public function has at least one test | PASS | `normalize_pattern`, `split_compound_pattern`, `pick_canonical_surface`, `classify_semantic_family` all covered |
| `EXPLAIN ANALYZE` on non-trivial queries | N/A at C1 scope | clusterer scans ~300 rows; trivial. The dedup-render query in the Reference UI is the one that needs EXPLAIN — owner: front-end agent |
| `SECURITY.md` written | PASS | `CANONICAL_GRAMMAR_SECURITY.md` enumerates 4 vectors (SQLi, JSONB injection, ReDoS, FK orphaning) with defenses + defense-in-depth |
| `README.md` written, "how to test this" | PASS | `CANONICAL_GRAMMAR_README.md` is operator-grade |
| ADR written | PASS | ADR-021 considers A/B/C and rejects A and B with substantive reasons |
| Migrations reversible AND tested both directions | PARTIAL | the down migration is correct by inspection; reviewer did not find a `migrate up → down → up` test for 006 specifically (the test_canonical_grammar_db.py fixture only calls `up`). SHOULD-FIX-2 |
| No top-level BEGIN/COMMIT in migration body | PASS | confirmed; only `SET LOCAL` + DDL + `DO $$ … $$` blocks |
| No `TODO`/`FIXME` without ticket | PASS | only one TODO, in SECURITY.md, scoped to Phase B (acceptable) |
| No `print()` / `console.log` | PASS | structlog throughout |
| No commented-out code | PASS | |
| No hardcoded secrets/URLs/paths | PASS | `DATABASE_URL` env-var; paths via `_resolve_input` |

---

## Findings

### SHOULD-FIX-1 — kgiu backfill clobbers manual polysemy splits

`cluster_canonical_grammar.py:_backfill_kgiu_entries` issues:
```sql
UPDATE kgiu_entries
   SET canonical_grammar_id = %s, …
 WHERE corpus = %s
   AND source_id = %s
   AND canonical_grammar_id IS DISTINCT FROM %s
```
The `%s` in both SET and the IS DISTINCT FROM check is the **auto-derived**
canonical id (from the cluster the row falls into by surface form).

The README documents this manual-split workflow:
```sql
INSERT INTO canonical_grammar (pattern_key, canonical_pattern, semantic_family)
  VALUES ('(으)니까#discovery', 'V-(으)니까 ②', 'discovery');
UPDATE kgiu_entries
   SET canonical_grammar_id = (SELECT id FROM canonical_grammar
                                WHERE pattern_key = '(으)니까#discovery')
 WHERE source_id = 'kgiu-beg-u20-02';
```
After this manual split, the row `kgiu-beg-u20-02` still has
`pattern_normalized = '(으)니까'`, so the next `apply` rebuilds the
`(으)니까` cluster with this row as a member, computes its auto canonical
id (the `(으)니까` row's id), sees that `canonical_grammar_id IS DISTINCT
FROM auto_id` (because it currently points at the manual `#discovery`
row), and silently overwrites — undoing the reviewer's split and bumping
`version` on every re-apply.

The README claims "Re-running `apply` will leave the manual split in
place: the upsert is keyed on `pattern_key` (UNIQUE) and the `WHERE`
clause in `_upsert_clusters` only touches display columns." That is true
for `_upsert_clusters` but not for `_backfill_kgiu_entries`, which is the
step that actually owns the kgiu-side FK.

**Fix options:**
1. Skip a kgiu row in `_backfill_kgiu_entries` if its current
   `canonical_grammar_id` already points at *any* canonical row whose
   `pattern_key` starts with the auto pattern_key + a disambiguator
   suffix (e.g., `(으)니까#…`). Convention-driven; matches the README.
2. Add a `manual_override BOOLEAN NOT NULL DEFAULT false` column on
   `kgiu_entries.canonical_grammar_id`'s pair (or a per-row sentinel),
   and gate the backfill `WHERE NOT manual_override`. More explicit, more
   schema surface.
3. Make the backfill `WHERE canonical_grammar_id IS NULL` only — first
   write wins, subsequent passes never overwrite. Cleanest semantically,
   but loses the "re-link after a `ON DELETE SET NULL` event" recovery
   the SECURITY doc claims (vector D). Probably need a flag to opt into
   re-link mode.

Option 1 is the smallest delta; the convention is already documented.

### SHOULD-FIX-2 — Polysemy detection misses the "ordinal vs no-ordinal" case

`cluster_canonical_grammar.py:_build_clusters`:
```python
ordinals = {_extract_ordinal(m.pattern_raw) for m in members} - {None}
needs_review = len(ordinals) >= 2
```
This flags when ≥2 distinct ordinals appear (`①` and `②` etc.), but a
common Darakwon case is "one row marked `①`, another row unmarked
(implicit ①)" — same surface, polysemy is real, but `ordinals = {'①'}`
and `needs_review = False`.

Recommend: `needs_review = len(ordinals) >= 2 or (len(ordinals) >= 1 and
len(members) > len(ordinals))`. Or simpler: any ordinal present + any
member without an ordinal ⇒ review.

Test gap: the existing unit/integration tests don't cover this case. The
fix needs a paired test.

### SHOULD-FIX-3 — Round-trip migration test missing for 006

`test_canonical_grammar_db.py` calls `migrate up` and exercises 006, but
no test exercises `migrate down` for 006 specifically. The bar §1.Migrations
calls for "both directions tested". The test infra already exists (it
runs the runner), so this is one fixture + assert that
`canonical_grammar` does not exist after `migrate down` and
`kgiu_entries.canonical_grammar_id` is gone.

I want one explicit test that catches the case where a future migration
adds a CASCADE-dependent object that 006's `down.sql` doesn't know about.
The `DROP TABLE canonical_grammar CASCADE` would silently nuke it.

---

### NITs

**NIT-1 — `_ORDINAL_RE_LOCAL` inconsistent with `_CIRCLED_DIGITS_RE`.**
The normalizer strips circled digits up to `⑳`, the higher range `㉑-㉟㊱-㊿`,
but the polysemy detector only matches `[①-⑳]`. If Darakwon ever printed
`㉑`, the normalizer strips it (good) but `_extract_ordinal` returns
`None` (no review flag). Make the two regexes share the same character
class, or document why they diverge.

**NIT-2 — `_LEADING_N_PLACEHOLDER_RE` character class typo in comment vs code.**
Code: `r"^\s*N\s*(?=[(가-힣])"` (uses 힣, U+D7A3 — correct end of
Hangul Syllables block). Comment one line above: "U+AC00 (가) .. U+D7A3
(힣)". Earlier in the file (line 75-76) the comment says "U+AC00 (가) ..
U+D7A3 (힣)" but the comment line just above the regex uses 힯 (U+D7AF —
a Hangul Jamo Extended-B character that's not actually a syllable). The
regex code is correct; the doc-comment is misleading. Fix the comment.

**NIT-3 — Implicit unique-constraint index has no `COMMENT`.**
Bar §1.Indexing: "Every index has a query that justifies it, named in a
`COMMENT ON INDEX`." `uq_canonical_grammar_pattern_key` is the dedup
lookup's primary access path. Add a `COMMENT ON CONSTRAINT` or on the
implicit index. Minor — the convention usually exempts uniqueness-derived
indexes, but the bar is strict.

**NIT-4 — Down migration's `DROP INDEX` before `DROP TABLE CASCADE` is
redundant.** `DROP TABLE … CASCADE` drops dependent indexes automatically.
The explicit `DROP INDEX IF EXISTS ix_canonical_grammar_semantic_family`
line at 006_canonical_grammar.down.sql:38 is harmless but dead.

**NIT-5 — `_extract_ordinal` re-imports re via `__import__`.**
`cluster_canonical_grammar.py:283`:
```python
_ORDINAL_RE_LOCAL = __import__("re").compile(r"[①-⑳]")
```
The module already imports nothing-from-re because it doesn't use re
itself — but `__import__("re")` here is an odd dodge. Either `import re`
at the module top and use `re.compile`, or compile inline. The current
form trips linters that don't whitelist `__import__`.

**NIT-6 — `pick_canonical_surface` ordering with `score()` is over-clever.**
The lambda passed to `max` uses `(score(s)[0], score(s)[1], len(s),
-ord_sum(s))` and calls `score(s)` three times — once per index. Each
call recomputes both regex matches. ~300 clusters max, so perf is fine;
the issue is readability. Either inline:
```python
def key(s):
    has_placeholder = bool(_LEADING_PLACEHOLDER_RE.match(s))
    has_dash = bool(_LEADING_DASH_RE.match(s))
    return (int(has_placeholder), int(has_dash), len(s), -ord_sum(s))
return max(aliases, key=key)
```
or unpack `score(s)` once. Same behaviour, half the regex calls, easier
to read.

---

### PRAISE

**P1.** ADR-021's A/B/C table is exactly what a senior engineer wants to
see — option B (link + aggregated description) is the seductive wrong
answer; the rejection ("duplicate state, who edits it?") is the right
question.

**P2.** Splitting `build` from `apply`, with the cluster JSON as a
reviewable artefact, is a senior-bar move. It separates the heuristic
classification step from the durable write — a reviewer can audit
clusters and `semantic_family` votes before any DB row lands. This is the
right shape for a heuristic stage.

**P3.** The `_upsert_clusters` SQL is exemplary. The `IS DISTINCT FROM`
guard inside `ON CONFLICT DO UPDATE … WHERE …` is the right Postgres
idiom for idempotence, and the deliberate exclusion of `semantic_family`
from the UPDATE SET clause correctly preserves the human-override
contract documented in the ADR. (Verified by inspection at
`cluster_canonical_grammar.py:393-407`.)

**P4.** SECURITY.md identifies ReDoS, not just SQLi — most reviewers
forget the regex surface. The defenses ("anchored to `^`, no nested
quantifiers, no back-references") are the right things to check, and the
regexes in the module hold up against that claim.

**P5.** The integration test against testcontainers Postgres (not
SQLite) honours the bar's hard rule ("SQLite is not Postgres"). The
fixture also drops/recreates `public` schema per test — clean isolation
without per-test container spinup. Good infrastructure.

---

## Coordination observations

- **Phase D bridge to `grammar_entries` (user-canonical) is deferred
  explicitly in ADR-021.** That's the correct posture; trying to build
  the bridge before the highlight-recognition pipeline exists would be
  premature. The shape sketched in ADR-008 ("Phase C will add a bridge
  from grammar_entries → kgiu_entries") matches ADR-021's
  `grammar_entry_canonical (grammar_entry_id, canonical_grammar_id)`
  junction proposal. Consistent.

- **`canonical_grammar.semantic_family` overlaps with
  `kgiu_entries.category`.** Two fields, two write paths. The intent —
  category is per-source-row (Darakwon's chapter framing), family is the
  coarse cross-corpus tag for the Reference facet — is defensible, and
  ADR-021 documents it. Worth a single sentence in CANONICAL_GRAMMAR_README
  about how the Reference UI chooses which to surface.

- **`kgiu_entries.register` is TEXT not enum** (per the column comment in
  002_darakwon_corpora.up.sql:334 — "Phase-C canonicalization will
  normalize"). C1 does not touch register canonicalization. Worth
  acknowledging in ADR-021's "What this ADR does NOT decide" section —
  currently it lists vocab dedup, cross-refs, TOPIK linkage, and the
  user-canonical bridge, but not register normalization. Add it so future
  agents don't fold register work into the wrong ADR.

- **The polysemy disambiguator convention** (`(으)니까#discovery`) is
  documented only in CANONICAL_GRAMMAR_README and ADR-021's "Polysemy"
  section. There is no DB constraint enforcing the convention — a
  reviewer could just as easily insert `(으)니까-discovery` or
  `(으)니까_discovery`. SHOULD-FIX-1's fix could lean on this convention,
  in which case the convention needs to become a CHECK constraint or
  similar. Coordination point with C2 (cross-ref) and any future agent
  that touches `canonical_grammar.pattern_key`.

- **`needs_review` admin surface** — ADR-021 says "the Reference UI
  surfaces the `needs_review` flag in the admin pane (not the learner
  UI)". That's a coordination requirement for the front-end agent. Worth
  a cross-link in DESIGN_SPEC or whatever the front-end spec is.

---

## Files reviewed

- `Repository/db/migrations/006_canonical_grammar.up.sql`
- `Repository/db/migrations/006_canonical_grammar.down.sql`
- `Repository/db/docs/ADR-021-canonical-grammar-bank.md`
- `Repository/tools/ingest/canonical_grammar.py`
- `Repository/tools/ingest/cluster_canonical_grammar.py`
- `Repository/tools/ingest/tests/test_canonical_grammar_normalizer.py`
- `Repository/tools/ingest/tests/test_canonical_grammar_db.py`
- `Repository/tools/ingest/CANONICAL_GRAMMAR_README.md`
- `Repository/tools/ingest/CANONICAL_GRAMMAR_SECURITY.md`
- Cross-referenced: SENIOR_ENGINEER_BAR.md, ADR-001, ADR-008, ADR-013,
  `Repository/db/migrations/002_darakwon_corpora.up.sql` (for
  `kgiu_entries` shape verification)
