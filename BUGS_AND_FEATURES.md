# Bugs & Features — Korean Master

Running list of things found while using the app, triaged with suspected root
cause + a **category label** so work can be batched into focused coding sessions.

- **Status:** 🔴 open · 🟡 in progress · 🟢 done · ⚪ won't do / deferred
- **Priority:** P0 blocker · P1 high · P2 medium · P3 low
- **Category** (subsystem the fix mostly lives in): `DATABASE` (schema/migration/
  query) · `BACKEND` (Express route/service) · `UI` (React render/route/state) ·
  `DATA` (missing/malformed content, not code) · `API` (Claude/external + keys) ·
  `CONFIG` (env/deploy). Many items are cross-cutting — the **primary** tag is
  where the bulk of the fix lives; secondary tags in parentheses.

> Triage done via read-only code scan on 2026-07-02. Path:line refs are pointers
> for the coding session, not guaranteed exact after future edits.

---

## 🗂️ Suggested session plan (batch by primary category)

Launch one focused session per group; cross-cutting items noted.

- **🔧 BACKEND session (8):** B-002, B-006, B-008, B-009, F-003, F-005, F-006, F-011
  — mostly Express route/query changes. B-002/B-008/B-009 also need a small UI
  mapping change in the same feature (do them end-to-end). F-011 is a
  psychometrics/design item — read its notes before touching the scoring math.
- **🖥️ UI session (9):** B-004, B-005, B-007, B-010, F-001, F-004, F-008, F-009, F-010
  — React render/routing/state. F-001 & F-004 wire up backends that already exist;
  F-010's history data already persists (one snapshot row per attempt).
- **📦 DATA session (3):** B-001, B-003, B-011 — little/no code; change content
  source or load data. B-003 largely resolves once B-001 is fixed.
- **🗃️ DATABASE session (2):** F-002, F-007 — new tables / enum values / migrations
  (each then needs backend + UI follow-through).

---

## 📊 Summary table

| ID | Type | Status | Pri | Category | Summary |
|----|------|--------|-----|----------|---------|
| B-001 | Bug | 🔴 | P1 | DATA (DATABASE) | Read "passages" are vocab word-lists, not prose/conversation |
| B-002 | Bug | 🔴 | P1 | BACKEND (UI, DATA) | Word lookup: "Definition unavailable"; examples never returned |
| B-003 | Bug | 🔴 | P2 | DATA (UI) | Read formatting = one-word-per-line, not a paragraph |
| B-004 | Bug | 🔴 | P2 | UI | Read audio never plays — `AudioBlock` is a fake player by design |
| B-005 | Bug | 🔴 | P2 | UI | Today: Listening tile points at `/reading`; no Listening screen exists |
| B-006 | Bug | 🔴 | P1 | BACKEND (API) | Diagnostic freezes: each answer blocks on a live Claude next-item gen |
| B-007 | Bug | 🔴 | P2 | UI (DATA) | Diagnostic retake shows stale result (client cache + hardcoded copy) |
| B-008 | Bug | 🔴 | P1 | BACKEND (UI, DATABASE) | TOPIK passage exists in DB but DTO drops it + UI has no passage element |
| B-009 | Bug | 🔴 | P1 | BACKEND (UI, DATABASE) | Review card: due query never joins vocab; UI hardcodes empty en/ex/source |
| B-010 | Bug | 🔴 | P1 | UI (BACKEND) | Chat empty "TUTOR" box — SSE event discriminator mismatch, NOT the API key |
| B-011 | Bug | 🔴 | P2 | DATA | Dictionary empty — KRDICT data never loaded (no code fix) |
| F-001 | Feature | 🔴 | P2 | UI (BACKEND) | Writing tile → Grammar; `/grade-writing` backend exists but is orphaned |
| F-002 | Feature | 🔴 | P3 | DATABASE (DATA, BACKEND) | Add TOPIK L1 & L2 to diagnostic (enum + band math + tagged content) |
| F-003 | Feature | 🔴 | P3 | BACKEND (UI) | Vocab genre+difficulty filters — columns exist, just not wired |
| F-004 | Feature | 🔴 | P2 | UI | Grammar detail view — endpoint + `getPattern` exist; Reference rows not clickable |
| F-005 | Feature | 🔴 | P3 | BACKEND (UI) | Grammar difficulty+genre filters — columns exist, just not wired |
| F-006 | Feature | 🔴 | P3 | BACKEND (CONFIG) | Email notifications — no mail infra anywhere; net-new build |
| F-007 | Feature | 🔴 | P2 | DATABASE (BACKEND, UI) | Resume in-progress TOPIK test — no attempt persistence today |
| F-008 | Feature | 🔴 | P2 | UI (BACKEND) | TOPIK results/grade screen — already built in Mock; needs Study-mode parity |
| F-009 | Feature | 🔴 | P2 | UI (DATA) | Wrong-answer explanations — wired in Mock; gate to incorrect-only + data coverage |
| F-010 | Feature | 🔴 | P2 | UI (BACKEND) | Progress/diagnostic history page with graph comparison across attempts |
| F-011 | Feature | 🟡 | P2 | BACKEND (DATA, DATABASE) | Diagnostic hardening — cheap heuristic pass **spec'd** → `BRIEF_F011_diagnostic_hardening.md` |

