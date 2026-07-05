# Re-review: TTMIK transcript fixpass

**Reviewer:** independent, read-only re-review, branch `feat/ttmik-transcripts`, fix commit `c1d122a`.
**Scope:** `tools/ingest/loaders/load_ttmik_transcript.py` (`_is_romanization`/`_strip_inline_rom`),
`tools/ingest/tests/test_load_ttmik_transcript.py`, `server/src/routes/ttmik.ts`,
`server/src/routes/reading.ts`, `server/tests/routes/ttmik.test.ts`.
**Method:** static diff read against the original `REVIEW_TR_PARSER.md` checklist; live read-only SQL
against `km-db`'s reloaded `ttmik_transcript_lines`; an independent from-scratch re-run of the actual
(unmodified) `extract_pdf_text`/`parse_script_text`/`_is_romanization` in a throwaway venv against the
three real corpus PDFs at `/home/jared-williams/data/korean-master/corpus/TTMIK/Lessons/Lesson Scripts/`
(no DB writes) to get ground truth independent of the DB snapshot; and an actual `pytest` run of
`tools/ingest/tests/test_load_ttmik_transcript.py` (not just a static read) both at `c1d122a` (post-fix)
and at `648e5ec` (pre-fix, `c1d122a~1`) to check for regressions and false confidence in the new tests.

## Verdict

