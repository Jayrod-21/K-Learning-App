# REVIEW_P3C — Reading + Chat (Pass 3)

> Independent senior review (30-yr engineer hat). No code was modified; this
> file is observation-only. Findings are cited at `file:line` against the
> tree as of 2026-05-29.

## Scope

- `client/src/pages/Reading.tsx` + `Reading.test.tsx`
- `client/src/pages/Chat.tsx` + `Chat.test.tsx`
- `client/src/services/conversation.ts` — the `requestId` extension

## Headline verdict

**PASS WITH CONDITIONS.** Both screens land their Pass 3 wiring with strong
threat-model headers, honest disclosure of known mismatches, and PRAISE
preservation from Passes 1+2 intact. The blockers are not in the production
code — they are in the test gaps that the original review prompt explicitly
called out. Two SHOULD-FIXes are real correctness concerns (no loading
affordance on the slow-path, malformed `data` shape escape in Chat). Threat
models are detailed and largely accurate; one minor cookie-posture line in
the Chat header is more aspirational than enforced.

| Category | Count |
|---|---|
| BLOCKER | 0 |
| SHOULD-FIX | 6 |
| NIT | 7 |
| PRAISE | 9 |

---

## BLOCKER

_None._ Production paths are coherent, threat-modelled, and degrade
gracefully. Test gaps below are SHOULD-FIX not BLOCKER because the screens
work; the gaps are coverage debt that compounds in future passes if not
addressed soon.

---

## SHOULD-FIX

### SF-1 — Slow-path tap has no loading affordance for the user
`client/src/pages/Reading.tsx:362-419` (`runSlowPath`),
`Reading.tsx:430-448` (`handleOpenWord`)

The slow-path chain (lemmatize → define → enrich) can take seconds against a
cold KRDICT + Claude. The code comment at `Reading.tsx:368-371` candidly
admits: *"The popover doesn't have a loading variant in Pass 3, so we land
the resolved data in one update."*

User-visible effect: tap a non-fixture word → screen does nothing visible
until the chain settles. There is no spinner, no popover-with-skeleton, no
disabled cursor. A 2-second cold-start looks like a dead tap; users will
re-tap, doubling network cost and stacking `beginInteraction` aborts. On a
3G phone this is the difference between "the app feels alive" and "this app
is broken".

Two acceptable fixes, in order of preference:

1. Open the popover immediately in a `kind: 'loading'` state (bare lemma
   + spinner) and patch in the define/enrich result when it lands. This
   also matches the optimistic-UI posture used in Chat.
2. At minimum, set a temporary `aria-busy` on the tapword button itself so
   AT users hear a pending state, and add a cursor: progress on `body`.

The threat-model header already documents the abort/race semantics; this
fix just makes the UX honest about what is in flight.

### SF-2 — `vocabInitCards` corpus is hard-coded; wiring is not "honest" so much as misleading
`client/src/pages/Reading.tsx:504-524` (`handleAdd`),
`Reading.tsx:121-122` (`DEFAULT_VOCAB_CORPUS`)

The file-header threat-model paragraph (lines 76-82) acknowledges that
`initCards` is a *corpus slice* init, not a per-entry bank, and that the
per-entry endpoint doesn't exist yet. That disclosure is good practice.

What the code actually does on tap: `vocabInitCards({ corpus:
'vocab_2000_intermediate', limit: 1 })`. The semantics:

- The corpus default is **fixed** at module scope — Reading currently
  hardcodes `'ttmik'` as the source corpus (`DEFAULT_CORPUS`, line 121)
  but the *bank corpus* is `'vocab_2000_intermediate'` (line 122). A user
  reading a TTMIK lesson banks against `vocab_2000_intermediate`, which
  has nothing to do with the word they tapped.
- `limit: 1` doesn't seed the tapped word — it seeds *whatever the first
  unbanked card from the corpus is*. The local `minedIds.add(d.kr)`
  reflects the user's intent; the server call reflects a different one.
