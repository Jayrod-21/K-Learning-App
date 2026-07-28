"""
Tests for the TOPIK listening-audio loader (F-119 Phase 3) + migration 078.

Two tiers (same shape as test_load_ttmik_audio.py):

  1. PURE tests — ``parse_artifact`` / ``discover_artifacts`` against
     synthetic artifact JSONs in tmp_path. No Docker, no DB.
  2. INTEGRATION tests — real Postgres via testcontainers with the FULL real
     migration chain applied through ``migrate.main()`` (so 078's columns +
     CHECK arrive exactly as production gets them), seeded topik_tests /
     topik_items rows, sample artifacts on disk, the loader run through its
     real async-pool entry point. Asserts keyed writes, paired-span fan-out,
     provenance merge, the confidence gate, the --corpus-root sha256 drift
     guard, dry-run rollback, idempotency, stale-span convergence (each
     paper is a full clear-then-write, so a re-run against a regenerated
     artifact drops spans the artifact no longer claims), invalid-span
     refusal, whole-run abort on a malformed artifact mid-set, and report
     counts. Also proves 078 down/up round-trips and that the span CHECK
     itself bites.

NEVER touches km-db or the real corpus — every test paper gets its own
unique test_number so tests stay independent inside the shared container.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import itertools
import json
import sys
from pathlib import Path

import pytest

from loaders.load_topik_audio import (
    MAX_SPAN_MS,
    ArtifactError,
    PaperArtifact,
    Segment,
    _parse_args,
    discover_artifacts,
    parse_artifact,
    verify_source_mp3,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"

# ---------------------------------------------------------------------------
# Artifact fixture builders (pure — also used by the integration tier)
# ---------------------------------------------------------------------------

_SHA = "ee0709f190841d0d08327c30afdaa061171e196c96becadd77199ed02d967532"


def _artifact_dict(
    test_number: int,
    *,
    topik_level: str = "TOPIK II",
    segments: list[dict] | None = None,
    unresolved_items: list[int] | None = None,
    audio_sha256: str = _SHA,
) -> dict:
    lvl = "II" if topik_level == "TOPIK II" else "I"
    return {
        "test_number": test_number,
        "topik_level": topik_level,
        "source_mp3": (
            f"TOPIK TEST/{test_number} - test/{test_number}th-TOPIK-{lvl}"
            "-Listening-Audio.mp3"
        ),
        "audio_sha256": audio_sha256,
        "aligner_version": "1.0.0",
        "min_confidence": 0.5,
        "segments": segments if segments is not None else [],
        "unresolved_items": unresolved_items or [],
    }


def _write_mp3(corpus_root: Path, source_mp3: str, data: bytes) -> str:
    """Plant a fake MP3 at the artifact's corpus-relative key; returns its
    real sha256 (what a drift-clean artifact must carry)."""
    mp3_path = corpus_root / Path(source_mp3)
    mp3_path.parent.mkdir(parents=True, exist_ok=True)
    mp3_path.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


def _segment(
    item_numbers: list[int],
    start_ms: int,
    end_ms: int,
    *,
    confidence: float = 0.9,
    marker: str | None = None,
    low_confidence: bool = False,
) -> dict:
    return {
        "item_numbers": item_numbers,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "confidence": confidence,
        "marker": marker or ", ".join(f"{n}번" for n in item_numbers),
        "low_confidence": low_confidence,
    }


def _write_artifact(directory: Path, doc: dict) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    lvl = "II" if doc["topik_level"] == "TOPIK II" else "I"
    path = directory / f"topik_{doc['test_number']}_{lvl}_listening.json"
    path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Tier 1 — pure artifact parsing / discovery
# ---------------------------------------------------------------------------


def test_parse_artifact_round_trips_valid_document(tmp_path: Path) -> None:
    doc = _artifact_dict(
        60,
        segments=[
            _segment([1], 125390, 159520, confidence=0.925),
            _segment([21, 22], 1044720, 1193450, confidence=0.91),
        ],
        unresolved_items=[43],
    )
    paper = parse_artifact(_write_artifact(tmp_path, doc))
    assert isinstance(paper, PaperArtifact)
    assert paper.test_number == 60
    assert paper.topik_level == "TOPIK II"
    assert paper.source_mp3 == doc["source_mp3"]
    assert paper.audio_sha256 == _SHA
    assert paper.aligner_version == "1.0.0"
    assert paper.unresolved_items == (43,)
    assert paper.segments == (
        Segment(
            item_numbers=(1,),
            start_ms=125390,
            end_ms=159520,
            confidence=0.925,
            marker="1번",
            low_confidence=False,
        ),
        Segment(
            item_numbers=(21, 22),
            start_ms=1044720,
            end_ms=1193450,
            confidence=0.91,
            marker="21번, 22번",
            low_confidence=False,
        ),
    )
    # Span-value problems are deliberately NOT parse errors (the loader
    # refuses + counts them per segment) — the parsed model just reports.
    assert paper.segments[0].span_is_valid()


@pytest.mark.parametrize(
    ("mutate", "match"),
    [
        (lambda d: d.update(topik_level="TOPIK III"), "topik_level"),
        (lambda d: d.update(topik_level=2), "topik_level"),
        (lambda d: d.update(test_number="60"), "test_number"),
        (lambda d: d.update(test_number=True), "test_number"),
        (lambda d: d.update(source_mp3="/abs/path/audio.mp3"), "corpus-relative"),
        (lambda d: d.update(source_mp3="TOPIK TEST/../../etc/passwd"), "traverse"),
        (lambda d: d.update(source_mp3=""), "source_mp3"),
        (lambda d: d.update(source_mp3="C:\\TOPIK\\audio.mp3"), "backslash"),
        (lambda d: d.update(source_mp3="a\\..\\b.mp3"), "backslash"),
        (lambda d: d.update(source_mp3="C:/TOPIK/audio.mp3"), "drive/scheme"),
        (lambda d: d.update(source_mp3="..\\..\\etc\\shadow"), "backslash"),
        (lambda d: d.update(source_mp3="C:/Windows/evil.mp3"), "drive/scheme"),
        (lambda d: d.update(source_mp3="a/C:/x.mp3"), "drive/scheme"),  # mid-key
        (lambda d: d["segments"].append(_segment([1], 2000, 3000)), "disjoint"),
        (lambda d: d["segments"][0].update(item_numbers=[2, 2]), "disjoint"),
        (lambda d: d.update(unresolved_items=[1]), "both in a segment"),
        (lambda d: d.update(audio_sha256=None), "audio_sha256"),
        (lambda d: d.update(audio_sha256="deadbeef"), "hex sha256"),  # truncated
        (lambda d: d.update(audio_sha256=_SHA.upper()), "hex sha256"),  # case
        (lambda d: d.update(audio_sha256=_SHA[:-1] + "g"), "hex sha256"),
        (lambda d: d.update(aligner_version=""), "aligner_version"),
        (lambda d: d.update(segments={"not": "a list"}), "segments"),
        (lambda d: d["segments"][0].update(item_numbers=[]), "item_numbers"),
        (lambda d: d["segments"][0].update(item_numbers=[0]), ">= 1"),
        (lambda d: d["segments"][0].update(start_ms="soon"), "start_ms"),
        (lambda d: d["segments"][0].update(end_ms=None), "end_ms"),
        (lambda d: d["segments"][0].update(confidence="high"), "confidence"),
        (lambda d: d["segments"][0].update(low_confidence="no"), "low_confidence"),
    ],
)
def test_parse_artifact_rejects_malformed(tmp_path: Path, mutate, match: str) -> None:
    doc = _artifact_dict(60, segments=[_segment([1], 0, 1000)])
    mutate(doc)
    path = _write_artifact(tmp_path, doc)
    with pytest.raises(ArtifactError, match=match):
        parse_artifact(path)


def test_parse_artifact_rejects_invalid_json(tmp_path: Path) -> None:
    path = tmp_path / "topik_60_II_listening.json"
    path.write_text("{ not json", encoding="utf-8")
    with pytest.raises(ArtifactError, match="invalid JSON"):
        parse_artifact(path)


def test_span_is_valid_enforces_24h_upper_bound() -> None:
    """An oversized offset (078's columns are INTEGER) is refused as an
    invalid span — never presented to psycopg to overflow."""

    def seg(start_ms: int, end_ms: int) -> Segment:
        return Segment(
            item_numbers=(1,),
            start_ms=start_ms,
            end_ms=end_ms,
            confidence=0.9,
            marker="1번",
            low_confidence=False,
        )

    assert seg(0, MAX_SPAN_MS).span_is_valid()  # boundary: 24 h exactly is OK
    assert not seg(0, MAX_SPAN_MS + 1).span_is_valid()
    assert not seg(0, 2**31).span_is_valid()  # the INTEGER-overflow shape
    assert not seg(2**31, 2**31 + 1000).span_is_valid()


def test_parse_args_rejects_out_of_range_min_confidence() -> None:
    """--min-confidence outside 0.0-1.0 is a usage error → argparse exit 2."""
    with pytest.raises(SystemExit) as excinfo:
        _parse_args(["--min-confidence", "1.5"])
    assert excinfo.value.code == 2
    with pytest.raises(SystemExit) as excinfo:
        _parse_args(["--min-confidence", "-0.1"])
    assert excinfo.value.code == 2


def test_discover_artifacts_sorted_and_filtered(tmp_path: Path) -> None:
    _write_artifact(tmp_path, _artifact_dict(60))
    _write_artifact(tmp_path, _artifact_dict(35, topik_level="TOPIK I"))
    (tmp_path / "notes.json").write_text("{}", encoding="utf-8")  # not an artifact
    found = discover_artifacts(tmp_path)
    assert [p.name for p in found] == [
        "topik_35_I_listening.json",
        "topik_60_II_listening.json",
    ]


def test_discover_artifacts_fails_loud_on_missing_dir(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="--artifacts-dir"):
        discover_artifacts(tmp_path / "nowhere")


def test_discover_artifacts_fails_loud_on_empty_dir(tmp_path: Path) -> None:
    """A mispointed dir must never read as '0 papers mapped, exit 0'."""
    with pytest.raises(FileNotFoundError, match="no topik_"):
        discover_artifacts(tmp_path)


def test_verify_source_mp3_accepts_matching_hash(tmp_path: Path) -> None:
    corpus = tmp_path / "corpus"
    data = b"fake mp3 bytes for the drift guard"
    doc = _artifact_dict(60, audio_sha256=hashlib.sha256(data).hexdigest())
    _write_mp3(corpus, doc["source_mp3"], data)
    paper = parse_artifact(_write_artifact(tmp_path / "artifacts", doc))
    assert verify_source_mp3(paper, corpus) is None


def test_verify_source_mp3_refuses_mismatch_and_missing(tmp_path: Path) -> None:
    """The F-185 lesson: changed media under a stored key must be refused,
    with the reason naming the artifact vs actual hashes."""
    corpus = tmp_path / "corpus"
    doc = _artifact_dict(60)  # carries _SHA — not the hash of these bytes
    _write_mp3(corpus, doc["source_mp3"], b"re-encoded audio, new bytes")
    paper = parse_artifact(_write_artifact(tmp_path / "artifacts", doc))
    reason = verify_source_mp3(paper, corpus)
    assert reason is not None and "sha256 mismatch" in reason
    assert _SHA in reason  # names what the artifact expected

    # Missing file entirely → refused too (never "can't check, load anyway").
    missing = parse_artifact(
        _write_artifact(
            tmp_path / "artifacts2", _artifact_dict(35, topik_level="TOPIK I")
        )
    )
    reason = verify_source_mp3(missing, corpus)
    assert reason is not None and "not found" in reason


# ---------------------------------------------------------------------------
# Tier 2 — integration against a throwaway Postgres (testcontainers) with the
# REAL migration chain applied via migrate.main() (bookkeeping included).
# ---------------------------------------------------------------------------

testcontainers = pytest.importorskip("testcontainers.postgres")
psycopg = pytest.importorskip("psycopg")
psycopg_pool = pytest.importorskip("psycopg_pool")

from psycopg_pool import AsyncConnectionPool  # noqa: E402
from testcontainers.postgres import PostgresContainer  # noqa: E402

from loaders import load_topik_audio  # noqa: E402
from loaders.runtime import LoaderConfig, configure_logging  # noqa: E402

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from db import migrate  # noqa: E402

# ---------------------------------------------------------------------------
# CLI exit contract — main()/_parse_args level, no DB container (the pool +
# load are faked). Sits below the importorskip because main() imports
# loaders.runtime (psycopg) even on the paths that never touch a database.
# Contract under test = the EXIT CODES block in the loader's module docstring.
# ---------------------------------------------------------------------------


def test_main_exits_2_without_database_url(monkeypatch) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert load_topik_audio.main([]) == 2


def _fake_report(**overrides) -> dict:
    report = {
        "status": "complete",
        "dry_run": False,
        "drift_check_enabled": False,
        "papers_total": 1,
        "papers_mapped": 1,
        "papers_skipped_empty": 0,
        "papers_without_spans": 0,
        "tests_without_row": 0,
        "drift_mismatch": 0,
        "items_updated": 1,
        "items_skipped_low_conf": 0,
        "segments_without_matching_item": 0,
        "segments_invalid_span": 0,
        "items_without_segment": 0,
    }
    report.update(overrides)
    return report


@pytest.mark.parametrize(
    ("overrides", "expected_exit"),
    [
        ({}, 0),  # clean run
        ({"segments_invalid_span": 1}, 1),  # corrupt artifact span
        ({"drift_mismatch": 1}, 1),  # audio drifted under a stored key
        ({"tests_without_row": 1}, 1),  # expected paper row missing (SF-2)
        ({"papers_without_spans": 1}, 1),  # admitted paper landed zero spans
    ],
)
def test_main_exit_code_reflects_report(
    monkeypatch, overrides: dict, expected_exit: int
) -> None:
    """main() must read 1 whenever the environment/artifacts are wrong —
    a regression to 'always 0' (or dropping any refusal counter from the
    gate) fails here without any database."""
    from loaders import runtime as loaders_runtime

    monkeypatch.setenv("DATABASE_URL", "postgresql://fake:fake@nowhere:5432/x")

    @contextlib.asynccontextmanager
    async def fake_open_pool(cfg):
        yield None  # main() only hands the pool to load(), which is faked too

    async def fake_load(pool, source_path, cfg, **kwargs):
        return _fake_report(**overrides)

    monkeypatch.setattr(loaders_runtime, "open_pool", fake_open_pool)
    monkeypatch.setattr(load_topik_audio, "load", fake_load)
    assert load_topik_audio.main([]) == expected_exit


@pytest.fixture(scope="module")
def pg_container():
    container = PostgresContainer("postgres:16-alpine")
    container.start()
    try:
        yield container
    finally:
        container.stop()


@pytest.fixture(scope="module")
def database_url(pg_container) -> str:
    url = pg_container.get_connection_url()
    return url.replace("postgresql+psycopg2://", "postgresql://")


@pytest.fixture(scope="module")
def schema(database_url):
    """Apply the FULL production migration chain (…including 078) through the
    real runner — schema_migrations bookkeeping and all — exactly as km-db
    receives it."""
    configure_logging("warning")
    mp = pytest.MonkeyPatch()
    mp.setenv("DATABASE_URL", database_url)
    try:
        # --allow-destructive: migration 045 (hygiene_cleanup, DROP TABLE)
        # sits in the chain, so a full `up` trips migrate.py's destructive
        # gate without the flag (same as db/tests/test_migration_046.py).
        rc = migrate.main(
            ["--migrations-dir", str(MIGRATIONS_DIR), "--allow-destructive", "up"]
        )
        assert rc == 0, f"migrate.main up returned {rc} — migration chain is red"
        yield database_url
    finally:
        mp.undo()


async def _exec(url: str, sql: str, params: tuple = ()) -> list[tuple]:
    async with (
        await psycopg.AsyncConnection.connect(url, autocommit=True) as conn,
        conn.cursor() as cur,
    ):
        await cur.execute(sql, params)
        if cur.description is None:
            return []
        return await cur.fetchall()


# Unique test_numbers per test function → tests are independent inside the
# shared module-scoped container (no cross-test row interference).
_test_numbers = itertools.count(60)


async def _seed_paper(
    url: str,
    *,
    test_number: int,
    topik_level: str = "TOPIK II",
    section: str = "listening",
    item_numbers: list[int] = (),
    extra_by_item: dict[int, dict] | None = None,
) -> int:
    """Seed one topik_tests row + its items; returns the test id."""
    extra_by_item = extra_by_item or {}
    async with (
        await psycopg.AsyncConnection.connect(url) as conn,
        conn.transaction(),
        conn.cursor() as cur,
    ):
        await cur.execute(
            """
            INSERT INTO corpus_sources
                (corpus, title, source_path, default_proficiency)
            VALUES ('topik'::corpus, 'TOPIK', 'topik.json',
                    'L3'::proficiency_level)
            ON CONFLICT (corpus) DO UPDATE SET title = EXCLUDED.title
            RETURNING id
            """
        )
        row = await cur.fetchone()
        src_id = int(row[0])
        await cur.execute(
            """
            INSERT INTO topik_tests
                (corpus_source_id, test_number, topik_level, section)
            VALUES (%s, %s, %s, %s::topik_section)
            RETURNING id
            """,
            (src_id, test_number, topik_level, section),
        )
        row = await cur.fetchone()
        test_id = int(row[0])
        for n in item_numbers:
            await cur.execute(
                """
                INSERT INTO topik_items
                    (topik_test_id, corpus_source_id, source_id,
                     item_number, section, item_type, stem, extra)
                VALUES (%s, %s, %s, %s, %s::topik_section,
                        'multiple_choice'::topik_item_type, %s, %s::jsonb)
                """,
                (
                    test_id,
                    src_id,
                    (
                        f"topik{test_number}-{topik_level[-2:].strip()}-"
                        f"{section}-{n:03d}"
                    ),
                    n,
                    section,
                    f"stem {n}",
                    json.dumps(extra_by_item.get(n, {})),
                ),
            )
    return test_id


def _run_loader(
    url: str,
    artifacts_dir: Path,
    *,
    min_confidence: float = 0.0,
    dry_run: bool = False,
    corpus_root: Path | None = None,
) -> dict:
    cfg = LoaderConfig(database_url=url, dry_run=dry_run)

    async def go() -> dict:
        async with AsyncConnectionPool(url, min_size=1, max_size=2, open=False) as pool:
            await pool.open(wait=True, timeout=15)
            return await load_topik_audio.load(
                pool,
                artifacts_dir,
                cfg,
                min_confidence=min_confidence,
                corpus_root=corpus_root,
            )

    return asyncio.run(go())


def _item_rows(url: str, test_id: int) -> list[tuple]:
    """(item_number, start, end, extra) for every item of a test, ordered."""
    return asyncio.run(
        _exec(
            url,
            """
            SELECT item_number, audio_start_ms, audio_end_ms, extra
              FROM topik_items WHERE topik_test_id = %s ORDER BY item_number
            """,
            (test_id,),
        )
    )


def _audio_path(url: str, test_id: int):
    rows = asyncio.run(
        _exec(url, "SELECT audio_path FROM topik_tests WHERE id = %s", (test_id,))
    )
    return rows[0][0]


def test_loader_maps_paper_offsets_provenance_and_report(schema, tmp_path):
    """Happy path: audio_path on the RIGHT test row only, spans on the right
    items, paired items share the identical span, provenance lands under
    extra.audio_seg with pre-existing extra keys preserved, and every report
    count is exact."""
    url = schema
    n = next(_test_numbers)
    # Same test_number, both levels + a reading section row — the keyed
    # UPDATE must hit ONLY the TOPIK II listening paper.
    listening_id = asyncio.run(
        _seed_paper(
            url,
            test_number=n,
            item_numbers=[1, 2, 21, 22, 50],
            extra_by_item={22: {"keep": "me"}},
        )
    )
    other_level_id = asyncio.run(
        _seed_paper(url, test_number=n, topik_level="TOPIK I", item_numbers=[1])
    )
    reading_id = asyncio.run(
        _seed_paper(url, test_number=n, section="reading", item_numbers=[1])
    )

    doc = _artifact_dict(
        n,
        segments=[
            _segment([1], 125390, 159520, confidence=0.925),
            _segment([2], 159520, 182200, confidence=0.4),
            _segment([21, 22], 1044720, 1193450, confidence=0.91),
            _segment([7], 400000, 410000),  # no DB item 7 → counted, not fatal
        ],
    )
    _write_artifact(tmp_path, doc)

    report = _run_loader(url, tmp_path)
    assert report == {
        "status": "complete",
        "dry_run": False,
        "drift_check_enabled": False,  # no --corpus-root → skipped, noted
        "papers_total": 1,
        "papers_mapped": 1,
        "papers_skipped_empty": 0,
        "papers_without_spans": 0,
        "tests_without_row": 0,
        "drift_mismatch": 0,
        "items_updated": 4,  # 1, 2, 21, 22
        "items_skipped_low_conf": 0,  # gate defaults to 0.0 = write all
        "segments_without_matching_item": 1,  # item 7
        "segments_invalid_span": 0,
        "items_without_segment": 1,  # item 50
    }

    assert _audio_path(url, listening_id) == doc["source_mp3"]
    assert _audio_path(url, other_level_id) is None
    assert _audio_path(url, reading_id) is None

    rows = _item_rows(url, listening_id)
    by_number = {r[0]: r for r in rows}
    assert by_number[1][1:3] == (125390, 159520)
    assert by_number[2][1:3] == (159520, 182200)
    # Paired items carry the IDENTICAL span (078's denormalization).
    assert by_number[21][1:3] == by_number[22][1:3] == (1044720, 1193450)
    # The span-less DB item stays NULL.
    assert by_number[50][1:3] == (None, None)
    # Other-level / reading items untouched.
    assert _item_rows(url, other_level_id)[0][1:3] == (None, None)

    expected_seg = {
        "confidence": 0.91,
        "marker": "21번, 22번",
        "low_confidence": False,
        "audio_sha256": _SHA,
        "aligner_version": "1.0.0",
    }
    assert by_number[21][3] == {"audio_seg": expected_seg}
    # Pre-existing extra keys survive the jsonb_set merge.
    assert by_number[22][3] == {"keep": "me", "audio_seg": expected_seg}
    assert by_number[50][3] == {}


def test_min_confidence_gate_skips_low_segments(schema, tmp_path):
    url = schema
    n = next(_test_numbers)
    test_id = asyncio.run(_seed_paper(url, test_number=n, item_numbers=[1, 2, 3]))
    _write_artifact(
        tmp_path,
        _artifact_dict(
            n,
            segments=[
                _segment([1], 0, 1000, confidence=0.95),
                _segment([2, 3], 1000, 2000, confidence=0.45, low_confidence=True),
            ],
        ),
    )

    report = _run_loader(url, tmp_path, min_confidence=0.5)
    assert report["items_updated"] == 1
    assert report["items_skipped_low_conf"] == 2  # both paired items
    assert report["items_without_segment"] == 2

    by_number = {r[0]: r for r in _item_rows(url, test_id)}
    assert by_number[1][1:3] == (0, 1000)
    # Below-gate items stay transcript-only: no span, no provenance.
    assert by_number[2][1:3] == (None, None)
    assert by_number[3][1:3] == (None, None)
    assert by_number[2][3] == {}
    # audio_path still maps — the paper HAS audio; only these items lack spans.
    assert _audio_path(url, test_id) is not None


def test_min_confidence_boundary_equal_is_written(schema, tmp_path):
    """SF-4 guard: the gate is strict `<` — a segment whose confidence
    EQUALS --min-confidence IS written (a `<=` regression fails here)."""
    url = schema
    n = next(_test_numbers)
    test_id = asyncio.run(_seed_paper(url, test_number=n, item_numbers=[1]))
    _write_artifact(
        tmp_path,
        _artifact_dict(n, segments=[_segment([1], 0, 1000, confidence=0.5)]),
    )

    report = _run_loader(url, tmp_path, min_confidence=0.5)
    assert report["items_updated"] == 1
    assert report["items_skipped_low_conf"] == 0
    assert _item_rows(url, test_id)[0][1:3] == (0, 1000)
    assert _audio_path(url, test_id) is not None


def test_all_segments_refused_sets_no_audio_path(schema, tmp_path):
    """A paper whose EVERY segment is refused (invalid spans here) must not
    get an audio_path — no offsets exist to serve, the same rule as the
    zero-segment skip. The run still surfaces the refusals."""
    url = schema
    n = next(_test_numbers)
    test_id = asyncio.run(_seed_paper(url, test_number=n, item_numbers=[1, 2]))
    _write_artifact(
        tmp_path,
        _artifact_dict(
            n,
            segments=[
                _segment([1], 5000, 5000),  # end == start → invalid
                _segment([2], -10, 1000),  # negative start → invalid
            ],
        ),
    )

    report = _run_loader(url, tmp_path)
    assert report["status"] == "complete_with_refusals"
    assert report["segments_invalid_span"] == 2
    assert report["items_updated"] == 0
    # Admitted but zero spans landed → counted, not "mapped".
    assert report["papers_mapped"] == 0
    assert report["papers_without_spans"] == 1
    assert _audio_path(url, test_id) is None
    for row in _item_rows(url, test_id):
        assert row[1:3] == (None, None)


def test_zero_segment_artifact_sets_no_audio_path(schema, tmp_path):
    """The corrupt papers: an artifact with 0 segments must NOT set an
    audio_path it has no offsets for."""
    url = schema
    n = next(_test_numbers)
    test_id = asyncio.run(_seed_paper(url, test_number=n, item_numbers=[1]))
    _write_artifact(tmp_path, _artifact_dict(n, segments=[]))

    report = _run_loader(url, tmp_path)
    assert report["papers_skipped_empty"] == 1
    assert report["papers_mapped"] == 0
    # Benign skip, not an admitted-paper refusal — the run stays clean.
    assert report["papers_without_spans"] == 0
    assert report["status"] == "complete"
    assert report["items_updated"] == 0
    assert _audio_path(url, test_id) is None
    assert _item_rows(url, test_id)[0][1:3] == (None, None)


def test_artifact_without_test_row_is_counted_and_skipped(schema, tmp_path):
    url = schema
    n = next(_test_numbers)  # never seeded
    _write_artifact(tmp_path, _artifact_dict(n, segments=[_segment([1], 0, 1000)]))

    report = _run_loader(url, tmp_path)
    assert report["status"] == "complete_with_refusals"
    assert report["tests_without_row"] == 1
    assert report["papers_mapped"] == 0
    assert report["items_updated"] == 0


def test_loader_is_idempotent(schema, tmp_path):
    """Re-run over the same artifacts: identical report, identical audio
    columns + provenance (clear-then-write converges — no dup, no drift).
    Item 1 starts with a NON-empty extra so the SECOND audio_seg write (a
    clear + jsonb_set over already-populated rows) provably preserves
    pre-existing sibling keys too, not just the first."""
    url = schema
    n = next(_test_numbers)
    test_id = asyncio.run(
        _seed_paper(
            url,
            test_number=n,
            item_numbers=[1, 2],
            extra_by_item={1: {"note": "hand-tagged"}},
        )
    )
    _write_artifact(
        tmp_path,
        _artifact_dict(
            n,
            segments=[
                _segment([1], 0, 1000, confidence=0.95),
                _segment([2], 1000, 2000, confidence=0.9),
            ],
        ),
    )

    first = _run_loader(url, tmp_path)
    rows_before = _item_rows(url, test_id)
    path_before = _audio_path(url, test_id)

    second = _run_loader(url, tmp_path)
    assert first == second
    assert _item_rows(url, test_id) == rows_before
    assert _audio_path(url, test_id) == path_before
    # The pre-existing extra key rode through BOTH clear+write cycles.
    by_number = {r[0]: r for r in _item_rows(url, test_id)}
    assert by_number[1][3]["note"] == "hand-tagged"
    assert "audio_seg" in by_number[1][3]


def test_rerun_clears_stale_span_when_item_leaves_artifact(schema, tmp_path):
    """SF-1 (stale-span convergence): run 1 maps items 1 and 2; the
    regenerated artifact for run 2 moves item 2 to unresolved_items. After
    run 2 item 2's span AND its audio_seg provenance are GONE (its other
    extra keys survive), the sibling keeps its identical span, and
    items_updated counts only the spans WRITTEN — the paper-wide clear's
    rowcount must never inflate it."""
    url = schema
    n = next(_test_numbers)
    test_id = asyncio.run(
        _seed_paper(
            url,
            test_number=n,
            item_numbers=[1, 2],
            extra_by_item={2: {"keep": "me"}},
        )
    )
    _write_artifact(
        tmp_path,
        _artifact_dict(
            n,
            segments=[
                _segment([1], 0, 1000, confidence=0.95),
                _segment([2], 1000, 2000, confidence=0.9),
            ],
        ),
    )
    first = _run_loader(url, tmp_path)
    assert first["items_updated"] == 2
    assert {r[0]: r for r in _item_rows(url, test_id)}[2][1:3] == (1000, 2000)

    # Re-segmentation dropped item 2 (same artifact filename, new content).
    _write_artifact(
        tmp_path,
        _artifact_dict(
            n,
            segments=[_segment([1], 0, 1000, confidence=0.95)],
            unresolved_items=[2],
        ),
    )
    second = _run_loader(url, tmp_path)
    assert second["status"] == "complete"
    assert second["items_updated"] == 1  # only the span written this run
    assert second["items_without_segment"] == 1  # item 2, now span-less
    assert second["papers_mapped"] == 1
    assert second["papers_without_spans"] == 0

    by_number = {r[0]: r for r in _item_rows(url, test_id)}
    # The sibling still carries its (identical) span + provenance…
    assert by_number[1][1:3] == (0, 1000)
    assert "audio_seg" in by_number[1][3]
    # …while the dropped item converged to span-less: NULL/NULL, audio_seg
    # removed, pre-existing extra keys intact.
    assert by_number[2][1:3] == (None, None)
    assert by_number[2][3] == {"keep": "me"}
    # A span still landed, so the paper keeps its audio_path.
    assert _audio_path(url, test_id) is not None


def test_rerun_with_zero_landing_segments_clears_stale_audio_path(schema, tmp_path):
    """Convergence at the PAPER level: run 1 maps a span + audio_path; run
    2's regenerated artifact has its every segment refused (invalid span) →
    the stale span AND the stale audio_path are both cleared (a path with no
    offsets behind it is the phantom-audio state GUARDS forbids), the paper
    is counted papers_without_spans, and the report does not read clean."""
    url = schema
    n = next(_test_numbers)
    test_id = asyncio.run(_seed_paper(url, test_number=n, item_numbers=[1]))
    _write_artifact(tmp_path, _artifact_dict(n, segments=[_segment([1], 0, 1000)]))
    first = _run_loader(url, tmp_path)
    assert first["papers_mapped"] == 1
    assert _audio_path(url, test_id) is not None

    _write_artifact(
        tmp_path,
        _artifact_dict(n, segments=[_segment([1], 5000, 5000)]),  # end == start
    )
    second = _run_loader(url, tmp_path)
    assert second["status"] == "complete_with_refusals"
    assert second["segments_invalid_span"] == 1
    assert second["papers_mapped"] == 0
    assert second["papers_without_spans"] == 1
    assert second["items_updated"] == 0
    assert _audio_path(url, test_id) is None  # stale path cleared
    assert _item_rows(url, test_id)[0][1:3] == (None, None)
    assert _item_rows(url, test_id)[0][3] == {}


def test_malformed_artifact_mid_set_aborts_whole_run(schema, tmp_path):
    """SF-2: ONE malformed artifact alongside a valid sibling aborts the
    WHOLE run at parse time (all artifacts parsed up front → ArtifactError
    before any DB work) — the valid paper gets NOTHING written, never a
    half-loaded corpus."""
    url = schema
    n_valid = next(_test_numbers)
    n_bad = next(_test_numbers)
    valid_id = asyncio.run(_seed_paper(url, test_number=n_valid, item_numbers=[1]))
    _write_artifact(
        tmp_path, _artifact_dict(n_valid, segments=[_segment([1], 0, 1000)])
    )
    bad_doc = _artifact_dict(n_bad, segments=[_segment([1], 0, 1000)])
    bad_doc["source_mp3"] = "/abs/escape.mp3"  # parse-time contract violation
    _write_artifact(tmp_path, bad_doc)

    with pytest.raises(ArtifactError, match="corpus-relative"):
        _run_loader(url, tmp_path)

    # The valid sibling was never touched: no path, no spans, no provenance.
    assert _audio_path(url, valid_id) is None
    row = _item_rows(url, valid_id)[0]
    assert row[1:3] == (None, None)
    assert row[3] == {}


def test_dry_run_plans_but_writes_nothing(schema, tmp_path):
    url = schema
    n = next(_test_numbers)
    test_id = asyncio.run(_seed_paper(url, test_number=n, item_numbers=[1, 2]))
    _write_artifact(
        tmp_path,
        _artifact_dict(
            n,
            segments=[_segment([1], 0, 1000), _segment([2], 1000, 2000)],
        ),
    )

    report = _run_loader(url, tmp_path, dry_run=True)
    # The plan is computed against the real DB — counts are the truth…
    assert report["dry_run"] is True
    assert report["papers_mapped"] == 1
    assert report["items_updated"] == 2
    assert report["items_without_segment"] == 0  # counted pre-rollback
    # …but nothing persists.
    assert _audio_path(url, test_id) is None
    for row in _item_rows(url, test_id):
        assert row[1:3] == (None, None)
        assert row[3] == {}


def test_invalid_span_is_refused_not_written(schema, tmp_path):
    """A span 078's CHECK would reject (end <= start, or negative start) is
    refused before the write — counted + the valid sibling still maps —
    so ck_topik_items_audio_span is never violated (the loader never even
    presents a bad span to Postgres)."""
    url = schema
    n = next(_test_numbers)
    test_id = asyncio.run(_seed_paper(url, test_number=n, item_numbers=[1, 2, 3]))
    _write_artifact(
        tmp_path,
        _artifact_dict(
            n,
            segments=[
                _segment([1], 0, 1000),
                _segment([2], 5000, 5000),  # end == start → invalid
                _segment([3], -10, 1000),  # negative start → invalid
                _segment([4], 0, 2**31),  # oversized (> MAX_SPAN_MS) → invalid
            ],
        ),
    )

    report = _run_loader(url, tmp_path)
    assert report["segments_invalid_span"] == 3
    assert report["items_updated"] == 1
    by_number = {r[0]: r for r in _item_rows(url, test_id)}
    assert by_number[1][1:3] == (0, 1000)
    assert by_number[2][1:3] == (None, None)
    assert by_number[3][1:3] == (None, None)


def test_corpus_root_drift_mismatch_refuses_paper(schema, tmp_path):
    """--corpus-root with a re-encoded MP3 (sha256 ≠ artifact.audio_sha256):
    the paper is refused whole — no audio_path, no spans, counted — while a
    drift-clean sibling paper in the same run still maps (per-paper refusal,
    not a run abort)."""
    url = schema
    artifacts = tmp_path / "artifacts"
    corpus = tmp_path / "corpus"

    n_drifted = next(_test_numbers)
    n_clean = next(_test_numbers)
    drifted_id = asyncio.run(_seed_paper(url, test_number=n_drifted, item_numbers=[1]))
    clean_id = asyncio.run(_seed_paper(url, test_number=n_clean, item_numbers=[1]))

    drifted_doc = _artifact_dict(  # carries _SHA, bytes hash differently
        n_drifted, segments=[_segment([1], 0, 1000)]
    )
    _write_mp3(corpus, drifted_doc["source_mp3"], b"replaced after segmentation")
    _write_artifact(artifacts, drifted_doc)

    clean_doc = _artifact_dict(n_clean, segments=[_segment([1], 2000, 3000)])
    clean_doc["audio_sha256"] = _write_mp3(
        corpus, clean_doc["source_mp3"], b"the exact bytes that were segmented"
    )
    _write_artifact(artifacts, clean_doc)

    report = _run_loader(url, artifacts, corpus_root=corpus)
    assert report["status"] == "complete_with_refusals"
    assert report["drift_check_enabled"] is True
    assert report["drift_mismatch"] == 1
    assert report["papers_mapped"] == 1  # the clean sibling
    assert report["items_updated"] == 1

    # The drifted paper is untouched…
    assert _audio_path(url, drifted_id) is None
    assert _item_rows(url, drifted_id)[0][1:3] == (None, None)
    # …the clean one fully mapped, with its provenance sha (the verified one).
    assert _audio_path(url, clean_id) == clean_doc["source_mp3"]
    row = _item_rows(url, clean_id)[0]
    assert row[1:3] == (2000, 3000)
    assert row[3]["audio_seg"]["audio_sha256"] == clean_doc["audio_sha256"]


def test_corpus_root_missing_mp3_refuses_paper(schema, tmp_path):
    """A corpus-root check against an ABSENT file is a refusal, not a load —
    'cannot verify' must never degrade into 'load anyway'."""
    url = schema
    artifacts = tmp_path / "artifacts"
    corpus = tmp_path / "corpus"
    corpus.mkdir()

    n = next(_test_numbers)
    test_id = asyncio.run(_seed_paper(url, test_number=n, item_numbers=[1]))
    _write_artifact(artifacts, _artifact_dict(n, segments=[_segment([1], 0, 1000)]))

    report = _run_loader(url, artifacts, corpus_root=corpus)
    assert report["drift_mismatch"] == 1
    assert report["papers_mapped"] == 0
    assert report["items_updated"] == 0
    assert _audio_path(url, test_id) is None


def test_main_end_to_end_clean_run_exits_0(schema, tmp_path):
    """SF-4: the REAL CLI path — argparse → open_pool → load → exit gate —
    against the container DB. A clean run returns 0 and actually writes."""
    url = schema
    n = next(_test_numbers)
    test_id = asyncio.run(_seed_paper(url, test_number=n, item_numbers=[1]))
    _write_artifact(tmp_path, _artifact_dict(n, segments=[_segment([1], 0, 1000)]))

    rc = load_topik_audio.main(
        [
            "--database-url",
            url,
            "--artifacts-dir",
            str(tmp_path),
            "--log-level",
            "warning",
        ]
    )
    assert rc == 0
    assert _audio_path(url, test_id) is not None
    assert _item_rows(url, test_id)[0][1:3] == (0, 1000)


def test_main_end_to_end_invalid_span_exits_1(schema, tmp_path):
    """SF-4 + SF-2: a paper whose every segment is invalid-span, run through
    main() itself (no fakes) → exit 1 AND no audio_path advertised."""
    url = schema
    n = next(_test_numbers)
    test_id = asyncio.run(_seed_paper(url, test_number=n, item_numbers=[1]))
    _write_artifact(
        tmp_path,
        _artifact_dict(n, segments=[_segment([1], 5000, 5000)]),  # end == start
    )

    rc = load_topik_audio.main(
        [
            "--database-url",
            url,
            "--artifacts-dir",
            str(tmp_path),
            "--log-level",
            "warning",
        ]
    )
    assert rc == 1
    assert _audio_path(url, test_id) is None
    assert _item_rows(url, test_id)[0][1:3] == (None, None)


def test_main_end_to_end_drift_mismatch_exits_1(schema, tmp_path):
    """SF-4: a drift-mismatching paper through main() with --corpus-root →
    exit 1, nothing written for the refused paper."""
    url = schema
    artifacts = tmp_path / "artifacts"
    corpus = tmp_path / "corpus"
    n = next(_test_numbers)
    test_id = asyncio.run(_seed_paper(url, test_number=n, item_numbers=[1]))
    doc = _artifact_dict(n, segments=[_segment([1], 0, 1000)])  # carries _SHA
    _write_mp3(corpus, doc["source_mp3"], b"re-encoded after segmentation")
    _write_artifact(artifacts, doc)

    rc = load_topik_audio.main(
        [
            "--database-url",
            url,
            "--artifacts-dir",
            str(artifacts),
            "--corpus-root",
            str(corpus),
            "--log-level",
            "warning",
        ]
    )
    assert rc == 1
    assert _audio_path(url, test_id) is None
    assert _item_rows(url, test_id)[0][1:3] == (None, None)


def test_078_span_check_bites_on_direct_write(schema):
    """Sanity that the constraint the loader guards for is really live in the
    chain: a half-span UPDATE straight at Postgres must be rejected."""
    url = schema
    n = next(_test_numbers)
    test_id = asyncio.run(_seed_paper(url, test_number=n, item_numbers=[1]))
    with pytest.raises(psycopg.errors.CheckViolation):
        asyncio.run(
            _exec(
                url,
                """
                UPDATE topik_items SET audio_start_ms = 5
                 WHERE topik_test_id = %s AND item_number = 1
                """,
                (test_id,),
            )
        )


def test_migration_078_round_trip(schema):
    """078 down drops audio_path + the span columns/CHECK; re-up restores
    them empty. Runs LAST-ish by definition order; earlier tests' spans are
    gone afterwards, but every test seeds its own paper so none re-read them."""
    url = schema

    def _has_column(table: str, column: str) -> bool:
        rows = asyncio.run(
            _exec(
                url,
                """
                SELECT 1 FROM information_schema.columns
                 WHERE table_name = %s AND column_name = %s
                """,
                (table, column),
            )
        )
        return len(rows) == 1

    async def _apply(path: Path) -> None:
        sql = path.read_text(encoding="utf-8")
        async with (
            await psycopg.AsyncConnection.connect(url) as conn,
            conn.transaction(),
            conn.cursor() as cur,
        ):
            await cur.execute(sql)

    assert _has_column("topik_tests", "audio_path")
    assert _has_column("topik_items", "audio_start_ms")
    assert _has_column("topik_items", "audio_end_ms")

    asyncio.run(_apply(MIGRATIONS_DIR / "078_topik_listening_audio.down.sql"))
    assert not _has_column("topik_tests", "audio_path")
    assert not _has_column("topik_items", "audio_start_ms")
    assert not _has_column("topik_items", "audio_end_ms")

    asyncio.run(_apply(MIGRATIONS_DIR / "078_topik_listening_audio.up.sql"))
    assert _has_column("topik_tests", "audio_path")
    assert _has_column("topik_items", "audio_start_ms")
    assert _has_column("topik_items", "audio_end_ms")
    # Re-upped columns start NULL — this loader is the only writer.
    rows = asyncio.run(
        _exec(url, "SELECT COUNT(*) FROM topik_tests WHERE audio_path IS NOT NULL")
    )
    assert rows == [(0,)]
    # And the CHECK is back (conrelid-scoped, exactly as 078 guards it).
    rows = asyncio.run(
        _exec(
            url,
            """
            SELECT 1 FROM pg_constraint
             WHERE conname = 'ck_topik_items_audio_span'
               AND conrelid = 'topik_items'::regclass
            """,
        )
    )
    assert rows == [(1,)]