**FAIL.** BLOCKER 2 (over-strip of English labels) is genuinely fixed and I could not find a
counter-regression. BLOCKER 1 (romanization leak) is **NOT fixed** — the fix closed the two specific
leak shapes called out in the original review (hyphen-/paren-led particle romanization, and
punctuation-bearing hyphenated romanization) but the replacement heuristic ("strip iff the bracket has
a lowercase-latin hyphen-join, or starts with `-`/`(`") leaves a much larger hole open: any
**non-hyphenated** romanization — which is the normal shape for single-syllable and short multi-word
TTMIK vocabulary/particle glosses (`네 [ne]`, `이 [i]`, `가 [ga]`, `아니요 [aniyo]`, `존댓말
[jondaetmal]`) — now sails through untouched. This is exactly the failure mode the task brief predicted
("a single-syllable inline romanization with no hyphen and no `-`/`(` lead") and it is not a one-off: it
is confirmed live in **243 of 303** bracket-containing rows in the reloaded table (161 distinct leaked
romanization forms, 350 total occurrences across the corpus) — a larger absolute leak than the 130 rows
the original BLOCKER 1 reported. The commit's own claim ("0 romanization leaks (all forms)") is false.

## Finding-by-finding

### BLOCKER-1 (romanization leak) — **NOT FIXED** (new shape, larger scope)

The fix (`load_ttmik_transcript.py:109-126`) replaced `_INLINE_ROM_RE` with `_is_romanization(inner)`,
which returns `True` (strip) only if the bracket content matches `_LATIN_SYLLABLE_HYPHEN_RE`
(`[a-z]-[a-z]`) or starts with `-`/`(`. This correctly fixes the two cases the original review cited
(`-도 [-do]`, `(이)랑 [(i)rang]`) — confirmed via the new parametrized tests, all 13 of which pass on the
current code (see SHOULD-FIX-4 below). But it does nothing for a bracket that is Latin, lowercase, and
romanized Korean, but has **no hyphen** — which is the norm for a single syllable (`ne`, `i`, `ga`, `do`,
`e`, `su`, `da`, `mwo`) or a short un-hyphenated multi-word gloss (`sa mu sil`-style forms, or number
words like `chil = seven`). None of these start with `-`/`(` or contain `[a-z]-[a-z]`, so
`_is_romanization` returns `False` and they are kept verbatim, indistinguishable in the code from a real
English label like `[noun]`.

**Live DB evidence** (`docker exec -i km-db psql -U korean_master -d korean_master`):
```
SELECT count(*) FROM ttmik_transcript_lines;                         -- 9536 (matches commit claim)
SELECT count(DISTINCT lesson_id) FROM ttmik_transcript_lines;        -- 232 (matches commit claim)
SELECT count(*) FROM ttmik_transcript_lines WHERE korean ~ '\[[A-Za-z]';   -- 271
SELECT count(*) FROM ttmik_transcript_lines WHERE english ~ '\[[A-Za-z]';  -- 31
-- 303 total rows still carry a bracket after the "fix" reload.
```
Sample distinct bracket contents pulled from the live table (`SELECT DISTINCT substring(korean from
'\[[^][]*\]') ...`): `[ne]` (11 rows), `[i]` (17), `[ga]` (11), `[da]` (10), `[e]`/`[eun]`/`[geot]`/`[gae]`
(8 each), `[su]`/`[deo]`/`[o]` (7 each), `[a]`/`[geu]` (6 each), `[an]`/`[aniyo]`/`[jung]` (4-5 each), and
~140 more distinct single/short-token romanized forms — none contain a hyphen, all sail through as if
they were English labels.

Representative surviving rows (`id, lesson_id, ordinal, kind, korean` from the live table):
| id | lesson_id | ordinal | kind | text |
|---|---|---|---|---|
| 48105 | 2 | 3 | pair | `네. [ne]` |
| 48106 | 2 | 4 | pair | `아니요. [aniyo]` |
| 48268 | 7 | 6 | pair | `이 [i]` |
| 48336 | 9 | 15 | prose | `이 [i] / 가 [ga] The role of subject marking particles is relatively simple...` |
| 48104 | 2 | 2 | prose | `네 / 아니요 In Korean, "Yes" is 네 [ne] and "No" is 아니요 [aniyo] in 존댓말 [jondaetmal], polite language.` |

**Independent re-parse cross-check** (unmodified `extract_pdf_text`/`parse_script_text`/`_is_romanization`
run directly against the three source PDFs in a throwaway venv, no DB): total output is **9,536 lines /
232 lessons**, an exact match to the live table, confirming the DB snapshot faithfully reflects the
current parser's actual behavior (not a stale load). Classifying every surviving bracket against a
manually-vetted allow-list of the corpus's ~53 genuine English grammar-label forms (`noun`, `verb`,
`past tense`, `honorific`, `subject marker`, `Original verb: ... = ...`, etc.):
- **114 occurrences (53 distinct forms)** are genuine labels, correctly kept — this direction is fixed.
- **350 occurrences (161 distinct forms)** are romanized Korean that leaked through, e.g. `a`, `an`,
  `aniyo`, `ap`, `ba(ek)`, `bo`, `da` (×10), `dae`, `de`, `deo` (×7), `do`, `e` (×8), `eu`, `eul`, `eun`
  (×8), `ga` (×11), `gae` (×8), `geo`, `geot` (×8), `geu` (×6), `ha`, `hada`, `han`, `i` (×17), `il`,
  `jal`, `jang`, `jeo` (×9), `jeon`, `jjeum`, `jondaetmal` (×3), `jung` (×5), `mal`, `mat`, `meok` (×3),
  `mwo` (×4), `myeong` (×5), `na`, `nan`, `ne` (×11), `neun` (×8), `o` (×7), `pal`, `sa`, `sal`, `sam`,
  `seo`, `si`, `sip`, `son`, `ssi`, `su` (×7), `wae`, `ya`, `yeol`, plus number-vocabulary pairs like
  `baek / 100`, `cheon = thousand`, `il = one`, `yuk = six`.
- Row-level: of the **303** bracket-containing rows in the live table, **243 (80%)** contain at least
  one leaked (non-label) romanization bracket; only **60** contain exclusively genuine label brackets.

