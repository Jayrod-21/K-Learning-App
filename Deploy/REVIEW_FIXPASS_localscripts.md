# Independent Review — Deploy/ local scripts (local-build / local-standup / local-test) + TESTS.md

Reviewer: independent senior DevOps/CI (did not author this code). No files were
modified — report only.

Artifacts reviewed in full:
- `Deploy/local-build.sh`
- `Deploy/local-standup.sh`
- `Deploy/local-test.sh`
- `TESTS.md`

Reference contracts read:
- `.github/workflows/ci.yml`
- `Deploy/README.md`, `Deploy/deployment-utils.sh`, `Deploy/docker-compose.shared.yml`,
  `Deploy/ensure-shared-volume.sh`, `Deploy/azure-deploy-inactive.sh`

Facts verified live on this box (M):
- `docker network ls` → `km-edge` and `km-internal` exist; **`services_default` does NOT exist.**
- Test path-depth assumptions confirmed against `server/tests/helpers/pg.ts:13`
  (`../../../db/migrations`) and `services/kiwi/tests/test_lemmatizer.py:217`
  (`parents[4]`), and the discriminator exclusion against
  `db/tests/test_discriminator_coverage.py` (scans gitignored `tools/ingest/output/`).

---

## Summary verdict

**SHIP AFTER FIXES.** `local-test.sh` is a faithful, well-built reproduction of
`ci.yml`'s *hard* gates and correctly adds db + kiwi coverage that CI omits; the
HARD/SOFT accounting is correct and no hard gate is silently weakened. Two things
must be addressed before these scripts can be trusted for their stated purpose:

1. **BLOCKER** — `local-standup.sh` will hard-fail on a cold M box because
   `compose_shared up` requires the external `services_default` network, which
   nothing here creates, checks, or documents (confirmed absent on this box).
2. **SHOULD-FIX (top finding)** — `pip-audit` is advertised in the `local-test.sh`
   header as a soft gate but is never actually run, so a supply-chain gap that CI
   surfaces is silently invisible locally.

Blocker count: **1**. Everything else is a soft gate parity gap, hermeticity
polish, or a NIT.

---

## Findings by category

### BLOCKER (1)
- **B1** — `local-standup.sh` depends on the unmanaged external network
  `services_default`; cold bring-up on M fails opaquely and undocumented.

### SHOULD-FIX (2)
- **S1 (top)** — `pip-audit` advertised but not wired: silent CI soft-gate parity gap + header comment mismatch.
- **S2** — Hermeticity: client/server/kiwi suites mount the source tree read-write and write artifacts (`dist/`, `*.egg-info`) back into the checkout, contradicting the "hermetic" claim.

### NIT (6)
- N1 `node:20-slim` lacks a native-build toolchain vs CI's ubuntu runner.
- N2 `docker.sock` + `--network host` trust/isolation note; base images unpinned by digest.
- N3 `secret_scan` leaks `cwd` into the calling shell.
- N4 `secret_scan` `! grep` treats a grep *error* (exit 2) as "clean".
- N5 `local-test.sh` arg handling silently ignores unknown flags.
- N6 `db_suite` inlines pinned deps that can drift from `db/tests` imports.

### PRAISE (7) — see bottom.

---

## Detailed findings (file:line)

### B1 — BLOCKER — `local-standup.sh` hard-fails on the `services_default` external network
`local-standup.sh:85` calls `compose_shared up`, which runs
`docker compose ... -f docker-compose.shared.yml up -d`
(`deployment-utils.sh:610`). That compose file declares **three** external
networks — `km-internal`, `km-edge`, and `services_default`
(`docker-compose.shared.yml:277-290`) — and `km-lb` attaches to
`services_default` (`docker-compose.shared.yml:93`).

`ensure-shared-volume.sh` creates only `km-internal` and `km-edge`
(`ensure-shared-volume.sh:77-78`); it deliberately does **not** create
`services_default` (it is owned by the cloudflared/`services` compose project —
`docker-compose.shared.yml:284-290`). `local-standup.sh` calls
`ensure-shared-volume.sh` (`local-standup.sh:61`) but never creates or checks
`services_default`, and its preflight (`local-standup.sh:47-55`) validates
**images only**, not networks.

Verified on M: `docker network ls` shows `km-edge` + `km-internal` but **not**
`services_default`. Therefore, on this exact box, `compose_shared up` aborts with
`network services_default declared as external, but could not be found` — deep in
the bring-up, with a raw compose error, after the script has already seeded
`nginx.conf` and ensured volumes. This defeats the script's stated purpose:
"FIRST-TIME cold bring-up of the stack on a fresh host (the M box)"
(`local-standup.sh:5-6`). The dependency is documented in the compose file's
comments but nowhere in the standup script's own header or preflight, so an
operator gets no actionable remedy.

