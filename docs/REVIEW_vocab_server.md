# REVIEW — vocab remove/clear, SERVER half (security focus)

Reviewer: independent senior security reviewer. Branch `feat/vocab-queue-clear` @ `7b24b1c`.
Scope: `server/src/routes/vocab.ts` (DELETE /vocab/cards/:cardId + POST /vocab/cards/clear) + `server/tests/routes/vocab.test.ts`.
Verification mode: READ-ONLY. Relied on orchestrator-confirmed green (server vocab.test.ts 125 passed; client 2246/0; tsc 0/0; lint 0). No test run executed (resource constraint; nothing needed runtime confirmation).

## Summary verdict

**PASS — 0 BLOCKER, 0 SHOULD-FIX, 3 NIT, 4 PRAISE.**
Both routes are soft-delete-only, session-user-scoped, vocab-deck-scoped, idempotent, parameterized, Zod-validated. `vocab_entries` is never written. Tests assert every bar item against a real DB (direct SQL post-conditions, not mocked), including cross-user 404 + untouched, hanja/grammar 404 + untouched, and word-survives.

## Bar checklist

| Bar item | Status | Evidence |
|---|---|---|
| Soft-delete only (`deleted_at`), never hard-delete | PASS | Single: `UPDATE vocab_cards SET deleted_at = COALESCE(deleted_at, now())` — `server/src/routes/vocab.ts:507-514`. Clear: `UPDATE … SET deleted_at = now()` — vocab.ts:560-568. No `DELETE FROM` anywhere in the diff. Tests confirm rows survive with `deleted_at` stamped — `server/tests/routes/vocab.test.ts:1284-1290`, 1381-1387. |
| Never touches `vocab_entries` | PASS | Both statements target only `vocab_cards`. Tests assert entry rows still exist after remove (vocab.test.ts:1293-1294) + after clear (vocab.test.ts:1389-1392). |
| User-scoped remove; cross-user → 404, no oracle | PASS | `AND user_id = $2` (vocab.ts:511), session-derived via `getUserId` (`server/src/middleware/auth.ts:52-58` — throws 401 if absent; never client-supplied). rowCount 0 → uniform `NotFoundError('vocab card not found')` (vocab.ts:515) for foreign / nonexistent / hanja / grammar ids — no existence oracle. Test: cross-user 404 + victim card still live — vocab.test.ts:1318-1332. |
| Clear only `WHERE user_id = $caller` | PASS | vocab.ts:563; only bind param is session user id (vocab.ts:569). Test: other user's card untouched + still served in their queue — vocab.test.ts:1398-1423. |
| Vocab-only scope (hanja + grammar excluded) | PASS | Shared constant `VOCAB_DECK_SCOPE_SQL = hanja_character_id IS NULL AND grammar_entry_id IS NULL` (vocab.ts:466-467) used by BOTH routes (vocab.ts:512, 565) — cannot drift apart. Matches/exceeds the due query's hanja exclusion (`c.hanja_character_id IS NULL`, vocab.ts:344); grammar exclusion is a documented deliberate decision (vocab.ts:455-461 — graduation owns that lifecycle). Tests: hanja card 404+live (vocab.test.ts:1334-1345), grammar card 404+live (1347-1358), clear leaves both untouched (1398-1423). |
| Idempotent | PASS | Single: `COALESCE(deleted_at, now())` matches an already-deleted row → 204, original timestamp preserved (vocab.ts:509, tested with timestamp-equality assertion vocab.test.ts:1300-1316). Clear: `deleted_at IS NULL` in WHERE → repeat honestly returns `{cleared: 0}` (vocab.ts:564, tested 1425-1435). |
| Parameterized SQL only | PASS | All client-influenced values are bind params (vocab.ts:513, 569). The only interpolation is the server-side constant `VOCAB_DECK_SCOPE_SQL` — no client input reaches SQL text. |
| Numeric id validation, non-numeric → 400 | PASS | `CardIdParamsSchema` = `z.coerce.number().int().positive().max(MAX_ID)` (vocab.ts:375-377; MAX_ID = MAX_SAFE_INTEGER prevents BIGINT overflow → 500, vocab.ts:45-49) via `validateParams` (`server/src/middleware/validate.ts:38-49` → ValidationError → 400). Test: `/vocab/cards/abc` → 400, unknown numeric → 404 — vocab.test.ts:1360-1365. |
| Suspended-cards-cleared decision documented + sensible | PASS | vocab.ts:535-538: suspension = pause WITHIN the set; clearing removes the set, so no zombie un-suspend into an emptied queue. Sensible. Test seeds a suspended card and asserts it clears (vocab.test.ts:1368-1387). |
| Removed card leaves GET /vocab/cards/due | PASS | Due query has `c.deleted_at IS NULL` (vocab.ts:340). Tests assert via the actual endpoint before/after (vocab.test.ts:1278-1297) and empty queue + total 0 post-clear (1394-1396). |
| Auth | PASS | `router.use(requireAuth)` (vocab.ts:24); both new routes in the 401 matrix test (vocab.test.ts:55-66). CSRF posture inherited: session cookie is `sameSite: 'strict'` (`server/src/auth/sessions.ts:192,203`). Rate limiting: `cheapLimiter()` on both (vocab.ts:499, 556). |
| Route shadowing | PASS | `POST /cards/clear` (literal) vs `POST /cards/:cardId/reviews` (extra segment) vs `POST /cards/init` — no overlap; a hypothetical `DELETE /cards/clear` 400s at Zod ("clear" not numeric). |

