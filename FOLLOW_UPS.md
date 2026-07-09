# Follow-ups — Korean Master (local M deploy)

Tracked deferrals from the local stand-up + `/fixpass` cycles. None block the
running stack; each is a real improvement to schedule.

## Corpus ingest — blocked sources (need OCR or source acquisition)
The local ingest loaded **TTMIK lessons (232 lessons / 2,742 sentences)** and
**TTMIK Iyagi (139 episodes / 11,162 turns)** — the only sources with a usable
PDF text layer. Still to do, each requiring work beyond a re-run:
- **Darakwon KGIU grammar (Beginner/Intermediate/Advanced)** — PDFs have a bad
  Adobe OCR layer; needs re-OCR before `parse` + `load_kgiu` can run.
- **Darakwon 2000 Essential Words (Beginner/Intermediate)** — image-only PDFs
  (no text layer); needs OCR, then `load_vocab_2000`.
- **TOPIK practice papers** — image-only PDFs; needs OCR, then `load_topik`.
- **KRDICT (국립국어원 dictionary)** — loader is ready (`load_krdict.py`) but the
  bulk XML source is not on this box; acquire it, then `Deploy/load-krdict.sh`.
- **HTSLANS** — audio only, no text/PDF source; out of scope until a script exists.

## Dependency advisories (soft gates — bar §3.11 wants these addressed)
The `local-test.sh` soft gates report advisories (non-blocking, mirrors CI's
`|| true`): `npm audit --audit-level=high` (client + server) and `pip-audit`
(ingest loader deps + kiwi).

**DONE (2026-07-01, non-breaking):** `npm audit fix` in client + server.
- **client → 0 vulnerabilities** (react-router, vite, postcss patched in-range).
- **server 12 → 7** (protobufjs etc. patched).
- `pip-audit`: only `pip` the installer is flagged (not a shipped dep) — noise.

**REMAINING (7, server) — all need a BREAKING major bump; do each as its own tested change:**
- `vitest` / `esbuild` / `vite` / `vite-node` (moderate) — **dev+test tooling only**, not in
  the prod image. Fix = `vitest@4` (major); verify the whole suite still passes after.
- `@anthropic-ai/sdk` 0.79→**0.109** (moderate) — the advisory is the SDK *Memory Tool*
  path/permissions issue; this app doesn't use that feature, so low real exposure. The SDK
  API changed a lot across that range — bump carefully and re-run the claude-service tests.
- `uuid`→**14** (moderate) — flaw is `v3/v5/v6` with a provided buffer (not our usage).
Consider promoting the audits to HARD gates once these are clean (bar wants SCA to fail on HIGH/CRITICAL).

## Loader cosmetics
- `count_assertion_mismatch` warnings during multi-file loads: the per-file count
  assertion compares one file's expected count against the *cumulative* table
  total, so it warns whenever >1 file loads into the same table even though every
  file reports `loaded == expected`, `skipped: 0`, `status: complete`. Cosmetic;
  worth making the assertion cumulative-aware.

## Commit hygiene
- New untracked file `client/src/lib/grammarKey.ts` must be `git add`ed together
  with the modified `Reference.tsx` / `Reference.test.tsx` or the client build
  breaks (flagged by the fixpass re-review).

## Test-suite polish (from /fixpass reviews — deferred nits)
- Move the `grammarKey` unit tests out of `Reference.test.tsx` into a dedicated
  file (R3 nit).
- `local-test.sh`: pin `node:20-slim` / `python:3.12` by digest; make `db_suite`'s
  inlined pin set track a manifest (N1, N6).

## Tester-sweep deferred items (2026-07-05, see db/docs/SWEEP_*.md)

Batch A (client UX) + Batch B (TOPIK picture-item exclusion + study survivor guard)
shipped. Deferred:

- **F-UP-006 (P2, data) — all 232 TTMIK lesson titles are the placeholder "Level N
  Lesson M"** (`tools/ingest/parse_ttmik.py:127`), never the real name. 100% of
  Listen browse rows + headers. Needs the real titles from the TTMIK source (data
  availability unknown) + a re-ingest; not a code one-liner.
