"""FU-NF-40 — guard the hanja 훈 (gloss_kr) data integrity + coverage.

The 훈 map (`data/hanja_hunmeum.json`) is sourced from the 한국어문회 훈음 data and
populates `gloss_kr` for every character in the hanja corpus. These tests lock
two invariants so a future corpus change can't silently ship a blank 훈 (the
Pass-7 bar: "a hanja tutor showing wrong characters is worse than useless"):

  1. The committed map is internally consistent — no blank values, `_missing`
     empty, `_count` matches the entry count.
  2. If the built corpus is present (`output/hanja.json`, gitignored — built by
     build_hanja.py), EVERY character carries a non-empty `gloss_kr`, and every
     corpus char is covered by the map (no drift introducing an unglossed char).
"""

import json
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
INGEST = HERE.parent
HUNMEUM_PATH = INGEST / "data" / "hanja_hunmeum.json"
HANJA_JSON = INGEST / "output" / "hanja.json"


def _load_hunmeum() -> dict:
    return json.loads(HUNMEUM_PATH.read_text(encoding="utf-8"))


def test_hunmeum_file_is_internally_consistent() -> None:
    doc = _load_hunmeum()
    gloss = doc["gloss_kr"]
    assert isinstance(gloss, dict) and gloss, "gloss_kr map must be a non-empty object"
    # No blank 훈 — every listed character must carry a gloss.
    blanks = [ch for ch, v in gloss.items() if not (isinstance(v, str) and v.strip())]
    assert blanks == [], f"characters with a blank 훈: {blanks}"
    # _missing is the build-time record of chars with no source 훈 — must be empty.
    assert doc.get("_missing", []) == [], f"_missing should be empty, got {doc.get('_missing')}"
    # _count is a self-check on the map size.
    assert doc.get("_count") == len(gloss), "_count must match the number of gloss_kr entries"
    # Single-character keys only (these are per-character glosses).
    bad_keys = [k for k in gloss if len(k) != 1]
    assert bad_keys == [], f"gloss_kr keys must be single characters: {bad_keys}"


@pytest.mark.skipif(not HANJA_JSON.exists(), reason="output/hanja.json not built (run build_hanja.py)")
def test_built_corpus_has_full_hun_coverage() -> None:
    corpus = json.loads(HANJA_JSON.read_text(encoding="utf-8"))["characters"]
    gloss = _load_hunmeum()["gloss_kr"]
    # Every built character must have a non-empty gloss_kr...
    missing = [c["char"] for c in corpus if not c.get("gloss_kr", "").strip()]
    assert missing == [], f"corpus chars missing a 훈 (gloss_kr): {missing}"
    # ...and every corpus char must be covered by the source map (catches drift:
    # a new corpus char that wasn't sourced would otherwise ship blank).
    uncovered = [c["char"] for c in corpus if c["char"] not in gloss]
    assert uncovered == [], f"corpus chars absent from the 훈 map: {uncovered}"
