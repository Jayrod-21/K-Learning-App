# Darakwon Extraction Audit Report

- Generated: 2026-05-28 (structural pass only; vision-OCR pass pending)
- Sample seed: `20260528`
- Sample rate: 5%
- Sample size: 173 entries (target — see "Sampling plan" below)
- Pipeline: `audit_darakwon.py {sample,compare,report}` per
  [ADR-023](../../db/docs/ADR-023-quality-audit-methodology.md)

## Run status

The vision-OCR comparison step (`audit_darakwon.py compare`) requires
network access + an Anthropic API key, which is **not available in the
build sandbox**. To produce useful findings now, this report contains:

1. **Structural / offline findings** — full-corpus, every entry. These
   are the schema-fidelity issues we can detect without re-OCR-ing the
   source PDFs.
2. **Sampling plan** — population & per-corpus sample size for the
   vision-OCR pass when an operator runs it.
3. **Operator runbook** — exactly how to extend this report once the
   vision pass has been run.

See `AUDIT_README.md` §"Running an audit" for the three-command
procedure.

## Sampling plan (vision-OCR pass)

| Corpus | Population | Sample (~5%, stratified) | Strata |
|---|---:|---:|---|
| kgiu_beginner | 143 | 8 | 24 units + intros + appendix |
| kgiu_intermediate | 120 | 6 | 26 chapters + intros |
| kgiu_advanced | 107 | 6 | 22 chapters + intros |
| vocab_beginner | 1580 | 79 | 15 themes |
| vocab_intermediate | 1551 | 78 | 14+ themes |
| **TOTAL** | **3501** | **177** | |

Because we stratify with a `max(1, ceil(rate × |stratum|))` floor, the
KGIU corpora actually draw slightly more than 5% (every chapter /
unit is represented at least once). This is a coverage-over-fidelity
trade-off — see ADR-023 §D2.

At n = 177 and an expected PASS rate of ~92%, the 95% Wilson CI is
roughly **±4.0 pp**. That's tight enough to make load/don't-load
decisions per corpus.

## Per-corpus structural findings (full population, offline)

These are issues `audit_darakwon.py structural --corpus all` will
surface on every entry, no network required.

| Corpus | Pop | PASS | MINOR | MAJOR | MISSING |
|---|---:|---:|---:|---:|---:|
| kgiu_beginner | 143 | 143 | 0 | 0 | 0 |
| kgiu_intermediate | 120 | 120 | 0 | 0 | 0 |
| kgiu_advanced | 107 | 107 | 0 | 0 | 0 |
| vocab_beginner | 1580 | 1206 | 374 (POS + audio_track) | 0 | 0 |
| vocab_intermediate | 1551 | 1351 | 200 (POS + audio_track) | 0 | 0 |
| **TOTAL** | **3501** | **2927** | **574** | **0** | **0** |

Headline: **no MAJOR or MISSING structural issues**. Every grammar
entry has its required critical fields (pattern, explanation,
examples). Every word entry has Korean + English. No duplicate IDs
in any corpus. Every entry records `source_pages` (intros include
the divider page; grammar/word entries include all spanned pages).

The per-corpus MINOR column above is the EXACT count
`structural_audit(corpus_key)` emits as of this revision. The two
contributing checks are:

  * Composite POS values (`"noun, adverb"` / `"noun/adverb"`) —
    Beginner 16, Intermediate 11. See *Pattern 1* below.
  * Missing `audio_track` on a word entry — Beginner 358,
    Intermediate 189. See *Pattern 2* below.

(REVIEW_C3 F1: pre-fix, the structural pass only emitted the POS
MINORs (16 + 11 = 27) and the audio_track gap surfaced only in
prose. The numbers in the table above were the SUM but the code
didn't produce them, so the table was unreproducible. The fix is
to extend `structural_audit()` to emit a MINOR for missing
`audio_track` on word entries — the table is now mechanically
reproducible by running `audit_darakwon.py structural --corpus all`.)

## Cross-corpus patterns

### Pattern 1 — composite POS values written as TEXT instead of ENUM

| Corpus | Composite POS count | Example |
|---|---:|---|
| vocab_beginner | 16 | `"part_of_speech": "noun, adverb"` |
| vocab_intermediate | 11 | `"part_of_speech": "noun/adverb"` |

