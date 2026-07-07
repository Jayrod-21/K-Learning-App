# Branch Audit: `topik-ux-fixes`

**Date:** 2026-07-07 · **Method:** net tree diff `git diff rebuild topik-ux-fixes` (ground truth = current `rebuild` tree, not ancestry) · **Verdict:** **DO NOT DELETE (yet)** — contains 2 unique-wanted fixes rebuild lacks. Port them fresh onto `rebuild`, then delete.

## Branch identity

- Single commit: `2027d26` — *"topik-ux fixpass: wall-clock mock timer + no per-second a11y flood"* (2026-07-03), addressing the two TOPIK-UX SHOULD-FIX findings SF-1 and SF-2 from REVIEW_BATCH_TOPIKUX.
- Merge base with `rebuild`: `96d4164` — *"TOPIK UX: answer explanations, mock-timer format, image-item display"* (the PR #14 feature commit itself). The branch is exactly one fixpass commit on top of the feature it was reviewing.
- `rebuild` has since advanced ~153 commits past that base, including B-008, F-007, F-008, F-009, F-020, F-UP-015, F-UP-018, the timeMs clamp, and the intense bug sweep (`1caaad8`) — all of which reworked `MockMode.tsx`/`MockMode.test.tsx`. **None of those later reworks implemented the branch's two fixes** (verified: `1caaad8` touched no timer/aria-live lines; `deadlineRef` and `aria-live="off"` appear nowhere in rebuild's client source; no `visibilitychange`/`performance.now` alternative exists in `MockMode.tsx`).

## Headline-fix verification against current `rebuild`

Files inspected: `client/src/pages/topik/MockMode.tsx` at `rebuild` tip (`83d93b1`).

**(a) Wall-clock mock timer — ABSENT from rebuild.** The countdown is still a drifting per-tick decrement (`MockMode.tsx:767-775`):

```ts
useEffect(() => {
  const id = setInterval(() => {
    setRemaining((r) => (r <= 0 ? 0 : r - 1));
  }, 1000);
  ...
```

A throttled/backgrounded tab whose interval skips fires still banks the skipped seconds as extra exam time. Note: rebuild's `MAX_ITEM_TIME_MS` clamp (`MockMode.tsx:123,736`) is a **different** fix — it caps per-item `timeMs` in the submit body so a sleep gap can't 400 the grade; it does nothing about the countdown granting extra time. The F-007 resume saves persist `remainingSec` **derived from this same tick counter** every 15s (`MockMode.tsx:841`), so resume inherits the drift too.

**(b) No per-second a11y flood — ABSENT from rebuild.** The ticking `role="timer"` is still a polite live region (`MockMode.tsx:879-884`):

```tsx
<span
  className="km-mock__timer"
  role="timer"
  // Polite (not assertive): announce the remaining time without
  // interrupting the user mid-keystroke every second.
  aria-live="polite"
```

Polite still **enqueues** an announcement per tick — a screen reader narrates the clock near-continuously for the whole 60–70 min exam. No coarse-cue region exists (no `km-sr-only` announcer in the file; the `.km-sr-only` CSS class does exist at `client/src/styles/index.css:1759`, so a port needs no new CSS).

## Per-hunk classification (net diff, both files)

Diff orientation: `-` = current rebuild content, `+` = branch content. The branch predates rebuild's last ~153 commits, so most `-` content is *newer rebuild work the branch merely lacks* — those hunks are STALE by definition, not wanted changes.

