# Independent Integration Review — Phase-2 Group 3 (`feat/phase2-g3-backend-logic`)

Reviewer: independent senior integration reviewer (did not author any of this code).
Scope: cross-cutting integration of the four Group-3 features (B-027 random writing
prompts, F-027/F-073 writing-prompt generation, F-068 story generation, F-035/F-036
chat attach + auto-naming) **plus independent verification of the hand-done
merge-conflict resolutions** in the shared Claude-proxy files.
Branch head reviewed: `897101f`. Baseline: `rebuild`.

## Verdict: **PASS — approve for merge.** 0 BLOCKERs, 1 SHOULD-FIX, 2 NITs.

The manually-repaired merge is correct: no conflict markers anywhere, the
`RouteName` union is exact (11 routes, each once), every `Record<RouteName, …>`
is exhaustive, and the split `generateStory` / `nameConversation` methods are
each complete and correctly wired (no cross-wiring). The migration chain
053→055 is add-only end to end, so this release ships via the **standard
zero-downtime blue/green flow** — no Group-1-style special protocol.

---

## Gates (run fresh by this reviewer)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (server) | **exit 0, clean** |
| `npx vitest run tests/services/claude/ tests/db/claude_route_enum.test.ts` | **exit 0 — 11 files passed, 1 skipped; 129 tests passed, 4 skipped.** The skipped file is `tests/services/claude/real_smoke.test.ts` (opt-in real-API smoke behind `describe.skipIf(!RUN)` at line 43 — expected). The stderr Zod-parse error lines in the log are negative-path test fixtures, not failures. |
| Enum drift guard re-run standalone (`claude_route_enum.test.ts`, fresh Testcontainers PG with the full migration chain applied) | **3/3 passed** — enum ⇄ `RouteName` exact both directions; 053's two values and 055's `name_conversation` each pinned independently |
| Full db chain (dockerized pytest, `db/tests` minus `test_discriminator_coverage.py`) | **56 passed in 117.91s** — chain applies 001→055 on a fresh container, including the 053/054/055 up/down/idempotency tests |
| Repo-wide conflict-marker grep (`<<<<<<<` / `=======` / `>>>>>>>`, plus `git grep`) | **zero matches** (both greps exit 1 = not found) |

Full server/client suites were not re-run here per instruction (OOM risk running
concurrently); the parent reported them green at server 1181/0, client 1261/0,
ingest 342 (1 known local-data non-issue).

---

## 1. Merge-resolution correctness (highest priority) — VERIFIED CLEAN

### 1.1 `RouteName` union and `ROUTE_NAMES`
`server/src/services/claude/config.ts:157-168` — union has exactly 11 members,
each once: the 8 pre-existing routes + `generate_writing_prompt` +
`generate_story` + `name_conversation`. No duplicate, no omission.
`ROUTE_NAMES` (config.ts:187-199) lists the same 11, pinned at compile time
from **both** directions: `satisfies readonly RouteName[]` (no extras) plus the
`_routeNamesExhaustive` conditional-type assertion (config.ts:204-209, no
missing). With `tsc` clean, the union/array pair is proven exact.

### 1.2 Every `Record<RouteName, …>` is exhaustive
All four config maps carry all 11 keys once each:
- `modelDefaults` — config.ts:265-277
- `inputCaps` — config.ts:278-290
- `cacheTtlSeconds` — config.ts:291-303
- `rateLimitPerMinute` — config.ts:304-316

Test fixtures likewise complete (and compile-checked, since `tsc` is clean):
- `server/tests/services/claude/rate_limit.test.ts:10-21` (11 keys incl. the 3 new)
- `server/tests/services/claude/index.test.ts:63-75` (TokenBucketLimiter map) and
  `index.test.ts:204` (per-route usage assertion object, 11 keys)
- `server/tests/services/claude/grammar_drill.test.ts:49-51` (new keys present)
- `server/tests/services/claude/generation.test.ts:40-52` (11-key limiter map)
- `server/tests/helpers/app.ts:194-254` — `makeStubProxy` gained complete
  `nameConversation` / `generateWritingPrompt` / `generateStory` stubs.

### 1.3 The split methods are complete and NOT cross-wired
The parent split a fused method during conflict repair; I verified each half
independently in `server/src/services/claude/index.ts`:

| Method | Route const | Request builder | cacheTtl key | Output schema | Parser |
|---|---|---|---|---|---|
| `generateWritingPrompt` (index.ts:570-592) | `'generate_writing_prompt'` (:575) | `buildWritingPromptRequest` (:581) | `generate_writing_prompt` (:588) | `WritingPromptResultSchema` (:589) | `parseToolResult('submit_writing_prompt')` (:590) |
| `generateStory` (index.ts:594-623) | `'generate_story'` (:599) | `buildStoryRequest(cleaned)` → passed as `request` (:612, :618) | `generate_story` (:619) | `StoryResultSchema` (:620) | `parseToolResult('submit_story')` (:621) |
| `nameConversation` (index.ts:625-657) | `'name_conversation'` (:630) | `buildNameConversationRequest` → `const req`, passed as `request: req` (:646, :652) | `name_conversation` (:653) | `ConversationTitleSchema` (:654) | `parseJsonContent` (:655) |

Every cell is internally consistent per row — no key from one route leaks into
another. The parser asymmetry is **correct**, not a merge artifact:
`prompts/generation.ts` forces tool use for both generation routes
(`tool_choice: {type:'tool', name:'submit_writing_prompt'}` at generation.ts:118,
`submit_story` at :208), while `prompts/name_conversation.ts` is a JSON-only
prompt with no tools (name_conversation.ts:21 "Respond ONLY with a single JSON
object"), so `parseJsonContent` is the right parser there. Each method appears
exactly once in the interface (index.ts:254, :263, :280) and once in the impl
(:570, :594, :625) — no duplicated bodies left behind by the merge.
`server/src/services/claudeProxy.ts` re-exports the new input/result types only
(pure type plumbing, no logic).

### 1.4 Sanitization survived the split
`generateStory` runs the only free-text field (`topic`) through
`sanitizeUserInput` with the `generate_story` cap (index.ts:603-606);
`nameConversation` sanitizes every history turn under the `name_conversation`
cap (index.ts:635-640); `generateWritingPrompt` correctly has nothing to
sanitize (closed enums — documented at index.ts:576-578). Caps match routes.

## 2. Migration chain 053/054/055 + deploy story — ZERO-DOWNTIME CONFIRMED

- **053** (`db/migrations/053_claude_route_generation.up.sql:30-31`): two
  `ALTER TYPE claude_route ADD VALUE IF NOT EXISTS` — value-only, nothing uses
  the values in-transaction (PG12+ safe). Down is a documented no-op.
- **054** (`054_generated_stories.up.sql:57-110`): `CREATE TABLE IF NOT EXISTS
  generated_stories` + index + `CREATE OR REPLACE TRIGGER` (idempotent — the
  right posture per the km trigger lesson). New table only; nothing existing
  touched. Down is `DROP TABLE IF EXISTS` — **trips the destructive gate by
  design** (rollback only, documented in the down header and README row 054).
- **055** (`055_conversation_titles.up.sql:47-70`): one `ADD VALUE IF NOT
  EXISTS` + `ADD COLUMN IF NOT EXISTS title TEXT` (nullable, no default → no
  table rewrite) + a guarded CHECK. Down drops constraint + column
  (`DROP COLUMN` does **not** match the gate — verified against
  `db/migrate.py:83-86`, `DESTRUCTIVE_PATTERNS = DROP TABLE|DROP SCHEMA|DROP
  DATABASE|TRUNCATE` — so the down's own claim at
  `055_conversation_titles.down.sql` is accurate).
- **No rename and no drop of any in-use column/table anywhere in the three ups.**
  Pre-055 code never references `title`; the still-serving color keeps working
  while migrations apply. **Rollback-by-flip remains valid.** The destructive
  down (054) matters only for a schema rollback, never the up-deploy.
- `db/migrations/README.md:66-68` — rows 053/054/055 present, accurate, and
  correctly labeled zero-downtime; 054's "Down → `--allow-destructive`" note
  matches the gate behavior verified above.
- Chain applies cleanly 001→055 on a fresh database (db gate: 56 passed;
  drift-guard test migrates fresh and passes 3/3). `PRE_055 = "054"`
  (`db/tests/test_migration_055.py:54`) — the 897101f fix is in and correct.

**Deploy ruling: standard zero-downtime blue/green flow. Unlike Group 1
(brief-downtime 045-047), nothing here needs a special protocol or the
`--allow-destructive` flag on the way up.**

## 3. App wiring — VERIFIED

- Mounts intact in `server/src/app.ts`: `/writing` (:76), `/conversation`
  (:85), `/reading` (:113).
- New endpoints all live under those existing prefixes:
  `POST /writing/generate` (`server/src/routes/writing.ts:292`),
  `POST /reading/generate` (`server/src/routes/reading.ts:482`),
  `GET /reading/generated` (:530) + `GET /reading/generated/:id` (:564),
  `PATCH /conversation/:conversationId` rename
  (`server/src/routes/conversation.ts:959`), `POST /conversation/:id/name`
  (:1009), `POST /conversation/:id/file` (:1146).
- nginx allow-list: `writing`, `reading`, `conversation` already present in the
  km-lb regex in **both** `Deploy/nginx-blue-active.conf:82` and
  `Deploy/nginx-green-active.conf:144`; I diffed the `location` blocks of the
  two files — identical. **No new nginx entry needed** (the F-012 /ttmik+/iyagi
  trap does not recur here).
- The auto-namer's never-clobber contract is enforced in the SQL itself:
  `WHERE … AND title IS NULL` inside the UPDATE (conversation.ts:1071), so a
  concurrent user rename wins the race — correct.

## Findings

### BLOCKER — none.

### SHOULD-FIX
1. **`Deploy/README.md` has no Group-3 shipping section.** The file carries an
   explicit section for Group 1 (line 127, brief-downtime protocol) and Group 2
   (line 231, "standard zero-downtime flow" + a rollback caution), but stops at
   052. Group 3 (053-055) follows the same standard flow, and the migrations
   README rows say so — but the deploy doc is the operator-facing runbook, and
   its own precedent is a short per-group entry. Add a "Shipping Phase-2
   Group 3 (migrations 053-055) — standard zero-downtime flow" section stating:
   no special protocol; and the one rollback caution — `run_migrate
   --allow-destructive --target 052 down` is required to cross 054's
   `DROP TABLE generated_stories`, and 055's down silently discards
   conversation titles without tripping the gate (take a `db-backup.sh`
   snapshot first, mirroring the Group-2 paragraph at lines 245-251).
   Docs-only; does not block the code merge.

### NIT
1. `055_conversation_titles.up.sql:59-70` adds the CHECK constraint directly
   (not `NOT VALID` + `VALIDATE`), which takes an ACCESS EXCLUSIVE lock and
   scans `conversations` to validate existing rows. At this app's single-user
   table size that is milliseconds and genuinely zero-downtime, but the header's
   zero-downtime claim silently depends on table size — worth one comment line
   so a future copy-paste onto a big table doesn't inherit the assumption.
2. `db/migrations/README.md:68` says the 055 CHECK bounds titles to 1..200 and
   "the app layer caps tighter (Zod)" — true (the API cap is 80 per the stub
   comment at `server/tests/helpers/app.ts:196-201`), but neither the README
   row nor the 055 header states the actual API cap; a number would make the
   DB-floor/API-ceiling relationship auditable at a glance.

### PRAISE
1. The double-sided compile-time pin of `ROUTE_NAMES` to `RouteName`
   (config.ts:187-209) plus the runtime enum drift guard
   (`server/tests/db/claude_route_enum.test.ts`) with per-migration value probes
   (053 at :62-75, 055 at :77-88) makes the exact defect class this merge risked
   (a dropped or duplicated route) mechanically impossible to ship silently.
   The merge repair itself is textbook: after the bad auto-strip, every seam I
   checked was restored exactly once with route/ttl/schema/parser coherent per
   method.
2. `generated_stories` (054) is a model add-only migration: closed enum for
   `level` with the server-chosen value (never a model echo — documented at
   054:96-99), DB CHECKs deliberately wider than the Zod caps with the
   rationale written down (054:31-35), and the "why a table vs. ephemeral"
   design note (054:13-18) answers the reviewer's first question before it's
   asked.

## Coordination
- The SHOULD-FIX is a docs edit to `Deploy/README.md` only — can ride this PR
  or the ship commit; no code change, no re-test needed beyond a docs read.
- Nothing here requires action from the client-side or Phase-3 wiring work
  (the `/name` trigger is client-called in Phase 3; the endpoint contract is
  already idempotent and race-safe).
