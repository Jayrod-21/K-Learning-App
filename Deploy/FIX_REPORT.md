# FIX_REPORT — local CI gate + server fixes (fixpass)

Fix-pass over the three independent reviews of the local-host CI/deploy work:

- `server/REVIEW_FIXPASS_ratelimits.md` (R1 — PASS, 0 blocker)
- `Deploy/REVIEW_FIXPASS_localscripts.md` (R2 — SHIP AFTER FIXES, 1 blocker, 2 should-fix)
- `client/REVIEW_FIXPASS_grammarkey.md` (R3 — APPROVE, 0 blocker)

Contract: `/home/jared-williams/projects/SENIOR_ENGINEER_BAR.md`.

## Disposition

| ID | Severity | Source | Disposition | Notes |
|----|----------|--------|-------------|-------|
| B1 | BLOCKER | R2 | **FIXED** | `local-standup.sh` now ensures the external `services_default` network (idempotent `docker network inspect \|\| create`) before `compose_shared up`, with a comment explaining that this box owns the tunnel (dad's box gets it from the cloudflared project). Cold bring-up no longer hard-fails. |
| S1 | SHOULD-FIX | R2 | **FIXED** | Added a real `pip_audit` soft gate (audits the ingest loader deps that `loader.Dockerfile` bakes + `services/kiwi`'s pyproject deps) and wired it into `main()`; header + `TESTS.md` now list it. Mirrors `ci.yml`'s non-blocking pip-audit. |
| S2 | SHOULD-FIX | R2 | **FIXED** | Header no longer over-claims "hermetic" — states REPRODUCIBLE (fresh deps/run) with gitignored artifact writes. `client_suite` gained an anon volume over `dist/` so builds don't dirty the host tree. server/kiwi rw mounts are documented (writes land only in gitignored paths). |
| N2 | NIT | R2 | **FIXED** | Added a comment in `server_suite` documenting the Docker-socket trust boundary vs `SENIOR_ENGINEER_BAR §6.3` (test containers, not app containers). |
| N3 | NIT | R2 | **FIXED** | `secret_scan` no longer `cd`s (scans `$REPO_ROOT` via path arg) and excludes `node_modules/.git/dist` so a host `npm ci` tree can't false-positive or slow the scan. |
| N5 | NIT | R2 | **FIXED** | `main()` now validates its argument (`--fast` or none) and rejects unknown flags with a usage message. |
| N1 | NIT | R2 | **DEFERRED** | `node:20-slim` lacks a native-build toolchain; latent only if a future native npm dep appears. Currently green; the choice is already justified inline. No change. |
| N4 | NIT | R2 | **DEFERRED** | `! grep` treating exit 2 as "clean" is a **verbatim reproduction of `ci.yml:151-152`** — keeping parity with CI is the point of this gate. Documented as inherited. |
| N6 | NIT | R2 | **DEFERRED** | `db_suite` inlines its pin set; there is **no CI db-pytest reference to drift from** (CI runs no db pytest), so this is a low-risk local-maintenance coupling, not a fidelity gap. |
| R1-nits | NIT | R1 | **NO CHANGE NEEDED** | Observations only (the `creationStack:false` invariant is guarded live by the 200-iteration test at `reading.test.ts`). Nothing to change. |
| R3-n1 | NIT | R3 | **DEFERRED** | Moving the `grammarKey` unit tests out of `Reference.test.tsx` into a dedicated file is optional polish; the tests are correct where they are. |
| R3-n2 | NIT | R3 | **ACTION AT COMMIT** | The new `client/src/lib/grammarKey.ts` is untracked — it will be `git add`ed with the two modified files when this work is committed, so the build doesn't break. |

## Self-assessment against the bar's "Done" checklist (relevant subset)

- [x] Lint passes (shellcheck clean on all three scripts).
- [x] No secrets in code/config; secret-scan gate present and hardened.
- [x] Every bug fix ships with a regression check: B1 is exercised by `local-standup.sh` actually running on the cold M box (validated at stand-up); the server rate-limiter + reading-isolation fixes are covered by the now-green route suites (594 tests).
- [x] No dead/commented-out code; comments explain WHY; no TODO/FIXME without context.
- [x] Idempotent + observable: `services_default` ensure is inspect-or-create; every fatal path logs an actionable remedy.
- [x] `TESTS.md` updated; header and manifest now agree on the soft gates.

Full test gate re-run after these fixes to confirm no regression (see `.testgate5.log`).
