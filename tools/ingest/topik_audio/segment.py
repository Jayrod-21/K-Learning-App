"""PURE alignment core: timestamped transcript -> per-question audio spans.

No GPU, no DB, no network, no filesystem — everything here is unit-testable
with synthetic transcripts. This is the productionized form of the Phase-2a
proof (``align5.py``), which was validated on two real papers (50/50 and
30/30 anchor coverage); its behavior is reproduced faithfully:

  * ANCHORS — each question is announced by number in the audio. A transcript
    segment whose text STARTS with either a single ``N번`` or a paired
    ``N번, M번`` (M = N+1) announcement is an anchor. Segments that open with
    a range instruction (``N번부터/까지 ...``) or carry ``정답`` ("the answer
    is ...") near their head are never anchors — they quote numbers without
    starting a question. The exclusion is deliberately NARROW: a mid-passage
    ``부터``/``정답`` (e.g. "2번 서울역부터 ...") must not demote a clean
    anchor into the fallback path. Anchors must be MONOTONIC by start number
    (strictly greater than the last accepted anchor's highest number), so a
    garbled or stray low number never derails the rest of the paper.
  * SPANS are FORMAT-AWARE — singles and pairs use OPPOSITE audio ordering
    (verified against the real 60th TOPIK II and 35th TOPIK I recordings):
      - SINGLE question: marker FIRST, passage after. Span =
        ``[marker, next boundary)``; a trailing single runs to
        ``duration_ms``.
      - PAIRED question: the shared passage plays FIRST, the marker(s)
        AFTER it (announcing which questions the just-played passage
        answers). TOPIK II speaks ONE paired ``N번, M번`` marker and moves
        straight on, so the span is the region between markers and ends AT
        the pair's own marker (the audio after the LAST pair's marker is
        the outro — excluded). TOPIK I instead announces each member singly
        (``25번`` ... ``26번``) and reads the answer options aloud after
        each, so the span runs from the passage start to the NEXT unit's
        boundary (last pair -> duration).
      - The pair's passage START is content-located: its validation text is
        aligned against the word timeline between the previous unit's last
        marker and the pair's first marker (:func:`_locate_text_start`); the
        preceding unit ENDS there. When the match fails, the span falls back
        to the previous marker (overlapping/padded — safe) and is
        force-flagged ``low_confidence`` — EXCEPT a TOPIK-II pair preceded
        by another paired marker, where the between-markers region is exact
        by construction and needs no flag.
    A paired unit always yields ONE span shared by both items.
  * FALLBACK — a question whose announcement Whisper garbled is recovered by
    fuzzy-matching its validation text (official transcript when available,
    else the DB stem) against the word stream inside the surrounding gap.
  * CONFIDENCE — every resolved span is scored by RECALL: the best fuzzy
    ratio of the validation text vs a target-sized window INSIDE the span
    (robust to twice-read passages and announcement padding — see
    :func:`_span_confidence`). Spans under ``min_confidence`` are FLAGGED
    (``low_confidence: true``), never dropped — the Phase-3 loader /
    operator decides what to do with them.

Units (single vs paired) come from the caller — derived from the DB's
``instruction_group`` via :func:`derive_units` — so pairing is enforced even
when the audio announces a pair as two single numbers: the unit's span is
then the union of both windows, which both items share. The OPPOSITE
mismatch — the audio speaking one combined ``N번, M번`` marker over two
DB-single units — merges those units into a de-facto pair sharing one span
(:func:`_merge_combined_single_units`); leaving them single would emit a
degenerate ``end_ms == start_ms`` window.

FINAL INVARIANT GATE — after everything above, :func:`align` runs
:func:`_enforce_span_invariants` over the emitted segments: every span must
satisfy ``start_ms >= 0`` and ``end_ms > start_ms`` (migration 078's
``ck_topik_items_audio_span``), and two overlapping spans are legal only
when at least one is flagged ``low_confidence`` (the documented padded
fallback). A geometry violation is dropped to ``unresolved_items`` —
reported, never emitted invalid; an unflagged overlap flags both sides.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, field, replace
from typing import Iterable, Mapping, Sequence, TypedDict

# Bumped whenever alignment behavior changes — recorded in every emitted
# artifact so the loader (and a human reading `extra.audio_seg`) can tell
# which aligner produced a span.
ALIGNER_VERSION = "1.0.0"

# Fallback acceptance floor from the Phase-2a proof: a fuzzy match of the
# validation text against the gap's word stream below this is noise, not a
# recovered anchor (align5.py's `best[0] > 0.30`).
FALLBACK_ACCEPT_RATIO = 0.30

# Default confidence gate. Decision §12.5 says the threshold is tuned during
# the real-audio phases; 0.50 matches the Phase-2a proof's QA line
# ("stem~span >= 0.50"). The CLI exposes ``--min-confidence`` to retune it
# without touching code.
DEFAULT_MIN_CONFIDENCE = 0.50

# When locating where a passage STARTS, prefer the EARLIEST window scoring
# within this fraction of the best match: TOPIK passages are read TWICE, and
# both readings match near-equally — argmax alone can land on the second
# reading and silently halve the span (seen on the real 60th II, Q21-22).
# TIGHT on purpose: a looser fraction lets a window a few junk words EARLY
# tie the real start and eat the tail of the PRECEDING question's audio —
# losing the pair's first reading (it still has the second, complete) is
# strictly better than losing the neighboring single's real content.
_NEAR_BEST_FRACTION = 0.95

# Floor on the located window's size, in normalized chars (~6 words — the
# Phase-2a prototype's minimum run): a very short validation stem must not
# shrink the comparison window into spurious two-word matches.
_MIN_LOCATE_CHARS = 18

# A spoken question-number announcement as a lone (normalized) word. These
# are dropped from the LOCATION timeline: validation texts never contain
# them, and a run of them ("26번 27번, 28번...") ahead of a passage otherwise
# lets a junk-prefixed window at the region's start tie the real match
# (seen on the real 35th I, Q27-28 / Q29-30).
_MARKER_TOKEN_RE = re.compile(r"^\d{1,2}번$")

# Paired announcement: "21번, 22번 ..." / "21번 22번 ..." — only accepted when
# the second number is exactly first+1 (M = N+1), the only pairing TOPIK uses.
_PAIRED_ANCHOR_RE = re.compile(r"^(\d{1,2})\s*번\s*,?\s*(\d{1,2})\s*번")

# Single announcement: "7번 ..." — the lookahead rejects "번째" (ordinal) and
# "번씩" ("N times each"), which start sentences without announcing a question.
_SINGLE_ANCHOR_RE = re.compile(r"^(\d{1,2})\s*번(?!째|씩)")

# A range instruction quoting question numbers without starting a question:
# the leading number is DIRECTLY followed by 부터/까지 ("21번부터 22번까지
# 잘 들으십시오"; Whisper may also split off "22번까지 ..."). Only the
# marker-adjacent form disqualifies — a passage that merely CONTAINS 부터
# ("2번 서울역부터 ...") is a clean anchor and must stay one.
_ANCHOR_EXCLUDE_RANGE_RE = re.compile(
    r"^\s*\d{1,2}\s*번\s*(?:,\s*\d{1,2}\s*번\s*)?(?:부터|까지)"
)
# "정답" disqualifies only when it sits near the segment HEAD (an answer
# readout whose leading number would otherwise anchor, e.g. "3번입니다.
# 정답은 ..."); deep in a passage it is ordinary content.
_ANCHOR_EXCLUDE_ANSWER_HEAD_CHARS = 12

# Characters stripped before fuzzy comparison — whitespace, punctuation the
# announcer never speaks, and the literal "보기" (the printed example marker).
_NORM_RE = re.compile(r"[\s_.,?!'\"·…∼~\-—:;()<>]|보기")

# A dialogue speaker label inside a stem ("여자: ...", "남자 : ..."). Its
# PRESENCE means the item carries its OWN spoken passage — a 2-item
# instruction_group of such items (e.g. 35th I, "5-6") is two individually
# announced singles sharing only a printed instruction, NOT a
# shared-passage pair. True pairs' stems are question prompts
# ("...고르십시오.") with no dialogue.
_DIALOGUE_SPEAKER_RE = re.compile(r"(?:여자|남자|여학생|남학생)\s*:")


class Unit(TypedDict):
    """One announced question unit: a single item or a consecutive pair."""

    item_numbers: list[int]


class Segment(TypedDict):
    """One aligned audio window — the per-paper artifact's payload row."""

    item_numbers: list[int]
    start_ms: int
    end_ms: int
    confidence: float
    marker: str
    low_confidence: bool


