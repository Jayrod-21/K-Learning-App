# Review D: Foundation + Plan Compliance (Pass 1)

Reviewer: Independent senior (30 yrs), no prior involvement in this Pass.
Scope: client foundation files + plan-vs-built diff + cross-cutting compliance.
Date: 2026-05-29.

---

## Summary verdict

**Conditional approve — one BLOCKER, three SHOULD-FIXes.**

Pass 1 is otherwise well-executed. The configuration files are clean and
opinionated, the auth wiring matches ADR-002 cookie semantics precisely, the
threat-model comments in `api.ts`, `AuthProvider.tsx`, and `Login.tsx` are
the best examples of "WHY in code" I've seen in this repo, and the nav
manifest is the right shape to carry through Pass 2+. The token block in
`styles/index.css` mirrors the design spec one-for-one.

The blocker is structural and required by the project's own bar: **no
`client/SECURITY.md` exists.** The bar (`SENIOR_ENGINEER_BAR.md` §2 "Security"
last bullet, plus §5 done-checklist) says every component writes one. Server,
db, db/migrations, and services/kiwi each have one. The client does not.
Pass 1 introduced cookie-session auth, a login form, an axios layer with
credentials, and a PWA manifest — every one of these is an attack surface
that deserves enumerated defences in a file a reviewer can audit without
diff-spelunking. The threat-model paragraphs in the source comments are
excellent and should be lifted into `SECURITY.md` with cross-references back.

Beyond the blocker, the supabase deletion is incomplete (lockfile still
carries the dep tree), the manifest icon set is single-SVG-only which will
fail an install prompt on iOS, and the README is still the Vite scaffold
boilerplate.

---

## Bar checklist (`SENIOR_ENGINEER_BAR.md` §5)

Applied to the Pass 1 client surface only.

| Item | Status | Note |
|---|---|---|
| Lint passes | ✅ assumed | `TESTS.md` declares `client-lint` must-pass; not executed in this review. |
| Type-check passes (strict) | ✅ assumed | `client-build` runs `tsc -b && vite build` per TESTS.md. tsconfig has `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports`, `erasableSyntaxOnly`, `verbatimModuleSyntax`. Good. |
| All tests pass | ⚠️ | No client test runner registered. Acceptable in Pass 1 (no logic to test yet); flag for Pass 2 when components do work. |
| Every public function tested | ⚠️ | Same as above. |
| `EXPLAIN ANALYZE` on queries | n/a | Client. |
| **`SECURITY.md` written** | ❌ **BLOCKER** | Client folder has none. Bar is explicit. |
| README written with "how to test" | ❌ SHOULD-FIX | `client/README.md` is the Vite scaffold default — no project-specific run/test/env instructions. |
| ADR for non-obvious decisions | ⚠️ | Several Pass 1 decisions warrant ADRs (proxy removal, no Redux, single-SVG manifest icon). Plan-level documentation exists; project ADR set could absorb. Not blocking. |
| No `TODO`/`FIXME` without ticket | ✅ | None found. |
| No `console.log`/`print` | ✅ | None. |
| No commented-out code | ✅ | None. |
| No hardcoded secrets/URLs/paths | ✅ | Base URL via env. One acceptable default in `.env.example` (`http://localhost:4000`). |

---

## Findings

### BLOCKER

- **B1. `client/SECURITY.md` is missing.** Required by `SENIOR_ENGINEER_BAR.md` §2 ("Each component writes `SECURITY.md` — explicit attack-vector enumeration + defenses") and §5 done-checklist. Every other component (server, db, db/migrations, services/kiwi) has one. The client Pass 1 added: cookie-session auth client, registration form, axios layer with credentials, PWA manifest, theme-color contract — all attack-relevant. The threat-model paragraphs in `services/api.ts` lines 8–26, `hooks/AuthProvider.tsx` lines 8–18, and `pages/Login.tsx` lines 9–26 are already 80% of the content needed; promote them and add the missing surfaces (CORS contract, PWA manifest hijack/install-prompt, env-var leak via `import.meta.env`, supply-chain via lockfile, dev-server bind, content-security-policy gap).

