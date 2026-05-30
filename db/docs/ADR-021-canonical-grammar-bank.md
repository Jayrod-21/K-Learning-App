# ADR-021: Canonical-grammar dedup layer (`canonical_grammar`)

**Status:** Accepted
**Date:** 2026-05-28
**Implemented in:** migration `006_canonical_grammar.up.sql`,
`tools/ingest/canonical_grammar.py`, `tools/ingest/cluster_canonical_grammar.py`
**Relates to:**
- ADR-001 (database choices — surrogate IDs, audit columns, TEXT not VARCHAR, JSONB)
- ADR-005 (stable cols vs JSONB)
- ADR-008 (`kgiu_entries` source rows vs `grammar_entries` user-canonical bank)
- ADR-013 (migration tx ownership)

## Context

KGIU (Korean Grammar in Use) is published in three levels — Beginner,
Intermediate, Advanced — and Darakwon deliberately revisits the most-used
forms at each level with progressively richer explanation. Examples
encountered in the source JSONs:

| Form               | Beginner | Intermediate | Advanced |
|--------------------|:---:|:---:|:---:|
| `-아/어도`         | Unit 16 | Ch.11 #03 | — |
| `-(으)면`          | Unit 16 | Ch.11 #01 | — |
| `-(으)니까`        | Unit 9 (because) + Unit 20 (discovery — ②) | (referenced) | — |
| `-처럼/같이`       | Unit 5 (basic comparison) | — | `-듯이` (richer comparison, Ch.18) |
| `-거든`            | (referenced as prereq) | Ch.11 #02 | — |

The app's tap-a-grammar-span gesture (DESIGN_SPEC) expects ONE pin per
form so the "you've banked this" highlight in Reference works
deterministically. But the per-level rows are individually valuable: each
level's explanation is calibrated to its level's learner and we don't
want to lose that calibration.

## Decision

**Option C: hybrid.** Introduce a thin `canonical_grammar` table that
holds the form's *identity* (the dedup key, the canonical display
surface, a coarse `semantic_family`). The per-level rows stay in
`kgiu_entries` and gain a nullable FK back to `canonical_grammar`. The
app:

- Reads `canonical_grammar.pattern_key` for the dedup-highlight join.
- Renders the level-appropriate explanation from `kgiu_entries` when one
  matches the learner's current level; falls back to the "richest"
  explanation otherwise.
- In Reference, fuses every level's explanation into a single page,
  ordered Beginner → Advanced, with the canonical row's `notes.aliases`
  shown as "also seen as: …".

`canonical_grammar.notes JSONB` carries the cluster metadata (aliases
seen, per-level counts, a `needs_review` flag for polysemy cases like
`-(으)니까 ①` vs ②).

### Why C and not A or B?

| Option | Idea | Rejected because |
|---|---|---|
| **A. Merge into one rich entry per form.** Per-level explanations as JSONB sub-records inside the canonical row. | Single source of truth, simplest dedup. | Erodes ADR-008's clean source vs canonical split. Loaders would have to MERGE existing rows on second-pass ingest, breaking the existing per-corpus idempotency contract (each loader writes only to its own source table). Also conflates source-level audit (re-ingest a level, version bumps just that level) with cross-level edits. |
| **B. Keep entries separate, link via `canonical_id` — canonical row holds an aggregated description.** | Less duplication than C. | Storing a "merged description" means another body of text the app must keep in sync. The level-specific descriptions already exist; computing+storing an aggregated form is duplicate state. Also: who edits the aggregated description? Senior reviewers? Then we're back to two write paths. |
| **C. Lightweight canonical row holds identity only; level entries stay in `kgiu_entries`.** ✅ | Respects ADR-008's separation. Cheap to compute. App reads canonical for dedup, level row for content. No state duplication. | The Reference UI has to do a small fan-out join. Acceptable — the cardinality is 1 → (1..4) rows max. |

### What the canonical row stores

```sql
canonical_grammar (
    id                BIGINT IDENTITY PK,
    pattern_key       TEXT UNIQUE NOT NULL,   -- dedup key (e.g. "아/어도")
    canonical_pattern TEXT NOT NULL,          -- display (e.g. "A/V-아/어도")
    semantic_family   TEXT NOT NULL DEFAULT 'uncategorized',
    notes             JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    version           INT NOT NULL DEFAULT 1
);
```

- `pattern_key` is produced by
  `tools.ingest.canonical_grammar.normalize_pattern()` — a deterministic,
  idempotent pure function. NFC-normalises, strips invisibles, strips the
  leading `A/V/N` placeholder + hyphen, strips trailing circled-digit
  ordinal markers (`①②③` — Darakwon's polysemy markers — see "Polysemy"
  below).
- `canonical_pattern` is the longest *raw* surface observed across
  members ("A/V-아/어도" beats "-아/어도" beats "아/어도") with a stable
  tiebreaker for determinism.