These are the schema-fidelity calls flagged in the agents' own reports:
some words (e.g., `내일`, `오늘`, `당분간`) genuinely function as both
nouns and adverbs and the source book marks them with two POS circles.
The agents chose to preserve the dual marking as a text string rather
than pick one for the enum.

**Note:** the two vocab books use **different separators** for the
composite POS — Beginner uses `","` (`"noun, adverb"`), Intermediate
uses `"/"` (`"noun/adverb"`). This inconsistency between sibling
extractions is itself a finding.

**Action:** the loader (`load_vocab_2000.py`) should pick a canonical
representation — either (a) store the primary POS in `part_of_speech`
and the secondary in a new `pos_secondary` column, or (b) store the
list in `part_of_speech_alternates` JSONB. ADR-008 already left room
for stable_cols vs JSONB tradeoff.

### Pattern 2 — `audio_track` field missing on ~24% of vocab Beginner words

| Corpus | word entries | with audio_track | without |
|---|---:|---:|---:|
| vocab_beginner | 1486 | 1128 | 358 (~24%) |
| vocab_intermediate | 1460 | 1271 | 189 (~13%) |

`audio_track` is documented in the extraction guide as one field per
word entry. The Beginner book groups multiple words per audio track
(one per page), so the source agent may have only set it on the first
word of each track, or on the word that explicitly displays the track
banner. Need to verify on the OCR pass whether the missing audio_track
values are (a) genuinely absent on the printed page (track ribbon only
appears on the first word) or (b) silently dropped during extraction.

**Action:** flag for the OCR pass — pull a sample of `audio_track=null`
entries and check the printed page. If the track ribbon is page-level,
not entry-level, then this is a schema modelling issue (audio_track
belongs on a `theme_audio` table indexed by page), not an extraction
bug.

### Pattern 3 — known field-level discrepancy (eyeball find)

`vocab-beg-0002` (Korean: `가족`, English: "a family"):
- `hanja`: `"家人"` ❌ — should be `"家族"` (matches the Japanese gloss
  `家族` on the same entry)

This was caught by direct inspection while writing the audit script.
The wrong hanja is structurally valid (it's a real word: 家人 = family
member in Chinese) but doesn't match the printed source book. Listed
in `AUDIT_TRIAGE.csv` as a MINOR (hanja is not a critical field per
ADR-023 §D3) and as a single test case in
`tests/fixtures/audit_snapshot.json`.

The OCR pass should turn up more of these — single-character hanja
mistakes are a high-probability OCR failure mode.

## Recommendations

### Immediate (no further audit needed)
1. **Fix `vocab-beg-0002.hanja`** — single character edit, listed in
   `AUDIT_TRIAGE.csv`.
2. **Normalize composite POS** in the loader rather than the source —
   pick a separator (`/` per the Intermediate convention is more
   conventional in linguistics) and split into a primary + secondary
   POS at load time. Don't re-extract.

### Run the vision-OCR pass when an operator has network + key
```bash
export ANTHROPIC_API_KEY=...
cd Repository/tools/ingest
python audit_darakwon.py sample --seed 20260528 --rate 0.05
python audit_darakwon.py compare \
    --manifest audit_artifacts/sample_manifest.json
python audit_darakwon.py report \
    --manifest audit_artifacts/sample_manifest.json \
    --results audit_artifacts/comparison_results.json
```

The report subcommand will **overwrite** this file with the
combined structural + OCR findings (it re-renders from the results
JSON, not from this Markdown), so this offline version is safe to
keep as the baseline.

### Audit-the-audit
After the OCR run, hand-check 3–5 entries the audit marked PASS to
confirm the OCR step isn't merely agreeing with itself. If a hand
check finds an error the audit missed, tighten the
`classify_field_discrepancy` heuristics.

## Confidence interval methodology

Per ADR-023 §D1, we report the **Wilson 95% CI** on the population
PASS rate (better-behaved than the normal-approximation interval at
the small samples + extreme proportions we expect). The interval is
computed by `audit_darakwon.wilson_ci()` and is unit-tested with
spot-checks at n=0, n=100×{0.5, 0.9, 1.0} (see
`tests/test_audit_darakwon.py`).

When the audit is run with seed `20260528` and rate 0.05, n ≈ 177;
a 92% observed PASS rate would give a 95% CI of roughly
**[87.2%, 95.4%]** — wide enough that the difference between "load"
and "re-extract" needs an observed PASS rate around 88% or below
before we'd reject the corpus outright.