---

## 🐞 Bugs

### B-001 · Read passages are vocab word-lists, not prose
- **Status:** 🔴 open · **Priority:** P1 · **Category:** DATA (DATABASE)
- **Where:** Read tab. Example — Level 9 Lesson 13: 신제품·신기록·신학기·신인… (17 rows).
- **Root cause:** Read tab is hard-pinned to the `ttmik` corpus, and many TTMIK
  lessons are hanja word-family lessons whose sentence rows are single words. The
  screen faithfully renders those rows → a "passage" is a word list. Real-prose
  podcast transcripts exist in `iyagi_sentences` but are only reachable via the
  picker, never the default.
- **Key files:** `server/src/routes/reading.ts:107-127`; `client/src/pages/Reading.tsx:140,182-196`; `tools/ingest/output/ttmik_7_9.json`; `db/migrations/005_lesson_podcast_topik.up.sql:114-260`
- **Fix hint:** Default the Read tab to prose/dialog corpora (iyagi transcripts, or filter `ttmik_sentences` to multi-word/dialog rows) instead of vocab word-group lessons.

### B-002 · Word lookup: "Definition unavailable"; no examples
- **Status:** 🔴 open · **Priority:** P1 · **Category:** BACKEND (UI, DATA)
- **Where:** Read tab → click a word → popover.
- **Root cause:** Two stacked defects. (1) `GET /define` selects only the
  denormalized definition columns and never queries `krdict_examples`, so examples
  are structurally absent. (2) Client `summariseEnrichment` reads fields
  (`summary/gloss/en`) that the real `EnrichmentResult` schema doesn't have (it
  returns `nuance/usageNote/examples/…`), so it falls through to the literal
  `'Definition unavailable'`. `popoverFromDefine` also hardcodes `ex_kr:''/ex_en:''`.
  The trailing "bad" is the looked-up word/error echoed verbatim into the lede.
- **Key files:** `server/src/routes/define.ts:30-36,133-140`; `client/src/pages/Reading.tsx:286-324,500-510`; `server/src/services/claude/models.ts:74-96`; `client/src/components/WordPopover.tsx:219-221,268-278`
- **Fix hint:** `/define` should join+return `krdict_examples` + `definition_english`; fix `summariseEnrichment`/`popoverFromDefine` to read the real enrichment fields and populate `ex_kr/ex_en/extra`; hide "More examples" when empty.

