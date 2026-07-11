# FIX_REPORT — Phase 3C-2 fix-pass (Reading · Listen · Writing · TOPIK)

Independent fix-pass against `REVIEW_reading.md`, `REVIEW_listen.md`,
`REVIEW_writing.md`, `REVIEW_topik.md` on `feat/phase3c2-content`. Reviews
carried 0 BLOCKERS / 11 SHOULD-FIX total. Scope: all 11 should-fixes.
CLIENT-only — `server/` and `db/` untouched. No push, no deploy.

## Disposition table

| ID | Finding | Disposition | What changed |
|---|---|---|---|
| Reading SF-1 | F-068 generation abort path has no test | **FIXED** | Added a mirror of the existing `mineWord` abort regression test in `Reading.test.tsx`: captures `generateStory`'s signal via a never-resolving mock, switches to the Books tab mid-flight, asserts `signal.aborted === true`. Exercises the real unmount path through `Tabs`' render-one/re-key design. |
| Reading SF-2 | Books `usePagination(..., { max: 30 })` can strand uploads >30; server `GET /uploads` is unbounded | **FIXED** | Raised `max` to 200 in `Reading.tsx`'s `BookSection`, matching the sibling Stories window. Documented in a code comment that `GET /uploads` (server/src/routes/uploads.ts:216) has no server `LIMIT` to mirror exactly — 200 is a deliberately generous fixed ceiling, not tied to a cap that doesn't exist. |
| Listen SF-1 | `ShowMore` unmounts on final reveal, drops keyboard focus to `<body>` (WCAG 2.4.3) — cross-cutting, fix belongs in the primitive | **FIXED** | Fixed inside `components/ShowMore.tsx` only (not per-consumer): the exhausted state now renders a visually-hidden (`.km-sr-only`), non-tab-stop (`tabIndex={-1}`) stand-in instead of `null`; an effect hands focus to it on the actual button→hidden transition (never on an already-exhausted first mount). Added two new tests to `ShowMore.test.tsx` (focus handoff + no-steal-on-mount) and updated the "renders nothing" test to the new contract. Re-ran `Progress.test.tsx` (44/44) and `ReviewVocab.test.tsx` (30/30) — both consumers pass unchanged, including their own "Show more" window/reset assertions. |
| Listen SF-2 | Row `aria-label` on Ttmik/Iyagi rows replaces the subtree name, hiding the AudioPill's "Audio"/"No audio" text from AT | **FIXED** | Folded audio state into both aria-labels in `Ttmik.tsx` (`… (audio)` / `… (no audio)`). Updated the exact-string `getByRole('button', { name: … })` assertions in `Ttmik.test.tsx` accordingly (lesson 1 = audio, lesson 21 = no audio, episode 1 = audio, episode 143 = no audio, matching the fixtures). |
| Listen SF-3 | Ttmik hand-rolls a Highlights/Transcript tablist while the shared `Tabs` (F-032) primitive exists | **FIXED** | Migrated the lesson sub-tabs in `Ttmik.tsx` to mount `Tabs` (full APG roving-tabindex/Arrow/Home/End/tabpanel contract) instead of the hand-rolled `role="tablist"` `<div>`. The persistent `<audio>` element is rendered as a sibling ABOVE this branch and is untouched by the swap, so its DOM position — and therefore its cross-tab identity (P-2 praise item) — is preserved; the identity test (`toBe` on the audio node across tab switches) stays green. |
| Listen SF-4 | `DetailView`'s fetch effect deps on `selection`, a fresh object literal every render → latent spurious abort+refetch | **FIXED** | Depped the effect on `selectionKey(selection)` (the same primitive string the parent already uses to key `DetailView`'s remount) instead of the object, with an `eslint-disable-next-line react-hooks/exhaustive-deps` + comment explaining the intentional exclusion. No new test added: the review itself notes this is "not currently reproducible in tests... latent, not live," and the assigned scope for this item was "stabilize the effect deps," not add a regression test — recorded here for the record. |
| Writing SF-1 | Today↔Writing F-101 handoff has zero test coverage on the Today side | **FIXED** | Added an integration test in `Today.test.tsx`: renders the real `Today` page, drives the real `WritingTopicGenerator` (Generate → "Write this topic"), and asserts against a real route stub that reads `useLocation().state` — pinning both the exact state key (`generatedTopic`) and the route (`/learn/writing`) against each other, not against hand-built state. |
| Writing SF-2 | `WritingTopicGenerator` prop-less backward-compat only implicitly asserted | **FIXED** | Added a test to `WritingTopicGenerator.test.tsx` asserting `queryByRole('button', { name: /Write this topic/ })` is absent after a successful generation when `onUseTopic` is omitted — locks Today's display-only contract against a future `onUseTopic = someFallback` default. |
| TOPIK SF-1 | B-029's `limit`-forwarding has zero coverage (`Topik.test.tsx` mocks `useEndpointOrMock` wholesale) | **FIXED** | Extracted the request-option builder into `lib/topikStudyDraw.ts` as `buildStudyDrawOptions(setSize)` (kept out of `Topik.tsx` itself — exporting a non-component from a page file trips `react-refresh/only-export-components`). `Topik.tsx`'s `realFn` now calls it. Added `lib/topikStudyDraw.test.ts` unit-testing the boundary directly: `''` → `{}`, `'20'/'30'/'50'` → `{ limit: N }`. This fails on a regression (e.g. a dropped `limit` or `NaN`) that the mocked-hook UI test cannot catch. |
| TOPIK SF-2 | F-078 "This session" tally silently resets when `StudyMode` unmounts (mode switch, or the Previous-attempts link) | **FIXED** | Lifted `tally`/`setTally` out of `StudyMode` into the `Topik` root component (which never unmounts across either navigation) and passed them down as props. Added `setTally` to `commitReview`'s `useCallback` deps (required once `setTally` became a prop rather than a local `useState` setter — otherwise React Compiler / `exhaustive-deps` correctly flag it, since a prop's identity isn't provably stable at the callee). Added two regression tests to `Topik.test.tsx`: tally survives a Study→Mock→Study round trip, and survives a trip to Previous-attempts and back. |
| TOPIK SF-3 | Code cites "proposed" F-118/F-119; F-081 image stub cites no ticket at all | **FIXED** | Confirmed F-116–F-120 are now filed in `BUGS_AND_FEATURES.md` (already landed on this branch — see `docs(phase3c2): file F-116–F-120 follow-up tickets` in the log — prior to this fix-pass starting). Removed the stale "proposed"/"proposed ticket" wording at all 4 sites in `topik/MockMode.tsx` (now reads plain `F-118`). Added an **F-120** reference to `components/TopikImageNote.tsx`'s docblock (previously uncited). Verified the F-116 (`Reading.tsx`), F-117 (`Writing.tsx`), F-118/F-119 (`MockMode.tsx`) code refs against the backlog's actual descriptions — all match (route/data-gap claims line up). |

