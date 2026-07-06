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

## Status snapshot (2026-07-05)

**Bugs: 16 of 17 resolved.** B-001–B-011, B-013–B-016 are all 🟢 done (mix of the
#19 Track-A wiring, the Read→Listen consolidation, the KRDICT dictionary load, and
the 2026-07-05 bug pass — see `db/docs/BUG_RETRIAGE_2026-07-05.md` and the
`REVIEW_*.md` trail). Only **B-012** remains (🟡 — the loaded count is fine at
100%; only an OCR-completeness spot-check is left).

**Features: 9 done, ~12 open.** 🟢 done: F-001, F-003, F-004, F-005, F-008, F-009,
F-010, F-012, F-013. 🟡 in progress: F-019 (wrong-answer explanations, ~1920/2088).
🔴 open: F-002, F-006, F-007, F-011, F-014, F-015, F-016, F-017, F-018, F-020,
F-021.

**Not in this doc — surfaced by the CI test gate + reviews (see `FOLLOW_UPS.md`):**
F-UP-002 (strategy_c min-3 fragment filter drops legit 2-syllable patterns),
F-UP-003 (3 ingest tests need generated output), F-UP-004/005 (rate-limit
`retry_after` precision + coverage).

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
| B-012 | Bug | 🔴 | P3 | DATA | Verify vocab-2000 completeness — 3,188 words loaded vs nominal ~4,000 (spot-check covered pages) |
| B-013 | Bug | 🔴 | P2 | UI (BACKEND) | "Add to review" is inert — no UI to seed vocab review cards; `POST /cards/init` exists but unwired |
| B-014 | Bug | 🔴 | P2 | UI | Review: rating a card flashes the NEXT card's English before it advances (flip not reset) |
| B-015 | Bug | 🔴 | P2 | UI | Reference "This Week": vocab+grammar need to be tabs; grammar overflows off-screen horizontally |
| B-016 | Bug | 🔴 | P3 | BACKEND (UI) | `expensiveLimiter` 429 never sends `retry_after` → Writing's "retry in N s" copy is dead code |
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
| F-012 | Feature | 🔴 | P2 | BACKEND (DATABASE, DATA, UI) | TTMIK tab — play Iyagi podcasts + TTMIK lessons with real audio + read-along script |
| F-013 | Feature | 🔴 | P2 | UI (BACKEND) | Word mastery view — surface per-word FSRS mastery (progress tab or word detail) |
| F-014 | Feature | 🔴 | P2 | UI (BACKEND) | Today "Writing" tab rework — audit + identify changes (relates to F-001) |
| F-015 | Feature | 🔴 | P2 | DATA (BACKEND, UI) | Hanja — finish + populate (route/tests exist; data missing, UI incomplete) |
| F-016 | Feature | 🔴 | P2 | UI (BACKEND) | Rework "More" tab → rename Ask/Chat/AI → Chat, with an in-chat dictionary function |
| F-017 | Feature | 🔴 | P2 | UI (BACKEND) | Today: swipeable multi-skill stats carousel (per-skill mastery/reviewed graphs, finger-slide) |
| F-018 | Feature | 🔴 | P3 | BACKEND (UI) | Rich grammar detail — render examples/dialogues/formation_rules in the detail Sheet (now explanation+unit only) |
| F-019 | Feature | 🟡 | P2 | DATA | Generate wrong-answer explanations — 0/2,088 topik_items have one; pilot done (in-session, no API) |
| F-020 | Feature | 🔴 | P2 | UI (BACKEND) | "Ask about this" — push a question + its explanation into Chat for AI follow-up Q&A |
| F-021 | Feature | 🔴 | P2 | DATABASE (BACKEND, UI) | Wrong-answer review log — revisit past missed questions + explanations across sessions (30-day window) |

---

## 🐞 Bugs

### B-001 · Read passages are vocab word-lists, not prose
- **Status:** 🟢 done (2026-07-06) · **Priority:** P1 · **Category:** DATA (DATABASE)
- **Where:** Read tab. Example — Level 9 Lesson 13: 신제품·신기록·신학기·신인… (17 rows).
- **Root cause:** Read tab is hard-pinned to the `ttmik` corpus, and many TTMIK
  lessons are hanja word-family lessons whose sentence rows are single words. The
  screen faithfully renders those rows → a "passage" is a word list. Real-prose
  podcast transcripts exist in `iyagi_sentences` but are only reachable via the
  picker, never the default.
- **Resolution (2026-07-06):** the Read tab was folded into **Listen** (`/ttmik`), which defaults to Iyagi prose and does TTMIK + Iyagi with audio + clickable transcripts. `reading.ts` + `Reading.tsx` are deleted. (Largely stale: once the Iyagi default landed, the Read tab no longer showed word-lists by default.)

### B-002 · Word lookup: "Definition unavailable"; no examples
- **Status:** 🟢 done (2026-07-05) · **Priority:** P1 · **Category:** BACKEND (UI, DATA)
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
- **Status:** 🟢 done (2026-07-05) · **Priority:** P2 · **Category:** DATA (UI)
- **Where:** Read tab.
- **Root cause:** Downstream of B-001. `adaptWirePassage` maps each DB row 1:1 to
  a sentence and `KoreanPassage` renders each as its own `<p>`. When each row is a
  single word, output is a stack of one-word paragraphs. The render component is
  structurally fine — there's just no prose to lay out.
