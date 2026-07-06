# Review + TOPIK + Reference audit

QA sweep of the three core study/browse flows against the live `km-db` corpus,
hunting for bugs a friend-tester (Korean + English) would actually hit. Branch
`chore/reconcile-rebuild`, prod stack up on :1840, DB in `km-db`.

Scope: `client/src/pages/Review.tsx`, `client/src/pages/Topik.tsx` +
`client/src/pages/topik/MockMode.tsx`, `client/src/pages/Reference.tsx`, and the
server routes behind them (`server/src/routes/topik.ts`,
`server/src/routes/krdict.ts`, `server/src/routes/vocab.ts`).

## Verdict

**Mostly solid, one real content bug.** The recently-fixed items (B-014 flip,
B-008 passage rendering, the mock timer, B-015 overflow) all hold. Empty states,
error paths, idempotent adds, 초성 browse, KRDICT fallbacks, and List CRUD are
clean. The one finding a tester will definitely notice: **60 picture-dependent
TOPIK listening items are unanswerable** — they render four bare ①②③④ choices
with no image, and every Mock Listening exam includes ~5 of them clustered at
the start. Everything else is P3 polish.

## Findings

### P2-1 — Picture-choice listening items are unanswerable (no image, bare ①②③④ options)

- **What**: 60 of the 2,000 gradeable `topik_items` are "listen and pick the
  matching picture" items. Their `options` JSONB is literally `["①","②","③","④"]`,
  `has_image=true`, and `image_text` is NULL (the corpus stores no image asset).
  In the UI each choice renders as marker `①` next to option text `①` (en `''`),
  so all four choices are visually identical and carry zero information. The
  `TopikImageNote` fallback says *"The original exam shows an image here that
  isn't included in this app. Answer from the text above."* — but for these items
  the ANSWER itself is a picture, so there is nothing in the text to answer from.
- **Repro (Mock)**: TOPIK → Mock → Listening. The server picks the highest test
  (`test_number=102`), which has 80 gradeable listening items including 5 picture
  items at question numbers 1–16. A tester gets an impossible question in the
  first three items of every listening mock.
- **Repro (Study)**: TOPIK → Study → New set. Each 10-item random draw has ~26%
  chance of including at least one (60/2000 ≈ 3% per slot). It grades
  server-side, so the reveal shows *"Correct answer: ① ①"* — confusing.
- **DB proof**:
  ```sql
  SELECT count(*) FROM topik_items
  WHERE jsonb_array_length(options)>=2 AND answer IS NOT NULL
    AND options->>0 IN ('①','②','③','④');   -- 60, all section=listening, all has_image, image_text NULL
  ```
- **Code path**: `server/src/routes/topik.ts:215-224` (`mapRowToDTO` maps the
  glyph string into `kr`) → `client/src/pages/topik/MockMode.tsx:818-850`
  (`ChoiceGroup` renders `{o.kr}`) and `client/src/pages/Topik.tsx:568-604`
  (`TopikBody`). Image fallback: `client/src/lib/topikImage.ts` /
  `client/src/components/TopikImageNote.tsx`.
- **Tester-hit?**: YES — guaranteed in Mock Listening, likely in Study.
- **Not a crash / not data-corrupting** (grading is correct server-side, app
  doesn't break), hence P2 not P1. Options for a fix (product call, not this
  sweep): exclude marker-only-option items from the study draw + mock assembly
  (add `options->>0 NOT IN ('①','②','③','④')` or a real "picture item" flag to
  the survivor guard), or source/render the actual images.

### P3-1 — "More examples" drawer on the Review flashcard is always empty (dead affordance)

- **What**: `dueCardToVocab` hardcodes `extra: []` and never sets `notes`
  (`Review.tsx:239-250`), so the wire never carries extra examples. The flashcard
  back always shows a "More examples" toggle (`Review.tsx:997-1009`) that expands
  an empty drawer (`Review.tsx:1010-1022`). Every review card has this dead button.
- **Repro**: Review → flip a card → click "More examples" → drawer opens with
  nothing in it (toggles to "Hide examples" but shows no content).
- **Tester-hit?**: Likely (curiosity click). Low harm — main example (`ex_kr`/
  `ex_en`) + source still render on the card back from the real joined fields.
