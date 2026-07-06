# Re-Review — F-020 fix-pass verification

- **Base commit:** `97eff80` (feature); fixes reviewed as the UNCOMMITTED working-tree diff on top.
- **Inputs verified against:** `REVIEW_F020_core.md` (SF-1), `REVIEW_F020_surfaces.md` (S1–S4 = SF-2..SF-5), `FIX_REPORT_F020.md` (treated as claims, not evidence).
- **Reviewer:** independent re-reviewer — did not author the feature, the original reviews, or the fixes.
- **Method:** full diff read against both reviews' cited lines, grep sweeps for lingering literals, fixture inspection for probe non-vacuity, **two live mutation tests** (field-swap in MockMode wiring; pre-fix navigate restored in Chat), and the full Docker pipeline run three times (clean, post-restore, count-confirm).

## Verdict: **PASS**

All five SHOULD-FIXes are **FIXED**, zero regressions, zero PRAISE'd behaviors undone. The two highest-value claims — that the new surface probes are real payload assertions and that the SF-1 regression test would have failed pre-fix — were both proven by live mutation, not taken on faith.

**Pipeline (Docker `node:20-slim`, clean and again after mutation-restore):**

```
npx tsc --noEmit  → TC=0
npm run lint      → LINT=0 (full eslint, incl. react-hooks rules)
npx vitest run    → 67 files, 682/682 passed
npm run build     → BUILD=0
```

Matches the fix report's claimed numbers exactly (682 = 673 pre-fix + 9 new: 1 Chat + 3 MockMode + 1 Topik + 4 Diagnostic; the report's "+8" figure counts SF-2 payload tests only, excluding the upgraded-in-place Topik test — internally consistent).

---

## Finding-by-finding

### SF-1 — Chat clearing navigation drops search/hash → **FIXED** (mutation-verified)

`client/src/pages/Chat.tsx:281-288` now navigates with `{ pathname, search, hash }` + `{ replace: true, state: null }`; deps extended to `location.search`/`location.hash`. The `seedClearedRef` guard still makes the effect fire at most once, so the widened deps cannot loop (the guard was already load-bearing for the same reason per the core review §4).

**Regression test is real.** `Chat.test.tsx` "preserves search + hash when clearing the seed state": seeded `MemoryRouter` entry at `/chat?conversation=7#latest`, waits for `location-state` → `empty`, then asserts the `location-url` probe reads `/chat?conversation=7#latest` **and** the composer still holds the seed. **Mutation B:** I reverted the code to the pre-fix `navigate(location.pathname, …)` and ran the suite — the test **failed** (`AssertionError: expected '/chat' … '/chat?conversation=7#latest'`) while all 14 other Chat tests passed. Code restored; verified. The probe extension (`location-url` testid added alongside the existing `location-state`) did not disturb the pre-existing state-cleared assertions.

### SF-2 — render-only surface tests → **FIXED** (the key one; mutation-verified on MockMode)

All three surfaces now carry Mistakes-style click-through probes: a real `MemoryRouter` with a `/chat` `ChatSeedProbe` route that prints the **actual router state** (`seedText` + `mode`) — no `useNavigate` mock. Each test clicks the real "Ask about this" button after driving the real flow (MockMode: start → submit → confirm → results; Topik: pick → submit → reveal; Diagnostic: begin → pick/skip → server-graded reveal) and asserts payload bytes.

**Non-vacuous by construction:** every fixture uses distinct correct/pick display texts (MockMode item 1002: picked 'a'=하나 vs correct 'c'=셋; Topik: 'a'=가 wrong vs 'b'=나 correct; Diagnostic: 'a'=발표 correct vs 'b'=발견 pick), so a swap or raw-id leak cannot pass.

**Mutation A (demanded probe) — the MockMode test DOES catch a field swap.** I swapped `correctText` ↔ `userPick` value expressions in the `TopikResults` `AskAboutThisButton` wiring (`MockMode.tsx:1269-1279`) and ran `MockMode.test.tsx`: the MISS-row test **failed exactly as designed** —

```
AssertionError: expected '…' to contain 'Correct answer: 셋'
- Correct answer: 셋
+ Correct answer: 하나
+ My answer: 셋 (incorrect)
```

14/15 passed, 1 failed — the mutant is killed. (The CORRECT-row and SKIPPED-row tests survive this particular mutant because their gate makes the swap a no-op on those rows; that is expected — the MISS test is the swap detector, and it works.) Code restored; final diff is byte-identical to the pre-mutation fix diff (same `--stat`, 453+/24−) and the full suite is back to 682/682.

