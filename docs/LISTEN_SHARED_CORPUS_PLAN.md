# Plan: Shared curated corpus + swipeable Listen tiles (F-207)

**Status:** draft for sign-off · **Date:** 2026-07-29 · relates to F-197 (Track-A audio ingested)

## 1. Goal

Reorganize the **Listen** page into swipeable, themed tile-pages (phone-home-screen style, with page dots), and promote the content Jared has already ingested into a **shared curated corpus** every account sees. Testers (e.g. Erin) get the same rich library; their own uploads stay private.

## 2. Product decisions (locked 2026-07-29)

1. **Shared corpus (Option B).** Everything Jared has ingested *now* becomes shared/curated — visible to all accounts, **read-only**. Anything a user uploads *after* this cutover stays private to them. Revisit at the app's 1.0.
2. **"My Audio" = own uploads made from here on only.** Jared's current content leaves "My Audio" (it becomes curated); "My Audio" now shows *owned-by-me AND not-shared*. Falls out of the same flag automatically.
3. **Tiles open both Listen and Read** where a reading version exists (Folktales, Easy Korean Reading, Real-Life Conversations). Audio-only categories (Blue Jindo Dog, News in Korean, TTMIK Grammar) are listen-only.
4. **Keep the current 3 tiles** (TTMIK Lessons, Iyagi Episodes, My Audio); add the six new categories; rearrange into swipe-pages.
5. **Nothing excluded** — all currently-ingested content is shared for testing.

## 3. The content (verified in live km-db)

All six target categories already exist as ingested, transcribed Track-A audio (`audio_sources`/`audio_tracks`, `kind='standalone_listening'`, F-197): `news-in-korean`, `jindo-dog`, `ttmik-grammar-level-1..10`, `korean-folktales`, `real-life-korean-conversations-intermediate`, `easy-korean-reading-beginners`. Three also have OCR'd book/reading versions in `book_uploads` (Folktales id 17, Easy Reading 18, Real-Life Conversations 19).

## 4. Core design: an `is_shared` flag (NOT re-owning)

`user_id` is woven into the composite FKs (`audio_tracks.(source_id,user_id) → audio_sources(id,user_id)`; `audio_sources.(source_upload_id,user_id) → book_uploads(id,user_id)`). Re-owning shared rows to a corpus account / NULL would break that graph. So:

- **Migration 079**: `ALTER TABLE audio_sources ADD COLUMN is_shared BOOLEAN NOT NULL DEFAULT false;` and the same on `book_uploads`. Owner (`user_id`) is unchanged → all composite-FK integrity + owner-only mutation preserved.
- The flag is **operator-set only** (no user-facing endpoint writes it) — a one-time cutover script flips it on Jared's current sets/books. New uploads default `false`.

## 5. Read-access changes (the security-sensitive part — threat-modeled)

The rule: **shared = readable by all, mutable by none but the owner.** Concretely:

| Surface | Today | After |
|---|---|---|
| `GET /audio` ("My Audio" list) | `WHERE user_id=$me` | `WHERE user_id=$me AND is_shared=false` |
| **NEW** shared-audio list (curated tiles) | — | `WHERE is_shared=true` (+ owner label), non-user-scoped |
| `GET /audio/tracks/:id/stream` (IDOR probe) | `WHERE id=$1 AND user_id=$me` | `WHERE id=$1 AND (user_id=$me OR is_shared=true)` — **read-only** |
| `GET /uploads`, reading chapters/pages | `WHERE user_id=$me` | shared surfaces add `OR is_shared=true`; "my uploads" stays `AND is_shared=false` |
| **All mutations** (rename/delete/upload/OCR-trigger, `POST/PATCH/DELETE`) | `WHERE id=$1 AND user_id=$me` | **UNCHANGED — owner-only** |

**Threat model (explicit, per standing security orders):**
- *Non-owner tampering* → every write path keeps `AND user_id=$me`; a non-owner can only read a shared row, never rename/delete/re-OCR it. Verified by tests that a 2nd account gets 200 on read, 403/404 on every mutation.
- *Share-flag hijack* → no user endpoint sets `is_shared`; it's operator/script only, so a user can neither share their own arbitrary content nor un-share/steal someone else's.
- *IDOR regression* → the stream probe only widens to `OR is_shared=true`; a private row (`is_shared=false`) owned by another user still 404s uniformly (no existence oracle). Test: account B streaming account A's *private* track → 404; A's *shared* track → 200.
- *Enumeration* → shared list returns curated sets only; private rows never leak into it.

## 6. Cutover (operator, one-time)

A small script (seed-style, run in the active container) flips `is_shared=true` on Jared's current `audio_sources` (all 21 sets) + the 3 curated `book_uploads`. Idempotent; logged. New content stays private.

## 7. Client — Listen page (`Ttmik.tsx`)

- Reuse `SwipeCarousel` (dots + swipe; already on Today/Progress). Group tiles into pages:
  - **Page 1 — Lessons:** TTMIK Lessons · TTMIK Grammar Textbook (one tile → level list) · Iyagi Episodes · Real-Life Conversations
  - **Page 2 — Stories & News:** Korean Folktales · Easy Korean Reading · Blue Jindo Dog · News in Korean
  - **Page 3 — Yours:** My Audio
- Each curated tile opens its set(s) via the new shared-audio list. Where a reading version exists, the collection view offers **Listen | Read** (Read → the existing chapter reader / upload viewer).
- TTMIK Grammar's 10 level-sets group under one tile → a level list.

## 8. Phasing (each phase → full `/fixpass`)

| Phase | Deliverable |
|---|---|
| **0** | This plan + sign-off |
| **1** | Migration 079 (`is_shared`) + read-route changes + the shared-audio list endpoint + **the access-control threat-model tests** |
| **2** | Cutover script + dry-run → apply on prod km-db (flip Jared's current content shared) |
| **3** | Listen swipe UI + curated tiles + Listen/Read wiring |
| **4** | Blue/green deploy + verify (Jared sees curated tiles; a 2nd account sees them too, read-only; new upload lands private in My Audio) |

## 9. Risks

- **Access-control** is the load-bearing risk — mitigated by the phase-1 threat-model tests (non-owner read-only, no share-flag hijack, IDOR uniform-404 preserved) and a dedicated `/fixpass` on phase 1.
- The reading-vs-listen "both" wiring depends on each shared audio set knowing its paired book; the `paired_reader` kind + `source_upload_id` link already models this for the 3 that have books.
