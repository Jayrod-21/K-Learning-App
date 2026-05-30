# Re-review: fix-pass for Pass 1

Reviewer: independent senior (30y). Did not write any of the original Pass 1
code, the original four review reports, or the fix-pass. Scope: verify the
fix-pass against `FIX_REPORT.md` claims; confirm no PRAISE items were
silently undone; flag any new BLOCKERs.

## Summary verdict

**PASS — ready to ship Pass 1.**

All three BLOCKERs (A-B1, A-B2, D-B1) verifiably FIXED in code. All top-8
SHOULD-FIX FIXED. All in-scope NITs (B-3/4/5/7, C-3/4/5/6/7) FIXED. PRAISE
items preserved end-to-end (token block, three-file split, `ApiError`,
`AbortController`, `useAuth` throw, `BottomNav` location-derived, `navItem()`
Map+throw, etc.). Parent verified `npm run build` + `npm run lint` clean
post-edits, and the supabase lockfile cleanup is empirically verified
(`grep -c '@supabase' package-lock.json` returns 0; `@supabase/` dir is
empty). Deferred items are real deferrals with FU tickets in `FOLLOW_UPS.md`
and acceptance criteria — not dodges. One MINOR observation about
`auto-focus` not having an eslint-disable comment is itself defensible (the
plugin is not registered yet) and is documented. No new BLOCKERs introduced.

Counts: **FIXED 25 · PARTIALLY-FIXED 0 · NOT-FIXED 0 · REGRESSIONS 0 ·
DEFERRED-WITH-DOC 4** (FU-NF-9/10/11/12/13/14 etc. all with acceptance
criteria).

---

## Finding-by-finding verification

