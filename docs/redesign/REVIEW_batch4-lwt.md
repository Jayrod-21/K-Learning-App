# Batch 4 review — Listen / Writing / TOPIK (`feat/redesign-learn-b` @ fae8223)

**Reviewer:** independent senior React/TS reviewer (did not write this code)
**Scope:** `client/src/pages/Ttmik.tsx`, `client/src/pages/Writing.tsx`, `client/src/pages/Topik.tsx` (+ their `.css`/`.test.tsx`), tickets F-128, F-129, F-131, F-159, F-160, F-161, F-162, F-163.

## Verdict: PASS — 0 BLOCKERS

All seven tickets are genuinely implemented, not dodged. The three F-160
sub-claims (client already correct, onError is real, ingest gap is honest)
hold up. F-159's chooser is a true non-trapping gate. F-163's AI Prompt is a
true co-equal top-level choice. Test suites assert real DOM/behavioral
outcomes, not tautologies. One coordination gap (MockMode.tsx unreskinned)
is honestly disclosed, correctly out of this diff's scope, and does not
block ship.

---

## Ticket checklist

| Ticket | Claim | Verdict |
|---|---|---|
| F-128 (reskin, all 3 pages) | PageHubHeader, CityCard, no hardcoded hex | ✅ PASS |
| F-129 (mobile) | No fixed-px widths, F-159 chooser stacks <380px | ✅ PASS |
| F-131 (accent hover) | Hover reads `--km-tone`/`--vermilion`, never literal | ✅ PASS |
| F-159 (TOPIK chooser) | Gate, not replacement; both flows reachable; deep-link skip | ✅ PASS |
| F-160 (Listen audio) | Client correct; onError real; ingest gap honestly deferred | ✅ PASS |
| F-161 (show-15) | Already satisfied by pre-existing F-072 `usePagination` | ✅ PASS (confirmed no leftover pager) |
| F-162 (scroll restore) | Restores on back; TTMIK/Iyagi isolated; try/catch-guarded | ✅ PASS |
| F-163 (AI Prompt top-level) | Genuine 3rd radio, chooser never disagrees with active task | ✅ PASS |

---

## F-160 — Listen audio (detailed verdict: **honest**)

`client/src/services/ttmik.ts:89` — `AUDIO_URL_ALLOW =
/^\/(?:ttmik\/lessons\/\d+\/\d+|iyagi\/episodes\/\d+)\/audio$/` — a real
allow-list, not a rubber stamp; `buildAudioSrc` (ttmik.ts:106-113) returns
`null` on anything that doesn't match, so a tampered/malformed `audioUrl`
can never point the `<audio>` element off-origin. This was pre-existing
(not new this pass) and is exactly what the file-top doc comment
(`Ttmik.tsx:121-146`) claims — verified independently, not taken on faith.

The one genuine new client behavior: `Ttmik.tsx:1015-1018` adds `audioError`
state + `onAudioError` handler; `Ttmik.tsx:1266-1281` wires it to the real
`<audio onError>` DOM event (not a mocked service rejection) and renders a
**distinct** `role="alert"` note (`km-ttmik__audio-error`) alongside the
still-mounted player — never replacing/unmounting it, never conflating with
the separate `role="note"` "no audio mapped" state at `Ttmik.tsx:1288-1293`.
Test `Ttmik.test.tsx:800-826` fires a real `fireEvent.error(audio)` DOM
event (not a service mock), asserts the alert appears, asserts
`document.querySelector('audio')` is still `toBe(audio)` (same node,
reference equality — not a look-alike replacement), asserts the `src`
attribute is untouched, and asserts the alert survives a tab switch
(Highlights↔Transcript) since it describes the persistent player, not a
tab-scoped state. This is a real assertion that would catch a regression
where the error handler tore down the player or where the alert leaked
into the wrong tab.

The deferral: TTMIK L9 (4/14 mapped) and Iyagi (91/139 mapped) coverage
gaps, plus a loader regex that misses a `-N` filename suffix (3 known
files), are named as backend/ingest issues
(`tools/ingest/loaders/load_ttmik_audio.py`) with a specific,
falsifiable claim (exact file names/lesson numbers) rather than a vague
"someone else's problem." I did not re-verify the ingest-side claims
against the live container (out of my read scope — reviewing the client
diff), but the claim is specific enough to be checked and is consistent
with the client behaving correctly around `hasAudio: false` (the landing
list's `AudioPill` and the detail's `audioSrc === null` branch both treat
"not mapped" as an honest, distinct state — `Ttmik.tsx:542-556`,
`:1283-1293`). **Nothing fabricates audio.** No client code invents a
fake `src`, silently retries with a different URL, or coerces
`hasAudio: false` into looking like a working player.

