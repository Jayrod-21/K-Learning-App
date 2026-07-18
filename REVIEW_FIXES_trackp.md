# RE-REVIEW — Track P fixpass verification

Branch `feat/track-p-comic-upload`, fix commit `5a6650f` on top of `10932f5`. Independent re-reviewer — did not write, review, or fix this code. All claims verified against the actual tree, not the FIX_REPORT.

## VERDICT: PASS

The fix commit does exactly what FIX_REPORT_trackp.md claims — 3 files, 12 insertions / 7 deletions, nothing else touched. All three fixes verified in code, both left-alone nits confirmed untouched, all gates green, and the highest-value guard (the label test) empirically mutation-proven in both directions. No new issues. Working tree left clean.

---

## Finding-by-finding verification

### FIXED (3)

**1. Client NIT-1 — label alignment (`TYPE_META.comic`)** — VERIFIED.
`client/src/pages/Uploads.tsx:79` is now `comic: { en: 'Picture / Comic / Manga', kr: '만화 · 그림책' }`, byte-identical to `client/src/components/UploadTypeModal.tsx:78`. Checked all six pairs side by side (Uploads.tsx:74-79 vs UploadTypeModal.tsx:73-78): vocab, grammar, both, dialogue, literature, comic — every en/kr string byte-identical. The 1:1 convention now holds for the full set; comic is no longer the divergent pair, and the '만화' pill on a picture-book upload is gone.

**2. Server NIT-1 — f-string SQL** — VERIFIED, not weakened.
`db/tests/test_migration_072.py:149-153` now executes `sql.SQL("ALTER TYPE book_upload_type ADD VALUE IF NOT EXISTS {}").format(sql.Literal(NEW_VALUE))`; the `from psycopg import sql` import is present at line 34. Semantically the same statement (a `sql.Literal` of `'comic'` renders to the identical quoted literal), so the IF NOT EXISTS guard is exercised exactly as before — style fix only. `python3 -m py_compile` passes. FIX_REPORT additionally reports a full containerized `pytest` run of the file (3 passed) because the executed code path changed to `sql.Composed`; I did not re-run the testcontainer suite (per re-review scope) but confirmed the composed SQL is equivalent by inspection.

**3. Server NIT-2 — idempotency-test docstring** — VERIFIED, accurate now.
Docstring at `db/tests/test_migration_072.py:142-146` now says the test "re-appl[ies] 072's ALTER statement directly against the already-migrated DB … exercises the IF NOT EXISTS guard in isolation" and explicitly points to `test_072_down_is_noop_and_reup_clean` for the runner-path re-up. That matches the body exactly: `_full_up` once, hand-execute the ALTER on an autocommit connection, assert the enum value survives. The old false claim ("running the chain up when everything is already applied") is gone. Coverage unchanged — same statements execute; only prose changed. The runner-path claim is true: test 3 (lines 162-191) does `down --target 071` then `_full_up` again, re-running 072 against a DB where 'comic' persists.

### LEFT ALONE (2) — correctly untouched

**4. Client NIT-2 — `opensViewer?: true` + `=== true`** — CONFIRMED untouched.
`client/src/pages/Reading.tsx:315` still `opensViewer?: true;`, line 442 still `section.opensViewer === true ? openViewer : onOpenBook`. Original reviewer said "fine to leave"; it was left. Reading.tsx has zero diff in the fix commit.

**5. Server NIT-3 — `GRAMMAR_BEARING_TYPES: ReadonlySet<string>`** — CONFIRMED untouched, correctly deferred.
`server/src/services/uploadExtract.ts:249` still `const GRAMMAR_BEARING_TYPES: ReadonlySet<string> = new Set(['grammar', 'both'])`. Pre-existing typing, not a Track P regression; deferral is the right call and the FIX_REPORT records the follow-up.

### Test assertion update (companion to fix 1) — VERIFIED, and NOT a tautology

`client/src/pages/Uploads.test.tsx:110` (test name) and `:126` (assertion) updated to `/Picture \/ Comic \/ Manga/`. Critically, this assertion queries the rendered DOM of the Uploads page (`screen.getByText`), whose only source for that string is `TYPE_META` — it is not asserting against the same constant it renders. Proven empirically below.

---

## Mutation spot-check (both directions)

Chose the sharpest possible mutation: set `TYPE_META.comic.en` back to the OLD copy `'Comic / Manga'` — the one value the PRE-fix assertion (`/Comic \/ Manga/`, a substring match) would have silently accepted. Only a properly updated assertion can catch it.

- **Mutated** (`Uploads.tsx:79` en → `'Comic / Manga'`): `npx vitest run src/pages/Uploads.test.tsx` → **1 failed | 14 passed** — the exact label test fails at `Uploads.test.tsx:126` (`getByText(/Picture \/ Comic \/ Manga/)` finds nothing). The guard bites, and it specifically catches the regression the fix exists to prevent.
- **Restored** (`git checkout -- client/src/pages/Uploads.tsx`): `git status` clean, line 79 back to `'Picture / Comic / Manga'`; re-run → **15 passed (15)**.

Tree verified clean after restore (`git diff --stat` empty; only the pre-existing untracked review/report files remain).

---

## No-regression sweep (core Track P intact)

- Fix commit touches ONLY `Uploads.tsx`, `Uploads.test.tsx`, `test_migration_072.py` (`git show --stat 5a6650f`) — everything else is byte-identical to the reviewed `10932f5` by construction.
- Migration 072 up: still exactly one statement — `ALTER TYPE book_upload_type ADD VALUE IF NOT EXISTS 'comic';` — value-only, nothing rides along.
- `server/src/services/bookUploadIngest.ts:112-119`: `BOOK_UPLOAD_TYPES` still `['vocab','grammar','both','dialogue','literature','comic'] as const`.
- `GRAMMAR_BEARING_TYPES` still `{'grammar','both'}` — 'comic' absent, doc comment (lines 245-248) intact.
- Reading.tsx: comics section (`key: 'comics'`, `types: ['comic']`, `opensViewer: true`, lines 318-324) routes via the `=== true` ternary to `openViewer` → `/uploads/:id`; literature/dialogue/documents have no `opensViewer`, so their `?book=` flow is the unchanged `onOpenBook`. All 50 Reading tests pass.
- PRAISE items spot-checked intact: migration 072's enum-gotcha comment block, the fresh-connection cast (`test_migration_072.py:136-138`), the `-잖아` discriminator (`uploadExtract.test.ts`), the 040 enum-comment fix (`bookUploadIngest.ts:109-111`).

## Gates (all run by this re-reviewer)

| Gate | Result |
|------|--------|
| `client npx tsc --noEmit` | exit 0, zero output |
| `client npx eslint src` | exit 0, clean |
| `vitest run Uploads.test.tsx UploadTypeModal.test.tsx Reading.test.tsx` | 3 files, **86/86 passed** |
| `python3 -m py_compile db/tests/test_migration_072.py` | OK |
| Mutation check (label) | FAILS mutated (1/15), PASSES restored (15/15) |

## New issues

None found.

## Ship recommendation

**SHIP.** The fixpass is faithful, minimal, and verified: all three nits genuinely fixed without weakening any test, the two deferrals are correct, the label guard is empirically revert-proof against the exact regression it targets, and the Track P core (value-only migration, non-grammar-bearing classification, viewer routing) is untouched and green. Ready for PR against `rebuild` (do not push to main; Jared merges).
