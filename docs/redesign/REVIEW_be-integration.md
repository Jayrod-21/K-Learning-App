# Review: plan.ts + Today integration + deep-link targets (Wave 2, backend batch)

**Reviewer:** independent senior full-stack review (no code changes made).
**Scope:** `server/src/routes/plan.ts` + `server/tests/routes/plan.test.ts`,
`client/src/pages/{Today,Reading,Ttmik,Writing}.{tsx,test.tsx}`,
`client/src/types/domain.ts`, `client/src/services/*`, plus (to verify the
deep-link contract end-to-end) `server/src/routes/{hanja,reading,ttmik,writing}.ts`
and `client/src/lib/localDay.ts`.
**Branch:** `feat/backend-batch` @ `6d05e93`, diffed against `rebuild`.
**Also read:** `docs/redesign/TODAY_NAV_SCOPING.md` (the scoping doc this batch implements).

## Verdict: **PASS** — 0 BLOCKERS

The batch does what the scoping doc asked for (B4 Option 2, B5, B6), the
deep-link param contract matches on both ends for all three tiles, daily
counts use real local-day math with an honest null-while-loading state, and
the reading re-source is correctly scoped to the caller's own tables. Found 2
SHOULD-FIX (both doc-only) and 3 NITs. No code changes made per instructions.

## Gates run

- `server/` `npx tsc --noEmit` → **0 errors**.
- `client/` `npx tsc --noEmit` → **0 errors**.
- `server/tests/routes/plan.test.ts` (real Postgres via testcontainers) →
  **17/17 passed** (30.6s).
- `client` targeted vitest — `Today.test.tsx`, `Reading.test.tsx`,
  `Ttmik.test.tsx`, `Writing.test.tsx`, `lib/localDay.test.ts` →
  **159/159 passed** (3.6s).

## Deep-link param-contract matrix

| Tile | plan.ts field(s) | Today.tsx builds | Target page reads | Match? |
|---|---|---|---|---|
| Reading (chapter) | `sourceKind:'chapter'`, `chapterId` | `/learn/reading?chapter=<id>` (`readingHref`, Today.tsx:240-248) | `Reading.tsx:196` `parsePositiveInt(params.get('chapter'))` → bare-`?chapter=` branch (Reading.tsx:227-236, F-183) | **Yes** |
| Reading (story) | `sourceKind:'story'`, `storyId` | `/learn/reading?story=<id>` (readingHref) | `Reading.tsx:197` `parsePositiveInt(params.get('story'))` → `StoryReader` branch (Reading.tsx:248-250) | **Yes** |
| Reading (no id) | neither field present | `/learn/reading` (bare fallback) | root `Tabs` view (Books/Stories) | **Yes** — never fabricates an id |
| Listening | `corpus:'iyagi'`, `episodeNumber` | `/learn/listen?corpus=iyagi&episode=<n>` (`listeningHref`, Today.tsx:251-256) | `Ttmik.tsx` `parseListenView` → `corpus==='iyagi'` + `parsePositiveInt(params.get('episode'))` (Ttmik.tsx:420-428) | **Yes** |
| Listening (no key) | `corpus`/`episodeNumber` absent | `/learn/listen` (bare) | `kind:'landing'` | **Yes** |
| Writing | `promptId` | `/learn/writing?promptId=<id>` (`writingHref`, Today.tsx:258-264) | `Writing.tsx:450-452` `parsePositiveIntParam(new URLSearchParams(location.search).get('promptId'))` → pinned-fetch branch (`fetchWritingPromptById`, Writing.tsx:520-529) | **Yes** |
| Writing (no id) | `promptId` absent | `/learn/writing` (bare) | `seedPromptId === null` → normal random-bank draw | **Yes** |

Every param name matches exactly on both ends (`chapter`/`story`/`corpus`+`episode`/`promptId`), and every producer/consumer pair is covered by a real test that renders the actual click (`Today.test.tsx:649-760`) and the actual param-parse (`Reading.test.tsx:321-425`, `Ttmik.test.tsx:458-521`, `Writing.test.tsx:716-790`) — not just a route-match, but the full pathname+search string via each suite's location probe. No dead link found.

### Degrade-on-bad-param, verified per target

- **Reading** (`Reading.tsx:183-187` `parsePositiveInt`): non-numeric `?chapter=` → falls to the Books/Stories root, no fetch (`Reading.test.tsx:361-371`). Well-formed but nonexistent id → honest `ErrorCard`, never a crash (`Reading.test.tsx:372-382`).
- **Ttmik** (`Ttmik.tsx:396-431` `parsePositiveInt`/`parseListenView`): malformed `?episode=` falls back to the Iyagi listing, no fetch (`Ttmik.test.tsx:499-505`); well-formed but nonexistent episode → honest error card (`Ttmik.test.tsx:506-521`).
- **Writing** (`Writing.tsx:343-347` `parsePositiveIntParam`): malformed `?promptId=` never calls the by-id lookup, falls straight into the random-bank draw (`Writing.test.tsx:762-772`); a well-formed but 404 (missing/retired) id degrades to the same random draw (`Writing.test.tsx:773-790`), and the one-shot pin is proven not to leak into a later "New prompt" redraw (`Writing.test.tsx:791-807`).

