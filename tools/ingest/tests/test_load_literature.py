"""
Integration tests for the U3b literature (chapters + passages) loader.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path

import pytest

testcontainers = pytest.importorskip("testcontainers.postgres")
psycopg_pool = pytest.importorskip("psycopg_pool")
psycopg = pytest.importorskip("psycopg")

from testcontainers.postgres import PostgresContainer  # noqa: E402
from psycopg_pool import AsyncConnectionPool  # noqa: E402

from loaders.runtime import LoaderConfig, configure_logging  # type: ignore  # noqa: E402
from loaders import load_literature  # type: ignore  # noqa: E402


REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
FIXTURE = Path(__file__).parent / "literature_mini.json"

# Satisfies ck_users_password_hash_argon2id (LIKE '$argon2id$%' AND length
# 80..255) without decoding a real argon2id string — the CHECK only inspects
# the prefix + length, not the encoded params.
_FAKE_ARGON2_HASH = "$argon2id$v=19$m=65536,t=3,p=4$" + "a" * 60
# An id that will never collide with a real IDENTITY-generated book_uploads.id
# in a fresh test container, used to exercise the "upload does not exist"
# failure path without needing to seed one.
_NONEXISTENT_UPLOAD_ID = 987_654_321


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
def schema(database_url):
    configure_logging("warning")
    asyncio.run(_apply_migrations(database_url))
    return database_url


async def _count(url: str, sql: str, params: tuple = ()) -> int:
    async with await psycopg.AsyncConnection.connect(url) as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql, params)
            row = await cur.fetchone()
    return int(row[0]) if row else 0


async def _scalar(url: str, sql: str, params: tuple = ()):
    """First column of the first row (or None)."""
    async with await psycopg.AsyncConnection.connect(url) as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql, params)
            row = await cur.fetchone()
    return row[0] if row else None


async def _rows(url: str, sql: str, params: tuple = ()) -> list[tuple]:
    async with await psycopg.AsyncConnection.connect(url) as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql, params)
            return await cur.fetchall()


async def _seed_user(url: str, *, email: str) -> int:
    async with await psycopg.AsyncConnection.connect(url) as conn:
        async with conn.transaction():
            async with conn.cursor() as cur:
                await cur.execute(
                    "INSERT INTO users (email, password_hash) VALUES (%s, %s) "
                    "RETURNING id",
                    (email, _FAKE_ARGON2_HASH),
                )
                row = await cur.fetchone()
    assert row is not None
    return int(row[0])


async def _seed_book_upload(
    url: str,
    *,
    user_id: int,
    title: str,
    upload_type: str = "literature",
    status: str = "processing",
) -> int:
    async with await psycopg.AsyncConnection.connect(url) as conn:
        async with conn.transaction():
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    INSERT INTO book_uploads (
                        user_id, title, type, status, blob_ref, byte_size)
                    VALUES (%s, %s, %s::book_upload_type, %s::book_upload_status,
                            %s, %s)
                    RETURNING id
                    """,
                    (
                        user_id,
                        title,
                        upload_type,
                        status,
                        f"{user_id}/{uuid.uuid4().hex}.pdf",
                        1024,
                    ),
                )
                row = await cur.fetchone()
    assert row is not None
    return int(row[0])


def _fixture_dict() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _write_fixture(tmp_path: Path, doc: dict, name: str = "literature.json") -> Path:
    path = tmp_path / name
    path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    return path


def _load(url: str, fixture_path: Path) -> dict:
    cfg = LoaderConfig(database_url=url)

    async def run() -> dict:
        async with AsyncConnectionPool(url, min_size=1, max_size=2, open=False) as pool:
            await pool.open(wait=True, timeout=15)
            return await load_literature.load(pool, fixture_path, cfg)

    return asyncio.run(run())


