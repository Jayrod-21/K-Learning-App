"""The out-of-band Whisper worker loop (Track A, A-2a).

Drains ``audio_transcription_jobs`` (076) — the claim/settle/reap arc of
server/src/services/uploadExtract.ts, moved out of the request path into a
standalone process (Whisper runs minutes per file; no HTTP request can hold
that). Every step is a small, independently testable unit; ``run`` is just
the composition.

Execution arc per job (uploadExtract's tx shape, adapted):

  CLAIM tx  (claim_one)  — reap stale 'running' rows first, then
              SELECT ... WHERE status = 'pending' ORDER BY created_at, id
              FOR UPDATE SKIP LOCKED LIMIT 1  (076's partial pending index
              makes this an index walk; SKIP LOCKED lets N workers coexist),
              then a guarded UPDATE ... SET status = 'running',
              started_at = now() WHERE id = %s AND status = 'pending'.
              COMMITS BEFORE transcription — a tx can never be held open
              across minutes of GPU work (uploadExtract's ocr-outside/
              persist-inside split).
  WHISPER   (no tx)      — resolve the track's blob_ref under the storage
              root (traversal-checked, blobstore) and run the INJECTED
              transcribe_fn. Injection is the testability seam: tests pass a
              fake; ``run`` binds the real faster-whisper wrapper.
  PERSIST tx (process_job) — DELETE the track's existing segments (an
              idempotent re-run replaces, never collides with
              uq_audio_transcript_segments_track_number), INSERT the new
              ones, mark the track 'done' (+ duration), and settle the job
              with a GUARDED UPDATE ... WHERE id = %s AND status = 'running'
              RETURNING id. An empty RETURNING means a reaper settled the
              job mid-flight — the tx is ABORTED so no orphan segments land
              (uploadExtract's empty-RETURNING abort, verbatim).
  FAILURE   — any exception settles the job 'failed' via settle_failed (a
              STANDALONE statement outside any aborted tx, WHERE status =
              'running' so it never clobbers a settled row, errors swallowed
              — bookkeeping must not mask the real failure) and best-effort
              marks the track 'failed'. EXCEPTION: the settled-elsewhere
              abort settles NOTHING — the actor that settled the job owns
              the track's state (a re-run may have made it 'done'), so this
              worker only yields.

076's PINNED CONTRACTS honored here (see that migration's header):
  - REAP IS 'running'-ONLY, KEYED ON started_at. 'pending' is the HEALTHY
    BACKLOG — an old pending job just means the worker was down; reaping it
    would fail-fail the entire queue on restart instead of draining it.
    This is the ONE place NOT to copy 069's
    ``status IN ('pending','running')``.
  - ORPHANED-PENDING: a claimed job whose track_id IS NULL (track deleted
    before the worker reached it — fk SET NULL) is settled 'failed'
    immediately, WITHOUT invoking Whisper, so it leaves the pending index.
  - NO DAILY-CAP LOGIC. charged_bytes is an ENQUEUE-time concern (the A-3
    route sums it before inserting); the worker drains whatever was admitted.

SECURITY (standing rule — each threat, its defense):
  - PATH TRAVERSAL: blob paths come from the DB but are treated as untrusted
    (blobstore.resolve_under_root — absolute rejected, ``..`` normalized,
    trailing-separator containment check) before any filesystem access.
  - SQL INJECTION: every statement is parameterized; no value — including
    the DB-sourced blob_ref and error strings — is ever interpolated.
  - UNBOUNDED ERROR WRITES: error_summary never returns '' (076's error
    CHECK requires length 1..2000 — an empty write inside the swallowed
    settle would leave the job stuck 'running' forever) and is bounded to
    2000 chars, with a belt-and-braces left(%s, 2000) in the SQL.
"""

from __future__ import annotations

import logging
import signal
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import structlog
from psycopg import Connection
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .blobstore import resolve_existing_blob
from .config import WorkerConfig, config_from_env

logger = structlog.get_logger(__name__)

