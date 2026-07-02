# Review: TOPIK load — loader + model

**Reviewer:** Independent senior (did not author this code)
**Branch:** `topik-corpus-load-fixes` vs `rebuild`
**Scope reviewed:** `tools/ingest/loaders/load_topik.py`, `tools/ingest/loaders/models.py` (Topik* models + `StrictBase`)
**Corroborated against:** migrations 005 / 029 / 030, `runtime.py` helper signatures, and all 60 source JSONs under `tools/ingest/output/topik_*.json`.

## Summary verdict

**REQUEST CHANGES** — 1 BLOCKER, 4 SHOULD-FIX.

The core fixes this branch targets are implemented correctly: `short_answer` is present on both sides of the enum bridge, the `topik_tests` provenance upsert is byte-for-byte aligned with migrations 029/030, and `char_range` lands in `extra` correctly. The blocker is not in the new provenance/enum code itself but in a pre-existing safety net that this change leaves defanged: a count mismatch is only a warning, yet the loader still marks the source `complete` and stores its sha — so an incomplete or silently-deduped load is recorded as success and skipped on every future non-`--force` run. That is exactly the silent-overwrite class this branch's sibling data fix (level token in `source_id`) exists to prevent, so the net matters here more than usual. One additional real gap: `answers_verified_against` is populated in all 60 files, is modeled, and is dropped — the same provenance-loss bug the branch set out to fix, missed for one field.

## Bar checklist

| Bar item | Verdict | Note |
|---|---|---|
| §0 Robust by default (resume/idempotency) | PASS | Per-batch tx, resume via `last_item_id`, ON CONFLICT upserts. |
| §0 Fail loud / no silent swallow | **FAIL** | Count mismatch warns then marks complete (B1). |
| §1.2 No bare `Any` | **FAIL** | `answer`/`model_answer` typed `Any` (S2). |
| §1.3 Pydantic at I/O boundary; validate, don't drop | PARTIAL | Provenance now captured, but `answers_verified_against` still dropped (S1). |
| §1.8 No swallowed exceptions; mark_failed on error | PARTIAL | `mark_failed` covers item batches only, not the first tx (S3). |
| §4.7 Parameterized queries only | PASS | 100% `%s` binds; corpus pinned as literal; no interpolation. |
| §4.1 `jsonb` value objects, typed casts | PASS | `::jsonb` on passages/provenance/options/answer/extra; `::corpus`/`::topik_section`/`::topik_item_type`/`::proficiency_level` casts correct. |
| §4.6 Short, explicit tx boundaries | PASS | Catalog+provenance in one tx; item batches each own tx; matches ADR-019 D5. |
| ADR-019 D3 idempotency (natural-key upsert) | PASS | `(test_number, topik_level, section)` + `(corpus, source_id)`. |
| ADR-019 D8 counts assertion → non-zero exit | **FAIL** | Downgraded to `log.warning`, still returns `complete` (B1). |
| DRY / no redundant storage | PARTIAL | `skill_tag_raw` double-stored: own column + `extra` (S4). |

## Findings

### BLOCKER
- **B1** — Count-assertion mismatch is a warning, and the source is marked `complete` anyway → incomplete loads are recorded as success and silently skipped forever.

### SHOULD-FIX
- **S1** — `answers_verified_against` (set in all 60/60 files, modeled at `models.py:211`) is persisted nowhere. Provenance silently dropped — the exact bug class this branch fixes.
- **S2** — `answer: Any | None` / `model_answer: Any | None` (`models.py:132-133`) are bare `Any` at the boundary; violates bar §1.2 [P0].
- **S3** — `mark_failed` does not cover the first transaction (validation + `topik_tests` upsert); a failure there leaves no `failed` status / `last_error`.
- **S4** — `skill_tag_raw` is stored twice: dedicated column and inside `extra` — redundant and self-contradicting the `extra` comment.

### NIT
- **N1** — `_resolve_item_type` `options` parameter is unused (documented as reserved). Acceptable, but a `# noqa`-style reserved-arg is mild YAGNI.
- **N2** — `assert row is not None` (`load_topik.py:193`) uses `assert` for a runtime invariant; stripped under `python -O`. Prefer an explicit raise.

