# Phase 3B Review — Mistakes page (F-044 / F-045 / F-046 / F-024)

Reviewer: independent senior review (report-only). Scope: `client/src/pages/Mistakes.tsx`, `Mistakes.css`, `Mistakes.test.tsx`; read-only context: `server/src/routes/topik.ts`, `server/src/routes/writing.ts`, `server/src/routes/gradeWriting.ts`, plus the shared primitives the page composes (`CollapsibleTile`, `FilterSelect`, `BackButton`, `useEndpointOrMock`, `services/topik.ts`, `data/mocks/mistakes.ts`).

Verified locally: `npx vitest run src/pages/Mistakes.test.tsx` → 12/12 pass.

## Summary verdict

**PASS — 0 blockers.** The F-045 and F-046 stubs are **genuinely honest**: I independently confirmed against the server tree that `GET /topik/attempts` does not exist (only the singular in-progress-resume `GET /topik/attempt`, `server/src/routes/topik.ts:803`), that the `/topik/mistakes` DTO carries no `attempt_id` (`topik.ts:579-591` selects only `response_id, picked, answered_at, mode`), and that the only writing read is the aggregate `GET /writing/series` (`writing.ts:226`) while `POST /grade-writing` does persist `writing_attempts` rows (`gradeWriting.ts:130-146`) — so every factual claim in the UI copy, including "New attempts are already being saved", is true. Nothing on the page fabricates a score, a correct/total, or a history row. Findings: 3 SHOULD-FIX (a count-honesty edge at the server's silent limit=100 cap, a test gap on the grouping aggregation, and tickets that exist only as code comments so far), plus minor nits.

## Quality-bar checklist

| Bar | Status | Evidence |
|---|---|---|
| WCAG AA | PASS | `--paper-dim` #57617A ≈ 6.2:1, `--paper-mute` #626C84 = 5.25:1 on light surface (documented AA-checked in the token sheet); dark-theme counterparts likewise annotated. Stat/stub copy deliberately uses `-dim` not `-mute` (`Mistakes.css:18-23`, `146-151`) |
| CollapsibleTile ARIA | PASS | `aria-expanded` + `aria-controls` on a real `<button>`, body mounted but `aria-hidden` + `inert` when collapsed (`CollapsibleTile.tsx:63-99`); tests assert the real contract (`Mistakes.test.tsx:129-171`) |
| Labeled session selector | PASS | Native `<select>` with `htmlFor` label "Session · 세션" (`FilterSelect.tsx:61-63`, `Mistakes.tsx:337-343`) |
| Strict TS at I/O boundary | PASS (one nit) | Typed `Mistake` DTO through `fetchMistakes` (`services/topik.ts:229-266`); `mode: string` is looser than the server enum — pre-existing F-021 shape, see NIT-3 |
| No swallowed errors | PASS | `useEndpointOrMock` is abort-aware, prod never falls back to fixture on real failure; `ErrorCard` + `onRetry={refetch}` wired (`Mistakes.tsx:318-322`) |
| Tests exercise real behavior | PASS (gap noted) | CollapsibleTile / FilterSelect / BackButton are REAL in tests, not mocked (`Mistakes.test.tsx:7-9`); disclosure, filtering, navigation, and chat-seed payload all asserted end-to-end. See SF-2 for the aggregation gap |
| Co-located CSS | PASS | `Mistakes.css` alongside, page-chrome-only, reuses global `km-topik__choice` rules |
| No scope creep | PASS | Diff confined to the three scoped files (362/75/220 changed lines); page reuses shared primitives instead of growing its own |
| No console.log / no unticketed TODO | PASS | Zero `console.log`/`TODO`/`FIXME` in all three files; pending work carries ticket refs KM-3B-M1/M2/M3 (but see SF-3) |
| Honest stubs (primary focus) | PASS | See detailed verification below |

## Honest-stub verification (F-045 / F-046)

**F-045 — no fabricated correct/total.** Grepped and read the whole page: the only numeric stats are missed counts — the per-session option label `"{day} · {mode} · {n} missed"` (`Mistakes.tsx:124`) and the live stat line `"{n} missed in the last 30 days"` / `"{n} missed in this session"` (`Mistakes.tsx:347-359`). No score, percentage, or correct/total appears anywhere, and code comments at `Mistakes.tsx:122-123` and `344-346` explicitly forbid fabricating one pending `GET /topik/attempts` (KM-3B-M1). Server-side confirmation: `topik.ts` registers `/items`, `/mistakes`, `/series`, `/attempt` (GET/PUT/DELETE — F-007 resume, singular), `/mock`, `/mock/submit`, `/study`, `/:itemId/answer` — **no attempts-history route exists**. The builder's underivability claim is mathematically correct: `/topik/mistakes` filters `WHERE r.is_correct = false` (`topik.ts:586`), so total answered (denominator) is not in the payload.

**Missed-count correctness.** `groupSessions` partitions the fetched log completely (every mistake lands in exactly one `(local-day, mode)` bucket, `Mistakes.tsx:107-127`); `visible` is either one session's array or the whole log (`Mistakes.tsx:291`), so `visible.length` is exact for the data the client holds. One honesty edge at the server cap — see SF-1.

**F-046 — nothing fabricated.** Both writing tiles render static copy only; `WritingReviewSection` performs no fetch and renders no rows (`Mistakes.tsx:240-273`). Copy claims verified against the server: (a) "will appear here … coming soon" — correct, no per-response history GET exists (`writing.ts` exposes `/prompts`, `/prompts/random`, `/series`, `/generate` only); (b) "New attempts are already being saved" — TRUE: `POST /grade-writing` persists a `writing_attempts` row on every successful grade (`gradeWriting.ts:80-146`, migration 038); (c) the generated-prompts tile makes no persistence claim, matching `/writing/generate`'s deliberate non-persistence (`writing.ts:288-289`). The "twin of F-074" claim checks out — F-074 ("Responses tab — past writing responses") exists at `BUGS_AND_FEATURES.md:1002`.

## Findings

### BLOCKER — none

### SHOULD-FIX

**SF-1 — "N missed in the last 30 days" silently truncates at the server's default limit of 100.**
`Mistakes.tsx:279` calls `fetchMistakes()` with no options, so the server applies `limit` default 100 (max 200) — `topik.ts:535: limit: z.coerce.number().int().min(1).max(200).default(100)`. A user with more than 100 misses in the window sees "100 missed in the last 30 days" (`Mistakes.tsx:349-351`) presented as a period total, and the oldest session in the selector may be truncated mid-sitting, undercounting its "N missed" label (`Mistakes.tsx:124`). This is exactly the class of quiet dishonesty F-045 exists to avoid, just at a different seam. Realistic trigger: one 40-question mock section bombed 3 times in a month. Fix options (any is fine): pass `{ limit: 200 }` explicitly and soften the copy when `mistakes.length === limit` ("most recent N missed"), or have the server return a total count alongside the page. Fold into ticket KM-3B-M1's DTO work if preferred — but note it in the ticket.

**SF-2 — Grouping aggregation is never exercised by a test.**
Both fixtures (`Mistakes.test.tsx:49-92`) produce single-item sessions, so every assertion sees "1 missed" (`Mistakes.test.tsx:219-220`). The core of `groupSessions` — multiple misses merging into one `(day, mode)` bucket, the count label > 1, and stable insertion order within a bucket — passes untested; a regression that dropped all but the first miss per session would still go green. The stale-`sessionKey` fallback guard (`Mistakes.tsx:289-291`, the derived `active`) is also untested — it's the page's only non-trivial state logic. Add: (a) two same-day same-mode misses → one option reading "2 missed" and both tiles rendered under that filter; (b) a data reshape (rerender with new hook data) while a session is selected → selector falls back to "All sessions" rather than filtering everything out.

**SF-3 — Tickets KM-3B-M1/M2/M3 exist only as code comments.**
`grep -r "KM-3B-M"` across the repo hits only `Mistakes.tsx` and `Mistakes.test.tsx`; nothing in `BUGS_AND_FEATURES.md` or any tracker doc, and `docs/phase3b/` did not exist before this review. The module note (`Mistakes.tsx:22`, "see the final report") defers to a report not yet written. The honest-stub bar requires the missing backend to be *ticketed*, not just name-dropped — if the final phase report is where these land, that's acceptable, but it must actually happen before merge. Flagging so the fix-pass/aggregator confirms the three tickets (M1 `GET /topik/attempts`, M2 `attempt_id` in the `/topik/mistakes` DTO, M3 per-response writing history GET) are recorded in `BUGS_AND_FEATURES.md` or the phase report.

### NIT

**N-1 — Redundant type assertion.** `const first = group[0] as Mistake;` (`Mistakes.tsx:119`) — `noUncheckedIndexedAccess` is not enabled in `client/tsconfig.app.json`, so `group[0]` already types as `Mistake` and the cast is a no-op today; if the flag ever lands, the cast will mask the check it was written for. A destructure with an explicit guard (or leaving the comment without the cast) is cleaner.

**N-2 — Double cast in test fixture.** `new Error('boom') as unknown as ApiError` (`Mistakes.test.tsx:27`). `ApiError` is importable and constructible — `new ApiError('boom', { status: 500, code: 'x' })` exercises the real shape and survives an `ApiError` refactor.

**N-3 — `mode: string` at the DTO boundary.** `services/topik.ts:234` types `Mistake.mode` as plain `string` while the server emits the `study|mock` enum; `modeLabel` (`Mistakes.tsx:75-77`) silently labels any unknown mode "학습". Pre-existing F-021 shape, not introduced by this diff — tighten to `'study' | 'mock'` opportunistically when KM-3B-M2 touches the DTO.

**N-4 — Midnight-spanning sitting splits into two sessions.** The local-day comment (`Mistakes.tsx:80-84`) argues the tile-date consistency case well, but a mock sitting crossing local midnight will split across two selector entries; this is inherent to the documented heuristic and self-corrects under KM-3B-M2 — worth one clause in the ticket, no code change.

### PRAISE (fix-pass must not undo)

**P-1 — Stub honesty is real, verified, and defended in depth.** The copy makes only claims the backend supports (verified above), the code comments cite the exact missing routes and migrations (`Mistakes.tsx:25-38`), and `useEndpointOrMock`'s prod path guarantees a real-endpoint failure can never paint fixture data as real (`useEndpointOrMock.ts:241-245`). This is the honest-stub bar done properly.

**P-2 — Stale-filter guard.** The derived `active` fallback (`Mistakes.tsx:287-291`) means a refetch that reshapes the log degrades to "All sessions" instead of an empty filtered list — a subtle failure mode most implementations miss. Deterministic `day|mode` keys also mean a re-fetched identical log keeps the user's selection.

**P-3 — Tests exercise real primitives.** CollapsibleTile, FilterSelect, and BackButton are deliberately NOT mocked (`Mistakes.test.tsx:7-9`); the collapse test asserts `aria-expanded`, resolves `aria-controls` to the actual body node, checks `aria-hidden`, and confirms interactive content is unreachable while collapsed (`Mistakes.test.tsx:129-144`); the F-020 test asserts the actual navigation payload arriving at `/chat` (`Mistakes.test.tsx:235-257`). None of these can pass for the wrong reason.

**P-4 — Correct live-region usage.** The `aria-live="polite"` stat is a persistent `<p>` whose children swap (`Mistakes.tsx:347-359`) — the container survives filter changes, so announcements actually fire; a common mistake is conditionally mounting the live region itself.

**P-5 — Disclosure content model respected.** Everything inside the tile header is a `<span>` because the title renders inside a `<button>` (phrasing content only) — called out at `Mistakes.tsx:130-136` and mirrored in the CSS (`Mistakes.css:31-41`). The no-nested-Card flatten of the explanation panel (`Mistakes.tsx:203-206`, `Mistakes.css:92-101`) keeps the design-system invariant now that the tile itself IS a Card.

**P-6 — Local-day grouping consistency.** `sessionDayKey` slices on the same local boundary as the `toLocaleDateString` labels the user sees (`Mistakes.tsx:79-90`), so a 23:00 sitting never files under "tomorrow" — the rationale is written down where the next maintainer will look.

## Coordination observations

- **KM-3B-M2 ground truth confirmed for the ticket author:** migration `db/migrations/046_topik_attempts_history.up.sql` exists and `topik_responses.attempt_id` is already stamped by mock submit (`topik.ts:1269`) — the DTO extension is a pure SELECT/DTO change on `/topik/mistakes` (`topik.ts:579-604`), no schema work needed. The client's `day|mode` keys can be swapped for `attemptId` with the selector UI unchanged.
- **KM-3B-M1 scope note:** correct/total per attempt is computable server-side once a history route reads `topik_attempts` (status/score columns from 046) — the client stat line at `Mistakes.tsx:347-359` is the intended consumer; SF-1's truncation caveat should ride the same ticket.
- **F-046 ↔ F-074:** the future writing-history endpoint serves both this page's section and the Learn → Writing responses tab (`BUGS_AND_FEATURES.md:831, 1002`) — KM-3B-M3 should be cross-linked to F-074 so two endpoints don't get built.
- `docs/phase3b/` was created by this review; the builder's final report (referenced from `Mistakes.tsx:22`) is not yet present.
