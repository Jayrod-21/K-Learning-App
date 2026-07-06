# Review: P1 — Read tab + word lookup

_Independent senior review. Branch `p1-bug-fixes`. Scope: B-001 (Read default corpus), B-002 (real enrichment fields + `/define` examples), B-003 (prose formatting), and the `.km-passage` font change. Reviewer did not author this code._

## Summary verdict

**PASS.**

All three bug fixes are correct, not merely green. The corpus default flip (B-001), the enrichment-field mapping (B-002), and the prose rendering (B-003) each address the root cause and are backed by tests that would fail on the pre-fix code. Queries are parameterized, corpus identifiers come from a `z.enum` (never interpolated), and every rendered Korean/English string reaches the DOM as React children (no XSS sink in scope). Degradation paths — empty KRDICT, `/define` 503, enrich failure, empty page — are all handled and asserted. No blockers. Two small findings (one SHOULD-FIX, one NIT) plus a font/tap-target NIT, none deal-breaking.

## Bar checklist

| Gate (SENIOR_ENGINEER_BAR) | Result | Notes |
|---|---|---|
| §2.1 Type safety at boundaries, no `any` cast | PASS | Enrichment envelope narrowed field-by-field (`textOrNull`, `Array.isArray` guards) instead of a bare cast — `summariseEnrichment` (Reading.tsx:313). |
| §2.8 No untrusted HTML / XSS | PASS | All display fields render as React children in WordPopover, KoreanPassage, ReadingPicker. No `dangerouslySetInnerHTML` in scope. |
| §3.5 / §4.7 Parameterized queries | PASS | Every query in `reading.ts` and `define.ts` uses `$1/$2` bindings incl. `ANY($1::bigint[])`. Table choice is a branch on a validated enum, never string-built. |
| §0 / §3.1 Fail closed, degrade gracefully | PASS | `/define` returns honest 503 when KRDICT absent; `fetchExamplesByEntry` swallows only `42P01`, rethrows all else (fail loud); empty examples → `[]`; drawer hides when empty. |
| §5.2 Every bug fix ships a regression test that fails on old code | PASS | See Findings → PRAISE. Tests target the exact pre-fix defects (`summary`/`gloss`/`en` mapping, ttmik default, hardcoded `''` example). |
| §2.6 WCAG 2.2 2.5.8 target size | PASS (with NIT) | 16px/1.8 gives a 28.8px line box; single-syllable words are <24px wide but word-spaced, satisfying the spacing exception. See NIT-1. |
| §1.5 / error envelope no leak | PASS | DB-error tests assert no table name / stack trace leaks (reading.test.ts:186, define.test.ts:170). |

## Findings

### BLOCKER
None.

### SHOULD-FIX
- **SF-1 — Sentinel gloss strings duplicated as magic literals across two files.** `buildWordPopover` emits `'Dictionary entry'` / `'Definition unavailable'` as fallback gloss values (Reading.tsx:386), and `handleAdd` re-tests those exact string literals to decide whether to forward `english` to `mineWord` (Reading.tsx:706). The coupling is implicit: change the literal in one place and the mine-filter silently starts sending a sentinel as a real English gloss. Extract both to a shared `const` (e.g. `GLOSS_UNAVAILABLE`, `GLOSS_DICTIONARY_ENTRY`) so the two sites can't drift.

### NIT
- **NIT-1 — Single-syllable tap targets shrink at 16px.** `.km-tapword` adds only `padding: 0 1px` (index.css:1347); a one-syllable word (e.g. 배) is ~16–18px wide. Technically WCAG-2.5.8-compliant via the word-spacing exception, and this is the core gesture of the app, so a slightly larger vertical hit area (e.g. a small `padding-block` or `line-height`-derived pad) would improve mobile ergonomics without re-inflating the visual line. The font drop itself (21→16) is the right call — 21px/2.0 genuinely read as a word list.
- **NIT-2 — Korean-only definition never surfaced.** In `buildWordPopover`, when a KRDICT entry has `definition_english === null` and enrichment carried no `nuance`, the gloss falls to the literal `'Dictionary entry'` (Reading.tsx:383-386) even though `definition_korean` is present on the entry. Minor — showing the Korean definition would beat a generic placeholder for the (uncommon) English-missing sense.

