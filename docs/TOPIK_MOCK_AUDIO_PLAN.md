# Plan: Real per-question listening audio for the official TOPIK mock tests

**Status:** draft for sign-off · **Author:** Claude (investigation + design) · **Date:** 2026-07-27

## 1. Goal

Give the app's existing **official TOPIK mock tests** real listening audio, per question — the actual government past-exam recordings, aligned to the questions already in the database. No workarounds, no placeholder content. When a user takes a listening mock, each question plays its real spoken passage.

This is the proper resolution of ticket **F-119** ("mock listening has no audio").

## 2. What already exists (verified on disk + in the DB)

Everything needed is already here — the audio was simply never ingested.

| Piece | State |
|---|---|
| **Official listening audio** | 24 whole-section MP3s (12 papers × TOPIK I/II), 38–85 MB each, at `~/data/korean-master/corpus/TOPIK TEST/<N> - Nth TOPIK/TOPIK-{I,II}/<N>th-TOPIK-{I,II}-Listening-Audio.mp3`. **Already inside the read-only `/corpus` mount** the server sees. |
| **Questions** | 960 listening items in `topik_items` — **options** (printed → stored), **answer key** (stored), and the **per-question spoken transcript** stored as `stem`. |
| **Official transcript PDFs** | 22 of 24 papers (TOPIK I for a couple of papers has none — segmentation must tolerate this). |
| **Corpus-audio serving pattern** | Already built for TTMIK lessons (`routes/ttmik.ts` → `resolveAudioFile`/`streamCorpusAudio`, Range-capable, auth-only, traversal-guarded). |

The **Final Step** audio loaded earlier (the 6 `kind='topik'` user-audio sources) is a *different* book's tests and is **not** used for this — it can become an optional "extra listening practice" tile in Listen, or be removed. That's a separate, minor decision.

## 3. Core architectural decision: whole-file + per-question offsets

We store the audio as **one file per exam section** (the existing MP3) plus a **`(start_ms, end_ms)` window on each question**, rather than cutting ~960 clip files.

Why:
- **Zero derived files.** The 24 MP3s already sit in the read-only mount; clipping would need a writable output dir, ffmpeg in the loader image, and a full re-cut whenever a boundary is corrected. With offsets, a fix is a two-integer `UPDATE`.
- **Paired questions are free.** When one dialogue covers two questions (e.g. Q29–30), both rows carry the *same* span.
- **One cached file per exam.** A 50-question mock hits one URL; the browser Range-fetches and caches it once. 50 clips = 50 cached files.
- **Supports both playback modes** from the same data: per-question segment playback *and* a possible future "authentic once-through tape" mode.
- Boundary precision (~±250 ms via HTML5 `currentTime` seek + `timeupdate` clamp) is fine — real segments begin with the "N번" announcer and end in silence, so boundaries are naturally padded.

## 4. Schema — migration `078_topik_listening_audio`

Additive, expand-only, mirrors the existing `audio_path` contract from migration 035:

```sql
ALTER TABLE topik_tests  ADD COLUMN IF NOT EXISTS audio_path TEXT;
-- relative key under CORPUS_AUDIO_DIR, e.g.
-- 'TOPIK TEST/60 - 60th TOPIK/TOPIK-II/60th-TOPIK-II-Listening-Audio.mp3'
-- meaningful only on section='listening' rows; NULL = no audio mapped.

ALTER TABLE topik_items
  ADD COLUMN IF NOT EXISTS audio_start_ms INTEGER,
  ADD COLUMN IF NOT EXISTS audio_end_ms   INTEGER;

ALTER TABLE topik_items ADD CONSTRAINT ck_topik_items_audio_span CHECK (
  (audio_start_ms IS NULL AND audio_end_ms IS NULL)
  OR (audio_start_ms >= 0 AND audio_end_ms > audio_start_ms));
```

- Both-or-neither CHECK makes a half-written span impossible.
- Segmentation provenance (confidence, aligner version, matched "N번" marker, source MP3 sha256) lives in the existing `topik_items.extra` JSONB under an `audio_seg` key — no extra columns.

