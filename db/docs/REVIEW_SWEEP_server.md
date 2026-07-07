# RE-REVIEW — server-side bug-sweep fixes (independent verification)

Date 2026-07-06. Branch `fix/bug-sweep` (uncommitted). Reviewer did not author the fixes.
Method: read fix reports (`FIX_sweep_{critical,topik,routes,services}.md`) with skepticism,
verified every claim against the actual diff, traced adversarial scenarios, and
mutation-probed the two highest-risk fixes (reverted the fix, confirmed the new
regression test fails, restored, confirmed green).

Suite (specified docker command, full requested set): **237 passed | 4 skipped — GREEN.**
Post-probe restoration re-run (`topik.test.ts` + `claude/index.test.ts`): 92/92 GREEN.

---

## 1. CRITICAL — stream crash (`services/claude/index.ts`) — **HOLDS** (mutation-verified)

- `void sdkFinal.catch(() => undefined)` is attached synchronously, immediately after
  `client.stream(...)` destructuring — no code path exists between promise creation and
  observation. `.catch()` derives a separate promise, so the happy-path
  `await sdkFinal` at line 644 still receives the original resolution/rejection
  unchanged. On a mid-stream iterator throw, the rejection is pre-observed and the
  error surfaces solely through the worker's existing catch (queue `error` event +
  rejected `finalPromise`) — the path `routes/conversation.ts` already handles.
- Happy path verified unaltered: deltas → complete → cache write → usage row, all
  existing streaming tests pass.
- Test quality verified: the stub (`tests/services/claude/setup.ts` `streamError`)
  pre-observes only its OWN inner promise; `client.ts` derives a new promise via
  `.then(normalizeResponse)`, and that derived promise is what the test's
  `process.on('unhandledRejection')` probe watches. Not self-confirming.
- **Mutation probe:** removed the `.catch` line → exactly one test fails:
  `escaped = [ [Error: simulated mid-stream connection drop] ]` at
  `index.test.ts:429`. Restored → passes. The test genuinely pins the fix.
- Leaving `process.exit(1)` in the global `unhandledRejection` handler is defensible
  given `restart: unless-stopped` on all compose files.

## 2. HIGH — mock TOPIK-level merge (`topik.ts` `resolveMockTest`) — **HOLDS** (mutation-verified)

- `/mock` and `/mock/submit` call the SAME `resolveMockTest(section, sourceTest?, level?)`
  and both item queries filter `t.test_number = $1 AND t.topik_level = $2` with the same
  `ANSWERABLE_ITEM_SQL` + `ORDER BY item_number LIMIT 50`. Resolution is deterministic
  (highest test_number, TOPIK II over TOPIK I lexically).
- Level-less client cannot get a different paper on submit than on assembly: submit
  REQUIRES `sourceTest` (echoed from `/mock`), which pins the sitting; the level
  tie-break is deterministic and identical in both calls. The only flip vector is a
  new TOPIK II paper for the same sitting/section being INGESTED mid-exam —
  negligible for a personal app, noted only.
- F-007 resume: verified the client (`MockMode.tsx:233`) replays
  `fetchMockTest(section, signal, sourceTest)`; grep confirms **no non-test client
  code sends `topikLevel` anywhere** — the wire field is dormant, so resume
  deterministically re-fetches the identical paper today.
- **Mutation probe:** neutralized the submit item-query level filter
  (`t.topik_level = $2` → always-true) → the two submit-side D-1 tests fail
  (`totalItems` 4 vs 2 — the exact TOPIK I+II chimera). Restored → passes.
