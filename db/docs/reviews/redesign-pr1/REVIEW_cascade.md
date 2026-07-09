# Review: Cascade / Correctness / State — Seoul Neon Redesign (PR1)

**Reviewer role:** Independent senior frontend reviewer (did not write this code)
**Branch:** `feat/redesign-seoul-neon` @ `600eeb7`
**Slice:** CSS cascade correctness for the accent feature, AccentProvider state/persistence,
server-parity of the accent id, and hard-constraint compliance (§1 of
`REDESIGN_SEOUL_NEON_BRIEF.md`).

---

## Summary verdict

**PASS — no blockers found in this slice.** The builder's fix for the cascade-clobber bug
is real and verified two ways: (1) reading the code shows `ACCENT_PRESETS` in
`palette-presets.ts` now carries no `vars` map at all (the earlier version, visible in the
pre-PR1 commit, *did* project `--vermilion`/`--vermilion-soft`/`--gold*` inline — that would
have beaten every `[data-accent]` block), and (2) `SettingsProvider.test.tsx` has an explicit
regression test (`applies NO palette vars for the DEFAULT palette`, `does not set tokens
outside the allowlist`) asserting `--vermilion` and `--gold-light` are never touched. The
accent feature itself — state, persistence, no-flash bootstrap, live switching — is
correctly implemented and mirrors `ThemeProvider` faithfully. Server parity is handled
correctly by *not* touching the server at all for the new accent ids (confirmed by grep —
`palette.accent` is never written by the accent picker), which avoids the 400 the builder
warned about, at the cost of no cross-device accent sync (flagged as SHOULD-FIX below, per
the task's own instruction to flag it).

All four re-run gates are green: `tsc` 0 errors, `eslint` 0 errors/warnings, `vitest`
96/96 files and 1140/1140 tests passing, and `vite build` succeeds.

**Findings: 0 BLOCKER · 2 SHOULD-FIX · 2 NIT · 3 PRAISE.**

---

## Findings by category

### BLOCKER
None.

### SHOULD-FIX
1. **Accent choice does not sync across devices** — by design, but worth a product decision
   record. See "Server parity" below.
2. **Dead legacy CSS vars in the palette allowlist** (`--green`, `--green-light`) — pre-existing,
   not introduced by this PR, but the redesign touched this exact file/allowlist and left it
   in place. See Detailed Findings #6.

### NIT
1. Comment/doc drift risk: the cascade note at `index.css:138-141` describes *why* dark
   combo blocks are needed but doesn't call out that light-mode needs no such combo (the
   asymmetry is correct, just non-obvious to a future editor who adds a 4th accent).
2. `AccentProvider.tsx` and `ThemeProvider.tsx` are >90% structurally identical (read/store/
   effect/setter/memo). Not a defect, but a candidate for a shared `createPersistedAttribute`
   helper if a third such attribute ever appears — noted, not required for this PR.

