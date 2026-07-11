# REVIEW — Reading slice (Phase 3C-2, `feat/phase3c2-content` vs `rebuild`)

Reviewer: independent senior review, report-only. Scope: `client/src/pages/Reading.tsx` / `.css` / `.test.tsx`, `client/src/services/reading.ts`, B-019 slice of `client/src/pages/Today.tsx` + `Today.test.tsx`; `server/src/routes/reading.ts` sampled for wiring context only.

## Verdict

**PASS — 0 BLOCKER, 2 SHOULD-FIX, 6 NIT, 7 PRAISE.**

B-019 confirmed correctly closed. F-070 honest-stub bar met. Verified live: `vitest run Reading.test.tsx Today.test.tsx` → 47/47 green; `eslint` clean on all in-scope files.

## Bar checklist

| Bar | Status | Evidence |
|---|---|---|
| WCAG AA / correct ARIA | PASS | Radiogroup w/ roving tabindex + arrow wrap (Reading.tsx:1117-1133, 1152-1174); `aria-disabled` not `disabled` on busy Generate w/ handler re-entry guard + CSS inert paint (Reading.tsx:1200-1204, Reading.css:149-152) — keyboard focus never dumped to `<body>`; labelled input (Reading.tsx:1178-1190); `role="status"` loading, `role="alert"` errors; Sheet = shared `useModalA11y` dialog (Esc, focus trap, restore — components/Sheet.tsx:14-26); `Tabs` primitive owns tablist semantics; every repeated Translate button disambiguated via `ariaContext` (Reading.tsx:823) |
| Strict TS at I/O boundary | PASS | Wire interfaces per endpoint + explicit wire→domain mappers (services/reading.ts:50-115, 161-196); snake_case position DTO vs camelCase story DTO split verified against server (routes/reading.ts:240-262 vs 437-465) — matches; contract-violation PUT null fails loud (services/reading.ts:245-252) |
| No swallowed errors / abortable fetch | PASS | Every fetch: own `AbortController`, aborted on unmount/re-fetch, signal checked before every post-await state write, `canceled` code dropped, everything else → fixed copy + working Retry (Reading.tsx:292-323, 455-492, 907-931, 1244-1267, 1352-1375) |
| Tests exercise real behavior | PASS | Route probes assert actual navigation incl. `?page=` threading (Reading.test.tsx:671-738); abort test observes real signal mid-flight (588-630); no-server-prose-leak asserted on every error path; B-019 test fails on old code (no `/learn/listen` stub in harness) |
| Honest stub (F-070/F-116) | **PASS** | `TranslateSheet` shows source passage + "Coming soon" pill + F-116 ref; no translation text anywhere (Reading.tsx:835-875); test pins it (Reading.test.tsx:632-662) |
| Co-located CSS | PASS | Reading.css holds only Reading-specific layout; shared row/list paint confirmed in styles/index.css (2974, 4586, 4713) |
| No scope creep / console.log / ticketless TODO | PASS | Grep clean. (But see coordination note on Today.tsx F-101.) |

## Ticket checks

- **F-067** PASS — typed sections Literature/Dialogue/Documents (Reading.tsx:263-277), ready-only filter (307), docs types = vocab/grammar/both, honest "no chapters yet" for chapterless docs. Section-membership test uses `within(region)` — books asserted in *their* section, not merely present (Reading.test.tsx:256-290).
- **F-068** PASS — `POST /reading/generate` wiring exact vs server schema: level enum `L1|L2|L3|L4|L5+` matches `StoryLevelBodySchema` (routes/reading.ts:421), topic trimmed + omitted-when-empty (matches `.min(1)`), `maxLength={500}` matches Zod cap. Supersede-abort on regenerate (Reading.tsx:1093-1096). List+open real; library window `max: 200` deliberately matches server `LIMIT 200` (routes/reading.ts:540). Gaps: see SF-1, N-2.
- **F-069** PASS — Resume only when saved `chapterId` still in listed chapters (Reading.tsx:503-506), stale-position test present (Reading.test.tsx:427-444). Save = PUT after chapter load, failure → one toast, reading uninterrupted, both tested (521-564). `toast` from provider is `useCallback([], …)`-stable → effect dep `[chapter, toast]` can't loop.
- **F-070** PASS — honest stub, F-116 referenced in code + copy + tests. Not a finding.
- **B-019** **CLOSED — verified.** Today.tsx:297 Reading tile nav `/learn/listen` → `/learn/reading`; Listening/Writing tiles untouched (:300-301); stale blocked-on comment replaced. New pinning test (Today.test.tsx:369-381) clicks the real tile, asserts landing on a `/learn/reading` route stub — fails on old code (harness has no `/learn/listen` stub, so old nav renders nothing). No other Today test references the old fallback; the rest of Today's diff is comments + the F-101 generator wiring (out of scope, see C-1). Route target real: App.tsx:136 `learn/reading` → this Reading page.
- **F-024** PASS — deterministic `to` on every nested view (Reading.tsx:188-206): picker→root, reader→picker, story→`?tab=stories`; BackButton primitive has first-entry guard; picker + story back tested (Reading.test.tsx:363-366, 781-784). Reader-level "Back to Chapters" untested (N-5).

## Findings

### BLOCKER

None.

### SHOULD-FIX

