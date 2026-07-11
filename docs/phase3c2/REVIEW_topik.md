# Independent Review — Phase 3C-2 TOPIK surfaces (Topik.tsx / MockMode.tsx)

Reviewer: independent senior review (did not author this code). Scope:
`client/src/pages/Topik.tsx|.css|.test.tsx`, `client/src/pages/topik/MockMode.tsx|.css|.test.tsx`,
sampled `server/src/routes/topik.ts` for wiring context. Branch `feat/phase3c2-content` vs `rebuild`.

## Summary verdict

**PASS — 0 BLOCKERS, 3 SHOULD-FIX, 5 NIT.** Every backend-blocked ticket
(F-078/079/080/081/082) renders a genuinely honest pending/empty state; nothing
fabricates a completion, score, checkmark, audio player, or image. The explicit
Start gate is real and test-asserted (no fetch, no timer until Start). B-029 is
fixed against the actual server schema. Both test files re-run green here
(66/66). The top finding is a coordination gap: the code cites "proposed"
tickets F-118/F-119 that exist nowhere in the backlog, and the F-081 image stub
cites no ticket at all.

## Quality-bar checklist

| Bar | Status | Evidence |
|---|---|---|
| WCAG AA / correct ARIA | PASS | Roving-tabindex APG radiogroup in exam (MockMode.tsx:1511-1623); `aria-checked` only (no conflicting `aria-pressed`), documented (Topik.tsx:768-773); timer `role="timer"` + `aria-live="off"` with coarse sr-only polite cues (MockMode.tsx:1302-1317, 1234-1242) — both test-asserted; palette buttons announce answered/current state (MockMode.tsx:1474-1476); submit confirm is a focus-trapped `alertdialog` via `useModalA11y` (MockMode.tsx:1016-1023, 1408); tally live region `aria-live="polite"` (Topik.tsx:197) |
| Strict TS at I/O boundaries | PASS | URL params parsed against closed unions (`parseSectionParam`/`parseExamParam` MockMode.tsx:127-138; `view`/`mode` Topik.tsx:106-107); `parseSetSize` narrows FilterSelect's free string (Topik.tsx:347-349); `timeMs` clamped to server zod cap — client `MAX_ITEM_TIME_MS = 3_600_000` (MockMode.tsx:173) exactly matches server `max(60 * 60 * 1000)` (server/src/routes/topik.ts:1096) |
| No swallowed errors | PASS | Abortable fetch/submit (one `AbortController` per call, abort on unmount, MockMode.tsx:247-258, 274-279); real error + retry for fetch AND submit (retry re-sends the same picks via `pendingSubmitRef`, MockMode.tsx:519-522); the only silent catches are documented best-effort writes (`recordTopikAnswer` Topik.tsx:526-546, `saveAttempt`/`clearAttempt` MockMode.tsx:339-358, 483-485) — deliberate, threat-model'd, and the reveal/grade never depends on them |
| Tests exercise real behavior | PASS w/ gaps | Wall-clock-deadline tests stub `Date.now` independently of the interval (throttled-tab, resume-budget, stale-save — MockMode.test.tsx:326-462); PROD no-fixture-substitution tests (1246-1311); Start-gate asserted via `fetchMockTest` not-called (1043, 1067). Gaps: SF-1, N-2 below |
| Co-located CSS | PASS | New 3C-2 styles live in Topik.css / MockMode.css, tokenized for both themes; the inline styles in `ResumeBanner` predate this phase (zero `style=` lines in the diff vs rebuild) |
| No scope creep | PASS | Within this scope the diff touches only the six named files; other changed files belong to sibling 3C-2 tickets |
| No console.log / no ticketless TODO | PASS* | grep clean for `console.log`/`TODO`/`FIXME`. *But see SF-3: two cited ticket ids are unregistered, one stub is uncited |

## Honest-stub audit (primary focus)

