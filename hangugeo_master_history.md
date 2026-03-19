# 한국어 마스터 — Project History Log
> This file tracks all major decisions, changes, and milestones throughout the project lifecycle.
> Format: [Date] | [Version] | [Category] | [Entry]

---

## Session 001 — Ideation & Specification
**Date:** 2026-03-18
**Phase:** Planning
**Status:** Complete

### Decisions Made
| Decision | Choice | Rationale |
|---|---|---|
| Frontend Framework | React + Vite + TypeScript | Component-based, interactive UI needs; learner is familiar with React |
| Backend | Node.js + Express | Full JS stack consistency, well-documented |
| Database & Auth | Supabase (PostgreSQL) | Handles auth + DB + storage, free tier, minimal backend overhead |
| AI Engine | Claude API (claude-sonnet-4-6) | Conversation partner + passage generation + grammar explanations |
| TTS | Web Speech API | Free, built-in, no API key needed; Korean voice available in most browsers |
| Spaced Repetition | Custom SM-2 implementation | Full control over scheduling logic, no third-party dependency |
| Styling | Tailwind CSS + custom design tokens | Speed + Korean aesthetic via custom color palette |
| Target Audience | Single user (personal tool) | No multi-tenancy needed; simplified auth and data model |
| Design Aesthetic | Korean traditional (단청 palette) | Personal preference; dark mode default |
| Hosting (future) | Vercel + Railway | Standard, cost-effective for personal projects |

### Pain Points Identified
- Existing apps (Duolingo, Anki, TTMIK) don't offer real-world / business Korean in context
- No single app combines TOPIK prep + business Korean + spaced repetition + reading
- Learning style: learn-by-doing; immersive context preferred over isolated vocab drilling
- No app currently tracks TOPIK readiness quantitatively

---

## Session 002 — Phase 1 Scaffold Build
**Date:** 2026-03-19
**Phase:** Development
**Status:** Complete

### What Was Built
- Full project scaffold: client (React+Vite+TS) and server (Node+Express)
- Tailwind CSS with Korean 단청 design tokens (dark mode default)
- Supabase schema with 11 tables, indexes, RLS policies
- SM-2 spaced repetition algorithm (`client/src/utils/sm2.ts`)
- Claude API service layer with 3 functions: conversationPartner, generateReadingPassage, explainGrammar
- Supabase service layer with common DB operations
- Auth middleware (JWT validation via Supabase)
- API routes: progress, vocab, conversation, grammar, reading
- Login/Register page with Supabase Auth
- Dashboard shell with placeholder metrics: TOPIK readiness, streak, vocab mastered, reading level, Korean age, weak area chart
- React Router with protected routes and placeholder pages for all 6 modules
- Rate limiting on AI endpoints (50 requests/24h)

### Decisions Made
| Decision | Choice | Rationale |
|---|---|---|
| Tailwind v4 | Used @tailwindcss/vite plugin + @theme CSS | v4 is current; cleaner config |
| RLS Policies | Added to schema.sql | Security best practice even for single-user |
| Rate Limit | 50 AI requests/day | Balances usability with cost control |
| Server scripts | `node --watch` for dev | Built-in Node watch mode, no nodemon dependency needed |
| Express v5 | Installed latest (v5.2) | Latest stable, installed by default |

### Deviations From Spec
- Added RLS policies and indexes to schema.sql (not in spec but essential)
- Added `createNewCard()` helper to SM-2 module (useful factory function)
- Used Tailwind v4 syntax (@theme instead of tailwind.config.js) since v4 was installed

---

## Open Questions (Unresolved)
- [ ] What formula to use for "Native Korean Age Equivalent" calculation?
- [ ] Source for authentic TOPIK listening audio (copyright issues)?
- [ ] How many vocab items to pre-load at launch vs. progressively unlock?
- [ ] Which open-source Korean graded reader texts to include at launch?
- [ ] Rate limiting strategy for Claude API to manage costs?

---

## Future Log Entries
> Add new entries below as the project progresses.
