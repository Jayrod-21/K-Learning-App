"""Operator corpus loader for Track A audio sets (A-4x — the bulk analog of
POST /audio).

Bulk-ingests a directory of local corpus audio (mp3/m4a) into the A-1 schema
so the already-running km-worker (tools/audio_stt/worker.py) drains and
transcribes it on the GPU. For each SET (one directory of files) it creates:

    1 audio_sources row            (kind='standalone_listening' by default,
                                    source_upload_id NULL — 073's kind<->link
                                    CHECK requires NULL for non-paired kinds)
    1 audio_tracks row per file    (track_number 1..N in sorted-filename
                                    order, blob_ref '{userId}/{uuid}.{ext}')
    1 audio_transcription_jobs row per track (status='pending',
                                    charged_bytes = the track's byte_size)

and copies each file into AUDIO_UPLOAD_STORAGE_DIR at its blob_ref. This is
routes/audio.ts's exact insert sequence (source -> blob -> track -> job),
operator-side: it bypasses HTTP, auth, and the per-user daily caps — the caps
are an ABUSE control on the upload surface, not a budget the operator's own
corpus ingest answers to (the jobs still land in the ledger via
charged_bytes, so nothing is hidden from it). Everything transcribes as a
standalone set; book<->audio pairing (kind='paired_reader', chapter
alignment) is deferred to A-5 by decision.

MODELING (locked decisions):
  * ONE audio_source per SET, upserted by (user_id, slug) —
    uq_audio_sources_user_slug, 073's stated loader contract ("the loader
    upserts a set by its stable slug").
  * ONE audio_track per FILE, keyed (source_id, track_number) —
    uq_audio_tracks_source_number, numbering the SORTED (deterministic)
    file list 1..N.
  * ONE live job per track — uq_audio_transcription_jobs_track_live (076's
    partial UNIQUE); the enqueue INSERT targets that partial index with
    ON CONFLICT ... DO NOTHING so a live job is never duplicated and never
    23505s.

TRANSACTION MODEL (short per-track transactions — never a long idle tx):
  * The source row is upserted in ONE short transaction of its own; then
    each track runs in its OWN short transaction: lock the source row
    (FOR UPDATE — the concurrency anchor), probe the track row FOR UPDATE
    (serializes against the worker's persist-tx track UPDATE, so a 'done'
    settle can never slip in between probe and enqueue), decide, copy the
    blob (still BEFORE its row), INSERT track + job, COMMIT. No transaction
    is ever idle across more than ONE file copy, so km-db's
    idle_in_transaction_session_timeout cannot abort a multi-GB set, and a
    concurrent POST /audio upsert on the same (user_id, slug) blocks for at
    most one track's copy — not the whole set.
  * REQUIRES an autocommit connection (asserted in load_set): on a
    non-autocommit connection psycopg nests each per-track "transaction" as
    a SAVEPOINT inside one implicit outer transaction — silently restoring
    exactly the long idle-in-transaction window this structure removes.

IDEMPOTENCY + RESUME SEMANTICS (re-running the same set is always safe):
  * Per-track COMMIT = durable progress: a crash resumes at the failed
    track; completed tracks no-op through on the next run. Only the FAILED
    track's transaction rolls back, and the blob written for that track (if
    any) is best-effort unlinked on the way out (routes/audio.ts's
    writtenBlobRef cleanup, per track) — a missed unlink leaves an orphan
    FILE, never a row pointing at nothing. Blobs re-copied (healed) to an
    EXISTING row's blob_ref are never unlinked: the committed row
    references them.
  * Re-run resume, per track (keyed on (source_id, track_number)):
      - row exists + blob FILE missing under the root -> the blob is HEALED
        (re-copied to the SAME blob_ref) REGARDLESS of transcript_status —
        a 'done' track's transcript is useless to Listen if the playback
        file is gone. Heal only writes when the file is absent.
      - row exists + transcript_status = 'done'      -> SKIP (its
        transcript is the expensive artifact; never re-enqueued).
      - row exists + not done + a LIVE job exists    -> leave it (the worker
        owns it; counted jobs_already_live).
      - row exists + not done + NO live job          -> (re)enqueue one
        pending job; a 'failed' track flips back to 'pending' so the Listen
        UI shows it queued again.
      - no row                                       -> new blob + track +
        job (the POST /audio sequence).
    Existing blob FILES are never re-copied (only healed when absent), done
    tracks are never re-transcribed, and the live-claim index is never
    violated.
  * DRIFT GUARDS (the F-185 mis-mapping bug class — the sorted file list
    changed under committed track numbers):
      - byte_size mismatch between the file now at track_number N and the
        committed row -> the SET IS REFUSED (fail-loud, ADR-019 §D10).
      - same size, different content -> a 64 KiB prefix-SHA256 of the
        source file is compared against the existing blob; a mismatch
        REFUSES the set (closes the same-size-swap hole, plausible for
        fixed-bitrate clips).
      - files removed from the END of the sorted list -> committed tracks
        beyond files_seen are never probed by the loop, so the guards above
        cannot fire; the loader logs a WARNING instead (the stale rows'
        pending jobs would otherwise burn Whisper silently). Not fatal: the
        committed transcripts may be deliberate keepers.
      RESIDUAL HOLES (documented, accepted): two same-size files identical
      in their first 64 KiB but differing later still swap silently; and a
      MISSING blob is healed from the current source file on a size match
      alone — the original blob is gone, so there is nothing to compare
      against.
  * CONCURRENCY: a double-invocation on the same set is safe — every
    per-track transaction takes the source row FOR UPDATE first, so two
    loaders serialize track-by-track and the loser sees the winner's
    committed rows (skip / already-live path, never a 23505). The running
    km-worker is never fought either: jobs become visible only after their
    blob is durable, and the FOR UPDATE track probe serializes against the
    worker's settle UPDATE.

--dry-run reports exactly what a real run would do — including the
DB-dependent skip/re-enqueue decisions — by executing the same plan inside
ONE transaction and raising psycopg.Rollback at the end: 0 rows committed,
0 blobs written (every filesystem write is gated off), real counts out.
(Dry-run's single transaction is exempt from the idle-tx concern precisely
because it never copies a file — it is pure, fast SQL.)

SECURITY (standing rule — each threat, its defense; mirrors
services/audioStore.ts + tools/audio_stt/blobstore.py):
  * PATH TRAVERSAL: blob_ref is built ONLY from server-trusted values — the
    operator-supplied numeric user id, a generated uuid4, and an extension
    from a two-entry whitelist keyed on the file's (case-insensitive)
    suffix. Defense in depth anyway: every write destination resolves
    through blobstore.resolve_under_root (absolute rejected, `..`
    normalized, trailing-separator containment), so even a poisoned
    blob_ref read back from the DB can never escape
    AUDIO_UPLOAD_STORAGE_DIR. Source filenames NEVER enter a filesystem
    path under the root — they only feed the (bounded) display title.
  * SQL INJECTION: every statement is parameterized; no filename, slug, or
    title is ever interpolated into SQL.
  * OWNERSHIP: user_id comes from the operator's --user flag, verified to
    exist up front (legible error instead of a deep 23503); the composite
    (source_id, user_id) -> audio_sources(id, user_id) FK (074) makes a
    drifted track owner structurally impossible regardless.
  * BOUNDED WRITES: slug/title lengths are pre-checked against the exact DB
    CHECK bounds (073: slug 1..200, title 1..500; 074: track title 1..500)
    so a malformed set fails with the offending name, not an opaque 23514.
  * ATOMIC-ISH BLOB WRITES: copy to a dot-tmp sibling then os.replace — a
    crash mid-copy leaves a tmp file (swept best-effort in-process, and
    stale ones are swept at startup), never a half-written blob at a
    committed blob_ref.
  * HIDDEN/APPLEDOUBLE FILES: discovery skips every path with a dot-leading
    component (.DS_Store, '._*' AppleDouble resource forks — which carry a
    valid .mp3 suffix and NON-zero size). They sort before real files
    ('.' < any digit), so admitting even one would shift every
    track_number — the exact drift class the guards above refuse sets over.

RUNBOOK (operator notes for the prod corpus run):
  * DAILY CAP LEDGER: every job's charged_bytes lands in the same ledger
    the POST /audio daily cap sums (AUDIO_TRANSCRIBE_DAILY_BYTES_CAP), so a
    ~1,000-file bulk load will consume the owning user's entire daily
    budget and 429 that user's OWN in-app uploads for the rest of the day.
    Expected and correct (nothing is hidden from the ledger) — schedule the
    bulk load with that in mind.
  * DRIFT-GUARD REMEDIATION IS DESTRUCTIVE: "delete the audio_sources row
    and re-load" CASCADEs the track/segment/job ROWS but ORPHANS the blob
    FILES on disk — nothing unlinks blobs for an operator SQL delete.
    Collect the set's blob_refs BEFORE deleting the row and unlink them
    under AUDIO_UPLOAD_STORAGE_DIR if the space matters.
  * audio_sources.status STAYS 'processing': nothing in the ecosystem flips
    it to 'ready' (the client rolls availability up from per-track
    transcript_status). The loader is deliberately consistent with that —
    do not "fix" it here alone.
  * CONCURRENT same-set double-invocation is safe (see CONCURRENCY above),
    and the running km-worker never needs stopping.
  * REAPER LOCK-ORDER (rare, self-healing): if a re-run aborts with a
    Postgres deadlock error, a stale-job reap collided with the loader on
    the exact same track (the reaper locks job-then-track, the loader
    locks track-then-job). Postgres's detector aborts one side in ~1s;
    both the loader (structured corpus_load_failed exit) and the worker
    (next poll) fully recover — just re-run the loader.
  * STALE .tmp-* SWEEP: real runs sweep '.tmp-*' files under the audio root
    that are older than an hour (a SIGKILL mid-copy leaves them behind);
    younger ones are left alone so a concurrent loader's in-flight copy is
    never yanked out from under its os.replace.

Usage (see Deploy/deployment-utils.sh `run_audio_corpus_loader` for the
containerized invocation):

    DATABASE_URL=... AUDIO_UPLOAD_STORAGE_DIR=... \\
    python -m tools.audio_stt.load_audio_corpus \\
        --set-dir /data --slug korean-folktales --title "Korean Folktales" \\
        --user 1 [--kind standalone_listening] [--dry-run] [--limit N]

    # or many sets at once:
    python -m tools.audio_stt.load_audio_corpus --manifest sets.json --user 1
    # sets.json: [{"set_dir": "...", "slug": "...", "title": "...",
    #              "kind": "standalone_listening"?}, ...]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import psycopg
import structlog
from psycopg.rows import tuple_row
from structlog.typing import FilteringBoundLogger

from .blobstore import BlobPathError, resolve_under_root
from .worker import configure_logging

logger = structlog.get_logger(__name__)

# Extension whitelist — the ONLY values that can ever reach a blob_ref. Keyed
# on the file's lowercased suffix; anything else is not audio for this
# pipeline and is skipped at discovery (audioUploadIngest.ts admits exactly
# these two kinds).
_AUDIO_EXTS: dict[str, str] = {".mp3": "mp3", ".m4a": "m4a"}

# Corpus sets are standalone by decision (book<->audio pairing is A-5);
# 'paired_reader' is deliberately NOT offered — it would also require a
# non-NULL source_upload_id this loader has no business inventing.
_ALLOWED_KINDS = ("standalone_listening", "topik")

# DB CHECK bounds pre-checked for legible errors (073/074).
_SLUG_MAX = 200
_TITLE_MAX = 500

# SF-6(a): how much of each file the same-size-swap guard fingerprints. A
# full-file hash would re-read the entire (multi-GB) corpus on every resume;
# 64 KiB catches header + early-frame differences for a fraction of the IO.
_PREFIX_CHECK_BYTES = 64 * 1024

# N-9: only .tmp-* files at least this old are swept at startup — a younger
# one may be a CONCURRENT loader's in-flight copy awaiting its os.replace.
_TMP_SWEEP_MIN_AGE_SECONDS = 60 * 60


class SetLoadError(RuntimeError):
    """A set cannot be loaded as-is (empty dir, bounds violation, or the
    re-numbering drift guard). Fail-loud (ADR-019 §D10): the message names
    the set and the offending file so the operator can fix the source."""


@dataclass(frozen=True)
class SetSpec:
    """One set to ingest: a directory + its stable slug/title/kind."""

    set_dir: Path
    slug: str
    title: str
    kind: str = "standalone_listening"


@dataclass
class SetReport:
    """What one set's load did (or, under --dry-run, would do)."""

    slug: str
    source_id: int | None = None
    files_seen: int = 0
    tracks_created: int = 0
    tracks_skipped_done: int = 0
    jobs_enqueued: int = 0
    jobs_already_live: int = 0
    blobs_written: int = 0
    blobs_recopied: int = 0
    bytes_enqueued: int = 0
    dry_run: bool = False

    def merged_into(self, total: SetReport) -> None:
        """Fold this set's counters into an aggregate report."""
        total.files_seen += self.files_seen
        total.tracks_created += self.tracks_created
        total.tracks_skipped_done += self.tracks_skipped_done
        total.jobs_enqueued += self.jobs_enqueued
        total.jobs_already_live += self.jobs_already_live
        total.blobs_written += self.blobs_written
        total.blobs_recopied += self.blobs_recopied
        total.bytes_enqueued += self.bytes_enqueued


