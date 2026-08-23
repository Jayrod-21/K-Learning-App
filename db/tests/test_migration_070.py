"""Migration 070 (vocab_cards.source_upload_id, ticket F-199) — real-chain
tests.

WHY THIS FILE EXISTS:
    070 moves USER-SAVED upload provenance for vocab onto the user-scoped
    save artifact: it adds a nullable `source_upload_id` FK on `vocab_cards`
    (mirroring migration 068's column on the already-user-scoped
    `grammar_entries`) and BACKFILLS it from the shared
    `vocab_entries.source_upload_id` tag — but ONLY where the tagged upload
    belongs to the card's owner. The pre-070 design wrote the tag onto the
    SHARED vocab_entries row first-write-wins, so a 2nd user mining the same
    lemma from their own upload silently lost their tag (F-199). The route
    layer owns ownership validation + its own coverage
    (server/tests/routes/vocab.test.ts); this file proves the DATABASE-level
    contract: column shape, FK lifecycle, the backfill's ownership rule, and
    the F-088 marker classification on both SQL files.

SCOPE:
    - up: source_upload_id is a nullable BIGINT FK -> book_uploads(id); NULL
      is valid; a dangling id is a ForeignKeyViolation; deleting the
      referenced upload SET-NULLs the tag while the card survives; the up
      file classifies as non-destructive via the F-088 marker (the backfill
      is fill-only — it never overwrites).
    - backfill: a card whose entry is tagged to an upload owned by THE SAME
      user gets the tag copied; a card whose entry is tagged to ANOTHER
      user's upload stays NULL (the mis-attributed shared-row tags are
      dropped, never copied — the exact F-199 bug); untagged entries stay
      NULL; `vocab_entries.source_upload_id` itself is untouched (it remains
      F-108 extracted-corpus provenance); a DIRECT re-run of the up body over
      a table that already carries a route-written card tag never overwrites
      it (the fill-only guard, proven non-vacuously — the down/up round trip
      cannot prove this because down drops the column).
    - down: DROP COLUMN removes source_upload_id (+ FK + partial index); the
      down file classifies as destructive via the F-088 marker (the
      DROP COLUMN shape the legacy sniff would NOT catch — same shape as
      068's own down); cards survive; re-up over populated tables re-runs
      the backfill cleanly (the whole file, backfill included, is
      re-runnable).

DETERMINISM:
    Mirrors test_migration_068.py — real migration files copied into a
    tmp_path-scoped dir, runner pointed at it via --migrations-dir, fresh
    schema per test. Backfill tests seed BETWEEN `up --target 040` and the
    final `up`, so 070's backfill runs over real pre-existing rows.
"""

from __future__ import annotations

import pathlib
import shutil
from typing import Iterable, Optional

import psycopg
import pytest
from psycopg import errors
from psycopg.rows import tuple_row

from db import migrate  # type: ignore[import-not-found]
from db.tests._helpers import _seed_user  # type: ignore[import-not-found]

try:
    from testcontainers.postgres import PostgresContainer  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    PostgresContainer = None  # type: ignore[assignment]


pytestmark = pytest.mark.skipif(
    PostgresContainer is None,
    reason="testcontainers not installed — `pip install testcontainers[postgres]`",
)

REAL_MIGRATIONS_DIR: pathlib.Path = (
    pathlib.Path(__file__).resolve().parents[1] / "migrations"
)


# The migration immediately before 070 in this file's minimal chain — both
# the seeding stop-point for backfill tests and the down-target that rolls
# back exactly 070 and nothing else. 040 creates book_uploads (the FK
# target) + vocab_entries.source_upload_id (the backfill source); 001
# creates vocab_cards; 002 creates vocab_entries.
PRE_070 = "040"


def _copy_real_migrations(dest: pathlib.Path, versions: Iterable[str]) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    wanted = set(versions)
    copied: set[str] = set()
    for src in REAL_MIGRATIONS_DIR.iterdir():
        if src.suffix != ".sql" or not src.is_file():
            continue
        version_prefix = src.name.split("_", 1)[0]
        if version_prefix in wanted:
            shutil.copy2(src, dest / src.name)
            copied.add(version_prefix)
    missing = wanted - copied
    if missing:
        raise FileNotFoundError(
            f"expected real migration files for versions {sorted(missing)} "
            f"under {REAL_MIGRATIONS_DIR}, found none"
        )


