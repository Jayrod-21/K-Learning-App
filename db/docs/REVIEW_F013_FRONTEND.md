# Review

**Scope:** F-013 word-mastery frontend, branch `feat/word-mastery`:
`client/src/pages/Progress.tsx` (`WordMasterySection`/`MasteryBar`/`BUCKET_META`/`BUCKET_ORDER`/`MASTERY_PAGE`),
`client/src/services/vocab.ts` (`fetchMastery`/`FetchMasteryOptions`),
`client/src/types/domain.ts` (`MasteryBucket`/`MasterySummary`/`MasteryWord`/`MasteryPage`),
`client/src/pages/Progress.css` (`.km-mastery__*`), `client/src/pages/Progress.test.tsx` (mastery tests).

Reviewed against `/home/jared-williams/projects/SENIOR_ENGINEER_BAR.md`. Server route
(`server/src/routes/vocab.ts` `GET /vocab/mastery`) read only to check wire fidelity — not in scope for grading.

## Verdict

**Changes requested — 1 BLOCKER.** The state/effect/abort logic is genuinely well-built (race-safe, unmount-safe,
correct pager/bucket-filter math, no XSS surface). But a CSS token mix-up makes the bucket **counts unreadable and
the "selected chip" indicator invisible** in both themes — the two things this card exists to show. Fix that one
rule, tighten test coverage on the error/toggle-off paths, and this is shippable.

## Findings

### BLOCKER
- **B1 — Bucket counts and the "selected" chip state are effectively invisible (contrast ≈1.1:1, both themes).**
  `.km-mastery__chip b` and `.km-mastery__chip.is-active` set `color`/`border-color` to `var(--ink)`, but the chip
  sits on a card whose background is `var(--ink-1)`. In this codebase `--ink`/`--ink-1` are **surface** tokens
  (`--ink` = "base table", `--ink-1` = "card paper" — see `client/src/styles/index.css:24-30`), not text tokens;
  the actual text-ink token is `--paper` (`#1B1813` light / `#EFE7D0` dark). `--ink` (`#E8DFC5`) vs `--ink-1`
  (`#F3ECD5`) computes to ~1.12:1 contrast in light mode and a similarly near-zero ratio in dark mode
  (`#15110D` vs `#1E1812`) — nowhere near the WCAG AA 3:1 (UI component)/4.5:1 (text) floor required by
  SENIOR_ENGINEER_BAR §2.6. Concretely: (1) the bold count next to every bucket label ("New **10**", "Mastered
  **3**") is unreadable — the summary bar's one piece of non-color-coded, screen-reader-independent info is gone;
  (2) `is-active` is the **only** visual signal that a chip is selected (no icon/underline/weight change), so once
  its color is invisible a sighted user has no way to tell which bucket is currently filtering the list. This is a
  copy-paste of the wrong token, almost certainly meant to be `var(--paper)`.

## SHOULD-FIX

- **S1 — Bucket-switch fires a spurious extra fetch (double network round-trip per chip tap).** Offset-reset lives
  in its own effect (`Progress.tsx:769-772`, deps `[bucket]`) separate from the fetch effect (`:774-802`, deps
  `[bucket, offset, nonce]`). On a bucket change both effects run in the same commit, in declaration order: the
  fetch effect fires first with the **stale** `offset` (e.g. 30), then the offset-reset effect's `setOffset(0)`
  triggers an immediate second render/commit where the fetch effect re-fires (aborting the first) with the correct
  offset. The abort logic is correct — no wrong data is ever shown — but every bucket tap wastes one request that's
  aborted before use. Cheaper fix: reset `offset` in the chip's `onSelect` handler (`onSelect={setBucket}` → do
  `setBucket(next); setOffset(0);` together) instead of a second effect, or fold both into one effect keyed only
  on `bucket`/`nonce` that derives the offset it needs.