@dataclass(frozen=True)
class _Anchor:
    numbers: tuple[int, ...]
    start_ms: int
    marker: str


@dataclass(frozen=True)
class _Covered:
    """A resolved window for one item number."""

    start_ms: int
    end_ms: int
    marker: str
    via_fallback: bool
    # An unresolvable single->pair transition split — the span is the whole
    # (overlapping) region and must be flagged regardless of its confidence.
    forced_low: bool = False


@dataclass(frozen=True)
class AlignResult:
    """Alignment outcome: the emitted segments plus QA bookkeeping."""

    segments: list[Segment]
    # Item numbers no anchor or fallback could place (their unit emitted no
    # segment). Reported, never guessed.
    unresolved_items: list[int] = field(default_factory=list)
    # Items placed by a clean spoken announcement vs recovered by the
    # validation-text fallback — the QA report's headline split.
    clean_anchor_items: list[int] = field(default_factory=list)
    fallback_items: list[int] = field(default_factory=list)


def normalize_korean(text: str | None) -> str:
    """Collapse text to the announcer-spoken core for fuzzy comparison."""
    return _NORM_RE.sub("", text or "")


def derive_units(items: Sequence[Mapping[str, object]]) -> list[Unit]:
    """Derive announced units from the paper's ordered question structure.

    ``items`` are dicts with ``number`` (int), ``instruction_group``
    (str | None) and optionally ``stem`` — exactly what the DB query /
    structure file provides.

    Pairing rule: a contiguous ``instruction_group`` containing EXACTLY two
    consecutive item numbers (e.g. ``"21-22"`` holding items 21 and 22) is
    one paired unit sharing one audio span — UNLESS either stem contains a
    dialogue speaker label (``여자:``/``남자:``): such items carry their own
    spoken passage and are individually announced singles that merely share
    a printed instruction (e.g. 35th TOPIK I's "5-6"). Larger groups
    (``"1-3"``, ``"4-8"``) and ungrouped items are single units.
    """
    numbers = [int(item["number"]) for item in items]  # type: ignore[arg-type]
    if not numbers:
        raise ValueError("derive_units: empty item list")
    if any(b <= a for a, b in zip(numbers, numbers[1:])):
        raise ValueError(
            f"derive_units: item numbers must be strictly increasing, got {numbers}"
        )

    units: list[Unit] = []
    i = 0
    while i < len(items):
        group = items[i].get("instruction_group")
        run = [int(items[i]["number"])]  # type: ignore[arg-type]
        j = i + 1
        while j < len(items) and group is not None and items[j].get("instruction_group") == group:
            run.append(int(items[j]["number"]))  # type: ignore[arg-type]
            j += 1
        own_dialogue = any(
            _DIALOGUE_SPEAKER_RE.search(str(items[k].get("stem") or ""))
            for k in range(i, j)
        )
        if len(run) == 2 and run[1] == run[0] + 1 and not own_dialogue:
            units.append({"item_numbers": run})
        else:
            units.extend({"item_numbers": [n]} for n in run)
        i = j
    return units