| Ticket | Honest? | Evidence |
|---|---|---|
| F-078 daily counter | **YES** | Tally counted client-side only from real committed outcomes (`commitReview`, Topik.tsx:496-510 — fed by actual Next/Skip on real reveals); tile is labelled "This session" (Topik.tsx:194); daily total explicitly pending: "Full-day totals will appear once attempt history is available" (Topik.tsx:207-212), F-104 cited in comments (Topik.tsx:27-30, 171-177). Test asserts the pending copy and correct increments incl. skip-as-wrong (Topik.test.tsx:662-700). Nothing claims to be a full-day total. Caveat: session tally resets on StudyMode unmount — undercount, never fabrication (SF-2) |
| F-079 chooser + checkmarks + start page | **YES** | Chooser offers exactly ONE wired card ("Recommended exam", server-picked, MockMode.tsx:765-785) plus an honest "Coming soon" pending block naming both missing dependencies (789-799); zero checkmark markup in the chooser (the only `check` icons are results verdicts / tally). Start page renders meta + rules + honestly-pending previous-attempts block (853-865). Start gate is real: `fetchMockTest` asserted NOT called after both navigation steps, called exactly once on Start with no `sourceTest` (MockMode.test.tsx:1043-1044, 1067, 1076-1081) |
| F-080 listening audio | **YES** | No `<audio>`, no play control anywhere — test asserts both absent (MockMode.test.tsx:1174-1177); gap disclosed BEFORE the timer arms (start page, MockMode.tsx:843-850) and again in the exam head (1282-1296); Reading exams carry no note (test 1180-1190); ticket F-119 cited (1288) — but see SF-3 |
| F-081 question images | **YES** | `splitImageItem` + `TopikImageNote` feature the bracketed text description in a labelled `aside` (`aria-label="Image described in text"`); when no description was captured, an explicit honest fallback: "The original exam shows an image here that isn't included in this app" (TopikImageNote.tsx:37-42). No `<img>`, no broken/fake asset, gated strictly on `hasImage` (Topik.tsx:719-722, MockMode.tsx:1265-1268). Tested in both modes. No F-120 ref anywhere, though — see SF-3 |
| F-082 attempts review view | **YES** | `?view=attempts` deep-link works (parsed against a closed check, Topik.tsx:106, 130; deep-link test Topik.test.tsx:735-752); both tiles render explicit pending copy citing the F-104 dependency (Topik.tsx:247-270); test asserts no `%` appears anywhere (no fabricated grade, Topik.test.tsx:721); the one wired affordance is a real `Link` to `/review/mistakes` (Topik.tsx:274-277, href asserted) |

**B-029 (verify fixed): FIXED.** Draw size is user-controllable via
`FilterSelect` (Topik.tsx:337-349, 556-563); `''` placeholder = server default,
labelled "10 · recommended"; options top out at 50 = the server's actual
`StudyBodySchema.limit.max(50).default(10)` (server/src/routes/topik.ts:1301);
chosen size forwarded as `limit` (`fetchStudyDraw(setSize === '' ? {} :
{ limit: Number(setSize) })`, Topik.tsx:387-390) and the hook key carries
drawKey + size so a size change is a real refetch. Test coverage of the
*forwarding* itself is missing (SF-1).

**F-024 (BackButton everywhere): PASS.** Chooser → "Back to Sections"
(MockMode.tsx:760), start page → "Back to {section} exams" (825-828), running
exam → same (1277-1280), attempts view → "Back to TOPIK" (Topik.tsx:232). Exam
exit flushes a resumable save via the unmount cleanup — test asserts the
flushed save carries the pick and that leaving is NOT a submit
(MockMode.test.tsx:1110-1141). Back-guard effect handles the resume URL-lag
race correctly (`examUrlBoundRef`, MockMode.tsx:296-319).

## Findings

### BLOCKER

None.

### SHOULD-FIX

**SF-1 — B-029's core behavior (limit forwarding) has zero test coverage.**
`Topik.test.tsx` module-mocks `useEndpointOrMock` wholesale (Topik.test.tsx:40-42),
so `realFn` is never invoked: no test asserts `fetchStudyDraw` receives
`{ limit: 30 }`, nor that the key change actually triggers a refetch. The
B-029 test (634-660) verifies only the select UI and stepping-state reset — the
wire half of the fix is unproven. A regression that stopped forwarding `limit`
(or built `{ limit: NaN }`) would pass the suite. Add an assertion at the
service boundary (e.g. spy on `fetchStudyDraw` and drive the real hook, or
export/unit-test the option-building).

**SF-2 — the F-078 "This session" tally silently resets on StudyMode unmount.**
`tally` lives in `StudyMode` state (Topik.tsx:365-376); the `Tabs` panel
renders with `key={activeId}` (Tabs.tsx:159) so switching Study→Mock→Study
unmounts and zeroes it — and so does clicking the **adjacent** "Previous
attempts" link (the `view === 'attempts'` early return at Topik.tsx:130 unmounts
the whole tabbed area). A learner who peeks at attempts and comes back loses
their session count. The comment's "never reset by New set or a size change"
holds, but the user-facing "This session" claim doesn't survive the two
navigations the same landing offers. Lift the tally to `Topik` (or module-level
state); the deliberate no-persistence decision (Topik.tsx:362-364) is fine and
unaffected. Undercount only — not a fabrication, so not a blocker.

**SF-3 — cited stub tickets are not registered; one stub is uncited.**
Code comments cite "proposed ticket F-118" (MockMode.tsx:20, 134, 744-747) and
"data-gap ticket F-119" (MockMode.tsx:811, 1288), but neither id exists in
`BUGS_AND_FEATURES.md` or any repo .md (repo-wide grep: zero definitions;
backlog has F-104 at BUGS_AND_FEATURES.md:1239 but stops at F-105-ish range).
The F-081 image-gap stub cites no ticket at all (expected F-120 per the phase
plan). The honest-stub bar is "render honest state AND reference the ticket" —
half-met until F-118/F-119/F-120 are actually registered in
`BUGS_AND_FEATURES.md`. Pure docs/backlog change; no code edit needed.

### NIT

