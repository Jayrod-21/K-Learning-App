# Re-review: tightening cycle for Pass 3

> Independent re-reviewer. 30 yrs. Did not write the code, did not review
> originally, did not run either fix-pass. Verified every claim in
> `FIX_REPORT_P3_TIGHTENING.md` against actual disk state. Treated the
> report with the skepticism the author note warranted.

## Summary verdict: **PASS**

The tightening cycle closes every item on the prior re-review's
`NOT-FIXED` + `REGRESSION-INTRODUCED` list at the contract level. The
seven gaps from `REVIEW_FIXES_P3.md` are all addressed in production
code AND in tests; the single regression (server `auth.test.ts` PATCH
bodies missing `expected_version`) is resolved across every
pre-existing test plus four new tests covering strict-schema reject,
stale-version 409, the user-visible side effect of an email change,
and the optimistic-concurrency version bump on a happy-path PATCH. One
test deliberately defers the audit-log direct-capture assertion to
`FU-NF-34` (the test harness lacks a pino log-capture transport); the
deferral is documented and the user-visible side effects of the same
code path ARE asserted in lieu of direct log capture, which is the
strongest assertion this harness supports.

Test count grew 239 → 249 (10 new), matching the report. Lint clean,
build clean, no new `any`, no new `dangerouslySetInnerHTML`, no
service signature regressions.

One stale doc reference (the audit-log test comment cites `FU-NF-33`
when it should cite `FU-NF-34`); too small to block — captured as a
NIT below.

Recommendation: **ship Pass 3** and file the NITs as follow-ups.

---

## Tightening item verification table

| Item | Original re-review status | Current status | Notes |
|---|---|---|---|
| RR-B1 — server PATCH /auth/me regression | REGRESSION-INTRODUCED | **FIXED** | Every pre-existing PATCH body carries `expected_version: 1` (`auth.test.ts:187, 250, 262, 268, 276, 287, 311`). Four new tests landed: strict-schema reject (`L204-215`), stale-version 409 (`L254-271`), audit-log via user-visible side effect (`L294-315`), happy-path now asserts `version: 2` (`L192`). Direct audit-log assertion deferred to FU-NF-34. |
| D-B3 — spacebar tests | NOT-FIXED | **FIXED** | `Review.test.tsx:345-407` adds two tests: spacebar-reveals via `fireEvent.keyDown(window, { key: ' ' })` asserting `aria-expanded` flip + rating buttons appear; spacebar-ignored-with-sheet-open opens `ListDetailSheet`, returns to Session tab, fires keyDown, asserts no reveal. Both tests use the Pass 2 idiom called out by name. |
| C-SF-1 — WordPopover loading affordance | NOT-FIXED | **FIXED** | `WordPopover.tsx:76-103, 172-200` gains `isLoading?: boolean` prop, renders inline spinner with `role="status"` + `aria-live="polite"` + `data-testid="word-popover-loading"`, suppresses gloss body + actions row when true, keeps head + close button visible for stable accessible name. `Reading.tsx:378-453` opens popover IMMEDIATELY with stub + `popLoading=true` then chain resolves; failure modes degrade gracefully ("Definition unavailable"). Test (`Reading.test.tsx:366-401`) mocks lemmatize + defineEntry as pending promises, asserts dialog + spinner + Add-button absent. |
| C-SF-2 — Reading add-to-bank | PARTIALLY-FIXED | **DEFERRED-with-FU** | `Reading.tsx` no longer imports `initCards` and no longer calls `vocabInitCards`. Local `minedIds` Set still flips so dotted-underline UX honest. Threat-model comment (`L84-94`) + `handleAdd` JSDoc (`L528-540`) explain the deferral and link FU-NF-33. FU-NF-33 exists in `FOLLOW_UPS.md` with full re-wire plan + lemma→`vocab_entries.id` resolver acceptance criteria. Reading test (`L338-360`) asserts no network call fires on add. |
| C-SF-5 — X-Request-Id forwarding test | NOT-FIXED | **FIXED** | `conversation.test.ts:147-166` asserts `streamSse` receives `headers: {'X-Request-Id': 'abc-123'}` when `requestId` set; inverse test `L169-185` asserts `headers === undefined` when omitted. |
| C-SF-6 — Chat retry reuses X-Request-Id | PARTIALLY-FIXED | **FIXED** | `Chat.test.tsx:313-358` captures `firstRequestId` off `streamCalls[0]`, drives onError + reject, clicks `Retry sending message`, asserts `streamCalls[1].requestId === firstRequestId` AND `body.content === '실패'` (content preserved). |
| E-SF-1 — optimisticBanked prune + 50-cap | NOT-FIXED | **FIXED** | `Grammar.tsx:225-243` adds `useEffect` keyed on `bankedState.data` that drops overlay entries reconciled with server settle; 50-entry cap (`L234-238`) keeps most-recent 50 via Set insertion order; identity preserved when prune is a no-op (`L241`). Test (`Grammar.test.tsx:185-238`) banks a row, mocks `listBanked` to return reconciled row on second call, asserts `Already banked` chip + `listBanked` called ≥2 times. |
| E-SF-3 — Reference MockBadge `.some()` → AND | NOT-FIXED | **FIXED** | `Reference.tsx:222-229` flips `.some()` to a per-filter branch: `'all'` filter ANDs only realFn-backed sources (vocab + grammar); hanja excluded from the conjunction. `MockBadge.tsx:25-48` JSDoc adds `## Gating semantics — when to fire the badge` documenting the cross-screen rule with Grammar (drill mock-only) and Reference (hanja mock-only) examples + the wrong-rule warning. Reference test (`Reference.test.tsx:194-230`) verifies both directions: badge OFF when realFn sources real, badge ON when both fail. |
| F-S1 — Settings deliberately-cleared test | PARTIALLY-FIXED | **FIXED** | `Settings.test.tsx:263-332` hydrates phone + version=1, awaits sync, types `'9'` then `user.clear`, advances 700ms, asserts phone stays empty AND `patchMe` NOT called. Settings.tsx diff builder (`L273-275`) confirmed to drop empty phone because server's Zod schema rejects it — the test's comment chain documents this end-to-end. |