- **F-UP-007 (P3) — Mock section-select advertises a fixed item count** ("50 items"
  in `MockMode.tsx:94-98`) but the mock serves all corpus items for the picked
  test (~80). Product call: cap the mock to the official TOPIK II counts (Reading
  50 / Listening 50) vs. show the real dynamic count. Left as-is pending that call.
- **F-UP-008 (P3) — Review "More examples" drawer is dead** (`extra` hardcoded to
  `[]` when mining a card) — the affordance is already correctly hidden when empty,
  so this is "populate `extra`", a data-plumbing task, not a bug.
- **F-UP-009 (P3) — data quality — ⚠️ live-fixed, loader root-cause deferred:**
  L6L12 was the ONLY lesson with duplicate `ordinal`s — its grammar block and an
  appended "Word Builder 과" Hanja block both started ordinals at 1. Re-sequenced
  live (16 unique ordinals, grammar then Word Builder). **Durable fix deferred:**
  the loader assigns per-sub-section ordinals that collide when sub-sections merge
  into one lesson; it should assign a single unique sequence per lesson (else a
  re-ingest reintroduces the collision). L9L5 (content-empty) got a real title
  from the TTMIK syllabus in the F-UP-006 titles work. No `(lesson_id, ordinal)`
  unique index exists on `ttmik_sentences` — consider adding one.

## Rate-limit retry_after (from B-016 review, 2026-07-05)

- **F-UP-004 (P3) — ✅ RESOLVED 2026-07-05:** `message` is now a function
  (`rateLimitedMessage`) that computes `retry_after` from `req.rateLimit.resetTime`
  (precise per-client seconds; falls back to the full window; floored at 1s).
- **F-UP-005 (P3) — ✅ RESOLVED 2026-07-05:** the shared `rateLimitedMessage`
  helper is applied to ALL four limiters (cheap, expensive, auth, media), so every
  429 carries `retry_after` (auth keeps its `too many auth attempts` text). Auth
  429 test strengthened to assert the field.

## CI ingest test-gate (surfaced 2026-07-05 when the gate was added)

The `ingest-checks` CI job now runs `pytest tests/` (272 green). Two sets of tests
are `--ignore`d in that job; both are tracked here.

### F-UP-002 · `strategy_c_claude` produces no dependency for a matching kgiu_entry (2 tests) — ✅ RESOLVED 2026-07-05
- **Root cause (real production bug, caught by the /fixpass review):**
  `strategy_c_claude` read the proxy response as top-level `result["pattern"]` /
  `["confidence"]`, but `/grammar/identify` returns the `ProxyResult` envelope
  `{"result": {"patternKey", "confidence", …}, "metadata": …}`
  (server/src/services/claude/models.ts). So against real infra `pattern_text` was
  ALWAYS `""` → Strategy C silently produced ZERO deps regardless of threshold. The
  originally-quarantined tests' FakeProxy mirrored the same buggy top-level shape,
  so they could never have caught it.
- **Fix:** (1) read `result["result"]["patternKey"]` + `["confidence"]`. (2) both
  tests' FakeProxy now return the REAL envelope (`_proxy_result()` helper), so they
  validate the actual contract — reverting the code read fails them. (3)
  `_STRATEGY_C_MIN_FRAGMENT_HANGUL_CHARS` 3→2 (the filter targets single-SYLLABLE
  fragments per its own comment, but 3 also dropped legit 2-syllable forms like
  `으면`). Ingest suite 290→292; both tests re-included in CI.
- **Severity:** real linker bug, P2.

### F-UP-011 · test_link_topik_dependencies order-dependence — ✅ resolved 2026-07-06
- Surfaced by the F-UP-010 re-review (pre-existing — `git archive` confirmed it
  predates F-UP-010). `test_strategy_a` (and, found via `pytest-randomly`,
  `test_strategy_b`) asserted exact dep counts / matched-id sets that were
  contaminated by rows other tests seeded into the module-scoped shared DB.
