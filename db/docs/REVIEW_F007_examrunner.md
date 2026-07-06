# Independent Review — F-007 ExamRunner state/persistence slice

**Commit:** `983fa09` — feat(topik): resume an in-progress TOPIK mock test (F-007)
**Scope:** `ExamRunner` state-machine + persistence in
`client/src/pages/topik/MockMode.tsx`; test adequacy in
`client/src/pages/topik/MockMode.test.tsx` and `client/src/pages/Topik.test.tsx`.
Server route + migration read only as context for the client-boundary race.
**Reviewer stance:** independent; did not author this code.

---

## Verdict

**APPROVE WITH FOLLOW-UP.** The two highest-risk correctness items were probed
hard:

1. **stateRef effect-ordering — CORRECT.** The ref-update effect is declared
   before both save effects; effects run in declaration order, so a save always
   reads the freshly-mirrored state. Not stale. (PRAISE)
2. **submit-doesn't-resurrect via the *unmount* save — CORRECT.** `submittedRef`
   is set synchronously in `doSubmit` before `onSubmit`, so by the time the
   phase→results unmount fires the cleanup save, the guard returns early. The
   exact sequence described in the design intent holds and is safe. (PRAISE)

There is, however, a **residual resurrect window that the `submittedRef` guard
does not close**: a `saveAttempt` PUT that was *already in flight* when
`/mock/submit` deletes the row can land after the delete and re-INSERT the row
(the PUT is an unconditional upsert). This is narrow and recoverable, but it is
the exact "resume banner offers a finished test" failure mode. Filed SHOULD-FIX.

No BLOCKERs. **0 blockers, 3 should-fix, 3 nits, 4 praise.**

---

## Senior-bar checklist

