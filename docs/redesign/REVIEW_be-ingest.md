# F-185 Audio-Loader Fix — Independent Ingest Review

**Reviewer:** Independent senior data/ingest reviewer (did not write this code)
**Scope:** `feat/backend-batch` @ `6d05e93`, diff vs `rebuild` limited to:
`tools/ingest/loaders/load_ttmik_audio.py`, `tools/ingest/tests/test_load_ttmik_audio.py`, `BUGS_AND_FEATURES.md` (F-185 entry)
**Date:** 2026-07-14

## Verdict: PASS — 0 BLOCKER

The season-block offset resolver is mathematically correct at every boundary, the empirical claim behind it holds up against the real corpus + real transcript JSON (independently re-derived below, not just trusted), TTMIK lesson numbering is untouched, and the BUGS_AND_FEATURES.md writeup is accurate — including the residual-gap and runbook claims. The ruff soft-gate failure in the batch is pre-existing and outside this diff. 1 SHOULD-FIX (documentation-only, non-blocking), 1 NIT.

---

## 1. Offset-boundary verification (local -> real episode_number)

Code under review, `tools/ingest/loaders/load_ttmik_audio.py:83-87`:

```python
def _resolve_iyagi_episode_number(local_number: int) -> int:
    if local_number <= _IYAGI_SEASON1_MAX:   # 50
        return local_number
    if local_number <= _IYAGI_SEASON2_MAX:   # 100
        return local_number + 50
    return local_number + 100
```

Traced every boundary named in the probe, by hand and against the parametrized test (`tools/ingest/tests/test_load_ttmik_audio.py:44-65`):

