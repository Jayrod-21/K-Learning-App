"""Traversal-safe audio-blob resolution — Python port of
server/src/services/uploadStore.ts (resolveUnderRoot / assertUnderRoot).

``audio_tracks.blob_ref`` (074) is a server/loader-written RELATIVE path
under AUDIO_UPLOAD_STORAGE_DIR (``{userId}/{uuid}.{mp3|m4a}``) — never a
client string. This module treats it as untrusted anyway on the way back IN
(uploadStore's exact reasoning: a compromised/corrupt row, or a future code
path that lets a client influence it, must not be able to escape the root):

  - reject absolute paths outright;
  - join to the resolved root, normalize (collapses ``..`` LEXICALLY —
    deliberately no symlink resolution, matching Node's path.resolve/
    normalize semantics the original defense was written against);
  - assert the result is the root itself or strictly inside it via a
    TRAILING-SEPARATOR prefix check, so ``/var/audio-evil`` is NOT treated
    as under ``/var/audio``.

Failure taxonomy is typed so the worker can settle a job with the right
error: ``BlobPathError`` = a poisoned/escaping path — the worker's
catch-all settles it into a FAILED JOB with the error preserved (correct:
the row is bad and the failure is recorded, never silently ignored);
``BlobMissing`` = the file is genuinely gone (a settle-'failed' condition,
not a crash).
"""

from __future__ import annotations

import os
from pathlib import Path


class BlobPathError(ValueError):
    """The stored blob path is absolute or escapes the storage root."""


class BlobMissing(FileNotFoundError):
    """The blob path is well-formed but the file does not exist."""


def resolve_under_root(root: Path | str, rel_path: str) -> Path:
    """Resolve the RELATIVE path stored in the DB to an absolute,
    traversal-checked path under ``root``.

    Raises:
        BlobPathError: if ``rel_path`` is absolute or resolves outside the
            storage root.
    """
    if os.path.isabs(rel_path):
        raise BlobPathError("blob path must be relative")
    root_abs = os.path.abspath(os.fspath(root))
    abs_path = os.path.normpath(os.path.join(root_abs, rel_path))
    # Trailing-separator prefix check: '/var/audio-evil' must not pass as
    # under '/var/audio' (uploadStore.assertUnderRoot, verbatim reasoning).
    root_with_sep = root_abs if root_abs.endswith(os.sep) else root_abs + os.sep
    if abs_path != root_abs and not abs_path.startswith(root_with_sep):
        raise BlobPathError("blob path escapes storage root (path traversal blocked)")
    return Path(abs_path)


def resolve_existing_blob(root: Path | str, rel_path: str) -> Path:
    """Resolve the RELATIVE path stored in the DB and require an existing
    regular file — the worker's pre-Whisper existence gate.

    (Replaces an earlier ``read_blob``: the worker never needs the bytes in
    memory — faster-whisper takes a path — so this checks existence instead
    of reading, and owns the 'audio blob missing' message in ONE place.)

    Raises:
        BlobPathError: traversal/absolute path (see resolve_under_root).
        BlobMissing: the resolved path is not an existing regular file —
            the caller maps this to a settled-'failed' job, not a crash.
    """
    abs_path = resolve_under_root(root, rel_path)
    if not abs_path.is_file():
        raise BlobMissing(f"audio blob missing: {rel_path}")
    return abs_path
