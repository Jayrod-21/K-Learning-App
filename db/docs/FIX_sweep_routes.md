# FIX — Sweep batch: server routes (all `server/src/routes/*.ts` except topik.ts)

Date 2026-07-06. Scope: route files + `server/tests/routes/`. Sources:
`SWEEP_server_routes.md`, `SWEEP_data_corpus.md` (route-level guards),
`SWEEP_server_services.md` (route-file findings only), `SWEEP_client_contracts.md` #16
(server-side fix). diagnostic.ts touched ONLY for sweep findings — F-011 code untouched.

## Fixed (each with a regression test that fails without the fix)

| Finding | Disposition | Fix | Test |
|---|---|---|---|
| routes #1 — study-log accumulator overflows NUMERIC(6,2), poisons the day's row | FIXED | `progress.ts`: upsert now `LEAST(sum, 9999.99)` (`MINUTES_STUDIED_MAX`, bound as `$5::numeric`) — saturates instead of 500ing; later logs that day keep working + activities keep appending | `progress.test.ts` "accumulator saturation": 7×1440 min all 201, value capped 9999.99, 8th log still 201, activities length 8 |
| routes #2 — study-log `date` regex admits 2026-02-30 → pg 500 | FIXED | `progress.ts`: `isRealCalendarDate` refine (Date.UTC round-trip; rejects year 0 / years <100) on top of the shape regex | `progress.test.ts`: 2026-02-30 / 2026-13-01 / 0000-01-01 / 2025-02-29 → 400 `validation_error`; 2024-02-29 → 201 |
| routes #3 — unbounded `z.coerce.number().int().positive()` ids overflow int8/int4 → 500 | FIXED | `.max(Number.MAX_SAFE_INTEGER)` (BIGINT cols) / `.max(2_147_483_647)` (INTEGER cols) added at: `vocabLists.ts` (list id, entryId, seed_entry_ids[], entry_ids[], both offsets), `images.ts` (:id), `grammar.ts` (kgiu :id, bank :id, offset), `grammarDrill.ts` (attemptId), `conversation.ts` (conversationId, expected_version→INT4), `diagnostic.ts` (runId, responseId), `vocab.ts` (cardId, entryId, krdictEntryId, duration_ms→INT4, expected_version→INT4, 2 offsets), `krdict.ts` (offset), `auth.ts` (PATCH /me expected_version→INT4) | `vocabLists.test.ts` class test: `GET /vocab/lists/99999999999999999999` → 400; `entry_ids: [1e20]` → 400 |
| data D-4 — diagnostic serves 60 glyph-option (①②③④) unanswerable items | FIXED | `diagnostic.ts` `pickTopikRow`: added `AND i.options->>0 NOT IN ('①','②','③','④')` — now matches topik.ts `ANSWERABLE_ITEM_SQL` exactly | `diagnostic.test.ts` "glyph-option items excluded": only topik row is a glyph item → reading dimension skipped, 0 topik responses recorded |
| services #3 — grammarDrill submit inserts fractional Claude score into INT column → whole tx rolls back post-paid-call | FIXED | `grammarDrill.ts`: `score = min(100, max(0, round(scored.score)))` before UPDATE; response echoes the persisted value (mirrors gradeWriting) | `grammarDrill.test.ts` "fractional score": stub returns 87.5 → 200, row + response = 88 |
| services #8 — gradeWriting `maxTotal` 0.4 rounds to 0 → CHECK trips → attempt silently dropped | FIXED | `gradeWriting.ts`: `maxTotal = Math.max(1, Math.round(...))` + structured warn when normalized | `gradeWriting.test.ts` "near-zero maxTotal": grade response untouched (0.4), row persists max_total=1, total_score=0 |
| routes #4 — /health echoes raw pg error (host/port/db leak, unauthenticated) | FIXED | `health.ts`: `db: 'fail'` fixed string; detail stays in the warn log | `health.test.ts` DB-error test updated: `db === 'fail'`, wire contains no ECONNREFUSED/127.0.0.1/db name |
| routes #5 — conversation SSE error frames ship raw `err.message` (schema/constraint names) | FIXED | `conversation.ts`: both SSE catch sites send `err.message` only for `AppError` (server-authored); otherwise fixed `'persistence failed'` / `'stream failed'`; raw detail log-only; `recovered_text` kept | `conversation.test.ts` "REDACTED error frame": BEFORE-UPDATE trigger raises `SECRET_INTERNAL_DETAIL…` → frame has `persistence_error` + `"persistence failed"` + `recovered_text`, leak string absent from wire |
| routes #6 — /vocab/mine lets any user overwrite the shared gloss | FIXED | `vocab.ts` upsert: `english = COALESCE(vocab_entries.english, EXCLUDED.english)` — existing gloss wins, re-mine only FILLS a NULL | `vocab.test.ts`: user B re-mines with different english → original kept; NULL gloss still fillable |
| client-contracts #16 — login/TOTP/enroll `user` narrower than `LoginResponse` type | FIXED (server-side) | `auth.ts` `finishLogin`: re-reads full public row (`id,email,display_name,phone,version` — same as /auth/me) BEFORE minting the session (soft-delete recheck, opaque 401 on vanish); all 3 branches (login, /login/totp, MFA-enroll confirm) now return the full shape | `auth.test.ts` "public user payload": login response carries display_name/phone/version |

## Skipped (with reason)

| Finding | Why skipped |
|---|---|
| routes #7 — rate limiters run after `requireAuth`, unauth probes never counted | Real fix needs an IP-keyed pre-auth limiter → `middleware/rateLimits.ts` (NOT my files). Reordering in route files alone would mis-key buckets. Owner: middleware agent. |
| services #9 — images.ts daily Vision cap check-then-act race | Routes sweep itself judged it "not worth a finding" (limiter bounds the overshoot); correct fix = lock/counter held across a multi-second Vision call or schema-backed counter — disproportionate for single-user cost control. Left as documented TOCTOU. |
| data D-2 / D-5 — placeholder-stem + withheld-passage items pass ALL guards (incl. topik's) | Fix belongs in the SHARED guard/data (topik.ts `ANSWERABLE_ITEM_SQL` + corpus flags) — topik.ts and data are other agents' scope. D-4 (glyph, diagnostic-only gap) fixed here. |
| data D-1 / services #4 — mock merges TOPIK I+II levels | topik.ts + `topik_attempts` schema — out of scope (topik.ts excluded). |
| routes sweep conversation.ts:504 error frame (`ev.message` from proxy stream events) | Not in the sweep findings; message originates in services/claude event construction (services scope). Route-level frames (#5's two sites) redacted. |

## Verify

`tsc --noEmit` STC=0; `vitest run tests/routes` — result in final agent message.
