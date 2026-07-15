# TESTS.md — Korean Master

Test manifest for this project. `/testcheck` reads this file and runs each
declared suite. The single authoritative gate is `Deploy/local-test.sh`, which
reproduces GitHub Actions `.github/workflows/ci.yml` (plus the db + kiwi suites
CI omits) in pinned containers so results don't depend on the host toolchain.

Run the whole gate before any build / stand-up / deploy:

```bash
Deploy/local-test.sh          # full gate (JS + db + kiwi + secret scan)
Deploy/local-test.sh --fast   # inner loop: JS + secret scan only (NOT a gate)
```

The pipeline order this gate sits in: **test → build → smoke → stand up →
validate → switch to prod**. A red hard suite blocks the build.

---

## Suites

| # | Suite | Command | Runner | Pass criteria |
|---|-------|---------|--------|---------------|
| 1 | Client | `npm ci && npm run lint && npx tsc --noEmit && npm run build` (in `client/`) | `node:22-slim` container | Lint clean, no TS type errors, Vite build succeeds |
| 2 | Server | `npm ci && npm run lint && npm run typecheck && npm test` (in `server/`) | `node:22-slim` container | Lint (incl. no-restricted-imports guardrails) clean, no TS errors, all vitest tests pass |
| 3 | DB migrations | `python -m pytest db/tests --ignore=db/tests/test_discriminator_coverage.py -q` | `python:3.12` + Docker socket (`--network host`) | testcontainers spins `postgres:16-alpine`; all migration up/down + real-migration tests pass. (Discriminator/enum-coverage runs in the ingest phase — it needs generated ingest output.) |
| 4 | Kiwi service | `python -m pytest --no-slow -q` (in `services/kiwi/`) | `python:3.12` container | API + lemmatizer tests pass against the fake Kiwi engine (no model download) |
| 5 | Secret scan | grep for `ANTHROPIC_API_KEY=sk-` / `SUPABASE_SERVICE_KEY=eyJ` in source | host | No API-key literals committed in source (HARD fail if found) |

**Hard gates:** 1–5 must all pass. A failure exits non-zero and blocks deploy.

## Soft gates (reported, non-blocking — mirror CI's `|| true`)

| Suite | Command | Notes |
|-------|---------|-------|
| Ingest lint | `ruff check .` (in `tools/ingest/`) | Style/lint on the corpus loaders |
| npm audit | `npm audit --audit-level=high` (client + server) | JS advisories surfaced, not blocking |
| pip-audit | `pip-audit --strict` (ingest loader deps + `services/kiwi`) | Python SCA, mirrors `ci.yml`; surfaced, not blocking |

## Not run by this gate (run elsewhere, by design)

- **`tools/ingest/tests/`** — these are DB-loader tests that exercise the corpus
  ingest against a real Postgres. They run during the **ingest phase** against
  `km-db` (`Deploy/load-corpora.sh` / `load-krdict.sh` context), not in the
  pre-build gate. CI likewise runs only ruff + pip-audit on `tools/ingest`.
- **Kiwi `slow` tests** — the real-Kiwi (100 MB model) integration tests. Run
  with `pytest --require-kiwi` inside the built `km-kiwi` image if needed.
- **Post-build smoke** — `docker run` + `curl /health` on the built `km-server`
  and `km-kiwi` images. This is the "validate" stage after build (the CI gap
  where images were never actually run); driven from the deploy flow, not here.
