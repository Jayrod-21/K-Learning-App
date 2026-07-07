# Branch Audit — `fixpass-batch-review` vs `rebuild`

**Date:** 2026-07-07
**Method:** Net 2-dot tree diff (`git diff rebuild fixpass-batch-review`) scoped to the files
actually touched by the branch's unique commits, with every claim verified against the
CURRENT `rebuild` working tree (we are on `rebuild`). Ancestry alone was NOT trusted —
the branch has two merge bases with `rebuild` (`96d41643`, `4f23b840`), so 3-dot diffs lie.

## Verdict

**DO NOT DELETE (yet) — 1 unique-wanted commit.**

Commit `fe6e487` ("topik-ux fixpass: wall-clock mock timer + no per-second a11y flood")
is genuinely absent from `rebuild` and still matters. Everything else on the branch is
byte-for-byte or patch-id-identical content already merged. Port `fe6e487` (adapted to
the F-007 resume rework — see below), then both `fixpass-batch-review` AND
`topik-ux-fixes` are safe to delete.

## Unique commits (`git log fixpass-batch-review --not rebuild`)

| Commit | Subject | Classification |
|---|---|---|
| `6f52864` | review: merge topik-ux-fixes for batch /fixpass | **PRESENT** — merge of `96d41643`, which is itself in `rebuild`'s first-parent history ("TOPIK UX: answer explanations, mock-timer format, image-item display", 2026-07-02) |
| `fe6e487` | topik-ux fixpass: wall-clock mock timer + no per-second a11y flood | **UNIQUE-WANTED** — not in `rebuild` in any form |
| `1b40d41` | fsrs+vocab fixpass: clamp stability overflow + fallback-path test coverage | **PRESENT** — exact patch-id twin `2108708b` is in `rebuild` (patch-id `c490e8a6…` matches) |

The remaining ~44k deletion lines in the raw 2-dot stat are `rebuild`'s LATER work that
the branch simply lacks (Ttmik, Writing, Progress, mastery/series routes, migrations
035-039, review docs, etc.) — noise, not branch content.

## Headline question: FSRS stability-overflow clamp

**Already in `rebuild`. Nothing is lost.** Commit `1b40d41` was merged as patch-id twin
`2108708b` ("fsrs+vocab fixpass: clamp stability overflow + fallback-path test coverage").
Tree proof in the current `rebuild` checkout, `server/src/services/fsrs.ts`:

- line 106: `export const STABILITY_MAX = 36_500;`
- lines 150–151: `function clamp(value, lo, hi)` with `if (!Number.isFinite(value)) return lo;` (NaN-safe)
- line 212: `const safeStability = clamp(stability, 0, STABILITY_MAX);`
- line 181: difficulty clamped to `[DIFFICULTY_MIN, DIFFICULTY_MAX]`

`git diff rebuild fixpass-batch-review -- server/src/services/fsrs.ts server/tests/services/fsrs.test.ts`
is **empty** — both files identical to the branch.

## Per-file classification (files touched by the unique commits)

### Commit `1b40d41` (fsrs+vocab fixpass) — all PRESENT

| File | Net diff vs rebuild | Evidence |
|---|---|---|
| `server/src/services/fsrs.ts` | none | identical; clamp at fsrs.ts:106/150-151/212 |
| `server/tests/services/fsrs.test.ts` | none | identical (clamp-to-cap, repeated-easy, NaN-floor tests present) |
| `tools/ingest/tests/fixtures/vocab_mini_beginner_fallback.json` | none | identical |
| `tools/ingest/tests/test_load_vocab_2000.py` | none | identical (beginner-fallback test present) |
| `server/src/routes/vocab.ts` | rebuild AHEAD only | Branch's NIT #3 (`ReviewBodySchema` "deliberately NOT .strict()" cross-reference) is in rebuild at vocab.ts:271-277. Every hunk in the net diff is a rebuild-side later addition the branch lacks: `MAX_ID`/`INT4_MAX` bounds (routes sweep #3), F-003 `domain`/`book_level` filters, B-009 `vocab_entries` join, gloss-wins `COALESCE(vocab_entries.english, EXCLUDED.english)` (routes sweep #6 — SUPERSEDES the branch's older `COALESCE(EXCLUDED.english, …)` order), F-013 mastery + F-017 series routes. Nothing branch-unique. |

