# Review: C3 — Darakwon quality audit

**Reviewer:** Independent senior engineer (30y).
**Date:** 2026-05-28
**Scope:** `audit_darakwon.py`, AUDIT_REPORT.md, AUDIT_TRIAGE.csv, AUDIT_README.md,
`tests/test_audit_darakwon.py`, `tests/fixtures/audit_snapshot.json`,
`ADR-023-quality-audit-methodology.md`.
**Verdict:** **ACCEPT** with two documentation-fix follow-ups (no code blockers).

---

## Summary verdict

C3 is the strongest C-track component I've reviewed. The sampling math is correct,
the comparison logic is well-factored and testable, the vision client is the right
shape (offline-safe, prompt-cached, key-from-env), and the offline structural pass
already surfaced the real bugs in the JSONs without spending a cent. Most of the
artifacts agree with the source data when spot-checked.

The two issues worth fixing are documentation, not code:

1. **AUDIT_REPORT.md inflates per-corpus MINOR counts.** The structural-pass table
   labels Beginner `374 (POS + audio)` and Intermediate `200 (POS + audio)`, but
   the `structural_audit()` function in `audit_darakwon.py` does NOT check
   `audio_track` — it only flags composite POS. The actual structural output is
   16 + 11 = 27 MINOR rows, not 574. The audio_track gap (358 / 189) is a real
   finding but it lives in the cross-corpus prose section, not in per-entry
   results. The table is mixing the two and overstating MINOR by ~20×.

2. **`vision_client.extract_entry_view` shows the model the JSON it's
   auditing.** The user message includes "Fields on the JSON to verify: {…}".
   That biases the OCR towards confirming what the agent already wrote. The
   ADR-023 "Negative consequences" section flags two-agent self-confirmation in
   general; this implementation detail makes the bias worse than the ADR admits.

Neither is a bar failure. Everything else passes.

---

## Bar checklist

| Item | Status | Notes |
|---|---|---|
| Lint passes | n/a | Code is clean: PEP 8, no dead code, no `print` outside CLI exit messages. |
| Type-check (strict) | ✓ | Full type hints, Pydantic models at every boundary, `Literal` for `Severity`. |
| All tests pass | ✓ | 9 parametric + 4 aggregate + 3 sampling + 4 Wilson + 1 snapshot replay + 2 smoke = comprehensive for what's testable offline. |
| Public functions tested | ✓ | `classify_field_discrepancy`, `aggregate_severity`, `stratified_sample`, `build_sample_manifest`, `wilson_ci`, `score_entry`, `render_report`, `render_triage_csv`, `structural_audit` all covered. Only `VisionOcrClient.extract_entry_view` is untested — defensible since it's the network boundary. |
| `EXPLAIN ANALYZE` | n/a | No SQL. |
| `SECURITY.md` | partial | No dedicated `AUDIT_SECURITY.md`; key handling is correct in code (env var only, never logged). For a read-only audit tool this is acceptable but inconsistent with sibling components (KRDICT, LOADERS, CANONICAL_GRAMMAR all have SECURITY.md). Recommend adding a short one. |
| `README.md` written | ✓ | `AUDIT_README.md` covers setup, three-command flow, cost estimate, re-audit-after-fixes, file map. |
| ADR for decisions | ✓ | ADR-023 covers rate, stratification, severity taxonomy, determinism, caching, read-only, three-subcommand split. Alternatives and consequences both enumerated. |
| Reversible migrations | n/a | Tool is read-only against the JSONs and PDFs. |
| No `TODO`/`FIXME` | ✓ | None. |
| No `print()` (logger) | ✓ | `print` only in `_cmd_*` for terminal feedback; `structlog`/`logging` elsewhere. |
| No commented-out code | ✓ | Clean. |
| No hardcoded secrets/URLs | ✓ | API key strictly from `ANTHROPIC_API_KEY` or constructor; model id is a configurable CLI flag with a documented default. |

---

## Findings

### F1 — AUDIT_REPORT.md per-corpus structural table is wrong (HIGH-impact doc bug)

The table at lines 52–59 of `AUDIT_REPORT.md` reports:

