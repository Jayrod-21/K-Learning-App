# Batch-3 Review — Grammar practice (`/learn/grammar`)

**Reviewer:** independent senior React/TS reviewer (did not write this code)
**Scope:** `client/src/pages/Grammar.{tsx,css,test.tsx}` on `feat/redesign-learn-a` @ `8eae3c8`, diffed against `rebuild`
**Read first:** `DESIGN_SEOUL_DAY_NIGHT.md`, `BUGS_AND_FEATURES.md` (F-128/F-129/F-131/F-158), the Grammar screens in the Learn-batch mockup, and the shared components `PageHubHeader`/`CollapsibleTile`/`CityCard`/`SealStamp`/`DancheongRail`.
**Method:** full diff read (727-line tsx/css diff + 296-line test diff), full-file trace of the F-158 state machine (targets, `genTick`, `advance`), `npx tsc --noEmit`, `npx eslint`, and `npx vitest run` (both `Grammar.test.tsx` and the consumed shared-component test files) actually executed, not just read.

## Verdict: **PASS** — no blockers. One SHOULD-FIX (test coverage gap on the revealed-phase "Another" path), two lower-priority SHOULD-FIXes (touch-target density, header actions-row placement vs. the mock), a couple of NITs.

The F-158 state machine — the core of this batch — is genuinely correct: picking a form really does stay on that form, "Another" really does regenerate the same pattern, leaving practice really does clear the pick, and the FU-NF-42 deep-link path is provably still intact. This is not "looks plausible," it's traced end-to-end below and backed by tests that would fail if any of those properties broke.

---

## Ticket checklist

