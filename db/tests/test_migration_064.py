"""Migration 064 (backfill notification_schedules from the 018 blob, F-093)
— real-chain tests.

WHY THIS FILE EXISTS:
    064 is a pure DATA backfill (no schema change): for every user whose
    `users.preferences->notif` blob already expresses an enabled EMAIL
    intent, it inserts an equivalent `notification_schedules` row — but only
    when one does not already exist. Its value is entirely in the mapping +
    guard rules (channel.email gate, per-kind intent, ON CONFLICT DO NOTHING,
    the jsonb_typeof defensive cast), so these tests apply the REAL migration
    chain against a real Postgres-16 testcontainer and prove each rule with
    actual rows — a malformed blob must not abort the migration, a user who
    already has a schedule row must be left untouched, and a user with no
    email intent backfills nothing.

SCOPE:
    - up: full intent (daily+reviewsDue+weekly, channel.email=true) backfills
      all three kinds with the documented default times/weekday/tz; a user
      with channel.email=false backfills nothing even with intents true; a
      user with an EXISTING schedule row for a kind is left untouched
      (ON CONFLICT DO NOTHING) rather than overwritten; a malformed
      (non-boolean) value at an intent path is treated as false, not an
      aborted migration; a fresh/empty `{}` blob backfills nothing.
    - down: deletes exactly the untouched backfilled rows and preserves a
      row the user edited after the backfill (updated_at bumped).

DETERMINISM:
    Mirrors test_migration_052.py — real migration files copied into a
    tmp_path-scoped dir, runner pointed at it via --migrations-dir, fresh
    schema per test.
"""

from __future__ import annotations

import pathlib
import shutil

import psycopg
import pytest
from psycopg.rows import dict_row, tuple_row

from db import migrate  # type: ignore[import-not-found]

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

FAKE_HASH = "$argon2id$" + "x" * 70


@pytest.fixture(scope="session")
def pg_container():
    with PostgresContainer("postgres:16-alpine") as pg:
        yield pg


