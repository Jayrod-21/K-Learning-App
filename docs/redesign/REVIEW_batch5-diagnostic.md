# Review — Batch 5: Diagnostic (F-143 removal + F-128 reskin)

**Reviewer:** independent senior React/TS review (no code written by reviewer)
**Scope:** `client/src/pages/Diagnostic.tsx`, `Diagnostic.css` (new), `Diagnostic.test.tsx`
**Branch:** `feat/redesign-cleanup` @ `9243489`, diffed against `rebuild`
**Verified by:** reading full current file (1175 lines) + full diff (540 lines) + running the real test suite (`npx vitest run src/pages/Diagnostic.test.tsx` → **26/26 passed**) + `tsc --noEmit` (no Diagnostic errors) + `eslint` (clean) + grep sweeps for hex/orphans.

## Verdict

**PASS.** F-143 removal is genuine and complete, with no orphans. F-128 reskin is a real adoption of the character-device kit (not a flat token reskin), presentational-only, both themes token-driven. Flow and scoring logic are byte-for-byte unchanged apart from JSX wrapping. Test coverage is substantive, not tautological. One SHOULD-FIX (dead shared CSS left behind in `styles/index.css`) and a couple of NITs.

**Blocker count: 0.**

## Checklist

| Item | Status |
|---|---|
| F-143: "Begin today's plan" CTA removed | ✅ confirmed absent, incl. from DOM in a dedicated test |
| F-143: "Derived from your gaps / Next steps" goals card removed | ✅ confirmed absent |
| F-143: no orphaned `useNavigate` / handlers / state | ✅ `useNavigate` import + `const navigate` both deleted; nothing else references `navigate` |
| F-143: `snapshot.goals` field itself untouched (shared API contract) | ✅ type/service layer unchanged, only the render dropped |
| F-143: rest of Results (scores, SkillsCompare, retake) intact | ✅ `PageHubHeader`, sub-line, `CityCard` skills card, `SkillsCompare`, retake button all present and unchanged in substance |
| F-143: real regression test for the removed strings | ✅ dedicated test + reinforced in the "lands on Results" test |
| F-128: `PageHubHeader` on Intro + Results | ✅ |
| F-128: `CityCard` question/section hero, mirrors Topik | ✅ same `tone="accent" rail` pattern as `Topik.tsx` |
| F-128: `SubwayProgress` replaces hand-rolled bar | ✅ old `.km-diagnostic__progress`/`-fill` div deleted from the component (still dead in shared CSS — see SHOULD-FIX) |
| F-128: `SealStamp` `milestone` on Done | ✅ |
| F-128: both themes render via tokens, no hardcoded hex | ✅ grep clean on `Diagnostic.tsx`/`.css`; new CSS uses `var(--vermilion)` (aliased to `--dan-verm`/`--neon-coral` per theme) |
| F-128: reskin is presentational only | ✅ no state/handler changes in the diff outside JSX wrapping |
| Flow preservation: intro→taking→reveal→advance→finish→done→results | ✅ unchanged; `gradeAnswer`/`prefetchNext`/`advance`/`finishRun`/`retry` bodies are untouched in the diff |
| E-DG-409 resync path | ✅ untouched logic; test still green |
| Mid-run retry | ✅ untouched logic; test still green |
| Scoring (server-graded, never self-graded) | ✅ untouched; `ChoiceList` still keys off `reveal.correctAnswer` only |
| F-129 mobile / F-131 accent-aware hover | ✅ new `.km-diagnostic__choice:hover:not(:disabled)` uses `var(--vermilion)`, matches `Topik.css` precedent |
| Test quality (real assertions, not tautologies) | ✅ see below |

## F-143 removal — explicit verdict

**Genuinely and completely removed, with no orphans.** Confirmed via three independent methods:

1. **Diff read** (`/tmp/diag.diff` lines 446–540): the entire `<Card className="km-diagnostic__goals-card">…</Card>` block (Eyebrow, "Next steps" title, `snapshot.goals.map` list) is deleted outright, not commented out or dead-code'd. The "Begin today's plan" `<Button onClick={() => navigate('/')}>` is deleted in the same hunk. `const navigate = useNavigate();` (Diagnostic.tsx:1103 pre-diff) and `import { useNavigate } from 'react-router-dom';` (top-of-file) are both deleted — grep for `useNavigate|navigate(` in the current file returns nothing (confirmed via Bash).
2. **Grep on the shipped file** for the removed strings ("Begin today", "Next steps", "Derived from your gaps", "today's plan", "오늘의 계획", "약점 기반", "다음 단계") returns hits only inside the *explanatory code comment* at Diagnostic.tsx:55–57 and 1161–1162 documenting the removal — never in renderable JSX.
3. **Test**, `Diagnostic.test.tsx:433–460` ("F-143: removes the..."): renders Results with `POPULATED_SNAPSHOT` (which carries a real, non-empty `goals: ['Drill -더라도 daily.']`) and asserts by `queryByRole`/`queryByText` that neither the button, the English/Korean card copy, nor **the fixture's actual goal string** appear anywhere in the DOM — this is a strong test because it uses live fixture data with content that *would* leak if the removal were incomplete, rather than an empty-goals fixture that could pass vacuously. It also asserts the retake button is the sole surviving CTA. The adjacent "lands on Results" test (line 409) independently re-asserts retake is present, giving a second, independent check.

The retake button changed `variant="ghost"` → `variant="gold"` (now the sole primary CTA) — a sensible, intentional visual consequence of it being alone, not a functional regression (`onRetest` handler unchanged).

`snapshot.goals` remains on the `DiagnosticSnapshot` type and is still populated server-side/in fixtures — correctly left alone per the code comment, since it is a shared API contract other consumers may still read (Today.tsx was not audited here — out of scope for this batch, worth a follow-up grep if Today ever surfaces it).

## Flow-preservation verdict

**No regression.** Diffed every callback in `TakingBlock` (`beginCall`, `runStart`, `prefetchNext`, `gradeAnswer`, `submit`, `skip`, `finishRun`, `advance`, `retry`) against `rebuild` — none of their bodies changed; the diff only rewraps their JSX consumers inside `CityCard` and swaps the progress bar markup for `SubwayProgress`. Specifically:

- The manual progress math (`completed`, `progressNow`, `progressPct`) was deleted (Diagnostic.tsx diff lines 118–129) because `SubwayProgress` takes `steps`/`current` directly and computes its own fill — this is a legitimate simplification, not a silent behavior change: `current={item.ordinal - 1}` reproduces the same "current item, revealed or not" semantics the old bar had, and the design doc's own precedent (Topik) uses the identical `ordinal - 1` convention.
- `ChoiceList`'s correctness logic (`reveal !== null && c.id === reveal.correctAnswer`) is byte-identical — the server-graded, no-self-grading contract is untouched.
- The E-DG-409 handlers (`onAlreadyRecorded` in `gradeAnswer`/`finishRun`/`advance`) are untouched; the dedicated test (line 1031) still passes.
- All 26 tests pass, including the full end-to-end walk (`intro → taking → reveal → advance → finish → done → results`, line 642) and the B-006 dwell-overlap test (line 932) and the `next: null` early-finish test (line 990) — these are the tests that would catch a scoring/navigation regression, and none needed modification beyond the reskin-specific assertions layered on top.

## Findings

### SHOULD-FIX

**S1 — Dead CSS left in the shared `styles/index.css` after the reskin/removal (the "orphaned rules" the builder flagged).**
`client/src/styles/index.css` still contains, unreferenced by the current `Diagnostic.tsx`:
- `.km-diagnostic__display` (index.css:3061–3067) — dead since the old bare `<h1>` was replaced by `PageHubHeader`.
- `.km-diagnostic__progress` / `.km-diagnostic__progress-fill` (index.css:3120–3130) — dead since `SubwayProgress` replaced the hand-rolled bar.
- `.km-diagnostic__results-title` (index.css:3258–3265) — dead, same cause as `__display`.
- `.km-diagnostic__goals-card` / `.km-diagnostic__goals` / `.km-diagnostic__goal-row` / `.km-diagnostic__goal-num` (index.css:3274, 3282–3305) — dead, F-143 removal.

