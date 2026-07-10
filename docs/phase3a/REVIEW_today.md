# Independent Review — Phase 3 Group 3A: Today page + WritingTopicGenerator

**Reviewer:** independent senior review (did not author this code)
**Branch:** `feat/phase3a-core-surfaces` vs `rebuild`
**Scope:** `client/src/pages/Today.{tsx,css,test.tsx}`, `client/src/components/WritingTopicGenerator.{tsx,css,test.tsx}`, additive `generateWritingPrompt` block in `client/src/services/writing.ts`. Neighbors sampled: `SwipeCarousel.tsx/.css/.test.tsx`, `server/src/routes/writing.ts`, `lib/errorCopy.ts`, `hooks/useEndpointOrMock.ts`, `App.tsx`, design tokens in `styles/index.css`.

## Verdict: **PASS WITH CONDITIONS**

0 BLOCKERS. 3 SHOULD-FIX (one real keyboard-a11y wrinkle, two test-rigor gaps). The implementation is genuinely strong: the F-027 generator's state machine, abort discipline, and 429 handling are textbook; B-019 is intact and explicitly commented; the dead-CSS cross-check came back exactly clean. Conditions: address or explicitly waive the three SHOULD-FIXes before merge.

**Verification actually run:** `vitest run` on both scoped suites — 30/30 pass. `tsc --noEmit` — clean. `eslint` on all five scoped TS/TSX files — clean. `grep` for `console.`/`TODO`/`FIXME` in all seven scoped files — zero hits. Removed-CSS-class vs TSX-reference cross-diff — zero orphans in either direction. All five navigation targets confirmed as real routes in `App.tsx:117–134`.

---

## Bar checklist

| Bar item | Status | Notes |
|---|---|---|
| WCAG AA — contrast | PASS | All colors are AA-audited tokens (`styles/index.css:28–34,122–127`); spot-computed `--paper-mute` on `--ink-2` ≈ 4.9:1 |
| WCAG AA — focus visibility | PASS | `focusring` on every interactive element (tiles, radios, resume banner) |
| WCAG AA — keyboard | PASS* | Full radiogroup arrow-key support; *see SF-1 (focus dropped when Generate disables itself) |
| Correct ARIA — radiogroup | PASS | `role=radiogroup` + `aria-labelledby`, `role=radio` + `aria-checked`, roving tabindex, wrapping arrows (`WritingTopicGenerator.tsx:139–170`) |
| Correct ARIA — async reveal | PASS | Persistent `aria-live="polite"` container (`WritingTopicGenerator.tsx:193`), `role="alert"` for errors (:214), `aria-busy` while in flight (:133) |
| Carousel a11y | PASS | Inherited from Phase-1 primitive (region + roledescription + tabs/tabpanels + inert off-screen pages); consumed correctly |
| Strict TS at I/O boundary | PASS | `GeneratedWritingPrompt` mirrors the server response field-for-field incl. `null` normalization (`services/writing.ts:162–173` vs `server/src/routes/writing.ts:312–320`); no `any`; typed generic on `api.post` matches existing service convention |
| No swallowed errors / working retry | PASS | Generator: fixed-copy error + button stays enabled as retry, retry exercised in test; abort-on-unmount + supersede both correct and tested. Today plan failure → ErrorCard + `refetch` (see SF-3 on test depth) |
| 429 renders real retryAfter copy | PASS | `errorMessageFor` structured path; tested at BOTH component level (`WritingTopicGenerator.test.tsx:142–167`) and Today integration level (`Today.test.tsx:423–445`) |
| No server prose echoed | PASS | Fixed-copy contract; 502 test asserts `pg constraint` never reaches DOM (`WritingTopicGenerator.test.tsx:169–185`) |
| Tests exercise real behavior | PASS* | Navigation via real MemoryRouter routes; panel-order asserted structurally; real `ApiError` class; captured-signal abort proof. *See SF-2 (loop prop unpinned at page level) |
| Loop test actually wraps | PASS | Real swipe-wrap both directions + repeated wrap, in Phase-1 `SwipeCarousel.test.tsx:408–441` (not in this diff, verified present) |
| Resume-banner test proves real-attempt gating | PASS | Positive (`Today.test.tsx:495–506`) and negative (`:508–517`) both asserted |
| Backward-compat SwipeCarousel consumers | PASS | `loop` defaults false, `cornerSlot` optional; primitive untouched by this diff |
| Co-located CSS | PASS | `Today.css` and `WritingTopicGenerator.css` colocated; tokens only |
| Match existing Today conventions | PASS | Inline spacing style, SkeletonCard, hook usage all match the rebuild version verbatim |
| No scope creep (in-scope files) | PASS | Scoped files contain only F-026/027/028/029 + B-018 work |
| No console.log | PASS | grep clean |
| No TODO without ticket ref | PASS | grep clean (see N-5 for a soft deferral) |
| No dead CSS | PASS | Every removed `.km-today__exam*/queue/shortcut*/soon*` rule maps to a removed component; zero removed classes still referenced in TSX (verified by cross-diff) |
| F-026 lead carousel polished | PASS | ActionTile: accent surface, icon chip, pill, stat headline, meta, arrow — a designed tile, not a plain box (`Today.tsx:177–229`, `Today.css:44–153`) |
| B-018 no "coming soon" | PASS | Test pins the old placeholder's exact strings incl. `준비 중` and `Daily grammar drills` (`Today.test.tsx:260–267`); grammar tile → real `/learn/grammar` route (`App.tsx:133`) |
| F-027 style choice + graceful 429 | PASS | topik/general radiogroup, closed-enum body, 429 first-class |
| F-028 order + corner resume banner | PASS | Study tile panel[0], mistakes panel[1] asserted structurally (`Today.test.tsx:449–470`); banner rides `cornerSlot` over both pages, only with a real attempt |
| F-029 all three carousels loop | PASS* | `loop` on all three (`Today.tsx:351,432,465`); *page-level pinning gap = SF-2 |
| **B-019 NOT regressed** | **PASS** | Reading tile still targets `/learn/listen` (`Today.tsx:298`) with an explicit comment naming B-019 and the blocking F-067–F-070 group (`Today.tsx:295–297`). Not prematurely "fixed". |