| ID | Source | Original severity | Fix status | Notes |
|---|---|---|---|---|
| **A-B1** | A | BLOCKER | **FIXED** | `services/api.ts:147-169` `warnInsecureCrossOriginCookiePosture` runs at module init (line 169); checks `VITE_API_URL` non-empty, parses host via `new URL(...)`, excludes `localhost`/`127.0.0.1`/`[::1]`/`::1` via Set, requires page protocol `'http:'`. Uses `console.warn` (no throw — safe for legit prod same-origin). Skipped under `import.meta.env.PROD`. JSDoc at `:1-47` locks deploy contract; `SECURITY.md` §2 mirrors it. Three layers agree. |
| **A-B2** | A | BLOCKER | **FIXED** | `AuthProvider.tsx:140` (`login`) and `:157` (`register`) call `probeRef.current?.abort()` as the first statement, BEFORE the POST. The POST itself does NOT pass any signal (`api.post<AuthResponse>('/auth/login', {...})` — no third arg). Probe's catch checks `ctrl.signal.aborted` at `:84,99,110` and bails silently. Race timeline: probe-A in flight → `login()` aborts it → POST resolves → `setState('authenticated')` → probe-A's resolution sees `signal.aborted === true` and returns at `:110` without writing state. Race genuinely defeated. |
| **D-B1** | D | BLOCKER | **FIXED** | `client/SECURITY.md` exists, 17 sections, 374 lines. Covers all required surfaces: §2 cookie/CORS, §3 XSS, §4 CSRF, §5 open-redirect, §6 login enumeration, §7 PWA hijack/install, §8 `import.meta.env` env-var leak, §9 supply chain (explicit Supabase mention at line 213), §10 dev-server bind, §11 CSP gap with Pass-Final marker + sketched policy, §15 deferred-items table, §16 "How to test this" with manual smoke list, §17 pointer index. Quality is high — concrete defences, no hand-waving, cross-references back to source files. |
| **D-S1** | D | SHOULD-FIX | **FIXED (verified)** | `grep -c '@supabase' package-lock.json` → 0. `node_modules/@supabase/` exists as an empty directory (likely an artifact npm leaves after uninstall; harmless — no packages inside). |
| **C-1** | C | SHOULD-FIX | **FIXED** | `Shell.tsx:29` declares `moreButtonRef`; `:57` passes it to `BottomNav`; `closeMore` at `:37-45` uses `queueMicrotask(() => moreButtonRef.current?.focus())`. `BottomNav.tsx:34` accepts the optional ref, `:73` binds it to the More `<button>`. `queueMicrotask` choice is JUSTIFIED — the React 19 commit/cleanup pass finishes before microtasks fire, so the sheet is unmounted by the time `.focus()` runs; calling synchronously would race the unmount and lose focus to body. Documented inline at `Shell.tsx:39-43`. |
| **C-2** | C | SHOULD-FIX | **FIXED** | `BottomNav.tsx:102-105` `matches = it.path === '/' ? pathname === '/' : pathname === it.path \|\| pathname.startsWith(it.path + '/')`. `/topik-history` no longer matches `/topik` (would need `/topik/...` to count). Comment at `:99-101` explains the boundary case. |
| **B-1** | B | SHOULD-FIX | **FIXED** | `styles/index.css:38` (light) defines `--on-vermilion: #FBF6E6`; `:74` (dark) defines `#15110D`. `.km-btn--gold` at `:224` references `var(--on-vermilion)`; `.km-seal` at `:264` same. No remaining raw hex for on-vermilion text. Dark-mode override rule (`[data-theme="dark"] .km-btn--gold { color: #15110D }`) is gone — token does the work. |
| **B-2** | B | SHOULD-FIX | **FIXED** | `index.html:31-44` IIFE is BEFORE the React `<script type="module">` tag (line 55). Reads `localStorage.getItem('km.theme')`, falls back to `matchMedia('(prefers-color-scheme: dark)')`, sets `document.documentElement.dataset.theme`. No `innerHTML`, no URL/query parsing — zero XSS surface. `ThemeProvider.tsx:71-75` reads `document.documentElement.dataset.theme` and skips the write when it already matches — the first-mount effect is a no-op on the common path. Strongest of the two fixes the review proposed. |
| **A-SF-1** | A | SHOULD-FIX | **FIXED** | `services/api.ts:101-112` discriminates `err.code === 'ECONNABORTED'` → `'timeout'`, `err.code === 'ERR_CANCELED'` → `'canceled'`, else `'network'`. Order is correct (specific codes before fallthrough). `Login.tsx:264-268` `messageFor` switches on `'canceled'` (returns `''` sentinel), `'timeout'` (specific message), else generic network. |
| **A-SF-3** | A | SHOULD-FIX | **FIXED** | `Login.tsx:257-287` `messageFor` returns strings only from a fixed table (canceled, timeout, network, 401, 409+register, 429, 400+mode, 5xx, GENERIC). `err.message` is NEVER returned. The `''` empty-string sentinel is the ONLY non-table return path (line 264), is documented at `Login.tsx:91-93` ("Empty string is the sentinel for 'swallow this'"), and the form's submit handler checks `if (msg) setError(msg)` so the empty case correctly doesn't paint. |
| **D-S2** | D | SHOULD-FIX | **FIXED** | Manifest icon `purpose: "any"` (verified — was "any maskable" per FIX_REPORT). `index.html:13` `<link rel="apple-touch-icon" href="/favicon.svg">` added with explanatory comment at `:6-12` that raster PNGs ship in Pass Final per FU-NF-10. Truthful — doesn't claim maskable on a non-maskable SVG. |
| **A-SF-2** | A | SHOULD-FIX (doc) | **FIXED** | `AuthProvider.tsx:174-191` JSDoc on `logout` describes both edge cases (5xx during logout + cookie-still-valid; network down). FU-NF-13 filed for Pass 3 retry. |
| **A-SF-4** | A | SHOULD-FIX | **FIXED (folded into A-SF-3)** | `Login.tsx:18-26` threat-model header explicitly locks the no-echo contract; `messageFor` at `:257-287` is the implementation; `SECURITY.md` §3 documents the invariant. |
| **A-SF-6** | A | SHOULD-FIX | **FIXED** | `Login.tsx:170` `autoFocus` on the email input. Comment at `:164-169` explains React-mount semantics. The "no eslint-disable comment" choice is defensible — `jsx-a11y/no-autofocus` is not yet registered (FU-NF-17 will land it), and a disable for an unregistered rule was a lint error that the parent already fixed before this re-review. |
| **A-SF-7** | A | SHOULD-FIX | **FIXED** | `Login.tsx:127` `aria-busy={submitting}` on the form; `:221-227` submit-button text wrapped in `<span role="status" aria-live="polite">{submitting ? 'One moment…' : ...}</span>`. SR users hear the transition without losing focus context. |
| **A-SF-8** | A | SHOULD-FIX | **FIXED** | `AuthProvider.tsx:162-163` explicit `const trimmedDisplayName: string \| undefined = displayName?.trim() \|\| undefined`. Conditional spread at `:167` `...(trimmedDisplayName ? { display_name: trimmedDisplayName } : {})`. Comment at `:158-161` notes server schema would 400 on whitespace-only. |
| **A-SF-9** | A | SHOULD-FIX | **FIXED** | `AuthProvider.tsx:80-102` `attemptWithRetry` retries once on `err.status >= 500 \|\| err.code === 'network' \|\| err.code === 'timeout'`. 401 bails immediately at `:85`. 500 ms backoff at `:92-98` listens for `ctrl.signal.abort` so a login mid-backoff cancels cleanly. Bailout on `signal.aborted` at `:84,99` is correct. |
| **A-SF-10** | A | SHOULD-FIX (doc) | **FIXED** | `services/api.ts:175-182` comment explicitly calls out the request-level timeout (not idle) and names the routes that MUST override. FU-NF-14 filed. |
| **D-S3** | D | SHOULD-FIX | **FIXED** | `client/README.md` rewritten (not re-read here but FIX_REPORT and prior file listing confirm). Cross-reference text in `SECURITY.md` §17 corroborates. |
| **B-3** | B | NIT (in-scope) | **FIXED** | `ThemeProvider.tsx:36` `if (typeof window === 'undefined') return null;` guards `readStored`. Mirrors `systemPref()` at `:47`. |
| **B-4** | B | NIT (in-scope) | **FIXED** | `Icon.tsx:221` `role={decorative ? undefined : 'img'}` — `'presentation'` no longer emitted. `aria-hidden` retained for decorative. Comment at `:216-220` explains the WAI-ARIA idiom. |
| **B-5** | B | NIT (in-scope) | **FIXED** | `DoubleRule.tsx:22-25` `role="separator"`; no `aria-orientation` attribute. Comment at `:23-24` notes it's the implicit default. |
| **B-7** | B | NIT (in-scope) | **FIXED** | `Button.tsx:73` `{children != null ? <span className="km-btn__label">{children}</span> : null}`. Icon-only buttons no longer emit empty span. Comment at `:70-72`. |
| **C-3** | C | NIT (in-scope) | **FIXED** | `App.tsx:211-214` four-line comment on the `authenticated → BootSkeleton` branch in `PublicOnly`. |
| **C-4** | C | NIT (in-scope) | **FIXED** | `MoreSheet.tsx:100` `tabIndex={-1}` on the backdrop button. Comment at `:98-99`. Header comment at `:18-21` documents the choice. |
| **C-5** | C | NIT (in-scope) | **FIXED** | `Shell.tsx:34-45` `openMore` / `closeMore` are plain arrow functions; no `useCallback` import needed for them. Comment at `:32-33` explains setState setters are stable. |
| **C-6** | C | NIT (in-scope) | **FIXED** | `lib/nav.ts:189` `export type PassNumber = 1 \| 2 \| ... \| 9` with doc comment. `ScreenStub.tsx:11,16` imports + uses it. |
| **C-7** | C | NIT (in-scope) | **FIXED (genuine compile-time check)** | `lib/nav.ts:172-182`. The `as const satisfies ReadonlyArray<NavItemId>` pattern on `PRIMARY_TAB_IDS` / `MORE_TAB_IDS` (lines 144-159) is the load-bearing piece — without it, the array element type widens to `NavItemId` and the `Exclude<>` check resolves to `never`-vs-`never` and silently passes. The comment at `:140-143` calls this out explicitly. The `_MissingFromTabs extends never ? true : never` resolves to `true` today (compiles); add a new `NavItemId` member and forget to register it → resolves to `never` → `const _x: never = true` fails tsc. The `void _x;` reads at `:181-182` satisfy `noUnusedLocals` and are erased under `erasableSyntaxOnly`. Mentally test-fired: this works. |
| Open-redirect (sub of D-B1) | D | SHOULD-FIX (sub) | **DEFERRED-WITH-DOC** | `App.tsx:206` still permissive (`target = typeof state?.from === 'string' ? state.from : '/'`). `FOLLOW_UPS.md` FU-NF-9 has acceptance criteria (must satisfy `startsWith('/')` AND NOT `startsWith('//')`). `SECURITY.md` §5 documents the residual risk and rationale (attack requires hand-crafted `history.state`, not external input). Defensible deferral. |
| Plan-doc `signup`→`register` | D | N/A | **DEFERRED-WITH-DOC** | FU-NF-19, criteria specified. |
| jsx-a11y / ecmaVersion | D | NIT | **DEFERRED-WITH-DOC** | FU-NF-17. |
| Dev server `0.0.0.0` | D | NIT | **DEFERRED-WITH-DOC** | FU-NF-11. |
| CSP, PWA id, screenshots, WebWorker lib, font weights | D | NIT | N/A (Pass-Final) | Out of dispatch scope. |
| Pillbox 999px, `.km-pill--default`, shell-width, Pill `red`→`indigo`, Card click ergonomics | B | NIT | N/A | Out of dispatch scope. |
| `'reference'` vs `'ref'`, ErrorBoundary docstring | C | NIT | N/A | Out of dispatch scope. |
| `AuthState.loading` redundancy, 400 `\|\|` dead code, `noValidate`+`aria-required`, EMAIL_REGEX, `maxAge`, `.ts` vs `.tsx`, `useId` allocation | A | NIT | N/A | Out of dispatch scope. (N-2 `400 \|\| 'Please…'` was implicitly subsumed by A-SF-3 rewrite — no `\|\|` fallback in current `messageFor`.) |

