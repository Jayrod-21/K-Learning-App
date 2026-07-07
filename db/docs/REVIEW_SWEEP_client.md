# RE-REVIEW — client bug-sweep fixes (pages + contracts batches)

Independent re-review of the fixes documented in `FIX_sweep_client_pages.md` and
`FIX_sweep_client_contracts.md`. Branch `fix/bug-sweep`, uncommitted working tree.
Reviewer did not author the fixes. Method: read every claimed fix against the code,
enumerate all consumers of the app-wide behavioral change, run the prescribed docker
gate, and mutation-probe the five high-risk fixes by reverting each to its pre-fix
behavior and confirming the regression tests fail.

**Gate (docker node:20-slim): TC=0 · TCAPP=0 (tsconfig.app.json) · LINT=0 ·
727/727 tests pass (68 files).** Re-verified green after all probes were restored.

---

## 1. HIGHEST RISK — `useEndpointOrMock` PROD gate: **HOLDS**

`client/src/hooks/useEndpointOrMock.ts` (lines 241–245): on a `realFn` rejection,
`import.meta.env.PROD` short-circuits the mock fallback — `data: null`,
`error: <real ApiError>`, `loading: false`. Non-PROD behavior unchanged (fixture
fallback + error still surfaced). `import.meta.env.PROD` is the correct Vite flag;
the tests stub it via `vi.stubEnv('PROD', true)`, which works because Vitest does
not statically replace `import.meta.env`.

**Every consumer enumerated and its null-data path verified** (17 call sites,
all with `realFn`, across 11 files — no page crashes, renders NaN, or goes blank
without a message):

| Consumer | Call site(s) | Null-data path in PROD failure |
|---|---|---|
| Today.tsx | 249 (`today`), 252 (`today.snapshot`), 262 (`today.series`) | `today` → ErrorCard "Today's plan is unavailable" + retry; snapshot → ErrorCard "Skills snapshot is unavailable" + retry; series → section renders `null` — verified unreachable: `fetchSkillSeries` uses `Promise.allSettled` per skill and only rejects on cancellation (stats.ts:87–98) |
| Topik.tsx | 281 | `!loading && error && draw.length === 0` → error branch (line 419); `draw = data ?? []` so no NaN |
| MockMode.tsx | (own inline fetches, see §below) | n/a — does not use the hook |
| Diagnostic.tsx | 126 | `fatalError = !snap.data && snap.error !== null` → `role="alert"` message (line 187); IntroBlock still renders so the user can start a diagnostic. No retry button on the alert, and it echoes `fatalError.message` — pre-existing, see findings |
| Mistakes.tsx | 110 | `error ?` → ErrorCard + `refetch` (line 135) |
| Chat.tsx | 197 | doesn't destructure `error`, but `hasNothingToShow = msgs.length === 0 && !data` → ErrorCard + retry (lines 591, 615). Null data ⇒ `serverList`/`mockSeed` null/empty ⇒ `seed = []` ⇒ lands in that card. Verified no undefined deref |
| Hanja.tsx | 109, 112, 119 | `fatal = !loading && (!chars || !progress) && (charsResult.error ?? progressResult.error)` → "Hanja unavailable" card (line 226). `todayResult.error` deliberately excluded → featured falls to a benign empty state (see findings) |
| Grammar.tsx | 500 (list), 510 (bank) | ListPanel: `error && items.length === 0` → ErrorCard + `refetch` (line 980); BankedPanel: `fetchErrored` combines both null+error states → error card + combined retry (lines 897–903). `bankedKeys` degrades to the optimistic overlay only — no crash |
| Settings.tsx | 236 (me), 529 (prefs), 987 (mfa) | me/prefs sync effects bail on `!fresh` (null) and on `isMock`, so the form degrades to useAuth/localStorage values — never consumed fallback fixture data even pre-fix; mfa: `statusQuery.error && !statusQuery.data` → ErrorCard + retry (line 1019) |
| Progress.tsx | 180 | `fatalError` (error + no snapshots) → ErrorCard + `hist.refetch` (lines 189, 213) |
| Review.tsx | 431 (due), 434 (lists), 1494 (all-tab) | SessionPanel `fetchErrored = (!data && error) ‖ …` → ErrorCard + Retry (722, 941); all-tab: `!data && error !== null` → ErrorCard (1502) |
| Images.tsx | 82 | `result.error && captures.length === 0` → `role="alert"` error card (line 245) |

Mock-only sources (no `realFn`): none exist among current call sites — every one
passes a `realFn` — so the "mock-only still resolves in prod" branch is currently
latent (covered by a test regardless).

Dev/mock mode: unchanged and covered by the pre-existing "falls back to mockFn when
realFn rejects IN DEV" test plus the untouched non-PROD fallback path.

