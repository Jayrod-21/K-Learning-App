/**
 * Domain types — shapes the mock loaders return and the screens consume.
 *
 * Source of truth: `Claude Design/design_handoff_korean_master/data.js`.
 * These mirror the prototype's data.js fixtures verbatim where possible. When
 * the server lands (Pass 3+) the endpoint response bodies MUST match these.
 *
 * Constraints honoured:
 *   - String unions everywhere (no enums) — `erasableSyntaxOnly`.
 *   - All multi-prop types are `interface` so consumers can `import type`
 *     under `verbatimModuleSyntax`.
 *   - Optional fields use `?` not `| undefined` so callers can omit them in
 *     fixtures and the structural typing stays loose where the prototype
 *     is loose.
 *
 * What we deliberately do NOT do:
 *   - No runtime zod validation. The mock files own the data and the type
 *     IS the contract. When real endpoints arrive in Pass 3+, the wire layer
 *     will validate at the boundary and these interfaces remain the canonical
 *     in-app shape.
 */

// ─────────────────────────────────────────────────────────────
// Shared primitives
// ─────────────────────────────────────────────────────────────

/** TOPIK level band. `basics` is for L1/L2 reference entries. */
export type ProficiencyLevel = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';

/** Composite level strings the design uses for transitional content. */
export type LevelLabel = ProficiencyLevel | 'L3→L4' | 'L4–5' | 'L4-5' | 'L3-4' | 'L3–4';

/** Korean POS tags used in glosses. Prototype uses dot suffix. */
export type PartOfSpeech = 'n.' | 'v.' | 'adj.' | 'adv.' | 'pn.' | 'n./adv.';

/** TOPIK section labels (Korean). */
export type TopikSection = '읽기' | '듣기' | '쓰기';

/** Vocab card SRS state. Prototype only tracks 3 states. */
export type CardState = 'new' | 'practicing' | 'banked' | 'produced';

/** Hanja study state — same 3 states as the index filter chips. */
export type HanjaState = 'new' | 'practicing' | 'banked';

/** Reference index entry kind. */
export type ReferenceKind = 'vocab' | 'grammar' | 'hanja';

/** Vocab list kind — what the list contains. */
export type VocabListKind = 'vocab' | 'grammar' | 'hanja' | 'mixed';

/** Diagnostic item kind — drives the screen's render branch. */
export type DiagnosticItemKind =
  | 'cloze'
  | 'synonym'
  | 'pattern'
  | 'passage-mc'
  | 'inference'
  | 'audio-mc';

/** Conversation role — tutor uses formal 합쇼체, user is the learner. */
export type ConversationRole = 'tutor' | 'user';

// ─────────────────────────────────────────────────────────────
// Vocab
// ─────────────────────────────────────────────────────────────

/** Extra example sentence pair attached to a vocab card. */
export interface VocabExample {
  kr: string;
  en: string;
}

/** Vocab card — mirrors `VOCAB[]` in data.js. */
export interface Vocab {
  id: string;
  kr: string;
  pos: PartOfSpeech;
  en: string;
  ex_kr: string;
  ex_en: string;
  notes?: string;
  extra?: VocabExample[];
  /** Provenance — where the learner mined this card from. */
  mined_in?: string;
}

// ─────────────────────────────────────────────────────────────
// Grammar
// ─────────────────────────────────────────────────────────────

/** Grammar production drill — context + seed + model answer. */
export interface GrammarDrill {
  context: string;
  seed: string;
  model: string;
  model_en: string;
}

/** Grammar pattern — mirrors `GRAMMAR[]` in data.js. */
export interface GrammarPattern {
  id: string;
  pattern: string;
  title: string;
  desc: string;
  ex_kr: string;
  ex_en: string;
  state: CardState;
  notes?: string;
  contrast?: string;
  examples?: VocabExample[];
  drill?: GrammarDrill;
}

// ─────────────────────────────────────────────────────────────
// Reading passage
// ─────────────────────────────────────────────────────────────

/** Gloss attached to a tapword token — opens WordPopover on tap. */
export interface PassageGloss {
  kr: string;
  pos: PartOfSpeech;
  en: string;
  ex_kr: string;
  ex_en: string;
}

