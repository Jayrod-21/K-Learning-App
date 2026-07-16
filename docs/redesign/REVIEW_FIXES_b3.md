# Re-review — B3 Writing/Grammar fix-pass

Re-reviewer: independent (did not write the code, the original reviews, or the fix-pass). Branch `worktree-agent-ac141d99b94bbd0a3` @ `bffe155`, fix-pass diff `8aaa590..bffe155`, batch diff vs `rebuild`. Inputs: `REVIEW_b3-writing.md` (PASS, 1 SHOULD-FIX / 3 NIT), `REVIEW_b3-grammar.md` (PASS, 3 NIT), `FIX_REPORT_b3.md`.

## Verdict

**PASS** — the fix-pass is genuinely polish-only. The one SHOULD-FIX is properly fixed and mutation-verified; the three fixed NITs are real fixes; the three skips are defensible; the protected surfaces (F-134 wiring, migration 067, grammar-mastery query) are byte-untouched.

## Fix-pass diff scope (verified first)

`git diff --stat 8aaa590 bffe155` touches exactly seven files: `client/src/pages/Today.tsx` (+26/−6), `client/src/pages/Today.test.tsx` (+43), `server/tests/routes/plan.test.ts` (+4/−2, type-annotation + comment only), `server/tests/routes/grammar.test.ts` (+30, one appended test), and the three review/fix docs. **No change to `server/src/routes/plan.ts`, `server/src/routes/grammar.ts`, `client/src/pages/Writing.tsx`, `db/migrations/067_*`, or `db/tests/test_migration_067.py`** — the F-134 same-prompt wiring, migration 067, and the grammar-mastery SQL are exactly as the original reviewers PASSed them. No regression surface exists outside one client component and two test files.

## Finding-by-finding

### R1 SHOULD-FIX 1 — preview invisible to screen readers — **FIXED, verified by mutation**

- `client/src/pages/Today.tsx:872-876`: the tile's `ariaLabel` now folds the FULL `promptKr` into the accessible name — `` `Open writing — ${t.title}. ${promptPreview}` `` when a preview exists, plain `` `Open writing — ${t.title}` `` otherwise. This is the full prompt body, not the 3-line-clamped visual: CSS clamping (`-webkit-line-clamp` in `Today.css`) affects only the rendered span; the label string is built from the raw `promptPreview` value. `ActivityTile` passes `ariaLabel` straight to `aria-label` on the `<button>` (`Today.tsx:416-420`), which replaces the accessible name of a `role=button` whose subtree is presentational — so this is the announced string.
- **Test asserts the actual accessible name**: `Today.test.tsx:1053-1055` — `toHaveAccessibleName('Open writing — Paragraph in 합쇼체. 재택근무의 장점과 단점에 대해 200~300자로 쓰십시오.')`, an exact-string jest-dom accessible-name computation, not a DOM-text proxy.
- **Mutation check (run, not reasoned)**: I temporarily reverted `ariaLabel` to the pre-fix `` `Open writing — ${t.title}` `` and ran `src/pages/Today.test.tsx`: **1 failed | 63 passed**, failing precisely on the `toHaveAccessibleName` assertion at line 1053. The tile selector uses a regex (`{ name: /Paragraph in/ }`) that still matches the reverted label, so the a11y assertion itself is what goes red — the test cannot pass vacuously. Fix restored; tree verified clean (`git status --porcelain` empty) and the suite back to 64/64.
- **Older envelope (no `promptKr`)**: the plain branch yields `Open writing — Paragraph in 합쇼체` — no "undefined", no dangling period. Pinned by test at `Today.test.tsx:1080-1084`.
- **Corrected comment is accurate**: the old overclaim ("the full text stays in the accessibility tree") is gone; the new comments at `Today.tsx:868-871` and `:888-893` correctly state that aria-label replaces the name and the button subtree is presentational to AT — this matches the ARIA name-computation behavior jest-dom implements.

### R1 NIT 2 — empty-string `''` guard — **FIXED**