@pytest.fixture()
def dsn(pg_container) -> str:
    raw = pg_container.get_connection_url()
    raw = raw.replace("postgresql+psycopg2://", "postgres://")
    raw = raw.replace("postgresql://", "postgres://")
    with psycopg.connect(raw, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute("DROP SCHEMA public CASCADE")
        cur.execute("CREATE SCHEMA public")
        cur.execute("SELECT 1 FROM pg_roles WHERE rolname = 'km_app'")
        if cur.fetchone() is not None:
            cur.execute("DROP OWNED BY km_app")
            cur.execute("DROP ROLE km_app")
    return raw


@pytest.fixture()
def env(monkeypatch, dsn) -> None:
    monkeypatch.setenv("DATABASE_URL", dsn)


@pytest.fixture()
def full_dir(tmp_path: pathlib.Path) -> pathlib.Path:
    """Every production migration file (needed for the users/notification_*
    tables + the F-089/F-092 siblings sitting in the same version range)."""
    d = tmp_path / "migrations_full"
    d.mkdir(parents=True)
    copied = 0
    for src in REAL_MIGRATIONS_DIR.iterdir():
        if src.suffix == ".sql" and src.is_file():
            shutil.copy2(src, d / src.name)
            copied += 1
    assert copied > 0, f"no migration files found under {REAL_MIGRATIONS_DIR}"
    return d


PRE_064 = "063"


def _up_to(dir_: pathlib.Path, target: str | None = None) -> None:
    args = ["--migrations-dir", str(dir_), "--allow-destructive"]
    if target is not None:
        args += ["--target", target]
    args.append("up")
    rc = migrate.main(args)
    assert rc == 0, f"up (target={target}) returned {rc}"


def _seed_user(conn: psycopg.Connection, email: str, preferences: dict | None) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        if preferences is None:
            cur.execute(
                "INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id",
                (email, FAKE_HASH),
            )
        else:
            import json

            cur.execute(
                """
                INSERT INTO users (email, password_hash, preferences)
                VALUES (%s, %s, %s::jsonb) RETURNING id
                """,
                (email, FAKE_HASH, json.dumps(preferences)),
            )
        return cur.fetchone()[0]


def _blob(daily: bool, reviews_due: bool, weekly: bool, email: bool = True) -> dict:
    return {
        "notif": {
            "channel": {"email": email, "sms": False},
            "daily": daily,
            "reviewsDue": reviews_due,
            "weekly": weekly,
        }
    }


def _schedules(conn: psycopg.Connection, user_id: int) -> list[dict]:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            SELECT kind, channel, to_char(time_of_day, 'HH24:MI') AS time_of_day,
                   tz, weekday, enabled, created_at, updated_at
              FROM notification_schedules
             WHERE user_id = %s
             ORDER BY kind
            """,
            (user_id,),
        )
        return cur.fetchall()


# ---------------------------------------------------------------------------
# 1. Full intent backfills all three kinds with the documented defaults
# ---------------------------------------------------------------------------

def test_064_full_intent_backfills_all_three_kinds(env, dsn: str, full_dir) -> None:
    # Migrate to just before 064 so we can seed users BEFORE the backfill runs.
    _up_to(full_dir, target=PRE_064)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(
            conn, "full-intent@example.com", _blob(daily=True, reviews_due=True, weekly=True)
        )
    _up_to(full_dir)  # apply 064 (and anything after)

    with psycopg.connect(dsn, autocommit=True) as conn:
        rows = _schedules(conn, user_id)
    by_kind = {r["kind"]: r for r in rows}
    assert set(by_kind) == {"daily_reminder", "reviews_due", "weekly_report"}

    assert by_kind["daily_reminder"]["time_of_day"] == "08:00"
    assert by_kind["daily_reminder"]["weekday"] is None
    assert by_kind["reviews_due"]["time_of_day"] == "18:00"
    assert by_kind["reviews_due"]["weekday"] is None
    assert by_kind["weekly_report"]["time_of_day"] == "09:00"
    assert by_kind["weekly_report"]["weekday"] == 0

    for row in by_kind.values():
        assert row["channel"] == "email"
        assert row["tz"] == "UTC"
        assert row["enabled"] is True


# ---------------------------------------------------------------------------
# 2. channel.email=false backfills NOTHING even with every intent true
# ---------------------------------------------------------------------------

def test_064_no_email_channel_backfills_nothing(env, dsn: str, full_dir) -> None:
    _up_to(full_dir, target=PRE_064)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(
            conn,
            "no-email-channel@example.com",
            _blob(daily=True, reviews_due=True, weekly=True, email=False),
        )
    _up_to(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        rows = _schedules(conn, user_id)
    assert rows == []


# ---------------------------------------------------------------------------
# 3. Partial intent backfills only the true kinds
# ---------------------------------------------------------------------------

def test_064_partial_intent_backfills_only_true_kinds(env, dsn: str, full_dir) -> None:
    _up_to(full_dir, target=PRE_064)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(
            conn,
            "partial-intent@example.com",
            _blob(daily=True, reviews_due=False, weekly=False),
        )
    _up_to(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        rows = _schedules(conn, user_id)
    assert {r["kind"] for r in rows} == {"daily_reminder"}


# ---------------------------------------------------------------------------
# 4. A user with an EXISTING schedule row is untouched (ON CONFLICT DO NOTHING)
# ---------------------------------------------------------------------------

def test_064_does_not_overwrite_an_existing_schedule_row(env, dsn: str, full_dir) -> None:
    _up_to(full_dir, target=PRE_064)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(
            conn,
            "already-has-schedule@example.com",
            _blob(daily=True, reviews_due=True, weekly=True),
        )
        # The user already visited /notifications/schedules and picked a
        # DIFFERENT time than the backfill default, before 064 ever runs.
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO notification_schedules
                        (user_id, kind, channel, time_of_day, tz, enabled)
                VALUES (%s, 'daily_reminder', 'email', '23:45', 'America/Denver', false)
                """,
                (user_id,),
            )
    _up_to(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        rows = _schedules(conn, user_id)
    by_kind = {r["kind"]: r for r in rows}
    # The pre-existing row survives EXACTLY as the user left it...
    assert by_kind["daily_reminder"]["time_of_day"] == "23:45"
    assert by_kind["daily_reminder"]["tz"] == "America/Denver"
    assert by_kind["daily_reminder"]["enabled"] is False
    # ...but the OTHER two kinds (no pre-existing row) still backfill.
    assert set(by_kind) == {"daily_reminder", "reviews_due", "weekly_report"}


# ---------------------------------------------------------------------------
# 5. A malformed (non-boolean) intent value is treated as false, not an
#    aborted migration.
# ---------------------------------------------------------------------------

def test_064_malformed_intent_value_does_not_abort_and_is_treated_false(
    env, dsn: str, full_dir
) -> None:
    _up_to(full_dir, target=PRE_064)
    with psycopg.connect(dsn, autocommit=True) as conn:
        # `daily` is an object, `reviewsDue` is a string, `weekly` is legally
        # true, `channel.email` legally true — a real-world "hand-edited or
        # ancient blob" scenario the jsonb_typeof guard exists for.
        weird_user = _seed_user(
            conn,
            "malformed-blob@example.com",
            {
                "notif": {
                    "channel": {"email": True, "sms": False},
                    "daily": {"unexpected": "object"},
                    "reviewsDue": "not-a-boolean",
                    "weekly": True,
                }
            },
        )
        # A well-formed neighbor proves the migration didn't just skip
        # everyone after hitting the malformed row.
        clean_user = _seed_user(
            conn, "clean-neighbor@example.com", _blob(daily=True, reviews_due=True, weekly=True)
        )

    # Must not raise / must not abort the deploy.
    _up_to(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        weird_rows = _schedules(conn, weird_user)
        clean_rows = _schedules(conn, clean_user)

    # Only the legally-true `weekly` kind backfills for the malformed user.
    assert {r["kind"] for r in weird_rows} == {"weekly_report"}
    # The clean neighbor gets the full three-kind backfill regardless.
    assert {r["kind"] for r in clean_rows} == {
        "daily_reminder",
        "reviews_due",
        "weekly_report",
    }


# ---------------------------------------------------------------------------
# 6. A fresh/empty blob (migration 018's own default) backfills nothing.
# ---------------------------------------------------------------------------

def test_064_empty_blob_backfills_nothing(env, dsn: str, full_dir) -> None:
    _up_to(full_dir, target=PRE_064)
    with psycopg.connect(dsn, autocommit=True) as conn:
        # preferences=None → the seed helper omits the column, leaving the
        # 018 DEFAULT '{}'::jsonb in place.
        user_id = _seed_user(conn, "fresh-user@example.com", preferences=None)
    _up_to(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        rows = _schedules(conn, user_id)
    assert rows == []


# ---------------------------------------------------------------------------
# 7. DOWN — deletes exactly the untouched backfilled rows, preserves a row
#    the user edited afterward (updated_at bumped past created_at).
# ---------------------------------------------------------------------------

def test_064_down_removes_untouched_backfill_but_preserves_user_edit(
    env, dsn: str, full_dir
) -> None:
    _up_to(full_dir, target=PRE_064)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(
            conn,
            "down-rollback@example.com",
            _blob(daily=True, reviews_due=True, weekly=True),
        )
    _up_to(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        before = {r["kind"]: r for r in _schedules(conn, user_id)}
        assert set(before) == {"daily_reminder", "reviews_due", "weekly_report"}

        # The user edits the backfilled reviews_due row after the fact —
        # updated_at now postdates created_at, so the down-migration's guard
        # must spare it.
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE notification_schedules
                   SET time_of_day = '20:00', updated_at = updated_at + interval '1 minute'
                 WHERE user_id = %s AND kind = 'reviews_due'
                """,
                (user_id,),
            )

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_064, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {PRE_064} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        after = {r["kind"]: r for r in _schedules(conn, user_id)}

    # The untouched daily_reminder/weekly_report backfill rows are gone...
    assert "daily_reminder" not in after
    assert "weekly_report" not in after
    # ...but the user's edited reviews_due row survives, unchanged.
    assert after["reviews_due"]["time_of_day"] == "20:00"
