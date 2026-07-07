# REVIEW — P1.2 Slice B: content fidelity + reconciliations (commit 59cb6a3)

Independent review. Scope: Reference dissolution fidelity, Grammar D3 + bank port,
My-Lists dedup, WeeklySuggestions park, react-refresh placement, test adequacy.
Spec: `db/docs/OVERHAUL_P1.2_BUILD.md` (Slice B, D2/D3) + `OVERHAUL_SCOUT_ia.md` §6.
Overriding requirement: no lost capability + dedup left exactly ONE working surface.

## Verdict: **PASS — 0 BLOCKERS**

Verification run (Docker, node:20-slim): `tsc -b --force` = 0, `eslint` = 0,
vitest targeted run = **104/104 pass** across 7 files
(grammarBank 17, ReviewLibrary 9, ReviewGrammar 11, Review 20, ReviewDictionary 3,
Grammar 30, ReviewVocab 14).

## Answers to the three fidelity questions

**(a) Reference dissolution — anything dropped?** No. Diffed all three extracted
pages against `59cb6a3^:client/src/pages/Reference.tsx` section by section:

- `/review/vocab` (`ReviewVocab.tsx`): VocabBrowse is a line-for-line port of the
  old VocabularyTab — F-003 `domain`+`book_level` filters ('all' omits the param),
  debounced search, pager against the real server `total` (with the pre-bump
  fallback), the stale-rows error fix (error always wins over stale rows),
  add-to-list Sheet with 409-as-gentle-success toast. All preserved verbatim.
- `/review/dictionary` (`ReviewDictionary.tsx`): browse-first on empty `q`, 초성
  InitialIndexBar (14 consonants + 전체), search-on-type supersedes 초성, clear
  returns to browse, 503 fixed copy, pager. Verbatim port; D2 honoured (separate
  page, not merged into vocab).
- `/review/grammar` (`ReviewGrammar.tsx`): F-005 filters, pattern count (hidden on
  error so it never describes a stale set), full-corpus fetch (limit 400), F-004
  detail Sheet via shared `KgiuDetailBody`, stale-detail-settle guard
  (`detailIdRef`). Verbatim + gained the Bank action (see b).
- ListsTab → superseded by `MyVocabLists` (see c). WeeklySuggestions → own
  component, parked atop `/review/vocab` (see below).

**(b) Banking-from-browse still reachable for a NON-banked pattern?** Yes —
not orphaned. Grammar.tsx dropped `list` and defaults to `banked`
(Grammar.tsx:336-338); a deep-linked `drillTarget` still opens the Drill tab
(same line, tested at Grammar.test.tsx:1084,1109); graduate/readmit fully intact
(Grammar.tsx:486-522, tested :1144,1221,1273). Banking now lives ONLY in
`/review/grammar`: per-row Bank button (ReviewGrammar.tsx:312-325) + Bank-in-sheet
(:409-420), optimistic flip, 409-kept-as-success, rewind + fixed copy on real
failure, banked state seeded from `GET /grammar/bank` via `listBanked`
(:99-117) so it reconciles with the LEARN screen's bank. Reachable paths to it:
BottomNav → Review library row, LibrarySubnav on any library page, and Grammar.tsx's
own "Browse all patterns" hand-offs in BOTH the empty and populated banked states
(Grammar.tsx:646-649, 786-795, 864-873). `kgiuBankBody` builds a correct body for
every gesture — see grammarBank note under PRAISE.

