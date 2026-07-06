# Fix report — F-013 word mastery

Dispositions for the two reviews (`REVIEW_F013_BACKEND.md`, `REVIEW_F013_FRONTEND.md`).

## Frontend

| Finding | Sev | Disposition |
|---|---|---|
| `color: var(--ink)` for bucket-count text + active-chip cue — `--ink` is a *surface* token (~1.1:1 contrast); counts unreadable | **BLOCKER** | **FIXED** — changed to `var(--paper)` (the text-ink token used across the page, e.g. `.km-progress__readout-value`). `Progress.css`. |
| Double-fetch per bucket tap (offset-reset in its own effect) | SHOULD-FIX | **FIXED** — offset reset folded into a `selectBucket` handler; the separate effect is gone, so one tap = one fetch. |
| Dead/redundant `ctrlRef` | SHOULD-FIX | **FIXED** — removed; the effect cleanup already aborts the in-flight request on re-run/unmount. |
| Error state wipes previously-good data | SHOULD-FIX | **FIXED** — the full `ErrorCard` shows only when `page === null` (first load). A refetch failure keeps the last data and shows a subtle inline "couldn't refresh — showing the last loaded mastery · Retry" (`role="alert"`), matching the sibling history block's graceful degradation. |
| Thin test coverage (no error/retry, toggle-off, pager) | SHOULD-FIX | **FIXED** — added 3 client tests: error→retry recovery, bucket toggle-off (back to all), pager forward (offset advances). |
| Reuse `useEndpointOrMock` instead of hand-rolled fetch | SHOULD-FIX | **REJECTED (documented)** — that hook mandates a `mockFn` and falls back to it on failure. Mastery is real-progress data; showing fake mastery numbers on a failed fetch would misrepresent the user's progress. Kept the real-data-only fetch; rationale added as a code comment. |

## Backend

| Finding | Sev | Disposition |
|---|---|---|
| No test pins the `stability = 21` mature boundary | SHOULD-FIX | **FIXED** — added a test: stability 21 → `mastered`, 20.9 → `reviewing`. |
| No test proves a non-vocab card (`vocab_entry_id NULL`) is excluded | SHOULD-FIX | **FIXED** — added a test seeding a topik card (topik_item_id set) and asserting `summary.total` / `words` count only the vocab card. |
| NITs / PRAISE | — | Left as-is (praise items untouched). |

## Verification
- Server `vocab.test.ts`: **72 passed** (incl. boundary + NULL-exclusion).
- Client `Progress.test.tsx`: **14 passed** (incl. error/retry, toggle-off, pager); full client suite green; typecheck + build clean.
- 0 BLOCKERs remain.
