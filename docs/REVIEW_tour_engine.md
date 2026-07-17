# REVIEW — Tour engine + persistence (feat/tutorial-tour)

Reviewer scope: `client/src/lib/tours.ts` + `tours.test.ts`, `client/src/lib/tourDriver.ts`,
`client/src/hooks/TourProvider.tsx` + `TourProvider.test.tsx` + `tour-context.ts` + `useTour.ts`,
`server/src/routes/settings.ts` + `server/tests/routes/settings.test.ts`,
`client/src/services/settings.ts` + `settings.test.ts`, `client/src/types/domain.ts`,
`docs/BUILD_tutorial_tour.md`. All read in full at worktree
`/home/jared-williams/projects/9b. Korean Master/.claude/worktrees/tutorial-tour`.

## Summary verdict

**PASS with reservations — 0 BLOCKER, 4 SHOULD-FIX, 6 NIT.**

Engine + persistence are senior-grade: trigger logic correct + genuinely tested
(held-promise hydration test, mocked-runner contract tests), persistence is real
two-tier with a coalesced read-merge-write sync, server schema addition preserves
`.strict()` + legacy-blob safety, ids closed client-side / bounded opaque server-side.
Two substantive gaps: (S1) the missing-anchor "don't burn the one-shot" guard is
**vacuous for all 11 shipped tours** — every tour has ≥1 un-anchored step, so a
half-loaded page still runs a degraded tour and marks it seen; (S2) `tourDriver.ts`
(the DOM-filtering / unavailable / single-fire-latch logic) has **zero direct tests** —
provider tests mock it wholesale.

Test runs (this review): client vitest — `tours.test.ts` 10, `TourProvider.test.tsx` 17,
`services/settings.test.ts` 7 → **34/34 passed** (3 files, 740ms). Server
`settings.test.ts` verified by reading (testcontainer, not run here): 43 `it` cases
counted, matches the orchestrator gate's "43 passed".

## Bar checklist

