# Fix report — B3 Writing/Grammar fix-pass

Base: `8aaa590` on `worktree-agent-ac141d99b94bbd0a3`. Inputs: `REVIEW_b3-writing.md` + `REVIEW_b3-grammar.md` (0 BLOCKER, 1 SHOULD-FIX, 6 NIT total). Constraint honored: no changes to F-134 same-prompt wiring, migration 067, or grammar-mastery query logic.

## Dispositions

### R1 SHOULD-FIX 1 — preview invisible to screen readers — **FIXED**
`client/src/pages/Today.tsx`: `ariaLabel` replaces the button's accessible name, so the F-134 preview was never announced. Fix:
- New `promptPreview` const (non-empty `promptKr` or `undefined`) computed once at the Writing-tile block.
- FULL prompt body folded into the tile's accessible name: `Open writing — <title>. <promptKr>` when a preview exists; plain `Open writing — <title>` otherwise. Chose the append-to-ariaLabel option — `ActivityTile` has no describedby plumbing and the button subtree is presentational to AT, so `aria-describedby` on the clamped span would not be cleaner.
- Overclaiming comment ("full text stays in the accessibility tree") rewritten to state the real mechanism (aria-label carries the full text; subtree presentational).
- Tests (`client/src/pages/Today.test.tsx`): existing F-134 preview test now asserts `toHaveAccessibleName('Open writing — Paragraph in 합쇼체. 재택근무의 장점과 단점에 대해 200~300자로 쓰십시오.')`; older-envelope test now pins the plain name (no dangling period/phantom preview).

### R1 NIT 1 — silent divergence notice on retired-row edge (Writing.tsx) — **SKIPPED**
User-facing behavior/UX change to the documented F-183 degrade path, not a trivially-safe polish. Out of fix-pass scope; leave to a follow-up feature decision.

### R1 NIT 2 — `t.promptKr !== undefined` admits `''` — **FIXED**
Folded into the `promptPreview` const: `t.promptKr !== undefined && t.promptKr !== ''`. Empty string now renders no stub AND adds nothing to the accessible name. New test: "an empty-string promptKr renders no preview stub and adds nothing to the accessible name".

### R1 NIT 3 — plan.test.ts local shape types `promptKr` required — **FIXED**
`server/tests/routes/plan.test.ts`: `promptKr?: string` now matches the optional wire contract; comment notes the test still asserts presence. Assertion strength unchanged (`toBe(<db value>)` fails on `undefined`).

### R2 NIT 1 — sequential summary+list queries → `Promise.all` — **SKIPPED**
Perf-only; reviewer's own note says fix together with vocab's identical shape or not at all. Out of scope per instructions.

### R2 NIT 2 — `vc.deleted_at IS NULL` join predicate untested — **FIXED**
`server/tests/routes/grammar.test.ts`: new test "a soft-deleted production card is ignored — the pattern buckets new again" — mature (stability 99, review) production card with `deleted_at = now()` → summary `{new:1, …, total:1}`, bucket `'new'`, stability `null`. Dropping the predicate turns this test red (would report mastered/99).

### R2 NIT 3 — graduated-with-live-card display quirk — **SKIPPED**
Cosmetic/taste; matches the stated "report the real card" philosophy. No change.

## PRAISE preserved
No changes to: the single-SELECT same-row pick in `plan.ts`, the plan.test.ts DB-backed promptId/promptKr equality assertion, the pinned-fetch lifecycle in `Writing.tsx`, migration 067 (either direction), `GRAMMAR_MASTERY_SOURCE` / bind-parameter bucket filter, the 20.9999/21 boundary and recognition-face tests, or the null-stability honesty chain.

## Gates (exact, run in worktree)

| Gate | Command | Result |
|---|---|---|
| Client lint | `cd client && npm run lint` | 0 errors |
| Client typecheck | `npx tsc -p tsconfig.app.json --noEmit --incremental false` | 0 errors |
| Client tests | `npx vitest run src/pages/Today.test.tsx src/pages/Progress.test.tsx` | 2 files, **134 passed**, 0 failed |
| Client build | `npx vite build --outDir /tmp/km-b3fix` | exit 0 |
| Server typecheck | `cd server && npm run typecheck` | 0 errors |
| Server tests | `npx vitest run tests/routes/grammar.test.ts tests/routes/plan.test.ts` | 2 files, **93 passed**, 0 failed |

(Server run shows only the pre-existing `pg` deprecation warning — unrelated.)
