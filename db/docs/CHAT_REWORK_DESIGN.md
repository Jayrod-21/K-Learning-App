# Chat rework (P4, hardest-first) — design

The global chat FAB (built P1.1, currently routes to `/chat`) becomes a full chat experience per
Jared's overhaul spec + the approved mockup (collapsible sidebar, "discuss this page?" popup,
image-in-chat). Ref: `db/docs/OVERHAUL_SCOUT_chat_progress.md` §1-3, mockup
`$CLAUDE_JOB_DIR/tmp/overhaul-mockup.html`. Reuses: conversation start/stream/list, the OCR pipeline
(`/images/ocr`), the askSeed router-state pattern, F-016's in-chat dictionary.

## What EXISTS vs NEW
EXISTS: `POST /conversation` (start), `POST /conversation/:id/messages/stream` (SSE), `GET /conversation`
(list metadata), `conversations.deleted_at` column (schema, unused), the askSeed seed pattern (TOPIK-shaped),
`/images/ocr` OCR/translate. NEW: `GET /conversation/:id` (history), the sidebar UI + collapse, force-new,
30-day retention, generic per-page context + the popup, image message support.

## Decisions
- **30-day retention = soft-delete on list (no scheduler).** When `GET /conversation` runs, first
  soft-delete (`SET deleted_at = now()`) any of the user's conversations with `updated_at < now() - 30 days`,
  then return the still-live set. Read routes already filter `deleted_at IS NULL`, so this both hides + deletes
  with zero new infra (no cron/interval — the repo has none). Matches Jared's "kept 30 days then deleted." (A
  periodic hard-purge of soft-deleted rows can be a later follow-up; soft-delete is enough now.)
- **FAB opens a NEW conversation** each time (Jared's spec), with the prior ones in the sidebar. The current
  "resume latest" mount behavior is replaced by explicit new-on-open + switch-via-sidebar.
- **Per-page context**: generalize the seed to a `ChatContext { pageLabel, summary, ... }` payload. A small
  `useChatContext()` / context-registry so the FAB (in Shell, outside pages) can read "what is the current
  page showing." Pages register a lightweight descriptor; the popup uses it.

## Slices (build sequentially — each its own build → verify)
### Slice 1 — server + data (no UI)
- `GET /conversation/:id` — return the full message history (JSONB `messages`), user-scoped, `deleted_at IS NULL`, 404 on other-user/missing. Client `getConversation(id)`.
- **Retention**: in `GET /conversation`, soft-delete `updated_at < now()-interval '30 days'` for the user before listing. Test: a 31-day-old convo is gone from the list + its row has `deleted_at`; a 29-day-old stays.
- **Image message support**: extend `StoredTurn` + the messages JSONB to carry an optional image reference (e.g. `{ role, content, imageUrl?/imageId?, ... }`); a turn can be an OCR'd image + its translation. Wire an endpoint (extend `/conversation/:id/messages` or a new `/conversation/:id/image`) that accepts an uploaded image → runs the existing OCR/translate → appends an image turn + returns it. Reuse `images.ts` OCR service; don't duplicate. Respect the existing per-user image cap.
- nginx: `/conversation` already in the allow-list — no change. If a new prefix is added, update both confs.
- Tests: history fetch (IDOR 404), retention sweep, image-turn round-trip.

### Slice 2 — client: sidebar + conversations
- **Collapsible conversation sidebar** (mockup): list prior conversations (title from first message / a derived label, `updated_at`), click-to-switch (loads history via `GET /conversation/:id`), a **collapse toggle** (Claude-style rail, space-saving — Jared's explicit ask), current-conversation highlight, the 30-day note.
- **New chat** button + **force-new on FAB open** (a fresh conversation; prior ones remain in the sidebar).
- Switching loads + renders that conversation's history (the currently-missing full-history render).
- Keep F-016's in-chat dictionary + the streaming compose intact.
- Tests: sidebar lists convos, switch loads history, collapse toggles, new-chat starts fresh + prior persists.

### Slice 3 — client: context popup + image-in-chat
- **"Discuss the prior page?" popup** on FAB-open-with-context: yes → seed the chat with the page's `ChatContext`; no → the opener asks "무엇에 대해… / What would you like to chat about?" (mockup copy). Generic — not TOPIK-only.
- **Per-page context registry**: a `useChatContext(descriptor)` pages call to publish "what I'm showing"; the Shell FAB reads the active page's descriptor. Migrate F-020's callers to the generic path (keep `/chat` route contract). ~10 pages get a lightweight descriptor (Today's plan, Progress's latest snapshot, Ttmik's episode, a reading passage, etc.) — start with the high-value ones, others can publish nothing (popup just skips to "what do you want to chat about?").
- **Image upload in chat**: a file/camera input in the composer → the Slice-1 image endpoint → the OCR'd text + translation appear as a turn the user can discuss. (Complements F-016's dictionary + the mockup's 📷.)
- Wire the ChatFab to open this experience (it currently just routes to `/chat`; now it opens new-convo + the popup).
- Tests: popup yes/no branches, a page descriptor seeds context, image upload → OCR turn, FAB-open flow.

## Each slice: Fable build → /fixpass → blue/green deploy on M. Content (Korean tutor replies, OCR'd text) is CONTENT — not language-toggle chrome. a11y for the sidebar/popup/upload. Then the rest of P4 (grammar mastery, carousels, past-exams, uploads, suggestions-into-LEARN) easiest-last.
