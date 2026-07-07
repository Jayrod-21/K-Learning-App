# Independent Review — F-018 Rich Grammar Detail + ScreenStub Cleanup

Commit: `41055b2` (`feat(grammar): render rich detail (formation/examples/dialogues) + rm ScreenStub (F-018)`)
Reviewer: independent senior React review (did not author the change)
Scope: `client/src/components/KgiuDetailBody.tsx` (new), `Grammar.tsx`/`Reference.tsx` + tests, `types/domain.ts`, `lib/nav.ts`, `styles/index.css`, deleted `ScreenStub.tsx`.

## Verdict: PASS

No blockers. Two SHOULD-FIX items, one of which is a **pre-existing** wire gap this
change did not introduce (and faithfully preserved). Toolchain verified in Docker:
`tsc --noEmit` = 0, `eslint` = 0, `vitest run Grammar.test.tsx Reference.test.tsx`
= 58/58 passed.

---

## Probe results

### 1. Shared-component extraction — CORRECT
Both call sites now render the shared body with an identical one-liner:
- `client/src/pages/Grammar.tsx:2010` — `{detail && !loading ? <KgiuDetailBody detail={detail} /> : null}`
- `client/src/pages/Reference.tsx:1127` — same expression.

Both pass the same prop shape (`KgiuEntryDetail`); no prop/type mismatch. The
pre-F-018 rendering is preserved verbatim inside the component: the
explanation block (`Eyebrow` + 14px `--paper-dim` prose) and the
`Unit · {detail.unit ?? '—'}` footer are character-for-character what both
sheets rendered before extraction (compare deleted hunks at Grammar.tsx:2009-2025
and Reference.tsx:1124-1138 pre-image). The `loading`/`error`/mock-row branches
stay in the pages, so gating behavior is unchanged. Grammar's bank action and
Reference's retry affordance were untouched.

### 2. Wire-type correctness — CORRECT (verified end to end)
- Server route `server/src/routes/grammar.ts:105-127` (`GET /kgiu/:id`) SELECTs
  the raw columns `formation_rules, examples, dialogues` and spreads `rows[0]`
  into the JSON response — the wire names are snake_case and the client types
  (`client/src/types/domain.ts:1150-1156`) and component reads
  (`KgiuDetailBody.tsx:41,54,84`) use exactly those names. No camelCase drift
  that would silently render nothing.
- Non-null array typing is backed by the schema:
  `db/migrations/002_darakwon_corpora.up.sql:258-260` (`JSONB NOT NULL DEFAULT
  '[]'::jsonb`) plus `ck_kgiu_entries_jsonb_arrays` at :289-292
  (`jsonb_typeof(...) = 'array'`). Missing/null is impossible on the real wire.
- Defensiveness caveat: the DB CHECK pins the *container* type, not element
  shape — see SHOULD-FIX-2 below.

### 3. Empty-array handling — CORRECT
Every rich section — **including its `Eyebrow` header** — is gated on
`.length > 0` (`KgiuDetailBody.tsx:41,54,84`). A pattern with all-empty arrays
renders exactly explanation + unit footer, and
`Grammar.test.tsx` "renders no rich-section headers when the arrays are empty"
asserts the absence of `Formation`/`Examples`/`Dialogues` while confirming
explanation + `Unit ·` still render. The `dialogues` case (empty in all 294
corpus rows today) degrades to nothing rendered, no crash — the populated-
dialogue path is still exercised by both test fixtures so the code isn't dead-
on-arrival when a future corpus load populates it. `alternatives` is typed
`unknown` and deliberately not rendered — the right call for an unpinned shape.

### 4. XSS / rendering safety — CORRECT
All corpus strings (`rule`, `ex.korean`, `ex.english`, `dialogue.context`,
`line.speaker`, `line.korean`, `line.english`, `detail.explanation`,
`detail.unit`) render as React text children. No `dangerouslySetInnerHTML`
anywhere in the new component; grep of the diff confirms none was added. A
hostile corpus row cannot escape into the DOM. Speaker labels and context are
plain-text children like everything else.

### 5. Dead-code cleanup safety — VERIFIED SAFE
- `grep -rn "ScreenStub" client/src` post-commit: **zero hits**. Truly
  unimported before deletion (routes were already real screens).
- `grep -rn "PassNumber" client/src`: **zero hits** — the type's only consumer
  was ScreenStub itself. `nav.ts` doc comment updated to drop the stale
  ScreenStub reference (`client/src/lib/nav.ts:184-189`). The nav
  exhaustiveness checks were untouched.
