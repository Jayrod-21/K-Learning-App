# REVIEW — Phase 3C-1 flashcards slice (Review.tsx family + F-061 receiving side)

Reviewer: independent senior review, 2026-07-10. Report-only; no code modified.
Scope: `client/src/pages/Review.tsx` / `.css` / `.test.tsx`; `client/src/pages/review/ReviewVocab.tsx` / `.css` / `.test.tsx`; + cross-surface mastery skim of `Grammar.tsx` / `Hanja.tsx`.
Diff basis: `feat/phase3c1-cards` vs `rebuild`. Scratch keyboard-repro test created + run + DELETED (`__reviewer_scratch__.test.tsx`, 2/2 confirmed hypotheses); tree left clean.

## Verdict

**FAIL — 2 BLOCKERS (both keyboard-a11y on the study session), 6 SHOULD-FIX, 8 NIT.**
Work is otherwise strong: every ticket (F-060/F-061/F-062/B-021/B-022/B-023/F-024 + FSRS wiring) is functionally delivered with real, non-tautological tests. Both blockers share one root family (key events from interactive descendants treated as flip gestures) and are small, surgical fixes.

## Bar checklist

| Bar | Result |
|---|---|
| WCAG AA | **FAIL** — B-022 drawer toggle/close not keyboard-operable; Space on rating button drops the rating (BLOCKER-1/2) |
| Correct ARIA | Mostly ✅ (role=group ratings, role=alert errors, aria-expanded, aria-pressed edit toggle). ❌ nested interactive controls inside `Flashcard`'s `role="button"`; progressbar unnamed (SF-4) |
| Strict TS at I/O boundaries | ✅ `parseListIdParam` (Review.tsx:237-241), `toAddToListTarget` structural validation of router state (ReviewVocab.tsx:144-159), typed services, BIGINT coercion in vocab.ts |
| No swallowed errors | Mostly ✅ (abortable list-detail + define fetches, ErrorCard+Retry, fixed copy). ❌ drawer fetch failure masked as "No additional examples" (SF-2); no recourse for failed rating saves (SF-5) |
| Tests exercise real behavior | ✅ — B-021 pins per-button DOM labels; B-022 exercises all 3 close paths; 409/rollback/round-trip tests assert observable outcomes + absence of server prose. Gaps: NIT-1 |
| Co-located CSS | ✅ Review.css new-rules-only w/ documented scoped overrides; ReviewVocab.css layout-only |
| No scope creep | ✅ diff confined to ticket surfaces; ReviewVocab delta is exactly the F-061 receiving side |
| No console.log / no TODO w/o ticket | ✅ (F-107, F-065-B, B-034 all ticketed) |

## Ticket checks

