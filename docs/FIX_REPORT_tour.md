# FIX REPORT — Guided tutorial tour (fix-pass over REVIEW_tour_engine.md + REVIEW_tour_integration.md)

Fix-pass agent, independent of the original builder and both reviewers.
Scope: the 6 SHOULD-FIX findings (S1–S4 from the engine review; SF-1/SF-2 from
the integration review). 0 blockers existed; all PRAISE properties preserved
(see the self-assessment).

| Finding | Disposition | Where |
|---|---|---|
| S1 — missing-anchor guard vacuous (every tour has an un-anchored step, so `unavailable` was unreachable and a half-loaded page burned the one-shot) | **FIXED** | `client/src/lib/tourDriver.ts` + tests |
| S2 — `tourDriver.ts` had zero direct tests | **FIXED** | `client/src/lib/tourDriver.test.ts` (new, 13 tests) |
| S3 — GET→PUT clobber window in the read-merge-write prefs sync | **FIXED** (server-side field-scoped merge — the "prefer it" branch) | `server/src/routes/settings.ts`, `client/src/services/settings.ts`, `client/src/hooks/TourProvider.tsx` + tests |
| S4 — PUT-side `.catch([])` wiped the whole stored seen-list on one malformed element | **FIXED** | `server/src/routes/settings.ts` (`ToursSeenSchema`) + tests |
| SF-1 — `data-tour="chat-fab"` duplicated (Sidebar chat link + floating ChatFab), first-run "dot" step resolved to the sidebar row on desktop | **FIXED** | `client/src/components/Sidebar.tsx`, `client/src/lib/tours.ts` + tests |
| SF-2 — Settings "Help & tours" UI untested (renders null in the provider-free suite) | **FIXED** | `client/src/pages/Settings.test.tsx` (new describe, 4 tests, real `TourProvider`) |

## S1 — availability threshold (decision + rationale)

**Threshold chosen: a tour that DEFINES anchored steps must resolve AT LEAST
ONE of them, or `startTour` returns `'unavailable'`.** Modal-only tours (no
anchored steps in the definition) stay always-available. The zero-total-steps
degenerate case still reports `unavailable` too.

Why "≥1 anchored resolves" rather than "the first anchored step" or "all":

- *First-step*: brittle to step reordering, and arbitrarily blocks a tour
  whose first anchor happens to be the one data-dependent element while the
  rest of the page is fully rendered.
- *All*: would defer a tour forever on legitimately partial pages (e.g. the
  Writing tour when the AI-prompt card is still loading but the task-type
  radiogroup is up) — the degraded case the bar targets is the fully
  anchorless one, where the user gets *only* connective copy and the mark is
  burned with nothing shown.
