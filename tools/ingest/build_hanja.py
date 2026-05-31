#!/usr/bin/env python3
"""
build_hanja.py — Pass 7 hanja corpus builder (vocab-grounded + Unihan-enriched).

WHY THIS EXISTS
    The Hanja screen needs a per-character corpus (character + Korean reading +
    English gloss + stroke count + compounds). We own no standalone hanja list,
    but the Darakwon "2000 Essential Korean Words" corpora carry a per-word
    `hanja` gloss on ~2,950 words. This script mines the distinct hanja from
    that vocabulary, enriches each character from the Unicode **Unihan**
    database (a public-domain primary source), and derives compounds from our
    OWN vocabulary — so every character a learner sees is one that actually
    appears in their study words.

PIPELINE
    1. Parse Unihan (kTraditionalVariant, kHangul, kDefinition, kTotalStrokes).
    2. Read vocab_2000_{beginner,intermediate}.json `items`. For each non-
       `hanja_extension` word with a `hanja` gloss, normalise every CJK char in
       the gloss to its **traditional** form (the form Korean hanja uses — the
       Darakwon gloss is Chinese and may be simplified, e.g. 动 → 動).
    3. Keep only characters that have a Korean reading in Unihan (`kHangul`) —
       this drops Chinese-only characters that appear in the Chinese gloss but
       are not Korean hanja.
    4. For each kept character emit: reading (sound), English gloss, stroke
       count, corpus frequency, a level band (from the easiest proficiency of
       the words it appears in), and the compounds it forms in our vocabulary.
    5. Write `output/hanja.json` in the house corpus shape ({source, characters}).

DATA GAPS (documented, not silently dropped)
    * Korean character gloss (훈, e.g. "배울" for 學) is sourced from the
      한국어문회-derived map at data/hanja_hunmeum.json (FU-NF-40) — Unihan has no
      훈 field. See load_hunmeum().
    * Prose etymology is still NOT sourced (no clean primary source) — emitted
      as an empty string; the English gloss (kDefinition) + reading carry the
      meaning. Tracked as the remaining half of FU-NF-40.

USAGE
    python3 build_hanja.py            # uses ./_work/unihan + ./output
    Unihan is fetched once to _work/unihan/ (see fetch_unihan); re-runs reuse it.

This is reference-data tooling — deterministic, offline after the one-time
Unihan fetch, and safe to re-run (idempotent: it overwrites output/hanja.json).
"""
from __future__ import annotations

import json
import re
import sys
import urllib.request
import zipfile
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUTPUT_DIR = HERE / "output"
WORK_DIR = HERE / "_work" / "unihan"
UNIHAN_URL = "https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip"

# 훈 (native-Korean gloss) per character — Unihan has no such field, so this is
# sourced + verified against the 사단법인 한국어문회 grade-level 훈음 data (canonical
# facts; see the file's _provenance). Committed (small, factual) so the build is
# reproducible without re-deriving from the source compilation. FU-NF-40.
HUNMEUM_PATH = HERE / "data" / "hanja_hunmeum.json"

VOCAB_FILES = ["vocab_2000_beginner.json", "vocab_2000_intermediate.json"]

# CJK Unified Ideographs + Ext-A + Compatibility Ideographs. Korean hanja live
# in the Unified block; Ext-A/Compat are included so a stray gloss char is
# still recognised (and then dropped in step 3 if it has no Korean reading).
CJK_RE = re.compile(r"[㐀-䶿一-鿿豈-﫿]")

# Map the vocab proficiency enum to the client `Hanja.level` label. A character
# is "introduced" at the easiest word that uses it, so we take the minimum.
PROFICIENCY_ORDER = {"basic": 0, "L3": 1, "L4": 2, "L5+": 3}
PROFICIENCY_TO_LEVEL = {"basic": "L2", "L3": "L3", "L4": "L4", "L5+": "L5"}


def fetch_unihan() -> None:
    """Download + unzip Unihan into WORK_DIR once. Reused on re-runs."""
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    readings = WORK_DIR / "Unihan_Readings.txt"
    if readings.exists():
        return
    zip_path = WORK_DIR / "Unihan.zip"
    print(f"  fetching Unihan from {UNIHAN_URL} …", file=sys.stderr)
    urllib.request.urlretrieve(UNIHAN_URL, zip_path)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(WORK_DIR)


