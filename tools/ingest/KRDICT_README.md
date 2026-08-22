# KRDICT loader

KRDICT (Korean Learners' Dictionary, 한국어기초사전) is the open Korean↔English
learner dictionary published by 국립국어원 (National Institute of Korean
Language). It is the lexical spine of the tap-a-word flow in
`DESIGN_SPEC.md`:

> Kiwi lemmatize → KRDICT lookup → Claude enrich → add to vocab.

This directory's KRDICT-specific files are:

| File | Role |
|---|---|
| `krdict_models.py` | Pydantic boundary models (parser ⇄ loader). |
| `krdict_parser.py` | Streaming XML parser, defusedxml-backed. |
| `load_krdict.py` | Idempotent, resumable, batched Postgres loader + CLI. |
| `tests/test_krdict_parser.py` | Parser fixture tests. |
| `tests/test_krdict_loader.py` | Loader unit + integration tests. |
| `tests/fixtures/krdict_sample.xml` | Hand-crafted 8-entry + 1-malformed fixture. |
| `KRDICT_README.md` | This file. |
| `KRDICT_SECURITY.md` | Attack-vector enumeration + defenses. |

ADRs (in `db/docs/`):

* `ADR-015-krdict-schema.md` — table layout, denormalization choices, FK policies.
* `ADR-016-krdict-parser-format.md` — XML vs JSON, defusedxml choice.
* `ADR-017-krdict-pos-taxonomy.md` — why POS is TEXT+CHECK and not an enum.

The DB migration is `db/migrations/003_krdict.up.sql` / `003_krdict.down.sql`.

---

## Downloading the KRDICT dataset

> **CORRECTED 2026-06 (verified against the real download).** The bulk dataset
> is **LMF** (Lexical Markup Framework, `DTD_LMF_REV_16`) — every value is a
> `<feat att="X" val="Y"/>` pair under `<LexicalResource><Lexicon><LexicalEntry>`
> — **not** the TEI-Lite shape an earlier version of this README and ADR-016
> assumed. `krdict_parser.py` has been rewritten for LMF. Concretely:
>
> 1. Open **https://krdict.korean.go.kr/download/downloadPopup** (from the site:
>    "사전 내려받기" → "사전 전체 내려받기"). No API key is needed for the bulk file.
> 2. Choose **"XML 전체 내려받기"** (XML, not Excel/JSON — XML carries
>    conjugations + multilingual equivalents).
> 3. Unzip to `data/krdict/`. The 2026-05 export is **11 volumes**, e.g.
>    `1_5000_20260529.xml … 11_3671_20260529.xml` (~386 MB unzipped, ~54k
>    entries). The parser reads every `*.xml` under the directory in sorted order.
> 4. Record the zip's SHA-256 for `krdict_source.source_sha256`.
>
> The KRDICT **Open API** (`/api/search`, 32-hex key, 50k calls/day) returns a
> *different* schema (`<channel><item>…`) and is intended as the **fallback /
> cache-miss** path, not the bulk loader — it needs its own small mapper.
>
> The original (TEI-Lite) instructions below are retained for history but are
> superseded by the above.

> **This is a manual / external step. The loader expects the data to be on
> disk already at `Repository/data/krdict/`. The loader DOES NOT download
> anything itself.**

1. Visit https://krdict.korean.go.kr/eng/mainAction
2. Top nav → "Open KORLEX" / "오픈 사전 자료". (Link target moves;
   navigate to the open-data page.)
3. Register for the open-data download (free; email + a brief use
   description). Approval is usually same-day.
4. Download the XML bundle (TEI-Lite-style). Choose XML over JSON —
   XML carries conjugation tables and per-sense register tags that the
   JSON export drops (see ADR-016).
5. Unpack to `Repository/data/krdict/`. Final layout:

   ```
   Repository/data/krdict/
       META.txt
       <volume-1>.xml
       <volume-2>.xml
       …
   ```

6. Record the SHA-256 of the bundle in your run notes — the loader stores
   this in `krdict_source.source_sha256` for provenance.

### License

> **CORRECTED 2026-06:** KRDICT is distributed under **CC BY-SA 2.0 KR**
> (저작자표시-동일조건변경허락 — attribution + **share-alike**), per
> https://krdict.korean.go.kr, **not** KOGL Type 1 (the note below is wrong).
> Attribute "국립국어원 한국어기초사전". ShareAlike adds a copyleft clause: a
> redistributed *derivative* of the data must use the same license. For this
> single-user, non-redistributed app it never triggers. `krdict_models.py`
> `KrdictSourceMetadata` now defaults to the CC BY-SA 2.0 KR string + URL.

KRDICT is distributed under **KOGL Type 1** (공공누리 제1유형 — attribution).
Free for any use including commercial, must attribute "국립국어원
한국어기초사전". The loader stores the license string in
`krdict_source.license` and the attribution URL in `license_url`. See
https://www.kogl.or.kr/info/license.do for the canonical license text.

---

## Running the loader

### Prerequisites

* Postgres 16+ reachable via `DATABASE_URL` env var (or `--database-url`).
* The 003 migration applied (`python -m db.migrate up`).
* Python 3.11+ with `pydantic`, `defusedxml`, `psycopg[binary]` installed.

### One-shot ingest

