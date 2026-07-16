# Fix Report: B7 cosmetic batch (F-077/F-087/F-097/F-179)

Fix-pass over `REVIEW_b7-cosmetic.md` (R1, dead-CSS) + `REVIEW_b7-labels.md` (R2, labels). Both reviews PASSed with 0 blockers; this pass addresses the SHOULD-FIXes + trivially-safe nits. Base commit reviewed: `c7774e7` (merge-base with `rebuild`: `b365b9e`). No PASSed substance touched — the 91 dead-CSS removals, F-077 `banked` wire ids, F-087 test assertions, and F-179 `goTo`/`onChange` logic are byte-identical to the reviewed commit.

## Dispositions

### R2 SHOULD-FIX 1 — `HANJA_PROGRESS_FIXTURE` incoherent under client-side composition → **FIXED**

`client/src/data/mocks/hanja.ts:206` — fixture carried `banked: 6, practicing: 4, new: 2, encountered: 142`, so the F-077 client-composed line (`total = banked + practicing + new`) rendered "6 mastered · 4 practicing · **142/12** encountered" in dev mock mode.

- `new: 2` → `new: 990`. Reconstructed total = 6 + 4 + 990 = **1000**; mock mode now renders "6 mastered · 4 practicing · 142/1000 encountered" — coherent and route-contract-consistent (`new` = total − banked − practicing per `server/src/routes/hanja.ts` GET /progress; encountered ≤ total).
- Added a doc comment on the fixture stating the invariant so a future edit can't silently reintroduce the mismatch.
- Added a regression test (`client/src/lib/encounteredBar.test.ts`) asserting `banked + practicing + new >= encountered` on the fixture — the exact failure mode, pinned.
- **Real (non-mock) path verified unaffected:** the fixture's only consumer is `loadHanjaProgressMock` (`hanja.ts:247`), reached solely as the mock fallback of `useEndpointOrMock('hanja:progress', …)` in `Hanja.tsx:385-389`; the real path uses `fetchHanjaProgress()`. Progress's Hanja tab is real-data-only. No unit test coupled to the old numbers (full grep: zero test references to the fixture's values before this pass).

### R1 SHOULD-FIX 2 — audit-completeness claim overstated → **CORRECTED**

The reviewed commit's message claimed the F-097 dynamic-construction audit inventory as complete when it listed only 5 template-literal bases; R1's independent audit found it missed `km-tone--${tone}` (5 components: `SealStamp.tsx:75`, `CityCard.tsx:68`, `DancheongRail.tsx:61`, `SubwayProgress.tsx:74`, `Sheet.tsx:103`) and the lookup-table pattern (`BUCKET_META[b].cls`, `TONE_CLASS`, `STATE_CLASS`). R1 confirmed **none of the missed bases collide with any removed selector**, so the sweep's outcome stands unchanged.

The claim exists only in commit `c7774e7`'s message (grep-verified: no in-code comment in `index.css`/`Progress.css` states it) — history is not rewritten by this fix-pass, so the correction is recorded where downstream readers will consume it:

- **Here** (this report), as the authoritative correction.
- **In this fix-pass's commit message**, so the branch log carries it.
- **For the PR body** (orchestrator composes it): the accurate claim is — *"the dynamic-construction audit covered template literals, lookup tables (`BUCKET_META`/`TONE_CLASS`/`STATE_CLASS`), and string concat; the complete suffix-composition base inventory is `km-tone--*`, `km-subway__station--*`, `km-learnmenu__hexwrap--*`, `km-hanja__statechip--*`, `km-progress__key/series/fill--*`, `km-upload-viewer__pageDrag*`, `km-resources__initial*` — none collide with the 91 removals (independently re-verified 91/91 by review)."* Do not cite the original 5-base list as sweep-method precedent.

No CSS re-added or changed; accuracy-only per the review ("no code change needed").

### R1 SHOULD-FIX 1 — Progress.css merge-conflict landmine vs advanced `rebuild` → **DEFERRED to orchestrator (out of mandate)**

This fix-pass is explicitly barred from rebasing; the orchestrator owns the merge onto the advanced `rebuild`. Recording the reviewer's resolution guidance for that merge: correct post-merge state in the `Progress.css:545-560` region is **no `trendKr` rule, no `soonhead`/`soonbody`/`soonicon` rules, F-099's comment kept**. (This pass also shrank the tombstone comment in that region — see R1 NIT 2 — which the merger should keep in its one-line form.)

### R1 NIT 1 — `.km-hanja__statechip--vermilion` next-sweep candidate → **SKIPPED (intentionally)**

The reviewer themselves scoped it out ("verify intent first; out of this commit's scope") — `Hanja.css:105`'s comment still references the variant, so removal needs an intent check, which makes it not trivially safe. Left for the next dead-CSS sweep.

### R1 NIT 2 — two-era tombstone comment in `Progress.css` → **FIXED**

`Progress.css:548-551` — shrank the parenthetical to one line: `(.km-progress__trendKr removed by the F-097 dead-rule sweep.)`. Comment-only change; the muted-sub rule and its three surviving selectors untouched.

### R2 NIT 1 — no direct unit test for `hanjaProgressSummary` → **FIXED**

New `client/src/lib/encounteredBar.test.ts` (4 tests): a 3-row table test pinning the EN/KR templates, the reconstructed `encountered/total` denominator, and the zero-count `0/0` shape independently of page markup — plus the fixture-coherence regression guard from R2 S1 above. Follows the existing `src/lib/*.test.ts` convention (`skillBand.test.ts` et al.). `encounteredBarAria`'s untested posture is pre-existing and was not flagged; left as-is.

### R2 NIT 2 — `goTo` compares against render-scope `index` (stale-closure) → **SKIPPED (intentionally)**

Reviewer confirms it is unreachable today (every call site is a discrete user event; React flushes between discrete events). The suggested cure — a functional `setRawIndex(prev => …)` with the change-check inside — would move the `onChange` side effect into (or force restructuring around) a state updater, which React StrictMode double-invokes: that trades a today-unreachable hypothetical for a real double-fire hazard, and it reworks the exact settle-guard design both reviews PASSed and praised. Not trivially safe; skipped.

## Gates (exact, run in worktree `client/`)

| Gate | Result |
|---|---|
| `npm run lint` | exit 0, no findings |
| `npx tsc -p tsconfig.app.json --noEmit --incremental false` | exit 0 |
| `npx vitest run` | **122 files / 2098 tests, all pass** (was 121/2094 pre-fix; +1 file / +4 tests = the new `encounteredBar.test.ts`) |
| `npx vite build --outDir /tmp/km-b7fix` | exit 0 (pre-existing >500 kB chunk warning only) |

## Files changed by this fix-pass

- `client/src/data/mocks/hanja.ts` — fixture `new: 2` → `990` + invariant doc comment (mock-only)
- `client/src/lib/encounteredBar.test.ts` — new; 4 unit tests
- `client/src/pages/Progress.css` — tombstone comment shrunk to one line
- `docs/redesign/FIX_REPORT_b7.md` — this report