**Mutation probe:** neutralized the gate (`if (import.meta.env.PROD)` → `if (false)`)
→ 2 PROD-posture hook tests fail ("mockFn is NEVER called", "refetch after PROD
failure"). Restored → green. Not vacuous.

## 1b. MockMode inline fixture gates (exam fetch + submit): **HOLDS**

`MockMode.tsx` `startSection` catch (line ~288) and `runSubmit` catch (line ~354):
PROD short-circuits before `loadTopikMockTest` / `submitTopikMockTestMock`.
- Fetch failure in prod → `errorKind 'fetch'` → ErrorCard with `newMock` ("Back") —
  returns to select where the user can restart. Not stranded.
- Submit failure in prod → `errorKind 'submit'` → "Retry submit" → `retrySubmit`
  re-runs `runSubmit(pendingSubmitRef.current)` — same picks, and `runSubmit`
  re-stashes the body so repeated failures keep retrying. No fabricated score, no
  lost work. Dev offline fallback (fixture exam + pseudo-grader with 🅂 badge)
  preserved on the non-PROD path.

**Mutation probe:** both gates → `if (false)` → the 2 "PROD posture — no fixture
substitution" tests fail. Restored → green.

## 2. HIGH — `MockReveal.itemId` string: **HOLDS**

- `types/domain.ts:293` — `itemId: string`, documented against the server's
  `i.id::text` projection. `MockSubmitAnswer.itemId` stays `number` (server zod
  `z.number()`) — asymmetry real and documented.
- `MockMode.tsx buildMockResultsSummary` — `Map<string, TopikMockItem>` keyed by
  `it.id` directly, looked up with `rev.itemId`. `TopikMockItem.id` is `string`;
  types line up end to end.
- Fixture `data/mocks/topik.ts:316` returns `itemId: it.id` (string) — no longer
  masks the bug in dev.
- **Other consumers audited:** `rev.itemId` is consumed only in
  `buildMockResultsSummary` (row `key` — `ResultsReviewRow.key: string | number`,
  fine for React keys). The F-020 "Ask about this" seed builds from row *text*
  (`buildAskSeed` takes prompt/picked/correct/explanation), no itemId arithmetic.
  `Topik.tsx`'s `serverReveal.itemId` is a separate local Study-mode type already
  `string`, compared against `TopikItem.id: string`. No numeric assumption remains.

**Mutation probes:**
- Map reverted to `new Map(items.map((it) => [Number(it.id), it]))` → 4 MockMode
  tests fail (results reveal test + all 3 F-020 seed tests — confirming the F-020
  path depends on the string keying).
- Fixture alone reverted to `Number(it.id)` → **caught at compile time**
  (TS2322 in `data/mocks/topik.ts:344`), which fails the gate's TC=0. Runtime
  tests alone would not catch a fixture-only revert; the protection is type-level.
  Acceptable — the gate runs tsc — but worth knowing.

## 3. HIGH — `image_words` derived key: **HOLDS**

`Images.tsx:77` `ocrWordKey(word, index) = `${index}:${word.kr}``.
- **Unique:** the index prefix guarantees distinct keys for identical `kr` at
  different positions (e.g. `0:커피` vs `3:커피`).
- **Stable:** a capture's `words` array is immutable after fetch (set once in
  `wordsById` / arrives on the capture), and both the render `map((w, i))` and
  `onAddAll`'s `forEach((w, i))` derive the key from the same array positions, so
  render key, added-set membership, and add-all marking always agree.
- Banking one word adds only that key to `addedByCapture[capId]`; rollback on
  mine-failure deletes only that key. `wordToPopover` and `mineWord` use
  `kr/en/gloss/pos` — nothing else consumed the phantom `id` (grep-verified;
  `OcrWord.id` and `ImageWordWire.id` both removed, tsc enforces).

**Mutation probe:** `ocrWordKey` → constant `'k'` (reintroduces the collapsed-key
behavior) → 2 Images tests fail, including "banking ONE word marks only THAT word
Added". Restored → green. (Nit: no test pins the duplicate-`kr` case specifically;
uniqueness is structural via the index prefix.)

## 4. Settings 409 rebase: **HOLDS**

`Settings.tsx:413` — 409 catch now calls `refetchMe()` (stable handle on
`meQuery.refetch`) before `refresh()`. The sync effect (line ~285) adopts the
refetched `version` + profile, overwriting only non-edited fields
(`editedFieldsRef`), so the next save carries the rebased `expected_version`.
- **No refetch loop:** `refetchMe()` fires only inside the 409 catch of a
  user-initiated debounced save; `scheduleSave` is called exclusively from the
  three onChange handlers (lines 458/469/497), never from an effect — a refetch
  settle cannot schedule a save.
- Mid-refetch the hook resets `meQuery.data` to null; the sync effect bails on
  null (`if (!fresh) return`) — the buffer is not clobbered.
- Debounce/abort unchanged: timer + `saveCtrlRef` abort on next keystroke/unmount
  untouched.

**Mutation probe:** removed the `refetchMe();` line → the "rebases the version
snapshot after a 409" test fails (fetchMe never re-called, expected_version stale).
Restored → green.

## 5. F-UP-015 + MED/LOW service fixes: spot-checked, **HOLD** (not vacuous)

- **Resume-fail notice** (`MockMode.tsx`): `resumeFailed` set in the resume-fetch
  catch, rendered as fixed-copy `role="status"` on the select screen, cleared on
  fresh start / new mock / next resume. Test covers notice + clears. Correct.