### B-003 · Read formatting is one word per line, not a paragraph
- **Status:** 🔴 open · **Priority:** P2 · **Category:** DATA (UI)
- **Where:** Read tab.
- **Root cause:** Downstream of B-001. `adaptWirePassage` maps each DB row 1:1 to
  a sentence and `KoreanPassage` renders each as its own `<p>`. When each row is a
  single word, output is a stack of one-word paragraphs. The render component is
  structurally fine — there's just no prose to lay out.
- **Key files:** `client/src/components/KoreanPassage.tsx:81-96,205-221`; `client/src/pages/Reading.tsx:182-196`
- **Fix hint:** Fix the content source (B-001); optionally group dialog turns into paragraphs so a passage is more than one row.

### B-004 · Read audio never plays
- **Status:** 🔴 open · **Priority:** P2 · **Category:** UI
- **Where:** Read tab audio control.
- **Root cause:** `AudioBlock` is a deliberately fake player — no `<audio>`
  element, no audio URL. The play button just animates a fake progress bar via
  `setInterval` (header comment: "There's no real audio yet"). Reading passes only
  a synthesized transcript, never an audio source.
- **Key files:** `client/src/components/AudioBlock.tsx:12-21,57-83`; `client/src/pages/Reading.tsx:161-165,769-771`
- **Fix hint:** Wire a real `<audio>` source (TTS or corpus audio URL) and thread an audio field through the reading data model. This is a feature build, not a one-liner.

### B-005 · Today: Listening and Reading open the same screen
- **Status:** 🔴 open · **Priority:** P2 · **Category:** UI
- **Where:** Today page tiles.
- **Root cause:** Both the Reading and Listening tiles hardcode `nav: '/reading'`.
  There is no Listening screen or route at all (App.tsx has no listening route;
  `nav.ts` has no listening id). Listening exists only as a diagnostic/skill label.
- **Key files:** `client/src/pages/Today.tsx:167-169`; `client/src/App.tsx:80-89`; `client/src/lib/nav.ts:26-36`
- **Fix hint:** Build a real Listening screen + `/listening` route (needs an audio/listening feature first), or repoint the tile. Related to B-004.

### B-006 · Diagnostic freezes after selecting an answer
- **Status:** 🔴 open · **Priority:** P1 · **Category:** BACKEND (API)
- **Where:** Diagnostic test.
- **Root cause:** `POST /diagnostic/:runId/answer` grades the answer, then in the
  SAME request synchronously generates the NEXT item via a blocking Claude call
  (`serveNextItem` → `buildGeneratedItem` → `proxy.generateDiagnosticItem`) before
  responding. So the reveal is withheld behind multi-second Claude latency; the
  route also sits behind `expensiveLimiter()` which can 429/stall.
- **Key files:** `server/src/routes/diagnostic.ts:739,848-890,598-614,404-475`; `client/src/pages/Diagnostic.tsx:414-454`
- **Fix hint:** Return the graded reveal immediately; generate/fetch the next item separately (or pre-generate during the reveal dwell) so grading never blocks on Claude.

### B-007 · Diagnostic retake shows stale result
- **Status:** 🔴 open · **Priority:** P2 · **Category:** UI (DATA)
- **Where:** Diagnostic → results.
- **Root cause:** Server is correct (each `/finish` INSERTs a new snapshot; `/latest`
  returns newest). Staleness is client-side: the latest-snapshot fetch runs once on
  mount and isn't refetched after a retake, and `ResultsBlock` hardcodes "completed
  5 min ago" / "Against TOPIK II Level 4", so a new score can look unchanged. Mock
  fallback is a constant, so retakes never change there.
- **Key files:** `client/src/pages/Diagnostic.tsx:110-151,240-244,890,895-896`; `client/src/hooks/useEndpointOrMock.ts:243`; `server/src/routes/diagnostic.ts:1010-1035,1077-1097` (correct)
- **Fix hint:** `refetch()` the snapshot on finish and drive the results header from the snapshot data, not literals.

