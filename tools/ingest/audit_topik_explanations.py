"""Audit topik_items.extra->>'explanation' against the graded answer key.

Context (SWEEP_data_corpus.md D-3 / FOLLOW_UPS F-UP-013): the ~1,9xx
DB-only, LLM-generated explanations sometimes solve the item incorrectly and
endorse a different option than the one the grader keys. Serving a wrong
explanation is worse than serving none, so this tool scans every enriched row
and ranks likely explanation-vs-key mismatches for human adjudication.

Method (heuristic — Korean/English mixed prose, no ground truth available):
  1. Normalize option texts and the explanation (NFC, strip everything except
     Hangul/Latin/digits) and locate verbatim (or long-prefix/suffix) quotes of
     each option inside the explanation.
  2. Split the explanation into an ENDORSE zone and a DISTRACTOR zone at the
     first distractor marker ("The distractors", "오답", "나머지", ...).
  3. Attach positive cues (correct / the answer / 정답 / directly supports /
     natural reply ...) and negative cues (wrong / unsupported / contradicts /
     아니다 ...) to each quote occurrence within a character window.
  4. Extract explicit ordinal endorsements ("option 2", "세 번째 선택지",
     "②가 정답") and compare them to the key AND to the quoted text.
  5. Verdicts:
       MISMATCH_HIGH   — a non-keyed option is positively endorsed while the
                         keyed option is absent or framed as a distractor, or
                         an explicit ordinal endorsement contradicts the key.
       MISMATCH_MEDIUM — endorsement evidence points away from the key but is
                         weaker (first-quoted heuristic only, or conflicting
                         signals).
       SUSPECT_LOW     — keyed option never quoted while others are (the
                         original sweep heuristic; mostly false positives).
       PLACEHOLDER     — the "explanation" is a SKIPPED/no-source-text note,
                         not an explanation.
       OK / OK_WEAK    — keyed option is the (only) endorsed one.
       UNSCANNABLE     — explanation quotes no option text at all
                         (paraphrase-only); heuristic is blind here.
  6. Risk-class flags (do not change the verdict, raise review priority):
     inversion items (맞지 않는 / 않은 것 / 틀린 것 ...) and
     speaker-attribution listening items (남자/여자가 이어서 할 행동 ...).

Output: JSONL of every audited row's verdict + evidence, and a ranked human-
readable report of everything flagged. This tool never writes to the DB —
fixes are applied as separate, id-scoped SQL after human review.

Usage:
  psql ... -c "COPY (SELECT jsonb_build_object('id', i.id, 'answer', i.answer,
      'instruction', i.instruction, 'stem', i.stem, 'prompt', i.prompt,
      'options', i.options, 'expl', i.extra->>'explanation',
      'section', i.section, 'test', t.test_number, 'level', t.topik_level,
      'n', i.item_number)
    FROM topik_items i JOIN topik_tests t ON t.id = i.topik_test_id
    WHERE i.extra ? 'explanation' ORDER BY i.id) TO STDOUT" > enriched.jsonl
  python audit_topik_explanations.py enriched.jsonl out_dir/
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------- normalization

_KEEP = re.compile(r"[0-9A-Za-z가-힣ㄱ-ㆎ]")


def normalize_with_map(s: str) -> tuple[str, list[int]]:
    """NFC-normalize and strip to Hangul/Latin/digits, keeping an index map
    from each kept char back to its offset in the NFC string."""
    s = unicodedata.normalize("NFC", s)
    out: list[str] = []
    idx: list[int] = []
    for i, ch in enumerate(s):
        if _KEEP.match(ch):
            out.append(ch)
            idx.append(i)
    return "".join(out), idx


def normalize(s: str) -> str:
    return normalize_with_map(s)[0]


# ---------------------------------------------------------------- cue patterns

# Marker that the explanation is switching from the endorsed answer to the
# wrong options. Everything before the first marker is the ENDORSE zone.
DISTRACTOR_MARKER = re.compile(
    r"(the\s+distractors?|distractors?\s*(:|each|all|break|misread|are)"
    r"|the\s+traps?\b|traps?:"
    r"|the\s+other\s+(options?|choices?|answers?|three|statements?)"
    r"|other\s+options?\s*[:(]?|others\s*:"
    r"|wrong\s+(options?|answers?|choices?)"
    r"|나머지|오답|다른\s*선택지)",
    re.IGNORECASE,
)

POSITIVE_CUE = re.compile(
    r"(correct(\s+(answer|statement|choice|option|reply|response))?"
    r"|the\s+answer\b|answer\s+is|best\s+(answer|choice|fit|reply)"
    r"|directly\s+(supports?|answers?|match(es)?|states?|reflects?)"
    r"|\bmatch(es|ing)?\b|\bfits?\b"
    r"|natural\s+(reply|response|answer|continuation)"
    r"|is\s+the\s+(clean|only|one|natural)"
    r"|정답|가\s*답이다|이\s*답이다|맞는\s*(답|것|설명)|일치한다|일치하는)",
    re.IGNORECASE,
)

# Strong subset: unambiguous "this is the answer" language.
STRONG_POSITIVE_CUE = re.compile(
    r"(correct\s+(answer|statement|choice|option)|the\s+answer\s+is"
    r"|answer\s+is|is\s+correct|정답이다|정답이|가\s*정답|이\s*정답|정답:)",
    re.IGNORECASE,
)

NEGATIVE_CUE = re.compile(
    r"(distractor|trap\b|wrong|incorrect|unsupported|contradicts?"
    r"|\bnot\b|\bn't\b|isn't|doesn't|never\b|misreads?|아니다|아니라|아니에요"
    r"|오답|틀리|틀린|없다|맞지\s*않|않는다|않았)",
    re.IGNORECASE,
)

# Inversion items: the task is to pick the NON-matching / wrong statement.
INVERSION = re.compile(r"(맞지\s*않는|같지\s*않은|않은\s*것|틀린\s*것|아닌\s*것|알맞지\s*않은)")

# Speaker-attribution listening items.
SPEAKER_ATTR = re.compile(
    r"(남자|여자)(가|의)?\s*(이어서\s*할\s*(행동|일)|할\s*(행동|일)|중심\s*생각|생각|태도|말하는\s*의도)"
)

PLACEHOLDER = re.compile(
    r"(SKIPPED|no\s+source\s+text|지문\s*없음|전사할\s*수\s*없음|cannot\s+be\s+(explained|transcribed))",
    re.IGNORECASE,
)

# Circled digits used in ordinal references.
_CIRCLED = {"①": 1, "②": 2, "③": 3, "④": 4}
_KO_ORDINAL = {"첫": 1, "두": 2, "세": 3, "네": 4}
_EN_ORDINAL = {"first": 1, "second": 2, "third": 3, "fourth": 4}

ORDINAL_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"(첫|두|세|네)\s*번째\s*(선택지|보기|답|것)"), "ko"),
    (re.compile(r"(first|second|third|fourth)\s+(option|choice|answer|statement)", re.I), "en"),
    (re.compile(r"option\s*\(?([1-4①②③④])\)?", re.I), "digit"),
    (re.compile(r"선택지\s*([1-4①②③④])"), "digit"),
    (re.compile(r"([①②③④])"), "digit"),
    (re.compile(r"\(([1-4])\)"), "digit"),
]

WINDOW = 90  # chars of context around a quote occurrence to look for cues


# ---------------------------------------------------------------- data classes


@dataclass
class OptionEvidence:
    quoted: bool = False
    partial: bool = False  # matched via long prefix/suffix, not full text
    first_pos: int | None = None  # earliest occurrence (NFC offset)
    endorse_zone: bool = False  # any occurrence before the distractor marker
    distractor_zone: bool = False
    pos_cue: bool = False
    strong_pos_cue: bool = False
    neg_cue: bool = False


@dataclass
class Verdict:
    id: int
    verdict: str
    confidence: str
    key: int
    endorsed: list[int] = field(default_factory=list)
    ordinal_endorsed: list[int] = field(default_factory=list)
    inversion: bool = False
    speaker_attr: bool = False
    detail: str = ""


# ---------------------------------------------------------------- core logic


def find_option_occurrences(opt: str, norm_expl: str, idx_map: list[int]) -> tuple[list[int], bool]:
    """Return (occurrence offsets in the NFC explanation, partial?) for one
    option's text inside the explanation."""
    key = normalize(opt)
    if len(key) < 4:  # too short to match meaningfully (e.g. bare glyphs)
        return [], False
    positions: list[int] = []
    start = 0
    while True:
        j = norm_expl.find(key, start)
        if j == -1:
            break
        positions.append(idx_map[j])
        start = j + 1
    if positions:
        return positions, False
    # Fall back to a long prefix / suffix for options quoted with elisions.
    if len(key) >= 18:
        for frag in (key[:14], key[-14:]):
            j = norm_expl.find(frag)
            if j != -1:
                return [idx_map[j]], True
    return [], False


