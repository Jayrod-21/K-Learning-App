# REVIEW — Phase 1 UI primitives: app-wide text-size setting (F-025)

Branch `feat/phase1-ui-primitives`, commit `4645273`. Independent review; no code modified.
Scope: TextSizeProvider stack, index.html bootstrap, index.css root rules, Settings two-way
prefs sync, `/settings/prefs` server schema + tests.

## Summary verdict

**APPROVE with one significant SHOULD-FIX.** The prefs-sync machinery — the riskiest part —
is correct: adopt-on-hydrate, debounced PUT, and the pre-hydration clobber guard all mirror
the AccentProvider template line-for-line, the server schema coerces missing/unknown
`textSize` to `'md'` without wiping the rest of the blob, and both sides carry real tests for
the rolling-deploy skews. Zero BLOCKERs. The one real problem is feature efficacy: the app's
text is styled almost entirely in fixed `px`, so the root-`%` scaling this feature ships has
almost no visible effect — and neither the code comments, the Settings hint copy, nor any
ticket documents that limitation. Gates: client typecheck 0 / lint 0 / 52 client tests pass;
server typecheck 0 / 27 route tests pass against testcontainer Postgres.

## Findings

| # | Severity | Finding |
|---|----------|---------|
| S1 | SHOULD-FIX | Root-`%` scaling is a near no-op today: 0 rem/Tailwind font-sizes in the app vs 256 `px` font-size declarations in `index.css` alone (plus 8 more CSS files and ~20 inline `fontSize` numbers). Not documented as a known limitation anywhere — needs a px→rem migration follow-up ticket and an honest limitation note. |
| S2 | SHOULD-FIX | Settings hint copy "Scales all text and spacing app-wide" (`client/src/pages/Settings.tsx:1836`) and the index.css comment "Tailwind utilities, rem paddings, inherited body text" (`client/src/styles/index.css:260-261`) overstate what actually scales; cheap to correct in this PR. |
| N1 | NIT | "Reset to defaults" button in the Appearance group resets notif/languageDisplay but not text size (nor accent/theme) — consistent with the accent precedent, but the button sits in the same visual group as the S/M/L control. |
| N2 | NIT | Server-wins-on-load can silently discard a text-size pick made during the hydration window (tested and intentional — `Settings.test.tsx:1094-1133` — but worth knowing it is a lossy semantic). |
| P1 | PRAISE | Server tests poison the JSONB blob via direct SQL and assert the rest of the blob **survives** coercion (explicitly "must NOT be the DEFAULT_PREFS fallback") — exactly the real-data testing lesson. |
| P2 | PRAISE | Rolling-deploy skew handled in **both** directions with tests on both sides: old server → new client (client-side `isTextSize` guard + baseline pinning), old client → new server (`.catch('md')` accepts a missing key). |
| P3 | PRAISE | The pre-hydration PUT-clobber guard — the exact bug class that bit the accent picker — is exercised with a held-open hydration promise and a mid-flight user pick. |
| P4 | PRAISE | Template fidelity: provider/context/hook/presets/tests mirror the accent stack essentially line-for-line, including SSR guard, privacy-mode try/catch, and the idempotent attribute write. |

**BLOCKERs: 0 · SHOULD-FIX: 2 · NIT: 2 · PRAISE: 4**

## Detailed findings

### S1 — px→rem efficacy gap is real and undocumented (SHOULD-FIX)

The mechanism is right: `client/src/styles/index.css:265-267` re-points the root font-size
(`:root` 100% / `sm` 93.75% / `lg` 112.5%), so anything rem-derived or inherit-derived scales.
But measured against the actual stylesheet:

- `grep -c "font-size:.*px" client/src/styles/index.css` → **256**; `font-size:.*rem` → **0**.
- Eight more CSS files set px font-sizes (`Today.css`, `Progress.css`, `Tabs.css`,
  `FilterSelect.css`, `ShowMore.css`, `BackButton.css`, `CollapsibleTile.css`, `LineChart.css`),
  plus ~20 inline `fontSize: <number>` in TSX.
- Tailwind is installed (`client/package.json:24`) but **zero** `text-*` / spacing utilities are
  used anywhere in `src/**/*.tsx` (verified by grep) — the app is styled via `km-*` BEM classes.
- Spot checks of high-traffic text all set px: `.km-topbar__title` 26px, `.km-settings__row-label`
  13px, `.km-btn--md` 14px, `.km-field__input` 15px, `.km-mfa__note` 12px, `body` sets no
  font-size at all (`index.css:278`).

