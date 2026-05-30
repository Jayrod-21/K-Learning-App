"""
Korean target-string normalizer for the cross-reference resolver.

WHY a dedicated module:
    1. Korean Unicode has both NFC and NFD precomposed forms; NFD breaks
       equality lookups against DB rows stored in NFC.
    2. Source JSON occasionally tags homographs with a (paren) suffix or a
       superscript-style "①" — we strip those for the FK lookup but preserve
       them for storage so the UI can still disambiguate.
    3. Some `related[]` entries list multiple targets separated by ", " or
       " · ". The lookup wants each individually.

Pure functions, no I/O — trivially unit-testable.
"""

from __future__ import annotations

import re
import unicodedata

from .models import NormalizedTarget


# Circled-digit / superscript / paren-digit homograph markers we've actually
# observed in source JSON. Keep the set tight — we'd rather miss one and log
# a broken-ref than greedy-strip real headword text.
_HOMOGRAPH_TRAILING_PAREN_RE = re.compile(r"\s*\(([0-9①-⑨ⅠⅡⅢⅣⅤⅥa-z]{1,4})\)\s*$")
_HOMOGRAPH_TRAILING_DIGIT_RE = re.compile(r"\s*([①-⑨])\s*$")

# A reference like "N에 ② (time)" — we want the canonical form "N에" and
# the homograph index "②".
_HOMOGRAPH_INLINE_CIRCLED_RE = re.compile(r"\s+([①-⑨])\s+\(")

# Multi-target separators commonly used in source `related[]`/`synonyms[]`
# entries like "만족하다, 만족스럽다" or "걸다 · 걸리다".
_MULTI_TARGET_SPLIT_RE = re.compile(r"\s*[,;/·]\s*|\s+또는\s+|\s+vs\s+", re.IGNORECASE)

# Strip standalone gloss tails that aren't part of the Korean form. Examples
# observed: "N에 (direction)", "-는 듯이 (Ch.15 #02)". We keep the form before
# the first parenthesis ONLY when there's Korean before it. Pure-English
# parenthetical labels (e.g. just "(time)") fall through unchanged so the
# lookup can fail loudly rather than silently coalescing them all to "".
_TRAILING_PAREN_GLOSS_RE = re.compile(r"\s*\(([^)]+)\)\s*$")

# Regex for entry-id-shaped tokens inside `note` fields: "kgiu-beg-u03-01",
# "kgiu-adv-c12-04", "vocab-int-2109". Captured tightly so we don't false-
# match nearby words.
ENTRY_ID_RE = re.compile(
    r"\b(kgiu-(?:beg|int|adv)-[a-z0-9]+-[0-9]+|vocab-(?:beg|int)-[0-9]+)\b",
    re.IGNORECASE,
)


def nfc(text: str) -> str:
    """Apply Unicode NFC normalization."""
    return unicodedata.normalize("NFC", text)


def collapse_whitespace(text: str) -> str:
    """Replace runs of any whitespace (incl. CJK ideographic space) with a single ASCII space; strip."""
    # 　 = ideographic space, \xa0 = NBSP, ​ = ZWSP
    cleaned = re.sub(r"[\s　\xa0​]+", " ", text)
    return cleaned.strip()


def _split_homograph_index(text: str) -> tuple[str, str | None]:
    """Strip a trailing homograph index. Returns (base, index_or_None)."""
    m = _HOMOGRAPH_INLINE_CIRCLED_RE.search(text)
    if m:
        base = text[: m.start()].rstrip()
        index = m.group(1)
        # Drop the parenthetical gloss tail too (e.g. "(time)") — it isn't
        # part of the form.
        base = _TRAILING_PAREN_GLOSS_RE.sub("", base).rstrip()
        return base, index

    m = _HOMOGRAPH_TRAILING_PAREN_RE.search(text)
    if m:
        # Only strip if the captured token is short and digit-ish — protects
        # against eating real glosses like "(family members)".
        return text[: m.start()].rstrip(), m.group(1)

    m = _HOMOGRAPH_TRAILING_DIGIT_RE.search(text)
    if m:
        return text[: m.start()].rstrip(), m.group(1)

    return text, None


def _strip_trailing_paren_gloss(text: str) -> str:
    """Strip a trailing parenthetical gloss like '(subject particle)'.

    Heuristic: only strip if there's substantive content before the paren and
    the parenthetical itself is mostly Latin (an English gloss / cross-ref
    pointer). A Korean-only parenthetical might be a real form variant we
    must preserve, so we leave those alone.
    """
    m = _TRAILING_PAREN_GLOSS_RE.search(text)
    if not m:
        return text
    paren_content = m.group(1)
    # 80% Latin / digit / space — heuristic, keeps us conservative.
    latin_chars = sum(1 for ch in paren_content if ch.isascii() and (ch.isalnum() or ch in " .-#"))
    if len(paren_content) == 0 or latin_chars / max(1, len(paren_content)) < 0.6:
        return text
    head = text[: m.start()].rstrip()
    if not head:  # don't return ""
        return text
    return head


def _split_multi_targets(canonical: str) -> tuple[str, ...]:
    """Split a comma/slash-separated multi-target line into individual targets.

    Single-target inputs return a one-tuple containing the canonical itself.
    Empty fragments are discarded.
    """
    parts = _MULTI_TARGET_SPLIT_RE.split(canonical)
    cleaned = tuple(p.strip() for p in parts if p.strip())
    if not cleaned:
        return (canonical,)
    if len(cleaned) == 1:
        return cleaned
    return cleaned


def normalize_target(raw: str | None) -> NormalizedTarget | None:
    """Normalize a raw target string from source JSON.

    Returns None for inputs that yield no usable canonical form — the caller
    should treat that as a "broken" reference.
    """
    if raw is None:
        return None
    s = nfc(raw)
    s = collapse_whitespace(s)
    if not s:
        return None

    base, homo = _split_homograph_index(s)
    base = collapse_whitespace(base)
    if not base:
        # The entire input was a homograph marker — nothing to look up.
        return None

    # Strip the trailing English/Latin parenthetical gloss after homograph
    # handling so things like "N에 ② (time)" → "N에".
    base = _strip_trailing_paren_gloss(base)
    base = collapse_whitespace(base)

    subtargets = _split_multi_targets(base)

    return NormalizedTarget(
        original=raw,
        canonical=base,
        homograph_index=homo,
        subtargets=subtargets,
    )


def extract_entry_ids(note: str | None) -> list[str]:
    """Pull `kgiu-…` / `vocab-…` source_ids out of a free-form note string.

    Returns a list (preserves order; preserves duplicates removed by index).
    """
    if not note:
        return []
    found = ENTRY_ID_RE.findall(note)
    # Lowercase for the lookup; source_ids are stored lowercase in JSON.
    out: list[str] = []
    seen: set[str] = set()
    for f in found:
        norm = f.lower()
        if norm not in seen:
            seen.add(norm)
            out.append(norm)
    return out