@pytest.fixture()
def provenance_dir(tmp_path: pathlib.Path) -> pathlib.Path:
    """001 (users, vocab_cards, set_updated_at()) + 002 (corpus_sources,
    vocab_entries — 040 ALTERs it, so 002 must precede) + 040 (book_uploads,
    the FK target + the shared source_upload_id the backfill reads) + 070
    (the column + backfill under test)."""
    d = tmp_path / "migrations_vocab_card_provenance"
    _copy_real_migrations(d, versions={"001", "002", "040", "070"})
    return d


def _seed_upload(conn: psycopg.Connection, user_id: int, title: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO book_uploads (user_id, title, type, blob_ref, byte_size)
            VALUES (%s, %s, 'vocab'::book_upload_type, %s, 1024)
            RETURNING id
            """,
            (user_id, title, f"{user_id}/test.pdf"),
        )
        return cur.fetchone()[0]


def _ensure_corpus_source(conn: psycopg.Connection) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT id FROM corpus_sources "
            "WHERE corpus = 'vocab_2000_intermediate'::corpus LIMIT 1"
        )
        row = cur.fetchone()
        if row is not None:
            return row[0]
        cur.execute(
            """
            INSERT INTO corpus_sources
                    (corpus, title, level, source_path, default_proficiency)
            VALUES ('vocab_2000_intermediate'::corpus, '2000 Words test seed',
                    'intermediate'::book_level, 'test://seed',
                    'L3'::proficiency_level)
            RETURNING id
            """
        )
        return cur.fetchone()[0]


def _seed_vocab_entry(
    conn: psycopg.Connection, source_id: str, source_upload_id: Optional[int]
) -> int:
    corpus_source_id = _ensure_corpus_source(conn)
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO vocab_entries
                    (corpus_source_id, corpus, source_id, book_level,
                     entry_type, source_book, korean, english, proficiency,
                     source_upload_id)
            VALUES (%s, 'vocab_2000_intermediate'::corpus, %s,
                    'intermediate'::book_level, 'word'::vocab_entry_type,
                    'test-seed', '단어', 'word', 'L3'::proficiency_level, %s)
            RETURNING id
            """,
            (corpus_source_id, source_id, source_upload_id),
        )
        return cur.fetchone()[0]


def _seed_card(
    conn: psycopg.Connection,
    user_id: int,
    vocab_entry_id: int,
    source_upload_id: Optional[int] = None,
    with_tag_column: bool = False,
) -> int:
    """Seed a recognition card. `with_tag_column` only after 070 is applied
    (the column does not exist at the PRE_070 seeding stop-point)."""
    cols = "(user_id, face, vocab_entry_id, proficiency, due_at"
    vals = "(%s, 'recognition'::card_face, %s, 'L3'::proficiency_level, now()"
    params: list = [user_id, vocab_entry_id]
    if with_tag_column:
        cols += ", source_upload_id"
        vals += ", %s"
        params.append(source_upload_id)
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            f"INSERT INTO vocab_cards {cols}) VALUES {vals}) RETURNING id",
            params,
        )
        return cur.fetchone()[0]


def _card_tag(conn: psycopg.Connection, card_id: int) -> Optional[int]:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT source_upload_id FROM vocab_cards WHERE id = %s", (card_id,)
        )
        row = cur.fetchone()
        assert row is not None, f"card {card_id} must exist"
        return row[0]


# ---------------------------------------------------------------------------
# 1. F-088 marker: 070's up is non-destructive, down is destructive.
# ---------------------------------------------------------------------------

def test_070_marker_classification() -> None:
    up_sql = (
        REAL_MIGRATIONS_DIR / "070_vocab_cards_source_upload.up.sql"
    ).read_text(encoding="utf-8")
    down_sql = (
        REAL_MIGRATIONS_DIR / "070_vocab_cards_source_upload.down.sql"
    ).read_text(encoding="utf-8")
    assert migrate.explicit_destructiveness(up_sql) is False
    assert not migrate.contains_destructive(up_sql)
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