# ---------------------------------------------------------------------------
# Discovery + title derivation (pure — unit-testable without FS/DB)
# ---------------------------------------------------------------------------


def _is_hidden(p: Path, set_dir: Path) -> bool:
    """SF-1: True when ANY component of the path relative to the set dir
    starts with '.' — dotfiles, '._*' AppleDouble resource forks (a
    valid-looking .mp3 suffix and ~4 KB of NON-zero metadata, so the suffix
    filter alone admits them), and anything under a dot-directory
    ('.Trashes/'). AppleDouble junk sorts BEFORE real files ('.' < any
    digit), so admitting even one would shift every track_number — the
    exact F-185 drift class the loader refuses sets over."""
    return any(part.startswith(".") for part in p.relative_to(set_dir).parts)


def discover_audio_files(set_dir: Path) -> list[Path]:
    """The set's audio files, recursively, in a DETERMINISTIC order.

    Sorted by posix-relative path so track numbering is stable across runs
    and hosts (load_ttmik_audio.scan_audio_tree's sorted-walk stance).
    Non-audio files (cover art, .DS_Store, playlists) and hidden/AppleDouble
    paths (any dot-leading component — see _is_hidden) are skipped
    silently — they are not errors, they are just not corpus audio. An
    empty result is an error: a mispointed --set-dir must fail loudly,
    never "load 0 tracks successfully".
    """
    if not set_dir.is_dir():
        raise SetLoadError(f"--set-dir {set_dir} is not a directory")
    files = sorted(
        (
            p
            for p in set_dir.rglob("*")
            if p.is_file()
            and p.suffix.lower() in _AUDIO_EXTS
            and not _is_hidden(p, set_dir)
        ),
        key=lambda p: p.relative_to(set_dir).as_posix(),
    )
    if not files:
        raise SetLoadError(
            f"no .mp3/.m4a files found under {set_dir} — is --set-dir pointed "
            "at the set's directory?"
        )
    return files


