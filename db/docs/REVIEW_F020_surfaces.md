# Review — F-020 "Ask about this": entry-point wiring + data correctness (4 surfaces)

- **Commit reviewed:** `97eff80` — feat(chat): 'Ask about this' — seed Chat from a reviewed item (F-020)
- **Slice:** the 4 wired surfaces only — `Mistakes.tsx`, `topik/MockMode.tsx` (TopikResults), `Topik.tsx` (study reveal), `Diagnostic.tsx` (reveal) — plus their tests. The seed module (`lib/askSeed.ts`), button component, and Chat consumption are other reviewers' slices; touched here only as the contract.
- **Reviewer:** independent senior review; standard senior bar (no SENIOR_ENGINEER_BAR.md in repo).
- **Tests run:** `docker run … npx vitest run Mistakes.test.tsx MockMode.test.tsx Topik.test.tsx Diagnostic.test.tsx` → **48/48 passed** (exit 0).

## Verdict

**PASS — no blockers.** All four surfaces map the `AskSeedInput` fields correctly: `correctText` is definitively the correct option's display text on every surface, `userPick` is definitively the user's wrong answer and is omitted on correct/skipped, `prompt`/`passage`/`explanation` are the real stem/passage/explanation, and F-009 gating is mirrored so no surface leaks an explanation its UI withheld. The highest-risk class the review probed for — a mislabeled field putting wrong information into the AI seed — is **absent on all four surfaces** (verified against types, server id scheme, and fixtures, not just the diff). What keeps this from a clean pass is test coverage: 3 of the 4 surfaces prove only that the button renders, so the correctness established by this review is protected by tests on exactly one surface.

## Field-correctness verification (the core probe)

| Surface | `correctText` | `userPick` | `explanation` vs UI | Gating |
|---|---|---|---|---|
| **Mistakes** (`Mistakes.tsx:91-104`) | `item.options.find(o => o.correct)?.kr` — the correct-flagged option's Korean text ✓ | `item.options.find(o => o.id === picked)?.kr` — `Mistake.picked` is documented as the WRONG choice id (`services/topik.ts:229-238`; endpoint returns misses only) ✓ | `item.explanation`, shown unconditionally on the card — all rows are misses, F-009 trivially satisfied ✓ | Button on every mistake card — every card is reviewable content ✓ |
| **MockMode / TopikResults** (`MockMode.tsx:1256-1270`) | `row.correctText` = `choiceText(item, rev.correctChoiceId)` — server-graded reveal's correct id resolved to `.kr` (`MockMode.tsx:1325`) ✓ | `row.pickedText` only when `!row.isCorrect && pickedText !== 'skipped'` — wrong picks only; skips and correct rows omitted ✓ | Passed only when `!row.isCorrect`, exactly mirroring the F-009-gated paragraph at `MockMode.tsx:1252-1254` — no leak ✓ | Button on every review row incl. correct rows; a correct row's seed carries only prompt/passage/correct-answer (text the UI already showed as "Your answer") ✓ |
| **Topik study reveal** (`Topik.tsx:625-637`) | `correctChoice?.kr` where `correctChoice` = the `correct`-flagged option (`Topik.tsx:513-515`) ✓ | `!isCorrect ? pickedChoice?.kr : undefined`; `isCorrect` compares `picked === correctChoice?.id`; skip → `picked === null` → `pickedChoice` undefined → omitted (and skips never reveal, so no button anyway) ✓ | The study reveal shows the explanation on correct AND wrong answers (`Topik.tsx:611-613` — F-009 gates the *results list*, not the in-flow reveal); the seed passes it under the same condition (`explanation !== ''`) — matches what's on screen, correctly not over-applying F-009 ✓ | Button only inside the `revealed ?` block ✓; test asserts absence pre-reveal ✓ |
| **Diagnostic reveal** (`Diagnostic.tsx:765-783`) | `item.choices.find(c => c.id === reveal.correctAnswer)?.kr ?? reveal.correctAnswer` — see id-scheme verification below ✓ | `!reveal.correct && picked !== null ? item.choices.find(c => c.id === picked)?.kr : undefined` — server verdict gates it; wrong picks only ✓ | `reveal.explain` passed unconditionally; the Diagnostic reveal card shows `explain` unconditionally too (`Diagnostic.tsx:763`) — matches UI ✓ | Button only inside the `reveal ?` block ✓ |

