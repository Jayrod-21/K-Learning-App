# Review — F-007 Resume-in-progress TOPIK mock: client service + MockMode orchestration

**Commit:** `983fa09` — feat(topik): resume an in-progress TOPIK mock test (F-007)
**Reviewer:** Independent senior engineer (did not author this code)
**Slice under review:**
- `client/src/services/topik.ts` — `fetchMockTest` 3rd-arg change; `AttemptState` / `AttemptSaveBody`; `fetchAttempt` / `saveAttempt` / `clearAttempt`.
- `client/src/pages/topik/MockMode.tsx` — MockMode PARENT orchestration only (resume state, mount fetch, `handleSaveProgress`, `resumeAttempt`, `ResumeBanner`, `startSection` / `newMock` / render). ExamRunner internals belong to another reviewer; touched here only where they interface with the save/hydrate contract.

> **Note on the brief:** `SENIOR_ENGINEER_BAR.md` does not exist at the repo root (or anywhere tracked). I reviewed against the standing quality bar recorded in the project memory (senior-engineer level; robust-by-default; distrust API schemas looser than the DB constraint behind them; test with real data). If a specific bar doc is expected, point me at it and I will re-check against it.

---

## Summary verdict

**APPROVE with follow-ups. 0 BLOCKERS.**

This is careful, well-reasoned work. The single highest-risk item flagged in the brief — the picks **string↔number key round-trip on resume** — is **correct**: it round-trips losslessly and matches the numeric key ExamRunner reads. Abort/race handling, fire-and-forget hygiene (`void` + `.catch`), the submitted-guard against a resurrecting save, and the unit conversions are all sound. Findings are 1 SHOULD-FIX (a low-severity, well-mitigated save-ordering race) plus several NITs (silent resume failure, a stale-state smell on the mount fetch, timer-pause-on-close semantics, read-side trust of `picks`). None block approval.

---

## Bar checklist

| Criterion | Verdict | Note |
|---|---|---|
| picks Map↔Record key type match on resume | ✅ PASS | `Number(item.id)` keying is uniform; `String(n)`→server `^\d+$`→`Number(k)` round-trips losslessly. See PRAISE-1. |
| remainingMs↔remainingSec unit conversion | ✅ PASS | Integer seconds; `*1000` / `Math.round(/1000)` — exact, no drift. |
| Abort/race: no stale set-state after unmount or newer action | ✅ PASS | Every `.then`/`.catch` guards `ctrl.signal.aborted`; unmount aborts both controllers. One benign stale-state smell (NIT-2). |
| Fire-and-forget: no unhandled rejection | ✅ PASS | `void saveAttempt(...).catch()`; `fetchAttempt(...).then().catch()`. Correct. |
| `void` used correctly | ✅ PASS | `void` binds the whole `.catch`-terminated chain; floating-promise clean. |
| handleSaveProgress sees correct `test` (never null/stale) | ✅ PASS | `test===null` guard + batched `setTest`/`setPhase`; `[test]` dep. See PRAISE-5. |
| Late save cannot resurrect a submitted attempt | ✅ PASS | `submittedRef` guard in `saveProgress`. |
| Resume-fetch failure leaves consistent state (not stuck loading) | ✅ PASS | Resets `net='idle'`, drops banner, stays on select. Silent, though — NIT-1. |
| I/O boundary type safety (`picks` value as ChoiceId) | ⚠️ ACCEPTABLE | Trusted on GET; but constrained on PUT (regex + enum). NIT-6. |
| Dismiss semantics (hide vs delete) | ⚠️ CONFIRM | Session-hide only; server row persists; no UI discard path. NIT-3. |

---

## Findings by severity

### BLOCKER
None.

### SHOULD-FIX

**SF-1 — Saves are fire-and-forget with no sequencing/cancellation; out-of-order delivery can persist a stale picks snapshot.**
`client/src/pages/topik/MockMode.tsx:191` (`handleSaveProgress` → `saveAttempt` **without a signal**), driven by `ExamRunner` `saveProgress` (`MockMode.tsx:735-743`).
Each pick/nav fires an independent PUT carrying the full latest map, none of which is aborted when a newer one starts. If PUT *n* (after pick A) is delivered by the network *after* PUT *n+1* (after pick B), the server's last-write-wins upsert ends on `{A}`, silently dropping pick B until the next save corrects it.
**Why not a BLOCKER:** strongly mitigated — every save sends the *entire* current map (not a delta), and saves also fire every 15 s and on unmount, so any subsequent save re-converges. The realistic exposure is "the single most-recent answer, made right before an abrupt close, is missing on resume" — the user simply re-answers one item.
**Recommendation:** give the save its own dedicated AbortController that aborts the prior in-flight save (mirroring `beginCall`), or attach a monotonic client sequence number the server rejects-if-older. Cheap, and it closes a genuine (if low-probability) data-ordering hole. If accepted as-is, document the last-write-wins-may-reorder assumption at `saveAttempt`.

