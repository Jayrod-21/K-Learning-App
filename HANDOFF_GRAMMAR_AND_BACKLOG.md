# Korean Master — Grammar fixes + app backlog (handoff)

Work package for the next implementer (Fable). Everything below was found by
testing the app live on **M** with the KGIU grammar corpus loaded (294 entries /
285 patterns). The stack is up on `:1840` (blue/green Docker); Postgres is
`km-db` (`psql -U korean_master -d korean_master`). Two PRs are already open for
review (see §6). Frontend is `client/` (React+Vite+TS), backend `server/`
(Node/Express+TS), DB migrations `db/migrations/`, corpus loaders `tools/ingest/`.

---

## 1. Grammar bugs (found live)

### 1.1 "Bank" fails — `Couldn't bank that pattern` (HTTP 400 validation_error)
**Symptom:** clicking **Bank** on any List-tab pattern returns 400. Server log:
`code":"validation_error","status":400,"message":"invalid request body`.

**Root cause (confirm, then fix):** the client body from `client/src/pages/Grammar.tsx`
does not satisfy `BankBodySchema` in `server/src/routes/grammar.ts` (~lines 110-127).
The schema **requires** `category` (min 1), `summary_en` (min 1), and constrains
`register` to a **fixed enum**: `['반말','해요체','합쇼체','문어체','하오체','하게체']`.
The loaded KGIU data has:
- `register` **composite/compound** values (e.g. `해요체/합쇼체`, `문어체/구어체`) — migration
  002 explicitly notes this. A composite register is NOT in the enum → 400.
- some rows with **empty `category`** → fails `category` min 1.
- `summary_en` must be non-empty — check the client is sending it (maps from
  `title_en`/explanation) and that it isn't empty for some rows.

**Fix direction:** on the client, sanitize the bank body before POST — drop
`register` when it isn't one of the six allowed values (it's optional), and
default `category`/`summary_en` to a safe non-empty fallback (e.g. `category`
→ `'uncategorized'`, `summary_en` → `title_en`) — OR relax the server schema to
accept composite registers + optional/empty category. Prefer the client-sanitize
+ a small server tolerance. Add a test that banks a pattern whose `register` is
composite and whose `category` is empty (both currently 400).
- Client: `client/src/pages/Grammar.tsx` (bank onClick / body builder), `client/src/lib/grammarKey.ts` (pattern_key is already correct — leave it).
- Server: `server/src/routes/grammar.ts` `BankBodySchema` + `POST /grammar/bank`.

### 1.2 `claude_route` enum missing `generate_grammar_drill` (migration gap)
**Symptom:** drill still returns, but server logs repeatedly show
`invalid input value for enum claude_route: "generate_grammar_drill"` →
`claude cache write failed` + `claude_usage insert failed`. Effect: **no drill
caching (every drill is a full paid Claude call)** and **no cost/usage tracking**.

**Root cause:** `claude_route` enum (migration `004_claude_cache_and_usage.up.sql`)
= `{enrich, recognize_grammar, grade_writing, generate_conversation}`. The grammar
drill code uses route(s) `generate_grammar_drill` (and likely a grade route for
submit) that were **never added to the enum**.

**Fix:** new forward migration `ALTER TYPE claude_route ADD VALUE 'generate_grammar_drill';`
(+ any grade route the submit path uses — grep `server/src/routes/grammarDrill.ts`
and `server/src/services/*` for the route strings passed to the claude module).
Note: on Postgres 16 `ADD VALUE` runs fine inside the runner's per-migration
transaction as long as the new value is not *used* in the same migration (it isn't
— we only add it), so no special handling vs ADR-013. Verify against
`db/migrate.py` before writing.

### 1.3 Drill always produces the SAME pattern (`N이다`)
**Symptom:** the Drill tab keeps drilling the first pattern (`N이다`) with
different situations, never advancing to other patterns.

**Root cause (investigate):** the client Drill tab pattern selection in
`client/src/pages/Grammar.tsx` isn't rotating — likely it always picks the first
banked/due pattern (and nothing is banked yet, so it may fall back to a fixed
default), or Skip/Next doesn't re-select. Cross-check with server `/grammar-drill`
(`server/src/routes/grammarDrill.ts`) for how the pattern is chosen. Expected
behavior: Skip/Next should advance through the user's banked patterns (once
banking works — see 1.1), or through a shuffled draw of KGIU patterns.

---

## 2. Grammar UI features (requested live)

### 2.1 Level filter on the List tab (beginner / intermediate / advanced)
Add filter buttons/segmented control. The list endpoint `GET /grammar/kgiu`
already accepts a corpus/proficiency filter param (see `server/src/routes/grammar.ts`
~lines 43-67, the `$2`/`$3` bind) — wire the client to pass `corpus=kgiu_beginner|
kgiu_intermediate|kgiu_advanced`. Also confirm the List tab loads **all** patterns
(285): the endpoint default LIMIT is 400 so it should, but verify the client isn't
capping/paginating to a smaller page. Corpus values: `kgiu_beginner`,
`kgiu_intermediate`, `kgiu_advanced`; book levels: beginner/intermediate/advanced.

