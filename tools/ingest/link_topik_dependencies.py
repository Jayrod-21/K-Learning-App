"""
TOPIK ↔ corpus dependency linker.

For each TOPIK item, identify which grammar entries (kgiu_entries) and which
vocab entries (vocab_entries) the item tests. Writes results into the
``topik_dependencies`` table (migration 008).

Three strategies, all mechanical-first per ADR-024:

    A. skill_tag → grammar_entry mapping
       For items whose normalized ``skill_tag`` implies a grammar family
       (e.g. ``grammar-connective``, ``grammar-paraphrase``), look up
       kgiu_entries whose ``pattern``/``category`` fits the family. Confidence
       0.90 (source = ``skill_tag``).

    B. lemma_match → vocab_entry
       Lemmatize the item's stem + options via the Kiwi service (B1). For each
       resulting content-word lemma, look up matching ``vocab_entries.korean``.
       Confidence 0.75 (source = ``lemma_match``).

    C. claude_analysis (optional, expensive, disabled by default)
       For items strategies A+B failed to cover, send the item + candidate
       grammar/vocab entries to Claude via B4's proxy (HTTP route
       ``/grammar/identify``) for a span→pattern match. Confidence per
       Claude's reply (source = ``claude_analysis``).

Precedence: if multiple strategies identify the same (item, dep_type, target)
triple, the higher-confidence row wins. Lower-confidence duplicates are
skipped via an ON CONFLICT DO UPDATE that only overwrites when the new row's
confidence beats the existing row.

Idempotency: re-running with the same inputs is a no-op. The natural key
``(topik_item_id, dep_type, COALESCE(grammar_entry_id,0), COALESCE(vocab_entry_id,0))``
materialized in migration 008's unique index makes this exact.

Resumability: per-test checkpoint via the ``load_state`` table (corpus =
``'topik_dep_linker'``).

CLI flags:
    --use-claude            Enable Strategy C (off by default; cost note below).
    --kiwi-url URL          Override Kiwi service URL (default $KIWI_URL).
    --proxy-url URL         Override Claude proxy URL (default $CLAUDE_PROXY_URL).
    --proxy-token TOKEN     Auth token / cookie for the proxy (env $CLAUDE_PROXY_TOKEN).
    --test-numbers 36,47    Restrict to specific TOPIK test numbers.
    --dry-run               Compute deps but DO NOT write rows.
    --batch-size N          Items per transaction (default 50).
    --log-level LEVEL       structlog level (debug|info|warning|error).

Environment:
    DATABASE_URL            Postgres connection string (required).
    KIWI_URL                Kiwi service base URL (default http://kiwi:8000).
    CLAUDE_PROXY_URL        B3 proxy base URL (default http://server:3000).
    CLAUDE_PROXY_TOKEN      Auth token for the proxy (optional; only when
                            --use-claude).

Cost (Strategy C, rough estimate):
    Per item: ~1 prompt to /grammar/identify per option (4) + 1 vocab pass.
    @ ~600 input tokens + 200 output @ Sonnet rate ≈ $0.012 / item.
    The full TOPIK corpus has ~1,200 items; full --use-claude run ≈ $15.
    With ``--strategy-c-only-uncovered`` (default), only items uncovered by
    A+B are sent — typically <20% — so ≈ $3.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import httpx
import structlog
from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel, ConfigDict, Field

# Reuse the loader runtime — pool, logging, checkpoints.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from loaders.runtime import (  # noqa: E402
    CheckpointRow,
    LoaderConfig,
    checkpoint_progress,
    configure_logging,
    get_or_create_checkpoint,
    mark_complete,
    mark_failed,
    mark_in_progress,
    open_pool,
)

logger = structlog.get_logger(__name__)


# =============================================================================
# Domain models (Pydantic at every boundary — SENIOR_ENGINEER_BAR §2 Type safety)
# =============================================================================


class TopikItemRow(BaseModel):
    """One TOPIK item as we load it from Postgres for linking."""

    model_config = ConfigDict(extra="forbid")

    id: int
    source_id: str
    test_number: int
    section: str
    item_number: int
    skill_tag: str | None
    stem: str | None
    options: list[Any] = Field(default_factory=list)
    underline: str | None = None


class KgiuCandidate(BaseModel):
    """Candidate grammar entry returned by the pattern-family lookup."""

    model_config = ConfigDict(extra="forbid")

    id: int
    pattern: str
    category: str | None
    book_level: str


class VocabCandidate(BaseModel):
    """Candidate vocab entry matched by lemma."""

    model_config = ConfigDict(extra="forbid")

    id: int
    korean: str
    part_of_speech: str | None


class Dependency(BaseModel):
    """One TOPIK→target dependency row, pre-DB insertion.

    ``grammar_entry_id`` and ``vocab_entry_id`` are mutually exclusive — the
    DB CHECK enforces it, and we enforce it here too so a bug in the linker
    never reaches the DB.
    """

    model_config = ConfigDict(extra="forbid")

    topik_item_id: int
    dep_type: str  # 'grammar' | 'vocab'
    grammar_entry_id: int | None = None
    vocab_entry_id: int | None = None
    confidence: float
    source: str
    evidence: dict[str, Any] = Field(default_factory=dict)


class LinkerConfig(BaseModel):
    """Runtime configuration. Constructed from CLI + env."""

    model_config = ConfigDict(extra="forbid")

    database_url: str
    kiwi_url: str = "http://kiwi:8000"
    proxy_url: str = "http://server:3000"
    proxy_token: str | None = None
    use_claude: bool = False
    test_numbers: list[int] | None = None
    dry_run: bool = False
    batch_size: int = 50
    log_level: str = "info"
    # HTTP timeouts (seconds). Generous, but bounded.
    kiwi_timeout_s: float = 10.0
    proxy_timeout_s: float = 60.0


# =============================================================================
# Strategy A — skill_tag → grammar family
# =============================================================================
#
# Mapping from the 33-tag controlled vocabulary (normalize_skill_tags.py)
# to one or more kgiu_entries.category values OR pattern-substring regexes.
#
# The mapping intentionally over-collects (multiple candidate categories per
# tag): the DB rows we write are dependencies, and a TOPIK item that tags
# itself "grammar-connective" really does test ANY connective the options
# represent. The confidence 0.90 is the cost we pay for that breadth.

SKILL_TAG_TO_GRAMMAR_CATEGORY: dict[str, tuple[str, ...]] = {
    "grammar-connective":  ("connective", "condition", "concession", "time", "reason"),
    "grammar-expression":  ("expression", "auxiliary", "modal", "aspect"),
    "grammar-paraphrase":  ("expression", "connective", "auxiliary", "modal"),
}


# =============================================================================
# Strategy B helpers — Kiwi client
# =============================================================================


class KiwiClient:
    """Thin async wrapper around the Kiwi /tokens endpoint.

    Re-used across the whole linker run via httpx.AsyncClient connection
    pooling. The lemmatizer service contract is documented in
    services/kiwi/src/kiwi_service/app.py.
    """

    def __init__(self, base_url: str, timeout_s: float) -> None:
        self._base = base_url.rstrip("/")
        self._client = httpx.AsyncClient(timeout=timeout_s)

    async def close(self) -> None:
        await self._client.aclose()

    async def lemmas(self, text: str) -> list[tuple[str, str]]:
        """Return list of (lemma, pos) for content words in ``text``.

        Drops particles, endings, and punctuation — anything whose POS is
        not a content-word class.
        """
        if not text.strip():
            return []
        resp = await self._client.post(
            f"{self._base}/tokens",
            json={"text": text[:4000]},  # match Kiwi default cap
            headers={"x-request-id": _request_id()},
        )
        resp.raise_for_status()
        body = resp.json()
        out: list[tuple[str, str]] = []
        for tok in body.get("tokens", []):
            pos: str = tok.get("pos", "")
            if pos in _CONTENT_POS:
                lemma: str = tok.get("lemma", "")
                if lemma:
                    out.append((lemma, pos))
        return out


# Kiwi (Sejong-style) content-word POS tags. We deliberately exclude particles
# (JK*, JX), endings (E*), and punctuation (S*) — those aren't dictionary
# lookups.
_CONTENT_POS = frozenset({
    "NNG",  # common noun
    "NNP",  # proper noun
    "NNB",  # bound noun
    "NR",   # numeral
    "VV",   # verb
    "VA",   # adjective
    "VX",   # auxiliary verb
    "VCP",  # copula 이다
    "VCN",  # copula 아니다
    "MAG",  # general adverb
    "MAJ",  # conjunctive adverb
    "MM",   # determiner
})


def _request_id() -> str:
    # Lightweight correlation id; structlog binds it in the request context.
    return f"linker-{int(time.time()*1000):x}-{os.getpid()}"


# Section ordering — matches the topik_section enum's logical order. Keeping
# the map here (not reading from the DB at runtime) avoids a round-trip in
# the resume-filter hot path. If a future migration adds a section, update
# this map AND the cursor format will keep sorting correctly because we
# zero-pad to 2 digits.
_SECTION_RANK: dict[str, int] = {
    "reading": 0,
    "listening": 1,
    "writing": 2,
}


def _item_sort_key(item: "TopikItemRow") -> str:
    """Encode (test_number, section, item_number) as a textually-sortable key.

    The SQL in ``fetch_items`` orders by (tt.test_number, ti.section,
    ti.item_number). We mirror that ordering in a string so the cursor
    stored in ``load_state.last_item_id`` (TEXT) can be compared
    lexically and still match the SQL order — independent of whatever
    convention the source ``source_id`` strings use.

    Format: ``"<test:06d>:<section_rank>:<item:06d>"`` — e.g. test 36,
    reading, item 10 → ``"000036:0:000010"``. The 6-digit zero-pad
    handles every TOPIK test number we'll ever see (currently ≤ ~99
    for TOPIK II); the section rank is a single digit; the item is
    zero-padded to 6 to handle Mock test items in the hundreds.

    REVIEW_C4 F1: the pre-fix code compared ``item.source_id`` strings
    lexically, which silently breaks when the convention drifts (e.g.,
    ``"topik36-read-10"`` < ``"topik36-read-9"`` lexically).
    """
    section_rank = _SECTION_RANK.get(item.section, 99)
    return f"{item.test_number:06d}:{section_rank}:{item.item_number:06d}"


# =============================================================================
# Strategy C helpers — Claude proxy client
# =============================================================================


class ClaudeProxyClient:
    """Calls B3's HTTP proxy for grammar-pattern recognition.

    We hit ``POST /grammar/identify`` (the existing "drag-to-highlight"
    endpoint) — sending the item's stem as ``fullSentence`` and the option
    text as ``highlightSpan``. The response surfaces a canonical pattern
    name the caller can map back to ``kgiu_entries``.
    """

    def __init__(self, base_url: str, token: str | None, timeout_s: float) -> None:
        self._base = base_url.rstrip("/")
        self._token = token
        self._client = httpx.AsyncClient(timeout=timeout_s)

    async def close(self) -> None:
        await self._client.aclose()

    async def identify_pattern(
        self, *, highlight_span: str, full_sentence: str, context_hint: str | None
    ) -> dict[str, Any] | None:
        headers = {"x-request-id": _request_id()}
        if self._token:
            headers["authorization"] = f"Bearer {self._token}"
        body: dict[str, Any] = {
            "highlightSpan": highlight_span[:120],
            "fullSentence": full_sentence[:2000],
        }
        if context_hint:
            body["contextHint"] = context_hint[:500]
        try:
            resp = await self._client.post(
                f"{self._base}/grammar/identify", json=body, headers=headers
            )
            if resp.status_code == 401 or resp.status_code == 403:
                logger.warning("claude_proxy_unauthorized", status=resp.status_code)
                return None
            resp.raise_for_status()
            return resp.json()  # type: ignore[no-any-return]
        except httpx.HTTPError as err:
            logger.warning("claude_proxy_call_failed", error=str(err))
            return None


# =============================================================================
# DB query layer (parameterized — SENIOR_ENGINEER_BAR §2 Security)
# =============================================================================


async def fetch_items(
    conn: AsyncConnection, test_numbers: list[int] | None
) -> list[TopikItemRow]:
    """Pull TOPIK items in scope. Restricts to selected tests if asked."""
    sql = (
        "SELECT ti.id, ti.source_id, tt.test_number, ti.section::text, "
        "       ti.item_number, ti.skill_tag, ti.stem, ti.options, ti.underline "
        "  FROM topik_items ti "
        "  JOIN topik_tests tt ON tt.id = ti.topik_test_id "
    )
    params: tuple[Any, ...] = ()
    if test_numbers:
        sql += " WHERE tt.test_number = ANY(%s) "
        params = (list(test_numbers),)
    sql += " ORDER BY tt.test_number, ti.section, ti.item_number"
    async with conn.cursor() as cur:
        await cur.execute(sql, params)
        rows = await cur.fetchall()
    out: list[TopikItemRow] = []
    for r in rows:
        options_raw = r[7]
        if isinstance(options_raw, str):
            options_raw = json.loads(options_raw)
        out.append(
            TopikItemRow(
                id=int(r[0]),
                source_id=str(r[1]),
                test_number=int(r[2]),
                section=str(r[3]),
                item_number=int(r[4]),
                skill_tag=r[5],
                stem=r[6],
                options=list(options_raw) if options_raw else [],
                underline=r[8],
            )
        )
    return out


async def grammar_candidates_by_category(
    conn: AsyncConnection, categories: Iterable[str]
) -> list[KgiuCandidate]:
    """Return all kgiu_entries with ``category`` in the given set."""
    cats = list({c for c in categories if c})
    if not cats:
        return []
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT id, pattern, category, book_level::text "
            "  FROM kgiu_entries "
            " WHERE entry_type = 'grammar' "
            "   AND pattern IS NOT NULL "
            "   AND category = ANY(%s) ",
            (cats,),
        )
        rows = await cur.fetchall()
    return [
        KgiuCandidate(
            id=int(r[0]), pattern=str(r[1]), category=r[2], book_level=str(r[3])
        )
        for r in rows
    ]


async def grammar_candidates_by_pattern_substring(
    conn: AsyncConnection, fragment: str, hangul_fragment: str
) -> list[KgiuCandidate]:
    """Find kgiu_entries whose pattern matches the extracted grammar fragment.

    F-UP-010 (safe variant). Two OR'd match arms:

      1. RAW substring: ``pattern ILIKE '%<fragment>%'`` — the original
         punctuation-exact match (``fragment`` still carries ``-``/``(``/``)``/``/``).
         Kept for ALL fragments; it is the baseline behavior and its precision is
         already accepted.
      2. SYLLABLE-normalized substring, ONLY when the fragment has
         ``>= _STRATEGY_C_MIN_NORMALIZED_HANGUL_CHARS`` syllables: both sides are
         reduced to Hangul syllables (``regexp_replace(pattern, '[^가-힣]', '')``
         vs ``hangul_fragment``). This recovers same-grammar links whose surface
         punctuation differs (e.g. a Claude ``-으려고`` vs a stored ``-(으)려고``).

    Why arm 2 is gated at 3 syllables and NOT applied to 2-syllable fragments:
    stripping all punctuation from a 2-syllable fragment collapses distinct
    grammar points that merely share a common ending. Validated against the real
    KGIU corpus (285 grammar patterns, ``tools/ingest/output/grammar_kgiu_*.json``):
    normalizing every fragment produced **26** spurious cross-links between
    unrelated entries (``-다가``↔``-아/어다가``, ``(으)로``↔``-(으)ㅁ으로써``,
    ``-데요``↔``-던데요`` …), essentially ALL of them driven by 2-syllable
    fragments; restricting normalization to >= 3 syllables drops that to **2**
    borderline (modifier-form patterns matching a modifier reference). Because
    substring matching cannot distinguish a true 2-syllable variant (``는데`` →
    ``-(으)ㄴ/는데``) from a false one (``다가`` → ``-아/어다가``), the 2-syllable
    case is deliberately left to the raw arm only — a missed link is safer than a
    wrong one for a prerequisite graph. FOLLOW_UPS F-UP-010 tracks the proper fix
    (alternation-aware expansion of ``(으)``/``ㄴ/는`` into surface forms).

    Full table scan with a per-row regexp_replace, which is fine: kgiu_entries is
    a few hundred rows and this runs only in the offline ingest linker. Both LIKE
    operands are parameterized (``%s``); the char-class is a hardcoded literal.
    """
    if not hangul_fragment or len(hangul_fragment) < 2:
        return []
    raw_like = f"%{fragment}%"
    if len(hangul_fragment) >= _STRATEGY_C_MIN_NORMALIZED_HANGUL_CHARS:
        where_clause = (
            "( pattern ILIKE %s "
            "  OR regexp_replace(pattern, '[^가-힣]', '', 'g') ILIKE %s )"
        )
        params: tuple[str, ...] = (raw_like, f"%{hangul_fragment}%")
    else:
        where_clause = "pattern ILIKE %s"
        params = (raw_like,)
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT id, pattern, category, book_level::text "
            "  FROM kgiu_entries "
            " WHERE entry_type = 'grammar' "
            f"   AND {where_clause} "
            " LIMIT 25 ",
            params,
        )
        rows = await cur.fetchall()
    return [
        KgiuCandidate(
            id=int(r[0]), pattern=str(r[1]), category=r[2], book_level=str(r[3])
        )
        for r in rows
    ]


async def vocab_candidates_for_lemmas(
    conn: AsyncConnection, lemmas: Iterable[str]
) -> dict[str, list[VocabCandidate]]:
    """Look up vocab_entries.korean = lemma for each lemma. Returns a mapping
    from lemma → matched rows.
    """
    uniq = sorted({lem for lem in lemmas if lem})
    if not uniq:
        return {}
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT id, korean, part_of_speech "
            "  FROM vocab_entries "
            " WHERE entry_type = 'word' "
            "   AND korean = ANY(%s) ",
            (uniq,),
        )
        rows = await cur.fetchall()
    out: dict[str, list[VocabCandidate]] = {lem: [] for lem in uniq}
    for r in rows:
        kor = str(r[1])
        if kor in out:
            out[kor].append(
                VocabCandidate(id=int(r[0]), korean=kor, part_of_speech=r[2])
            )
    return out


# =============================================================================
# Insertion — idempotent, precedence-aware
# =============================================================================


_INSERT_DEP_SQL = """
INSERT INTO topik_dependencies (
    topik_item_id, dep_type, grammar_entry_id, vocab_entry_id,
    confidence, source, evidence
)
VALUES (%s, %s::topik_dependency_type, %s, %s, %s, %s, %s::jsonb)
ON CONFLICT (
    topik_item_id, dep_type,
    COALESCE(grammar_entry_id, 0),
    COALESCE(vocab_entry_id,   0)
) DO UPDATE
   SET confidence = GREATEST(topik_dependencies.confidence, EXCLUDED.confidence),
       source     = CASE
                      WHEN EXCLUDED.confidence > topik_dependencies.confidence
                          THEN EXCLUDED.source
                      ELSE topik_dependencies.source
                    END,
       evidence   = CASE
                      WHEN EXCLUDED.confidence > topik_dependencies.confidence
                          THEN EXCLUDED.evidence
                      ELSE topik_dependencies.evidence
                    END,
       version    = topik_dependencies.version + 1
   WHERE EXCLUDED.confidence > topik_dependencies.confidence
