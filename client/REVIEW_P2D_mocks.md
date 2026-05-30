# /fixpass review — Pass 2 / D: mocks + `useEndpointOrMock` + MockBadge + domain types

**Reviewer**: independent senior (30y, did not author this code).
**Date**: 2026-05-29.
**Scope**:
- `src/types/domain.ts`
- `src/data/mocks/_delay.ts`
- `src/data/mocks/{today,topik,reading,review,diagnostic,grammar,hanja,images,chat,reference,settings}.ts`
- `src/hooks/useEndpointOrMock.ts`
- `src/hooks/useEndpointOrMock.test.ts`
- `src/components/MockBadge.tsx`
- MockBadge classes in `src/styles/index.css`

**Verdict**: **PASS WITH CONDITIONS**. The contract is honoured, the fixtures are faithful, the hook is StrictMode-safe and properly aborts. Three SHOULD-FIXes are load-bearing for Pass 3 (stale-data flicker on key change, missing CSS classes the scope explicitly called for, missing threat-model header on the future-real-endpoint substrate).

| Category | Count |
|---|---:|
| BLOCKER | 0 |
| SHOULD-FIX | 5 |
| NIT | 9 |
| PRAISE | 8 |

---

## BLOCKERs

None.

---

## SHOULD-FIX

### SF-1 — `useEndpointOrMock.ts:114-178`: stale `data`/`isMock` on key change causes UI flicker
When `key` changes, the effect sets `loading=true` and `error=null` but **does not reset `data` or `isMock`**. The component re-renders with `{ data: <previous result>, loading: true, isMock: <previous flag> }`. Two consequences:

1. The screen shows the prior screen's data underneath the skeleton (or briefly stays on stale content while the spinner starts).
2. If the previous fetch came from the mock and the next fetch is real (or vice versa), the **🅂 badge stays in its old state** until the new resolve. This contradicts the "no silent mock in prod" contract — for a brief window during a refetch, `isMock` lies about the data currently rendered.

Recommended fix at lines 122-123:
```ts
setLoading(true);
setError(null);
setData(null);   // add
setIsMock(false); // add — badge follows real data only
```

This will surface as a real bug the moment Pass 3 introduces key-driven refetches (e.g. Review's `cardId` changes, Reading's `passageId` changes).

### SF-2 — `MockBadge.tsx:63` references `km-mock-badge` class that does not exist in `styles/index.css`
The scope explicitly called for "MockBadge classes in `src/styles/index.css`". `grep -n "mock\|km-mock\|MockBadge" styles/index.css` returns nothing. The component sets `className="km-mock-badge"` but the class is undefined, so every style relies on inline `STYLE` only.

Two problems:
- **No way to theme/override** without editing the component file. The component header even argues "If the design swaps the glyph from 'S' to '模', every screen flips together" — but the visual styling can't follow that pattern because there's no CSS hook.
- Dead `className` is misleading to readers — it suggests styles exist somewhere.

Either (a) move the inline styles to a `.km-mock-badge` rule under `styles/index.css` and keep only positioning inline (or drop inline entirely), or (b) remove the unused `className` and document that the component is intentionally inline-only.

### SF-3 — `useEndpointOrMock.ts:1-31` header is missing the threat-model paragraph the SENIOR_ENGINEER_BAR + Pass 3 wire-up requires
The Pass 2 prompt explicitly asks whether the hook's threat-model comment header "anticipates the Pass 3 wire-up (where realFn becomes a network call)". It does not. The header documents behaviour and rationale, but not threats. Per `SENIOR_ENGINEER_BAR.md §2 "Security (every component)"` and §5 "`SECURITY.md` written, attack vectors enumerated", this hook — the substrate every Pass 3+ network call will flow through — needs the same threat-model block the Pass 1 fix-pass extracted from `api.ts`/`AuthProvider.tsx`/`Login.tsx` into `client/SECURITY.md`.

Recommended enumeration (each one is a real Pass 3 risk):
- **Untrusted realFn output**: hook stores `await realFn()` straight into `data` with `T`-typed return — no runtime validation. When Pass 3 wires up axios, a compromised endpoint returns arbitrary JSON; the screen renders it. Mitigation: document that the wire layer (Pass 3) MUST validate with zod/io-ts at the boundary before resolving into the hook.
- **Mock-fallback masking server compromise**: on `realFn` reject the hook falls back to the mock and the screen renders. If the server is hijacked and starts 500ing, the user sees mock data with no signal in dev (badge OFF in prod). The `error` field carries the failure, but a screen that doesn't surface it shows fake data. Mitigation: document that production screens MUST render the error path; the fallback is dev-time only behaviour.
- **AbortError leakage**: ApiError code `canceled` should never reach a user toast (the user caused it). The hook already separates this in normaliseError upstream, but the comment at line 150-152 hand-waves "preserve" — make explicit that downstream toast layer MUST filter `code: 'canceled'`.
- **Stale-closure write-after-unmount**: addressed by `safeSet` — call out as explicit defense, not just behaviour.

A 6-line `Threats:` block in the header is enough. Promotion to `client/SECURITY.md` should happen when Pass 3 lands.