All three parsers reject non-digit input, decimals, signs, and exponents (`Number()` alone would admit some of those) — consistent, bounded, no injection surface, matching the pattern documented in each file's own threat-model comment.

## Daily counts (Hanja / Reading / Listening) — verdict: correct

- **Source:** `fetchHanjaAttempts`, `listReadingAttempts`, `listListeningAttempts` (`services/hanja.ts:327-335`, `services/reading.ts` new tail, `services/ttmik.ts` new tail) call the new `GET /hanja/attempts`, `GET /reading/attempts`, `GET /ttmik/attempts` — all added in the **same commit** (`server/src/routes/{hanja,reading,ttmik}.ts`), user-scoped, `COUNT(*) OVER()`-backed, capped `limit ≤ 100` server-side (matches the `{ limit: 100 }` the client requests, `Today.tsx:469-501`).
- **Local-day math:** `isLocalToday` (`client/src/lib/localDay.ts:39-67`) uses `Date.prototype.getFullYear/getMonth/getDate` — real local getters, not UTC twins. `localDay.test.ts` proves this two independent ways that are blind to the CI host's UTC timezone: a `Date.prototype` spy proving the default path calls the local trio and never the UTC trio, and a simulated +9h (KST) extractor that produces `true` for a genuine UTC-day-crossing pair where a UTC-day extractor produces `false` (lines 68-100). This is exactly the rigor needed — a naive "compare against `new Date()`" test on a UTC CI runner cannot distinguish correct-local from regressed-UTC, and this suite closes that gap without relying on the runner's TZ.
- **Loading → null, never a fabricated zero:** `Today.tsx:524-547` gates every one of the six done-today derivations on `data && !loading`, else `null`; `DoneTodayRow` (`Today.tsx:399-426`) renders nothing when `count === null`. Verified for Hanja/Reading/Listening specifically at `Today.test.tsx:985-994`, and for the pre-existing three at `Today.test.tsx:946-952`.
- **Boundary case:** the day-boundary comparison itself is unit-tested with a genuine crossing (16:00 UTC Jan 1 vs. 19:00 KST Jan 2 — same local day under KST, different under UTC) in `localDay.test.ts`. `Today.test.tsx`'s own fixtures (`*_MIXED`) use realistic "today" vs. "2019" data to test the wiring/filtering, which is the right division of labor — the module doing the actual date arithmetic carries the edge-case test, the page test carries the integration.

No count is fabricated; all six tiles (grammar/writing/TOPIK pre-existing, hanja/reading/listening new) follow one honest contract.

## Reading re-source (user B) — verdict: correct

- `plan.ts:296-330` — a `UNION ALL` of `reading_chapters c WHERE c.user_id = $1` and `generated_stories s WHERE s.user_id = $1`. Both legs scoped to the caller; no `ttmik_lessons` reference remains in the reading branch. Cross-user isolation is explicitly tested (`plan.test.ts:297-308`, "never surfaces another user's reading_chapters or generated_stories").
- **Deterministic daily rotation preserved:** same `md5($2::text || seoul_date || source_kind || row_id::text)` tie-break idiom the old pick and the writing branch use; a repeated `GET /plan/today` in one day returns byte-identical JSON (`plan.test.ts:311-341`), now exercised across BOTH reading sources plus Iyagi in one test.
- **Band preference sane:** `reading_chapters` carries no proficiency band (`NULL::text AS level`), so a chapter can only ever land in the CASE's fallback tier (`ELSE 1`); only a `generated_stories` row with a matching `proficiency_level` can win the `0` tier. This is correctly documented and tested both ways — a low estimate prefers a band-matched story over a bandless chapter and an L5+ story (`plan.test.ts:242-268`), and with no matching story the chapter still surfaces rather than a fabricated null (`plan.test.ts:270-295`).
- **Dead `bookLevel*` helpers:** confirmed removed — `grep` for `bookLevel`/`ttmik_lessons` in the current `plan.ts` returns nothing; the file's only helpers now are `estimateToProficiency`, `readingMinsFromChars`, `readingLevelToLabel`, `listeningMinsFromSentences`, `computeLargestGap`, all exercised by the route tests and consistent with their doc comments (e.g. `readingLevelToLabel`'s null/L4-default fallback matches the "no signal → centre band" contract the old pick used).
- **Title fallback:** a null chapter title server-derives `Chapter N` (`plan.ts:334-338`), matching the same fallback `POST /reading/attempts` already uses (`reading.ts:282`) — one convention, not two independently-drifting ones.

