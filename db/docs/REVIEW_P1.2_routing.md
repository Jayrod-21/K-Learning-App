# REVIEW — P1.2 moves + routing (Slice A + Slice B routing surface)

Independent review, commits `4197c5b` (Slice A) + routing parts of `59cb6a3` (Slice B), branch `feat/overhaul-p1.2`.
Scope: Today/Progress rebalance + App.tsx routes + nav.ts + redirects + ReferenceRedirect/referenceTarget + ReviewLibrary index. NOT review/* page internals / Grammar / My-Lists (R2).

## VERDICT: **PASS-WITH-CONDITIONS**

Condition: restore the 3 dropped series-carousel test assertions (SHOULD-FIX 1). Zero blockers. Zero lost capability. Zero broken routes.

Verification run (node:20-slim container): `tsc -b --force` = 0; targeted suites (Today 13, Progress 24, nav, redirects, ReviewLibrary) 70/70; **full client suite 877/877 pass**.

---

## BLOCKER

None.

## SHOULD-FIX

1. **Three series-carousel tests dropped in the Today→Progress move — not repointed.** Old `Today.test.tsx` (pre-4197c5b) had, new `Progress.test.tsx` lacks:
   - `renders the Writing page as a real chart when it has points (F-014)` (old Today.test.tsx:342) — the POSITIVE Writing path (points → real LineChart, `72%` headline, no invitation). New suite covers only Writing-empty (Progress.test.tsx:435) + Writing-failed (:452).
   - `renders the Grammar page with the score metric (score/pts wire shape)` (old :466) — `pts` unit formatting. Fixture still defines `unit: 'pts'` (Progress.test.tsx:134) but no test navigates to the Grammar panel; the count metric is covered via Vocab (:419), score/pts is not.
   - `renders every panel honestly for a fresh user (all series empty)` (old :487) — all-empty-REAL-series → five "No data yet" panels. New suite asserts "No data yet" only NEGATIVELY (:467, :494).
   Capability itself moved intact (code paths identical in `Progress.tsx` SkillTrendPanel/latestValue); this is coverage regression only. Spec (`OVERHAUL_P1.2_BUILD.md`:38): "Don't weaken existing tests — repoint them." Commit message claim "repointed, not weakened" is inaccurate for these three. Fix: add the three assertions to the carousel describe block (Progress.test.tsx:396).

## NIT

2. **App.tsx `/review/*` route registrations untested at the wiring level.** ReviewLibrary tests assert against a stub location probe; redirects.test mounts only the shim table. Swapping `<ReviewDictionary/>`/`<ReviewGrammar/>` elements in App.tsx:107-114 would fail no test. Mitigated by nav.test path assertions + single-user manual use; a tiny render-App-at-path smoke would close it.
3. **OpenExamPanel degrades a FAILED `/topik/attempt` lookup to the "No exam in progress" copy** (Today.tsx:151-192) without surfacing `attempt.error`. Documented as intentional (mirrors MockMode's offline behaviour, never a fake resume) — acceptable, noting the failure is invisible to the user.
4. Series fetch key renamed `today.series` → `progress.series` (Progress.tsx:411-415) — harmless (key drives refetch identity only, nothing persisted). Observation, no action.

## PRAISE

- **Honest-data discipline on the exam resume.** `loadOpenAttemptMock` resolves `null` at module scope with explicit rationale (Today.tsx:112-122); `useEndpointOrMock` prod contract (real failure → `data: null`, NO mock fallback) means a fabricated resume CTA is impossible in dev or prod. Resume renders only on a real non-null `GET /topik/attempt` (services/topik.ts:176-186).
- **referenceTarget is exhaustive and exhaustively tested** — dictionary/grammar/lists/vocab/absent/unknown all mapped (lib/referenceTarget.ts:10-24) and asserted both through the mounted shim and the pure fn (redirects.test.tsx:74-90). `?tab=lists` lands on `/review/vocab?tab=lists`, which ReviewVocab honours (pages/review/ReviewVocab.tsx:82-86).
- **nav.ts compile-break guards genuinely survive.** `as const satisfies` + `Exclude`/`Extract` never-checks (nav.ts:295-318) still fail tsc on an unplaced/double-placed/unknown id; the three new ids sit exactly once in SECONDARY_IDS. `navItem()` throw guard intact.
- **Compare reconciliation is clean.** Exactly ONE compare card: `CompareCard` = `SkillsCompare full` over the latest history snapshot + retake CTA + `AttemptCompare` sub-block at ≥2 attempts (Progress.tsx:542-575), test-asserted (Progress.test.tsx:330). Server `HistorySnapshotDTO extends SnapshotDTO` (server/src/routes/diagnostic.ts:1526) so the F-011 bands render from real data — the compact→full upgrade is backed by the wire, not just the type.
- **BottomNav boundary matching** (`pathname.startsWith(`${it.path}/`)`, BottomNav.tsx:121-131) lights the Review tab on `/review/vocab` and never on `/reviewx`-style prefixes.

---

## Probe answers (definitive)

**(a) Did Today lose anything?** No. F-017 stats carousel (SkillTrendsCard + SERIES_PANELS + SwipeCarousel + per-skill degrade + total-outage ErrorCard w/ live refetch + writing-empty invitation) and the SkillsCompare TOPIK-level snapshot both fully render on Progress (Progress.tsx:280-334, 542-575); skill-accent CSS moved (5 `data-skill` rules in Progress.css; Today.css notes the move). Today has an explicit negative test ("no longer renders the stats carousel or the TOPIK-level snapshot", Today.test.tsx:160). Exactly ONE compare surface on Progress; attempt-vs-attempt functional at ≥2 attempts with clamped stale selections (Progress.tsx:583-586) and hidden at 1 (test :539). Diagnostic's `/diagnostic/latest` + its mock remain in use by Diagnostic.tsx — nothing orphaned. Only caveat: the 3 test assertions above.

**(b) Do all routes/redirects resolve?** Yes. `/review/{vocab,dictionary,grammar}` → ReviewVocab/ReviewDictionary/ReviewGrammar, correct element per path (App.tsx:104-114, imports :52-54). Tab-aware `/reference` shim: dictionary→`/review/dictionary`, grammar→`/review/grammar`, lists→`/review/vocab?tab=lists`, vocab/absent/unknown→`/review/vocab` — every old P1.1 deep link (`?tab=vocab|dictionary|grammar|lists`, verified against pre-dissolution Reference.tsx) lands. All 8 legacy shims mount under the Shell layout; `*→/` intact (App.tsx:133); `/chat` untouched (route :128, `CHAT_PATH='/chat'` pin unchanged, zero diff to AskAboutThisButton/Chat in either commit). No in-code links to `/reference` remain (comments only). ReviewLibrary rows drive off `navItem()` → the four real routes; exams/uploads are inert designed placeholders (non-buttons, test-asserted); hot chips → `/learn/vocab` + `/learn/grammar` (it.each-tested).

**(c) Can a fabricated exam-resume ever show on Today?** No. Mock resolves `null`; prod real-failure keeps `data: null` (hook contract forbids prod mock fallback); dev fallback is the null mock. The resume CTA requires a genuine persisted attempt from `GET /topik/attempt`; failure/absence both render the honest "No exam in progress" panel → `/learn/topik` where MockMode's own resume banner is authoritative.
