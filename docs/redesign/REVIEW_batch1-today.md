# Review: Today page rework

**Reviewer:** independent senior React/TS review (did not write this code)
**Scope:** `client/src/pages/Today.tsx`, `Today.css`, `Today.test.tsx` @ `feat/redesign-today-progress` (083388d, off `rebuild`)
**Consumed but not re-reviewed:** `SkylineHeader`, `CityCard`, `DancheongRail`, `SealStamp`, `CollapsibleTile`, `SwipeCarousel` (foundation components — already fixpassed per `docs/redesign/REVIEW_components.md` etc.)

## Summary verdict: **PASS WITH CONDITIONS**

The page-level rework is well-built: every claimed ticket is genuinely implemented, the code reads as senior-level (clear separation of concerns, honest empty/loading/error states, no fabricated data, token-driven CSS, clean strict-TypeScript, 29/29 tests green, zero ESLint errors), and the "honesty" discipline the codebase has clearly standardized on (never show a fake zero, never fake a denominator) is followed carefully throughout. This is good work.

The one BLOCKER is a test-quality gap, not a runtime bug: the implementation of F-138's local-day math is *correct*, but the test suite as written cannot detect a regression to UTC-day math, because it never establishes a genuine UTC-vs-local day-boundary case and CI runs on `ubuntu-latest` (TZ=UTC), where local getters and UTC getters are indistinguishable. Given F-138 was flagged as the highest-risk ticket specifically because of this exact class of bug, the test suite needs a deterministic boundary case before this should be considered proven, not just "probably correct because I read the code."

