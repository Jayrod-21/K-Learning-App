# Review: B3 Writing — F-134 prompt preview + F-096 / migration 067 prompt depth

Reviewer: independent senior full-stack review. Scope: `worktree-agent-ac141d99b94bbd0a3` @ `8aaa590` vs `rebuild` — `server/src/routes/plan.ts`, `client/src/pages/Today.{tsx,css}`, `client/src/types/domain.ts`, `client/src/data/mocks/today.ts`, `db/migrations/067_writing_prompts_depth.{up,down}.sql`, `db/tests/test_migration_067.py`, `server/tests/routes/plan.test.ts`. Code not modified.

## Summary verdict: **PASS** — 0 BLOCKER, 1 SHOULD-FIX, 3 NIT

The F-134 same-prompt guarantee is structurally sound (single SELECT feeds both `promptId` and `promptKr`; the Writing page loads by that PK), and migration 067 is provably safe on a populated table (real UNIQUE behind the ON CONFLICT, all CHECKs satisfied, exact-24 down, clean round trip). All four gates green. The one SHOULD-FIX: the new prompt preview is invisible to screen-reader users because the tile's `ariaLabel` overrides the button's accessible name.

## F-134 — same-prompt guarantee trace (the core probe)

Provably the same row, end to end:

1. **One pick, one row.** `server/src/routes/plan.ts:397-410` — a single `SELECT id::text, title, prompt_kr, level, est_minutes FROM writing_prompts WHERE is_active AND rubric IS NOT NULL ORDER BY (band-preference CASE), md5($1 || plan_date || id) LIMIT 1`. Deterministic per user per day (md5 seed), so re-fetches of `/plan/today` within a day return the same row.
2. **Both fields from the identical row object.** `plan.ts:426-433` — `promptId: Number(writingRow.id)` and `promptKr: writingRow.prompt_kr` are read off the same `writingRow`. There is no second query and no code path where the two can name different rows.
3. **Tile renders that body, links that id.** `client/src/pages/Today.tsx:873-878` renders `t.promptKr`; `Today.tsx:891` navigates `writingHref(t)` → `/learn/writing?promptId=<id>` (`Today.tsx:306-310` — falls back to bare `/learn/writing` only when `promptId` is absent).
4. **Writing page loads by that PK.** `client/src/pages/Writing.tsx:450-452` strict-parses `?promptId=` (digits only, `Writing.tsx:343-347`); the first bank fetch (`Writing.tsx:519-533`) calls `fetchWritingPromptById` (`client/src/services/writing.ts:156-162`) → `GET /writing/prompts/:id` (`server/src/routes/writing.ts:235-262`), a `WHERE id = $1 AND is_active AND rubric IS NOT NULL` lookup on the same table. Same PK → same `prompt_kr`. The pin is consumed exactly once (`pinnedPromptIdRef` cleared on settle), so later redraws are honest random draws — the deep link never permanently pins.
5. **Test proves it against the DB, not a fixture echo.** `server/tests/routes/plan.test.ts:159-165` takes the endpoint's `promptId`, re-queries `writing_prompts.prompt_kr` for that id in the testcontainer, and asserts equality with the returned `promptKr`. This is exactly the right assertion shape — it would catch a preview/id divergence.

**Graceful no-preview:** `Today.tsx:873` gates on `t.promptKr !== undefined` — an old envelope renders no `.km-today__tilePrompt` node at all (no stub, no "undefined", no orphaned hairline). Verified by test: `client/src/pages/Today.test.tsx:1051-1073` (older-envelope case asserts the node is absent) and `Today.test.tsx:1036-1049` (preview text present inside the tile button). Server-side, `prompt_kr` is `NOT NULL` with a `length BETWEEN 1 AND 2000` CHECK (`db/migrations/013_writing_prompts.up.sql:56,79-80`), so the live envelope can never carry `''`.

**Divergence windows considered:** the only way preview ≠ loaded prompt is the row being retired/edited between the plan fetch and the tile tap — then `/writing/prompts/:id` 404s and `Writing.tsx:567-577` deliberately degrades to a random draw (documented F-183 behavior). Not reachable in normal operation; see NIT-1.

## F-096 / migration 067 — populated-table safety (the second probe)

