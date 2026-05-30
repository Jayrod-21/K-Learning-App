# Review: C2 — Cross-reference enrichment

**Reviewer:** independent senior (30y), did not author.
**Scope:** migration 009, resolver package, CLI, tests, ADR-022.
**Date:** 2026-05-28.

---

## Summary verdict

**Conditional accept.** The architecture is sound and aligns with ADR-007's
hybrid-target pattern. SQL schema, idempotency strategy, lookup precedence,
and resume machinery are all correct in design. The migration is well-
coordinated with C1/C4.

But there is a **counter accounting bug** in `pipeline._flush_batch` that
double-counts `text_only` refs in `refs_extracted` and `refs_broken`,
inflating both. That bug also means the integration test
`test_resolver_resume_picks_up_where_it_stopped` will fail on any fixture
that produces a `text_only` outcome — and the first integration test
confirms u03-99 does exactly that. The resolver is *correct in what it
writes*; the bug is purely in reported metrics and the resume assertion.
That makes it test-blocking, not data-corrupting.

Two smaller items (CSV filename is misleading; one missing CHECK on the new
`target_page`) are nits, not blockers. Fix the counter bug and the review is
a clean accept.

---

## Bar checklist

| Item | Result |
| --- | --- |
| BIGINT IDENTITY PKs | PASS (resolver_state) |
| TIMESTAMPTZ + audit cols + trigger | PASS |
| TEXT not VARCHAR | PASS |
| FK ON DELETE explicit | PASS (CASCADE source, SET NULL target — matches ADR-007) |
| CHECK constraints for closed sets | PASS (status, resolution_status, relation_kind) |
| COMMENT on tables/columns/indexes | PASS — thorough |
| Reversible migration | PASS, with documented loud-fail on text-only rows (correct posture) |
| No top-level BEGIN/COMMIT (ADR-013) | PASS |
| Idempotent re-run (zero version bumps) | PASS — `IS DISTINCT FROM` guard verified |
| Pydantic models at I/O boundary | PASS |
| Parameterized queries always | PASS |
| Structured logging | PASS (structlog) |
| Domain exception types | PASS (`ResolverPrerequisiteError`) |
| Integration tests against real Postgres | PASS (testcontainers) |
| No SQLite stand-in | PASS |
| Resume + dry-run + idempotency tests | PASS (modulo the counter bug) |
| ADR written | PASS (ADR-022, well-argued) |
| README | PASS (`CROSS_REF_README.md`) |

---

## Findings

### F1 (BLOCKING) — `text_only` refs double-counted in `refs_extracted` / `refs_broken`

`pipeline._process_entry` writes a `BrokenRefRow` *and* a `RelationRow` for
the same `text_only` outcome (lines 217–242):

```python
if outcome.status == "text_only":
    broken.append(BrokenRefRow(...))     # ← also appended

rows.append(RelationRow(...))            # ← falls through unconditionally
```

Then `_flush_batch` computes:

```python
extracted = len(rows) + len(broken)
broken_count = sum(1 for b in broken)    # == len(broken)
```

`len(rows)` already counts `text_only` rows; `len(broken)` counts them
again. Consequences:

- `resolver_state.refs_extracted` is inflated by one per text-only ref.
- `resolver_state.refs_broken` includes text-only entries, double-billing
  what `refs_text_only` already tracks. The counter contract advertised in
  ADR-022 D2 (resolved | text_only | broken) is violated.
- `test_resolver_resume_picks_up_where_it_stopped` asserts
  `refs_extracted == 3`. From the first test, `u03-99` is text-only.
  Assuming the three post-cursor entries each produce one ref, real
  extracted is 4 (3 row appends + 1 broken append from u03-99). The test
  must be failing as written, or it's running against a fixture whose
  u03-99 isn't text-only despite what the first test asserts.

**Fix options**, in increasing order of refactor cost:

1. Stop double-billing: drop the `broken.append` for `text_only` in
   `_process_entry`, and emit a separate `text_only_report` list for the
   CSV. Counters then need a new `text_only_report` field but reporting
   stays accurate.
2. Compute counts from the typed outcomes directly: track `n_resolved`,
   `n_text_only`, `n_broken`, `n_unsupported`, `n_self_loop` in
   `_process_entry`'s return, and have `_flush_batch` use those instead of
   `len(rows)`/`len(broken)`. This is cleaner and makes the test honest.

