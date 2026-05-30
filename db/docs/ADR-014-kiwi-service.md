# ADR-014 — Kiwi Morphological Analyzer as a Separate Service

- **Status:** Accepted
- **Date:** 2026-05-27
- **Component:** B1 (Kiwi service) — see `DESIGN_SPEC.md` §The engine
- **Author:** B1 owner

## Context

The Korean Master engine needs Korean morphological analysis: given a Korean
sentence (or token), return lemmatized morphemes with POS tags so the client
can highlight the tapped word and the gateway (B3) can hand the lemma to
KRDICT for definition lookup.

Kiwi is the de facto open-source Korean morphological analyzer, with a Python
binding (`kiwipiepy`) that is well-maintained and reasonably fast. The
decisions in this ADR are:

1. **Web framework** — FastAPI vs Flask vs a non-HTTP transport.
2. **Model size** — Kiwi ships `small` / `base` / `large` variants.
3. **Deployment shape** — a separate Docker service vs an embedded
   Python module called from B3's Express server.

Each of these had a reasonable alternative; this ADR exists so the choice is
deliberate and reversible.

---

## D1 — Web framework: FastAPI

### Decision

Use **FastAPI** (uvicorn ASGI worker) for the HTTP surface.

### Alternatives considered

| Option | Pros | Cons |
|---|---|---|
| **FastAPI** (chosen) | Pydantic-native (we use Pydantic everywhere already); async endpoints with `run_in_threadpool` for the CPU-bound analyzer; OpenAPI generated for free (B3 dev benefits); good ecosystem for testing | One more dep than Flask; async surface to manage |
| Flask + flask-pydantic | Minimal; familiar | Manual schema validation; no built-in OpenAPI; synchronous WSGI — `gunicorn` worker count vs FastAPI's threadpool is roughly equivalent here but Flask is the more dated stack |
| Starlette directly | Lighter than FastAPI | Loses the Pydantic-integrated request/response binding — we'd hand-roll it |
| gRPC | Lower per-call overhead | The gateway is Node/Express; gRPC clients in Node add complexity that doesn't pay off at this scale (single user, single host) |
| Unix socket + line-protocol | Lowest overhead | Custom protocol; loses inspectability (no `curl` debugging); no benefit at our QPS |

### Rationale

FastAPI is what the rest of the Python in this project would use too (the
ingest tools and migration runner already lean on Pydantic for schemas). The
async surface lets us add structured request logging cleanly without
sacrificing throughput (`run_in_threadpool` offloads the actual analysis).
OpenAPI is a real bonus for B3's developer experience.

The single material downside — being slightly heavier than Flask — doesn't
matter for a service that loads a ~100MB model and lives forever.

### Consequences

- We add `fastapi`, `uvicorn`, `pydantic-settings` as runtime deps.
- The container exposes `/docs` (Swagger UI). This is on the internal network
  only and is convenient for the gateway dev.

### Reversibility

High. The wrapper (`lemmatizer.py`) is framework-agnostic. Swapping FastAPI
for Flask is a ~1-day rewrite of `app.py`; everything else stays the same.

---

## D2 — Kiwi model size: `base`

### Decision

Default to the **`base`** model. Configurable via `KIWI_MODEL_SIZE`.

### Alternatives considered

| Model | Approx size | Quality | Load time | Per-request time |
|---|---|---|---|---|
| `small` | ~30 MB | Good on common patterns; weaker on irregulars | ~200ms | ~3ms |
| **`base`** (chosen) | ~100 MB | Strong across the board; reliable on the seven irregular-conjugation classes | ~500–800ms | ~5–10ms |
| `large` | ~400 MB | Marginally better on rare patterns / OOV proper nouns | ~3–5s | ~15–25ms |

### Rationale

The product depends on Kiwi getting the seven Korean irregular conjugation
classes (ㄷ, ㅂ, 르, ㅎ, ㅅ, ㅡ, ㄹ) right. `small` is noticeably weaker
there; `large` adds noticeable load time and image bulk (~400MB additional in
the runtime image) for marginal improvement on Iyagi/TTMIK-style content,
which is our actual workload. `base` is the right default; ops can swap to
`large` via env var if a content set demands it.