# The injectable transcription seam: real runs bind whisper_transcribe.
# transcribe to the config; tests pass a fake. Takes the RESOLVED absolute
# audio path, returns 075-shaped segment dicts.
TranscribeFn = Callable[[Path], list[dict]]

ORPHANED_TRACK_ERROR = "track deleted before transcription started"


@dataclass(frozen=True)
class Job:
    """A claimed queue row. psycopg returns BIGINT as Python int (unlike
    node-pg's strings), so ids are plain ints end-to-end — one consistent
    boundary type."""

    id: int
    track_id: int | None
    user_id: int


class JobSettledElsewhereError(RuntimeError):
    """The settle-'done' UPDATE returned no row: a reaper (or operator)
    settled this job mid-flight. Raised INSIDE the persist tx so the whole
    write rolls back — no orphan segments for a job the ledger says failed."""


def error_summary(exc: BaseException) -> str:
    """Bounded, never-empty failure summary for the job row's error column.

    NEVER returns '' — ``Exception('')`` (and some driver errors) stringify
    empty, which would violate ck_audio_transcription_jobs_error_length
    inside settle_failed's swallowed UPDATE and leave the job stuck
    'running' until the reaper (uploadExtract.errorSummary's guarantee)."""
    msg = str(exc).strip()
    if not msg:
        msg = f"unknown error ({type(exc).__name__})"
    return msg[:2000]


def reap_stale(conn: Connection, stale_minutes: int) -> int:
    """Settle 'failed' every 'running' job whose started_at is older than
    ``stale_minutes`` — and fail the tracks those jobs stranded. Returns the
    number of jobs reaped.

    'running'-ONLY, keyed on started_at (never NULL for a 'running' row —
    stamped by the claim UPDATE): a crashed worker's claim would otherwise
    409-brick its track's re-enqueue forever under the partial-UNIQUE live
    index. 'pending' rows are deliberately untouched — they are the healthy
    backlog, not a crash (076's pinned departure from 069's reaper).

    THE COMPANION TRACK UPDATE: the crashed worker also left its track's
    transcript_status (074 — what the Listen UI reads) at 'running', and the
    reaper is the ONLY actor that ever learns the crash happened — without
    this write the track would spin 'running' forever. The
    ``transcript_status = 'running'`` guard protects a track whose NEWER job
    already settled it ('done'/'failed' from a re-run must win); NULL
    track_ids (track deleted, fk SET NULL) are skipped. Running in the
    caller's claim transaction means both ledgers — job and track — settle
    atomically."""
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE audio_transcription_jobs
               SET status = 'failed'::audio_transcription_status,
                   error = 'stale run reaped: still running after ' || %s ||
                           ' minutes (worker died mid-job)',
                   finished_at = now()
             WHERE status = 'running'
               AND started_at < now() - make_interval(mins => %s)
             RETURNING track_id
            """,
            (stale_minutes, stale_minutes),
        )
        reaped = cur.fetchall()
        track_ids = [row[0] for row in reaped if row[0] is not None]
        if track_ids:
            cur.execute(
                """
                UPDATE audio_tracks
                   SET transcript_status = 'failed',
                       updated_at = now()
                 WHERE id = ANY(%s)
                   AND transcript_status = 'running'
                """,
                (track_ids,),
            )
        return len(reaped)


def claim_one(conn: Connection, stale_minutes: int) -> Job | None:
    """One claim poll: reap, then claim the oldest 'pending' job, in a
    single transaction. Returns the claimed Job, or None if the queue is
    empty. The transaction COMMITS here — transcription happens outside it.

    The SELECT rides ix_audio_transcription_jobs_pending (ORDER BY
    created_at, id = strict FIFO, id tiebreak for same-tick batch enqueues);
    FOR UPDATE SKIP LOCKED lets concurrent workers claim disjoint rows. The
    claim UPDATE re-checks status = 'pending' (uploadExtract's guarded-write
    discipline) so a row settled between statements can never be hijacked."""
    with conn.transaction():
        reaped = reap_stale(conn, stale_minutes)
        if reaped:
            logger.warning("reaped stale running jobs", count=reaped)
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, track_id, user_id
                  FROM audio_transcription_jobs
                 WHERE status = 'pending'
                 ORDER BY created_at, id
                   FOR UPDATE SKIP LOCKED
                 LIMIT 1
                """
            )
            row = cur.fetchone()
            if row is None:
                return None
            cur.execute(
                """
                UPDATE audio_transcription_jobs
                   SET status = 'running'::audio_transcription_status,
                       started_at = now()
                 WHERE id = %s AND status = 'pending'
                 RETURNING id, track_id, user_id
                """,
                (row[0],),
            )
            claimed = cur.fetchone()
            if claimed is None:
                # Unreachable while we hold the row lock; guarded anyway so a
                # future refactor that drops the lock fails safe (no claim).
                return None
            return Job(
                id=int(claimed[0]),
                track_id=int(claimed[1]) if claimed[1] is not None else None,
                user_id=int(claimed[2]),
            )