def _validate_transcript(transcript: Mapping[str, object]) -> tuple[int, list[dict]]:
    """Shape-check the transcript up front — a malformed segment must fail
    loudly HERE, not as a silent KeyError / inverted span mid-alignment."""
    duration_ms = transcript.get("duration_ms")
    segments = transcript.get("segments")
    if not isinstance(duration_ms, int) or duration_ms <= 0:
        raise ValueError(f"transcript.duration_ms must be a positive int, got {duration_ms!r}")
    if not isinstance(segments, list):
        raise ValueError("transcript.segments must be a list")
    prev_start = -1
    for i, seg in enumerate(segments):
        if not isinstance(seg, dict):
            raise ValueError(f"transcript.segments[{i}] must be a dict, got {type(seg).__name__}")
        start = seg.get("s")
        if not isinstance(start, int) or start < 0:
            raise ValueError(
                f"transcript.segments[{i}].s must be a non-negative int ms, got {start!r}"
            )
        if start < prev_start:
            raise ValueError(
                f"transcript.segments[{i}] breaks time order ({start} < {prev_start})"
            )
        prev_start = start
        if not isinstance(seg.get("words"), list):
            raise ValueError(f"transcript.segments[{i}].words must be a list (may be empty)")
    return duration_ms, segments


def _validate_units(units: Sequence[Unit]) -> list[int]:
    """Check unit shape/order; return the flat, ordered item-number list."""
    if not units:
        raise ValueError("align: units must be non-empty")
    flat: list[int] = []
    for unit in units:
        nums = unit["item_numbers"]
        if len(nums) not in (1, 2):
            raise ValueError(f"align: a unit holds 1 or 2 items, got {nums}")
        if len(nums) == 2 and nums[1] != nums[0] + 1:
            raise ValueError(f"align: paired items must be consecutive, got {nums}")
        flat.extend(nums)
    if any(b <= a for a, b in zip(flat, flat[1:])):
        raise ValueError(f"align: unit item numbers must be strictly increasing, got {flat}")
    return flat


