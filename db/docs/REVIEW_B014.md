# Review — B-014 (Review flashcard answer-flash on flip-back)

Reviewer: independent senior read-only pass. No edits made. Branch:
`fix/b014-review-flip-flash`. Commit reviewed: `ac8da6c`.

## Verdict

**APPROVE.** The fix genuinely kills the reported flash, doesn't introduce a
reverse-flash, and the regression test is real (fails on the pre-fix code for
the right reason, confirmed by direct diff against the parent commit). One
SHOULD-FIX (an incidental accessibility win worth locking in with an explicit
comment/test) and two NITs (diff hygiene, no visual/E2E backstop for the CSS
claim).

## Findings

### PRAISE

- **The fix is geometrically correct, not just plausible.** Worked the
  rotateY math from the actual CSS values (`client/src/styles/index.css:1606-1632`):
  `.km-flashcard__inner` rotates 180°→0° over the flip-back; a face is
  front-facing (visible through `backface-visibility: hidden`) whenever
  `cos(effective angle) > 0`. For the back face (`rotateY(180deg)` baseline),
  that holds for the **first half** of the flip-back (θ from 180° down to 90°,
  i.e. ~240ms of the 480ms transition) — exactly matching the reported
  "flashes for about half the rotation." Conditionally mounting the back face
  to `null` while `!flipped` removes the content for the *entire* transition,
  including that first-half window, so there's nothing to leak regardless of
  the geometry. This is the correct root-cause fix, not a band-aid.
- **No reverse-flash.** Flipping front→back (`flipped: false→true`) mounts the
  back content at θ=0, but by the same cosine math the back face doesn't
  become front-facing until θ passes 90° — i.e. not until the *second* half of
  that transition, which is exactly when the back is supposed to become
  visible. Mounting the content a beat "early" (in wall-clock terms, at the
  start of the transition instead of at the moment it would first show) causes
  no visible artifact because the face is geometrically hidden by
  `backface-visibility` for the whole first half regardless of DOM content.
- **Regression test is real, not false-green.** Confirmed by diffing the
  pre-fix `Review.tsx` (`git show 9e78a7e:client/src/pages/Review.tsx`)
  against the post-fix version: pre-fix, the `back={...}` slot
  (`client/src/pages/Review.tsx` old L972) was an unconditional
  `<div className="km-review__back">...</div>` with no `flipped` gate. Run
  against that code, `Review.test.tsx`'s new assertions —
  `expect(screen.queryByText('influence')).not.toBeInTheDocument()` before the
  first flip — would find "influence" unconditionally in the DOM and fail.
  Post-fix, `npx vitest run src/pages/Review.test.tsx` → **19/19 green**
  (verified directly). The test asserts the actual mechanism of the fix
  (content absence pre-flip), which is the correct level to test at — happy-dom
  doesn't run layout/animation, but this bug's fix operates entirely at the
  React mount level, not the CSS level, so a DOM-presence assertion is a valid,
  sufficient proxy once the CSS geometry is independently verified (as above).
