# Backend batch — scoping doc

**Read-only investigation.** Branch `rebuild` @ `934fd2f`. Migrations run through
`058`; next number is **`059`**. Stack per `db/docs/ADR-018-server-stack.md`
(`pg` + `@node-rs/argon2` + `cookie-parser` + `express-rate-limit` + `undici` +
Vitest/testcontainers).

No code was changed to produce this document.

---

## 1. The attempt-logging pattern (canonical template)

Three existing "attempt log" features share one shape. `grammar_drill_attempts`
is the cleanest template (newest, most fully documented); `writing_attempts`
and `topik_responses`/`topik_attempts` are the other two live examples.

### 1a. `grammar_drill_attempts` (the template)

- **Migration:** `db/migrations/019_grammar_drill_attempts.up.sql` (+ `020` adds
  the production-card unique index and a `discovered_via = 'drill'` CHECK value
  it needs).
- **Table shape** (`019_grammar_drill_attempts.up.sql:42-79`):
  - `id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
  - `user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE`
  - Item-identifying columns carried verbatim from the client (`pattern_key`,
    `pattern_display`)
  - `drill_type TEXT NOT NULL CHECK (...)` — a closed set describing what was
    generated
  - `item JSONB NOT NULL` — the FULL generated content **including the answer
    key**, written at generation time. Server-only; never sent to the client
    until after submit (see security note below).
  - Nullable submit-time columns: `user_answer`, `score INT`, `verdict TEXT`,
    `feedback JSONB` — all `NULL` until scored.
  - `created_at TIMESTAMPTZ NOT NULL DEFAULT now()` (generation time),
    `scored_at TIMESTAMPTZ` (submit time; `NULL` = unscored — this is the
    concurrency gate, see below).
  - One index: `idx_gda_user_pattern_created ON (user_id, pattern_key,
    created_at DESC)` — supports "last N attempts for (user, item)".
  - CHECK constraints mirror the server's Zod enums (defense in depth).
- **Lifecycle is two-phase, one row:** `POST /grammar-drill` INSERTs
  (generation); `POST /grammar-drill/:id/submit` UPDATEs the SAME row
  (scoring). This is the key design choice — not two tables, one row with a
  nullable "not yet done" half.
- **Routes:** `server/src/routes/grammarDrill.ts`
  - `POST /grammar-drill` (`grammarDrill.ts:184-247`) — picks a variant by
    history rotation (`pickDrillType`, `grammarDrill.ts:83-92`, reads the last
    3 rows via the index), calls Claude **before** the INSERT (a Claude
    failure writes nothing — "no half-state"), inserts, strips the answer key
    from the response (`toPublicItem`, `grammarDrill.ts:105-110`).
  - `POST /grammar-drill/:attemptId/submit` (`grammarDrill.ts:253-525`) —
    loads the row scoped to `(id, user_id)` (404 if not theirs — IDOR
    defense), 409s if already scored, calls Claude to score, then in one
    transaction: single-shot `UPDATE ... WHERE scored_at IS NULL` (rowCount
    gate — the actual concurrency defense, not the earlier read), auto-banks
    a `grammar_entries` row, resolves-or-creates an FSRS production card,
    advances it, and appends a `card_reviews` snapshot. All-or-nothing.
  - `GET /grammar-drill/attempts` (`grammarDrill.ts:552-596`, F-110) — paged,
    user-scoped, `scored_at IS NOT NULL` only (unscored/skipped generations
    are excluded from "history"), `COUNT(*) OVER ()` window function carries
    the total alongside the page (one round trip).
- **Client service:** `client/src/services/grammarDrill.ts` — thin wrappers
  (`generateDrill`, `submitDrill`, `listAttempts`) around `api.post`/`api.get`,
  with an explicit `DRILL_CLAUDE_TIMEOUT_MS = 30_000` override on the two
  Claude-backed legs (the plain history GET uses the default axios timeout).
- **Security invariants worth copying into any new attempt table:**
  answer-stripping (never send the reference/answer key until after submit),
  IDOR scoping (`WHERE id = $1 AND user_id = $2`, 404 not 403), single-shot
  scoring via a `WHERE <sentinel column> IS NULL` rowCount-gated UPDATE (not a
  pre-check), Claude-call-before-write ordering so a paid failure never leaves
  a half-written row.

### 1b. `writing_attempts` (second example — simpler, one-phase)

- Migration `038_writing_attempts.up.sql:107-158`. Columns: `id`, `user_id`
  (CASCADE), `prompt_id` (soft FK, `ON DELETE SET NULL` — survives prompt
  removal), `rubric`, `prompt_kr` (snapshot), `sample` (the essay verbatim),
  `total_score`/`max_total`, `estimated_level`, `result JSONB` (full graded
  breakdown), `graded_at`. One index: `ix_writing_attempts_user_graded (user_id,
  graded_at DESC)`.
- Difference from grammar-drill: **one-phase, best-effort persist.** The row is
  written entirely by `POST /grade-writing` as a **side effect after** the
  Claude call succeeds — a persist failure logs and continues; it never fails
  the (already-paid) grade response. No generate/submit split because writing
  has no "generate a task" step — the prompt is picked client-side from
  `writing_prompts`.
- `GET /writing/attempts` (`server/src/routes/writing.ts:353+`) — same paging /
  user-scoping / `COUNT(*) OVER ()` idiom as grammar-drill's history route.

### 1c. `topik_attempts` + `topik_responses` (third example — session + log)

- Two tables: `topik_attempts` (one **resumable in-progress session**,
  migration `037` + lifecycle rework `046`) and `topik_responses` (append-only
  **per-answer** log, migration `015`, now with a nullable `attempt_id` FK
  added by `046` to group responses into the sitting that produced them).
- This is the shape to copy when the activity has an internal multi-step
  session (a timed multi-item exam) rather than one single generate→submit
  unit. Grammar-drill and writing are single-unit; TOPIK mock is multi-item.

### What a NEW attempt-log table should copy

For **Hanja / Reading / Listening daily attempts** (F-171/F-172), the closest
analog is **writing_attempts**, not grammar-drill: these are single completed
actions (finished a hanja review set / finished reading a passage / finished
listening to a lesson), not a two-phase generate→score flow, and not a
multi-item timed session. Recommended shape (see §2 below):

- `id BIGINT IDENTITY PK`, `user_id BIGINT NOT NULL REFERENCES users(id) ON
  DELETE CASCADE`
- Target identification (what was practiced) — a soft FK where possible
  (mirrors `writing_attempts.prompt_id`, `ON DELETE SET NULL`), plus a text
  snapshot of the display label so history survives a corpus reload (mirrors
  `hanja_progress.char` being TEXT, not FK-only, and `writing_attempts.prompt_kr`
  snapshotting text).
- One `created_at`/`completed_at TIMESTAMPTZ NOT NULL DEFAULT now()` — the
  event timestamp, since these are one-shot logs not two-phase.
- Whatever minimal outcome data the modality actually has (hanja: which state
  transition; reading: which passage/story + how far; listening: which
  lesson/episode). No `JSONB item` payload needed — there is no generated,
  answer-bearing content to protect the way grammar-drill/TOPIK mock protect a
  reference answer.
- One index: `(user_id, <target/day>, created_at DESC)` mirroring
  `idx_gda_user_pattern_created`.
- A paged `GET .../attempts` route with the `COUNT(*) OVER ()` idiom, user-scoped,
  matching the exact response shape (`{ attempts, total, limit, offset }`) all
  three existing history routes already use.

---

## 2. F-171 (Hanja daily attempts) + F-172 (Reading/Listening daily attempts)

### Confirmed: no per-attempt/per-day log exists today

- **Hanja** (`server/src/routes/hanja.ts`): the only user-state tables are
  `hanja_progress` (migration `016`) — one row per (user, char), holding a
  single **current state** (`new`/`practicing`/`banked`), overwritten on every
  `POST /hanja/:char/state` (`hanja.ts:435-467`) — and, since migration `050`,
  FSRS cards on the shared `vocab_cards`/`card_reviews` engine
  (`hanja.ts:547-738`, `POST /hanja/:char/card`, `GET /hanja/cards/due`,
  `POST /hanja/cards/:cardId/reviews`). `card_reviews` **is** technically an
  append-only review log, but it only exists for characters the user has
  seeded an FSRS card for — it says nothing about "did the user do a hanja
  session today," and its schema is FSRS-review-specific (rating,
  before/after stability/difficulty), not a general "I practiced X" event.
  There is no table recording "the user viewed/interacted with hanja
  character Y at time T" independent of the FSRS card lifecycle.
- **Reading** (`server/src/routes/reading.ts`): only `reading_positions`
  (migration `051`, one row per (user, book) — the current bookmark,
  overwritten on every `PUT`) and `generated_stories` (migration `054` — a
  library of AI-generated stories, not a completion log). There is **no**
  "user finished passage/chapter N" or "user read for N minutes" event log at
  all. TTMIK/Iyagi listening content served by `reading.ts`'s sibling
  `ttmik.ts` has the same gap.
- **Listening** (`server/src/routes/ttmik.ts`, both `ttmikRouter` and
  `iyagiRouter`): this file is **pure read-only corpus serving** — lesson/
  episode lists, transcript/highlight detail, and Range-capable mp3 streaming.
  There is zero user-state writing anywhere in this file. No progress, no
  position, no completion — not even a resume pointer (unlike Reading's
  `reading_positions`).
- Cross-checked `server/src/routes/plan.ts` (`GET /plan/today`) and
  `server/src/routes/progress.ts` (`GET/PUT /progress`, `POST
  /progress/study-log`): `plan.ts` is a pure content-picker (no per-attempt
  reads); `progress.ts`'s `study_log` table (migration `001`) is a **generic,
  free-form per-day minutes+activities JSONB blob** the client opts into
  posting (`progress.ts:113-178`) — it is not modality-specific and does not
  currently receive any calls tied to hanja/reading/listening completions
  (grep across `client/src` would confirm which screens call it today; not
  itself the per-attempt log F-171/F-172 need, though a new attempt-log write
  could ALSO fire a `study-log` POST if a "streak" signal is wanted — that is
  an orthogonal, already-existing mechanism, not something to build).

### What each needs

**F-171 (Hanja):** a `hanja_attempts` table (or the unified table, see below)
logging one row per completed hanja practice action — the natural trigger
point is either (a) the FSRS card review (`POST /hanja/:char/card/reviews`
already exists and already writes `card_reviews`; the natural minimal move is
to ALSO write a lightweight attempt-log row from inside that same handler /
transaction), or (b) a new explicit "I studied this character" client action
if the product wants a non-FSRS interaction counted too (e.g. viewing an
etymology note without rating it). Recommend anchoring on (a) — the review
submit is already a real, authenticated, rate-limited, transactional write
point (`hanja.ts:707-738` → `services/cardReview.ts`); piggy-backing the
attempt-log INSERT onto that existing transaction is cheap and avoids
inventing a new "did nothing but I'll log it anyway" client call.

**F-172 (Reading/Listening):** the natural completion signal does not exist
yet on the client side either — `reading.ts`/`ttmik.ts` have no
"mark as read/listened" action at all today. This needs a genuine new
client-triggered POST, fired when:
- Reading: the user finishes a chapter/passage (or a generated story) — the
  reader already tracks position via `PUT /reading/position/:uploadId`; the
  natural page-action is "reached the last passage of a chapter" or an
  explicit "mark chapter done" affordance. A generated-story read has no
  position tracking at all today, so its completion signal would need to be
  its own explicit "I finished this story" button/scroll-to-bottom trigger.
- Listening: the TTMIK lesson / Iyagi episode player reaching the end of the
  audio (an `<audio>` `ended` event client-side), or an explicit "mark
  listened" action — there is currently no player state on the server side
  at all to hang this off of, so this is a clean new POST with no existing
  transaction to piggyback on (unlike Hanja's FSRS review).

### Recommendation: separate tables per skill, not one unified `activity_attempts`

Recommend **three separate tables** (`hanja_attempts`, `reading_attempts`,
`listening_attempts`) rather than one unified `activity_attempts` table, for
reasons consistent with this codebase's existing conventions:

1. **Every existing attempt-log table in this codebase is modality-specific**
   (`grammar_drill_attempts`, `writing_attempts`, `topik_responses`) — there is
   no precedent here for a polymorphic activity-log table, and introducing one
   now would be the first of its kind, adding a discriminator + nullable
   per-type columns (or a JSONB catch-all) that fights the codebase's stated
   convention of favoring closed, explicit CHECK-constrained columns over
   generic polymorphic blobs (`db/migrations/README.md` "Conventions" —
   "Closed sets: Postgres ENUM. Open sets that may grow: TEXT + CHECK").
2. **The three modalities have genuinely different natural keys and payloads**
   — Hanja keys on `char` (already a TEXT identity per migration `016`'s own
   "must survive corpus reload" design note), Reading keys on
   `(source_upload_id, chapter_id?)` or a `generated_stories.id`, Listening
   keys on `(ttmik_lessons.id)` or `(iyagi_episodes.id)`. A unified table would
   need a polymorphic target (the codebase already has ONE such precedent —
   `vocab_cards`'s XOR target columns — and its own migration history
   (`020`, `049`, `050`) shows each new leg of that polymorphic target needed
   its own migration + CHECK widening + partial unique index anyway; it is not
   actually simpler than three plain tables).
3. **Independent evolution / rollback.** Three small tables can each ship,
   test (`db/tests/test_migration_0NN.py`), and roll back independently. A
   unified table forces every future modality-specific column addition (e.g. a
   Hanja-only `state_transition` column) through a shared table that Reading's
   and Listening's tests don't care about, and a single down-migration rollback
   risk surface touches three features' data instead of one.
4. **History `GET` endpoints already read modality-scoped** (Grammar's
   `/grammar-drill/attempts`, Writing's `/writing/attempts`, TOPIK's
   `/topik/attempts`) — nothing in the client currently wants a cross-modality
   merged feed; a "Today activity" screen, if ever built, can UNION three
   typed queries far more cheaply than it can special-case a polymorphic row
   shape client-side.

The counter-argument for a unified table (one place to query "did the user do
*anything* today," useful for a streak/heatmap) is real, but that need is
already served by `study_log` (migration `001`, `progress.ts:113-178`) — a
generic per-day-per-user rollup that ANY of these three new write paths can
additionally POST to (`activity: 'hanja_review' | 'reading' | 'listening'`)
without needing the per-attempt tables themselves to be unified. Recommend:
three attempt tables (parallel structure, one per builder, see §9) + each
new write path optionally also posts to `study-log` if the roadmap wants the
Today/streak surface to reflect these actions (that wiring can be a follow-up,
not part of this batch's minimum viable scope).

---

## 3. Migration conventions

- **File naming:** `NNN_<short_name>.up.sql` + `NNN_<short_name>.down.sql`,
  three-digit zero-padded sequence number (`db/migrations/README.md:4-5`, ADR-001
  D11). Next number is chosen by taking the highest existing `NNN` and
  incrementing — currently `058` is the highest applied, so **`059` is next**.
- **Runner:** `db/migrate.py`. Applies/rolls back via `python -m db.migrate up`
  / `down`, tracks applied migrations + a SHA-256 checksum per file in
  `schema_migrations` (drift on an in-place edit to an already-applied file
  is a hard error — `ChecksumMismatch`, see the README's "Migration checksum
  drift" runbook). `make db.up` / `db.down N=1` / `db.status` are the Makefile
  wrappers.
- **Transaction ownership (ADR-013):** migration files MUST NOT contain
  top-level `BEGIN`/`COMMIT`/`ROLLBACK`/`START TRANSACTION` — the runner wraps
  the whole file body in one transaction together with the bookkeeping write.
  `discover_migrations` statically rejects a file containing top-level tx
  control before any apply runs. `DO $$ ... $$` blocks are fine (tx-control
  keywords inside dollar-quoted strings are stripped before the check).
- **The destructive gate (`db/migrate.py:75-90, 161, 278-372, 461-568`):** any
  migration body (up OR down) containing `DROP TABLE`, `DROP SCHEMA`,
  `TRUNCATE`, or `DROP DATABASE` requires an explicit `--allow-destructive`
  flag, or the runner exits non-zero **before opening a write transaction**.
  Critically, **`--dry-run` ALSO evaluates this gate** (ADR-010 amendment,
  2026-07-10, `migrate.py:485-508`) — this is the blue/green deploy's
  expand/contract safety check: the deploy's dry-run step aborts on a pending
  destructive migration instead of discovering it mid-apply. `DROP COLUMN` is
  **deliberately NOT** in the destructive-keyword list — the comment at
  `migrate.py:75-81` explains why: treating every column drop as destructive
  would force every additive migration through `--allow-destructive` and
  defeat the blue/green expand-contract gate's whole purpose (letting truly
  additive migrations sail through ungated). Down-migrations are inherently
  destructive by nature and always require the flag regardless of content.
- **Expand/contract rule (why this matters for a shared blue-green DB):** both
  color stacks (`km-server-blue`/`km-server-green`) point at the **same**
  `km-db` Postgres instance. A migration that ships alongside the deploy of
  ONE color must not break the OTHER color's still-running code against the
  new schema. This is why **additive-only** changes
  (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS` with a sane
  default, new indexes, new enum values via `ALTER TYPE ... ADD VALUE`) are
  the default posture and ship "zero-downtime safe" (migrations `049`, `053`,
  `054`, `055` are explicitly called out this way in the README table) — the
  old code simply doesn't reference the new column/table, and the new code
  works against rows the old code hasn't touched yet. Migrations that RENAME
  a column, tighten a CHECK the old code's writes would violate, or drop
  something the other color still reads (`046`'s partial-unique swap, `045`'s
  `DROP TABLE`) are NOT expand/contract-safe and are called out individually
  in the README as needing the "brief-downtime Group-1 release" runbook
  (`Deploy/README.md`) instead of the normal flow.
