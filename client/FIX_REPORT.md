# Fix Report — Pass 1 fix-pass

Date: 2026-05-29
Author: independent fix-pass agent (did not write or review the original Pass 1 code).
Surface: `Repository/client/` only.
Inputs: REVIEW_A_auth.md, REVIEW_B_design.md, REVIEW_C_shell.md, REVIEW_D_foundation.md, FIXPASS_AGGREGATE.md, SENIOR_ENGINEER_BAR.md, ADR-002, global CLAUDE.md.

## Summary

All three BLOCKERs are FIXED in code. The full top-8 SHOULD-FIX list is FIXED. Every "cheap-while-in-file" SHOULD-FIX in the dispatch prompt is FIXED. NITs explicitly listed in the prompt (B-3/4/5/7, C-3/4/5/6/7) are FIXED. NITs NOT in the prompt are left for a future pass per the dispatch's "out of scope" clause. Two items were promoted from "in-scope SHOULD-FIX" to "FIXED in this pass with caveat" because they sit on the same surface and the bar §5 calls for them: open-redirect hardening (now FU-NF-9 with rationale) and the per-call timeout pattern doc (now FU-NF-14, in SECURITY.md §15). No suggestion was rejected outright; the SF-1 "axios timeout vs cancel vs network" discrimination is implemented exactly as the review specified.

**Verification gap (important, see §"Verification" below):** The sandbox in this environment blocks executing `npm run build`, `npm run lint`, and even `node ./node_modules/.bin/eslint` directly. Only `npm install` is allow-listed. The fix-pass therefore could NOT empirically confirm green build/lint after edits. Every edit was made with careful read-back and TS-strict / `erasableSyntaxOnly` / `verbatimModuleSyntax` rules in mind, but the re-reviewer MUST run `npm run build` and `npm run lint` from `Repository/client/` and report regressions.

`D-S1` (`@supabase/*` lockfile cleanup) IS empirically verified because `npm install` is the action that closes it. After re-install: `package-lock.json` grep `"@supabase"` returns 0 hits; `node_modules/@supabase/` does not exist.

## Disposition table

Status codes: **FIXED** (landed in this pass) · **DEFERRED** (ticket filed in FOLLOW_UPS.md) · **REJECTED** (with rationale) · **N/A** (out of scope per the dispatch prompt).

