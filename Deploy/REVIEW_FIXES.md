# Re-Review of Fix-Pass — local CI gate + server/client fixes

Reviewer: independent re-reviewer (did not author the code and did not perform the
three original reviews). Fresh eyes, verified finding-by-finding against the ACTUAL
changed files, not the fix report's claims. No code was modified.

Contract: `/home/jared-williams/projects/SENIOR_ENGINEER_BAR.md`
(read §3.8 rate limiting, §5.2/5.3 tests, §6.3 docker socket, §6.9 Cloudflare/networking).

Artifacts verified:
- `Deploy/local-standup.sh`, `Deploy/local-test.sh`, `Deploy/local-build.sh`, `TESTS.md`
- `server/src/middleware/rateLimits.ts`, `server/tests/routes/reading.test.ts`
- `client/src/lib/grammarKey.ts`, `client/src/pages/Reference.tsx`, `client/src/pages/Reference.test.tsx`

Live facts checked on this box (M):
- `git status --short` confirms the four modified files (`Reference.test.tsx`,
  `Reference.tsx`, `rateLimits.ts`, `reading.test.ts`) plus the untracked new file
  `client/src/lib/grammarKey.ts` — matching R3-n2 exactly.
- `.gitignore` confirms `dist/` (root :2, client :11), `*.egg-info/` (root :28,
  `services/kiwi/.gitignore:10`) are gitignored — S2's "writes land only in
  gitignored paths" claim is factually accurate.

---

## Summary verdict: **PASS**

Every one of the four fixes I was asked to probe (B1, S1, S2, N3, N5, plus the N2
comment) is present in the actual code, correctly implemented, and does what the
fix report claims. No fix introduced a regression, and none undid a PRAISE item —
the HARD/SOFT accounting, the whole-repo-mount rationale, and the standup ordering
are all intact and, in the standup case, improved. The deferrals (N1, N4, N6,
R1-nits, R3-n1) are deferred for sound, documented reasons, not dodged. The two
files that the fix-pass should NOT have touched (`rateLimits.ts`, `reading.test.ts`)
are byte-consistent with the R1 PASS description; `grammarKey.ts` matches R3.

One residual, non-blocking item: the new `grammarKey.ts` is still untracked — it
MUST be `git add`ed together with the two `M` client files at commit, or the build
breaks (R3-n2). This is a commit-hygiene action, correctly flagged in the fix
report as "ACTION AT COMMIT," not a code defect.

---

## Finding-by-finding verification table

| Finding | Orig severity | Fix status | Notes (verified against code) |
|---------|---------------|------------|-------------------------------|
| **B1** — `services_default` network | BLOCKER (R2) | **FIXED** | `local-standup.sh:83-98` inspect-or-create (`docker network inspect \|\| create`), idempotent. Placed BEFORE `compose_shared up` (`:102`) in the straight-line path — no ordering gap; the only prior `return 1`s (missing tag :37-40, missing images :51-55) fail fast earlier. Production-host case is a clean no-op: if cloudflared already created the net, `inspect` succeeds and it logs "already exists" (`:93-94`). Comment (`:84-92`) accurately explains the M-box-owns-tunnel rationale. |
| **S1** — pip-audit advertised but not run | SHOULD-FIX (R2) | **FIXED** | `pip_audit()` now defined (`local-test.sh:186-202`) AND wired into `main()` as soft (`:229`). Not hollow: it installs the ingest loader pin set + `pip install -e /kiwi` (pyproject deps), then `pip-audit --strict` audits the whole resulting venv (`:192-201`). `--strict` non-zero is caught by `soft()` → non-blocking, mirroring CI's `\|\| true`. Header (`:30`) and `TESTS.md:38` now BOTH list pip-audit — the prior disagreement is resolved. Minor: the ingest pins are hand-maintained inline (coupling to `loader.Dockerfile`), documented at `:189-191` — same acceptable pattern as N6. |
| **S2** — "hermetic" over-claim | SHOULD-FIX (R2) | **FIXED** | Header no longer claims hermetic: "REPRODUCIBLE (fresh deps every run) but not fully hermetic; the writes are all to gitignored paths" (`local-test.sh:15-18`). `client_suite` now adds an anon volume over dist/ (`-v /app/dist`, `:93`) so builds don't dirty the host tree. server/kiwi rw mounts documented (`:111-118`, `:150-156`). gitignore check confirms dist/ + *.egg-info/ are gitignored, so the honesty claim holds. |
| **N2** — docker-socket trust boundary | NIT (R2) | **FIXED** | Explicit comment added at `local-test.sh:113-118` naming §6.3, distinguishing throwaway TEST containers from app containers, noting km-backup avoids the socket. Accurate. |
| **N3** — secret_scan cwd leak | NIT (R2) | **FIXED** | No `cd` remains; scans `"$REPO_ROOT"` via path arg (`:169-172`). Verified the grep still detects a planted key: GNU grep permits `--include`/`--exclude-dir` interspersed with the pattern + path; a `ANTHROPIC_API_KEY=sk-…` literal in a non-excluded `*.ts` under REPO_ROOT matches → `! grep` = false → `\|\| { return 1; }` fires → HARD fail. Detection intact; exclude-dirs (node_modules/.git/dist) only suppress false positives. |
| **N5** — arg validation | NIT (R2) | **FIXED** | `main()` `case` (`:208-212`): `""` and `--fast` accepted, anything else → usage message + `return 2`. Correct. |
| **N1** — node:20-slim toolchain | NIT (R2) | **DEFERRED-WITH-DOC** | Sound: latent only if a future native npm dep appears; currently green; justified inline (`:12`). No change needed. |
| **N4** — `! grep` masks exit 2 as clean | NIT (R2) | **DEFERRED-WITH-DOC** | Confirmed the behavior persists (grep exit 2 → `! grep`=0 → `\|\|` short-circuits → treated clean). This is a verbatim reproduction of `ci.yml:151-152`; parity with CI is the gate's purpose. Documented as inherited (FIX_REPORT N4). Sound deferral. |
| **N6** — db_suite inlined pins | NIT (R2) | **DEFERRED-WITH-DOC** | No CI db-pytest reference to drift from (CI runs no db pytest); low-risk local coupling. Sound. |
| **R1-nits (N1/N2)** — creationStack / non-atomic TRUNCATE | NIT (R1) | **DEFERRED-WITH-DOC** | Observations only; `creationStack:false` is guarded live by the 200-iteration test (`reading.test.ts:167`). `rateLimits.ts` was correctly NOT touched further. |
| **R3-n1** — test locality | NIT (R3) | **DEFERRED-WITH-DOC** | Optional polish; tests correct where they are. Sound. |
| **R3-n2** — new file untracked | NIT (R3) | **PARTIALLY-FIXED / ACTION-AT-COMMIT** | `grammarKey.ts` still shows `??` in `git status`. Must be staged with the two `M` files at commit or the build breaks. Correctly flagged, not yet actioned (expected — nothing committed yet). |