- **All 8 tickets in this batch are additive-only by nature** (new tables, new
  indexes, a new WHERE clause, a widened filter) — none require the
  brief-downtime path. Confirm this holds at PR time: a new attempt table is
  `CREATE TABLE IF NOT EXISTS` + new indexes only (no existing table is
  altered), the krdict/vocab filter changes are query-side only (F-175
  needs no migration at all — see §5; F-176 needs no migration either — see
  §6).
- **ONE migration-ownership rule for this batch:** to avoid two builders both
  claiming `059`, **one builder (or the batch coordinator) claims and reserves
  migration numbers sequentially before work starts, and every other builder's
  PR either (a) needs no migration at all, or (b) is assigned the next free
  number in order and rebases if a lower number lands first.** Concretely for
  this batch: only F-171/F-172 (new attempt tables) need new migrations at
  all — recommend **one builder owns ALL new-table migrations for this batch**
  (reserve `059`, `060`, `061` up front for `hanja_attempts`,
  `reading_attempts`, `listening_attempts` respectively, even if built by
  different people, so the numbers are claimed atomically in one PR or three
  PRs merged in a fixed, agreed order) rather than three builders racing to
  grab `059`. F-173/F-175/F-176/F-185 are route/query/loader-only — zero
  migration surface, so they cannot conflict on numbering and can merge in any
  order.

