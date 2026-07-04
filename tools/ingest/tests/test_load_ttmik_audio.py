"""
Tests for the TTMIK audio loader (F-012) + migration 035 reversibility.

Two tiers:

  1. PURE tests — ``parse_audio_filename`` + ``scan_audio_tree`` against a
     synthetic fixture tree in tmp_path. No Docker, no DB, no real corpus.
  2. INTEGRATION tests — real Postgres via testcontainers (same pattern as
     test_load_ttmik.py): apply the production migrations, seed a handful of
     lesson/episode rows, run the loader against the fixture tree, assert
     audio_path values + report counts + idempotency. Also proves migration
     035 down/up round-trips.

NEVER touches km-db or the real corpus — the tree is fabricated 0-byte files.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

# Optional dep guard: mirror the sibling loader tests so the pure tests still
# run in an environment without Docker/psycopg.
psycopg = pytest.importorskip("psycopg")
psycopg_pool = pytest.importorskip("psycopg_pool")

from psycopg_pool import AsyncConnectionPool  # noqa: E402

from loaders import load_ttmik_audio  # type: ignore  # noqa: E402
from loaders.load_ttmik_audio import (  # type: ignore  # noqa: E402
    EpisodeKey,
    LessonKey,
    parse_audio_filename,
    scan_audio_tree,
)
from loaders.runtime import LoaderConfig, configure_logging  # type: ignore  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"


# ---------------------------------------------------------------------------
# Tier 1 — pure filename parsing
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        # Ground-truth shapes
        ("03 TTMIK Level 1 Lesson 3.mp3", LessonKey(level=1, number=3)),
        ("17 TTMIK Level 9 Lesson 17.mp3", LessonKey(level=9, number=17)),
        ("143 TTMIK Iyagi 143.mp3", EpisodeKey(number=143)),
        ("1 TTMIK Iyagi 1.mp3", EpisodeKey(number=1)),
        # Variance the regex must absorb: case, extra whitespace, extension case
        ("ttmik level 2 lesson 10.mp3", LessonKey(level=2, number=10)),
        ("05  TTMIK  Level  3   Lesson  12 .mp3", LessonKey(level=3, number=12)),
        ("TTMIK LEVEL 1 LESSON 1.MP3", LessonKey(level=1, number=1)),
        ("22 ttmik iyagi 22.MP3", EpisodeKey(number=22)),
        ("TTMIK Iyagi #7.mp3", EpisodeKey(number=7)),
        ("TTMIK Iyagi episode 12.mp3", EpisodeKey(number=12)),
        # Non-matches: no key, wrong tokens, missing number
        ("random song.mp3", None),
        ("TTMIK Iyagi.mp3", None),
        ("TTMIK Level 1.mp3", None),
        ("TTMIK Level 1 Lesson 3.wav", None),
        ("Iyagi 5 outro TTMIK.mp3", None),
    ],
)
def test_parse_audio_filename(name: str, expected: object) -> None:
    assert parse_audio_filename(name) == expected


# ---------------------------------------------------------------------------
# Tier 1 — fixture-tree scanning
# ---------------------------------------------------------------------------


def _touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"")


def _build_fixture_tree(root: Path) -> None:
    """A miniature corpus root mirroring the real layout (0-byte 'mp3s')."""
    ttmik = root / "TTMIK"
    _touch(ttmik / "Lessons" / "Lesson 1" / "01 TTMIK Level 1 Lesson 1.mp3")
    _touch(ttmik / "Lessons" / "Lesson 1" / "02 TTMIK Level 1 Lesson 2.mp3")
    _touch(ttmik / "Lessons" / "Lesson 2" / "05 TTMIK Level 2 Lesson 5.mp3")
    _touch(ttmik / "이야기들" / "이야기" / "3 TTMIK Iyagi 3.mp3")
    _touch(ttmik / "이야기들" / "이야기" / "7 TTMIK Iyagi 7.mp3")
    # Duplicate key: second file claiming Iyagi 3 (sorted order → the one
    # above wins because "3 TTMIK..." < "99 dup...").
    _touch(ttmik / "이야기들" / "이야기" / "99 dup TTMIK Iyagi 3.mp3")
    # Unparseable mp3 → reported, not guessed
    _touch(ttmik / "Lessons" / "bonus track.mp3")
    # Non-mp3 noise → silently ignored (not audio)
    _touch(ttmik / "Lessons" / "cover.jpg")


def test_scan_audio_tree_maps_keys_to_relative_paths(tmp_path: Path) -> None:
    _build_fixture_tree(tmp_path)
    scan = scan_audio_tree(tmp_path)

    assert scan.lessons == {
        LessonKey(1, 1): "TTMIK/Lessons/Lesson 1/01 TTMIK Level 1 Lesson 1.mp3",
        LessonKey(1, 2): "TTMIK/Lessons/Lesson 1/02 TTMIK Level 1 Lesson 2.mp3",
        LessonKey(2, 5): "TTMIK/Lessons/Lesson 2/05 TTMIK Level 2 Lesson 5.mp3",
    }
    assert scan.episodes == {
        EpisodeKey(3): "TTMIK/이야기들/이야기/3 TTMIK Iyagi 3.mp3",
        EpisodeKey(7): "TTMIK/이야기들/이야기/7 TTMIK Iyagi 7.mp3",
    }
    assert scan.unparsed == ["TTMIK/Lessons/bonus track.mp3"]
    assert scan.duplicates == ["TTMIK/이야기들/이야기/99 dup TTMIK Iyagi 3.mp3"]
    # Every stored path is corpus-relative (starts with TTMIK/), never absolute.
    for rel in [*scan.lessons.values(), *scan.episodes.values()]:
        assert not Path(rel).is_absolute()
        assert rel.startswith("TTMIK/")


def test_scan_audio_tree_rejects_missing_ttmik_dir(tmp_path: Path) -> None:
    """A mispointed --audio-dir fails loudly, never 'zero matches'."""
    with pytest.raises(FileNotFoundError, match="TTMIK"):
        scan_audio_tree(tmp_path / "nowhere")


def test_scan_audio_tree_rejects_ttmik_dir_itself(tmp_path: Path) -> None:
    """Pointing at .../TTMIK instead of the corpus root is the likely operator
    mistake — it must fail with the corrective hint, not mis-relativize."""
    _build_fixture_tree(tmp_path)
    with pytest.raises(FileNotFoundError, match="corpus root CONTAINING"):
        scan_audio_tree(tmp_path / "TTMIK")


# ---------------------------------------------------------------------------
# Tier 2 — integration against a throwaway Postgres (testcontainers)
# ---------------------------------------------------------------------------

testcontainers = pytest.importorskip("testcontainers.postgres")
from testcontainers.postgres import PostgresContainer  # noqa: E402


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


async def _apply_migrations(url: str) -> None:
    files = sorted(MIGRATIONS_DIR.glob("*.up.sql"))
    async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
        for f in files:
            sql = f.read_text(encoding="utf-8")
            async with conn.transaction():
                async with conn.cursor() as cur:
                    await cur.execute(sql)


@pytest.fixture(scope="module")
def schema(database_url):
    configure_logging("warning")
    asyncio.run(_apply_migrations(database_url))
    return database_url


async def _exec(url: str, sql: str, params: tuple = ()) -> list[tuple]:
    async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql, params)
            if cur.description is None:
                return []
            return await cur.fetchall()


async def _seed_rows(url: str) -> None:
    """Seed 3 lessons + 2 episodes; leaves one lesson + one episode with no
    matching fixture file so 'row without audio' is exercised."""
    async with await psycopg.AsyncConnection.connect(url) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO corpus_sources
                    (corpus, title, level, source_path, default_proficiency)
                VALUES
                    ('ttmik'::corpus, 't', 'beginner'::book_level, 'x.json',
                     'L1'::proficiency_level),
                    ('iyagi'::corpus, 'i', 'intermediate'::book_level, 'y.json',
                     'L3'::proficiency_level)
                RETURNING id
                """
            )
            ids = await cur.fetchall()
            ttmik_src, iyagi_src = int(ids[0][0]), int(ids[1][0])
            await cur.execute(
                """
                INSERT INTO ttmik_lessons (
                    corpus_source_id, corpus, source_id, book_level,
                    lesson_level, lesson_number, ordinal, title)
                VALUES
                    (%(src)s, 'ttmik'::corpus, 'ttmik-L1-1', 'beginner'::book_level,
                     1, 1, 1, 'L1 lesson 1'),
                    (%(src)s, 'ttmik'::corpus, 'ttmik-L1-2', 'beginner'::book_level,
                     1, 2, 2, 'L1 lesson 2'),
                    (%(src)s, 'ttmik'::corpus, 'ttmik-L4-9', 'beginner'::book_level,
                     4, 9, 3, 'no audio published')
                """,
                {"src": ttmik_src},
            )
            await cur.execute(
                """
                INSERT INTO iyagi_episodes (
                    corpus_source_id, corpus, source_id, episode_number,
                    ordinal, title)
                VALUES
                    (%(src)s, 'iyagi'::corpus, 'iyagi-003', 3, 1, 'ep 3'),
                    (%(src)s, 'iyagi'::corpus, 'iyagi-500', 500, 2, 'no file')
                """,
                {"src": iyagi_src},
            )
        await conn.commit()


