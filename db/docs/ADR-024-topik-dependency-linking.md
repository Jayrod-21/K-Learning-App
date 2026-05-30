# ADR-024 — TOPIK ↔ corpus dependency linking: mechanical-first, confidence-weighted

**Status:** Accepted
**Date:** 2026-05-28
**Implemented in:**
- `Repository/db/migrations/008_topik_dependencies.{up,down}.sql`
- `Repository/tools/ingest/link_topik_dependencies.py`
- `Repository/tools/ingest/tests/test_link_topik_dependencies.py`

**Relates to:**
- ADR-001 §D2/D3/D5/D6/D8/D9/D10 (foundational data choices)
- ADR-005 (stable cols vs JSONB — `evidence` is JSONB here)
- ADR-013 (migration runner owns transactions)
- ADR-014 (Kiwi service — Strategy B's HTTP dependency)
- ADR-020 (Claude proxy — Strategy C's HTTP dependency)
- DESIGN_SPEC §"Pages" — TOPIK Prep study mode, weak-area filter, gap-map

---

## 1. Context

The TOPIK item pool (one row per question in `topik_items`, see migration
005) is tagged with a coarse `skill_tag` (33-tag controlled vocab from
`normalize_skill_tags.py`). Coarse tagging is enough to bucket items by
section + skill (`grammar-connective`, `reading-main-idea`, etc.) but it's
**not** enough to power three product features the spec demands:

1. **"Filter mock test to items testing the `-(으)면` family"** — needs
   the finer link: this item tests **that specific grammar entry**.
2. **"Show me weak areas"** — the gap-map dashboard counts unmastered
   grammar/vocab entries that have linked TOPIK items.
3. **SRS interleaving** — when the user reviews a grammar entry, surface
   a TOPIK item exercising it.

All three want the same edge: **`topik_items ↔ kgiu_entries` and
`topik_items ↔ vocab_entries`**. This ADR is about how that edge is
represented and how it gets populated.

---

## 2. Decision

### D1. Single junction table `topik_dependencies` (polymorphic via discriminator + XOR)

One table with a `dep_type` enum discriminator and a CHECK-enforced XOR
between `grammar_entry_id` and `vocab_entry_id`.

Alternatives considered:

| Option | Pros | Cons |
|---|---|---|
| **One junction with discriminator** (chosen) | Single index strategy; forward and reverse queries each hit one table; cheap to add a third target table later (just extend the enum + add an XOR clause) | The "two FK columns, exactly one non-NULL" shape is slightly less obvious than two tables |
| Two separate junctions (`topik_grammar_deps`, `topik_vocab_deps`) | Each row strictly typed; no XOR check needed | Forward query "what does this item test?" becomes a UNION; reverse-query indexes have to be defined twice; adding the inevitable third target (audio? canonical-grammar?) means a third table |
| JSONB column on `topik_items` | Simple | Loses FK integrity, loses reverse-query index reach, loses the audit columns per dep row |

The chosen shape preserves FK integrity (kgiu_entries / vocab_entries can't
be deleted while linked; ADR-001 §D9 `RESTRICT`), is cheap to extend, and
matches the query patterns we actually have. The XOR is an explicit CHECK
constraint plus a redundant `(grammar_entry_id IS NOT NULL)::int +
(vocab_entry_id IS NOT NULL)::int = 1` guard — belt and suspenders.

### D2. Targets are the corpus reference tables, not `grammar_entries`

The choice was: link to **`kgiu_entries`** (corpus reference, migration 002)
or to **`grammar_entries`** (the per-user banked-grammar table, migration
001).

We target `kgiu_entries` (and `vocab_entries`) because:

- TOPIK items are corpus content; they test patterns regardless of which
  user banks them. A dep should be a property of the corpus, not the user.
- `grammar_entries` is per-user — a dep against it would force a per-user
  link table that exists only when a user has banked a pattern. The product
  wants the dep to exist whether or not the user has banked it (that's how
  "what should I bank next?" prompts work).
- Phase C-1 is adding a `canonical_grammar` table (migration 006) above
  `kgiu_entries`. When that lands, we can either (a) extend
  `dep_type` to include `'canonical_grammar'` and add a third FK, or
  (b) migrate existing grammar rows to point at `canonical_grammar.id`.
  Both are routine migrations; today's choice doesn't paint us into a
  corner.

### D3. Confidence as `NUMERIC(3, 2)`, not float

Per ADR-001 §"Types": exact decimals are NUMERIC. Confidence is compared
with `>` in the `ON CONFLICT DO UPDATE` precedence rule; a float would risk
0.90 != 0.90 surprises on round-trip. Range [0.00, 1.00] enforced by a
CHECK.

### D4. Source taxonomy is open TEXT with CHECK, not enum

Following ADR-001 §D8's pattern for "domain-extensible categories"
(grammar_entries.category, vocab_entries.part_of_speech). New linker
strategies should be a one-line CHECK update, not an `ALTER TYPE ADD
VALUE`.

Today's known values: `skill_tag`, `lemma_match`, `claude_analysis`,
`manual` (the last for any human-curated overrides we might paste in
later).

### D5. `evidence` JSONB for provenance, scalars as columns

Per ADR-005 (stable cols vs JSONB): stable scalars (`topik_item_id`,
`confidence`, `source`) are columns. Variable-shape provenance (the
original skill_tag, the matched lemma, the Claude reasoning excerpt) is
JSONB. CHECK enforces object shape.

This lets us answer "why was this dep created?" forensically without ever
making `evidence` part of the natural key.

---

## 3. Strategy choices (mechanical-first)

### Why mechanical strategies before Claude

1. **Cost.** A full corpus run through `/grammar/identify` is multiple
   dollars. The mechanical strategies are free.
2. **Determinism.** Mechanical strategies make the same call every time;
   Claude doesn't. Re-runs of A+B produce identical dep sets; Claude's
   confidence and pattern strings drift slightly across runs, which is
   exactly the kind of churn we want to keep out of "is this dep stable?".
3. **Auditability.** A linker reviewer can read `SKILL_TAG_TO_GRAMMAR_CATEGORY`
   and tell what the linker thinks "grammar-connective" means. Claude is
   a black box at that layer.
4. **Coverage.** Strategy A maps a tag to multiple categories, producing
   ~5 grammar candidates per tagged item. Strategy B then catches the
   vocab side. Across the corpus that's already plurality coverage.

Strategy C is therefore **default off** — operator opt-in via `--use-claude`.

### Strategy A: skill_tag → category

The mapping is a Python dict, not a DB-side rule, because:

- It's data-pipeline knowledge, not a referenceable corpus fact.
- It changes in lockstep with the linker code, not with the schema. A
  schema migration to add a new tag mapping is overkill.
- It's covered by a unit test that fails loudly if anyone deletes a known tag.

### Strategy B: lemma match (Kiwi → vocab_entries.korean)

We use Kiwi (`/tokens`, ADR-014) to lemmatize stem + options, keep only
content-word POS tags, then look up `vocab_entries.korean = lemma`.

Excluded POS tags: particles (JK*), endings (E*), punctuation (S*). Those
aren't dictionary entries; including them produces false hits when the
particle surface form happens to collide with a real word.

Confidence 0.75 reflects "this word appears in the item" — it might or
might not be the word the item *tests*; that distinction is the source of
the lower-than-A confidence. The product treats vocab deps as soft hints;
the UI can additionally filter by 0.75+ if it wants the high-quality cut.

### Strategy C: Claude proxy (B4) — opt-in only

Sends each item's `stem` + each option (or the `underline` span if present)
to the existing `POST /grammar/identify` route on B3, which forwards to
the B4 proxy. The proxy is the abstraction boundary; **we never import
@anthropic-ai/sdk**.

We accept Claude's confidence as-is (clamped to [0, 1]). If Claude's
confidence drops below 0.50 we still write the row — the product layer
filters on the confidence index, and ingesting low-confidence rows is the
cost of having "show me speculative deps the user might review" available.

Strategy C is invoked **only for items uncovered by A+B** by default. That
keeps the cost envelope at ~$3 per full corpus run instead of ~$15.

---

## 4. Precedence: highest-confidence wins, baked into SQL

The natural key for idempotency is
`(topik_item_id, dep_type, COALESCE(grammar_entry_id, 0), COALESCE(vocab_entry_id, 0))`.
The XOR check guarantees exactly one of the two FK columns is non-NULL, so
the COALESCE-to-0 trick yields a stable unique tuple without Postgres'
"NULLs are distinct in UNIQUE" gotcha.

The `ON CONFLICT DO UPDATE` clause:

```sql
ON CONFLICT (topik_item_id, dep_type,
             COALESCE(grammar_entry_id, 0),
             COALESCE(vocab_entry_id, 0)) DO UPDATE
   SET confidence = GREATEST(topik_dependencies.confidence, EXCLUDED.confidence),
       source     = CASE WHEN EXCLUDED.confidence > topik_dependencies.confidence
                          THEN EXCLUDED.source ELSE topik_dependencies.source END,
       evidence   = CASE WHEN EXCLUDED.confidence > topik_dependencies.confidence
                          THEN EXCLUDED.evidence ELSE topik_dependencies.evidence END,
       version    = topik_dependencies.version + 1
   WHERE EXCLUDED.confidence > topik_dependencies.confidence
```

Two things to notice:

1. **The `WHERE` filters out equal-confidence ties** so we don't churn
   the row's `version` for a true no-op.
2. **`GREATEST` is redundant given the WHERE**, but it's there as defense
   against a future hand-edit to the WHERE clause flipping the
   monotonic-increase invariant.

This means the strategies can run in any order; the persisted row will
always carry the highest-confidence source.

---

## 5. Indexing strategy

Four indexes; each one tied to a query the product makes:

| Index | Query |
|---|---|
| `uq_topik_dependencies_natural_key` (UNIQUE) | Upsert idempotency |
| `ix_topik_dependencies_item (topik_item_id, dep_type)` | Forward — "what does item X test?" |
| `ix_topik_dependencies_grammar_target (grammar_entry_id, topik_item_id) WHERE dep_type='grammar'` | Reverse — "which items test grammar Y?" |
| `ix_topik_dependencies_vocab_target (vocab_entry_id, topik_item_id) WHERE dep_type='vocab'` | Reverse — "which items test vocab Z?" |
| `ix_topik_dependencies_confidence (confidence DESC, topik_item_id) WHERE confidence >= 0.75` | Filter — "give me high-confidence deps" |

Per SENIOR_ENGINEER_BAR §1 "No speculative indexes" — every index above
has a named query in the comment on the index.

---

## 6. Consequences

- The linker is now a required ingest step after every TOPIK loader run.
  Orchestration (ADR-019) needs to know about it; we'll surface it in the
  next pass.
- `kgiu_entries` and `vocab_entries` cannot be deleted while deps exist
  (ON DELETE RESTRICT). That's intentional — silently orphaning the dep
  row would lose the audit trail of which item used to be linked to what.
- Strategy A's coarse category match means a single item often produces
  3–5 grammar deps. UIs that say "this item tests X" must qualify "tests
  *one of these*". The data is honest; the UI copy needs to be.

---

## 7. Open questions

- **When does Strategy A get more specific?** Today it picks every kgiu
  entry in the matched categories. We could narrow to entries whose
  `pattern` substring appears in one of the item's options (a cheap
  mechanical match). Tracked as a follow-up; the current implementation
  is the simpler, more conservative starting point.
- **What about `canonical_grammar` (migration 006)?** When C-1 lands, we
  may add a third `dep_type` enum value and a third FK column. The XOR
  check generalizes (`(a IS NOT NULL)::int + (b IS NOT NULL)::int + (c
  IS NOT NULL)::int = 1`) and the natural-key COALESCE pattern keeps
  working. No data migration needed for existing rows.
- **Manual overrides.** `source='manual'` is in the CHECK constraint
  today but has no insertion tooling. When a content editor wants to fix
  a wrong dep, they currently `INSERT … ON CONFLICT DO UPDATE … SET
  confidence = 1.00, source = 'manual'`. That's intentional minimalism;
  if we get enough overrides, we'll add a CLI for it.
