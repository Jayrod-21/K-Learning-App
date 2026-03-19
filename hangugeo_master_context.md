# 한국어 마스터 — Project Context & Summary
> Reference file for Claude Code sessions and overnight tasks.
> Always load this file at the start of a new session.

---

## What This Project Is

Hangugeo Master is a personal full-stack Korean language learning web application. It is NOT a general-purpose language app — it is purpose-built for one user who is:

- An intermediate Korean learner
- Targeting TOPIK I & II certification
- Targeting business-level + daily life fluency for living in Korea
- Learning style: context-based, learn-by-doing, spaced repetition
- Frustrated with: gamified apps, decontextualized vocab, lack of real-world Korean

---

## Tech Stack Reference

```
Frontend:   React + Vite + TypeScript
Backend:    Node.js + Express
Database:   Supabase (PostgreSQL + Auth + Storage)
AI:         Claude API — claude-sonnet-4-6
TTS:        Web Speech API (browser-native)
SRS:        Custom SM-2 algorithm
Styling:    Tailwind CSS + custom Korean design tokens
Hosting:    Local dev → Vercel (FE) + Railway (BE) when ready
```

---

## Core Modules Summary

### Module 1: Dashboard
Central hub showing: TOPIK readiness %, streak, weak area heatmap, vocab mastered, reading level, Korean age equivalent.

### Module 2: Vocabulary (SM-2 SRS)
Sentence-based flashcards with TOPIK I/II, business, daily life decks. SM-2 controls intervals.

### Module 3: Grammar
Progressive lessons: explanation → examples → practice → quiz. Mapped to TOPIK levels.

### Module 4: TOPIK Practice
Timed test mode for TOPIK I & II sections. Score tracking feeds readiness %.

### Module 5: AI Conversation Partner
Claude API-powered. Modes: casual / business / TOPIK prep. Corrections with explanations.

### Module 6: Reading Practice
Graded + AI-generated passages. Comprehension questions. Feeds reading level metric.

### Module 7: Speaking / Pronunciation
TTS for all content. Listen → repeat → record flow.

### Module 8: Korean Mode Selector
Context modes: business / daily / academic / casual. Filters content across all modules.

---

## Design Tokens

```css
--color-primary:     #8B1A1A;   /* 단청 red */
--color-secondary:   #2D5A27;   /* forest green */
--color-accent:      #C9A84C;   /* gold */
--color-ink:         #1A1A2E;   /* ink black */
--color-paper:       #F5F0E8;   /* hanji paper (light mode) */
--font-korean:       'Noto Sans KR', sans-serif;
--font-ui:           'Inter', sans-serif;
```

---

## Progress Checkpoints

- [x] Phase 1: Project scaffold + Supabase setup + auth
- [ ] Phase 2: Vocabulary system + SM-2
- [ ] Phase 3: Grammar lessons module
- [ ] Phase 4: TOPIK practice tests
- [ ] Phase 5: AI conversation partner
- [ ] Phase 6: Reading practice module
- [ ] Phase 7: Speaking/TTS module
- [ ] Phase 8: Dashboard metrics wired up + polish
- [ ] Phase 9: Korean mode selector integration
- [ ] Phase 10: Polish, testing & deployment