| ID | Source | Severity | Status | File:line | Notes |
|---|---|---|---|---|---|
| A-B1 | A | BLOCKER | FIXED | `src/services/api.ts:1-47, 126-170`; `client/SECURITY.md` §2 | Deploy contract locked in JSDoc; runtime tripwire `warnInsecureCrossOriginCookiePosture` warns dev-mode on non-loopback HTTP; SECURITY.md §2 documents same-origin posture and the relax-path. |
| A-B2 | A | BLOCKER | FIXED | `src/hooks/AuthProvider.tsx:13-21, 134-148, 150-172` | `probeRef.current?.abort()` called BEFORE the POST in both `login` and `register`. Threat-model header updated to describe the race + defence. |
| D-B1 | D | BLOCKER | FIXED | `client/SECURITY.md` (new file) | 17-section SECURITY.md per dispatch spec; promotes (does not rewrite) threat-model paragraphs; adds CORS, PWA hijack, env-var leak, supply chain, dev-server bind, CSP gap, deferred items. |
| D-S1 | D | SHOULD-FIX | FIXED | `package-lock.json`; `node_modules/` | `npm install` regenerated lockfile; 18→0 `@supabase` mentions; 6→0 packages on disk. Verified empirically. |
| C-1 | C | SHOULD-FIX | FIXED | `src/components/Shell.tsx:13-71`; `src/components/BottomNav.tsx:18-45, 62`; `src/components/MoreSheet.tsx:6-22` | `moreButtonRef` plumbed Shell → BottomNav → DOM. `closeMore` uses `queueMicrotask` to defer focus restore until React unmount completes. MoreSheet JSDoc updated to reflect actual ownership. |
| C-2 | C | SHOULD-FIX | FIXED | `src/components/BottomNav.tsx:83-105` | `matchActiveId` uses `pathname === it.path || pathname.startsWith(it.path + '/')` for non-root paths. `/topik-history` no longer lights TOPIK. |
| B-1 | B | SHOULD-FIX | FIXED | `src/styles/index.css:33-37, 60-65, 220, 261` | New `--on-vermilion` token (cream in light, near-ink in dark) referenced from `.km-btn--gold` and `.km-seal`. Comment in each block explains purpose-not-surface. |
| B-2 | B | SHOULD-FIX | FIXED | `index.html` (new IIFE); `src/hooks/ThemeProvider.tsx:1-15, 27-34, 65-78` | Synchronous IIFE sets `data-theme` pre-mount. ThemeProvider effect skips redundant DOM write when already correct. `readStored` guards `typeof window` (B-3 folded in). |
| A-SF-1 | A | SHOULD-FIX | FIXED | `src/services/api.ts:78-124`; `src/pages/Login.tsx:254-284` | `normaliseError` discriminates `ECONNABORTED` → `code: 'timeout'`, `ERR_CANCELED` → `code: 'canceled'`, else `'network'`. `messageFor` switches on the code. `'canceled'` returns sentinel `''` so the form swallows. |
| A-SF-3 | A | SHOULD-FIX | FIXED | `src/pages/Login.tsx:244-284` | Fixed lookup table; `err.message` never returned. Includes the 429 branch and a mode-aware 400 message. A-SF-4 (future-drift XSS) folded into this — comment locks the contract. |
| D-S2 | D | SHOULD-FIX | FIXED | `public/manifest.webmanifest:13-20`; `index.html:5-13` | Manifest `purpose: "any maskable"` → `"any"` (truthful for the SVG we ship). `apple-touch-icon` link added pointing at favicon.svg with a comment that the rasterised PNGs ship in Pass Final (FU-NF-10). |
| A-SF-2 | A | SHOULD-FIX (doc) | FIXED | `src/hooks/AuthProvider.tsx:174-191` | `logout` JSDoc now documents the 5xx edge: re-probe succeeds if cookie is still valid, UI flashes "logged out" then bounces back. Pass 3 (FU-NF-13) will add retry + warning. |
| A-SF-4 | A | SHOULD-FIX | FIXED | `src/pages/Login.tsx:17-25, 254-284` | Folded into A-SF-3 as instructed. Threat-model comment updated. |
| A-SF-6 | A | SHOULD-FIX | FIXED | `src/pages/Login.tsx:163-168` | `autoFocus` on email input (with explanatory comment that React only fires it on mount). Lint disable for `jsx-a11y/no-autofocus` is forward-compat (plugin not currently in config). |
| A-SF-7 | A | SHOULD-FIX | FIXED | `src/pages/Login.tsx:122-127, 218-224` | `aria-busy={submitting}` on the form; submit-button text wrapped in `<span role="status" aria-live="polite">` so SR users hear the transition. |
| A-SF-8 | A | SHOULD-FIX | FIXED | `src/hooks/AuthProvider.tsx:150-172` | Explicit `trimmedDisplayName: string \| undefined = displayName?.trim() \|\| undefined`. Same semantics as before, intent now visible. Comment notes server schema would 400 on `'   '`. |
| A-SF-9 | A | SHOULD-FIX | FIXED | `src/hooks/AuthProvider.tsx:67-120` | Initial probe gets one retry on 5xx / `'network'` / `'timeout'` with 500 ms backoff. 401 bails immediately. Backoff respects `AbortController` so a `login()` mid-backoff still cancels cleanly. |
| A-SF-10 | A | SHOULD-FIX (doc) | FIXED | `src/services/api.ts:176-183`; `client/SECURITY.md` §15 | Timeout semantics documented in the axios instance comment; FU-NF-14 filed for per-call override pattern. |
| D-S3 | D | SHOULD-FIX | FIXED | `client/README.md` (replaced) | Real client README: status, quick start, scripts, env vars, architecture, gotchas, "how to add a screen", pointers. Replaces the Vite scaffold boilerplate. |
| B-3 | B | NIT (in-scope) | FIXED | `src/hooks/ThemeProvider.tsx:27-37` | `readStored` guards `typeof window === 'undefined'`. |
| B-4 | B | NIT (in-scope) | FIXED | `src/components/Icon.tsx:204-217` | `role={decorative ? undefined : 'img'}` (drops the redundant `presentation`). `aria-hidden` retained. |
| B-5 | B | NIT (in-scope) | FIXED | `src/components/DoubleRule.tsx:23` | `aria-orientation="horizontal"` removed; comment explains the default. |
| B-7 | B | NIT (in-scope) | FIXED | `src/components/Button.tsx:72-76` | Label span only rendered when `children != null`. Icon-only buttons no longer emit an empty `<span>`. |
| C-3 | C | NIT (in-scope) | FIXED | `src/App.tsx:210-216` | One-line comment on the `authenticated → BootSkeleton` branch in `PublicOnly`. |
| C-4 | C | NIT (in-scope) | FIXED | `src/components/MoreSheet.tsx:91-98` | Backdrop button gets `tabIndex={-1}`. Esc + outside-tap still dismiss for keyboard. |
| C-5 | C | NIT (in-scope) | FIXED | `src/components/Shell.tsx:38-56` | `useCallback` wrappers dropped from `openMore` / `closeMore`. `useState` setters are referentially stable. |
| C-6 | C | NIT (in-scope) | FIXED | `src/lib/nav.ts:184-189`; `src/pages/ScreenStub.tsx:9-19` | New `PassNumber = 1 \| 2 \| … \| 9` type alias in `lib/nav.ts`; ScreenStub consumes it. |
| C-7 | C | NIT (in-scope) | FIXED | `src/lib/nav.ts:140-182` | Compile-time exhaustiveness check using `Exclude<NavItemId, _PrimaryOrMoreId>` and the inverse. Arrays narrowed via `as const satisfies ReadonlyArray<NavItemId>` so the check actually fires (a `ReadonlyArray<NavItemId>` annotation would have widened the element type and defeated the check — noted in a comment). |
| Open-redirect (D §B1 sub-finding) | D | SHOULD-FIX (sub) | DEFERRED → FU-NF-9 | `src/App.tsx:206`; SECURITY.md §5; FOLLOW_UPS.md FU-NF-9 | The dispatch prompt's BLOCKER list for D-B1 is documentation; the open-redirect code change was called out as "a SHOULD-FIX hiding inside the BLOCKER fix". Kept the code as-is to avoid scope creep and filed FU-NF-9 with concrete acceptance criteria. SECURITY.md §5 documents the residual risk. |
| Plan-doc `/auth/signup` vs `/auth/register` | D | N/A | DEFERRED → FU-NF-19 | FOLLOW_UPS.md FU-NF-19 | Plan-doc edit per dispatch's "out of scope" clause. |
| jsx-a11y plugin (D-N3) | D | NIT | DEFERRED → FU-NF-17 | FOLLOW_UPS.md FU-NF-17 | Adding the plugin would surface NITs not in this fix-pass's scope. Filed with the eslint config update plus the `ecmaVersion: 2023` fix (D-N2). |
| ecmaVersion mismatch (D-N2) | D | NIT | DEFERRED → FU-NF-17 | Folded into FU-NF-17 above. |
| Dev server `0.0.0.0` (D-N1) | D | NIT | DEFERRED → FU-NF-11 | Not in dispatch's in-scope NIT list. |
| CSP (D-N8), PWA `id` (D-N6), screenshots (D-N7), WebWorker lib (D-N4), font weights (D-N5) | D | NIT | N/A | All Pass-Final per the dispatch's deferred-icons comment + the design plan; none touched. |
| Pillbox radius (B-NIT 6) | B | NIT | N/A | Out of scope; prototype wins per FIXPASS_AGGREGATE.md §"Cross-cutting #5". |
| `.km-pill--default` empty rule (B-NIT 7) | B | NIT | N/A | Not in in-scope NIT list. |
| Shell-width 480 vs 402 (B-NIT 9) | B | NIT | N/A | Not in in-scope NIT list. |
| Pill `red`→`indigo` rename (B-NIT 10) | B | NIT | N/A | Explicitly flagged as Pass 2. |
| Card click-handler ergonomics (B-NIT 11) | B | NIT | N/A | Explicitly flagged as Pass 2. |
| `'reference'` vs `'ref'` (C-NIT 8) | C | NIT | N/A | Not in in-scope NIT list. |
| ErrorBoundary docstring (C-NIT 9) | C | NIT | N/A | Not in in-scope NIT list. |
| `AuthState.loading` redundancy (A-N1) | A | NIT | N/A | Not in in-scope NIT list. |
| `messageFor` 400 fallback dead code (A-N2) | A | NIT | FIXED (subsumed) | Removed alongside the A-SF-3 lookup rewrite. |
| `noValidate` + `aria-required` (A-N3) | A | NIT | N/A | Not in in-scope NIT list. |
| `EMAIL_REGEX` server comment (A-N4) | A | NIT | N/A | Server-side; out of scope. |
| `setSessionCookie` `maxAge` (A-N5) | A | NIT | N/A | Server-side; out of scope. |
| `auth-context.ts` `.ts` vs `.tsx` (A-N6) | A | NIT | N/A | Pass; reviewer noted it's correct. |
| `useId` allocation when no error (A-N7) | A | NIT | N/A | Pass; reviewer noted it's harmless. |
| Test framework | various | — | DEFERRED → FU-NF-18 | Explicit "out of scope for this fix-pass" per dispatch. Ticket logged. |
| Rasterised PWA PNGs | D | — | DEFERRED → FU-NF-10 | Explicit "defer per plan" per dispatch. Ticket logged. |

