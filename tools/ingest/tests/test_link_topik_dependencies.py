"""
Tests for link_topik_dependencies.py.

Two layers:

  * Pure-function unit tests — strategy logic in isolation, mocked Kiwi/Claude
    HTTP clients. Run anywhere, no Postgres required.

  * Integration tests — a real Postgres in Docker via testcontainers. We
    apply every migration, seed kgiu_entries + vocab_entries + topik_items
    rows directly with parameterized SQL, then run the linker's strategy
    functions and assert dependency rows are written as expected.

We do NOT spin up a real Kiwi or Claude HTTP server. Both clients are
swapped with in-process fakes that record their inputs and return canned
outputs — exactly the boundary SENIOR_ENGINEER_BAR §2 Testing prescribes
(mock at the boundary, not inside our code).
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

testcontainers = pytest.importorskip("testcontainers.postgres")
psycopg_pool = pytest.importorskip("psycopg_pool")
psycopg = pytest.importorskip("psycopg")

from testcontainers.postgres import PostgresContainer  # noqa: E402
from psycopg_pool import AsyncConnectionPool  # noqa: E402

# Allow imports of `link_topik_dependencies` and `loaders.runtime`.
import sys  # noqa: E402
INGEST_DIR = Path(__file__).resolve().parents[1]
if str(INGEST_DIR) not in sys.path:
    sys.path.insert(0, str(INGEST_DIR))

import link_topik_dependencies as ltd  # noqa: E402
from loaders.runtime import configure_logging  # noqa: E402


REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class FakeKiwiClient:
    """In-process replacement for KiwiClient. Returns canned lemmas by text."""

    def __init__(self, table: dict[str, list[tuple[str, str]]]) -> None:
        self._table = table
        self.calls: list[str] = []

    async def lemmas(self, text: str) -> list[tuple[str, str]]:
        self.calls.append(text)
        return list(self._table.get(text, []))

    async def close(self) -> None:
        pass


class FakeProxyClient:
    """In-process replacement for ClaudeProxyClient."""

    def __init__(self, table: dict[str, dict[str, Any] | None]) -> None:
        self._table = table
        self.calls: list[dict[str, Any]] = []

    async def identify_pattern(
        self, *, highlight_span: str, full_sentence: str, context_hint: str | None
    ) -> dict[str, Any] | None:
        self.calls.append(
            {
                "highlightSpan": highlight_span,
                "fullSentence": full_sentence,
                "contextHint": context_hint,
            }
        )
        return self._table.get(highlight_span)

    async def close(self) -> None:
        pass


# ---------------------------------------------------------------------------
# Postgres fixtures (module-scoped — one container per test module)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def pg_container():
    c = PostgresContainer("postgres:16-alpine")
    c.start()
    try:
        yield c
    finally:
        c.stop()


@pytest.fixture(scope="module")
def database_url(pg_container) -> str:
    url = pg_container.get_connection_url()
    return url.replace("postgresql+psycopg2://", "postgresql://")


async def _apply_migrations(url: str) -> None:
    files = sorted(MIGRATIONS_DIR.glob("*.up.sql"))
    async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
        for f in files:
            sql = f.read_text(encoding="utf-8")
            async with conn.transaction():
                async with conn.cursor() as cur:
                    await cur.execute(sql)


@pytest.fixture(scope="module")
def schema(database_url) -> str:
    configure_logging("warning")
    asyncio.run(_apply_migrations(database_url))
    return database_url


# ---------------------------------------------------------------------------
# Seed helpers — write the minimal rows each test needs.
# ---------------------------------------------------------------------------


async def _seed_corpus_source(conn, corpus: str, title: str) -> int:
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO corpus_sources (
                corpus, title, source_path, source_sha256
            ) VALUES (%s::corpus, %s, %s, %s)
            ON CONFLICT (corpus) DO UPDATE SET title = EXCLUDED.title
            RETURNING id
            """,
            (corpus, title, f"/fixture/{corpus}.json", "0" * 64),
        )
        row = await cur.fetchone()
        return int(row[0])