---

## BLOCKER

None.

## SHOULD-FIX

**SF-1 — Keyboard focus is dropped when the Generate button disables itself mid-flight.**
`WritingTopicGenerator.tsx:175` (`disabled={busy}`). A keyboard user pressing Enter on "Generate topic" has their focus silently moved to `<body>` the instant the button disables; when the call resolves they must Tab back from the top of the page. The `aria-live` region mitigates for screen-reader users (the topic is announced) but sighted keyboard users get no such cue, and a 429/error path lands them nowhere near the retry button the copy tells them to use. Standard remedies: `aria-disabled="true"` + an in-handler busy guard instead of `disabled`, or restore focus to the button when `phase` leaves `busy`. WCAG 2.4.3-adjacent — real, but not an approval-refusing hole given the live-region mitigation and the single-control panel.

**SF-2 — F-029 is unpinned at the Today level: deleting `loop` from all three carousels passes the entire suite.**
`Today.test.tsx` never asserts looping on any of the three carousels; wrap behavior is (properly, behaviorally) tested only inside the Phase-1 primitive's own suite (`SwipeCarousel.test.tsx:408–441`). That means the ticket's acceptance criterion — *these three carousels* loop — has no regression guard: a future edit dropping the `loop` prop from `Today.tsx:351/432/465` is invisible to CI. One pointer-swipe wrap test against the lead carousel (last page → forward swipe → page 1 active), reusing the primitive suite's pointer-event helper, closes this without tautology.

**SF-3 — The plan-failure Retry is asserted to exist but never to work.**
`Today.test.tsx:279` checks `getByRole('button', { name: 'Retry' })` is in the document, but the hook mock's `refetch` is an inert `() => undefined` (`Today.test.tsx:56,68`) and no test clicks the button or asserts the wiring (`Today.tsx:279` passes `today.refetch` → ErrorCard `onRetry`). The bar demands a *working* retry; as written, `onRetry={undefined}` or a miswired handler would still pass. Make `refetch` a `vi.fn()` in the mock and assert it is called on click.

## NIT

**N-1 — `services/plan` unmocked despite the test's own stated rationale.**
`Today.test.tsx:84–94` mocks `services/topik` and `services/writing` "so no test path can reach the real axios layer", but `services/plan` (whose `fetchToday` the screen closes over at `Today.tsx:253`) is left unmocked. Harmless today (the hook mock never invokes `realFn`) but internally inconsistent — mock all three or none.

**N-2 — Regenerate blanks the previous topic.**
`WritingTopicGenerator.tsx:97` — `setState({ phase: 'busy' })` discards the `done` prompt, so "New topic" collapses the result panel for the duration of the call (layout jump + the polite live region empties). Keeping the stale prompt visible (dimmed) during `busy` — e.g. `{ phase: 'busy'; prev?: GeneratedWritingPrompt }` — would read better. Preference, not a defect.

**N-3 — Late attempt resolution shifts the TOPIK carousel layout.**
`Today.tsx:469,501` + `Today.css:38–40` — when the attempt lookup resolves *after* first paint, both TOPIK pages gain 44px `padding-top` and the banner pops in. Honest (never a fabricated banner) and small, but a reserved-space or transitioned variant would avoid the jump.