| Criterion | Result |
|---|---|
| State machine correct (hydrate / persist / unmount) | PASS |
| Effect declaration order sound (ref-before-save) | PASS |
| Stale-closure handling (interval/unmount read latest) | PASS |
| Immutable state updates (no shared-mutable Map) | PASS |
| Guard against post-submit resurrect (unmount path) | PASS |
| Guard against post-submit resurrect (in-flight PUT) | **GAP** (SHOULD-FIX #1) |
| Timer restore edge-cases handled | PASS (minor gaps, NIT) |
| eslint suppressions justified | PASS |
| Save-side test coverage | **MISSING** (SHOULD-FIX #2) |
| Resurrect-guard test coverage | **MISSING** (SHOULD-FIX #3) |
| Dead code | 1 unused export (NIT) |

---

## Findings by severity

### SHOULD-FIX

**SF-1 — In-flight save can resurrect a submitted attempt (client/server race).**
`MockMode.tsx:735-738` (`saveProgress` guard) + `saveAttempt` fire-and-forget at
`MockMode.tsx:172-186` + server `server/src/routes/topik.ts` PUT `/attempt`
(unconditional `INSERT … ON CONFLICT (user_id) DO UPDATE`).

The `submittedRef` guard only blocks saves *initiated* after submit. It does not
cancel a PUT already dispatched. Sequence:

1. 15s interval (or a late pick-save) dispatches `PUT /topik/attempt` at T.
2. Before it commits, the user submits → `/mock/submit` `DELETE`s the row (its tx
   commits at T+a).
3. The in-flight PUT commits at T+b > T+a → the `ON CONFLICT` upsert takes the
   INSERT path → **row resurrected**.

Result: next visit shows a resume banner for an already-graded section; resuming
re-fetches the (deterministic) exam and lets the user re-submit/re-grade.
Recoverable (dismiss) but it is precisely the flagged risk.

*Why not a BLOCKER:* the common submit path routes through a confirm dialog
(`setConfirming` → user clicks confirm), a human delay far exceeding a save's
network RTT, so the last pick-save almost always commits first; the window is the
rare case where the *15s interval or auto-submit* fires within ~one RTT of the
delete, and the consequence is recoverable, not data loss.

*Fix options (server-side is the robust one):* the table already carries a
`version` column that is currently only incremented, never checked — use it (or a
submitted high-water mark) so a PUT refuses to *create* a row for a
(user, source_test) that was just submitted; or make submit set a short-lived
tombstone; or client-side, abort in-flight saves and `await` a final save before
calling `onSubmit`. The unused `version` column is the natural hook.

**SF-2 — No test exercises the SAVE side.** `MockMode.test.tsx:469-495`. The new
test asserts the resume *re-fetch* path only. `saveAttempt` is mocked to resolve
and never asserted. The bulk of the risk (that picks/idx/remaining are persisted
with the *latest* values, i.e. the stateRef-ordering behavior) is untested. Add a
test: pick an answer, then assert `saveAttempt` was called with a body whose
`picks` contains that answer (proves the ref-update-before-save ordering end to
end, not just by inspection).

**SF-3 — The submit-doesn't-resurrect guard is untested on the client.**
`MockMode.test.tsx` (no reference to the guard). The server "submit-clears" test
covers the DB delete, but the client `saveProgress` no-op-after-submit guard —
the thing that prevents the unmount flush from resurrecting — has zero coverage.
Add: answer → submit → assert no `saveAttempt` call occurs after
`submitMockTest` resolves / on unmount.

### NIT

**N-1 — Contradictory comment on the stateRef pattern.** `MockMode.tsx:717-728`.
Lines 719-720 say "Writing a ref during render is the standard 'latest value'
pattern"; lines 726-727 then say "writing a ref during render is disallowed" and
the code uses the effect. The first clause misdescribes what the code does.
Trim to just the effect rationale.

**N-2 — `clearAttempt` is exported but never used.** `client/src/services/topik.ts`
(new `clearAttempt`); no caller in `client/src`. Either wire it into the
abandon/start-fresh path (currently `startSection` relies on the next save's
upsert-replace, and results relies on the server-side submit delete) or drop it.
Dead export.

**N-3 — No upper bound on restored `current_idx` / `remaining_ms`.** Migration
037 CHECKs only `>= 0`; server schema only `nonnegative`. On resume, an
out-of-range `currentIdx` (e.g. corpus item count shrank between save and resume)
yields `items[idx] === undefined` → the defensive "no items / Finish" ErrorCard
(`MockMode.tsx:755-767`), a degraded-but-safe outcome. A very large `remainingMs`
would show a nonsense clock. Both are low-likelihood given the deterministic
re-fetch; worth a clamp for robustness.

### PRAISE

**P-1 — Effect ordering is correct and deliberately documented.**
`MockMode.tsx:729-753`. Ref-update effect (deps `[idx, picks, remaining]`)
precedes the save-on-pick effect (`[idx, picks, saveProgress]`) and the
interval/unmount effect (`[saveProgress]`). On a pick, the ref updates before the
save reads it, so the *new* pick is persisted, not the previous one. The comment
explicitly calls out the ordering requirement. This is the subtle bug the pattern
invites, and it was avoided.

**P-2 — Unmount-resurrect guard is correct.** `MockMode.tsx:665-670, 735-738`.
`submittedRef` is set synchronously before `onSubmit`; the cleanup save at
`:751` reads it and no-ops. No resurrect on the unmount path.

**P-3 — Immutable picks; no shared-mutable-state bug.** `MockMode.tsx:708-714`
replaces the Map via `new Map(prev)`. Although the `useState` initializer
(`:584-586`) adopts the parent's `initialExam.picks` Map by reference, that Map is
never mutated in place, so the parent's copy stays intact. Safe.

**P-4 — Auto-submit eslint suppression is justified.** `MockMode.tsx:692-697`.
The `react-hooks/set-state-in-effect` disable is a genuine sync-to-external-system
case (timer expiry must kick the grade call) and is guarded by `submittedRef`
against double-fire; it is not masking a render cascade.

---

## Detailed analysis

### stateRef pattern and effect ordering (highest-risk #1) — SOUND

Effects in `ExamRunner`, in declaration order:

1. `:615` examStart stamp — `[]`
2. `:677` countdown interval — `[]`
3. `:692` auto-submit — `[remaining, doSubmit]`
4. `:729` **stateRef update** — `[idx, picks, remaining]`
5. `:741` **save-on-pick** — `[idx, picks, saveProgress]`
6. `:747` **interval + unmount save** — `[saveProgress]`

- On a **pick**: `picks` changes → effects 4 then 5 both re-run (both list
  `picks`). 4 runs first → `stateRef.current` = new picks; 5 runs → `saveProgress`
  reads the fresh ref. **Persists the new pick.** Correct.
- On a **tick** (`remaining`): only effect 4 re-runs (5 and 6 don't list
  `remaining`). The ref stays fresh; the actual save happens on the 15s interval
  or unmount, both of which read the fresh ref. Correct.
- `useRef` initializer (`:721-725`) seeds the ref with current values, so even the
  mount-time save (effect 5 runs on mount) reads correct data before effect 4
  first runs.

The pattern is genuinely necessary for the interval/unmount closures (which would
otherwise capture stale `idx`/`picks`/`remaining`); routing the save-on-pick
effect through the same ref is consistent and correct.

### submit-doesn't-resurrect (highest-risk #2) — unmount path safe, in-flight path is SF-1

`doSubmit` (`:665`): `submittedRef.current = true` (sync) → `onSubmit(buildBody())`
→ parent `runSubmit` → server `/mock/submit` deletes the row in-tx → parent flips
phase → `ExamRunner` unmounts → effect 6 cleanup (`:749-752`): `clearInterval` +
`saveProgress()` → guard `:736` returns early. No resurrect. Verified safe.

The residual window is SF-1: a PUT dispatched *before* `submittedRef` flipped and
still in flight when the delete commits. The client guard cannot retract it; the
server upsert has no submitted-guard. Documented above with fix options.

### Timer restore — OK

`remaining` hydrates from `Math.round(initial.remainingMs / 1000)` (`:638-640`).
- `remainingMs = 0` → `remaining = 0` → auto-submit effect fires on mount and
  submits immediately. Defensible (time is up); and it normally can't be saved as
  0 because reaching 0 auto-submits and clears the row first.
- Large/corrupt value → wrong clock, no functional break. NIT N-3 suggests a clamp.
- Countdown interval and auto-submit both operate on the hydrated value unchanged,
  so mid-way resume ticks and auto-submits correctly.

### Double-save on unmount — harmless

Effect 6 cleanup clears the interval *then* calls `saveProgress` once. No double
timer, no error. If unsubmitted, the final flush persists latest state (intended);
if submitted, the guard no-ops. `onSave`/`saveProgress` identities are stable for
an exam (`handleSaveProgress` deps `[test]`; `test` set once per exam), so effect 6
sets up and tears down exactly once.

### Shared Map reference — safe

Covered in P-3. `initialExam.picks` is built fresh in `resumeAttempt`
(`new Map()` populated from `Object.entries`), adopted by reference into
`ExamRunner`'s `picks` state, and only ever replaced immutably. No aliasing bug.

### Test adequacy — banner path proven, save + guard paths unproven

The new `MockMode` test (`MockMode.test.tsx:469-495`) proves
banner→resume→re-fetch-by-`source_test` (asserts `fetchMockTest('reading',
<signal>, 777)`). It does **not** assert hydration into the DOM (restored pick
selected, idx label `3 / N`, timer ~30:00), the save side (SF-2), or the
resurrect guard (SF-3). `Topik.test.tsx` additions are correct minimal stubs
(`fetchAttempt → null`, `saveAttempt → resolve`) so study-mode tests see no
banner. Recommend the SF-2/SF-3 tests plus a hydration assertion.

---

## Summary

The state machine is well-constructed and the two subtle, high-risk items —
effect ordering and the unmount resurrect guard — are correct and documented.
The one real residual defect is the in-flight-PUT resurrect race (SF-1), which the
`submittedRef` guard structurally cannot close; fix it server-side using the
already-present-but-unused `version` column or a submitted tombstone. Add the
save-side and resurrect-guard tests (SF-2/SF-3). Approvable with those follow-ups.
