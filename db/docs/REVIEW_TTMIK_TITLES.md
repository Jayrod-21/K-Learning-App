# Review: TTMIK Lesson Titles (232 entries)

Independent bilingual review of `tools/ingest/data/ttmik_lesson_titles.json` and the live
`ttmik_lessons.title` column it backfilled. Read-only audit; no files were changed.

## Verdict

**PASS, with 3 SHOULD-FIX items and 0 BLOCKERs.** All 232 titles are present, unique, within
length/word bounds, and every DB row's title matches the file. Every title checked against
actual lesson content (20-lesson random sample spanning all 9 levels, plus 5 more spot-checks
for DB/file parity) was factually accurate — no wrong grammar attributions, no misspelled
Korean grammar forms, no placeholders. The only defect class found is three lessons whose
titles are vaguer than the rest of the set ("Review and Practice" / "Vocabulary and Phrases")
where the file's own established pattern (naming the specific forms being reviewed, as done
in ~15 other review/drill lessons) was not applied. These are graded SHOULD-FIX rather than
BLOCKER because they are not factually wrong — the lessons genuinely are reviews — they are
just less informative than the standard the rest of the file sets.

## Sample checked (20 lessons, random across all 9 levels, seed 20260705)

Content pulled from `ttmik_sentences` (falling back to `ttmik_transcript_lines` when a lesson's
sentence table was empty/thin — happened for L7/M3, L8/M17, L9/M3, and thin for L6/M27,
L6/M28, L5/M15, L3/M15, L6/M8). All 20 verdicts: **accurate**.

| Level | Lesson | Title | Content check | Verdict |
|---|---|---|---|---|
| 1 | 11 | Making Polite Requests with NOUN + 주세요 | Lesson opens with 있어요/없어요 review then teaches 주세요 ("사과 주세요", "우유 주세요", "밥 주세요") | Accurate |
| 1 | 19 | Time Words: Today, Yesterday, Tomorrow, Now | 오늘/어제/내일/지금/아까/나중에 | Accurate |
| 2 | 6 | But or However: 그렇지만 vs 그런데 | Both conjunctions taught and contrasted | Accurate |
| 2 | 11 | Self-Introduction Patterns: Job, Hobby, and Family | 직업/취미/가족/친척, ABC은/는 XYZ patterns | Accurate |
| 3 | 3 | Location Words: 앞, 뒤, 옆, 위, and 밑 | Exactly those 5 words + 에 forms | Accurate |
| 3 | 8 | Similar vs Same: 비슷하다 and 같다 | Both verbs taught and contrasted | Accurate |
| 3 | 15 | In That Case, Then: 그러면 | 그러면/그럼 explained and drilled | Accurate |
| 4 | 28 | Becoming Something New: The -아/어/여지다 Ending | 예뻐지다/작아지다/이상해지다/재미있어지다 | Accurate |
| 4 | 30 | Sentence Drill: Comparisons and Past Modifiers | 보다/훨씬 comparatives + 산/만난/찍은 past-tense noun modifiers | Accurate |
| 5 | 15 | Settling for Second Best: -(이)라도 | Full -(이)라도 semantics + construction | Accurate |
| 6 | 8 | Saying 'I'm Not Sure If ...' with -(으/느)ㄴ지 | 잘 모르겠어요 + -(으/느)ㄴ지 fully covered | Accurate |
| 6 | 27 | Comparison: -(으)ㄹ 줄 알다 vs -(으)ㄹ 수 있다 | Transcript explicitly compares the two endings | Accurate |
| 6 | 28 | Saying 'It Depends' with -에 따라 and -마다 | -에 따라 다르다 / -마다 다르다 both taught | Accurate |
| 7 | 3 | Being Worth It or Bearable: -(으)ㄹ 만하다 | Transcript: "-(으)ㄹ 만하다... bearable to do" | Accurate |
| 7 | 26 | On Top of That: -(으/느)ㄴ 데다가 | 예쁜 데다가/바쁜 데다가/비싼 데다가 | Accurate |
| 8 | 1 | Idiomatic Eye (눈) Expressions: Part 1 | 눈이 높다, 눈 밖에 나다, 눈을 붙이다, etc. | Accurate |
| 8 | 17 | -만 아니면: If Only It Weren't For | Transcript: "-만 아니면...if only it's not" | Accurate |
| 8 | 21 | Idiomatic Head and Mind (머리) Expressions | 머리가 좋다/나쁘다, 머리를 쓰다, 잔머리 굴리다 | Accurate |
| 9 | 3 | Situational: Anger and Disappointment | "unhappy or upset," 열 받는 일, 화 나는데, 서운해요 | Accurate |
| 9 | 6 | Foot (발) Idioms: Ties, Detainment, and Triviality | 발이 넓다, 발 벗고 나서다, 발 디딜 틈이 없다 | Accurate |