- Note: the primary example fields ARE wired (`server/src/routes/vocab.ts:214-215`)
  and populated for ~94% of entries (217/3405 `vocab_entries` lack an example) —
  those blanks degrade to empty text, which is fine. It's only the *extra* drawer
  that is structurally always empty.

### P3-2 — Mock section-select advertises the wrong item count

- **What**: `SECTIONS` in `MockMode.tsx:94-98` hardcodes "Reading 50 items /
  Listening 50 items", but the exam serves ALL gradeable items for the
  server-picked test — listening `test_number=102` yields 80. Tester is promised
  50, gets 80 (with a 60-minute timer sized for a 50-item section).
- **Tester-hit?**: Yes, cosmetic — the count on the select card doesn't match the
  exam. No functional break.

### P3-3 — Study draw can return fewer items than requested

- **What**: `POST /topik/study` (`server/src/routes/topik.ts:693-725`) omits the
  survivor guard (`jsonb_array_length(options)>=2 AND answer IS NOT NULL`) that
  `/items` and the mock-source resolver use. It does `ORDER BY random() LIMIT 10`
  over all 2,088 rows (incl. ~6.5% ungradeable), then `mapRows` silently drops the
  ungradeable ones — so a "10-item" draw usually returns ~9. Cosmetic; no error,
  the "New set" flow still works.
- **Tester-hit?**: Barely noticeable (short set). P3.

## Checked-and-clean

- **B-014 flip fix**: back face mounts only while `flipped` (`Review.tsx:981-1024`);
  rating flow, drawer toggle (`e.stopPropagation`), and next-card advance intact.
  No answer-leak flash. (The always-empty drawer is P3-1, unrelated to the fix.)
- **B-008 passage**: server resolves the shared reading passage onto
  `item.passage` (`topik.ts:236-248`, `sharedPassageFor`); Study, Mock exam, and
  the Mock/Study results review all render `TopikPassage`. Holds.
- **Mock timer**: `formatClock` renders `h:mm:ss` / `mm:ss` and ticks every second
  via the interval effect (`MockMode.tsx:374-381, 483-503`); auto-submit at 0 with
  a single-fire guard. The old "frozen at 01:10" bug is fixed.
- **Answer-strip security**: mock DTO Omits `correct` + `explanation` at the type
  level (`topik.ts:281-313`); grading is server-side from the DB. No client
  self-grade path. Clean.
- **초성 browse**: all 14 base consonants return results (ㄱ 8468 … ㅋ 521, ㅌ 1220,
  ㅍ 1586, ㅎ 3456); Unicode ranges + tense-pair folding correct; `힤` correctly caps
  the ㅎ range. 1,863 non-Hangul-initial entries (Latin/digit headwords) aren't
  under any initial but ARE reachable via 전체 + search — intended.
- **KRDICT search / definitions**: 0/53,978 entries have BOTH definitions empty;
  1,685 lack an English def but the client falls back to `definition_korean`
  (`Reference.tsx:854-856`) — graceful. Search escapes LIKE metachars, honest 503
  when tables absent.
- **"Add to review" seed**: `SEED_CORPORA` (`vocab_2000_beginner`,
  `vocab_2000_intermediate`) match real corpus enum values (1706 + 1696 rows);
  idempotent, "all caught up" wording on `inserted:0`. Works.
- **Empty / error states**: Review empty bank, empty All-search, empty Lists,
  empty list-detail, TOPIK empty draw, Dictionary "no entries" — all render an
  EmptyCard/empty-text rather than a dead screen. Fetch errors route to ErrorCard
  + Retry.
- **Blank prompts**: 0 gradeable topik_items render a blank question (when an item
  is gradeable it always has a non-empty `stem`; `prompt` is NULL for 2040/2088
  and the DTO falls back to `stem`).
- **Wrong-answer explanations (F-019)**: gated on `!isCorrect` AND non-empty
  (`MockMode.tsx:995`, `Topik.tsx:620`); items without an explanation degrade
  gracefully — the paragraph is omitted but the correct answer is still named.
- **List CRUD**: create / rename / delete / add-entry / remove-entry all have
  confirm-before-delete, optimistic-with-rollback removal, and treat 409 as
  success (already-in-list / already-banked). Clean.
- **Search debounce**: 200ms across Review All-panel and all Reference tabs;
  keyed `useEndpointOrMock` aborts stale in-flight fetches.
