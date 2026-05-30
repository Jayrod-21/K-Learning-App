# Korean Master — Client (React + Vite SPA)

The hanji-paper Korean study app's front-end. Talks to the Express server in
`../server/` via cookie-session auth (ADR-002), renders the 11-screen mobile
shell, and bakes the canonical design tokens. Pass 1 ships the skeleton —
every screen is a `ScreenStub` placeholder; Pass 2 fills the bodies.

For project-wide context see `../../PROJECT.md` and
`../../CLAUDE_DESIGN_INTEGRATION_PLAN.md`.

---

## Status

**Pass 1: skeleton.** The wiring is real (auth, routing, theme, IA) but the
screen bodies are stubs that say "Pass N: feature coming". Pass 2 begins
replacing them.

What's wired and working:

- Cookie-session auth (`/auth/me`, `/auth/login`, `/auth/register`,
  `/auth/logout`) with a single-source-of-truth `AuthProvider`.
- 11-screen IA: 4 primary tabs (Today, TOPIK, Read, Review) + 7 in the
  More sheet (Hanja, Images, Diagnostic, Grammar, Chat, Reference,
  Settings) via `BottomNav` + `MoreSheet`.
- Hanji + Sumi design tokens (light + dark), nine bone components
  (`Card`, `Button`, `Pill`, `Eyebrow`, `SealStamp`, `DoubleRule`, `Icon`,
  `Shell`, `BottomNav`), all matching the canonical design handoff
  one-for-one.
- Theme persistence (`localStorage["km.theme"]`) with an OS-pref fallback
  and a no-flash bootstrap in `index.html`.
- Accessibility primitives (focus restoration, `aria-busy`, `aria-current`,
  `role="dialog"`/`aria-modal`, focus rings, double-submit guard).

What's deliberately *not* here in Pass 1: screen body wiring, streaming,
the install banner, MFA, email verification, CSP. Each is tracked in
[`SECURITY.md`](./SECURITY.md) §15 with a ticket id.

---

## Quick start

```bash
cp .env.example .env
# Edit .env if your server isn't on http://localhost:4000

npm install
npm run dev        # Vite on http://localhost:5173
```

The Express server in `../server/` must be running for auth to work.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (HMR). Reads `.env`. |
| `npm run build` | `tsc -b && vite build`. **This is the type-check.** |
| `npm run lint` | ESLint over the whole tree. |
| `npm run preview` | Serve the production build locally (`dist/`). |

[`TESTS.md`](./TESTS.md) (next to this README) declares `client-build`,
`client-lint`, and `client-unit` as the must-pass suites for this lane.
Run all three before shipping. The project-root `TESTS.md` is now a thin
pointer to this file.

---

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `VITE_API_URL` | `''` (empty = same-origin) | Dev: `http://localhost:4000`. **Prod: empty.** Same-origin reverse proxy is the deploy contract — see SECURITY.md §2. |

**Never put a secret in a `VITE_…` variable.** Anything prefixed `VITE_` is
**bundled into the public JS** and visible to every browser. The Express
server is the only place secrets live.

Local dev pairing:

```
client (vite)  http://localhost:5173
server (node)  http://localhost:4000
```

Both are `localhost` → same-site for cookie purposes (eTLD+1), so
`SameSite=Strict` works. The dev tripwire in `services/api.ts` warns if
`VITE_API_URL` points at a non-loopback host over HTTP.

---

## Architecture (Pass 1)

```
src/
├── main.tsx                  # React 19 root mount
├── App.tsx                   # ErrorBoundary > ThemeProvider > Router > AuthProvider > Routes
├── pages/
│   ├── Login.tsx             # Sign-in / register (hanji-styled)
│   └── ScreenStub.tsx        # Pass 1 placeholder for the 11 in-app screens
├── components/
│   ├── Shell.tsx             # Layout chrome: statusbar + scroll + BottomNav + MoreSheet
│   ├── BottomNav.tsx         # 4 primary tabs + More opener
│   ├── MoreSheet.tsx         # Bottom-attached modal with the 7 More tabs + theme toggle
│   ├── ErrorBoundary.tsx     # Root-level render-time error catch
│   ├── Icon.tsx              # ~39-name line-stroke SVG registry
│   ├── Card.tsx, Button.tsx, Pill.tsx,
│   ├── Eyebrow.tsx, SealStamp.tsx, DoubleRule.tsx   # bone components
├── hooks/
│   ├── AuthProvider.tsx      # Cookie-session state + login/register/logout
│   ├── auth-context.ts       # AuthContext + types (separate file for React Refresh)
│   ├── useAuth.ts            # Hook with throw-if-unprovided guard
│   ├── ThemeProvider.tsx     # `data-theme` on <html>, localStorage persist
│   ├── theme-context.ts, useTheme.ts
├── services/
│   └── api.ts                # axios instance + ApiError taxonomy + cross-origin tripwire
├── lib/
│   ├── nav.ts                # Single source of truth: 11 NavItems, PRIMARY_TAB_IDS, MORE_TAB_IDS, PassNumber
│   └── cn.ts                 # className join helper
└── styles/
    └── index.css             # Hanji + Sumi tokens + 9-bone styles + reset
```