- **ON CONFLICT target is a real UNIQUE.** `CONSTRAINT uq_writing_prompts_source_id UNIQUE (source_id)` exists since table creation (`013_writing_prompts.up.sql:75-76`) — `ON CONFLICT (source_id)` (`067...up.sql:173`) cannot error with "no unique constraint matching".
- **No collision with existing seeds.** 038 seeded `wp-topik53-01..03` / `wp-topik54-01..03` (`038_...up.sql:62-87`); 067 continues at `04..15`. 013's legacy rows use a different naming scheme (`wp-l4-register-*`). On a live populated table the 24 INSERTs are all fresh; a partial prior apply is absorbed by DO NOTHING.
- **CHECK conformance, verified against the actual constraints:** `title` ≤ 200 (longest ~35 chars), `prompt_kr`/`prompt_en` within 1..2000 (longest ~230), `register` '문어체' within 40, `est_minutes` 15/30 within 1..120 (`013:78-86`); `rubric` values are exactly the two `ck_writing_prompts_rubric` admits (`038_...up.sql:33-34`); `level` labels L3/L4/L5+ all exist in the `proficiency_level` enum (`001_core_schema.up.sql:82`). No free_write rows, honoring 056's deliberately-narrow CHECK.
- **Idempotent:** re-running the body is a no-op; `db/tests/test_migration_067.py:239-258` drives the raw up SQL a second time directly (bypassing the runner's already-applied skip — the right way to test this) and asserts the pool stays at 15/rubric.
- **Down is exact and gated:** `067...down.sql:20-28` DELETEs by `source_id IN (<the same 24 ids as the up, verified 1:1>)` — no pattern match, no rubric-wide sweep; 038/013 rows untouched (asserted at `test_migration_067.py:292-300`, plus 038-bank restore to 3/rubric at `:294`). Marker `-- migrate: destructive` is correct and necessary (mass DELETE evades the legacy keyword sniff) — the gate-refusal-without-flag is tested (`:273-278`), as is the down→up round trip (`:302-312`). Up marker `-- migrate: non-destructive` also asserted (`:141-153`). The down header honestly documents the one-remove lossiness (`writing_attempts.prompt_id` → NULL via ON DELETE SET NULL).
- **ADR-013:** no top-level BEGIN/COMMIT in either file — runner owns the transaction.

The DB test file is real work, not theater: fresh schema per test, real migration files in a minimal 001+013+038+067 chain, and it exercises marker classification, seed shape, both untouched neighbor populations, idempotency, gate refusal, exact removal, and round trip.

## Findings

### BLOCKER

None.

### SHOULD-FIX

1. **Preview is invisible to screen readers — the code comment overclaims.** `Today.tsx:862` sets `ariaLabel={`Open writing — ${t.title}`}` on `ActivityTile`, which becomes `aria-label` on the `<button>` (`Today.tsx:416-420`). Per ARIA, `aria-label` replaces the accessible name, and `role=button` has presentational children — so AT users hear only "Open writing — Paragraph in 합쇼체" and never the new prompt preview. The inline comment at `Today.tsx:873-877` ("the full text stays in the accessibility tree") is true of the DOM (and `getByText` passes) but not of what a screen reader announces. Fix is one line: fold the prompt into the label when present (e.g. `ariaLabel={t.promptKr !== undefined ? `Open writing — ${t.title}. ${t.promptKr}` : `Open writing — ${t.title}`}`). Not a blocker — sighted parity exists and the prompt is fully announced on the Writing page itself — but F-134's own stated intent ("full text in the a11y tree") isn't met for the users who need it most.

### NIT

1. **Silent preview/loaded divergence on the retired-row edge.** If the previewed row is retired between plan fetch and tap, `Writing.tsx:567-577` silently substitutes a random draw — the user read prompt X on Today and lands on prompt Y with no notice. Rare (requires an operator deactivation mid-day) and better than a dead end, but a one-line "that prompt is no longer available — here's another" notice would make the degrade honest.
2. **`t.promptKr !== undefined` admits `''`.** An empty string would paint an empty hairline-topped stub (`Today.css:214-229`). Unreachable from the live server (NOT NULL + length ≥ 1 CHECK) and from the mocks — noted only because the client type (`domain.ts:536-539`) can't express the non-empty invariant. `t.promptKr !== undefined && t.promptKr !== ''` would cost nothing.
3. **plan.ts test types `promptKr: string` as required in the local shape** (`plan.test.ts:129`) while the wire contract is optional — fine for this test (writing row always exists in its fixture), just slightly stronger than the envelope it describes.

### PRAISE

- The same-row guarantee is enforced where it belongs — one SQL pick, both fields off one row object — and the server test asserts it against the database rather than trusting the route.
- The pinned-fetch lifecycle in `Writing.tsx` (one-shot consume, abort-safe snapshot per effect run, rubric sync guarded against a phantom second draw) is careful, well-commented concurrency work.
- 067's down-vs-deactivate reasoning (round-trip correctness under ON CONFLICT) is exactly right and documented in the file where the next person will look.

## Gates (exact)

| Gate | Command | Result |
|---|---|---|
| Server typecheck | `cd server && npm run typecheck` | 0 errors |
| Server routes | `npx vitest run tests/routes/plan.test.ts tests/routes/writing.test.ts` | 2 files, **56 passed**, 0 failed |
| Client Today | `cd client && npx vitest run src/pages/Today.test.tsx` | 1 file, **63 passed**, 0 failed |
| DB migrations | dockerized `pytest db/tests/test_migration_067.py db/tests/test_migrations.py -q` | **34 passed**, 0 failed |