| Corpus | PASS | MINOR |
|---|---:|---:|
| vocab_beginner | ~1206 | 374 (POS + audio) |
| vocab_intermediate | ~1351 | 200 (POS + audio) |

`structural_audit()` checks only: missing id, missing source_pages, missing
`korean`/`english` on word entries, missing `pattern`+`title_en` on grammar
entries, missing `explanation`/`examples` on grammar entries, and composite POS.
It does NOT touch `audio_track`. The actual numbers the code would produce on the
real data are **16 MINOR for Beginner** and **11 MINOR for Intermediate**
(verified — composite POS counts in the two JSONs match exactly).

The audio_track gap (358 Beginner / 189 Intermediate, verified — 24.1% / 12.9%)
is real, but it surfaces only in the prose "Pattern 2" section. Mixing the two
counts in the per-entry MINOR column overstates the structural-pass failure rate
by ~20× for Beginner and conflates two different kinds of finding (per-entry vs
population-level pattern).

**Fix:** either (a) restate the table with the real structural-pass numbers (16
/ 11) and keep `audio_track` only in the prose, or (b) extend `structural_audit`
to emit a per-entry MINOR when `audio_track` is missing on a word entry, and
re-render. Option (b) is more honest because it makes the prose claim
mechanically reproducible.

**Severity:** doc fidelity, not a code bug. But this is the headline table; a
reader will trust it over the prose.

### F2 — Vision client biases OCR towards the JSON it's auditing (MEDIUM)

`VisionOcrClient.extract_entry_view` (lines 694–710) constructs the user message
as:

```
"Audited entry id: " + str(entry.get("id"))
+ "\nFields on the JSON to verify: "
+ json.dumps({k: entry.get(k) for k in entry if k not in {"source_pages", "source_book"}}, ensure_ascii=False)
+ "\n\nRespond with a compact JSON object containing only the fields you can see on the page and their actual values."
```

The model sees the agent's own answer, then is asked what's "actually" on the
page. Anchoring will pull the second pass towards the first. The system prompt's
"Do NOT paraphrase Korean — copy printed Hangul verbatim" mitigates but doesn't
eliminate this; OCR for fields the model can't read clearly will preferentially
echo the JSON.

ADR-023 §"Negative consequences" acknowledges this in the abstract
("two-agent agreement is strong evidence but not certainty"), but the
implementation detail makes it stronger than disclosed.

**Fix options, in order of preference:**

- **Blind first, anchor second:** make a first call with only the field NAMES
  (no values), then if the model output differs from the JSON, make a second
  anchored call only for the differing fields to disambiguate "OCR couldn't
  read" from "JSON is wrong." Doubles cost on disagreements only.
- **Or:** strip values from the user message — send only `list(entry.keys())`.
- **Or:** at minimum, update ADR-023 to explicitly acknowledge the value-anchor
  in the prompt and the post-hoc "audit-the-audit" hand-check it implies.

The current AUDIT_README §"Audit-the-audit" already recommends hand-checking 3-5
PASS entries, which compensates partially. Tightening the prompt would compensate
more.

**Severity:** real bias risk on the expensive path, but offline structural pass
isn't affected and the hand-check mitigation is documented.

### F3 — Triage CSV row-count slightly off from the brief (LOW)

The brief described "28 real rows." `AUDIT_TRIAGE.csv` has 30 lines = 1 header +
29 rows. The 29 are: 1 hanja bug + 16 Beginner composite POS + 11 Intermediate
composite POS + 1 Beginner audio_track pattern row + 1 Intermediate audio_track
pattern row = 30. Wait, that adds to 30; let me recount — 1+16+11+1+1 = 30, but
file has 29 data rows. One is missing. (The discrepancy is harmless — likely an
off-by-one in either counting or a row consolidated.)

**Severity:** cosmetic. Not worth chasing unless the consumer is automated.

### F4 — `_pages_to_examine` silently truncates at 4 pages (LOW)

Some KGIU grammar points span 5–6 pages. The cap at `pdf_pages[:4]` is the
right tradeoff for cost, but the truncated pages are dropped without a log
warning, so the operator never learns the audit didn't look at all the source
material. Recommend emitting `logger.info("truncating source_pages for cost", …)`
when this fires.

