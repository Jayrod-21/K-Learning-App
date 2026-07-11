# REVIEW — Listen page (Ttmik.tsx / .css / .test.tsx) — Phase 3C-2

Reviewer: independent senior review, scope = `client/src/pages/Ttmik.{tsx,css,test.tsx}` + sampled Phase-1 primitives (`components/ShowMore.tsx`, `hooks/usePagination.ts`, `components/FilterSelect.tsx`). Diff basis: `feat/phase3c2-content` vs `rebuild`. Report-only; no code modified.

## Verdict

**PASS — 0 BLOCKERS, 4 SHOULD-FIX, 4 NIT.** F-071 / F-072 / F-024 / URL-addressing all genuinely implemented + genuinely tested. Verified `src/pages/Ttmik.test.tsx` 24/24 green locally. Primitives (ShowMore / usePagination / FilterSelect) untouched by this diff — no scope creep. Top concern = cross-cutting ShowMore final-reveal focus drop (SHOULD-FIX, fix belongs in `components/ShowMore.tsx`).

## Quality-bar checklist

| Bar | Status | Notes |
|---|---|---|
| WCAG AA contrast | PASS (computed) | New tile styles: light `--paper-dim` #57617A on `--ink-1` #FFFFFF ≈ 6.2:1; dark #A0ABC9 on #141A28 ≈ 7.6:1. Both ≥4.5:1 at 11px. CSS comment's AA claim (Ttmik.css:60) checks out |
| Correct ARIA | PARTIAL | Live-region stat, role=status loading, labelled lists, keyboard tiles all correct. Gaps: SF-2 (aria-label hides AudioPill from AT), SF-3 (hand-rolled tablist, carried-over), N-1 (list-style:none Safari role loss) |
| Strict TS at I/O boundary | PASS | `parseListenView` narrows untrusted params to closed `ListenView` union; `parsePositiveInt` = `/^\d{1,4}$/` + `>=1` (rejects signs/exponents/whitespace/overlong); `DetailData` discriminated union; every catch takes `err: unknown`; exhaustiveness `never` guard Ttmik.tsx:1331 |
| No swallowed errors | PASS | 3 abortable fetch sites (listing ×2, detail) each: AbortController + cleanup abort + `signal.aborted` settle-guards + `ApiError code==='canceled'` filter + ErrorCard w/ working Retry (monotonic reloadTick). Add-to-bank POST: optimistic + rollback + fixed-copy toast + abort-on-close (tested, Ttmik.test.tsx:653-713) |
| Tests exercise real behavior | PASS | Window test walks 15→30→40 w/ exact "Show more (15)"/"(10)" labels + expander disappearance (285-313); filter-reset asserts back-to-15 not 30 (315-354); audio persistence via `toBe` DOM reference identity (529-553); malformed params assert **fetch not called** (405-434); error tests assert server prose absent. `buildAudioSrc` deliberately unmocked. Not tautological |
| Co-located CSS | PASS | New 3C-2 styles in Ttmik.css. Inline `style={{}}` count 27 = identical to rebuild's 27 — no regression, pre-existing idiom |
| No scope creep | PASS | `git diff rebuild` shows zero changes in ShowMore.tsx / usePagination.ts / FilterSelect.tsx; page files only |
| console.log / TODO | PASS | grep clean across all three files |

## Ticket verification

