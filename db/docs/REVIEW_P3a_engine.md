# Review — P3a language-display: engine + primitive + server prefs

Reviewer: independent senior review (R1 slice: `Bilingual.tsx`, `useLanguageDisplay.ts`,
`SettingsProvider` CSS-var projection, `lib/settings.ts`, `server/src/routes/settings.ts`, + tests).
Commit `350f099`, branch `feat/overhaul-p3-language`. Spec `db/docs/OVERHAUL_P3a_BUILD.md`.
Settings.tsx control + wired pages = R2, not covered here.

## Verdict

**PASS — no blockers.** 1 SHOULD-FIX (a11y polish inside the sr-only path), 6 NITs.
Client: `tsc -b` = 0; targeted vitest 40/40 (Bilingual 13, useLanguageDisplay 11, lib/settings 16).
Server: `tests/routes/settings.test.ts` 19/19 (real Postgres via testcontainers).
Two live mutation checks run against `Bilingual.test.tsx` — both killed (details below).

### The three headline questions

**(a) Does single-language visual mode ever degrade the accessible name?** No — for
name *content*. In `en`/`ko`/`both+compact` with both languages present, the visible
segment is wrapped in `aria-hidden="true"` and a `.km-sr-only` span carries
`"visible · other"` (`Bilingual.tsx:133-145`), so the computed name contains both
languages exactly once — never doubled (the aria-hidden half is excluded from name
computation), never missing one. `.km-sr-only` is a correct clip-rect utility with
`white-space: nowrap` (`styles/index.css:1921-1931`). When only one language exists,
the single segment renders un-hidden — name = visible text, never blank
(`Bilingual.tsx:94-104`). The one *quality* gap is F-1 below: the sr-only string is
not lang-tagged, so the Korean half loses its screen-reader voice switch — the
pronunciation, not the presence, degrades.

**(b) Can a palette update erase `--lang-sub-scale`?** No — structurally impossible
today. The scale is written by its own effect keyed on
`settings.languageDisplay.subScale` (`SettingsProvider.tsx:193-198`), never through
`applyPaletteVars`. `applyPaletteVars` only removes keys present in its module-level
`writtenVars` set, which only ever receives keys that passed the `ALLOWED_VARS`
filter (`SettingsProvider.tsx:118-134`) — and `--lang-sub-scale` is not in
`ALLOWED_VARS` (`:65-91`), so it can never enter `writtenVars` and can never be
cleared by a palette write. The rationale is documented at the decision site
(`:186-192`). Guard is architectural + comment only — see F-6 for the missing
regression test.

**(c) Legacy blob no-clobber + strict rejection?** Both verified, both tested against
a directly-poisoned JSONB column. A pre-P3a stored `{notif, palette}` passes
`PrefsSchema.safeParse` on GET because `languageDisplay` carries an object-level
`.default(...)` (`settings.ts:120`) — the response comes back with the stored notif +
palette intact and only `languageDisplay` defaulted; it does NOT fall to
`DEFAULT_PREFS` (test: `server/tests/routes/settings.test.ts:139-154`). `.strict()`
at every level rejects with 400: bad `mode` enum (`:185-191`), out-of-range
`subScale` 1.5 / 0.2 / -1 (`:193-199`), unknown key inside `languageDisplay`
(`:201-207`), unknown top-level key (`:122-127`). `validateBody` writes back
`result.data` (`server/src/middleware/validate.ts:20-21`), so a defaults-filled parse
is what actually persists — no half-shaped blob ever reaches the column.

## Findings

### SHOULD-FIX

**F-1 — sr-only bilingual reading loses `lang="ko"` on the Korean half.**
`client/src/components/Bilingual.tsx:142-144`. The screen-reader path renders a flat
template string (`` `${en} · ${kr}` ``), while the visible segments get `lang="ko"` +
the `kr` font class via `Segment` (`:57-79`). So in exactly the modes built *for*
screen-reader users (`en`, `ko`, `compact`), the Hangul is announced without a
language switch — most SR/voice combos will read it in the English voice (often
spelled out or skipped) instead of Korean TTS. The header comment (":19-24") and the
Segment doc ("wherever it lands", `:57-58`) promise more than this path delivers.
Fix is small — compose the sr-only span from lang-tagged children:

```tsx
<span className="km-sr-only">
  <span lang={visibleIsEn ? 'en' : 'ko'}>{visibleIsEn ? en : kr}</span>
  {' · '}
  <span lang={visibleIsEn ? 'ko' : 'en'}>{visibleIsEn ? kr : en}</span>
</span>
```

(Accessible-name computation concatenates child text; `lang` on inline spans is
honored by AT. Update the three `.km-sr-only` textContent assertions accordingly —
textContent is unchanged, so they may pass as-is.) Not a blocker: both languages are
still *in* the name; this is pronunciation quality, and `both` mode (the default) is
unaffected.

### NIT

**F-2 — `aria-hidden` guarded by a single test.** `Bilingual.test.tsx:65-67` asserts
the aria-hidden wrapper only in the mode-`en` case; `ko` and `compact` rely on the
shared code path. Mutation check confirmed removal *is* caught (1 test fails), so
coverage is real but thin — one shared helper assertion would harden it.