## Findings

### BLOCKER
None.

### SHOULD-FIX
None.

### NIT
1. **Entry-survives assertions check existence, not immutability** — `SELECT 1 FROM vocab_entries WHERE id = $1` (vocab.test.ts:1293, 1391) proves the row exists, not that it was unmodified (e.g. a `version` bump would pass unseen). Low risk — the routes' SQL statically targets only `vocab_cards` — but comparing the full row (or `version`) before/after would make the "word untouched" guarantee airtight against future refactors.
2. **`POST /vocab/cards/clear` accepts an arbitrary unvalidated body** — the body is ignored (only the session user id reaches SQL, vocab.ts:556-570), so there is no injection or mass-assignment surface; still, an explicit empty-body schema (or `.strict({})`) would document the contract the way `/cards/init` does (vocab.ts:577-581).
3. **Post-clear, grammar production cards still ride `GET /vocab/cards/due`** — by design (the due query includes grammar cards, vocab.ts:339-344; clear excludes them, vocab.ts:539-540, per the bar). The "queue is honestly empty" test (vocab.test.ts:1394-1396) holds only for pure-vocab decks. Server behavior is correct and bar-mandated; flag for the CLIENT reviewer: the clear-confirmation UX should not promise "your due list will be empty" to a user with live grammar drills.

### PRAISE
1. **`VOCAB_DECK_SCOPE_SQL` shared constant** (vocab.ts:463-467) — single-card and bulk routes structurally cannot drift on deck scoping; the classic bug class (clear wipes hanja deck after a later edit to one route) is designed out.
2. **`COALESCE(deleted_at, now())` idempotency** (vocab.ts:509) — retry-safe AND history-preserving; a retried DELETE cannot rewrite the original removal timestamp, and the test asserts exactly that (vocab.test.ts:1313-1315).
3. **Threat models written into the code** (vocab.ts:487-495, 545-554) — IDOR, blast radius, and injection surfaces enumerated per route with the defense named, matching the repo's standing security-documentation bar.
4. **Tests are adversarial, not trivial** — real testcontainer DB, direct SQL post-condition checks on victim rows (not just status codes), cross-user agents, all three foreign card classes (other-user / hanja / grammar) probed on BOTH routes, and end-to-end queue verification through the actual `GET /vocab/cards/due` endpoint.

## Detailed findings (file:line)

- `server/src/routes/vocab.ts:466-467` — deck-scope constant; server-side literal, no injection surface.
- `server/src/routes/vocab.ts:497-521` — DELETE /vocab/cards/:cardId. Zod-validated param (:375-377), session user (:503), parameterized soft-delete UPDATE (:507-514), uniform 404 (:515), 204 (:516).
- `server/src/routes/vocab.ts:556-575` — POST /vocab/cards/clear. Session user only bind (:558, :569), `deleted_at IS NULL` idempotency (:564), CTE `RETURNING 1` + `COUNT(*)::int` for an exact cleared count (:560-568).
- `server/src/routes/vocab.ts:339-344` — reference due query: `deleted_at IS NULL` guarantees removed/cleared cards leave the queue with zero additional code.
- `server/src/middleware/validate.ts:38-49` — validateParams → ValidationError → 400 path for non-numeric ids.
- `server/src/middleware/auth.ts:52-58` — getUserId from `req.user` (session), never client input.
- `server/src/auth/sessions.ts:192,203` — `sameSite: 'strict'` session cookie; CSRF on these state-changing routes mitigated platform-wide.
- `server/tests/routes/vocab.test.ts:1224-1269` — seed helpers insert real vocab/hanja/grammar cards via SQL (controllable due/suspended state).
- `server/tests/routes/vocab.test.ts:1272-1365` — single-remove suite: soft-delete + word-saved + queue-exit (1273), timestamp-preserving idempotency (1300), cross-user 404 + untouched (1318), hanja guard (1334), grammar guard (1347), 404/400 (1360).
- `server/tests/routes/vocab.test.ts:1367-1435` — clear suite: due+future+suspended all clear, words kept, queue empty (1368); hanja/grammar/other-user untouched with victim-row SQL checks (1398); repeat/empty clear → 0 (1425).