- **F-071 landing** — VERIFIED. `.km-ttmik__tiles` = `grid-template-columns: repeat(2, minmax(0, 1fr))` (Ttmik.css:21) → genuinely 2 across; `.km-ttmik__tile` `aspect-ratio: 1 / 1` (Ttmik.css:30) → genuinely square; grid rows are implicit so a 3rd `COLLECTIONS` entry (Ttmik.tsx:145) wraps to row 2 with no CSS change — future collections flow correctly. Tiles are real `<button>`s in a labelled `<ul>`; keyboard operability tested via `.focus()` + `{Enter}` (test:217-226). Landing fires no fetch (tested, test:213-214). `minmax(0,…)` prevents long-text track blowout — correct.
- **F-072 window** — VERIFIED. `LIST_WINDOW = { initial: 15, step: 15, max: 990 }` (Ttmik.tsx:183) applied to both listings via `usePagination`; max=990 correctly overrides the hook's default 30 (which WOULD have stranded rows on the ~190-lesson corpus — the comment shows the author understood the trap). `remaining` (not `total - visible`) wired to `<ShowMore remaining>` per the hook's own warning. Filter change calls `reset()` in `onLevelChange` (Ttmik.tsx:484-492); tested end-to-end incl. reset-on-clear.
- **URL addressing** — VERIFIED CLOSED. Corpus checked against literal `'ttmik'`/`'iyagi'`; ints bounded 1–9999; fallback is hierarchical (bad detail nums → listing, unknown corpus → landing) and the tests prove no fetch fires on malformed input. No param ever reaches a path segment un-narrowed (`Selection` fields are `number` by construction). Sampled `buildAudioSrc` (services/ttmik.ts:106): allow-list `/^\/(?:ttmik\/lessons\/\d+\/\d+|iyagi\/episodes\/\d+)\/audio$/` is real, anchored, and rejects protocol-relative/absolute URLs — threat-model comment is accurate, not aspirational.
- **F-024 BackButton** — VERIFIED. Listing → `to={LISTEN_PATH}`; detail → `to={listPath(corpus)}` with collection label (Ttmik.tsx:277-284). Explicit-parent `to` (not `navigate(-1)`) so deep links can't back out of the PWA — matches BackButton's documented contract. Both tested (test:388-402, 715-726, 810-819).
- **DEFERRED items handled correctly** — B-025: no timed read-along built (no timestamps in corpus); the comment at Ttmik.tsx:1016-1019 documents it as the follow-up once timestamps exist, and transcripts render fully (every line kind tested, test:555-583). B-026: `audioUrl === null` → no player + fixed "No audio yet — read along below." note, transcript still renders (test:776-803). Both are data tickets, not code faults. Confirmed — no fault assigned.

## Findings

### BLOCKER

None.

### SHOULD-FIX

**SF-1 — ShowMore unmounts on final reveal → keyboard focus drops to `<body>`. CROSS-CUTTING — fix in `components/ShowMore.tsx`, NOT this page.**
`ShowMore.tsx:45` — `if (!canShowMore) return null;`. On the last reveal the focused button leaves the DOM and focus resets to body; next Tab restarts from document top. Assessment: **real a11y defect, moderate severity — SHOULD-FIX, not BLOCKER.** Reasons it isn't a blocker here: (a) it fires exactly once per list, on the final reveal only — intermediate reveals keep the button mounted and focus intact; (b) the page's `aria-live` ListingStat (Ttmik.tsx:394) announces "Showing 40 of 40" so SR users hear the outcome even as focus drops; (c) page stays fully operable. But it is a genuine WCAG 2.4.3 (Focus Order) failure for keyboard users on long lists — after revealing row 31-40 they must re-traverse the whole document to reach them. Affects ALL consumers (Progress, ReviewVocab, both Ttmik listings). Correct fix in the primitive: on the exhausting click, move focus programmatically (first newly-revealed item via a callback/ref contract, or an adjacent status node) before/instead of unmounting. Do not fix per-page.

**SF-2 — Row `aria-label` hides the AudioPill from assistive tech.**
Ttmik.tsx:565, Ttmik.tsx:688 — `aria-label={`Open lesson N: title`}` on the row `<button>`. `role=button` has presentational children; an author `aria-label` REPLACES the subtree name, so the visible "Audio / No audio" pill text (AudioPill, Ttmik.tsx:366 — whose own comment says the state is "never conveyed by iconography alone") is announced to nobody using a screen reader. A SR user browsing the listing cannot tell which lessons have audio — sighted users can. Carried over from rebuild (same labels at rebuild:409/518), but the rows were reworked this phase and the fix is one line: fold the state into the label (`… (no audio)`) or drop the aria-label and let content name the button.

**SF-3 — Hand-rolled tablist while a W3C-compliant `Tabs` primitive (F-032) exists.**
Ttmik.tsx:1050-1072 — `role="tablist"`/`role="tab"` + `aria-selected` but NO `role="tabpanel"`, no `aria-controls`/`aria-labelledby` panel wiring, no roving tabindex, no ArrowLeft/Right/Home/End. `components/Tabs.tsx` implements the full APG pattern and exists precisely to replace hand-rolled strips. CARRIED-OVER F-012 idiom (identical structure in rebuild:250-262) — not introduced by this diff, and not migrating it respects the no-scope-creep rule, so this is a should-fix follow-up, not a fault of this phase. Note the diff DID touch this block (new `visibleLessonTabs` filtering + derived `effectiveTab`), so a migration ticket is warranted. Grammar.tsx/Writing.tsx share only the CSS class, not the roles — this is the last hand-rolled tablist among them.

