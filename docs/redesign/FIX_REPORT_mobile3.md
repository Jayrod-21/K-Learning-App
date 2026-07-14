# FIX REPORT — Mobile Hardening, Round 3 (fix-pass on 2 SHOULD-FIX + 1 NIT)

**Repo:** `9b. Korean Master`, branch `feat/mobile-hardening`
**Source reviews:** `docs/redesign/REVIEW_mobile3-logic.md` (PASS, 2 SHOULD-FIX + 2 NITs),
`docs/redesign/REVIEW_mobile3-capstone.md` (MOBILE-SAFE TO DEPLOY, 0 blockers, 1 SHOULD-FIX + 2 NITs)

All items in scope closed. **No runtime behavior changed** — this round is
test additions + comments only, exactly as scoped.

---

## Dispositions

### 1. SF (logic review) — touch-path test coverage: zoom-disarm + listener cleanup

**Disposition: closed — both gaps covered with real native-touch dispatches.**

- **Touch zoom-disarm** (`client/src/pages/UploadViewer.test.tsx`, new test
  `'the touch swipe is not armed once zoomed past fit-width — a horizontal
  touch drag never turns the page'`): zooms in via the real "Zoom in" button,
  then drives `touchSwipeLeft(pageBox())` (real `touchstart`/`touchmove`/
  `touchend` dispatches, not Pointer Events) and asserts the page stays on
  `1 / 5`. This is the touch-path twin of the existing mouse-only
  `'the swipe gesture is not armed once zoomed past fit-width'` test, closing
  the exact gap the logic review named: the touch effect
  (`useEffect([swipeEligible, pageBoxEl])`) is a structurally separate attach
  path from the pointer-handler guard and could regress independently.

- **Listener cleanup / no-leak** (`client/src/pages/UploadViewer.test.tsx`,
  new test `'attaches the four touch listeners on mount and removes the exact
  same handlers on unmount (no leak)'`): spies on `addEventListener`/
  `removeEventListener`, mounts, asserts exactly one add per touch event type
  (`touchstart`/`touchmove`/`touchend`/`touchcancel`) on the real page-box
  element, unmounts, asserts exactly one matching remove per type, and
  asserts the **same function reference** is removed as was added per event
  type (catches the "different closure on remove" leak class the review
  called out, not just "removeEventListener was called"). Also fires a
  post-unmount `touchmove` and asserts it doesn't throw.

  **Notable implementation snag, resolved:** the naive
  `vi.spyOn(EventTarget.prototype, 'addEventListener')` from the review's
  suggestion silently spies on the wrong class — happy-dom's DOM node
  hierarchy does NOT inherit `addEventListener` from the global `EventTarget`
  visible to test code (confirmed directly: `el.addEventListener !==
  EventTarget.prototype.addEventListener`, even before any spying). Added a
  small helper, `domEventTargetProto()`, that walks a throwaway node's own
  prototype chain to find whichever level actually owns
  `addEventListener`/`removeEventListener` (happy-dom's real internal base
  class), and spies there instead. Documented inline as a happy-dom quirk so
  the next person doesn't rediscover it the hard way.

### 2. SF (design-limit doc note) — diagonal-onset swipe under `touch-action: pan-y`

**Disposition: closed — comment only, no code change.**

- `client/src/pages/UploadViewer.tsx`, inside the native `onTouchMove`
  handler, immediately before the axis-lock decision (`d.axis =
  swipeAxisFor(...)`): added a comment documenting the capstone review's named
  residual — while the axis is still `'none'` (first <8px sample) the
  handler never calls `preventDefault`, so a near-diagonal gesture onset can
  let the compositor commit to a native vertical pan under `touch-action:
  pan-y` before the axis locks `'h'` a few samples later, causing that one
  page-turn to no-op (self-corrects on the next swipe). Explicitly notes the
  only full fix (`touch-action: none` while eligible) would forfeit native
  vertical scroll of a tall scan and is therefore the wrong trade — this is a
  documented design limit, not a bug, matching both reviews' verdict.

### 3. NIT (logic review, in a file already being edited) — Space-key keyboard test

**Disposition: closed.**

- `client/src/pages/UploadViewer.test.tsx`, `'the bottom pager shows the live
  page-N-of-M readout and stays keyboard-operable'`: the test previously only
  drove `{Enter}`. Since this file was already open for the two SHOULD-FIX
  items above, added a Space-key assertion on the Previous button (focus →
  `[Space]` → asserts the page navigates back to `1 / 5`) so the test name's
  "keyboard-operable" claim is now fully literal, not partially so.

- The other three NITs (logic review N2 comment cross-reference on
  `Shell.tsx`/`index.css`, capstone N1/N2 on `Today.tsx`/`Today.css`/
  `seoul-devices.css`) were **not** in a file this round already touches —
  per the brief's scoping ("address ONLY if trivial + in a file you're
  already editing; otherwise skip"), left untouched.

---

## Gate results (from `client/`)

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` | **0 errors, 0 warnings** |
| Typecheck | `npx tsc -p tsconfig.app.json --noEmit --incremental false` | **0 errors** |
| `UploadViewer.test.tsx` (targeted) | `npx vitest run src/pages/UploadViewer.test.tsx` | **59 tests passed** (57 pre-existing + 2 new) |
| Full test suite | `npx vitest run` | **115 files passed, 1804 tests passed** (clean run; one parallel run hit the same pre-existing flaky `ReviewDictionary.test.tsx` debounce assertion documented in `FIX_REPORT_mobile2.md` — re-confirmed 18/18 in isolation, unrelated file, untouched this round) |
| Build | `npx vite build --outDir /tmp/km-fix-r3` | **exit 0** (831.54 kB main chunk, pre-existing >500kB warning, no new errors) |

---

## Files touched

- `client/src/pages/UploadViewer.tsx` — one code comment added (design-limit
  note on the touch axis-lock); no logic changed.
- `client/src/pages/UploadViewer.test.tsx` — 2 new tests (touch zoom-disarm,
  listener-cleanup/no-leak) + 1 new helper (`domEventTargetProto()`) + 1
  Space-key assertion added to an existing test. No existing test's
  assertions were altered.

**Confirmation: no runtime behavior changed anywhere in this round** — every
edit is either a test, a test helper, or a comment.
