# Independent Review — client logout button (`feat/client-logout-button` @ c0e18d4)

Reviewer: independent senior review (did not author). Report only — no code edited.
Scope: `client/src/services/auth.ts(+test)`, `client/src/hooks/AuthProvider.tsx(+test)`,
`client/src/pages/Settings.tsx(+css,+test)`. Diff vs `origin/rebuild`: 7 files, +263/−3.

## Summary verdict

**PASS — 0 BLOCKERS, 2 SHOULD-FIX, 3 NIT.** The critical invariant holds and is
tested: a failed `POST /auth/logout` still clears local auth state to `guest`, and the
`guest` flip drives a real `Navigate` to `/login` through `RequireAuth`
(`client/src/App.tsx:204-212`). Single-flight is enforced by guard + `disabled`.
No auth token exists client-side to leak. Gates all green (lint 0, tsc 0,
vitest 2242/2242 on re-run; one pre-existing flake unrelated to this branch).

## Bar checklist

| Bar item | Verdict | Evidence |
|---|---|---|
| Failure still logs out locally + lands on /login | **PASS** (with documented 5xx edge — SF-2) | `AuthProvider.tsx:307-318` clears unconditionally; test `AuthProvider.test.tsx:230-263`; redirect real at `App.tsx:209-211` |
| Single-flight / no double-fire | **PASS** | `Settings.tsx:1101-1106` (`loggingOut` guard) + `disabled` on the button; test `Settings.test.tsx:1979-2006` |
| Server owns revocation + HttpOnly cookie; no token left client-side | **PASS** | `auth.ts:208-222` doc is accurate; verified zero auth writes to `localStorage`/`sessionStorage` anywhere in `client/src/services` + `client/src/hooks` |
| WCAG/ARIA (disabled + aria-busy in flight) | **PASS** | `Settings.tsx:1215-1219`; `Button.tsx:58-69` spreads `...rest` so both attributes reach the DOM; asserted in `Settings.test.tsx:1996-1997` |
| Kebab-case BEM per `client/BEM_CONVENTIONS.md` | **PASS** | `km-settings__logout`, `km-settings__logout-hint` (`Settings.css:44-59`); CSS vars `--line`/`--paper-mute` exist (`styles/index.css:70,212`) |
| Tests exercise real behavior | **MOSTLY PASS** | Failure→guest and success→guest both real at the provider layer; gap = no routed integration test for the redirect itself (SF-1); one comment overstates what the single-flight test proves (NIT-1) |
| Consistent with Settings conventions | **PASS** | `Bilingual`, `SettingsGroup`/Profile tile, hairline-divider idiom matching sched rows |
| No scope creep | **PASS** | Diff touches exactly the 7 mandated files |
| Session/CSRF posture unchanged | **PASS** | Logout rides the existing `api.post` path; `SameSite=Strict` posture (`api.ts:26-34`) untouched |

## Findings

### BLOCKER — none

### SHOULD-FIX

- **SF-1 — Redirect path is real but never tested end-to-end.**
  The `/login` landing is a three-layer contract chain: Settings mocks
  `useAuth().logout` (`Settings.test.tsx:124-133`), AuthProvider tests assert the
  `guest` flip, and `RequireAuth`'s `Navigate` (`App.tsx:209-211`) is asserted by
  nobody — `grep -rln RequireAuth client/src --include='*.test.tsx'` matches only a
  comment in `Settings.test.tsx`. Each link is individually verified real by this
  review, but a regression in `RequireAuth` (or in wiring Settings under it) would not
  fail any test while leaving the logout button clearing state with no visible effect.
  Add one routed integration test: real `AuthProvider` + `MemoryRouter` + a
  `RequireAuth`-gated page, click Log out, assert the login route renders.