### PRAISE
- **Regression tests are exemplary and genuinely pre-fix-failing.** Reading.test.tsx:433 seeds a full `EnrichmentResult` (`nuance`/`usageNote`/`examples`/`dontConfuseWith`) and asserts each lands in the popover/drawer — this fails hard against the old `summary`/`gloss`/`en` reader. Reading.test.tsx:392 drives the exact fresh-visit loader and asserts `fetchUnits({corpus:'iyagi',limit:1})` — fails on the old ttmik default. define.test.ts:83 asserts `krdict_examples` join order and cross-entry non-bleed; WordPopover.test.tsx:104 asserts the empty drawer is hidden. This is the §5.2 contract met literally.
- **`summariseEnrichment` narrows the opaque envelope structurally.** Rather than `as EnrichmentResult`, it `Array.isArray`-guards and `textOrNull`-filters each field (Reading.tsx:313-346), so a malformed or legacy-cached B4 envelope degrades to nulls/empties instead of rendering garbage — exactly the boundary discipline §2.1/§7.1 asks for on untrusted upstream data.
- **`fetchExamplesByEntry` degradation is precisely scoped.** It catches only `42P01` (senses/examples dropped by a half-rolled-back migration) and rethrows everything else, keeping examples additive without masking real DB errors (define.ts:99-101). The batched `ROW_NUMBER() … PARTITION BY entry_id` cap avoids an N+1 across the entry page.

## Detailed findings (file:line)

- **B-001 correctness — `readingSelection.ts:38`.** `DEFAULT_READING_CORPUS = 'iyagi'`; the docstring names the real reason (ttmik hanja word-family lessons are single-word rows). `ReadingPicker.tsx:56` orders Iyagi first and seeds its tab from `current?.corpus ?? DEFAULT_READING_CORPUS` (line 98), so the picker and the screen agree on the default. No regression to the picker — it fetches independently and pages on the server's real `total`.
- **B-001 no-empty-regression — `Reading.tsx:246-257`.** Fresh visit does `fetchUnits({corpus:'iyagi',limit:1})`; `units.length === 0` throws `ApiError` → `useEndpointOrMock` lights the mock badge rather than rendering an empty Card. Graceful, and the user-confirmed browser behavior implies iyagi is populated on the box.
- **B-002 wire — `define.ts:70-103, 237-243`.** `/define` now joins `krdict_examples` through `krdict_senses` (`s.krdict_entry_id = ANY($1::bigint[])`), caps at `EXAMPLES_PER_ENTRY = 5` via window function, and rides an `examples: []` array on each entry. Empty-KRDICT box → `examples` degrades to `[]` (define.test.ts:67-81 asserts exactly this), so the "More examples" drawer has nothing to show.
- **B-002 client mapping — `Reading.tsx:313-402`.** `summariseEnrichment` reads the REAL fields (`nuance`, `usageNote`, `examples[].korean/english`, `dontConfuseWith[].lemma/distinction`); `buildWordPopover` leads with KRDICT (`definition_english`, joined examples) and supplements with enrichment. `'Definition unavailable'` is now genuinely last-resort (both sources empty), asserted at Reading.test.tsx:536.
- **B-002 empty-drawer hide — `WordPopover.tsx:147-151, 258-273`.** `hasDrawer = extras.length > 0 || hasUsage`; info toggle and drawer are both gated on it. On the zero-example box the drawer button never renders (WordPopover.test.tsx:104). Correct — no empty panel.
- **B-003 prose — `Reading.tsx:199-223` + `KoreanPassage.tsx:80-93`.** `tokeniseSentence` splits each `ReadingSentenceRow.korean` on `\s+|\S+`, one `PassageSentence` per row, tokens inline; KoreanPassage renders one paragraph per sentence with inline tapwords. Combined with the iyagi default, a passage now reads as multi-word prose (Reading.test.tsx:427-430 asserts `words.length > 1`). B-003 is fundamentally the corpus fix, not a render rewrite.
- **Font — `index.css:1376-1385`.** `.km-passage` 16px / line-height 1.8, comment documents the prior 21px/2.0 word-list problem. Vertical line box 28.8px (>24px); tap targets fine except single-syllable width (NIT-1).
- **Security cross-check — `reading.ts:66-91`, `define.ts:199-207`.** Corpus branch selects the table; `headword = $1`, `lesson_id = $1`, `episode_id = $1`, `LIMIT $1 OFFSET $2` all bound. `loadReadingSelection` validates untrusted localStorage against the corpus union and coerces `unitId` to a positive int (readingSelection.ts:46-73), so a tampered value can't drive a malformed route.

## Coordination observations

- **`/define` entry-id contract is threaded end-to-end.** `entries[0].id` → `WordPopoverData.krdictEntryId` → `mineWord({krdictEntryId})` (FU-NF-33) for homograph-safe dedup, and absent-id falls back to lemma. The B4 `EnrichmentResult` shape (`services/claude/models.ts`) is consumed defensively, so a B4 schema change degrades rather than breaks — but if B4 renames a field (e.g. `usageNote`), the drawer silently loses that field with no test tripping on the server side. Worth a shared type or a contract test at the B4 boundary later; not in scope here.
- **`krdictAvailable` cache is shared with `/krdict/search`** (exported, define.ts:133) — one information_schema probe budget and one rollback-invalidation path, correctly reused rather than duplicated.
- No changes to `domain.ts` regressed consumers: `DefineEntry.examples`, `ReadingSentenceRow`, `ReadingSelection`, and `ReadingCorpus` are all consistent between the server DTOs, the client adapter, and the picker.