### SHOULD-FIX

- **S1. Supabase removed from `package.json` but `package-lock.json` still resolves the entire `@supabase/*` tree.** `package-lock.json` line 11 still pins `@supabase/supabase-js: ^2.99.2`, and `node_modules/@supabase/{auth-js,functions-js,postgrest-js,realtime-js,storage-js,supabase-js}` are still present on disk (18 lockfile mentions, 6 installed packages). Reproducible builds will reinstall the supabase tree on `npm ci`, which (a) defeats the deletion, (b) keeps a non-trivial attack surface in the bundle's dep graph, (c) makes the lockfile lie about intent. Run `npm install` (or `npm uninstall @supabase/supabase-js`) to regenerate the lockfile and delete the on-disk packages.

- **S2. PWA manifest has no rasterised icon and the only icon is `purpose: "any maskable"` on an SVG.** `public/manifest.webmanifest:13-20` defines a single icon entry: `/favicon.svg`, `sizes: "any"`, `purpose: "any maskable"`. iOS Safari (the principal install target on a mobile-first PWA) does not render maskable SVG icons for `apple-touch-icon`. Android Chrome's install prompt requires at minimum a 192×192 and a 512×512 PNG with `purpose: "any"`; having only "any maskable" causes Chrome to also synthesise a fallback that often looks worse than no icon. Per `Claude Design/.../README.md` line 461 "**No bitmap/illustration assets.**" but that's about content imagery, not the launcher icon. Add at least: 192×192 PNG (`purpose: "any"`), 512×512 PNG (`purpose: "any"`), 512×512 PNG (`purpose: "maskable"`), and an `apple-touch-icon` link in `index.html`. The PWA install banner is a Pass-Final item (plan line 257) so this can slip if explicitly scheduled, but the manifest as it stands is shipping incorrect metadata today.

- **S3. `client/README.md` is the unedited Vite scaffold.** Reads as "React + TypeScript + Vite" with stock copy about Oxc vs SWC and ESLint type-checked config. Bar §3 requires a project README with "what it does, how to run it, how to test it, gotchas." For the client lane that means: env vars (`VITE_API_URL`), expected server origin + CORS contract pointer, `npm run dev` / `lint` / `build`, the BottomNav+MoreSheet IA, and a "Pass 1 status: skeleton" note so a fresh reader knows the screen bodies are stubs by design.

### NIT

- **N1. `vite.config.ts:21` binds dev server to `0.0.0.0`.** Documented choice (mobile-first dev, want to test from a phone on the same LAN). Two refinements worth considering: (a) gate behind an env var (`HOST=0.0.0.0 npm run dev`) so the default is loopback-only — currently any device on the LAN reaches a dev build with full source maps, (b) at minimum, add a sentence to the comment block on lines 5–16 explaining the LAN exposure trade-off so the next reader doesn't have to reason about it. Vite's dev server is not designed to be exposed; binding-by-default is a footgun.

- **N2. `eslint.config.js:19` sets `ecmaVersion: 2020` but tsconfig targets ES2023.** Inconsistent. Lint won't catch syntax legal in 2021–2023 — minor, but it's literally a one-line fix to align them.

- **N3. `eslint.config.js` doesn't extend `jsx-a11y` rules.** The Pass 1 components do hand-rolled a11y (aria-labels, role="alert", focusring, aria-current, aria-modal, aria-busy/live) — visibly thoughtful, and the right things were done. But there's no automated check, so the next pass's component additions could regress silently. `eslint-plugin-jsx-a11y` is a single dep + extend. Worth doing now while the surface is tiny.