def test_070_up_applies_without_allow_destructive(
    env, dsn: str, provenance_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(provenance_dir), "up"])
    assert rc == 0, "070 up must not require --allow-destructive (F-088 marker)"


# ---------------------------------------------------------------------------
# 2. Schema shape: nullable FK — NULL valid, real upload id persists, a
#    dangling id is rejected, and deleting the upload SET-NULLs the tag.
# ---------------------------------------------------------------------------

def test_070_column_accepts_null_and_a_real_owned_upload(
    env, dsn: str, provenance_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(provenance_dir), "up"])
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f199-accepts@example.com")
        upload_id = _seed_upload(conn, user_id, "단어책")
        entry_null = _seed_vocab_entry(conn, "seed-null-tag", None)
        entry_tagged = _seed_vocab_entry(conn, "seed-tagged", None)
        card_null = _seed_card(conn, user_id, entry_null, None, with_tag_column=True)
        card_tagged = _seed_card(
            conn, user_id, entry_tagged, upload_id, with_tag_column=True
        )
        assert _card_tag(conn, card_null) is None
        assert _card_tag(conn, card_tagged) == upload_id


def test_070_fk_rejects_a_dangling_upload_id(
    env, dsn: str, provenance_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(provenance_dir), "up"])
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f199-dangling@example.com")
        entry_id = _seed_vocab_entry(conn, "seed-dangling", None)
        with pytest.raises(errors.ForeignKeyViolation):
            _seed_card(conn, user_id, entry_id, 99_999_999, with_tag_column=True)


def test_070_deleting_the_upload_untags_but_keeps_the_card(
    env, dsn: str, provenance_dir: pathlib.Path
) -> None:
    """ON DELETE SET NULL — the whole point of mirroring 068/040's posture:
    the user's card outlives the source PDF; only the tag clears."""
    rc = migrate.main(["--migrations-dir", str(provenance_dir), "up"])
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f199-setnull@example.com")
        upload_id = _seed_upload(conn, user_id, "삭제될 책")
        entry_id = _seed_vocab_entry(conn, "seed-survivor", None)
        card_id = _seed_card(conn, user_id, entry_id, upload_id, with_tag_column=True)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("DELETE FROM book_uploads WHERE id = %s", (upload_id,))
        assert _card_tag(conn, card_id) is None, "the tag must clear (SET NULL)"


# ---------------------------------------------------------------------------
# 3. BACKFILL — the ownership rule. Seed pre-070 state (entry-level tags,
#    cards without the column) at `up --target 040`, then apply 070 and
#    assert who got the tag.
# ---------------------------------------------------------------------------

def test_070_backfill_copies_owner_matched_tags_and_drops_cross_user_tags(
    env, dsn: str, provenance_dir: pathlib.Path
) -> None:
    """The F-199 core: pre-070 the SHARED entry carried one first-write-wins
    tag. The backfill must copy it ONLY onto cards whose owner owns the
    tagged upload:
      - user A's card on an entry tagged to A's upload  -> tag copied
      - user B's card on that SAME entry (tag = A's upload) -> stays NULL
      - a card on an untagged entry                     -> stays NULL
      - vocab_entries.source_upload_id itself           -> untouched (F-108)
    """
    rc = migrate.main(
        ["--migrations-dir", str(provenance_dir), "--target", PRE_070, "up"]
    )
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_a = _seed_user(conn, "f199-backfill-a@example.com")
        user_b = _seed_user(conn, "f199-backfill-b@example.com")
        upload_a = _seed_upload(conn, user_a, "A의 책")

        # The shared entry both users mined, first-write-wins tagged to A.
        shared_entry = _seed_vocab_entry(conn, "backfill-shared", upload_a)
        card_a = _seed_card(conn, user_a, shared_entry)
        card_b = _seed_card(conn, user_b, shared_entry)

        # Control: a card on an untagged entry.
        plain_entry = _seed_vocab_entry(conn, "backfill-plain", None)
        card_plain = _seed_card(conn, user_a, plain_entry)

    rc = migrate.main(["--migrations-dir", str(provenance_dir), "up"])
    assert rc == 0, "070 up (with the backfill) must apply over seeded rows"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _card_tag(conn, card_a) == upload_a, (
            "owner-matched tag MUST be copied onto the owner's card"
        )
        assert _card_tag(conn, card_b) is None, (
            "a card whose entry was tagged to ANOTHER user's upload must NOT "
            "get the tag (the mis-attributed shared-row tag is dropped)"
        )
        assert _card_tag(conn, card_plain) is None
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT source_upload_id FROM vocab_entries WHERE id = %s",
                (shared_entry,),
            )
            assert cur.fetchone()[0] == upload_a, (
                "the backfill must not modify vocab_entries.source_upload_id "
                "(it stays F-108 extracted-corpus provenance)"
            )