/**
 * Passage token. Each token is one render unit in the KoreanPassage.
 *
 *   - `w`   — visible text (always present; may be a space, punct, or word).
 *   - `gloss` — when present, the token is a tapword; click opens popover.
 *   - `vid` — vocab id link, or `null` for "not in user bank yet".
 *   - `span` — grammar-span marker (`{gid}-start | -mid | -end`); the run of
 *              tokens between matching start/end renders as a single highlight.
 */
export interface PassageToken {
  w: string;
  gloss?: PassageGloss;
  vid?: string | null;
  span?: string;
  mined?: boolean;
}

/** One sentence in a passage — KR tokens + EN translation line. */
export interface PassageSentence {
  en: string;
  tokens: PassageToken[];
}

/** Reading passage — mirrors `READING_PASSAGE` in data.js. */
export interface ReadingPassage {
  title: string;
  level: string;
  meta: string;
  sentences: PassageSentence[];
}

// ─────────────────────────────────────────────────────────────
// TOPIK
// ─────────────────────────────────────────────────────────────

/** One choice in a TOPIK multiple-choice item. */
export interface TopikChoice {
  id: string;
  kr: string;
  en: string;
  correct: boolean;
}

/**
 * TOPIK item — mirrors `TOPIK_ITEM` in data.js.
 *
 * `id` is the server row id as a string (`topik_items.id::text`). The Pass-2
 * fixture predated the live endpoint and had no stable id; Pass 6 adds it so
 * the Study flow can stamp `recordTopikAnswer(item.id, …)` against a real
 * row. Study mode keeps the inline `correct` flag on each option — TOPIK items
 * are public reference data, so the answer is served inline (the Mock-Test
 * answer-stripped flow is deferred to FU-NF-39).
 */
export interface TopikItem {
  id: string;
  section: TopikSection;
  number: number;
  level: number;
  prompt: string;
  passageRef?: string;
  options: TopikChoice[];
  explanation: string;
}

/**
 * Server reveal after recording one study answer — `POST /topik/:itemId/answer`.
 *
 * In Study mode the client already knows the correct choice (it lives inline on
 * the item), so this result is primarily an analytics acknowledgement; the
 * screen reveals correctness off the item itself and treats the record call as
 * fire-and-forget. The shape mirrors the server's grade so a future answer-
 * stripped Mock-Test flow (FU-NF-39) can reuse it as the authoritative reveal.
 */
export interface TopikAnswerResult {
  correct: boolean;
  correctChoiceId: string;
  explanation: string;
}

// ─────────────────────────────────────────────────────────────
// Diagnostic
// ─────────────────────────────────────────────────────────────

/** One dimension in the skills snapshot — score 0–100. */
export interface DiagnosticDimension {
  // `grammar` was added in Pass 5 when the diagnostic went live: the server
  // now scores reading/listening/vocab/grammar. `writing` stays in the union
  // for forward-compat (Pass 8 wires it) even though the server omits it today.
  key: 'reading' | 'listening' | 'writing' | 'vocab' | 'grammar';
  label: string;
  kr: string;
  score: number;
  note: string;
}

/** Reference line band on the SkillsCompare chart. */
export interface DiagnosticReference {
  id: 'L3' | 'L4' | 'L5' | 'L6' | 'native';
  label: string;
  kr: string;
  value: number;
}

/** Skills snapshot — drives SkillsCompare on Today + Diagnostic Results. */
export interface DiagnosticSnapshot {
  dimensions: DiagnosticDimension[];
  references: DiagnosticReference[];
  /** Default selected ref. */
  defaultRef: DiagnosticReference['id'];
  goals: string[];
}

/** One audio payload attached to a listening item. */
export interface DiagnosticAudio {
  duration: number;
  transcript: string;
}

/** One choice on a diagnostic item — no `correct` flag (kept server-side). */
export interface DiagnosticChoice {
  id: string;
  kr: string;
  en: string;
}

/** The section a diagnostic item exercises. */
export type DiagnosticSection = 'vocab' | 'grammar' | 'reading' | 'listening';

/** The proficiency band the server serves a live diagnostic item at. */
export type DiagnosticLevel = 'L3' | 'L4' | 'L5+';