def load_unihan() -> dict[str, dict[str, str]]:
    """Parse the Unihan fields we need into {codepoint: {field: value}}."""
    wanted = {"kTraditionalVariant", "kHangul", "kDefinition", "kTotalStrokes"}
    # kHangul/kDefinition → Readings; kTraditionalVariant → Variants;
    # kTotalStrokes → IRGSources (NOT DictionaryLikeData, despite the name).
    files = ["Unihan_Readings.txt", "Unihan_Variants.txt", "Unihan_IRGSources.txt"]
    out: dict[str, dict[str, str]] = {}
    for fn in files:
        path = WORK_DIR / fn
        if not path.exists():
            continue
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("#") or "\t" not in line:
                    continue
                cp, field, value = line.rstrip("\n").split("\t", 2)
                if field in wanted:
                    out.setdefault(cp, {})[field] = value
    return out


def codepoint(ch: str) -> str:
    return "U+%04X" % ord(ch)


def from_codepoint(cp: str) -> str:
    return chr(int(cp[2:], 16))


# --- Disambiguation of simplified→traditional 1:N merges -----------------------
#
# A handful of simplified Chinese characters in the Darakwon glosses merge two
# (or more) distinct *Korean* hanja that BOTH carry a kHangul reading. Unihan's
# kTraditionalVariant lists every candidate but cannot tell us which one a given
# word means, so the reading-only heuristic below (`korean_reading` membership)
# would silently pick the wrong one. These overrides resolve the ambiguity from
# our own corpus, cross-checked against each word's intended Korean meaning.
#
# WHY TWO MAPS:
#   * WORD_CONTEXT_OVERRIDE — for chars whose correct traditional form differs
#     BETWEEN words in our corpus (genuinely context-dependent). Keyed by the
#     raw (simplified) gloss substring and the char's index within it.
#       历 → 歷 (history/career/résumé: 역사/경력/이력) vs 曆 (calendar: 음력)
#       复 → 復 (review/repeat/recover: 복습/반복/회복) vs 複 (duplicate: 복사)
#       系 → 係 (relationship: 관계)        — the dept/tie senses don't survive validation
#       台 → 颱 (typhoon: 태풍)  vs 臺 (stage: 무대)
#       制 → 製 (manufacture: 제작/제품) vs 制 (restrict: 제한 — already traditional)
#   * SIMPLIFIED_OVERRIDE — for chars whose every surviving corpus word resolves
#     to the SAME traditional form, but whose reading-only pick is (or could be)
#     wrong. A flat char→trad map is sufficient and clearer here.
#       干 → 乾 (dry/clean: 건조/깨끗 — not 幹 "trunk")
#       钟 → 鐘 (bell/clock: 종/종로)     范 → 範 (scope: 범위)
#       准 → 準 (standard/prepare: 기준/준비)   郁 → 鬱 (melancholy: 우울)
#
# Each override is logged to stderr at build time (see to_traditional) so the
# choice is auditable, and any *still-unmapped* ambiguous char is logged too.
WORD_CONTEXT_OVERRIDE: dict[str, dict[int, str]] = {
    # history / career / résumé → 歷 ; calendar → 曆
    "历史": {0: "歷"},
    "经历": {1: "歷"},
    "经历、经验": {1: "歷"},
    "履历": {1: "歷"},
    "阴历": {1: "曆"},
    "日历": {1: "曆"},
    # review / repeat / recover → 復 ; duplicate (copy) → 複
    "复习": {0: "復"},
    "反复": {1: "復"},
    "恢复": {1: "復"},
    "复印": {0: "複"},
    # relationship → 係
    "关系": {1: "係"},
    # typhoon → 颱 ; stage → 臺
    "台风": {0: "颱"},
    "舞台": {1: "臺"},
    # manufacture → 製 ; restrict (限制) keeps 制 (already traditional, no entry needed)
    "制作": {0: "製"},
    "制品": {0: "製"},
}

SIMPLIFIED_OVERRIDE: dict[str, str] = {
    "干": "乾",
    "钟": "鐘",
    "范": "範",
    "准": "準",
    "郁": "鬱",
}