Either fix also requires updating the resume test's expected count.

### F2 (NIT) — broken-ref CSV name is misleading

The CSV at `tools/ingest/broken_cross_references.csv` actually contains:
unsupported relation_kinds, self-references, text-only successes, *and*
true broken refs. The header field is `reason`, which captures intent — but
the filename and the CLI flag `--report-broken-refs` both promise "broken"
only. Two reasonable fixes:

- Rename to `unresolved_cross_references.csv` (covers text-only + broken)
  with a `report_type` column, or
- Split into two CSVs (broken vs text-only) and let QA query
  `WHERE resolution_status = 'broken'` for the dev-cycle harness.

The ADR-022 D2 wording ("broken rows NOT written to DB, only CSV report")
implies a strict broken-only CSV. The implementation is broader and that's
the safer behavior — just update the naming/doc to match.

### F3 (NIT) — `kgiu_entry_relations.target_page` lacks a nonneg CHECK

`vocab_entry_relations` has `ck_vocab_entry_relations_page_nonneg`.
Migration 009 adds `target_page INTEGER` to `kgiu_entry_relations` without
the symmetric `CHECK (target_page IS NULL OR target_page >= 0)`. Cheap to
add; matches the bar's "consistency with sibling table" expectation.

### F4 (NIT) — `_check_corpora_loaded` and request-vs-loaded mismatch

`run_all` rejects when ANY requested corpus is missing from the loaded set.
That's the right posture. But the error message tells the user to run the
loader; it doesn't say which corpora ARE loaded, which is more useful when
the user got a corpus name slightly wrong. Add the loaded set to the error:

```python
raise ResolverPrerequisiteError(
    f"missing={missing}; loaded={sorted(loaded)}; ..."
)
```

### F5 (NIT) — `LookupIndex.from_db` builds across all corpora unconditionally

ADR-022 D8 calls this out: the index is built once before the corpus loop
because the resolver only writes relations, never entries — so the index
is stable for the duration of the run. Correct. But this means a kgiu/vocab
entry loaded mid-run (e.g., parallel loader writing while resolver runs)
won't be picked up. The `_check_corpora_loaded` preflight + the
single-writer environment mitigate this. Recommend a one-line warning in
the ADR's "Open questions" — "do not run resolver concurrently with the
loader against the same corpus" — to keep future-you out of trouble.

### F6 (NIT) — extraction skips logged but not counted

