# REVIEW_B2 — KRDICT schema + importer

**Reviewer:** Independent senior reviewer (30 yr).
**Author under review:** Agent B2.
**Date:** 2026-05-28.
**Scope:** Migration 003 (up/down), `krdict_models.py`, `krdict_parser.py`,
`load_krdict.py`, parser+loader tests, fixture, KRDICT README + SECURITY,
ADR-015 / ADR-016 / ADR-017.

---

## 1. Summary verdict

**APPROVE WITH CHANGES.**

This is solid, well-thought-out work. The schema is properly normalized, the
parser is correctly defended (defusedxml + streaming + per-entry skip), and the
loader is genuinely idempotent and resumable with provenance hashing. The three
ADRs justify the non-obvious calls (denormalized first-sense, POS as TEXT+CHECK,
XML vs JSON). The SECURITY doc is the best one in this repo so far —
ten attack vectors enumerated with concrete defenses, each cross-referenced to a
test.

I have **0 blockers**, **6 should-fix** findings, **5 nits**, and **6 praises**.
None of the should-fix items rise to "refuse to ship", but at least two of
them (#SF1 resume monotonicity and #SF2 the replace-all-deletes-children blast
radius) deserve attention before the first production run on the real KRDICT
archive.

The single highest-impact thing to fix is **#SF1**: the resume cursor assumes
source_ids visit the loader in an order such that "skip until you see X" is
sound. That holds in the fixture and probably holds in practice, but the
loader does not enforce it, the parser does not document it, and the failure
mode (silent data loss on resume) is bad. See finding #SF1 for the cheap fix.

---

## 2. Bar checklist (against SENIOR_ENGINEER_BAR.md)

### Schema (003)

| Bar item | Status | Notes |
|---|---|---|
| 4 tables (entries/senses/examples/inflections) correctly normalized | PASS | Plus `krdict_source` (provenance) and `krdict_import_state` (checkpoint). Cleanly 3NF. |
| Surrogate BIGINT IDENTITY PKs everywhere | PASS | Every table — 003 up.sql:51, :98, :245, :306, :360, :425. |
| Audit columns on every entity table | PASS | `created_at`, `updated_at`, `version` on all six. |
| Explicit ON DELETE policies | PASS | RESTRICT on FK to `krdict_source` (003:127); CASCADE for child rows (:266, :323, :374). Each justified in ADR-015 §D8. |
| ENUM where appropriate; TEXT+CHECK for drift-prone (POS) | PASS | Register uses `register_level` enum; POS is TEXT+CHECK per ADR-017. |
| TIMESTAMPTZ, TEXT, JSONB types | PARTIAL | No JSONB on KRDICT (correctly — KRDICT shape is stable). TIMESTAMPTZ and TEXT used throughout. |
| COMMENT ON TABLE/COLUMN/INDEX | PASS | Every table and every index commented; columns where purpose isn't obvious. |
| tsvector + GIN indexes for FTS | PASS | `ix_krdict_entries_search_tsv` (003:206) with weights A/B/C/D. |
| Migration is reversible | PASS | Down drops children before parents, idempotent IF EXISTS, scoped to objects 003 owns. |
| No top-level BEGIN/COMMIT (ADR-013) | PASS | Verified — neither file contains BEGIN/COMMIT/ROLLBACK/SAVEPOINT. |

### Parser

| Bar item | Status | Notes |
|---|---|---|
| defusedxml used (XXE defense) | PASS | `from defusedxml import ElementTree as DET` (parser.py:42); `forbid_dtd=True, forbid_entities=True` set explicitly. |
| Streaming via iterparse (memory bounded) | PASS | `DET.iterparse` + `elem.clear()` in finally (parser.py:253). |
| Tag constants centralized | PASS | Lines 58–79. One-line fix on a schema rename. |
| Pydantic models validate at the boundary | PASS | `extra="forbid"` on every model — drift surfaces immediately. |
| Malformed entries skip-with-log, no crash | PASS | Per-entry try/except (parser.py:236) + on_skip callback + structured log. |

