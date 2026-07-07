# OVERHAUL_SCOUT_ia — IA/Nav structural map (read-only scout, 2026-07-07)

Target nav: **Today · Progress · LEARN(center hexagon launcher, not a page) · Review(NEW library) · Settings** + a global chat FAB.

## 1. Nav system
- `client/src/lib/nav.ts` — single source of truth. `NavItemId` union (14): today, topik, review, diagnostic, grammar, writing, hanja, images, chat, reference, settings, progress, mistakes, ttmik. Paths: today `/`, topik `/topik`, review `/review`, diagnostic `/diagnostic`, grammar `/grammar`, writing `/writing`, hanja `/hanja`, mistakes `/mistakes`, images `/images`, chat `/chat`, reference `/reference`, settings `/settings`, progress `/progress`, ttmik `/ttmik` (label "Listen").
- `PRIMARY_TAB_IDS` (178-183) = today, topik, ttmik, review. `MORE_TAB_IDS` (185-196) = mistakes, hanja, images, diagnostic, grammar, writing, chat, reference, settings, progress.
- **Exhaustiveness check (198-219)** fails the build if a NavItemId isn't in exactly one array — any nav rework MUST update the manifest + both arrays together or tsc breaks.
- `BottomNav.tsx` — 4 primary buttons + a 5th "More" (opens `MoreSheet`). Active tab = longest-prefix match on pathname.
- `MoreSheet.tsx` — modal sheet of the 10 MORE_TAB_IDS + theme toggle (124-131); uses `useModalA11y`.
- `App.tsx` (83-104) — every Route nested under `<Shell/>` behind RequireAuth. `/reading → Navigate to /ttmik` (legacy redirect shim). `* → Navigate to /`.

## 2. Pages (client/src/pages/)
- Today.tsx — SkillsCompare compact (=TOPIK-level), F-017 "Progress by skill" SwipeCarousel (stats: Reading/Listening/Vocab/Grammar/Writing 30-day trends), Review-queue CTA (→/review), 3 TaskCards (Reading/Listening/Writing).
- Topik.tsx + topik/MockMode.tsx — Study↔Mock; Mock = section-select→timed exam→server-graded.
- Ttmik.tsx — "Listen": TTMIK lessons + Iyagi, audio player, tap-word popovers.
- Review.tsx (75.8k) — FSRS **vocab flashcard** review (session/lists/all).
- Reference.tsx (53.5k) — "Resources": Vocabulary tab (curated vocab_2000, domain+book_level filters F-003), Dictionary tab (KRDICT search), Grammar tab (KGIU browse, KgiuDetailBody, F-005), My Lists tab, "This Week" strip.
- Diagnostic.tsx — intro→taking→done→results; results = `SkillsCompare` variant `full` (THE TOPIK-1→Native compare).
- Writing.tsx — Q53/Q54 writing practice.
- Hanja.tsx — 한자 study.
- Grammar.tsx (78.7k) — list (KGIU + bank), banked (Active/Known graduate/re-admit), drill (production drill).
- Images.tsx — OCR mining.
- Progress.tsx — diagnostic history (SVG trend chart, attempt-vs-attempt CompareBlock, AttemptsTable) + **WordMasterySection (F-013 vocab mastery — already here)**.
- Chat.tsx — tutor thread, streaming, F-016 dictionary, F-020 seed intake.
- Settings.tsx — profile (server) + notifications/appearance (localStorage) + theme.
- Mistakes.tsx — recent wrong TOPIK answers (30d) + AskAboutThisButton.

