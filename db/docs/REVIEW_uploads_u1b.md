# Review — U1b client (PDF book-upload feature, commit `39154d1`)

Reviewer: independent senior review (not the author). Scope: client-side U1b
per `db/docs/PDF_UPLOAD_DESIGN.md` §"U1 → U1b client". Verified against the
actual server (U1a, commits `8ddadae`/`95d3ed4`), not just client-side claims.

## Verdict: **PASS — no blockers.**

Verification run (`node:20-slim` container, clean `npm ci`):
- `tsc -b --force` → exit 0.
- `eslint .` → exit 0.
- `vitest run` (full suite) → **1084/1084 passed** (95 files), matches the
  commit message exactly. Targeted slice (Uploads/UploadViewer/UploadTypeModal/
  review/Settings) → 127/127.
- `vite build` → succeeds; `dist/assets/pdf.worker.min-FHbmGBN0.mjs`
  (1.24 MB, content-hashed) confirms the worker is a bundled same-origin
  asset, not a CDN reference.

## Answers to the five probe questions

**(a) Does the pdf worker bundle, never CDN?** Yes, confirmed two ways: (1)
static — `UploadViewer.tsx:1541` imports
`pdfjs-dist/build/pdf.worker.min.mjs?url` (Vite asset-URL form, resolves at
build time to a same-origin hashed path, no runtime network fetch to
resolve the import itself); (2) dynamic — the actual `npm run build` output
emits `dist/assets/pdf.worker.min-FHbmGBN0.mjs` and the app's own JS
references that hashed path. No `cdn.jsdelivr.net`/unpkg string anywhere in
the diff. `GlobalWorkerOptions.workerSrc` is set once at module scope
(`UploadViewer.tsx:1550`), not per-render/per-mount — correct, matches
pdf.js's own recommended pattern, and avoids any risk of two components
racing to set it differently.

Version pin: `pdfjs-dist@5.6.205` requires Node `>=20.19.0 || >=22.13.0 ||
>=24` (package-lock, line ~314). CI (`node-version: 20`) resolves to a
current 20.x (verified in-container: node 20.20.2 — satisfies the floor);
the stated "v6 needs node22, verify=node20" reasoning in the commit message
checks out as the correct call for staying on v5.

One incidental finding, not a blocker: Workbox's PWA precache glob
(`vite.config.ts:110`, `globPatterns: ['**/*.{js,css,html,svg,woff2,png}']`)
doesn't match `.mjs`, so the 1.24 MB worker is (accidentally, not by an
explicit exclude) kept out of the offline-install precache. Fragile if
pdfjs-dist ever ships the worker with a `.js` extension in a later bump —
worth an explicit `globIgnores`/comment rather than relying on the
coincidence, but not a U1b blocker (SHOULD-FIX, see below).

**(b) Can the viewer leak or set-state-after-unmount on a big-PDF nav?** No.
Verified in `UploadViewer.tsx`:
- `aliveRef` gates every async continuation (`load`'s `.then/.catch`,
  `renderPage`'s post-await checks, `fitWidth`'s post-await check) against
  both real unmount and route-param (`id`) changes without unmount.
- `teardown()` (lines 1579-1587) cancels the in-flight `RenderTask`,
  destroys the `loadingTask`, and destroys the `PDFDocumentProxy` — called
  from both the mount effect's cleanup AND the start of every `load()`, so a
  retry or an `id` change never leaks the *previous* attempt's resources.
- Identity checks (`loadingTaskRef.current !== loadingTask`,
  `docRef.current !== doc`) additionally guard against a stale continuation
  overwriting state set by a newer load — not just an unmount race.
