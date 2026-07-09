# U3b Client Review — chapter reader (`feat/u3b-chapter-reader`)

Reviewer: independent senior frontend pass, no prior context on this branch.

## Summary verdict

**Conditional pass — one BLOCKER, two SHOULD-FIX.** The `useTapWord` extraction is a
careful, faithful lift of Ttmik's tap-handler machine and is safe (abort discipline,
no ref-write-in-render, no stale-closure risk). `Reading.tsx`'s three-level
drill-down correctly handles loading/error/empty at every level and matches app
conventions throughout. The one real defect is that `ChapterReader`'s "Add to bank"
handler drops the `AbortSignal` that Ttmik's equivalent deliberately wires through
`mineWord`, breaking the "closing the popover cancels the bank request too" contract
this file's own header claims to preserve. Test coverage is real but incomplete —
the chapter-reader level (the actual net-new tap-to-define surface) has zero tests;
only the book/chapter pickers are covered.

- BLOCKER: 1
- SHOULD-FIX: 3
- NIT: 3
- PRAISE: 4

## Findings by category

### BLOCKER
1. `ChapterReader.handleAdd` calls `mineWord(...)` with no `AbortSignal` —
   `client/src/pages/Reading.tsx:563-572` — breaks the abort-on-close contract
   Ttmik established and this file's own header claims to match.

### SHOULD-FIX
1. Same finding as above, restated for the test-coverage angle: no test exercises
   the abort/rollback race this creates.
2. `ChapterReader` (level 3 — the actual net-new tap-to-define surface) has zero
   test coverage — `client/src/pages/Reading.test.tsx` never invokes
   `readingSvc.getChapter`, despite mocking it.
3. `BookPicker` and `ChapterPicker`'s fetch-error branches (`ErrorCard` + retry)
   are untested, despite being one of the three explicitly-required states per
   the review brief.

### NIT
1. `PassageBody` splits on `'\n'` only — a `\r\n`-sourced OCR passage would leave
   a trailing `\r` glued to each line's last token. `client/src/pages/Reading.tsx:480`.
2. `ChapterReader.handleAdd` (Reading.tsx) vs `DetailView.handleAdd` (Ttmik.tsx)
   duplicate ~30 lines of identical mine-payload-building logic; both already
   note the tap-handler dedup is deferred to U3c — the mine-payload builder could
   ride along in the same follow-up.
3. `ChapterPicker`'s "View original scan" button appears above the loading
   spinner / error card (Reading.tsx:346-357), so it's clickable before the
   chapters have loaded or even if they error — harmless (it navigates to a
   different, self-sufficient screen) but slightly inconsistent with the
   loading-gates-interaction pattern elsewhere.

### PRAISE (fix-pass must not undo)
1. `useTapWord`'s `isMinedRef` — written from an unconditional `useEffect`, never
   from the render body — is the correct fix for what would otherwise be a
   ref-write-in-render violation, and it's explicitly documented as such.
   `client/src/hooks/useTapWord.ts:63-72`.
2. `PassageBody`'s manual `\n`-split-then-`<br/>`-reinsert, with each line tapped
   against its own text as the "source sentence," correctly works around
   `tokeniseKorean`'s whitespace-collapsing behavior — a real bug in a naive
   port that was caught and documented. `client/src/pages/Reading.tsx:462-494`.
3. The abort discipline on all three GET-fetching effects (`BookPicker`,
   `ChapterPicker`, `ChapterReader`) is uniform and correct: abort-on-mount-race,
   check `ctrl.signal.aborted` before every post-await `setState`, abort on
   unmount, and swallow `ApiError.code === 'canceled'` rather than surfacing it
   as a user-facing error. Matches `Ttmik.tsx` and `UploadViewer.tsx` exactly.
4. `key={selectedChapterId}` / `key={selectedBook.id}` on the level-2/level-3
   components force a full remount (and therefore a fresh `useTapWord` instance
   and reset `minedIds`) on every book/chapter change — simpler and more robust
   than trying to reset in-place via extra effect dependencies.

## Detailed findings

### 1. BLOCKER — `mineWord` called without an `AbortSignal` in `ChapterReader`

`client/src/pages/Reading.tsx:554-589` (the `handleAdd` passed to `WordPopover`
via `onAdd`), specifically the call at `Reading.tsx:563`:

```ts
return mineWord({
  lemma,
  ...
}).then( ... )
```

Compare `Ttmik.tsx:714-757`'s `handleAdd`, which deliberately does:

```ts
// Reuse the popover-scoped controller so a popover close cancels the
// bank too; fall back to a fresh one if the chain already cleared it.
const ctrl = inFlightCtrlRef.current ?? new AbortController();
inFlightCtrlRef.current = ctrl;

return mineWord({ ... }, ctrl.signal).then(...)
```