- **N4. `tsconfig.app.json:7` library set has no `"WebWorker"` despite being a PWA.** If/when service worker registration lands (Pass Final), the SW source file will need its own tsconfig anyway, so this isn't urgent. Note it now to avoid future churn.

- **N5. `index.html:15` Google Fonts CSS2 string requests Noto Serif KR weights 400/500/600/700.** Design spec README line 459 says "Noto Serif KR (400–700)" — covered. Inter and Noto Sans KR weights 300–700 — covered. Match exact. (Praise on getting this right; nit is just the size of the request. Fonts loaded eagerly add ~120kb. Consider `&display=swap` is already there — good. `font-display: optional` for one of the three families would be a Pass-Final tuning.)

- **N6. `public/manifest.webmanifest` has no `id` field.** Without `id`, Chrome derives identity from `start_url` + `scope`, which is fine until those change; an explicit `id: "/"` future-proofs against a re-prompt scenario.

- **N7. `manifest.webmanifest` has no `screenshots` array.** Required for richer install UI on Chrome Android. Pass-Final.

- **N8. No CSP meta tag in `index.html`.** Cookie auth + cross-origin API + Google Fonts mean a real CSP is non-trivial; Pass Final is the right time. Note here so it's not forgotten.

### PRAISE

- **P1. Threat-model comments in `api.ts`, `AuthProvider.tsx`, and `Login.tsx` are exemplary.** Concrete vectors, concrete defences, concrete delegations to server. Exactly what the standing-orders §3 "WHAT specific attacks exist for this type of app and HOW do we defend against each one" asks for. This is the bar for the whole codebase. Once promoted into `SECURITY.md` (BLOCKER B1), they become a contract instead of a comment.
- **P2. `AuthProvider.tsx:56-79` handles the StrictMode-double-mount race correctly via `AbortController`.** A junior engineer would have shipped a double `GET /auth/me` on every page load.
- **P3. `AuthProvider.tsx:120-129` re-probes after logout** — defence in depth against a server-side cookie-clear failure. Most logout implementations only zero the local state.
- **P4. `Login.tsx:216-235` maps `ApiError.status` codes to safe user-facing strings** and explicitly does NOT distinguish "wrong email" from "wrong password" — username-enumeration defence, properly delegated to the server's collapsed shape and reflected on the client.
- **P5. `BottomNav.tsx:83-95` computes the active tab from `useLocation`, not props,** with longest-prefix matching. Survives deep links, browser back/forward, and nested routes. The right shape.
- **P6. `lib/nav.ts` is a single-source-of-truth manifest** with a discriminated-union `NavItemId`, a `Map<>` lookup with a throw-on-miss guard — both the routing in `App.tsx`, the BottomNav, and the MoreSheet read from it. Pass 2 will thank Pass 1.
- **P7. `styles/index.css` token block is exact-match to the design spec** with `--vermilion = #B83A2E`, full dark inversion, `.kr` / `.kr-display` / `.hanja` utility classes, all named per `Claude Design/.../styles.css` so future ports are mechanical.
- **P8. `tsconfig.app.json` ships with `verbatimModuleSyntax` AND `erasableSyntaxOnly` AND `noUncheckedSideEffectImports`** — these are the 2025+ TS-strictness knobs most teams still don't turn on. Right call.

---

## Plan deviations

Pass 1 plan (`CLAUDE_DESIGN_INTEGRATION_PLAN.md` §Pass 1) vs what was built.