/**
 * A live diagnostic item as the client receives it from the server.
 *
 * SECURITY (answer-tampering defense): this type intentionally has **no
 * `answer` field**. The diagnostic is graded server-side; the correct choice
 * id lives only in the `diagnostic_responses.correct_answer` column and is
 * never sent to the client before the user answers. The reveal arrives in the
 * `/answer` response's `DiagnosticAnswerResult` — never on the item itself.
 * Reintroducing an `answer` field here would re-enable client-side grading and
 * leak the key, so it is deliberately omitted.
 */
export interface DiagnosticLiveItem {
  /** Server response row id — echoed back on `/answer` to bind the grade. */
  responseId: number;
  /** 1-based position within the run. */
  ordinal: number;
  section: DiagnosticSection;
  level: DiagnosticLevel;
  kind: DiagnosticItemKind;
  prompt: string;
  hint?: string;
  passage?: string;
  underline?: string;
  audio?: DiagnosticAudio;
  choices: DiagnosticChoice[];
}

/** Server's reveal after grading one answer — the only place the key surfaces. */
export interface DiagnosticAnswerResult {
  correct: boolean;
  /** The correct choice id, revealed only after the user answers. */
  correctAnswer: string;
  explain: string;
}

/** Progress within a run — drives the progressbar's ARIA values. */
export interface DiagnosticProgress {
  ordinal: number;
  total: number;
}

/** `POST /diagnostic` — starts a run and serves item 1. */
export interface DiagnosticStartResponse {
  runId: number;
  item: DiagnosticLiveItem;
  progress: DiagnosticProgress;
}

/**
 * `POST /diagnostic/:runId/answer` — grades the current item.
 *
 * `next` is the following live item, or `null` when the graded item was the
 * last one (the client then calls `/finish`).
 */
export interface DiagnosticAnswerResponse {
  result: DiagnosticAnswerResult;
  next: DiagnosticLiveItem | null;
  progress: DiagnosticProgress;
}

// ─────────────────────────────────────────────────────────────
// Today plan
// ─────────────────────────────────────────────────────────────

/** One task card on the Today screen. */
export interface TodayTask {
  title: string;
  mins: number;
  level: LevelLabel;
  tag: 'Reading' | 'Listening' | 'Writing';
}

/**
 * Today plan. Originally mirrored `TODAY` in data.js; Pass 4 wires it to
 * `GET /plan/today`.
 *
 * Each content task is `TodayTask | null` because the server genuinely may
 * have no content for a modality (an empty corpus) — the screen renders the
 * tiles that resolved and skips the nulls rather than faking a card.
 *
 * `largestGap` names the user's weakest of the three modalities (from their
 * latest diagnostic snapshot); it drives which tile wears the "Largest gap"
 * highlight. `null` when the user has no diagnostic snapshot yet — the screen
 * falls back to highlighting Listening (the design's default emphasis).
 */
export interface TodayPlan {
  reviewCount: number;
  reading: TodayTask | null;
  listening: TodayTask | null;
  writing: TodayTask | null;
  largestGap: TodayTask['tag'] | null;
}

// ─────────────────────────────────────────────────────────────
// Conversation
// ─────────────────────────────────────────────────────────────

/** One tutor/user turn — bilingual line. */
export interface ConversationMessage {
  role: ConversationRole;
  kr: string;
  en: string;
}

/** Whole chat thread the screen renders. */
export type Conversation = ConversationMessage[];

// ─────────────────────────────────────────────────────────────
// Reference
// ─────────────────────────────────────────────────────────────

/** One row in the global reference index. */
export interface ReferenceEntry {
  kind: ReferenceKind;
  kr: string;
  en: string;
  level: LevelLabel;
  /** True for beginner items grouped under "Basics". */
  basics?: boolean;
}

// ─────────────────────────────────────────────────────────────
// Vocab lists
// ─────────────────────────────────────────────────────────────

/** Per-user custom vocab list — `lists.custom[]`. */
export interface CustomVocabList {
  id: string;
  name: string;
  en: string;
  kind: VocabListKind;
  count: number;
  mature: number;
  due: number;
  lastStudied: string;
  preview: string[];
}