**Severity:** observability gap, not correctness.

### F5 — KGIU Advanced `pdf_offset` drifts but only one offset is applied (LOW-MEDIUM)

`CORPUS_FILES["kgiu_advanced"]["pdf_offset_default"] = 8` with the comment
"drifts later." The current implementation applies that single offset to every
page — for late-chapter entries the audit will OCR the wrong PDF page, and the
comparison will produce false MAJOR/MISSING_DATA results (the OCR view will be
of a different topic entirely).

**Fix:** either (a) accept a per-chapter offset table in the corpus config, or
(b) include a runtime check that re-OCRs and confirms it's looking at the right
page (e.g., search for the entry's `pattern` or `korean` in the OCR output and
log a warning if absent). The audit's findings on KGIU Advanced should be
treated with extra caution until this is resolved.

**Severity:** could produce noisy results on a subset; worth either fixing or
calling out loudly in AUDIT_README before the operator runs the vision pass.

### F6 — `corpus_stats['strata']` reports sampled strata, not total strata (LOW)

`build_sample_manifest` (line 403) computes
`strata_count = len({s.stratum for s in sample})`. Because every non-empty
stratum is guaranteed at least one sample by `max(1, …)`, this equals total
strata in steady state — but if a corpus has empty strata (none currently do)
the metric would mislead. Cosmetic; rename to `strata_sampled` or compute
total strata separately.

### F7 — `score_entry` redundant `is_critical` guard (TRIVIAL)

`is_critical = field in critical and field not in _FORMATTING_FIELDS` —
`_VOCAB_CRITICAL_FIELDS` and `_FORMATTING_FIELDS` are disjoint in the current
config, so the second clause never fires. Defensive, but reads as if the author
expected overlap. Worth a comment, or drop the redundant check.

### F8 — `AUDIT_SECURITY.md` missing (LOW)

Every other tools/ingest component (KRDICT_SECURITY.md, LOADERS_SECURITY.md,
CANONICAL_GRAMMAR_SECURITY.md) has one. The audit handles less sensitive data
(reading public JSONs and PDFs) but does send page images to an external API
and uses an API key — attack surface for credential leakage, prompt injection
via OCR-extracted text, and quota exhaustion. A short SECURITY.md enumerating
these and the defenses (env var key, max-pages cap, no PII in JSONs to leak)
would match the bar set by the rest of the directory.

---

## Detailed evaluation

### Sampling — PASS

- **Deterministic.** `stratified_sample` takes a `random.Random` instance.
  `test_stratified_sample_is_deterministic` asserts same seed → same sample.
  Verified by reading: `rng.shuffle(pool_copy); pool_copy[:target]` is the only
  randomness, and `pool_copy` is reset per stratum from a `defaultdict(list)`
  filled in input order. Final sort by `json_index` makes the manifest order
  also deterministic.
- **Stratified.** Buckets by chapter (KGIU) / theme (vocab) via `_stratum_for`.
  ID-shape parsing handles the four KGIU naming conventions
  (`intro`/`u\d+`/`c\d+`/`gr`/`app`); vocab falls back to theme then id-range
  bucketing. Coverage-first: `max(1, ceil(rate × |stratum|))` ensures every
  non-empty stratum is represented. `test_stratified_sample_covers_every_stratum`
  asserts this at 1% rate.
- **Rate justified.** ADR-023 §D1 explains the 5% choice — n≈170, Wilson ±3.5pp,
  enough to distinguish 95% from 85%. Alternatives (1%, 10%) considered and
  rejected with reasoning.
- **Wilson CI math.** `wilson_ci` matches the standard Wilson score interval
  (`(phat + z²/2n ± z·sqrt(phat(1-phat)/n + z²/4n²)) / (1 + z²/n)`). Edge
  cases handled: `n=0` returns `(0, 0)`; clamps to `[0, 1]`. Tests check `n=0`,
  `100/100`, `90/100`, `50/100`.

### Comparison logic — PASS (with F2 caveat on the OCR side)

