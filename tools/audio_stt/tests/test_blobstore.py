"""Traversal-defense tests for blobstore — the uploadStore.ts port.

Each case maps to an attack shape uploadStore's tests pin: absolute paths,
``..`` escapes, and the sibling-prefix root (``/var/audio-evil`` vs
``/var/audio`` — the trailing-separator check's whole reason to exist)."""

from __future__ import annotations

import pytest

from tools.audio_stt.blobstore import (
    BlobMissing,
    BlobPathError,
    resolve_existing_blob,
    resolve_under_root,
)


def test_resolves_a_valid_relative_path(tmp_path) -> None:
    root = tmp_path / "audio"
    (root / "7").mkdir(parents=True)
    (root / "7" / "track.mp3").write_bytes(b"bytes")
    assert resolve_under_root(root, "7/track.mp3") == root / "7" / "track.mp3"
    assert resolve_existing_blob(root, "7/track.mp3") == root / "7" / "track.mp3"


def test_rejects_absolute_path(tmp_path) -> None:
    with pytest.raises(BlobPathError, match="must be relative"):
        resolve_under_root(tmp_path, "/etc/passwd")


def test_rejects_dotdot_escape(tmp_path) -> None:
    root = tmp_path / "audio"
    root.mkdir()
    with pytest.raises(BlobPathError, match="escapes storage root"):
        resolve_under_root(root, "../secrets.txt")
    with pytest.raises(BlobPathError, match="escapes storage root"):
        resolve_under_root(root, "7/../../secrets.txt")


def test_rejects_sibling_prefix_root(tmp_path) -> None:
    """'/var/audio-evil' must NOT count as under '/var/audio' — the
    trailing-separator prefix check (uploadStore.assertUnderRoot)."""
    root = tmp_path / "audio"
    evil = tmp_path / "audio-evil"
    root.mkdir()
    evil.mkdir()
    (evil / "x.mp3").write_bytes(b"evil")
    with pytest.raises(BlobPathError, match="escapes storage root"):
        resolve_under_root(root, "../audio-evil/x.mp3")


def test_interior_dotdot_that_stays_inside_is_allowed(tmp_path) -> None:
    root = tmp_path / "audio"
    (root / "7").mkdir(parents=True)
    (root / "8").mkdir()
    (root / "8" / "t.mp3").write_bytes(b"ok")
    # Normalizes to 8/t.mp3 — inside the root, so legal (matches Node's
    # normalize-then-containment semantics).
    assert resolve_existing_blob(root, "7/../8/t.mp3") == root / "8" / "t.mp3"


def test_missing_file_raises_typed_blob_missing(tmp_path) -> None:
    root = tmp_path / "audio"
    root.mkdir()
    with pytest.raises(BlobMissing, match="audio blob missing"):
        resolve_existing_blob(root, "7/gone.mp3")
    # A directory at the path is "missing" too — the worker needs a FILE.
    (root / "7" / "dir.mp3").mkdir(parents=True)
    with pytest.raises(BlobMissing, match="audio blob missing"):
        resolve_existing_blob(root, "7/dir.mp3")
    # BlobMissing IS a FileNotFoundError (callers can catch either).
    assert issubclass(BlobMissing, FileNotFoundError)