### NIT

**N-1 — Resume-fetch failure is completely silent.**
`MockMode.tsx:230-236`. On failure the banner disappears and the screen returns to a plain select with no message — the user clicked "Resume" and nothing visibly happened. Not falling back to the offline fixture is *correct* (the fixture wouldn't match the saved picks/index), but a one-line inline notice ("Couldn't reload that test — start a new one") would avoid a dead-click feel.

**N-2 — Mount `fetchAttempt` uses a controller independent of `beginCall`; a slow attempt-fetch can set `resumable` after a fresh Start.**
`MockMode.tsx:170-182`. `startSection` (`:245`) calls `beginCall()`, which aborts `ctrlRef.current` — but the mount fetch's controller is a separate local `ctrl`, so it is **not** aborted. If it resolves after the user has already started a section, `setResumable(attempt)` runs with a now-stale attempt. **Harmless in practice** (the banner only renders in `phase==='select'`, and `newMock` nulls `resumable`), but it's a stale-state smell. Consider aborting the mount fetch when any exam-loading action begins, or ignoring its result once `phase !== 'select'`.

**N-3 — Dismiss (✕) only hides for the session; there is no UI path to permanently discard.**
`MockMode.tsx:382-384` sets `resumable=null` but never calls `clearAttempt`, so the banner reappears on the next page load. This matches the stated design (persist so a later visit can still resume) and `startSection` upsert-replaces on fresh start — but note `clearAttempt` is imported/exported yet **unused by any client component** (verified: only referenced in the service module + tests). Confirm the "dismiss doesn't stick" UX is intended, or wire a real discard action to `clearAttempt`.

**N-4 — No defensive clamp when hydrating `initial.idx`; no NaN guard on the pick keys.**
`MockMode.tsx:216-223` / ExamRunner `useState(initial?.idx ?? 0)`. Both are safe *today* because resume re-fetches the same deterministic exam (so `total` matches) and `TopikMockItem.id` is a numeric-string server row id (so `Number(k)` never yields `NaN`). But there is no guard: if the deterministic exam ever changed size between save and resume, a stale `idx >= total` renders the misleading "This mock test has no items" ErrorCard; and if an `item.id` were ever non-numeric, `Number(id)` → `NaN` would collapse **every** pick onto a single `NaN` Map key (Map uses SameValueZero). Cheap insurance: clamp `idx` to `[0, total-1]` on hydrate and skip non-finite pick keys.

**N-5 — Timer effectively pauses while the app is closed; `remainingSec===0` resumes into an instant auto-submit.**
`MockMode.tsx:222` / ExamRunner `:638-640`. `remainingSec` is restored verbatim, so closing the tab for an hour and resuming continues from the saved value — the "timed" mock is pausable by leaving. That's lenient-by-design for a study app, but worth an explicit product decision. Separately, a saved `remainingSec` of 0 hydrates `remaining=0`, and `0 ?? default` keeps 0, so the auto-submit effect fires immediately on resume (semantically "time's up" — defensible, just note it).

**N-6 — GET `picks` is trusted as `Record<string, ChoiceId>` with no client-side runtime validation.**
`topik.ts` `AttemptState.picks` and `MockMode.tsx:216`. Per the project's "distrust API schemas" standing rule, a cast is not validation. **Mitigated**: the PUT path validates keys `^\d+$` and values `enum(['a','b','c','d'])`, and the server derives `answered` from `Object.keys(row.picks).length`, so the only way to get a non-ChoiceId value is direct DB tampering. Acceptable, but the read-side type safety *depends on* the write-side constraint — worth a one-line comment at `AttemptState.picks` noting that GET is trusted because PUT is constrained.

**N-7 — Two `role="status"` live regions can double-announce.**
The loading `<div role="status">` (`MockMode.tsx:353`) and the `ResumeBanner` `role="status"` (`:496`) are mutually exclusive by the `net !== 'loading'` render guard, so in practice they don't overlap — minor, listed for completeness.

### PRAISE

**P-1 — The picks key round-trip (the flagged high-risk item) is correct and verified end-to-end.**
ExamRunner keys picks uniformly by `Number(item.id)` — at pick (`:834`→`:708`), lookup (`:769-770`), palette (`:932`), time-flush (`:647`,`:701`), and submit indexing (`:1263`). Save serializes `String(number)` (`:190`), the server validates keys against `^\d+$` and stores JSONB, and resume rehydrates via `Number(k)` (`:217`) — landing back on the exact numeric key `picks.get(Number(current.id))` reads. Because `item.id` is a canonical integer decimal string (the server row id, per the DTO and the `MockSubmitAnswer` contract), `Number(String(n)) === n` holds losslessly. The submit path (`buildBody`, `:645-662`) sends the same numeric key, so a resumed exam grades identically to one taken in one sitting. This is the class of bug the brief worried about, and it was handled correctly.

**P-2 — Fire-and-forget hygiene is textbook.**
`void saveAttempt({...}).catch(() => {})` (`:191-199`) attaches the catch to the full chain then discards the promise — no unhandled rejection, no floating-promise lint violation. The mount `fetchAttempt(...).then(...).catch(...)` (`:172-178`) is likewise fully handled.

**P-3 — Abort discipline is consistent.**
Every async continuation guards `ctrl.signal.aborted` before touching state (`:174`, `:213`, `:233`, `:255`, `:262`, `:267`, `:273`). The mount fetch aborts on cleanup (`:179-181`); the shared `ctrlRef` aborts on unmount (`:155-159`) and on each new call via `beginCall` (`:161-166`). No set-state-after-unmount path found.

**P-4 — `submittedRef` guard in `saveProgress` correctly prevents a late save from resurrecting a cleared attempt.**
`MockMode.tsx:735-738` + the unmount flush (`:747-753`). This is the subtle correctness point (submit clears the row server-side; a trailing unmount/interval save must not re-create it) and it is handled. The `stateRef` latest-value mirror (`:721-731`) is the correct React-19 pattern for interval/unmount reads of live state.

**P-5 — No window where `onSave` fires with a null/stale `test`.**
`handleSaveProgress` guards `test===null` (`:188`), ExamRunner only mounts under `phase==='exam' && test!==null` (`:391`), and `resumeAttempt` batches `setTest(real)` with `setPhase('exam')` (`:224-228`) so the child never observes an interim null. `handleSaveProgress`'s `[test]` dep keeps its `sourceTest`/`section` closure current.

**P-6 — Unit conversions are exact.**
`remaining` is integer seconds (interval decrements by 1); `*1000` and `Math.round(remainingMs/1000)` introduce no drift. The banner uses the same `Math.round` so its displayed "left" matches what resume hydrates.

---

## Detailed notes

### Race / lifecycle walkthrough
- **Mount fetch vs Resume:** `resumeAttempt` can only be invoked after the banner renders, which requires the mount fetch to have already resolved and set a non-null `resumable`. So there is no "resume before attempt loaded" race. ✅
- **Resume vs unmount:** unmount aborts `ctrlRef.current` (the resume controller); the resume `.then`/`.catch` both early-return on `aborted`. ✅
- **Double-click Resume:** impossible — `net='loading'` hides the banner+select during the fetch. ✅
- **Start-fresh vs slow mount fetch:** the one real gap (N-2) — benign because the late `setResumable` isn't rendered outside select and is cleared by `newMock`.

### Data-integrity walkthrough (save → DB → resume)
Live map key `= Number(item.id)` → save `String(key)` → server Zod `^\d+$` + `enum` (write-constrained) → JSONB → GET raw → `Number(k)` → `picks.get(Number(current.id))`. Lossless and symmetric. The only unguarded assumptions (numeric id, unchanged exam size) are currently guaranteed by the deterministic re-fetch and the DTO; N-4 recommends cheap defensive guards anyway.

### Test coverage observed
The added MockMode test (`shows a resume banner … Resume re-fetches the same exam by source_test`) asserts the banner appears after the mount fetch and that Resume calls `fetchMockTest('reading', <signal>, 777)`. Good on the wiring. **Gaps worth adding** (not blocking): (a) an assertion that restored picks actually land on the right items after resume (the P-1 round-trip — the exact thing most worth locking in); (b) resume-fetch **failure** clears the banner and does not hang on loading (N-1 path); (c) `saveAttempt` is invoked on pick/nav with `String`-keyed picks. All three exercise real correctness rather than the happy wiring path.