### B-008 · TOPIK question unanswerable — passage not rendered
- **Status:** 🔴 open · **Priority:** P1 · **Category:** BACKEND (UI, DATABASE)
- **Where:** TOPIK tab. Example: fill blank ㉠ with no passage shown.
- **Root cause:** Passage IS in the DB but never reaches the screen. (1) `mapRowToDTO`
  collapses to `prompt ?? stem`, masking passage text stored in `stem`; and never
  selects/joins `topik_tests.passages` (JSONB of shared reading passages). (2) The
  UI has no passage element — `TopikBody`/`ExamRunner` render only prompt + options.
  A `KoreanPassage` component already exists (Diagnostic uses it) and is just not wired.
- **Key files:** `server/src/routes/topik.ts:167-169,198,276-280`; `db/migrations/005_lesson_podcast_topik.up.sql:326`; `client/src/pages/Topik.tsx:393`; `client/src/pages/topik/MockMode.tsx:558`; `client/src/types/domain.ts:180-190`
- **Fix hint:** Join+select `topik_tests.passages`, stop masking `stem` behind `prompt`, emit passage text in the DTO, and render it via `KoreanPassage` before the choices.

### B-009 · Review card: English both sides, empty source/examples
- **Status:** 🔴 open · **Priority:** P1 · **Category:** BACKEND (UI, DATABASE)
- **Where:** Review tab.
- **Root cause:** The due-cards query selects only scheduling + a grammar LEFT JOIN;
  it never joins `vocab_entries`, so a vocab card returns just a single `face` string
  (no korean/english/examples). The client `dueCardToVocab` then maps `kr = face` and
  hardcodes `en:''/ex_kr:''/ex_en:''/source undefined`. If `face` holds English, both
  sides show English with empty source/examples — exactly the report.
- **Key files:** `server/src/routes/vocab.ts:163-179,405-407`; `client/src/types/domain.ts:846`; `client/src/pages/Review.tsx:194-219,933-956`
- **Fix hint:** Add `LEFT JOIN vocab_entries` to the due query, surface korean/english/example fields on `DueCard`, and populate them in `dueCardToVocab`.

### B-010 · Chat returns empty "TUTOR" box (NOT the API key)
- **Status:** 🔴 open · **Priority:** P1 · **Category:** UI (BACKEND)
- **Where:** Chat tab.
- **Root cause:** SSE wire-protocol mismatch. The server emits data-only JSON frames
  with the discriminator *inside* the payload (`data:{"event":"delta","text":…}`),
  omitting SSE `event:` lines. But the client reads `ev.event` from the SSE-level
  `event:` field (always `'message'`) and checks `ev.event === 'delta'` — never true —
  so `onDelta` is never called and the tutor bubble stays empty. In-band `error`
  frames are ignored too, so no error shows. The API key passes the boot check, so
  this is **not** a key problem.
- **Key files:** `client/src/services/conversation.ts:145-158`; `client/src/services/sseStream.ts:79-98`; `server/src/routes/conversation.ts:490-508,618-621`; `client/src/pages/Chat.tsx:318-362`
- **Fix hint:** In the client `onEvent`, `JSON.parse(ev.data)` and switch on the inner `.event` (delta/error/done) — or make the server emit real `event: <name>` SSE lines.

### B-011 · Dictionary is empty
- **Status:** 🔴 open · **Priority:** P2 · **Category:** DATA
- **Where:** Reference → Dictionary.
- **Root cause:** Schema + route work, but no KRDICT rows were ever loaded on this
  box. The route 503s only when tables are *missing*; empty-but-present tables just
  return `entries:[], total:0` → empty UI. `load_krdict.py` is ready but the bulk LMF
  XML was never acquired/run here (see FOLLOW_UPS.md).
- **Key files:** `db/migrations/003_krdict.up.sql:60`; `server/src/routes/krdict.ts:83,112`; `Deploy/load-krdict.sh`; `tools/ingest/load_krdict.py`
- **Fix hint:** Acquire the KRDICT bulk XML and run `Deploy/load-krdict.sh <dir>`. No code change.

---

## ✨ Features / Improvements

