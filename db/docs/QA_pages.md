# QA — P1.2 moved/changed pages, runtime-break audit (branch `feat/overhaul-p1.2`)

Read-only QA pass over the pages the overhaul touched, hunting for runtime breaks the
test suite might miss: a page that renders but whose moved/reworked feature is broken.
Method: read every scoped page + its moved components, trace each fetch to a live
server route AND through the nginx allow-list, trace every button/link to a registered
route, and re-check the reconciliations (bank-from-library, My-Lists dedup, drill
deep-link, exam resume) end to end. Complements `REVIEW_P1.2_routing.md` /
`REVIEW_P1.2_content.md` (both PASS); this pass re-verified their claims independently.

**Test run** (Docker, node:20-slim): targeted vitest over
Today / Progress / Grammar / review/* / Review / ReviewLibrary / MyVocabLists —
**9 files, 134/134 pass.** (`MyVocabLists.test.tsx` now exists — the content review's
"phantom test file" NIT is closed. The routing review's condition — the 3 dropped
series-carousel assertions — is met: Progress.test.tsx:435, 454, 551.)

## Verdict: no BROKEN findings. 1 real runtime RISK + 3 carried-over nits.

| Page / component | Verdict | Notes |
|---|---|---|
| `pages/Today.tsx` | **OK** | All states render; both fetches live; all 5 nav targets registered; placeholders designed |
| `pages/Progress.tsx` | **OK** | Moved carousel + compare fully self-sufficient in new host; per-skill degrade honest; placeholder designed |
| `pages/Grammar.tsx` | **OK** | banked default, drill deep-link, graduate/readmit, library hand-offs all sound |
| `pages/review/ReviewVocab.tsx` | **OK** | Browse + filters + pager + add-to-list intact; `?tab=lists` deep link honoured |
| `pages/review/ReviewDictionary.tsx` | **OK** | Browse/초성/search/pager intact; NIT: error card has no Retry (carried over) |
| `pages/review/ReviewGrammar.tsx` | **OK** | Bank flow verified end to end (see below) |
| `pages/Review.tsx` (`/learn/vocab`) | **OK** | Dedup clean — no duplicate list surface; manage-link + drill deep-link both land |
| `pages/ReviewLibrary.tsx` | **OK** | 4 real rows + 2 inert designed placeholders + 2 real hot chips |
| `components/MyVocabLists.tsx` | **RISK** | Silent delete/refresh failure when rows are present — see RISK-1 |
| `components/LibrarySubnav.tsx` | **OK** | Routes via `navItem()`; `aria-current`; no-op on the active section |
| `components/LibraryControls.tsx` | **OK** | Presentation-only; `Pager` guards `total === 0` |
| `components/WeeklySuggestions.tsx` | **OK** | `allSettled` per-source degrade; empty → renders `null`; idempotent add (409 → ✓) |

## RISK-1 — MyVocabLists: a failed delete (or refresh) is invisible when lists exist

`components/MyVocabLists.tsx:196` gates the error card on
`error && lists.length === 0`; the delete handler sets `error` at :116 but a delete
only ever fails while at least one list is still rendered, so the branch can never
show it.

Runtime scenario: user has lists → taps the row's ✕ → confirms the dialog →
`DELETE /vocab/lists/:id` fails (server restart mid-deploy, network blip) → the catch
runs `setError(...)` but the render falls through to the populated-list branch —
**nothing on screen changes**: the list stays, no error card, no toast. The user
either believes the delete worked (until a reload disagrees) or taps repeatedly.
Same gate hides a failed background `load()` after a create/rename — stale rows keep
rendering with no stale indicator (contrast `WordMasterySection`'s explicit
"Couldn't refresh — showing the last loaded mastery" banner, Progress.tsx:1116-1127).

Classification: **carried over, not a regression** — the old Reference ListsTab had the
identical gate (`59cb6a3^:client/src/pages/Reference.tsx:1263`,
"Could not delete the list." at :1216). Low severity in a single-user app, but it is
the one place in the audited scope where a user action can fail with zero feedback.
Fix shape (P2/P4): render `error` as an inline alert above the list regardless of
`lists.length` (the WordMastery stale-banner pattern), or route it through `useToast`.

## Verified end-to-end (the reconciliations)

- **Endpoint wiring — every fetch in scope hits a live, allow-listed route.**
  Cross-checked all client service paths against `server/src/app.ts` mounts +
  route registrations + the `location ~ ^/(auth|…)` regex in BOTH
  `Deploy/nginx-blue-active.conf:82` and `nginx-green-active.conf:137`:
  `/plan/today`, `GET /topik/attempt`, `/topik|vocab|grammar|writing/series`,
  `/diagnostic/history`, `/vocab/mastery`, `/vocab/entries(+bank)`,
  `/vocab/lists` CRUD + entries (client hits `/vocab/lists/*`; server mounts
  `vocabLists` at `/vocab/lists` BEFORE `/vocab`, app.ts:79-80 — order correct),
  `/krdict/search` (incl. `initial` — z.enum server-side, krdict.ts:74),
  `/grammar/kgiu(/:id)`, `/grammar/bank(+/:id/graduate|readmit)`,
  `/vocab|grammar/suggestions/weekly`, `/grammar-drill`, `/vocab/cards/*`.
  No renamed/orphaned path anywhere in scope. Fetch keys are unique per page
  (`today`, `today.attempt`, `progress.series`, `diagnostic.history`,
  `grammar:list`, `grammar:bank`, `review:*`) — the `today.series`→
  `progress.series` rename is identity-only (nothing persisted).
- **Bank from `/review/grammar`.** Optimistic flip → `kgiuBankBody` (clamped,
  register sanitised against the closed enum, `GR-` key via `grammarKey`) →
  409 kept as success → real failure rewinds + fixed copy
  (ReviewGrammar.tsx:195-224). Seeding from `GET /grammar/bank` reconciles because
  Grammar.tsx (`fromKgiu`, :198) and ReviewGrammar/WeeklySuggestions derive the SAME
  key from the same row shape; the historical non-GR keys ("kgiu-beginner-002") were
  400-rejected at write time so they cannot exist in `grammar_entries` to mismatch.
  Limit 400 == server ceiling (`grammar.ts:52`, `max(400)`).
- **My-Lists dedup.** Exactly one surface: create (kr + optional en + kind) /
  delete (confirm-gated) / open→real entries via `getListDetail` (BIGINT ids
  coerced) / optimistic remove w/ rollback / rename via `patchList`. Review.tsx
  renders only the seed card + "Manage my lists" → `/review/vocab?tab=lists`
  (:770), which `ReviewVocab.initialView` honours on mount (:76-87); its own
  ListDetailSheet is source-lists-only with a defensive custom fallback (:1584-88).
- **Grammar drill post-D3.** Default tab `banked`; a Review deep-link
  (`/learn/grammar` + `location.state.drillTarget`, Review.tsx:600-613) matches
  `readDrillTarget`'s shape exactly and opens Drill focused on that pattern —
  drillable even with an empty pool (DrillPanel:1119-23, 1275). Pool prefers
  active-banked, falls back to the corpus, never serves graduated. Cursor persists in
  localStorage (validated read). Both "Browse all patterns" hand-offs →
  `/review/grammar` (:648).
- **Today exam resume.** `GET /topik/attempt` returns `{ attempt: … | null }`;
  a resolved `null` is data (not an error) through `useEndpointOrMock`, the mock is
  `null` by design, and PROD failure keeps `data: null` — a fabricated resume CTA is
  impossible; failure degrades to the honest "No exam in progress" panel
  (Today.tsx:151-192). Resume → `/learn/topik` where MockMode's banner is
  authoritative.
- **Moved code is self-sufficient in its new hosts.** SkillTrendsCard/SkillTrendPanel
  take everything via one `UseEndpointOrMockResult` prop; `fetchSkillSeries` never
  rejects (allSettled, per-skill `metric:'none'` degrade) so the total-outage
  ErrorCard + per-panel degrade both work; the five-key mock is complete (no
  `seriesData[key]` undefined access). CompareCard renders SkillsCompare `full`
  with props matching its interface; AttemptCompare clamps stale selections. All
  moved CSS present: `data-skill` accents (Progress.css:394-98), `km-today__soon*`/
  `examPanel`/`shortcut` (Today.css), `km-library__*`, `km-resources__*`/
  `km-reference__*`/`km-review__kindOpt*` in the global `styles/index.css` (imported
  app-wide via main.tsx, so the extracted pages lost no styling when Reference.css
  ownership dissolved).
- **Placeholders.** Today grammar-practice + TOPIK-recommendation
  (`ComingSoonPanel`: icon + bilingual title + copy + pill), Progress
  `GrammarMasterySection`, library exams/uploads rows (non-interactive `div` +
  "Coming soon" pill) — all designed cards with existing icon names
  (`IconName` union) and existing CSS; none can render blank.

## Carried-over nits (pre-existing behaviour faithfully ported; not P1.2 breaks)

1. `ReviewDictionary.tsx:199` — error card without a Retry (old DictionaryTab gap).
2. MyVocabLists detail-sheet word count comes from the parent row snapshot; removing
   an entry doesn't live-update the header until reopen (old Reference behaviour).
3. Stale JSDoc: `types/domain.ts:1106` points at "`buildBankBody` in pages/Grammar.tsx"
   — it lives in `lib/grammarBank.ts` since P1.2. Comment drift only, as is the
   ≈370-vs-285 corpus-count drift already logged in `REVIEW_P1.2_content.md` NIT 6.
