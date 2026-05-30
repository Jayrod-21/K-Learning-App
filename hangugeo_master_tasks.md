# 한국어 마스터 — Task List
> Phased build plan for Claude Code overnight sessions
> Status: [ ] Not started | [~] In progress | [x] Complete | [!] Blocked

---

## PHASE 1 — Project Scaffold & Foundation
*Goal: Working skeleton app with auth, routing, database, and core services*

- [x] Initialize React + Vite + TypeScript client
- [x] Initialize Node.js + Express server
- [x] Configure Tailwind CSS with Korean design tokens
- [x] Create Supabase schema (supabase/schema.sql)
- [x] Set up environment variables (.env files for client + server)
- [x] Build auth middleware (JWT validation)
- [x] Build Login / Register page (React)
- [x] Set up React Router with protected routes
- [x] Implement SM-2 algorithm in `/client/src/utils/sm2.ts`
- [x] Build Claude API service layer (`claudeService.js`)
- [x] Build Supabase service layer (`supabaseService.js`)
- [x] Create Dashboard page shell (placeholder data)
- [x] Build API routes (progress, vocab, conversation, grammar, reading)
- [x] Verify client builds successfully

**Phase 1 Deliverable:** App launches, user can register/login, dashboard renders, all services connected.

---

## PHASE 2 — Vocabulary System (SM-2 Flashcards)
*Goal: Fully functional spaced repetition vocabulary system*

- [ ] Seed database with TOPIK I vocabulary list (~800 words with example sentences)
- [ ] Seed database with business Korean starter deck (~200 words)
- [ ] Seed database with daily life Korean starter deck (~200 words)
- [ ] Build Flashcard component (front: Korean sentence + highlighted word / back: English + explanation)
- [ ] Build SM-2 review session page
- [ ] Connect SM-2 algorithm to `vocab_reviews` table
- [ ] Build deck selector (TOPIK I / TOPIK II / Business / Daily / Slang)
- [ ] Build vocab stats component (mastered / learning / new counts)
- [ ] Implement mastery threshold logic (5 consecutive correct = mastered)
- [ ] Wire vocab mastered count to dashboard

---

## PHASE 3 — Grammar Lessons

- [ ] Seed 20 grammar lessons (beginner → TOPIK I level) with content JSON
- [ ] Build Grammar Lesson page (explanation → examples → practice → quiz flow)
- [ ] Build lesson completion tracker
- [ ] Build grammar quiz component (multiple choice + fill-in-the-blank)
- [ ] Implement Korean mode filtering
- [ ] Build grammar progress page
- [ ] Wire grammar lesson completions to dashboard

---

## PHASE 4 — TOPIK Practice Tests

- [ ] Seed 3 full TOPIK I reading practice sets
- [ ] Seed 3 full TOPIK I listening practice sets (TTS-based)
- [ ] Build TOPIK test UI (timed, question-by-question flow)
- [ ] Build test score calculation and review screen
- [ ] Persist test attempts
- [ ] Build TOPIK readiness algorithm
- [ ] Wire TOPIK readiness % to dashboard

---

## PHASE 5-10 — See full spec in project context

---

## Current Sprint
**Active Phase:** Phase 2
**Last Updated:** 2026-03-19
**Next Session Goal:** Build vocabulary system with SM-2 flashcards
