# FIX_REPORT — F-020 "Ask about this" fix-pass

**Date:** 2026-07-06
**Pass-owner:** independent fix-pass (did not author or review F-020)
**Inputs:** `REVIEW_F020_core.md` (SF-1), `REVIEW_F020_surfaces.md` (S1–S4 = SF-2..SF-5). 0 BLOCKER + 5 SHOULD-FIX.

## Executive summary

| ID | Disposition | Change |
|---|---|---|
| **SF-1** | **FIXED** | Chat's state-clearing replace-navigation now preserves `search` + `hash` |
| **SF-2** | **FIXED** | +8 seed-payload assertion tests across MockMode (3), Topik (2), Diagnostic (4, incl. SF-4/SF-5 coverage) |
| **SF-3** | **FIXED** | `'skipped'` magic string → exported `SKIPPED_PICK` constant, used at all 3 sites |
| **SF-4** | **FIXED** | Diagnostic bare-id fallback → `''` (buildAskSeed omits the "Correct answer" line) + test |
| **SF-5** | **FIXED** (not deferred — plumbing was trivial) | Diagnostic seeds listening transcript as passage + marks the underlined span with ⟨ ⟩ |
| NITs | **SKIPPED** | Per brief (none were trivially in-file while editing) |
| PRAISE'd behavior | **PRESERVED** | Untrusted-state validation, lazy-init no-clobber, no-auto-send, field mappings, F-009 gating direction on both surfaces — untouched; all pre-existing tests still pass |

## Detail

### SF-1 — clearing navigation dropped `location.search`/`location.hash` — FIXED
`client/src/pages/Chat.tsx:278` — `navigate(location.pathname, …)` →
`navigate({ pathname, search, hash }, { replace: true, state: null })`; effect deps extended to `location.search`/`location.hash`. Ref-guard + once-only + no-re-seed behavior unchanged.
**New test:** `Chat.test.tsx` — "preserves search + hash when clearing the seed state": seeded entry at `/chat?conversation=7#latest` → state goes `empty`, URL probe reads `/chat?conversation=7#latest`, composer still pre-filled. `LocationStateProbe` extended with a `location-url` testid (existing `location-state` assertions untouched).

### SF-2 — render-only tests on 3 of 4 surfaces — FIXED
All three surfaces now have Mistakes-style click-through probes (real `MemoryRouter` + `/chat` probe route asserting the actual router-state payload; no `useNavigate` mock — same pattern the review PRAISE'd as the model).

- **`client/src/pages/topik/MockMode.test.tsx`** (+3, the intricate surface):
  - MISS row → seed contains `Correct answer: 셋` + `My answer: 하나 (incorrect)` + `Why: C restates the phrase.` + `mode=topik_prep` — a correct/pick swap or raw-id leak fails.
  - CORRECT row → seed has `Correct answer: 나` but NO `My answer` and NO `Why:` (F-009 gate mirrored into the seed).
  - SKIPPED row (`picked: null`) → seed keeps `Correct answer` + `Why:` but NO `My answer` and no literal `skipped` — the sentinel can't be fabricated into a wrong answer.
  - Helpers: `ChatSeedProbe` + `renderWithChatProbe` + `driveToResults` (start → submit → confirm → results; confirm dialog is unconditional, so no answering needed — rows come from the mocked grade).
- **`client/src/pages/Topik.test.tsx`** (+1 new, +1 upgraded): the render-only F-020 test now clicks through and asserts `Correct answer: 나` / `My answer: 가 (incorrect)` / `Why: …` / `mode=topik_prep`; new CORRECT-pick test asserts NO `My answer` but `Why:` present (study reveal shows explanations on both verdicts — pins the review's P2, that this surface correctly does NOT copy MockMode's gate).
- **`client/src/pages/Diagnostic.test.tsx`** (+4): wrong-pick test asserts id→`.kr` resolution on the right labels (`Correct answer: 발표`, `My answer: 발견 (incorrect)`, `Why:`, `mode=topik_prep`); plus the SF-4 and 2 SF-5 tests below. Helper `driveToReveal` boots a single-item run (`done: true`, no `/next` to satisfy).

### SF-3 — `'skipped'` magic string — FIXED
`client/src/pages/topik/MockMode.tsx` — new `export const SKIPPED_PICK = 'skipped'` (doc comment names all three sites + why one constant), used by:
- producer `buildMockResultsSummary` (`MockMode.tsx`, was `:1324`),
- consumer `userPick` gate in `TopikResults` (`MockMode.tsx`, was `:1266`),
- producer `buildReviewRow` in `client/src/pages/Topik.tsx` (was `:346`, imports the constant).
`ResultsReviewRow.pickedText` doc comment updated to reference the constant. Display behavior unchanged ("Your answer: skipped" still renders; Topik.test.tsx `getByText(/skipped/i)` still passes).

### SF-4 — Diagnostic bare-id fallback — FIXED
`client/src/pages/Diagnostic.tsx` reveal wiring: `?? reveal.correctAnswer` → `?? ''`. `buildAskSeed` (`askSeed.ts:94`) drops a blank `correctText`, so corrupt data now omits the line instead of seeding `Correct answer: b`. Button kept (prompt/passage/explanation still worth asking about — per review, hiding it is not warranted). Comment documents the choice.
**New test:** `correctAnswer: 'z'` (absent from choices) → probe contains NO `Correct answer` and no `: z`, but still carries prompt + `Why:`.

### SF-5 — Diagnostic seed thinness (listening transcript / underline) — FIXED (not deferred)
Judged the effort: both fields already sit on `DiagnosticLiveItem` (`audio.transcript`, `underline`, `types/domain.ts:393-407`) — no new plumbing, so built rather than deferred.
`client/src/pages/Diagnostic.tsx` — new module-scope `buildSeedPassage(item)` (placed next to `PassageCard`, whose rendering it mirrors):
- `item.passage ?? item.audio?.transcript` — listening items seed their transcript as the passage-equivalent (exactly the review's suggestion);
- when `item.underline` is present AND occurs in the passage, the span is marked `⟨…⟩` (same `split` mechanics as `PassageCard`); guard against an underline not present in the passage → plain passage, no broken markers.
Reveal wiring: `passage={item.passage}` → `passage={buildSeedPassage(item)}`.
**New tests:** listening item → seed contains `지문: 내일은 전국에 비가 오겠습니다.`; underline item → seed contains `지문: 그는 ⟨하루가 멀다 하고⟩ 도서관에 갔다.`

## Verify (full pipeline, Docker `node:20-slim`)

```
npm ci && npx tsc --noEmit          → TC=0
npm run lint (full output, no tail) → LINT=0, zero errors, zero warnings
npx vitest run                      → 67 files, 682/682 passed (was 673 — +9 new tests)
npm run build                       → BUILD=0
```

## Files touched

- `client/src/pages/Chat.tsx` (SF-1)
- `client/src/pages/Chat.test.tsx` (SF-1 test, probe extension)
- `client/src/pages/topik/MockMode.tsx` (SF-3)
- `client/src/pages/topik/MockMode.test.tsx` (SF-2: +3 tests, probe helpers)
- `client/src/pages/Topik.tsx` (SF-3)
- `client/src/pages/Topik.test.tsx` (SF-2: +1 test, 1 upgraded, probe helpers)
- `client/src/pages/Diagnostic.tsx` (SF-4, SF-5)
- `client/src/pages/Diagnostic.test.tsx` (SF-2/SF-4/SF-5: +4 tests, probe helpers)
