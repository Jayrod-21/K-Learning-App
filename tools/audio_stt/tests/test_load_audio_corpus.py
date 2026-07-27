"""Corpus-loader tests against a real migrated Postgres (conftest's
session-scoped 073..077 chain) + a temp audio root with tiny fake mp3/m4a
files. No Whisper, no worker — the loader's contract is the SCHEMA plus the
blob layout the running km-worker consumes.

Coverage (each maps to a locked decision or a bug class the loader defends
against — test_worker.py's checklist style):
  - end-to-end: one set -> 1 source (standalone, NULL source_upload_id) +
    N tracks (track_number 1..N in sorted-filename order, cleaned titles,
    byte_size = file size) + N pending jobs (charged_bytes = byte_size),
    blobs at {userId}/{uuid}.{ext} under the root with the source bytes.
  - IDEMPOTENT re-run: zero new rows, zero re-copied blobs, no 23505 off
    uq_audio_transcription_jobs_track_live.
  - resume semantics: a 'done' track is skipped outright; a 'failed' track
    is re-enqueued exactly once (transcript_status back to 'pending', never
    a second live job); a still-live track is left to the worker.
  - --dry-run: real counts, ZERO rows and ZERO blobs (the Rollback path).
  - traversal safety: write_blob refuses absolute/../ paths (blobstore's
    resolve_under_root guard on the WRITE side).
  - composite-FK correctness: every track's (source_id, user_id) pair is
    the source's; a forged pair is a structural 23503 (074's owner guard).
  - re-numbering drift guard: a changed file size under a committed
    track_number refuses the set (the F-185 silent-mis-mapping class).
  - SF-1: hidden/AppleDouble files ('._*', .DS_Store, dot-dirs) excluded
    from discovery — they must never shift track_number.
  - SF-4: a 'done' track whose blob FILE is missing gets it healed back to
    the SAME blob_ref (playback needs the file), with zero row churn.
  - SF-5: a track failing AFTER its blob copy rolls back ONLY that track's
    transaction and unlinks ONLY that track's blob (no orphan survives the
    failed unit; earlier per-track commits are durable resume progress).
  - SF-6(a): a same-size content swap is refused by the prefix-hash guard.
  - SF-6(b): trailing-file removal logs a WARNING (stale committed tracks
    beyond files_seen are surfaced, never silently ignored or deleted).
  - N-9: stale .tmp-* files are swept at startup; young ones are kept (a
    concurrent loader's in-flight copy).
  - the autocommit guard: load_set refuses a non-autocommit connection
    (per-track transactions would degrade to savepoints).
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
import structlog

pytest.importorskip("psycopg", reason="loader tests require psycopg")

import psycopg  # noqa: E402
from psycopg.errors import ForeignKeyViolation  # noqa: E402
from psycopg.rows import tuple_row  # noqa: E402

from tools.audio_stt.blobstore import BlobPathError  # noqa: E402
from tools.audio_stt.load_audio_corpus import (  # noqa: E402
    SetLoadError,
    SetSpec,
    clean_track_title,
    discover_audio_files,
    load_set,
    write_blob,
)

from .conftest import requires_pg  # noqa: E402
from .seeds import seed_user  # noqa: E402

pytestmark = requires_pg


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

# Deliberately name-sorted: 01 < 02 < zz. Mixed mp3/m4a, distinct sizes so
# byte_size/charged_bytes assertions can tell tracks apart.
_SET_FILES: list[tuple[str, bytes]] = [
    ("01. Page 3 옛날 이야기.mp3", b"ID3-fake-mp3-bytes-one"),
    ("02. Page 5-6 다음 이야기.m4a", b"ftyp-fake-m4a-bytes-two!!"),
    ("zz plain title.mp3", b"ID3-fake-mp3-bytes-three-longer"),
]


def _make_set_dir(base: Path, files: list[tuple[str, bytes]] = _SET_FILES) -> Path:
    set_dir = base / "folktales"
    set_dir.mkdir(parents=True, exist_ok=True)
    for name, data in files:
        (set_dir / name).write_bytes(data)
    # Non-audio noise the discovery must skip silently.
    (set_dir / "cover.jpg").write_bytes(b"jpeg")
    (set_dir / ".DS_Store").write_bytes(b"junk")
    # SF-1: a macOS AppleDouble resource fork — a REAL .mp3 suffix and
    # NON-zero bytes, and it sorts before every real file ('.' < digits).
    # Present in EVERY fixture set so all the e2e tests prove it never
    # becomes a track or shifts track_number.
    (set_dir / "._01 preface.mp3").write_bytes(b"\x00\x05\x16\x07appledouble")
    return set_dir


def _spec(set_dir: Path, slug: str = "folktales") -> SetSpec:
    return SetSpec(set_dir=set_dir, slug=slug, title="Korean Folktales")


def _rows(conn: psycopg.Connection, sql: str, params: tuple = ()) -> list[tuple]:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def _blob_files(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*") if p.is_file())


# ---------------------------------------------------------------------------
# Pure helpers (no DB)
# ---------------------------------------------------------------------------


def test_clean_track_title_strips_number_and_page_noise() -> None:
    assert clean_track_title("03. Page 15 The Rabbit.mp3", 3) == "The Rabbit"
    assert clean_track_title("01. Page 3 옛날 이야기.mp3", 1) == "옛날 이야기"
    assert clean_track_title("02. Page 5-6 다음 이야기.m4a", 2) == "다음 이야기"
    assert clean_track_title("zz plain title.mp3", 9) == "zz plain title"
    # All-noise names fall back rather than violating the 1..500 CHECK.
    assert clean_track_title("07.mp3", 7) == "Track 7"
    # Bounded to the DB's 500-char title CHECK.
    assert len(clean_track_title(("x" * 600) + ".mp3", 1)) == 500


def test_discovery_is_sorted_and_fails_loud_on_empty(tmp_path: Path) -> None:
    set_dir = _make_set_dir(tmp_path)
    names = [p.name for p in discover_audio_files(set_dir)]
    assert names == [n for n, _ in _SET_FILES]  # sorted; jpg/DS_Store skipped
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(SetLoadError, match="no .mp3/.m4a files"):
        discover_audio_files(empty)


def test_discovery_skips_hidden_and_appledouble(tmp_path: Path) -> None:
    """SF-1: '._*' AppleDouble forks (valid .mp3 suffix, non-zero bytes),
    .DS_Store, and files under dot-directories are excluded — and because
    '.' sorts before every digit, admitting one would shift EVERY
    track_number. The full name list proves numbering is unshifted."""
    set_dir = _make_set_dir(tmp_path)  # already plants ._01 + .DS_Store
    (set_dir / "._02 another fork.m4a").write_bytes(b"\x00\x05\x16\x07more")
    hidden_dir = set_dir / ".Trashes"
    hidden_dir.mkdir()
    (hidden_dir / "00 stray.mp3").write_bytes(b"audio inside a dot-dir")

    files = discover_audio_files(set_dir)
    assert [p.name for p in files] == [n for n, _ in _SET_FILES]
    # Track numbering (enumerate order) starts at the first REAL file.
    assert files[0].name == _SET_FILES[0][0]


def test_write_blob_blocks_traversal(tmp_path: Path) -> None:
    root = tmp_path / "audio-root"
    root.mkdir()
    src = tmp_path / "a.mp3"
    src.write_bytes(b"bytes")
    with pytest.raises(BlobPathError):
        write_blob(root, "../evil.mp3", src)
    with pytest.raises(BlobPathError):
        write_blob(root, "7/../../evil.mp3", src)
    with pytest.raises(BlobPathError):
        write_blob(root, "/etc/evil.mp3", src)
    # Nothing escaped, nothing landed.
    assert _blob_files(root) == []
    assert not (tmp_path / "evil.mp3").exists()


# ---------------------------------------------------------------------------
# End-to-end against the migrated schema
# ---------------------------------------------------------------------------


def test_loads_a_set_end_to_end(conn: psycopg.Connection, tmp_path: Path) -> None:
    user_id = seed_user(conn, "loader@test.dev")
    set_dir = _make_set_dir(tmp_path)
    root = tmp_path / "audio-root"

    report = load_set(
        conn, spec=_spec(set_dir), user_id=user_id, audio_root=root
    )
    assert report.tracks_created == 3
    assert report.jobs_enqueued == 3
    assert report.blobs_written == 3
    assert report.bytes_enqueued == sum(len(d) for _, d in _SET_FILES)

    sources = _rows(
        conn,
        """SELECT id, slug, title, kind, source_upload_id, status
             FROM audio_sources WHERE user_id = %s""",
        (user_id,),
    )
    assert len(sources) == 1
    source_id, slug, title, kind, upload_id, status = sources[0]
    assert (slug, title, kind, upload_id, status) == (
        "folktales", "Korean Folktales", "standalone_listening", None, "processing",
    )

    tracks = _rows(
        conn,
        """SELECT track_number, title, blob_ref, byte_size, transcript_status
             FROM audio_tracks WHERE source_id = %s ORDER BY track_number""",
        (source_id,),
    )
    assert [t[0] for t in tracks] == [1, 2, 3]
    assert [t[1] for t in tracks] == ["옛날 이야기", "다음 이야기", "zz plain title"]
    assert all(t[4] == "pending" for t in tracks)
    for (n, _t, blob_ref, byte_size, _s), (name, data) in zip(tracks, _SET_FILES):
        assert int(byte_size) == len(data)
        # blob_ref shape: {userId}/{uuid}.{ext from the file's real suffix}.
        prefix, blob_name = blob_ref.split("/")
        assert prefix == str(user_id)
        assert blob_name.endswith(Path(name).suffix.lower())
        blob = root / blob_ref
        assert blob.is_file() and blob.read_bytes() == data, f"track {n} blob"

    jobs = _rows(
        conn,
        """SELECT t.track_number, j.status::text, j.charged_bytes
             FROM audio_transcription_jobs j
             JOIN audio_tracks t ON t.id = j.track_id
            WHERE j.user_id = %s ORDER BY t.track_number""",
        (user_id,),
    )
    assert [(n, s) for n, s, _ in jobs] == [(1, "pending"), (2, "pending"), (3, "pending")]
    assert [int(c) for _, _, c in jobs] == [len(d) for _, d in _SET_FILES]


def test_rerun_is_idempotent(conn: psycopg.Connection, tmp_path: Path) -> None:
    user_id = seed_user(conn, "loader@test.dev")
    set_dir = _make_set_dir(tmp_path)
    root = tmp_path / "audio-root"
    spec = _spec(set_dir)

    load_set(conn, spec=spec, user_id=user_id, audio_root=root)
    # N-7: fingerprint every blob by (mtime_ns, bytes) — independent of the
    # loader's own counters, so a regression that silently re-copies (same
    # path, same content, fresh write) is still caught by the mtime.
    blobs_before = {
        p: (p.stat().st_mtime_ns, p.read_bytes()) for p in _blob_files(root)
    }
    refs_before = _rows(conn, "SELECT blob_ref FROM audio_tracks ORDER BY id")
    version_before = _rows(
        conn, "SELECT version, updated_at FROM audio_sources"
    )[0]

    # Second run: must not 23505 on the live-claim index, duplicate rows, or
    # touch a single blob.
    report = load_set(conn, spec=spec, user_id=user_id, audio_root=root)
    assert report.tracks_created == 0
    assert report.jobs_enqueued == 0
    assert report.jobs_already_live == 3
    assert report.blobs_recopied == 0

    assert _rows(conn, "SELECT count(*) FROM audio_sources")[0][0] == 1
    assert _rows(conn, "SELECT count(*) FROM audio_tracks")[0][0] == 3
    assert _rows(conn, "SELECT count(*) FROM audio_transcription_jobs")[0][0] == 3
    blobs_after = {
        p: (p.stat().st_mtime_ns, p.read_bytes()) for p in _blob_files(root)
    }
    assert blobs_after == blobs_before  # not re-copied, none added
    assert _rows(conn, "SELECT blob_ref FROM audio_tracks ORDER BY id") == refs_before
    # N-8: a no-op resume must not churn the source's audit fields.
    assert _rows(
        conn, "SELECT version, updated_at FROM audio_sources"
    )[0] == version_before


def test_resume_skips_done_and_reenqueues_failed(
    conn: psycopg.Connection, tmp_path: Path
) -> None:
    user_id = seed_user(conn, "loader@test.dev")
    set_dir = _make_set_dir(tmp_path)
    root = tmp_path / "audio-root"
    spec = _spec(set_dir)
    load_set(conn, spec=spec, user_id=user_id, audio_root=root)

    # Simulate the worker settling: track 1 done, track 2 failed; track 3
    # keeps its live pending job.
    conn.execute(
        """UPDATE audio_transcription_jobs j
              SET status = s.status::audio_transcription_status,
                  finished_at = now()
             FROM (SELECT t.id AS track_id,
                          CASE t.track_number WHEN 1 THEN 'done' ELSE 'failed' END AS status
                     FROM audio_tracks t WHERE t.track_number IN (1, 2)) s
            WHERE j.track_id = s.track_id"""
    )
    conn.execute(
        """UPDATE audio_tracks
              SET transcript_status = CASE track_number WHEN 1 THEN 'done' ELSE 'failed' END
            WHERE track_number IN (1, 2)"""
    )

    report = load_set(conn, spec=spec, user_id=user_id, audio_root=root)
    assert report.tracks_skipped_done == 1  # track 1 never re-enqueued
    assert report.jobs_enqueued == 1        # track 2 got exactly one new job
    assert report.jobs_already_live == 1    # track 3 left to the worker
    assert report.tracks_created == 0

    per_track = _rows(
        conn,
        """SELECT t.track_number, t.transcript_status,
                  count(*) FILTER (WHERE j.status IN ('pending', 'running')) AS live,
                  count(j.id) AS total
             FROM audio_tracks t
             LEFT JOIN audio_transcription_jobs j ON j.track_id = t.id
            GROUP BY t.track_number, t.transcript_status
            ORDER BY t.track_number""",
    )
    assert per_track == [
        (1, "done", 0, 1),     # untouched
        (2, "pending", 1, 2),  # failed -> re-enqueued, status back to pending
        (3, "pending", 1, 1),  # original live job only
    ]

    # A third run changes nothing: track 2's fresh job is now the live one.
    report = load_set(conn, spec=spec, user_id=user_id, audio_root=root)
    assert report.jobs_enqueued == 0
    assert report.jobs_already_live == 2
    assert _rows(conn, "SELECT count(*) FROM audio_transcription_jobs")[0][0] == 4


def test_dry_run_writes_nothing(conn: psycopg.Connection, tmp_path: Path) -> None:
    user_id = seed_user(conn, "loader@test.dev")
    set_dir = _make_set_dir(tmp_path)
    root = tmp_path / "audio-root"

    report = load_set(
        conn, spec=_spec(set_dir), user_id=user_id, audio_root=root, dry_run=True
    )
    # Real plan counts...
    assert report.dry_run is True
    assert report.tracks_created == 3
    assert report.jobs_enqueued == 3
    assert report.bytes_enqueued == sum(len(d) for _, d in _SET_FILES)
    # ...zero writes.
    assert _rows(conn, "SELECT count(*) FROM audio_sources")[0][0] == 0
    assert _rows(conn, "SELECT count(*) FROM audio_tracks")[0][0] == 0
    assert _rows(conn, "SELECT count(*) FROM audio_transcription_jobs")[0][0] == 0
    assert not root.exists() or _blob_files(root) == []


def test_composite_owner_fk_correctness(
    conn: psycopg.Connection, tmp_path: Path
) -> None:
    user_id = seed_user(conn, "owner@test.dev")
    other_id = seed_user(conn, "other@test.dev")
    set_dir = _make_set_dir(tmp_path)
    root = tmp_path / "audio-root"
    load_set(conn, spec=_spec(set_dir), user_id=user_id, audio_root=root)

    # Every loaded track's (source_id, user_id) is exactly its source's pair.
    mismatched = _rows(
        conn,
        """SELECT count(*) FROM audio_tracks t
             JOIN audio_sources s ON s.id = t.source_id
            WHERE t.user_id <> s.user_id""",
    )
    assert mismatched[0][0] == 0

    # And a forged pair is structurally impossible (074's composite FK): the
    # same source_id under ANOTHER user's id must 23503, not insert.
    source_id = _rows(conn, "SELECT id FROM audio_sources LIMIT 1")[0][0]
    with pytest.raises(ForeignKeyViolation):
        conn.execute(
            """INSERT INTO audio_tracks
                   (source_id, user_id, track_number, blob_ref, byte_size)
               VALUES (%s, %s, 99, 'forged/evil.mp3', 10)""",
            (source_id, other_id),
        )


def test_changed_file_size_refuses_the_set(
    conn: psycopg.Connection, tmp_path: Path
) -> None:
    user_id = seed_user(conn, "loader@test.dev")
    set_dir = _make_set_dir(tmp_path)
    root = tmp_path / "audio-root"
    spec = _spec(set_dir)
    load_set(conn, spec=spec, user_id=user_id, audio_root=root)

    # Grow file 2 — as if the sorted list drifted under committed numbering.
    name2 = _SET_FILES[1][0]
    (set_dir / name2).write_bytes(b"different, longer m4a payload than before")

    with pytest.raises(SetLoadError, match="file list has changed"):
        load_set(conn, spec=spec, user_id=user_id, audio_root=root)
    # The refused track's transaction rolled back; the earlier track's no-op
    # transaction wrote nothing — still 3 tracks, 3 jobs, no dupes.
    assert _rows(conn, "SELECT count(*) FROM audio_tracks")[0][0] == 3
    assert _rows(conn, "SELECT count(*) FROM audio_transcription_jobs")[0][0] == 3


def test_same_size_content_swap_is_refused(
    conn: psycopg.Connection, tmp_path: Path
) -> None:
    """SF-6(a): byte_size alone cannot catch two same-size files whose
    sorted order swapped (fixed-bitrate clips) — the 64 KiB prefix-hash
    guard must refuse the set instead of silently mis-mapping audio."""
    user_id = seed_user(conn, "loader@test.dev")
    set_dir = _make_set_dir(tmp_path)
    root = tmp_path / "audio-root"
    spec = _spec(set_dir)
    load_set(conn, spec=spec, user_id=user_id, audio_root=root)

    name1, data1 = _SET_FILES[0]
    swapped = b"ID3-fake-mp3-bytes-uno"  # same length, different content
    assert len(swapped) == len(data1) and swapped != data1
    (set_dir / name1).write_bytes(swapped)

    with pytest.raises(SetLoadError, match="same byte_size"):
        load_set(conn, spec=spec, user_id=user_id, audio_root=root)
    # Nothing changed: rows and the committed blob's bytes are untouched.
    assert _rows(conn, "SELECT count(*) FROM audio_tracks")[0][0] == 3
    assert _rows(conn, "SELECT count(*) FROM audio_transcription_jobs")[0][0] == 3
    blob_ref = _rows(
        conn, "SELECT blob_ref FROM audio_tracks WHERE track_number = 1"
    )[0][0]
    assert (root / blob_ref).read_bytes() == data1


def test_trailing_file_removal_logs_warning(
    conn: psycopg.Connection, tmp_path: Path
) -> None:
    """SF-6(b): files removed from the END of the sorted list never hit the
    per-track guards (the loop just stops early) — the loader must WARN
    that committed tracks beyond files_seen have no file, and must leave
    those rows untouched."""
    user_id = seed_user(conn, "loader@test.dev")
    set_dir = _make_set_dir(tmp_path)
    root = tmp_path / "audio-root"
    spec = _spec(set_dir)
    load_set(conn, spec=spec, user_id=user_id, audio_root=root)

    (set_dir / _SET_FILES[2][0]).unlink()  # drop the LAST sorted file

    with structlog.testing.capture_logs() as logs:
        report = load_set(conn, spec=spec, user_id=user_id, audio_root=root)
    assert report.files_seen == 2
    warning = [
        e for e in logs if e["event"] == "trailing_tracks_missing_from_directory"
    ]
    assert len(warning) == 1
    assert warning[0]["committed_max_track_number"] == 3
    assert warning[0]["files_seen"] == 2
    # Warn, never delete: the stale committed track (and its job) survive.
    assert _rows(conn, "SELECT count(*) FROM audio_tracks")[0][0] == 3
    assert _rows(conn, "SELECT count(*) FROM audio_transcription_jobs")[0][0] == 3


def test_done_track_with_missing_blob_is_healed(
    conn: psycopg.Connection, tmp_path: Path
) -> None:
    """SF-4: a 'done' track whose blob FILE is gone gets it re-copied to the
    SAME blob_ref — the transcript exists but Listen streams the FILE — with
    zero row churn and no re-enqueue."""
    user_id = seed_user(conn, "loader@test.dev")
    set_dir = _make_set_dir(tmp_path)
    root = tmp_path / "audio-root"
    spec = _spec(set_dir)
    load_set(conn, spec=spec, user_id=user_id, audio_root=root)

    # The worker settled track 1 done; then its blob file vanishes
    # (lost commit-ack / operator deletion).
    conn.execute(
        """UPDATE audio_transcription_jobs
              SET status = 'done', finished_at = now()
            WHERE track_id = (SELECT id FROM audio_tracks WHERE track_number = 1)"""
    )
    conn.execute(
        "UPDATE audio_tracks SET transcript_status = 'done' WHERE track_number = 1"
    )
    blob_ref = _rows(
        conn, "SELECT blob_ref FROM audio_tracks WHERE track_number = 1"
    )[0][0]
    (root / blob_ref).unlink()
    rows_before = _rows(
        conn,
        """SELECT id, blob_ref, byte_size, transcript_status, version
             FROM audio_tracks ORDER BY id""",
    )

    report = load_set(conn, spec=spec, user_id=user_id, audio_root=root)
    assert report.blobs_recopied == 1
    assert report.tracks_skipped_done == 1
    assert report.jobs_enqueued == 0
    # Restored at the SAME ref with the source bytes; rows byte-identical.
    assert (root / blob_ref).read_bytes() == _SET_FILES[0][1]
    assert _rows(
        conn,
        """SELECT id, blob_ref, byte_size, transcript_status, version
             FROM audio_tracks ORDER BY id""",
    ) == rows_before
    # The done track got NO new job — its live-job count stays zero.
    live = _rows(
        conn,
        """SELECT count(*) FROM audio_transcription_jobs j
             JOIN audio_tracks t ON t.id = j.track_id
            WHERE t.track_number = 1 AND j.status IN ('pending', 'running')""",
    )
    assert live[0][0] == 0

    # And a heal must NOT re-copy a blob that is present (write-once): a
    # third run touches nothing.
    mtime_ns = (root / blob_ref).stat().st_mtime_ns
    report = load_set(conn, spec=spec, user_id=user_id, audio_root=root)
    assert report.blobs_recopied == 0
    assert (root / blob_ref).stat().st_mtime_ns == mtime_ns


def test_failed_track_tx_unlinks_only_its_own_blob(
    conn: psycopg.Connection, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SF-5: the rollback-unlink contract, exercised for real. A 4th file
    whose track INSERT trips 074's title CHECK fails AFTER its blob was
    copied — exactly the window the unlink contract covers. That track's
    transaction rolls back and its blob is unlinked; the earlier tracks'
    per-track commits (rows AND blobs) are durable resume progress. No
    orphan blob survives the failed unit."""
    import tools.audio_stt.load_audio_corpus as loader_mod

    user_id = seed_user(conn, "loader@test.dev")
    files = _SET_FILES + [("zz-zz broken.mp3", b"bytes that never commit")]
    set_dir = _make_set_dir(tmp_path, files)
    root = tmp_path / "audio-root"

    real_clean = loader_mod.clean_track_title

    def poisoned(filename: str, track_number: int) -> str:
        if filename == "zz-zz broken.mp3":
            # '' violates ck_audio_tracks_title_length (1..500) at INSERT
            # time — a REAL constraint firing after the blob copy.
            return ""
        return real_clean(filename, track_number)

    monkeypatch.setattr(loader_mod, "clean_track_title", poisoned)
    with pytest.raises(psycopg.errors.CheckViolation):
        load_set(conn, spec=_spec(set_dir), user_id=user_id, audio_root=root)

    # Earlier tracks committed durably (per-track resume progress)...
    assert _rows(conn, "SELECT count(*) FROM audio_sources")[0][0] == 1
    assert _rows(conn, "SELECT count(*) FROM audio_tracks")[0][0] == 3
    assert _rows(conn, "SELECT count(*) FROM audio_transcription_jobs")[0][0] == 3
    # ...and the failed track's blob was unlinked: the disk holds EXACTLY
    # the committed refs — no orphan survives the failed unit.
    refs = {r[0] for r in _rows(conn, "SELECT blob_ref FROM audio_tracks")}
    on_disk = {p.relative_to(root).as_posix() for p in _blob_files(root)}
    assert on_disk == refs

    # Resume after fixing the source: remove the bad file, re-run, no-op.
    (set_dir / "zz-zz broken.mp3").unlink()
    monkeypatch.setattr(loader_mod, "clean_track_title", real_clean)
    report = load_set(conn, spec=_spec(set_dir), user_id=user_id, audio_root=root)
    assert report.tracks_created == 0
    assert report.jobs_already_live == 3


