# Korean chrome — for Jared to verify (P3b)

The Korean I authored for UI chrome during P3b. All of it is grammatical + standard-register; these
are the renderings where a NATIVE/learner eye might prefer a different word or nuance. Content
(vocab/grammar/examples/TOPIK/dictionary/Hanja) was NOT touched. Fix anything you don't like — I'll
apply your corrections to the glossary + everywhere. **Canonical terms locked in the fixpass** (already
consistent app-wide): Bank **담기** / Banked **담김** / Add-to-bank **모음에 추가** · My lists **내 단어장** ·
Mock/TOPIK exam **모의고사** · Confidence band **신뢰 구간** · Native **원어민**.

## Highest-value to check (loanwords + nuance)
- **튜터** (Tutor — Chat: 튜터 대화, 튜터 bubble label). Loanword. Alt: 선생님 / 선생.
- **세션** (Session tab, Review flashcards). Loanword. Alt: 학습 세션.
- **레슨 / 에피소드** (Ttmik: TTMIK 레슨, 이야기 에피소드). Loanwords. Alts: 강의 / 화(회).
- **캡처 / 스캔** (Images: capture/scan). Loanwords — probably fine for a photo feature.
- **다시 / 어려움 / 좋음 / 쉬움** (flashcard ratings Again/Hard/Good/Easy) — the Anki-Korean convention. OK?
- **틀렸어요 / 맞았어요** (Topik verdict Not quite / Correct) — 틀렸어요 is blunter than "Not quite". Prefer 아쉬워요?
- **나 / 튜터** (Chat bubble labels You / Tutor) — 나 = "me". OK for own messages?

## Counters / units
- 카드 **N장** (flashcards) · **N획** (Hanja strokes) · **N문항 / N개 답변** (questions/answered) ·
  **N과** (Ttmik lesson) · **N화** (Iyagi episode) · **표제어 5.4만** (54k dict entries — number style?).

## Section / page labels
- **현재 실력** (Where you stand) · **현재 위치** (Where you are) · **실력 요약** (Skills snapshot) ·
  **실력 추이** (Progress by skill) · **간단 실력 추정** (Quick placement estimate) · **회차** (attempt —
  최신 회차/전체 회차/회차별) · **약점 기반** (Derived from your gaps) · **약점 지도 보기** (See gap map) ·
  **숙달** (mastery) · **신규** (New) · **복습 자료실** (Review library) · **오늘의 과제** (Today's tasks).

## Empty / status states
- **아직 데이터가 없어요** · **아직 없어요** · **불러오는 중…** · **준비 중** (coming soon) ·
  **다시 시도해 주세요** · **최근 30일간 틀린 문제가 없어요 — 잘하고 있어요** (Mistakes empty) ·
  **새로고침하지 못했어요 — 마지막으로 불러온 내용이에요** (stale) · **진행 중인 시험 확인 중…** ·
  **스캔한 책의 지문이 여기에 담길 예정이에요** (Reading placeholder).

## Page-specific
- **Diagnostic**: 정답 확인 중 (Reviewing your answer) · 결과가 준비됐어요 (Your results are ready) ·
  신뢰 구간은 각 결과의 신뢰도를 보여 줘요 (bands sentence — 띠 replaced in the fixpass to match the
  legend) · 객관식이에요… (intro hint) · 약점 지도 보기 (See gap map — new in the fixpass, so
  "See results" 결과 보기 and "See gap map" stop sharing one Korean).
- **Progress**: 최근 30일 · 실력 추이 · 오래된 순 (Oldest first) · 문형별 숙달도가 여기에 표시될 거예요.
- **Today**: 지금 복습 (Due now) · 복습할 카드 N장 · 선택과 타이머 저장됨 (picks & timer saved) ·
  ko-KR date eyebrow "7월 7일 월요일".
- **Review/Vocab/Grammar**: 현재 목록 (Active list) · 출처 (Source) · 복습에 추가 (Add to review) ·
  내 단어장에 추가 (heading) · 문법 만들기 (Grammar production — reads "making grammar"; prefer 문법 산출?) ·
  혼합 (mixed list kind) · 교재 단어장 (From sources / textbook wordbook).
- **Chat**: 답장 (Reply) · 합쇼체 (register cue — content-ish, kept).
- **Settings**: 화면 표시 (Appearance) · 받을 알림 (Send me) · 채널 (Channels) · 한지 기본값으로 (Reset to Hanji).
- **Writing**: 설명하는 글 / 주장하는 글 (Q53/Q54 rubrics) · 새 과제 (New prompt) · 고쳐서 다시 채점 (Revise & regrade) · 총평 (Overall).
- **Hanja**: 한자 어원 (Word roots — 어원=etymology) · 접한 한자 (Encountered) · 색인 (Index tab) ·
  복합어 (Compound words) · 열리는 단어 (Words you unlock) · 눌러서 어원과 연습 보기 (tap to see…).
- **Images**: 촬영 또는 업로드 · 샘플로 해 보기 · 인식된 단어 (Detected words) · 단어 N개 인식 · 그림 설명 (Image description).
- **Login** (pre-auth, renders in 'both' default): the EN halves I added to Welcome / Create account / Verification code / Two-factor / Recovery codes.
- **Mock exam (MockMode — wired in the fixpass)**: NEW Korean, please eyeball:
  - **실전 · 시간 제한** (the red "Timed · live" pill — is 실전 the right "live/real-conditions" word?)
  - 영역을 골라 시간 제한 모의고사를 풀어 보세요. 답은 제출한 뒤에 채점돼요 — 시험 중에는 정답을
    볼 수 없어요. (section-select lead)
  - N문항 · N분 (section-card meta) · 모의고사를 불러오는 중… · 채점 중… (matches Diagnostic's Scoring…)
  - **시험을 제출할까요?** (Submit test? confirm headline) · 전체 N문항 중 N문항에 답했어요. 답하지 않은
    문제는 오답으로 처리돼요. 제출하면 되돌릴 수 없어요. (confirm body) · **계속 풀기** (Keep going) ·
    시험 제출 (Submit test) · 제출 (Submit)
  - 이전/다음 (Prev/Next) · 답변 N / N (n of total answered) · 읽기/듣기 · N / N (progress line)
  - 읽기/듣기 시험 이어서 하기 (resume banner) · 답변 N개 · MM:SS 남음 (banner meta) · 이어서 하기 (Resume) ·
    저장된 시험을 이어서 하지 못했어요 — 아래에서 새로 시작해 주세요. (resume-failed notice)
  - Results: 정답 N / N · 답변 N개 · **복습할 문제 N개** / **틀린 문제 없음** (score line) · 복습 (Review
    eyebrow) · 맞았어요/틀렸어요 (verdicts, matches Study mode) · 내 답 (Your answer) · 정답 (Correct
    answer — EN also changed from "Correct:" to "Correct answer:" to match Study mode) · 새 모의고사 (New mock)
  - Left EN on purpose: button aria-labels ("Start Reading mock test…", "Question N, answered", "Confirm
    submit", "Time remaining …"), the sr-only coarse timer announcements ("N minutes remaining." etc. —
    test-pinned), ErrorCard fixed copy + retry labels ("Could not load/submit the test.", "Retry submit",
    "Back", "Finish"), and the literal "skipped" pick display for a skipped item (shared sentinel).

## Left ENGLISH on purpose (long-tail — the `<Bilingual>` fallback renders EN in ko-mode)
Placeholder attributes, `window.confirm` prose, ErrorCard security strings, long instructional hints,
form field labels, source-row metadata. These are a future top-up, not a bug — flag any you want prioritized.
