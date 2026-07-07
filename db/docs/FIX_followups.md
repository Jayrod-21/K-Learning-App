# FIX — follow-up nits (F-UP-016a / 017 / 018 / 019)

Branch `fix/followups`, 2026-07-06. Each item below is FIXED / SKIPPED / DEFERRED
with the change and its regression test. Gates: client TC=0 · LINT=0 ·
745/745 tests (70 files) · BUILD=0; server STC=0 · 707 passed / 4 skipped
(32 files + 1 skipped file) on `tests/routes tests/services/claude`.

---

## F-UP-016a · Carousel total-outage silence — **FIXED**

**Change** (`client/src/pages/Today.tsx`):
- The `metric: 'none'` degraded panel (produced ONLY by `fetchSkillSeries` on a
  route rejection — the server never sends `'none'`) now reads
  **"Couldn’t load this trend."** instead of "No data yet". "No data yet"
  remains reserved for a route that ANSWERED with an empty series (LineChart
  renders that copy itself), so failure and genuinely-empty are now visually
  distinct.
- When ALL five skills are `'none'` (total outage), the whole card collapses to
  one `ErrorCard` — "Progress trends couldn’t be loaded." — wired to
  `series.refetch`. Partial failure still renders the carousel with per-panel
  failure copy. `services/stats.ts` unchanged (its allSettled degradation
  already carried the signal; only the render discarded it).

**Tests** (`Today.test.tsx`): updated the writing-route-failed test to assert
the new copy AND that "No data yet" does NOT render; new total-outage test
asserts the ErrorCard, absence of both empty-state copies and of the carousel,
and that Retry fires the series source's `refetch` (hook mock extended with an
observable per-key refetch).

## F-UP-017 · Writing "New prompt" no-op at pool size 1 — **FIXED**

**Change** (`client/src/pages/Writing.tsx`): chose **disable** over
fetch-another (the pool IS the server's full pool for the rubric —
`GET /writing/prompts` returns all active prompts, so there is nothing else to
fetch). `canRotatePrompt = prompts !== null && prompts.length > 1`; both "New
prompt" buttons (composing + graded footers) are disabled at pool ≤ 1 with an
explanatory `title`. Pre-fix the composing-state button was a destructive
no-op: rotate wrapped to the same prompt and silently wiped the draft.
Re-enables automatically when a second prompt exists server-side.

**Tests** (`Writing.test.tsx`): single-prompt pool → button disabled, draft
survives a click, same prompt stays on screen; graded state → still disabled
while "Revise & regrade" stays enabled. (Existing rotate test with a 2-prompt
pool still passes — behavior unchanged above pool size 1.)

## F-UP-018 · Diagnostic fatal branch: no retry + prose echo — **FIXED**