async def _seed_kgiu_entry(
    conn, *, source_id: str, pattern: str, category: str
) -> int:
    cs_id = await _seed_corpus_source(conn, "kgiu_intermediate", "KGIU Int Fixture")
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO kgiu_entries (
                corpus_source_id, corpus, source_id, book_level, entry_type,
                source_book, pattern, category, proficiency, domain)
            VALUES (%s, 'kgiu_intermediate'::corpus, %s, 'intermediate'::book_level,
                    'grammar', 'KGIU Int Fixture', %s, %s, 'L3'::proficiency_level,
                    'general'::content_domain)
            ON CONFLICT (corpus, source_id) DO UPDATE SET pattern = EXCLUDED.pattern
            RETURNING id
            """,
            (cs_id, source_id, pattern, category),
        )
        row = await cur.fetchone()
        return int(row[0])


async def _seed_vocab_entry(conn, *, source_id: str, korean: str) -> int:
    cs_id = await _seed_corpus_source(
        conn, "vocab_2000_intermediate", "Vocab 2000 Fixture"
    )
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO vocab_entries (
                corpus_source_id, corpus, source_id, book_level, entry_type,
                source_book, korean, proficiency, domain)
            VALUES (%s, 'vocab_2000_intermediate'::corpus, %s,
                    'intermediate'::book_level, 'word', 'Vocab 2000 Fixture',
                    %s, 'L3'::proficiency_level, 'general'::content_domain)
            ON CONFLICT (corpus, source_id) DO UPDATE SET korean = EXCLUDED.korean
            RETURNING id
            """,
            (cs_id, source_id, korean),
        )
        row = await cur.fetchone()
        return int(row[0])


async def _seed_topik_item(
    conn,
    *,
    test_number: int,
    section: str,
    source_id: str,
    item_number: int,
    skill_tag: str | None,
    stem: str,
    options: list[str],
    underline: str | None = None,
) -> int:
    cs_id = await _seed_corpus_source(conn, "topik", "TOPIK Fixture")
    async with conn.cursor() as cur:
        # topik_tests row
        await cur.execute(
            """
            INSERT INTO topik_tests (
                corpus_source_id, corpus, test_number, topik_level, section)
            VALUES (%s, 'topik'::corpus, %s, 'TOPIK II', %s::topik_section)
            ON CONFLICT (test_number, section) DO UPDATE
              SET topik_level = EXCLUDED.topik_level
            RETURNING id
            """,
            (cs_id, test_number, section),
        )
        row = await cur.fetchone()
        test_id = int(row[0])
        # topik_items row
        await cur.execute(
            """
            INSERT INTO topik_items (
                topik_test_id, corpus_source_id, corpus, source_id, item_number,
                section, item_type, skill_tag, stem, options, underline)
            VALUES (%s, %s, 'topik'::corpus, %s, %s, %s::topik_section,
                    'multiple_choice'::topik_item_type, %s, %s, %s::jsonb, %s)
            ON CONFLICT (corpus, source_id) DO UPDATE SET stem = EXCLUDED.stem
            RETURNING id
            """,
            (
                test_id,
                cs_id,
                source_id,
                item_number,
                section,
                skill_tag,
                stem,
                json.dumps(options),
                underline,
            ),
        )
        row = await cur.fetchone()
        return int(row[0])


async def _count_deps(conn, *, topik_item_id: int) -> int:
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT COUNT(*) FROM topik_dependencies WHERE topik_item_id = %s",
            (topik_item_id,),
        )
        row = await cur.fetchone()
    return int(row[0]) if row else 0


# ---------------------------------------------------------------------------
# Pure-function unit tests (no Postgres)
# ---------------------------------------------------------------------------


