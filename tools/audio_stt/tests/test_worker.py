"""Worker-loop tests against a real migrated Postgres (faster-whisper NEVER
imported — every test injects a fake transcribe function).

Coverage (each maps to a 076-contract or a bug class the worker defends
against — modeled on uploadExtract.test.ts's checklist):
  - REAP IS 'running'-ONLY: a stale 'running' job is reaped 'failed'; a
    stale 'pending' job (old created_at, NULL started_at) is NOT reaped and
    IS subsequently claimed + processed — the key 076 regression pin (the
    one place NOT to copy 069's IN ('pending','running')).
  - happy path: pending job → drain_once → job 'done', ordered segments in
    075, track transcript_status 'done', duration_ms set from the last
    segment (and an existing probe value preserved).
  - orphaned-pending: track_id NULL → settled 'failed' immediately,
    transcribe_fn NEVER called.
  - missing blob → 'failed' with a clear error; transcribe_fn never called.
  - transcribe raises → job 'failed', ZERO segments persisted (persist-tx
    atomicity), track 'failed'.
  - idempotent re-run: pre-existing segments are DELETEd before the new
    INSERT (no UNIQUE violation; final set is exactly the new one).
  - claim guard: FIFO order (created_at, id); a 'running' job is never
    re-claimed; a fresh 'running' job is not reaped; empty-queue drain
    returns False.
  - mid-flight reap: a job settled elsewhere during transcription aborts
    the persist tx (empty RETURNING) — no orphan segments.
  - settle_failed: status-guarded (never clobbers a settled job).
  - error_summary: never '' and bounded to 2000.
  - reap fails a stranded-'running' TRACK too, but never a settled one
    (W-SF1); a settled-elsewhere job yields the track — a newer job's
    'done' is never clobbered (W-SF2).
  - track vanished between claim and fetch → settled failed, no Whisper.
  - run_loop: transient claim errors logged + backed off, never fatal.

CROSS-REF: the other half of the reap contract — a reaped job UNBLOCKS the
track's re-enqueue under the partial-UNIQUE live index (the "not-bricked"
half) — is pinned in db/tests/test_migration_076.py. Deleting coverage
there is NOT compensated for here; both halves must stay.
"""

from __future__ import annotations

import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import structlog

# worker.py (and seeds) import psycopg at module level — skip the whole
# module, not error, when the driver is absent (conftest's T-N4 stance).
pytest.importorskip("psycopg", reason="worker tests require psycopg")
pytest.importorskip("psycopg_pool", reason="worker tests require psycopg_pool")

from tools.audio_stt.config import WorkerConfig  # noqa: E402
from tools.audio_stt.worker import (  # noqa: E402
    ORPHANED_TRACK_ERROR,
    claim_one,
    drain_once,
    error_summary,
    process_job,
    reap_stale,
    run_loop,
    settle_failed,
)

from .conftest import requires_pg  # noqa: E402
from .seeds import (  # noqa: E402
    job_row,
    seed_job,
    seed_source,
    seed_track,
    seed_user,
    segment_rows,
    track_row,
)

pytestmark = requires_pg

STALE_MINUTES = 60

SEGMENTS = [
    {"segment_number": 1, "start_ms": 0, "end_ms": 1500, "body": "안녕하세요"},
    {"segment_number": 2, "start_ms": 1500, "end_ms": 3200, "body": "오늘의 뉴스입니다"},
    {"segment_number": 3, "start_ms": 3100, "end_ms": 4000, "body": "감사합니다"},
]


def two_hours_ago() -> datetime:
    return datetime.now(timezone.utc) - timedelta(hours=2)


def make_cfg(dsn: str, root: Path) -> WorkerConfig:
    return WorkerConfig(
        database_url=dsn,
        audio_storage_dir=root,
        stale_run_minutes=STALE_MINUTES,
        poll_interval_sec=0.01,
    )


class FakeTranscribe:
    """Injected transcribe_fn: records calls, returns canned segments or
    raises — the testability seam the worker is built around."""

    def __init__(self, segments=None, error: Exception | None = None):
        self.segments = SEGMENTS if segments is None else segments
        self.error = error
        self.calls: list[Path] = []

    def __call__(self, audio_path: Path) -> list[dict]:
        self.calls.append(audio_path)
        if self.error is not None:
            raise self.error
        return self.segments