Sources of truth:

- **Design tokens** — `src/styles/index.css` (hanji light + Sumi dark) is
  one-for-one with `Claude Design/design_handoff_korean_master/styles.css`.
  Don't add hard-coded colors; introduce a token if you need one.
- **Navigation IA** — `src/lib/nav.ts`. Adding a screen means adding to
  `NAV_ITEMS`, the discriminated `NavItemId` union, and one of
  `PRIMARY_TAB_IDS` / `MORE_TAB_IDS`. A compile-time exhaustiveness check
  fails the build if a `NavItemId` is missing from both arrays.
- **Auth shape** — `src/hooks/auth-context.ts` (types) +
  `AuthProvider.tsx` (state). The `{ login, register, logout, status,
  user, loading }` value comes from `useAuth()`.
- **Security contract** — [`SECURITY.md`](./SECURITY.md). Read it before
  touching anything in `services/api.ts`, `hooks/AuthProvider.tsx`, or
  `pages/Login.tsx`.

---

## Gotchas

- **No Vite proxy.** The server mounts `/auth`, `/vocab`, etc. directly
  (no `/api/*` prefix), so a dev-time proxy would only obscure URL shape.
  Set `VITE_API_URL=http://localhost:4000` instead. The server's
  `CLIENT_ORIGIN` must include `http://localhost:5173` for CORS to allow
  the credentialed XHR.
- **`SameSite=Strict` is fine in dev because `localhost:5173` and
  `localhost:4000` are same-site** (cookie *site* is eTLD+1). Don't ship
  a real cross-origin `VITE_API_URL` to prod — the cookie will silently
  drop. SECURITY.md §2.
- **Theme is set pre-React** by an inline IIFE in `index.html`. If you
  change the storage key (`km.theme`) or the dataset attribute name,
  update both the IIFE and `ThemeProvider.tsx`.
- **`useAuth()` throws if used outside the Provider** by design. If you
  see "useAuth must be used inside AuthProvider", check your component is
  rendered inside `<AuthProvider>` (it's mounted at the App root, so this
  usually means a stray render in a test).
- **`apiRequest`'s `timeout: 10_000` is request-level, not idle**. Routes
  that wrap Claude (`/enrich`, `/conversation/*/messages`) MUST pass
  their own larger `timeout`. Tracked as `FU-NF-14`.

---

## Adding a screen

1. Add the entry to `NAV_ITEMS` in `src/lib/nav.ts` (label, kr, eyebrow,
   icon, headerTitle, path).
2. Extend the `NavItemId` union with the new id.
3. Add the id to `PRIMARY_TAB_IDS` OR `MORE_TAB_IDS` (the compile-time
   exhaustiveness check fails the build otherwise).
4. Add a `<Route>` in `App.tsx`. During Pass 1 most routes wrap a
   `<ScreenStub id="…" pass={…} comingCopy="…"/>` placeholder.

---

## Pointers

- Project context — `../../PROJECT.md`
- Integration plan — `../../CLAUDE_DESIGN_INTEGRATION_PLAN.md`
- Design handoff — `../../Claude Design/design_handoff_korean_master/`
- ADR-002 (cookie sessions) — `../db/docs/ADR-002-auth-and-sessions.md`
- Senior engineer bar — `../../SENIOR_ENGINEER_BAR.md`
- Security — [`SECURITY.md`](./SECURITY.md)
- Tests / suites — [`TESTS.md`](./TESTS.md) (project root has a pointer)
- Follow-ups — `../../FOLLOW_UPS.md`
