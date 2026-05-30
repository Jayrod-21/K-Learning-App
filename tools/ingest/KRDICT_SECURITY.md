# KRDICT loader — security threat model & defenses

Per SENIOR_ENGINEER_BAR §"Security (every component)": every component
ships its own attack-vector enumeration. This file enumerates the
specific vectors against the KRDICT XML parser + Postgres loader, and the
defense for each.

## Trust posture

KRDICT is downloaded from a government source (국립국어원) — **semi-trusted**.
We do not assume malice, but we DO assume:

* Files could be corrupted in transit, or by a wrong tarball replacing
  the right one on the upstream server.
* A future archive could include a parser-confusing edge case the loader
  was not designed for.
* The local archive on disk could be tampered with after download (a host
  the server admin doesn't directly control).

We parse **defensively** in every case. "It's from the government" is not
a defense, ever.

## Attack vectors and defenses

### V1. XML External Entity (XXE) injection

**Vector:** A maliciously crafted XML file embeds an external DOCTYPE
declaration with entities that:
* exfiltrate local files (`<!ENTITY x SYSTEM "file:///etc/passwd">`),
* probe internal network (`<!ENTITY x SYSTEM "http://internal/admin">`),
* DoS via recursive entity expansion (billion-laughs).

**Defense:** All XML parsing goes through `defusedxml.ElementTree`,
which (a) refuses DOCTYPE by default (`forbid_dtd=True`), (b) refuses
entity declarations (`forbid_entities=True`), (c) refuses external
references (`forbid_external=True` — the default). Both flags are also
set explicitly in `krdict_parser._iter_entries_from_path` for
documentation and so a future defusedxml default change doesn't silently
weaken our posture.

**Verification:** `defusedxml.ElementTree.iterparse` raises
`EntitiesForbidden`, `ExternalReferenceForbidden`, or
`DTDForbidden` immediately on a malicious file — the loader's per-file
`try/finally` ensures cursor cleanup, and the file-level exception
bubbles up. No partial commits.

### V2. XML billion-laughs / entity-bomb DoS

**Vector:** Nested entity definitions that expand exponentially
(`<!ENTITY a "&b;&b;"> <!ENTITY b "&c;&c;"> …`). Even without
external references, this can OOM the parser.

**Defense:** `forbid_entities=True` rejects entity definitions outright.

### V3. Pathological entry size

**Vector:** A single `<headword>`, `<definition_ko>`, or `<example_ko>`
that's hundreds of megabytes, OOM-ing the parser and/or the Postgres
INSERT.

**Defense:** Two walls:

1. **Loader-side**: every Pydantic model field has a `max_length`
   matching the corresponding DB CHECK. Validation fails BEFORE the
   value reaches Postgres. (Length caps: 200 for headword /
   pronunciation / hanja / POS; 8000 for definitions; 4000 for
   examples; 200 for inflection forms/labels.)
2. **DB-side**: the same length caps as CHECK constraints in
   `003_krdict.up.sql`. Even if a future loader change forgot the
   Pydantic check, the DB rejects.

### V4. SQL injection

**Vector:** Headword or definition text containing `'); DROP TABLE
krdict_entries;--` or similar.

**Defense:** All SQL in `load_krdict.py` is parameterized via psycopg's
`%(name)s` named-parameter binding. There is zero string interpolation
of values into SQL. The test
`test_persist_entry_uses_parameterized_queries` asserts this
mechanically: it inspects every `cursor.execute` call and verifies the
SQL string is the first arg, parameters the second — never a single
concatenated string.

**Additional defense:** the test also asserts no value characters
(Korean headwords, source IDs) appear inside the SQL text itself, so a
regression that started building dynamic SQL would be caught.

### V5. Loader-resume forging

**Vector:** A malicious operator forges a
`krdict_import_state.last_processed_source_id` to skip rows the
upstream archive labels "skip these" — e.g., a row containing a
backdoored example sentence that bypasses review.

**Defense:** `krdict_import_state` is keyed on
`(source_label, source_sha256)`. The loader recomputes the SHA-256 on
every run before reading the checkpoint. A different archive than the
one that produced the checkpoint yields a different SHA, a different
row, no resume. This bounds a tampered checkpoint to the specific
archive it was written against — and the archive itself has its own
SHA tied to the krdict_source row.

This is not bulletproof against a fully-compromised DB
(everything is then up for grabs) but it bounds the damage to "what
this archive contains" rather than "anything the operator can dream up".

### V6. Re-ingest race / partial state

**Vector:** Two loader invocations against the same archive at the same
time corrupt the checkpoint or write phantom rows.

**Defense:** every batch is wrapped in a single transaction together
with the checkpoint update; psycopg's per-connection isolation
(READ COMMITTED by default) plus the UNIQUE constraint on
`(source_label, source_sha256)` mean two concurrent loaders write
checkpoints that don't conflict but ALSO don't interleave the upsert
streams in a way that corrupts. They'll both bump version on every row;
that's wasteful, not corrupting.

A stronger guarantee (advisory lock on `source_label`) is reserved for
the day someone reports the duplicate-loader case in practice. YAGNI.

### V7. Logging leaks

**Vector:** Logs are shipped off-server (CI logs, observability stack)
and contain provenance — but provenance must not include secrets.

**Defense:** The structured logger NEVER logs `DATABASE_URL` or any
field marked sensitive. Source paths and SHA-256s are not secrets. The
loader's `_JsonFormatter` whitelists `extra={}` keys it can JSON-encode
and falls back to `repr()` for unencodeable values — no `**kwargs`
sloppiness.

### V8. Statement-timeout disabled

**Vector:** The loader explicitly sets `statement_timeout = 0` for its
session — a runaway query could hold a connection forever.

**Defense:** This is documented as the loader role's contract in
ADR-001 §D13 ("Statement timeout per role: 5s for the app, 0 for
migrations and loaders"). The loader connects with
`application_name='korean-master-krdict-loader'`, so a stuck loader
shows up in `pg_stat_activity` and can be `pg_terminate_backend`'d by
the operator. The trade-off (a stuck loader can hold a connection) is
acceptable in the operational model — we are a single-user app.

### V9. Storage exhaustion

**Vector:** A KRDICT archive 100× larger than expected fills the disk
during ingest.

**Defense:**

* The loader counts `<entry>` occurrences before connecting; if the
  count is wildly different from expectations, the operator notices in
  the log line `krdict_loader.source_hashed item_count=…`.
* Postgres-side: `corpus_sources.item_count` (or the KRDICT-specific
  `krdict_source.item_count` per ADR-015 §D12) carries the reported
  size, and `krdict_import_state.entries_processed` carries the
  actual. A wide divergence is a tripwire.

Disk monitoring is the operator's responsibility — the loader doesn't
self-limit by free space because that's not something the application
layer is well-positioned to enforce.

### V10. Encoding confusion

**Vector:** Source XML claims `<?xml encoding="utf-8"?>` but is actually
EUC-KR; misparsed bytes become an attack surface for the FTS path.

**Defense:** `defusedxml.iterparse` honors the XML declaration; the
parser does not override. UTF-8 is what KRDICT publishes. If a future
vintage publishes EUC-KR, the parser will raise a `UnicodeDecodeError`
on the first non-ASCII byte — loud failure, not silent corruption.

## What we deliberately do NOT defend against

* **Malicious code execution on the DB server.** If an attacker has root
  on the Postgres host, no application-layer defense matters. Out of
  scope.
* **Plaintext content review.** We do not human-review every example
  sentence for objectionable content. KRDICT is curated by 국립국어원;
  if they publish a slur in a definition, that's an upstream issue.
* **Encrypted-at-rest data.** Postgres-level encryption (TDE,
  filesystem-level dm-crypt) is the operator's call. KRDICT is open
  public data; encryption-at-rest is for the user-table side of the
  schema.

## Test coverage of these defenses

* `test_persist_entry_uses_parameterized_queries` — V4.
* `test_model_rejects_oversized_headword` — V3 (loader side).
* `ck_krdict_entries_headword_len` in 003 — V3 (DB side).
* `test_parser_skips_malformed_entry_via_callback` — V3 + V8 graceful
  degradation (a broken entry doesn't crash the load).
* `test_loader_resume_without_checkpoint_raises` — V5 (silent resume
  refused).
* `test_compute_source_sha256_*` — V5 provenance hash.

defusedxml itself ships with a suite covering V1+V2; we depend on that
contract rather than re-asserting it.