def write_blob(root: Path, user_id: int) -> str:
    """Create a dummy audio blob under the storage root; returns the
    RELATIVE blob_ref (074's {userId}/{uuid}.mp3 shape)."""
    rel = f"{user_id}/{uuid.uuid4()}.mp3"
    abs_path = root / rel
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    abs_path.write_bytes(b"\xff\xfbfake-mp3-bytes")
    return rel


# ---------------------------------------------------------------------------
# 1. THE 076 pin: reap is 'running'-only, keyed on started_at.
# ---------------------------------------------------------------------------


def test_reap_running_only(conn, pool, tmp_path, dsn) -> None:
    cfg = make_cfg(dsn, tmp_path)
    user = seed_user(conn, "reap@example.com")
    source = seed_source(conn, user)
    track_a = seed_track(conn, source, user, n=1)
    blob = write_blob(tmp_path, user)
    track_b = seed_track(conn, source, user, n=2, blob_ref=blob)

    # A crashed worker's claim: 'running' with a 2-hour-old started_at —
    # and the track it stranded at transcript_status = 'running' (074).
    stale_running = seed_job(
        conn, track_a, user, status="running", started_at=two_hours_ago()
    )
    conn.execute(
        "UPDATE audio_tracks SET transcript_status = 'running' WHERE id = %s",
        (track_a,),
    )
    # The healthy backlog: 'pending' ENQUEUED 2 hours ago (started_at NULL).
    old_pending = seed_job(conn, track_b, user, created_at=two_hours_ago())

    fake = FakeTranscribe()
    assert drain_once(pool, fake, cfg) is True

    # The stale 'running' row was reaped 'failed' with an explanatory error…
    status, error, finished_at = job_row(conn, stale_running)
    assert status == "failed"
    assert "stale run reaped" in error
    assert finished_at is not None
    # …its stranded track was failed WITH it (W-SF1 — otherwise the Listen
    # UI would show 'running' forever; the reaper is the only actor that
    # ever learns the crash happened)…
    assert track_row(conn, track_a)[0] == "failed"

    # …and the old 'pending' row was NOT reaped — it was claimed + processed
    # (reaping 'pending' would fail-fail the whole backlog after downtime).
    status, error, _ = job_row(conn, old_pending)
    assert status == "done", f"old pending job must be drained, not reaped: {error}"
    assert len(fake.calls) == 1


def test_reap_fails_stranded_track_but_never_a_settled_one(conn, pool) -> None:
    """W-SF1's guard: the reap's companion UPDATE fails a track stranded at
    transcript_status 'running', but its ``= 'running'`` guard leaves a
    track whose NEWER job already settled it 'done' untouched — and a
    reaped job with a NULL track_id (track deleted, fk SET NULL) is
    skipped, not a crash."""
    user = seed_user(conn, "reap-tracks@example.com")
    source = seed_source(conn, user)
    stranded = seed_track(conn, source, user, n=1)
    settled = seed_track(conn, source, user, n=2)
    conn.execute(
        "UPDATE audio_tracks SET transcript_status = 'running' WHERE id = %s",
        (stranded,),
    )
    conn.execute(
        "UPDATE audio_tracks SET transcript_status = 'done' WHERE id = %s",
        (settled,),
    )
    stale_a = seed_job(
        conn, stranded, user, status="running", started_at=two_hours_ago()
    )
    # An OLD stale claim on `settled` — a newer job re-ran it to 'done'
    # already (that job is settled, so the partial-UNIQUE live index allows
    # both rows).
    stale_b = seed_job(
        conn, settled, user, status="running", started_at=two_hours_ago()
    )
    seed_job(conn, settled, user, status="done")
    # Orphan: reaped job whose track was deleted (SET NULL).
    stale_null = seed_job(
        conn, None, user, status="running", started_at=two_hours_ago()
    )

    with pool.connection() as c:
        assert reap_stale(c, STALE_MINUTES) == 3

    assert job_row(conn, stale_a)[0] == "failed"
    assert job_row(conn, stale_b)[0] == "failed"
    assert job_row(conn, stale_null)[0] == "failed"
    # The stranded track settles 'failed' with its job…
    assert track_row(conn, stranded)[0] == "failed"
    # …but the newer job's 'done' is NEVER clobbered by reaping an old job.
    assert track_row(conn, settled)[0] == "done"