## 5. Segmentation (the crux) — accurate *and* self-checking

Each whole-section MP3 plays: instructions → example (보기) → "1번" [passage] → "2번" [passage] → … Every question is announced by number, and **we already have each question's transcript in `topik_items.stem`** as ground truth. So segmentation is aligned and *validated*, not guessed:

1. **Transcribe** each MP3 with Whisper `large-v3` producing **word/segment timestamps** (the same GPU worker used for the corpus).
2. **Anchor** on the spoken "N번" markers in the timestamped output (Whisper picks these up cleanly — proven on the Final Step audio, e.g. "3번 …", "5번 …").
3. **Validate + refine**: for each question N, fuzzy-match the audio text between anchor N and N+1 against the DB `stem` for item N (normalized Korean similarity). A high match confirms the boundary; a low match flags the paper for manual review rather than writing a bad span.
4. **Emit** one JSON artifact per paper:
   ```json
   { "test_number": 60, "topik_level": "TOPIK II", "audio_sha256": "…",
     "segments": [
       { "item_numbers": [1],      "start_ms": 12300,  "end_ms": 45100,  "confidence": 0.97, "marker": "1번" },
       { "item_numbers": [29,30],  "start_ms": 1523000,"end_ms": 1691000,"confidence": 0.91, "marker": "29~30번" } ] }
   ```
   `item_numbers` is an **array** — the paired-question contract (one segment → two items).

