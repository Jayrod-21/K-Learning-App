# BUILD b8 — F-108 · U2 extraction/OCR pipeline (backend)

**Branch:** `feat/f108-u2-extraction` (worktree off `rebuild`)
**Ticket:** F-108 — "Build the OCR trigger route + pipeline reading `book_pages`
images; populate `kgiu_entries.source_upload_id` at curation. Unblocks F-059
(the viewer's honestly-disabled 'Extract text' button) and makes F-056's
grammar-from-upload view return real rows."

## What was built

| Piece | File |
|---|---|
| Extraction-run table + kgiu CHECK relaxation | `db/migrations/068_upload_extractions.{up,down}.sql` |
| Pipeline service (claim → OCR → curate → persist) | `server/src/services/uploadExtract.ts` |
| Trigger + status routes | `server/src/routes/uploads.ts` (`POST`/`GET /uploads/:id/extract`) |
| Daily Vision-page cap config | `server/src/config/index.ts` (`UPLOAD_EXTRACT_DAILY_PAGE_CAP`, default 50) |
| Cross-user visibility fences | `server/src/routes/vocab.ts`, `routes/grammar.ts`, `routes/diagnostic.ts` |
| Tests (20, testcontainer Postgres, proxy always mocked) | `server/tests/routes/uploadExtract.test.ts` |
| Migration ledger rows (067 backfilled + 068) | `db/migrations/README.md` |

## Design decisions

### 1. Extraction-run table (`upload_extractions`, migration 068)

One row per **run** — a bounded page-range slice, not per page and not per
upload. Columns: status enum (`pending`/`running`/`done`/`failed`; `pending`
reserved for a future async runner — the synchronous pipeline claims directly
as `running`), `page_from`/`page_to`/`pages_requested`, result counts
(`pages_ocred`, `pages_failed`, `vocab_inserted`, `grammar_inserted`,
`words_skipped`), bounded `error`, `started_at`/`finished_at`, standard audit
cols + `set_updated_at()` trigger.

- **Observable**: `GET /uploads/:id/extract` reads real rows (status surface
  for F-059's button).
- **Resumable**: an omitted range defaults to `MAX(page_to)+1` over the
  upload's `done` runs — a 500-page book is worked through in slices.
- **Concurrency-idempotent**: partial UNIQUE `(upload_id) WHERE status IN
  ('pending','running')` makes the claim INSERT the arbiter — a concurrent
  second trigger gets 23505 → 409, never a double Vision spend.
- **Cost-accountable**: `pages_requested` (the count of `book_pages` rows
  actually in range at claim time, not the raw span) is what the daily cap
  sums; failed runs still count — a cap is a *cost* control and a failed run
  spent money too (same stance as `image_captures` counting soft-deleted).
  The ledger **survives upload deletion** (`fk_upload_extractions_upload` is
  `ON DELETE SET NULL`, `upload_id` nullable — fixpass b8 BLOCKER-1): the cap
  sums by the denormalized `user_id` alone, so extract→delete→re-upload can
  never refund budget (a CASCADE here was the original design's cost-bypass
  hole).
- `user_id` is denormalized (written from the ownership-checked parent inside
  the same tx) so the hot-path cap query needs no join — and so orphaned
  ledger rows stay chargeable to the user who spent the money.
- **Crash-recoverable**: a run left `running` by a process death is settled
  `failed` by the next claim once older than `STALE_RUN_MINUTES` (15) —
  inside the claim tx, so the partial-unique claim can never be permanently
  bricked by a restart mid-run (fixpass b8 SF-2).

068 also relaxes `ck_kgiu_entries_corpus_kgiu_only` /
`ck_kgiu_entries_level_matches_corpus` to admit `'user_mined'` — the exact
maneuver migration 022 performed on `vocab_entries` (strictly more
permissive; same constraint names; `book_level='beginner'` +
`proficiency='L3'` sentinels). The down restores both CHECKs verbatim and
**fails loudly** if user_mined kgiu rows still exist (022's documented
posture: destroying extracted content is a deliberate operator act).

### 2. Page-range + cost-cap rationale

- **Hard span ceiling 20 pages/run** (`MAX_EXTRACT_PAGES_PER_RUN`), default
  slice 10: one page = one Vision call = seconds of latency and real money; a
  blind full-book run would be ~500 calls. 20 keeps the synchronous request
  inside proxy/browser timeouts and aligns with the daily budget.
- **`UPLOAD_EXTRACT_DAILY_PAGE_CAP` (default 50/day/user)**, checked *inside
  the claim transaction, before any upstream call* → 429
  (`ExtractionDailyCapError`), with a structured log line recording what was
  refused. The claim's `FOR UPDATE` on `book_uploads` only serializes claims
  for ONE upload, so the cap read additionally takes a **per-user advisory
  xact lock** (`pg_advisory_xact_lock`, keyed on the user id) before the SUM —
  without it, concurrent triggers on two different uploads of the same user
  both read the pre-spend total under READ COMMITTED and can jointly overshoot
  the cap (fixpass b8 SF-1/S-3; the original doc overclaimed here). A separate
  knob from `IMAGE_OCR_DAILY_CAP` because a deliberate book-extraction session
  legitimately burns more Vision calls than photo mining, and the two budgets
  shouldn't starve each other.
- Synchronous execution (no job runner exists in this codebase; U1a set the
  precedent with synchronous zip normalization). If bigger ranges are ever
  wanted, the schema already supports an async runner (`pending` status).

### 3. Curation boundary (`curateOcrWords` — pure, no I/O)

"Populate at curation" (ticket wording) = raw OCR output never touches the
corpus tables. Between OCR and persist, every word passes a pure boundary:

- **Sanitize**: `kr`/`en`/`gloss` each go through the shared
  `sanitizeUserInput` (NFC + control-char strip + injection-marker rejection,
  bounded at the OCR schema's own ceilings). A rejected/blank word is
  **skipped and counted** (`words_skipped`) — per-word, so one poisoned line
  can't veto a page; same guard docAttach.ts applies at upload. Rationale:
  this text is *persisted content that re-enters Claude prompts* (drills,
  enrich, diagnostics read these tables).
- **Dedup**: one curated row per headword per run; page numbers merge into
  `source_pages` (real provenance, e.g. `[3, 7]`).
- **Classify (v1 heuristic)**: on grammar-bearing uploads (`type`
  `'grammar'`/`'both'`), a word the Vision model left *untagged* for
  part-of-speech is a grammar-pattern candidate (KGIU-style strings like
  "-았/었더니" aren't n./v./adj./adv./pn.); pos-tagged words are vocabulary
  even in a grammar book. Non-grammar uploads send everything to vocab. The
  `ocrImage` contract (reused as mandated — no new OCR engine/route) returns
  word-shaped output only, so this is the honest v1; a richer grammar-aware
  extraction prompt is a follow-up (see below).

### 4. Persist + idempotency mechanism

`persistExtraction(client, …)` runs on the **caller's** transaction (the
imageIngest split: OCR outside tx, persist inside) together with the run's
`done` settlement — content and settlement commit-or-roll-back atomically; a
mid-persist failure leaves zero corpus rows and the run settles `failed` via
a separate best-effort, status-guarded UPDATE.

Row-level idempotency: deterministic `source_id = upload-{uploadId}-{kr}`
arbitrated by both tables' existing `UNIQUE (corpus, source_id)` via
`ON CONFLICT DO NOTHING` — a re-run re-charges Vision (the user asked it to)
but can never duplicate or clobber content. Inserts mirror `POST /vocab/mine`
(the established route-populated `user_mined` pattern): vocab rows carry
korean/english/part_of_speech; kgiu rows carry `pattern` (the headword,
satisfying the pattern-required CHECK), `title_en`, `explanation` (the
gloss), `entry_type='grammar'`, `category='uploaded'`. Every row carries
`source_upload_id = :uploadId` — the column F-056 and the U3a source filters
read.

### 5. Cross-user visibility fences (security consequence of the inserts)

`vocab_entries`/`kgiu_entries` are shared reference tables, but extracted
rows derive from a user's **private** upload. Without a fence they'd surface
in every user's browse/detail/suggestions. The rule (fixpass b8 hardened it
into ONE audit surface — `server/src/db/corpusFences.ts`, whose
`sourceUploadFenceSql` fragment every owner-conditional site composes): any
query that returns row content **or validates a client-supplied id** carries
`(source_upload_id IS NULL OR EXISTS(owner))`. Fence sites:

- `GET /vocab/entries` (browse) + `GET /vocab/entries/:entryId` (detail)
- `GET /grammar/kgiu` (Reference list) + `GET /grammar/kgiu/:id` (detail)
- `POST /vocab/entries/:entryId/bank` — the existence check (fixpass b8 B-2:
  unfenced, it was an existence oracle AND exfiltrated content through the
  caller's own `GET /vocab/cards/due` join)
- `POST /vocab/lists` seed validation + `POST /vocab/lists/:id/entries`
  typed-add validation, for BOTH the vocab and grammar target types (fixpass
  b8 B-3: the only path that leaked extracted **kgiu** content)
- `/grammar/suggestions/weekly` and `diagnostic.ts pickGrammarSeed` **and
  `pickVocabSeed`** (fixpass b8 B-1 — the vocab twin was missed; extracted
  rows are written `proficiency='L3'`, so they matched the first targeted
  pass of any user's diagnostic): `source_upload_id IS NULL` outright —
  extracted rows are uncurated OCR candidates, wrong for curated
  suggestion/seed pools regardless of owner.

Verified safe WITHOUT a fence: `POST /vocab/cards/init` +
`/vocab/suggestions/weekly` (closed curated-corpus allow-lists), `hanja.ts`
(joins through the user's own cards). The U3a source-filter branches
(already shipped with owner-EXISTS guards) are unchanged — the owner sees
their rows exactly there. Every fence above is pinned by an adversarial
stranger-probe test (`uploadExtract.test.ts`).

Other enumerated threats + defenses are documented in
`server/src/services/uploadExtract.ts`'s header (IDOR → uniform 404;
path traversal → `uploadStore.readBlob` only; per-page 8 MiB bound; mass
assignment → `.strict()` bodies).

## Gate results (all run, not trusted)

| Gate | Result |
|---|---|
| `npm ci` | clean, 0 vulnerabilities |
| `npm run typecheck` | **0 errors** |
| `npm run lint` | **0 errors** (warnings = pre-existing `no-non-null-assertion` style, matches codebase) |
| `npx vitest run tests/routes/uploadExtract.test.ts` | **20/20 passed** (testcontainer Postgres, proxy mocked — no real Vision call anywhere) |
| Regression: `uploads` + `vocab` + `grammar` + `diagnostic` route suites | **280/280 passed** |
| Migration 068 on scratch Postgres 16 | up ✅ · up again (idempotent) ✅ · live `user_mined` kgiu INSERT under relaxed CHECK ✅ · down ✅ · schema diff before-068 vs after-down **empty** (only pg_dump's random `\restrict` nonce) · re-up ✅ |

Test-to-bug-class map: happy-path provenance (wrong/missing
`source_upload_id`), idempotent re-trigger (double-insert), cap-429-before-
upstream with a proxy spy (silent budget burn), claim-409 (concurrent double
charge), cross-user 404 on both routes (IDOR), range validation ×3, partial
page failure vs total failure vs missing blob (half-run semantics),
injection-word skip (poisoned corpus → wedged prompts), resume default,
`persistExtraction` rollback (half-write), visibility fences (private-content
leak), `.strict()` mass assignment.

## Notes / follow-ups to file

- **F-059 client half**: enable the "Extract text" button → `POST
  /uploads/:id/extract` (empty body = resume), render `GET .../extract` runs.
  Server contract: `201 {run}` / `400/404/409/429`; GET returns
  `{runs, max_pages_per_run}`. CLIENT-only ticket.
- **F-056 backend is now real**: `GET /grammar/kgiu?source_upload_id=X`
  returns extracted rows for the owner — client sub-page can wire up.
- **Richer grammar extraction** (follow-up): the reused `ocrImage` route
  returns ≤30 vocab-shaped words/page; a dedicated extraction prompt could
  return structured pattern + explanation + examples. The run table, curation
  boundary, and idempotency keys all carry over.
- **No nginx change needed**: routes live under the already-allow-listed
  `/uploads` prefix (see km_nginx_api_route_allowlist).
- `book_uploads.status` is deliberately untouched by extraction — U1a already
  settles it at upload time ('ready'); run state lives wholly in
  `upload_extractions` (migration 040's "U2 sets status" comment predates the
  041 rework).
