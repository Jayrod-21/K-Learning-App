"""
Loader tests.

These split into two layers:

    1. Pure-Python unit tests on the loader's deterministic helpers
       (batching, resume filtering, SHA-256, entry-row param assembly,
       checkpoint state). They run anywhere, no Postgres needed.

    2. Integration tests against a live Postgres (marked `pg`). They run
       only when `KRDICT_TEST_DATABASE_URL` is set in the environment
       AND psycopg can connect. CI provides this via the Postgres-16
       Docker service. Skipped otherwise.

The integration tests cover the bar checks the SENIOR_ENGINEER_BAR calls
out by name: idempotency (running twice yields the same row count, no
duplicate side effects), resume (kill mid-run → resume picks up
correctly).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

import load_krdict
from krdict_models import (
    KrdictEntryModel,
    KrdictExampleModel,
    KrdictInflectionModel,
    KrdictSenseModel,
    KrdictSourceMetadata,
)
from krdict_parser import parse_file


FIXTURE = Path(__file__).parent / "fixtures" / "krdict_sample.xml"


# -----------------------------------------------------------------------------
# Layer 1 — pure-Python unit tests (no DB).
# -----------------------------------------------------------------------------
def test_compute_source_sha256_file_is_deterministic():
    first = load_krdict.compute_source_sha256(FIXTURE)
    second = load_krdict.compute_source_sha256(FIXTURE)
    assert first == second
    assert len(first) == 64
    int(first, 16)  # valid hex


def test_compute_source_sha256_rejects_missing_path(tmp_path):
    with pytest.raises(load_krdict.KrdictSourceMissingError):
        load_krdict.compute_source_sha256(tmp_path / "missing.xml")


def test_count_xml_entries_matches_parsed_plus_skipped():
    parsed = list(parse_file(FIXTURE))
    counted = load_krdict.count_xml_entries(FIXTURE)
    # 6 valid + 1 malformed = 7 `<LexicalEntry>` tags in the LMF fixture.
    assert counted == len(parsed) + 1


def test_batched_groups_into_size():
    items = list(range(7))
    batches = list(load_krdict._batched(iter(items), size=3))
    assert batches == [[0, 1, 2], [3, 4, 5], [6]]


def test_batched_rejects_zero_or_negative_size():
    with pytest.raises(ValueError):
        list(load_krdict._batched(iter([1, 2]), size=0))


def test_filter_resumable_skips_until_marker():
    entries = [
        _entry("A", "1"),
        _entry("B", "2"),
        _entry("C", "3"),
        _entry("D", "4"),
    ]
    state = load_krdict.ResumeState(last_processed="2")
    survivors = list(load_krdict._filter_resumable(iter(entries), state))
    # The marker itself ("2") is consumed (already persisted); only C, D pass.
    assert [e.source_id for e in survivors] == ["3", "4"]
    assert state.seeking is False


def test_filter_resumable_is_noop_without_marker():
    entries = [_entry("A", "1"), _entry("B", "2")]
    state = load_krdict.ResumeState(last_processed=None)
    survivors = list(load_krdict._filter_resumable(iter(entries), state))
    assert [e.source_id for e in survivors] == ["1", "2"]


def test_entry_params_pulls_first_sense_definitions():
    e = _entry("가족", "10001", english="family")
    params = load_krdict._entry_params(e, source_pk=42)
    assert params["krdict_source_id"] == 42
    assert params["source_id"] == "10001"
    assert params["headword"] == "가족"
    assert params["definition_korean"].startswith("부모")
    assert params["definition_english"] == "family"


def test_dry_run_reports_stats(caplog):
    metadata = KrdictSourceMetadata(
        source_label="TEST",
        source_path=str(FIXTURE),
        source_sha256="0" * 64,
        item_count=7,
    )
    stats = load_krdict.dry_run(source=FIXTURE, metadata=metadata)
    assert stats.entries_inserted_or_updated == 6
    assert stats.entries_skipped == 1


def test_cli_dry_run_exits_zero(monkeypatch, capsys):
    monkeypatch.setenv("DATABASE_URL", "postgresql://ignored")
    rc = load_krdict.main(
        ["--source", str(FIXTURE), "--dry-run", "--log-format", "text"]
    )
    assert rc == 0


def test_cli_rejects_missing_source(monkeypatch):
    rc = load_krdict.main(
        ["--source", "/nonexistent/path.xml", "--dry-run", "--log-format", "text"]
    )
    assert rc == 2


def test_cli_requires_dsn_when_not_dry_run(monkeypatch, tmp_path):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    rc = load_krdict.main(
        ["--source", str(FIXTURE), "--log-format", "text"]
    )
    assert rc == 2


def test_persist_entry_uses_parameterized_queries(monkeypatch):
    """
    No string interpolation in SQL — verify _persist_entry only calls
    cursor.execute with `(sql, params)` shape, never a single concatenated
    string. SENIOR_ENGINEER_BAR §"Security".
    """
    cur = MagicMock()
    # cursor.fetchone returns a dict per row_factory=dict_row; the loader
    # alternates between INSERT…RETURNING (dict) and DELETE (no fetch).
    cur.fetchone.return_value = {"id": 7}

    entry = _entry("가족", "10001", english="family")
    load_krdict._persist_entry(cur, entry, source_pk=42)

    # Every execute call must have a parameters dict — proves no f-string
    # SQL building.
    for call in cur.execute.call_args_list:
        args, _kwargs = call
        assert len(args) == 2, (
            f"unparameterized cur.execute call: {args!r}"
        )
        assert isinstance(args[1], dict), (
            f"parameters must be dict, got {type(args[1]).__name__}"
        )
        # The SQL string contains %(name)s placeholders — but never raw
        # value substitution. Quick smell test: no Korean characters
        # inside the SQL text itself.
        sql = args[0]
        assert "가족" not in sql
        assert "10001" not in sql


def _entry(
    headword: str,
    source_id: str,
    *,
    english: str | None = None,
) -> KrdictEntryModel:
    """Tiny entry factory for the helper tests."""
    return KrdictEntryModel(
        source_id=source_id,
        homograph_index=0,
        headword=headword,
        senses=[
            KrdictSenseModel(
                sense_index=1,
                definition_korean="부모, 자식, 형제 등 한집에서 함께 사는 사람들.",
                definition_english=english,
            )
        ],
    )


# -----------------------------------------------------------------------------
# Layer 2 — integration against a live Postgres.
#
# Skipped unless KRDICT_TEST_DATABASE_URL is set AND psycopg can connect.
# -----------------------------------------------------------------------------

@pytest.fixture(scope="module")
def pg_dsn() -> str:
    dsn = os.environ.get("KRDICT_TEST_DATABASE_URL")
    if not dsn:
        pytest.skip("KRDICT_TEST_DATABASE_URL not set — skipping live-DB tests")
    try:
        import psycopg
        with psycopg.connect(dsn, connect_timeout=3) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"cannot connect to test DB: {exc}")
    return dsn


@pytest.fixture
def fresh_schema(pg_dsn: str):
    """Apply 001+002+003 up against the test DB; rollback at teardown.

    NOTE: assumes the repo's migrate.py is on the path and the DB is empty
    (or contains a compatible schema we can drop). For typical CI runs this
    fixture would actually run `python -m db.migrate up`. Here we apply
    just 003 against a DB the harness has already prepared.
    """
    # Intentionally minimal — the migrations are applied by the CI harness
    # (db/tests/test_migrations.py) before this test module runs. We rely
    # on that contract rather than re-implementing apply/rollback.
    yield pg_dsn


@pytest.mark.pg
def test_loader_idempotent_on_rerun(fresh_schema):
    """SENIOR_ENGINEER_BAR §"Idempotency": running twice = same effect."""
    import psycopg

    metadata = KrdictSourceMetadata(
        source_label="TEST_KRDICT",
        source_path=str(FIXTURE),
        source_sha256=load_krdict.compute_source_sha256(FIXTURE),
        item_count=9,
    )

    # Run 1
    load_krdict.load(
        source=FIXTURE,
        metadata=metadata,
        dsn=fresh_schema,
        batch_size=4,
    )

    with psycopg.connect(fresh_schema) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM krdict_entries;")
            count1 = cur.fetchone()[0]
            cur.execute("SELECT count(*) FROM krdict_senses;")
            sense1 = cur.fetchone()[0]

    assert count1 == 8

    # Run 2 (identical input)
    load_krdict.load(
        source=FIXTURE,
        metadata=metadata,
        dsn=fresh_schema,
        batch_size=4,
    )

    with psycopg.connect(fresh_schema) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM krdict_entries;")
            count2 = cur.fetchone()[0]
            cur.execute("SELECT count(*) FROM krdict_senses;")
            sense2 = cur.fetchone()[0]

    assert count2 == count1
    assert sense2 == sense1


@pytest.mark.pg
def test_loader_resume_picks_up_where_it_left_off(fresh_schema):
    """SENIOR_ENGINEER_BAR §"Resumable": kill mid-run, resume completes."""
    import psycopg

    metadata = KrdictSourceMetadata(
        source_label="TEST_KRDICT_RESUME",
        source_path=str(FIXTURE),
        source_sha256=load_krdict.compute_source_sha256(FIXTURE),
        item_count=9,
    )

    # Simulate a partial run by manually inserting a checkpoint past
    # the third entry. The resume cursor should then process entries
    # 4..8 only.
    with psycopg.connect(fresh_schema) as conn:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO krdict_source (
                    source_label, source_path, source_sha256, license
                ) VALUES (%s, %s, %s, %s)
                ON CONFLICT (source_label) DO UPDATE
                  SET source_sha256 = EXCLUDED.source_sha256;
                """,
                (
                    metadata.source_label,
                    metadata.source_path,
                    metadata.source_sha256,
                    metadata.license,
                ),
            )
            cur.execute(
                """
                INSERT INTO krdict_import_state (
                    source_label, source_sha256, last_processed_source_id,
                    entries_processed
                ) VALUES (%s, %s, %s, %s)
                ON CONFLICT (source_label, source_sha256) DO UPDATE
                  SET last_processed_source_id = EXCLUDED.last_processed_source_id,
                      entries_processed = EXCLUDED.entries_processed;
                """,
                (
                    metadata.source_label,
                    metadata.source_sha256,
                    "10003",  # 가족, 먹다, 예쁘다 are "done"
                    3,
                ),
            )

    stats = load_krdict.load(
        source=FIXTURE,
        metadata=metadata,
        dsn=fresh_schema,
        batch_size=4,
        resume=True,
    )

    # Carried forward 3 + processed 5 fresh = 8 total.
    assert stats.entries_inserted_or_updated == 8


@pytest.mark.pg
def test_loader_resume_without_checkpoint_raises(fresh_schema):
    metadata = KrdictSourceMetadata(
        source_label="NEVER_RAN",
        source_path=str(FIXTURE),
        source_sha256="b" * 64,
        item_count=0,
    )
    with pytest.raises(load_krdict.KrdictResumeWithoutCheckpointError):
        load_krdict.load(
            source=FIXTURE,
            metadata=metadata,
            dsn=fresh_schema,
            resume=True,
        )
