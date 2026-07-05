# Review — TTMIK/Iyagi lesson & episode detail endpoints

**Branch:** `feat/ttmik-transcripts` · **Scope:** `server/src/routes/ttmik.ts` (lesson/episode
detail handlers, `splitHosts`, `SENTENCE_COLUMNS`, `SentenceRow`/`TranscriptLineRow`/`UnitRow`),
`server/tests/routes/ttmik.test.ts`, `server/tests/helpers/seed.ts` (ttmik/iyagi seeds).
Read-only review — no code changed.

## Verdict

**Approve with follow-ups.** Zero blockers in the reviewed files. The two fixes this diff claims —
(1) full transcript alongside highlights, correctly ordered and joined; (2) `splitHosts` turning the
`hosts` TEXT column into `string[]` with a type that makes the old bug class uncompilable — are both
real and well-tested, including a regression test that seeds the actual `"최경은 & 진석진"` production
value rather than a synthetic stand-in. The romanization removal is real *within this file* but the
endpoint enforces it by omission (not selecting the column / not filtering the kind) rather than by an
active guard, and one existing test's use of `toMatchObject` means the "never on the wire" claim isn't
actually regression-tested. Both are cheap to close. Separately — outside the assigned scope, but
directly responsive to what I was asked to verify — a sibling route (`reading.ts`) still exposes
`romanization` and still has the identical raw-`hosts`-typed-as-`string[]` pattern this PR fixed in
`ttmik.ts`; see the dedicated section below.

## Findings

### BLOCKER
None.

### SHOULD-FIX

1. **"Never on the wire" isn't actually asserted by a server test.** The highlights test
   (`server/tests/routes/ttmik.test.ts:174`) checks
   `expect(res.body.highlights[0]).toMatchObject({ korean: '안녕하세요', english: 'hello' })`.
   `toMatchObject` only asserts the *listed* keys match — it does not fail if the object also carries
   a `romanization` key. If `SENTENCE_COLUMNS` (`server/src/routes/ttmik.ts:133`) ever regresses to
   re-include `romanization` (copy-paste from `reading.ts`, a merge, a careless "restore the column"),
   this test suite would stay green. Add an explicit
   `expect(res.body.highlights[0]).not.toHaveProperty('romanization')` (or assert the full key set)
   so the claim in the commit message ("never on the wire") is actually enforced, not just currently
   true.

2. **The transcript endpoint trusts the loader with no belt of its own.** The `kind` CHECK
   constraint on `ttmik_transcript_lines` (`db/migrations/036_ttmik_transcript.up.sql:69-70`) still
   permits `'romanization'` as a legal value — only the Python loader
   (`tools/ingest/loaders/load_ttmik_transcript.py`, per `git show 648e5ec`) guarantees it never
   inserts one. The endpoint query (`server/src/routes/ttmik.ts:205-211`) has no
   `WHERE kind <> 'romanization'`, and no server-side test seeds a `kind: 'romanization'` row and
   asserts it's excluded or safely handled (`seedTtmikTranscript` is only exercised with
   `dialog`/`pair`/`header` in the test file — `server/tests/routes/ttmik.test.ts:180-184`). The only
   actual guard against a leaked romanization line reaching a user is the client's defensive
   no-op render (`client/src/pages/Ttmik.tsx:1021-1024`, `case 'romanization': return <></>`) — i.e.
   the server is the least-defended layer in the chain for an invariant the user stated explicitly
   ("no romanization anywhere"). This is cheap to close: add `AND kind <> 'romanization'` to the
   transcript query (or a server test asserting a seeded romanization-kind row is dropped/ignored)
   so the guarantee doesn't rest entirely on an offline batch script plus a DB constraint that still
   allows the value.

### NIT

3. Module-level doc comment (`server/src/routes/ttmik.ts:12-22`) still describes
   `kind ∈ header|pair|romanization|prose|dialog` as an undifferentiated rendering contract
   ("for single-text kinds render `korean ?? english`") without noting that `romanization` is now a
   should-never-appear kind excluded by the loader. A maintainer reading only this file's header
   would not learn about the "no romanization anywhere" invariant or where it's actually enforced.
   Worth a one-line addendum given finding #2 above.

4. `SentenceRow.is_dialog` is typed `boolean | null` (`server/src/routes/ttmik.ts:97`), but the
   backing column is `is_dialog BOOLEAN NOT NULL DEFAULT FALSE`
   (`db/migrations/005_lesson_podcast_topik.up.sql:125`) — the type is looser than the schema
   guarantees. Harmless (a nullable type is a safe over-approximation), but worth tightening to
   `boolean` for precision now that the row shape is being hand-audited anyway.

5. No compile-time link between a SQL projection and its hand-written TS row interface (e.g.
   `UnitRow.hosts?: string | null` is correct today, but nothing stops the ttmik query from someday
   selecting a `hosts`-shaped column under a different name without the type catching it). Pre-existing
   pattern across the codebase, not introduced by this diff — flagging only because finding #1 shows
   the test suite doesn't fully backstop it either.

