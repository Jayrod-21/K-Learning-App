"""
Tests for the TOPIK question-image loader (F-120 Phase 1) + migration 085.

Two tiers (same shape as test_load_topik_audio.py):

  1. PURE tests — ``parse_manifest`` / ``discover_manifests`` against
     synthetic manifest JSONs in tmp_path. No Docker, no DB. Pins the
     absolute-path / traversal / backslash / drive-token rejection on
     ``image_ref`` (the 035/078 relative-key gate).
  2. INTEGRATION tests — real Postgres via testcontainers with the FULL real
     migration chain applied through ``migrate.main()`` (so 085's column
     arrives exactly as production gets it), seeded topik_tests/topik_items
     rows, manifests on disk, the loader run through its real async-pool
     entry point. Asserts the keyed section-scoped UPDATE (the wrong
     level/section paper is never touched), NULL for unmapped items,
     idempotency, stale-ref convergence (clear-then-write), missing-item
     counting, and report counts.

NEVER touches km-db or the real corpus — every test paper gets its own
unique test_number so tests stay independent inside the shared container.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
import sys
from pathlib import Path

import pytest

from loaders.load_topik_image import (
    ImageItem,
    ImageManifest,
    ManifestError,
    _parse_args,
    discover_manifests,
    parse_manifest,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"

_SHA = "ee0709f190841d0d08327c30afdaa061171e196c96becadd77199ed02d967532"


# ---------------------------------------------------------------------------
# Manifest fixture builders (pure — also used by the integration tier)
# ---------------------------------------------------------------------------

def _item_dict(number: int, *, image_ref: str | None = None) -> dict:
    return {
        "number": number,
        "image_ref": image_ref
        or f"TOPIK IMAGES/60 - test/listening/q{number:02d}.png",
        "width": 800,
        "height": 600,
        "kind": "picture_choice",
        "sha256": _SHA,
    }


def _manifest_dict(
    test_number: int,
    *,
    topik_level: str = "TOPIK II",
    section: str = "listening",
    items: list[dict] | None = None,
) -> dict:
    return {
        "test_number": test_number,
        "topik_level": topik_level,
        "section": section,
        "source_pdf": f"TOPIK TEST/{test_number} - test/{section}.pdf",
        "pdf_sha256": _SHA,
        "extractor_version": "1.0.0",
        "items": items if items is not None else [_item_dict(1)],
    }


def _write_manifest(directory: Path, doc: dict) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    lvl = "II" if doc["topik_level"] == "TOPIK II" else "I"
    path = directory / f"topik_{doc['test_number']}_{lvl}_{doc['section']}.json"
    path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Tier 1 — pure manifest parsing / discovery
# ---------------------------------------------------------------------------

def test_parse_manifest_round_trips_valid_document(tmp_path: Path) -> None:
    doc = _manifest_dict(
        60, items=[_item_dict(1), _item_dict(2, image_ref="a b/q 2.webp")]
    )
    manifest = parse_manifest(_write_manifest(tmp_path, doc))
    assert isinstance(manifest, ImageManifest)
    assert manifest.test_number == 60
    assert manifest.topik_level == "TOPIK II"
    assert manifest.section == "listening"
    assert manifest.source_pdf == doc["source_pdf"]
    assert manifest.pdf_sha256 == _SHA
    assert manifest.extractor_version == "1.0.0"
    assert manifest.items == (
        ImageItem(
            number=1,
            image_ref="TOPIK IMAGES/60 - test/listening/q01.png",
            width=800,
            height=600,
            kind="picture_choice",
            sha256=_SHA,
        ),
        ImageItem(
            number=2,
            image_ref="a b/q 2.webp",  # spaces survive — the 035 keys have them
            width=800,
            height=600,
            kind="picture_choice",
            sha256=_SHA,
        ),
    )


@pytest.mark.parametrize(
    ("mutate", "match"),
    [
        (lambda d: d.update(topik_level="TOPIK III"), "topik_level"),
        (lambda d: d.update(topik_level=2), "topik_level"),
        (lambda d: d.update(section="speaking"), "section"),
        (lambda d: d.update(test_number="60"), "test_number"),
        (lambda d: d.update(test_number=True), "test_number"),
        (lambda d: d.update(test_number=0), ">= 1"),
        # The relative-key gate on image_ref — the security-critical set.
        (lambda d: d["items"][0].update(image_ref="/abs/q1.png"), "corpus-relative"),
        (lambda d: d["items"][0].update(image_ref="a/../../etc/passwd"), "traverse"),
        (lambda d: d["items"][0].update(image_ref=""), "image_ref"),
        (lambda d: d["items"][0].update(image_ref="C:\\imgs\\q1.png"), "backslash"),
        (lambda d: d["items"][0].update(image_ref="a\\..\\b.png"), "backslash"),
        (lambda d: d["items"][0].update(image_ref="C:/imgs/q1.png"), "drive/scheme"),
        (lambda d: d["items"][0].update(image_ref="a/C:/x.png"), "drive/scheme"),
        # source_pdf runs through the same gate.
        (lambda d: d.update(source_pdf="/abs/listening.pdf"), "corpus-relative"),
        # Structural refusals.
        (lambda d: d["items"].append(_item_dict(1)), "more than once"),
        (lambda d: d["items"][0].update(number=0), ">= 1"),
        (lambda d: d["items"][0].update(number="1"), "number"),
        (lambda d: d["items"][0].update(width=0), "width/height"),
        (lambda d: d["items"][0].update(height="tall"), "height"),
        (lambda d: d["items"][0].update(kind=""), "kind"),
        (lambda d: d["items"][0].update(sha256="deadbeef"), "hex sha256"),
        (lambda d: d["items"][0].update(sha256=_SHA.upper()), "hex sha256"),
        (lambda d: d.update(pdf_sha256=None), "pdf_sha256"),
        (lambda d: d.update(extractor_version=""), "extractor_version"),
        (lambda d: d.update(items={"not": "a list"}), "items"),
    ],
)
def test_parse_manifest_rejects_malformed(tmp_path: Path, mutate, match: str) -> None:
    doc = _manifest_dict(60)
    mutate(doc)
    path = _write_manifest(tmp_path, doc)
    with pytest.raises(ManifestError, match=match):
        parse_manifest(path)


def test_parse_manifest_rejects_invalid_json(tmp_path: Path) -> None:
    path = tmp_path / "topik_60_II_listening.json"
    path.write_text("{ not json", encoding="utf-8")
    with pytest.raises(ManifestError, match="invalid JSON"):
        parse_manifest(path)


def test_discover_manifests_sorted_and_filtered(tmp_path: Path) -> None:
    _write_manifest(tmp_path, _manifest_dict(60))
    _write_manifest(tmp_path, _manifest_dict(35, topik_level="TOPIK I", section="reading"))
    (tmp_path / "notes.txt").write_text("not a manifest", encoding="utf-8")
    found = discover_manifests(tmp_path)
    assert [p.name for p in found] == [
        "topik_35_I_reading.json",
        "topik_60_II_listening.json",
    ]


def test_discover_manifests_fails_loud_on_missing_dir(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="--manifests-dir"):
        discover_manifests(tmp_path / "nowhere")


def test_discover_manifests_fails_loud_on_empty_dir(tmp_path: Path) -> None:
    """A mispointed dir must never read as '0 papers mapped, exit 0'."""
    with pytest.raises(FileNotFoundError, match="no topik_"):
        discover_manifests(tmp_path)


# ---------------------------------------------------------------------------
# Tier 2 — integration against a throwaway Postgres (testcontainers) with the
# REAL migration chain applied via migrate.main() (bookkeeping included).
# ---------------------------------------------------------------------------

testcontainers = pytest.importorskip("testcontainers.postgres")
psycopg = pytest.importorskip("psycopg")
psycopg_pool = pytest.importorskip("psycopg_pool")

from psycopg_pool import AsyncConnectionPool  # noqa: E402
from testcontainers.postgres import PostgresContainer  # noqa: E402

from loaders import load_topik_image  # noqa: E402
from loaders.runtime import LoaderConfig, configure_logging  # noqa: E402

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from db import migrate  # noqa: E402

# ---------------------------------------------------------------------------
# CLI exit contract — main() level, no DB container (pool + load faked).
# ---------------------------------------------------------------------------


def test_main_exits_2_without_database_url(monkeypatch) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert load_topik_image.main([]) == 2


def _fake_report(**overrides) -> dict:
    report = {
        "status": "complete",
        "dry_run": False,
        "manifests_total": 1,
        "manifests_mapped": 1,
        "manifests_skipped_empty": 0,
        "manifests_without_rows": 0,
        "tests_without_row": 0,
        "items_updated": 1,
        "items_without_matching_row": 0,
    }
    report.update(overrides)
    return report


@pytest.mark.parametrize(
    ("overrides", "expected_exit"),
    [
        ({}, 0),  # clean run
        ({"tests_without_row": 1}, 1),  # expected paper row missing
        ({"manifests_without_rows": 1}, 1),  # admitted manifest landed zero rows
        ({"items_without_matching_row": 1}, 0),  # a seeding gap warns, not gates
    ],
)
def test_main_exit_code_reflects_report(
    monkeypatch, overrides: dict, expected_exit: int
) -> None:
    from loaders import runtime as loaders_runtime

    monkeypatch.setenv("DATABASE_URL", "postgresql://fake:fake@nowhere:5432/x")

    @contextlib.asynccontextmanager
    async def fake_open_pool(cfg):
        yield None  # main() only hands the pool to load(), which is faked too

    async def fake_load(pool, source_path, cfg):
        return _fake_report(**overrides)

    monkeypatch.setattr(loaders_runtime, "open_pool", fake_open_pool)
    monkeypatch.setattr(load_topik_image, "load", fake_load)
    assert load_topik_image.main([]) == expected_exit


def test_parse_args_defaults() -> None:
    args = _parse_args([])
    assert args.manifests_dir == load_topik_image.DEFAULT_MANIFESTS_DIR
    assert args.dry_run is False


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
    """Apply the FULL production migration chain (…including 085) through the
    real runner — schema_migrations bookkeeping and all."""
    configure_logging("warning")
    mp = pytest.MonkeyPatch()
    mp.setenv("DATABASE_URL", database_url)
    try:
        # --allow-destructive: migration 045 (hygiene_cleanup, DROP TABLE)
        # sits in the chain (same as test_load_topik_audio.py).
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
# shared module-scoped container.
_test_numbers = itertools.count(600)


async def _seed_paper(
    url: str,
    *,
    test_number: int,
    topik_level: str = "TOPIK II",
    section: str = "listening",
    item_numbers: list[int] = (),
) -> int:
    """Seed one topik_tests row + its items; returns the test id."""
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
                     item_number, section, item_type, stem)
                VALUES (%s, %s, %s, %s, %s::topik_section,
                        'multiple_choice'::topik_item_type, %s)
                """,
                (
                    test_id,
                    src_id,
                    (
                        f"img{test_number}-{topik_level[-2:].strip()}-"
                        f"{section}-{n:03d}"
                    ),
                    n,
                    section,
                    f"stem {n}",
                ),
            )
    return test_id


