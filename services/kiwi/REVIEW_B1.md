# Review: B1 — Kiwi morphology service

**Reviewer:** Independent senior reviewer (30y)
**Date:** 2026-05-28
**Scope:** `Repository/services/kiwi/` + `ADR-014` + `docker-compose.yml` (kiwi stanza)
**Verdict source bar:** `SENIOR_ENGINEER_BAR.md`

---

## Summary verdict

**Conditional approve — 3 SHOULD-FIX, no BLOCKERs.**

B1 is mature work. The architecture story is genuinely thought through (ADR-014
considers five alternatives for D1 alone, with honest pros/cons), the SECURITY.md
follows the project's "enumerate attack vectors, don't write generic boilerplate"
rule, the test split between fake and real Kiwi is the right shape, and the
UTF-16 offset translation — easy to bungle — is correct and tested across
ASCII / BMP / emoji / empty inputs.

The defects that exist are bounded and mechanical, not architectural. The most
material one is a Pydantic-vs-Settings DoS limit disagreement that could reject
legitimately-sized inputs when ops tunes `KIWI_MAX_INPUT_CHARS` above 4096
(F-2 below). The remaining SHOULD-FIXes are a Pydantic v2 `model_` namespace
collision (F-1) and the read-only filesystem possibly conflicting with
kiwipiepy's cache directory (F-3).

I would request these three changes before merge. I would not block the deploy
once they are addressed.

---

## Bar checklist (§5 table)

| Check | Status | Notes |
|---|---|---|
| Lint passes (no warnings) | ⚠ Likely passes ruff but Pydantic emits runtime `UserWarning` for `model_*` field names | F-1 |
| Type-check passes (mypy strict) | ⚠ `strict=true` set; `info: object` in `_end_after_start` and `# type: ignore[call-arg]` sprinkled in tests are mild bypasses | F-7 |
| All tests pass | ✓ Test suite structurally complete; fast layer < 2s claim plausible |  |
| Every public function tested | ✓ Endpoint × happy/422/413/extra-field + offsets + irregulars × 7 | Praise |
| `EXPLAIN ANALYZE` | n/a — no DB | — |
| `SECURITY.md` with enumerated vectors | ✓ T1–T8 + "defenses we did NOT add" table | Praise |
| `README.md` with how-to-test | ✓ Three test modes documented; perf targets stated | Praise |
| ADR for each non-obvious decision | ✓ D1–D4 with alternatives explicitly rejected | Praise |
| Migrations reversible | n/a — no schema | — |
| No `TODO`/`FIXME` without ticket | ✓ None found |  |
| No `print()` / `console.log` | ✓ structlog throughout |  |
| No commented-out code | ✓ |  |
| No hardcoded secrets/URLs | ✓ All via BaseSettings; `KIWI_URL=http://kiwi:8000` is service-name DNS, not a hardcode |  |

---

## Findings

### BLOCKER

*(none)*

### SHOULD-FIX

- **F-1** Pydantic v2 protected-namespace collision on `model_*` fields
  (`models.py:97`, `:98`, `:107`, `config.py:45`).
- **F-2** Pydantic-level input cap (`_DEFAULT_MAX_INPUT_CHARS=4096`) silently
  overrides any larger `KIWI_MAX_INPUT_CHARS` from env (`models.py:17,37–41`).
- **F-3** Read-only filesystem + `--no-create-home` may break kiwipiepy if it
  tries to write a cache directory (`Dockerfile:67,76`, `docker-compose.yml:143–145`).

### NIT

- **F-4** Dead/misleading helper `surface_from_tag_stem` (`lemmatizer.py:178,209–216`).
- **F-5** `_end_after_start` validator is a no-op despite its name (`models.py:64–67`).
- **F-6** Bare `except Exception` in `_kiwi_version_string` (`app.py:299`) — the
  function only does `import kiwipiepy` and `getattr`; narrow to `ImportError`.
