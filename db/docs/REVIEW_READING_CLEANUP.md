# Review

**Scope:** Removal of the dead server `/reading` routes (orphaned after the Read tab
was folded into Listen/`/ttmik` in a prior PR). Branch `chore/remove-dead-reading-server`,
reviewed as uncommitted working-tree changes against `HEAD`
(`d982f2c chore(pwa): prompt-to-reload on new deploys`, an unrelated prior commit).

**Files touched (per `git status` / `git diff HEAD`):**
- Deleted (staged): `server/src/routes/reading.ts`, `server/tests/routes/reading.test.ts`
- Modified (unstaged): `server/src/app.ts`, `Deploy/nginx-blue-active.conf`,
  `Deploy/nginx-green-active.conf`, `client/src/components/BottomNav.tsx`

## Verdict

**APPROVE.** The removal is safe and functionally complete. Nothing in `server/src`,
`server/tests`, or `client/src` still imports or calls the deleted route, both nginx
configs were edited identically and correctly (regex intact, no adjacent alternatives
mangled, both occurrences in both files updated), and no data (the shared
`ttmik_*`/`iyagi_*`/`*_sentences` tables or their migrations) was touched.

**Blocker count: 0.** Two SHOULD-FIX items are pure stale-documentation drift (a code
comment and a backlog "Key files" pointer) — neither affects build, runtime, or the
API surface. Nothing still depends on `/reading` at runtime.

## Findings

### BLOCKER
None.

### SHOULD-FIX
1. **Stale doc comment claims the deleted route still exists** —
   `server/src/routes/ttmik.ts:31-32` says the TTMIK/Iyagi list endpoints are
   deliberately unpaginated because "the paginated generic browser remains at
   GET /reading/units." That route no longer exists after this diff; the comment
   should be updated or the parenthetical dropped so the next engineer doesn't go
   looking for a route that 404s.
2. **`BUGS_AND_FEATURES.md:91` (B-001) points at two now-deleted files** —
   `server/src/routes/reading.ts:107-127` and `client/src/pages/Reading.tsx:140,182-196`
   are both gone (the latter deleted in the prior Read→Listen consolidation PR, the
   former in this one). The backlog item itself may still be conceptually valid
   (word-list vs. prose passages) against whatever surface replaced it, but the
   "Key files" pointer is now dead and will send whoever picks up B-001 to files that
   don't exist. Update the pointer to the current equivalent (or close/re-scope B-001
   if the Read-tab consolidation already superseded it).

### NIT
1. Two pre-existing review artifacts (`db/docs/REVIEW_TR_ENDPOINT.md:157-170`,
   `db/docs/REVIEW_TR_FIXES.md:6,139-140`) cite line numbers in the now-deleted
   `reading.ts`. These are historical, append-only review logs of past work, not
   living documentation of current state — no action needed, flagging only so it's
   not mistaken for a missed reference during a future search.

### PRAISE
1. The nginx regex edit is exactly right in both files, both occurrences: `reading`
   was removed from the alternation (`...krdict|conversation|progress...`) without
   disturbing the neighboring `krdict|conversation` / `progress|vocab` alternatives —
   easy to get wrong with a careless regex edit, done cleanly here.
2. `client/src/components/BottomNav.tsx:92` doc-comment fix is a nice touch — most
   PRs would leave the stale `/reading/abc-123` example in place.
3. The change is scoped tightly to the HTTP route layer. The DB tables the deleted
   routes read (`ttmik_lessons`, `iyagi_episodes`, `*_sentences`) are untouched — no
   migration, no data-layer change — correctly leaving the Listen tab's shared data
   path alone.

## Detailed (file:line)

- `server/src/app.ts:28` (import) and `:81` (mount) — both `readingRoutes` references
  cleanly removed; no other file in `server/src` imports from `./routes/reading.js`
  (confirmed via repo-wide grep, node_modules and unrelated `.claude/worktrees/`
  scratch dirs excluded).
- `server/src/routes/reading.ts` (deleted) — the router mounted `requireAuth` at
  line 16 of the pre-deletion file (`git show HEAD:server/src/routes/reading.ts`),
  confirming the prompt's premise: before this change `/reading` hit the API and
  401'd; after, it falls through to nginx's SPA `location /` and is served
  `index.html`, letting the client-side `<Route path="reading" element={<Navigate
  to="/ttmik" replace />}>` in `client/src/App.tsx:87-90` run. That redirect route
  and the `/reading` deep-links that trigger it (`client/src/pages/Today.tsx:167-168`,
  nav tiles) are unaffected by this diff and were already in place from the prior
  Read→Listen consolidation — confirmed intact and consistent with the new
  nginx behavior.
- `Deploy/nginx-blue-active.conf:82,129` and `Deploy/nginx-green-active.conf:82,129`
  — both API-route allow-list regexes in both files updated identically; `reading`
  removed, all 15 other alternatives (`auth|health|define|enrich|lemmatize|krdict|
  conversation|progress|vocab|grammar-drill|grammar|diagnostic|topik|hanja|images|
  plan|settings|grade-writing|ttmik|iyagi`) preserved verbatim and correctly ordered.
  Grep confirms zero remaining occurrences of `reading` in either conf file.
- `client/src/components/BottomNav.tsx:92` — doc comment updated from the stale
  `/reading/abc-123` → "Reading" example to `/ttmik/lessons/1/1` → "Listen",
  matching current nav reality.
- No orphaned server types (`ReadingSentenceRow`, `ReadingUnit`) found — grep across
  `server/src`, `server/tests`, `client/src` for those identifiers returns nothing;
  the only `UnitRow` in the codebase is a distinct, unrelated local interface in
  `server/src/routes/ttmik.ts:100`.
- No orphaned client artifacts — `find client/src -iname "*reading*"` returns
  nothing; the client `reading` service/mocks were fully removed in the prior PR
  that folded Read into Listen, as the task description states.
- All other `reading` hits across `server/src`, `server/tests`, `client/src` (e.g.
  `progress.reading_score`, `topik` section enum `'reading'`, diagnostic dimension
  `reading`, `Today.tsx` task tag `'Reading'`) are the pre-existing domain
  vocabulary (a TOPIK skill/section name), unrelated to the deleted HTTP route —
  correctly left alone.
- `server/src/routes/ttmik.ts:31-32` — SHOULD-FIX, see above.
- `BUGS_AND_FEATURES.md:91` — SHOULD-FIX, see above.
- Data layer: no `db/migrations/*` files appear in `git status`/`git diff` for this
  change; the shared `ttmik_lessons`/`iyagi_episodes`/`ttmik_sentences`/
  `iyagi_sentences` tables the deleted routes read are untouched, confirming the
  change is HTTP-route-layer-only as intended.
- `tsc`/lint: no Node/npm toolchain was available in this review's shell
  (`node`/`npm`/`npx` not on `PATH`) to independently re-run the compiler, so this
  review relies on the reported clean `tsc`+lint run plus manual verification that
  no file still imports from `./routes/reading.js` or references a type/symbol that
  only `reading.ts` defined — both confirmed clean by grep.