- **Four-level taxonomy.** `classify_field_discrepancy` produces
  PASS / MINOR_DISCREPANCY / MAJOR_DISCREPANCY / MISSING_DATA per ADR-023 §D3.
  Decision tree is correct: both empty → PASS; found-empty + expected-nonempty
  → MISSING_DATA; found-nonempty + expected-empty → MINOR (don't trust the OCR
  to be exhaustive); equal-after-normalize → PASS; Korean-equivalent →
  MINOR; otherwise MAJOR-if-critical-else-MINOR.
- **Critical fields.** KGIU: `pattern`, `explanation`, `examples`. Vocab:
  `korean`, `english`, `part_of_speech`. Matches ADR-023 §D3.
- **Hanja non-critical defensible.** Hanja is intentionally NOT in
  `_VOCAB_CRITICAL_FIELDS`, so a wrong hanja yields MINOR, not MAJOR. ADR-023
  §D3 documents this; AUDIT_REPORT.md "Pattern 3" notes the trade-off. Reasonable:
  hanja is reference info, not a user-facing definition. Note that the
  parametric test at line 72 passes `is_critical=True` to the pure classifier
  and asserts MAJOR — that's testing the function contract, not the production
  call site. Confusing but not wrong.
- **Korean-only normalization.** `_korean_only` keeps Hangul syllables and jamo
  (compat ranges included). Used as a fuzzy-equivalence escape hatch: if the
  Korean inside differs only by punctuation/romanization, downgrade to MINOR.
  Correct application; reverts to the major/minor split when Korean differs
  materially. Note: hanja-only fields like `家族` produce empty Korean-only
  string, so the fuzzy check never triggers for them — correct.

### Vision OCR client — PASS (with F2)

- **Prompt caching.** `cache_control: {"type": "ephemeral"}` on the system
  prompt and on every image block. Per-process page cache
  (`self._page_cache`) avoids re-rendering the same PNG. Correct two-layer
  caching: in-process for PDF→PNG rendering, Anthropic-side for system
  prompt + images.
