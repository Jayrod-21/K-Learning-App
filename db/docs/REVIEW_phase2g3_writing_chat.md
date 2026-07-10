# REVIEW — Phase 2 Group 3: writing-prompt randomization (B-027) + chat auto-naming/attach (F-036/F-035, migration 055)

**Branch:** `feat/phase2-g3-backend-logic`
**Reviewer:** independent senior review (did not author this code)
**Date:** 2026-07-10
**Scope:** `server/src/routes/writing.ts` (GET /writing/prompts/random), `server/src/routes/conversation.ts` (POST /:id/name, PATCH /:id, POST /:id/file), `server/src/services/docAttach.ts`, `db/migrations/055_conversation_titles.{up,down}.sql`, `db/tests/test_migration_055.py`, `server/tests/routes/writing.test.ts`, `server/tests/routes/conversation.test.ts`

## Verdict

**PASS — 0 BLOCKERS, 2 SHOULD-FIX, 5 NIT, plus coordination items.**

The security posture of the document-attach path is real, not decorative: every claim in the `docAttach.ts` threat-model header was verified against the code that enforces it, including the non-obvious one (the upload-time prompt-injection guard exists because `generateConversation` re-sanitizes **every** persisted history turn on every later send — `services/claude/index.ts:680-685` — so a poisoned stored turn really would wedge the conversation permanently). The auto-name flow cannot clobber a user rename and cannot re-spend Claude. Migration 055 is ADR-013-compliant, idempotent, and reversibly tested against the real chain.

## Gates (targeted, per instructions — no full suite)

```
npx vitest run tests/routes/writing.test.ts tests/routes/conversation.test.ts
Test Files  2 passed (2)
Tests       93 passed (93)     (260s, real Postgres testcontainer)
```

Note: `npm ci` failed with sandbox EACCES unlinking inside the existing `node_modules`; the suite was run against the already-present install (397 packages), which is the same tree CI would rebuild.

---

## Feature 1 — B-027: GET /writing/prompts/random

### Findings

**PRAISE** — `server/src/routes/writing.ts:144-191`. The contract asked for is exactly what ships: `rubric` is **required** (schema at :144-146; missing or invalid → 400 via `validateQuery`, tested at `writing.test.ts:203-215`), the pick is uniformly random server-side (`ORDER BY random() LIMIT 1`, :173-180 — fine and documented for a single-digit pool), and an empty pool is a 404 `NotFoundError`, never a null-200 (:182-185, tested at `writing.test.ts:217-233`). The predicates match the list endpoint (`is_active AND rubric = $1`), the query is parameterized, and the DTO is shared with `/prompts` (:89-99) so the wire shapes cannot drift apart.

