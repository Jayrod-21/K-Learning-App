# Client — Security

> Per `SENIOR_ENGINEER_BAR.md` §2 last bullet: "Each component writes
> `SECURITY.md` — explicit attack-vector enumeration + defenses."
>
> This file is the contract. The threat-model headers in `src/services/api.ts`,
> `src/hooks/AuthProvider.tsx`, and `src/pages/Login.tsx` are the in-code
> echo; if the two diverge, **this file wins** and the comments are wrong.

Status: Pass 1 skeleton — every screen is a `ScreenStub` placeholder; the
only authenticated surface area is the cookie session, the login form, and
the routing wrappers (`RequireAuth`, `PublicOnly`). PWA install banner, CSP,
MFA, and email verification are explicitly deferred to Pass Final (see §15).

---

## 1. Surfaces shipped in Pass 1

| # | Surface | File(s) |
|---|---|---|
| 1 | Cookie-session API client | `src/services/api.ts` |
| 2 | Auth state machine + provider | `src/hooks/{auth-context.ts, AuthProvider.tsx, useAuth.ts}` |
| 3 | Login / register form | `src/pages/Login.tsx` |
| 4 | Routing guards (`RequireAuth`, `PublicOnly`) | `src/App.tsx` |
| 5 | PWA manifest + installable web app shell | `public/manifest.webmanifest`, `index.html` |
| 6 | Theme persistence + system-pref read | `src/hooks/ThemeProvider.tsx` |
| 7 | Bundle (Vite-emitted JS + CSS) and the env vars baked into it | `import.meta.env.VITE_*` |
| 8 | Dev server (`vite dev`) bind + HMR socket | `vite.config.ts` |
| 9 | Third-party type/font/script origins | `index.html` (Google Fonts) |

---

## 2. Cross-origin cookie posture (locked)

**Threat:** The session cookie is `HttpOnly`, `Secure`, `SameSite=Strict`
(ADR-002 D3). `Strict` is the strongest CSRF defence available, but it has
a footgun: cross-site requests don't carry the cookie at all. Shipping the
SPA to `app.example.com` while the API lives on `api.example.com` means
the cookie lands on the response but the browser refuses to send it on
every subsequent request — login appears to succeed, every page load
401s.

**Defence (production posture):**
- The production deploy is **same-origin**: a reverse proxy in front of the
  Express server routes `/auth/*`, `/vocab/*`, etc. on the same hostname
  the SPA is served from.
- `VITE_API_URL` is therefore the **empty string** in prod. `axios` then
  uses the page origin — no cookie-site mismatch.
- The dev override (`http://localhost:4000` paired with Vite on
  `localhost:5173`) is still same-site because cookie *site* is eTLD+1
  (`localhost`). `SameSite=Strict` is happy in dev.
- `services/api.ts` ships a dev-only runtime tripwire
  (`warnInsecureCrossOriginCookiePosture`) that logs a warning when
  `VITE_API_URL` is non-empty, points at a non-loopback host, and the page
  is served over plain HTTP. If anyone changes the dev URL to a LAN IP or
  a real hostname over HTTP, they see the warning before they see broken
  auth.

**If we ever need a cross-origin deploy** (OAuth callbacks, multi-team
subdomains), ADR-002 D3/D4 must be reopened:
- Relax to `SameSite=Lax` or `None; Secure`.
- Add a CSRF double-submit token in `services/api.ts` request interceptor.
- Add `Access-Control-Allow-Credentials: true` + explicit origin on the
  server CORS layer (it already does this gated by `CLIENT_ORIGIN`).

---

## 3. XSS — reflected and stored

**Threat:** Any path that puts attacker-controlled bytes into the DOM
without escaping is an XSS vector. Cookie session is `HttpOnly`, so an
XSS *cannot* exfiltrate the session by reading `document.cookie`, but it
can still impersonate the user against same-origin endpoints for the
lifetime of the page (`fetch` carries the cookie automatically).

**Defences:**
- React's default text-node interpolation HTML-escapes (`{variable}`). The
  Pass 1 code uses this exclusively — no `dangerouslySetInnerHTML`
  anywhere.