RETURNING (xmax = 0) AS inserted, id
"""


@dataclass
class WriteStats:
    inserted: int = 0
    upgraded: int = 0
    skipped: int = 0

    def merged(self) -> int:
        return self.inserted + self.upgraded + self.skipped


async def write_deps(
    conn: AsyncConnection, deps: list[Dependency]
) -> WriteStats:
    """Upsert a batch of dependency rows. Precedence baked into the SQL.

    Strategy precedence (ADR-024): the row with higher confidence wins on
    natural-key conflict. Equal-confidence rows leave the existing row
    untouched (the WHERE in the ON CONFLICT only matches strict-greater).
    """
    stats = WriteStats()
    if not deps:
        return stats
    async with conn.cursor() as cur:
        for d in deps:
            # Defensive XOR: never let a bug write a half-shaped row.
            if (d.grammar_entry_id is None) == (d.vocab_entry_id is None):
                raise ValueError(
                    f"Dependency XOR violated: item={d.topik_item_id} "
                    f"grammar={d.grammar_entry_id} vocab={d.vocab_entry_id}"
                )
            await cur.execute(
                _INSERT_DEP_SQL,
                (
                    d.topik_item_id,
                    d.dep_type,
                    d.grammar_entry_id,
                    d.vocab_entry_id,
                    d.confidence,
                    d.source,
                    json.dumps(d.evidence, ensure_ascii=False),
                ),
            )
            row = await cur.fetchone()
            if row is None:
                stats.skipped += 1
            else:
                inserted = bool(row[0])
                if inserted:
                    stats.inserted += 1
                else:
                    stats.upgraded += 1
    return stats


# =============================================================================
# Strategy implementations
# =============================================================================


async def strategy_a_skill_tag(
    conn: AsyncConnection, item: TopikItemRow
) -> list[Dependency]:
    """Tag→category lookup, returns one dep per matched grammar entry."""
    tag = item.skill_tag or ""
    cats = SKILL_TAG_TO_GRAMMAR_CATEGORY.get(tag)
    if not cats:
        return []
    candidates = await grammar_candidates_by_category(conn, cats)
    return [
        Dependency(
            topik_item_id=item.id,
            dep_type="grammar",
            grammar_entry_id=c.id,
            confidence=0.90,
            source="skill_tag",
            evidence={"skill_tag": tag, "matched_category": c.category},
        )
        for c in candidates
    ]


async def strategy_b_lemma_match(
    conn: AsyncConnection, kiwi: KiwiClient, item: TopikItemRow
) -> list[Dependency]:
    """Lemmatize stem+options; for each content-word lemma, look up vocab."""
    texts: list[str] = []
    if item.stem:
        texts.append(item.stem)
    for opt in item.options:
        if isinstance(opt, str) and opt.strip():
            texts.append(opt)
    if not texts:
        return []
    all_lemmas: dict[str, list[str]] = {}  # lemma → list of source contexts
    for t in texts:
        try:
            pairs = await kiwi.lemmas(t)
        except httpx.HTTPError as err:
            logger.warning("kiwi_call_failed", item_id=item.id, error=str(err))
            continue
        for lemma, _pos in pairs:
            all_lemmas.setdefault(lemma, []).append(t)

    if not all_lemmas:
        return []
    matches = await vocab_candidates_for_lemmas(conn, all_lemmas.keys())
    deps: list[Dependency] = []
    seen: set[int] = set()
    for lemma, vocab_rows in matches.items():
        for v in vocab_rows:
            if v.id in seen:
                continue
            seen.add(v.id)
            deps.append(
                Dependency(
                    topik_item_id=item.id,
                    dep_type="vocab",
                    vocab_entry_id=v.id,
                    confidence=0.75,
                    source="lemma_match",
                    evidence={
                        "lemma": lemma,
                        "vocab_korean": v.korean,
                        "contexts": all_lemmas[lemma][:3],
                    },
                )
            )
    return deps


# Hangul jamo range for trimming Claude's returned pattern strings.
# The character class includes:
#   - 가-힯  : Hangul Syllables block (full Korean characters).
#   - ㄰-㆏  : Hangul Jamo Extended ranges (rare; preserved for safety).
#   - \-     : hyphen — KGIU pattern strings routinely begin with one
#              ("-아/어도", "-(으)니까") and the substring match must
#              keep it to find the right entries.
#   - \(\)   : parentheses — KGIU encodes morphophonological alternations
#              with them ("(으)면", "N(이)랑") and stripping them would
#              lose the disambiguator.
#   - /      : slash — KGIU writes co-equal forms like "와/과" or
#              "이/가" together, so the slash is part of the pattern's
#              identity (REVIEW_C4 NIT F8).
_HANGUL_RE = re.compile(r"[㄰-㆏가-힯\-\(\)/]+")


# Strategy C caps (REVIEW_C4 F3): with 4 spans × 25-row LIMIT, the worst
# case is 100 grammar deps for a single TOPIK item — an opt-in pass at
# this size would compete with the skill_tag rows on the natural-key
# conflict. Two cheap defenses:
#   1. Reject the candidate when the matched fragment is too short to be
#      discriminating (single-syllable fragments like "오" or "이" match
#      virtually every connective).
#   2. Cap the TOTAL Strategy C deps written PER ITEM. Anything beyond
#      the cap is dropped with a WARN log so the operator can decide
#      whether to tighten the prompt or accept the loss.
# 2, not 3: reject only single-SYLLABLE (1-char) fragments, per note 1 above.
# Requiring 3 also silently dropped legitimate 2-syllable grammar patterns like
# "으면" (from "-(으)면") and "는데" — which the DB pattern match validates anyway,
# so a 2-char fragment that is NOT a real grammar form simply yields no candidate.
_STRATEGY_C_MIN_FRAGMENT_HANGUL_CHARS = 2
# F-UP-010: the syllable-normalized match arm (which strips ALL punctuation) is
# only applied to fragments with >= 3 Hangul syllables. Below that, stripping
# punctuation collapses distinct 2-syllable grammar points that share an ending
# and floods the linker with false positives (26 on the real KGIU corpus, vs 2
# for >= 3) — so 2-syllable fragments use the raw, punctuation-exact arm only.
# See grammar_candidates_by_pattern_substring for the full rationale + numbers.
_STRATEGY_C_MIN_NORMALIZED_HANGUL_CHARS = 3
_STRATEGY_C_MAX_DEPS_PER_ITEM = 10


async def strategy_c_claude(
    conn: AsyncConnection,
    proxy: ClaudeProxyClient,
    item: TopikItemRow,
    already_covered: bool,
) -> list[Dependency]:
    """Optional pass — only invoked when --use-claude is set.

    For grammar-tagged items, send each option (the underline if present;
    otherwise the option text) as a highlight span. Claude returns a
    canonical pattern name; we use a substring match against kgiu_entries.
    """
    if already_covered:
        return []
    full_sentence = item.stem or ""
    if not full_sentence:
        return []
    spans: list[str] = []
    if item.underline:
        spans.append(item.underline)
    else:
        # MCQ options are the candidate forms.
        for opt in item.options:
            if isinstance(opt, str) and 0 < len(opt) <= 60:
                spans.append(opt)
    if not spans:
        return []

    deps: list[Dependency] = []
    over_cap = 0
    for span in spans[:4]:  # cap per item
        result = await proxy.identify_pattern(
            highlight_span=span,
            full_sentence=full_sentence,
            context_hint=f"section={item.section}; tag={item.skill_tag or 'unknown'}",
        )
        if not result:
            continue
        # /grammar/identify returns the ProxyResult envelope
        # { "result": PatternResult, "metadata": CallMetadata } — see
        # server/src/services/claude/models.ts. The canonical pattern and the
        # confidence live UNDER "result" (keyed patternKey), not at the top level.
        inner = result.get("result")
        if not isinstance(inner, dict):
            continue
        pattern_text = str(inner.get("patternKey") or "")
        confidence = float(inner.get("confidence", 0.65))
        confidence = max(0.0, min(1.0, confidence))
        # Trim to Hangul-ish characters to use as a substring lookup.
        m = _HANGUL_RE.search(pattern_text)
        if not m:
            continue
        fragment = m.group(0)
        # Hangul-only character count for the discriminating-length check.
        # Strip non-syllable characters (-, (, ), /) so "(으)면" counts as 2
        # discriminating syllables, not 5.
        # `가`–`힣` (U+AC00–U+D7A3, the assigned Hangul-syllable range) so the
        # count here matches the SQL-side `[^가-힣]` strip in the matcher (N-1).
        hangul_only = "".join(ch for ch in fragment if "가" <= ch <= "힣")
        if len(hangul_only) < _STRATEGY_C_MIN_FRAGMENT_HANGUL_CHARS:
            logger.debug(
                "strategy_c_fragment_too_short",
                item_id=item.id,
                fragment=fragment,
                hangul_chars=len(hangul_only),
            )
            continue
        # F-UP-010: pass BOTH the raw fragment (punctuation-exact match, all
        # lengths) and the syllable-only form (normalized match, 3+ syllables
        # only). `fragment` (with punctuation) is also kept for the evidence trail.
        candidates = await grammar_candidates_by_pattern_substring(
            conn, fragment, hangul_only
        )
        for c in candidates:
            if len(deps) >= _STRATEGY_C_MAX_DEPS_PER_ITEM:
                over_cap += 1
                continue
            deps.append(
                Dependency(
                    topik_item_id=item.id,
                    dep_type="grammar",
                    grammar_entry_id=c.id,
                    confidence=confidence,
                    source="claude_analysis",
                    evidence={
                        "highlight_span": span,
                        "claude_pattern": pattern_text,
                        "matched_fragment": fragment,
                    },
                )
            )
    if over_cap > 0:
        logger.warning(
            "strategy_c_deps_capped",
            item_id=item.id,
            kept=len(deps),
            dropped=over_cap,
            cap=_STRATEGY_C_MAX_DEPS_PER_ITEM,
            hint=(
                "Strategy C produced more grammar candidates than the per-item "
                "cap allows. Consider tightening the proxy's pattern-extraction "
                "prompt or narrowing the candidate query (ADR-024 §7)."
            ),
        )
    return deps


# =============================================================================
# Orchestration
# =============================================================================


CORPUS = "topik_dep_linker"  # load_state row label


@dataclass
class LinkerRunStats:
    items_processed: int = 0
    deps_inserted: int = 0
    deps_upgraded: int = 0
    deps_skipped: int = 0
    errors: int = 0
    per_strategy: dict[str, int] = field(default_factory=dict)


async def link_test(
    pool: AsyncConnectionPool,
    cfg: LinkerConfig,
    kiwi: KiwiClient,
    proxy: ClaudeProxyClient | None,
    test_number: int,
) -> LinkerRunStats:
    """Link all items for one TOPIK test. Per-test checkpoint."""
    log = logger.bind(test_number=test_number)
    source_path = f"topik_dep_linker:test={test_number}"

    # Checkpoint setup — separate connection so any failure on the inner
    # batch doesn't poison the checkpoint connection state.
    async with pool.connection() as conn:
        async with conn.transaction():
            cp: CheckpointRow = await get_or_create_checkpoint(
                conn, corpus=CORPUS, source_path=source_path
            )
            await mark_in_progress(
                conn,
                corpus=CORPUS,
                source_path=source_path,
                source_sha256=("0" * 64),  # not file-derived; placeholder
                items_in_source=0,  # will update after fetch
            )

    stats = LinkerRunStats()
    try:
        async with pool.connection() as conn:
            items = await fetch_items(conn, [test_number])
        log.info("items_fetched", count=len(items))
        if not items:
            async with pool.connection() as conn:
                async with conn.transaction():
                    await mark_complete(
                        conn, corpus=CORPUS, source_path=source_path
                    )
            return stats

        # Resume — skip items at-or-before the checkpoint cursor when
        # in_progress (REVIEW_C4 F1).
        #
        # The SQL in fetch_items ORDERs by (tt.test_number, ti.section,
        # ti.item_number) — a numeric/enum ordering. The pre-fix code
        # compared `source_id` strings LEXICALLY, which works for today's
        # zero-padded ids but silently breaks if the naming convention
        # drifts ("topik36-read-10" < "topik36-read-9" lexically would
        # cause item 10 to be re-processed or items 11-19 to be skipped
        # depending on the cutoff position).
        #
        # We encode the cursor as the same tuple SQL orders by so the
        # filter is grounded in the database's actual ordering, not in
        # whatever convention the loader happens to mint. Stored as a
        # zero-padded string for textual sortability in `last_item_id`
        # (TEXT column).
        if cp.status == "in_progress" and cp.last_item_id:
            cutoff = cp.last_item_id
            before = len(items)
            items = [it for it in items if _item_sort_key(it) > cutoff]
            log.info(
                "resume_after_checkpoint",
                remaining=len(items),
                skipped=before - len(items),
                cutoff=cutoff,
            )

        for batch_start in range(0, len(items), cfg.batch_size):
            batch = items[batch_start : batch_start + cfg.batch_size]
            batch_deps: list[Dependency] = []
            for item in batch:
                try:
                    a_deps = await _run_strategy_a(pool, item)
                    b_deps = await _run_strategy_b(pool, kiwi, item)
                    covered = bool(a_deps or b_deps)
                    c_deps: list[Dependency] = []
                    if cfg.use_claude and proxy is not None:
                        c_deps = await _run_strategy_c(pool, proxy, item, covered)
                    item_deps = a_deps + b_deps + c_deps
                    batch_deps.extend(item_deps)
                    stats.per_strategy["skill_tag"] = (
                        stats.per_strategy.get("skill_tag", 0) + len(a_deps)
                    )
                    stats.per_strategy["lemma_match"] = (
                        stats.per_strategy.get("lemma_match", 0) + len(b_deps)
                    )
                    stats.per_strategy["claude_analysis"] = (
                        stats.per_strategy.get("claude_analysis", 0) + len(c_deps)
                    )
                except Exception as err:
                    stats.errors += 1
                    log.error(
                        "item_linking_failed",
                        item_id=item.id,
                        source_id=item.source_id,
                        error=repr(err),
                    )
                stats.items_processed += 1

            if cfg.dry_run:
                log.info(
                    "dry_run_batch",
                    batch_size=len(batch),
                    deps_computed=len(batch_deps),
                )
            else:
                async with pool.connection() as conn:
                    async with conn.transaction():
                        write_stats = await write_deps(conn, batch_deps)
                        stats.deps_inserted += write_stats.inserted
                        stats.deps_upgraded += write_stats.upgraded
                        stats.deps_skipped += write_stats.skipped
                        # Cursor MUST be derived from the same SQL ordering
                        # key (test_number, section, item_number) — see the
                        # `resume_after_checkpoint` filter above (REVIEW_C4 F1).
                        last_id = _item_sort_key(batch[-1])
                        await checkpoint_progress(
                            conn,
                            corpus=CORPUS,
                            source_path=source_path,
                            last_item_id=last_id,
                            items_loaded_delta=len(batch),
                        )
                log.info(
                    "batch_written",
                    inserted=write_stats.inserted,
                    upgraded=write_stats.upgraded,
                    skipped=write_stats.skipped,
                )

        if not cfg.dry_run:
            async with pool.connection() as conn:
                async with conn.transaction():
                    await mark_complete(
                        conn, corpus=CORPUS, source_path=source_path
                    )
        return stats
    except Exception as err:
        log.error("test_linking_failed", error=repr(err))
        async with pool.connection() as conn:
            async with conn.transaction():
                await mark_failed(
                    conn,
                    corpus=CORPUS,
                    source_path=source_path,
                    error=repr(err),
                )
        raise


async def _run_strategy_a(
    pool: AsyncConnectionPool, item: TopikItemRow
) -> list[Dependency]:
    async with pool.connection() as conn:
        return await strategy_a_skill_tag(conn, item)


async def _run_strategy_b(
    pool: AsyncConnectionPool, kiwi: KiwiClient, item: TopikItemRow
) -> list[Dependency]:
    async with pool.connection() as conn:
        return await strategy_b_lemma_match(conn, kiwi, item)


async def _run_strategy_c(
    pool: AsyncConnectionPool,
    proxy: ClaudeProxyClient,
    item: TopikItemRow,
    covered: bool,
) -> list[Dependency]:
    async with pool.connection() as conn:
        return await strategy_c_claude(conn, proxy, item, covered)


async def run(cfg: LinkerConfig) -> LinkerRunStats:
    """Top-level entry point. Discovers tests in scope and links each."""
    loader_cfg = LoaderConfig(
        database_url=cfg.database_url,
        batch_size=cfg.batch_size,
        dry_run=cfg.dry_run,
        application_name="korean-master-linker",
    )
    log = logger.bind(use_claude=cfg.use_claude, dry_run=cfg.dry_run)
    overall = LinkerRunStats()
    kiwi = KiwiClient(cfg.kiwi_url, cfg.kiwi_timeout_s)
    proxy = (
        ClaudeProxyClient(cfg.proxy_url, cfg.proxy_token, cfg.proxy_timeout_s)
        if cfg.use_claude
        else None
    )
    try:
        async with open_pool(loader_cfg) as pool:
            # Discover the universe of test numbers.
            async with pool.connection() as conn:
                async with conn.cursor() as cur:
                    if cfg.test_numbers:
                        await cur.execute(
                            "SELECT DISTINCT test_number FROM topik_tests "
                            " WHERE test_number = ANY(%s) "
                            " ORDER BY test_number",
                            (cfg.test_numbers,),
                        )
                    else:
                        await cur.execute(
                            "SELECT DISTINCT test_number FROM topik_tests "
                            " ORDER BY test_number"
                        )
                    rows = await cur.fetchall()
            tests = [int(r[0]) for r in rows]
            log.info("tests_in_scope", count=len(tests), tests=tests[:5])

            for test_number in tests:
                try:
                    s = await link_test(pool, cfg, kiwi, proxy, test_number)
                    overall.items_processed += s.items_processed
                    overall.deps_inserted += s.deps_inserted
                    overall.deps_upgraded += s.deps_upgraded
                    overall.deps_skipped += s.deps_skipped
                    overall.errors += s.errors
                    for k, v in s.per_strategy.items():
                        overall.per_strategy[k] = overall.per_strategy.get(k, 0) + v
                except Exception as err:
                    log.error("test_failed", test_number=test_number, error=repr(err))
                    overall.errors += 1
    finally:
        await kiwi.close()
        if proxy is not None:
            await proxy.close()
    log.info(
        "run_complete",
        items=overall.items_processed,
        inserted=overall.deps_inserted,
        upgraded=overall.deps_upgraded,
        skipped=overall.deps_skipped,
        errors=overall.errors,
        per_strategy=overall.per_strategy,
    )
    return overall


# =============================================================================
# CLI
# =============================================================================


def parse_args(argv: list[str] | None = None) -> LinkerConfig:
    """Build a LinkerConfig from CLI args + env. Pydantic validates the result."""
    p = argparse.ArgumentParser(
        prog="link_topik_dependencies",
        description="Link TOPIK items to the grammar and vocab they test.",
    )
    p.add_argument("--use-claude", action="store_true",
                   help="Enable Strategy C (Claude). Default off — see cost note.")
    p.add_argument("--kiwi-url", default=os.environ.get("KIWI_URL", "http://kiwi:8000"))
    p.add_argument("--proxy-url",
                   default=os.environ.get("CLAUDE_PROXY_URL", "http://server:3000"))
    p.add_argument("--proxy-token", default=os.environ.get("CLAUDE_PROXY_TOKEN"))
    p.add_argument("--test-numbers", default=None,
                   help="Comma-separated test numbers, e.g. 36,47.")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--batch-size", type=int, default=50)
    p.add_argument("--log-level", default=os.environ.get("LOG_LEVEL", "info"))
    args = p.parse_args(argv)

    db = os.environ.get("DATABASE_URL")
    if not db:
        raise SystemExit("DATABASE_URL is required")
    test_numbers: list[int] | None = None
    if args.test_numbers:
        test_numbers = [int(x.strip()) for x in args.test_numbers.split(",") if x.strip()]

    return LinkerConfig(
        database_url=db,
        kiwi_url=args.kiwi_url,
        proxy_url=args.proxy_url,
        proxy_token=args.proxy_token,
        use_claude=args.use_claude,
        test_numbers=test_numbers,
        dry_run=args.dry_run,
        batch_size=args.batch_size,
        log_level=args.log_level,
    )


def main(argv: list[str] | None = None) -> int:
    cfg = parse_args(argv)
    configure_logging(cfg.log_level)
    stats = asyncio.run(run(cfg))
    # Exit non-zero if every single item failed — partial failure is OK
    # (logged at ERROR), but a total wipeout is operator-actionable.
    if stats.items_processed == 0:
        logger.warning("no_items_processed")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