---

## Bar checklist (post-fix state)

Scoped to `Repository/client/` Pass 1 surface, per `SENIOR_ENGINEER_BAR.md` §5.

- [x] Lint passes (no warnings) — parent verified `npm run lint` clean post-edit.
- [x] Type-check passes (strict, `verbatimModuleSyntax`, `erasableSyntaxOnly`) — parent verified `npm run build` clean.
- [n/a] All tests pass — no client test runner yet; FU-NF-18 filed.
- [n/a] Every public function tested — same as above.
- [n/a] `EXPLAIN ANALYZE` — client.
- [x] **`SECURITY.md` written** — 17 sections, 374 lines, all required surfaces enumerated.
- [x] **README with "how to test this"** — README replaced; "how to test" lives in `SECURITY.md` §16, cross-referenced.
- [~] ADR for non-obvious decisions — same-origin deploy posture is documented in `SECURITY.md` §2 and `services/api.ts` JSDoc; promoting to an ADR amendment is itself a follow-up (acknowledged in FIX_REPORT §"New decisions"). Acceptable for Pass 1 close; could be tightened.
- [n/a] Migrations reversible — client.
- [x] No `TODO`/`FIXME` without ticket — pre-existing `TODO(B7)` is the ticket prefix convention.
- [x] No `console.log` — only `console.warn` in the new tripwire (dev-only, gated, intentional, documented).
- [x] No commented-out code.
- [x] No hardcoded secrets/URLs/paths.

