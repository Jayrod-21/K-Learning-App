# Review: grammar-ui — migrations + server

**Reviewer:** Independent senior reviewer (did not author this code)
**Branch:** `grammar-ui-fixes` vs `rebuild`
**Scope:** migrations 031/032/033 (up + down), `server/src/routes/grammar.ts`
(bank body, graduate/readmit, GET /bank), `server/src/routes/vocab.ts`
(due-exclusion), and the graduation server tests.
**Date:** 2026-07-02

## Summary verdict

**PASS WITH CONDITIONS.**

The graduation feature (migration 033 + the graduate/readmit/due-exclusion code)
is well-engineered, senior-grade, and thoroughly tested — I would approve it as
written. The two enum-alignment migrations (031/032) are *mostly* correct, but
**032 permanently adds a `claude_route` value (`anon`) that is NOT a `RouteName`**,
based on a misreading of the code. That directly defeats 032's own stated goal
("makes the enum mirror RouteName exactly") and would break the drift-guard test
the migration itself recommends. Because `ALTER TYPE … ADD VALUE` is irreversible
(the down is a documented no-op), this must be corrected **before the migration
is applied to any shared environment**. It is runtime-harmless (nothing ever
writes `route = 'anon'`), so it is a strong SHOULD-FIX rather than a BLOCKER.

Conditions to clear before merge/apply:
1. Remove `ALTER TYPE claude_route ADD VALUE … 'anon'` from 032 (and its comment).
2. Resolve the 030 numbering gap with the incoming PR (out-of-order-apply hazard).

Zero BLOCKERs. Two SHOULD-FIX, three NIT, four PRAISE.

## Bar checklist (relevant items)

| Bar item | Verdict | Note |
|---|---|---|
| §4.1 `timestamptz` for point-in-time cols | PASS | `graduated_at TIMESTAMPTZ`; test asserts `timestamp with time zone` |
| §4.1 nullable/additive, deliberate NULL semantics | PASS | NULL = active; no backfill; documented |
| §4.3 audit/lifecycle, soft-delete respected | PASS | all reads/writes carry `deleted_at IS NULL` |
| §4.4 indexing — no-index decision justified | PASS | 033 comment names the index it would lose to; per-user rows are few |
| §4.5 tested downgrade, no edit-in-place | PASS | reversible `DROP COLUMN`; enum downs no-op (correct) |
| §4.5 expand→migrate→contract / online-safe | PASS | 033 is pure additive nullable column; 031/032 ADD VALUE only |
| ADR-013 no top-level tx control in body | PASS | no BEGIN/COMMIT in any of the 6 files |
| §4.7 / §3.5 parameterized queries, no interpolation of input | PASS | id/userId always bound; the one `${…}` fragment is a fixed literal (see NIT-1) |
| §3.4 object-level authz (BOLA/IDOR) | PASS | ownership enforced in UPDATE `user_id = $2` → foreign row 404s |
| §0 idempotency where a partial run doubles an effect | PASS | graduate = `COALESCE(graduated_at, now())`; readmit = NULL |
| ADR-002 auth on every route | PASS | `router.use(requireAuth)` + `cheapLimiter` + `validateParams` |
| enum == RouteName after 031/032 | **FAIL** | enum = RouteName ∪ {`anon`}; `anon` is a bucketKey, not a route (SF-1) |
| linear migration history | **PARTIAL** | 030 gap + no contiguity check → out-of-order-apply risk (SF-2) |
| §5.2 regression test that fails on old code | PASS | schema-shape, route-exists, and due-exclusion tests all fail pre-feature |
| §5.2 unhappy paths (cross-user, unknown, malformed) | PASS | 404 both endpoints, 400 non-numeric, idempotency timestamp equality |
| §5.3 deterministic / real infra | PASS | real Postgres via `pg.pool`; no sleeps; injected ids |

## Findings

### BLOCKER
None.

### SHOULD-FIX
- **SF-1** — Migration 032 permanently adds a non-existent route `anon` to the
  `claude_route` enum; enum no longer equals `RouteName`, defeating 032's own goal
  and its recommended drift test. Irreversible.
- **SF-2** — The 030 numbering gap plus the runner's gap-agnostic pending filter
  creates an out-of-order-apply hazard if PR-030 merges after 031–033 are applied.

### NIT
- **NIT-1** — `setGraduation` builds the SET clause with
  `${graduate ? 'COALESCE(graduated_at, now())' : 'NULL'}`. Safe, but two explicit
  query strings would remove the "interpolate-into-SQL" smell entirely.
- **NIT-2** — `033.down`'s `DROP COLUMN` is genuinely data-lossy but is not matched
  by `migrate.py`'s `DESTRUCTIVE_PATTERNS` (which gates only DROP TABLE/SCHEMA/
  DATABASE/TRUNCATE), so a rollback skips the `--allow-destructive` speed bump.
  Inherent to the gate's design, not this migration; the down documents "lossy by
  design," which is the right posture.
- **NIT-3** — A grammar card whose entry is *soft-deleted* still surfaces as due
  (LEFT JOIN `ON … deleted_at IS NULL` nulls `ge.*`, so `ge.graduated_at IS NULL`
  is true). Pre-existing behavior, unchanged by 033 — flagged only so the fix-pass
  doesn't mistake it for a graduation regression.

### PRAISE
- **PR-1** — Migration 033's module comment is exemplary: it justifies flag-on-entry
  vs flag-on-card, names the *specific* index a partial index would lose to, states
  expand-only/additive, cites ADR-013, and correctly escapes `''` in the COMMENT.
- **PR-2** — Ownership is enforced *in the UPDATE* (`WHERE id = $1 AND user_id = $2
  AND deleted_at IS NULL`), so a foreign or soft-deleted row 404s with no existence
  leak — textbook BOLA defense, and matched by two cross-user tests.
