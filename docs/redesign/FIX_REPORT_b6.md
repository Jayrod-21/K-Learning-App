# Fix Report — Batch 6 fix-pass (server follow-ups)

Fix-pass agent, independent of builder + reviewers. Branch `worktree-agent-a1fd8330d7b581634`, base e76c55d. Inputs: `REVIEW_b6-errors.md` (R1) + `REVIEW_b6-notif.md` (R2). Scope = polish only; F-093 contract behavior, kiwi leak fix, F-193 mapper untouched.

## Dispositions

### R2 SHOULD-FIX 1 — route-header inverse claim overstates round-trip fidelity (doc-only) → FIXED
`server/src/routes/settings.ts` — `deriveNotifFromSchedules` doc-comment expanded exactly as review prescribes: "exact inverse" claim scoped to what 064 *produces*; all 3 lossy legacy classes enumerated verbatim from review §1 (email-on/no-kinds → email false; sms-on → sms false unless F-040 sms rows; kinds-on/email-off → kinds false), each noted as 064's own documented drop, drift wire-only, no consumer affected. Zero code change.

### R1 NIT 1 — `isTransient` omits `UND_ERR_BODY_TIMEOUT` → FIXED
`server/src/services/kiwi.ts` — added `'UND_ERR_BODY_TIMEOUT'` to the transient-code list (+ inline comment). Body-stall after headers now retries, then surfaces fixed `kiwi unreachable` 502 instead of opaque 500. No leak-behavior change (review confirmed catch handles it correctly either way; both outcomes emit only fixed server-minted strings). Retry-classification only.

### R1 NIT 3 — F-193 test doesn't pin whitelisted message string → FIXED
`server/tests/routes/grammar.test.ts` — `it.each` matrix gains 4th column (expected wire message) + `expect(res.body.error.message).toBe(wireMessage)`: 429 → `too many requests — please slow down and try again shortly`; 400 → `your message could not be processed`; 503→502 → `the AI assistant is temporarily unavailable — please try again`. Matches `CLAUDE_CLIENT_MESSAGES` / `DEFAULT_UPSTREAM_MESSAGE` in errors.ts. Test-only, strictly additive.

### R2 NIT 2 — push-channel rows invisible in derived kind booleans → FIXED (doc)
Review asked "one sentence in the derive fn's doc-comment" — added (email-only keying mirrors 064 + F-040 client; revisit if push gains send behavior). Folded into the SHOULD-FIX comment edit. No code change.

### R1 NIT 2 — `mapClaudeError` 4xx passthrough puts `details: { status }` on wire → SKIPPED
Reason: fix requires changing the `UpstreamError` status-override mechanism or errorHandler details forwarding — wire-shape change inside the F-193/F-124 mapper that PASSed and is explicitly out of this pass's scope ("do NOT change the F-193 mapper"). Reviewer: pre-existing, server-minted, gated 400–499, harmless. Backlog candidate, not a polish fix.

### R2 NIT 3 — GET prefs SELECT + derive SELECT sequential, could `Promise.all` → SKIPPED
Reason: perf-only micro-opt inside PASSed F-093 route logic; reviewer calls it trivial on this route's traffic. Risk/benefit doesn't justify touching contract-adjacent code in a polish pass.

### R2 NIT 4 — `loadPrefsMock` still fabricates client-originated `notif` → SKIPPED
Reason: reviewer explicitly defers it to "the final client contract step" together with the outgoing-PUT notif. Mock-only, `isMock`-guarded, never adopted. Out of scope here.

### R2 NIT 5 — `seedSchedules` row-by-row insert loop → SKIPPED
Reason: test-only perf taste; loop is parameterized + CHECK-compliant and correctness-neutral. Not worth churn.

PRAISE items: all untouched (kiwi throw-path hygiene, status-override regression test, wire-level absence assertions, direct-DB no-dual-write assert, `parseStoredPrefs` strip-before-validate, derive-on-every-GET-branch).

## Gates (exact, from worktree)

| Gate | Command | Result |
|---|---|---|
| Server typecheck | `cd server && npm run typecheck` | **0 errors** (exit 0) |
| Server targeted | `cd server && npx vitest run tests/services/kiwi.test.ts tests/routes/lemmatize.test.ts tests/routes/grammar.test.ts tests/routes/settings.test.ts tests/services/notificationDelivery.test.ts` | **5 files passed, 131/131 tests passed** (264.9s; benign pre-existing pg `client.query()` deprecation warning) |
| Client targeted | `cd client && npx vitest run src/pages/Settings.test.tsx src/services/settings.test.ts` | **2 files passed, 65/65 tests passed** (7.6s) |

131 = reviewers' 94 (R1 four files) + 37 (settings.test.ts, counted separately by R2); same five files, single run here.

## Files changed
- `server/src/routes/settings.ts` — doc-comment only
- `server/src/services/kiwi.ts` — 1-entry retry-classification addition + comment
- `server/tests/routes/grammar.test.ts` — message-pin assertions
- `docs/redesign/FIX_REPORT_b6.md` — this report
