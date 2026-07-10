# FIX REPORT — Phase-2 Group 3 fix-pass

**Branch:** `feat/phase2-g3-backend-logic` (working tree, NOT committed)
**Fixer:** independent fix-pass (did not author, did not review)
**Date:** 2026-07-10
**Inputs:** `REVIEW_phase2g3_{generation,anki,writing_chat,integration}.md` (0 BLOCKER aggregate)

Note: telegraphic style below per repo standing order (internal artifact).

## Disposition table

| # | Finding (review) | Disposition | Where | Notes |
|---|---|---|---|---|
| 1a | docAttach surrogate-slice 500 (writing_chat SF-1) | **FIXED** | `server/src/services/docAttach.ts:157-173` (new `truncateAtCodePointBoundary`, :196-203) | `slice(0,4000)` on UTF-16 units stranded a lone high surrogate when unit 4000 = astral char → pg rejects unpaired surrogate in `::jsonb` → 500 on legit doc. Now truncates on codepoint boundary (drops dangling high surrogate; input is well-formed UTF-16 from `fatal:true` decode, so boundary cut is the only stranding vector). Test: `conversation.test.ts` "truncates on a code point boundary…" — doc = 3999×`a` + 2 emoji, unit 4000 mid-pair → 201, content = 3999×`a`, follow-up send 200 (no wedge). **Mutation-verified:** old code → 500 (`/tmp/km_p2g3_mutation.log`). |
| 1b | docAttach NFC-expansion 400 + false comment (writing_chat SF-2) | **FIXED** | `server/src/services/docAttach.ts:148-163` | Old order truncated pre-NFC; `sanitizeUserInput` length-checks post-NFC (`sanitize.ts:95-101`) and NFC can EXPAND (composition exclusions) → clean 4000-char doc → injection-flavored 400; adjacent comment asserted impossible. Now: NFC-normalize → codepoint-boundary truncate → sanitize. NFC idempotent + codepoint-prefix of NFC string stays NFC → guard's maxLength provably can't fire; comment rewritten to state the real invariant. Bound = the normalized length the DB stores (= ConversationInputSchema per-turn cap 4000, wedge-consistency preserved). Test: "accepts a clean document whose NFC normalization EXPANDS past the cap" — 3999×`a` + U+0958 (NFC → U+0915 U+093C, 4001 post-NFC) → 201, truncated flag set. **Mutation-verified:** old code → 400. |
| 2 | mapClaudeError flattens proxy 400/429 → 502 (generation SF-1) | **FIXED** (generation routes) + **F-094 filed** (other copies) | Helper: `server/src/middleware/errors.ts:90-124`; wired: `writing.ts:46,320`, `reading.ts:70,516` (private copies deleted) | No shared helper existed — 6 private flatten-to-502 copies. Created ONE shared `mapClaudeError` in middleware/errors.ts: proxy-origin 4xx (`PromptInjectionRejectedError` 400, `ClaudeRateLimitError` 429, `ClaudeInputValidationError` 400) pass status through via the existing `UpstreamError {status}` override (same mechanism `gradeWriting.ts:160`/`enrich.ts:55` already use); ≥500 still flattens to blanket 502 (Anthropic status never forwarded — SECURITY.md §13.7 honored, per review's reading). Generation pair (writing/reading) wired to it. Per task's risk clause, the four remaining copies (`grammarDrill.ts:~533`, `diagnostic.ts:~1596`, `conversation.ts:~1107`, `imageIngest.ts:~407`) NOT migrated — wire-contract change per route, each needs own suite run + status test → filed **F-094** in BUGS_AND_FEATURES.md. Tests: `generation.test.ts` "proxy prompt-injection rejection → 400 (not 502) and writes NO row" + "proxy per-route rate limit → 429 (not 502)" on `/reading/generate`, throwing REAL `PromptInjectionRejectedError`/`ClaudeRateLimitError` instances; existing "Claude failure → 502" tests (httpStatus 502) still green — mapping precision proven both directions. |
| 3 | Deploy/README.md missing Group-3 section (integration SF-1) | **FIXED** | `Deploy/README.md` — new "## Shipping Phase-2 Group 3 (migrations 053–055) — standard zero-downtime flow" after the Group-2 section | Mirrors Group-2 style: add-only chain (053 enum ADD VALUE ×2 / 054 new table / 055 enum + nullable ADD COLUMN, no default → no rewrite), no rename/drop-in-use, rollback-by-flip valid, unflagged up-deploy, no set-km-app-password (047 default privileges), nginx no-op (existing prefixes — F-012 trap n/a). Rollback caution: `--allow-destructive --target 052` crosses 054's DROP TABLE; 055 down silently discards titles (gate doesn't match DROP COLUMN); 053 down documented no-op; db-backup.sh first. |
| D1 | Anki client "~10 minutes" label (anki SF-1) | **DEFERRED → B-034** | `BUGS_AND_FEATURES.md` | Phase-3 client slice: `Grammar.tsx:~1573` + test pin + 3 domain.ts comments; `schedule.rating` already on the wire. Closes B-021 fully when landed. |
| D2 | B-027 client wiring (writing_chat coordination) | **DEFERRED → B-035** | `BUGS_AND_FEATURES.md` | `Writing.tsx:~228` must consume `GET /writing/prompts/random`; Q53/Q54 header hardcode folded in. B-027 stays open. |
| D3 | F-035/F-036 client ("+" attach, /name trigger) | **DEFERRED → F-095** | `BUGS_AND_FEATURES.md` | Phase-3 by design; expensive-limiter NIT cross-referenced for the name-on-open decision. |
| D4 | Writing-prompt content depth (~3 active/rubric) | **DEFERRED → F-096** | `BUGS_AND_FEATURES.md` | DATA ticket: add-only seed migration. |
| R1 | generation NIT-3 — relocate IDOR/orphan-row proofs from generation.test.ts to reading.test.ts | **REJECTED** (deliberate, task left to fixer's call) | — | Tests live correctly in `tests/routes/generation.test.ts` — the dedicated suite for the generation route surface; reading.test.ts covers chapters/positions. Moving them buys nothing; the review's real ask (name generation.test.ts in future gate lists) is a process note, honored here (suite run + extended). |

Out-of-scope items NOT touched (per task): SF-2 opus/temperature (generation review — codebase-wide coordination), anki N-1/N-2, writing_chat NITs 3/4/5/7, integration NITs 1/2, imageIngest injection-guard coordination item.

## Gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (server) | clean (exit 0) |
| `npm run lint` scope (touched files, legacy config) | 0 errors (4 pre-existing non-null-assertion warnings in reading.ts, untouched lines) |
| Targeted: `tests/routes/generation.test.ts` + `tests/routes/conversation.test.ts` | **104/104 passed** (30 + 74; includes the 4 new tests) |
| Mutation check (docAttach fix reverted) | both new tests FAIL exactly as predicted (500 / 400), fix restored byte-identical |
| FULL server suite alone (`npx vitest run`) | **1185 passed / 0 failed, 4 skipped** (skips = opt-in real-API smoke) — log `/tmp/km_p2g3_fix_server.log` |
| db-targeted tests | none run — no migration/SQL change in this fix-pass (code + docs + tests only) |

## Self-assessment

- Fixes are minimal + atomic: 1a/1b are one function-local reorder + one 8-line helper; #2 reuses the existing `UpstreamError {status}` mechanism and an existing in-repo precedent rather than inventing a new error path; no route logic touched beyond the catch mapping.
- Honest scope call on #2: migrating all six copies in one pass would change four routes' wire contracts without their reviews asking for it — F-094 records the debt with exact file:line + the test recipe.
- Risk watch for re-review: (a) `truncated` flag now compares against NFC-normalized length (a 4000-char pre-NFC doc that expands counts as truncated — correct per "what the DB stores" but a semantic change); (b) shared `mapClaudeError` also passes `ClaudeInputValidationError` (400) through — proxy input-validation failures on the generation routes were previously 502, now 400; both are proxy-origin client-fault statuses per `services/claude/errors.ts` design comments.
