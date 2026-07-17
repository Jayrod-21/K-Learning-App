# REVIEW — server half, `GET /tickets/:id` (branch `fix/ticket-detail-endpoint`)

Reviewer: independent, security-focused. Scope: `server/src/routes/tickets.ts` (new `/:id` handler) + `server/tests/routes/tickets.test.ts`. Report only; no edits.

## Summary verdict

**PASS — 0 BLOCKERS.** New endpoint honors the F-023 anonymity contract: owner probe is SQL-scoped (`id AND user_id`), anonymized branch's SELECT list is param-normalized byte-identical to `/community`'s (mechanically verified), no `version`/`user_id`/author column crosses to a non-owner. Route order correct; `requireAuth` + Zod id validation + parameterized SQL all present. Tests are non-trivial and prove the own-vs-anonymized split and the just-filed-under-filter regression. Suite: **41/41 passed** (testcontainer, single run, 46.7s).

## Bar checklist

| Requirement | Status | Evidence |
|---|---|---|
| No author-identity leak to non-owner | PASS | Anonymized SELECT `tickets.ts:292-295` = `/community`'s `tickets.ts:207-210` (verified programmatically, param-normalized identical: `id,type,title,body,status,source_page,comment_count,is_mine,created_at,updated_at` — no `user_id`, no users join, no `version`) |
| Own ticket → full owner shape incl. `version` | PASS | Owner SELECT `tickets.ts:255-258` byte-identical to `/mine`'s `tickets.ts:157-160`; test asserts `version === 1` (`tickets.test.ts:325`) |
| Other user's ticket → anonymized shape, `is_mine` only | PASS | Test `tickets.test.ts:361-381`: `is_mine === false`, `version` undefined, `assertAnonymized` over whole payload |
| IDOR posture (view allowed, owner data/edit rights not) | PASS | Non-owner can never hit the owner branch — ownership decided in SQL (`tickets.ts:261`), never from client input; no edit-rights token (`version`) on the community branch |
| Parameterized SQL only | PASS | `$1/$2` placeholders both queries (`tickets.ts:254-264`, `280-301`); no interpolation |
| Missing id → 404, not 403 | PASS | `tickets.ts:306` `NotFoundError`; test `tickets.test.ts:383-388` asserts 404 + code `not_found`. No 403 path exists — no existence oracle beyond what `/community` already exposes |
| Route registration order | PASS | `/mine` line 144, `/community` line 180, `/:id` line 238 — literals registered first, Express matches in order. Implicitly regression-guarded: the just-filed test calls `GET /tickets/mine?status=resolved` and expects the list shape (`tickets.test.ts:346-348`) through the same app where `/:id` is live — shadowing would fail it, as would the whole pre-existing `/mine` + `/community` suites |
| `requireAuth` | PASS | Router-level `tickets.ts:65`; 401 test row for `GET /tickets/1` (`tickets.test.ts:53`) |
| Numeric id validation (no 500 on garbage) | PASS | `validateParams(TicketIdParamsSchema)` (`tickets.ts:241`; schema `tickets.ts:78-80` — `coerce.number().int().positive().max(MAX_SAFE_INTEGER)`); 20-digit overflow test → 400 `validation_error` (`tickets.test.ts:83-88`). Non-numeric coerces to NaN → 400 |

## Active probes (from review charter)

1. **Owner shape reachable by non-owner?** No. The only path returning `version` is guarded by `WHERE t.id = $1 AND t.user_id = $2` (`tickets.ts:261`) with `userId` from the session (`getUserId`, `tickets.ts:244`), never from the request.
2. **`/mine` / `/community` shadowed by `/:id`?** No — registration order correct; existing list suites + the filter test at `tickets.test.ts:346` would fail loudly if flipped.
3. **`GET /tickets/mine` parsed as id?** No — the literal `/mine` layer wins (registered at line 144, before `/:id` at 238). Were the order ever inverted, `"mine"` would 400 at Zod, not 500 — and tests would catch it.
4. **Anonymized SELECT byte-identical to `/community`?** Yes — verified with a script comparing extracted column lists; only difference is placeholder index (`$1` vs `$2`), semantics identical.
5. **Tests trivial?** No. Owner test asserts the positive presence of `version`/`source_page`/`comment_count` AND absence of `is_mine`; anonymized test uses two real registered users and asserts `version === undefined` plus full-payload `assertAnonymized`; the just-filed test reproduces the exact regression (filtered `/mine` returns empty, id read still resolves).

## Findings

### BLOCKER
None.

### SHOULD-FIX
- **S1 — SELECT-list parity is by convention, not construction.** The anonymity contract now lives in 4 hand-copied column lists (`/mine`:157-160, `/community`:207-210, owner probe:255-258, community detail:292-295). Nothing structural ties `/:id`'s anonymized list to `/community`'s — a future edit adding a column to one copy silently forks the shapes, and only `assertAnonymized` (a substring blacklist, see N1) stands between that and an identity leak. Extract shared SQL fragments (e.g. `OWNER_COLS` / `COMMUNITY_COLS` template constants) or add a test that asserts the `/:id` non-owner payload's key set equals a `/community` row's key set. Current state is correct; the risk is drift.

### NIT
- **N1 — `assertAnonymized` is substring-based** (`tickets.test.ts:41-46`): `JSON.stringify(payload)` must not contain `user_id`/`userId`/`email`. Pre-existing helper, not introduced by this diff — but note (a) a ticket body containing the literal word "email" would false-fail, and (b) an author id leaked under a differently named key (e.g. `owner`, `author_id` → contains `user_id`? no — `author`) would pass. A key-set allowlist assertion would be stronger. Fine to defer; flagged for awareness.
- **N2 — No explicit non-numeric-id test** (e.g. `GET /tickets/abc` → 400). The overflow test exercises the same validator, and route-literal cases are covered indirectly, so coverage is adequate — a one-liner would make the contract explicit.
- **N3 — Two sequential queries** (owner probe → community fetch) instead of one. Benign: the only race outcome (ticket deleted between queries) degrades to a truthful 404. The two-query form keeps `user_id` out of the app layer entirely on the community path, which is arguably the safer posture. No change requested.

### PRAISE
- **P1** — Ownership decided in SQL, mirroring PATCH's pre-read posture (`tickets.ts:261` vs `tickets.ts:347`); no client-influenced branch selects the owner shape.
- **P2** — The absence of `version` as the client's "view-only" signal is documented at the query site (`tickets.ts:271-279`) and asserted in tests (`tickets.test.ts:375-377`) — the contract is executable, not just commented.
- **P3** — The regression test (`tickets.test.ts:332-352`) reproduces the actual user-visible bug (filtered list hides a just-filed ticket) rather than a synthetic happy path.
- **P4** — 404-not-403 and the 20-digit-id → 400 posture are consistent with every other route in the file; no new existence oracle introduced.

## Test run

```
npx vitest run tests/routes/tickets.test.ts
Test Files  1 passed (1)
Tests       41 passed (41)   — 0 failed
Duration    46.67s (real Postgres testcontainer)
```
