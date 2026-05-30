# Darakwon extraction audit — operator runbook

Audits the five Darakwon JSONs against their source PDFs via Claude
vision OCR. See [`db/docs/ADR-023`](../../db/docs/ADR-023-quality-audit-methodology.md)
for the methodology.

## What this tool does

For each Darakwon corpus, draw a deterministic stratified random
sample (~5%), re-OCR the source PDF pages for each sampled entry,
compare the freshly-extracted view to the entry written by the
original extraction agent, and produce:

- `AUDIT_REPORT.md` — per-corpus PASS rate + Wilson 95% CI + the
  specific entries that need fixing
- `AUDIT_TRIAGE.csv` — machine-readable list of every flagged
  discrepancy, one row per `(entry, field)`
- `audit_artifacts/sample_manifest.json` — the reproducible sample
- `audit_artifacts/comparison_results.json` — raw per-entry scoring

It is **read-only**. Fixing the flagged entries is a separate workflow
driven by the triage CSV.

## Setup

Requires Python 3.11+. Install dependencies from the repo's existing
environment (they're already used by other ingest tooling):

```bash
pip install anthropic pydantic structlog pymupdf
```

Set the API key:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

The audit script also runs in **offline mode** without the SDK / key —
it just records `ocr_method="skipped_no_network"` for every entry
instead of doing the vision call. Useful for testing the sampling and
reporting plumbing without burning API budget.

## Running an audit (three steps)

### 1. Sample (offline, instant)

```bash
cd Repository/tools/ingest
python audit_darakwon.py sample \
    --seed 20260528 \
    --rate 0.05 \
    --output audit_artifacts/sample_manifest.json
```

Inspect `audit_artifacts/sample_manifest.json` before proceeding —
it lists every entry the next step will audit, with stable
`json_index` + `sha256_short` so you can verify the sample is
reproducible across machines.

### 2. Compare (network + API key — this is the expensive step)

```bash
python audit_darakwon.py compare \
    --manifest audit_artifacts/sample_manifest.json \
    --output audit_artifacts/comparison_results.json
```

Useful flags:
- `--limit N` — only audit the first N entries (smoke test).
- `--model claude-opus-4-5-20250929` — pick a different vision model.
- `--dry-run` — skip the API call; emit `skipped_no_network` results
  for every entry (sanity-check the pipeline without spending money).

Cost: at ~170 sampled entries × ~3 pages each × Opus 4.5 vision
pricing, expect a few dollars per full audit. Prompt caching halves
the per-page cost when neighbours share a page.

> **Blind extraction (REVIEW_C3 F2).** The compare step sends the
> model only the FIELD NAMES from the JSON, not the values. The model
> has to extract the values from the page image and our scoring code
> compares them against the JSON afterward — a real second opinion,
> not a "do you agree with what I wrote?" anchor. ADR-023's "Negative
> consequences" section documents this in more depth.

### 3. Report (offline, instant)

```bash
python audit_darakwon.py report \
    --manifest audit_artifacts/sample_manifest.json \
    --results audit_artifacts/comparison_results.json \
    --report-out AUDIT_REPORT.md \
    --triage-out AUDIT_TRIAGE.csv
```

Open `AUDIT_REPORT.md` for the headline stats; hand `AUDIT_TRIAGE.csv`
to the follow-up fix process.

## What to do with the findings

Per ADR-023 §"Consequences / Follow-ups":

1. **Overall PASS rate ≥ 95%** — accept as-is, proceed to load.
2. **Overall PASS rate 85–95%** — load, but file the MAJOR list as
   tickets for hand-fix; the long tail of MINORs can be ignored unless
   a clear systematic pattern emerges.
3. **PASS rate < 85%, isolated to one corpus** — re-extract that
   corpus and re-run the audit with the same seed.
4. **Recurring field-level pattern across corpora** (e.g. all
   `hanja` values off by one) — write a targeted re-extract script
   for the single field rather than re-running everything.

## Re-auditing after fixes

Use the **same seed** (`--seed 20260528`) when you re-audit so the
before/after PASS rates are directly comparable. Different seeds will
draw a different sample and conflate "we fixed things" with "we audited
different things".

## Testing

```bash
cd Repository/tools/ingest
pytest tests/test_audit_darakwon.py -v
```

The tests exercise the pure scoring functions, sampling determinism,
the Wilson CI helper, and the snapshot fixture in
`tests/fixtures/audit_snapshot.json` (5 hand-curated audit cases).
The vision-OCR call itself is not exercised by tests — it's
non-deterministic and would require network — but the wrapper
(`VisionOcrClient`) degrades gracefully when the SDK / key is absent.

## Files

```
tools/ingest/
├── audit_darakwon.py            # main audit script (sample / compare / report)
├── AUDIT_README.md              # this file
├── AUDIT_REPORT.md              # written by `report` subcommand
├── AUDIT_TRIAGE.csv             # written by `report` subcommand
├── audit_artifacts/             # sample + comparison JSONs (gitignored-ish)
└── tests/
    ├── test_audit_darakwon.py
    └── fixtures/
        └── audit_snapshot.json  # 5 hand-curated comparison cases
```
