# REVIEW_P2C — Pass 2 settings substrate

> Independent senior review (30 yrs). Reviewer did NOT write this code.
> Scope per the dispatcher: `palette-presets.ts`, `settings.ts`,
> `settings.test.ts`, `settings-context.ts`, `SettingsProvider.tsx`,
> `SettingsProvider.test.tsx`, `useSettings.ts`, `SwatchPicker.tsx`,
> `SwatchPicker.test.tsx`, `App.tsx` (Provider position),
> `src/styles/index.css` (`.km-swatchpicker*` rules).

## Verdict

**PASS WITH CONDITIONS.** The substrate is clean, faithfully ported from
`shared.jsx`, and meets the engineering bar on the file split, type
safety, and tests. The provider/hook/context three-file split (FIXPASS
A-P4 PRAISE) is preserved. There is exactly **one BLOCKER** (the
prompt's own gating question: SECURITY.md was not updated for the new
settings I/O surface), a small batch of SHOULD-FIXes around the flush
semantics, the cross-tab story, and one a11y improvement on the
SwatchPicker — none big enough to back out the substrate.

| Category   | Count |
|------------|------:|
| BLOCKER    |     1 |
| SHOULD-FIX |     7 |
| NIT        |     8 |
| PRAISE     |    11 |

---

## BLOCKER

### B1 — `client/SECURITY.md` has no `§ Settings substrate` section
**Files:** `client/SECURITY.md` (no diff); `src/hooks/SettingsProvider.tsx:13-29`;
`src/lib/settings.ts:13-23`.
**Symptom.** Pass 1 closed `D-B1` by promoting threat-model paragraphs
from each new surface into `client/SECURITY.md`. Pass 2 ships a brand
new I/O surface — `localStorage["km.settings"]`, JSON parse of attacker-
modifiable bytes on every load, an inline-style write loop that mutates
the document root — and the threat models live only as code comments.
Grepping the file confirms it has no `Settings` mention beyond the
contract text in §1 and no new entry in §1's surface table.

