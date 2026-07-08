# Review: uploads U1b-rework — UploadViewer

Reviewer: independent senior (React/TS). Artifact: `client/src/pages/UploadViewer.tsx`
(545 lines). Contract reference (read, not reviewed): `client/src/services/uploads.ts`.
Design authority: `db/docs/PDF_UPLOAD_DESIGN.md` §"REVISION (2026-07-08): NORMALIZE TO
PAGE IMAGES" + §"PAGE ORDER".

## Summary verdict: PASS WITH CONDITIONS

The viewer is genuinely senior-level work: a strict one-mounted-page memory bound, a
detached next-page prefetch, keyed remount-on-nav/retry that removes the need for any
reset effect, exact-snapshot optimistic rollback, thorough `AbortController` discipline,
full types (no `any`/`as`/`!`), and honest in-code documentation of a real cross-agent
gap. No BLOCKERs. Three SHOULD-FIX items keep it from an unconditional pass: (1) per-page
retry has no cache-bust and can dead-loop against the "cache-friendly" page route; (2)
`submitMove` has no explicit in-flight guard, so the Enter-key path can bypass the
button's disabled state and fire concurrent reorders with a stale rollback baseline; (3)
the eslint-disable is legitimately needed (confirmed by lint) but its justifying comment
names the wrong hazard.

The reorder feature is also **dead against the current server** (`listPages` → 404) — but
that is a documented, out-of-scope cross-agent dependency, not a defect in this file (see
Coordination observations).

## Bar checklist

| Bar rule | Status | Note |
|---|---|---|
| §2.1 No `any` / no unchecked `as` / no non-null `!` | PASS | None present; `Number()` results all guarded. |
| §2.2 Rules of Hooks; **never disable exhaustive-deps** | PASS | `exhaustive-deps` never disabled. One `set-state-in-effect` disable (different rule) — see dedicated finding. |
| §2.2 Stable keys, never index for reorderable list | PASS | No rendered page list; reorder is a numeric input. `PageImage` key `${pageNum}-${retryToken}` is intentional remount, not a list key. |
| §2.2 Effects sync external systems only; cleanup + stale-guard | PASS w/ note | Meta/pages/reorder effects abort + guard `signal.aborted`. Prefetch effect has no cancellation (NIT). |
| §2.2 No setState-after-unmount | PASS | Every post-await write guarded by `ctrl.signal.aborted`; unmount aborts all three controllers. |
| Only current page mounted + prefetch next (design + memory bound) | PASS (PRAISE) | Exactly one `<img>` mounted; next page prefetched via detached `new Image()`. |
| Per-page error + retry actually re-requests | FAIL | Retry remounts with identical `src`; no cache-bust — see SHOULD-FIX #1. |
| Retry-storm / infinite-retry risk | PASS | Retry is user-initiated only; no auto-retry. |
| Optimistic reorder matches exact-set contract | PASS | Optimistic list is a permutation of `pages`; all ids present once. |
| Rollback restores EXACT prior order | PASS (PRAISE) | `previousPages`/`previousPageNum` captured pre-mutation. |
| No lost update on rapid double-reorder; in-flight disabled state | FAIL | Button disabled during PATCH, but Enter path unguarded — see SHOULD-FIX #2. |
| Accessibility of prev/next/jump/zoom/reorder controls | PASS | `aria-label` on all icon/symbol buttons; `aria-live` page count; `aria-pressed`/`aria-busy`; labelled inputs; `role="status"`/`role="alert"` states. |
| §0 Correct/robust path, surface shortcuts explicitly | PASS | Cross-agent `listPages` gap documented, not silently papered over. |

## Findings

### BLOCKER
None.

### SHOULD-FIX
1. Per-page retry does not cache-bust — can become an unbreakable retry loop against a
   `cache-friendly` page response. (`UploadViewer.tsx:115-125`, `:531-539`)
2. `submitMove` lacks an explicit `if (reordering) return;` guard; the input's Enter
   handler bypasses the Move button's `disabled` state, permitting concurrent reorders and
   a stale rollback baseline. (`UploadViewer.tsx:275-336`, `:507-518`)
3. The `set-state-in-effect` eslint-disable is genuinely required (verified by lint) and
   hides no bug, but its justifying comment attributes the suppression to the wrong hazard.
   (`UploadViewer.tsx:178-194`) — dedicated verdict below.

### NIT
- Prefetch effect has no cancellation; rapid navigation spawns competing background image
  loads. (`UploadViewer.tsx:208-212`)