- *≥1*: the fully-anchorless (half-loaded / empty-state) page now retries
  silently on a later visit and is never marked seen; a partially resolved
  page still delivers most of the tour's value, and burning the mark there is
  a reasonable trade (the engine reviewer's own suggested fix).

Documented in the `tourDriver.ts` header and at the check site; the registry
header (`tours.ts`) and the `TourProvider` header were updated to match.

Tests proving the bar's sentence exactly:
- Engine half (`tourDriver.test.ts`): a tour whose anchors are all absent →
  `unavailable`, driver never constructed, `onFinished` never fires; the SAME
  tour starts once its anchor is in the DOM; partial resolution still runs;
  modal-only tours always run.
- Provider half (`TourProvider.test.tsx`): an `unavailable` tour is not
  marked seen and no PATCH is issued; on a later visit (fresh mount) with the
  anchor present it fires again and only THEN persists.

## S2 — tourDriver direct tests

New `client/src/lib/tourDriver.test.ts` mocks **driver.js at the import
boundary** (not `tourDriver` itself), so the production filter/threshold/
latch/config logic runs against a real happy-dom DOM. Covered: the
missing-target filter (dropped absent anchors, element/side passthrough,
centered popovers for target-less steps), the `unavailable` paths (S1),
reduced-motion → `animate: false` (and the animate-by-default inverse),
`allowClose` + `disableActiveInteraction` pinned, and the `finished` latch —
`onDestroyed` → `onFinished` exactly once for finish, skip/Esc, a
double-destroy race, and a caller `handle.destroy()` whose pipeline echoes
back into `onDestroyed`.

## S3 — approach chosen: field-scoped server-side merge (PATCH), not a narrower window

The task allowed either minimizing the GET→PUT window or preferring a cheap
server-side merge / PATCH-of-just-toursSeen. The client-side window was
already minimal (the sync re-fetched immediately before the PUT; only a merge
computation sat between), so "narrowing" had nothing real left to narrow —
the exposure was structural to carrying the full blob. Since S4 already
required touching the server route and running the server gates, the marginal
cost of doing it right was small:

- **New `PATCH /settings/prefs/tours-seen`** (`server/src/routes/settings.ts`):
  validates `{ toursSeen }` (strict, same per-element-filtered schema as S4),
  union-merges with the stored list, and writes with
  `jsonb_set(preferences, '{toursSeen}', …)` — the update touches ONLY that
  key of the column's value *at write time*, so a palette/languageDisplay/
  textSize write landing at any point around the sync can no longer be
  reverted. The reviewers' concrete scenario (debounced accent PUT racing
  "Skip all tours") is eliminated as a class, not shrunk.
  - Empty `{}`/corrupt blob: the route writes a full defaults+marks blob
    instead (a `jsonb_set` on `{}` would persist a palette-less blob the
    GET-side parse rejects — marks would be stored but never served). Tested.
  - Union cap at 200 keeps a crafted stored∪body union from tripping the
    GET-side anti-bloat catch.
  - Union-merge means the endpoint is monotonic (cannot shrink the list) —
    "unsee" does not exist in the product (replay ignores seen state).
- **Client sync** (`TourProvider.syncSeenToServer`) now sends one PATCH with
  the local set and adopts server-known ids from the echo; the boot-time GET
  hydration is unchanged. The coalescing (single in-flight + one pending
  re-run) is untouched. No rolling-deploy fallback to the old GET+PUT path:
  the only server generation lacking the PATCH also rejects `toursSeen` on
  PUT (`.strict()`), so a fallback could never have succeeded either — the
  existing behavior (warn, keep localStorage, retry on next mark/boot) covers
  that transient identically.
- **Residual, documented** (route + provider headers): concurrent writers of
  `toursSeen` *itself* (full PUT racing a PATCH, or two tabs marking
  different tours) still resolve last-writer-wins on that one field; each
  device re-unions from localStorage on its next sync, so the set converges
  upward. A version gate/CAS was deliberately not added — the route's
  last-writer-wins posture is a locked decision, and the remaining exposure
  is a transient, self-healing, single-field drift for the same user.

The comments the engine review called overstated ("is never clobbered") were
replaced with the accurate structural claim + residual note.

## S4 — per-element tolerance

`ToursSeenSchema` now filters elements individually (a `z.preprocess` that
drops any element failing the `min(1).max(64)` string bound) before the
array-level bounds. One malformed element no longer discards accumulated user
data — on the PUT body, the PATCH body, AND the stored-read path (a
hand-corrupted column keeps its valid marks on GET now too). The array-level
`.catch([])` is retained ONLY for array-level failures: a non-array value or
a >200-element list (anti-bloat guard, unreachable from the closed 11-id
client registry) — the wipe radius was never widened. All pre-existing
malformed-input tests pass unchanged (their expected results are identical;
only the mechanism differs); new tests pin mixed valid/garbage arrays on PUT
(valid ids persist to the column), on PATCH, and in a poisoned stored blob on
GET.

## SF-1 — unique chat anchor

