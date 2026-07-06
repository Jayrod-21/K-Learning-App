# Fix report — tester-sweep Batch A

Review: `REVIEW_SWEEP_BATCH_A.md` — **1 BLOCKER** (fix #4), plus SHOULD-FIX (no
tests for the text/plural changes; 0/0-lesson edge). #3 and #5 verified solid.

| Finding | Disposition |
|---|---|
| **BLOCKER — #4 empty-Highlights used a `useEffect` to set `lessonTab`**: trips `react-hooks/set-state-in-effect` and causes a one-commit mis-render (empty tablist + stale "No highlights" panel) on the 0-highlights case; `act()` hid it from the test (false-green). | **FIXED** — removed the effect entirely. The shown tab is now **derived during render**: `effectiveTab` falls back to the non-empty side when the selected tab has no content (symmetric, both directions), and `visibleLessonTabs` filters out an empty tab. No state-in-effect, no post-render flash — the first paint is already correct. `Ttmik.tsx`. |
| SHOULD-FIX — 0/0 lesson (no highlights AND no transcript) filtered the tablist to zero tabs with no empty state. | **FIXED** — that case now renders "No read-along content for this lesson yet." instead of an ARIA-invalid empty tablist. + regression test. |
| SHOULD-FIX — text/plural changes shipped without tests. | **FIXED** — added a Today "1 card due" singular test; the #4 test now also asserts the stale "No highlights for this one." message never leaks (the exact false-green the reviewer flagged). |
| #3 badge contrast, #5 blank example | **KEPT** — reviewer verified both solid (contrast math + traced every `WordPopoverData` producer: no path has `ex_en` without `ex_kr`). |

## Verification
- Lint **0 errors** (the set-state-in-effect is gone by construction); `tsc` clean.
- Client suite green (~594); `Ttmik`/`WordPopover`/`Today` 29/29 incl. all new tests.
- The #4 test is no longer false-green: with the derived render there is no intermediate state for `act()` to collapse — the asserted state IS the only state, and it additionally asserts the empty-panel message never appears.