def test_skill_tag_mapping_includes_known_tags():
    """Every controlled-vocab grammar tag should map somewhere."""
    for tag in ("grammar-connective", "grammar-expression", "grammar-paraphrase"):
        assert tag in ltd.SKILL_TAG_TO_GRAMMAR_CATEGORY


def test_content_pos_filter_excludes_particles_and_endings():
    """Sanity: noun/verb/adj are in the set; particle/ending tags are not."""
    assert "NNG" in ltd._CONTENT_POS
    assert "VV" in ltd._CONTENT_POS
    assert "VA" in ltd._CONTENT_POS
    assert "JKB" not in ltd._CONTENT_POS  # adverbial particle
    assert "EF" not in ltd._CONTENT_POS   # final ending
    assert "ETM" not in ltd._CONTENT_POS  # adnominal ending


def test_dependency_xor_enforced_in_python():
    """Building a dep with both/neither FK set must be rejected by write_deps."""
    bad_both = ltd.Dependency(
        topik_item_id=1,
        dep_type="grammar",
        grammar_entry_id=5,
        vocab_entry_id=7,
        confidence=0.9,
        source="skill_tag",
    )

    async def run_it():
        # Fake conn — we never get past the XOR check.
        class Cur:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return None

            async def execute(self, *a, **kw):
                raise AssertionError("should not reach execute")

            async def fetchone(self):
                return None

        class Conn:
            def cursor(self):
                return Cur()

        with pytest.raises(ValueError, match="XOR violated"):
            await ltd.write_deps(Conn(), [bad_both])

    asyncio.run(run_it())


def test_strategy_b_returns_empty_when_kiwi_returns_no_lemmas(schema):
    """Lemma strategy is a no-op when Kiwi returns nothing — proves we don't
    write spurious deps just because the text exists."""
    url = schema

    async def run_it():
        async with await psycopg.AsyncConnection.connect(url) as conn:
            item = ltd.TopikItemRow(
                id=10**9,  # nonexistent — we never write
                source_id="fake",
                test_number=0,
                section="reading",
                item_number=1,
                skill_tag=None,
                stem="안녕",
                options=[],
            )
            kiwi = FakeKiwiClient({})  # empty table => no lemmas for any text
            deps = await ltd.strategy_b_lemma_match(conn, kiwi, item)
            assert deps == []
            assert "안녕" in kiwi.calls  # the stem was sent

    asyncio.run(run_it())


# ---------------------------------------------------------------------------
# Integration tests (real Postgres)
# ---------------------------------------------------------------------------


def test_strategy_a_writes_grammar_dep_per_matched_kgiu_entry(schema):
    """skill_tag='grammar-connective' maps to a category set; matched kgiu
    rows produce one dep each."""
    url = schema

    async def run_it():
        async with await psycopg.AsyncConnection.connect(url) as conn:
            await _seed_kgiu_entry(
                conn, source_id="kgiu-a-001", pattern="-(으)니까", category="connective"
            )
            await _seed_kgiu_entry(
                conn, source_id="kgiu-a-002", pattern="-(으)면", category="condition"
            )
            await _seed_kgiu_entry(
                conn, source_id="kgiu-a-003", pattern="-기 위해", category="reason"
            )
            # An entry in a non-matching category — must NOT be picked up.
            await _seed_kgiu_entry(
                conn, source_id="kgiu-a-noise", pattern="-시-", category="honorific"
            )
            await conn.commit()

            item_id = await _seed_topik_item(
                conn,
                test_number=901,
                section="reading",
                source_id="topik901-read-001",
                item_number=1,
                skill_tag="grammar-connective",
                stem="비가 (   ) 우산을 가져왔어요.",
                options=["오는데", "오니까", "오면서", "오든지"],
            )
            await conn.commit()

            item = ltd.TopikItemRow(
                id=item_id,
                source_id="topik901-read-001",
                test_number=901,
                section="reading",
                item_number=1,
                skill_tag="grammar-connective",
                stem="비가 (   ) 우산을 가져왔어요.",
                options=["오는데", "오니까", "오면서", "오든지"],
            )
            deps = await ltd.strategy_a_skill_tag(conn, item)
            assert len(deps) == 3  # three matched categories
            for d in deps:
                assert d.dep_type == "grammar"
                assert d.source == "skill_tag"
                assert d.confidence == 0.90
                assert d.grammar_entry_id is not None
                assert d.vocab_entry_id is None

            stats = await ltd.write_deps(conn, deps)
            await conn.commit()
            assert stats.inserted == 3
            assert await _count_deps(conn, topik_item_id=item_id) == 3

    asyncio.run(run_it())


