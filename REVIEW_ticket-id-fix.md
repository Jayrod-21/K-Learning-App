# Review: fix/ticket-detail-bigint-id-coercion

**Reviewer:** Independent senior review (did not author the change)
**Scope:** `client/src/services/tickets.ts` (modified), `client/src/services/tickets.test.ts` (new), diffed vs `rebuild`
**Date:** 2026-07-17

---

## Summary verdict: **PASS**

The fix is correct, minimal, at the right layer, consistent with the codebase's
established convention, and guarded by a test that empirically fails against the
pre-fix code (mutation-verified, not just mentally traced). No blockers, no
should-fixes. Two nits, both follow-up material rather than conditions on this
merge.

Verification performed:

- `npx vitest run src/services/tickets.test.ts` on the branch: **5/5 pass**.
- `npx tsc --noEmit` on the client: **clean** (the `number | string` retype
  breaks nothing else).
- Mutation check: temporarily swapped in `rebuild`'s `tickets.ts` and re-ran the
  suite — **all 5 tests fail** exactly on the id assertions
  (`expect(result.ticket.id).toBe(1)` receiving `"1"`, plus the `typeof`
  assertions). Restored the fixed version afterwards; tree clean, suite green.

---

## Findings

### BLOCKER

None.

### SHOULD-FIX

None.

### NIT

1. **Unguarded `Number()` can silently produce `NaN` or lose precision on a
   contract break** — `client/src/services/tickets.ts:124,140,156`.
   If the server ever emitted a malformed id (empty string → `0`,
   non-numeric → `NaN`, or a bigint beyond `Number.MAX_SAFE_INTEGER` → silent
   precision loss), the coercion would reproduce the exact silent
   "not found" symptom class this fix closes, rather than failing loudly.
   In practice the risk is near zero: ids are `bigserial` positive integers
   from a single-user database, far below 2^53, and the URL side is already
   hardened (`parseTicketIdParam` caps at 15 digits and checks
   `Number.isSafeInteger` — `client/src/pages/Tickets.tsx:216-220`).
   Crucially, **every other service in the codebase uses the same unguarded
   `Number()` convention** (`grammar.ts:71,107`, `hanja.ts:350,393-394`,
   `progress.ts:54,65`, `vocab.ts:105,472`), so guarding only here would be
   inconsistent. The right follow-up, if desired, is a shared
   `coerceId(v: number | string): number` helper (assert
   `Number.isSafeInteger(n) && n > 0`, throw otherwise) adopted across all
   services in one pass — out of scope for this bugfix.

2. **The three mutating endpoints' responses are not directly exercised by the
   new tests** — `createTicket` (`tickets.ts:197`), `patchTicket`
   (`tickets.ts:275`), `addTicketComment` (`tickets.ts:289`). They route
   through the same three mappers the tests do cover, and the mutation check
   proves the mappers are the guard, so this is genuinely optional. A single
   `createTicket` case would make the guard visibly complete if anyone later
   splits the mappers.

### PRAISE

1. **Type honesty as the enforcement mechanism** —
   `tickets.ts:57,76,93`. Retyping the wire `id` to `number | string` is what
   makes the coercion *compiler-enforced*: any future code assigning `wire.id`
   straight into the domain's `id: number` is a type error under strict TS.
   The previous `id: number` declaration was the actual root cause (the lie
   that let `"1" === 1` slip through both review and typecheck); the fix
   removes the lie rather than papering over one comparison. Verified
   `tsc --noEmit` clean.

2. **The wire-boundary comments explain the *why*, not the *what*** —
   `tickets.ts:51-56`. A future reader who sees `Number(wire.id)` and is
   tempted to "simplify" it will hit the full postmortem in the doc comment.
   This is exactly what prevents regression-by-cleanup.

3. **The test targets the real failure mode, not a tautology** —
   `tickets.test.ts:28-40`. It mocks at the `api.get` layer (below the
   mappers, the unit under test) with fixtures matching the server's actual
   serialization: string bigint ids, numeric `version` (integer column),
   numeric `comment_count` (the server casts `::int` —
   `server/src/routes/tickets.ts:161,174`), owner shape with `version` /
   community shape with `is_mine` matching `OWNER_TICKET_COLS` and
   `communityTicketCols` (`server/src/routes/tickets.ts:159,173`). This
   directly addresses the project's recurring "tests mocked with fake-typed
   data" failure — and I confirmed it by mutation, not by inspection alone.