def _is_answer_or_range_text(text: str) -> bool:
    """True when the segment quotes question numbers without starting one —
    a leading range instruction or a head-adjacent answer readout."""
    if _ANCHOR_EXCLUDE_RANGE_RE.match(text):
        return True
    return "정답" in text[:_ANCHOR_EXCLUDE_ANSWER_HEAD_CHARS]


def _find_anchors(segments: Iterable[Mapping[str, object]], max_item: int) -> list[_Anchor]:
    """Scan transcript segments for monotonic question announcements."""
    anchors: list[_Anchor] = []
    last = 0
    for seg in segments:
        text = str(seg.get("text") or "").strip()
        if _is_answer_or_range_text(text):
            continue
        paired = _PAIRED_ANCHOR_RE.match(text)
        single = _SINGLE_ANCHOR_RE.match(text)
        if paired and int(paired.group(2)) == int(paired.group(1)) + 1:
            a, b = int(paired.group(1)), int(paired.group(2))
            if a > last and b <= max_item:
                anchors.append(_Anchor((a, b), int(seg["s"]), f"{a}번, {b}번"))  # type: ignore[arg-type]
                last = b
        elif single:
            n = int(single.group(1))
            if n > last and n <= max_item:
                anchors.append(_Anchor((n,), int(seg["s"]), f"{n}번"))  # type: ignore[arg-type]
                last = n
    return anchors


def _span_text(segments: Iterable[Mapping[str, object]], start_ms: int, end_ms: int) -> str:
    """Concatenated transcript text of segments starting inside the window."""
    return " ".join(
        str(seg.get("text") or "")
        for seg in segments
        if start_ms <= int(seg["s"]) < end_ms  # type: ignore[arg-type]
    )


def _extract_words(segments: Iterable[Mapping[str, object]]) -> list[tuple[int, str]]:
    """Flatten the transcript's word-level timeline to (start_ms, word)."""
    return [
        (int(w["s"]), str(w["w"]))  # type: ignore[index]
        for seg in segments
        for w in seg.get("words") or []  # type: ignore[union-attr]
    ]