def to_traditional(
    ch: str, unihan: dict[str, dict[str, str]], *, word: str | None = None, index: int = 0
) -> str:
    """
    Normalise a (possibly simplified) character to its traditional form — the
    form Korean hanja uses.

    Resolution order (most specific first):
      1. WORD_CONTEXT_OVERRIDE — a curated per-word disambiguation for the
         simplified chars that merge two Korean hanja (历→{歷,曆}, …). `word`
         is the raw simplified gloss substring and `index` the char position.
      2. SIMPLIFIED_OVERRIDE — a flat curated char→traditional map for chars
         whose corpus words all resolve to one form but whose reading-only
         pick is unreliable.
      3. Already-Korean guard — if the input char LISTS ITSELF among its own
         kTraditionalVariant candidates AND has a kHangul reading, it is a valid
         traditional Korean hanja (Unihan self-lists chars used as both
         simplified and traditional, e.g. 家 → "傢 家"); return it UNCHANGED.
         Without this, common hanja like 家 (가) get "upgraded" to a rare
         sibling variant (傢). NOTE: a "has any reading" test is NOT enough —
         purely-simplified chars (学/国) carry a borrowed ':N'-tagged reading yet
         must still normalise to 學/國, so the self-listed test is the key.
      4. kTraditionalVariant — genuinely simplified inputs (not self-listed)
         reach here. `kTraditionalVariant` lists space-separated codepoints (the
         char itself excluded). When several candidates carry a Korean reading
         the choice is ambiguous and reading alone cannot resolve it; we pick the
         first but LOG it to stderr so the gap can be promoted to an override.
    """
    if word is not None:
        override = WORD_CONTEXT_OVERRIDE.get(word, {}).get(index)
        if override is not None:
            return override
    if ch in SIMPLIFIED_OVERRIDE:
        return SIMPLIFIED_OVERRIDE[ch]
    cp = codepoint(ch)
    tv = unihan.get(cp, {}).get("kTraditionalVariant")
    if not tv:
        return ch  # no traditional-variant mapping → already traditional
    cps = tv.split()
    # Already-Korean guard (corrected). A char that LISTS ITSELF among its own
    # kTraditionalVariant candidates is, by Unihan convention, a valid
    # traditional form (chars used as BOTH simplified and traditional, e.g.
    # 家 → "傢 家"); with a Korean reading it must be kept, never "upgraded" to a
    # sibling variant — this is what corrupted 家→傢. A purely-simplified char
    # whose mapping does NOT include itself (学 → "學") is normalised even though
    # Unihan gives it a borrowed (':N'-tagged) Korean reading — checking only for
    # "has a reading" wrongly kept 学/国 as the simplified form.
    # The self-listed char is kept ONLY if it has a STANDARD (':0…') reading.
    # 家(가:0E) is standard → keep; 医 self-lists but reads only '예:N/의:N'
    # (non-standard), so it is NOT kept and normalises to 醫(의:0E) below.
    if cp in cps and has_standard_reading(ch, unihan):
        return ch
    candidates = [c for c in cps if c != cp]
    if not candidates:
        return ch
    korean_candidates = [c for c in candidates if unihan.get(c, {}).get("kHangul")]
    # Prefer a candidate with a STANDARD (':0…') reading over a non-standard
    # sibling: 線(:0E) over 綫(:1N), 衆 over 眾. Only when MULTIPLE standard forms
    # remain (e.g. 發/髮, both :0E) is the choice genuinely ambiguous → log it.
    standard = [c for c in korean_candidates if has_standard_reading(from_codepoint(c), unihan)]
    pool = standard or korean_candidates
    if len(pool) > 1:
        chosen = from_codepoint(pool[0])
        print(
            f"  AMBIGUOUS simplified→traditional: {ch} "
            f"(word={word!r}, idx={index}) has multiple standard-reading variants "
            f"{[from_codepoint(c) for c in pool]} — picked {chosen}; "
            f"add a WORD_CONTEXT_OVERRIDE entry if this is wrong",
            file=sys.stderr,
        )
        return chosen
    if pool:
        return from_codepoint(pool[0])
    return from_codepoint(candidates[0])


# Unihan kHangul readings carry a source tag after the colon. The standard/
# non-standard signal is the SOURCE LETTER, not the leading digit: 'E' marks an
# attestation in the modern standard source (the genuine Korean traditional
# reading), while 'N' marks a non-standard / borrowed / simplified-form source.
# So '0E'/'E'/'0EN' are standard; '0N'/'1N'/'N' (and bare-digit '0'/'1') are not.
# Korean hanja study wants the standard forms — 後(후:0E) over 后(후:0N),
# 醫(의:0E) over 医(의:N), 線(선:0E) over 綫(선:1N). Testing the leading digit
# (e.g. startswith('0')) is WRONG: '0N' — the single most common tag — starts
# with '0' yet is non-standard, which leaked 后/无/强/烟/筑 over 後/無/強/煙/築.
def _is_standard_tag(tag: str) -> bool:
    return "E" in tag