def _run_loader(url: str, manifests_dir: Path, *, dry_run: bool = False) -> dict:
    cfg = LoaderConfig(database_url=url, dry_run=dry_run)

    async def go() -> dict:
        async with AsyncConnectionPool(url, min_size=1, max_size=2, open=False) as pool:
            await pool.open(wait=True, timeout=15)
            return await load_topik_image.load(pool, manifests_dir, cfg)

    return asyncio.run(go())


def _image_refs(url: str, test_id: int) -> list[tuple]:
    """(item_number, image_ref) for every item of a test, ordered."""
    return asyncio.run(
        _exec(
            url,
            """
            SELECT item_number, image_ref
              FROM topik_items WHERE topik_test_id = %s ORDER BY item_number
            """,
            (test_id,),
        )
    )


def test_loader_keyed_update_maps_only_the_named_paper(schema, tmp_path):
    """Happy path: image_ref lands on the RIGHT (test, level, section) paper's
    items only; unmapped items stay NULL; the same-number other-level and
    other-section papers are untouched; report counts exact."""
    url = schema
    n = next(_test_numbers)
    listening_id = asyncio.run(
        _seed_paper(url, test_number=n, item_numbers=[1, 2, 3])
    )
    other_level_id = asyncio.run(
        _seed_paper(url, test_number=n, topik_level="TOPIK I", item_numbers=[1])
    )
    other_section_id = asyncio.run(
        _seed_paper(url, test_number=n, section="reading", item_numbers=[1])
    )

    doc = _manifest_dict(
        n,
        items=[
            _item_dict(1, image_ref=f"TOPIK IMAGES/{n}/q01.png"),
            _item_dict(3, image_ref=f"TOPIK IMAGES/{n}/q03.png"),
        ],
    )
    _write_manifest(tmp_path, doc)
    report = _run_loader(url, tmp_path)

    assert report["status"] == "complete"
    assert report["manifests_total"] == 1
    assert report["manifests_mapped"] == 1
    assert report["items_updated"] == 2
    assert report["items_without_matching_row"] == 0
    assert report["tests_without_row"] == 0

    assert _image_refs(url, listening_id) == [
        (1, f"TOPIK IMAGES/{n}/q01.png"),
        (2, None),  # unmapped item stays NULL
        (3, f"TOPIK IMAGES/{n}/q03.png"),
    ]
    # Same test_number, different level/section — never touched.
    assert _image_refs(url, other_level_id) == [(1, None)]
    assert _image_refs(url, other_section_id) == [(1, None)]


