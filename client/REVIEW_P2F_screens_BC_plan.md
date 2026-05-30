# REVIEW_P2F — Screens B/C + Plan Compliance

> Independent senior reviewer (30 yrs). I did not write this code.
> Scope: Pass 2 cross-cut review of Topik, Diagnostic, Grammar, Hanja,
> Images, Reference, Settings + App.tsx rewiring + ScreenStub fate +
> CSS additions for `.km-*` namespaces + `vitest.config.ts` + `test/setup.ts`.
> Pass 2 plan-compliance table included at the bottom.

---

## Verdict

**PASS WITH CONDITIONS.**

Pass 2 lands all 11 screens behind real bodies, the hanji aesthetic is
consistent, MockBadge gating is honest, and the suite covers
loading→data + one main interaction per screen as the plan calls for.
The work is at senior-engineer caliber: threat-model docstrings on
every file, hoisted `vi.mock` factories, useEndpointOrMock keys that
distinguish snapshot vs. test fetches, `prefers-reduced-motion` on
the OCR pulse, allowlist-bounded DOM mutation in
`SettingsProvider`.

What blocks a clean PASS is small:

1. The `TESTS.md` file the prompt was asked to verify **does not exist**
   anywhere in the repo. README/SECURITY both link to it. The plan
   says it should be there.
2. Settings landed two passes ahead of schedule (plan: Pass 3 profile
   + Pass 9 prefs). The work is defensible (all local-state per the
   design README) but the deviation is undocumented.
3. A small handful of correctness/UX leaks (see BLOCKERs/SHOULD-FIX
   below) — none of them prevent shipping the next pass, but each is
   a low-cost fix worth landing before Pass 3.

---

## BLOCKERs

### B-1 — `TESTS.md` missing
- **File:** `Repository/TESTS.md` (expected; absent).
- **Evidence:**
  - `client/README.md:64,186` references `../../TESTS.md`.
  - `client/SECURITY.md:342-343` cites `TESTS.md → client-build` and
    `client-lint`.
  - `find Repository -maxdepth 3 -name TESTS.md` returns nothing.
- **Why blocker:** the Senior Engineer Bar §5 "done" criteria require
  the test surface to be discoverable; the prompt specifically asked
  this reviewer to verify the client-unit suite is referenced. Right
  now Pass 2's Vitest harness is invisible to anyone who reads only
  the docs. Two screens already shipped `*.test.tsx` files (Today,
  every Pass 2 page) and there's no entry that maps `npm run test` →
  `client-unit`.
- **Fix:** add `Repository/TESTS.md` enumerating at least
  `client-build`, `client-lint`, `client-unit` (vitest) with the
  exact invocation. Cheap; one file.

### B-2 — Diagnostic results-mode entry breaks the design's "intro by default" rule
- **File:** `src/pages/Diagnostic.tsx:67-74`.
- **Evidence:** the `useEffect` settles `mode` to `'results'` whenever
  `snap.data.dimensions.length > 0`. The mock
  (`loadDiagnosticSnapshotMock`) ships a populated snapshot, so the
  Diagnostic screen **opens directly on Results** with no way to see
  the intro layout without going through "Re-test diagnostic" first.
- **Why blocker:** the prompt's Diagnostic exit criteria says
  "4-mode state machine (intro/taking/done/results) correct. Intro
  shows numbered list of 4 sections + DoubleRule + CTAs." A user who
  navigates to /diagnostic for the first time today does **not** see
  the intro. The code does have a comment that says "real wiring
  (Pass 5) replaces this with a 404 on `/diagnostic/latest` → `intro`",
  but Pass 2 ships the mock and the mock has dimensions. The QA
  reviewer comparing side-by-side with `Korean Master.html` will not
  find a way to view Intro mode against the design.
- **Fix options:**
  - Cheapest: change `loadDiagnosticSnapshotMock` to return
    `{ dimensions: [], references: […], goals: [] }` and add a second
    `loadDiagnosticSnapshotMock_withPriorRun` fixture. Default the
    screen to `intro`. Document the "Re-test" loop as the path back
    to Intro for anyone who has run before.
  - OR: invert the gate — default to `intro` and only land on
    `results` when the URL says so (e.g. `/diagnostic?from=done`).
- **Note:** the test `lands on Results when the snapshot has prior
  dimensions` at `Diagnostic.test.tsx:109` is correct for the new
  behavior — its symmetry confirms the bug is in the **default**.

