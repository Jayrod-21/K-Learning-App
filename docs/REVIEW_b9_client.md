# REVIEW — Batch 9 client half (F-059 + F-056 + NIT-A)

Reviewer: independent senior review, branch `feat/b9-uploads-ui`, worktree
`.claude/worktrees/b9-uploads-ui`. Scope: client files only (UploadViewer,
ReviewGrammar saved section, ReviewVocab NIT-A, services/uploads,
services/grammar, types/domain, tests, CSS). Server route read for contract
verification only.

## Summary verdict

**PASS — 0 BLOCKER, 3 SHOULD-FIX, 4 NIT.** The F-059 trigger handles every
documented server error with its own fixed copy (prose never echoed, all four
paths test-pinned), the busy/disabled lifecycle is sound and cannot leave the
UI stuck, the fetch boundary is properly typed with `upload_id`/`error`
dropped and test-enforced, the grammar saved section is a faithful mirror of
the vocab twin, and the NIT-A fix is real in BOTH pages — verified by
mutation: reverting the early-return to `groups.length === 0` fails exactly
the two new tests (1 per page). Gates re-run locally: `tsc` clean, `eslint`
clean, 207/207 tests pass across the 5 touched files (matches BUILD doc).

Top finding: the 400 fixed copy ("That page range isn't valid for this
book") is misleading for the only 400 this button can realistically produce —
the client always POSTs an empty body, so a 400 in practice means "book
already fully extracted", not a bad range the user never entered.

## Bar checklist

| Bar item | Status | Evidence |
|---|---|---|
| Every documented error → honest fixed copy (409/429/400/404) | PASS (400 wording caveat → SF-1) | `UploadViewer.tsx:332-350` (`extractErrorCopy`); tests `UploadViewer.test.tsx` it.each 409/429/400/404 assert fixed copy AND absence of `server prose that must never render` |
| 429 surfaces structured numeric retry hint | PASS | `UploadViewer.tsx:337-341`; test "429 with a structured retry hint" (3600s). Readability NIT-1 |
| Busy/disabled while a run is live | PASS | `disabled={extracting \|\| runLive}` + `aria-busy` `UploadViewer.tsx:1333-1334`; `runLive` covers `pending`+`running` (1163-1165); in-flight disabled test + cross-tab GET-seeded disable test both real |
| Double-fire | PASS | `if (!id \|\| extracting) return` guard `UploadViewer.tsx:1168` + disabled button; React flushes discrete-event state before the next click, so a double-click can't slip both |
| Synchronous multi-minute POST — timeout + settled state sane, can't stick | PASS (caveat SF-2) | Per-call `EXTRACT_TIMEOUT_MS = 5 min` (`uploads.ts:343-370`) overrides the 10 s app default (test-pinned `timeout > 10_000`); `finally { if (!ctrl.signal.aborted) setExtracting(false) }` (1188-1190) guarantees settle; unmount aborts (1154-1158) |
| WCAG AA + ARIA on button / status strip / grammar section | PASS (announce-timing caveat SF-3) | Real `<button>`s; label-in-name OK ("Extract text from this book" contains visible "Extract text"); `role="status"` + `aria-label` on strip (1355-1358); `ErrorCard` is `role="alert"` (`components/ErrorCard.tsx:47`); grammar section = `CollapsibleTile` (aria-expanded/controls) + `<section aria-label>` regions |
| Strict TS at the fetch boundary; `upload_id`/`error` dropped | PASS | `ExtractionRunWire` (`uploads.ts:288-304`) → explicit `toExtractionRun` mapping (317-333); drop pinned by `uploads.test.ts` (`not.toHaveProperty('error'/'upload_id')`); grammar envelope typed (`domain.ts:1046-1076`), wire verified camelCase against `server/src/routes/grammar.ts:374-508` |
| Honest empty/truncated/loading states | PASS | null-when-empty-and-untruncated (both pages); strip hidden with no runs; best-effort GET failure leaves trigger usable (test-pinned) |
| NIT-A: truncated+zero-groups renders note, BOTH pages | PASS — mutation-verified | `ReviewVocab.tsx:436`, `ReviewGrammar.tsx` (`GrammarSavedFromUploads`); reverting the condition in both files → exactly the 2 new tests fail |
| Grammar section mirrors vocab model | PASS | Near-verbatim structure vs `ReviewVocab.tsx:409-483` (CollapsibleTile surface="city" rail, Eyebrow per group, same key scheme, same truncation copy) |
| Tests exercise real behavior | PASS | Deferred-promise in-flight assertion; 409→history-re-read→disabled sequence; prose-never-renders negative assertions; encoded-id probe (`'9/../1'` → `/uploads/9%2F..%2F1/extract`) |
| Co-located CSS | PASS | `UploadViewer.css:85-104` (`__extract`, `__extract-hint`), `ReviewGrammar.css:21-46` mirrors `ReviewVocab.css` naming |
| No scope creep / dead code | PASS | Old "coming soon" test replaced, not orphaned; one dead test param (NIT-2) |

## Findings by category

- **BLOCKER**: none.
- **SHOULD-FIX**: SF-1 (400 copy misleading for fully-extracted book),
  SF-2 (no history re-read after a timeout failure — button re-enables while
  a run may still be live), SF-3 (status strip mounts WITH `role="status"` —
  first-run settle likely never announced).
- **NIT**: N-1 (raw-seconds 429 hint), N-2 (dead `retryAfter` it.each param),
  N-3 (`doneRunCopy` computed twice per render), N-4 (interactive Refresh
  button inside the live region).
- **PRAISE**: P-1…P-5 below.

## Detailed findings

### SF-1 — 400 fixed copy blames a page range the user never chose
`client/src/pages/UploadViewer.tsx:342-344` — `'That page range isn't valid
for this book.'`. The client ALWAYS sends an empty body
(`services/uploads.ts:365-368`), so the only realistic 400 from this button
is the server's "no pages in the requested range — the book may already be
fully extracted, or the range is past the last page"
(`server/src/services/uploadExtract.ts:520-525`, thrown when the resume
default slice starts past the last page). A normal user who has extracted
the whole book taps Extract and is told a range they never entered is
invalid — technically fixed copy, honestly confusing. The server folds both
causes into `code: 'validation_error'`, so the client can't discriminate;
follow the `bookUploadErrorMessage` precedent (`lib/errorCopy.ts:101-111`,
"worded to stay correct for either cause") — e.g. "Nothing left to extract —
this book may already be fully digitised." Fix is copy-only plus the
matching test expectation in `UploadViewer.test.tsx` (the it.each 400 row).

### SF-2 — timeout failure doesn't re-read the run history
`client/src/pages/UploadViewer.tsx:1181-1190` — only the 409 branch calls
`loadRuns()`. If the 5-minute client timeout fires while the server run is
still live (the run continues server-side; header comment at 1154-1157 says
exactly this), the `finally` correctly resets `extracting`, but `runLive` is
computed from a history that was never re-read — so the button re-enables
while a run is genuinely live, and the user's honest-looking retry is doomed
to a 409 (which then heals the state via that branch's `loadRuns()`). Not a
stuck UI — every path recovers in one extra tap — but it's a transient
dishonest enable this design otherwise takes pains to avoid. Call
`loadRuns()` on `err.code === 'timeout'` (or on every failure — it's
best-effort and idempotent) next to the 409 case at 1187.

### SF-3 — `role="status"` strip mounts together with its content
`client/src/pages/UploadViewer.tsx:1354-1358` — the strip renders only when
`latestRun !== null`, so the first run a session ever settles INSERTS the
live region already populated. Most SR/browser pairs only announce
*changes inside* an existing live region, not content present at insertion —
the comment's claim ("the settled result of a just-triggered run is
announced without stealing focus", 1349-1352) is therefore unreliable for
exactly the primary case: a user with no prior runs tapping Extract.
Subsequent settles (strip already mounted, content swaps) announce fine.
Fix: render the strip container unconditionally once `canView` (empty
content when `latestRun === null`) so the region pre-exists its first
update. Mitigating: the same mount-with-content pattern is app-wide
(`km-grammar__state` loading blocks), so this is a convention-level gap, not
a regression introduced here.

### N-1 — hour-scale retry hint rendered as raw seconds
`client/src/pages/UploadViewer.tsx:338-340` — `Try again in about 3600
seconds` is the realistic daily-cap hint. Consistent with
`errorCopy.ts:46`'s existing pattern, so app-conventional — but for a DAILY
cap the number is hours-scale and reads poorly; consider humanizing
(minutes/hours) here or, better, once in a shared helper.

### N-2 — dead `retryAfter` parameter in the error-path test table
`client/src/pages/UploadViewer.test.tsx` (it.each rows around the "%s from
the trigger" test) — every row passes `undefined` for `retryAfter`, and the
spread `...(retryAfter !== undefined ? { retryAfter } : {})` is never
exercised by the table (the hint case has its own separate test). Drop the
column or fold the hint case into the table.

### N-3 — `doneRunCopy(latestRun)` computed twice per render
`client/src/pages/UploadViewer.tsx:1361-1364` — `.en` and `.kr` each call
the builder. Trivial cost; compute once into a local for cleanliness.

### N-4 — interactive control inside the live region
`client/src/pages/UploadViewer.tsx:1385-1392` — the "Refresh status" button
lives inside the `role="status"` element; legal, but region updates can
re-announce the button's text noisily on some SRs. Consider placing it as a
sibling of the region.

### P-1 — wire mapping and its enforcement
`services/uploads.ts:288-333` types the wire explicitly and
`toExtractionRun` drops `upload_id` + `error`; `uploads.test.ts` pins the
drop with `not.toHaveProperty` assertions AND feeds a poisoned
`error: 'server prose that must never surface'` fixture. This is exactly how
a fixed-copy boundary should be held.

### P-2 — error-path tests are genuinely behavioral
Every 4xx test asserts the right fixed copy AND that the server prose never
renders; the 409 test verifies the full recovery sequence (message → second
`listExtractions` call → live-run strip → honestly disabled trigger). The
in-flight test uses a deferred promise to assert the disabled/`aria-busy`
state mid-POST, then the settled counts. No tautologies found.

### P-3 — NIT-A mutation-verified in both pages
Reverting `if (groups.length === 0 && !truncated)` to the old
`groups.length === 0` in BOTH `ReviewVocab.tsx` and `ReviewGrammar.tsx`
fails exactly the two degenerate-case tests (2 failed / 75 passed). The fix
and its pins are real.

### P-4 — settled-state discipline
`extract()`'s `finally` guard, per-call AbortControllers with
`signal.aborted` checks before every state write, unmount aborts for both
the POST and the history GET, and the best-effort posture on a failed
history read (trigger stays usable, server re-fences) — the "can't leave the
UI stuck" bar is met by construction, not luck.

### P-5 — faithful vocab mirror
`GrammarSavedFromUploads` reproduces the vocab twin's structure, honest
states, key scheme, ARIA, CSS naming, and truncation copy line-for-line
where it should, diverging only where the data model differs
(`pattern`/`summary` non-nullable vs vocab's `korean ?? ''`). Easy to
maintain as a pair.

## Coordination observations (for the server-half reviewer / aggregator)

1. **Wire contract verified field-for-field**: client
   `GrammarSavedFromUploadsResponse` (`types/domain.ts:1046-1076`) matches
   the new `GET /grammar/saved-from-uploads` route's emitted shape
   (`server/src/routes/grammar.ts:374-508`): `groups[].upload.{id,title}`,
   `entries[].{id,pattern,summary,savedAt}` (camelCase, ISO string), `total`
   number, `truncated` boolean. No mapping layer needed client-side —
   correct, since the server already emits domain shape here (unlike the
   snake_case uploads routes).
2. **SF-1 has a clean server-side assist**: if the extract route ever
   distinguishes "nothing left to extract" with its own error `code`
   (currently folded into `validation_error`,
   `uploadExtract.ts:520-525`), the client could give exact copy instead of
   either/or wording. Not required for the copy fix.
3. **Gates re-run in this review**: `tsc -p tsconfig.app.json --noEmit`
   clean, `eslint .` clean, `vitest run` on the 5 touched files → 207/207.
   `vite build` was NOT re-verified here (BUILD doc claims success).
4. **Client `total` field** is carried in the envelope but unused by the UI
   (only `groups` + `truncated` render). Fine as a pass-through contract;
   noting so nobody flags it as dead independently.