**Change** (`client/src/pages/Diagnostic.tsx`): the fatal snapshot-failure
branch (`Couldn’t load diagnostic. {fatalError.message}`, no retry) is now an
`ErrorCard` with fixed copy ("Couldn’t load your diagnostic results. Retry, or
begin a new diagnostic below.") and `onRetry={snap.refetch}`. The page-local
`toMessage` helper (used by the four taking-flow alerts) now delegates to the
shared fixed-copy lookup instead of echoing `ApiError.message`.

**Test** (`Diagnostic.test.tsx`): fatal state renders the fixed copy, does NOT
render the planted server prose (`relation "diagnostic_snapshots" does not
exist`), Retry fires the snapshot refetch, and the IntroBlock "Begin" control
still renders (no dead end).

## F-UP-018 · Hanja featured-item failure as empty state — **FIXED**

**Change** (`client/src/pages/Hanja.tsx`): in the Today view, a failed
`hanja:today` fetch (`todayResult.error !== null`) now renders an `ErrorCard`
("Couldn’t load today’s featured 한자.") with a retry scoped to
`todayResult.refetch`. The "No featured 한자 yet" empty card is reserved for a
successful null response (genuinely no featured character). `fatal` gating for
list/progress is unchanged.

**Test** (`Hanja.test.tsx`): featured fetch failure → error copy renders, the
empty-state copy and the server prose do NOT, and Retry re-runs ONLY the
`today` source (list/progress refetch spies untouched).

## F-UP-018 · SSE redaction, services layer — **FIXED**

**Change** (`server/src/services/claude/index.ts`, `generateConversation`
worker catch): the stream `error` event no longer carries the raw
`e.message` (upstream SDK/driver prose) — it now ships the fixed message
`'conversation stream failed'` plus the structured `code`. The raw detail is
logged at `error` level with `{ route, requestId, code }` (necessary: the
route's `final.catch` sink logs at debug only on this path, so without the new
log line the detail would have been lost). The route (`conversation.ts` ~504)
forwards the frame verbatim, which is now safe. The `final` promise still
rejects with the ORIGINAL error — redaction is wire-only.

**Test** (`tests/services/claude/index.test.ts`): mid-stream SDK failure with
sensitive prose → error event message is exactly the fixed string, does not
contain the planted detail, `code` still present, and `final` still rejects
with the full original message. **Mutation-probed:** reverting the queue push
to `message: detail` fails the test; restored green.

## F-UP-018 · Rate-limit ordering — **FIXED (clear wins) + DEFERRED (router-level pattern)**

Fixed (each limiter now runs BEFORE `requireAuth` where that is a strict win):
- `routes/define.ts` — swapped to `cheapLimiter(), requireAuth`. `cheapLimiter`
  keys per-IP (`ipKey`) regardless of auth, so authed behavior is byte-identical
  and unauthenticated floods now count.
- `routes/enrich.ts`, `routes/gradeWriting.ts`, `routes/lemmatize.ts` — now
  `cheapLimiter(), requireAuth, expensiveLimiter()`. `expensiveLimiter` MUST
  stay after auth: it keys per-USER when authenticated (`userOrIpKey`) — moving
  it before auth would silently demote every authed caller to per-IP keying
  (breaking the documented fair-share-behind-NAT design). The per-IP cheap
  limiter in front bounds unauthenticated floods (each bogus-cookie request
  costs one session-table lookup). Trade-off: authed calls to these routes also
  consume the shared per-IP cheap bucket (max 120/min vs the expensive 20/min)
  — negligible at this app's scale, documented here.
- `routes/auth.ts` — `POST /auth/logout` and `GET /auth/me` previously mounted
  **no limiter at all**. Both now run `authLimiter()` before `requireAuth`
  (the existing `/mfa/status` pattern). `authLimiter` counts FAILURES only
  (`skipSuccessfulRequests`), so legitimate authenticated polling of `/me` is
  never throttled.

**Tests**: `define.test.ts` — unauthenticated flood draws 429 (bucket shrunk to
3 via `_setConfigForTesting`, restored in `finally`); pre-fix this looped 401s
forever. `auth.test.ts` — unauthenticated `/me` (bogus cookie) and `/logout`
floods trip 429 within the AUTH_MAX=5 window; 10 successful authenticated `/me`
calls in a row all return 200 (skipSuccessfulRequests pinned). All existing
401/429 tests pass unchanged (first unauth request still 401; expensive-bucket
429 semantics untouched).

**DEFERRED — router-level `router.use(requireAuth)` files** (topik, grammar,
vocab, vocabLists, progress, plan, hanja, diagnostic, grammarDrill, ttmik,
images, krdict, conversation, settings, writing): their per-route limiters run
after the router-level auth. A blanket pre-auth `router.use(cheapLimiter())`
would (a) double-count media/audio streaming against the cheap bucket and undo
the F-012 media-bucket separation on `ttmik.ts`, and (b) demote nothing but add
cross-route bucket coupling on every JSON screen. The exposure is one indexed
session lookup per bogus-cookie request, on a private single-user app behind
Cloudflare + the nginx allow-list. Revisit with a dedicated pre-auth per-IP
bucket if the app ever goes multi-user/public (same trigger as F-UP-014).

## F-UP-018 · ApiError.message echo into ErrorCard (~5 pages) — **FIXED (app-wide)**

**Assessment**: real and wider than noted — `err instanceof ApiError ?
err.message : '<fallback>'` (echoing server prose) appeared at **28 call
sites across 9 pages**: Reference (11), Review (6), Chat (3), Ttmik (3),
Images (3, as `err.message || fallback`), Progress (2), Grammar (1),
Topik (1 inline alert), plus Diagnostic's `toMessage` (covered above).
Login/Settings/Writing already followed the fixed-copy contract.

**Decision — fixed copy via one shared helper**: new
`client/src/lib/errorCopy.ts` exports `errorMessageFor(err, fallback)` — fixed
strings keyed on the STRUCTURED fields only (`code: network/timeout`,
`status: 401/429` incl. the numeric `retryAfter`), falling back to the call
site's own author-controlled copy. Every echo site now routes through it, so
the useful distinctions (network vs session-expired vs rate-limited-with-
countdown) survive without ever rendering server prose. Images' local
`messageForUploadError` kept its richer per-status copy and just dropped the
three `err.message ||` prefixes.

**Tests**: `lib/errorCopy.test.ts` (prose never escapes across 7 status/code
shapes, fallback passthrough, fixed mappings, 429 retryAfter interpolation,
non-ApiError handling) + 7 existing page tests updated from asserting the echo
to asserting fixed copy AND prose absence (Chat, Images, Progress, Review,
Reference ×3), and the Ttmik/Diagnostic/Hanja tests above.

## F-UP-019 · reference.ts dead mock — **FIXED (deleted)**

Verified zero importers of `client/src/data/mocks/reference.ts`
(`REFERENCE_FIXTURE` / `loadReferenceMock`) — deleted the file, the orphaned
`ReferenceEntry` interface in `types/domain.ts`, and `ReferenceKind` (its only
consumer was `ReferenceEntry`; grep-verified nothing else references it).
No new test (deletion); TC=0 + full suite green is the regression proof.

---

## Skipped (noted per brief)

- **`'cards'` residue in the generic LineChart test fixture** (F-UP-016) —
  cosmetic label inside a test fixture, no runtime surface; the real vocab wire
  unit is already `reviews`. Not worth a diff.
- **SwipeCarousel `setPointerCapture` capture-throw corner** (F-UP-016) —
  theoretical, not reachable in practice per the original re-review; guarding
  it would add untestable code.

---

## F-UP-018 (re-review CONCERN) · MockMode.tsx echo site missed — **FIXED**

The app-wide ApiError-echo sweep missed `client/src/pages/topik/MockMode.tsx`
(flagged in `REVIEW_followups.md`): its local `toMessage` still did
`err instanceof ApiError ? err.message : fallback`, feeding raw server prose
into the ErrorCard at all 4 call sites (fetch failure ×2, submit failure ×2).

**Change** (`client/src/pages/topik/MockMode.tsx`): `toMessage` now delegates
to the shared `errorMessageFor(err, fallback)` from `lib/errorCopy` — same
conversion as `Diagnostic.tsx`. Each call site keeps its own fixed fallback
("Could not load the mock test." / "Could not submit the test.") unchanged;
the now-unused `ApiError` import was dropped.

**Tests** (`MockMode.test.tsx`, 2 new — 21/21 pass): a failed exam fetch with
an ApiError carrying relation-name prose renders the fixed "Could not load the
mock test." copy and the prose is ABSENT from the DOM; a failed submit with
FK-constraint prose renders "Could not submit the test.", prose absent, and
the "Retry submit" button still wired (mirrors the Diagnostic prose-absence
test).

**Gates**: TC=0 · LINT=0 · MockMode 21/21 · FULL=0 (whole client suite green),
run in the node:20-slim Docker verify harness.