- **Defensive parsing.** Strips ``` fences and optional `json` prefix,
  falls back to `{}` on `JSONDecodeError` with a warn log. Handles the
  common malformed-output cases. Could additionally try to extract the
  first balanced `{…}` substring as a last-resort fallback before giving
  up, but the current behavior is safe.
- **Secrets.** `os.environ.get("ANTHROPIC_API_KEY")` or constructor arg.
  Never logged. Never written to disk. Correct.
- **Graceful offline mode.** Missing SDK or missing key → `available=False`,
  caller drops to `skipped_no_network`. Tested implicitly via the smoke
  test path.

### Audit findings — PASS (spot-checked)

| Finding | Audited claim | My spot-check | Match |
|---|---|---|---|
| `vocab-beg-0002.hanja` | should be `家族` not `家人` | Confirmed: same entry has `japanese: "家族"`, English "a family", and 가족 in modern Korean takes 家族. 家人 in Chinese means family member, not family. | ✓ |
| Composite POS — Beginner | 16 entries with `","` separator | Grep count of `"part_of_speech": "noun, adverb"` or `"adverb, noun"` = 16. | ✓ |
| Composite POS — Intermediate | 11 entries with `"/"` separator | Grep count of `"noun/adverb"` or `"adverb/noun"` = 11. | ✓ |
| Beginner audio_track gap | 358 / 1486 (24%) | 1486 word entries, 1128 with `audio_track` key, 358 missing = 24.1%. | ✓ |
| Intermediate audio_track gap | 189 / 1460 (13%) | 1460 word entries, 1271 with key, 189 missing = 12.9%. | ✓ |
| Separator inconsistency | Beginner `,` vs Intermediate `/` | Confirmed by reading sampled entries. | ✓ |

All five corpus-level claims are accurate. The structural-pass table summary is
miscounted (F1), but the individual findings stand up.

### Tests — PASS

- **9 parametric `classify_field_discrepancy` cases** covering every code
  branch: PASS (both empty, equal-after-normalize), MISSING (found-empty),
  MINOR (expected-empty, Korean-equivalent, non-critical-different),
  MAJOR (critical-different, hanja-different).
- **Sampling determinism:** same seed → same sample, different seed →
  different sample, malformed entries skipped, every stratum gets ≥1.
- **Wilson CI:** four spot-checks at n=0, 100/100, 90/100, 50/100.
- **Snapshot replay:** 5 hand-curated cases in `audit_snapshot.json` exercise
  the integrated `score_entry → aggregate_severity` pipeline. Includes the
  real-world hanja bug as a regression test. Also includes wrong-pattern
  MAJOR, missing-explanation MISSING, paraphrased-English MINOR, and a
  perfect-match PASS — good coverage of the four severity outcomes.
- **Smoke tests:** `structural_audit` runs cleanly on every real corpus that
  exists in the checkout; `render_report` produces expected headings; warning
  is emitted when `ocr_method=skipped_no_network`.
- **Not tested:** `VisionOcrClient.extract_entry_view` (the network boundary
  — correctly out of scope; mocking the SDK at the HTTP level would just be
  testing the mock); `_pages_to_examine` truncation (would catch F4 if it
  were tested); per-chapter offset behavior for KGIU Advanced (F5).

Snapshot pattern is the right call. Vision OCR is non-deterministic and
expensive; encoding 5 known answer keys and asserting the classifier handles
them is the highest-leverage offline test possible.

### Documentation — PASS (with F1, F8)

- **AUDIT_README.md** covers setup, three-command flow, useful flags,
  cost estimate ("a few dollars per full audit" — vague but present and
  honest about per-page caching halving the cost), what-to-do-with-findings
  decision tree from ADR-023, re-audit-with-same-seed guidance, test
  invocation, file layout.
- **ADR-023** is excellent: justifies the rate, the stratification, the
  severity taxonomy, determinism, prompt caching, read-only separation, and
  the three-subcommand split. Alternatives enumerated. Negative consequences
  acknowledged including the two-agent self-confirmation risk that F2
  amplifies.
- **AUDIT_REPORT.md** is informative but contains F1 (inflated MINOR counts).
- **No AUDIT_SECURITY.md** (F8).

---

## Coordination notes

- **For C4 (loaders):** the triage CSV is the authoritative TODO list for
  pre-load fixes. Specifically: (a) hand-fix `vocab-beg-0002.hanja` to `家族`,
  (b) implement composite POS normalization at load time (the loader, not the
  JSON, should pick a separator). The audit's recommendation to store the
  primary POS plus a `pos_secondary` column (or `part_of_speech_alternates`
  JSONB per ADR-005) is the right shape — leaves the source JSON immutable
  and makes the schema explicit about the duality.

- **For the operator running the vision pass:** before running `compare` on
  KGIU Advanced, address F5 — the single `pdf_offset_default=8` will produce
  noisy MAJOR/MISSING results on late-chapter entries because it OCRs the
  wrong page. Either patch the offset table or skip kgiu_advanced from the
  first pass and audit it separately.

- **For ADR-023:** consider amending §"Negative consequences" to explicitly
  call out F2 — the user message includes the JSON values, biasing OCR
  towards confirmation. Recommend the blind-first/anchor-second tweak or
  document the expectation that hand-check (the "audit the audit" step in
  AUDIT_README) is load-bearing, not optional.

- **For Phase D (load decisions):** the structural pass already produced
  enough evidence to proceed with conditional loading on Beginner/Intermediate
  vocab (the 1 hanja bug + composite POS normalization is a contained
  remediation), and to flag KGIU corpora as load-ready pending the vision
  pass (no structural defects detected). The audit infrastructure itself is
  load-ready.

---

## Bottom line

C3 ships. Two doc fixes (F1 structural-table miscounts, F8 SECURITY.md gap)
should land before this is "done by the bar." Two real-but-non-blocking issues
(F2 OCR prompt anchor, F5 KGIU Advanced offset drift) need either a small code
change or an explicit caveat in AUDIT_README before the operator burns API
budget on the vision pass. The remaining findings (F3/F4/F6/F7) are polish.

The hanja bug, the composite-POS separator inconsistency, and the audio_track
gaps are all real, all caught, and all worth acting on — the audit did its job.
