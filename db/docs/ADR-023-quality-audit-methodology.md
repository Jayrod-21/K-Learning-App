# ADR-023: Darakwon extraction quality audit methodology

**Status:** Accepted
**Date:** 2026-05-28
**Owner:** Phase C — Audit
**Depends on:** ADR-008 (KGIU vs grammar entries), ADR-019 (loader orchestration)

## Context

Five Darakwon JSONs power large slices of the app:
- `grammar_kgiu_beginner.json` (KGIU Beginner)
- `grammar_kgiu_intermediate.json` (KGIU Intermediate — extracted from
  4 PDF slices)
- `grammar_kgiu_advanced.json` (KGIU Advanced — agents reported
  intermittent page-rendering gaps)
- `vocab_2000_beginner.json` (2000 Words Beginner — Theme 15 retried
  after the original agent hit a session-budget cap)
- `vocab_2000_intermediate.json` (2000 Words Intermediate)

All five were written by Claude vision OCR via parallel subagents per
the prompts in `docs/_*_extraction_guide.md`. Quality is expected to
be good but is not guaranteed — every subagent flagged at least one
class of concern in its final report.

Downstream features (SRS scheduling, TOPIK study mode, grammar bank,
tap-to-mine) all assume the data is correct at the field level.
Loading a known-broken corpus would manifest as user-visible bugs we
have no easy way to diagnose ("why is `가족`'s Hanja `家人`?").

We therefore need a **measurable, reproducible** quality bar BEFORE
the loaders ingest these JSONs into Postgres.

## Decision

Implement a read-only audit harness — `tools/ingest/audit_darakwon.py`
plus tests, README, and this ADR — that:

1. Draws a **deterministic stratified random sample** at a chosen rate
   per corpus (default 5%).
2. For each sampled entry, re-OCR's the source PDF page(s) with Claude
   vision and compares the freshly-extracted view to the JSON entry.
3. Classifies each comparison on a 4-level severity scale.
4. Produces a human report (Markdown), a machine triage file (CSV),
   and a 95% Wilson confidence interval on the population PASS rate.

The audit is intentionally **read-only**: it never mutates the JSON.
Fixing flagged entries is a separate, follow-up workflow driven by
the triage CSV.

## Decisions

### D1. Sampling rate = 5% per corpus

**Decision:** Default to 5%, configurable via `--rate`.

**Rationale:** at 5% across a ~3,400-entry population (~170 audited
items) and an expected PASS rate around 90–95%, the Wilson 95% CI is
roughly ±3.5pp. That's tight enough to distinguish "great" (95%+) from
"need a re-extraction pass" (<85%) but small enough that the audit
finishes in an evening and the cost (Claude vision OCR is expensive
per page) is bounded.

**Alternatives considered:**
- 1% (~35 items): CI ±7pp — too wide to make load/don't-load decisions.
- 10% (~340 items): CI ±2.5pp — but 2× the runtime/cost for marginal
  gain. We can always raise the rate selectively for a corpus that
  fails the first pass.
- Stratified 5% with a minimum per stratum: our final choice. Ensures
  every chapter / theme is represented at least once so a single bad
  chapter cannot hide.

### D2. Stratify by chapter (KGIU) / theme (vocab)

**Decision:** Bucket items by the natural pedagogical unit before
sampling so coverage is even, then `max(1, ceil(rate × |stratum|))`
items per bucket.

**Rationale:** the failure modes we expect are **clustered**: one
subagent's slice goes wrong, one chapter's pages didn't render. A
naive uniform random sample would over-sample large strata and could
miss a small but broken one entirely. Stratifying guarantees every
unit has a chance to surface.

### D3. Severity taxonomy: PASS / MINOR / MAJOR / MISSING

| Severity | Meaning | Action |
|---|---|---|
| `PASS` | Found matches expected (after NFC + whitespace normalization). | None. |
| `MINOR_DISCREPANCY` | Values differ but are equivalent for users — punctuation, paraphrased gloss, Korean text identical but romanization differs. | Aggregate; fix in batches if a clear pattern emerges. |
| `MAJOR_DISCREPANCY` | Critical field values are materially different (wrong pattern, wrong Korean headword, wrong POS). | Per-entry hand fix or targeted re-extract. |
| `MISSING_DATA` | A field that should be present according to the OCR view is absent / null in the JSON. | Targeted field re-extraction from the listed pages. |

Critical fields are the ones whose value drives downstream behavior:
- KGIU: `pattern`, `explanation`, `examples`
- Vocab: `korean`, `english`, `part_of_speech`