- **F-7** `info: object` in `field_validator` signature (`models.py:66`) — should
  be `pydantic.ValidationInfo`.
- **F-8** Tests import private `_FakeKiwi` / `_FakeToken` from conftest
  (`test_lemmatizer.py:147`). Anti-pattern — move helpers to a `tests/_helpers.py`.
- **F-9** `real_lemmatizer` fixture is function-scoped (`conftest.py:218–223`);
  parametrized real-Kiwi tests reload the model per case.
- **F-10** `빨간 사과` fake canned offsets overlap (`conftest.py:142–146`):
  VA `(start=0,len=2)` and ETM `(start=1,len=1)` produce overlapping spans
  that don't correspond to real character positions.
- **F-11** `Settings(extra="ignore")` (`config.py:36`) lets unknown `KIWI_*`
  env vars pass silently; the rest of the project favors `extra="forbid"`.
- **F-12** HEALTHCHECK regex `grep -q '"model_loaded": *true'` (`Dockerfile:84`)
  is brittle to JSON whitespace and to any future field rename.

### PRAISE

- **P-1** ADR-014 is the right shape for this project: alternatives table per
  decision, reversibility scored, consequences enumerated. A reviewer can
  argue with it without re-deriving the choice space.
- **P-2** SECURITY.md trust-boundary diagram + the "Defenses we deliberately
  did NOT add" table — this is exactly the senior style the bar asks for.
  "Auth on Kiwi endpoints is theater on an internal network" is a refreshing
  honest take.
- **P-3** UTF-16 offset table — correct, allocation-light, and tested across
  ASCII / BMP / emoji / empty.
- **P-4** `Lemmatizer.__init__(_engine=...)` test seam — the right place to
  mock and exactly what the bar calls for re. dependency injection.
- **P-5** `TestClient` constructed without context manager to skip lifespan
  (`conftest.py:234–245`) — clever, correctly documented.
- **P-6** Single-worker uvicorn rationale stated (CPU-bound, model held in
  memory) and scale-up path noted. This is the right call.

---

## Detailed findings

### F-1 — Pydantic v2 `model_` namespace collision (SHOULD-FIX)

**Files:** `src/kiwi_service/models.py:97,98,107`; `src/kiwi_service/config.py:45`

```python
# models.py
class HealthResponse(BaseModel):
    model_loaded: bool          # ← collides
    model_size: str             # ← collides

class VersionResponse(BaseModel):
    model_size: str             # ← collides

# config.py
class Settings(BaseSettings):
    model_size: KiwiModelSize   # ← collides
```

Pydantic v2 reserves the `model_` prefix for its own attribute namespace
(`model_validate`, `model_dump`, `model_config`, etc.). Any user field
starting with `model_` triggers a `UserWarning: Field "model_*" has conflict
with protected namespace "model_"`. The warnings are noisy in logs, undermine
the "lint clean" bar check, and risk a future Pydantic minor bump promoting
the warning to an error.

**Fix:** either set `protected_namespaces=()` on each model's `ConfigDict`
(explicit opt-out, project-wide convention) or rename to `kiwi_model_loaded`
/ `kiwi_model_size` / use Field aliasing. The cleanest fix here is the
namespace opt-out plus a one-line comment pointing to this finding.

### F-2 — Pydantic-level cap overrides env-configurable limit (SHOULD-FIX)

**Files:** `src/kiwi_service/models.py:17,33–42`; `src/kiwi_service/app.py:190–203`

```python
# models.py
_DEFAULT_MAX_INPUT_CHARS = 4096

@field_validator("text")
@classmethod
def _bound_length(cls, v: str) -> str:
    if len(v) > _DEFAULT_MAX_INPUT_CHARS:
        raise ValueError(...)
```

The README, `.env.example`, and `Settings.max_input_chars` all advertise
`KIWI_MAX_INPUT_CHARS` as the configurable knob (range `[16, 65536]`).
However, the Pydantic `LemmatizeRequest` validator hard-caps at
`_DEFAULT_MAX_INPUT_CHARS=4096` *before* the endpoint's
`_enforce_input_limit` can consult `Settings`. So:

- If ops *lowers* the env limit to 1024 → request hits the env check first,
  works as intended.
- If ops *raises* the env limit to 8192 → Pydantic validator rejects with 422
  at 4097 chars, never reaching `_enforce_input_limit`. The 413 path becomes
  unreachable; legitimate large inputs are silently 422'd.

The comment in `models.py` calls this "belt-and-suspenders", but the two
belts are buckled to different waists. Either:
- drop the field-level numeric check entirely (let `_enforce_input_limit`
  own it — it has access to `Settings` and returns the correct 413 + code),
- or pass `max_input_chars` into the model via dependency injection at
  request time (FastAPI supports custom validators), or
- bump `_DEFAULT_MAX_INPUT_CHARS` to the `Settings.max_input_chars` ceiling
  (65536) so the Pydantic layer is the absolute backstop, not the operative
  limit.

I'd pick option 1 — the endpoint check is sufficient and the model check is
redundant. The "belt-and-suspenders" justification doesn't survive contact
with the env variable's whole reason to exist.

### F-3 — Read-only FS may break kiwipiepy cache (SHOULD-FIX)

**Files:** `Dockerfile:67,76`; `docker-compose.yml:143–145`

```
useradd --system --uid 1000 --gid kiwi --no-create-home …
…
read_only: true
tmpfs:
  - /tmp:size=16m
```

`kiwipiepy` 0.20+ ships its model files inside the wheel under
`site-packages/kiwipiepy/*` (read-only path under the venv — fine), but the
underlying C++ analyzer may write to `~/.cache/kiwi*` on first load for
runtime caches in some builds, and Python itself will try to write `.pyc`
files anywhere on `sys.path` unless `PYTHONDONTWRITEBYTECODE=1` is set
(it is — Dockerfile:46 — good).

The risk: the kiwi user has no home (`--no-create-home`), `$HOME` will
resolve to `/` (root, owned by root, read-only mounted), and any future
`kiwipiepy` release that adds a cache write at model-warm-up time will
fail in production but not in CI (where the FS is writable).

**Evidence:** The SECURITY.md hardening checklist (`SECURITY.md:208–211`)
lists "Read-only filesystem" as enforced and says "kiwipiepy doesn't need
to write" without citing how this was verified. SHOULD-FIX is either:
- explicitly set `HOME=/tmp` and bind tmpfs there, OR
- run an integration test inside the read-only container that loads the
  model and runs `/lemmatize` to prove the negative, OR
- mount a tmpfs at `/home/kiwi` and create the home dir.

The cheap fix is `ENV HOME=/tmp` in the Dockerfile runtime stage.

### F-4 — Dead helper `surface_from_tag_stem` (NIT)

**File:** `src/kiwi_service/lemmatizer.py:178,209–216`

```python
def surface_from_tag_stem(tok: object) -> str:
    """Extract the morpheme's canonical stem string from a Kiwi Token. …"""
    return str(getattr(tok, "form", ""))
```

The function does exactly what `surface = str(getattr(tok, "form", ""))` on
line 174 already does — they're called with the same `tok` and the result
of one is fed straight into `_stem_to_lemma`. The docstring's "canonical
stem" framing implies it does *something* (stripping inflection? mapping
irregulars?) but it just returns the form. Either:
- inline-delete it and pass `surface` directly into `_stem_to_lemma`, or
- if it's meant as a future hook for stem mapping, mark it as such with a
  `TODO(B1-…)` and a ticket.

Currently it's a misleading abstraction — anti-KISS.

### F-5 — `_end_after_start` validator is a no-op (NIT)

**File:** `src/kiwi_service/models.py:64–67`

```python
@field_validator("end")
@classmethod
def _end_after_start(cls, v: int, info: object) -> int:  # pragma: no cover - trivial
    return v
```