- `RenderingCancelledException` is caught and swallowed distinctly from a
  genuine render error (`renderPage`'s catch block) — a fast page-flip or
  zoom drag cancelling the previous render never flips the UI to the error
  state.
- Test coverage directly exercises this: `UploadViewer.test.tsx`'s teardown
  describe block asserts `doc.destroy()` fires on unmount.
- Paged (not virtualized-scroll) rendering means a 200-300pp PDF costs one
  page's raster work per nav tap, never all pages at once — reasonable
  given the design doc's stated volume (~10 books, 200-300pp).

**(c) Does the `/uploads/:id/file` fetch reach the server (Accept), with
auth?** Yes, confirmed both sides:
- Client: `getDocument({ url: pdfFileUrl(id), withCredentials: true })` —
  pdf.js does its own fetch/XHR outside axios, and `withCredentials` is a
  real, typed pdf.js `DocumentInitParameters` field (confirmed in
  `node_modules/pdfjs-dist/types/src/display/api.d.ts:34`) — it actually
  sends the session cookie, this isn't a no-op flag.
- Server: `server/src/routes/uploads.ts` mounts `router.use(requireAuth)`
  (auth-gated) and the `GET /:id/file` handler sets
  `Content-Type: application/pdf` + `X-Content-Type-Options: nosniff` +
  `Content-Disposition: inline` — never `text/html`, so nginx's
  `Accept: text/html` SPA-shadow split (the mechanism the App.tsx comment
  describes) can't misroute it: a browser full-page nav to `/uploads/:id`
  (text/html Accept) gets the SPA; the viewer's own `getDocument` fetch
  (non-text/html Accept, pdf.js sets its own) reaches the API. `/uploads` is
  present in the nginx allow-list regex in both
  `Deploy/nginx-{blue,green}-active.conf`, all 4 locations, from the prior
  U1a commit (`8ddadae`) — U1b correctly added no redirect of its own.
- IDOR: every uploads route scopes by `user_id` (`WHERE id = $1 AND
  user_id = $2`), 404 uniformly for "not mine" vs. "doesn't exist" — the
  client never has to reason about ownership.

**(d) Does `source_upload_id` 400 anywhere?** No. Verified server-side:
`VocabSearchQuerySchema` (`server/src/routes/vocab.ts`) and
`KgiuSearchQuerySchema` (`server/src/routes/grammar.ts`) are both plain
`z.object({...})` with no `.strict()` call — Zod's default behavior silently
strips unrecognized keys rather than erroring. This is a deliberate,
pre-existing codebase convention (a sibling schema in `vocab.ts` has an
explicit comment to this effect), and contrasts correctly with the request
*bodies* elsewhere in the app (settings/hanja/topik/uploads), which DO use
`.strict()` as mass-assignment defense — the distinction between a strict
body-schema and a lenient query-schema is intentional, not an oversight.
`source_upload_id` is therefore a genuine safe no-op today, exactly as the
client-side comments claim — this was independently verified against the
server code, not taken on faith from the client comment.

**(e) Any Settings/library regression?** No functional regression found.
- `Settings.tsx` now calls `useNavigate()`; `Settings.test.tsx` wraps the
  render helper in `MemoryRouter` (alongside the existing
  Theme/Toast/SettingsProvider nesting) — full suite run confirms all
  31 Settings tests pass, including MFA re-enroll/regenerate flows deep in
  the file, so the Router wrap didn't disturb anything else on the page.
- `ReviewVocab`/`ReviewGrammar`: `SourceFilterRow` is additive — both pages'
  existing domain/book_level `FilterGroup` filters are untouched, the new
  row renders `null` (no DOM at all) when `listUploads()` returns zero ready
  uploads, and every PRE-EXISTING test in both files still passes because
  their `uploadsSvc.listUploads` mock defaults to `[]`. New source-filter
  tests confirm processing-status uploads are excluded from the chip list
  (only `ready` uploads become filter options) and that selecting a chip
  sets `source_upload_id` on the list call.
- Full 1084/1084 suite passing, plus a clean `tsc -b`/`eslint`/`build`, is
  strong evidence against a silent cross-page regression.

## Findings

**BLOCKER:** none.

**SHOULD-FIX:**

1. `client/vite.config.ts:110` — the PWA precache `globPatterns` excludes the
   1.24 MB pdf.worker only because its extension is `.mjs` and the glob only
   lists `.js`. That's currently a happy accident, not a design decision — a
   future pdfjs-dist bump that ships `pdf.worker.min.js` would silently pull
   a 1.24 MB file into every user's offline-install precache. Add an
   explicit `globIgnores: ['**/pdf.worker*']` (or similar) with a one-line
   comment so this stays excluded on purpose rather than by luck of the
   current filename.

2. `client/src/App.tsx` / `pages/UploadViewer.tsx` — `pdfjs-dist` is a
   static top-level import, so its (non-worker) core module ships in the
   app's single main JS chunk (`dist/assets/index-*.js`, 1067 KB / 320 KB
   gzip per the build output) for every user, including the majority who
   never open a PDF viewer. The app doesn't currently code-split any route
   (`App.tsx` has zero `React.lazy` usage anywhere), so this isn't a
   regression U1b introduced on its own — it's consistent with existing
   practice — but `pdfjs-dist` is the single heaviest new dependency added
   to that shared bundle to date, and it's the first page in the app whose
   cost is genuinely usage-gated (most users won't view a PDF every
   session). Worth a follow-up to lazy-load `UploadViewer` specifically
   (`React.lazy(() => import('./pages/UploadViewer'))`) rather than
   deferring to the pre-existing no-code-splitting norm.