/** One row inside a textbook-source's list group. */
export interface SourceVocabListItem {
  id: string;
  name: string;
  en: string;
  count: number;
  level: LevelLabel;
  /** How many cards from this list the user has banked. */
  added: number;
  complete?: boolean;
}

/** A textbook / source group of pre-built lists. */
export interface SourceVocabGroup {
  source: string;
  publisher: string;
  /** Single-character cover stamp (한 / 문 / 연 / 뉴). */
  cover: string;
  kind: VocabListKind;
  lists: SourceVocabListItem[];
}

/** Whole vocab-lists bundle. */
export interface VocabListBundle {
  /** Currently active custom list id (drives the Session queue). */
  active: string;
  custom: CustomVocabList[];
  sources: SourceVocabGroup[];
}

// ─────────────────────────────────────────────────────────────
// Hanja
// ─────────────────────────────────────────────────────────────

/** A single hanja compound word that uses this character. */
export interface HanjaCompound {
  kr: string;
  han: string;
  en: string;
  /** The other hanja in this compound — drives the "+ <other>" hint. */
  with: string;
}

/** Hanja character — mirrors `HANJA[]` in data.js. */
export interface Hanja {
  id: string;
  /** The character itself. */
  ch: string;
  /** Korean reading (sino-Korean). */
  sound: string;
  /** Korean gloss (native Korean meaning marker). */
  gloss: string;
  /** English gloss. */
  en: string;
  level: LevelLabel;
  strokes: number;
  state: HanjaState;
  note: string;
  compounds: HanjaCompound[];
}

/** Aggregate hanja progress — drives the Encountered band card. */
export interface HanjaProgress {
  banked: number;
  practicing: number;
  new: number;
  /** Rough working count of L4 hanja. */
  targetL4: number;
  /** How many of the targetL4 set the user has encountered. */
  encountered: number;
  note: string;
}

// ─────────────────────────────────────────────────────────────
// Settings (palette + notif intents)
// ─────────────────────────────────────────────────────────────

/** Paper preset — base surface palette family. */
export type PaperPreset = 'hanji' | 'ivory' | 'linen' | 'sumi';
/** Accent preset — primary accent color family. */
export type AccentPreset = 'vermilion' | 'indigo' | 'plum' | 'ochre';
/** Correct-state preset — success/affirmative color family. */
export type CorrectPreset = 'moss' | 'pine' | 'teal';
/** Wrong-state preset — danger/incorrect color family. */
export type WrongPreset = 'vermilion' | 'amber' | 'slate';

/** Palette choices (subset of Settings.palette). */
export interface PalettePrefs {
  paper: PaperPreset;
  accent: AccentPreset;
  correct: CorrectPreset;
  wrong: WrongPreset;
}

/** Notification channel + cadence intents (server only persists intent). */
export interface NotifPrefs {
  channel: { email: boolean; sms: boolean };
  reviewsDue: boolean;
  daily: boolean;
  weekly: boolean;
}

/** Full Settings shape — `localStorage["km.settings"]` AND `/settings`. */
export interface Settings {
  name: string;
  email: string;
  phone: string;
  notif: NotifPrefs;
  palette: PalettePrefs;
}

// ─────────────────────────────────────────────────────────────
// Server wire shapes (Pass 3)
// ─────────────────────────────────────────────────────────────
//
// Below are the shapes the real server endpoints emit / accept. Kept
// separate from the prototype-mirroring fixture types above so existing
// mock loaders and screens (which speak the fixture shapes) keep
// compiling. The service modules in `src/services/*` translate at the
// boundary where the in-app shape and the wire shape differ.

/** Reading corpus the server supports for `/reading/units`. */
export type ReadingCorpus = 'ttmik' | 'iyagi';

/** Server-side reading-unit row (corpus-tagged via the query). */
export interface ReadingUnit {
  id: number;
  /** Present for TTMIK lessons. */
  lesson_level?: number;
  /** Present for TTMIK lessons. */
  lesson_number?: number;
  /** Present for Iyagi episodes. */
  episode_number?: number;
  /** Present for Iyagi episodes. */
  hosts?: string[];
  title: string;
}

