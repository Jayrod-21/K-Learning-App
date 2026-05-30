# Review A: Auth + API (Pass 1)

Reviewer: independent senior (30y), zero authorship on this code.
Scope: client `services/api.ts`, `hooks/auth-context.ts`, `hooks/AuthProvider.tsx`,
`hooks/useAuth.ts`, `pages/Login.tsx`.
Cross-referenced against server `routes/auth.ts`, `middleware/auth.ts`,
`auth/sessions.ts`, `middleware/errors.ts`, ADR-002, SENIOR_ENGINEER_BAR.md,
and the Pass 1 plan in CLAUDE_DESIGN_INTEGRATION_PLAN.md.

## Summary verdict

**PASS WITH CONDITIONS.**

The auth/API skeleton is unusually well thought through for Pass 1: the
context/provider/hook split is textbook, the `ApiError` taxonomy is honest,
the cookie/CSRF threat model is correctly articulated, and the Login page is
genuinely accessible. There are no hard security holes that would refuse
approval. However there are **2 BLOCKERs** rooted in cross-origin cookie
mechanics — `SameSite=Strict` does not behave the way the comments assume when
the client is on a different origin than the API (the `.env.example` ships
`VITE_API_URL=http://localhost:4000`), and `Secure: false` in dev means modern
Chrome will silently drop the `SameSite=Strict` cookie cross-site in some
flows. Both must be settled before this layer is declared "done" or any
multi-origin deploy will look authenticated locally and dead in production.
The remaining items are SHOULD-FIXes around AbortError handling, logout
re-probe semantics, dev-only error leakage on register, and a few minor TS /
a11y nits.

---

## Bar checklist

Drawn from §5 "Bar checks before declaring done" and §2 Security in
SENIOR_ENGINEER_BAR.md, scoped to what's reviewable here (client only).

