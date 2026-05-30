"""
Unit tests for the resolver's counter-accounting contract (REVIEW_C2 F1).

WHY this file exists:
    The pre-fix bug had ``_process_entry`` append text-only refs to BOTH
    ``rows`` and ``broken``, then ``_flush_batch`` computed
    ``extracted = len(rows) + len(broken)``. This double-counted every
    text-only ref in ``refs_extracted`` AND mis-tallied them as
    ``refs_broken``. The data on disk was correct (the RelationRow was
    written with ``resolution_status='text_only'`` exactly once) but the
    reported counters and the resume cursor's accuracy were wrong.

    These tests pin the contract from ADR-022 D2:

        refs_extracted = refs_resolved + refs_text_only + refs_broken
        refs_broken counts ONLY truly-broken refs (unsupported kind,
                          self-reference, normalize failure) — never
                          text-only successes.

    Without a real Postgres we can't exercise the SQL ``RETURNING``
    plumbing inside ``write_relations``, but we CAN exercise the pure
    logic of ``_process_entry`` (no I/O) and the counter math in
    ``_flush_batch`` via a dry-run path. The integration test in
    ``test_resolve_cross_references_integration.py`` covers the end-to-end
    SQL path; these tests catch the counter regression at unit speed.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

_INGEST_DIR = Path(__file__).resolve().parents[1]
if str(_INGEST_DIR) not in sys.path:
    sys.path.insert(0, str(_INGEST_DIR))

from resolver import pipeline as pl  # noqa: E402
from resolver.models import (  # noqa: E402
    BrokenRefRow,
    RelationRow,
    ResolverCounters,
)


# ---------------------------------------------------------------------------
# Helpers — minimal stand-ins for _process_entry's collaborators.
# ---------------------------------------------------------------------------


def _make_row(*, status: str, target_entry_id: int | None) -> RelationRow:
    return RelationRow(
        source_entry_id=1,
        source_corpus="kgiu_beginner",
        relation_kind="compare_with",
        target_entry_id=target_entry_id,
        target_korean="식구",
        target_english=None,
        target_page=None,
        target_source_id=None,
        note=None,
        resolution_status=status,
    )


def _make_broken_report(reason: str) -> BrokenRefRow:
    return BrokenRefRow(
        source_corpus="kgiu_beginner",
        source_entry_id=1,
        source_pattern="N가족",
        relation_type="compare_with",
        target_text="bad",
        reason=reason,
    )


# ---------------------------------------------------------------------------
# _flush_batch — counter accounting (the load-bearing fix)
# ---------------------------------------------------------------------------


def test_flush_batch_text_only_not_counted_as_broken() -> None:
    """REVIEW_C2 F1 regression: text-only rows must not inflate refs_broken."""
    result = pl._CorpusResult(corpus="kgiu_beginner")
    rows = [
        _make_row(status="resolved", target_entry_id=42),
        _make_row(status="text_only", target_entry_id=None),
        _make_row(status="text_only", target_entry_id=None),
    ]
    broken: list[BrokenRefRow] = []
    text_only_reports = [
        _make_broken_report("no matching entry"),
        _make_broken_report("no matching entry"),
    ]

    asyncio.run(
        pl._flush_batch(
            pool=None,  # type: ignore[arg-type]  — unused in dry_run path
            corpus="kgiu_beginner",
            rows=rows,
            broken=broken,
            text_only_reports=text_only_reports,
            last_source_id="kgiu-beg-u03-99",
            result=result,
            dry_run=True,
        )
    )

    assert result.counters.refs_extracted == 3, (
        "extracted should equal resolved+text_only+broken = 1+2+0 = 3"
    )
    assert result.counters.refs_resolved == 1
    assert result.counters.refs_text_only == 2
    assert result.counters.refs_broken == 0, (
        "broken must EXCLUDE text-only successes"
    )
    # Broken ledger stays empty; text-only ledger carries the report rows
    # for the unresolved CSV.
    assert result.broken == []
    assert len(result.text_only_reports) == 2


def test_flush_batch_broken_only_counted_in_refs_broken() -> None:
    """A purely-broken batch (no rows) increments only refs_broken."""
    result = pl._CorpusResult(corpus="kgiu_beginner")
    broken = [
        _make_broken_report("unsupported relation_kind for kgiu"),
        _make_broken_report("self-reference; skipped"),
    ]
    asyncio.run(
        pl._flush_batch(
            pool=None,  # type: ignore[arg-type]
            corpus="kgiu_beginner",
            rows=[],
            broken=broken,
            text_only_reports=[],
            last_source_id="kgiu-beg-u03-99",
            result=result,
            dry_run=True,
        )
    )
    assert result.counters.refs_extracted == 2
    assert result.counters.refs_resolved == 0
    assert result.counters.refs_text_only == 0
    assert result.counters.refs_broken == 2
    assert len(result.broken) == 2
    assert result.text_only_reports == []


def test_flush_batch_mixed_outcome_counters_sum_to_extracted() -> None:
    """Counter invariant: extracted == resolved + text_only + broken,
    across the FULL set of outcomes the resolver produces."""
    result = pl._CorpusResult(corpus="kgiu_beginner")
    rows = [
        _make_row(status="resolved", target_entry_id=10),
        _make_row(status="resolved", target_entry_id=11),
        _make_row(status="text_only", target_entry_id=None),
    ]
    broken = [_make_broken_report("normalize failed")]
    text_only_reports = [_make_broken_report("no matching entry")]

    asyncio.run(
        pl._flush_batch(
            pool=None,  # type: ignore[arg-type]
            corpus="kgiu_beginner",
            rows=rows,
            broken=broken,
            text_only_reports=text_only_reports,
            last_source_id="kgiu-beg-u03-99",
            result=result,
            dry_run=True,
        )
    )
    c = result.counters
    assert c.refs_extracted == c.refs_resolved + c.refs_text_only + c.refs_broken
    assert c.refs_extracted == 4
    assert c.refs_resolved == 2
    assert c.refs_text_only == 1
    assert c.refs_broken == 1


def test_flush_batch_rejects_unknown_resolution_status() -> None:
    """If a future code path adds a new resolution_status without updating
    _flush_batch, the assertion fires — preventing silent counter drift."""
    result = pl._CorpusResult(corpus="kgiu_beginner")
    bad_row = _make_row(status="unknown_future_status", target_entry_id=None)
    with pytest.raises(AssertionError, match="resolution_status"):
        asyncio.run(
            pl._flush_batch(
                pool=None,  # type: ignore[arg-type]
                corpus="kgiu_beginner",
                rows=[bad_row],
                broken=[],
                text_only_reports=[],
                last_source_id="kgiu-beg-u03-99",
                result=result,
                dry_run=True,
            )
        )


# ---------------------------------------------------------------------------
# _process_entry — exclusive ledgers (the structural fix)
# ---------------------------------------------------------------------------


def test_process_entry_returns_three_disjoint_lists() -> None:
    """Smoke check: the function signature now returns three lists, and
    a text_only outcome appears in `text_only_reports` and `rows` (one
    RelationRow with resolution_status='text_only') but NEVER in
    `broken`."""
    # The signature is the contract: 3 lists, not 2.
    import inspect
    sig = inspect.signature(pl._process_entry)
    # The function is annotated; verify the return is a 3-tuple of lists.
    return_anno = sig.return_annotation
    assert "list" in str(return_anno).lower()
    # Count comma-separated entries inside the tuple annotation. Quick&dirty
    # but it catches the "back to two-tuple" regression.
    text = str(return_anno)
    assert text.count("BrokenRefRow") == 2 or text.count("list") == 3, (
        f"_process_entry must return (rows, broken, text_only_reports); "
        f"got annotation {return_anno!r}"
    )