/** One sentence in a reading unit as the server emits it. */
export interface ReadingSentenceRow {
  id: number;
  ordinal: number;
  korean: string;
  english: string | null;
  romanization: string | null;
  speaker: string | null;
  is_dialog: boolean;
}

/** Envelope for `GET /reading/units/:corpus/:unitId/sentences`. */
export interface ReadingSentences {
  corpus: ReadingCorpus;
  unit_id: number;
  sentences: ReadingSentenceRow[];
}

/** One token in a `/lemmatize` response — mirrors Kiwi's output schema. */
export interface LemmaToken {
  form: string;
  lemma: string;
  tag: string;
  start: number;
  length: number;
}

/** Envelope returned by `POST /lemmatize`. */
export interface LemmatizeResponse {
  tokens: LemmaToken[];
}

/** One KRDICT entry returned by `GET /define`. */
export interface DefineEntry {
  id: number;
  headword: string;
  part_of_speech: string | null;
  /** JSONB — sense list. Shape owned by B2 (KRDICT loader). */
  senses: unknown;
  /** JSONB — example list. Shape owned by B2. */
  examples: unknown;
}

/** Envelope returned by `GET /define`. */
export interface DefineResult {
  word: string;
  entries: DefineEntry[];
}

/** Body accepted by `POST /enrich`. */
export interface EnrichRequest {
  lemma: string;
  sourceSentence: string;
  context?: string;
  krdictGloss?: string;
}

/** Result shape from `POST /enrich` — B4 controls the inner shape. */
export interface EnrichResult {
  result: unknown;
  metadata?: Record<string, unknown>;
}

/** Vocab corpus identifiers the server accepts. */
export type VocabCorpus = 'vocab_2000_beginner' | 'vocab_2000_intermediate';

/** Server proficiency band names — distinct from the design's `LevelLabel`. */
export type ServerProficiency = 'basic' | 'L3' | 'L4' | 'L5+';

/** Row returned by `GET /vocab/entries`. */
export interface VocabEntry {
  id: number;
  corpus: string;
  korean: string | null;
  english: string | null;
  proficiency: string | null;
  theme: string | null;
}

/** Full vocab entry returned by `GET /vocab/entries/:entryId`. */
export interface VocabEntryDetail extends VocabEntry {
  source_id: string | null;
  pronunciation: string | null;
  hanja: string | null;
  part_of_speech: string | null;
  subsection: string | null;
  example_korean: string | null;
  example_english: string | null;
  tips: unknown;
  cross_refs: unknown;
  notes: unknown;
}

/** Envelope for `GET /vocab/entries`. */
export interface VocabEntriesPage {
  entries: VocabEntry[];
  limit: number;
  offset: number;
}

/** One due card row from `GET /vocab/cards/due`. */
export interface DueCard {
  id: number;
  face: string;
  due_at: string;
  stability: string;
  difficulty: string;
  fsrs_state: string;
  /**
   * Optimistic-concurrency version snapshot — must be echoed back in the
   * `expected_version` field of `submitReview`. The server bumps this on
   * every successful review, so re-rating without re-fetching produces a
   * legitimate 409 (the client is rating a stale snapshot).
   */
  version: number;
  vocab_entry_id: number | null;
  grammar_entry_id: number | null;
  source_sentence_id: number | null;
  topik_item_id: number | null;
}

/** FSRS rating button. */
export type FsrsRating = 'again' | 'hard' | 'good' | 'easy';
/** FSRS card state — wire shape. */
export type FsrsState = 'new' | 'learning' | 'review' | 'relearning';

/** Body accepted by `POST /vocab/cards/:id/reviews`. */
export interface ReviewSubmission {
  rating: FsrsRating;
  state_before: FsrsState;
  stability_before: number;
  difficulty_before: number;
  elapsed_days_before: number;
  state_after: FsrsState;
  stability_after: number;
  difficulty_after: number;
  scheduled_days_after: number;
  duration_ms?: number;
  expected_version: number;
}

/** Result envelope from `POST /vocab/cards/:id/reviews`. */
export interface ReviewResult {
  version: number;
  due_at: string;
}

