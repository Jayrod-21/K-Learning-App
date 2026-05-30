#!/usr/bin/env python3
"""
Normalize TOPIK item skill_tags into a controlled vocabulary.

Five parallel extraction terminals produced 60 drifting skill_tag values (near-duplicates like
listening-detail vs listening-detail-match). This collapses them into one consistent vocabulary so
weak-area filtering in the app is reliable.

- Reading & listening: mapped by tag string (pure synonym collapse).
- Writing: assigned by item number, since TOPIK II writing structure is fixed
  (51 practical blank, 52 expository blank, 53 chart description, 54 argumentative essay).
- The original value is preserved in `skill_tag_raw` whenever it changes.

Run from anywhere:  python3 normalize_skill_tags.py [output_dir]
Idempotent: re-running is safe (already-canonical tags map to themselves).
"""
import json, glob, os, sys
from collections import Counter

READING_MAP = {
    "grammar-connective": "grammar-connective",
    "grammar-expression": "grammar-expression",
    "grammar-paraphrase": "grammar-paraphrase",
    "reading-cloze-context": "reading-cloze-context",
    "reading-connective-adverb": "reading-cloze-context",  # connector cloze -> cloze
    "reading-detail-match": "reading-detail-match",
    "reading-infer": "reading-main-idea",                  # single inference item -> main idea
    "reading-emotion": "reading-emotion",                  # character's 심정
    "reading-attitude": "reading-attitude",                # writer's 태도
    "reading-graph": "reading-graph",
    "reading-headline": "reading-headline",
    "reading-idiom": "reading-idiom",
    "reading-insert-sentence": "reading-insert-sentence",
    "reading-main-idea": "reading-main-idea",
    "reading-purpose": "reading-purpose",
    "reading-sequence": "reading-sequence",
    "reading-topic-id": "reading-topic-id",
}

LISTENING_MAP = {
    "listening-detail-match": "listening-detail-match",
    "listening-main-idea": "listening-main-idea",
    "listening-opinion": "listening-main-idea",
    "listening-attitude": "listening-attitude",
    # next utterance in a dialogue
    "listening-next-utterance": "listening-next-utterance",
    "listening-dialogue-response": "listening-next-utterance",
    "listening-response": "listening-next-utterance",
    # what a speaker will do next
    "listening-next-action": "listening-next-action",
    # what a speaker is currently doing
    "listening-speaker-action": "listening-speaker-action",
    "listening-action-id": "listening-speaker-action",
    # picture selection
    "listening-picture-select": "listening-picture-select",
    "listening-picture-match": "listening-picture-select",
    # graph/chart match
    "listening-graph-match": "listening-graph-match",
    "listening-graph": "listening-graph-match",
    # identify who/role/relationship/situation
    "listening-identify": "listening-identify",
    "listening-identify-person": "listening-identify",
    "listening-identify-role": "listening-identify",
    "listening-identity": "listening-identify",
    "listening-speaker-id": "listening-identify",
    "listening-speaker-role": "listening-identify",
    "listening-situation-id": "listening-identify",
    # speaker's intent/purpose
    "listening-intent": "listening-intent",
    "listening-intention": "listening-intent",
    # reason / why
    "listening-detail-reason": "listening-detail-reason",
    "listening-reason": "listening-detail-reason",
    # preceding-context inference
    "listening-preceding-context": "listening-preceding-context",
    "listening-infer-preceding": "listening-preceding-context",
    "listening-infer-context": "listening-preceding-context",
    # how the speaker develops/delivers the talk (말하는 방식)
    "listening-speaker-method": "listening-speaker-method",
    "listening-method": "listening-speaker-method",
    "listening-speaking-manner": "listening-speaker-method",
    # topic of talk/dialogue
    "listening-topic-id": "listening-topic-id",
}

# Writing: by item number (TOPIK II structure is fixed).
WRITING_BY_NUMBER = {
    51: "writing-blank-practical",
    52: "writing-blank-expository",
    53: "writing-chart-description",
    54: "writing-essay-argumentative",
}


def normalize(out_dir):
    changed = 0
    before = Counter()
    after = Counter()
    for f in sorted(glob.glob(os.path.join(out_dir, "topik_*.json"))):
        d = json.load(open(f, encoding="utf-8"))
        src = d.get("source", {})
        for it in d.get("items", []):
            sec = it.get("section", src.get("section"))
            raw = it.get("skill_tag")
            before[raw] += 1
            if sec == "writing":
                canon = WRITING_BY_NUMBER.get(it.get("number"), raw)
            elif sec == "listening":
                canon = LISTENING_MAP.get(raw, raw)
            else:
                canon = READING_MAP.get(raw, raw)
            after[canon] += 1
            if canon != raw:
                if raw is not None and "skill_tag_raw" not in it:
                    it["skill_tag_raw"] = raw
                it["skill_tag"] = canon
                changed += 1
        json.dump(d, open(f, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        open(f, "a", encoding="utf-8").write("\n")
    return changed, before, after


if __name__ == "__main__":
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__)) + "/output"
    changed, before, after = normalize(out_dir)
    print(f"items changed: {changed}")
    print(f"distinct tags: {len(before)} -> {len(after)}")
    print("\nCanonical vocabulary:")
    for t, c in sorted(after.items()):
        print(f"  {c:>4}  {t}")