def test_stale_tmp_swept_and_fresh_tmp_kept(
    conn: psycopg.Connection, tmp_path: Path
) -> None:
    """N-9: startup sweeps orphaned '.tmp-*' files older than an hour (a
    SIGKILL mid-copy strands them); a YOUNG tmp — possibly a concurrent
    loader's in-flight copy — is left alone."""
    user_id = seed_user(conn, "loader@test.dev")
    set_dir = _make_set_dir(tmp_path)
    root = tmp_path / "audio-root"
    root.mkdir()
    stale = root / ".tmp-deadbeefdeadbeef"
    stale.write_bytes(b"orphaned half-copy")
    two_hours_ago = time.time() - 7200
    os.utime(stale, (two_hours_ago, two_hours_ago))
    fresh = root / ".tmp-cafebabecafebabe"
    fresh.write_bytes(b"in-flight copy")

    load_set(conn, spec=_spec(set_dir), user_id=user_id, audio_root=root)
    assert not stale.exists()
    assert fresh.exists()


def test_load_set_refuses_non_autocommit_connection(
    dsn: str, tmp_path: Path
) -> None:
    """The per-track transaction model silently degrades to savepoints
    inside one implicit outer transaction on a non-autocommit connection —
    load_set must refuse up front (before touching DB or disk)."""
    set_dir = _make_set_dir(tmp_path)
    with psycopg.connect(dsn) as nc:  # autocommit=False (psycopg default)
        with pytest.raises(SetLoadError, match="autocommit"):
            load_set(
                nc,
                spec=_spec(set_dir),
                user_id=1,
                audio_root=tmp_path / "audio-root",
            )
