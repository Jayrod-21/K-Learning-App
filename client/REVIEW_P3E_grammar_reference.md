# Independent review — Pass 3 screens E (Grammar / Reference)

> Reviewer: independent senior engineer (30 yrs).
> Scope: `pages/Grammar.tsx` + `Grammar.test.tsx`, `pages/Reference.tsx` +
> `Reference.test.tsx`.
> Method: read both screens fully; read both test files fully; cross-checked
> `useEndpointOrMock` (lines 137-250), `services/grammar.ts` shape, the
> `MockBadge` PROD gate (`MockBadge.tsx:58`), `WordPopover`'s `useModalA11y`
> wiring, the reference mock fixture, and the Pass 2 PRAISE/fix-pass docs.
> Date: 2026-05-29.

## Verdict

**PASS WITH CONDITIONS.** Both screens hit their Pass 3 contracts cleanly.
Grammar's three tabs are properly differentiated; List/Banked wire to the
real services, Drill stays mock with an honest 🅂 badge, and the optimistic
bank → refetch reconciliation with 409 idempotency is correctly implemented.
Reference's debounced search re-keys `useEndpointOrMock` per-keystroke so
the Pass 2 fixpass D-SF-1 reset-on-key behaviour does exactly what it was
designed for (no stale-data flash, abort-previous on every settled
keystroke). The Pass 2 `items` memoization pattern is re-applied to Grammar
and intact (`Grammar.tsx:315-318`).

Concerns worth fixing before Pass 4 wiring lands on top of these:
**optimisticBanked accumulates without bound across the session**;
**Reference's MockBadge fires on the 'all' filter in production-mock
parity** because hanja has no `realFn`; and **the 409 idempotency path is
asserted in the JSDoc but not covered by a test** — the very property the
threat model leans on.

Roll-up:

| Category | Count |
|---|---:|
| BLOCKER | 0 |
| SHOULD-FIX | 6 |
| NIT | 8 |
| PRAISE | 7 |

---

## BLOCKERs

None. Nothing in scope prevents merge.

---

## SHOULD-FIX

### SF-1. `Grammar.tsx:271-310` — `optimisticBanked` never gets pruned; grows for the session lifetime

The bank flow adds the row's `patternKey` to `optimisticBanked` (line 271)
and **never removes it on success**. The JSDoc claims "Cleared implicitly
when refetch lands the server's view (the union below stays correct either
way)" (lines 207-209), but the union at lines 227-233 is a *merge*, not a
replace — `bankedKeys = base ∪ optimisticBanked`. The optimistic set is
only pruned on a non-409 failure (lines 298-302).

Effect: a long session that banks 200 patterns ends up with 200 entries in
`optimisticBanked` plus the same 200 in `bankedState.data`. The merge
creates a new `Set` on every render that has either state touched
(line 227). Cheap individually, wasteful over a long screen visit, and the
JSDoc explicitly promises a cleanup that never happens. Fix: after the
successful `bankPattern` call and after `bankedState.refetch()` has
returned a set containing `row.patternKey`, drop it from `optimisticBanked`
— or simpler, drop it unconditionally on the next render where
`bankedState.data?.has(patternKey)` is true.

Either rewrite the JSDoc to admit the overlay never clears, or clear it.
The current state is the worst of both.

### SF-2. `Grammar.test.tsx` does not cover the 409 idempotency path the threat model relies on

The Grammar JSDoc says (lines 22-29):

> bankPattern is the only state-mutating call. Server is idempotent on
> (user_id, pattern_key) … we treat 409 as success here too, since the
> post-condition holds either way.

The code at lines 293-294 has a dedicated branch for `apiErr.status === 409`
that keeps the optimistic add and refetches. **No test exercises this
branch.** The bank-happy-path test (Grammar.test.tsx:135-163) only covers
a 200. A `bankPattern.mockRejectedValueOnce(new ApiError('...', { status:
409, code: 'conflict' }))` test would prove the chip stays "Banked" and
`bankedState.refetch` is called — both observable post-conditions.