### Loader

| Bar item | Status | Notes |
|---|---|---|
| Idempotent (upsert by natural key + version-bump-only-on-real-change) | PASS | `ON CONFLICT (source_id, homograph_index) DO UPDATE … WHERE IS DISTINCT FROM …` (load:222). |
| Resumable via checkpoint (cursor keyed on source archive — not just last_id) | PASS but see #SF1 | Keyed on `(source_label, sha256)` — V5-grade. But the cursor compares source_id equality, not ordering — see #SF1. |
| Transactional per batch | PASS | `conn.transaction()` wraps both the entry persists AND the checkpoint write per batch (load:638). Correct. |
| Parameterized queries everywhere | PASS | All SQL uses `%(name)s`. Test `test_persist_entry_uses_parameterized_queries` mechanically asserts. |
| CLI with `--source`, `--resume`, `--dry-run`, `--batch-size` | PASS | All four plus `--source-label`, `--license*`, `--notes`, `--log-format`, `--database-url`. |
| Structured logs | PASS | Custom `_JsonFormatter` with whitelist + repr() fallback. Stdlib-only by design — fine. |

### Quality

| Bar item | Status | Notes |
|---|---|---|
| Sense reordering handling (replace-all vs diff-upsert — justified) | PASS but see #SF2 | Replace-all chosen, justified at load:251 and in ADR-015 §D10. Cost: every entry update triggers DELETE → INSERT × N senses + examples + inflections, even on unchanged children. |
| POS schema-drift fail-loud behavior — correct? | PASS | Loader RE-RAISES CheckViolation (load:644-660); does NOT silently skip. ADR-017 documents this is by design. Per-batch behavior — see #SF3 for nuance. |
| Denormalized first-sense definitions on entries — justified? | PASS | ADR-015 §D5 explains tap-a-word hot path. Reasonable. |
| Tests cover: parse known-good, parse malformed, resume, idempotency | PASS | All four — though the idempotency / resume integration tests require live Postgres. |

### Security

| Bar item | Status | Notes |
|---|---|---|
| XXE blocked via defusedxml | PASS | V1 in SECURITY.md; `forbid_dtd` + `forbid_entities` explicit. |
| Source trust documented (semi-trusted gov source) | PASS | KRDICT_SECURITY.md "Trust posture" section. |
| Huge-entry DoS defense | PASS | Two-wall defense (Pydantic max_length + DB CHECK length(col) BETWEEN N AND M). V3 in SECURITY.md. |
| Resume cursor not tamperable (sha256 of source archive) | PASS | V5 explicitly modeled. SHA recomputed per run; tampered checkpoint bounded to the same archive. |

### Documentation

| Bar item | Status | Notes |
|---|---|---|
| README: download, license, run, verify, gotchas | PASS | KRDICT_README.md has all five. |
| 3 ADRs justify schema, parser format (XML vs JSON), POS-taxonomy | PASS | ADR-015 / ADR-016 / ADR-017 — each ~50–200 lines, each lists alternatives considered and consequences. |

---

## 3. Findings

### BLOCKERS

**None.**

### SHOULD-FIX

#### SF1. Resume cursor relies on source_id ordering that the parser does not guarantee

**Files:** `load_krdict.py:316–322, 528–546`; `krdict_parser.py:283`.

The resume cursor design (load_krdict.py:316 docstring):

> "Bytes-comparable 'skip until we pass this source_id'. KRDICT source IDs are
> stable strings; lexicographic compare matches the parser's deterministic
> visit order (sorted XML file paths, then per-entry document order within each
> file)."

But `_filter_resumable` (load:528) does NOT do a lexicographic compare. It does:

```python
if entry.source_id == target:
    state.seeking = False
    continue
# Skipping past prior work.
continue
```

It walks the iterator until it sees an exact-match source_id, then flips
`seeking=False`. Two failure modes:

1. **The marker entry no longer exists in the archive.** If a new vintage
   removes the entry that was last-processed, the loader silently SKIPS
   EVERY REMAINING ENTRY (the `seeking` flag never flips) and reports
   `entries_processed` unchanged. There is no warning, no error — the
   `completed_at` checkpoint is then written, and the loader claims success
   on a zero-progress run. This is a silent data-loss bug on the resume path.

2. **The marker entry has moved earlier in the archive.** Same outcome.

The parser's "sorted XML file paths, then document order within each file"
guarantees a *file-set-stable* visit order, not a source_id-ordered one.
KRDICT entries in document order are NOT necessarily in source_id order
(homograph_index sequences will repeat IDs, and KRDICT publishes additions
intermixed in later volumes).

**Fix (cheap):**
- Track parser position by `(file_path, byte_offset)` or `(file_path,
  entry_ordinal)` instead of by source_id. Persist that as the resume cursor.
  This is what the parser already produces (sorted file order + per-entry
  ordinal); just thread it through.
- Or, if you keep source_id as the cursor, add a guard: if `seeking` is still
  True at end-of-input, raise a "resume marker not found" error instead of
  silently committing zero progress. That's the minimum defense and is ~5
  lines.

I'd push for the position-based cursor — it's the same complexity and removes
a class of footgun.

#### SF2. Replace-all sense/example/inflection on EVERY entry upsert burns version + churn

**Files:** `load_krdict.py:251–257, 403–441`.

