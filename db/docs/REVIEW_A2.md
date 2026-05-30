# Review: A2 — Darakwon corpora schemas

**Reviewer:** Independent senior reviewer (did NOT write the code).
**Scope reviewed:** `002_darakwon_corpora.up.sql`, `002_darakwon_corpora.down.sql`,
`erd-darakwon.md`, `ADR-002-stable-cols-vs-jsonb.md`, `ADR-003-tsvector-language-config.md`,
`ADR-004-vocab-relations-hybrid-target.md`, `ADR-005-kgiu-vs-grammar-entries.md`,
A2's appended sections in `SECURITY.md` and `README.md`.
**Cross-checked against:** `SENIOR_ENGINEER_BAR.md`, `ADR-001-database-choices.md`,
`001_core_schema.up.sql` (A1), and the Darakwon source JSONs under
`Repository/tools/ingest/output/`.

---

## Summary verdict

**REQUEST CHANGES.** The schema is well-engineered, the ADRs are first-rate, and the
coordination with A1 is thoughtful. But two of the source JSONs contain a row `type` —
`"reference"` — that the schema's discriminator enums silently reject. As written,
**45 vocab "reference" rows + 5 KGIU "reference" rows will fail the loader's INSERT** the
first time A3/A4 runs against real data. That is a BLOCKER because Phase A's whole point is
ingest fidelity — "Does every field have a home?" The answer here is "no, ~50 rows have no
home and the loader will crash on them or silently drop them."

Aside from that and one related NULL-tolerance miss, the work is in solid shape. The
modeling decisions (stable-col-vs-JSONB, hybrid-target relations, kgiu-vs-grammar
disambiguation) are correctly justified in ADRs, the security threat model is concrete,
and the schema is comfortably above the senior-engineer bar for every other axis.

- **BLOCKERs:** 1
- **SHOULD-FIX:** 4
- **NITs:** 5
- **PRAISE:** 8

---

## Bar checklist (table)

| Bar item | Pass? | Notes |
|---|---|---|
| Surrogate `BIGINT IDENTITY` PK on every entity table | yes | Every table at `002.up.sql:143, 199, 394, 455, 637, 713, 793`. |
| Audit columns (`created_at`, `updated_at`, `version`) on every entity table | yes | All 7 tables. `version` defaults `1`, optimistic-concurrency contract honored. |
| `updated_at` trigger maintained, reusing `set_updated_at()` from A1 | yes | Reuses, never redefines. Triggers at `:188, :320, :434, :570, :685, :771, :856`. |
| Soft delete decision made deliberately | yes | Correctly absent — reference data; rationale documented in ADR-001 §D7 and in the migration header. |
| Every FK has explicit `ON DELETE` / `ON UPDATE` | yes | Every FK declaration includes both. |
| `NOT NULL` is the default | yes | Nullable columns are the explicit exception (audio_track, register, theme/subsection on intros, …). |
| `CHECK` constraints validate ranges + JSONB shape | mostly | Excellent JSONB array-shape CHECKs everywhere they should be. `target_page >= 0` is present. Missing: `length(source_sha256)` already covered by regex CHECK; `item_count >= 0` present. |
| ENUM types per ADR-001 §D8 | yes | Five new enums; reuses A1's four. All guarded by `DO $$ IF NOT EXISTS` blocks. |
| `TIMESTAMPTZ` not `TIMESTAMP` | yes | All audit columns. |
| `TEXT` not `VARCHAR` | yes | No `VARCHAR` anywhere. |
| `JSONB` not `JSON` | yes | No `JSON` anywhere. |
| `COMMENT ON TABLE/COLUMN/INDEX` everywhere | yes | Every table, every non-obvious column, every index — and every TYPE. Above the bar. |
| Indexes justified by named query in COMMENT | yes | All 16 indexes carry a comment naming the query. |
| GIN on tsvector + GIN on JSONB containment where useful | partial | `search_tsv` GIN ✓. No GIN on the JSONB blobs themselves, but ADR-002 explicitly defers that as YAGNI — acceptable. |
| Forward + reverse migrations, idempotent | mostly | Forward up = idempotent, reverse = clean. Seed UPSERT bumps `version` on every re-apply (see NIT-5). |
| Naming consistent (ADR-001 §D10) | yes | All `ix_*`, `uq_*`, `fk_*`, `ck_*` names follow the convention. |
| No business logic in DB (triggers only for mechanical maintenance) | yes | Two trigger functions, both pure tsvector refreshes. ADR-001 §D12 explicitly allows. |
| Modeling fidelity to source data | **NO — BLOCKER B-1** | `vocab_entry_type` / `kgiu_entry_type` enums omit the `"reference"` value present in 50 source rows. |
| Coordination with A1's deferred FK (`fk_vocab_cards_vocab_entry`) | yes | Added correctly at `:890-901`, dropped first in `down.sql:28-34`. |
| Naming-collision resolution with A1 (`grammar_entries` vs `kgiu_entries`) | yes | ADR-005 explains and the choice is sound. |
| ERD accurate and complete | mostly | Mermaid faithful to SQL, but omits ON DELETE/UPDATE annotations on the mermaid edges (in prose table only). Acceptable. |
| ADRs include alternatives considered + rejected | yes | All four ADRs do this explicitly. |
| SECURITY.md enumerates attack vectors + defenses | yes | 7 vectors covered with both DB-layer and loader-layer defenses. |