Per `SENIOR_ENGINEER_BAR.md §2` (last bullet) and the contract block at
the top of `SECURITY.md` itself ("This file is the contract … if the
two diverge, **this file wins**"), the comments are now the divergent
party. A future hardening reviewer reads `SECURITY.md` and sees no
mention of the LS surface — a regression risk the moment someone moves
the threat model out of the file header.

**Required fix (no code change to substrate):**
1. Add row 10 to §1's table — `Settings persistence + palette projection`
   → `src/lib/settings.ts`, `src/hooks/SettingsProvider.tsx`.
2. Add a new section (suggest `§ 18` — slot in before "Pointer index"):
   - **LS corruption** — `loadSettings` is total, falls back to
     `DEFAULT_SETTINGS`, never throws.
   - **LS quota** — `saveSettings` swallows `QuotaExceededError` with a
     `console.warn`; in-memory state remains authoritative.
   - **DOM property pollution** — bounded by `ALLOWED_VARS` allowlist
     in `SettingsProvider.tsx:62-88`; preset `vars` are constants,
     never user-controlled. State the invariant explicitly so a future
     "drive preset vars from server" PR can't quietly break it.
   - **Cross-tab race** — explicitly deferred to Pass 9 (mirror the
     `FU-NF-*` ticket pattern; suggest `FU-NF-19`).
   - **Sensitive data** — `name/email/phone` are PII; document that
     they live in cleartext LS today (acceptable for single-user
     local-first app), and that this is the surface a future device-
     loss threat must reckon with.
3. Cross-reference from the file headers of `settings.ts` and
   `SettingsProvider.tsx` ("see `SECURITY.md §18`").

This is the same shape as the Pass 1 fix-pass for `api.ts` /
`AuthProvider.tsx` — promote, do not rewrite.

---

## SHOULD-FIX

### S1 — `resetSettings` is not a "persist now" — it leans on debounce
**File:** `src/hooks/SettingsProvider.tsx:171-173`.
**Behaviour.** `resetSettings` calls `setSettings(DEFAULT_SETTINGS)`. The
documented contract on `SettingsContextValue.resetSettings` is **"Reset
to `DEFAULT_SETTINGS` and persist."** (`settings-context.ts:31`). The
implementation only schedules the debounce — if the user clicks Reset
and the tab is closed within 200 ms (a common pattern: "Reset → close
the Settings sheet → close the tab"), the LS blob is never updated.
The unmount-flush effect only runs when the *Provider* unmounts, not
when a sheet/route closes.

**Recommended fix.** Either (a) call `saveSettings(DEFAULT_SETTINGS)`
synchronously inside `resetSettings` and clear the timer, or (b)
expose a `flushSettings()` method on context and call it from
`resetSettings` (and from the Settings screen on close). Option (a) is
the simplest and matches the "and persist" promise verbatim. The 200 ms
debounce was justified for keystrokes; Reset is a single deliberate
action and deserves a synchronous write.

### S2 — `pickString` accepts empty strings as valid
**File:** `src/lib/settings.ts:92-94, 124-127`.
**Issue.** `pickString` only checks `typeof v === 'string'`. A stored
`palette.paper: ""` round-trips back as `""`, then `paletteVars` looks
up `PAPER_PRESETS[""]` → `undefined`, the paper section silently drops
out of the CSS-var dict, and the user sees only accent/correct/wrong
applied over the prior surface tokens. The fall-through is graceful
(no crash) but is the kind of "silent wrong palette" bug that costs
support time later.

Either: (a) tighten `pickString` for palette keys only — verify the
string is a known key of the corresponding `PresetMap` — or (b) accept
any string but have `paletteVars` fall back to `DEFAULT_SETTINGS.palette.<x>`
when the key is not present in the map. (b) is the smaller change and
keeps `pickString` general; the test at `settings.test.ts:142-155`
already proves the current behavior is "drop the section" — change the
expectation to "fall back to default preset" along with the fix.

### S3 — Unmount-flush effect closes over a stale `persistTimerRef.current`
**File:** `src/hooks/SettingsProvider.tsx:145-153`.
**Subtle bug.** The unmount-flush effect has `[]` dep array, so its
cleanup captures the ref instance — that part is fine (refs are stable).
The issue is **the cleanup only flushes when there *is* a pending
timer**: `if (persistTimerRef.current !== null) { … saveSettings(…) }`.
If the user updates settings, the debounce fires *successfully* (writes
to LS, sets `persistTimerRef.current = null`), then the user
immediately closes the tab — the unmount cleanup sees `null` and
correctly *doesn't* re-write. Good.

The actual hazard: if `saveSettings` *just got called* and the in-memory
state has changed *between* the debounce firing and the unmount, the
intermediate state is lost. Sequence:
- t=0: setSettings(A) → timer T1 scheduled.
- t=200: T1 fires, saves(A), persistTimerRef = null.
- t=210: setSettings(B) → timer T2 scheduled.
- t=220: Provider unmounts.

At t=220, the React commit order runs: the cleanup of the prior
debounce effect (no return — nothing to do) then the `[]` cleanup
sees `persistTimerRef.current = T2 ≠ null` → clears T2 → `saveSettings(B)`.
That's actually correct. So this is **not a bug, but** the comment
block at `:141-144` is right that "the cleanup isn't re-armed on every
settings change" while the implementation **relies on** that for
correctness. Recommend adding the worked example above to the comment so
the invariant is documented, not just observed.

(Promoting to S3 because the next maintainer is likely to "simplify" the
two-effect split into one and silently break the unmount-flush.)

### S4 — `applyPaletteVars` never clears old keys → stale tokens stick on preset deletion
**File:** `src/hooks/SettingsProvider.tsx:92-111`.
**Documented but real.** The comment at `:92-104` is honest: "stale
value can only persist if a preset was deleted from the maps
mid-session (not a real-world flow)." That's true today, but it's also
true that a future refactor that splits a preset (e.g., correct's
`--green-light` removed because it's redundant) will silently leak the
old value forever for users who had that preset selected before the
upgrade. The cost of a defence here is one extra loop pass against the
prior-vars `Map`.

Recommend: in `SettingsProvider`, keep a `prevAppliedRef = useRef<Set<string>>(new Set())`;
on each `applyPaletteVars`, compute the new key set, call
`removeProperty` for any key in `prev \ new`, then `setProperty` for
the new set. Cheap, robust, and means the `ALLOWED_VARS` list (which
must also be a closed superset) can be relaxed to a `Set` derived from
the four `PresetMap`s at module load. Or leave it — but then document
the deletion-blast-radius as a forbidden change in a comment on each
`PresetMap` definition.

### S5 — SwatchPicker — Space/Enter activation isn't implemented
**File:** `src/components/SwatchPicker.tsx:78-104`.
**Issue.** WAI-ARIA APG for radio groups says Space activates the
currently-focused radio. Today only click and the arrow keys move
selection; if a keyboard user lands on a non-selected radio via some
other path (e.g., focus is restored after a re-render) and presses
Space, nothing happens. The buttons are `type="button"` so they don't
submit, but Space normally fires a click on `<button>` — that does work
here, *but* the click handler only calls `onSelect` when `!isSelected`,
which is fine for selection. The real gap is **Enter on a non-selected
radio**: standard radio behaviour is to select the focused one, and
that needs an explicit case in `onKeyDown` for safety against future
`button` → `div` refactors.

Add `case ' ':` / `case 'Enter':` → `e.preventDefault();
onSelect(ids[/* current focused index from a focusedIdx ref */]);`.
Cheap. Adds one test: focus a non-selected radio, press Enter, assert
selection moves.

### S6 — Provider position vs `BrowserRouter` looks fine, but `useSettings` cannot read route — flag for Pass 3
**File:** `src/App.tsx:48-89`.
**Observation.** Order is `ErrorBoundary → ThemeProvider → SettingsProvider → BrowserRouter → AuthProvider → Routes`. Putting `SettingsProvider`
*outside* `BrowserRouter` is correct for Pass 2 (settings have no
route dependency, and a route change should never tear the provider
down). It also means that as soon as someone in Pass 3 wants
`useLocation` inside the settings persistence hook (e.g., "if we're on
/settings, flush immediately"), they have to either move the provider
or expose `flushSettings`.

Not a bug. Note this in the file header so the next pass doesn't break
the ordering by accident. Suggest: add a one-line comment at
`App.tsx:51` — "SettingsProvider is intentionally outside BrowserRouter:
settings have no route dependency, and a route change must not unmount
the provider."

### S7 — `SwatchPicker` arrow-key behaviour conflates focus and selection
**File:** `src/components/SwatchPicker.tsx:64-76`.
**WAI-ARIA APG nuance.** The current `moveFocus` calls `onSelect`
*and* `focus()` together. For radio groups, this is the "select-on-
focus" pattern, which is APG-compliant when `aria-activedescendant`
isn't in use. **However**, calling `onSelect` on every Arrow press
means a keyboard user dragging through 4 swatches generates 4 state
updates → 4 palette re-applications → 4 setProperty bursts on
`document.documentElement`. The debounce on persistence absorbs the LS
hit, but the visual palette flips 4 times in ~80 ms. On mobile that's a
visible strobe.

Two options:
- (a) Decouple focus from selection: arrows just move focus, Space/Enter
  commits. This breaks the APG "select-on-focus" pattern (less
  conventional, slightly worse a11y).
- (b) Keep select-on-focus but throttle the *visual* application: in
  `SettingsProvider`, apply palette vars on `requestAnimationFrame`
  instead of synchronously in the effect. Cleanest.

(b) is the right answer; debounce isn't appropriate (the user expects
to see each swatch's preview *immediately on focus*; the cost is the
4× write while the key is held). Coalesce to one rAF, which collapses
the burst to the last value.

---

## NIT

- **N1** — `palette-presets.ts:22-29`: `PresetMap = Readonly<Record<string, Preset>>`
  is wider than necessary. Each category is a *closed* set; consider
  exporting a literal union type per category (`type PaperPresetId = 'hanji' | 'ivory' | 'linen' | 'sumi'`)
  so `PaletteSettings.paper: PaperPresetId` becomes self-validating.
  YAGNI today but cheap to add.
- **N2** — `settings.ts:33`: comment says "bump only on shape break"
  but there's no schema version field. If you bump the key
  (`km.settings.v2`), old data is silently abandoned. Suggest a
  `__v: 1` field inside the blob now, even if unused, so Pass 9's
  server-sync migration has a hook.
- **N3** — `SettingsProvider.tsx:127-130`: `settingsRef` update effect
  doesn't need its own effect — `useRef` + assigning in a render-phase
  inline (via `useMemo` or a render-phase write) is the documented
  React pattern. Current code is fine; just one extra commit per
  settings change. Not worth fixing alone, would be worth it if
  refactored alongside S3 / S4.
- **N4** — `SwatchPicker.tsx:59`: `useRef<Map<string, HTMLButtonElement>>(new Map())`
  creates a fresh `Map` per render of the SwatchPicker — wait, no, `useRef`
  initialiser runs once. OK. **Real nit:** the ref callback at
  `:136-139` writes to the ref on *every* render. Switch to a stable
  callback returned by `useCallback` keyed on `id` if you ever profile
  this. Today, fine.
- **N5** — `settings.test.ts:88-91`: the "round-trips" test sets
  `palette: { paper: 'sumi', accent: 'plum', correct: 'pine', wrong: 'amber' }` —
  no Korean preset keys appear in the test for palette. Add a
  `paletteVars` test that confirms `sumi` flips the surface to dark and
  no `accent`-only preset can re-introduce light surface tokens. (This
  is the "later wins" guarantee the prompt asks for; current ordering
  tests cover `--danger` only.)
- **N6** — `SettingsProvider.test.tsx:36`: `document.documentElement.removeAttribute('style')`
  cleanup is fine but assumes nothing else writes to `<html>` style.
  ThemeProvider writes `data-theme` (attribute, not style). Safe today,
  but a `beforeEach` snapshot would be more robust if other Pass 2
  tests start writing styles.
- **N7** — `SwatchPicker.tsx:46-54`: `last?: boolean` flag is a UI knob
  that the parent already knows about (the parent renders the four in
  sequence). Either drop it and rely on `:last-child` CSS, or document
  why it's an explicit prop (CSS would simplify).
- **N8** — `index.css:557-637`: the swatchpicker block is solid; the
  selected-ring `box-shadow` at `:632` is one-for-one with the design
  spec (README "Selected swatch ring" shadow). One missing piece — the
  spec says "selected swatch has a paper-colored ring", and dark theme
  inverts `--paper` to cream; the box-shadow uses `--paper` so it works
  in both themes. Good — but no test verifies this. Add a Sumi-theme
  visual snapshot in Pass Final.

---

## PRAISE

- **P1** — `palette-presets.ts`: verbatim port of `shared.jsx`
  ordering and hex values. No "tidying", no rounding, no implicit
  conversion. The header comment even tells the next maintainer **not**
  to tidy. Excellent discipline.
- **P2** — `settings.ts:88-98`: `isRecord` / `pickString` / `pickBool`
  guards. Total functions over `unknown`, no `as` casts, no `any`. This
  is the right shape for parsing untrusted JSON.
- **P3** — `settings.ts:137-148`: `loadSettings` swallows everything —
  corrupt JSON, missing key, `localStorage` unavailable (private mode,
  storage disabled, SSR with `window` shimmed). The single `try`
  around `getItem + JSON.parse + mergeSettings` is exactly the right
  granularity.
- **P4** — `settings.ts:154-164`: `saveSettings` quota handling. The
  `console.warn` is the right log level (best-effort, not an error,
  not silent). Comment explains *why* it warns.
- **P5** — Three-file split honoured: `settings-context.ts` (types +
  `createContext`), `SettingsProvider.tsx` (component), `useSettings.ts`
  (hook). No mixed exports per file. `react-refresh/only-export-components`
  rule survives. Matches the FIXPASS Pass 1 PRAISE A-P4.
- **P6** — `SettingsProvider.tsx:62-88`: `ALLOWED_VARS` allowlist as
  defence-in-depth against future "preset vars are server-driven"
  drift. The comment ties it back to the threat model. **This** is the
  shape Pass 1's threat-model praise was about.
- **P7** — `SettingsProvider.tsx:113-185`: separation of debounce
  effect (per `[settings]`) and unmount-flush effect (`[]`). The
  comment at `:141-144` correctly anticipates the "why two effects"
  question.
- **P8** — `useSettings.ts:15-21`: throws if used outside Provider.
  Matches `useAuth` shape. Loud render-time failure mode > silent
  `undefined`.
- **P9** — `SwatchPicker.tsx:46-159`: faithful port of the prototype's
  SwatchPicker with real radiogroup ARIA, roving tabIndex, Home/End,
  and selected ring. The visual contract matches `screens-d.jsx`.
- **P10** — `SwatchPicker.test.tsx`: covers all the right things —
  ARIA role assertions, aria-checked flip, wrap-around at boundaries,
  Home/End, roving tabIndex.
- **P11** — Test file `SettingsProvider.test.tsx:42-46`: silences React's
  expected error log with a spied `console.error`. Mature test
  hygiene — keeps the test output clean without disabling the
  assertion.

---

## Bar-check matrix (SENIOR_ENGINEER_BAR.md §5)

| Item | Status | Note |
|---|---|---|
| Lint passes | not run by this review | tsconfig has `verbatimModuleSyntax + erasableSyntaxOnly`; code uses `import type` correctly |
| Type-check strict | ✅ | No `any`, all parsers narrow from `unknown`, generic types via `Readonly<Record<string, …>>` |
| Every public fn tested | ✅ | `loadSettings`, `saveSettings`, `paletteVars`, `useSettings`, Provider hydrate/debounce/reset, SwatchPicker render/click/arrow/Home/End/roving |
| SECURITY.md written | ❌ | **B1** above |
| README "how to test" | n/a | per-component test files document themselves |
| No TODO/FIXME | ✅ | grep clean across the eight files |
| No console.log | ✅ | only `console.warn` in `saveSettings` (justified) |
| No commented-out code | ✅ | — |
| No hardcoded secrets | ✅ | no secrets; PII fields are user-supplied |

---

## Recommendation

Land Pass 2 settings substrate after closing **B1** and **S1, S2, S4,
S5, S7**. **S3 / S6** are documentation-only; **NITs** can wait. Do not
unwind any of the eleven PRAISE items — they are the load-bearing parts
of why this substrate will survive Pass 9's server-sync addition.

`/fixpass` is the right gate; this review fits the `/fixpass` shape
exactly.
