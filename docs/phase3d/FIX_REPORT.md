# Phase 3D — Chat Fix-Pass Report

**Scope:** fixes from `docs/phase3d/REVIEW_chat_client.md` (FAIL — 1 blocker, 4 should-fix) and `docs/phase3d/REVIEW_chat_server.md` (PASS — 1 should-fix). Branch `feat/phase3d-chat`. No push, no deploy.

## Findings

| ID | Finding | Disposition | Notes |
|---|---|---|---|
| **B-1** | "+" attach menu missing arrow-key roving navigation + close-on-Tab-out | **FIXED** | See "B-1 detail" below. |
| **S-1 (client)** | Generic 400 copy can't distinguish "wrong format" from "content flagged" | **FIXED** | Required a small, low-risk SERVER change too (see "S-1 detail"). |
| **S-2 (client)** | Auto-name latch-release-on-failure path untested | **FIXED** | New test added; no production code change needed (behavior was already correct). |
| **S-3 (client)** | Outside-click focus doc/code mismatch | **FIXED** | Comment rewritten to match actual (correct) behavior; code unchanged. |
| **N-1 (client)** | English-toggle wrapper has false-affordance cursor | **FIXED** | `<span>` → `<label>`; now genuinely clickable, matching the `cursor: pointer` it already had. |
| **S-1 (server)** | `/name` route not exactly-once under concurrent first calls | **DEFERRED → F-125** | Justification below. |

---

### B-1 detail — attach menu keyboard a11y (BLOCKER)

`client/src/pages/Chat.tsx` (~955–1052, render ~2048–2110): added roving-tabindex bookkeeping (`attachActiveIndex` state + `attachActiveIndexRef` mirror, `focusAttachItem`) and split the single "on open" effect into two: one that resets/focuses item 0 ONLY when the menu transitions open, and one that attaches the document `keydown`/`mousedown` listeners while the menu is open.

- `ArrowDown`/`ArrowUp` move focus to the next/previous item, wrapping at each end; `Home`/`End` jump to the first/last item.
- Each `menuitem` now carries `tabIndex={0}` only when it's the active roving-tabindex target, `-1` otherwise (each item's `onFocus` also syncs the roving index, so mouse/pointer focus stays consistent).
- `Tab` now closes the popup (`closeAttachMenu(false)`) WITHOUT calling `preventDefault` — the browser's own default focus-move still runs (forward past the menu, or backward via Shift+Tab), so the fix doesn't trap focus; it only stops the popup from being rendered once focus is gone, closing the "orphaned floating menu" hole the review found.
- Escape, outside-click-close, and open-focuses-first-item are all preserved unchanged (PRAISE-worthy pre-existing behavior, not touched).

**Mid-fix bug caught by the tests themselves:** my first version depended the listener-attaching effect on `attachActiveIndex`, which re-ran the effect on every arrow-key move — but the same effect ALSO reset focus to item 0 on every run (the "menu opened" reset wasn't separated from "menu still open, index changed"). Result: every ArrowDown snapped focus straight back to Camera. Caught immediately by running the new tests (not by inspection) and fixed by moving the "reset on open" logic into its own effect keyed only on `attachMenuOpen`, and having the keydown handler read/write a `useRef` mirror of the index instead of the closured state value.

**Tests added** (`Chat.test.tsx`, "Chat attach menu (F-035)" block):
- `moves focus between menu items with ArrowDown/ArrowUp/Home/End (roving tabindex, wraps at each end)`
- `closes the menu on Tab so it can never be left open+orphaned once focus moves on`

**Mutation check:** stashed only the `Chat.tsx` production-code changes (kept the new tests), reran the two new tests against the pre-fix `Chat.tsx` → both FAILED (2 failed / 2 selected) — confirming the tests actually exercise the fixed behavior, not a tautology. Re-applied the fix (`git stash pop`) and reran the full suite → all green again.

### S-1 (client) detail — distinguishing "wrong format" from "content flagged"

The two 400 causes on `POST /conversation/:id/file` were structurally indistinguishable on the wire: every `ValidationError` (empty file, non-UTF-8 bytes, binary content) AND the prompt-injection rejection all carried the same `code: 'validation_error'`. Fixing the client copy honestly required a small server-side change first:

- `server/src/middleware/errors.ts`: added `ContentRejectedError extends AppError` (`status: 400`, `code: 'content_rejected'`) — same HTTP status as `ValidationError`, only the wire `code` differs.
- `server/src/services/docAttach.ts`: the injection-guard catch block now throws `ContentRejectedError` instead of `ValidationError` (the marker text itself is still never echoed — unchanged).
- `client/src/pages/Chat.tsx`'s `docUploadErrorMessage`: added a branch keyed on `err.code === 'content_rejected'` returning distinct fixed copy ("That document's content can't be sent to the tutor. Try a different file.") BEFORE the generic 400 fallback ("...Use a plain text (.txt or .md) file under 256 KB.").

**Tests added:**
- `server/tests/routes/conversation.test.ts`: the existing binary-bytes-despite-text/plain-mime test now asserts `code: 'validation_error'`; the existing injection-marker test now asserts `code: 'content_rejected'` — proving the two 400 causes are now structurally distinguishable, not just documented as such.
- `client/src/pages/Chat.test.tsx`: new test `renders distinct copy for a server-side content_rejected 400 (not the generic "wrong format" message)` in the "Chat document attach (F-035)" block.

This is a genuinely low-risk change (new error subclass, one `throw` swapped, one new `if` branch) and directly closes the loop both reviews independently flagged (client review S-1 / server review N-1) — not scope creep, since the client fix is meaningless without it.

### S-2 detail — auto-name latch-release test

No production code changed — `triggerAutoName`'s rejection branch (`Chat.tsx`) was already correct, just untested. Added `releases the latch on a failed nameConversation call so a later turn retries it` to the "Chat auto-naming (F-036)" block: rejects the first `nameConversation` call, sends a second turn, and asserts `nameCalls.length` becomes 2 (proving the conversation isn't permanently wedged unnamed after a transient failure).

