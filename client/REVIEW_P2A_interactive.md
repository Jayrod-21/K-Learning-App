# Review P2A: Interactive composites

> Independent senior reviewer pass. Surface: `Tapword`, `KoreanPassage`,
> `WordPopover`, `AudioBlock`, `Flashcard`, `Sheet`, `Topbar`, `Toggle` +
> tests + the `.km-*` CSS for each. Reviewer did not author this code.
> Date: 2026-05-29.

## Summary verdict

**PASS WITH CONDITIONS.** The set is well-architected: minimal prop
contracts, controlled-vs-uncontrolled split is consistent (Flashcard is
controlled by design, Tapword is presentational, AudioBlock owns its
fake-progress state, WordPopover owns Added/drawer), `role="dialog"` +
`aria-modal` + body-scroll-lock + Esc are in place on both modals,
and the test suites assert behaviour (keyboard parity, aria-checked
flips, Esc closes, scroll lock restore) — not just rendering. The
gram-span walk in `KoreanPassage` is a genuine improvement over the
prototype (id-prefix derived dynamically rather than hard-coded
`'g4'`).

There are, however, **3 BLOCKERs** that must close before this
component set is wired into Pass-3 screens, plus several SHOULD-FIX
items grouped around (1) focus management on close (no restore on
either modal), (2) Tapword swallowing Space-scroll without claiming
the role contract that `role="button"` requires (no `aria-pressed` is
fine, but the Space `preventDefault` mismatches the no-`onKeyUp`
shape), and (3) the WordPopover focus trap query missing several
focusable element types, which silently breaks once a learner adds an
input/select/textarea to the drawer.

The Pass-1 PRAISE list (auth threat-models, three-file provider
split, BottomNav location-derived active state) is not touched by
this work — no silent regressions detected.

## Bar checklist

| Bar item | Status |
|---|---|
| Keyboard a11y on every interactive | PARTIAL — see B-1, B-2, SF-1 |
| Esc closes Sheet + WordPopover | YES |
| Backdrop closes Sheet + WordPopover | YES |
| Body scroll lock + restore | YES (both modals; tested for Sheet) |
| Focus trap on Sheet + WordPopover | PARTIAL — only WordPopover; Sheet has none. See B-3 |
| Focus *restore* on close | NO — neither modal restores. See B-2 |
| Spacebar reveal on Flashcard | YES (parent owns binding; component exposes correct `onFlip` shape) |
| Reduced-motion honoured | YES via global media query; flashcard flip + sheet-up + popover rise + audio bar transitions all hit the `transition-duration: 0.001ms` blanket. **Note** that the global blanket also zeroes the fake-audio progress `transition: width 100ms linear` — visually fine but worth a comment |
| TS strict, no `any`, `import type`, no enums | YES across all 8 components |
| Props minimal + correct | YES; one shape concern in Tapword (`active` is set but no caller passes it in Pass 2 — YAGNI) |
| Tests assert contract not just render | YES for Tapword, Toggle, Sheet, Flashcard, WordPopover. **KoreanPassage and AudioBlock have NO `.test.tsx`** — see B-1 |
| XSS via `tk.w` strings safe | YES — `KoreanPassage` renders via React children, no `dangerouslySetInnerHTML` anywhere in P2A surface |
| KoreanPassage matches prototype's gram-span/tapword walk | YES with an improvement (dynamic gid extraction) |

---

## Findings

### BLOCKER