def test_loader_is_idempotent_and_converges_stale_refs(schema, tmp_path):
    """A re-run is a no-op in effect; a REGENERATED manifest that no longer
    covers an item clears its stale ref (the clear-then-write convergence)."""
    url = schema
    n = next(_test_numbers)
    test_id = asyncio.run(_seed_paper(url, test_number=n, item_numbers=[1, 2]))

    doc = _manifest_dict(n, items=[_item_dict(1), _item_dict(2)])
    manifests = tmp_path / "run1"
    _write_manifest(manifests, doc)
    first = _run_loader(url, manifests)
    assert first["items_updated"] == 2
    after_first = _image_refs(url, test_id)

    # Identical re-run → identical rows (idempotent).
    second = _run_loader(url, manifests)
    assert second["items_updated"] == 2
    assert _image_refs(url, test_id) == after_first

    # Regenerated manifest drops item 2 → its stale ref converges to NULL.
    doc2 = _manifest_dict(n, items=[_item_dict(1)])
    manifests2 = tmp_path / "run2"
    _write_manifest(manifests2, doc2)
    third = _run_loader(url, manifests2)
    assert third["items_updated"] == 1
    rows = _image_refs(url, test_id)
    assert rows[0][1] is not None
    assert rows[1] == (2, None), "stale ref must be cleared, not left serving"