### PRAISE
1. The `ALLOWED_VARS` allowlist in `SettingsProvider.tsx` (defence-in-depth: only listed keys
   are ever written, no matter what a preset's `vars` map claims) is exactly the right pattern
   to prevent this class of clobber-by-inline-style bug from recurring even if a preset gains
   an errant key later.
2. The `[data-theme="dark"][data-accent="X"]` combo blocks are a correct, deliberate use of
   CSS specificity (2 attribute selectors > 1) to guarantee dark-mode accent values win
   regardless of source order — and the code comment explains exactly why the combo is
   necessary (equal-specificity same-order collision otherwise). This is senior-level cascade
   reasoning, not an accident that happens to work.
3. Test coverage on `AccentProvider.test.tsx` explicitly covers the stale-value fallback,
   pre-stamped-attribute idempotency (no-flash coordination), and repeated switching — the
   right set of edge cases for this exact feature.

---

## Detailed findings (file:line)

### 1. The clobber bug — confirmed real, confirmed fixed

Diffing against the pre-PR1 commit (`c0b751b`) shows the actual bug the builder describes:

```
- vermilion: { vars: { '--vermilion': '#B83A2E', '--vermilion-soft': ...,
                        '--gold': ..., '--gold-light': ..., '--gold-soft': ... } }
+ vermilion: { name: 'Vermilion', kr: '단청', swatch: '#B83A2E' }   // no vars
```
(`client/src/lib/palette-presets.ts`, `ACCENT_PRESETS`, diff `c0b751b..HEAD`)

Before PR1, picking any non-default `ACCENT_PRESETS` entry (or even the default, which used
to carry `vars` too — see the `PAPER_PRESETS.hanji` diff, which *also* dropped its `vars` map)
would call `SettingsProvider.applyPaletteVars()` → `documentElement.style.setProperty('--vermilion', …)`.
An inline style on `documentElement` beats every selector-based rule in the cascade
(inline style specificity always wins over selectors, regardless of attribute-selector
count), so this would have silently frozen `--vermilion` to whatever hex the last-picked
*palette* preset declared, and no `[data-accent]` block could ever override it — exactly the
bug scenario.

**Fix, verified three ways:**
- `client/src/lib/palette-presets.ts:113-118` — `ACCENT_PRESETS` now declares zero `vars` on
  any of its four entries (`vermilion`/`indigo`/`plum`/`ochre`).
- `client/src/lib/settings.ts:256-270` (`paletteVars()`) — only folds `PAPER_PRESETS`,
  `CORRECT_PRESETS`, `WRONG_PRESETS` into the output; `ACCENT_PRESETS` is never in the
  `sources` array, so even if a future edit accidentally added a `vars` map back to
  `ACCENT_PRESETS` it would need a second independent line change (adding it to `sources`) to
  actually reach the DOM.
- `client/src/hooks/SettingsProvider.tsx:65-90` (`ALLOWED_VARS`) — the accent tokens
  (`--vermilion`, `--vermilion-bright`, `--vermilion-soft`, `--glow`, `--gold*`,
  `--on-vermilion`) are explicitly **absent** from the allowlist, with a comment explaining
  why (`"an inline --vermilion here would beat them in the cascade"`). `applyPaletteVars()`
  (line 117) checks `ALLOWED_VARS.has(k)` before every `setProperty` call — defence-in-depth
  even against a rogue preset map.
- Regression tests: `client/src/hooks/SettingsProvider.test.tsx` (diff `c0b751b..HEAD`) adds
  `'applies NO palette vars for the DEFAULT palette (Seoul Neon)'` and updates
  `'does not set tokens outside the allowlist'` to assert `touched.has('--gold-light') === false`
  and `touched.has('--vermilion') === false` even when a non-default palette (`accent: 'plum'`)
  is stored.

**Verdict: `data-accent` reliably wins.** No inline projection of any accent-owned variable
exists anywhere in the current tree (confirmed by grepping every `--vermilion*`/`--glow`/
`--gold*`/`--on-vermilion` *assignment* in `index.css` — all 33 assignment sites are inside
`:root`/`[data-theme]`/`[data-accent]` selector blocks; zero inline-style write sites remain
in the TS/TSX layer for these keys).

### 2. Cascade specificity trace (why it's correct, not just "happens to work")

`client/src/styles/index.css:19-186`:
- `:root, [data-theme="light"]` (specificity 0,1,0) sets the coral-light values as the base
  default (`:37-44`).
- `[data-theme="dark"]` (0,1,0) overrides with dark-coral values (`:98-101`), source-order
  after the light block — correct, light/dark are mutually exclusive states so this pairing
  never actually competes with itself.
- `[data-accent="coral"|"blue"|"mint"]` (0,1,0 each) sit **after** both theme blocks
  (`:143-186`) and carry the *light* value for each accent. Because they're equal specificity
  to `[data-theme="light"]`/`[data-theme="dark"]` and come later in source, they win over
  `[data-theme="light"]` correctly (light-mode accent switch works with no combo needed) but
  would *also* incorrectly win over `[data-theme="dark"]` if left alone (dark mode would show
  light-accent hex values).
- The `[data-theme="dark"][data-accent="X"]` combo blocks (0,2,0 — two attribute selectors)
  exist for exactly this reason and have strictly higher specificity than either single-attribute
  block, independent of source order. All three accents have a dark combo
  (`:149`, `:163`, `:179`) covering every token the light block sets. This is the correct fix
  for the asymmetry, and the in-file comment (`:138-141`) documents *why* it's needed — good
  practice, not an accident.
- I verified no other rule anywhere in the 4778-line sheet reassigns `--vermilion`,
  `--vermilion-bright`, `--vermilion-soft`, `--on-vermilion`, `--glow`, or `--gold*` outside
  these seven blocks (`grep -n "^\s*--vermilion..." `, `^\s*--glow:`, etc. — all hits land in
  lines 37-186 only; every other occurrence in the file is a `var(--vermilion)` *read*, not a
  write).

**No remaining path where a stored user palette preset silently breaks the design.** The
only way a `--vermilion*` value could still land is via `PAPER_PRESETS`/`CORRECT_PRESETS`/
`WRONG_PRESETS` `vars` maps, and none of those three declare a `--vermilion*`, `--glow`, or
`--on-vermilion` key (confirmed by reading all of `palette-presets.ts`) — nor could they:
`ALLOWED_VARS` would silently drop them even if a future edit added one.

### 3. AccentProvider state/persistence trace

`client/src/hooks/AccentProvider.tsx`:
- `readStored()` (`:40-51`) — SSR guard, try/catch around `localStorage.getItem`, narrows
  via `isAccent()`. Returns `null` (not a default) on any failure — the caller (`:67-69`)
  applies `DEFAULT_ACCENT` (`'coral'`), so a corrupt/absent value degrades safely. Matches
  `ThemeProvider`'s `readStored()` pattern exactly.
- Mount effect (`:73-77`) — reads current `data-accent` before writing, skips the DOM write
  if it already matches. This is the documented no-flash coordination with `index.html`'s
  inline bootstrap script (`index.html:43-49`) and is correct: on first mount the attribute
  is already right, so the effect is a no-op; the dependency array `[accent]` is correct
  (only re-fires on an actual accent change, not spuriously).
- `setAccent` (`:79-82`, `useCallback` with `[]` deps) — calls `storeAccent(next)` then
  `setAccentState(next)`. Both are stable references (module-level function + state setter),
  so the empty dep array is correct — **no stale closure**: `setAccent` never captures a
  snapshot of `accent`, it only ever receives the caller-supplied `next` value.
- `value` memo (`:84-87`) deps `[accent, setAccent]` — correct, both are the only two fields
  in `AccentContextValue`.
- No cleanup is needed/present for the attribute-write effect (idempotent DOM write, nothing
  to tear down) — consistent with `ThemeProvider`'s equivalent effect.

**Settings picker wiring** (`client/src/pages/Settings.tsx:942-950`):
```tsx
<SwatchPicker
  label="Accent"
  ...
  presets={ACCENT_OPTIONS}
  selectedId={accent}
  onSelect={(id) => { if (isAccent(id)) setAccent(id); }}
/>
```
Correct — narrows the picker's generic `string` id through `isAccent()` before calling the
typed setter, so the accent state can never desync from the `Accent` union even if
`ACCENT_OPTIONS`'s key set were ever a superset of `Accent` (it isn't, but the guard is cheap
insurance). `SwatchPicker` itself (`client/src/components/SwatchPicker.tsx:96-105,197-198`)
only commits on click or Space/Enter — not on arrow-key focus movement — so switching accent
doesn't hammer the (unthrottled, immediate) `setAccent`/`localStorage.setItem` call on a
keyboard sweep.