---

## 4. F-173 (Resumed-TOPIK item-count)

### What carries an in-progress exam's answered count today

- `topik_attempts` (migration `037`, lifecycle reworked by `046`) stores
  `section`, `source_test` (the paper's `test_number`), `current_idx`, `picks`
  (`{"<topik_item_id>": "a"|"b"|"c"|"d"}`), `remaining_ms`. **No item-count
  column exists or is stored** — `GET /topik/attempt`
  (`server/src/routes/topik.ts:917-945`) computes `answered:
  Object.keys(row.picks).length` on the fly (`topik.ts:937`) and returns
  `{ section, sourceTest, currentIdx, picks, remainingMs, answered, updatedAt }`
  — **no `totalItems` field**.
- Compare to the COMPLETED-attempt history route, `GET /topik/attempts`
  (`topik.ts:1157-1228`), which DOES compute and return `totalItems` per
  attempt, via a helper `resolveServedTotal(section, sourceTest)`
  (`topik.ts:1108-1133`). This is the exact function to reuse.

### Is `sourceTest` ambiguous between TOPIK I/II?

**Yes, structurally** — `topik_tests` was widened in migration `029` to a
natural key of `(test_number, topik_level, section)` specifically because
"TOPIK I and TOPIK II sittings SHARE every test_number" (`topik.ts:1267-1272`,
the `resolveMockTest` doc comment; also `db/migrations/README.md`'s `029`
entry). `topik_attempts` (migration `037`) **predates** that widening and has
**no `topik_level` column at all** — only `source_test` (the bare
`test_number`) + `section`. The code is candid about this: the
`resolveServedTotal` doc comment (`topik.ts:1086-1107`) calls it a
"best-effort re-derivation" and explicitly notes "`topik_attempts` does NOT
store `topik_level`... this pass is routes-only (no migration)."
- **Why it's still safe in practice today:** `resolveMockTest` (`topik.ts:1285-1311`)
  is **deterministic** — given no explicit `topikLevel`, it always picks
  "highest `test_number`, then TOPIK II over TOPIK I" for that
  `(section, sourceTest)` pair. Because `POST /topik/mock` (initial serve),
  `POST /topik/mock/submit` (grading), and F-007's resume flow (which replays
  `POST /topik/mock {sourceTest, section}` with no `topikLevel`) **all** call
  the same resolver with the same inputs, a resumed attempt today
  deterministically re-resolves to the SAME paper it was originally served
  from — the ambiguity is real (two exams share the key) but resolution is
  stable, so no user currently sees a wrong exam on resume. This only breaks
  if the underlying corpus changes between save and resume (a topik_items
  row added/removed for that test_number) — a pre-existing, documented,
  accepted risk, not something F-173 needs to fix.

