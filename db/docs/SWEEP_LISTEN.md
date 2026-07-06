# Listen audit

Scope: `client/src/pages/Ttmik.tsx`, `client/src/lib/tapChain.ts`,
`client/src/components/Tapword.tsx` + `WordPopover.tsx`, `server/src/routes/ttmik.ts`
(TTMIK lessons + Iyagi episodes). Branch `chore/reconcile-rebuild`. Verified against
the live `km-db` corpus (232 `ttmik_lessons` / 2,758 `ttmik_sentences` /
`ttmik_transcript_lines`, 139 `iyagi_episodes` / `iyagi_sentences`).

## Verdict

**Solid engineering, real content-data issues.** The code itself — null-korean
guards, persistent-audio identity, zero-romanization enforcement, path-traversal /
symlink defenses on the audio stream, abortable tap chain, graceful degradation on
lemmatize/define/enrich failure — is careful and well-tested; I could not find a
crash path anywhere in the Listen screen. What I did find are real, data-driven
issues: every TTMIK lesson title is a generic placeholder, ~14% of lessons default
to a misleadingly-empty Highlights tab, the shared word popover renders a visibly
blank "Example" section for a non-trivial slice of real dictionary entries, and one
specific lesson has a data-integrity defect (duplicate ordinals) that produces
duplicate React keys and jumbled highlight order. None of these are blockers; all
are things a tester will plausibly notice.

## Findings

### P2 — Every TTMIK lesson title is a generic placeholder, not real content

- **Repro:** Open Listen → TTMIK Lessons. Every row and every detail header reads
  "Level N Lesson M" (e.g. "Level 9 Lesson 5", "Level 2 Lesson 14") — never an
  actual TTMIK lesson name like "Formal vs. Informal" or "Body Parts".
- **Proof:** `SELECT count(*) FROM ttmik_lessons WHERE title ~ '^Level [0-9]+ Lesson [0-9]+$'`
  → **232 / 232** (100%). Root cause: `tools/ingest/parse_ttmik.py:127` —
  `title=f"Level {level} Lesson {lesson}"` — the ingest parser never extracts the
  real lesson title from the source PDF, it synthesizes a placeholder for every
  unit.
- **Will a tester hit it:** Yes, constantly — it's the primary label in the browse
  list and the detail header for all 232 lessons. Testers browsing by name (rather
  than level/number) have nothing to go on; two lessons are indistinguishable
  except by number. (Note: Iyagi episode titles are "이야기 #N" too, but that's the
  real TTMIK convention for that numbered series — not a placeholder gap the way
  the lesson titles are.)
- Not a Listen-screen code bug — the page renders `lesson.title` correctly; the
  defect is upstream in the ingest tool. Flagging because it's 100%-reproducible
  and directly hurts the feature testers are being asked to try.

### P2 — Default Highlights tab looks empty on ~14% of lessons that actually have content

- **Repro:** Open any of the 32 lessons below. Highlights (the default sub-tab)
  shows "No highlights for this one." with no visual cue that the Transcript tab
  (one click over) has real content.
- **Proof:** `SELECT count(*) FROM ttmik_lessons l LEFT JOIN ttmik_sentences s ON
  s.lesson_id=l.id LEFT JOIN ttmik_transcript_lines t ON t.lesson_id=l.id GROUP BY
  l.id HAVING count(s.id)=0 AND count(t.id)>0` → **32 lessons** (e.g. Level 2
  Lesson 13 — 0 highlights, 19 transcript lines; Level 7 Lesson 27; Level 4 Lesson
  4; Level 9 Lesson 3; Level 1 Lesson 4/15; Level 3 Lesson 2/21; Level 9 Lesson 8).
  Code: `Ttmik.tsx` `HighlightsPanel` (~line 964) renders the empty state with no
  pointer to Transcript; `lessonTab` defaults to `'highlights'` (line 554).
- **Will a tester hit it:** Likely — 32/232 (~14%) of the catalog. A tester who
  opens one of these and doesn't think to check the Transcript sub-tab will
  reasonably conclude the lesson has no read-along content for its audio, when a
  full transcript exists.

### P2 — WordPopover renders a visibly blank "Example" section for words with no examples

- **Repro:** Tap a Korean word whose KRDICT entry has zero example sentences AND
  whose Claude enrichment also returns no examples (enrichment can fail/timeout
  independently — `tapChain.ts` `resolveWordPopover` degrades silently on an
  `enrich` failure). The popover opens showing the "Example" eyebrow label with
  two empty lines beneath it — no text, just blank space where Korean + English
  examples should be.