## F-159 — TOPIK Study/Mock chooser (detailed verdict: **both flows reachable, true gate**)

`Topik.tsx:223-225` — `chooserOpen` is seeded via a **lazy initializer**
reading `searchParams.get('mode') === null` **once** on mount, not derived
every render — this is the correct pattern for "gate a fresh visit only."
A deep link that already carries `?mode=mock` (Today's Mock tile, a
bookmark) never shows the chooser (`Topik.test.tsx:731-744` covers this).

Critically, `Topik.tsx:358-375` — the `Tabs`-driven Study/Mock landing is
rendered **unconditionally**, below/behind the `<Sheet>` in the same
return, not gated on `!chooserOpen`. `Sheet` (`components/Sheet.tsx:52`)
returns `null` when `open=false` — it never conditionally hides its
sibling content. So dismissing the chooser by any path (explicit
Study/Mock pick, Esc, backdrop click) always lands on an already-populated
screen, never a blank state. `Topik.test.tsx:672-684` explicitly asserts
the Study item text is already visible **while the dialog is still open**
— a materially deferred-not-blocking check that would legitimately fail if
someone made the chooser a true full-screen replacement instead of an
overlay. Esc-dismissal (`Topik.test.tsx:717-729`) and both explicit picks
(`:686-715`) are separately tested and all leave the correct tab selected
afterward. `chooseMode` (`Topik.tsx:249-255`) reuses the exact same
`selectMode` URL-rewrite the manual Tabs click uses — one code path, so a
chooser pick can't diverge from a tab click's behavior.

Sheet correctly focus-traps while open (`useModalA11y`) — a sighted/AT user
can't tab into the underlying content until the sheet closes, which is
correct modal semantics, not a "flow blocked" bug; the ticket's "gate, not
replacement" language is about render structure (both flows exist
underneath) and post-dismissal reachability, both of which hold.

## F-163 — Writing AI Prompt as top-level option (detailed verdict: **genuinely co-equal**)

`Writing.tsx:184-188` — `CHOICES` is a flat 3-entry array (Q53, Q54,
`ai_prompt`) rendered by `Writing.tsx:703-725` as **identical** `role="radio"`
buttons in **one** `role="radiogroup"` — not a 2-way toggle with a 3rd
button styled differently, not a nested/secondary control. Arrow-key roving
tabindex (`onChoiceKeyDown`, `Writing.tsx:629-644`) treats all three
identically (wraps across all 3).

Sync correctness: `selectRubric` (`Writing.tsx:583-596`) calls
`setUiChoice(next)` **unconditionally** on every bank pick, including a
pick made while `ai_prompt` was selected — so the segmented control can
never show "AI Prompt" highlighted while a bank task is actually active.
`selectAiPrompt` (`Writing.tsx:605-607`) deliberately does not touch
`source`/`taskState` — correct, since selecting the chip is a UI-only
switch until the learner actually generates+adopts a topic.
`Writing.test.tsx:564-586` and `:642-665` both assert the `aria-checked`
state of the AI Prompt radio directly (not just visual text), including
the F-101 seed-on-mount case where a Today-carried topic must show the
chooser already reflecting reality on first paint — this is the exact
"chooser never disagrees with the active task" property the ticket cares
about, tested directly, not inferred.

"New topic" still works after adoption: `WritingTopicGenerator` stays
mounted (`Writing.tsx:745`, unconditional on `uiChoice === 'ai_prompt'`,
independent of whether a topic was adopted), and its own "New topic"
button (relabeled from "Generate topic" once `state.phase==='done'`,
`WritingTopicGenerator.tsx:204`) is untouched by adoption.

Old flow not broken: Q53/Q54 bank behavior (random draw, "New prompt",
draft preservation across redraws) is unchanged and still covered
(`Writing.test.tsx:202-263`, `:459-496`, `:521-562`) — the only structural
change is what wraps the segmented control, not the bank fetch/grade
lifecycle.

