# /fixpass plan — F-012 (TTMIK/Iyagi audio)

Branch: `feat/ttmik-audio` (backend + UI merged, combined-verified: client 628 + server ttmik 51 green). NOT pushed/deployed.
Bar every reviewer reads: `/home/jared-williams/projects/SENIOR_ENGINEER_BAR.md`. Reviewers = independent, did NOT write code, cite file:line, categories BLOCKER/SHOULD-FIX/NIT/PRAISE, output `db/docs/REVIEW_F012_<x>.md`, do NOT edit code. Dispatch 3 in parallel (worktree NOT needed — read-only). Model: sonnet (cost).

## R1 — Audio streaming + security (HIGHEST RISK)
Files: `server/src/routes/ttmik.ts` (audio endpoints), `server/src/config/index.ts` (CORPUS_AUDIO_DIR), `Deploy/docker-compose.{blue,green}.yml` (ro mount).
Focus:
- Path escape: can a crafted req OR a tampered `audio_path` (treat DB value as hostile) escape `CORPUS_AUDIO_DIR`? Verify normalize + lexical-prefix + realpath containment + symlink-escape kill. Absolute-path reject.
- Range: 206 + Content-Range correct; suffix ranges; end-clamp to EOF; 416 + `bytes */total` on unsatisfiable; malformed Range → 200 (RFC 9110); multi-range handling.
- Auth on ALL audio routes; uniform 404 (no existence oracle); Content-Type audio/mpeg + Content-Length/Accept-Ranges.
- Resource: STREAMS not buffers whole file; file handle/stream closed on client abort; no fd leak.
- Compose mount is `:ro`; env wiring correct.
BLOCKER bar: any traversal/symlink escape, missing auth, whole-file buffer, fd leak.

## R2 — Migration + loader + data endpoints
Files: `db/migrations/035_ttmik_audio.up.sql` + `.down.sql`, `tools/ingest/loaders/load_ttmik_audio.py` (+ dispatcher reg in `load_to_postgres.py`), the LIST/DETAIL handlers in `server/src/routes/ttmik.ts`, `server/tests/routes/ttmik.test.ts`.
Focus:
- Migration: ADR-013 style (no BEGIN/COMMIT), nullable add, `down` truly reverses (drop cols), checksum-safe.
- Loader: filename regex covers ALL real variants of the 1,179 files (Iyagi `<N> TTMIK Iyagi <N>.mp3`, Lessons `<track> TTMIK Level <L> Lesson <M>.mp3`). Idempotent; first-wins dup; unmatched/unparsed counted not crashed. `audio_path` = RELATIVE key, NEVER host-absolute. (Reviewer MAY dry-run parsing vs a `find` listing of real filenames — read-only, do NOT write km-db.)
- Endpoints: list ordered (level,number)/(number); detail joins sentences ordinal-ordered; `hasAudio` derived from audio_path non-null; parameterized queries; requireAuth.
- Tests would fail on pre-fix behavior.
BLOCKER bar: irreversible migration, audio_path stores a host path, loader crashes on a real filename, SQL injection.

## R3 — Client UI
Files: `client/src/pages/Ttmik.tsx` (+ .test), `client/src/services/ttmik.ts` (+ .test), `client/src/types/domain.ts`, `client/src/App.tsx`, `client/src/lib/nav.ts`.
Focus:
- `buildAudioSrc`: rejects off-origin/protocol-relative (`https://`, `//…`) so a tampered `audioUrl` can't point the player off-site; joins app-relative onto the api base; cookie rides same-origin (prod) + same-site dev.
- Real `<audio controls>` (NOT fake AudioBlock/B-004); seek works (Range). Read-along transcript escaped React children (XSS); ordinal order; speaker label on dialog.
- States: `audioUrl===null`/`hasAudio===false` → transcript-only note, no player; loading; ErrorCard+Retry; empty list. a11y (rows are buttons not icon-only; audio caption disable justified).
- Route/nav appended cleanly; nav exhaustiveness passes.
BLOCKER bar: XSS sink, player can be pointed off-origin, broken-by-construction.

## After reviews
Aggregate (table + every BLOCKER + top SHOULD-FIX + PRAISE-to-keep) → 1 independent fix-pass agent (all BLOCKER + SHOULD-FIX, add tests) → 1 fresh re-reviewer (verify fixes hold, no regressions). Then go-live sequence (below).

## Go-live sequence (after fixpass PASS)
1. Push `feat/ttmik-audio` + open PR into `rebuild` (Jared merges).
2. Set `CORPUS_AUDIO_DIR_HOST=/home/jared-williams/data/korean-master/corpus` in `Deploy/.env`.
3. Apply migration 035 to live km-db.
4. Run loader `--corpus ttmik_audio --audio-dir <corpus root>` against live km-db (populates audio_path for the 1,179 mp3s).
5. Blue/green deploy: build → stage IDLE color → health-check → flip. (Corpus mount must resolve on the host at CORPUS_AUDIO_DIR_HOST.)
6. Hard-refresh; test /ttmik (Listen tab): browse + play + read-along.