- **Fixed at the root:** an autouse `_isolate_tables` fixture TRUNCATEs the seeded
  tables (topik_dependencies/items/tests, kgiu_entries, vocab_entries,
  corpus_sources) before EVERY test, so the whole file is order-independent.
  Verified: 15 passed on normal order + all of `pytest-randomly` seeds 1–10 (was
  failing seed 1 before). No per-test assertion changes needed.
- **Deferred:** actually turning ON `pytest-randomly` for the ingest suite in CI —
  that needs the OTHER ingest test files audited for the same coupling first; this
  fix only hardens `test_link_topik_dependencies.py`.

### F-UP-010 · strategy_c pattern match brittleness — ✅ fully resolved 2026-07-06
- **Full fix shipped — alternation-aware expansion.** The interim safe variant
  (raw + syllable-normalized-if-≥3) was replaced by `_pattern_alternant_forms`,
  which expands the KGIU/TTMIK notation into Hangul-syllable SURFACE forms word by
  word (`(X)` optional, `X/Y` alternation within a word, `A/V`/`N` POS placeholders,
  `①②③` markers, cartesian product across space-separated words). The matcher links
  a candidate when the raw substring matches OR the two patterns' form sets
  INTERSECT.
- This **recovers the 2-syllable case the interim variant couldn't**: Claude `-는데`
  shares the form `는데` with stored `-(으)ㄴ/는데` → linked; while `-다가` (form
  {다가}) does NOT match `-아/어다가` (form {어다가}) — the conservative `/`-split (no
  shared-suffix guessing) keeps it precise. Multi-word keys match on the FULL
  `claude_pattern`, not the space-truncated first word (so `-으려고 하다` → whole
  form `으려고하다`).
- **Structure-aware forms (fixpass BLOCKER fix):** per-word syllable parts are
  joined with a boundary marker (`_KGIU_FORM_SEP`), and `(X)` optionals are expanded
  on the whole sub-string BEFORE the word split. So a one-word `는데` (form `는데`)
  does NOT collide with the two-word nominalizer `-는 데` (form `는␟데`), and
  `-(으)ㄹ 만하다` does NOT collide with `만 하다` — the two false positives the
  first cut had. **Real-corpus cross-links: 26 (strip) → 11 (concat) → 6 (this),
  and all 6 are CORRECT** (same-grammar sense/POS variants like `-(으)ㄹ까요? ①↔②↔③`
  + the `대로` family). The `irregular` category (7 `'X' 불규칙` references) is excluded.
- The caller gate + matcher were fixed so a MULTI-WORD key with a short first word
  (`-(으)ㄹ 만하다` → first run `으`) still reaches the form arm (the raw arm stays
  gated at 2 syllables). Candidate fetch is `ORDER BY id` (deterministic cap).
- Tests: expander unit test, `는데`/`-으려고 하다` recall (empirically-proven
  revert-catchers), `-다가`≠`-아/어다가` + `-는데`≠`-는 데` precision, and an
  end-to-end `strategy_c_claude` test through the real gate. See
  `db/docs/FIX_REPORT_FUP010.md` + `REVIEW_FUP010_FULL.md`.

### F-UP-013 · 4 topik_items with answer keys that contradict their own content (P3, DATA) — ✅ RESOLVED 2026-07-06
Surfaced by the F-019 explanation pass (the generator skipped them rather than ship a
contradictory explanation). Each has enough accessible content to check, and the keyed
`answer` looks WRONG against it:
- **222** — two options both fail to match the self-contained text (no single clean answer).
- **659** — keyed blank-fill contradicts the cap-and-trade logic (the "must buy" firm should
  be an OVER-emitter, not one under its allocation).
- **769** — transcript present, but the keyed answer is the WOMAN's argument while the stem
  asks for the MAN's view.
- **1086** — keyed answer not cleanly separable from a competing, equally-supported option.
Likely source-bank answer-key alignment bugs, not un-explainable items. Manually re-check
each `answer` against its stem/passage; if wrong, correct in the corpus + DB (these items
are served in study/mock, so a wrong key mis-grades a learner). Low volume (4 of 2,088).

