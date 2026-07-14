# REVIEW — Batch 4 (Chat / Settings / Tickets reskin)

**Behavior-preservation review** — these three pages are RESKIN passes over existing,
shipped functionality (Chat: Phase 3D; Settings: Phase 3A + F-038/F-093; Tickets: F-023 +
F-127). The design-fidelity capstone review (`REVIEW_batch4-fidelity.md`) already covers
visual/mockup/device-adoption fidelity for these same three pages (PASS, zero blockers) —
this review does **not** re-litigate that; it is a separate, narrower pass asking only
"did the reskin regress anything that already worked."

Branch `feat/redesign-learn-b` @ `fae8223` (off `rebuild`). Reviewer: independent senior
React/TS engineer, did not author this code. No code was changed by this review; all
claims below were independently verified by reading the current files, diffing against
`rebuild`, and — for the two BLOCKER findings — re-derived by hand from the source lines
cited (not taken on a sub-reviewer's word).

---

## Verdict

**CONDITIONAL PASS — 2 BLOCKERs, 5 SHOULD-FIX, 2 NIT.** Settings' reskin is clean —
wiring, collapse behavior, and test coverage are all intact, with the diff itself proving
the point (it never touches a single control's JSX). Chat's *logic* is untouched (74/74
tests pass, zero handler/state-machine lines differ from `rebuild`), but the reskin
**introduces** a genuine new touch-target regression on the two most-used composer
buttons, and the page's own new F-129 test cannot catch it because jsdom has no layout
engine. Tickets' pre-existing flows (tabs, filters, anonymity, 409 recovery, comments,
pagination, provenance) are logic-identical, but the new Sheet-gated compose flow ships
with a crash-class bug in its router-state guard and a memoization fix that has no
regression test protecting it.

Neither blocker is a "the feature stopped working" regression in the classic sense —
both are new defects **introduced by** the reskin's own new code (a CSS override, a new
router-state branch), which is precisely why a design-fidelity/mockup-matching review
would not have caught them: neither shows up as "wrong color" or "missing device."

---

## Ticket checklist

| Ticket | Page | Status this batch |
|---|---|---|
| **F-128** (Seoul Day & Night visual redesign) | Settings, Chat, Tickets | Adopted — `PageHubHeader`, `CityCard`/`CollapsibleTile surface="city"`, `DancheongRail`, zero hardcoded hex confirmed by grep on all 6 files (`.tsx`+`.css` × 3 pages) |
| **F-129** (mobile responsiveness / horizontal overflow) | Settings | Horizontal-overflow risk addressed (media query); **touch-target claim in the new code comment is inaccurate** — see S-1 |
| **F-129** | Chat | Horizontal-overflow tests added, but jsdom-only so they can't verify layout; **the composer's own touch targets regressed below 44px** — see BLOCKER-1 |
| **F-129** | Tickets | No fixed-width overflow risk found; no touch-target regression found |
| **F-131** (accent-color hover states) | Settings | N/A — `Settings.css` has zero hover/active rules |
| **F-131** | Chat | Clean — `--vermilion`/`--on-vermilion` genuinely re-point per `[data-accent]` |
| **F-131** | Tickets | Clean — no new hover states introduced |
| **F-127** (FeedbackFab hand-off → Tickets) | Tickets | Wired correctly for the one real caller, but the defensive guard has a hole — see BLOCKER-2; `FeedbackFab.tsx`'s own doc comment is now stale — see T-2 |

No dedicated per-page Wave-2 feature ticket list exists for Chat/Settings/Tickets in
`BUGS_AND_FEATURES.md` beyond the cross-cutting F-128/F-129/F-131 (confirmed by grep —
unlike Today/Progress/Library/LEARN, these three pages have no `### Chat` / `### Settings`
/ `### Tickets` Wave-2 subsection).

**Recommend filing** (next available IDs, F-183+, not filed in this pass since this
review makes no code/doc edits):
- Chat composer touch-target regression (BLOCKER-1) — P1, bug/mobile/a11y
- Tickets `sourcePage: null` crash (BLOCKER-2) — P2, bug
- Settings F-129 touch-target comment correction + real fix for `.km-settings__sched-field` / `Toggle` (S-1) — P3, bug/design
- Tickets draft-loss-on-dismiss (T-1) — P3, ux
- Tickets useCallback focus-race regression test (T-3) — P4, test

---

## Behavior-preservation verdict per page

