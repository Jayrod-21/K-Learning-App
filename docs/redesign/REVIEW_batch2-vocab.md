# Review — Batch 2: Library → Vocab + Dictionary + Library index

**Reviewer:** independent senior React/TS reviewer (did not write this code)
**Branch:** `feat/redesign-library` @ `2c2d4ad` (off `rebuild`)
**Scope:** `client/src/pages/ReviewLibrary.*`, `client/src/pages/review/ReviewVocab.*`, `client/src/pages/review/ReviewDictionary.*`
**Tickets:** F-128 (library slice), F-144–F-151

## Verdict: **CHANGES REQUIRED — 1 BLOCKER**

The reskin work (F-128 device adoption on all three pages), F-148 (This-Week popup), F-146 (collapsible My Lists), F-149 (search labels), and F-150 (dictionary grammar filter) are all real, well-built, and well-tested. F-151's deferral is honest and unusually well-documented (cites live row counts). But **F-144 is not actually done**, and the F-147 PARTIAL disposition is the same dodge wearing a different ticket number — both point at the same untouched code: `MyVocabLists`' always-visible "New list" card, which puts a literal **"Grammar 문법" radio button** on the Vocab page, mounted by default, with zero test coverage of the fact. The PR's own doc comments only address a cosmetic classname (`km-grammar__state` → `km-vocab__state`) and never mention this control exists. That's the ticket's actual "WHY IS GRAMMAR IN HERE" complaint, still live.

---

## Ticket checklist