| Bar item | Status | Note |
|---|---|---|
| Type-check passes (strict, `verbatimModuleSyntax`, `erasableSyntaxOnly`) | PASS (visual review) | `import type` discipline OK in all 5 files; no `as any`; no `enum`/namespace forms that violate `erasableSyntaxOnly`. |
| No `any` | PASS | `unknown` used at error boundary (`isServerErrorBody`), narrowed defensively. |
| Domain errors typed (not bare `Error`) | PASS | `ApiError` is the single boundary type the rest of the app sees. |
| Never swallow exceptions | PARTIAL | `logout` swallows by design (documented), but it does NOT distinguish "network down" (don't trust local clear) from "401" (already gone). See SF-2. |
| Parameterized queries (N/A — client) | N/A | |
| Input validation at boundary | PARTIAL | Server-side Zod is solid; client-side `Login.tsx` has only HTML `required`/`minLength`. Acceptable for Pass 1 since `noValidate` is set; see NIT-3. |
| Secrets never in code, never logged | PASS | No keys in client. Cookie is HttpOnly. |
| Cookies `HttpOnly`, `Secure`, `SameSite=Strict` | CONDITIONAL | Server sets all three correctly **in prod only** (`secure: cfg.NODE_ENV !== 'development'`). The combination of `Secure=false` + `SameSite=Strict` + cross-origin dev server (`localhost:5173` → `localhost:4000`) is the trap; see BLOCKER-1. |
| CORS restrictive | OUT OF SCOPE | Not in scope files; flagged in coordination. |
| Rate limiting | PASS (server) | `authLimiter()` mounted on `/register` and `/login`. |
| Audit log for sensitive operations | PASS (server) | `last_login_at` updated, `req.log.info` on register/login/logout. |
| `SECURITY.md` per component, attack vectors enumerated | PARTIAL | Threat model is in JSDoc headers on each client file (acceptable for Pass 1 skeleton), but no `client/SECURITY.md` yet. SHOULD-FIX before Pass 3. |
| No `console.log`, no `TODO`/`FIXME` without ticket | PASS | Clean. |
| No commented-out code | PASS | |
| No hardcoded URLs | PASS | `VITE_API_URL` env, same-origin fallback. |
| KISS / SOLID — provider+hook split correct | PASS | `auth-context.ts` carries types + context object; provider lives in `.tsx`; hook lives in its own file. React Refresh + only-export-components rules satisfied (explicitly documented in `auth-context.ts:1-8`). |

---

## Findings

### BLOCKER

- **B-1 — Cross-origin cookie + `SameSite=Strict` mismatch with dev config.**
  `.env.example` ships `VITE_API_URL=http://localhost:4000`; Vite dev runs the
  client on `localhost:5173`. Different ports = different sites for cookie
  purposes is the common misconception. Cookie *site* is eTLD+1, so
  `localhost:5173` and `localhost:4000` are same-site → `SameSite=Strict` is
  fine in dev. BUT the same configuration in production becomes a real problem
  the moment the API is on a different subdomain (e.g. `api.koreanmaster.app`
  vs `app.koreanmaster.app`) — those *are* same-site (same eTLD+1), but if the
  deploy ever uses a fully different origin (Cloudflare Tunnel routing the
  API to a different hostname is plausible per project memory), `Strict`
  silently drops cookies on cross-site `fetch`/XHR, and the Pass 1 client will
  appear to log in (cookie set OK on the response), but every subsequent
  request will arrive without the cookie and `requireAuth` will 401. The
  comment in `services/api.ts:11-14` correctly identifies the principle but
  doesn't lock the contract. The ADR (D3) doesn't address cross-origin
  deployment. Two issues to settle:
  1. Decide and document the deploy origin contract (same-site or
     cross-site). If cross-site, `SameSite=Strict` will not work and ADR-002
     D4 needs to be reopened.
  2. The `Secure=false` branch in dev (`auth/sessions.ts:172`,
     `auth/sessions.ts:183`) combined with Chrome's recent "Reject insecure
     SameSite=None cookies" tightening means the dev branch is fine *only*
     because `SameSite=Strict` exempts the secure requirement on `localhost`.
     If anyone changes the dev `VITE_API_URL` to a non-localhost host
     (`127.0.0.1` is fine; a LAN IP is NOT — Chrome treats it as insecure
     non-localhost), the cookie is dropped silently with no error in DevTools
     except a yellow triangle. Add a check in the client api layer (or a
     startup log line) that warns when `VITE_API_URL` is set, not empty, and
     not `localhost`/`127.0.0.1` while the page is HTTP. Same-origin (empty
     `VITE_API_URL`) is the safe deploy default and should be the documented
     production posture.

- **B-2 — `AbortController.abort()` makes axios throw a `CanceledError` (an
  `AxiosError` with `code === 'ERR_CANCELED'` and `response === undefined`),
  which `normaliseError` flattens to `{ status: 0, code: 'network' }`.**
  In `AuthProvider.tsx:69-78` the catch path does check
  `ctrl.signal.aborted` and returns early — good. BUT in `probe`, the new
  controller is assigned to `probeRef.current` *before* the await, so a
  re-entrant `probe()` (e.g. logout's `await probe()` racing with the
  unmount/cleanup of the initial-mount effect) aborts the in-flight request
  with the OLD controller while the awaiter holds the OLD `ctrl` reference.
  After abort, `ctrl.signal.aborted` is `true`, the catch returns silently —
  fine. The bug is the inverse: after logout's `probe()` resolves to "guest"
  state, the initial-mount effect's cleanup (`return () => { probeRef.current?.abort() }`)
  will abort the **logout's** controller if the component unmounts during
  logout — but more importantly, the initial-mount effect's cleanup fires
  on every re-render that changes `probe`'s identity. `probe` is wrapped in
  `useCallback(…, [])` so its identity is stable; the effect only re-runs on
  StrictMode double-mount. In dev StrictMode, mount → cleanup → mount runs:
  the FIRST mount starts a probe (controller A), the cleanup aborts A
  (sets `probeRef.current` to A, aborted), the SECOND mount starts probe B
  (overwrites `probeRef.current` with B). A's `.catch` returns silently
  because `A.signal.aborted` is true — correct. So the StrictMode race is
  handled correctly today.
  However, a real bug remains: `login()` (`AuthProvider.tsx:93-102`) and
  `register()` (`:104-118`) **do not abort an in-flight probe before
  optimistically setting `state` to `authenticated`**. Sequence:
  (1) mount → probe A in-flight; (2) user types fast and submits before the
  probe resolves → `login()` resolves successfully and sets
  `authenticated`; (3) probe A's response arrives 200ms later (the user
  isn't authed *yet* from A's perspective — A was a `GET /auth/me` before
  the cookie was set) → A's response is 401 → catch path sets
  `{ status: 'guest', user: null }`, clobbering the post-login state. The
  user gets bounced back to the login screen with no error. To fix: in
  `login`/`register`, call `probeRef.current?.abort()` BEFORE the POST, OR
  re-probe after success instead of optimistically setting state from the
  POST response. The latter is cleaner and matches what `logout` does.
  This is a soft blocker — it's a guaranteed UX bug under real-world timing
  and would be caught in the first manual test. Cite `AuthProvider.tsx:93`
  and `:104`.