def _seed_user_and_upload(url: str, *, upload_type: str = "literature") -> tuple[int, int]:
    """Seed a fresh user + book_uploads row; return (user_id, upload_id)."""
    suffix = uuid.uuid4().hex[:8]
    user_id = asyncio.run(_seed_user(url, email=f"lit-{suffix}@example.com"))
    upload_id = asyncio.run(
        _seed_book_upload(
            url, user_id=user_id, title=f"Lit Fixture {suffix}", upload_type=upload_type
        )
    )
    return user_id, upload_id


def test_literature_loader_writes_expected_counts(schema, tmp_path):
    url = schema
    _user_id, upload_id = _seed_user_and_upload(url)

    doc = _fixture_dict()
    doc["source"]["source_upload_id"] = upload_id
    expected_chapters = len(doc["chapters"])
    expected_passages = sum(len(c["passages"]) for c in doc["chapters"])
    path = _write_fixture(tmp_path, doc)

    result = _load(url, path)
    assert result["status"] == "complete"
    assert result["chapters"] == expected_chapters
    assert result["passages"] == expected_passages
    assert (
        asyncio.run(
            _count(
                url,
                "SELECT COUNT(*) FROM reading_chapters WHERE source_upload_id = %s",
                (upload_id,),
            )
        )
        == expected_chapters
    )
    assert (
        asyncio.run(
            _count(
                url,
                """
                SELECT COUNT(*) FROM reading_passages rp
                JOIN reading_chapters rc ON rc.id = rp.chapter_id
                WHERE rc.source_upload_id = %s
                """,
                (upload_id,),
            )
        )
        == expected_passages
    )


def test_literature_loader_preserves_ordering_and_text(schema, tmp_path):
    """Chapters/passages must come back in source order with exact body text
    (Korean headwords + punctuation preserved verbatim — no mojibake, no
    truncation)."""
    url = schema
    _user_id, upload_id = _seed_user_and_upload(url)

    doc = _fixture_dict()
    doc["source"]["source_upload_id"] = upload_id
    path = _write_fixture(tmp_path, doc)

    result = _load(url, path)
    assert result["status"] == "complete"

    chapter_rows = asyncio.run(
        _rows(
            url,
            "SELECT chapter_number, title FROM reading_chapters "
            "WHERE source_upload_id = %s ORDER BY chapter_number",
            (upload_id,),
        )
    )
    assert [r[0] for r in chapter_rows] == [1, 2]
    assert [r[1] for r in chapter_rows] == ["제1장", "제2장"]

    chapter1_id = asyncio.run(
        _scalar(
            url,
            "SELECT id FROM reading_chapters "
            "WHERE source_upload_id = %s AND chapter_number = 1",
            (upload_id,),
        )
    )
    passage_rows = asyncio.run(
        _rows(
            url,
            "SELECT passage_number, body, page_number FROM reading_passages "
            "WHERE chapter_id = %s ORDER BY passage_number",
            (chapter1_id,),
        )
    )
    assert [r[0] for r in passage_rows] == [1, 2]
    assert passage_rows[0][1] == "옛날 옛적에 한 마을에 착한 나무꾼이 살고 있었습니다."
    assert passage_rows[0][2] == 1
    assert passage_rows[1][1] == "그는 매일 산에 올라가 나무를 하며 부모님을 모셨습니다."


def test_literature_loader_flips_upload_status_to_ready(schema, tmp_path):
    url = schema
    _user_id, upload_id = _seed_user_and_upload(url)

    doc = _fixture_dict()
    doc["source"]["source_upload_id"] = upload_id
    path = _write_fixture(tmp_path, doc)

    result = _load(url, path)
    assert result["status"] == "complete"
    status = asyncio.run(
        _scalar(url, "SELECT status::text FROM book_uploads WHERE id = %s", (upload_id,))
    )
    assert status == "ready"