def has_standard_reading(ch: str, unihan: dict[str, dict[str, str]]) -> bool:
    """True iff the char has a kHangul reading from the standard (':0…') source."""
    raw = unihan.get(codepoint(ch), {}).get("kHangul")
    if not raw:
        return False
    return any(_is_standard_tag(tok.split(":", 1)[1]) for tok in raw.split() if ":" in tok)


def korean_reading(ch: str, unihan: dict[str, dict[str, str]]) -> str | None:
    """
    Korean reading from kHangul, preferring the STANDARD (':0…') source over a
    non-standard (':N'/':1N') one ('예:N 의:N' has none standard → '예'; a char
    with '선:0E' → '선'). Returns None when the char has no kHangul reading.
    """
    raw = unihan.get(codepoint(ch), {}).get("kHangul")
    if not raw:
        return None
    tokens = raw.split()
    for tok in tokens:
        reading, _, tag = tok.partition(":")
        if _is_standard_tag(tag):
            return reading
    return tokens[0].split(":")[0]


def korean_readings(ch: str, unihan: dict[str, dict[str, str]]) -> set[str]:
    """All Korean readings from kHangul ('독:0E 두:0E' → {'독','두'})."""
    raw = unihan.get(codepoint(ch), {}).get("kHangul")
    if not raw:
        return set()
    return {tok.split(":")[0] for tok in raw.split()}


HANGUL_SYLLABLE_RE = re.compile(r"[가-힣]")


def word_is_hanja_backed(
    korean: str, trad_chars: list[str], unihan: dict[str, dict[str, str]]
) -> bool:
    """
    True iff `trad_chars` is genuinely the Korean hanja for `korean`.

    WHY: the Darakwon `hanja` field is a *Chinese* gloss. For Sino-Korean words
    it coincides with the hanja (활동 = 活動), but for native-Korean words it
    holds a Chinese *translation* with no relation to Korean hanja (아내 → 妻子,
    깜짝 → 嚇一跳). We accept a word only when each hanja character's Korean
    reading lines up with the word's leading syllables — so 活(활)動(동) matches
    활동, but 妻(처)子(자) does not match 아내 and is rejected. Trailing native
    suffixes (하다 / 적 / 들 …) are allowed, hence "leading syllables", not equality.
    Multi-reading characters (不 → {불,부}) match on ANY reading.
    """
    syllables = HANGUL_SYLLABLE_RE.findall(korean)
    if len(syllables) < len(trad_chars):
        return False
    for syl, ch in zip(syllables, trad_chars):
        if syl not in korean_readings(ch, unihan):
            return False
    return True


def load_hunmeum() -> dict[str, str]:
    """Load the per-character 훈 (native-Korean gloss) map (FU-NF-40).

    Unihan carries the reading (음) and an English gloss but NOT the Korean 훈,
    so the 훈 is sourced + verified against the 사단법인 한국어문회 훈음 data and
    committed as a small factual map at HUNMEUM_PATH. Missing file → empty map
    (build still succeeds, gloss_kr falls back to "" as before).
    """
    if not HUNMEUM_PATH.exists():
        print(f"  WARN: {HUNMEUM_PATH} not found — gloss_kr (훈) will be empty", file=sys.stderr)
        return {}
    doc = json.loads(HUNMEUM_PATH.read_text(encoding="utf-8"))
    gloss = doc.get("gloss_kr", {})
    return {k: v for k, v in gloss.items() if isinstance(v, str) and v}