def clean_track_title(filename: str, track_number: int) -> str:
    """A readable display title from a corpus filename, bounded to 074's
    1..500 title CHECK.

    Strips the extension, then the leading 'NN. ' track-number noise and a
    leading 'Page X ' (or 'Page X-Y ') token the scanned-corpus naming
    convention prepends. A name that was ALL noise (e.g. '07.mp3') falls
    back to 'Track N' — a bare number is exactly the noise being removed,
    so re-surfacing the stem would defeat the cleaner. Never empty (074
    forbids '' — NULL is legal but a titled track is strictly better for
    the Listen list).
    """
    stem = Path(filename).stem.strip()
    # Leading track-number noise: '03. ', '12 - ', '7) ' ...
    cleaned = re.sub(r"^\s*\d{1,4}\s*[.)\-_–]*\s*", "", stem)
    # Leading 'Page 15 ' / 'page 3-4 - ' noise from the scanned-book sets.
    cleaned = re.sub(
        r"^(?:page)\s*\d+(?:\s*[-–~]\s*\d+)?\s*[.\-–]?\s*",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = " ".join(cleaned.split())
    if not cleaned:
        cleaned = f"Track {track_number}"
    return cleaned[:_TITLE_MAX]


def _validate_spec(spec: SetSpec) -> None:
    """Pre-check the DB CHECK bounds so a bad spec fails with a legible
    message instead of an opaque 23514 (load_literature's stance)."""
    if not (1 <= len(spec.slug) <= _SLUG_MAX):
        raise SetLoadError(
            f"slug {spec.slug!r}: length {len(spec.slug)} outside 1..{_SLUG_MAX} "
            "(ck_audio_sources_slug_length)"
        )
    if not (1 <= len(spec.title) <= _TITLE_MAX):
        raise SetLoadError(
            f"set {spec.slug}: title length {len(spec.title)} outside "
            f"1..{_TITLE_MAX} (ck_audio_sources_title_length)"
        )
    if spec.kind not in _ALLOWED_KINDS:
        raise SetLoadError(
            f"set {spec.slug}: kind {spec.kind!r} not in {_ALLOWED_KINDS} — "
            "paired_reader sets are A-5's job, not this loader's"
        )


# ---------------------------------------------------------------------------
# Blob writes (traversal-safe, atomic-ish)
# ---------------------------------------------------------------------------


def write_blob(audio_root: Path, rel_path: str, src: Path) -> Path:
    """Copy ``src`` into the storage root at ``rel_path`` — resolve through
    blobstore.resolve_under_root first (defense in depth: rel_path is built
    from trusted values, but no path may reach the filesystem un-vetted),
    then copy to a dot-tmp sibling and os.replace into place so a crash
    mid-copy never leaves a half-written file at a committed blob_ref.

    Raises BlobPathError (from resolve_under_root) on any escaping path.
    """
    dest = resolve_under_root(audio_root, rel_path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.parent / f".tmp-{uuid.uuid4().hex}"
    try:
        shutil.copyfile(src, tmp)
        os.replace(tmp, dest)
    finally:
        # Sweep the tmp on any failure path; ENOENT after a successful
        # replace is the normal case.
        tmp.unlink(missing_ok=True)
    return dest


def _prefix_sha256(path: Path, limit: int = _PREFIX_CHECK_BYTES) -> str:
    """SHA-256 of the file's first ``limit`` bytes — the SF-6(a) same-size
    swap guard's content fingerprint (see _PREFIX_CHECK_BYTES for why not
    the whole file)."""
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        digest.update(fh.read(limit))
    return digest.hexdigest()


def _sweep_stale_tmp(audio_root: Path, log: FilteringBoundLogger) -> None:
    """N-9: a SIGKILL mid-copy strands a '.tmp-*' file forever (write_blob's
    finally-sweep only covers in-process failures). Sweep them at startup —
    but ONLY those older than _TMP_SWEEP_MIN_AGE_SECONDS, so a CONCURRENT
    loader's in-flight copy is never deleted out from under its os.replace.
    Best-effort throughout: a failed scan or unlink is logged, never fatal.
    """
    now = time.time()
    swept = 0
    try:
        candidates = [p for p in audio_root.rglob(".tmp-*") if p.is_file()]
    except OSError as err:
        log.warning("stale_tmp_sweep_scan_failed", error=str(err)[:500])
        return
    for tmp in candidates:
        try:
            if now - tmp.stat().st_mtime < _TMP_SWEEP_MIN_AGE_SECONDS:
                continue
            tmp.unlink(missing_ok=True)
            swept += 1
        except OSError as err:
            log.warning(
                "stale_tmp_sweep_unlink_failed",
                tmp_path=str(tmp),
                error=str(err)[:500],
            )
    if swept:
        log.info("stale_tmp_files_swept", count=swept)


# ---------------------------------------------------------------------------
# The per-set load (one short tx for the source, then one short tx per track)
# ---------------------------------------------------------------------------


def _resolve_user(conn: psycopg.Connection, user_id: int) -> None:
    """Assert the target user exists — a legible operator error instead of a
    23503 deep in the insert sequence (load_literature._resolve_owner's
    fail-loud posture; the FKs remain the structural guarantee)."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute("SELECT 1 FROM users WHERE id = %s", (user_id,))
        if cur.fetchone() is None:
            raise SetLoadError(
                f"user {user_id} does not exist — --user must be the id of a "
                "real users row (the sets' owner)"
            )


def _upsert_source(
    conn: psycopg.Connection, *, user_id: int, spec: SetSpec
) -> int:
    """Upsert the set row by (user_id, slug) — 073's stated loader contract —
    and return its id. kind/status/source_upload_id are loader constants
    (source_upload_id NULL satisfies the kind<->link CHECK for both allowed
    kinds); a conflicting UPDATE onto a paired_reader row would trip that
    CHECK and fail loudly, which is correct — this loader must never
    silently un-pair a book.

    N-8: the DO UPDATE is gated on a REAL change (title/kind differ) so a
    no-op resume does not bump version or fire the updated_at trigger —
    audit fields stay honest across idempotent re-runs. A suppressed update
    returns no row from RETURNING, hence the fallback SELECT for the id."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO audio_sources
                (user_id, slug, title, kind, source_upload_id, status)
            VALUES (%s, %s, %s, %s, NULL, 'processing')
            ON CONFLICT (user_id, slug) DO UPDATE
               SET title   = EXCLUDED.title,
                   kind    = EXCLUDED.kind,
                   version = audio_sources.version + 1
             WHERE (audio_sources.title, audio_sources.kind)
                   IS DISTINCT FROM (EXCLUDED.title, EXCLUDED.kind)
            RETURNING id
            """,
            (user_id, spec.slug, spec.title, spec.kind),
        )
        row = cur.fetchone()
        if row is None:
            # Conflicted but nothing changed — the WHERE suppressed the
            # no-op UPDATE (and its RETURNING row). Fetch the id directly.
            cur.execute(
                "SELECT id FROM audio_sources WHERE user_id = %s AND slug = %s",
                (user_id, spec.slug),
            )
            row = cur.fetchone()
            if row is None:
                raise SetLoadError(
                    f"set {spec.slug}: audio_sources row vanished during the "
                    "upsert (concurrent delete?) — re-run the loader"
                )
        return int(row[0])


def _lock_source_row(
    conn: psycopg.Connection, source_id: int, slug: str
) -> None:
    """The per-track serialization anchor (the SF-2/SF-3 restructure): take
    the source row lock for THIS track's short transaction only. Two loaders
    on the same set — or POST /audio's upsert on the same (user_id, slug) —
    serialize track-by-track instead of blocking for a whole set. Doubles as
    a liveness check: the row vanishing mid-run (operator delete) fails
    legibly here instead of as a 23503 deep in the insert sequence."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT 1 FROM audio_sources WHERE id = %s FOR UPDATE",
            (source_id,),
        )
        if cur.fetchone() is None:
            raise SetLoadError(
                f"set {slug}: audio_sources row {source_id} disappeared "
                "mid-run (concurrent delete?) — re-run the loader"
            )


def _warn_trailing_removal(
    conn: psycopg.Connection,
    *,
    source_id: int,
    files_seen: int,
    limit: int | None,
    log: FilteringBoundLogger,
) -> None:
    """SF-6(b): files removed from the END of the sorted list never collide
    with a committed row (the loop just stops early), so the byte-size and
    prefix-hash guards cannot fire — committed tracks N..M would sit
    silently with pending jobs burning Whisper on stale blobs. Surface it
    as a WARNING, not an error: the committed rows/transcripts may be
    deliberate keepers. Suppressed under --limit, which legitimately
    truncates the list."""
    if limit is not None:
        return
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT max(track_number) FROM audio_tracks WHERE source_id = %s",
            (source_id,),
        )
        row = cur.fetchone()
    max_committed = row[0] if row is not None else None
    if max_committed is not None and int(max_committed) > files_seen:
        log.warning(
            "trailing_tracks_missing_from_directory",
            committed_max_track_number=int(max_committed),
            files_seen=files_seen,
            note=(
                "committed tracks beyond files_seen have no file in the set "
                "directory — files were removed from the end of the sorted "
                "list since the set was loaded; their rows/jobs are untouched"
            ),
        )


