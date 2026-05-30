# ADR-022: Cross-reference resolution policy

**Status:** Accepted
**Date:** 2026-05-28
**Implemented in:** `db/migrations/009_cross_ref_relations.up.sql`,
`tools/ingest/resolve_cross_references.py`,
`tools/ingest/resolver/`
**Relates to:** ADR-007 (hybrid-target on `vocab_entry_relations`),
ADR-001 §D9 (FK ON DELETE policies),
ADR-013 (migration tx ownership).

## Context

The Darakwon source JSONs (`grammar_kgiu_*.json`, `vocab_2000_*.json`)
encode word↔word and pattern↔pattern relations as text inside each entry:

- `related[]`, `synonyms[]`, `antonyms[]` — list of dicts with a Korean
  target and optional english/page.
- `compare_with[]` — list of `{with, note}` dicts. The note often
  contains a sentence-style "See kgiu-beg-u03-01." pointing at a sibling
  entry by source id.
- `cross_refs[]` — `{label, page}` Appendix pointers; sometimes the
  label carries a Korean form.
- Scalar form fields (`passive_form`, `causative_form`, `basic_form`,
  `honorific_form`, `humble_form`, `contracted_form`) — bare Korean
  strings that point at another headword's basic form.

A2 (migration 002) created `kgiu_entry_relations` and
`vocab_entry_relations` to hold the resolved FK links. The vocab side
already used ADR-007's hybrid-target pattern (`target_entry_id NULL` +
`target_korean TEXT NULL`). The KGIU side had `target_entry_id NOT NULL`
— forcing the loader to either drop unresolvable refs or invent stub rows.
This ADR fixes that asymmetry and specifies the resolver's behavior.

## Decisions

### D1. KGIU relations adopt the hybrid-target pattern.

`kgiu_entry_relations.target_entry_id` is now nullable; `target_korean`,
`target_english`, `target_page`, `target_source_id` are added. The CHECK
becomes `target_entry_id IS NOT NULL OR target_korean IS NOT NULL OR
target_source_id IS NOT NULL`. Rationale matches ADR-007 §"Decision" —
we don't want to drop signal or pollute the dictionary.

`target_source_id` is new (relative to vocab): KGIU notes commonly say
"See kgiu-beg-u03-01" and we want to surface that even when the target
isn't loaded yet, so a future re-resolve can upgrade.

### D2. Resolution status is recorded per row.

A `resolution_status` column on both relations tables takes one of:

- `resolved` — `target_entry_id` is set.
- `text_only` — `target_entry_id` IS NULL, `target_korean` IS NOT NULL.
  The reference is a real label whose target isn't in the DB yet.
- `broken` — the resolver could not even normalize a target form. Rows of
  this kind are NOT written to the relations table (they'd violate
  `ck_*_target_present`); they only appear in the broken-ref CSV.

The split lets the UI render "text-only" labels (page pointer, still
useful) while the dev-cycle harness queries `WHERE resolution_status =
'broken'` for QA.

### D3. Same-corpus preference + deterministic priority tiebreak.

When a normalized Korean target matches captured entries in multiple
corpora, the resolver picks the one whose corpus matches the source row's.
If none match, it falls back to a fixed priority order:

```
kgiu_beginner  < kgiu_intermediate  < kgiu_advanced
vocab_2000_beginner < vocab_2000_intermediate
```

Lower index = higher priority. The rationale: when an advanced grammar
references a form also defined at the beginner level, the foundational
definition is the one a learner should land on. The priority order is
fixed at code time (not data), so re-runs against the same DB produce
identical FK choices.

**Why not:**

- **Alphabetical by entry id**: stable but arbitrary; learner UX worse.
- **Highest-id (most recent extraction)**: incentivizes overwrites; bad
  for git diffs.
- **Refuse to resolve when ambiguous**: forces all multi-corpus headwords
  into `text_only`, dropping the signal of "yes, this matches *something*".

### D4. Multi-target refs split deterministically.

Source `related[]` items occasionally list multiple targets in one
Korean field — e.g. `"만족하다, 만족스럽다"`. The normalizer splits on
`,`, `;`, `/`, ` · `, ` 또는 `, and ` vs ` (case-insensitive). The lookup
takes the FIRST subtarget that resolves; if none resolve, the row is
written as `text_only` carrying the FIRST subtarget as `target_korean`.

This is asymmetric — only one of N subtargets gets an FK. The alternative
(write N rows) was rejected because:

- The UI cluster is "these are related" — N rows would duplicate the same
  semantic edge for the user.
- The natural-key UNIQUE is `(source, kind, target_korean)` and each
  subtarget would write under a different key; consequence: idempotency
  requires the resolver to remember each subtarget across re-runs.
  Single-row keeps the upsert math simple.

### D5. Normalization: NFC + collapse-whitespace + homograph index strip.

The normalizer applies, in order:

1. Unicode NFC (Korean syllables stored decomposed compare unequal to
   composed; Postgres `=` is byte-equal).
2. Whitespace collapse (multi-space / CJK-ideographic-space / NBSP /
   ZWSP all become single ASCII spaces; outer trim).
3. Homograph-index strip (trailing `(2)` / `②` / inline `② (gloss)`).
4. Trailing English-parenthetical strip (a heuristic — keeps Korean
   parentheticals like `(주격)` intact).
