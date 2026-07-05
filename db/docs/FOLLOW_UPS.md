# Follow-ups — TTMIK transcript feature (`feat/ttmik-transcripts`)

Non-blocking items surfaced during the `/fixpass` review cycle. None block shipping
the transcript feature; each should become a tracked ticket.

## CI

- **`tools/ingest/tests/` does not run in CI.** The "Ingest tooling (Python)" job
  runs only `ruff check . || true` and `pip-audit --strict || true` (both advisory,
  never fail the build); the `db-checks` job runs only `db/tests`. So the ingest
  parser tests — including `test_load_ttmik_transcript.py` — never gate CI. This is
  why 2 stale `test_classify_line_cases` were red locally while CI stayed green
  (both since fixed). Wire `pytest tools/ingest/tests` into CI. Note most ingest
  tests need `testcontainers[postgres]` + `structlog`/`psycopg`/`pypdf`; the
  transcript parser tests are pure and could run without a DB if scoped.

## Parser / loader (`load_ttmik_transcript.py`)

- **Reload idempotency footgun.** A parser bugfix silently no-ops on reload because
  `load_state` keys on the source PDF's sha256, which is unchanged. The corrective
  reload requires clearing the `load_state` rows for the Lesson Scripts PDFs (or a
  `--force`). Undocumented in the module docstring / `Deploy/` docs — document it.
- **English-label allow-list is corpus-specific.** `_LABEL_EXACT` (+ the
  `… tense` / `… marker` tails, single-letter slots, and English-hint rule) was
  ground-truthed from the current three Lesson Scripts PDFs. A future TTMIK lesson
  introducing a new bracketed English label not in the set would be over-stripped
  as romanization. If the corpus grows, re-derive the allow-list. (Noted in code.)
- **Resume-order / mid-crash gaps** (from `REVIEW_TR_PARSER.md` SHOULD-FIX-5/6):
  string-vs-tuple resume ordering and the sha-changed-mid-crash resume gap are
  unaddressed (never claimed fixed).

## Endpoint / reading (`reading.ts`)

- **Latent raw-`hosts` bug.** `reading.ts` types episode `hosts` as `string[]` but
  the column is a TEXT string ("A & B") — the same bug fixed in `ttmik.ts` via
  `splitHosts`. Currently latent (no client maps it). Fix with the same helper if a
  consumer is added.

## UI (`Ttmik.tsx` / `Reading.tsx`)

- **Stale trust-boundary comment** on `Tapword` (from `REVIEW_TR_UI.md`).
- **Tabpanel ARIA.** The Highlights/Transcript sub-tabs lack the
  `role="tablist"`/`tab`/`tabpanel` + arrow-key pattern (pre-existing elsewhere,
  repeated here). Accessibility polish.
