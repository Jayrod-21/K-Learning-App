#!/usr/bin/env python3
"""
Google Cloud Vision OCR -> curated literature JSON.

Vision (DOCUMENT_TEXT_DETECTION, ko) transcribes the operator's owned page
scans; this script only maps the engine's output into the
``load_literature.py`` chapter schema using an operator-supplied structure
config. Every ``body`` string is Vision's verbatim output — no text is
authored here.

Per prose page, the story is the LONGEST paragraph block Vision returns
(banner / comic bubbles / footnotes are all short), so the mapping is robust
to comic-heavy layouts without pixel cropping.

Env: GOOGLE_VISION_API_KEY.
Modes:
  --test PAGE [PAGE ...]     OCR pages, print the picked story block per page.
  (--config C --out O)       Run the config -> JSON.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://vision.googleapis.com/v1/images:annotate"


def _key() -> str:
    k = os.environ.get("GOOGLE_VISION_API_KEY", "").strip()
    if not k:
        sys.exit("GOOGLE_VISION_API_KEY not set in the environment")
    return k


def vision_fta(key: str, path: Path) -> dict | None:
    img = base64.b64encode(path.read_bytes()).decode()
    body = json.dumps(
        {
            "requests": [
                {
                    "image": {"content": img},
                    "features": [{"type": "DOCUMENT_TEXT_DETECTION"}],
                    "imageContext": {"languageHints": ["ko"]},
                }
            ]
        }
    ).encode()
    last: Exception | None = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(
                f"{API}?key={key}", data=body, headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=90) as r:
                d = json.loads(r.read())
            resp = d.get("responses", [{}])[0]
            if resp.get("error"):
                raise RuntimeError(f"Vision API error: {resp['error']}")
            return resp.get("fullTextAnnotation")
        except (urllib.error.URLError, TimeoutError) as e:  # transient — retry
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"Vision request failed after retries: {last}")


def _paragraph_text(para: dict) -> str:
    """Reconstruct one paragraph's text from Vision symbols, honoring breaks.

    Korean wraps mid-word: a LINE_BREAK is NOT a space (join), whereas
    SPACE/SURE_SPACE/EOL_SURE_SPACE ARE spaces. This yields the printed text.
    """
    out = []
    for word in para.get("words", []):
        for sym in word.get("symbols", []):
            out.append(sym.get("text", ""))
            brk = sym.get("property", {}).get("detectedBreak", {}).get("type")
            # Mid-LINE spaces are real word boundaries -> keep. LINE-END breaks
            # (LINE_BREAK / EOL_SURE_SPACE / HYPHEN) are join points: this book
            # wraps mid-eojeol, so adding a space there would split words and
            # wreck tap-to-define tokenization. Join with no space.
            if brk in ("SPACE", "SURE_SPACE"):
                out.append(" ")
    return "".join(out).strip()


def ordered_paragraphs(fta: dict | None) -> list[tuple[float, str]]:
    """Every paragraph on the page as (min_y, text), in reading (top-to-bottom)
    order — unfiltered.

    This is the raw primitive the structured-book drivers (drivers/*.py) build
    their own state machines on: they need to see the short heading / section
    markers (``복습``, ``Vocabulary``, ``제N장``) that ``story_paragraphs`` filters
    out, then decide keep/drop themselves.
    """
    out: list[tuple[float, str]] = []
    if not fta:
        return out
    for page in fta.get("pages", []):
        for block in page.get("blocks", []):
            for para in block.get("paragraphs", []):
                t = _paragraph_text(para)
                ys = [v.get("y", 0) for v in para.get("boundingBox", {}).get("vertices", [])]
                out.append((min(ys) if ys else 0.0, t))
    out.sort(key=lambda p: p[0])
    return out


def _korean_ratio(s: str) -> float:
    chars = [c for c in s if not c.isspace()]
    if not chars:
        return 0.0
    hangul = sum(1 for c in chars if "가" <= c <= "힣")
    return hangul / len(chars)


# A numbered comprehension question ("1. …", "2) …") or an imperative discussion
# prompt ("… 소개해 보세요", "… 이야기해 보세요", "…까요?"). In exercise-bearing
# language-learner books these sit alongside the story prose; drop them from the
# reading passages (they belong to the comprehension feature — F-205).
_Q_RE = re.compile(r"^\s*\d+\s*[.)]")
_PROMPT_RE = re.compile(r"(보세요|보십시오|하세요|까요)\s*[?.!]?\s*$")


def _is_exercise(t: str) -> bool:
    return bool(_Q_RE.match(t) or _PROMPT_RE.search(t))


def story_paragraphs(
    fta: dict | None,
    min_len: int = 25,
    min_korean: float = 0.6,
    anchor: bool = True,
    drop_exercises: bool = False,
) -> list[str]:
    """All story-prose paragraphs on the page, in reading (top-to-bottom) order.

    A story paragraph is LONG and mostly HANGUL — which excludes the short
    banner/comic-bubble text and the English-glossed footnotes (low Korean
    ratio) without any pixel cropping. Keeping *all* qualifying blocks (not
    just the longest) captures multi-paragraph stories intact.

    ``anchor=True`` (comic layout, e.g. Easy Korean Reading): the story sits at
    the page BOTTOM under the comic panels, so keep the longest block + only
    what's at-or-below it, dropping in-panel Korean signs above.
    ``anchor=False`` (prose layout, e.g. facing-page folktale books): the whole
    page is story text, so keep EVERY qualifying Korean paragraph in order.
    """
    if not fta:
        return []
    picked: list[tuple[float, str]] = []
    for page in fta.get("pages", []):
        for block in page.get("blocks", []):
            for para in block.get("paragraphs", []):
                t = _paragraph_text(para)
                if len(t) >= min_len and _korean_ratio(t) >= min_korean:
                    if drop_exercises and _is_exercise(t):
                        continue
                    ys = [v.get("y", 0) for v in para.get("boundingBox", {}).get("vertices", [])]
                    picked.append((min(ys) if ys else 0.0, t))
    if not picked:
        return []
    picked.sort(key=lambda p: p[0])
    if not anchor:
        return [t for _, t in picked]
    # Comic layout: the story is the bottom text block. Anchor on the longest
    # qualifying paragraph (always the story's main body) and keep it + any
    # paragraph at-or-below it (multi-paragraph continuation), dropping in-comic
    # Korean notices/signs that sit ABOVE the story in the panels.
    anchor_y = max(picked, key=lambda p: len(p[1]))[0]
    return [t for y, t in picked if y >= anchor_y]


def run_test(scan_dir: Path, pages: list[str], anchor: bool, drop_exercises: bool = False) -> int:
    key = _key()
    for p in pages:
        path = scan_dir / p
        if not path.exists():
            print(f"[MISSING] {path}", file=sys.stderr)
            continue
        paras = story_paragraphs(vision_fta(key, path), anchor=anchor, drop_exercises=drop_exercises)
        print(f"\n===== {p}  ({len(paras)} story paragraph(s)) =====")
        for i, t in enumerate(paras, 1):
            print(f"  [{i}] {t}")
    return 0


def run_config(scan_dir: Path, cfg: dict, out_path: Path) -> int:
    key = _key()
    anchor = cfg.get("layout", "prose") == "comic"
    drop_ex = bool(cfg.get("drop_exercises", False))
    chapters = []
    for ch in cfg["chapters"]:
        passages = []
        seen: set[str] = set()
        pnum = 0
        for spec in ch["pages"]:
            for body in story_paragraphs(
                vision_fta(key, scan_dir / spec["file"]), anchor=anchor, drop_exercises=drop_ex
            ):
                # Facing-page spreads occasionally re-OCR the same block; drop
                # exact-duplicate bodies within a chapter (keep first occurrence).
                if body in seen:
                    continue
                seen.add(body)
                pnum += 1
                passages.append(
                    {"passage_number": pnum, "body": body, "page_number": spec["printed_page"]}
                )
        chapters.append(
            {
                "chapter_number": ch["chapter_number"],
                "title": ch.get("title"),
                "start_page": ch["printed_start"],
                "end_page": ch["printed_end"],
                "passages": passages,
            }
        )
        print(f"  ch{ch['chapter_number']:>2}: {sum(len(p['body']) for p in passages)} chars", flush=True)
    out = {"source": cfg["source"], "chapters": chapters}
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    npass = sum(len(c["passages"]) for c in chapters)
    print(f"OCR done: {len(chapters)} chapters, {npass} passages -> {out_path}")
    return 0


def run_cache(scan_dir: Path, cache_dir: Path) -> int:
    """OCR every ``NNNN.jpg`` in ``scan_dir`` once, caching each page's
    fullTextAnnotation to ``cache_dir/NNNN.json``.

    Multi-slice books (novels, exercise readers, dialogue books) get re-mapped
    several times while dialing in chapter boundaries; caching the one expensive
    Vision pass makes every later re-slice local and free. Idempotent — an
    already-cached page is skipped, so an interrupted run just resumes.
    """
    key = _key()
    cache_dir.mkdir(parents=True, exist_ok=True)
    # Lowercase NNNN.jpg only — the whole scan corpus is normalized to that name.
    scans = sorted(scan_dir.glob("[0-9][0-9][0-9][0-9].jpg"))
    if not scans:
        sys.exit(f"no NNNN.jpg scans in {scan_dir}")
    done = 0
    for src in scans:
        dst = cache_dir / f"{src.stem}.json"
        if dst.exists():
            continue
        # Temp file + atomic rename: a kill mid-write must not leave a truncated
        # NNNN.json that the resume check above would then skip forever. Blank
        # pages still serialize as literal JSON null (fta is None) — that null
        # round-trip is load-bearing for resume-skipping blanks.
        tmp = dst.with_name(dst.name + ".tmp")
        tmp.write_text(json.dumps(vision_fta(key, src), ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, dst)
        done += 1
        if done % 25 == 0:
            print(f"  cached {done} (at {src.name})", flush=True)
    print(f"cache done: {done} newly OCR'd, {len(scans)} pages total -> {cache_dir}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scan-dir", required=True, type=Path)
    ap.add_argument("--config", type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--cache-dir", type=Path,
                    help="OCR every scan once into this dir of NNNN.json (cache pass "
                         "for the structured-book drivers); nothing else runs")
    ap.add_argument("--test", nargs="+")
    ap.add_argument("--layout", choices=("comic", "prose"), default="prose",
                    help="test-mode extraction layout (config runs read cfg['layout'])")
    ap.add_argument("--drop-exercises", action="store_true",
                    help="test-mode: drop numbered questions / discussion prompts "
                         "(config runs read cfg['drop_exercises'])")
    args = ap.parse_args(argv)
    if args.cache_dir:
        return run_cache(args.scan_dir, args.cache_dir)
    if args.test:
        return run_test(args.scan_dir, args.test, anchor=(args.layout == "comic"),
                        drop_exercises=args.drop_exercises)
    if not args.config or not args.out:
        ap.error("either --test PAGES or (--config and --out) is required")
    return run_config(args.scan_dir, json.loads(args.config.read_text("utf-8")), args.out)


if __name__ == "__main__":
    raise SystemExit(main())
