"""Shared plain-function test helpers for db/tests.

These are NOT pytest fixtures — pytest only auto-injects fixtures declared
via `@pytest.fixture` in a conftest.py, not plain functions/constants. The
fixtures that DO get shared automatically (`pg_container`, `dsn`, `env`,
`full_dir`) live in `conftest.py`; this module holds the handful of
byte-identical helper functions/constants that used to be pasted into ~30
of the db/tests/test_migration_*.py files and must instead be imported
explicitly, e.g.:

    from db.tests._helpers import FAKE_HASH, _seed_user, _full_up

A few files kept their own local `_seed_user` because it has a genuinely
different signature there (extra params, a different default email, an
ON CONFLICT upsert, etc.) — those still import `FAKE_HASH` from here since
the constant itself was identical everywhere.
"""

from __future__ import annotations

import pathlib

import psycopg
from psycopg.rows import tuple_row

from db import migrate  # type: ignore[import-not-found]

# A syntactically valid argon2id-shaped hash satisfying
# ck_users_password_hash_argon2id (LIKE '$argon2id$%', length 80..255).
FAKE_HASH = "$argon2id$" + "x" * 70


def _seed_user(conn: psycopg.Connection, email: str) -> int:
    # tuple_row pinned: helpers must work on dict_row connections too.
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id",
            (email, FAKE_HASH),
        )
        return cur.fetchone()[0]


def _full_up(full_dir: pathlib.Path) -> None:
    # --allow-destructive: migration 045 (hygiene_cleanup, DROP TABLE) sits in
    # the chain, so a full `up` trips migrate.py's destructive gate without it.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0, f"full up returned {rc}"