- **`.km-stub` CSS retention was the correct and necessary call**:
  `client/src/App.tsx:171-173` (route-loading fallback: `km-stub`,
  `km-stub__title`) and `client/src/components/ErrorBoundary.tsx:46-49`
  (`km-stub`, `km-stub__title`, `km-stub__placeholder`) still consume all
  three classes. Deleting the CSS along with the component would have visually
  broken the loading and error surfaces; the commit kept it and retitled the
  CSS section comment (`styles/index.css:897`) to name the real consumers.
  Exactly right.

### 6. Test adequacy — GOOD, non-vacuous
- **Populated case, Grammar** (`Grammar.test.tsx:613-651`): asserts the
  `Formation` header + both bullet strings, `Examples` header + KR sentence +
  EN gloss, `Dialogues` header + context line + both speaker labels + KR turn +
  EN turn, and that explanation still leads. Every one of these (except
  explanation) would fail against the pre-F-018 sheet — non-vacuous.
- **Empty case, Grammar** (`Grammar.test.tsx:653-677`): asserts explanation +
  `Unit ·` present AND `queryByText` absence of all three headers.
- **Reference path** (`Reference.test.tsx:436-448`): the F-004 detail test now
  ships a fully populated fixture and asserts formation bullet, example KR,
  dialogue context, speaker, and dialogue KR through the Reference
  `GrammarDetailSheet` — proving the shared component is actually wired there
  too, not just imported.
- Stale-guard and error-path tests updated to the new array-typed fixtures.
  All 58 tests in the two files pass in a clean Docker run.

---

## Findings

### BLOCKER — none.

### SHOULD-FIX
1. **[pre-existing, surfaced by this review — not introduced by 41055b2]
   `unit` is missing from the detail endpoint's SELECT, so the footer shows
   `Unit · —` in production.** `server/src/routes/grammar.ts:114-118` selects
   16 columns but not `unit` (the list endpoint at :72 does select it).
   `KgiuEntryDetail extends KgiuEntrySummary` declares `unit: string | null`
   (`types/domain.ts:1109`), so the type asserts a field the detail wire never
   carries, and `detail.unit ?? '—'` (`KgiuDetailBody.tsx:104`) always renders
   the em-dash for real rows. Both test suites mask this by mocking a detail
   that includes `unit` (`Reference.test.tsx` asserts `Unit 9`) — the
   mock-richer-than-wire pattern this project has been burned by before. The
   extraction faithfully preserved the pre-F-018 behavior, so this is not a
   regression of this commit — but it is a one-word server fix (add `unit` to
   the SELECT) plus, ideally, one integration-flavored assertion against the
   real route shape. File as a follow-up.
2. **Element-shape malformation crashes the whole screen, not just the
   section.** The DB CHECK guarantees `jsonb_typeof = 'array'` but nothing
   about elements. If a future loader bug writes `formation_rules: [{...}]`,
   React throws "Objects are not valid as a React child"
   (`KgiuDetailBody.tsx:56`); a dialogue element missing `lines` throws
   `TypeError` at `dialogue.lines.map` (`KgiuDetailBody.tsx:124`). Either
   propagates to the app-level ErrorBoundary and blanks the screen instead of
   the sheet degrading. Likelihood is low (loader-controlled corpus, 287/294
   rows verified live, single-user app), so this is proportionate hardening,
   not a blocker: a cheap
   `formation_rules.filter((r) => typeof r === 'string')` /
   `Array.isArray(dialogue.lines) ? ... : []` at the render site — or a
   narrowing pass in `services/grammar.getPattern` — would confine a bad row
   to invisible-section behavior, matching the component's own stated design
   goal ("renders defensively").

### NIT
1. `KgiuDetailBody.tsx:53,69,112,132` — index-only `key={i}`. Acceptable here
   (static corpus content, never reordered/edited in place), noting for the
   record.
2. `Reference.test.tsx` covers only the populated case; the empty-arrays case
   is proven only through Grammar's suite. Defensible since both sheets render
   the same shared component, but one `queryByText('Formation')` absence check
   on the Reference path would close the gap cheaply.
3. `KgiuDetailBody.tsx:78,146` — the `!== ''` guards on `english`/`speaker`
   let a hypothetical `null` through (`null !== ''` is `true`), rendering an
   empty `<p>`/`<div>`. Harmless (empty element, no crash) and the types say
   `string`, but a truthiness check would be both shorter and stricter.

### PRAISE
1. The extraction is the right structural move: two previously copy-pasted
   sheet bodies now share one component, so the Grammar and Reference detail
   surfaces cannot drift — and the diff proves it by deleting identical hunks
   from both pages.
2. Honest typing discipline in `types/domain.ts:1123-1136`: `KgiuDialogue` is
   explicitly documented as "contract for future loads, not verified against
   live rows," and `alternatives` stays `unknown` and unrendered instead of a
   guessed shape. The remaining JSONB columns stay `unknown` until a feature
   renders them — no speculative typing.