def _locate_text_start(
    words: Sequence[tuple[int, str]], lo: int, hi: int, target: str
) -> tuple[float, int | None]:
    """Fuzzy position of NORMALIZED ``target``'s start inside ``[lo, hi)``.

    Slides a TARGET-SIZED window over the word stream (words accumulated
    until the candidate reaches the target's length — the same construction
    as :func:`_span_confidence`, so a candidate aligned with the content
    scores near 1.0 instead of being diluted by trailing words). Returns
    (best ratio, start_ms of the EARLIEST near-best window) — earliest, not
    argmax, because a twice-read passage matches at both readings and the
    span must start at the FIRST (see _NEAR_BEST_FRACTION). The caller
    applies its acceptance floor to the returned ratio.
    """
    window = [
        (ts, tok)
        for ts, w in words
        if lo <= ts < hi
        and (tok := normalize_korean(w))
        and not _MARKER_TOKEN_RE.match(tok)
    ]
    if not window or not target:
        return 0.0, None
    need = max(len(target), _MIN_LOCATE_CHARS)
    scored: list[tuple[int, float]] = []
    best_ratio = 0.0
    for i in range(len(window)):
        parts: list[str] = []
        length = 0
        j = i
        while j < len(window) and length < need:
            parts.append(window[j][1])
            length += len(window[j][1])
            j += 1
        ratio = difflib.SequenceMatcher(None, target, "".join(parts)).ratio()
        scored.append((window[i][0], ratio))
        if ratio > best_ratio:
            best_ratio = ratio
    threshold = max(FALLBACK_ACCEPT_RATIO, _NEAR_BEST_FRACTION * best_ratio)
    for i, (_ts, ratio) in enumerate(scored):
        if ratio >= threshold:
            # Shed junk prefixes: each stray word ahead of the real content
            # only LOWERS the ratio, so walking forward while the ratio is
            # non-decreasing lands exactly on the content start — without
            # ever skipping a true passage start (the ratio drops
            # immediately once real content is dropped, e.g. past the first
            # of two readings).
            while i + 1 < len(scored) and scored[i + 1][1] >= scored[i][1]:
                i += 1
            return best_ratio, scored[i][0]
    return best_ratio, None


def _span_confidence(
    words: Sequence[tuple[int, str]],
    start_ms: int,
    end_ms: int,
    target: str,
    span_text: str,
) -> float:
    """RECALL of the validation ``target`` inside the span: the best fuzzy
    ratio of the target vs a target-SIZED word window within the span.

    Whole-span ratio systematically under-scores correct spans — TOPIK reads
    paired passages TWICE and every span carries announcement padding, so a
    perfectly-mapped pair peaked at ~0.65 on the real 60th II. Recall asks
    the right question for the gate ("is this passage IN this window?"):
    a mis-mapped span still scores near zero, a correct padded/twice-read
    one scores like a single. Falls back to the whole-span text ratio when
    the transcript has no word timestamps.
    """
    tokens = [normalize_korean(w) for ts, w in words if start_ms <= ts < end_ms]
    tokens = [t for t in tokens if t]
    if not tokens:
        return difflib.SequenceMatcher(
            None, target, normalize_korean(span_text)
        ).ratio()
    best = 0.0
    for i in range(len(tokens)):
        parts: list[str] = []
        length = 0
        j = i
        while j < len(tokens) and length < len(target):
            parts.append(tokens[j])
            length += len(tokens[j])
            j += 1
        ratio = difflib.SequenceMatcher(None, target, "".join(parts)).ratio()
        if ratio > best:
            best = ratio
            if best > 0.98:  # cannot meaningfully improve — stop scanning
                break
    return best


def _trim_preceding(covered: dict[int, _Covered], k: int, boundary_ms: int) -> None:
    """Trim the nearest preceding window to end where a recovery starts.

    Without this, the preceding item's ``end_ms`` (finalized before recovery
    ran) still reaches the NEXT anchor, so the recovered span nests inside it
    UNFLAGGED — the preceding clip plays the recovered question's audio. All
    unit members sharing the nearest window (a pair) are trimmed together so
    the pair union stays consistent; a window that cannot be trimmed safely
    (the boundary at/before its start would leave ``end <= start``) is
    force-flagged ``low_confidence`` instead — visible, never silent.
    """
    prior = {j: c for j, c in covered.items() if j < k}
    if not prior:
        return
    nearest_start = max(c.start_ms for c in prior.values())
    for j, c in prior.items():
        if c.start_ms != nearest_start or c.end_ms <= boundary_ms:
            continue
        if boundary_ms > c.start_ms:
            covered[j] = replace(c, end_ms=boundary_ms)
        else:
            covered[j] = replace(c, forced_low=True)