| # | Planned | Built | Risk | Verdict |
|---|---|---|---|---|
| D1 | "`useAuth.ts` — rewrite: `GET /auth/me` probe, `POST /auth/login`, **`POST /auth/signup`**, `POST /auth/logout`" | Implementation calls `POST /auth/register` (correct: matches `server/src/routes/auth.ts:58`). | Low. Plan was wrong; implementation chose the actual server endpoint. Both the comment header in `routes/auth.ts:4-6` and the route declaration at line 58 use `/register`. | **Plan was wrong; build is right.** Update the plan doc to read `signup` → `register` so Pass 2/3 reviewers don't trip on the same. |
| D2 | "`hooks/useAuth.ts` — rewrite ... preserve `{ user, loading }` shape" | Refactored into three modules: `auth-context.ts` (types + context object), `AuthProvider.tsx` (component + state), `useAuth.ts` (hook). Shape extended: `{ status, user, loading, login, register, logout }`. | Low. Extension is additive; `{ user, loading }` still works for legacy callers. Split is the textbook React-Refresh-rule fix (component file vs hook file vs context file). Improvement, not deviation. | **Defensible extension.** Worth one line in the next checkpoint so future "but the plan said one file" arguments don't waste cycles. |
| D3 | "`components/Navigation.tsx` — delete (replaced by `BottomNav`)" | Confirmed deleted. Filesystem check: `find src/ -name Navigation.tsx` returns nothing. | None. | **Compliant.** |
| D4 | Plan: legacy pages "Curriculum/Dashboard/Vocab/GrammarList/GrammarLesson" stripped from `App.tsx`. Plan exit criterion: "`archive/legacy-client/` not yet created (do at Pass 3 when last legacy page retires)." | Legacy pages appear to have been **deleted outright**, not just stripped from routes (no `src/pages/{Dashboard,Curriculum,Vocabulary,GrammarList,GrammarLesson}.tsx` files exist). `archive/legacy-client/` does NOT exist either. | **Medium.** Plan explicitly said "archive at Pass 3 when last legacy page retires" — implying the files were to survive in `src/pages/` (or somewhere reachable) through Pass 2 in case Pass 2/3 needed to reference design decisions. Deleting them now means Pass 3's "Reading screen wiring" team has lost the only working reference for how the legacy Reading screen handled tap-a-word / passage rendering. Git history covers this, but git is a worse interface than a file in the tree. **Verdict: defensible if deliberate, undocumented otherwise.** Recommend: add a sentence to `.project-state.md` confirming this was intentional and the reference is "git log of commit X" so Pass 3 doesn't waste a half-day re-discovering legacy logic. |
| D5 | Plan listed components: `Card`, `Button`, `Pill`, `Eyebrow`, `BottomNav`, `MoreSheet`, `Icon`, `SealStamp`, `DoubleRule` (9 bones). | Built: same 9 + `Shell` + `ErrorBoundary`. | None. `Shell` is explicitly called out as a separate file in the plan (line 60 of plan); `ErrorBoundary` is a reasonable additive precaution. | **Compliant + improvement.** |
| D6 | Plan: "`pages/ScreenStub.tsx` — create: shows eyebrow + serif Korean title + 'Pass N: feature coming' placeholder." | Built: `ScreenStub` reads from the central `lib/nav.ts` manifest by id, includes per-screen `comingCopy` per-route in `App.tsx`. | None. Cleaner factoring than the plan called for. | **Compliant + improvement.** |
| D7 | Vite proxy — plan didn't explicitly call out removal. | Built: no proxy; comment block in `vite.config.ts:5-16` explains why (server mounts at `/auth`, `/vocab`, ... not `/api/*`, so a rewrite would only obscure the URL shape). | Low. Adds a CORS dependency in dev (server must include the client dev origin in `CLIENT_ORIGIN`). Note in `.env.example:3-4` documents this. | **Defensible.** A proxy would be the alternative; the choice is reasonable and the trade-off documented in comments. |
| D8 | Plan: "`.env.example` — drop `VITE_SUPABASE_*`, add `VITE_API_URL`." | Built: clean. No supabase vars; `VITE_API_URL=http://localhost:4000` with CORS / same-origin comment. | None. | **Compliant.** |
| D9 | Plan: 11 routes navigable. | Built: 11 routes in `App.tsx:42-167` (today, topik, reading, review, diagnostic, grammar, hanja, images, chat, reference, settings) + `/login` + catch-all `*`. | None. | **Compliant.** |
| D10 | Plan: `client/package.json` remove `@supabase/supabase-js`. | Built: removed from `package.json:12-20`. **NOT removed from `package-lock.json`** — line 11 still has `@supabase/supabase-js: ^2.99.2` as a root dep, and 6 supabase packages still installed in `node_modules/`. | **Medium.** Lockfile drift means `npm ci` will reinstall supabase. Bundle size unaffected if tree-shaken, but the dep graph still ships in `npm audit` results, vulnerability scanners, and `npm ls`. Called out in finding S1. | **Partial — see S1.** |
| D11 | Plan: PWA manifest. | Built: manifest exists with correct hanji `--ink` background-color and theme-color, lang=ko, display=standalone, scope/start_url=/, single SVG icon as "any maskable". | **Medium.** Single SVG icon at "any maskable" will produce wrong launcher icons. See S2. | **Compliant on shape, deficient on icon set.** |
| D12 | Plan: `client/src/styles/index.css` full design token block. | Built: full hanji light + Sumi dark token block + `.kr` / `.kr-display` / `.hanja` utility classes, paper-grain background. Matches design spec one-for-one. | None. | **Compliant.** |
| D13 | Plan: bare `useAuth` shape preserved. | Built: `Login.tsx` calls `login(email, password)` and `register(email, password, displayName?)` directly; `AuthProvider.tsx:108-118` sends `display_name` (snake_case) matching server's `RegisterSchema`. | None. Wire is correct. | **Compliant.** |
| D14 | Plan: server endpoint name `/auth/signup`. | Built endpoint name: `/auth/register`. (See D1.) | Low (consistent with server). | **Plan-doc error; build correct.** Update plan. |

