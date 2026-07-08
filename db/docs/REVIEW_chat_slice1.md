# Review — Chat Rework Slice 1 (server + data)

- **Commit:** `833884d` on `feat/chat-rework`
- **Spec:** `db/docs/CHAT_REWORK_DESIGN.md` §Slice 1
- **Reviewer:** independent senior review (backend/security focus)
- **Build/tests:** `tsc --noEmit` clean (STC=0); `tests/routes/conversation.test.ts` + `tests/routes/images.test.ts` → 61/61 passed in Docker (node:20-slim, testcontainer Postgres)

## Verdict

**APPROVE — 0 blockers.** The security-sensitive surfaces (IDOR, image upload, Vision budget, retention) are correctly implemented and consistent with the codebase's existing hardening patterns. Two SHOULD-FIX items, both about *guarding* properties that are currently correct in code but not fully pinned by tests / accounting.

---

## Findings

### BLOCKER

None.

### SHOULD-FIX

**SF-1 — The "no Vision spend" tests don't actually observe the Vision call.**
`server/tests/routes/conversation.test.ts:630` ("IDOR … spends no Vision budget"), `:609` (409 stale), `:586` (429 cap), `:555` (no file) all assert only DB state (`image_captures` count = 0, version unchanged). The stub proxy's `ocrImage` (`server/tests/helpers/app.ts:145`) is not call-counted, and a Vision call leaves **no DB trace** (it happens before any persist). So if a future refactor reorders the gates — e.g. moves `ocrUploadedImage` above the conversation ownership/version pre-check in `server/src/routes/conversation.ts:832-847` — every one of these tests would **still pass** while the security property (attacker can't burn Vision budget via a foreign id or stale version) silently regressed. The code today is correct (404/409/429/400 are all thrown before `ocrUploadedImage` is reached), but the tests don't pin it. Fix: wrap the stub's `ocrImage` in a counter (or expose a `calls` array from `buildTestApp`) and assert `ocrImageCalls === 0` in the 404/409/429/no-file tests, and `=== 1` in the happy path.

**SF-2 — Version-race rollback makes the daily Vision cap under-count on the chat path.**
The daily cap (`server/src/services/imageIngest.ts:257-267`) counts **persisted** `image_captures` rows. On `POST /conversation/:id/image`, a Vision call whose subsequent version-gated UPDATE loses the race is rolled back **including its capture row** (`server/src/routes/conversation.ts:849-884`) — so that Vision call never counts against the cap. K concurrent uploads carrying the same `expected_version` = K Vision calls, 1 counted. `/images/ocr` doesn't have this (no version gate; every Vision call persists). The same file's own comment ("deleting captures must not reset the budget", `imageIngest.ts:31-32`) argues rolled-back attempts should count too. Severity is low: amplification is bounded by `expensiveLimiter`, requires racing your **own** conversation (no cross-user angle), and this is a single-user personal app. Options: count attempts in a side table outside the tx, or accept and document the bounded slack. Worth a code comment at minimum.

### NIT

