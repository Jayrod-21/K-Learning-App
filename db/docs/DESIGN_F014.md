# F-014 — Writing rework (locked design + contract)

The Writing feature already works end-to-end (screen + Claude grader + Today tile → /writing). This rework closes 4 gaps. Two Fable agents (backend + frontend) build against THIS contract.

## Goals
1. **Prompt reconciliation** — the `/writing` screen currently uses a HARDCODED prompt list (`Writing.tsx` `WRITING_TASKS`) while the Today tile advertises a `writing_prompts` DB row → mismatch. Fix: serve prompts from the DB; screen fetches them; retire the hardcoded list.
2. **Persistence** — grading is stateless. Add a `writing_attempts` table + save-on-grade.
3. **F-017 Writing chart** — persistence gives Writing a real per-day series → replace F-017's Writing placeholder with a live chart.
4. **B-016** — the `expensiveLimiter` 429 omits `retry_after`, so the Writing screen's retry-countdown branch is dead. Add it.

## Data model

### Migration 038 (`db/migrations/038_writing_attempts.{up,down}.sql`)
- **`ALTER TABLE writing_prompts ADD COLUMN rubric TEXT`** — `CHECK (rubric IS NULL OR rubric IN ('topik_ii_53','topik_ii_54'))`. The 8 legacy register-drill seed rows keep `rubric = NULL`.
- **Retire the legacy rows from the active pool**: `UPDATE writing_prompts SET is_active = false WHERE rubric IS NULL;` (they were only ever the Today-tile label source and never matched the screen — the down migration re-activates them). This makes ALL active prompts rubric-tagged, so `/plan/today` naturally advertises a real Q53/Q54 prompt the screen can show.
- **Seed the real prompts**: port the current `Writing.tsx` `WRITING_TASKS` content (read it — 3 prompts for Q53 + 3 for Q54) into new `writing_prompts` rows, `is_active = true`, `rubric` set, `level`/`register`/`est_minutes` filled sensibly, unique `source_id`s, `ON CONFLICT (source_id) DO NOTHING`.
- **`CREATE TABLE writing_attempts`** (follow the audit-column + FK conventions of migration 037_topik_attempts):
  - `id` BIGINT identity PK; `user_id` BIGINT NOT NULL FK users ON DELETE CASCADE.
  - `prompt_id` BIGINT NULL FK writing_prompts(id) ON DELETE SET NULL (history survives prompt removal).
  - `rubric` TEXT NOT NULL CHECK IN ('topik_ii_53','topik_ii_54').
  - `prompt_kr` TEXT NOT NULL (snapshot of the graded prompt).
  - `sample` TEXT NOT NULL (the user's essay).
  - `total_score` INT NOT NULL, `max_total` INT NOT NULL (30 for 53, 50 for 54), CHECK total between 0 and max.
  - `estimated_level` TEXT NULL.
  - `result` JSONB NOT NULL (the full grade result: content/organization/languageUse dimensions + overallComment).
  - `graded_at` TIMESTAMPTZ NOT NULL DEFAULT now(); created_at/updated_at/version audit cols; updated_at trigger.
  - INDEX `ix_writing_attempts_user_graded (user_id, graded_at DESC)`.
- Down: DROP TABLE writing_attempts; drop the rubric column; re-activate the legacy rows. Note it's lossy (attempts).

## API contract (LOCKED — client mirrors exactly)

```
GET /writing/prompts?rubric=topik_ii_53|topik_ii_54   (auth, cheapLimiter)
  -> 200 { prompts: WritingPromptDTO[] }
  WritingPromptDTO = {
    id: number, promptKr: string, promptEn: string | null,
    level: string, rubric: 'topik_ii_53'|'topik_ii_54', estMinutes: number | null
  }
  (active + rubric-filtered, stable order e.g. by id)

POST /grade-writing            (EXISTING route; extend request + add a side-effect)
  request: { prompt, sample, rubric, targetLevel?, promptId?: number }   // promptId NEW, optional
  response: UNCHANGED  { result, metadata }
  NEW side-effect: on a successful grade, INSERT a writing_attempts row for the
    session user (prompt_id = promptId ?? null, prompt_kr = prompt, sample, rubric,
    total_score = result.totalScore, max_total = result.maxTotal,
    estimated_level = result.estimatedLevel, result = result JSONB). A failed persist
    must NOT fail the grade response (log + continue) — the grade already cost a Claude call.

GET /writing/series?days=1..90(def 30)   (auth, cheapLimiter)  // for F-017
  -> 200 { series: SkillSeries }
  SkillSeries = { metric: 'score', unit: '%', points: { date: 'YYYY-MM-DD', value: number }[] }
  value = round(avg(total_score * 100.0 / max_total)) per UTC day, ascending, one point per active day.
  (Normalized to % so Q53/30 and Q54/50 are comparable + LineChart uses its fixed 0-100 axis.)
```

## B-016 (`server/src/middleware/rateLimits.ts`)
The `expensiveLimiter` (and the shared 429 responder) must include `retry_after` (integer seconds until the window resets) in the JSON body AND set the `Retry-After` header. The Writing client already reads `retry_after` (`services/writing.ts` / `Writing.tsx`). Fix at the middleware so every expensive route benefits; add/extend a test asserting the 429 body carries `retry_after`.

## Client changes
- `services/writing.ts`: add `fetchWritingPrompts(rubric, signal?): Promise<WritingPromptDTO[]>`; extend `gradeWriting` to send `promptId`.
- `Writing.tsx`: fetch prompts per rubric tab from `/writing/prompts` (drop hardcoded `WRITING_TASKS`); loading/error states; pass `promptId` into grade. The B-016 fix makes the existing `retryAfter` countdown branch live — leave it wired.
- `services/stats.ts`: add `/writing/series` to the fan-out; `AllSkillSeries.writing` = the real series (remove the synthesized-empty writing).
- `Today.tsx`: the Writing carousel panel renders the `LineChart` when it has points; keep the "Start writing to see your progress" invitation only when points are empty (metric is now `'score'`, not `'none'`).

## Non-goals
- No writing HISTORY list UI in this pass (persistence + the F-017 chart are the payoff). A history/review screen is a future follow-up.
- Grading stays a live Claude call (unchanged). No new API surface there beyond the persist side-effect.