The name promises a cross-field invariant ("end >= start"). The body
returns `v` unchanged. Either:
- implement the invariant using `info.data["start"]` (Pydantic v2
  `ValidationInfo`), or
- delete the validator. A non-implemented validator named after a
  constraint is worse than no validator — readers infer protection that
  isn't there.

The lemmatizer's `max(start_cp, min(end_cp, len(text)))` already keeps the
internal invariant; the API model could leave it implicit.

### F-6 — Bare `except Exception` in version helper (NIT)

**File:** `src/kiwi_service/app.py:294–300`

```python
def _kiwi_version_string() -> str:
    try:
        import kiwipiepy
        return str(getattr(kiwipiepy, "__version__", "unknown"))
    except Exception:  # noqa: BLE001
        return "unknown"
```

The only failure mode here is `ImportError` (kiwipiepy not installed).
Catching `Exception` masks programming errors. Narrow to `ImportError` and
let everything else propagate so a real bug isn't hidden behind "unknown".

(The bare catches in `Lemmatizer.__init__` and `Lemmatizer.lemmatize` are
defensible — they're proper boundary handlers that log and re-raise or
convert. This one is just lazy.)

### F-7 — `info: object` in field validator (NIT)

**File:** `src/kiwi_service/models.py:66`

Pydantic v2's validator signature is `(cls, v, info: ValidationInfo)`. Typing
it as `object` accepts the call but loses the type information mypy strict
would otherwise catch (and would block fixing F-5 cleanly). Replace with
`from pydantic import ValidationInfo` and `info: ValidationInfo`.

### F-8 — Test imports private name from conftest (NIT)

**File:** `tests/test_lemmatizer.py:147`

```python
def test_pathological_token_offset_clamped(self) -> None:
    from tests.conftest import _FakeKiwi, _FakeToken
```

Pytest's documented contract is that conftest provides fixtures, not
importable names. Importing `_FakeKiwi` / `_FakeToken` (note the leading
underscore — explicitly private) works today but couples the test to
conftest's file layout. Refactor to a `tests/_helpers.py` module exposing
`FakeKiwi` / `FakeToken` as public names, then conftest imports from
helpers, tests import from helpers. One change, two cleanups.

### F-9 — `real_lemmatizer` fixture should be session-scoped (NIT)

**File:** `tests/conftest.py:218–223`

```python
@pytest.fixture
def real_lemmatizer(kiwi_availability: KiwiAvailability) -> Lemmatizer:
    …
    return Lemmatizer(model_size="base")
```

Function scope is the pytest default. Each of the 5
`test_irregular_verbs_against_real_kiwi` parametrize cases will reload the
~100MB Kiwi model — ~500ms each per the ADR, so 2.5s wasted across one
parametrize set, more across the file. Promote to `scope="session"`. The
Lemmatizer is stateless w.r.t. calls so this is safe.

### F-10 — Fake `빨간 사과` offsets are unrealistic (NIT)

**File:** `tests/conftest.py:142–146`

```python
"빨간 사과": [
    ("빨갛", "VA", 0, 2),     # 빨간 -> 빨갛 stem
    ("ㄴ", "ETM", 1, 1),
    ("사과", "NNG", 3, 2),
],
```

The VA span `[0, 2)` covers the original surface "빨간", but the ETM jamo
"ㄴ" at `[1, 2)` overlaps it AND doesn't correspond to any character at
index 1 (which is "간", not "ㄴ"). This canned data passes the lemma
assertion but would fail any "offsets must cover the surface without
overlap" structural check. Real Kiwi reports the ETM with length 0 in this
position (the jamo is a sub-syllabic morpheme). Update the canned data to
match real behavior, or note explicitly that ETM offsets are
intentionally fudged in the fake.

This is the only inconsistency I found between fake and real semantics,
and the slow-layer test already catches it for real Kiwi — but the fake
should be honest too, or the offset-translation tests aren't testing what
they claim to test.

### F-11 — `Settings(extra="ignore")` vs project convention (NIT)

