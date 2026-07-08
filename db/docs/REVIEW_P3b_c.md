# Independent review — P3b Batch C (Review library + Chat/Settings + remaining pages)

Commit `ead4109` on `feat/overhaul-p3-language`. Reviewer: independent senior pass (React + Korean),
did not write the code. Refs: `db/docs/OVERHAUL_P3b_BUILD.md`, `db/docs/KOREAN_CHROME_GLOSSARY.md`,
`client/src/components/Bilingual.tsx`.

## Verdict: PASS — 0 blockers

The four probed risks come back clean at the blocker level: **no learning content is wrapped in
`<Bilingual>` anywhere in the diff**, every wired site degrades safely in all three modes, the two
title re-alignments landed on the nav manifest values with a11y intact, and no verbage cut dropped
information the user still needs. Verification: `tsc -b --force` = 0, `eslint` = 0, and the full
Batch C test surface passes in Docker (162/162 across Review/Settings/Chat/Hanja/Topik/review*, plus
87/87 across Ttmik/Images/Login/Mistakes/Writing/Reading/ReviewLibrary/MyVocabLists). Three
should-fix items — two Korean-consistency reconciliations and one coverage gap (the mock-exam flow)
— plus nits, below.

---

## 1. Content-leak probe (worst risk) — CLEAN

Checked every `<Bilingual>` call site in the diff against its data source:

- **Topik.tsx** — question text, passage, choices (`choice.kr`, `CHOICE_MARKERS`), the revealed
  correct answer (`correctChoice.kr`), and `item.section` / `current.section` all render raw. Only
  verdict eyebrows, buttons, counts, and the item-position eyebrow went bilingual (the section tag
  is deliberately left OUTSIDE the pair at Topik.tsx:417 — correct).
- **Review.tsx flashcards** — `card.kr`, `card.en`, `card.pos`, `card.mined_in`, KRDICT examples,
  `card.notes`, and `activeList.name` untouched. Only chrome (ratings, counts, drawer buttons).
- **review/ReviewDictionary.tsx** — dictionary rows untouched; only loading/empty states wired.
- **review/ReviewVocab.tsx** — `entry.korean`/`entry.english` and `list.name_kr` render raw
  (the add-to-list button correctly shows `list.name_kr` as-is when not pending).
- **review/ReviewGrammar.tsx** — `p.pattern`, `row.pattern`, summaries untouched.
- **Hanja.tsx** — `h.char`, `h.gloss`, `h.sound`, `h.en`, `h.note`, and compound words (`c.kr`)
  all raw; only section headings/pills/filters/buttons wired. The 한자 characters and readings are
  content, and stayed content.
- **Ttmik.tsx** — lesson/episode titles (`data.title`), hosts, transcript lines, highlights raw.
- **Images.tsx** — OCR'd words (`cap.words`) raw; only chrome around them.
- **Chat.tsx** — `msg.kr`/`msg.en` untouched; `HINT_STARTERS` (learning content) untouched.
- **Writing.tsx** — prompts and grade comments raw. The rubric-dimension headings
  (내용 및 과제수행 etc.) routed through `<Bilingual>` are TOPIK rubric *labels* — a pre-existing
  hand-composed kr/en pair, i.e. chrome per the build rules. Correct call.

## 2. Broken / half-wired probe — CLEAN

- **Every wired pair has both languages present** at the call site; the two dynamic-shape additions
  are total: `KIND_KR` covers all four `VocabListKind`s (MyVocabLists.tsx:36), `STATE_PILL_KR`
  covers all three `HanjaState`s (Hanja.tsx:68). `DetailData.krEyebrow` is populated on both corpus
  branches (Ttmik.tsx loadDetail). `EmptyCard.krMessage` is optional and both callers pass it; a
  missing `kr` falls back to EN by design (Bilingual.tsx:94–104) — never blank, never `undefined`.
- **Title re-alignments landed correctly.**
  - Review flashcards (Review.tsx:692): `복습 · Review` → `단어 카드 · Vocab`, exactly nav.ts's
    `headerTitle: '단어 카드 · Vocab'` (nav.ts:150). `titleId="review-title"` moved onto the Topbar
    h1, so the section's `aria-labelledby="review-title"` (Review.tsx:684) still resolves, and the
    h1 semantics are preserved by Topbar (Topbar.tsx:62). The eyebrow was dropped because the nav
    pair would repeat the new title and the old one was an FSRS impl leak — right call.
  - Topik (Topik.tsx:88): `학습` → `모의`, matching `headerTitle: '모의 · TOPIK'` (nav.ts:127) and
    freeing 학습 for the Study-mode toggle. Test asserts the level-1 heading name `모의 · TOPIK`.
  - The library index keeps `복습 · Review` (ReviewLibrary.tsx:91) — collision resolved.