## 3. Reusable carousel
`client/src/components/SwipeCarousel.tsx` (296 lines) — generic one-page swipeable, `role=tablist` dots, reduced-motion aware, pure shell (`children: ReactNode[]` + `ariaLabel`). Only consumer today: Today.tsx:381-391 wrapping 5 `SkillTrendPanel`s (SERIES_PANELS 149-159; each a LineChart of that skill's 30-day `/…/series`, fetched via `useEndpointOrMock('today.series',…)` 266-270). The SHELL is domain-agnostic → reusable for Today's new action carousels. The STATS instance (SkillTrendPanel/SERIES_PANELS/today.series fetch) MOVES wholesale to Progress.

## 4. Move-map (current → new)
| Current | Target | Notes |
|---|---|---|
| Today SkillsCompare compact | Progress (fold into TOPIK-1→Native compare) | Today loses TOPIK-level |
| Today F-017 stats carousel | Progress (per-skill trends) | move component+fetch wholesale |
| Today review-queue CTA | Today(new) vocab cards-due | becomes carousel-shaped |
| Today 3 TaskCards | Today(new) — grammar-practice carousel + reading/listening/writing carousel | one grid → two carousels |
| — | Today(new) TOPIK-recommendation/open-exam carousel | NEW; no recommend endpoint exists |
| Diagnostic results (SkillsCompare full) | Progress — TOPIK-1→Native compare | reconcile w/ Progress's own CompareBlock |
| Progress trend/CompareBlock/AttemptsTable | Progress (stays) | |
| Progress WordMasterySection (F-013) | Progress — vocab mastery | ALREADY EXISTS |
| — | Progress — grammar mastery | genuinely NEW |
| Progress EmptyBlock "Take diagnostic" | Progress — retake-diagnostic | populated-state retake is new |
| Topik+MockMode | LEARN → TOPIK | pure move |
| Ttmik | LEARN → Listen | pure move; keep /reading→/ttmik shim |
| Review.tsx (flashcards) | LEARN → Vocab-flashcards | pure move BUT `/review` is reclaimed → needs a NEW path |
| Grammar.tsx | LEARN → Grammar-practice | pure move |
| Writing.tsx | LEARN → Writing | pure move |
| Hanja.tsx | LEARN → Hanja | pure move |
| — | LEARN → Reading (new, later) | `/reading` already a redirect → needs different path |
| Mistakes.tsx | Review(library) → Mistakes | pure move |
| — (no past-exams list) | Review(library) → past TOPIK exams | NEW; no endpoint |
| Reference Vocabulary tab | Review(library) → all-Vocab | filters already match (domain=genre, book_level=difficulty) |
| Reference Dictionary tab | Review(library) → merge w/ all-Vocab or separate sub-tab | decide |
| Reference Grammar tab | Review(library) → all-Grammar | overlaps Grammar.tsx list tab — reconcile |
| Reference My Lists | Review(library) or LEARN Vocab-flashcards | **duplicate of Review.tsx lists tab** — unify to one owner |
| Reference "This Week" strip | unassigned | decide (drop/fold) |
| — | Review(library) → PDF-uploads | NEW |
| — | Review(library) → hot-buttons→LEARN | NEW |
| Settings.tsx + MoreSheet theme toggle | Settings | stays; fold theme in |
| — | LEARN center hexagon launcher | NEW (no analog; MoreSheet pops from bottom, not up) |
| — | global chat FAB | NEW; visibility logic problems (see §5) |

## 5. Route-stability risks
- **`/chat` is a hardcoded contract** — `AskAboutThisButton.tsx:31` pins `CHAT_PATH='/chat'` (called from Diagnostic, Topik, MockMode, Mistakes). MUST NOT move. F-020 `ChatSeedState` rides router state, depends on `/chat`.
- **`/review` means two things** — today FSRS flashcards; target reassigns "Review" to the library. The FSRS page needs a NEW path; `Today.tsx:409` `navigate('/review')` + the nav manifest update in lockstep. **Highest-risk rename** (`review` is baked into NavItemId/PRIMARY_TAB_IDS).
- **`/reading`** already a permanent redirect to `/ttmik` — the new Reading page needs a different path or the redirect must be repointed first.
- **nginx allow-list** (`Deploy/nginx.conf:82` + mirrored `:129`) = regex over SERVER prefixes only (auth|health|define|…|ttmik|iyagi). Client page reshuffling is SAFE. Any NEW server endpoints (past-exams, PDF uploads, grammar-mastery) MUST be added to the regex in BOTH prod+test blocks.
- **TOPIK exam-active state is LOCAL to MockMode** (`phase` state, MockMode.tsx:150) — not in URL/context. The "hide chat FAB during exam" rule has NO existing signal; needs new shared state lifted to Shell.
- **Keyboard-open detection** — no precedent (no visualViewport listener/hook); new plumbing.

## 6. Shared components / duplication (don't orphan; reconcile)
- `SwipeCarousel` — Today→Progress + new Today carousels; safe.
- `SkillsCompare`(+SkillBar) — Today(→Progress) + Diagnostic(full); reconcile with Progress's separate CompareBlock/TrendChart so there aren't two compare widgets.
- `AskAboutThisButton`+`askSeed` — Diagnostic/Topik/MockMode/Mistakes; all hardcode `/chat`; every host page is moving → re-verify in new host.
- `KgiuDetailBody` — Grammar + Reference Grammar tab; keep as the single detail renderer when they consolidate.
- **`vocabService.listLists()`/`createList()` — Review.tsx AND Reference.tsx duplicate the My Lists UI** — consolidate to ONE owner.
- `Icon.tsx` — needs new entries (no hexagon/fab/search-fab icon exists).
- `Shell.tsx` — the sane single mount point for the chat FAB (wraps `<Outlet/>`) + where the LEARN upward menu overlays above BottomNav.
- `useModalA11y` — reuse for the LEARN menu; don't delete with MoreSheet.

## 7. Genuinely-new UI (no current component)
Hexagon LEARN launcher (upward menu); global chat FAB + visibility logic (exam-state signal + keyboard-open both new); Today action carousels (grammar-practice, reading/listening/writing, TOPIK-recommendation/open-exam — no recommend endpoint); grammar mastery on Progress; populated-state retake-diagnostic; Review library past-exams list + PDF-uploads + hot-buttons.
