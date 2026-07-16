# Review: B7 — F-077 hanja "Mastered" reword · F-087 accent contrast tests · F-179 carousel onChange

Reviewer: independent senior front-end review. Scope: F-077 (Hanja/Progress "Banked"→"Mastered" display reword + client-composed status line), F-087 (accent-as-text / accent-as-indicator AA contrast tests), F-179 (`SwipeCarousel` settled-index `onChange`), as of commit `c7774e7` on `worktree-agent-a48bf1406a016fcf4` (merge-base with `rebuild`: `b365b9e`). The F-097 dead-CSS sweep is owned by a separate reviewer and is out of scope here. Code not modified (one token was temporarily mutated to prove the contrast tests detect regressions, then restored byte-identical; tree verified clean).

## Summary verdict: **PASS** — 0 blockers, 1 should-fix, 2 nits

All three features are correctly implemented. The `banked` wire id is provably unchanged end to end (server enum, POST body, DB CHECK, client filter id, CSS state class — display strings only were renamed, so no persisted data or contract is at risk). The client-side `hanjaProgressSummary` reconstruction is arithmetically faithful to the server's templated note in every non-degenerate state, and strictly *more* correct under optimistic writes. The contrast tests compute real WCAG ratios from parsed tokens and demonstrably fail when a token regresses (mutation-verified). `onChange` fires only on settled-index change, with full backward compatibility. The one should-fix is a mock-fixture incoherence the new client-side composition exposes in dev mock mode.

## Gate (exact)

Run in the worktree, `client/`:

| Gate | Result |
|---|---|
| `npm run lint` | 0 errors, 0 warnings |
| `npx tsc -p tsconfig.app.json --noEmit --incremental false` | 0 errors (exit 0) |
| `npx vitest run src/pages/Hanja.test.tsx src/pages/Progress.test.tsx src/components/SwipeCarousel.test.tsx src/styles/tokensContrast.test.ts` | **4 files, 251/251 passed** (SwipeCarousel 31 = 24 pre-existing + 7 new F-179; tokensContrast 98 = 50 pre-existing + 48 new F-087) |

## F-077 — wire-id and contract audit

- **Wire id unchanged, verified at every layer.** Server enum `HANJA_STATES = ['new', 'practicing', 'banked']` untouched (`server/src/routes/hanja.ts:74`); the POST `/hanja/:char/state` body still sends `'banked'` (asserted by the untouched test expectation `setHanjaStateMock).toHaveBeenCalledWith('學', 'banked')`, `client/src/pages/Hanja.test.tsx:445`); the filter chip id stays `banked` (`client/src/pages/Hanja.tsx:268`), and the filter is ephemeral `useState` (`Hanja.tsx:400`) — no URL param, no localStorage, so nothing persisted could break; the Progress band key/class stay `banked`/`is-banked` (`client/src/pages/Progress.tsx:1737`). Only `label`/`kr` display strings changed.
- **Reconstructed total is faithful.** Server note is `` `${banked} banked · ${practicing} practicing · ${encountered}/${total} encountered` `` with `new = Math.max(0, total − banked − practicing)` (`server/src/routes/hanja.ts:394-403`). Client reconstructs `total = banked + practicing + new` (`client/src/lib/encounteredBar.ts:66`) — algebraically identical whenever the server clamp doesn't fire. The only divergence case is the degenerate orphan state the clamp exists for (progress rows outnumbering the current corpus): there the server's own note is already incoherent (e.g. "11/8 encountered") while the client renders a self-consistent "11/11". The client is never *worse* than the wire note; no real-data case differs.
- **More correct than the wire note under optimistic writes.** The Hanja page recomputes `progress` from the state-override overlay (`Hanja.tsx:437-453`), moving counts *between* buckets — so `banked + practicing + new` is invariant and the composed line updates in lockstep with a bank/unbank tap. The old server-templated `note` string would have gone stale in exactly that window. Tests assert the stale wire note never reaches the DOM (`Hanja.test.tsx:314-320`, `Progress.test.tsx:1312-1314`).
- **"Mastered" applied consistently everywhere "Banked" showed.** Filter chip + state pills (`Hanja.tsx:268,280,288`), EncounteredBand chip (`Hanja.tsx:729`), detail-sheet action "Mark as mastered"/"숙달로 표시" (`Hanja.tsx:3144`), Progress band meta + empty-state invite copy EN/KR (`Progress.tsx:1737,1810-1811`), and the Progress band's `aria-label` ("12 mastered, 8 practicing, 80 new", `Progress.tsx:1832`). A full-repo sweep for residual `Banked`/`담김`/`담기` display strings finds only Grammar-domain *identifiers* (`BankedGrammarRow`, `listBanked` — wire/type names, different feature, correctly untouched), code comments, and the internal CSS class `km-hanja__detail-bank` (not user-visible; renaming it belongs to the dead-CSS sweep's turf if at all).
- **Semantics of "Mastered" (product flag, per ticket).** The codebase already glossed this state as mastery *before* the reword: the pre-change detail-sheet comment read "the SRS ('practicing') and mastered ('banked') states", the index grid colors it with `--km-mastery-mastered`, and a banked character's only action is "Practice again" (i.e. it has left the SRS as done). So "Mastered" is consistent with the app's own semantics, and unifying with Progress's word-mastery bucket ("Mastered/숙달") is the right one-concept-one-word move. The honest caveat for the copy decision: this is a **one-tap, self-declared** state — a brand-new character can be "Mark as mastered"-ed instantly, whereas the word-mastery buckets are FSRS-derived. If that asymmetry bothers, a humbler label ("Known", as Grammar chose) fits the mechanics better; the implementation is label-agnostic either way (two label maps + three literals to change).