def test_loader_dry_run_writes_nothing(schema, tmp_path):
    url = schema
    n = next(_test_numbers)
    test_id = asyncio.run(_seed_paper(url, test_number=n, item_numbers=[1]))
    _write_manifest(tmp_path, _manifest_dict(n, items=[_item_dict(1)]))

    report = _run_loader(url, tmp_path, dry_run=True)
    assert report["dry_run"] is True
    assert report["items_updated"] == 1, "the plan runs for real…"
    assert _image_refs(url, test_id) == [(1, None)], "…then rolls back"


def test_loader_counts_missing_test_and_missing_items(schema, tmp_path):
    """A manifest for an unseeded paper is a counted refusal; a manifest item
    whose number has no DB row is counted without failing the paper."""
    url = schema
    n = next(_test_numbers)
    test_id = asyncio.run(_seed_paper(url, test_number=n, item_numbers=[1]))

    _write_manifest(tmp_path, _manifest_dict(n, items=[_item_dict(1), _item_dict(9)]))
    _write_manifest(tmp_path, _manifest_dict(n + 1, items=[_item_dict(1)]))  # unseeded

    report = _run_loader(url, tmp_path)
    assert report["status"] == "complete_with_refusals"
    assert report["tests_without_row"] == 1
    assert report["items_updated"] == 1
    assert report["items_without_matching_row"] == 1
    assert _image_refs(url, test_id)[0][1] is not None


def test_loader_zero_landed_manifest_gates_the_run(schema, tmp_path):
    """An admitted manifest whose EVERY item is unseeded must not read clean."""
    url = schema
    n = next(_test_numbers)
    asyncio.run(_seed_paper(url, test_number=n, item_numbers=[1]))

    _write_manifest(tmp_path, _manifest_dict(n, items=[_item_dict(7), _item_dict(8)]))
    report = _run_loader(url, tmp_path)
    assert report["manifests_without_rows"] == 1
    assert report["status"] == "complete_with_refusals"


def test_loader_empty_manifest_is_a_benign_skip(schema, tmp_path):
    url = schema
    n = next(_test_numbers)
    asyncio.run(_seed_paper(url, test_number=n, item_numbers=[1]))
    _write_manifest(tmp_path, _manifest_dict(n, items=[]))
    report = _run_loader(url, tmp_path)
    assert report["manifests_skipped_empty"] == 1
    assert report["status"] == "complete"