---

## The four probes

### 1. Does the new test actually catch the original bug? — **YES, empirically verified.**

I checked out `rebuild`'s `tickets.ts` (mapper reverted to `id: wire.id`),
re-ran the suite, and **all 5 tests failed** — the strict `toBe(1)` against
`"1"` (`Object.is("1", 1)` is `false`), the `typeof` assertions, and the
`toEqual([1, 2])` array check all trip. The fixed version was then restored
and the suite passes 5/5. This is not a tautological test; it is a genuine
regression guard for the exact production failure.

### 2. Any other id comparison / id-typed field left as a raw string? — **NO.**

- All seven exported service functions route every response through exactly
  the three fixed mappers: `createTicket:197`, `listMyTickets:209`,
  `fetchTicket:236-237`, `listCommunityTickets:249`, `patchTicket:275`,
  `addTicketComment:289`, `listTicketComments:305`. There is no fourth path
  by which wire data reaches the domain.
- The only raw-wire read outside the mappers is the `'version' in wire`
  discriminator (`tickets.ts:235`) — a key-presence check, type-immune.
- Other id-adjacent wire fields are safe by construction: `version` is a
  Postgres `integer` (arrives as number), `comment_count` is cast `::int`
  server-side (`server/src/routes/tickets.ts:161,174`), and the anonymized
  shapes carry no `user_id` at all (the F-023 contract).
- Comment ids are covered: `toComment` (`tickets.ts:156`) coerces, and the
  consumers (`key={c.id}` at `Tickets.tsx:602`, thread state updates) receive
  numbers.
- All `.id` comparisons in `Tickets.tsx` (`714, 751, 761, 1035, 1193, 1207,
  1246-1259`) operate on domain objects downstream of the mappers — all
  numeric now.

### 3. Is a client-only fix sufficient and correct? — **YES; server-side normalization is a follow-up nit, not a blocker.**

- `tickets.ts`'s module header (`tickets.ts:6`) explicitly declares this
  module "the wire↔domain boundary" — this is precisely where a
  serialization-format concern belongs.
- More importantly, this is the **dominant existing convention**: `grammar.ts`,
  `hanja.ts`, `progress.ts`, and `vocab.ts` all coerce bigint ids with
  `Number()` client-side at their mapper boundary. The fix makes tickets
  consistent with the codebase, not divergent from it.
- The cited server-side precedent, `server/src/auth/sessions.ts:135-136`
  (`Number(row.id)`), coerces for *internal server* consumption of session
  rows — it is not an API-response convention. The tickets route ships raw
  `t.id` on the wire, like every other route.
- A server-side alternative exists (cast `t.id::int` in the SELECT lists,
  matching the existing `comment_count ::int` treatment, or a global
  `pg.types.setTypeParser` for int8 — no `setTypeParser` exists anywhere in
  `server/src` today). Either would fix the *class* of bug for future
  services rather than this instance, and would be a reasonable follow-up
  ticket. But it touches every route's wire contract and deserves its own
  test pass; folding it into this bugfix would be scope creep. **Follow-up
  nit, not a condition.**

### 4. Does `openTicket` → `String(id)` → `parseTicketIdParam` still round-trip? — **YES, no regression.**

`openTicket` (`Tickets.tsx:1181-1189`) receives a domain id — now guaranteed
`number` — and writes `String(id)` into the URL (`"1"`). `parseTicketIdParam`
(`Tickets.tsx:216-220`) accepts `^\d{1,15}$`, parses with
`Number.parseInt(raw, 10)`, and gates on `Number.isSafeInteger(n) && n > 0` —
yielding the same `number` back. `fetchTicket` then interpolates `String(id)`
into the path (`tickets.ts:231`), identical bytes on the wire as before the
fix. The round-trip is number → string → number with no lossy step, and the
comparisons at `Tickets.tsx:1207,1246-1259` now compare number to number.

---

## Does the test catch the bug? — **YES** (see probe 1: mutation-verified, all 5 tests fail against the reverted mapper).
