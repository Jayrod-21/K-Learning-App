# Review: P1 — Review card + Chat

Independent senior review (I did not write this code). Scope: B-009 (card vocab
JOIN), B-010 (client SSE inner-discriminator fix), and the conversation
`cache_control` TTL fix. Reviewed against `SENIOR_ENGINEER_BAR.md` (§app error
handling, §db parameterized queries, §5 testing, §7.1 LLM).

## Summary verdict

**APPROVE.** All three fixes are correct, root-caused, and well-tested. FSRS is
not regressed — the due query still selects `c.version` + all FSRS state, the
server-authoritative submit path is untouched, and a regression test explicitly
pins `version === 1` / `fsrs_state === 'new'` on a joined vocab card. The SQL
JOIN is correct and injection-free. The `cache_control` fix resolves the prod
400 and no other 5m/1h mix remains in the conversation request. The B-010 client
rewrite is genuinely excellent — it fails loud on the exact failure mode of the
original bug.

- **BLOCKER: 0**
- **SHOULD-FIX: 1** (bug fix shipped without its own regression test — BAR §5.2 [P0])
- **NIT: 2**
- **PRAISE: 4**

## Bar checklist

| Gate | Verdict |
|---|---|
| §db [P0] parameterized queries, no interpolation | PASS — JOIN uses `$1`/`$2` bind params only; aliases are static SQL |
| §db [P0] no `SELECT *`, columns enumerated | PASS — every column named |
| §db user-isolation preserved | PASS — `c.user_id = $1`; grammar join re-scopes `ge.user_id = c.user_id`; vocab_entries is shared ref data (no user_id) so FK-only join is correct |
| FSRS non-regression (version + scheduling) | PASS — `c.version` still selected; submit path untouched; test asserts version/state survive JOIN |
| §app [P0] graceful on null english (un-enriched mined word) | PASS — degrades via `?? ''` / `?? face`; server + client tests cover NULL |
| §7.1 LLM cache_control correctness (no 400) | PASS — system + scenario both `ttl:'1h'`; no tools block; only two breakpoints, consistent |
| §2 client SSE type safety at boundary | PASS — `parseFramePayload` narrows to object, rejects arrays/non-object, field types checked at dispatch |
| §app [P1] fail loud, no silent drop | PASS — malformed frame → `stream_parse`, not silent skip |
| §5.2 [P0] every bug fix ships a failing-on-old-code regression test | **PARTIAL** — B-009 + B-010 covered; cache_control fix has NO test (see SHOULD-FIX) |

## Findings

### SHOULD-FIX

**SF-1 — The `cache_control` fix ships without a regression test.**
`buildConversationRequest` (`server/src/services/claude/prompts/conversation.ts`)
is the fix for a bug that **400'd every chat request in prod**, and no test
caught it before or guards it now. `grep` confirms there is no
`buildConversationRequest` test anywhere under `server/tests/`, and no
`prompts/` test directory exists. BAR §5.2 [P0]: "Every bug fix ships with a
regression test that fails on the old code — non-negotiable." A ~10-line unit
test asserting `system[0].cache_control.ttl === '1h'` (and that no `'1h'` block
follows a `'5m'` block in tools→system→messages order) would have failed on the
pre-fix code (system defaulted to 5m) and would pin the invariant against a
future regression. This is the single most important gap in the change set. It
is not a code blocker — the fix itself is correct — but it is a real BAR [P0]
process miss.

### NIT

**N-1 — Client discards the authoritative `version` in the `done` frame.**
`client/src/pages/Chat.tsx:364` re-derives the post-turn version with
`versionRef.current += 1` instead of reading `persistedVersion` from the `done`
frame the server actually sends
(`server/src/routes/conversation.ts:575-581`). I verified this is **currently
correct** — the server bumps `version = version + 1` exactly once per turn
(conversation.ts:534), appending both user + assistant turns under a single
increment — so `+= 1` stays in sync. But it silently couples the client to that
"exactly +1 per turn" invariant; the moment a turn bumps by 2 (e.g. a future
edit that splits the write) the next send would 409. Reading the version out of
the `done` frame the client already parses-and-drops would be strictly more
robust and remove the coupling. Low priority; not wrong today.

**N-2 — `dueCardToVocab` hardcodes `pos: 'n.'`** (`Review.tsx:210`). Every card
renders as a noun regardless of true part of speech. Cosmetic and pre-existing
(mirrors `vocabEntryToVocab`), not introduced by B-009 — noting for
completeness.

### PRAISE