| # | Claimed | Actually done? | Evidence |
|---|---|---|---|
| F-128 (library slice) | Full reskin: SkylineHeader, DancheongRail, CityCard, tones | **YES** | `ReviewLibrary.tsx:117-150` (own file, current), 4 CityCard rows with 4 distinct tones (`accent`/`blue`/`mint`/`plain`), matching test `ReviewLibrary.test.tsx` new `it('F-128: reskins...')`. Same recipe replicated correctly in `ReviewVocab.tsx:226-245` and `ReviewDictionary.tsx:298-320`. No hardcoded hex found in any of the 3 touched CSS files (`grep` clean). |
| F-144 | "Remove leftover grammar UI from Vocab" | **NO — BLOCKER** | Only the page's own loading-state `<div>`s were renamed (`ReviewVocab.tsx:562`, `:795`). `MyVocabLists.tsx:47-52,193-213` (unchanged, 0 lines touched by this branch — `git diff rebuild -- client/src/components/MyVocabLists.tsx` is empty) renders an always-visible "New list" card with a `role="radiogroup"` "List kind" control offering **vocab / grammar (문법) / hanja / mixed**, mounted inside `ReviewVocab.tsx`'s `CollapsibleTile` which is **open by default**. A user landing on `/review/vocab` sees the word "Grammar"/"문법" as a clickable option before doing anything. No test in `ReviewVocab.test.tsx` queries for this control at all (see Findings, B-1). |
| F-145 | Vocab mobile responsiveness | **PARTIAL, plausible** | `ReviewVocab.css:16-18` adds `overflow-x:hidden` backstop + `flex-wrap`/`min-width:0` on new rows (`:73-82`, `:88-97`); `@media (max-width:420px)` stacks the genre/difficulty filters (`:59-63`). Consistent with the Progress.css convention cited in the comments. **No automated test** asserts absence of horizontal overflow at a narrow viewport (jsdom limitation, same gap as batch-1 pages) — can't verify beyond code-reading. |
| F-146 | Collapsible My Lists | **YES** | `ReviewVocab.tsx:279-287`, `CollapsibleTile` with `surface="city"`, default open. Real test: `ReviewVocab.test.tsx` "My Lists is collapsible (F-146)" toggles `aria-expanded` true→false→true and checks content presence/absence via `queryByText`. Not a tautology. |
| F-147 | Create-list popup (vocab-only) | **PARTIAL claim is a dodge, see Findings B-2** | `AddToListSheet` (word-picker entry point) is genuinely already a vocab-only Sheet (`ReviewVocab.tsx:751-756`, hardcoded `kind: 'vocab'`). But the OTHER create-list surface — `MyVocabLists`' inline card with the vocab/grammar/hanja/mixed picker — is the SAME code implicated in F-144, and the "shared component, out of scope" excuse doesn't hold up: `MyVocabLists` has exactly one production consumer today (`ReviewVocab.tsx` — confirmed by grep, no other `.tsx` imports it). |
| F-148 | This-Week popup | **YES** | `ReviewVocab.tsx:296-343`: trigger `Button` → `Sheet` → `WeeklySuggestions` mounted only as `Sheet` children (Sheet returns `null` when `!open`, so nothing renders/fetches until opened). Real tests: "renders behind a popup" asserts `fetchWeeklyVocabSuggestions` NOT called pre-open; "closes via its own close button, returning focus to the trigger" asserts `trigger).toHaveFocus()` post-close. Both are genuine behavioral assertions. |
| F-149 | "Search for a word" label | **YES, both pages** | `ReviewVocab.tsx:525-527,533`, `ReviewDictionary.tsx:329-331,337` — visible `Eyebrow` caption + matching `aria-label`, both wired to the same string. Tests assert both `getByRole('searchbox', {name:...})` AND `getByText(...)` (visible caption), not just the accessible name — good, catches a label-only-in-aria regression. |
| F-150 | No grammar in All Words dictionary | **YES, filter correct; gap honestly flagged** | `ReviewDictionary.tsx:94-97` `isGrammarPos` excludes `어미`/`조사`, explicitly keeps `접사` (correct — affixes aren't grammar patterns). Applied consistently to render (`:384`) AND to the `rowCount` used for empty/error/pager gating (`:285-288`) — this second application is the detail that makes the "all-grammar page → honest empty state" test pass instead of rendering a blank list with a nonzero pager. Real tests, including the specific "all rows are grammar" edge case and the vocab-pivot non-exclusion case. |
| F-151 | More genres | **DEFERRED, honest** | See Findings, PRAISE-1. Verified against `server/src/routes/vocab.ts:69` (`domain: z.enum(['general','research','business'])`, no `theme` param) — the claim is accurate, not hand-waved. |

---

## Findings

### BLOCKER

**B-1 — F-144 is not done: a live "Grammar" control renders on the Vocab page by default.**
`client/src/components/MyVocabLists.tsx:47-52` (`KIND_OPTIONS` includes `'grammar'`), `:55-60` (`KIND_KR.grammar = '문법'`), `:193-213` (the `role="radiogroup"` "List kind" picker, unconditionally rendered as part of the always-visible "New list" card — not gated by loading/empty state). This component is mounted at `client/src/pages/review/ReviewVocab.tsx:286` inside a `CollapsibleTile` that defaults to **open** (`ReviewVocab.tsx:279-287`, no `defaultCollapsed`). Net effect: navigate to `/review/vocab`, and before touching anything, "Grammar · 문법" is a tappable radio option, and selecting it + naming a list actually POSTs `kind: 'grammar'` (`MyVocabLists.tsx:100-104`). This is the exact complaint the ticket quotes ("WHY IS GRAMMAR IN HERE") — not a cosmetic classname echo, a literal word "Grammar" in a functioning control on this page.

The PR's own doc comment (`ReviewVocab.tsx:30-37`) only describes renaming `.km-grammar__state` → `.km-vocab__state` for the two loading divs, and separately (`:44-50`, the F-147 note) acknowledges `MyVocabLists`' create card has "vocab/grammar/hanja/mixed kind picker" — but frames it purely as an F-147 (popup-vs-inline) scoping question, never connecting it back to F-144 (grammar UI presence). Both tickets are being satisfied by the same excuse against the same code, and neither actually removes the grammar-labeled control from the page.

No test catches this. `ReviewVocab.test.tsx`'s F-144 describe block (search `no leftover grammar UI (F-144)`) only forces the Browse-loading branch and asserts `.km-grammar__state` is absent — it never renders far enough or queries for the "New list" card's radiogroup, so a test suite that says "F-144: PASS" is silent about the actual bug. This is exactly the "test can't catch its bug" category from the brief.

**Fix-pass action:** either (a) pass a prop into `MyVocabLists` (e.g. `allowedKinds`/`hideKindPicker`) so `ReviewVocab` can mount it vocab-only — cheap, since it's a single real consumer today — or (b) convert the inline create card into the same `AddToListSheet`-style popup pattern already used elsewhere on this page, vocab-scoped. Either closes F-144 and F-147 together. A follow-up ticket is not an acceptable disposition for a P1 ticket whose entire point is "the user is annoyed grammar shows up here."

### SHOULD-FIX

**S-1 — F-147's "shared component, out of scope" framing understates the actual coupling.**
`MyVocabLists` is described in its own header comment as "THE canonical My lists surface" (implying future reuse), but as of this branch it has exactly one production import (`ReviewVocab.tsx`). Calling it "shared" to justify not touching it, while it is simultaneously the direct cause of the F-144 BLOCKER above, reads as scope-avoidance rather than a genuine architectural boundary. If a Grammar library page is imminent (the PR mentions "another agent... reworking [Grammar] in parallel this pass" re: F-151), that's a fixpass-report line item, not a reason to ship a P1 bug as "PARTIAL, satisfied."

**S-2 — F-150's server/client total mismatch is disclosed but untested.**
`ReviewDictionary.tsx:84-92` quantifies the gap precisely (504 어미 + 157 조사 of 53,978, ~1.2%) and correctly identifies the fix (`WHERE part_of_speech NOT IN (...)` server-side). This is a genuinely honest, well-researched disposition — but there's no test asserting the *specific* symptom (e.g., a "31–60 of 54000" pager caption rendering while fewer than 30 rows are on screen). The all-grammar-page test covers the extreme case; the partial-page case (the actually likely one at 1.2% density) is undemonstrated. Not a blocker — the failure mode is a cosmetic off-by-a-few in a footer caption, not broken functionality — but worth a follow-up ticket with an actual repro test, not just a code comment, so it doesn't quietly rot.

**S-3 — Inconsistent grammar-classname cleanup across the touched pages.**
`ReviewVocab.tsx` renamed its own loading divs off `.km-grammar__state`, but `ReviewDictionary.tsx:361` (touched in this same PR, same reskin pass) still renders its loading state through `.km-grammar__state`. Outside the exact ticket text (F-144 says "Vocab" only) this is a minor inconsistency but undermines the "no page should say grammar in its own classnames" spirit the F-144 comment articulates — cheap to fix while already in the file.

**S-4 — F-145 has no regression test.**
No test in any of the three touched `*.test.tsx` files exercises viewport width / `scrollWidth` vs `clientWidth` to catch horizontal overflow. This mirrors a gap already flagged in batch-1's fidelity review, so it's a known, accepted limitation of the current test stack rather than a new regression — flagging for completeness per the review brief, not counting it against this batch specifically.

### NIT

**N-1** — `ReviewVocab.tsx:236` line-wraps awkwardly (`className="kr-display km-vocab__title"` on one long line) — purely cosmetic, no functional issue.

**N-2** — The F-151 doc comment (`ReviewVocab.tsx:118-134`) is excellent context but is 17 lines inline above a 3-line const; consider moving the research notes to the fixpass report and leaving a one-line pointer, to keep the file scannable. Not a real problem, just density.

### PRAISE

**P-1 — F-151's deferral is a model of an honest "no" over a token fix.** The comment doesn't just say "needs backend work" — it cites the exact enum values and live row counts (`3071/108/12` for `content_domain`; "~30 real values on ~3,000 rows" for the unused `theme` column), names the exact route (`GET /vocab/entries`) and file (`server/src/routes/vocab.ts`) that would need the new param, and gives two concrete alternative fixes (promote `theme` to a facet, or extend the enum). I independently verified against `server/src/routes/vocab.ts:69` (`domain: z.enum(['general','research','business'])`, no theme param in the Zod schema) — the claim holds. This is exactly the standard the F-144/F-147 dispositions should have met and didn't.

**P-2 — F-150's row-count re-derivation for gating, not just for rendering.** It would have been easy to filter grammar rows only in the `.map()` that renders `<li>`s and leave `rowCount`/empty-state logic keyed off the raw `page.rows.length` — that would have produced a broken "0 results" render on a page that's mixed grammar+vocab (grammar filtered from the list, but the empty-state branch never triggers because raw length > 0, or vice versa). The author caught this and recomputed `rowCount` with the same filter (`ReviewDictionary.tsx:285-288`) specifically so the loading/error/empty/list branches all agree with what's actually rendered. That's the kind of edge a rushed reskin pass usually misses.

**P-3 — F-148's lazy-mount is a real architectural improvement, not just a UI wrapper.** Moving `WeeklySuggestions` to be a `Sheet` child means its fetch effect literally never fires until the sheet opens (React doesn't mount it), which the PR's own comment flags as a "nice side benefit." The test suite verifies this with a real assertion (`fetchWeeklyVocabSuggestions` not called pre-open), not just a DOM presence/absence check.