### SF-4 — `useEndpointOrMock.test.ts` does not cover the realFn-aborts-on-unmount path
Test 4 (`'aborts in-flight requests on unmount without writing state'`) uses `mockFn` only. The realFn branch (lines 141-153 in the hook) has no abort-on-unmount test — if a future change accidentally awaits something outside `raceAgainstAbort` inside the realFn branch, the suite will miss it.

Add a sixth test:
```ts
it('aborts the realFn branch on unmount', async () => {
  const pending = (): Promise<never> => new Promise<never>(() => {});
  const realFn = vi.fn(pending);
  const mockFn = vi.fn(async () => ({ x: 1 }));
  const { result, unmount } = renderHook(() =>
    useEndpointOrMock('k6', mockFn, { realFn }),
  );
  expect(result.current.loading).toBe(true);
  unmount();
  await act(async () => { await wait(20); });
  expect(result.current.loading).toBe(true);
  expect(mockFn).not.toHaveBeenCalled(); // critical: mock fallback must NOT run
});
```

Also: no test covers the StrictMode double-mount scenario (`renderHook` does not enable StrictMode by default). Either add one with `wrapper: ({ children }) => <StrictMode>{children}</StrictMode>` or add a JSDoc note that the dev shell mounts StrictMode and exercises this path.

### SF-5 — `_delay.ts` non-determinism makes the test suite flaky over time
`mockDelay()` uses `Math.random()`. Two tests (the abort test, the mock-only failure test) implicitly rely on the 60–120 ms band being short enough that `waitFor` finishes inside its 1000ms default. That holds today. But:
- The delay is non-mockable from outside (no module-level export of the RNG or the range).
- The header explicitly says "If a future test needs determinism it should mock this module directly." Fine — but then every screen test in Pass 3+ will need `vi.mock('../data/mocks/_delay')` boilerplate.

Cleaner: export `setMockDelayRange(minMs, maxMs)` (or a single `mockDelayMs` module-level let) so the test suite can call `setMockDelayRange(0, 0)` once in setup. Pure-determinism approach beats `vi.mock` chunks in every spec.

Lower-priority alternative: keep as-is and add a `// vitest-environment: jsdom; tests should mock this module` banner.

---

## NITs

### N-1 — `domain.ts:31`: `LevelLabel` allows both `'L4–5'` and `'L4-5'` (en-dash and hyphen)
Same for `'L3-4'`/`'L3–4'`. The union accepts both because data.js has `'L4-5'` in one place and `'L4–5'` in another. That's data-side inconsistency the type union papers over. Either normalise the fixtures to one dash (en-dash matches the prototype's typography) and drop the hyphen variant, or add a code comment explaining why both are accepted.

### N-2 — `domain.ts:34`: `PartOfSpeech` is fragile
`'n.' | 'v.' | 'adj.' | 'adv.' | 'pn.' | 'n./adv.'` — the dot suffix and the compound `'n./adv.'` are presentation concerns leaking into the domain type. If a future entry is `'n./v.'`, the type breaks. Either drop the dot (`'n' | 'v' | ...`) and let the renderer append it, or add `string` as a fallback with a runtime guard.

### N-3 — `domain.ts:43`: `CardState` includes `'produced'` but `HanjaState` does not
The two states are nearly identical but diverge by one variant. The comment "Vocab card SRS state. Prototype only tracks 3 states." says 3, but the union has 4 (`new | practicing | banked | produced`). Either the comment is wrong or `'produced'` shouldn't be there. data.js has `state: 'produced'` on g3, so the value is real. Fix the comment.

### N-4 — `domain.ts:227,386`: structural `interface { new: number }` uses a reserved-word property
TypeScript allows `new` as an object key, but it's an avoidable readability hazard. The data.js fixture uses `new: 2` (a real bareword in object literal); the interface does too. Consider `'new'` quoted for the literal type or rename to `newCount` with a `// JSON: "new"` comment.

### N-5 — `useEndpointOrMock.ts:82-88`: `toApiError` discards the original error's stack
`new ApiError(err.message, { status: 0, code: 'unknown' })` constructs a fresh Error, losing the original stack. For debugging Pass 3+ wire failures, preserving the chain (`cause: err`) — `new ApiError(err.message, { status: 0, code: 'unknown', cause: err })` if ApiError supports it, or via `Error.captureStackTrace` — would help. Low priority since ApiError currently doesn't accept `cause`.

### N-6 — `useEndpointOrMock.ts:115`: aborting a freshly-constructed controller in `useRef` initialisation
`ctrlRef.current?.abort()` runs every effect activation. On the first run, `ctrlRef.current` is null — no-op. Fine. On StrictMode double-mount, the first effect's controller gets aborted, the second effect creates a new one. Correct. Worth a one-line code comment at line 115 making this explicit (the existing line 108-110 comment talks about it abstractly).

### N-7 — `useEndpointOrMock.test.ts:97`: `pending` returns `Promise<never>` but `mockFn` typed as `() => Promise<{ greeting: string }>` via vi.fn
The `vi.fn(pending)` typing infers `Promise<never>`. Tests pass under loose vitest typing but a stricter inference (TS 5.6+) would complain that `never` is not assignable. Add an explicit cast: `vi.fn<() => Promise<{ greeting: string }>>(pending)` for forward safety.