### 2.2 "Graduate / known" state with re-admit
Let the user mark a pattern they're comfortable with as **known/mastered** so it
leaves active learning, with a way to **re-admit** it to review. Design:
- The FSRS card states are `new/learning/review/relearning` (`vocab_cards`) — there
  is no "known/suspended" state today. Add a suspend/known flag (e.g. a
  `suspended_at`/`known` column on the banked grammar row `grammar_entries`, or a
  card state), a **Graduate** action in the UI, and a **Re-admit** action (from a
  "Known" list/tab). Migration + server endpoint + client UI + test.
- Keep it consistent with how banked grammar feeds the Review screen's due cards.

---

## 3. TOPIK UX backlog (from earlier live test — see memory `project-korean-master-ux-polish`)
- **Answerable questions / show images:** 145 TOPIK items are `has_image=true` but
  only carry a **text description** (no image asset stored). Either surface the
  image (requires extracting/storing image assets from the source PDFs — new
  ingest work) or ensure image-dependent items are answerable/skipped.
- **Wrong-answer explanation:** Study mode shows only "NOT QUITE" with no
  explanation, though the API returns `explanation`. Fix `client/src/pages/Topik.tsx`
  (StudyMode reveal) to render it.
- **Mock timer:** `client/src/pages/topik/MockMode.tsx` — countdown freezes after
  one tick (starts 1:10, stops at 1:09) and the units are wrong (Reading ~70 min /
  Listening ~60 min should read `70:00` mm:ss or `1:10:00`). Fix the tick loop +
  formatting.

---

## 4. Data + loaders remaining
- **Vocab (2000 Essential Korean Words):** `vocab_entries` is still EMPTY → the
  `/review` Vocab surface has no corpus. OCR it copyright-safe (own facts +
  generated examples, like grammar) → `vocab_2000_<level>.json` → `load_vocab_2000`.
  A ready OCR-prompt approach is in `~/.claude/jobs/.../grammar_ocr_prompt.txt`
  (adapt for vocab / playbook Part 2B).
- **Loader hardening (systemic):** `load_topik.py` (done, PR #8) and `load_kgiu.py`
  (done, PR #9) had a silent-partial-load bug (count mismatch → warn + mark
  complete). The SAME pattern still exists in `load_vocab_2000.py`, `load_ttmik.py`,
  `load_iyagi.py` — apply the same `CountAssertionError`-raises fix before/when
  loading vocab.

## 5. Known feature gaps (from feature-surface audit)
- **Vocab FSRS scheduler is a STUB** — the biggest gap. `client/src/pages/Review.tsx`
  hardcodes `scheduled_days_after: 0`, so rated vocab cards return **due
  immediately**; the interval labels are cosmetic. Grammar's scheduler
  (`server/src/services/grammarScheduler.ts`) is real — port that math to the vocab
  submit path (`POST /vocab/cards/:cardId/reviews`).
- **TOPIK Writing mock section** is intentionally deferred (FU-NF-47) — the writing
  items are now loaded, so it's unblocked whenever wanted.

## 6. Repo / PR state
- **PR #8** (`topik-corpus-load-fixes` → `rebuild`): TOPIK corpus-load fixes. Open, awaiting merge (Jared merges).
- **PR #9** (`grammar-loader-hardening` → `rebuild`): KGIU loader hardening. Open, awaiting merge.
- Integration branch is **`rebuild`** (not `main`). New work branches off `rebuild`; open PRs into `rebuild`; Jared merges on GitHub. Push via **SSH** (`git@github.com:Jayrod-21/K-Learning-App.git`). **No `Co-Authored-By` trailer.** Never commit corpus data (`tools/ingest/output/` + `output.*` are gitignored — PR #8 hardens this; branches off current `rebuild` may still lack it, so `git add` explicit files, never `-A`).

## 7. How to work
- **Stack:** `docker ps` shows `km-lb/db/backup` + `km-*-blue`. Prod at `http://localhost:1840` (and `korean.jaredstudio.com` via Cloudflare). App is behind login + MFA (single user).
- **Server logs:** `docker logs -f km-server-blue`.
- **DB:** `docker exec -i km-db psql -U korean_master -d korean_master`.
- **Client/server tests:** see `TESTS.md` / `.github/workflows/ci.yml`. Loader tests run in Testcontainers (real Postgres 16) — pattern:
  `docker run --rm --network host -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD":/repo -w /repo -e PYTHONPATH=/repo/tools/ingest python:3.12 sh -ec 'pip install -q "psycopg[binary]==3.2.3" "psycopg-pool>=3.2,<4" "pydantic>=2,<3" "structlog==24.4.0" "testcontainers[postgres]>=4,<5" "pytest>=8,<10" && python -m pytest tools/ingest/tests/<file> -q'`
- **Quality bar:** `/home/jared-williams/projects/SENIOR_ENGINEER_BAR.md`. ADRs in `db/docs/`.
- **Migrations:** runner is `db/migrate.py` (each migration in its own tx, ADR-013; up-body is checksummed — never edit an applied migration, add a new one). Apply on M via `DEPLOY_TAG=local bash -c 'source Deploy/deployment-utils.sh; load_environment; export DEPLOY_TAG=local; run_migrate up'`.