---

## Verification that untouched files stayed untouched (no wrongful change)

- **`server/src/middleware/rateLimits.ts`** — matches R1's PASS description exactly:
  lazy `_x ??= build*()` memoization (`:93-101`), stable wrappers (`:103-118`),
  `resetLimiters()` nulling instances (`:120-125`), `creationStack:false` on all
  three builders (`:41,54,67`), `skipSuccessfulRequests:true` on auth only (`:71`).
  The fix-pass did NOT alter it. Correct.
- **`server/tests/routes/reading.test.ts`** — TRUNCATE at `:36`
  (`ttmik_lessons, iyagi_episodes CASCADE`) and the 200-iteration cheap-bucket
  regression loop at `:167` / `got429` assertion at `:174` are present and
  unchanged. Correct.
- **`client/src/lib/grammarKey.ts`** — byte-identical to R3's confirmed extraction:
  `grammarKey` (`:19-23`), private `slugifyKey` regex chain (`:26-33`), type-only
  import (`:1`), doc comment (`:3-18`). Correct.

## Regression check against PRAISE items

- **HARD/SOFT accounting** — unchanged (`local-test.sh:53-73`, `:206-247`). `pip_audit`
  added purely as a `soft` call (`:229`); it cannot flip `HARD_FAIL`. No regression.
- **Whole-repo-mount rationale** — server_suite (`:106-118`) and kiwi_suite (`:152-156`)
  justifications intact; the S2 anon-volume change only affected client dist/. No regression.
- **Standup ordering** — the `services_default` ensure is inserted between the nginx.conf
  seed (`:68-81`) and `compose_shared up` (`:102`), preserving (and improving) the
  documented cold-boot sequence. No regression.

---

## New findings (fresh eyes) — none blocking

- **[NIT] Production-host edge on B1.** `local-standup.sh` targets the M box, but if
  it were ever run on the production host *before* cloudflared's "services" compose
  project came up, it would create `services_default` as a plain bridge; a later
  external-network declaration by cloudflared reuses an existing net, so this is
  benign, but it is an unlikely path the comment could mention. Not a defect for the
  stated target (M box, owns its own tunnel).
- **[NIT] `pip_audit` audits pip-audit's own transitive deps** alongside the ingest +
  kiwi surfaces (single shared venv). Harmless (only widens coverage) and matches how
  CI's job-scoped venvs behave in spirit; noting for completeness.

---

## Recommendation: **Ready to ship** (after the one commit-hygiene action)

All blocker + should-fix items are genuinely FIXED in the code; all deferrals are
documented and sound. The only gate before commit is R3-n2: `git add
client/src/lib/grammarKey.ts` alongside the two modified client files so the build
resolves the new module. No further fix-pass is warranted. A follow-up ticket for
N1 (native-toolchain divergence, if a native npm dep ever lands) and N4 (grep exit-2
masking, shared with `ci.yml`) would be reasonable house-keeping but is not required
for this ship.

Counts: FIXED 6 · PARTIALLY-FIXED 1 (R3-n2, action-at-commit) · DEFERRED-WITH-DOC 6 ·
NOT-FIXED 0 · REGRESSION-INTRODUCED 0.
