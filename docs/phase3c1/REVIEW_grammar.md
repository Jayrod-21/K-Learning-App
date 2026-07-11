# REVIEW — Grammar page (Phase 3C-1, F-063/F-064/F-065/F-066/B-024/F-024)

Reviewer: independent senior review, report-only. Scope: `client/src/pages/Grammar.tsx`, `Grammar.css`, `Grammar.test.tsx` on `feat/phase3c1-cards` vs `rebuild`. Context read: `client/src/pages/Review.tsx`, `server/src/routes/grammarDrill.ts`, `client/src/services/grammarDrill.ts`, `server/src/services/fsrs.ts`, `client/src/hooks/useEndpointOrMock.ts`, `BUGS_AND_FEATURES.md`, `FOLLOW_UPS.md`. Targeted suite re-run: `npx vitest run src/pages/Grammar.test.tsx` → 37/37 pass.

## Verdict

**NOT SHIPPABLE AS-IS — 2 BLOCKERS.** The vocab-mirror is faithful in vocabulary and HONEST in mechanism (drill submit genuinely advances the server-owned FSRS production card; nothing fabricated; no fake self-rate loop), and the F-065 stub meets the honest-stub bar. But (1) the flagship F-063 due-first ordering is defeated in real usage by the persisted rotation cursor — the test only passes because localStorage is cleared — and (2) the async score reveal is never announced to AT. Both are narrow, low-risk fixes.

## Bar checklist

| Bar | Status | Note |
|---|---|---|
| WCAG AA | **FAIL** | Score reveal not announced (BLOCKER-2); rest is solid |
| Correct ARIA | Mostly PASS | aria-pressed toggle group, disclosure tiles, labeled rows/textarea; `<ul>` w/ `list-style:none` lacks `role="list"` (SF-4) |
| Strict TS at I/O boundaries | PASS | `readDrillTarget` narrows unknown; `loadRealDueKeys` field-checks each DueCard; `parseView` closed set; typed services |
| No swallowed errors | PASS | Abortable generate/submit (AbortController + `canceled` code drop); real error+retry on both legs; failed due fetch degrades to empty set, never blocks |
| Tests exercise real behavior | PASS w/ caveat | Strong behavioral suite; due-first test masked by `localStorage.clear()` (see BLOCKER-1) |
| Co-located CSS | PASS | `Grammar.css`, imported at Grammar.tsx:131 |
| No scope creep | PASS | Page + its co-located test/css only |
| No console.log / no unticketed TODO | PASS w/ caveat | Zero console/TODO; ticket ids F-065-B / F-063-B exist only in code comments (SF-3) |
| **Honest-stub bar (F-065)** | **PASS** | HistoryPanel (Grammar.tsx:1101–1113) states plainly no read endpoint exists, cites ticket, renders no fake/empty list. NOT a finding |

### Ticket checks

- **F-063 + F-066 (vocab mirror + Anki) — core:** Terminology replaced: `Learning | Known` toggle (Grammar.tsx:800–805, 898–917), "Mark known"/"Relearn" (1058–1084), no banked/graduate jargon (pinned by test:283–305). Reveal names the server-derived rating with labels IDENTICAL to vocab's `RATINGS` (`Again/Hard/Good/Easy`, Grammar.tsx:1823–1828 vs Review.tsx:1298–1303). **Honesty verified:** submit → `POST /grammar-drill/:id/submit` → server single-tx (grammarDrill.ts:330–501): score UPDATE gated `scored_at IS NULL`, auto-bank, production-card upsert, versioned FSRS advance (`version = $9` gate → ConflictError at :464–469), immutable `card_reviews` snapshot. Client renders only the server-returned `schedule`; the dev-only mock score deliberately carries NO schedule (Grammar.tsx:1242–1260) — no fabricated rating/interval, ever. No per-card self-rate loop was faked — reveal names the derived rating, comment states the read-API gap and tickets it (F-063-B, but see SF-3). Due-first partition exists (1344–1353) but is **defeated by the cursor — BLOCKER-1**.
- **B-024:** Rows grouped into CollapsibleTiles by proficiency (812–820, 889–894, 964–994) with per-group counts — real separation. One-line constraint: `.km-grammar__row-kr` `white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0` with the full flex `min-width:0` chain through `__row-btn` and `__row-head` (Grammar.css:60–99) — correct; the Due pill can't be crushed (flex min-width:auto floor). Not machine-testable in jsdom; verified by inspection — recommend a one-off visual check with a long composite form.
- **F-064:** PASS — gold "Practice" button in the Topbar `right` slot (Grammar.tsx:716–727); test asserts it sits inside `.km-topbar` (test:326–328).
- **F-065:** PASS — honest stub, see bar row above.
- **F-024:** PASS — BackButton on both nested views with deterministic `to="/learn/grammar"` (706–708), so a deep link can't history-back out of the app; round-trips tested (test:343–373, 469–476).

