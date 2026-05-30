"""Coverage tests: every distinct `type` value in Darakwon source JSON
must have a matching enum value in `vocab_entry_type` / `kgiu_entry_type`
in migration 002.

WHY: REVIEW_A2 BLOCKER-1 was that the schema's discriminator enums omitted
the `reference` value used by ~50 source rows. This test fails loudly if a
future enum/source drift reintroduces the same gap — for vocab,
kgiu, or any later-added enum we extend the coverage map to.

Implementation: scan every grammar_kgiu_*.json and vocab_2000_*.json under
Repository/tools/ingest/output/, extract distinct `type` values, and
assert each is present in the matching enum's value list as parsed out of
002_darakwon_corpora.up.sql.

The test is a pure-Python source scan — it does NOT require a running
Postgres, so it runs in any environment that has the JSON files on disk.
"""

from __future__ import annotations

import json
import pathlib
import re

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
INGEST_DIR = REPO_ROOT / "tools" / "ingest" / "output"
MIGRATION_002 = (
    REPO_ROOT / "db" / "migrations" / "002_darakwon_corpora.up.sql"
)

# Map enum name → glob pattern selecting the source JSONs the enum covers.
# `lets_check` and `hanja_extension` live in their own tables (not in
# vocab_entry_type) and are explicitly excluded — see the column comment
# on `vocab_entries.entry_type`.
ENUM_COVERAGE = {
    "kgiu_entry_type": {
        "globs": ["grammar_kgiu_*.json"],
        "excluded_types": set(),
    },
    "vocab_entry_type": {
        "globs": ["vocab_2000_*.json"],
        # Per the migration comment: lets_check and hanja_extension are
        # routed to their own tables (lets_check_exercises and
        # hanja_extensions respectively), so they are NOT expected to be
        # values of vocab_entry_type.
        "excluded_types": {"lets_check", "hanja_extension"},
    },
}


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def _enum_values_from_migration(enum_name: str) -> set[str]:
    """Parse 002_darakwon_corpora.up.sql and return the value set declared
    for `enum_name`, considering both the CREATE TYPE list and any
    ALTER TYPE … ADD VALUE statements.
    """
    sql = MIGRATION_002.read_text(encoding="utf-8")

    values: set[str] = set()

    # CREATE TYPE <name> AS ENUM ( 'a', 'b', ... )
    create_pattern = re.compile(
        rf"CREATE\s+TYPE\s+{re.escape(enum_name)}\s+AS\s+ENUM\s*\((?P<body>[^)]*)\)",
        re.IGNORECASE | re.DOTALL,
    )
    for match in create_pattern.finditer(sql):
        body = match.group("body")
        for value_match in re.finditer(r"'([^']+)'", body):
            values.add(value_match.group(1))

    # ALTER TYPE <name> ADD VALUE [IF NOT EXISTS] '<value>'
    alter_pattern = re.compile(
        rf"ALTER\s+TYPE\s+{re.escape(enum_name)}\s+ADD\s+VALUE\s+"
        r"(?:IF\s+NOT\s+EXISTS\s+)?'([^']+)'",
        re.IGNORECASE,
    )
    for match in alter_pattern.finditer(sql):
        values.add(match.group(1))

    return values


def _source_type_values(globs: list[str]) -> set[str]:
    """Walk the source JSONs matching `globs`, return the union of every
    row-level `type` value.
    """
    types: set[str] = set()
    for glob in globs:
        for path in sorted(INGEST_DIR.glob(glob)):
            data = json.loads(path.read_text(encoding="utf-8"))
            # Source JSON shape varies a little (top-level dict with
            # "entries" / "items" / etc., or a bare list). Be tolerant.
            rows = _iter_rows(data)
            for row in rows:
                if isinstance(row, dict) and "type" in row:
                    value = row["type"]
                    if isinstance(value, str):
                        types.add(value)
    return types


def _iter_rows(data: object) -> list[dict]:
    """Yield every dict that plausibly represents a row from a Darakwon
    JSON. We accept (a) a list at the top level, (b) a dict with a list
    under any common key, (c) a dict whose values include the row list.
    """
    if isinstance(data, list):
        return [row for row in data if isinstance(row, dict)]
    if isinstance(data, dict):
        # Common shapes: {"entries": [...]}, {"items": [...]},
        # {"rows": [...]}, {"data": [...]} — try these first.
        for key in ("entries", "items", "rows", "data"):
            if key in data and isinstance(data[key], list):
                return [row for row in data[key] if isinstance(row, dict)]
        # Fallback: any value that's a list of dicts.
        for value in data.values():
            if isinstance(value, list) and value and isinstance(value[0], dict):
                return [row for row in value if isinstance(row, dict)]
    return []


# --------------------------------------------------------------------------
# Coverage assertions — one per enum
# --------------------------------------------------------------------------

@pytest.mark.parametrize("enum_name", sorted(ENUM_COVERAGE.keys()))
def test_enum_covers_all_source_types(enum_name: str) -> None:
    """Every distinct `type` value in source JSON must be present in the
    matching enum's value set, modulo the enum's documented exclusions
    (lets_check and hanja_extension live in their own tables, not in
    vocab_entry_type)."""
    spec = ENUM_COVERAGE[enum_name]
    enum_values = _enum_values_from_migration(enum_name)
    assert enum_values, (
        f"could not parse any values for enum {enum_name} out of "
        f"{MIGRATION_002}. Either the regex is wrong or the enum was "
        "removed."
    )

    source_types = _source_type_values(spec["globs"])
    expected = source_types - spec["excluded_types"]

    missing = expected - enum_values
    assert not missing, (
        f"{enum_name} is missing the following type values seen in source "
        f"JSON (globs={spec['globs']}): {sorted(missing)}. "
        "Either add them to the enum (ALTER TYPE … ADD VALUE) or document "
        "the exclusion."
    )


def test_ingest_output_directory_present() -> None:
    """If this fails, the source JSONs were moved or the test is being
    run from the wrong root. Surface the misconfiguration before the
    parametrized assertions blame the schema."""
    assert INGEST_DIR.is_dir(), (
        f"ingest output directory not found: {INGEST_DIR}. "
        "Either the test moved or the JSON files were relocated. "
        "Update INGEST_DIR or restore the files."
    )