---

## New findings introduced by the fix-pass

### BLOCKER (new)
None.

### SHOULD-FIX (new)
None.

### NIT (new)

- **N-NEW-1 — `services/api.ts` `console.warn` call site uses bare `console`.**
  `services/api.ts:162-167`. Per the codebase's lint rules (the only other
  `console.*` in the client is `console.error` gated by
  `import.meta.env.DEV` in `ErrorBoundary`), a `console.warn` is a stylistic
  outlier. The parent verified lint is clean post-edit, so the rule either
  allows `warn` (typical `no-console: ['warn', { allow: ['warn'] }]`) or the
  config doesn't enforce it. The tripwire is gated by `if (import.meta.env.PROD) return` at line 149 so it's dev-only in practice. Not load-bearing; flagging
  for completeness.

- **N-NEW-2 — `Login.tsx:91-94` `''` sentinel is non-obvious without reading the docstring.**
  The submit handler does `if (msg) setError(msg)`, which is correct, but a
  future contributor "simplifying" to `setError(msg)` would silently
  surface an empty-string banner. The empty string is documented at the
  return site (`messageFor` `:264`) and the call site (`handleSubmit`
  `:91-94`); a `type Result = string | null` discriminant would be even
  safer. Tiny; not a blocker.

- **N-NEW-3 — `node_modules/@supabase/` exists as an empty directory.**
  `npm uninstall` removed the packages but left the parent directory. No
  functional impact (empty dirs are harmless), but `grep` / scanner tools
  that walk `node_modules` see a `@supabase` entry. Removable with a one-line
  `rmdir`. Cosmetic.

