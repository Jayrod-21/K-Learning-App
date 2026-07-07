# Review — fix(topik): wall-clock mock-exam timer + a11y (commit 7232e00)

**Branch:** `fix/mock-timer-wallclock` · **Files:** `client/src/pages/topik/MockMode.tsx`, `client/src/pages/topik/MockMode.test.tsx`
**Reviewer:** independent (did not author the change)
**Date:** 2026-07-07

## Verdict: PASS

0 BLOCKER · 1 SHOULD-FIX · 3 NIT · 5 PRAISE

Verification actually run (not taken on faith):

| Check | Result |
|---|---|
| `tsc --noEmit` (docker node:20-slim) | TC=0 |
| `npm run lint` | LINT=0 |
| `vitest run MockMode.test.tsx` | 25/25 pass |
| **Adversarial stash-revert** (old `MockMode.tsx` from `7232e00^` swapped in, new test file kept) | **4/4 new tests fail, 21/21 pre-existing pass** — the regression tests genuinely pin the fix; no old test passes for the wrong reason |

## The three probe questions, answered definitively

**(a) Can the exam still drift or gain extra time in any tab/resume scenario?**
Not unboundedly, in any scenario. `remaining` is always re-derived as `Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000))` (MockMode.tsx:795-797) from a deadline fixed once at mount (:712-718); nothing accumulates, so a throttled/suspended tab lands on the true remaining at its next fire. One **bounded** residue survives (the SHOULD-FIX below): the persistence loop saves the interval-derived `remaining` state, not a fresh deadline sample, so a save fired from a heavily throttled background tab can persist a value up to ~one throttle period (~60 s under Chrome intensive throttling) stale-generous; a subsequent resume inherits at most that. Old code was unbounded (minutes over a 70-min exam); this is the only remaining seam. (Time not counting while the tab is *closed* is F-007's pause-on-resume semantics, by design, out of scope.)

**(b) Can a stray early interval fire auto-submit instantly?**
No, twice over. (1) The deadline-stamping effect (:712) is declared before the interval effect (:790); React runs effects in declaration order, and the first interval fire is a further ~1000 ms out — so `deadlineRef` is always set before any fire. (2) Even a hypothetical pre-stamp fire hits `if (deadlineRef.current === 0) return;` (:794) and performs **no setState** — `remaining` stays at its seeded full-budget value, and the auto-submit effect (:810-815) requires `remaining <= 0`, which that path cannot produce. Auto-submit fires exactly once: `submittedRef` latch inside `doSubmit` (:771-773) shared with manual submit; the existing auto-submit test asserts `toHaveBeenCalledTimes(1)` (test:679).

**(c) Does the mount effect ever re-fire and reset the deadline mid-exam?**
No. Deps are `[initial, test.section]` (:718). `initial` is `initialExam ?? undefined` from the parent (:476); `setInitialExam` is called only in `resumeAttempt` (:253), `startSection` (:288), and `newMock` (:408) — all reachable only from the select/results phases. While the exam runs (`phase === 'exam'`, `net` idle), `initialExam` and `test` are untouched, so both deps are referentially stable. Every `net` transition (submitting/error) *unmounts* `ExamRunner` entirely (the gate at :440) rather than re-rendering it, so there is no remount-with-stale-initial path either; the unmount-time `saveProgress` is correctly no-op'd post-submit by `submittedRef` (:854).

## Findings

### SHOULD-FIX

**S1 — Persistence saves the interval-derived `remaining`, not a fresh deadline sample** — `MockMode.tsx:839-859`
`saveProgress` reads `stateRef.current.remainingSec`, which is only as fresh as the last countdown-interval fire. Foreground that is ≤1 s stale (fine); in a background tab both the 1 s countdown and the 15 s save loop are clamped to the same ~1/min cadence, so a save can persist a remaining up to ~60 s more generous than the wall clock, and a resume inherits it. The commit message's "the 15s F-007 persistence now saves the true value" slightly overstates this. Fix is three lines: in `saveProgress` (a handler/interval context, so the no-`Date.now()`-in-render discipline holds), send
`remainingSec: deadlineRef.current === 0 ? stateRef.current.remainingSec : Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000))`.
Bounded (~1 min worst case vs previously unbounded) and requires background-save-then-kill to matter, hence not a blocker for a single-user app — but it is the one place the throttling this commit targets still leaks through.

### NIT

**N1 — Exact-equality announcement marks can be skipped** — `MockMode.tsx:884-892`
`remaining === 30` and `remaining % 60 === 0` fire only if the derived sequence lands exactly on the mark. A late fire (>1 s gap: GC pause, throttle recovery) skips integers and silently drops the cue — e.g. refocusing a backgrounded tab can jump 600 → 58 past every mark. Crossing-detection (compare against the previous `remaining`) would be robust. Low impact: an SR user in the exam keeps the tab focused, where fires are ~1 s apart.

**N2 — "Time is up. Submitting your test." may never be spoken** — `MockMode.tsx:885` + parent gate `:440`
The same `remaining → 0` render that produces the announcement also triggers `doSubmit` → parent sets `net='submitting'` → `ExamRunner` (and its live region) unmounts within milliseconds. Removing a live region can cancel a queued polite announcement in some AT. The `role="status"` "Grading your test…" node (:427) that replaces it largely covers the gap, so this is cosmetic.

**N3 — Comment says "once, on mount" but the effect has re-fireable deps** — `MockMode.tsx:707-718`
Correct today (see (c) above), but a future parent change that re-creates `initial` per render would silently re-arm the deadline and hand out a fresh budget. A literal one-shot guard (`if (deadlineRef.current !== 0) return;`) would make the comment true by construction. Purely defensive.

### PRAISE

**P1** — The throttled-tab test (test:286-322) is exactly the right instrument: it fakes *only* the interval and spies `Date.now` independently, so it asserts the deadline derivation itself, not fake-timer lockstep. Reproduced failing on the old code (shows `1:09:59`, expects `1:00:00`).

**P2** — The F-007 resume test (test:324-371) discriminates all three failure modes at once (tick counter → `09:59`, full-budget deadline → `1:05:00`, correct → `05:00`) with anchored `/^05:00$/` regexes that a substring match couldn't fudge.

**P3** — The commit's stash-revert claim is honest: independently reproduced, 4/4 new tests fail on `7232e00^`, zero pre-existing tests needed weakening. The one updated old test ("auto-submits at 0", test:641-684) still passes on both codebases *for the right reason* — full fake timers move `Date` in lockstep, so it now exercises the deadline path end to end, including exactly-once submission.

**P4** — React-19 discipline held under audit: every `Date.now()` call site is in an effect (:713), the interval callback (:796), or handler-invoked callbacks (:724, :761); render reads only `remaining` state. The `timerAnnouncement` `useMemo` (:884) sits above the `current === undefined` early return (:894), so hook order is unconditional.

**P5** — The a11y split (visible `role="timer"` at `aria-live="off"` :930 + separate `km-sr-only` polite region :936, class verified present at `client/src/styles/index.css:1759`) is the textbook fix for live-region timer flood, and the empty-string-between-marks design means nothing is enqueued off-mark.

## Scope notes (accepted, not findings)

- A system-clock change (NTP jump, manual adjustment) mid-exam shifts the derived remaining — inherent to any wall-clock deadline and the correct trade-off against throttle immunity; `performance.now()` would not survive tab suspension.
- A resumed attempt saved with `remainingSec === 0` seeds `remaining = 0` and auto-submits on mount — correct behavior (time was already up).