**NIT:**

3. `UploadTypeModal.tsx:906-909` — the empty-title guard
   (`if (trimmedTitle === '') { setError('Give the book a title.'); return; }`)
   is dead code in the UI as currently wired: the submit button is already
   `disabled={!file || title.trim() === '' || uploading}`
   (`UploadTypeModal.tsx:1044`), so a user can never actually trigger
   `submit()` with a blank title through the rendered UI. Harmless
   belt-and-suspenders (defends a future caller who invokes `submit`
   differently), but slightly misleading as written since nothing currently
   exercises that branch — a short comment noting it's defense-in-depth
   would remove the ambiguity for the next reader.

4. `pages/Uploads.tsx` and `pages/UploadViewer.tsx` both duplicate the
   `formatBytes`/byte-size-in-B/KB/MB formatting pattern that likely already
   exists for `image_captures` (`services/images.ts`'s callers almost
   certainly format sizes similarly) — not verified to be an exact
   duplicate, but worth a `/wasden-consolidate`-style pass in a later phase
   if the pattern repeats a third time.

**PRAISE:**

- The abort/teardown discipline in both `UploadTypeModal` and
  `UploadViewer` is genuinely careful — not just "abort on unmount" but
  correctly distinguishing a stale-continuation race (route `id` changed,
  same instance) from a real unmount, and distinguishing pdf.js's own
  `RenderingCancelledException` (expected, from `.cancel()`) from a real
  render failure. This is exactly the class of bug ("blank canvas after a
  fast double-tap on next-page") that's easy to ship silently broken and
  hard to catch in manual testing.
- The `source_upload_id` scaffolding is honest about being inert: the
  `SourceFilterRow` header doc, the `SearchEntriesOptions`/
  `ListPatternsOptions` field docs, and the component's hide-when-empty
  behavior all say the same true thing rather than presenting fake-working
  UI. The tests for "processing uploads don't become chips" show real care
  about the exact contract (only `ready` uploads are useful as filters).
  Independently re-verified server-side (not just trusted from the
  comment) that the unrecognized param is genuinely a schema no-op, not an
  assumption resting on the client author's word.
- Error-copy discipline (`bookUploadErrorMessage`) correctly mirrors the
  existing `imageUploadErrorMessage` shape and its 429-with/without-
  `retryAfter` discriminator — independently confirmed against the server's
  `DailyCapError` (429, no `retry_after` field set) vs. the rate limiter's
  429 (which does carry one) — so the "which copy to show" logic is
  actually correct, not just plausible-looking.
- Test suite is non-vacuous: pdfjs-dist is fully mocked (correctly, per the
  stated policy of never exercising real PDF rendering in vitest), but the
  assertions that matter — `workerSrc` set to the bundled URL,
  `getDocument` called with the real `pdfFileUrl`-derived URL and
  `withCredentials: true`, teardown calling `doc.destroy()` on unmount,
  cancellation vs. real-error branching — are all present and specific
  rather than smoke-test-shaped.

## Test adequacy note

The 54 new tests (1084 total vs. a documented prior baseline of 1030) are
concrete and behavior-specific rather than shape-only: they assert exact
wire payloads (`FormData` contents, trimmed title, `AbortSignal` identity),
exact user-facing copy (never raw server prose), and exact call arguments
(`workerSrc`, `getDocument({ url, withCredentials })`). No test was found
that merely renders a component and checks it didn't throw without also
asserting a specific outcome.