- **Key files:** `client/src/components/KoreanPassage.tsx:81-96,205-221`; `client/src/pages/Reading.tsx:182-196`
- **Fix hint:** Fix the content source (B-001); optionally group dialog turns into paragraphs so a passage is more than one row.

### B-004 · Read audio never plays
- **Status:** 🟢 done (2026-07-05) · **Priority:** P2 · **Category:** UI
- **Where:** Read tab audio control.
- **Root cause:** `AudioBlock` is a deliberately fake player — no `<audio>`
  element, no audio URL. The play button just animates a fake progress bar via
  `setInterval` (header comment: "There's no real audio yet"). Reading passes only
  a synthesized transcript, never an audio source.
- **Key files:** `client/src/components/AudioBlock.tsx:12-21,57-83`; `client/src/pages/Reading.tsx:161-165,769-771`
- **Fix hint:** Wire a real `<audio>` source (TTS or corpus audio URL) and thread an audio field through the reading data model. This is a feature build, not a one-liner.

### B-005 · Today: Listening and Reading open the same screen
- **Status:** 🟢 done (2026-07-05) · **Priority:** P2 · **Category:** UI
- **Where:** Today page tiles.
- **Root cause:** Both the Reading and Listening tiles hardcode `nav: '/reading'`.
  There is no Listening screen or route at all (App.tsx has no listening route;
  `nav.ts` has no listening id). Listening exists only as a diagnostic/skill label.
- **Key files:** `client/src/pages/Today.tsx:167-169`; `client/src/App.tsx:80-89`; `client/src/lib/nav.ts:26-36`
- **Fix hint:** Build a real Listening screen + `/listening` route (needs an audio/listening feature first), or repoint the tile. Related to B-004.

### B-006 · Diagnostic freezes after selecting an answer
- **Status:** 🟢 done (2026-07-05) · **Priority:** P1 · **Category:** BACKEND (API)
- **Where:** Diagnostic test.
- **Root cause:** `POST /diagnostic/:runId/answer` grades the answer, then in the
  SAME request synchronously generates the NEXT item via a blocking Claude call
  (`serveNextItem` → `buildGeneratedItem` → `proxy.generateDiagnosticItem`) before
  responding. So the reveal is withheld behind multi-second Claude latency; the
  route also sits behind `expensiveLimiter()` which can 429/stall.
- **Key files:** `server/src/routes/diagnostic.ts:739,848-890,598-614,404-475`; `client/src/pages/Diagnostic.tsx:414-454`
- **Fix hint:** Return the graded reveal immediately; generate/fetch the next item separately (or pre-generate during the reveal dwell) so grading never blocks on Claude.

### B-007 · Diagnostic retake shows stale result
- **Status:** 🟢 done (2026-07-05) · **Priority:** P2 · **Category:** UI (DATA)
- **Where:** Diagnostic → results.
- **Root cause:** Server is correct (each `/finish` INSERTs a new snapshot; `/latest`
  returns newest). Staleness is client-side: the latest-snapshot fetch runs once on
  mount and isn't refetched after a retake, and `ResultsBlock` hardcodes "completed
  5 min ago" / "Against TOPIK II Level 4", so a new score can look unchanged. Mock
  fallback is a constant, so retakes never change there.
- **Key files:** `client/src/pages/Diagnostic.tsx:110-151,240-244,890,895-896`; `client/src/hooks/useEndpointOrMock.ts:243`; `server/src/routes/diagnostic.ts:1010-1035,1077-1097` (correct)
- **Fix hint:** `refetch()` the snapshot on finish and drive the results header from the snapshot data, not literals.

### B-008 · TOPIK question unanswerable — passage not rendered
- **Status:** 🟢 done (2026-07-05) · **Priority:** P1 · **Category:** BACKEND (UI, DATABASE)
- **Where:** TOPIK tab. Example: fill blank ㉠ with no passage shown.
- **Root cause:** Passage IS in the DB but never reaches the screen. (1) `mapRowToDTO`
  collapses to `prompt ?? stem`, masking passage text stored in `stem`; and never
  selects/joins `topik_tests.passages` (JSONB of shared reading passages). (2) The
  UI has no passage element — `TopikBody`/`ExamRunner` render only prompt + options.
  A `KoreanPassage` component already exists (Diagnostic uses it) and is just not wired.
- **Key files:** `server/src/routes/topik.ts:167-169,198,276-280`; `db/migrations/005_lesson_podcast_topik.up.sql:326`; `client/src/pages/Topik.tsx:393`; `client/src/pages/topik/MockMode.tsx:558`; `client/src/types/domain.ts:180-190`
- **Fix hint:** Join+select `topik_tests.passages`, stop masking `stem` behind `prompt`, emit passage text in the DTO, and render it via `KoreanPassage` before the choices.