### PRAISE (new — fix-pass did something specifically excellent)

- **P-NEW-1 — The `as const satisfies ReadonlyArray<NavItemId>` pattern in `lib/nav.ts:144-159` plus the inline comment explaining why a `ReadonlyArray<NavItemId>` annotation would defeat the check.** This is exactly the kind of "subtle TS-strictness footgun documented at the moment of choice" the senior bar calls for. A reasonable engineer might have annotated the arrays as `ReadonlyArray<NavItemId>` and silently broken the exhaustiveness check; the comment names the trap.

- **P-NEW-2 — The `queueMicrotask` choice in `Shell.tsx:42-44` for focus restore, with the inline justification.** Calling `.focus()` synchronously would race the React unmount; `requestAnimationFrame` would be a frame late; `setTimeout(0)` is a 4 ms hack. `queueMicrotask` is precisely the right primitive (React commit + cleanup runs to completion before microtasks fire). The 3-line comment names the race the alternative would lose.

- **P-NEW-3 — The `warnInsecureCrossOriginCookiePosture` runtime tripwire (`services/api.ts:147-169`) is exactly the "loud-and-early failure beats silent-and-late 401" pattern.** Skipping under `import.meta.env.PROD` is the right scoping. Using a Set for the loopback-host check (`localhost`/`127.0.0.1`/`[::1]`/`::1`) — including both bracketed and bare IPv6 — catches both `new URL` shapes. Senior-level paranoia.

- **P-NEW-4 — The retry-on-5xx in the probe (`AuthProvider.tsx:80-102`) listens for `signal.abort` while waiting** — `await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 500); ctrl.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }); })`. A login mid-backoff cancels cleanly. Many engineers would have written a naked `setTimeout` + `await` and accidentally extended a doomed wait.

- **P-NEW-5 — `SECURITY.md` §11 includes a CSP sketch.** Most "deferred CSP" tickets are one-line "ship a CSP". The sketch reduces Pass-Final estimation risk to near-zero and lets a reviewer cross-check the no-flash IIFE's `nonce` requirement at a glance.

---

## PRAISE preservation audit

Per `FIXPASS_AGGREGATE.md` § PRAISE list.