def test_fresh_running_job_is_not_reaped(conn, pool) -> None:
    user = seed_user(conn, "fresh-running@example.com")
    source = seed_source(conn, user)
    track = seed_track(conn, source, user)
    job = seed_job(
        conn, track, user, status="running",
        started_at=datetime.now(timezone.utc),
    )
    with pool.connection() as c:
        assert reap_stale(c, STALE_MINUTES) == 0
        # …and it is not claimable either (claim polls 'pending' only).
        assert claim_one(c, STALE_MINUTES) is None
    assert job_row(conn, job)[0] == "running"


# ---------------------------------------------------------------------------
# 2. Happy path.
# ---------------------------------------------------------------------------


def test_happy_path_persists_segments_and_settles_done(
    conn, pool, tmp_path, dsn
) -> None:
    cfg = make_cfg(dsn, tmp_path)
    user = seed_user(conn, "happy@example.com")
    source = seed_source(conn, user)
    blob = write_blob(tmp_path, user)
    track = seed_track(conn, source, user, blob_ref=blob)
    job = seed_job(conn, track, user)

    fake = FakeTranscribe()
    assert drain_once(pool, fake, cfg) is True

    status, error, finished_at = job_row(conn, job)
    assert (status, error) == ("done", None)
    assert finished_at is not None

    rows = segment_rows(conn, track)
    assert rows == [
        (s["segment_number"], s["start_ms"], s["end_ms"], s["body"])
        for s in SEGMENTS
    ]
    transcript_status, duration_ms = track_row(conn, track)
    assert transcript_status == "done"
    assert duration_ms == 4000  # max end_ms — an honest lower bound (074)

    # The fake received the RESOLVED absolute path under the storage root.
    assert fake.calls == [tmp_path / blob]
    # Queue drained: the next poll is idle.
    assert drain_once(pool, fake, cfg) is False


def test_happy_path_preserves_probed_duration(conn, pool, tmp_path, dsn) -> None:
    cfg = make_cfg(dsn, tmp_path)
    user = seed_user(conn, "duration@example.com")
    source = seed_source(conn, user)
    blob = write_blob(tmp_path, user)
    track = seed_track(conn, source, user, blob_ref=blob)
    conn.execute(
        "UPDATE audio_tracks SET duration_ms = 99000 WHERE id = %s", (track,)
    )
    seed_job(conn, track, user)

    assert drain_once(pool, FakeTranscribe(), cfg) is True
    # COALESCE keeps the probed value — segments only fill a NULL.
    assert track_row(conn, track) == ("done", 99000)


# ---------------------------------------------------------------------------
# 3. Orphaned-pending (076's pinned contract).
# ---------------------------------------------------------------------------


def test_orphaned_pending_settles_failed_without_whisper(
    conn, pool, tmp_path, dsn
) -> None:
    cfg = make_cfg(dsn, tmp_path)
    user = seed_user(conn, "orphan@example.com")
    job = seed_job(conn, None, user)  # track deleted before the worker got there

    fake = FakeTranscribe()
    assert drain_once(pool, fake, cfg) is True

    status, error, finished_at = job_row(conn, job)
    assert status == "failed"
    assert error == ORPHANED_TRACK_ERROR
    assert finished_at is not None
    assert fake.calls == [], "Whisper must NEVER run for an orphaned job"


def test_track_vanished_after_claim_settles_failed(conn, pool, tmp_path, dsn) -> None:
    """The claim saw a live track_id, but the track was DELETEd before the
    worker's fetch (the job row was SET NULL'd concurrently — the stale Job
    dataclass still carries the old id). Must settle 'failed' like
    orphaned-pending, never invoke Whisper, and never raise (a raise here
    would kill the loop)."""
    cfg = make_cfg(dsn, tmp_path)
    user = seed_user(conn, "vanished@example.com")
    source = seed_source(conn, user)
    blob = write_blob(tmp_path, user)
    track = seed_track(conn, source, user, blob_ref=blob)
    job = seed_job(conn, track, user)

    with pool.connection() as c:
        claimed = claim_one(c, STALE_MINUTES)
    assert claimed is not None and claimed.track_id == track
    conn.execute("DELETE FROM audio_tracks WHERE id = %s", (track,))

    fake = FakeTranscribe()
    process_job(pool, claimed, fake, cfg)

    status, error, finished_at = job_row(conn, job)
    assert status == "failed"
    assert error == ORPHANED_TRACK_ERROR
    assert finished_at is not None
    assert fake.calls == [], "Whisper must NEVER run for a vanished track"