| # | File / hunk | Branch side | Class | Evidence |
|---|---|---|---|---|
| 1 | `MockMode.tsx` header docblock: wall-clock exam description + React-19 deadline discipline | adds | **UNIQUE-WANTED** (doc for #4/#6) | No deadline language in rebuild header (`MockMode.tsx:1-45`) |
| 2 | `MockMode.tsx` header/imports/body: absence of F-007 resume (fetchAttempt/saveAttempt/clearAttempt, ResumeBanner, initialExam, saveProgress effects), F-008 TopikResults, F-009 gating, F-020 AskAboutThisButton, B-008 TopikPassage, F-UP-015 notice, F-UP-018 errorMessageFor, PROD no-fixture posture, MAX_ITEM_TIME_MS clamp, string itemId wire fix | removes (old base) | **UNIQUE-STALE** | All present in rebuild: e.g. `MockMode.tsx:123` (clamp), `:168-260` (F-007), `:566-600` (ResumeBanner), F-UP-018 `errorMessageFor` import; branch simply forked before them |
| 3 | `MockMode.tsx` `toMessage` = `err instanceof ApiError ? err.message : fallback` | adds (old code) | **UNIQUE-STALE** | Rebuild's F-UP-018 `errorMessageFor` deliberately replaced exactly this (fixed copy, never server prose) |
| 4 | `MockMode.tsx` `deadlineRef` + mount effect stamping `deadline = now + SECTION_MINUTES * 60_000` | adds | **UNIQUE-WANTED** (SF-1) | Rebuild has no deadline anywhere; timer is `MockMode.tsx:767-775` tick decrement |
| 5 | `MockMode.tsx` `remaining` seeded from section budget only (no `initial?.remainingSec`) | adds | **UNIQUE-WANTED w/ adaptation** | The wall-clock seed must be merged with rebuild's F-007 resume hydration (`MockMode.tsx:719-721`): on resume, `deadline = Date.now() + remainingSec*1000` |
| 6 | `MockMode.tsx` interval effect: `sync()` re-samples `ceil((deadline − Date.now())/1000)` floored at 0, with pre-deadline guard (`deadlineRef.current === 0 → return`) | adds | **UNIQUE-WANTED** (SF-1 core) | Rebuild `MockMode.tsx:767-775` still decrements a counter |
| 7 | `MockMode.tsx` `timerAnnouncement` useMemo — coarse cues (final five 1-min marks, 30 s, time-up), `''` between marks | adds | **UNIQUE-WANTED** (SF-2) | No equivalent in rebuild |
| 8 | `MockMode.tsx` `aria-live="off"` on the ticking timer + separate `km-sr-only` polite region | adds | **UNIQUE-WANTED** (SF-2 core) | Rebuild `MockMode.tsx:882` is `aria-live="polite"`; no sr-only announcer in file |
| 9 | `MockMode.test.tsx` throttled-tab test (Date.now stub + single interval fire ⇒ 1:00:00 not 1:09:59) | adds | **UNIQUE-WANTED** (regression proof for #6) | No such test in rebuild's suite |
| 10 | `MockMode.test.tsx` `aria-live="off"` assertion test | adds | **UNIQUE-WANTED** (proof for #8) | No such test in rebuild |
| 11 | `MockMode.test.tsx` coarse-announcement test ("1 minute remaining." at the 60 s mark) | adds | **UNIQUE-WANTED** (proof for #7) | No such test in rebuild |
| 12 | `MockMode.test.tsx` everything else: absence of MemoryRouter wrappers, F-007/F-009/F-020/F-UP-015/F-UP-018/B-008/PROD-posture/timeMs-clamp tests; numeric `itemId` fixture; ungated-explanation assertion | removes (old base) | **UNIQUE-STALE** | Rebuild's suite has all of these; the string-`itemId` fixture is the wire-correct one (sweep fixed the Map<number> blank-rows bug the numeric fixture masked) |

**Counts: PRESENT 0 · SUPERSEDED 0 · UNIQUE-WANTED 8 (hunks 1, 4–11; #5 needs adaptation) · UNIQUE-STALE 4 (hunks 2, 3, 12 — all "old base" artifacts).**

## Verdict and recommended path

**DO NOT DELETE** until the unique work is ported. What is lost if deleted now:

1. **SF-1 wall-clock deadline timer** — without it, a backgrounded/throttled tab silently grants extra exam time over a 70-minute mock (browsers clamp `setInterval` in inactive tabs), and F-007 resume persists the drifted value.
2. **SF-2 timer a11y** — without it, screen-reader users get a queued announcement every second for the entire exam.
3. **Three regression tests** proving both fixes.

**Do NOT merge the branch itself** — its tip is the pre-F-007/F-008/F-009/F-020/B-008/F-UP-018 file; merging (or cherry-picking blind) would fight ~153 commits of newer work and every STALE hunk above is a regression. Instead: **port hunks 1, 4–11 by hand onto a fresh branch off current `rebuild`**, adapting two seams:

- **Resume (F-007):** on hydrate, set `deadlineRef.current = Date.now() + initial.remainingSec * 1000` (and fresh start = `now + budget`); the periodic save then persists deadline-derived `remainingSec`, which also fixes resume inheriting drift.
- **Tests:** add the three new tests into rebuild's current suite (keep MemoryRouter wrappers, string `itemId` fixture, F-007 service mocks).

The port is small (~60 lines of product code + 3 tests). After it lands on `rebuild`, delete `topik-ux-fixes` (local + `origin/topik-ux-fixes`).
