# REVIEW — Track P client slice ('comic' upload type)

Branch `feat/track-p-comic-upload` (10932f5) vs `origin/rebuild`. Reviewer: independent senior pass. Scope = 7 client files per task. Verified live: `tsc --noEmit` clean; all 3 touched test files pass (86/86); two mutation checks run + restored (tree clean).

## VERDICT: APPROVE — 0 BLOCKERS, 0 SHOULD-FIX, 2 NITs

Matches `docs/CONTENT_INGEST_DESIGN.md` §7 items 2 + 4 exactly; no scope creep.

---

## Probe answers (explicit yes/no)

**1. Type completeness — YES.**
`BookUploadType` gains `'comic'` with a doc comment stating display-only / never grammar-bearing / never auto-OCR'd (client/src/types/domain.ts:2403-2413). Exhaustive consumers enumerated by grep, all updated:
- `TYPE_META: Record<BookUploadType,…>` has `comic` (client/src/pages/Uploads.tsx:79) — consumed at Uploads.tsx:232 (`TYPE_META[upload.type]`), so a missing key would crash the row render; tsc also enforces totality.
- `TYPE_OPTIONS` in the modal has the comic chip (client/src/components/UploadTypeModal.tsx:78).
- `BOOK_SECTIONS` filter (client/src/pages/Reading.tsx:434) — comic gets its own section (see probe 2).
- Remaining `.type` uses are pure passthroughs (client/src/services/uploads.ts:122, wire mapping). No `switch` on `BookUploadType` exists anywhere in client; no `as`-cast or `default:` masks a gap. `tsc --noEmit` exits 0.

**2. Reading.tsx nav — YES on all four sub-points.**
- (a) Comic rows → `/uploads/:id`: `BOOK_SECTIONS` comics entry has `opensViewer: true` (Reading.tsx:318-325); section map passes `onOpenBook={section.opensViewer === true ? openViewer : onOpenBook}` (Reading.tsx:442); `openViewer` = `navigate(`/uploads/${id}`)` (Reading.tsx:388-393). Route confirmed against App.tsx's `/uploads/:id` → UploadViewer. Test-proven (probe 4).
- (b) Other sections' `?book=ID` flow unchanged: the parent `openBook`/chapter-picker code is untouched by the diff; for literature/dialogue/documents `opensViewer` is undefined so the ternary yields the exact same `onOpenBook` prop as before. The 49 pre-existing Reading tests (incl. the U3c deep-link and chapter-picker suites) all still pass.
- (c) `openViewer` is a `useCallback` with `[navigate]` deps using the already-present `useNavigate()` (Reading.tsx:339); declared alongside `refetch` BEFORE the loading/error/empty conditional returns — no hook-rule violation, lint-clean.
- (d) No AbortController changes; the fetch effect (Reading.tsx:346-375) is byte-identical to base.
- Double-listing: 'comic' absent from literature (`['literature']`), dialogue (`['dialogue']`), and documents (`['vocab','grammar','both']`) types arrays (Reading.tsx:317, 326, 331) — a comic appears in exactly one section.

**3. UploadTypeModal — YES.**
Comic chip is a real bilingual option (`en: 'Picture / Comic / Manga', kr: '만화 · 그림책'`, UploadTypeModal.tsx:78) rendered as a button in the type step (same `Bilingual` chip pattern as the other five); clicking it calls `setType('comic')` which flips `step` to 'file' (UploadTypeModal.tsx:104, step derivation `type === null ? 'type' : 'file'`). The 2-step flow, reset-on-close, abort handling, and title-cap logic are all untouched (1-line diff to this file).