def load_set(
    conn: psycopg.Connection,
    *,
    spec: SetSpec,
    user_id: int,
    audio_root: Path,
    dry_run: bool = False,
    limit: int | None = None,
) -> SetReport:
    """Load one set — a short source-upsert transaction, then ONE SHORT
    TRANSACTION PER TRACK (module docstring TRANSACTION MODEL): no long
    idle-in-transaction window, durable per-track resume progress, and the
    FOR UPDATE track probe closes the worker done-settle race. Requires an
    autocommit connection (asserted — anything else silently turns the
    per-track transactions into savepoints inside one implicit outer
    transaction). Under dry_run the same plan executes inside a single
    transaction rolled back via psycopg.Rollback: real counts, zero rows,
    zero blobs.
    """
    if not conn.autocommit:
        raise SetLoadError(
            "load_set requires an autocommit connection: without it psycopg "
            "nests each per-track conn.transaction() as a SAVEPOINT inside "
            "one implicit outer transaction — silently recreating the long "
            "idle-in-transaction window (and all-or-nothing rollback) this "
            "loader is structured to avoid"
        )
    log = logger.bind(slug=spec.slug, set_dir=str(spec.set_dir), user_id=user_id)
    _validate_spec(spec)
    files = discover_audio_files(spec.set_dir)
    if limit is not None:
        files = files[:limit]
    report = SetReport(slug=spec.slug, files_seen=len(files), dry_run=dry_run)
    log.info("set_load_start", files=len(files), dry_run=dry_run)

    if dry_run:
        # The whole dry-run plan in ONE transaction, rolled back at the end:
        # every DB-dependent decision above is real, nothing survives. The
        # long-idle-tx concern does not apply — dry-run never copies a file
        # (every filesystem write is dry_run-gated), so this transaction is
        # pure, fast SQL.
        with conn.transaction():
            _resolve_user(conn, user_id)
            source_id = _upsert_source(conn, user_id=user_id, spec=spec)
            report.source_id = source_id
            _warn_trailing_removal(
                conn,
                source_id=source_id,
                files_seen=len(files),
                limit=limit,
                log=log,
            )
            for track_number, src in enumerate(files, start=1):
                _load_track(
                    conn,
                    report=report,
                    log=log,
                    source_id=source_id,
                    user_id=user_id,
                    track_number=track_number,
                    src=src,
                    audio_root=audio_root,
                    dry_run=True,
                    new_blob_paths=[],
                )
            # Exit WITHOUT committing — conn.transaction() consumes
            # psycopg.Rollback and rolls back silently; control continues
            # after the `with`.
            raise psycopg.Rollback
        log.info("set_load_complete", **_report_fields(report))
        return report

    _sweep_stale_tmp(audio_root, log)

    # Short tx 1: the set row. Its lock RELEASES at commit — each per-track
    # transaction re-takes it (_lock_source_row), so no lock ever spans more
    # than its own track's copy.
    with conn.transaction():
        _resolve_user(conn, user_id)
        source_id = _upsert_source(conn, user_id=user_id, spec=spec)
    report.source_id = source_id
    _warn_trailing_removal(
        conn, source_id=source_id, files_seen=len(files), limit=limit, log=log
    )

    for track_number, src in enumerate(files, start=1):
        # Blob(s) written for THIS track's not-yet-committed row — unlinked
        # best-effort if its transaction fails (routes/audio.ts's
        # writtenBlobRef cleanup, per track). Heals of an EXISTING row's
        # blob_ref are excluded: that row is committed and references the
        # path, so the file must stay.
        track_blob_paths: list[Path] = []
        try:
            with conn.transaction():
                _lock_source_row(conn, source_id, spec.slug)
                _load_track(
                    conn,
                    report=report,
                    log=log,
                    source_id=source_id,
                    user_id=user_id,
                    track_number=track_number,
                    src=src,
                    audio_root=audio_root,
                    dry_run=False,
                    new_blob_paths=track_blob_paths,
                )
        except BaseException:
            # THIS track's transaction rolled back; every earlier track's
            # commit is durable (resume re-enters at this track on the next
            # run). Unlink only the blob(s) this track wrote for rows that
            # no longer exist.
            for path in track_blob_paths:
                try:
                    path.unlink(missing_ok=True)
                except OSError as unlink_err:
                    # Best-effort only: an orphan FILE is harmless (no
                    # committed row references it) and must never mask the
                    # real failure.
                    log.warning(
                        "orphan blob cleanup failed",
                        blob_path=str(path),
                        error=str(unlink_err)[:500],
                    )
            raise

    log.info("set_load_complete", **_report_fields(report))
    return report


