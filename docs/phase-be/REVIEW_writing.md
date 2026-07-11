# Independent review — Writing scope (F-106 attempts, F-117 free_write rubric, migration 056)

**Branch:** `feat/phase-be-lightup` vs `origin/rebuild`
**Reviewer:** independent senior reviewer (report-only, no code modified)
**Scope:** `server/src/routes/writing.ts`, `server/src/routes/gradeWriting.ts`,
`db/migrations/056_writing_rubric_widen.{up,down}.sql`,
`db/tests/test_migration_056.py`, `server/src/services/claude/models.ts`
(`WritingGradeRubricSchema`), `server/src/services/claude/prompts/grade_writing.ts`,
`client/src/services/writing.ts` (+ test), `client/src/pages/Writing.tsx` (+ test),
`client/src/types/domain.ts` (`WritingRubric` / `WritingAttemptDTO`).

## Verdict: PASS — 0 BLOCKERS

This is a clean, well-scoped mini-phase. `GET /writing/attempts` is correctly
user-scoped and parameterized; migration 056 is a textbook additive CHECK
widen with an honest, dual-tested rollback gate on both tables; and the
`free_write` rubric is a genuinely distinct, independently-weighted rubric,
not a relabeled Q54 fallback. No scope creep found — every file touched maps
to F-106/F-117/056. 2 SHOULD-FIX and 3 NIT findings below, none blocking.

---

## Security checklist

| Check | Status | Evidence |
|---|---|---|
| `GET /writing/attempts` requires auth | PASS | `router.use(requireAuth)` at `writing.ts:56`, applies to all routes in the file including `/attempts`. Test: `writing.test.ts:425` (`unauthenticated → 401`). |
| User-scoped (no IDOR) | PASS | `WHERE user_id = $1` bound to `getUserId(req)`, never a client-supplied id (`writing.ts:350-361`). Cross-user test: `writing.test.ts:522` seeds two users, asserts each sees only their own row. |
| Parameterized SQL | PASS | All values passed via `$1/$2/$3` placeholders (`writing.ts:354-361`); no string interpolation into SQL anywhere in scope. |
| Input validation (zod) at the edge | PASS | `AttemptsQuerySchema` (`limit` 1..100 default 20, `offset` nonnegative default 0) via `validateQuery` (`writing.ts:283-286`); `GradeSchema` is `.strict()` with bounded strings/enums (`gradeWriting.ts:47-60`). Both 400 on violation, tested (`writing.test.ts:557`, `gradeWriting.test.ts:94-114`). |
| Rate limiting | PASS | `/attempts` rides `cheapLimiter()` (single indexed SELECT); `/grade-writing` sits behind `cheapLimiter → requireAuth → expensiveLimiter`, matching the documented F-UP-018 ordering rationale (per-user keying must follow auth). |
| Prompt-injection surface on the grader | PASS | User `sample`/`prompt` text is wrapped via `wrapUserInput` inside a `<user_input>` block (`grade_writing.ts:228`) with an explicit system-prompt instruction to treat it as data, never instructions (`grade_writing.ts:43-44`). |
| Response never leaks server internals | PASS | `gradeWriting.ts:163-169` maps any B4/proxy error with an `httpStatus` to a generic `UpstreamError` with a fixed code+message; nothing from the upstream body free-rides into the client response. |
| Free-form output rendered safely on client | PASS | All grader/Claude text (evidence, improvements, comments, prompts) renders via React text children only; no `dangerouslySetInnerHTML` anywhere in `Writing.tsx`. |
| `location.state` (F-101 deep link) treated as untrusted | PASS | `readGeneratedTopic` (`Writing.tsx:254-272`) narrows every field at runtime; a malformed payload falls back to the bank flow rather than crashing or lying about types. Tested: `Writing.test.tsx:652` (malformed payload → falls back). |

No cross-user leak path found. No SQL injection surface found (every query in scope is parameterized). No blocker-level security finding.

## Migration checklist (ADR-013)

