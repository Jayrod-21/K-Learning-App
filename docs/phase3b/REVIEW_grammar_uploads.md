# Phase 3B Review — ReviewGrammar + Uploads + UploadViewer

- **Reviewer:** independent senior review (did not write this code; report-only)
- **Date:** 2026-07-10
- **Branch:** `feat/phase3b-library` vs `rebuild`
- **Scope:** `client/src/pages/review/ReviewGrammar.{tsx,css,test.tsx}`, `client/src/pages/Uploads.{tsx,test.tsx}`, `client/src/pages/UploadViewer.{tsx,css,test.tsx}`; server sampling of `server/src/routes/grammar.ts` (GET /grammar/kgiu) and `server/src/routes/uploads.ts`

## Summary verdict

**PASS with 0 BLOCKERs, 3 SHOULD-FIX, 8 NIT.** The work is honest, well-tested,
and traceable ticket-by-ticket. The F-057 rotation geometry is mathematically
correct and tested with real numbers, both stubs (F-056 uploads-grammar, F-059
OCR) are genuinely honest, the F-058 respec is sound in code, and the
shared-helper orphan cross-check comes back clean: **none of `LibrarySubnav`,
`SearchBox`, `FilterGroup`, `DOMAIN_FILTERS`, `useDebouncedSearch` is
orphaned** in the merged tree. The top finding is an ARIA-conformance gap:
ReviewGrammar hand-rolls a `role="tablist"` strip without the keyboard/panel
contract those roles promise, while the project's own shared `Tabs` component
(F-032) implements the full W3C APG pattern and exists precisely for new
overhaul sections.

## Quality-bar checklist

| Bar | Verdict | Notes |
|---|---|---|
| WCAG AA — rotation/zoom/fit keyboard-operable + labeled | PASS | All native `<button>`s via shared `Button`; every control has an accessible name; rotate's name carries current angle (`UploadViewer.tsx:709-720`); "coming soon" is in the visible label, not tooltip-only |
| Correct ARIA | PARTIAL | One gap: hand-rolled tablist in ReviewGrammar (SF-1). Everything else correct: labelled native `<select>` (FilterSelect), `role="status"` loading states, `aria-live="polite"` pager, `aria-pressed` on bank/reorder toggles, labelled `role="group"` for reorder controls |
| Strict TS at I/O boundaries | PASS | Wire→domain mapping types in `services/uploads.ts:78-123`; `toLevelFilter` narrows the DOM string back onto the closed vocabulary (`ReviewGrammar.tsx:99-102`); `parseInitialPage` strictly validates `?page=` (`UploadViewer.tsx:139-143`); server zod-validates + ownership-guards `source_upload_id` (`routes/grammar.ts:55,97-103`) |
| No swallowed errors | PASS | Every fetch abortable with `signal.aborted` guards; real ErrorCard + Retry on meta/pages/list/detail/browse/uploads paths; per-page `<img>` failure → Retry with cache-bust; reorder failure → rollback + fixed-copy toast. The two intentional best-effort catches (bank-list at `ReviewGrammar.tsx:147-149`, SourceFilterRow) are documented with sound rationale |
| Tests exercise real behavior | PASS | Rotation test stubs `clientWidth`/`naturalWidth` and asserts computed 800×533.33 px rotated box (`UploadViewer.test.tsx:380-412`) — real geometry, not tautology; F-058 test feeds ghost + lifecycle rows and asserts exclusion set (`Uploads.test.tsx:191-215`); F-054 removals asserted as regressions including "no fetch ever carries `domain`/`q`" (`ReviewGrammar.test.tsx:157-186`) |
| Co-located CSS | PASS | `ReviewGrammar.css` + `UploadViewer.css` new, co-located, every class consumed; commit even moved previously-inline viewer styles into the CSS file |
| No scope creep | PASS | Reorder tool pre-exists on `rebuild` (38 grep hits) — this branch only hardened it (Enter-bypass guard). ReviewLibrary + `nav.ts` touches in the uploads commit are justified and ticketed (F-039 pre-deploy blocker, F-100) |
| No console.log / TODO-without-ticket / dead imports | PASS | Zero hits across all 8 in-scope files; lint + tsc green |

## Findings by severity

### BLOCKER — none

### SHOULD-FIX

**SF-1 — Hand-rolled `role="tablist"` without the ARIA tabs contract.**
`ReviewGrammar.tsx:244-266`. The Browse/Uploads strip uses `role="tablist"` +
`role="tab"` + `aria-selected`, but: no roving tabindex, no
ArrowLeft/ArrowRight/Home/End handling, no `role="tabpanel"`, no
`aria-controls`. Using the tab roles signals the APG keyboard model to AT
users and then doesn't deliver it. Not a blocker — both tabs are native
buttons in the tab order with proper names, so nothing is inoperable — but
the project already has the correct primitive: `components/Tabs.tsx` (F-032)
implements the full W3C pattern and its header explicitly says it is "the
shared primitive the overhaul's new sections mount instead" of hand-rolled
strips. Phase 3B is that overhaul. Fix: mount `Tabs` (or copy its roving
tabindex + tabpanel wiring). Note the same hand-rolled idiom exists on older
pages (Grammar.tsx, Review.tsx, Hanja.tsx, Topik.tsx, Ttmik.tsx) — those are
out of scope, but new code should not add another instance.