### F-UP-014 · topik_attempts resurrect-race — mitigated, not fully closed (P3, F-007) — ✅ RESOLVED 2026-07-06
The mock-resume save race (a progress `PUT /topik/attempt` in flight when the exam
submits) is mitigated but not eliminated. `doSubmit` aborts the in-flight save and
`runSubmit` fires a `clearAttempt()` mop-up on real-submit success — but the abort is
CLIENT-side only, so a PUT already on the wire that the server delays past BOTH the
`/mock/submit` DELETE and the `clearAttempt` DELETE can still re-INSERT the row and
resurface a resume banner for a graded test. Window is far narrower than pre-fix and
recoverable (dismiss / re-submit). Acceptable for the private single-device app; the
robust fix (server-side `version`/tombstone guard on `topik_attempts`, or scoping the
mop-up to a returned attempt id) should be done BEFORE any multi-device or public use.
Verified + accepted in `db/docs/REVIEW_FIXES_F007.md` (PASS with this recorded residual).

### F-UP-019 · F-018 data + cleanup residuals (2026-07-06, P3) — ⚠️ reference.ts cleanup done; dialogues data DEFERRED (source lacks it)
- **Grammar `dialogues` empty in all 294 corpus rows**: F-018 renders the Dialogues section
  defensively but it's invisible because no row has dialogue data. If the Darakwon KGIU source
  carries dialogues, extend the loader/parser to populate `kgiu_entries.dialogues` (shape
  `{context, lines:[{speaker,korean,english}], alternatives?}`) — then the section lights up
  with no client change. Also `register` is fetched-but-not-carried on the detail wire (optional).
- **Dead-code candidate**: `client/src/data/mocks/reference.ts` has zero importers — deleting it
  would also orphan the `ReferenceEntry` type in `domain.ts`. A deliberate cleanup, not urgent.

### F-UP-018 · Bug-sweep residuals (2026-07-06, all P3 unless noted) — ⚠️ mostly resolved 2026-07-06 (explanation tail closed; polish done; DEFERRED: blanket rate-limit, topik_level persist pre-level-picker, Claude-spend monitoring, B-012 upstream)
Deferred items from the intense bug sweep (findings in `db/docs/SWEEP_*.md`; fixes in
`FIX_sweep_*.md`; re-reviews in `REVIEW_SWEEP_*.md`). The sweep fixed ~40 defects incl. a
CRITICAL server crash + the TOPIK-mock level merge; these are the honest leftovers:
- **Residual bad explanations (~2–5, max ~10)**: batch F audited all 1,926 enriched rows +
  fixed 45, but ~289 paraphrase-only explanations are heuristic-blind (sampled clean).
  A follow-up **LLM re-verification pass** over that bucket would close the tail. A `topik_items_explanation_bak_20260706` backup table holds the 45 pre-fix rows.
- **topik_level not persisted in `topik_attempts` (P2 — do BEFORE any level picker)**: the mock
  level-merge fix resolves deterministically today (client never sends `topikLevel`), but if a
  client-side level selector ships, F-007 resume + a split mock/submit level could mis-target.
  Persist `topik_level` on the attempt row + echo on submit first.
- **SSE redaction (services layer)**: the conversation proxy stream `error` events still forward
  raw `ev.message` from the services layer (route-level catches are redacted). Small services-scope fix.
- **Claude spend**: the 4 formerly-poison-cached routes (diagnostic_item, image_ocr, grammar-drill
  gen/score) are now genuinely uncached — watch the usage dashboard. `CLAUDE_CACHE_TTL_*_S=0` now means "uncached", not "forever".
- **UI error-state polish**: Diagnostic's now-reachable fatal branch echoes server prose with no
  retry; Hanja's featured-item failure renders as an empty "no hanja yet" state; the app-wide
  "echo ApiError.message into ErrorCard" contract-drift note (XSS-safe) across ~5 pages.
