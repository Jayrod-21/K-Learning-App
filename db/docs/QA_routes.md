# QA Audit — Route & Navigation Integrity (Overhaul P1.2)

- **Date:** 2026-07-07 · **Branch:** `feat/overhaul-p1.2` · **Scope:** read-only audit, no code changes
- **Method:** full route inventory (`App.tsx` + `lib/redirects.tsx` + `ReferenceRedirect`) cross-checked against every navigation call site in `client/src` (`navigate(`, `<Link`, `to=`, `href=`), the nav manifest (`lib/nav.ts`), the three nav surfaces (BottomNav, LearnMenu, ChatFab), and a live route-serving check against the deployed app on `:1840`.

## Verdict

**No dead-end links. No broken redirects. No wrong-tab states. One orphaned route (`/images`).** All 30 probed paths serve `200 text/html` from the deployed app.

---

## 1. Route inventory (App.tsx)

| Path | Component | Status |
|---|---|---|
| `/login` | Login (PublicOnly) | OK |
| `/` | Today | OK — bottom tab |
| `/progress` | Progress | OK — bottom tab |
| `/review` | ReviewLibrary | OK — bottom tab |
| `/review/mistakes` | Mistakes | OK — library row + Today shortcut |
| `/review/vocab` | ReviewVocab | OK — library row + LibrarySubnav + Review.tsx:770 |
| `/review/dictionary` | ReviewDictionary | OK — library row + LibrarySubnav |
| `/review/grammar` | ReviewGrammar | OK — library row + LibrarySubnav + Grammar.tsx:648 |
| `/settings` | Settings | OK — bottom tab |
| `/learn/topik` | Topik | OK — hexagon + Today exam panel |
| `/learn/listen` | Ttmik | OK — hexagon + Today task tiles |
| `/learn/vocab` | Review (FSRS flashcards) | OK — hexagon + Today queue CTA + library hot-button |
| `/learn/grammar` | Grammar | OK — hexagon + library hot-button + Review.tsx:602 |
| `/learn/writing` | Writing | OK — hexagon + Today task tile |
| `/learn/hanja` | Hanja | OK — hexagon |
| `/learn/reading` | Reading (placeholder) | OK — hexagon |
| `/diagnostic` | Diagnostic | OK — reachable via Progress retake (Progress.tsx:486, :565) |
| `/images` | Images | **ORPHANED** — see finding O-1 |
| `/chat` | Chat | OK — ChatFab + AskAboutThisButton (hard contract) |
| `*` | `<Navigate to="/" replace>` | OK — soft catch-all by design |

Redirect shims (`lib/redirects.tsx`, mounted under the Shell layout route):

| Old path | Target | Status |
|---|---|---|
| `/topik` | `/learn/topik` | OK |
| `/ttmik` | `/learn/listen` | OK |
| `/reading` | `/learn/listen` | OK (repointed pre-overhaul shim; new placeholder deliberately at `/learn/reading`) |
| `/grammar` | `/learn/grammar` | OK |
| `/writing` | `/learn/writing` | OK |
| `/hanja` | `/learn/hanja` | OK |
| `/mistakes` | `/review/mistakes` | OK |
| `/reference` (no/unknown tab) | `/review/vocab` | OK — tab-aware `<ReferenceRedirect/>` (see §3) |

## 2. Findings table

| # | Type | Where | Finding | Fix |
|---|---|---|---|---|
| O-1 | **ORPHANED** | `client/src/App.tsx:127` (route), `client/src/lib/nav.ts:227-235` (`images` in `SECONDARY_IDS`) | `/images` has **no UI path to it**. Nothing in `client/src` navigates there — the only occurrences of the path are the route registration, the nav-manifest entry, and the unrelated API path in `services/images.ts:215`. The page works if hand-typed, but no tab, hexagon item, library row, FAB, or in-page link reaches it. `OVERHAUL_DESIGN.md:79` marks Images/OCR "TBD … fold into `/review/uploads` or the chat image feature — **open sub-task**", so this is a known gap — but as shipped, a real feature (OCR mining) is invisible to the user. | Short term: add a row/entry (e.g. a ReviewLibrary row or Settings link) pointing at `navItem('images').path`. Long term: resolve the open sub-task per the design doc. |
| N-1 | NOTE (not routes) | `client/src/pages/ReviewLibrary.tsx:59-60` | `Past TOPIK exams` and `Uploads` rows are inert "coming soon" `<div>`s (no `to`), and **`/review/exams` / `/review/uploads` are not registered routes** — a direct URL hit falls through `*` to `/`. Matches design intent (routes land in P4/P6); no dead-end because nothing navigates to them. | None now; register routes when P4/P6 land. |
| N-2 | NOTE (doc divergence) | `client/src/lib/redirects.tsx:48` vs `db/docs/OVERHAUL_DESIGN.md:75` | Design table says `/reference` → `/review`; implementation sends the tab-less `/reference` to `/review/vocab`. The implemented behavior is arguably better (Vocabulary was the Reference default tab) and the tab-aware cases all land correctly, but the doc and code disagree on the fallback. | Update the design-doc row, or repoint the fallback — either way, make them agree. |
| N-3 | NOTE (a11y/UX) | `client/src/components/BottomNav.tsx:121-140` | On `/chat`, `/diagnostic`, and `/images` **no bottom cell reads active** (no primary-tab prefix match, not a `/learn/*` path). Not a wrong-tab bug — nothing lights incorrectly — but the bar shows no location on these three screens. | Acceptable for secondary screens; if undesired, add an explicit "no-tab" affordance or map diagnostic → Progress. |
| N-4 | NOTE (intentional) | `client/src/pages/Today.tsx:281` | The **Reading** task tile navigates to `/learn/listen` (same as Listening), not the `/learn/reading` placeholder. Consistent with the retired-Read-screen history; flagging so it's a decision, not an accident. | Repoint to `/learn/reading` once that page has real content (P6). |

