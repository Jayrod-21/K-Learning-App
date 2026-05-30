/**
 * Zod schemas for every Claude-proxy input and output type.
 *
 * The rule: nothing untyped crosses a layer boundary. Every public
 * function parses its input against an `…Input` schema and parses its
 * output (whether from the model OR from the cache) against an `…Output`
 * schema. This means a cached row that pre-dates a schema migration
 * fails validation and falls through to a fresh API call rather than
 * silently returning a stale shape.
 *
 * Naming: `XxxInputSchema` / `XxxOutputSchema` for the schemas;
 * `XxxInput` / `XxxOutput` for the inferred TypeScript types.
 */

import { z } from 'zod';

// ---- Shared building blocks -------------------------------------------------

/** Korean / English / mixed text. Length-capped per route. */
const NonEmptyText = z.string().trim().min(1);

/** Register tags from the DESIGN_SPEC tagging model. Matches the Postgres
 *  `register_level` enum from migration 001. */
export const RegisterSchema = z.enum([
  '반말',
  '해요체',
  '합쇼체',
  '문어체',
  '하오체',
  '하게체',
]);
export type Register = z.infer<typeof RegisterSchema>;

/** Proficiency tags. Matches the Postgres `proficiency_level` enum. */
export const ProficiencyLevelSchema = z.enum(['basic', 'L3', 'L4', 'L5+']);
export type ProficiencyLevel = z.infer<typeof ProficiencyLevelSchema>;

/** Domain tags. Matches the DESIGN_SPEC content-tagging model. */
export const DomainSchema = z.enum(['general', 'research', 'business']);
export type Domain = z.infer<typeof DomainSchema>;

/** Conversation modes — mirror the Postgres `conversation_mode` enum. */
export const ConversationModeSchema = z.enum([
  'casual',
  'business',
  'research',
  'topik_prep',
  'register_drill',
]);
export type ConversationMode = z.infer<typeof ConversationModeSchema>;

// ---- 1. enrich --------------------------------------------------------------
// Used on tap-a-word. (lemma, source_sentence, context) → enrichment payload.

export const EnrichmentInputSchema = z.object({
  /** The Kiwi-lemmatized dictionary form. e.g., '먹다' for 먹었어요. */
  lemma: NonEmptyText.max(64),
  /** The sentence the lemma was tapped in. Verbatim, for context. */
  sourceSentence: NonEmptyText.max(2000),
  /** Optional broader context (paragraph or scenario description). */
  context: z.string().trim().max(2000).optional(),
  /** Optional KRDICT primary gloss to anchor enrichment to. */
  krdictGloss: z.string().trim().max(2000).optional(),
  /** Optional override of the default model. */
  model: z.enum(['haiku', 'sonnet', 'opus']).optional(),
});
export type EnrichmentInput = z.infer<typeof EnrichmentInputSchema>;

const ExampleSchema = z.object({
  korean: NonEmptyText.max(500),
  english: NonEmptyText.max(500),
});

export const EnrichmentResultSchema = z.object({
  /** One-sentence nuance line that supplements (does not replace) KRDICT. */
  nuance: NonEmptyText.max(500),
  /** Brief usage note: collocations, register signals, when to / not to use. */
  usageNote: NonEmptyText.max(800),
  /** 2-4 additional example sentences with English glosses. */
  examples: z.array(ExampleSchema).min(2).max(4),
  /** Words this is commonly confused with, with one-line distinguishing notes. */
  dontConfuseWith: z
    .array(
      z.object({
        lemma: NonEmptyText.max(64),
        distinction: NonEmptyText.max(300),
      }),
    )
    .max(5)
    .default([]),
  /** Best-guess proficiency tier for the lemma. */
  proficiency: ProficiencyLevelSchema,
  /** Best-guess register for this usage in context. */
  register: RegisterSchema.optional(),
});
export type EnrichmentResult = z.infer<typeof EnrichmentResultSchema>;

// ---- 2. recognizeGrammarPattern --------------------------------------------
// User drag-highlights a span in a sentence; we identify the canonical
// pattern and map to a grammar-bank entry.

export const GrammarRecognitionInputSchema = z.object({
  /** The highlighted span verbatim. e.g., '-아/어 버리다'. */
  highlightSpan: NonEmptyText.max(200),
  /** The full sentence the span lives in. */
  fullSentence: NonEmptyText.max(2000),
  /** Optional speaker register hint (from the source corpus). */
  registerHint: RegisterSchema.optional(),
  /** Optional override of the default model. */
  model: z.enum(['haiku', 'sonnet', 'opus']).optional(),
});
export type GrammarRecognitionInput = z.infer<typeof GrammarRecognitionInputSchema>;

