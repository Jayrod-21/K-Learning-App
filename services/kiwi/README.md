# Kiwi Morphological Analyzer Service

Korean morphological analyzer behind a small REST API. Wraps
[`kiwipiepy`](https://github.com/bab2min/kiwipiepy) — the Python binding to
[Kiwi](https://github.com/bab2min/Kiwi) — in a FastAPI app. Stateless,
internal-only, single responsibility: take Korean text, return lemmatized
tokens with POS tags and character offsets.

This service is component **B1** in the engine described in `DESIGN_SPEC.md`.
The tap-a-word flow is: **Kiwi (this service) → KRDICT lookup → Claude enrich
→ bank to vocab cards**. We are the first step.

---

## What this service is, and isn't

| Is | Isn't |
|---|---|
| Lemmatize + segment Korean text | A dictionary (that's KRDICT, B2) |
| Return POS tags + character offsets | An enrichment / explanation layer (that's Claude via B3/B4) |
| Stateless — no DB, no cache | A persistence layer |
| Internal-only — Express (B3) is the public gateway | A public API |

---

## API

All endpoints return JSON. Errors follow `{error, detail}`.

### `POST /lemmatize`

Full lemmatization with character offsets. Use this for the reader UI where
you need to highlight the tapped word.

**Request:**
```json
{ "text": "어제 친구를 만났어요" }
```

**Response (200):**
```json
{
  "tokens": [
    {"surface": "어제", "lemma": "어제", "pos": "MAG", "start": 0, "end": 2},
    {"surface": "친구", "lemma": "친구", "pos": "NNG", "start": 3, "end": 5},
    {"surface": "를",   "lemma": "를",   "pos": "JKO", "start": 5, "end": 6},
    {"surface": "만나", "lemma": "만나다", "pos": "VV", "start": 7, "end": 9},
    {"surface": "었",   "lemma": "었",   "pos": "EP", "start": 8, "end": 9},
    {"surface": "어요", "lemma": "어요", "pos": "EF", "start": 9, "end": 11}
  ]
}
```

**Offset semantics:** UTF-16 code-unit offsets — the same indexing JavaScript
uses for `String.prototype.substring`. For Korean text in the BMP (which is
all of 가-힣) this matches Python code-point indices 1:1; the difference
matters only for non-BMP characters (emoji etc.).

**Errors:**
- `413 input_too_long` — input exceeds `KIWI_MAX_INPUT_CHARS`
- `422` — malformed JSON / extra fields / missing `text` / empty `text`
- `500 lemmatization_failed` — Kiwi raised internally

### `POST /tokens`

Same input, lighter output — no offsets. Use when you only need lemmas (e.g.
batch SRS card creation).

```json
{
  "tokens": [
    {"surface": "어제", "lemma": "어제", "pos": "MAG"},
    {"surface": "친구", "lemma": "친구", "pos": "NNG"}
  ]
}
```

### `GET /health`

```json
{ "status": "ok", "model_loaded": true, "model_size": "base" }
```

- `status: "ok"` iff the Kiwi model is loaded.
- During the ~10–30s startup window the response is `{"status": "starting",
  "model_loaded": false, ...}`. Docker's HEALTHCHECK gives this 60s before
  marking unhealthy.

### `GET /version`

```json
{
  "service": "kiwi-service",
  "service_version": "0.1.0",
  "kiwi_version": "0.20.x",
  "model_size": "base"
}
```

### `GET /docs`

OpenAPI (Swagger UI). Useful for the gateway dev. Safe to expose — the service
is on the internal compose network only.

---

## POS tags

Kiwi uses the [Sejong-style POS tagset](https://github.com/bab2min/Kiwi/blob/main/docs/Kiwi_POS_tags.md).
The most common ones you'll see:

| Tag | Meaning | Example |
|-----|---------|---------|
| NNG | common noun | 친구 |
| NNP | proper noun | 한국 |
| VV  | verb stem | 먹 (→ lemma 먹다) |
| VA  | adjective stem | 예쁘 (→ lemma 예쁘다) |
| VX  | auxiliary verb | 보 (in 먹어 보다) |
| VCP | copula 이다 | |
| VCN | negative copula 아니다 | |
| MAG | general adverb | 어제 |
| MAJ | conjunctive adverb | 그러나 |
| JKS | subject particle | 이/가 |
| JKO | object particle | 을/를 |
| JKB | adverbial particle | 에, 에서 |
| JX  | auxiliary particle | 은/는, 도 |
| EP  | pre-final ending | 었, 겠 |
| EF  | final ending | 어요, ㅂ니다 |
| ETM | adnominal ending | ㄴ, 는, 을 |
| ETN | nominal ending | 기, 음 |
| EC  | connective ending | 고, 서, 면 |
| XSN | noun-deriving suffix | 들 (plural) |
| XSV | verb-deriving suffix | 하 (in 공부하다) |
| XSA | adjective-deriving suffix | |

Verb/adjective lemmas (POS in `{VV, VA, VX, VCP, VCN}`) end in `다`. All other
lemmas are the surface form of the morpheme.

---

## How to run

### Locally (without Docker)

```bash
cd services/kiwi
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn kiwi_service.app:app --reload --port 8000
```

First request after startup takes ~200–500ms (model warm-up); subsequent
requests are < 50ms on a modern CPU for typical sentence-length input.

### Docker

```bash
docker build -t korean-master/kiwi services/kiwi
docker run --rm -p 8000:8000 korean-master/kiwi
curl -s http://127.0.0.1:8000/health
```

### Inside the compose stack

The service is added as `kiwi` to `Repository/docker-compose.yml`. It has no
host port mapping — only the `server` container (B3) on the same `internal`
network can reach it at `http://kiwi:8000`.

```bash
cd Repository
docker compose up kiwi
```

---

## How to test

Two layers:

```bash
# Fast — uses the fake Kiwi engine. No model download. < 2s.
pytest tests/ --no-slow

# Full — runs the `slow`-marked tests against the real Kiwi model.
# Requires `kiwipiepy` installed and its model files (the wheel ships them).
pytest tests/

# Strict integration gate — fail if real Kiwi isn't available.
pytest tests/ --require-kiwi
```

The fast layer covers the API contract, error paths, UTF-16 offset
translation, lemma derivation, and every Korean irregular-conjugation class
(ㄷ, ㅂ, 르, ㅎ, ㅅ, ㅡ, ㄹ) using canned tokenizations. The slow layer
re-runs the irregular-conjugation assertions against real Kiwi and smoke-tests
the first 10 Iyagi sentences from `tools/ingest/output/iyagi_1_50.json` for
structural invariants (every verbal lemma ends in `다`, offsets land on
character boundaries, etc.).

Specific tokenization counts are intentionally not asserted against real Kiwi
— minor segmentation choices vary by Kiwi version and that's not what we're
guarding.

---

## Configuration

All knobs are env vars (12-factor). See `.env.example` for the full list.
Pydantic `BaseSettings` validates types and provides defaults; bad values
fail at boot, not at first request.

| Var | Default | Meaning |
|---|---|---|
| `KIWI_HOST` | `0.0.0.0` | Bind address |
| `KIWI_PORT` | `8000` | Bind port |
| `KIWI_MODEL_SIZE` | `base` | Kiwi model: `small` / `base` / `large` |
| `KIWI_MAX_INPUT_CHARS` | `4096` | Reject requests larger than this (DoS defense) |
| `KIWI_REQUEST_TIMEOUT_SECONDS` | `5.0` | Wall-clock budget per request |
| `KIWI_LOG_LEVEL` | `INFO` | `DEBUG` / `INFO` / `WARNING` / `ERROR` / `CRITICAL` |
| `KIWI_SERVICE_NAME` | `kiwi-service` | Identifier in logs |

---

## Observability

Structured JSON logs via `structlog`. Every request:
- gets a `request_id` (honored from `x-request-id` header or minted),
- propagates it through every log line in that request,
- echoes it back on the response so B3 can correlate.

Sample log line:
```json
{"event":"http.request","method":"POST","status_code":200,"duration_ms":12.3,"path":"/lemmatize","request_id":"…","level":"info","timestamp":"…"}
```

No PII enters this service (we receive text fragments only; no user identity),
so log scrubbing is not configured.

---

## Performance

Targets and measured behavior on a 2020-era 4-core x86 CPU, Python 3.12,
`base` model:

| Metric | Target | Typical |
|---|---|---|
| Model load (cold) | < 5s | ~1s |
| `/lemmatize` p50, single sentence (~30 chars) | < 25ms | ~5–10ms |
| `/lemmatize` p95, single sentence | < 50ms | ~15ms |
| Memory resident (process) | < 500MB | ~250–350MB |

The model is loaded once at startup and held in memory for the process
lifetime. The endpoint is `async def` but offloads the actual `analyze()` call
to a threadpool (`run_in_threadpool`) so a slow request doesn't block the
event loop.

---

## Gotchas

- **First request after startup is slow** (~200–500ms). The Kiwi analyzer
  warms its caches lazily; subsequent requests are fast. If you SLO on cold
  starts, pre-warm by hitting `/lemmatize` once during the readiness probe.
- **Offsets are UTF-16, not Python code-points or bytes.** This matches what
  the React client will index with. The conversion happens in
  `lemmatizer.py::_build_utf16_offset_table`.
- **Lemma derivation appends `다`** to verbal POS stems. Some kiwipiepy
  versions already include the `다`; we check for it before appending so
  there's no `먹다다`.
- **`KIWI_MAX_INPUT_CHARS` defaults to 4096.** Pathological strings (e.g.
  10MB of `먹` repeated) will be rejected with 413 before the analyzer ever
  sees them. Chunk by sentence on the client.
- **No rate limiting in this service.** Rate limiting is the gateway's (B3)
  responsibility — see `SECURITY.md` for the threat model.

---

## See also

- `SECURITY.md` — threat model + defenses
- `../../db/docs/ADR-014-kiwi-service.md` — design decisions
- `DESIGN_SPEC.md` (project root) — engine overview, tap-a-word flow
- `SENIOR_ENGINEER_BAR.md` (project root) — quality bar this service is built to