### PRAISE
- **P1** — `topik_tests` upsert is exactly aligned with the schema (see detail). Do not let a fix-pass "tidy" the cast list.
- **P2** — `short_answer` correctly added to BOTH the `Literal` (`models.py:171`) and `_TYPE_TO_DB_ENUM` (`load_topik.py:58`); all 9 Literal members have a mapping. Both sides consistent — the central fix, done right.
- **P3** — `provenance` built from non-null keys, always a dict → `json.dumps` → satisfies migration 030's `CHECK (jsonb_typeof(provenance) = 'object')` even when empty (`'{}'`).
- **P4** — Transaction structure matches ADR-019 D5; resume filter key == sort key == `last_item_id`, and the `original_size` pre-filter (line 209) correctly avoids over-counting skipped items.

---

## Detailed findings

### B1 (BLOCKER) — mismatch warns, then marks complete → silent, self-hiding data loss

`load_topik.py:248-257`

```python
if actual != total_items:
    log.warning("count_assertion_mismatch", expected=total_items, actual=actual)

async with pool.connection() as conn:
    async with conn.transaction():
        await mark_complete(conn, corpus=CORPUS, source_path=str(source_path))
```

Two problems compound:

1. **ADR-019 D8 is explicit:** *"Loader exits non-zero if the assertion fails so CI catches drift."* Here the mismatch is a `log.warning` and the function returns `status="complete"`. CI/orchestrator sees success.
2. **The mismatch path still calls `mark_complete`.** `mark_in_progress` already stored `source_sha256=sha` (line 122-128); `mark_complete` flips status to `complete`. So the next run hits the skip guard at `load_topik.py:119` (`status == "complete" and source_sha256 == sha and not force`) and skips the file. A load that dropped rows is now permanently invisible until someone thinks to pass `--force`.

Why this bites *this* corpus specifically: one file = one `(test_number, topik_level, section)` → one `topik_test_id` → the `SELECT COUNT(*) … WHERE topik_test_id = %s` (line 243) should equal `total_items` *exactly*. Any deviation is a real defect — duplicate OCR `source_id`s collapsing under the `(corpus, source_id)` upsert, or the very cross-level `source_id` collision the branch's data fix (level token) addresses. The count assertion is the runtime backstop for that collision; downgrading it to a warning removes the backstop at the same moment the schema change relies on it.

**Fix:** on `actual != total_items`, do NOT `mark_complete`; raise so the `except` at line 265 runs `mark_failed` (recording `last_error`) and the process exits non-zero, per D8. If a legitimate mismatch case is ever discovered, encode it explicitly rather than blanket-warn.

### S1 (SHOULD-FIX) — `answers_verified_against` modeled but dropped for all 60 files

`load_topik.py:150-158`, model at `models.py:211`

The provenance dict captures only `note`, `transcript_available`, `transcript_source`:

```python
provenance = {
    k: v for k, v in {
        "note": doc.source.note,
        "transcript_available": doc.source.transcript_available,
        "transcript_source": doc.source.transcript_source,
    }.items() if v is not None
}
```

`TopikSourceModel.answers_verified_against` (`models.py:211`) is set in **60/60** source files (verified) and is written to no column, no `provenance`, no `corpus_sources` field — it is silently dropped by nothing more than omission. For a test-prep corpus, *which answer key the answers were verified against* is arguably the highest-value provenance field of the four. This is the same "extra/omission drops provenance" defect the branch exists to close; it was fixed for three fields and missed for the fourth. Add `"answers_verified_against": doc.source.answers_verified_against` to the provenance dict (it survives the `is not None` filter and the migration-030 `object` CHECK unchanged).

### S2 (SHOULD-FIX) — bare `Any` on `answer` / `model_answer`

`models.py:132-133`

```python
answer: Any | None = None         # int or object (writing)
model_answer: Any | None = None
```

