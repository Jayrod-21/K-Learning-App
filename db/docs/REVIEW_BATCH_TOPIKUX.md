# Review: batch — TOPIK UX

Independent senior review (I did not write this code). Branch `fixpass-batch-review`.
Scope: the three TOPIK-tab UX fixes — Study-mode explanation reveal, Mock countdown
timer format/units, and the image-described-in-text affordance — plus the server wire
carrying `hasImage`/`imageText` and the accompanying tests.

Files read in full: `server/src/routes/topik.ts`, `client/src/pages/Topik.tsx`,
`client/src/pages/topik/MockMode.tsx`, `client/src/types/domain.ts`. Sampled:
`TopikImageNote.tsx`, `lib/topikImage.ts` (+ test), `Topik.test.tsx`,
`MockMode.test.tsx`, `data/mocks/topik.ts`, `server/tests/routes/topik.test.ts`,
`server/tests/helpers/seed.ts`, `services/topik.ts`.

---

## Summary verdict

**APPROVE. 0 blockers.** All three fixes are correct, and each is defended by a
regression test that would fail on the pre-fix code. The security-critical property —
the mock exam wire is answer-stripped — is preserved: the new `hasImage`/`imageText`
fields carry only question metadata, the strip stays type-level (`Omit`), and a server
test asserts the serialized mock item contains no `"correct"` substring and no
`explanation`. Explanation rendering is correct on both verdicts and degrades cleanly to
"no paragraph" when empty. The image note renders as a React text node (no
`dangerouslySetInnerHTML`, no XSS). The countdown now decrements every second to 0 and
auto-submits, with an unambiguous `h:mm:ss`/`mm:ss` format.

Findings below are quality/robustness improvements, none blocking. The most substantive
is that the timer counts ticks rather than tracking a wall-clock deadline (SHOULD-FIX),
so a backgrounded tab under browser throttling silently grants extra exam time.

---

## Bar checklist

| Bar item | Verdict |
|---|---|
| Answer-leak: mock wire carries no `correct`/`explanation` | PASS — type-level `Omit` + server test `JSON.stringify(item)` excludes `"correct"` |
| `hasImage`/`imageText` carry no answer info | PASS — question metadata (image the PDF showed), same field study mode already served |
| Timer decrements every second to 0 | PASS — functional-updater interval, per-second visible |
| Timer auto-submits at 0 | PASS — separate effect keyed on `remaining<=0`, `submittedRef`-guarded |
| Format unambiguous for 70/60-min budget | PASS — `1:10:00` / `1:00:00`, not the old `01:10` |
| No stale-closure / missing-dep / cleanup bug in interval | PASS — deps `[]` valid (only stable setter used); cleanup clears interval |
| Handles unmount + exam→results without leaked interval | PASS — `net='submitting'` unmounts `ExamRunner`, firing effect cleanup |
| Explanation shows on BOTH correct + wrong | PASS |
| Empty/missing explanation handled (no blank box) | PASS — paragraph gated on `explanation !== ''` |
| Image note graceful when `imageText` absent | PASS — falls back to bracketed prompt extraction, then honest hint |
| No `dangerouslySetInnerHTML` / XSS on corpus text | PASS — all Korean strings are React text nodes |
| `hasImage`/`imageText` typed correctly; optional `imageText`; no `any` | PASS |
| react-refresh/only-export-components | PASS — page files export only their component |
| Tests fail on pre-fix code | PASS — assert `1:10:00` + explanation text, both absent pre-fix |

---

## Findings

### BLOCKER
None.

### SHOULD-FIX
1. **Countdown counts `setInterval` ticks instead of a wall-clock deadline**
   (`MockMode.tsx:435-481`). `remaining` starts at `mins×60` and is decremented once
   per interval fire. Browsers throttle/suspend `setInterval` in background/inactive
   tabs (down to ~once/min, or paused entirely on mobile), and `setInterval` drifts over
   a 70-minute run. For a *timed* mock the displayed clock and the auto-submit therefore
   drift from real elapsed time, and a user who backgrounds the tab gets materially more
   than the allotted time. Recommend deriving `remaining` from a deadline captured on
   mount (`deadline = Date.now() + budgetMs`) and letting the interval only refresh the
   display (`remaining = ceil((deadline - Date.now())/1000)`), auto-submitting when
   `Date.now() >= deadline`. This also removes any drift concern. Not a deal-breaker for
   a single-user self-study tool, but it undercuts the "timed exam" contract.

2. **Per-second updates inside an `aria-live="polite"` timer flood assistive tech**
   (`MockMode.tsx:542-552`). `role="timer"` is already an implicit live region; adding
   `aria-live="polite"` on an element whose text changes every second queues a fresh
   announcement each second, which screen readers narrate near-continuously. The comment
   intends "announce without interrupting," but polite still enqueues every tick. Prefer
   `aria-live="off"` on the ticking value and, if a spoken cue is wanted, announce only
   at coarse marks (e.g. every minute or the final 60s) via a separate visually-hidden
   region. Low severity but a real WCAG-adjacent annoyance under the §2.6 a11y bar.

### NIT
1. **Two sources of truth for the section minutes** — `SECTIONS[].mins` (70/60/50, drives
   the card copy) and `SECTION_MINUTES` (70/60, drives the countdown) in
   `MockMode.tsx:85-95`. If one is edited the card can advertise a budget the timer
   doesn't honor. Derive the countdown from the single `SECTIONS` entry (or vice-versa).