## Findings

### SHOULD-FIX

1. **Level 1, Lesson 25 — "Level 1 Review: Vocabulary and Phrases."** Content is a genuine
   end-of-level vocab/phrase recap (no single grammar point), so the title isn't *wrong*, but
   it's the vaguest title in the set. Suggest something that names what's actually reviewed,
   e.g. "Level 1 Review: Core Verbs, Questions, and Numbers."

2. **Level 5, Lesson 11 — "Sentence Building Drill 2: Review and Practice."** Actual content
   drills 중에서 (among), 아무거나/아무나/아무것도 (any-), 너무, -아서/어서 (because), -자마자
   (as soon as), and 별로 — a real mixed-forms review, same genre as the "Practice Combining
   X, Y, Z" titles used consistently in Levels 6-9 (e.g. L6/M10, L6/M20, L7/M10). This lesson
   breaks that pattern by not naming any of the forms. Fix: retitle to name the actual forms,
   e.g. "Practice Combining 중에서, 아무거나, and -자마자."

3. **Level 5, Lesson 20 — "Sentence Building Drill 3: Review and Practice."** Same issue.
   Content drills 못 -ㄴ다고 하다 (reported "can't"), -(이)라도, -(으)려고 하다, and -(으)니까 —
   again a real multi-form review that should be named like its Level 6-9 counterparts. Fix:
   e.g. "Practice Combining -(이)라도, -려고 하다, and -(으)니까."

These three are the only titles in all 232 that fall back to a generic "Review"/"Practice"
label instead of naming the grammar content, so this is a narrow, easily-fixed gap rather than
a systemic problem — the file's own convention (seen in ~15 other review/drill lessons) already
shows the right pattern to copy.

### NIT

- None beyond the above — no stray capitalization, punctuation, or spacing issues found in the
  232 titles, and no Korean grammar-form typos were found anywhere in the sample or in the
  full-set regex scan.

## Invariants

| Check | Result |
|---|---|
| Total entries in JSON file | 232 — **pass** |
| Live `ttmik_lessons` row count | 232 — **pass**, matches file exactly |
| Rows with NULL/empty `title` | 0 — **pass** |
| Rows still matching `^Level \d+ Lesson \d+$` (placeholder) | 0 in file, 0 in live DB — **pass** |
| Case-insensitive duplicate titles (file) | 0 — **pass** |
| Case-insensitive duplicate titles (live DB, `GROUP BY lower(title)`) | 0 — **pass** |
| Titles > ~52 chars or outside 4-8 words | 0 flagged — **pass** |
| Generic filler ("Various Expressions," "More Grammar," bare "Review," "Miscellaneous") | 0 found — **pass** |
| Per-level counts (file) | L1:25 L2:30 L3:27 L4:27 L5:26 L6:26 L7:27 L8:30 L9:14 = 232 |
| Per-level counts (live DB) | Identical to file, per level — **pass** |
| DB-vs-file title parity spot-check (5 random lessons: L3/M4, L5/M7, L4/M15, L6/M16, L3/M15) | All 5 exact matches — **pass** |

## `parse_ttmik.py` wiring

`_load_lesson_titles()` (lines 129-140) reads `data/ttmik_lesson_titles.json`, builds a
`dict[(level, lesson) -> title]`, and is called once at module import time into module-level
`_LESSON_TITLES`. `parse_lesson_text()` (line 151) does
`_LESSON_TITLES.get((level, lesson)) or f"Level {level} Lesson {lesson}"` — correct: a missing
key or an empty/whitespace-only title falls back to the placeholder, so any lesson not in the
232 (or added later) still loads with a non-crashing default.

Failure-mode check:
- **File missing:** `_TITLES_PATH.exists()` guard returns `{}` — graceful, all lessons fall
  back to placeholders. No crash.
- **File present but invalid JSON:** caught by `except (OSError, ValueError)` (```json.JSONDecodeError``` is a `ValueError` subclass) — returns `{}` — graceful.
- **File present, valid JSON, but a record missing `"level"` or `"lesson"` key:** the dict
  comprehension does `int(e["level"])` / `int(e["lesson"])` with no `.get()` — this would raise
  `KeyError` **uncaught**, at import time, crashing any script that imports `parse_ttmik.py`
  (not just at parse-invocation time). This is a real but narrow gap: it only matters if a
  future hand-edit of the JSON drops a required key, which is unlikely but not defended against
  the same way the "file missing/corrupt" cases are. Not a blocker for the current 232-entry
  file (verified structurally intact — every entry has `level`, `lesson`, `title`), but worth a
  one-line hardening (`e.get("level")`/`e.get("lesson")` with a skip-and-warn on `None`) if this
  file is expected to be hand-edited going forward.
