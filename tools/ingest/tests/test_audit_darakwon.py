"""
Unit tests for ``audit_darakwon``.

We cover:
  * The pure scoring functions — exhaustive parameterization over the
    interesting cases.
  * The sampling determinism — same seed + same data ⇒ identical sample.
  * The Wilson confidence interval helper — spot-checks against known
    reference values.
  * A snapshot-style fixture for 4 hand-curated audit cases (found
    entry + simulated OCR view + expected severity). The vision-OCR
    call is mocked out via fixture data so these tests don't need the
    SDK or network.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

# conftest.py adds the parent directory to sys.path so this import works.
from audit_darakwon import (  # type: ignore
    ComparisonResult,
    FieldDiscrepancy,
    SampleManifest,
    aggregate_severity,
    build_sample_manifest,
    classify_field_discrepancy,
    render_report,
    render_triage_csv,
    score_entry,
    stratified_sample,
    wilson_ci,
)
import random


# ---------------------------------------------------------------------------
# classify_field_discrepancy
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "field,found,expected,is_critical,expected_severity",
    [
        # Both empty -> PASS
        ("pattern", None, None, True, "PASS"),
        ("pattern", "", "", True, "PASS"),
        # Equal after normalization -> PASS
        ("pattern", " -아/어 보이다 ", "-아/어 보이다", True, "PASS"),
        # Found empty, expected present -> MISSING_DATA
        ("explanation", None, "Some explanation.", True, "MISSING_DATA"),
        # Found present, expected empty (OCR didn't return anything) -> MINOR
        # (we don't claim the JSON is wrong from absence of OCR evidence)
        ("explanation", "Something the JSON claims", None, True, "MINOR_DISCREPANCY"),
        # Critical field with materially different values -> MAJOR
        ("korean", "가족", "친척", True, "MAJOR_DISCREPANCY"),
        # Non-critical field with different values -> MINOR
        ("category", "conjecture", "supposition", False, "MINOR_DISCREPANCY"),
        # English text differs but Korean inside is equivalent -> MINOR
        (
            "examples",
            "가족이 있어요. (We have a family.)",
            "가족이 있어요. — We have family.",
            True,
            "MINOR_DISCREPANCY",
        ),
        # Hanja off-by-one — critical field, definitely MAJOR
        ("hanja", "家人", "家族", True, "MAJOR_DISCREPANCY"),
    ],
)
def test_classify_field_discrepancy(
    field: str,
    found: object,
    expected: object,
    is_critical: bool,
    expected_severity: str,
) -> None:
    assert (
        classify_field_discrepancy(
            field, found=found, expected=expected, is_critical=is_critical
        )
        == expected_severity
    )


# ---------------------------------------------------------------------------
# aggregate_severity
# ---------------------------------------------------------------------------


def _discr(field: str, severity: str) -> FieldDiscrepancy:
    return FieldDiscrepancy(
        field=field, severity=severity, expected=None, found=None
    )


def test_aggregate_severity_empty_is_pass() -> None:
    assert aggregate_severity([]) == "PASS"


def test_aggregate_severity_picks_worst() -> None:
    discs = [
        _discr("a", "MINOR_DISCREPANCY"),
        _discr("b", "MAJOR_DISCREPANCY"),
        _discr("c", "MINOR_DISCREPANCY"),
    ]
    assert aggregate_severity(discs) == "MAJOR_DISCREPANCY"


def test_aggregate_severity_missing_outranks_major() -> None:
    discs = [
        _discr("a", "MAJOR_DISCREPANCY"),
        _discr("b", "MISSING_DATA"),
    ]
    assert aggregate_severity(discs) == "MISSING_DATA"


# ---------------------------------------------------------------------------
# Sampling determinism
# ---------------------------------------------------------------------------


def _make_kgiu_items() -> list[dict[str, object]]:
    """Synthetic KGIU-shaped items spanning 4 chapters."""
    items: list[dict[str, object]] = []
    for ch in range(1, 5):
        for n in range(1, 8):  # 7 entries per chapter -> 28 total
            items.append(
                {
                    "id": f"kgiu-int-c{ch:02d}-{n:02d}",
                    "type": "grammar",
                    "pattern": f"pattern-{ch}-{n}",
                    "source_pages": [10 * ch + n],
                    "source_book": "KGIU Intermediate",
                }
            )
    return items


def test_stratified_sample_is_deterministic() -> None:
    items = _make_kgiu_items()
    s1 = stratified_sample(items, "kgiu_intermediate", 0.2, random.Random(42))
    s2 = stratified_sample(items, "kgiu_intermediate", 0.2, random.Random(42))
    assert [e.entry_id for e in s1] == [e.entry_id for e in s2]
    assert len(s1) >= 4  # at least 1 from each chapter
    # Different seed -> different sample (almost always true at this size)
    s3 = stratified_sample(items, "kgiu_intermediate", 0.2, random.Random(7))
    assert [e.entry_id for e in s1] != [e.entry_id for e in s3]


def test_stratified_sample_covers_every_stratum() -> None:
    items = _make_kgiu_items()
    sample = stratified_sample(items, "kgiu_intermediate", 0.01, random.Random(1))
    strata = {e.stratum for e in sample}
    # Even at 1% rate, every chapter should get at least 1 entry — that's
    # the coverage-first guarantee in the implementation.
    assert strata == {f"chapter_{ch:02d}" for ch in range(1, 5)}


def test_stratified_sample_skips_malformed_entries() -> None:
    items: list[dict[str, object]] = [
        {"id": "kgiu-int-c01-01", "type": "grammar", "source_pages": [10]},
        {"not_an_entry": True},  # malformed — no id
        {"id": "kgiu-int-c01-02", "type": "grammar", "source_pages": [11]},
    ]
    sample = stratified_sample(items, "kgiu_intermediate", 1.0, random.Random(0))
    assert {e.entry_id for e in sample} == {"kgiu-int-c01-01", "kgiu-int-c01-02"}


# ---------------------------------------------------------------------------
# Wilson CI
# ---------------------------------------------------------------------------


def test_wilson_ci_zero_n_returns_zero_zero() -> None:
    assert wilson_ci(0, 0) == (0.0, 0.0)


def test_wilson_ci_all_pass_has_positive_lower_bound() -> None:
    lo, hi = wilson_ci(100, 100)
    assert hi == pytest.approx(1.0)
    assert lo > 0.95  # 100/100 with Wilson gives a tight lower bound near .96+


def test_wilson_ci_brackets_phat() -> None:
    # 90/100 = 0.9 — the CI must contain 0.9 and have width ~10pp
    lo, hi = wilson_ci(90, 100)
    assert lo < 0.9 < hi
    assert 0.05 < (hi - lo) < 0.15


def test_wilson_ci_symmetric_at_half() -> None:
    lo, hi = wilson_ci(50, 100)
    # Wilson is slightly biased toward 0.5 but at p=0.5 it should be
    # essentially symmetric around 0.5
    assert abs(((lo + hi) / 2) - 0.5) < 0.01


# ---------------------------------------------------------------------------
# Snapshot fixture — hand-curated comparison verdicts
# ---------------------------------------------------------------------------

FIXTURE = Path(__file__).parent / "fixtures" / "audit_snapshot.json"


def test_snapshot_fixture_exists() -> None:
    assert FIXTURE.exists(), (
        f"Snapshot fixture missing at {FIXTURE}. "
        "It encodes the expected verdicts for hand-curated audit cases."
    )


def test_snapshot_cases_classify_as_expected() -> None:
    """For each curated case, run score_entry and assert overall severity."""
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert isinstance(data, list)
    assert len(data) >= 4, "expected at least 4 curated cases"

    for case in data:
        discs = score_entry(
            corpus_kind=case["corpus_kind"],
            entry_type=case["entry_type"],
            found=case["found"],
            expected=case["expected"],
        )
        actual = aggregate_severity(discs)
        assert actual == case["expected_severity"], (
            f"case `{case['name']}`: expected {case['expected_severity']}, "
            f"got {actual}; discrepancies={discs}"
        )


# ---------------------------------------------------------------------------
# Report rendering smoke test
# ---------------------------------------------------------------------------


def test_render_report_smoke() -> None:
    manifest = SampleManifest(
        seed=1,
        rate=0.05,
        generated_at="2026-05-28T00:00:00+00:00",
        corpus_stats={
            "kgiu_beginner": {"population": 100, "sampled": 5, "strata": 5},
        },
        entries=[],
    )
    results = [
        ComparisonResult(
            corpus="kgiu_beginner",
            entry_id="kgiu-beg-c01-01",
            overall_severity="PASS",
            discrepancies=[],
            ocr_method="claude_vision",
            ocr_model="claude-opus-4-5-20250929",
            pages_examined=[20],
        ),
        ComparisonResult(
            corpus="kgiu_beginner",
            entry_id="kgiu-beg-c01-02",
            overall_severity="MAJOR_DISCREPANCY",
            discrepancies=[
                FieldDiscrepancy(
                    field="korean",
                    severity="MAJOR_DISCREPANCY",
                    expected="가족",
                    found="친척",
                )
            ],
            ocr_method="claude_vision",
            ocr_model="claude-opus-4-5-20250929",
            pages_examined=[21],
        ),
    ]
    md = render_report(manifest=manifest, results=results)
    assert "Darakwon Extraction Audit Report" in md
    assert "kgiu-beg-c01-02" in md
    assert "95% Wilson CI" in md

    csv_out = render_triage_csv(results)
    assert "corpus,entry_id,severity,field,expected,found,notes" in csv_out
    assert "MAJOR_DISCREPANCY" in csv_out


def test_structural_audit_runs_on_real_corpora_if_present() -> None:
    """Smoke test — structural audit should run cleanly on each real corpus.

    Skipped if the corpus JSONs aren't present in this checkout.
    """
    from audit_darakwon import CORPUS_FILES, structural_audit  # type: ignore

    any_run = False
    for corpus_key, cfg in CORPUS_FILES.items():
        if not Path(cfg["json"]).exists():
            continue
        any_run = True
        results = structural_audit(corpus_key)
        assert results, f"{corpus_key} produced no results"
        # Sanity: every result has a valid severity.
        for r in results:
            assert r.overall_severity in {
                "PASS",
                "MINOR_DISCREPANCY",
                "MAJOR_DISCREPANCY",
                "MISSING_DATA",
            }
    if not any_run:
        pytest.skip("no Darakwon corpora present in this checkout")


def test_render_report_warns_when_ocr_skipped() -> None:
    manifest = SampleManifest(
        seed=1,
        rate=0.05,
        generated_at="2026-05-28T00:00:00+00:00",
        corpus_stats={},
        entries=[],
    )
    results = [
        ComparisonResult(
            corpus="kgiu_beginner",
            entry_id="x",
            overall_severity="PASS",
            discrepancies=[],
            ocr_method="skipped_no_network",
            ocr_model=None,
            pages_examined=[],
        )
    ]
    md = render_report(manifest=manifest, results=results)
    assert "WARNING" in md
    assert "no network" in md.lower() or "no api key" in md.lower()


# ---------------------------------------------------------------------------
# Vision client — self-confirmation bias regression (REVIEW_C3 F2)
# ---------------------------------------------------------------------------


class _FakeMessages:
    """Records the messages payload so we can assert what the model SAW."""

    def __init__(self) -> None:
        self.captured: dict = {}

    def create(self, **kwargs):
        self.captured = kwargs
        # Return a stub message with one text block — content is irrelevant
        # for this test (we're verifying the INPUT prompt, not the parse).

        class _Block:
            type = "text"
            text = "{}"

        class _Msg:
            content = [_Block()]

        return _Msg()


class _FakeAnthropic:
    def __init__(self) -> None:
        self.messages = _FakeMessages()


def test_vision_client_does_not_leak_audited_values_into_prompt(monkeypatch, tmp_path):
    """REVIEW_C3 F2 regression: the OCR call must NOT include the JSON values.

    Pre-fix, the user message contained ``json.dumps({k: entry.get(k) ...})``
    so the model saw the agent's own answers and was biased to confirm.
    Post-fix, only the field NAMES go into the prompt. The model must
    extract values from the page image alone.

    This test injects a fake Anthropic SDK, calls extract_entry_view, and
    inspects the captured prompt to ensure the audited values are absent.
    """
    from audit_darakwon import VisionOcrClient  # type: ignore

    # Build the client and inject our fake SDK client in place of the real one.
    client = VisionOcrClient(api_key="test-key-not-used")
    fake = _FakeAnthropic()
    client._client = fake  # type: ignore[assignment]

    # Bypass real PDF rendering — return a stub PNG byte string.
    monkeypatch.setattr(
        VisionOcrClient,
        "_get_page_png",
        lambda self, p, pp: b"\x89PNG\r\n\x1a\n" + b"\x00" * 64,
    )

    audited_entry = {
        "id": "vocab-beg-0002",
        "korean": "가족",
        "english": "a family",
        "hanja": "家人",  # the known-wrong value from AUDIT_REPORT.md
        "part_of_speech": "noun",
        "audio_track": "track-7",
        "source_pages": [12],
        "source_book": "Test",
    }

    client.extract_entry_view(
        pdf_path=tmp_path / "fake.pdf",
        pdf_pages=[1],
        entry=audited_entry,
    )

    # Pull the captured user message text.
    captured = fake.messages.captured
    assert captured, "extract_entry_view did not invoke the SDK"
    user_msg = captured["messages"][0]
    content_blocks = user_msg["content"]
    text_blocks = [b for b in content_blocks if b.get("type") == "text"]
    assert text_blocks, "no text block in the user message"
    prompt_text = " ".join(b["text"] for b in text_blocks)

    # The id is allowed (it's a bookkeeping label, not an OCR answer).
    assert "vocab-beg-0002" in prompt_text

    # The AUDITED VALUES must NOT be in the prompt — that was the bias.
    forbidden_values = ["가족", "a family", "家人", "track-7"]
    for v in forbidden_values:
        assert v not in prompt_text, (
            f"Vision OCR prompt leaked audited value {v!r} — "
            f"self-confirmation bias (REVIEW_C3 F2)"
        )
    # "noun" is a common English word that might legitimately appear in the
    # field-name list ("part_of_speech") but not as a value; check explicitly.
    assert '"noun"' not in prompt_text, (
        "Audited POS value 'noun' leaked into the prompt as a JSON string"
    )

    # The FIELD NAMES should be present (the model needs to know what to
    # extract). This is the post-fix contract.
    for field_name in ("korean", "english", "hanja", "part_of_speech",
                        "audio_track"):
        assert field_name in prompt_text, (
            f"Field name {field_name!r} missing from blind-extraction prompt"
        )
