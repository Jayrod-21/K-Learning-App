/**
 * tapChain — the shared "tap-anything" word-lookup pipeline.
 *
 * Extracted from `pages/Reading.tsx` so the Listen screen (F-012 rework) can
 * reuse the exact same tokenise → lemmatize → define → enrich path without
 * copy-paste divergence. Owns:
 *
 *   - `tokeniseKorean`     — eojeol-boundary splitter that turns a Korean
 *                            string into `PassageToken`s (placeholder gloss
 *                            on every word so it renders as a `Tapword`).
 *   - `isPlaceholderGloss` — the fast-path/slow-path discriminator.
 *   - `buildWordPopover`   — folds a `/define` result + `/enrich` envelope
 *                            into the `WordPopoverData` the popover renders.
 *   - `resolveWordPopover` — the abortable slow-path chain itself.
 *
 * Threat model (carried over from Reading's Pass 3 header):
 *   - Every string that reaches the popover renders as React text children —
 *     escaped, never HTML. The enrichment envelope is structurally validated
 *     field-by-field (never trusted via a cast) so a malformed or
 *     legacy-cached envelope degrades to nulls / empty lists, not garbage.
 *   - Each chain step can fail independently (KRDICT 503, Claude timeout).
 *     The chain degrades gracefully: define-without-enrich still yields the
 *     dictionary entry; both failing falls back to the fixed
 *     'Definition unavailable' literal. Server failure text is NEVER echoed.
 *   - The whole chain is abortable: the `AbortSignal` threads into every
 *     service call (cancelling the in-flight HTTP request, not just ignoring
 *     the response) and is re-checked between steps — an aborted chain
 *     resolves `null` so the caller paints nothing stale.
 */
import { lemmatize } from '../services/lemmatize';
import { defineEntry } from '../services/define';
import { enrich } from '../services/enrich';
import type { WordPopoverData } from '../components/WordPopover';
import type {
  DefineResult,
  EnrichResult,
  PassageGloss,
  PassageToken,
  VocabExample,
} from '../types/domain';

/**
 * Sentinel gloss strings the popover falls back to when there's no real
 * definition. Shared consts so mine-filters (which must NOT persist a
 * sentinel as a word's English) can never drift from what `buildWordPopover`
 * produces (B-002 review SF-1).
 */
export const GLOSS_DICTIONARY_ENTRY = 'Dictionary entry';
export const GLOSS_UNAVAILABLE = 'Definition unavailable';

/**
 * Split a Korean sentence into eojeol-boundary tokens plus the spaces
 * between them. Every non-space token gets a placeholder gloss so it
 * renders as a Tapword; the slow-path on tap replaces the placeholder.
 * Punctuation rides with its adjacent word — fine for a tap target; the
 * slow-path lemma chain strips it server-side.
 *
 * Placeholder sentinel: `en === ''`. Real glosses (fixture-attached or
 * post-enrichment) always carry a non-empty English string, so callers can
 * branch fast-path vs slow-path via {@link isPlaceholderGloss}.
 */
export function tokeniseKorean(korean: string): PassageToken[] {
  const tokens: PassageToken[] = [];
  const parts = korean.match(/\s+|\S+/g) ?? [];
  for (const part of parts) {
    if (/^\s+$/.test(part)) {
      tokens.push({ w: part });
    } else {
      tokens.push({
        w: part,
        vid: null,
        gloss: {
          kr: part,
          pos: 'n.',
          en: '',
          ex_kr: '',
          ex_en: '',
        },
      });
    }
  }
  return tokens;
}

/** True when the gloss is the placeholder synthesised by the tokeniser. */
export function isPlaceholderGloss(g: PassageGloss): boolean {
  return g.en === '';
}

/**
 * The enrichment fields the popover consumes, extracted from the opaque
 * `/enrich` envelope. The inner `result` is owned by B4's
 * `EnrichmentResultSchema` (server `services/claude/models.ts`):
 * `{ nuance, usageNote, examples: [{korean, english}], dontConfuseWith:
 * [{lemma, distinction}], proficiency, register? }`. Every field is
 * structurally validated before use rather than trusted via a cast.
 */
interface EnrichmentSummary {
  nuance: string | null;
  usageNote: string | null;
  examples: VocabExample[];
  contrast: string | null;
}

const EMPTY_ENRICHMENT: EnrichmentSummary = {
  nuance: null,
  usageNote: null,
  examples: [],
  contrast: null,
};

/** A non-empty trimmed string, or null. */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Extract the popover-relevant fields from the enrichment envelope.
 *
 * B-002 regression note: an earlier version looked for `summary` / `gloss` /
 * `en` — fields the real `EnrichmentResult` schema never had — so every
 * real-data tap fell through to the 'Definition unavailable' literal even
 * when Claude had returned a full enrichment.
 */