def settle_failed(pool: ConnectionPool, job_id: int, error: str) -> None:
    """Mark a claimed job 'failed' — best-effort, standalone statement.

    Runs on its OWN pooled connection, outside any aborted transaction. The
    ``status = 'running'`` guard makes it a no-op when the job already
    settled (reaper, operator). Errors are SWALLOWED (logged): settlement is
    bookkeeping; the caller is propagating/logging the real failure and must
    not have it masked. left(%s, 2000) backstops the error-length CHECK even
    if a caller bypasses error_summary."""
    try:
        with pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                """
                UPDATE audio_transcription_jobs
                   SET status = 'failed'::audio_transcription_status,
                       error = left(%s, 2000),
                       finished_at = now()
                 WHERE id = %s AND status = 'running'
                """,
                (error or "unknown error", job_id),
            )
    except Exception as exc:
        logger.warning(
            "settle_failed swallowed a settlement error",
            job_id=job_id,
            error=error_summary(exc),
        )


def _mark_track_failed(pool: ConnectionPool, track_id: int | None) -> None:
    """Best-effort: surface the failure on the track's own lifecycle column
    (074 — what the Listen UI reads). Swallows errors for the same reason
    settle_failed does; a NULL/deleted track is a no-op."""
    if track_id is None:
        return
    try:
        with pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE audio_tracks SET transcript_status = 'failed' WHERE id = %s",
                (track_id,),
            )
    except Exception as exc:
        logger.warning(
            "track failed-status write swallowed",
            track_id=track_id,
            error=error_summary(exc),
        )


