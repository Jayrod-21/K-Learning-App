# REVIEW — F-002 item-selection + generator + client slice (commit 0111373)

Reviewer: independent senior review. Scope: `server/src/routes/diagnostic.ts`
(pickTopikRow + buildTopikItem), `server/src/services/claude/models.ts`,
`server/src/services/claude/prompts/diagnostic_item.ts`, server route tests +
seed helper, client types/mocks/tests. Design: `db/docs/DESIGN_F002.md`.

Verified against the LIVE km-db corpus (read-only queries) and by running both
test suites in Docker:

- server `tests/routes/diagnostic.test.ts`: **41/41 passed**
- client `Diagnostic.test.tsx` + `SkillsCompare.test.tsx`: **passed** (exit 0)
- live corpus: answerable topik_items = **776 TOPIK I / 1164 TOPIK II, ALL with
  NULL proficiency**; vocab_entries = 1716 `basic` + 1475 `L3` (zero L1/L2);
  kgiu_entries = 114 `basic` + 180 L3–L5+ (zero L1/L2)

## Verdict: **BLOCK — 1 blocker, 2 should-fix**

The reading/listening payoff is real: at L1/L2 the band-targeted attempt
genuinely filters `topik_tests.topik_level = 'TOPIK I'` and serves the 776
answerable beginner items, with a correct fall-through to "any" when the pool
is exhausted, and no regression to L3+ behavior. But the generator half of the
feature is only half-wired: the design's stated L1/L2 seed source (the
`basic`-tagged vocab/kgiu pools) is provably never selected — at L1/L2 the
seed picker's targeted attempt matches zero rows and always falls back to a
uniformly random seed of ANY level.

---

## BLOCKER

### B-1 — L1/L2 generated items are NOT seeded from the beginner pool; the targeted seed attempt provably matches zero rows

`server/src/routes/diagnostic.ts:359-381` (`pickVocabSeed`) and `:384-412`
(`pickGrammarSeed`) filter attempt 1 as
`proficiency = $1::proficiency_level` with the raw target (`'L1'`/`'L2'`).
Migration 039 adds the enum values **with no backfill**, and the live corpus
confirms zero rows are tagged L1/L2 (vocab: 1716 `basic` + 1475 `L3`; kgiu:
114 `basic` + 66/37/77 L3/L4/L5+). So for every L1/L2 vocab/grammar slot,
attempt 1 is an always-empty query and the seed comes from attempt 2 — a
uniform random row across the WHOLE corpus (~46% chance of an L3-tagged word
for vocab, ~39% chance of an L3–L5+ pattern for grammar).

Consequences:

- DESIGN_F002.md:48-50 explicitly names the seed pools: "`basic`-tagged vocab
  (1716 rows) + `basic` kgiu (114) are the L1/L2 seed source (already handled
  by `targetLevelForTheta` picking the seed band)". That parenthetical is a
  false premise — `targetLevelForTheta` now returns `'L1'`/`'L2'` (identity
  over `bandForTheta`, cat.ts:93-95), which never matches `'basic'`-tagged
  rows. Nothing maps L1/L2 → `basic` anywhere.