- **Rate-limit ordering**: some limiters run after `requireAuth` (middleware/rateLimits.ts) — review
  whether unauthenticated attempts should be limited first.
- **B-012 (vocab-2000)**: NOT a loader bug — the loader is faithful; the corpus *extraction* is
  ~400 words/level short of nominal 2,000. Needs re-extraction upstream, not a code fix.

### F-UP-017 · F-014 Writing rework — NITs from the /fixpass (P3) — ✅ RESOLVED 2026-07-06
Non-blocking NITs from the three F-014 reviews (full lists in
`db/docs/REVIEW_F014_{backend,ratelimit,frontend}.md`; re-review PASSed). Notables:
- **"New prompt" no-op when a rubric's server pool has exactly one prompt** — the
  rotate cursor wraps to the same prompt (only clears the draft). Fetch-another or
  disable the button at pool size 1.
- Backend nits (4): minor doc/observability polish on the series + persist paths.
- Rate-limit nits (2): 429 test/doc tidy-ups.
None affect correctness; batch them into a Writing polish pass or the app overhaul.

### F-UP-016 · F-017 stats carousel — 3 cosmetic NITs from the re-review (P3) — ✅ RESOLVED 2026-07-06
Left by the F-017 /fixpass re-review (verdict PASS; see `db/docs/REVIEW_FIXES_F017.md`), none
shippable-blocking:
- **Total-outage silence**: with `Promise.allSettled`, if ALL 3 series routes fail (network
  down), every panel shows "No data yet" with no "couldn't load" signal — rejection reasons
  are discarded. A distinct per-skill "unavailable" state (vs empty) would be more honest on a
  total outage. (Partial failure already degrades correctly.)
- **Theoretical capture-throw corner** in `SwipeCarousel` — a `setPointerCapture` throw during
  the `'h'`-lock transition isn't guarded; not reachable in practice.
- **Cosmetic 'cards' residue** in a generic `LineChart` test fixture (harmless label, not the
  vocab wire unit which is now correctly `reviews`).

### F-UP-015 · Resume-fetch failure is silent (P3, F-007, UX) — ✅ RESOLVED 2026-07-06
On the resume banner's "Resume", if `fetchMockTest(section, …, sourceTest)` fails, the
banner just disappears with no user feedback (`resumeAttempt`'s catch clears `resumable`
+ resets net to idle). Rare, but a brief "couldn't resume — start fresh" notice would be
better than a silent drop. Low priority (personal app).
From the F-UP-010-full re-review (PASS WITH CONDITIONS — not blockers):
- **Parenthetical-alternative parens.** `_pattern_alternant_forms` treats every
  `(X)` as an OPTIONAL MORPHEME, but ~3 patterns use `(…)` as a parenthetical
  ALTERNATIVE spanning a space (e.g. `안 A/V (A/V-지 않다)` = short vs long negation).
  These expand into garbage forms (`안␟지␟않다`) — not currently colliding with
  anything, but the 3 negation entries can't be form-matched (recall gap). Fix:
  detect a `(X)` whose content holds a space / `A/V` / `-` and treat it as a
  separate alternative sub-pattern (like a comma), not an inline optional.
- **Raw-arm candidate cap hit.** The matcher fetches all grammar rows and caps at
  `_STRATEGY_C_MATCHER_CANDIDATE_CAP = 25`. `kgiu-advanced-049` genuinely raw-matches
  25 unrelated entries, hitting the boundary — PRE-EXISTING raw-arm imprecision (the
  raw substring arm, not the new form arm), now demonstrated on real data. Consider
  tightening the raw arm (anchor it) or raising/removing the cap for the form arm.

### F-UP-003 · ingest CI exclusions — ⚠️ mostly resolved 2026-07-05
- **Original premise was wrong.** Re-checked on a clean checkout: `test_topik_item_type_validation`
  and `test_hanja_hunmeum` run clean (28 passed / 1 skipped — hanja `skipif`s its
  single output-dependent test), so they are now **un-ignored** in the ingest-checks
  job (CI 292 → 320 tests).