### PRAISE

- **`splitHosts` is genuinely well tested.** `server/tests/routes/ttmik.test.ts:454-468` covers no
  spaces around `&` (`'A&B'`), stray whitespace, three hosts, a *leading* dangling separator
  (`'& 석진'` → `['석진']`, not `['', '석진']`), empty string, `null`, and `undefined` — a thorough
  edge-value sweep, not just the happy path.
- **The regression test uses real corpus data, not a placeholder.** `server/tests/routes/ttmik.test.ts:244-253`
  seeds the actual production-shaped value `'최경은 & 진석진'` and asserts the exact split — directly
  satisfies the project's standing "test with real corpus data" bar, and would fail hard on the
  pre-fix `episode.hosts ?? []` passthrough (that code returns the raw string, which fails a
  `toEqual(['최경은','진석진'])` array comparison).
- **`UnitRow.hosts?: string | null`** (`server/src/routes/ttmik.ts:100-110`) with the accompanying
  comment turns the old bug class into a compile error at the call site rather than a runtime crash —
  exactly the right fix shape (type change, not just a code change) for a bug that was a type-contract
  violation in the first place.
- **Transcript ordering test is correctly falsifiable.** `server/tests/routes/ttmik.test.ts:177-195`
  seeds lines with ordinals `3, 1, 2` (deliberately out of insertion order) and asserts the response
  is `[1, 2, 3]` via `toEqual` on the full array — this *would* fail on a query missing
  `ORDER BY ordinal`, unlike a test that happens to seed already-sorted data.
- **`Promise.all` for highlights + transcript** (`server/src/routes/ttmik.ts:197-212`) — both queries
  key off the same already-resolved `lesson.id`, fired concurrently rather than sequentially; no
  N+1, no avoidable waterfall. The iyagi handler's two queries are correctly *not* parallelized
  (sentences query needs `episode.id` from the first query) — the difference is deliberate, not an
  inconsistency.
- **`SENTENCE_COLUMNS`** shared constant (`server/src/routes/ttmik.ts:133`) is the single source of
  truth for both the ttmik and iyagi sentence projections — one place to keep the "no romanization"
  invariant, one place it can regress. Good DRY choice even though it doesn't close finding #1/#2.
- **`requireAuth` is applied at the router level** (`ttmikRouter.use(requireAuth)` /
  `iyagiRouter.use(requireAuth)`, `server/src/routes/ttmik.ts:71-72`) rather than per-route, so a new
  route added to either router can't accidentally ship unauthenticated. Confirmed by
  `server/tests/routes/ttmik.test.ts:110-122`, which parametrizes all six routes including both
  detail endpoints and asserts 401 unauthenticated.
- All queries in the reviewed handlers are parameterized (`$1`, `$2`); `SENTENCE_COLUMNS` is a
  hardcoded constant, never string-built from request input — no injection surface.
- No over-fetch: every `SELECT` enumerates exactly the columns the response needs
  (`id, title, audio_path`; `SENTENCE_COLUMNS`; `ordinal, korean, english, kind`) — no `content_hash`,
  `search_tsv`, `version`, or other internal bookkeeping column leaks to the client.

## Detailed (file:line)

- `server/src/routes/ttmik.ts:91-98` — `SentenceRow`: `romanization` correctly absent (removed
  alongside `SENTENCE_COLUMNS`, see `git show 648e5ec`). `korean` correctly non-nullable per the DB's
  `NOT NULL` + `CHECK (length(korean) >= 1)` (`db/migrations/005_lesson_podcast_topik.up.sql:122,145`).
- `server/src/routes/ttmik.ts:100-110` — `UnitRow.hosts?: string | null` with an explanatory comment
  citing the exact bug it prevents; correctly optional since the ttmik query never selects `hosts`.
