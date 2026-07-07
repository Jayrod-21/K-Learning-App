# Overhaul Phase 1.2 — page-content reshuffle (build spec)

P1.1 (nav skeleton) is done + deployed. P1.2 = move every component to its TARGET home + do the
reconciliations (dissolve Reference, dedup My-Lists, grammar-browse dedup). **P1.2 is structural
reorg only — NO genuinely-new features.** The new-feature slots (grammar-practice carousel backing,
TOPIK recommendation, grammar mastery, past-exams, PDF uploads, hot-buttons, chat rework) become
**clean, intentional placeholders** ("coming soon" panels that look designed, not broken) — P4 fills them.
Refs: `OVERHAUL_DESIGN.md` (decisions D1-D5), `OVERHAUL_SCOUT_ia.md`, `OVERHAUL_SCOUT_learn_review.md`.

Zero regressions: every existing capability still reachable. Two FILE-DISJOINT slices (parallel-safe).

## Slice A — Today / Progress rebalance (Today.tsx, Progress.tsx + moved carousel bits; NOT App.tsx/nav.ts)
**Move OFF Today → onto Progress:**
- The F-017 stats carousel: `SkillTrendPanel` + `SERIES_PANELS` + the `today.series` fetch (Today.tsx ~149-159,184-230,266-270,381-391) → relocate to Progress.tsx as the "per-skill trends over time" section. Reuse the `SwipeCarousel` shell in Progress. Move the associated skill-accent CSS too. (Scout: components have zero Today-coupling; ~150 lines of glue.)
- The `SkillsCompare` compact snapshot (the TOPIK-level display) → Progress, folded into the TOPIK-1→Native compare area. **Reconcile with Progress's existing `CompareBlock`/`TrendChart`** so there is ONE compare surface, not two competing widgets (prefer `SkillsCompare full` as the headline compare; keep Progress's attempt-vs-attempt table if still useful, but don't ship two visually-different "compare" cards).
**Progress additions:**
- A **retake-diagnostic** button in the POPULATED state (today it's only in the zero-attempts empty block).
- A **grammar-mastery PLACEHOLDER** section next to the existing `WordMasterySection` (F-013 vocab mastery stays) — a designed "Grammar mastery — coming soon" card. (Real route is P4.)
**Today becomes an ACTION hub (existing content + placeholders):**
- Keep the vocab **cards-due** entry (the review-queue CTA → now points to `/learn/vocab`, already repointed in P1.1) — present it as the lead card/first carousel.
- **Reading/Listening/Writing carousel** — reshape the existing 3 TaskCards into a `SwipeCarousel` (real, existing targets: `/learn/listen`, `/learn/writing`).
- **Grammar-practice carousel** — PLACEHOLDER panel (real grammar-due backing is P4).
- **TOPIK-recommendation + open-exam carousel** — PLACEHOLDER panel (the open-exam part MAY surface the existing F-007 `topik_attempts` resume if trivially available; else placeholder). Recommendation heuristic is P4.
- A **Review shortcut** row → `/review/mistakes`.
- Today NO LONGER shows the stats carousel or the TOPIK-level snapshot (moved to Progress).

## Slice B — Review library assembly (ReviewLibrary.tsx, Reference.tsx, Review.tsx My-Lists, App.tsx routes, nav.ts, Grammar.tsx D3; NOT Today.tsx/Progress.tsx)
**Dissolve Reference → real `/review/*` routes** (replace the P1.1 `/reference?tab=` placeholders):
- `/review/vocab` — the Reference **Vocabulary** tab (curated corpus, `domain`+`book_level` filters). 
- `/review/dictionary` — the Reference **Dictionary** tab (KRDICT search). **D2: keep it a SEPARATE tab** (do not merge into all-Vocab).
- `/review/grammar` — the Reference **Grammar** tab (KGIU browse, level filter, `KgiuDetailBody`). **D3: this is the SINGLE grammar browse.** `Grammar.tsx` (LEARN grammar-practice) DROPS its `list`/browse tab, keeping only `banked` + `drill`. Keep `KgiuDetailBody` as the shared detail renderer.
- Add these as real routes in App.tsx + the `NavItemId`s (e.g. `review-vocab`,`review-dictionary`,`review-grammar`) in nav.ts's SECONDARY bucket (keep the exhaustiveness/disjointness checks green). `/reference` → redirect to `/review/vocab` (retire the old page once its tabs are re-homed; keep a redirect shim).
**ReviewLibrary index** (`/review`) — replace placeholder links with real routes: rows → `/review/mistakes`, `/review/vocab`, `/review/dictionary`, `/review/grammar`; PLACEHOLDER rows for `/review/exams` (past TOPIK exams) + `/review/uploads` (PDF uploads) ("coming soon", designed). Add the **hot-buttons** as PLACEHOLDER (quick-launch chips → `/learn/vocab`, `/learn/grammar`) — wire the two links (they're real targets) but keep it visually simple; the fuller hot-button treatment is P4.
**My-Lists dedup** — Review.tsx AND Reference.tsx both implement a "My Lists" UI over `vocabService.listLists()`/`createList()`. Unify to ONE shared component; place the canonical surface in the Review library (all-Vocab area, e.g. a tab/section under `/review/vocab`), and REMOVE the duplicate from the other. (Judgment: lists organize vocab → library is the natural home; the LEARN flashcards page may link to it. If placement is unclear, put it in the library + note it.)

## Both slices
- Strict TS, ESLint strict (set-state-in-effect/refs are ERRORS). Reuse existing components; match app tokens. Placeholders must look intentional (a proper empty-state card with an icon + "coming soon" copy), never a broken/blank panel.
- Update tests for moved/changed components; add tests for the new routes (B) + Today's new structure (A) + the dedup (one list surface, not two). Don't weaken existing tests — repoint them.
- New SERVER endpoints? NONE in P1.2 (all client reorg over existing endpoints). nginx allow-list untouched.
- VERIFY each slice green: client `tsc --noEmit`=0, `lint`=0/0, `vitest run` all pass, `build`=0.

## Then
/fixpass P1.2 (both slices: no lost capability, the Reference dissolution routes all resolve, the My-Lists dedup left exactly one working surface, Grammar.tsx still works without its list tab, the Today/Progress move didn't drop the stats/compare, placeholders are clean). Deploy blue/green on M. Then P2 (QA), P3 (label cleanup), P4 (fill placeholders + chat rework), P5 (visual), P6 (data/Reading).
