# Review — Chat rework Slice 3: in-chat image upload

Scope: image-upload UI + flow only — `client/src/pages/Chat.tsx` (camera button,
`uploadImageFile`, image-turn rendering), `client/src/lib/errorCopy.ts`
(`imageUploadErrorMessage` move), `client/src/pages/Images.tsx` (refactor to the shared
helper), `client/src/services/conversation.ts` (`uploadConversationImage`),
`client/src/components/Icon.tsx` (camera glyph — pre-existing, unchanged in `1e13623`).
Context popup / FAB / per-page context are the other reviewer's scope.

Commit: `1e13623` on `feat/chat-rework`. Verification (Docker, node:20-slim):
`tsc -b --force` = 0, `eslint` = 0, targeted vitest
(`Chat.test.tsx` + `Images.test.tsx` + `errorCopy.test.ts`) = **78/78 passed**.

## Verdict: APPROVE — 0 BLOCKERS, 2 SHOULD-FIX, 3 NIT, 4 PRAISE

The data crux holds: version integrity across image append, 409 resync, abort
discipline, and fixed-copy error handling are all correct and non-vacuously tested.
The two SHOULD-FIXes are a preventable client-side version race window and a 429
copy conflation — both recoverable, neither corrupts data.

---

## Findings

### SHOULD-FIX 1 — text send is not gated on an in-flight image upload (version race window)

`Chat.tsx:981` gates the upload on `uploading || streaming || !threadReady`, and the
camera button (`Chat.tsx:1745`) is disabled during `streaming` — but the reverse gate
is missing: `send` (`Chat.tsx:1212`) checks only `streaming || !threadReady`, and the
Send button (`Chat.tsx:1768`) is not disabled while `uploading`. Enter-to-send
(`Chat.tsx:1312`) has the same hole.

So while a photo is uploading (a multi-second OCR round-trip), the user can fire a
text send. Both requests then carry the same `expected_version` and the server
guarantees one of them 409s (`server/src/routes/conversation.ts:838` pre-check +
`:873` transactional gate for the image; `:470` pre-check + `:575` transactional gate
for the stream). Every interleaving recovers — upload-409 → refetch resync; stream
pre-check-409 → failed chip whose Retry rides the corrected `versionRef`;
mid-stream conflict → `persistence_error` frame with fixed copy + `recovered_text` —
but the race wastes a full Claude stream or Vision call and shows the user a
conflict error the client could simply have prevented. Symmetric one-line fix: add
`uploading` to `send`'s guard and to the Send button's `disabled`.

### SHOULD-FIX 2 — short-window 429 renders the daily-cap copy ("Try again tomorrow")

`imageUploadErrorMessage` (`errorCopy.ts:66`) keys on `status === 429` alone, but
`POST /conversation/:id/image` sits behind `expensiveLimiter()`
(`server/src/routes/conversation.ts:813`), whose short-window 429 is a
seconds-scale wait carrying `retry_after` (`server/src/middleware/rateLimits.ts:41-54`).
Both 429s use code `rate_limited` (`server/src/services/imageIngest.ts:378-386`), so
the code field can't disambiguate — but `retryAfter` presence can: the limiter sends
it, the daily-cap error does not. As written, a user who trips the shared expensive
bucket (e.g. rapid chat sends then a photo) is told to "try again tomorrow" for a
wait measured in seconds. This behavior is carried over verbatim from Images (NOT
drift introduced by the move), but the shared helper now makes it a one-line fix for
both surfaces: branch to `errorMessageFor`'s retry-in-N copy when
`err.retryAfter !== undefined`.

### NIT 1 — `imageUploadErrorMessage` has no direct unit tests

`errorCopy.test.ts` covers only `errorMessageFor`. The 429 branch is exercised via
Chat (`Chat.test.tsx:2081`) and Images (`Images.test.tsx:346`), and 413/400 via
Chat's pre-check tests — but the 502, network, and non-ApiError-fallback branches
of the shared mapper are untested anywhere. Cheap table-driven test; also where a
SHOULD-FIX-2 regression test belongs.

### NIT 2 — a 409-refetch discards a session-local failed-send chip

`Chat.tsx:1039` `setLoaded(null)` makes the history effect replace `msgs` wholesale
with server truth. If the thread held a `failed → retry` chip (unsent text), it is
silently dropped. The same trade-off is documented for switch-away
(`Chat.tsx:146-148`), but here the user didn't navigate — an image 409 costs them a
pending retry. Requires a failed text send followed by an image 409 in the same
thread; edge-of-edge, flagging for the record.

