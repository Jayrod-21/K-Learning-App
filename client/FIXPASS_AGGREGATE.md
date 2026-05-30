# /fixpass — Pass 1 aggregate

> Aggregator: parent session. Sources: `REVIEW_A_auth.md`, `REVIEW_B_design.md`,
> `REVIEW_C_shell.md`, `REVIEW_D_foundation.md`. Date: 2026-05-29.

## Reviewer roll-up

| Reviewer | Surface | Verdict | BLOCKER | SHOULD-FIX | NIT | PRAISE |
|---|---|---|---:|---:|---:|---:|
| A — auth + API | `services/api.ts`, `hooks/{auth-context, AuthProvider, useAuth}.tsx`, `pages/Login.tsx` | PASS WITH CONDITIONS | 2 | 10 | 7 | 10 |
| B — design + tokens + bones | `styles/index.css`, theme provider trio, 7 stateless bones, `Icon.tsx` | PASS WITH CONDITIONS | 0 | 2 | 9 | 9 |
| C — nav + shell + routing | `BottomNav`, `MoreSheet`, `Shell`, `ErrorBoundary`, `App`, `main`, `ScreenStub`, `nav.ts`, `cn.ts` | PASS WITH CONDITIONS | 0 | 2 | 7 | 3 |
| D — foundation + plan compliance | configs, manifest, env, `tsconfig`, `eslint`, `TESTS.md`, plan-vs-built | PASS WITH CONDITIONS | 1 | 3 | 8 | 8 |
| **Total** | — | **PASS WITH CONDITIONS** | **3** | **17** | **31** | **30** |

## BLOCKERs — every one, explicitly

