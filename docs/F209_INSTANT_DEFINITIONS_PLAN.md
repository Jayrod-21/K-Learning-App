# Plan: Instant pre-seeded in-context definitions (F-209)

**Status:** draft · **Date:** 2026-08-11 · decision: **pre-seed everything** (Jared, 2026-08-11)

## 1. Goal
Make tap-to-define **instant**. Today: tap → lemmatize (fast) → `GET /define` (KRDICT, fast) → `POST /enrich` (**live Claude, ~1–2s** — the latency). The popover blocks on the whole chain behind a "Looking it up…" spinner. F-209 removes the perceived wait AND pre-computes the contextual (Claude) nuance so even a first tap is instant.

## 2. What exists (scout-verified)
- Chain: `client/src/lib/tapChain.ts` `resolveWordPopover` → lemmatize → `GET /define` (KRDICT, `server/src/routes/define.ts`, ~53,978 entries) → `POST /enrich` (`server/src/routes/enrich.ts` → `proxy.enrich` → Anthropic, `expensiveLimiter`).
- **Enrich is already a 30-day write-through cache** (`claude_cache`, migration 004, key = sha256(route|model|system|user); user text = {lemma, source_sentence, context, krdict_gloss}). Repeat tap on the same (word, sentence) is already free. Only the FIRST tap is slow.
- Enrich is context-specific: input = lemma + the exact sentence; output JSON = `{nuance, usageNote, examples[], dontConfuseWith[], proficiency, register?}`.
- Static tappable corpus (sentence known ahead → pre-seedable): `reading_passages`/`reading_chapters` (books), TTMIK/Iyagi transcripts, TOPIK stems. Dynamic (NOT pre-seedable): chat, OCR/Images, per-user generated stories. Scale ≈ 308,700 surface tokens / 50,009 unique forms.
- Precedent: `claude_usage.user_id` nullable for "a system-initiated pre-warm job"; `audio_transcription_jobs` (076) is the durable-queue model; NO background worker process today (Express monolith) → batch = a one-shot `tools/` script.

## 3. Phase 1 — instant render (client, zero cost)
Make the popover **paint immediately** off the fast KRDICT `/define` result and fold in the Claude enrichment **progressively** (non-blocking), instead of blocking the whole popover on enrich.
- `client/src/hooks/useTapWord.ts` + `client/src/lib/tapChain.ts`: show the KRDICT-based popover as soon as `/define` resolves; run `/enrich` in the background and merge its `nuance/usageNote/extra examples/dontConfuse` in when it lands (or on the "More" drawer). A subtle inline "adding nuance…" affordance, not a full-screen spinner. Keep the existing abort/cleanup + the cache-hit fast path.
- Result: gloss + primary example are instant; contextual nuance appears in ~1–2s on a cold tap, instantly once cached/pre-seeded. This alone kills the visible latency.

## 4. Phase 2 — batch pre-seed tool (server, count-first)
A one-shot operator script (mirrors the ingest loaders) `tools/ingest/preseed_definitions.py` OR a `server/src/scripts/preseed-definitions.ts` (TS reuses `proxy.enrich` directly — preferred, since **prompt-hash identity is critical**: the batch MUST hash the byte-identical prompt the live path builds, or the cache keys won't collide and taps still miss. Calling the real `proxy.enrich` guarantees it).
- For each static-corpus sentence: lemmatize its tokens (reuse the `/lemmatize` Kiwi path), dedupe `(lemma, sentence)` pairs, skip function words the popover never enriches, and call `proxy.enrich(lemma, sentence, …)` — which populates `claude_cache` as a side effect. No new schema, no read-path change.
- **`--count` / `--dry-run` mode (spends nothing):** enumerate + dedupe the `(lemma, sentence)` pairs, subtract pairs already in `claude_cache`, and report: exact call count, estimated Anthropic cost (input+output tokens × model price), and estimated wall-clock. **Present this to Jared before the real run.**
- Idempotent (cache-hit pairs skipped), resumable, rate-limit-aware, budget-capped.

## 5. Phase 3 — run + deploy
1. Deploy Phase 1 (blue/green) — instant render live.
2. Run Phase 2 `--count` → present cost → on approval, run the real pre-seed (warms `claude_cache` for the whole static corpus). Taps across all static content become instant.
- Dynamic surfaces (chat/OCR/stories) keep the existing lazy write-through (unavoidable — sentence unknown ahead).

## 6. Open questions / risks
- **Cost** is the load-bearing unknown — resolved by the Phase-2 `--count` gate before any spend.
- **Prompt-hash fragility:** mitigated by pre-seeding through the real `proxy.enrich`. If we ever want to decouple, a dedicated `in_context_definitions` table checked before the network chain is the alternative (bigger; not needed now).
- **Cache eviction:** enrich TTL is 30 days; a pre-seed is "fresh" for 30 days. If we want the corpus permanently instant, either bump the enrich TTL for pre-seeded rows or add a periodic re-warm (a later refinement).

Each phase → full 4-phase `/fixpass` → blue/green deploy.
