# Review: C4 — TOPIK dependency linking

**Reviewer:** Independent senior engineer (30y), no authorship of this code.
**Scope:** Migration 008 (`topik_dependencies`), ADR-024, the three-strategy
linker `link_topik_dependencies.py`, the README, and the test suite.
**Bar:** `SENIOR_ENGINEER_BAR.md` + ADR-001.

---

## Summary verdict

**APPROVE WITH MINOR FIXES.**

This is the strongest component review I've done on this project so far. The
data model, the precedence story, the indexing, and the test coverage are all
where a senior engineer would put them. Mechanical-first ordering with Claude
as opt-in is correct trade-off reasoning, documented in ADR-024 in the right
voice (alternatives considered, rationale, consequences).

Two real findings (one moderate, one minor) and a handful of nits below. No
blockers. Nothing here needs to ship before merging; all are follow-ups
unless someone wants to do them in the same PR.

---

## Bar checklist

| Bar item | Status | Note |
|---|---|---|
| Migrations forward + reverse, both runnable | PASS | Down drops trigger, table CASCADE, type — clean |
| No top-level `BEGIN/COMMIT` (ADR-013) | PASS | Both files use `DO $$ … $$` correctly; no SQL `BEGIN;` |
| `BIGINT IDENTITY` PK, audit cols, `updated_at` trigger | PASS | Exact pattern from ADR-001 §D6 |
| `TIMESTAMPTZ`, `TEXT`, `JSONB`, `NUMERIC(p,s)` | PASS | All types per ADR-001 |
| FKs explicit `ON UPDATE/ON DELETE` | PASS | CASCADE on `topik_items` (re-import cleanup), RESTRICT on corpus targets |
| ENUM for closed set; TEXT+CHECK for extensible | PASS | `topik_dependency_type` enum (grammar/vocab); `source` is TEXT+CHECK |
| Natural-key UNIQUE for idempotency | PASS | `uq_topik_dependencies_natural_key` with COALESCE on nullable FKs — the only legitimate way to do this in PG |
| XOR CHECK enforced | PASS | Two redundant CHECKs (dep_type↔FK presence AND count=1) — belt-and-suspenders, and the integration test `test_xor_constraint_rejected_at_db_level` proves it |
| Forward + reverse indexes (partial where appropriate) | PASS | 4 deliberate indexes, each with a query in the COMMENT |
| `COMMENT ON TABLE/COLUMN/INDEX` everywhere | PASS | Thorough, including the index justifications |
| Parameterized SQL throughout (no string interpolation) | PASS | `%s` everywhere; LIKE fragment built but value parameterized |
| Pydantic at every I/O boundary | PASS | `TopikItemRow`, `KgiuCandidate`, `VocabCandidate`, `Dependency`, `LinkerConfig` |
| No external I/O in DB transactions (ADR-013, BAR §1) | PASS | HTTP calls in `link_test` happen with no tx open; only the batch write opens one |
| Idempotent rerun | PASS | `ON CONFLICT … WHERE EXCLUDED.confidence > existing.confidence` — and tested |
| Strategy precedence baked into SQL | PASS | `GREATEST` + WHERE strict-greater. Documented in ADR-024 §4 |
| Unit + integration tests | PASS | testcontainers, real PG16, fake Kiwi+proxy at the boundary — exactly the prescribed pattern |
| README written, includes "how to test" | PASS | Clear, with cost envelope |
| ADR written for non-obvious decisions | PASS | ADR-024 is excellent |

---

## Findings

### F1 — MODERATE — Resume cutoff compares `source_id` strings lexically (`link_topik_dependencies.py:731-733`)

```python
if cp.status == "in_progress" and cp.last_item_id:
    cutoff = cp.last_item_id
    items = [it for it in items if it.source_id > cutoff]
```

The fetch is ordered by `(tt.test_number, ti.section, ti.item_number)` — a
numeric/enum ordering. But resume filters by a **string** comparison on
`source_id` (e.g. `"topik901-read-001"`). The two orderings coincide *only*
because today's source_ids happen to be zero-padded and prefixed in a way
that sorts compatibly with the SQL ORDER BY.

Failure modes if the convention drifts (and `source_id` is loader-controlled,
so it can):
- `"topik36-read-10"` vs `"topik36-read-9"` — lexical says `10 < 9`, so
  resume after item 9 will RE-process item 10 (idempotency saves us — only
  wasted work) OR resume after item 10 will SKIP items 11-19 if the cutoff
  was item 10 and 11 lexically < 10 (data loss in linker coverage).
- A future re-numbering or section rename breaks comparison entirely.