### B-009 · Review card: English both sides, empty source/examples
- **Status:** 🟢 done (2026-07-05) · **Priority:** P1 · **Category:** BACKEND (UI, DATABASE)
- **Where:** Review tab.
- **Root cause:** The due-cards query selects only scheduling + a grammar LEFT JOIN;
  it never joins `vocab_entries`, so a vocab card returns just a single `face` string
  (no korean/english/examples). The client `dueCardToVocab` then maps `kr = face` and
  hardcodes `en:''/ex_kr:''/ex_en:''/source undefined`. If `face` holds English, both
  sides show English with empty source/examples — exactly the report.
- **Key files:** `server/src/routes/vocab.ts:163-179,405-407`; `client/src/types/domain.ts:846`; `client/src/pages/Review.tsx:194-219,933-956`
- **Fix hint:** Add `LEFT JOIN vocab_entries` to the due query, surface korean/english/example fields on `DueCard`, and populate them in `dueCardToVocab`.

### B-010 · Chat returns empty "TUTOR" box (NOT the API key)
- **Status:** 🟢 done (2026-07-05) · **Priority:** P1 · **Category:** UI (BACKEND)
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
- **Status:** 🟢 done (2026-07-05) · **Priority:** P2 · **Category:** DATA
- **Where:** Reference → Dictionary.
- **Root cause:** Schema + route work, but no KRDICT rows were ever loaded on this
  box. The route 503s only when tables are *missing*; empty-but-present tables just
  return `entries:[], total:0` → empty UI. `load_krdict.py` is ready but the bulk LMF
  XML was never acquired/run here (see FOLLOW_UPS.md).
- **Key files:** `db/migrations/003_krdict.up.sql:60`; `server/src/routes/krdict.ts:83,112`; `Deploy/load-krdict.sh`; `tools/ingest/load_krdict.py`
- **Fix hint:** Acquire the KRDICT bulk XML and run `Deploy/load-krdict.sh <dir>`. No code change.

### B-012 · Verify vocab-2000 completeness (3,188 loaded vs nominal ~4,000)
- **Status:** 🟢 done (2026-07-06) · **Priority:** P3 · **Category:** DATA
- **Spot-check result (2026-07-05):** source JSON → DB load is/was **100% complete**
  (source beginner 1706 / intermediate 1696 == DB), so nothing was lost in loading —
  the gap vs nominal is entirely OCR/parse of the PDFs. The load was never actually
  incomplete; "3,188" is the `word`-type subset (3402 total rows − 214 navigational).
- **⚠️ CORRECTION (2026-07-06) — earlier deletion was a MISTAKE, to be undone:**
  The 214 rows I deleted on 2026-07-05 as "empty artifacts" are **legitimate
  navigational rows** — `theme_intro` (31), `subsection_intro` (142), `reference`
  (41) — whose content lives in the `theme`/`subsection`/`notes` fields, NOT in
  `korean`/`english` (which are NULL by design; ck_vocab_entries_korean_required
  only applies to `word` rows). Verified against the real corpus: 214/214 carry
  theme/subsection content (e.g. "01 사람 / People", "1 가족/친척 / Family/Relatives").
  I misread "NULL korean + 0 FK refs" as "artifact" — a `theme_intro` legitimately
  has both. The follow-on loader "skip empty rows" fix (rejected in fixpass —
  `db/docs/REVIEW_LOADER_FIXES.md`) has been reverted; it would have dropped these
  legitimate rows AND broken the count assertion on re-ingest.
- **TODO (live data):** the 214 deleted navigational rows should be restored to the
  running km-db (they organize vocab into themes/subsections). No functional impact
  today — every app vocab query filters `entry_type='word'`, so the navigational
  rows are display-only metadata the current UI never reads — hence low priority. A
  force re-ingest of `vocab_2000_{beginner,intermediate}.json` re-inserts them (the
  loader upserts on source_id). See the deploy notes / morning summary.
- **Where:** Vocab corpus (`vocab_entries`) — loaded 2026-07-03 from the copyright-safe OCR.
- **Root cause / state:** Both "2000 Essential Korean Words" books were OCR'd with FULL
  page coverage (beginner 505/505 PDF pages, intermediate 538/538, all themes + appendices),
  yet only 1,598 + 1,590 = **3,188 `word` entries** loaded vs the nominal 4,000. Most of the
  gap is explained: ~500 related words per book are stored as `cross_refs` (not standalone
  rows — 521 links beginner / 500 intermediate), and "2000" is a rounded title. BUT full
  page coverage does not prove every headword on a covered page became an entry — an OCR
  pass can still miss words on a page it read. **Not confirmed missing, just unverified.**
- **Key files:** `tools/ingest/output/vocab_2000_{beginner,intermediate}.json`; `tools/ingest/loaders/load_vocab_2000.py`; `db/migrations/002_darakwon_corpora.up.sql` (vocab_entries)
- **Fix hint:** Spot-check a handful of book pages — count the printed headwords on page N
  vs the `word` entries whose `source_pages` contain N. Match → extraction complete (close as
  ⚪ rounding/structural). Page has more → OCR undercounted; re-run/patch those pages. No code
  fix unless undercounting is confirmed.

### B-013 · "Add to review" is inert — no UI to seed vocab review cards
- **Status:** 🟢 done (2026-07-05) · **Priority:** P2 · **Category:** UI (BACKEND)
- **Where:** Review tab (Lists tab "Add all to my bank" / "Study this list"); adding
  dictionary words to the review queue generally.