# ---------------------------------------------------------------------------
# 4. Missing blob.
# ---------------------------------------------------------------------------


def test_missing_blob_settles_failed(conn, pool, tmp_path, dsn) -> None:
    cfg = make_cfg(dsn, tmp_path)
    user = seed_user(conn, "noblob@example.com")
    source = seed_source(conn, user)
    track = seed_track(conn, source, user, blob_ref=f"{user}/gone.mp3")
    job = seed_job(conn, track, user)

    fake = FakeTranscribe()
    assert drain_once(pool, fake, cfg) is True

    status, error, _ = job_row(conn, job)
    assert status == "failed"
    assert "audio blob missing" in error
    assert track_row(conn, track)[0] == "failed"
    assert fake.calls == []


# ---------------------------------------------------------------------------
# 5. Transcription failure — tx atomicity.
# ---------------------------------------------------------------------------


def test_transcribe_error_settles_failed_with_zero_segments(
    conn, pool, tmp_path, dsn
) -> None:
    cfg = make_cfg(dsn, tmp_path)
    user = seed_user(conn, "boom@example.com")
    source = seed_source(conn, user)
    blob = write_blob(tmp_path, user)
    track = seed_track(conn, source, user, blob_ref=blob)
    job = seed_job(conn, track, user)

    fake = FakeTranscribe(error=RuntimeError("CUDA out of memory"))
    assert drain_once(pool, fake, cfg) is True

    status, error, _ = job_row(conn, job)
    assert status == "failed"
    assert "CUDA out of memory" in error
    assert segment_rows(conn, track) == [], "no partial segments may land"
    assert track_row(conn, track)[0] == "failed"


def test_invalid_segments_roll_back_atomically(conn, pool, tmp_path, dsn) -> None:
    """A transcribe_fn emitting schema-violating rows (empty body — 075
    CHECK) aborts the persist tx: job 'failed', zero segments, and any
    PRE-EXISTING segments survive the rolled-back DELETE."""
    cfg = make_cfg(dsn, tmp_path)
    user = seed_user(conn, "badseg@example.com")
    source = seed_source(conn, user)
    blob = write_blob(tmp_path, user)
    track = seed_track(conn, source, user, blob_ref=blob)
    conn.execute(
        """
        INSERT INTO audio_transcript_segments
            (track_id, segment_number, start_ms, end_ms, body)
        VALUES (%s, 1, 0, 900, '이전 것')
        """,
        (track,),
    )
    job = seed_job(conn, track, user)

    bad = [{"segment_number": 1, "start_ms": 0, "end_ms": 100, "body": ""}]
    assert drain_once(pool, FakeTranscribe(segments=bad), cfg) is True

    assert job_row(conn, job)[0] == "failed"
    # The DELETE rolled back with the failed INSERT — the old transcript
    # survives a broken re-run instead of being half-destroyed.
    assert segment_rows(conn, track) == [(1, 0, 900, "이전 것")]


# ---------------------------------------------------------------------------
# 6. Idempotent re-run.
# ---------------------------------------------------------------------------


def test_rerun_replaces_existing_segments(conn, pool, tmp_path, dsn) -> None:
    cfg = make_cfg(dsn, tmp_path)
    user = seed_user(conn, "rerun@example.com")
    source = seed_source(conn, user)
    blob = write_blob(tmp_path, user)
    track = seed_track(conn, source, user, blob_ref=blob)
    conn.execute(
        """
        INSERT INTO audio_transcript_segments
            (track_id, segment_number, start_ms, end_ms, body)
        VALUES (%s, 1, 0, 500, '옛날 텍스트'), (%s, 2, 500, 900, '더 옛날')
        """,
        (track, track),
    )
    job = seed_job(conn, track, user)

    # Same segment_numbers as the pre-existing rows: without the DELETE the
    # INSERT would 23505 on uq_audio_transcript_segments_track_number.
    assert drain_once(pool, FakeTranscribe(), cfg) is True

    assert job_row(conn, job)[0] == "done"
    assert segment_rows(conn, track) == [
        (s["segment_number"], s["start_ms"], s["end_ms"], s["body"])
        for s in SEGMENTS
    ]


