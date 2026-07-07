# FIX — Data / Corpus sweep batch (D-3 explanation audit, D-6 loader wipe, D-7, D-9, B-012)

Date: 2026-07-06. Scope: `tools/ingest/loaders/load_topik.py` + live km-db data.
Source findings: `db/docs/SWEEP_data_corpus.md` (D-3, D-6, D-7, D-9, B-012) and
`FOLLOW_UPS.md` F-UP-013.

---

## 1. D-3 / F-UP-013 expansion — systematic audit of all TOPIK explanations

### Methodology

Every enriched row (`topik_items.extra ? 'explanation'` — **1,926 rows**, slightly
more than the 1,915 estimated in the sweep) was exported and run through a purpose-built
detector, `tools/ingest/audit_topik_explanations.py`:

1. Normalize option texts and explanation (NFC, Hangul/Latin/digits only) and locate
   verbatim or long-prefix/suffix quotes of each option inside the explanation.
2. Split the explanation into an ENDORSE zone and a DISTRACTOR zone at the first
   distractor marker ("The distractors", "오답", "나머지", …).
3. Attach positive cues (correct / the answer / 정답 / directly supports / matching …)
   and negative cues (wrong / unsupported / contradicts / 아니다 / not …) to each quote.
   Cue attribution is **quote-bounded** — clipped at the nearest occurrence of a
   *different* option — because a fixed window bled endorsement language across
   options (this is exactly how known-bad id 2140 evaded the first version).
4. Extract explicit ordinal endorsements ("세 번째 선택지 … 정답", "option 2 is correct")
   and compare them against both the key and the quoted text.
5. Verdicts: `MISMATCH_HIGH` / `MISMATCH_MEDIUM` / `SUSPECT_LOW` / `PLACEHOLDER` /
   `OK` / `OK_WEAK` / `UNSCANNABLE` (explanation quotes no option — heuristic-blind).
   Inversion items (맞지 않는/않은 것) are held to a stricter bar before HIGH because a
   *correct* inversion explanation also frames the keyed statement as factually wrong.

Calibration: all four sweep-confirmed bad ids (812, 1057, 2000, 2140) are flagged by
the final detector — recall 4/4 on known truth.

**Every flagged row was then manually adjudicated** (87 rows: 16 HIGH, 46 MEDIUM,
18 LOW, 7 PLACEHOLDER — full text read, endorsed option compared to key by hand).
Two supplementary passes covered detector blind spots:

- A regex sweep of all 1,926 explanations for skip/cannot-explain language
  ("SKIPPED", "Skipping due to missing passage", "지문 없음", "cannot be determined", …):
  34 hits, each read in full — 28 were placeholder pseudo-explanations, 6 were
  substantive and correct (759, 1230, 1248, 1560, 1578, 2332 — kept).
- A 30-row random sample of the *unflagged* buckets (12 UNSCANNABLE, 8 OK_WEAK,
  10 OK/OK_WEAK from the high-risk inversion + speaker-attribution classes):
  0 wrong endorsements found (1 skip-class row surfaced, which triggered the regex
  sweep above).

### Coverage / results

| Metric | Count |
|---|---|
| Enriched rows audited (automated) | **1,926** (100%) |
| Detector-flagged, manually adjudicated | 87 |
| Skip-language hits, manually adjudicated | 34 (overlap with flagged: 10) |
| Random unflagged sample, manually read | 30 |
| **Wrong-endorsement explanations → nulled** | **14** |
| **Placeholder pseudo-explanations → nulled** | **28** |
| **U+FFFD-corrupted explanations → repaired in place (D-7)** | **3** |
| Total rows modified | 45 |
| Enriched rows before → after | 1,926 → **1,884** |

**Nulled — explanation endorsed a different option than the graded key (14):**
150, 152, 220, 637, 812, 883, 936, 1057, 1404, 1580, 1791, 2000, 2140, and 2201
(2201 endorses nothing — "the answer depends on the sentence's intent" — junk).
Risk-class confirmation: 6 of these are 맞지 않는-inversion items and 3 are
speaker-attribution listening items, matching the sweep's predicted high-risk classes.
For every one where the stem/notice/transcript is self-contained (150, 152, 220, 883,
1057, 1404, 1580, 1791, 2140) the graded key was re-derived by hand and is **correct** —
the explanation was the wrong side. For the listening items without accessible
transcript (637, 936, 2000) the provenance-verified key was trusted and the
contradicting explanation nulled (per brief: prefer null over uncertain correction).

**Nulled — placeholder pseudo-explanations (28):** 221, 239, 335, 431, 463, 591, 607,
701, 703, 713, 719, 725, 735, 737, 767, 783, 831, 943, 959, 1007, 1087, 1356, 1359,
1423, 1503, 1727, 1855, 2396. These say "SKIPPED / Skipping due to missing passage /
picture-dependent content" etc. — zero pedagogic value and broken UX if served.
Notable: **id 221** claimed "SKIPPED — data bug: the recorded answer contradicts the
sign" — but the item is a 맞지 않는 inversion, so the "contradicting" option is exactly
the right answer; the key (1) is correct and the explanation author missed the
inversion. Nulled.

**Repaired (D-7, U+FFFD):** 1803 (`늘�일` → `늘릴`), 1867 (`수월해�었다` → `수월해졌다`),
2001 (`이루어�었다` → `이루어졌다`). Reconstruction is certain — each corruption sits
inside a verbatim quote of the item's own option text. 0 rows with U+FFFD remain.

