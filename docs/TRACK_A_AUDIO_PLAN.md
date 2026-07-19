# Track A — Audio → Listen (Whisper). Build Plan

**Status:** proposal for review (not yet started). Written 2026-07-18.
**Goal:** get the ~1,021 owned Korean audio files transcribed and playable inside
the app's **Listen** surface, with transcripts, ideally aligned to the paired
reading books. This is the last and largest of the three content-ingest tracks
(P = comics/viewer ✅ done; B = books → Read ✅ done; A = audio → Listen).

This plan is grounded in the actual codebase (file/line references throughout),
not a greenfield sketch. The headline architectural fact drives everything
below.

---

## 0. The one hard problem: there is no background worker

Every "async job" in this repo today runs **synchronously inside the HTTP
request**. The `upload_extractions` system (`db/migrations/069_*`,
`server/src/services/uploadExtract.ts`) documents its own pattern explicitly:

- **The INSERT is the claim** — a partial unique index
  (`uq_upload_extractions_upload_live … WHERE status IN ('pending','running')`)
  makes a second concurrent claim fail with a 23505 → 409.
- **Settle** via a status-guarded `UPDATE … WHERE id=$1 AND status='running'`
  (idempotent; a duplicate settle is a no-op).
- **Reap** stale rows lazily, *inside the next claim transaction* — there is no
  reaper process.

Vision OCR fits this because a page-range OCR finishes within one request.
**Whisper does not.** A single 30-minute mp3 is minutes of CPU; the full corpus
is ~150–200 hours of audio. We cannot hold an HTTP request open for that, and we
cannot block the single Node event loop on CPU-bound transcription.

**So Track A's genuinely new component is a real out-of-band job runner.** The
`069` tables and claim/settle/reap SQL are the *template*; we add the missing
loop. Everything else (blob storage, streaming, auth-scoping, the loader
pattern, the Listen surface) already exists and is copied.

Two credible runner designs — this is the **first decision to make**:

| Option | What it is | Pros | Cons |
|---|---|---|---|
| **A1. Separate worker process** | A second Node entrypoint (`worker.ts`) that polls `audio_transcription_jobs` with `SELECT … FOR UPDATE SKIP LOCKED`, shells out to Whisper, settles rows. Runs as its own container in the compose stack. | True isolation from the API event loop; horizontally scalable; the "correct" long-term shape. | New deployable + process supervision; more moving parts in the blue/green flow. |
| **A2. Offline operator script** (recommended to start) | A `tools/ingest` Python script that walks the corpus, runs Whisper locally on **M**, writes the transcript JSON, and loads via a standalone loader — exactly like the Track B OCR path we just used. No API involvement at all for bulk ingest. | Zero new runtime infra; mirrors the proven Track-B pipeline; keeps Whisper's heavy deps off the production image; we control it entirely on M. | Not a *user-facing* upload path — only we can add audio. Fine for the corpus; a user "upload your own audio" feature would still need A1 later. |

**Recommendation:** ship **A2 first** for the corpus (it's the same shape as the
OCR pipeline we just proved end-to-end), and treat **A1** (the in-app user audio
upload + worker) as a later, separately-scoped feature. This gets all the owned
audio into Listen fast, without standing up a new production process.

The rest of this plan assumes the **A2 corpus path** for Phase A, and notes
where A1 would diverge.

---

## 1. Scope for Phase A (corpus ingest)

**In:** transcribe the owned corpus audio; store transcripts; make each audio set
playable + readable in Listen; align the 3 confirmed book↔audio pairs so Read and
Listen reference the same content.