- **Proof:** `client/src/components/WordPopover.tsx:229-233` renders
  `<div>Example</div><div>{data.ex_kr}</div><div>{data.ex_en}</div>` unconditionally
  whenever `isLoading` is false — there's no `ex_kr !== ''` guard the way
  `SentenceRow`/`TranscriptLineItem` guard their optional fields elsewhere in this
  same codebase. `buildWordPopover` (`tapChain.ts:196-213`) sets `ex_kr: '' , ex_en:
  ''` whenever both the dictionary and enrichment came back with zero examples.
  DB proof this is common, not theoretical:
  `SELECT count(*) FROM krdict_entries` = 53,978;
  `SELECT count(DISTINCT s.krdict_entry_id) FROM krdict_senses s JOIN
  krdict_examples e ON e.krdict_sense_id=s.id` = 51,821 → **2,157 entries
  (~4%) have no example sentence at all** even before accounting for enrichment
  failures/rate-limiting (enrich sits in the "expensive" rate bucket — see
  `server/src/middleware/rateLimits.ts`), which will push the effective rate
  higher during a burst of taps.
- **Will a tester hit it:** Yes — this is the single most likely tap-chain issue a
  tester will run into, since tapping words is the headline gesture of this screen
  and roughly 1 in 25 real dictionary entries (before enrichment failures) has no
  example. This is a shared component (`WordPopover`) also used by Reading, so the
  bug isn't introduced by Listen, but Listen's transcript taps are a live path to
  it.

### P3 — Lesson 6·12 (`ttmik_lessons.id=137`) has duplicate `ordinal` values in `ttmik_sentences`, producing duplicate React keys and jumbled Highlights order

- **Repro:** Open Level 6 Lesson 12 → Highlights. The panel interleaves two
  unrelated content groups (grammar-phrase highlights: "이렇게 하다", "물어보다" …
  and a hanja word-building breakdown: "과+식", "과+음", "과+속" …) because both
  groups were ordinated 1..N independently within the same lesson, and
  `HighlightsPanel` keys each row on `sentence.ordinal` (`Ttmik.tsx:957`).