**Minor NIT (not a blocker):** switching away from the `ai_prompt` chip to
a bank rubric and back unmounts/remounts `WritingTopicGenerator`, so its
own local "last generated topic" preview is lost (reverts to idle) even
though the underlying adopted task (if still `source==='generated'`)
would still render via the appended compose sheet. This is consistent
with the documented "selectRubric is also the way back to bank tasks from
a generated topic" contract, so it's a deliberate design choice, not an
oversight — flagging only because it's a slightly surprising UX corner
(the generator "forgets" what it just made) that a design-fidelity
reviewer might want a screenshot of.

## F-161 — "Next page" not show-15 (confirmed no leftover)

Grepped `client/src/pages/Ttmik.tsx` and `Ttmik.css` for any page-cursor
pattern (`currentPage`, `pageNum`, "next page" pager UI) — none exists.
Both `TtmikListing` and `IyagiListing` use `usePagination`
(`hooks/usePagination.ts`, dated F-031/F-051/F-072 — genuinely pre-existing,
not authored this pass) + `ShowMore`, windowed to 15/15/990
(`Ttmik.tsx:273`). The builder's claim that this ticket was already
satisfied by prior work is correct; there was nothing to remove.

## F-162 — Preserve scroll on back (verified real, isolated, guarded)

`useListScrollRestore` (`Ttmik.tsx:316-355`) keys off `.km-shell__scroll`
via `closest()`, is `sessionStorage`-backed per-corpus
(`LISTEN_SCROLL_KEY`, `Ttmik.tsx:286-289`), and every storage access is
try/catch-guarded. Tests genuinely exercise the unmount/remount round trip
rather than asserting on component state that would trivially survive: the
listing component fully unmounts when navigating to a detail view (the
parent's `view.kind` branch swaps components), so
`Ttmik.test.tsx:898-923`/`:950-971` assert on `scroller.scrollTop`, a real
DOM property, after a `fireEvent.scroll` → navigate away → navigate back
round trip — this could not pass via a stale in-memory ref, only via the
sessionStorage path actually working. Isolation is directly tested
(`:925-948`): scrolling TTMIK doesn't bleed into a first-visit Iyagi
listing, and a second TTMIK visit still recovers its own prior position
after Iyagi wrote to its own key in between. Test infra note
(`Ttmik.test.tsx:161-177`) wraps the page in a real `.km-shell__scroll` div
matching the actual `Shell.tsx` ancestor shape, so the hook's `closest()`
call is exercised against a realistic DOM, not a fabricated pass-through.

---

## F-128 / F-129 / F-131 (cross-cutting)

- **No hardcoded hex:** `grep -nE "#[0-9a-fA-F]{3,8}"` across `Ttmik.css`,
  `Writing.css`, `Topik.css`, and the shared `CityCard.css`/
  `PageHubHeader.css`/`SubwayProgress.css`/`SealStamp.css` returns nothing.
  All color is `var(--...)` or `color-mix(in srgb, var(--...) N%, transparent)`.
- **Character devices used correctly, not just tokens:** `PageHubHeader` on
  all three landings + the Topik "Previous attempts" nested view; `CityCard`
  (device #1/#2) on Listen's tiles/player/reader panels, Writing's compose
  card + Responses history, Topik's session tally/study item/chooser tiles;
  `SubwayProgress` (device #5) on Topik's study stepper; `SealStamp`
  (device #7) on Topik's "set complete" milestone; `.km-giwa`/
  `.km-hangul-watermark` (devices #3/#6) on every genuine (not per-tab
  micro-) empty state across all three pages; `.km-rain-sheen` (device #8)
  on all three page roots. Each page's doc comment explicitly justifies
  which devices it *doesn't* use (no SubwayProgress/SealStamp fit on
  Listen; no najeon anywhere in this batch) rather than silently skipping
  them — matches the design doc's "adopt a genuine subset, not force all
  nine" allowance.
- **F-131 accent hover:** `Ttmik.css:57-63` hover reads
  `color-mix(in srgb, var(--km-tone) 10%, transparent)` where `--km-tone`
  is the same CSS var CityCard/DancheongRail set per-tile — genuinely tone-
  aware, not literal. `Topik.css:146-156` hovers read `var(--vermilion)`,
  which the doc comment correctly notes tracks the active `[data-accent]`
  pick. Neither file has a literal hex or a fixed named color in a hover
  rule.
- **F-129 mobile:** no `width: <n>px` in any of the three page CSS files
  (grep confirms only a `@media (max-width: 380px)` breakpoint, in
  `Topik.css:178-182`, which stacks the F-159 chooser's two tiles instead
  of letting them shrink illegibly — the ONE new fixed layout this batch
  introduced, and it's the one place mobile was explicitly handled). All
  three pages' grids/flex layouts use `fr`/`flex: 1`/`gap`, matching the
  "no hardcoded hex, no fixed px" mandate.

---

## Coordination observations

- **MockMode.tsx (`client/src/pages/topik/MockMode.tsx`) is genuinely
  unreskinned** — confirmed via grep: it still imports `Topbar`-era `Card`/
  `Button`/`Pill` and has zero references to `CityCard`, `PageHubHeader`,
  `SubwayProgress`, `SealStamp`, or the `.km-rain-sheen`/`.km-giwa` utility
  classes. `Topik.tsx`'s own doc comment (`Topik.tsx:68-70`) discloses this
  explicitly as "a sibling file, out of this pass's edit scope... a separate
  follow-up," rather than silently leaving it stale. This is an honest,
  correctly-scoped deferral, not an oversight passed off as done — but it
  is a real, visible design-fidelity gap in the shipped batch: a learner who
  goes TOPIK landing (fully reskinned) → Mock mode → a section/exam
  (MockMode's old flat `Card`/`Topbar` look) will see a jarring style seam
  mid-flow. **Flag for the design-fidelity reviewer**: this should be a
  tracked follow-up ticket (not blocking this batch, since it's explicitly
  out of scope and doesn't regress anything), but it shouldn't be allowed
  to sit un-ticketed — recommend confirming a ticket number exists before
  closing out Wave 2's TOPIK line item as fully done.
- No shared component (`CityCard`, `PageHubHeader`, `SubwayProgress`,
  `SealStamp`, `Sheet`, `usePagination`) needed modification for this
  batch — all three pages consumed the existing Batch-1/2/3 foundation
  as-is, consistent with each page's doc-comment claim.

---

## Test quality — real assertions, not tautologies

Spot-checked the tests most likely to be rubber-stamps and found none:

- Scroll restore tests assert on `scroller.scrollTop` (a real DOM property)
  after a genuine unmount/remount cycle — cannot pass on stale component
  state (`Ttmik.test.tsx:905-923`).
- The audio-error test fires a real `fireEvent.error` DOM event and checks
  reference equality (`toBe(audio)`) on the player node post-failure —
  would catch a regression that tore down and remounted the player
  (`Ttmik.test.tsx:813-819`).
- F-163's tests check `aria-checked` directly on the radio, both for the
  manual-click path and the F-101 seed-on-mount path — would catch a
  chooser/task desync (`Writing.test.tsx:568-579`, `:656-659`).
- F-159's tests assert the Study item's Korean prompt text is visible
  **while `getByRole('dialog')` still resolves** — would catch a chooser
  implemented as a full-screen replacement instead of an overlay
  (`Topik.test.tsx:672-684`).
- F-072/F-161 windowing tests assert exact visible-row counts (15/30/40)
  and the exact "Show more (N)" label text at each step, including the
  boundary where the expander control disappears — would catch an
  off-by-one in the windowing math (`Ttmik.test.tsx:332-360`).

No test found that merely re-asserts a mock's return value or checks for
the mere presence of a component without exercising its actual contract.

---

## PRAISE

- The `F-160` audio-error/no-audio-mapped state split
  (`role="alert"` vs `role="note"`) is a genuinely careful a11y +
  correctness distinction that a lazier pass would have conflated.
- `useListScrollRestore`'s "always assign `scrollTop` once ready (restore
  OR explicit reset to 0)" design (`Ttmik.tsx:305-310`) correctly avoids
  the classic bug where a never-scrolled list inherits whatever position a
  *different* list left the shared scroll container at.
- F-163's `uiChoice` as a genuinely separate third state (distinct from
  `rubric`/`source`) rather than overloading an existing field is the
  right modeling call — it's what makes the "chooser never disagrees with
  reality" property provable rather than incidental.
- Every doc comment names its own scope boundary honestly (MockMode
  unreskinned, F-160 ingest gap, "no natural fit for SubwayProgress on
  Listen") instead of overclaiming completeness.

## Findings summary

- **BLOCKER:** none.
- **SHOULD-FIX:** none required before ship; recommend confirming a
  tracked ticket exists for MockMode's reskin follow-up (coordination
  gap above).
- **NIT:** WritingTopicGenerator's own "last generated" preview resets on
  a bank-rubric→AI-Prompt round trip (documented above); cosmetic only.
- **PRAISE:** see above.