def process_job(
    pool: ConnectionPool,
    job: Job,
    transcribe_fn: TranscribeFn,
    cfg: WorkerConfig,
) -> None:
    """Run one claimed job to settlement. Never raises on a per-job failure
    — the job is settled 'failed' and the loop lives on (a worker that dies
    on one bad file strands the whole backlog). Only BaseExceptions
    (KeyboardInterrupt/SystemExit) propagate."""
    log = logger.bind(job_id=job.id, track_id=job.track_id, user_id=job.user_id)

    # ORPHANED-PENDING (076's pinned contract): track deleted before the
    # worker reached the job — fk SET NULL kept the row 'pending' in the
    # index. Settle immediately; Whisper is never invoked.
    if job.track_id is None:
        settle_failed(pool, job.id, ORPHANED_TRACK_ERROR)
        log.info("orphaned pending job settled failed (no track)")
        return

    blob_ref: str | None = None
    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    "SELECT blob_ref, duration_ms FROM audio_tracks WHERE id = %s",
                    (job.track_id,),
                )
                track = cur.fetchone()
                if track is None:
                    # Deleted between claim and here; the job row was SET
                    # NULL'd concurrently. Same settlement as orphaned-pending.
                    settle_failed(pool, job.id, ORPHANED_TRACK_ERROR)
                    log.info("track vanished after claim — job settled failed")
                    return
                blob_ref = track["blob_ref"]
                # Track lifecycle (074): 'running' while Whisper is in
                # flight, so the Listen UI shows live progress. Committed
                # with the read on connection checkin.
                cur.execute(
                    "UPDATE audio_tracks SET transcript_status = 'running' "
                    "WHERE id = %s",
                    (job.track_id,),
                )

        # --- WHISPER (no tx open — this is minutes of GPU work) -----------
        # Traversal check + existence gate live in blobstore (one owner for
        # the 'audio blob missing' failure); BlobMissing/BlobPathError both
        # land in the settle-'failed' handler below.
        audio_path = resolve_existing_blob(cfg.audio_storage_dir, blob_ref)
        segments = transcribe_fn(audio_path)

        # --- PERSIST tx ---------------------------------------------------
        # duration_ms is informational (074): keep an existing probe value,
        # else the last segment's end is an honest lower bound. None when
        # Whisper heard nothing (silence-only file) — COALESCE keeps NULL.
        duration_ms = max((s["end_ms"] for s in segments), default=None)
        with pool.connection() as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    # Idempotent re-run: replace, never collide with
                    # uq_audio_transcript_segments_track_number.
                    cur.execute(
                        "DELETE FROM audio_transcript_segments WHERE track_id = %s",
                        (job.track_id,),
                    )
                    cur.executemany(
                        """
                        INSERT INTO audio_transcript_segments
                            (track_id, segment_number, start_ms, end_ms, body)
                        VALUES (%s, %s, %s, %s, %s)
                        """,
                        [
                            (
                                job.track_id,
                                s["segment_number"],
                                s["start_ms"],
                                s["end_ms"],
                                s["body"],
                            )
                            for s in segments
                        ],
                    )
                    cur.execute(
                        """
                        UPDATE audio_tracks
                           SET transcript_status = 'done',
                               duration_ms = COALESCE(duration_ms, %s)
                         WHERE id = %s
                        """,
                        (duration_ms, job.track_id),
                    )
                    cur.execute(
                        """
                        UPDATE audio_transcription_jobs
                           SET status = 'done'::audio_transcription_status,
                               finished_at = now()
                         WHERE id = %s AND status = 'running'
                         RETURNING id
                        """,
                        (job.id,),
                    )
                    if cur.fetchone() is None:
                        # A reaper settled this job mid-flight. Abort the
                        # WHOLE tx (raising inside conn.transaction() rolls
                        # back) so no segments land for a 'failed' job.
                        raise JobSettledElsewhereError(
                            f"job {job.id} was settled elsewhere mid-flight "
                            "(stale-reaped?) — persist aborted"
                        )
        log.info("job settled done", segments=len(segments), duration_ms=duration_ms)
    except JobSettledElsewhereError:
        # A reaper (or operator) settled this job while Whisper ran; the
        # persist tx above already rolled back. The settling ACTOR owns the
        # track's state now — a re-enqueued job may have already settled the
        # track 'done' with fresh segments, and _mark_track_failed here
        # would clobber that valid result. settle_failed would be a
        # guaranteed no-op too (the job is, by definition, no longer
        # 'running'). This worker settled NOTHING — it just yields.
        log.info("job was settled elsewhere; yielding track untouched")
    except Exception as exc:
        # ANY other failure (missing blob, whisper crash, persist rollback):
        # settle 'failed' with a bounded summary and surface it on the
        # track. The loop continues.
        summary = error_summary(exc)
        settle_failed(pool, job.id, summary)
        _mark_track_failed(pool, job.track_id)
        log.error("job settled failed", error=summary)


def drain_once(
    pool: ConnectionPool, transcribe_fn: TranscribeFn, cfg: WorkerConfig
) -> bool:
    """Claim and process at most one job. True if a job was claimed (even if
    it settled 'failed'), False when the queue was empty — the loop's
    sleep-or-not signal."""
    with pool.connection() as conn:
        job = claim_one(conn, cfg.stale_run_minutes)
    if job is None:
        return False
    process_job(pool, job, transcribe_fn, cfg)
    return True