def test_literature_loader_sets_user_id_from_upload_owner_not_source_json(
    schema, tmp_path
):
    """Composite-FK owner rule: reading_chapters.user_id must be the upload's
    TRUE owner. The Pydantic source model has no user_id field at all
    (StrictBase extra='ignore'), so even a curation pass that accidentally
    emits a `user_id` key in the source header must have it silently dropped
    — the loader always resolves ownership from book_uploads, never the
    JSON."""
    url = schema
    suffix = uuid.uuid4().hex[:8]
    owner_id = asyncio.run(_seed_user(url, email=f"owner-{suffix}@example.com"))
    other_id = asyncio.run(_seed_user(url, email=f"other-{suffix}@example.com"))
    upload_id = asyncio.run(
        _seed_book_upload(url, user_id=owner_id, title=f"Owned {suffix}")
    )

    doc = _fixture_dict()
    doc["source"]["source_upload_id"] = upload_id
    doc["source"]["user_id"] = other_id  # attempted spoof
    path = _write_fixture(tmp_path, doc)

    result = _load(url, path)
    assert result["status"] == "complete"
    assert result["user_id"] == owner_id
    assert result["user_id"] != other_id

    owners = asyncio.run(
        _rows(
            url,
            "SELECT DISTINCT user_id FROM reading_chapters WHERE source_upload_id = %s",
            (upload_id,),
        )
    )
    assert owners == [(owner_id,)]


def test_literature_loader_idempotent_reload_replaces_cleanly(schema, tmp_path):
    """Re-running the loader on an updated document REPLACES the book's
    chapters/passages — no leftover rows from the prior load survive."""
    url = schema
    _user_id, upload_id = _seed_user_and_upload(url)

    doc = _fixture_dict()
    doc["source"]["source_upload_id"] = upload_id
    path1 = _write_fixture(tmp_path, doc, name="v1.json")
    result1 = _load(url, path1)
    assert result1["status"] == "complete"
    assert result1["chapters"] == 2
    assert result1["passages"] == 3

    # Same load again, unchanged — converges to the identical state (no
    # duplication, no drift).
    result_repeat = _load(url, path1)
    assert result_repeat["status"] == "complete"
    assert result_repeat["chapters"] == 2
    assert result_repeat["passages"] == 3

    # Now drop chapter 2 and trim chapter 1 to a single passage — a re-load
    # must leave EXACTLY this content, not the union of old + new.
    doc_v2 = _fixture_dict()
    doc_v2["source"]["source_upload_id"] = upload_id
    doc_v2["chapters"] = [doc_v2["chapters"][0]]
    doc_v2["chapters"][0]["passages"] = [doc_v2["chapters"][0]["passages"][0]]
    path2 = _write_fixture(tmp_path, doc_v2, name="v2.json")

    result2 = _load(url, path2)
    assert result2["status"] == "complete"
    assert result2["chapters"] == 1
    assert result2["passages"] == 1

    assert (
        asyncio.run(
            _count(
                url,
                "SELECT COUNT(*) FROM reading_chapters WHERE source_upload_id = %s",
                (upload_id,),
            )
        )
        == 1
    )
    assert (
        asyncio.run(
            _scalar(
                url,
                "SELECT COUNT(*) FROM reading_chapters "
                "WHERE source_upload_id = %s AND chapter_number = 2",
                (upload_id,),
            )
        )
        == 0
    )
    assert (
        asyncio.run(
            _count(
                url,
                """
                SELECT COUNT(*) FROM reading_passages rp
                JOIN reading_chapters rc ON rc.id = rp.chapter_id
                WHERE rc.source_upload_id = %s
                """,
                (upload_id,),
            )
        )
        == 1
    )