| Bar item | Verdict | Evidence |
|---|---|---|
| First-run fires once when unseen | PASS | TourProvider.tsx:274-291 (effect: unseen `first-run` wins); TourProvider.test.tsx:144-167 |
| Per-surface fires on first visit, once | PASS | tours.ts:398-413 + TourProvider.test.tsx:207-231 |
| Seen tour never re-fires (persisted) | PASS | markSeen → localStorage sync write (TourProvider.tsx:147-158, tour-context.ts:68-78); tests :217-224, :281-293 |
| Auto-fire waits for prefs hydration (no flash) | PASS | `if (!hydrated) return` (TourProvider.tsx:275); hydration settles on success OR failure (:198-199); proven by held-promise test TourProvider.test.tsx:170-190 |
| Suppressed while mock exam active | PASS | TourProvider.tsx:277; test :199-203 |
| Missing-anchor → unavailable, NOT marked seen, retries | **PARTIAL** | Engine contract implemented (tourDriver.ts:86-88; TourProvider.tsx:224-226) + provider-level test :352-364 — but unreachable for every shipped tour (see S1) |
| Two-tier persistence (localStorage + server prefs) | PASS | tour-context.ts:50-78; TourProvider.tsx:106-158 |
| Server sync is read-merge-write, no palette/textSize clobber | PASS w/ residual race | Fresh GET → union → full-blob PUT (TourProvider.tsx:119-132); PUT-shape test asserts palette/textSize/languageDisplay untouched (TourProvider.test.tsx:253-258). Residual GET→PUT window — see S3 |
| PrefsSchema stays `.strict()` | PASS | settings.ts:214-221, :229-231; unknown-sibling-key 400 test settings.test.ts:590-595 |
| `toursSeen` `.catch([])` fresh-user default | PASS | settings.ts:127-131; fresh-user default test :133-138, corrupt-stored coerce test :544-554 |
| Legacy blob w/o field → default, NO wipe of palette/textSize | PASS | `.default([])` + tests settings.test.ts:530-542 (and :376-395) |
| Tour ids a CLOSED union, not user input | PASS | tours.ts:52-63; server stores opaque bounded strings ≤64ch ×≤200 (settings.ts:127-131, rationale :108-126); Settings narrows DOM select via `isTourId` before use (Settings.tsx:2532) |
| a11y: reduced-motion, Esc/overlay dismiss, keyboard nav | PASS | `animate: !prefersReducedMotion()` (tourDriver.ts:48-53, 93); `allowClose: true` (:94); keyboard next/prev/Esc = driver.js default (`allowKeyboardControl` defaults on — not pinned, N6) |
| `toursSeen` bounded | PASS | Server caps 200 ids × 64 chars; client only ever adopts server-provided unknown ids (bounded by that cap); localStorage mirrors the same set |
| Tests exercise real behavior | MOSTLY | Provider + route tests are real-behavior (fires/doesn't, persist shape, hydration-wait, poisoned DB column); gap = tourDriver.ts untested (S2) |

## Findings by category

**BLOCKER** — none.

**SHOULD-FIX**
- S1. Missing-anchor guard is dead code for all 11 shipped tours — half-loaded page still burns the one-shot.
- S2. `tourDriver.ts` has no tests at all — the actual missing-target filter, zero-step `unavailable`, and `onFinished` single-fire latch are only exercised in production.
- S3. Read-merge-write still has a GET→PUT clobber window (no version gate); "never clobbered" claim in comments/doc is overstated. Realistic collision: Settings' debounced accent PUT racing "Skip all tours" from the same screen.
- S4. `.catch([])` on the PUT path silently wipes the user's server-side `toursSeen` to `[]` (HTTP 200) on any malformed value — one bad element discards the whole list.

**NIT**
- N1. BUILD doc wrong twice: claims "oversized array rejected on PUT" (it's coerced to `[]`, 200 — proven at settings.test.ts:565-588) and names the Settings component `TourControls` (actual: `ToursSection`, Settings.tsx:2479).
- N2. `km.toursSeen` localStorage is not user-scoped: on a shared browser, user B inherits A's marks, and B's next `markSeen` sync PUTs A's ids into B's server prefs. Consistent with the `km.textSize` posture; acceptable for the personal-app scope, but note it.
- N3. Rolling-deploy write path: NEW client + OLD server → every PUT carrying `toursSeen` 400s against the old `.strict()` schema (comments in services/settings.ts:70-81 only cover the GET direction). Same transient as every prior field addition.
- N4. Back-to-back sequences: finishing first-run on a surface route immediately chains that surface's tour 600ms later (markSeen → `seen` dep change → effect refires, TourProvider.tsx:274-291). Two popover sequences in a row on e.g. a first visit landing on `/learn/hanja`. Possibly intended; not covered by a test (test :227-231 only asserts index 0).
- N5. `START_DELAY_MS = 600` (TourProvider.tsx:79) is a fixed heuristic, unrelated to actual data settle — the direct cause of S1's exposure on slow loads.
- N6. driver.js keyboard nav relies on the library default (`allowKeyboardControl` not pinned in the Config at tourDriver.ts:91-112); pinning it would make the a11y contract explicit and upgrade-proof.

**PRAISE**
- P1. The held-promise hydration test (TourProvider.test.tsx:170-190) genuinely proves the no-pre-hydration-flash property — advances well past the paint-settle delay while the fetch is pending, then resolves with a seen mark and asserts silence. Exactly the non-tautological test the bar asks for.
- P2. PUT-shape assertion (TourProvider.test.tsx:253-258) pins the read-merge-write contract: `toursSeen` merged, palette/textSize/languageDisplay byte-identical to the fresh GET.
- P3. Server tests poison the JSONB column directly with real Postgres (settings.test.ts:148-171, :544-554) — no mocked API schema, exactly the real-corpus-data discipline.
- P4. Coalesced sync (TourProvider.tsx:107-145): single in-flight + one pending re-run + `setsEqual` short-circuit — no PUT storms, converges in ≤2 rounds, second round no-ops via the equality check.
- P5. Settings sources `toursSeen` live from `loadSeenTours()` at PUT-compose time (Settings.tsx:715-730, :916-922) — the two-writer clobber defense actually holds in the Settings→TourProvider direction.
- P6. tour-context.ts:16-19 deliberately preserves unknown persisted ids (rollback safety) while decision logic uses only known ids — a subtle forward-compat call, correctly made.
- P7. `parseStoredPrefs` strips a malformed legacy `notif` BEFORE validation (settings.ts:313-323) so dead data can't wipe live prefs — and it's tested (:160-171).

## Detailed findings

### S1 — Missing-anchor guard vacuous for every shipped tour (burns the one-shot on a half-loaded page)

`tourDriver.ts:64-88`: anchored steps whose selector misses are dropped; `'unavailable'`
is returned only when **zero steps of any kind** survive. Un-anchored steps (no `target`)
always survive. Every one of the 11 tours in `tours.ts:68-370` contains at least one
un-anchored step (e.g. `hanja` step 1 at tours.ts:277-280, `reading` step 1 at :307-310,
first-run steps 1 and 9). Therefore `steps.length === 0` is unreachable in the shipped
registry, and the TourProvider guard at TourProvider.tsx:224-226 ("deliberately NOT
marked seen — retries") never executes in practice.

Consequence: on a slow load or empty state, the tour fires at the fixed 600ms delay
(TourProvider.tsx:79, :285-287) with only its connective copy — e.g. `reading` runs as a
single centered popover if `[data-tour="reading-shelf"]` (Reading.tsx:408, data-dependent)
hasn't rendered — the user clicks Done, `markSeen` fires (TourProvider.tsx:212-218), and
the anchored coach marks are never shown and never retried. That is exactly the
"burning its shot on a half-loaded page" the bar excludes. The trade-off is acknowledged
in the tourDriver header (:7-13, "the un-anchored connective copy usually still runs"),
so this is a conscious design call, not an oversight — hence SHOULD-FIX, not BLOCKER —
but it fails the stated bar as written for real registry content.

Fix is small: compute availability over **anchored** steps only — if the tour has ≥1
anchored step and none resolve, return `'unavailable'` (empty-state pages then retry
silently instead of running degraded). Partial resolution (some anchors present) can
reasonably still run.

### S2 — tourDriver.ts entirely untested

There is no `tourDriver.test.ts`. `TourProvider.test.tsx:36-41` mocks the whole module,
and the "missing target" spec (:351-364) tests only the provider's *reaction* to a mocked
`{ status: 'unavailable' }`. Untested production logic: the `document.querySelector`
filter (tourDriver.ts:66-79), the zero-step unavailable branch (:86-88), the `finished`
latch guaranteeing single-fire `onFinished` under destroy-races (:90, :105-111), the
reduced-motion flag (:48-53, :93), and the step→DriveStep mapping (side passthrough,
centered popover for target-less steps). All of it is jsdom-testable with driver.js
mocked at the import boundary. Given S1 lives exactly in this file, it is the
highest-value test to add.

### S3 — Residual clobber window in the read-merge-write sync

TourProvider.tsx:119-132: sync GETs fresh prefs, unions `toursSeen`, PUTs the full blob.
The server route is explicit last-writer-wins with no version gate (settings.ts:390-397).
Any prefs write landing between the sync's GET and its PUT is silently reverted — the PUT
carries the GET-time palette/textSize. Concrete same-screen sequence: user changes accent
in Settings (debounced PUT scheduled) → clicks "Skip all tours" → `markAllSeen` sync GET
returns the old accent → Settings' PUT lands (new accent) → sync PUT lands (old accent +
merged tours) → accent reverted server-side (local `data-accent` still new; drifts on the
next device). Low probability (~one RTT window) and self-healing on the next Settings PUT,
but the comments (TourProvider.tsx:32-36: "is never clobbered") and
BUILD_tutorial_tour.md:68-70 overstate the guarantee. Either document the residual window
honestly, or route both writers through one serialized queue / add a version gate.

### S4 — PUT-side `.catch([])` silently destroys the stored seen-list

settings.ts:127-131: `ToursSeenSchema` = `z.array(z.string().min(1).max(64)).max(200).default([]).catch([])`.
On PUT, one malformed element (a 65-char id, a number) coerces the **entire array** to
`[]` with a 200 — proven at settings.test.ts:565-588. Unlike the accent/textSize
precedent (scalar preference coerces to a default *value*), this catch discards
accumulated user *data*. The route's own posture elsewhere is "reject a tampered value
as a 400" (settings.ts:37-42, languageDisplay :193-197). Mitigations that keep this out
of BLOCKER territory: the only writers union-merge before PUT, ids come from the closed
client registry, and localStorage re-seeds the server on the next markSeen sync. Still,
splitting the schema — strict-400 on the PUT body, `.catch([])` only on the stored-read
path (which `parseStoredPrefs` already separates) — would keep both safety properties
without the silent-wipe semantics.

### Verification notes

- Double-fire probes: `runTour` re-entry guard (TourProvider.tsx:210), `activeTourId`
  effect gate (:276), timer cleanup on dep change (:288-290), `markSeen` idempotence with
  synchronous `seenRef` update (:149-152), and the driver-side `finished` latch
  (tourDriver.ts:105-111) — no path found where one tour fires twice or two run at once.
- Route-change teardown (:294-301) destroys via the same single-fire funnel — abandoned
  tour = seen, by design; replay-navigate can't be killed by it (handle not yet set
  during the 600ms replay timer, :245-264).
- Boot hydration: abort-guarded, settles `hydrated` on success and failure but not on
  abort (:177-205) — correct on unmount.
- `surfaceTourForPath` exact-beats-prefix and the trailing-slash prefix rule
  (tours.ts:398-413) verified against the registry test (tours.test.ts:78-106).
- Server test count independently tallied from the file: 2 (auth) + 4 (GET) + 8 (F-093)
  + 4 (PUT) + 4 (accent) + 9 (languageDisplay, incl. 3 `it.each`) + 4 (textSize)
  + 6 (toursSeen) + 2 (isolation) = **43**, matching the orchestrator gate.