- **No server error message is ever echoed to the auth UI.** `messageFor`
  in `pages/Login.tsx` returns strings only from a fixed lookup keyed by
  `(status, code)`. A future server PR that adds a detailed validation
  message ("password must contain a digit") cannot leak through. This is
  belt-and-braces against (a) accidental XSS via future drift to
  `dangerouslySetInnerHTML`, and (b) username-enumeration oracles.
- Cookie `HttpOnly` is enforced by the server; documented here so the
  contract is auditable from the client side too.

**Deferred (Pass Final):** A real CSP. Without one, an injected `<script>`
that lands in the bundle (supply-chain) runs unrestricted. See §11.

---

## 4. CSRF

**Threat:** A cross-site form or `<img src="…/auth/logout">` triggers a
state change against `app.example.com` using the user's already-attached
cookie.

**Defence:** `SameSite=Strict` (ADR-002 D4) — the browser refuses to attach
the cookie on cross-site requests, so the state-changing endpoint never
sees the user. Same-origin posture (§2) is what makes this practical.

**Defence in depth (server):** the server additionally checks `Origin` /
`Referer` for state-changing endpoints. Not visible from the client, but
recorded here so the layering is auditable.

**If we relax `SameSite`** (see §2 last paragraph), the client MUST grow a
CSRF token interceptor at the same time.

---

## 5. Open-redirect after login

**Threat:** `PublicOnly` in `App.tsx` reads `location.state.from` to send
the user back to their original target after sign-in. A malicious deep
link could set `from = "https://evil.com/phish"` and ride the post-login
navigation off-origin.

**Defence (today):** `target` is the path from `state.from` only when it's
a string. Today the check is permissive (any string).

**Hardening tracked:** `FU-NF-9` (added in this fix-pass) — require
`target.startsWith('/')` and NOT `target.startsWith('//')` (the
protocol-relative-URL bypass). Same-origin-only is the invariant. This is
called out as a hardening item rather than a Pass 1 blocker because
`location.state` is set by the router itself (from `RequireAuth`) on the
common path, not by external callers — the attack requires a hand-crafted
`window.history.pushState` from the user. Still worth landing.

---

## 6. Login form — credential-stuffing / brute-force / enumeration

**Threats:**
1. Credential stuffing — automated reuse of leaked password lists.
2. Brute force — sequential password guesses against a single account.
3. Username enumeration — distinguishing "this email exists" from "this
   password is wrong" via response shape, message text, or timing.

**Defences:**
- Server-side `authLimiter` rate-limits `/auth/login` and `/auth/register`
  per IP (verified in `server/SECURITY.md`).
- Login UI never distinguishes "wrong email" from "wrong password" — both
  map to `'Email or password is incorrect.'` (Pass 1 contract).
- `messageFor` lookup is fixed (see §3) — no oracle through verbose
  validation messages.
- Server collapses login/register response shape and timing — the client
  trusts and reflects this.
- Email field has `autoComplete="email"`; password discriminates between
  `current-password` (login) and `new-password` (register) so password
  managers behave correctly and we don't surface a stale autofill on
  registration.
- Double-submit defence: form sets `submitting` + `disabled` + checks
  `submitting` at the top of the handler. Slow click can't re-fire.

**Deferred (Pass Final / Pass 9):** MFA (TOTP), email verification before
login, CAPTCHA on burst.

---

## 7. PWA manifest — install identity and hijack

**Threats:**
- A drive-by site that ships a competing manifest with the same `id` /
  `start_url` could shoulder-tap the install banner.
- Manifest with `purpose: "any maskable"` on a non-maskable SVG produces
  ugly launcher icons on iOS/Android — not a security threat, but a
  *trust* threat (looks like a knock-off).

**Defences:**
- `start_url: "/"` and `scope: "/"` lock the install identity to this
  origin. Document: any future change here forces a re-prompt to install.
- This fix-pass corrected `purpose: "any maskable"` → `purpose: "any"`.
  Maskable + apple-touch-icon PNGs (180/192/512) ship in Pass Final
  (`FU-NF-10`).
- `apple-touch-icon` link added in `index.html` so iOS doesn't fall back
  to a generic screenshot when the user adds to home screen. Today's link
  points at the SVG favicon as a placeholder; iOS rasterises it. Pass
  Final replaces with a 180×180 PNG.

**Deferred (Pass Final):** install banner UX, `screenshots[]`, real
rasterised PNG set.

---

## 8. Environment variables (`import.meta.env`)