def test_literature_loader_idempotent_reload_adds_chapter_and_passage(schema, tmp_path):
    """The REMOVE direction is covered by
    test_literature_loader_idempotent_reload_replaces_cleanly (shrink case);
    this covers the ADD direction — a re-extraction that grows the document
    (a curator finds a missed chapter, or a missed passage within an already-
    loaded chapter) must leave exactly the larger set, not silently drop the
    new rows or duplicate the old ones."""
    url = schema
    _user_id, upload_id = _seed_user_and_upload(url)

    # v1: trim to chapter 1 with only its first passage.
    doc_v1 = _fixture_dict()
    doc_v1["source"]["source_upload_id"] = upload_id
    doc_v1["chapters"] = [doc_v1["chapters"][0]]
    doc_v1["chapters"][0]["passages"] = [doc_v1["chapters"][0]["passages"][0]]
    path1 = _write_fixture(tmp_path, doc_v1, name="v1.json")

    result1 = _load(url, path1)
    assert result1["status"] == "complete"
    assert result1["chapters"] == 1
    assert result1["passages"] == 1

    # v2: the full fixture — adds chapter 1's second passage AND a whole new
    # chapter 2.
    doc_v2 = _fixture_dict()
    doc_v2["source"]["source_upload_id"] = upload_id
    path2 = _write_fixture(tmp_path, doc_v2, name="v2.json")

    result2 = _load(url, path2)
    assert result2["status"] == "complete"
    assert result2["chapters"] == 2
    assert result2["passages"] == 3

    chapter_numbers = asyncio.run(
        _rows(
            url,
            "SELECT chapter_number FROM reading_chapters "
            "WHERE source_upload_id = %s ORDER BY chapter_number",
            (upload_id,),
        )
    )
    assert [r[0] for r in chapter_numbers] == [1, 2]

    chapter1_id = asyncio.run(
        _scalar(
            url,
            "SELECT id FROM reading_chapters "
            "WHERE source_upload_id = %s AND chapter_number = 1",
            (upload_id,),
        )
    )
    passage_numbers = asyncio.run(
        _rows(
            url,
            "SELECT passage_number FROM reading_passages "
            "WHERE chapter_id = %s ORDER BY passage_number",
            (chapter1_id,),
        )
    )
    assert [r[0] for r in passage_numbers] == [1, 2]


def test_literature_loader_idempotent_reload_changes_passage_body_text(schema, tmp_path):
    """Same chapter_number/passage_number across a reload, but the curated
    body text itself changed (a correction pass fixing an OCR error) — the
    stored text must reflect the NEW body, not the stale one delete-then-
    insert is supposed to have replaced."""
    url = schema
    _user_id, upload_id = _seed_user_and_upload(url)

    doc_v1 = _fixture_dict()
    doc_v1["source"]["source_upload_id"] = upload_id
    original_body = doc_v1["chapters"][0]["passages"][0]["body"]
    path1 = _write_fixture(tmp_path, doc_v1, name="v1.json")
    result1 = _load(url, path1)
    assert result1["status"] == "complete"

    doc_v2 = _fixture_dict()
    doc_v2["source"]["source_upload_id"] = upload_id
    corrected_body = "옛날 옛적에 한 마을에 착한 나무꾼이 살고 있었더랍니다."
    assert corrected_body != original_body
    doc_v2["chapters"][0]["passages"][0]["body"] = corrected_body
    path2 = _write_fixture(tmp_path, doc_v2, name="v2.json")

    result2 = _load(url, path2)
    assert result2["status"] == "complete"
    # Row counts are unchanged (same chapter/passage numbers) — only the
    # text itself must have moved.
    assert result2["chapters"] == 2
    assert result2["passages"] == 3

    chapter1_id = asyncio.run(
        _scalar(
            url,
            "SELECT id FROM reading_chapters "
            "WHERE source_upload_id = %s AND chapter_number = 1",
            (upload_id,),
        )
    )
    stored_body = asyncio.run(
        _scalar(
            url,
            "SELECT body FROM reading_passages "
            "WHERE chapter_id = %s AND passage_number = 1",
            (chapter1_id,),
        )
    )
    assert stored_body == corrected_body
    assert stored_body != original_body


