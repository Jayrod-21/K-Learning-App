# Review — F-012 Listen Screen (client UI)

**Scope:** `client/src/pages/Ttmik.tsx` (+ `Ttmik.test.tsx`), `client/src/services/ttmik.ts`
(+ `ttmik.test.ts`), `client/src/types/domain.ts` (F-012 section), `client/src/App.tsx`,
`client/src/lib/nav.ts`. Branch: `feat/ttmik-audio`. Reviewer: independent, read-only.

## Verdict

**Do not ship as-is.** One BLOCKER: `buildAudioSrc`'s off-origin rejection is bypassable with a
well-known WHATWG URL-parsing quirk (backslash / tab normalization), which defeats the exact
security property the code's own doc comments claim to provide, and there is no compensating
control (no CSP `media-src`/`default-src` header on the document response in this deploy — see
Detailed §1). Everything else on this screen — player choice, read-along escaping, state handling,
a11y, routing, and test coverage of the happy/empty/error paths — is genuinely solid, better than
average for this class of feature.

## Findings

### BLOCKER

1. **`buildAudioSrc` off-origin check is bypassable via backslash/control-char URL normalization**
   (`client/src/services/ttmik.ts:102`). The guard only rejects a literal `//` prefix. Browsers
   (and Node's spec-compliant `URL`, verified empirically below) treat a backslash the same as a
   forward slash in the path of a "special" scheme (http/https/etc.), and strip embedded tab/
   newline characters before parsing. An `audioUrl` of `"/\\evil.example/a.mp3"` (or
   `"/\t/evil.example/a.mp3"`) passes both conditions (`startsWith('/')` true, `startsWith('//')`
   false) and is returned verbatim when `base === ''` (the documented prod same-origin path), then
   handed straight to `<audio src>`. The browser resolves it to `http://evil.example/a.mp3` —
   exactly the attacker-origin redirect the code's threat-model comments (`Ttmik.tsx:24-29`,
   `ttmik.ts:90-93`) claim is defended against. This is not theoretical — confirmed with Node 20's
   WHATWG `URL`:
   ```
   new URL('/\\evil.example/a.mp3', 'http://localhost:3000').href
   → 'http://evil.example/a.mp3'   (hostname: evil.example)
   ```
   The `base + audioUrl` (dev, split-origin) branch is *not* exploitable the same way — verified
   separately that once an authority is already fixed in the string (`http://localhost:4000`), the
   trailing `\` normalizes to a same-host path segment, not a new authority. So the exposure is
   specifically the prod/`base === ''` branch, which per the file's own comments is the primary
   deployment mode.
   No compensating control: `server/src/app.ts:46` runs bare `helmet()`, whose default CSP has no
   `media-src` directive (falls back to `default-src 'self'` — checked in
   `server/node_modules/helmet/index.cjs`), but that header is attached to the **API's** JSON
   responses, not to the HTML document (the Express app has no `express.static`/`sendFile` route —
   grepped `app.ts`, none found). `Deploy/nginx.conf`, which is what actually serves the built SPA,
   sets no `Content-Security-Policy` header at all. So there is nothing at the infra layer to catch
   this if the client-side check is bypassed.
   **Exploit precondition:** the attacker needs to get a value of this shape into a detail
   response's `audioUrl` — i.e. a corpus-loader bug, a compromised DB row, or a compromised/MITM'd
   response. That's a real, if not trivial, precondition; it does not make this a non-issue —
   defense-in-depth at the boundary that actually renders the value is the point, and the code
   explicitly (and now incorrectly) claims to provide it.
   **Fix direction:** don't reason about this with string prefixes at all. The set of legal
   `audioUrl` values is small and server-known (`/ttmik/lessons/:level/:number/audio`,
   `/iyagi/episodes/:number/audio`) — validate against a strict allow-list regex
   (`/^\/ttmik\/lessons\/\d+\/\d+\/audio$/`, `/^\/iyagi\/episodes\/\d+\/audio$/`) instead of a
   generic "looks app-relative" heuristic. That removes the entire class of URL-parsing-ambiguity
   bugs (backslash, tab/CR/LF stripping, and any other WHATWG quirk) rather than patching this one
   instance of it.

### SHOULD-FIX

1. **No regression test for the bypass class.** `ttmik.test.ts:164-168` covers `https://…`, `//…`,
   and a bare-hostname string, but nothing with an embedded backslash or control character — the
   exact shape that defeats the current check. Per the bar's "every bug fix ships with a test that
   fails on the old code," once BLOCKER #1 is fixed, add cases for `"/\\evil.example/x"` and
   `"/\t/evil.example/x"` (and ideally assert the *resolved* URL's origin via `new URL(src, ...)`,
   not just string equality, so a future refactor can't silently reopen the class).
2. **Redundant `ctrlRef.current?.abort()` at the top of all three fetch effects**
   (`Ttmik.tsx:213-215`, `330-332`, `466-468`). By the time the effect body runs again, React has
   already invoked the previous run's cleanup (`ctrl.abort()`), so `ctrlRef.current` is already an
   aborted controller — the extra abort call is a no-op. Harmless, but it's dead code and `ctrlRef`
   itself serves no purpose beyond it (nothing else reads it). Low priority since it mirrors an
   existing convention elsewhere in the app ("same documented exception the Reference tabs use") —
   worth a follow-up cleanup across all call sites at once rather than diverging just here.

### NIT

1. `ErrorCard`'s own doc (`components/ErrorCard.tsx`) states its `message` prop must be
   "author-controlled / from a fixed lookup, never an echo of an untrusted server message," but
   `Ttmik.tsx` passes `err.message` straight through for `ApiError` (e.g. `Ttmik.tsx:231-233`,
   `349-353`, `485-488`), and `ApiError.message` can carry the server's `error.message` body
   (`services/api.ts:99-102`). Rendered as an escaped React text child, so no XSS — this is a
   documentation/contract nit, not a vulnerability. Pre-existing, identical pattern across the app
   (`Reference.tsx`, `Grammar.tsx` do the same), so it's not a regression introduced by this diff;
   flagging only because the component doc explicitly disclaims it.
2. `<audio style={{ width: '100%' }}>` (`Ttmik.tsx:544`) is an inline style where Tailwind is
   available in this project. Matches the prevailing idiom throughout the rest of the app (extensive
   inline `style` use on `Card`/`Eyebrow`/etc. elsewhere), so not a deviation introduced here —
   noting only for completeness against the bar's §2.5 preference.

### PRAISE

- Real `<audio controls>` streaming element, explicitly *not* the `AudioBlock` placeholder — the
  doc comment calls that out by name (`Ttmik.tsx:21-22`) so a future reader can't confuse the two.
- Every transcript field (`korean`, `english`, `romanization`, `speaker`) renders as a plain React
  text child — no `dangerouslySetInnerHTML` anywhere on the screen. Confirmed by grep: zero hits in
  `Ttmik.tsx`.
- Consistent, correct stale-response handling: every one of the three fetch effects
  (`TtmikLessonsTab`, `IyagiEpisodesTab`, `DetailView`) uses a fresh `AbortController` per run,
  checks `signal.aborted` before each `setState`, and swallows the `ApiError('canceled')` case
  distinctly from a real failure.
- Defensive re-sorting (lessons by level/number, episodes by number, sentences by ordinal) even
  though the server already orders — cheap insurance against an upstream ordering regression, and
  commented as deliberately defensive rather than load-bearing.
- Good state coverage: loading skeleton, `ErrorCard` + working `Retry` (verified in tests to
  actually re-invoke the fetcher), empty-list copy for both tabs, and the `audioUrl === null` /
  `hasAudio === false` transcript-only path with a visible "no audio" note (`role="note"`).
- a11y is handled correctly, not just decorated: browse rows are real `<button>` elements with a
  descriptive `aria-label` (title + number), never icon-only; the `jsx-a11y/media-has-caption`
  suppression carries a substantive justification (no timestamps in the corpus yet, full transcript
  renders directly below) rather than a bare disable.
- `preload="metadata"` is the right default for a list-then-detail player — duration/seek scaffolding
  without eagerly downloading full audio on every detail open.
- Routing/nav wiring is clean: `App.tsx` route added with no dead imports, `lib/nav.ts` entry
  appended at the end per the file's established "pure append" convention (matches the F-010
  precedent comment), and the compile-time `NavItemId`/`PRIMARY_TAB_IDS`/`MORE_TAB_IDS`
  exhaustiveness check is untouched and still exhaustive with `'ttmik'` present in `MORE_TAB_IDS`.
