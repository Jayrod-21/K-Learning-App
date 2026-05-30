# Database ADRs — index and numbering policy

Architecture Decision Records (ADRs) for the Korean Master database layer.

## Numbering policy

**ADR numbers are global and assigned chronologically.** Numbers are NEVER
recycled.

When two PRs collide on a number:

- The **earlier merge keeps its number.**
- The **later PR renumbers** before merging.

If you are adding a new ADR, claim the next free number by checking the file
list below. If your branch was opened before another ADR with the same number
landed, renumber your file (and update internal cross-references) before merge.

The original Phase A snapshot had three agents (A1 / A2 / A3) all writing
ADR-002…ADR-005 in parallel. That collision was resolved by renumbering A2's
ADRs to 005–008 and A3's ADRs to 009–012 (the fix-pass dated 2026-05-28).
ADR-013 (migration transaction ownership) was added by the fix-pass.

## Current ADRs

| # | Title | Owner |
|---|---|---|
| 001 | Database foundation choices | core |
| 002 | Auth and sessions | A1 (core schema) |
| 003 | FSRS storage | A1 (core schema) |
| 004 | Soft FK to corpus | A1 (core schema) |
| 005 | Stable columns vs JSONB | A2 (Darakwon corpora) |
| 006 | tsvector language configuration | A2 |
| 007 | Vocab relations hybrid target | A2 |
| 008 | `kgiu_entries` vs `grammar_entries` | A2 |
| 009 | Compose layout | A3 (harness) |
| 010 | Migration runner choice | A3 |
| 011 | Backup strategy | A3 |
| 012 | Postgres version pin | A3 |
| 013 | Migration transaction ownership | fix-pass |

## Process for new ADRs

1. Pick the next free number (currently `014` at time of writing — verify
   against `ls Repository/db/docs/ADR-*.md`).
2. Filename: `ADR-NNN-short-kebab-name.md`. The body's H1 must match
   (`# ADR-NNN: Human-readable title`).
3. Required sections: Status, Date, Context, Decision, Alternatives
   considered, Consequences.
4. Add a row to the table above.
5. Cross-references in SQL/Python/Markdown should use the **number** (e.g.
   "ADR-007") so a rename of the filename slug doesn't break references.

## Related

- `../README.md` — harness README
- `../SECURITY.md` — DB threat model
- `../migrations/README.md` — migrations index + per-migration notes
- `../migrations/SECURITY.md` — per-migration threat models
- `erd-darakwon.md` — entity-relationship diagram for migration 002
- `REVIEW_A1.md`, `REVIEW_A2.md`, `REVIEW_A3.md` — phase-A review reports
- `FIX_REPORT.md` — fix-pass disposition (2026-05-28)