- **Legacy ReactNode `krTitle` fully retired** in this slice: Ttmik, Images, ReviewVocab,
  ReviewGrammar, ReviewDictionary all moved to string `krTitle` + `title` + `titleId`, and their
  buried sr-only id spans were deleted. Grep confirms no `km-topbar__title-en` usage remains in any
  component (only the now-dead CSS class — see NIT).
- **Login pre-auth**: `useLanguageDisplay` explicitly does NOT throw outside `SettingsProvider` —
  it returns the 'both' defaults (useLanguageDisplay.ts:10–17 doc + implementation). Login renders
  today's baked look pre-auth. No crash; verified by the passing Login tests.

## 3. Cuts probe — nothing needed was lost

- **Settings impl-leak tooltip** (Settings.tsx:~975): `title="Showing locally-cached preferences…"`
  removed; `aria-label="Preferences not synced from server"` KEPT, so AT users keep the signal and
  the 🅂 marker remains for sighted users. Test asserts the tooltip is gone.
- **Mistakes empty state** (Mistakes.tsx:150): one line now, and the "nice work" reassurance
  survives in both languages (`잘하고 있어요`). The cut second line ("Missed TOPIK questions collect
  here…") is now conveyed by the nav eyebrow `Missed questions · 틀린 문제 모음`.
- **Review dup tooltip** → `LIST_ACTION_SOON_TITLE` const (Review.tsx:49), verbatim text — still
  tells the user the workaround ("use Add to review on the Lists tab"). Both buttons reference it.
- **Ttmik empties** consolidated to "No X yet." — each still names what's absent (오디오 / lesson
  text / 하이라이트 / 대본), and the audio one keeps the "read along below" guidance.
- **FSRS jargon** (Review.tsx:1284): "Seed FSRS review cards" → "Seed review cards"; the topbar
  "SRS · FSRS-style scheduling" eyebrow removed. Pure impl detail; nothing user-facing lost.
- **Reading trim** (Reading.tsx:34): the "coming with your book scans" context survives as
  "Graded passages from your scanned books will live here", and "Coming soon" survives as the nav
  eyebrow (`Coming soon · 준비 중`). The duplicate in-card 준비 중 eyebrow is correctly gone.
- **TopikImageNote** (TopikImageNote.tsx:33): `그림 · Image described in text` → `그림 설명 ·
  Image description`; the container's `aria-label="Image described in text"` keeps the fuller
  meaning for AT.

## 4. Korean quality + consistency