### Settings wiring — **regressed: NO**
`git diff rebuild -- client/src/pages/Settings.tsx` is 152 lines across 7 hunks: the file
doc-comment, an import swap (`Topbar`→`PageHubHeader`), a root className add, the
`PageHubHeader` swap, five `tone="…"` prop additions on `SettingsGroup`/`TwoFactorSection`
call sites, and `SettingsGroup`'s signature threading `tone` into
`CollapsibleTile surface="city"`. Every `SettingsRow`, `ThemeModeControl`,
`TextSizeControl`, `SwatchPicker`, `LanguageDisplayControl`, the MFA body
(`TwoFactorSection`, `client/src/pages/Settings.tsx:1443-1449`), the notification-schedule
rows, and profile-autosave JSX appear in the diff only as **unchanged context** — zero
`+`/`-` lines inside any control. `npx vitest run src/pages/Settings.test.tsx` →
**53/53 passed**, covering theme-mode (`:1202-1228`, dataset/localStorage assertions),
accent (`:918-1024`, `data-accent` + PUT-body assertions), text-size (`:1051-1143`, same
pattern), notification schedules (`:1867-2064`, PUT-body/debounce/clobber-guard
assertions), and profile autosave (`:329-599`, PATCH-body/409-rebase assertions) — all
genuine state-mutation checks, not render-only tautologies. `CollapsibleTile` keeps the
body mounted + `aria-hidden`/`inert` under `surface="city"` exactly as under
`surface="card"` (confirmed by reading the shared, unchanged component,
`client/src/components/CollapsibleTile.tsx:118-158`), so no control loses live state on
collapse/expand.

### Chat features — **regressed: NO (logic) / YES (one new touch-target defect)**
`git diff rebuild -- client/src/pages/Chat.tsx` only touches JSX wrapper markup
(`Topbar`→`PageHubHeader`, raw `<button>`→`Button`, raw `<div>`→`CityCard`, added
classNames) and doc comments — zero lines inside `runStream`, retry, upload/409 handling,
the attach-menu keyboard-nav effect, auto-naming, or sidebar select/collapse differ from
`rebuild`. `npx vitest run src/pages/Chat.test.tsx` → **74/74 passed** (68 pre-existing +
6 new). `git diff rebuild -- client/src/pages/Chat.test.tsx` is purely `+135` additive
lines appended after the last existing `describe` block — no deletions, no weakened
assertions. However, the reskin's own new CSS (BLOCKER-1 below) shrinks the composer's
attach/send buttons to 36×36px, under the 44px floor the design doc and the codebase's
own `.km-btn--sm` precedent both treat as non-negotiable — a defect that did not exist in
`rebuild` and was introduced by this pass.

### Tickets flows — **regressed: NO (existing flows) / one new crash-class bug (new Sheet-gated flow)**
`git diff rebuild -- client/src/pages/Tickets.tsx` shows every non-cosmetic line is
either a `Card`→`CityCard` swap, a `Topbar`→`PageHubHeader` swap, the Sheet-gating
restructure itself, or the two `useCallback`s that restructure requires. My-tickets/
Community tabs, filters, "Reported from" provenance (both self-filed and
FeedbackFab-sourced), Community anonymity, 409 recovery (B-033's known 409-vs-404 gap is
untouched — no server-route changes in scope), comments, and pagination are byte-for-byte
unchanged. All 24 tests in `Tickets.test.tsx` (existing + new) pass. The new
Sheet-gated compose flow, however, ships with an unguarded-`null` crash in its
router-state narrowing (BLOCKER-2) — latent today (the only real caller, `FeedbackFab`,
never sends that shape) but reachable via any future caller or a hand-crafted
`navigate()`/deep link, directly contradicting the code's own comment that malformed
state "just falls back to 'no page context.'"

---

## Findings

### BLOCKER

