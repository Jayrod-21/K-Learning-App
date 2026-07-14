# FIX REPORT — Batch 4 (`feat/redesign-learn-b` @ fae8223)

Completes the fix-pass against `REVIEW_batch4-{lwt,cst,launcher,fidelity}.md`. A
prior agent applied most of the fixes to the working tree and stalled before
gating/reporting/committing. This pass: (1) verified every already-applied edit
actually satisfies its finding (found and corrected one real regression in the
verification itself — a stale doc comment), (2) completed the two items the
stalled agent had not reached, (3) ran the full gate, (4) commits.

## Disposition per finding

| Finding | Source | Status | Files |
|---|---|---|---|
| BLOCKER-1: Chat composer attach/send buttons under 44px | cst | **FIXED (already applied, verified)** | `Chat.css` (`min-height`/`min-width: 44px` on `.km-chat__attachTrigger`/`.km-chat__sendBtn`), `Chat.test.tsx` (new stylesheet-contract test) |
| BLOCKER-2: `sourcePage: null` crashes Tickets | cst | **FIXED (already applied, verified)** | `Tickets.tsx` (optional-chaining guard replaces the `!== undefined` narrowing that let `null` through), `Tickets.test.tsx` (new test renders with `sourcePage: null`, asserts no crash + correct fallback + no key sent to `createTicket`) |
| Sheet tone-aware promotion (gap-d, the batch centerpiece) | fidelity | **FIXED (already applied, verified — one doc-comment inaccuracy found + corrected)** | `Sheet.tsx`, `Sheet.test.tsx`, `styles/index.css`. See "Sheet consumer regression confirmation" below. |
| Launcher `km-neon-flicker` double-animation (S1) | launcher | **FIXED (already applied, verified)** | `LearnMenu.tsx` (flicker moved from `.km-learnmenu__panel` to the static `.km-learnmenu__title`), `LearnMenu.test.tsx` (asserts flicker on title, NOT on dialog panel) |
| Settings S-1: sched-field/Toggle touch targets + inaccurate comment | cst | **FIXED (already applied, verified)** | `Settings.css` (`min-height: 44px` on `.km-settings__sched-field`; corrected comment), `styles/index.css` (`.km-toggle::before` 44×44 invisible hit-region, visible pill stays 38×22), `Settings.test.tsx` + `Toggle.test.tsx` (new stylesheet-contract tests) |
| T-1: Tickets draft-loss-on-dismiss | cst | **FIXED (already applied, verified)** | `Tickets.tsx` (draft state lifted from `FileTicketForm` to `Tickets` so `Sheet`'s unmount-on-close no longer destroys an unsaved draft), `Tickets.test.tsx` (Esc-dismiss-preserves-draft test + successful-file-clears-draft test) |
| T-3: useCallback focus-race regression test | cst | **FIXED (already applied, verified)** | `Tickets.test.tsx` (new test retypes into Title while the sheet stays open — the exact re-render-while-open scenario the `useCallback`d `closeFileSheet` guards against — asserts focus never leaves the field) |
| FeedbackFab stale doc comment (S-4) | cst | **FIXED (already applied, verified)** | `FeedbackFab.tsx` (comment updated: form is now Sheet-gated/opened-on-arrival, not always-rendered-inline) |
| WritingTopicGenerator double-surface (gap-b) | fidelity | **FIXED — completed this pass** (stalled agent had built `embedded` prop + wired `Today.tsx`, but had NOT wired `Writing.tsx`'s own AI-Prompt slot, which is the exact surface the finding names) | `Writing.tsx:745` (`<WritingTopicGenerator embedded onUseTopic={adoptTopic} />`), `WritingTopicGenerator.test.tsx` (new default-vs-embedded class tests), `Writing.test.tsx` (new wiring test asserting `.km-topicgen--embedded` on this page) |
| AI-Prompt/bank-rubric round-trip NIT (lwt) | lwt | **DEFERRED** — see reasoning below | none |
| S4/N2: LearnMenu comb-order stale comments | fidelity | **FIXED — completed this pass** (not explicitly in the stalled agent's touched-file list; found on inspection while verifying the launcher findings) | `LearnMenu.tsx` (both the module header's Row1/2/3 description and `COMB_ROWS`' own docstring corrected to match the actual array; the false "grouping reads as intentional" claim replaced with an honest statement that the two accent tiles are non-adjacent in the true 2-3-2 tessellation) |
| S-2: Chat.css "tokens only" overclaim | cst | **FIXED — completed this pass** (not in the stalled agent's touched-file list for this specific comment; found on inspection) | `Chat.css` (comment now names the two pre-existing, by-design `rgba()` literals — `.km-chat__attachMenu` shadow, `.km-chat__askpopBackdrop` scrim — instead of claiming zero non-token color) |
| N-1: Chat askpop CityCard omits `rail` | cst | **DEFERRED** — cosmetic NIT, reviewer explicitly could not confirm intent against the mockup ("flagging as a possible missed polish opportunity, not a defect"). Out of this fix-pass's blocker/should-fix scope; left for a design pass with mockup in hand. | — |
| N-2: Settings test redundancy | cst | **DEFERRED** — harmless duplicate coverage, adds no regression surface, reviewer flagged it as low-priority cleanup only. | — |
| MockMode.tsx unreskinned (fidelity S2 / lwt coordination note) | fidelity, lwt | **REJECTED for this batch (by design, per task scope)** — explicitly out of scope; filed as follow-up ticket #1 below. | — |
| Images.tsx legacy Topbar (fidelity S1) | fidelity | **REJECTED for this batch (by design, per task scope)** — explicitly out of scope; filed as follow-up ticket #2 below. | — |
| F-160 ingest gaps (TTMIK L9, Iyagi, `-N` suffix regex) | lwt | **REJECTED for this batch (by design, per task scope)** — backend/ingest work, not client; filed as follow-up ticket #3 below. | — |

## The one thing I fixed in the "already-applied" verification pass

`Sheet.tsx`'s new module doc comment (added by the stalled agent) claimed the
tone-aware promotion's consumer list — `ReviewGrammar`, `UploadTypeModal`,
`Topik`, `Mistakes`, `Grammar`, `ReviewVocab`, `Review`, `MyVocabLists`,
`Hanja`, `Reading` — all "omits `tone` today" and is "completely unaffected."
This was already false at the moment it was written: `Topik.tsx`'s chooser
passes `tone="accent"` in the very same diff, and `Tickets.tsx`'s file-form
passes `tone="plain"` and isn't in the list at all. Corrected the comment to
separate the nine truly-unaffected consumers from the two that opt in this
pass (Topik, Tickets), matching the codebase's own stated bar ("comments that
lie are worse than none" — echoed in `REVIEW_batch4-fidelity.md` N2).

## Sheet-consumer regression confirmation (gap-d, highest risk item)

Grepped every `<Sheet` call site in the repo (11 files, 13 render sites) and
confirmed the default (`tone` prop omitted) is byte-for-byte unchanged —
`className` still resolves to exactly `'km-sheet__panel'`, no `km-tone--*`
class is added, pinned by `Sheet.test.tsx`'s new
`'omitting tone keeps the panel byte-identical'` test:

- `components/MyVocabLists.tsx` — 2 call sites (create-list, list-detail) — no `tone`
- `components/UploadTypeModal.tsx` — 1 call site — no `tone`
- `pages/Grammar.tsx` — 1 call site (pattern detail) — no `tone`
- `pages/Hanja.tsx` — 4 call sites (detail, add-to-list, new-list, add-hanja-to-list) — no `tone`
- `pages/Mistakes.tsx` — 1 call site (question detail) — no `tone`
- `pages/Reading.tsx` — 1 call site (passage translation) — no `tone`
- `pages/review/ReviewVocab.tsx` — 2 call sites (this-week's-words, add-to-list) — no `tone`
- `pages/review/ReviewGrammar.tsx` — 1 call site (pattern detail) — no `tone`
- `pages/Review.tsx` — 1 call site (new-list) — no `tone`

Two consumers opt in this pass (new, both intentional, both tested):

- `pages/Topik.tsx` — Study/Mock chooser — `tone="accent"` (this page's own skill identity)
- `pages/Tickets.tsx` — file-a-ticket form — `tone="plain"` (a ticket carries no skill color, matching this page's `tone="plain"` CityCards)

Both the Day dancheong top-stripe and Night `--km-tone` glow rules only ever
match `.km-sheet__panel.km-tone--<x>` — a compound selector that can't match
an untoned panel — so the CSS itself, not just the tsx call sites, backs the
"opt-in, not redesign" claim. Precedent check: `.km-tone--plain` in dark
theme bumps the border 1px→1.5px (still `var(--line-strong)`, no color
change) — confirmed this is the SAME established convention `CityCard.css`
already uses for its own `[data-theme="dark"] .km-citycard.km-tone--plain`
rule, not a new inconsistency.

## AI-Prompt/bank-rubric round-trip NIT — DEFERRED, with reason

`REVIEW_batch4-lwt.md`'s NIT: switching from the `ai_prompt` chip to a bank
rubric and back unmounts/remounts `WritingTopicGenerator`, losing its local
"last generated topic" preview even though an already-adopted task (if
`source==='generated'`) still renders via the compose sheet below. The
reviewer's own verdict was explicit: **"this is consistent with the
documented... contract, so it's a deliberate design choice, not an
oversight."** Fixing it for real would mean lifting the generator's
preview state out of `WritingTopicGenerator` into `Writing.tsx` (the same
kind of state-lifting T-1 did for Tickets' draft) — a real structural change
to a shared component also consumed by `Today.tsx`, not a trivial tweak, and
the reviewer asked only for a screenshot/design-fidelity look, not a code
fix. Deferring rather than force a non-trivial shared-component refactor
into a fix-pass whose own reviewer called the current behavior acceptable.

## Gate — exact numbers

Run from `client/`:

- `npm run lint` → **0 problems** (no output)
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` → **0 errors** (no output)
- `npx vitest run` → **116 test files passed (116), 1747 tests passed (1747)**, 0 failed
- `npx vite build --outDir /tmp/km-fix-batch4` → **exit 0** (built in 580ms; one pre-existing, unrelated chunk-size warning on the main JS bundle, not a build failure)

## Follow-up tickets to file (orchestrator files these)

1. Reskin `MockMode.tsx` (TOPIK timed-exam body) to Seoul — the last jarring flat seam, reached from the batch-B chooser
2. Reskin `Images.tsx` — last page on the legacy flat Topbar
3. Backend/ingest: TTMIK L9 (10 lessons) + Iyagi (48 episodes) audio coverage + loader regex `-N` suffix bug (3 known files) [F-160 real fix]

## Self-assessment vs. gate

All four gates pass at the exact numbers above. Every BLOCKER and
SHOULD-FIX from all four reviews that falls inside this batch's declared
scope is now FIXED, with one exception (AI-Prompt round-trip) that is
correctly DEFERRED per the reviewer's own explicit "deliberate design
choice, not oversight" verdict — not silently dropped. Two NITs (N-1 Chat
askpop rail, N-2 Settings test redundancy) are DEFERRED as genuinely
low-priority per their own reviewers. Two SHOULD-FIX items (MockMode,
Images.tsx reskins) and one ingest gap are REJECTED for this batch only in
the sense of "not this diff" — they are out-of-scope coordination items
that get filed as the three follow-up tickets above, exactly as both
capstone reviews recommended, not as findings dodged.