# ---------------------------------------------------------------------------
# 7. Claim guard + FIFO + empty queue.
# ---------------------------------------------------------------------------


def test_claim_is_fifo_and_guarded(conn, pool) -> None:
    user = seed_user(conn, "fifo@example.com")
    source = seed_source(conn, user)
    track_1 = seed_track(conn, source, user, n=1)
    track_2 = seed_track(conn, source, user, n=2)
    # Same-tick enqueues: id is the deterministic FIFO tiebreak (076 index).
    now = datetime.now(timezone.utc)
    job_1 = seed_job(conn, track_1, user, created_at=now)
    job_2 = seed_job(conn, track_2, user, created_at=now)

    with pool.connection() as c:
        first = claim_one(c, STALE_MINUTES)
    assert first is not None and first.id == job_1
    assert first.track_id == track_1 and first.user_id == user
    status, _, _ = job_row(conn, job_1)
    assert status == "running"
    with conn.cursor() as cur:
        cur.execute(
            "SELECT started_at FROM audio_transcription_jobs WHERE id = %s",
            (job_1,),
        )
        assert cur.fetchone()[0] is not None, "claim must stamp started_at"

    # The 'running' row is invisible to the next poll — only job_2 remains.
    with pool.connection() as c:
        second = claim_one(c, STALE_MINUTES)
    assert second is not None and second.id == job_2

    # Empty queue: claim returns None, drain returns False.
    with pool.connection() as c:
        assert claim_one(c, STALE_MINUTES) is None


def test_drain_on_empty_queue_returns_false(conn, pool, tmp_path, dsn) -> None:
    cfg = make_cfg(dsn, tmp_path)
    fake = FakeTranscribe()
    assert drain_once(pool, fake, cfg) is False
    assert fake.calls == []


# ---------------------------------------------------------------------------
# 8. Mid-flight settle race: empty RETURNING aborts the persist tx.
# ---------------------------------------------------------------------------


def test_job_settled_elsewhere_mid_flight_aborts_persist(
    conn, pool, tmp_path, dsn
) -> None:
    cfg = make_cfg(dsn, tmp_path)
    user = seed_user(conn, "raced@example.com")
    source = seed_source(conn, user)
    blob = write_blob(tmp_path, user)
    track = seed_track(conn, source, user, blob_ref=blob)
    job = seed_job(conn, track, user)

    with pool.connection() as c:
        claimed = claim_one(c, STALE_MINUTES)
    assert claimed is not None and claimed.id == job

    def reap_during_transcribe(audio_path: Path) -> list[dict]:
        # Simulate a reaper settling the job while Whisper is in flight.
        conn.execute(
            """
            UPDATE audio_transcription_jobs
               SET status = 'failed', error = 'reaped by another worker',
                   finished_at = now()
             WHERE id = %s
            """,
            (job,),
        )
        return SEGMENTS

    process_job(pool, claimed, reap_during_transcribe, cfg)

    # The other settlement WINS (settle_failed's status guard no-ops on a
    # non-'running' row) and no segments landed for the failed job.
    status, error, _ = job_row(conn, job)
    assert (status, error) == ("failed", "reaped by another worker")
    assert segment_rows(conn, track) == []