def _build_transcribe_fn(cfg: WorkerConfig) -> TranscribeFn:
    """Bind the real faster-whisper wrapper to the config. Imported lazily so
    that everything above stays importable (and testable) engine-free."""
    from .whisper_transcribe import transcribe  # noqa: PLC0415 — lazy by design

    def fn(audio_path: Path) -> list[dict]:
        return transcribe(
            audio_path,
            model_size=cfg.whisper_model,
            device=cfg.whisper_device,
            compute_type=cfg.whisper_compute_type,
            language="ko",
        )

    return fn


def run_loop(
    pool: ConnectionPool,
    transcribe_fn: TranscribeFn,
    cfg: WorkerConfig,
    stop: threading.Event,
) -> None:
    """The drain loop proper, separated from ``run``'s signal wiring so
    tests can drive it with their own stop event and transcribe_fn.

    Per iteration: a fresh correlation id bound into structlog contextvars
    (cleared in ``finally`` so ids never bleed across jobs); a transient
    infrastructure error (DB hiccup — process_job itself never raises) is
    logged and backed off one poll interval, NOT fatal — a worker that dies
    on a blip strands the queue until an operator notices. Idle polls sleep
    on the stop event so shutdown is immediate when the queue is empty."""
    while not stop.is_set():
        correlation_id = uuid.uuid4().hex
        structlog.contextvars.bind_contextvars(correlation_id=correlation_id)
        try:
            worked = drain_once(pool, transcribe_fn, cfg)
        except Exception as exc:
            # process_job never raises — this is claim/pool infrastructure
            # (DB down, network). Back off one interval and retry.
            logger.error("drain iteration failed", error=error_summary(exc))
            worked = False
        finally:
            structlog.contextvars.clear_contextvars()
        if not worked:
            stop.wait(cfg.poll_interval_sec)


def run(pool: ConnectionPool, cfg: WorkerConfig) -> None:
    """The infinite drain loop with graceful shutdown.

    SIGTERM/SIGINT set a stop flag — the CURRENT job runs to settlement
    (killing mid-persist would just make work for the reaper), then the loop
    exits. NOTE: ``signal.signal`` may only be called from the MAIN thread —
    ``run`` must be invoked there (``main()`` is); ``run_loop`` itself has
    no such constraint."""
    stop = threading.Event()

    def _request_stop(signum: int, _frame: object) -> None:
        logger.info("shutdown requested", signal=signal.Signals(signum).name)
        stop.set()

    signal.signal(signal.SIGTERM, _request_stop)
    signal.signal(signal.SIGINT, _request_stop)

    transcribe_fn = _build_transcribe_fn(cfg)
    logger.info(
        "worker started",
        model=cfg.whisper_model,
        device=cfg.whisper_device,
        poll_interval_sec=cfg.poll_interval_sec,
        stale_run_minutes=cfg.stale_run_minutes,
    )
    run_loop(pool, transcribe_fn, cfg, stop)
    logger.info("worker stopped")


def configure_logging(level: str = "info") -> None:
    """Structured JSON logging — the same processor chain as
    tools/ingest/loaders/runtime.py (kept local: the worker must not import
    ingest's module tree just for logging). Safe to call twice."""
    log_level = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(level=log_level, format="%(message)s")
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(log_level),
        cache_logger_on_first_use=True,
    )


def main() -> None:
    """Entry point: ``python -m tools.audio_stt.worker``."""
    configure_logging()
    cfg = config_from_env()
    pool = ConnectionPool(
        cfg.database_url,
        min_size=1,
        max_size=2,
        kwargs={"application_name": cfg.application_name},
        open=False,
    )
    pool.open(wait=True, timeout=30)
    try:
        run(pool, cfg)
    finally:
        pool.close()


if __name__ == "__main__":
    main()