### SHOULD-FIX

- **SF-1 — `services/api.ts:71` collapses `status === 0` to `code: 'network'`,
  but axios uses `status: 0`/no response for several distinct cases**:
  network unreachable, CORS preflight failure, request canceled, and timeout.
  Login.tsx's `messageFor` shows "Could not reach the server" on
  `status === 0`, which is wrong messaging for a timeout (server is reachable
  but slow) or a CORS failure (server is reachable, returning the wrong
  headers — user can't do anything about it but a developer needs to see it).
  Discriminate: `err.code === 'ECONNABORTED'` → `'timeout'`,
  `err.code === 'ERR_CANCELED'` → `'canceled'`, otherwise `'network'`.

- **SF-2 — `logout` swallows the POST result and unconditionally clears local
  state**, then re-probes. The intent (`AuthProvider.tsx:120-129`) is correct:
  if the server is unreachable, drop the local state so the UI redirects
  to login. BUT: if the POST returned **non-2xx that wasn't a network
  failure** (say the rate limiter 429'd a logout-spam, or the server returned
  500), the catch still runs, local state clears, and the re-probe will hit
  the same broken server and also fail → state stays guest → the user
  *appears* logged out, but the session cookie is still valid on the server.
  Next page load will silently re-authenticate them. Two fixes:
  (1) Re-probe should happen *after* the catch, regardless of which path was
  taken — that's already what the code does, so that part is right.
  (2) But for a 5xx logout the re-probe will succeed (cookie still valid)
  and put the user back to `authenticated`, contradicting the local clear.
  This is the right behavior (the cookie *is* still valid), but the UI shows
  "logged out" for the duration of the POST→probe window. Acceptable for
  Pass 1 but document the trade-off in the JSDoc.

- **SF-3 — Probe / login error path leaks server message into the UI even
  for a 400 register.** `Login.tsx:222-225` returns `err.message` verbatim
  for a 400. The server's 400 path is Zod failure (`errors.ts:74-80`) with
  `message: 'invalid input'` — generic and safe. BUT `ConflictError` and
  the `register insert returned no rows` path in `routes/auth.ts:74` will
  surface via `code: 'internal_error', message: 'something went wrong'` —
  also safe. The narrow concern is: nothing in the client *enforces* that
  the server message is safe to render. A future server PR that adds a
  detailed validation message (e.g. "password must contain a digit") will
  leak through. Tighten: in `messageFor`, *never* echo `err.message` for
  unauthenticated routes — pick a fixed table of messages keyed by
  `(status, code)`. Falling back to a generic "Please check your entries"
  for any unhandled 4xx is the senior-engineer move.

- **SF-4 — XSS via reflected error is *not* mitigated by `role="alert"`
  alone.** The threat-model comment in `Login.tsx:18-20` says React's text
  interpolation HTML-escapes, which is true — there is no XSS vector
  through `{error}` as written. The concern is **future drift**: someone
  adding `dangerouslySetInnerHTML` or a Markdown renderer to error display
  would silently introduce one. Add a single-line ESLint rule comment or a
  dedicated `<ErrorBanner>` component whose contract is "text only, never
  HTML". Lighter touch: rename the prop the threat-model comment guards so
  the invariant is local. NIT-adjacent but flagged because the comment
  *claims* defense; the comment should match the code's actual posture.

- **SF-5 — `useAuth` is exported from the same file as a re-export of
  `User`/`AuthStatus`/`AuthContextValue`.** This works under
  `verbatimModuleSyntax` because the re-export uses `export type { … }`
  (`useAuth.ts:10`), so it's erased at compile time. But the file is named
  `useAuth.ts` and a `Vite` hot-reload edge case is React Refresh: the
  `only-export-components`/`only-export-hooks` rule expects the file to
  export exactly the hook. Re-exporting types is fine for `eslint-plugin-react-refresh`
  in practice (types are erased), but some configurations flag it. Verify
  the lint config allows this; if it complains, move the re-exports back
  to `auth-context.ts` and have consumers import types from there.

- **SF-6 — `Login.tsx` autofocus is *not* implemented**, despite the
  threat-model comment in `:30-31` claiming "First field receives
  autofocus on mount". Add `autoFocus` on the email input (or call
  `inputRef.current?.focus()` in a mount effect — autofocus on every
  re-render is what `autoFocus` does, and React only honors it on mount,
  so the attribute is the correct primitive). Without this, keyboard
  users land on the document and have to Tab through the seal stamp and
  eyebrow to reach the form.