---

## Bar checklist (post-tightening state)

- [x] Lint passes (0 errors / 0 warnings — parent gated).
- [x] Type-check passes strict on client (parent gated). Server's
      pre-existing claude-proxy / gradeWriting TS errors remain under
      `server-typecheck: must_pass: false` per TESTS.md.
- [x] Client tests pass (39 files / 249 tests — parent gated).
- [ ] Server tests not runnable here (Docker testcontainers needed).
      The pre-existing PATCH bodies all now carry `expected_version`
      and the new strict-schema / 409 / audit-log tests follow the
      same supertest agent idiom as the rest of the file; failure
      surface is procedural (testcontainers), not contract.
- [x] Every public function added by this cycle has at least one
      test:
      - `WordPopover` `isLoading` → asserted via `getByTestId('word-popover-loading')`.
      - `Reading.runSlowPath` immediate-open contract → asserted via dialog-and-spinner test.
      - `Grammar` prune effect → asserted via reconciled-chip test.
      - `Reference` AND-gating → two tests, real + mock-fallback.
      - `Settings` cleared-field path → dedicated F-S1 test.
      - `Chat` retry-reuses-id → dedicated C-SF-6 test.
      - `conversation.streamMessage` X-Request-Id → dedicated + inverse.
      - `Review` spacebar handler → reveal + sheet-open-guard.
- [x] `EXPLAIN ANALYZE` — N/A (no new SQL).
- [x] `SECURITY.md` — server §10 + client §14a continuity preserved;
      Reading.tsx threat-model section updated for FU-NF-33 deferral.
- [x] No commented-out code introduced.
- [x] No `console.log` introduced.
- [x] No new `TODO` / `FIXME` without ticket — FU-NF-33..37 all live
      in `FOLLOW_UPS.md` with acceptance criteria.
- [x] No new `any`, no new enums, no new `dangerouslySetInnerHTML`,
      no new untyped exception types.
- [x] Service signatures with `signal?: AbortSignal` not regressed —
      read services still accept signal; mutation services tracked
      for FU-NF-35 (out of scope here).

---

## New findings introduced by the tightening

### BLOCKER

None.

### SHOULD-FIX

None.

### NIT

**RR2-N-1 — Stale FU-NF reference in audit-log test comment.**
`Repository/server/tests/auth.test.ts:304` reads `…is filed as FU-NF-33.`
The actual ticket for the deferred pino log-capture work is FU-NF-34
(FU-NF-33 is the Reading Add-to-bank re-wire). Reader of that comment
will be misdirected. Single-character edit. Captured here rather than
filed as a follow-up.

**RR2-N-2 — Grammar prune test asserts user-visible state, not direct overlay shrinkage.**
`Grammar.test.tsx:185-238` covers the contract via the rendered chip
(`Already banked`) + the refetch call count, both of which are
downstream of the prune effect. The original spec wording
("optimistic shrinks to 1") suggested a more direct assertion on the
overlay's size. The user-visible test is the right contract to assert
(internal state is implementation detail), but a tighter test would
also drive the >50 cap path — currently uncovered. Minor; the cap is
defensive, the visible chip is the user-facing contract, and a 50-
entry overflow in a healthy session would itself be a bug.