### Minimal safe server change

Reuse `resolveServedTotal(section, sourceTest)` (already exported/available in
`topik.ts`) inside `GET /topik/attempt` (`topik.ts:917-945`) exactly the way
`GET /topik/attempts` already does for history rows (`topik.ts:1211`):

```
const served = await resolveServedTotal(row.section, row.source_test);
// ...
totalItems: served?.totalItems ?? row's own answered-count fallback (same posture as history)
```

This requires **zero migration** — it's a route-only change reusing an
existing, already-tested helper with the identical fallback posture the
history route already uses (best-effort; falls back to a safe lower bound —
never fabricates a total above what the corpus can prove). No new column, no
new table. Recommend adding `topikLevel: served?.topikLevel ?? null` to the
response too, mirroring the history DTO shape, so the client's SubwayProgress
can label the resumed exam correctly (TOPIK I vs II) without guessing.

---

## 5. F-175 (dictionary grammar exclusion)

- **File:** `server/src/routes/krdict.ts`, `GET /krdict/search`
  (`krdict.ts:90-198`). Two query branches, each computing `total` via a
  `COUNT(*) OVER ()` window function riding along on every row
  (`krdict.ts:134`, `krdict.ts:158`) — the exact pager idiom used across this
  codebase (mirrors `GET /vocab/entries`, `GET /grammar-drill/attempts`, etc).