**Out (deferred to a later A1 phase):** user-uploaded audio, an in-app Whisper
job runner/process, real-time transcription. Also out: TOPIK mock-test listening
audio wiring (that's a separate mapping problem, F-185 class).

**Corpus (from the inventory):** ~1,021 files (~1,142 counting the loose files),
~150–200 hr, ~3.6 GB, mp3 (Folktales = m4a). Sets: TTMIK grammar audio L1–L10, TOPIK 1 (87) + TOPIK 2
(108) listening, News In Korean (50), Real-Life Conversations (90), Easy Korean
Reading (30), Folktales (35), plus loose files. **3 confirmed book↔audio pairs:**
Easy Korean Reading (book id=18), Korean Folktales (id=17), Real-Life
Conversations (id=19).

---

## 2. Data model (new migrations, starting at 073)

Following the exact repo conventions (3-digit sequential, header block with
`Reverse:`/`Depends on:`, no top-level BEGIN/COMMIT, enum guards via `DO $$`,
`set_updated_at` trigger, `created_at/updated_at/version` + `version >= 1` check,
a matching `db/tests/test_migration_NNN.py`).

**`073_audio_sources`** — one row per audio set/collection (the "book" analog).
- `id`, `user_id` (CASCADE, denormalized for scoping),
- `slug TEXT` (stable set key, e.g. `easy-korean-reading`), `title TEXT`,
- `kind TEXT + CHECK` in `('paired_reader','standalone_listening','topik')`,
- optional `source_upload_id BIGINT NULL` → `book_uploads(id)` for paired sets
  (composite `(source_upload_id, user_id)` owner FK, mirroring
  `044_reading_chapters`), so a paired audio set is structurally tied to its book,
- `status` in `('processing','ready','failed')`, audit cols,
- `UNIQUE (user_id, slug)`.

**`074_audio_tracks`** — one row per mp3 file (the "book_pages" analog).
- `id`, `source_id BIGINT NOT NULL` → `audio_sources(id) ON DELETE CASCADE`,
- `user_id` denormalized,
- `track_number INTEGER`, `title TEXT`,
- **`blob_ref TEXT NOT NULL`** (relative path under a new
  `AUDIO_UPLOAD_STORAGE_DIR`, CHECK length 1..1024 — identical contract to
  `book_pages.blob_ref`),
- `duration_ms INTEGER NULL`, `byte_size BIGINT`,
- `transcript_status` in `('pending','running','done','failed')`,
- optional `chapter_id BIGINT NULL` → `reading_chapters(id)` for alignment
  (a track that corresponds to a reading chapter),
- `UNIQUE (source_id, track_number)`, audit cols.

**`075_audio_transcript_segments`** — Whisper output, one row per segment.
- `id`, `track_id BIGINT NOT NULL` → `audio_tracks(id) ON DELETE CASCADE`,
- `segment_number INTEGER`,
- `start_ms INTEGER NOT NULL`, `end_ms INTEGER NOT NULL` (for word-highlight sync),
- `body TEXT` (CHECK 1..5000),
- `UNIQUE (track_id, segment_number)`.
- Segments (not one blob) so the Listen UI can highlight the current line as
  audio plays, and so a paired reader can line up passages ↔ segments by time.

**`076_audio_transcription_jobs`** — the claim/settle/reap table, copying `069`
but with a **real `'pending'` state a worker actually claims** (069 reserved
`'pending'` for a future runner; this is that runner).
- Same shape as `069`: `status ('pending','running','done','failed')`, partial
  unique index `WHERE status IN ('pending','running')` keyed on `track_id`,
  `started_at/finished_at`, `error TEXT`, a `charged_bytes` enqueue-time cost
  snapshot (069's `pages_requested` analog), and the reap/orphaned-pending
  worker contracts pinned in the migration header.
- Only exercised by the **A1** (in-app worker) path — the **A2** offline
  loader writes segments directly and bypasses this table entirely. Built in
  the A-1 schema phase anyway (as shipped) so the claim arbiter and cost
  ledger exist from day one and `charged_bytes` never needs a backfill.

**`077_listening_source_kind_audio_track`** — widen the existing discriminator.
- `listening_attempts.source_kind` is `TEXT + CHECK` today
  (`061_listening_attempts.up.sql`, values `'ttmik_lesson','iyagi_episode'`).
- Add `'audio_track'` to the CHECK, plus a nullable `track_id BIGINT NULL`
  → `audio_tracks(id) ON DELETE SET NULL` target column, and extend the
  `ck_..._target_not_both` at-most-one-target constraint. This lets the existing
  attempt-logging + "listened today" plumbing count user-audio listens with zero
  new surface.

---

## 3. Blob storage (copy uploadStore.ts)

Audio bytes go on the **local filesystem**, not Postgres — same as page images.
Add `AUDIO_UPLOAD_STORAGE_DIR` (default `./var/audio-uploads`) to
`server/src/config/index.ts`, and an `audioStore.ts` that is a near-verbatim copy
of `uploadStore.ts`: `saveBlob(userId, trackId, ext, buffer)` →
`{userId}/{uuid}.{mp3|m4a}`, `resolveUnderRoot`, `assertUnderRoot` traversal
guard, `deleteBlob`. Path built only from server-trusted values (session userId +
server UUID + sniffed mime) — never client input.

For **A2**, the offline loader copies the mp3s into this dir (or we point
`blob_ref` at the existing corpus location under a read-only `CORPUS_AUDIO_DIR`,
reusing the `035_ttmik_audio` model — decision noted below).

---

## 4. Streaming route (copy streamCorpusAudio, add user-scoping)

The Range-capable streamer already exists: `streamCorpusAudio()` in
`server/src/routes/ttmik.ts:658-715` (RFC 9110 single-range, 206/Content-Range/
Accept-Ranges, 416 unsatisfiable, `audio/mpeg`, `Cache-Control: private`). It's
built for the *public* corpus, so it does existence-only checks.

New route `GET /audio/tracks/:id/stream` (new `server/src/routes/audio.ts`,
mounted `/audio`):
- `requireAuth` + `const userId = getUserId(req)`.
- Resolve the row **user-scoped**: `SELECT blob_ref FROM audio_tracks
  WHERE id=$1 AND user_id=$2` — a miss is a **uniform 404** (the repo's IDOR
  convention; never 403, never confirm existence).
- Feed `blob_ref` through `audioStore.resolveUnderRoot` (traversal defense),
  then reuse the exact `parseRangeHeader` + stream logic from `ttmik.ts`.
  Factor the range-streamer into a shared helper both routes call, rather than
  copy-paste.
- Client-side: extend the `AUDIO_URL_ALLOW` allow-list regex in
  `client/src/services/ttmik.ts:100` (or a new audio service) to accept
  `^\/audio\/tracks\/\d+\/stream$`, so `buildAudioSrc` will render it.

## 5. Listing + reading routes (copy reading.ts)

New `GET /audio/sources` and `GET /audio/sources/:id` (with tracks + segments),
parallel to `GET /reading/chapters` — same `assertOwnedUpload`-style
`WHERE user_id=$1` scoping. For paired sets, the response links
`source_upload_id` / `chapter_id` so the client can offer "read along."

## 6. Whisper transcription service (the offline engine)

New `tools/ingest/audio_stt/` (mirrors `tools/ingest/reading_ocr/`):
- `whisper_transcribe.py`: runs **faster-whisper** (or openai-whisper) locally on
  M with a Korean model (`large-v3` for accuracy; `medium` if throughput
  matters), `language="ko"`. Emits `{track, segments:[{start_ms,end_ms,body}]}`.
- Batch driver that walks a corpus set dir, transcribes each file, writes a
  curated `audio_source` JSON (sources → tracks → segments), the same
  cache-the-expensive-pass discipline we used for OCR (transcribe once → cache
  JSON → all structure work local).
- **This is the mechanical-engine parallel to Vision OCR**: Whisper produces the
  transcript text mechanically from owned audio; our tooling only maps structure.
  Same copyright-clean line as Track B.

## 7. Audio loader (copy load_literature.py)

New `tools/ingest/loaders/load_audio.py`, standalone CLI addressed by
`source_upload_id`/slug, exactly like `load_literature.py`:
- Pydantic model validation → `_validate` bounds pre-check → one transaction:
  resolve+lock owner, DELETE-then-INSERT sources/tracks/segments (structural
  idempotency), assert counts, flip `audio_sources.status='ready'`.
- Runs in the `km-loader:<tag>` container on `km-internal` (km-db not
  host-exposed), same invocation as the literature loader.
- Blobs: the loader (or a pre-step) copies mp3s into `AUDIO_UPLOAD_STORAGE_DIR`
  and records `blob_ref`.

## 8. Book↔audio alignment (the payoff)

For the 3 paired readers, set `audio_tracks.chapter_id` → the matching
`reading_chapters.id` (same book we already ingested in Track B). Then:
- Listen page shows "read along" → deep-links to the reading chapter.
- Reading page shows a "listen" affordance when a chapter has a linked track.
- Time-coded segments enable line highlighting during playback (post-MVP).

Alignment granularity to decide: **chapter-level** (one track ↔ one chapter,
trivial, ship first) vs **passage-level** (segment timestamps ↔ passages, needs a
matching pass, later).

---

## 9. Security threat model (per standing security orders)

Audio + transcripts touch user data, file streaming, and the AI layer. Attack
vectors and defenses:

1. **IDOR on streaming / listing** (read another user's audio). → Every query
   `WHERE user_id = getUserId(req)`; miss → uniform 404; DB composite owner FK on
   paired sources makes cross-user rows structurally impossible.
2. **Path traversal / symlink escape** via `blob_ref`. → `blob_ref` is never
   client-supplied (server UUID); `resolveUnderRoot` + `assertUnderRoot`
   trailing-sep prefix check + realpath symlink check (copied from uploadStore /
   ttmik resolveAudioFile).
3. **Malicious upload bytes** (A1 path only). → magic-byte mime sniff (not
   extension), size cap, decode in a subprocess (Whisper/ffmpeg) never in the
   event loop; reject non-audio.
4. **Transcript → prompt injection.** Whisper output is untrusted text that will
   flow into AI features (definitions, coaching). → fence + sanitize before it
   enters any prompt (the design doc's "transcript fence+sanitize"); treat
   segment `body` as data, never instructions.
5. **DoS via huge/long audio** (A1). → duration + byte caps, a per-user daily
   transcription-minutes cap (mirror `UPLOAD_EXTRACT_DAILY_PAGE_CAP` via
   `pg_advisory_xact_lock`), job concurrency = 1 live per track (partial unique
   index).
6. **Streaming resource exhaustion.** → `createReadStream().pipe(res)` (bounded
   memory), Range support so clients fetch slices, `Cache-Control: private`.
7. **Storage exhaustion.** → cap total per-user audio bytes; clean blobs on
   source delete (best-effort unlink after commit, like uploads DELETE).

---

## 10. Phasing / PR breakdown

Each PR is independently shippable and goes through the full build → tests →
**/fixpass** gate (full suite for the schema PRs, per the schema-change rule).

- **A-0 (this doc):** plan + decisions. ← you are here.
- **A-1 migrations:** 073–077 (076 = the jobs table, 077 = the source_kind
  widen — see §2) + `db/tests/` for each. No behavior yet.
- **A-2 Whisper tooling:** as built, this became the **A1 in-app worker**
  (decision reversed from the A2-first recommendation above), split in two:
  - **A-2a (merged):** `tools/audio_stt/` — a pure-Python worker
    (`python -m tools.audio_stt.worker`) that drains `audio_transcription_jobs`
    (076 claim/settle/reap) and transcribes with faster-whisper.
  - **A-2b (packaging):** `Deploy/worker.Dockerfile` (CUDA 12.4 + cuDNN 9 base,
    ffmpeg, large-v3 weights BAKED into the image — km-internal has no egress)
    + a single long-lived `km-worker` service in `docker-compose.shared.yml`
    (shared project like km-backup: the queue makes it color-agnostic and the
    one GPU can't be shared; nvidia device reservation; km_app DSN; reads the
    name-pinned `km_audio_uploads` volume read-only at `/var/audio-uploads`)
    + `ensure-shared-volume.sh` creates `km_audio_uploads`
    + `build_worker` / `run_worker_once` in `deployment-utils.sh` (the image is
    built ON M — multi-GB, never CI-shipped).
- **A-3 loader + storage:** `load_audio.py` + `audioStore.ts` + config; load the
  pilot set; verify rows.
- **A-4 serving:** `routes/audio.ts` (stream + list) + client allow-list +
  Listen UI wiring via the existing `source_kind` plumbing.
- **A-5 alignment:** link the pilot reader's tracks ↔ reading chapters; "read
  along" / "listen" affordances.
- **A-6 bulk:** transcribe + load the remaining sets (News, TOPIK, Folktales,
  Real-Life Conversations, etc.).
- **A-7 (separate, later):** A1 in-app user-audio upload + real worker process.

---

## 11. Decisions I need from you

1. **Runner:** A2 offline operator path first (recommended), or stand up the A1
   in-app worker process now?
2. **Whisper model:** `large-v3` (best Korean accuracy, slower) vs `medium`
   (faster, still good) — affects how long the ~150–200 hr bulk pass takes on M.
3. **Blob location:** copy mp3s into a new `AUDIO_UPLOAD_STORAGE_DIR` (user-owned,
   like uploads), or reference them in place under the existing read-only
   `CORPUS_AUDIO_DIR` (like the TTMIK/Iyagi corpus model)? Owned-copy is cleaner
   for per-user semantics; in-place saves 3.6 GB of duplication.
4. **Alignment granularity:** ship chapter-level links first, or invest in
   passage-level time alignment up front?
5. **Pilot set:** start with Easy Korean Reading (30 files, clean pair), agreed?