/** Body for `POST /vocab/cards/init` — seeds a slice of recognition cards. */
export interface InitCardsBody {
  corpus: VocabCorpus;
  proficiency?: ServerProficiency;
  limit?: number;
}

/** Result envelope from `POST /vocab/cards/init`. */
export interface InitCardsResult {
  inserted: number;
}

// ── Vocab lists (Pass 3A — server routes land alongside this client wiring) ──

/** Body for `POST /vocab/lists`. */
export interface CreateListBody {
  name: string;
  kind: VocabListKind;
  description?: string;
}

/** Body for `PATCH /vocab/lists/:id`. */
export interface PatchListBody {
  name?: string;
  description?: string;
}

/** Server-side list row — Pass 3A wire shape. */
export interface ServerVocabList {
  id: number;
  name: string;
  kind: VocabListKind;
  description: string | null;
  entry_count: number;
  created_at: string;
  updated_at: string;
}

/** Envelope for `GET /vocab/lists`. */
export interface ListListsResponse {
  lists: ServerVocabList[];
}

/** Envelope for `POST /vocab/lists/:id/entries`. */
export interface AddListEntriesResult {
  added: number;
}

// ── Grammar wire shapes ──────────────────────────────────────────────

/** Server-side KGIU entry summary. */
export interface KgiuEntrySummary {
  id: number;
  corpus: string;
  source_id: string | null;
  pattern: string;
  title_en: string | null;
  category: string | null;
  proficiency: string | null;
  unit: string | null;
  source_pages: unknown;
}

/** Server-side KGIU entry detail. */
export interface KgiuEntryDetail extends KgiuEntrySummary {
  explanation: string | null;
  formation_rules: unknown;
  examples: unknown;
  dialogues: unknown;
  vocabulary: unknown;
  tips: unknown;
  compare_with: unknown;
  exercises: unknown;
  cultural_notes: unknown;
}

/** Envelope for `GET /grammar/kgiu`. */
export interface KgiuListResponse {
  entries: KgiuEntrySummary[];
}

/** Register label set (Korean speech-style names). */
export type RegisterLevel =
  | '반말'
  | '해요체'
  | '합쇼체'
  | '문어체'
  | '하오체'
  | '하게체';

/** How the user arrived at this banked grammar pattern. */
export type DiscoveredVia =
  | 'manual'
  | 'reading_highlight'
  | 'listening_highlight'
  | 'topik_item'
  | 'diagnostic'
  | 'conversation'
  | 'import';

/** Body for `POST /grammar/bank`. */
export interface BankGrammarBody {
  pattern_key: string;
  pattern_display: string;
  summary_en: string;
  proficiency: ServerProficiency;
  category: string;
  register?: RegisterLevel;
  discovered_via?: DiscoveredVia;
  notes?: Record<string, unknown>;
}

/** Envelope for `GET /grammar/bank`. */
export interface BankedGrammarRow {
  id: number;
  pattern_key: string;
  pattern_display: string;
  summary_en: string;
  proficiency: string;
  category: string;
  register: string | null;
  discovered_via: string;
  created_at: string;
}

/** Envelope for `GET /grammar/bank`. */
export interface BankedGrammarList {
  entries: BankedGrammarRow[];
}

/** Body for `POST /grammar/identify`. */
export interface IdentifyPatternBody {
  highlightSpan: string;
  fullSentence: string;
  contextHint?: string;
}

/** Result envelope from `POST /grammar/identify` — B4-owned. */
export interface PatternMatch {
  result: unknown;
  metadata?: Record<string, unknown>;
}

// ── Grammar production-drill wire shapes (Pass 9) ─────────────────────
//
// The drill flow is a three-leg server round-trip:
//   1. `POST /grammar-drill`            → `GeneratedDrill` (a `DrillItemPublic`
//      + the `attemptId` that binds the eventual score). The server picks the
//      `DrillType` by history rotation; the client never asks for a type.
//   2. user types a Korean production answer.
//   3. `POST /grammar-drill/:id/submit` → `DrillScore` (the Claude grade plus
//      the reference model, revealed only now).
//
// `DrillItemPublic` deliberately MIRRORS the server's `GrammarDrillItem` Zod
// union MINUS the two `referenceModel*` fields. Those fields are the "answer":
// the server stores them on the attempt row and strips them from the generate
// response, exactly like the diagnostic's answer-stripping (`DiagnosticLiveItem`
// above). Re-adding them here would leak the model answer before submit and
// re-enable a client that paints the answer without grading — so they are
// intentionally absent until the `DrillScore` reveal.

