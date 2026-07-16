# REVIEW — Batch 5 client half (F-107 saved-from-uploads UI + F-102 /images re-entry)

Reviewer: independent senior review, branch `feat/b5-uploads-provenance`, base `f01bdc4`.
Scope: `client/src/pages/review/ReviewVocab.{tsx,css,test.tsx}`, `client/src/pages/ReviewLibrary.{tsx,test.tsx}`, `client/src/services/vocab.ts`, `client/src/types/domain.ts`. BUILD doc verified against code, not trusted.

## Summary verdict

**PASS — 0 BLOCKER, 2 SHOULD-FIX, 5 NIT.** Surgical, convention-faithful work. The F-053 stub is replaced with exactly its documented contract (honest-null on empty AND on best-effort fetch failure, both test-pinned); the F-102 pinning test was strengthened, not loosened (4→5 rows, order, real per-row navigation, only-5-buttons invariant). Gates re-run independently by this review: 58/58 vitest (both test files), `tsc --noEmit` clean, eslint clean on all 4 source files. Top finding: the branch's own server change falsifies a doc comment 60 lines above the new code in the same edited file (`services/vocab.ts:69-78`).

## Bar checklist

| Bar item | Verdict | Evidence |
|---|---|---|
| WCAG AA / ARIA on new section | PASS | CollapsibleTile disclosure = real `<button>` + `aria-expanded`/`aria-controls`, collapsed body `aria-hidden`+`inert` (CollapsibleTile.tsx:98-135); per-upload `<section aria-label>` → named regions, tests query by `role('region')` (ReviewVocab.test.tsx:257,262) |
| WCAG AA / ARIA on Library row | PASS | Real `<button>` owns interaction, CityCard purely visual (ReviewLibrary.tsx:151-180); `role="list"`/`listitem` restore stripped semantics (144-150) |
| Keyboard reachable | PASS | Native buttons throughout; no click-only divs |
| Honest empty state, not dead blank | PASS | `if (groups.length === 0) return null` (ReviewVocab.tsx:423) — F-053 says "only shown if such items exist"; pinned at ReviewVocab.test.tsx:267-273 |
| Strict TS, no `any` at fetch boundary | PASS | `api.get<SavedFromUploadsResponse>` (services/vocab.ts:374), typed DTOs (domain.ts:999-1022); matches documented convention "server validates with Zod, client trusts TS types" (vocab.ts:19). No runtime validation — same as every sibling fn, not a regression |
| No swallowed errors | PASS w/ note | Fetch failure → section hidden, deliberate + documented (ReviewVocab.tsx:394-398) + test-pinned (test:275-284), mirrors theme-fetch posture (tsx:509-524). See NIT-1: catch is total (swallows programmer errors too), no dev log |
| Tests exercise REAL behavior | PASS | Grouped render with per-region containment via `within()` (test:249-265); empty→hidden (267-273); error→hidden + core surfaces intact (275-284). F-102: userEvent click + LocationProbe pathname assertion incl. Images→`/images` (ReviewLibrary.test.tsx:94-109) — not tautological |
| Pinning test guards nav regressions | PASS — strengthened | 5 rows + order (77-92), per-row nav target for all 5 (94-109), "only 5 buttons on page" (191), CityCard count 5 (139-140) |
| Backward compat (existing sections) | PASS | git diff: ReviewVocab.tsx changes confined to the `SavedFromUploads` stub body, header doc, one type import. Browse/My Lists/This Week byte-untouched |
| F-102 Library-row-not-LEARN reasoning | VERIFIED | All 7 `LEARN_SUBPAGE_IDS` paths under `/learn/*` (nav.ts:344-352); `/images` is not (nav.ts:293); `images` NavItem + route pre-existing (nav.ts:291-301, App.tsx:144, SECONDARY_IDS nav.ts:362). `sectionFor('images','plain')` = zero new patterns (ReviewLibrary.tsx:122) |
| Co-located CSS | PASS | 2 new rules only, rides shared `.km-vocab__section` rhythm (ReviewVocab.css:38-48) |
| No scope creep / dead code / TODO | PASS | Client diff = 7 files, all in ticket scope; `MineWordInput.source_upload_id` (domain.ts:996) is the F-107 client typing half; no TODO/FIXME in diff |

## Findings by category

### BLOCKER
None.

### SHOULD-FIX
1. **Stale doc falsified by this branch's own change** — `client/src/services/vocab.ts:69-78`: `SearchEntriesOptions.source_upload_id` doc still claims "WIRED but inert until U2 lands: no `vocab_entries` row carries a `source_upload_id` yet, so this param returns nothing today". F-107 (this branch) makes `POST /vocab/mine` write `vocab_entries.source_upload_id` (server/src/routes/vocab.ts:727, 746-747, 755), so mined rows now carry provenance and the U3a filter CAN return rows. Doc drift in a file this diff edited — a future reader will trust the wrong claim.
2. **No unit test for `fetchSavedFromUploads`** — `client/src/services/vocab.test.ts` tests essentially every export including trivial wrappers (getEntry :110, deleteList :516, seedListCards :611), but not the new fn's `res.groups` unwrap. Component tests mock the whole service module (ReviewVocab.test.tsx:65), so the wrapper has zero real coverage; the BUILD-doc gate "services/vocab.test.ts 36/36" is pre-existing tests only. (Precedent for the omission exists — `fetchVocabThemes` is also untested — but the file's dominant convention says add one.)

