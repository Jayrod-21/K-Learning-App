# Review

**Scope:** F-012 TTMIK audio — data layer only (migration 035, loader
`load_ttmik_audio.py` + its registration, LIST/DETAIL handlers in
`server/src/routes/ttmik.ts`). The audio-stream handlers and the shared
`streamCorpusAudio`/`resolveAudioFile` code are explicitly out of scope
(owned by R1) and were only skimmed for context, not reviewed.

**Reviewer:** independent read-only pass against `feat/ttmik-audio`. No files
were modified; no writes were made to any database. The corpus dry-run below
used `find` only (read-only) against the real mp3 tree at
`~/data/korean-master/corpus/TTMIK`.

## Verdict

**APPROVE WITH SHOULD-FIX ITEMS.** No blocker. The migration is textbook-clean
(ADR-013 compliant, truly reversible, well-commented). The loader is
idempotent, deterministic, crash-safe on unparseable/duplicate input, and
never stores a host-absolute path. The endpoints are correctly ordered,
parameterized, and auth-gated. Two real gaps found by the filename dry-run are
worth fixing before this ships as "done," but neither is a shipped-broken
defect: both degrade to a documented, counted, logged "no audio" state rather
than a crash or a silent corruption.

- **BLOCKER: 0**
- **SHOULD-FIX: 3**
- **NIT: 2**
- **PRAISE: 5**

## Findings

### BLOCKER
None.

### SHOULD-FIX