| ID | Source | File:line | Headline | Recommended fix |
|---|---|---|---|---|
| **A-B1** | A | `services/api.ts:11-26`, ADR-002 D3 | Cross-origin cookie posture not locked: `SameSite=Strict` will silently 401 every request from a cross-site prod deployment. Dev is fine (same-site `localhost:*`); prod is undefined. | (a) Document the deploy origin contract (same-origin reverse-proxy is the safe default). (b) Add a startup runtime warning in `api.ts` when `VITE_API_URL` is non-empty, non-localhost, while the page is HTTP. (c) Note the open question in `client/SECURITY.md` (see D-B1). |
| **A-B2** | A | `hooks/AuthProvider.tsx:93,104` | Login/register race vs in-flight `/auth/me` probe: probe A returns 401 *after* `login()` optimistically sets `authenticated`, clobbering it back to `guest`. Guaranteed UX bug on slow connections. | In `login` and `register`, call `probeRef.current?.abort()` **before** the POST, then optimistic state-set stays correct. Or replace optimistic-set with re-probe (matches `logout`'s shape). |
| **D-B1** | D | `client/SECURITY.md` (missing) | Bar §2 + §5 explicitly require a `SECURITY.md` per component. Every other component has one; client doesn't. | Promote the threat-model comment blocks from `api.ts`, `AuthProvider.tsx`, `Login.tsx` into `client/SECURITY.md`. Add the missing surfaces (CORS contract, PWA manifest hijack, env-var leak via `import.meta.env`, lockfile supply chain, dev-server bind, CSP gap). |

## Top SHOULD-FIX (highest impact)

| ID | Source | Headline |
|---|---|---|
| **D-S1** | D | `package-lock.json` still resolves `@supabase/*` tree and `node_modules/@supabase/*` is still installed — `npm ci` would reinstall it. Delete on-disk + regenerate lockfile. |
| **C-1** | C | MoreSheet focus restoration documented but unimplemented — keyboard/VoiceOver loses focus to `<body>` on Esc. |
| **C-2** | C | `BottomNav.matchActiveId` uses bare `startsWith(it.path)` — a future `/topik-history` would light "TOPIK". Add path-boundary check. |
| **B-1** | B | Hard-coded `#FBF6E6` / `#15110D` on-vermilion text colour in 3 CSS rules — introduce `--on-vermilion` token before Pass 2 propagates the constant. |
| **B-2** | B | First-paint FOUC because theme attribute applies in `useEffect`. Either `useLayoutEffect` or a synchronous IIFE in `index.html` (canonical no-flash pattern). |
| **A-SF-1** | A | `api.ts` collapses `status === 0` to `'network'` — discriminate `ECONNABORTED`/`ERR_CANCELED` so Login's user-facing message is accurate. |
| **A-SF-3** | A | `Login.messageFor` echoes `err.message` for unhandled 4xx — a future server PR that adds a detailed validation message will leak through. Pick a fixed `(status, code)` table. |
| **D-S2** | D | PWA manifest has only a single SVG icon at `"any maskable"` — fails iOS install + Android adaptive icons. Add 192/512 PNG + apple-touch-icon. (Plan defers the install banner to Pass Final; the manifest as it stands is still shipping incorrect metadata.) |
| **D-S3** | D | `client/README.md` is the unedited Vite scaffold. Bar §3 requires per-module README. |
| **A-SF-2** | A | `logout` 5xx edge: re-probe will succeed if cookie still valid → user appears logged out then bounces back. Document the trade-off; the behavior itself is correct. |
| **A-SF-4** | A | Future-drift XSS guard: never echo unvalidated server message for unauthenticated routes — same fix as SF-3. |
| **A-SF-6** | A | Login email field has no `autoFocus` despite threat-model doc saying first field receives focus. |
| **A-SF-7** | A | Submitting form has no `aria-busy="true"` / live region update — screen-reader users get no feedback. |
| **A-SF-8** | A | `register` only sends `display_name` when non-empty — but trimmed empty becomes `undefined`, dropping the field entirely. Sound today; brittle if server adds a "blank name" path. |
| **A-SF-9** | A | No retry/backoff on initial `/auth/me` probe — one-shot 5xx puts the user at login with no recovery. |
| **A-SF-10** | A | `apiRequest` `timeout: 10_000` is request-level, not idle-timeout. Streaming endpoints (Pass 3 chat) will hit it. |

## Cross-cutting observations

1. **Threat-model paragraphs are 80% of `SECURITY.md` already** — A, D both
   flag the comments as exemplary (A-P1, D-P1) and D escalates the missing
   `SECURITY.md` to BLOCKER. The fix-pass should *promote* not *rewrite*.
2. **The provider/context/hook three-file split** (A-P4, B-PRAISE, D-N/A)
   is load-bearing for React Refresh and praised by every reviewer who
   touched it. **Do not collapse.**
3. **`AbortController` for the auth probe** (A-P-handled-StrictMode-correctly,
   C-PRAISE, D-P2) is correct for unmount + StrictMode but does NOT
   currently abort on login/register — that's A-B2's whole point.
4. **Plan deviation `/auth/signup` → `/auth/register`** is the right call;
   D-N/A flagged for plan-doc correction, not code change.
5. **Pillbox radius 999px** (B-#6) contradicts the *README*'s 3px claim but
   matches the prototype's `styles.css`. Prototype wins; README is the
   stale document.

## PRAISE — fix-pass must not undo

- A-P1 / D-P1 — threat-model comment blocks in `api.ts`, `AuthProvider.tsx`,
  `Login.tsx`.
- A-P4 — provider / hook / context three-file split.
- A-P2 / A-P3 — `ApiError` boundary type + `isServerErrorBody` type guard.
- A-P5 — discriminated-union auth state.
- A-P6 — logout best-effort POST then unconditional local clear then re-probe.
- A-P7 — `useAuth` throws if used outside `<AuthProvider>`.
- A-P8 / A-P9 — `autoComplete` discrimination on the password field + double-submit guard.
- B-PRAISE — token block is one-for-one with prototype's `styles.css`; Icon
  set is a strict superset with `<title>`-first SVG; `forwardRef` on Button;
  `min-height: 100dvh`; `color-mix` for the BottomNav backdrop.
- C-PRAISE — `navItem()` Map+throw, `matchActiveId` longest-prefix shape,
  StrictMode-safe AbortController plumbing.
- D-P2..P8 — same threat-model praise plus `BottomNav` location-derived
  active state, `lib/nav.ts` single source of truth, token-block fidelity,
  `verbatimModuleSyntax + erasableSyntaxOnly + noUncheckedSideEffectImports`.

## Recommendation

Dispatch a single fix-pass agent against:
- Every BLOCKER (3): A-B1, A-B2, D-B1.
- Top 8 SHOULD-FIX: D-S1, C-1, C-2, B-1, B-2, A-SF-1, A-SF-3, D-S2.
- Cheap-while-in-file SHOULD-FIX: A-SF-6, A-SF-7, A-SF-8, A-SF-9, A-SF-10,
  A-SF-2 (docstring-only), A-SF-4 (folded into SF-3), D-S3.

NITs are out of scope unless trivially fixable while editing the same file.