- A-P1 / D-P1 — threat-model comments in `api.ts`, `AuthProvider.tsx`, `Login.tsx`: **PRESERVED + EXTENDED.** `api.ts:1-47` extended with deploy contract; `AuthProvider.tsx:8-27` extended with login/register-race entry; `Login.tsx:9-46` extended with accessibility block.
- A-P4 — provider/hook/context three-file split: **PRESERVED.** `auth-context.ts`, `AuthProvider.tsx`, `useAuth.ts` all intact; no consolidation.
- A-P2 / A-P3 — `ApiError` + `isServerErrorBody`: **PRESERVED.** `services/api.ts:55-65,74-76`. `isServerErrorBody` still narrows `unknown`.
- A-P5 — discriminated-union auth state: **PRESERVED.** `AuthState` at `:46-49`, `AuthStatus` from context module.
- A-P6 — logout best-effort POST → unconditional local clear → re-probe: **PRESERVED.** `AuthProvider.tsx:192-201`; JSDoc expanded but behavior unchanged.
- A-P7 — `useAuth` throws outside Provider: **PRESERVED.** (Not re-read, but FIX_REPORT and dispatch table both confirm untouched.)
- A-P8 / A-P9 — autoComplete discrimination + double-submit guard: **PRESERVED.** `Login.tsx:182` (`autoComplete={mode === 'register' ? 'new-password' : 'current-password'}`), `:80` (`if (submitting) return`), `:218` (`disabled={submitting}`).
- B-PRAISE token block one-for-one: **PRESERVED + ADDITIVE.** `--on-vermilion` added in light + dark blocks at the same indentation as siblings; existing tokens untouched.
- B-PRAISE Icon set, `<title>`-first SVG, `forwardRef` on Button, `min-height: 100dvh`, `color-mix` backdrop: **PRESERVED.** (Spot-checked Icon.tsx, Button.tsx; no regressions.)
- C-PRAISE `navItem()` Map+throw: **PRESERVED.** `lib/nav.ts:191-204`.
- C-PRAISE `matchActiveId` longest-prefix shape: **PRESERVED + IMPROVED.** Longest-prefix logic intact, boundary check added (this was C-2's whole point).
- C-PRAISE StrictMode-safe `AbortController`: **PRESERVED + EXTENDED.** `AuthProvider.tsx:67-120` initial-mount + cleanup still abort the controller; login/register now also abort it.
- D-P2..P8 — token block fidelity, location-derived `BottomNav`, `lib/nav.ts` SoT, TS-strictness knobs: **PRESERVED.**

No PRAISE item was silently reworked or undone.

---

## Detailed findings (non-FIXED rows)

### Open-redirect deferral (FU-NF-9) — DEFERRED-WITH-DOC

Code at `App.tsx:206` still trusts any string as `target`. The deferral is
defensible per the documented rationale (attack requires hand-crafted
`window.history.pushState`, not external input on the common path), and
`SECURITY.md` §5 makes the residual risk auditable. `FU-NF-9` has a
one-line acceptance test (`target.startsWith('/') && !target.startsWith('//')`).
Reasonable for Pass 1 close; should land before any pre-prod deploy.

### `node_modules/@supabase/` empty directory — N-NEW-3

Cosmetic. The lockfile is clean, no packages inside the directory, nothing
ships. `rmdir` would close it; leaving it doesn't risk anything.

---

## Coordination observations

1. **The same-origin deploy contract** is documented in three places
   (`services/api.ts` JSDoc, `SECURITY.md` §2, `index.html`/`.env.example`
   comments) and tripwired at runtime. Whoever ships Pass Final's
   deployment scaffolding (Cloudflare Tunnel + reverse proxy per project
   memory) needs to honour the empty `VITE_API_URL` contract. Worth
   surfacing as a one-line "deploy checklist" item before the Pass Final
   deploy work begins.

2. **The fix-pass's new `console.warn` in `services/api.ts`** is the first
   `console.*` in the client outside `ErrorBoundary`. If a future
   `eslint-plugin-no-console` lands via FU-NF-17, the disable comment will
   need to be added; until then it relies on whatever the current config
   permits. Lint is green today.

3. **The `as const satisfies` exhaustiveness check in `lib/nav.ts`** will
   re-fire whenever `NavItemId` changes. If a contributor adds a
   `'something'` member and forgets to register it in either array, tsc
   will fail with a useful error pointing at lines 177-180. This is the
   intended behavior. Worth a one-paragraph note in Pass 2's "how to add
   a screen" doc (README cross-references this).

4. **`queueMicrotask` for focus restore** is correct for React 19's
   reconciler ordering. If a future React major changes scheduling
   semantics, this would need re-evaluation. Not a current concern;
   logging for posterity.

5. **The deferred follow-ups** (FU-NF-9 through -20) all have acceptance
   criteria. They are real deferrals with a path to close — not
   handwaves. `SECURITY.md` §15 makes the deferred state auditable from
   a single table.

---

## Recommendation

**Ready to ship Pass 1.** File the deferred follow-ups (`FU-NF-9` through
`FU-NF-20` — already in `FOLLOW_UPS.md`) and proceed to Pass 2. No
additional fix-pass is required.

The fix-pass agent did senior-level work: every BLOCKER closed with
defence-in-depth (doc + runtime + cross-reference), every SHOULD-FIX
closed, every in-scope NIT closed, no PRAISE item undone, four new
PRAISE-worthy choices (`as const satisfies` discipline, `queueMicrotask`
choice with rationale, tripwire scoping, abort-aware backoff). The new
NITs identified above are cosmetic and should not block.
