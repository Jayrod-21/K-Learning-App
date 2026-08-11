/**
 * cloze — F-208 (cloze vocab drill) span-finding + grading helpers.
 *
 * A cloze is a random alternate PRESENTATION of an existing recognition card:
 * the entry's example sentence with the target word blanked, answered by
 * TYPING. This module owns the deterministic pieces:
 *
 *   - buildClozePrompt: given an entry (headword LEMMA + example sentence),
 *     find the surface span to blank via Kiwi. The headword is a LEMMA (먹다)
 *     while the sentence carries a CONJUGATED surface (먹었어요) — so the match
 *     is on token.lemma, and the blank is the token's [start, end) SURFACE
 *     span. NEVER a raw string match of the lemma against the sentence (it
 *     would miss every conjugated form and false-positive on substrings).
 *
 *   - answerMatchesLemma: the lemma-tolerance leg of grading — a typed answer
 *     that is a DIFFERENT valid conjugation of the same headword (먹는다 for
 *     먹었어요) still counts, because Kiwi lemmatizes both to 먹다.
 *
 *   - blankSentence / clozeHint: presentation helpers. The blanked sentence is
 *     what the due queue serves (the answer_surface itself is NEVER shipped —
 *     SECURITY.md §17 answer-stripping posture); the hint is the partial
 *     reveal after a first wrong attempt (first syllable + length only).
 *
 * All functions are pure/deterministic given the injected lemmatizer — the
 * Kiwi HTTP client is passed in (never imported) so unit tests run with a
 * canned token list and no network.
 *
 * OFFSETS: km-kiwi Token start/end are UTF-16 code-unit offsets, end
 * exclusive (services/kiwi.ts contract mirror). JS String.prototype.slice
 * uses the same units, so spans apply directly — but every token is still
 * verified against the sentence (slice(start, end) === surface) before use,
 * so a drifted upstream can produce a null result, never a corrupted blank.
 */

/** One token as the km-kiwi /lemmatize contract returns it. */
export interface ClozeToken {
  surface: string;
  lemma: string;
  pos: string;
  start: number;
  end: number;
}

/** Injected lemmatizer — the route passes a closure over services/kiwi.ts. */
export type ClozeLemmatizeFn = (text: string) => Promise<{ tokens: ClozeToken[] }>;

/** The entry fields buildClozePrompt reads (a projection of vocab_entries). */
export interface ClozeSourceEntry {
  /** Headword — a LEMMA (dictionary form), e.g. 먹다. */
  korean: string;
  /** The candidate sentence (e.g. example_korean, or a KRDICT example). */
  sentence: string;
  /** Optional English translation of the sentence. */
  english?: string | null;
}

/** A computed cloze prompt, ready to persist (offsets into `korean`). */
export interface ClozePromptDraft {
  korean: string;
  english: string | null;
  blankStart: number;
  blankEnd: number;
  answerSurface: string;
}

/** The blank marker the served (blanked) sentence carries. */
export const BLANK_MARKER = '______';

/** Kiwi's own input cap (services/kiwi.ts LemmatizeRequestSchema max). A
 *  sentence longer than this cannot be lemmatized, hence never cloze-eligible. */
const MAX_SENTENCE_LEN = 2_000;

/** NFC-normalize + trim. Korean text arrives from multiple pipelines (corpus
 *  ingest, KRDICT XML, a learner's IME) — compare in one canonical form. */
function normalizeKorean(text: string): string {
  return text.normalize('NFC').trim();
}

/** Normalize a typed answer for the exact-match leg of grading. */
export function normalizeAnswer(text: string): string {
  return normalizeKorean(text);
}

/**
 * Find the cloze span for an entry: lemmatize the sentence, take the FIRST
 * token whose lemma equals the entry headword (first occurrence — the
 * canonical reading order), and blank its surface span.
 *
 * Returns null (→ not cloze-eligible) when:
 *   - headword or sentence is empty after normalization,
 *   - the sentence exceeds Kiwi's input cap (lemmatizer is not even called),
 *   - no token's lemma matches the headword, or
 *   - every matching token fails span verification (upstream offset drift).
 *
 * Never throws for "no match"; a lemmatizer (network) failure DOES propagate —
 * the caller decides whether that aborts a batch or fails a request.
 */
export async function buildClozePrompt(
  entry: ClozeSourceEntry,
  lemmatizeFn: ClozeLemmatizeFn,
): Promise<ClozePromptDraft | null> {
  const headword = normalizeKorean(entry.korean);
  const sentence = normalizeKorean(entry.sentence);
  if (headword.length === 0 || sentence.length === 0) return null;
  if (sentence.length > MAX_SENTENCE_LEN) return null;

  const { tokens } = await lemmatizeFn(sentence);
  for (const token of tokens) {
    if (token.lemma.normalize('NFC') !== headword) continue;
    // Span verification: offsets must address THIS sentence and reproduce the
    // token's own surface. A mismatch means upstream offset drift — skip the
    // token (a later occurrence may still verify) rather than blanking a
    // wrong/garbled span.
    if (
      !Number.isInteger(token.start) ||
      !Number.isInteger(token.end) ||
      token.start < 0 ||
      token.end <= token.start ||
      token.end > sentence.length
    ) {
      continue;
    }
    const surface = sentence.slice(token.start, token.end);
    if (surface !== token.surface) continue;
    const english = entry.english ?? null;
    return {
      korean: sentence,
      english: english !== null && english.trim().length > 0 ? english.trim() : null,
      blankStart: token.start,
      blankEnd: token.end,
      answerSurface: surface,
    };
  }
  return null;
}

/**
 * Render the served (blanked) sentence: [blankStart, blankEnd) replaced by
 * BLANK_MARKER. The caller passes spans straight from a cloze_prompts row —
 * they were verified against this exact string at seed time.
 */
export function blankSentence(korean: string, blankStart: number, blankEnd: number): string {
  return korean.slice(0, blankStart) + BLANK_MARKER + korean.slice(blankEnd);
}

/**
 * Lemma-tolerance grading leg: does ANY token of the (lemmatized) typed
 * answer share the entry headword's lemma? "Any token" (not "the only
 * token") because Kiwi splits a conjugated verb into stem + ending morphemes
 * and a learner may type trailing punctuation — the word they produced is
 * what matters.
 */
export function answerMatchesLemma(tokens: readonly ClozeToken[], headword: string): boolean {
  const target = normalizeKorean(headword);
  if (target.length === 0) return false;
  return tokens.some((t) => t.lemma.normalize('NFC') === target);
}

/** The partial reveal after a first wrong attempt: first character (Hangul
 *  syllable) + total character count — never more. Counted in code POINTS
 *  (Array.from), so a hypothetical astral char is one "character". */
export function clozeHint(answerSurface: string): { firstChar: string; length: number } {
  const chars = Array.from(answerSurface);
  return { firstChar: chars[0] ?? '', length: chars.length };
}
