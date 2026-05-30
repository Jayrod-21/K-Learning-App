# Kiwi Service — Security Threat Model

> Component B1 in the Korean Master engine. Stateless Korean morphological
> analyzer behind a small REST API. Internal-only (no public ingress);
> reached only from the Express gateway (B3) on the compose `internal`
> network.
>
> This file enumerates the attack vectors that apply to a service of this
> shape and the defense for each. Format follows the project standard
> (`SENIOR_ENGINEER_BAR.md §2 Security`).

---

## Trust boundaries

```
[ browser ]                       [ host network ]
     |
     v
[ Cloudflare Tunnel ]  -- only reaches -->  [ server (B3 / Express) ]
                                                       |
                                                       |  (internal docker net)
                                                       v
                                                  [ kiwi (B1, this service) ]
                                                       |
                                                       v
                                                  [ db (Postgres) ]   <-- kiwi does NOT touch
```

**Inputs to this service** come only from B3 (Express). B3 is responsible for
user auth, rate limiting, and request hygiene. We treat B3 as semi-trusted —
it's our gatekeeper, but if it's compromised the attacker can hit us
directly. So we keep our own defenses for the things we control.

**This service has no:**
- database connection,
- outbound network egress (the `internal` compose network blocks it),
- persistent state,
- file writes (read-only file system possible — see §hardening),
- secrets to leak (no API keys, no auth tokens received or held).

That eliminates a huge class of attacks. What remains is denial-of-service
and resource exhaustion.

---

## Threats and defenses

### T1 — DoS via oversized input

**Vector:** Attacker (or buggy upstream) sends a multi-megabyte payload.
Kiwi is O(n) in input length but allocations and tagging passes are not free;
a few thousand concurrent 10MB requests will OOM the container.

**Defense:**
- Pydantic `LemmatizeRequest` validates `text` is non-empty and (as a fallback)
  ≤ 4096 chars.
- The endpoint itself enforces `Settings.max_input_chars` (env-configurable,
  default 4096) BEFORE calling Kiwi — see `app.py::_enforce_input_limit`.
  Returns `413 input_too_long`.
- Docker memory limit set in `docker-compose.yml` (`KIWI_MEM_LIMIT`, default
  512MB). Cgroup OOM kills the container before it takes the host with it;
  compose restart policy brings it back.

**Tested:** `tests/test_api.py::TestLemmatize::test_oversize_413`.

---

### T2 — DoS via high request rate

**Vector:** Even with small payloads, hammering `/lemmatize` at thousands of
QPS exhausts the CPU. The Kiwi C++ analyzer is fast (~5ms) but uvicorn's
threadpool size is finite.

**Defense (layered):**
- **Primary defense lives at the gateway (B3).** B3 is the public ingress and
  is the right place for per-user / per-IP rate limiting (e.g. `express-rate-limit`
  with separate buckets for cheap vs expensive endpoints — see
  `SENIOR_ENGINEER_BAR.md §2 Security`). This service has no concept of
  identity and so cannot rate-limit fairly.