Consequence: a user who picks **Large** sees essentially nothing change on most screens.
F-025's ticket text ("app-wide S/M/L text-size setting (root rem scaling)") implies the rem
migration is part of the feature's value; shipping the switch without the migration is a
defensible v1 slice **only if** the limitation is recorded. It currently is not — no
follow-up ticket in `BUGS_AND_FEATURES.md`, no known-limitation note in
`text-size-presets.ts`/`index.css`, and the comments actively claim the opposite (see S2).

**Disposition asked for by the review brief (ticket vs acceptable-for-v1):** acceptable for
v1 *as infrastructure* — the sync plumbing, enum, bootstrap, and CSS hook are all correctly
extensible — but it must not ship silently. Required follow-ups: (a) file a px→rem migration
ticket (or extend F-025) covering `index.css` + the page/component CSS files + inline styles;
(b) add a known-limitation note where the scale contract is documented
(`client/src/lib/text-size-presets.ts:11-15` is the natural home); (c) fix the copy per S2.

### S2 — overstated copy, in-PR fix (SHOULD-FIX)

- `client/src/pages/Settings.tsx:1836` — hint reads "Scales all text and spacing app-wide."
  Today it scales neither most text nor any spacing (no rem paddings exist). Suggest honest
  v1 copy, e.g. "Scales base text size app-wide" — or hold the control until the migration
  lands, since a visible-but-inert setting erodes trust in Settings generally.
- `client/src/styles/index.css:260-261` — "every rem-derived length in the app — Tailwind
  utilities, rem paddings, inherited body text — scales together": there are no Tailwind
  utilities or rem paddings in use. The comment describes the codebase the pattern was
  designed for, not this one.

### Two-way sync vs the AccentProvider template — verified clean

Compared line-by-line; no divergence that changes behavior.

- **Provider layer** (`client/src/hooks/TextSizeProvider.tsx:44-98` vs
  `AccentProvider.tsx:45-97`): identical structure — SSR-guarded `readStored` with
  privacy-mode try/catch (44-55), best-effort `storeTextSize` (58-64), lazy `useState`
  initializer, idempotent `data-text-size` effect that skips the write when the index.html
  bootstrap already stamped it (77-81), memoized context value. Context/hook/presets splits
  (`text-size-context.ts`, `useTextSize.ts`, `text-size-presets.ts`) mirror the accent files
  including the react-refresh rationale.
- **Adopt-on-hydrate** (`client/src/pages/Settings.tsx:693-718`): `textSizeRef` keeps the
  hydration effect settle-driven (664-669, same ref discipline as `accentRef`); a pre-F-025
  server response missing `textSize` fails `isTextSize` and the **local** value is pinned as
  baseline (697-700) — no adoption, no "correcting" PUT (test at `Settings.test.tsx:1064-1092`).
  Critically, `lastSyncedPrefsRef` is updated with the server value *before* `setTextSize`
  (706-717), so the change effect diffs to nothing and no echo PUT fires (test at 1039-1062).
- **PRE-HYDRATION PUT GUARD** (`Settings.tsx:766`): the single `prefsHydratedRef` gate covers
  textSize because textSize rides the same change effect (767-793). A pick made before the GET
  settles is stored locally, the PUT is suppressed, and the late settle lands server-wins —
  exercised end-to-end at `Settings.test.tsx:1094-1133`. A mock settle keeps the guard closed
  (674), so a server-down session can never clobber the stored blob.
- **Change-PUT**: `textSize` added to both the current-object build (771) and the equality
  check (778), debounced 400ms, eager baseline update so a failed PUT can't loop-retry (785),
  failure surfaced via the non-blocking retry toast (627-638) — change already durable in
  localStorage. No swallowed errors: only deliberate best-effort catches (localStorage,
  canceled PUT), each commented.

### Bad/legacy value coercion — verified

`server/src/routes/settings.ts:80` — `z.enum(['sm','md','lg']).catch('md')`, exactly the
brief's required shape, with a doc-comment (66-79) explaining why `.catch` instead of the
sibling enums' hard-400 posture. Because `.catch` also absorbs `undefined`, every pre-F-025
stored blob passes the GET-side `safeParse` **without** falling back to `DEFAULT_PREFS` —
the whole-blob-wipe failure mode is structurally closed. Empirically proven by
`server/tests/routes/settings.test.ts:274-286` (poisoned `textSize: 'gigantic'` via direct
SQL → GET returns `{...CUSTOM_PREFS, textSize: 'md'}`, custom notif/palette/languageDisplay
intact) and 298-311 (pre-F-025 client PUT → 200, stores `'md'`, rest persists untouched).

### Server strict-schema change — verified

