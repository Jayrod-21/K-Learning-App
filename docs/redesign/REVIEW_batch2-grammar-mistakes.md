# Independent review — Library → Grammar (`ReviewGrammar`) + Mistakes rework

**Reviewer:** independent senior React/TS reviewer (did not write this code).
**Scope:** F-128 (reskin), F-152 (Bank→Mastered), F-153 (15-at-a-time), F-154
(square tiles + popup) as shipped on `feat/redesign-library` @ 2c2d4ad.
**Files:** `client/src/pages/review/ReviewGrammar.{tsx,css,test.tsx}`,
`client/src/pages/Mistakes.{tsx,css,test.tsx}`.
**Method:** read `DESIGN_SEOUL_DAY_NIGHT.md`, `BUGS_AND_FEATURES.md` (F-128/
F-152/F-153/F-154), the km-final.html Grammar/Mistakes mock, the full diff vs
`rebuild`, the full current files, the consumed batch-1 primitives
(`CityCard`, `SealStamp`, `Sheet`, `usePagination`, `ShowMore`,
`CollapsibleTile`), the server bank/graduate contract
(`server/src/routes/grammar.ts`), and ran `tsc --noEmit`, `eslint`, and the
two test files (39/39 pass). No code changes made.

## Verdict: **PASS WITH FINDINGS** (1 BLOCKER carried/corroborated, 1 BLOCKER-grade semantic finding, several SHOULD-FIX)

Engineering quality is genuinely high: strict TS, real optimistic-update
tests, no hardcoded hex in either page's CSS, `tsc`/`eslint` clean, and the
F-154 popup wiring is provably index-free (see the explicit verdict below).
F-153's pagination math and reset-on-filter-change behavior are correct and
well tested. The rework does **not**, however, fully clear the bar on two
fronts: (1) a pre-existing, already-tracked BLOCKER (missing `SkylineHeader`
on both pages — corroborated independently below) and (2) a **new** finding
this review surfaces — the F-152 "Mastered" relabel is applied to an action
that still only means "added to my bank," while the app already has a real,
wired mastery signal (`graduated_at` / the Grammar-practice screen's
Learning↔Known split) that this rework silently discards. That is a
user-facing false claim, not just a copy nit.

## Ticket checklist

| Ticket | Verdict | Notes |
|---|---|---|
| F-152 Bank→Mastered | ⚠️ **Shipped as literally specified, but semantically questionable** | See "F-152 deep dive" below. |
| F-153 15-at-a-time | ✅ **PASS** | Correct math, correct reset-on-filter, real tests, no perf risk at ~370 rows. |
| F-154 square tiles/popup | ✅ **PASS, with one test-quality gap** | Popup-correctness is provably right by construction; the test suite doesn't quite prove it (see below). |
| F-128 reskin (these 2 pages) | ⚠️ **Mostly compliant, 1 corroborated BLOCKER + 1 SHOULD-FIX** | Devices #1/#2/#3/#6/#7/#8/#9 present and token-driven; device #4 (SkylineHeader) is absent on both pages — already flagged in `REVIEW_batch2-fidelity.md`, independently reconfirmed here. |

---

## F-154 popup-correctness verdict (explicit)

**Yes — the tapped tile maps to the right question, by construction, not by
luck.**

`MistakeQuestionTile` (`client/src/pages/Mistakes.tsx:159-181`) receives the
actual `mistake: Mistake` object as a prop (not an array index), and its
`onClick` closes over that exact object: `onClick={() => { onOpen(mistake); }}`
(`Mistakes.tsx:172-174`). `MistakeSessionGroup` maps tiles with
`key={m.responseId}` over `session.mistakes` (`Mistakes.tsx:208-210`) — no
index is ever threaded through. The page-level `openMistake` state
(`Mistakes.tsx:412`) is set directly to that object, and
`MistakeSheetBody` is keyed by `openMistake.responseId`
(`Mistakes.tsx:521`), so switching between two different tiles remounts the
sheet body fresh (its `showExplanation` reveal state can't leak between
questions). There is no lookup-by-index anywhere in this path that a future
edit could silently desync — the "index mismatch" failure mode the task
asked me to probe for does not exist in the shipped code.