**B-1.** `KoreanPassage.tsx` and `AudioBlock.tsx` have **no `.test.tsx`
siblings.** Every other component in this review (Tapword, WordPopover,
Sheet, Toggle, Flashcard) has a test file that asserts the behavioural
contract; these two — the most complex in the set — have none.
KoreanPassage is the central reading gesture (token walk + span
batching + EN reveal toggle); AudioBlock owns a setInterval that must
clean up on unmount and on every play→pause. Untested =
untested-tomorrow-too. Bar §2 *Testing*: "every public function has at
least one test." **Files**: `src/components/KoreanPassage.tsx`,
`src/components/AudioBlock.tsx`. **Fix**: add `KoreanPassage.test.tsx`
asserting (a) plain tokens render as `<span>`, (b) gloss tokens render
as Tapword and call `onOpenWord` with the gloss, (c) a g4-start /
g4-end run renders as a single `.gram-span` calling `onOpenGrammar`
with `'g4'`, (d) EN toggle reveals + hides the sentence, (e) malformed
fixture with unterminated span still renders the tail. Add
`AudioBlock.test.tsx` asserting (a) play button toggles `aria-pressed`,
(b) interval clears on unmount (use `vi.useFakeTimers`), (c) clicking a
speed pill flips `aria-pressed` on the row, (d) transcript toggle shows
the KR/EN text.

**B-2.** **No focus restoration on close for `Sheet` or `WordPopover`.**
When a learner taps a Tapword to open the popover, keyboard focus
should return to the Tapword on dismiss. Today, focus lands on `<body>`
after either modal closes, which is a screen-reader / keyboard-user
regression — the user loses their place in the passage and Tab starts
from the document root. The same flaw was already filed against
MoreSheet in Pass 1 (`C-1`, top SHOULD-FIX). Promoting it here because
it now hits the *learning gesture itself* — every word-tap, every list
sheet — not just the navigation chrome. **Files**:
`src/components/Sheet.tsx:38-95`, `src/components/WordPopover.tsx:86-114`.
**Fix**: capture `document.activeElement as HTMLElement | null` in a
ref at mount; restore via `previous?.focus({ preventScroll: true })` in
the unmount cleanup. Pattern is small, copyable across both files, and
should also be retrofitted into MoreSheet to close C-1.