- **PR-3** — Idempotent graduate via `COALESCE(graduated_at, now())` with a
  dedicated regression test asserting the timestamp does *not* slide — the test
  fails without the COALESCE.
- **PR-4** — The due-exclusion predicate is correctly placed in the WHERE (not the
  JOIN ON), is three-valued-logic-safe (`IS NULL`), and preserves non-grammar
  cards via the `c.grammar_entry_id IS NULL OR …` guard; the reasoning is
  documented inline and pinned by a round-trip test (due → graduate → excluded →
  readmit → restored).

## Detailed findings

### SF-1 — 032 adds `anon`, which is not a `RouteName` (enum ≠ RouteName after)

`db/migrations/032_claude_route_complete.up.sql:26` —
`ALTER TYPE claude_route ADD VALUE IF NOT EXISTS 'anon';`
with the comment (line 14): *"anon — the anonymous/base RouteName (config.ts)."*

That comment is factually wrong. `anon` is **not** a member of the `RouteName`
union (`server/src/services/claude/config.ts:118-126`). It is the *rate-limit
bucket key* fallback used when there is no `userId`:
- `server/src/services/claude/index.ts:526` and `:754` —
  `… ctx.userId !== null ? String(ctx.userId) : 'anon'`
- `server/src/services/claude/rate_limit.ts:9` — documents `'anon'` as the bucket
  key, consumed via `limiter.consume(route, bucketKey)`.

The route written to `claude_cache.route` / `claude_usage.route` is always a real
`RouteName` literal — every one of the eight assignments in `index.ts` (`:272,
:304, :336, :361, :402, :436, :484, :522`) is a declared route; none is `'anon'`.
So `route = 'anon'` is never written to the DB. The added enum value is dead.

Consequences:
1. **Goal not met.** 032's stated purpose (lines 14-15) is to make the enum
   "mirror RouteName exactly." After 031+032 the enum is
   `{enrich, recognize_grammar, grade_writing, generate_conversation,
   generate_grammar_drill, score_grammar_drill, image_ocr, diagnostic_item,
   anon}` (9 values) while `RouteName` has 8 — the set differs by exactly `anon`.
   The four *real* missing routes (generate_grammar_drill, score_grammar_drill,
   image_ocr, diagnostic_item) are added correctly; `anon` is the sole spurious
   addition.
2. **The recommended drift test would fail.** 032's own follow-up note (lines
   21-22) asks for "a server test asserting the claude_route enum equals the
   RouteName union." That test, written straight, would fail on merge because of
   this extra value — the migration ships pre-broken against its own guard.
3. **Irreversible.** The down (032.down) is a documented no-op because Postgres
   can't drop an enum value. Once applied to a shared/prod env, `anon` is
   effectively permanent (removal requires recreating the type + rewriting
   `claude_cache.route` and `claude_usage.route`). **Fix before first apply.**

Recommended fix: delete line 26 (and the `anon` bullet at lines 13-14) from 032.
Keep `image_ocr` and `diagnostic_item` — those are correct. If the eventual drift
test is written, it will then pass.

*(031 is clean: `generate_grammar_drill` and `score_grammar_drill` are genuine
`RouteName`s, `ADD VALUE IF NOT EXISTS` is idempotent, the tx-safety rationale is
accurate for PG12+/PG16 inside the runner's tx since the values aren't used in the
same tx, and the no-op down matches the 028 precedent.)*

### SF-2 — 030 gap + gap-agnostic runner = out-of-order-apply hazard

There is no filename/version *collision* — 030 and 031/032/033 are distinct — so
these files are safe to land. The hazard is ordering. `db/migrate.py` `cmd_migrate`
computes `pending = [m for m in migrations if m.version not in applied]` (line
~456) with **no contiguity check**. Migrations are applied in version order among
the pending set only. If 031/032/033 are applied now and PR-030 merges later, the
next `migrate` run sees 030 as pending and applies it *after* 033 already ran —
a non-linear history. It is harmless *iff* 030 is independent of the enum and
`grammar_entries` changes here; if it touches either, the apply order is wrong.

Recommendation (coordination, not a code change in these files): either renumber
the incoming PR to 034+ so history stays monotonic, or ensure 030 is applied
before 031–033 anywhere they'll co-exist. Longer term, a contiguity/linearity
check in the runner would turn this class of gap into a loud failure instead of a
silent out-of-order apply — but that is out of this branch's scope.

## Coordination observations

- **Enum drift guard is still missing.** Both 031 and 032 promise a test that
  pins `claude_route` == `RouteName`. It does not exist in this branch. Add it —
  but only *after* SF-1 is fixed, or it will fail on the `anon` value. This is the
  single highest-leverage follow-up: it would have caught SF-1 automatically.
- **033's three-surface claim checks out.** The migration asserts a graduated row
  is excluded from (a) the drill pool, (b) `/vocab/cards/due`, and (c)
  `/grammar/suggestions/weekly`. I verified (b) in `vocab.ts:188` and (c) in
  `grammar.ts:318-324`: the weekly NOT-EXISTS matches *any* non-deleted banked row
  and deliberately ignores `graduated_at`, so a graduated pattern stays excluded
  from suggestions — the "no change needed" claim is correct, and it is pinned by
  a route test. (a) is the client's concern (GET /bank returns `graduated_at` at
  `grammar.ts:186` for the client to filter), which is out of this scope but wired.
- **Version bump.** graduate/readmit bump `version = version + 1`, consistent with
  the POST /bank upsert (`grammar.ts:151`) and ADR-001 §D6. Note there is no
  optimistic-concurrency *check* on these flips (no `WHERE version = $n`), which is
  fine — a graduation toggle is not a lost-update-sensitive edit.