All 45 touched explanations are backed up in table
**`topik_items_explanation_bak_20260706`** (id, original jsonb value, timestamp).
All SQL was id-scoped and guarded (`AND extra ? 'explanation'` / `LIKE '%�%'`) —
idempotent on re-run. `version` bumped on every touched row.

### F-UP-013 (ids 222, 659, 769, 1086)

Folded into the audit. All four are already clean in live data: their answer keys were
corrected in an earlier pass **and propagated to the source JSONs** (sweep-verified),
and none of them carries an explanation today (the generator skipped them), so there is
nothing contradictory being served. Current keys re-checked where locally derivable
(222 → 4 is right: 민희 is not with 수미 in the SNS exchange). F-UP-013 can be closed.

### Honest residual estimate

The detector cannot read Korean; it matches quotes and cue words. What it cannot see:

- **~289 paraphrase-only explanations** (UNSCANNABLE after the skip-class cleanup) that
  never quote an option verbatim — mostly listening items explained from the transcript.
  A 12-row random sample was 100% correct.
- OK-verdict rows where cue bleed could mask a mismatch (the mechanism was observed in
  the opposite direction); an 18-row risk-class sample was 100% correct.

Among the 1,616 scannable rows the adjudicated wrong-endorsement rate was ~0.9%
(14/1,616, and the detector caught 4/4 known-bad). If the blind set misendorses at a
similar rate, expect **roughly 2–5 (upper bound ~10) bad explanations to remain**,
most likely among listening items whose explanation paraphrases the transcript.
**Follow-up suggested:** an LLM re-verification pass over the ~289 paraphrase-only
explanations (feed stem + options + key + explanation, ask "which option does this
explanation endorse?") would close the gap the string heuristic cannot.

Re-run recipe: export query + usage are in the module docstring of
`tools/ingest/audit_topik_explanations.py`.

---

## 2. D-6 — `load_topik.py` upsert wiped DB-only `extra` enrichment

`tools/ingest/loaders/load_topik.py` (`_insert_item_batch` upsert): `extra =
EXCLUDED.extra` rebuilt `extra` from source on every re-ingest. The source JSONs carry
zero explanations (and `TopikItemModel` is strict, so the key can't ride through), so
one re-ingested file silently destroyed up to 50 DB-only explanations.

**Fix:** `extra = (topik_items.extra - 'char_range') || EXCLUDED.extra` — the single
loader-owned key (`char_range`) stays fully source-authoritative (including source-side
deletion), every other (enrichment) key survives a reload.

**Also fixed while in the same `ON CONFLICT` clause (D-9, linkage half):** the upsert
now updates `topik_test_id`, `corpus_source_id`, and `section`, so an item re-keyed to
a different test/section in source no longer keeps stale linkage silently.

**Test:** new `test_topik_reingest_preserves_db_only_extra_enrichment` in
`tools/ingest/tests/test_load_topik.py` — loads the writing fixture, injects an
`explanation` into item #53's `extra` via SQL, force-reloads, and asserts the
explanation survived **and** `char_range` was still refreshed from source.
Full suite run in the project's containerized pattern (python:3.12 + docker socket +
testcontainers): **6 passed** (5 existing + 1 new). Ruff clean on all touched files.

D-9's other half — `load_state.items_loaded` accumulating across `--force` reloads
(ops metric only, shared `runtime.py` checkpoint semantics) — deliberately **not**
fixed here; reported as a follow-up to keep this batch low-risk.

---

## 3. B-012 — vocab-2000 completeness spot-check

| Level | Source JSON entries | Word entries | Loaded in km-db | Skipped (id-only placeholder rows) |
|---|---|---|---|---|
| Beginner | 1,706 | 1,598 | **1,598** | 108 |
| Intermediate | 1,696 | 1,590 | **1,590** | 106 |

- **Loader is faithful**: DB row counts equal the source word counts exactly; the
  skipped rows contain only an `id` (no korean/english — structural/navigational
  artifacts of the PDF extraction). 0 empty korean/english among loaded corpus rows
  (the 1 empty-english row in `vocab_entries` is `user_mined`, not corpus).
- **The gap vs nominal is upstream of the loader**: the books are nominally "2000
  Essential Korean Words" per level, but the extraction itself tops out at source id
  1706/1696 and yields 1,598/1,590 actual words — **~400 words short per level
  (~20%)**. Closing it requires a corpus re-extraction pass (out of scope per brief;
  reported here).

---

## 4. Other sweep findings — status from the data side

- **D-1 (level-merged mocks), D-2 (28 placeholder listening items), D-4 (diagnostic
  glyph guard), D-5 (8 withheld-passage items), D-8 (40 zero-option test-35 rows)** —
  serving-guard/route fixes owned by the route agents; no data mutation is appropriate
  (the rows are honest records of imperfect sourcing, provenance documents them).
  Note for the route agent: the 7 zero-option test-35 rows that carried "SKIPPED"
  pseudo-explanations are now explanation-free too.
- **Dup/contradictory options** — sweep already verified clean (0 out-of-range keys,
  0 dup/empty option texts among served items); re-confirmed nothing regressed after
  this batch (guarded UPDATEs touched only `extra`/`version`).
- **D-10 (empty `topik_dependencies` / `canonical_grammar`)** — informational; no
  server consumer today; unchanged.

## Follow-ups proposed

1. LLM re-verification pass over the ~289 paraphrase-only explanations (residual tail).
2. `load_state.items_loaded` reset on `--force` reload (D-9 metric half).
3. vocab-2000 re-extraction if the missing ~400 words/level matter for B-012.