def test_strategy_b_writes_vocab_deps_per_matched_lemma(schema):
    url = schema

    async def run_it():
        async with await psycopg.AsyncConnection.connect(url) as conn:
            v1 = await _seed_vocab_entry(conn, source_id="v-b-001", korean="오다")
            v2 = await _seed_vocab_entry(conn, source_id="v-b-002", korean="우산")
            await conn.commit()

            item_id = await _seed_topik_item(
                conn,
                test_number=902,
                section="reading",
                source_id="topik902-read-001",
                item_number=1,
                skill_tag=None,
                stem="비가 와서 우산을 가져왔어요.",
                options=["오다", "가다"],
            )
            await conn.commit()
            item = ltd.TopikItemRow(
                id=item_id,
                source_id="topik902-read-001",
                test_number=902,
                section="reading",
                item_number=1,
                skill_tag=None,
                stem="비가 와서 우산을 가져왔어요.",
                options=["오다", "가다"],
            )
            # Fake Kiwi returns canned lemmas for each text we send.
            kiwi = FakeKiwiClient({
                "비가 와서 우산을 가져왔어요.": [("오다", "VV"), ("우산", "NNG")],
                "오다": [("오다", "VV")],
                "가다": [("가다", "VV")],  # no matching vocab — should not produce a dep
            })

            deps = await ltd.strategy_b_lemma_match(conn, kiwi, item)
            # Expect one dep per unique matched vocab entry (오다, 우산).
            vocab_ids = {d.vocab_entry_id for d in deps}
            assert vocab_ids == {v1, v2}
            for d in deps:
                assert d.dep_type == "vocab"
                assert d.source == "lemma_match"
                assert d.confidence == 0.75

            stats = await ltd.write_deps(conn, deps)
            await conn.commit()
            assert stats.inserted == 2
            assert await _count_deps(conn, topik_item_id=item_id) == 2

    asyncio.run(run_it())


def test_idempotent_rerun_produces_no_new_rows(schema):
    """Running the linker twice on the same input must not insert duplicates."""
    url = schema

    async def run_it():
        async with await psycopg.AsyncConnection.connect(url) as conn:
            g_id = await _seed_kgiu_entry(
                conn, source_id="kgiu-i-001", pattern="-(으)니까", category="connective"
            )
            await conn.commit()
            item_id = await _seed_topik_item(
                conn,
                test_number=903,
                section="reading",
                source_id="topik903-read-001",
                item_number=1,
                skill_tag="grammar-connective",
                stem="x",
                options=["a", "b"],
            )
            await conn.commit()
            dep = ltd.Dependency(
                topik_item_id=item_id,
                dep_type="grammar",
                grammar_entry_id=g_id,
                confidence=0.90,
                source="skill_tag",
            )

            s1 = await ltd.write_deps(conn, [dep])
            await conn.commit()
            s2 = await ltd.write_deps(conn, [dep])
            await conn.commit()
            s3 = await ltd.write_deps(conn, [dep])
            await conn.commit()
            assert s1.inserted == 1
            assert s2.inserted == 0  # second run hits ON CONFLICT
            assert s3.inserted == 0
            assert await _count_deps(conn, topik_item_id=item_id) == 1

    asyncio.run(run_it())