- **NEW FINDING (LOW-MED, latent — follow-up before any client-side level picker):**
  `topik_attempts` does not store `topik_level` and `AttemptBodySchema` has no field
  for it. The moment a client feature lets the user explicitly take a TOPIK I mock,
  (a) resume will re-fetch the TOPIK II paper of that sitting (picks keyed by item id
  won't match — broken resume, not a silent mis-grade), and (b) a client that sends
  `topikLevel` on `/mock` but omits it on `/mock/submit` will grade the wrong paper.
  Harmless today; must be fixed (persist level in the attempt row + client echoes
  level on submit) before exposing level selection.

## 3. F-UP-014 tombstone (`topik.ts`) — **HOLDS** (traced; race test verified present and pre-fix-failing per report)

Traced all requested scenarios against the actual SQL:

- **Can a legit new mock be blocked?** No stranding path found. `GET /attempt`
  reports a tombstone as `attempt: null` (no banner), `POST /mock` is untouched, and
  a save for a DIFFERENT `(source_test, section)` always passes the `WHERE NOT(...)`
  guard (test-pinned). Worst case: an immediate SAME-paper retake has a ≤15 s save
  blackout — each refused PUT is a silent 204, picks are re-sent cumulatively, so the
  first post-window save recovers everything. Only a crash inside that 15 s window
  loses those first few answers. Bounded, acceptable.
- **Can a stale save still resurrect?** Only if the racing PUT lands **>15 s** after
  submit (e.g. an offline queue replaying much later). Within the window — the actual
  race shape (ms–s) — it is refused. Accepted residual, documented in the code.
- **Unforgeable?** Yes — `AttemptBodySchema` picks keys are regex-bound `^\d+$`;
  `__closed__` from the wire → 400 (test-pinned). The tombstone is only ever written
  server-side inside the submit transaction.
- Correct auxiliary behavior: `DELETE /attempt` preserves only a FRESH tombstone
  (mop-up can't evict the guard) while still deleting live attempts and stale
  tombstones; the freshness check uses trigger-maintained `updated_at`; the stale-
  tombstone test correctly disables the trigger to backdate. Tombstone rows linger
  one-per-user until overwritten — harmless.

## 4. HIGH — cache TTL-0 (`services/claude/cache.ts`) — **HOLDS**

- Both impls route through one shared `expiryFor()`: `0`/negative/NaN → `null` →
  `put` returns before connecting (Postgres stub test asserts zero connects/queries);
  positive finite → real future `expires_at`; `CACHE_TTL_FOREVER` (Infinity) →
  `9999-12-31` timestamp, never NULL.
- `SELECT_SQL` now requires `expires_at IS NOT NULL AND expires_at > now()` → legacy
  NULL-expiry poison rows (incl. the colliding weak-key image_ocr rows) are immediate
  misses with no purge needed; `EVICT_SQL` additionally sweeps `expires_at IS NULL`
  so they self-heal out.
- Confirmed in `config.ts`: the 4 ttl-0 routes (`diagnostic_item`, `image_ocr`,
  `generate_grammar_drill`, `score_grammar_drill`) all default 0; **no code path uses
  `CACHE_TTL_FOREVER`**; the env schema (`int().nonnegative()`) cannot express
  Infinity, so forever-caching cannot be opted into accidentally.
- **Did anything rely on old ttl-0-forever behavior?** Behaviorally yes, but wrongly:
  those 4 routes previously got free (and for image_ocr, potentially WRONG) cache
  hits on repeats. Post-fix every repeat spends a Claude call — a deliberate
  cost/perf change matching the documented "0 = no caching" intent. Also note: an
  operator who set a `CLAUDE_CACHE_TTL_*_S=0` env override meaning "forever" now
  gets "uncached" — defaults are unaffected. Nit (accepted): `get()` still runs a
  guaranteed-miss SELECT per request on ttl-0 routes.
- Hit-count accounting (#7) and the in-memory mirror verified consistent.

## 5. Batch B behavioral route changes — **HOLDS**, with notes

| Change | Verdict | Detail |
|---|---|---|
| `progress.ts` `LEAST(sum, 9999.99)` | HOLDS | Saturation only above 9999.99 min/day (~167 h — unreachable legitimately). No silent data loss that matters: the `activities` array still appends every log entry, so the full trail survives even at the cap; pre-fix the row 500'd for the rest of the day. Real-date refine (rejects 2026-02-30 etc.) is correct incl. leap years. |
| `conversation.ts` SSE AppError-only | HOLDS | Legit errors still informative: `ConflictError` ("stale conversation version") is an AppError and rides the wire; mid-stream Claude proxy failures reach the client through the UNCHANGED `ev.type === 'error'` queue path with `code` + `message`; non-AppError persistence failures → generic message **plus `recovered_text`**, so the client can still render/save/retry. Raw pg/driver detail now log-only — correct. **Residual (documented skip):** the proxy event frame at ~line 504 still ships raw `ev.message` from the services layer — recommend a follow-up in services scope. |
| `vocab.ts` `/vocab/mine` COALESCE | HOLDS (design note) | `vocab_entries` has no owner column — rows are shared by `(corpus, source_id)`, so "update your OWN gloss" is not representable; existing-wins is the only safe rule without schema change. User-visible change: re-mining a word with a corrected gloss silently keeps the old one, and no other gloss-edit path exists. Acceptable at personal scope; follow-up (owner column or explicit edit endpoint) if gloss correction matters. |
| `auth.ts` `finishLogin` full shape | HOLDS | Re-reads `id, email, display_name, phone, version` with `deleted_at IS NULL` BEFORE minting the session; vanish → opaque 401 ("invalid credentials", no enumeration signal). Nullable fields (`display_name`, `phone`) are typed nullable — same shape as `/auth/me`, matching the client's `LoginResponse`. BIGINT-as-string id → `Number()`. All 3 branches share it. One extra SELECT per login — negligible. |
| `db/pool.ts` `release(err)` | HOLDS | `releaseOnce()` guarantees exactly one release (pg throws on double-release). Destroy only when ROLLBACK itself failed (connection demonstrably suspect); ROLLBACK-succeeded and happy paths still re-pool. BEGIN-failure and COMMIT-failure paths traced — both end in exactly one release of the right kind. Non-Error throw wrapped. |

Spot-checked the rest of the batch (not in scope but adjacent): `health.ts` fixed
`'fail'` string, `grammarDrill.ts` round+clamp with response echoing the PERSISTED
score, `gradeWriting.ts` `max(1, round(maxTotal))` + structured warn, `kiwi.ts`
accurate `'kiwi <status>'` rethrow, numeric bounds (INT4 vs MAX_SAFE_INTEGER) applied
to the correct column types throughout. No regressions found.

---

## New findings (by severity)

1. **LOW-MED (latent):** `topik_attempts` has no `topik_level` — resume and submit of
   an explicitly-selected TOPIK I mock will target the wrong paper the day a client
   level picker ships. Dormant today (client never sends `topikLevel`). Track as a
   precondition for any level-selection feature. (§2)
2. **LOW:** proxy stream `ev.message` still ships raw upstream error text over SSE —
   the one redaction site left open (documented as services-scope skip). (§5)
3. **NOTE:** 4 ttl-0 Claude routes now genuinely uncached → repeat calls cost tokens
   where the bug previously served (sometimes wrong) free hits; env `TTL=0` override
   semantics flipped from "forever" to "uncached". Intended. (§4)
4. **NOTE:** same-paper immediate-retake saves are silently absorbed for ≤15 s after
   submit; a crash in that window loses those saves. Bounded, documented. (§3)

## Verdict: **SHIP**

All five high-risk fixes hold. Both mutation probes confirmed the regression tests
fail without their fixes (stream-crash test: unhandled rejection escapes; level-merge
tests: 4-item chimera graded). Full requested suite green (237 passed | 4 skipped);
tree restored byte-identical after probes and re-verified green. No mis-grade,
stranding, or data-loss path found in the shipped state. Items 1–2 above are
follow-ups, not blockers.
