"""
Integration tests for the canonical-grammar dedup script.

These spin up a real Postgres 16 container via testcontainers (SQLite
explicitly forbidden by SENIOR_ENGINEER_BAR §2.testing — it lies about
enums, FKs, JSONB, and triggers).

Strategy:
    1. Apply migrations 001 through 006 via the runner.
    2. Seed the corpus_sources catalog + a handful of `kgiu_entries` rows
       across all three KGIU levels — chosen so a known overlap
       (e.g. -아/어도 appears in Beginner + Intermediate) AND a singleton
       (e.g. -느니 only in Advanced) are both represented.
    3. Run the clusterer in `apply` mode against the live DB.
    4. Assert:
       a. canonical_grammar has exactly N rows for the N unique
          pattern_keys we seeded.
       b. The overlapping form's two kgiu rows both point at the same
          canonical_grammar.id.
       c. The singleton points at its own canonical row, alone.
       d. Re-running is a no-op (idempotence).
       e. semantic_family heuristic produces SOMETHING (not "uncategorized"
          for a clear case like -아/어도 ≈ concession).
"""

from __future__ import annotations

import os
import pathlib
import sys

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
# Also ensure tools/ingest is on path (conftest already does this, but the
# DB test may be invoked from a runner that ignores the conftest).
INGEST_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(INGEST_DIR) not in sys.path:
    sys.path.insert(0, str(INGEST_DIR))

# Import the cluster module by its bare-module name (conftest path) so we
# don't require a `tools.ingest` package install.
import cluster_canonical_grammar as ccg  # noqa: E402
from canonical_grammar import (  # noqa: E402
    CanonicalCluster,
    PatternOccurrence,
)

try:
    import psycopg
    from testcontainers.postgres import PostgresContainer
except ImportError:  # pragma: no cover
    psycopg = None  # type: ignore[assignment]
    PostgresContainer = None  # type: ignore[assignment]