def test_strategy_precedence_higher_confidence_wins(schema):
    """If two strategies identify the same (item, target), the higher-confidence
    row's source/evidence is what persists, and we end up with a single row."""
    url = schema

    async def run_it():
        async with await psycopg.AsyncConnection.connect(url) as conn:
            g_id = await _seed_kgiu_entry(
                conn, source_id="kgiu-p-001", pattern="-(으)면", category="condition"
            )
            await conn.commit()
            item_id = await _seed_topik_item(
                conn,
                test_number=904,
                section="reading",
                source_id="topik904-read-001",
                item_number=1,
                skill_tag="grammar-connective",
                stem="x",
                options=["a"],
            )
            await conn.commit()

            # First write: lower-confidence claude-derived row.
            low = ltd.Dependency(
                topik_item_id=item_id,
                dep_type="grammar",
                grammar_entry_id=g_id,
                confidence=0.65,
                source="claude_analysis",
                evidence={"note": "low"},
            )
            s1 = await ltd.write_deps(conn, [low])
            await conn.commit()
            assert s1.inserted == 1

            # Second write: higher-confidence skill_tag row — should upgrade.
            high = ltd.Dependency(
                topik_item_id=item_id,
                dep_type="grammar",
                grammar_entry_id=g_id,
                confidence=0.90,
                source="skill_tag",
                evidence={"note": "high"},
            )
            s2 = await ltd.write_deps(conn, [high])
            await conn.commit()
            assert s2.upgraded == 1
            assert s2.inserted == 0
            assert await _count_deps(conn, topik_item_id=item_id) == 1

            # Third write: lower-confidence again — must NOT downgrade.
            again_low = ltd.Dependency(
                topik_item_id=item_id,
                dep_type="grammar",
                grammar_entry_id=g_id,
                confidence=0.50,
                source="claude_analysis",
                evidence={"note": "even_lower"},
            )
            s3 = await ltd.write_deps(conn, [again_low])
            await conn.commit()
            assert s3.inserted == 0
            assert s3.upgraded == 0
            assert s3.skipped == 1

            # The row that survives is the high-confidence one.
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT confidence, source, evidence "
                    "  FROM topik_dependencies "
                    " WHERE topik_item_id = %s AND grammar_entry_id = %s",
                    (item_id, g_id),
                )
                row = await cur.fetchone()
            assert row is not None
            assert float(row[0]) == 0.90
            assert row[1] == "skill_tag"
            ev = row[2] if isinstance(row[2], dict) else json.loads(row[2])
            assert ev == {"note": "high"}

    asyncio.run(run_it())


def test_xor_constraint_rejected_at_db_level(schema):
    """Belt and suspenders: even if our Python check failed, the DB rejects
    a row where both FKs are set."""
    url = schema

    async def run_it():
        async with await psycopg.AsyncConnection.connect(url) as conn:
            g_id = await _seed_kgiu_entry(
                conn, source_id="kgiu-x-001", pattern="-아/어/여요", category="ending"
            )
            v_id = await _seed_vocab_entry(conn, source_id="v-x-001", korean="가다")
            await conn.commit()
            item_id = await _seed_topik_item(
                conn,
                test_number=905,
                section="reading",
                source_id="topik905-read-001",
                item_number=1,
                skill_tag=None,
                stem="x",
                options=[],
            )
            await conn.commit()
            with pytest.raises(psycopg.errors.CheckViolation):
                async with conn.cursor() as cur:
                    await cur.execute(
                        """
                        INSERT INTO topik_dependencies (
                            topik_item_id, dep_type, grammar_entry_id,
                            vocab_entry_id, confidence, source)
                        VALUES (%s, 'grammar'::topik_dependency_type, %s, %s,
                                0.5, 'manual')
                        """,
                        (item_id, g_id, v_id),
                    )
                await conn.commit()

    asyncio.run(run_it())


# ---------------------------------------------------------------------------
# REVIEW_C4 F1 — resume cursor ordering (regression: lexical vs numeric)
# ---------------------------------------------------------------------------