**N-4 — 44px banner clearance is a cross-file magic number.**
`Today.css:38` hardcodes clearance derived from `SwipeCarousel.css:51–55` (`top: 8px`) plus the banner's own computed height. Documented in the comment (good), but if the bilingual banner text ever wraps on a narrow viewport the clearance silently breaks. A shared custom property (`--km-corner-clearance`) would couple them explicitly.

**N-5 — Dead-rule sweep deferral has no ticket reference.**
`Today.css:9–12` documents that the now-unreferenced `.km-today__queue*` rules in `styles/index.css:3157–3182` are deliberately left for "the app-wide dead-rule sweep". The reasoning (shared mutable global sheet across parallel branches) is sound, but the sweep itself is untracked — worth a backlog entry so the deferral doesn't rot.

## PRAISE

(The fix-pass must not undo any of these.)

**P-1 — The generator's lifecycle is exemplary.** The `GenState` discriminated union (`WritingTopicGenerator.tsx:69–73`) eliminates boolean-soup states; the abort discipline is exactly right — supersede-on-regenerate (:94), abort-on-unmount (:84–89), and the double `ctrl.signal.aborted` guard on both resolve and reject paths (:102,:106) so an aborted call can never set state. The unmount test proves it with a captured real `AbortSignal` (`WritingTopicGenerator.test.tsx:187–206`), not a mock assertion.

**P-2 — Error handling honors the fixed-copy contract end-to-end and the tests prove the negative.** 429-with-retryAfter, 429-without, and a 502 carrying fake server prose (`pg constraint xyz`) are each exercised, with an explicit assertion that the prose never reaches the DOM (`WritingTopicGenerator.test.tsx:169–185`). The 429 path is additionally re-proven at the Today integration level (`Today.test.tsx:423–445`) — the button stays enabled as the retry, and the retry-succeeds path is exercised too (`WritingTopicGenerator.test.tsx:162–166`).

**P-3 — The honest-null attempt mock.** `Today.tsx:148–157` deliberately resolves `null` so no dev fallback or prod failure can ever paint a resume CTA for an exam that doesn't exist, and the test suite pins both directions (`Today.test.tsx:495–517`). This is the right instinct applied consistently (same rationale as the plan-failure degradation keeping the grammar tile alive, tested at `:269–288`).

**P-4 — B-019 handled with discipline.** The tempting-to-"fix" Reading tile keeps its `/learn/listen` target with a comment naming the bug, the blocking ticket group (F-067–F-070), and why (`Today.tsx:294–298`). Exactly what the ticket demanded.

**P-5 — Dead-CSS hygiene is verifiably complete.** Every class removed from `Today.css` (`exam*`, `queue`, `shortcut*`, `soon*`) corresponds to a removed component, zero removed classes survive in the TSX, and the header comment (`Today.css:5–12`) documents the one deliberate exception with a defensible concurrency rationale.

**P-6 — Client/server contract fidelity.** `GenerateWritingPromptBody` and `GeneratedWritingPrompt` (`services/writing.ts:151–173`) mirror the route's `.strict()` + refine schema and its response shape field-for-field, including the `lengthHint ?? null` / `rubric ?? null` normalizations (`server/src/routes/writing.ts:270–320`); the timeout override (35s, `services/writing.ts:187`) follows api.ts's documented Claude-route contract with reasoning for the sizing relative to the 65s grade leg.

**P-7 — The single-generator-instance sweep.** `Today.test.tsx:383` asserts exactly ONE radiogroup exists across all carousel pages including hidden ones — a subtle test that catches accidental generator mounting on non-Writing tiles.

---

## Coordination observations

1. **Other files in this diff** (`Progress.*`, `Settings.*`, `services/notifications.ts`) are outside this review's scope — they need their own reviewer; nothing in the Today/generator work depends on them.
2. **F-073 reuse readiness:** `WritingTopicGenerator` is fully standalone (no Today-specific props or context), so the Writing screen can mount it as-is. One design note for F-073: the generated topic is display-only by design here — carrying it into the grading flow will need a callback prop (e.g. `onGenerated`) added *additively*.
3. **SwipeCarousel primitive:** `loop`/`cornerSlot` behavior is properly covered in the Phase-1 suite (`SwipeCarousel.test.tsx:408–466`, real swipe wraps both directions + corner overlay render/omission). This diff correctly leaves the primitive untouched — Progress's non-looping usage is unaffected by construction (`loop` default false).
4. **Global-sheet dead rules** (`styles/index.css:3157–3182`, `.km-today__queue*`): now orphaned by this branch; whichever branch lands last in P3a should own the sweep ticket (see N-5).
5. **nginx allow-list:** no new top-level API prefix introduced (`/writing/generate` rides the existing `/writing` prefix, already routed for F-014) — the F-012-class SPA-shadow trap does not apply here.