**SF-2 — F-058 respec is documented in code + commit but not where the ticket
lives, and the code cites a phase report that does not exist.**
The respec itself is sound and honest (see "F-058 verification" below), and
it IS written down — `Uploads.tsx:11-23` module header and the `eacc4a4`
commit body both explain it. But `BUGS_AND_FEATURES.md:889` still carries the
literal "Uploads listing shows only PDF versions", status 🔴 open, with no
disposition note, and `Uploads.tsx:23` says "ticketed, see the F-058
disposition note in the phase report" — no phase report exists in the tree
(`docs/phase3b/` was absent before this review file). A future reader
following that pointer finds nothing, and the ticket as written diverges from
what shipped. Fix: add the disposition note to the F-058 ticket entry (respec
to viewable-rendition filter; literal source-format filter needs the server
to retain `source_format` — file that as the follow-up), and either write the
phase report or point the header at the ticket instead.

**SF-3 — Delete confirm gate fails open.**
`Uploads.tsx:139-143`: `typeof window !== 'undefined' ? window.confirm(...) :
true`. In any environment without `window`, the guard on a destructive,
irreversible delete resolves to "confirmed". This is unreachable in the
current client-only SPA (and tests stub `confirm`), but a safety gate's
defensive default should fail closed. One-token fix: `: false`.

### NIT

**N-1 — Dead client option surface: `ListPatternsOptions.q`.**
`client/src/services/grammar.ts:29`. After F-054 removed the search box, no
caller passes `q` (the only `listPatterns` consumers are `pages/Grammar.tsx`
and `ReviewGrammar.tsx`, neither sends it). The server keeps the param
(other-consumer back-compat is fine server-side), but the client-side typed
option is now dead. Remove it or annotate why it stays.

**N-2 — Browse refetch shows stale rows + stale count with no loading cue.**
`ReviewGrammar.tsx:454-491`: the loading state renders only when
`rows.length === 0`, so a difficulty-filter change silently shows the
previous rows (and their count) until the new fetch settles. The error case
is correctly handled (stale rows hidden); the in-flight case isn't.

**N-3 — `remove()` delete has no AbortSignal.**
`Uploads.tsx:137-158`: `deleteUpload(upload.id)` is called without a signal,
so a settle after unmount writes state to an unmounted component. Harmless in
React 18 and arguably intentional (you don't want to abort a delete
mid-flight), but it's inconsistent with the module's own abort discipline —
a comment or a signal would settle it.

**N-4 — Ghost upload deep-linked directly shows "still processing" forever.**
`UploadViewer.tsx:615-623`: a `ready` upload with 0 pages (the same pre-041
ghost F-058 hides from the listing) falls into the `!canView` branch and
renders "still processing — check back shortly", which is never true for it.
Reachable only via stale bookmark/typed URL. A `status === 'ready'` +
no-pages check could render honest "no viewable pages" copy (the copy already
exists for the `failed` branch).

**N-5 — Grammar-named class as generic loading style.**
`.km-grammar__state` (defined `styles/index.css:2974`) is used as the loading
indicator on Uploads and UploadViewer. Pre-existing global class, works fine,
but the name is now a cross-page coupling — a later grammar-page cleanup
could break upload pages.

**N-6 — Duplicate `listUploads` fetches on ReviewGrammar.**
Browse's `SourceFilterRow` fetches `/uploads` on mount, and the Uploads view
fetches it again on tab switch. Bounded and cheap for a personal corpus; a
shared fetch would be tidier.

**N-7 — One test name overclaims.**
`UploadViewer.test.tsx:248-252` "normal navigation never appends a cache-bust
query param" asserts only the initial page-1 URL — it never navigates. The
actual nav-resets-cache-bust behavior IS covered by the test at lines
270-283, so no coverage gap; rename or fold the weaker test.

**N-8 — Single `pendingKey` slot for bank actions.**
`ReviewGrammar.tsx:132,190-219`: banking row B while row A's POST is in
flight lets A's `finally` clear B's pending indicator. Cosmetic only — the
optimistic flip has already happened and the server path is idempotent
(409 → keep flip) — but a `Set<string>` would be exact.

### PRAISE (fix-pass must not undo)