def test_item_sort_key_is_monotone_with_sql_ordering():
    """``_item_sort_key`` must order items the same way the SQL ORDER BY does.

    SQL: ORDER BY (test_number, section, item_number).
    Regression: pre-fix code compared raw ``source_id`` strings, so
    ``"topik36-read-10" < "topik36-read-9"`` lexically — a cursor at item
    9 would mistakenly RE-process item 10, or worse, a cursor at item 10
    would SKIP items 11-19 because ``"11" < "10"`` is false but ``"2" >
    "10"`` is true.

    This test pins three independent failure modes that catch the lexical
    bug:

      * Two items in the same test+section, ids 9 and 10 — numerical order
        is 9 < 10; lexical order on source_id ("topik36-read-9" vs
        "topik36-read-10") would invert it.
      * Two sections within the same test — reading before listening.
      * Two tests by number — test 5 before test 36 (lexical on
        "topik36-..." vs "topik5-..." inverts).
    """
    def make(test: int, section: str, item_no: int) -> ltd.TopikItemRow:
        return ltd.TopikItemRow(
            id=item_no,
            source_id=f"topik{test}-{section[:4]}-{item_no}",
            test_number=test,
            section=section,
            item_number=item_no,
            skill_tag=None,
            stem=None,
            options=[],
        )

    item_9 = make(36, "reading", 9)
    item_10 = make(36, "reading", 10)
    # Sanity check the lexical bug we're guarding against:
    assert item_9.source_id > item_10.source_id, (
        "Fixture invariant: lexical compare of source_id is inverted vs "
        "numeric item_number — this is exactly the bug F1 calls out."
    )
    # Post-fix: the sort key respects numeric order.
    assert ltd._item_sort_key(item_9) < ltd._item_sort_key(item_10)

    # Cross-section: reading < listening within the same test.
    read = make(36, "reading", 50)
    listen = make(36, "listening", 1)
    assert ltd._item_sort_key(read) < ltd._item_sort_key(listen)

    # Cross-test: test 5 < test 36.
    early = make(5, "reading", 99)
    late = make(36, "reading", 1)
    assert ltd._item_sort_key(early) < ltd._item_sort_key(late)


def test_resume_cursor_skips_at_or_before_and_keeps_after():
    """End-to-end resume filter: the cursor selects exactly the items
    AFTER the saved checkpoint, using the SQL-aligned key.

    The mock list is intentionally constructed so source_id lexical
    ordering DIFFERS from numeric item_number ordering (items 9, 10, 11).
    The filter must keep item 11 (after cursor at 10) and drop items 9
    and 10 (at-or-before cursor at 10). Pre-fix, lexical comparison
    on source_id would have produced the wrong skip set.
    """
    def make(item_no: int) -> ltd.TopikItemRow:
        return ltd.TopikItemRow(
            id=item_no,
            source_id=f"topik36-read-{item_no}",
            test_number=36,
            section="reading",
            item_number=item_no,
            skill_tag=None,
            stem=None,
            options=[],
        )

    items = [make(9), make(10), make(11)]
    cursor = ltd._item_sort_key(make(10))  # checkpoint at item 10

    surviving = [it for it in items if ltd._item_sort_key(it) > cursor]
    surviving_ids = {it.item_number for it in surviving}
    assert surviving_ids == {11}, (
        f"Resume after item 10 should yield {{11}} only; got {surviving_ids}. "
        f"Pre-fix lexical compare would have yielded {{9}} (wrong: "
        f"\"topik36-read-9\" > \"topik36-read-10\" lexically)."
    )


# ---------------------------------------------------------------------------
# REVIEW_C4 F3 — Strategy C dep cap
# ---------------------------------------------------------------------------