**index.html bootstrap parity** (`client/index.html:43-49`):
```js
var a = localStorage.getItem('km.accent');
document.documentElement.dataset.accent =
  (a === 'coral' || a === 'blue' || a === 'mint') ? a : 'coral';
```
Reads the same key (`ACCENT_STORAGE_KEY = 'km.accent'`, `accent-context.ts:33`), applies the
same three-value validation as `isAccent()`, and falls back to the same default (`'coral'` ==
`DEFAULT_ACCENT`). No drift between the pre-mount script and the provider's runtime guard.
No flash: correct.

### 4. Server parity — confirmed, and confirmed the client never POSTs an invalid id

`server/src/routes/settings.ts:46-49`:
```ts
const AccentPreset = z.enum(['vermilion', 'indigo', 'plum', 'ochre']);
```
This is the legacy enum, unchanged by the redesign, `.strict()`-validated (`PalettePrefsSchema`,
`:51-58`) — a PUT carrying `'coral'`/`'blue'`/`'mint'` in `palette.accent` would indeed 400.

I traced every write path to `settings.palette.accent` on the client and found **none** that
ever assigns a new accent id to it:
- The Accent `SwatchPicker`'s `onSelect` (`Settings.tsx:947-949`) calls only `setAccent(id)` —
  it does not call `updateSettings(...)` and never touches `settings.palette` at all.