### F-001 · Make "Writing" a real writing feature (backend already exists)
- **Status:** 🔴 open · **Priority:** P2 · **Category:** UI (BACKEND)
- **Where:** Today → Writing tile.
- **Root cause / state:** The tile hardcodes `nav: '/grammar'`. A real writing grader
  DOES exist server-side — `POST /grade-writing` (TOPIK rubric grader via Claude) —
  but it's orphaned: no client service/page calls it, and there's no `/writing` route.
- **Key files:** `client/src/pages/Today.tsx:169`; `server/src/routes/gradeWriting.ts:1-60` (unused); `client/src/App.tsx:80-89`
- **Fix hint:** Build a Writing screen that prompts the user and POSTs to `/grade-writing`; point the tile at it. (Or, if you only want the quick fix, rename the tile to "Grammar.")

### F-002 · Add TOPIK Level 1 & 2 to the diagnostic
- **Status:** 🔴 open · **Priority:** P3 · **Category:** DATABASE (DATA, BACKEND)
- **Where:** Diagnostic.
- **State:** Moderate-to-hard. Levels are coupled across the DB enum
  `proficiency_level = (basic,L3,L4,L5+)` (no L1/L2), the CAT band math (anchors,
  `THETA_MIN=2.0` floor), types, and the route's REFERENCES. Biggest cost: corpus
  content actually tagged at L1/L2 (today only basic/L3/L4/L5+) — without it the
  item pools are empty.
- **Key files:** `db/migrations/001_core_schema.up.sql:82`; `server/src/services/diagnostic/cat.ts:20-83`; `server/src/routes/diagnostic.ts:642-648,344-397`
- **Fix hint:** New migration to add enum values + L1/L2 band anchors, lower `THETA_MIN`, extend types/REFERENCES — and tag L1/L2 content (the real work).

### F-003 · Vocabulary: genre + difficulty filters
- **Status:** 🔴 open · **Priority:** P3 · **Category:** BACKEND (UI)
- **State:** Columns already exist — difficulty ≈ `proficiency`/`book_level`, genre ≈
  `domain` (general/research/business), with a supporting index. Route currently
  accepts `corpus`+`proficiency` only; `domain`/`book_level` not wired.
- **Key files:** `db/migrations/002_darakwon_corpora.up.sql:534`; `server/src/routes/vocab.ts:44`; `client/src/pages/Reference.tsx` (VocabTab)
- **Fix hint:** Add `domain`(+`book_level`) to `VocabSearchQuerySchema` + WHERE, then add filter controls in the VocabTab.

### F-004 · Grammar: clickable detail view (backend already exists)
- **Status:** 🔴 open · **Priority:** P2 · **Category:** UI
- **State:** The Reference Grammar tab renders each pattern as non-interactive spans —
  no onClick/Sheet. But `GET /grammar/kgiu/:id` already returns explanation/formation/
  examples/dialogues/tips/… and `grammarService.getPattern(id)` already exists. The
  standalone `Grammar.tsx` page even wires a tap-row→detail Sheet; the Reference tab
  just never got it.
- **Key files:** `client/src/pages/Reference.tsx:783`; `server/src/routes/grammar.ts:82`; `client/src/services/grammar.ts:50`; `client/src/pages/Grammar.tsx` (reference impl)
- **Fix hint:** Make the row a button that calls `getPattern(p.id)` and renders it in a `Sheet` (reuse the Grammar.tsx pattern).

### F-005 · Grammar: difficulty + genre/source filters
- **Status:** 🔴 open · **Priority:** P3 · **Category:** BACKEND (UI)
- **State:** `kgiu_entries` already carries `proficiency`, `book_level`, `domain`,
  `source_book`, `corpus`. Route filters on `corpus`+`proficiency` only.