def ordinal_endorsements(expl_nfc: str, key: int) -> list[int]:
    """Extract option ordinals that the text explicitly endorses (an ordinal
    reference with a strong positive cue nearby)."""
    hits: list[int] = []
    for pat, kind in ORDINAL_PATTERNS:
        for m in pat.finditer(expl_nfc):
            g = m.group(1)
            if kind == "ko":
                n = _KO_ORDINAL.get(g)
            elif kind == "en":
                n = _EN_ORDINAL.get(g.lower())
            else:
                n = _CIRCLED.get(g) or (int(g) if g.isdigit() else None)
            if not n:
                continue
            ctx = expl_nfc[max(0, m.start() - WINDOW) : m.end() + WINDOW]
            if STRONG_POSITIVE_CUE.search(ctx) and not NEGATIVE_CUE.search(
                expl_nfc[m.end() : m.end() + 25]
            ):
                hits.append(n)
    return sorted(set(hits))


def audit_row(row: dict) -> Verdict:
    key = int(row["answer"])
    expl_nfc = unicodedata.normalize("NFC", row["expl"] or "")
    options: list[str] = row["options"] or []
    task_text = unicodedata.normalize(
        "NFC", " ".join(filter(None, [row.get("instruction"), row.get("stem")]))
    )
    v = Verdict(
        id=row["id"],
        verdict="OK",
        confidence="",
        key=key,
        inversion=bool(INVERSION.search(task_text)),
        speaker_attr=bool(SPEAKER_ATTR.search(task_text)),
    )

    if PLACEHOLDER.search(expl_nfc) and len(options) < 2:
        v.verdict, v.confidence = "PLACEHOLDER", "HIGH"
        v.detail = "explanation is a no-source-text placeholder note"
        return v

    norm_expl, idx_map = normalize_with_map(expl_nfc)
    marker = DISTRACTOR_MARKER.search(expl_nfc)
    split_at = marker.start() if marker else None

    # Pass 1: locate every occurrence interval of every option, so cue
    # attribution can be bounded by NEIGHBORING option quotes instead of a
    # fixed window (a fixed window bleeds "matching ..." language from one
    # option's sentence into the next option's context — this is exactly how
    # id 2140 evaded the first version of this detector).
    occ_by_opt: dict[int, list[tuple[int, int]]] = {}
    partial_by_opt: dict[int, bool] = {}
    all_intervals: list[tuple[int, int, int]] = []  # (start, end, opt#)
    for i, opt in enumerate(options, start=1):
        occ, partial = find_option_occurrences(opt, norm_expl, idx_map)
        n = len(normalize(opt))
        ivs = [(pos, pos + n, i) for pos in occ]
        occ_by_opt[i] = [(s, e) for s, e, _ in ivs]
        partial_by_opt[i] = partial
        all_intervals.extend(ivs)
    all_intervals.sort()

    def cue_context(start: int, end: int, opt_no: int) -> str:
        """Context for one occurrence, clipped at the nearest occurrence of a
        DIFFERENT option on each side (fallback: fixed window)."""
        lo = max(0, start - WINDOW)
        hi = min(len(expl_nfc), end + WINDOW)
        for s, e, o in all_intervals:
            if o == opt_no:
                continue
            if e <= start:
                lo = max(lo, e)
            if s >= end:
                hi = min(hi, s)
                break
        return expl_nfc[lo:start] + expl_nfc[end:hi]

    ev: dict[int, OptionEvidence] = {}
    for i in occ_by_opt:
        e = OptionEvidence(quoted=bool(occ_by_opt[i]), partial=partial_by_opt[i])
        for start, end in occ_by_opt[i]:
            if e.first_pos is None or start < e.first_pos:
                e.first_pos = start
            in_endorse = split_at is None or start < split_at
            if in_endorse:
                e.endorse_zone = True
            else:
                e.distractor_zone = True
            ctx = cue_context(start, end, i)
            if POSITIVE_CUE.search(ctx):
                e.pos_cue = True
            if STRONG_POSITIVE_CUE.search(ctx):
                e.strong_pos_cue = True
            if NEGATIVE_CUE.search(ctx):
                e.neg_cue = True
        ev[i] = e

    quoted = [i for i, e in ev.items() if e.quoted]
    endorsed = [
        i
        for i, e in ev.items()
        if e.quoted and e.endorse_zone and (e.pos_cue or e.strong_pos_cue)
    ]
    strong_endorsed = [i for i in endorsed if ev[i].strong_pos_cue]
    v.endorsed = endorsed
    v.ordinal_endorsed = ordinal_endorsements(expl_nfc, key)

    key_e = ev.get(key, OptionEvidence())
    # quoted options always have first_pos set; the `or 0` is for the type checker.
    first_quoted = min(quoted, key=lambda i: ev[i].first_pos or 0) if quoted else None

    non_key_strong = [i for i in strong_endorsed if i != key]
    non_key_endorsed = [i for i in endorsed if i != key]
    ordinal_conflict = bool(v.ordinal_endorsed) and key not in v.ordinal_endorsed

    if not quoted:
        v.verdict, v.confidence = "UNSCANNABLE", ""
        if ordinal_conflict:
            v.verdict, v.confidence = "MISMATCH_MEDIUM", "MEDIUM"
            v.detail = f"no option quoted, but ordinal endorsement -> {v.ordinal_endorsed}, key={key}"
        return v

    key_endorsed = key in endorsed
    key_framed_wrong = key_e.quoted and (
        (key_e.distractor_zone and not key_e.endorse_zone) or (key_e.neg_cue and not key_e.pos_cue)
    )

    if non_key_strong and (not key_endorsed) and (key_framed_wrong or not key_e.quoted):
        v.verdict, v.confidence = "MISMATCH_HIGH", "HIGH"
        v.detail = (
            f"option(s) {non_key_strong} strongly endorsed; key {key} "
            + ("framed as distractor" if key_framed_wrong else "never quoted")
        )
    elif ordinal_conflict and (non_key_endorsed or not key_endorsed):
        v.verdict, v.confidence = "MISMATCH_HIGH", "HIGH"
        v.detail = f"ordinal endorsement {v.ordinal_endorsed} != key {key}"
    elif non_key_endorsed and not key_endorsed and key_framed_wrong and not v.inversion:
        # A non-keyed option praised while the key is framed as wrong. For
        # INVERSION items ("pick the NON-matching one") this signature is
        # ambiguous — a CORRECT explanation also calls the keyed statement
        # factually wrong — so inversion items stay MEDIUM for human review.
        v.verdict, v.confidence = "MISMATCH_HIGH", "HIGH"
        v.detail = (
            f"option(s) {non_key_endorsed} endorsed; key {key} framed as distractor"
        )
    elif non_key_endorsed and not key_endorsed:
        v.verdict, v.confidence = "MISMATCH_MEDIUM", "MEDIUM"
        v.detail = f"option(s) {non_key_endorsed} endorsed (weak cue); key {key} not endorsed"
    elif first_quoted is not None and first_quoted != key and not key_endorsed and key_framed_wrong:
        v.verdict, v.confidence = "MISMATCH_MEDIUM", "MEDIUM"
        v.detail = f"first-quoted option {first_quoted} != key {key}; key framed as distractor"
    elif not key_e.quoted:
        v.verdict, v.confidence = "SUSPECT_LOW", "LOW"
        v.detail = f"key {key} never quoted; quoted={quoted}"
    else:
        v.verdict = "OK" if key_endorsed else "OK_WEAK"
    return v


