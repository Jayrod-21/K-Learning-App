# Review

Scope: F-103 (`PastExams` past-exams library page), F-105 (`Mistake.attemptId`), F-123 (`ExamChooser` done-set keying), on branch `worktree-agent-ace5c3eb73f48dcb9` @ bc62eb7, diffed against `rebuild`.

## Summary verdict

**PASS, no blockers.** Re-enter correctness is provably exact (verified by code inspection and a dedicated test asserting the full re-entered querystring), the nav/route wiring is complete end-to-end, and F-123's checkmark-keying fix is precisely targeted at the TOPIK I/II test-number collision it claims to fix, with real regression tests. Gate is clean: lint 0 problems, `tsc --noEmit` 0 errors, targeted vitest 86/86 passing across the four named files.

The one substantive design concern is the IA question the task asked me to probe: leaving `AttemptsReview` (LEARN-side) untouched while shipping `PastExams` (Review-side) is the right structural call, but the two surfaces currently ship with **verbatim-identical bilingual chrome** (same eyebrow text in both languages, same Korean page heading) despite behaving very differently (one is inert read-only, one is a full re-enter action list). That's a real, cheap-to-fix confusion risk — see SHOULD-FIX 2.

## Findings

### BLOCKER

None.

### SHOULD-FIX

1. **`mockSectionFromKr` silently defaults writing to "reading" instead of asserting exhaustiveness** — `client/src/pages/PastExams.tsx:71-73`. The function's declared input type is `TopikAttemptHistoryEntry['section']`, which resolves to the full `TopikSection` union (`'읽기' | '듣기' | '쓰기'`, `client/src/types/domain.ts:37`), but the implementation only branches on `'듣기'` and treats everything else — including `'쓰기'` (writing) — as `'reading'`. This is safe **today** only because of an out-of-file guarantee: `server/src/routes/topik.ts:978-980` documents that `topik_attempts.section` can never be `'writing'` because `AttemptSectionSchema` rejects it at the PUT boundary, so `GET /topik/attempts` rows are always reading/listening. `PastExams.tsx` neither narrows its input type to reflect that guarantee nor comments on it. If that server-side constraint is ever loosened, or this helper is reused elsewhere, a writing attempt would silently mis-route into a `section=reading` re-enter link — the exact "lands on the wrong paper" failure class this review was asked to probe for, just currently unreachable rather than live. Recommend narrowing the parameter type to `Extract<TopikSection, '읽기' | '듣기'>` (mirroring the server's own `Extract<SectionEnum, 'reading' | 'listening'>` pattern at `server/src/routes/topik.ts:978`) or adding an explicit `default: throw`/assertion branch, plus a comment citing the guarantee it depends on.

2. **Copy collision between `PastExams` and `AttemptsReview`** — the two now-coexisting "past attempts" surfaces present near-identical bilingual chrome:
   - Eyebrow: `PastExams` via `nav.ts:222-223` (`'Completed exams · grades'` / `'완료한 시험 · 성적'`, consumed at `PastExams.tsx:167`) is **verbatim identical** to `AttemptsReview`'s own eyebrow at `client/src/pages/Topik.tsx:552` (`en="Completed exams · grades" kr="완료한 시험 · 성적"`).
   - Korean heading: `PastExams`'s Korean page heading (`nav.ts:225`, `'지난 시험'`, consumed at `PastExams.tsx:169`) is **verbatim identical** to `AttemptsReview`'s Korean heading at `Topik.tsx:553` (`kr="지난 시험"`). Only the English heading differs ("Past exams" vs. "Previous attempts").

   Functionally the two are quite different — `AttemptsReview`'s `AttemptHistoryRow` (`Topik.tsx:498-518`) is a plain `<li>` of spans with **no navigation**, while `PastExamRow` (`PastExams.tsx:109-140`) is a full re-enter `<Link>` plus a Mistakes CTA. That functional gap is a legitimate reason to keep both per the LEARN=doing/Review=browsing rule. But a user who reads Korean, or who glances at the eyebrow rather than the English heading, has no textual signal that these are two different screens — they'd reasonably believe they navigated back to the same "지난 시험" page. This undermines the very IA distinction the builder is relying on to justify not merging them. Recommend differentiating the copy (e.g. keep `AttemptsReview`'s eyebrow as something like "Quick check · this session" or similar, distinct from the Library's "Completed exams · grades") rather than two screens sharing identical bilingual labels for materially different behavior.

3. (Related, non-blocking, roadmap note) Given F-103 now provides the fuller, actionable version of what `AttemptsReview` shows, it's worth a backlog ticket to reconsider whether `AttemptsReview`'s "Completed exams" tile should shrink to a lightweight pointer ("see full history in Review → Past exams") rather than duplicating the full grade/date/band list server-round-trip a second time. Out of scope for this ticket, but the duplication is now real, not hypothetical.

### NIT

1. `bandForPercentage` (`PastExams.tsx:96-101`) is byte-for-byte identical to `Topik.tsx:654-659`. The doc-comment above it explicitly acknowledges this ("each screen owns its own band function; this is not a shared grading contract") so it's a deliberate choice, not an oversight — but a shared `lib/topikBands.ts` would remove the risk of the two silently drifting apart later.
2. `PAST_EXAMS_FETCH_LIMIT = 100` (`PastExams.tsx:65-67`) matches the server's own paging cap exactly and there's no "load more"/pagination affordance. Comment correctly notes this is fine for a personal single-user app's *current* volume, but a multi-year user could eventually exceed 100 completed exams with no indication more exist and no way to reach them. Not urgent given the documented personal/small-scope posture (`project_korean_master_personal_scope`).