The floating `ChatFab` is mounted in BOTH chromes (it has no desktop hide),
so the correct fix was to make the FAB the single owner of `chat-fab`: the
step's "This dot…" copy then matches the resolved element in *both* layouts,
with no per-layout step scoping needed. The Sidebar's chat entry got its own
`chat-nav` key (kept as an inert, stable hook for any future rail-specific
step; no step targets it today). The misleading "two chromes are mutually
exclusive" comment now scopes that claim to the `tab-*` keys and names the
ChatFab exception explicitly; the first-run step carries the same note.
Tests (`Sidebar.test.tsx`): the rail entry carries `chat-nav` and never
`chat-fab`; rendering Sidebar + ChatFab together (the desktop coexistence the
review flagged) resolves `[data-tour="chat-fab"]` to exactly ONE element, and
it is the `.km-chatfab` dot.

## SF-2 — Settings "Help & tours" under a real provider

New describe in `Settings.test.tsx` mounting Settings inside a **real
`TourProvider`** (driver runner and settings service mocked at their module
boundaries — same seams as `TourProvider.test.tsx`), so the section renders
and the wiring is exercised end-to-end: section + controls render (Replay
disabled until a pick); picking Hanja and clicking Replay **re-arms and runs
the already-seen tour** (navigate → paint-settle → `startTour('hanja')`);
"Replay the welcome tour" re-runs first-run; "Skip all tours" marks every
registered id seen, persists to BOTH tiers (localStorage asserted verbatim;
exactly one field-scoped PATCH with the full sorted id set; **no** full-blob
PUT), disables itself with the "All tours are off" label, and no tour ever
auto-fires. Note on wording: "re-arms" is implemented as *replay runs the
tour regardless of its seen mark* — the design intentionally never clears
seen ids (there is no "unsee"; the mark stays so auto-fire stays quiet), so
the test pins the actual contract.

## NITs fixed opportunistically (files already in scope)

- Stale comments contradicting S1/S3 semantics in `TourProvider.tsx`,
  `tours.ts`, `tourDriver.ts` headers (part of the fixes above).
- The engine review's N1/N2/N3/N4/N5/N6 and integration N-1…N-4 were left
  alone — none lives in a line these fixes touched, and several (N4 chaining,
  N5 delay heuristic, N-3 copy tuning) are product decisions not suited to an
  unasked drive-by.

## PRAISE preservation (self-assessment)

- **Hydration-wait no-flash trigger** — untouched; the held-promise test
  passes unchanged; Shell's inert-provider harness extended only by a
  `patchToursSeen` never-settling stub (same posture as the existing stubs).
- **Exam suppression** — untouched, test unchanged.
- **Sound test-harness fixes (Shell suites)** — only the mock factory gained
  the extra stub; every assertion body untouched.
- **Closed TourId union** — untouched (`isTourId` narrowing still guards the
  Settings picker; server still stores opaque bounded strings).
- **D2 pin repair (ReviewLibrary)** — untouched.
- **P2 (PUT-shape pins the no-clobber contract)** — the *test* changed
  because the mechanism changed, but the *property* got strictly stronger:
  the sync now issues no full-blob PUT at all, and the new tests pin that
  structurally (client: `putPrefs` never called by the tour path; server:
  byte-identical stored slices after a PATCH).
- **P4 (coalesced sync)** — structure intact; only the network op inside it
  changed.
- **P5/P-6 (Settings live-sources `toursSeen` at PUT-compose)** — untouched
  and still necessary: Settings' own PUTs still carry the field.
- **P-4 (can't wedge UI / can't burn first-run)** — strengthened: the claim
  is now true for real registry content, not just in principle.

## Gates (all green before commit)

- client `npm ci` + `npm run lint` → 0 findings
- client `npx tsc -p tsconfig.app.json --noEmit --incremental false` → 0 errors
- client `npx vitest run` (FULL suite) → **128 files, 2,235 tests, 0 failed**
  (was 127/2,211 pre-fix)
- client `npx vite build --outDir /tmp/km-tourfix2-dist` → success
- server `npm ci` + `npm run typecheck` → 0 errors
- server `npx vitest run tests/routes/settings.test.ts` (testcontainer) →
  **54 tests, 0 failed** (was 43 pre-fix)