**File:** `src/kiwi_service/config.py:36`

Every other Pydantic model in this service uses `extra="forbid"`. The
Settings class uses `extra="ignore"`. The trade-off is real (env namespaces
collide; you don't want a stray `KIWI_HELPER=…` from a deployment script
to crash the app), but it's worth being explicit about — either document
the inversion in `config.py` with a comment, or switch to `forbid` and
accept the strict-env consequences. Right now it looks like a forgotten
override.

### F-12 — HEALTHCHECK regex is brittle (NIT)

**File:** `Dockerfile:82–84`

```
HEALTHCHECK …
  CMD curl -fsS http://127.0.0.1:${KIWI_PORT}/health \
      | grep -q '"model_loaded": *true' || exit 1
```

Two fragilities:
1. If F-1 is fixed by renaming `model_loaded` → `kiwi_model_loaded`, this
   silently breaks healthchecks until someone notices.
2. FastAPI's `JSONResponse` emits compact JSON (`"model_loaded":true`, no
   space) — the regex's `: *` handles both, so this works *today*, but a
   future switch to pretty-printed responses (e.g. via a custom encoder)
   breaks it again.

Use `python -c "import json,urllib.request,sys; sys.exit(0 if json.loads(urllib.request.urlopen('http://127.0.0.1:'+'${KIWI_PORT}'+'/health').read())['model_loaded'] else 1)"` — Python is already in the image; no shell-regex
fragility. Or use a dedicated `/healthz` endpoint that returns
status code (200 vs 503) so `curl -f` alone is the test.

---

## Coordination observations

- **Boundary with B3 (gateway).** The contract is clean: B3 calls `POST
  /lemmatize` with `{text}`, gets back `{tokens: [{surface, lemma, pos,
  start, end}]}`. B3 owns auth, rate limiting, caching, request IDs
  (honored if supplied). This is exactly the seam the engine architecture
  in `DESIGN_SPEC.md §The engine` describes. Good fit.

- **Boundary with the DB.** None — Kiwi has no DB credentials, can't read
  KRDICT, can't write the cache. The cache layer described in
  `DESIGN_SPEC.md §The engine ("Cache layer in Postgres")` is B3's
  responsibility, correctly. ADR-014's open question #3 acknowledges this
  explicitly. Good architectural discipline.

- **Boundary with the security model.** The `internal: true` network is
  the single most valuable security control here, and the ADR + SECURITY.md
  + compose all agree on its role. T7 (container escape → lateral
  movement) is convincingly defended.

- **Friction surfaces I'd watch.** (1) When B3 implements caching, will it
  cache on the *text* (full sentence) or the *lemma* (per token)? The
  current `/tokens` vs `/lemmatize` split anticipates both — fine. (2)
  When OOV words enter (proper nouns from Iyagi, slang from TTMIK), the
  ADR's "Open questions — Custom dictionary" path is ready. (3) Cold-start
  spike (~200–500ms first request) is documented in README§Gotchas but not
  surfaced to B3's deploy playbook — worth a one-line cross-reference when
  B3 lands.

- **Compose integration.** B1's stanza added to `docker-compose.yml` is
  internally consistent with the existing `db` stanza style (named
  container, restart policy, healthcheck, deploy.resources.limits, json-file
  logging caps, `no-new-privileges`). It correctly adds `kiwi:
  {condition: service_healthy}` to `server.depends_on` so B3 waits for the
  model to finish loading. No drift from the project's compose conventions.

---

## What I'd want to see before next review

1. **F-1, F-2, F-3 fixed** (the three SHOULD-FIXes).
2. A real-Kiwi smoke test running inside the actual read-only container
   to prove F-3 isn't latent (`docker compose up kiwi` + `/health` going
   green + `/lemmatize` returning tokens).
3. A short note in `README.md§Performance` linking to B3's expected
   cold-start handling, so the next reviewer doesn't have to triangulate
   between three files to find it.

No new ADR needed. The work is well-grounded.