def test_070_backfill_respects_soft_deleted_cards_and_multiple_owners(
    env, dsn: str, provenance_dir: pathlib.Path
) -> None:
    """Each owner's card gets THEIR OWN entry's tag — two users, two entries,
    two uploads, no cross-talk. Soft-deleted cards are backfilled too
    (provenance is a historical fact; every read filters deleted_at)."""
    rc = migrate.main(
        ["--migrations-dir", str(provenance_dir), "--target", PRE_070, "up"]
    )
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_a = _seed_user(conn, "f199-multi-a@example.com")
        user_b = _seed_user(conn, "f199-multi-b@example.com")
        upload_a = _seed_upload(conn, user_a, "A의 두번째 책")
        upload_b = _seed_upload(conn, user_b, "B의 책")
        entry_a = _seed_vocab_entry(conn, "multi-a", upload_a)
        entry_b = _seed_vocab_entry(conn, "multi-b", upload_b)
        card_a = _seed_card(conn, user_a, entry_a)
        card_b = _seed_card(conn, user_b, entry_b)
        soft_deleted = _seed_card(conn, user_a, entry_b)  # cross-user: no tag
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE vocab_cards SET deleted_at = now() WHERE id = %s",
                (card_a,),
            )

    rc = migrate.main(["--migrations-dir", str(provenance_dir), "up"])
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _card_tag(conn, card_a) == upload_a, (
            "soft-deleted owner-matched card is still backfilled"
        )
        assert _card_tag(conn, card_b) == upload_b
        assert _card_tag(conn, soft_deleted) is None, (
            "A's card on B's-upload-tagged entry must stay NULL"
        )


def test_070_backfill_rerun_never_overwrites_an_existing_card_tag(
    env, dsn: str, provenance_dir: pathlib.Path
) -> None:
    """The fill-only guard (`c.source_upload_id IS NULL`, the up file's last
    predicate) is what makes a re-run of the backfill unable to clobber a tag
    the route has written since — the up header claims exactly this. The
    down/up round-trip tests CANNOT exercise it: down drops the column, so
    every re-up backfills an all-NULL column and the guard is vacuously true.
    Execute the REAL up file's body directly (psycopg, not the runner — the
    runner never re-runs an applied version) over a table that already
    carries a route-written card tag DIFFERENT from the entry-derivable one:
      - the pre-existing tag (upload X) must survive even though the entry
        points at same-owner upload Y, which a guard-less backfill would copy
      - an untagged control card on a Y-tagged entry must still be FILLED —
        proving the UPDATE genuinely executed and only the guard protected
        the tag (not a skipped or failed statement).
    """
    rc = migrate.main(["--migrations-dir", str(provenance_dir), "up"])
    assert rc == 0

    up_sql = (
        provenance_dir / "070_vocab_cards_source_upload.up.sql"
    ).read_text(encoding="utf-8")

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f199-no-overwrite@example.com")
        upload_x = _seed_upload(conn, user_id, "카드가 이미 가리키는 책")
        upload_y = _seed_upload(conn, user_id, "엔트리가 가리키는 책")

        # The dangerous state: entry tagged to Y (same owner), card already
        # route-tagged to X. A broken/absent guard would flip X -> Y.
        entry_tagged = _seed_vocab_entry(conn, "no-overwrite-kept", upload_y)
        tagged_card = _seed_card(
            conn, user_id, entry_tagged, upload_x, with_tag_column=True
        )

        # Fill control: same shape, but the card has no tag yet.
        entry_fill = _seed_vocab_entry(conn, "no-overwrite-fill", upload_y)
        control_card = _seed_card(
            conn, user_id, entry_fill, None, with_tag_column=True
        )

        # Re-run the whole up body (idempotent by design: IF NOT EXISTS DDL
        # + the fill-only backfill). ADR-013: the file holds no BEGIN/COMMIT,
        # so a plain execute runs it exactly as the runner would.
        with conn.cursor() as cur:
            cur.execute(up_sql)

        assert _card_tag(conn, tagged_card) == upload_x, (
            "fill-only guard: a backfill re-run must NOT overwrite a card "
            "tag the route has already written"
        )
        assert _card_tag(conn, control_card) == upload_y, (
            "control: the re-run backfill must still fill untagged cards — "
            "the guard, not a skipped UPDATE, is what protected the tag"
        )


