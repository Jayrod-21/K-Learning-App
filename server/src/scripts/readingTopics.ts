/**
 * Curated, app-owned neutral topic list for F-220 slice 2's generated
 * READING items — the seed for `generate-item-bank.ts`'s `'reading'` section
 * and `services/claude/prompts/diagnostic_reading_item.ts`.
 *
 * COPYRIGHT — the whole point of this file. Every entry below is a BARE,
 * uncopyrightable Korean concept word/phrase (weather, food, a daily
 * routine, a trip...) — the kind of everyday topic that appears, unprotected,
 * in every language textbook and conversation-starter list ever written. A
 * single common noun or short phrase naming a topic is not protectable
 * expression; it carries no original arrangement of words, sentences, or
 * ideas the way a passage of PROSE does.
 *
 * NONE of this list is derived from, or drawn out of, TOPIK/Darakwon/TTMIK/
 * KRDICT or any other corpus this app has ingested — it was hand-picked as a
 * generic, level-agnostic set of "things Korean textbooks always talk
 * about". Claude receives ONLY the bare topic string (never a passage, an
 * article, or any existing text) and is instructed
 * (prompts/diagnostic_reading_item.ts) to author the reading passage 100%
 * FRESH from it — the topic is a seed for imagination, not source material
 * to summarize, paraphrase, or transform. This separation (bare concept in,
 * wholly original prose out) is what makes the resulting passage safe to
 * serve as a diagnostic reading item without touching any of the app's
 * copyright-blocked corpora.
 *
 * Deliberately NOT sourced from a DB table (unlike vocab_entries/
 * canonical_grammar, F-220 slice 1's seeds): a topic list this small and
 * static doesn't need a table, and keeping it as a reviewable, in-repo
 * constant makes the "every entry is a bare concept, never corpus text"
 * claim above trivially auditable by anyone reading this file.
 */

/** ~40 neutral, everyday topics spanning the kind of subject matter every
 *  TOPIK band's reading section covers (daily life, routines, places,
 *  hobbies, society) — none skew toward any one proficiency level; the
 *  TARGET BAND controls difficulty (sentence length/vocabulary/complexity),
 *  not the topic choice, per diagnostic_reading_item.ts's prompt. */
export const READING_TOPICS: readonly string[] = [
  '날씨', // weather
  '음식', // food
  '취미', // hobbies
  '학교', // school
  '여행', // travel
  '하루 일과', // daily routine
  '쇼핑', // shopping
  '건강', // health
  '직장', // work/workplace
  '계절', // seasons
  '가족', // family
  '교통', // transportation
  '운동', // exercise/sports
  '영화', // movies
  '도서관', // library
  '공원', // park
  '카페', // cafe
  '요리', // cooking
  '음악', // music
  '반려동물', // pets
  '휴일', // holidays
  '생일', // birthdays
  '이웃', // neighbors
  '주말', // weekend
  '아르바이트', // part-time job
  '병원', // hospital/clinic
  '은행', // bank
  '우체국', // post office
  '시장', // market
  '축제', // festival
  '사진', // photography
  '독서', // reading (as a hobby)
  '봉사활동', // volunteering
  '동아리', // clubs/circles
  '인터넷', // the internet
  '스마트폰', // smartphones
  '환경', // the environment
  '전통', // tradition
  '명절', // holidays/traditional festivals
  '커피', // coffee
] as const;

/** A single reading-topic draw, shaped to slot directly into
 *  `generate-item-bank.ts`'s `SeedCandidate` (structurally — `seedEnglish` is
 *  simply absent, which `SeedCandidate`'s optional field allows). */
export interface ReadingTopicSeed {
  /** Synthetic provenance ref (topics aren't DB rows) — `topic-<level>-<n>`. */
  readonly seedRef: string;
  /** The bare topic string itself — reuses the `seedKorean` NAME (not a new
   *  field) so it slots into the existing `SeedCandidate`/`BuiltRequest`
   *  plumbing unchanged; for this section it holds a topic, not a corpus
   *  headword. */
  readonly seedKorean: string;
}

/**
 * Up to `n` reading-topic seeds. Topics are NOT a scarce DB resource (unlike
 * vocab_entries/canonical_grammar) — the list is small and reuse is fine, so
 * this never "runs short" the way the DB-backed pickers can.
 *
 * Draws WITHOUT replacement from a shuffled copy of the list for as long as
 * distinct topics remain (indices `0..min(n, list.length)-1` of a shuffle are
 * always distinct), then wraps around (index modulo list length) for any
 * remainder — maximizing topic variety (and therefore distinct
 * `prompt_hash`es — see generate-item-bank.ts) before any repetition ever
 * kicks in, rather than risking an early duplicate the way independent
 * random draws could.
 *
 * `level` only flavors `seedRef` (for operator-facing work-order ids); topics
 * themselves are level-agnostic — the TARGET LEVEL passed alongside the topic
 * to `generateDiagnosticReadingItem` is what controls passage difficulty.
 *
 * `rng` is injectable so tests can assert the shuffle deterministically
 * (mirrors `shuffleGeneratedChoices`).
 */
export function pickReadingTopics(
  level: string,
  n: number,
  rng: () => number = Math.random,
): ReadingTopicSeed[] {
  const shuffled = [...READING_TOPICS];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = tmp;
  }
  const out: ReadingTopicSeed[] = [];
  for (let i = 0; i < n; i += 1) {
    const topic = shuffled[i % shuffled.length]!;
    out.push({
      seedRef: `topic-${level}-${String(i + 1).padStart(4, '0')}`,
      seedKorean: topic,
    });
  }
  return out;
}
