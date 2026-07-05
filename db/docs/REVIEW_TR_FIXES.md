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

---

## Round 2 re-review

**Fix commit:** `b78a250` ("fixpass round 2: allow-list romanization detection"). **Method:** same as
round 1 — independent SELECT-only queries against the reloaded live `ttmik_transcript_lines`; a
from-scratch re-run of the actual unmodified round-2 parser against the three source PDFs in a throwaway
venv; a side-by-side diff of round-1 (`c1d122a`) vs round-2 (`b78a250`) `_is_romanization` across every
inline bracket in the corpus; and an actual `pytest` run.

### Verdict: **PASS WITH CONDITIONS**

The round-1 BLOCKER-1 — the non-hyphenated bracket leak (243/303 rows: `네 [ne]`, `이 [i]`, `아니요
[aniyo]`) — is **genuinely resolved** by the allow-list rewrite, and I independently confirm the
coordinator's "37 distinct brackets survive, all legit" claim for ASCII `]`-closed brackets. The
approach is correct and the tests are falsifiable. **However, the commit's stronger claim — "ZERO
romanization" — is refuted:** 20 rows still carry romanization through delimiter channels the
bracket-strip never covered (slash `/an-da/`, fullwidth `［…］`, parentheses `(…)`) plus one *new*
round-2 bracket regression. And round 2 introduces a small **new over-strip** of 4 legitimate English
annotation brackets. Both residuals are far smaller than round 1 and mostly out of the bracket-fix's
original scope, but they keep the migration's "lossless / no romanization anywhere" contract from being
literally true. Ship-decision is the coordinator's: the scoped bracket blocker is fixed; two residual
defects remain.

### BLOCKER-1 (romanization leak) — bracket channel **FIXED**; "zero romanization" **REFUTED** (20 residual rows)

Round-2 `_is_romanization` (`load_ttmik_transcript.py:118-149`) strips letter-leading Latin brackets by
default and keeps only Hangul-bearing content, an allow-listed English label (`_LABEL_EXACT` +
`"…tense"`/`"…marker"`), a single uppercase slot, or an English prose fragment (`_ENGLISH_HINT_RE`:
`...`/`etc`/`and`/`or`/`the`). Verified correct for the round-1 leak class:

- **Live enumeration of every ASCII `]`-closed bracket** (both columns):
  `SELECT DISTINCT (regexp_matches(korean|english,'\[[^][]*\]','g'))[1] …` → **37 distinct**, and I
  hand-classified all 37 — every one is a genuine label (`[noun]`, `[past tense]`, `[subject marker]`,
  `[be]`, `[p.p.]`, `[polite/formal]`), a slot (`[A]/[B]/[D]/[S]`), an English fragment
  (`[a friend and a movie]`, `[More calm and neutral]`, `[often/fast/early/soon/etc...]`), or a
  Korean-bearing note (`[NOT 그렇은]`, `[verb: 가다]`, `[verb stem + -는 것]`). **Zero romanization
  among the 37.** The coordinator's claim holds *for this query's scope*.
- **Corpus diff (round-1 vs round-2 inline `_is_romanization`):** 168 distinct forms (357 occurrences)
  that round 1 kept are now correctly stripped — `ne`(×11), `i`(×17), `ga`(×11), `da`(×10), `aniyo`,
  `jondaetmal`, number glosses `baek / 100`, `cheon = thousand`, etc. This is the 243/303 leak, gone.

**But "zero romanization anywhere" is false.** My round-1 review warned that my *own* verify query
shared the parser's blind spot; the coordinator's 37-bracket query (`\[[^][]*\]`) has the same one — it
only matches ASCII `[`…`]`. Probing the delimiter forms it misses:

```
-- slash-delimited romanization  /xxx-xxx/
SELECT count(*) … WHERE korean ~ '/[a-z-]+-[a-z-]+/' OR english ~ '/[a-z-]+-[a-z-]+/';   -- 13
-- fullwidth-bracket romanization  ［ … ］  (U+FF3B/U+FF3D, not ASCII '[')
SELECT count(*) … WHERE korean ~ '［' OR english ~ '［';                                   -- 3
-- 3+-syllable hyphen-chain anywhere (romanization hallmark)
SELECT count(*) … WHERE korean ~ '[a-z]+-[a-z]+-[a-z]+' OR english ~ '[a-z]+-[a-z]+-[a-z]+'; -- 13 (1 = "know-it-all" false pos)
-- dedup across all channels, minus the "know-it-all" English false positive
SELECT count(DISTINCT id) …;                                                              -- 20
```