1. **Parser misses 3 real, in-scope audio files that are the *only* audio
   for their lesson/episode** — `tools/ingest/loaders/load_ttmik_audio.py:56-67`
   (`_LESSON_RE` / `_IYAGI_RE`). Real filenames:
   - `Lessons/Lesson 3/17 TTMIK Level 3 Lesson 17-1.mp3` (no companion
     `...Lesson 17.mp3` exists — this IS lesson (3, 17)'s audio)
   - `Lessons/Lesson 5/20 TTMIK Level 5 Lesson 20-1.mp3` (same — lesson (5, 20))
   - `이야기들/이야기/67 TTMIK Iyagi 67-1.mp3` (same — episode 67)

   The trailing `-1` before `.mp3` breaks the `\s*\.mp3$` anchor. These are
   reported (`files_unparsed`, `log.warning("unparsed_mp3", …)`), so it's not
   *silent* in the log — but at 801 total unparsed files in a real run
   (see dry-run below), 3 genuine misses are invisible in the noise, and
   the practical effect is real: lesson (3,17), lesson (5,20), and iyagi
   episode 67 will show `hasAudio: false` forever even though the mp3 exists
   on disk, because nothing else in the pipeline re-parses `files_unparsed`.
   Fix: tolerate an optional `-\d+` suffix, e.g.
   `r"ttmik\s+level\s+(\d{1,2})\s+lesson\s+(\d{1,3})(?:-\d+)?\s*\.mp3$"` and
   the Iyagi equivalent. Add a regression fixture for exactly this shape (Bar
   §5.2 — "every bug fix ships with a regression test that fails on the old
   code"); `tools/ingest/tests/test_load_ttmik_audio.py` currently has no
   case shaped like `<N> TTMIK Level <L> Lesson <M>-1.mp3`.

2. **Docstrings claim the two documented patterns are "ground truth" for all
   1,179 files — they're ground truth for only 378 (32%)** —
   `tools/ingest/loaders/load_ttmik_audio.py:9-14` ("Filename ground truth
   (1,179 files): ...") and `db/migrations/035_ttmik_audio.up.sql:3` ("the
   corpus ships 1,179 TTMIK mp3s (lesson tracks + Iyagi episode
   recordings)"). Both are factually incomplete: 796 of the 1,179 real files
   (67.5%) belong to a third course, "How To Sound Like A Native Korean
   Speaker" (`TTMIK/How To Sound Like A Native Korean Speaker/Chapter
   N/Lesson M/Chapter N Lesson M NN.mp3`), which has **no corresponding
   table** — it was never text-ingested (no `corpus_sources` row, no
   `ttmik_lessons`/`iyagi_episodes` analog), so there is nowhere for this
   loader to write those 796 paths even if the regex matched them. This is
   confirmed as a known, deliberate scope boundary — `BUGS_AND_FEATURES.md:395`
   calls it out explicitly as "a bonus … set" — so it is **not a defect in
   this deliverable**, but the two docstrings read as if 1,179 ≈ "the corpus
   this loader covers," which will mislead the next engineer who greps them
   while debugging a "68% miss rate." Fix: state the true split in both
   places (378 lesson+iyagi files this loader maps; 796 bonus-course files
   that are intentionally out of scope pending a future table) so nobody
   re-discovers this by surprise.

3. **`tools/ingest/tests/test_load_ttmik_audio.py`'s fixture tree doesn't
   exercise the majority-shape file** — `_build_fixture_tree` (line 86-100)
   covers clean lesson/iyagi names, one unparseable name, and one duplicate,
   but nothing shaped like the real corpus's dominant pattern (`Chapter N
   Lesson M NN.mp3` / `Chapter N MM.mp3`, ~68% of real files) or the `-1`
   suffix from finding #1. Given the real corpus is majority "unparsed by
   design," a fixture case naming that shape explicitly (with a comment
   saying why it's expected to land in `unparsed`, not `duplicates`) would
   make the test suite doc itself instead of relying on this review to
   explain it.

### NIT

1. `files_without_row` (`load_ttmik_audio.py:172-206`) merges lesson-file and
   episode-file mismatches into one untyped `list[str]` — fine for log
   output (which is all it's used for today), but if a caller ever wants
   `lessons_without_row` vs `episodes_without_row` counts separately (e.g. a
   future ops dashboard), it'll need re-splitting. Not worth a change now,
   just flagging the coupling.
2. `server/src/routes/ttmik.ts:16-20`'s comment justifying unpaginated list
   endpoints cites "232 lessons / 139 episodes" — per the dry-run below the
   real counts are close (237/141 real audio files vs. those row counts) but
   worth a quick sanity check against the live `ttmik_lessons`/`iyagi_episodes`
   row counts before ship, since the comment is asserting a specific number
   as justification for skipping pagination.

### PRAISE

1. **Migration 035** is exemplary ADR-013 style: no `BEGIN`/`COMMIT`,
   `ADD COLUMN IF NOT EXISTS` / `DROP COLUMN IF EXISTS` (idempotent both
   ways), a `down` that is a complete, honest reversal (no dependent objects
   left behind to break it), and `COMMENT ON COLUMN` that pins the
   relative-path contract directly on the schema — a future engineer reading
   `\d ttmik_lessons` in psql sees the contract without opening this repo.
2. **Relative-path contract is enforced at the only place that can write the
   column**: `scan_audio_tree` (`load_ttmik_audio.py:114-144`) computes
   `path.relative_to(corpus_root).as_posix()` — structurally impossible to
   store a host-absolute path from this loader, which is exactly the
   BLOCKER-tier failure mode the task called out.
3. **Deterministic duplicate resolution**: `scan_audio_tree` walks
   `sorted(...)` paths and the first writer into `result.lessons`/`episodes`
   wins, with the loser reported in `scan.duplicates` (never silently
   dropped, never nondeterministic). Verified this holds with the real
   corpus too — zero natural-key collisions found in the dry-run (see below).
4. **Idempotency is actually proven, not asserted**: `test_loader_is_idempotent`
   runs the loader twice against `pg_container` and diffs both the report and
   the table rows — a real regression test, not a comment claiming safety.
5. **Endpoints are clean**: parameterized queries throughout (`$1`/`$2`,
   `%s`), `requireAuth` mounted once via `router.use` (can't be forgotten per
   route — proven by the `it.each` 401 test), correct `ORDER BY` on both list
   queries and the sentence sub-queries, `hasAudio` derived server-side from
   `audio_path IS NOT NULL` in both the list projection and the detail
   handler (no drift between the two).

## Detailed (file:line)

- `db/migrations/035_ttmik_audio.up.sql:29-47` — additive, nullable,
  commented; no index added (correct — audio_path is never filtered on, only
  selected via the existing unique keys).
- `db/migrations/035_ttmik_audio.down.sql:11-15` — plain `DROP COLUMN IF
  EXISTS` ×2, no blockers to a clean reversal since nothing else references
  the column.
- `tools/ingest/loaders/load_ttmik_audio.py:56-67` — regex definitions; see
  SHOULD-FIX #1 for the `-N` suffix gap.
- `tools/ingest/loaders/load_ttmik_audio.py:114-144` — `scan_audio_tree`;
  correct relative-path construction, correct first-wins dedup, correct
  `FileNotFoundError` fail-loud guard for a mispointed `--audio-dir`
  (`:124-128`), including the "pointed at TTMIK/ itself" operator-mistake
  case (tested at `test_load_ttmik_audio.py:130-135`).
- `tools/ingest/loaders/load_ttmik_audio.py:174-221` — single transaction
  wraps every UPDATE plus the two `COUNT(*) ... WHERE audio_path IS NULL`
  reads, so the returned report numbers are always consistent with what was
  actually committed (no read-after-partial-write skew).
- `tools/ingest/load_to_postgres.py:50-68,219-225` — `ttmik_audio` correctly
  excluded from `ALL_CORPORA` (won't fire on a plain `--corpus all` run
  without a mounted audio dir) and `main()` hard-fails with a clear message
  if `--audio-dir` is missing when requested explicitly. Clean wiring.
- `server/src/routes/ttmik.ts:124-138` (list) / `:144-176` (detail) —
  ordering, parameterization, `hasAudio` derivation all correct; `:166`
  computes `hasAudio` from the fetched row rather than re-querying, so
  list and detail can't disagree on the same row.
- `server/tests/routes/ttmik.test.ts:123-221` — LIST/DETAIL coverage matches
  the handlers: ordered lists with mixed `hasAudio`, `audioUrl` null vs.
  populated, 404 for unknown keys, 400 for non-numeric/out-of-range params.
  These would fail against a pre-fix handler that hardcoded `hasAudio` or
  omitted the `ORDER BY`.

## Loader dry-run

Ran the loader's exact regexes (copied verbatim, not re-derived) against
every real file under `~/data/korean-master/corpus/TTMIK`
(`find ... -name '*.mp3'`, read-only):

```
Total real mp3 files:            1,179
Matched → LessonKey:                237
Matched → EpisodeKey:                141
Total matched (this loader's scope): 378   (32.06% of all 1,179 files)
Unparsed:                            801
Duplicate-key collisions:              0
```

Breaking down the 801 unparsed by cause:

- **796 files** — "How To Sound Like A Native Korean Speaker" bonus course
  (`Chapter N/Lesson M/Chapter N Lesson M NN.mp3`, plus some `Chapter N
  QN.mp3` quiz tracks). **Correctly out of scope**: no DB table exists for
  this course at all (see SHOULD-FIX #2) — not a parser defect, a scope
  boundary that should be documented rather than left implicit.
- **2 files** — `Lessons/Lesson 1/26 TTMIK Level 1 Dialog.mp3` and
  `Lessons/Lesson 2/31 TTMIK Level 2 Dialog.mp3`: bonus dialog tracks with no
  lesson number in the filename at all — correctly unparseable by any
  reasonable regex (there is no natural key to extract), not a defect.
- **3 files** — the `-1`-suffixed continuation files from SHOULD-FIX #1
  (`Lesson 3/17 ... Lesson 17-1.mp3`, `Lesson 5/20 ... Lesson 20-1.mp3`,
  `이야기/67 ... Iyagi 67-1.mp3`). These ARE within the two documented
  ground-truth patterns and ARE the sole audio for their lesson/episode —
  this is the one genuine parser gap found.

Restricting to just the two corpora this loader is actually meant to cover
(`Lessons/` + `이야기들/이야기/`, 241 + 142 = 383 files, i.e. excluding the
796 out-of-scope bonus files): **378 / 383 matched (98.7%)**, with the 5
misses being the 2 "Dialog" files (unmappable by design) and the 3 `-1`
files (fixable per SHOULD-FIX #1).
