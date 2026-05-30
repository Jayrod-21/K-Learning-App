# Review C: Navigation + Shell + Routing (Pass 1)

Independent senior review against `SENIOR_ENGINEER_BAR.md`, global `CLAUDE.md`,
and the design handoff (`Claude Design/design_handoff_korean_master/README.md`
+ `shared.jsx`). I did not write this code.

---

## Summary verdict

**Conditional pass with two SHOULD-FIX items.** The Pass 1 shell is clean
work. Routing covers all 11 screens with the correct paths, Korean headers,
and eyebrows. The nav manifest is well-typed and centralized, BottomNav has
real a11y semantics, MoreSheet is a competent modal dialog with scroll lock,
and ErrorBoundary is appropriately defensive. The two SHOULD-FIX items are
(1) focus restoration on MoreSheet close is documented as "Shell owns it" but
neither Shell nor MoreSheet actually implements it, and (2) the longest-prefix
active-tab matcher allows `/topiknotreal` to light "TOPIK" because there is no
path-boundary check. Neither blocks Pass 2, but the focus-restoration miss is
the one a screen-reader user would feel.

The other rough edges are NIT-level (one redundant `useCallback`, a tiny dead
state branch in `PublicOnly`, a `<button>` used as the backdrop where a
`role="presentation"` div with a click handler would be more honest), and there
is a chunk of genuine PRAISE that I want preserved through fixpass — see the
end.

---

## Bar checklist

| Bar item | Status | Notes |
|---|---|---|
| Type safety (`tsc --strict`, no `any`) | PASS | Discriminated `NavItemId` union, `ReadonlyArray<NavItem>`, typed `IconName`. |
| Single responsibility per module | PASS | Shell owns layout + sheet state, BottomNav owns active match, MoreSheet owns dialog behavior, nav.ts owns the manifest. |
| KISS / YAGNI | PASS | No premature abstraction; the `navItem()` lookup is a Map for O(1) without ceremony. |
| Errors handled at the right layer | PASS | ErrorBoundary at root, AuthProvider degrades to guest on network/5xx, `navItem()` throws on unknown id (correctly — that is an invariant violation). |
| a11y | MOSTLY | `aria-current`, `aria-haspopup`, `aria-expanded`, `aria-modal`, `aria-labelledby`, `aria-busy`, `role="alert"` all present; missing focus restoration on MoreSheet close. |
| No `TODO` without a ticket | NIT | One `TODO(B7)` in `ErrorBoundary.tsx:34` — that is the convention this project uses (Bx ticket prefix), so I treat this as acceptable, but flag it for explicit confirmation. |
| No `console.log` in committed code | PASS | The one `console.error` is gated behind `import.meta.env.DEV` — that is the right call. |
| No commented-out code | PASS | |
| No hardcoded secrets / URLs | PASS | |
| Documented intent | PASS | Every file has a substantive module docstring that explains why, not what. |

---

## Findings

### BLOCKER

*(none)*

### SHOULD-FIX

1. **MoreSheet focus restoration is documented but not implemented.** Comment
   on `MoreSheet.tsx:11–13` claims "Restores focus to the trigger on close
   (the parent owns that — we just call `onClose`)." Shell does not. The More
   button in BottomNav is not refed, and `closeMore` does not re-focus it. A
   keyboard or VoiceOver user who opens the sheet, Escapes out, loses focus
   to `<body>`.
2. **Active-tab matcher has no path boundary.** `BottomNav.tsx:87` uses
   `pathname.startsWith(it.path)` for non-root paths. `/topiknotreal` lights
   "TOPIK". No such routes exist today, but a future sub-route like
   `/topik-history` would silently light TOPIK while routing elsewhere.

### NIT

3. **`PublicOnly` renders `BootSkeleton` for `'authenticated'` while the
   effect schedules a redirect.** Correct but subtle. Worth a one-line
   comment so the next reader doesn't "simplify" it.
4. **Backdrop is a `<button>`.** A11y-tree-wise, it is announced as a
   button labelled "Close menu" — that is fine, but it also shows up as the
   first focusable in the sheet. The first-row focus effect overrides it on
   mount, but a Shift-Tab from the first row will land on the backdrop
   "button", not on the previous page focus. Either remove from the tab order
   (`tabIndex={-1}`) or document that this is intentional.
5. **`openMore` is a `useCallback` over a setter** — `useState`'s setter is
   already stable, so the `useCallback` round-trip adds nothing. `closeMore`
   same. Not wrong, just noise.
6. **`pass: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9`** in `ScreenStubProps` — fine for
   Pass 1 but will rot. A `number` constraint or a single `PassNumber` type
   alias would age better.
7. **`PRIMARY_TAB_IDS` / `MORE_TAB_IDS` are not exhaustively checked against
   `NavItemId`.** A future engineer can add a new id to the union, forget to
   place it in either array, and the manifest still type-checks. A
   compile-time exhaustiveness check is cheap (see Detailed §7).