- **Live corpus check** (queried directly against `km-db`, the local running
  stack): `part_of_speech` distribution across all 53,978 `krdict_entries` —
  `어미` (grammatical ending): **504 rows**; `조사` (particle): **157 rows**.
  661 rows combined (~1.2% of the corpus) — small but not negligible; these
  are function-word entries (grammar morphology), not vocabulary, and their
  presence in a *vocabulary* dictionary browse/search is the reported bug.
- **Where the filter goes, precisely:**
  - Browse branch (`krdict.ts:130-142`): currently `WHERE` only appears
    conditionally (only when `q.initial` narrows to a 초성 range). Needs an
    unconditional `AND part_of_speech NOT IN ('어미', '조사')` — i.e. the query
    needs a real `WHERE` clause always present, with the existing 초성 range
    conditionally `AND`-ed onto it (today the range condition IS the entire
    WHERE clause, or WHERE is absent).
  - Search branch (`krdict.ts:155-166`): the exclusion must wrap the existing
    3-way `OR` (headword/definition-korean/definition-english match) in
    parens and `AND` the exclusion onto the OUTSIDE:
    `WHERE (headword ILIKE $1 ... OR ... OR ...) AND part_of_speech NOT IN
    ('어미','조사')` — adding it as a bare `AND` without parenthesizing the OR
    group would be a correctness bug (operator precedence would only gate the
    LAST OR arm).
  - Because `COUNT(*) OVER ()` reflects whatever the WHERE clause matched,
    adding the exclusion to both branches' WHERE automatically makes `total`
    exact — no separate count query or client-side adjustment needed.
- **Is krdict.ts the sole consumer of `krdict_entries` that this change would
  affect?** `krdict_entries` has exactly one other server consumer:
  `server/src/routes/define.ts` (`GET /define`, the tap-to-define exact-headword
  lookup, `define.ts:205-206`). **This is a DIFFERENT query in a different
  file** — untouched by editing `krdict.ts`'s two queries. It is also
  semantically correct that it stays untouched: `/define` is a single-word
  lookup a user can trigger by tapping ANY token, including a grammatical
  particle or verb ending encountered in a sentence — excluding `어미`/`조사`
  there would break legitimate "what does 을/를 mean" lookups. So: **yes, safe
  to change krdict.ts in isolation** — no migration, no other route affected,
  `define.ts`'s exact-match lookup is intentionally a separate, broader
  surface.

---

## 6. F-176 (vocab genre/theme filter)

- **`vocab_entries.theme` is a real column** — `TEXT` (migration
  `002_darakwon_corpora.up.sql:496`, `COMMENT`: "Top-level theme label (e.g.
  '01 인간 / People')", `002...up.sql:596`). It is already `SELECT`ed by
  `GET /vocab/entries` (`server/src/routes/vocab.ts:118`) but **not currently
  filterable** — the query's `WHERE` clause filters on `q`, `corpus`,
  `proficiency`, `domain` (content_domain enum), `book_level`, and
  `source_upload_id` (`vocab.ts:120-139`) — no `theme` parameter exists in
  `VocabSearchQuerySchema` (`vocab.ts:54-85`) and no `$N::text IS NULL OR
  theme = $N` clause exists in the SQL.
- **It IS already indexed:** `ix_vocab_entries_theme_subsection ON
  vocab_entries (theme, subsection) WHERE theme IS NOT NULL`
  (`002_darakwon_corpora.up.sql:669-673`). A composite B-tree index on
  `(theme, subsection)` fully serves an equality filter on the LEADING column
  (`theme = $N`) alone — Postgres can use a multicolumn index for a query that
  only constrains the leading column(s). **No new index/migration is needed**
  for F-176's performance — this is purely additive on the query/route side.
