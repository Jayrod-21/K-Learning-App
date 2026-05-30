# ADR-006: Full-text search language configuration for Darakwon corpora

**Status:** Accepted (Phase A interim)
**Date:** 2026-05-28
**Implemented in:** migration `002_darakwon_corpora.up.sql`
**Revisits:** Open question in ADR-001 (D, "Full-text search for Korean")

## Context

`grammar_entries` and `vocab_entries` carry `search_tsv` TSVECTOR columns
populated by triggers. Postgres `to_tsvector(config, …)` needs a text-search
configuration; the choice affects stemming, stop-word removal, and
tokenization. Korean is the primary search target.

Postgres ships with built-in configurations for English, German, Spanish,
French, etc. — none for Korean. Korean morphology (agglutinative verbs,
particle-suffixed nouns, no whitespace between many morphemes) means
naïve whitespace tokenization is wrong: 먹었어요 (ate-deferentially) won't
match 먹다 (to eat) unless we segment+lemmatize first.

Production-grade Korean FTS in our stack is **Kiwi** (the morphological
analyzer planned for Phase B, running in its own service). Kiwi outputs
lemmatized tokens that can be fed to `to_tsvector('simple', …)` to produce
a Korean-aware index.

But Kiwi doesn't exist yet (Phase A is the schema).

## Decision

For Phase A, use **`to_tsvector('simple', …)`** with raw text.

- `simple` does whitespace tokenization, lowercases, and removes nothing.
- It does NOT stem English words ("ran"/"runs" don't unify) and does NOT
  segment Korean morphology.
- Both are acceptable for Phase A: the Reference search is exact-substring-
  friendly enough on KGIU patterns (which are usually copied verbatim) and
  vocab headwords (typed as-is).

When Phase B Kiwi exists, we will:

1. Add a sibling column `search_tsv_kiwi TSVECTOR` populated by a loader
   step (NOT a trigger — Kiwi is an HTTP call, and ADR-001 §D12 + the
   senior-engineer-bar forbid external I/O inside triggers/transactions).
2. Switch the GIN index target to `search_tsv_kiwi`.
3. Drop `search_tsv` in a later migration.

## Why not `english`?

- It would stem English words but butcher Korean by lowercase-folding plus
  applying English stop-word removal to Korean phrases — wrong on the
  primary target text.

## Why not skip FTS entirely until Kiwi?

- The schema needs SOME index to back the Reference search feature in Phase
  A. `simple` is good enough for exact-headword and English-gloss lookups
  (the two queries we actually run pre-Kiwi).

## Why is the trigger acceptable here?

- ADR-001 §D12 lists "search-index maintenance" as an explicit allowed use
  for triggers. The function is pure (no external I/O), deterministic
  (`setweight(to_tsvector(...))`), and fast.

## Threat model on the FTS path

- **Pathological-query DoS** (the senior-engineer-bar SECURITY.md hint):
  a user-supplied `to_tsquery()` like `(a|b|c|d|e|f) & …` can be expensive.
  **Defense:** statement timeout per app role (ADR-001 §D13: 5s for the
  app role). The DB will kill a runaway query before it ties up a
  connection.
- **Injection via the FTS input:** parameterized queries always; the app
  must use `plainto_tsquery` (which escapes) rather than `to_tsquery`
  (which parses operators) on user-supplied strings.
- **TSVECTOR bloat:** the weighted concatenation has a known upper bound
  (entry size). `GIN` handles it fine.

## Consequences

- Phase A: imperfect Korean recall on FTS queries. Mitigated by the B-tree
  index `ix_vocab_entries_korean` for exact-headword lookups.
- Phase B: add `search_tsv_kiwi` and migrate. Old `search_tsv` retained
  during transition for fallback.
- Tests must use the `simple` config to assert on Phase-A behaviour; the
  Kiwi rollout will get its own test suite.
