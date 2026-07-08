# Review: uploads U1b-rework — client service + list + modal

Reviewer: independent senior reviewer (React/TypeScript). Code not modified — report only.

**Scope:** `client/src/services/uploads.ts` (267 lines), `client/src/pages/Uploads.tsx` (233
lines), `client/src/components/UploadTypeModal.tsx` (291 lines), plus the directly-wired
`client/src/lib/errorCopy.ts` (`bookUploadErrorMessage`) and `client/src/services/api.ts` (fetch
boundary) where the review criteria required following the call chain. Cross-checked against the
live server implementation (`server/src/routes/uploads.ts`, `server/src/services/
bookUploadIngest.ts`, migrations `040_book_uploads`/`041_book_pages`) and against
`db/docs/PDF_UPLOAD_DESIGN.md` §REVISION / §PAGE ORDER.

## Summary verdict: PASS WITH CONDITIONS

No BLOCKERs. The headline risk named in the assignment — a client/server reorder-contract
mismatch — **does not exist**: I independently read the live server route and it matches the
client's assumed wire shape exactly (see Coordination section). Six real SHOULD-FIX items remain,
none of them data-loss/corruption/security-severity; the most consequential is stale, actively
misleading error copy left over from the pre-revision (single-PDF, 15 MB) design. Recommend fixing
SHOULD-FIX #1–#4 before calling U1b done; #5–#6 can follow.

## Bar checklist

