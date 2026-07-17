# Fix Report: fix/ticket-detail-bigint-id-coercion

Fix-pass against `REVIEW_ticket-id-fix.md` (verdict PASS, 0 BLOCKER, 0 SHOULD-FIX, 2 NITs).
Product code (`client/src/services/tickets.ts`) untouched — the reviewed fix stands as-is.

## NIT dispositions

### NIT-2 — mutating endpoints' response paths not directly tested → FIXED
Added a `mutating endpoints — bigint id coercion on the response` describe block to
`client/src/services/tickets.test.ts` (3 new tests):

1. `createTicket coerces the created ticket id to a number` — mocks `api.post`
   with a real owner-shape wire envelope carrying `id: '9'`; calls
   `createTicket({ type: 'bug', title: 'T', body: 'B' })`; asserts `created.id`
   is strictly `9` and `typeof === 'number'`.
2. `patchTicket coerces the updated ticket id to a number` — mocks `api.patch`
   with `id: '1', version: 2`; calls
   `patchTicket(1, { status: 'resolved', expectedVersion: 1 })` (the required
   `expectedVersion` per `PatchTicketBody`); asserts numeric `1`.
3. `addTicketComment coerces the created comment id to a number` — mocks
   `api.post` with a comment envelope carrying `id: '8'`; calls
   `addTicketComment(1, 'hi')`; asserts numeric `8`.

Signatures verified against `tickets.ts` (`createTicket(body, signal?)`,
`patchTicket(id, patch, signal?)`, `addTicketComment(id, body, signal?)`) and
mocked per the existing `vi.spyOn(api, 'get')` pattern, at the same layer.

**Mutation-verified:** swapped in `rebuild`'s `tickets.ts` and re-ran the suite —
all **8/8 tests fail** (the 5 original + the 3 new) on the id assertions; restored
the fixed file, suite green again. The new tests are genuine regression guards,
not tautologies.

### NIT-1 — unguarded `Number()` / shared `coerceId()` helper → DEFERRED (F-202)
Not applied, per fix-pass scope: guarding only tickets would diverge from the
codebase-wide bare-`Number()` convention (`grammar.ts`, `hanja.ts`,
`progress.ts`, `vocab.ts`), and a cross-service helper is repo-wide scope creep
on a launch-critical hotfix. Ticket ids are `bigserial` positive integers far
below `Number.MAX_SAFE_INTEGER` for this single-user app, so `Number()` is exact
today. Filed as **F-202**.

### Review probe 3 — optional server-side bigint normalization → DEFERRED (F-203)
The root-cause-at-source hardening (per-query `::int` casts or a global
`pg.types.setTypeParser` for int8) touches every route's wire contract and needs
its own full-suite pass. Filed as **F-203**.

## BUGS_AND_FEATURES.md rows added

New section `## 🔎 Ticket-id-coercion follow-ups — surfaced by the ticket-detail
bigint-id fix-pass (filed 2026-07-17)` (after F-201, matching the existing
detailed-entry style):

- **F-202** · Shared `coerceId()` helper — guard every service's bare
  `Number(id)` wire coercion (P4, wire-boundary hardening; lists all call
  sites; fail-loud `Number.isSafeInteger(n) && n > 0` helper, one pass across
  all services).
- **F-203** · Server-side bigint id normalization — fix the bigint→string class
  at the source (P4, wire-contract hardening; `::int` casts vs global
  `setTypeParser(20, …)`, own PR + full-suite gate per the schema-change rule).

## Files changed

- `client/src/services/tickets.test.ts` — +3 tests (+50 lines)
- `BUGS_AND_FEATURES.md` — +F-202, +F-203 (+14 lines)
- `client/src/services/tickets.ts` — **unchanged** (byte-identical to the
  reviewed branch state; verified via `git status` after the mutation check)

## Gate results (final state)

| Gate | Result |
|---|---|
| `npx vitest run src/services/tickets.test.ts src/pages/Tickets.test.tsx` | **42/42 pass** (was 39; +3 new) |
| `npx eslint src/services/tickets.ts src/services/tickets.test.ts` | **0 problems** |
| `npx tsc --noEmit -p tsconfig.app.json` filtered to `tickets` | **no tickets errors** (known-unrelated tsbuildinfo EACCES + driver.js noise excluded per instructions) |

Nothing committed; changes left in the working tree per instructions.
