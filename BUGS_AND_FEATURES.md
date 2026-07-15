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

## Status snapshot (2026-07-06 — post feature-roadmap + intense bug sweep)

**Bugs: all 17 resolved / reclassified.** B-001–B-011, B-013–B-016 🟢 done; **B-016**
genuinely closed 2026-07-06 (via F-014 — it had been mis-marked). **B-012** is NOT a
loader bug (the loader is faithful) — it's an upstream corpus *extraction* gap (~400
words/level short of nominal 2,000) → tracked in FOLLOW_UPS, not a code fix.

**Features: 17 done, 4 open.** 🟢 done: F-001, F-003, F-004, F-005, **F-007, F-008,
F-009, F-010, F-011, F-012, F-013, F-014, F-015, F-017, F-019, F-020, F-021** (the
2026-07-06 roadmap: Hanja → Mistakes/explanations → Resume TOPIK → stats carousel →
Writing rework → Ask-about-this → diagnostic hardening, PRs #49–#55). 🔴 open (→ the
app overhaul phase): **F-002** (TOPIK L1/L2 diagnostic), **F-006** (email notifications),
**F-016** (More-tab → Chat rework + in-chat dictionary), **F-018** (rich grammar detail).

**Intense bug sweep (2026-07-06):** 5 Fable finders swept the whole codebase → ~40 real
defects fixed across 6 batches + a CRITICAL, each mutation-tested + independently
re-reviewed (server SHIP / client PASS). Headliners: a dropped chat stream crashed the
whole server (`process.exit`); `POST /topik/mock` merged TOPIK I+II sittings (scores
against a mixed/truncated exam); a TTL-0 cache served wrong OCR; `useEndpointOrMock`
painted fixture data as real in prod on a live-call failure; and a full audit of 1,926
explanations nulled 42 wrong/placeholder + repaired 3. **No security holes found.**
Trail: `db/docs/{SWEEP,FIX_sweep,REVIEW_SWEEP}_*.md`. Residuals → FOLLOW_UPS F-UP-018.

**Not in this doc — see `FOLLOW_UPS.md`:** F-UP-013…018 (answer-key data, resurrect-race
hardening, resume-fail UX, carousel/Writing nits, and the bug-sweep residuals).