### S-3 detail — outside-click focus doc/code mismatch

Per the review's own recommendation ("fix the comment, not the code — the code's choice is defensible"), rewrote the header's "Attachments" section (~lines 144–155) to accurately describe: Escape closes+refocuses the trigger; Tab closes without trapping focus (new, see B-1); outside mousedown closes without moving focus, explained (not forcing focus back onto the trigger after a click that may have activated something else). No behavior change.

### N-1 detail — English-toggle false-affordance cursor

`Chat.tsx`: `<span className="km-chat__engToggle">` → `<label className="km-chat__engToggle">`. `Toggle` renders a native `<button>` (a labelable element per the HTML spec), so wrapping it in a real `<label>` makes the whole "English · 영어" row actually clickable via the browser's built-in label→control delegation — matching the `cursor: pointer` it already had in `Chat.css` instead of contradicting it. Required also adding `Toggle` to `client/eslint.config.js`'s `jsx-a11y/label-has-associated-control` `controlComponents` list (the rule can't statically see that a custom component renders a labelable native element).

### S-1 (server) detail — `/name` route race — DEFERRED to F-125

**Not fixed in this pass.** Filed as `F-125` in `BUGS_AND_FEATURES.md`. Both of the two clean fixes the review suggested carry real cost disproportionate to the risk:

1. A claim-first sentinel column (`UPDATE ... SET title = 'PENDING' WHERE title IS NULL`) is a **schema change** — this repo's own gate (`feedback_fixpass_gates_run_full_suite.md`) requires migration/schema work to run the FULL client+server+db suite, not a targeted slice. This fix-pass was explicitly scoped to targeted verification only.
2. A session-scoped Postgres advisory lock held across the Claude network round-trip needs careful client-checkout/release lifecycle management — a pattern with **zero existing precedent or test coverage** in this codebase. Introducing it under a targeted-test-only gate risks a subtler bug (a leaked lock or pooled connection) than the race it fixes.

The race itself is bounded and does not meet this project's bar for forcing a fix at any cost: it can only fire ONCE per conversation (every later call short-circuits with zero Claude spend, verified by the existing idempotency tests), storage never diverges (the UPDATE's `WHERE title IS NULL` guard means exactly one write wins), and it's further capped by the existing per-user `expensiveLimiter()`. Both independent reviews characterized it the same way — "not a blocker," "worth a follow-up ticket."

---

## Verification

**Client** (`cd client`):
- `npm run lint` → 0 errors, 0 warnings.
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` → 0 errors.
- `npx vitest run src/pages/Chat.test.tsx` → **67/67 passed** (63 pre-existing + 4 new: 2 attach-menu keyboard, 1 auto-name latch-release, 1 content-rejected copy).

**Server** (`cd server`, touched — `errors.ts`, `docAttach.ts`, `conversation.test.ts`):
- `npx tsc --noEmit` → 0 errors.
- `npx vitest run tests/routes/conversation.test.ts` → **74/74 passed** (72 pre-existing + 2 new assertions on existing tests, not new test cases — the injection-marker test and the binary-bytes test each gained one `expect(res.body.error.code)` line; no test count change on the server side).

**Mutation check (blocker):** confirmed above — stashing only the `Chat.tsx` production fix (keeping the new tests) causes both new keyboard tests to fail (2/2); re-applying the fix restores 67/67 green.

**Praise items:** none undone. B-020 label/aria-label, F-034 dictionary removal, F-035 upload paths' 409/abort/mutual-exclusion handling, F-036's precedence chain and confirmedTitles design, and the abort/mount discipline are all untouched except where a finding explicitly required a change (English-toggle wrapper tag, docUploadErrorMessage's branch order, the header comment).