- **S2 — `ctrlRef` is dead weight; the effect's own cleanup already does its job.** `Progress.tsx:767,776-777`:
  `ctrlRef.current?.abort()` immediately before `ctrlRef.current = ctrl` is redundant with the effect's `return ()
  => { ctrl.abort(); }` (`:799-801`), which React already invokes on every dependency change *before* the next
  effect body runs. The manual pre-abort only ever double-aborts an already-aborted controller (a harmless no-op),
  so `ctrlRef` can be deleted along with both abort call sites without changing behavior — right now it reads as
  defensive code that implies the automatic cleanup isn't trusted, which isn't true here.
- **S3 — A failed refetch wipes previously-good data instead of degrading gracefully.** Render order
  (`:804-882`) is `loading&&page===null → error → summary.total===0 → page`. Once `page` has loaded successfully
  once (e.g. the user is on "Mastered" and reviews are showing), a **transient** failure on a later bucket-switch
  or retry replaces the whole card — bar, chips, list — with `ErrorCard`, discarding the still-valid `page` in
  state. That's inconsistent with the sibling block on the same screen: `Progress`'s own `fatalError` (`:189-192`)
  is deliberately scoped to "error AND nothing to show" so a refetch hiccup never nukes a working trend chart.
  Recommend the same pattern here — only show `ErrorCard` when `page === null`; otherwise keep the last good
  `page` visible (optionally with a small inline retry affordance) so one flaky request doesn't strand the user
  mid-filter with no way back to "All" without hitting Retry.
- **S4 — Tests don't cover the trickiest paths.** The mastery `describe` block (`Progress.test.tsx:320-349`) only
  asserts initial render + "chip click → `fetchMastery` called with the bucket" + the `total===0` empty state. It
  never exercises: (a) the **error branch** (`fetchMastery` rejecting → `ErrorCard` renders → Retry bumps `nonce`
  → refetch fires) — the retry/nonce mechanism described in the task brief has zero test coverage; (b)
  **toggle-off** (select a bucket, then tap it again → `bucket` returns to `null` / list returns to "all") — the
  one bit of chip-toggle logic that's easy to regress silently; (c) pager bounds (Prev/Next disabled state,
  `offset` math) — untested even though `MASTERY_PAGE`/pager math is hand-rolled; (d) the `words.length===0` vs
  `summary.total===0` distinction is only tested for the latter. A broken `onSelect` toggle or a broken retry
  button would pass CI today.
- **S5 — Re-implements (imperfectly) what `useEndpointOrMock` already solved.** Every other data fetch on this
  page (and 10 other screens per that hook's own docstring) goes through `useEndpointOrMock`, which already gives
  abort-safe fetch/refetch, a `refetch()` for `ErrorCard`, and a documented mock-fallback contract so a
  screen never fully breaks when the backend is unavailable. `WordMasterySection` hand-rolls its own
  `AbortController`/`loading`/`error`/`nonce` state instead (reasonable if the intent is "never show fabricated
  mastery data" — mirrors the empty-mock policy in this file's own `loadProgressHistoryMock`, `:120-125`) but that
  intent could be expressed by passing an **empty** mock loader through `useEndpointOrMock` (same idiom as the
  history block above it) rather than duplicating the abort/race machinery from scratch — which is exactly where
  S1/S2's extra-request bug came from. Consider consolidating unless there's a specific reason mastery needs its
  own hook (e.g. cross-cutting `bucket`/`offset` params `useEndpointOrMock`'s single-`key` re-fetch model doesn't
  fit cleanly — plausible, but worth a one-line comment saying so).

## NIT

- **N1 — Chip active-state relies on `aria-pressed` alone for AT, and (per B1) on a broken color signal for
  sighted users.** Once B1 is fixed, consider also giving `is-active` a non-color cue (e.g. slightly heavier
  border-width or a filled background) so the state doesn't ride on a single CSS custom property again.
- **N2 — `MasteryWord.dueAt` is fetched and typed but never rendered** (`domain.ts:799-801`, unused in
  `Progress.tsx`). Fine if intentionally reserved for a near-future "next review" column; otherwise it's dead
  wire surface.
- **N3 — Removing `role="status"` from the mastery loading `<div>` (`Progress.tsx:809-810`) is a correct, verified
  fix for a real test collision** (both the top-level "Loading progress…" and a hypothetical mastery
  "Loading word mastery…" `role="status"` would coexist synchronously right after `render()` in the "shows the
  loading state" test at `Progress.test.tsx:291-296`, since `fetchMastery`'s mock resolves on a microtask after
  the initial synchronous assertion — `getByRole('status')` would throw on the duplicate). Losing the live region
  is a minor a11y regression for a transient state, though. A named status region
  (`role="status"` + `aria-label="Word mastery"`, matched in tests via `getByRole('status', { name: ... })`) would
  keep both the AT announcement and the disambiguation, if worth the extra churn.

## PRAISE

- **Abort/race handling is correct.** Every `.then`/`.catch` branch re-checks `ctrl.signal.aborted` before calling
  `setState` (`Progress.tsx:787,792`), so a superseded or post-unmount resolve can never paint stale data or warn
  on set-state-after-unmount — this holds regardless of promise resolution order, because cleanup runs
  synchronously before the next effect body in the same React commit flush.
- **Retry (`nonce`) is a clean, idiomatic re-fetch-without-key-change pattern**, consistent with the rest of the
  file's `refetch` idiom.
- **Pager math is exactly right at every boundary**: `Prev` disabled at `offset===0`, `Next` disabled at
  `offset+MASTERY_PAGE>=total`, the `x–y of total` line uses `Math.min` so the last partial page never overflows,
  and the pager is hidden entirely when `total<=MASTERY_PAGE` — no off-by-one anywhere.
- **Offset resets on bucket change** (`Progress.tsx:769-772`) — without this, switching from a bucket with many
  pages to one with few would silently 404 into an empty page despite `total>0`. Correct call, even though its
  effect-separation costs the extra request in S1.
- **No XSS surface.** `w.korean`/`w.english` render as plain React children (`Progress.tsx:836-837`); no
  `dangerouslySetInnerHTML` anywhere in the diff.
- **`fetchMastery` params are built type-safely** (`vocab.ts:120-127`): `bucket` is only spread onto the params
  object when non-null, so `MasteryBucket | null` never leaks a literal `"null"`/`undefined` onto the wire, and no
  `any`/cast is used.
- **Mock fixture is wire-faithful.** `MASTERY_DEFAULT` (`Progress.test.tsx:92-119`) matches the server's actual
  `GET /vocab/mastery` shape column-for-column (`server/src/routes/vocab.ts:900-914`) — `stability` as a plain
  number (server does `Number(r.stability)`), `dueAt: string | null`, same summary key set — not a hand-wavy
  approximation.
- **Empty-vs-empty-filtered states are correctly distinguished**: `summary.total===0` → "No vocab cards yet…"
  invitation (`:818-822`), vs. a non-empty summary with `words.length===0` for the selected bucket → "No words in
  this group." (`:830-832`). Divide-by-zero in the proportion bar is also guarded (`denom = Math.max(1,
  summary.total)`, `:715`) even though that path is currently unreachable in practice (the `total===0` branch
  short-circuits before `MasteryBar` renders) — good defensive coding for a component that could be reused later.

## Detailed (file:line)

- `client/src/pages/Progress.css:297` — `.km-mastery__chip b { color: var(--ink); ... }` — BLOCKER B1, should be `var(--paper)`.
- `client/src/pages/Progress.css:298` — `.km-mastery__chip.is-active { border-color: var(--ink); color: var(--ink); }` — BLOCKER B1.
- `client/src/styles/index.css:24-30` / `:59-66` — token definitions confirming `--ink`/`--ink-1` are surface tokens, `--paper` is the text-ink token, in both themes.
- `client/src/pages/Progress.tsx:769-772` — offset-reset effect, deps `[bucket]` — S1.
- `client/src/pages/Progress.tsx:774-802` — fetch effect, deps `[bucket, offset, nonce]`; abort/guard logic — S1/S2, PRAISE (race safety).
- `client/src/pages/Progress.tsx:767,776-777` — `ctrlRef` — S2 (redundant with effect cleanup at `:799-801`).
- `client/src/pages/Progress.tsx:804-882` — render branch order — S3 (error branch precedes stale-data fallback).
- `client/src/pages/Progress.tsx:761` / `:746-748` — `onSelect={(b) => onSelect(selected === b ? null : b)}` toggle logic (`:746-748`) — correct, but untested (S4).
- `client/src/pages/Progress.tsx:852-878` — pager bounds/labels — PRAISE, correct at every boundary.
- `client/src/pages/Progress.test.tsx:320-349` — mastery `describe` block — S4 (no error/retry test, no toggle-off test, no pager test).
- `client/src/services/vocab.ts:104-128` — `FetchMasteryOptions`/`fetchMastery` — PRAISE (type-safe param building).
- `server/src/routes/vocab.ts:839-919` — `GET /vocab/mastery` — read for wire-shape cross-check only; matches `MasteryPage`/`MasterySummary`/`MasteryWord` field-for-field.