| Check | Status | Evidence |
|---|---|---|
| No top-level `BEGIN`/`COMMIT`/`ROLLBACK` in either file | PASS | Neither `056...up.sql` nor `056...down.sql` contains transaction-control statements; both files explicitly document "runner owns the transaction" at their tail (`up.sql:55`, `down.sql:47`). `discover_migrations`'s `contains_top_level_tx_control` gate (ADR-013) would reject them at load time if they did — and the full 64/64 migration suite is reported green. |
| Pure widen, no data mutation | PASS | `up.sql` only does `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` (widened `IN (...)` list) + `COMMENT ON COLUMN` on both tables. No `UPDATE`/`INSERT`/`DELETE`. Confirmed by `test_migration_056.py::test_056_up_preserves_rows_and_widens_both_checks`, which asserts pre-056 seeded rows are byte-identical post-migration (lines 225-234). |
| Constraint names reused, not replaced | PASS | Both `up.sql` and the test assert `ck_writing_prompts_rubric` / `ck_writing_attempts_rubric` keep their 038 names (`test_migration_056.py:216-219`) — no other code/migration referencing them by name can silently break. |
| DOWN is reversible in the clean case | PASS | `test_056_down_restores_narrow_check_when_no_free_write_rows` (line 287): rolls back, confirms `free_write` rejected again on both tables, confirms `topik_ii_53/54` still insert, confirms a clean re-up. |
| DOWN is honest when the widened value is in use | PASS | Two separate tests — one per table — assert the down FAILS LOUDLY (`migrate.main()` returns exit code 2) when a `free_write` row already exists, and that NOTHING was rolled back (bookkeeping row for 056 still present, CHECK still widened, offending row untouched): `test_056_down_fails_loudly_when_a_free_write_prompt_row_exists` (line 340) and its `_attempt_row_exists` twin (line 375). |
| Exit-code-2 claim verified against the runner, not just asserted | PASS | Confirmed independently by reading `db/migrate.py`: `except (MigrationError, psycopg.Error) as exc: ... return 2 if isinstance(exc, psycopg.Error) else 1` (`migrate.py:686-688`). A Postgres `CheckViolation` is a `psycopg.Error` subclass, so the exit-2 contract is real, not asserted-and-hoped. |
| Both directions tested on BOTH tables | PASS | Confirmed by direct read of `test_migration_056.py`: up-widen touches `writing_prompts` AND `writing_attempts` (lines 237-250); down-clean touches both (lines 309-323); down-honest-gate has one test per table (writing_prompts at line 340, writing_attempts at line 375) — 4 distinct scenarios, not 2 with an implicit "same for the other table" assumption. |
| `NULL` rubric on `writing_prompts` still permitted post-widen | PASS | `test_056_up_preserves_rows_and_widens_both_checks` explicitly inserts a `NULL`-rubric prompt post-up and asserts it succeeds (lines 253-258) — the legacy register-drill NULL path wasn't accidentally tightened. |
| Destructive-gate interaction documented honestly | PASS | The test docstring (lines 42-47) explicitly distinguishes migrate.py's `DESTRUCTIVE_PATTERNS` gate (fires on `DROP TABLE`/`SCHEMA`/`DATABASE`/`TRUNCATE`, needed only because the *chain* traverses 045) from 056's own honest-gate mechanism (a `CheckViolation`, which needs no `--allow-destructive` override) — this is a correct and non-conflated account of two different safety mechanisms. |

**Migration 056 both-directions verdict: fully proven, both tables, both the clean and honest-failure down paths — no gaps.**

---

## Findings

### BLOCKER — none found

### SHOULD-FIX

**SF-1. `free_write` rubric on `writing_prompts` is now schema-legal but has no seed/ingest path, and no route currently serves it.**
`056...up.sql:24-31` widens `ck_writing_prompts_rubric` to accept `free_write` "so the bank can (eventually) carry a free_write-tagged curated prompt" — but `GET /writing/prompts` (`writing.ts:63`, `WritingRubricSchema = z.enum(['topik_ii_53', 'topik_ii_54'])`) and `GET /writing/prompts/random` (`writing.ts:151`) both still gate on the *narrower* two-value `WritingRubricSchema`, so a `free_write`-tagged bank row (if one were ever inserted) could never be fetched by rubric filter, and would only surface via the unfiltered `GET /writing/prompts` (no `rubric` param) call. This is documented intent ("(eventually)"), not a bug today — there is no code path that inserts such a row — but it is schema/route drift worth a tracked follow-up ticket so it isn't forgotten before something does insert one.

**SF-2. `GET /writing/attempts`'s `offset` has no upper bound (`.max(Number.MAX_SAFE_INTEGER)`), unlike `limit`'s 100 ceiling.**
`writing.ts:285`: `offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0)`. Practically harmless today (the query is `user_id`-scoped and each user's row count is small — an absurd offset just returns zero rows past an indexed scan), but it's an asymmetry with `limit`'s deliberate bound and with the `tickets.ts` precedent this endpoint claims to mirror (worth confirming `tickets.ts` caps its offset the same way, and matching it here for consistency's sake — not a security issue at current scale).

### NIT