**4. Tests real, not tautologies — YES, mutation-verified.**
- NAV test (Reading.test.tsx:1110-1128): uses `renderReadingWithViewerRoute()` — a real `MemoryRouter` with a `/uploads/:id` route whose `UploadViewerProbe` renders `${id}${location.search}` (Reading.test.tsx:1012-1032, pre-existing U3c infra). Asserts `probe.textContent === COMIC_READY.id` ('77') — this is `.toBe`, so ANY query string (incl. `?book=`) fails it — plus `readingSvc.listChapters` never called. This proves the actual navigation outcome, not a `navigate` spy detail.
- GROUPING test (Reading.test.tsx:1083-1108): seeds literature + comic + grammar uploads; asserts the comic's Open button is inside the 'Comics & Picture Books' region AND `queryByText(title)` is absent from both the Literature and Documents regions.
- **Revert catch — YES, empirically.** Mutation 1: replaced the ternary with plain `onOpenBook` → nav test fails (1/50). Mutation 2: deleted the comics `BOOK_SECTIONS` entry → both Track P tests fail (2/50); tsc would NOT catch that one, so the tests are the only net — and they hold. Both mutations restored; `git status` clean.
- UploadTypeModal.test.tsx:233-249: clicks the comic chip, uploads a zip, asserts `uploadBook` called once with `mock.calls[0][1] === 'comic'` (arg 1 = the `type` param of `uploadBook(file, type, title, …)`, services/uploads.ts:256) — proves the type survives chip→submit. A removed chip fails at `getByRole`. The five→six chip-count test (line 96) totalizes via `Record<BookUploadType,string>`.
- Uploads.test.tsx:110-127: renders a `type:'comic'` row, asserts the visible bilingual 'Comic / Manga' pill. Reverting `TYPE_META.comic` breaks compile AND crashes the render — fails either way.

**5. a11y + consistency — YES, with 2 NITs below.**
Section: `<section aria-label={en}>` + bilingual `<h2>` via `Bilingual` — identical to the three existing sections (Reading.tsx:471-475). Modal chip: real `<Button>` with `Bilingual` label, same as siblings. No `dangerouslySetInnerHTML` in any touched file (Reading.tsx:63 documents its absence); server text (titles) rendered as escaped JSX children only. No scope creep — diff touches exactly the 7 in-scope files, 139 insertions, all Track P.

---

## Findings

### BLOCKER
None.

### SHOULD-FIX
None.

### NIT
1. **Label copy diverges between the modal and the Uploads pill.** All five pre-existing types share byte-identical en/kr copy between `TYPE_OPTIONS` (UploadTypeModal.tsx:73-77) and `TYPE_META` (Uploads.tsx:74-78). Comic breaks the 1:1: modal says 'Picture / Comic / Manga' / '만화 · 그림책' but the pill says 'Comic / Manga' / '만화' (Uploads.tsx:79) — a picture-book (그림책) upload shows a '만화' (comic) pill. Likely a deliberate shortening for pill width, but it's the only divergent pair; either align the copy or add a one-line comment stating the shortening is intentional.
2. **`opensViewer?: true` + `=== true` check** (Reading.tsx:315, 442) — the literal-`true` optional type plus explicit comparison is slightly belt-and-suspenders where a plain `opensViewer?: boolean` + truthy check would read the same; harmless, and the literal type does prevent an accidental `opensViewer: false` half-state. Fine to leave.

### PRAISE
- The nav test asserts the OUTCOME (rendered route param, empty query string, `listChapters` untouched) via the reused U3c route-probe pattern — this is exactly how to make a navigation test revert-proof, and both mutations confirmed it bites.
- `BOOK_SECTIONS`' doc comment (Reading.tsx:298-308) explains WHY comics bypass the picker (no `reading_chapters` → `?book=ID` dead-ends), and `domain.ts` documents the type's never-OCR'd contract at the type itself — future readers won't re-derive the design.
- The modal test asserts the `type` argument on the service boundary rather than UI state, catching the silent-mis-mapped-chip failure mode its own comment describes.

## "Would the nav + grouping tests catch a revert?" — YES (both, empirically mutation-tested; see probe 4).