- After a successful reorder, `pages` is reconciled to `serverPages` but `pageNum` is not —
  if the server ever returns a non-echoed order the viewed position is not re-derived.
  (`UploadViewer.tsx:319-323`)
- Opening reorder mode does not move focus into the panel. (`UploadViewer.tsx:262-268`)

### PRAISE
- Strict memory bound: exactly one mounted `<img>` + a detached prefetch. (`:208-212`, `:531-539`)
- Keyed remount for nav AND retry eliminates a reset effect entirely. (`:80-128`, `:532`)
- Keyboard-operable numeric reorder (no pointer-only drag) satisfies WCAG 2.5.7 by design. (`:473-524`)
- Exact pre-mutation snapshot rollback. (`:292-293`, `:327-334`)
- Honest, precise documentation of the cross-agent contract gap. (`:37-49`)

## Detailed findings

### SHOULD-FIX #1 — Retry re-requests the same URL with no cache-bust (`UploadViewer.tsx:115-125`, `:531-539`)

`PageImage` renders `<img src={src}>` where `src = pageUrl(id, pageNum)` (`:533`), and on
error surfaces an `ErrorCard` whose `onRetry` increments `retryToken` (`:536-538`). The
`retryToken` is threaded into the **key** (`${pageNum}-${retryToken}`, `:532`) so the
component remounts with a fresh `<img>` — but it is **not** threaded into the URL. The
`src` on retry is byte-identical to the failed request.

For a transient network drop this is fine (browsers do not cache a failed image load).
The problem is the design's own serving contract: `services/uploads.ts:46` and the design
doc describe `GET /uploads/:id/page/:n` as **"cache-friendly"** — i.e. it emits caching
headers. If the browser ever caches a bad-but-`200` response (a truncated/partial JPEG
mid-transfer, or a stale entry), remounting with the same URL replays the **same cached
bytes** → `onError` again → the user taps Retry again → same cached bytes, forever. Retry
that cannot make progress is the defect §0 "fail loud, to a recoverable state" guards
against.

The fix is nearly free because the token already exists: append it as a cache-buster on
retry only, e.g. build `src` as `retryToken > 0 ? \`${base}?r=${retryToken}\` : base`. This
keeps the happy path fully cacheable (token 0 = no query) and forces a fresh fetch on every
explicit retry. Recommend cache-bust only when `retryToken > 0` so normal navigation still
benefits from the cache.

### SHOULD-FIX #2 — Reorder concurrency: Enter bypasses the in-flight guard; stale rollback baseline (`UploadViewer.tsx:275-336`, `:507-518`)

The Move **button** is correctly disabled during an in-flight PATCH:
`disabled={reordering || moveTarget.trim() === ''}` with `aria-busy={reordering}` (`:515-516`).
But the move-target input's keyboard handler calls `submitMove()` unconditionally on Enter
(`:507-509`), and `submitMove` itself has no `if (reordering) return;` at the top
(`:275-282`). So the disabled button does not actually prevent a second submission — only
the incidental fact that the optimistic block clears `moveTarget` to `''` (`:306`) does, and
only after React commits that state. Two Enter events dispatched before the re-render
(key-repeat, or a fast double-press) both read the still-valid `moveTarget` from the same
render and both proceed.

If a second `submitMove` does slip through:
- It captures `previousPages = pages` (`:292`) — but `pages` is now the **first move's
  optimistic order**, which the server never confirmed. A subsequent failure therefore rolls
  back to an unconfirmed intermediate state, not the true last-known-good order.
- It calls `reorderCtrlRef.current?.abort()` (`:311`), aborting the first PATCH. The first
  request's `.then/.catch` bail on `signal.aborted` (`:320`, `:325`), so the first move is
  silently dropped in favour of the second — a lost update relative to what the user saw
  confirmed.

The button-disabled state is the right intent; it just isn't the actual gate. Add an
explicit `if (reordering) return;` as the first line of `submitMove` so both the button and
the keyboard path share one authoritative guard. That single line closes the double-submit,
the stale-baseline rollback, and the lost-update window together.

### The eslint-disable verdict — `react-hooks/set-state-in-effect` on the meta-fetch effect (`UploadViewer.tsx:178-194`)