def test_settled_elsewhere_does_not_clobber_done_track(
    conn, pool, tmp_path, dsn
) -> None:
    """The W-SF2 race: worker A outruns the stale threshold, its job is
    reaped, a re-enqueued job completes the track 'done' with fresh
    segments — THEN worker A's persist aborts (settled elsewhere). A must
    yield: the track stays 'done' and the newer transcript survives (the
    old unconditional _mark_track_failed flipped it to 'failed')."""
    cfg = make_cfg(dsn, tmp_path)
    user = seed_user(conn, "clobber@example.com")
    source = seed_source(conn, user)
    blob = write_blob(tmp_path, user)
    track = seed_track(conn, source, user, blob_ref=blob)
    job = seed_job(conn, track, user)

    with pool.connection() as c:
        claimed = claim_one(c, STALE_MINUTES)
    assert claimed is not None and claimed.id == job

    def settled_elsewhere_and_rerun(audio_path: Path) -> list[dict]:
        # While A's Whisper runs: a reaper fails A's job, then a re-enqueued
        # job B completes the SAME track — 'done', fresh segments.
        conn.execute(
            """
            UPDATE audio_transcription_jobs
               SET status = 'failed', error = 'stale run reaped',
                   finished_at = now()
             WHERE id = %s
            """,
            (job,),
        )
        conn.execute(
            "UPDATE audio_tracks SET transcript_status = 'done' WHERE id = %s",
            (track,),
        )
        conn.execute(
            """
            INSERT INTO audio_transcript_segments
                (track_id, segment_number, start_ms, end_ms, body)
            VALUES (%s, 1, 0, 800, 'B의 결과')
            """,
            (track,),
        )
        return SEGMENTS

    process_job(pool, claimed, settled_elsewhere_and_rerun, cfg)

    # A yielded: B's 'done' track state and B's transcript are untouched
    # (A's persist — including its DELETE of B's segments — rolled back).
    assert track_row(conn, track)[0] == "done"
    assert segment_rows(conn, track) == [(1, 0, 800, "B의 결과")]
    assert job_row(conn, job)[0] == "failed"


# ---------------------------------------------------------------------------
# 9. settle_failed guard + error_summary bounds.
# ---------------------------------------------------------------------------


def test_settle_failed_never_clobbers_a_settled_job(conn, pool) -> None:
    user = seed_user(conn, "settled@example.com")
    source = seed_source(conn, user)
    track = seed_track(conn, source, user)
    job = seed_job(conn, track, user, status="done")

    settle_failed(pool, job, "should be a no-op")
    status, error, _ = job_row(conn, job)
    assert (status, error) == ("done", None)


def test_error_summary_never_empty_and_bounded() -> None:
    assert error_summary(Exception("")) == "unknown error (Exception)"
    assert error_summary(RuntimeError("   ")) == "unknown error (RuntimeError)"
    assert error_summary(ValueError("boom")) == "boom"
    long = error_summary(RuntimeError("x" * 5000))
    assert len(long) == 2000


# ---------------------------------------------------------------------------
# 10. run_loop — transient-error backoff + stop event (no DB needed; the
#     pool is a stub that fails like a downed database).
# ---------------------------------------------------------------------------


class StopAfterFirstWait(threading.Event):
    """A stop event whose wait() records the backoff interval and then stops
    the loop — the single-iteration seam for run_loop tests."""

    def __init__(self) -> None:
        super().__init__()
        self.waits: list[float | None] = []

    def wait(self, timeout: float | None = None) -> bool:
        self.waits.append(timeout)
        self.set()
        return True


class ExplodingPool:
    """A pool whose connection() always raises — the DB is down."""

    def connection(self):
        raise RuntimeError("connection refused: db is down")


def make_loop_cfg(root: Path) -> WorkerConfig:
    # database_url is never dialed — the stub pool fails first.
    return WorkerConfig(
        database_url="postgres://unused", audio_storage_dir=root,
        poll_interval_sec=0.01,
    )


def test_run_loop_logs_and_backs_off_on_transient_claim_error(tmp_path) -> None:
    """A claim-side infrastructure error (pool.connection raises) must be
    LOGGED and BACKED OFF one poll interval — never propagate and kill the
    worker (a worker that dies on a DB blip strands the queue)."""
    stop = StopAfterFirstWait()
    fake = FakeTranscribe()
    with structlog.testing.capture_logs() as logs:
        run_loop(ExplodingPool(), fake, make_loop_cfg(tmp_path), stop)

    # Exactly one backoff of the configured interval, then the (test) stop.
    assert stop.waits == [0.01]
    assert any(
        entry["event"] == "drain iteration failed"
        and "db is down" in entry["error"]
        for entry in logs
    ), f"transient error must be logged, got: {logs}"
    assert fake.calls == []


def test_run_loop_exits_immediately_when_stop_preset(tmp_path) -> None:
    """A pre-set stop event means ZERO iterations — the pool is never
    touched (ExplodingPool would raise if it were)."""
    stop = threading.Event()
    stop.set()
    run_loop(ExplodingPool(), FakeTranscribe(), make_loop_cfg(tmp_path), stop)
