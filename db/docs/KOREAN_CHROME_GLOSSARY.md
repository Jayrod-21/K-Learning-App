# Korean UI-chrome glossary (canonical translations for P3b)

Authored to keep chrome Korean CONSISTENT across all P3b batches. Use these exact renderings for
recurring chrome terms. This is UI-CHROME Korean (nav/headings/buttons/empty-states) — NOT learning
content (vocab/grammar/examples always stay as their own Korean). `(verify)` = flag for Jared to confirm.
When a needed term isn't here, translate in the SAME register (terse, standard app Korean, noun-style
for labels/eyebrows, `-기`/`-하기` or polite imperative for buttons) and ADD it to your final report so
we can fold it in.

## Nav / sections (already canonical in nav.ts — reuse)
Today 오늘 · Progress 성장 · Learn 배움 · Review(library) 복습 · Settings 설정 · TOPIK 모의고사 ·
Listen 듣기 · Vocab flashcards 단어 카드 · Grammar practice 문법 연습 · Writing 쓰기 · Hanja 한자 ·
Reading 읽기 · Dictionary 사전 · Mistakes 틀린 문제 · Diagnostic 진단 · Chat 대화 · Library 자료실 ·
Images / Scan images 이미지 스캔

## Skill domains (chrome labels — the CONTENT tag stays as-is)
Reading 읽기 · Listening 듣기 · Vocabulary/Vocab 어휘 · Grammar 문법 · Writing 쓰기 · Speaking 말하기

## Common recurring chrome nouns
mastery 숙달 · review 복습 · practice 연습 · due 복습 예정 · progress 성장 · trend/over time 추이 ·
level 등급 (TOPIK 급) · score 점수 · streak 연속 · today's tasks 오늘의 과제 · overview 요약 ·
this week 이번 주 · recommendation 추천 · exam 시험 · mock exam 모의시험 · section 영역 ·
passage 지문 · question 문제 · answer 정답 · pattern (grammar) 문형 · word 단어 · list 목록 ·
card 카드 · bank(noun, saved set) 모음 · results 결과 · settings 설정 · appearance 화면 표시 ·
account 계정 · notifications 알림 · theme 테마

## Buttons / actions (imperative, polite-terse)
Start 시작 · Start review 복습 시작 · Continue 계속 · Resume 이어서 하기 · Retake 다시 하기 ·
Retake diagnostic 진단 다시 하기 · Retry 다시 시도 · Add 추가 · Add to bank 모음에 추가 ·
Remove 빼기 · Delete 삭제 · Edit 편집 · Rename 이름 변경 · Create 만들기 · New 새로 만들기 ·
Save 저장 · Cancel 취소 · Close 닫기 · Send 보내기 · Search 검색 · Filter 필터 · Browse 둘러보기 ·
Browse all patterns 전체 문형 보기 · Open 열기 · Manage 관리 · Look up 찾아보기 · Submit 제출 ·
Grade 채점 · Next 다음 · Previous 이전 · Skip 건너뛰기 · Show answer 정답 보기 · Graduate 완료 처리 (verify) ·
Re-admit 다시 학습 (verify)

## Empty / status states (terse, kind but not wordy)
No data yet 아직 데이터가 없어요 · Loading… 불러오는 중… · Coming soon 준비 중 ·
No X yet 아직 X이(가) 없어요 · Nothing here yet 아직 없어요 · Couldn't load 불러오지 못했어요 ·
Try again 다시 시도해 주세요 · No mistakes 틀린 문제가 없어요 · All caught up 모두 완료했어요 ·
Start X to see your progress 성장을 보려면 X을(를) 시작하세요

## Level / band labels
TOPIK 1–6 → 토픽 1급 … 토픽 6급 · Beginner 초급 · Intermediate 중급 · Advanced 고급 · Native 원어민 · basic 기초

## Register notes
- Buttons: prefer terse verb-noun (복습 시작) or `-기` (찾아보기) over full sentences.
- Empty states: 해요체 (…없어요 / …해 주세요) — friendly, not stiff 합니다체, not casual 반말.
- Eyebrows/section labels: bare nouns (오늘의 과제, 이번 주), no trailing punctuation.
- NEVER translate a proper noun that's a brand/content (TTMIK, KRDICT stay; TOPIK → 토픽 only where the app already localizes it, else keep TOPIK).
- If a string is a THROWAWAY/rare toast with no natural short Korean, leave EN + flag it (the `<Bilingual>` fallback renders EN in ko-mode gracefully — a documented long-tail top-up).