**P-1 — B-010 client rewrite is exemplary.** `conversation.ts` (client)
dispatches on the inner `.event` discriminator, and critically **fails loud**
(`stream_parse`) on a non-JSON or event-less frame rather than silently dropping
it — silent drop was the exact failure mode of B-010. The terminal-error
handling is careful and correct: `failStream` fires `onError` once, aborts via a
private controller so `sseStream`'s transport path can't double-fire, stores
`terminalError` and rethrows it over the synthetic `canceled` rejection so the
caller's catch sees the real failure, and suppresses `onDone` when the error
arrives in the EOF tail-flush. This is subtle streaming logic done right.

**P-2 — The B-010 regression suite drives the REAL parser with byte-for-byte
server frames.** `conversation.test.ts:260-391` mocks `fetch` (not `streamSse`)
with `serverFrames(...)` that serialize exactly like the server's
`writeSseFrame` (`data: <json>\n\n`, no SSE-level `event:` line), then asserts
`onDelta` fires per delta and `onError`/reject on an in-band error. These fail
on the old SSE-level-dispatch code. Exactly the right level of test for a wire
contract.

**P-3 — B-009 test explicitly guards the FSRS non-regression.**
`vocab.test.ts:344-350` asserts `version === 1`, `fsrs_state === 'new'`, and the
NUMERIC columns stay strings *after* the JOIN — a deliberate guard that the
vocab JOIN didn't disturb the FSRS wire contract the client echoes back on
submit. This is precisely the risk the review brief flagged, and it's covered.

**P-4 — Null-english degradation is graceful and tested end-to-end.**
`dueCardToVocab` collapses NULLs via `?? ''` / `?? face`; the server test
asserts NULL example columns for an un-enriched entry (vocab.test.ts:353-370)
and the client test asserts the face-label fallback for a card with no vocab
fields (Review.test.tsx:374). An un-enriched mined word degrades to a blank
gloss, never a crash.

## Detailed findings (file:line)

- `server/src/routes/vocab.ts:200-225` — B-009 JOIN. `LEFT JOIN vocab_entries ve
  ON ve.id = c.vocab_entry_id` is correct; aliased `vocab_*` (collision-free vs
  grammar_*); `c.version` retained in the SELECT list; WHERE/ORDER/LIMIT
  unchanged from the FSRS work. Bind params only — no injection surface.
- `server/src/routes/vocab.ts:229-237` — row mapping normalizes BIGINT id/FK ids
  to Number, leaves NUMERIC stability/difficulty as strings (precision-safe).
  Correct.
- `client/src/services/vocab.ts:137-160` — `normalizeDueCard` maps snake→camel,
  collapses `!= null` to absent keys so a grammar card's `vocabKorean` stays
  `undefined`. Clean.
- `client/src/pages/Review.tsx:206-217` — front = `vocabKorean ?? face`,
  back = english + example pair + source. Fallback preserves degraded (not
  blank) rendering for sentence/topik cards. Correct.
- `server/src/services/claude/prompts/conversation.ts:78-100` — both the system
  block (line 87) and the scenario block (line 99) are `ttl:'1h'`. Processing
  order tools→system→messages: no tools block exists; the only two breakpoints
  are system(1h) then the scenario block inside the first user message(1h).
  Consistent — no `'1h'` after a `'5m'`. Fix is correct. History message content
  blocks (lines 121-126) carry no `cache_control`, so no extra breakpoint. 1h on
  a small, conversation-stable system prompt is reasonable on cost (1h write is
  2× base vs 1.25× for 5m, but it's reused across every turn of the scenario and
  matches the existing `grade_writing.ts` 1h/1h precedent).
- `client/src/services/conversation.ts:175-265` — see P-1.
- `server/src/routes/conversation.ts:534,575-581` — server bumps version by
  exactly 1 and emits the authoritative version/messages in the `done` frame
  (which the client currently ignores — see N-1).

## Coordination observations

- The B-009 and FU-NF-42 (grammar) JOINs coexist cleanly in one query with
  distinct alias prefixes (`vocab_*` vs `grammar_*`) and independent NULL
  semantics; neither regresses the other, and separate tests assert each stays
  NULL for the other card family (vocab.test.ts:372-388). Good separation.
- The B-010 fix's contract (data-only frames, inner `.event`) is documented in
  the client service header (conversation.ts:98-118) *and* matched byte-for-byte
  against the server's `writeSseFrame` in tests — client and server wire
  contracts are pinned together, which is what keeps this from silently drifting
  again.
- One cross-cutting theme: the `done` frame carries authoritative
  `version`/`messages` that the client parses and drops (N-1). If a future task
  needs post-turn message reconciliation (e.g. server-side inline corrections),
  the plumbing is already on the wire — wire it into `onDone` rather than adding
  a refetch round-trip.