Fix options (any one): (a) have `local-standup.sh` create a plain-bridge
`services_default` if missing before `compose_shared up` (idempotent, mirrors the
`ensure_network` pattern); or (b) add a network preflight alongside the image
preflight that fails fast with the remedy ("start the cloudflared stack, or
`docker network create services_default`"); or (c) at minimum document the
prerequisite in the header. Note this is a *cold-box* blocker only — if the
cloudflared stack is already up (as on the production host) the network exists and
standup proceeds; but that precondition is currently unchecked and undocumented on
the box these scripts target.

### S1 — SHOULD-FIX (top) — `pip-audit` advertised as a soft gate but never run
`local-test.sh:27` (header) lists soft gate 7 as
"npm audit (client + server), **pip-audit**". CI runs `pip-audit --strict || true`
in **two** jobs — `ingest-checks` (`ci.yml:93-97`) and `security-scan` for both
`tools/ingest` and `services/kiwi` (`ci.yml:136-146`). But `main()` wires only two
soft gates: `soft "ingest ruff" ingest_ruff` and `soft "npm audit (high)" npm_audit`
(`local-test.sh:190-191`). There is no `pip_audit` function anywhere and no call
site. So Python supply-chain advisories that CI surfaces (as warnings) are
**silently invisible** in the local gate, and the header comment overstates
coverage. Because CI marks these `|| true`, this does not change CI's pass/fail —
but the prompt's question "is anything ELSE silently skipped or downgraded?" is
answered here: **yes, pip-audit (ingest + kiwi), and it is falsely claimed as
present.** `TESTS.md:37` is at least honest (it lists only npm audit and omits
pip-audit), which makes the `local-test.sh` header the incorrect artifact.
Fix: add a `pip_audit` soft gate (ingest + kiwi) mirroring `ci.yml`, or strike the
`pip-audit` claim from the header and note the intentional omission.

### S2 — SHOULD-FIX — Hermeticity claim vs read-write source-tree mounts
The header claims the gate is "hermetic" (`local-test.sh:14-16`) on the strength of
the anonymous `node_modules` volume. But three suites mount the source tree
**read-write** and write build/install artifacts back into the checkout:
- `client_suite` mounts `client/` rw and runs `npm run build` → writes
  `client/dist/` on the host (`local-test.sh:86-89`; the comment acknowledges it).
- `server_suite` mounts the whole repo rw (`-v "${REPO_ROOT}":/repo`)
  (`local-test.sh:110`); any file a test writes lands on the host tree.
- `kiwi_suite` mounts the whole repo rw and `pip install -e ".[dev]"` writes
  `*.egg-info`/build metadata into `services/kiwi/` on the host
  (`local-test.sh:145-148`).
By contrast `db_suite` correctly mounts `:ro` (`local-test.sh:121`). The gate is
therefore *reproducible* (fresh deps per run) but not *hermetic*: it dirties the
tracked working tree, and a stale artifact (e.g. an old `client/dist/`) can outlive
a run and mask a problem. Recommend `:ro` + anonymous volumes over the specific
write targets where feasible (client needs `dist/` writable; kiwi's `egg-info` is
fixed to the package dir, so at least scope the rw mount), or downgrade the
"hermetic" wording to "reproducible dependencies; writes build artifacts into the
tree."

### N1 — NIT — `node:20-slim` toolchain vs CI ubuntu
`NODE_IMAGE="node:20-slim"` (`local-test.sh:42`) is Debian/glibc, same node major
as CI's `setup-node` 20 — a sound choice and correctly justified
(`local-test.sh:14`). It currently passes, so no dep needs `node-gyp`. Latent
risk: `slim` lacks `build-essential`/python, so a future native module would fail
`npm ci` locally while CI's ubuntu (with build tools) passes — a false divergence.
Worth a comment, not a code change today.

### N2 — NIT — docker.sock / host-network trust boundary; unpinned base images
`server_suite` and `db_suite` bind `/var/run/docker.sock` into the test container
(`local-test.sh:109`, `121`) and use `--network host` (`108`, `120`). This is the
correct and necessary pattern for testcontainers spawning sibling containers, but
it grants those containers **full control of the host Docker daemon
(host-root-equivalent)** and removes network isolation. Acceptable for a local gate
on the operator's own box — the trust boundary is "you already run this repo's
tests" — but worth stating explicitly; note that the km-backup design elsewhere
*deliberately avoids* the socket for exactly this reason
(`docker-compose.shared.yml:230-234`). Separately, `node:20-slim` / `python:3.12`
are mutable tags (unpinned by digest), so "reproducible" is best-effort against tag
drift. No secret exposure anywhere: `local-test.sh` and `local-build.sh` never
`load_environment`, and `run_migrate` passes the DSN via `-e` only, never logging
it (`deployment-utils.sh:482-488`).

### N3 — NIT — `secret_scan` leaks cwd
`secret_scan` does `cd "$REPO_ROOT"` (`local-test.sh:153`) with no subshell, so the
shell's working directory stays at `REPO_ROOT` for the remainder of `main`.
Harmless here because every other suite uses absolute `${REPO_ROOT}/...` paths in
its `docker -v` mounts, but it is avoidable state leakage — run the greps in a
`( cd … && … )` subshell or pass the path to `grep`.

### N4 — NIT — `secret_scan` masks grep read errors as "clean"
`! grep -rn …` (`local-test.sh:154-157`) turns grep's exit 2 (I/O/permission error)
into success, so a scan that *failed to run* reports "no secret found". This mirrors
`ci.yml:151-152` verbatim, so it is a faithful reproduction, not a regression — but
it is a latent weakness inherited from CI.

### N5 — NIT — no arg validation
`main` only tests `[[ "${1:-}" == "--fast" ]]` (`local-test.sh:174-175`); any other
argument (typo, `--help`) is silently ignored and the full gate runs. A one-line
usage guard would be friendlier.

### N6 — NIT — `db_suite` inlines pinned deps
`db_suite` pip-installs a hand-maintained pin set
(`psycopg[binary]==3.2.3`, `structlog==24.4.0`, `testcontainers`, `pytest`) inline
(`local-test.sh:125-128`) rather than from a `db/tests` requirements source. If the
db tests grow a new import, this list must be hand-updated or the suite breaks.
Because CI runs **no** db pytest, there is no CI reference to drift from — it is
purely a local-maintenance coupling.

---

## Fidelity assessment (local-test.sh vs ci.yml) — hard gates

| CI job | CI steps | local-test.sh | Verdict |
|--------|----------|---------------|---------|
| `client-checks` | `npm ci` → lint → `tsc --noEmit` → build (`ci.yml:26-36`) | `client_suite` identical (`local-test.sh:89`) | **Faithful** |
| `server-checks` | `npm ci` → lint → typecheck → test (`ci.yml:54-67`) | `server_suite` identical (`local-test.sh:112`) | **Faithful** (lint enforces the no-restricted-imports guardrails either way) |
| `security-scan` secrets | two greps (`ci.yml:148-153`) | `secret_scan`, HARD (`local-test.sh:151-159`) | **Faithful** |
| `ingest-checks` ruff | `ruff check . || true` (`ci.yml:90-91`) | `ingest_ruff`, SOFT (`local-test.sh:190`) | **Faithful** (soft = soft) |
| `ingest-checks` / `security-scan` pip-audit | `pip-audit --strict || true` ×3 (`ci.yml:93-97,136-146`) | **absent** | **Gap → S1** |
| `security-scan` npm audit | client + server `|| true` (`ci.yml:128-134`) | `npm_audit`, SOFT (`local-test.sh:191`) | **Faithful** |
| `docker-build` | build client/server/kiwi images (`ci.yml:99-112`) | not in local-test.sh | **By design** — reproduced by `local-build.sh` in the test→build order (`TESTS.md:49`); a Dockerfile break passes local-test and is caught at the next stage |
| — (no CI equivalent) | — | `db_suite` + `kiwi_suite` added (`local-test.sh:184-185`) | **Strengthening** — CI runs neither pytest suite |

Hard-vs-soft mapping is correct: everything CI runs as a hard step is HARD here;
every `|| true` step is SOFT here (except the missing pip-audit, S1). The
`db_suite` exclusion of `test_discriminator_coverage.py` is a **correct scoping**,
not a silent skip: that test scans the gitignored, generated
`tools/ingest/output/*.json` (`db/tests/test_discriminator_coverage.py:9-19`) and
belongs to the ingest phase; the omission is documented in the header
(`local-test.sh:129-135`), inline, and `TESTS.md:26`. Node image choice (N1) and
the whole-repo mount are acceptable/necessary — see below.

**Whole-repo mount correctness (confirmed):** mounting `${REPO_ROOT}` at `/repo`
and running from `/repo/server` reproduces CI's checkout depth so
`pg.ts:13` (`path.resolve(__dirname, '../../../db/migrations')`) resolves to
`/repo/db/migrations` — a shallow `server/`-only mount would resolve to
`/db/migrations` (ENOENT). Likewise `services/kiwi/tests/test_lemmatizer.py:217`
uses `Path(__file__).resolve().parents[4]`; at `/repo/services/kiwi/tests/...`,
`parents[4]` is `/` (valid, no IndexError), whereas a shallow `services/kiwi` mount
has only 3 parents → IndexError at collection. The header's justification
(`local-test.sh:100-106`, `140-144`) is accurate. The anonymous `node_modules`
volume correctly keeps installs off the host (the hermeticity caveat is only about
*artifact writes* — S2, not `node_modules`).

---

## Robustness assessment

- **HARD_FAIL accounting is correct (PRAISE).** `hard()` invokes the suite as
  `if "$@"; then … else record HARD … FAIL` (`local-test.sh:59-69`), so under
  `set -Eeuo pipefail` + the ERR trap a failing suite does **not** abort the run
  (commands in an `if` condition are exempt from errexit), all suites run, and
  `record` sets `HARD_FAIL=1` only on a HARD FAIL (`local-test.sh:49-55`). `main`
  then `return 1`s iff `HARD_FAIL -ne 0` (`local-test.sh:204-208`). The run truly
  fails on any hard suite and still collects every failure for the summary. Solid.
- **Fail-fast where it should:** `require_cmd docker` (`local-test.sh:176`,
  `local-build.sh:37`, `local-standup.sh` via helpers) is outside any `if`, so a
  missing docker aborts immediately via the ERR trap.
- **Idempotency:** all three scripts are safely re-runnable. `local-build.sh`
  rebuilds images; `local-standup.sh` re-seeds `nginx.conf` only when absent
  (`local-standup.sh:77-81`), `ensure-shared-volume.sh` is inspect-or-create,
  `run_migrate up` no-ops on applied migrations, and `update_nginx_config` is
  idempotent (`deployment-utils.sh:355`). Good.
- **Image-presence preflight** in `local-standup.sh:47-55` fails fast with a
  `local-build.sh <tag>` remedy before any bring-up — correct.
- **Ordering in `local-standup.sh` is correct (PRAISE):** seed live `nginx.conf`
  from the active template *before* the LB starts (`72-81`) → `compose_shared up`
  (`85`) → `wait_healthy km-db` (`86`) → migrate dry-run then apply, aborting on
  either (`91-100`) → `compose_color <active> up` (`105`) → wait the trio healthy
  (`106-108`) → `update_nginx_config` (`112`) → `verify_local_app :1840`
  (`114-117`). This matches the README first-time sequence (`README.md:229-252`),
  with the improvement that the LB config is seeded before the LB boots (avoiding
  the directory-auto-create bind-mount trap the compose file warns about,
  `docker-compose.shared.yml:53-61`). The **only** first-boot gap vs the README is
  B1 (`services_default`) — the README's step 7 starts cloudflared *after* bring-up,
  but the compose file needs `services_default` to exist *before* `compose_shared up`.
- **No secret exposure** anywhere (see N2).

---

## Coordination observations

- **`local-build.sh` builds 5 images** (adds `km-migrate`, `km-loader`) vs CI's
  `docker-build` 3 (`local-build.sh:44-57` vs `ci.yml:105-112`) — a correct superset:
  `run_migrate`/`run_loader` resolve those two by name:tag
  (`deployment-utils.sh:465`, `532`) and standup preflights all five
  (`local-standup.sh:48`).
- **Image-build validation lives only in `local-build.sh`**, not the test gate, so
  the documented pipeline order test→build (`TESTS.md:15-16`) is load-bearing: a
  Dockerfile break passes `local-test.sh` and is caught one stage later. This is
  the intended split and is documented, but worth stating that "green test gate"
  ≠ "images build."
- **`TESTS.md` and the `local-test.sh` header disagree on pip-audit.** `TESTS.md:37`
  lists only npm audit as the dependency-audit soft gate (honest about the impl);
  `local-test.sh:27` claims pip-audit too (S1). Fix S1 in whichever direction and
  make the two agree.
- **`--fast` semantics** (skip db+kiwi) are consistently documented across the
  header (`local-test.sh:33-35`), `main` (`183-188`), and `TESTS.md:12`. Good.

---

## PRAISE

1. HARD/SOFT accounting is correct and collects all failures before exiting — the
   central robustness requirement, done right (`local-test.sh:49-69,204-208`).
2. No secret exposure: test/build never load the `.env`; standup's
   `load_environment` and `run_migrate` never echo secrets.
3. Correct, well-documented scoping of `test_discriminator_coverage.py` — a real
   post-ingest data test, not a silent skip.
4. `local-standup.sh` bring-up ordering is textbook and improves on the README by
   seeding the LB config before the LB boots.
5. Whole-repo mount at checkout depth is the *correct* way to reproduce CI path
   resolution (verified against `pg.ts` and the kiwi tests) — and it is justified
   inline rather than left as a mystery.
6. Consistent house style throughout: source `deployment-utils.sh`, reuse the
   structured loggers / `require_cmd` / `REPO_ROOT`, `set -Eeuo pipefail` + ERR
   trap, and every fatal path prints an actionable remedy.
7. The local gate adds db + kiwi coverage CI omits — a genuine strengthening over
   the CI contract, not a shortcut.