**B-3.** **`Sheet` has no focus trap and no initial focus.** When the
sheet opens, focus stays wherever the trigger left it — typically a
button outside the panel. Keyboard users can then Tab straight out of
the dialog and back into the (scroll-locked but otherwise live) page
content behind. `WordPopover` does have a trap (line 129-145) and
moves focus to the close button on mount; `Sheet`, used by
`ListDetailSheet` / `CreateListSheet` / `HanjaDetailSheet` per Pass 2
plan, has neither. `role="dialog"` + `aria-modal="true"` without a
trap is a false promise — AT users hear "modal" and then escape it via
Tab. **File**: `src/components/Sheet.tsx:74-95`. **Fix**: (a) on mount,
move focus to the panel (give the panel `tabIndex={-1}` and
`.focus()`), or to the first focusable inside it if any. (b) Wrap the
panel's `onKeyDown` with the same Tab-cycle trap WordPopover uses, OR
extract that trap into a `useFocusTrap(ref)` hook and call from both.
The extraction is the right call because the duplication is now real
(rule-of-three from MoreSheet's also-missing trap), but a copy-paste
to unblock Pass 2 is acceptable if a follow-up ticket files the hook.

### SHOULD-FIX

**SF-1.** `Tapword` Space handler swallows the key without owning a
real button. The component does `e.preventDefault()` on Space (correct
to stop page scroll), but it's a `<span role="button">`, which means
screen readers announce it as a button while assistive tech tooling
that uses `keyup` semantics (NVDA forms mode, some Switch Control
shortcuts) won't fire `onTap`. The `<span>`-over-`<button>` rationale
in the file header (avoid block/inline-block issues mid-`<p>`) is
defensible but the contract then needs to honour both `keydown` and
`keyup` to fully replicate native button activation, OR the comment
should say "we accept the keyup gap." **File**:
`src/components/Tapword.tsx:53-58`. **Fix**: either add `onKeyUp`
treating Space identically, or add a one-line note in the header
acknowledging the gap with a rationale ("desktop NVDA users can use
Enter; mobile VoiceOver double-tap fires click, which is covered").

**SF-2.** `WordPopover` focus-trap selector is incomplete. Line 131-133:
```ts
'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
```
Pass-2 today: fine, the popover only contains buttons. Pass-3+: the
moment anyone adds an `<input>` (e.g., a "note this word" field per
the design's drawer extension), a `<textarea>`, a `<select>`, an
`<audio controls>`, or a contenteditable, that element becomes
focusable and the trap breaks (Tab from "last" button cycles back to
close, skipping the new input; Tab from the input escapes the
dialog). **File**: `src/components/WordPopover.tsx:131-133`. **Fix**:
expand the selector to the canonical focusable list:
`'a[href], area[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'`.
Also filter out non-visible elements (`:not([aria-hidden="true"])`).
Pair this with the `useFocusTrap` extraction in B-3 so we don't fix
it in two places later.

**SF-3.** `WordPopover` keydown Esc handler stops propagation
(`e.stopPropagation()` at line 101) even though the popover is
typically nested inside a screen that may also want to handle Esc
(close a parent Sheet, for instance). For Pass 2 this is fine — the
popover is the top-most overlay. But the same fix-pass-able assumption
is baked into `Sheet.tsx:49-52`. If the user opens
`HanjaDetailSheet` → tap a tapword inside → popover opens → press Esc:
today, both close (popover's listener wins by registration order, but
because Esc bubbles to window-level on both, *both* fire). Verify with
a test that nested-overlay Esc closes only the top one. **Files**:
`src/components/WordPopover.tsx:99-104`,
`src/components/Sheet.tsx:48-53`. **Fix**: scope the Esc listener to
`capture: false` (default) AND remove `stopPropagation()` (it's
useless on window-level — there's nothing above window). Instead,
wire a small "modal stack" idiom: when the popover mounts, push onto
a stack; only the top of the stack handles Esc. Simpler alternative:
pass an `onlyTopHandler` flag in via context.

**SF-4.** `Sheet.tsx:48-52` body-scroll-lock implementation is correct
but the test at `Sheet.test.tsx:63-73` asserts restoration from
`'auto'` → `'hidden'` → `'auto'`. The implementation stores the
*inline* style value (`document.body.style.overflow`), not the
*computed* value. If a global stylesheet ever sets `body { overflow:
auto }` via class rather than inline style, the capture reads `''` and
restoration leaves `body.style.overflow = ''`, which then defaults to
the computed `'auto'` — coincidentally correct but for the wrong
reason. Bar §3 *Inline comments explain WHY*: add a one-liner saying
"inline-style capture only; if a parent sets overflow via CSS class,
the empty-string restore relies on the cascade". **File**:
`src/components/Sheet.tsx:64-69`. **Fix**: add the comment; consider
also restoring on `useEffect` cleanup using a fallback to `''`.

**SF-5.** `KoreanPassage` `Sentence` component's `flushSpan` is only
called once for unterminated runs at the end (line 190) but never
called if a token has `span` ending in `-start` while a previous run
was still open (no `-end` token between them). E.g., the fixture has
`[..., {span:'g4-start'}, {span:'g5-start'}, ...]` — `spanGid` flips
from `'g4'` to `'g5'`, the `g4` run is silently merged into the `g5`
output. This is a fixture-author error, not user-supplied, so it's
not a security issue, but the silent merge is a *substance* bug
because the tail flush comment at line 188-189 ("Defensive: flush any
unterminated span so a malformed fixture still renders all of its
tokens") implies defensive behaviour the code doesn't fully provide.
**File**: `src/components/KoreanPassage.tsx:171-186`. **Fix**: when
processing a `-start` token, if `spanGid !== null` already, flush the
old run first. One extra line:
```ts
if (tk.span && tk.span.endsWith('-start')) {
  if (spanGid !== null) flushSpan();
  spanGid = tk.span.slice(0, -'-start'.length);
  spanRun.push(piece);
  return;
}
```

**SF-6.** `AudioBlock` interval cleanup is correct but the *render
itself* depends on `playing`, `durationS`, and `speed` — flipping the
speed pill mid-playback unmounts and remounts the interval, which
resets the 100ms cadence (drops up to one tick of progress on every
speed change). Tiny UX bug; production-honest would carry the
elapsed time forward. **File**: `src/components/AudioBlock.tsx:57-83`.
**Fix**: drive progress from a `useRef<number>(0)` for elapsed-time
that survives effect-restarts; the interval reads/writes the ref and
syncs to React state. Or accept the trade-off and add a comment.

**SF-7.** `WordPopover.tsx:171` `onKeyDown` is attached to the dialog
`div`, but the Esc listener at line 98-109 is on `window`. The Tab
trap captures Tab properly only when focus is *inside* the dialog
(`document.activeElement` check). If, between unmount and mount of
the popover, focus is somewhere on the backdrop or body, the Tab
fires `last.focus()` via `out-of-tree activeElement` which may
ignore the test. Symptom: a Tab pressed in the first 16ms after
mount (before `closeRef.focus()` resolves in the effect) hits the
`active === last` branch when neither first nor last is the active
element, doing nothing — minor but observable. **Fix**: guard
`trapTab` with `if (!dialogRef.current?.contains(active)) return;`
before doing anything.

**SF-8.** `Toggle.tsx` correctly spreads `...rest` onto the button.
However, `aria-label` is also part of the rest props (since
`ButtonHTMLAttributes` includes it) but we extract `ariaLabel`
explicitly. A caller who does
`<Toggle ariaLabel="X" aria-label="Y" />` will get `aria-label="X"`
because explicit props are applied after `...rest` in the JSX (line
46). Today not a bug; tomorrow a confusing one. **File**:
`src/components/Toggle.tsx:30-58`. **Fix**: either rename the prop to
`label` (less confusing collision with the HTML attribute) or document
the precedence in the docstring. Also: there is no test asserting the
`disabled` prop reaches the DOM as the `disabled` attribute — the
"does not fire when disabled" test relies on userEvent's behaviour,
which is fine, but an explicit `expect(el).toBeDisabled()` would lock
the contract.

### NIT

**N-1.** `Tapword.tsx:42` the `active` prop is declared but **no
caller in Pass 2 currently passes it.** YAGNI — defer until
WordPopover wires its anchor back to the originating tapword. Either
remove the prop or grep-verify a caller exists.

**N-2.** `KoreanPassage` revealed-state seed (lines 63-68) builds the
"all sentences revealed" set inside the lazy initializer — correct,
but the `for...let...i+=1` style fights the rest of the codebase
which uses `forEach`/`map`. Tiny consistency nit; not load-bearing.

**N-3.** `WordPopover.tsx:204-207` the example KR/EN block isn't
guarded for empty strings. If `ex_kr === ''` and `ex_en === ''`, the
rule (`<hr className="hr-gold km-popover__rule" />`) still renders
above an empty block, leaving a floating divider. Mocks always
populate these; Pass 3 may not.

**N-4.** `Sheet.tsx:25` imports `type ReactNode` from `'react'` —
correct usage of `verbatimModuleSyntax`. `Flashcard.tsx:28-32` does
the same. WordPopover does the same. Consistency is good; flag is
PRAISE-adjacent.

**N-5.** `AudioBlock.tsx:29` `SPEEDS: readonly Speed[]` is fine but
`Speed` is a union literal (`0.75 | 1 | 1.25`) which is exactly the
member set of the array. Could use `as const` on the array and
derive: `type Speed = typeof SPEEDS[number]`. Tiny tightening.

**N-6.** `Topbar.tsx` — the only component in this batch with neither
state nor a11y concern. It's a presentational header; no test, but
also nothing testable beyond renders-children. Acceptable.

**N-7.** `Flashcard.tsx:55-60` handles Enter + Space but the focus
ring is on the outer `<div role="button">`. Chrome bug: outer `<div
role="button">` doesn't trigger form submission inside an enclosing
`<form>` (good) but also doesn't receive the same default styles as a
`<button>` on iOS Safari — verify the cursor + `:focus-visible`
behavior is consistent.

**N-8.** `WordPopover.tsx` docstring claims "Tab order: close → add →
info-toggle. Shift-Tab from close wraps to info" (lines 23-24) but
the actual focus trap (lines 129-145) only wraps at first↔last; it
doesn't enforce the documented order. The order is what the DOM
order produces (head, close, lede, rule, eyebrow, ex_kr, ex_en, add,
info, drawer). Close is the FIRST focusable (not last), so the
documented "Shift-Tab from close" path is correct. The comment is
fine; this nit is a careful-read result.

### PRAISE

**P-1.** Dynamic gram-span gid extraction in `KoreanPassage.tsx:172`
(`tk.span.slice(0, -'-start'.length)`) is a real improvement over the
prototype's hard-coded `'g4'` (`shared.jsx:316` of the design). Pass
3 fixtures that mix multiple grammar patterns in one passage will
work without code change. Substantial refactor for the better.

**P-2.** `Sheet`'s decision NOT to generalize from MoreSheet
(`Sheet.tsx:7-13`) is the right call and the comment captures the
trade-off honestly. Two simple components beat one parameterized
component with a navigation escape hatch.

**P-3.** `Sheet.test.tsx:63-73` asserts the **previous** body
overflow value is restored, not just that it's reset to `''`. That's
the careful test that catches the next refactor's regression. Same
shape for the open=false → renders nothing test (line 18-25).

**P-4.** `Flashcard.tsx:8-16` rationale for keeping it controlled
(parent owns `flipped` to bind Spacebar at the Review screen level)
is the correct contract for Pass 2 → Pass 3 wiring. Avoids an
uncontrolled→controlled mode-switch when SRS rating wires up.

**P-5.** `AudioBlock.tsx:77-82` interval cleanup runs both on every
play→pause and on unmount. Belt-and-suspenders: the explicit
`intervalRef.current = null` after `clearInterval` prevents a stale
ref ever leaking back into a subsequent effect.

**P-6.** `Toggle.tsx`'s use of `role="switch"` + `aria-checked`
(line 44-45) rather than the more common `aria-pressed` + button is
the WAI-ARIA-correct choice for the "on/off persistent state"
semantic. NVDA and VoiceOver announce "switch, on" — matches the
visual affordance.

**P-7.** `WordPopover.tsx:213` `aria-pressed={added}` on the Add
button: nice — the button is a toggle (add → added), and `aria-pressed`
is the right ARIA verb.

**P-8.** Every test file in this batch uses `userEvent.setup()`
correctly (per Testing Library 14+ guidance) — not the deprecated
direct `userEvent.click()` call. Consistent across all 5 test files.

**P-9.** `KoreanPassage.tsx:189-190` defensive `flushSpan()` after
the token loop catches unterminated-span fixture bugs. The comment
explains WHY, not just WHAT — bar §3 compliant.

---

## Detailed findings (file:line → propose fix)

| ID | File:line | Issue | Proposed fix |
|---|---|---|---|
| B-1 | `KoreanPassage.tsx` (no test), `AudioBlock.tsx` (no test) | Most complex components in batch are untested | Add `KoreanPassage.test.tsx` + `AudioBlock.test.tsx` per B-1 above |
| B-2 | `Sheet.tsx:38-95`, `WordPopover.tsx:86-114` | No focus restoration on close | Capture activeElement on mount, restore on unmount cleanup |
| B-3 | `Sheet.tsx:74-95` | No focus trap, no initial focus | Extract `useFocusTrap(ref)` from WordPopover, call from Sheet + MoreSheet; move focus to panel on mount |
| SF-1 | `Tapword.tsx:53-58` | Space `preventDefault` without `onKeyUp` parity | Add `onKeyUp` for Space OR document the gap |
| SF-2 | `WordPopover.tsx:131-133` | Focus-trap selector misses inputs/select/textarea | Use canonical focusable selector |
| SF-3 | `WordPopover.tsx:99-104`, `Sheet.tsx:48-53` | Esc fires on all stacked overlays | Modal-stack pattern or capture-only-on-top |
| SF-4 | `Sheet.tsx:64-69` | Inline-style scroll-lock capture only | Add comment explaining cascade fallback |
| SF-5 | `KoreanPassage.tsx:171-186` | Unterminated span swallowed when new -start arrives | Flush before opening new run |
| SF-6 | `AudioBlock.tsx:57-83` | Speed change drops a tick | Move elapsed-time to ref or document |
| SF-7 | `WordPopover.tsx:129-145` | Tab trap acts on activeElement outside dialog | Guard with `contains` check |
| SF-8 | `Toggle.tsx:30-58` | `ariaLabel` vs `aria-label` precedence undocumented | Rename to `label` or document |
| N-1 | `Tapword.tsx:42` | Unused `active` prop in Pass 2 | Remove or wire up |
| N-2 | `KoreanPassage.tsx:63-68` | Style inconsistency | Use `.map` |
| N-3 | `WordPopover.tsx:204-207` | Empty example renders rule above void | Conditional render |
| N-5 | `AudioBlock.tsx:27-29` | Redundant Speed type | Derive from array |
| N-7 | `Flashcard.tsx` | iOS Safari cursor for `div role=button` | Verify visually |

---

## Coordination observations

1. **Focus-trap duplication is now real.** `WordPopover` has one
   (inline, lines 129-145). `Sheet` lacks one (B-3). `MoreSheet` lacks
   one (C-1, still open). Rule-of-three is met. Extract
   `useFocusTrap(ref)` into `src/hooks/` during the B-3 fix so all
   three converge. Otherwise Pass 3 will copy the same
   incomplete-selector bug from WordPopover into every new sheet.

2. **Focus restoration is missing across every modal (Sheet,
   WordPopover, MoreSheet).** This is the single highest-impact
   behavioural fix in P2A — it's the difference between "the modal
   works for sighted mouse users" and "the modal works for everyone."
   Pair with focus-trap extraction in the same patch; both want
   `useModalA11y(ref, { onClose })` shape.

3. **Body-scroll-lock pattern is duplicated 3× now** (Sheet,
   WordPopover, MoreSheet) with identical implementations. Same
   rule-of-three trigger; same `useModalA11y` would absorb it.

4. **The Pass 1 PRAISE list is intact.** Spot-checks against
   `FIXPASS_AGGREGATE.md`:
   - `services/api.ts` threat-model comments — untouched (out of scope here).
   - Provider/context/hook three-file split — untouched.
   - `BottomNav.matchActiveId` longest-prefix shape — `MoreSheet.tsx:116`
     uses `location.pathname === it.path` which is fine for the More
     items (none nested), but worth re-checking once `/topik/results`
     and `/diagnostic/results` ship.
   - `verbatimModuleSyntax` + `import type` — every component in this
     batch obeys (e.g., `Sheet.tsx:25`, `Flashcard.tsx:28-32`,
     `WordPopover.tsx:38-44`).

5. **No `dangerouslySetInnerHTML` anywhere in the P2A surface.**
   Threat model holds: `tk.w` and gloss/example strings render as
   React text children; XSS via fixture content is not reachable. If
   Pass 3 wires `KoreanPassage` to a server endpoint, the server-side
   contract must continue to return plain text (not HTML). Add this
   to `client/SECURITY.md` (the file the Pass 1 D-B1 BLOCKER is
   creating) under a "Reading passages" heading.

6. **Reduced-motion is honoured via the global blanket** at
   `index.css:158-164`. This covers the flashcard flip (480ms
   transition → 0.001ms), sheet up (240ms animation → 0.001ms),
   popover rise (200ms), audio bar width transition (100ms linear).
   The blanket is the right tool — no per-component overrides needed.
   One caveat: the audio progress visual still *jumps* every 100ms
   because the JS interval is unchanged; that's by design and matches
   reduced-motion intent (no smooth interpolation).

7. **Tests do assert the contract**, not just renders. Sample:
   `Toggle.test.tsx:18-21` (aria-checked flips), `Sheet.test.tsx:39-49`
   (Esc fires onClose exactly once), `WordPopover.test.tsx:77-92`
   (Add locks idempotently). This is the bar §2.6 *"Test names
   describe behavior"* discipline showing up. Carry it forward to the
   two missing test files (B-1).

8. **Component sizes are healthy.** WordPopover at 274 lines is the
   largest; KoreanPassage at 209 next. Both under the bar's "function
   ≤ ~50 lines" rule applied at the *function* level (Sentence,
   flushSpan, trapTab, handleAdd are each well under), even though
   the file totals are larger.