`_safe_str` returns None on empty; `_as_list` silently coerces. When the
source JSON has a malformed `compare_with` item, the extractor silently
skips it. Per the module docstring this is intentional ("liberal in what
they accept"). But the pipeline never counts skips, so the
"extraction layer's silence about malformed source data can't hide bugs"
claim in the extractor docstring is not actually backed by code. Add a
`malformed_skips` counter to ResolverCounters, increment from the
extractors via a callback (or return a tuple). Cheap, real value, satisfies
the bar's observability rule.

---

## Detailed observations

### Migration 009 SQL

**Coordination — sound.** Taking 009 to leave headroom past C1's 006 and
C4's 008 is the right call; the header comment explains the rationale
clearly. Reserving 007 as "skipped on purpose" rather than backfilling it
is unusual but defensible — better to leave a gap than risk a real
collision.

**Hybrid target on kgiu — consistent.** The schema mirrors ADR-007's vocab
pattern, with the welcome addition of `target_source_id` (KGIU `compare_with`
notes routinely contain parseable IDs; the vocab corpus rarely does). The
CHECK `target_entry_id IS NOT NULL OR target_korean IS NOT NULL OR
target_source_id IS NOT NULL` correctly allows the "id known, row not
loaded yet" case that enables lazy re-resolve. Good.

**Two partial UNIQUE indexes — work correctly.** The ON CONFLICT inference
in `writer.py` matches the partial-index predicate exactly:

- FK branch: `ON CONFLICT (source_entry_id, relation_kind, target_entry_id)
  WHERE target_entry_id IS NOT NULL` vs index
  `(source_entry_id, relation_kind, target_entry_id) WHERE target_entry_id
  IS NOT NULL`. Inference succeeds.
- Text branch: `ON CONFLICT (source_entry_id, relation_kind,
  (lower(target_korean))) WHERE target_entry_id IS NULL AND target_korean
  IS NOT NULL` vs index `(source_entry_id, relation_kind, lower(target_korean))
  WHERE target_entry_id IS NULL AND target_korean IS NOT NULL`. Inference
  succeeds — Postgres normalizes parens around expression columns.

Both predicates match exactly (whitespace and the redundant `()` around
`lower(...)` don't matter for inference). Confirmed against the same
pattern used successfully in A2's `ix_vocab_entry_relations_target_korean_lower`.

**Down migration — correct failure mode.** Restoring NOT NULL on
`target_entry_id` will fail if text-only rows exist; the header comment
acknowledges this explicitly and recommends DELETE-first. That's the right
posture for a destructive revert. ADR-013 (no top-level transaction)
respected.

**FK policy switch — correct per ADR-007.** Source side moves from RESTRICT
to CASCADE (relation belongs to source), target from RESTRICT to SET NULL
(preserve text label). Matches the vocab side's policy.

**relation_kind CHECK extension — appropriate.** Keeps the legacy A2 values
(`parallel_lower_level`, etc.) for backwards compat and adds the
text-source kinds the resolver actually emits. Good. The KGIU_RELATION_KINDS
set in `models.py` exactly matches the new allowed values; A2's legacy
values aren't in the resolver's set, which is fine because the resolver
doesn't emit them.

**Backfill UPDATE — good defensive move.** Setting `source_corpus` on
existing rows after the column add means the partial broken-refs index is
useful immediately rather than only on next write. Note: this UPDATE is
not idempotent in the strict sense (subsequent runs of 009 — though no
sane workflow re-runs an already-applied migration — would still be no-ops
because of `IS NULL` guard). Fine.

### Resolver package

**Pipeline structure — clean.** Single responsibility per module
(extract / normalize / lookup / write / orchestrate). DI via `ResolverConfig`.
Each module's docstring explains WHY. Good shape, well within bar.

**Same-corpus preference + priority — justified.** ADR-022 D3's beginner-
wins rationale is pedagogically sound (foundational definition first) and
the deterministic priority means re-runs against the same DB produce
identical FK choices. The open question about per-user re-weighting is
correctly deferred. The `_CORPUS_PRIORITY` map could omit `kgiu_advanced=2`
since `dict.get(_, 99)` would handle it, but explicit is fine.

**Multi-target first-match — defensible.** ADR-022 D4's rejection of
"write N rows" is well-argued. The natural-key UNIQUE on `target_korean`
means N rows would each have a distinct key — they wouldn't deduplicate on
re-run unless the resolver remembered the split, which is exactly the
complexity D4 avoids. The cost (lose N-1 sibling targets) is acceptable
because the original text is preserved in `target_korean` and the UI can
render it.

**Direct source-id short-circuit — correct.** When `parsed_target_source_id`
is set, `resolve()` bypasses the Korean-text path entirely. If the ID
isn't loaded, it returns text-only WITH `target_source_id` set, enabling
lazy re-resolve. The behavior when `target is None` and the parsed ID
isn't loaded (lines 243–254) is correct — text-only with the parsed ID
surfaced, no canonical-form lookup attempted (there isn't one to attempt).

**Normalization — sound.** NFC + whitespace + homograph strip + multi-
target split, in that order. The `_TRAILING_PAREN_GLOSS_RE` heuristic
(60% Latin ratio) is conservative — false negatives over false positives,
which is the right trade-off for a dictionary corpus. The
`_HOMOGRAPH_INLINE_CIRCLED_RE` handling of `"N에 ② (time)"` → `"N에"` is
a nice touch.

**Idempotency — verified.** The `IS DISTINCT FROM` guard on every updatable
field, combined with `RETURNING (xmax = 0)`, gives the resolver an exact
"changed vs unchanged" signal. `test_resolver_is_idempotent` asserts
`versions_after == versions_before` — that's the right test, and it should
pass.

**Resume — works in spirit.** The per-corpus `last_source_id` cursor, the
sorted iteration, and the `source_id <= last_source_id` skip are all
consistent. The cross-corpus index-staleness concern in ADR-022 D8 is
correctly mitigated by the resolver's read-only-on-entries posture.

**Counter accuracy — see F1.** Otherwise the counter shape (per-corpus
`ResolverCounters` model) is well-designed.

### CLI

Clean argparse, distinct exit codes (per the bar's "errors typed too"),
DATABASE_URL via env (12-factor), logging configured by the shared
`loaders.runtime.configure_logging`. The KeyboardInterrupt handler
returning 130 is the Unix-conventional thing. Good.

One nit: `args.corpus == ["all"]` is checked but `["all", "kgiu_beginner"]`
silently degrades — only the explicit `"all"` is removed and the rest
proceed. That's fine but worth a one-line comment so a future reader
doesn't assume `all + others` is the union.

### Tests

The split between unit (normalize, lookup) and integration (full pipeline +
testcontainers) is right. Unit tests are thorough on edge cases (NFD,
CJK ideographic space, NBSP, homograph variants, multi-target separators,
case-insensitive ID matching, etc.).

Integration coverage of FK, text-only, resume, dry-run, and prerequisite
error is complete. The fixture corpora exercising the cross-corpus path
(kgiu source → vocab target) is good. Module-scoped pg_container is
appropriate — testcontainers startup is expensive enough to share.

**Concern:** `test_resolver_resume_picks_up_where_it_stopped` asserts
`refs_extracted == 3`. If u03-99 is text-only (as the first test confirms),
the bug in F1 would make this count 4. Either the test is unrun, or my
read of `_flush_batch` is wrong — but I've traced it twice and it adds up
to 4. Running the test suite end-to-end would confirm. Fixing F1 also
requires updating this assertion.

**Missing:** no test for the "source_id IS DISTINCT FROM" guard at the
SQL level — i.e., a row that's resolved → text_only → resolved again
upgrades the FK correctly. The first run of the suite tests resolved and
text-only separately but not the upgrade transition. Add one short test:

1. Load a fixture where target is absent.
2. Run resolver → row is text_only.
3. Load the missing target.
4. Re-run → assert the same row's `target_entry_id` is now non-null and
   `resolution_status = 'resolved'`.

This is the headline future-use case of `target_source_id` and `text_only`,
and it should be exercised.

### Coordination with C1 / C4

- Migration number: 009 is past 006 (C1) and 008 (C4). No file collision.
  The 007-gap rationale is sound (avoid stepping on any C4 reshuffle).
- No table-name collision: `resolver_state` is independent from B3's
  `load_state` (migration 005). Two checkpoint tables for two stages, per
  ADR-022 D8 — correct separation.
- No corpus-enum changes: 009 adds rows that use the existing `corpus`
  type. If C1 or C4 added enum values, those wouldn't break 009. If they
  *renamed* a value, 009 would fail — but no such rename is in 006 or 008.
- ADR-007 pattern reused exactly: the kgiu hybrid columns, CHECK shape, and
  FK policy mirror what A2 did for vocab. The only addition
  (`target_source_id`) is justified by the KGIU-specific note convention.
- A2's downstream contract intact: existing `vocab_entry_relations` rows
  loaded by B3 keep working. The new columns on vocab side
  (`target_source_id`, `source_corpus`, `resolution_status`) all have
  defaults that match the old behavior.

No cross-PR landmines visible.

---

## Action items (recommended order)

1. **Fix F1.** Stop double-counting `text_only`. Either separate the
   broken/text-only reporting lists or compute counts from typed outcomes.
2. **Update the resume test's expected count** after the F1 fix; add the
   text-only-upgrade test described under "Tests".
3. F3 (one-line CHECK), F4 (better error message), F5 (one-line ADR note)
   and F2 (rename or split CSV) are good follow-ups but not blockers.
4. F6 (count malformed-extractor skips) — bar-aligned hygiene; do when
   touching the extractor next.

---

## File paths

- `Repository/db/migrations/009_cross_ref_relations.up.sql`
- `Repository/db/migrations/009_cross_ref_relations.down.sql`
- `Repository/db/docs/ADR-022-cross-reference-resolution.md`
- `Repository/tools/ingest/resolver/{pipeline,lookup,writer,normalize,models,extractor}.py`
- `Repository/tools/ingest/resolve_cross_references.py`
- `Repository/tools/ingest/CROSS_REF_README.md`
- `Repository/tools/ingest/tests/test_resolve_{normalize,lookup,cross_references_integration}.py`