def _run_loader(url: str, corpus_root: Path) -> dict:
    cfg = LoaderConfig(database_url=url, batch_size=50)

    async def go() -> dict:
        async with AsyncConnectionPool(url, min_size=1, max_size=2, open=False) as pool:
            await pool.open(wait=True, timeout=15)
            return await load_ttmik_audio.load(pool, corpus_root, cfg)

    return asyncio.run(go())


def test_loader_maps_fixture_tree_and_reports(schema, tmp_path: Path) -> None:
    url = schema
    _build_fixture_tree(tmp_path)
    asyncio.run(_seed_rows(url))

    report = _run_loader(url, tmp_path)
    assert report["status"] == "complete"
    # Fixture has lesson files (1,1) (1,2) (2,5); DB has rows (1,1) (1,2) (4,9)
    assert report["lessons_matched"] == 2
    # Fixture has episode files 3, 7; DB has rows 3, 500
    assert report["episodes_matched"] == 1
    # (2,5) lesson file + episode-7 file have no DB row
    assert report["files_without_row"] == 2
    assert report["files_unparsed"] == 1
    assert report["files_duplicate_key"] == 1
    # Rows the tree didn't cover keep NULL and are counted
    assert report["lessons_without_audio"] == 1
    assert report["episodes_without_audio"] == 1

    rows = asyncio.run(
        _exec(
            url,
            """
            SELECT lesson_level, lesson_number, audio_path
              FROM ttmik_lessons ORDER BY lesson_level, lesson_number
            """,
        )
    )
    assert rows == [
        (1, 1, "TTMIK/Lessons/Lesson 1/01 TTMIK Level 1 Lesson 1.mp3"),
        (1, 2, "TTMIK/Lessons/Lesson 1/02 TTMIK Level 1 Lesson 2.mp3"),
        (4, 9, None),
    ]
    rows = asyncio.run(
        _exec(
            url,
            "SELECT episode_number, audio_path FROM iyagi_episodes ORDER BY 1",
        )
    )
    assert rows == [
        (3, "TTMIK/이야기들/이야기/3 TTMIK Iyagi 3.mp3"),
        (500, None),
    ]


