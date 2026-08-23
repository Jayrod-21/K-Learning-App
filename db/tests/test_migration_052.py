"""Migration 052 (notification schedules + delivery log, F-040) — real-chain tests.

WHY THIS FILE EXISTS:
    052 is pure net-new schema (no data transform), but it carries a dense set
    of DECLARATIVE rules the route layer leans on — the (user, kind, channel)
    upsert key, the weekday⟷kind CHECK, the status set on the delivery log,
    the sent⇒sent_at invariant, and the users→schedules→deliveries CASCADE
    chain (per-user erasure). The synthetic harness tests (test_migrations.py)
    prove the RUNNER; these tests apply the REAL migration chain against a
    real Postgres-16 testcontainer via `migrate.main()` and prove each of
    those rules with actual rows — the constraint text in the .sql file is
    prose until a violating INSERT bounces off it.

SCOPE:
    - up: both tables + trigger exist; every CHECK/UNIQUE/FK proven by a
      violating row (kind, channel, weekday-by-kind both directions, tz shape,
      delivery status, sent⇒sent_at, uq (user,kind,channel)); updated_at
      trigger fires; CASCADE user→schedules→deliveries.
    - down: both tables dropped (REQUIRES --allow-destructive — 052.down
      contains real DROP TABLE, unlike 046.down's unmatched DELETEs), the
      rest of the schema intact; re-up is clean.

DETERMINISM:
    Mirrors test_migration_046.py — the real migration files are copied into a
    tmp_path-scoped directory and the runner is pointed at it via
    `--migrations-dir`; the `dsn` fixture gives each test a fresh schema.
"""

from __future__ import annotations

import pathlib

import psycopg
import pytest
from psycopg import errors
from psycopg.rows import dict_row, tuple_row

from db import migrate  # type: ignore[import-not-found]
from db.tests._helpers import _seed_user, _full_up  # type: ignore[import-not-found]

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

# The migration immediately before 052 in the merged Group-2 chain
# (051_reading_positions) — the down-target that rolls back exactly 052 and
# nothing else. This is what makes the gate-refusal assertion below isolate
# 052's OWN DROP TABLE (with a deeper target, an earlier migration's gated
# down could satisfy the refusal and mask a regression in 052.down).
PRE_052 = "051"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _seed_schedule(
    conn: psycopg.Connection,
    user_id: int,
    kind: str = "daily_reminder",
    channel: str = "push",
    time_of_day: str = "07:30",
    tz: str = "Asia/Seoul",
    weekday: int | None = None,
    enabled: bool = True,
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO notification_schedules
                    (user_id, kind, channel, time_of_day, tz, weekday, enabled)
            VALUES (%s, %s, %s, %s::time, %s, %s, %s)
            RETURNING id
            """,
            (user_id, kind, channel, time_of_day, tz, weekday, enabled),
        )
        return cur.fetchone()[0]


def _table_exists(conn: psycopg.Connection, table: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = %s
            """,
            (table,),
        )
        return cur.fetchone() is not None


# ---------------------------------------------------------------------------
# 1. UP — schema shape + every declarative rule proven with real rows
# ---------------------------------------------------------------------------