pytestmark = pytest.mark.skipif(
    PostgresContainer is None or psycopg is None,
    reason="testcontainers + psycopg required (pip install testcontainers[postgres] psycopg)",
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def pg_container():
    with PostgresContainer("postgres:16-alpine") as pg:
        yield pg


@pytest.fixture()
def dsn(pg_container) -> str:
    """A fresh-schema DSN per test."""
    raw = pg_container.get_connection_url()
    raw = raw.replace("postgresql+psycopg2://", "postgres://")
    raw = raw.replace("postgresql://", "postgres://")
    with psycopg.connect(raw, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute("DROP SCHEMA public CASCADE")
        cur.execute("CREATE SCHEMA public")
    return raw


@pytest.fixture()
def applied_db(dsn, monkeypatch):
    """Apply migrations 001…006 against the fresh DB."""
    from db import migrate  # type: ignore[import-not-found]

    monkeypatch.setenv("DATABASE_URL", dsn)
    migrations_dir = REPO_ROOT / "db" / "migrations"
    rc = migrate.main(["--migrations-dir", str(migrations_dir), "up"])
    assert rc == 0, "migration runner failed to apply 001…006"
    return dsn


def _seed_minimal_corpus(dsn: str) -> dict[str, int]:
    """Insert just enough rows to exercise the clusterer.

    Returns a map of (corpus, source_id) → kgiu_entries.id for later
    assertion lookups.
    """
    rows = [
        # source_id, corpus, level, pattern, title_en, category, prof
        ("kgiu-beg-u16-01", "kgiu_beginner",   "beginner",
         "A/V-(으)면", "When/if",       "condition", "basic"),
        ("kgiu-int-c11-01", "kgiu_intermediate", "intermediate",
         "A/V-(으)면", "If/when",       "condition", "L3"),
        ("kgiu-beg-u16-03", "kgiu_beginner",   "beginner",
         "A/V-아/어도", "Even if",       "concession", "basic"),
        ("kgiu-int-c11-03", "kgiu_intermediate", "intermediate",
         "-아/어도",    "Even if/though","concession", "L3"),
        # Advanced singleton.
        ("kgiu-adv-c01-01", "kgiu_advanced", "advanced",
         "-느니",       "Rather than",   "comparison", "L4"),
        # Polysemy pair — same form, distinct ordinals.
        ("kgiu-beg-u9-02",  "kgiu_beginner", "beginner",
         "A/V-(으)니까 ①", "Because",     "reason", "basic"),
        ("kgiu-beg-u20-02", "kgiu_beginner", "beginner",
         "V-(으)니까 ②", "Discovery upon",  "discovery", "basic"),
    ]
    out: dict[tuple[str, str], int] = {}
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        # corpus_sources are already seeded by migration 002. Look them up.
        cur.execute("SELECT corpus::text, id FROM corpus_sources")
        cs_map = dict(cur.fetchall())
        for source_id, corpus, level, pattern, title, cat, prof in rows:
            cur.execute(
                """
                INSERT INTO kgiu_entries (
                    corpus_source_id, corpus, source_id, book_level,
                    entry_type, source_book, source_pages, pattern,
                    title_en, category, proficiency, domain
                ) VALUES (
                    %s, %s::corpus, %s, %s::book_level,
                    'grammar', %s, %s, %s,
                    %s, %s, %s::proficiency_level, 'general'::content_domain
                ) RETURNING id
                """,
                (cs_map[corpus], corpus, source_id, level,
                 f"KGIU {level.title()}", [1], pattern, title, cat, prof),
            )
            (kgiu_id,) = cur.fetchone()
            out[(corpus, source_id)] = kgiu_id
        conn.commit()
    return out


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_apply_creates_canonical_rows(applied_db, monkeypatch, tmp_path):
    seeded = _seed_minimal_corpus(applied_db)
    monkeypatch.setenv("DATABASE_URL", applied_db)

    # Build synthetic clusters from the seeded rows (no source-JSON read).
    occurrences = [
        PatternOccurrence(
            corpus="kgiu_beginner", source_id="kgiu-beg-u16-01",
            pattern_raw="A/V-(으)면", pattern_normalized="(으)면",
            level="beginner", title_en="When/if", category="condition",
        ),
        PatternOccurrence(
            corpus="kgiu_intermediate", source_id="kgiu-int-c11-01",
            pattern_raw="A/V-(으)면", pattern_normalized="(으)면",
            level="intermediate", title_en="If/when", category="condition",
        ),
        PatternOccurrence(
            corpus="kgiu_beginner", source_id="kgiu-beg-u16-03",
            pattern_raw="A/V-아/어도", pattern_normalized="아/어도",
            level="beginner", title_en="Even if", category="concession",
        ),
        PatternOccurrence(
            corpus="kgiu_intermediate", source_id="kgiu-int-c11-03",
            pattern_raw="-아/어도", pattern_normalized="아/어도",
            level="intermediate", title_en="Even if/though", category="concession",
        ),
        PatternOccurrence(
            corpus="kgiu_advanced", source_id="kgiu-adv-c01-01",
            pattern_raw="-느니", pattern_normalized="느니",
            level="advanced", title_en="Rather than", category="comparison",
        ),
        PatternOccurrence(
            corpus="kgiu_beginner", source_id="kgiu-beg-u9-02",
            pattern_raw="A/V-(으)니까 ①", pattern_normalized="(으)니까",
            level="beginner", title_en="Because", category="reason",
        ),
        PatternOccurrence(
            corpus="kgiu_beginner", source_id="kgiu-beg-u20-02",
            pattern_raw="V-(으)니까 ②", pattern_normalized="(으)니까",
            level="beginner", title_en="Discovery upon", category="discovery",
        ),
    ]
    clusters = ccg._build_clusters(occurrences)

    # Apply: hand-call the internal upsert + backfill so we don't have to
    # write an intermediate file. argparse-glue would also work; this is
    # tighter for the assertion path.
    with psycopg.connect(applied_db) as conn, conn.cursor() as cur:
        ccg._ensure_table_exists(cur, _noop_log())
        ccg._upsert_clusters(cur, clusters, _noop_log())
        ccg._backfill_kgiu_entries(cur, clusters, _noop_log())
        conn.commit()

    # --- Assert ---

    with psycopg.connect(applied_db) as conn, conn.cursor() as cur:
        # 4 distinct pattern keys: (으)면, 아/어도, 느니, (으)니까.
        cur.execute("SELECT count(*) FROM canonical_grammar")
        assert cur.fetchone()[0] == 4

        # (으)면 has 2 kgiu rows on it (one per level).
        cur.execute(
            """
            SELECT count(*) FROM kgiu_entries k
            JOIN canonical_grammar c ON c.id = k.canonical_grammar_id
            WHERE c.pattern_key = %s
            """,
            ("(으)면",),
        )
        assert cur.fetchone()[0] == 2

        # 아/어도 ditto.
        cur.execute(
            """
            SELECT count(*) FROM kgiu_entries k
            JOIN canonical_grammar c ON c.id = k.canonical_grammar_id
            WHERE c.pattern_key = %s
            """,
            ("아/어도",),
        )
        assert cur.fetchone()[0] == 2

        # 느니: singleton.
        cur.execute(
            """
            SELECT count(*) FROM kgiu_entries k
            JOIN canonical_grammar c ON c.id = k.canonical_grammar_id
            WHERE c.pattern_key = %s
            """,
            ("느니",),
        )
        assert cur.fetchone()[0] == 1

        # The polysemous (으)니까 cluster is flagged for review.
        cur.execute(
            "SELECT (notes->>'needs_review')::boolean FROM canonical_grammar "
            "WHERE pattern_key = %s",
            ("(으)니까",),
        )
        assert cur.fetchone()[0] is True

        # Semantic family for 아/어도 is concession (not 'uncategorized').
        cur.execute(
            "SELECT semantic_family FROM canonical_grammar WHERE pattern_key = %s",
            ("아/어도",),
        )
        assert cur.fetchone()[0] == "concession"


def test_apply_is_idempotent(applied_db, monkeypatch):
    """Running apply twice produces no extra rows and no FK churn."""
    _seed_minimal_corpus(applied_db)
    monkeypatch.setenv("DATABASE_URL", applied_db)

    # Build a one-cluster scenario.
    clusters = ccg._build_clusters([
        PatternOccurrence(
            corpus="kgiu_beginner", source_id="kgiu-beg-u16-03",
            pattern_raw="A/V-아/어도", pattern_normalized="아/어도",
            level="beginner", title_en="Even if", category="concession",
        ),
        PatternOccurrence(
            corpus="kgiu_intermediate", source_id="kgiu-int-c11-03",
            pattern_raw="-아/어도", pattern_normalized="아/어도",
            level="intermediate", title_en="Even if/though", category="concession",
        ),
    ])
    with psycopg.connect(applied_db) as conn, conn.cursor() as cur:
        ccg._ensure_table_exists(cur, _noop_log())
        ccg._upsert_clusters(cur, clusters, _noop_log())
        ccg._backfill_kgiu_entries(cur, clusters, _noop_log())
        conn.commit()

    # Snapshot the version column on canonical_grammar.
    with psycopg.connect(applied_db) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT pattern_key, version FROM canonical_grammar ORDER BY pattern_key"
        )
        before = cur.fetchall()
        cur.execute(
            "SELECT corpus::text, source_id, canonical_grammar_id, version "
            "FROM kgiu_entries WHERE canonical_grammar_id IS NOT NULL "
            "ORDER BY source_id"
        )
        kgiu_before = cur.fetchall()

    # Run again. ZERO inserts, zero version bumps expected.
    with psycopg.connect(applied_db) as conn, conn.cursor() as cur:
        ccg._upsert_clusters(cur, clusters, _noop_log())
        ccg._backfill_kgiu_entries(cur, clusters, _noop_log())
        conn.commit()

    with psycopg.connect(applied_db) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT pattern_key, version FROM canonical_grammar ORDER BY pattern_key"
        )
        after = cur.fetchall()
        cur.execute(
            "SELECT corpus::text, source_id, canonical_grammar_id, version "
            "FROM kgiu_entries WHERE canonical_grammar_id IS NOT NULL "
            "ORDER BY source_id"
        )
        kgiu_after = cur.fetchall()

    assert before == after, "canonical_grammar.version churned on re-apply"
    assert kgiu_before == kgiu_after, "kgiu_entries.version churned on re-apply"