## Findings

### BLOCKER

**B-1 · Due-first practice ordering is defeated by the persisted rotation cursor; the test passes for the wrong reason.**
`Grammar.tsx:1336` initialises `idx` from the localStorage cursor (`readDrillCursor`), which monotonically grows across sessions and never resets (the deliberate always-N이다 fix). The pool partitions due-first (`1344–1353`), but the entry point is `pool[idx % pool.length]` (`1380`). After any prior practice, `idx % pool.length === 0` only by coincidence (~1/len), so the session almost never starts at the due partition — the scheduler's due cards are NOT served first. Worse, the cards view actively promises otherwise: *"N patterns due for review — Practice serves them first."* (`922–927`) — a misleading mastery/scheduling display per this review's category defs. The pinning test (`test:523–547`, 'practice serves DUE patterns before the rest of the rotation') passes only because `resetMocks()` clears localStorage (`test:272`) → cursor 0. Fix sketch: apply the cursor rotation BEFORE the due partition (rotate `base` by `idx`, then partition due-first, then always drill index 0), or reset/skip the cursor to the first due index when `dueKeys` is non-empty; add a test that seeds `km.grammar.drillCursor` to a non-zero value and still expects the due pattern first.

**B-2 · A11y: the async score reveal is never announced (WCAG 2.2 AA 4.1.3 Status Messages).**
On submit, `role="status"` "Scoring your answer…" (`1675–1679`) unmounts and `DrillReveal` (`1751–1815`) mounts with no live region — an SR user gets silence where a sighted user gets score/verdict/rating/schedule. The JSDoc rationale (`1802–1809`) claims the reveal is "already-announced" via the card's `aria-describedby={revealId}` — that is incorrect: `aria-describedby` is only surfaced when its element receives focus, and the textarea is `disabled` once revealed (`1669`), so it never will. Note the asymmetry: the FAILURE path announces (`ErrorCard` `role="alert"`, ErrorCard.tsx:47) but the success path doesn't. Fix sketch: an sr-only `role="status"` line inside/alongside the reveal ("Scored 82 of 100 — Good, rated Good, next review in 3 days") or `role="status"` on a compact reveal header; keep it to one announcement.

### SHOULD-FIX

**SF-1 · Late bank/due settle regenerates the drill mid-answer (answer loss).**
`PracticePanel`'s pool identity depends on `learningItems`/`dueKeys` (`1344–1353`); its loading gate covers only `listState.loading` (`766`, `1533`). If the user opens Practice before `bankedState`/`dueState` settle (slow network; or deep entry), the settle switches/reorders the pool → `patternKey` at `idx` changes → the generate effect (`1400–1462`) aborts and resets `userInput` — wiping an in-progress answer with no warning, on a page whose own error copy promises "Your answer is still here." Fix sketch: snapshot the pool once per practice session (e.g. freeze on first non-empty resolve / on view entry), or refuse to re-fire the generate effect while `phase === 'ready' && userInput.trim().length > 0`.

**SF-2 · `scheduleLine` "~10 minutes" misstates the server policy and breaks the vocab mirror it cites.**
`Grammar.tsx:1836–1843`: any `scheduledDays <= 0` renders "next review in ~10 minutes". Server truth (`fsrs.ts dueDelayMs`): `again` → 50s (`RELEARN_DELAY_MS`, "<1 min"), `hard` at 0 days → 6 min (`HARD_STEP_DELAY_MS`). Vocab's own buttons display `<1m` / `6m` (Review.tsx:1299–1300). "~10 minutes" is wrong by ~12x for `again` and inconsistent with the F-063 shared-vocabulary goal. The rating is in hand (`schedule.rating`) — branch: `again` → "in under a minute", `hard` → "in ~6 minutes". Update the pinned copy test (`test:1196`).

**SF-3 · Ticket ids F-065-B and F-063-B exist only in code comments.**
Grammar.tsx:35/47/99 (+ test:12) cite "Backend ticket: F-065-B / F-063-B", but neither id appears in `BUGS_AND_FEATURES.md`, `FOLLOW_UPS.md`, or git history. Parent tickets F-065 and F-063 ARE open in `BUGS_AND_FEATURES.md` (:930, :943), so the stub itself is honestly ticketed at the feature level — but the "-B" references dangle. Register the two backend sub-tickets (or re-point the comments at F-065/F-063 with a "backend half open" note).