**BLOCKER-1 — Chat composer touch targets shrink below the 44px floor (F-129 regression)**
`client/src/pages/Chat.css:245-254`:
```
.km-chat .km-chat__attachTrigger { padding: 10px; border-radius: 50%; }
.km-chat .km-chat__sendBtn { padding: 10px; border-radius: 50%; }
```
`Button`'s `md` size is `padding: 12px 18px` (`client/src/styles/index.css:877`) with no
`min-height`/`min-width` floor — that floor only exists on `.km-btn--sm`
(`client/src/styles/index.css:876`: `min-height: 44px; min-width: 44px`, with its own
doc comment citing WCAG 2.5.8 / `DESIGN_SEOUL_DAY_NIGHT.md` §8). This page-scoped
override drops `md`'s padding to 10px all sides around a `size={16}` `Icon` (which
renders an exact `width={size} height={size}` SVG with no internal padding —
`client/src/components/Icon.tsx:231-233`), landing both the attach trigger
(`client/src/pages/Chat.tsx:2124-2127`, `Icon` used at the trigger) and the send button
(`client/src/pages/Chat.tsx:2221-2231`, `<Icon name="send" size={16} />`) at **exactly
36×36px** — versus the pre-reskin `.km-btn--md` pill (no override existed on `rebuild`).
Both are the two most-used controls in the whole page. This is the reskin actively
shrinking the exact metric F-129 exists to fix.

