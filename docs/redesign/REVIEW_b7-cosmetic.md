# Review: B7 cosmetic batch — F-097 dead-CSS sweep (+ F-179 carousel onChange, F-087 accent contrast, F-077 hanja reword)

Reviewer: independent senior front-end review. Scope: commit `c7774e7` on `worktree-agent-a48bf1406a016fcf4` (off `rebuild` @ `b365b9e`), primary focus the F-097 dead-CSS deletion in `client/src/styles/index.css` (−404 lines) and `client/src/pages/Progress.css`. Reviewer did not author this code and re-derived every verification independently — no reliance on the builder's own scan. Code not modified.

Note on diffing: `rebuild` has advanced past the branch point (PRs #121/#122, which independently removed `.km-progress__soonhead/soonbody/soonicon` via F-099), so `git diff rebuild` shows those rules spuriously "re-added". All review below is against the commit's true diff (`git show c7774e7`, parent `b365b9e` = merge-base). See SHOULD-FIX 1.

## Summary verdict: **PASS**

I independently re-verified **91 of 91 removed class selectors** (the full set, not a sample) with token-boundary greps across all of `client/src` (tsx/ts/css/html) plus `client/index.html`: every one has **zero remaining references**. An independent dynamic-class-construction audit found **no removed selector that is built at runtime** — the builder's claimed template-literal list was incomplete (it missed `km-tone--${tone}` in five components, plus several ternary-literal patterns), but none of the missed bases collide with anything removed, so the omission is harmless. The three selector-list trims are correct (removed member dead, surviving members live). All four gates pass clean, and the emitted production CSS bundle contains none of the removed classes while retaining every dynamically-composed keeper.

## F-097 — independent dead-selector verification (the core question)

### Method
1. Extracted every class token appearing on a `-` line of `git show c7774e7 -- client/src/styles/index.css client/src/pages/Progress.css`: 96 distinct names — 91 removed selectors, 3 live selector-list survivors (`.km-bilingual__sub`, `.km-skillbar__label`, `.km-review__input`), 1 removed-and-also-kept context (`.km-today__soonTitle`, counted in the 91), 1 extraction artifact (`.css`).
2. For each of the 91 removed selectors, ran `grep -rnE '(^|[^a-zA-Z0-9_-])<class>([^a-zA-Z0-9_-]|$)'` over `client/src` + `client/index.html` in the post-removal tree.
3. Separately audited every dynamic class-construction site in the codebase (below).
4. Grepped a risky subset (`km-review__*`, `km-passage*`, `gram-span`, `km-topik__mode*`, `km-reference__row-btn`, `km-library__chip`) across `server/`, `services/`, `tools/`, `Deploy/`, `db/` — nothing server-rendered references them (one hit in `db/docs/REVIEW_P1_READ.md:48` is a historical review document, not runtime).

### Result: 91/91 clean
All 91 removed selectors returned **zero references**. Representative citations (each grep run individually):

- `gram-span` (highest risk: short, un-prefixed, comment claimed "used inline by KoreanPassage's spanning run"): 0 hits. `KoreanPassage.tsx` no longer exists — only `client/src/components/TopikPassage.tsx` remains, which does not use it. Dead.
- `.km-passage`, `__sentence`, `__en`, `__en-toggle`: 0 hits each — the component they styled was deleted. Dead.
- `.km-topik__modes` / `__mode` / `__mode--active` (FU-NF-39 Study/Mock toggle): 0 hits — the toggle UI is gone from `Topik.tsx`. Dead.
- `.km-grammar__state--error` (risk: state-suffix pattern suggests `--${status}` construction): 0 literal hits AND no `km-grammar__state--${` interpolation anywhere. The base `.km-grammar__state` (index.css:3371) remains and is live in 8+ files (`WeeklySuggestions.tsx:159`, `Ttmik.tsx:703,856`, `Reading.tsx:369,560,1551`, `Writing.tsx:887,1048`). Only the variant died. Correct.
- `.km-review__sourceStatus--complete/--partial/--none` (risk: looks like `sourceStatus--${status}`): 0 hits, no matching interpolation. Dead.
- The full 60-rule `km-review__*` family (`__all*`, `__source*`, `__list*`, `__preview*`, `__thumb*`, `__maturity*`, `__mat*`, `__search*`, `__cover*`, `__due`, `__pct`, `__field`, `__formCol`, `__textarea`, `__sheetFoot`, `__sourcesMeta`, `__listRow--active`): 0 hits each. Survivors `.km-review__input` (live: `Review.tsx:1098,1111`, `MyVocabLists.tsx:617`), `.km-review__sectionTitle` (live: `ReviewVocab.tsx`), `.km-review__listsCol` (live: `Review.tsx:889`) correctly kept.
- `.km-reference__row-btn/filters/filter/skeleton/skeleton-line/error/row-kind`, `.km-resources__tabs`, `.km-library__quick/chip/row--soon`, `.km-skillbar__kr`, `.km-skillscompare__legendkr`, `.km-taskcard__krtag`, `.km-diagnostic__section-kr/-en/done-eyebrow`, `.km-reading__title`, `.km-grammar__title/tutor-note/tutor-label`: 0 hits each.
- `.km-progress__trendKr` (Progress.css): only surviving mention is its own tombstone comment (`Progress.css:550`) — not a reference. Dead, and this was the ticket's named orphan.

### Dynamic-construction audit (independent)
Scanned every `` `...km-*${...` `` template literal, `cn(`/clsx/`classList` call, and string-concat class builder in `client/src` (excluding tests). Complete inventory of true suffix-composition bases — where the full class token never appears literally and a literal grep would miss it:

| Base | Site | Collides with a removal? |
|---|---|---|
| `km-tone--${tone}` | `SealStamp.tsx:75`, `CityCard.tsx:68`, `DancheongRail.tsx:61`, `SubwayProgress.tsx:74`, `Sheet.tsx:103` | No — no `km-tone--*` removed. **Missing from builder's list.** |
| `km-subway__station--${state}` | `SubwayProgress.tsx:91` | No |
| `km-learnmenu__hexwrap--${SKILL_COLOR[navId].hexHue}` | `LearnMenu.tsx:315` | No — all 7 hue values in `lib/skill-colors.ts:88-94` (indigo, crimson, ochre, cyan, moss, violet, stone) have surviving rules at index.css:1594-1624 |
| `km-hanja__statechip--${tone}` | `Hanja.tsx:777` (tone: `'moss'\|'ochre'\|'mute'`, Hanja.tsx:774) | No — `--moss`/`--mute` kept (index.css:3832,3834), `--ochre` styled in `Hanja.css:116` |
| `km-progress__key--/series--/fill--${series.key}` | `Progress.tsx:1014,1171,1197,1277,1294` | No |
| `km-upload-viewer__pageDrag${...}` | `UploadViewer.tsx:1262` | No |
| `km-resources__initial${...}` | `ReviewDictionary.tsx:151` (interpolation is literal `' is-active'`) | No |

All other interpolations (`km-carousel__track/dot`, `km-chat__row/bubble/role`, `km-review__tab/rating/kindOpt/breakCell`, `km-mastery__seg/stat/chip/badge`, `km-btn`, `km-hanja__rating`) contain full literal class names inside ternaries or lookup tables (`TONE_CLASS`, `STATE_CLASS`, `BUCKET_META`) — all reachable by the literal token-boundary grep, so covered by the 91/91 sweep. String-concat scan (`'...' + ...`) found only self-contained literals (`SwatchPicker.tsx:150`, `Images.tsx:546,566`, `Settings.tsx:2324`), none touching removed names.

**Conclusion: no removed selector is dynamically constructed anywhere.** The builder's stated audit list of 5 bases was incomplete as a *claim* (see SHOULD-FIX 2) but the *outcome* is unaffected.

### Selector-list trims (3)
1. index.css:646 — `.km-today__soonTitle .km-bilingual__sub` removed from the muted-sub group: `km-today__soonTitle` has 0 references anywhere; survivors `.km-taskcard__skill` (TaskCard.tsx) and `.km-skillbar__label` (SkillBar.tsx) are live. Rule still needed. Correct, including the comment update dropping "Today coming-soon title".
2. index.css:3760 — `.km-review__textarea` dropped from the `.km-review__input` base rule: textarea 0 refs, input live x3. Correct.
3. index.css:3774 — same pair's `:focus-visible` rule. Correct.

### Emitted-bundle spot check
`npx vite build --outDir /tmp/km-b7rev` → exit 0, no CSS parse errors (a dangling brace/comment from the 404-line deletion would have failed the build). In `/tmp/km-b7rev/assets/index-BR8-0B74.css`: `km-review__thumb`, `km-passage`, `gram-span`, `km-topik__mode`, `km-library__chip` all absent; keepers `statechip--moss`, `statechip--mute`, `hexwrap--crimson`, `hexwrap--stone`, `km-progress__key--`, `km-subway__station--` all present.

## F-179 — SwipeCarousel `onChange` (secondary scope)

Correct and genuinely backward-compatible. All three user-gesture mutation paths route through `goTo` (`SwipeCarousel.tsx:154`): swipe snap (`:261-262`), dot keyboard nav (`:297`), dot click (`:368`). The settle guard `if (target !== index) onChange?.(target)` (`:166`) compares against the current render's settled index, so spring-backs, active-dot clicks, and clamped edge swipes are correctly silent; the render-time children-shrink clamp bypasses `goTo` entirely and never fires, as documented. Prop is optional with no default side effects — zero behavior change for existing consumers. Test file extended (+99 lines) and passing.

## F-087 — accent contrast tests (secondary scope)

Real assertions, not smoke: `tokensContrast.test.ts:247-` adds two matrices — `--vermilion-ink` >= 4.5:1 (AA text) and `--vermilion` >= 3:1 (WCAG 1.4.11 indicator) against all four opaque surfaces (`--ink`..`--ink-3`) for every theme x accent combo. The `ACCENTS` list (coral, blue, mint) exactly matches the presets defined in index.css (`data-accent="blue|coral|mint"` — verified exhaustive by grep). Cascade merge order (light block, then dark, then accent, then dark-accent) mirrors runtime. This is the exact check the historical light-mint 2.99:1 regression would have tripped.

## Gates (run by reviewer in the worktree)

| Gate | Result |
|---|---|
| `npm run lint` | exit 0, no findings |
| `npx tsc -p tsconfig.app.json --noEmit --incremental false` | exit 0 |
| `npx vitest run` | **121 files / 2094 tests, all pass** (19.6s) |
| `npx vite build --outDir /tmp/km-b7rev` | exit 0, no CSS errors (pre-existing >500 kB chunk warning only) |

## Findings

### BLOCKER
None. No removed selector is referenced anywhere — statically or dynamically — and the stylesheet survives the deletion syntactically intact.

### SHOULD-FIX
1. **Merge-conflict landmine in `Progress.css` vs current `rebuild`.** `rebuild` has moved past this branch's base: PR #121/#122 (F-099) deleted `.km-progress__soonhead/soonbody/soonicon` and replaced the trailing comment block that this commit's `.km-progress__trendKr` removal sits directly above (`Progress.css:545-560` region). The two edits touch adjacent/overlapping lines, so the eventual merge into `rebuild` will likely conflict — and a careless resolution could resurrect the soon-placeholder rules or drop the trendKr tombstone comment. Resolve by rebasing onto current `rebuild` before PR (the correct post-merge state is: no `trendKr`, no `soonhead/soonbody/soonicon`, F-099's comment kept).
2. **Commit message overstates the construction-audit's completeness.** The claimed template-literal inventory (5 bases) omits `km-tone--${tone}` (`SealStamp.tsx:75`, `CityCard.tsx:68`, `DancheongRail.tsx:61`, `SubwayProgress.tsx:74`, `Sheet.tsx:103`) and the lookup-table pattern (`BUCKET_META[b].cls`, `TONE_CLASS`, `STATE_CLASS`). Outcome unaffected this time (no collision with removals), but future sweeps citing this commit's method as precedent would inherit the blind spot. Worth a one-line correction in the PR description; no code change needed.

### NIT
1. `.km-hanja__statechip--vermilion` (index.css:3833) survives the sweep but the statechip tone union is now `'moss' | 'ochre' | 'mute'` (`Hanja.tsx:774`) — the vermilion variant looks like a candidate for the next sweep (Hanja.css:105's comment still references it, so verify intent first; out of this commit's scope).
2. `Progress.css:550`'s tombstone comment now narrates two eras of removal history for one dead rule. Fine to keep, but it could shrink to one line.

### PRAISE
- The sweep's discipline is visible in what it *kept*: every dynamically-composed family (`hexwrap--*` x7 exactly matching `SKILL_COLOR`'s hue set, `statechip--*`, the `progress__key/series/fill--*` chart keys) survived, and the three selector-list trims surgically removed only the dead member while preserving live rules — the hardest part of a dead-CSS sweep done right.
- F-179's settle-only semantics (`target !== index` inside the single `goTo` chokepoint) is the minimal correct design — one guard covers all five documented no-fire cases without per-path bookkeeping.
- F-087 asserts against the parsed token file with a runtime-faithful cascade merge, making the tests regression-proof against token refactors rather than hardcoding hex pairs.