**N-1.** `writing.ts:277`'s `PersistedWritingRubric` is a plain TS union (not a zod schema) reasoned as "OUTPUT type only... mirrors the DB CHECK." That's a defensible call (matches the file's own stated posture on output-only types elsewhere), but it does mean a future manual `psql` write of a bogus rubric value directly into `writing_attempts` (bypassing the CHECK somehow, e.g. via a superuser) would silently widen the client-visible type at the TS level with no runtime catch. Extremely low likelihood given the CHECK constraint is the actual gate; noting only because the file's own SECURITY block leans on "every query is parameterized" without mentioning this output-trust boundary explicitly.

**N-2.** `grade_writing.ts`'s `free_write` rubric totals 30 points (12/10/8) — identical total to Q53's 30 (12/12/6) but with a different dimension split, and different from Q54's 50 (20/20/10). This is intentional and well-explained (free-write is closer in scope/length to Q53's short-form task than Q54's essay), but worth flagging as a design decision worth a one-line note in `DESIGN_F014` or an ADR if one doesn't already reference it — right now the rationale lives only in a code comment (`grade_writing.ts:10-16`) and the migration's own comment, not in a discoverable design doc.

**N-3.** `Writing.tsx`'s `messageFor`/`promptsMessageFor`/`attemptsMessageFor` are three near-identical fixed-copy-error-lookup functions with overlapping branches (`network`, `401`, generic fallback). Not a bug — each is scoped to its own leg's copy — but a shared helper parameterized by feature name would cut ~20 lines of duplication. Pure style; explicitly out of scope per the "no scope creep" instruction, noted only as a low-priority observation for a later consolidation pass.

### PRAISE

- **The free_write rubric is genuinely real, not a relabeled Q54.** Verified by direct read of `grade_writing.ts:95-120`: distinct point allocation (12/10/8 vs Q53's 12/12/6 vs Q54's 20/20/10), distinct dimension descriptors explicitly written for open-topic composition ("no fixed information checklist to tick off, and no 200-300/600-700자 band to enforce"), and a distinct total (30, matching its own boundary table). The client-side "no longer a Q54-borrow" claim (`Writing.tsx:20-24`, test comment at `Writing.test.tsx:625-627`) is accurate against the actual prompt text, not just asserted in a comment.
- **The migration-056 test file is unusually rigorous for what looks like a "just widen a CHECK" change.** Four scenarios (up-both-tables, down-clean-both-tables, down-honest-gate-writing_prompts, down-honest-gate-writing_attempts) plus a constraint-name-preservation assertion plus a post-widen NULL-still-allowed assertion. This is exactly the kind of test that would have caught a narrower, less-careful widen.
- **`WritingGradeRubricSchema` is deliberately kept separate from `TopikRubricSchema`** (`models.ts:151-169`) rather than widening the latter in place, with an explicit comment explaining why (`TopikRubricSchema` still gates prompt-generation mode, and widening it there would let `free_write` "ride a code path that has nothing to do with grading"). This is the correct call and it's explained, not just done.
- **Best-effort persist in `gradeWriting.ts` is genuinely best-effort, not silently lossy.** The `maxTotal`/`totalScore` clamping (`gradeWriting.ts:99-136`) logs a `warn` with both raw and normalized values whenever the grader's output would otherwise trip a DB CHECK and silently drop the row — this is a real defense against a documented prior failure mode ("services sweep #8"), and it's tested (`gradeWriting.test.ts:210`, `:288`).
- **F-106's client-side test coverage is complete for the honest-empty-state / loading / error+retry / user-scoping quartet** — `Writing.test.tsx:682-756` covers all four states plus draft-preservation across a tab round-trip without an extra fetch (line 758), which is exactly the kind of state-machine edge a re-keyed-tabs UI tends to get wrong.

---

## Coordination observations

- This scope shares the `writing_attempts`/`writing_prompts` tables with no other in-flight branch in this phase (grammar/topik/reading are separate tables) — no merge-conflict or cross-migration-ordering risk observed for 056 specifically.
- `gradeWriting.ts`'s `GradeSchema.rubric` enum (`['topik_ii_53', 'topik_ii_54', 'free_write']`, `gradeWriting.ts:53`) and `models.ts`'s `WritingGradeRubricSchema` (`models.ts:164-169`) and the DB CHECK (`056...up.sql:31,48`) and the client's `WritingRubric` type (`domain.ts:1821`) are all kept in lockstep across four independent layers — verified each enumerates exactly `topik_ii_53 | topik_ii_54 | free_write`, in the same order, with no layer silently narrower or wider than another. This is the kind of cross-layer consistency that's easy to let drift and wasn't here.
- No dependency on the sibling grammar/topik/reading merges in this phase was found in the writing-scope files themselves (no imports crossing feature boundaries beyond the shared `middleware/`, `db/pool`, and `services/claude/` modules, which are pre-existing shared infrastructure, not new coupling introduced by this phase).