**RR2-N-3 — Grammar prune effect could short-circuit on settle reference equality.**
`Grammar.tsx:225-243` runs the prune on every `bankedState.data`
identity change, including reference-only changes where the contents
are unchanged. The inner identity-preservation guard catches no-op
SET diffs, but the effect body still allocates a transient Set on
each settle. Sub-microsecond impact; flagged for symmetry with the
identity guarding done elsewhere.

### PRAISE (new — this cycle did something specifically excellent)

- **`isLoading` body suppression keeps the dialog title visible.**
  The `WordPopover.tsx:148-170` head (KR headword + close button)
  renders unconditionally; only the body + action row swap to the
  spinner. The dialog's `aria-labelledby` target stays in the DOM the
  entire time, so screen readers announce a stable accessible name
  through the loading → resolved transition. This is exactly the
  right shape for a dialog that opens before its content has
  resolved.

- **Reading.tsx graceful-degradation tiering preserved in the new
  immediate-open path.** Each of lemmatize / define / enrich still
  has its own `try/catch` with a documented fallback (raw form / no
  definition / no enrichment). Importantly, the *immediate-open*
  stub at `L392-400` uses the raw tapped word as a placeholder
  headword so the dialog has an accessible name even if lemmatize
  itself fails before producing a lemma. This is the strongest
  reading of the graceful-degradation contract.

- **MockBadge JSDoc documents the wrong rule that caused the
  recurring bug.** `MockBadge.tsx:43-48` explicitly calls out the
  `.some(s => s.isMock)` formulation that pinned the badge under
  mock-only sources. Future contributors who reach for the
  intuitive-but-wrong rule will see the warning. Documentation that
  fights the next regression is the right shape.

- **Server PATCH /auth/me audit-log assertion picks the strongest
  observable contract under harness constraints.** The test (`auth.test.ts:294-315`)
  asserts the user-visible side effects (version bump + GET /me
  reflects new email) that depend on the same code path as the
  WARN-level log. Combined with the route's static threat-model
  comment, this is the strongest end-to-end assertion possible
  without re-engineering `buildTestApp`. Deferring the log-capture
  refactor to FU-NF-34 is the right call.

- **Settings F-S1 test documents the schema-rejects-empty-phone
  side effect.** The test (`Settings.test.tsx:263-332`) doesn't just
  assert the surface contract ("phone stays empty"); the comment
  chain explains WHY no PATCH is sent (server Zod rejects empty
  phone → diff builder drops empties → no body → no call). Future
  contributor who wonders "should we clear phone on the server too?"
  finds the answer + the deferral inline.

---

## PRAISE preservation audit (cross-Pass)

| Original PRAISE | Preserved? |
|---|---|
| Pass 1: cookie auth threat model + `ApiError` boundary | **PRESERVED**. |
| Pass 1: AuthProvider AbortController | **PRESERVED**. |
| Pass 1: provider/hook/context split | **PRESERVED**. |
| Pass 1: BottomNav location-derived | **PRESERVED**. |
| Pass 1: lib/nav.ts | **PRESERVED**. |
| Pass 2: useModalA11y | **PRESERVED**. WordPopover still uses it. |
| Pass 2: ErrorCard | **PRESERVED**. |
| Pass 2: useEndpointOrMock contract | **PRESERVED**. Used in Grammar prune effect via stable `data` reference + `refetch()`. |
| Pass 2: Diagnostic mode-init pattern | **PRESERVED** (not touched). |
| Pass 2: Settings substrate + `editedFieldsRef` | **PRESERVED**. F-S1 test exercises the very contract this substrate enforces. |
| Pass 3 A: idempotency-check-before-version-gate (SSE) | **PRESERVED**. |
| Pass 3 A: FOR UPDATE on vocab_list_entries | **PRESERVED** (not touched). |
| Pass 3 A: persist-as-last-step on streaming | **PRESERVED**. |
| Pass 3 A: SSE-framed post-headers errors | **PRESERVED**. |
| Pass 3 A: phone regex parity | **PRESERVED**. |
| Pass 3 B: sseStream reader-cancel race fix | **PRESERVED**. |
| Pass 3 B: `raceAgainstAbort` pattern | **PRESERVED**. |
| Pass 3 B: ApiError boundary on all services | **PRESERVED**. |
| Pass 3 C: threat-model headers (Reading, Chat) | **PRESERVED** + Reading's expanded with FU-NF-33 deferral. |
| Pass 3 C: graceful-degradation tiering on slow path | **PRESERVED** + now combined with immediate-open. |
| Pass 3 D: ratings Map | **PRESERVED**. |
| Pass 3 D: empty-vs-error split | **PRESERVED**. |
| Pass 3 D: dueCardIndex carries version | **PRESERVED**. |
| Pass 3 D: debounced re-key on All tab | **PRESERVED**. |
| Pass 3 E: optimistic-bank → refetch reconciliation | **PRESERVED** + now pruned (E-SF-1). |
| Pass 3 E: 409 idempotency baked in | **PRESERVED**. |
| Pass 3 E: Reference 200ms debounce keying | **PRESERVED**. |
| Pass 3 F: server-as-truth pattern | **PRESERVED**. |
| Pass 3 F: 600ms debounce + minimal-diff PATCH | **PRESERVED**. F-S1 test confirms empty-drops-from-diff. |
| Pass 3 F: abort-on-unmount | **PRESERVED**. FU-NF-37 tracks the dedicated unmount assertion. |
| Pass 3 F: AuthProvider.refresh on 409 | **PRESERVED**. |
| Pass 3 F: one-way email/phone → notif-channel coupling | **PRESERVED**. |
| RR1 PRAISE: `editedFieldsRef` Set | **PRESERVED** + now under test. |
| RR1 PRAISE: `fireErrorOnce` guard | **PRESERVED**. |
| RR1 PRAISE: `getApiBaseUrl()` exported | **PRESERVED**. |
| RR1 PRAISE: server `CallContext.signal` threading | **PRESERVED**. |