## F-087 — contrast tests

- **Real computation, not hardcoded.** The tests parse `--name: value` declarations out of `index.css` (`tokensContrast.test.ts:57-67`), resolve `var()` chains (`:70-76`), and compute WCAG 2.x relative luminance/contrast from the hex values (`:78-99`). 48 new assertions: 3 accents × 2 themes × 4 surfaces × {text ≥ 4.5:1 at `:247-286`, indicator ≥ 3:1 at `:288-323`}.
- **Cascade-merge order matches the real stylesheet.** Verified against `index.css` block order: base `:root,[data-theme="light"]` (line 44) → `[data-theme="dark"]` (253) → `[data-accent=…]` (480+, later in source, same 0-1-0 specificity so it wins over the dark block) → `[data-theme="dark"][data-accent=…]` (0-2-0, wins everything). The test's `Map` spread order (light, dark, accent, dark-accent) reproduces exactly that resolution.
- **Spot-verified independently.** I recomputed all 48 ratios with a separate script: worst text = **4.642:1** (light+mint `--vermilion-ink` on `--ink`), worst indicator = **4.006:1** (light+mint `--vermilion` on `--ink`) — matching the builder's claimed 4.64/4.01 to the rounding digit.
- **Mutation-verified.** Temporarily degrading `--dan-jade` `#2E7D6B` → `#7ec9b5` produced **6 test failures** in the suite; restoring the token returned 98/98 and a clean tree. The tests genuinely gate regressions.

## F-179 — SwipeCarousel onChange

- **Backward compatible.** `onChange?: (index: number) => void` optional, invoked via `onChange?.(target)` (`SwipeCarousel.tsx:100,166`); omitted = byte-for-byte prior behavior. All 24 pre-existing tests pass untouched.
- **Fires only on settle.** `goTo` is the single settle path — the only `setRawIndex` call sites are `goTo` (`:161`) and the initial-state lazy init (`:139`). Mid-drag movement only touches `setDragX` (`:249`); spring-back and clamped edge swipes reach `goTo` with `target === index` and are suppressed (`:166`); the render-time shrink clamp (`:144`) bypasses `goTo` entirely and correctly stays silent (parent drove it). Loop wrap reports the wrapped index (double-modulo at `:157-160`).
- **Tests are real.** 7 new tests (`SwipeCarousel.test.tsx:571-661`) cover swipe snap, dot click, dot keyboard, active-dot no-fire, spring-back no-fire, non-loop edge-clamp no-fire, and loop wrap last→first firing `0` — each asserts both call count and payload, and the negative cases also assert the page did not move.

## Findings

### BLOCKER — none

### SHOULD-FIX

1. **`HANJA_PROGRESS_FIXTURE` is incoherent under the new client-side composition** — `client/src/data/mocks/hanja.ts:206-213`: `banked: 6, practicing: 4, new: 2, encountered: 142`. Reconstructed total = 6+4+2 = **12**, so the Hanja page in mock mode (dev 🅂-badge fallback) now renders "6 mastered · 4 practicing · **142/12** encountered". Before F-077 the fixture's prose `note` rendered instead ("142 of the ~800…"), which was coherent. Dev/mock-only (Progress's panel is real-data-only; unit tests use their own coherent 4/2/1 fixture), so not a blocker — but fix the fixture's `new` to something route-contract-consistent (e.g. `new: 990` → "142/1000 encountered").

### NIT

1. **No direct unit test for `hanjaProgressSummary`** — the helper (`client/src/lib/encounteredBar.ts:59-75`) is exercised only through the two pages' DOM assertions. Its sibling `encounteredBarAria` in the same file has the same (pre-existing) posture, so this follows local convention, but a 3-line table test would pin the EN/KR templates and the zero-count shape independently of page markup.
2. **`goTo` compares against the render-scope `index`** (`SwipeCarousel.tsx:166`) — a stale-closure comparison if two `goTo` calls ever landed within one render pass (fire-then-silent-revert would leave a consumer believing a stale index). Unreachable today: every call site is a discrete user event and React flushes between discrete events. A functional `setRawIndex(prev => …)` with the change-check inside would make it correct by construction rather than by call-site discipline.

### PRAISE

- The mutation-killable contrast suite is the right way to write a11y guards — parsed-from-source, cascade-faithful, and it names the exact historical failure (light-mint 2.99:1) it exists to prevent.
- Composing the status line client-side didn't just fix the bilingual/reword problem — it fixed a latent staleness bug, since the optimistic overlay now moves the summary in lockstep where the server note could not.
- F-179's negative-case tests (spring-back, edge clamp, active dot) are exactly the cases a naive `useEffect`-on-index implementation would have gotten wrong; routing through `goTo` avoided that class of bug entirely.

### NOTE (process, not a finding against this change)

`rebuild` has advanced past this branch's merge-base (PRs #121/#122 — F-099 grammar mastery panel, migration 067, etc.), so `git diff rebuild` shows large reverse-noise (it looks like this branch deletes the grammar-mastery panel; it does not). This review diffed `b365b9e..c7774e7`. Both sides touch `client/src/pages/Progress.tsx`, so expect a (mechanical) rebase before merge.