- The item is recorded at `difficulty = proficiencyToNumber(target)` = 1 or 2
  (diagnostic.ts:531) while the seed may be an intermediate word/pattern. The
  prompt then gets contradictory instructions ("test the seed at the target
  band" + "a beginner band must stay genuinely beginner-level") for a seed
  that has no beginner-level treatment. Measurement validity of the vocab and
  grammar dimensions — 2 of the 4 the commit claims target L1/L2 — is
  degraded at exactly the levels F-002 adds.
- The route test masks this: the low-ability run (diagnostic.test.ts:1086+)
  seeds only L4/L3 vocab/kgiu, so the fallback silently supplies the seed and
  the test still passes. No test asserts an L1/L2 slot seeds from `basic`.

Fix (small): in `pickVocabSeed`/`pickGrammarSeed`, map the beginner targets to
the content tag — e.g. attempts `[target === 'L1' || target === 'L2' ?
'basic' : target, null]` — mirroring exactly what `pickTopikRow` does for the
topik pool, and add a test seeding a `basic` + an `L3` row asserting the L1
slot picks the `basic` seed.

---

## SHOULD-FIX

### SF-1 — Live snapshots still ship only L3+ reference lines; the L1/L2 "TOPIK 1 / TOPIK 2" ladder exists only in client mocks

The client fixtures (`client/src/data/mocks/diagnostic.ts:28-33,101-106`) and
the widened `DiagnosticReference['id']` union (domain.ts:345) add
`{ id: 'L1', label: 'TOPIK 1', value: 10 }` / `{ id: 'L2', … value: 25 }`,
and both new client tests assert them — but ONLY against fixtures and
hand-built snapshots. The server's `REFERENCES` const
(`server/src/routes/diagnostic.ts:722-728`) was not touched: live responses
from `/latest`, `/history`, `/finish` still carry `L3…native` only. A real
beginner scoring 10/25 renders bars far below the lowest labeled rung
(TOPIK 3 = 40) with no TOPIK 1/2 line to compare against — the exact thing
DESIGN_F002.md:60-61 asked for ("Wherever the … reference line renders a
level label, ensure L1/L2 render"). Side effects: the comment on
`emptySnapshot()` (diagnostic.ts:737-738, "Matches the client's
DIAGNOSTIC_SNAPSHOT_FIXTURE") is now false (fixture has 7 refs, server 5),
mock mode and live mode visibly diverge, and the client tests give false
confidence that beginners see the ladder. Fix: add the L1/L2 entries (values
10/25, matching `estimateToScore`'s anchors) to the server `REFERENCES` and
assert them in a route test.

### SF-2 — Higher bands: attempt 1 never matches in production, so L3/L4/L5+ users draw ~40% TOPIK I items from the "any" fallback

Live corpus: **all** 1,940 answerable topik_items have NULL `proficiency`, so
the L3/L4/L5+ band-targeted attempt (`i.proficiency = $n`,
diagnostic.ts:240-243) matches zero rows in production and every intermediate/
advanced reading/listening pick is served from "any" — a pool that is 40%
TOPIK I beginner items, each recorded at `difficulty = band` (3/4/5.5) via the
NULL-proficiency fallback in buildTopikItem (diagnostic.ts:297-300). This is
pre-existing (not an F-002 regression), but F-002 makes it asymmetric —
beginners now get targeted content while advanced users get diluted,
mis-scored difficulty — and the design flagged the symmetric fix as "do it
symmetrically if cheap" (DESIGN_F002.md:42). It IS cheap: give L3+ bands the
attempt list `[{proficiency: band, topikLevel: 'TOPIK II'}, {proficiency:
null, topikLevel: 'TOPIK II'}, {proficiency: null, topikLevel: null}]` or
similar. Related test-realism gap: `seedFullPool`
(diagnostic.test.ts:68-80) and the F-002 fallback test seed L4-**tagged**
topik rows — a corpus shape that does not exist in prod — so the higher-band
attempt-1 path is only ever exercised against synthetic tags (violates the
project's "test with REAL corpus data" rule; the F-002 TOPIK I row, correctly,
was seeded untagged).

---

## NIT

### N-1 — enrich/recognize prompts still enumerate the old proficiency set while the schema accepts the new one

`ProficiencyLevelSchema` (models.ts:37) now accepts `'L1'|'L2'`, and it is the
OUTPUT validator for `EnrichmentResultSchema.proficiency` (models.ts:94) and
`PatternResultSchema.proficiency` (models.ts:134) — but those routes' prompts
still tell the model `proficiency: "basic" | "L3" | "L4" | "L5+"`
(prompts/enrich.ts:34,43; prompts/recognize_grammar.ts:35,45). Additive-safe
today (schema superset of prompt), and migration 039 means the DB would accept
L1/L2 anyway, but the intent — should content tagging ever emit L1/L2? —
should be pinned in a comment or the prompts updated deliberately, or a future
prompt edit will start minting L1/L2 content tags silently.

### N-2 — `'TOPIK I'` is a bare magic string in pickTopikRow

diagnostic.ts:216 embeds `'TOPIK I'` inline (the column is TEXT with a CHECK
`IN ('TOPIK I','TOPIK II')`, migration 005:317,341 — so a typo would fail
silently as an always-empty filter, exactly the B-1 failure mode). A named
constant shared with the seed helper's `topikLevel?: 'TOPIK I' | 'TOPIK II'`
union would make it grep-able and typo-proof. The comparison itself is fine:
parameterized, text-typed, and the JOIN/exclusion/answerable guard apply to
both attempts identically.

---

## PRAISE (verified, not vacuous)

- **pickTopikRow L1/L2 targeting is correct and proven.** The SQL is
  parameterized throughout ($n placeholders, no interpolation), the answerable
  guard (≥2 options, non-null answer, no bare ①②③④ glyphs) lives in the base
  SQL so it applies to BOTH attempts, and the fall-through returns a TOPIK II
  row rather than null/500 when TOPIK I is exhausted. The route test
  (diagnostic.test.ts:1152+) is deterministic despite `ORDER BY random()` —
  ordinal 5 can only be the single TOPIK I row, ordinals 9/13 can only be
  fallback TOPIK II — and it seeds the TOPIK I row **untagged**, the real
  corpus shape. θ math checks out: all-skip staircase 4.0→3.0→2.1→1.3→1.0
  puts reading slots 5/9/13 at band L1 exactly as the comments claim.
- **Backward-compat is genuinely tested.** The v1.1.0 snapshot test
  (diagnostic.test.ts:1195+) rebuilds the stored band verbatim (66/63/70),
  degrades a statless dimension to zero-width, and exercises both `/latest`
  and `/history`; `dimensionStatsFromEvidence` was untouched, and `THETA_MIN
  = 1.0` stays inside the `BETWEEN 0 AND 6` CHECK (migration 014:89).
- **The prompt reframe kept the output contract intact.** Rules 1–2 (JSON-only,
  exact shape) survive; `DiagnosticItemResultSchema` and `parseJsonContent`
  are unchanged, so grading/shuffling/kind-enforcement downstream are
  unaffected. The L1–L5+ anchor line plus "do not write above the band" is a
  real improvement over the old TOPIK II-only framing.
- **seedTopikItem's `topikLevel` option is correct per migration 029**: both
  the reuse-SELECT and the INSERT now key on (test_number, topik_level,
  section) — the true natural key — so a pinned testNumber can coexist across
  papers without a unique-violation.
- **Client is data-driven end to end**: the level pill renders `{item.level}`
  raw (Diagnostic.tsx:745) and SkillsCompare maps `references` from props —
  no hardcoded level set anywhere that could omit L1/L2 — and the new tests
  assert 'L1'/'L2' pills and 'TOPIK 1'/'TOPIK 2' radios actually render, with
  the literals typed against the widened unions so a regression fails at
  compile time. The client's `DiagnosticLevel` values match the server's
  emitted band tokens exactly.

## Bottom line

Reading/listening genuinely serve beginner TOPIK I content at L1/L2 (verified
against the live 776-item pool, with sound exhaustion fallback and no L3+
regression). Vocab/grammar reach the beginner band only via the prompt's band
instruction — their design-mandated `basic` seed pool is dead code at L1/L2
(B-1) — and live-mode results lack the TOPIK 1/2 reference ladder the mocks
promise (SF-1). Fix B-1 (+SF-1) before merge; both are small.