- `semantic_family` is a coarse heuristic family tag (condition,
  concession, reason, …) used by the Reference UI's "browse by family"
  facet. The clusterer fills this from KGIU's own `category` column +
  English-title keyword fallback. A senior reviewer can override
  in-place; `cluster_canonical_grammar.py apply` does NOT overwrite the
  stored family after the first insert.
- `notes` is `{ aliases, members_per_level, needs_review, review_reason,
  member_count }`. Lets the Reference UI render the "appears in: Beg
  Unit 16, Int Ch.11" subtitle without re-running the clusterer.

### Polysemy

Darakwon uses `①`, `②`, `③` on patterns whose surface form is identical
but whose meaning is distinct (e.g. `-(으)니까 ①` "because" vs
`-(으)니까 ②` "discovery upon doing X"). The dedup key strips the
ordinal, so both fall into the same cluster — but the clusterer flags
`needs_review = true` and records `review_reason`. A senior reviewer
chooses one of:

1. Confirm — leave them as one canonical row; both senses are user-
   distinguishable from the underlying kgiu rows.
2. Split — insert a manual second `canonical_grammar` row whose
   `pattern_key` is `(으)니까#discovery` (or similar disambiguator), then
   `UPDATE` the relevant `kgiu_entries.canonical_grammar_id` to point
   there. The unique constraint on `pattern_key` permits any suffix
   structure; the convention is documented in
   `CANONICAL_GRAMMAR_README.md`.

The Reference UI surfaces the `needs_review` flag in the admin pane (not
the learner UI).

### Idempotence + reversibility

- `cluster_canonical_grammar.py apply` is idempotent: the upsert's
  `ON CONFLICT … DO UPDATE` is gated by a `WHERE` clause that runs only
  when the display columns actually changed. The kgiu-side backfill is
  `WHERE canonical_grammar_id IS DISTINCT FROM …`.
- `006_canonical_grammar.down.sql` reverses every change. The
  `kgiu_entries.canonical_grammar_id` column is dropped (with its FK
  constraint and index). The `canonical_grammar` table drops cleanly
  because no other migration depends on it.

### What this ADR does NOT decide

- The bridge from `canonical_grammar` to A1's user-canonical
  `grammar_entries` table (the SRS production-drill bank). That's
  Phase D. The expected shape is a junction table
  `grammar_entry_canonical (grammar_entry_id, canonical_grammar_id)`
  populated by the highlight-recognition pipeline (DESIGN_SPEC).
- Cross-reference resolution inside individual entries (C2 owns).
- TOPIK linkage (C4 owns `topik_dependencies`).
- Vocab dedup — different problem, different normalisation.

## Consequences

- The app gains a clean dedup pivot. Tap-a-grammar can store a
  `canonical_grammar_id` on the user's banked-grammar record and the
  "you've banked this" highlight checks `canonical_grammar_id IN (banked)`
  rather than chasing surface-form fuzzy matches at query time.
- The Reference page can render a "form across levels" view by joining
  one canonical row to all its `kgiu_entries` members.
- Adding a future corpus (TTMIK grammar, learner-mined patterns) is a
  matter of writing the normalizer's input adapter and running
  `cluster_canonical_grammar.py apply`. The canonical layer is
  corpus-agnostic by design.

## Open questions

- **Phase B Kiwi morphological key.** Today we hand-roll the regex
  normalizer. When the Kiwi service lands (ADR-014), we can OPTIONALLY
  re-key clusters by morphological signature, catching cases the regex
  misses ("-는 한" / "-(으)ㄴ 한" — same conditional-domain morpheme,
  different surface). This is a Phase D candidate, not blocking.
- **User-typed grammar.** When the highlight-recognition pipeline starts
  producing canonical entries from user-tapped spans, we'll need to
  decide whether those land in `canonical_grammar` (corpus-agnostic
  shared row) or in a separate `learner_grammar` table. Tentative answer:
  `canonical_grammar` if the recognition is confident (Claude returns a
  KGIU-shaped pattern), `learner_grammar` if it's a one-off fragment.

## Test evidence

- `Repository/tools/ingest/tests/test_canonical_grammar_normalizer.py` —
  unit tests for `normalize_pattern`, `split_compound_pattern`,
  `pick_canonical_surface`, `classify_semantic_family`. Covers
  ㅏ/ㅓ alternation, parenthesised morphemes, NBSP/ZWSP, circled-digit
  ordinals, multi-form rows, NFC composition, idempotence.
- `Repository/tools/ingest/tests/test_canonical_grammar_db.py` —
  integration tests against a real Postgres 16 container. Applies
  migrations 001–006, seeds a minimal mixed-level corpus, runs the
  clusterer, asserts (a) one canonical row per dedup key, (b) the
  known-overlapping `-아/어도` maps to one canonical row with two
  member kgiu rows, (c) `ON DELETE SET NULL` semantics, (d) idempotent
  re-apply doesn't churn `version`.