**N-1** — `server/src/routes/conversation.ts:842` (and `:757`): tiny race window between the cheap pre-check and the in-tx version gate where a concurrently swept/soft-deleted conversation surfaces as **409** ("stale conversation version") instead of 404. Harmless and self-healing (the retry's pre-check 404s); noting for completeness.

**N-2** — `GET /conversation/:id` returns the stored `messages` verbatim, including internal `request_id` idempotency markers on assistant turns. Owner-only and random, so no security impact, and the client type (`StoredConversationTurn.request_id?`, `client/src/types/domain.ts`) shows it's deliberate — but it is internal bookkeeping on the wire.

**N-3** — `Number(capture.id)` / `Number(conv.id)` (`conversation.ts:855`, `:745`): BIGINT-as-string coerced to JS number. Fine below `MAX_SAFE_INTEGER` (identity columns on a single-user app will never get close), and the code comments acknowledge it. Consistent with the pre-existing POST /conversation contract.

**N-4** — Orphaned blob **file** on a version-race rollback (`saveBlob` runs before the inserts inside the tx; the file write itself isn't transactional). Explicitly documented as GC-able (`imageIngest.ts:315-317`) and identical to `/images/ocr`'s DB-failure posture — but no GC job exists anywhere in the repo. A periodic orphan sweep is a reasonable future follow-up.

**N-5** — Commit message says "20 image tests unchanged"; `tests/routes/images.test.ts` actually runs 19 (61 total − 42 conversation). Cosmetic.

**N-6** — The multipart body (up to 8 MiB) is buffered into memory by multer *before* the conversation ownership check (middleware order: `validateParams` → `multerImageUpload` → `validateBody` → handler). No Vision spend and bounded by `limits.fileSize` + `expensiveLimiter`, and `/images/ocr` has the same shape — acceptable, just noting the ordering is upload-bandwidth-first by necessity (the `expected_version` field only exists after the multipart parse).

### PRAISE

**P-1 — Gate ordering on the image endpoint is exactly right.** Auth (`router.use(requireAuth)`, `conversation.ts:84`) → id validation (400, int8-bounded at `:118-122`) → conversation ownership + `deleted_at IS NULL` (uniform 404, `:832-841`) → version pre-check (409, `:842-844`) → file presence/magic-byte sniff (400) → daily cap (429) → only then the Vision call — with the version gate re-run **inside** the transaction (`:863-871`) so the pre-check is an optimization, not the defense.

**P-2 — The extraction is genuinely behavior-identical.** Verified line-by-line against `833884d~1:server/src/routes/images.ts`: same multer config (memory storage, 8 MiB, `files:1`, `fields:4`, non-throwing fileFilter), same magic-byte sniff constants, same cap query (counts soft-deleted rows, `date_trunc('day', now())`), same error mapping (the old `next(mapClaudeError(err)); return` became `throw mapClaudeError(err)` — equivalent through the route's catch), same tx boundary (blob write inside), same DTO construction and 201 envelope. `tests/routes/images.test.ts` is untouched by the commit and passes.

**P-3 — The retention sweep predicate exactly matches the pre-existing partial index** `ix_conversations_user_updated (user_id, updated_at DESC) WHERE deleted_at IS NULL` (`db/migrations/001_core_schema.up.sql:533-535`) — no perf concern, and the `deleted_at IS NULL` clause makes the sweep idempotent by construction (a swept row leaves the predicate, confirmed by the stamp-preservation test at `conversation.test.ts:454-477`).

**P-4 — The backdate test helper is non-vacuous and says why.** `backdateConversation` (`conversation.test.ts:40-58`) disables `trg_conversations_updated_at` in a try/finally, with a comment explaining that a plain UPDATE would be silently undone by the trigger and the test would pass vacuously. That is the correct way to simulate age: real rows age naturally because `updated_at` only bumps on writes.

**P-5 — `projectHistory` needed zero changes for image turns** — `content` carries the OCR'd Korean text with a guaranteed-non-empty fallback chain (`imageTurnContent`, `conversation.ts:898-911`), so image turns flow into Claude history through the existing string-content projection, and every pre-existing text turn remains a valid `StoredTurn` (both new fields optional).

---

## Probe answers (definitive)

1. **IDOR / cross-user access: NONE.** Every conversation query in both new routes binds `user_id = $2` from the session (`conversation.ts:738-742`, `:834-838`, plus `user_id = $3` inside the UPDATE at `:866`) and filters `deleted_at IS NULL`; foreign/missing/swept ids all produce an indistinguishable 404 (never 403). `MessageParamsSchema` rejects garbage and int8-overflow ids with 400. There is no query path where the id reaches SQL unbound from the session user.

2. **Vision budget before cheap gates: NO.** All cheap gates (401 auth, 400 id, 404 ownership, 409 stale version, 400 no-file/sniff, 429 daily cap) precede `proxy.ocrImage`. The daily cap IS enforced on the chat path (shared `ocrUploadedImage`). Residual: SF-1 (tests don't pin the ordering) and SF-2 (race-rollback under-counts the cap by a bounded factor).

3. **Version race → orphaned capture: NO.** `persistCapture` runs on the tx client; a `rowCount === 0` on the version-gated UPDATE throws `ConflictError` inside `withTransaction`, whose catch issues `ROLLBACK` (`server/src/db/pool.ts:150-152`) — the `image_captures`/`image_words` rows are undone. Only the blob **file** survives (N-4, documented, same as the pre-existing /images/ocr posture).

4. **`/images/ocr` behavior-identical after extraction: YES** (see P-2). Same gates, same order, same cap semantics, same 400/413/429/502 mapping, same tx boundary, same response envelope; the untouched image test file passes.

5. **Retention sweep user-scoped + correct: YES.** `WHERE user_id = $1 AND deleted_at IS NULL AND updated_at < now() - interval '30 days'` — parameterized, user-bound (the user-scoping test at `conversation.test.ts:479-495` proves listing as B leaves A's stale row live), idempotent, runs before the list SELECT, and covered by the partial index. The `set_updated_at` trigger bumps `updated_at` on swept rows, which is inert (they've left every reader's predicate), and the trigger-disable in tests is the valid — indeed the only non-vacuous — way to backdate. `deleted_at` pre-exists in migration 001; the image ref lives in the `messages` JSONB — **no migration needed, confirmed.**