- Test suite is meaningfully behavioral, not just present: it asserts the actual resolved `<audio
  src>` value (not just "an audio tag exists"), asserts transcript reordering from a deliberately
  reversed fixture, asserts the speaker label appears only on the dialog row, and asserts
  audio-element *absence* on the null-`audioUrl` path plus the visible "no audio" note.

## Detailed (file:line)

- `client/src/services/ttmik.ts:97-104` — `buildAudioSrc`; the flawed check is line 102.
- `client/src/services/ttmik.ts:16-22`, `81-96` — threat-model comments asserting a guarantee the
  code does not currently provide (see BLOCKER #1).
- `client/src/pages/Ttmik.tsx:15-19`, `24-29` — same claim restated at the call-site.
- `client/src/services/ttmik.test.ts:146-169` — `buildAudioSrc` unit tests; gap noted in
  SHOULD-FIX #1.
- `client/src/pages/Ttmik.tsx:213-215`, `330-332`, `466-468` — redundant `ctrlRef.current?.abort()`
  (SHOULD-FIX #2).
- `client/src/pages/Ttmik.tsx:231-233`, `349-353`, `485-488` — `ApiError.message` passed to
  `ErrorCard` (NIT #1); contract stated in `client/src/components/ErrorCard.tsx:11-16`.
- `client/src/pages/Ttmik.tsx:539-545` — real `<audio controls>` element, `preload="metadata"`,
  `jsx-a11y/media-has-caption` suppression with justification.
- `client/src/pages/Ttmik.tsx:577-611` — `TranscriptLine`; escaped JSX children, speaker-label
  gating.
- `client/src/pages/Ttmik.tsx:508-516`, `546-550` — loading skeleton / error / no-audio-note states.
- `client/src/App.tsx:50`, `95` — route registration.
- `client/src/lib/nav.ts:39`, `161-171`, `195` — `NavItemId` union entry, `NAV_ITEMS` append,
  `MORE_TAB_IDS` inclusion (exhaustiveness guard at `nav.ts:198-213` untouched and still valid).
- `client/src/types/domain.ts:1734-1809` — F-012 wire types (`TtmikSentence`, `TtmikLesson(Detail)`,
  `IyagiEpisode(Detail)`), consistent with what the page/service actually consume.
- `server/src/app.ts:46` — bare `helmet()`, no `media-src` directive, and no static-file serving in
  this app (checked, no `express.static`/`sendFile`) — cited as the reason there's no
  compensating CSP control for BLOCKER #1.
- `Deploy/nginx.conf` — no `Content-Security-Policy` header on the document response in this
  deploy's actual static/HTML-serving layer.