### Consequences

- Runtime image footprint includes the `base` model files (shipped with the
  wheel).
- Cold start is sub-second.

### Reversibility

Trivially reversible: `KIWI_MODEL_SIZE=large` and restart.

---

## D3 — Deployment shape: separate Docker service (not embedded in B3)

### Decision

Run Kiwi as a **separate containerized service** on the internal compose
network, reached by B3 over HTTP at `http://kiwi:8000`.

### Alternatives considered

#### Alternative A — Python child process of B3

Express server spawns a Python child running Kiwi; communicates via stdio
or a Unix socket.

| | Pros | Cons |
|---|---|---|
| | One fewer container | Cross-runtime mess (Node managing Python lifecycle); model reload on B3 restart; harder to scale Kiwi independently |

#### Alternative B — In-process Node binding

Use a JS-native Korean analyzer (e.g. node-mecab-ko, hannanum.js).

| | Pros | Cons |
|---|---|---|
| | Single runtime | Quality of node-side Korean analyzers is materially below Kiwi; we'd lose on the irregulars, which is the whole point |

#### Alternative C — Separate Docker service (chosen)

| | Pros | Cons |
|---|---|---|
| | Single responsibility; B3 restarts don't drop the loaded model; scales independently; the right boundary for the security `internal: true` network restriction | One more container to operate |

### Rationale

The "one more container" cost is small (we already have `db`, `server`,
`client`) and pays off immediately:

1. **Separation of concerns.** B3 is a Node/TypeScript gateway. Embedding a
   Python interpreter + Kiwi model inside it conflates runtimes and complicates
   B3's image. The Korean Master quality bar (`SENIOR_ENGINEER_BAR.md §2 Structure`)
   is explicit about single-responsibility modules.

2. **Independent restart cycles.** Kiwi takes ~1s to load its model. If it
   were embedded in B3, every B3 deploy would incur that cost (and worse, B3
   deploys are frequent — Express endpoint changes shouldn't drop the
   analyzer cache).

3. **Security boundary.** The `internal: true` compose network blocks egress.
   The Kiwi service has no DB credentials and no Anthropic API key. A
   hypothetical RCE in Kiwi cannot reach the Anthropic API or the database.
   That isolation is much harder to achieve if Kiwi were a Python child
   process of B3.

4. **Right shape for the future.** When (if) we need to scale Kiwi to multiple
   replicas behind a load balancer, the boundary is already a service. We
   don't pay any migration cost.

### Consequences

- B3 makes one extra HTTP hop on every tap-a-word. At ~5ms on localhost,
  this is well below the user-perceptible threshold.
- The compose stack grows from 3 to 4 services. Documented in `docker-compose.yml`.

### Reversibility

Medium. Tearing the service down and embedding Kiwi into a Python sidecar
process within B3 is a multi-day rewrite. The current shape doesn't preclude
that — but it's not free to undo.

---

## D4 — Internal-only network exposure

### Decision

Kiwi has **no host port mapping**. It is reachable only from other containers
on the `internal` compose network (specifically B3).

### Rationale

Kiwi has no auth and no rate limiting (see SECURITY.md §T2). Exposing it on
a host port would let anyone on the box bypass B3's auth and rate limits.
The cost of internal-only is "you can't `curl` it from your laptop" — which
is fine, because B3 is the supported integration point. For local dev, the
developer can temporarily add a port mapping in a `docker-compose.override.yml`
(gitignored).

### Reversibility

Trivial: add `ports: ["127.0.0.1:8000:8000"]` to the kiwi service stanza.

---

## Open questions

- **Multiple replicas.** Not needed for single-user Korean Master. If we add
  multi-user, we'll put Kiwi behind a simple round-robin (compose's default
  service-name DNS already round-robins).
- **Custom dictionary.** Kiwi supports user dictionaries for OOV terms. If
  TOPIK/Iyagi content shows systematic mis-tokenization, we'll add a
  `user_dict.txt` mount and load it in `Lemmatizer.__init__`. Tracked as a
  follow-up.
- **Persistent cache.** Per-(text → tokens) caching belongs in B3 (it knows
  the user, the request context, and has Postgres). This service stays pure
  and stateless.