- **`rate()` itself is untouched.** Diffed `rate()`'s body byte-for-byte
  between the two commits (ignoring Prettier's quote/wrap churn) — the
  `setFlipped(false)` / `setDrawer(false)` / `setIdx((i) => i + 1)` sequence
  (`Review.tsx:550-552`) is identical to before. The fix is scoped exactly to
  the `back` render slot, as advertised.
- **Drawer state survives correctly, with no regression.** `drawer` is
  Review-level state (`Review.tsx:445`), not local to the now-conditionally-mounted
  JSX, so unmounting/remounting the back slot on every flip doesn't drop it.
  Flipping the *same* card back and forth (without rating) preserves whatever
  `drawer` value was already set — same as pre-fix, since the pre-fix back
  slot was always mounted and `drawer` was already parent-owned. `rate()`
  explicitly resets `setDrawer(false)` (`Review.tsx:551`) when advancing to the
  next card, so drawer state does *not* leak across cards, which is correct
  and unchanged by this diff.
- **No layout jump.** `.km-flashcard__face` is `position: absolute; inset: 0`
  and `.km-flashcard__inner` carries its own `min-height: 340px`
  (`index.css:1606-1619`), so the container's height doesn't depend on the
  back face's content — conditionally rendering it to `null` causes no CLS.

### SHOULD-FIX

- **Incidental a11y improvement is real but undocumented/untested — make it
  intentional.** Pre-fix, the back face's answer content was in the DOM
  unconditionally; `backface-visibility: hidden` is a paint-only property and
  does not remove an element from the accessibility tree. That means a screen
  reader user tabbing/reading through the flashcard region could have had the
  English gloss exposed *before* ever "flipping" the card — the quiz's
  self-test mechanic silently didn't work for AT users. This fix closes that
  gap as a side effect (the answer genuinely isn't in the DOM until
  `flipped`), which is a real accessibility win, but it isn't called out
  anywhere (JSDoc, commit message, or test) as intentional. Recommend adding
  one line to the `Flashcard.tsx` or `Review.tsx` JSDoc noting that
  conditional-mount also fixes premature AT exposure of the answer, so a
  future refactor doesn't accidentally revert to always-mounting the back face
  "for simplicity" and reintroduce it.

### NIT

- **Diff hygiene.** The commit reformats the entire file (single→double
  quotes, line-wrap changes) alongside the targeted fix — 541 lines touched
  for what is functionally a ~50-line change (the back-slot ternary + JSDoc).
  Confirmed via `diff` against the parent commit with quotes normalized that
  no other logic changed, but a reviewer without tooling to do that
  normalization has to eyeball a much larger diff than the fix warrants.
  Prefer a separate formatting-only commit when a repo-wide style pass and a
  bugfix coincide.
- **No visual/E2E backstop for the CSS claim.** The DOM-presence test is the
  right unit-level guard, but nothing in the suite pins the actual rotateY
  values, `backface-visibility: hidden`, or the 480ms duration in
  `index.css:1606-1632` that the fix's correctness argument depends on. A
  future CSS refactor (e.g., switching to `opacity`-based flip, or removing
  `backface-visibility`) could silently reopen the bug or introduce a new one
  without failing any test. Not blocking — this is a reasonable scope cut for
  a P2 fix — but worth a follow-up ticket if the flip animation is ever
  touched again (a Playwright frame-capture or at minimum a CSS-contract test
  asserting the three properties exist would close the gap).

## Detailed (file:line)

- `client/src/pages/Review.tsx:996-1049` — the `back={...}` slot, now
  `flipped ? (<div className="km-review__back">...) : null`. JSDoc at
  `:997-1003` correctly explains the mechanism.
- `client/src/pages/Review.tsx:538-593` — `rate()`; `:550-552` is the
  `setFlipped(false)` / `setDrawer(false)` / `setIdx((i) => i + 1)` batch that
  causes the flip-back + content-swap to land in one commit (root cause of
  the original bug, now neutralized by the conditional mount).
- `client/src/components/Flashcard.tsx:62-82` — controlled flip shell;
  `:72-79` shows front always mounted, back mounted per the caller's
  conditional `back` prop (unchanged file, confirmed no edits needed here).
- `client/src/styles/index.css:1606-1632` — `.km-flashcard` (perspective
  1400px), `.km-flashcard__inner` (480ms `cubic-bezier(.4,.2,.2,1)` transform
  transition), `.km-flashcard--flipped .km-flashcard__inner` (`rotateY(180deg)`),
  `.km-flashcard__face` (`backface-visibility: hidden`), `.km-flashcard__face--back`
  (`rotateY(180deg)`) — the geometry backing the flash/no-reverse-flash
  reasoning above.
- `client/src/styles/index.css:165-174` — global `prefers-reduced-motion`
  block collapses all transitions to `0.001ms`, so the flip-back window this
  fix targets was already near-instantaneous under reduced motion; the fix
  doesn't change that path's behavior.
- `client/src/pages/Review.test.tsx:314-348` — new regression test. Verified
  it fails on pre-fix code (unconditional back-slot mount) by diffing against
  `git show 9e78a7e:client/src/pages/Review.tsx`; verified 19/19 pass on
  current code via `npx vitest run src/pages/Review.test.tsx`.
- `db/docs/BUG_RETRIAGE_2026-07-05.md:21` — the re-triage entry documenting
  the actual mechanism (CSS transition racing the content swap, not the
  originally-suspected React batching timing), which this fix correctly
  targets.