2. **Interval keeps firing after `remaining` hits 0** (`MockMode.tsx:474-481`). The
   updater returns 0 forever, so the interval keeps ticking (React bails on the no-op
   re-render) until the submit-driven unmount clears it. Harmless — the auto-submit
   unmounts `ExamRunner` within a tick — but the interval could `clearInterval` itself at
   0 for tidiness.
3. **No test for the manual-submit vs auto-submit race** or for interval cleanup on
   unmount. The `submittedRef` guard is simple, but an explicit "manual submit then clock
   expiry does not double-fire" test would lock the invariant.

### PRAISE
1. **Type-level answer strip is genuinely leak-proof** (`topik.ts:243-271`,
   `domain.ts:240-264`). `TopikMockChoiceDTO`/`TopikMockItemDTO` are `Omit`s, so a
   regression that copied `correct`/`explanation` onto a mock item would fail to compile
   — and the server test `expect(JSON.stringify(item)).not.toContain('correct')`
   (`topik.test.ts:238`) backstops it at runtime. The docstring correctly reasons that
   `hasImage`/`imageText` describe the *question*, not the answer, so they rightly
   survive the strip. Exactly the right defense-in-depth for the diagnostic pattern.
2. **`splitImageItem` is pure and total** (`lib/topikImage.ts`) with a thorough unit
   suite covering curated-precedence, trailing/whole-prompt/multiple brackets, empty
   pairs, and degenerate `''`/`'   '` input — a malformed prompt can never break the
   render.
3. **Stale-response guard on the Study reveal** (`Topik.tsx:215-218, 353-357`): the
   server backfill explanation is keyed by `itemId` so a late `recordTopikAnswer` for a
   previous item cannot paint the next item's reveal — and there's a dedicated test
   (`Topik.test.tsx:300`) that withholds then resolves a stale response and asserts it
   never leaks forward.
4. **Timer regression test asserts the exact pre-bug value would fail** — `1:10:00` and a
   1s decrement to `1:09:59` (`MockMode.test.tsx:148-210`), directly encoding the
   "frozen `01:10`" defect so it can't regress.
5. **Fire-and-forget analytics write is correctly non-blocking** with a `.catch(() => {})`
   so it never becomes an unhandled rejection and never gates the reveal
   (`Topik.tsx:266-270`).

---

## Detailed findings (file:line)

- `server/src/routes/topik.ts:259-271` — `toMockItemDTO` explicitly enumerates the wire
  fields (`id, section, number, level, prompt, passageRef?, options{id,kr,en}, hasImage,
  imageText?`); `explanation` is never read and the return type forbids `correct`. Clean.
- `server/src/routes/topik.ts:205-217` — `mapRowToDTO` trims `image_text` and only spreads
  `imageText` when non-empty, so a NULL/blank corpus value stays off the wire. Verified by
  `topik.test.ts:129-136` (`img` has no `imageText`, `imgText` has it).
- `client/src/pages/Topik.tsx:487-505` — reveal Card renders on `revealed` regardless of
  correctness; `isCorrect` only switches the Eyebrow label; the correct answer is named in
  text; explanation paragraph gated on `explanation !== ''`. `aria-describedby` points at
  the block only when revealed, and the block always has content (verdict) so the ref never
  dangles.
- `client/src/pages/Topik.tsx:409-412` — explanation resolution prefers inline, falls back
  to the server grade's, else `''` → omitted. Correct precedence, covered by
  `Topik.test.tsx:248` and `:277`.
- `client/src/pages/topik/MockMode.tsx:365-372` — `formatClock` guards negatives with
  `Math.max(0, …)`, emits `h:mm:ss` at ≥1h else `mm:ss`. Correct and unambiguous.
- `client/src/pages/topik/MockMode.tsx:462-494` — `doSubmit` is `submittedRef`-guarded and
  shared by confirm + auto-submit; the interval and the auto-submit are separate effects so
  no setter runs inside another setter. Sound.
- `client/src/pages/topik/MockMode.tsx:242-284` — while `net==='submitting'` the phase
  subtree (incl. `ExamRunner`) is not rendered, so submit unmounts the exam and the
  interval-cleanup fires — no leaked interval across exam→results.
- `client/src/components/TopikImageNote.tsx:20-40` — description rendered as a text node;
  `null` description shows an honest fallback note. Complementary landmark with an
  `aria-label`. No XSS surface.
- `client/src/types/domain.ts:196-198, 259-263` — `hasImage?: boolean`, `imageText?: string`
  on both `TopikItem` and `TopikMockItem`; optional, no `any`. Consistent.

---

## Coordination observations

- **Client service layer trusts the wire with a cast, not a zod parse**
  (`services/topik.ts:141` `api.post<MockTest>(…)`, `:162` `<MockResult>`). This is the
  project-wide pattern (every endpoint is consumed this way, and `domain.ts:9-21`
  documents "the wire layer will validate at the boundary" as deferred), so it is **not a
  regression introduced by this batch**. It is worth flagging against SENIOR_BAR §2.1
  ("type external data with a zod schema, not a cast") as a standing gap: the mock wire's
  answer-strip is enforced server-side and at the type level, so no answer leaks through
  the un-validated client cast — but a malformed/hostile payload is still trusted
  structurally. Track separately from this UX batch.
- `data/mocks/topik.ts` mock fixtures for `TopikMockItem` correctly omit `correct` and
  `explanation`, matching the real wire field-for-field, and the offline grader documents
  its pseudo-key as dev-only chrome (🅂 badge) — good discipline keeping the fallback from
  masquerading as a grading authority.
- `SECTION_MINUTES` (client) and the server's mock assembly don't share a budget constant,
  which is fine (the budget is a pure client-UX concern; the server never times the exam).