| Area | Status | Note |
|---|---|---|
| No `any` / unchecked cast at type level | PASS | grep confirms zero `any`/`@ts-ignore`/`@ts-expect-error` in all three files |
| Runtime validation of server responses (zod at boundary, Bar §2.1 P0) | FAIL | `api.get<T>`/`post`/`patch` are unchecked generic casts (`services/api.ts:242-249`); every service module in the app does this identically — pre-existing convention, not introduced here (see SHOULD-FIX #6) |
| Discriminated unions / exhaustiveness | N/A | status/type are string unions consumed via lookup tables (`STATUS_META`, `TYPE_META`), not switches — fine at this cardinality |
| Rules of Hooks / exhaustive-deps | PASS | `useCallback`/`useEffect` deps correct in `Uploads.tsx`; abort-on-unmount effects correct in `UploadTypeModal.tsx` |
| Keys are stable domain IDs | PASS | `key={upload.id}` (server row id), never index |
| Semantic HTML / keyboard operability | PASS | real `<button>`s throughout, `<ul>`/`<li>` for lists, labelled inputs |
| Focus management / a11y for the modal | PASS (assumed via `Sheet`) | `UploadTypeModal` delegates focus-trap/Esc/restore to `Sheet`'s `useModalA11y` — not re-implemented, not itself reviewed (out of scope) |
| No `dangerouslySetInnerHTML` / XSS surface | PASS | all user/server text renders as React children |
| CSRF posture | PASS | inherits `SameSite=Strict` cookie posture from `services/api.ts`; state-changing calls documented correctly in the file header |
| IDOR | PASS (client side) | client never reasons about ownership; server scopes every row/page to `user_id` (verified in `routes/uploads.ts`) |
| Error copy never echoes raw server text | PASS w/ 1 defect | `errorMessageFor`/`bookUploadErrorMessage` only ever interpolate a structured numeric `retryAfter`, never server prose — but the *fixed* copy itself is stale/wrong post-revision (SHOULD-FIX #2) |
| Upload size/type pre-check exists, server-authoritative | PASS | `checkBookFile` documented as convenience-only; matches server's 300 MiB cap and magic-byte posture |
| Progress/abort/large-file handling | CONDITIONAL | abort discipline is excellent; no upload-progress indicator for up to 300 MB transfers (SHOULD-FIX #5) |
| Delete: confirm-before-destroy, error handling | PASS w/ 1 gap | confirm + toast-on-error present; no guard against navigating into the row being deleted (SHOULD-FIX #4) |
| Client/server reorder contract (`page_ids`, id types, exact-set) | PASS | verified byte-for-byte against `routes/uploads.ts` — see Coordination section |
| Tailwind token usage (no inline `style={{}}`, Bar §2.5 P1) | NIT | two inline `style={{}}` uses in `UploadTypeModal.tsx` (lines 211, 224) |

## Findings

### BLOCKER
None.

### SHOULD-FIX
1. Stale "contract gap" comment in `services/uploads.ts` (lines 54–66) is factually wrong and should be corrected.
2. `bookUploadErrorMessage` (`client/src/lib/errorCopy.ts:101-119`) has pre-revision copy that misstates the real cap and conflates unrelated 400 causes.
3. No client-side `maxLength` on the title field in `UploadTypeModal.tsx` — a >200-char title round-trips to a 400 that (per #2) shows a misleading message.
4. `Uploads.tsx`'s per-row "view" button isn't disabled while that row's delete is pending — a click race can navigate into a row that's about to vanish.
5. No upload-progress indicator (`onUploadProgress` unused) for transfers now up to 300 MB.
6. Fetch-boundary responses are unchecked casts, no runtime (zod) validation — app-wide convention, flagged for awareness.

### NIT
1. Two inline `style={{}}` blocks in `UploadTypeModal.tsx` (lines 211, 224) — Bar §2.5 P1 prefers token/utility classes; low-impact and consistent with the app's broader hand-rolled-BEM-class styling elsewhere, so likely an established pattern rather than a regression introduced here.
2. `Uploads.tsx`'s delete confirmation uses the native blocking `window.confirm` (line 112) rather than an in-app confirm sheet — acceptable for a personal single-user app; worth revisiting only if the rest of the design system already has a themed confirm pattern.
3. `checkBookFile` (`services/uploads.ts:253-267`) doesn't reject a 0-byte file client-side; it will round-trip to the server before being rejected there. Trivial polish.

### PRAISE
1. **Threat-model documentation embedded directly in the code** (`services/uploads.ts:11-49`) — enumerates auth/CSRF/IDOR/upload-validation/multipart-boundary posture per surface, exactly matching the global Bar's "document the defended-against attack in a code comment" standard (§0). This is the kind of comment a fix-pass should never strip.
2. `checkBookFile` is correctly scoped and documented as a **non-authoritative UX convenience** with the server's magic-byte sniff + size cap as the real gate (`services/uploads.ts:244-252`) — genuine defense-in-depth, not a false sense of security. Don't "fix" this into thinking the client check is sufficient.
3. **Error-copy discipline**: `errorMessageFor` / `bookUploadErrorMessage` never interpolate raw server-provided strings into user-facing copy — only a validated, finite, positive `retryAfter` number ever crosses that boundary (`services/api.ts:118-126`, `lib/errorCopy.ts:44-47,104-106`). A real, consistently-applied defense against an error-oracle/text-injection surface. The *content* is stale in one spot (SHOULD-FIX #2) but the *mechanism* is sound and should be preserved.
4. **Abort discipline in `UploadTypeModal`** (lines 94-111, 135-150): the in-flight upload is aborted on both modal-close and component-unmount (two independent effects, explicitly reasoned as "belt-and-suspenders" in the comment), and every state write after an `await` is guarded on `ctrl.signal.aborted`. No late-settle-after-unmount class of bug here.
5. **No unbounded client memory use on upload** — the raw `File` is appended directly to `FormData` and streamed by the browser; nothing reads it into a `base64`/`ArrayBuffer` buffer first. Correct for files now up to 300 MB (`services/uploads.ts:222-232`).
6. **`reorderPages`'s wire contract is genuinely correct**, not just asserted: `book_pages.id` is a `BIGINT IDENTITY` (never a UUID), so the client's `Number(pid)` conversion (`services/uploads.ts:204`) is safe, and "array position = new 1-based `page_number`" matches the server's actual two-phase renumber implementation exactly (`routes/uploads.ts:453-467`).

## Detailed findings

### SHOULD-FIX 1 — Stale/incorrect "contract gap" comment, `services/uploads.ts:54-66`
The file header states, as a `KNOWN CROSS-AGENT CONTRACT GAP`:

> `listPages` below calls `GET /uploads/:id/pages`, which does NOT exist on that server commit
> … the reorder tool's initial load will 404 in the running app…

I read the live server route directly: `server/src/routes/uploads.ts:355-390` implements
`GET /:id/pages` and returns exactly `{ pages: [{ id, page_number }] }` — the shape `PagesEnvelope`/
`PageWire` in this file expects, field for field. The route's own comment
(`routes/uploads.ts:343-352`) explicitly says it was added *to close* this gap. The consumer,
`client/src/pages/UploadViewer.tsx`, already calls `listPages`/`reorderPages` (confirmed via grep;
out of scope for this review but its existence corroborates the route is live and consumed, not
dead code). This comment is now false and will actively mislead the next engineer who reads it —
into believing a working code path is broken, or skipping a test that should pass. Fix: delete or
update the paragraph now that the server side has landed.

### SHOULD-FIX 2 — Stale error copy for the (raised) 300 MB cap and the 400 status, `client/src/lib/errorCopy.ts:101-119`
```
if (err.status === 413) {
  return 'That PDF is too large. Pick one under 15 MB.';
}
if (err.status === 400) {
  return 'That file isn’t a valid PDF. Choose a different file.';
}
```
Both strings predate the design-doc REVISION (`db/docs/PDF_UPLOAD_DESIGN.md` "NORMALIZE TO PAGE
IMAGES"). The actual cap is 300 MiB (`server/src/services/bookUploadIngest.ts:107`,
`client/src/services/uploads.ts:79` — these two *do* agree with each other, just not with this
copy), and the accepted types are PDF **or** zip. Two concrete problems:
- Telling a user hitting the real 300 MB cap to "pick one under 15 MB" is simply wrong advice — a
  20 MB legitimate scan would trigger this text even though it's well under the real cap only if
  some other 413 path fires, and for a genuinely-oversized (300 MB+) file the number told to the
  user is off by 20x.
- The 400 branch is reached by **every** `ValidationError` the route can throw — missing file
  (`bookUploadIngest.ts:275`), wrong magic bytes (`:279`), zip/PDF normalize failure (`:284-295`),
  **or** a body-schema violation (blank/>200-char title, invalid `type` — `UploadBodySchema`,
  `routes/uploads.ts:122-127`, also 400 via `validateBody`). A title-too-long 400 gets the message
  "that file isn't a valid PDF. Choose a different file." — wrong actionable advice; the user will
  re-pick the same valid file and hit the same error again.

### SHOULD-FIX 3 — No client-side title length cap, `client/src/components/UploadTypeModal.tsx:249-264`
The title `<input>` has no `maxLength` and `submit()` (lines 128-151) only checks
`trimmedTitle === ''`, not length. The server's `UploadBodySchema` caps title at 200 chars
(`routes/uploads.ts:122-127`, backed by a DB `CHECK` per migration 040). Combined with SHOULD-FIX 2,
a too-long title dead-ends the user in a confusing state. Fix: add `maxLength={200}` to the input
(and ideally a live character count, though that's optional polish).

### SHOULD-FIX 4 — View-navigation not gated during pending delete, `client/src/pages/Uploads.tsx:176-213`
```tsx
<button
  type="button"
  className="km-resources__list-open focusring"
  onClick={() => { navigate(`/uploads/${upload.id}`); }}
  ...
>
  ...
</button>
<Button
  variant="ghost"
  size="sm"
  onClick={() => { void remove(upload); }}
  disabled={pending}
  ...
>
```
`pending = pendingDeleteId === upload.id` disables the trash button but is never applied to the
row-open button above it. Sequence: user clicks delete → `window.confirm` (synchronous, blocks all
other interaction) → confirms → `remove()` starts its `await deleteUpload(upload.id)` → **before
that network round-trip resolves**, nothing stops the user from clicking the same row's "view"
button (their mouse is right there) → `navigate('/uploads/:id')` fires for an id that is about to
be removed from `rows`. Not data corruption (the server-side delete is still authoritative, and the
viewer will simply get a 404 on its own fetch), but it violates the specific criterion in-scope for
this review ("no orphaned nav to a deleted id") and is a one-line fix: also disable/hide the
row-open control when `pending` is true, or spread `disabled={pending}` onto both controls.

### SHOULD-FIX 5 — No upload-progress feedback for large transfers, `client/src/services/uploads.ts:216-234` / `client/src/components/UploadTypeModal.tsx:268-285`
`uploadBook` calls `buildMultipartConfig(signal)` (from `services/images.ts`), which only sets
`headers`/`signal` — no `onUploadProgress`. The UI's only in-flight feedback is a static "Uploading…"
label with `aria-busy`. The design doc's own numbers put a real book at ~200–300 MB (vFlat export,
548 JPGs). On a slow/mobile connection that's a multi-minute request with zero percentage feedback,
which reads to a user as a hang. This wasn't a defect at the old 15 MB cap; it is one now that the
cap is 300 MB. Axios supports `onUploadProgress` natively — worth wiring a percentage into the
"Uploading… NN%" label.

### SHOULD-FIX 6 — Unchecked cast at the fetch boundary, `client/src/services/api.ts:242-271`
`api.get<T>`/`post`/`patch`/`delete` return `res.data` typed as the caller's generic with no runtime
check — `res.uploads.map(toBookUpload)` (`services/uploads.ts:153`) trusts the server's JSON shape
completely. Per Bar §2.1 [P0], external data at a boundary should be validated with a schema
(zod), not a bare generic cast. This is real, but **every** service module in this client uses the
identical `api.get<T>()` pattern (confirmed by reading `services/api.ts` itself, which is shared
infrastructure, not something this PR introduces or could reasonably fix in isolation). Flagging
for awareness and recommending an app-wide follow-up (e.g. a `zod`-validated `apiRequest` wrapper)
rather than asking this PR to diverge from the established convention.

## Coordination observations — client/server reorder contract

This was the assignment's named risk area, and I verified it independently rather than trusting
either side's comments:

- **`GET /uploads/:id/pages`**: exists (`routes/uploads.ts:355-390`), returns
  `{ pages: [{ id: string, page_number: number }] }`. Matches client's `PagesEnvelope`/`PageWire`
  (`services/uploads.ts:103-111`) exactly, field name and type.
- **`PATCH /uploads/:id/pages/order`**: server schema is
  `z.object({ page_ids: z.array(z.coerce.number().int().positive().max(MAX_ID)).min(1).max(3000) }).strict()`
  (`routes/uploads.ts:138-142`). Client sends `{ page_ids: orderedPageIds.map((pid) => Number(pid)) }`
  (`services/uploads.ts:202-206`) — field name matches, value type matches (server coerces to
  number regardless, but the client already sends numbers), and the array shape matches
  `.strict()` (no extra fields sent).
- **Exact-set enforcement**: the server handler (`routes/uploads.ts:408-435`) rejects any submission
  whose id set isn't *exactly* the upload's current full page-id set (`ValidationError` on mismatch,
  inside a `FOR UPDATE` transaction). The client's `listPages` is the only way to obtain that
  current set before submitting a reorder, and it now works (see SHOULD-FIX 1) — so a caller that
  fetches via `listPages` immediately before calling `reorderPages` will always submit a valid
  exact-set body, assuming no concurrent mutation from elsewhere (single-user app, low risk).
- **Id type**: `book_pages.id` is `BIGINT GENERATED ALWAYS AS IDENTITY` (migration
  `041_book_pages.up.sql:57`), never a UUID — so the client's `Number(pid)` conversion is safe and
  correct, not a latent bug waiting for a future UUID migration.
- **Response echo**: both the GET and the PATCH return the identical `{ pages: [...] }` shape,
  ordered by `page_number` — the client's `toPage` mapper and its "reconcile against the server's
  returned order" comment (`services/uploads.ts:187-196`) match this correctly.

**Net: no contract mismatch found.** The one genuine issue in this area is documentation debt (SHOULD-FIX 1) — the client code comment describes a gap that the server side has since closed, and should be corrected so it doesn't cost someone a debugging session later.