Without it, a regression that flips 409 to the error-rewind branch (which
already exists in the same function) would surface as a confusing chip
flicker in production, not as a test failure. This was explicitly called
out in the EVAL CRITERIA ("409 (duplicate-bank) treated as
success-equivalent? Verify the path is idempotent.").

### SF-3. `Reference.tsx:193, 215` — MockBadge always fires under the 'all' filter

`hanjaState` has no `realFn` (line 193), so it stays `isMock=true`
indefinitely until Pass 7. The `isMock` derivation is
`activeStates.some((s) => s.isMock)` (line 215). Under filter='all',
`activeStates = [vocabState, grammarState, hanjaState]` (line 206).
Therefore the 🅂 badge **always** paints on the Reference screen under the
default filter in any environment where MockBadge isn't gated out (it's
gated by `import.meta.env.PROD`, so this is a dev-only signal — but the
signal is now uninformative: vocab + grammar could be 100% real and the
badge still shows).

This is the inverse of Grammar's gating, which uses `&&`
(`listState.isMock && bankedState.isMock`, line 329). Both screens need to
mean the same thing. The honest reading for Pass 3 is: badge shows when
*the user's currently active source is mock*. Suggest:

- filter='all' → badge if `vocabState.isMock || grammarState.isMock`
  (hanja is known-mock pre-Pass 7 and shouldn't drag the badge across
  vocab+grammar success), OR
- filter='all' → badge if all three are mock (matches Grammar's gating
  shape), OR
- accept the current behaviour but document that the badge under 'all' is
  partial-mock until Pass 7. The screen-level JSDoc currently doesn't
  acknowledge this.

Pick one and make the comment match the code.

### SF-4. `Reference.tsx:199-206` — `activeStates` rebuilt on every render trips a downstream new-array identity