### NIT
1. `ReviewVocab.tsx:415-417` — `.catch(() => {})` is total: it swallows programmer errors (e.g. a TypeError off a malformed envelope) along with the intended network failures, and the user cannot distinguish "nothing saved" from "endpoint down". Posture is documented + test-pinned; a dev-only `console.warn` (`import.meta.env.DEV`) would make a silently missing shelf debuggable.
2. `ReviewVocab.tsx:404-423` — no loading placeholder: the section pops in after the fetch, shifting Browse downward (minor CLS). Acceptable for a conditional shelf; polish-backlog material.
3. `ReviewVocab.tsx:436` — `aria-label={group.upload.title}`: an empty-string title would yield an unnamed region. Server likely enforces non-empty titles; an `|| 'Untitled upload'` fallback is cheap insurance.
4. `client/src/components/SourceFilterRow.tsx:11` — sibling stale comment ("U1 has no `source_upload_id` on any `vocab_entries`/`kgiu_entries` row yet") also falsified by the F-107 write path; file untouched by this diff, so lower priority than SHOULD-FIX-1.
5. `ReviewVocab.tsx:426-430` — SavedFromUploads tile omits `tone` (defaults to `'accent'`) where the sibling My Lists tile passes `tone="accent"` explicitly (tsx:291-296). Same rendered result; explicitness inconsistency only.

### PRAISE (must not be undone)
- **Honest-null done right**: the stub → real component swap keeps the exact F-053 contract, with all three states (grouped / empty / failed) pinned by behavioral tests using `within()` region containment — a hostile upload title also stays inert (React text children, threat model documented at ReviewVocab.tsx:400-402).
- **Server-side BIGINT coercion instead of client patching**: unlike siblings that needed `numericId` client-side (vocab.ts:99-105), the new route folds and `Number()`-coerces on the server (server vocab.ts:912-928), so the client DTO (`domain.ts:1014-1017`) is honest with no redundant coercion.
- **F-102 pinning test strengthened**: order + count + real navigation + only-N-buttons invariant all updated coherently; an accidental sixth row or a silently dead Images row both fail loudly.
- **Surgical diff**: 95 lines in ReviewVocab.tsx, all inside the stub component and its doc; zero collateral churn.
- **BUILD doc is honest**: its "verify-before-build" section corrects the brief's wrong claim about pre-existing mine-path support, and its follow-ups section discloses the write-path caller gap rather than hiding it.

## Detailed findings

- `ReviewVocab.tsx:404-462` (SavedFromUploads): single mount-scoped fetch with AbortController + aborted-guard before `setGroups` (407-421) — no set-state-after-unmount, no race (effect has no deps, single flight). Keys are collision-safe (`saved-upload:${id}`, `saved:${uploadId}:${entryId}`; server guarantees an entry appears in exactly one group since provenance is a single FK).
- `services/vocab.ts:371-379` (fetchSavedFromUploads): signature/`signal` plumbing identical to sibling fns; doc comment accurately mirrors the server route's semantics (dedup, earliest save, ownership on the join) — cross-checked against `server/src/routes/vocab.ts:812-933`.
- `domain.ts:999-1022`: types match the server DTO exactly (nullable korean/english, ISO `savedAt`, numeric ids post-coercion).
- `ReviewLibrary.tsx:85-123`: `sectionFor('images','plain')` last in `SECTIONS`, copy sourced from the nav manifest (nav.ts:291-301) — no bespoke strings to go stale; module doc's placement rationale (lines 22-30) matches the code and the ticket.
- Tests: `ReviewVocab.test.tsx:145-147` defaults the new mock to `[]` so all pre-existing tests are isolated from the new section — correct backward-compat hygiene.

## Gate results (re-run by this review, not trusted from BUILD doc)

| Gate | Result |
|---|---|
| `npx vitest run src/pages/ReviewLibrary.test.tsx src/pages/review/ReviewVocab.test.tsx` | 58/58 pass |
| `npx tsc --noEmit` (client) | 0 errors |
| `npx eslint` on the 4 reviewed source files | clean |

## Coordination observations (for orchestrator / server reviewer)

1. **Write-path caller gap (documented, accepted)**: no client surface passes `source_upload_id` to `mineWord` yet (grep confirms; BUILD doc follow-up §"No client caller" concurs). Until F-108/U2, the section can only populate via list adds of upload-tagged entries — server reviewer should confirm that leg returns rows end-to-end.
2. SHOULD-FIX-1 spans the client/server boundary conceptually (client comment vs server behavior) — whoever runs the fix-pass should update `services/vocab.ts:69-78` and optionally `SourceFilterRow.tsx:11` in the same pass.
3. `MineWordInput` mixes `krdictEntryId` (camel) with `source_upload_id` (snake) on the same wire body (domain.ts:991-997); the snake choice is documented (matches DB column/query-param naming everywhere) and the server schema accepts both as-is (server vocab.ts:624) — flagged only so the server review confirms schema field names match; no change requested.