---

## Detailed findings (file:line + fix)

### B1 — Missing `client/SECURITY.md`

**Location:** `Repository/client/SECURITY.md` does not exist.
**Bar reference:** `SENIOR_ENGINEER_BAR.md` §2 last bullet ("Each component writes `SECURITY.md` — explicit attack-vector enumeration + defenses") + §5 ("`SECURITY.md` written, attack vectors enumerated").
**Other components compliant:** `Repository/server/SECURITY.md`, `Repository/db/SECURITY.md`, `Repository/db/migrations/SECURITY.md`, `Repository/services/kiwi/SECURITY.md`.
**Required surfaces for this file:**
1. Cookie session model — pointer to ADR-002, defence: HttpOnly/Secure/SameSite=Strict (delegated to server but contract documented here).
2. CORS contract — `withCredentials: true` requires server `Access-Control-Allow-Credentials: true` with a non-`*` `CLIENT_ORIGIN`; mismatch silently strips the cookie. Defence: env-var contract documented in `.env.example` and here.
3. XSS — React's default escaping is the primary defence; no `dangerouslySetInnerHTML` introduced in Pass 1; cookie HttpOnly removes session-theft path.
4. CSRF — SameSite=Strict primary, ADR-002 D4 backup. If proxy ever returns or `SameSite` ever loosens (OAuth callbacks, etc.), CSRF token must be added — explicit warning.
5. Open-redirect — `PublicOnly` honours `location.state.from` in `App.tsx:204-208`; **note: today this is read as `unknown` and only type-checked as `string`, but the value could be an external URL.** Worth a one-line check in `App.tsx:206` that `target.startsWith('/')` to defeat `from = "https://evil.com"` from a malicious deep link. (This is itself a SHOULD-FIX hiding inside the BLOCKER fix; calling it out separately would be S4 if scope wasn't already long enough.)
6. Supply chain — lockfile audit, `npm audit` in CI, dependabot or equivalent. Note: supabase tree currently still in lockfile (S1).
7. Environment variables — `import.meta.env.VITE_*` is bundled into the public build; **never** put secrets in `VITE_*` vars. Document the trap.
8. PWA manifest hijack — `start_url` and `scope` lock the install identity; document why they're `/` and what changes if they move.
9. Dev server bind — `host: '0.0.0.0'` exposes dev builds on LAN (see N1). Document the trade-off and the prod posture.
10. Content Security Policy — currently none. Document as a known gap with target pass.

**Fix:** Create `Repository/client/SECURITY.md` covering items 1–10 above, cross-referencing the threat-model comments in `api.ts`, `AuthProvider.tsx`, and `Login.tsx`. Promote the comment content; replace the comment paragraphs with a one-line `See SECURITY.md §N` pointer to keep the source files lean.

### S1 — Supabase still in lockfile + `node_modules`

**Location:** `Repository/client/package-lock.json:11` (`"@supabase/supabase-js": "^2.99.2"` listed as root dep). 18 total matches in lockfile across `auth-js`, `functions-js`, `postgrest-js`, `realtime-js`, `storage-js`, `supabase-js` packages. 6 directories present under `node_modules/@supabase/`.
**Risk:** `npm ci` on a fresh machine (CI, new contributor, deploy) reinstalls supabase. `npm audit` will flag the supabase tree's CVEs. `npm ls @supabase/supabase-js` returns it as a top-level dep.
**Fix:** From `Repository/client/`, run `npm uninstall @supabase/supabase-js` (regenerates lockfile and removes from `node_modules`), then `git diff package-lock.json` should show ~150 lines deleted across the 6 supabase packages. Verify with `npm ls @supabase/supabase-js` returning "not found".

### S2 — PWA manifest icon set incomplete

**Location:** `Repository/client/public/manifest.webmanifest:13-20`.
**Issue:** Single icon at SVG + `purpose: "any maskable"`.
**Required for proper install on the principal target (iOS Safari + Android Chrome):**
- 192×192 PNG, `purpose: "any"` (Chrome install banner thumbnail).
- 512×512 PNG, `purpose: "any"` (splash screen / launcher).
- 512×512 PNG, `purpose: "maskable"` (Android adaptive icon).
- Keep the SVG as `sizes: "any"`, `purpose: "any"` (browsers that prefer SVG).
- Add `<link rel="apple-touch-icon" href="/apple-touch-icon.png" />` (180×180) to `index.html` for iOS home-screen.
**Why not now:** Plan §Pass Final line 257 calls "manifest icons (vermilion seal on cream)" out, so deferring is on-plan. However the manifest as it stands today will fail an install prompt — better to either delete the manifest until Pass Final or ship a placeholder PNG set now. Recommend the placeholder PNG set: at least Chrome's install criteria are met, and the visual treatment can be refined later.

### S3 — `client/README.md` is Vite scaffold boilerplate

**Location:** `Repository/client/README.md`.
**Issue:** Reads as "React + TypeScript + Vite" template — no project context.
**Required by bar §3:** "README per module — what it does, how to run it, how to test it, gotchas."
**Minimum content for Pass 1 README:**
- One-paragraph project context (link up to `/PROJECT.md`).
- `npm run dev` / `npm run lint` / `npm run build`.
- `.env` setup (`VITE_API_URL` and the CORS contract with the server).
- Pass status note ("Pass 1 skeleton — every route is a `ScreenStub`; Pass 2 fills bodies").
- Architecture pointer (`SECURITY.md`, `src/lib/nav.ts` as nav SoT, `src/styles/index.css` as token SoT).

### N1 — Dev server binds 0.0.0.0 unconditionally

**Location:** `vite.config.ts:19-22`.
**Fix:**
```ts
server: {
  port: Number.parseInt(process.env.PORT ?? '4173', 10),
  // Bind to 0.0.0.0 only when explicitly requested (e.g. `HOST=0.0.0.0 npm run dev`
  // to test from a phone on the same LAN). Default loopback keeps the dev
  // build off the network.
  host: process.env.HOST ?? '127.0.0.1',
},
```

### N2 — ESLint `ecmaVersion: 2020` vs tsconfig `target: ES2023`

**Location:** `eslint.config.js:19` vs `tsconfig.app.json:5`.
**Fix:** Bump `ecmaVersion` to 2023 in `eslint.config.js`.

### N3 — Missing jsx-a11y plugin

**Fix:** Add `eslint-plugin-jsx-a11y` and extend `.recommended` in `eslint.config.js`. Pass 1 components already follow the rules manually; lint will codify.

### A11y rooting (separate praise + nit)

The hand-rolled a11y in `BottomNav.tsx`, `MoreSheet.tsx`, `Login.tsx`, and `App.tsx`'s `BootSkeleton` is genuinely good (aria-current, aria-modal+aria-labelledby+role=dialog, role=alert, aria-busy+aria-live, focusring class). Lint plugin should be additive, not a fix.

### Open-redirect note (sub-finding under B1)

**Location:** `App.tsx:198-213`, specifically line 206:
```ts
const target = typeof state?.from === 'string' ? state.from : '/';
```
**Issue:** `target` can be any string. If a malicious deep link sends a user to `/login` with `state = { from: 'https://evil.com/phish' }`, the redirect after login goes off-origin. React Router's `navigate(target)` will happily navigate to any URL.
**Fix:** Add a defence:
```ts
const candidate = typeof state?.from === 'string' ? state.from : '/';
const target = candidate.startsWith('/') && !candidate.startsWith('//') ? candidate : '/';
```
The `!candidate.startsWith('//')` is the protocol-relative-URL defence (`//evil.com/...` is a same-origin redirect in some routers).

---

## Coordination observations

1. **Plan-doc accuracy debt.** The `signup` vs `register` mismatch (D1/D14) is a small but real cost — every future reviewer of this plan has to cross-check server reality. One-line fix in `CLAUDE_DESIGN_INTEGRATION_PLAN.md`. Recommend a "plan as built" delta-log section in the doc itself so deviations like D2 (auth split into 3 files), D4 (legacy pages deleted not archived), D7 (proxy omitted) accumulate visibly instead of as oral tradition.

2. **TESTS.md server suites at `must_pass: false`.** Justifiable now per the plan's "server lane re-engaged in Pass 3" framing, but worth noting that flipping these to `true` is the Pass 3 exit criterion and that should be visible in the Pass 3 entry checklist in `.project-state.md`. Otherwise the flip silently becomes a Pass 3 surprise.

3. **Cross-cutting threat-model comment style is a pattern worth codifying.** The comment block at `api.ts:8-26` is the same shape as `AuthProvider.tsx:8-18` and `Login.tsx:9-26`. Promote the convention into `SENIOR_ENGINEER_BAR.md` §2 as the canonical "threat-model header" pattern — every new component file gets one. This is exactly the standing-orders item ("Document every security measure so it compounds across projects.") working as designed; codifying the pattern keeps it from being lost when the engineer-who-wrote-it leaves the rotation.

4. **No CSP, no SRI on Google Fonts.** The `<link href="https://fonts.googleapis.com/css2?...">` in `index.html:14-17` has no `integrity=`/`crossorigin=` SRI. Google Fonts deliberately doesn't support SRI on the CSS2 endpoint (the CSS body varies with `User-Agent`), so the right defence is a CSP `style-src` allow-list pinning `https://fonts.googleapis.com`, plus `font-src https://fonts.gstatic.com`. CSP is Pass Final per Plan §Polish, but flagging here so it makes the Pass Final list.

5. **`SealStamp` includes `韓` as a top-level prop in `Login.tsx:92`.** Fine for Pass 1, but the design spec README line 99 lists `韓 / 復 / 完 / 譯` as a closed set. Worth making the type narrow now (`type SealChar = '韓' | '復' | '完' | '譯'`) so Pass 2 contributors can't accidentally drift the seal vocabulary.

---

**End of review.**