**Verdict: the suppression is legitimate and hides no bug — but keep it only after
correcting its rationale (SHOULD-FIX #3); a key-based reset would remove the need for it
entirely (preferred).**

What I verified, not assumed:
- Ran `eslint --report-unused-disable-directives src/pages/UploadViewer.tsx` →
  **clean/exit 0**. A truly unnecessary directive would be reported as unused; it was not.
  So the rule genuinely fires on `loadMeta()` and the disable is really suppressing a
  violation — it is **not** cargo-cult.
- Ran `eslint src/pages/Uploads.tsx` (its `load()` effect is structurally identical —
  `useCallback` with synchronous setState + async fetch, called from an effect, cleanup
  aborts, `signal.aborted` guards) → **clean with no disable**. Plugin version
  `eslint-plugin-react-hooks@7.0.1`. So the comment's claim that the rule fires here but not
  on the twin in `Uploads.tsx` is **accurate on disk** — it is a real heuristic
  inconsistency in the rule, exactly as the comment states.

Why the rule is right to fire (and why it is benign): `loadMeta` performs **synchronous**
`setMetaState('loading')` + `setPageNum(1)` (`:163-164`), plus `setMetaState('error')` on
the no-`id` branch (`:157-158`), *before* any `await`. That is a genuine
synchronous-setState-in-effect. On first mount it is a redundant no-op (both already at
those initial values → React bails). On an `id` change without unmount
(`/uploads/a` → `/uploads/b`), it intentionally resets `metaState → 'loading'` and
`pageNum → 1`. That is a legitimate "reset prop-derived state when the identity prop
changes" — benign here, correctly guarded downstream (cleanup aborts `:191-193`; every
post-await write checks `ctrl.signal.aborted` `:167`,`:172`; deps `[loadMeta]`, `loadMeta`
deps `[id]` → no loop, no stale closure, no double-fetch, no setState-after-unmount). I
found no hidden defect behind the suppression.

The flaw is documentation, not logic. The comment (`:186-188`) justifies safety by pointing
at the **async** guard: *"`loadMeta` guards every state write after its `await` on
`ctrl.signal.aborted`."* But `set-state-in-effect` has nothing to say about the async
writes — it fires on the **synchronous** `setMetaState`/`setPageNum` that run before the
`await`. The comment defends the wrong hazard, which will mislead the next maintainer about
what the disable is actually covering. Correct the rationale to name the synchronous
reset-on-`id`-change and why it is safe (redundant on mount; intentional + guarded on
navigation).

Preferred alternative (removes the disable rather than annotating it): key the route
element on `id` (e.g. `<UploadViewer key={id} />` at the router, or lift the reset by
remounting), so switching books remounts the component and the `metaState`/`pageNum` reset
happens via fresh `useState` initial values during render — the React-idiomatic way to
reset state on identity change, with no in-effect setState to suppress at all. This is a
NIT-level refactor, not required for approval, but it is the cleaner long-term shape.

## Coordination observations

- **Reorder is non-functional against the committed server (documented, out of scope).**
  `openReorder` → `loadPages()` → `listPages(id)` hits `GET /uploads/:id/pages`
  (`services/uploads.ts:179-185`), which per both files' headers **does not exist** on server
  commit `82ea4c2`. In the running app the reorder panel will show
  `"Could not load page order. Try again."` (`:485`) and never load. This is a genuine
  cross-agent dependency on the parallel server work, thoroughly and honestly flagged in
  three places (`UploadViewer.tsx:37-49`, `uploads.ts:54-66`, `uploads.ts:171-178`). I do
  **not** count it against this artifact — the client code, UI, and (per the header) tests
  are complete and correct against the documented `page_ids` contract. Flagging so whoever
  integrates knows the reorder path is blocked until the server exposes a page-id-list route
  (or `GET /uploads/:id` is extended to include the id list).

- **Reorder correctness depends on server sort assumptions.** `submitMove` treats
  `pages[pageNum - 1]` as the currently-viewed page (`:283-285`), which holds only if
  `listPages` returns pages sorted ascending and contiguous by `pageNumber`. The design
  doc's `unique(upload_id, page_number)` supports that, but the server contract for
  `GET /uploads/:id/pages` should explicitly promise sorted-ascending output so this
  index math stays valid.

- **Contract wire-shape alignment looks correct:** `PageWire {id, page_number}` /
  `PagesEnvelope {pages}` (`uploads.ts:102-111`) and `reorderPages` submitting
  `{ page_ids: number[] }` (`uploads.ts:197-208`) match the design doc's
  `PATCH /uploads/:id/pages/order` and the "full current id set, validated exactly"
  contract this viewer's optimistic list satisfies.