# ---------------------------------------------------------------- entry point


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    src = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    rows = [json.loads(line) for line in src.read_text(encoding="utf-8").splitlines() if line]
    verdicts = [audit_row(r) for r in rows]

    with (out_dir / "verdicts.jsonl").open("w", encoding="utf-8") as f:
        for v in verdicts:
            f.write(json.dumps(v.__dict__, ensure_ascii=False) + "\n")

    order = {
        "MISMATCH_HIGH": 0,
        "PLACEHOLDER": 1,
        "MISMATCH_MEDIUM": 2,
        "SUSPECT_LOW": 3,
        "UNSCANNABLE": 4,
        "OK_WEAK": 5,
        "OK": 6,
    }
    counts: dict[str, int] = {}
    for v in verdicts:
        counts[v.verdict] = counts.get(v.verdict, 0) + 1
    print(json.dumps(counts, indent=2))

    by_id = {r["id"]: r for r in rows}
    flagged = sorted(
        (v for v in verdicts if order[v.verdict] <= 3),
        key=lambda v: (order[v.verdict], v.id),
    )
    with (out_dir / "flagged.txt").open("w", encoding="utf-8") as f:
        for v in flagged:
            r = by_id[v.id]
            f.write(
                f"=== id={v.id} test={r['test']} {r['level']} {r['section']} #{r['n']} "
                f"verdict={v.verdict} key={v.key} endorsed={v.endorsed} "
                f"ordinal={v.ordinal_endorsed} inv={v.inversion} spk={v.speaker_attr}\n"
                f"    detail: {v.detail}\n"
                f"    instruction: {r.get('instruction')}\n"
                f"    stem: {(r.get('stem') or '')[:200]}\n"
                f"    options: {json.dumps(r['options'], ensure_ascii=False)}\n"
                f"    expl: {r['expl']}\n\n"
            )
    print(f"flagged -> {out_dir / 'flagged.txt'} ({len(flagged)} rows)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