## Payload / expand-contract

All Wave-2 fields (`sourceKind`, `chapterId`, `storyId`, `corpus`, `episodeNumber`, `promptId`) are optional additions to the existing `TodayTask` shape (`domain.ts` diff, `plan.ts:208-230`) — no field renamed or removed, `fetchToday` (`services/plan.ts:46-58`) passes the whole `TodayTask` through untouched rather than hand-picking fields (so no risk of a manual mapper silently dropping a new field on either side). Safe for blue/green: an older client ignores the new fields; an older server simply omits them and every consumer already null-checks before using them (`readingHref`/`listeningHref`/`writingHref` all fall back to the bare route when a field is `undefined`).

No hardcoded hex colors introduced in the diffed page files (checked via diff grep); a11y — every new/changed tile keeps a real `<button>` with an `aria-label` describing the specific item (e.g. `Open reading — ${t.title}`), consistent with the file's existing pattern.

## Findings

**SHOULD-FIX**

- **SF-1 — stale "not wired yet" doc comments in 3 client services, contradicted by this same commit's own Today.tsx wiring.** `client/src/services/hanja.ts:317-320` ("wiring it into Today.tsx itself is out of this ticket's scope"), `client/src/services/reading.ts` (tail, `listReadingAttempts`'s doc: "Not currently rendered by any screen this phase"), and `client/src/services/ttmik.ts` (tail, `listListeningAttempts`'s doc, same sentence) all say the history reads aren't consumed by any screen yet — but `Today.tsx:487-501` calls exactly these three functions in this same commit (`6d05e93`) to drive the Hanja/Reading/Listening "done today" rows. Low risk (doesn't affect behavior), but it will actively mislead the next person who trusts the comment over checking Today.tsx. Fix: update the three doc comments to say these ARE consumed by Today.tsx's done-today counts.

**NIT**

- **N-1** — `Ttmik.tsx`'s `parsePositiveInt` (used for both `?level=`/`?lesson=` and `?episode=`) caps at 4 digits (`/^\d{1,4}\$/`, Ttmik.tsx:396-399). Fine today (~170 Iyagi episodes, documented in the file's own comments), but it's a shared parser across TTMIK lesson numbers and Iyagi episode numbers — worth a one-line comment noting the bound is intentionally shared/generous rather than episode-specific, so a future corpus growth past 9999 isn't a silent surprise. Not a real risk at current/foreseeable scale.
- **N-2** — `plan.ts`'s writing/reading id fields coerce BIGINT-as-text to `Number()` (`Number(writingRow.id)`, `Number(readingRow.row_id)`), which could theoretically lose precision past `2^53`. This mirrors the codebase's existing convention everywhere else BIGINT ids cross the wire (e.g. `services/hanja.ts`'s own `Number(l.id)` list mapper) — not a regression introduced by this diff, just noting it's an existing, accepted pattern rather than something Wave 2 should have fixed alone.
- **N-3** — `docs/redesign/BACKEND_BATCH_SCOPING.md` (new in this commit) wasn't in the reviewed diff paths but is the Wave-1+2 scoping doc referenced throughout; worth a quick skim by whoever merges this to confirm it doesn't promise anything this review didn't find delivered (I did not audit it line-by-line — out of the requested scope, which was `TODAY_NAV_SCOPING.md`).

**PRAISE**

- The local-day boundary test (`localDay.test.ts`) is genuinely rigorous — the `Date.prototype` spy plus the simulated-non-UTC-extractor technique correctly defeats the "CI runs in UTC so a naive test can't distinguish correct-local from regressed-UTC" trap. This is exactly the kind of test that should exist whenever "local calendar day" logic ships to a CI runner pinned to UTC, and the file's own header comment explains why in a way a future maintainer can follow.
- The reading re-source's band-preference tie-break correctly generalizes the writing branch's existing CASE idiom rather than inventing a new one, and the "bandless chapter can never win band-match" invariant is both documented and positively tested (not just asserted in a comment).
- Deep-link degrade coverage is unusually thorough for all three targets — malformed param, well-formed-but-missing param, and (for Writing) the one-shot-pin-doesn't-leak-into-later-redraws case are all real tests, not just code review confidence.

## Coordination / next steps

- No code changes were made (per instructions). SF-1 is a 3-line comment fix in `hanja.ts`/`reading.ts`/`ttmik.ts` client services — trivial for whoever does the next pass, no test changes needed.
- `db/tests/test_migration_059/060/061.py` and any `--allow-destructive` gate for the new attempt-log tables (called out in the commit message as "for fixpass") is outside this review's file scope (server routes + Today integration + deep-link targets) — flag to whoever runs the DB-migration leg of `/fixpass` separately.
- Nothing here blocks merge on the reviewed surface.