def test_loader_is_idempotent(schema, tmp_path: Path) -> None:
    """Second run over the same tree: identical report, identical rows."""
    url = schema
    _build_fixture_tree(tmp_path)
    first = _run_loader(url, tmp_path)
    before = asyncio.run(
        _exec(url, "SELECT lesson_level, lesson_number, audio_path FROM ttmik_lessons ORDER BY 1, 2")
    )
    second = _run_loader(url, tmp_path)
    after = asyncio.run(
        _exec(url, "SELECT lesson_level, lesson_number, audio_path FROM ttmik_lessons ORDER BY 1, 2")
    )
    assert first == second
    assert before == after


def test_migration_035_round_trip(schema) -> None:
    """035 down drops both audio_path columns; re-up restores them (empty)."""
    url = schema

    def _has_column(table: str) -> bool:
        rows = asyncio.run(
            _exec(
                url,
                """
                SELECT 1 FROM information_schema.columns
                 WHERE table_name = %s AND column_name = 'audio_path'
                """,
                (table,),
            )
        )
        return len(rows) == 1

    async def _apply(path: Path) -> None:
        sql = path.read_text(encoding="utf-8")
        async with await psycopg.AsyncConnection.connect(url) as conn:
            async with conn.transaction():
                async with conn.cursor() as cur:
                    await cur.execute(sql)

    assert _has_column("ttmik_lessons") and _has_column("iyagi_episodes")
    asyncio.run(_apply(MIGRATIONS_DIR / "035_ttmik_audio.down.sql"))
    assert not _has_column("ttmik_lessons") and not _has_column("iyagi_episodes")
    asyncio.run(_apply(MIGRATIONS_DIR / "035_ttmik_audio.up.sql"))
    assert _has_column("ttmik_lessons") and _has_column("iyagi_episodes")
    # Re-upped columns start NULL — the loader is the only writer.
    rows = asyncio.run(
        _exec(url, "SELECT COUNT(*) FROM ttmik_lessons WHERE audio_path IS NOT NULL")
    )
    assert rows == [(0,)]