**SF-4 — DetailView fetch effect keyed on unstable object identity → latent spurious abort+refetch.**
Ttmik.tsx:271 — `parseListenView(searchParams)` runs per render and mints a NEW `view.selection` object each time; DetailView's fetch effect deps are `[selection, reloadTick]` (Ttmik.tsx:880). DetailView is keyed on `selectionKey` (Ttmik.tsx:314), so a *different* selection always remounts — meaning the `selection` dep can only ever re-fire *spuriously*: any parent re-render without a location change (ancestor context/state churn) would abort the in-flight or completed fetch and refetch the same detail, flashing the skeleton. Not currently reproducible in tests (nothing above re-renders Ttmik without navigation) — latent, not live. Cheap hardening: `const view = useMemo(() => parseListenView(searchParams), [searchParams])` (react-router memoizes `searchParams` per location), or dep the effect on `selectionKey(selection)`.

### NIT

**N-1** — `<ol style={{ listStyle: 'none' … }}>` at Ttmik.tsx:1205, 1235, 1345 without explicit `role="list"`: Safari/VoiceOver strips list semantics when `list-style: none`; the `aria-label` names a role the element may no longer expose. Add `role="list"` to keep `getByRole('list', { name })` true in real browsers, not just jsdom.

**N-2** — Malformed-param fallback tested only for ttmik (`?corpus=ttmik&level=0&lesson=abc`, test:428-433); no iyagi twin (`?corpus=iyagi&episode=abc` → listing, no fetch). Same code path shape but different branch of `parseListenView` — one cheap test closes it.

**N-3** — `parsePositiveInt` accepts leading zeros (`level=0001` → 1), so multiple URL spellings address one lesson. Harmless (no fetch amplification, bounded), just non-canonical.

**N-4** — Loading state reuses `.km-grammar__state` (Ttmik.tsx:511, 651) — a Grammar-page-named class on the Listen page. Works (rule lives in shared index.css) but the name lies; a shared `.km-loading-state` alias would stop the drift.

### PRAISE (fix-pass must NOT undo)

- **P-1** — `parseListenView` + `parsePositiveInt` (Ttmik.tsx:221-256): genuinely closed validation — regex-anchored digits, bounded length, closed corpus set, hierarchical fallback — and the tests assert the security property that matters (*no fetch fires on malformed input*), not just the rendered fallback.
- **P-2** — Persistent-player test (test:529-553) asserts DOM node **reference identity** (`toBe`) across sub-tab switches plus single-fetch — the strongest possible guard for the "don't remount the audio" invariant; the code comment at Ttmik.tsx:1007-1012 tells future editors exactly what not to do.
- **P-3** — Derived `effectiveTab` (Ttmik.tsx:981-991) instead of set-state-in-effect: empty-Highlights lessons open on Transcript with zero flash, empty tabs hidden, zero-tab case renders a note instead of an ARIA-invalid empty tablist — all three branches tested (test:480-527).
- **P-4** — Pagination wiring is exactly per the primitive's contract: `remaining` (not `total - visible.length`) feeds the ShowMore label; `max: 990` documents WHY it must exceed corpus size; filter change calls `reset()`; the reset is tested observably (expand to 30 first, then assert 15).
- **P-5** — Stale-filter guard (Ttmik.tsx:467-469): `activeLevel` re-derived against current levels so a refetch that removes a level degrades to "all" instead of an empty list.
- **P-6** — Abort discipline across all four I/O surfaces incl. the page-local add-to-bank controller with rollback + fixed-copy toast; the close-aborts-mine test observes the actual `AbortSignal` mid-flight (test:679-713).
- **P-7** — `buildAudioSrc` left unmocked in tests + its allow-list verified real and anchored — the threat-model comments in the file header match the implementation line for line.

## Coordination observations (for the aggregator)

1. **SF-1 is a Phase-1 primitive defect** — one fix in `components/ShowMore.tsx` clears it for Progress, ReviewVocab, and both Listen listings simultaneously. Do not patch per-consumer. Severity call: SHOULD-FIX (moderate; final-reveal-only, live-region-mitigated for SR, but a real keyboard 2.4.3 failure).
2. **SF-3 migration** (hand-rolled tablist → `Tabs` F-032) should be its own ticket; touching it inside a fix-pass risks the P-2 invariant (the tablist sits ABOVE the persistent `<audio>` — any restructuring must preserve the player's stable child position; the identity test will catch a regression, trust it).
3. `usePagination` default `max: 30` is a foot-gun the page dodged explicitly; any future listing consumer should get the same over-corpus `max` treatment — worth a line in the hook's docblock or a dev-mode warn when `max < items.length` at first render.
4. Deferred B-025/B-026 confirmed handled as data/no-op — no code fault; transcripts render for every line kind incl. `korean: null` corpus rows (fixtures mirror the real 409+2903 null-korean rows — good real-corpus discipline per the standing test rule).