- **Backstop defense in this service:** uvicorn is launched with a single
  worker (CPU-bound; multiple workers wouldn't help) and a bounded threadpool.
  Docker CPU limit caps consumption at the container level.

**Not implemented here, by design.** This is documented as a B3
responsibility — see `db/docs/ADR-014-kiwi-service.md` §rate-limiting.

---

### T3 — DoS via pathological string

**Vector:** Some morphological analyzers blow up on adversarial sequences
(deep alternation, exotic Unicode classes). Kiwi specifically is bounded
linear, but the JSON parser, UTF-16 offset table, and Pydantic validation
each touch the string.

**Defense:**
- Same length cap as T1 keeps the worst case bounded.
- The UTF-16 offset table walk is O(n) and allocation-light (single list
  preallocated to len+1).
- Pathological-token offsets reported by the analyzer are clamped, not
  trusted blindly — see `lemmatizer.py::Lemmatizer.lemmatize` and the
  `test_pathological_token_offset_clamped` test.

**Tested:** unit test exercising an out-of-range token offset.

---

### T4 — Prompt-injection-like attacks

**Vector:** This service does not call an LLM. There is no prompt to inject.
Kiwi is a deterministic statistical analyzer.

**Defense:** N/A — by design.

**Note for B3/B4:** when Express forwards the tapped word's surface form to
Claude, it MUST treat the user-provided text as data, not instructions. That's
B4's threat model, not ours.

---

### T5 — Information disclosure via error responses

**Vector:** A 500 reveals internal stack traces, file paths, or library
versions an attacker can use to find vulnerable dependencies.

**Defense:**
- Exception handlers return only `{error, detail}` with a curated message.
  No `repr(exc)`, no traceback.
- `/version` deliberately exposes `kiwi_version` — but this is on the
  internal network only, and that version is also derivable from the Python
  package metadata that we publish in our internal SBOM anyway. The benefit
  (B3 can short-circuit incompatible deployments) outweighs the cost.
- Structured logs DO include the internal error message, but they go to
  stdout for the host log driver, not to the client.

---

### T6 — Code execution via dependency vulnerability

**Vector:** A future CVE in kiwipiepy, FastAPI, or pydantic ships into the
image.

**Defense:**
- Deps pinned to `MAJOR.MINOR` ranges in `pyproject.toml`; a lockfile (added
  by CI) pins exact versions.
- Multi-stage Docker build excludes build toolchain from the final image,
  shrinking attack surface.
- Container runs as non-root (`uid=1000 kiwi`).
- `no-new-privileges` security_opt set in docker-compose.
- Quarterly dependency audit cadence: `pip-audit` against the lockfile in CI.

---

### T7 — Container escape / lateral movement

**Vector:** RCE in the service is leveraged to attack the DB or steal the
Anthropic API key from the `server` container.

**Defense:**
- The `kiwi` service is on the `internal` compose network only. `internal: true`
  on that network blocks egress. So even with RCE, the attacker can't reach the
  Anthropic API or any external host.
- The `db` container is on the same `internal` network, but accepts
  connections only from authenticated clients with credentials. The Kiwi
  service has no DB credentials — see app code, there's no `DATABASE_URL`.
- Filesystem: the venv and source are owned by `root` and read-only to the
  `kiwi` user. The only writable mount would be a tmpfs if added; no
  persistent volumes are mounted.

---

### T8 — Supply chain (malicious kiwipiepy)

**Vector:** A typosquatted or hijacked `kiwipiepy` package compromises the
image at build time.

**Defense:**
- We pin a known-good `>=0.20,<0.21` and require a lockfile with hashes in
  CI (`pip install --require-hashes`).
- The Docker base image is `python:3.12-slim-bookworm`, a well-maintained
  Debian-derived official image.

**Open item:** SBOM generation in CI (e.g. `syft`) is a follow-up — tracked
in the dev-cycle backlog, not blocking the first deploy.

---

## Defenses we deliberately did NOT add

| Defense | Why not |
|---|---|
| Auth on the Kiwi endpoints | We're on an internal-only docker network. Auth on every internal RPC is theater that adds latency without adding security. The right layer for auth is B3. |
| Rate limiting in this service | See T2 — belongs at the gateway. |
| Input sanitization beyond length | Kiwi accepts arbitrary Unicode; "sanitizing" Korean text is the opposite of the service's job. |
| TLS termination | The `internal` compose network is not routed to the public internet. Cloudflare Tunnel terminates TLS at B3. |
| Audit logging of requests | Request text is not sensitive (it's TOPIK/Iyagi content, etc.). Standard structured request logging is enough. |

---

## Hardening checklist (compose-level)

These are enforced in `docker-compose.yml`:

- [x] Non-root user inside container (`uid=1000`)
- [x] `no-new-privileges: true`
- [x] `internal: true` network — no egress
- [x] Memory + CPU limits
- [x] Read-only filesystem (`read_only: true`) — kiwipiepy doesn't need to write
- [x] `tmpfs` for `/tmp` if any temporary writes are needed
- [x] HEALTHCHECK so unhealthy containers are restarted
- [x] Log driver caps (size + file count) — runaway logs can't fill the disk

---

## Incident playbook (abbreviated)

| Signal | Action |
|---|---|
| `/health` returns 503 sustained > 60s | Model failed to load. Check container logs. Likely cause: corrupt kiwipiepy install — `docker compose build --no-cache kiwi`. |
| 5xx rate spike on `/lemmatize` | Check structured logs for `kiwi.analyze_failed` events. Likely cause: malformed UTF-8 from B3. Roll back B3 if recent deploy. |
| Memory limit hit (cgroup OOM) | Either T1 (oversize input — check 413 rate before the OOM) or T6 (memory leak in a new kiwipiepy). Pin to the previous tag and file an issue. |
| New CVE in kiwipiepy or FastAPI | Bump pin, regenerate lockfile, redeploy. Service has no state so rolling restart is zero-downtime per-replica. |