Coverage now includes the exact gaps the surfaces review named: MockMode skipped row omits `My answer` and never leaks the literal `skipped`; MockMode correct row omits both `My answer` and `Why:` (F-009 gate mirrored into the seed); Topik correct pick keeps `Why:` (pinning P2 — study reveal correctly does NOT copy MockMode's gate); Diagnostic asserts id→`.kr` resolution on the right labels plus `mode=topik_prep` everywhere.

### SF-3 — `'skipped'` magic string → **FIXED**

`export const SKIPPED_PICK = 'skipped'` at `MockMode.tsx:1129` with a doc comment naming all three sites. Grep over `client/src` confirms **all** producers/consumers use it — `buildMockResultsSummary` (`MockMode.tsx:1334`), the `userPick` gate (`MockMode.tsx:1275`), and Topik's `buildReviewRow` (`Topik.tsx:347`, importing the constant). The **only** remaining `'skipped'` literal in source is the constant's own definition (the one hit in `MockMode.test.tsx:488` is a `not.toContain` assertion, which is the point). `ResultsReviewRow.pickedText` doc updated. Constant value unchanged (`'skipped'`), so zero runtime drift — display behavior identical, confirmed by the full green suite including the pre-existing `/skipped/i` display assertions.

### SF-4 — Diagnostic bare-id fallback → **FIXED**

`Diagnostic.tsx:768-779`: `?? reveal.correctAnswer` → `?? ''`, with a comment documenting why (choices are labelled ①②③④ on screen; a bare `b` corresponds to nothing the learner saw). `buildAskSeed` (`askSeed.ts:94`, untouched) drops a blank `correctText`, so the line is omitted. Button kept, per the surfaces review's explicit guidance. **Test proves it with an unresolvable id:** `correctAnswer: 'z'` (absent from choices) → probe contains no `Correct answer` and no `: z`, while the prompt and `Why:` still seed — exactly the demanded shape.

### SF-5 — Diagnostic listening transcript / underline → **FIXED**

New `buildSeedPassage(item)` (`Diagnostic.tsx:876-882`): `item.passage ?? item.audio?.transcript` (the review's exact suggestion), and when `item.underline` is present **and occurs in the passage**, marks it `⟨…⟩` via `split`/`join` — the same all-occurrences semantics as `PassageCard` (`Diagnostic.tsx:886-908`), so the seed mirrors what the UI rendered. Crash-safety verified by reading: `underline ?? ''` + the `includes` guard mean an absent or non-matching underline yields the plain passage; an item with neither passage nor transcript yields `undefined` and `buildAskSeed` omits the `지문:` block. Both tests are real: a listening item asserts `지문: 내일은 전국에 비가 오겠습니다.` and an underline item asserts `지문: 그는 ⟨하루가 멀다 하고⟩ 도서관에 갔다.` in the clicked-through seed payload.

---

## Regression sweep

- **ESLint hooks rules:** `npm run lint` → 0 errors/warnings on the full tree. The Chat effect change stays a pure navigation side effect (no `setState` in any effect, no render-phase ref access), so `react-hooks/set-state-in-effect` and `react-hooks/refs` remain clean despite the widened dep array.
- **PRAISE'd behaviors — all intact:**
  - `readChatSeedState` validation / threat model (core P-1): `askSeed.ts` is **untouched** (not in the diff, `git status` confirms).
  - Lazy-init no-clobber (core P-2): `const [chatSeed] = useState(() => readChatSeedState(location.state))` untouched; only the clear effect changed.
  - No-auto-send: untouched; the pre-existing non-vacuous test still passes.
  - Mistakes probe pattern (surfaces P1): `Mistakes.tsx`/`Mistakes.test.tsx` untouched; the new probes replicate rather than modify it.
  - F-009 gating in both directions (surfaces P2): MockMode's `!row.isCorrect` gates unchanged; Topik study's show-on-both-verdicts explanation now **pinned by a new test** rather than merely preserved.
- **`SKIPPED_PICK` extraction:** pure constant extraction, identical value, no behavioral delta anywhere (full suite green, display assertions included).
- **Pre-existing tests:** all pass — 682/682 across 67 files includes every pre-fix Chat/MockMode/Topik/Diagnostic/Mistakes test.
- **Scope:** diff touches exactly the 8 files the fix report lists; no drive-by changes.

## New findings

- **NF-1 (NIT, test-only):** `ChatSeedProbe` + `renderWithChatProbe` are now copy-pasted in four test files (Mistakes, MockMode, Topik, Diagnostic). A shared test util would prevent drift if the seed-state shape changes, but per-file isolation is a defensible testing convention — not worth blocking.
- **NF-2 (observation, no action):** the field-swap mutant survives the CORRECT-row and SKIPPED-row MockMode tests (their gates make the swap invisible on those rows); the MISS-row test kills it, which is sufficient — noted so nobody later deletes the MISS test thinking coverage is redundant.
- Prior NITs (core N-1..N-5, surfaces N1..N4) remain open by design — the fix brief scoped them out, and none was silently made worse.

## Recommendation

**Ship.** Commit the working tree as-is. All five SHOULD-FIXes verified FIXED with the two critical proofs done by live mutation rather than inspection; the full pipeline is green and no praised property regressed. The open NITs are correctly deferred backlog, none load-bearing.