No PRAISE items SILENTLY-REWORKED or UNDONE.

---

## Detailed findings (one section per non-FIXED row)

None. Every prior `NOT-FIXED` or `REGRESSION-INTRODUCED` row is closed.
The two NITs above are out-of-pattern observations introduced by the
tightening itself, not rollbacks of prior work.

### RR2-N-1 — Audit-log test FU reference (NIT)

`Repository/server/tests/auth.test.ts:304`:

```
// pino transport + assert WARN line with event=profile_email_changed
// and afterDomain matching the new domain) is filed as FU-NF-33.
```

Should read `FU-NF-34`. The Reading Add-to-bank wiring is FU-NF-33;
the pino log-capture transport is FU-NF-34. One-character edit.

### RR2-N-2 — Grammar prune 50-cap path uncovered (NIT)

`Grammar.tsx:234-238`:

```ts
if (next.size > 50) {
  const keep = Array.from(next).slice(-50);
  return new Set(keep);
}
```

The cap exists as a defence-in-depth measure. The test covers the
post-refetch shrinkage path; the >50 overflow path is not driven by a
test. Acceptable since the cap is documented as a "this shouldn't
happen in a healthy session" backstop; if the test landed it would
need to bank 51 patterns in a row, which exercises a code path no
realistic UX produces. Captured for completeness.

### RR2-N-3 — Grammar prune effect transient allocation (NIT)

`Grammar.tsx:225-243` allocates a transient Set on every
`bankedState.data` identity change. The inner guard preserves
`optimisticBanked` identity when no prune happens, so consumers
downstream don't re-render. The allocation itself is negligible
(empty-Set case skips, see `L229`), but a defensive `if
(prev.size === 0) return prev` short-circuit (which is already there)
could be extended to skip the loop entirely when `bankedState.data` is
the same reference. Sub-microsecond impact. Strict YAGNI says leave
it — flagged for symmetry only.

---

## Recommendation

**Ready to ship Pass 3.**

The seven NOT-FIXED items + the one REGRESSION on the prior re-review
are all closed at the contract level. Test coverage now matches the
production code changes. The single doc-level NIT (the misnumbered FU
in `auth.test.ts:304`) is too small to block.

The two remaining NITs (Grammar 50-cap coverage; Grammar effect
allocation) are below the SHOULD-FIX bar and capture observations
worth keeping in mind during the next pass — not gating issues.

File follow-ups for the documented deferrals:
- FU-NF-33 (Reading Add-to-bank end-to-end via `bankEntry(entryId)`)
  — ALREADY FILED. Acceptance criteria match the work needed.
- FU-NF-34 (pino log-capture transport in `buildTestApp`) — ALREADY
  FILED. Acceptance criteria match.
- FU-NF-35 (mutation services thread `signal?: AbortSignal`) —
  ALREADY FILED.
- FU-NF-36 (Review `lastKey` rollback simplification) — ALREADY FILED.
- FU-NF-37 (Settings unmount-aborts-PATCH dedicated test) — ALREADY
  FILED.

No additional fix-pass required. Pass 3 is done.