- **Key files:** `db/migrations/002_darakwon_corpora.up.sql:230`; `server/src/routes/grammar.ts:30,57`; `client/src/pages/Reference.tsx:715` (GrammarTab)
- **Fix hint:** Extend `KgiuSearchQuerySchema`/WHERE with `domain`+`book_level` (source textbook maps to `corpus`/`source_book`), then add filter UI. Pairs with F-003.

### F-006 · Email notifications from a domain email
- **Status:** 🔴 open · **Priority:** P3 · **Category:** BACKEND (CONFIG)
- **State:** Net-new. Email is collected and notification *intents* exist
  (`notif.channel.email`, reviewsDue/daily/weekly), but there is NO mail-sending
  infra anywhere (no nodemailer/sendgrid/SES/SMTP in source) and no reminder scheduler.
- **Key files:** `client/src/pages/Settings.tsx:588`; `server/src/routes/settings.ts:62,83` (persists intent only); no mail module present
- **Fix hint:** Add a mail provider client + env config (domain sender, SPF/DKIM) and a scheduled worker that fans out reminders/word lists from the stored intents. Ties into the deploy email-verification checklist.

### F-007 · Resume an in-progress TOPIK test
- **Status:** 🔴 open · **Priority:** P2 · **Category:** DATABASE (BACKEND, UI)
- **State:** No attempt persistence today. `topik_responses` is an append-only log of
  *completed* answers only. In-progress state (picks map, index, timer) lives in
  in-memory React state and is lost on reload.
- **Key files:** `db/migrations/015_topik_responses.up.sql:56-90`; `client/src/pages/topik/MockMode.tsx:368-374`; `server/src/routes/topik.ts:430-459`
- **Fix hint:** Add a `topik_attempts` table (user_id, section, sourceTest, current_idx, picks JSONB, remaining_ms, status) + save/resume endpoints; hydrate `ExamRunner` from it.

### F-008 · TOPIK results / grade screen
- **Status:** 🔴 open · **Priority:** P2 · **Category:** UI (BACKEND)
- **State:** Mostly done. A full results screen already exists for **Mock mode**
  (`MockResults`: %, band, correct/total, per-item review) fed by `/topik/mock/submit`.
  The gap is **Study mode**, which only shows a "Set complete" count.
- **Key files:** `client/src/pages/topik/MockMode.tsx:831-949`; `server/src/routes/topik.ts:499-607`; `client/src/pages/Topik.tsx:288-305`
- **Fix hint:** Reuse `MockResults`; for Study mode, tally client-side reveals into an equivalent summary card.

### F-009 · Wrong-answer explanations
- **Status:** 🔴 open · **Priority:** P2 · **Category:** UI (DATA)
- **State:** Explanations already flow end-to-end in Mock review, but for ALL items
  (ticket wants incorrect-only). Real risk is DATA coverage: explanation comes from
  `topik_items.extra->>'explanation'` and defaults to `''` when absent — many rows
  likely have none. (Generation would follow the existing Claude-proxy pattern.)
- **Key files:** `client/src/pages/topik/MockMode.tsx:920-931`; `server/src/routes/topik.ts:190-191,567-573`; `server/src/services/claude/config.ts:118-126` (for generation)
- **Fix hint:** Gate the explanation block on `!isCorrect`; audit/generate `topik_items.extra.explanation` coverage.

### F-010 · Progress / diagnostic history page with graph comparison
- **Status:** 🔴 open · **Priority:** P2 · **Category:** UI (BACKEND)
- **Where:** New tab/page (progress/history).
- **What:** A page showing the user's diagnostic results over time — per-dimension
  (reading/listening/vocab/grammar) trend lines and an attempt-vs-attempt
  comparison so improvement is visible after studying + retaking.
- **State:** The data already exists — each `/finish` INSERTs a `diagnostic_snapshots`
  row per attempt (dimensions + `captured_at` + overall), never upserted. So this is
  mostly UI: add a `GET /diagnostic/history` (list snapshots for the user) and a
  charting page. No new capture logic needed.