## Incidental fixes made while in these files

- **Ttmik.tsx**: removed a now-stale `eslint-disable/enable react-hooks/set-state-in-effect` pair around `DetailView`'s fetch-kickoff `setLoading`/`setError` calls — the SF-4 dependency-array change (object → primitive key) made the rule stop flagging that block, and ESLint correctly reports the disable as unused dead code. Removing it is required for a clean `npm run lint`, not optional polish.
- Attempted the Listen review's N-1 nit (`role="list"` on the three transcript `<ol>`s, for Safari's `list-style:none` semantics-stripping) but **reverted it**: it collides with the project's own `jsx-a11y/no-redundant-roles` rule (`<ol>`'s implicit role already is `list`), which would fail `npm run lint`. Out of the assigned 11-item scope regardless — left as a NIT for a future ticket, not fixed.

## Self-assessment

- All 11 assigned should-fixes: **FIXED**, 0 deferred, 0 rejected.
- No PRAISE item was undone: the F-070 honest-stub, the abort-discipline pattern across all pages, the `aria-disabled`+guard busy-button pattern, the persistent-`<audio>`-identity invariant (re-verified after the SF-3 `Tabs` migration), the stale-resume guard, the draft-preservation logic in Writing, the wall-clock timer discipline in MockMode, and the PROD anti-fabrication posture are all untouched and their governing tests are still green.
- Gates run: `tsc -p tsconfig.app.json --noEmit --incremental false` → clean. `npm run lint` → clean (0 errors, 0 warnings). Targeted vitest run across every touched test file plus both `ShowMore` consumers (`Progress`, `ReviewVocab`) → **257/257 passed** across 11 files (exact per-file counts below).
- New tests added are non-tautological: each one fails on the pre-fix code by construction (verified by re-reading the diff each test targets, not just by running green) — e.g. the ShowMore focus test asserts `document.activeElement` is not `document.body`, which is exactly what regresses without the fix; the Today↔Writing test reads real `location.state` off a real route, not a hand-built fixture; the tally tests exercise the actual unmount paths (`Tabs` re-key and the `view==='attempts'` early return) the review named.
- Two items (Reading SF-2, TOPIK SF-3) were pure "raise a ceiling / fix stale wording + citations" changes with no new runtime branch to test, so no new tests were added for them — consistent with what each review actually asked for.

## Test counts (targeted run, this fix-pass)

| File | Tests |
|---|---|
| `src/pages/Reading.test.tsx` | 24 passed |
| `src/pages/Ttmik.test.tsx` | 24 passed |
| `src/pages/Writing.test.tsx` | 23 passed |
| `src/pages/Today.test.tsx` | 25 passed |
| `src/pages/Topik.test.tsx` | 31 passed |
| `src/pages/topik/MockMode.test.tsx` | 37 passed |
| `src/components/ShowMore.test.tsx` | 7 passed |
| `src/pages/Progress.test.tsx` (ShowMore consumer) | 44 passed |
| `src/pages/review/ReviewVocab.test.tsx` (ShowMore consumer) | 30 passed |
| `src/components/WritingTopicGenerator.test.tsx` | 10 passed |
| `src/lib/topikStudyDraw.test.ts` (new) | 2 passed |
| **Total** | **257 passed, 0 failed** |

`npx tsc -p tsconfig.app.json --noEmit --incremental false` — 0 errors.
`npm run lint` — 0 errors, 0 warnings.