- **SF-7 — The form has no aria-busy / no aria-live on the submitting
  state.** Screen readers won't announce "submitting…". The button text
  changes to "One moment…" which is read on focus but the user has
  pressed Enter and focus is still on the button so a re-announcement
  won't fire. Add `aria-busy={submitting}` to the form and the button
  text becomes a `aria-live="polite"` announcement.

- **SF-8 — `register` sends `display_name` only when the trimmed string is
  truthy.** Server schema (`auth.ts:49`) accepts `display_name` as
  `z.string().min(1).max(80).optional()`. Sending `display_name: ''` would
  fail validation (min(1)). The conditional spread
  (`AuthProvider.tsx:113`) is correct. **Praise**, not a SHOULD-FIX, but
  flagged here because the symmetry with `Login.tsx:71` (which passes
  `displayName.trim() || undefined`) means both sides converge on the same
  invariant — good defensive layering.

- **SF-9 — No retry/backoff on the initial `/auth/me` probe.** The probe
  runs once and falls through to `guest` on any non-401 error
  (`AuthProvider.tsx:75-77`). For a transient 5xx or network glitch on
  page load, the user sees the login screen and enters credentials only
  to have them silently work — annoying but not broken. Acceptable for
  Pass 1; flag for Pass 3 ("Loading states + error handling" line in
  the integration plan §"Other Pass 3 work").