def test_052_up_schema_constraints_and_cascade(env, dsn: str, full_dir) -> None:
    """Apply the full real chain, then prove 052's contract row by row:
    valid shapes insert; every CHECK / UNIQUE bounces its violation; the
    updated_at trigger fires; user deletion cascades through schedules into
    deliveries."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_exists(conn, "notification_schedules")
        assert _table_exists(conn, "notification_deliveries")

        user_id = _seed_user(conn, "f040@example.com")

        # -- Valid rows: a daily (no weekday), a weekly (weekday required),
        #    and the sms placeholder channel all store cleanly.
        daily_id = _seed_schedule(conn, user_id)
        _seed_schedule(conn, user_id, kind="weekly_report", channel="email",
                       time_of_day="18:00", tz="America/Denver", weekday=0)
        _seed_schedule(conn, user_id, channel="sms")

        # -- CHECK violations, one per rule. Each statement runs in its own
        #    implicit tx (autocommit) so a bounce leaves the connection clean.
        with pytest.raises(errors.CheckViolation):
            _seed_schedule(conn, user_id, kind="hourly_nag", channel="email")
        with pytest.raises(errors.CheckViolation):
            _seed_schedule(conn, user_id, kind="reviews_due",
                           channel="carrier_pigeon")
        with pytest.raises(errors.CheckViolation):  # weekday on a daily kind
            _seed_schedule(conn, user_id, kind="reviews_due", weekday=1)
        with pytest.raises(errors.CheckViolation):  # weekly without weekday
            _seed_schedule(conn, user_id, kind="weekly_report", channel="push",
                           weekday=None)
        with pytest.raises(errors.CheckViolation):  # weekday out of range
            _seed_schedule(conn, user_id, kind="weekly_report", channel="sms",
                           weekday=7)
        with pytest.raises(errors.CheckViolation):  # tz shape (empty)
            _seed_schedule(conn, user_id, kind="reviews_due", channel="email",
                           tz="")

        # -- UNIQUE (user_id, kind, channel): the F-040 upsert key.
        with pytest.raises(errors.UniqueViolation):
            _seed_schedule(conn, user_id, time_of_day="09:00")
        # ...but the same (kind, channel) under ANOTHER user is fine.
        other_id = _seed_user(conn, "f040-other@example.com")
        _seed_schedule(conn, other_id)

        # -- updated_at trigger (001's set_updated_at) fires on UPDATE.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                UPDATE notification_schedules SET enabled = false
                 WHERE id = %s
                RETURNING updated_at > created_at
                """,
                (daily_id,),
            )
            assert cur.fetchone()[0] is True, "trigger must bump updated_at"

        # -- Delivery log: pending needs no sent_at; sent REQUIRES one.
        # window_start (063, F-092's claim-key column) is NOT NULL with no
        # default — every insert below supplies a distinct literal so the
        # (schedule_id, window_start) UNIQUE claim key never spuriously
        # collides between these same-schedule rows.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                INSERT INTO notification_deliveries (schedule_id, status, window_start)
                VALUES (%s, 'pending', '2026-07-01 07:30:00+00') RETURNING id
                """,
                (daily_id,),
            )
        with pytest.raises(errors.CheckViolation):  # unknown status
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO notification_deliveries (schedule_id, status, window_start)
                    VALUES (%s, 'bounced', '2026-07-01 07:31:00+00')
                    """,
                    (daily_id,),
                )
        with pytest.raises(errors.CheckViolation):  # sent without sent_at
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO notification_deliveries (schedule_id, status, window_start)
                    VALUES (%s, 'sent', '2026-07-01 07:32:00+00')
                    """,
                    (daily_id,),
                )
        with conn.cursor() as cur:  # sent WITH sent_at is the valid shape
            cur.execute(
                """
                INSERT INTO notification_deliveries
                        (schedule_id, status, sent_at, provider_ref, window_start)
                VALUES (%s, 'sent', now(), 'ses-msg-0001', '2026-07-01 07:33:00+00')
                """,
                (daily_id,),
            )
        with pytest.raises(errors.ForeignKeyViolation):  # orphan delivery
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO notification_deliveries (schedule_id, status, window_start)
                    VALUES (%s, 'pending', '2026-07-01 07:34:00+00')
                    """,
                    (daily_id + 100000,),
                )

        # -- Erasure chain: deleting the user cascades through schedules into
        #    deliveries (users → schedules → deliveries, both CASCADE).
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (user_id,))
            cur.execute(
                "SELECT count(*) FROM notification_schedules WHERE user_id = %s",
                (user_id,),
            )
            assert cur.fetchone()[0] == 0
            cur.execute("SELECT count(*) FROM notification_deliveries")
            assert cur.fetchone()[0] == 0, (
                "deliveries must cascade away with their schedules"
            )
            # The other user's schedule is untouched.
            cur.execute(
                "SELECT count(*) FROM notification_schedules WHERE user_id = %s",
                (other_id,),
            )
            assert cur.fetchone()[0] == 1


# ---------------------------------------------------------------------------
# 2. DOWN — clean drop (destructive-gated), rest of schema intact, clean re-up
# ---------------------------------------------------------------------------

def test_052_down_drops_both_tables_then_reups(env, dsn: str, full_dir) -> None:
    """Roll back exactly 052 and prove: both tables gone, neighboring schema
    untouched, and a re-up applies cleanly. Unlike 046.down (whose data loss
    is via DELETE/DROP COLUMN, unmatched by the runner's gate), 052.down
    contains real DROP TABLE — the flag is REQUIRED, and the gate refusing
    without it is asserted first."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f040-down@example.com")
        sched_id = _seed_schedule(conn, user_id)
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO notification_deliveries (schedule_id, status, window_start)
                VALUES (%s, 'pending', '2026-07-01 07:30:00+00')
                """,
                (sched_id,),
            )

    # The destructive gate must refuse a 052 rollback without the flag — this
    # target also traverses 063's down (window_start/claim-key, F-092), which
    # is independently marked destructive (F-088), so the refusal holds for
    # either reason.
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_052, "down"]
    )
    assert rc != 0, "052.down contains DROP TABLE — the gate must refuse it"
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_exists(conn, "notification_schedules"), (
            "a refused rollback must leave the schema untouched"
        )

    # ...and perform it with the flag.
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_052,
         "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {PRE_052} returned {rc}"

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        assert not _table_exists(conn, "notification_schedules")
        assert not _table_exists(conn, "notification_deliveries")
        # Neighboring schema intact — the seeded user survives the rollback.
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) AS n FROM users WHERE id = %s", (user_id,))
            assert cur.fetchone()["n"] == 1

    # Re-up: 052 applies cleanly again and comes back empty.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        assert _table_exists(conn, "notification_schedules")
        assert _table_exists(conn, "notification_deliveries")
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) AS n FROM notification_schedules")
            assert cur.fetchone()["n"] == 0
