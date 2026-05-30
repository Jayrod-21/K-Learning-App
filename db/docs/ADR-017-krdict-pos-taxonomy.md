# ADR-017: KRDICT POS taxonomy — TEXT with CHECK, not a new enum

**Status:** Accepted
**Date:** 2026-05-28
**Implemented in:** `db/migrations/003_krdict.up.sql`
**Owner:** Agent B2 (KRDICT)
**Relates to:** ADR-015 (KRDICT schema), ADR-001 §D8 (when to enum)

## Context

KRDICT's part-of-speech taxonomy is finer than the four-or-five POS labels
we'd otherwise informally use:

- 명사 (noun)
- 대명사 (pronoun)
- 수사 (numeral)
- 동사 (verb)
- 형용사 (adjective)
- 관형사 (determiner / adnominal)
- 부사 (adverb)
- 감탄사 (interjection)
- 조사 (particle)
- 어미 (verbal ending)
- 접사 (affix — 접두사 prefix / 접미사 suffix)
- 의존 명사 (bound noun)
- 보조 동사 (auxiliary verb)
- 보조 형용사 (auxiliary adjective)
- 품사 없음 (no POS — used for fragments)

KRDICT occasionally publishes new POS labels when their analysis evolves
(it has done so twice in the past five years). Modeling POS as an enum
would require `ALTER TYPE ADD VALUE` migrations on those upstream changes
— easy to forget, breaks loaders silently when the new value appears.

The Darakwon corpora (KGIU, 2000 Words) took the same call for the same
reason: `kgiu_entries.category` and `vocab_entries.part_of_speech` are
both TEXT for extensibility (002 ADR notes).

## Decision

**`krdict_entries.part_of_speech` is `TEXT`** with a CHECK constraint
listing the 15 known KRDICT POS values plus NULL (KRDICT entries that
predate the taxonomy don't carry a POS tag).

```sql
CHECK (
    part_of_speech IS NULL OR part_of_speech IN (
        '명사', '대명사', '수사', '동사', '형용사', '관형사',
        '부사', '감탄사', '조사', '어미', '접사',
        '의존 명사', '보조 동사', '보조 형용사', '품사 없음'
    )
)
```

When KRDICT adds a value, we update the CHECK in a small migration. The
loader's defensive validation (Pydantic model accepts `str`, no enum
coercion) means a new upstream value triggers a single CHECK violation at
INSERT time — easy to spot, easy to fix.

## Alternatives considered

- **`CREATE TYPE krdict_pos AS ENUM (…)`.** Type-safe but requires
  `ALTER TYPE ADD VALUE` migrations on every upstream change. Postgres
  also can't REMOVE an enum value, so cleanup is hard. The existing
  ADR-001 §D8 carve-out for "domain-extensible categories" applies here.
  Rejected.
- **Map KRDICT POS to the smaller, app-internal POS we already have.**
  We don't have one — KGIU and 2000 Words both use TEXT POS strings.
  There IS no canonical app-internal POS. Premature consolidation,
  rejected (YAGNI).
- **No constraint at all.** Loses defense against a parser bug writing
  garbage. Rejected.

## Consequences

- A new KRDICT POS value requires a one-line migration updating the CHECK
  set. Acceptable cadence (we've seen 2 upstream changes in 5 years).
- The parser's Pydantic model treats POS as plain `Optional[str]` and
  strips whitespace; it does NOT enum-validate. The DB CHECK is the
  validation point — by design, so a parser update doesn't need to chase
  the DB.
- Reference / Search UI POS facets read the CHECK list dynamically (a
  small SELECT on `pg_constraint` lets us avoid hardcoding the list in
  two places).