**Threat:** `import.meta.env.VITE_*` is **bundled into the public JS**.
Anything in a `VITE_…` var ships to every browser tab that loads the SPA.

**Defence:**
- `VITE_API_URL` is the only `VITE_*` var we use. It's a public URL by
  design — same-origin in prod, `http://localhost:4000` in dev. No
  secret.
- Documented in `.env.example`: **never** put secrets (API keys, signing
  secrets, internal hostnames) in a `VITE_…` var. Use server-side env
  vars for those.

---

## 9. Supply chain (lockfile / `npm ci`)

**Threats:**
- Removed dependency still resolved in `package-lock.json` → `npm ci`
  reinstalls it on a fresh checkout → attack surface lives on in the
  dep graph.
- Transitive dependency CVE.
- Typo-squat / malicious version bump.

**Defences:**
- `package-lock.json` is committed. This fix-pass regenerated it after
  the Supabase deletion (`D-S1`) so `@supabase/*` no longer resolves.
- `npm audit` in CI is the periodic check (Pass Final to wire).
- Dependabot / Renovate is the auto-bump path (Pass Final).

---

## 10. Dev server (`vite dev`)

**Threat:** `vite.config.ts` currently binds the dev server on
`host: '0.0.0.0'` by design (mobile-first dev: testing the PWA from a
phone on the same LAN). That means **anyone on the LAN can hit the dev
build with source maps and a running HMR socket**. On a public Wi-Fi,
that's a leak of unreleased code.

**Defences:**
- Documented in `vite.config.ts` comment block.
- Production builds (`npm run build`) emit static files only — no dev
  server.
- The HMR socket has no auth; treat it as a debugging interface, not a
  service.

**Hardening tracked:** `FU-NF-11` (added in this fix-pass) — gate the
`0.0.0.0` bind behind `HOST=0.0.0.0 npm run dev` so the default is
loopback.

---

## 11. Content Security Policy — known gap

**Threat:** No CSP today. An injected `<script>` (XSS that slipped through
React's escape, or a supply-chain compromise of a bundled package) runs
unrestricted: any origin for `fetch`, any inline script, any data: URL.

**Defence (today):** None at the CSP layer. React's escape + `HttpOnly`
cookie are the primary defences. Same-origin posture means a successful
XSS still can't make cross-origin authenticated requests with the cookie.

**Deferred (Pass Final, `FU-NF-12`):** Ship a CSP via `<meta http-equiv>`
or a `Content-Security-Policy` header at the reverse-proxy layer.
Sketch:
```
default-src 'self';
script-src 'self' 'nonce-…';     /* nonce covers the no-flash IIFE */
style-src 'self' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com;
img-src 'self' data:;
connect-src 'self';
frame-ancestors 'none';
base-uri 'self';
form-action 'self';
```

The no-flash bootstrap `<script>` in `index.html` is pure (no dynamic
input), so a `'nonce-…'` source covers it cleanly when CSP lands.

---

## 12. Third-party origins (Google Fonts)

**Threat:** Google Fonts CSS pulled from `fonts.googleapis.com` at runtime
without SRI. If Google's CDN were compromised (vanishingly unlikely; not
zero), a tampered CSS could inject `@import` chains or `content:` values.

**Defence:** Google Fonts deliberately doesn't support SRI on the CSS2
endpoint (the response body varies by `User-Agent` for variable-font
slicing). The right defence is the CSP `style-src` / `font-src`
allow-list in §11. Until CSP lands, the residual risk is accepted.

---

## 13. Logout edge cases

**Threat:** Server returns 5xx during `/auth/logout`. Client clears local
state, then re-probes; if the cookie is still valid, the re-probe
succeeds and flips state back to `authenticated`. The UI flashes "logged
out" then returns to authenticated. The user is effectively *not* logged
out.

**Defence (today):** The behaviour is documented in
`AuthProvider.tsx → logout` JSDoc. The trade-off (best-effort logout vs
"block until server confirms") favours UX in Pass 1; the user can verify
session state by reloading the page.