8. **`reference` vs the prototype's `'ref'`** — intentional rename (the
   prototype uses `'ref'`), and `'reference'` is the better choice (the
   route is `/reference`, the icon is `search`, and "ref" is ambiguous).
   Worth a one-line comment in `nav.ts` noting the deliberate divergence so
   a future cross-check against `shared.jsx` does not flip it back.
9. **`ErrorBoundary` does not catch event handlers** — correct React
   behavior, but the module docstring would be stronger if it said so
   explicitly. The current text implies it catches "render-time" exceptions,
   which is right but easy to misread.

### PRAISE (do not undo in fixpass)

- **`navItem()` Map lookup with a thrown invariant.** `nav.ts:157–170` is
  textbook: O(1), typed, fails loud on a code mistake. Do not "simplify" to
  `NAV_ITEMS.find()` in every caller.
- **`matchActiveId` longest-prefix-with-special-case-for-`/`**
  (`BottomNav.tsx:83–95`). Right shape for the problem; the only thing
  missing is the path boundary check (see SHOULD-FIX #2).
- **`AuthProvider` `AbortController` for the StrictMode double-mount**
  (`AuthProvider.tsx:54–91`). Race-free, idempotent, and called out in the
  threat model. The `PublicOnly` `useEffect` then layers on top of this
  correctly — by the time it runs, `status` has already converged.
- **Provider order in `App.tsx:38–41`**: ErrorBoundary outside everything
  (so even ThemeProvider crashes are caught), ThemeProvider outside Router
  (so the theme survives a route change unrendered by Router), Router
  outside Auth (so AuthProvider can use `useLocation` for the `from`
  redirect). This is the right order and worth keeping.
- **MoreSheet body-scroll-lock with `previous` capture**
  (`MoreSheet.tsx:49–55`). Restores the prior value rather than blindly
  setting `''`. Subtle but correct.
- **CSS uses `100dvh`, `env(safe-area-inset-top)`, and
  `max(8px, env(safe-area-inset-bottom))`** (`index.css:293,306,328`). This
  is the iOS safe-area handling the design called for, done right.
- **`<StrictMode>` retained at the root.** Some teams strip it. Do not.

---

## Detailed findings (file:line, proposed fix)

### 1. MoreSheet focus restoration missing — SHOULD-FIX

- **Where**: `client/src/components/MoreSheet.tsx:11–13` (claim), Shell.tsx:23–28
  (omission), `client/src/components/BottomNav.tsx:61–74` (the trigger that
  should be refocused).
- **Why it matters**: WCAG 2.4.3 (Focus Order). When a dialog closes, focus
  must return to the element that opened it. Today, Escape or backdrop click
  drops focus on `<body>`; the next Tab restarts from the top of the page.
- **Fix shape** (Shell owns it, as the comment promises):

  ```tsx
  // Shell.tsx
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);

  const openMore = useCallback(() => {
    setMoreOpen(true);
  }, []);
  const closeMore = useCallback(() => {
    setMoreOpen(false);
    // restore focus to the trigger on next tick
    queueMicrotask(() => moreBtnRef.current?.focus());
  }, []);

  // pass moreBtnRef down to BottomNav and attach to the More <button>.
  ```

  Alternative: have BottomNav capture `document.activeElement` at the moment
  of `onOpenMore` and restore from there. Either is fine; the Shell approach
  matches what the MoreSheet comment promises.

### 2. Active-tab path boundary — SHOULD-FIX

- **Where**: `client/src/components/BottomNav.tsx:87`.
- **Current**: `pathname.startsWith(it.path)`.
- **Failure case**: a future `/topik-history` or `/reviewing-room` would
  light "TOPIK" / "Review" while routing elsewhere.
- **Fix**:

  ```ts
  const matches =
    it.path === '/'
      ? pathname === '/'
      : pathname === it.path || pathname.startsWith(`${it.path}/`);
  ```

  Cheap, correct, and makes the longest-prefix-wins logic actually win on a
  real boundary.

### 3. `PublicOnly` "authenticated" renders `BootSkeleton` — NIT

- **Where**: `App.tsx:198–213`.
- **Current behaviour**: when `status === 'authenticated'`, the component
  renders `<BootSkeleton/>` while the effect schedules a `navigate(target,
  { replace: true })`. This is right (avoids flashing the Login form) but
  reads as a bug at first glance.
- **Fix**: a one-line comment:

  ```tsx
  // Already-authenticated users get the skeleton instead of the login form
  // until the effect's navigate() lands. Prevents a one-frame flash.
  if (status === 'authenticated') return <BootSkeleton />;
  ```

### 4. Backdrop is a `<button>` — NIT

- **Where**: `MoreSheet.tsx:88–93`.
- **Why it is OK**: gives a real activation target for keyboard users and an
  `aria-label` to announce.
- **Why it could be better**: it joins the tab order. With the panel
  containing seven row buttons + theme toggle, the backdrop tabstop is
  redundant — Escape and "click anywhere outside" already cover the
  dismiss intent.
- **Fix**: add `tabIndex={-1}` to the backdrop button, or convert to a
  `<div role="presentation" onClick={onClose}>` and rely on Escape + the
  explicit theme/row dismiss paths for keyboard users. (Keep the
  `aria-label` only if you keep it focusable.)

### 5. `useCallback` over `setMoreOpen` — NIT

- **Where**: `Shell.tsx:23–28`.
- **Issue**: `useState` setters are stable. Wrapping `() => setMoreOpen(true)`
  in `useCallback` is purely decorative here because `BottomNav` /
  `MoreSheet` are not memoized.
- **Fix**: inline the lambdas, or memoize the consumers. Not load-bearing.

### 6. `ScreenStubProps.pass` is a 2..9 literal union — NIT

- **Where**: `pages/ScreenStub.tsx:16`.
- **Issue**: a `pass: 10` will fail to type-check, and most consumers
  will not care.
- **Fix**: replace with `pass: number` and validate at the boundary (or
  type-alias `type PassNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;` and
  re-export it so it is shared).

### 7. No exhaustiveness check between `NavItemId` and the two ID arrays — NIT

- **Where**: `lib/nav.ts:140–155`.
- **Issue**: a new union member can be silently absent from both arrays.
- **Fix**:

  ```ts
  // Compile-time guarantee: every NavItemId is in exactly one of the two
  // arrays. Type the assertion using `satisfies` so a missing id fails CI.
  type _ExhaustiveCheck =
    (typeof PRIMARY_TAB_IDS)[number] | (typeof MORE_TAB_IDS)[number];
  const _check: NavItemId = '' as unknown as _ExhaustiveCheck;
  ```

  Or, cleaner: derive `MORE_TAB_IDS` from `NAV_ITEMS.filter(it =>
  !PRIMARY_TAB_IDS.includes(it.id))` and freeze it. That eliminates the
  duplication entirely.

### 8. `'reference'` vs prototype `'ref'` — NIT

- **Where**: `lib/nav.ts:25–36, 121, 153`.
- **Issue**: the design handoff prototype uses `id: 'ref'`. The
  implementation uses `'reference'`. The implementation choice is better
  (path is `/reference`, less ambiguity), but a future cross-reference may
  re-introduce `'ref'` without realising.
- **Fix**: one-line comment in `nav.ts` calling out the deliberate divergence.

### 9. ErrorBoundary docstring — NIT

- **Where**: `ErrorBoundary.tsx:1–11`.
- **Issue**: implies render-time only; React's documented limitation
  (does NOT catch event handlers, async code, SSR, or errors thrown inside
  the boundary itself) is not stated.
- **Fix**: append:

  ```
  Does NOT catch: event handler errors, async/Promise rejections, SSR
  errors, or errors thrown by this component's own render. Wrap risky
  event handlers in try/catch at the call site.
  ```

---

## Coordination observations

These are not flaws in this slice; they are things adjacent work needs to
honor or pick up later.

- **Pass 2 needs to honor focus restoration as a contract.** Once Pass 2
  introduces `WordPopover` and `ListDetailSheet` (also dialogs), the same
  focus-restoration pattern must apply. Best done as a single
  `useDialog({ open, onClose })` hook that handles Esc + scroll-lock +
  focus restore. Worth pulling out before three dialogs grow three slightly
  different implementations.
- **`Topbar` is not present in Pass 1.** ScreenStub draws its own eyebrow
  + title inline. Pass 2 needs the `Topbar` component (per `shared.jsx`)
  and the per-screen header data still wants to come from `nav.ts`
  (`eyebrow`, `headerTitle`). Good news: those fields already exist on
  `NavItem`. Bad news: ScreenStub renders them directly from the manifest;
  Pass 2 screens will likely want to override (e.g., Reading's eyebrow
  becomes the passage's level/duration). Plan for a `<Topbar
  eyebrow={…} title={…}/>` consumer pattern, not a manifest-driven one.
- **`AuthProvider` and the rest of the app cross a context layer.** The
  current Provider stack puts AuthProvider inside BrowserRouter, which is
  necessary for `useLocation()` in `PublicOnly`. Anything Pass 2 builds
  that needs auth at a non-routed level (e.g., a service worker registration
  in `main.tsx`) will have to either route-mount or read the cookie
  directly. Fine for now; flag for future.
- **`PublicOnly`'s `from` field comes from `location.state`.** If a user
  pastes a deep link into a fresh tab while logged out, `state.from` is
  `null` and they land on `/` after login — correct. If `RequireAuth`
  redirects with `{ from: location.pathname }`, that survives the round
  trip — correct. Worth a single e2e test in CI (Pass 3+) to lock this in.
- **Tests for this slice are absent.** Per the bar, "every public function
  has at least one test." Pass 2 should add Vitest + React Testing Library
  coverage for at least: `matchActiveId` (root, exact, prefix, no-match,
  future-boundary case), `navItem` (known + throws on unknown), and a
  smoke test that the More sheet renders all seven items and that clicking
  one navigates + closes. ErrorBoundary's fallback is testable with a
  forced-throw child.

---

## Verdict

Two SHOULD-FIXes (focus restoration; path boundary in `matchActiveId`) are
the must-close items before declaring Pass 1 done. The NITs are cleanup, not
rework. The PRAISE items are load-bearing — fixpass should not regress them.
