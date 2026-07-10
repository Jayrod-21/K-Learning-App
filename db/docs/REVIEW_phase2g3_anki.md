# Independent Review — B-021 FSRS Interval Retune (Phase 2 G3)

**Branch:** `feat/phase2-g3-backend-logic` (commit `d5cce10`) vs `rebuild`
**Scope:** `server/src/services/fsrs.ts`, `server/src/services/cardReview.ts`, `server/src/routes/vocab.ts`, `server/src/routes/grammarDrill.ts` + the four pinned test suites
**Reviewer:** independent (did not author)
**Date:** 2026-07-10

## Verdict: PASS — 0 BLOCKERS

The retune is correct, minimal, and confined to the one shared engine. The
fresh-card math genuinely produces the advertised Anki intervals, the
learning-step-out-of-stability modeling is ADR-003-consistent, repeat-review
multiplicative growth is untouched, and all four test suites were retuned to
the new bands (and would fail on the old engine by design). One coordination
item for the client slice, two nits.

## Gate results (targeted run, per instructions — no full suite)

```
npx vitest run tests/services/fsrs.test.ts tests/routes/vocab.test.ts \
              tests/routes/hanja.test.ts tests/routes/grammarDrill.test.ts
Test Files  4 passed (4)
Tests       171 passed (171)
Duration    337.85s
```

## Fresh-card intervals — verified

Traced through `schedule()` + `dueDelayMs()` (`fsrs.ts:211-281`) and confirmed
by unit pins (`fsrs.test.ts:263-277`) and live HTTP window assertions
(`vocab.test.ts:758-800`):

| Rating | stability seed | scheduledDays | dueDelayMs | Wall-clock | UI label (`Review.tsx:858-861`) |
|--------|---------------|---------------|------------|------------|-------------------------------|
| again  | 0             | 0             | 50,000 ms  | **50 s**   | `<1m` ✓ |
| hard   | 0             | 0             | 360,000 ms | **6 min**  | `6m` ✓ |
| good   | 1             | 1             | 86,400,000 ms | **1 day** | `1d` ✓ |
| easy   | 4             | 4             | 345,600,000 ms | **4 days** | `4d` ✓ |

Strict ordering again < hard < good < easy is asserted both in the unit suite
(`fsrs.test.ts:273-276`) and end-to-end over HTTP (`vocab.test.ts:796-799`).
The pre-retune engine (10m / 1d / 3d / 6d) fails these assertions — the tests
pin the NEW contract, not the old one (explicitly noted at
`fsrs.test.ts:28-30` and `vocab.test.ts:763`).

## Quality-bar checklist

- **No change to STORED `due_at` of existing cards** — ✓. No migration touches
  `vocab_cards` (the branch's 053/054/055 migrations are writing-prompts /
  short-stories / conversation-naming). Only future transitions are affected.
- **Multiplicative growth preserved** — ✓. `STABILITY_MULTIPLIER`
  (`fsrs.ts:163-167`, ×1.2/×2.0/×3.0) untouched; good→good chains 1d→2d
  end-to-end (`vocab.test.ts:869-883`, `grammarDrill.test.ts:408-409`), and
  graduated-card behavior (stability > 0) is byte-identical to the old engine
  for hard/good/easy (`fsrs.test.ts:62-94`, `:257-261`).
- **card_reviews BEFORE/AFTER logging intact** — ✓. `cardReview.ts:168-192`
  unchanged in substance (comments only in this commit); `*_before` still comes
  from the FOR UPDATE-locked row, `*_after` from the engine. Verified live:
  `vocab.test.ts:824-867`, `hanja.test.ts:551-568`,
  `grammarDrill.test.ts:384-390`.
- **ADR-003 storage-shape consistency** — ✓. The hard learning step persists
  stability 0 / scheduled_days 0, exactly the shape the pre-existing
  RELEARN_DELAY precedent already stored for `again`; both satisfy
  `ck_vocab_cards_stability_nonneg` and `ck_vocab_cards_scheduled_nonneg`
  (`db/migrations/001_core_schema.up.sql:727,730`) and the card_reviews checks
  (`:833-838`). Minute-scale steps stay clock policy in `dueDelayMs`, outside
  the stability-days model, matching the ADR-003 2026-07-02 amendment (one
  shared engine, storage unchanged). No migration needed and none was written.
- **Shared-engine consumers retuned together, no unintended regression** — ✓.
  The commit's changes to `cardReview.ts`, `vocab.ts`, `grammarDrill.ts` are
  comment-only; the behavior change lives solely in `fsrs.ts`, so vocab, hanja
  (`hanja.ts:720` → `applyCardReview`), and grammar production drills
  (`grammarDrill.ts:430` → `dueDelayMs`) move in lockstep by construction.
  `grammarScheduler.test.ts` (verdict→rating mapping only) is correctly
  untouched — it pins no intervals.