**However, the test suite doesn't fully prove this.** The only test that
opens a tile and asserts the Sheet's *content* (`Mistakes.test.tsx:202-235`,
"tapping a tile opens the Sheet popup...") uses a single-mistake fixture —
there is exactly one tile to tap, so the test can't distinguish "opened the
right mistake" from "opened whichever mistake happens to exist." The one
test with two tiles in the same visible group
(`Mistakes.test.tsx:263-293`, "multiple same-day same-mode misses merge
into ONE session option") only asserts **DOM order** via
`compareDocumentPosition` (line 284-288) — it never opens the second tile
(`questionTile(20)`) and checks the Sheet shows *that* item's prompt
(`'빈칸에 알맞은 말을 고르십시오.'`) rather than the first's
(`'알맞은 것을 고르십시오.'`). **A regression that swapped the per-tile
mapping for an index into `session.mistakes` (e.g. `session.mistakes[i]`
captured by loop variable, or a `.find` keyed on the wrong id) would not be
caught by this suite.** SHOULD-FIX: add one assertion, tapping the second
tile in a two-item group and asserting the Sheet shows the second item's
distinguishing prompt text, not the first's.

---

## F-152 deep dive: is "Mastered" honest?

**Short answer: no, not as shipped, and the gap is provable from the code
the rework itself touched.**

The ticket text (`BUGS_AND_FEATURES.md:1502-1503`) is narrow: *"F-063
reworked the model but 'Bank/banked' labels persist; replace with a
Mastered button + mastery labeling."* The builder's own docstring
(`ReviewGrammar.tsx:24-26`) is explicit that this was treated as a pure
rename: *"the underlying model/endpoints are untouched, F-063 already
reworked those."* That's the problem — F-063 **did** build a real mastery
model (grammar practice's Learning↔Known split, backed by
`graduated_at` + FSRS `production` cards — see
`server/src/routes/grammar.ts:232-235` and the sibling screen
`client/src/pages/Grammar.tsx:11,549,609,680-699,840-841`), and this rework
had that exact signal available on the wire and threw it away:

- `GET /grammar/bank` already returns `graduated_at: string | null` per row
  (`client/src/types/domain.ts:1275`) — non-null means genuinely graduated
  ("known"/mastered in the app's own established vocabulary); null means
  merely banked/still-learning.
- `ReviewGrammar.tsx:163-181` flattens **every** returned entry's
  `pattern_key` into one `mastered` `Set<string>`, discarding
  `graduated_at` entirely:
  ```
  setMastered((prev) => {
    const merged = new Set(prev);
    for (const e of res.entries) merged.add(e.pattern_key);
    return merged;
  });
  ```
- `markMastered` (`ReviewGrammar.tsx:218-247`) is a single call to
  `grammarService.bankPattern` (`POST /grammar/bank` —
  `server/src/routes/grammar.ts:187-227`), which only ever inserts/upserts a
  `grammar_entries` row. It never touches `graduate`/`readmit`. A pattern
  with **zero drill history** (`card_state: null`, per the server's own
  comment at `grammar.ts:257-260`: *"null when the pattern has never been
  drilled... an honest 'not started'"*) flips to the "Mastered" chip
  (`PatternRow`, `ReviewGrammar.tsx:402-412`) and the `SealStamp`
  milestone badge the instant the user taps once.

So the literal user-visible claim — a milestone stamp reading "Mastered" /
"이미 숙달됨" (`ReviewGrammar.tsx:407-412`, `:777-783`), with
`aria-pressed="true"` and `aria-label="Already mastered"`
(`ReviewGrammar.tsx:398-401`) — fires on "I added this to my list," not on
"I have demonstrated mastery," while the app's own sibling screen
(`Grammar.tsx`) already has a real, working definition of "mastered" (=
graduated, retired from the drill pool) that this page had direct wire
access to and did not use. That is a materially false, persistent,
accessibility-visible claim ("Already mastered" is literal screen-reader
text), not a cosmetic label choice — I'm treating it as **BLOCKER-grade**
even though the code faithfully executes the literal ticket text, because
the review brief specifically asked me to judge semantic honesty rather
than ticket-literalism, and a user who has tapped one button is told they
have mastered a piece of Korean grammar they have never once drilled.

This is a design/product decision more than an engineering bug, so I'm not
recommending a code fix be improvised unilaterally — but it should go back
to whoever owns `DESIGN_SEOUL_DAY_NIGHT.md`/F-152 before this ships. Two
honest paths forward: (a) keep this action as "add to bank"-flavored copy
("Add to practice" / "Study this" / "In my list") and reserve "Mastered" for
`graduated_at !== null`, rendering a genuine three-state chip (unbanked →
"Learning"/banked → "Mastered"/graduated) that would also better match the
km-final.html mock's THREE pill states (`Mastered` / `Learning` / `Known` on
three different rows in the same screen — `km-final.html:153-155`), which
the shipped page never reproduces (it only ever renders two states: "Mark
mastered" or "Already mastered" — "Learning"/"Known" text never appears on
this screen at all); or (b) if "Mastered" is deliberately meant as "you've
chosen to actively study this" (a defensible but different meaning), the
in-app copy elsewhere (aria-label, SealStamp label, docstring) should not
use language ("Already mastered," a milestone 印 stamp) that unambiguously
signals achievement/completion.

Wiring integrity, separately, **is correct**: `bankPattern`/`listBanked`
still point at the right endpoints, the 409-as-success and rewind-on-500
paths are intact and tested (`ReviewGrammar.test.tsx:432-470`), and no
"Bank"/"Banked" user-facing string survives (`grep` clean — confirmed
across both `.tsx`/`.css` files; only internal identifiers
`bankPattern`/`listBanked`/`kgiuBankBody` remain, none of which render).

---

## F-153 — 15-at-a-time: PASS

- `usePagination(rows, { initial: 15, step: 15, max: Infinity })`
  (`ReviewGrammar.tsx:435-439`) is the shared, already-fixpass'd primitive
  (`client/src/hooks/usePagination.ts`). With `max: Infinity`,
  `limit = Math.min(Infinity, items.length) = items.length` — the cap
  simply becomes "the whole list," which is exactly the intended override
  of the primitive's default 30-row ceiling for this ~370-row corpus. No
  arithmetic risk (`Math.min`/`Math.max` handle `Infinity` cleanly; no
  `NaN`/overflow path).
- Filter-change reset is real, not simulated: `GrammarBrowse` keys
  `<PatternList key={`${level}:${source}`} .../>` (`ReviewGrammar.tsx:565`),
  which **remounts** `PatternList` (and therefore its internal
  `usePagination` `useState`) on any level/source change — confirmed by
  the passing test `ReviewGrammar.test.tsx:743-767` ("a filter change
  resets the window back to 15").
- Perf at ~370 rows with repeated "Show more": no concern. `usePagination`
  clamps at render via `slice`, not accumulation; each click renders at
  most `items.length` `CityCard` rows, which is small for a mobile list
  even fully expanded.
- `ShowMore` is present and correctly wired (`ReviewGrammar.tsx:447-451`),
  including its focus-catch-on-exhaustion behavior (unmodified shared
  component, already covered by its own tests).
- One real gap: `PatternList` is reused for `GrammarUploads` group rows
  (`ReviewGrammar.tsx:693-699`) **without** a filter-keyed reset, which is
  fine today (Uploads has no filter to reset against), but is worth a
  one-line comment if F-108 (upload-tagged grammar) later adds a filter
  there — flagging only so it doesn't get missed later, not a defect now.

---

## F-128 reskin — findings

**Corroborates `docs/redesign/REVIEW_batch2-fidelity.md`** (an earlier,
broader design-fidelity pass over all 6 Library pages). I independently
re-verified its two headline claims against these two files specifically:

- **BLOCKER (corroborated) — no `SkylineHeader` on either page.**
  `ReviewGrammar.tsx:256` and `Mistakes.tsx:425` both render the flat
  `Topbar`, not `SkylineHeader`. Independently confirmed: `grep -l
  SkylineHeader client/src/pages/**/*.tsx` returns `ReviewDictionary.tsx`,
  `ReviewVocab.tsx`, `Progress.tsx`, `Today.tsx`, `ReviewLibrary.tsx`,
  `UploadViewer.tsx`, `Uploads.tsx` — 7 sibling screens — but not these two.
  Device #4 ("an SVG skyline strip at the top of ... major landings") is a
  named non-negotiable in `DESIGN_SEOUL_DAY_NIGHT.md` §4/§8, and both
  `km-final.html` and `km-prototype.html` render every mocked screen under
  the shared `.skyhdr` strip. This is real, user-visible drift (Library →
  Vocab has a skyline hero; Library → Grammar, one tab over, has a flat
  sticky bar), not a documentation nit.
- **SHOULD-FIX (corroborated) — Mistakes hand-rolled its own Sheet body
  classes.** `Mistakes.css:104-142` defines
  `.km-mistakes__sheetBody`/`__sheetHead`/`__when` from scratch, while
  `ReviewGrammar.tsx:740` (`GrammarDetailSheet`) consumes the shared
  `.km-review__sheetBody`/`__sheetHead`/`__sheetTitle`/`__sheetRule`
  classes already used by `ReviewVocab`. Same `Sheet` primitive, same
  interaction, visibly different header hierarchy/padding across two
  Library popups in the same navigation flow.

**What IS done well and matches the doc (independently verified, not just
re-stated):**

- **No hardcoded hex.** `grep -n '#[0-9a-fA-F]\{3,8\}'` over both
  page-scoped CSS files returns nothing. The two pre-existing fallback
  hardcodes the docstring claims were fixed
  (`var(--danger, #b3261e)` → `var(--danger-ink)`; `var(--paper-line,
  rgba(0,0,0,.08))` → `var(--ink-2)`) are confirmed gone in the diff
  (`Mistakes.css` diff hunk 1) and no new ones were introduced.
- **Device #1/#2 (CityCard + DancheongRail).** Both pages use `CityCard
  rail` correctly: per-pattern rows in Grammar (`ReviewGrammar.tsx:368-372`,
  tone flips `mint`/`plain` by mastery state) and per-session groups in
  Mistakes (`Mistakes.tsx:198-201`, `tone="plain"`).
- **Device #7 (SealStamp) and #9 (najeon)** are used exactly per the doc's
  own named use cases — `milestone` stamp for "a mastered item"
  (`ReviewGrammar.tsx:407-412`), `km-najeon` reserved for the single modal
  instance only, not per-row (`ReviewGrammar.tsx:782`) — matching
  Progress's precedent for sparing use of the "jewel."
- **Devices #3/#6 (giwa + hangul watermark)** on both empty states
  (`ReviewGrammar.tsx:663-665` "문법"; `Mistakes.tsx:451-453` "복습"),
  correctly implemented as CSS `content: attr(data-glyph)` —
  `aria-hidden` is implicit (never in the accessibility tree) per
  `seoul-devices.css:80-95`.
- **Device #8 (rain-sheen)** applied to both page roots
  (`ReviewGrammar.tsx:253`, `Mistakes.tsx:416`) as the ambient,
  Night-only, pointer-events-none overlay; correctly gated by
  `[data-theme="dark"]` in `seoul-devices.css:36-38`.
- **Touch targets.** Mistakes' new `.km-mistakes__qtile`
  (`Mistakes.css:79-102`) is explicitly `min-width/min-height: 44px` —
  genuinely compliant, real new code doing the right thing. (ReviewGrammar's
  row action `Button size="sm"` is `padding: 6px 10px` /
  `font-size: 12px` — `styles/index.css:836` — well under 44px, but this is
  the **same, pre-existing** `Button` size class the old "Bank" button
  already used; this batch didn't touch button sizing, so I'm not counting
  it against this diff, just flagging it as inherited debt worth a NIT.)
- **WCAG AA contrast**, spot-checked the new danger tile colors: Day
  `--danger-ink #AB4129` on `--danger-soft #F3E0D6` ≈ 4.68:1; Night
  `--danger-ink #FF6B8A` on `--danger-soft #2C1420` ≈ 6.3:1. Both clear
  4.5:1 for the ~13.6px tile numerals.
- **Reduced-motion**: no page-specific motion was added by this batch; the
  reused utilities (`km-rain-sheen`, `km-najeon--shimmer`) already gate
  correctly (`seoul-devices.css:60-64`).
- **`tsc --noEmit`** across the whole client: clean. **`eslint`** on both
  changed files: clean. **Tests**: both files, 39/39 pass
  (`vitest run src/pages/Mistakes.test.tsx
  src/pages/review/ReviewGrammar.test.tsx`).

## Detailed findings (file:line)

**BLOCKER**
1. `ReviewGrammar.tsx:163-181`, `:218-247`, `:402-412`, `:777-783` — F-152
   "Mastered" fires on bank-add, not on the app's own real mastery signal
   (`graduated_at`, already on the wire per `domain.ts:1275` and
   `server/src/routes/grammar.ts:232-235`). Materially misleading,
   `aria-label`-visible claim. See "F-152 deep dive" above.
2. `ReviewGrammar.tsx:256`, `Mistakes.tsx:425` — no `SkylineHeader`; device
   #4 missing on both pages while 7 sibling Library/Wave-2 pages have it.
   Corroborates `REVIEW_batch2-fidelity.md`'s B1.

**SHOULD-FIX**
3. `Mistakes.test.tsx:263-293` (and the whole F-154 test block) — no test
   opens a *second* tile in a multi-tile group and asserts the Sheet shows
   that tile's distinguishing content. The current suite would not catch
   an index-based regression in the tile→Sheet mapping. Add one assertion
   using `MISTAKE_SAME_SESSION`'s prompt text.
4. `Mistakes.css:104-142` vs `ReviewGrammar.tsx:740` — Mistakes' Sheet body
   uses page-rolled classes instead of the shared `.km-review__sheet*`
   set ReviewGrammar and ReviewVocab both use. Corroborates
   `REVIEW_batch2-fidelity.md`'s S2.
5. `ReviewGrammar.tsx:367` — `<li className="km-review-grammar__rowItem">`
   has no matching rule anywhere in `ReviewGrammar.css` (only
   `.km-review-grammar__row`/`-open`/`-kr`/`-en`/`-level`/`-action` exist).
   Harmless today (the `<ul>` already zeroes list styling and the flex
   `gap` on the parent handles spacing), but it's a dead/typo'd class name
   a future edit could mistake for a real styling hook.

**NIT**
6. `styles/index.css:836` (`.km-btn--sm`) — the Grammar row's "Mark
   mastered" action button is well under a 44px touch target. Pre-existing
   (unchanged by this diff — the old "Bank" button used the same size),
   not a regression, but worth a follow-up ticket given the design brief's
   own "touch targets ≥ 44px" non-negotiable.
7. `Mistakes.tsx:198-206` — `CityCard`'s `aria-labelledby` (forwarded via
   `...rest` onto a plain `<div>` with no `role`) likely has little to no
   effect on the accessibility tree, since `aria-labelledby` only reliably
   computes a name for elements with an ARIA role. The visible `<p>`
   divider and the `<ul aria-label={session.label}>` (`Mistakes.tsx:207`)
   already carry the real accessible labeling, so this is redundant rather
   than broken — not worth a special trip, just noting for anyone auditing
   `CityCard`'s a11y contract generally.

**PRAISE**
- `Mistakes.tsx:159-181` — the tile→mistake wiring is genuinely
  index-free-by-construction; a careful, correct choice that a lazier
  implementation (rendering by `.map((m, i) => ...)` and closing over `i`)
  would have gotten wrong.
- `ReviewGrammar.test.tsx:697-768` — the F-153 pagination tests are real
  assertions (exact accessible names appearing/disappearing across a
  "Show more" click and a filter change), not just count checks; they
  would catch a broken window or a non-reset filter.
- `usePagination`'s `max: Infinity` override and the filter-keyed
  `PatternList` remount are both clean, minimal, well-reasoned uses of an
  already-hardened shared primitive — no bespoke pagination logic was
  reinvented for this page.
- Grep-clean of user-facing "Bank"/"Banked" copy — the rename itself was
  executed thoroughly (this is separate from whether the *new* word choice
  is honest, per the BLOCKER above).

## Coordination observations

- This review's two BLOCKER/SHOULD-FIX findings on F-128 (missing
  `SkylineHeader`, non-shared Sheet classes) were **already caught and
  filed** by an earlier, broader design-fidelity pass
  (`docs/redesign/REVIEW_batch2-fidelity.md`, headlines #1 and #3). I
  reverified both independently against these two files' current line
  numbers rather than taking that report on faith; both hold. Whoever runs
  the fix-pass for this batch should treat that report and this one as
  covering the same two structural gaps from different angles — no need
  to re-derive them a third time.
- The F-152 semantic-honesty finding in this review is **new** — it was
  outside that report's design-fidelity lens (which checks *devices
  present/tokens/consistency*, not *does the label lie*) and outside
  F-152's own ticket text (which asked for a rename, not a model change).
  It should be routed back to product/design (whoever owns
  `BUGS_AND_FEATURES.md` F-152) rather than silently patched by a fix-pass
  agent, since the right fix depends on a product decision (three-state
  chip vs. different verb) that isn't mine to make unilaterally.