Formatting-class fields (`category`, `pronunciation`, `audio_track`,
`register`, `domain`, `irregular_class`, `case_marker`) downgrade
mismatches to MINOR even if listed as critical — these often differ
between OCR runs and aren't user-visible bugs.

### D4. Deterministic + idempotent

**Decision:** Sampling takes a seed (default `20260528`). Same seed +
same source JSON ⇒ same sample (asserted in tests).

**Rationale:** before/after-fix audits must be directly comparable. If
the second pass samples different items, the PASS rate change conflates
"we fixed things" with "we audited different things". Determinism lets
us re-run with the same seed and compare like-for-like.

### D5. Prompt caching for OCR

**Decision:** Use Anthropic SDK ephemeral prompt caching on the system
prompt + page image. PDF pages are also held in an in-process cache
keyed by `(pdf_path, pdf_page)`.

**Rationale:** many KGIU grammar points span 2–4 pages, and pages often
contain multiple sampled entries when stratification picks neighbors.
Without caching we'd re-send the same page bytes to the API repeatedly.
With caching, only the per-entry question varies; the bulk of the
request hits the cache.

### D6. Read-only, separate from the loaders

**Decision:** The audit script does NOT write to the corpus JSONs or
Postgres. Fixes are a follow-up driven by `AUDIT_TRIAGE.csv`.

**Rationale:** mixing read and write in one tool invites the audit
masking its own findings. A separate fix workflow keeps the audit
trustworthy and gives us a chance to review every change.

### D7. Sample / compare / report are separate subcommands

**Decision:** `sample` (offline, fast), `compare` (network, expensive),
`report` (offline, fast) are independent CLI commands sharing artifact
files on disk.

**Rationale:**
- The sample manifest is reviewable before we burn API budget.
- A `compare` interrupted by network failure can be resumed (re-run
  with the same manifest).
- The report step can be re-rendered without re-running OCR.
- Tests exercise each step independently.

## Consequences

### Positive
- Quantified data quality before downstream features depend on it.
- Reproducible audits — same seed gives same sample.
- Triage CSV plugs straight into a follow-up fix script.

### Negative
- The compare step requires network + an API key, so it doesn't run
  in the same sandbox where we develop the script. We address this by
  making `sample` and `report` fully offline and recording a
  `skipped_no_network` ocr_method when the SDK isn't available.
- Wilson CI at n≈170 gives ±3.5pp at most; not tight enough to
  distinguish 90% from 92%. For decisions at that precision, bump
  `--rate` for the affected corpus and re-audit.
- We classify, but we don't authoritatively prove "the OCR was right"
  — the audit asks Claude to OCR the page again. Two-agent agreement
  is strong evidence but not certainty. For entries flagged MAJOR by
  the audit, hand-review the page before re-extracting.
- **OCR prompt is BLIND (no audited values in the user message).** The
  initial implementation included the JSON values in the prompt
  ("Fields on the JSON to verify: {...}"), which anchored the model
  toward confirming what the agent already wrote — a form of
  self-confirmation bias on the "second opinion." The fixed
  implementation sends only the field NAMES; the model must read
  values off the page image. `score_entry` then performs the
  comparison against the JSON as a separate, value-aware step.
  Regression test:
  `test_vision_client_does_not_leak_audited_values_into_prompt`.
  (REVIEW_C3 F2, 2026-05-28.)

### Follow-ups
- After the first audit run, decide per-corpus whether to (a) accept
  and proceed to load, (b) hand-fix the triage list, or (c) re-extract
  the corpus. The decision belongs in the README of whatever loader
  picks up next.
- If a recurring field-level pattern shows up (e.g. all `audio_track`
  values dropped in vocab Intermediate Themes 8–12), write a targeted
  re-extract script for just that field — cheaper than a full re-run.

## Test plan

Captured in `tools/ingest/tests/test_audit_darakwon.py`:
- Parametric tests for `classify_field_discrepancy` covering each
  severity-emitting branch.
- Determinism test: same seed ⇒ same sample.
- Coverage test: at very low rate, every stratum still gets ≥1 entry.
- Wilson CI spot-checks (n=0, 100/100, 90/100, 50/100).
- Snapshot fixture (`fixtures/audit_snapshot.json`) of 4 hand-curated
  audit cases asserting the classifier returns the expected verdict —
  this is the closest we can get to a unit test of the
  semantically-noisy "is this Korean text equivalent" question without
  invoking the live vision model.