| Ticket | Status | Notes |
|---|---|---|
| F-158 pick a form, drill continuously | **DONE** | See state-machine verdict below. |
| F-128 reskin | **DONE** | `PageHubHeader` (real `<h1>`), `CollapsibleTile surface="city"` + `DancheongRail` per proficiency group, `CityCard` as the drill hero, `SealStamp milestone` on Known rows, `.km-giwa`/`.km-hangul-watermark` on every empty state, `.km-rain-sheen` on the page root. All nine-device components used correctly (props validated against each component's actual type). |
| F-129 mobile | **DONE** for this diff's surface | Row uses flex + `min-width:0` + ellipsis; the new two-button row-actions cluster wraps (`flex-wrap:wrap`) instead of forcing width. Two new tests assert this directly. Pre-existing crowding concern noted below (SHOULD-FIX). |
| F-131 accent-driven hover | **Verified, not actually this diff's problem** | Grep of `Grammar.tsx`/`Grammar.css` for hex found zero hits. The shared `.km-btn--ghost:hover` reads `var(--vermilion)`, which I traced in `client/src/styles/index.css:348-401` — `--vermilion` is itself re-bound per `[data-accent]` × `[data-theme]`, i.e. it **is** the resolved accent token despite its Day-default name. So hover already follows the accent picker at the token layer; Grammar composes it for free. `BUGS_AND_FEATURES.md` still shows F-131 as 🔴 open — that looks like a stale ticket status, not a code gap, but flagging since the ticket doc and code have diverged. |

---

## F-158 state-machine verdict (explicit)

**Stays on the picked form: YES. Regenerates via "Another": YES. Clears cleanly on leave: YES. Deep-link still works: YES.**

Traced `Grammar.tsx` end to end:

- `formTarget` (`Grammar.tsx:481`) is separate state from `drillTarget` (`Grammar.tsx:447`, the pre-existing FU-NF-42 one-shot deep link). `drillForm` (`Grammar.tsx:484-494`) sets it from a `CardRow`'s own fields (`patternKey`/`pattern`/`title` → `DrillTarget.patternKey`/`display`/`meaning`, matching the shape `readDrillTarget` validates at `Grammar.tsx:208-220`) and pushes `?view=practice` in the same handler — both state updates are batched into one commit, so the mount-time "leaving practice clears `formTarget`" effect never fires spuriously on the way in.
- `activeTarget = formTarget ?? drillTarget` and `continuousDrill = formTarget !== null` (`Grammar.tsx:511-512`) give `PracticePanel` a single `target`/`continuous` pair regardless of which entry point fired. Deterministic precedence: a hand-picked form always wins over a lingering unconsumed deep link, by explicit design comment (`Grammar.tsx:507-510`), and I couldn't construct a path where the two race — the only way to reach a cards-row "Drill" click is to already be on `cards`, and a deep link's mount effect (`Grammar.tsx:457-467`) has already consumed itself into `?view=practice` before that's possible.
- Inside `PracticePanel` (`Grammar.tsx:1800-1807`), when `target` is set, `source = targetToSource(target)` — completely bypassing `idx`/`duePos`/the rotation pool. `patternKey` is therefore **constant** for the life of a continuous pick; nothing in the component can silently drift it to a different pattern, because nothing recomputes `source` from `idx` while `target` is truthy.
- `advance()` (`Grammar.tsx:1904-1919`), wired to **both** `Skip` and `Next pattern`/`Another` (`Grammar.tsx:2043-2044` — same callback, not two divergent code paths that could desync): with a continuous target it does `setGenTick(t => t+1); return;` and nothing else — `idx`/`duePos` are never touched. The generate effect's dep array (`Grammar.tsx:1889`, `[idx, duePos, patternKey, genTick]`) re-fires on the `genTick` bump with `patternKey` unchanged → a fresh `generateDrill` call for the identical pattern. This is exactly the mechanism the PROD generate-failure Retry already used (`retryGenerate`, `Grammar.tsx:1932-1934`), reused rather than duplicated — good reuse, not a hack.
- No duplicate-fetch/race risk: the generate effect aborts the prior `AbortController` before starting a new request (`Grammar.tsx:1827-1829`) and every settle path checks `ctrl.signal.aborted` before touching state (`Grammar.tsx:1855,1860`). Rapid double-clicks on "Another" can't leave a stale response overwriting a newer one.
- Leaving practice: `useEffect(() => { if (view !== 'practice') setFormTarget(null); }, [view])` (`Grammar.tsx:503-505`). Because `PracticePanel` is conditionally rendered only under `view === 'practice'` (`Grammar.tsx:871-888`), any view change away from practice actually **unmounts** the panel — so there's no leftover internal state (`genTick`, `idx`, `phase`, etc.) to worry about either, only the persisted rotation cursor (`readDrillCursor`/`writeDrillCursor`), which continuous mode never touches in the first place. A later plain "Practice" tap (`openPractice`, `Grammar.tsx:515-518`) doesn't touch `formTarget` itself, but by then it's already `null` from the leave-effect, so `activeTarget` correctly falls through to `drillTarget` (if any) or `null` → normal pool rotation. Verified live: `npx vitest run` passes, including the new test that clicks Drill → Back → Practice and asserts `Skip`/no-`Another` reappear (proof `continuous` flipped back to `false`).
- Deep link (`drillTarget`) unbroken: the pre-existing `describe('FU-NF-42 B3: practice opens focused on a deep-link target')` block (`Grammar.test.tsx:1712-1767`, untouched by this diff) still passes against the refactored `activeTarget`/`continuous` plumbing — I ran it, not just read it (`56 passed` in `Grammar.test.tsx`, `35 passed` across the four shared-component test files it consumes).

No BLOCKER here. This is the best-traced part of the diff and it holds up.

---

## Findings

### SHOULD-FIX

1. **Test gap: the revealed-phase "Another" label/behavior is never exercised.** (`client/src/pages/Grammar.test.tsx:1930-2264`, new F-158 describe block)
   All four new F-158 tests interact with the drill only in the **pre-reveal** phase (`Skip` → `Another`, never `Submit`). The assertion `expect(screen.queryByRole('button', {name: /next pattern/i})).not.toBeInTheDocument()` (test at `Grammar.test.tsx:~2072`) is true trivially in the pre-reveal phase regardless of `continuous` — pre-reveal never renders "Next pattern" for *either* mode (`Grammar.tsx:2165-2171`). The actual "Another" vs. "Next pattern" swap that matters for the common real-world flow (submit → reveal → tap the CTA again) lives in the **revealed** branch (`Grammar.tsx:2174-2189`) and is completely untested. A regression that hardcodes `'Next pattern'` in the revealed branch (removing the `continuous ?` ternary at `Grammar.tsx:2187`) would not be caught by this suite. Recommend one more test: pick a form, submit an answer, reach `revealed`, assert the button reads "Another" (not "Next pattern") and that clicking it fires a second `generateDrill` call for the same `patternKey`.

2. **Row action-cluster touch-target density.** (`client/src/pages/Grammar.css:126-133`, `client/src/styles/index.css:836`)
   `.km-grammar__row-actions` now packs **two** `size="sm"` buttons (new "Drill" + the pre-existing "Mark known"/"Relearn") 6px apart. `.km-btn--sm` is `padding: 6px 10px; font-size: 12px` with no `min-height` — well under the 44px floor `DESIGN_SEOUL_DAY_NIGHT.md` §8 requires ("touch targets ≥ 44px"). This gap pre-dates this diff (the shared `Button` component has never enforced a touch-target floor for `sm`), but this diff is the first thing in the Grammar page to put two small, adjacent, easily-confused tap targets ("Drill continuously" vs. "Mark known"/"Relearn" — one starts an endless drill, the other changes mastery state) on every single row. Worth a real fix at the shared `Button`/`.km-btn--sm` level (out of this page's authority to fix alone) rather than shipping the density increase silently.

3. **`PageHubHeader`'s `actions` slot renders below the rail divider, not inline with the title** (`client/src/components/PageHubHeader.tsx:89-94`, `PageHubHeader.css:.km-hubheader__actions`), whereas the mock (`km-learn.html:162`) shows the "Practice" button on the **same row** as the `문법 연습` title (`<div class="top">…<button class="btn">Practice</button></div>`). This is inherited shared infra (not something the Grammar builder introduced or could unilaterally change) and was apparently accepted in the batch-2 fixpass per the component's own doc comment — but that comment also says "No current consumer needs this [actions prop]," which is now stale since Grammar is the first real consumer. Flagging as a coordination note for whoever owns `PageHubHeader`, not a Grammar-page defect.

### NIT

4. **`GROUP_TONE_BY_INDEX` is keyed to the *filtered* (non-empty) groups array, not the fixed `PROFICIENCY_GROUPS` array.** (`client/src/pages/Grammar.tsx:1031-1034` `groups = PROFICIENCY_GROUPS.map(...).filter(g => g.rows.length > 0)`, then `groups.map((g, i) => ... GROUP_TONE_BY_INDEX[i % 4])`.) The component doc comment (`Grammar.tsx:272-286`) calls the per-index tone assignment "stable," but because empty groups are filtered out before indexing, a given proficiency level's tone can shift between sessions as other groups populate or empty out (e.g. Beginner is `mint` when it's the only populated group, but becomes `blue` if a lower-index group like nothing precedes it — more relevantly, if Beginner's slot 0 is skipped because Beginner itself is empty, the *next* populated group inherits index 0's tone instead). Harmless given the comment's own disclaimer that this isn't a semantic mapping, but "stable" overstates what's actually delivered; a NIT worth a doc-comment tweak, not a code change.

5. Stale references to "the bare `Topbar`" survive only in comments (`Grammar.tsx:85,815`) — the import itself is correctly removed and `eslint`/`tsc` are clean. Not a functional issue, just a heads-up that the comment prose slightly outlives the code it's describing (normal for incremental diffs, not worth blocking on).

### PRAISE

- The `continuous`/`target` threading through `PracticePanel` → `DrillCard` is a clean minimal diff: one new boolean prop, reused in exactly the two label ternaries and one early-return branch it needs to touch. No parallel/duplicate drill-loop was built for the continuous case — it's the same `advance`/generate-effect machinery with one new branch, which is exactly the right amount of change for this feature.
- The new F-158 tests are **not tautological** for the parts they do cover — in particular "'Another' regenerates the SAME picked pattern" asserts on `generateDrill.mock.calls[0][0]` **and** `calls[1][0]` both carrying the same `patternKey`, which would fail if `advance()` ever fell through to the rotation instead of bumping `genTick`. That's a real regression-catcher, not a smoke test.
- Comment discipline throughout the diff is unusually good for tracing intent — e.g. the precedence comment at `Grammar.tsx:507-510` explains not just what the code does but why the apparent race it guards against can't actually occur, which is exactly the kind of context a reviewer needs and most diffs don't bother to leave.
- `SealStamp`, `CityCard`, `DancheongRail`, and `CollapsibleTile` props are all used with values that type-check against each component's actual exported prop types (`DancheongRailTone`, `CityCardTone`, `SealSize`/`SealTone`) — no stringly-typed prop guessing, confirmed by reading each component's source, not just assuming.
- `npx tsc --noEmit`, `npx eslint`, and `npx vitest run` all pass clean on this page and its consumed shared components — verified by actually running them, not inferred from the diff.

---

## Coordination observations

- F-131's actual fix lives entirely at the shared token layer (`client/src/styles/index.css`), not in any per-page diff — worth noting for whoever is tracking ticket status, since `BUGS_AND_FEATURES.md` still lists it 🔴 open while the code appears to already satisfy it for every page that only uses shared `Button`/`Pill` (which includes Grammar).
- The touch-target-floor gap (SHOULD-FIX #2) and the `PageHubHeader` actions-placement gap (SHOULD-FIX #3) are both shared-component issues that any single page's fixpass can flag but not fix alone — they'll keep resurfacing per-page until someone takes them as their own cross-cutting ticket, the same pattern that produced the `PageHubHeader` consolidation itself (per its own doc comment, referencing `REVIEW_batch2-fidelity.md` BLOCKER-2).
