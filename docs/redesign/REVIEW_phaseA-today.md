# Review

**Ticket:** F-173 — resumed-TOPIK "X of N" progress on Today
**Branch:** `feat/beta-phaseA-partials` @ 2c0c805 (base `rebuild`)
**Files in scope:** `client/src/pages/Today.tsx`, `client/src/pages/Today.css`, `client/src/pages/Today.test.tsx`

## Summary verdict

**PASS WITH CONDITIONS**

The wiring is correct, the tests are real (not tautologies), and the `steps`/`current` mapping matches the exact precedent already established by `Hanja.tsx`'s F-170 draw-drill bar (`current={masteredCount}`, `steps={totalInSession}`). No fabricated data is introduced anywhere in the normal path: `totalItems` really does come from the server's `resolveServedTotal` re-derivation, and the client-side `?? answered` fallback mirrors the server's own documented fallback contract. Nothing in this diff is a hard blocker on its own — the one significant issue (below) is a pre-existing gap in the *backend's* wire contract (the client can't tell "genuinely complete" from "unknown total, lower bound only") that this diff is the first to surface visibly to a user, and it should be fixed before or shortly after this ships, not silently left.

- **BLOCKERS: 0**
- **SHOULD-FIX: 2**
- **NIT: 2**
- **PRAISE: 3**

## Findings

### BLOCKER
None.

### SHOULD-FIX

1. **The no-total fallback renders "N of N answered," which reads as complete, sitting directly next to a "Resume exam" CTA that says the opposite.** (`Today.tsx:643`, `1040`, `1044-1045`) — Real bug risk, not fabrication, but a genuine honesty gap once `totalItems` is absent/unresolvable. See detailed findings below.
2. **The `AttemptState` wire contract collapses two different situations into one number** — "the exam truly has exactly N items" and "we don't know the total, here's a lower bound" both render as `totalItems === answered`. The client has no way to disambiguate them, so it cannot render honestly in the second case without guessing. See detailed findings below.

### NIT

1. **Double-locked-in edge case: `answered === 0` and no resolvable total.** `resumeTotalItems` becomes `0`, and `SubwayProgress` internally clamps `steps` to `1` (`Math.max(1, Math.floor(steps))`), but the `valueText`/readout strings in `Today.tsx` are built from the un-clamped `resumeTotalItems = 0`, so `aria-valuemax` (from the component) and the spoken/visible "0 of 0 answered" text would disagree if this combination ever occurs. Extremely rare in practice (requires a fresh, zero-answered attempt *and* a since-deleted corpus paper simultaneously) — flagging for completeness, not requesting a fix.
2. **`aria-valuenow` (13) vs. `aria-valuetext` ("12 of 20 answered")** use different counting conventions (1-indexed "current station" vs. plain "answered count"). This is inherited from `SubwayProgress`'s existing contract and matches the Hanja.tsx precedent exactly, so it's not a regression — just noting for anyone auditing AT output who expects the raw number to match the spoken text 1:1.

### PRAISE

1. **Test fixture discipline.** `ATTEMPT.totalItems = 20` vs. `answered = 12` (`Today.test.tsx:197`) is a deliberately-adversarial fixture — a test asserting "12 of 20" genuinely could not pass against a regressed `steps={answered}` or a hardcoded ratio. This is exactly the kind of fixture that catches copy-paste bugs the "PRAISE" category exists for.
2. **`current={answered}` matches established precedent exactly**, down to variable-naming intent (`Hanja.tsx:2702-2707`'s `current={masteredCount}`/`steps={totalInSession}`). No new convention was invented; this reduces review risk and keeps the codebase consistent.
3. **The doc comments are unusually honest about the fallback's limits** (`Today.tsx:96-107`, `topik.ts:940-947`) — "a real lower bound, never a guess above what is actually known" is accurate language for what the code does. The gap flagged in SHOULD-FIX #1/#2 is a rendering consequence of an already-documented tradeoff, not a case of the comments overselling the code.

## Detailed findings

### SHOULD-FIX #1 — the no-total fallback visually reads as "exam complete"

`Today.tsx:643`:
```ts
const resumeTotalItems = openAttempt?.totalItems ?? openAttempt?.answered ?? 0;
```

Traced the full path: `GET /topik/attempt` (`server/src/routes/topik.ts:951-964`, **not part of this diff** — already shipped) computes `totalItems: served?.totalItems ?? answered`, where `served` comes from `resolveServedTotal` (`topik.ts:1134-1160`). That helper returns `null` only when the backing corpus paper for the attempt's `(section, sourceTest)` has since been deleted — an already-accepted degraded-state pattern in this codebase (the sibling `GET /topik/attempts` history endpoint has carried the identical `topikLevel: null` / `totalItems` fallback for the same reason before this branch existed). So in the ordinary case, `totalItems` is a real, freshly re-resolved item count, and the client fallback in `Today.tsx:643` is closing a narrower gap: pre-F-173 cached/fixture data or (redundantly) the same corpus-gone case the server already handles.

The problem is what actually renders when the fallback fires (confirmed via `Today.test.tsx:1194-1210`, the `ATTEMPT_NO_TOTAL` case, and by running the suite):
- Resume banner aria-label: `"Resume exam — Reading mock, 7 of 7 answered"` (`Today.tsx:649`)
- Bilingual readout: `"7 of 7 answered"` (`Today.tsx:1044`)
- `SubwayProgress`: `steps=7`, `current=7` → internal clamp `active = min(max(0,7), 6) = 6`, fill bar renders at 100% width (`fillPct = active/(total-1)*100 = 100`), with only the last dot rendered in the "current" (ringed) rather than "done" (filled) visual state.

To a sighted user, this is a fill bar at 100% and text reading "7 of 7 answered," directly beside a button whose own label starts with "Resume exam." A user who has genuinely answered 7 of an exam whose real (unknown) total is, say, 20 sees a progress readout that says they're done, contradicting the CTA next to it. This is exactly the "renders as complete when it's actually resumable mid-way" scenario named in the review brief.

**Severity assessment:** I'm not calling this a BLOCKER because (a) it only fires in an already-existing rare backend degraded state that this PR did not introduce and does not worsen, (b) the actual resume mechanics (`currentIdx`, `picks`) are unaffected — a user who clicks through still lands back in the exam at the correct position and can keep answering past the "7th" question despite what the readout implied, and (c) net-net, real-world executions of this code are almost always improved by this change (a genuine "12 of 20" is far more informative than the pre-existing bare "12 answered"). But it is a real, user-visible honesty regression *in the fallback branch specifically*, and it should be fixed before this ships broadly rather than filed away. Suggested fix: when the server can't resolve a true total, don't render the "of N" phrasing at all — fall back to the pre-F-173 "N answered" wording (which is what this exact code used before this diff, per the removed line at `Today.tsx` old aria-label: `"... mock, ${answered} answered"`), or render an explicit "12+ answered" / indeterminate-bar treatment.

### SHOULD-FIX #2 — the wire contract can't express "unknown total" distinctly from "true total"

This is the root cause of #1. `AttemptState.totalItems` (`client/src/services/topik.ts:167-190`) is typed `number | undefined`, but "undefined" only covers the pre-F-173-fixture case — the far more likely real-world trigger (server-side `resolveServedTotal` returning `null`) is *already* collapsed into a plain `number` equal to `answered` before it ever reaches the client. The client-side `?? answered` in `Today.tsx:643` can therefore never distinguish "the server told me the true total is N" from "the server gave up and echoed back what it already knew." Once collapsed, no amount of client-side care can recover the distinction. If this is worth fixing, it has to happen server-side (e.g. a `totalItemsExact: boolean` alongside `totalItems`), which is out of scope for a client-only diff — noting it here since it's the structural reason SHOULD-FIX #1 exists and isn't fixable purely in `Today.tsx`.

### Wiring correctness — confirmed correct

- `steps={resumeTotalItems}`, `current={openAttempt.answered}` (`Today.tsx:1036-1037`) — verified against `SubwayProgress`'s documented contract (`SubwayProgress.tsx:27-30`: `current` is "0-indexed active station, clamped into `[0, steps-1]`"). Since `answered` counts completed items, using it directly as the 0-indexed "current" station means station `answered` (the next unanswered item) is marked "current" and stations `0..answered-1` are marked "done" — this is the exact correct semantic for "you've finished items 1..N, you're now on item N+1." Verified this matches the only other live usage of the identical pattern, `Hanja.tsx:2702-2707`'s draw-drill bar (`current={masteredCount}`).
- Ran the actual test suite (`npx vitest run src/pages/Today.test.tsx`): **53/53 pass.** Ran `tsc --noEmit`: clean, no errors touching `Today.tsx`.
- `aria-label` enrichment (`Today.tsx:649`) is additive to the pre-existing string — the "Resume exam — {section} mock, {answered}" prefix and the deep-link behavior (`?mode=mock`, verified unchanged at `Today.test.tsx:1169-1180`) are untouched. The click handler and route target were not touched by this diff.
- `role="progressbar"` + `aria-valuemin`/`aria-valuemax`/`aria-valuenow`/`aria-valuetext` are all supplied by `SubwayProgress` itself and were not modified by this diff — `Today.tsx` only supplies `label` and `valueText`, both real strings built from real numbers, never hardcoded.
- `tone={SKILL_COLOR.topik.tone}` resolves to `'stone'` (`client/src/lib/skill-colors.ts:94`), a valid `DancheongRailTone` member (`DancheongRail.tsx:33-42`) with a real CSS binding at `client/src/styles/seoul-devices.css:194` (`--km-tone: var(--stone)`) — the bar will actually render in the intended color, not silently fall through to unstyled.
- CSS (`Today.css:224-238`): `.km-today__resumeProgress` deliberately mirrors `.km-today__tileProgress`'s spacing rhythm (`margin-top`/`padding-top`/`border-top`, `Today.css:215-222`) per its own header comment, and is scoped as its own class rather than overloading `ActivityTile`'s `extra` slot — reasonable, non-hacky choice given the tile it's attached to (the TOPIK `SwipeCarousel` card) isn't `ActivityTile`-shaped at that slot.

### Tests — assessed for real vs. tautological

- `Today.test.tsx:1191-1210` (`ATTEMPT` fixture, 12/20): asserts `aria-valuemin="1"`, `aria-valuemax="20"`, `aria-valuenow="13"`, `aria-valuetext="12 of 20 answered"`, and the paired visible text "12 of 20 answered." Given the fixture sets `totalItems: 20` and `answered: 12` (deliberately non-equal, per the `Today.test.tsx:186-190` fixture comment), this test would genuinely fail if `steps` were wired to `answered` instead of `totalItems`, or if the readout used a hardcoded/derived-elsewhere number. Confirmed real.
- `Today.test.tsx:1212-1227` (`ATTEMPT_NO_TOTAL`, 7/7): asserts the aria-label reads "7 of 7 answered" and `aria-valuemax="7"`. This test does prove the fallback-to-`answered` mechanism fires and doesn't fabricate a number *above* `answered` — that part is genuinely verified. It does **not** (and structurally cannot) prove the fallback is non-misleading in the "N of N reads as complete" sense raised in SHOULD-FIX #1; that's a UX/product judgment call no assertion on numeric props can settle.
- `Today.test.tsx:1229-1236` (no attempt): asserts the progressbar is absent via `queryByRole` when `attempt` resolves to `null` — correctly exercises the `openAttempt !== null` guard through the real hook-mock path (`loadDefaults()` sets `hoisted.attempt.state = { kind: 'data', data: null }`), not a shortcut around the component.

### Deep-link / existing-behavior regression check

`Today.test.tsx:1169-1180` (unchanged from before this diff except for the updated aria-label string) still asserts the resume banner click navigates and the resulting URL carries `?mode=mock`. No regression found in the routing/deep-link surface.