**F-3 — a11y tests assert DOM structure, not the computed name.**
`Bilingual.test.tsx` checks `.km-sr-only` textContent + `[aria-hidden]` presence
rather than `toHaveAccessibleName` on a labeled wrapper. Acceptable for a bare-span
primitive (no role of its own), but the R2 wired-chrome tests should assert real
accessible names on the buttons/links that embed it.

**F-4 — stale headers.** `client/src/lib/settings.ts:1-23` ("profile + notif +
palette", "server sync (Pass 9 alongside auth)" as future work) and
`client/src/hooks/SettingsProvider.tsx:19-21` still describe the pre-server-sync
world; server sync shipped (Pass 9) and P3a rides it. Doc drift only — the
languageDisplay additions themselves are correctly documented.

**F-5 — server-prefs hydration is Settings-page-only.** `fetchPrefs` is called only
from `pages/Settings.tsx:552`; on a fresh device the chrome renders the localStorage
defaults until the user visits Settings. This is the pre-existing palette pattern and
the spec explicitly says "follows the palette pattern", so compliant — noting it so
nobody mistakes "server-synced" for "hydrated at app boot".

**F-6 — no regression test for the palette-can't-erase-the-scale invariant.** The
separation is deliberate and structurally sound (see headline (b)), but the only
guard against someone later adding `--lang-sub-scale` to `ALLOWED_VARS` or routing it
through `applyPaletteVars` is a comment. A 5-line test in
`useLanguageDisplay.test.tsx` (update `settings.palette`, assert the var survives)
would pin the invariant the code comment promises.

**F-7 — inner-object partial PUT accepted.** `{ languageDisplay: { mode: 'en' } }`
passes and silently defaults `primary`/`subScale`
(`server/tests/routes/settings.test.ts:176-183` documents it as intended). Slightly
at odds with the route's "whole blob replace, no merge" posture — a buggy client
sending a partial resets siblings without a 400. Harmless single-user; the real
client always sends the full object.

### Accepted trade-off (reviewed, agree)

**Last-writer-wins stale-client PUT** (`server/src/routes/settings.ts:82-84`): a
pre-P3a client PUTting `{notif, palette}` persists default `languageDisplay`,
resetting the user's choice. That is the only exposure I can find beyond it: the GET
side never destroys data (a corrupt/hand-edited blob falls back to `DEFAULT_PREFS`
*in the response only* — nothing is written until the next PUT, which then heals the
column). For a single-user app whose only "stale client" is the owner's own old tab,
acceptable — and consistent with the route's locked no-version-gate design.

### PRAISE

- **P-1** `clampSubScale` (`lib/settings.ts:56-61`) rejects non-finite/non-numeric
  input to the default instead of NaN-poisoning the CSS var; the hook re-clamps on
  read (`useLanguageDisplay.ts:31`) and the provider re-clamps at the projection
  (`SettingsProvider.tsx:196`) — belt, braces, and suspenders, with client bounds
  mirroring the server's exactly and cross-referenced in comments both sides.
- **P-2** Missing-language fallback is genuinely total: `present()` treats
  whitespace-only as absent (`Bilingual.tsx:52-55`), both-absent renders an empty
  wrapper without crashing, and all of it is tested (`Bilingual.test.tsx:127-166`).
- **P-3** The server legacy-blob tests poison `users.preferences` directly via SQL
  rather than mocking the read path (`settings.test.ts:88-98, 139-154`) — exactly the
  real-data posture this project's history demands.
- **P-4** Mutation-resistant a11y tests, verified empirically: deleting the sr-only
  span fails 3 tests; stripping `aria-hidden` fails 1. The `visibleText()` helper
  (clone + strip `.km-sr-only`) is a clean way to assert the sighted rendering.
- **P-5** `mergeSettings` defaults each `languageDisplay` field independently
  (`lib/settings.ts:187-199`) with per-field type guards — a partial blob upgrades
  cleanly, tested field-by-field (`settings.test.ts:97-104`).
- **P-6** The `'both'` default + Korean-first + kept-in-name "·" separator means an
  existing user (and every existing `aria-label` call-site shape) sees zero change
  until they touch the control — a well-reasoned compatibility default, documented at
  `lib/settings.ts:128-129` and `Bilingual.tsx:115-118`.

## Verification run

- Client (Docker `node:20-slim`): `tsc -b --force` → `TC=0`; `vitest run
  Bilingual.test.tsx useLanguageDisplay.test.tsx lib/settings.test.ts` → 40/40.
- Server (Docker + testcontainers Postgres): `vitest run tests/routes/settings.test.ts` → 19/19.
- Mutation 1 (remove sr-only span, `Bilingual.tsx:142-144`) → 3 failed / 10 passed. Killed.
- Mutation 2 (remove `aria-hidden="true"`, `Bilingual.tsx:135`) → 1 failed / 12 passed. Killed.
- Working tree restored after mutations (`git status` clean for the file).