- **F-060 lists-first landing — PASS.** Session part + All Cards gone (test Review.test.tsx:291-307 asserts no tabs / no banked-vocab search). Landing = create-list card (wired `POST /vocab/lists` via `vocabService.createList`, payload pinned at test:366-371) + all lists + due strip below lists + collapsed B-013 seed tile. List opens to words w/ Study at TOP (Review.tsx:1184-1195; test:415-433).
- **F-061 edit-lists — PASS.** Rename (PATCH w/ name_en null-clear contract, Review.tsx:1057-1061), remove-words optimistic+rollback (1071-1104, rollback test:494-513), add-words → `/review/vocab` w/ `location.state.addToList={id,name}` (544-551; state pinned test:515-529). Receiving side: structural guard ReviewVocab.tsx:144-159 (malformed-state test:769-778), add-mode banner + return leg (:187-207, test:760-767), direct add to the ORIGINALLY-open list (:378-399, test:721-742), 409 = "Already in <list>" info toast (:386-388, test:744-758). Round-trip closes: return nav remounts Review → fresh `getListDetail`.
- **F-062 completion — PASS.** Count, 4-cell breakdown, next-due buckets from server `scheduled_days` (0/1/2+), pending-saves gate, failed-saves alert, local-fixture honesty line (Review.tsx:1745-1869; tests:739-853).
- **B-021 VERIFY — PASS on this page.** `RATINGS` subs `<1m / 6m / 1d / 4d` (Review.tsx:1298-1303) match the RETUNED engine exactly: `RELEARN_DELAY_MS=50*1000`, `HARD_STEP_DELAY_MS=6*60*1000`, `BASE_STABILITY {good:1, easy:4}` (server/src/services/fsrs.ts:94,106,151-155 — verified on this branch). Test pins the DISPLAYED labels per button via `within(btn).getByText(sub)` (Review.test.tsx:537-558) — real DOM assertion, not a tautology. ⚠️ NOT mirrored on grammar/hanja — see cross-surface.
- **B-022 drawer — PARTIAL.** Expand-underneath: legacy `.km-flashcard__face{position:absolute;inset:0}` (styles/index.css:2223-2233) overridden by grid-stack (`Review.css:28-35`, specificity 0,2,0 > 0,1,0 — verified); back face grows in flow → rating row pushed down. Geometry is CSS-inspection-only (happy-dom can't assert layout) — acceptable, well-commented. Close button ✅, page-tap close ✅, flip close+reset ✅ (tests:691-731, all behavioral). **BUT the toggle/close buttons are not keyboard-operable — BLOCKER-1.**
- **B-023 geometry — PASS.** Legacy outer 4px radius + square `--ink-2` face content confirmed (styles/index.css:2213, 3238-3263); fix = one radius (`--radius-lg`) + `overflow:hidden` clip, scoped `.km-review` (Review.css:14-19). No shared-file edit.
- **FSRS wiring — PASS.** Due cards: `POST /vocab/cards/:id/reviews` w/ `{rating, expected_version}` only via `buildReviewSubmission` (version threading, D-B1); list cards: idempotent `bankEntry` → review against the fresh version snapshot (Review.tsx:1449-1466; tests:560-609). 409-aware: counted `failedSaves`, fixed copy, no server prose (test:789-806). Abort-on-unmount: review WRITES deliberately not aborted (aborting a rating POST would lose the write; header doc line 55 scopes abort to raw READS — list detail + KRDICT, both verified abortable). Deviation from the letter of the check, sound engineering; post-unmount setState on a settled save is benign in React 18/19.
- **F-024 BackButton — PASS.** Due-study → `/learn/vocab` (:573), list-study → list detail (:597-598), list detail → landing (:619); ReviewVocab → `/review` (:175). All explicit `to`.

## Findings — BLOCKER

**BLOCKER-1 · B-022 drawer toggle + close button unusable by keyboard (WCAG 2.1.1).**
`Flashcard`'s outer `role="button"` `onKeyDown` (components/Flashcard.tsx:55-60) has no `e.target === e.currentTarget` guard, so Enter/Space originating on ANY control inside the card bubbles up, `preventDefault()`s the button's own activation, and flips the card. Empirically verified (scratch test, deleted): focus "More examples" → Enter → card flips to FRONT, back face unmounts, drawer NEVER opens, toggle gone. Same for "Close examples". Since the whole answer face lives inside the flip button, the B-022 acceptance controls this phase ADDED (Review.tsx:1627-1663) are mouse/touch-only. Also an ARIA violation: interactive descendants inside `role="button"` (front "Reveal" button, drawer toggle, drawer close). Fix direction (fix-pass): target-guard the Flashcard key handler (`if (e.target !== e.currentTarget) return;`) — one line, front "Reveal" button keeps working since its click path is unaffected — + add keyboard regression tests (Enter and Space on toggle + close). Flashcard.tsx is outside this slice's diff but the regression surface (the buttons) is in it; coordinate with whoever owns components/.

**BLOCKER-2 · Space on a rating button flips the card and DROPS the rating.**
Session-level window keydown (Review.tsx:1404-1417) exempts only `INPUT`/`TEXTAREA`; focus "Good" → Space → `preventDefault()` cancels the button activation, `flip()` un-flips the card — no rating registered, ratings row hidden. Empirically verified (scratch test, deleted). Keyboard users routinely activate buttons with Space; this silently eats reviews on the core FSRS surface. Pattern is carried over verbatim from rebuild (rebuild Review.tsx:506-510) — pre-existing root cause, but the entire session UI is this phase's deliverable and the fix is one condition: also bail when `document.activeElement` is a BUTTON (or `closest('button, [role="button"], select, [contenteditable]')`). Add a keyboard test that rates via Enter AND asserts Space-on-button doesn't flip.

## Findings — SHOULD-FIX

**SF-1 · Concurrent entry removals can corrupt the optimistic rollback.** Review.tsx:1071-1104 — only the clicked row's button disables (`removingId` is a single id, :1262), other rows stay clickable. Remove A then quickly remove B: A's failure rollback overwrites `entries` with its stale `prevEntries` snapshot (still containing B) and restores its stale `prevCount` → resurrects a server-deleted row / wrong header count. Disable all remove buttons while `removingId !== null`, or make rollback re-insert only its own row.

**SF-2 · Drawer fetch failure masquerades as "No additional examples."** Review.tsx:1385-1394 — non-abort `defineEntry` failure sets `krdictExamples=[]` → UI states a fact ("no examples") the client doesn't know. Bar says real error + retry: render "Couldn't load examples — try again" w/ retry (re-call `openDrawer`).

**SF-3 · Lists >100 entries silently truncate detail view AND study deck.** `getListDetail` is called w/ default `entry_limit=100` (services/vocab.ts:329-345; server default 100, max 500, and server has NO list-size cap — routes/vocabLists.ts:191-192 caps only per-call seeds at 200). `usePagination max:100` (Review.tsx:1030-1033) + no entry paging → words 101+ invisible and never studied while the header proudly shows the full `entry_count`. The comment ":1028-1030 'so long lists stay fully reachable'" is only true ≤100. Single-user app, low likelihood — but silent data omission on a study surface. Either page the entries or state the truncation ("Showing first 100").

**SF-4 · Progressbar has no accessible name.** Review.tsx:1564-1570 — `role="progressbar"` carries value attrs but no name; the wrapper div's `aria-label="Session progress"` (:1558) does nothing without a role. Move the label onto the progressbar element (WCAG 4.1.2).

**SF-5 · No recourse for failed rating saves.** Completion page reports "N ratings couldn't be saved" (Review.tsx:1840-1846) — honest, but the only options are Study again (re-rates everything) or Done (ratings lost). A retry-failed-saves affordance (re-POST the failed {card,rating} pairs) or at minimum a ticket. Fine to ticket-and-defer; flagging so it's a decision, not an accident.

**SF-6 · Cross-surface interval copy is NOT mirrored (see section below).** Vocab pins engine-true `<1m/6m/1d/4d`; hanja omits interval subs behind a now-false comment; grammar prints an engine-false "~10 minutes". Details + ownership below.

## Findings — NIT

- **N-1** `dueCardToStudyCard` fallbacks untested — `kr: d.vocabKorean ?? d.face` and missing-english paths (Review.tsx:138-148) never exercised; `DUE_STUDY` fixture is hand-built (test:228-239) and the captured `dueRealFn` runs only in grammar-partition tests.
- **N-2** Partial seed tally discarded on 2nd-corpus failure (Review.tsx:483-505) — corpus 1's `inserted` count is lost when corpus 2 throws; error banner hides real progress.
- **N-3** `saveTitle` unchanged-early-return (:1051-1053) gives zero feedback — button stays enabled, click no-ops.
- **N-4** Drawer toggle `aria-expanded` ✅ but no `aria-controls`/id link to the drawer region (:1637-1646).
- **N-5** Clicking drawer CONTENT (example text) bubbles to the card-wide `onFlip` → flips to front; selecting/copying an example dismisses the answer. Ticket wording ("auto-close on page tap") arguably covers it, but stop-propagating the drawer container would let users read/copy examples.
- **N-6** ReviewVocab `directAdd` guard (:380) silently drops clicks on OTHER rows while one add is in flight (only the in-flight row's button is disabled, :481).
- **N-7** 1,871-line page module — LandingView/ListDetailView/StudySession/SessionComplete are cleanly separable files; cohesive as-is, but at the split threshold.
- **N-8** Inline `style=` sprinkled (e.g. :662, :821, :844, :961) alongside the co-located-CSS convention.

## Cross-surface mastery consistency (Grammar.tsx / Hanja.tsx vs this vocab page)

User decision: "grammar & hanja work the SAME as vocab." Skim-level check only — full correctness of those pages is owned by their reviewers.

| Axis | Vocab (this page) | Grammar | Hanja | Verdict |
|---|---|---|---|---|
| Rating labels | Again/Hard/Good/Easy + 다시/어려움/좋음/쉬움 (Review.tsx:1298-1303) | Identical English names for the server-DERIVED rating (Grammar.tsx:1824-1827; no self-rate buttons by design — comment cites Review.tsx RATINGS as source of truth) | **Identical incl. Korean** (Hanja.tsx:201-204) | ✅ faithful |
| Due-first ordering | Server `ORDER BY c.due_at` on `/vocab/cards/due` (routes/vocab.ts:273) | Practice pool partitions due keys to FRONT, comment explicitly mirrors vocab (Grammar.tsx:1135-1140) | `/hanja/cards/due` server-ordered due query (routes/hanja.ts:660-670), shared engine (:703) | ✅ faithful |
| Interval copy (B-021) | `<1m/6m/1d/4d`, engine-true, test-pinned | **"~10 minutes" for scheduledDays 0** (Grammar.tsx:1836-1843) — false for BOTH again (50s) and hard (6m); = open ticket **B-034**, and the REWORKED Grammar.test.tsx RE-PINS the stale copy (:1173-1196) instead of fixing it. B-021 "not fully closed until this lands" per the ticket | **No interval subs at all**, justified by comment "hard-coded '1d/4d' labels would be a lie" (Hanja.tsx:193-194) — premise is now FALSE: hanja reviews run the same retuned shared engine, so vocab's exact labels are exactly as true here | ❌ **divergent — the substantive mirror gap** (see SF-6) |
| State names (Learning/Known) | Vocab displays NO mastery-state names (nothing to mirror against) | Learning \| Known split + Mark known / Relearn (F-063/F-066; Grammar.tsx:803-804, :651-660) | Banked / Practicing / New chips retained (Hanja.tsx:187-191) — hanja reword is **F-077, flagged "discuss," undecided** (BUGS_AND_FEATURES.md:1024-1027) | ⚠️ three surfaces, three vocabularies — but not a defect of THIS diff; grammar's model is the F-063 decision, hanja's reword is deliberately deferred. Surface to the user at F-077 time |
| Self-graduate wording | No vocab equivalent (vocab cards never retire; no graduate endpoint exists for vocab) | "Mark known" retires / "Relearn" readmits — F-066's accepted self-graduate concept, reworded ✅ | Absent (no retire concept) | ✅ within decided scope |

**Net:** rating vocabulary and due-first behavior faithfully mirror vocab on both pages. The interval-hint copy does not — hanja under-promises (omits), grammar mis-states (~10m). Recommend the fix-pass align hanja's rating subs to the vocab constants (or record an explicit decision to omit) and treat grammar's line as the already-ticketed B-034 (grammar reviewer's scope; one-file fix keyed on `schedule.rating`).

## PRAISE (fix-pass must not undo)

- **P-1** URL-driven view state (`?list=`, `?study=`) with boundary validation — refresh/back/deep-link all safe; hostile-param test (Review.test.tsx:402-407) proves degradation to landing with no fetch.
- **P-2** `useListDetail`'s forId-tagged settled state deriving `loading` at render time (Review.tsx:352-412) — eliminates the stale-flash frame classic re-fetch hooks have. Quietly excellent.
- **P-3** `StudyCardWire` discriminated union (:114-133) — three persistence provenances, and the 'local' arm is honestly surfaced as "sample data — not saved" on completion rather than faked.
- **P-4** Optimistic entry removal snapshots the COUNT separately with a comment explaining why `entries.length` would corrupt a paged header (:1076-1088).
- **P-5** B-022/B-023 CSS fix is surgical: scoped `.km-review` overrides beat legacy specificity without touching the shared sheet, each override carries a why-comment naming the legacy rule it defeats (Review.css:9-35).
- **P-6** B-021 test pins the rendered DOM label per rating button — precisely the "not a tautology" the ticket demanded; ditto B-014 back-face mount gating retained (:1597-1601, test:624-635).
- **P-7** `toAddToListTarget` treats router state as an untyped I/O boundary with structural validation + a malformed-state test — rare rigor for `location.state`.
- **P-8** Fixed-copy error discipline is airtight: every failure test also asserts the server prose is ABSENT from the DOM.
- **P-9** `SavedFromUploads` honest-null with a documented backend audit and ticket ref F-107 (ReviewVocab.tsx:244-268) — refusing to fabricate "saved" semantics is the right call.
- **P-10** Threat-model headers on both pages are current and accurate to the code (verified: abort scope, 409 copy, optimistic rollback claims all hold).

## Coordination observations

1. **BLOCKER-1's cleanest fix lives in `components/Flashcard.tsx`** (target-guard the key handler) — outside this slice's diff; hanja's study drill uses the same `Flashcard` and inherits both the bug (if it puts controls on the back face) and the fix. Sync with the hanja reviewer/fix-pass.
2. **B-034 (grammar "~10 minutes")** was open before this phase and the grammar rework RE-PINNED the stale copy in its new tests — hand to the grammar fix-pass; do not double-fix.
3. **Hanja rating subs** (SF-6): one decision, two files — if the user wants literal "same as vocab," lift vocab's `RATINGS` sub constants into a shared `lib/` module so the three surfaces can't drift again.
4. Grammar's DetailSheet and ReviewVocab's AddToListSheet reuse `km-review__sheet*` classes from the shared sheet styling — fine today, but any Review.css sheet restyle now has cross-page blast radius.
5. Scratch verification file `client/src/pages/__reviewer_scratch__.test.tsx` was created for the two keyboard repros and **deleted**; `git status` clean apart from pre-existing untracked `.claude/` + `REDESIGN_SEOUL_NEON_BRIEF.md`.
