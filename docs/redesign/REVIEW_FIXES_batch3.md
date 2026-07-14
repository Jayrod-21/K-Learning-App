# RE-REVIEW — Batch 3 (LEARN batch A: Flashcards/Grammar-practice/Hanja/Reading) fix-pass verification

**Reviewer:** independent senior re-reviewer (fresh — did not write the batch-3 code, the 4 original reviews, or the fix-pass).
**Scope:** `feat/redesign-learn-a` @ `5ffe4bb` (fix-pass) on `8eae3c8` (batch), off `rebuild`. Verifying `docs/redesign/FIX_REPORT_batch3.md` against actual code, re-running the full gate, and independently re-computing the Hanja mastery-color WCAG contrast numbers.

## VERDICT: PASS

All BLOCKER and required SHOULD-FIX items are genuinely fixed and hold up under direct probing of the code (not just the report's prose). The independently re-computed WCAG contrast numbers match the fix-pass's claimed numbers exactly (all 6 pairings, both themes). All 4 gate commands were re-run from scratch and match the report's claimed numbers exactly. No regressions found in any of the shared-component changes (tone enum, `PageHubHeader`, `.km-btn--sm`). Three lower-priority SHOULD-FIX items from the original reviews were left unaddressed and untracked as follow-ups (see New Findings) — none are blocking, but they should be logged before this is considered fully closed out.

---

## Finding-by-finding table

| ID | Finding | Orig. severity | Fix status | Test catches regression? | Notes |
|---|---|---|---|---|---|
| B1 | Hanja new-tile painted `--danger` (red) | BLOCKER | **FIXED** | Partial (class-name assertion only, not color; contrast/hue can't be unit-tested) | `--km-mastery-new` → `--paper-mute` in both themes, `index.css:150-152,269-271,335`. `Hanja.css` override fully retired (only comments remain at lines 88/98, no rule). Verified: `--km-mastery-new` never resolves to `--danger` anywhere. |
| B2 | Day `--ochre` practicing band fails 3:1 AA; false "already checked" comment | BLOCKER | **FIXED** | Same as B1 (no unit test can assert computed contrast — inherent CI limitation, correctly acknowledged by both reviews) | `--km-mastery-practicing` → `--ochre-ink`. False code comment corrected. **Independently re-verified all 6 numbers — see dedicated row below.** |
| — | Tone-enum promotion (`ochre` on `DancheongRailTone`/`CityCardTone`/`SubwayProgressTone`); `HanjaCell` mastery separated from tone system; page override retired | Fidelity structural win + Hanja workaround (b) | **FIXED** | N/A (structural) | `DancheongRail.tsx:26` — `ochre` added additively to the union. `seoul-devices.css:161-168` — `.km-tone--ochre` maps Day `--dan-ochre` / Night `--neon-amber`. Hanja: 1 `railTone="ochre"` (line 575) + 6 `tone="ochre"` (711, 871, 2041, 2664, 2707, 3286) = 7 sites, matches claim exactly. No `tone="plain"`/`railTone="plain"` remains in `Hanja.tsx`. Mastery triad (`--km-mastery-*`) kept as a genuinely separate token mechanism from `--km-tone`, per the fidelity review's explicit caveat not to collapse the two concepts. |
| — | Flashcard signboard occluded by opaque `.km-review__front`/`__back` bg | SHOULD-FIX (Flashcards) | **FIXED** | No dedicated visual test (jsdom can't render CSS — acknowledged, not a gap unique to this fix) | `Review.css:133-136` — `.km-review .km-review__front, .km-review .km-review__back { background: transparent; }`. Confirmed `.km-flashcard__face`'s gradient/glow rules (`Review.css:77-93`) are otherwise untouched and now the topmost visible surface. |
| — | F-129 overflow-x test tautological | SHOULD-FIX (Flashcards) | **FIXED** | **Yes** — re-verified the test reads `Review.css` source via `readFileSync` and asserts the literal `.km-review { }` block contains `overflow-x: hidden;` (`Review.test.tsx:1238-1258`). Confirmed the actual rule at `Review.css:15-18` contains it. Deleting that line would fail the test. |
| — | Hanja's 3 Sheets bespoke chrome vs. shared `.km-review__sheet*` + `<Button>` | SHOULD-FIX (Fidelity SF-1) | **FIXED** | Existing role/name-based Sheet interaction tests pass unmodified (button labels preserved) | Read all 3 sheets directly: `QuickAddSheet` (`Hanja.tsx:1150-1163`), `CreateListSheet` (`:1806-1852`), `AddHanjaPicker` (`:2343-2360`) all now render `.km-review__sheetBody`/`__sheetHead` with a `<Button variant="ghost" size="sm">` Close and `<Button variant="gold">` CTAs ("Create & add", "Create", "Add N selected"). Matches the exact recipe used in `Mistakes.tsx:245-246` and `ReviewGrammar.tsx:814-815`. |
| — | `PageHubHeader` actions render below rail divider, not inline with h1 | SHOULD-FIX (Grammar) | **FIXED** | `PageHubHeader.test.tsx`'s 7-test contract suite passes unmodified | `PageHubHeader.tsx:86-93` — new `.km-hubheader__titlerow` flex row (`justify-content: space-between`) wraps h1 + optional actions; renders nothing extra when `actions === undefined` (confirmed: ternary returns `null`). `SkylineHeader.css:80-89` — `.km-skyline__title` gained `right: 20px` (was `left`-only), giving the flex row room to push actions to the banner edge. Confirmed Grammar (`Grammar.tsx:820`) is the only current `actions=` consumer via repo-wide grep; the other 8 `PageHubHeader` consumers (Mistakes, Uploads, ReviewLibrary, ReviewDictionary, ReviewGrammar, ReviewVocab, Reading, UploadViewer) pass no `actions` and are structurally unaffected. |
| — | `.km-btn--sm` under 44px touch target | SHOULD-FIX (Grammar) | **FIXED** | No dedicated new test (jsdom doesn't compute layout — acknowledged residual risk, not a gate failure) | `index.css:876` — `.km-btn--sm { padding: 6px 10px; font-size: 12px; min-height: 44px; min-width: 44px; }`. Confirmed via full suite pass (no consumer broke). |
| — | Grammar revealed-phase "Another"/"Next pattern" untested | SHOULD-FIX (Grammar) | **FIXED** | **Yes** — real regression catcher | `Grammar.test.tsx:2093-2172` — submits an answer, reaches `revealed`, disambiguates the two same-labeled "Another" buttons by `.km-btn--gold` class (`Grammar.tsx:2174-2189` confirms both the ghost-Skip-replacement and gold-Next-pattern-replacement relabel to "Another" in continuous mode — a real pre-existing a11y quirk, correctly worked around not hidden), clicks the gold one, and asserts `generateDrill` fires again for the identical `patternKey`. Hardcoding `'Next pattern'` in the revealed branch would fail this test. |
| — | Dead CSS `.km-review__progressBar`/`__progressFill` | NIT (confirmed dead) | **FIXED** | N/A | Repo-wide grep confirms zero JSX references remain — only a `Review.css:110` comment mentions the old classnames descriptively. Genuinely removed from `index.css`. |
| — | F-164 doc overclaim ("only two literal-px risks") | SHOULD-FIX (trivial) | **FIXED** | N/A (doc-only) | Fixed opportunistically in the same file as B1/B2. |
| Hanja SF#1 | `masteredCount` label imprecision on already-banked reconfirmation | SHOULD-FIX (Hanja, not in the 9 "required") | **NOT-FIXED** | — | See New Findings below. |
| Hanja SF#2 | Untested no-op-write branch (already-banked right answer) | SHOULD-FIX (Hanja, not in the 9 "required") | **NOT-FIXED** | — | See New Findings below. |
| Hanja SF#3 | Stat-chip `tone="vermilion"` vs. index-grid fixed ochre-ink mismatch | SHOULD-FIX (Hanja, explicitly recommended to fold into this same fix-pass) | **NOT-FIXED** | — | See New Findings below — this is the one item worth flagging most, since the original review explicitly asked for it to ride along with the B1/B2 fix in the same file. |
| Flashcards SF#3 | F-130 deferral has no in-code trace | SHOULD-FIX (Flashcards, not in the 9 "required") | **NOT-FIXED** | — | See New Findings below. |

---

## Hanja mastery-color AA — independent re-computation

Recomputed from the actual hex values in `client/src/styles/index.css` using the standard WCAG 2.1 relative-luminance contrast formula, independently (not copied from the report), against each theme's card surface (`--ink-1`).

| Band | Day token chain (hex) | My Day ratio | Report's Day ratio | Night token chain (hex) | My Night ratio | Report's Night ratio |
|---|---|---|---|---|---|---|
| Mastered | `--km-mastery-mastered` → `--moss` → `--dan-jade` `#2E7D6B` vs `--ink-1` `#FAF6EC` | **4.567:1 PASS** | 4.57:1 | `--moss` → `--neon-mint` `#12C08A` vs `--ink-1` `#12172a` | **7.558:1 PASS** | 7.56:1 |
| Practicing | `--km-mastery-practicing` → `--ochre-ink` → `--dan-ochre-ink` `#8B5F15` vs `--ink-1` `#FAF6EC` | **5.195:1 PASS** | 5.20:1 | `--ochre-ink` → `--ochre` → `--neon-amber` `#FFB43D` vs `--ink-1` `#12172a` | **10.028:1 PASS** | 10.03:1 |
| New | `--km-mastery-new` → `--paper-mute` `#6B614D` vs `--ink-1` `#FAF6EC` | **5.649:1 PASS** | 5.65:1 | `--paper-mute` `#8B96C8` vs `--ink-1` `#12172a` | **6.172:1 PASS** | 6.17:1 |

All 6 pairings independently confirmed to clear the 3:1 non-text floor, and the specific hex/token chain in `index.css` (lines 48, 78, 81, 113-114, 126-127, 150-152, 200, 214, 229-230, 247-248, 257-258, 269-271) matches what the fix report claims to have used. **The numbers are real, not fabricated.**

---

## Praise-intact check

- **F-158 state machine (Grammar continuous drill):** `Grammar.tsx`'s `formTarget`/`activeTarget`/`advance()` plumbing untouched by this fix-pass's diff scope; the new revealed-phase test exercises it further without altering the mechanism. Confirmed via full suite pass (56+ Grammar tests, no failures).
- **F-165 Anki loop (Hanja):** `buildDrawQueue` (`Hanja.tsx:354`), `judgeRight`/`judgeWrong` (`:2542`, `:2554`), `DRAW_SESSION_LIMIT = 20` (`:252`), `seededForRef` guard (`:2517`) all present and unmodified by this fix-pass.
- **F-169/F-170 real data (Hanja):** `HanjaCell` still called sound-only in the grid; `SubwayProgress` still driven by real `idx`/`masteredCount`. Not touched by this diff except the color-token chain (B1/B2), which is orthogonal to the data plumbing.
- **No regression from shared-component changes:** tone-enum addition is additive-only (44 other `tone="accent"|"blue"|"mint"|"plain"` call sites across `Reading.tsx`, `Uploads.tsx`, `UploadViewer.tsx`, etc. grepped and confirmed unaffected); `PageHubHeader`'s 7-test contract suite and all 8 non-`actions` consumers pass; `.km-btn--sm`'s 8 consumers all pass in the full suite.

---

## New findings (not in the original 4 reviews' explicit probe list, but worth logging)

1. **Three real SHOULD-FIX items from the original reviews were silently dropped — not fixed, and not added to the fix report's own "Follow-up ticket titles" section:**
   - Hanja SF#1 (`masteredCount` label imprecision, `Hanja.tsx:2482-2492,2639`) — still says "N of M mastered" on a no-op reconfirmation.
   - Hanja SF#2 (untested no-op-write branch) — no new test added to `Hanja.test.tsx` for the `promoteState` no-change guard.
   - Hanja SF#3 (stat-chip `tone="vermilion"` vs. index-grid fixed ochre mismatch, `Hanja.tsx:721-726`) — confirmed still present: `StateChip` "Practicing" still reads `tone="vermilion"` (accent-tracking) while the index grid two paragraphs below now reads the fixed `--ochre-ink`. The original Hanja review explicitly recommended this ride along with the B1/B2 fix since it's "the same root cause and same file" — it didn't.
   - Flashcards SF#3 (F-130 deferral undocumented) — no doc comment was added near `StudySession` in `Review.tsx`; grepped for "F-130" in `Review.tsx`, zero hits.
   
   None of these are blockers — the fix-pass's own report is internally honest that it scoped to "9 required findings (2 BLOCKER + 7 SHOULD-FIX)" and explicitly enumerates them, so this isn't a case of the report lying about what it fixed. But three real, previously-identified SHOULD-FIX items now have no tracking (they're absent from both `BUGS_AND_FEATURES.md` and the fix report's 2-item follow-up list), so they're at risk of being lost. Recommend filing them explicitly before closing this batch out.

No other new findings — no regressions detected anywhere in the diff.

---

## Independent gate run (from `client/`, on `5ffe4bb`)

| Command | Result | Report's claim | Match? |
|---|---|---|---|
| `npm run lint` | 0 errors, exit 0 | 0 errors, exit 0 | Yes |
| `npx tsc -p tsconfig.app.json --noEmit --incremental false` | 0 errors, exit 0 | 0 errors, exit 0 | Yes |
| `npx vitest run` | **116 files passed (116), 1707 tests passed (1707)** | 116/116 files, 1707/1707 tests | Yes, exact match |
| `npx vite build --outDir /tmp/km-rr-batch3` | exit 0, built in 574ms, PWA precache 15 entries, pre-existing >500kB chunk warning present | exit 0, ~570ms, PWA 15 entries, same pre-existing warning | Yes |

Working tree left clean (only pre-existing untracked `.claude/` and `REDESIGN_SEOUL_NEON_BRIEF.md`, present before this review began, unrelated to batch-3).

---

## Recommendation

**Ready to PR into `rebuild`.** All BLOCKER and required-scope SHOULD-FIX findings are genuinely fixed, verified against source (not just the self-report), and the AA numbers are real. File the 4 dropped SHOULD-FIX items (Hanja SF#1/#2/#3, Flashcards F-130 doc note) as explicit follow-up tickets before/alongside merging so they don't silently disappear — none block the merge.