**SF-1 — Generation abort path has no test.** Ticket F-068 names abort as a verify item. The wiring exists and is correct (unmount abort Reading.tsx:1084-1089; supersede 1093-1096; post-await signal check 1104), but no test observes it — contrast the mineWord abort, which got a dedicated mid-flight-signal regression test (Reading.test.tsx:588-630). A refactor could silently drop the unmount abort (late `onCreated` → setParams on a dead tree) and the suite stays green. Add the mirror test: capture `generateStory`'s signal, switch tabs mid-flight, assert `signal.aborted === true`.

**SF-2 — Books section cap can strand uploads.** `usePagination(books, { initial: 8, step: 8, max: 30 })` (Reading.tsx:397): a section with >30 ready uploads has NO path to items 31+ — no search on this page, and server `GET /uploads` is unbounded (no LIMIT in routes/uploads.ts). The stories list shows the right instinct (client max deliberately = server cap 200, with a comment); books picked 30 with no matching reasoning. Personal-scope app so low likelihood, but Documents accretes indefinitely by design ("this is also where uploaded documents live"). Raise `max` to cover realistic shelf size or note why 30 is safe.

### NIT

**N-1 — Mismatched deep link `?book=A&chapter=<chapter of B>`.** ChapterReader fetches by `chapterId` alone (Reading.tsx:894, 915); BackButton targets `?book=A`'s picker (:191) — back lands on an unrelated book. Data-safe (position PUT uses the loaded chapter's own `sourceUploadId`, server re-validates chapter∈book), purely a hand-crafted-URL cosmetic.

**N-2 — 429 not exercised at page level.** Comments sell 429 as first-class (Reading.tsx:1067-1068, 72); the page test uses 502 only (Reading.test.tsx:845-866). Composition is safe (`errorMessageFor` retryAfter copy unit-tested in lib/errorCopy.test.ts), so this is belt-and-suspenders: one 429-with-retryAfter render test would pin the claim.

**N-3 — Unmount aborts the position PUT → save silently lost.** Effect cleanup (Reading.tsx:953-955) aborts the fire-and-forget save; open-chapter-then-immediately-back drops the position with no toast (aborted branch returns). The abort exists only to suppress a post-unmount toast — letting the PUT settle and gating just the toast would keep the save. Chapter-granularity makes the loss minor.

**N-4 — No deep-link/garbage-param tests.** `parsePositiveInt` and the `?tab=stories` restore (Reading.tsx:149-164) are untested: `?book=--1`, `?chapter=1e3`, `?story=0` → root, `?tab=stories` → stories tab. Cheap render-only tests.

**N-5 — Chapter reader's "Back to Chapters" untested** (the other two BackButtons are).

**N-6 — Stale comment in App.tsx:129** — "except Reading — a new placeholder until P6" is now false. File untouched by this diff; one-line comment fix belongs with this feature.

### PRAISE (fix-pass must not undo)

**P-1** — F-070 stub is exactly the honest shell asked for, and the test asserts the *absence* of fabricated translation, not just presence of "coming soon" (Reading.test.tsx:650-656).
**P-2** — `aria-disabled` + handler guard + CSS inert-paint mirror on the busy Generate button (Reading.tsx:1197-1204, Reading.css:146-152) — correct WCAG 2.4.3 focus-preservation pattern, with the click-not-blocked pitfall explicitly handled.
**P-3** — Abort discipline: fresh controller per fetch, supersede on re-entry, signal check before every post-await state write, `canceled` never surfaces as an error — uniformly across all five data flows.
**P-4** — Stale-resume guard (Reading.tsx:503-506) + its dedicated test: Resume can never be a dead button after a book re-load. Matches the server's own degraded-row normalization.
**P-5** — `saveReadingPosition` fails loud on a contract-violating null (services/reading.ts:245-252) instead of returning garbage; wire-shape docs verified accurate against the server DTOs, including the snake/camel split and why no string-id split is needed.
**P-6** — `\r\n` normalization + per-line `<br/>` re-insertion in `PassageBody` (Reading.tsx:769-795) with a test that inspects the rendered `<br/>` — a real OCR-corpus defect class, defended and pinned.
**P-7** — B-019 pinning test is a genuine regression test: it fails on the pre-change code by construction (no `/learn/listen` stub in the harness).

## Coordination observations

- **C-1** — Today.tsx's diff also carries the F-101 `WritingTopicGenerator onUseTopic` → `location.state.generatedTopic` wiring (Today.tsx:448-461). Out of this slice; confirm the Writing reviewer covers both ends (generator prop + Writing page's state narrowing).
- **C-2** — Mined-highlight is keyed by surface form while the mined set stores lemmas (`Tapword mined={minedIds.has(tk.w)}` Reading.tsx:743 vs `handleAdd` storing `d.kr` :660-663): a banked conjugated form never re-renders as mined. Inherited verbatim from Ttmik.tsx (:1137 vs :901) — a pre-existing shared-stack quirk, NOT new in this diff; if ever fixed, fix it in one place for both pages.
- **C-3** — `/reading` API prefix already exists in the km-lb nginx allow-list (pre-existing U3b routes) — no F-012-class SPA-shadowing risk from this slice.
- **C-4** — Server routes sampled read production-grade (uniform 404 IDOR posture, bounded ids, Claude-before-INSERT no-half-state, `.strict()` bodies); client threat-model headers accurately describe them — the two sides' comments cross-reference and agree.