**Recommended fix:** filter by the numeric `item.id` (the PK) which is
monotonic with insertion order, OR pair `(test_number, section,
item_number)` and compare that tuple. Either way: ground the cutoff in the
same key the SQL `ORDER BY` uses, not in a string the loader happens to mint
in a particular shape.

The idempotency guarantee in `write_deps` masks the bug in most cases
(re-doing an item is a no-op), but a SKIP yields silently missing deps for
the items between cutoff and `cutoff < items < next-prefix`.

### F2 — MINOR — Homonym vocab matches not deduplicated semantically (Strategy B)

`vocab_candidates_for_lemmas` does an exact `korean = lemma` lookup. A lemma
like `눈` (eye / snow) maps to multiple `vocab_entries` rows. The current
code adds each as a separate dep keyed by `vocab_entry_id` — which is
technically correct (they're distinct dictionary entries) but the
`evidence.lemma` is identical across rows and the UI can't distinguish "the
item tests the 'eye' sense" from "tests the 'snow' sense".

This is a known limit of lemma-only matching and ADR-024 §7 already flags
follow-ups; suggest adding a one-line note in ADR-024 §3 ("Strategy B" sub-
section) calling this out explicitly so a future reader doesn't think it's
been overlooked.

### F3 — MINOR — Strategy C can write up to 100 grammar deps per item

`grammar_candidates_by_pattern_substring` LIMITs to 25 rows, and Strategy C
iterates up to 4 spans per item (`spans[:4]`). Worst case: 4 × 25 = 100
grammar deps for one TOPIK item with `source='claude_analysis'`. With a
typical corpus of 1,200 items, that's 120k potential rows from one
opt-in pass — and they'd compete with skill_tag rows at the natural-key
conflict (the LIMIT 25 substring match is a wide net).

Not a correctness bug — the WHERE filter discards lower-confidence
duplicates of skill_tag rows — but it does mean uncovered items can each
yield a long candidate list. Two cheap tightenings:
- Cap candidates per `(item, span)` to ~5 (the typical ambiguity ceiling).
- Require the matched fragment to be ≥3 Hangul chars (avoid `오` matching
  every pattern containing the syllable).

ADR-024 §7 already flags "narrow to entries whose `pattern` substring
appears in one of the item's options" — same family. Document the cap, or
add the constants, before turning Strategy C on for the full corpus.

### F4 — NIT — `LinkerConfig.log_level` is parsed but never re-applied inside `run()`

`main()` calls `configure_logging(cfg.log_level)` before `asyncio.run(run(cfg))`,
but `cfg.log_level` is also stored on the Pydantic model and ignored by
`run()`. Harmless; either drop the field, or call `configure_logging` from
inside `run()` and document that programmatic callers don't need `main()`.

### F5 — NIT — `_run_strategy_a/b/c` checks out a separate pool connection per item per strategy

For 1,200 items × 3 strategies = 3,600 connection acquisitions per full run.
The pool will reuse, so it's not catastrophic, but for the cost it'd be
cleaner to acquire one connection per item and pass it down:

```python
async with pool.connection() as conn:
    a = await strategy_a_skill_tag(conn, item)
    b = await strategy_b_lemma_match(conn, kiwi, item)
    c = await strategy_c_claude(conn, proxy, item, bool(a or b)) if use_claude else []
```

This also keeps the per-item DB reads colocated with the linker's reasoning,
which makes pg_stat_statements traces easier to read.

### F6 — NIT — `LinkerConfig.test_numbers: list[int] | None` Pydantic-validated, but the CLI parser does `[int(x.strip()) for x in ...]` and could fail with a bare `ValueError` instead of a friendly `argparse` error

`int("notanumber")` raises `ValueError` directly to the user. Wrap in a
custom `argparse.ArgumentTypeError` so the error reads "argument
--test-numbers: invalid value 'notanumber'" rather than a bare traceback.

### F7 — NIT — `_request_id()` correlation id is generated per-call

It changes for every HTTP call within a single item's processing. For
log-correlation purposes you'd usually want one id per **item** (or per
batch). The current shape makes it hard to filter logs to "everything that
happened while processing item X". Easy fix: bind a `structlog.contextvars`
on entry to `link_test` and let the HTTP clients read it.

### F8 — NIT (style only) — `_HANGUL_RE` includes hyphens, parens, and slashes — comment why

The regex is `[㄰-㆏가-힯\-\(\)/]+`. The hyphens and parens are because
KGIU patterns look like `-(으)니까`. Worth a one-line comment so a future
reader doesn't simplify them out.

---

## Detailed comments

### Migration 008 — `topik_dependencies.up.sql`

