# Independent Review — Phase 3C-1, Hanja surface

Reviewer: independent senior reviewer (report-only, no code modified)
Scope: `client/src/pages/Hanja.tsx` / `.css` / `.test.tsx`, `client/src/services/hanja.ts`
Context read: `client/src/pages/Review.tsx`, `server/src/routes/hanja.ts`, `server/src/routes/vocabLists.ts`, `client/src/components/Flashcard.tsx`, `client/src/hooks/usePagination.ts`, `client/src/services/api.ts`, `client/src/types/domain.ts`
Diff base: `rebuild` → `feat/phase3c1-cards`
Verification: `vitest run src/pages/Hanja.test.tsx` → 40/40 pass (re-run during review)

## Verdict

**PASS — 0 blockers.** The Drill button is genuinely functional (rebuild's button had no `onClick`; it now seeds an idempotent recognition card and enters a real cards/due → self-rate → 409-aware review loop wired to the shared FSRS scheduler). The stroke-order stub is honest and the card-seed-for-id side effect is deliberate, idempotent, and disclosed in the UI. 3 SHOULD-FIX, 6 NIT, 8 PRAISE.

## Quality-bar checklist

| Bar | Result |
|---|---|
| WCAG AA / correct ARIA | PASS with one caveat (SF-1: Space-key conflicts; Enter works everywhere, so operable) — tablist/tab + `aria-selected`, toolbar + `aria-pressed`, `role="group"` ratings, `role="alert"`/`role="status"` split, progressbar clamp tests, `role="img"` canvas with descriptive label |
| Strict TS at I/O boundaries | PASS — every new wrapper narrows the wire shape; BIGINT-as-string ids coerced at the boundary; no `any` |
| No swallowed errors | PASS — all four sub-view fetches are AbortController-driven, cancellation filtered via `isCanceled`, real `ErrorCard`/inline-alert + retry on every path; error copy is author-controlled (`errorMessageFor`), never server prose |
| Tests exercise real behavior | PASS — wire payloads asserted (`expected_version: 3`, `addHanjaToList(5, [1])`, `createList({kind:'hanja'})`), failure + 409 paths, ARIA states, two-step delete confirm, no-refetch overlay proof |
| Co-located CSS | PASS — `Hanja.css` new this phase, fully tokenized, both themes free |
| No scope creep | PASS — diff confined to ticket surface; F-077 confirmed deferred (see below) |
| No console.log / no ticketless TODO | PASS — grep clean across all four files |
| Honest-stub bar (F-076) | PASS — see F-076 section |

## Ticket verification

### F-075 — flashcard system + lists (VERIFIED)
- Wrappers hit the real endpoints and I verified each against the server route source:
  - `seedHanjaCard` ↔ `POST /hanja/:char/card` (`server/src/routes/hanja.ts:560-631`) — idempotent `ON CONFLICT … DO NOTHING` on the migration-050 partial unique index, 201/`created:true` vs 200/`created:false`, response carries `character_id`.
  - `fetchHanjaDueCards` ↔ `GET /hanja/cards/due` (`hanja.ts:648-678`) — client `STUDY_SESSION_LIMIT = 50` is inside the server's 1–200 Zod bound.
  - `submitHanjaCardReview` ↔ `POST /hanja/cards/:cardId/reviews` (`hanja.ts:707-737`) — body shape matches the `.strict()` `CardReviewBodySchema` exactly (`rating`, optional `duration_ms`, `expected_version`); client clamps `duration_ms` to the same `INT4_MAX` the server enforces; shared `applyCardReview` FSRS path with `requireHanjaTarget: true`.
  - Lists ride the 049 multitype infra: `fetchHanjaLists` (`GET /vocab/lists?kind=hanja`, limit 100 = server max), `fetchHanjaListDetail` (049 `item_type` + `hanja_*` columns), `addHanjaToList` (typed `{items:[{type:'hanja',id}]}`, 409 = duplicate), `removeHanjaFromList` (`?type=hanja` addressing the XOR column — matches `RemoveQuerySchema` default-'vocab' behavior at `vocabLists.ts:679-686`).
- **Card-seed-for-id round trip:** deliberate, correct, and disclosed. The rationale is documented in the `AddToListTile` doc comment (`Hanja.tsx:2175-2184`), the seed is idempotent server-side, and the UI states it in plain copy at `Hanja.tsx:2283-2286`: *"Lists group characters for focused study. Adding 學 also puts its flashcard in your deck."* Not a silent surprise write. Tests assert the seed→membership sequence (`Hanja.test.tsx:702-724`).
- New-list creation (`kind: 'hanja'`) works from both the lists view and the detail-sheet tile; duplicate membership 409 is presented as information (`role="status"`, not alert) — tested.

### B-028 — dead Drill button (VERIFIED FIXED)
`git show rebuild:client/src/pages/Hanja.tsx` line ~690: the old button had **no onClick handler** — genuinely dead. Now (`Hanja.tsx:2014-2029`) it seeds the card (making it immediately due), navigates to `?view=study`, and on failure keeps the sheet open with a `role="alert"` and resets pending. The study flow itself is real: await-then-advance (never optimistic — a failed rating can't be dropped silently), buttons disabled in flight, 409 gets a distinct "rescheduled elsewhere" message with a Refresh-deck CTA instead of replaying a stale snapshot. Both paths tested (`Hanja.test.tsx:657-688`, 594-635).

### F-076 — drawing drill (VERIFIED, honest stub)
- No fabricated stroke guidance anywhere. The About tile (`Hanja.tsx:1770-1774`) states: *"Freehand practice only — nothing is graded or saved. Stroke-order guidance isn't available yet: the corpus doesn't carry per-character stroke data."* That meets the honest-stub bar exactly.
- Keyboard/AT alternative: the same tile names the pointer-only limitation and links a real button to the flashcard drill (`Hanja.tsx:1776-1790`); canvas is `role="img"` with a descriptive label so AT never encounters an operable-but-unusable widget (`Hanja.tsx:1932-1945`). Test asserts all three disclosures and that the alternative button actually routes (`Hanja.test.tsx:958-973`).
- Canvas mechanics: dpr-scaled bitmap, undo/clear driven by a stroke model that updates even without a 2d context (tested model-first at `Hanja.test.tsx:935-956`), reveal-compare ghost with `aria-pressed` toggle, single-point taps drawn as dots, ink follows the theme via computed `color`, `touch-action: none` in CSS.

### F-077 — no speculative reword (VERIFIED)
Every removed line in the `Hanja.tsx` diff vs `rebuild` is structural (re-indentation under the `subContent` wrapper, `IndexView` pagination, `HanjaDetail` prop additions). All pre-existing user-facing strings — "Read a passage to start mining 한자…", "Hanja unavailable", "Drill · recall 음 & 뜻", empty states — reappear verbatim.

### F-024 — BackButton on nested views (VERIFIED)
Every sub-view renders `<BackButton>` with an explicit `to` (`Hanja.tsx:369-372, 421-423`); list detail goes up one level to `?view=lists`, everything else to the root — deep links can't strand the user. Tested (`Hanja.test.tsx:520-531`).

## Findings

### BLOCKER
None.

### SHOULD-FIX

**SF-1 — Space-key conflicts between the global reveal listener and focused controls** (`Hanja.tsx:913-926` + `components/Flashcard.tsx:55-60`)
The window-level spacebar handler excludes only `INPUT`/`TEXTAREA`/`SELECT`. Two consequences:
1. A keyboard user who Tabs to a **rating button** and presses Space gets the card flipped back (the handler's `preventDefault()` on keydown also cancels the button's space-activation click) — the ratings unmount instead of the rating being recorded.
2. With the **flashcard itself** focused, Space fires both the Flashcard's own keydown handler and the window listener → double toggle → visible no-op.
Enter works in both spots, so this is not a WCAG 2.1.1 blocker, and the pattern is inherited verbatim from `Review.tsx:1403-1417` (which is worse — it doesn't even exclude `SELECT`). Fix in one place for both pages: skip when `document.activeElement` is any interactive element (or when the event target is inside the card/ratings), ideally hoisted into a shared hook.

**SF-2 — Misleading partial-failure copy in "Create & add"** (`Hanja.tsx:2247-2272`)
`createAndAdd` runs createList → seed → membership under one catch. If the list is created but the seed or membership write fails, the status reads *"Couldn't create that list. Try again."* — false: the list exists (it's already in local state and pre-selected in the combobox). A user who retries via "Create & add" mints a second, identically-named list. Distinguish the phases, e.g. "List created, but 學 couldn't be added — select it above and press Add."

**SF-3 — `restart` after a 409 discards the user's place silently in longer sessions** (`Hanja.tsx:892-900, 952-956`)
Minor behavioral note rather than a bug: "Refresh deck" refetches from scratch and resets `idx` to 0, so in a 50-card session a mid-deck 409 restarts the walk (already-rated cards won't re-appear since they're no longer due, so no double-rating — correct, just abrupt). Consider preserving nothing but stating it: the current copy "Refresh the deck to continue" is adequate; at minimum keep as-is knowingly. Downgrade to NIT if the team judges the copy sufficient.

### NIT

**N-1** — Canvas bitmap is sized once on mount (`Hanja.tsx:1823-1831`); a post-mount box resize (orientation change on <320px viewports) leaves the bitmap mismatched to the CSS box until remount, skewing stroke alignment. Exposure is small because the stage is `min(320px, 100%)`.

**N-2** — Silent windowing caps: `GRID_WINDOW.max = 960` and `LIST_WINDOW.max = 300` (`Hanja.tsx:156-159`) make rows beyond the cap unreachable — ShowMore just stops with no "N more hidden" note. Documented as deliberate render-cost bounds; fine at current corpus scale.

**N-3** — `fetchHanjaLists` fetches `limit: 100` (the server max) with no pagination (`services/hanja.ts:246-254`); a 101st hanja list would silently never appear in the lists view or the add-to-list select. Acceptable under the single-user scope.

**N-4** — `parseListId` accepts exponent forms (`?id=1e2` → list 100) (`Hanja.tsx:220-224`). Harmless; a `/^\d+$/` guard would be stricter.

**N-5** — `MockBadge` is suppressed on all sub-views (`Hanja.tsx:420`), but `DrawView` consumes the root pool which can be on its mock fallback — dev-only cosmetic inconsistency with the badge's purpose.

**N-6** — Success confirmations use `role="status"` elements that mount *with* their content (`Hanja.tsx:1578-1589, 2367-2378`); some screen readers don't announce a live region inserted already-populated (unlike `role="alert"`). A persistent live region with swapped text is the more reliable pattern.

### PRAISE (fix-pass must not undo)

**P-1** — `services/hanja.ts` is verifiably additive: the diff vs `rebuild` touches only the type-import statement; all pre-existing functions (`fetchHanjaList`, `fetchHanjaProgress`, `fetchHanjaToday`, `setHanjaState`) are byte-identical. The ~220 new lines narrow every server response at the boundary, coerce BIGINT-as-string ids exactly where node-postgres serializes them, keep NUMERIC `stability`/`difficulty` as strings (precision-safe, matching the vocab convention), thread `AbortSignal` through every call, and document 409/404 semantics per wrapper.

**P-2** — The card-seed-for-id side effect is handled the right way: idempotent server-side (partial unique index), rationale documented at both call sites and in the wrapper, and disclosed to the user in plain product copy — an honest design for a DTO gap rather than a hack.

**P-3** — Review submission is server-authoritative and defensively correct: rating + `expected_version` only, `duration_ms` clamped to INT4 client-side to mirror the server bound, await-then-advance so no review is ever silently lost, and the rating labels deliberately avoid fake interval hints ("hard-coded 1d/4d labels would be a lie").

**P-4** — F-076 is a model honest stub: three distinct disclosures (not graded/saved, no stroke data, pointer-only) plus a working one-click accessible alternative, all covered by tests that would fail if the disclosures were removed.

**P-5** — Test suite quality is high for a page this size: 40 tests assert wire payloads, ARIA states (`aria-pressed`, `aria-expanded`, progressbar clamping to valuemax), optimistic-overlay behavior proven by asserting *zero* refetches, both halves of the two-step delete confirms, 409-as-information vs 409-as-stale distinction, and the canvas stroke model without a 2d context. No tautologies found.

**P-6** — Partial-failure honesty in `addAllToDeck` (`Hanja.tsx:1444-1479`): sequential idempotent seeds with an exact "Stopped after N of M" report, and an honest created-vs-already-there tally on success (tested).

**P-7** — The B-014 pattern is correctly applied to the study card (`Hanja.tsx:1064-1068`): the answer face mounts only while flipped, so the next card's answer can't flash through the flip-back sweep and stays out of the a11y tree until revealed.

**P-8** — Two-step inline delete confirm instead of `window.confirm` (poor AT support), with the armed state disabling correctly during flight — in both the lists index and list detail.

## Coordination observations

1. **`services/hanja.ts` wrappers** — additive as claimed (P-1). One deliberate duplication to track: `fetchHanjaListDetail` re-types `GET /vocab/lists/:id`, which `services/vocab.getListDetail` already types with the pre-049 vocab-only columns. The rationale is documented, but two client type-views of one endpoint can drift — a future task should migrate `vocab.getListDetail` to the 049 shape and delete the hanja-local view.
2. **SF-1 is shared with `Review.tsx`** — the fix belongs in a shared hook (or inside `Flashcard`), not in two page-local copies; a fix-pass that patches only Hanja leaves the vocab session with the same defect.
3. **nginx allow-list** — no new top-level API prefixes this phase (`/hanja` and `/vocab` are already allow-listed), so no `km-lb` config change is needed (the F-012 class of failure does not apply).
4. **`INT4_MAX` duplicated** client (`Hanja.tsx:152`) and server (`routes/hanja.ts`) — acceptable (client can't import server constants) and both are commented.
5. The study view faithfully mirrors the vocab Review session conventions (spacebar reveal, deck advance, empty/complete states, seal-stamped completion) — the "similar to vocab" requirement is met without copy-pasting Review.tsx wholesale.