---

## Findings

### BLOCKER

#### B-1: `kgiu_entry_type` and `vocab_entry_type` are missing the `"reference"` value present in source JSON

**File:lines:** `002_darakwon_corpora.up.sql:98-103, 110-115`

The enums are declared as:

```sql
CREATE TYPE kgiu_entry_type AS ENUM ('grammar', 'intro');
CREATE TYPE vocab_entry_type AS ENUM ('word', 'theme_intro', 'subsection_intro');
```

But running

```bash
grep -oE '"type"\s*:\s*"[^"]+"' tools/ingest/output/grammar_kgiu_*.json | sort -u
grep -oE '"type"\s*:\s*"[^"]+"' tools/ingest/output/vocab_2000_*.json    | sort -u
```

shows the source JSONs also produce `"type": "reference"`:

- KGIU Beginner: 4 reference rows. KGIU Intermediate: 1. (Total 5.)
- Vocab Beginner: 23 reference rows. Vocab Intermediate: 22. (Total 45.)

A representative KGIU example (`grammar_kgiu_intermediate.json:13363-13404`) is a
chapter-end review quiz (`확인해 볼까요?`) — null `pattern`, populated `exercises[]`,
non-empty explanation. It is not a chapter divider (so calling it `intro` is wrong) and
it is not a teachable pattern (so calling it `grammar` is wrong). The loader will hit
`ck_kgiu_entries_corpus_kgiu_only`-style failures the first time it tries to insert
these rows, OR it will silently coerce them to `intro` and lose the quiz semantics.

A representative vocab example (`vocab_2000_intermediate.json:50927-50958`) is an
appendix "Additional Vocabulary" page — a thematic illustrated reference (`동물 Animals`,
`어패류 Fish and Shellfish`, etc.) with bulleted multilingual lists in `notes[]`. These
are neither `word` (no single headword), `theme_intro` (no theme), nor `subsection_intro`
(no subsection). Coercing them anywhere in the existing enum is wrong.

**Why this is a BLOCKER, not SHOULD-FIX:** the senior-engineer-bar question is "does
every field have a home?" The answer is no for ~50 documented rows of source data that
the schema is supposed to receive. Either the schema or the source contract must
change before A3/A4 runs. Specifically:

1. Add `'reference'` to both `kgiu_entry_type` and `vocab_entry_type`.
2. Update the CHECK constraints. The current `ck_kgiu_entries_pattern_required` already
   allows null pattern when `entry_type <> 'grammar'`, which is fine for KGIU reference
   rows. For vocab, `ck_vocab_entries_korean_required` allows null korean for non-word
   types — also fine for vocab reference rows (which DO have a korean theme word, but
   the CHECK doesn't force it).
3. Decide whether vocab reference rows belong in `vocab_entries` or get their own table
   (similar to `hanja_extensions`). The current `vocab_entries` columns are mostly
   nullable for non-word types, so reusing the same table is plausible — but document
   the choice.
4. The KGIU reference rows have populated `exercises[]` JSONB; that field already exists
   on `kgiu_entries`, so adding the enum value is the only schema change needed.

Alternative fix path: have A3's loader filter or transform reference rows into
`lets_check_exercises` (KGIU side) and an appendix table (vocab side). That moves the
problem but doesn't make it go away — and "silently drop" loses information.

Until this is resolved, mark migration 002 as not safe to apply against the full source
corpus.

---

### SHOULD-FIX

#### SF-1: `vocab_entries.proficiency` is NOT NULL but `theme_intro` / `lets_check` / `subsection_intro` source rows don't carry one

**File:lines:** `002_darakwon_corpora.up.sql:499`

`proficiency` is `proficiency_level NOT NULL`. But:

- `vocab_2000_intermediate.json:16-37` (`theme_intro` for "01 인간 / People") has no
  `"proficiency"` key.
- `lets_check` rows (e.g. `vocab_2000_intermediate.json:1281-1297`) also lack
  `"proficiency"`.

The loader has two options: (a) populate from `corpus_sources.default_proficiency` (which
is itself a lossy mapping of `"L3/L4"` to `"L3"`), or (b) the schema needs `proficiency`
nullable for non-`word` rows. Option (a) is fine as a documented policy, but it should
be written down — currently it's implicit, and a future loader maintainer will set the
wrong default.

**Recommendation:** either (i) make `proficiency` nullable and rely on app/UI logic to
infer from corpus, or (ii) add a NOT NULL default-from-corpus loader contract to the
README's "Coordination with A3" section. (i) is the cleaner DB choice.

#### SF-2: `vocab_entries.notes` can be a string in source JSON, but the CHECK requires `jsonb_typeof = 'array'`

**File:lines:** `002_darakwon_corpora.up.sql:521`

Source examples:
```
vocab_2000_intermediate.json: "notes": "Subsection opener page — Appearance / 外貌 …"
vocab_2000_intermediate.json: "notes": "headword marker: 기사 01"
```

`grep '"notes": "' tools/ingest/output/vocab_2000_*.json | wc -l` returns several rows.
The DB CHECK rejects scalar JSONB, so the loader must wrap each string in a single-element
array. That's a fine convention — but the README's "How to test" doesn't mention it and
A3's loader contract doesn't either. Worth documenting in either the column comment or
the README so A3 doesn't ship a loader that drops these rows.

#### SF-3: `corpus_sources` seed UPSERT bumps `version` on every re-apply, breaking strict idempotency

**File:lines:** `002_darakwon_corpora.up.sql:946-955`

```sql
ON CONFLICT (corpus) DO UPDATE SET
    title = EXCLUDED.title, …,
    updated_at = now(),
    version    = corpus_sources.version + 1;
```

Re-running the up migration on an already-applied DB is not idempotent in the strict
sense — `version` increments and `updated_at` moves forward. ADR-001 §D11 says
migrations should be idempotent; the senior bar §1 Migrations says "applying again is a
no-op on a fresh DB" (verbatim wording differs, but the intent is the same).

The loader will also UPSERT into `corpus_sources` — that path SHOULD bump `version`. So
the migration-side seed and the loader-side upsert are doing the same thing. That's a
duplication that future maintainers will trip over.

**Recommendation:** make the seed an `INSERT … ON CONFLICT DO NOTHING` so re-applying
the migration is a true no-op. Let the loader own version bumps. Updating canonical
metadata (title, publisher) when the source file actually changes is the loader's job,
not the migration's.

#### SF-4: `lets_check_exercises.parent_vocab_theme/subsection` are free text with no reverse FK or uniqueness

**File:lines:** `002_darakwon_corpora.up.sql:802-803, 868-870`

For `parent_kind = 'vocab_subsection'`, the parent is identified only by two TEXT
columns matching `vocab_entries.theme` and `vocab_entries.subsection`. If a theme is ever
renamed (typo fix, translation polish), the exercises become orphaned-by-string with no
referential integrity to surface the breakage.

This is defensible — vocab subsections aren't first-class rows — but the design would be
more robust if either (a) there's a future plan to make subsections first-class rows
(then a FK), or (b) a CHECK / a trigger asserts that for every lets_check_exercises row
with `parent_kind='vocab_subsection'`, the (theme, subsection) pair exists in
`vocab_entries`. ADR-001 §D12 forbids business logic in triggers but this kind of
referential-integrity check would be allowed under "mechanical maintenance" by analogy.

Acceptable as-is for Phase A, but should be reconsidered when vocab subsections become
worth a table of their own (likely Phase C). Worth a brief mention in the ADR or the
README known-gotchas.

---

### NITs

#### N-1: ERD's mermaid omits `ON DELETE/UPDATE` annotations
The prose table at `erd-darakwon.md:198-208` is excellent; the mermaid lacks the
cardinality nuance. Mermaid ER syntax supports it. Cosmetic.

#### N-2: `kgiu_entry_relations.relation_kind` is TEXT + CHECK, while `vocab_entry_relations.relation_type` is an enum
Both are defensible. The justification ("TEXT+CHECK rather than enum so adding a kind
doesn't need a migration", `002.up.sql:428-431`) is reasonable, but the vocab
relation_type is a similarly-closed set yet uses an enum. The asymmetry is fine, but the
inconsistency would be worth one line of justification in `ADR-002` — currently the
"why enum here, TEXT there" reasoning isn't in any ADR.

#### N-3: README.md migration table description for 002 is stale
`README.md:15` says migration 002 is "Sources, sentences, vocab entries, TOPIK, KRDICT
cache". That's not what 002 actually ships — it doesn't include sentences, TOPIK items,
or KRDICT cache. Update the one-line description to match reality
("Darakwon corpora: KGIU + 2000 Words + supplements").

#### N-4: `corpus_sources.default_proficiency` is enum-typed but real data has composite `"L3/L4"`
The seed maps `"L3/L4"` → `"L3"` (lossy), and the JSON itself only carries this on the
source-level metadata, not per-row. Acceptable as a default-hint field — but a brief
COMMENT on the column noting that the source may carry a composite value, and the
seed/loader picks the lower bound, would prevent confusion. (Comment at `:176` says
"default proficiency tag for rows that do not specify one" — doesn't address the
composite-input case.)

#### N-5: `kgiu_entries.unit` and `audio_track` are nullable but have no `COMMENT` on the nullability rationale
ADR-001 §"Schema" says nullable is "an explicit choice, justified in a `COMMENT`". The
column comments at `:293, :294` describe what they are, but don't explicitly justify
nullability ("nullable for intro rows" / "may be missing on entries without printed
audio reference" — both are fine but should be written).

---

### PRAISE

- **P-1:** ADR-005 (kgiu vs grammar_entries) is exceptionally well-reasoned. The
  cross-agent collision was a real risk and was caught + documented with three named
  alternatives explicitly rejected.
- **P-2:** ADR-002 (stable-col-vs-JSONB) demonstrates correct application of the
  senior bar — normalize where queryable, JSONB where shape varies, *with concrete
  reasons rooted in actual queries the app will run*. The "no cross-entry queries on
  examples" argument is the right one and rarely articulated.
- **P-3:** ADR-004 (hybrid target on vocab_entry_relations) is a textbook example of
  designing around the "neither pure option is acceptable" trap. The "FK upgraded by a
  later resolve pass" pattern with a partial expression index for the lookup is a
  proper engineering answer, not a hand-wave.
- **P-4:** Every JSONB column carries `jsonb_typeof(col) = 'array'` CHECK with named
  constraint. This catches the most common loader bug (passing object instead of array)
  AND mitigates the "malformed-JSONB DoS" path in SECURITY.md A2-2. Consistently
  applied across all four such tables.
- **P-5:** The polymorphic-parent integrity on `lets_check_exercises` via discriminator
  + XOR CHECK (`ck_lets_check_exercises_parent_xor`) is the correct way to do this in
  Postgres — no "soft" polymorphism that the DB can't enforce.
- **P-6:** `corpus_sources.source_sha256` with a `CHECK ^[0-9a-f]{64}$` regex addresses
  the reference-data-tampering threat (SECURITY.md A2-6) at the DB layer. The combination
  of provenance hash + version bump + RESTRICT delete is the right defense stack.
- **P-7:** Coordination with A1 is clean: re-uses `set_updated_at()`, re-uses enums,
  adds A1's reserved FK with the reserved name, drops it first in the down migration.
  No redefinitions, no surprises.
- **P-8:** SECURITY.md A2's enumeration is concrete — every vector names both a
  DB-layer defense AND a loader/app-layer defense, distinguishes the two, and
  explicitly cites the ADRs that justify the trade-offs. A2-7 (loader role privilege
  drift) is exactly the kind of "ground-truth ops" thinking the senior bar wants.

---

## Detailed findings

### On modeling fidelity to source data (the BLOCKER deep-dive)

I ran:
```
grep -oE '"type"\s*:\s*"[^"]+"' tools/ingest/output/{grammar_kgiu,vocab_2000}_*.json | sort -u
```

Unique row types observed in the JSON:

| Corpus | `type` values present | Schema handles? |
|---|---|---|
| grammar_kgiu_beginner | `grammar`, `intro`, `reference` | ✗ — `reference` rejected |
| grammar_kgiu_intermediate | `grammar`, `intro`, `reference` | ✗ |
| grammar_kgiu_advanced | `grammar`, `intro` | ✓ |
| vocab_2000_beginner | `word`, `theme_intro`, `subsection_intro`, `lets_check`, `hanja_extension`, `reference` | partial |
| vocab_2000_intermediate | `word`, `theme_intro`, `lets_check`, `hanja_extension`, `reference` | partial |

The `lets_check` and `hanja_extension` row types live in their own tables — correct,
and the README documents this. But `reference` is unaccounted for in either grammar
or vocab. See B-1 above.

### On the trigger pattern reuse

The migration correctly reuses A1's `set_updated_at()` (header lines 8-9, every trigger
at `:188, :320, :434, :570, :685, :771, :856`). It declares its OWN two functions
(`kgiu_entries_tsv_refresh`, `vocab_entries_tsv_refresh`) for tsvector maintenance and
drops them in `down.sql:47-48`. The down migration deliberately does NOT drop
`set_updated_at()` (`down.sql:8-12`) — that's the right call.

### On the partial indexes

Every partial index targets a query named in its COMMENT and a `WHERE` predicate that
matches typical filters:

- `ix_kgiu_entries_category WHERE category IS NOT NULL` — intros have null category,
  filtered out. ✓
- `ix_kgiu_entries_domain_proficiency WHERE entry_type = 'grammar'` — Today queue assembly
  excludes intros. ✓
- `ix_kgiu_entries_pattern_prefix WHERE pattern IS NOT NULL` — pattern is null for
  intros. ✓
- `ix_vocab_entries_korean WHERE entry_type = 'word' AND korean IS NOT NULL` — exact
  headword lookup excludes intros. ✓
- `ix_vocab_entries_theme_subsection WHERE theme IS NOT NULL` — root rows excluded. ✓
- `ix_vocab_entries_domain_proficiency WHERE entry_type = 'word'` — SRS queue
  assembly. ✓
- `ix_vocab_entry_relations_target WHERE target_entry_id IS NOT NULL` — hybrid model
  means many rows have null FK. ✓
- `ix_vocab_entry_relations_target_korean_lower WHERE target_korean IS NOT NULL AND target_entry_id IS NULL` —
  for the resolve-pass loader query. ✓
- `ix_lets_check_exercises_kgiu_parent / vocab_parent` — discriminated polymorphic
  parent. ✓

This is the textbook application of partial indexes. Praise withheld only because there
are too many of them to list individually.

### On the tsvector trigger UPDATE OF columns

`trg_kgiu_entries_tsv` fires `BEFORE INSERT OR UPDATE OF pattern, title_en, explanation, notes`.
The `OF` clause restricts re-running the tsv function to only the four columns that feed
it — saves cost on every other column update. Correct optimization. Same on vocab.
Beware: if the trigger source list ever changes (e.g. add `category` to the tsv), the
`UPDATE OF` clause needs updating too. That's not a current bug but it's a known
maintenance gotcha worth a comment near the function definition. NIT-worthy at best;
omitted from the NIT list because the function comment at `:339-342` does list the
sources.

### On ADR-003 (tsvector config = `simple`)

The choice to defer Korean tokenization to Phase B (Kiwi) is correct — putting an HTTP
call inside a trigger would violate ADR-001 §D12 and would create a cascade-failure
mode. The transition path (`search_tsv_kiwi` sibling column populated by a loader, then
swap the GIN target, then drop the old column) is the proper way to do this.

The threat model in the ADR (pathological-query DoS, injection via FTS input, TSVECTOR
bloat) is appropriately concrete. `plainto_tsquery` vs `to_tsquery` distinction is named
correctly.

### On the down migration

`down.sql` is clean:

- Drops vocab_cards FK BEFORE dropping vocab_entries — order-correct.
- Tables dropped children-first.
- Owned functions dropped.
- Owned enums dropped.
- A1's enums and `set_updated_at()` NOT dropped — correct.
- Idempotent (every DROP IF EXISTS).
- One concern: if any future migration (003+) seeds rows into `corpus_sources`
  (e.g. TTMIK), then `002.down.sql:44` (`DROP TABLE corpus_sources CASCADE`) destroys
  that data. Acceptable because that future migration would re-insert on re-apply, but
  worth flagging: down-migrating 002 is destructive to any subsequently-seeded corpus
  rows. Out-of-scope of 002 itself.

---

## Coordination observations

### With A1 (001_core_schema)

- **`set_updated_at()` reuse** — correct, never redefined.
- **Enum reuse** — `proficiency_level`, `corpus`, `book_level`, `register_level` reused
  as-is.
- **`grammar_entries` naming collision** — caught and resolved in ADR-005. A2's
  source-data table renamed to `kgiu_entries`. Sound resolution.
- **Deferred FK `fk_vocab_cards_vocab_entry`** — added with the exact reserved name
  (`002.up.sql:897`) and `ON DELETE RESTRICT` matching A1's expectation
  (`README.md:101`). Dropped first in `down.sql:32`. Clean handshake.
- **Other two reserved FKs (`fk_vocab_cards_source_sentence`,
  `fk_vocab_cards_topik_item`)** — correctly NOT added by 002, because their target
  tables (`source_sentences`, `topik_items`) are out of A2's scope. Will land in later
  migrations. The migration header at `:34-36` is explicit about this.

### With A3 (loader, future)

- The README A3-coordination section names the upsert key (`corpus, source_id`) and the
  intended loader-role table grants. Both are correct.
- The seed-on-migration vs loader-on-ingest split (SF-3) is the one area where the
  responsibilities overlap and should be made cleaner.
- The implicit "loader fills missing proficiency from `default_proficiency`" contract
  (SF-1) needs to be made explicit before A3 ships.

### With Phase C (canonical-grammar dedup)

ADR-005 sketches the bridge table (`grammar_entry_sources`). The current schema doesn't
paint the bridge into a corner — `kgiu_entries.id` is a stable BIGINT IDENTITY ready to
be FK'd to. ADR-002 notes Phase C may add a `canonical_id` column on `grammar_entries`
without breaking the JSONB model. Good forward-compatibility.

---

## Files referenced

- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/migrations/002_darakwon_corpora.up.sql`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/migrations/002_darakwon_corpora.down.sql`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/docs/erd-darakwon.md`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/docs/ADR-002-stable-cols-vs-jsonb.md`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/docs/ADR-003-tsvector-language-config.md`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/docs/ADR-004-vocab-relations-hybrid-target.md`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/docs/ADR-005-kgiu-vs-grammar-entries.md`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/migrations/SECURITY.md` (A2 section, lines 189-322)
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/migrations/README.md` (A2 section, lines 173-290)
- Source JSONs under `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/tools/ingest/output/grammar_kgiu_*.json` and `vocab_2000_*.json`
