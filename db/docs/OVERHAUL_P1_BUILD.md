# Overhaul Phase 1 — build spec

Two increments. **P1.1 = nav/routing/patterns skeleton (this spec).** P1.2 = page-content reorg (Progress absorbs stats, Review library assembly, Today action-carousels) — separate spec later. P1.1 must NOT reorganize any page's internal content — only re-home pages to new paths + stand up the new nav chrome + the two patterns. **Zero regressions: every existing page still renders + works, just at its new path.**

Refs: `OVERHAUL_DESIGN.md` (path table + decisions), `OVERHAUL_SCOUT_ia.md` (nav internals + risks). Mockup approved: hexagon launcher + chat FAB (collapsible sidebar).

## Nav id/path model (`client/src/lib/nav.ts`)
Clean semantics for future work. Ids + paths:
- **Primary tabs (4 routed):** `today` `/`, `progress` `/progress`, `review` `/review` (NOW = the library, repurposed), `settings` `/settings`.
- **LEARN launcher:** a NON-routed launcher (NOT a NavItem with a path) — it opens the upward menu. Represent as its own concept (e.g. a `LEARN_SUBPAGE_IDS` array + a launcher button), not a routed NavItemId.
- **LEARN sub-pages (routed, not primary tabs):** `topik` `/learn/topik`, `ttmik` `/learn/listen` (keep id `ttmik`, label "Listen"), `flashcards` `/learn/vocab` (NEW id — was the old `review` page; label "Vocab flashcards"), `grammar` `/learn/grammar`, `writing` `/learn/writing`, `hanja` `/learn/hanja`, `reading` `/learn/reading` (NEW, placeholder page).
- **Secondary routed (reachable from tabs/pages, not in the bar):** `mistakes` `/review/mistakes`, `reference` `/reference` (KEEP for now — dissolves in P1.2), `diagnostic` `/diagnostic`, `images` `/images`, `chat` `/chat` (**UNCHANGED — hard contract**).
- Restructure the exhaustiveness check to cover the new buckets (primary + learn-subpages + secondary) so `tsc` still guards that every `NavItemId` is accounted for. Keep it green.
- **Id migration:** the old `review` id/label/path (vocab flashcards) → becomes id `flashcards`, path `/learn/vocab`, label "Vocab flashcards". The id `review` is REUSED for the new library tab (path `/review`, label "Review"). Grep every `navItem('review')` / `'/review'` / `navigate('/review')` and repoint: the vocab-flashcards intent (e.g. `Today.tsx:409` review-queue CTA) → `flashcards` `/learn/vocab`; the library intent → `review` `/review`.

## Routes + redirects (`client/src/App.tsx`)
- New routes at the paths above. `/review` renders a minimal **placeholder library index** (a page listing links to Mistakes + the Reference vocab/grammar/dictionary tabs + "coming soon" rows for past-exams/uploads) — the real assembly is P1.2. Reuse existing page components at their new LEARN paths (pure re-home).
- `/learn/reading` → a simple placeholder page ("Reading — coming with your book scans").
- **Redirect shims** (`<Navigate replace>`), so old links/bookmarks + any missed call site keep working: `/topik→/learn/topik`, `/ttmik→/learn/listen`, `/grammar→/learn/grammar`, `/writing→/learn/writing`, `/hanja→/learn/hanja`, `/mistakes→/review/mistakes`. The old flashcards `/review` intent → now the library; do NOT redirect `/review` (it's the library now). Update the existing `/reading→/ttmik` shim to `/reading→/learn/listen`. Keep `*→/` and `/chat`, `/diagnostic`, `/images`, `/reference`, `/settings`, `/progress`.
- Any NEW server endpoints? NONE in P1.1 (pure client routing) — nginx allow-list untouched.

## BottomNav (`client/src/components/BottomNav.tsx`)
- 5 slots: `today` · `progress` · **[LEARN hexagon]** · `review` · `settings`. The hexagon is the center, elevated, larger (per the mockup — clip-path polygon, gold). It is a BUTTON that toggles the LEARN menu (`aria-expanded`, `aria-controls`), NOT a nav link. The 4 tabs are links (active = longest-prefix match on the new paths; note `/learn/*` pages should NOT light up a primary tab — or optionally light none/LEARN when on a learn subpage).
- Retire the old "More" button + `MoreSheet` (the theme toggle it held moves to Settings — but Settings content reorg is light; for P1.1 just ensure theme is reachable in Settings, which it already is via `useSettings`/appearance). Keep `MoreSheet.tsx` file if quick, but unmount it; `useModalA11y` stays (LearnMenu uses it).

## New components + hooks
- **`LearnMenu.tsx`** — the upward-expanding menu over the nav (mockup behavior): a scrim + a stacked list of the 7 LEARN sub-pages (icon + label + kr), staggered reveal, `useModalA11y` (focus trap / Esc / scroll-lock), closes on scrim-tap / re-tap / route-change / Esc. Each item `navigate`s to its `/learn/*` path + closes. Mount in `Shell.tsx` (overlays above BottomNav). Respect `prefers-reduced-motion`.
- **`ChatFab.tsx`** — the floating chat dot (~1/5 up, right edge, per mockup). In P1.1 it simply `navigate('/chat')` (full chat rework is P4). Visibility: HIDDEN when — on `/chat`, on `/settings`, during a TOPIK exam, or the keyboard is open. Mount in `Shell.tsx`.
- **`ExamActiveContext`** (new) — lift the mock-exam active flag out of `MockMode.tsx` (its local `phase==='exam'`) into a shared context/provider so `Shell`/`ChatFab` can read it. `MockMode` sets `examActive=true` on entering the exam phase, false on leave/submit/unmount. Minimal — a boolean + setter.
- **`useKeyboardOpen()`** (new hook) — `visualViewport` resize/height heuristic (viewport height shrinks vs. layout height ⇒ keyboard open); SSR/undefined-safe; cleanup listeners on unmount. Used by `ChatFab`.
- **Icons**: add hexagon/learn + search-fab + any missing icons to the `Icon.tsx` registry.

## Out of scope for P1.1 (→ P1.2 / P4)
- Today content reshape (removing stats/compare, action carousels) — Today stays AS-IS in P1.1 (still shows its current stats carousel). It just lives under the new nav.
- Progress absorbing the stats/compare — Progress stays as-is.
- Review library real assembly (dissolving Reference, dedup My-Lists, past-exams/uploads) — placeholder index only.
- Chat rework (sidebar/retention/context/image) — FAB just routes to the existing `/chat`.
- Grammar-practice drop-its-browse (D3), Dictionary tab split (D2), suggestions-into-LEARN (D4) — all P4.

## Tests + verify
- nav.ts: the exhaustiveness partition still holds (a compile test / the existing guard). BottomNav renders 5 slots incl. the hexagon. LearnMenu opens/closes + lists 7 items + navigates. ChatFab hidden on /chat + /settings + when examActive + keyboard-open; visible elsewhere. Redirect shims resolve old→new. `useKeyboardOpen` toggles on viewport change. Existing page tests still pass at new paths (update any hardcoded `/review`/`/topik` expectations).
- VERIFY green: client `tsc --noEmit` (0), `npm run lint` (0/0), `vitest run` (all), `npm run build` (0).

## Then
/fixpass the P1.1 skeleton (nav correctness, no orphaned routes, the two patterns' a11y + visibility logic, no regressions), deploy blue/green on M, user sees the new nav live. Then P1.2.