- The catch on line 519-522 swallows the error silently, with a comment
  "swallow — local mined state already reflects the user's intent".

This is OK for Pass 3 as a placeholder, but the call should be a no-op
local-only until the per-entry endpoint lands. Firing a wrong-shaped server
call obscures real failures and pollutes the user's FSRS queue with random
cards. Concretely:

- Remove the `vocabInitCards(...)` call from `handleAdd` and leave a
  `TODO(FU-…) per-entry bank when the endpoint lands` comment with the
  ticket number, OR
- Make the call carry the actual entry id (`d.vid`?) once the endpoint
  exists.

The "we exercise the auth/CSRF path" justification doesn't pay for the cost
of a misleading mutation on every Add-to-bank.

### SF-3 — Chat's `data` discriminator silently coerces malformed envelopes to "mock"
`client/src/pages/Chat.tsx:182-192` (`serverList` / `mockSeed`)

The discriminator treats `data` as either:
- `Array<ConversationMessage>` → mockSeed
- `{ conversations: … }` → serverList
- anything else → neither

The fall-through case (`return null;` at line 186) hides a real shape drift.
If `listConversations` ever returns `{ conversations: null }` or `{
conversations: 'not-an-array' }` due to a server change, both branches
silently produce `null` / `[]` and the screen renders the empty-state path
WITHOUT the `MockBadge`, WITHOUT an error, WITHOUT logging. The bug only
surfaces when a user tries to send and gets a confusing experience.

The `pickActiveConversation` defensive check (`Array.isArray(list
.conversations)`, `Chat.tsx:146`) is the right pattern; do the same here:

- Validate the envelope shape at the boundary (`useMemo`).
- On unknown shape, set an error state (toast + log warn).
- Never silently degrade malformed-server-data to mock-style UX, because
  the user has no visual cue that anything is off.

### SF-4 — `pickActiveConversation` sort doesn't tolerate non-string `updated_at`
`client/src/pages/Chat.tsx:148-152`

The sort does string-comparison on `updated_at`. The threat-model comment
correctly notes that ISO-8601 strings sort lexicographically. But if any
row arrives with `updated_at` as `null`, `undefined`, or a non-ISO format
(e.g., a Postgres-default `now()::text` rendering with timezone offset
notation `'2026-05-29 12:00:00+00'` instead of `'2026-05-29T12:00:00Z'`),
the comparison silently produces wrong order — the most-recent row is no
longer at index 0, and the user is anchored to a stale conversation.

The TS type on `ConversationRow.updated_at` is `string` (`domain.ts:820`)
but the server contract is not enforced at runtime. Add a defensive
runtime parse:

```ts
const ts = (s: string): number => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
};
rows.sort((a, b) => ts(b.updated_at) - ts(a.updated_at));
```

This also matches the standard idiom for ISO date sort and removes the
"strings happen to sort the same as dates" footgun in the comment.

### SF-5 — Test gap: `streamMessage` requestId → `X-Request-Id` header forwarding is uncovered
`client/src/services/conversation.test.ts` — entire `streamMessage` block

The original review prompt explicitly listed this as in-scope. The service
(`conversation.ts:127-129`) forwards `opts.requestId` into the SSE
`headers: { 'X-Request-Id': opts.requestId }`. The test for `streamMessage`
covers URL composition (`:73-110`), event forwarding (`:112-130`), and
error propagation (`:132-145`), but never asserts the header.

A test like:

```ts
it('forwards requestId as X-Request-Id header', async () => {
  let capturedOpts: SseStreamOptions | null = null;
  vi.spyOn(sse, 'streamSse').mockImplementation(async (_url, _h, opts) => {
    capturedOpts = opts as SseStreamOptions;
  });
  const ctrl = new AbortController();
  await streamMessage(7, { content: 'hi', expected_version: 1 }, {
    signal: ctrl.signal, onDelta: () => undefined, requestId: 'abc-123',
  });
  expect(capturedOpts?.headers).toMatchObject({ 'X-Request-Id': 'abc-123' });
});
```