### Commit `6f52864` (merge of topik-ux-fixes @ `96d41643`) — all PRESENT

`96d41643` is a direct commit in `rebuild`'s history; tree-verified anyway:

| File | Evidence in current rebuild |
|---|---|
| `client/src/components/TopikImageNote.tsx` | net diff none — identical |
| `client/src/lib/topikImage.ts` / `.test.ts` | net diff none — identical |
| `client/src/pages/Topik.tsx` | imports at :53/:59, `hasImage`/`splitImageItem` at :543-544, `<TopikImageNote>` at :563 |
| `client/src/pages/topik/MockMode.tsx` | h:mm:ss `formatClock` fix at :631-640; `splitImageItem` wiring at :866-871 |
| `client/src/types/domain.ts` | `hasImage`/`imageText` at :181-188, :253-256 |
| `client/src/data/mocks/topik.ts` | `hasImage: true` + `imageText` at :126-127 |
| `client/src/styles/index.css` | `.km-topik__answer`/`__image-note`/`__image-desc`/`__image-hint` at :1875-1898 |
| `server/src/routes/topik.ts` | `has_image`/`image_text` at :208-209, `hasImage:` at :312, SELECT at :407 |
| `server/tests/helpers/seed.ts` | `has_image`/`image_text` seed params at :390-392, :449 |
| test files (Topik/MockMode/topik.test.ts) | superseded by rebuild's much larger later suites covering the same feature |

### Commit `fe6e487` (wall-clock timer + a11y) — UNIQUE-WANTED

| Hunk | Status | Evidence rebuild LACKS it |
|---|---|---|
| Wall-clock deadline countdown (`deadlineRef = mount + budget`; interval re-samples `ceil((deadline − now)/1000)`, floor 0; pre-deadline guard) | **UNIQUE-WANTED** | rebuild `client/src/pages/topik/MockMode.tsx:767-770` still tick-decrements: `setInterval(() => { setRemaining((r) => (r <= 0 ? 0 : r - 1)); }, 1000)`. A throttled/backgrounded tab (browsers clamp inactive-tab intervals) drifts and grants extra exam time over a 70-min run. The F-007 resume rework does NOT fix this — it persists the already-drifted `remainingSec` every 15s. The 2026-07-06 bug sweep did not touch the timer mechanics (verified: sweep diff has no `setInterval`/`aria-live`/`deadline` lines in MockMode). |
| Timer a11y: `aria-live="off"` on the ticking value + coarse `km-sr-only` polite region (final-5 minute marks, 30s warning, time-up) | **UNIQUE-WANTED** | rebuild MockMode.tsx:882 is still `aria-live="polite"` on the per-second `role="timer"` — screen readers enqueue an announcement every second. No `timerAnnouncement`/sr-only region exists anywhere in the file (grep count 0). The `.km-sr-only` CSS class DOES already exist (index.css:1759), so only the component change is needed. |
| `MockMode.test.tsx`: throttled-tab test (fake interval + stubbed `Date.now`), `aria-live="off"` + coarse-announcement assertions | **UNIQUE-WANTED** | accompanies the missing fix; absent from rebuild's suite |

## Porting note

`fe6e487` will NOT cherry-pick cleanly: rebuild's `ExamRunner` was reworked for F-007
resume (`initial?.remainingSec` seed at MockMode.tsx:719-721, `saveProgress` persistence
at :806-846). The port must set
`deadlineRef.current = Date.now() + (initial?.remainingSec ?? SECTION_MINUTES[section] * 60) * 1000`
in the mount effect and keep persisting the (now correctly derived) `remainingSec`.
Small adapted port on a fresh branch off `rebuild`; then delete `fixpass-batch-review`
and `topik-ux-fixes` (whose sole unique commit `2027d26` is the patch-id twin of `fe6e487`).

## Related branch

`topik-ux-fixes` — exactly one unique commit vs rebuild: `2027d26`, the same wall-clock
fix. It carries nothing else; it lives or dies with the same port decision.