- **Residual (P3):** only `test_resolve_cross_references_integration` stays excluded,
  and NOT for an `output/` reason — it uses committed fixtures. Its
  `test_prerequisite_error_when_corpus_not_loaded` TRUNCATEs the shared module-scoped
  testcontainer to assert the "corpus not loaded" error, so it fails when run
  alongside its `schema`-fixture module-mates (passes in isolation). Fix = give that
  one test an isolated DB/schema, then drop the last `--ignore`.

## U3b (digitized chapter reader) — /fixpass re-review residuals (2026-07-08, all P3)
Paper trail: `db/docs/reviews/u3b-reader/`. All non-blocking; U3b shipped PASS.
- **README migration-table backfill — RESOLVED (2026-07-09, `feat/docs-migration-hygiene`)** —
  `db/migrations/README.md`'s table was missing every row after 017 except 041/044;
  backfilled 018–040 + 042/043 (descriptions sourced from each migration's own header
  comment).
- **Constraint-guard idempotency sweep — WON'T DO (2026-07-09)** — retrofitting the 044
  `DO $$ … IF NOT EXISTS $$` guard onto the ALREADY-APPLIED migrations 029/038 was
  attempted then reverted: editing an applied migration file changes its checksum, and
  `migrate.py` re-hashes applied migrations on every deploy, so it would raise
  `ChecksumMismatch` on the next prod `up` — not worth breaking the deploy pipeline for
  re-apply idempotency that only matters to dev re-runs. New migrations already use the
  guard (044); the old applied ones are left untouched.
- **ADR-019 addendum — RESOLVED (2026-07-09, `feat/docs-migration-hygiene`)** — addendum
  documents why `load_literature.py` is deliberately NOT wired into
  `load_to_postgres.py`'s corpus-enum dispatch (no `corpus` enum slot / no `load_state`
  checkpoint; structural delete-then-reinsert idempotency; invoked directly per book).
- **reading.ts header cross-reference (NIT) — RESOLVED (2026-07-09,
  `feat/docs-migration-hygiene`)** — header SECURITY block now cross-references
  migration 044's `COMMENT ON CONSTRAINT` caveat (composite FK pins ownership but does
  NOT enforce `book_uploads.type = 'literature'`; loader/routes own that invariant).
- **Upload body-cap deploy smoke test — RESOLVED (2026-07-09, `feat/docs-migration-hygiene`)** —
  the km-lb 1 MB-default `client_max_body_size` regression (silent 413 on book uploads,
  fixed at 320m) is now guarded in deploy verification: `verify_upload_body_limit`
  (Deploy/deployment-utils.sh) POSTs a ~2 MiB body to `/uploads` on the test port after
  the inactive color health-checks (Deploy/azure-deploy-inactive.sh Step 7) and fails
  the deploy on a 413 (expected result 401 = traversed nginx to the app's auth layer;
  verified live against prod :1840 → 401).