def _load_track(
    conn: psycopg.Connection,
    *,
    report: SetReport,
    log: FilteringBoundLogger,
    source_id: int,
    user_id: int,
    track_number: int,
    src: Path,
    audio_root: Path,
    dry_run: bool,
    new_blob_paths: list[Path],
) -> None:
    """One file's resume-aware create/skip/heal/re-enqueue step (module
    docstring RESUME SEMANTICS, verbatim). Runs inside the caller's
    transaction; the existing-row probe takes FOR UPDATE, serializing
    against the worker's settle UPDATE so a 'done' flip can never slip in
    between the probe and the enqueue (SF-3)."""
    byte_size = src.stat().st_size
    if byte_size <= 0:
        raise SetLoadError(
            f"set {report.slug}: {src.name} is 0 bytes — not a valid audio "
            "file (ck_audio_tracks_byte_size_positive)"
        )
    tlog = log.bind(track_number=track_number, file=src.name)

    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT id, transcript_status, blob_ref, byte_size
              FROM audio_tracks
             WHERE source_id = %s AND track_number = %s
               FOR UPDATE
            """,
            (source_id, track_number),
        )
        existing = cur.fetchone()

        if existing is not None:
            track_id, transcript_status, blob_ref, existing_bytes = existing
            if int(existing_bytes) != byte_size:
                # The re-numbering drift guard (module docstring): the sorted
                # file list changed since this row committed. Enqueueing this
                # file under that row would silently mis-map audio (the F-185
                # bug class) — refuse the whole set instead.
                raise SetLoadError(
                    f"set {report.slug} track {track_number} ({src.name}): "
                    f"on-disk size {byte_size} != committed byte_size "
                    f"{existing_bytes} — the set's file list has changed "
                    "since it was loaded (added/removed files shift every "
                    "later track_number). Fix the directory to match, or "
                    "delete the audio_sources row and re-load fresh (see "
                    "RUNBOOK — that orphans the blob files on disk)."
                )
            dest = resolve_under_root(audio_root, str(blob_ref))
            if dest.is_file():
                # SF-6(a) same-size swap guard: byte_size alone cannot tell
                # two same-size files apart (plausible for fixed-bitrate
                # clips) — compare a prefix hash of the source against the
                # existing blob. Residual hole (module docstring): identical
                # prefixes with differing tails still pass.
                if _prefix_sha256(src) != _prefix_sha256(dest):
                    raise SetLoadError(
                        f"set {report.slug} track {track_number} ({src.name}): "
                        f"same byte_size but the first {_PREFIX_CHECK_BYTES} "
                        "bytes differ from the committed blob — the sorted "
                        "file list changed shape (same-size swap). Fix the "
                        "directory to match, or delete the audio_sources row "
                        "and re-load fresh (see RUNBOOK — that orphans the "
                        "blob files on disk)."
                    )
            else:
                # SF-4: heal the missing blob FILE (lost commit-ack, partial
                # restore, operator deletion) at the SAME blob_ref —
                # REGARDLESS of transcript_status: a done track's transcript
                # is useless to Listen if the playback file is gone. Heal
                # only writes when the file is absent, and healed refs are
                # deliberately NOT in new_blob_paths (the committed row
                # references them).
                if dry_run:
                    report.blobs_recopied += 1
                else:
                    write_blob(audio_root, str(blob_ref), src)
                    report.blobs_recopied += 1
                    tlog.warning("blob was missing under root — re-copied")
            if transcript_status == "done":
                report.tracks_skipped_done += 1
                tlog.info("track skipped — already transcribed")
                return
            _ensure_job(
                cur,
                report=report,
                tlog=tlog,
                track_id=int(track_id),
                user_id=user_id,
                charged_bytes=byte_size,
            )
            return

        # New track: blob (write BEFORE its row — a failure can only orphan a
        # file, never commit a row pointing at missing bytes; audio.ts's
        # ordering), then the track row, then its job.
        ext = _AUDIO_EXTS[src.suffix.lower()]
        blob_ref = f"{user_id}/{uuid.uuid4()}.{ext}"
        if not dry_run:
            new_blob_paths.append(write_blob(audio_root, blob_ref, src))
        report.blobs_written += 1
        title = clean_track_title(src.name, track_number)
        cur.execute(
            """
            INSERT INTO audio_tracks
                (source_id, user_id, track_number, title, blob_ref,
                 byte_size, transcript_status)
            VALUES (%s, %s, %s, %s, %s, %s, 'pending')
            RETURNING id
            """,
            (source_id, user_id, track_number, title, blob_ref, byte_size),
        )
        row = cur.fetchone()
        assert row is not None, "INSERT ... RETURNING must return a row"
        report.tracks_created += 1
        _ensure_job(
            cur,
            report=report,
            tlog=tlog,
            track_id=int(row[0]),
            user_id=user_id,
            charged_bytes=byte_size,
        )


def _ensure_job(
    cur: psycopg.Cursor,
    *,
    report: SetReport,
    tlog: FilteringBoundLogger,
    track_id: int,
    user_id: int,
    charged_bytes: int,
) -> None:
    """Ensure exactly ONE live job for the track. The conflict target names
    uq_audio_transcription_jobs_track_live's partial-index predicate, so a
    concurrent (or leftover) pending/running job makes this a no-op instead
    of a 23505 — the loader can never double-enqueue and never crash on the
    live-claim. charged_bytes snapshots the track's byte_size (076's
    enqueue-time contract), keeping the cost ledger honest even for operator
    ingests."""
    cur.execute(
        """
        INSERT INTO audio_transcription_jobs
            (track_id, user_id, status, charged_bytes)
        VALUES (%s, %s, 'pending', %s)
        ON CONFLICT (track_id) WHERE status IN ('pending', 'running')
        DO NOTHING
        RETURNING id
        """,
        (track_id, user_id, charged_bytes),
    )
    if cur.fetchone() is None:
        report.jobs_already_live += 1
        tlog.info("track already has a live job — left to the worker")
        return
    report.jobs_enqueued += 1
    report.bytes_enqueued += charged_bytes
    # A previously-failed track just got a fresh job: surface 'pending' on
    # the Listen UI's per-track lifecycle. Status-guarded so a 'running'
    # track (stranded label, or claimed mid-statement) is never clobbered —
    # the worker owns those transitions.
    cur.execute(
        """
        UPDATE audio_tracks
           SET transcript_status = 'pending'
         WHERE id = %s AND transcript_status = 'failed'
        """,
        (track_id,),
    )
    tlog.info("job enqueued", charged_bytes=charged_bytes)


def _report_fields(report: SetReport) -> dict:
    return {
        "source_id": report.source_id,
        "files_seen": report.files_seen,
        "tracks_created": report.tracks_created,
        "tracks_skipped_done": report.tracks_skipped_done,
        "jobs_enqueued": report.jobs_enqueued,
        "jobs_already_live": report.jobs_already_live,
        "blobs_written": report.blobs_written,
        "blobs_recopied": report.blobs_recopied,
        "bytes_enqueued": report.bytes_enqueued,
        "dry_run": report.dry_run,
    }


# ---------------------------------------------------------------------------
# Manifest parsing (the thin many-sets loop)
# ---------------------------------------------------------------------------

_MANIFEST_KEYS = {"set_dir", "slug", "title", "kind"}


def parse_manifest(
    path: Path, default_kind: str = "standalone_listening"
) -> list[SetSpec]:
    """Parse a JSON manifest: [{set_dir, slug, title, kind?}, ...]. Unknown
    keys are REJECTED (never ignored — a typo'd key silently dropping a
    field is the mass-assignment bug class inverted) and slugs must be
    unique within the file. Entries without a kind get ``default_kind``
    (the CLI's --kind)."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        raise SetLoadError(f"manifest {path}: {err}") from err
    if not isinstance(raw, list) or not raw:
        raise SetLoadError(f"manifest {path}: expected a non-empty JSON array")
    specs: list[SetSpec] = []
    seen_slugs: set[str] = set()
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise SetLoadError(f"manifest {path} entry {i}: expected an object")
        unknown = set(entry) - _MANIFEST_KEYS
        if unknown:
            raise SetLoadError(
                f"manifest {path} entry {i}: unknown keys {sorted(unknown)} "
                f"(allowed: {sorted(_MANIFEST_KEYS)})"
            )
        missing = {"set_dir", "slug", "title"} - set(entry)
        if missing:
            raise SetLoadError(
                f"manifest {path} entry {i}: missing keys {sorted(missing)}"
            )
        slug = str(entry["slug"])
        if slug in seen_slugs:
            raise SetLoadError(f"manifest {path}: duplicate slug {slug!r}")
        seen_slugs.add(slug)
        specs.append(
            SetSpec(
                set_dir=Path(str(entry["set_dir"])),
                slug=slug,
                title=str(entry["title"]),
                kind=str(entry.get("kind", default_kind)),
            )
        )
    return specs


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=(
            "Bulk-ingest local corpus audio sets into the Track A pipeline "
            "(audio_sources + audio_tracks + audio_transcription_jobs + "
            "blobs under AUDIO_UPLOAD_STORAGE_DIR). The running km-worker "
            "drains the enqueued jobs. Idempotent + resumable per set."
        )
    )
    target = p.add_mutually_exclusive_group(required=True)
    target.add_argument("--set-dir", type=Path, help="Directory of one audio set.")
    target.add_argument(
        "--manifest",
        type=Path,
        help="JSON array of sets: [{set_dir, slug, title, kind?}, ...].",
    )
    p.add_argument("--slug", help="Stable set slug (required with --set-dir).")
    p.add_argument("--title", help="Set display title (required with --set-dir).")
    p.add_argument(
        "--user", type=int, required=True, help="Owning users.id for every set."
    )
    p.add_argument(
        "--kind",
        choices=_ALLOWED_KINDS,
        default="standalone_listening",
        help="audio_sources.kind (default: standalone_listening).",
    )
    p.add_argument(
        "--audio-root",
        type=Path,
        default=None,
        help=(
            "Blob storage root (default: $AUDIO_UPLOAD_STORAGE_DIR). Must "
            "already exist for a real run — a typo'd root must never be "
            "silently created and filled."
        ),
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Plan against the real DB state, write nothing (rows or blobs).",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Process at most N files per set (smoke runs; numbering stays "
        "1..N, consistent with a later full run).",
    )
    p.add_argument(
        "--log-level", default="info", choices=("debug", "info", "warning", "error")
    )
    args = p.parse_args(argv)
    if args.set_dir is not None and (args.slug is None or args.title is None):
        p.error("--set-dir requires --slug and --title")
    if args.user <= 0:
        p.error("--user must be a positive users.id")
    if args.limit is not None and args.limit <= 0:
        p.error("--limit must be positive")
    return args