None of these are load-bearing (grep confirms zero references from any `.tsx`), so this is not a functional bug, but it is a real gap against the design doc's own "no orphaned hard-coded colors" *and* general hygiene expectation for a "cleanup batch" — the batch's own commit message is "cleanup" yet leaves ~45 lines of dead CSS behind. `Diagnostic.css`'s own doc comment explicitly disclaims touching `styles/index.css` as "out of this pass's scope," which is an honest note but doesn't make the dead code correct to leave — it should be a fast follow-up, ideally in the same PR since it's a one-line removal in a file this batch already knows is stale here. Recommend deleting the four rule groups above in a follow-up commit (verify no other page reuses the same class names first — spot-checked, these are Diagnostic-prefixed and page-specific, so safe).

### NITS

**N1 — `SkillsCompare`'s `defaultRefId`/goal ladder consumers not re-audited for `goals` leakage elsewhere.** The doc comment says `snapshot.goals` "is still part of the shared API contract (other consumers may read it)" — true, but this batch didn't grep whether `Today.tsx` or any other screen renders the same goals list redundantly now that Diagnostic's copy is gone (e.g., if Today used to say "see your full plan on Diagnostic" and that link is now dead-ended). Not a Diagnostic-file bug, but worth a fast cross-page grep before calling F-143 fully closed at the *product* level, not just the *file* level.

**N2 — `.km-diagnostic__card { margin-bottom: 4px; }` in the new `Diagnostic.css`** is a very small, slightly magic-number nudge with a comment explaining it, which is fine, but the 4px figure isn't tied to a spacing token/scale the way the rest of the design system's radii/spacing claims to be tokenized. Cosmetic only.

**N3 — Minor asymmetry**: Intro's section-list `CityCard` and Results' skills-card `CityCard` both pass `tone="accent" rail`, but the live-drill hero card passes `rail tone="accent"` (prop order swapped, functionally identical). Harmless, purely stylistic inconsistency in the JSX prop ordering across the same file.

### PRAISE

**P1 — The F-143 removal comment (Diagnostic.tsx:55–57, 1161–1165) is exemplary self-documentation**: it names the ticket, states the *reason* (user's explicit request), states *what remains* (skills snapshot + retake), and explicitly flags that `snapshot.goals` is intentionally still wired at the data layer for other consumers — this is exactly the kind of comment that prevents a future engineer from "helpfully" re-adding the card or deleting the type field.

**P2 — The F-143 test is genuinely hard to fool.** Using `POPULATED_SNAPSHOT` (goals is non-empty, with real prose: `'Drill -더라도 daily.'`) rather than an empty-goals fixture means the test would fail loudly if the removal were reverted or incomplete — it is not a vacuous "assert absence of nothing" test.

**P3 — `SubwayProgress`'s replacement of the manual progress math is a net risk reduction**, not just a reskin: the old inline `completed`/`progressNow`/`progressPct` computation was hand-rolled per page (three different pages independently computing the same clamp math); centralizing it in one audited component (with its own `Number.isFinite` NaN guards, visible in `SubwayProgress.tsx:49-56`) removes a class of copy-paste bugs.

**P4 — CSS token discipline held.** `Diagnostic.css`'s new rules use `var(--vermilion)` exclusively, which the codebase resolves per-theme (`--dan-verm` in Day, `--neon-coral` in Night, confirmed at `styles/index.css:89` and `:236`) — genuinely no hardcoded hex anywhere in the touched files, verified by grep, not just by reading the comment's claim.

## Coordination observations

- **The orphaned `styles/index.css` rules are real** (see S1) — the builder's own self-flagged concern in `Diagnostic.css`'s doc comment is accurate and should be tracked as a follow-up task, not left silently in a shared file "because it's out of scope." A shared CSS file accumulating dead per-page rules across every reskin batch will eventually become a maintenance hazard (nobody can tell which rules are live without grepping every batch's diff).
- No coordination conflicts found with `Topik.tsx`/`Progress.tsx` usage of the same shared components (`PageHubHeader`, `CityCard`, `SubwayProgress`, `SealStamp`) — prop shapes and tone conventions (`tone="accent"`, `ordinal - 1` for current station) match the established precedent exactly, so a future consistency fixpass across pages should find nothing to flag here.
- The empty-state device omission (giwa texture / hangul watermark, devices #3/#6) is correctly justified against the actual precedent in `Reading.tsx` (confirmed: `Reading.tsx` gates `.km-giwa`/`.km-hangul-watermark` to genuine empty states only, e.g. lines 367, 601, 1107, 1411) — this is not a shortcut, it's consistent application of an established rule.