- **SF-2 — 5xx-with-live-cookie edge is user-visible dead air (pre-existing, now
  exposed by UI; track the planned follow-up).**
  Sequence verified in code: POST 5xxs → state clears (`AuthProvider.tsx:307-318`) →
  `RequireAuth` navigates to `/login` with `state.from` → re-probe succeeds (cookie
  still valid) → `PublicOnly` (`App.tsx:220-231`) bounces the user straight back to
  Settings. Net: user clicked "Log out", screen flashed, they are still logged in,
  zero feedback. The provider documents this and defers a retry + surfaced warning to
  "Pass 3" (`AuthProvider.tsx:289-303`), and staying authenticated is the *correct*
  security posture (the session genuinely still exists — pretending otherwise would be
  worse). Not a blocker for this branch, but this button is what first puts the edge
  in front of a user: file the Pass-3 warning item in `BUGS_AND_FEATURES.md` so it
  doesn't evaporate. The Settings handler comment (`Settings.tsx:1089-1100`) describes
  the round-trip accurately, including why `loggingOut` never needs resetting (fresh
  mount on return — verified against `PublicOnly`'s `state.from` handling).

### NIT

- **NIT-1 — Single-flight test comment overstates what `fireEvent.click` proves.**
  `Settings.test.tsx:2001-2005` says fireEvent is used "to prove the guard, not the
  CSS". In fact React suppresses click handlers on `disabled` buttons outright, so the
  `calledTimes(1)` assertion is satisfied by the `disabled` attribute before the
  `if (loggingOut) return` guard (`Settings.tsx:1102`) is ever reached — the closure
  guard is exercised by no test. Protection is still tested (removing `disabled` fails
  `toBeDisabled()` at `Settings.test.tsx:1996`), and the guard is legitimate
  belt-and-suspenders for the pre-re-render window; just correct the comment or drop
  the claim.

- **NIT-2 — Collapsed-tile test phrasing vs assertion.** `Settings.test.tsx:1954-1957`
  comments that the button is "aria-hidden with the rest of the tile body" but asserts
  `not.toBeInTheDocument()`. It passes because `queryByRole` excludes aria-hidden
  nodes by default (returns `null`), on which the matcher is vacuously true — the
  element may well still be in the document. Assert via `queryByRole(..., { hidden:
  true })` presence + default-query absence if the aria-hidden claim matters, or
  reword.

- **NIT-3 — Pre-existing flake, not this branch.**
  `src/pages/review/ReviewDictionary.test.tsx:250` (`'전체'` `aria-pressed`) failed
  once in the first full-suite run, passed on immediate re-run, and is untouched by
  this diff. Worth a stabilization ticket; do not hold this branch on it.

### PRAISE

- **P-1 — Redirect by state, not by `navigate()`.** `Settings.tsx:1092-1096`
  deliberately owns no navigation; the `guest` flip is the single source of truth and
  cannot race or disagree with auth state. This is the right architecture and the
  comment explaining it is exemplary.
- **P-2 — The critical failure case is genuinely tested.**
  `AuthProvider.test.tsx:230-263` rejects the service call with a real `ApiError` 500
  against the real provider and asserts the flip to `guest` + emptied email — exactly
  the "never stuck logged-in-but-broken" bar, not a tautology.
- **P-3 — Honest security comments.** `auth.ts:208-219` states precisely what the
  client can and cannot do about an HttpOnly cookie; verified accurate (no storage
  writes, cookie cleared only via server `Set-Cookie`).
- **P-4 — `void logout()` is provably safe.** `probe()` catches everything
  (`AuthProvider.tsx:127-143`) and `logout` wraps its only other await in try/catch,
  so the context method never rejects; the fire-and-forget in the click handler cannot
  produce an unhandled rejection.

## Gates (run in worktree `client/`)

| Gate | Result |
|---|---|
| `npm ci` | clean, 0 vulnerabilities |
| `npm run lint` | 0 errors, 0 warnings (exit 0) |
| `npx tsc -p tsconfig.app.json --noEmit --incremental false` | 0 errors (exit 0) |
| `npx vitest run` (full suite) | run 1: 127/128 files, 2241/2242 tests (1 fail = NIT-3 flake); run 2: **128/128 files, 2242/2242 tests** |
| Touched files only (`auth.test.ts`, `AuthProvider.test.tsx`, `Settings.test.tsx`) | **103/103** |