5. Multi-target split.

The original input is preserved in `target_korean` for storage; the
canonical form is used for FK lookup. The lookup index keys are
`lower(NFC(headword))` — Korean is case-insensitive in practice but the
lower() matches the partial-unique-index expression A2 created (and the
ones migration 009 adds for KGIU).

### D6. Direct source-id match short-circuits text resolution.

When a `compare_with[].note` contains a token like `kgiu-beg-u03-01`, the
resolver looks the id up directly. This bypasses the text-normalization
path entirely (the parsed id is the authoritative target).

If a note carries MULTIPLE entry ids ("See kgiu-beg-u01-01 and
kgiu-beg-u01-02") the first becomes the `compare_with` target; each
extra id produces a separate `cross_ref` row. Rationale: preserves the
multi-link signal without conflating it with the canonical
`compare_with` semantics.

### D7. Idempotency via natural-key partial UNIQUE.

Migration 009 adds two partial UNIQUE indexes per relations table:

- `uq_*_relations_fk`   — `(source, kind, target_entry_id) WHERE target_entry_id IS NOT NULL`
- `uq_*_relations_text` — `(source, kind, lower(target_korean)) WHERE target_entry_id IS NULL`

The resolver routes each row to the matching ON CONFLICT branch. The
`DO UPDATE` clause has an `IS DISTINCT FROM` guard on every field, so a
re-run with unchanged input bumps zero versions and writes zero rows.

A regular (non-partial) `UNIQUE (source, kind, target_korean)` was
rejected because text-only rows would conflict with FK-resolved rows that
happen to carry the same `target_korean`, blocking the upgrade path.

### D8. Resume cursor is per-corpus.

`resolver_state.last_source_id` records the last source_id processed
within a corpus. `--resume` reads it and skips entries with
`source_id <= last_source_id`. Without `--resume`, the cursor + counters
reset at the start of each corpus.

Cross-corpus dependency: the LookupIndex is built once at the top of
`run_all`, not per-corpus. If a fresh run of corpus B depends on data
loaded for corpus A *during the same run*, the index would be stale.
Mitigation: the resolver only reads from `*_entries`; it only WRITES to
`*_entry_relations`. The index is therefore stable across the entire
resolver run regardless of corpus order.

## Consequences

- The dictionary is never polluted with auto-created stub entries.
- The UI rendering query remains a single SELECT: `target_entry_id`
  OR `target_korean` is always present.
- The broken-ref CSV produces a deterministic snapshot per run, suitable
  for diff-based QA in the dev-cycle harness.
- The new `target_source_id` column on `kgiu_entry_relations` enables
  lazy re-resolve: when missing entries get loaded later, a re-run can
  upgrade text-only refs to FK refs without an extra schema change.
- Migration 009 is destructive on existing relation data if it contained
  rows where the now-relaxed constraints were the only thing preventing a
  malformed insert. The down migration `009_cross_ref_relations.down.sql`
  fails loudly if text-only rows exist — that's the right posture.

## Alternatives considered

- **Two separate relations tables (`*_fk`, `*_text`)** — rejected per
  ADR-007: a UNION ALL on every render is worse than one nullable column
  with a CHECK.
- **Pure FK + stub-row insert** — rejected; dictionary integrity issue.
- **Drop unresolvable refs** — rejected; loses learner-visible signal.
- **JSONB blob on each entry** — rejected; loses indexed reverse-lookup.
- **Per-row backoff between resolved/text_only without status column** —
  considered; rejected because querying broken refs without a column
  requires a complex WHERE that doesn't index cleanly.

## Open questions

- **Cross-corpus ambiguity priority list as data, not code.** Today the
  priority order lives in `resolver/lookup.py::_CORPUS_PRIORITY`. If we
  later let teachers re-weight ("for an advanced learner, link to the
  advanced gloss first"), the priority needs to be config or per-user.
  Deferred: the current order is the safe default.
- **Re-resolve trigger.** A future automation could run the resolver
  whenever a corpus checkpoint completes. Today it's manual. Deferred to
  the loader-orchestration ADR (ADR-019).
- **Do NOT run the resolver concurrently with the loader against the
  same corpus.** The lookup index is built once before the corpus loop
  (D8 above) — entries written by a parallel loader mid-run won't be
  picked up until the next resolver run. The single-writer environment
  and the `_check_corpora_loaded` preflight mitigate the practical
  risk; this is documented here so future-you doesn't decide to
  parallelize without re-reading D8. (REVIEW_C2 F5, 2026-05-28.)

## Test evidence

- `tools/ingest/tests/test_resolve_normalize.py` — NFC / homograph /
  multi-target normalization unit tests, plus the entry-id extractor.
- `tools/ingest/tests/test_resolve_lookup.py` — same-corpus preference,
  cross-corpus fallback, priority tiebreak, multi-target.
- `tools/ingest/tests/test_resolve_cross_references_integration.py` —
  full pipeline against a real Postgres testcontainer:
    - FK + text-only resolution
    - Idempotency (re-run yields zero new rows, zero version bumps)
    - Dry-run writes nothing
    - Resume continues from the cursor without re-processing
    - Prerequisite check raises `ResolverPrerequisiteError` against an
      empty schema