Without this, a future PR could regress the header (e.g., a refactor that
renames `requestId` to `requestID`) and CI would stay green.

### SF-6 — Test gap: Chat retry does not assert same-requestId reuse
`client/src/pages/Chat.test.tsx:281-311` (error path)

The error-path test (`:281-311`) renders the Retry button but never clicks
it, and never asserts the second `streamMessage` call's `requestId` matches
the first one's. This is the exact correctness property the threat-model
header (lines 42-47 of Chat.tsx) bills as the idempotency contract.

The original review prompt called this out explicitly: *"X-Request-Id
reuse on retry of a failed turn (not a fresh id)"*. The test should:

1. Fire the first send, capture `requestId = streamCalls[0].requestId`.
2. Reject the stream → row becomes `failed`.
3. Click the Retry button.
4. Assert `streamCalls[1].requestId === streamCalls[0].requestId`.

Same test should also assert that a *new* user submit after a successful
turn DOES mint a fresh id (the inverse property). Without this pair, the
idempotency contract is documented but unverified.

---

## NIT

### N-1 — `popoverFromDefine` ignores `enrichSummary === ''` distinction
`client/src/pages/Reading.tsx:248-262`

`summariseEnrichment` returns `string | null`. `popoverFromDefine` checks
`enrichSummary ?? 'Dictionary entry'`. If the enrichment summary is the
empty string `''`, `??` doesn't kick in, and the popover shows an empty
`en` line. Use `enrichSummary || 'Dictionary entry'` (truthy fallback) or
have `summariseEnrichment` normalise empty-to-null at the source.

### N-2 — `sentenceTextForGloss` and `sentenceTextForGrammar` do O(n²) scans on every tap
`client/src/pages/Reading.tsx:542-586`

Each tap walks `data.sentences` × `sent.tokens` until a match. For a
30-sentence passage with ~20 tokens each this is 600 comparisons per tap —
fine in practice, but a passage-tokens precomputed `Map<glossKr, sentence>`
in a `useMemo` would be O(1) per tap and matches the pattern the rest of
the codebase uses for derived lookups. Filed as nit; not worth a SHOULD-FIX
unless passages grow past 100 sentences.

### N-3 — `sentenceTextForGloss` keys on `gloss.kr` only, which can collide
`client/src/pages/Reading.tsx:542-555`

If two sentences contain a token whose gloss `kr` matches (common — same
word in two sentences), the helper returns the first sentence's text every
time. The `enrich` call's `sourceSentence` is therefore wrong for the
second occurrence. Acceptable for Pass 3 because the slow-path output
doesn't surface the sentence to the user, but Pass 4+ that uses sentence
context for disambiguation will break here.

### N-4 — `tokeniseSentence` placeholder `pos: 'n.'` is type-correct but semantically lies
`client/src/pages/Reading.tsx:189-213`

Every placeholder token gets `pos: 'n.'` because `PartOfSpeech` is a closed
union (`domain.ts:34`). Until the slow-path resolves, every tapword's
popover would briefly claim "n." even for verbs. The fast-path/slow-path
branch in `handleOpenWord` keys off `en === ''` (the placeholder sentinel),
so the popover never actually shows the stale `pos` for placeholders — but
the code's defensive contract would benefit from a `pos?: PartOfSpeech`
(make it optional on `PassageGloss`) so the lie is structural, not
semantic.

### N-5 — `mintRequestId` fallback is not RFC 4122 v4 — version/variant bits aren't set
`client/src/pages/Chat.tsx:435-446`

The fallback path produces a UUID-shaped string but doesn't set the version
nibble (`4` in position 13) or the variant bits. The threat-model header
acknowledges the id is opaque to the server, so this isn't a correctness
bug; it is a maintainability nit. Either:

- Add a comment line above the fallback noting "shape only, not RFC4122-
  compliant — fine because server treats opaque", or
- Pull a small `uuidv4()` helper into `lib/`.

The current code reads like it intended to be v4-compliant.