def main() -> int:
    fetch_unihan()
    unihan = load_unihan()
    if not unihan:
        print("ERROR: Unihan data not found/parsed in _work/unihan", file=sys.stderr)
        return 1
    hunmeum = load_hunmeum()

    # word_trad_cache memoises a vocab word's hanja → traditional rendering.
    char_freq: Counter[str] = Counter()
    char_best_prof: dict[str, int] = {}
    char_words: dict[str, list[dict]] = {}
    words_seen = 0
    words_with_hanja = 0
    words_validated = 0
    raw_distinct: set[str] = set()

    for fname in VOCAB_FILES:
        path = OUTPUT_DIR / fname
        data = json.loads(path.read_text(encoding="utf-8"))
        for item in data.get("items", []):
            if item.get("type") == "hanja_extension":
                continue
            words_seen += 1
            hanja = item.get("hanja")
            korean = item.get("korean")
            if not (isinstance(hanja, str) and isinstance(korean, str)):
                continue
            raw_chars = CJK_RE.findall(hanja)
            if not raw_chars:
                continue
            words_with_hanja += 1
            raw_distinct.update(raw_chars)
            # Render the whole word's hanja in traditional, char by char. The
            # raw gloss + char index are passed so the curated per-word
            # overrides can disambiguate simplified 1:N merges (历→歷/曆, …).
            trad_chars = [
                to_traditional(c, unihan, word=hanja, index=i)
                for i, c in enumerate(raw_chars)
            ]
            # Reject Chinese-translation glosses on native-Korean words — only a
            # genuine Sino-Korean hanja whose readings match the word survives.
            if not word_is_hanja_backed(korean, trad_chars, unihan):
                continue
            words_validated += 1
            word_hanja_trad = "".join(trad_chars)
            prof = item.get("proficiency") if item.get("proficiency") in PROFICIENCY_ORDER else "L4"
            english = (item.get("english") or "").strip()
            word_record = {
                "korean": korean,
                "hanja": word_hanja_trad,
                "english": english,
            }
            # Attribute the word to each DISTINCT traditional char it contains.
            for idx, tch in enumerate(trad_chars):
                if korean_reading(tch, unihan) is None:
                    continue  # not a Korean hanja — skip (Chinese-only gloss char)
                char_freq[tch] += 1
                rank = PROFICIENCY_ORDER[prof]
                if tch not in char_best_prof or rank < char_best_prof[tch]:
                    char_best_prof[tch] = rank
                others = "".join(t for j, t in enumerate(trad_chars) if j != idx)
                # Dedupe a word under a char (a char repeated in one word counts once for compounds).
                bucket = char_words.setdefault(tch, [])
                if not any(w["korean"] == korean for w in bucket):
                    bucket.append({**word_record, "with": others})

    level_from_rank = {v: PROFICIENCY_TO_LEVEL[k] for k, v in PROFICIENCY_ORDER.items()}
    characters = []
    for ch in sorted(char_freq, key=lambda c: (-char_freq[c], c)):
        info = unihan.get(codepoint(ch), {})
        strokes_raw = info.get("kTotalStrokes", "").split()
        strokes = int(strokes_raw[0]) if strokes_raw and strokes_raw[0].isdigit() else None
        compounds = [
            {"kr": w["korean"], "han": w["hanja"], "en": w["english"], "with": w["with"]}
            for w in char_words.get(ch, [])
        ]
        characters.append(
            {
                "char": ch,
                "sound": korean_reading(ch, unihan) or "",
                # 훈 (Korean gloss) from the 한국어문회-sourced map (FU-NF-40);
                # "" only if a char is absent from it.
                "gloss_kr": hunmeum.get(ch, ""),
                "gloss_en": (info.get("kDefinition") or "").strip(),
                "strokes": strokes,
                "frequency": char_freq[ch],
                "level": level_from_rank[char_best_prof[ch]],
                "etymology": "",  # no primary source; v1 gap
                "compounds": compounds,
            }
        )

    out = {
        "source": {
            "corpus": "hanja",
            "built_by": "tools/ingest/build_hanja.py",
            "method": "vocab-grounded (Darakwon 2000 Words hanja glosses) + Unihan enrichment",
            "unihan_source": UNIHAN_URL,
            "unihan_license": "Unicode (public-domain redistributable)",
            "scope": "all distinct Korean hanja appearing in the vocab corpora",
            "hunmeum_source": "훈 sourced/verified against 사단법인 한국어문회 훈음 data via github.com/rycont/hanja-grade-dataset; canonical facts (FU-NF-40), see data/hanja_hunmeum.json _provenance",
            "gaps": "etymology has no primary source — empty (FU-NF-40 deferred etymology)",
        },
        "characters": characters,
    }
    out_path = OUTPUT_DIR / "hanja.json"
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---- stats to stderr ----
    with_compounds = sum(1 for c in characters if c["compounds"])
    no_strokes = sum(1 for c in characters if c["strokes"] is None)
    no_gloss = sum(1 for c in characters if not c["gloss_en"])
    print(f"vocab words scanned: {words_seen} (with hanja gloss: {words_with_hanja})", file=sys.stderr)
    print(f"  validated Sino-Korean (reading-matched) words: {words_validated}", file=sys.stderr)
    print(f"raw distinct CJK chars in glosses: {len(raw_distinct)}", file=sys.stderr)
    print(f"KEPT Korean hanja (have a kHangul reading, traditional-normalised): {len(characters)}", file=sys.stderr)
    print(f"  with >=1 compound: {with_compounds}", file=sys.stderr)
    print(f"  missing stroke count: {no_strokes}", file=sys.stderr)
    print(f"  missing English gloss: {no_gloss}", file=sys.stderr)
    print(f"wrote {out_path} ({out_path.stat().st_size} bytes)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