3. The cleanup half was done with care: dead component and its orphaned type
   removed, but the shared `.km-stub` CSS — still load-bearing for the App
   loading fallback and ErrorBoundary — was kept and its comment corrected.
   That is exactly the mistake this cleanup could have made and didn't.
4. Test fixtures were migrated from `null` to `[]` with a comment citing the
   DB constraint, keeping the fixtures honest to the wire for the three
   F-018 fields.

---

## Verification log

```
docker run --rm -v "$PWD":/repo -v /repo/client/node_modules -w /repo/client node:20-slim \
  sh -ec 'npm ci ... && npx tsc --noEmit; echo TC=$? && npm run lint; echo LINT=$? \
          && npx vitest run src/pages/Grammar.test.tsx src/pages/Reference.test.tsx'
TC=0
LINT=0
Tests  58 passed (58)
```

Greps: `ScreenStub` → 0 hits; `PassNumber` → 0 hits; `km-stub` consumers →
`App.tsx:171`, `ErrorBoundary.tsx:46-49`; `KgiuDetailBody` consumers →
`Grammar.tsx:2010`, `Reference.tsx:1127`.

---

## Fix pass — both SHOULD-FIXes resolved (2026-07-06)

### SF-1 — `unit` restored to the detail wire (real prod bug)

- `server/src/routes/grammar.ts` (`GET /kgiu/:id`): `unit` added to the SELECT
  column list, with a comment explaining why it must ride along (the client's
  `KgiuEntryDetail extends KgiuEntrySummary` declares it and the Sheet footer
  renders `Unit · {detail.unit ?? '—'}`). The column exists on `kgiu_entries`
  (`db/migrations/002_darakwon_corpora.up.sql:241`, nullable TEXT) and the
  client type already carried it — only the SELECT was short.
- **Regression pin (fails if `unit` is ever dropped again):** new route test
  `detail wire carries the real \`unit\` value (REVIEW_F018 SF-1)` in
  `server/tests/routes/grammar.test.ts` seeds a row with a non-null unit
  (`seedKgiuEntry` in `server/tests/helpers/seed.ts` gained a `unit?: string`
  option, default NULL) and asserts `res.body.unit` equals the seeded string
  against the REAL route — an unselected column arrives as `undefined`, so the
  pre-fix wire fails this test. This closes the mock-richer-than-wire gap for
  this field the way the grammar-Bank incident taught: assert the wire, not
  the fixture.
- **Other richer-than-wire fields checked:** `register` is the only remaining
  summary/detail field the wire doesn't carry, and it is typed *optional* with
  an explicit doc comment saying the endpoint doesn't return it today
  (`types/domain.ts` `KgiuEntrySummary.register`) — and no client fixture
  ships it. No further fixture infidelity found.

### SF-2 — element-shape guards in `KgiuDetailBody`

- `client/src/components/KgiuDetailBody.tsx`: the three rich arrays are now
  re-narrowed from `unknown` at the wire boundary (`asArray`, `stringRules`,
  `isKgiuExample`, `isRenderableDialogue`, `isKgiuDialogueLine`). A malformed
  element (non-string formation rule, example missing/typed-wrong
  `korean`/`english`, dialogue without a `lines` array, malformed dialogue
  turn) is skipped and the rest of the sheet renders; a section whose every
  element is malformed collapses to nothing (same look as the legitimate
  empty-array case — no orphaned header). `dialogue.context` additionally
  requires `typeof === 'string'` before rendering. Well-formed rendering is
  unchanged — all pre-existing F-018 assertions still pass byte-for-byte.
- **Crash-regression pin:** new `client/src/components/KgiuDetailBody.test.tsx`
  (3 tests) feeds deliberately malformed details covering every crash mode the
  review identified: mixed valid+malformed elements (asserts valid parts
  render, malformed are absent, `render` does not throw), all-elements-
  malformed (headers suppressed, scalar fields intact), and non-array
  containers. Against the unguarded component the first test throws at the
  object-in-`formation_rules` React child and the `dialogue.lines.map`
  TypeError — so these fail without the fix.

### Verification (Docker, clean `npm ci`)

```
server: STC=0; tests/routes/grammar.test.ts  Tests 56 passed (56)   [was 55; +1 = SF-1 wire pin]
client: TC=0; LINT=0; BUILD=0; full suite    Tests 735 passed (735) [69 files; +3 = KgiuDetailBody.test.tsx]
```

No changes to the working F-018 rendering, the `.km-stub` CSS retention, or
any other reviewed surface.