**(c) My-Lists dedup — one surface, nothing lost?** Yes, exactly one.
`MyVocabLists.tsx` at `/review/vocab?tab=lists` is the union:
create (Korean name + optional `name_en` + `kind` radio — ported from Review's
CreateListSheet), delete (confirm-gated), open → REAL entries via `getListDetail`,
optimistic remove-entry w/ rollback (from Reference), rename via `patchList`
(from Review's sheet — Reference lacked it). Review.tsx renders NO duplicate:
ListsPanel now has only the B-013 seed card, a "Manage my lists" link →
`/review/vocab?tab=lists`, and From-sources (Review.tsx:1217-1299); its
ListDetailSheet is source-lists-only with a defensive custom fallback
(:1559-1589). Review.test.tsx:501-529 proves the negative: no "New list" button,
no custom-list row, `getListDetail` never called, and the manage link asserted to
land on `?tab=lists`. The `/reference?tab=lists` shim also lands there
(`referenceTarget.ts:16-18`, tested in redirects.test.tsx).

On the "only ever showed zeros" claim: **slightly overstated but nothing real
lost.** The removed Review `CustomListRow` showed the REAL `entry_count`
(old Review.tsx `serverListsToBundle`: `count: r.entry_count`) alongside
hardcoded `mature: 0`, `due: 0`, `lastStudied: ''`, `preview: []` (maturity bar
pinned at 0%). The real datum (entry count) survives — MyVocabLists renders
`entry_count` per row and in the sheet header. No data or behaviour lost.

## Findings

### BLOCKER
None.

### SHOULD-FIX
None. (Everything below is cosmetic or a faithful carry-over of pre-existing
behaviour in a personal single-user app.)

### NIT
1. **Phantom test file in the verify manifest.** No
   `client/src/components/MyVocabLists.test.tsx` exists — the dedup coverage
   lives inside `ReviewVocab.test.tsx` (6 My-lists tests: deep-link, create,
   create-with-en+kind, remove-entry, rename, delete-confirm; that placement is
   fine, arguably better as integration coverage). But the vitest invocation that
   references the phantom path silently matches nothing (vitest fuzzy-matching
   coincidentally pulled in `ReviewLibrary.test.tsx` instead). If any future
   per-file manifest lists it, the suite would silently under-run. Nothing in
   TESTS.md references it today.
2. **Commit-message precision**: "custom-list rows … only ever showed zeros" —
   the row's count was real; only mature/due/lastStudied were zeros/empty. See (c).
3. **Dropped dead affordance**: old Review CreateListSheet had a "Seed words"
   textarea that was explicitly never wired into `createList` (documented Pass-4+
   TODO). MyVocabLists drops it without a placeholder — correct call (it was a
   live-looking no-op), but the Pass-4 seed-words intent now has no UI trace.
4. **ReviewDictionary error has no Retry** (`ReviewDictionary.tsx:199` —
   `<ErrorCard message={error} />` without `onRetry`). Faithful to the old
   DictionaryTab; pre-existing gap carried over, not a regression.
5. **Sheet header count staleness**: MyVocabLists' detail-sheet word count comes
   from the parent row snapshot, so removing an entry doesn't live-update the
   header until reopen. Identical to old Reference behaviour; carried over.
6. **Corpus-count comment drift**: `libraryFilters.ts:47` says "≈370";
   `Grammar.tsx:157` comment says "285 listable rows". One of them is stale.

### PRAISE
1. **`lib/grammarBank.ts` is a genuine improvement, not just a move.** One choke
   point for every bank gesture (library row, library sheet, weekly strip). The
   old Reference weekly strip used an exact-match `toBankProficiency` that banked
   a `beginner`-labelled KGIU pattern as `L3` and never sent `register`; it now
   rides `kgiuBankBody` → `toServerProficiency` (beginner→basic etc.) + exact-match
   register pass-through. grammarBank.test.ts (17) pins the coercions: composite
   register omitted (not guessed), min-1 fields defaulted, ceilings clamped
   (120/240/40), GR-shaped key asserted against the server regex.
2. **The extraction is disciplined** — every hard-won fix survived the move
   verbatim: stale-rows error precedence (vocab + grammar), stale-detail-settle
   guard, pager NaN fallback, 초성-vs-search precedence, 409-idempotency.
3. **Review.test dedup test is a real negative proof**, not a smoke assert:
   absence of create affordance, absence of the bundle row, zero `getListDetail`
   calls, and the deep-link destination all asserted.
4. **Grammar.test.tsx was repointed, not gutted** — 30 tests: post-D3 shape
   (default banked, NO list tab, library hand-off in both banked states), B-SF-1
   independence, detail sheet, full drill lifecycle incl. PROD posture, cursor
   persistence, graduate/readmit. Bank coverage moved with the capability to
   ReviewGrammar.test.tsx (11) + grammarBank.test.ts (17).
5. **Tab-aware `/reference` shim** covers all four old `?tab=` values + unknown
   fallback, exhaustively tested (redirects.test.tsx it.each of 6 paths +
   `referenceTarget` unit test); `ReferenceRedirect` correctly isolated in its own
   component file for react-refresh.
6. **react-refresh placement clean**: shared constants/types in `lib/`
   (libraryFilters, grammarBank, referenceTarget), hook in `hooks/`,
   LibraryControls exports components + type-only interfaces. Lint 0/0 confirms.
