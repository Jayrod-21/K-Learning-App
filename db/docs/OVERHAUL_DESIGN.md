# Korean Master — App Overhaul design (Phase 0 synthesis, 2026-07-07)

Consolidates the 3 scouts (`OVERHAUL_SCOUT_{ia,learn_review,chat_progress}.md`) + Jared's spec
([[project-korean-master-overhaul]] memory). Target nav: **Today · Progress · LEARN(hexagon
launcher) · Review(library) · Settings** + a global chat FAB. Guiding finding: **mostly reorg +
extend existing infra; the genuinely-new surface is smaller than it looks — concentrated in the
chat rework, the two nav patterns (hexagon + FAB), and a few Today/Review pieces.**

## Effort reality per area (EXISTS / EXTEND / NEW)

### Today (new = action hub)
- vocab cards-due — EXTEND (the review-queue CTA exists; reshape to carousel).
- grammar-practice carousel — EXTEND: server ~90% done (bank + graduate/readmit + FSRS production cards + **grammar DUE reuses `/vocab/cards/due`**); the due-split logic exists but is embedded in `Review.tsx:186-209,1144-1184` → extract to a shared module + build the carousel. (Caveat: 0 production cards in live db — test with real data.)
- reading/listening/writing carousel — EXTEND: the 3 TaskCards exist; reshape one grid → a `SwipeCarousel`.
- TOPIK-recommendation + open-exam carousel — NEW: no recommend endpoint; open-exam state = the F-007 `topik_attempts` resume (exists).
- Remove from Today: SkillsCompare compact (TOPIK-level) + F-017 stats carousel → both to Progress.

### Progress (new = stats hub) — nearly free
- Page EXISTS (`/progress`, F-010/F-013 populated). SkillsCompare EXISTS (movable). F-017 carousel components EXIST (only ~150 lines of Today-glue to move). `/…/series` routes page-agnostic.
- TOPIK-1→Native compare — EXISTS (Diagnostic results `SkillsCompare` variant `full`); reconcile with Progress's own `CompareBlock` so there's ONE compare widget.
- vocab mastery — EXISTS (F-013 `WordMasterySection`).
- grammar mastery — NEW but cheap: a read route mirroring `/vocab/mastery` (state exists: production-card FSRS + `graduated_at`) + a Progress section.
- retake-diagnostic — EXTEND (CTA exists only in the zero-attempts empty state; add to populated state).