No grammatically wrong or mistranslated strings found. The big renderings are right:
다시/어려움/좋음/쉬움 are exactly the Korean Anki convention; 맞았어요/틀렸어요 are natural verdicts;
답장, 튜터, 나/내 답, 새 목록, 이름 변경/이름 저장, 정답 보기 · 스페이스바, 설명하는 글/주장하는 글,
총평, 채점하기, 준비 중, 복습 자료실 (used consistently across all three review/* pages) are all in
the glossary register. Glossary conformance spot-checks: Dictionary = 사전 ✓, Review library = 복습
자료실 (자료실 per nav) ✓, mastery/Maturity = 숙달 ✓, due = 복습 예정 ✓, pattern = 문형 ✓,
passage = 지문 ✓, Browse = 둘러보기 ✓, Rename = 이름 변경 ✓, Close/Dismiss = 닫기 ✓.

**화면 표시 / 외관 reconciliation: fully applied.** `grep -rn 외관 client/src` finds only the
Settings test that asserts its absence and one comment. Settings' Appearance group, the nav settings
eyebrow (`프로필 · 알림 · 화면 표시`), and the P3a control all agree on 화면 표시.

Inconsistencies found (all fixable with small string edits) — see findings below.

## a11y spot-checks

- Images dangling `aria-labelledby` — fixed for real: `section aria-labelledby="km-images-title"`
  (Images.tsx:232) now resolves to the Topbar h1 via `titleId="km-images-title"` (Images.tsx:238).
  Same pattern verified on Ttmik (`km-ttmik-title`), ReviewVocab/Grammar/Dictionary.
- `<Bilingual>` sr-only is never bypassed: single-language modes keep the bilingual accessible name
  (Bilingual.tsx:146–150), and the updated tests lean on it (e.g. computed names
  `문형 모으기 · Bank pattern`, `이름 변경 · Rename`).

---

## Findings

### BLOCKER
None.

### SHOULD-FIX
1. **"Bank" verb inconsistent with the glossary and the rest of the batch** —
   `client/src/pages/review/ReviewGrammar.tsx:434–441, 460–467`. ReviewGrammar renders Bank →
   모으기, Bank pattern → 문형 모으기, while Hanja.tsx:350 (`이 한자 모음에 추가`), Images.tsx:193
   (`모두 모음에 추가`), and Review.tsx:407 (`모두 모음에 추가`) follow the glossary's
   `Add to bank 모음에 추가`. Worse, it's mixed *within the same button family*: Bank = 모으기
   ("collect") but Banked = 추가됨 / Already banked = 이미 추가됨 ("added"). Pick the 모음에
   추가/추가됨 family (glossary-backed) and retire 모으기.
2. **"My lists" renders as two different Korean terms for the same server lists surface** —
   `client/src/pages/Review.tsx:1329` (`내 단어장 · My lists`, plus `내 단어장 관리` at :1341) vs
   `client/src/pages/review/ReviewVocab.tsx:576` (`내 목록 · My lists`) and MyVocabLists' 목록
   phrasing throughout. These are the same vocab lists; a user toggling to ko-mode sees two names
   for one thing. 내 단어장 was the pre-existing baked string, but 목록 is what the whole library
   surface now uses — reconcile (likely 내 단어장 → 내 목록, or add "my lists" to the glossary and
   sweep).
3. **Mock-exam flow chrome is entirely unwired — a batch-plan coverage gap, not a defect of this
   commit** — `client/src/pages/topik/MockMode.tsx` (0 `<Bilingual>` uses; e.g. "Submit test?"
   :1054, "Timed · live" :953, "N answered · X left" :609, results "Review" eyebrow :1359). The
   Batch C scope named `pages/Topik.tsx` but not `pages/topik/*`, and no other batch owns it, so
   after P3b "done" the mock flow — a top-level user surface — still ignores the language-display
   setting. Needs an owner (follow-up slice) before P3 is declared finished.

### NIT
4. `client/src/pages/Topik.tsx:695` — `${answered}개 답함` is awkward telegraphic Korean for chrome;
   prefer `답변 ${answered}개` (or `${answered}개 답변`).
5. `client/src/pages/Ttmik.tsx:849` — "No lesson text yet." → `아직 수업 내용이 없어요` uses 수업
   while every other Ttmik string says 레슨 (TTMIK 레슨, 아직 레슨이 없어요, 레슨을 불러오는 중).
   Suggest `아직 레슨 내용이 없어요`.
6. `client/src/pages/Review.tsx:1200` — "Grammar production" → 문법 만들기 reads as "making
   grammar". If this is production-drill in the SLA sense, 문법 생성 연습 or plain 문법 연습 is
   truer. Flag for Jared's list.
7. `client/src/pages/Hanja.tsx:142,` `STATE_PILL_KR.banked` — bare 모음 as a *status* chip label is
   ambiguous in a Korean-learning app (모음 also = "vowel", and it sits right next to 한자 content).
   It follows the glossary's bank = 모음, so this is a glossary-level question for Jared, but
   consider 저장됨 for the state reading.
8. `client/src/pages/Review.tsx:1064` — `<Bilingual en="Source · seen in" kr="출처" />`: the en half
   contains its own "·", so ko-primary both-mode renders "출처 · Source · seen in" (three apparent
   segments). Trim en to "Source" or "Seen in".
9. EN-only chrome left unwired in-slice without a committed flag list: EmptyCard `hint`s
   (Review.tsx:960, 1526), Review "Your custom lists live in…" body (:1330), Login ledes/MFA
   instructions, Settings ToggleRow/ChannelChip labels, Images upload-hint (:100), Hanja error/empty
   body copy (:102, 116, 127). Most were outside the batch's named scope and the `<Bilingual>`
   fallback makes them safe, but the build doc requires flagged strings to reach ONE collected list
   for Jared — the commit says "list in report" yet no P3b report/flag doc exists in `db/docs/`.
   Make sure that list actually lands somewhere durable.
10. `client/src/pages/Settings.tsx:937` — `한국어 마스터 · v0.2` is still a hand-composed pair (stays
    Korean-first in en-mode). Trivial; wire or leave deliberately.
11. `client/src/styles/index.css` — `.km-topbar__title-en` is now dead (no component references it).
    Remove in a cleanup pass.

### PRAISE
- The 합쇼체 register cue kept OUTSIDE the bilingual pair (Chat.tsx:863) — exactly right; it names
  the target register and must not disappear in en-mode.
- Both title collisions were fixed *by aligning to the nav manifest* rather than inventing new
  strings, with `titleId` moved onto the h1 so every `aria-labelledby` stays stable across display
  modes — and tests assert the computed heading names.
- Rating labels use the established Korean Anki convention rather than literal translations.
- The new tests are real behavioral assertions (외관 absence, tooltip removal, per-mode Korean,
  bilingual computed a11y names), not snapshot padding.
- Content discipline is flawless across the most dangerous pages (Topik reveal, dictionary rows,
  KRDICT examples, Hanja compounds, OCR words).

## Test evidence

Docker (`node:20-slim`), repo mounted read-write with isolated `node_modules`:
- `npx tsc -b --force` → exit 0; `npm run lint` → exit 0.
- `vitest run` Review/Settings/Chat/Hanja/Topik/review* → **9 files, 162/162 passed**.
- `vitest run` Ttmik/Images/Login/Mistakes/Writing/Reading/ReviewLibrary/MyVocabLists → **8 files,
  87/87 passed**.