`PrefsSchema` (settings.ts:149-156) stays `.strict()` at every level; `textSize` added at 154
and to `DEFAULT_PREFS` at 170. A valid new-client PUT cannot 400 (round-trip test at
tests:288-296); genuinely-unknown keys still 400 (tests:124-129); unknown `textSize` *values*
coerce rather than 400 (tests:313-319), consistent with the accent posture. Client wire type
(`client/src/services/settings.ts:60-68`, `client/src/types/domain.ts:629`) mirrors the enum
with a lockstep doc-comment, and the rolling-deploy caveat on the required-but-maybe-absent
field is explicitly documented at the type site.

### No-flash bootstrap — verified

`client/index.html:50-57` mirrors the accent bootstrap exactly: reads
`localStorage['km.textSize']`, allow-lists `sm|md|lg`, stamps `data-text-size` synchronously
before paint, falls back to `'md'`. An unset attribute (privacy-mode throw) falls through to
the base `:root { font-size: 100%; }` rule — still md. The provider's mount effect
(TextSizeProvider.tsx:77-81) skips the redundant write, tested at
`TextSizeProvider.test.tsx:62-69`.

### Default 'md' shrinks nothing — verified

`:root { font-size: 100%; }` restates the browser default; there is no other `html`/`:root`
font-size rule in the sheet, and `body` (index.css:278) sets none. `DEFAULT_TEXT_SIZE = 'md'`
with an explicit "Deliberately NOT 'sm'" rationale (`text-size-context.ts:20-23`), asserted by
`TextSizeProvider.test.tsx:32-36` and `Settings.test.tsx:987-1001`. Note the F-025 ticket's
second half ("generally reduce the default text size") is deliberately not shipped — see
coordination notes.

### index.css scope — verified

`git diff rebuild -- client/src/styles/index.css` adds only the 14-line comment block plus the
three `:root`/`[data-text-size]` rules (17 insertions, 0 deletions). No other global changes.

## Gates (re-run, real counts)

| Gate | Result |
|------|--------|
| client typecheck | **0 errors** — no `typecheck` script exists in `client/package.json`; ran the equivalent `npx tsc -p tsconfig.app.json --noEmit` + `npx tsc -p tsconfig.node.json --noEmit`, both exit 0. (`npx tsc -b` itself is blocked by a root-owned `client/node_modules/.tmp/` — stale Docker artifact, environment issue, not code.) |
| client lint | `npm run lint` → **0 errors, 0 warnings** |
| client targeted tests | `npx vitest run src/hooks/TextSizeProvider src/pages/Settings src/services/settings` → **3 files, 52 tests, all passed** (4.91s) |
| server deps | `npm ci` **fails with EACCES** — root-owned leftovers (`node_modules/pend`, `node_modules/yauzl`, from a prior root Docker run). Worked around with `npm install` (310 added / 158 changed, exit 0). Environment issue; needs a one-time `sudo chown` on the box. |
| server typecheck | `npm run typecheck` → **0 errors** |
| server route tests | `npx vitest run tests/routes/settings.test.ts` (testcontainer Postgres 16) → **1 file, 27 tests, all passed** (26.17s) |

## Coordination observations

1. **F-025 is only half-shipped by design.** The ticket asks for the S/M/L setting *and* "generally
   reduce the default text size." The default stays md=16px (correct for a safe rollout), and the
   smaller-default half plus the px→rem migration (S1) remain open — the coordinator should either
   extend F-025's status notes in `BUGS_AND_FEATURES.md` or file follow-up tickets so this doesn't
   silently read as done.
2. **`SegmentedRadioGroup` gained a per-option `ariaLabel`** (`Settings.tsx:1714-1716,1780`) to give
   the S/M/L glyphs real accessible names ("Small"/"Medium"/"Large") — a small shared-component
   change other Phase 1 slices (LanguageDisplay uses the same component) should be aware of;
   it is backward-compatible (optional prop).
3. **Extensibility contract is spread across five places** (context union, presets, CSS blocks,
   index.html allow-list, server enum) — each site carries a lockstep comment naming the others,
   which is the best you can do without codegen. Adding `xl` later touches all five.
4. **Environment debt on M:** root-owned `client/node_modules/.tmp/` and
   `server/node_modules/{pend,yauzl}` break `tsc -b` and `npm ci` respectively for the
   non-root user. Fix once with `sudo chown -R jared-williams:jared-williams` on both trees,
   or CI-parity gates will keep tripping locally.
5. **Reset-to-defaults asymmetry (N1)** predates this slice (accent/theme behave the same); if it
   gets fixed, fix it for all three attribute-backed prefs at once.
