# P3b Batches A+B — independent review (shared components + nav + Today/Progress/Diagnostic)

Reviewer: independent (did not write this). Commits: `17768d3` (A), `f919cb1` (B), branch `feat/overhaul-p3-language`.
Refs: `db/docs/OVERHAUL_P3b_BUILD.md` §Rules, `db/docs/KOREAN_CHROME_GLOSSARY.md`, `client/src/components/Bilingual.tsx`.
Verification run (docker, node:20-slim): `tsc -b --force` = 0, `eslint` = 0, vitest slice
(Today/Progress/Diagnostic + components) = **277/277 pass (31 files)**.

## VERDICT: PASS — no blockers. 2 SHOULD-FIX (both Korean-consistency, not correctness), rest nits.

The four probed risks all come back clean:

1. **Content leak — NONE.** Grepped both diffs and the post-B state of every sliced file. Everything
   wrapped in `<Bilingual>` is chrome (eyebrows, titles, section labels, buttons, pills, empty/loading
   states, table captions/headers, pager text). Verified NOT wrapped: TaskCard `title` (Korean task
   content, stays on `.kr km-taskcard__title` — explicitly excluded in the P3b comment,
   `TaskCard.tsx`), WeeklySuggestions rows (`entry.korean` / `entry.english` / `pattern.pattern` /
   `title_en` render plain, `WeeklySuggestions.tsx:154-190`), Diagnostic `item.prompt` (:766),
   `item.passage` (:775), choices, `reveal.explain` (:805), Progress mastery word list (only the FSRS
   bucket NAME is bilingual — the words themselves plain, `Progress.tsx:1247-1253`), Diagnostic level
   pill `{item.level}` plain. Skill-domain section LABELS (`읽기 · Reading` in `INTRO_SECTIONS`,
   `sectionLabel()`, `SECTION_LABELS`) are chrome per the build-doc rule — correctly wired.

2. **Broken / half-wired — NONE.** Every `<Bilingual>` call site in the slice supplies both `en` and
   `kr` except two deliberate optionals, both of which ride the primitive's documented
   missing-language fallback (renders whatever exists, never blank): `ComingSoonPanel.krCopy`
   (additive optional prop; both Today call sites pass it, `Today.tsx:435/450`) and
   `SkillsCompare` legend `activeRef.kr` (`SkillsCompare.tsx:183`). No site can render blank in any
   of en/ko/both. Prop contracts held: `TaskCardProps` unchanged (`skill`/`krTag`/`title`/`mins`…),
   `SkillBar`/`SkillsCompare`/`LibrarySubnav` props untouched, `ComingSoonPanel` change is additive
   only — Batch C (`ead4109`) touches zero sliced files, confirming no cross-batch coupling.
   `Topbar.eyebrow` is `ReactNode` so Today's `<Bilingual>` eyebrow is type-sound. The locale-keyed
   single date formatter (`formatDateEyebrow(d, locale)`, `Today.tsx:63-71`) is a nice
   can't-drift design. `formatDay` (`Progress.tsx:150`) emits numeric `M/D`, so the Korean readout
   half isn't polluted with an English month name.

3. **Trims — no needed info lost.**
   - Progress eyebrow-repeats-title cuts (Word mastery, Grammar mastery, Progress-by-skill,
     All-attempts, CompareCard): each cut removed pure redundancy; the load-bearing meta survived in
     the eyebrow (`Last 30 days`/`최근 30일`, `Oldest first`/`오래된 순`, `Latest attempt`,
     `Derived from your gaps`). Test-pinned (`Progress.test.tsx:628-658`).
   - Diagnostic intro eyebrow: dropped the `진단평가 ·` prefix that the `h1` directly below repeats;
     kept `N분 · N문항` meta. Correct.
   - ComingSoonPanel copies: "Due grammar patterns queue here." / "Mock-exam picks based on your
     practice." — flavor removed, promise kept.
   - Word-mastery empty state: "add words from Listen and their mastery shows here" preserves the
     instruction (where to add words); only the tap-mechanics tour was cut.
   - **DoneBlock honesty fix is correct and not lossy** (`Diagnostic.tsx:1040-1048`): the old
     "Comparing against TOPIK II L4 reference." was factually wrong for beginner runs (results pick
     their reference dynamically, defaults L2) — same dishonest-literal class as B-007. "Your results
     are ready." / "결과가 준비됐어요." removes misinformation, not information, and a regression
     guard pins `/Comparing against/` absent (`Diagnostic.test.tsx:127-129`).
   - Borderline (see N-3): WeeklySuggestions hint dropped "Tap Add to bank a card".

4. **Korean quality — nothing clearly WRONG.** All new Korean is grammatical, in the glossary's
   register (해요체 empty-states, bare-noun eyebrows, terse verb-noun buttons). Glossary terms match:
   mastery→숙달, review→복습, Grammar→문법, Vocabulary(skill)→어휘, Coming soon→준비 중,
   Loading…→불러오는 중…, Retake diagnostic→진단 다시 하기, Sections/Skill→영역, due→복습 예정,
   appearance→화면 표시, Resume→이어서 하기, Skip→건너뛰기, Retry→다시 시도, mock exam→모의시험,
   "Start X to see your progress"→성장을 보려면 쓰기를 시작하세요 (template verbatim). Counters are
   right (카드 N장, N문항, N회차, 표제어 5.4만). Consistency divergences below (S-1, S-2, N-1, N-2).

## Findings

### BLOCKER
None.