def test_literature_loader_accepts_empty_passages_divider_chapter(schema, tmp_path):
    """A chapter with zero passages ("divider-only", e.g. a part title page
    with no body text of its own) is design-sanctioned —
    `_literature_extraction_guide.md`'s `passages[]` contract explicitly
    allows an empty list, and `_replace_chapters` special-cases it (`if not
    chapter.passages: continue`, skipping the no-op `executemany`). Must load
    cleanly: the chapter row exists, contributes zero passages, and is not
    rejected by `_validate_document`."""
    url = schema
    _user_id, upload_id = _seed_user_and_upload(url)

    doc = _fixture_dict()
    doc["source"]["source_upload_id"] = upload_id
    doc["chapters"].append(
        {
            "chapter_number": 3,
            "title": "Part Two",
            "start_page": None,
            "end_page": None,
            "passages": [],
        }
    )
    path = _write_fixture(tmp_path, doc)

    result = _load(url, path)
    assert result["status"] == "complete"
    assert result["chapters"] == 3
    # The divider chapter contributes no passages of its own — total passage
    # count is unchanged from the base fixture's 3.
    assert result["passages"] == 3

    divider_id = asyncio.run(
        _scalar(
            url,
            "SELECT id FROM reading_chapters "
            "WHERE source_upload_id = %s AND chapter_number = 3",
            (upload_id,),
        )
    )
    assert divider_id is not None
    passage_count = asyncio.run(
        _count(
            url,
            "SELECT COUNT(*) FROM reading_passages WHERE chapter_id = %s",
            (divider_id,),
        )
    )
    assert passage_count == 0


def test_literature_loader_rejects_missing_upload(schema, tmp_path):
    url = schema
    doc = _fixture_dict()
    doc["source"]["source_upload_id"] = _NONEXISTENT_UPLOAD_ID
    path = _write_fixture(tmp_path, doc)

    with pytest.raises(load_literature.SourceUploadNotFoundError):
        _load(url, path)

    assert (
        asyncio.run(
            _count(
                url,
                "SELECT COUNT(*) FROM reading_chapters WHERE source_upload_id = %s",
                (_NONEXISTENT_UPLOAD_ID,),
            )
        )
        == 0
    )


def test_literature_loader_rejects_non_literature_upload(schema, tmp_path):
    """A vocab/grammar/dialogue/both upload must be refused, not silently
    accept literature chapters."""
    url = schema
    _user_id, upload_id = _seed_user_and_upload(url, upload_type="vocab")

    doc = _fixture_dict()
    doc["source"]["source_upload_id"] = upload_id
    path = _write_fixture(tmp_path, doc)

    with pytest.raises(load_literature.SourceUploadNotFoundError):
        _load(url, path)

    assert (
        asyncio.run(
            _count(
                url,
                "SELECT COUNT(*) FROM reading_chapters WHERE source_upload_id = %s",
                (upload_id,),
            )
        )
        == 0
    )
    # Failure is recorded on the upload row for operator visibility (there is
    # no load_state for this loader — see module docstring).
    status = asyncio.run(
        _scalar(url, "SELECT status::text FROM book_uploads WHERE id = %s", (upload_id,))
    )
    assert status == "failed"


def test_literature_loader_rejects_duplicate_chapter_number(schema, tmp_path):
    url = schema
    _user_id, upload_id = _seed_user_and_upload(url)

    doc = _fixture_dict()
    doc["source"]["source_upload_id"] = upload_id
    # Both chapters claim chapter_number 1 — must fail loud before any write.
    doc["chapters"][1]["chapter_number"] = 1
    path = _write_fixture(tmp_path, doc)

    with pytest.raises(Exception) as exc_info:
        _load(url, path)
    assert "chapter_number" in str(exc_info.value)
    assert "duplicated" in str(exc_info.value)

    assert (
        asyncio.run(
            _count(
                url,
                "SELECT COUNT(*) FROM reading_chapters WHERE source_upload_id = %s",
                (upload_id,),
            )
        )
        == 0
    )