def _resolve_audio_root(args: argparse.Namespace) -> Path:
    """--audio-root flag, else $AUDIO_UPLOAD_STORAGE_DIR — fail-fast with the
    config.py-style actionable message when neither is set. For a real run
    the root must already EXIST (unlike the server's lazy-create: an
    operator typo here would silently build a parallel tree no one serves)."""
    root = args.audio_root or (
        Path(os.environ["AUDIO_UPLOAD_STORAGE_DIR"])
        if os.environ.get("AUDIO_UPLOAD_STORAGE_DIR")
        else None
    )
    if root is None:
        raise SystemExit(
            "AUDIO_UPLOAD_STORAGE_DIR is required (the root blob_refs resolve "
            "under) — set the env var or pass --audio-root"
        )
    if not args.dry_run and not root.is_dir():
        raise SystemExit(
            f"audio root {root} does not exist — mount/create it first (a "
            "mistyped root must not be silently created and filled)"
        )
    return root


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    configure_logging(args.log_level)

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit(
            "DATABASE_URL is required (postgres://user:pass@host:5432/db)"
        )
    audio_root = _resolve_audio_root(args)

    if args.manifest is not None:
        try:
            specs = parse_manifest(args.manifest, default_kind=args.kind)
        except SetLoadError as err:
            logger.error("manifest_invalid", error=str(err)[:2000])
            return 1
    else:
        specs = [SetSpec(args.set_dir, args.slug, args.title, args.kind)]

    total = SetReport(slug="(all sets)", dry_run=args.dry_run)
    sets_loaded = 0
    try:
        # autocommit=True is REQUIRED by load_set's per-track transaction
        # model (asserted there): each conn.transaction() must be a real
        # transaction, never a savepoint inside an implicit outer one.
        with psycopg.connect(
            database_url,
            application_name="korean-master-audio-corpus-loader",
            autocommit=True,
        ) as conn:
            for spec in specs:
                # Committed work survives a later failure — the manifest run
                # is resumable at set AND track granularity (fix the bad
                # set, re-run the manifest; loaded sets/tracks no-op through
                # the idempotent path).
                report = load_set(
                    conn,
                    spec=spec,
                    user_id=args.user,
                    audio_root=audio_root,
                    dry_run=args.dry_run,
                    limit=args.limit,
                )
                report.merged_into(total)
                sets_loaded += 1
    except (SetLoadError, BlobPathError, psycopg.Error, OSError) as err:
        # BlobPathError is in the tuple deliberately (N-6): a poisoned
        # blob_ref surfacing on the heal path must exit via this structured
        # log, not a raw traceback.
        logger.error(
            "corpus_load_failed",
            error=str(err)[:2000],
            sets_completed=sets_loaded,
            sets_total=len(specs),
        )
        return 1

    logger.info(
        "corpus_load_complete",
        sets=sets_loaded,
        **_report_fields(total),
        note=(
            "dry run — nothing written"
            if args.dry_run
            else "the running km-worker will drain the enqueued jobs"
        ),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