### LEARN (hexagon launcher menu) — pure moves + 1 new pattern
- TOPIK, Listen, Vocab-flashcards(=Review.tsx), Grammar-practice(=Grammar.tsx), Writing, Hanja = PURE MOVES.
- Reading = NEW (deferred; skeleton a route/placeholder — NOT `/reading`, that's a redirect).
- The hexagon launcher itself = NEW pattern (upward-expanding menu over BottomNav; reuse `useModalA11y`; mounts in `Shell`).

### Review (new library) — moves + reconciliations + a few new
- Mistakes = PURE MOVE. all-Vocab = Reference Vocabulary tab (filters match: domain=genre, book_level=difficulty) + optional Dictionary merge. all-Grammar = Reference Grammar tab (reconcile w/ Grammar.tsx list tab). vocab-by-genre — EXTEND: add a `theme` query param (30+ chapter values already in db, e.g. "01 인간/People").
- past TOPIK exams — NEW (no attempts-list endpoint). PDF uploads — NEW. hot-buttons→LEARN — NEW (small).
- Consolidate the DUPLICATE My-Lists UI (Review.tsx + Reference.tsx both call `listLists`/`createList`).

### Settings — stays; theme folds in from MoreSheet. Upload feature = NEW (deferred, Jared explains later).

### Global chat FAB + rework — the biggest NEW chunk
- Reusable: conversation start/stream (`conversation.ts:69-91,347-619`), conversation LIST metadata (`:638-660`), image OCR/translate/mine pipeline (`images.ts:253-381`), the F-020 seed primitive (`askSeed.ts`).
- NEW: `GET /conversation/:id` (full history — missing, `Chat.tsx:282-286`); the sidebar UI; force-new-on-FAB-open; **30-day retention** (no scheduler; `deleted_at` unused; `evictExpiredCache` is dead code); a GENERIC per-page context export (~10/14 pages) + the "discuss the prior page?" popup; image-in-chat (file input + an image turn type in `StoredTurn`); the FAB overlay + visibility logic.
- Visibility signals BOTH MISSING: exam-active (MockMode `phase` is local state — lift to shared context so `Shell` can see it) + keyboard-open (no `visualViewport` hook anywhere).

## Route-stability rules (hard constraints)
1. `/chat` MUST NOT move — hardcoded `CHAT_PATH='/chat'` in `AskAboutThisButton.tsx:31` (4 callers). 
2. `/review` reassignment is the highest-risk rename — today = FSRS flashcards; target "Review" = library. The flashcard page gets a NEW path; update `Today.tsx:409` + the nav manifest + `PRIMARY_TAB_IDS` in lockstep.
3. `/reading` is a live redirect to `/ttmik` — the new Reading page needs a different path.
4. Keep the `nav.ts` exhaustiveness check green (update manifest + arrays together).
5. New SERVER endpoints (grammar-mastery, past-exams, PDF upload, `/conversation/:id`) MUST be added to the nginx allow-list regex in BOTH `Deploy/nginx.conf` prod+test blocks.

## Decisions — LOCKED (Jared, 2026-07-07)
- **D1 Path scheme = NAMESPACED (chosen for long-term maintainability; Jared: "whatever's best for future work").** Full table below. LEARN sub-pages under `/learn/*`, the library under `/review/*`. `/chat` stays flat (hard contract). Redirect shims from every old flat path so nothing breaks. More P1 churn than keeping flat paths, but the URL then mirrors the IA (enables section guards / analytics / clear deep links).
- **D2 Dictionary = SEPARATE tab** in the Review library (KRDICT search is its own sub-tab, not merged into all-Vocab).
- **D3 Grammar browse = single browse in Review-library "all-Grammar"**; the LEARN Grammar-practice page focuses purely on drilling (drops its own list/browse). `KgiuDetailBody` stays the shared detail renderer.
- **D4 "This Week" strip = REMOVED from Reference; the SUGGESTION function moves INTO the LEARN vocab + grammar pages** (a "suggested to learn/add" section on each). Grammar side has `/grammar/suggestions/weekly` already; a vocab equivalent needs scoping. **HOW-TO-SURFACE is an open sub-task** (Jared: "we'll have to figure out how that works") — resolve during P4.
- **D5 Chat rework = its own dedicated sub-phase in P4.** NEW requirement: the previous-conversations sidebar must be **COLLAPSIBLE (like Claude's chat sidebar)** for UI space-saving — collapse/expand toggle, not always-open.

### Path table (target; redirect old→new)
| Page | New path | Old path (→ redirect) |
|---|---|---|
| Today | `/` | — |
| Progress | `/progress` | (same) |
| LEARN → TOPIK | `/learn/topik` | `/topik` → |
| LEARN → Listen | `/learn/listen` | `/ttmik` →, `/reading` → (repoint the existing shim) |
| LEARN → Vocab-flashcards | `/learn/vocab` | old `/review` (flashcards) →; update `Today.tsx:409` |
| LEARN → Grammar-practice | `/learn/grammar` | `/grammar` → |
| LEARN → Writing | `/learn/writing` | `/writing` → |
| LEARN → Hanja | `/learn/hanja` | `/hanja` → |
| LEARN → Reading (new, later) | `/learn/reading` | — (do NOT reuse `/reading`) |
| Review library (index) | `/review` | — (REPURPOSED from flashcards → library) |
| Review → Mistakes | `/review/mistakes` | `/mistakes` → |
| Review → all-Vocab | `/review/vocab` | Reference Vocabulary tab |
| Review → Dictionary | `/review/dictionary` | Reference Dictionary tab |
| Review → all-Grammar | `/review/grammar` | Reference Grammar tab + Grammar list |
| Review → past exams (new) | `/review/exams` | — |
| Review → uploads (new) | `/review/uploads` | — |
| Reference (whole) | — dissolved | `/reference` → `/review` |
| Settings | `/settings` | (same) |
| Chat | `/chat` | **UNCHANGED — hard contract, never move** |
| Diagnostic | `/diagnostic` | (same; entered from Progress retake) |
| Images/OCR | TBD | fold into `/review/uploads` or the chat image feature — **open sub-task** |

## Phase plan (Jared's order + Phase 0)
- **P0 (now):** scouts ✔ + this doc + mockups (hexagon, chat FAB) + lock D1-D5.
- **P1 skeleton:** 5-tab nav + hexagon launcher + chat-FAB shell (visibility signals: lift exam-state to context + a keyboard-open hook) + re-home all pure-move pages + placeholders for new slots. No regressions. Reconcile the /review path + nav manifest here.
- **P2 QA:** everything still works (esp. the moved pages + the /chat + /review contracts).
- **P3 cleanup:** incorrect labels + extra verbage.
- **P4 new features:** Today action-carousels (grammar-due extract + TOPIK-recommendation), grammar-mastery on Progress, Review library (past-exams, PDF uploads, hot-buttons, theme genre), My-Lists dedup, and the CHAT REWORK sub-phase (sidebar + `/conversation/:id` + retention + generic context + popup + image-in-chat).
- **P5 visual overhaul:** app-like, not claude-page-like.
- **P6 data:** Jared uploads scanned books → the Reading feature.

Each phase = build (Fable) → /fixpass → blue/green deploy on M. Every phase-group gets a fixpass (per [[feedback-always-fixpass-before-finalizing]]).
