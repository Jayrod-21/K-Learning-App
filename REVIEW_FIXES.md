# Re-Review: fix/ticket-detail-bigint-id-coercion (post fix-pass)

**Reviewer:** Independent re-reviewer (did not author the fix, the original review, or the fix-pass)
**Scope:** Verified `FIX_REPORT.md` claims against actual code on branch `fix/ticket-detail-bigint-id-coercion`, diffed vs `rebuild`
**Date:** 2026-07-17

---

## Summary verdict: **PASS**

Every FIX_REPORT claim verified true against the code. The mutation test proves
all 8 service tests (5 original + 3 new) are genuine regression guards. Product
code is untouched by the fix-pass — the diff vs `rebuild` contains only the
original reviewed coercion fix. No F-202/F-203 collision. All gates green.
**Ready to ship.**

---

## Finding-by-finding table

| # | Original finding | Fix-pass disposition | Verified? |
|---|---|---|---|
| NIT-1 | Unguarded `Number()` → shared `coerceId()` helper | DEFERRED as F-202 | ✅ `tickets.ts` has no guard/helper (correct — matches codebase convention); F-202 filed at `BUGS_AND_FEATURES.md:1793` with all call sites listed |
| NIT-2 | Mutating endpoints (`createTicket`/`patchTicket`/`addTicketComment`) not directly tested | FIXED — 3 new tests | ✅ New `mutating endpoints` describe block present; all 3 assert strict numeric equality against string-id wire fixtures; mutation-verified (below) |
| Probe-3 follow-up | Server-side bigint normalization | DEFERRED as F-203 | ✅ Filed at `BUGS_AND_FEATURES.md:1799`; correctly flags the full-suite gate rule for the `setTypeParser` option |

---

## Mutation test (probe 1) — **PASS, both directions**

Reverted just the coercion in all 3 mappers (`id: Number(wire.id)` →
`id: wire.id as number` at `tickets.ts:124,140,156`), then ran
`npx vitest run src/services/tickets.test.ts`:

- **Mutated:** **8/8 tests FAIL** — every test in the file trips on the id
  assertions, including all 3 new mutating-path tests.
- **Restored** via `git checkout -- client/src/services/tickets.ts`
  (`git status --porcelain` clean for the file afterward), re-ran the full gate:
  **42/42 pass** (8 in `tickets.test.ts` + 34 in `Tickets.test.tsx`).

The file was left in its exact committed state; no mutation residue.

## Probe 2 — new mutating-path tests are NOT tautologies: **CONFIRMED**

All three mock at the `api.post`/`api.patch` layer (below the mappers) with
string-id wire fixtures (`{ ...ownWire, id: '9' }`, `id: '1'`, comment
`id: '8'`) and assert `toBe(9)` / `toBe(1)` / `toBe(8)` plus
`typeof === 'number'`. `Object.is('9', 9)` is false, so each fails under the
bug — empirically proven by the mutation run, where all 3 failed.

## Probe 3 — fix-pass did not touch product `tickets.ts`: **CONFIRMED**

`git diff rebuild -- client/src/services/tickets.ts` contains ONLY the original
reviewed fix: the three `Number(wire.id)` coercions, the `number | string` wire
retypes, and doc comments. No `coerceId` helper, no `NaN`/safe-integer guard,
nothing else. Working tree is clean for the file (all fix-pass changes are in
`tickets.test.ts` and `BUGS_AND_FEATURES.md` only — matches `git diff --stat`:
3 files, and `git status` shows `tickets.ts` unmodified vs the branch commit).

## Probe 4 — domain type integrity: **CONFIRMED**

`client/src/types/domain.ts` has zero diff vs `rebuild`. `OwnTicket.id`
(line 2588), `CommunityTicket.id` (line 2609), and `TicketComment.id`
(line 2652) are all still plain `number`. The `number | string` union lives
only in the private wire interfaces inside `tickets.ts` — no leak into domain
types or any consumer.

## Probe 5 — F-202/F-203 collision check: **NO COLLISION**

`git show rebuild:BUGS_AND_FEATURES.md | grep "F-202\|F-203"` → no matches;
the highest pre-existing id is **F-201**. F-202 and F-203 are the only
occurrences in the updated file and are sequential continuations. Row format
matches the established detailed-entry style exactly (`### F-xxx · Title`,
then `**Status:** / **Priority:** / **Category:**`, `**Where / State:**`,
`**Key files:**`, `**Fix hint:**` — same fields as F-201 directly above).

## Probe 6 — remaining id comparisons on the ticket path: **NO REGRESSION**

All `.id` comparisons in `Tickets.tsx` operate on domain objects downstream of
the fixed mappers, now guaranteed numeric: line 1035 (`t.id === id` optimistic
update), 1193 (`t.id === updated.id`), 1207 (`updated.id === ticketId`),
1246-1247 (`find((t) => t.id === ticketId)`), 1253/1259
(`detail.ticket.id === ticketId`). The `openTicket` → `String(id)` →
`parseTicketIdParam` round-trip is intact: number → `"1"` in the URL →
`^\d{1,15}$` + `parseInt` + `Number.isSafeInteger(n) && n > 0` → same number
(`Tickets.tsx:216-220`). No lossy or type-mismatched step remains.

---

## Gates (run fresh, final state)

| Gate | Expected | Actual |
|---|---|---|
| `npx vitest run src/services/tickets.test.ts src/pages/Tickets.test.tsx` | 42 pass | **42/42 pass** (2 files: 8 + 34) |
| `npx eslint src/services/tickets.ts src/services/tickets.test.ts` | 0 problems | **0 problems** |

(Known tsbuildinfo EACCES / driver.js tsc noise excluded per instructions; not
re-litigated here.)

---

## New blockers found

None.

## Recommendation

**Ready to ship.** No further pass needed. F-202 (shared `coerceId()`) and
F-203 (server-side bigint normalization) are properly filed follow-ups with
accurate call-site inventories and the right scope warnings (F-203 explicitly
requires its own PR + full-suite gate per the schema-change rule).
