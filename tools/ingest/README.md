# Ingestion tools

Scripts to turn raw source materials (PDFs, audio) into structured database rows.

## Pipeline

```
PDF / audio  →  parse_*.py  →  output/*.json  →  load_to_postgres.py  →  Postgres
```

Output JSON is gitignored (derived data of copyrighted sources). Re-run any time.

## Scripts

| Script | Input | Output |
|---|---|---|
| `parse_ttmik.py` | TTMIK lesson-script PDFs (Levels 1-9) | JSON with sources/units/sentences |
| `parse_iyagi.py` | TTMIK 이야기 (Iyagi) transcript PDFs | JSON with sources/episodes/dialog turns |
| `load_to_postgres.py` | Any parser JSON in `output/` | Loads into the project's self-hosted Postgres (idempotent, checksum-gated) — see `LOADERS_README.md` / ADR-019 |

## Running the parsers

```bash
# TTMIK lessons (3 PDFs, levels 1-9)
python parse_ttmik.py \
    "../../../Lessons/Lesson Scripts/TTMIK Level 1 - 3.pdf" \
    output/ttmik_1_3.json \
    --slug ttmik-1-3 --series-title "TTMIK Levels 1-3"

# Iyagi transcripts (3 PDFs, episodes 1-146)
python parse_iyagi.py \
    "../../../이야기들/이야기 Scripts/TTMIK Talking 1 - 50.pdf" \
    output/iyagi_1_50.json \
    --slug ttmik-iyagi-1-50 --series-title "TTMIK 이야기 #1-50"
```

## Loading into Postgres

The Supabase/PostgREST loader (`load_to_supabase.py`) is retired — see ADR-019
and `LOADERS_README.md`. The live loader is `load_to_postgres.py`, run as a
module against the project's self-hosted Postgres:

```bash
export DATABASE_URL=postgres://user:pass@host:5432/db

python -m tools.ingest.load_to_postgres --corpus all
# or one corpus at a time, e.g.:
python -m tools.ingest.load_to_postgres --corpus ttmik
```

See `LOADERS_README.md` for the full CLI (`--dry-run`, `--force`,
`--batch-size`) and per-corpus loader layout.

The loader is idempotent — re-running over the same file updates rather than duplicates.

## Current parser coverage

| Source | Status | Notes |
|---|---|---|
| TTMIK Levels 1-9 | ✅ Parsing works | 233 lessons / 2,769 sentence rows |
| TTMIK 이야기 #1-146 | ✅ Parsing works | 139 episodes / 11,611 dialog turns |
| Darakwon vocab books | ❌ Blocked on OCR | Image-only PDFs, no text layer |
| Darakwon KGIU grammar | ❌ Blocked on OCR | Has bad Adobe OCR layer, needs re-OCR |
| KRDICT (국립국어원) | ✅ Loader ready | XML → Postgres via `load_krdict.py` (B2). See `KRDICT_README.md`. |
| TOPIK test papers | ❌ Blocked on OCR | All TOPIK PDFs are image-only |
| HTSLANS textbook | ❌ Missing source | Have audio (~14 chapters) but no text/PDF |

## Known issues

- TTMIK parser captures vocab glosses (e.g., `안녕 = well-being`) and morpheme breakdowns
  (e.g., `안녕+하세요 = 안녕하세요`) as "sentences." This is intentional — they're useful
  flashcard material — but a future migration may want a `kind` column to distinguish.
- Iyagi speaker normalization (e.g., `최경은` and `경은` are the same person) is not done.
- 9 TTMIK lessons came out with 0 sentences (likely hangul/pronunciation-only lessons).
- TTMIK dialog regex undercounts speaker tags when `[romanization]` is present.