**Zero findings** in the categories: dead-end links, broken/dangling links, missing redirect shims, wrong-tab active states, nav-manifest inconsistencies.

## 3. Cross-checks performed (all PASS)

**Dead-end sweep** — every static and dynamic navigation target resolved against the route table:
`/chat` (ChatFab.tsx:56, AskAboutThisButton.tsx:48), LEARN paths via `navItem()` (LearnMenu.tsx:61), primary-tab paths (BottomNav.tsx:70), library rows + hot-buttons via `navItem()` (ReviewLibrary.tsx:96, :116 — resolves to `/review/mistakes`, `/review/vocab`, `/review/dictionary`, `/review/grammar`, `/learn/vocab`, `/learn/grammar`), `/diagnostic` (Progress.tsx:486, :565), LibrarySubnav routes (LibrarySubnav.tsx:41), `/learn/vocab` + task tiles (`/learn/listen` ×2, `/learn/writing`) + `/learn/topik` + `/review/mistakes` (Today.tsx:314, :362, :397, :415), `/` (Diagnostic.tsx:1100), `/learn/grammar` with router state (Review.tsx:602), `/review/vocab?tab=lists` (Review.tsx:770 — `ReviewVocab` honours the param via `useSearchParams`, pages/review/ReviewVocab.tsx:82-87), `/review/grammar` (Grammar.tsx:648). Self-navigations (Chat.tsx:326 seed-clear, Grammar.tsx:348) are same-path `replace` calls. No `<Link>` components and no internal `href=` targets exist in `client/src`; the only `window.location` uses are reload/protocol checks, not navigation. **Every target is a live route or shim.**

**Redirect completeness** — all 8 legacy paths shimmed (table above). `/reference?tab=dictionary|grammar|lists` land on `/review/dictionary`, `/review/grammar`, `/review/vocab?tab=lists` respectively via `referenceTarget()` (lib/referenceTarget.ts:10-24); unknown tabs fall back to `/review/vocab`. The old `/review` flashcards meaning deliberately has no shim (`/review` is live again as the library — documented in redirects.tsx:22-24). No other pre-overhaul path exists to shim.

**Nav surfaces** — all 7 `LEARN_SUBPAGE_IDS` paths (`/learn/topik|listen|vocab|grammar|writing|hanja|reading`) match registered routes 1:1; all 4 `PRIMARY_TAB_IDS` paths (`/`, `/progress`, `/review`, `/settings`) match; ChatFab targets `/chat` and correctly hides on `/chat` + `/settings` (segment-boundary match, ChatFab.tsx:27-38).

**nav.ts integrity** — every `NavItem.path` in the manifest corresponds to a registered route (18/18, including the orphaned-but-registered `/images`). Compile-time exhaustiveness (`_MissingFromBuckets`), extra-id (`_ExtraInBuckets`), and pairwise-overlap checks cover all 18 ids across the 3 buckets (nav.ts:295-318). `BottomNav.matchActiveId` uses longest-prefix with a `/`-boundary guard, so `/review/mistakes|vocab|dictionary|grammar` light **Review**, `/learn/*` lights the **hexagon** (`isLearnPath`, incl. bare `/learn`), and no path lights a wrong tab.

**Cross-cutting pins** — `AskAboutThisButton` pins `CHAT_PATH = '/chat'` (AskAboutThisButton.tsx:31) with absolute navigation, so all four re-homed hosts still work: Mistakes (`/review/mistakes`, pages/Mistakes.tsx:97), Topik (`/learn/topik`, pages/Topik.tsx:635), MockMode (under `/learn/topik`, pages/topik/MockMode.tsx:1419), Diagnostic (`/diagnostic`, pages/Diagnostic.tsx:791). The F-020 seed rides router state, is consumed via `readChatSeedState` (Chat.tsx:236-237, composer prefill at :300), and is cleared with a same-path `replace` so back/reload never re-seeds (Chat.tsx:320-334).

## 4. Deployed route-serving check (:1840)

All 30 probed paths returned `200 text/html` (SPA shell), including all legacy shim paths, `/images`, `/reference`, the not-yet-routed `/review/exams` + `/review/uploads`, bare `/learn`, and a garbage path (client-side catch-all handles the last four). **No 401/404/500 on any path.**

```
/ /progress /settings /diagnostic
/learn/topik /learn/listen /learn/vocab /learn/grammar /learn/writing /learn/hanja /learn/reading
/review /review/vocab /review/dictionary /review/grammar /review/mistakes
/chat /images /reference
/topik /ttmik /reading /grammar /writing /hanja /mistakes
/review/exams /review/uploads /learn /nonexistent        → all: 200 text/html
```