# ---------------------------------------------------------------------------
# 4. DOWN — DROP COLUMN removes source_upload_id (+ FK + index), requires
#    --allow-destructive (F-088 marker); cards survive; re-up (backfill
#    included) is clean over populated tables.
# ---------------------------------------------------------------------------

def test_070_down_requires_allow_destructive_then_drops_column(
    env, dsn: str, provenance_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(provenance_dir), "up"])
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f199-down@example.com")
        upload_id = _seed_upload(conn, user_id, "롤백 책")
        entry_id = _seed_vocab_entry(conn, "seed-rollback", None)
        _seed_card(conn, user_id, entry_id, upload_id, with_tag_column=True)

    # The gate must refuse without the flag (F-088 marker declares 070.down
    # destructive even though DROP COLUMN has no keyword the legacy sniff
    # catches — same shape as 068's own down).
    rc = migrate.main(
        ["--migrations-dir", str(provenance_dir), "--target", PRE_070, "down"]
    )
    assert rc != 0, "070.down is marked destructive — the gate must refuse it"

    rc = migrate.main(
        [
            "--migrations-dir",
            str(provenance_dir),
            "--target",
            PRE_070,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_070} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor(
        row_factory=tuple_row
    ) as cur:
        cur.execute(
            """
            SELECT 1 FROM information_schema.columns
             WHERE table_name = 'vocab_cards'
               AND column_name = 'source_upload_id'
            """
        )
        assert cur.fetchone() is None, "source_upload_id must be gone after 070 down"
        # The card survives (only its provenance column is dropped).
        cur.execute("SELECT count(*) FROM vocab_cards")
        assert cur.fetchone()[0] == 1


def test_070_down_up_round_trip_re_runs_the_backfill(
    env, dsn: str, provenance_dir: pathlib.Path
) -> None:
    """Down discards the card tags (documented lossy); re-up must be clean
    over populated tables AND re-derive the recoverable tags from the
    entry-level source — proving the whole up file, backfill included, is
    re-runnable."""
    rc = migrate.main(
        ["--migrations-dir", str(provenance_dir), "--target", PRE_070, "up"]
    )
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f199-reup@example.com")
        upload_id = _seed_upload(conn, user_id, "재적용 책")
        entry_id = _seed_vocab_entry(conn, "seed-reup", upload_id)
        card_id = _seed_card(conn, user_id, entry_id)

    rc = migrate.main(["--migrations-dir", str(provenance_dir), "up"])
    assert rc == 0
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _card_tag(conn, card_id) == upload_id

    rc = migrate.main(
        [
            "--migrations-dir",
            str(provenance_dir),
            "--target",
            PRE_070,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0

    rc = migrate.main(["--migrations-dir", str(provenance_dir), "up"])
    assert rc == 0, "070 must re-apply cleanly over vocab_cards with rows"
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _card_tag(conn, card_id) == upload_id, (
            "re-up re-runs the backfill and re-derives the owner-matched tag"
        )