### N-8 — Mock fixtures duplicate data.js verbatim — no single source of truth
`reading.ts`, `hanja.ts`, etc. duplicate `data.js` content in TS form. Future drift is guaranteed when the prototype evolves. A small `scripts/sync-from-design.mjs` that reads `Claude Design/.../data.js` (via eval into a sandboxed `globalThis`) and codegens the TS fixtures would prevent that. Not Pass 2 work, but worth a TODO comment in `types/domain.ts` referencing the drift risk.

### N-9 — `MockBadge.tsx:25`: `import type { CSSProperties, JSX }` only consumes `CSSProperties` at runtime
`JSX` is purely a type-context use. Fine, since both are `import type`. But the JSX namespace is implicit in modern React 19. `JSX.Element | null` could be `ReactElement | null` for tighter typing. Cosmetic only.

---

## PRAISE

### P-1 — `useEndpointOrMock.ts:57-80`: `raceAgainstAbort` is the right pattern
Cleanly separates the abort signal from the underlying promise. Listener uses `{ once: true }`, removes itself in both `then` branches — no memory leak. Pre-abort check at line 61 is the standard defensive pattern. This is how it should be done.

### P-2 — `useEndpointOrMock.ts:127-136`: `safeSet` helper eliminates the "guard at every hop" foot-gun
Excellent abstraction. Reads cleanly, hides the abort-check repetition, accepts undefined branches so callers only set what they actually changed. The `next.data !== undefined` discriminator correctly handles `data: null` as a valid value (the mock-failure case).

### P-3 — `useEndpointOrMock.ts:139,159`: `realError` carried into the mock-fallback result
Surfacing the real failure as `error` while still rendering mock data is the right call. The hook lets the screen render *something* during dev while still giving the toast layer the original failure to surface. This is the contract the Pass 2 plan wanted and most implementations would have dropped one side.

### P-4 — `useEndpointOrMock.test.ts:65`: cost-conscious assertion (`expect(mockFn).not.toHaveBeenCalled()`)
"Important for cost on real endpoints that bill per call (e.g. Claude proxy)" — comment is exactly the kind of senior-engineer rationale that earns trust. The test is also the right test: ensures the realFn-resolved path *never* triggers the mock, which is a load-bearing invariant for Pass 3+.

### P-5 — `MockBadge.tsx:58`: `import.meta.env.PROD` early-return is correct
Single gate, single place, returns null (not a comment, not a hidden element). `aria-hidden="true"` is correct — it's developer chrome, not user info. `pointerEvents: 'none'` and `userSelect: 'none'` prevent the seal from interfering with the user, including when accidentally inside a click target.

### P-6 — `domain.ts` discipline: no enums, all string unions, `interface` for objects
`erasableSyntaxOnly` + `verbatimModuleSyntax` constraints are honoured throughout. No `any`. Discriminated section types (`DiagnosticDimension.key`) are tight. The "what we deliberately do NOT do" paragraph (lines 16-21) heads off the obvious "why no zod?" question — exactly the kind of comment that prevents a future PR adding speculative validation.

### P-7 — Mock fixtures are Korean-plausible TOPIK 3-4
`'재택근무는 출퇴근 시간을 줄여 주는 반면, ...'` (reading.ts), `'환경 문제는 한 나라의 노력 만으로는 ...'` (diagnostic.ts), `'그 의견이 일리가 있더라도 ...'` (grammar.ts). These are real intermediate-register Korean, not English placeholders. The grammar drill model answers actually demonstrate the patterns they're drilling. Anyone using the app in dev gets a realistic feel for what it'll look like with real data.

### P-8 — `_delay.ts` rationale comment
"Without it, the mock resolves synchronously in the next microtask and skeletons never render — then real endpoints in Pass 3+ surface latency bugs the suite never caught." That's the exact reason this helper exists and the kind of comment that survives a refactor.

---

## Cross-cutting observations

1. **Stale-data on key change (SF-1) is the only behavioural bug**. Everything else is hardening / coverage / documentation.

2. **The MockBadge CSS gap (SF-2) reflects the scope spec, not the implementation choice**. If the team has decided inline-only is fine, the scope doc should be updated; otherwise add the classes. Don't leave the dead `className`.

3. **Threat-model paragraph (SF-3) is the cheapest fix and pays the most**. Six lines in the hook header now → fewer surprises in Pass 3 when this becomes a network endpoint.

4. **Fixture quality is genuinely high**. The Korean is plausible, the grammar patterns drill what they claim to drill, the diagnostic items have credible distractors. This isn't placeholder data — it's design-fidelity data.

5. **Coverage gap is small** (SF-4: realFn-abort, StrictMode-double-mount) but worth closing before Pass 3 since both branches become production-critical the moment a real `realFn` lands.

## Recommendation

Close SF-1, SF-2, SF-3 before declaring Pass 2-D done. SF-4 and SF-5 can ride into the Pass 3 prep ticket. NITs are optional unless touched by the SHOULD-FIX edits.
