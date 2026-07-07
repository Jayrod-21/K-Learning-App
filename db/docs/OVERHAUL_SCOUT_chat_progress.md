# Overhaul Scout — Global Chat (FAB) + Progress Page

Read-only infra audit, 2026-07-07. Scope: two target areas for the app overhaul —
(1) a reworked global chat opened by a search-icon FAB, with a conversation
sidebar, 30-day retention, prior-page-context handoff, and in-chat image
upload; (2) a new Progress page assembling the diagnostic skills-compare, the
F-017 per-skill trend carousel, and a retake-diagnostic entry, all currently
living elsewhere.

Live DB queried via `docker exec -i km-db psql -U korean_master -d korean_master`.
At audit time: `conversations` has 1 row, `image_captures` has 0 rows.

---

## 1. Chat + conversations

**Files:** `client/src/pages/Chat.tsx`, `client/src/services/conversation.ts`,
`server/src/routes/conversation.ts`, `db/migrations/001_core_schema.up.sql`
(conversations table, ~line 495).

| Capability | Verdict | Evidence |
|---|---|---|
| Start a conversation | EXISTS | `POST /conversation` — `server/src/routes/conversation.ts:69-91`; client `startConversation()` — `client/src/services/conversation.ts:41-45` |
| Streamed messages (SSE) | EXISTS | `POST /conversation/:id/messages/stream` — `conversation.ts:347-619`; client `streamMessage()` — `client/src/services/conversation.ts:118-292` |
| List conversations (metadata) | EXISTS | `GET /conversation` — `conversation.ts:638-660`, returns `{id, mode, target_register, version, updated_at, message_count}` (no message bodies); client `listConversations()` — `client/src/services/conversation.ts:58-61` |
| **Fetch ONE conversation's full message history** | **MISSING** | No `GET /conversation/:id` route exists in `conversation.ts`. `Chat.tsx:282-286` comment says explicitly: *"we open with the personalised opener until the user's first send streams in a tutor reply... Full history fetch lands in a later pass."* |
| **Multi-conversation sidebar UI** | **MISSING** | `Chat.tsx` calls `listConversations()` only to run `pickActiveConversation()` (`Chat.tsx:197-208`, used at `262-265`) — i.e. it picks the single most-recently-updated row and treats it as *the* thread. There is no list/sidebar component rendering multiple rows, no click-to-switch-conversation affordance anywhere in `client/src/pages/Chat.tsx` or `client/src/components/`. |
| **"Start a NEW conversation" on FAB-open** | **MISSING (as a distinct action)** | The primitive exists (`startConversation`), but Chat.tsx's mount behavior is "resume the latest active conversation, lazy-start only if none exists" (`ensureConversationId`, `Chat.tsx:389-397`; `seed` memo `281-294`). There is no code path that force-starts a fresh conversation while preserving the prior one in a retrievable list — that's new product behavior on top of an existing primitive. |
| Soft-delete column on conversations | EXISTS (schema only) | `conversations.deleted_at TIMESTAMPTZ` — `db/migrations/001_core_schema.up.sql` (~line 513); confirmed live: `docker exec -i km-db psql ... "\d conversations"` shows `deleted_at`. Every read route filters `WHERE ... AND deleted_at IS NULL` (`conversation.ts:200, 412`). |
| **30-day retention (job/TTL/cleanup)** | **MISSING — 100% new** | No code ever writes `deleted_at` for a conversation, and no scheduled job exists anywhere in `server/src` (`grep -rn "cron\|setInterval\|node-cron\|scheduleJob" server/src` → zero hits outside doc comments). The only related precedent in the whole repo: `server/src/services/claude/index.ts:228-229,753-755` exposes `evictExpiredCache()` "safe to call from a cron handler" for the **Claude response cache** (not conversations) — and it is **never called anywhere** (`grep -rn "evictExpiredCache" server/src` finds only its own declaration/impl, no caller). The one *working* scheduled job in the stack is `Deploy/km-backup-entrypoint.sh` — a bash sleep-loop sidecar container that nightly prunes DB **backups** by `BACKUP_RETENTION_DAYS`, unrelated to conversation rows but a directly reusable *pattern* (in-container loop, not host cron, because the stack must stay self-contained per that file's own header comment) if the team wants an out-of-process sweep rather than an in-Node interval. |
| Message shape | EXISTS, text-only | `StoredTurn { role, content: string, sent_at, request_id? }` — `conversation.ts:47-52`; JSONB array on `conversations.messages` (schema, ~line 502-505). No image/attachment field. |

**Retention precedent worth noting:** F-021 (Mistakes log, `BUGS_AND_FEATURES.md:671`)
already establishes a house convention that "30 days" can mean a **query
window**, not deletion ("Retention = a query WINDOW (show last 30 days), not
deletion"). The target spec for chat explicitly wants actual deletion after
30 days, which is a different (harder) contract than that existing precedent
— don't assume the Mistakes-log pattern transfers.

---

## 2. Prior-page context ("discuss this page?")

**Files:** `client/src/lib/askSeed.ts`, `client/src/pages/Chat.tsx:229-238,
296-334`.

| Capability | Verdict | Evidence |
|---|---|---|
| Seed mechanism (router state → composer pre-fill) | EXISTS | `ChatSeedState { seedText, mode? }` (`askSeed.ts:63-66`); `readChatSeedState()` runtime-narrows untrusted `history.state` (`askSeed.ts:122-138`); Chat reads it once via lazy `useState` initializer (`Chat.tsx:236-238`), pre-fills composer (`Chat.tsx:300`), clears router state after mount so back-nav can't re-seed (`Chat.tsx:319-334`). |
| Seed-text builder | EXISTS but narrow | `buildAskSeed(input: AskSeedInput)` (`askSeed.ts:80-104`) takes exactly `{prompt, correctText, explanation?, passage?, userPick?}` — a **TOPIK-question-shaped** payload, not a generic "page context" object. |
| Callers today | EXISTS, only 3-4 review surfaces | Per `BUGS_AND_FEATURES.md:636-654` (F-020), only Mistakes / TOPIK mock reveal / TOPIK study reveal / Diagnostic reveal call `buildAskSeed` + `navigate('/chat', {state})`. Every other page (Today, Progress, Ttmik, Hanja, Grammar, Writing, Images, Reference, Settings) has **no** context-export code at all. |
| **Generic "any page can hand Chat its context" capability** | **MISSING** | The mechanism (router-state + lazy-read + clear-on-mount) is architecturally reusable, but the *shape* (`AskSeedInput`) and the *call sites* are hard-coded to TOPIK-question review UI. A FAB living outside every page component has no hook into "what is this page currently showing" — each of the ~10 non-review pages would need new code to produce a context payload (e.g. Today's plan-of-the-day, Progress's latest snapshot, Ttmik's current episode) before a generic seed could be built. |
| **"Discuss the prior page?" yes/no popup** | **MISSING** | Today's F-020 flow **always** silently pre-fills the composer — there is no confirm dialog anywhere in `Chat.tsx` or `askSeed.ts`. The target spec's popup, and the "no → ask 'what do you want to chat about'" branch, are wholly new UI + state. |

**Bottom line for this section:** the *plumbing pattern* (router-state seed,
narrow-on-read, clear-after-consume) is proven and should be reused/extended,
but the *product surface* — a generic per-page context export, invoked from
a FAB rather than an explicit in-page button, gated behind a confirm popup —
does not exist and is mostly new work per page.

---

## 3. Image-in-chat

**Files:** `server/src/routes/images.ts`, `server/src/services/imageStore.ts`,
`server/src/services/claude/prompts/image_ocr.ts`, `client/src/pages/Images.tsx`,
`client/src/services/images.ts`.

| Capability | Verdict | Evidence |
|---|---|---|
| Upload + magic-byte-sniff + Vision OCR + persist (transactional) | EXISTS, hardened | `POST /images/ocr` — `images.ts:253-381`. Multer memory storage (8 MiB cap), fileFilter + magic-byte sniff (`sniffImageMime`, `images.ts:142-167`, never trusts declared mime), per-user daily Vision cost cap (`images.ts:277-292`), OCR call OUTSIDE any transaction so a Vision failure writes nothing (`images.ts:294-310`), then ONE transaction for blob+capture+words (`images.ts:326-375`). |
| OCR result shape | EXISTS | Returns `caption_kr`, `caption_en`, `words: {kr, en, gloss, pos}[]` (DTO at `images.ts:181-191`; prompt at `server/src/services/claude/prompts/image_ocr.ts`). This already **is** "translate" — caption_en + per-word gloss. |
| Word mining from an image capture | EXISTS | Words inserted into `image_words`, same DTO shape client already renders (`images.ts:354-363`). |
| Blob serving (authed, nosniff, IDOR-scoped) | EXISTS | `GET /images/:id/blob` — `images.ts:462-508`. |
| **Any of the above reachable from Chat / conversation turns** | **MISSING** | `Chat.tsx` has no file input, no camera affordance, no image-message rendering; `ThreadRow`/`ConversationMessage`/server `StoredTurn` are text-only (`conversation.ts:47-52`). `Chat.tsx`'s only non-text feature is the dictionary lookup pop-over (F-016, `Chat.tsx:631-793`), which is a good **pattern** to imitate (optimistic UI, abort-on-newer-lookup, fixed-copy error states) but does not touch images. |
| Camera-capture attribute on file input | MISSING (minor) | `Images.tsx:412-415` uses `accept="image/jpeg,image/png,image/webp"` with no `capture="environment"` — the existing upload is a generic file picker, not an explicit "take a photo" trigger; small gap if the target UX wants to force the camera specifically. |

**What's missing to do it INSIDE chat (vs. the standalone Images page):**
1. A chat-composer affordance (camera/upload button) — new UI, but can copy
   `Images.tsx`'s upload flow almost verbatim.
2. A decision + new server work on **whether the OCR result becomes a new
   user turn's `content`** (cheapest — reuse `POST /images/ocr` as-is, then
   feed `caption_kr`/`caption_en`/words into the next `streamMessage` call as
   plain text) **or whether the conversation schema needs an image reference
   field** (harder — `StoredTurn`/`conversations.messages` JSONB shape and
   the `ConversationMessage` domain type would need a new optional field, and
   every consumer of that JSONB — `projectHistory`, `findIdempotentTurn` —
   would need updating). The first option requires no schema change; the
   second requires touching `conversation.ts`'s `StoredTurn` interface and
   the client `ThreadRow`/`Bubble` renderer.
3. No new OCR/Vision work needed either way — `POST /images/ocr` already
   does everything the spec asks ("take a photo → translate") and is
   independently reusable by a new chat-scoped endpoint or called directly
   from the Chat screen.

---

## 4. Chat FAB placement / hide rules

**Files:** `client/src/App.tsx`, `client/src/components/Shell.tsx`,
`client/src/components/BottomNav.tsx`, `client/src/lib/nav.ts`.

| Capability | Verdict | Evidence |
|---|---|---|
| Any existing FAB / global floating-overlay pattern | MISSING | `grep -rln "FAB\|fab\b\|floating"` across `client/src` matches only `App.tsx`, `lib/nav.ts`, `components/BottomNav.tsx`, `components/Shell.tsx` — none of which implement a floating action button; they're the bottom tab bar + its "More" sheet (portal-mounted, `Shell.tsx:60-62`). The MoreSheet open/close + focus-restore contract (`Shell.tsx:24-45`) is a decent state-management pattern to imitate for a FAB, but there is no floating UI element today. |
| Per-route "hide chrome on X" logic | MISSING | `Shell.tsx` renders `<BottomNav>` unconditionally for every routed screen (`Shell.tsx:53-59`); there is no `useLocation()`-based conditional anywhere in `Shell.tsx`. All routes — including `/settings`, `/chat`, and the TOPIK mock-exam route `/topik` — mount inside the **same** `<Route element={<Shell/>}>` wrapper (`App.tsx:76-104`), so there is no existing mechanism that suspends chrome during an exam either. |
| Keyboard-open detection | MISSING | `grep -rn "visualViewport\|keyboardOpen\|keyboard-open\|isKeyboardOpen"` across all of `client/src` → zero hits. |
| Route manifest to key a FAB allow/deny-list off of | EXISTS (reusable) | `client/src/lib/nav.ts` — a clean `NavItem[]`/`NavItemId` manifest already used by `BottomNav`/`MoreSheet`; a FAB visibility rule ("show on every route except settings/topik-exam/chat/keyboard-open") could cheaply match `useLocation().pathname` against this manifest's `path` values, but that's a new small utility, not an existing one. |

**Bottom line for this section:** nothing to reuse structurally except the
MoreSheet's state/focus-management idiom and the nav manifest as a lookup
table. FAB mount point, route-based hide rules, exam-mode detection, and
keyboard-open detection are all greenfield.

(Context: `BUGS_AND_FEATURES.md:568-571` records that F-016's nav-IA half —
"promote Chat out of the More sheet" — was explicitly **deferred to this app
overhaul** on 2026-07-07, confirming the FAB rework is intentionally new
scope, not something partially started elsewhere.)

---

## 5. Progress page assembly

**Files:** `client/src/pages/Progress.tsx` (already exists, routed at
`/progress` — `App.tsx:102`, `lib/nav.ts:152-160`), `client/src/pages/Today.tsx`,
`client/src/pages/Diagnostic.tsx`, `client/src/components/SkillsCompare.tsx`,
`client/src/services/stats.ts`.

**Progress.tsx already exists and is populated** (F-010/F-013, both 🟢 done
per `BUGS_AND_FEATURES.md:92,95`). It currently renders, from
`GET /diagnostic/history` (`server/src/routes/diagnostic.ts:1546`) and
`fetchMastery`:
- `TrendChart` — SVG line chart, score-over-*attempts* (not calendar days),
  one line per dimension + Overall (`Progress.tsx:299-510`).
- `CompareBlock` — attempt-vs-attempt delta table (`Progress.tsx:535-637`).
- `AttemptsTable` — accessible twin of the chart (`Progress.tsx:659-691`).
- `WordMasterySection` — F-013 FSRS mastery buckets + paginated word list
  (`Progress.tsx:767-907`).
- Empty state already links to `/diagnostic` (`EmptyBlock`, `Progress.tsx:237-258`).

**Important: Progress.tsx's existing chart is NOT the target "SkillsCompare"
component** — it's a different axis (score vs. attempt-number over time),
not a skill-vs-TOPIK-reference-band bar chart. Bringing SkillsCompare onto
Progress is an *addition*, not a dedupe of something already there.

| Component to relocate | Verdict | Where it lives now | Coupling |
|---|---|---|---|
| `SkillsCompare` (TOPIK-1→Native bar-chart compare) | EXISTS, cleanly reusable | `client/src/components/SkillsCompare.tsx` — already a standalone, props-only component used in **two** places: `Today.tsx:324-332` (`variant="compact"`) and `Diagnostic.tsx:1075-1079` (`variant="full"`, the actual diagnostic-results skills snapshot). Adding a third call site on Progress is trivial — no extraction needed, it's already decoupled. |
| F-017 carousel (`SwipeCarousel` of per-skill `LineChart`s) | EXISTS but **Today-coupled at the glue layer, not the component layer** | Lives entirely inside `Today.tsx`: `SERIES_PANELS` manifest (`Today.tsx:149-159`), `SkillTrendPanel` (`Today.tsx:184-230`), the fetch (`useEndpointOrMock('today.series', loadSkillSeriesMock, {realFn: () => fetchSkillSeries(30)})`, `Today.tsx:266-270`), and the render block (`Today.tsx:361-398`) are all local to the Today page module — none of it is exported or in a shared `lib`/`hooks` file. `SwipeCarousel` and `LineChart` themselves (in `client/src/components/`) ARE standalone/reusable; only the Today-specific wiring (manifest + panel component + mock keys) needs to move. |
| `/…/series` backing endpoints (F-017 data) | EXISTS, page-agnostic | `GET /topik/series` (`server/src/routes/topik.ts:662`), `GET /vocab/series` (`server/src/routes/vocab.ts:959`), `GET /grammar/series` (`server/src/routes/grammar.ts:394`), `GET /writing/series` (`server/src/routes/writing.ts:144`) — all `requireAuth`-scoped, degrade-per-skill via `Promise.allSettled` in `client/src/services/stats.ts` (`fetchSkillSeries`, never fabricates data on failure). Fully decoupled from Today; safe to call from Progress unchanged. |
| Retake-diagnostic entry | EXISTS elsewhere, not on Progress | `Diagnostic.tsx`'s own header comment: "The retake CTA on results sets mode='intro'" — this lives on `/diagnostic`, is page-local state (not a shared route param/action), and Progress today only offers "Take the diagnostic" in its **empty** state (`Progress.tsx:237-258`) — there's no "Retake" affordance on Progress once history exists. Moving/duplicating this onto Progress means either navigating to `/diagnostic` (simple, already works — any button can `navigate('/diagnostic')`) or teaching Diagnostic to accept a query/state flag that forces `mode='intro'` even with prior history (small new wiring, mirrors the existing retake CTA's own state-set, just triggered from a different page). |

**Relocation verdict:** the underlying **components** (`SkillsCompare`,
`SwipeCarousel`, `LineChart`) and the **backing routes/services** (`/…/series`,
`fetchSkillSeries`, `fetchLatestSnapshot`) are all already decoupled,
props/service-only, and safe to call from anywhere. What's Today-coupled is
purely the **glue** in `Today.tsx` — the `SERIES_PANELS` manifest, the
`SkillTrendPanel` wrapper, the `useEndpointOrMock` cache keys
(`'today.snapshot'`, `'today.series'`), and the mock fixtures
(`loadDiagnosticSnapshotMock`, `loadSkillSeriesMock`). This is a cut-paste
relocation of ~150 lines from `Today.tsx` into `Progress.tsx` (rename mock
keys, drop the now-redundant "skills snapshot" card and carousel section
from Today, decide whether Today keeps a slim teaser linking to `/progress`
or drops the block entirely) — not a rewrite, and not blocked on any missing
primitive.

---

## Bottom line

**(a) Multi-conversation persistence + sidebar:** the *list* endpoint
(`GET /conversation`, metadata only) and the *start* endpoint already exist,
but there is no `GET /conversation/:id` full-history route and no sidebar/list
UI anywhere — the sidebar and "switch conversations" experience is **new**,
built on top of an existing but incomplete list primitive.

**(b) 30-day retention:** **entirely new.** `conversations.deleted_at` exists
in the schema but nothing ever sets it, no cron/interval/scheduler runs
anywhere in `server/src`, and the one cache-eviction method that documents
itself as "cron-handler-safe" (`evictExpiredCache`) is dead code with zero
callers — the only working scheduled-job pattern in the repo is the unrelated
DB-backup sidecar loop, reusable as a *pattern* only.

**(c) Prior-page-context + image-in-chat reuse:** mostly **assembly** on the
image side (OCR/translate/word-mine is fully built, hardened, and reusable —
`POST /images/ocr` needs no changes, only a chat-side caller and a decision on
whether OCR output rides as plain text in a new turn or needs a schema change
to `StoredTurn`); mostly **new** on the context side — F-020's seed mechanism
(router-state pass-through) is a good pattern to extend, but its message
builder and every call site are hard-coded to TOPIK-question review UI, no
generic per-page context export exists, and the "discuss the prior page?"
confirm popup doesn't exist at all.

**(d) Progress components movability:** **cleanly movable.** `SkillsCompare`,
`SwipeCarousel`, and `LineChart` are already standalone components with zero
Today-specific coupling (SkillsCompare is already used in two places today);
only the glue code in `Today.tsx` (manifest, wrapper component, fetch keys,
mocks) needs to be cut and relocated into the already-existing `Progress.tsx`
— no missing backend primitive blocks this.
