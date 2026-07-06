# Review — tester-sweep batch A (`fix/sweep-batch-a`, commit `2c0816b`)

**Reviewer:** independent senior reviewer (read-only). Did not write this code.
**Scope:** 5 client fixes from `git diff HEAD~1` — badge contrast (#3), blank example (#5),
empty-Highlights default tab (#4), Progress/Today copy (text). Cross-referenced against
`db/docs/SWEEP_LISTEN.md`, `SWEEP_PROGRESS_TODAY.md`, `SWEEP_REVIEW_TOPIK_REF.md`, and
`/home/jared-williams/projects/SENIOR_ENGINEER_BAR.md`.

Full client suite: `npx vitest run` → **592/592 pass** (61 files). `Ttmik.test.tsx` alone → 12/12 pass.

---

## Verdict

| # | Fix | Verdict |
|---|-----|---------|
| 3 | Badge contrast (`Progress.css`) | **PASS** — verified with real hex contrast math, both themes, all 4 buckets |
| 5 | Blank example (`WordPopover.tsx`) | **PASS** — traced every production data source; no path can hide a real example |
| 4 | Empty-Highlights tab (`Ttmik.tsx`) | **BLOCKER** — see below |
| — | Progress/Today copy | **PASS** — text and pluralization logic both correct, but ships untested |

**Overall: do not merge as-is.** Fix #4 introduces a real ESLint error that fails the CI lint gate
(`npm run lint`, `.github/workflows/ci.yml:29-30`), and the underlying pattern (deriving state from
`useEffect` instead of computing it during render) produces a genuine, reproducible one-frame
mis-render — an ARIA-invalid tablist paired with the wrong panel — on exactly the ~14%-of-catalog
case (32/232 lessons) this fix was written to solve. Fixes #3, #5, and the copy changes are correct
and ready to ship independently.

---

## Findings

### BLOCKER

**B1 — New effect in `Ttmik.tsx` fails `react-hooks/set-state-in-effect`; breaks `npm run lint` (CI gate).**
`client/src/pages/Ttmik.tsx:748-756`. Ran `npx eslint src/pages/Ttmik.tsx`:
```
754:7  error  Error: Calling setState synchronously within an effect can trigger cascading renders
react-hooks/set-state-in-effect
```
Confirmed this is newly introduced, not pre-existing: `git show HEAD~1:client/src/pages/Ttmik.tsx`
has no such block at all, and linting the HEAD~1 copy is clean. `.github/workflows/ci.yml:29-30` runs
`npm run lint` (= `eslint .`) as a blocking job with no `|| true` — an ESLint **error** (not warning)
fails that step. This is not a style nit; it is the same class of violation
`SENIOR_ENGINEER_BAR.md` §2.2 [P1] names directly: *"`useEffect` is for syncing with external systems
only — not for deriving state (compute during render)."* `lessonTab`'s "correct default given this
lesson's data" is exactly the kind of value that should be computed during render, not patched in
after the fact via `setState` inside an effect.

**B2 — The effect+filter combination mis-renders for one frame on every lesson it targets (the ~14% case), and the new test can't see it.**
Trace of the real render sequence for a 0-highlights/N-transcript lesson (the exact case #4 is fixing):
1. `loadDetail(...).then(detail => { setData(detail); setLoading(false); })` — both `setState` calls
   are batched into **one** commit. On that commit: `data` is set, `loading` is false, but `lessonTab`
   is *still* `'highlights'` (untouched this render — the correction only happens in a *later* effect
   flush).
2. On that commit, `LESSON_TABS.filter(...)` (`Ttmik.tsx:815-819`) already sees `orderedHighlights.length
   === 0`, so the Highlights **button is not rendered at all** — only a lone "Transcript" button
   renders. Its `aria-selected` is `lessonTab === 'transcript'` → **false** (because `lessonTab` is
   still `'highlights'`). Result: a `role="tablist"` with exactly one tab, and that tab is unselected —
   an invalid ARIA tablist state (a tablist must have exactly one selected tab).
3. The panel switch (`Ttmik.tsx:838`) is `lessonTab === 'highlights' ? <HighlightsPanel .../> : ...` —
   still `'highlights'` on this same commit, so it renders `<HighlightsPanel rows={[]}>`, which shows
   **"No highlights for this one."** — the exact confusing empty state the fix exists to avoid.
4. Only on the *next* commit (after the `useEffect([data])` passive effect fires and calls
   `setLessonTab('transcript')`) does the UI correct itself to the intended state.

Per React's own documented effect-timing model, passive effects for an update *not* caused by a
direct user interaction (this one is caused by an async fetch resolving) generally run **after** the
browser has painted — i.e., the browser gets a real chance to paint the intermediate,
self-contradictory state in step 2-3 before it snaps to correct. This is not a contrived edge case:
it is the primary case the fix targets (32/232 real lessons per `SWEEP_LISTEN.md`), so a tester
opening any one of those 32 lessons is likely to see a flash of an unselected lone tab over a "No
highlights" panel before it corrects to Transcript. The app also wraps the tree in `<StrictMode>`
(`client/src/main.tsx:15`), which double-invokes effects in dev — the environment a friend-tester
running `npm run dev` would actually be using — making the inconsistent intermediate state *more*
likely to be visible, not less.

The new test (`Ttmik.test.tsx` "a lesson with no Highlights opens on Transcript…") only asserts the
**settled** state after `await openLessonOne(user)` — Testing Library's `act()` flushes pending
effects synchronously within the same act cycle, so the test structurally cannot observe the
intermediate frame described above. It is a legitimate assertion of the *final* state, but it gives
false confidence that the fix is clean end-to-end; it does not exercise the actual risk this task
flagged as hardest to verify.

**Fix direction (not applied — read-only review):** compute the effective/default tab as a plain
derived value during render (e.g. `const effectiveTab = lessonTab === 'highlights' &&
orderedHighlights.length === 0 && orderedTranscript.length > 0 ? 'transcript' : lessonTab`, and render
off `effectiveTab`, while `onClick` still calls `setLessonTab` so a manual pick is respected) instead
of `setState` inside `useEffect`. This removes both the lint error and the extra render/flash — no
effect, no intermediate DOM, single commit lands on the correct tab.

### SHOULD-FIX

**S1 — Degenerate 0-highlights/0-transcript lesson: empty `tablist` + wrong empty-state message.**
`Ttmik.tsx:815-819`, `838-850`. If a lesson has *both* `highlights.length === 0` and
`transcript.length === 0`, `LESSON_TABS.filter(...)` returns an empty array — the `role="tablist"`
renders with **zero** `role="tab"` children (an ARIA-invalid empty tablist widget). The new
`useEffect`'s condition requires `transcript.length > 0` to fire, so for this case it does **not**
fire, and `lessonTab` stays at its default `'highlights'` — so the panel below renders
`<HighlightsPanel rows={[]}>` → "No highlights for this one," which is misleading (the lesson has no
*transcript* either; the message doesn't say so). Not a crash, and `SWEEP_LISTEN.md`'s closest
documented case (Level 9 Lesson 5) actually has 1 transcript row (a stray page-footer artifact), not
0, so this exact 0/0 shape may not currently exist in the corpus — but nothing in the code defends
against it, and `SENIOR_ENGINEER_BAR.md` §5.2 calls out exactly this class of boundary (`0, 1, n,
n+1, empty`) as required coverage. Add a guard: when both lists are empty, render a single
"No content for this lesson yet" state instead of an empty tablist + a Highlights-flavored message.

**S2 — Today's new singular/plural branch ships with no regression test.**
`client/src/pages/Today.tsx:242,247-248`. I hand-verified the logic is correct — both the
`aria-label` and the visible label branch on `reviewCount === 1`, and the JSX
`{count}{' '}\n{ternary} due` renders as a single, correctly-spaced string ("1 card due" / "24 cards
due") because the explicit `{' '}` supplies the space that JSX's whitespace-collapsing would
otherwise strip between the count and the newline-indented ternary. But `Today.test.tsx` only ever
mocks `reviewCount: 24` (`Today.test.tsx:57`) — there is no test asserting the `reviewCount === 1`
branch (either the visible text or the `aria-label`) renders "card" not "cards". Per
`SENIOR_ENGINEER_BAR.md` §5.2 [P0]: *"Every bug fix ships with a regression test that fails on the old
code — non-negotiable."* This one didn't. Low risk (verified correct by hand) but a real process gap.

### NIT

**N1 — "New" bucket badge relies on a near-invisible border, unlike the other 3 buckets.**
`Progress.css:333-335` gives `.is-learning/.is-reviewing/.is-mastered` a solid colored border, but
there is no `.km-mastery__badge.is-new` rule, so the "New" badge falls back to the base
`border: 1px solid var(--line)` — a faint hairline (`rgba(27,24,19,0.10)` light /
`rgba(239,231,208,0.08)` dark). The bucket is still identified by its text label ("New"), so this
isn't a WCAG 1.4.1 (color-alone) violation, but visually the 4 buckets aren't equally
color-differentiated. Pre-existing (not introduced by this diff) — the diff only changed the base
badge's text color, not this border gap.

**N2 — Fix #3's code comment cites "3.1–4.3:1" but the base (New/`paper-mute`) badge also failed AA
(4.12:1) before this fix**, per `SWEEP_PROGRESS_TODAY.md`'s own numbers. The fix still correctly
covers it (the base selector's `color` changed unconditionally), so this is purely a comment-accuracy
nit, not a functional gap.

**N3 — "Read/Listen" → "Listen" copy fix (`Progress.tsx:824-826`) has no dedicated regression test**
(`Progress.test.tsx:346` matches `/No vocab cards yet/`, a substring that doesn't pin the trailing
copy either way). Trivial two-word copy change, very low risk — noting only for completeness against
the same "every fix needs a regression test" bar as S2.

### PRAISE

**P1 — Fix #5 (blank example) is provably safe against every real production data source**, not just
the one fixture in the new test. Traced both callers that ever populate `WordPopoverData`:
- `client/src/lib/tapChain.ts:188-197,212-213` (`buildWordPopover`, the Read/Listen tap-anything path)
  — every `VocabExample` pushed into the `examples` array is filtered through `textOrNull(ex.korean)`
  first (`kr === null` entries are dropped, never partially added), so `primary?.kr` is either a
  real non-empty string or `primary` itself is `undefined` (in which case `ex_en` is also forced to
  `''`). There is no code path where `ex_en` is populated while `ex_kr` is empty.
- `client/src/pages/Images.tsx:321-332` (`wordToPopover`, the OCR path) sets `ex_kr: w.gloss`, which
  the server (`server/src/routes/images.ts:362`) can legitimately coerce to `''` when Claude's OCR
  vision call omits a gloss (`gloss: z.string().max(800).optional()` per
  `server/src/services/claude/models.ts:274`). When that happens there genuinely is no caption to
  show, and `ex_en: w.en` is a duplicate of the `en` field already rendered as the popover's lede —
  so hiding the Example section here loses no information.
- The `kind: 'grammar'` branch (`ex_kr` always populated in its one real construction site, the test
  fixture) is unaffected, and is otherwise currently unreachable from any production caller
  (`kind: 'grammar'` is never set outside of `*.test.tsx`/`data/mocks/*` — a pre-existing gap, not
  introduced by this diff, worth a backlog note if the Grammar bank is meant to route through this
  popover).
- The new test (`WordPopover.test.tsx:143-157`) is a genuine pre-fix failure: reverting just the JSX
  change would still render the "Example" eyebrow unconditionally, so `queryByText('Example')` would
  find it — confirmed by reading the pre-diff JSX (`git diff HEAD~1`), not merely assumed.

**P2 — Fix #3 (badge contrast) verified by hand with actual sRGB relative-luminance math**, both
themes, all three named buckets: light-theme `--ochre` on `--ink-1` = **3.15:1**, `--moss` = **4.34:1**
(both fail WCAG AA 4.5:1 for 11px/non-large text, matching the sweep doc's own numbers almost
exactly). Post-fix, `--paper` on `--ink-1`/`--ink-2` is **~13–16:1** in both themes (it's the app's
primary body-text ink, used everywhere) — comfortably clears AA with headroom, and does so for the
"New" bucket too since the change is on the shared base selector. Color-coding is preserved via the
border (still full-saturation accent) plus the text label, so meaning is never conveyed by color
alone (WCAG 1.4.1). Comment accurately cites the F-013 precedent — verified `Progress.css:269`
(`.km-mastery__chip`) uses the identical `color: var(--paper)` pattern already.

**P3 — Comment quality throughout this diff is genuinely excellent**: every changed block explains
*why*, cites the specific bug/percentage/precedent, and several comments (F-013 cross-reference, the
"~4%"/"~14%" corpus stats) were independently verified against the sweep docs and found accurate.

---

## Detailed (file:line)

- `client/src/pages/Progress.css:321-335` — badge contrast fix. Correct, both themes, all 4 buckets (N1/N2 are nits only).
- `client/src/components/WordPopover.tsx:229-241` — blank-example guard. Correct; see P1.
- `client/src/components/WordPopover.test.tsx:143-157` — new regression test; confirmed genuine (fails pre-fix).
- `client/src/pages/Ttmik.tsx:748-756` — **BLOCKER B1/B2**: `useEffect` derives `lessonTab`; fails `eslint react-hooks/set-state-in-effect`; produces a one-commit mis-render on the targeted 14% case.
- `client/src/pages/Ttmik.tsx:815-819` — tab filter; correct for the "some highlights + some transcript" and "0 highlights + N transcript" cases; see S1 for the 0/0 case.
- `client/src/pages/Ttmik.tsx:838-850` — panel switch keyed on raw `lessonTab`, not a derived/clamped value — the proximate cause of B2.
- `client/src/pages/Ttmik.tsx:780-806` — persistent `<audio>` element, rendered unconditionally above the tab subtree, untouched by this diff — confirmed the "same audio element across sub-tab switches" contract still holds (also confirmed by the existing passing test).
- `client/src/pages/Ttmik.test.tsx:260-281` — new test; passes, but see B2 (cannot observe the intermediate render `act()` collapses).
- `client/src/pages/Progress.tsx:824-826` — "Read/Listen" → "Listen" copy; accurate (no "Read" tab exists — confirmed via `client/src/lib/nav.ts`). See N3.
- `client/src/pages/Today.tsx:242,247-248` — singular/plural; logic correct (hand-traced JSX whitespace behavior). See S2.

---

## Commands run (read-only)

```
git diff HEAD~1 --stat / -- <files>
git show HEAD~1:client/src/pages/Ttmik.tsx   # confirm B1/B2 are newly introduced
npx eslint src/pages/Ttmik.tsx src/components/WordPopover.tsx src/pages/Progress.tsx src/pages/Today.tsx
npx vitest run src/pages/Ttmik.test.tsx      # 12/12 pass
npx vitest run                               # 592/592 pass, 61 files
```
No files were modified, committed, or pushed.