`Today.tsx:850-851`: `promptPreview = t.promptKr !== undefined && t.promptKr !== '' ? t.promptKr : undefined`, and **both** consumers (the `extra` render at `:887` and the `ariaLabel` at `:872`) now branch on `promptPreview`, so `''` can neither paint the hairline-topped stub nor pollute the label. New test `Today.test.tsx:1087-1115` feeds `promptKr: ''` and asserts both: no `.km-today__tilePrompt` node and the plain accessible name. Unreachable from the live server (013's `NOT NULL` + length ≥ 1 CHECK) — this is pure defensive polish, as the original reviewer scoped it.

### R1 NIT 3 — plan.test.ts local shape — **FIXED**

`server/tests/routes/plan.test.ts:129-131`: `promptKr?: string` now matches the optional wire contract. Assertion strength unchanged — the equality check against the re-queried DB value still fails on `undefined`, so the F-134 DB-backed same-row assertion is exactly as strong as before.

### R2 NIT 2 — `vc.deleted_at IS NULL` untested — **FIXED, test is real**

`server/tests/routes/grammar.test.ts:1196-1224`: inserts a mature production card (`fsrs_state='review'`, `stability=99`) with `deleted_at = now()` on a banked pattern, then asserts summary `{new:1, …, total:1}`, bucket `'new'`, `stability: null`. I verified against the route source: `GRAMMAR_MASTERY_SOURCE` carries `AND vc.deleted_at IS NULL` in the LEFT JOIN (`server/src/routes/grammar.ts:502`) — dropping that predicate would make the join match the dead card and report `mastered`/99, turning all three assertions red. The insert is schema-legal (the partial unique index `uq_vocab_cards_user_grammar_production` only covers `deleted_at IS NULL` rows, as the test's comment notes). This is a discriminating test, not theater.

### Skips — all three reasonable, none a dodge

- **R1 NIT 1 (retired-row divergence notice)**: a user-facing UX change to the documented F-183 degrade path in `Writing.tsx` — new copy, new state, a product decision about how loudly to announce a substitution. Correctly out of scope for a polish fix-pass; deferring to a follow-up is the right call, and `Writing.tsx` is untouched in the fix diff.
- **R2 NIT 1 (`Promise.all` the two mastery queries)**: perf-only, and the original reviewer's own finding says the identical shape exists in vocab's `/mastery` — "fix both together or not at all." Fixing only grammar would create the drift the reviewer warned about. Reasonable skip.
- **R2 NIT 3 (graduated-with-live-card badge/stability quirk)**: cosmetic, and consistent with the codebase's stated "report the real card" philosophy that the original review endorsed. Reasonable skip.

## Regression check on protected surfaces

Confirmed via the fix-pass diff (not just the fix report's claim):

- `server/src/routes/plan.ts` — untouched; the single-SELECT same-row pick and the `promptId`/`promptKr` off-one-row-object guarantee stand as reviewed.
- `db/migrations/067_writing_prompts_depth.{up,down}.sql` + `db/tests/test_migration_067.py` — untouched.
- `server/src/routes/grammar.ts` — untouched; `GRAMMAR_MASTERY_SOURCE`, the bind-parameter bucket filter, and the 21-day CASE are as reviewed.
- `client/src/pages/Writing.tsx`, `client/src/services/*`, `client/src/types/domain.ts`, `client/src/pages/Progress.tsx` — untouched by the fix-pass.
- The `Today.tsx` render change is behavior-identical for every live-server envelope (non-empty `promptKr` renders exactly as before; the only behavioral deltas are the two defensive cases `undefined`/`''` and the enriched label).

## Gates (exact, run in worktree @ bffe155)

| Gate | Command | Result |
|---|---|---|
| Client lint | `cd client && npm run lint` | **0 errors** (exit 0) |
| Client typecheck | `npx tsc -p tsconfig.app.json --noEmit --incremental false` | **0 errors** (exit 0) |
| Client tests | `npx vitest run src/pages/Today.test.tsx src/pages/Progress.test.tsx src/services/grammar.test.ts` | 3 files, **147 passed**, 0 failed |
| Server typecheck | `cd server && npm run typecheck` | **0 errors** (exit 0) |
| Server tests | `npx vitest run tests/routes/grammar.test.ts tests/routes/plan.test.ts` | 2 files, **93 passed**, 0 failed |

(Server run shows only the pre-existing `pg` deprecation warning — present before this batch, unrelated.)

## Recommendation

**Ship.** Both original reviews PASSed with zero blockers; the fix-pass addressed the one SHOULD-FIX and two of the NITs with real, mutation-verified fixes, skipped the remaining three for sound reasons, and touched nothing the original reviewers signed off on. All targeted gates are green at `bffe155`. No conditions.