Ttmik's version reuses the tap-chain's own `AbortController` so that closing the
popover (`handleClosePopover` → `inFlightCtrlRef.current?.abort()`) also cancels
any in-flight "Add to bank" POST. That's what makes the `if (err instanceof
ApiError && err.code === 'canceled') return;` guard in the catch meaningful: a
close-triggered failure is swallowed before it reaches `setMinedIds`/`toast`, and
critically before it re-throws into the promise `WordPopover.handleAdd` is
awaiting (`components/WordPopover.tsx:139-144`), which would otherwise call
`setAdded(false)` on the (by-then unmounted) popover.

In `ChapterReader.handleAdd`, no signal is threaded at all, so:
- Closing the popover does not cancel the bank request — it keeps running
  server-side and client-side after the popover (and its `useTapWord` popover
  data) is gone.
- If that un-cancelable request later fails for a **real** reason (not abort —
  network drop, 500, rate limit), the `canceled` guard doesn't fire, so
  `setMinedIds`/`toast` run (harmless — `ChapterReader` may still be mounted or
  `toast`'s provider is a parent), but the re-thrown error also reaches
  `WordPopover`'s already-unmounted `.then(undefined, () => setAdded(false))`,
  calling a state setter on an unmounted component. React 18 no-ops this
  silently rather than crashing, so the user-visible blast radius is small, but
  it is a genuine deviation from the documented, deliberate pattern this file's
  own module header claims to follow ("'Add to bank' reuses
  `services/vocab.mineWord` with the same optimistic-flip + rollback +
  fixed-copy-toast contract `Ttmik.tsx`'s `DetailView` uses" —
  `Reading.tsx:26-31`). The header's claim is not accurate as written.

Fix: reuse the same `inFlightCtrlRef` from `useTapWord`'s scope, or (since
`useTapWord` intentionally doesn't expose its internal ref — see the hook's
own scope note) give `ChapterReader` its own `AbortController` ref for the
add path and abort it from `onClose`'s call site, mirroring Ttmik exactly.

### 2. SHOULD-FIX — `ChapterReader` has zero test coverage

`client/src/pages/Reading.test.tsx` mocks `readingSvc.getChapter` (line 22) but
never calls it in any test — no test opens a chapter, so the entire tap-to-define
integration (`useTapWord` + `Tapword` + `WordPopover` + `PassageBody`'s
newline-preservation + the mine-to-bank flow) is unexercised. This is the actual
**net-new core** the design doc calls out (`db/docs/U3_READER_DESIGN.md` §U3b:
"the new reader consumes it"), and it's the one place `useTapWord`'s integration
with a live page can be checked without needing real OCR content — the mock data
(`readingSvc.getChapter.mockResolvedValue(...)`) can supply any passage body,
independent of the "no throwaway fixture" rule (which is about DB seed data /
real corpus, not unit-test mocks — see design doc "Content / test data"). At
minimum this should cover: opening a chapter renders its passages, tapping a
word opens `WordPopover` with a loading state then resolves, and an empty
`passages: []` chapter shows "No passages yet."

### 3. SHOULD-FIX — Fetch-error states untested for `BookPicker` / `ChapterPicker`

The review brief's criterion 2 explicitly asks about "fetch error → error card,
not a crash" for all three levels. `Reading.test.tsx` covers only the empty-list
and happy-path chapter-list states; no test makes `listUploads` or `listChapters`
reject to confirm the `ErrorCard` + retry path renders (`Reading.tsx:225-227`,
`Reading.tsx:363-364`). The retry button's wiring to `refetch`/`reloadTick` is
therefore also unverified.

### 4. NIT — `\r\n` not stripped before `PassageBody`'s newline split

`client/src/pages/Reading.tsx:480`: `body.split('\n')`. If a passage's `body`
was OCR'd/curated with Windows line endings, each line (except the last) will
retain a trailing `\r`, which is invisible but would ride along as part of the
last token's tap target / sentence text passed to `onTapWord`. Low-severity —
depends entirely on the loader's normalization, which is out of this review's
scope (`tools/ingest/loaders/load_literature.py`) — but a defensive `.replace(/\r\n/g, '\n')` here would make `Reading.tsx` robust regardless of what the
loader does.

### 5. NIT — Duplicated mine-payload construction

`Reading.tsx:564-571` and `Ttmik.tsx:730-737` build the identical
`{ lemma, ...(en...), ...(pos...), ...(krdictEntryId...) }` payload shape
byte-for-byte. Both files already note the tap-handler-machine dedup is
deferred to U3c (per the design doc); worth folding this small payload-builder
into that same follow-up rather than opening a third copy-paste site.

### 6. NIT — "View original scan" button not gated on load state

`client/src/pages/Reading.tsx:346-357` (`ChapterPicker`) renders the "View
original scan" button above the loading/error/empty branch, so it's clickable
immediately, before chapters have loaded or even if the chapter fetch errors.
Not a bug (the button navigates to `/uploads/:id`, a self-sufficient screen
with its own load state), just a minor inconsistency with the rest of the app's
tendency to gate secondary actions behind a resolved load state.

## Coordination observations

- The server contract match is exact: `services/reading.ts`'s wire interfaces
  (`ChapterListRowWire`, `ChapterWire`, `PassageWire`) field-for-field match
  `server/src/routes/reading.ts`'s response shapes, including the
  BIGINT-as-JSON-number convention this route uses (unlike `services/uploads.ts`,
  which keeps ids as wire strings) — correctly called out in both files' headers.
- The new `/reading` top-level prefix was correctly added to **both**
  `Deploy/nginx-blue-active.conf` and `Deploy/nginx-green-active.conf`'s
  API allow-list regex (confirmed via `git diff`), avoiding the exact
  SPA-shadowing pitfall the project's own history flags for new API prefixes
  (`km-nginx-api-route-allowlist` / the U1 `/uploads` lesson). `server/src/app.ts`'s
  route registration comment cross-references the same requirement.
- `types/domain.ts`'s new `ReadingChapterSummary` / `ReadingChapter` /
  `ReadingPassage` types are additive-only and correctly documented as a
  numeric-id exception to `BookUpload`'s wire-string-id convention.
- `lib/nav.ts`'s diff is exactly the eyebrow-copy change the task description
  promised — no unrelated changes.
- No `dangerouslySetInnerHTML`, no hardcoded colors/fonts outside the existing
  `km-*` class vocabulary and `var(--paper-dim)`-style tokens; `Bilingual`,
  `Button`, `Card`, `Icon`, `Eyebrow`, `Topbar` are all reused as-is, no new UI
  primitives invented.