def _recover_gaps(
    covered: dict[int, _Covered],
    missing: Sequence[int],
    words: Sequence[tuple[int, str]],
    duration_ms: int,
    validation_texts: Mapping[int, str],
) -> None:
    """Fallback: place anchor-less items by fuzzy-matching their validation
    text against the word stream inside the surrounding resolved gap.

    Mutates ``covered`` in place; ascending order so an earlier recovery
    tightens the next one's search window (align5.py's exact behavior). Each
    accepted recovery trims the nearest preceding window to end at the
    recovered start (:func:`_trim_preceding`).
    """

    def prev_start(k: int) -> int:
        starts = [covered[j].start_ms for j in covered if j < k]
        return max(starts) if starts else 0

    def next_start(k: int) -> int:
        starts = [covered[j].start_ms for j in covered if j > k]
        return min(starts) if starts else duration_ms

    for k in missing:
        target = normalize_korean(validation_texts.get(k, ""))
        if not target:
            continue  # nothing to match against — stays unresolved, reported
        best_ratio, best_ts = _locate_text_start(words, prev_start(k), next_start(k), target)
        if best_ts is not None and best_ratio > FALLBACK_ACCEPT_RATIO:
            end_ms = next_start(k)
            _trim_preceding(covered, k, best_ts)
            covered[k] = _Covered(best_ts, end_ms, f"stem:{k}", via_fallback=True)


@dataclass
class _UnitPlacement:
    """Working state for one anchor-resolved unit's span computation."""

    unit_index: int
    first_anchor_ms: int
    marker: str
    is_pair: bool
    # The pair was announced with ONE combined "N번, M번" marker (TOPIK II
    # format) — its span ends at that marker. TOPIK-I-format pairs (members
    # announced singly, options read aloud after) end at the next boundary.
    paired_anchor_ms: int | None
    start_ms: int = 0
    end_ms: int = 0
    # Passage start confirmed by content location (drives neighbor trims).
    located: bool = False
    forced_low: bool = False


def _place_units(
    units: Sequence[Unit],
    anchors: Sequence[_Anchor],
    duration_ms: int,
    words: Sequence[tuple[int, str]],
    validation: Mapping[int, str],
) -> list[_UnitPlacement]:
    """Format-aware span per anchor-resolved unit (see the module docstring).

    Forward pass sets STARTS: singles start at their marker; pairs start at
    their content-located passage start inside (previous unit's last marker,
    own first marker], falling back to the previous marker (force-flagged,
    except the exact-by-construction TOPIK-II pair-after-pair case).
    Backward-looking second pass sets ENDS: a combined-marker pair ends at
    its own marker; everything else ends at the NEXT unit's start — which
    for a located pair is its passage start, trimming the preceding unit —
    and the last unit ends at ``duration_ms``.
    """
    number_to_unit = {n: i for i, unit in enumerate(units) for n in unit["item_numbers"]}
    unit_anchors: dict[int, list[_Anchor]] = {}
    for anchor in anchors:
        for idx in {number_to_unit.get(n) for n in anchor.numbers} - {None}:
            unit_anchors.setdefault(idx, []).append(anchor)

    placements: list[_UnitPlacement] = []
    prev_last_anchor_ms = 0
    prev_was_combined_pair = False
    for idx in sorted(unit_anchors):
        ancs = sorted(unit_anchors[idx], key=lambda a: a.start_ms)
        is_pair = len(units[idx]["item_numbers"]) == 2
        combined = next((a for a in ancs if len(a.numbers) == 2), None)
        placement = _UnitPlacement(
            unit_index=idx,
            first_anchor_ms=ancs[0].start_ms,
            marker=", ".join(a.marker for a in ancs),
            is_pair=is_pair,
            paired_anchor_ms=combined.start_ms if combined and is_pair else None,
        )
        if is_pair and placement.paired_anchor_ms is not None and prev_was_combined_pair:
            # Combined-marker pair straight after another combined-marker
            # pair: the between-markers region IS the passage — exact by
            # construction (the coordinator-verified TOPIK II rule). No
            # content location, no flag.
            placement.start_ms = prev_last_anchor_ms
        elif is_pair:
            numbers = units[idx]["item_numbers"]
            target = next(
                (
                    normalize_korean(validation.get(n, ""))
                    for n in numbers
                    if normalize_korean(validation.get(n, ""))
                ),
                "",
            )
            best_ratio, best_ts = (
                _locate_text_start(words, prev_last_anchor_ms, placement.first_anchor_ms, target)
                if target
                else (0.0, None)
            )
            # ``> prev_last_anchor_ms`` keeps the preceding unit from being
            # trimmed to an empty span on a degenerate region-start match.
            if (
                best_ts is not None
                and best_ratio > FALLBACK_ACCEPT_RATIO
                and best_ts > prev_last_anchor_ms
            ):
                placement.start_ms = best_ts
                placement.located = True
            else:
                # No marker bounds this passage start and content couldn't
                # place it: keep the whole region (padded, safe) and flag.
                placement.start_ms = prev_last_anchor_ms
                placement.forced_low = True
        else:
            placement.start_ms = placement.first_anchor_ms
        placements.append(placement)
        prev_last_anchor_ms = ancs[-1].start_ms
        prev_was_combined_pair = placement.paired_anchor_ms is not None

    for pos, placement in enumerate(placements):
        if placement.paired_anchor_ms is not None:
            # Combined-marker pair: passage precedes the marker; what follows
            # is the next unit's audio (or the outro, for the last pair).
            placement.end_ms = placement.paired_anchor_ms
            continue
        nxt = placements[pos + 1] if pos + 1 < len(placements) else None
        if nxt is None:
            placement.end_ms = duration_ms
        elif nxt.located:
            placement.end_ms = nxt.start_ms
        else:
            placement.end_ms = nxt.first_anchor_ms
    return placements