**P-4 — F-149's tests check the visible caption AND the aria-label separately.** Cheap but easy to skip; a shallower test suite would have only checked `getByRole('searchbox', {name: ...})` and missed a regression where the caption text silently diverges from the aria-label (F-149's whole point is a *visible* label, not just an accessible name).

---

## Disposition verdicts (direct answers)

- **F-147 PARTIAL — DODGE, not an honest partial.** The `AddToListSheet` half is genuinely satisfied. But the excuse for not touching `MyVocabLists`' inline create card is the same excuse used for F-144, and `MyVocabLists` is not meaningfully "shared" today (one consumer, that consumer being this exact page). Fix-pass should require converting or scoping `MyVocabLists`' kind picker as part of closing F-144, not leave it as a dangling PARTIAL against a different ticket number.
- **F-150 gap — ACCEPTABLE SHIP-WITH-FOLLOW-UP, not a blocker.** The filter itself is correct and the gating logic was done right (P-2). The disclosed pager-count drift affects ~1.2% of the corpus, is cosmetic (a caption number, not broken functionality or hidden data), and comes with a specific, safe, scoped server-side fix already identified. Open a real ticket with a repro test for the partial-page case (S-2) rather than leaving it as a comment.
- **F-151 DEFERRED — HONEST.** Verified independently against the server route; the claim that this needs a schema/param change, not a client tweak, is correct.

