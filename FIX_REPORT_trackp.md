# FIX_REPORT — Track P fixpass

Branch `feat/track-p-comic-upload`, commit `5a6650f` (on top of `10932f5`). NOT pushed. 3 files changed, 12 ins / 7 del. No product-behavior change beyond label copy.

## Nit dispositions (5 total)

| # | Nit | Disposition |
|---|-----|-------------|
| Client NIT-1 | `TYPE_META.comic` label diverged from modal `TYPE_OPTIONS.comic` | **FIXED** — `client/src/pages/Uploads.tsx:79` now `{ en: 'Picture / Comic / Manga', kr: '만화 · 그림책' }`, byte-identical to `UploadTypeModal.tsx:78`; 1:1 convention restored for all 6 types. Aligned (option A), no comment route — pill width judged fine, consistency = established pattern |
| Client NIT-2 | `opensViewer?: true` + `=== true` | **LEFT** — reviewer-endorsed ("fine to leave"); untouched |
| Server NIT-1 | f-string SQL in `test_migration_072.py:146-148` | **FIXED** — now `sql.SQL("ALTER TYPE book_upload_type ADD VALUE IF NOT EXISTS {}").format(sql.Literal(NEW_VALUE))`; added `from psycopg import sql` import. Same statement executed, parameterized style |
| Server NIT-2 | `test_072_up_is_idempotent_on_reapply` docstring claimed runner-path chain re-up it never runs | **FIXED** — docstring (`db/tests/test_migration_072.py:141-145`) now: re-applies the ALTER directly → proves IF NOT EXISTS in isolation; notes runner-path re-up covered by `test_072_down_is_noop_and_reup_clean` |
| Server NIT-3 | `GRAMMAR_BEARING_TYPES: ReadonlySet<string>` → `<BookUploadType>` | **DEFERRED** — pre-existing, not Track P; explicitly out of scope per fix instructions. Follow-up candidate: type it `ReadonlySet<BookUploadType>` in `server/src/services/uploadExtract.ts:249` (compile-error on typo'd member) in a future hardening pass |

## Test assertion update (label)

`client/src/pages/Uploads.test.tsx:110,126` asserted old pill copy (`/Comic \/ Manga/` regex — would have STILL PASSED as substring of new label, but pinned old copy). Updated test name + assertion to `/Picture \/ Comic \/ Manga/` = aligned copy. No Korean-pill assertion existed (only title `만화 모험`, untouched).

## Gates

| Gate | Result |
|------|--------|
| `client npx tsc --noEmit` | exit 0 |
| `client npx eslint src` | exit 0 |
| `vitest run Uploads.test.tsx UploadTypeModal.test.tsx Reading.test.tsx` | 3 files / 86 tests, ALL PASS |
| `python -m py_compile db/tests/test_migration_072.py` | OK |
| `pytest db/tests/test_migration_072.py` in pinned python:3.12 container (Deploy/local-test.sh recipe, psycopg 3.2.3) | 3 passed in 11.01s — run because sql.Composed swaps the executed code path; not strictly required, chose to verify |

## Not touched

- `UploadTypeModal.tsx`, `Reading.tsx`, `Reading.test.tsx`, `UploadTypeModal.test.tsx`, all server src, migrations 072 SQL — zero diff
- All PRAISE items intact (enum-gotcha comment block, fresh-connection cast, `-잖아` discriminator, 040 comment fix, nav route-probe tests)
