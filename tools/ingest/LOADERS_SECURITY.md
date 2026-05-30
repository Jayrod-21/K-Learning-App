# Corpus loaders — security threat model

> Loaders run in a privileged context (DB write access). The threat model is
> smaller than the API server's — there's no untrusted user input — but a
> compromise here can still poison reference data, so we enumerate.

## Trust boundary

The loader is invoked by an operator (Jared, or a deploy pipeline) with the
`DATABASE_URL` env var pointing at the Postgres on Dad's home server.
It reads JSON files from `tools/ingest/output/`. Those files are
parser outputs produced by Claude vision over PDFs — i.e. they're
**partially trusted**: structured by us, but the content came from an LLM
processing arbitrary book pages.

## Attack vectors

### 1. SQL injection through corpus data

- **Vector:** A malformed source JSON could carry a field value that, if
  interpolated into SQL, would break out and execute arbitrary statements.
- **Defense:** Every INSERT/UPDATE in the loaders uses psycopg's `%s`
  placeholder. No `f"..."` SQL interpolation anywhere in this tree. The
  natural-key clauses in `ON CONFLICT` are static SQL with `EXCLUDED.*`
  references; no caller-supplied SQL is concatenated.
- **Defense:** Pydantic models reject typed-wrong values before they reach
  SQL — e.g. `source_pages` is `list[int]`, so a string "; DROP TABLE" can
  never be passed where an int array is expected.

### 2. Resource exhaustion via huge JSONs

- **Vector:** A 1 GB JSON could blow process memory.
- **Defense:** SHA-256 of the file is streamed (`sha256_of_file`), not
  computed by re-reading the whole bytes. The parse step still loads the
  doc into memory — bounded by source-file size (~1-2 MB today, ~50 MB
  worst case for the full TOPIK corpus). Documented for future revisit.

### 3. Resource exhaustion via large per-row payloads

- **Vector:** A single item with a 10 MB `explanation` blob.
- **Defense:** Postgres TOAST handles up to ~1 GB per column safely.
  We don't impose a hard cap (yet) because the parser output we control
  doesn't produce that. If we ever ingest from a less-controlled source,
  add a Pydantic `Field(..., max_length=N)` per text column.

### 4. Foreign-key tampering

- **Vector:** A loader writes rows pointing at `corpus_source_id` for
  another corpus.
- **Defense:** Each loader hard-codes its corpus enum value. `corpus_sources`
  is keyed UNIQUE on `corpus`, so we can't write the wrong parent row.
- **Defense:** Schema CHECK constraints
  (`ck_kgiu_entries_corpus_kgiu_only`, `ck_topik_tests_corpus_pinned`,
  etc.) reject writes that pick the wrong corpus.

### 5. Checkpoint forgery

- **Vector:** A malicious actor with write access to `load_state` could set
  `status='complete'` for a corpus we haven't loaded, causing future loads
  to be silently skipped.
- **Defense:** DB-level access control — only the `korean-master-loader`
  role writes to `load_state`. The API role doesn't have write privilege
  on this table.
- **Defense:** Loader honors `--force` to override checkpoint state; the
  fallback for "I don't trust the checkpoint" is `--force`.

### 6. Secret exposure

- **Vector:** `DATABASE_URL` leaks via logs.
- **Defense:** structlog renderer doesn't log env vars. The loader never
  emits `DATABASE_URL` in any log line; we log host/db only when
  troubleshooting connection failures (via psycopg's error messages,
  which include host:port but not the password).

### 7. Transactional safety

- **Vector:** Loader crash mid-batch leaves dangling rows.
- **Defense:** Each batch is one transaction; `last_item_id` is updated in
  the same transaction as the data INSERT. A crash before COMMIT rolls back
  both; on resume the loader retries the batch (idempotent via ON CONFLICT).

### 8. Type confusion at JSONB boundary

- **Vector:** Source JSON sends an array where the schema expects an
  object, or vice versa — the row fails CHECK and the whole batch aborts.
- **Defense:** Pydantic validates shape at the boundary; the loader
  hard-fails (non-zero exit) so the operator knows something changed in
  the parser. Better than silently mangling data.

## What the loader explicitly trusts

- The PDF-extracted JSON has been reviewed by Jared / the parser tests
  for fidelity. Hostile content (script tags, control characters) in
  text columns is stored as-is; the API layer renders user data with
  HTML escaping, so a malicious `<script>` in a Korean grammar
  explanation does no harm there. (We could strip control chars in the
  loader; deferred.)
- Postgres role separation — the loader role can write reference data,
  the API role cannot.

## Bar checks

- [x] Parameterized queries only — psycopg `%s` everywhere.
- [x] Pydantic models at every I/O boundary.
- [x] Structured logging via structlog.
- [x] Idempotent: ON CONFLICT DO UPDATE keyed on natural keys.
- [x] Resumable: load_state checkpoint table.
- [x] Tests against real Postgres in Docker (testcontainers).
- [x] No secrets in code (env vars + Pydantic settings).
- [x] No business logic in the database (triggers only mechanical).