Design points:
- **Paired questions**: detected where the announcer says a range ("29번부터 30번") or where two consecutive items share stem text; both items get the one span.
- **Transcript-less papers** (a couple of TOPIK I papers, and the 60th's D-2 placeholder items): fall back to "N번" anchoring alone; lower confidence, flagged for review.
- **Confidence gate**: below a threshold (TBD in this workstream), the loader **skips** writing that span — the item keeps its transcript-only rendering rather than getting a wrong clip. Nothing silently mis-maps.
- **De-risk first**: prove the pipeline on **one paper** (35th TOPIK I — clean, has stems), eyeball every boundary against the audio, before running all 24.

## 6. Ingest — `tools/ingest/loaders/load_topik_audio.py` (new)

Modeled on `load_ttmik_audio.py` (keyed-UPDATE audio mapper, one transaction, no checkpoint state — it only writes UPDATEs, copies nothing). Two phases, one CLI, idempotent/re-runnable:

- **Phase 1 — map MP3s → `topik_tests.audio_path`.** Parse the *filename* (`(\d+)(?:st|nd|rd|th)-TOPIK-(I{1,2})-Listening-Audio.mp3`), keyed `UPDATE … WHERE test_number=? AND topik_level=? AND section='listening'` (the migration-029 natural key). Reports matched / files-without-row / tests-without-audio.
- **Phase 2 — write per-item offsets** from the Phase-5 segment JSONs. One segment fans out to N keyed UPDATEs (paired items), writing the same span + `extra.audio_seg`. Refuses a JSON whose `audio_sha256` ≠ the mapped MP3 (drift guard, the F-185 lesson). Validates each span against the CHECK before writing. Re-run = no-op.

Wired into `Deploy/load-corpora.sh` alongside the other loaders. **No clip files are produced** — the only audio files are the 24 originals already under the mount.

## 7. Serving route — `GET /topik/audio/:testNumber/:level`

- Under `/topik` (already `requireAuth`; `/topik` is **already in the km-lb nginx allow-list on both colors** → zero infra change). `level ∈ {1,2}` → `TOPIK I`/`II`. `mediaLimiter`.
- Handler resolves `audio_path` for the paper, then streams via the shared corpus streamer.
- **Extract first**: move `resolveAudioFile` + `streamCorpusAudio` out of `routes/ttmik.ts` into a new `server/src/services/corpusAudio.ts` (the same clean extraction we did for `rangeStream.ts`), so TTMIK and TOPIK share one hardened streamer — all defenses intact (relative-only, lexical containment, realpath symlink check, uniform 404, `audio/mpeg`, `Cache-Control: private, max-age=86400`; stored paths contain spaces, which the resolver already handles).
- **Not** on `/audio/...` — that's the user-scoped Track A surface (IDOR-guarded). Shared exam audio must be non-user-scoped.

## 8. Server DTO + mock wiring (`routes/topik.ts`)

- `ITEM_COLUMNS` += `i.audio_start_ms, i.audio_end_ms, t.audio_path` (the `t` join already exists).
- Row type + `mapRowToDTO` + `toMockItemDTO` carry `audioStartMs?/audioEndMs?` (emitted only when both present) — timing is *question* metadata, so it rides through the mock DTO exactly like `hasImage`/`passage`; the answer strip is untouched.
- `POST /topik/mock` envelope gains `audioUrl: string | null` = `/topik/audio/<test>/<level>` when the paper has `audio_path`.

## 9. Client (`MockMode.tsx`)

- One persistent `<audio preload="metadata" src={buildAudioSrc(test.audioUrl)}>` for the whole exam. "Play question audio" sets `currentTime = audioStartMs/1000`, plays, and a `timeupdate` handler pauses at `audioEndMs/1000`. Same element across items → the section file stays buffered; palette free-jumps just re-seek.
- Replace the F-119 "no audio" note with the player when `audioUrl` + the item's span exist; keep the honest note as the per-item fallback for anything still unmapped.
- `AUDIO_URL_ALLOW` (client) gains `topik/audio/\d+/[12]`; reuse `buildAudioSrc`. Types: `TopikMockItem` += `audioStartMs?/audioEndMs?`, `MockTest` += `audioUrl`.

## 10. Phasing (each phase → full `/fixpass`)

| Phase | Deliverable |
|---|---|
| **0** | This plan + sign-off on §12 decisions |
| **1** | Migration 078 + db tests |
| **2a** | Segmentation pipeline proven on **one** paper (35th TOPIK I), boundaries eyeballed |
| **2b** | Run segmentation over all 24 papers → segment JSONs + a QA report (confidence distribution, flagged papers) |
| **3** | `load_topik_audio.py` (map audio_path + write offsets), run against prod km-db (approved dry-run → apply) |
| **4** | Extract `corpusAudio.ts` + `GET /topik/audio/:test/:level` |
| **5** | Server DTO + mock envelope `audioUrl` |
| **6** | Client `MockAudioPlayer` in `MockMode` |
| **7** | Deploy (blue/green) + verify a real listening mock plays |

## 11. Risks

- **Segmentation accuracy** is the load-bearing risk. Mitigated by: DB-stem validation per question, a confidence gate that skips rather than mis-maps, transcript-PDF cross-check where available, and a one-paper proof before the full run. Some papers may need manual boundary nudges (cheap — a 2-integer UPDATE).
- **Paper 60 TOPIK I** has 28/30 placeholder question stems (pre-existing gap) — its audio can be mapped but those items stay excluded until the questions themselves are filled (out of scope here).
- **Whisper time** — 24 × 38–85 MB files is a few hours of GPU, one-time.

## 12. Decisions — SIGNED OFF (2026-07-27)

1. **Re-admit the 28 placeholder items ONCE THEY HAVE AUDIO.** ✅ Widen `ANSWERABLE_ITEM_SQL` (and the render-time guard) so an item passes when it has an audio span even if its stem is the `[듣기 지문 없음]` placeholder. Serving counts change — expected.
2. **NO transcript text during the mock exam** (pure listening) — but **the transcript IS shown in the library's TOPIK "review your mistakes" view**, where users go over wrong answers. So: hide the stem/transcript in the timed `ExamRunner`; keep it visible in the mock results/review surface.
3. **Unlimited per-question replay** for now.
4. **Mock-only first.** Study-mode audio is deferred — flag it as a follow-up (a later phase), do not surface audio in the non-mock study view in v1.
5. **Segmentation confidence threshold: tuned during Phase 2a** on the proof paper.
6. **Keep the Final Step audio as an "extra TOPIK listening" practice tile** in Listen (part of the tiles work) — good content, not the official exams. Not removed.