### N-6 — `setSendError(message)` echoes raw server error text into the UI
`client/src/pages/Chat.tsx:378-381, 415-419, 484-487`

`message = err.message` — for an `ApiError` this is whatever the server
echoed. SECURITY.md §3 documents that for the auth UI, server messages are
never echoed (`messageFor` lookup table). The same discipline should apply
to Chat. Today a malicious upstream that lands a `500` with `"<script>"` in
the body — defended at the network layer + React text-escape, but a
nuisance message like `"undefined is not a function at line 47"` leaking
into the user's view is bad UX. Map known `ApiError.code` values to fixed
strings; fall back to "Send failed. Please retry." for unknowns.

This is a nit, not a SHOULD-FIX, because React-text-escape covers the XSS
vector and the threat-model header in Chat correctly cites it.

### N-7 — Chat's `seed` recomputes whenever `settings.name` flips, including identity
`client/src/pages/Chat.tsx:213-226`

`personalise` rebuilds an array with `[…modified, ...slice(1)]` each call.
The `seed` useMemo therefore produces a new identity every time `settings
.name` changes (correct intent: refresh the opener), and the head-replace
effect (lines 245-268) handles it gracefully. But `personalise` is called
twice in the useMemo branches (lines 220 + 223) — pull the call to the
top so the personalised opener path and the mock-personalised path share
one computation. Trivial.

---

## PRAISE

### P-1 — Threat-model headers are excellent
Both file headers (`Reading.tsx:41-83`, `Chat.tsx:28-60`) read like the
work of an engineer who has been bitten before. The stale-popover-race,
optimistic-UI-rollback, X-Request-Id-idempotency, and same-origin-cookie-
posture paragraphs are the four hardest things to get right in this kind of
screen, and each one is named, defended, and cross-referenced to a
specific code location. This is the bar the project's SENIOR_ENGINEER_BAR
.md asks for; this is what it actually looks like.

### P-2 — Honest disclosure of the `initCards` slice-vs-per-entry mismatch
`Reading.tsx:76-82` — the threat-model paragraph spells out exactly what
the call does, what it should do, and why the current shape is wired the
way it is. This is the right way to ship a known-imperfect Pass: the
reviewer can audit the gap without spelunking. (SF-2 still recommends
removing the call entirely, but the disclosure itself is exemplary.)

### P-3 — Graceful degradation chain is correctly tiered
`Reading.tsx:362-419` — `lemmatize` failure → fall through with raw form;
`define` failure → bare-lemma popover with enrichment fallback; `enrich`
failure → dictionary entry only. Each `if (ctrl.signal.aborted) return;`
guard between stages prevents the late-resolve clobber documented in the
threat model. This is textbook progressive degradation.