**Strong points (called out for posterity):**

- **XOR is enforced two ways** (`ck_topik_dependencies_xor` and
  `ck_topik_dependencies_target_one_side`). The second is technically
  redundant given the first, but the comment ("belt and suspenders") is
  explicit and the test exercises both.
- **Natural key as `UNIQUE INDEX` with `COALESCE(_, 0)`** — this is the one
  correct way to make a UNIQUE work across nullable XOR columns in
  Postgres (the alternative — `NULLS NOT DISTINCT` — would lose the ability
  to ever have NULL on the other side, even with XOR). The choice of `0` as
  sentinel is safe because `id` is `BIGINT GENERATED ALWAYS AS IDENTITY`,
  which never produces 0.
- **All four indexes have query justifications in `COMMENT ON INDEX`** —
  this is the bar from SENIOR_ENGINEER_BAR §1 "no speculative indexes" and
  it's followed to the letter.
- **CHECK `jsonb_typeof(evidence) = 'object'`** — defends against the
  linker writing a scalar. The kind of thing you only think to add after
  you've been bitten once.
- **Confidence is `NUMERIC(3, 2)`** — exact decimal, no float-equality drift
  for the `GREATEST(…)` precedence calc. Matches ADR-001 §"Types" exactly.
- **FK targets are `kgiu_entries` / `vocab_entries`, not `grammar_entries`**
  — correct per ADR-024 §D2 reasoning. TOPIK deps belong on the corpus
  layer, not the per-user banked layer.

**Down migration:** Clean and correct. `DROP TABLE … CASCADE` releases the
indexes and trigger; the enum is dropped after because no other migration
references it. Matches the up file in reverse.

### Coordination check (006 / 007 / 008 / 009)

Prompt claimed C2 took 007. Actual filesystem state:
- 006 = canonical_grammar (C1) ✓
- 007 = **not present** (reserved-but-unused, per the 009 file's own header)
- 008 = topik_dependencies (C4 — this review) ✓
- 009 = cross_ref_relations (C2)

The header in `008` mistakenly claims "C-2 owns 007 (cross_reference UNIQUE
if needed)". The 009 file's own header corrects this ("007 was reserved …
not taken; 009 leaves explicit headroom"). The coordination outcome is
fine — no collision — but **the comment in 008 is now inaccurate** and
should be patched to read something like:

> * C-1 owns 006 (canonical_grammar).
> * C-2 owns 009 (cross_reference relations).
> * C-3 is read-only.
> * 007 was reserved but never claimed.

One-line doc fix. Not load-bearing on behavior.

### ADR-024

Excellent. Hits every prompt expectation:

- Alternatives table for the polymorphic-junction shape with honest
  trade-offs.
- Justification for `kgiu_entries` vs `grammar_entries` as target.
- Explicit cost model for Strategy C with the ~$3 vs ~$15 envelope.
- Honest documentation of the "Strategy A over-collects" trade-off (§D1
  consequences).
- Open questions section names the canonical_grammar future migration path
  and the manual-override gap.

One small inconsistency: §4 quotes the `ON CONFLICT` SQL with `WHERE
EXCLUDED.confidence > topik_dependencies.confidence`. The implementation
matches. Good. The note "GREATEST is redundant given the WHERE … defense
against a future hand-edit" is exactly the right comment for that line of
code — flagged here because more codebases need it.

### Linker — `link_topik_dependencies.py`

**Architecture:** Clean separation. `KiwiClient` / `ClaudeProxyClient` at
the HTTP boundary, `fetch_items` / `grammar_candidates_*` / `vocab_candidates_*`
at the DB boundary, Strategy A/B/C as pure logic, `link_test` as orchestrator,
`run` at the top.

**Type safety:** Pydantic models at every domain boundary including the
internal `Dependency`. The defensive XOR check in `write_deps` (raises
`ValueError` before hitting SQL) is exactly the "domain types, not strings"
discipline from BAR §2.

**Idempotency:** Both Python-level (the XOR guard) and DB-level (the natural
key UNIQUE + ON CONFLICT). The two reinforce each other.

**Transaction discipline:** HTTP calls in `link_test` are made with the
pool's connection released between calls (each strategy opens and closes its
own); only the batch write opens a transaction, and it does so AFTER the
HTTP work. Honors ADR-013 / BAR §1 "no external I/O inside an open
transaction". Note: see F5 — the discipline is right but the implementation
opens more connections than necessary.

**Resumability:** `load_state` per `(corpus='topik_dep_linker',
source_path='topik_dep_linker:test=<N>')`. Mostly works; see F1 for the
cutoff comparison concern.