export const GrammarPatternExampleSchema = z.object({
  korean: NonEmptyText.max(300),
  english: NonEmptyText.max(300),
  register: RegisterSchema,
});

export const PatternResultSchema = z.object({
  /** Canonical pattern key. e.g., '-아/어 버리다'. */
  patternKey: NonEmptyText.max(120),
  /** Human-readable name. e.g., 'completion / regret aspectual'. */
  patternName: NonEmptyText.max(200),
  /** 1-3 sentence meaning explanation. */
  meaning: NonEmptyText.max(800),
  /** When to use / when not to use. */
  usage: NonEmptyText.max(800),
  /** 2-4 register-appropriate examples. */
  examples: z.array(GrammarPatternExampleSchema).min(2).max(4),
  /** Proficiency tier (matches Postgres enum). */
  proficiency: ProficiencyLevelSchema,
  /** Confidence in the recognition (0..1). */
  confidence: z.number().min(0).max(1),
  /** Patterns commonly confused with this one. */
  relatedPatterns: z.array(NonEmptyText.max(120)).max(5).default([]),
});
export type PatternResult = z.infer<typeof PatternResultSchema>;

// ---- 3. gradeWriting -------------------------------------------------------
// TOPIK rubric-aligned writing grader. Uses tool-use for structured output.

export const TopikRubricSchema = z.enum([
  'topik_ii_53', // 200-300 자 description writing
  'topik_ii_54', // 600-700 자 argumentative essay
]);
export type TopikRubric = z.infer<typeof TopikRubricSchema>;

export const GradeInputSchema = z.object({
  /** The user's writing sample. Korean. */
  sample: NonEmptyText.max(16_000),
  /** Which TOPIK rubric to grade against. */
  rubric: TopikRubricSchema,
  /** Optional prompt the user was writing toward. */
  prompt: z.string().trim().max(2000).optional(),
  /** Optional model override. */
  model: z.enum(['haiku', 'sonnet', 'opus']).optional(),
});
export type GradeInput = z.infer<typeof GradeInputSchema>;

const DimensionScoreSchema = z.object({
  /** Score within the rubric's allowed range (0..max_for_dim). */
  score: z.number().nonnegative(),
  /** Max score for this dimension (so the consumer knows the denominator). */
  maxScore: z.number().positive(),
  /** Specific evidence cited from the sample (verbatim Korean fragments OK). */
  evidence: z.array(NonEmptyText.max(500)).max(5),
  /** Concrete, actionable improvement notes. */
  improvements: z.array(NonEmptyText.max(300)).max(5),
});

export const GradeResultSchema = z.object({
  rubric: TopikRubricSchema,
  /** 내용 및 과제수행 — content and task completion. */
  content: DimensionScoreSchema,
  /** 전개구조 — organization and development. */
  organization: DimensionScoreSchema,
  /** 언어사용 — language use (grammar, vocab, register). */
  languageUse: DimensionScoreSchema,
  /** Total score (sum of dimensions). */
  totalScore: z.number().nonnegative(),
  /** Max total. */
  maxTotal: z.number().positive(),
  /** Estimated TOPIK II level the sample would earn. */
  estimatedLevel: z.enum(['below_L3', 'L3', 'L4', 'L5', 'L6']),
  /** One-paragraph overall comment. */
  overallComment: NonEmptyText.max(2000),
});
export type GradeResult = z.infer<typeof GradeResultSchema>;

// ---- 3b. generateDiagnosticItem --------------------------------------------
// Diagnostic CAT-lite item generation. Given a vocab word or grammar pattern at
// a target level, Claude authors ONE 4-choice multiple-choice question with
// exactly one correct answer. Reading/listening items come from topik_items (no
// Claude); only vocab/grammar are generated.

/** Which diagnostic dimension a generated item probes. */
export const DiagnosticGenSectionSchema = z.enum(['vocab', 'grammar']);
export type DiagnosticGenSection = z.infer<typeof DiagnosticGenSectionSchema>;

/** Target proficiency band the item should be written at. Subset of
 *  ProficiencyLevel that the CAT band() function can land on. */
export const DiagnosticTargetLevelSchema = z.enum(['L3', 'L4', 'L5+']);
export type DiagnosticTargetLevel = z.infer<typeof DiagnosticTargetLevelSchema>;

/** Item kinds the generator may emit. vocab → synonym|cloze; grammar →
 *  pattern. (reading/listening kinds passage-mc/inference/audio-mc come from
 *  topik_items, never from this route.) */