**Diagnostic choice-id scheme (flagged thinnest — verified end to end):** the server builds both the served choices and `correct_answer` from the same `CHOICE_IDS` ('a'–'d') mapping (`server/src/routes/diagnostic.ts:404-419`, reveal at `:884/:891`), and the client UI already relies on the identical match to paint the green highlight (`Diagnostic.tsx:917` — `c.id === reveal.correctAnswer`). So the seed's resolution uses the same scheme as established, working UI behavior; the `?? reveal.correctAnswer` fallback can only fire on corrupt data, in which case the highlight is equally broken. Resolution: **correct**. The fallback's *shape* is a should-fix (below), not the resolution.

**MockMode `'skipped'` sentinel:** semantics are correct — a skipped item must not claim a wrong "My answer", and the filter at `MockMode.tsx:1266` achieves that for both producers (mock rows `MockMode.tsx:1324`, study rows `Topik.tsx:346`). Brittleness is real and is finding S2.

**Cross-surface consistency:** all four pass the Korean (`.kr`) option text — never the English gloss, never an option id (Diagnostic's fallback aside), never an index. Labels in the seed are English, content Korean, per the seed module's design. Coherent.

## Findings

### BLOCKER

None.

### SHOULD-FIX

**S1 — Three of four surfaces have render-only tests; a field mislabel would ship silently everywhere except Mistakes.**
`MockMode.test.tsx:284-287` (asserts 2 buttons exist), `Topik.test.tsx:223-240` (asserts absent-then-present), `Diagnostic.test.tsx:270-274` (asserts present) — none assert a single byte of the seed payload. Only `Mistakes.test.tsx:107-128` does the click-through probe, and it is well built: the fixture (`picked: 'a'` = 가 오답 wrong, `'b'` = 나 정답 correct, `Mistakes.test.tsx:45-64`) means a correct/pick swap would fail the "Correct answer: 나 정답" / "My answer: 가 오답 (incorrect)" assertions. The component test (`AskAboutThisButton.test.tsx`) proves click→router-state for *given props*, and `askSeed.test.ts` proves composition — so the untested layer is precisely the per-surface prop mapping, which is where every real bug in this feature class would live. MockMode is the worst case: it has the most intricate mapping (skipped sentinel + F-009 gating + server-graded rows) and zero data assertions — there is no test that a skipped row omits `userPick`, none that a correct row omits `explanation` from the seed, none that `correctText`/`pickedText` aren't swapped. Recommend replicating the Mistakes-style `ChatSeedProbe` on the MockMode results test (one wrong row, one skipped row) and on Diagnostic (asserting the id→`.kr` resolution); Topik study can piggyback the existing wrong-submit test with one `toContain('My answer: …')`.

**S2 — `'skipped'` is a magic string across two files, three sites.**
Produced at `MockMode.tsx:1324` and `Topik.tsx:346`, consumed by the new wiring at `MockMode.tsx:1266`. If either producer's literal changes (copy tweak, i18n to 건너뜀), the consumer silently mismatches and a skipped item seeds `My answer: 건너뜀 (incorrect)` — a fabricated wrong answer handed to the AI tutor. Severity today is low (the sentinel is documented on `ResultsReviewRow` at `MockMode.tsx:1138`, and a real Korean choice text colliding with the ASCII string `'skipped'` is implausible), but structurally it is below the bar: the row shape should carry `skipped: boolean` (or `pickedText: string | null`), or at minimum the literal should be one exported constant shared by all three sites.

**S3 — Diagnostic id-fallback puts a bare choice id into the seed; empty-string degrades better.**
`Diagnostic.tsx:772-773`: `?? reveal.correctAnswer` yields `Correct answer: b` — meaningless to the user reviewing the composer *and* to the AI (the UI labels choices ①②③④ via `CHOICE_MARKERS`, so 'b' corresponds to nothing anyone saw). Since `buildAskSeed` cleanly omits a blank `correctText` (`askSeed.ts:94`), falling back to `''` drops the line instead of asserting nonsense. Hiding the whole button is *not* warranted — the prompt/passage/explanation are still worth asking about, and this branch requires corrupt data anyway (see id-scheme verification). One-character-class fix.

**S4 — Diagnostic seed omits content the item is about: listening transcript, underline marking.**
A listening item renders its transcript (`Diagnostic.tsx:732-736`), but the seed carries only `prompt`+`passage` — for `section: 'listening'` the AI receives a stem like "무엇에 대한 이야기입니까?" with no way to know what was said. Similarly, underline items interleave `item.underline` into the passage for emphasis (`Diagnostic.tsx:866-880`); the seed passes the plain passage, so a "밑줄 친 부분…" question loses *which* span was underlined. Suggest `passage={item.passage ?? item.audio?.transcript}` (the transcript is the passage-equivalent for listening) and marking the underlined span in the seeded passage (e.g. wrapping it in ⟨ ⟩). Not a mislabel — nothing wrong goes in — but the feature's promise ("hand the item to the tutor") is materially degraded for two of the four diagnostic sections.

### NIT

**N1 — MockMode degraded-row fallbacks leak placeholder junk into the seed.** When the reveal's `itemId` misses the items map, `prompt` becomes `''` and `correctText` `'—'` (or `id.toUpperCase()` on a missing choice) — `MockMode.tsx:1307-1325`. `buildAskSeed` treats `'—'` as non-blank, so the seed reads `Correct answer: —`. Pre-existing degraded behavior the UI shares; noting for the record.

**N2 — The button's text joins the radios' accessible description.** Both the Topik and Diagnostic reveal cards are the `aria-describedby` target of every choice (`Topik.tsx` `revealBlockId`; `Diagnostic.tsx:930`), so screen readers now append "… Ask about this" to each choice's description. Harmless noise, but worth knowing the reveal card doubles as an ARIA description container before adding more chrome to it.

**N3 — `style={{ marginTop: 10 }}` copy-pasted at all four call sites** (`Mistakes.tsx:96`, `MockMode.tsx:1259`, `Topik.tsx:629`, `Diagnostic.tsx:769`) in a codebase otherwise styled via `km-*` BEM classes. The spacing belongs in the component (a `km-ask-about` wrapper class) so a fifth surface can't forget it or drift.

**N4 — Mistakes' `userPick` has no is-wrong guard.** `Mistakes.tsx:103` passes `pickedOpt?.kr` unconditionally — safe solely because `/topik/mistakes` returns misses only (`services/topik.ts:244-253`). If that endpoint ever grows a "recent answers" variant, this line would label a correct pick "(incorrect)". A one-line comment citing the invariant would do.

### PRAISE

**P1 — The Mistakes click-through probe is the model for this feature class.** Real `MemoryRouter` + probe route asserting the actual router state, with a fixture engineered so a correct/pick swap cannot pass (`Mistakes.test.tsx:75-128`). S1 is simply "do this three more times."

**P2 — F-009 discipline is exactly right in both directions.** MockMode gates `explanation`/`userPick` to misses, matching the UI (`MockMode.tsx:1263-1268`); Topik's study reveal shows the explanation on correct answers too, and the seed *matches that* rather than blindly copying MockMode's gate — the wiring tracks what each surface actually shows, not a cargo-culted rule.

**P3 — The Diagnostic pick-then-skip trap is already defused.** I probed whether a user who selects a choice and then hits Skip could leak the unsubmitted selection into `userPick` (server grades a skip; local `picked` might still hold the selection). It can't: `skip` does `setPicked(null)` before grading (`Diagnostic.tsx:520-524`), so at reveal time `picked !== null` is false. Whether by design or inheritance, the invariant holds.

**P4 — Topik gating is airtight and tested.** The button exists only inside the `revealed ?` block, so an un-revealed item can never offer a handoff, and `Topik.test.tsx:223-240` locks the absent-pre-reveal behavior in.

## Test run

```
docker run --rm -v "$PWD":/repo -v /repo/client/node_modules -w /repo/client node:20-slim \
  sh -ec 'npm ci … && npx vitest run src/pages/Mistakes.test.tsx src/pages/topik/MockMode.test.tsx src/pages/Topik.test.tsx src/pages/Diagnostic.test.tsx'
Tests  48 passed (48)   — exit 0
```