- **P-1 — Rotated-box geometry is correct and honestly tested.**
  `pageLayout` (`UploadViewer.tsx:167-228`): quarter turns size an explicit
  wrapper to the rotated dimensions from measured container width × natural
  aspect (`displayW = containerWidth · zoom`; `displayH = displayW · w/h` —
  verified: img CSS height = displayW with `width:auto` yields post-rotation
  visual box displayW × displayW·w/h, exactly the wrapper's box), so layout
  and scroll extent stay honest. The test drives it with real stubbed
  dimensions and asserts the computed 533.33 px. The 0°/180° box-preserving
  shortcut and the pre-load fallback branch are both correctly reasoned.
- **P-2 — Zoom respec from `transform: scale()` to real width.** The old
  `rebuild` viewer used `transform: scale(...)` (confirmed at old
  `UploadViewer.tsx:408`), which desyncs layout box from painted pixels; the
  new width-based model with fit-width = 1 is the right fix, and the
  cache-bust-only-on-explicit-retry design (`services/uploads.ts:138-157` +
  `pageUrl` contract mirrored faithfully in the test mock) is a genuinely
  sharp piece of engineering.
- **P-3 — Honest stubs, both of them.** F-059: disabled button, visible
  "Extract text (coming soon)" copy, no endpoint call, ticket + server-header
  cross-reference in the code (`UploadViewer.tsx:745-756`). F-056: wired to
  the REAL ownership-guarded endpoint (verified server-side: zod-coerced id +
  SQL `EXISTS` guard on `book_uploads.user_id`, `routes/grammar.ts:97-103`),
  renders an honest empty state, nothing fabricated, U2 dependency documented
  at the file header.
- **P-4 — Removal-as-regression tests.** F-054's removals are pinned by
  tests that assert the absence of the search box, genre filter, and section
  strip AND that no fetch ever carries `domain`/`q`
  (`ReviewGrammar.test.tsx:157-186`) — the removals can't silently creep back.
- **P-5 — Defensive races closed with tests that prove the mechanism.** The
  Enter-key in-flight bypass guard on reorder (`UploadViewer.tsx:517-528` +
  test at `UploadViewer.test.tsx:542-565`) and the pending-delete row-open
  gate (`Uploads.tsx:213-222` + test at `Uploads.test.tsx:285-318`) both test
  the exact bypass path, not the happy path.
- **P-6 — Fixed-copy discipline.** Every error surface renders fixed copy and
  the tests assert the server prose does NOT render (e.g. "constraint
  violation xyz" checks).

## F-058 respec verification (ticket check)

The respec is **sound**. Verified against the server: migration 041 keeps
only normalized page images (route header: "NO extraction/OCR happens here");
there is no `source_format` column, so a literal "PDF-only" filter is
unimplementable client-side and would misfire on zip-based corpus books.
`hasViewableRendition` (`Uploads.tsx:82-85`) keeps `processing`/`failed`
lifecycle rows (correct — they're real renditions in flight or needing
attention) and drops only `ready`-with-no-pages ghosts, which the viewer can
never render. Tests cover both ghost shapes (missing and `pageCount: 0`) and
both lifecycle keeps. The only gap is documentation placement — see SF-2.

## Coordination observations

- **Shared-helper orphan cross-check (the flagged risk): CLEAN.** The grammar
  builder's claim held even after ReviewVocab/ReviewDictionary were reworked
  in parallel. Verified by import in the merged tree, not by comment:
  - `LibrarySubnav` → `ReviewVocab.tsx:52`, `ReviewDictionary.tsx:39`,
    `ReviewLibrary.tsx` (+ its own test)
  - `SearchBox` → `ReviewVocab.tsx:51`, `ReviewDictionary.tsx:38`
  - `useDebouncedSearch` → `ReviewVocab.tsx:60`, `ReviewDictionary.tsx:41`
  - `DOMAIN_FILTERS` → `ReviewVocab.tsx` (libraryFilters import at 67),
    `ReviewDictionary.tsx:42`
  - `FilterGroup` → `SourceFilterRow.tsx:27` (which ReviewGrammar itself
    still mounts)
  No orphaned exports in `lib/libraryFilters.ts` either (`GRAMMAR_LEVEL_FILTERS`,
  `GRAMMAR_PAGE_SIZE`, `PAGE_SIZE`, `VOCAB_LEVEL_FILTERS` all consumed).
- **Merge hygiene:** five parallel feature branches merged cleanly into
  `phase3b-library`; the uploads commit's cross-page touches (ReviewLibrary
  Uploads row going live, `nav.ts` F-100 comment) are the two things the
  backlog explicitly scheduled for this landing — good coordination, not creep.
- **Divergent tab-strip idioms across the parallel branches:** ReviewGrammar
  hand-rolled its tablist (SF-1) while the shared `Tabs` (F-032) sat unused;
  `LibrarySubnav` predates `Tabs` and rolls its own roving focus. Worth a
  phase-wide consolidation ticket so the next parallel build doesn't mint a
  fourth variant.
- **Contract-note hygiene worth copying:** `services/uploads.ts:54-61`
  explicitly retired a stale "KNOWN CROSS-AGENT CONTRACT GAP" note after
  verifying the server route landed — exactly how parallel-branch contract
  notes should be closed out.