def _merge_combined_single_units(
    units: Sequence[Unit], anchors: Sequence[_Anchor]
) -> list[Unit]:
    """Merge two SINGLE units the audio announced with ONE combined
    ``N번, M번`` marker into a de-facto paired unit sharing one span.

    The structure says single (a real TOPIK II pair with a NULL/odd
    ``instruction_group``, or a dialogue-heuristic demotion) but the
    recording treats the two as a shared-passage pair. Kept single, both
    units would start at the same marker and unit N's ``end_ms`` would land
    on that SAME timestamp — a degenerate ``end == start`` span that
    violates migration 078's ``ck_topik_items_audio_span``. Merging applies
    the normal paired-span rules (passage before marker, span ends AT the
    marker) to one shared window instead.
    """
    number_to_unit = {n: i for i, unit in enumerate(units) for n in unit["item_numbers"]}
    merge_second: set[int] = set()
    for anchor in anchors:
        if len(anchor.numbers) != 2:
            continue
        a, b = anchor.numbers
        ia, ib = number_to_unit.get(a), number_to_unit.get(b)
        if (
            ia is not None
            and ib == ia + 1  # adjacent units (False when ib is None)
            and units[ia]["item_numbers"] == [a]
            and units[ib]["item_numbers"] == [b]
        ):
            merge_second.add(ib)
    if not merge_second:
        return list(units)
    merged: list[Unit] = []
    for i, unit in enumerate(units):
        if i in merge_second:
            merged[-1] = {"item_numbers": merged[-1]["item_numbers"] + unit["item_numbers"]}
        else:
            merged.append(dict(unit))
    return merged


def _enforce_span_invariants(
    segments: list[Segment],
    unresolved: list[int],
    clean: list[int],
    fallback: list[int],
) -> list[Segment]:
    """FINAL structural gate — nothing invalid ever reaches the artifact.

    * Geometry: every span must satisfy ``start_ms >= 0`` and
      ``end_ms > start_ms`` (migration 078's ``ck_topik_items_audio_span``).
      A violating segment is moved to ``unresolved_items`` (and out of the
      clean/fallback QA lists) — reported, never emitted invalid.
    * Overlap policy: two overlapping spans are legal ONLY when at least one
      side is flagged ``low_confidence`` (the documented padded-transition /
      recovery fallback, where keeping overlapping audio is safer than
      guessing a boundary). An unflagged overlap flags BOTH sides — the
      audio is preserved, the operator is warned.

    Mutates ``unresolved``/``clean``/``fallback`` and the surviving
    segments' flags in place; returns the surviving segment list.
    """
    valid: list[Segment] = []
    for seg in segments:
        if seg["start_ms"] < 0 or seg["end_ms"] <= seg["start_ms"]:
            unresolved.extend(seg["item_numbers"])
            for n in seg["item_numbers"]:
                if n in clean:
                    clean.remove(n)
                if n in fallback:
                    fallback.remove(n)
            continue
        valid.append(seg)
    for i, a in enumerate(valid):
        for b in valid[i + 1 :]:
            overlapping = a["start_ms"] < b["end_ms"] and b["start_ms"] < a["end_ms"]
            if overlapping and not a["low_confidence"] and not b["low_confidence"]:
                a["low_confidence"] = True
                b["low_confidence"] = True
    return valid