- **SF-10 — `apiRequest`'s `timeout: 10_000` is a *connection-level*
  timeout in axios's terminology**: it fires on response inactivity. For
  `/auth/me` and `/auth/login`, that's appropriate. But the comment
  (`api.ts:93-95`) hints this same instance will serve `/enrich`
  (Claude-backed). Claude streaming responses can take >10s on cold
  starts. Either (a) raise the default ceiling and pass shorter timeouts
  per call-site, or (b) keep 10s here and require all Claude-backed
  routes to pass their own. The integration plan implies (b) ("Per-call
  code can override") — fine, but doc-only enforcement is fragile. Add
  a comment in `services/api.ts` listing the routes whose callers MUST
  override.

### NIT

- **N-1 — `AuthState` has a `status` discriminator but the consumer
  surface re-exposes both `status` and `loading: status === 'loading'`
  (`AuthContextValue:18-24`).** Two ways to ask the same question.
  Pick one. Recommend deleting `loading` and forcing consumers onto
  `status` — the discriminated union is exhaustive and TS will catch
  missing cases. `loading` is a Pass-0 artifact carried for compatibility.

- **N-2 — `messageFor`'s 400 branch returns `err.message || 'Please…'`**
  (`Login.tsx:223`). `ApiError.message` is always populated (set in the
  constructor from `super(message)`), so the `||` fallback is dead code.
  Either trust the constructor and drop the fallback, or harden the
  constructor invariant in `ApiError`.

- **N-3 — `Login.tsx` form uses `noValidate`** (`:105`), so HTML
  `required`/`type="email"` are visual only. Fine for Pass 1 — server
  Zod is authoritative — but `aria-required="true"` on the inputs would
  preserve the assistive-tech signal that "required" was conveying.

- **N-4 — `EMAIL_REGEX` on the server** (`auth.ts:40`) is stricter than
  `z.string().email()` and is anchored. The client side
  (`Login.tsx:131-141`) sets `type="email"` only. Mismatch is OK
  (server is authoritative) but the regex on the server is liberal
  enough to accept emails Zod would reject and vice versa; double
  validation is belt-and-braces but the redundancy should be commented
  ("regex catches Unicode-confusable emails that Zod's loose RFC 5322
  parser accepts" — or whatever the actual rationale is).

- **N-5 — `setSessionCookie` does not set `cookie.maxAge`** alongside
  `expires` (`auth/sessions.ts:170-176`). `expires` is the older spec
  and works in every browser; `maxAge` is the recommended modern
  attribute. Belt-and-braces: set both. Server-side concern but flagged
  here because the client is the consumer and a `maxAge`-less cookie
  in some testing flows (Cypress with `cy.clock`) misbehaves.

- **N-6 — `auth-context.ts:9` imports `createContext` but the file's
  filename ends `.ts`, not `.tsx`.** The context itself takes a
  `Provider`/`Consumer` but those are used in `.tsx` files — fine. Just
  noting that splitting context-object-only into `.ts` (vs the provider
  in `.tsx`) is a clean pattern; this is the right call.

- **N-7 — `Login.tsx:62` allocates `errorId` via `useId` even when no
  error is shown**, which is harmless but slightly wasteful. The
  conditional `aria-describedby` (`:189`) only references it when
  `error` is set — correct usage.

### PRAISE

- **P-1 — The threat-model comment block atop each file** is exactly
  the pattern global standing-orders §2 asks for: "document what was
  defended against in code comments". Don't undo these in fix-pass.
  Specifically `api.ts:8-26`, `AuthProvider.tsx:8-19`, `Login.tsx:9-32`.

- **P-2 — `ApiError` as the single boundary type** with `status` +
  `code` (`api.ts:33-44`) is the right abstraction. Call sites switch on
  `status` for HTTP-level routing and `code` for domain-level routing
  without reaching into `AxiosError`. This is senior-level error
  taxonomy.

- **P-3 — `isServerErrorBody` type guard** (`api.ts:53-55`) instead of
  a naked cast. Under `verbatimModuleSyntax` + `noUncheckedSideEffectImports`,
  this is the disciplined way to narrow `unknown`.

- **P-4 — Provider + hook + context-object split across three files**
  (`AuthProvider.tsx` / `useAuth.ts` / `auth-context.ts`). React Refresh
  and `react-refresh/only-export-components` both satisfied. The
  docstring on `auth-context.ts:1-8` explains the *why*. This is
  exactly how a senior would lay it out.

- **P-5 — `requireAuth`-shaped `state` discriminated union**
  (`auth-context.ts:16` — `'loading' | 'authenticated' | 'guest'`). No
  ambiguous "is logged in" booleans floating between layers.

- **P-6 — `logout` does best-effort POST then unconditional local clear
  then re-probe** (`AuthProvider.tsx:120-129`). The trade-off is
  documented in the JSDoc. Even with SF-2's caveat, this is the right
  default — "log out optimistically, reconcile from server" is
  user-friendlier than "block on server response".

- **P-7 — `useAuth` throws if used outside `<AuthProvider>`**
  (`useAuth.ts:13-16`). Loud-and-early failure beats silent-and-late
  `undefined`. Standing-orders §2 "Never swallow exceptions" applied
  correctly.

- **P-8 — `autoComplete="new-password"` vs `"current-password"`
  dynamically based on mode** (`Login.tsx:152`). Password managers
  treat these differently and a senior reviewer always checks this.
  Praise specifically called out so fix-pass doesn't "simplify" it.

- **P-9 — `handleSubmit` guards against double-submit with
  `if (submitting) return`** (`Login.tsx:66`) AND disables the button
  (`:188`). Both layers. Click-to-double-fire is a known accessibility
  attack surface (a slow click can re-fire the handler before React
  re-renders the disabled state).

- **P-10 — `Eyebrow` + `SealStamp` + `DoubleRule` are imported as
  Pass-1 design components, hanji palette respected, no Tailwind /
  inline-style soup.** This page actually matches the design ADR.

---

## Detailed findings

### B-1 (BLOCKER): cross-origin cookie deploy posture

**Where**: `services/api.ts:86` (baseURL), `auth/sessions.ts:170-176`
(setSessionCookie), `.env.example:5`. ADR-002 D3/D4.

**What**: ADR-002 locks `SameSite=Strict`. The dev `.env.example` ships a
cross-origin URL (`http://localhost:4000` from a `localhost:5173` Vite
dev server). These are same-site for cookie purposes (eTLD+1 is
`localhost`), so it works in dev. The ADR is silent on production
deployment topology — same-origin reverse proxy or two hostnames? The
project memory ("Cloudflare Tunnel for reachability") implies a single
public origin, which is fine; but the client/server split means the
"same origin" posture has to be enforced by the deploy config
(reverse-proxy `/api/*` to the server), and **no code or config in the
client repo asserts this**.

**Why it's a blocker**: ship the current code to a two-hostname
production (api.X / app.X) and `SameSite=Strict` will silently drop the
cookie on every request from `app.X` to `api.X`. Every user appears
authenticated for one round-trip and then 401s. The failure mode is
"login works, nothing else works" — exactly the kind of integration
trap that wastes hours.

**Fix**: (1) Add to ADR-002 a "Deploy topology" section locking
"same-origin only; the API is reverse-proxied under `/api/*`". (2) Add
to `services/api.ts` a runtime assertion (dev-only) that warns when
`VITE_API_URL` is set to a non-localhost cross-origin host. (3) Change
`.env.example` to `VITE_API_URL=` (empty = same origin) and document
the `localhost:4000` setup under a `# dev only` block. (4) Optional:
add a `client/SECURITY.md` line item "cross-origin deploy requires
SameSite=Lax + CSRF token; do not ship without ADR amendment".

### B-2 (BLOCKER): login/register race vs in-flight probe

**Where**: `AuthProvider.tsx:81-91` (probe effect) + `:93-118`
(login/register).

**What**: The initial-mount `probe()` may still be in flight when the
user submits the login form. `login()` resolves and sets
`state = { status: 'authenticated', user }`. Then the in-flight probe
A's response arrives (it was sent *before* the cookie was set, so the
server returns 401), and the catch path overwrites state with
`{ status: 'guest', user: null }`. The user is bounced back to the
login screen with no error to show.

**Why it's a blocker**: every login carries this race. On a fast
machine it usually races correctly (probe resolves before the user can
type their password); on a slow machine or a slow server it doesn't.
This will manifest as flaky tests and intermittent user reports — the
worst kind.

**Fix**: in `login` and `register`, abort the in-flight probe before
making the POST:
```
probeRef.current?.abort();
```
Or — cleaner — after a successful login/register, *don't* set state
from the POST response; call `await probe()` to re-synchronize from
the server (which is what `logout` does and what the JSDoc on
`AuthProvider.tsx:14-19` says is the "defence in depth" pattern). The
asymmetry (login optimistic, logout re-probes) is suspicious for a
reason.

### SF-1: error code discrimination

**Where**: `services/api.ts:71-78`, `Login.tsx:226-231`.

**Fix**: discriminate axios error subtypes. Add to `normaliseError`:
```
if (err.code === 'ECONNABORTED') return new ApiError('request timed out', { status: 0, code: 'timeout' });
if (err.code === 'ERR_CANCELED') return new ApiError('request canceled', { status: 0, code: 'canceled' });
```
Then `Login.tsx`'s `messageFor` should switch on `err.code === 'timeout'`
to say "The server is taking too long to respond" and on
`err.code === 'canceled'` to swallow (the user navigated away). Without
this, a logout that races with a route change will surface "Could not
reach the server" — a confusing lie.

### SF-2: logout failure modes

**Where**: `AuthProvider.tsx:120-129`.

**Fix**: distinguish "logout returned 401" (cookie already gone — best
case) from "logout returned 5xx" (cookie may still be valid). On 5xx,
either retry once with backoff, or surface a quiet warning that the
session may not have been revoked on the server. The current code's
behavior is acceptable for Pass 1 but should land before any
multi-device deploy.

### SF-3: server error message leakage

**Where**: `Login.tsx:222-225`, `:232`.

**Fix**: replace the `err.message` echo with a fixed lookup:
```
const FRIENDLY: Record<number, string> = { 400: 'Please check your entries…', 401: 'Email or password is incorrect.', … };
return FRIENDLY[err.status] ?? 'Authentication failed. Please try again.';
```
This locks the invariant "no server text reaches the auth page" at the
client boundary, regardless of future server changes. Belt-and-braces
against credential-stuffing oracles.

### SF-4: XSS-via-future-drift on error display

**Where**: `Login.tsx:177-181`.

**Fix**: introduce `<ErrorBanner text={error} />` with a one-line
contract ("text only; renders via `{children}` interpolation only").
The JSDoc threat-model claim then matches the code's actual posture
and a future PR adding `dangerouslySetInnerHTML` to that component
gets caught in review.

### SF-5: re-export under verbatimModuleSyntax

**Where**: `useAuth.ts:10`.

**Fix**: verify in CI that `eslint-plugin-react-refresh`'s
`only-export-components` does NOT flag this. If it does, move the
re-exports to `auth-context.ts` and have callers import types from
there directly. The `useAuth.ts` file is sized exactly right (12
lines of code, one hook); don't dilute it.

### SF-6: missing autofocus on email input

**Where**: `Login.tsx:129-141`.

**Fix**: add `autoFocus` on the email input. The threat-model comment
already claims this behavior.

### SF-7: aria-busy / aria-live on submit

**Where**: `Login.tsx:105`, `:183-196`.

**Fix**: add `aria-busy={submitting}` to the form element and
`aria-live="polite"` on a wrapper around the button text so the
"One moment…" state is announced.

### SF-8: register `display_name` empty-string handling

Praise — see PRAISE-adjacent note above. No fix needed.

### SF-9: probe lacks retry on transient failure

**Where**: `AuthProvider.tsx:75-77`.

**Fix**: add a single retry with 500ms backoff on `err.status >= 500`
or `err.code === 'network'`. Out of Pass 1 scope; flag for Pass 3.

### SF-10: shared timeout for fast and slow endpoints

**Where**: `services/api.ts:93-95`.

**Fix**: comment explicitly that Claude-backed routes must override
`timeout`. Better: export a `slowApi` instance with `timeout: 60_000`
or accept timeout per-call from a domain-aware wrapper. Pass-1 OK as
is.

---

## Coordination observations

Cross-cutting notes for slices B/C/D:

1. **ADR-002 amendment needed for deploy topology** (B-1). Without
   this, any reviewer of the server CORS config (slice B?) is
   working from incomplete spec. The server side currently sets
   `secure: cfg.NODE_ENV !== 'development'` — this is right *only*
   if the production deploy is same-origin. Lock it.

2. **`req.log.info({ userId }, 'login success')`** in
   `routes/auth.ts:89,134` is good audit logging — but the
   correlation ID is set by the error middleware
   (`errors.ts:78,86`) and the client doesn't surface it on success
   responses, only on error bodies. If a slice-D screen wants to
   show "if this keeps happening, contact support with code X", X
   needs to come back in success responses too. Out of Pass 1 scope.

3. **Server's `getActiveSession` regex `/^[A-Za-z0-9_-]{42,44}$/`**
   (`auth/sessions.ts:86`) — base64url of 32 bytes is exactly 43
   chars unpadded. The range 42-44 is forgiving; consider tightening
   to `{43}` exactly to reject any malformed input deterministically.
   Not in client review scope but flagged because the client's
   threat-model header in `api.ts` claims "the server is the source
   of truth on token shape" and a senior cross-reads.

4. **`Login.tsx` mode toggle preserves `email` / `password` /
   `displayName` state across the login↔register switch**. Probably
   intentional (don't make the user retype email when they realize
   they need to register). But security-wise, the password field
   value persists across a mode change without clearing — a low-risk
   minor leak if a user walks away after switching modes. Mention to
   slice-D (Login UX). Out of scope for fix-pass.

5. **`AuthProvider`'s `value` memoization** depends on
   `[state.status, state.user, login, register, logout]`. `login`,
   `register`, `logout` are stable (`useCallback` with stable deps).
   `state.user` is a new object every `setState`. The memo will
   recompute every probe even when the user identity is the same
   (server returns a fresh `{ id, email }` object). Inconsequential
   for two consumers; matters if 100+ components consume
   `useAuth`. Future Pass.

6. **No `client/SECURITY.md`** exists yet — the per-file threat-model
   comments are doing the job for now. SENIOR_ENGINEER_BAR.md §2 says
   "Each component writes SECURITY.md — explicit attack-vector
   enumeration + defenses". Defer to Pass 3 when the wired endpoints
   land; flag here so it doesn't slip.