def test_strategy_c_caps_deps_per_item_and_rejects_short_fragments(schema):
    """Strategy C must (1) drop matches whose Hangul fragment is too short
    to discriminate, and (2) cap total deps per item.

    Pre-fix worst case: 4 spans × 25 candidates = 100 deps for one TOPIK
    item, and a single-syllable fragment like "오" would match every
    pattern containing that syllable.
    """
    url = schema

    async def run_it():
        async with await psycopg.AsyncConnection.connect(url) as conn:
            # Seed 12 grammar entries whose pattern contains "는데" — enough
            # for the candidate query to hit the cap (10) and over-cap (2).
            for i in range(12):
                await _seed_kgiu_entry(
                    conn,
                    source_id=f"kgiu-cap-{i:03d}",
                    pattern=f"-(으)ㄴ/는데 #{i}",
                    category="connective",
                )
            await conn.commit()

            item = ltd.TopikItemRow(
                id=42,
                source_id="topik-cap-test",
                test_number=1,
                section="reading",
                item_number=1,
                skill_tag="grammar-connective",
                stem="비가 오는데 우산이 없어요.",
                options=["오는데", "오"],  # second is too short
                underline=None,
            )

            # Fragment for the short option ("오") would be 1 Hangul char —
            # below the minimum (3). Fragment for "오는데" is 3 chars —
            # above the minimum. Proxy returns the option verbatim as the
            # claimed pattern.
            proxy = FakeProxyClient({
                "오는데": {"pattern": "오는데", "confidence": 0.8},
                "오": {"pattern": "오", "confidence": 0.8},
            })

            deps = await ltd.strategy_c_claude(
                conn, proxy, item, already_covered=False
            )

            # Cap should be respected.
            assert len(deps) <= ltd._STRATEGY_C_MAX_DEPS_PER_ITEM
            assert len(deps) == ltd._STRATEGY_C_MAX_DEPS_PER_ITEM, (
                f"Expected exactly {ltd._STRATEGY_C_MAX_DEPS_PER_ITEM} deps "
                f"(cap), got {len(deps)}"
            )

            # Short-fragment span must NOT have yielded any candidates — if
            # it had, the cap would have been hit earlier. We verify the
            # short span produced no DB lookup by checking the proxy was
            # called for it (proves it wasn't skipped at the proxy boundary)
            # but no dep traces back to "오".
            span_calls = [c["highlightSpan"] for c in proxy.calls]
            assert "오" in span_calls, "Proxy should have been queried"
            assert "오는데" in span_calls
            short_deps = [d for d in deps if d.evidence.get("matched_fragment") == "오"]
            assert short_deps == [], (
                "Strategy C must drop too-short fragments before the DB "
                "lookup (REVIEW_C4 F3)"
            )

    asyncio.run(run_it())


def test_strategy_c_uses_proxy_only_when_uncovered(schema):
    """Strategy C should be skipped when A or B already produced deps."""
    url = schema

    async def run_it():
        async with await psycopg.AsyncConnection.connect(url) as conn:
            await _seed_kgiu_entry(
                conn, source_id="kgiu-c-001", pattern="-(으)면", category="condition"
            )
            await conn.commit()
            item = ltd.TopikItemRow(
                id=1,
                source_id="x",
                test_number=0,
                section="reading",
                item_number=1,
                skill_tag=None,
                stem="비가 오면 우산을 써요.",
                options=["오면"],
                underline="오면",
            )
            proxy = FakeProxyClient({
                "오면": {"pattern": "-(으)면", "confidence": 0.8}
            })
            # Already covered → proxy must NOT be called.
            deps_skip = await ltd.strategy_c_claude(conn, proxy, item, already_covered=True)
            assert deps_skip == []
            assert proxy.calls == []
            # Not covered → proxy IS called and produces a dep.
            deps_run = await ltd.strategy_c_claude(conn, proxy, item, already_covered=False)
            assert len(deps_run) >= 1
            assert proxy.calls and proxy.calls[0]["highlightSpan"] == "오면"
            for d in deps_run:
                assert d.source == "claude_analysis"
                assert d.dep_type == "grammar"
                assert d.confidence == 0.8

    asyncio.run(run_it())
