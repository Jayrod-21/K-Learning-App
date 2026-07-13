# Review: Design fidelity — Seoul Day/Night foundation

**Reviewer:** Independent senior design-engineering reviewer (did not write this code)
**Scope:** Fidelity of the built foundation to `DESIGN_SEOUL_DAY_NIGHT.md` — NOT code correctness (separate reviewer).
**Branch/commit:** `feat/redesign-foundation` @ `c525288` off `rebuild`.
**Files reviewed:** `client/src/styles/index.css` (token head, lines 1–560), `client/src/styles/seoul-devices.css` (full), `components/{CityCard,SkylineHeader,SubwayProgress,DancheongRail}.{tsx,css}`, `components/SealStamp.tsx`, `styles/tokensContrast.test.ts` (coverage sampled).

---

## Summary verdict

**PASS WITH CONDITIONS**

The foundation genuinely honors the vision. All nine character devices are implemented as reusable components/utilities — not a flat color reskin. Both worlds are rendered purely via `data-theme` with equal structural care. The signature Night neon-signboard treatment matches the approved mockup value-for-value. Reduced-motion is gated correctly (real conditional gating, not zero-duration fakery) — exactly what the doc warned about. Accent orthogonality holds in both worlds. The two flagged decisions are both defensible and I independently re-verified the deepened hex values pass AA and stay in-palette.

Two SHOULD-FIX conditions keep this from an unconditional PASS: (1) `CityCard`'s Night body gradient, plain border, and radius are hard-coded hex/px — a direct violation of the doc's "never hard-code a hex in a component" non-negotiable, and the file's own docstring falsely claims "no hard-coded hex"; (2) Day Latin headings render in rounded Nunito, not the serif/high-contrast face the doc's §3 "Day = serif-forward" explicitly requires — the Latin type axis does not differentiate Day from Night.

**Blocker count: 0.**

---

## 9-device checklist

| # | Device | Implemented? | Faithful? | file:line |
|---|--------|:---:|:---:|-----------|
| 1 | Neon signboard (Night) / hanji card (Day) | Yes | Yes — border `color-mix(km-tone 55%)` = rgba(255,62,108,.55) at coral, outer `0 0 22px` glow + `inset` inner glow, glowing title; Day = paper + hairline + soft shadow + ink title | `CityCard.css:33–67`; Day base `12–31` |
| 2 | Dancheong rail (jade/verm/cobalt/ochre bands) | Yes | Yes — Day fixed 4-band `repeating-linear-gradient` (8px each); Night single glowing edge in tone | `DancheongRail.css:21–45` |
| 3 | 기와 roof texture / Night city-grid | Yes (utility) | Mostly — Day = `repeating-radial-gradient` rings (approximates arced tiles, not literal eave-arcs); Night = crosshatch grid | `seoul-devices.css:104–124` |
| 4 | Namsan skyline header | Yes | Yes — Day hanok roofs (Q-curves) + soft buildings + red beacon; Night towers + Namsan mast/bulb + lit windows + neon horizon; parallax gated | `SkylineHeader.tsx:45–96`, `SkylineHeader.css:30–78` |
| 5 | Subway-line progress | Yes | Yes — done/current(ringed, +3px)/ahead dots, fill in tone, Night glow | `SubwayProgress.{tsx,css}` |
| 6 | Hangul watermark | Yes (utility) | Yes — giant serif glyph via `content: attr(data-glyph)`, opacity 0.05, `z-index:-1`, pointer-events none | `seoul-devices.css:76–95` |
| 7 | Seal stamps (印) | Yes | Yes — `milestone` variant: organic border-radius blob, `-6deg` hand-stamp tilt, `印` default glyph, tone-aware, Night glow | `SealStamp.tsx:55–79`, `index.css:881–904` |
| 8 | Rain-neon sheen | Yes (utility + body) | Yes — diagonal `repeating-linear-gradient` at rgba(255,255,255,.014), Night-only via `[data-theme="dark"]`, pointer-events none | `seoul-devices.css:21–38`, `index.css:441–447` |
| 9 | Mother-of-pearl (자개 najeon) | Yes (utility) | Yes — iridescent accent-family gradient, shimmer gated under `no-preference`, documented "used sparingly" | `seoul-devices.css:47–68` |

All nine present. The user's "ALL 9 incorporated" demand is met — no missing or stubbed device.

---

## Findings

### BLOCKER
_None._

### SHOULD-FIX
- **SF-1** — `CityCard` Night body/border/radius are hard-coded, violating the doc's token-only non-negotiable and contradicting the file's own docstring. `CityCard.css:34–38, 40, 48`.
- **SF-2** — Day Latin headings render in rounded Nunito, not the serif/high-contrast face the doc's §3 requires; the Latin type axis fails to distinguish Day from Night. `index.css:454`.