- **Test pins updated to the new bands, and correct** — ✓.
  `hanja.test.ts:533` (good ⇒ 1, was 3), `hanja.test.ts:582-586` (again <1 min,
  was ~10 min), `grammarDrill.test.ts:334` (good-on-new ⇒ 1 day),
  `grammarDrill.test.ts:466-480` (again ⇒ 0 days, minute-scale re-queue). No
  suite still asserts the old 10m/1d/3d/6d bands.
- **No corrupted-row due-now bug** — ✓, and in fact improved (see PRAISE-1).

## Findings

### BLOCKER — none

### SHOULD-FIX

**SF-1 — Client drill banner still says "~10 minutes" for scheduledDays 0
(coordination: client slice of B-021).**
`client/src/pages/Grammar.tsx:1573-1578` renders
`'Added to your review · next in ~10 minutes'` whenever
`scheduledDays === 0`. After this retune that copy is false twice over: an
`again` step is now <1 minute and a `hard` learning step is 6 minutes. The
stale copy is also pinned by `client/src/pages/Grammar.test.tsx:914-937`, and
the doc comments at `client/src/types/domain.ts:1014`, `:1379`, `:1395` still
describe the ~10-minute policy. Not a server defect — the B-021 commit
(`d5cce10`) is deliberately server-only — but the bug report was about label
truthfulness, so B-021 is not fully closed until this lands. The drill
response already carries `schedule.rating` (`grammarDrill.test.ts:465`), so
the client can distinguish "<1 min" from "~6 min" without an API change.
**Coordination:** route to whichever group owns the Phase-2 client slice;
one-file copy change + test pin + three doc comments.

### NIT

**N-1 — `relearning` label on a never-lapsed card (hard → hard on new).**
`fsrs.ts:227-239`: a brand-new card rated `hard` twice arrives at the second
rating with reps > 0, stability 0, lapses 0; the `stability === 0` branch at
`fsrs.ts:235-236` labels it `relearning`. Canonically (Anki/FSRS) a card still
inside its initial learning steps that has never lapsed stays `learning`;
`relearning` implies a lapse. The code comment at `fsrs.ts:231-233` ("a card
with prior reps is recovering from a lapse") is untrue on this path.
Behaviorally inert today — every consumer buckets the two states together
(`vocab.ts:758`, `:765`, `:800`) — but the `card_reviews.state_after` audit
trail (ADR-003 D2, the re-tuning input) records a semantically wrong state.
One-line fix when convenient: distinguish on `current.lapses > 0` instead of
`reps` alone. The existing pin at `fsrs.test.ts:105-114` (lapses: 1 →
relearning) remains correct either way.

**N-2 — hanja suite has no fresh-card `hard` pin.**
`hanja.test.ts:519-613` pins good (1d) and again (<1m) but not the new 6-minute
hard step. Vocab covers all four ratings through the identical
`applyCardReview` path (`vocab.test.ts:758-800`), so the marginal value is
low — noting only for completeness.

### PRAISE

**P-1 — The `dueDelayMs` fallback closes a real latent due-now hazard.**
Pre-retune, a corrupted row (e.g. Infinity stability) clamped to 0 with a
non-`again` rating produced `0 × MS_PER_DAY = 0` → due immediately — the exact
class of bug the 2026-07-02 amendment existed to kill. The new second branch
(`fsrs.ts:277-281`) fail-safes any non-`again` scheduledDays-0 transition to
the 6-minute step, and the comment (`fsrs.ts:269-272`) says so explicitly.

**P-2 — Tests pin the new contract at every layer.** Unit bands, wire
responses, persisted `vocab_cards` rows, and `card_reviews` snapshots are each
asserted independently, with real-clock windows on the HTTP tests
(`vocab.test.ts:770-794`) rather than mocked time — the old engine cannot pass.

**P-3 — Discipline of the change surface.** The behavior change is confined to
constants + seed table + one state branch + one dueDelayMs branch in the single
shared engine; the three call sites received only comment updates. That is
exactly the "one schedule policy" architecture ADR-003's amendment prescribes,
and it is why hanja and grammar drills retuned for free without drift.

## Coordination summary

- SF-1 → client-slice owner: `Grammar.tsx` scheduledDays-0 copy + its test +
  `domain.ts` comments (server response already provides what's needed).
- N-1 → optional 1-line engine follow-up; no schema or test-contract impact.