### PRAISE

1. **F-123 fix is precisely targeted and well-tested.** Keying the done-set by `examKey(topikLevel, sourceTest)` and *skipping* attempt rows with `topikLevel === null` (`client/src/pages/topik/MockMode.tsx:983-989`) rather than guessing is exactly right — a false checkmark is worse than a missing one, and it's the correct fix for the documented D-1 "one test_number, two papers" collision. The two new tests (`MockMode.test.tsx:805-843` "checkmarks ONLY the TOPIK II row, never the same-numbered TOPIK I row", and `MockMode.test.tsx:846-882` "a legacy attempt with topikLevel null checkmarks neither same-numbered row") are real regression tests — they construct two same-numbered rows across levels and assert on `toHaveAccessibleName`/`not.toHaveAccessibleName` with exact-string matching (explicitly to avoid a "TOPIK I" substring-matching inside "TOPIK II"), so they would fail immediately if the old `sourceTest`-only keying (`doneTestNumbers`) regressed back in.
2. **F-103 re-enter correctness is provably exact, not just plausible.** `reEnterHref` (`PastExams.tsx:83-91`) constructs the identical `mode=mock&section=…&exam=…&level=…` shape that `MockMode.tsx`'s own `goToView`/`onPickExam` path produces (`MockMode.tsx:288-311`, `943-950`), and `PastExams.test.tsx:386-427` asserts the **full resulting querystring** for a reading exam, a listening exam, and a legacy null-level exam (asserting `level=` is entirely absent, never guessed) — this is exactly the "re-enters the correct paper" property the review was asked to verify, and it's locked in by assertion, not just code-reading.
3. **Honest loading/empty/error states, each independently tested.** `PastExams.tsx:172-204` has a real three-way branch (loading / error-with-no-data / empty / populated), and `PastExams.test.tsx` exercises all four (`shows a loading state`, `shows an honest empty state`, `shows an error card with retry`) plus wires the ErrorCard's retry to the hook's real `refetch`. No swallowed fetch errors.
4. **F-105's `attemptId` addition is a clean, low-risk type-only change.** It isn't consumed/rendered anywhere in `Mistakes.tsx` yet (confirmed via grep — zero non-declaration references), so there is no possibility of a stray `"null"` string leaking into the UI; fixtures (`data/mocks/mistakes.ts`) and both `Mistakes.test.tsx` mistake objects were updated consistently to keep the type honest.
5. Nav wiring is complete end-to-end: `App.tsx` route (`review/exams` → `PastExams`), `nav.ts` `NavItemId` union + `NAV_ITEMS` entry + `SECONDARY_IDS` entry, `ReviewLibrary`'s exams shelf target updated to `navItem('review-exams').path`, and `nav.test.ts` asserts the new path. `review-exams` correctly has no `aria-current` wiring, consistent with its sibling secondary id `mistakes` — neither appears in `BottomNav`/`LibrarySubnav`, both are reached only via `ReviewLibrary`'s shelf buttons, so no `aria-current` gap exists.

## Detailed findings (file:line)

- `client/src/pages/PastExams.tsx:71-73` — `mockSectionFromKr` non-exhaustive over `TopikSection`; see SHOULD-FIX 1.
- `client/src/pages/PastExams.tsx:83-91` — `reEnterHref`; matches `MockMode.tsx`'s own URL shape; verified correct.
- `client/src/pages/PastExams.tsx:96-101` vs. `client/src/pages/Topik.tsx:654-659` — duplicated `bandForPercentage`; see NIT 1.
- `client/src/pages/PastExams.tsx:167,169` vs. `client/src/pages/Topik.tsx:552-553` — copy collision; see SHOULD-FIX 2.
- `client/src/lib/nav.ts:97-109` (diff numbering; entry at `id: 'review-exams'`) — nav entry, eyebrow/heading source for the collision above.
- `client/src/pages/topik/MockMode.tsx:915-917` — `examKey` helper, correct composite-identity fix for F-123.
- `client/src/pages/topik/MockMode.tsx:983-989` — done-set built skipping `topikLevel === null`; correct, matches server contract that `fetchAvailableTests` entries (`services/topik.ts:366`) always carry a non-null `topikLevel` while attempt-history rows (`services/topik.ts:327`) may not.
- `client/src/pages/ReviewLibrary.tsx:94-107` — exams shelf now targets `/review/exams`; label/kr intentionally kept as the shelf's own "TOPIK exams"/"기출 시험" (not sourced from `navItem('review-exams').label`), only `desc`/`krDesc` sourced from the nav item — deliberate and test-covered (`ReviewLibrary.test.tsx`), not a bug.
- `server/src/routes/topik.ts:978-980`, `1315-1319` — server-side guarantee that `topik_attempts.section` excludes `'writing'`; the guarantee `mockSectionFromKr` implicitly depends on without referencing it.

## Gate results

Run from `client/`:
- `npm run lint` — clean, 0 problems.
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` — clean, 0 errors.
- `npx vitest run src/pages/PastExams.test.tsx src/pages/ReviewLibrary.test.tsx src/pages/topik/MockMode.test.tsx src/lib/nav.test.ts` — **4 files, 86/86 tests passed.**