The comment at lines 197-198 ("we skip useMemo to avoid pretending it's
stable when it isn't") is defensible for the array itself, but the
consequences leak: `activeStates` is read by the `loading`/`allErrored`/
`isMock` derivations (lines 208-215) **every render**, and the retry
handler at line 363 (`for (const s of activeStates) s.refetch();`)
captures `activeStates` in an inline arrow. That arrow is new every
render → `ErrorCard`'s `onRetry` prop is new every render → if `ErrorCard`
ever picks up `React.memo` or a child component holds the prop, it
re-renders unnecessarily. Cheap today, sharp edge tomorrow.

`useMemo` IS correct here as long as the deps are the three state objects'
references (`vocabState`, `grammarState`, `hanjaState`), which DO change
identity every render — so the memo would never hit. The JSDoc reasoning
is right for *this* derivation. What's actually needed: extract the retry
function with `useCallback` over the three refetches:

```ts
const retryActive = useCallback(() => {
  if (filter === 'all' || filter === 'vocab') vocabState.refetch();
  if (filter === 'all' || filter === 'grammar') grammarState.refetch();
  if (filter === 'all' || filter === 'hanja') hanjaState.refetch();
}, [filter, vocabState.refetch, grammarState.refetch, hanjaState.refetch]);
```

— since `refetch` is a `useCallback` inside the hook (lines 245-247), its
identity IS stable.

### SF-5. `Reference.tsx:229-287` — `handleRow` is recreated every render and closes over render-time `setPopData`

Not a correctness bug — `useState` setters are stable — but `handleRow`
itself is an `async` arrow constructed inline at every render. It's passed
to row buttons via an inline `() => { void handleRow(r); }` (line 384). The
inline closure is fine; the outer `handleRow` recreation isn't strictly
needed. Wrap in `useCallback` with deps `[]` (since setters are stable and
no other reactive value is captured beyond `defineEntry`, which is a
module-scope import).

This becomes load-bearing the moment any row-level memoization is added
later in the cycle, e.g. for virtualised long lists. Cheap fix today,
removes a footgun.

### SF-6. `Grammar.tsx:233` — `bank` callback's dep array includes the whole `bankedState` object

Line 309: `[bankedKeys, bankedState]`. `bankedState` is the
`useEndpointOrMock` return value — `{ data, loading, error, isMock,
refetch }` — and its identity changes on **every render** because the hook
returns a fresh object literal. That means `bank` is recreated every
render, defeating the `useCallback`. The intent is to use
`bankedState.refetch`, which IS stable (per `useEndpointOrMock.ts:245-247`).

Fix: `[bankedKeys, bankedState.refetch]`.

The downstream impact today is small — the row's `onBank` prop is also an
inline arrow at the call site (lines 375-377) — but if any
`React.memo(PatternRow)` lands later (a reasonable optimisation for the
list path against KGIU's ~700 patterns), this dep will silently bust the
memo on every parent render.

---

## NIT

### N-1. `Grammar.tsx:118-128` — `toServerProficiency` swallows unknown values silently

The JSDoc says "Unknown strings fall back to `L3`" (lines 116-117) which is
the correct user-facing behaviour. A `console.warn` for unknown raw values
behind `import.meta.env.DEV` would catch corpus drift in dev without
shipping noise. Cheap insurance.

### N-2. `Grammar.tsx:136` — `row.source_id ?? row.pattern` for patternKey is a silent dedup-key collision risk

If two KGIU rows have `source_id=null` and the same `pattern` string (e.g.
'-더라도' appearing in two different lessons with different proficiency),
the patternKey collides, the optimistic Set treats them as the same row,
and banking one will visually flip both. The KGIU loader probably
guarantees `source_id`, but this code defends against null. If the fallback
is hit, hash in `row.id` too: `row.source_id ?? \`pattern:${row.id}\``.

### N-3. `Grammar.tsx:631-637` — `DrillPanel` `useEffect` doesn't surface load errors

`void loadGrammarMock().then(...)` swallows rejection. The mocked-loader
ErrorCard path at the page level (lines 453-459) handles this for List,
but `DrillPanel` independently calls `loadGrammarMock()` and silently
shows "Drill data unavailable" without logging. A `.catch((e) =>
console.error('drill mock load failed', e))` keeps dev signal alive.

### N-4. `Grammar.tsx:267, 303` — `bankError` is a single string, not per-row

If a user bangs Bank on row A (fails, sets `bankError`), then immediately
on row B (succeeds), `bankError` is cleared at line 267 — fine. But if
row B is still pending and row A's error is showing, the ErrorCard above
the list is ambiguous about which row failed. Per-row error in a Map
keyed by `patternKey` would be cleaner; not required for Pass 3.

### N-5. `Reference.tsx:269-275` — `setPopData((cur) => cur ? { ...cur, ... } : cur)` discards the augmentation if the popover was closed

If the user closes the popover between the synchronous `setPopData` (line
257) and the KRDICT `defineEntry` settle (line 265-274), `setPopData` is
called with `(cur) => cur` and the augmentation is lost. Harmless. But the
abort never happens — if a slow KRDICT eventually resolves AFTER a new
row was tapped, the older response will try to augment the new popover.
Result: vocab row B shows row A's part-of-speech briefly. Pass-3-quality
fix is to track an "active lemma" ref and gate the `setPopData` update
on `currentLemmaRef.current === r.kr` at settle time.

### N-6. `Reference.tsx:218-227` — union memo iterates each `data` slot every render

A trivial perf NIT for an unrealistic dataset size. KGIU is ~700 patterns,
vocab corpus could be much larger; if both are populated, the
spread+spread+spread allocates a new array of all rows every time `filter`
or any of three `data` references change. At Pass 3 size this is invisible.
At Pass 7 with hanja real-wired (5000+ characters?), virtualize the list
instead of spreading.

### N-7. `Reference.tsx:163-166` — `qInput` and `q` would be cleaner as `useDeferredValue`

React 18's `useDeferredValue(qInput)` does this exactly, with the bonus
that it ties into concurrent rendering. The setTimeout pattern works and is
explicit; this is purely a "modern primitive available" note.

### N-8. `Grammar.test.tsx:209-223` — drill-tab MockBadge test doesn't assert it disappears returning to list

The test asserts badge OFF on list (line 218), badge ON on drill (line 222).
A follow-up `await user.click(screen.getByRole('tab', { name: 'List' }))`
+ `expect(...mock-badge...).not.toBeInTheDocument()` would gate the
"toggle off" path too. Two lines, full state-machine coverage.

---

## PRAISE — fix-pass must not undo

### P-1. The `items` memoization is correctly re-applied (`Grammar.tsx:315-318`)

The Pass 2 Reference fix-pass introduced `useMemo(() => listState.data ?? [],
[listState.data])` to stop `[] !== []` from busting downstream memos. The
same pattern is correctly re-applied here, with a comment that says exactly
what it's for (lines 313-315). `bankedItems` then depends on `[items,
bankedKeys]` (line 322) — both stable — and that memo can actually hit.
Keep.

### P-2. The 409 → success-equivalent code branch (`Grammar.tsx:293-295`)

The idempotency contract is correctly honoured at the client: 409 is not an
error, the optimistic add stays, the server view gets refetched. This is
exactly what the JSDoc threat model promises. **Do not** "simplify" this
into a single error path. (Pair with SF-2: add the test.)

### P-3. The mock + real id namespace split (`Grammar.tsx:148-150`)

Mock rows synthesise negative ids; real rows use BIGINT positives. This
trivially prevents `getPattern(-1)` from ever hitting the real server when
a Sheet opens on a mock row (and the `isReal` flag in `openDetail` line 240
short-circuits the fetch entirely). Defensive in depth. Keep.

### P-4. Reference's `q` debounce + key-driven reset = race-free per-keystroke search

The debounce (lines 152-159) gates `q`; `q` is the key suffix for both
`vocabState` (line 166) and `grammarState` (line 178); `useEndpointOrMock`
aborts the previous in-flight call and clears `data`/`isMock` on key
change (per the hook's lines 171-198 + 236-238). The screen therefore
satisfies the Pass 2 fixpass D-SF-1 design contract per-keystroke without
extra plumbing. This is the cleanest expression of the contract in the
codebase to date — Today/Review/Reading/Chat all use single fixed keys.

### P-5. The synchronous-then-augment popover pattern (`Reference.tsx:257-275`)

Open the popover instantly with row data (line 257), enrich asynchronously
with KRDICT (line 265-274), silently swallow 404 (line 278-282), surface
non-404 (line 283-285). This is the right user-facing latency story
(no "Loading…" flash for a popover) and the right error story (no popup
for "we just didn't have a dictionary entry"). Keep the shape.

### P-6. Threat model paragraphs are concrete and non-vapid

Grammar.tsx:21-39 and Reference.tsx:20-37 enumerate specific attack
vectors (CSRF surface, innerHTML avoidance, body-size guard deferred to
server, debounce as rate-limit, lemma origin guarantee) — not the
"validates input, encrypts data" boilerplate that fails the senior bar.
This is the standard the Senior Engineer Bar §SECURITY asks for. Keep.

### P-7. ErrorCard + refetch primitives used end-to-end, no `window.location.reload()`

Both screens wire ErrorCard's `onRetry` to `useEndpointOrMock.refetch`
(Grammar.tsx:457, 393-394, 565; Reference.tsx:362-364). The hard-reload
retry primitive is nowhere in scope. Pass 1 PRAISE preserved.

---

## Tests — coverage table

| Criterion | Grammar.test.tsx | Reference.test.tsx |
|---|---|---|
| Happy path | ✓ lines 124-133 | ✓ lines 134-141 |
| Bank action | ✓ lines 135-163 | n/a |
| 409 idempotency | **✗ missing (SF-2)** | n/a |
| Detail Sheet → service call | ✓ lines 186-205 | n/a |
| Debounce → service call w/ q | n/a | ✓ lines 158-176 |
| Filter switch | n/a | ✓ lines 144-156 |
| Row → popover/define | n/a | ✓ lines 179-191 |
| ErrorCard + Retry | ✓ lines 165-182 | ✓ lines 194-215 |
| Drill MockBadge gating | ✓ lines 209-223 (one-way only, see N-8) | n/a |

Overall test posture is solid. The single material gap is SF-2.

---

## Threat-model check (per criteria)

- **Search input is user-controlled.** Server-side Zod validation
  acknowledged in JSDoc (`Reference.tsx:25-30`); React text-escapes the
  rendered count + row strings (line 369). No `dangerouslySetInnerHTML`,
  no markdown parser, no `eval`. ✓
- **Per-keystroke rate limit.** Debounce (200 ms) + abort-previous via
  key change → in-flight `AbortController` aborts on every key tick. ✓
- **bankPattern idempotent.** Server contract documented at
  `grammar.ts:51` ("Idempotent on (user, pattern_key)"), client honours
  409 as success at `Grammar.tsx:293-295`. ✓ (test gap — see SF-2.)
- **CSRF on bankPattern.** Stated as `SameSite=Strict` in the JSDoc; not
  verified in this scope but the screen doesn't undermine it.
- **No PII flow into logs.** Neither screen logs anything.

---

## Quick recommendation

Land this as-is if the deadline is tight. Before Pass 4 wiring on top of
either screen, address SF-1 (memory hygiene), SF-2 (test the 409 path you
documented), and SF-3 (badge gating semantics). SF-4/SF-5/SF-6 are
hygiene; address them if you're already in the file. NITs are NITs.

The Pass 2 patterns (memoized `items`, ErrorCard + refetch, modal a11y
through `useModalA11y`, MockBadge PROD gate, no hard-reload retry) are
preserved across both screens.