**Error handling:** Per-item `try/except` logs `error=repr(err)` and
continues. Per-test outer `try/except` marks the load_state row failed and
re-raises. Total-failure path (every item errored) exits non-zero via the
`stats.items_processed == 0` check. This is the right shape — partial
failures are tolerated, total wipeouts are operator-actionable.

### Tests

`test_link_topik_dependencies.py` is genuinely good. Coverage:

- `test_skill_tag_mapping_includes_known_tags` — guards against accidental
  deletion from the mapping dict.
- `test_content_pos_filter_excludes_particles_and_endings` — sanity on the
  Kiwi POS filter, including the specific Sejong tags (JKB, EF, ETM).
- `test_dependency_xor_enforced_in_python` — proves `write_deps` rejects
  bad rows before SQL.
- `test_strategy_b_returns_empty_when_kiwi_returns_no_lemmas` — the "no
  spurious deps" guarantee.
- `test_strategy_a_writes_grammar_dep_per_matched_kgiu_entry` — end-to-end
  Strategy A with negative case (non-matching category not picked up).
- `test_strategy_b_writes_vocab_deps_per_matched_lemma` — with a vocab
  lemma that has no matching entry (가다) to prove the lemma→vocab join is
  selective, not promiscuous.
- `test_idempotent_rerun_produces_no_new_rows` — three consecutive writes
  of the same dep produce exactly one row.
- `test_strategy_precedence_higher_confidence_wins` — low→high upgrades,
  high→low is a no-op skip, surviving row's source/evidence is the
  high-confidence one. The detail of checking the persisted `evidence`
  JSONB is exactly right.
- `test_xor_constraint_rejected_at_db_level` — `pytest.raises(CheckViolation)`
  with both FKs set. Proves the DB defense survives a hypothetical buggy
  loader.
- `test_strategy_c_uses_proxy_only_when_uncovered` — `already_covered=True`
  short-circuits; `already_covered=False` invokes the fake proxy.

**Gaps (small):**
- No test exercises the **resume** path (F1). A test that inserts a
  `load_state` row with `last_item_id` set, then runs `link_test`, and
  asserts that earlier-numbered items are skipped, would catch the lexical
  comparison concern.
- No test exercises a `Strategy C` confidence value that **beats** an
  existing A row. The precedence test uses the opposite direction
  (A overwrites C). A round-trip test would lock in the symmetry.
- The `test_xor_constraint_rejected_at_db_level` test uses an `'ending'`
  category that doesn't match any A-mapping value — fine, but adds a
  fixture row that's never reused. Cosmetic.

None of these are blockers.

---

## Coordination

- **Migration numbering:** C4 took 008 as instructed; 009 ended up with C2
  (cross-reference resolution). 007 is unused but explicitly reserved-and-
  not-claimed per 009's header. No collision; one minor comment-only fix
  needed in 008 (see "Coordination check" above).
- **A2 sources:** `kgiu_entries` / `vocab_entries` from 002 — referenced
  correctly. `kgiu_entries.entry_type = 'grammar'` filter in
  `grammar_candidates_by_category` matches the enum definition.
  `vocab_entries.entry_type = 'word'` filter matches the enum and the
  `ck_vocab_entries_korean_required` CHECK (which guarantees `korean` is
  non-null for `word` rows — important because Strategy B joins on it).
- **A2 ↔ user grammar:** Correctly NOT targeting `grammar_entries` (the
  per-user bank). ADR-024 §D2 explains this.
- **C1 (canonical_grammar):** Cleanly forward-compatible — ADR-024 §7
  describes the migration path when canonical_grammar gets adopted as a
  third dep target.
- **B1 (Kiwi service):** HTTP contract `POST /tokens` with `{"text": ...}`
  → `{"tokens": [{"lemma": ..., "pos": ...}, ...]}`. Stated in code, not
  in the README — would be worth one line in the README's prerequisites.
- **B4 (Claude proxy):** Strategy C calls `/grammar/identify` on B3
  (which proxies to B4). The linker never imports `@anthropic-ai/sdk`,
  consistent with ADR-020.
- **ADR-013 transactions:** Both 008 migration files free of top-level
  BEGIN/COMMIT; verified by reading both files end-to-end.

---

## Recommendation

Merge. Open follow-up tickets for F1 (resume cutoff — moderate, should be
fixed before next loader run with checkpoints), F3 (Strategy C candidate
cap — needed before the first `--use-claude` corpus run), and F2 (homonym
documentation note). F4-F8 are nits — fix opportunistically.

The component meets the senior-engineer bar. The data model and the
precedence story are the kind of thing I'd point a junior engineer at as an
example.