function summariseEnrichment(
  enrichment: EnrichResult | null,
): EnrichmentSummary {
  if (!enrichment) return EMPTY_ENRICHMENT;
  const inner = enrichment.result;
  if (typeof inner !== 'object' || inner === null) return EMPTY_ENRICHMENT;
  const rec = inner as Record<string, unknown>;

  const examples: VocabExample[] = Array.isArray(rec.examples)
    ? rec.examples.flatMap((ex): VocabExample[] => {
        if (typeof ex !== 'object' || ex === null) return [];
        const e = ex as Record<string, unknown>;
        const kr = textOrNull(e.korean);
        if (kr === null) return [];
        return [{ kr, en: textOrNull(e.english) ?? '' }];
      })
    : [];

  const contrastLines: string[] = Array.isArray(rec.dontConfuseWith)
    ? rec.dontConfuseWith.flatMap((c): string[] => {
        if (typeof c !== 'object' || c === null) return [];
        const cc = c as Record<string, unknown>;
        const lemma = textOrNull(cc.lemma);
        if (lemma === null) return [];
        const distinction = textOrNull(cc.distinction);
        return [distinction !== null ? `${lemma} — ${distinction}` : lemma];
      })
    : [];

  return {
    nuance: textOrNull(rec.nuance),
    usageNote: textOrNull(rec.usageNote),
    examples,
    contrast: contrastLines.length > 0 ? contrastLines.join(' · ') : null,
  };
}

/**
 * Build the popover payload from whatever the tap chain resolved.
 *
 * KRDICT is the spine when present: headword, POS, the first English
 * definition, and the example sentences `/define` joins in from
 * `krdict_examples`. Claude enrichment supplements it: the nuance line
 * backfills a missing English definition, its examples extend the
 * "More examples" drawer, and its usage note / don't-confuse list fill the
 * drawer's Usage section. With no dictionary entry at all (KRDICT 404, or
 * 503 while the tables aren't loaded — B-011) the enrichment alone still
 * yields a real popover; the 'Definition unavailable' literal is the last
 * resort when BOTH sources came back empty.
 */
export function buildWordPopover(
  lemma: string,
  defineResult: DefineResult | null,
  enrichment: EnrichResult | null,
): WordPopoverData {
  const first = defineResult?.entries[0];
  const enriched = summariseEnrichment(enrichment);

  // Dictionary examples lead (they anchor the headword sense); enrichment
  // examples follow. The first becomes the popover's primary example, the
  // rest feed the drawer.
  const defineExamples: VocabExample[] = (first?.examples ?? []).flatMap(
    (ex): VocabExample[] => {
      const kr = textOrNull(ex.korean);
      if (kr === null) return [];
      return [{ kr, en: textOrNull(ex.english) ?? '' }];
    },
  );
  const examples = [...defineExamples, ...enriched.examples];
  const primary = examples[0];
  const extra = examples.slice(1);

  const gloss =
    textOrNull(first?.definition_english) ??
    enriched.nuance ??
    (first ? GLOSS_DICTIONARY_ENTRY : GLOSS_UNAVAILABLE);

  return {
    kr: first?.headword ?? lemma,
    en: gloss,
    pos: first?.part_of_speech ?? 'word',
    // The KRDICT entry id is what FU-NF-33 mines on — it gives the server a
    // stable, homograph-safe dedup key. Absent only when `/define` returned
    // no entries (the fallback popover keys on the lemma instead).
    ...(first ? { krdictEntryId: first.id } : {}),
    ex_kr: primary?.kr ?? '',
    ex_en: primary?.en ?? '',
    ...(extra.length > 0 ? { extra } : {}),
    ...(enriched.usageNote !== null ? { notes: enriched.usageNote } : {}),
    ...(enriched.contrast !== null ? { contrast: enriched.contrast } : {}),
  };
}

/**
 * The abortable slow-path chain: lemmatize → define → enrich → popover data.
 *
 * Resolves `null` when the signal aborts mid-chain — the caller must treat
 * `null` as "paint nothing" (the user closed the popover or tapped a newer
 * word). Each step degrades gracefully on its own failure:
 *   - lemmatize fails → continue with the raw surface form (KRDICT often
 *     matches the conjugated form anyway);
 *   - define fails    → popover falls back to enrichment (or the fixed
 *     'Definition unavailable' literal);
 *   - enrich fails    → popover opens on the dictionary entry alone.
 *
 * The signal threads into every service call so an abort cancels the
 * in-flight HTTP request itself (freeing the server's per-route bucket),
 * not merely ignores the response.
 */
export async function resolveWordPopover(
  raw: string,
  sourceSentence: string,
  signal: AbortSignal,
): Promise<WordPopoverData | null> {
  let lemma = raw;
  try {
    const tokens = await lemmatize(raw, signal);
    const first = tokens[0];
    if (first && first.lemma) lemma = first.lemma;
  } catch {
    // Lemmatize failure → fall through with the raw form.
  }
  if (signal.aborted) return null;

  let defineResult: DefineResult | null = null;
  try {
    defineResult = await defineEntry(lemma, signal);
  } catch {
    // Define failure → graceful degradation (see contract above).
  }
  if (signal.aborted) return null;

  let enrichResult: EnrichResult | null = null;
  try {
    enrichResult = await enrich({ lemma, sourceSentence }, signal);
  } catch {
    // Enrich failure is non-fatal — popover opens on the entry alone.
  }
  if (signal.aborted) return null;

  return buildWordPopover(lemma, defineResult, enrichResult);
}
