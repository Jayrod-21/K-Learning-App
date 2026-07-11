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

/** Proficiency tags. Matches the Postgres `proficiency_level` enum ('L1'/'L2'
 *  added by migration 039, F-002 — the diagnostic ladder's beginner levels;
 *  'basic' remains the legacy corpus content tag). */
export const ProficiencyLevelSchema = z.enum(['basic', 'L1', 'L2', 'L3', 'L4', 'L5+']);
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

/**
 * The full GRADING rubric taxonomy — `TopikRubricSchema`'s two TOPIK II
 * rubrics plus `free_write` (056/F-117): a Claude-generated free-write topic
 * (mode='general', no TOPIK rubric of its own) previously had to borrow the
 * Q54 essay rubric to be graded at all — an honest but ill-fitting stand-in.
 * Deliberately a SEPARATE, wider schema from `TopikRubricSchema` rather than
 * a widen-in-place: `TopikRubricSchema` still gates
 * `WritingPromptGenInputSchema.rubric` below, which is topik-MODE prompt
 * GENERATION only (a free-write prompt is authored via mode='general', which
 * carries no rubric field at all) — widening that schema would let
 * 'free_write' ride a code path that has nothing to do with grading. Mirrors
 * the DB CHECK widened by migration 056 (`ck_writing_attempts_rubric`).
 */
export const WritingGradeRubricSchema = z.enum([
  'topik_ii_53',
  'topik_ii_54',
  'free_write',
]);
export type WritingGradeRubric = z.infer<typeof WritingGradeRubricSchema>;