### SHOULD-FIX
- **S-1 · `client/src/pages/Diagnostic.tsx:1113` — "띠" for confidence bands, inconsistent with the
  same screen's legend.** The results sub-line reads "띠는 각 결과의 신뢰도를 보여 줘요", but the
  SkillsCompare legend rendered directly below it calls the same visual element 신뢰 구간
  (`SkillsCompare.tsx:196`, "Confidence band"). 띠 (sash/strip) alone is an odd word for a chart
  confidence band and the ko-mode user sees both terms for one thing on one screen. Suggest
  "신뢰 구간은 각 결과의 신뢰도를 보여 줘요" (or 밴드). Style-adjacent, but this is a same-screen
  term mismatch, not a taste call.
- **S-2 · `client/src/components/SkillsCompare.tsx:143` — picker leaves "Native" EN-only in ko-mode
  although `r.kr` (원어민) is already on the prop and 원어민 is a glossary entry.** The code comment
  (:111-116) documents the deferral (TOPIK is a proper noun; kr surfaces in the legend), and page
  tests pin the accessible names — so this is a conscious call, not an accident. But per the build
  rule ("every EN-only chrome label gets a kr"), the segmented picks are chrome with the Korean
  sitting unused one field away; `<Bilingual compact>` would fit the tight strip. Fine to fold into
  the long-tail top-up, but it should be on that list explicitly.

### NIT
- **N-1 · `client/src/pages/Diagnostic.tsx:886 vs :1059`** — "See results" and "See gap map" (two
  consecutive, differently-named EN CTAs) both render kr "결과 보기". Not wrong, but ko-mode loses
  the distinction EN keeps; consider 결과 확인 for one of them.
- **N-2 · `client/src/pages/Today.tsx:170/193/207`** — 모의시험 and 모의고사 both appear inside the
  one exam card ("듣기 모의시험" vs "Mock exams 모의고사" / "모의고사 열기"). Both are correct
  Korean and the glossary itself sanctions both in different slots, but within a single card one
  term would read tighter. Related low-grade divergence: "Where you are"→현재 위치
  (`Diagnostic.tsx:1119`) vs "Where you stand"→현재 실력 (`Progress.tsx:599`) — near-identical EN,
  two Korean renderings; both natural in context.
- **N-3 · `client/src/components/WeeklySuggestions.tsx:136-141`** — the trim dropped "Tap Add to
  bank a card". The essential guarantee ("nothing is added automatically") survives and each row
  carries a labeled Add button, so no needed info is truly lost — noting it as the one trim that
  removed an instruction rather than pure redundancy.
- **N-4 · ko-mode loading strings lose specificity** — "Loading this week's picks…" / "Loading word
  mastery…" / "Loading skill trends…" all map to generic "불러오는 중…" (glossary-sanctioned, so
  acceptable; just noting ko-mode is flatter than en-mode here).
- **N-5 · `client/src/lib/nav.ts:158`** — "Production drill" ↔ 문형 연습 ("pattern practice") is a
  semantic drift rather than a translation; likewise "Word roots" ↔ 한자 어원 ("Hanja etymology",
  :177-178). Both defensible eyebrow-register choices; listing for Jared's uncertain-Korean pass.
- **N-6 · `client/src/pages/Diagnostic.test.tsx`** — anchored button matchers loosened
  (`/^submit$/i` → `/submit/i` etc.). Necessary, since accessible names are now bilingual
  ("제출 · Submit"); no ambiguity risk on these screens (one submit-named control at a time), so
  not a real weakening.

### PRAISE
- **P-1** — The content/chrome boundary is handled with visible care: TaskCard's doc comment
  explicitly keeps `title` out of the primitive; Progress's `BUCKET_META` comment distinguishes
  bucket NAME (chrome) from bucket contents (words); Diagnostic's section-label comment cites the
  scope rule. Nothing leaked anywhere in the slice.
- **P-2** — `nav.test.ts:94-109`: asserting every `krEyebrow` contains actual Hangul and obeys the
  glossary's no-trailing-punctuation register is exactly the guard that stops a copy-pasted English
  string from silently defeating ko-mode.
- **P-3** — A11y held throughout: the sr-only both-languages mechanism is never bypassed (the only
  aria-label overrides are the pre-existing WeeklySuggestions Add buttons, which the primitive
  documents as "parent label wins"); `dg-intro-h`/`dg-done-h`/`dg-results-h`/`progress-title` id
  wiring intact; the Progress table caption stays AT-only (`Progress.css:233-239`) with its EN half
  keeping the table's accessible name stable for existing queries.
- **P-4** — The DoneBlock fix pairs the copy change with a negative regression test
  (`queryByText(/Comparing against/)`), and the Today date eyebrow derives both languages from one
  locale-keyed formatter so the pair can never drift.
- **P-5** — CSS discipline per the rules: new rules are scoped and flagged (index.css edits called
  out in both commit messages), orphaned kr-tag rules explicitly parked for the dead-rule sweep.

## Uncertain-Korean list for Jared (consolidated from this slice)
띠 (→ 신뢰 구간?, S-1) · 결과 보기 ×2 (N-1) · 모의고사/모의시험 mix (N-2) · 현재 위치 vs 현재 실력
(N-2) · 문형 연습 for "Production drill" (N-5) · 한자 어원 for "Word roots" (N-5) · 아쉬워요 for
"Not quite" (fine, friendly — confirm register) · 시작/끝 for the From/To pickers (`Progress.tsx`)
· 간단 실력 추정 for "Quick placement estimate" (headline-compressed; 간단한 would be softer).