/** Production-drill format. Drives the `DrillCard` render branch. */
export type DrillType = 'transformation' | 'cloze' | 'conversation';

/** Claude's overall verdict band for a graded drill answer. */
export type DrillVerdict = 'excellent' | 'good' | 'needs_work' | 'incorrect';

/**
 * Fields every drill item carries regardless of `type`. The `referenceModel*`
 * pair lives ONLY on the server's `GrammarDrillItem` — it is stripped before
 * the item reaches the client, so it is absent from this public shape.
 */
interface DrillItemCommon {
  type: DrillType;
  /** Server dedup key for the source pattern. */
  patternKey: string;
  /** Korean pattern display ("-더라도"). */
  patternDisplay: string;
  /** EN "what to do" line shown above the textarea. */
  instruction: string;
}

/** Transformation drill — rewrite a base sentence using the pattern. */
export interface TransformationDrillItem extends DrillItemCommon {
  type: 'transformation';
  /** Base Korean sentence that does NOT yet use the pattern. */
  sourceKr: string;
  /** English gloss of the base sentence. */
  sourceEn: string;
}

/** Cloze drill — fill a `___` blank in a seed sentence with the pattern. */
export interface ClozeDrillItem extends DrillItemCommon {
  type: 'cloze';
  /** EN situation framing the blank. */
  context: string;
  /** Korean seed sentence containing one `___` blank. */
  seedKr: string;
}

/** Conversation drill — reply to an interlocutor's line using the pattern. */
export interface ConversationDrillItem extends DrillItemCommon {
  type: 'conversation';
  /** EN scenario describing who is speaking and why. */
  scenario: string;
  /** The interlocutor's Korean line. */
  promptKr: string;
  /** English gloss of the interlocutor's line. */
  promptEn: string;
}

/**
 * Public drill item — discriminated union by `type`. This is the answer-
 * stripped shape the client receives from `POST /grammar-drill`; the server's
 * full `GrammarDrillItem` additionally carries `referenceModelKr/En`.
 */
export type DrillItemPublic =
  | TransformationDrillItem
  | ClozeDrillItem
  | ConversationDrillItem;

/** One inline correction Claude attaches to a graded answer. */
export interface DrillCorrection {
  /** Verbatim Korean fragment the issue applies to. */
  span: string;
  /** What's wrong with that fragment. */
  issue: string;
  /** The suggested fix. */
  fix: string;
}

/**
 * Server's reveal after grading a submitted drill answer — the only place the
 * reference model surfaces (it is stripped from the generate response).
 */
export interface DrillScore {
  /** 0–100. */
  score: number;
  verdict: DrillVerdict;
  /** Whether the answer actually used the target pattern. */
  usesPattern: boolean;
  /** EN overall feedback. */
  summary: string;
  corrections: DrillCorrection[];
  /** The model answer in Korean — revealed only post-submit. */
  referenceModelKr: string;
  /** English gloss of the model answer. */
  referenceModelEn: string;
}

// ── Progress wire shapes ──────────────────────────────────────────────

/** One metric snapshot from `GET /progress`. */
export interface ProgressMetric {
  metric_type: string;
  value: unknown;
  captured_at: string;
}

/** Envelope for `GET /progress`. */
export interface ProgressResponse {
  metrics: ProgressMetric[];
}

/** Body for `PUT /progress/:metricType`. */
export interface UpdateMetricBody {
  value: string | number | Record<string, unknown>;
}

/** Result envelope for `PUT /progress/:metricType`. */
export interface MetricSnapshot {
  id: number;
  captured_at: string;
}

/** Body for `POST /progress/study-log`. */
export interface StudyLogBody {
  minutes: number;
  activity: string | Record<string, unknown>;
  /** YYYY-MM-DD; defaults to today if omitted. */
  date?: string;
}

