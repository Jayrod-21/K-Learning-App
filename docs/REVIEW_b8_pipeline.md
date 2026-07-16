# REVIEW b8 — F-108 U2 extraction/OCR pipeline (core pipeline + security + migration)

Reviewer: independent senior review (did not author this code). Branch
`feat/f108-u2-extraction` vs `origin/rebuild`, worktree
`.claude/worktrees/f108-ocr`. Files read fully: `server/src/services/uploadExtract.ts`,
`db/migrations/068_upload_extractions.{up,down}.sql`; sampled: `server/src/routes/uploads.ts`,
`server/src/routes/{vocab,grammar,diagnostic,vocabLists,hanja}.ts`, `server/src/config/index.ts`,
`server/src/services/{imageIngest,uploadStore,claudeProxy}.ts`,
`server/src/services/claude/{index,models}.ts`, `server/src/services/claude/prompts/sanitize.ts`,
migrations 002/022/027, `server/tests/routes/uploadExtract.test.ts`, `docs/BUILD_b8_f108_ocr.md`.

## Summary verdict: REQUEST CHANGES

The pipeline core is genuinely well built — the claim/OCR/curate/persist
transaction shape is correct, the partial-UNIQUE claim is a real race arbiter,
and the migration is disciplined. But two findings are blockers: (1) the daily
Vision-page cap can be reset at will because the cost-accounting rows CASCADE
away with `DELETE /uploads/:id`, and (2) the cross-user visibility fence was
applied to only some read surfaces — `pickVocabSeed`, the vocab bank route, and
the vocab-lists add/read paths still expose another user's extracted private
rows to sequential-id probing. Both are exactly the classes (cost-bypass,
cross-user leak) this change's own comments declare it defends against.

## Bar checklist