- `server/src/routes/ttmik.ts:112-117` — `TranscriptLineRow.kind` union still includes
  `'romanization'` as a legal value (correct — it mirrors the DB CHECK's vocabulary) but nothing
  downstream of the DB query narrows it away; see SHOULD-FIX #2.
- `server/src/routes/ttmik.ts:124-130` — `splitHosts`: splits on `&`, `.trim()`s each part,
  `.filter()`s empties, `[]` on falsy input. Correct and matches its test coverage 1:1.
- `server/src/routes/ttmik.ts:133` — `SENTENCE_COLUMNS` — no `romanization`; shared by both sentence
  queries at lines 199 and 288.
- `server/src/routes/ttmik.ts:180-224` — lesson detail handler: resolves `(level, number)` →
  `lesson.id` first (composite natural key, parameterized), then fires highlights + transcript in
  parallel keyed on `lesson.id`. Both `ORDER BY ordinal`. Correct join strategy — sentences/transcript
  tables have no `lesson_level`/`lesson_number` columns, so the two-step resolve is required, not
  incidental.
- `server/src/routes/ttmik.ts:272-313` — episode detail handler: resolves `episode_number` →
  `episode.id`, then sentences by `episode_id`, `ORDER BY ordinal`. `hosts` passed through
  `splitHosts()` at the boundary (line 303), not stored/typed as an array upstream.
- `server/tests/routes/ttmik.test.ts:161-175` — highlights+audioUrl shape test; see SHOULD-FIX #1 re:
  `toMatchObject`.
- `server/tests/routes/ttmik.test.ts:177-204` — transcript ordering + empty-before-loader-run tests;
  solid, falsifiable.
- `server/tests/routes/ttmik.test.ts:228-265` — iyagi meta/hosts tests, including the real-value
  regression and the single-host/null-hosts edge cases.
- `server/tests/helpers/seed.ts:161-192` (`seedTtmikLesson`) and `:226-248` (`seedIyagiEpisode`) —
  seed exactly two sentences each with fixed content, deterministic `content_hash` via `hex64(...)`;
  clean, minimal fixtures. `seedIyagiEpisode`'s `hosts` param defaults to `null` and is documented as
  "mirrors production data" — good.
- `server/tests/helpers/seed.ts:194-218` (`seedTtmikTranscript`) — inserts arbitrary
  `TranscriptLineSeed[]`, used out-of-order by the ordering test; never exercised with
  `kind: 'romanization'` (see SHOULD-FIX #2).

## Out-of-scope but directly relevant: `reading.ts` re-exposes both bugs this PR fixed

Not scored against this PR (different file, different route, arguably a different feature — the
Reading passage picker predates the Listen/F-012 surface), but worth flagging since it bears directly
on both things I was asked to verify:

- **Romanization is still on the wire elsewhere.** `server/src/routes/reading.ts:109` and `:120`
  (`GET /reading/units/:corpus/:unitId/sentences`) still `SELECT id, ordinal, korean, english,
  romanization, speaker, is_dialog` from both `ttmik_sentences` and `iyagi_sentences`. The commit
  removing romanization (`648e5ec`) touched only `ttmik.ts`/`Ttmik.tsx` — its own message scopes the
  directive to "the Listen surfaces," and the client type for this route
  (`client/src/types/domain.ts:721,1757`) still models `romanization` as a real, documented field for
  the Reading-passage feature, with no current renderer consuming it
  (`grep -rn romanization client/src` outside `types/domain.ts` and `pages/Ttmik.tsx` is empty). So
  this reads as a deliberately separate feature rather than a leftover — but if "no romanization
  anywhere" was meant app-wide rather than Listen-only, this route falsifies that claim today. Worth
  a one-line confirmation of intended scope, and a ticket either way.
- **The exact `hosts`-as-`string[]` bug, latent.** `server/src/routes/reading.ts:78-84` selects the
  raw `hosts` TEXT column for the iyagi branch of `/reading/units` and types the row as
  `UnitRow.hosts?: string[]` (`server/src/routes/reading.ts:29`) — not run through `splitHosts` or
  any equivalent. The client type (`client/src/types/domain.ts:686`) matches the same wrong shape.
  No current component calls `.map()` on it (`grep -rn "\.hosts\b" client/src` outside `Ttmik.tsx`'s
  already-fixed `meta.hosts` is empty), so it isn't live-crashing today — but it's the identical
  landmine this PR just defused in `ttmik.ts`, sitting one feature over, with nothing to stop the
  next person who wires up a hosts column in the Reading picker from hitting it again.

## Answering the specific checklist

- **Lesson detail shape `{ meta, highlights, transcript, audioUrl }`** — correct; `requireAuth`
  confirmed at router level; ordering by `ordinal` confirmed for both queries; join by `(level,
  number)` → `lesson.id` confirmed correct (no columns for level/number on the child tables); no N+1
  (`Promise.all`, both keyed on one already-resolved id).
- **`splitHosts`** — splits on `&`, trims, drops empties, `[]` on null/undefined — all confirmed;
  `UnitRow.hosts` is `string | null` (not `string[]`); a real `"A & B"`-shaped value
  (`"최경은 & 진석진"`) is seeded and asserted as an array in a dedicated regression test.
- **Romanization removed from the wire** — true for `ttmik.ts`'s own `SentenceRow`/
  `SENTENCE_COLUMNS`. The transcript's exclusion of `romanization`-kind lines is purely
  loader-guaranteed, not endpoint-enforced (SHOULD-FIX #2) — the endpoint trusts the loader.
- **Answer-strip / column privacy** — N/A per the task; confirmed no over-fetch of private/internal
  columns on any of the reviewed queries.
- **Tests** — would correctly fail on pre-fix `splitHosts`/ordering behavior; would **not** fail on a
  `romanization` regression at the endpoint layer due to `toMatchObject`'s partial-match semantics
  (SHOULD-FIX #1).