The 20 residual leak rows, by channel:
| channel | rows | example (id, lesson) |
|---|---|---|
| slash-delimited `/…/` inside parens | 13 | `(Verb: 앉다 /an-da/ to sit)` — id 72735, L139-140 |
| fullwidth brackets `［…］` | 3 | `갔을 리가 없어요［ga-sseul li-ga eop-seo-yo］` — id 70600, L85 |
| parenthesized romanization `(…)` | ~3 | `돈을 모아서 뭐 할 거예요? (do-neul mo-a-seo mwo hal geo-ye-yo?)` — id 69701, L62; `(dong-yeong-sang)` id 70706; `(gwaen-ha-da)` id 70712 |
| **bracket + Hangul short-circuit (NEW round-2 regression)** | 1 | `Present Tense: 이상해요 [i-sang-hae-yo) (NOT 이상하여요)` — id 67712, L17 |

The slash / fullwidth / paren channels (19 rows) never involve an ASCII `[…]` and so leaked in **every**
round — they are pre-existing and orthogonal to the bracket heuristic that was the scoped fix, but they
are romanization sitting in the shipped "no romanization anywhere" table. The **one genuinely new**
round-2 leak is `id=67712`: the bracket `[i-sang-hae-yo) (NOT 이상하여요)` (closed on `)`, greedy content
spans to the final `)`) contains *both* romanization and Hangul; round 2's `HANGUL_RE` short-circuit
(`load_ttmik_transcript.py:135-136`) keeps the whole bracket, romanization included. Round-1 code
stripped this exact bracket (its content has the `[a-z]-[a-z]` hyphen-join) — confirmed by the corpus
diff ("round-1 stripped but round-2 keeps: `i-sang-hae-yo) (NOT 이상하여요`", 1 occurrence). So the new
Hangul short-circuit, while correct for pure glosses, regresses this mixed romanization+Hangul bracket.

### BLOCKER-2 (over-strip) — **NEW over-strip of 4 legit English brackets** (small)

The 37 surviving ASCII brackets prove no *label* was wrongly deleted. But the corpus diff surfaced 4
inline **English-annotation** brackets that round 1 kept and round 2 now deletes, because "strip by
default" fires and `_ENGLISH_HINT_RE` (`...`/`etc`/`and`/`or`/`the`) does not match them:

| bracket (round-1 KEPT → round-2 STRIP) | line before → after |
|---|---|
| `[more common in written language]` | `- 항상 [hang-sang] = always [more common in written language]` → `- 항상 = always` |
| `[more common in spoken language]` | `- 맨날 … all the time [more common in spoken language]` → `- 맨날 … all the time` |
| `[one's]` | `take off [one's] shoes` → `take off shoes` |
| `[watching them]` | `…you can't quit [watching them] easily.` → `…you can't quit easily.` |