export const GradeInputSchema = z.object({
  /** The user's writing sample. Korean. */
  sample: NonEmptyText.max(16_000),
  /** Which rubric to grade against (two TOPIK rubrics, or free_write). */
  rubric: WritingGradeRubricSchema,
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
  rubric: WritingGradeRubricSchema,
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
 *  ProficiencyLevel that the CAT band() function can land on ('L1'/'L2'
 *  added by F-002 — never 'basic', which is a content tag, not a band). */
export const DiagnosticTargetLevelSchema = z.enum(['L1', 'L2', 'L3', 'L4', 'L5+']);
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

// ---- 3c. ocrImage ----------------------------------------------------------
// Image OCR mining (Pass 8, Images screen). Given a photo containing Korean
// text, Claude Vision transcribes it and returns a short caption plus the
// distinct CONTENT words (nouns/verbs/adjectives/adverbs/pronouns), each with
// glosses + a part-of-speech tag. NO bounding boxes (locked decision): the
// result carries no coordinates and the client renders a tappable word LIST.

/** Part-of-speech tags the model may emit — the client `PartOfSpeech` union.
 *  Free-ish but constrained to a small closed set so the DTO is predictable.
 *  `.optional()` (not defaulted) so a missing tag stays absent rather than
 *  guessing a value; the route maps a missing tag to null in the DB. */
export const ImageWordPosSchema = z.enum(['n.', 'v.', 'adj.', 'adv.', 'pn.']);
export type ImageWordPos = z.infer<typeof ImageWordPosSchema>;

const ImageOcrWordSchema = z.object({
  /** Dictionary form of the word (Korean). Non-empty. */
  kr: NonEmptyText.max(200),
  /** Short English gloss. `.optional()` (not `.default('')`) so the inferred
   *  result type matches `runJsonRoute`'s output; the route coerces to ''. */
  en: z.string().max(500).optional(),
  /** Slightly fuller gloss / usage note. Optional; route coerces to ''. */
  gloss: z.string().max(800).optional(),
  /** Part of speech. Optional — absent when the model didn't tag it. */
  pos: ImageWordPosSchema.optional(),
});
export type ImageOcrWord = z.infer<typeof ImageOcrWordSchema>;

export const ImageOcrInputSchema = z.object({
  /** Base64-encoded image bytes (no data: URI prefix). Capped so a pathological
   *  payload can't blow past the upload limit at the schema layer too — an 8
   *  MiB blob is ~11.2M base64 chars; 16M leaves headroom without being
   *  unbounded. The route's multer fileSize limit is the primary cap. */
  imageBase64: z.string().min(1).max(16_000_000),
  /** Sniffed media type — must be one of the upload allowlist values. */
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  /** Optional model override (vision-capable tiers only in practice). */
  model: z.enum(['haiku', 'sonnet', 'opus']).optional(),
});
export type ImageOcrInput = z.infer<typeof ImageOcrInputSchema>;

export const ImageOcrResultSchema = z.object({
  /** Short Korean caption. `.optional()` (not `.default('')`) so the inferred
   *  result type matches `runJsonRoute`'s output; the route coerces to ''. */
  caption_kr: z.string().max(2000).optional(),
  /** English translation of the caption. Optional; route coerces to ''. */
  caption_en: z.string().max(2000).optional(),
  /** The distinct content words. Capped at 30 (the prompt asks for ~30); an
   *  empty/absent array is valid (no Korean text). Optional; route coerces to
   *  []. NO box field. */
  words: z.array(ImageOcrWordSchema).max(30).optional(),
});
export type ImageOcrResult = z.infer<typeof ImageOcrResultSchema>;

// ---- 3d. generate/scoreGrammarDrill ----------------------------------------
// Grammar PRODUCTION drills (Pass 9, Grammar screen DrillPanel). Given a grammar
// pattern, Claude authors ONE production task of a chosen type (transformation /
// cloze / conversation); the learner answers; Claude then scores the answer.
// Generation uses tool-use (a per-type input_schema); scoring uses tool-use too.

/** The three drill variants (locked decision — all three). Matches the
 *  Postgres CHECK on grammar_drill_attempts.drill_type and the client DrillType. */
export const DrillTypeSchema = z.enum(['transformation', 'cloze', 'conversation']);
export type DrillType = z.infer<typeof DrillTypeSchema>;

/** Score verdict buckets. Matches the grammar_drill_attempts.verdict CHECK and
 *  the client DrillVerdict union. */
export const DrillVerdictSchema = z.enum(['excellent', 'good', 'needs_work', 'incorrect']);
export type DrillVerdict = z.infer<typeof DrillVerdictSchema>;

export const GrammarDrillGenInputSchema = z.object({
  /** Canonical pattern key (the dedup key from the grammar bank). */
  patternKey: NonEmptyText.max(120),
  /** Human-readable display form of the pattern shown to the learner. */
  patternDisplay: NonEmptyText.max(120),
  /** Optional EN summary/title of the pattern's meaning, to anchor the drill. */
  meaning: z.string().trim().max(300).optional(),
  /** Optional KR example of the pattern in use (corpus seed). */
  exampleKr: z.string().trim().max(500).optional(),
  /** Optional EN gloss of that example. */
  exampleEn: z.string().trim().max(500).optional(),
  /** Which variant to author. The ROUTE picks this from attempt history
   *  (rotation) and passes it explicitly — the model never chooses the type. */
  drillType: DrillTypeSchema,
  /** Optional model override. */
  model: z.enum(['haiku', 'sonnet', 'opus']).optional(),
});
export type GrammarDrillGenInput = z.infer<typeof GrammarDrillGenInputSchema>;

/**
 * Fields common to every generated drill item, regardless of type. The
 * `referenceModel*` pair is the model answer and is SERVER-ONLY — the
 * generation route strips it before responding (answer-stripping) and reveals it
 * only after the learner submits. Defined as a plain object spread into each
 * member of the discriminated union below.
 */
const DrillCommon = {
  type: DrillTypeSchema,
  patternKey: NonEmptyText.max(120),
  patternDisplay: NonEmptyText.max(120),
  /** EN, "what to do" — the task instruction shown above the answer box. */
  instruction: NonEmptyText.max(400),
  /** The reference model answer (KR). SERVER-ONLY — stripped from gen response. */
  referenceModelKr: NonEmptyText.max(600),
  /** EN gloss of the reference model answer. SERVER-ONLY — stripped from gen. */
  referenceModelEn: NonEmptyText.max(600),
};

/**
 * A generated drill item. Discriminated on `type` so each variant carries only
 * its own task fields — the tool-use input_schema the prompt forces must match
 * the per-type member exactly or the output parse fails.
 */
export const GrammarDrillItemSchema = z.discriminatedUnion('type', [
  z.object({
    ...DrillCommon,
    type: z.literal('transformation'),
    /** Base KR sentence NOT using the pattern; the learner rewrites it. */
    sourceKr: NonEmptyText.max(500),
    /** EN gloss of the base sentence. */
    sourceEn: NonEmptyText.max(500),
  }),
  z.object({
    ...DrillCommon,
    type: z.literal('cloze'),
    /** The situation the seed sentence sits in. */
    context: NonEmptyText.max(500),
    /** Seed KR sentence containing ONE blank `___` where the pattern goes. */
    seedKr: NonEmptyText.max(500),
  }),
  z.object({
    ...DrillCommon,
    type: z.literal('conversation'),
    /** The conversational scenario framing. */
    scenario: NonEmptyText.max(500),
    /** The interlocutor's KR line the learner replies to. */
    promptKr: NonEmptyText.max(500),
    /** EN gloss of that line. */
    promptEn: NonEmptyText.max(500),
  }),
]);
export type GrammarDrillItem = z.infer<typeof GrammarDrillItemSchema>;

export const GrammarDrillScoreInputSchema = z.object({
  /** Which variant was drilled (controls how the prompt frames the grading). */
  drillType: DrillTypeSchema,
  /** The pattern the learner was meant to produce. */
  patternDisplay: NonEmptyText.max(120),
  /** The rendered task text (source | context+seed | scenario+prompt) — grading
   *  context so the scorer sees what the learner was responding to. */
  promptText: NonEmptyText.max(1200),
  /** The reference model answer (KR) — the scorer compares against this. */
  referenceModelKr: NonEmptyText.max(600),
  /** The learner's submitted answer (KR). Treated as DATA, never instructions. */
  userAnswer: NonEmptyText.max(600),
  /** Optional model override. */
  model: z.enum(['haiku', 'sonnet', 'opus']).optional(),
});
export type GrammarDrillScoreInput = z.infer<typeof GrammarDrillScoreInputSchema>;

export const GrammarDrillScoreSchema = z.object({
  /** Overall score 0..100 (naturalness + accuracy). */
  score: z.number().min(0).max(100),
  /** Verdict bucket derived from the score + pattern usage. */
  verdict: DrillVerdictSchema,
  /** Did the answer actually use the target pattern? false → score low. */
  usesPattern: z.boolean(),
  /** EN, overall feedback shown to the learner. */
  summary: NonEmptyText.max(800),
  /** Specific corrections, each citing a verbatim KR fragment. Capped at 5;
   *  defaults to [] so a flawless answer yields an empty list, not a missing
   *  field. (Uses the systemically-fixed `.default()` quirk — the inferred type
   *  carries corrections as a required array post-default.) */
  corrections: z
    .array(
      z.object({
        span: NonEmptyText.max(200),
        issue: NonEmptyText.max(300),
        fix: NonEmptyText.max(300),
      }),
    )
    .max(5)
    .default([]),
});
export type GrammarDrillScore = z.infer<typeof GrammarDrillScoreSchema>;

// ---- 3e. generateWritingPrompt / generateStory -------------------------------
// The Claude GENERATION engine (F-027 Today-writing-tile, F-073 Writing-page
// generate, F-068 reading short-story generate). Writing prompts are EPHEMERAL
// (returned inline, never persisted — the learner's response persists later via
// writing_attempts); stories are persisted to generated_stories (migration 054)
// by the route, so the reading page can list and re-open them.

/** The two prompt-generation modes: 'topik' authors a TOPIK II Q53/Q54-style
 *  task against the given rubric; 'general' authors a free-write prompt. */
export const WritingPromptModeSchema = z.enum(['topik', 'general']);
export type WritingPromptMode = z.infer<typeof WritingPromptModeSchema>;

export const WritingPromptGenInputSchema = z.object({
  /** Which flavor of prompt to author. */
  mode: WritingPromptModeSchema,
  /** TOPIK rubric to target when mode='topik' (defaults to Q54 at the route).
   *  Meaningless for mode='general' — the route rejects that combination. */
  rubric: TopikRubricSchema.optional(),
  /** Optional model override. */
  model: z.enum(['haiku', 'sonnet', 'opus']).optional(),
});
export type WritingPromptGenInput = z.infer<typeof WritingPromptGenInputSchema>;

export const WritingPromptResultSchema = z.object({
  /** The writing prompt itself (Korean) — what the learner writes toward. */
  promptKr: NonEmptyText.max(1000),
  /** English gloss of the prompt (so the learner can confirm understanding). */
  promptEn: NonEmptyText.max(1000),
  /** Target-length hint, e.g. '200-300자'. `.optional()` (not `.default('')`)
   *  so the inferred result type matches `runJsonRoute`'s output; the route
   *  coerces a missing hint to null on the wire. */
  lengthHint: z.string().trim().max(100).optional(),
});
export type WritingPromptResult = z.infer<typeof WritingPromptResultSchema>;

/** Story target bands: the generatable proficiency levels. 'basic' is a legacy
 *  corpus CONTENT tag, never a generation target (same stance as
 *  DiagnosticTargetLevelSchema) — though the DB column (proficiency_level)
 *  could store it, the API never asks for it. */
export const StoryLevelSchema = z.enum(['L1', 'L2', 'L3', 'L4', 'L5+']);
export type StoryLevel = z.infer<typeof StoryLevelSchema>;

export const StoryGenInputSchema = z.object({
  /** Proficiency band to write the story at. */
  level: StoryLevelSchema,
  /** Optional user-supplied topic ("a cat who runs a café"). Free text —
   *  sanitized + wrapped as untrusted data by the proxy. */
  topic: z.string().trim().min(1).max(500).optional(),
  /** Optional model override. */
  model: z.enum(['haiku', 'sonnet', 'opus']).optional(),
});
export type StoryGenInput = z.infer<typeof StoryGenInputSchema>;

export const StoryResultSchema = z.object({
  /** Story title (Korean). Bounded UNDER the DB CHECK ceiling (300) so a
   *  schema-valid result can always persist. */
  title: NonEmptyText.max(200),
  /** The story body (Korean). Bounded UNDER the DB CHECK ceiling (20000). */
  bodyKo: NonEmptyText.max(6000),
});
export type StoryResult = z.infer<typeof StoryResultSchema>;

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

// ---- 4b. nameConversation ----------------------------------------------------
// F-036 conversation auto-naming: given the opening exchange of a conversation,
// produce a concise content-derived title (Claude-web style, never "mode +
// date"). Non-streaming, haiku-tier by default. The route truncates history
// before calling; these caps are the hard ceiling.

export const NameConversationInputSchema = z.object({
  /** The turns to derive the title from — typically the first exchange.
   *  At least one turn (naming an empty conversation is a route-level 409). */
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: NonEmptyText.max(4000),
      }),
    )
    .min(1)
    .max(12),
  /** Conversation mode — a hint only (a business chat titles differently from
   *  a TOPIK drill). Optional so callers without it still get a title. */
  mode: ConversationModeSchema.optional(),
  /** Optional model override. */
  model: z.enum(['haiku', 'sonnet', 'opus']).optional(),
});
export type NameConversationInput = z.infer<typeof NameConversationInputSchema>;

export const ConversationTitleSchema = z.object({
  /** The generated title. Short by instruction; the cap is the enforcement.
   *  Bounded WELL below the DB CHECK (200 chars, migration 055) so a stored
   *  title can never trip the constraint. */
  title: NonEmptyText.max(80),
});
export type ConversationTitle = z.infer<typeof ConversationTitleSchema>;

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
