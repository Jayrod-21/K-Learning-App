# FIX — F-UP-018: LLM re-verification of the paraphrase-only explanation residual

Date: 2026-07-06. Scope: live km-db data only (no app code, routes, or loader touched).
Source: `db/docs/FIX_sweep_data.md` §1 "Honest residual estimate" — the batch-F heuristic
detector (`tools/ingest/audit_topik_explanations.py`) could not verify ~289
paraphrase-only explanations that never quote an option verbatim (verdict
`UNSCANNABLE`), and the sweep proposed an LLM re-verification pass over exactly that
bucket. This document is that pass.

## Method

1. Re-exported all enriched rows (`topik_items.extra ? 'explanation'` — **1,884**,
   matching the post-sweep count) and re-ran the batch-F detector to reproduce the
   residual bucket: **292 UNSCANNABLE rows** (the sweep's "~289"; the small delta is
   count-at-export timing, same bucket).
2. Every one of the 292 rows was read in full — instruction, stem/transcript, prompt,
   all options, the graded key (1-based), and the complete explanation — and judged
   in Korean on one question: *does the explanation's reasoning endorse the graded
   option or a different one?* Special attention went to the sweep's two known
   failure classes (맞지 않는/않은 inversion items and speaker-attribution listening
   items; the bucket contained 0 inversion-class and 2 speaker-class rows, both fine).

## Coverage

| Metric | Count |
|---|---|
| Residual bucket size (UNSCANNABLE, post-sweep) | **292** |
| Rows read in full (LLM judgment) | **292** (100%) |
| Wrong-endorsement explanations found | **3** |
| Junk null-valued `explanation` keys found | **4** |
| Explanations repaired in place | **1** (cosmetic gloss error; endorsement was correct) |
| Explanations nulled | **7** |
| Enriched rows before → after | 1,884 → **1,877** |

## What was wrong

**Wrong endorsement — nulled (3).** Each of these carries an explanation that argues
for a different option than the graded key. All three sit on items whose shared
passage / picture set is not in the corpus, so a confident re-derivation was
impossible; per the sweep's rule (prefer null over uncertain correction) they were
nulled, and the provenance-verified key stands:

- **1031** (test 37, TOPIK I listening #15, key 4) — the item is a restaurant
  recommendation dialogue, but the explanation narrates an entirely different item
  (a laptop that won't turn on at a service center) and endorses picture ②.
- **2199** (test 91, TOPIK II reading #19, key 3 = 비록) — the explanation invents a
  sentence frame ("____, 면접을 보지 말아야 한다"), rules out 비록 as "concessive,"
  and endorses 만약 (option 4). The [19~20] shared passage is not stored (sibling
  stems are instruction-only), so no rewrite was possible.
- **2377** (test 96, TOPIK II reading #23, key 2 = 긴장되다) — the explanation grades
  a phantom option list (답답하다/서운하다/당황스럽다/불만스럽다) that matches none of
  the real options and endorses "당황스럽다" (its option 3). The [22~24] passage is
  not stored; nulled.

**Junk `explanation: null` keys — removed (4).** Ids **684, 1436, 1724, 1740** had
the `explanation` key present with a JSON `null` value — they counted as "enriched"
and pass an `extra ? 'explanation'` check while carrying nothing servable. The key
was removed (`extra - 'explanation'`). Three of the four are transcript-less
listening items, consistent with a generator that emitted nothing and a loader that
stored the empty result. 0 null-valued explanation keys remain DB-wide.

**Repaired in place (1).** **330** (test 96, TOPIK I listening #10, key 4 = 가구점):
the reasoning and endorsement are correct (buying a desk → furniture store), but the
closing sentence glossed option 4 as "optician's shop." Replaced with
"(가구점, furniture store)". Endorsement unchanged, so this is not counted among the
wrong-endorsement rows.

**Read-but-kept borderlines (no action, on record):** 169 and 2025 endorse the
correct key but partly hedge ("the correct position depends on…" / "the correct
answer depends on the logical flow") — low pedagogic value, not wrong; 565 and 855
endorse the correct option through muddled reasoning; 391 describes the right
post-office context for a picture item without naming a picture number. None of
these endorses a wrong option, and the brief forbids re-nulling correct content.

## Mechanics

All SQL id-scoped, guarded (`AND extra ? 'explanation'`, and `LIKE '%optician%'` for
the 330 repair), and idempotent on re-run; `version` bumped on every touched row.
All 8 touched rows' prior `explanation` values (including the four JSON nulls) are
backed up in **`topik_items_explanation_bak_followup`** (id, jsonb value, timestamp),
mirroring the sweep's `topik_items_explanation_bak_20260706`.

Post-fix detector re-run: `UNSCANNABLE` 292 → **285**, every other bucket unchanged
(OK 1266, OK_WEAK 261, MISMATCH_MEDIUM 43, MISMATCH_HIGH 4, SUSPECT_LOW 18 — all of
which were already manually adjudicated in batch F), confirming no regressions.

## Residual estimate now

The sweep estimated ~2–5 (upper bound ~10) bad explanations hiding in this bucket;
the full read found **3** wrong endorsements (plus 4 junk keys the heuristic count
had silently included) — inside the predicted band. Since every row in the
heuristic-blind bucket has now been human/LLM-read end to end, and the flagged/OK
buckets were already adjudicated or risk-sampled in batch F, **the residual for this
bucket is closed (best estimate: 0 remaining wrong-endorsement explanations among
the 285 kept paraphrase-only rows)**. The only remaining exposure DB-wide is the
batch-F OK-verdict cue-bleed scenario, which the sweep already sampled at 0/18 and
which this pass did not re-open.
