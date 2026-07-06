# Review

**Scope:** PWA auto-update → user-prompted update (`chore/pwa-auto-update`)
**Files:** `client/vite.config.ts`, `client/src/components/PwaUpdatePrompt.{tsx,test.tsx}`,
`client/src/App.tsx`, `client/src/vite-env.d.ts`, `client/src/styles/index.css`
**Method:** read every file in scope + `node_modules/vite-plugin-pwa` source for the exact
runtime contract; ran `npx tsc -b`, `npx vitest run PwaUpdatePrompt.test.tsx`, and a real
`vite build` (redirected to `/tmp/km-dist-review` — the repo's `dist/` is a stale, root-owned
directory from a prior build and isn't writable by this user; unrelated to this diff) to inspect
the generated `sw.js` and `index.html` directly rather than trust the source comments.

## Verdict

**Approve.** Registration is sound for both new and returning users on every route, including
`/login` — verified by reading the actual `App.tsx` mount point and by inspecting the built output
(`injectRegister: null` correctly produces no auto-injected `registerSW.js`/inline script; the
*only* registration path is `useRegisterSW()` inside `PwaUpdatePrompt`, mounted unconditionally at
app root). Zero BLOCKERs. One real SHOULD-FIX: a genuine visual collision between this new banner
and the existing `InstallPrompt` banner, which can hide the update prompt exactly when it's needed.

## Findings

### BLOCKER
None.

### SHOULD-FIX
1. **`PwaUpdatePrompt`'s banner can be fully hidden behind `InstallPrompt`'s banner.** Both are
   independent fixed-position, centered banners pinned to nearly the same spot just above the
   bottom nav, but at different z-indexes (79 vs 60). If a not-yet-installed user (browser fired
   `beforeinstallprompt`, banner not dismissed) has a tab open when a deploy lands, both banners
   become eligible simultaneously and the install banner will visually cover/block the update
   banner and its Reload button. No mutual-exclusion or vertical-stacking logic ties the two
   together. See Detailed §1.

### NIT
1. `updateServiceWorker(true)`'s `true` argument is currently inert. Verified against the
   installed `vite-plugin-pwa@1.3.0` source: in `generateSW` mode the returned function's
   `reloadPage` parameter is received as `_reloadPage` and never read; the actual
   `window.location.reload()` fires from an internal `wb.addEventListener('controlling', …)`
   listener wired up when the SW first enters `'waiting'`, independent of this argument. Calling
   `updateServiceWorker()` with no argument would behave identically today. Not a defect — `true`
   matches the documented public API and is good future-proofing if the plugin/mode ever changes
   how the argument is used — just worth knowing the mechanism doesn't hinge on it right now.
2. `role="alert"` (assertive, interrupts the screen reader) is defensible for an actionable,
   easy-to-miss banner, but `role="status"` (polite) is the more conventional choice for a
   persistent, non-error, non-time-critical notice. Taste, not correctness.
3. The component only destructures `needRefresh` and `updateServiceWorker` — `offlineReady` is
   never surfaced (no "ready to work offline" acknowledgment on first install). That's outside this
   change's stated scope (fixing the stale-tab-after-deploy problem), just noting the related
   half of `useRegisterSW`'s contract is left unused.
4. The banner offers only "Reload," no dismiss/defer. Acceptable given the app's personal,
   single-user/low-traffic scope (`project_korean_master_personal_scope`), but would deserve a
   second look if concurrent users who might be mid-task (e.g., typing an answer) grows.
5. The `"See REVIEW_PF_pwa SF-1"` comment (`vite.config.ts:53`) points at a review document that
   doesn't exist anywhere in the repo (checked `db/docs/` and a repo-wide filename search). This
   line is carried over verbatim from the *pre-existing* `autoUpdate` comment (confirmed via
   `git diff`), so it's not newly introduced by this change, but it's still a dangling pointer for
   the next reader and could be dropped or replaced with this file's path.

### PRAISE
1. **The registration pattern is exactly vite-plugin-pwa's own recommended "Prompt for update"
   React recipe** — `injectRegister: null` + a single `useRegisterSW()` call — and it's mounted at
   true app root (sibling of `<BrowserRouter>`, outside `<Routes>`, not gated by `RequireAuth`),
   so it registers on `/login` and every authenticated route identically. Confirmed by reading
   `App.tsx`'s actual render tree, not just the comments.
2. **Verified end-to-end against the real plugin, not just its docs.** Read
   `node_modules/vite-plugin-pwa/dist/client/dev/react.js` (a genuine no-op stub used when
   `devOptions.enabled: false`, so `vite dev`/Vitest never attempt a real registration or
   double-register under StrictMode) and `.../dist/client/build/react.js` (the real
   Workbox-backed hook used in production). Then ran a real `vite build` and inspected the
   output: no `registerSW.js` is emitted (confirms `injectRegister: null` actually took effect),
   and the generated `sw.js`'s only wake-up path is a `message` listener for `SKIP_WAITING` — no
   unconditional `self.skipWaiting()`/`clientsClaim()` — which is precisely the "installs but
   waits" lifecycle the PR claims.
3. **The "SW never sees the cross-origin API" claim is verified, not just asserted.** The built
   `sw.js` contains exactly one route registration (`NavigationRoute` → `/index.html` with the
   documented `navigateFallbackDenylist`) and nothing else — no `runtimeCaching` handler exists to
   intercept or replay the credentialed API origin.
4. **The test correctly mocks the actual external boundary** — `virtual:pwa-register/react`, a
   Vite-magic module that doesn't exist under jsdom — rather than trying to fake a real
   `ServiceWorkerRegistration`. Both assertions are meaningful and were confirmed to actually run
   and pass (`vitest run`: 2/2), and would fail on a broken component (e.g. wrong destructuring
   key, banner rendered unconditionally, or `updateServiceWorker` never called on click).
5. `tsc -b` and `vite build` both succeed cleanly with the new `vite-env.d.ts` reference and the
   `injectRegister: null` change — no dev/build breakage from removing the auto-inject.

## Detailed (file:line)

**§1 — Banner collision (SHOULD-FIX):**
- `client/src/styles/index.css:4109-4128` — `.km-pwa-update`: `position: fixed`, `z-index: 60`,
  `bottom: calc(env(safe-area-inset-bottom, 0px) + 78px)`, horizontally centered
  (`left: 50%; transform: translateX(-50%)`).
- `client/src/styles/index.css:320-339` — `.km-install` (InstallPrompt): `position: fixed`,
  `z-index: 79`, `bottom: calc(var(--shell-bottomnav-h) + 12px + env(safe-area-inset-bottom))`
  (`--shell-bottomnav-h: 64px`, defined at `index.css:54`, so effectively `76px + safe-area`),
  same horizontal centering.
- Both banners are ~40-60px tall, centered, and sit within ~2px of each other's baseline offset —
  with `.km-install` at the higher z-index, it paints over `.km-pwa-update` whenever both are
  eligible at once (uninstalled user + a deploy landing while their tab is open).
- Mount sites, confirming both can be simultaneously present: `client/src/App.tsx:112` (`<InstallPrompt />`)
  and `client/src/App.tsx:116` (`<PwaUpdatePrompt />>`), both unconditional siblings at app root.

**Registration/lifecycle correctness:**
- `client/src/App.tsx:63-117` — `<PwaUpdatePrompt />` and `<InstallPrompt />` are mounted as
  direct children of `<ToastProvider>`, as siblings of `<BrowserRouter>` — outside `<Routes>` and
  outside `<RequireAuth>`, so they mount identically on `/login` and every authenticated route.
  No route/auth gating exists that could suppress SW registration for any user class.
- `client/vite.config.ts:46-60` — `registerType: 'prompt'`, `injectRegister: null`,
  `devOptions: { enabled: false }`.
- `client/src/components/PwaUpdatePrompt.tsx:19-25` — destructures
  `needRefresh: [needRefresh]` and `updateServiceWorker` from `useRegisterSW()`; matches the real
  hook's return shape (`{ needRefresh: [bool, setter], offlineReady: [bool, setter], updateServiceWorker }`)
  verified directly against `node_modules/vite-plugin-pwa/dist/client/build/react.js`.
- `client/src/components/PwaUpdatePrompt.tsx:33-35` — `void updateServiceWorker(true)` on click;
  the `true` argument is inert in this plugin version (see NIT §1) but harmless and matches the
  documented contract.
- Build verification: `npx vite build --outDir /tmp/km-dist-review` — no `registerSW.js` emitted
  (old `autoUpdate` build under the repo's stale `client/dist/registerSW.js` did emit one, for
  contrast); generated `/tmp/km-dist-review/sw.js` contains only
  `self.addEventListener("message", e => { if (e.data?.type === "SKIP_WAITING") self.skipWaiting() })`
  plus `precacheAndRoute` + one `NavigationRoute` — no auto `skipWaiting()`/`clientsClaim()`, no
  API route handling.
- `client/src/components/PwaUpdatePrompt.test.tsx:14-16` — mocks the `virtual:pwa-register/react`
  boundary correctly (the right thing to mock: it's not real under jsdom). Tests at lines 26-34
  (no-op when clean) and 36-50 (banner + `updateServiceWorker(true)` on tap) both ran and passed.
- `client/src/vite-env.d.ts:1-2` — adds `/// <reference types="vite-plugin-pwa/react" />` on top
  of the existing `vite/client` reference; confirmed the type declarations exist at
  `node_modules/vite-plugin-pwa/react.d.ts`.

**Dev/build regression check:**
- `npx tsc -b` — clean, no errors.
- `npx vitest run client/src/components/PwaUpdatePrompt.test.tsx` — 2/2 passed.
- `npx vite build` (redirected outDir) — succeeded; confirms `devOptions.enabled: false` +
  `injectRegister: null` don't break the production build, and the dev-mode stub
  (`node_modules/vite-plugin-pwa/dist/client/dev/react.js`) means `vite dev`/Vitest never attempt
  a real registration.

## Re-review

**PASS** — SHOULD-FIX resolved; no new blocker.

The banner collision is fixed correctly. `.km-pwa-update` (`client/src/styles/index.css:4111-4136`)
now shares `.km-install`'s exact positioning convention — same `bottom`
(`calc(var(--shell-bottomnav-h) + 12px + env(safe-area-inset-bottom))`), same `width`/`max-width` —
and sits at **z-index 80 > the install banner's 79**, so the update prompt is always on top and its
Reload button is never covered. The two can still visually overlap when both are eligible at once,
but that's now a deliberate, correct stacking (update prompt on the highest surface, `--ink-3`, with
its own hairline border + shadow reading clearly against the install banner behind it) rather than
the reload button being blocked. Stacking-on-top with distinct surfaces is an acceptable resolution
for this app's scope — no residual overlap problem.

Verified:
1. **Tokens all exist** — `--shell-bottomnav-h` (`index.css:54`, 64px), `--shell-max-width`
   (`index.css:55`, 480px), `--ink-3` (`index.css:23` light / `:62` dark), `--line-strong`
   (`index.css:50` light / `:83` dark). Both themes defined; no undefined-var fallback risk.
2. **NIT cleared** — the dangling `REVIEW_PF_pwa SF-1` reference is gone from `vite.config.ts`
   (grep: no match).
3. **No new blocker** — `tsc -b` clean. `updateServiceWorker(true)` and `role="alert"`
   deliberately retained (both were NITs, not required changes); positions unchanged.

Remaining open items are all prior NITs (inert `true` arg, `role="alert"` vs `status`, unused
`offlineReady`, no dismiss/defer) — none blocking. Ship it.