**Hardening tracked (`FU-NF-13`):** Pass 3 will retry the logout once on
5xx with backoff, and surface a non-blocking warning if the retry also
fails ("we couldn't reach the server to end your session — close all
tabs or try again").

---

## 14. Login / register vs in-flight probe race

**Threat:** The initial `GET /auth/me` probe is still in flight when the
user submits the login form. `login` resolves and sets
`authenticated`. Then the probe (which was sent before the cookie was
set) returns 401 and clobbers state back to `guest`. The user bounces to
the login screen with no error.

**Defence:** `login` and `register` call `probeRef.current?.abort()`
**before** the POST. The probe's catch sees `ctrl.signal.aborted === true`
and bails. The post-login `setState('authenticated')` is the last writer.

Documented in the `AuthProvider.tsx` threat-model header.

---

## 14a. Settings substrate (palette presets, localStorage I/O, DOM var
writes)

**Surface (added in Pass 2):**

| Component | File |
|---|---|
| Pure I/O + merge + palette flatten | `src/lib/settings.ts` |
| Closed-set palette presets | `src/lib/palette-presets.ts` |
| Provider + DOM allowlist + debounce | `src/hooks/SettingsProvider.tsx` |
| Context value shape (separate file for React Refresh) | `src/hooks/settings-context.ts` |
| Hook with throw-if-unprovided guard | `src/hooks/useSettings.ts` |
| Settings screen | `src/pages/Settings.tsx` |
| Reusable swatch radio row | `src/components/SwatchPicker.tsx` |

**Threats and defences:**

- **Corrupt `localStorage["km.settings"]` JSON** — `loadSettings()` is
  wrapped in `try/catch`; parse failure (or DOMException when storage is
  disabled in private mode) returns `DEFAULT_SETTINGS`. The user sees
  defaults and can re-pick; the next save heals the blob. `mergeSettings`
  type-guards every nested branch and falls back to the default at each
  leaf, so a partial / malformed blob upgrades cleanly rather than
  throwing.
- **Quota exhaustion on write** — `saveSettings()` swallows DOMException
  with `console.warn`. In-memory state remains the session source of
  truth. No data is lost within the session; only persistence skips.