| local | branch taken | result | expected (per TTMIK's real 3-block numbering: 1-50 / 101-150 / 201-246) | correct? |
|---|---|---|---|---|
| 1 | `<=50` | 1 | 1 | yes |
| 50 | `<=50` | 50 | 50 (season-1 end) | yes |
| 51 | `<=100` | 101 | 101 (season-2 start) | yes |
| 100 | `<=100` | 150 | 150 (season-2 end) | yes |
| 101 | else | 201 | 201 (season-3 start) | yes |
| 146 | else | 246 | 246 (season-3 end, highest real episode_number) | yes |

No off-by-one at either breakpoint. The two transitions (50->51 local jumping to 50->101 real, and 100->101 local jumping to 150->201 real) exactly reproduce TTMIK's real numbering gaps (51-100 and 151-200 are never used in the real space) — the resolver isn't introducing a discontinuity, it's correctly reproducing one that already exists in the site's own numbering. `<=` (not `<`) at both `_IYAGI_SEASON1_MAX`/`_IYAGI_SEASON2_MAX` is the right comparison for these inclusive block boundaries; verified by hand, not just by reading the test.

Test coverage (`test_resolve_iyagi_episode_number_season_blocks`, `tools/ingest/tests/test_load_ttmik_audio.py:44-65`) hits both boundary pairs directly: `(50,50)` and `(51,101)` bracket the first breakpoint; `(100,150)` and `(101,201)` bracket the second; `(1,1)` and `(146,246)` cover the season-1 and season-3 endpoints. This is exactly the coverage the probe asked for — no gap.

`parse_audio_filename` (`load_ttmik_audio.py:165-171`) routes every matched Iyagi filename through the resolver before constructing `EpisodeKey`, and the SQL `UPDATE ... WHERE episode_number = %s` (`load_ttmik_audio.py:270-276`) keys strictly off that resolved number — so the fix is wired into the actual DB-write path, not just a dangling helper.

## 2. Independent re-verification of the evidence (not just trusting the docstring)

Ran this myself rather than accepting the builder's claim at face value, since content-correctness for 46 rows is exactly the kind of claim that should be independently checked:

- The real corpus is present on this machine at `~/data/korean-master/corpus/TTMIK/이야기들/이야기/` — 142 mp3s spanning local 1-146 (4,5,6,7 absent — consistent with the docstring's "gap-tolerant" framing; irrelevant to the boundary claims since it's inside season 1).
- Installed `mutagen` in a throwaway `python:3.12` container, mounted the real corpus read-only, and pulled the `USLT` (embedded lyrics) ID3 frame directly out of local files 51, 67, 101, 110, 119, 130, 146.
- Cross-referenced that extracted Korean text against the actual transcript JSONs (`tools/ingest/output/iyagi_51_100.json`, `iyagi_101_146.json`) by `number` field, independent of anything the builder wrote.

Result — every spot-check matched exactly, word-for-word:

| local file | ID3 lyrics topic (extracted by me) | JSON unit `number` with matching text | matches builder's claim? |
|---|---|---|---|
| 51 | 혈액형 (blood type) — "오늘은 혈액형에 대해서 이야기를 한다고요?" | 101 | yes |
| 67-1 | SNS/소셜 네트워크 서비스 — "오늘은 SNS... 얘기해 보려고요" | 117 | yes |
| 101 | 쇼핑 (shopping) — "쇼핑이요!" | — (this is the season-3 file; its own content is at real 201, see below) | consistent |
| 110 | 굴욕적인 기억 (embarrassing memory), 윤아/석진 | 210 | yes |
| 119 | 선글라스/멋 (sunglasses/style), 경화/석진 | 219 | yes |
| 130 | 어릴 적 식사량 (childhood eating), 경화/석진 | 230 | yes |
| 146 | "2주일에 한 번씩 발행" (biweekly release announcement) | 246 | yes |

I additionally confirmed local file "101"'s 쇼핑 content matches JSON unit `number=201` (season-3 file, +100 offset) by locating "쇼핑" in `iyagi_101_146.json` — same result the builder reported.

This is real, reproducible, independently-checkable evidence, not a fabricated or hand-waved claim. The 2-breakpoint step function (+0 / +50 / +100) is real.

## 3. Residual-gap claim (episodes 119, 236, 240) — verified, not fabricated

Checked the transcript JSONs directly for gaps in the `number` sequence:

- `iyagi_51_100.json` (season 2, real 101-150): keys jump `...118, 120...` — **119 is absent**.
- `iyagi_101_146.json` (season 3, real 201-246): keys jump `...235, 237...` and `...239, 241...` — **236 and 240 are absent**.

And the corresponding local audio files the builder claims exist for these do exist on disk: `69 TTMIK Iyagi 69.mp3` (-> resolves to 119), `136 TTMIK Iyagi 136.mp3` (-> 236), `140 TTMIK Iyagi 140.mp3` (-> 240). Since `load_iyagi.py` seeds `iyagi_episodes` rows from these same JSON files, an absent `number` in the JSON means no row exists for the loader to attach audio to — exactly the "audio present, no DB row" gap described in `BUGS_AND_FEATURES.md`'s F-185 entry (`BUGS_AND_FEATURES.md:18`). The claim is accurate, not fabricated, and is honestly scoped as a content gap rather than something this loader could fix (it only `UPDATE`s existing rows, per `load_ttmik_audio.py:270-276`).

## 4. TTMIK lesson numbering — unaffected

`_LESSON_RE` and the `LessonKey` branch of `parse_audio_filename` (`load_ttmik_audio.py:163-165`) are byte-identical to `rebuild` — the diff only touches the `_IYAGI_RE` branch (`load_ttmik_audio.py:166-168`) and adds the resolver function above it. Confirmed via `git diff rebuild -- tools/ingest/loaders/load_ttmik_audio.py`: no lines in the lesson-parsing path changed. The `-N` suffix handling the F-185 writeup says was "already fixed" traces to commit `a508ba0` ("F-012 fixpass: ... loader -N suffix", 2026-07-04), predating this batch — that provenance claim checks out too.

## 5. Ingest test run

Ran the actual suite in a `python:3.12` container with the host Docker socket mounted (testcontainers spins its own throwaway Postgres, same pattern as CI's `ingest-checks` job):

```
30 passed in 6.95s
```

All pure-function tests (`test_parse_audio_filename`, `test_resolve_iyagi_episode_number_season_blocks`) and all integration tests (`test_loader_maps_fixture_tree_and_reports`, `test_loader_is_idempotent`, `test_migration_035_round_trip`) pass. The "30 tests pass" claim in `BUGS_AND_FEATURES.md:18` is accurate.

## 6. Ruff — is the batch's soft-gate ruff failure in this diff?

```
ruff check loaders/load_ttmik_audio.py   -> All checks passed!
```

Ran `ruff check .` across the whole `tools/ingest` tree to find the batch's soft-gate failure: 21 pre-existing errors (unused imports/locals), all in `tests/test_load_ttmik.py`, `tests/test_resolve_counters.py`, and `tests/test_resolve_cross_references_integration.py` — none in `load_ttmik_audio.py` or `test_load_ttmik_audio.py`. Confirmed via `git diff rebuild --stat` on those three files: zero changes on this branch. **The ruff soft-gate failure is pre-existing and unrelated to F-185** — nothing to fix in this diff.

## Findings

**BLOCKER:** none.

**SHOULD-FIX:** none in this diff (the batch's ruff soft-failure belongs to other, untouched files — flag separately, not against this change).

**NIT:**
- `load_ttmik_audio.py:83-87` — `_IYAGI_SEASON1_MAX`/`_IYAGI_SEASON2_MAX` constants are only consumed inside `_resolve_iyagi_episode_number`; fine as-is, but if a fourth season block is ever added this becomes an if/elif chain that should probably become a small sorted-breakpoint table. Not worth doing now for 2 breakpoints — purely a forward-looking note, no action needed.

**PRAISE:**
- The module docstring's "IYAGI SEASON-BLOCK RENUMBERING" section (`load_ttmik_audio.py:19-56`) is unusually good root-cause documentation — it states the wrong-mapping mechanism precisely enough (season-3 local files colliding with season-2 DB rows) that I could independently re-derive and check the claim without needing to ask the builder anything.
- The residual-gap section in `BUGS_AND_FEATURES.md` (episodes 119/236/240) correctly resists the temptation to claim total victory — it draws an honest line between "loader bug, now fixed" and "content-ingestion gap, needs a separate transcript backfill," and names the exact follow-up loader (`load_iyagi.py`).
- The runbook (`BUGS_AND_FEATURES.md:19`) correctly identifies this as a plain loader re-run against live `km-db`, not a migration, and correctly did NOT attempt that live-DB run itself — consistent with `km_never_manually_apply_migrations.md`'s standing rule about not hand-running things outside the deploy runner.

## Ingest-test / ruff summary

| Check | Result |
|---|---|
| `pytest tests/test_load_ttmik_audio.py -q` (testcontainers, python:3.12) | 30 passed |
| `ruff check loaders/load_ttmik_audio.py` | All checks passed |
| `ruff check .` (whole `tools/ingest`, for the batch's soft-gate) | 21 pre-existing errors, 0 in this diff's files |