### B-3 — Settings persists `email`/`phone` channel-disable on stale state
- **File:** `src/pages/Settings.tsx:138, 154`.
- **Evidence:** the ChannelChip `disabled={!settings.email}` /
  `disabled={!settings.phone}` decision is read at render time, but
  `settings.notif.channel.email` is **not** auto-cleared when the
  user later wipes the email field. So:
  1. user types `foo@bar`, toggles Email channel ON,
  2. user erases the email field (it becomes empty),
  3. the Email chip becomes disabled (correctly), but
     `settings.notif.channel.email === true` remains true in
     localStorage and will fire as soon as any email is re-entered.
- **Why blocker:** this is the "active toggle on a missing channel"
  state the design's spec explicitly forbids ("each disabled until
  the corresponding field is filled" — implies the field must be
  filled for the toggle to STAY on, not just to BECOME on). For a
  notifications screen this is the difference between "you opted in
  recently" and "you opted in once and never opted out".
- **Fix:** when `updateSettings({ email: '' })` lands, clear
  `notif.channel.email` in the same patch (and same for phone/sms).
  One conditional in the `onChange` handler each.

---

## SHOULD-FIX

### SF-1 — Settings.tsx MockBadge unconditional vs. Today/Hanja `isMock` gating
- **File:** `src/pages/Settings.tsx:59`.
- Settings is local-state only — no `useEndpointOrMock`. The badge is
  hard-coded `<MockBadge />`. That's defensible per Pass 2 exit
  criterion 3 ("🅂 badge visible on every screen because no real
  endpoints yet"), but Pass 3 will wire `GET /auth/me` here and the
  badge needs to start gating on something. Recommend adding an
  `isMock` source now — e.g., a constant `const isMock = true` with
  a `// TODO Pass 3 — wire from useEndpointOrMock('auth-me', …)`
  comment — so the future un-mock surface is obvious.

### SF-2 — Diagnostic `fatalError` swallows non-fatal errors silently
- **File:** `src/pages/Diagnostic.tsx:77-78`.
- `fatalError = !snap.data && !test.data && (snap.error ?? test.error)`.
  If `snap.data` arrives but `test.data` errors **with the mock
  returning something**, the error path won't render — the screen
  will mount Results successfully. That's the desired UX, but the
  `error` value is never surfaced anywhere (no toast, no banner).
  Pass 3 plans Toast on error; until then the silent swallow means a
  500 from `/diagnostic/test` (Pass 5) would be invisible. Document
  the trade-off explicitly in the docstring or stash the error in a
  ref so a Pass 5 e2e can grep for it.

### SF-3 — Hanja CSS class arithmetic via string concat instead of `cn()`
- **File:** `src/pages/Hanja.tsx:243, 273-275, 376-378`.
- Every other page in scope (Topik, Diagnostic) imports
  `cn` from `../lib/cn` for class composition. Hanja uses
  bare `+` concatenation. Functionally identical, but the
  inconsistency is a paper-cut for future maintenance, and
  `cn()` handles falsy entries cleanly while the manual
  concatenation leaves a literal `" "` gap when the conditional
  is false. Use `cn()`.

### SF-4 — Diagnostic `aria-pressed` AND `aria-checked` on the same `role="radio"`
- **File:** `src/pages/Diagnostic.tsx:437-438` and `src/pages/Topik.tsx:147-148`.
- `aria-pressed` is the toggle-button ARIA. `aria-checked` is the
  radio ARIA. Putting both on the same element makes AT speak
  conflicting state (`toggle button pressed, radio button checked`).
  Pick one — for `role="radio"`, drop `aria-pressed`. This was likely
  a copy-paste from a button variant; tests in `Topik.test.tsx:90`
  even key off `aria-pressed`. Both screens are affected.

### SF-5 — Images `wordToPopover` flattens `ex_kr` to gloss; loses provenance
- **File:** `src/pages/Images.tsx:171-179`.
- The mapping sets `ex_kr: w.gloss, ex_en: w.en` — the popover's
  "example" field shows the gloss verbatim and English duplicates
  itself. The design says WordPopover has "Source/example: KR + EN"
  — without an actual example sentence the popover renders two
  copies of "beverage". Either fix the mapping to pull a real example
  from the OCR fixture (add `example_kr`/`example_en` on `OcrWord`)
  or skip the example block entirely when no example exists. The
  current mapping is dishonest.

### SF-6 — Topik `Skip` increments idx but doesn't track skipped IDs
- **File:** `src/pages/Topik.tsx:84-87`.
- Skip just bumps `idx`. No record of what was skipped. Once Pass 6
  wires `POST /topik/:itemId/answer`, the analytics layer needs to
  see skips as a real signal. Add a `skipped: Set<itemId>` now (or
  document why it's intentional that Pass-2 silently drops skip
  events).

### SF-7 — Reference `entryToPopover` lies about POS for hanja
- **File:** `src/pages/Reference.tsx:239`.
- `pos: r.kind === 'hanja' ? 'pn.' : 'n.'` — hanja is not "proper
  noun". This is just wrong. Either drop the `pos` field for hanja
  entries or pass an actual reading.

### SF-8 — Grammar default tutor note is a constant — confusing in QA
- **File:** `src/pages/Grammar.tsx:27-28, 178-180`.
- `TUTOR_NOTE` is a static string emitted on every submit regardless
  of what the user typed. QA reviewing the screen will see the same
  feedback for "asdf" and a correct answer. That's defensible for
  Pass 2 (the plan defers grading to Pass 9), but mark it visibly:
  put a `// MOCK: Pass 9 will replace with /grammar-drill/submit` on
  the line, and consider rendering "(mock feedback)" in the UI text
  itself so the demo isn't misleading.

### SF-9 — Hanja unused import `STATE_PILL_TONE['new']` typed `default`
- **File:** `src/pages/Hanja.tsx:74-78`.
- `STATE_PILL_TONE` declares `new: 'default'`. The `Pill` component's
  `tone` prop is `'gold' | 'red' | 'green' | 'ochre' | 'default'?`
  Verify `default` is a valid Pill tone (Pass 1 review noted the Pill
  variants). If it's not in the union, this triggers a TS error in
  strict mode. (I didn't read `Pill.tsx`; check.)

### SF-10 — Reference search debounce never flushes on unmount
- **File:** `src/pages/Reference.tsx:60-67`.
- `useEffect` schedules a setTimeout to set `q`; the cleanup clears
  it. If the user navigates away in the middle of typing, the last
  keystroke is lost. Settings handles this with an "unmount flush"
  effect (`SettingsProvider.tsx:145-153`). Not a correctness bug for
  Pass 2 (Reference has no persistence) but the pattern split between
  the two debounced inputs is confusing — pick one.

---

## NITs

- **N-1** `Diagnostic.tsx:174` — `0{String(i + 1)}` hard-codes a 2-digit
  format. Fine for 4 sections; will render `010` at section 10. Pad
  with `padStart(2,'0')` if the section list ever grows.
- **N-2** `Diagnostic.tsx:556` — same `0{String(i + 1)}` for goals.
- **N-3** `Grammar.tsx:121` — `Card.variant='flat'` is used for
  the reveal block but the rest of the file uses default Card.
  Inconsistent; verify the design says reveal is flat-style.
- **N-4** `Hanja.tsx:88` — `useState<ViewMode>('today')` defaults to
  `today`. Design README says Today view first; good. Worth a comment.
- **N-5** `Images.tsx:202-203` — `onFile` doesn't `e.target.value = ''`
  after read. Picking the same file twice will not re-fire `onChange`.
  Cosmetic Pass-8 issue.
- **N-6** `Images.tsx:78-80` — `pushHistory(id)` keeps `slice(0, 6)`.
  Mock fixture is one capture; if a user opens the same capture six
  times the `includes(id)` guard already dedupes. Defensible but
  document the cap.
- **N-7** `Reference.tsx:177` — `key={\`${r.kind}-${r.kr}-${String(i)}\`}`
  — including `i` defeats React reconciliation when results are
  filtered. Use a stable key (`r.id` if you add it; else `kind|kr`).
- **N-8** `Settings.tsx:264` — version string is `v0.2` hard-coded.
  Should read from `import.meta.env.VITE_APP_VERSION` or `package.json`.
- **N-9** `Settings.test.tsx:65-75` — the typing test asserts the
  input value but not the underlying settings state. Adding one
  `expect(settings.name).toBe('Jared')` via a probe child would
  tighten the contract.
- **N-10** `Topik.tsx:53` — `<span id="topik-title">` lives inside
  the `Topbar`'s `krTitle` prop, but `Topbar`'s own H1 may already
  carry an ID. Risk of duplicate IDs. Verify.
- **N-11** `App.tsx:51-86` — `SettingsProvider` wraps **outside**
  `BrowserRouter`; `AuthProvider` wraps **inside**. Verify that's
  intentional (it is — Settings is router-independent; Auth needs
  Route context for redirects). Worth a one-line comment.
- **N-12** `Diagnostic.test.tsx:161-164` — the test mutates
  `hookState.snapshot` mid-flow. Functionally fine because the next
  render re-reads the module-mocked hook, but a comment would help.

---

## PRAISE

- **P-1** Threat-model paragraphs on every file in scope. The Fixpass
  Pass 1 aggregate praised this; Pass 2 carried the convention
  through cleanly. The `Settings.tsx` paragraph in particular
  documents the XSS escape contract at the screen level.
- **P-2** `useEndpointOrMock` key includes `idx` in Topik so a future
  per-item refetch works without rewriting the hook (`Topik.tsx:39-42`).
  Same shape on Diagnostic's snapshot vs. test keys.
- **P-3** `vi.hoisted` used correctly in Hanja/Images/Reference tests
  with an explanatory comment about the TDZ issue. This is a real
  trap and the comment will save the next reader 20 minutes.
- **P-4** `Hanja.tsx:436-450` only colours the **studied** glyph in a
  compound vermilion, matching the design exactly. The
  `Array.from(c.han).map(...)` pattern is the right way to do this in
  JSX (codepoint-aware split, no innerHTML).
- **P-5** OCR pulse animation in `index.css:2864-2883` includes a
  `prefers-reduced-motion` block. The prompt asked for it; it's there.
- **P-6** `Diagnostic.tsx` separates `IntroBlock`, `TakingBlock`,
  `DoneBlock`, `ResultsBlock` into named sub-components in one file.
  Reads exactly like the design's mode machine.
- **P-7** `Settings.tsx` reads/writes via `useSettings()` and never
  shadows it with local form state — every keystroke flows through
  the Provider, the Provider debounces. This is the right shape for
  Pass 9 server-sync.
- **P-8** `Reference.tsx:71-86` memoises `items` to give the filter
  memo a stable dependency. Most reviewers miss this; this author
  didn't.
- **P-9** `App.tsx` correctly composes:
  `ErrorBoundary > Theme > Settings > Router > Auth > Routes`.
  Auth inside the router (needs `useNavigate`); Settings outside the
  router (router-independent). Right call.
- **P-10** `ScreenStub.tsx` left in the repo with no live imports —
  the right call. Could be deleted at Pass 3 cleanup once we're
  certain no future screen will regress to a stub.

---

## Plan compliance

| Pass 2 exit criterion | Status | Evidence / note |
|---|---|---|
| Side-by-side with `Korean Master.html`, every screen matches color/type/spacing/corner radius | **PARTIAL** | I did not run the dev server. Token block fidelity confirmed at the CSS level (radii 2/3/4px, vermilion `#B83A2E`, hanji surfaces, double rule, seal stamp). The Diagnostic Results mode is the one I can't QA visually because the **screen defaults to Results, not Intro** (B-2) — so Intro never renders in a fresh boot. Hanja Today view's HanjaFeature card includes the corner seal, 140×140 TianGrid square, 96px char, gold rule, compound chips — matches `screens-c.jsx`. Images CaptureView includes overlay boxes with vermilion + pulse + reduced-motion. Settings has the three group cards with vermilion-soft icon squares. |
| All 11 screens populated; no `ScreenStub` left | **PASS** | `grep -rn ScreenStub src/` returns only the file itself plus docstring references. `App.tsx:35-45` imports every real screen; routes map 1:1. No live `<ScreenStub>` element anywhere. |
| 🅂 MockBadge visible on every screen (because no real endpoints yet) | **PASS** | Topik/Diagnostic/Grammar/Hanja/Images/Reference all gate `<MockBadge />` on `isMock` from `useEndpointOrMock`; the hook returns `isMock: true` on mock-fallback. Settings renders `<MockBadge />` unconditionally (defensible for Pass 2; flagged SF-1 for Pass 3 handover). Today/Reading/Review/Chat — out of this review's scope; trust they conform. |

**Overall:** PASS WITH CONDITIONS (PARTIAL on criterion 1 driven by B-2).

---

## Plan deviations

### D-1 — Settings shipped two passes ahead (PARTIAL acceptable)
- **Plan says:** Settings goes live in *Pass 3 (profile) + Pass 9 (prefs)*.
  Pass 2's screen list at `CLAUDE_DESIGN_INTEGRATION_PLAN.md:107` does
  include "Settings — Profile/Notifications/Appearance group cards
  + SwatchPicker for each palette dimension" as a screen to fill,
  but the wiring (`/settings/prefs`, `/auth/me`) was reserved for
  later.
- **What shipped:** Settings is fully interactive — every input
  binds to `useSettings()` and persists to `localStorage` via the
  Provider's 200ms debounce. Palette presets project to CSS vars on
  `<html>` immediately.
- **Verdict:** **DEFENSIBLE.** Pass 2's exit criteria explicitly
  require all 11 screens populated. The plan's wiring split into
  Pass 3 / Pass 9 is about *server sync* — that's still parked, and
  the screen ships in mock mode with the `<MockBadge>` showing.
  Pass 9 will add `GET /settings` / `PUT /settings` and convert the
  Provider's persist target from `localStorage` to "localStorage AND
  server". No work to undo. Document this in the next
  `/project-checkpoint`.

### D-2 — Grammar drill UI shipped with hard-coded tutor note
- **Plan says:** Pass 2 should ship "Grammar — production drill UI
  mock (no AI scoring yet)". Pass 9 lands `POST /grammar-drill`.
- **What shipped:** Grammar.tsx ships a constant `TUTOR_NOTE` string
  emitted on every submit. That's mock UI as planned, but with no
  visible "this is mock" cue beyond `<MockBadge>`. See SF-8.
- **Verdict:** **WITHIN PLAN** — but tightening per SF-8 will help.

### D-3 — Diagnostic mode-resolution effect contains an ESLint disable
- **File:** `Diagnostic.tsx:72-74` and `Images.tsx:71-73`.
- Both files use `// eslint-disable-next-line
  react-hooks/set-state-in-effect`. The plan is silent on this rule;
  the comment explains why it's needed. Fine. **WITHIN PLAN.**

### D-4 — No `Repository/TESTS.md` (blocker)
- **Plan says:** every component finishes Pass 1 with a `TESTS.md`
  entry (per Senior Engineer Bar §5 "done"). The README and
  SECURITY.md already cite it. Pass 1 should have shipped it; Pass 2
  inherited the gap. See B-1.

### D-5 — Out-of-scope items confirmed parked
- Verified against `CLAUDE_DESIGN_INTEGRATION_PLAN.md` "Out of scope"
  list (lines 262-269):
  - No domains-tracks UI **(✓ absent)**
  - No HTSLANS Whisper transcription **(✓ absent)**
  - No server-side push/email/SMS senders **(✓ Settings only persists
    intent to localStorage)**
  - No native wrappers **(✓ PWA only)**
  - Single-user assumption **(✓ no user-id branching anywhere)**

---

## Cross-cutting observations

1. **Pass 2 lives entirely on local state + `useEndpointOrMock`.**
   That's exactly what the plan asks for. No premature wiring leaked
   in.
2. **The `AbortController` plumbing in `useEndpointOrMock` is solid
   under StrictMode.** Same Pass-1 praise applies in Pass 2: every
   screen indirectly inherits abort-on-unmount for free.
3. **CSS class namespacing is honest** — every `.km-{screen}__*`
   prefix is unique; no Pass 1 token regressions. Spot-checked
   `index.css:1387-1490` (Topik), `1490-1750` (Diagnostic),
   `2864-2883` (Images OCR pulse + reduced-motion).
4. **Test fixtures are minimal-by-design** (2 items each). Keeps
   tests fast. Praised.
5. **Diagnostic radio/button ARIA double-attr (SF-4) appears in two
   files** — likely a copy-paste from a Pass 1 button choice. Easy
   single-PR fix.

---

## Recommendation

Dispatch one fix-pass agent against:

- **All 3 BLOCKERs**: B-1 (add `Repository/TESTS.md`), B-2
  (Diagnostic default-mode), B-3 (Settings channel-disable
  consistency).
- **Top 4 SHOULD-FIX**: SF-1 (Settings mock badge gate),
  SF-4 (ARIA double-attr in Topik + Diagnostic),
  SF-5 (Images popover example mapping),
  SF-7 (Reference hanja POS).
- **Cheap-while-in-file**: SF-3 (Hanja `cn()`),
  SF-8 (Grammar tutor-note mock label),
  SF-9 (Hanja Pill tone TS check),
  N-7 (Reference key stability), N-11 (App.tsx provider comment).

The rest are NITs for a later cleanup pass.