**PRAISE** — `server/tests/routes/writing.test.ts:186-201`. The randomness test is statistically honest: 40 draws over a 3-prompt pool, P(all identical under uniform) ≈ 8e-19, with the reasoning written into the test. `writing.test.ts:235-254` additionally pins that a retired prompt never surfaces over repeated draws, and the pool tests assert against the **real** migration-038 seed rather than fixtures (per the project's real-corpus-data rule).

**COORDINATION** — the endpoint has **no client caller yet**. `client/src/pages/Writing.tsx:167-170` still initializes the per-rubric rotation cursor to 0 and `:228` indexes the deterministic `/prompts` list, so the user-visible B-027 symptom (same prompt on every visit) persists until the client is wired to `/prompts/random`. Acceptable for a backend-logic branch, but B-027 must not be closed in `BUGS_AND_FEATURES.md` until the client PR lands, and the client work should be on a roadmap line.

**NIT** — `writing.ts` and `conversation.ts` now each carry an identical private `mapClaudeError` (writing.ts:331-338, conversation.ts:1107-1114), which the comments admit also mirrors grammarDrill/diagnostic/images. Five copies is past the rule-of-three; hoist to `middleware/errors.ts` or a shared helper on the next sweep.

---

## Feature 2 — F-036: auto-naming + rename (+ migration 055)

### Route findings (`server/src/routes/conversation.ts`)

**PRAISE** — the no-clobber / no-re-spend contract is enforced twice, correctly:
- Fast path: `conversation.ts:1032-1035` returns the existing title with `generated:false` **before** any Claude call when `title !== null`.
- Race path: the write itself is guarded — `UPDATE … WHERE … AND title IS NULL` (:1068-1074) — so a rename (or competing auto-name) that lands between the read and the write wins, and the lost-race branch re-reads and returns the survivor (:1083-1094). PATCH (:972-978) sets title unconditionally, so the user always wins, including over a prior auto-title.
- Tests pin both with a **call counter** rather than DB state (`conversation.test.ts:40-47, 794-828`), which is the only way to observe "no second Claude spend" — a benign clobber would leave no DB trace. Good instinct, explicitly documented in the test header.

**PRAISE** — deliberate decision not to bump `version` on title writes (:951-957, :1006-1007): `version` is the messages-array OCC token, and bumping it on a cosmetic rename would 409 in-flight sends. Tested at `conversation.test.ts:781-792`. IDOR posture is uniform: every query is `user_id`-scoped, foreign/missing/swept ids → 404 with zero Claude spend (tested :851-879), and the empty-conversation 409 fires before any spend (:842-849).

**PRAISE** — layered length authority is coherent: generated titles capped at 80 (`ConversationTitleSchema`, `models.ts:570-575`), user renames at 120 (`TitleBodySchema`, conversation.ts:941-948), DB CHECK at 200 (migration 055) — app caps strictly tighter than the DB constraint, per the house rule.

**NIT** — `conversation.ts:1043`: the per-turn excerpt `content.slice(0, NAME_TURN_MAX_CHARS)` can split a surrogate pair (lone surrogate is later replaced with U+FFFD at HTTP encoding — harmless) or, if a turn's first 500 chars are all whitespace, produce content that fails `NonEmptyText` at the proxy's input parse and surfaces as a 502. Both are vanishingly rare; fold into the surrogate-safe-slice fix below if desired.

**NIT** — repeat calls to `POST /:id/name` on an already-named conversation are free (no Claude) but still debit `expensiveLimiter` (:1011). A client that calls name-on-open could 429 itself. Consider the cheap limiter with an internal spend gate, or accept and document.

### Migration findings (`db/migrations/055_*.sql`, `db/tests/test_migration_055.py`)

**PRAISE** — ADR-013 compliant: no top-level `BEGIN/COMMIT` (the `DO $$ … END $$` block at up.sql:59-70 is PL/pgSQL and passes the runner's detector per ADR-013 §Decision). The `ALTER TYPE … ADD VALUE IF NOT EXISTS` (up.sql:47) is legal inside the runner's transaction because nothing **uses** the value in-migration — the 021/016 gotcha is called out and respected (up.sql:23-30). Add-only nullable column, no default → no table rewrite; expand/contract and blue/green safe (up.sql:32-36).

**PRAISE** — reversibility is exactly the 031/032 posture: down drops the CHECK then the column (down.sql:22-23), documents the lossiness as acceptable (regenerable display label), and deliberately retains the enum value with the correct rationale (enum removal requires a type rewrite over `claude_cache.route`/`claude_usage.route`). `test_migration_055.py:271-309` proves the down runs on a **titled, non-empty** table without `--allow-destructive` (regression probe on the destructive-gate classification), that the enum value survives, and that re-up is clean. Idempotent re-apply of the raw body is tested at :252-264. The 031/032 defect class (enum value unusable → every cache/usage write fails) has a dedicated post-commit usability test (:229-249) plus the drift guard (`server/tests/db/claude_route_enum.test.ts:77-83`) pinning the enum to the code's `RouteName` union. `db/migrations/README.md:68` row is present and accurate.

**NIT** — the DB CHECK (`char_length BETWEEN 1 AND 200`) admits a whitespace-only title (`'   '`); only the app-layer `.trim().min(1)` blocks it. Given the single-writer app this is fine, but the CHECK could use `char_length(btrim(title)) >= 1` if the DB is meant to be the full authority the up.sql comment claims.

---

## Feature 3 — F-035: document attach (`docAttach.ts` + POST /:id/file)

### Security posture — verified claim by claim

**PRAISE** — this is a real defense-in-depth chain, and the one non-obvious design decision is the right one:

| Threat | Enforcement | Verified |
|---|---|---|
| MIME spoofing | declared-mime allowlist is early-reject only (`docAttach.ts:44-67`); the **byte** authority is `TextDecoder('utf-8', {fatal:true})` + explicit NUL reject (:135-140) | PNG-bytes-as-`text/plain` → 400, nothing persisted (`conversation.test.ts:1006-1024`) |
| Oversize | multer memory storage, 256 KiB `fileSize`, `files:1`, `fields:4` (:58-67); `LIMIT_FILE_SIZE` → typed **413** (:83-89) | 300 KiB → 413 (test :1026-1038) |
| Path traversal | filename is display-only, never a path: basename over both separators, control-strip, 120-cap, stable fallback (:178-185) | `../../etc/passwd.txt` → `passwd.txt` (test :962-975) |
| Prompt injection wedging later sends | `sanitizeUserInput` runs **at upload** (:151-162) — necessary because `generateConversation` re-sanitizes every stored history turn on every send (`services/claude/index.ts:680-685`); a poisoned persisted turn would otherwise throw there forever. Marker not echoed to the wire (:158-161) | injection doc → 400, marker absent from response, nothing persisted (test :1040-1063) |
| JSONB bloat / proxy wedge by length | excerpt capped at `DOC_TURN_MAX_CHARS` = 4000 (:56), which equals the `ConversationInputSchema` per-turn cap (`models.ts:520`) and sits under the route input cap default 8000 | truncation + flag tested (:945-960); post-attach send round-trips (:939-942) |
| IDOR / stale version | ownership + version pre-check **before** reading the payload does work (conversation.ts:1161-1173), re-gated inside the version-checked UPDATE (:1191-1206) | 404 foreign / 409 stale, nothing persisted (tests :1065-1113) |

The wedge-consistency question ("can a doc that passes upload fail a later send?") checks out: the stored text is post-NFC, post-control-strip, marker-checked with the same deterministic function later sends use, ≤4000 chars against a later per-turn cap of 4000 (Zod) and a sanitize cap defaulting to 8000. Re-sanitization is idempotent on its own output.

### Findings

**SHOULD-FIX (1)** — surrogate-pair split at the truncation boundary → 500 on a legitimate upload. `docAttach.ts:151`: `trimmed.slice(0, DOC_TURN_MAX_CHARS)` cuts on UTF-16 code units. If character 4000/4001 is astral (emoji, or CJK Extension B hanja — plausible in Korean-learning material), the excerpt ends in a **lone high surrogate**. `sanitizeUserInput` does not remove it (NFC leaves unpaired surrogates untouched; the control-char regex doesn't match it), `JSON.stringify` emits a well-formed-but-unpaired `\udXXX` escape, and Postgres **rejects unpaired surrogates in `::jsonb` input** — the insert at `conversation.ts:1191-1204` throws and the client gets an opaque 500 instead of a 201. Nothing corrupts (the transaction aborts), but a valid document is unusable with no actionable error. Fix: truncate on code points (e.g. iterate the string iterator, or drop a trailing high surrogate after slicing). The same pattern exists at `conversation.ts:1043` (`slice(0, 500)`, harmless — becomes U+FFFD at HTTP encoding) and the pre-existing `:327/:506` scenario `slice(0, 480)`; a shared `truncateCodePoints()` helper would close all of them.

**SHOULD-FIX (2)** — misleading rejection when NFC expands past the cap, and a wrong comment. `docAttach.ts:152-155` asserts "its maxLength can't fire (we just truncated)". That's false: `sanitizeUserInput` NFC-normalizes **before** its length check (`sanitize.ts:95-101`), and NFC can expand certain code points (composition exclusions, e.g. U+0958 → 2 code units). A 4000-char pre-NFC excerpt can exceed 4000 post-NFC, throw `PromptInjectionRejectedError`, and surface as the injection-flavored 400 "document contains content that cannot be sent to the tutor" for a document containing zero injection content. Behavior is safe (reject, nothing persisted) but the user-facing diagnosis is wrong and the code comment codifies the wrong invariant. Fix: normalize **then** truncate (which also composes with the SHOULD-FIX above), or catch the length case separately and reword.

**NIT** — operational coupling: later sends sanitize each history turn with `cfg.inputCaps.generate_conversation` (`index.ts:682-684`), env-tunable via `CLAUDE_MAX_INPUT_CONVERSATION` (default 8000, `config.ts:67`). An operator setting it below 4000 would retroactively wedge every conversation containing a doc turn — exactly the failure docAttach exists to prevent. Worth a startup assertion (`inputCaps.generate_conversation >= DOC_TURN_MAX_CHARS`) or at minimum a warning comment on the env schema line.

**NIT** — `.md` uploads depend on the browser declaring `text/markdown`; several platforms send `application/octet-stream` for `.md`, which the fileFilter silently drops (no `req.file` → 400 "missing or empty" — also a slightly misleading message for a file that WAS sent). The Phase-3 client should set `contentType` explicitly on the multipart part; alternatively accept a missing/octet-stream declared mime and let the byte authority decide.

**COORDINATION (out of slice, wedge-relevant)** — the **image** path persists OCR'd captions as turn `content` (`conversation.ts:876-887`) with **no** injection-marker guard anywhere in `imageIngest.ts` (grep confirms `sanitizeUserInput` is absent). A photographed page containing "ignore previous instructions" would persist and wedge later sends at `index.ts:682` — the exact scenario docAttach's header describes. Pre-existing Slice-1 behavior, not this branch's regression, and low severity in a single-user app, but the two attach paths now have inconsistent postures; the fix-pass owner for the image slice should apply the same upload-time guard (or a projectHistory-side drop).

**COORDINATION** — nginx: no action needed. `/conversation` and `/writing` are existing top-level prefixes already in the km-lb allow-list; no new prefixes ship in this slice (the F-012 `/ttmik`-class trap does not apply).

---

## Summary table

| # | Severity | Where | What |
|---|---|---|---|
| 1 | SHOULD-FIX | `docAttach.ts:151` | UTF-16 slice can strand a lone surrogate → pg `::jsonb` rejects → 500 on a legit 4000+-char doc with an astral char at the cut |
| 2 | SHOULD-FIX | `docAttach.ts:152-155` | NFC expansion can trip sanitize's maxLength → injection-flavored 400 for clean content; comment asserts the opposite |
| 3 | NIT | `config.ts:67` / `index.ts:682` | Env-lowered conversation input cap < 4000 would wedge doc-turn conversations; add startup assert |
| 4 | NIT | `docAttach.ts:61-67` | `.md` with octet-stream declared mime rejected before the byte authority runs; message says "missing" |
| 5 | NIT | `conversation.ts:1011,1043` | already-named /name path debits expensive limiter; 500-char excerpt slice shares the surrogate/whitespace edge |
| 6 | NIT | `writing.ts:331` + 4 siblings | fifth copy of `mapClaudeError`; hoist |
| 7 | NIT | `055_conversation_titles.up.sql:64-69` | CHECK admits whitespace-only titles; app layer is the only trim authority |
| — | COORDINATION | `client/src/pages/Writing.tsx:228` | `/prompts/random` has no caller; B-027 not user-visible-fixed until client wiring — don't close the bug yet |
| — | COORDINATION | `imageIngest.ts` (out of slice) | image OCR captions persist un-guarded → same wedge class docAttach defends against |

## Test evidence

- `server`: `npx vitest run tests/routes/writing.test.ts tests/routes/conversation.test.ts` → **93/93 passed** (2 files, real Postgres testcontainer, 260s).
- `db/tests/test_migration_055.py`: not run here (targeted server gates only, per review instructions — the migration suite needs its own testcontainer session); read-verified as covering shape, CHECK boundaries (empty/200/201), post-commit enum usability, idempotent re-apply, and down → re-up on the real chain with the correct `PRE_055 = "054"` predecessor.
