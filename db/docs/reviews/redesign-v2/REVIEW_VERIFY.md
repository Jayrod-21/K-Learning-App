# Redesign v2 Flatten — Independent Verification

**Reviewed:** commit `075a2f5` on `feat/redesign-v2-flatten`
**Reviewer:** independent (did not write this code); own WCAG script, own greps, own gate re-runs.
**Reference:** `REDESIGN_SEOUL_NEON_BRIEF.md` + stated mockup target (light bg #EDF1F8/#FFFFFF/#FF3E6C, dark #080A11/#141A28/#FF4D74).

## Verdict: **PASS**

All three corrections are implemented correctly and cleanly. Contrast is compliant everywhere real text renders (worst real-text cell 4.76:1, still ≥4.5 AA). No broken layout, no dead code from the flatten, no orphaned CSS introduced by this commit. One SHOULD-FIX (not a blocker) found in the palette-removal wire-echo path — a narrow race condition that can silently overwrite a user's legacy server-stored `palette` blob with the default; harmless to current UI (nothing reads/renders it) but a real data-integrity issue if that field is ever consumed elsewhere. All four build/test gates pass clean.

---

## 1. Color correction — OK

`client/src/styles/index.css`:

- Light block (`:root, [data-theme="light"]`, lines 19–103): `--ink: #EDF1F8` (line 22), `--ink-1: #FFFFFF` (line 23), `--vermilion: #FF3E6C` (line 39), `--vermilion-bright: #FF3E6C` (line 40), `--on-vermilion: #0A0C12` (line 44). Matches the stated mockup target exactly — note this is a deliberate **deviation from the original brief** (`REDESIGN_SEOUL_NEON_BRIEF.md` §3, which had light CTA fill as deep rose `#E11D48` + white text). The commit message (`075a2f5`) documents the pivot explicitly: bright coral + near-black ink in **both** themes ("same move as dark theme + mint"). This is the correct call — it satisfies AA (see §2 below) while keeping the accent visually identical across themes, which the brief's own approach did not.
- Dark block (`[data-theme="dark"]`, lines 104–153): `--ink: #080A11` (106), `--ink-1: #141A28` (107), `--vermilion: #FF4D74` (117), `--on-vermilion: #0A0C12` (120). Matches target.
- All three accent presets (coral/blue/mint, light + dark, lines 175–227) follow the same fill+dark-ink pattern consistently.

## 2. Contrast — OK (own from-scratch WCAG script)

Wrote an independent relative-luminance/contrast calculator (sRGB → linear → WCAG relative luminance → `(L1+0.05)/(L2+0.05)`), no reliance on the builder's numbers. Full matrix:

| Pair | Ratio | Verdict |
|---|---|---|
| **Light CTA fill `#FF3E6C` vs `--on-vermilion` `#0A0C12`** | **5.73:1** | PASS (≥4.5) |
| **Dark CTA fill `#FF4D74` vs `--on-vermilion` `#0A0C12`** | **6.11:1** | PASS |
| Light `--vermilion-ink` `#BB183C` on `--vermilion-soft` `#FFE6ED` | 5.38:1 | PASS |
| Dark `--vermilion-ink` `#FF7190` on `--vermilion-soft` `#2C1420` | 6.53:1 | PASS |
| Light `--indigo-ink` `#1C55FF` on `--indigo-soft` `#E7EEFF` | **4.76:1** | PASS (worst real-text cell) |
| Light `--moss-ink` `#0B7756` on `--moss-soft` `#DEF7EF` | 4.93:1 | PASS |
| Light `--ochre-ink` `#965D05` on `--ochre-soft` `#FEF1DA` | 4.87:1 | PASS |
| Light `--violet-ink` `#643EFB` on `--violet-soft` `#EFEAFE` | 4.93:1 | PASS |
| Light `--cyan-ink` `#097285` on `--cyan-soft` `#E0F6FB` | 4.99:1 | PASS |
| Light `--danger-ink` `#BB183C` on `--danger-soft` `#FFE6ED` | 5.38:1 | PASS |
| Dark `--indigo-ink` `#7AA2FF` on `--indigo-soft` `#131F3D` | 6.54:1 | PASS |
| Dark `--moss-ink`(=`--moss`) on `--moss-soft` | 8.90:1 | PASS |
| Dark `--ochre-ink`(=`--ochre`) on `--ochre-soft` | 8.92:1 | PASS |
| Dark `--violet-ink` `#AE96FF` on `--violet-soft` | 7.03:1 | PASS |
| Dark `--cyan-ink`(=`--cyan`) on `--cyan-soft` | 9.08:1 | PASS |
| Dark `--danger-ink` `#FF7190` on `--danger-soft` | 6.53:1 | PASS |
| Body text `--paper` on `--ink`/`--ink-1`, both themes | 15.5–17.7:1 | PASS (large margin) |
| `--paper-dim` on `--ink-1`, both themes | 6.18 / 7.58:1 | PASS |
| **`--paper-mute` `#99A2B6` on `--ink-1` (white) `#FFFFFF`** | **2.56:1** | **FAIL vs AA — flagged, see below** |

**Worst overall cell: 2.56:1** (`--paper-mute` on white, light theme). **Worst *non-flagged* real-text cell: 4.76:1** (indigo-ink on indigo-soft, light) — passes but narrowly; no headroom left if any category hue shifts again.

**`--paper-mute` assessment (builder's flagged item):** confirmed via grep (`client/src/styles/index.css`, ~90 usages) that `--paper-mute` is used almost exclusively for: secondary/muted labels in bilingual sub-segments (`.km-bilingual__sub`), meta/timestamp/unit text (mins, page counts, "of N" pagers), gloss/translation lines, scrollbar thumb, and `.km-pill--default` (neutral pill text on `--ink-2`, not white — that combo measures 2.39:1, still sub-AA). None of these are primary reading content — they are all secondary/supporting text (glosses, units, counts, timestamps) sitting alongside a higher-contrast primary line. **This is a real AA gap, not a false alarm** (WCAG doesn't have a "decorative eyebrow" exemption for actual text — that exemption only covers non-text/disabled/logo content), but the risk is contained: it's exclusively secondary metadata, never the sole carrier of required information, and it is a **pre-existing token** unchanged by this commit (not introduced by any of the three corrections under review). Recommend: SHOULD-FIX in a follow-up, not a blocker for this PR — darken `--paper-mute` light value (e.g. toward `#7A8399`, ~3.9:1) or reclassify these specific labels as decorative in a future pass. Out of scope for "verify the 3 stated corrections."

## 3. Palette-removal cleanliness — OK, with one SHOULD-FIX

Grepped `client/src` for `paletteVars`, `ALLOWED_VARS`, `PALETTE_PRESET`, `paper-correct`, `correctColor`, `wrongColor` — no dangling references. `client/src/lib/palette-presets.ts` now only exports the `Preset`/`PresetMap` *type* consumed by `SwatchPicker` for the (retained) accent picker; the actual paper/correct/wrong preset objects and `paletteVars()` projector are gone (confirmed absent from `client/src/lib/settings.ts` and `SettingsProvider.tsx`).

**Accent picker intact:** `client/src/pages/Settings.tsx:924-933` renders `<SwatchPicker presets={ACCENT_OPTIONS} selectedId={accent} onSelect={...}>` wired to `useAccent()`/`data-accent`. Untouched by the removal.

**Test edits legitimately track the removal, not mask a regression** (read in full):
- `client/src/hooks/SettingsProvider.test.tsx` — old test asserted a *non-default* palette DOES project `--ink`/`--moss`/`--danger` onto `<html>`; new test asserts it does **not**, and that the only key ever set is `--lang-sub-scale`. This is the correct inverse assertion for a feature deletion, not a weakened test.
- `client/src/lib/settings.test.ts` — old test asserted `paletteVars()` flattens presets to CSS vars; new test asserts a legacy `palette` key is silently **dropped** from `loadSettings()`'s merged shape (`expect('palette' in got).toBe(false)`) rather than crashing or leaking into state. Also correct.

**Wire-palette-echo edge (flagged by the task) — SHOULD-FIX, not a blocker:**
`client/src/pages/Settings.tsx:568-572` seeds `lastSyncedPrefsRef.current.palette = LEGACY_PALETTE_DEFAULT` before the `/settings/prefs` hydration GET resolves. The debounced-PUT effect (lines 675-699) fires on `[settings.notif, settings.languageDisplay]` changes with **no gate on `prefsHydratedRef`** — so if the user toggles a notification or language-display setting in the window before the prefs GET settles (plausible: a user tapping a toggle immediately on opening Settings, or a slow/offline GET), the PUT sends `palette: LEGACY_PALETTE_DEFAULT`, not the user's actual server-stored value. If that user previously had a non-default legacy palette (`hanji`/`moss`/`vermilion`/etc. presets, now-dead client-side but still a valid server-schema value), this **silently overwrites their stored blob with the default** — a real data-integrity clobber, race-condition-gated. It is harmless to *this* client's UI today (nothing reads or projects `palette` anymore, confirmed by grep), but not harmless in general: it corrupts a field the server schema still owns for back-compat, which matters if any other consumer (a future client, an admin export, a re-introduced feature) ever reads it. Recommend gating the debounced-PUT effect on `prefsHydratedRef.current` (skip the PUT — or at minimum omit `palette` from the body — until hydration has completed at least once), consistent with how the effect already treats mock settles as non-authoritative.

## 4. Flatten integrity — OK, no broken layout, no other missed nesting

**Today.tsx** (`client/src/pages/Today.tsx:416-443`, diff in `075a2f5`): outer `<Card variant="default">` removed from around the Reading/Listening/Writing `SwipeCarousel`; the `.km-eyebrow` div and `SwipeCarousel` now sit directly under the `<section>` on the page background. Verified: `TaskCard` (`client/src/components/TaskCard.tsx:57-90`) renders its own `<button className="km-taskcard...">` which independently carries the elevated-card look (`.km-taskcard` styled at `index.css:1613` with its own shadow/radius) — so removing the outer Card is correct; the tile itself is already the "card." No orphaned CSS: `Today.css` has no leftover rule keyed to the removed wrapper (its only two selectors, `.km-today__taskPage` and `.km-today__taskPage .km-taskcard`, both still apply to the carousel-page div and are unaffected by the removal). The other two Today.tsx sections (Grammar practice, TOPIK) still correctly wrap their single-level content in one `<Card>` each — those were never double-carded and were untouched by this commit.

**Mistakes.tsx** (`client/src/pages/Mistakes.tsx:91-105`, diff in `075a2f5`): the explanation block changed from `<Card variant="flat" className="km-mistakes__explain">` to a plain `<div className="km-mistakes__explain">`. `Mistakes.css` gained matching surface/padding/radius rules (`background: var(--ink-2); border-radius: var(--radius-sm); padding: 14px 16px;`) so the explanation still reads as a recessed section of the outer `MistakeCard`'s `<Card>`, not a floating tile. No dead CSS — the added rules target the *retained* class, nothing was left targeting a removed wrapper class.

**No other card-in-card missed** — spot-checked with an AST-ish scan (paired `<Card>`/`</Card>` stack across every `.tsx` in `client/src/pages`) plus manual reads of Progress.tsx, Review.tsx, Reading.tsx:
- Progress.tsx: `SkillTrendsCard`'s `<Card>` wraps a `SwipeCarousel` of `SkillTrendPanel`s, but `SkillTrendPanel` renders a bare `<div className="km-progress__trendPanel">` with **no independent background/shadow** in `index.css` (confirmed via grep — no `box-shadow`/`background` rule for that class) — not a card-in-card.
- Review.tsx (lines 977, 1285, 1323) and Reading.tsx (lines 236, 265, 379, 420, 684): each `<Card>` wraps plain content (lists, buttons, text) or another `<Card>` was never present — single-level in every instance checked.
- The one automated "nested Card" hit in Mistakes.tsx was a **false positive** from my own regex matching a code comment (`client/src/pages/Mistakes.tsx:92` — the sentence "NOT a nested `<Card variant="flat">`" inside a `/* */` comment) rather than real JSX; manually confirmed the three `<Card>` usages in that file are sibling branches of a ternary/conditional, never nested.

## 5. Gates — all clean

| Gate | Result |
|---|---|
| `npx tsc -p tsconfig.app.json --noEmit` | **0 errors** |
| `npm run lint` | **0 errors/warnings** |
| `npx vitest run` | **1135/1135 passed (96 files)** |
| `npx vite build --outDir /tmp/km-v2-verify-dist` | **OK** (PWA precache generated, 15 entries, 808 KiB; only a routine code-splitting size-warning, not an error) |

---

## Summary of findings

| Severity | Item |
|---|---|
| SHOULD-FIX | Settings.tsx debounced-prefs-PUT effect can fire before `/settings/prefs` hydration completes, sending the seeded `LEGACY_PALETTE_DEFAULT` and clobbering a user's real stored legacy `palette` value server-side. Gate the effect on `prefsHydratedRef.current`. |
| SHOULD-FIX (pre-existing, not introduced by this commit) | `--paper-mute` (#99A2B6 light) on white/`--ink-2` measures 2.39–2.56:1 — sub-AA for the secondary/meta text it's used on across ~90 call sites app-wide. Contained risk (never sole carrier of primary info) but worth a follow-up token darken. |
| Confirmed clean | Color tokens match mockup target exactly in both themes; accent-as-text and all 5 category-hue-on-soft pairs pass AA in both themes; palette feature fully removed with no dangling refs/dead imports; accent picker intact; flatten in Today.tsx/Mistakes.tsx is structurally sound with no orphaned CSS; no other missed card-in-card across Progress/Review/Reading; all 4 build gates green. |

**Ship recommendation:** PASS — safe to proceed to `/fixpass` / deploy. The one SHOULD-FIX (palette wire-echo race) is worth a quick follow-up patch before or shortly after deploy, but it does not affect the shipped UI (cosmetics-only scope) and only risks a dead-to-the-client wire field.
