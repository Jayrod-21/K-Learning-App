# Canonical-grammar dedup — security addendum

> Addendum to `LOADERS_SECURITY.md`. The canonical-grammar dedup script
> (`cluster_canonical_grammar.py`) operates inside the same trust boundary
> as the corpus loaders: privileged DB context, no untrusted user input.
> Most of the loader threat model applies unchanged. This file enumerates
> only the *new* surface introduced by this component.

## New attack vectors

### A. SQL injection through pattern strings

- **Vector.** Pattern strings in the source JSON are vision-OCR output;
  a malformed entry could carry SQL-flavoured text in `pattern`.
- **Defense.** All DB writes in `cluster_canonical_grammar.py` use
  psycopg `%s` / `%(name)s` parameter placeholders. No `format` / `f""`
  SQL interpolation anywhere. Pattern strings are passed as parameters to
  `INSERT … VALUES (%s, …)` and to `UPDATE … WHERE pattern_key = %s` —
  psycopg parameterises them as TEXT, not as SQL fragments.
- **Defense in depth.** The DB-side `CHECK (length(pattern_key) > 0)`
  ensures a zero-length pattern never lands. Pattern strings have no
  syntactic structure on the DB side; they're TEXT.

### B. JSONB injection through `notes` payload

- **Vector.** A pattern's notes payload (aliases list, review reason)
  could be crafted to inject jsonb keys the app trusts.
- **Defense.** The notes payload is constructed by `_upsert_clusters`
  from `CanonicalCluster` — a Pydantic model with `extra='forbid'`,
  meaning unknown fields raise at construction time. The fields in
  `notes` are: `aliases (list[str])`, `members_per_level
  (dict[str,int])`, `needs_review (bool)`, `review_reason (str|None)`,
  `member_count (int)`. Serialised via `json.dumps` with the value
  controlled entirely by this code path.
- **Defense in depth.** `CHECK (jsonb_typeof(notes) = 'object')` on
  `canonical_grammar.notes` rejects array / scalar payloads at the DB
  layer, blocking a future caller from accidentally writing `[…]`.

### C. ReDoS in `normalize_pattern`

- **Vector.** A pathological input string could blow up the regex
  engine.
- **Defense.** Every regex is linear-time: anchored to start (`^`), no
  nested quantifiers, no back-references. Worst-case is a long string of
  invisible characters which match `_INVISIBLE_RE` once per char in
  linear time.
- **Test.** Inputs up to ~10 KB run in < 1 ms in informal benchmarking.
  Larger inputs would be rejected upstream by the Pydantic loader's
  pattern-length constraints (TODO: add an explicit length cap if Phase
  B ever sees adversarial inputs).

### D. FK orphaning by manual canonical_grammar deletion

- **Vector.** An operator runs `DELETE FROM canonical_grammar WHERE
  pattern_key = '…'` directly and orphans the kgiu rows that pointed at
  it.
- **Defense.** The FK is `ON DELETE SET NULL` (ADR-001 §D9) — kgiu rows
  survive with `canonical_grammar_id = NULL`, which is the "not yet
  clustered" state. Re-running `cluster_canonical_grammar.py apply` will
  rebuild the cluster and re-link the FK. No data loss.
- **Defense in depth.** The `version` column on every kgiu row that gets
  updated bumps by 1 on each re-link, so an audit can spot unexpected
  re-link storms.

## Vectors that DON'T apply

- Authentication, sessions, CORS, rate limiting — not an HTTP-facing
  surface.
- Multi-tenant isolation — single-user app per design.
- Secrets exposure — no secrets touched; only `DATABASE_URL` (already
  governed by the loader threat model).

## Operational checks

- Application name on the connection: `korean-master-canonical-grammar`
  — surfaces in `pg_stat_activity` so an operator can spot a
  long-running or stuck apply pass.
- Structured logs include `clusters_inserted`, `clusters_updated`,
  `kgiu_rows_backfilled`, plus `missing_canonical_id_after_upsert`
  warnings if the cluster→ID round-trip fails (would indicate a race
  or a broken UNIQUE constraint).