- `settings.palette.accent` is only ever set by the (untouched) `ACCENT_PRESETS`-driven code
  paths, all of which still use the legacy ids (`vermilion`/`indigo`/`plum`/`ochre`) — there is
  in fact no more UI control left in `Settings.tsx` that writes `palette.accent` at all (the
  old accent `SwatchPicker` row was replaced in place by the new runtime-accent row, confirmed
  by the diff: `Settings.tsx` diff shows the accent `SwatchPicker`'s `presets`/`selectedId`/
  `onSelect` swapped from `ACCENT_PRESETS`/`settings.palette.accent`/`updateSettings` to
  `ACCENT_OPTIONS`/`accent`/`setAccent`).
- `client/src/services/settings.ts`'s `putPrefs` sends whatever is in `settings.palette`
  verbatim; since nothing ever mutates `palette.accent` away from its loaded/default value
  (`'vermilion'`), the PUT body's `accent` field is always one of the four legacy enum values
  and will never 400.

So the builder's claim is correct, and the mitigation (never write the new ids into the
synced field) is airtight against the specific 400 risk — verified, not just asserted.

**Is localStorage-only the right call, or should the schema be extended?** Flagging as
SHOULD-FIX per the task instructions: this means **the accent choice does not follow the user
across devices**, unlike every other palette preference. That's an inconsistent UX within the
same Settings screen (Paper/Correct/Incorrect all sync across devices; Accent, sitting in the
same visual group with the same swatch-picker chrome, silently does not) and there's no
in-UI indication of this asymmetry — a user who sets Cyber Blue on desktop and opens the app
on their phone will see Coral with no explanation. The brief's own §14a decision text says
"persist to localStorage (+ user settings if the app syncs settings server-side — check
settings route/store; keep parity with the theme toggle's persistence)" — and the theme
toggle has exactly the same asymmetry (`km.theme` is also localStorage-only), so this
decision is *consistent with existing precedent*, not a new gap. I'd call this an accepted,
pre-existing product tradeoff rather than a bug — but it should be a deliberate call for
someone to sign off on (extending `AccentPreset` server enum to `['coral','blue','mint']` —
or better, keeping the legacy enum but adding a second nullable `runtimeAccent` field — is the
straightforward fix if cross-device parity is later desired). Not a blocker for this PR.

### 5. Hard constraints (§1) — spot-checked, all intact

- **Token names**: `git diff c0b751b..HEAD -- client/src/styles/index.css` shows only VALUE
  changes plus net-new tokens (`--indigo-soft`, `--violet*`, `--cyan*`, `--radius*`,
  `--shadow*`, `--glow`, `--font-display`, `--on-vermilion`) — no existing token was renamed.
  `--ink*`, `--paper*`, `--vermilion*`, `--moss*`, `--ochre*`, `--line*`, `--danger*` all
  survive verbatim as names.
- **Class names**: `.km-card`, `.km-btn`, `.km-pill`, `.km-bottomnav*` all still present
  (34 combined matches via grep across the sheet).
