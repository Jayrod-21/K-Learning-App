# REVIEW — F-016 in-chat dictionary lookup (commit 7cc2c1c, branch feat/f016-chat-dictionary)

Reviewer: independent senior (client correctness probe). No code edits made.
Verified in Docker (node:20-slim): `tsc --noEmit` TC=0, `eslint .` LINT=0, `vitest run src/pages/Chat.test.tsx` 25/25 pass.

## VERDICT: PASS-WITH-CONDITIONS

0 BLOCKER, 3 SHOULD-FIX (all test-adequacy — product code itself is defect-free), 4 NIT.
Conditions = the three test gaps below; feature is safe to merge as-is for a single-user app, but the advertised invariants (abort-guard, rollback) are currently unprotected by the suite.

## Probe answers (the hard questions)

**(a) Set-state-after-unmount / after-abort: NO path exists.**
- `lookupWord` (Chat.tsx:669) captures its own local `ctrl`; both continuations guard on `ctrl.signal.aborted` (Chat.tsx:689, :705) — the LOCAL controller, not the ref, so no TOCTOU when a newer lookup replaces the ref (the old ctrl was aborted first at :672, old continuation returns).
- Unmount: cleanup-only effect aborts `dictCtrlRef.current` (Chat.tsx:647-651). No setState in the effect body — no `react-hooks/set-state-in-effect` hit; ref read in cleanup is legal — no `react-hooks/refs` hit. Lint confirms 0 errors.
- Close: `closeDictPopover` (Chat.tsx:725-729) aborts + nulls the ref + clears pop/loading synchronously.
- `code === 'canceled'` swallowed (Chat.tsx:706 lookup; :775 bank) — second layer under the aborted-guard.
- No stale closure over the controller: new lookup aborts the prior via `dictCtrlRef.current?.abort()` (:672) — ref read at call time, never a captured stale ctrl.

**(b) Fabricated / sentinel gloss reaching UI or bank: NO.**
- 200-with-empty-entries → popover closed (`setDictPop(null)`) + fixed `DICT_NO_ENTRY_COPY` (Chat.tsx:691-695). Legacy 404 → same fixed copy (:710-713). Nothing invented.
- `buildWordPopover` is only called when `entries.length > 0`, so `GLOSS_UNAVAILABLE` is unreachable in this flow (tapChain.ts:199-202 falls to `GLOSS_DICTIONARY_ENTRY` only when an entry exists but has no English — a real entry, app-wide sentinel convention, not fabrication).
- Bank filter: `handleDictAdd` excludes `GLOSS_DICTIONARY_ENTRY` / `GLOSS_UNAVAILABLE` from the `english` field (Chat.tsx:762-765) — a sentinel can never persist as a word's English. Same shared consts as tapChain (B-002 SF-1 contract).

**(c) Raw server prose reaching DOM: NO.**
- 404 → fixed copy; 503 `krdict_unavailable` → fixed `DICT_UNAVAILABLE_COPY` (Chat.tsx:716-717); everything else → `errorMessageFor(err, DICT_FAILED_COPY)` (:718) — errorCopy.ts returns only author-controlled strings + the numeric `retryAfter`. Bank-failure toast is fixed copy (:781). `err.message` is never rendered anywhere in the new code.
- Tests assert ABSENCE of server prose (`not.toHaveTextContent('KRDICT tables missing')` Chat.test.tsx:693-717; `not.toHaveTextContent('ECONNREFUSED')` :718-741) — non-vacuous; a mutation that echoes `err.message` fails both.

## Findings

### SHOULD-FIX (test adequacy)

**SF-1 — Aborted-continuation guard never exercised.** Chat.test.tsx:760-793 assert `signal.aborted === true` after unmount/close but never resolve/reject the captured promise AFTERWARD. Deleting `if (ctrl.signal.aborted) return;` (Chat.tsx:689 or :705) survives the whole suite — the mutation the abort tests exist to kill. (Prod has a second layer — real axios rejects ERR_CANCELED → 'canceled' swallow — but the resolve-after-abort path, e.g. close then late success, has exactly one guard, untested.) Fix: in the close test, after asserting aborted, `act(() => defineCalls[0].resolve(ENTRY_RESULT))` → assert no dialog reappears.

**SF-2 — Newer-lookup-aborts-prior untested.** No test fires lookup A then lookup B and asserts `defineCalls[0].signal.aborted === true` + only B's result paints. Removing the abort at Chat.tsx:672 survives the suite.