| Bar item | Status | Notes |
|---|---|---|
| User-scoped every query; 404 not 403 on mismatch | PARTIAL | Extract POST/GET correctly 404 (`uploadExtract.ts:448-456`, `uploads.ts` GET owner check). Corpus-read fences incomplete — see BLOCKER-2 |
| No external I/O inside an open DB tx | PASS | OCR loop runs with no tx open (`uploadExtract.ts:550-606`); persist + settle in one tx (`uploadExtract.ts:624-655`) |
| Atomic persist, no half-write | PASS | Rollback covers corpus rows + settlement together; mid-OCR upload deletion aborts tx (`uploadExtract.ts:646-653`); failure settlement is a separate best-effort statement with a `status='running'` guard (`uploadExtract.ts:683-704`) |
| Daily cap 429 BEFORE upstream, counts failed/requested pages | PARTIAL | Enforced pre-upstream inside the claim tx (`uploadExtract.ts:499-523`); sums `pages_requested` over all statuses so failed runs count. BUT rows CASCADE-delete with the upload (BLOCKER-1) and the same-user/different-upload race is real (SF-1) |
| Idempotent trigger; race-safe claim | PASS | Deterministic `upload-{id}-{kr}` source_id + `ON CONFLICT (corpus, source_id) DO NOTHING` (`uploadExtract.ts:354, 379, 400-402`); claim INSERT arbitrated by `uq_upload_extractions_upload_live` → 23505 → 409, no check-then-insert gap (`uploadExtract.ts:527-543`, `068 up:156-161`) |
| Prompt-injection guard on every persisted word | PARTIAL | kr/en/gloss all pass `sanitizeUserInput`, rejects are skipped+counted (`uploadExtract.ts:256-274`). `pos` is persisted un-re-checked (SF-3) |
| Parameterized SQL only | PASS | Every statement in the new code is parameterized; the sourceId is data, never interpolated (`uploadExtract.ts:396-402`) |
| Typed AppErrors, no swallowed errors | PASS | 404/400/409/429/502 all typed; the single swallow (`uploadExtract.ts:700-703`) is deliberate, commented bookkeeping — acceptable (but see SF-4 for a way it silently sticks a run) |
| Migration additive/expand-contract, reversible, idempotent, F-088 markers | PASS | `-- migrate: non-destructive` up / `-- migrate: destructive` down; enum DO-block, `IF NOT EXISTS` everywhere, `CREATE OR REPLACE TRIGGER`; CHECK relax strictly more permissive (verified against 002:301-310 — down restores verbatim); down fails loudly on populated user_mined kgiu rows (022 posture) |
| Tests exercise real behavior | PASS | 20 tests on testcontainer Postgres through real routes; only the Vision proxy is stubbed (correct — that's the metered call). 429-before-proxy asserted via spy; rollback atomicity and injection-skip tested against real tables |

## Findings by category

| ID | Category | One-line summary |
|---|---|---|
| BLOCKER-1 | Cost bypass | `DELETE /uploads/:id` CASCADE-wipes today's `upload_extractions` rows → daily Vision-page cap resets on demand |
| BLOCKER-2 | Cross-user leak | Visibility fence missing on `pickVocabSeed`, `POST /vocab/entries/:entryId/bank`, and vocab-lists add/read — extracted private rows readable via id probing |
| SF-1 | Race / cost | Daily-cap check races across two uploads of the same user (READ COMMITTED; the code comment claims protection it doesn't have) |
| SF-2 | Availability / integrity | Process crash mid-run leaves a `running` row forever → permanent 409 for that upload; no stale-claim recovery |
| SF-3 | Injection defense-in-depth | `pos` bypasses the curation-boundary re-sanitization the module header promises for "every field" |
| SF-4 | Edge / integrity | `settleFailed` with an empty error message violates `ck_upload_extractions_error_length`, is swallowed, and leaves the run stuck `running` |
| NIT-1 | Style | 068 up.sql omits `SET LOCAL client_min_messages = WARNING` that 022 carries |
| NIT-2 | Semantics | Cap day boundary is server-TZ `date_trunc('day', now())` (consistent with imageIngest, so acceptable — noting only) |
| NIT-3 | Data shape | A headword can land in `vocab_entries` in one run and `kgiu_entries` in a later run (pos-tag drift across OCR passes) — same source_id in two tables |
| NIT-4 | API | `GET /uploads/:id/extract` hard LIMIT 50 with no pagination (bounded and documented; fine for scope) |
| PRAISE-1..6 | — | See end — these must survive any fix pass |

## Detailed findings

### BLOCKER-1 — Daily Vision-page cap is defeated by deleting the upload (cost bypass)

- `db/migrations/068_upload_extractions.up.sql:105-107` — `fk_upload_extractions_upload ... REFERENCES book_uploads(id) ON DELETE CASCADE`.
- `server/src/services/uploadExtract.ts:499-506` — the cap sums `pages_requested` from `upload_extractions WHERE user_id = $1 AND created_at >= date_trunc('day', now())`.

The cap's ledger rows live or die with the upload. `DELETE /uploads/:id`
(`server/src/routes/uploads.ts`, existing route) is available to every user and
CASCADE-deletes all of that upload's extraction runs — including today's. The
loop "upload pages → extract 50 → delete upload → re-upload → extract 50" spends
unbounded Vision budget in a day; nothing counts failed OR succeeded pages once
the parent row is gone. This directly contradicts the stance the migration
itself cites (`068 up:30-32` — "same stance as image_captures counting
soft-deleted"): `imageIngest.ts:254-266` counts soft-deleted captures precisely
so deletion can't refund budget, but book uploads are hard-deleted, so the
mirrored posture doesn't actually hold here.

Fix direction: keep the ledger independent of the upload's lifetime — e.g.
`ON DELETE SET NULL` on `upload_id` (with the partial-unique index unaffected,
since a dead run is no longer `running`... note a live run's row must still
block via the FK or be settled first), or a separate per-user daily spend
counter, or soft-delete semantics for the runs. Any fix must keep the 409 claim
semantics intact.

(Note `BOOK_UPLOAD_DAILY_CAP` = 10 uploads/day does bound the loop's iterations,
but 10 re-uploads × 50 pages = 10× the intended Vision budget — still a real
bypass, not a theoretical one.)

### BLOCKER-2 — Visibility fence applied to only some read surfaces; extracted private rows leak cross-user

The change correctly establishes (and tests) that extracted rows are private:
browse fences in `server/src/routes/vocab.ts:153-160` / `grammar.ts:103-110`,
detail fences at `vocab.ts:523-530` / `grammar.ts:153-168` ("another user
probing sequential ids must get the same 404"), weekly picks `grammar.ts:445-452`,
and the grammar diagnostic seed `diagnostic.ts:419-426`. But three read
surfaces over the same tables were not fenced, and each one defeats the
sequential-id-probe defense the fenced routes document:

1. **`pickVocabSeed` — `server/src/routes/diagnostic.ts:394-396`.** Selects
   `FROM vocab_entries WHERE korean IS NOT NULL ... ORDER BY random()` with no
   `source_upload_id IS NULL` filter. Its sibling `pickGrammarSeed`
   (`diagnostic.ts:419-426`) got exactly this filter in this diff, with a
   comment explaining why ("private to the upload's owner AND uncurated OCR
   candidates — this helper has no user context"). Every argument applies
   verbatim to the vocab seed: another user's diagnostic can now be seeded from
   a word extracted out of my private book upload, exposing its
   `korean`/`english` in generated items.

2. **`POST /vocab/entries/:entryId/bank` — `server/src/routes/vocab.ts:560-577`.**
   The existence check (`SELECT proficiency FROM vocab_entries WHERE id = $1`)
   has no fence. A stranger who probes sequential ids can bank a foreign
   extracted entry (confirming existence — the fenced detail route's 404 is
   moot) and then read the row's full `korean`/`english` through their own
   card listings (`vocab.ts:919` JOIN) and review flow.

3. **Vocab lists — `server/src/routes/vocabLists.ts:236-247` (create-with-seeds
   existence check), `vocabLists.ts:618-640` (typed add — inserts arbitrary
   `entry_id`/`kgiu_entry_id` with no existence or ownership check at all;
   the FK is the only gate).** Once a foreign extracted id is in a list, the
   list-entries read (`vocabLists.ts:341-361`) returns `v.korean, v.english,
   v.example_korean, v.example_english, g.pattern, g.title_en` for it, and the
   list→cards seeding (`vocabLists.ts:884-895`) banks it.

The fence test (`server/tests/routes/uploadExtract.test.ts:547-598`) covers
browse + detail only, which is exactly the coverage gap.

Fix direction: add the same
`(source_upload_id IS NULL OR EXISTS (... bu.user_id = $n))` predicate to the
bank existence check and both vocab-lists add paths (and the lists display/seed
joins, or rely on add-time fencing plus the fact lists are user-owned), and
`AND source_upload_id IS NULL` to `pickVocabSeed`. Extend the fence test to
probe bank + list-add with a stranger's agent.

### SF-1 — Daily-cap check is racy across two uploads of the same user; the comment overclaims

`server/src/services/uploadExtract.ts:495-497`: "inside the claim tx so two
concurrent triggers can't both read a pre-spend total." That holds only for the
SAME upload, where `SELECT ... FOR UPDATE` on `book_uploads`
(`uploadExtract.ts:448-452`) serializes claims. For two concurrent triggers on
two DIFFERENT uploads owned by one user, `withTransaction` runs plain `BEGIN`
(READ COMMITTED — `server/src/db/pool.ts:146`), each tx's SUM
(`uploadExtract.ts:499-506`) cannot see the other's uncommitted claim row, and
nothing locks the user: both pass at `usedToday = cap - 20` and commit,
overshooting the cap by up to `MAX_EXTRACT_PAGES_PER_RUN - 1` per extra
concurrent upload. Overshoot is bounded (20/run) and this is a single-user app,
so not a blocker — but the comment asserts a guarantee the code doesn't provide.
Fix: `pg_advisory_xact_lock` keyed on userId (or `SELECT ... FOR UPDATE` on the
users row) before the SUM; at minimum correct the comment.

### SF-2 — Crash mid-run permanently bricks extraction for that upload

The claim commits `status='running'` in tx1 (`uploadExtract.ts:529-543`); the
only paths that settle it are in-process (`uploadExtract.ts:624-655` done,
`:683-704` failed). If the process dies mid-OCR (deploy restart, OOM, SIGKILL),
the row stays `running` forever, `uq_upload_extractions_upload_live`
(`068 up:156-158`) then 409s every future trigger for that upload, and there is
no reaper, no timeout takeover, and no user-visible way out short of deleting
the upload (which, per BLOCKER-1, also erases the ledger). A synchronous
pipeline on a Docker-deployed personal app WILL hit a restart mid-run
eventually. Fix direction: treat a `running` run older than a threshold (e.g.
15 min — a 20-page run is minutes) as dead at claim time — settle it `failed`
inside the claim tx before inserting the new claim.

### SF-3 — `pos` skips the curation-boundary re-sanitization the module promises

`uploadExtract.ts:62-67` ("Every field passes through the shared
sanitizeUserInput guard") and `:257-260` ("a buggy/mocked proxy still can't
push oversized or marker-bearing text into the corpus") — but
`uploadExtract.ts:281` takes `raw.pos ?? null` untouched and persists it at
`:361` into `part_of_speech`. Upstream, `ImageWordPosSchema` is a closed
`z.enum(['n.','v.','adj.','adv.','pn.'])`
(`server/src/services/claude/models.ts:288`), so with the REAL proxy this is
safe — but the stated defense is precisely against a buggy/mocked proxy, and
`pos` is the one field that defense doesn't cover (TypeScript types are erased
at runtime; a stub returning `pos: '<user_input>...'` persists verbatim).
Fix: validate `pos` against the closed set at the curation boundary (map
unknown → null) — one line, closes the stated invariant.

### SF-4 — Empty-message failure leaves a run stuck `running` via a swallowed CHECK violation

`ck_upload_extractions_error_length` requires `length(error) BETWEEN 1 AND 2000`
(`068 up:120-121`). `errorSummary` (`uploadExtract.ts:717-721`) returns
`err.message`, which can legitimately be `''` (e.g. `new Error('')`, some
driver errors); `left('', 2000)` is `''`, the UPDATE (`uploadExtract.ts:690-699`)
then violates the CHECK, the catch at `:700-703` swallows it, and the run stays
`running` — permanent 409 for that upload (compounding SF-2). Fix:
`errorSummary` should fall back to a non-empty sentinel
(`return msg || 'unknown error'`).

## NITs

- **NIT-1** — `068_upload_extractions.up.sql` (and down) omit
  `SET LOCAL client_min_messages = WARNING;` that 022 opens with
  (`022 up:39`). Cosmetic inconsistency with the mirrored migration.
- **NIT-2** — Cap window `created_at >= date_trunc('day', now())`
  (`uploadExtract.ts:503`) is a server-TZ calendar day, not a rolling 24 h —
  same posture as the image cap, so consistent; noting for operators.
- **NIT-3** — A headword pos-tagged in run 1 (→ `vocab_entries`) and untagged
  in run 2 (→ `kgiu_entries`) yields the same `upload-{id}-{kr}` source_id in
  BOTH tables (`uploadExtract.ts:281-285, 400-402`) — the per-table UNIQUE
  can't see across tables. Harmless duplication, but worth a cross-table
  existence check if it ever bothers the grammar-from-upload view.
- **NIT-4** — `GET /uploads/:id/extract` returns at most 50 runs with no
  offset (`routes/uploads.ts`, GET handler) — bounded and consciously
  documented; fine at this scope.

## PRAISE (must not be undone by any fix pass)

- **P-1** — The tx shape is exactly right: claim tx → OCR with NO transaction
  open → single atomic persist+settle tx (`uploadExtract.ts:443-546, 550-606,
  624-655`). No Vision call ever holds a connection's transaction.
- **P-2** — The claim INSERT as concurrency arbiter via the partial UNIQUE
  (`068 up:156-161` + `uploadExtract.ts:527-543`) is genuinely TOCTOU-free for
  the same upload: no check-then-insert window, 23505 mapped to a typed 409.
- **P-3** — `pages_requested` = COUNT of real `book_pages` rows, not the raw
  span (`068 up:82-85`, `uploadExtract.ts:507,535`), so sparse ranges can't be
  gamed; failed runs stay in the ledger and the cap check precedes any
  upstream call, asserted in a test with a proxy spy
  (`uploadExtract.test.ts:322-348`).
- **P-4** — Per-word injection screening with skip+count semantics
  (`uploadExtract.ts:256-274`) — one poisoned word can't veto a page, and the
  filtering is observable via `words_skipped` on the run row.
- **P-5** — The migration is disciplined: idempotent enum DO-block,
  IF NOT EXISTS throughout, ADR-013 transaction ownership, correct F-088
  markers, CHECK relax strictly more permissive with names preserved, and a
  down that fails loudly on a populated user_mined corpus — verified verbatim
  against 002:301-310 and the 022 posture it cites. 027 touched only
  `ck_kgiu_entries_pattern_required`, so the down's "verbatim" claim is
  accurate.
- **P-6** — Ownership 404 (never 403) with `FOR UPDATE` on the parent so a
  concurrent upload DELETE serializes against the claim
  (`uploadExtract.ts:444-456`); blob reads only via the traversal-checked
  `uploadStore.readBlob` (`uploadStore.ts:108-131`); `.strict()` body schema
  on the trigger route.

## Coordination observations

- BLOCKER-2's three unfenced surfaces live in files partly OUTSIDE this diff
  (`vocabLists.ts`, the bank route in `vocab.ts`) — the fix pass should treat
  "who can read `vocab_entries`/`kgiu_entries` rows" as a single audit, not a
  per-route patch; `hanja.ts:272` and `vocab.ts:800` (weekly) were checked and
  are safe (hanja requires the user's own live card + `hanja IS NOT NULL`;
  weekly restricts corpus to `vocab_2000_*`), and `POST /vocab/cards/init` is
  safe via its corpus enum (`vocab.ts:443`).
- BLOCKER-1's fix touches migration 068 (the FK action) — if 068 has already
  been applied to the shared live DB, the fix must ship as a NEW migration
  (069), not an edit of 068, per the project's runner-owned versioning
  (`km_never_manually_apply_migrations`).
- `docs/BUILD_b8_f108_ocr.md` is accurate about what was built but its fence
  claim ("Cross-user visibility fences | vocab.ts, grammar.ts, diagnostic.ts")
  describes incomplete coverage as if complete — update it alongside the fix.
- The test suite's fence describe block should gain stranger-probes for
  bank + list-add + diagnostic seeding once BLOCKER-2 is fixed, or this exact
  gap will regress silently.