**Root cause is the same class of bug the original review flagged**, just inverted: "contains a hyphen"
is neither necessary (single-syllable/short-phrase romanization has no hyphen) nor sufficient
(a genuinely hyphenated English label would still be misclassified — see BLOCKER-2 verification, where
none happen to exist in this corpus, but the logic doesn't know that) as a positive test for "this
bracket is romanized Korean." The fix comment at `load_ttmik_transcript.py:112-119` states this exact
principle for the old bug ("neither necessary nor sufficient... gate on the first character") but the
replacement gates on presence-of-hyphen, which is exactly as unprincipled for the un-hyphenated case.

### BLOCKER-2 (over-strip of English labels) — **FIXED**, no counter-regression found

Live DB confirms legit label brackets survive intact and complete: `[noun]` (11), `[verb]` (3),
`[past tense]` (13), `[honorific]` (11), `[present tense]` (8), `[Original verb: 닫다 = to close]` and
its four siblings (1 each), `[subject marker]`, `[topic marker]`, `[informal]`, `[plain]`,
`[polite/formal]`, `[verb: 가다]` etc. — all present, matching (and exceeding) the commit's own claim of
"30 English labels preserved" (actual count from the from-scratch re-parse: 53 distinct label forms /
114 occurrences). The `(8, 17)` sentence-pattern casualty the original review cited
("If only it were not `[noun]`, I would `[verb]`") is confirmed no longer stripped.

I actively probed the task brief's predicted counter-regression — a legitimate English label that
*happens* to contain a hyphen (`[well-known]`, `[e-mail]`, `[self-introduction]`) and would now be
wrongly stripped by the new hyphen-join rule. Searched the raw PDF text directly (candidates:
`well-known`, `e-mail`, `self-intro`, `up-to-date`, `face-to-face`, `one-on-one`, `follow-up`,
`check-in`/`check-out`, `long-term`/`short-term`, `part-time`/`full-time`, `so-called`, `built-in`,
`well-being`, `well-mannered`): **zero hits**. A broader sweep for any bracket containing a
capitalized-word-plus-hyphen shape turned up only two matches in the entire corpus —
`[TalkToMeInKorean-i-ra-neun wep-sa-i-teu a-ra-yo?]` and `[eo-je Taliana-ga han-gu-ge wa-sseul-kka-yo?]`
— both are themselves full Korean-romanization sentences (correctly stripped as romanization, not
mislabeled English). **No over-strip casualty exists in this corpus** for the hyphen-based rule; the
theoretical risk is real (the rule has no actual defense against a hyphenated English label), but it is
not realized here.

### New parametrized tests — **partially assert both directions, would catch the OLD bugs, would NOT catch the current leak**

Ran `pytest tools/ingest/tests/test_load_ttmik_transcript.py -k strip_inline_rom_strips` on the current
code: **13/13 pass.** Re-ran the same 13 cases against the pre-fix `_strip_inline_rom` (extracted from
`c1d122a~1` into an isolated copy): **8/13 fail** — confirming the new tests are genuinely falsifiable
against the old heuristic, covering both the leak direction (hyphen/paren-led particle romanization) and
the over-strip direction (English labels). This much is solid.

However, none of the 13 new cases exercise a **non-hyphenated, non-`-`/`(`-led** romanization bracket
(e.g. `"네. [ne]"`, `"이 [i]"`) — the exact shape that is now leaking at scale in the live corpus. A test
asserting `_strip_inline_rom("네. [ne]") == "네."` would fail today and would have caught this finding
before merge. The test suite currently provides false confidence: it proves the two originally-reported
BLOCKER shapes are fixed while being silent on the new, larger leak.

### SHOULD-FIX (R2, endpoint/reading cleanup) — all **FIXED**, confirmed by diff read

- `server/src/routes/ttmik.ts:210` — transcript query now has `AND kind <> 'romanization'` with a
  code comment naming it as belt-and-suspenders defense. Confirmed in the diff; live DB has 0 rows with
  `kind='romanization'` regardless, so this is defense-in-depth as designed, not currently load-bearing.
- `server/tests/routes/ttmik.test.ts` — added `expect(res.body.highlights[0]).not.toHaveProperty
  ('romanization')` immediately after the existing `toMatchObject` check, closing the exact gap the
  original endpoint review flagged (`toMatchObject` alone would not catch a regressed `romanization`
  field). Confirmed in the diff.
- `server/src/routes/reading.ts:109,120` — both the `ttmik_sentences` and `iyagi_sentences` branches of
  `GET /reading/units/:corpus/:unitId/sentences` no longer select `romanization`. Confirmed in the diff;
  this closes the out-of-scope finding the endpoint reviewer flagged (`reading.ts` had re-exposed
  romanization outside the Listen surfaces).

### Other SHOULD-FIX items from `REVIEW_TR_PARSER.md` — unchanged (out of scope for this commit)

`c1d122a` touches only `_is_romanization`/`_strip_inline_rom` and the endpoint/reading queries. It does
not touch `load_ttmik_transcript.py:377-379,429-437` (SHOULD-FIX-5, string-vs-tuple resume order) or the
sha-changed-mid-crash resume gap (SHOULD-FIX-6), and the idempotency footgun (SHOULD-FIX-3, a parser fix
silently no-ops without `--force`) is still not documented anywhere in the module docstring or
`db/docs/`. These were never claimed as fixed by this commit, so they are not regressions — just still
open. Given this review just found the *reload itself* still leaves romanization present, whoever runs
the next corrective reload needs to remember `--force` for the same undocumented reason flagged
originally.

## REGRESSIONS check

- **Row/lesson counts:** 9,536 rows / 232 distinct lessons — matches the commit's claim exactly, and
  matches an independent from-scratch re-parse of the source PDFs bit-for-bit.
- **Ordinal contiguity:** `SELECT count(*) FROM (SELECT lesson_id FROM ttmik_transcript_lines GROUP BY
  lesson_id HAVING count(*) <> max(ordinal) OR min(ordinal) <> 1) t` → **0** bad lessons. Every lesson's
  ordinals are contiguous 1..n with no gaps.
- **No empty lessons / standalone romanization-kind rows:** `SELECT count(*) FROM
  ttmik_transcript_lines WHERE kind='romanization'` → **0**, as designed (standalone romanization-only
  lines are dropped entirely at parse time; this was never the bug — the bug is inline brackets embedded
  in `pair`/`prose`/`dialog` lines).
- **Pre-existing (non-regression) test-suite defect found during verification:** running the actual
  suite — not just reading it — `pytest tools/ingest/tests/test_load_ttmik_transcript.py` reports
  **30 passed, 2 failed** on the current branch. The two failures are
  `test_classify_line_cases` for the `"가다 [ga-da] --> 갈수록 [gal-su-rok] = ..."` and `"맛있다
  [ma-sit-da] = ..."` cases (lines 211-225): both assert the korean side *keeps* the `[ga-da]`/
  `[ma-sit-da]` bracket, but `classify_line` now strips it (these brackets have a lowercase-latin
  hyphen-join, so `_is_romanization` correctly flags them for removal — the *test's* expectation is
  stale). I confirmed via `git show c1d122a~1` that **these same 2 tests were already failing before this
  fix commit** (extracted the pre-fix loader + test file into an isolated copy and re-ran — identical 2
  failures), so this is not something `c1d122a` introduced. It is, however, a live defect nobody has
  caught: the parser test suite is not currently green, contradicting the commit message's framing
  ("Verified: ... parser heuristic proven on real corpus + unit").

## New findings

1. **BLOCKER-1 is not fixed; it changed shape and grew.** See above — 243/303 bracket-bearing rows in
   the live table still leak inline romanization, versus the 130 rows originally reported. This is the
   headline finding and blocks ship.
2. **The parser's own test suite is currently red** (`test_classify_line_cases`, 2/32 tests), independent
   of this fix and not introduced by it, but undetected until this re-review actually ran `pytest`
   instead of reading the file. The fix commit's "Verified: ... parser heuristic proven on ... unit"
   claim is not accurate as stated — 2 unit tests in the same file fail.
3. No counter-regression found for the specific over-strip risk the task asked me to probe (hyphenated
   English label casualty) — the corpus simply doesn't contain one, so BLOCKER-2's fix is safe today but
   is not defended by anything structural (a future English label that happens to be hyphenated, e.g. a
   new TTMIK lesson's `[well-known]`-style annotation, would still be silently deleted with no test to
   catch it).

## Recommendation

**Another fix cycle required before ship.** BLOCKER-1 is not resolved and is now larger in absolute
scope than the version originally rejected. The underlying design needs to stop trying to distinguish
romanization from English labels by a single structural signal (first-letter, then hyphen-presence) —
both have been tried and both leak. Given TTMIK's English annotation vocabulary is a small, closed,
enumerable set (grammar categories, tense names, "Original verb: ... = ...", a handful of markers), a
robust fix is more likely to succeed as: strip a bracket by default (romanization is the norm for
letter-leading Latin brackets in this corpus), and **allow-list** the enumerable closed set of English
label shapes to keep — the inverse of both heuristics tried so far, and the one shape that would need no
further hyphen/case tricks to get right. Add the missing test case class (bare single-syllable /
un-hyphenated romanization, e.g. `"네. [ne]"` → `"네."`) before the next re-review, and separately file a
ticket for the red `test_classify_line_cases` cases (pre-existing, not blocking, but should not stay red).