### NIT 3 — lazy-start can yank the selection off a just-switched-to conversation (pre-existing shared path)

Upload from the pending-'new' thread → `ensureActiveConversationId` starts a
conversation; if the user clicks sidebar row B while the start is in flight,
`adoptStartedConversation` (`Chat.tsx:942-946`) still runs on resolve (only
`mountedRef`-guarded, not abort-guarded) and `setSelectedKey(id)` pulls them off B
onto the empty new conversation. The aborted upload itself never lands
(`Chat.tsx:1019` guard) — this is selection UX only, and the identical window exists
in Slice 2's `send` path, so it is pre-existing shared infrastructure, not a Slice-3
regression. Related: aborting an upload client-side does not recall the request —
the server may still OCR + append the turn (and spend Vision budget) on the old
conversation; consistency self-heals because switching back refetches.

### PRAISE 1 — pre-checks synthesize structured errors through the shared mapper

`Chat.tsx:984-1005` builds `ApiError({status: 413|400})` and routes it through
`imageUploadErrorMessage` — the client pre-check and the server path produce
byte-identical copy by construction, and the synthetic messages ("client size
pre-check") can never render because the mapper keys on structured fields only.

### PRAISE 2 — 409 resync reuses the history effect as the single recovery mechanism

`setLoaded(null)` + fixed copy (`Chat.tsx:1036-1041`) re-arms the existing
abort-guarded history effect (`Chat.tsx:715-748`), which restores both the thread
AND `versionRef` from the authoritative `GET /conversation/:id`; `threadReady` stays
false throughout the refetch, so no send or upload can fire on the stale version in
the gap. No bespoke resync code to rot.

### PRAISE 3 — the test suite is pointedly non-vacuous on the data crux

`Chat.test.tsx:2029` asserts the upload carries the history-loaded version (5);
`:2062` asserts the post-upload send rides the server's post-append version (6, not
5); `:2242` asserts the post-409 send rides the refetched version (7). Prose-absence
is asserted (`:2107`, `:2229`), abort is asserted on the actual signal (`:2160`,
`:2187`), and the switch test additionally asserts the OCR turn never appears in the
other thread (`:2193-2198`). History round-trip renders via the same
`storedTurnToRow` as the live path (`:2065`).

### PRAISE 4 — the errorCopy move is drift-free

The new `imageUploadErrorMessage` is byte-identical to Images' removed
`messageForUploadError` (all five strings, including the curly apostrophe in
"isn’t"); the only structural change — dropping the redundant inner
`'Upload failed. Try again.'` return — is behavior-identical since control falls
through to the same final string. `Images.tsx:222` is a 1:1 call-site swap, its 429
fixed-copy test still passes unmodified, and there is no import cycle
(`lib/errorCopy` → `services/api` only) or react-refresh concern (plain lib module).

---

## Probe answers (asked by the dispatch)

- **(a) Can a post-image text send carry a stale version?** After the upload
  completes: no — `versionRef.current = result.version` (`Chat.tsx:1027`) is set
  before `uploading` clears, and the test proves the next send rides it. *During*
  the upload: yes (SHOULD-FIX 1) — but the server's version gates turn that into a
  409 on one side, never a silent mis-apply.
- **(b) Does the 409-refetch correctly resync?** Yes — `setLoaded(null)` re-arms the
  history effect, which refetches and writes the authoritative `detail.version` into
  `versionRef`; `threadReady` blocks sends/uploads until it lands. Test-proven
  (send rides 7 after the conflict).
- **(c) Does raw server prose reach the DOM?** No — every upload failure path
  renders a fixed string (`imageUploadErrorMessage`, `UPLOAD_CONFLICT_COPY`), the
  stream's `persistence_error` substitutes fixed copy in the service layer, and
  tests assert the server prose is absent. Caveat: the 429 fixed string can be the
  *wrong* fixed string (SHOULD-FIX 2) — still author-controlled, never prose.
- **(d) Is the errorCopy move drift-free for Images.tsx?** Yes — byte-identical
  strings, identical branch order, 1:1 call-site swap, Images tests green, no
  cycle/react-refresh issue (PRAISE 4).
- **(e) Can a late upload render into the wrong conversation?** No — switch, New
  chat, and unmount all abort the per-upload controller, every continuation is
  `ctrl.signal.aborted`-guarded, and tests assert both the wrong-thread negative and
  the post-unmount no-op. (Server-side the old conversation may still gain the turn
  — abort doesn't recall a received request — but it only ever renders in its own
  conversation after a refetch.)