Bar §1.2 [P0]: *"No bare `Any`… if unavoidable use a narrowed union and justify."* Observed shapes across all 60 files: `answer` ∈ {int, null}; `model_answer` ∈ {dict, str, null}. Bare `Any` means the Pydantic boundary validates nothing here — a malformed `answer` (e.g. a stray string where an option index is expected) passes straight through to `json.dumps` and into `topik_items.answer` jsonb. Tighten to `answer: int | None` and `model_answer: dict[str, Any] | str | None` (or a small tagged model). This is the whole point of having Pydantic at the boundary (ADR-019 D6).

### S3 (SHOULD-FIX) — `mark_failed` does not cover the first transaction

`load_topik.py:107` (validation), `114-194` (catalog + provenance tx), `198-275` (try/except)

The `try/except` that calls `mark_failed` begins at line 198 — after `TopikDocumentModel.model_validate_json` (107) and after the `topik_tests` upsert tx (114-194). If validation raises, or the `topik_tests` INSERT/`fetchone` fails, the exception propagates with **no** `load_state` row marked `failed` and no `last_error` recorded. ADR-019 D4 leans on `status == 'failed'` + `last_error` for operator triage; those failure modes bypass it. (Mitigations: the exception still halts the run loudly, and because `mark_in_progress` shares the failing tx it rolls back cleanly — state stays consistent, just unannounced in `load_state`.) Wrap the first tx in the same failure-recording path, or hoist the `try` to include it.

### S4 (SHOULD-FIX) — `skill_tag_raw` double-stored

`load_topik.py:298-305` (into `extra`) vs `315` + column list `336` (dedicated column, DDL `005:387 skill_tag_raw TEXT`)

```python
extra = {
    k: v for k, v in {
        "skill_tag_raw": it.skill_tag_raw,   # <- also its own column
        "char_range": it.char_range,
    }.items() if v is not None
}
```

The `extra` comment states it is the catch-all for source data "with **no** dedicated column" — but `skill_tag_raw` has one (written at line 315). Storing it in both places is redundant and, on any future divergence in the two write paths, a source of quiet inconsistency between `topik_items.skill_tag_raw` and `topik_items.extra->>'skill_tag_raw'`. Drop `skill_tag_raw` from `extra`; keep `char_range` (which correctly has no column).

---

## Coordination observations

- **Migration alignment is exact and worth stating.** `topik_tests` INSERT (`load_topik.py:164-190`): 10 columns, 10 placeholders, 10 params. `topik_level` is `TEXT` in DDL (`005`) → correctly no cast; `section` → `::topik_section`; `passages`/`provenance` → `::jsonb`; `corpus` → `::corpus`. `ON CONFLICT (test_number, topik_level, section)` matches `uq_topik_tests_number_level_section` added by migration 029 (which dropped the old two-column key). `provenance` is always a dict → migration 030's `NOT NULL` + `CHECK jsonb_typeof = 'object'` are both satisfied, including the empty `'{}'` case. No drift between loader and schema.
- **`extra="ignore"` is currently dropping nothing else.** Scanned all 60 files: top-level keys are exactly `{source, passages, items}`; every source key and every item key is present in the models. The only silent loss is S1 (`answers_verified_against`), which is *modeled but not persisted* — a loader omission, not a model gap. If new OCR passes add keys, `extra="ignore"` will silently swallow them at the source level (there is no `extra` escape hatch on `TopikSourceModel` the way there is on `topik_items`); worth a note to the parser owners.
- **Enum bridge is complete both directions.** All 9 `Literal` members (`models.py:170-180`) have a `_TYPE_TO_DB_ENUM` entry (`load_topik.py:56-69`); every mapping target (`short_answer_blanks`, `chart_description`, `essay`, `multiple_choice`) is a real `topik_item_type` member (DDL `005:42-49`). `_resolve_item_type`'s fall-through-to-`multiple_choice` on an unmapped-but-non-null type is defensively correct and unreachable while the Literal and map stay in sync — keep them in sync in one place if this grows.
- **The 12 writing docs / 48 writing items now load** by construction: `short_answer` accepted at the model boundary (was the hard-fail) and collapsed to `short_answer_blanks` for the NOT-NULL `item_type` column. Recommend the resume/idempotency integration test (ADR-019 D10) add a writing fixture with a `short_answer` item and non-empty `char_range` + `note`/`answers_verified_against` so B1/S1 regressions are caught by CI, not by inspection.