### P-4 — `seededRef` Pass-2 invariant preserved
`Chat.tsx:244-268` — the comment block explicitly cites the Pass-2 bug it
prevents ("the previous shape re-ran `setMsgs(seed)` on every `seed`
identity change, which wiped user-sent turns whenever `settings.name`
changed"). The head-only refresh path correctly preserves user-sent +
streamed-tutor turns. This is the textbook "name what you're defending
against in the comment so the next refactor doesn't re-break it" pattern.

### P-5 — Per-send AbortController + unmount cleanup
`Chat.tsx:279-284, 327-329, 419-423` — controller per send, current
controller tracked on a ref, unmount effect aborts whichever is current,
finally-block only releases the latch if the controller is still current
(handles unmount-mid-stream cleanly). Closes the FU-NF-4 streaming-abort
ticket as advertised. Also note the catch's `ApiError.code === 'canceled'`
swallow (line 376-378) — keeps the UI quiet on the unmount path.

### P-6 — `useModalA11y` on `WordPopover` intact
`WordPopover.tsx:103-108` — the Pass-2 fixpass extraction is preserved
verbatim. Reading still passes `data` through unchanged, so focus
restoration / Esc / focus trap / scroll lock all still work for the slow-
path popover.

### P-7 — `KoreanPassage` dynamic gid extraction intact
`KoreanPassage.tsx:130-160, 184-185` — the Pass-2 dynamic `*-start` /
`*-end` parsing (vs the prototype's hard-coded `'g4'`) is preserved.
Reading's `sentenceTextForGrammar` (lines 557-586) correctly cooperates
with this by looking up by `${gid}-start` / `${gid}-end` markers.

### P-8 — `gram-span` keyboard handler (Pass 2 fix) intact
`KoreanPassage.tsx:138-152` — role=button, tabIndex=0, Enter+Space key
handler, aria-label. The Pass 2 fixpass E-SF-2 finding is preserved; Reading
tests reference `getByRole('button', { name: /Grammar pattern g4 — open/i
})` (`Reading.test.tsx:380-383`) confirming the gesture parity.

### P-9 — `ErrorCard` + `refetch` substrate used correctly
`Reading.tsx:629-634` and `Chat.tsx:563-567` — both screens use the Pass-2
extracted `ErrorCard` component, and `retry` calls the hook's `refetch`
function rather than `window.location.reload()`. The Pass-2 fixpass cross-
cutting refactor (E-SF-5) is preserved.

---

## Threat-model adequacy check

### Reading
- [x] Behavioural telemetry leak via tap-anything — defended (server-side rate limit, no client batching).
- [x] Independent-failure surface — graceful degradation contract documented + implemented.
- [x] Stale-popover resolution race — AbortController + ignore-late-resolves pattern documented AND covered by code (services don't accept signal yet; ignore-late-resolve guards are correct).
- [x] Passage rendering — React text-escape contract, no `dangerouslySetInnerHTML`.
- [x] Add-to-bank corpus default — mismatch is documented (see SF-2).
- [ ] **Missing**: rate-limit-induced repeat-tap behaviour. If `/enrich` returns 429, the user has no indication and may re-tap, compounding the problem. Threat model documents the rate limit; it should also document the client-side response (today: nothing — falls under SF-1 loading-affordance).

### Chat
- [x] Streaming abort + no-half-turn — explicit, references server SECURITY.md §10.
- [x] Concurrent-send race — `streaming` gate + `aria-busy` on the button, both verified.
- [x] Network-flap retry idempotency — documented; coverage gap noted at SF-6.
- [x] Optimistic-UI rollback — partial tutor dropped, user row marked failed; behaviour matches the docstring contract.
- [x] XSS via React text-escape — explicit, including `settings.name` template path.
- [x] Conversation impersonation — server-scoped to cookie user, correct cross-reference.
- [x] Same-origin cookie posture for SSE — documented in `conversation.ts:6-15`, matches SECURITY.md §2.
- [ ] **Missing**: streaming-mid-network-flap (TCP RST mid-stream, not a clean error). `sseStream.ts:184-208` handles this as an early `done: true` with no `onError` — Chat would finalise a *truncated* tutor reply as if complete. The threat-model header should call this out; in practice the server's `done` envelope (P3A contract) is what disambiguates clean vs truncated, and the client trusts `done` from the stream. Worth a paragraph.

---

## File pointers for the fix pass (if any)

- `client/src/pages/Reading.tsx` — SF-1 (slow-path loading), SF-2 (initCards), N-1..N-4.
- `client/src/pages/Chat.tsx` — SF-3 (envelope validation), SF-4 (date sort), N-5..N-7.
- `client/src/pages/Chat.test.tsx` — SF-6 (retry-with-same-id assertion).
- `client/src/services/conversation.test.ts` — SF-5 (X-Request-Id header assertion).

## Sign-off

Pass 3C Reading + Chat is a substantive, professional integration. Production
paths are correct, the threat-model headers are at the SENIOR_ENGINEER_BAR
.md level, and Pass 1+2 PRAISE items are all intact. The two test gaps
(SF-5, SF-6) and the user-visible slow-path silence (SF-1) are the highest-
leverage items; address those and SF-3 / SF-4 in a small follow-up and this
ships clean.