- **SSE `retry_after`** (`sseStream.ts:145+`): non-OK path extracts
  `error.retry_after` with the same finite-positive guard as the axios path onto
  `ApiError.retryAfter`. Tests: 429 with 42 → threaded on rejection and `onError`;
  `-5` dropped. Correct.
- **BIGINT id coercions** (`vocab.ts`, `grammar.ts`, `progress.ts`): `Number(id)`
  per row on `searchEntries`/`searchEntriesPage`/`listLists`/`getListDetail`
  (incl. `entry_id`), `listPatterns`/`listBanked`, `updateMetric`/`logStudy`.
  Idempotent if the server later adds its own coercion. Tests use string-id wire
  fixtures. Correct.
- **`blobUrl`** (`images.ts`): joined on `getApiBaseUrl()`; prod (`base === ''`)
  byte-identical relative path, dev base joined; injectable `base` mirrors
  `ttmik.ts`. Tests cover both postures. Correct.
- **`logStudy` clamp**: `minutes` clamped to `[0, 1440]` matching the server
  schema; tests assert 1500→1440 and -3→0. Correct.
- **`timeMs` clamp** (`MockMode.tsx:725`): per-item `Math.min(raw, 3_600_000)`
  matches the server cap; fake-timer test asserts exactly 3_600_000 after a
  70-minute idle. Correct.
- **`persistence_error` fixed copy + `recoveredText`** (`conversation.ts`,
  `api.ts`): raw pg prose replaced with fixed copy; `recovered_text` threaded on
  the ApiError. Test asserts prose absent + recovered text present. Correct.
- **`streamPath: 'query'` removal** (`conversation.ts`): option gone, no caller
  passed it (grep-verified), URL test updated. Correct.
- **Grammar detail stale-guard / drill Retry re-submit / Reference un-gated error
  ladders / Login RecoveryStep `.finally` reset**: all verified against code;
  each has a fail-without-fix test (Login's late no-op setState after unmount is
  harmless in React 18+). Correct.

---

## New findings (this re-review)

**MED — Grammar DrillPanel's generate fallback is NOT prod-gated (missed sibling
of the flagged change).** `Grammar.tsx` DrillPanel generate effect (~line 1510):
when `generateDrill` fails, it falls back to `MOCK_DRILLS[idx % …]` with
`setIsMock(true)` and local offline scoring — *in prod too*. MockBadge renders
null in prod, so a prod user whose `/grammar/drill` endpoint is down silently
gets a canned fixture drill graded locally, indistinguishable from real. This is
the exact fake-data-as-real class the sweep gated in `useEndpointOrMock` and
MockMode's two inline fallbacks. Side effect of gating it later: the drill-submit
ErrorCard's Retry (now wired to `submit()`) stays sound because `error` is only
ever set by the submit catch and the mock item is a sync fixture that cannot fail
— but if a future gate makes generate surface an error with `item === null`,
`submit()`'s `if (!item) return` turns Retry into a dead button. Gate + rewire
together. Not a regression of this sweep — flagging for consistency.

**LOW — Diagnostic snapshot fatal branch has no retry and echoes server prose.**
`Diagnostic.tsx:187–193` renders `Couldn't load diagnostic. {fatalError.message}`
— server-controlled text (the fixed-copy sweep the pages batch deferred already
covers this class) and no retry affordance; the PROD gate makes this branch
reachable in prod where it previously painted fixture data. Page is not stranded
(IntroBlock still offers "Begin"), but this is now a real prod surface — include
it in the coordinated fixed-copy/retry follow-up.

**LOW — Hanja `todayResult` failure masquerades as empty state.** With
`todayResult.error` deliberately excluded from `fatal`, a prod failure of the
featured-hanja fetch renders "No featured 한자 yet — read a passage…" (a data
statement) rather than an error. Benign, pre-existing shape, but now reachable.

**NIT — stale doc references to the deleted settings mock.** `Settings.tsx:7`
JSDoc still names `loadSettingsMock`; acknowledged as out-of-scope in the fix doc
itself. Cosmetic.

**NIT — fixture wire-fidelity is protected by tsc only.** A revert of
`submitTopikMockTestMock`'s `itemId` to `Number(it.id)` passes all runtime tests
and is caught only by the TC=0 gate (probe-verified). Fine as long as the gate
always runs tsc against `tsconfig.app.json` (the fix doc's own note that root
`tsc --noEmit` validates nothing applies — this review ran both).

## Verdict

**PASS.** All five high-risk fixes HOLD: correct, regression-free, and
non-vacuously tested (every mutation probe produced the designed failures —
11 targeted test failures across the 5 probes — and the tree was restored to a
fully green gate: TC=0, TCAPP=0, LINT=0, 727/727). No consumer of
`useEndpointOrMock` strands, blanks, or renders NaN under the new PROD error
propagation; every realFn-backed screen has an error card or an honest degraded
state. The one thing to schedule before (or immediately after) deploy is the
**MED finding: prod-gate Grammar DrillPanel's fixture fallback** so the app's
"no fabricated data in prod" posture is consistent — as shipped, that one screen
still fabricates.