### NIT
- **N-1** — Day skyline "soft buildings" fill `--ink-2` (#F3ECDB) sits on a pale `--city-gradient` (top #DCE9EC); buildings are near-invisible, so the Day strip reads almost entirely as floating red roofs + beacon. Decorative/`aria-hidden`, so no AA duty, but the "soft buildings" intent barely registers. `SkylineHeader.css:31`.
- **N-2** — `CityCard` Night radius `15px` (SF-1) diverges from both `--radius-card-night: 18px` and `.km-card`'s Night 18px, so the two card primitives don't share a corner radius in Night. `CityCard.css:40` vs `index.css:150, 248`.
- **N-3** — Pre-JS first-paint edge: under OS-dark with no `data-theme` attribute yet stamped and a non-coral `data-accent`, the `:root:not([data-theme])` media block (spec 0,2,0) beats `[data-accent="blue|mint"]` (0,1,0), so the accent flashes as neon-coral until `ThemeProvider` stamps `data-theme`. Transient only; harmless once JS settles. `index.css:264–302` vs `351–390`.

### PRAISE
- **P-1** — Reduced-motion done *right*: skyline parallax (`SkylineHeader.css:58`), najeon shimmer (`seoul-devices.css:60`), and neon flicker (`seoul-devices.css:163`) are each gated inside `@media (prefers-reduced-motion: no-preference)`, so a reduced-motion user renders the settled end-state, never a stalled mid-frame — precisely the trap the doc's §7 and the index.css block (`547–556`) call out. Do not let a fix-pass "simplify" these into zero-duration.
- **P-2** — `--km-tone` centralization (`seoul-devices.css:145–157`) gives CityCard, DancheongRail, SubwayProgress, and SealStamp one shared Day-dancheong ⇄ Night-neon ⇄ accent-tracking resolution instead of three re-derivations. Clean, and the reason accent orthogonality holds uniformly.
- **P-3** — The Night signboard border generalizing the doc's literal `rgba(255,62,108,.55)` into `color-mix(km-tone 55%)` is *better* than the literal spec: it keeps the signboard glow accent-orthogonal (§2) instead of pinning it to coral. Correct call, not a deviation.
- **P-4** — Inactive skyline `<g>` layer is `display:none` (`SkylineHeader.css:26–27`), fully removing it from paint so its gated animation can never run on the hidden world.

---

## Detailed findings

### SF-1 — CityCard Night surface is hard-coded, breaking the token-only contract (and its own docstring)

`CityCard.css:34–38` paints the Night signboard body with literal `linear-gradient(160deg, rgba(30,37,66,0.85), rgba(16,20,40,0.9))`; line 48 sets the `plain` border to literal `rgba(255,255,255,0.12)`; line 40 hard-codes `border-radius: 15px`.

Two problems:
1. **Contract violation.** `DESIGN_SEOUL_DAY_NIGHT.md` §2 ("never hard-code a hex in a component") and §8 (non-negotiable: "toggling `data-theme` fully reskins — no orphaned hard-coded colors") are explicit. Those rgba stops are ink-family-adjacent (#1e2542 / #101428 vs the real `--ink-2 #1a2038` / `--ink-1 #12172a`) but are NOT the tokens — retune `--ink-1/2` later and the CityCard body will not follow, orphaning the app's flagship surface.
2. **False docstring.** `CityCard.tsx:26` and `CityCard.css` header both assert "Token-driven only (no hard-coded hex)." That is untrue at `CityCard.css:34–38, 48`. A reviewer trusting the docstring would miss the drift.

Fix direction: express the body via `color-mix(in srgb, var(--ink-2) 90%, transparent)` / `var(--ink-1)` (preserving the intended alpha-let-through so `--city-gradient` reads underneath), the plain border via `var(--line)`/`--line-strong`, and the radius via `var(--radius-lg)` (which also resolves N-2). Renders identically today; survives a future retune. Not a blocker — it renders correctly now and only the flagship card is affected — but it is a direct hit on a stated non-negotiable, so it must not ship unaddressed.

### SF-2 — Day Latin headings are not serif-forward

`index.css:454` sets `h1, h2 { font-family: var(--font-display); }`, and `--font-display` (`index.css:166`) is `'Nunito', ui-rounded, …` — the rounded/Night display face — in **both** worlds. Night additionally glows (`index.css:455`). Korean display correctly switches to serif in both worlds via `.kr-display` (`index.css:462–466`), which is good and is the primary content face for this app.

But the doc §3 is explicit: "**Day** = serif-forward. Korean display in Noto Serif KR; **Latin headings in a serif or high-contrast treatment**. Calm, editorial, ink-on-paper." As built, Day Latin headings render in the same rounded Nunito as Night — the Latin type axis carries no Day/Night distinction beyond the Night glow. "Both worlds equal care" is not fully met on typography: Night got its face; Day's Latin editorial/serif register is absent.

The builder consciously left this (comment at `index.css:165–166`). It is a softer miss than a color break because Korean leads the content, but it is a named, explicit doc requirement unmet. Fix direction: give `:root[data-theme="light"] h1, h2` a serif or high-contrast Latin stack, leaving Night on Nunito+glow.

---

## The two flagged decisions — verdict on each

### (a) Deepened doc-literal hex values for WCAG AA — **ENDORSE**

I recomputed the WCAG ratios independently (sRGB relative luminance):

- **Day `--paper-mute` #8A7D63 → #6B614D.** On the hardest host `--ink #EFE7D6`: **4.96:1** (matches the code's claim, `index.css:63–67`) — PASS AA; the doc-literal #8A7D63 computes ~3.3–3.8:1, a genuine AA failure, so the deepen was necessary. #6B614D is a deeper warm olive-brown — same hue family, not muddied; still visibly lighter than `--paper-dim` (guarded by `tokensContrast.test.ts:129–134`).
- **Night `--neon-blue` #4F7BFF → #5C87FF.** As title text on `--ink-2 #1a2038`: #5C87FF = **4.87:1** (PASS ≥4.5); the doc-literal #4F7BFF = **4.29:1** (FAIL as text). #5C87FF is one notch brighter in the *identical* blue hue — reads as the same neon blue, not a new color.
- **Dancheong `-ink` twins** (`index.css:78–81`): each is a deepened value of its own dancheong hue, guarded on its soft chip by `tokensContrast.test.ts:88–107` — the live 28-test guard, which I confirmed targets exactly these `-ink`-on-`-soft`, `--paper-mute`-on-surface, and focus-ring pairings.

Verdict: the deepenings are correct, minimal, in-palette, and necessary. The Seoul look survives. This is the right way to reconcile a doc-literal palette with a hard AA floor.

### (b) Kept legacy `--ink`/`--paper` meanings (inverse of doc) + var-chained the doc palette — **ENDORSE**

The builder kept `--ink*` = surfaces and `--paper*` = text (the inverse of the doc's `--ground`/`--paper`/`--ink` vocabulary), added `--ground*` aliases for the doc's app-bg name, and var-chained the doc's `--dan-*`/`--neon-*` palette onto the legacy `--vermilion/indigo/moss/ochre` names (`index.css:44–257`).

The question is whether the **look** is preserved. It is — the *hex values assigned to the legacy names match the doc exactly*: `--ink #EFE7D6` = doc `--ground`, `--ink-1 #FAF6EC` = doc `--paper`, `--ink-2 #F3ECDB` = doc `--paper-2`, `--paper #27331F` = doc `--ink`, and the Night set likewise. The rendered pixels are the doc's palette; only the token *names* differ. Renaming across ~30 components + a 4889-line sheet would be mass breakage for zero visual gain, and the single source of truth is preserved via the var-chain (accent↔dan/neon, hanja↔ochre, vocab↔cobalt, success↔jade/mint).

The only residual cost is cognitive: a page-builder who reads the doc then the code meets an inverted `--ink`/`--paper`. That is fully mitigated by the 26-line mapping docstring (`index.css:16–41`) which states the inversion and the "read `--ink-1` for surface, `--paper` for text" rule outright. Verdict: pragmatic, well-documented, look-preserving. Correct engineering call.

---

## Coordination observations

- **For the correctness/code reviewer:** SF-1's hard-coded rgba is as much a maintainability/token-purity issue as a fidelity one — flag it there too. Also confirm `AccentProvider`/`ThemeProvider` stamp `data-theme` via an inline pre-paint script; if not, N-3's accent-flash is user-visible on cold load.
- **For the fix-pass agent:** Do **not** collapse the three `@media (prefers-reduced-motion: no-preference)` gates (P-1) into `animation-duration:0` — that reintroduces the stalled-mid-frame bug the doc explicitly forbids. When fixing SF-1, keep the alpha in the gradient stops (via `color-mix(... transparent)`) so `--city-gradient` still reads through the signboard body; a solid `var(--ink-1)` would flatten the intended depth.
- **AA coverage gap the live test does not cover (all currently safe, but future page-builders should not assume the guard catches them):** `tokensContrast.test.ts` checks `-ink`-on-`-soft`, `--paper-mute`-on-surface, and focus-ring-vs-bg. It does **not** check text-on-accent-fill (`--on-vermilion` on `--vermilion`) — those are only documented by hand-comment (`index.css:322–330`, e.g. Night near-black 5.73:1 on coral). I spot-verified `.km-btn--gold` Night (near-black #0A0C12 on neon-coral) clears AA. If a future accent is added, its on-accent pairing needs a manual check because the test won't catch it.