**SF-3 — Add-to-bank failure path + sentinel filter untested in Chat.** The `mineWord` mock (Chat.test.tsx:189-195) always resolves; rollback (`dictMined` delete), fixed-copy toast, and the re-throw that resets WordPopover's "Added" button (Chat.tsx:774-783) are unexercised — deleting the rollback block survives. Likewise no fixture with `definition_english: null`, so the sentinel filter (:762-765) is mutation-unprotected. Ttmik's own tests cover Ttmik's copy, but this is a second copy of the code. Add: one rejecting-mineWord test (assert toast + button back to "Add to vocab" + no `english: 'Dictionary entry'` in a follow-up payload).

### NIT

**N-1 — Result landing while dict row is toggled closed is silent.** `toggleDict` (Chat.tsx:653) doesn't abort; if the user closes the row mid-flight and the lookup returns no-entry/error, the notice is set but unrendered (notice lives inside the `dictOpen` conditional, Chat.tsx:889+) and the loading popover vanishes with no feedback. Edge-case UX; reopen clears the notice so nothing stale ever shows.

**N-2 — `aria-controls="chat-dict-row"` (Chat.tsx:884) references an unmounted node when collapsed.** Common React pattern, but strict ARIA validators flag dangling idrefs. Alternative: keep the row mounted + `hidden`.

**N-3 — Enter bypasses the `dictLoading` disable.** The search Button is `disabled={!dictInput.trim() || dictLoading}` but `onDictKeyDown` has no `dictLoading` check — Enter during a pending lookup aborts + restarts. Harmless (abort semantics are correct) but inconsistent with the button affordance.

**N-4 — Close-canceled bank leaves the optimistic `dictMined` flip in place** (word reads "already banked" on re-lookup without having persisted). Verbatim Ttmik/Reading contract ("close-aborted request is swallowed"), documented, `mineWord` is idempotent server-side — pre-existing app-wide behavior, not a divergence introduced here.

### PRAISE

**P-1 — Ttmik parity is verbatim.** `handleDictAdd` (Chat.tsx:744-785) matches Ttmik.tsx:673-716 line-for-line: same payload shape (lemma/english/pos/krdictEntryId with identical sentinel + 'word'-POS filters), same optimistic Set flip, same rollback-only-if-present, same fixed-copy toast, same re-throw for WordPopover's button rollback, same controller-reuse-so-close-cancels-bank. Payload asserted exactly in Chat.test.tsx:794-825 (`toEqual({ lemma: '사전', english: 'dictionary', pos: 'noun', krdictEntryId: 77 })`) — non-vacuous.

**P-2 — define→popover mapping cannot crash WordPopover.** `buildWordPopover` (tapChain.ts:177-218) always returns the four required fields `kr`/`en`/`ex_kr`/`ex_en` (fallbacks `?? lemma`, `?? ''`); `krdictEntryId` present exactly when an entry exists — matching WordPopover's optional contract (WordPopover.tsx:49-81). Skipping lemmatize/enrich for a typed headword is the right call (documented in the file header).

**P-3 — Fixed-copy tests are mutation-resistant** (absence assertions, not just presence — see (c) above), and the no-entry test asserts `queryByRole('dialog')` absent, so a fabricated-gloss mutation that opens a popover fails it.

**P-4 — Send flow untouched, verified.** The diff only adds the book Button inside the composer row + the dict row + the popover mount; no existing send/hint/F-020-seed line modified. "leaves the send flow untouched" test (Chat.test.tsx:826+) asserts streamCalls fire and defineCalls stay 0 with the dict row open; all 15 pre-existing tests (incl. F-020 seed suite) still pass.

**P-5 — a11y complete.** Toggle: `aria-label="Dictionary lookup"` + `aria-expanded={dictOpen}` + `aria-controls` (Chat.tsx:878-887; Button spreads `...rest` so all three reach the DOM). Input: `<label htmlFor>` + `aria-label` (:892-911). Search button: `aria-label` + `aria-busy`. Notice: `role="alert"` for errors, `role="status"` for no-entry (:924) — correct severity split.

## Test-count check
10 new F-016 tests as claimed (Chat.test.tsx:631-847): lookup+render, Enter submit, no-entry, krdict_unavailable, network, empty no-op, unmount abort, close abort, add-to-bank payload, send-flow untouched. Suite 25/25.