- **Theme system intact**: `ThemeProvider.tsx` is untouched by this diff (absent from the
  `git diff --stat` file list) — it still stamps `data-theme` exactly as before; `AccentProvider`
  is a pure addition alongside it in `App.tsx:73-78`, not a modification.
- **`.focusring` preserved**: `index.css:279` — `.focusring:focus-visible { outline: 1.5px
  solid var(--vermilion); outline-offset: 2px; }` — still present, and now correctly tracks
  whichever accent is active (a nice side benefit of the token-based approach: the focus ring
  itself re-tints with the accent choice).
- **Hexagon drop-shadow focus ring preserved**: `index.css:762-766` —
  `.km-bottomnav__hex--current, .km-bottomnav__hex:focus-visible { filter:
  drop-shadow(0 0 0 rgba(0,0,0,0)) drop-shadow(0 0 10px var(--vermilion-bright)); }` — present,
  unchanged in mechanism (still a `drop-shadow` filter, not a `box-shadow`/`outline`, avoiding
  the "rect outline on a clipped shape" problem the brief calls out).

### 6. Minor: dead legacy CSS vars in the allowlist (SHOULD-FIX, pre-existing)

`SettingsProvider.tsx`'s `ALLOWED_VARS` (`:83-86`) includes `--green` and `--green-light`
(legacy aliases for the `CORRECT_PRESETS` pine/teal `vars` maps — `palette-presets.ts:132-135,
143-146`). I grepped the entire 4778-line stylesheet for `var(--green` / `var(--green-light`
and found **zero usages** — nothing in the current CSS reads these tokens; only `--moss`/
`--moss-soft` are actually consumed. This predates PR1 (the alias comment says "legacy alias
for parity" in both the old and new file), so it's not something this PR introduced, but the
redesign touched this exact allowlist/preset file and left the dead tokens in — worth a
follow-up cleanup pass so a future reader doesn't assume `--green` does something.

---

## Build/type/test re-run results (actually executed, not taken on faith)

```
$ cd "client" && npx tsc -p tsconfig.app.json --noEmit
(no output — exit 0)

$ npm run lint
> client@0.0.0 lint
> eslint .
(no output — exit 0)

$ npx vitest run
 Test Files  96 passed (96)
      Tests  1140 passed (1140)
   Duration  19.01s (transform 30.05s, setup 26.52s, import 58.44s, tests 99.22s, environment 62.94s)

$ npx vite build --outDir /tmp/km-rev-cascade-dist
✓ 258 modules transformed.
✓ built in 458ms
(PWA precache: 15 entries, 810.75 KiB — unrelated size warning on the main JS chunk,
 pre-existing, not introduced by this PR)
```

All four gates the builder claimed are independently reproduced clean.

---

## Coordination observations

- This review covers **cascade/state/correctness only**, per the assigned slice. I did **not**
  independently re-derive the §3a contrast-ratio math (coral/blue/mint × light/dark × solid
  fill) beyond reading the in-code comment's claimed ratios — that's explicitly called out in
  the brief as needing verification "for EVERY preset in BOTH themes" and belongs with
  whichever reviewer owns visual/a11y/contrast for this PR. Worth confirming that reviewer
  actually measured the mint-light `#0F9E7A` + white ≈3.4:1 claim (and its `--on-vermilion:
  #10141F` mitigation) with a real contrast tool, not just trusted the comment.
- I did not review the non-accent visual/shape/motion changes (§5-§11 of the brief:
  radius/shadow/font/motion) — out of scope for this slice, and a large fraction of the
  391-line `index.css` diff is exactly that.
- No other in-flight change in this diff touches `AccentProvider`/`ThemeProvider`/
  `SettingsProvider` concurrently as far as I could tell from the single-commit branch state
  — no merge-conflict/overlap risk to flag for a parallel reviewer working the same files.
- Recommend the SHOULD-FIX on cross-device accent sync (finding #4) be explicitly triaged by
  Jared as a product decision (accept the asymmetry vs. extend the server enum) rather than
  silently left as an implicit gap — it's the one place this PR's behavior could surprise a
  user, even though it's not a code defect.