**N-1 — `SKIPPED_PICK` sentinel doubles as display copy.** The literal string
`'skipped'` renders to the user inside a Korean-styled span ("내 답:
skipped") in review rows (MockMode.tsx:1639, 1773-1776; produced at
Topik.tsx:488). Works, and the F-020 seed gate correctly never labels it as a
wrong answer — but a bilingual display mapping (건너뜀 · skipped) decoupled
from the sentinel would read better and stop a copy tweak from being a logic
change.

**N-2 — one tautological micro-assertion.** MockMode.test.tsx:261-265 asserts
the value resolved by the *mocked* `fetchMockTest` has no `correct` property —
i.e. it asserts the test's own fixture. The stripped-wire guarantee actually
lives in the `TopikMockItem` type + server projection; the assertion proves
nothing the fixture didn't define. The rest of that test is real; just drop or
re-point this line at the DOM (e.g. no reveal styling present).

**N-3 — fast-Next can commit a missed item's review row without its
explanation.** For a live-pool item (empty inline explanation), if the learner
clicks Next before `recordTopikAnswer` resolves, `commitReview` reads an empty
`effectiveExplanation` (Topik.tsx:459-469, 496-499) and the F-008 results row
for that miss permanently lacks the explanation the reveal would have
backfilled a moment later. Rare and self-healing next session; worth a
follow-up only.

**N-4 — start page hardcodes "50 items"** (MockMode.tsx:838-840) for whatever
exam the server picks. True for the standard TOPIK II paper format today, but
if a partially-ingested paper ever serves fewer items the page will have
overstated. Fine now; becomes real when F-118 lists concrete exams.

**N-5 — `role="status"` on static pending Cards** (MockMode.tsx:789, 855;
Topik.tsx:250). Live regions are for dynamic updates; on mount-static content
some AT re-announces them gratuitously. Plain text (or nothing) suffices.

### PRAISE (fix-pass must not undo)

**P-1 — Wall-clock-deadline timer discipline and its tests.** The countdown
derives from `deadline − Date.now()` with the interval as a render trigger only
(MockMode.tsx:1039-1057, 1129-1141), and `saveProgress` re-samples the deadline
rather than persisting stale interval state (1192-1209). The three tests that
prove it (throttled-tab, resume-budget, stale-save — MockMode.test.tsx:326-462)
stub `Date.now` independently of the faked interval and would each catch a
naive tick-counter rewrite. This is exactly how exam timers should be built and
tested.

**P-2 — PROD anti-fabrication posture, enforced by tests.** Failed real
fetch/submit in PROD never substitutes the fixture/pseudo-grader
(MockMode.tsx:432-437, 494-499), and the tests assert the fixture loaders are
*never consulted* (MockMode.test.tsx:1246-1311). This is the same honesty bar
as the stubs, applied to the failure path — do not "simplify" it away.

**P-3 — The `timeMs` clamp** (MockMode.tsx:164-173, 1089-1095) matches the
server zod cap to the millisecond and is documented with the exact failure it
prevents (one over-cap value 400s the whole `.strict()` submit while
`submittedRef` is latched → ungradeable exam).

**P-4 — Wire-contract regression capture.** The string-vs-number `itemId` Map
bug is fixed at the lookup (MockMode.tsx:1830-1839), the fixture now documents
why it must be a string (MockMode.test.tsx:86-89), and the test asserts the
resolved prompts/choices render instead of "No. 0"/'—' (558-569).

**P-5 — Timer a11y pattern** (aria-live="off" ticking clock + coarse polite
sr-only cues) with tests for both halves (MockMode.test.tsx:464-500).

**P-6 — Start-gate assertions by absence.** Both F-079 tests prove navigation
fetches nothing (`fetchMockTest` not called, no timer in DOM) before asserting
Start fetches exactly once — the strongest possible form of the gate check.

**P-7 — Atomic URL rewrites.** `selectMode` clears `section`/`exam`/`view`
together (Topik.tsx:112-125) and `goToView` never touches the parent's `mode`
(MockMode.tsx:204-216), so no stale deep-link state can survive a mode flip.

## Coordination observations

- `bandForPercentage` is duplicated client-side (Topik.tsx:292-297) and matches
  the server byte-for-byte (server/src/routes/topik.ts:388-393). The comment
  argues presentation-parity-not-shared-contract, which is defensible — but if
  the server bands ever change, Study's results screen silently diverges.
  Whoever builds F-104/F-103 should consider returning the band from the server
  for study summaries too, or a shared constant.
- The F-082 attempts view's BackButton targets `/learn/topik` (Topik.tsx:232),
  dropping `mode=mock` — a user who reached attempts from a future Mock-side
  link would land on Study. Today the only entry point is the Study landing, so
  correct as built; note for the F-104 wiring pass.
- `GET /topik/attempt` (singular, in-progress resume slot) exists and is used;
  `GET /topik/attempts` (history) genuinely does not — confirmed against
  `server/src/routes/topik.ts` route list. The stubs' dependency claims are
  accurate, and F-090 (BUGS_AND_FEATURES.md:1131-1134) already flags that
  pre-046 history will start empty — the honest-pending copy here is consistent
  with that product decision.
- Both test files pass in isolation (66/66, re-run during this review).