- **Root cause / state:** `POST /vocab/cards/init` (seed recognition cards from a
  corpus slice) exists and works server-side, but the Review Lists-tab buttons have no
  `onClick` (flagged in the feature-surface audit), so a user cannot seed review cards
  from the loaded vocab. Surfaced 2026-07-03 while fixing B-009: the review queue was
  effectively empty (one un-enriched mined word) and 40 beginner cards had to be seeded
  via raw SQL to test the fix. A fresh user has no reviewable vocab despite 3,188 loaded
  words.
- **Key files:** `server/src/routes/vocab.ts` (`POST /cards/init`, ~432); `client/src/pages/Review.tsx` (Lists-tab buttons, inert); `client/src/services/vocab.ts` (needs an `initCards` call)
- **Fix hint:** Wire an "Add to review" / "Study this list" action to `POST /vocab/cards/init` (corpus + limit), then refetch the due queue. Pairs with F-003 (vocab filters) for choosing what to add.

### B-014 · Review: next card's English flashes before the card advances
- **Status:** 🟢 done (2026-07-05) · **Priority:** P2 · **Category:** UI
- **Where:** Review tab — after flipping a card and tapping a rating (Again/Hard/Good/Easy), for a frame *before* the next card appears you can see the **next** card's English (its back face). Leaks the answer for the upcoming card.
- **Root cause (suspected):** the rating handler advances the card index but the `flipped` state isn't reset to `false` synchronously with the index change, so the incoming card renders in its flipped (back = English) state for a render or two before `flipped` resets.
- **Key files:** `client/src/pages/Review.tsx` (rating handler → card advance + `flipped` state); `client/src/components/Flashcard.tsx`
- **Fix hint:** Reset `flipped=false` in the same state update that advances the card, or key the `Flashcard` on the card id so a new card always mounts unflipped — a new card must never render showing its back.