The companion test, `client/src/pages/Chat.test.tsx:113-142` ("F-129 mobile: no
horizontal overflow"), only asserts DOM ancestor containment
(`.closest('.km-chat__composerRow')`, `.closest('.km-chat__attach')`) — jsdom has no
layout engine, so this test cannot detect rendered box dimensions and gives false
assurance of F-129 coverage while missing this exact regression.

**Fix direction (not applied — review only):** either drop the page-scoped
padding override for a token-driven minimum (e.g. keep `Button`'s own `min-height`/
`min-width: 44px` and size the icon/padding within that box), or explicitly add
`min-height: 44px; min-width: 44px` alongside the 10px padding.

**BLOCKER-2 — `sourcePage: null` crashes Tickets at render (F-127 router-state guard)**
`client/src/pages/Tickets.tsx:889-895`:
```ts
const sourcePage =
  navState?.sourcePage !== undefined &&
  typeof navState.sourcePage.path === 'string' &&
  typeof navState.sourcePage.name === 'string'
    ? navState.sourcePage
    : undefined;
```
`null !== undefined` is `true` in JS. When `sourcePage` is explicitly `null` (as opposed
to simply absent), the first clause passes and the second clause dereferences `.path` on
`null`, throwing `TypeError: Cannot read properties of null (reading 'path')` — uncaught,
at render time. Independently reproduced two ways: hand-tracing the expression, and an
end-to-end RTL render of `<Tickets>` with
`initialEntries=[{ pathname: '/tickets', state: { compose: true, sourcePage: null } }]`,
which crashes at this exact line. The surrounding comment
(`client/src/pages/Tickets.tsx:885-888`) explicitly promises "anything malformed just
falls back to 'no page context'" — false for this one shape. `TicketsLocationState` is not
exported/shared outside this file, so nothing currently stops a future caller (or a
hand-typed deep link / programmatic `navigate()`) from sending `sourcePage: null` and
taking down the page. `FeedbackFab.tsx` (the only current caller, confirmed unchanged in
this diff via `git diff rebuild -- client/src/components/FeedbackFab.tsx` = empty) never
sends this shape, so the bug is latent, not user-facing today.

**Fix direction (not applied — review only):** `navState?.sourcePage != null` (loose
null-check) or `typeof navState?.sourcePage === 'object' && navState.sourcePage !== null`
before touching `.path`/`.name`.

### SHOULD-FIX

**S-1 — Settings F-129 doc comment overstates touch-target compliance**
`client/src/pages/Settings.css:119-129` (new comment) claims "the day `<select>`, the
time field, and the `Toggle` all stay ≥ 44px tall." This is not accurate on either side
of the new 380px breakpoint: `.km-settings__sched-field`
(`client/src/pages/Settings.css:90-99`; padding 8px+8px, font-size 13px, 1px border)
computes to ~33-34px tall, and `.km-toggle` (`client/src/styles/index.css:2577-2586`) is
a hardcoded `width: 38px; height: 22px` with no larger hit-area wrapper
(`client/src/components/Toggle.tsx:38-61` renders the 38×22 button as the sole
interactive element). Neither meets the 44px floor in either layout. The media query does
fix the actual horizontal-overflow risk (the real F-129 ask), so the layout change itself
is sound — only the comment's compliance claim is wrong. Recommend correcting the comment
and tracking the touch-target gap as its own ticket rather than asserting it solved.

**S-2 — Chat doc comment overclaims token purity**
`client/src/pages/Chat.css:21-23` ("Tokens only — no hard-coded hex anywhere in this
file (F-131)") is true for hex specifically (grep-verified: zero hex hits in both
`Chat.tsx` and `Chat.css`), but two literal `rgba()` values remain:
`client/src/pages/Chat.css:272` (`box-shadow: 0 10px 24px rgba(0, 0, 0, 0.32)`) and
`client/src/pages/Chat.css:458` (`background: rgba(6, 8, 12, 0.32)`, the ask-popup
backdrop scrim). Both predate this pass (unchanged in the diff) and are conventional
un-tokenized literal-black shadow/scrim values — not a new violation — but the comment's
phrasing claims more than it delivers.

**S-3 — Tickets: unsubmitted draft is silently lost on sheet dismiss (not on failure)**
`client/src/pages/Tickets.tsx:295-317` (`FileTicketForm`'s local `title`/`body`/`type`
state) combined with `client/src/components/Sheet.tsx:52` (`if (!open) return null` —
unmounts children on close). A failed *submit* correctly preserves typed values (only the
`onFiled` success path calls `closeFileSheet`; the catch branch does not). But dismissing
the sheet without submitting — Esc or backdrop click — unmounts `FileTicketForm` and
destroys the draft. Pre-reskin the form was always-inline and never lost a draft under
any circumstance; this is a genuine UX behavior change introduced by the move to `Sheet`,
untested and not called out as an accepted tradeoff in the design docs.

**S-4 — `FeedbackFab.tsx` doc comment is now stale**
`client/src/components/FeedbackFab.tsx:13-14`: "`Tickets.tsx` reads `state.compose` to
autofocus the (always-rendered) file-a-ticket form" is no longer true — the form is now
Sheet-gated and closed by default. `FeedbackFab.tsx` itself is unchanged in this diff
(`git diff rebuild -- client/src/components/FeedbackFab.tsx` = empty), so the *code* is
fine, but this PR is exactly the one that made the comment inaccurate and should have
updated it.

**S-5 — No regression test pins the `useCallback` focus-race fix**
`client/src/pages/Tickets.test.tsx` has no test that triggers a Tickets-level re-render
(filter change, tab change, list refetch) *while the sheet is open* and then asserts focus
remains inside the dialog — the exact scenario the fix at
`client/src/pages/Tickets.tsx:1089-1091` (`closeFileSheet = useCallback(() =>
setFileOpen(false), [])`) addresses. RTL/jsdom effects run synchronously, so this is fully
testable. As written, reverting the fix to an inline arrow
(`onClose={() => setFileOpen(false)}`) would not fail any existing test.

### NIT

**N-1 — Chat askpop CityCard skips the `rail` prop**
`client/src/pages/Chat.tsx:1969`: `<CityCard tone="accent" feat className="km-chat__askpop">`
omits `rail`, so the "Discuss the page you were on?" popup gets CityCard's glow/gradient
body but no `DancheongRail` leading edge, even though CityCard's own doc comment
(`client/src/components/CityCard.tsx:29-31`) frames `rail` as part of the canonical
device-#1 hero-card recipe. Cannot confirm intent against the mock; flagging as a possible
missed polish opportunity, not a defect.

**N-2 — Settings test redundancy**
`client/src/pages/Settings.test.tsx:2095-2107` duplicates existing coverage in the
pre-existing `describe('Settings — collapsible groups (F-038)')` block
(`:1667-1727`, esp. `:1696`). Harmless, adds no new regression surface.

### PRAISE

- Settings: the entire reskin diff never reaches into a single control's JSX — the
  minimality itself is what makes "no wiring regression" verifiable by inspection, not
  faith.
- Chat: the decision **not** to wrap each message bubble in a full `CityCard` is sound
  engineering judgment, not corner-cutting. `CityCard`'s own doc comment
  (`client/src/components/CityCard.tsx:1-9`) frames it as a singular "featured
  surface... hero card, milestone panel, callout" — the wrong primitive for dozens of
  stacked turns in a scrolling thread. `Bubble` (`client/src/pages/Chat.tsx:2280`)
  instead applies the `km-tone--accent` utility class directly, resolving the same
  `--km-tone` variable CityCard reads, at a scaled-down, inset-ring treatment
  (`client/src/pages/Chat.css:104-112` vs. `client/src/components/CityCard.css:26-33`) —
  genuine device reuse at the right density, not a shortcut.
- Chat: the `--vermilion`→`--on-vermilion` retry-chip fix
  (`client/src/pages/Chat.css:168-175`) is independently verified as the correct semantic
  pair with real numbers, not just asserted: Day white-on-`#C0492E` ≈ 4.96:1 (clears AA
  4.5:1); Night `#0A0C12`-on-`#FF3E6C`/`#FF6B8A` ≈ 5.73:1 / 7.19:1. The background this
  text sits on really is the accent-filled fill in both themes
  (`client/src/pages/Chat.css:115-123`), so the "`--on-X` sits on an X-filled background"
  contract genuinely holds.
- Chat: swapping hand-rolled buttons for the shared `Button` component preserved every
  ref-dependent focus/outside-click call site (`Button`'s `forwardRef` threads through
  correctly to `attachTriggerRef.current?.focus()` / `.contains(target)` uses) — an easy
  place to silently break something that didn't break.
- Tickets: the old bespoke `useRef` + one-shot-effect autofocus hack in `FileTicketForm`
  was correctly deleted in favor of reordering Title-before-Type so
  `useModalA11y`'s built-in first-focusable-descendant behavior lands correctly on its
  own — a real simplification enabled by the Sheet move, not just a reskin no-op.
- Tickets: the `useCallback` fix for the focus race is a genuine root-cause fix (stable
  `onClose` identity removes the spurious re-arm of `useModalA11y`'s effect entirely)
  rather than a symptom patch — see the detailed race explanation below.

---

## Detailed reasoning: the useCallback focus-race fix (Tickets)

`useModalA11y`'s setup effect depends on `[open, onClose]` and, on cleanup, removes the
Esc listener, restores `body.style.overflow`, and `queueMicrotask`s a focus restore to
whatever element it captured as `previouslyActive` *at setup time*. Before this fix, an
inline `onClose={() => setFileOpen(false)}` gets a new function identity on every parent
render; since `Tickets` re-renders on every list/filter/tab state change independent of
the sheet, the effect would tear down and re-arm on every such render while the sheet is
open — each re-arm re-captures `document.activeElement` as the new restore target, and
the just-queued cleanup microtask from the previous instance can fire afterward and yank
focus out of the sheet mid-type. Memoizing `closeFileSheet` with
`useCallback(() => setFileOpen(false), [])` (`client/src/pages/Tickets.tsx:1089-1091`)
gives it a permanently stable identity (`setFileOpen` is itself guaranteed stable by
React), so the effect only re-arms on a genuine `open` transition. This is correct and,
for this specific race, complete — its one structural limitation is that the discipline
lives in the caller, not inside `useModalA11y` itself (e.g. via an internal ref for the
latest `onClose`), so any other current or future `Sheet`/`WordPopover`/`MoreSheet`
consumer that forgets to memoize its own `onClose` reintroduces the identical race with
nothing in the shared hook to stop it. See S-5 for the missing regression test.

---

## Coordination observations

- **This review is complementary to, not overlapping with,** `REVIEW_batch4-fidelity.md`
  (design-fidelity capstone, same branch/commit, PASS/zero-blockers for these same seven
  surfaces). That review's checklist is about mockup/device-adoption fidelity and
  correctly found none of the two functional defects here — BLOCKER-1 (a CSS padding
  override producing an under-44px control) and BLOCKER-2 (a `null`-vs-`undefined`
  narrowing bug) are invisible to a "does it match the mock and use the devices"
  lens. Recommend both reviews' findings be triaged together before this batch merges;
  neither reviewer's PASS supersedes the other's findings.
- The `Sheet`/`.km-popover` chrome rendering flat regardless of theme tone (flagged by
  the Chat builder as a pre-existing shared-file gap) is out of scope for all three of
  these pages individually — it lives in `styles/index.css`, not any page's own
  stylesheet, and both `Sheet.tsx` and `.km-popover` consumers across the app share the
  same gap. Confirmed it is not something Chat, Settings, or Tickets could reasonably
  have token-scoped around locally without duplicating shared chrome. Worth a shared
  follow-up ticket, not a per-page fix.
- All three pages' `.tsx`/`.css` files grep clean for hardcoded hex
  (`grep -n "#[0-9a-fA-F]\{3,6\}"`), satisfying F-128's non-negotiable across this batch.
- Test suites were independently re-run, not trusted from the diff/PR description:
  Settings 53/53, Chat 74/74, and (per the Tickets sub-review) 24/24 all pass on the
  current branch.