export const DiagnosticGenKindSchema = z.enum(['synonym', 'cloze', 'pattern']);
export type DiagnosticGenKind = z.infer<typeof DiagnosticGenKindSchema>;

export const DiagnosticItemInputSchema = z.object({
  /** Which dimension: 'vocab' tests a word, 'grammar' tests a pattern. */
  section: DiagnosticGenSectionSchema,
  /** Band to author the item at. */
  targetLevel: DiagnosticTargetLevelSchema,
  /** Seed Korean term: the vocab headword (section=vocab) or the grammar
   *  pattern (section=grammar). */
  seedKorean: NonEmptyText.max(200),
  /** Optional English gloss / pattern English name to anchor the item. */
  seedEnglish: z.string().trim().max(300).optional(),
  /** Optional secondary gloss (e.g. a usage note) to disambiguate the seed. */
  seedGloss: z.string().trim().max(500).optional(),
  /** Optional model override. */
  model: z.enum(['haiku', 'sonnet', 'opus']).optional(),
});
export type DiagnosticItemInput = z.infer<typeof DiagnosticItemInputSchema>;

const DiagnosticGenChoiceSchema = z.object({
  /** Korean choice text. */
  kr: NonEmptyText.max(300),
  /** Optional English gloss for the choice (may be omitted). `.optional()`
   *  (not `.default('')`) so the inferred result type keeps `en` optional and
   *  matches `runJsonRoute`'s output type — the route coerces a missing gloss
   *  to '' when mapping to the client choice. */
  en: z.string().max(300).optional(),
});

export const DiagnosticItemResultSchema = z.object({
  /** Item kind the model chose. Constrained to the generable kinds. */
  kind: DiagnosticGenKindSchema,
  /** The question stem / prompt the learner reads. */
  prompt: NonEmptyText.max(1000),
  /** Exactly 4 choices. */
  choices: z.array(DiagnosticGenChoiceSchema).length(4),
  /** Index (0..3) of the single correct choice. */
  answerIndex: z.number().int().min(0).max(3),
  /** One- or two-sentence explanation, revealed only after the user answers. */
  explain: NonEmptyText.max(800),
});
export type DiagnosticItemResult = z.infer<typeof DiagnosticItemResultSchema>;

// ---- 4. generateConversation -----------------------------------------------
// Streamed conversation turns. Register-aware. Optional vocab focus.

export const ConversationInputSchema = z.object({
  /** Scenario brief. e.g., 'business meeting introduction; first time meeting'. */
  scenario: NonEmptyText.max(2000),
  /** Target register the AI should speak in. */
  registerTarget: RegisterSchema,
  /** Vocab the user is trying to produce. Threaded into the AI's turns. */
  vocabFocus: z.array(NonEmptyText.max(100)).max(20).default([]),
  /** Conversation mode (controls system prompt selection). */
  mode: ConversationModeSchema.default('casual'),
  /** Prior turns in this conversation (for follow-up calls). */
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: NonEmptyText.max(4000),
      }),
    )
    .max(40)
    .default([]),
  /** Optional model override. */
  model: z.enum(['haiku', 'sonnet', 'opus']).optional(),
  /** Max output tokens for THIS turn. */
  maxTokens: z.number().int().min(64).max(2000).default(800),
});
export type ConversationInput = z.infer<typeof ConversationInputSchema>;

export const ConversationTurnSchema = z.object({
  /** AI's response, in Korean. */
  korean: NonEmptyText,
  /** Brief English explanation: register signals, tricky vocab. */
  englishNote: z.string().max(1000),
  /** Vocab from focus list the AI actually used. */
  vocabUsed: z.array(NonEmptyText.max(100)).default([]),
  /** Register the AI spoke in (echoed for client display). */
  register: RegisterSchema,
});
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;

/** Streaming event union returned by `generateConversation`. */
export const ConversationStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), register: RegisterSchema }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('complete'), turn: ConversationTurnSchema }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type ConversationStreamEvent = z.infer<typeof ConversationStreamEventSchema>;

// ---- Common metadata returned alongside non-streaming results --------------

export const CallMetadataSchema = z.object({
  requestId: z.string(),
  model: z.enum(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7']),
  cacheHit: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
  // Tokens written to Anthropic's prompt cache on this call. Billed at
  // a premium over standard input. See usage.ts RATE_CARD.
  cacheCreationInputTokens: z.number().nonnegative(),
  costEstimateUsd: z.number().nonnegative(),
});
export type CallMetadata = z.infer<typeof CallMetadataSchema>;

/** Generic wrapper for non-streaming responses: result + metadata. */
export interface ProxyResult<T> {
  readonly result: T;
  readonly metadata: CallMetadata;
}