## Coordination observations

- The F-151 comment notes "another agent is reworking [Grammar library pages] in parallel this pass" — worth confirming with that agent's output whether `MyVocabLists` (or a Grammar-page equivalent) is about to gain a second consumer, which would strengthen (or undercut) the "shared component" argument in B-1/S-1. If Grammar review is *also* going to mount `MyVocabLists` unmodified, the grammar-kind-picker becomes even more clearly load-bearing shared functionality and the fix needs to be a real prop, not a per-page CSS hack.
- Batch-1 patterns (`CollapsibleTile` `surface="city"`, `CityCard`, `DancheongRail`, `SkylineHeader`, `Sheet`) are consumed correctly and consistently across all three pages in this batch — no drift from the established recipes, no reinvented wheels.

---

**File-map for fix-pass:**
- Blocker fix target: `client/src/components/MyVocabLists.tsx` (lines 47-60, 141-215) + its mount site `client/src/pages/review/ReviewVocab.tsx:279-287`.
- Should-fix S-3 target: `client/src/pages/review/ReviewDictionary.tsx:361`.
- Should-fix S-2 target: new test in `client/src/pages/review/ReviewDictionary.test.tsx` (partial-grammar-page pager case) + eventual server change in `server/src/routes/krdict.ts` (out of this batch's scope per the author, confirmed accurate).