- **Proof:** `SELECT lesson_id, ordinal, count(*) FROM ttmik_sentences GROUP BY
  lesson_id, ordinal HAVING count(*) > 1` → only `lesson_id=137` (Level 6 Lesson
  12), ordinals 1–4 each appear twice (ids 1721–1724 vs 1758–1761); the group
  actually runs to 16 rows total (a 4-item phrase group + a 12-item hanja group).
  `ttmik_sentences` has no `UNIQUE(lesson_id, ordinal)` constraint (unlike
  `ttmik_transcript_lines`, which does enforce one via
  `uq_ttmik_transcript_lines_lesson_ordinal`) — so this is a structural gap that
  could recur on a future re-ingest, not purely a one-off.
  React's `[...rows].sort((a,b) => a.ordinal - b.ordinal)` (`Ttmik.tsx:726`) is
  stable, so today's row order is deterministic given Postgres's current physical
  row order (verified: 3 repeated identical queries returned the same order) — but
  duplicate `key=` values on sibling `<li>`s is still a real React key-uniqueness
  violation, and the displayed content itself (phrase #1, hanja #1, phrase #2,
  hanja #2 …) doesn't read as a coherent list either way.
- **Will a tester hit it:** Only if they open this one specific lesson (1/232) —
  edge case, but 100% reproducible on that lesson, not a hypothetical.

### P3 — Level 9 Lesson 5 is functionally content-empty

- **Repro:** Open Level 9 Lesson 5. Highlights: "No highlights for this one."
  Transcript: a single line reading "- 1 / 2 -" (a PDF page-footer artifact, not
  real lesson content).
- **Proof:** `ttmik_sentences` for `lesson_id` of Level 9/5 → 0 rows.
  `ttmik_transcript_lines` → 1 row: `{ordinal:1, kind:'prose', korean:NULL,
  english:'- 1 / 2 -'}`. Renders correctly per the `prose` contract (no crash —
  `korean` is null so only the English note paints), but the lesson has
  effectively zero real content behind its audio, likely an ingest gap for this
  one PDF page.
- **Will a tester hit it:** Only if they specifically browse to Level 9 Lesson 5 —
  true edge case (1/232).

## Checked-and-clean

- **Null-korean crash (the historical regression):** fully guarded.
  `tapChain.ts` `tokeniseKorean` uses `korean?.match(...) ?? []` so a `null`
  Korean line yields zero tokens instead of throwing; `TranscriptLineItem`
  (`Ttmik.tsx:1009-1079`) checks `line.korean != null && line.korean !== ''`
  before rendering a `TapKorean` for every kind (`header`, `prose`, `pair`,
  `dialog`); `header` falls back to `line.english ?? ''`. Confirmed exercised by
  `Ttmik.test.tsx` ("renders every transcript line kind…") with a `korean: null`
  header + prose fixture, and confirmed no `ttmik_transcript_lines` row anywhere
  in the corpus violates the `CHECK (korean IS NOT NULL OR english IS NOT NULL)`
  constraint, so a fully-null line is impossible at the DB layer too.
- **Zero romanization, hard requirement:** verified at both layers. Server: the
  shared `SENTENCE_COLUMNS` projection (`ttmik.ts:132`) never selects
  `romanization`, and the transcript query explicitly filters `kind <>
  'romanization'`. Client: `SentenceRow` never reads `sentence.romanization`; the
  `TranscriptLineItem` `'romanization'` case returns an empty fragment. No path
  renders it.
- **Persistent audio across Highlights ↔ Transcript:** `<audio>` is rendered once,
  outside and above the sub-tab-switched subtree, never keyed on `lessonTab` —
  confirmed by code structure and by `Ttmik.test.tsx`'s reference-equality
  assertion (`toBe(audio)` across a tab switch). Detail view IS keyed on
  `selectionKey(selection)`, so opening a different lesson/episode correctly
  remounts (fresh player) while switching sub-tabs of the SAME unit does not.
- **Iyagi `hosts` string→array crash (the other historical regression):** fixed
  and holding. `splitHosts` (`ttmik.ts:123`) splits the raw `"A & B"` TEXT column
  into a real `string[]` at the server boundary; DB check confirms every episode
  has a non-null, non-empty `hosts` value (0 null, 0 empty), and all 16 distinct
  formats in the corpus are simple `"name & name"` pairs — `splitHosts` handles
  all of them correctly (also handles a lone name with no `&`, tested).
- **Audio streaming security (path traversal / symlink escape / range handling):**
  reviewed `resolveAudioFile` and `parseRangeHeader` — absolute-path rejection,
  lexical `..`-collapse + prefix check, THEN a `realpath()` re-check against the
  resolved root (defeats a symlink planted inside the tree), uniform 404 on every
  rejection branch (no existence oracle), single-range-only parsing with correct
  suffix-range / unsatisfiable-range / EOF-clamping behavior. No exploitable gap
  found.
- **Rate limiting on the tap chain:** `lemmatize`/`enrich` sit in the
  "expensive" per-user bucket, `define` in "cheap", audio streaming in its own
  "media" bucket specifically so an active listening session can't starve the
  JSON calls. Every step of `resolveWordPopover` is independently try/caught, so
  a 429 (or any other failure) at any step degrades gracefully to the next
  fallback instead of hanging or throwing to the user — confirmed no code path
  strands the popover in a permanent loading state.
- **Stale-response races:** both the detail fetch and the tap chain key to their
  own `AbortController`; a new tap aborts the in-flight one, closing the popover
  aborts it, and unmounting the detail view aborts it — all confirmed against
  `null`-return + `signal.aborted` checks at every `await` boundary.
- **Empty/loading/error states for both list screens and the detail view:**
  present and covered by tests (empty catalog, list-fetch failure + working
  retry, detail-fetch failure + working retry) — matches what I traced in the
  code.
- **Audio `src` origin-pinning:** `buildAudioSrc`'s allow-list regex
  (`^\/(?:ttmik\/lessons\/\d+\/\d+|iyagi\/episodes\/\d+)\/audio$`) rejects
  anything but the exact expected shapes, closing the `"/\\evil.example/…"`
  double-slash-normalization trick the code comment calls out.
- **Duplicate-ordinal check on `ttmik_transcript_lines` / `iyagi_sentences`:**
  clean — the transcript-lines table has a DB-enforced `UNIQUE(lesson_id,
  ordinal)`, and a live query found zero ordinal collisions in `iyagi_sentences`
  (only `ttmik_sentences` had the one lesson noted above).