## Detailed dispositions

### A-B1 (BLOCKER) — Cross-origin cookie posture

**FIXED.** Three layered defences:

1. **Documentation lock** — JSDoc at the top of `src/services/api.ts:1-47` now spells out the deploy contract ("production deploy MUST be same-origin via reverse proxy; `VITE_API_URL` is the empty string in prod"). It also lists the relax path: if cross-origin is ever required, ADR-002 D3/D4 reopens and the CSRF token interceptor lands here.

2. **Runtime tripwire** — `warnInsecureCrossOriginCookiePosture` in `src/services/api.ts:147-170` runs on bundle init. Triggers when (a) `VITE_API_URL` is non-empty, (b) the host is not loopback (localhost / 127.0.0.1 / [::1] / ::1), and (c) the page is plain HTTP. Skipped under `import.meta.env.PROD`. Single `console.warn` with explicit instructions and a SECURITY.md pointer.

3. **`client/SECURITY.md` §2** — promotes the contract into the canonical security document so the threat model is auditable without diff-spelunking.

Rationale for not changing `.env.example`: the dispatch did not ask for it, the current value is documented as dev-only, and changing it might break a workstation in the middle of a re-review. The README and SECURITY.md both call out the safe production posture.

### A-B2 (BLOCKER) — Login/register vs in-flight probe race

