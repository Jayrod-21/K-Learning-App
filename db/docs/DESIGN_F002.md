# F-002 — TOPIK Level 1 & 2 in the diagnostic (locked design)

Adds L1/L2 resolution to the diagnostic. Scout verdict: code-only, content already exists
(`topik_level='TOPIK I'` = ~776 answerable beginner reading/listening items; vocab/grammar
Claude-gen can target L1/L2). Scope = scout options **(a)+(b)** — all 4 dimensions target L1/L2.
θ staircase seed stays 4.0 (the seed-bias is a known separate limitation; the F-011 confidence
band correctly shows LOW confidence for beginners — the right interim behavior).

## The ladder change
Today the diagnostic outputs `basic/L3/L4/L5+` (θ<2.5 collapses to `basic`). F-002 **splits the
below-L3 range into L1 + L2** so a beginner gets a real placement. `basic` stays in the
`proficiency_level` enum (content in `vocab_entries`/`kgiu_entries` is tagged `basic`; don't
disturb it) — L1/L2 are added as new enum members + new DIAGNOSTIC output bands.

## Backend

### Migration (next number)
- `ALTER TYPE proficiency_level ADD VALUE 'L1' BEFORE 'L3'; ADD VALUE 'L2' BEFORE 'L3';` (Postgres
  ADD VALUE is not transactional with other DDL — put each in its own statement per pg rules;
  ADD VALUE IF NOT EXISTS). Down migration: enum values can't be dropped in pg — document the
  down as a no-op with a comment (the new values are inert if unused). No data backfill.

### `server/src/services/diagnostic/cat.ts`
- `proficiencyToNumber`: add `L1 = 1`, `L2 = 2` cases (exhaustiveness `_never` will force it).
  (Keep `basic = 2` — it's a content tag, rarely the diagnostic band now.)
- `THETA_MIN = 2.0 → 1.0` so θ can descend to L1 territory. `THETA_MAX` unchanged (6.0). SEED 4.0 unchanged.
- `bandForTheta`: new cut points across 5 bands — `θ<1.5 → 'L1'`, `1.5–2.5 → 'L2'`, `2.5–3.5 → 'L3'`,
  `3.5–4.75 → 'L4'`, `≥4.75 → 'L5+'`. (Replaces the `<2.5 → 'basic'` collapse; `basic` is no longer emitted as a band.)
- `targetLevelForTheta` (the level handed to the generator): low θ → `'L1'`/`'L2'` per the same cuts.

### `server/src/services/diagnostic/scoring.ts`
- `estimateToScore`: add low anchors so L1/L2 scores are ANCHORED, not extrapolated. New anchor
  table: `{1→10, 2→25, 3→40, 4→55, 5→70, 6→85, 7→100}` (adds 1→10, 2→25). Keep clamp [0,100].
- `clampEstimate`: floor stays 1 (estimate 1 = lowest, maps to score 10 = L1). Ceiling 6.
- `RUBRIC_VERSION 'v1.1.0' → 'v1.2.0'` (the 0–6 band semantics changed; F-010 history must compare like versions).
- The F-011 Agresti-Coull band is generic — no change; verify it behaves at low estimates.

### `server/src/routes/diagnostic.ts` — `pickTopikRow`
- When the target band is `'L1'` or `'L2'`, add a `t.topik_level = 'TOPIK I'` preference to the
  band-targeted attempt (mirroring the existing 2-attempt band→any fallback), so beginners get the
  ~776 TOPIK I reading/listening items; fall through to "any" when short. Keep the answerable guard.
  (Higher bands may optionally prefer `TOPIK II` — do it symmetrically if cheap, else leave.)

### Generator — `server/src/services/claude/models.ts` + `prompts/diagnostic_item.ts`
- `DiagnosticTargetLevelSchema`: widen `z.enum(['L3','L4','L5+'])` → include `'L1','L2'`.
- `prompts/diagnostic_item.ts`: the system prompt hardcodes "TOPIK II item writer" + only L3–L5+
  anchors. Reframe so it writes at the requested level INCLUDING TOPIK I (L1/L2); add anchor
  language: `L1 ≈ TOPIK 1, L2 ≈ TOPIK 2, L3 ≈ TOPIK 3, L4 ≈ TOPIK 4, L5+ ≈ TOPIK 5–6`. Seed pools:
  `basic`-tagged vocab (1716 rows) + `basic` kgiu (114) are the L1/L2 seed source (already handled
  by `targetLevelForTheta` picking the seed band).

### Tests (server)
- cat: `bandForTheta` new cuts (L1/L2/L3/L4/L5+ at representative θ), `proficiencyToNumber` L1/L2,
  θ reaches 1.0. scoring: `estimateToScore` low anchors (1→10, 2→25, monotonic, bounds), band still
  sane at low estimate, RUBRIC_VERSION. diagnostic route: a low-ability run resolves L1/L2 (not
  collapsed to basic); pickTopikRow prefers TOPIK I for L1/L2 + falls back; old v1.1.0 snapshots still load.

## Client
- Add L1/L2 to the level label maps + the diagnostic mock fixture (`client/src/data/mocks/diagnostic.ts`
  hardcodes L3='TOPIK 3'…): `L1='TOPIK 1'`, `L2='TOPIK 2'`. Wherever the ResultsBlock / SkillsCompare
  / reference line renders a level label, ensure L1/L2 render. Tests assert L1/L2 labels render.

## Non-goals
- Lowering SEED_THETA / fixing the middle-bias (separate future work; the confidence band handles it honestly).
- Backfilling real `topik_items.proficiency` (option c — not needed; `topik_level` is the proxy).