The loader takes the "replace-all" path on every entry it considers updated:
DELETE all senses (which CASCADEs to examples), re-INSERT them; same for
inflections. This is justified at load:251 ("Simpler than upserting each
sense in place because KRDICT senses can reorder upstream") and in
ADR-015 §D10.

Two issues:

1. **Children always change `updated_at` even when their data didn't.** The
   IS DISTINCT FROM guard on `krdict_entries` prevents the *entry* row from
   bumping version on unchanged content — but the children get DELETEd and
   re-INSERTed unconditionally. So even a no-op re-run (same archive, same
   sha) of a single entry where the parent IS DISTINCT FROM check says
   "nothing changed" will still delete-and-reinsert N senses + M examples +
   K inflections. Run the loader twice and you've churned 250k–500k example
   rows for zero net change.

   The CASCADE-DELETE → INSERT path is also fired even when the entry-row
   upsert was a no-op (the `WHERE … IS DISTINCT FROM …` guard returned no
   row, so `_persist_entry` falls into the `else` branch at load:384 and
   STILL proceeds to delete-and-reinsert children). That's clearly not the
   intent.

2. **`test_loader_idempotent_on_rerun` doesn't catch this.** That test
   verifies row *counts* are equal across two runs — they will be, because
   delete-then-insert preserves count. It does NOT verify that `updated_at`
   on child rows is preserved across an idempotent re-run.

**Fix:** Skip the children-replace path entirely when `_persist_entry` enters
the "row unchanged" branch (i.e., `cur.fetchone()` after the upsert returned
None). The natural-key fetch can still return `entry_pk`, but you should
`return` before deleting children. That makes a no-op re-run truly a no-op
for child rows.

If you want full diff-upsert later (so individual changed senses don't take
down their unchanged siblings), that's a follow-up; the above is the minimum
hygiene to make the "idempotent" claim hold.

Also: add a test like
`test_loader_idempotent_does_not_churn_child_updated_at` to lock the
behavior in. The current test passes a false negative.

#### SF3. CheckViolation in mid-batch aborts the batch AND the checkpoint, but the message says "fail loudly" — what actually happens?

**File:** `load_krdict.py:644–660`.

When a CheckViolation fires mid-batch, the loader `raise`s. The enclosing
`with conn.transaction()` block then rolls back the entire batch — including
the entries that were successfully upserted earlier in the same batch AND
the checkpoint update. Then the exception bubbles to `main` and the loader
exits with code 4 (`KrdictLoaderError`).

So the actual behavior on a bad POS value is:

- The most recent batch's worth of work (up to `--batch-size` entries) is
  lost.
- The checkpoint stays at the END of the *previous* batch.
- `--resume` then re-processes the failed batch from scratch — and crashes
  at the same entry again.
- The operator has to choose between fixing the schema (`ALTER TABLE … DROP
  CONSTRAINT … ADD CONSTRAINT …` in a migration) before re-running, or
  filtering out the bad entry.

That's actually correct behavior for "fail loudly" and matches what ADR-017
documents. **But** the comment at load:644–660 is internally contradictory:

```
# Per-entry recoverable: the entry violated a CHECK
# (e.g. an unknown POS value). Log and skip — don't
# poison the whole batch.
# NOTE: CheckViolation aborts the current tx in
# psycopg, so we re-raise and re-batch single-entry
# if needed. For Phase A, fail the batch loudly —
```

The first three lines describe a "log and skip" behavior that the code does
NOT implement. The NOTE then says "for Phase A, fail loudly" — which is
what the code DOES do — but readers will be confused by the first paragraph.

**Fix:** delete the misleading first-paragraph comment. The behavior is
"fail-loudly on schema drift" and the comment should say that and only that.

#### SF4. `krdict_source` upsert ON CONFLICT only matches `source_label`, but the natural keys are two columns

**File:** `load_krdict.py:178–207`, schema `003_krdict.up.sql:66–67`.

The schema has TWO unique constraints on `krdict_source`:
- `uq_krdict_source_label` UNIQUE(source_label)
- `uq_krdict_source_source_path` UNIQUE(source_path)

The upsert uses `ON CONFLICT (source_label)`. If a caller re-uses an existing
`source_path` with a NEW `source_label` (e.g., "KRDICT-2026-Q2" pointing at
the same on-disk archive as "KRDICT-2026-Q1"), the upsert will instead hit
the `uq_krdict_source_source_path` constraint and raise `UniqueViolation`,
not a friendly error.

This is also a security-property bug for V5: if the operator changes
`--source-label` while pointing at the same files, they'd reasonably expect
either "use the existing row" or "create a new label entry"; instead they
get a hard crash with a Postgres error.

**Fix:** Either (a) drop `uq_krdict_source_source_path` if you actually
support multiple labels on the same path, or (b) document the constraint in
the README and add a friendly error wrap in the loader. I'd recommend (a) —
the constraint isn't load-bearing and the failure mode is annoying.

#### SF5. Whitespace handling is asymmetric — leading/trailing stripped but interior runs preserved

**File:** `krdict_models.py:57–63, 81–87, 106–111`.

`_strip_or_none()` collapses leading/trailing whitespace and maps "" → None.
But the model field validators with `mode="before"` apply this BEFORE the
length check. So an input string of `"   가   "` becomes `"가"` and passes.
That's the right call.

However, the parser passes XML element text through `child.text.strip()`
(parser.py:101) AND the model layer ALSO strips — fine, but redundant. The
risk is the model's `_strip_korean` / `_strip_def_korean` validators are
inconsistent with each other — `_strip_korean` (example KO) and
`_strip_def_korean` (sense KO) both raise on None, but the headword
validator `_strip_required` (krdict_models.py:156–161) ALSO raises on None.
Three near-identical functions; should be one. Minor.

Also: the model uses `str_strip_whitespace=False` in `model_config` but then
strips manually in validators. Why opt out of auto-strip if you're going to
strip anyway? Either set `str_strip_whitespace=True` and delete the
strip-in-validator code, or document why you can't.

**Fix:** consolidate the three `_strip_required` variants into one shared
validator (DRY rule of three is met). Pick `str_strip_whitespace=True` or
keep the manual approach — but be consistent and document the choice.

#### SF6. The tag-constant table has a name collision masking sense-level vs entry-level register

**File:** `krdict_parser.py:65, 72`.

```python
TAG_REGISTER = "register"          # entry-level
TAG_SENSE_REGISTER = "register"    # sense-level
```

Same string value, different names. That's deliberate ("KRDICT uses `<register>`
at both levels"), but having two constants with identical values is a
"why?" trap. A future reader will be 100% sure one of them must be wrong
and may rename one to fix the "duplicate".

**Fix:** drop `TAG_SENSE_REGISTER` and use `TAG_REGISTER` at both call
sites, with a comment explaining KRDICT uses the same tag at two scopes.
Or, if KRDICT in fact uses different tags for entry vs sense register (the
ADR text suggests they might — sense register is "inconsistent" and "free
TEXT" while entry register is the closed enum), the constants are wrong
and the parser is reading the same tag for both. Either way, this needs a
test that distinguishes the two and a comment cementing the contract.

### NITS

#### N1. `count_xml_entries` does a "line by line" scan but iterates over a binary file in line mode — fine, but the comment is misleading

**File:** `load_krdict.py:155–170`.

The function counts `b"<entry>"` and `b"<entry "` substrings line by line.
If the source XML has `<entry attr="…">` split across a line boundary (no
newline before the tag), the count is wrong. KRDICT is well-formatted so this
won't happen in practice, but the comment says "purely defensive" — that's
overselling. Maybe just call it a sanity-check heuristic.

#### N2. Trigger function naming inconsistency

**File:** `003_krdict.up.sql:198–202`.

The trigger fires `BEFORE INSERT OR UPDATE OF headword, pronunciation,
definition_korean, definition_english`. Good — only fires on actual
field changes. But the comment in ADR-015 §D6 says "BEFORE INSERT OR
UPDATE" without the column list. Minor doc-vs-code drift.

#### N3. CLI `--source-label` defaults to "KRDICT"

**File:** `load_krdict.py:728–732`.

The README correctly recommends `--source-label "KRDICT-2026-Q1"`. But
because the CLI has a default of just `"KRDICT"`, an operator running
without `--source-label` for the first time creates a row labeled "KRDICT"
and then can never have a second vintage. I'd require `--source-label` (no
default) so the operator MUST think about it.

#### N4. `_fetch_resume_state` does a SELECT outside a transaction

**File:** `load_krdict.py:499–525`.

Reading the checkpoint outside a transaction is fine for correctness, but
inconsistent with the rest of the loader's careful tx ownership. Each
SELECT-on-conn opens an implicit single-statement tx in autocommit mode
(but `_connect` sets `autocommit=False`, so this becomes a long-running tx
that's never committed). Not a bug, but a stylistic smell. Wrap in
`with conn.transaction()` for clarity.

#### N5. Test fixture has source_id `10006` for both 사과 homographs — good coverage but the malformed entry has no entry_id at all

**File:** `tests/fixtures/krdict_sample.xml:208–215`.

Excellent that both homograph paths are tested. But the malformed entry's
only defect is the missing `<entry_id>` — there's no fixture covering "entry
with entry_id but no senses" or "entry whose senses all lack a definition_ko".
Those paths exist in the parser (lines 144, 199) but aren't asserted in tests.
Easy addition.

### PRAISE

#### P1. The SECURITY doc enumerates ten attack vectors with concrete defenses AND test references

`KRDICT_SECURITY.md` is the highest-quality SECURITY doc in this repo so far.
V5 (resume forging) in particular shows real threat-model thinking — sha256
keying limits damage to the specific archive, not the operator's imagination.
And every defense is cross-referenced to a test or a code line. This is the
shape every component's SECURITY.md should follow.

#### P2. Idempotent upsert with `IS DISTINCT FROM` guard avoiding version churn

`load_krdict.py:200–206, 232–240`. Re-running on an unchanged archive does
NOT bump `version` or `updated_at` on the parent rows. This is the right
contract for "idempotent". (Caveat in #SF2 about children — but the parent
behavior is exactly right.)

#### P3. Tag constants centralized for cheap schema-drift response

`krdict_parser.py:58–79`. A KRDICT XML schema change is a one-block edit.
This is what ADR-016 promised and the code delivers it.

#### P4. The migration scrupulously avoids top-level BEGIN/COMMIT per ADR-013

Verified end-to-end. `migrate.py`'s discover_migrations would reject it
otherwise, but I checked the file directly and it's clean.

#### P5. CheckViolation behavior matches ADR-017 — schema drift fails loud

The decision to NOT silently coerce unknown POS to NULL is explicitly
documented in ADR-017 and implemented in code. A new POS value triggers a
DB-level CHECK violation that bubbles to the operator's attention. This is
the right call.

#### P6. Two-wall length defense (Pydantic + DB CHECK)

`krdict_models.py:46–54` and `003_krdict.up.sql:137–142, 273–276, 330–333,
386–389`. The constants match. Defense in depth done correctly — a buggy
loader still can't insert a 100MB headword because the DB also says no.

---

## 4. Detailed evaluation by criterion

### Schema design

Tables are 3NF; surrogate `id BIGINT GENERATED ALWAYS AS IDENTITY` is uniform;
audit triple (`created_at`, `updated_at`, `version`) on every table including
the provenance/state tables. FK on-delete policies are explicit and justified
(ADR-015 §D8): RESTRICT to source (don't delete a source while entries cite
it), CASCADE for true children (a sense without an entry is meaningless).

Index choices justified per query (each `COMMENT ON INDEX` names the query
it serves) — this is exactly what the bar asks for. Partial indexes used
correctly (`WHERE pronunciation IS NOT NULL`, `WHERE part_of_speech IS NOT
NULL`) so the index doesn't bloat with NULL keys.

The denormalized first-sense definitions on the entry row are a legitimate
performance shortcut for the tap-a-word hot path; ADR-015 §D5 makes the case.
The cost (loader must keep entries.definition_korean in sync with sense 1)
is borne in `_entry_params` (load:359–372).

The TSVECTOR trigger fires only `BEFORE INSERT OR UPDATE OF` the four
columns it actually depends on. That's the correct narrow trigger pattern
(avoid spurious tsv recompute on a register-only update).

`krdict_source` deliberately sits outside `corpus_sources` (ADR-015 §D12)
because the latter requires NOT NULL UNIQUE corpus and KRDICT isn't a
"learner corpus" in the DESIGN_SPEC sense. Clean call.

The provenance/state tables include CHECK constraints on counter signs
(`entries_processed >= 0`) and sha256 format (`~ '^[0-9a-f]{64}$'`). Belt
and suspenders.

### Parser

`defusedxml.ElementTree` with `forbid_dtd=True, forbid_entities=True`
explicit (parser:224). XXE class blocked. Tag constants at top of file
(parser:58–79). Per-entry try/except (parser:236) yields a `SkipReason` to
an optional callback — the loader uses this to count parser-side skips
without entangling parser logic.

`elem.clear()` in `finally` (parser:253) is critical for streaming; it's
in the right place (always runs, even on yield consumption).

`parse_directory` sorts by filename (parser:283). Combined with `iterparse`'s
document-order entry yield, this gives a deterministic visit order — which
the loader's resume cursor assumes (see #SF1 for the caveat).

`_int_or_default` (parser:104) defangs a malformed sense_num — falls back
to the position-based ordinal. Sensible.

The `register=` value flows through `_coerce_register` on the model
(krdict_models:163), which only accepts known enum values; anything else
becomes None. That's the right place for that validation — it's a boundary
concern.

### Loader

Connection setup is conservative: `autocommit=False`, statement_timeout=0,
application_name set (load:567–579). Per-batch `with conn.transaction():`
correctly wraps both the entry upserts AND the checkpoint write — so a
crash mid-batch loses only the in-flight batch, not the checkpoint of the
previous batch. This is the contract the README claims and it holds.

`_persist_entry` (load:375–441):
- Upsert returns RETURNING id when the row actually changed; falls back to
  natural-key lookup when the IS DISTINCT FROM guard suppressed the update.
- DELETE-and-reinsert children. See #SF2 for the wrinkle.

`_filter_resumable` (load:528–546): see #SF1.

The CLI exposes the right flags. Exit codes are distinct (2 for arg errors,
3 for resume-without-checkpoint, 4 for other loader errors). The logging
format auto-detects TTY vs pipe — small touch, nice.

### Tests

Parser tests cover the variation matrix (8 valid + 1 malformed) with a
hand-crafted fixture that's clearly commented. Model-level invariants
(duplicate sense_index, missing sense 1, oversized headword, extra fields,
unknown register coerced to None) all tested directly via Pydantic.

Loader tests are honest about their layers: unit tests (pure Python, no DB)
for batching/resume-filtering/SHA-256/CLI; integration tests marked `@pytest.mark.pg`
that skip cleanly when `KRDICT_TEST_DATABASE_URL` is absent. The integration
tests cover idempotency AND resume — the two contracts the SENIOR_ENGINEER_BAR
calls out by name.

Gaps:
- No test catches the #SF2 child-churn behavior (the idempotency test only
  checks row counts, which are preserved by delete-and-reinsert).
- No test exercises the #SF1 resume-marker-missing failure mode.
- `test_loader_resume_picks_up_where_it_left_off` asserts only the aggregate
  count, not that the specific entries 4..8 are present and 1..3 aren't
  duplicated. Fine for now; flag for tightening.

### Documentation

`KRDICT_README.md` covers download / license / running / verifying / gotchas
/ coordination. ADR-015/016/017 each explain a non-obvious decision (4
tables, XML over JSON, POS as TEXT+CHECK) and list alternatives considered.
ADR-016 in particular makes a strong case for defusedxml (vs lxml, vs stdlib
ET) that I'd want to cite the next time someone asks why we have a defusedxml
dependency.

---

## 5. Coordination notes

- **B3 (Darakwon loaders) shares this directory.** B2 namespaced everything
  `krdict_*` / `KRDICT_*` to avoid collision. That contract is held; no
  filename overlaps with B3's existing `parse_ttmik.py`, `load_to_postgres.py`,
  etc.
- **A1 (001 core schema) is the dependency.** 003 reuses `register_level`
  enum and `set_updated_at()` trigger function from 001 — confirmed present
  at 001_core_schema.up.sql:91 and :59. Down script correctly does NOT drop
  either.
- **A2 (002 Darakwon) is NOT a dependency.** 003 explicitly does not need 002
  per the header comment (003.up:7). Verified — no FKs to `corpus_sources`
  or any 002 table.
- **The `corpus_sources` sidestep (ADR-015 §D12) is the right call.** I'd
  have made the same one. The alternative (widening corpus enum or making
  it nullable) would have broken downstream invariants.
- **Future bridge to vocab_cards** (mentioned as out-of-scope in 003 header
  and ADR-015) needs the on-delete RESTRICT pattern from KRDICT side so user
  vocab data isn't orphaned by a re-ingest. Worth flagging that contract
  when that bridge migration lands.

---

## 6. Bottom line

This passes the senior bar with the caveats noted. The schema is right, the
parser is hardened, the loader is honest about its contracts and tested for
the two big ones. SF1 (resume cursor robustness) and SF2 (child-row churn
on no-op re-runs) are the two I'd want fixed before the first production
ingest of the real KRDICT archive — both are small (~10–30 lines) and would
prevent quiet wrong-behavior in conditions the test suite doesn't exercise.

Other should-fix items (#SF3-#SF6) are quality/correctness polish that won't
bite until they do.

Nothing here changes the conclusion that B2 produced solid work. Approve
after addressing SF1 and SF2; SF3–SF6 can land as a follow-up commit if
needed.