## U3c (fast-follow — already planned in db/docs/U3_READER_DESIGN.md)
- **Tap-handler de-dup — RESOLVED (2026-07-09, `feat/u3c-dedup-deeplink`)** — `Ttmik.tsx`'s
  `DetailView` migrated onto `client/src/hooks/useTapWord.ts` (its inline copy of the
  machine — the copy the hook was originally extracted from — is deleted; add-to-bank
  stays page-local via an `addCtrlRef`, the same composition `Reading.tsx` uses).
  `Images.tsx` was NOT migrated, deliberately: it never carried a copy of this machine —
  its word popover opens synchronously from OCR wire data (`wordToPopover`), with no
  lemmatize→define→enrich resolve and no loading/abort state, so routing it through
  `useTapWord` would ADD network calls rather than remove duplication. Its tap flow
  remains its own (documented in the hook's header scope note).
- **"View original scan" deep-link — RESOLVED (2026-07-09, `feat/u3c-dedup-deeplink`)** —
  `UploadViewer` accepts an optional `?page=N` query (validated; clamped to
  `[1, page_count]` once meta arrives; absent/invalid → page 1, so existing bare
  `/uploads/:id` callers are unchanged) and the reader's scan link threads
  `chapter.start_page` through it (`start_page` IS `book_pages.page_number` — no offset);
  null `start_page` falls back to the bare route.

## Redesign (Modern Seoul restyle) — PR1 /fixpass residuals + later slices
Paper trail: `db/docs/reviews/redesign-pr1/`. PR1 shipped PASS (all AA-contrast BLOCKERs fixed).
- **Accent cross-device sync — RESOLVED (2026-07-09, `feat/settings-accent-sync`)** — the
  server `PrefsSchema.accent` now accepts `coral|blue|mint` (default `coral`) with a
  `.catch('coral')` so a stored/PUT legacy id (`vermilion|indigo|plum|ochre`) coerces
  instead of 400ing or wiping the blob. The Settings screen adopts the server accent on
  `/settings/prefs` hydration (localStorage fast-path + no-flash bootstrap keep the
  same-device instant paint) and carries user picks in the debounced prefs PUT
  (`palette.accent`). Accent remains a `data-accent` attribute only — no inline CSS-var
  projection.
- **Mint focus-ring contrast (new, P3)** — under the non-default Mint accent in light
  theme, the focus-ring outline measures ~2.86:1 against the raw page background (below the
  WCAG 1.4.11 3:1 non-text floor); it passes (3.39:1) on the more common card/nav surfaces.
  Pre-existing shape (unchanged by the fix-pass). Deepen the Mint focus-ring hue in light.
- **PR2 — misc surfaces + ink-motif retint (§8 of the brief)** — toast/sheet/popover/input
  radii already done in PR1; the rustic ink motifs (`.hr-gold`, `.km-seal`, SealStamp,
  GoldRule, CornerMark, TianGrid) now geometrically clash with the rounded system and
  non-default paper/correct/wrong palette presets still project legacy hanji-era surface
  vars over the new design — retint or retire per screen.
- **PR3 — LearnMenu honeycomb launcher (§7 Phase 2 of the brief)** — upgrade the vertical
  `LearnMenu` row list to the color-coded hex-tile honeycomb per the mockup.

### Redesign v2 (mockup-exact colors + flatten) — verify residuals (2026-07-09, P3)
Paper trail: `db/docs/reviews/redesign-v2/`. Shipped PASS.
- **`--paper-mute` on white ≈2.56:1 (pre-existing)** — the muted meta/eyebrow text hue fails
  AA as small text on white; it's decorative secondary text and predates the redesign, but
  deepen it (or bump weight/size) for a clean AA sweep.
- **Settings pre-hydration PUT can clobber the legacy `palette` blob — RESOLVED
  (2026-07-09, `feat/settings-accent-sync`)** — the debounced prefs PUT is now gated on the
  `prefsHydratedRef` latch: no PUT fires until the initial `GET /settings/prefs` settles
  (real, non-mock), so the seeded `LEGACY_PALETTE_DEFAULT`/default baselines can never
  overwrite the stored blob. Pre-hydration edits stay durable in localStorage; server wins
  on load (unchanged semantic); post-hydration edits sync promptly. Mattered doubly once
  `palette.accent` became a live consumed field (accent cross-device sync, same branch).

### Redesign PR2 residual (2026-07-09, P3)
- **Remaining sumi-ink shadows/radii — RESOLVED (2026-07-09, `feat/redesign-polish-final`)** —
  the leftover `rgba(27,24,19,…)` box-shadows and their stray 4px/6px radii were converted to
  the theme-aware `--shadow*`/`--radius*` tokens (toast, install banner, chat FAB, popover,
  flashcard face, sheet panel, toggle thumb, segmented-tab actives, `.km-hanja__feature`,
  PWA-update banner; the two sumi scrim backgrounds re-hued to the modern near-black).
  Intentionally kept: the LearnMenu hexwrap `drop-shadow()` filters (box-shadow tokens can't
  feed `filter`, and the clip-path silhouette requires drop-shadow; they already have a dark
  override) and the translucent scrollbar-thumb background (a neutral color, not elevation).