- **Debounced persistence (200ms)** — `SettingsProvider` debounces the
  write so a flurry of swatch-keyboard navigation or input typing
  collapses to a single `localStorage.setItem`. The cleanup-on-unmount
  effect (empty dep list) flushes any pending timer before the Provider
  tears down, so a tab close mid-debounce still persists the latest
  state. `resetSettings()` synchronously persists `DEFAULT_SETTINGS` and
  clears the debounce timer (rapid close-and-quit can't lose the reset).
- **DOM custom-property pollution** — `applyPaletteVars` writes inline
  styles on `<html>` via `documentElement.style.setProperty(k, v)`. Both
  `k` and `v` are sourced exclusively from `palette-presets.ts` — author-
  controlled constants, never user input. Defence in depth: `Settings
  Provider` gates every key through `ALLOWED_VARS` (a closed Set of CSS
  variable names) and tracks which keys it has written so the next
  `applyPaletteVars` call can clear stale ones when the user picks a
  preset with fewer overrides. A future preset added to one map but
  forgotten in `ALLOWED_VARS` is silently dropped rather than written —
  the threat-model header on the Provider documents the contract.
- **Cross-tab race** — two tabs concurrently editing settings can clobber
  each other on the next persistence flush. Acknowledged Pass-9 deferral
  (the localStorage `storage` event listener + merge-or-last-writer-wins
  policy lands alongside server sync). The reasoning here mirrors the
  cookie-session model in ADR-002 D2: server-side state is the eventual
  source of truth; the localStorage blob is a session cache. Tracked as
  a future `FU-NF` ticket (see "Follow-ups filed" in `FIX_REPORT_P2.md`).
- **Palette-preset application** — `SwatchPicker` keyboard handling
  separates focus from selection: arrow keys move focus through the
  swatches without writing settings; Space / Enter commits the
  selection. This prevents an inadvertent keyboard sweep from churning
  the localStorage debounce + the `applyPaletteVars` projection (which
  in turn would CSS-cascade-invalidate the entire page on each keystroke).
- **Notification channel coupling** — when the user clears the email
  field, `Settings.tsx` also sets `notif.channel.email = false` (same
  for phone / SMS). One-way coupling: clearing a contact field clears
  the channel; setting a field does NOT auto-enable the channel. This
  prevents a stale opt-in from persisting into the saved settings blob
  (and, in Pass 9, the server sync) after the user has removed the
  underlying contact destination.
- **XSS** — every settings field renders as a React text child (input
  value bindings, `<span>{krLabel}</span>`). No `dangerouslySetInnerHTML`
  anywhere. `settings.name` flows into Chat's first tutor message via
  string template (`Chat.tsx → personalise`); the resulting string is
  still rendered as text. See §3 for the wider XSS posture.

**Out of scope (Pass 2):**

- Encryption-at-rest of the settings blob — there are no secrets in
  `km.settings`; the palette + name + email + phone + notif toggles are
  preferences, not credentials.
- Schema versioning — no breaking shape change yet. When one lands, a
  `version: number` field will be added to `Settings` and `mergeSettings`
  will branch on it.
- Server sync — Pass 9 will mirror the blob to a `user_settings` table
  via the API layer. The localStorage shape is the offline-first cache;
  the server is the canonical source post-Pass-9.

---

## 15. Deferred items (tracked as `FU-NF-*` tickets)

| Ticket | Surface | Pass | What lands |
|---|---|---|---|
| FU-NF-9 | Open-redirect | Pass 3 | Same-origin guard on `target` in `PublicOnly` |
| FU-NF-10 | PWA icons | Pass Final | 180/192/512 PNG icon set + maskable purpose entry |
| FU-NF-11 | Dev server bind | Pass 3 | `HOST=0.0.0.0` opt-in |
| FU-NF-12 | CSP | Pass Final | `Content-Security-Policy` meta + reverse-proxy header |
| FU-NF-13 | Logout 5xx | Pass 3 | Retry + non-blocking warning |
| FU-NF-14 | Streaming timeouts | Pass 3 | Per-call `timeout` override for Claude routes |
| FU-NF-15 | MFA | Pass 9 | TOTP enrolment + recovery codes |
| FU-NF-16 | Email verification | Pass Final | `email_verified_at` gate before login |
| FU-NF-17 | jsx-a11y lint | Pass 2 | `eslint-plugin-jsx-a11y` |
| FU-NF-18 | Vitest | Pass 2 | Test framework + first specs |

---

## 16. How to test this

Pass 2 ships the test framework (`FU-NF-18` closed). The security
posture is verified by:

1. **`npm run build`** — type-check + production build. Confirms strict TS
   passes, no `any`, no missing imports. Per [`TESTS.md`](./TESTS.md) →
   `client-build`.
2. **`npm run lint`** — ESLint. Per [`TESTS.md`](./TESTS.md) →
   `client-lint`.
3. **`npm test`** — Vitest + Testing Library suites. Per
   [`TESTS.md`](./TESTS.md) → `client-unit`.
3. **Manual smoke**:
   - Open the dev server (`npm run dev`). Confirm `data-theme` is set
     before the first paint (no FOUC). DevTools → Application → Local
     Storage shows `km.theme` after you toggle.
   - Open DevTools → Application → Cookies after login. Verify `km_sid`
     is `HttpOnly`, `Secure` (prod) / not-Secure (dev), `SameSite=Strict`.
   - Set `VITE_API_URL=http://192.168.1.99:4000` (a LAN IP) and reload.
     Console should warn about the cross-origin HTTP posture
     (`warnInsecureCrossOriginCookiePosture`).
   - Open the More sheet, press Esc. Focus should land back on the More
     button (visible focus ring).
   - Tab through the login form. The email field should be focused on
     load; Shift-Tab from email should leave the form, not land on the
     password.
   - Submit with bad credentials. Check the alert region announces the
     error and the same shape is shown regardless of whether the email
     exists.
4. **Cross-reference**: when reviewing this file, also read the
   threat-model headers in `services/api.ts`, `hooks/AuthProvider.tsx`,
   and `pages/Login.tsx`. They must agree with this document.

---

## 17. Pointer index

- ADR-002 (cookie sessions, hashing, CSRF): `Repository/db/docs/ADR-002-auth-and-sessions.md`
- Server attack surface: `Repository/server/SECURITY.md`
- Senior engineer bar (defines the SECURITY.md requirement): `SENIOR_ENGINEER_BAR.md`
- Follow-up tickets (deferred items): `Repository/../FOLLOW_UPS.md`
- Plan: `CLAUDE_DESIGN_INTEGRATION_PLAN.md`