def test_known_overlapping_form_produces_one_canonical_row(applied_db, monkeypatch):
    """Regression: -아/어도 must end up with one canonical row pointing to
    BOTH the Beginner and Intermediate kgiu_entries rows."""
    seeded = _seed_minimal_corpus(applied_db)
    monkeypatch.setenv("DATABASE_URL", applied_db)

    clusters = ccg._build_clusters([
        PatternOccurrence(
            corpus="kgiu_beginner", source_id="kgiu-beg-u16-03",
            pattern_raw="A/V-아/어도", pattern_normalized="아/어도",
            level="beginner", title_en="Even if", category="concession",
        ),
        PatternOccurrence(
            corpus="kgiu_intermediate", source_id="kgiu-int-c11-03",
            pattern_raw="-아/어도", pattern_normalized="아/어도",
            level="intermediate", title_en="Even if/though", category="concession",
        ),
    ])
    with psycopg.connect(applied_db) as conn, conn.cursor() as cur:
        ccg._ensure_table_exists(cur, _noop_log())
        ccg._upsert_clusters(cur, clusters, _noop_log())
        ccg._backfill_kgiu_entries(cur, clusters, _noop_log())
        conn.commit()

    with psycopg.connect(applied_db) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT k.source_id, c.id AS canonical_id, c.canonical_pattern
              FROM kgiu_entries k
              JOIN canonical_grammar c ON c.id = k.canonical_grammar_id
             WHERE c.pattern_key = '아/어도'
             ORDER BY k.source_id
            """
        )
        rows = cur.fetchall()
    assert len(rows) == 2
    # Both rows reference the SAME canonical_id.
    assert rows[0][1] == rows[1][1]
    # Canonical surface preserved the most-formed alias.
    assert rows[0][2] == "A/V-아/어도"


def test_polysemy_one_ordinal_one_bare_flags_review(applied_db, monkeypatch):
    """REVIEW_C1 SHOULD-FIX-2: a cluster with one ordinal-marked member and
    one bare (implicit ①) member should be flagged for review.

    Pre-fix, this case slipped through because the detector only fired when
    >=2 distinct ordinals were present. Real-world example: a Beginner unit
    introduces -(으)니까 with no ordinal (sense ①), then a later Intermediate
    chapter introduces -(으)니까 ② — same surface key, ordinals = {'②'},
    bare_count = 1. The cluster is polysemous and the reviewer should split.
    """
    # Seed rows we can resolve back later.
    with psycopg.connect(applied_db) as conn, conn.cursor() as cur:
        cur.execute("SELECT corpus::text, id FROM corpus_sources")
        cs_map = dict(cur.fetchall())
        for source_id, corpus, level, pattern, title, cat in [
            ("kgiu-beg-u09-bare", "kgiu_beginner", "beginner",
             "-(으)니까", "Because", "reason"),
            ("kgiu-int-c01-marked", "kgiu_intermediate", "intermediate",
             "-(으)니까 ②", "Discovery upon", "discovery"),
        ]:
            cur.execute(
                """
                INSERT INTO kgiu_entries (
                    corpus_source_id, corpus, source_id, book_level, entry_type,
                    source_book, source_pages, pattern, title_en, category,
                    proficiency, domain
                ) VALUES (%s, %s::corpus, %s, %s::book_level, 'grammar', %s, %s, %s,
                          %s, %s, 'basic'::proficiency_level, 'general'::content_domain)
                """,
                (cs_map[corpus], corpus, source_id, level,
                 f"KGIU {level.title()}", [1], pattern, title, cat),
            )
        conn.commit()

    monkeypatch.setenv("DATABASE_URL", applied_db)

    clusters = ccg._build_clusters([
        PatternOccurrence(
            corpus="kgiu_beginner", source_id="kgiu-beg-u09-bare",
            pattern_raw="-(으)니까", pattern_normalized="(으)니까",
            level="beginner", title_en="Because", category="reason",
        ),
        PatternOccurrence(
            corpus="kgiu_intermediate", source_id="kgiu-int-c01-marked",
            pattern_raw="-(으)니까 ②", pattern_normalized="(으)니까",
            level="intermediate", title_en="Discovery upon", category="discovery",
        ),
    ])
    # One cluster covering both rows.
    assert len(clusters) == 1
    cluster = clusters[0]
    assert cluster.pattern_key == "(으)니까"
    assert cluster.needs_review is True, (
        "One-ordinal-one-bare polysemy must trigger needs_review "
        "(REVIEW_C1 SHOULD-FIX-2)"
    )
    assert cluster.review_reason is not None
    assert "bare" in cluster.review_reason.lower(), (
        "review_reason should mention the bare/implicit-① case so the "
        "reviewer knows what to look at"
    )


def test_manual_override_survives_reapply(applied_db, monkeypatch):
    """REVIEW_C1 SHOULD-FIX-1: a reviewer's manual polysemy split must
    survive subsequent `apply` runs.

    Setup mirrors the workflow documented in CANONICAL_GRAMMAR_README:
      1. Run `apply` once — clusters land, FK points at the auto canonical row.
      2. Reviewer creates a split: a second canonical row with pattern_key
         '(으)니까#discovery', re-points one kgiu row's FK to it, sets
         canonical_grammar_id_is_manual_override = TRUE in the same tx.
      3. Run `apply` again. The override row's FK MUST still point at the
         split (not the auto row), and its version MUST NOT have bumped.

    Pre-fix, step 3 silently clobbered the override (the WHERE clause only
    checked IS DISTINCT FROM auto_id, which was true after the split).
    """
    seeded = _seed_minimal_corpus(applied_db)
    monkeypatch.setenv("DATABASE_URL", applied_db)

    # Use the polysemy pair from the seed: kgiu-beg-u9-02 and kgiu-beg-u20-02
    # both normalize to "(으)니까".
    occurrences = [
        PatternOccurrence(
            corpus="kgiu_beginner", source_id="kgiu-beg-u9-02",
            pattern_raw="A/V-(으)니까 ①", pattern_normalized="(으)니까",
            level="beginner", title_en="Because", category="reason",
        ),
        PatternOccurrence(
            corpus="kgiu_beginner", source_id="kgiu-beg-u20-02",
            pattern_raw="V-(으)니까 ②", pattern_normalized="(으)니까",
            level="beginner", title_en="Discovery upon", category="discovery",
        ),
    ]
    clusters = ccg._build_clusters(occurrences)

    # 1. First apply — both rows point at the auto canonical row.
    with psycopg.connect(applied_db) as conn, conn.cursor() as cur:
        ccg._ensure_table_exists(cur, _noop_log())
        ccg._upsert_clusters(cur, clusters, _noop_log())
        ccg._backfill_kgiu_entries(cur, clusters, _noop_log())
        conn.commit()

    # 2. Reviewer splits the cluster.
    split_pattern_key = "(으)니까#discovery"
    with psycopg.connect(applied_db) as conn, conn.cursor() as cur:
        # Create the split canonical row.
        cur.execute(
            """
            INSERT INTO canonical_grammar (pattern_key, canonical_pattern,
                                            semantic_family, notes)
            VALUES (%s, %s, %s, %s::jsonb)
            RETURNING id
            """,
            (split_pattern_key, "V-(으)니까 ②", "discovery",
             '{"split_from": "(으)니까", "note": "manual review split"}'),
        )
        (split_id,) = cur.fetchone()
        # Re-point the kgiu-beg-u20-02 row at the split AND flag it.
        cur.execute(
            """
            UPDATE kgiu_entries
               SET canonical_grammar_id = %s,
                   canonical_grammar_id_is_manual_override = TRUE
             WHERE corpus = 'kgiu_beginner'::corpus
               AND source_id = 'kgiu-beg-u20-02'
            """,
            (split_id,),
        )
        conn.commit()

    # Snapshot expected state.
    with psycopg.connect(applied_db) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT canonical_grammar_id, version, "
            "       canonical_grammar_id_is_manual_override "
            "  FROM kgiu_entries "
            " WHERE corpus = 'kgiu_beginner'::corpus "
            "   AND source_id = 'kgiu-beg-u20-02'"
        )
        override_before = cur.fetchone()
    assert override_before[0] == split_id
    assert override_before[2] is True

    # 3. Re-run apply. The reviewer's split MUST survive.
    with psycopg.connect(applied_db) as conn, conn.cursor() as cur:
        ccg._upsert_clusters(cur, clusters, _noop_log())
        ccg._backfill_kgiu_entries(cur, clusters, _noop_log())
        conn.commit()

    with psycopg.connect(applied_db) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT canonical_grammar_id, version, "
            "       canonical_grammar_id_is_manual_override "
            "  FROM kgiu_entries "
            " WHERE corpus = 'kgiu_beginner'::corpus "
            "   AND source_id = 'kgiu-beg-u20-02'"
        )
        override_after = cur.fetchone()

    assert override_after[0] == split_id, (
        "Reviewer's manual override was clobbered by re-apply "
        "(REVIEW_C1 SHOULD-FIX-1)"
    )
    assert override_after[1] == override_before[1], (
        "Re-apply bumped version on a manually-overridden row — should be no-op"
    )
    assert override_after[2] is True, "Override sentinel was lost"

    # The other (non-override) row still points at the auto canonical row.
    with psycopg.connect(applied_db) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT canonical_grammar_id_is_manual_override "
            "  FROM kgiu_entries "
            " WHERE corpus = 'kgiu_beginner'::corpus "
            "   AND source_id = 'kgiu-beg-u9-02'"
        )
        (other_override,) = cur.fetchone()
    assert other_override is False, (
        "Non-overridden row should not have its sentinel set"
    )


def test_migration_006_down_then_up_round_trip(applied_db, monkeypatch):
    """REVIEW_C1 SHOULD-FIX-3: explicit round-trip test for migration 006.

    Apply already happened via the `applied_db` fixture. Drive `down` then
    `up` and assert the canonical_grammar table + kgiu FK column both go
    away and come back. Catches a future migration that adds a CASCADE-
    dependent object 006's down.sql doesn't know about.
    """
    from db import migrate  # type: ignore[import-not-found]

    monkeypatch.setenv("DATABASE_URL", applied_db)
    migrations_dir = REPO_ROOT / "db" / "migrations"

    # Helpers.
    def _has_canonical_grammar_table() -> bool:
        with psycopg.connect(applied_db) as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = current_schema() "
                "  AND table_name = 'canonical_grammar'"
            )
            return cur.fetchone() is not None

    def _has_fk_column() -> bool:
        with psycopg.connect(applied_db) as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_schema = current_schema() "
                "  AND table_name = 'kgiu_entries' "
                "  AND column_name = 'canonical_grammar_id'"
            )
            return cur.fetchone() is not None

    assert _has_canonical_grammar_table()
    assert _has_fk_column()

    # Roll back from the top down to (but not including) 006. The migrate
    # runner takes `--target 005` to mean "roll back so 005 is the highest
    # applied migration" — i.e., drop 006+.
    rc = migrate.main([
        "--migrations-dir", str(migrations_dir),
        "--allow-destructive",
        "--target", "005",
        "down",
    ])
    assert rc == 0, "migrate down to 005 failed"

    assert not _has_canonical_grammar_table(), (
        "canonical_grammar table survived migrate down — 006 down.sql is "
        "missing a DROP or a follow-up migration added a CASCADE-dependent "
        "object 006 doesn't know about"
    )
    assert not _has_fk_column(), (
        "kgiu_entries.canonical_grammar_id survived migrate down"
    )

    # Re-apply forward. Schema should be identical to where we started.
    rc = migrate.main(["--migrations-dir", str(migrations_dir), "up"])
    assert rc == 0, "migrate up from 005 failed"

    assert _has_canonical_grammar_table()
    assert _has_fk_column()


def test_fk_on_delete_set_null(applied_db, monkeypatch):
    """Deleting a canonical_grammar row must NULL the FK on its kgiu members
    (ADR-001 §D9; ON DELETE SET NULL). Source rows survive."""
    _seed_minimal_corpus(applied_db)
    clusters = ccg._build_clusters([
        PatternOccurrence(
            corpus="kgiu_advanced", source_id="kgiu-adv-c01-01",
            pattern_raw="-느니", pattern_normalized="느니",
            level="advanced", title_en="Rather than", category="comparison",
        ),
    ])
    with psycopg.connect(applied_db) as conn, conn.cursor() as cur:
        ccg._ensure_table_exists(cur, _noop_log())
        ccg._upsert_clusters(cur, clusters, _noop_log())
        ccg._backfill_kgiu_entries(cur, clusters, _noop_log())
        cur.execute("DELETE FROM canonical_grammar WHERE pattern_key = '느니'")
        conn.commit()
    with psycopg.connect(applied_db) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT canonical_grammar_id FROM kgiu_entries "
            "WHERE source_id = 'kgiu-adv-c01-01'"
        )
        (fk,) = cur.fetchone()
        assert fk is None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _NoopLogger:
    def info(self, *a, **k): pass
    def warning(self, *a, **k): pass
    def debug(self, *a, **k): pass
    def error(self, *a, **k): pass


def _noop_log():
    return _NoopLogger()