```bash
export DATABASE_URL="postgresql://user:pass@host:5432/korean_master"

python -m load_krdict \
    --source Repository/data/krdict/ \
    --source-label "KRDICT-2026-Q1" \
    --batch-size 1000
```

`source-label` is the unique provenance key — different vintages of the
KRDICT dataset get different labels.

### Dry run (parse + validate; no DB I/O)

```bash
python -m load_krdict \
    --source Repository/data/krdict/ \
    --source-label "KRDICT-2026-Q1" \
    --dry-run
```

Prints aggregate stats to stdout (JSON). Use to sanity-check a new dataset
vintage before committing it.

### Resume after a crash

The loader checkpoints `last_processed_source_id` to `krdict_import_state`
inside the same transaction as each batch. On crash, re-run with
`--resume`:

```bash
python -m load_krdict \
    --source Repository/data/krdict/ \
    --source-label "KRDICT-2026-Q1" \
    --resume
```

Resume requires the checkpoint to exist (same label + same SHA-256). A
missing checkpoint raises `KrdictResumeWithoutCheckpointError` (exit 3) —
silent restart-from-zero would be a footgun.

### Idempotency

Re-running the loader on the same archive is a no-op for unchanged entries
and a row-level UPDATE for changed ones (it bumps `updated_at` and
`version`). Senses + examples + inflections are replaced for each updated
entry (children CASCADE on the entry FK).

This contract is tested in `tests/test_krdict_loader.py::test_loader_idempotent_on_rerun`.

---

## Verifying a successful load

After a successful run, you should see:

```sql
SELECT count(*) FROM krdict_entries;             -- ≈ 50k–110k depending on vintage
SELECT count(*) FROM krdict_senses;              -- ≈ 100k–250k
SELECT count(*) FROM krdict_examples;            -- ≈ 200k–500k
SELECT count(*) FROM krdict_inflections;         -- ≈ 30k–80k (verbs + adjectives only)

-- Provenance + completion checkpoint:
SELECT source_label, completed_at, entries_processed, entries_skipped
  FROM krdict_import_state
 ORDER BY started_at DESC LIMIT 5;

-- Smoke-test the tap-a-word path:
SELECT id, headword, part_of_speech, definition_english
  FROM krdict_entries
 WHERE headword = '먹다';

-- Smoke-test FTS:
SELECT id, headword, ts_rank(search_tsv, q) AS r
  FROM krdict_entries, plainto_tsquery('simple', 'family') q
 WHERE search_tsv @@ q
 ORDER BY r DESC LIMIT 5;
```

`entries_skipped` > 0 means the loader logged at least one
`krdict_parser.entry_skipped` event — review the logs to decide whether
that's expected (a known-bad upstream entry) or a parser bug to file.

---

## Running tests

```bash
cd tools/ingest
python -m pytest tests/test_krdict_parser.py -v
python -m pytest tests/test_krdict_loader.py -v
```

The loader-integration tests (marked `@pytest.mark.pg`) skip themselves
unless `KRDICT_TEST_DATABASE_URL` is set in the environment. In CI:

```bash
export KRDICT_TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/korean_master_test"
python -m pytest -m pg tests/test_krdict_loader.py -v
```

(The CI harness applies migrations 001 → 002 → 003 against the test DB
before running the marked tests.)

---

## Operational notes

* **Statement timeout**: the loader explicitly disables `statement_timeout`
  for its session (ADR-001 §D13 — loaders are allowed long queries).
* **Application name**: the loader connects with
  `application_name='korean-master-krdict-loader'` so it's visible in
  `pg_stat_activity`.
* **Batch size**: 1000 is fine for a Postgres on a modest VM. Lower to
  100–500 if connection memory pressure is an issue.
* **Re-ingest on schema drift**: if a future migration adds a column the
  loader populates, run `--source … --source-label … ` (without `--resume`)
  and ON CONFLICT will UPDATE the existing rows with the new column
  populated. The `IS DISTINCT FROM` guard on the upsert avoids churning
  `version` on truly unchanged rows.

## Gotchas

* **POS taxonomy drift**: when KRDICT introduces a new POS value the CHECK
  in 003 will reject the insert. Add the value via a migration that
  updates `ck_krdict_entries_pos` (one-liner). The loader will fail loudly
  with a `CheckViolation` on the first new-POS entry — by design, so the
  drift is investigated rather than silently mapped to NULL.
* **Multi-file archives**: when `--source` is a directory the parser
  visits `*.xml` files in sorted recursive order. This makes
  `last_processed_source_id` resume offsets stable across re-runs.
* **Unknown register values**: KRDICT occasionally tags entries with
  register strings outside the canonical six (`반말 / 해요체 / 합쇼체 /
  문어체 / 하오체 / 하게체`). The Pydantic model coerces unknown values
  to NULL rather than rejecting the entry. The parser logs a warning;
  decide entry-by-entry whether to widen the enum or leave NULL.

## Coordination

* B3 (Darakwon corpora loader) owns the existing files in this directory.
  KRDICT-specific files are prefix-namespaced (`krdict_*.py`,
  `KRDICT_*.md`) to avoid collision.
* The Postgres `corpus_sources` table from 002 is NOT used by KRDICT —
  see ADR-015 §D12 for the rationale and the `krdict_source` sibling
  table that takes its place.