/** Result envelope for `POST /progress/study-log`. */
export interface StudyLogResult {
  id: number;
  /** Postgres numeric — server returns it as a string. */
  minutes_studied: string;
}

// ── Conversation wire shapes ──────────────────────────────────────────

/** Modes the server accepts when starting a conversation. */
export type ConversationMode =
  | 'casual'
  | 'business'
  | 'research'
  | 'topik_prep'
  | 'register_drill';

/** Body for `POST /conversation`. */
export interface StartConversationBody {
  mode: ConversationMode;
  target_register?: RegisterLevel | null;
}

/** Envelope from `POST /conversation`. */
export interface StartConversationResult {
  conversation: { id: number };
}

/** Body for `POST /conversation/:id/messages`. */
export interface AppendMessageBody {
  content: string;
  expected_version: number;
}

/** Result envelope from `POST /conversation/:id/messages`. */
export interface AppendMessageResult {
  version: number;
  messages: unknown;
}

/** One row from `GET /conversation`. */
export interface ConversationRow {
  id: number;
  mode: string;
  target_register: string | null;
  version: number;
  updated_at: string;
  message_count: number;
}

/** Envelope for `GET /conversation`. */
export interface ConversationsList {
  conversations: ConversationRow[];
}

/** Auth `/auth/me` and PATCH envelope. */
export interface AuthMeResponse {
  user: {
    id: number;
    email: string;
    display_name?: string;
    phone?: string;
    /**
     * Optimistic-concurrency version snapshot. Required on every PATCH so
     * the server can refuse a stale write with 409. See ADR-002 + SECURITY.md
     * §10.1 (server) and `services/auth.ts` `patchMe`. Optional in the wire
     * type so legacy fixtures without it still typecheck; runtime code paths
     * that mutate the user MUST read the live value.
     */
    version?: number;
  };
}

/**
 * Body for `PATCH /auth/me` (Pass 3A).
 *
 * `expected_version` is REQUIRED. The server enforces optimistic concurrency
 * via `UPDATE … WHERE id = $1 AND version = $expected` and 409s on mismatch.
 * A client that omits it would 400 at the Zod boundary.
 */
export interface PatchAuthMeBody {
  display_name?: string;
  email?: string;
  phone?: string;
  expected_version: number;
}

// ─────────────────────────────────────────────────────────────
// Images / OCR mining (Pass 8)
// ─────────────────────────────────────────────────────────────

/**
 * One detected content word in an image capture.
 *
 * No bounding box (Pass 8 locked decision): Claude Vision returns reliable
 * word transcription + glosses but NOT precise coordinates, so the capture
 * view renders the real photo plus a tappable word list rather than an
 * overlay. The shape matches the server's `image_words` row projected onto
 * the client (`kr` dictionary form, `en` short gloss, `gloss` fuller gloss,
 * `pos` the POS union).
 */
export interface OcrWord {
  id: string;
  kr: string;
  en: string;
  pos: PartOfSpeech;
  gloss: string;
}

/**
 * One image capture in the user's history — the result of `POST /images/ocr`
 * and the shape `GET /images/:id` returns.
 *
 * `blobUrl` is the relative path to the real image bytes (`/images/:id/blob`),
 * served same-origin with the session cookie. `scene`/`gradient` are
 * mock-only placeholder fields: the prototype's `loadImagesMock` paints a
 * gradient + absolutely-positioned KR text when no real photo exists, so they
 * stay optional and a real capture carries neither.
 */
export interface ImageCapture {
  id: string;
  /** Display name shown in the recent-captures grid. */
  name: string;
  caption_kr: string;
  caption_en: string;
  /** Relative URL to the real image bytes (`/images/:id/blob`). */
  blobUrl: string;
  /** Mock-only: decorative gradient seed for the placeholder render. */
  gradient?: string;
  /** Mock-only: KR text rendered absolutely-positioned in the placeholder. */
  scene?: { text: string; x: number; y: number; size: number }[];
  /** Detected content words. Present on a single-capture fetch / upload result. */
  words: OcrWord[];
  /** ISO timestamp — drives the "today / yesterday / ..." label. */
  capturedAt: string;
}