- **Key files:** `server/src/routes/diagnostic.ts:1010-1035` (snapshot insert), `:1077-1097` (`/latest` — model a `/history` on it); `client/src/pages/Diagnostic.tsx` (ResultsBlock — reuse the dimension bars); new page + route in `client/src/App.tsx`.
- **Fix hint:** Add a history endpoint returning all snapshots ordered by `captured_at`, and a page charting per-dimension trends. Pairs with B-007 (stale-result fix) so a fresh attempt actually appears.

### F-011 · Diagnostic is a heuristic, not a valid psychometric test
- **Status:** 🔴 open · **Priority:** P2 · **Category:** BACKEND (DATA, DATABASE)
- **Where:** Diagnostic engine.
- **What it actually is today (from reading the code):**
  - **8 items total, 2 per dimension** (fixed interleaved schedule) — reading/listening
    pulled from the real `topik_items` pool; vocab/grammar authored on the fly by Claude.
  - Ability model is a **"CAT-lite" staircase (Elo-ish), not IRT/real CAT**: θ seeds at
    `SEED_THETA=4.0` (L4 mid), moves ±a decaying step (1.0→0.4) per answer, clamped
    `[2.0, 6.0]`. No item-information selection, no standard error, no stopping rule.
  - **Item "difficulty" is the proficiency *label*, not a calibrated IRT b-parameter**
    (basic=2/L3=3/L4=4/L5+=5.5). For Claude-generated items this is circular — the item
    is authored *to* a target band, then scored *as* that difficulty.
  - Per-dimension score rests on **just 2 questions** + a ±delta, then a piecewise-linear
    map to 0–100 (6→85, never 100). 4-option MCQ = 25% guess rate, **no guessing correction**.
- **Reliability verdict:** fine as a lightweight *placement/vibe-check*, but **not
  psychometrically reliable** — 2 items/dimension means one lucky/unlucky guess swings a
  skill by a full level. The "baseline" is the internal 0–6 TOPIK-aligned scale seeded at
  L4; it is **not** normed/validated against real TOPIK score distributions.
  Seed-at-L4 + `THETA_MIN=2.0` also biases toward the middle and **can't resolve true
  beginners** (ties into F-002 — no L1/L2).
- **Improvement options (pick per appetite):** more items per dimension + a standard-error
  stopping rule; a **calibrated item bank** with real difficulty/discrimination params
  instead of proficiency tags; proper 2PL/3PL IRT θ-update; guessing correction; and an
  honest UI label ("quick placement estimate," with a confidence band) until validated.
- **Key files:** `server/src/services/diagnostic/cat.ts:20-26,68-99` (seed/step/bands), `server/src/services/diagnostic/scoring.ts:40-70,98-128` (2-item estimate + score curve), `server/src/routes/diagnostic.ts:60-73` (8-item schedule), `:404-475` (Claude-generated items), `:642-648` (REFERENCES/anchors)
- **Fix hint:** Decide the goal first — a *validated* test is a large psychometrics effort (calibrated bank + IRT); a *better heuristic* is cheaper (more items, guessing correction, honest labeling + confidence interval). Don't over-index on the current θ number.
- **DECIDED (2026-07-02):** Do the **cheap heuristic** pass now — scope = **more items
  per dimension (2→4)** + **confidence band + honest label**. Guessing correction and
  adaptive stopping deferred; validated/IRT version is the long-term goal.
  Full coding spec: **`BRIEF_F011_diagnostic_hardening.md`** (ready to hand to Fable).
  Depends on B-006 (do first/together — doubling generated items worsens the freeze)
  and overlaps B-007 (same results-copy lines).

---

<!-- Templates — copy when adding items.

### B-00X · <title>
- **Status:** 🔴 open · **Priority:** P2 · **Category:** <label>
- **Where:**
- **Root cause:**
- **Key files:**
- **Fix hint:**

### F-00X · <title>
- **Status:** 🔴 open · **Priority:** P2 · **Category:** <label>
- **Where / State:**
- **Key files:**
- **Fix hint:**
-->