**SF-4 · `<ul class="km-grammar__list">` needs `role="list"`.**
Grammar.css:40 sets `list-style:none`, which makes Safari/VoiceOver drop list semantics (row count/position no longer announced). The codebase's own convention adds explicit `role="list"` (ReviewLibrary.tsx:102–107, Mistakes.tsx:183). One attribute at Grammar.tsx:977.

### NIT

**N-1 ·** `knownPendingKey` is single-slot (`569`): rapid Mark-known on row A then row B — A's `finally` (`612`) nulls the key while B is still in flight, re-enabling B's button mid-flight. Cosmetic; the endpoints are idempotent.
**N-2 ·** Stale Due pill after Mark known: `dueKeys` is not refetched on graduate, and `CardRow` renders the pill regardless of view (`1054`), so a just-known pattern can show "Due" in the Known view until reload. Consider `dueState.refetch()` alongside the bank refetch in `setKnown`, or suppress the pill in the `known` view.
**N-3 ·** `openDetail` (`529–558`) uses a stale-guard ref but never aborts the underlying `getPattern` request (the service accepts a signal). Result is correctly dropped; the request just isn't canceled. Mirrors the pre-existing ReviewGrammar idiom — fine to leave, worth a follow-up sweep.
**N-4 ·** Inconsistent indexed-access style: `pool[idx % pool.length]!` (`1380`) vs `MOCK_DRILLS[idx % MOCK_DRILLS.length]` bare (`1418`). Compiles because `noUncheckedIndexedAccess` is off; pick one style.
**N-5 ·** B-024's one-line constraint has no automated coverage (jsdom can't compute layout) — acceptable, but note it in the PR so the visual check isn't skipped.

### PRAISE (fix-pass must not undo)

**P-1 · PROD honest-error posture for generate failures.** `import.meta.env.PROD` gate (`1442–1446`): prod never serves `MOCK_DRILLS`/local pseudo-scoring (where the null-rendering MockBadge would make fixtures read as real); dev keeps the failure-safe fallback with the 🅂 badge. Pinned by a dedicated `vi.stubEnv` describe block (test:1035–1143) covering both sides of the gate AND the retry wiring.
**P-2 · No fabricated FSRS anywhere.** Mock due set is empty by design (`350–352`); mock score carries no `schedule` (`1246`); rows badge only due-NOW patterns instead of inventing intervals (header:44–47); due summary is silence-when-unknown, not "0 due" (`919–921`).
**P-3 · Retry wiring is semantically correct and regression-pinned:** submit-failure Retry RE-SUBMITS the preserved answer; generate-failure Retry RE-GENERATES via `genTick` (avoiding the `if (!item) return` dead-end) — each with a test that would catch the cross-wiring (test:982–1024, 1040–1080).
**P-4 · Test suite is genuinely behavioral:** stale detail settle race (test:743–810), cursor-survives-remount regression for the live always-N이다 bug (test:1309–1342), B-SF-1 corpus-independence pair (test:589–631), bank-row id (501) vs KGIU id (42) distinction asserted (test:1458–1460).
**P-5 · Rating labels are exactly vocab's** (`RATING_LABEL` ≡ Review.tsx `RATINGS` labels), and the reveal-names-the-derived-rating approach is the honest mirror given the server derives rating from verdict (`ratingFromVerdict`, grammarDrill.ts:320).
**P-6 · Threat-model header** (`57–80`) is accurate to the code (verified each claim), including the closed-set `?view=` parse and the fixture-as-real-in-prod analysis.

## Coordination observations

- `DrillTarget` (Grammar.tsx:151–155) is the deep-link contract consumed by Review.tsx's grammar-production section (`onDrill` → navigate with `location.state.drillTarget`). Any fix-pass rename/shape change must touch both sides; Review.tsx is another reviewer's scope on this branch.
- `loadRealDueKeys` (`361–375`) deliberately mirrors Review.tsx's `isGrammarProductionCard` predicate — if the fix-pass alters one predicate, keep them in lockstep or extract a shared helper.
- BLOCKER-1's fix touches `DRILL_CURSOR_STORAGE_KEY` semantics — do not regress the always-N이다 fix (P-4's remount test must stay green alongside a new nonzero-cursor due-first test).
- `KGIU_LIST_LIMIT = 400` equals the server's Zod `limit` ceiling exactly (server grammar.ts:59) — if the corpus grows past 400 listable rows, both sides move together.
- Branch also reworks Review.tsx/Hanja.tsx/ReviewVocab.tsx (merged sibling branches); nothing in Grammar's diff reaches into those files.