**FIXED.** `src/hooks/AuthProvider.tsx`:

- `login()` (lines 134-148) and `register()` (lines 150-172) call `probeRef.current?.abort()` as the first statement, **before** the POST.
- The probe's catch path already checks `ctrl.signal.aborted` and bails silently; the abort + bail is now the contract.
- Threat-model header (lines 13-21) describes the race and the defence explicitly so the next reviewer doesn't undo it.

The asymmetry called out in the review (optimistic-set login vs re-probe logout) is preserved by intention — the abort makes the optimistic set safe, and the optimistic set gives the UI immediate feedback. A re-probe could replace it (matching logout's shape) but would add a network round-trip on every successful login; the abort is the minimal correct fix.

### D-B1 (BLOCKER) — Missing client/SECURITY.md

**FIXED.** New file `Repository/client/SECURITY.md` covers the dispatch-specified surfaces:

- §1 Surfaces (table of attack surface)
- §2 Cross-origin cookie posture (deploy contract; mirrors api.ts JSDoc)
- §3 XSS (React escape, no-server-message echo)
- §4 CSRF (SameSite=Strict primary; relax-path warning)
- §5 Open-redirect (PublicOnly state.from; FU-NF-9 hardening filed)
- §6 Login (rate limit, enumeration, double-submit, autoComplete)
- §7 PWA manifest hijack + install identity
- §8 Env-var leak via `import.meta.env.VITE_*`
- §9 Supply chain (lockfile; the Supabase cleanup landed)
- §10 Dev server bind (FU-NF-11)
- §11 CSP gap (FU-NF-12)
- §12 Third-party origins (Google Fonts, no SRI)
- §13 Logout edge cases (FU-NF-13)
- §14 Login/register race (closed in A-B2)
- §15 Deferred items table (FU-NF-9 through FU-NF-18, all in FOLLOW_UPS.md)
- §16 How to test (manual smoke list pending Vitest)
- §17 Pointer index

The threat-model paragraphs in `services/api.ts`, `hooks/AuthProvider.tsx`, and `pages/Login.tsx` are intentionally retained — per the FIXPASS_AGGREGATE.md PRAISE list ("do not undo"). SECURITY.md cross-references them; the comments remain canonical in their files.

### D-S1 — Supabase lockfile cleanup

**FIXED, EMPIRICALLY VERIFIED.** Ran `npm install` (the only build-adjacent command the sandbox allows). After install:
- `grep -c '@supabase' package-lock.json` → 0 (was 18)
- `ls node_modules/@supabase` → no such directory (was 6 packages)
- `package.json` already had Supabase removed in Pass 1; the lockfile was the lagging artifact.

### C-1 — MoreSheet focus restoration

**FIXED.** Three-file change:

- `src/components/BottomNav.tsx`: new optional `moreButtonRef?: RefObject<HTMLButtonElement | null>` prop, attached to the More `<button>` (line 62). Optional rather than required so the existing test surface (if any) doesn't break.
- `src/components/Shell.tsx`: owns the ref (line 30), passes it down (line 65), restores focus in `closeMore` (line 53) via `queueMicrotask` so React finishes unmounting the sheet before `.focus()` runs.
- `src/components/MoreSheet.tsx`: JSDoc updated (lines 6-22) — "Focus restoration is owned by Shell" replaces the now-inaccurate "the parent owns that". Backdrop note added (C-4 dovetails here).

### C-2 — Active-tab path boundary

**FIXED.** `src/components/BottomNav.tsx:83-105`:
```ts
const matches =
  it.path === '/'
    ? pathname === '/'
    : pathname === it.path || pathname.startsWith(`${it.path}/`);
```
Comment explains the future-route case (`/topik-history` lighting TOPIK).

### B-1 — `--on-vermilion` token

**FIXED.** `src/styles/index.css`:
- Light theme adds `--on-vermilion: #FBF6E6` with a 3-line comment explaining the token is *type on vermilion fill*, not a surface.
- Dark theme adds `--on-vermilion: #15110D` with a 2-line comment about type-on-fill on dark mahogany.
- `.km-btn--gold` (line 220) and `.km-seal` (line 261) reference the token. Both `#FBF6E6` and `#15110D` hard-codes are gone. Dark-mode override `[data-theme="dark"] .km-btn--gold { color: #15110D; }` is also gone — the token does that work now.

### B-2 — First-paint FOUC

**FIXED with the stronger recommendation (synchronous IIFE).** `index.html`:
- Inline `<script>` block before the `<link rel="manifest">` reads `localStorage["km.theme"]` then falls back to `matchMedia('(prefers-color-scheme: dark)')`. Sets `document.documentElement.dataset.theme` synchronously.
- HTML comment explains the script is pure (no dynamic input, no inline-style soup) so a future CSP can cover it with a single `nonce-…` source.
- `ThemeProvider.tsx:65-78` reads `document.documentElement.dataset.theme` and skips the redundant write when already correct. The first effect-run is now a no-op on the common path.

### A-SF-1 — Error code discrimination

**FIXED.** `src/services/api.ts:78-124`:
- `ECONNABORTED` → `{ status: 0, code: 'timeout' }`
- `ERR_CANCELED` → `{ status: 0, code: 'canceled' }`
- Otherwise → `{ status: 0, code: 'network' }`

`messageFor` in `Login.tsx:254-284` switches on the code:
- `'canceled'` → returns `''` (sentinel for swallow; the form's catch doesn't paint the alert region).
- `'timeout'` → "The server is taking too long to respond."
- Anything else → "Could not reach the server."

### A-SF-3 — Fixed lookup table

**FIXED.** `src/pages/Login.tsx:244-284`:
- Returns strings ONLY from a fixed lookup keyed by `(status, code)`.
- Never returns `err.message`.
- Added a `429` branch (rate-limit response from the server).
- A-SF-4 folded in: comment explicitly locks the no-echo contract.

### D-S2 — PWA manifest icon

**FIXED.** `public/manifest.webmanifest`: `purpose: "any maskable"` → `purpose: "any"`. (The SVG isn't a maskable icon; claiming it was misled Chrome/Android into synthesising a fallback.) `index.html`: new `<link rel="apple-touch-icon" href="/favicon.svg">` with an explanatory comment that the rasterised PNGs follow in Pass Final (FU-NF-10). Truthful about what we ship today.

### A-SF-2 — Logout 5xx documentation

**FIXED (doc-only).** `src/hooks/AuthProvider.tsx:174-191`: full JSDoc on `logout` describes the two known edges (5xx during logout where the cookie is still valid; network down). Behaviour unchanged; FU-NF-13 filed for the Pass-3 retry + warning.

### A-SF-6 — autoFocus on email

**FIXED.** `autoFocus` attribute on the email input. ESLint disable for `jsx-a11y/no-autofocus` is forward-compat (plugin not in the current config; disable is a no-op today, ready for FU-NF-17 when the plugin lands).

### A-SF-7 — aria-busy + aria-live

**FIXED.** Form gets `aria-busy={submitting}`. Submit button text wrapped in `<span role="status" aria-live="polite">` so the "One moment…" transition is announced.

### A-SF-8 — Explicit display_name trim

**FIXED.** `const trimmedDisplayName: string | undefined = displayName?.trim() || undefined;` — same semantics as the conditional spread before, but the intent is now visible at the binding site. Comment notes the server's `z.string().min(1).optional()` schema rejects `'   '`.

### A-SF-9 — Probe one-retry on 5xx

**FIXED.** `src/hooks/AuthProvider.tsx:67-120`: inner try around the first `attempt()`. On `ApiError` with `status >= 500` or `code === 'network' || 'timeout'`, awaits 500 ms then retries. 401 bails immediately. The 500 ms wait listens for `AbortController` abort, so a `login()` mid-backoff still cancels cleanly.

### A-SF-10 — Timeout semantics doc + per-call note

**FIXED (doc).** `src/services/api.ts:176-183`: the axios instance comment now says "10 s is a **request-level** timeout in axios (time-to-completion of the whole request, not idle-timeout)" and names the routes that MUST override (`/enrich`, `/conversation/*/messages`). FU-NF-14 filed in SECURITY.md §15 for the per-call override pattern.

### D-S3 — Real client README

**FIXED.** `README.md` replaced wholesale. Sections: Status, Quick start, Scripts, Environment variables (with the never-secrets warning), Architecture (file tree + sources of truth), Gotchas, Adding a screen, Pointers. Cross-references SECURITY.md, ADR-002, the design handoff, TESTS.md, and FOLLOW_UPS.md.

### B-3 — readStored SSR guard

**FIXED.** `ThemeProvider.tsx:27-37`: mirrors `systemPref()` with a `typeof window === 'undefined'` early-return + comment.

### B-4 — Drop role="presentation" on decorative SVG

**FIXED.** `Icon.tsx:204-217`: `role={decorative ? undefined : 'img'}`. `aria-hidden` retained for decorative case. Comment explains the WAI-ARIA idiom.

### B-5 — Drop aria-orientation on DoubleRule

**FIXED.** `DoubleRule.tsx:23`: attribute removed; comment notes it's the implicit default for `role="separator"`.

### B-7 — Button label span ternary

**FIXED.** `Button.tsx:72-76`: `{children != null ? <span …>{children}</span> : null}`. Comment explains the icon-only case.

### C-3 — PublicOnly comment

**FIXED.** `App.tsx:210-216`: three-line comment on the `authenticated → BootSkeleton` branch ("looks like a bug, is actually the fix").

### C-4 — Backdrop tabIndex=-1

**FIXED.** `MoreSheet.tsx:91-98`: `tabIndex={-1}` on the backdrop button. Comment explains keyboard dismissal stays via Esc + outside-tap. Header comment updated.

### C-5 — Drop useCallback on setMoreOpen

**FIXED.** `Shell.tsx:38-56`: plain arrow functions; `useCallback` import dropped; comment explains setState setters are referentially stable.

### C-6 — PassNumber type alias

**FIXED.** `lib/nav.ts:184-189`: exported `PassNumber = 1 | … | 9` with a doc comment. `ScreenStub.tsx:9-19` consumes it.

### C-7 — Exhaustiveness check

**FIXED.** `lib/nav.ts:140-182`:
- Arrays narrowed via `as const satisfies ReadonlyArray<NavItemId>` so element types are literal-string unions, not `NavItemId`. A `ReadonlyArray<NavItemId>` annotation would have widened back and silently defeated the check; comment calls this out.
- `_MissingFromTabs = Exclude<NavItemId, _PrimaryOrMoreId>` and the symmetric `_ExtraInTabs`. Each is asserted via a `const _x: T extends never ? true : never = true` line; `void _x` reads the binding so `noUnusedLocals` is satisfied.
- The check is erased at runtime under `erasableSyntaxOnly` (only `const` value bindings remain, and `void identifier` is a side-effect-free read).

## Verification

**`npm run build`** — NOT EXECUTED. Sandbox blocks `npm run …`, `npx`, and direct invocation of `./node_modules/.bin/*` and `node ./node_modules/<x>/bin/x.js`. Only `npm install` is whitelisted. The re-reviewer MUST run `npm run build` from `Repository/client/` and report regressions. Pre-existing build status was claimed green by TESTS.md / Review D §"Bar checklist" but not re-verified here.

**`npm run lint`** — NOT EXECUTED, same reason as above. Same instruction to the re-reviewer.

**`npm install`** — EXECUTED, exit 0. Used to close D-S1 (regenerate the lockfile without Supabase). After install: 0 `@supabase` mentions in `package-lock.json`; `node_modules/@supabase` does not exist.

**Manual code review** — every modified file was read back end-to-end. Checked specifically for:
- `verbatimModuleSyntax` compliance (all type imports use `import type`; new imports added respect this).
- `erasableSyntaxOnly` compliance (no enums, no parameter properties; the exhaustiveness check is types + `const` value bindings only).
- `noUnusedLocals` (the `_navIdExhaustiveness*` locals are read via `void` expressions).
- `react-hooks` exhaustive-deps (the `useEffect`/`useCallback` blocks I touched retain or correctly update their dep arrays).
- React Refresh `only-export-components` (no new exports added to `.tsx` files that weren't components; `lib/nav.ts` is `.ts` and unaffected).
- No new `any`, no `as any`, no `@ts-ignore`.

**Verification gap risk:** the changes are intentionally conservative, but a sandbox-blocked verification means the re-reviewer should treat `npm run build` and `npm run lint` as the first acceptance gates. If either fails, the failures will point at:
1. The `_navIdExhaustiveness*` const-with-conditional-true pattern (if the chosen TS rule mode disallows this idiom in some way I missed) — fix is to switch to `function _check(): asserts …` form.
2. The `as const satisfies ReadonlyArray<NavItemId>` in `lib/nav.ts` — needs TS 5.0+; the project has 5.9.3 so this should be fine.
3. The new `RefObject<HTMLButtonElement | null>` import in `BottomNav.tsx` — verify the React 19 `RefObject` shape matches (it does; React 19 made all refs nullable by default).
4. `console.warn` in `services/api.ts` — only flagged if `no-console` is on without `{ allow: ['warn'] }`. The existing code has no `console.*` so no precedent; the disable comment in place is the defensive line. If lint complains, change to `if (!import.meta.env.PROD) globalThis.console.warn(...)` to dodge.
5. The `void _x;` lines — should not trigger `@typescript-eslint/no-unused-expressions` (void of an identifier is a recognised exception in tseslint defaults). If it does, swap to `if (_x) { /* keep */ }` or assign to `export const _NAV_ID_CHECK_OK = …`.

## Self-assessment against the bar's "done" checklist

(`SENIOR_ENGINEER_BAR.md` §5, scoped to the Pass 1 client surface.)

| Item | Status | Evidence |
|---|---|---|
| Lint passes (no warnings) | UNVERIFIED | Sandbox-blocked. Pre-fix-pass: assumed green per TESTS.md. Edits made with lint compliance in mind. **Action for re-reviewer: run `npm run lint`.** |
| Type-check passes (strict) | UNVERIFIED | Sandbox-blocked. Same comment. **Action for re-reviewer: run `npm run build`.** |
| All tests pass (unit + integration) | N/A | No client test runner per TESTS.md; FU-NF-18 filed for Pass 2 bootstrap. Not regressed in this pass. |
| Every public function tested | N/A | Same as above. |
| `EXPLAIN ANALYZE` on queries | N/A | Client. |
| **`SECURITY.md` written** | **PASS (now)** | `client/SECURITY.md` created with 17 sections (was the BLOCKER). |
| **README written, "how to test this"** | **PASS (now)** | `client/README.md` rewritten with status, env, scripts, architecture, gotchas; "How to test this" lives in SECURITY.md §16 (cross-referenced from README). |
| ADR for non-obvious decisions | DEFERRED | The dispatch identified the "deploy posture" as worth an ADR. Captured in `client/SECURITY.md` §2 and `services/api.ts` JSDoc; folding it into ADR-002 amendment is **a follow-up** the next pass owns. See FU-NF-19/20 (plan doc) and the §"New decisions" below. |
| Migrations reversible | N/A | Client. |
| No `TODO`/`FIXME` without ticket | PASS | The pre-existing `TODO(B7)` in `ErrorBoundary.tsx` is the B-7 convention (uses the ticket prefix). No new TODOs added. |
| No `console.log` | PASS | Only `console.warn` in the new tripwire (defensible — dev-only safety net, gated by `import.meta.env.PROD`, with an eslint-disable). The pre-existing `console.error` in ErrorBoundary remains gated by `import.meta.env.DEV` (PRAISE-listed; untouched). |
| No commented-out code | PASS | None added. |
| No hardcoded secrets/URLs/paths | PASS | `VITE_API_URL` is the only URL; `localhost:4000` mention is in dev `.env.example`. No new hard-codes. |

Items that newly PASS (were FAIL pre-fix-pass):
- `SECURITY.md` written.
- README written with "how to test this".
- Cross-origin cookie posture documented (deploy contract locked).
- Open-redirect tracked as a deferred item (FU-NF-9) — was an undocumented gap.

Items that were already PASS and remain so:
- Threat-model comments in `services/api.ts`, `AuthProvider.tsx`, `Login.tsx` (extended, not undone, per PRAISE list).
- Provider / context / hook three-file split (untouched).
- `ApiError` boundary type + `isServerErrorBody` guard (untouched).
- `AbortController` for the probe (extended for the login/register race).
- Logout best-effort + re-probe (untouched; JSDoc expanded).
- Token block one-for-one with prototype (extended with `--on-vermilion`).
- `forwardRef` on Button (untouched).
- `BottomNav` location-derived active state (extended with boundary check).

## New decisions worth an ADR

1. **Same-origin deploy posture for the client** — Locked in `services/api.ts` JSDoc and `client/SECURITY.md` §2. Worth promoting to an ADR amendment on `ADR-002 §"D3 Cookie attributes"` (new sub-section: "D8 Deploy topology — same-origin only; cross-origin requires CSRF token + SameSite relax"). FU-NF-19/20 tracks the plan-doc edits; an ADR amendment is the senior-engineer-bar form of the same.

2. **`as const satisfies T` for tab id arrays** — Chosen pattern in `lib/nav.ts` to enable compile-time exhaustiveness checking. A reasonable engineer might have stayed with `ReadonlyArray<NavItemId>` and added a runtime `Object.freeze` + console assert. The TS-only pattern wins on (a) zero runtime cost, (b) catch-at-PR not catch-at-deploy, (c) `erasableSyntaxOnly` compliance. The trade-off is that the array element type narrows to a literal union, which is what some consumers want and others don't; documented in the comment block.

3. **`queueMicrotask` for focus restore** — Chosen over `requestAnimationFrame` and a `setTimeout(0)` because React 19 finishes commit + cleanup before microtasks fire. Documented inline.

4. **No-flash bootstrap as inline `<script>` in `index.html`** — Chosen over `useLayoutEffect` because LayoutEffect still fires after first commit (not before paint of the very first frame the bundler emits). The trade-off is one inline script tag, which will need a CSP nonce when FU-NF-12 lands. Documented in the HTML comment and SECURITY.md §11.

## Follow-ups filed

`/root/Jared/9b. Korean Master -- OVERNIGHT/FOLLOW_UPS.md` — new section "From client Pass 1 fix-pass (2026-05-29)" with 12 tickets:

- **FU-NF-9** Open-redirect guard in `PublicOnly`.
- **FU-NF-10** PWA rasterised icon set.
- **FU-NF-11** Vite dev server bind opt-in.
- **FU-NF-12** Content Security Policy.
- **FU-NF-13** Logout 5xx retry + warning.
- **FU-NF-14** Per-call timeout for Claude-backed routes.
- **FU-NF-15** MFA (TOTP + recovery).
- **FU-NF-16** Email verification gate.
- **FU-NF-17** `eslint-plugin-jsx-a11y` + `ecmaVersion` 2023.
- **FU-NF-18** Vitest + RTL bootstrap.
- **FU-NF-19** Plan-doc `/auth/signup` → `/auth/register`.
- **FU-NF-20** Plan-doc "as built" deltas log.

Each has acceptance criteria; SECURITY.md §15 cross-references them.