- **Real distinct `theme` values** (queried live against the running `km-db`
  stack — there is no static enum/whitelist in code or corpus JSON; themes are
  free text lifted verbatim from the source PDF extraction): **31 distinct
  values** across 3,188 tagged rows, e.g. `01 인간 / People` (262),
  `01 사람 / People` (179, a DIFFERENT theme string from a different corpus
  book — beginner vs intermediate word lists use their own numbering/wording),
  `02 행동 / Actions` (171), `03 성질/양 / Quality & Quantity` (166),
  `05 의식주 / Necessities of Life` (145), `부록 / Appendix` (127), down to
  smaller buckets like `07 날씨 / Weather` (40). **Note the duplication
  pattern**: beginner and intermediate corpora each have their OWN "01" /
  "02" ... numbered theme taxonomy with similar-but-not-identical Korean/
  English labels (`01 인간 / People` vs `01 사람 / People` are both "unit 1,
  people" from two different source books) — a client-side theme filter UI
  should almost certainly present themes as a flat list of the exact 31
  strings (or group by corpus first), NOT assume "01" numbers are comparable
  across corpora.
- **Recommended change:** add `theme: z.string().trim().min(1).max(200)
  .optional()` to `VocabSearchQuerySchema`, bind it as `$N` and add
  `AND ($N::text IS NULL OR theme = $N)` to the `WHERE` clause (exact match,
  not ILIKE — themes are stable corpus labels, not free-text search), matching
  the existing `domain`/`book_level` filter idiom exactly. **Query-param-only,
  zero migration.** `client/src/lib/libraryFilters.ts` would need a new
  `THEME_FILTERS` (or a themes-by-corpus grouping) built from a live values
  list — recommend a small `GET /vocab/themes` (or reuse the existing
  `GET /vocab/entries` response to derive it) rather than hardcoding the 31
  strings client-side, since the value set is corpus-derived data, not a
  designed taxonomy.

---

## 7. F-185 (Listen audio ingest)

### The regex, and an important correction to the ticket's premise

`tools/ingest/loaders/load_ttmik_audio.py` has two filename regexes:

```python
_LESSON_RE = re.compile(
    r"ttmik\s+level\s+(\d{1,2})\s+lesson\s+(\d{1,3})(?:-\d+)?\s*\.mp3$",
    re.IGNORECASE,
)
_IYAGI_RE = re.compile(
    r"ttmik\s+iyagi\s+(?:episode\s+)?#?\s*(\d{1,4})(?:-\d+)?\s*\.mp3$",
    re.IGNORECASE,
)
```

Both **already contain** an optional trailing `(?:-\d+)?` group specifically
documented as handling a "part suffix" (e.g. `Lesson 17-1.mp3` → lesson 17).
I verified this empirically two ways:

1. **Regex unit-test against the actual filenames on disk** (corpus at
   `~/data/korean-master/corpus/TTMIK/`): `20 TTMIK Level 5 Lesson 20-1.mp3`,
   `17 TTMIK Level 3 Lesson 17-1.mp3`, and `67 TTMIK Iyagi 67-1.mp3` **all
   match correctly** under the CURRENT regex, extracting `(5,20)`, `(3,17)`,
   and `67` respectively.
2. **Live DB check** (queried the running `km-db` container):
   - `ttmik_lessons` rows `(level=3, number=17)` and `(level=5, number=20)`
     **already have `audio_path` populated correctly**
     (`TTMIK/Lessons/Lesson 3/17 TTMIK Level 3 Lesson 17-1.mp3` and the level-5
     equivalent) — these two are **not currently broken**.
   - `iyagi_episodes` has **no row at all** for `episode_number = 67` (`SELECT
     ... WHERE episode_number=67` returns 0 rows). The mp3 file
     `67 TTMIK Iyagi 67-1.mp3` exists on disk, parses correctly to
     `EpisodeKey(number=67)`, and the loader's `UPDATE iyagi_episodes SET
     audio_path=... WHERE episode_number=67` legitimately matches **zero
     rows** — this is logged today as a `file_without_db_row` warning
     (`load_ttmik_audio.py`'s `load()`, the `files_without_row` list), not
     silently dropped.

**Conclusion: this is NOT a filename-regex bug for any of the 3 files named in
the ticket.** Two are already correctly loaded; the third (Iyagi 67) fails not
because of a parsing miss but because **`iyagi_episodes` itself has no row for
episode 67** — a content-ingestion gap, not an audio-mapping gap. Cross-checked
`iyagi_episodes`' actual number distribution: of 139 total episodes, numbers
run from 1 to 246 with substantial gaps, including **the entire 51-100 range
missing except a couple of stragglers** and 119 also missing. `load_iyagi.py`
(the loader that CREATES `iyagi_episodes` rows) reads a single pre-parsed
`iyagi_*.json` file and writes exactly what's in it — the 51-100 gap is a
property of that source JSON (i.e., of the original TTMIK Iyagi transcript
corpus that was extracted), not something `load_ttmik_audio.py` can fix by
changing a filename regex, because there is no row to attach the audio path
to.

### What the actual fix is

**Recommend re-scoping F-185 before building it**, since the premise (a regex
fix for 3 files) does not match the observed system state:
1. Re-verify against the CURRENT ticket/BUGS_AND_FEATURES.md description
   whether "3 known files" refers to a stale/earlier version of this loader
   (the `(?:-\d+)?` suffix handling may have been added in a later pass and
   the ticket not updated) — if so, F-185 may already be **resolved for 2 of
   3 files** and just needs the ticket closed/updated for those two.
2. For Iyagi episode 67 specifically: this needs either (a) a content-side fix
   — re-examine the source `iyagi_*.json` / the original TTMIK transcript
   corpus to see if episode 67's content genuinely doesn't exist (a real gap
   in what TTMIK published under sequential numbering — plausible, since
   TTMIK's Iyagi series had multiple seasons/renumbering over the years) —
   in which case there is nothing to load and audio-only coverage for that
   episode is out of scope; or (b) if the content DOES exist somewhere
   unextracted, a content-loader fix (not an audio-loader fix) to add the
   missing `iyagi_episodes` row(s), after which the EXISTING audio loader
   (no code change needed) picks it up on next run.
3. **How coverage is (re)loaded either way:** `load_ttmik_audio.py`'s `load()`
   is idempotent and safely re-runnable — it's "one big transaction, ~1,300
   single-row UPDATEs, no checkpoint" (explicitly documented: "the whole pass
   is cheap and atomic, so resume bookkeeping would add a schema change for no
   benefit"). Re-running it after ANY fix (regex change, corpus file update,
   or a content-loader gap fix) is just: re-invoke the loader against the
   corpus root — no migration, no special re-load flag. Current live gap
   count (for context/prioritization): **10 `ttmik_lessons` rows** and
   **48 `iyagi_episodes` rows** have `audio_path IS NULL` — most of that is
   likely genuine "no audio was ever published for this lesson/episode," not
   a parsing failure; only a targeted diff (parse every mp3 on disk, list
   `unparsed` + `duplicates` + `files_without_row` from a real loader run) can
   separate real bugs from expected gaps.
- **Corpus location:** `~/data/korean-master/corpus/TTMIK/` (this machine),
  matching `CORPUS_AUDIO_DIR` config; specifically `TTMIK/Lessons/Lesson <L>/`
  and `TTMIK/이야기들/이야기/` subtrees.

### CORRECTION (2026-07-14, code build pass): the Iyagi-67 finding above was
### right that it isn't a `-N` regex bug, but WRONG that it's "just" a
### one-episode content gap — it's a real mapping bug affecting 46 rows

The `--allow-destructive`-free re-verification above (this file) stopped at
"episode 67 has no `iyagi_episodes` row, plausibly a real corpus gap" without
cross-referencing the mp3's actual audio content against the transcript JSON.
Doing that (decode each mp3's embedded ID3 `USLT` lyrics frame, string-match
against `iyagi_*.json` unit text) found the local on-disk Iyagi numbering
(1..146) is a DIFFERENT number space than `iyagi_episodes.episode_number`
(TTMIK's real season-block site numbering: 1-50, 101-150, 201-246) — local
"51" is content-identical to `episode_number=101`, local "67" to
`episode_number=117`, confirmed off-by-exactly-+50-or-+100 at 10 sample
points spanning both season boundaries.

**Practical consequence, worse than "48 episodes missing":** before a fix,
`load_ttmik_audio.py` keyed its UPDATE on the raw local number, so local
season-3 files (101-146, real content = episodes 201-246) numerically
collided with DB rows 101-146 (real content = the season-2 topics) and wrote
the WRONG audio onto 46 already-populated rows — not just left 48 rows null.
Confirmed live in `km-db`: `episode_number=101` (a 혈액형/blood-type episode)
was serving `101 TTMIK Iyagi 101.mp3`, whose actual transcript is about
쇼핑/shopping (real content of `episode_number=201`).

**Fixed** in `tools/ingest/loaders/load_ttmik_audio.py` via a
`_resolve_iyagi_episode_number` season-block offset applied before the DB
key lookup, with tests in `tools/ingest/tests/test_load_ttmik_audio.py`
(30/30 passing, pure + testcontainer tiers). Full detail + the runbook for
re-running the loader against `km-db` is in `BUGS_AND_FEATURES.md`'s F-185
entry — read that instead of this section for the current state; this
addendum exists only so a future reader doesn't stop at the original,
incomplete "episode 67 is a lone content gap" conclusion above.

Residual (genuine, small) content gap after the code fix: 3 real
`episode_number`s (119, 236, 240) have audio present in the corpus but no
`iyagi_episodes` row at all — the transcript source JSON never extracted a
unit for them. That's a `load_iyagi.py`/transcript-extraction backfill task,
not something the audio loader can create.

---

## 8. Test infra for the /fixpass gate

Authoritative source: `TESTS.md` (repo root) — read it directly for the
current exact commands; summarized here.

| # | Suite | Command | Runner |
|---|-------|---------|--------|
| 1 | Client | `npm ci && npm run lint && npx tsc --noEmit && npm run build` (in `client/`) | `node:20-slim` |
| 2 | Server | `npm ci && npm run lint && npm run typecheck && npm test` (in `server/`) | `node:20-slim`; `npm test` = `vitest run`, `testTimeout: 120_000` (2 min) per test for testcontainer warm-up — **this is the ~testcontainer suite**, test files run strictly sequentially (one Postgres container per file, not shared) |
| 3 | DB migrations | `python -m pytest db/tests --ignore=db/tests/test_discriminator_coverage.py -q` | `python:3.12` + Docker socket (`--network host`); spins `postgres:16-alpine` via testcontainers |
| 4 | Kiwi service | `python -m pytest --no-slow -q` (in `services/kiwi/`) | `python:3.12`, fake Kiwi engine (no model download) |
| 5 | Secret scan | grep for API-key literal patterns | host |

All 5 are **hard gates** — must pass, block deploy on failure.
`tools/ingest/tests/` is explicitly **NOT** part of this gate (runs during the
ingest phase against real `km-db`, driven by `Deploy/load-corpora.sh` /
`load-krdict.sh` — CI only lints/audits `tools/ingest`, doesn't run its DB
tests in the pre-build gate).

**Single authoritative local command reproducing CI + the extra suites:**
```bash
Deploy/local-test.sh          # full gate: JS + db + kiwi + secret scan
Deploy/local-test.sh --fast   # inner loop only (JS + secret scan) — NOT a gate
```

**Per memory (`feedback_fixpass_gates_run_full_suite.md`): this batch touches
schema (new migrations for F-171/F-172) AND cross-cutting query changes
(F-175/F-176), so every fixpass stage for this batch must run the FULL
server + db + ingest suites — not a targeted slice per ticket.** The prior
incident this rule encodes (P2-G1: a clean 4-phase PASS then CI-failed on a
migration's FK + destructive-gate) is exactly the failure mode a "just run the
new table's test file" shortcut would reproduce here — a new attempt table's
FK to `users`, its interaction with the destructive-gate dry-run check, and
whether it breaks an unrelated existing db/tests fixture are only caught by
the full suite. Run `Deploy/local-test.sh` (not `--fast`) at every fixpass
gate for this batch, for every builder's PR, even the query-only tickets
(F-173/F-175/F-176) — a query change can still regress an existing server
test file's fixture expectations.

Ingest tests specifically relevant if F-185 touches the loader:
`tools/ingest/tests/` has no existing `test_load_ttmik_audio.py`... actually
it does — `tools/ingest/tests/test_load_ttmik_audio.py` exists; run it
directly (`python -m pytest tools/ingest/tests/test_load_ttmik_audio.py -q`)
in addition to the standard gate if F-185's scope changes
`load_ttmik_audio.py` or `load_iyagi.py`.

---

## Recommended build plan

### Ticket → migration-need summary

| Ticket | New migration? | New table(s) | Route-only change | Notes |
|---|---|---|---|---|
| F-171 Hanja attempts | **Yes** | `hanja_attempts` | — | Anchor write on existing `POST /hanja/cards/:cardId/reviews` transaction |
| F-172 Reading/Listening attempts | **Yes** | `reading_attempts`, `listening_attempts` | New client completion action needed (no existing trigger point) | Two tables — reading and listening have different target shapes |
| F-173 Resumed TOPIK item-count | No | — | Yes (`topik.ts`) | Reuse existing `resolveServedTotal` helper |
| F-175 KRDICT grammar exclusion | No | — | Yes (`krdict.ts`) | Two WHERE clauses, parenthesization matters |
| F-176 Vocab theme filter | No | — | Yes (`vocab.ts` + `libraryFilters.ts`) | Index already exists; add a `GET /vocab/themes`-style values source |
| F-185 Listening audio ingest | Done (loader fix, no migration) | — | `load_ttmik_audio.py` (Iyagi season-offset bug) | Re-scope found a WORSE bug than the ticket claimed (46 rows silently mis-mapped, not just 48 nulls) — see the CORRECTION note in §7 + `BUGS_AND_FEATURES.md` F-185; still needs a live-DB loader re-run to actually backfill |

### Migration ownership (avoiding numbering conflicts)

**One builder owns every new-table migration in this batch.** Only F-171 and
F-172 need new tables (3 tables total: `hanja_attempts`, `reading_attempts`,
`listening_attempts`). Assign ONE person/agent to author all three migrations
(`059_hanja_attempts`, `060_reading_attempts`, `061_listening_attempts`) even
if the ROUTE code for each ships from different builders — this avoids two
people racing to claim `059`. If org preference is to split by feature
instead, the fallback rule is: reserve the number range up front in a single
tracking comment/PR-description before any builder starts, and each migration
PR merges strictly in numeric order (a `060` PR must not merge before `059`
does, since `migrate.py` applies in numeric order and a gap would leave `060`
referencing tables `059` hasn't created yet if there's any cross-dependency —
there isn't here, the three tables are independent, but the numeric-order-merge
discipline avoids checksum/ordering surprises regardless).

F-173/F-175/F-176/F-185 need **zero migrations** — they cannot conflict with
each other or with the F-171/F-172 migrations on numbering, and can be built
and merged in any order, in parallel, by separate builders.

### Parallelization

**Fully parallel, no shared files, no ordering dependency:**
- Builder A: F-171 (Hanja attempts) — owns `059_hanja_attempts` migration +
  `hanja.ts` route change
- Builder B: F-172 (Reading/Listening attempts) — owns
  `060_reading_attempts` + `061_listening_attempts` migrations +
  `reading.ts`/`ttmik.ts` route changes + the new client completion-trigger UI
  (touches `client/src/pages/Reading.tsx` and `client/src/pages/Ttmik.tsx`)
- Builder C: F-173 (TOPIK item-count) — `topik.ts` only, route-only
- Builder D: F-175 (KRDICT exclusion) + F-176 (vocab theme filter) — both
  touch dictionary/vocab query surfaces, small enough to pair; `krdict.ts`,
  `vocab.ts`, `libraryFilters.ts` — no file overlap with A/B/C
- Builder E: F-185 — **starts with the re-scoping investigation** (confirm
  against the live ticket text / BUGS_AND_FEATURES.md whether the regex
  premise is stale, and determine whether Iyagi 67 needs a content-loader fix
  or is an accepted corpus gap) before writing any code; likely the smallest
  or possibly a "close as already-fixed + document the Iyagi 67 gap" outcome
  rather than a code change.

**If headcount is tighter than 5:** F-171 and F-172 should NOT be combined
into one builder if the goal is genuine parallelism, since F-172 has the
extra client-side "add a completion trigger from scratch" work F-171 doesn't
(F-171 piggybacks on an existing transaction). F-173/F-175/F-176 are the
three smallest, safest, no-migration tickets and are a reasonable single
builder's batch if consolidating.

### Sequencing / ordering constraints

- Nothing in this batch has a hard cross-ticket dependency — all 6 tickets are
  independent of each other. The only sequencing constraint is the
  migration-numbering rule above (F-171/F-172's three migrations merge in
  strict numeric order relative to EACH OTHER; they have no ordering
  constraint relative to F-173/175/176/185's non-migration PRs).
- Recommend merging the non-migration tickets (F-173, F-175, F-176, F-185)
  FIRST/anytime, and treating the migration-bearing batch (F-171, F-172) as
  its own coordinated mini-release, so the "who owns `059`" coordination
  overhead doesn't block the four simpler tickets.

### Risk callouts

- **Destructive-gate:** none of these six tickets should ever need
  `--allow-destructive` — every migration is `CREATE TABLE IF NOT EXISTS` +
  new indexes only. If a builder's draft migration for F-171/F-172 ever
  contains `DROP`/`TRUNCATE`/`ALTER ... TYPE` on an EXISTING table, that's a
  signal the design has drifted from "new additive table" into something
  riskier — stop and re-review before merging, since it would also trip the
  blue/green dry-run gate (`Deploy/README.md`'s Group-1 release path) and
  turn a routine deploy into a coordinated-downtime one.
- **FK correctness:** new attempt tables' `user_id` FK should be `ON DELETE
  CASCADE` (mirrors every other attempt-log table — `grammar_drill_attempts`,
  `writing_attempts`, `topik_responses`: an attempt has no standalone value
  once its owner is gone). Any soft-FK to a target table (a hanja character, a
  book chapter, a lesson/episode) should follow the `writing_attempts.prompt_id`
  precedent: `ON DELETE SET NULL` with a TEXT snapshot column carrying the
  display label, so history survives both a corpus reload (Hanja precedent,
  migration `016`'s design note) and a target row's removal.
  **Do not FK hard against `hanja_characters`/`ttmik_lessons`/`iyagi_episodes`
  with `ON DELETE RESTRICT` or CASCADE** unless the team is certain those
  corpus tables never get pruned/reloaded — RESTRICT would block a legitimate
  corpus reload, CASCADE would silently erase user history on one.
- **Full-suite gating:** per memory, run `Deploy/local-test.sh` (the FULL
  server + db + kiwi suite, not `--fast`) at every fixpass stage for every PR
  in this batch, including the four no-migration tickets — a query-only
  change can still regress an existing test fixture, and this batch's mixed
  schema+query nature is exactly the shape the "don't shortcut to a targeted
  slice" rule exists for.
- **F-185's premise mismatch is itself a risk if unaddressed:** shipping a
  "fix" to a regex that isn't actually broken wastes a builder's cycle and
  risks introducing a REAL regression to a currently-working pattern for the
  sake of "fixing" 2 files that were never broken. Re-scope before assigning
  code work.