These are legitimate English — a register annotation (the *entire* pedagogical point of the 항상-vs-맨날
contrast is "written vs spoken"), a placeholder, and a clarifying gloss — deleted from a column the
migration documents as "lossless verbatim." Same defect class as the original BLOCKER-2, reintroduced at
~4-row scale (down from 76). `_ENGLISH_HINT_RE` is an incomplete allow-list for prose fragments; it
needs a broader English-detection signal (e.g. ≥2 dictionary words, or a space-separated multi-token
all-lowercase-ASCII run that isn't a romanization hyphen-chain).

### New parametrized tests — **GREEN and falsifiable**, but blind to the residuals

`pytest tools/ingest/tests/test_load_ttmik_transcript.py` → **45 passed** (was 30 passed / 2 failed;
the 2 stale `test_classify_line_cases` for `가다 [ga-da]` / `맛있다 [ma-sit-da]` are fixed — their
expectations now reflect the stripped Korean, which is correct). I re-ran the 6 new non-hyphenated
cases (`네. [ne]`→`네.`, `이 [i]`→`이`, `아니요`, `존댓말`, `일 [il = one]`) against the round-1
`_strip_inline_rom`: **6/6 FAIL** — the new tests genuinely catch the round-1 blocker. Good falsifiable
coverage of the bracket channel. **Gaps:** no test covers (a) slash/fullwidth/paren romanization, (b)
the Hangul-short-circuit-with-embedded-romanization case (`[i-sang-hae-yo) (NOT 이상하여요)`), or (c) the
newly over-stripped English phrases (`[more common in written language]`, `[watching them]`) — so the
green suite does not backstop any of the residuals above.

### Regressions — clean

- **Counts:** 9,526 rows / 232 distinct lessons — matches the commit claim and an independent
  from-scratch re-parse of the source PDFs exactly.
- **Ordinal contiguity:** 0 bad lessons (`HAVING count(*) <> max(ordinal) OR min(ordinal) <> 1`).
- **`kind='romanization'`:** 0 (standalone bracket-only lines still dropped at parse time, as designed).
- **Endpoint / reading.ts SHOULD-FIX items** from round 1 remain in place (unchanged by `b78a250`).

### Recommendation

**Shippable for the bracket blocker; two residual tickets before the "zero romanization anywhere" claim
can be made truthfully.** The allow-list rewrite is the right design and demonstrably kills the round-1
243/303 leak. Before the directive is literally satisfied: (1) extend stripping beyond ASCII `[…]` to
the slash/fullwidth/paren romanization channels (19 pre-existing rows, concentrated in L139-140 slash,
L85 fullwidth) and fix the new `id=67712` Hangul-short-circuit leak by stripping any romanization
sub-span even inside a Hangul-bearing bracket; (2) tighten the English-fragment allow-list so
`[more common in written language]` / `[watching them]` / `[one's]` are kept (4-row over-strip); (3) add
regression tests for all three. If the coordinator scopes round 2 strictly to the ASCII-bracket leak the
round-1 review named, this is a PASS; scoped to the migration's literal "no romanization anywhere"
contract, 20 romanization rows still ship, so it is PASS-WITH-CONDITIONS at best.

---

## Round 3 re-review

**Fix commit:** `16ace8a` ("fixpass round 3: strip romanization across ALL delimiters + fix
over-strip/regression"). **Method:** SELECT-only queries on the reloaded live table; an independent
from-scratch delimiter sweep (fullwidth / slash / paren / naked / mixed-with-Korean, not just ASCII
`[…]`); a diff of the round-3 vs round-2 `_strip_inline_rom` on the 6 new test cases; and a `pytest`
run in a throwaway venv.

### Verdict: **PASS WITH CONDITIONS**

Every channel the round-2 review flagged is **genuinely fixed** — fullwidth `［…］`, slash `/an-da/`, the
`(dong-yeong-sang)` paren class, and the `id=67712` `[i-sang-hae-yo) (NOT 이상하여요)` regression all
verify to **0** by my own queries, and the 4 over-stripped English brackets from round 2 are restored
(3 of them). But my deeper delimiter sweep — the kind I flagged twice as the thing that keeps getting
missed — surfaces **3 residual romanization rows** the "= 0 across every channel" claim does not cover,
plus **1 over-strip the commit claims to have fixed but did not** (`[one's]`, a curly-apostrophe miss).
The magnitude is now ~4 rows out of 9,524 (0.04%), down from round-2's 24 and round-1's 130–243 — a
strong convergence, and none of the 4 destroys a line's primary Korean/English content. So: shippable
with two small follow-ups; "zero romanization anywhere" is still not *literally* true.

### BLOCKER-1 (romanization leak) — round-2 channels **FIXED**; 3 new residual rows found

Confirmed fixed by direct query on the reloaded table:
```
fullwidth ［…］ :  WHERE korean~'［|］' OR english~'［|］'                              -> 0
slash /xx-yy/  :  WHERE korean~'/[a-z]+-[a-z]' OR english~'/[a-z]+-[a-z]'           -> 0
3+ syllable chain: WHERE (…~'[a-z]+-[a-z]+-[a-z]+') minus 'know-it-all'             -> 0
id 67712 (이상해요 [i-sang-hae-yo)…): WHERE korean~'i-sang-hae-yo'                    -> 0 rows
ASCII bracket enumeration (both cols)                                              -> 40 distinct, all legit
```
The 40 surviving ASCII brackets are all genuine (labels `[noun]`/`[past tense]`/`[subject marker]`,
slots `[A]/[B]/[D]/[S]`, English fragments `[a friend and a movie]`/`[More calm and neutral]`/
`[often/fast/early/soon/etc...]`, Korean notes `[NOT 그렇은]`/`[verb: 가다]`, and the 3 restored
`[more common in written/spoken language]`/`[watching them]`). The round-2 delimiter work is correct.

**But "zero romanization across EVERY delimiter" is refuted** — 3 rows still leak, via channels the
round-3 rules structurally don't cover (all confirmed by an independent paren/mixed sweep):

| # | lesson | id | leaked romanization | why it survives |
|---|---|---|---|---|
| 1 | L1 L22 | 77398 | `( 현재 시제: hyeon-je si-je)` + `(과거 시 제: gwa-geo si-je)` | `_paren_is_romanization` returns False when the parenthetical contains Hangul — but here the paren holds the Korean term **and** its romanization pronunciation guide after a colon, so the romanization rides along, kept. Exactly the mixed-content class as the `id=67712` bracket regression, one delimiter over (parens, not brackets). |
| 2 | L2 L25 | 78601 | `(-n-ga)` | `_paren_is_romanization` requires **≥2** latin hyphen-joins; `-n-ga` has one (`n-g`), so it falls below the threshold and is kept. Any single-syllable-pair paren romanization leaks. |
| 3 | L5 L28 | 82065 | `…없다 l su ba-kke eopda]` | The PDF text-extraction dropped this bracket's opening `[`, leaving naked romanization `l su ba-kke eopda` + a stray `]`. No opener → the bracket pass never matches it; not slash- or paren-wrapped either. |

Sweep confirming completeness: a query for *any* parenthetical carrying both a Hangul char and a latin
hyphen-join returns **only** id 77398 (2 instances); the single-hyphen-paren sweep returns only id 78601
(`-n-ga`) besides the correctly-kept English `(make-up)`. So the residual is these 3 rows, not a broad
class. Note the `[a-z]-[a-z]` sweep otherwise returns 95 rows that are all **legitimate** — English
hyphenated words (`well-being`, `make-up`, `ex-boyfriend`, `know-it-all`, `part-time`, `e-mail`) and
romanized proper **names inside English translations** (`Kyeong-eun`, `Kyung-hwa`, `So-yeon`) — which
must be kept (stripping them would gut the English prose), so the parser is right to leave those.

### BLOCKER-2 (over-strip) — 3 of 4 restored; **`[one's]` NOT fixed (curly-apostrophe miss)**

The 40-bracket enumeration confirms `[more common in written language]`, `[more common in spoken
language]`, and `[watching them]` are all back, and the English parentheticals `(make-up)`/`(room)`/
`(to move)`/`(image)`/`(owner)` are intact (ids 80002-80012). But **`[one's]` is still over-stripped.**
The corpus token uses a curly apostrophe `[one`+U+2019+`s]`, while the widened `_ENGLISH_HINT_RE`
matches `'s\b` with a **straight** ASCII quote — so it misses the real token:
```
_strip_inline_rom("take off [one’s] shoes")   -> "take off shoes"      # curly (as in corpus) — STILL STRIPPED
_strip_inline_rom("take off [one's] shoes")    -> "take off [one's] shoes"  # straight — kept
```
`[one's]` does not appear in the 40-bracket live enumeration, confirming it was stripped on reload
(lesson content degraded from "take off [one's] shoes" to "take off shoes"). The commit's claim
"`[one's]` restored" is false. **This also exposes a test gap:** the new
`test_strip_inline_rom_multi_delimiter` asserts `("[one's]", "[one's]")` with a **straight** apostrophe —
a placeholder that passes while the real curly-apostrophe corpus token fails (the project's own
"test with real corpus data, not placeholders" rule). Fix: make `_ENGLISH_HINT_RE` accept both quote
forms (`['`+U+2019+`]s\b`) and change the test to the curly corpus token.

### Tests — GREEN and load-bearing

`pytest tools/ingest/tests/test_load_ttmik_transcript.py` -> **57 passed** (was 45). The 6 new
`test_strip_inline_rom_multi_delimiter` cases (slash, paren, sentence-in-paren, the `[i-sang-hae-yo)`
mixed bracket, and the English keeps) all **FAIL on round-2 code** (6/6, verified against the extracted
`b78a250` `_strip_inline_rom`) — genuinely falsifiable coverage of the delimiter fixes. The only test
weakness is the straight-vs-curly `[one's]` placeholder noted above; no test covers the 3 residual leak
shapes (colon pronunciation-guide in a Korean paren, single-hyphen paren, opener-less mangled bracket).

### Regressions — clean

- **Counts:** 9,524 rows / 232 distinct lessons (matches commit + independent re-parse).
- **Ordinal contiguity:** 0 bad lessons (`HAVING count(*) <> max(ordinal) OR min(ordinal) <> 1`).
- **`kind='romanization'`:** 0. **English parentheticals** `(make-up)`/`(room)` preserved.

### Recommendation

**Shippable; two small follow-up tickets to make "zero romanization anywhere" literally true.**
The delimiter-expansion is the right design and demonstrably closed every round-2 channel. Remaining:
(1) the 3 residual leak rows — strip romanization even when it rides *inside* a Korean-bearing
parenthetical after a colon (id 77398, mirror the bracket-level Hangul-AND-hyphen-join fix onto parens),
lower or special-case the single-hyphen paren threshold for `-x-y`-marker forms (id 78601), and handle
the opener-less mangled bracket (id 82065, a PDF-extraction artifact — e.g. strip a naked
`\bl?\s?[a-z]+-[a-z]+…]` trailing a Korean grammar token); (2) the `[one's]` curly-apostrophe over-strip
+ its placeholder test. All four are edge cases affecting 4 rows / 0.04% of the corpus and none destroy
a line's primary content — a reasonable ship-then-ticket call, but the literal "no romanization
anywhere" contract is not yet met.