> Snapshot refreshed 2026-07-06 after the sweep. Per-item detailed entries below are the
> source of truth; path:line refs are pointers, not guaranteed exact after edits.

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
| B-012 | Bug | ⚪ | P3 | DATA | Verify vocab-2000 completeness — 3,188 words loaded vs nominal ~4,000 (spot-check covered pages) |
| B-013 | Bug | 🔴 | P2 | UI (BACKEND) | "Add to review" is inert — no UI to seed vocab review cards; `POST /cards/init` exists but unwired |
| B-014 | Bug | 🔴 | P2 | UI | Review: rating a card flashes the NEXT card's English before it advances (flip not reset) |
| B-015 | Bug | 🔴 | P2 | UI | Reference "This Week": vocab+grammar need to be tabs; grammar overflows off-screen horizontally |
| B-016 | Bug | 🟢 | P3 | BACKEND (UI) | `expensiveLimiter` 429 never sends `retry_after` → Writing's "retry in N s" copy is dead code |
| F-001 | Feature | 🔴 | P2 | UI (BACKEND) | Writing tile → Grammar; `/grade-writing` backend exists but is orphaned |
| F-002 | Feature | 🟢 | P3 | DATABASE (DATA, BACKEND) | Add TOPIK L1 & L2 to diagnostic (enum + band math + tagged content) |
| F-003 | Feature | 🔴 | P3 | BACKEND (UI) | Vocab genre+difficulty filters — columns exist, just not wired |
| F-004 | Feature | 🔴 | P2 | UI | Grammar detail view — endpoint + `getPattern` exist; Reference rows not clickable |
| F-005 | Feature | 🔴 | P3 | BACKEND (UI) | Grammar difficulty+genre filters — columns exist, just not wired |
| F-006 | Feature | 🔴 | P3 | BACKEND (CONFIG) | Email notifications — no mail infra anywhere; net-new build |
| F-007 | Feature | 🟢 | P2 | DATABASE (BACKEND, UI) | Resume in-progress TOPIK test — no attempt persistence today |
| F-008 | Feature | 🟢 | P2 | UI (BACKEND) | TOPIK results/grade screen — already built in Mock; needs Study-mode parity |
| F-009 | Feature | 🟢 | P2 | UI (DATA) | Wrong-answer explanations — wired in Mock; gate to incorrect-only + data coverage |
| F-010 | Feature | 🟢 | P2 | UI (BACKEND) | Progress/diagnostic history page with graph comparison across attempts |
| F-011 | Feature | 🟢 | P2 | BACKEND (DATA, DATABASE) | Diagnostic hardening — cheap heuristic pass **spec'd** → `BRIEF_F011_diagnostic_hardening.md` |
| F-012 | Feature | 🔴 | P2 | BACKEND (DATABASE, DATA, UI) | TTMIK tab — play Iyagi podcasts + TTMIK lessons with real audio + read-along script |
| F-013 | Feature | 🟢 | P2 | UI (BACKEND) | Word mastery view — surface per-word FSRS mastery (progress tab or word detail) |
| F-014 | Feature | 🟢 | P2 | UI (BACKEND) | Today "Writing" tab rework — audit + identify changes (relates to F-001) |
| F-015 | Feature | 🔴 | P2 | DATA (BACKEND, UI) | Hanja — finish + populate (route/tests exist; data missing, UI incomplete) |
| F-016 | Feature | 🟡 | P2 | UI (BACKEND) | Rework "More" tab → rename Ask/Chat/AI → Chat, with an in-chat dictionary function |
| F-017 | Feature | 🟢 | P2 | UI (BACKEND) | Today: swipeable multi-skill stats carousel (per-skill mastery/reviewed graphs, finger-slide) |
| F-018 | Feature | 🟢 | P3 | BACKEND (UI) | Rich grammar detail — render examples/dialogues/formation_rules in the detail Sheet (now explanation+unit only) |
| F-019 | Feature | 🟢 | P2 | DATA | Generate wrong-answer explanations — 0/2,088 topik_items have one; pilot done (in-session, no API) |
| F-020 | Feature | 🟢 | P2 | UI (BACKEND) | "Ask about this" — push a question + its explanation into Chat for AI follow-up Q&A |
| F-021 | Feature | 🟢 | P2 | DATABASE (BACKEND, UI) | Wrong-answer review log — revisit past missed questions + explanations across sessions (30-day window) |

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
- **Status:** 🟢 done (2026-07-06, via F-014) · **Priority:** P3 · **Category:** BACKEND (UI)
- **Correction:** this was mis-marked done 2026-07-05 — the F-014 scout (2026-07-06)
  confirmed it was still live (429 body carried no `retry_after`). Genuinely fixed as
  part of F-014: `rateLimits.ts` now uses a shared `rateLimitedHandler` that sets the
  `Retry-After` header + the JSON `retry_after` from one integer (floored at 1s), so the
  Writing retry-countdown branch is now reachable + tested (incl. a `≤ 60` regression
  guard). Benefits every `expensiveLimiter` route.
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
- **Status:** 🟢 done (2026-07-07, deployed) · **Priority:** P3 · **Category:** DATABASE (DATA, BACKEND)
- **Resolution (2026-07-07):** the diagnostic used to collapse everything below L3 into
  'basic'; now it resolves true beginners into TOPIK 1 / TOPIK 2. **Code-only** — the scout
  confirmed the content already exists (on `topik_level`, not `proficiency`). Migration 039
  adds L1/L2 to the `proficiency_level` enum. `cat.ts`: THETA_MIN 2.0→1.0, 5-band cuts
  (θ<1.5→L1…), no 'basic' band. `scoring.ts`: low score anchors {1→10, 2→25} (on the existing
  line — zero historical score change), RUBRIC_VERSION v1.2.0. **All 4 dimensions genuinely
  target the level**: reading/listening prefer `topik_level='TOPIK I'` (the ~776 answerable
  beginner items); vocab/grammar gen seeds from `basic`-tagged content (the fixpass caught a
  BLOCKER where the seed targeted the dead 'L1'/'L2' tag). Symmetric TOPIK II preference added
  for L3+ (fixed a pre-existing asymmetry). Server REFERENCES + client both ship TOPIK 1/2
  rungs. Verified by hand: a beginner reaches θ=1.0 (L1) in 4 answers. Full /fixpass (R1 math
  PASS + R2 BLOCK → fix → re-review PASS, all mutation-proven). server 840 / client 751. PR #59.
  Deferred: lowering SEED_THETA (middle-bias, separate work); real proficiency backfill (not needed).
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
  resume-fail) → F-UP-014/F-UP-015. PR #51.
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
- **Status:** 🟢 done (2026-07-06, deployed — hardening pass) · **Priority:** P2 · **Category:** BACKEND (DATA, DATABASE)
- **Resolution (2026-07-06):** the "cheap heuristic pass" per `BRIEF_F011_diagnostic_hardening.md`
  — makes the diagnostic more trustworthy WITHOUT a psychometrics rebuild (θ staircase
  intentionally untouched; guessing-correction / adaptive-stopping / real-IRT still deferred).
  (1) 2→4 items/dimension (16-item interleaved run; B-006 already decoupled `/next` gen from
  grading so the 8 Claude gens don't re-freeze). (2) Per-dimension estimate uses proportion
  correct (`ESTIMATE_SPREAD`), not a 3-bucket delta — every item counts. `RUBRIC_VERSION` v1.0.0
  → v1.1.0. (3) Agresti-Coull confidence band per dimension (`BAND_Z`) — non-zero even at 0/4
  and 4/4, narrows as n grows, persisted in `evidence.dimensionStats` (no migration); legacy
  v1.0.0 snapshots still load (zero-width band). Client renders a subtle band range in
  SkillsCompare + honest "rough placement estimate, not an official score" framing (dropped the
  hardcoded "Level 4"); Intro copy corrected to 16 items / 4 per section. Built by 2 Fable
  agents; full /fixpass (1 BLOCKER: intro count mismatch → re-review PASS, math verified by a
  966-cell sweep + 5 mutation probes). Consts tunable. **Note for F-010** (progress history):
  the rubric bump means history must compare like RUBRIC_VERSIONs. server 59 / client 699. PR #55.
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
- **Status:** 🟢 done (2026-07-06, deployed) · **Priority:** P2 · **Category:** UI (BACKEND)
- **Resolution (2026-07-06):** the audit found the Writing feature already worked
  end-to-end (screen + Claude grader + Today tile → /writing; F-001's "points at
  Grammar" was already fixed). The "rework" = 4 gaps, all closed: (1) **prompt
  reconciliation** — migration 038 adds `writing_prompts.rubric`, retires the 8 legacy
  register-drill rows, seeds the real Q53/Q54 prompts; `GET /writing/prompts` serves
  them; `Writing.tsx` fetches per rubric tab (hardcoded list deleted); `/plan/today`
  filters `rubric IS NOT NULL` so tile + screen agree. (2) **Persistence** — new
  `writing_attempts` table; `/grade-writing` persists each grade (clamp-with-warn on an
  out-of-contract score, never a silent drop; a persist failure never fails the paid
  grade). (3) **F-017 Writing chart** — `GET /writing/series` (daily avg normalized to %)
  turns the carousel Writing panel from placeholder → real chart. (4) **B-016** fixed
  (see below). Built by 2 Fable agents; full /fixpass (0 BLOCKER → re-review PASS,
  both fix tests mutation-proven). PR #53. Leftover nits → F-UP-017.
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
- **Status:** 🟡 dictionary done (2026-07-07, deployed); nav rework deferred to the app overhaul · **Priority:** P2 · **Category:** UI (BACKEND)
- **Resolution (2026-07-07):** split into its two halves. **(1) In-chat dictionary — DONE + deployed:**
  a book-icon lookup by the Chat composer → `defineEntry(word)` → `buildWordPopover` → the existing
  `WordPopover` (KR headword, POS, gloss, example, More-examples drawer, Add-to-bank). Client-only —
  reuses the KRDICT `/define` endpoint + `WordPopover` as-is. All states handled with fixed copy
  (empty/loading/no-entry/`krdict_unavailable`/network/abort); no fabricated or sentinel gloss can
  reach the UI or the bank; raw server prose never rendered (`errorMessageFor`). Add-to-bank mirrors
  Ttmik (optimistic flip + rollback + toast). Full /fixpass (PASS, 0 blockers) + 7 mutation-verified
  hardening tests (abort-safety, newer-lookup-abort, bank-rollback, sentinel-filter). Chat.test.tsx
  32 tests. PR #60. **(2) Nav rework (promote Chat out of the 'More' sheet) — DEFERRED to the app
  overhaul** (product call 2026-07-07): the nav label is already "Chat"; the real ask is an
  information-architecture change (Chat is buried 7th-of-10 in the More sheet), which overlaps the
  overhaul's nav reorganization. `/chat` route + F-020's seed-navigation are untouched, so the
  promotion is a clean future change.
- **Where:** Bottom nav "More" tab.
- **What:** Repurpose "More" — rename it to something like **Ask / Chat / AI** and have it route to the conversation/chat screen. That chat should also gain a **dictionary function** (look a word up inline from chat), tying the AI tutor and the dictionary into one place.
- **State / relationships:** Chat exists (`Chat.tsx`, working after B-010). The dictionary depends on KRDICT data (**B-011** — currently empty), so the in-chat lookup needs B-011 to return results.
- **Key files:** `client/src/lib/nav.ts` + `client/src/App.tsx` (nav entry/route for "More"); `client/src/pages/Chat.tsx`; dictionary lookup → `server/src/routes/krdict.ts` / `define.ts`.
- **Fix hint:** Rename/re-point the "More" nav entry to the chat screen, and add an in-chat dictionary lookup (reuse `/define` or `/krdict`). Depends on B-011.

### F-017 · Today: swipeable multi-skill stats carousel
- **Status:** 🟢 done (2026-07-06, deployed) · **Priority:** P2 · **Category:** UI (BACKEND)
- **Resolution (2026-07-06):** new "실력 추이 · Progress by skill" card on Today (below
  SkillsCompare, which is untouched) — a swipeable `SwipeCarousel` of 5 per-skill panels
  (Reading/Listening accuracy %, Vocab reviews/day, Grammar avg score/day, Writing
  placeholder), each a hand-rolled `LineChart`. Backend: 3 read-only user-scoped series
  routes (`GET /topik/series`, `/vocab/series`, `/grammar/series`) aggregating the practice
  logs by UTC day — NO migration, no nginx change (existing prefixes). Practice-level data
  (fills in as you study); writing has no series → honest placeholder. Built by 2 Fable
  agents (backend/frontend, locked contract). Full /fixpass: 3 Fable reviewers (1 BLOCKER —
  carousel stuck-drag + ~8 SHOULD-FIX incl. fabricated-data fallback + fixture infidelity) →
  Fable fix → Fable re-review PASS (both critical tests mutation-proven). Tests: server +21
  (195 in the 3 suites), client +50ish (641 total). 3 cosmetic NITs → F-UP-016. PR #52.
- **Where:** Today page — extend the existing "compare to" widget.
- **What:** Make the Today stats widget **finger-swipeable** — a carousel / layered rotating display that pages through per-skill statistics for **all five skills (reading, listening, vocabulary, grammar, writing)**, e.g. a line graph of words mastered / items reviewed over time per skill. Swipe (or a rotating layered stack) moves between skills/metrics rather than showing just one.
- **State:** The current widget compares against a single reference. Underlying time-series data partly exists (diagnostic snapshots per attempt — see F-010; FSRS review history for vocab mastery — see F-013), but not uniformly across all five skills; listening/writing especially may lack a time-series until those features produce data.
- **Key files:** `client/src/pages/Today.tsx` (the "compare to" widget); charting — reuse whatever F-010/ResultsBlock uses; a swipe/carousel interaction (touch); backend reads for per-skill series (`diagnostic` history + `vocab` FSRS + others).
- **Fix hint:** Build a touch-swipeable carousel (or layered rotating stack) of per-skill charts on Today; back each panel with a per-skill time series. Pairs with F-010 (history data) and F-013 (mastery); confirm which skills actually have series data before promising all five.

### F-018 · Rich grammar detail — render examples/dialogues/formation_rules
- **Status:** 🟢 done (2026-07-06, deployed) · **Priority:** P3 · **Category:** BACKEND (UI)
- **Resolution (2026-07-06):** the fields already arrived from the server (SELECTed +
  spread) but were typed `unknown` and never rendered. Now typed (formation_rules string[],
  examples {korean,english}[], dialogues typed per the migration) + rendered via a new
  shared `KgiuDetailBody` used by BOTH the Grammar `DetailSheet` + Reference
  `GrammarDetailSheet` (so they can't drift); each section shows only when non-empty, with
  element-shape guards so a malformed corpus row degrades instead of crashing. The /fixpass
  also caught + fixed a REAL pre-existing prod bug: the detail SELECT omitted `unit` → footer
  showed "Unit · —" for every real pattern (masked by unit-carrying mocks — the grammar-Bank
  fixture class); now on the wire + pinned by a server test. Deleted dead `ScreenStub.tsx`.
  **Data note:** `dialogues` is empty in all 294 corpus rows today → the Dialogues section is
  coded but invisible until a corpus load populates it (F-UP-019). client 735 / server 56. PR #57.
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
- **Status:** 🟢 done (2026-07-06, deployed) · **Priority:** P2 · **Category:** UI (BACKEND)
- **Resolution (2026-07-06):** an "Ask about this" button on every reviewed item
  (Mistakes log, TOPIK mock + study reveal, diagnostic reveal). Frontend-only, NO
  backend change — `navigate('/chat', { state })` → `Chat.tsx` pre-fills the composer
  from `useLocation()` (user reviews + sends; never auto-sends). `lib/askSeed.ts`
  builds the seed (prompt + correct answer + wrong pick + explanation) and
  `readChatSeedState` runtime-narrows the forgeable router state + clamps to the 4000
  char message cap; the seed rides the same sanitize path as any chat message. Chat
  seed captured via a lazy useState initializer (can't clobber typed text / an
  in-progress thread). F-009 gating respected. Built by a Fable agent; full /fixpass
  (0 BLOCKER → re-review PASS; the MockMode seed-payload probe is mutation-proven — a
  correct-vs-pick field swap fails it). Independent of F-016 by design. client 682
  (+29). PR #54.
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

## 🌊 Wave 1 — Pre-beta redesign (2026-07-09)

Full pre-beta wave: every item below ships before friends begin beta testing. Tickets are
grouped by page/area in the order the edit list was given; IDs continue from B-016/F-021.
Confirmed decisions baked in: B-019 reverses B-005 (Reading tile → Reading page); B-018 is
Today-tile-only; F-034 removes the just-built F-016 chat dictionary; B-026 is an
audio-missing *investigation*. "Discuss" items (F-025 text-size, F-037 chat response style,
F-063 grammar-mastery model, F-077 Hanja reword) are flagged and not pre-decided.

#### ▸ Backend / DB

### F-022 · Database integrity + security audit, schema readiness for Wave 1
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P1 · **Category:** DATABASE (BACKEND) · **Beta:** —
- **What:** Verify the DB follows proper procedures and normalization: no duplications, no loopholes, nothing cheap or security-breachable. Confirm the schema will hold up under and support all newly added + Wave-1 features.
- **Notes:** Run before/alongside the new-table work (ticketing F-023, lists F-048/F-061, uploads sub-pages F-053/F-056, writing history F-046/F-074).

### B-017 · Placeholders shown where real database data should render
- **Status:** ✅ done (beta-hardening push — shipped + deployed + live-DB-audit-verified 2026-07-15) · **Priority:** P1 · **Category:** UI (BACKEND) · **Beta:** —
- **What:** No placeholders on pages for areas that actually need to show database data. Sweep all pages and wire every such area to real data.
- **Notes:** Same failure class as the earlier `useEndpointOrMock` fixture-as-real finding — treat as silently-broken, not cosmetic.

#### ▸ All Pages

### F-023 · In-app ticketing / feedback system for beta testers
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P1 · **Category:** BACKEND (DATABASE, UI) · **Beta:** 🚩 blocker
- **What:** A ticketing place so beta-testing friends can report issues, concerns, bugs, suggestions, and requests. Users see their own previous tickets plus community tickets shown anonymously; tickets have date/time-stamped comments, an edit option for your own tickets, a type (bug/concern/suggestion/request), and a status field.
- **Notes:** In-app feature, separate from this dev doc. Author IS stored (moderation) but hidden in the UI.

### F-024 · Back buttons on nested/sub-pages
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P1 · **Category:** UI · **Beta:** 🚩 blocker
- **What:** Add an in-app back control on pages that are inside pages (all nested/sub-pages), rather than relying on browser/OS navigation.

### F-025 · App-wide text-size setting + smaller default
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P3 · **Category:** UI · **Beta:** —
- **What:** Add an app-wide S/M/L text-size setting (root rem scaling) and generally reduce the default text size.
- **Notes:** Approach details flagged **discuss** (user: "perhaps smaller text?"). Setting + sync plumbing shipped on `feat/phase1-ui-primitives`; visible effect is limited to rem-sized text until the **F-086** px→rem migration lands (most styles pin px). The "smaller default" half is deliberately not shipped (default stays md=16px).

#### ▸ Today

### F-026 · Vocab tile rework → vocab/grammar carousel
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI · **Beta:** —
- **What:** Rework the vocab card tile — it's just a box and needs to look cooler. Make it a carousel that swipes between grammar and vocab.

### B-018 · Today grammar tile says "coming soon" instead of opening Grammar practice
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI · **Beta:** —
- **What:** Point the Today-page grammar drills tile at the real Learn → Grammar practice page; it must not show "coming soon."
- **Notes:** Confirmed scope: Today-page tile only — the Grammar practice page itself exists (not a global regression).

### B-019 · Today Reading tile routes to listening lessons, not Reading
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI · **Beta:** —
- **What:** The Reading tile must hot-link to the Reading page, not to the listening lessons.
- **Notes:** REVERSES B-005's resolution ("Reading + Listening both → Listen by design"; `Reading.tsx` was deleted when Read folded into Listen — see B-001). Depends on the rebuilt Reading page (F-067…F-070).

### F-027 · Writing tile: generate-new-topic via Claude API (TOPIK or general)
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** API (BACKEND, UI) · **Beta:** —
- **What:** The entire Today writing part needs a "generate new topic" powered by the Claude API, with an option to choose TOPIK-style questions if wanted or just a general prompt.
- **Notes:** Same generation engine as the Learn → Writing generate selection (F-073) — build once, surface twice.

### F-028 · TOPIK-recommended carousel rework (study link, order, resume banner)
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI · **Beta:** —
- **What:** TOPIK-recommended tile must bring the user to the study part of TOPIK and sit first in the carousel; Review Mistakes goes second in the same carousel. Resume-exam becomes a small clickable banner in the top-left of the carousel, present on both tiles.

### F-029 · All carousels loop back to the first tile
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P3 · **Category:** UI · **Beta:** —
- **What:** Every carousel in the app must loop infinitely — after the last tile it wraps around to the first original tile.

#### ▸ Progress

### F-030 · "Where you stand" bottom section → carousel (trend / attempt-vs-attempt / all attempts)
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI · **Beta:** —
- **What:** Turn the bottom part of Where You Stand (the attempt-vs-attempt area) into a carousel ordered: trend (score over attempts) → attempt vs attempt → all attempts.
- **Notes:** Builds on F-010/F-017 carousel + history infrastructure.

### F-031 · Word mastery pagination — words per page
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI · **Beta:** —
- **What:** Word mastery is too long — rework it to show only a set number of words per page.

### F-032 · Word Mastery + Grammar Mastery as tabs in one area
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI · **Beta:** —
- **What:** Word Mastery and Grammar Mastery become clickable tabs sharing the same area, instead of being stacked on top of each other.

#### ▸ Chat

### F-033 · Chat page formatting overhaul
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI · **Beta:** —
- **What:** The chat page needs major formatting changes overall.
- **Notes:** Specific changes tracked in F-034/F-035/B-020/F-036/F-037; this covers the general layout pass.

### F-034 · Remove in-chat dictionary + suggested words
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI (BACKEND) · **Beta:** —
- **What:** Remove the dictionary part and the suggested words from the chat page.
- **Notes:** Deliberate removal — this tears out the recently built F-016 in-chat dictionary. Confirmed decision.

### F-035 · "+" attach button in chat box (camera / image / document upload)
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI (BACKEND) · **Beta:** —
- **What:** Add a clickable "+" symbol in the bottom-left of the chat box housing camera, upload image, and upload document/file.

### B-020 · English on/off slider has no label
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P3 · **Category:** UI · **Beta:** —
- **What:** The add-English on/off slider needs an actual label — it is not easy to tell what it is.

### F-036 · Auto-name chats (Claude-web style)
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** BACKEND (API) · **Beta:** —
- **What:** Chats need to be auto-named from their content, not the same name with a date — similar to how Claude does it in the web interface.

### F-037 · Rework Claude response style in chat
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** API (BACKEND) · **Beta:** —
- **What:** Update how Claude responds — currently very long and blocky.
- **Notes:** Response style/format flagged **discuss** before implementing.

#### ▸ Settings

### F-038 · Collapsible settings tiles, collapsed by default
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P3 · **Category:** UI · **Beta:** —
- **What:** Make each Settings tile/box collapsible and start collapsed.

### F-039 · Move Uploads out of Settings → Review → Uploads
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI · **Beta:** —
- **What:** Physically migrate the current Settings Uploads section to the Review → Uploads area; it no longer lives in Settings.
- **Notes:** Destination behavior specced in F-057/F-058/F-059.

### F-040 · Notifications rework — user-selectable timing + SMS placeholder
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** BACKEND (UI, CONFIG) · **Beta:** —
- **What:** Revisit the notifications section: for daily reminder, reviews-due, and weekly report, the user must be able to select when each notification happens. Add a placeholder SMS channel with the same notification types (placeholder only for now).
- **Notes:** SUPERSEDES/EXPANDS F-006 (email notifications — no mail infra exists; net-new build).

### F-041 · Hanja Mastery carousel
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI (BACKEND) · **Beta:** —
- **What:** Add a new Hanja Mastery carousel, similar to the existing vocab and grammar ones.
- **Notes:** Pairs with the Hanja flashcard/anki work (F-075).

#### ▸ Review

### F-042 · Restructure Review landing (sections + removals)
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI · **Beta:** —
- **What:** Remove Flashcards and Grammar Drill from the top. Section order becomes: Vocabulary, Grammar, TOPIK Exams (where mistakes and past TOPIK exams will live), Uploads. Remove anything else — but only after the page merges/moves land (some pages are being put inside others or combined).
- **Notes:** Sequence after F-039 (Uploads move) and the Mistakes/TOPIK rework (F-044…F-046, F-082).

### F-043 · Rename "Review" → "Library"
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P3 · **Category:** UI · **Beta:** —
- **What:** Change the page title from Review to Library.

#### ▸ Review → Mistakes

### F-044 · Session selector + collapsible questions in Mistakes
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI (BACKEND) · **Beta:** —
- **What:** User selects which session (TOPIK exam) to review, and questions within it are collapsible — currently everything is shown at once, so the page is very long and cluttered.
- **Notes:** Builds on F-021 (wrong-answer review log).

### F-045 · Show score out of total questions per TOPIK exam
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI (BACKEND) · **Beta:** —
- **What:** Each TOPIK exam in Mistakes needs to show how many questions the user got right out of the total.

### F-046 · Writing review — past written responses (TOPIK + generated prompts)
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI (BACKEND, DATABASE) · **Beta:** —
- **What:** Add a writing review so users can revisit past writing practice, in two parts: (1) TOPIK-exam writing responses, collapsible like Mistakes, with score-out-of-max grade; (2) "Prompts" — responses written against app-generated (Claude) prompts.
- **Notes:** Consumes the same history as the Learn → Writing responses tab (F-074).

#### ▸ Review → Vocabulary

### F-047 · Remove grammar from the Vocabulary tab
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI · **Beta:** —
- **What:** Remove grammar content from this tab since Review now has a separate Grammar tab.

### F-048 · Add-word list selection + Create List button
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI (BACKEND, DATABASE) · **Beta:** —
- **What:** When adding a word, the user must be able to select which list it goes to. Add a Create List button so a user can make and choose a list.
- **Notes:** SUPERSEDES B-013 (disabled per-list "Study this list"/"Add all to bank" buttons) together with F-060/F-061.

### F-049 · Genre + difficulty dropdown filters at top of Vocabulary
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI (BACKEND) · **Beta:** —
- **What:** Move the genre filter to the top, before the list, as a dropdown of all genre types; add a dropdown for the 3 difficulty levels.
- **Notes:** "Genre" = the existing `domain` field. Relates to F-003 (filters columns exist, unwired).

### F-050 · Rename Dictionary → "All Words" with first-character + genre search
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI (BACKEND) · **Beta:** —
- **What:** Change the Dictionary button to All Words, searchable by the first Hangul character as well as by genre (same genres as normal vocabulary).

### F-051 · Limit word list to 15 with show-more (up to 30)
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P3 · **Category:** UI · **Beta:** —
- **What:** Limit displayed words to 15, with an option to show more up to 30.

### F-052 · Move My Lists to the top
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P3 · **Category:** UI · **Beta:** —
- **What:** Move the My Lists section up to the top of the Vocabulary page.

### F-053 · "My Uploads" sub-page inside Vocabulary
- **Status:** 🟡 client shipped · backend deferred · **Priority:** P2 · **Category:** UI (BACKEND, DATABASE) · **Beta:** —
- **What:** A My Uploads page inside Vocabulary holding vocab words the user chose to study from their uploads (clicking a word in an upload and adding it to a list files it here), separable/grouped by the source upload on the user's profile.
- **Notes:** Only shown if such saved items exist. Grammar twin = F-056.

#### ▸ Review → Grammar

### F-054 · Prune Grammar page (remove vocab/dictionary, search-all, genre filter)
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI · **Beta:** —
- **What:** Remove vocabulary and dictionary from the Grammar page, remove the search-all-grammar-patterns feature, and remove the genre filter (can't really sort grammar by genre).
- **Notes:** Confirmed: grammar drops genre entirely.

### F-055 · Grammar difficulty filter → dropdown
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P3 · **Category:** UI · **Beta:** —
- **What:** Keep the difficulty filter but make it a dropdown.
- **Notes:** Relates to F-005 (grammar filter columns exist, unwired).

### F-056 · Grammar "Uploads" sub-page
- **Status:** 🟡 client shipped · backend deferred · **Priority:** P2 · **Category:** UI (BACKEND) · **Beta:** —
- **What:** Add an Uploads page mirroring the Vocabulary one (F-053): user-saved grammar pulled from their uploads, grouped by source upload — only populated when a grammar-bearing upload/selection exists.

#### ▸ Review → Uploads

### F-057 · PDF viewer: rotation option + auto fit-width
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI · **Beta:** —
- **What:** When viewing an upload's PDF version, add a rotation option and auto fit-width.
- **Notes:** Lives in the migrated Uploads area (F-039).

### F-058 · Uploads listing shows only PDF versions
- **Status:** 🟢 done-as-respecced (Phase 3B) · **Priority:** P3 · **Category:** UI · **Beta:** —
- **What:** The Uploads area only shows the PDF versions of uploads.
- **Disposition:** A literal "PDF-only" filter is unimplementable and product-wrong — the server discards the original format at ingest (migration 041, no `source_format` column) and a literal filter would hide zip-based corpus books. Phase 3B shipped the honest equivalent: a **viewable-rendition filter** (excludes only un-renderable ghost rows, keeps processing/failed lifecycle rows). A literal source-format filter needs a server column first — tracked in **F-109**.

### F-059 · Manual OCR trigger button
- **Status:** 🟡 client shipped · backend deferred · **Priority:** P2 · **Category:** UI (BACKEND) · **Beta:** —
- **What:** Add a clickable OCR button (or another term understandable to a normal user) that starts the OCR process for an upload.

#### ▸ Learn → Vocab flashcards

### F-060 · Flashcards landing rework — lists-first, remove sessions + All Cards
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI (BACKEND) · **Beta:** —
- **What:** Remove the session part and the All Cards section. Landing shows all lists; clicking a list shows its vocab words with a Study button at the top that launches the flashcards. Add a create-new-list section on the landing page.
- **Notes:** Create-list shares plumbing with F-048. Part of the set superseding B-013.

### F-061 · Edit-lists inside a list (rename, remove words, add-words flow)
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI (BACKEND, DATABASE) · **Beta:** —
- **What:** Inside a list, an Edit Lists button lets the user change the title, remove words, or add words — the add button routes to the Review → Vocabulary section, and any word selected via that route is automatically added to the list that was originally open.
- **Notes:** With F-048/F-060, supersedes B-013.

### F-062 · List-completion page with stats
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI · **Beta:** —
- **What:** After completing a flashcard list, show a completion page with some of the session's stats.

### B-021 · Verify FSRS/anki intervals are actually honored
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P1 · **Category:** BACKEND (DATABASE) · **Beta:** —
- **What:** Verify the anki system really works at runtime: Again < 1 m, Hard < 6 m, Good < 1 d, Easy < 4 d must be genuinely respected by the scheduler, not just displayed.
- **Notes:** Verify-class item — could be silently broken. Test against real card data, not mocks.

### B-022 · "More examples" overlays rating row; no close; doesn't reset
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI · **Beta:** —
- **What:** Clicking More Examples overlays the Again/Hard/Good/Easy row; it should instead expand the initial tile underneath. Add a close button, and auto-close/reset whenever the page is tapped or the card is flipped.
- **Notes:** REOPENS F-UP-008 (more-examples drawer) as a bug.

### B-023 · Card has pointed corner + square box over a rounded tile
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P3 · **Category:** UI · **Beta:** —
- **What:** Cards still show a point and a square box while the tile underneath is round — formatting error; make the shapes consistent.

#### ▸ Grammar practice

### F-063 · Rework banked/graduate/known terminology → grammar mastery model
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI (BACKEND) · **Beta:** —
- **What:** Replace the words "banked," "graduate," and "known" — probably with something similar to vocabulary so grammar mastery works the same way.
- **Notes:** Mastery model flagged **discuss/brainstorm** before implementing. Pairs with F-066.

### B-024 · Saved-grammar list formatting is cluttered; forms wrap lines
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P3 · **Category:** UI · **Beta:** —
- **What:** The saved-grammar list has no real separation and feels cluttered — needs better organization, and all grammar forms must stay on one line.

### F-064 · Move drill button to top-right, rename "Practice"
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P3 · **Category:** UI · **Beta:** —
- **What:** Move the drill button to the top-right of the page and relabel it "Practice."

### F-065 · View past drill entries
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI (BACKEND, DATABASE) · **Beta:** —
- **What:** Provide a way to see past grammar drill entries.

### F-066 · Anki-style scheduling for grammar
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** BACKEND (DATABASE, UI) · **Beta:** —
- **What:** Apply the same anki approach to grammar. The self-graduate concept is acceptable, but its current formatting is not.
- **Notes:** Depends on the mastery-model discussion in F-063.

#### ▸ Learn → Reading

### F-067 · Reading sections by type (literature, dialogue) + uploaded docs
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI (BACKEND) · **Beta:** —
- **What:** Add sections for reading type (literature, dialogue); this is where uploaded documents will live.
- **Notes:** The Reading page must be rebuilt — it was deleted when Read folded into Listen (see B-001/B-019).

### F-068 · AI short-story generation section
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** API (BACKEND, UI) · **Beta:** —
- **What:** A Generate section where AI can generate a short story to read.

### F-069 · Per-upload reading resume
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI (BACKEND, DATABASE) · **Beta:** —
- **What:** A Resume button that saves where the user was when reading, tracked per upload.

### F-070 · Passage selection → translation popup (Google-Translate style)
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI (API) · **Beta:** —
- **What:** In the digitized-books area, keep single-word definition lookup, but selecting a whole passage translates it in a popup, Google-Translate style, via the Claude API.

#### ▸ Learn → Listen

### F-071 · Listen landing → square tile grid (2 across)
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI · **Beta:** —
- **What:** Change the Listen landing page to square tiles, 2 across and flowing down — ready for if/when more audio is added.

### B-025 · Verify TTMIK transcripts + highlights
- **Status:** 🟡 partial (transcripts + highlights verified working; read-along highlight needs forced alignment — deferred) · **Priority:** P1 · **Category:** DATA (UI) · **Beta:** —
- **What:** Verify the transcripts and the read-along highlights actually work for the TTMIK lessons.
- **Notes:** Verify-class — check against real corpus content, not fixtures.

### B-026 · Missing audio investigation — ~10 TTMIK lessons + ~48 Iyagi episodes
- **Status:** 🟡 partial (root cause confirmed: ~58 mp3s absent from disk, loader correct; blocked on user-supplied audio) · **Priority:** P1 · **Category:** DATA (BACKEND, CONFIG) · **Beta:** —
- **What:** All lessons/episodes are expected to have audio, but roughly 10 TTMIK lessons and 48 Iyagi episodes have no `audio_path`. Investigate why (missing source files vs bad ingest vs path mismatch) and restore the audio.
- **Notes:** Investigation ticket — root-cause first, then repair. Corpus at `~/data/korean-master/corpus/`.

### F-072 · Limit Listen listing to 15 files per page
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P3 · **Category:** UI · **Beta:** —
- **What:** Limit the number of files shown per page to 15.

#### ▸ Learn → Writing

### F-073 · Generate selection — AI-created non-TOPIK prompts
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** API (UI) · **Beta:** —
- **What:** Add a new Generate selection where AI creates a writing prompt for the user, different from the TOPIK ones.
- **Notes:** Same Claude-API generation engine as the Today writing tile (F-027): TOPIK-style question OR general prompt.

### B-027 · Verify writing questions aren't hard-locked to Q53/Q54 and randomize
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P1 · **Category:** BACKEND (UI) · **Beta:** —
- **What:** Verify the writing page is not hard-locked to Q53/Q54 in the headers and that it genuinely randomly selects writing questions.
- **Notes:** Verify-class — could be silently broken.

### F-074 · Responses tab — past writing responses
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI (BACKEND) · **Beta:** —
- **What:** Add a Responses tab showing the responses the user submitted for past prompts.
- **Notes:** Shares history/storage with the Review writing review (F-046).

#### ▸ Learn → Hanja

### B-028 · Verify Hanja drill / recall actually works
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P1 · **Category:** UI (BACKEND) · **Beta:** —
- **What:** Actually verify the Hanja drill/recall flow works end-to-end.
- **Notes:** Verify-class; F-015 history says route/tests existed while data/UI lagged — exercise with real data.

### F-075 · Hanja flashcard system (lists + anki)
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI (BACKEND, DATABASE) · **Beta:** —
- **What:** Add a flashcard system for Hanja similar to vocab: lists, new-list creation, and the anki flashcard scheduling system.
- **Notes:** Feeds the Settings Hanja Mastery carousel (F-041).

### F-076 · Hanja drawing drill
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI · **Beta:** —
- **What:** Create the drawing drill for Hanja.

### F-077 · Hanja page reword
- **Status:** 🔴 open · **Priority:** P3 · **Category:** UI · **Beta:** —
- **What:** The Hanja page needs a reword.
- **Notes:** Flagged **discuss** — possibilities to be brainstormed with the user first.

#### ▸ Learn → TOPIK

### B-029 · TOPIK landing wrongly limited to 10 items
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI · **Beta:** —
- **What:** Don't limit the initial landing page to just 10 — 10 is only the daily recommended amount for study, not a hard cap.

### F-078 · Daily right/wrong counter
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI (BACKEND) · **Beta:** —
- **What:** Add a daily counter of right and wrong answers on the TOPIK page.
- **Notes:** User wrote "write and wrong" — interpreted as right/wrong; confirm.

### F-079 · Mock exam chooser with done-checkmarks + start page with attempts
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI (BACKEND) · **Beta:** —
- **What:** In the mock exam section, the user chooses which exam to take — e.g. clicking Reading lists the TOPIK exams; previously-completed ones show a green checkmark. Selecting one leads to a start page requiring a Start click; if already done, the same start page additionally shows previous attempts and the grade.

### F-080 · Listening mock exams — playable per-question audio
- **Status:** 🟡 client shipped · backend deferred · **Priority:** P2 · **Category:** UI (DATA, BACKEND) · **Beta:** —
- **What:** The listening mock exams need work: add the option to play the audio for each question.
- **Notes:** Check whether TOPIK question audio exists in the corpus at all — may surface a data gap like B-026.

### F-081 · Show question-paired images where possible
- **Status:** 🟡 client shipped · backend deferred · **Priority:** P2 · **Category:** DATA (UI) · **Beta:** —
- **What:** If possible, show the images that some TOPIK questions are paired with.
- **Notes:** User flagged this may be hard. `has_image` items currently render text-only.

### F-082 · TOPIK landing "Previous attempts" review view
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI (BACKEND) · **Beta:** —
- **What:** Landing page gets a Previous Attempts list of completed TOPIK exams with grade and correct-out-of-total. Wrong questions show red in the mock-exam tile format; clicking a question shows it with the user's previous answer (no explanation), plus a button that jumps to that exact question + explanation in the current Review → Mistakes view.
- **Notes:** Builds on F-021 attempt history; links into F-044/F-045.

#### ▸ Carryover (pre-Wave-1, still open)

Existing items that ship with this wave — referenced by existing ID, not re-ticketed:

- **Dependency-vuln bumps** — 🟢 **/fixpass COMPLETE — PASS (all 4 phases)** in worktree `worktree-agent-a866a005817c1f492`: 2 independent reviewers → 0 blockers → independent fix-pass → independent re-review PASS (0 not-fixed, 0 regressions). 7 vulns (1 crit/1 high) → **0**; @anthropic-ai/sdk 0.80→0.110, uuid 10→14, vitest 2→4; SF-1 done (Docker both stages → `node:22-alpine`, `docker build --check` clean), NIT done, SF-2→**B-032**, consistency follow-ups→**F-085**. Gates green (audit 0, tsc 0, lint 0, 980 tests). Paper trail: REVIEW_deps_{runtime,tests}.md + FIX_REPORT.md + REVIEW_FIXES.md (worktree). **Ready to merge to `rebuild`; deploy held** (node:22-alpine pulls fresh on first idle-color build). · **P1** · **Beta:** 🚩 blocker
- **F-UP-013** — 🟢 done (2026-07-09) — 659→3, 769→2, 1086→3 applied to prod km-db + corpus JSON; item 222 was correct-as-is (→ B-031 for its option-1 OCR). · **P1** · **Beta:** 🚩 blocker
- **B-012** — vocab-2000 ~400/level short + 214 navigational rows to restore · **P2**
- **F-UP-018** — residual explanations + Claude-spend monitoring + `topik_level`-not-persisted · **P3**
- **CI/hygiene nits** — pin docker images by digest; re-enable ignored ingest integration test + pytest-randomly; loader count-assertion cumulative-awareness · **P3**

#### ▸ Phase 0 outcomes + follow-on tickets (2026-07-09)

Phase-0 verify sweep results (annotations on the tickets above):
- **B-021** (anki) — scheduler works + is server-authoritative (verified vs 70 real reviews), but labels lie (`<1m/6m/1d/4d` shown vs `10m/1d/3d/6d` actual). **DECIDED: retune the FSRS-lite engine so grades genuinely yield true Anki `1m/6m/1d/4d`** (not just relabel). Engine `server/src/services/fsrs.ts` (BASE_STABILITY + RELEARN_DELAY_MS); do in the flashcards phase.
- **B-027** (writing) — confirmed BROKEN: hard-locked Q53/Q54 (client+server enum+DB CHECK) + deterministic selection (same prompt every visit); only 6 active prompts. Fix = randomize/seed selection + widen beyond Q53/54 (schema) + add prompt content depth.
- **B-028** (hanja drill) — confirmed: "Drill" button is dead (no onClick/endpoint/grading; `hanja_progress` 0 rows). Real build (pairs with F-075/F-076).
- **B-025** (transcripts/highlight) — transcripts fully work; read-along **highlight doesn't exist** (no per-line timestamps in corpus). Needs forced-alignment to add timestamps (a project) or drop the karaoke ask — **decision deferred**.
- **B-026** (missing audio) — root cause: all 58 mp3s (TTMIK L9 5–14; Iyagi 147–150/201–235/237–239/241–246) are **absent from disk**; loader is correct. Repair = **user sources the files** → drop into corpus → re-run idempotent loader.
- **B-017** (placeholders) — fixture-as-real class fully remediated; only real finding folds into F-042 (Review "Uploads — coming soon" stub hides the live `/uploads`).

New tickets from Phase 0:

### B-030 · App DB connection runs as a Postgres SUPERUSER
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P1 · **Category:** DATABASE (CONFIG) · **Beta:** —
- **What:** `korean_master` is `rolsuper=t` and is the role Express connects as. Create a non-superuser `km_app` role (SELECT/INSERT/UPDATE/DELETE on app tables only — no DDL/TRUNCATE) for the app; keep the superuser for the migration runner only.
- **Notes:** F-022 finding C1. Contained today (km-db has no host port, all SQL parameterized, single-user) but a latent RCE-class escalation if any SQL-exec leak ever appears.

### F-083 · DB hygiene cleanup migration
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P3 · **Category:** DATABASE · **Beta:** —
- **What:** New migration: drop 6 redundant indexes (ix_diagnostic_responses_run_ordinal, ix_topik_items_test_number, ix_image_words_capture, ix_krdict_examples_sense, ix_krdict_senses_entry, ix_krdict_inflections_entry); export + drop the 2 orphan backup tables (topik_items_explanation_bak_20260706, _followup).
- **Notes:** F-022 A2/A3/B1. Author as a migration; the deploy runner applies it — do NOT hand-apply. **Scope change (migration 045):** the audit's proposed FK `grammar_drill_attempts → grammar_entries(user_id, pattern_key)` was DROPPED — the audit finding was wrong. `POST /grammar-drill` inserts the attempt row at generation time, but the grammar_entries row is only auto-banked at submit time, so a drill attempt for a not-yet-banked pattern is a legitimate state by design (the "5 orphan rows" were this state, not corruption); the FK would 500 the live drill route on every first drill of an unbanked pattern. The index/bak-table hygiene stands.

### B-031 · TOPIK item 222 option-1 text OCR glitch
- **Status:** 🔴 open · **Priority:** P3 · **Category:** DATA · **Beta:** —
- **What:** `topik83-I-read-042` option[0] ("수미 씨는 공항에 왔습니다") reads as unsupported, making two options look false. The answer key (4) is correct; re-OCR option 1 against the original 83rd TOPIK PDF + patch `tools/ingest/output/topik_83_I_reading.json` + DB.
- **Notes:** F-UP-013 spinoff.

### F-084 · Iyagi 51–100 transcript load — numbering-mismatch investigation
- **Status:** 🔴 open · **Priority:** P2 · **Category:** DATA · **Beta:** —
- **What:** `tools/ingest/output/iyagi_51_100.json` is unloaded and could add ~51 audio-backed episodes, BUT its units are numbered 101+ and the source is "TTMIK **Talking** 51-100.pdf" (possibly a different series than 이야기). Reconcile the numbering against the on-disk Iyagi audio (51–100) and existing DB episodes (101–118) BEFORE loading, to avoid collisions/mis-mapping.
- **Notes:** B-026 spinoff. Do not load until the numbering is understood.

### B-032 · `withRetry` never retries plain connection errors (dead error-name check)
- **Status:** ✅ done (beta-hardening push — shipped + deployed + live-DB-audit-verified 2026-07-15) · **Priority:** P3 · **Category:** BACKEND · **Beta:** —
- **What:** `server/src/services/claude/retry.ts` gates a retry on `err.name === 'APIConnectionError'`, but the Anthropic SDK reports `.name === 'Error'` on connection failures (verified against both 0.80 and 0.110), so that branch is dead — a transient network drop to Claude isn't retried.
- **Notes:** Pre-existing (NOT introduced by the dep bump); surfaced by the dep-vuln /fixpass runtime review (SF-2). Fix = duck-type on the SDK's actual connection-error shape (e.g. `status`/cause), add a test.

### F-085 · Node 22 upgrade consistency sweep (CI + client Dockerfile + compose + engines guard)
- **Status:** ✅ done (beta-hardening push — shipped + deployed + live-DB-audit-verified 2026-07-15) · **Priority:** P3 · **Category:** CONFIG · **Beta:** —
- **What:** The server Dockerfile moved to `node:22-alpine` (dep-vuln fix). For consistency + because Node 20 is EOL: bump CI `node-version: 20`→22 (`.github/workflows/*`), move the client Dockerfile(s) node:20→22, update stale `node:20-alpine` mentions in the compose healthcheck comments, and add an `"engines": { "node": ">=20.19" }` guard to `server/package.json` (uuid@14's undeclared ESM floor).
- **Notes:** Surfaced by the dep-vuln /fixpass re-review. Non-blocking (CI currently runs Node 20.20.2 ≥20.19, so tests pass). Sibling of B-032.

### F-086 · App-wide px→rem font-size migration (makes the F-025 text-size setting fully effective)
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** CONFIG (UI) · **Beta:** —
- **What:** The F-025 text-size setting re-points the ROOT font-size, but almost all app text is pinned in px and ignores it: `client/src/styles/index.css` alone has ~256 `font-size: …px` declarations (0 rem) plus px font-sizes in the page/component CSS files (`Today.css`, `Progress.css`, `LineChart.css`, …) and ~20 inline `fontSize:` numbers in TSX. Migrate font-size declarations px→rem (÷16, keep the same rendered md size) so S/M/L visibly scales the whole app.
- **Notes:** Unblocks F-025's real effect — today the setting only moves the rem-migrated Phase-1 primitives (BackButton/CollapsibleTile/Tabs/FilterSelect/ShowMore, converted in the Phase-1 fix-pass). Known-limitation notes live in `client/src/lib/text-size-presets.ts` and the index.css text-size block; Settings hint copy already worded honestly. Surfaced by the Phase-1 /fixpass text-size review (S1). New text should be authored in rem from day one.

### F-087 · Accent-as-text/indicator contrast test coverage
- **Status:** 🔴 open · **Priority:** P3 · **Category:** UI · **Beta:** —
- **What:** `client/src/**/tokensContrast.test.ts` validates accent-on-surface (non-text 3:1) but not accent-used-as-a-selection-INDICATOR / accent-as-text at the AA text bar. The Phase-1 fix-pass measured the light-theme **mint** `--vermilion` at **2.99:1 vs `--ink`** (below 3:1) and **coral** at 3.01:1 (barely passing) — currently masked by redundant cues (underline/`--paper` promotion). Add explicit accent-as-indicator + accent-as-text assertions so a future token tweak or a component that leans on accent color alone can't silently drop below AA.
- **Notes:** Surfaced + ruled non-blocking by the Phase-1 /fixpass re-review; the mint 2.99:1 gap predates Phase-1 (in `rebuild`'s own token comments). Do this **before the overhaul mounts Tabs / accent-driven selection at scale**.

### F-088 · Per-migration explicit destructive marker (vs pattern-sniffing)
- **Status:** ✅ done (beta-hardening push — shipped + deployed + live-DB-audit-verified 2026-07-15) · **Priority:** P3 · **Category:** CONFIG (DATABASE) · **Beta:** —
- **What:** `migrate.py`'s destructive gate detects `DROP TABLE`/`TRUNCATE` by SQL-pattern. It does NOT catch mass `DELETE FROM` (046.down) or `DROP COLUMN` (041) — and widening the patterns would force `--allow-destructive` onto legitimate additive migrations (e.g. 045's `DELETE`, 041's `DROP COLUMN`). Cleaner: an explicit per-migration marker (e.g. a header directive `-- migrate: destructive`) the runner reads, so destructiveness is declared, not sniffed.
- **Notes:** Surfaced by the P2-G1 /fixpass (gate-widening deferred with rationale). Implemented as `-- migrate: destructive|non-destructive` (`MIGRATE_DIRECTIVE_PATTERN`, `explicit_destructiveness`, `db/migrate.py`): an explicit marker wins over the sniff when present; unmarked files (every migration 001-061) fall back to the unchanged legacy sniff (backward-compat preserved). String literals can't forge a marker (`_strip_string_literals_only`); both directives in one file raises `ConflictingDestructiveMarkers`. Unit tests in `db/tests/test_migrations.py`; exercised end-to-end by 062 (non-destructive) and 063/064's down files (destructive — the mass-DELETE/DROP-COLUMN gap this ticket names, now correctly gated). 046.down itself was NOT retrofitted with a marker (out of scope — already-applied migration content is checksum-locked).

### F-089 · Revoke default TEMP privilege from `km_app`
- **Status:** ✅ done (beta-hardening push — shipped + deployed + live-DB-audit-verified 2026-07-15) · **Priority:** P3 · **Category:** DATABASE (CONFIG) · **Beta:** —
- **What:** `km_app` (migration 047) is least-privilege for DML but still holds Postgres's default `TEMP` privilege on the database (temp-table creation). Tighten to true least-privilege: `REVOKE TEMP ON DATABASE ... FROM km_app` (+ from PUBLIC). Low risk; completes the B-030 hardening.
- **Notes:** Surfaced by the P2-G1 /fixpass dbinfra review (NIT, deferred). Sibling of B-030. Verified zero `CREATE TEMP`/`CREATE TEMPORARY`/`pg_temp` usage anywhere in `server/src` or `db/migrations` before writing the REVOKE (repo-wide grep, confirmed clean). `db/migrations/062_revoke_km_app_temp.{up,down}.sql` revokes/restores both km_app's own grant (defensive — never explicitly granted) and PUBLIC's database-level default (the real fix, protects future roles too); marked non-destructive (F-088) since a privilege REVOKE is not data loss. Tests: `db/tests/test_migration_062.py`.

### F-090 · F-078 pre-046 attempt-history gap decision
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P3 · **Category:** DATA (UI) · **Beta:** —
- **What:** Before migration 046, `topik_attempts` was a single overwrite-in-place slot per user, so **no historical attempts exist prior to 046** — the "Previous attempts" view (F-078/F-082) will start empty and only accrue history going forward. When building F-078, decide how to present this (e.g. accept the clean-start, or backfill a synthetic history row from `topik_responses` if desired).
- **Notes:** Surfaced by the P2-G1 /fixpass re-review. Not a bug — a product decision for the F-078 build.

### B-033 · Tickets PATCH returns 409 instead of 404 when the ticket vanishes mid-update
- **Status:** ✅ done (beta-hardening push — shipped + deployed + live-DB-audit-verified 2026-07-15) · **Priority:** P3 · **Category:** BACKEND · **Beta:** —
- **Where:** `server/src/routes/tickets.ts` (~252-273) — PATCH `/tickets/:id`.
- **Root cause:** If the ticket row disappears between the pre-read and the versioned UPDATE (today only possible via a cascading `DELETE FROM users`), the UPDATE affects 0 rows and the handler throws `ConflictError('stale ticket version')` — telling the client to refetch-and-retry a ticket that no longer exists (the refetch 404s, so the client self-corrects after one wasted round trip).
- **Fix hint:** When the UPDATE returns no row, re-probe existence (owner-scoped) and throw `NotFoundError` vs `ConflictError` accordingly. Low severity now; **becomes user-visible the day a `DELETE /tickets/:id` endpoint ships — do not build that endpoint without this** (and revisit the comment-moderation question in the same design pass).
- **Notes:** Deferred from the P2-G2 /fixpass (tickets review SHOULD-FIX 1).

### F-091 · Client multi-type list awareness — key and delete list rows by (item_type, entry_id)
- **Status:** 🔴 open · **Priority:** P2 · **Category:** UI · **Beta:** —
- **What:** Migration 049 lets a list hold vocab AND grammar/hanja items whose numeric ids may collide, but the client still assumes `entry_id` alone identifies a row: `client/src/components/MyVocabLists.tsx` (~517) keys rows on `` `entry:${entry_id}` `` (collides across types → wrong-row rendering), and `removeListEntry` (`client/src/services/vocab.ts` ~374-382) never passes `?type=` (server defaults to vocab → removing a grammar row 404s at best, deletes a same-numbered vocab row at worst).
- **Fix hint:** Key rows and deletes on the `(item_type, entry_id)` pair and pass `?type=` on remove; `addListEntries` should adopt the typed `items: [{type, id}]` body. **Hard gate: must land before any grammar/hanja add-UI ships (the F-048/F-060/F-061 client slice).** Server is already correct.
- **Notes:** Deferred from the P2-G2 /fixpass (lists review SF-2). Harmless today — no UI can put a non-vocab item in a list yet.

### F-092 · notification_deliveries needs a uniqueness-based claim key before a sender ships
- **Status:** ✅ done (beta-hardening push — shipped + deployed + live-DB-audit-verified 2026-07-15) · **Priority:** P3 · **Category:** DATABASE · **Beta:** —
- **What:** The 052 deliveries log's idempotency story is probe-newest-then-insert-pending. Without a `UNIQUE (schedule_id, <firing-window>)` there is a probe→insert race in which two workers both claim the same firing and double-send.
- **Fix hint:** When the F-040 sender phase is built, add a `window_start` (or equivalent firing-window) column + UNIQUE constraint as the real claim — the insert, not the probe, must be the arbiter. Table is trivially alterable until then.
- **Notes:** Deferred from the P2-G2 /fixpass (reading/notif review F2-2). Copy into the sender-phase spec. `db/migrations/063_notification_deliveries_claim_key.{up,down}.sql` adds `window_start TIMESTAMPTZ NOT NULL` + `uq_notification_deliveries_schedule_window UNIQUE (schedule_id, window_start)`. Claim/settle primitives in `server/src/services/notificationDelivery.ts` (`claimDelivery` = atomic `INSERT ... ON CONFLICT DO NOTHING`; `settleDelivery` = `UPDATE ... WHERE status='pending'`, the "unclaimed" guard) — still no sender/scheduler, just the guard rail per the ticket's own scope. Tests: `server/tests/services/notificationDelivery.test.ts`, including an 8-way `Promise.all` concurrent-claim test proving exactly one winner under real Postgres. Down is marked destructive (F-088) — DROP COLUMN would lose claim history.

### F-093 · Migrate client Settings off the 018 preferences-blob notification booleans
- **Status:** 🟡 partial (Phase B2a) · **Priority:** P3 · **Category:** UI (BACKEND) · **Beta:** —
- **What:** The Settings screen still reads/writes the migration-018 `users.preferences` JSONB notification booleans; migration 052 + `/notifications/schedules` is now the real notification-intent store. Until the client migrates, two sources of truth drift (the blob's booleans are documented as future-dead keys in 052's header).
- **Fix hint:** Point the Settings notification section at GET/PUT `/notifications/schedules` (note: `weekday` must be *omitted*, not `null`, for daily kinds), then retire the blob's notification keys from `NotifPrefsSchema` in a follow-up once nothing reads them.
- **Notes:** Deferred from the P2-G2 /fixpass (reading/notif review F2-3). The Settings notification SECTION (the actual UI) had already migrated to `/notifications/schedules` before this batch — the schedule rows are what F-040 shipped. Phase B2a did the EXPAND half: `db/migrations/064_backfill_notification_schedules_from_prefs.{up,down}.sql` backfills `notification_schedules` from any pre-existing blob intent (gated on `channel.email`, `ON CONFLICT DO NOTHING` so real user data always wins, defensive `jsonb_typeof` guards against a malformed blob aborting the migration) — see `db/tests/test_migration_064.py`. Also closed the one live client-side drift vector: `client/src/pages/Settings.tsx`'s outgoing prefs PUT now echoes `lastSyncedPrefsRef.current.notif` (the last value the SERVER reported) instead of `settings.notif` (the localStorage cache "Reset to defaults" can independently revert) — see the F-093 regression test in `Settings.test.tsx`. **NOT done in this batch:** making `GET`/`PUT /settings/prefs` actually SOURCE `notif` from `notification_schedules` server-side. Investigated and deliberately deferred — that wire-contract change (the route stops trusting/persisting the client's `notif` and instead derives+overrides it from the canonical schedules table) breaks ~15 assertions in `server/tests/routes/settings.test.ts` that currently pin "PUT echoes whatever notif you send, verbatim" as the contract, and is a bigger, coordinated client+server redesign than an expand-only batch should carry — exactly the "CONTRACT step, do it as a follow-up" the ticket's own fix hint already anticipated. Recommend its own ticket/batch.

### F-094 · Migrate the remaining private `mapClaudeError` copies to the shared 4xx-aware helper
- **Status:** ✅ done (beta-hardening push — shipped + deployed + live-DB-audit-verified 2026-07-15) · **Priority:** P3 · **Category:** BACKEND · **Beta:** —
- **What:** The P2-G3 fix-pass hoisted `mapClaudeError` into `server/src/middleware/errors.ts` with the corrected behavior (proxy-origin client faults keep their status: injection → 400, proxy per-route limiter → 429; everything else flattens to 502) and wired the generation routes (`writing.ts`, `reading.ts`) to it. Four private flatten-to-502 copies remain: `server/src/routes/grammarDrill.ts` (~533), `server/src/routes/diagnostic.ts` (~1596), `server/src/routes/conversation.ts` (~1107), and `server/src/services/imageIngest.ts` (~407). On those surfaces an injection rejection or the proxy's own limiter still reads as a 502 outage.
- **Fix hint:** Swap each to the shared helper and delete the local copy. This is a wire-contract change per route (400/429 instead of 502) — do each with its route suite run + a status-mapping test, same as `tests/routes/generation.test.ts` now pins for the generation pair. `gradeWriting.ts`/`enrich.ts` already pass status through inline and can adopt the helper for free.
- **Notes:** Deferred from the P2-G3 /fixpass (generation review SF-1 coordination note + writing/chat review NIT-6: five-plus copies past the rule-of-three).

### B-034 · B-021 client slice — drill banner still says "next in ~10 minutes" for scheduledDays 0
- **Status:** 🟢 done (Phase 3C-1) — grammar 0-day copy branches on `schedule.rating` (again → "under a minute", hard → "~6 minutes"); the three `types/domain.ts` doc comments corrected; hanja restored engine-true interval subs mirroring vocab. · **Priority:** P2 · **Category:** UI · **Beta:** —
- **Where:** `client/src/pages/Grammar.tsx` (~1573-1578); stale copy also pinned by `client/src/pages/Grammar.test.tsx` (~914-937) and described in `client/src/types/domain.ts` doc comments (~1014, ~1379, ~1395).
- **Root cause:** After the B-021 FSRS retune (server-only, deliberate), a scheduledDays-0 transition is either an `again` step (<1 minute) or a `hard` learning step (6 minutes) — the hardcoded "~10 minutes" label is false either way. The drill response already carries `schedule.rating`, so the client can distinguish "<1m" from "~6m" without an API change.
- **Fix hint:** One-file copy change keyed on `schedule.rating` + re-pin the test + update the three domain.ts comments. B-021 is not fully closed until this lands.
- **Notes:** Deferred from the P2-G3 /fixpass (anki review SF-1 — client slice, Phase-3).

### B-035 · B-027 client slice — Writing.tsx still indexes the deterministic prompt list
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI · **Beta:** —
- **Where:** `client/src/pages/Writing.tsx` (~167-170 rotation-cursor init, ~228 indexes the `/prompts` list; the Q53/Q54 header hardcode lives in the same screen).
- **Root cause:** The B-027 backend (`GET /writing/prompts/random?rubric=`) shipped in P2-G3 but has no caller — the client still fetches the deterministic `/prompts` list and opens a fixed index, so the user-visible symptom (same prompt every visit) persists.
- **Fix hint:** Consume `/writing/prompts/random` per draw; fold the Q53/Q54 header hardcode into the same change. Do not close B-027 until this lands.
- **Notes:** Deferred from the P2-G3 /fixpass (writing/chat review coordination item — client slice, Phase-3).

### F-095 · Chat client slice for F-035/F-036 — "+" attach button + auto-name trigger
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** UI · **Beta:** —
- **What:** The F-035/F-036 backends are live (`POST /conversation/:id/file` document attach; `POST /conversation/:id/name` auto-title — idempotent, race-safe, never clobbers a user rename; `PATCH /conversation/:id` rename) but the chat UI has neither the "+" attach button nor any auto-name call.
- **Fix hint:** Add the "+" attach control (document branch → `/file` with `expected_version`; the image path already exists), and call `POST /conversation/:id/name` once after the first assistant reply. Repeat `/name` calls are free (no Claude spend) but still debit the expensive limiter — see the NIT in `db/docs/REVIEW_phase2g3_writing_chat.md` before wiring name-on-open.
- **Notes:** Deferred from the P2-G3 /fixpass (Phase-3 client work by design).

### F-096 · Writing-prompt content depth — seed more prompts per rubric
- **Status:** 🔴 open · **Priority:** P2 · **Category:** DATA · **Beta:** —
- **What:** The active writing-prompt bank is only ~3 prompts/rubric (migration 038 seed), so even with server-side random selection (B-027 backend) the rotation is shallow. Seed a substantially larger bank per rubric (Q53 memo/graph tasks, Q54 essay topics), optionally curating outputs from `POST /writing/generate`.
- **Fix hint:** New seed migration (add-only INSERTs into `writing_prompts` with `rubric` + `is_active`) — content work, not code. Keep prompt lengths well under the DB CHECK ceilings.
- **Notes:** Deferred from the P2-G3 /fixpass (B-027 Phase-0 note: "add prompt content depth").

### F-097 · App-wide dead-CSS sweep of the shared `index.css` global sheet
- **Status:** 🔴 open · **Priority:** P4 · **Category:** UI (HYGIENE) · **Beta:** —
- **What:** The shared `client/src/styles/index.css` accumulates orphaned rule blocks whenever a page rework deletes markup, because parallel branches deliberately avoid editing the shared sheet mid-flight. Phase 3A's fix-pass swept the settings-channel/toggle and `.km-today__queue*` orphans, but `.km-progress__trendKr` (pre-existing on `rebuild`, out of the 3A diff scope) remains. Do one deliberate sweep of the whole sheet for classes with zero `.tsx` consumers.
- **Fix hint:** Grep each `.km-*` selector against the client tree; delete only zero-consumer blocks. Distinct from **F-086** (px→rem migration) — this is dead-rule removal, not unit conversion.

### F-098 · BEM element-casing convention + mechanical rename
- **Status:** 🔴 open · **Priority:** P4 · **Category:** UI (CONSISTENCY) · **Beta:** —
- **What:** BEM element casing drifts per page — Settings is kebab-case (`__sched-row`), Today is camelCase (`__tileIcon`), Progress mixes both. Pick one convention (kebab-case recommended, it dominates the older pages), document it, and mechanically rename. Deferred from the Phase 3A /fixpass as high-churn / low-value to do inline; worth doing before Phase 3B compounds it.

### F-099 · Grammar-mastery read route (server) for the Progress Grammar tab
- **Status:** 🔴 open · **Priority:** P3 · **Category:** BACKEND (API, UI) · **Beta:** —
- **What:** Progress's F-032 mastery tabs ship Words + Hanja live, but the Grammar tab shows an honest "coming soon" placeholder because no `/grammar/mastery`-style aggregate read route exists yet (P4 plan of record). Build the read route (FSRS bucket counts over the user's grammar cards) and wire the tab — the client already reserves the panel for real data.
- **Notes:** Pairs with F-063 (grammar-mastery model). Progress Grammar tab is wired to accept a real panel with no further client rework.

### F-100 · Fix the stale `nav.ts` Uploads comment (fold into F-057–F-059)
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P4 · **Category:** UI (DOC) · **Beta:** —
- **What:** After F-039 removed Uploads from Settings, a comment in `client/src/lib/nav.ts` (~line 280) still says the Uploads page is "reached from Settings → Uploads." Left untouched during Phase 3A to avoid a shared-file edit across parallel branches. Fix it when `nav.ts` is next open — naturally, when Review→Uploads (F-057–F-059) lands and re-homes the entry point.

### F-101 · Carry a Today-generated writing topic into the Writing screen (F-027 → F-073 page half)
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** UI · **Beta:** —
- **What:** The Today Writing tile's Claude-generated topic (F-027, `POST /writing/generate`) is currently display-only — the server persists nothing. Add the page-side half of F-073: carry a generated topic into `/learn/writing` (via `location.state`) so the user can actually write against it and have it graded. Build-once/surface-twice: the `WritingTopicGenerator` component is already reusable on the Writing screen.

---

## ✅ Phase 3A — Core surfaces (Today · Progress · Settings) — DONE, PR pending

Delivered on `feat/phase3a-core-surfaces`, full 4-phase /fixpass PASS (re-review 10 FIXED / 0 regressions), full client suite 1305/1305.
- **Today:** F-026 ✅ (vocab/grammar lead carousel) · B-018 ✅ (grammar tile → real page, no "coming soon") · F-027 ✅ (Claude generate-topic, TOPIK/general) · F-028 ✅ (TOPIK carousel reorder + corner resume banner) · F-029 ✅ (all carousels loop) · F-024 ⏭️ n/a (no nested sub-views) · **B-019 still 🔴 BLOCKED** on the rebuilt Reading page (F-067–F-070); Reading tile behavior preserved verbatim.
- **Progress:** F-030 ✅ (where-you-stand carousel: trend→vs→all) · F-031 ✅ (word-mastery pagination) · F-032 ✅ (Word/Grammar/Hanja mastery tabs; Grammar tab awaits F-099) · F-041 ✅ (Hanja Mastery, aggregate-only pending F-075 per-character list).
- **Settings:** F-038 ✅ (collapsible tiles, collapsed default) · F-039 ✅ (Uploads removed — ⚠️ **PRE-DEPLOY BLOCKER: F-057–F-059 Review→Uploads must land before deploy**, else uploads are only reachable by typing /uploads) · F-040 ✅ (per-type notification timing + SMS placeholder).
- **New tickets filed:** F-097 (dead-CSS sweep) · F-098 (BEM casing) · F-099 (grammar-mastery route) · F-100 (nav.ts comment) · F-101 (F-027→F-073 page half).

---

## 🌊 Phase 3B follow-up tickets (filed 2026-07-10)

Surfaced by the Phase 3B builders + /fixpass reviewers; several backend routes are net-new work the client already reserves UI for.

### F-102 · `/images` needs an in-app re-entry point
- **Status:** 🔴 open · **Priority:** P3 · **Category:** UI (NAV) · **Beta:** —
- **What:** F-042 removed the interim "Scan images" row from the Library landing, which was `/images`'s ONLY in-app entry point — the OCR image-mining page is now reachable only by typing the URL (route still registered at `client/src/App.tsx:139`). Give it a home: a Library row, the LEARN launcher, or fold it into Uploads/the chat image feature (pending the P4 IA decision on image capture).

### F-103 · Dedicated "Past TOPIK exams" surface
- **Status:** 🔴 open · **Priority:** P2 · **Category:** UI (BACKEND) · **Beta:** —
- **What:** The Library "TOPIK exams" section currently lands on Mistakes as an honest stub (sanctioned by F-042). Build the dedicated past-exams page (list of completed sittings + scores) under the exams shelf; re-point the Library section's target to it, and Mistakes becomes a link inside it. Depends on F-104. The pinning test `ReviewLibrary.test.tsx` must be updated when this lands.

### F-104 · `GET /topik/attempts` — completed-attempt history with per-exam score
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** BACKEND (API) · **Beta:** —
- **What:** No route returns completed TOPIK attempts with a per-exam score (correct/total, section, sourceTest, completedAt). Schema is ready (migration 046: `topik_attempts.status`, `topik_responses.attempt_id`) — the route is missing in `server/src/routes/topik.ts`. **Unblocks F-045** (Mistakes score-out-of-total, currently honest missed-count only), F-078, F-082, and F-103. (Was code-comment ticket "KM-3B-M1".)

### F-105 · `attempt_id` in the `GET /topik/mistakes` DTO
- **Status:** 🔴 open · **Priority:** P3 · **Category:** BACKEND (API) · **Beta:** —
- **What:** Mistakes groups sessions by a (local-day, mode) heuristic that merges two same-day mock sittings. Expose `attempt_id` in the `/topik/mistakes` DTO so the session selector groups by true sitting (F-044 exactness). (Was "KM-3B-M2".)

### F-106 · `GET /writing/attempts` — per-response writing history
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** BACKEND (API) · **Beta:** —
- **What:** `writing_attempts` rows are persisted by `POST /grade-writing`, but the only read is aggregate `GET /writing/series`. Add a per-response history GET (promptKr, rubric, sample, totalScore/maxTotal, gradedAt, nullable promptId to split TOPIK-prompt vs Claude-generated). **Unblocks F-046** (Mistakes writing-review, currently a pending stub) and is the twin of F-074. (Was "KM-3B-M3".)

### F-107 · Upload provenance on vocab/grammar save paths + saved-from-uploads read
- **Status:** 🔴 open · **Priority:** P2 · **Category:** BACKEND (API, DATABASE) · **Beta:** —
- **What:** F-053/F-056 ("My Uploads" sub-pages) render honest-empty because nothing records which upload a saved word/pattern came from. Add optional `source_upload_id` to the save paths (`POST /vocab/mine` + list adds; the grammar equivalent) and a `GET /vocab/saved-from-uploads` (grouped by upload); then wire the reserved `SavedFromUploads` sections. Distinct from F-108 (that populates *extracted-corpus* provenance; this is *user-saved* provenance).

### F-108 · U2 extraction/OCR pipeline (backend)
- **Status:** 🔴 open · **Priority:** P2 · **Category:** BACKEND (API) · **Beta:** —
- **What:** No OCR/extraction backend exists (`server/src/routes/uploads.ts` header: extraction is a later separate phase, "U2"). Build the OCR trigger route + pipeline reading `book_pages` images; populate `kgiu_entries.source_upload_id` at curation. **Unblocks F-059** (the viewer's honestly-disabled "Extract text" button) and makes F-056's grammar-from-upload view return real rows.

### F-109 · Retain `source_format` on uploads (enables literal source-format filter)
- **Status:** 🔴 open · **Priority:** P4 · **Category:** BACKEND (DATABASE) · **Beta:** —
- **What:** The server discards the original zip/PDF at ingest (migration 041) and stores no `source_format` column, so F-058's literal "PDF-only" filter is unimplementable client-side (and would wrongly hide zip-based corpus books). F-058 shipped the honest equivalent — a viewable-rendition filter. If a literal source-format filter is ever wanted, add the server column first. **F-058 is done-as-respecced.**

---

## 🌊 Phase 3C-1 follow-up tickets (filed 2026-07-10)

Backend gaps the Phase 3C-1 card/FSRS reworks (flashcards · grammar · hanja) honest-stubbed or reserved UI for. Client is CLIENT-only; these are the server halves for the mini-phase.

### F-110 · `GET /grammar-drill/attempts` — past drill history (grammar F-065 backend)
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** BACKEND (API) · **Beta:** —
- **What:** `grammar_drill_attempts` has no read endpoint, so the Grammar → History view is an honest "not available yet" stub. Add a paged, user-scoped read (pattern, drill type, answer, score, verdict, scored_at) so History renders real entries. (Was code-comment id "F-065-B".)

### F-111 · Per-pattern grammar production-card schedule read (grammar F-063 backend)
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P3 · **Category:** BACKEND (API) · **Beta:** —
- **What:** Grammar card rows show only due-NOW badges because there's no read of full FSRS state + `due_at` for non-due production cards. Expose it (e.g. folded into `GET /grammar/bank`) so grammar mastery rows can show Anki state/next-due like vocab. (Was code-comment id "F-063-B".)

### F-112 · Vocab list detail rows should carry example sentences
- **Status:** 🔴 open · **Priority:** P3 · **Category:** BACKEND (API) · **Beta:** —
- **What:** `GET /vocab/lists/:id` rows carry no example sentences, so list-study card backs show gloss only (the KRDICT drawer compensates on demand). Server should JOIN `example_korean`/`example_english` so study backs are complete offline.

### F-113 · Per-list due-aware study queue + bulk "add all to review"
- **Status:** 🔴 open · **Priority:** P2 · **Category:** BACKEND (API) · **Beta:** —
- **What:** List "Study" presents ALL words each run — there's no `due?list_id=` queue, so it isn't due-only like the global due queue. Add a per-list due-aware queue and a per-list bulk "add all to review/deck".

### F-114 · Expose numeric `hanja_characters.id` on the `GET /hanja` DTO
- **Status:** 🔴 open · **Priority:** P4 · **Category:** BACKEND (API) · **Beta:** —
- **What:** The hanja pool DTO doesn't expose the numeric character id, so list-add currently obtains it via an idempotent card-seed round-trip (disclosed in UI). Expose the id on the pool DTO so list-add no longer needs the seed side-effect.

### F-115 · Hanja stroke-order data → guided + gradable drawing drill (F-076 backend)
- **Status:** 🔴 open · **Priority:** P3 · **Category:** DATA (BACKEND) · **Beta:** —
- **What:** The F-076 drawing drill ships as a freehand canvas with an honest note — there's no stroke-order data in the corpus. Acquire per-character stroke data (KanjiVG / makemeahanzi-style) to add a guided stroke overlay + a gradable drill. (Was code-comment id "F-076-b".)

---

## ✅ Phase 3C-1 — Card/FSRS family (Vocab flashcards · Grammar practice · Hanja) — DONE, PR pending

Delivered on `feat/phase3c1-cards`, full 4-phase /fixpass PASS (re-review: all 4 blockers mutation-verified dead, 0 regressions), full client suite 1415/1415.
- **Vocab flashcards:** F-060 ✅ (lists-first landing) · F-061 ✅ (edit-lists + add-words round-trip) · F-062 ✅ (completion stats) · **B-021 ✅ verified** (client copy matches retuned engine) · B-022 ✅ (More-Examples expands underneath + close + auto-reset + keyboard-operable) · B-023 ✅ (card geometry).
- **Grammar practice:** F-063 + F-066 ✅ (mirror vocab + Anki — Learning/Known, Again–Easy labels, due-first) · B-024 ✅ (formatting, one-line forms) · F-064 ✅ (Practice button) · F-065 ⏳ history honest-stub (backend **F-110**).
- **Hanja:** F-075 ✅ (flashcard system + lists) · **B-028 ✅** (real drill replaces the dead button) · F-076 ✅ (canvas drill; stroke guidance stubbed → **F-115**) · F-077 ⏳ deferred (reword — discuss).
- **Cross-cutting:** shared keyboard-flip bug fixed once in `components/Flashcard.tsx` + `lib/interactiveElement.ts`; interval copy unified engine-true across all three (**B-034 done**).
- **New tickets filed:** F-110 · F-111 · F-112 · F-113 · F-114 · F-115.

---

## 🌊 Phase 3C-2 follow-up tickets (filed 2026-07-10)

Backend routes / corpus data the Phase 3C-2 content-surface reworks (Reading · Listen · Writing · TOPIK) honest-stubbed or reserved UI for. Client is CLIENT-only; these are the server/data halves for the mini-phase. (IDs canonicalized after a parallel-builder collision — these are the authoritative assignments, matching the `F-11x` references baked into the page code.)

### F-116 · `POST /reading/translate` — whole-passage translation (reading F-070 backend)
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** API (BACKEND) · **Beta:** —
- **What:** Reading's F-070 passage-selection popup ships as an honest "coming soon" shell (`Reading.tsx` `TranslateSheet`) — there's no passage-translate route (reading.ts serves passages + single-word define/enrich only). Add a Claude whole-passage translation route behind the proxy (expensiveLimiter, sanitized passage input, Zod-validated output). When it lands, only the popup's fetch needs wiring.

### F-117 · Widen the writing rubric taxonomy beyond Q53/Q54 (writing B-027 remainder)
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P3 · **Category:** BACKEND (DATABASE, API) · **Beta:** —
- **What:** B-027's client half is fixed (honest headers + random selection), but the rubric is still hard-locked to `topik_ii_53/54` in the server Zod enum + `writing_prompts`/`writing_attempts` DB CHECK. Widen the taxonomy (+ a real free-write rubric for `/grade-writing`) so free-writes stop grading against a Q54 fallback. Removes the on-sheet deferral note.

### F-118 · `GET /topik/tests` — enumerate TOPIK papers (TOPIK F-079 chooser backend)
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P2 · **Category:** BACKEND (API) · **Beta:** —
- **What:** The F-079 mock-exam chooser can't list per-section exams because no route enumerates `topik_tests` (the `/topik/items` DTO carries no test number). Add a read returning available papers (test_number, topik_level, section, item counts). Feeds the chooser list; pairs with F-104 for the completed-checkmarks + previous-attempts.

### F-119 · TOPIK listening audio — ingest + serve per-question (TOPIK F-080 data gap)
- **Status:** 🔴 open · **Priority:** P2 · **Category:** DATA (BACKEND) · **Beta:** —
- **What:** F-080 (per-question listening audio) is a data gap: audio exists only as one whole-section MP3 per paper (`~/data/korean-master/corpus/TOPIK TEST/.../*-Listening-Audio.mp3`, ~24 files), un-ingested, with no DB column/DTO field, no serving route, and no per-question timestamps. Ingest + segment (or serve with cue points), add a DTO audio field + route; then wire per-question play controls. The client discloses the gap honestly today.

### F-120 · TOPIK question images — extract + serve (TOPIK F-081 data gap)
- **Status:** 🔴 open · **Priority:** P3 · **Category:** DATA (BACKEND) · **Beta:** —
- **What:** F-081 (question-paired images) is a data gap: images live only inside the test-paper PDFs; the DB has only `has_image` + `image_text`. Extract `has_image` items' figures, store + serve the assets, add a DTO image URL; then render alongside `image_text`. The client renders the honest text-description affordance today.

### F-121 · `ShowMore` final-reveal focus lands on an off-screen node (visible-focus polish)
- **Status:** ✅ done (beta-hardening push — shipped + deployed + live-DB-audit-verified 2026-07-15) · **Priority:** P4 · **Category:** UI (A11Y) · **Beta:** —
- **What:** The Phase 3C-2 fix for the `components/ShowMore.tsx` focus-drop (button unmounts on final reveal → focus fell to `<body>`) hands focus off to the revealed content region, which fully fixes the focus-loss defect but the target isn't reliably in-viewport, so it doesn't satisfy WCAG 2.4.7 (visible focus) for sighted keyboard users. Strict improvement over the original bug; polish the handoff to land on a visible, scrolled-into-view element. Affects all ShowMore consumers (Progress, ReviewVocab, Listen).

---

## ✅ Phase 3C-2 — Content/exam surfaces (Reading · Listen · Writing · TOPIK) — DONE, PR pending

Delivered on `feat/phase3c2-content`, full 4-phase /fixpass PASS (re-review: 11/11 should-fixes FIXED, 0 regressions; cross-cutting ShowMore + Tabs changes verified against all consumers), full client suite 1463/1463.
- **Reading:** F-067 ✅ (typed sections) · F-068 ✅ (AI story-gen, wired) · F-069 ✅ (per-upload resume, wired) · F-070 ⏳ passage-translate honest stub (→ **F-116**) · **B-019 ✅ closed** (Today Reading tile → /learn/reading).
- **Listen:** F-071 ✅ (2-across square grid) · F-072 ✅ (15/page) · B-025/B-026 correctly not-built (deferred/data).
- **Writing:** F-073 ✅ (on-page generator) · **F-101 ✅ closed** (Today→Writing handoff wired both ends) · **B-027 ✅** (honest headers + random selection; rubric-widen → **F-117**) · F-074 ⏳ responses stub (→ **F-106**).
- **TOPIK:** B-029 ✅ (uncapped draw) · F-078/F-079/F-082 ⏳ honest stubs (→ **F-104** attempts + **F-118** /topik/tests) · F-080 ⏳ audio data gap (→ **F-119**) · F-081 ⏳ image data gap (→ **F-120**).
- **Cross-cutting:** `components/ShowMore.tsx` focus-drop fixed (all consumers); Ttmik hand-rolled tablist → shared `Tabs`.
- **New tickets filed:** F-116 · F-117 · F-118 · F-119 · F-120 · F-121.

---

## 🌊 Backend mini-phase follow-up tickets (filed 2026-07-11)

### F-122 · Persist `topik_level` on `topik_attempts` for full D-1 level-pinning
- **Status:** 🔴 open · **Priority:** P3 · **Category:** BACKEND (DATABASE) · **Beta:** —
- **What:** F-104/S-1 threaded `topik_level` through the exam pick/serve/grade path so clicking a specific TOPIK I vs II paper serves the exact level. But `topik_attempts` has no `topik_level` column (migration 037 predates D-1), so the F-007 **resume** re-fetch still can't pin the level on an in-progress attempt. Add a `topik_level` column (migration) + thread it through resume to close the D-1 gap fully.

### F-123 · Exam-completion checkmarks keyed by `sourceTest` alone (same D-1 class)
- **Status:** 🔴 open · **Priority:** P3 · **Category:** UI (BACKEND) · **Beta:** —
- **What:** `ExamChooser`'s completed-checkmark set is keyed by `test_number` only, so a completed TOPIK II paper marks the same-numbered TOPIK I paper done (and vice-versa). Key the completed-set by `(test_number, topik_level)` once F-122 lands the level on attempt history.

### F-124 · `mapClaudeError` forwards `${code}: ${message}` to the client
- **Status:** ✅ done (beta-hardening push — shipped + deployed + live-DB-audit-verified 2026-07-15) · **Priority:** P4 · **Category:** BACKEND (SECURITY) · **Beta:** —
- **What:** The shared `mapClaudeError` forwards `${code}: ${message}` on both 4xx and 5xx paths. Safe today (every proxy error message is a fixed generic string), but a future non-generic message would leak to the client. Pre-existing, surfaced during the F-116 review. Harden to only forward a whitelisted/generic message.

### F-125 · `POST /conversation/:id/name` not exactly-once under concurrent first calls
- **Status:** ✅ done (beta-hardening push — shipped + deployed + live-DB-audit-verified 2026-07-15) · **Priority:** P4 · **Category:** BACKEND · **Beta:** —
- **What:** `routes/conversation.ts`'s `/name` route reads `title`, calls Claude only if it's `NULL`, then persists via `UPDATE ... WHERE title IS NULL`. Two requests arriving close together on the same never-named conversation (two open tabs, a reloaded component, etc.) can both pass the read-check and both burn a Claude call before either commits the UPDATE — storage never diverges (the UPDATE's `WHERE title IS NULL` guard means only one write wins) and the race can only happen ONCE per conversation (every later call short-circuits with no Claude spend), bounded further by the existing per-user `expensiveLimiter()`. Surfaced independently by both the Phase 3D client and server reviews (`docs/phase3d/REVIEW_chat_server.md` S-1) as a SHOULD-FIX, not a blocker. Pre-existing Phase 2 code; Phase 3D only wired the client to it.
- **Why deferred (not fixed in Phase 3D):** the two low-risk-looking fixes both carry real cost for a bounded, storage-safe race: (a) a sentinel/claim-first column (`UPDATE ... SET title = 'PENDING' WHERE title IS NULL`) is a schema change, and this repo's own gate requires migration/schema work to run the FULL client+server+db suite, not a targeted slice — out of scope for a fix-pass restricted to targeted verification; (b) a session-scoped Postgres advisory lock held across the Claude network round-trip needs careful client-checkout/release lifecycle management (a pattern with zero existing precedent or test coverage in this codebase) — introducing it under a fix-pass's targeted-test-only gate risks a subtler bug (a leaked/never-released lock or pooled connection) than the race it fixes. Recommend implementing whichever of the two the next full-suite-gated pass picks, with the full suite run per `feedback_fixpass_gates_run_full_suite.md`.

### F-126 · `set-km-app-password.sh` verification false-fails (aborts every deploy)
- **Status:** ✅ done (beta-hardening push — shipped + deployed + live-DB-audit-verified 2026-07-15) · **Priority:** P2 · **Category:** DEPLOY (CONFIG) · **Beta:** —
- **What:** `Deploy/set-km-app-password.sh`'s verify step runs `SELECT current_user || chr(58) || (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)` and string-compares the result to `'km_app:f'`. But `||`-concatenating a boolean casts it to text as **`'false'`**, not `'f'` (the `-tA` short form only applies to a bool *column*, not one concatenated into a string), so the check yields `'km_app:false'` and the script `return 1`s — even though km_app is correctly set up and authenticates. Hit live during the Wave-1 deploy (2026-07-11); worked around by continuing the runbook manually after confirming km_app auth by hand. **Fix:** compare against `'km_app:false'`, OR change the query to `... rolsuper::text = 'false'` / select the bool as a column. Every future deploy aborts at this step until fixed.

### F-127 · Global entry point (FAB) for the beta ticketing page
- **Status:** 🟢 done (shipped Wave 1) · **Priority:** P3 · **Category:** UI · **Beta:** —
- **What:** F-023's `/tickets` page currently has a single entry point — a "Beta feedback" tile in Settings. For beta testers to report from anywhere, add a more prominent global entry (a `ChatFab`-style floating button, mirroring `components/ChatFab.tsx`) that opens `/tickets`. The Settings tile stays as the canonical entry per the F-023 spec; this is discoverability polish. Referenced in `App.tsx` + `Settings.tsx` code comments.

---

## ✅ Backend mini-phase — light-up (F-104/F-106/F-110/F-111/F-116/F-117/F-118) — DONE, PR pending

Delivered on `feat/phase-be-lightup`, full 4-phase /fixpass PASS (0 blockers, security clean across all 4 surfaces, 9 should-fixes FIXED, 0 regressions; migrations 056+057 up/down verified in-container). Full suites: client 1500 · server 1240 (+4 skip) · db 63.
- **TOPIK:** F-104 ✅ (`GET /topik/attempts`) · F-118 ✅ (`GET /topik/tests`) → **F-078/F-079/F-082 now live** (real scores, chooser, previous-attempts; S-1 level-threading fixed). Residual: F-122/F-123.
- **Writing:** F-106 ✅ (`GET /writing/attempts`) → **F-074 live**; F-117 ✅ (migration 056 widens `writing_attempts` rubric to `free_write`; real free-write grader) → **B-027 rubric-widen closed**.
- **Grammar:** F-110 ✅ (`GET /grammar-drill/attempts`) → **F-065 live**; F-111 ✅ (FSRS schedule folded into `/grammar/bank`) → grammar mastery rows show real state/next-due.
- **Reading:** F-116 ✅ (migration 057 + `POST /reading/translate` Claude route, cached/low-temp) → **F-070 live** (real passage translation).
- **New tickets filed:** F-122 · F-123 · F-124.

---

## ✅ Phase 3D — Chat (final page group) — DONE, PR pending

Delivered on `feat/phase3d-chat`, full 4-phase /fixpass PASS (1 blocker + 5 should-fixes → re-review PASS, 0 regressions; attach-menu keyboard blocker mutation-verified dead). Full suites: client 1502 · server 1240 (+4 skip).
- **F-037 ✅** tutor replies now concise & conversational by default (system-prompt DEFAULT BREVITY / expand-only-on-request block; tutor domain behavior intact).
- **F-033 ✅** formatting overhaul (styles consolidated into co-located `Chat.css`).
- **F-034 ✅** in-chat dictionary + suggested-words removed (grep-clean across the whole client tree).
- **F-035 ✅** "+" attach menu (camera / upload-image / upload-document) — all three wired (document to the existing `POST /conversation/:id/file`), WAI-ARIA menu-button with roving arrow-key nav + Tab-close + Escape/outside-click, 409 stale-version handling on both upload paths; server-side file validation (size, real UTF-8 bytes, injection markers).
- **B-020 ✅** English toggle labeled ("English · 영어" + sharpened aria-label).
- **F-036 ✅** chats auto-named from content via the existing `name_conversation` route (latched per-conversation; title precedence session→server→snippet→date).
- **F-024** n/a (`/chat` has no nested route).
- **New ticket filed:** F-125 (`/name` route not exactly-once under concurrent first calls — bounded/storage-safe, deferred for a full-suite-gated pass).

---

## 🏁 Wave 1 pre-beta redesign — BUILD COMPLETE (PRs #91–#96)

All phases through the full 4-phase /fixpass: Phase 1 primitives · Phase 2 backend (045–055) · **3A** Today/Progress/Settings (#91) · **3B** Review/Library (#92) · **3C-1** flashcards/grammar/hanja (#93) · **3C-2** reading/listen/writing/topik (#94) · **backend light-up** (#95) · **3D** Chat (#96). Next: DEPLOY (blue/green to M, migrations 045–057 + km_app role) → friends beta.

---

## 🌃 Wave 2 — beta feedback: redesign + per-page polish (design-approved, build pending)

Source: friends beta-test feedback (Jared, Jul 2026). Two cross-cutting themes — a full visual redesign ("Seoul Day & Night") and mobile responsiveness — plus ~40 per-page changes. Design phase COMPLETE: identity locked in `DESIGN_SEOUL_DAY_NIGHT.md`; every page mocked at fidelity (artifacts: prototype, Learn ×2, final batch). Build proceeds page-by-page off `feat/redesign-foundation`, each reskinned to the locked design + its feature set, full-suite-gated + 4-phase /fixpass (design-fidelity reviewer added), deployed zero-downtime in batches.

### Cross-cutting

#### F-128 · Visual redesign — "Seoul Day & Night" identity
- **Status:** 🟡 design-approved, build in progress · **Priority:** P1 · **Category:** design
- **What:** App is "too plain." Full day↔night Seoul duality — `data-theme="light"` = Day Seoul (hanji, dancheong, daylight), `data-theme="dark"` = Night Seoul (neon). All 9 character devices: neon signboards / hanji cards, dancheong rail, 기와 roof texture, Namsan skyline header, subway-line progress, hangul watermark, seal stamps (印), rain-neon sheen, mother-of-pearl (자개). Accent picker orthogonal (works both worlds). WCAG AA both, reduced-motion, mobile-first.
- **Contract:** `DESIGN_SEOUL_DAY_NIGHT.md` (authoritative). Components: `SkylineHeader`, `SubwayProgress`, `SealStamp`, `DancheongRail`, `CityCard` + utilities `.km-rain-sheen`/`.km-najeon`/`.km-hangul-watermark`/`.km-giwa`. Retheme shared primitives.
- **Key files:** `client/src/styles/index.css` (tokens), new `client/src/components/*`, `client/src/hooks/accent-context.ts`.

#### F-129 · Mobile responsiveness — horizontal overflow
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P1 · **Category:** bug/mobile
- **Where:** Content clips off-screen-right on **Progress, Vocab, Grammar** (and audit all pages). Body must never scroll sideways; wide content gets its own `overflow-x:auto`.
- **Fix hint:** mobile-first; relative units; `max-width:100%`; flex/grid + gap not fixed widths.

#### F-130 · Mobile touch-swipe broken
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P1 · **Category:** bug/mobile
- **Where:** Carousels + PDF viewer — swipe gestures don't register on touch. `components/SwipeCarousel.tsx` + PDF viewer (Uploads).

#### F-131 · Accent-color hover states
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** bug
- **Where:** Hover/active states are hardcoded red regardless of chosen accent; must follow `data-accent` (coral/blue/mint).

#### F-132 · Auto-theme by time of day
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P3 · **Category:** feature
- **What:** Optionally auto-switch Day/Night Seoul by local time (noted in `DESIGN_SEOUL_DAY_NIGHT.md`). Manual override always wins.

### Today

#### F-133 · Tighten layout / reduce white space
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** design · **Key files:** `pages/Today.tsx`

#### F-134 · Writing tile expands inline (not separate page)
- **Status:** 🔴 open (Writing inline-expand was reverted to a deep-link to /learn/writing — sole criterion unmet; re-verified 2026-07-15) · **Priority:** P2 · **Category:** feature · **Where:** Today writing tile should open its content in-place, not navigate away.

#### F-135 · Tasks-title IA cleanup
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** design · **Where:** the tasks section heading/hierarchy on Today.

#### F-136 · Suggested learning = R/W/L/TOPIK + daily reading rotation
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature · **What:** Suggested-learning covers Reading/Writing/Listening/TOPIK, with the reading suggestion rotating daily.

#### F-137 · TOPIK progress bar — no highlights
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P3 · **Category:** design · **Where:** remove the highlight styling on the Today TOPIK progress bar.

#### F-138 · Per-tile daily progress bars tied to real daily exercises
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature · **What:** Each tile's progress bar reflects that day's actual completed exercises, not landing-page visits.

#### F-139 · Remove "words" tile
- **Status:** ✅ done — SUPERSEDED (2026-07-15, user call: the removal was a misinterpretation; F-190 correctly restored the vocab tile as a first-class Today action — that IS the desired end state) · **Priority:** P2 · **Category:** design · **Where:** drop the words section/tile from Today.

#### F-140 · Hanja tile in the Today carousel
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature · **Where:** add Hanja into the Today activity carousel.

### Progress

#### F-141 · Everything collapsible (TOPIK-compares default open)
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature · **Key files:** `pages/Progress.tsx`, `components/CollapsibleTile.tsx`

#### F-142 · Better trend + data points on all graphs
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature · **What:** richer trendlines and visible data points across every Progress chart.

#### F-143 · Remove "begin today's plan" + "gaps / next steps"
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** design · **Where:** drop those two blocks from Progress.

### Library — Vocab

#### F-144 · Remove leftover grammar UI from Vocab
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P1 · **Category:** bug · **Where:** F-047 removed WeeklySuggestions grammar but leftover `km-grammar__*` UI persists in Vocab ("WHY IS GRAMMAR IN HERE"). Grammar belongs only under Library→Grammar.

#### F-145 · Vocab mobile responsiveness
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P1 · **Category:** bug/mobile · (see F-129)

#### F-146 · Collapsible My Lists
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature

#### F-147 · Create-list popup (vocab-only)
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature · **What:** create-list is a popup, scoped to vocab.

#### F-148 · This-Week popup
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature

#### F-149 · "Search for a word" label
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P3 · **Category:** design · **Where:** label the Vocab search field.

#### F-150 · No grammar in All Words dictionary
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** bug · **Where:** All-Words dictionary must exclude grammar entries.

#### F-151 · More genres
- **Status:** 🔴 open · **Priority:** P2 · **Category:** feature · **Where:** expand the genre set in Vocab.

### Library — Grammar

#### F-152 · Bank/banked → Mastered button + label
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** bug · **Where:** F-063 reworked the model but "Bank/banked" labels persist; replace with a Mastered button + mastery labeling.

#### F-153 · 15-at-a-time
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature · **Where:** paginate grammar list 15 at a time (`usePagination`).

### Library — Mistakes

#### F-154 · Square question-tiles, date-divided, click→popup
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature · **What:** small square question-number tiles in a grid, divided by session/date; tap → popup with the question, your answer, jump-to-explanation.

### Library — Uploads

#### F-155 · PDF mobile swipe
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P1 · **Category:** bug/mobile · (paired with F-130) — swipe/arrow page-turn on the PDF viewer must work on touch.

### Flashcards

#### F-156 · Add-to-review = 15, not 200
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** bug · **Where:** "add to review" batches 15, not 200.

#### F-157 · Create-list popup (flashcards)
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature

### Grammar practice

#### F-158 · Pick a form to drill continuously
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature · **What:** choose a single grammar form and drill it continuously (form-picker → endless drill).

### TOPIK

#### F-159 · Study/Mock chooser popup (semi-transparent)
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature · **Where:** entering TOPIK shows a semi-transparent Study-vs-Mock chooser popup.

### Listen

#### F-160 · TTMIK / iyagi missing audio
- **Status:** 🟡 partial (F-185 season-numbering fix shipped + tested, loader not re-run on live km-db; episodes #119/#236/#240 transcript gap) · **Priority:** P1 · **Category:** bug · **Where:** audio not playing for TTMIK + iyagi sources.

#### F-161 · "Next page" not show-15
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature · **Where:** Listen list uses next-page pagination instead of a show-15/expand.

#### F-162 · Preserve scroll on back
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** bug · **Where:** returning to the Listen list restores scroll position.

### Writing

#### F-163 · AI Prompt as top-level option
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature · **Where:** surface "AI Prompt" as a top-level Writing choice.

### Hanja

#### F-164 · Spacing
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P3 · **Category:** design · **Key files:** `pages/Hanja.tsx`

#### F-165 · Drawing-drill anki right/wrong loop → mastery pool
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature · **What:** drawing drill runs an Anki-style right/wrong loop feeding a mastery pool.

#### F-166 · Create-list popup + Add-hanja picker
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature

#### F-167 · Index tiles colored by mastery (green/yellow/red)
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature · **Where:** Hanja index tiles colored by mastery state.

#### F-168 · Index "+"-to-list popup + "added to list" toast
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature

#### F-169 · Index shows hangul sound, not the word
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** bug · **Where:** index tile label shows the hangul reading/sound, not the gloss word.

#### F-170 · Live progress bar (Hanja)
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature

---

## 🔎 Wave 2 follow-ups — surfaced by the Today+Progress fix-pass

Filed from the batch-1 /fixpass (Today+Progress). Each is an honest data/infra gap the pages currently handle by omitting rather than fabricating.

#### F-171 · Hanja daily-attempt signal
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature/backend
- **Where / State:** `services/hanja.ts` exposes only lifetime aggregate bands (`HanjaProgress`) — no per-attempt/per-day log. So Today's Hanja tile (F-140) can't show a real "done today" count like Grammar/Writing/TOPIK do (F-138). Needs a per-attempt Hanja history endpoint (mirror `/grammar-drill/attempts`).

#### F-172 · Reading/Listening daily-attempt signal
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature/backend
- **Where / State:** No attempt-history endpoint exists for Reading (`services/reading.ts`) or Listening (`services/ttmik.ts`), so Today's Reading/Listening suggestions (F-136) can't show a real per-day completion count. Add attempt logging + a history endpoint for each.

#### F-173 · Resumed-TOPIK item-count for SubwayProgress
- **Status:** ✅ done (beta-hardening push — shipped + deployed + live-DB-audit-verified 2026-07-15) · **Priority:** P3 · **Category:** feature
- **Where / State:** `AttemptState` carries `answered` but no item-count total, and `sourceTest` alone is ambiguous between TOPIK I/II. A real `SubwayProgress` for a resumed exam on Today needs a total (item count) wired through `/plan/today` or `/topik/attempt`, or a safe `sourceTest`+`topikLevel`→itemCount lookup.

#### F-174 · Shared LineChart trend-line prop for Progress skill carousel
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P3 · **Category:** feature
- **Where / State:** F-142 added the least-squares trend line only to Progress's own `TrendChart`. The 5 skill-carousel charts render via the shared `components/LineChart.tsx` (already shows dots+line+area). Add an optional trend-line/regression prop to `LineChart` so the skill charts get F-142 parity. Shared component — was out of scope for the batch's page-only builders.

---

## 🔎 Wave 2 follow-ups — surfaced by the Library fix-pass

Filed from the batch-2 /fixpass (Library). Two need server work (client display is already honest); one is a consistency migration.

#### F-175 · Dictionary grammar-exclusion: server-side WHERE clause for exact pager
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P3 · **Category:** bug/backend
- **Where / State:** F-150 excludes grammar POS rows (`어미`/`조사`) client-side, so no grammar ever renders — but the server's `total`/page range is computed BEFORE the exclusion, so a grammar-heavy page can render short and the "N–M of T" count can be slightly off. Add `WHERE part_of_speech NOT IN ('어미','조사')` to the dictionary query in `server/src/routes/krdict.ts` (sole consumer — safe surgical change) so pager counts are exact.

#### F-176 · Vocab genre/theme filter — promote `theme` to a filterable facet (was F-151)
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** feature/backend
- **Where / State:** F-151 "more genres" can't be done client-side — `content_domain` is a real 3-value Postgres enum (`general`/`research`/`business`). The richer signal is `vocab_entries.theme` (~30 real per-book categories, ~3,000 tagged rows) but `GET /vocab/entries` has no `theme` filter param. Add `theme` as a filterable facet in `server/src/routes/vocab.ts` + `lib/libraryFilters.ts` (shared with the Grammar pages), then surface it in the Vocab genre filter.

#### F-177 · Migrate Today + Progress headers to shared PageHubHeader
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P3 · **Category:** refactor
- **Where / State:** The batch-2 fixpass extracted the hub-header recipe (SkylineHeader title slot + DancheongRail divider) into shared `components/PageHubHeader.tsx`, adopted on all 7 Library pages. Today.tsx + Progress.tsx still use their own inline copy of the recipe — migrate them to `PageHubHeader` so the header lives in exactly one place and can't drift.

---

## 🔎 Wave 2 follow-ups — surfaced by the LEARN batch A fix-pass

Filed from the batch-3 /fixpass (Flashcards/Grammar-practice/Hanja/Reading). All low-priority polish/test-coverage; none block anything.

#### F-178 · Adopt shared `ochre` tone on Today's Hanja tile
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P3 · **Category:** refactor
- **Where / State:** Batch-3 added a shared `ochre` value to the CityCard/SubwayProgress/DancheongRail `tone` enum and adopted it on the Hanja page. Today.tsx's Hanja tile still uses the `plain` fallback (the pre-`ochre` workaround). Migrate it to `tone="ochre"` — fold into F-177 (Today/Progress header migration) if convenient.

#### F-179 · SwipeCarousel `onChange`/settled-index prop (+ document F-130 on Flashcards)
- **Status:** 🔴 open · **Priority:** P4 · **Category:** feature
- **Where / State:** Swipe-to-advance on the Flashcards study card can't be built because shared `SwipeCarousel` exposes no `onChange`/settled-index prop (a parent can't observe a swipe settling). Low priority — F-130's real targets (carousels + PDF) already work; flashcard-swipe was self-invented scope, the mock never asked for it. If ever wanted, add the prop. Also add a one-line doc comment near `StudySession` in `Review.tsx` noting why flashcards don't swipe-advance.

#### F-180 · Hanja StateChip "Practicing" tone mismatch (vermilion vs ochre)
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P3 · **Category:** bug/design
- **Where / State:** `Hanja.tsx:721-726` — the "Practicing" `StateChip` still reads `tone="vermilion"` (accent-tracking) while the index grid two paragraphs below now reads the fixed `--ochre-ink` (from the B2 AA fix). So the same "Practicing" concept shows two different colors on one page. Point the chip at the same mastery token as the grid.

#### F-181 · Hanja `masteredCount` label imprecision on no-op reconfirmation
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P4 · **Category:** bug
- **Where / State:** `Hanja.tsx:2482-2492,2639` — a right answer on an already-mastered character still increments the displayed "N of M mastered" copy on a no-op reconfirmation (the underlying state write is correctly a no-op; only the label is imprecise).

#### F-182 · Hanja `promoteState` no-op branch test coverage
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P4 · **Category:** test
- **Where / State:** the `promoteState` no-change guard (right answer on an already-banked/mastered char = no write) has no test in `Hanja.test.tsx`. Add one so a regression that double-writes or mis-promotes would be caught.

---

## 🔎 Wave 2 follow-ups — surfaced by the LEARN batch B fix-pass (capstone)

The final page-rework batch's fixpass found the app is "one batch + two files from truly one app," plus the real fix for the Listen audio.

#### F-183 · Reskin MockMode.tsx (TOPIK timed-exam body) to Seoul
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** design
- **Where / State:** `MockMode.tsx` (the TOPIK timed-exam flow) is still on the legacy flat look but is reached straight from batch B's new Study/Mock chooser Sheet — the app's most jarring flat→Seoul seam mid-flow. Reskin it to the shared kit (PageHubHeader/CityCard/tokens) to match Topik.tsx.

#### F-184 · Reskin Images.tsx — last legacy flat Topbar page
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P3 · **Category:** design
- **Where / State:** `Images.tsx` is the last page in the app still using the legacy flat `Topbar` instead of the shared `PageHubHeader` + Seoul kit. Bring it onto the shared header + character devices so every page is uniform.

#### F-185 · Backend/ingest: Listen (TTMIK/Iyagi) audio coverage — Iyagi season-numbering bug (RE-SCOPED, partially fixed) [F-160 real fix]
- **Status:** 🟡 in progress (code fixed + tested; live-DB backfill still needed) · **Priority:** P1 · **Category:** bug/backend
- **Original premise was stale/wrong, and also understated the real bug.** Re-verified against the live corpus + `km-db` on 2026-07-14:
  1. **`-N` filename-suffix regex — NOT a bug, already fixed.** `_LESSON_RE`/`_IYAGI_RE` already contain `(?:-\d+)?` (added in commit `a508ba0`, "F-012 fixpass: ... loader -N suffix"). All 3 originally-named files (TTMIK lesson (3,17), (5,20), Iyagi ep 67) parse correctly today. Lessons (3,17) and (5,20) already have `audio_path` populated. Close this sub-item — nothing to do.
  2. **TTMIK level 9 (10/14 lessons missing) — genuine content gap, not a bug.** Verified: the corpus (`~/data/korean-master/corpus/TTMIK/Lessons/Lesson 9/`) contains only 4 mp3s (lessons 1-4); lessons 5-14 were never acquired into this corpus. No code fix possible or needed — this is a content-acquisition task (source the missing level-9 audio, or accept as a known gap), not an ingest bug.
  3. **Iyagi "48/139 episodes missing" (incl. ep 67) — was a REAL mapping bug in `load_ttmik_audio.py`, now fixed.** The on-disk Iyagi mp3s are numbered with a LOCAL sequential scheme (1..146) that does **not** match `iyagi_episodes.episode_number`, which carries TTMIK's real season-block site numbering (season 1: 1-50 unchanged; season 2: 101-150; season 3: 201-246). Proven by decoding each mp3's embedded ID3 lyrics (`USLT`) and matching the Korean transcript text against the `iyagi_*.json` source: local file "51" (혈액형 topic) is the same content as `episode_number=101`; local "67" (SNS/소셜 topic) == `episode_number=117`; confirmed at 10 points spanning both season boundaries (all off by exactly +50 or +100, a clean 2-breakpoint step function). **This was not merely "some files don't map" — before the fix, the loader silently wrote WRONG audio onto 46 real rows**: local season-3 files (101-146, real content is episodes 201-246) numerically collided with DB rows 101-146 (whose real content is the season-2 topics) and overwrote their `audio_path`, while the true season-2 audio (local 51-100) and true season-3 audio never matched anything. Confirmed live in `km-db`: `episode_number=101` (혈액형 topic) was serving `101 TTMIK Iyagi 101.mp3`, which is actually the 쇼핑/shopping episode (real content of episode_number 201). **Fixed** in `tools/ingest/loaders/load_ttmik_audio.py` (`_resolve_iyagi_episode_number`, season-block offset applied before the DB key lookup) with unit tests (`tools/ingest/tests/test_load_ttmik_audio.py`) covering both boundaries and the corrected ep-67→117 / ep-143→243 mappings. All 30 tests in that file pass (pure + testcontainer-integration tiers).
- **Residual, genuine content-ingestion gap (3 episodes) — needs a transcript backfill, not a loader change:** after the season-offset fix is deployed and the loader re-run, audio exists for every local file but the transcript source JSON (`tools/ingest/output/iyagi_*.json`, consumed by `load_iyagi.py`) never extracted a unit for real `episode_number` **119** (audio present as local file 69, no `iyagi_episodes` row exists to attach it to), **236** (local file 136), or **240** (local file 140). These 3 have real, already-corpus-present audio with no transcript/DB row — a content-ingestion gap in the original Iyagi transcript extraction, not something `load_ttmik_audio.py` can create (it only UPDATEs existing rows). Follow-up: source/extract transcripts for TTMIK Iyagi episodes #119, #236, #240 (or accept the gap) and add rows via `load_iyagi.py`; the existing (fixed) audio loader will then attach their audio automatically on next run, no further code change.
- **Deploy runbook (not yet run against live `km-db` — do NOT hand-apply, this is a loader re-run not a migration):** once this code change ships to a color via the normal deploy pipeline, re-run `python -m loaders.load_ttmik_audio` (or whatever the project's `load-corpora.sh` entry point is) against the corpus root (`~/data/korean-master/corpus/` on this machine / the container's configured `CORPUS_AUDIO_DIR`) exactly as documented in `load_ttmik_audio.py`'s own IDEMPOTENCY note — single transaction, safe to re-run, corrects the 46 mis-mapped rows and populates the 48 previously-null rows (minus the 3 real content gaps above, which will remain in `files_without_row`/null as expected).

---

## 🔎 Wave 2 follow-up — surfaced by the cleanup fix-pass

#### F-186 · Migrate WordPopover.tsx to the shared tone-aware Sheet
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P3 · **Category:** refactor · post-beta
- **Where / State:** `components/WordPopover.tsx` (the app's most-used popup — Reading/Grammar/Hanja/Listen/Images all consume it) still renders bespoke `role="dialog"` chrome instead of the now-tone-aware shared `Sheet`. It already has full a11y parity (focus trap, Esc/backdrop, restore-focus). Migrating it is the last "promote to shared primitive" of the redesign — a cross-page refactor, so deferred post-beta.

---

## 📱 Phone round 4 — live beta feedback (filed 2026-07-14)

### B-036 · Settings → Appearance text-size (S / M / L) does nothing
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** bug · regression
- **Where:** Settings → Appearance → text size control. Selecting Small / Medium / Large has no visible effect on the app's type scale. This is the F-025 Phase-1 primitive (global text-size setting) — built and gate-green, but not actually resizing anything on device.
- **Root cause (suspect):** the documented px→rem limitation — the root `[data-text-size]` font-size scales only `rem`-based type, but most of the app's text uses hardcoded `km-*` px font-sizes that don't respond to the root scale. So the S/M/L control changes `--?`/root font-size but the visible copy is pinned in px. (Was flagged as a known limitation → F-086 px→rem sweep.) Verify the control is even writing the attribute + persisting the pref, THEN address the px→rem coverage so the setting produces a real, obvious size change.
- **Key files:** `hooks/TextSizeProvider.tsx`, `lib/text-size-presets.ts`, `client/index.html` (data-text-size bootstrap), `client/src/styles/index.css` (`[data-text-size]` root font-size), `pages/Settings.tsx`; the px-based `km-*` font-size declarations across component CSS (F-086 sweep).
- **Fix hint:** confirm the two-way pref sync works (attribute set + persisted + rehydrated), then convert the dominant px font-sizes to `rem` (or a `clamp()`/scale token driven by the root) so M→L is unmistakable. Ship with a real on-device size delta, not just an attribute flip.

### F-187 · Today — excess vertical gap between "Suggested Learning" and "TOPIK"
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** ui-polish
- **Where / State:** Today page still has way too much whitespace between the Suggested-Learning carousel section and the TOPIK section. (Earlier spacing pass tightened it but not enough.)
- **Key files:** `pages/Today.tsx`, `pages/Today.css` (section gap / carousel bottom margin between the Suggested-Learning block and the TOPIK block).
- **Fix hint:** reduce the inter-section gap specifically at that boundary; verify on a real phone viewport, not just jsdom.

### F-188 · Today — stray small blue line above-and-left of "Review & Drills"
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P3 · **Category:** ui-polish
- **Where / State:** a small blue line/rule appears just above and to the left of the "Review & Drills" section header on Today. Looks unintentional (leftover rail/divider/accent decoration). Remove it.
- **Key files:** `pages/Today.tsx` / `pages/Today.css` (section-header decoration — likely a DancheongRail/SubwayProgress accent stub, a `::before`, or a stray hub-header rail on that block).
- **Fix hint:** identify the element rendering the blue line and remove it (or the CSS rule); confirm nothing else depended on it.

### F-189 · Distinct per-skill highlight colors — shared across Today tiles AND the LEARN honeycomb
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** design-system · cross-cutting
- **Where / State:** The six skill surfaces — **Vocab, Grammar, Hanja, Reading, Listening, Writing** — currently share too-similar highlight colors (lots of blue, and the greens are barely distinguishable). Give EACH skill its own clearly-distinct highlight color. The SAME color must be used for a given skill in BOTH places: the Today-page tiles AND the LEARN launcher honeycombs (each hexagon its own color). One skill→color map, consumed by both surfaces, so a skill reads as the same color everywhere.
- **Key files:** a new/central per-skill color token map in `client/src/styles/index.css` (or a `skill-colors` module); Today tile components (`pages/Today.tsx` + CSS, `CityCard`/tile highlight); the LEARN hexagon launcher (honeycomb component + CSS). Must respect both themes (Day/Night) and stay WCAG-AA.
- **Fix hint:** define one canonical `--skill-<name>` accent set (6 visually-separated hues, AA-checked in light + dark), then wire both the Today tiles and the LEARN honeycombs to it. No hardcoded per-surface hex — single source of truth.

### F-190 · Center the default carousel card — Review & Drills → Vocab, Suggested Learning → Reading
- **Status:** ✅ done (verified — adversarial reconciliation 2026-07-15) · **Priority:** P2 · **Category:** ui-polish
- **Where / State:** On landing on Today, both swipeable carousels should open centered on a specific middle card, not the first card:
  - **Review & Drills:** put **Vocab** in the middle and make it the default centered/landing card.
  - **Suggested Learning:** put **Reading** in the middle and make it the default centered/landing card.
- **Key files:** `pages/Today.tsx` (carousel item ordering + initial index/scroll position), the peek-slider carousel (`.km-today__peekTrack` / SwipeCarousel initial-index prop), `pages/Today.css`.
- **Fix hint:** reorder each carousel so the named skill sits in the center slot, and set the carousel's initial scroll/active index to that center card on mount (respect scroll-snap-align: center). Verify on a real phone.

### F-191 · TOPIK's own page + mock mode carried the old accent/blue chrome (not its new stone hue)
- **Status:** ✅ done (folded into the round-4 batch) · **Priority:** P3 · **Category:** design-system consistency
- **Where / State:** After F-189 gave TOPIK its dedicated `stone` tone (tile + LEARN honeycomb), `pages/Topik.tsx` (×9) and `pages/topik/MockMode.tsx` (×6) still hardcoded `tone="accent"`/`tone="blue"` on their CityCard/Sheet chrome — so the TOPIK tile read stone but the TOPIK page read blue (a "one skill, two colors" split). Surfaced by the round-4 re-review.
- **Resolution:** all 15 TOPIK-identity sites migrated to `SKILL_COLOR.topik.tone`; `sectionTone()` (reading/listening/writing exam-section differentiation) deliberately left (different axis). Also retuned TOPIK's Night hue #A69FBC → #DAD6ED ("white neon") to fit the Seoul-nightlife Night aesthetic while staying achromatic/distinct (min ΔE76 40.6, AA 12.08:1). Commit `b402008` on `feat/phone-round4`.
- **Follow-up (non-blocking):** re-review suggested adding the `feat` prop to StartPage's exam-meta card so its pending-attempts pairing keeps the same hero/secondary weight the ExamChooser pair has (it now relies on stacking/headings alone). Minor polish — not shipped in this batch.

---

## 🌊 Phase B2a follow-up tickets (filed 2026-07-15)

### F-194 · 064's down-migration can't distinguish "backfilled" from "a real pre-064 row that happens to match the shape"
- **Status:** 🔴 open · **Priority:** P3 · **Category:** DATABASE · **Beta:** —
- **What:** `db/migrations/064_backfill_notification_schedules_from_prefs.down.sql`'s DELETE guards on `created_at = updated_at` (never edited since insert) to avoid removing a user's genuine post-backfill edit, but that guard cannot distinguish "this row was INSERTed by the 064 backfill" from "this row was INSERTed by a real, single `PUT /notifications/schedules` call that happened to land on the exact same kind/channel/blob-intent combination and was never touched again" — the latter is plausible, not hypothetical, since the `/notifications/schedules` route already ships in prod.
- **Fix hint:** have 064's up-migration tag exactly the rows it inserts (e.g. a transient marker column, or a side-table log of the affected `(user_id, kind)` pairs) so the down can target precisely what it created instead of re-deriving the predicate.
- **Notes:** Surfaced by the B2a /fixpass re-review (R1 SHOULD-FIX 1). Deliberately NOT implemented in Phase B2a — the down path is rollback-only (gated behind `--allow-destructive`, never part of the forward deploy path), and the imprecision is documented in-file (see the down-migration's own header). A stronger fix is a real but bounded schema change (either an added column or a side-table), out of scope for an expand-only batch. Tracked here so it isn't silently re-forgotten.

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