### B-015 · Reference "This Week": vocab + grammar need tabs; grammar overflows off-screen
- **Status:** 🟢 done (2026-07-05) · **Priority:** P2 · **Category:** UI
- **Where:** Resources / Reference tab → the "This Week" section that lists this week's vocabulary + grammar.
- **Root cause / state:** Weekly vocab and grammar are rendered stacked in one view and the layout doesn't fit — grammar rows overflow horizontally and get cut off the right edge of the visible area. Should be split into two tabs (Vocabulary | Grammar) with proper wrapping.
- **Key files:** `client/src/pages/Reference.tsx` (weekly-suggestions / "This Week" section; vocab + grammar suggestion lists)
- **Fix hint:** Split "This Week" vocab and grammar into tabbed sub-views (reuse Reference's existing tab pattern), and fix the grammar row layout so long pattern text wraps instead of overflowing (wrap or an `overflow-x` container).

### B-016 · `expensiveLimiter` 429 never sends `retry_after` → Writing retry copy is dead
- **Status:** 🟢 done (2026-07-05) · **Priority:** P3 · **Category:** BACKEND (UI)
- **Where:** Any route behind `expensiveLimiter()` (Writing `/grade-writing`, lemmatize, enrich, diagnostic gen, …).
- **Root cause / state:** Surfaced 2026-07-04 in the Track A /fixpass. `Writing.tsx` has a "retry in N seconds" UX path keyed on a structured `retryAfter` from the 429 body, but `expensiveLimiter`'s 429 response never sets `retry_after` — so that branch is unreachable and the client always falls back to fixed copy. Pre-existing shared-infra gap, not scoped to the Writing PR.
- **Key files:** `server/src/middleware/rateLimits.ts` (`expensiveLimiter` 429 body); `client/src/pages/Writing.tsx` (the retryAfter branch)
- **Fix hint:** Have `expensiveLimiter` include `retry_after` (seconds) in the 429 JSON, or drop the dead client branch. Benefits every expensive route, not just Writing.

---

## ✨ Features / Improvements

### F-001 · Make "Writing" a real writing feature (backend already exists)
- **Status:** 🟢 done (2026-07-05) · **Priority:** P2 · **Category:** UI (BACKEND)
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
- **Status:** 🟢 done (2026-07-05) · **Priority:** P3 · **Category:** BACKEND (UI)
- **State:** Columns already exist — difficulty ≈ `proficiency`/`book_level`, genre ≈
  `domain` (general/research/business), with a supporting index. Route currently
  accepts `corpus`+`proficiency` only; `domain`/`book_level` not wired.
- **Key files:** `db/migrations/002_darakwon_corpora.up.sql:534`; `server/src/routes/vocab.ts:44`; `client/src/pages/Reference.tsx` (VocabTab)
- **Fix hint:** Add `domain`(+`book_level`) to `VocabSearchQuerySchema` + WHERE, then add filter controls in the VocabTab.

### F-004 · Grammar: clickable detail view (backend already exists)
- **Status:** 🟢 done (2026-07-05) · **Priority:** P2 · **Category:** UI
- **State:** The Reference Grammar tab renders each pattern as non-interactive spans —
  no onClick/Sheet. But `GET /grammar/kgiu/:id` already returns explanation/formation/
  examples/dialogues/tips/… and `grammarService.getPattern(id)` already exists. The
  standalone `Grammar.tsx` page even wires a tap-row→detail Sheet; the Reference tab
  just never got it.
- **Key files:** `client/src/pages/Reference.tsx:783`; `server/src/routes/grammar.ts:82`; `client/src/services/grammar.ts:50`; `client/src/pages/Grammar.tsx` (reference impl)
- **Fix hint:** Make the row a button that calls `getPattern(p.id)` and renders it in a `Sheet` (reuse the Grammar.tsx pattern).

### F-005 · Grammar: difficulty + genre/source filters
- **Status:** 🟢 done (2026-07-05) · **Priority:** P3 · **Category:** BACKEND (UI)
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
- **Status:** 🟢 done (2026-07-06, deployed) · **Priority:** P2 · **Category:** DATABASE (BACKEND, UI)
- **Resolution (2026-07-06):** new `topik_attempts` table (migration 037) persists ONE
  in-progress mock per user (section, source_test, current_idx, picks JSONB, remaining_ms).
  No item snapshot — `/topik/mock` is deterministic per (section, sourceTest) (a true total
  order via `uq_topik_items_test_number`), so resume re-fetches the identical exam and
  restores picks/index/timer. Backend `GET/PUT/DELETE /topik/attempt` (auth, user-scoped —
  no IDOR; upsert ON CONFLICT (user_id); picks capped 60; int fields `.max(INT4_MAX)`);
  `/mock/submit` clears the attempt in the score tx. Client: `fetchMockTest` gains optional
  `sourceTest`; ExamRunner hydrates from a saved attempt + persists on each pick/nav, every
  15s, on unmount (in-flight save aborted on submit + `clearAttempt` mop-up so a raced save
  can't resurrect a finished test); MockMode shows a dismissible resume banner on the mock
  select screen. Full /fixpass: 3 reviewers (0 BLOCKER) → 5 SHOULD-FIX fixed → re-review PASS.
  Tests: server 52 (6 new) / client 12 (2 new). Residual (resurrect-race window, silent
  resume-fail) → F-UP-014/F-UP-015. PR #TBD.
- **State:** No attempt persistence today. `topik_responses` is an append-only log of
  *completed* answers only. In-progress state (picks map, index, timer) lives in
  in-memory React state and is lost on reload.
- **Key files:** `db/migrations/015_topik_responses.up.sql:56-90`; `client/src/pages/topik/MockMode.tsx:368-374`; `server/src/routes/topik.ts:430-459`
- **Fix hint:** Add a `topik_attempts` table (user_id, section, sourceTest, current_idx, picks JSONB, remaining_ms, status) + save/resume endpoints; hydrate `ExamRunner` from it.

### F-008 · TOPIK results / grade screen
- **Status:** 🟢 done (2026-07-05) · **Priority:** P2 · **Category:** UI (BACKEND)
- **State:** Mostly done. A full results screen already exists for **Mock mode**
  (`MockResults`: %, band, correct/total, per-item review) fed by `/topik/mock/submit`.
  The gap is **Study mode**, which only shows a "Set complete" count.
- **Key files:** `client/src/pages/topik/MockMode.tsx:831-949`; `server/src/routes/topik.ts:499-607`; `client/src/pages/Topik.tsx:288-305`
- **Fix hint:** Reuse `MockResults`; for Study mode, tally client-side reveals into an equivalent summary card.

### F-009 · Wrong-answer explanations
- **Status:** 🟢 done (2026-07-05) · **Priority:** P2 · **Category:** UI (DATA)
- **State:** Explanations already flow end-to-end in Mock review, but for ALL items
  (ticket wants incorrect-only). Real risk is DATA coverage: explanation comes from
  `topik_items.extra->>'explanation'` and defaults to `''` when absent — many rows
  likely have none. (Generation would follow the existing Claude-proxy pattern.)
- **Key files:** `client/src/pages/topik/MockMode.tsx:920-931`; `server/src/routes/topik.ts:190-191,567-573`; `server/src/services/claude/config.ts:118-126` (for generation)
- **Fix hint:** Gate the explanation block on `!isCorrect`; audit/generate `topik_items.extra.explanation` coverage.

### F-010 · Progress / diagnostic history page with graph comparison
- **Status:** 🟢 done (2026-07-05) · **Priority:** P2 · **Category:** UI (BACKEND)
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

### F-012 · Talk To Me In Korean (TTMIK) tab — podcasts + lessons with audio + read-along script
- **Status:** 🟢 done (2026-07-05) · **Priority:** P2 · **Category:** BACKEND (DATABASE, DATA, UI)
- **Where:** NEW tab + route (`/ttmik`).
- **What:** A dedicated TTMIK tab to consume the TTMIK content directly: (a) **Iyagi
  podcasts** — play the actual episode audio while reading the transcript/script along with
  it; (b) **TTMIK lessons** — play the lesson audio (and read the lesson). Browse by
  level / episode.
- **State — scripts EXIST, audio EXISTS on disk, but no columns/serving/tab:**
  - Transcripts are LOADED in the DB: `ttmik_lessons` (232) / `ttmik_sentences` (2,742),
    `iyagi_episodes` (139) / `iyagi_sentences` (11,162).
  - Audio is ON DISK (gitignored/local, 1,179 mp3s): TTMIK lessons at
    `~/data/korean-master/corpus/TTMIK/Lessons/Lesson <L>/<track> TTMIK Level <L> Lesson <M>.mp3`;
    Iyagi at `~/data/korean-master/corpus/TTMIK/이야기들/이야기/<N> TTMIK Iyagi <N>.mp3`
    (+ a bonus "How To Sound Like A Native Korean Speaker" set). Filenames map deterministically
    to `ttmik_lessons.(lesson_level, lesson_number)` and `iyagi_episodes.episode_number`.
  - The mp3s are NOT referenced in the DB (no audio column) and NOT served; today's `AudioBlock`
    player is fake (**B-004**), and there is no static/streamed audio serving anywhere.
- **Build (the real work is audio infra, not the tab):**
  1. **DATABASE:** migration adding an audio reference to `ttmik_lessons` + `iyagi_episodes`
     (e.g. `audio_path TEXT` — store a stable relative key, not a host path).
  2. **DATA/ingest:** a mapping script that walks the corpus mp3s and populates the audio
     column by matching `(lesson_level, lesson_number)` / `episode_number` to the filenames
     (deterministic). Corpus stays local + gitignored — never commit mp3s.
  3. **BACKEND:** an authenticated audio-stream endpoint (`GET /audio/…` with HTTP **Range**
     support for seeking) that reads from the local corpus mount, plus list/detail endpoints
     returning episodes/lessons with transcript + audio URL. The `km-server` container needs the
     corpus audio dir **bind-mounted read-only** (compose change).
  4. **UI:** `/ttmik` route + nav tab; browse (lessons by level, Iyagi episodes); a player view
     = real `<audio>` + the transcript rendered line-by-line to read along.
- **Fix hint / relationships:** this is the real-audio build that **B-004** (fake player) and
  **B-005** (no Listening screen) are waiting on — F-012 largely resolves both. v1 ships the full
  transcript beside a working player; **karaoke-style per-line highlight is a follow-up** (needs
  per-line timestamps we don't have → forced alignment). Large feature: migration + loader +
  audio-serving infra + new tab.

### F-013 · Word mastery view — see how well a word is known
- **Status:** 🟢 done (2026-07-05) · **Priority:** P2 · **Category:** UI (BACKEND)
- **Where:** A surface for per-word mastery — likely a Progress tab, or the word popover / a vocab detail view. (Placement TBD.)
- **State:** The mastery signal already exists in the DB: `vocab_cards` carries `stability`, `difficulty`, `fsrs_state`, `due_at` + review history (the FSRS scheduler state). Nothing shows a learner how well they know a given word, or an overview of mastery across their vocab.
- **Key files:** `server/src/routes/vocab.ts` (cards + FSRS state; needs a per-word/summary read); `server/src/services/fsrs.ts` (stability → mastery mapping); client — new surface. Pairs with F-010 (progress/history) and F-017.
- **Fix hint:** Derive a "mastery" level from FSRS stability (e.g. buckets → New/Learning/Familiar/Mastered), expose it per word + as an aggregate, and render it (progress tab and/or on the word popover). Decide placement first.

### F-014 · Today "Writing" tab — rework (scope to be identified)
- **Status:** 🔴 open · **Priority:** P2 · **Category:** UI (BACKEND)
- **Where:** Today page → Writing tile / the writing flow.
- **State:** Flagged as needing rework; the exact changes still need to be identified by using it. Overlaps **F-001** (the Writing tile currently just navigates to Grammar, while a real `/grade-writing` grader exists server-side but is orphaned). Treat this as the investigation + redesign umbrella; fold F-001 in once the target behavior is decided.
- **Key files:** `client/src/pages/Today.tsx` (Writing tile); `server/src/routes/gradeWriting.ts` (orphaned grader); see F-001.
- **Fix hint:** First pass = use the current Writing flow and write down exactly what's wrong / what it should do; then design the real Writing screen (likely wiring `/grade-writing`). Blocked on that scoping note.

### F-015 · Hanja — finish the feature + populate the data
- **Status:** 🟢 done (2026-07-06) · **Priority:** P2 · **Category:** DATA (BACKEND, UI)
- **Resolution (2026-07-06):** the feature was ALREADY fully built (route + 21 tests,
  `Hanja.tsx` UI, `/hanja` route + `More`-tab nav entry, all wired) — the only gap was
  empty tables. Ran the pipeline: `build_hanja.py` (auto-fetches Unihan, mines the
  Darakwon vocab `hanja` glosses) → **857 characters** (all with reading/gloss/strokes/
  frequency/level + ≥1 compound) → `output/hanja.json` → loaded into the shared km-db
  via `DEPLOY_TAG=local bash Deploy/load-corpora.sh <output-dir> --corpus hanja`.
  Live counts: **857 `hanja_characters` + 1,853 `hanja_compounds`** (idempotent upsert;
  covers both blue/green). `/hanja` verified wired (401 JSON, in the nginx allow-list);
  `/hanja/today` returns a character. Server 21 + client 35 tests green.
- **Known v1 gaps (both intentional, tracked):** `etymology` is empty for all rows
  (build script documents no clean primary source; route maps `etymology AS note` and
  the code comment already says "v1 empty" — UI degrades to no note). The
  `hanja_extensions` table is unused (no loader, not queried by route/client — dead
  scaffolding; safe to drop in a future cleanup). Reproducible: re-run the two commands
  above (data is gitignored `output/hanja.json`, not committed).
- **Where:** Hanja feature / tab.
- **State:** Backend scaffolding exists — `server/src/routes/hanja.ts` + `server/tests/routes/hanja.test.ts` (21 tests) — but the hanja content isn't populated and the feature isn't finished end-to-end (data + UI). Needs a hanja dataset loaded and the flow completed so it's actually usable.
- **Key files:** `server/src/routes/hanja.ts`; `server/tests/routes/hanja.test.ts`; the hanja table (verify which migration defines it); a hanja loader + corpus (to acquire); client hanja page/route.
- **Fix hint:** Audit what the hanja route already returns, acquire/load a hanja dataset (character, meaning, reading, example words), and build/finish the hanja UI. Confirm the exact gaps before scoping.

### F-016 · Rework the "More" tab → Ask/Chat/AI, with an in-chat dictionary
- **Status:** 🔴 open · **Priority:** P2 · **Category:** UI (BACKEND)
- **Where:** Bottom nav "More" tab.
- **What:** Repurpose "More" — rename it to something like **Ask / Chat / AI** and have it route to the conversation/chat screen. That chat should also gain a **dictionary function** (look a word up inline from chat), tying the AI tutor and the dictionary into one place.
- **State / relationships:** Chat exists (`Chat.tsx`, working after B-010). The dictionary depends on KRDICT data (**B-011** — currently empty), so the in-chat lookup needs B-011 to return results.
- **Key files:** `client/src/lib/nav.ts` + `client/src/App.tsx` (nav entry/route for "More"); `client/src/pages/Chat.tsx`; dictionary lookup → `server/src/routes/krdict.ts` / `define.ts`.
- **Fix hint:** Rename/re-point the "More" nav entry to the chat screen, and add an in-chat dictionary lookup (reuse `/define` or `/krdict`). Depends on B-011.

### F-017 · Today: swipeable multi-skill stats carousel
- **Status:** 🔴 open · **Priority:** P2 · **Category:** UI (BACKEND)
- **Where:** Today page — extend the existing "compare to" widget.
- **What:** Make the Today stats widget **finger-swipeable** — a carousel / layered rotating display that pages through per-skill statistics for **all five skills (reading, listening, vocabulary, grammar, writing)**, e.g. a line graph of words mastered / items reviewed over time per skill. Swipe (or a rotating layered stack) moves between skills/metrics rather than showing just one.
- **State:** The current widget compares against a single reference. Underlying time-series data partly exists (diagnostic snapshots per attempt — see F-010; FSRS review history for vocab mastery — see F-013), but not uniformly across all five skills; listening/writing especially may lack a time-series until those features produce data.
- **Key files:** `client/src/pages/Today.tsx` (the "compare to" widget); charting — reuse whatever F-010/ResultsBlock uses; a swipe/carousel interaction (touch); backend reads for per-skill series (`diagnostic` history + `vocab` FSRS + others).
- **Fix hint:** Build a touch-swipeable carousel (or layered rotating stack) of per-skill charts on Today; back each panel with a per-skill time series. Pairs with F-010 (history data) and F-013 (mastery); confirm which skills actually have series data before promising all five.

### F-018 · Rich grammar detail — render examples/dialogues/formation_rules
- **Status:** 🔴 open · **Priority:** P3 · **Category:** BACKEND (UI)
- **Where:** Grammar detail Sheet — both the Reference Grammar tab (F-004, shipped) and the standalone `Grammar.tsx`.
- **State:** `GET /grammar/kgiu/:id` returns `explanation`, `unit`, plus `formation_rules` / `examples` / `dialogues` / `tips` as untyped `jsonb`. The detail Sheet (both screens) renders only explanation + unit and DISCARDS the richer fields — a real usability gap for a language-reference feature (you can't see example sentences for a pattern). Flagged in the Track A /fixpass (F-004 review) as an acceptable v1 cut, now tracked.
- **Key files:** `client/src/pages/Reference.tsx` (GrammarDetailSheet), `client/src/pages/Grammar.tsx` (DetailSheet), `client/src/types/domain.ts` (type the jsonb), `server/src/routes/grammar.ts` (`GET /grammar/kgiu/:id`)
- **Fix hint:** Type the `jsonb` fields on the DTO and render examples/dialogues/formation in a shared richer detail renderer used by both screens.

### F-019 · Generate wrong-answer explanations for topik_items
- **Status:** 🟢 done (2026-07-06) · **Priority:** P2 · **Category:** DATA
- **Resolution (2026-07-06):** the entry's "0 of 2,088" was stale — a prior session
  had generated most already. Audited: 1,924/2,088 carried an explanation; a
  subagent generated the remaining explainable ones in the approved format (quotes
  Korean, covers all 4 choices, references by text). Applied 2 more → **1,926/2,088**.
- **The remaining 162 are genuinely NOT explainable** (skip-over-guess, per the
  entry): ~48 writing (open-ended, no MC answer), ~33 reading with the passage
  absent (`options=[]`), 26 listening whose audio isn't in the corpus (stems read
  "듣기 지문 없음"), 4 reading with copyright-withheld passages ("지문은 공개하지
  않습니다"), and 4 (ids 222, 659, 769, 1086) whose keyed `answer` CONTRADICTS their
  own accessible content — likely source-bank answer-key bugs, tracked in FOLLOW_UPS.
  Feeds F-009 (gating), F-021 (mistakes log ✅).
- **Where:** TOPIK item bank (`topik_items.extra->>'explanation'`).
- **State:** F-009's UI gating shipped in Track A but a coverage audit found **0 of 2,088** `topik_items` carry an explanation — nothing shows. **Generated IN-SESSION (no API / no key):** Claude Code (main model + subagents) writes the explanations and bulk-inserts them — explanations are static per fixed item, so generate once. Pilot done 2026-07-04 (ids 1, 2, 349, 350); Jared approved the format.
- **Format (approved):** English reasoning that QUOTES the Korean; covers ALL four choices (why the answer is right + why each distractor is a trap); reference the answer by its Korean TEXT, never by position ("option 3") so it survives display reordering. Depth scales with item difficulty.
- **Data gap:** the `prompt` (question text) is EMPTY for most items — infer the question from the option pattern (motivations → "why", statements → 내용 일치). Mark/skip any item too ambiguous to explain confidently rather than guess.
- **Key files:** `server/src/routes/topik.ts` (reads `extra.explanation`); `topik_items` table (`extra` JSONB)
- **Fix hint:** Fan out subagents over the 2,088 items (chunked), each generating explanations in the approved format → `jsonb_set(extra,'{explanation}',…)`, idempotent (skip rows that already have one). Feeds F-009 (gating), F-020 (ask-in-chat), F-021 (mistakes log).

### F-020 · "Ask about this" — push a question + explanation into Chat
- **Status:** 🔴 open · **Priority:** P2 · **Category:** UI (BACKEND)
- **Where:** Any reviewed wrong answer — TOPIK study/mock review, diagnostic review, and the F-021 mistakes log.
- **What:** A button on a reviewed question that opens Chat pre-seeded with the item context — the question (stem/dialogue), the options, the user's pick, the correct answer, and the stored explanation — so the user can ask the AI tutor follow-ups ("why is 일부 동의 wrong?", "break down 그런데"). Turns a static explanation into an interactive tutoring session.
- **State:** Chat/conversation already exists (`Chat.tsx`, `/conversation`, working after B-010). Need to open a conversation SEEDED with the item context (as the scenario / first message) + the button in the review UI.
- **Key files:** `client/src/pages/Chat.tsx` + `client/src/services/conversation.ts` (seed a conversation); the review/explanation components (`MockMode.tsx`/TopikResults, `Diagnostic.tsx`); `server/src/routes/conversation.ts` (scenario already supported)
- **Fix hint:** Add an "Ask about this" action that navigates to Chat with the item context as the conversation scenario/seed; reuse the conversation API. Composes with F-016 (More→Chat) and F-021.

### F-021 · Wrong-answer review log (mistakes) — 30-day window
- **Status:** 🟢 done (2026-07-06, deployed) · **Priority:** P2 · **Category:** DATABASE (BACKEND, UI)
- **Resolution (2026-07-06):** shipped as a "Review mistakes" screen (More tab, first).
  Backend `GET /topik/mistakes` (auth-gated, user-scoped `getUserId` — no IDOR) over
  `topik_responses` (is_correct=false, `make_interval(days)` rolling 30-day window)
  joined to `topik_items`, returning the full item DTO (options + inline correct flag
  + explanation) + wrong pick + answered_at. Reuses `ix_topik_responses_user_answered_at`
  — no migration. Client: `fetchMistakes` + `Mistakes.tsx` (correct=green / wrong-pick=red
  "Your answer") + mock + route + nav. Tests: server 46 (2 new incl. IDOR + 30-day window),
  client 3. /fixpass APPROVE. PR #50. F-020's "Ask about this" per row is deferred (F-020
  is later in the roadmap).
- **Where:** New page/tab ("Review mistakes").
- **What:** A persistent list of questions answered INCORRECTLY across sessions — each with the question, the user's wrong pick, the correct answer, and the explanation — so the user can leave, come back, and review why they missed things. Rolling **30-day** window.
- **State:** Data partly exists — `topik_responses` is an append-only log of completed answers (verify it stores the picked answer + correctness + item id); `diagnostic_responses` logs diagnostic answers. A read endpoint filters incorrect answers within 30 days and joins `topik_items` for the question + explanation.
- **Key files:** NEW mistakes/review endpoint over `topik_responses` (+ `diagnostic_responses`); `db/migrations/015_topik_responses…` (confirm columns; maybe an index on user + correct + created_at); NEW client page + route + nav
- **Fix hint:** Query incorrect responses from the last 30 days joined to their items + explanations; render a reviewable list; each row gets F-020's "Ask about this". Retention = a query WINDOW (show last 30 days), not deletion. Pairs with F-010 (progress), F-019 (explanations), F-020.

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