Everything else is SHOULD-FIX/NIT-level polish, several PRAISE-worthy engineering decisions, and one judgment call (the writing tile's Night-glow CSS duplication) that I consider an acceptable, well-reasoned shortcut rather than a defect.

---

## Ticket checklist

| F-# | Claimed | Actually done? | Evidence |
|---|---|---|---|
| F-128 | Seoul Day/Night identity adopted on Today | ✅ Yes | `Today.tsx:82-86` imports `SkylineHeader`/`CityCard`/`DancheongRail`/`SealStamp`/`CollapsibleTile`; `Today.tsx:581` `km-rain-sheen`; `Today.tsx:662` `km-hangul-watermark` |
| F-129 | No horizontal overflow at mobile widths | ✅ Yes | `Today.css:38-41` `max-width:100%`, no fixed px widths >36px anywhere in `Today.css`; `min-width:0` on flex children (`Today.css:111`, `CollapsibleTile.css:35`) |
| F-130 | Touch-swipe works | ✅ Yes (inherited) | `SwipeCarousel.tsx` uses Pointer Events (`onPointerDown/Move/Up`, `SwipeCarousel.tsx:146-224`) which unify touch/mouse/pen; Today's carousels consume `SwipeCarousel` unchanged |
| F-131 | No hardcoded hex; hover follows accent | ✅ Yes | `grep -nE "#[0-9a-fA-F]{3,8}|rgb\("` over `Today.css`/`Today.tsx` → zero hits; `.km-today__tileIcon` (`Today.css:104-107`) and `.km-today__linkBtn:hover` (`Today.css:174-176`) key off `var(--km-tone, var(--vermilion))` / `var(--vermilion-ink)`, both accent-picker-aware tokens (`styles/index.css:349-397`) |
| F-133 | Tighten layout | ✅ Yes | Reduced hero/section margins (`Today.css:22-32`), tile padding 20px→14/16px (`Today.css:87-89`), icon 40px→36px, headline 16px→15px |
| F-134 | Writing expands inline | ✅ Yes, correctly | `CollapsibleTile` with `aria-expanded={!collapsed}` (`CollapsibleTile.tsx:68`), toggles on click, F-101 handoff preserved (`Today.tsx:474-476`, test `Today.test.tsx:642-682`) |
| F-135 | Tasks-title IA cleanup | ✅ Yes | "Today's tasks" + "TOPIK" merged into single "Suggested learning" section (`Today.tsx:660-673`); "Review mistakes" folded into TOPIK page instead of its own carousel tab |
| F-136 | R/W/L/TOPIK + daily reading rotation | ✅ Yes | All four modalities present in one carousel (`Today.tsx:415-577`); rotation confirmed server-side only — `server/src/routes/plan.ts:260-318` orders reading/listening/writing by `md5(user_id || seoul_date || row_id)`; Today.tsx does not duplicate any rotation logic, just renders whatever the plan sends |
| F-137 | No TOPIK progress-bar highlight | ✅ Yes | No `role="progressbar"` anywhere (asserted `Today.test.tsx:471`); TOPIK's "done today" is plain text + honest `SealStamp`, never a meter. *(Judgment note: the tile still carries a gold "Recommended" pill + `feat` neon emphasis — see NIT below.)* |
| F-138 | Real per-day attempt counts | ⚠️ **Implementation correct; test coverage insufficient** | `isLocalToday` (`Today.tsx:134-142`) uses local `getFullYear/getMonth/getDate` — correct. See **BLOCKER** and **F-138 verdict** below. |
| F-139 | Words/vocab tile removed | ✅ Yes | No `/learn/vocab` reference anywhere in `Today.tsx`/`Today.css`; explicit negative test (`Today.test.tsx:350-359`) |
| F-140 | Hanja tile in carousel | ✅ Yes | `Today.tsx:636-656`, routes to `/learn/hanja`, which is a real registered route (`App.tsx:136`), not a stub |

---

## Findings

### BLOCKER

**B1 — F-138's test suite cannot detect a UTC-vs-local regression (the exact bug class the ticket exists to prevent).**
`isLocalToday` (`Today.tsx:134-142`) is implemented correctly — it does `new Date(iso)` then reads `.getFullYear()/.getMonth()/.getDate()`, which are local-timezone getters, not `getUTCFullYear()` etc. This is the right implementation.

However, `Today.test.tsx`'s only day-boundary fixtures are `TODAY_ISO = new Date().toISOString()` (line 162) vs. `LONG_AGO_ISO = '2019-03-01T00:00:00.000Z'` (line 163) — years apart. A regression that swapped the local getters for UTC getters would still pass every one of these assertions, because "right now" and "seven years ago" land on the same calendar day under *either* interpretation. The suite has zero cases that are close to a real day boundary (e.g., a timestamp constructed to be "11:30pm local / already tomorrow UTC" or vice versa).

Worse, the test file's own comment (`Today.test.tsx:158-161`) explains they deliberately avoid `vi.useFakeTimers()` "matching the rest of this suite" — which means the suite has no mechanism to construct a *deterministic* boundary case at all; whatever it tests is incidental to whatever hour the test happens to run. And CI runs on `ubuntu-latest` (`.github/workflows/*.yml`, confirmed `TZ` is never set), which defaults to UTC — so in CI, local getters and UTC getters are **byte-for-byte identical**, and this test suite would pass 100% of the time even if a future refactor silently switched `isLocalToday` to UTC getters. That is precisely the "test that can't catch its bug" failure mode.

**Fix direction:** add at least one deterministic case, e.g. mock `Date` (or inject a fixed `ref`) so a fixture timestamp is provably on one UTC calendar day and a different local calendar day (or the reverse), and assert the local interpretation wins. This likely requires either (a) refactoring `isLocalToday`/the "now" computation to accept an injectable reference for testability, or (b) using `vi.setSystemTime` with a timezone-aware fixture. Either is a small, contained addition — this is a test-suite fix, not a page rewrite.

### SHOULD-FIX

**S1 — Writing's "done today" count is invisible unless the user expands the tile, unlike Grammar/TOPIK.**
`DoneTodayRow` for Grammar (`Today.tsx:622-629`) and TOPIK (`Today.tsx:552-559`) render directly on the always-visible `ActivityTile` face. Writing's `DoneTodayRow` (`Today.tsx:478-483`) is nested *inside* `CollapsibleTile`'s children — which starts `defaultCollapsed` (`Today.tsx:454`). So a user scanning Today sees "2 drills today" and "1 mock attempt today" at a glance, but has to tap open Writing to see "1 essay graded today." The test suite even had to call `activateWritingPage(user)` (i.e., expand it) before asserting the count (`Today.test.tsx:754-756`) — confirming this is the actual behavior, not an oversight in the test. This may be an intentional "keep the collapsed face uncluttered" call, but it's an inconsistency worth a product decision, not silent drift.

**S2 — Attempt-history fetches are capped at `limit: 20`, so a very active day can under-count.**
All three F-138 fetches (`Today.tsx:336-350`) request `{ limit: 20 }` against newest-first, unfiltered-by-date history endpoints (`grammarDrill.listAttempts`, `writing.fetchWritingAttempts`, `topik.fetchAttemptHistory`). If a user completes more than 20 grammar drills (or writing/TOPIK attempts) in a single day, the 21st+ item never arrives client-side and the "done today" count silently reads low instead of the true total. This is an edge case (unlikely for grammar/writing/TOPIK in one day) but directly contradicts the ticket's "reflects that day's actual completed exercises" framing for power users. Worth a comment acknowledging the cap, or a larger limit/paginated accumulation if it's a realistic scenario.

**S3 — Page-scoped Night-glow duplication on the Writing tile will silently drift if CityCard's *formula* (not just its tokens) changes.**
`Today.css:193-204` hand-copies CityCard's `[data-theme="dark"] .km-citycard` gradient/border/box-shadow ruleset (`CityCard.css:33-48`) onto `.km-today__writingTile`, substituting `var(--km-tone)` for the literal `var(--vermilion)`. I verified this substitution is *correct*, not a shortcut that breaks accent-awareness: `.km-tone--accent { --km-tone: var(--vermilion); }` (`seoul-devices.css:152`) and `--vermilion` itself is redefined per `data-accent` in `styles/index.css` (lines 89-92, 349-397) — so this override *does* track the accent picker and *does* track future token retunes (it references the same token names, not literal colors). The doc comment's reasoning (`--km-tone` isn't set in scope here because `CollapsibleTile` never gets a `km-tone--*` class) is accurate, and hardcoding to `--vermilion` is the right equivalent since the sibling `DancheongRail` is `tone="accent"` (fixed) either way.
What it will **not** survive is a *formula*-level change to CityCard's Night treatment (e.g., designers decide the border should be 2px, or the glow opacity stops should change) — that edit lives in one file and this copy in another, so they will silently diverge with no test or lint catching it. I'd accept this as shipped (it's honest about the tradeoff in its own doc comment, `Today.css:6-11`), but recommend opening a small shared-component follow-up (e.g., a `.km-citycard--dark-glow` mixin/utility class both `CityCard.css` and `Today.css` can apply) rather than letting page-scoped copies of this formula accumulate as more pages adopt CollapsibleTile+Night-glow.

**S4 — The "follow-up ticket" the code comments reference doesn't exist as a tracked ticket.**
`Today.tsx:16-19` and `:57-58` both say "see... the PR report for the follow-up ticket" regarding Hanja/Reading/Listening lacking attempt-history endpoints (so those tiles can't show a real daily count). No such ticket exists in `BUGS_AND_FEATURES.md`, and no `docs/redesign/*.md` mentions it either. A PR description isn't a durable backlog item — recommend filing it as an actual F-ticket so it doesn't get lost once the PR is merged and the description is buried in git history.

### NIT

**N1 — F-137's tile still carries emphasis, just not a progress bar.** The TOPIK `ActivityTile` is rendered with `feat` (stronger neon glow) and a gold "Recommended" `Pill` (`Today.tsx:536-544`). The ticket's literal ask — remove the highlighted *progress bar* — is satisfied (no `progressbar` role, confirmed by test), but if "no highlights" was meant more broadly (i.e., stop visually singling out TOPIK at all), this doesn't fully deliver that. Worth a one-line confirmation from whoever filed F-137 that "featured card + recommended pill" is in scope for "no highlights."

**N2 — Minor aria-label / visible-text mismatch.** The lead carousel's visible eyebrow reads "Review & drills" (`Today.tsx:601`) while its `aria-label` reads "Review and drills" (`Today.tsx:604` `ariaLabel="Review and drills"`). Cosmetic only (pre-existing convention, not introduced by this diff), but worth aligning since AT users and sighted users should hear/see the same string.

### PRAISE

**P1 — The empty/loading/error discipline is excellent and consistently applied.** `DoneTodayRow` returns `null` (not a 0) while its source is loading (`Today.tsx:292`), matching the codebase-wide "never present unknown as a confirmed zero" convention already used for `loadOpenAttemptMock` (`Today.tsx:187-190`). The explicit test for this (`Today.test.tsx:769-775`) is a genuinely good regression guard.

**P2 — Independent fetch failure isolation is correctly designed and tested.** Five separate `useEndpointOrMock` calls, each keyed independently, with `useEndpointOrMock`'s effect deliberately excluding `realFn`/`mockFn` identity from its dependency array (`useEndpointOrMock.ts:269-273`) — so re-renders never cause fetch thrash, and a plan failure doesn't block the Review & drills carousel (tested at `Today.test.tsx:416-429`).

**P3 — Clean strict-TypeScript, zero `any`.** `tsc --noEmit` (strict mode both `tsconfig.app.json`/`tsconfig.node.json`) is clean, ESLint is clean, and the only occurrences of the string "any" in the touched files are in prose comments or `expect.any(AbortSignal)`.

**P4 — Honest reasoning for why `SubwayProgress` (device #5) is deliberately absent.** The JSDoc (`Today.tsx:13-19`) explains this rather than forcing the device in for checklist compliance — a fabricated denominator would have been worse than omitting the device. This is exactly the right call and the right way to document it.

---

## F-138 date-math verdict (explicit)

**Implementation: CORRECT.** `isLocalToday` converts the ISO instant to the runtime's local timezone via `Date`'s local getters before comparing Y/M/D components — this is the right approach for "what does 'today' mean to the person looking at the screen," not the server's UTC day boundary. Malformed timestamps resolve to `false` rather than throwing (`Number.isNaN(d.getTime())` guard, `Today.tsx:136`), so a corrupt timestamp degrades to "not today" rather than crashing the page. No off-by-one at day boundaries (comparing full Y/M/D triplet, not a subtraction/threshold). Loading/null states resolve to `null` (unknown), never a fabricated `0` (verified by dedicated test).

**Test coverage: INSUFFICIENT — this is the BLOCKER (B1) above.** The suite proves the code produces the right answer for "obviously today" vs. "obviously years ago," but does not — and structurally cannot, given the no-fake-timers convention and UTC CI runners — prove the code is doing local-day comparison rather than UTC-day comparison. Since this was called out as the single riskiest ticket in this batch specifically because of this failure mode, I'm holding the line: this needs a deterministic boundary-case test before I'd sign off on F-138 as proven, even though I believe (from reading the code) that it currently works correctly.

---

## Coordination observations

- **This diff is not actually isolated to Today.\*.** The parent commit (083388d) bundles Today AND Progress together in one commit (`Progress.tsx`/`.css`/`.test.tsx`, plus all the new foundation components and `styles/index.css`/`seoul-devices.css`), per `git diff rebuild --stat`. My review scope was explicitly Today-only per the task brief, so I have not reviewed Progress.tsx's changes at all — flagging this so whoever is coordinating the batch review knows a separate Progress-focused pass is still needed (it wasn't in scope here, not that it's missing).
- The foundation components (`CityCard`, `DancheongRail`, `SealStamp`, `CollapsibleTile`, `SkylineHeader`, `SwipeCarousel`) already have their own review trail (`docs/redesign/REVIEW_components.md`, `REVIEW_design-fidelity.md`, `REVIEW_token-arch.md`, `FIX_REPORT.md`) — I did not re-review them beyond confirming Today.tsx consumes their public contracts correctly (prop shapes, tone enums, aria-expanded semantics all check out against their actual source).
- No stray hard-coded colors, no scope creep into unrelated Today concerns, no dead imports found in Today.tsx — the diff is tightly scoped to what the ticket list asked for.
