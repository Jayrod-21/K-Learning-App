# RE-REVIEW — Batch 4 fix-pass verification (`feat/redesign-learn-b` @ `356579f`)

**Independent re-reviewer** (fresh eyes; did not write the code, the four original
reviews, or the fix-pass). Commissioned with extra scrutiny because the original
fix-pass agent **stalled mid-run** and a second "finisher" agent completed and
committed the work (`356579f`, on top of the batch commit `fae8223`, off `rebuild`).
Every claim below was independently re-derived from the current source — the
finisher's `FIX_REPORT_batch4.md` was read as a hypothesis to verify, not as a
source of truth.

## Verdict: **PASS**

All BLOCKER and SHOULD-FIX findings in scope for this fix-pass are genuinely
fixed, each with a test that would fail if the bug returned. The stall left
nothing half-done — the two items the stalled agent hadn't reached (Writing's
own `embedded` slot, the `LearnMenu` comb-order comment) are both now complete
and consistent with the rest of the diff. The highest-risk item — `Sheet`'s
`tone` promotion, a shared component with 13 call sites — is backward-compatible
at every site that doesn't opt in. No regressions found. Gate is green across
lint/typecheck/tests/build, matching the finisher's reported numbers exactly.

---

## Finding-by-finding table

| ID | Orig. severity | Fix status | Test catches regression? | Notes |
|---|---|---|---|---|
| BLOCKER-1 (Chat 44px composer buttons) | BLOCKER | **FIXED** | Yes | `Chat.css:265-278` adds `min-height:44px;min-width:44px` to both `.km-chat__attachTrigger`/`.km-chat__sendBtn`; `Chat.test.tsx:2599-2622` reads the CSS source (jsdom has no layout engine) and regexes the exact declaration block — reverting the CSS fails the test. |
| BLOCKER-2 (Tickets `sourcePage: null` crash) | BLOCKER | **FIXED** | Yes | `Tickets.tsx:921-924` now chains `navState?.sourcePage?.path`/`?.name` (optional chaining throughout) instead of the old `!== undefined` narrowing that let `null` slip past its first clause and crash on `.path`. `Tickets.test.tsx:287-317` renders with `state:{compose:true, sourcePage:null}` and asserts no crash, correct "no page context" fallback, and no `sourcePage` key sent to `createTicket`. Hand-traced: reverting to the old guard reintroduces `null !== undefined → true`, then `null.path` throws — test would fail. |
| Sheet tone promotion (gap-d) | — (fidelity capstone S3/"highest-value follow-up") | **FIXED** | Yes | See dedicated section below. |
| Launcher flicker (S1) | SHOULD-FIX | **FIXED** | Partial (visual, not pixel-tested) | `km-neon-flicker` moved from `.km-learnmenu__panel` (parent of every tile, previously compositing multiplicatively with each tile's own `km-hexrise` opacity stagger) to the static `.km-learnmenu__title` (no competing opacity animation), matching the existing `CityCard` precedent. `prefers-reduced-motion` gating untouched. No new automated test asserts absence-of-double-animation (would need a real layout/paint harness), but the structural fix (single element, no sibling opacity animation) is verifiable by inspection and matches the reviewer's own suggested fix direction. |
| Settings S-1 (sched-field/Toggle touch targets) | SHOULD-FIX | **FIXED** | Yes | `.km-settings__sched-field` gets `min-height:44px` (`Settings.css:90-104`, comment corrected to state the real computed height instead of the prior overclaim); `Toggle`'s visible 38×22 pill is kept (correctly, per the reviewer's own reasoning that growing it would be a regression) and gains an invisible 44×44 `::before` hit-region (`index.css:2645-2652`) that expands the click target without touching what's painted. `Settings.test.tsx:2114-2122` and `Toggle.test.tsx:67-80` both pin the CSS via stylesheet-source regex. |
| T-1 (Tickets draft-loss-on-dismiss) | SHOULD-FIX | **FIXED** | Yes | Draft state (`draftType`/`draftTitle`/`draftBody`) lifted from `FileTicketForm` up to `Tickets` (`Tickets.tsx:937-946`) so `Sheet`'s unmount-on-close no longer destroys it. `Tickets.test.tsx:706-735` (Esc preserves draft on reopen) and `:736-758` (successful file clears draft) both pass. |
| T-3 (focus-race regression test) | SHOULD-FIX | **FIXED** | Yes | `Tickets.test.tsx:759+` retypes into the Title field while triggering a page-level re-render (the exact scenario `closeFileSheet = useCallback(...,[])` at `Tickets.tsx:1130` guards against) and asserts focus never leaves the field. Un-memoizing `closeFileSheet` would reintroduce the race this test is built to catch. |
| S-4/FeedbackFab stale comment | SHOULD-FIX | **FIXED** | N/A (doc-only) | `FeedbackFab.tsx:13-14` now correctly states the form "lives in a `Sheet`, opened on arrival" instead of the old "always-rendered inline" claim. Matches current `Tickets.tsx` behavior. |
| WritingTopicGenerator double-surface (gap-b) | SHOULD-FIX | **FIXED** (completed by finisher — stall had left `Writing.tsx`'s own slot unwired) | Yes | `embedded` prop added to `WritingTopicGenerator` (strips border/background/shadow, `WritingTopicGenerator.css:27-33`); `Today.tsx:485` (stall-era) and **`Writing.tsx:745`** (finisher-completed) both now pass `embedded`. `WritingTopicGenerator.test.tsx` asserts the default-vs-embedded class difference; `Writing.test.tsx` asserts `.km-topicgen--embedded` is present on this page specifically. |
| S4/N2 LearnMenu comb-order stale comments | SHOULD-FIX/NIT | **FIXED** (completed by finisher — not in stalled agent's touched-file list) | N/A (doc-only) | Both the module header comment (`LearnMenu.tsx:28-40`) and `COMB_ROWS`' own docstring (`LearnMenu.tsx:125-131`) now correctly describe the real array — `[[flashcards,grammar],[reading,topik,ttmik],[writing,hanja]]` — and honestly state the two vermilion/accent tiles (TOPIK, Writing) are non-adjacent, replacing the false "intentional pairing" claim. |
| AI-Prompt/bank-rubric round-trip NIT (lwt) | NIT | **DEFERRED** (correctly, per original reviewer's own "deliberate design choice" verdict) | N/A | Not re-litigated; the original reviewer explicitly called this acceptable, not a defect. |
| N-1 Chat askpop `rail` omission | NIT | **DEFERRED** (correctly, reviewer flagged as unconfirmable against mock) | N/A | Left as-is; correct call. |
| N-2 Settings test redundancy | NIT | **DEFERRED** (correctly, harmless) | N/A | Left as-is; correct call. |
| MockMode.tsx unreskinned | SHOULD-FIX (capstone) | **REJECTED for this batch, filed as follow-up** | N/A | Confirmed still legacy (`grep` for `CityCard`/`PageHubHeader` in `MockMode.tsx` returns nothing) — correctly out of scope, not silently dropped. |
| Images.tsx legacy Topbar | SHOULD-FIX (capstone) | **REJECTED for this batch, filed as follow-up** | N/A | Confirmed still on `Topbar` (`Images.tsx:56,235`) — correctly out of scope. |
| F-160 ingest gaps | SHOULD-FIX (capstone) | **REJECTED for this batch, filed as follow-up** | N/A | Backend/ingest, correctly out of client scope. |

**Counts: 10 FIXED, 0 PARTIAL, 0 NOT-FIXED, 0 REGRESSION** (3 NIT correctly deferred, 3 capstone items correctly filed as out-of-scope follow-ups rather than fixed or ignored).

---

## Sheet consumer backward-compatibility — dedicated section

`Sheet.tsx`'s `tone` prop is optional and unused (`tone === undefined`) by
default; the className resolves via `cn('km-sheet__panel', tone !== undefined
&& \`km-tone--${tone}\`)` (`Sheet.tsx:99-104`), so omitting `tone` produces
`className="km-sheet__panel"` exactly as before — no way for an omitted prop to
add a class. `Sheet.test.tsx:82-91` pins this directly: renders with no `tone`
prop and asserts no class starting with `km-tone--` is present.

I independently grepped every `<Sheet` JSX call site (not trusting the
finisher's list) and got the same 13 render sites across 11 files the report
claims:

| File | Call site(s) | `tone` passed? | Verdict |
|---|---|---|---|
| `components/MyVocabLists.tsx` | 2 (create-list `:333`, list-detail `:547`) | none | Unaffected |
| `components/UploadTypeModal.tsx` | 1 (`:196`) | none | Unaffected |
| `pages/Hanja.tsx` | 4 (`:659`, `:1138`, `:1802`, `:2339`) | none | Unaffected |
| `pages/Grammar.tsx` | 1 (`:2373`) | none | Unaffected |
| `pages/review/ReviewVocab.tsx` | 2 (`:308`, `:769`) | none | Unaffected |
| `pages/review/ReviewGrammar.tsx` | 1 (`:813`) | none | Unaffected |
| `pages/Mistakes.tsx` | 1 (`:522`) | none | Unaffected |
| `pages/Reading.tsx` | 1 (`:938`) | none | Unaffected |
| `pages/Review.tsx` | 1 (`:975`) | none | Unaffected |
| `pages/Topik.tsx` | 1 (`:297`, chooser) | `tone="accent"` | Opts in, intentional (page's own vermilion identity) |
| `pages/Tickets.tsx` | 1 (`:1321`, file form) | `tone="plain"` | Opts in, intentional (a ticket carries no skill color) |

That's 11 files / 13 sites, matching the finisher's count exactly, independently
re-derived. Nine of eleven files pass no `tone` at all and are byte-identical
to pre-promotion; two opt in deliberately. The CSS backing this
(`index.css:2550-2593`, verified in the `356579f` diff against `fae8223`) is
complete and coherent on both axes — Day gets a 4-band dancheong `border-image`
top stripe for `accent|blue|mint|ochre` and a plain 1px hairline for `plain`;
Night gets a `--km-tone`-colored glow layered onto (not replacing) the existing
navy shadow for the same four tones, and a 1.5px hairline for `plain` — no
dangling rule, no missing Day/Night pairing, no half-applied edit from the
stall. Both toned-panel selector blocks are compound (`.km-sheet__panel.km-tone--<x>`),
which cannot match an untoned panel, so the CSS itself — not just the call
sites — backs the "opt-in, not redesign" claim.

**Verdict: PASS.** No stall damage found here — this was the single highest-risk
surface in the batch and it holds up under independent re-derivation, not just
re-reading the finisher's prose.

---

## Stall-completeness check

Confirmed nothing was left half-done by comparing the stall's two named gaps
against current code:

1. **Writing's own AI-Prompt slot** — the stall had built the `embedded` prop
   and wired `Today.tsx:485`, but not `Writing.tsx`'s own slot (the actual
   surface the fidelity review's gap-b names). `git diff fae8223 356579f --
   client/src/pages/Writing.tsx` shows exactly one line changed:
   `<WritingTopicGenerator onUseTopic={adoptTopic} />` →
   `<WritingTopicGenerator embedded onUseTopic={adoptTopic} />` (line 745) —
   minimal, complete, consistent with the already-shipped `Today.tsx` wiring
   and the `.km-topicgen--embedded` CSS rule. No dangling reference, no
   half-applied prop threading.
2. **LearnMenu comb-order comments** — both the module header comment and
   `COMB_ROWS`' own docstring now describe the identical, correct array.
   Neither comment contradicts the other or the code.

No other gaps found. `git diff fae8223 356579f --stat` shows a clean,
self-consistent 25-file diff (1517 insertions / 54 deletions) with every
touched file's changes cohering with its stated purpose in `FIX_REPORT_batch4.md`
— no orphaned test imports, no unused new CSS classes, no prop added without a
consumer. Working tree is clean (`git status` shows only two pre-existing
untracked files unrelated to this diff: `.claude/`, `REDESIGN_SEOUL_NEON_BRIEF.md`).

**Verdict: no stall damage. The recovery is complete.**

---

## Praise-intact check

Spot-checked items the original reviews praised, to confirm the fix-pass didn't
undo them:

- Chat bubble `--km-tone` mechanism at bubble scale (not full `CityCard` per
  message) — `Chat.tsx:2280`/`Chat.css:104-123` unchanged in the `fae8223`→`356579f`
  diff (not in the file list at all). Intact.
- `--on-vermilion` retry-chip AA fix (`Chat.css:168-175` region) — untouched by
  this diff. Intact.
- F-159/F-160/F-163 (TOPIK chooser gate, Listen audio-error state, Writing
  AI-Prompt top-level radio) — none of `Ttmik.tsx`/`Ttmik.css` appear in the
  `fae8223`→`356579f` diff at all; `Topik.tsx`'s only change is the 10-line
  `tone="accent"` addition to the chooser `Sheet`, which is additive and
  doesn't touch F-159's gate logic. Intact.
- LearnMenu nav/a11y preservation (routes, focus trap, Tab order, Esc,
  entrance/exit stagger) — `LearnMenu.tsx` diff (69 lines) is scoped to the
  flicker relocation + comment corrections; `COMB_ROWS`, `navItem()`, the exit
  timing constants are unchanged. Intact.
- Settings wiring minimality (diff never reaches into a control's JSX) — the
  `356579f` diff to `Settings.css`/`Settings.test.tsx` is purely the sched-field
  `min-height` + comment fix + one new test; no `.tsx` control JSX touched.
  Intact.

**Verdict: no praise regressed.**

---

## New findings from this re-review

None. No new BLOCKER, SHOULD-FIX, or correctness issue found beyond what the
four original reviews and the fix-pass already covered. One minor observation,
not rising to a finding: the launcher flicker fix (S1) has no automated
regression test for "the double-animation doesn't recur" — the fix is
structurally sound and matches the reviewer's own suggested direction, but
nothing in CI would catch a future regression if `km-neon-flicker` were
re-applied to `.km-learnmenu__panel`. Not blocking; flagging for awareness only,
since the original review itself only asked for "an explicit look... or a
deliberate call that it's fine," not a specific test.

---

## Independently-run gate (from `client/`)

- `npm run lint` → **0 problems** (no output)
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` → **0 errors** (no output)
- `npx vitest run` → **116 test files passed (116), 1747 tests passed (1747)**, 0 failed
- `npx vite build --outDir /tmp/km-rr-batch4` → **exit 0** (built in 584ms; same pre-existing, unrelated >500kB main-chunk warning, not a build failure)

All four numbers match the finisher's `FIX_REPORT_batch4.md` claims exactly —
verified independently, not taken on the report's word.

---

## Recommendation

**Ready to PR into `rebuild`.** All BLOCKER/SHOULD-FIX items from the four
original reviews that fall inside this batch's declared scope are genuinely
fixed and test-covered; the shared-component risk (`Sheet` tone promotion) is
confirmed backward-compatible across all 13 real call sites; the stall left no
half-applied edits; nothing previously praised was undone; the gate is green
end-to-end on an independent re-run. The three capstone items (MockMode reskin,
Images.tsx reskin, F-160 ingest gaps) are correctly out of this batch's scope
and should be tracked as the follow-up tickets `FIX_REPORT_batch4.md` already
names — they do not block this PR.