def align(
    transcript: Mapping[str, object],
    units: Sequence[Unit],
    validation_texts: Mapping[int, str] | None = None,
    *,
    min_confidence: float = DEFAULT_MIN_CONFIDENCE,
) -> AlignResult:
    """Align a paper's transcript to its question units.

    Args:
        transcript: ``{duration_ms, segments: [{n, s, e, text, words}]}`` —
            the shape :func:`tools.ingest.topik_audio.transcribe.transcribe_paper`
            produces.
        units: ordered single/paired question units (:func:`derive_units`).
        validation_texts: per-item spoken-text ground truth — the official
            transcript PDF's text when available, else the DB stem. Drives
            BOTH gap recovery and confidence scoring; ``None``/missing items
            simply score 0.0 and cannot be gap-recovered.
        min_confidence: segments scoring below this are flagged
            ``low_confidence`` — flagged, never dropped.

    Returns:
        :class:`AlignResult` — one segment per resolved unit (paired items
        share one segment), plus unresolved/QA bookkeeping. Every returned
        segment is guaranteed valid by :func:`_enforce_span_invariants`:
        ``start_ms >= 0``, ``end_ms > start_ms``, and any overlap carries a
        ``low_confidence`` flag on at least one side.
    """
    duration_ms, segments = _validate_transcript(transcript)
    flat_items = _validate_units(units)
    validation = dict(validation_texts or {})

    anchors = _find_anchors(segments, max_item=flat_items[-1])
    # The audio's announcements outrank the structure's single/pair guess: a
    # combined marker over two single units makes them a de-facto pair.
    units = _merge_combined_single_units(units, anchors)
    words = _extract_words(segments)
    placements = _place_units(units, anchors, duration_ms, words, validation)

    covered: dict[int, _Covered] = {}
    for placement in placements:
        # Unit-level coverage: a pair with even ONE announced member shares
        # the unit's span across both items.
        for n in units[placement.unit_index]["item_numbers"]:
            covered[n] = _Covered(
                placement.start_ms,
                placement.end_ms,
                placement.marker,
                via_fallback=False,
                forced_low=placement.forced_low,
            )

    missing = [n for n in flat_items if n not in covered]
    _recover_gaps(covered, missing, words, duration_ms, validation)

    result_segments: list[Segment] = []
    unresolved: list[int] = []
    clean: list[int] = []
    fallback: list[int] = []
    for unit in units:
        nums = unit["item_numbers"]
        resolved = [n for n in nums if n in covered]
        if not resolved:
            unresolved.extend(nums)
            continue
        # Paired unit: one shared span. When the audio announced the pair as
        # one anchor both windows are identical; when it (unexpectedly) used
        # two singles, the UNION covers both passages — safe for a shared span.
        start_ms = min(covered[n].start_ms for n in resolved)
        end_ms = max(covered[n].end_ms for n in resolved)
        marker = covered[resolved[0]].marker
        span = _span_text(segments, start_ms, end_ms)
        confidence = 0.0
        for n in nums:
            target = normalize_korean(validation.get(n, ""))
            if not target:
                continue
            ratio = _span_confidence(words, start_ms, end_ms, target, span)
            confidence = max(confidence, ratio)
        confidence = round(confidence, 4)
        # An unresolvable transition split flags the span regardless of the
        # confidence score — its boundary is known-imprecise.
        forced_low = any(covered[n].forced_low for n in resolved)
        result_segments.append(
            {
                "item_numbers": list(nums),
                "start_ms": start_ms,
                "end_ms": end_ms,
                "confidence": confidence,
                "marker": marker,
                "low_confidence": forced_low or confidence < min_confidence,
            }
        )
        for n in resolved:
            (fallback if covered[n].via_fallback else clean).append(n)

    result_segments = _enforce_span_invariants(result_segments, unresolved, clean, fallback)
    unresolved.sort()

    return AlignResult(
        segments=result_segments,
        unresolved_items=unresolved,
        clean_anchor_items=clean,
        fallback_items=fallback,
    )
