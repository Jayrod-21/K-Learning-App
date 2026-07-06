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
  /**
   * The shared reading passage this item is asked about (B-008). TOPIK reading
   * tests pose several questions about one text; the server resolves the
   * passage covering this item's number from `topik_tests.passages` and the
   * screens render it before the choices — without it a fill-blank ㉠ or
   * "윗글의 주제…" item is unanswerable. Absent for self-contained items.
   */
  passage?: string;
  passageRef?: string;
  options: TopikChoice[];
  explanation: string;
  /**
   * True when the original exam item shows image(s) the corpus stores only as
   * a bracketed TEXT description (in the prompt and/or `imageText`) — no image
   * asset exists. The screens render that description prominently with an
   * "image described in text" affordance. Optional so pre-existing fixtures
   * (all non-image) stay valid; the server always sends it.
   */
  hasImage?: boolean;
  /** Curated text description of the image(s), when the corpus captured one. */
  imageText?: string;
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

// ── TOPIK Mock-Test (FU-NF-39) — server-graded, answer-stripped ──────────

/** Stable choice id on a TOPIK multiple-choice item (`a`|`b`|`c`|`d`). */
export type ChoiceId = 'a' | 'b' | 'c' | 'd';

/**
 * The two MCQ sections the Mock-Test flow supports in v1. Writing
 * (constructed-response) is deferred to FU-NF-47 and is NOT a member of this
 * union — the exam never serves or submits it. The wire normalises Korean
 * labels (읽기/듣기) to this enum server-side; the client speaks the enum.
 */
export type MockSection = 'reading' | 'listening';

/**
 * One choice on a Mock-Test item as the client receives it.
 *
 * SECURITY (answer-tampering defense, mirrors `DiagnosticChoice`): this type
 * intentionally has **no `correct` field**. Mock items are graded server-side
 * on submit (`POST /topik/mock/submit`); the key lives only in the DB and is
 * revealed per item in `MockReveal.correctChoiceId` AFTER the exam ends.
 * Re-adding `correct` here would re-enable client-side grading and leak the
 * answer mid-exam, so it is deliberately omitted (the strip is type-level so a
 * regression cannot compile a leak through).
 */
export interface TopikMockChoice {
  id: ChoiceId;
  kr: string;
  en: string;
}

/**
 * A Mock-Test item — `TopikItem` WITHOUT `options[].correct` and WITHOUT
 * `explanation` (both stripped at the server boundary, revealed only in the
 * submit result). This is the only TOPIK shape the timed exam ever consumes.
 */
export interface TopikMockItem {
  id: string;
  section: TopikSection;
  number: number;
  level: number;
  prompt: string;
  /** See `TopikItem.passage` — the reading text the QUESTION is about. It is
   *  question content (like the prompt itself), never answer data, so it
   *  survives the answer strip; the exam needs it to be answerable (B-008). */
  passage?: string;
  passageRef?: string;
  options: TopikMockChoice[];
  /** See `TopikItem.hasImage` — question metadata, never answer data, so it
   *  survives the answer strip. */
  hasImage?: boolean;
  /** See `TopikItem.imageText`. */
  imageText?: string;
}

/** Envelope returned by `POST /topik/mock` — the answer-stripped exam payload. */
export interface MockTest {
  /** The test the server picked (or echoed) — referenced on submit. */
  sourceTest: number;
  section: MockSection;
  items: TopikMockItem[];
}

/** One graded answer the client submits in `POST /topik/mock/submit`. */
export interface MockSubmitAnswer {
  /** Positive server row id of the item (the `TopikMockItem.id` as a number). */
  itemId: number;
  picked: ChoiceId;
  /** Best-effort time-on-item in ms; omitted when not measured. */
  timeMs?: number;
}

/** Body for `POST /topik/mock/submit`. */
export interface MockSubmitBody {
  sourceTest: number;
  section: MockSection;
  answers: MockSubmitAnswer[];
  /** Best-effort total wall-clock duration of the exam, in ms. */
  durationMs?: number;
}

/**
 * Per-item reveal in the submit result — the only place a mock item's answer
 * surfaces. `picked` is `null` for an item the user skipped (graded incorrect).
 */
export interface MockReveal {
  itemId: number;
  picked: ChoiceId | null;
  correctChoiceId: ChoiceId;
  isCorrect: boolean;
  explanation: string;
}

/** Result envelope from `POST /topik/mock/submit` — server-computed score. */
export interface MockResult {
  sourceTest: number;
  section: MockSection;
  totalItems: number;
  answered: number;
  correct: number;
  /** correct/total × 100, one decimal place (server-computed). */
  percentage: number;
  /** Readiness band headline derived from `percentage` server-side. */
  band: string;
  items: MockReveal[];
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

/**
 * One attempt in the diagnostic history — the `/latest` snapshot shape plus
 * when it was captured. `GET /diagnostic/history` returns these oldest→newest;
 * the Progress screen charts them as the per-dimension trend.
 */
export interface DiagnosticHistorySnapshot extends DiagnosticSnapshot {
  /** ISO-8601 capture timestamp of the finished run. */
  capturedAt: string;
}

/** Envelope returned by `GET /diagnostic/history`. Empty list = no runs yet. */
export interface DiagnosticHistoryResponse {
  snapshots: DiagnosticHistorySnapshot[];
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
 * `POST /diagnostic/:runId/answer` — grades the current item and returns the
 * reveal IMMEDIATELY (B-006: grading never blocks on item generation).
 *
 * `done` is true when the graded item filled the run's last scheduled slot —
 * the client then calls `/finish` without asking for a next item. When `done`
 * is false the client fetches the next item via `POST /:runId/next` during
 * the reveal dwell (see `DiagnosticNextResponse`).
 */
export interface DiagnosticAnswerResponse {
  result: DiagnosticAnswerResult;
  done: boolean;
  progress: DiagnosticProgress;
}

/**
 * `POST /diagnostic/:runId/next` — serves the run's next live item.
 *
 * `next` is `null` when the run is over early (every remaining section pool
 * is empty) or already fully served — the client then calls `/finish`.
 * Idempotent server-side: re-calling while an item is pending re-serves that
 * same item, so a lost response or a double-fired prefetch never burns an
 * extra generation.
 */
export interface DiagnosticNextResponse {
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

/** One KRDICT example sentence returned by `GET /define` (joined in from
 *  `krdict_examples` via the entry's senses, capped server-side). */
export interface DefineExample {
  korean: string;
  /** English translation — KRDICT often omits it on low-frequency senses. */
  english: string | null;
}

/** One KRDICT entry returned by `GET /define`. */
export interface DefineEntry {
  id: number;
  headword: string;
  part_of_speech: string | null;
  /** First-sense Korean definition (denormalized on krdict_entries). */
  definition_korean: string | null;
  /** First-sense English definition. */
  definition_english: string | null;
  /** Example sentences in sense/example order. Empty when KRDICT has none
   *  loaded for this entry (B-011: tables may be present but unloaded). */
  examples: DefineExample[];
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

/**
 * Content-tagging genre — mirrors the server's `content_domain` enum
 * (migration 002). Drives the Reference-tab "topic" filters (F-003/F-005).
 */
export type ContentDomain = 'general' | 'research' | 'business';

/**
 * Source-book difficulty band — mirrors the server's `book_level` enum.
 * Drives the Reference-tab "level" filters (F-003/F-005). Distinct from
 * {@link ServerProficiency}: this is the band of the book a row was ingested
 * from, not the learner-facing proficiency tag.
 */
export type BookLevel = 'beginner' | 'intermediate' | 'advanced';

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

/**
 * Envelope for `GET /vocab/entries`.
 *
 * `total` is the unfiltered-by-page row count the browse pagination needs (the
 * server adds it alongside the existing `entries`/`limit`/`offset` — see the
 * Resources browse contract). It is optional here so the client still
 * type-checks against a pre-bump server that hasn't shipped the count yet; the
 * Resources Vocabulary tab falls back to "page-length" semantics when it's
 * absent rather than rendering a broken pager.
 */
export interface VocabEntriesPage {
  entries: VocabEntry[];
  limit: number;
  offset: number;
  total?: number;
}

// ── Word mastery (F-013 — Progress page) ──────────────────────────────
/** FSRS maturity bucket for a vocab card. */
export type MasteryBucket = 'new' | 'learning' | 'reviewing' | 'mastered';

/** Per-bucket card counts across all of the user's vocab cards. */
export interface MasterySummary {
  new: number;
  learning: number;
  reviewing: number;
  mastered: number;
  total: number;
}

/** One word in the mastery list — the card's FSRS state made human. */
export interface MasteryWord {
  id: number;
  korean: string;
  english: string | null;
  bucket: MasteryBucket;
  /** FSRS memory stability in days. */
  stability: number;
  reps: number;
  lapses: number;
  /** ISO timestamp of the next review, or null. */
  dueAt: string | null;
}

/** Envelope for `GET /vocab/mastery`: summary + a (filtered) page of words. */
export interface MasteryPage {
  summary: MasterySummary;
  words: MasteryWord[];
  /** Total matching the current bucket filter (for the word-list pager). */
  total: number;
}

// ── KRDICT dictionary search (Resources Dictionary tab) ───────────────

/**
 * One KRDICT row returned by `GET /krdict/search`. Mirrors the `/define`
 * entry columns (`krdict_entries` — ADR-015 §D5): first-sense definitions are
 * denormalised onto the row; the multi-sense / example detail lives behind
 * `/define` and is not carried by the paginated search surface.
 */
export interface KrdictSearchEntry {
  id: number;
  headword: string;
  part_of_speech: string | null;
  definition_korean: string | null;
  definition_english: string | null;
}

/** Envelope for `GET /krdict/search`. */
export interface KrdictSearchPage {
  entries: KrdictSearchEntry[];
  total: number;
}

// ── Weekly suggestions (Resources "This Week" — suggest-only) ─────────

/**
 * One weekly vocab suggestion. Shares the `VocabEntry` shape (the server's
 * `/vocab/suggestions/weekly` selects the same `vocab_entries` columns), so a
 * tapped suggestion can be banked through the existing per-entry bank path
 * (`bankEntry(entry.id)`) without a second resolver.
 */
export type VocabSuggestion = VocabEntry;

/** Envelope for `GET /vocab/suggestions/weekly` (≈15 rows, deterministic per ISO week). */
export interface VocabSuggestionsResponse {
  entries: VocabSuggestion[];
}

/**
 * One weekly grammar suggestion. Shares the KGIU summary shape so a tapped
 * suggestion can be banked through the existing `bankPattern` path; the
 * `source_id` (or `pattern`) is the server dedup key.
 */
export type GrammarSuggestion = KgiuEntrySummary;

/** Envelope for `GET /grammar/suggestions/weekly`. */
export interface GrammarSuggestionsResponse {
  patterns: GrammarSuggestion[];
}

/**
 * Body accepted by `POST /vocab/mine` (FU-NF-33) — the "tap anything → bank
 * it" path. A tapped/OCR'd word, resolved through KRDICT, is upserted into a
 * shared `user_mined` corpus and banked as a recognition card for the caller.
 *
 *   - `lemma`         — the KRDICT headword / tapped surface (required).
 *   - `english`       — gloss from enrich/define, when available.
 *   - `pos`           — part of speech, when available.
 *   - `krdictEntryId` — the `/define` `entries[0].id`, used for stable dedup
 *                       (homographs stay distinct by KRDICT id). Omitted for
 *                       OCR words with no `/define` lookup → the server keys
 *                       the shared entry on the lemma instead.
 */
export interface MineWordInput {
  lemma: string;
  english?: string;
  pos?: string;
  krdictEntryId?: number;
}

/**
 * Envelope returned by `POST /vocab/mine`. Mirrors the server builder shape:
 * the upserted shared `vocab_entries.id` plus the user-scoped recognition
 * card (idempotent — a double-tap returns the same `card.id`).
 */
export interface MineWordResult {
  entryId: number;
  card: { id: number; version: number };
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
  /**
   * Korean headword of the joined vocab entry (B-009). Present only when
   * `vocab_entry_id` is set — the due query LEFT JOINs `vocab_entries` and
   * carries the entry fields so the Review flashcard can render the real word
   * without a second round-trip. Absent for grammar/sentence/topik cards.
   * NOTE: `face` is the card_face ENUM ('recognition' | 'production' |
   * 'cloze'), NOT the word — never render it as card content. The service
   * maps the server's snake-case `vocab_korean` onto this camelCase field at
   * the wire boundary (same convention as the grammar_* columns).
   */
  vocabKorean?: string;
  /** English gloss of the joined vocab entry (B-009). Same JOIN/origin as `vocabKorean`. */
  vocabEnglish?: string;
  /** Korean example sentence of the joined vocab entry (B-009); absent when the entry has none. */
  vocabExampleKorean?: string;
  /** English translation of the example sentence (B-009); absent when the entry has none. */
  vocabExampleEnglish?: string;
  /** Provenance — the source book the entry was ingested/mined from (B-009). */
  vocabSourceBook?: string;
  /**
   * Grammar-pattern display for a production card (FU-NF-42). Present only when
   * `grammar_entry_id` is set — the due query LEFT JOINs `grammar_entries` and
   * carries the pattern display so the Review screen can render a grammar
   * production card without a second round-trip. `null`/absent for vocab cards.
   * The service maps the server's snake-case `grammar_pattern_display` onto
   * this camelCase field at the wire boundary.
   */
  grammarPatternDisplay?: string;
  /**
   * EN summary for a production card's pattern (FU-NF-42). Same JOIN/origin as
   * `grammarPatternDisplay`; absent for vocab cards.
   */
  grammarSummaryEn?: string;
  /**
   * Server dedup key for the pattern (FU-NF-42). REQUIRED for a Review →
   * Drill deep-link to round-trip to the SAME production card: the drill's
   * generate route resolves-or-creates a grammar_entry on `(user, pattern_key)`,
   * so re-drilling must hand back the original `pattern_key` — NOT the entry's
   * numeric id — or the server would mint a parallel entry and the due card
   * would never leave the queue. The current A4 due query (vocab.ts) JOINs only
   * `pattern_display` + `summary_en`; it must also alias `ge.pattern_key AS
   * grammar_pattern_key` for the loop to close. Optional here so the client
   * type-checks against the pre-bump server; when absent the Review screen
   * falls back to the display string as a best-effort key (see
   * `dueCardToGrammar`) and the deep-link still navigates, but the re-schedule
   * round-trip is only exact once the server exposes this field.
   */
  grammarPatternKey?: string;
}

/** FSRS rating button. */
export type FsrsRating = 'again' | 'hard' | 'good' | 'easy';
/** FSRS card state — wire shape. */
export type FsrsState = 'new' | 'learning' | 'review' | 'relearning';

/**
 * Body accepted by `POST /vocab/cards/:id/reviews`.
 *
 * Server-authoritative scheduling (ADR-003 amendment, 2026-07-02): the client
 * sends ONLY its self-rating + the optimistic-concurrency `expected_version`
 * snapshot (from `DueCard.version`). The server reads the card's current FSRS
 * state from the DB and computes the transition itself — the old
 * `*_before` / `*_after` / `scheduled_days_after` fields are gone from the
 * contract (a client-sent interval must never control `due_at`).
 */
export interface ReviewSubmission {
  rating: FsrsRating;
  duration_ms?: number;
  expected_version: number;
}

/** Result envelope from `POST /vocab/cards/:id/reviews`. */
export interface ReviewResult {
  version: number;
  due_at: string;
  /**
   * Server-computed whole-day interval to the next review. 0 means the card
   * lapsed (`again`) and was re-queued ~10 minutes out, not "due now".
   */
  scheduled_days: number;
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

// ── Vocab lists (migration 012 — `vocab_lists` + `vocab_list_entries`) ──
//
// Wire shapes track the server's `/vocab/lists` routes verbatim. The list
// carries a Korean/English NAME PAIR (`name_kr` required, `name_en` the
// optional English caption) — NOT a free-form description; there is no
// description column. `version` is the optimistic-concurrency counter the
// server bumps on every mutation.

/** Body for `POST /vocab/lists`. */
export interface CreateListBody {
  name_kr: string;
  name_en?: string;
  kind?: VocabListKind;
  /** Optional seed: append these entry ids in one round-trip on create. */
  seed_entry_ids?: number[];
}

/** Body for `PATCH /vocab/lists/:id`. `name_en: null` clears the caption. */
export interface PatchListBody {
  name_kr?: string;
  name_en?: string | null;
  kind?: VocabListKind;
}

/** Server-side list row. */
export interface ServerVocabList {
  id: number;
  name_kr: string;
  name_en: string | null;
  kind: VocabListKind;
  version: number;
  entry_count: number;
  created_at: string;
  updated_at: string;
}

/** Envelope for `GET /vocab/lists`. */
export interface ListListsResponse {
  lists: ServerVocabList[];
  limit: number;
  offset: number;
}

/** Envelope for `POST /vocab/lists`. */
export interface CreateListResponse {
  list: ServerVocabList;
  /** How many seed entries were actually appended (idempotent — dups skipped). */
  appended: number;
}

/** Envelope for `PATCH /vocab/lists/:id`. */
export interface PatchListResponse {
  list: ServerVocabList;
}

/** One joined entry row inside a list's detail (entry id + the vocab columns). */
export interface VocabListEntryRow {
  entry_id: number;
  position: number;
  added_at: string;
  korean: string | null;
  english: string | null;
  proficiency: string | null;
}

/** Envelope for `GET /vocab/lists/:id`. */
export interface VocabListDetailResponse {
  list: ServerVocabList;
  entries: VocabListEntryRow[];
  entry_limit: number;
  entry_offset: number;
}

/** One appended membership row returned by `POST /vocab/lists/:id/entries`. */
export interface AddedListEntry {
  entry_id: number;
  position: number;
  added_at: string;
}

/** Envelope for `POST /vocab/lists/:id/entries`. */
export interface AddListEntriesResult {
  entries: AddedListEntry[];
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
  /**
   * Raw corpus register string. The KGIU corpus stores free text here — often
   * COMPOSITE values such as "해요체 / 하십시오체" or "formal/written" that
   * are NOT members of the server's closed {@link RegisterLevel} set. The list
   * endpoint doesn't return this column today; it is typed optional so a
   * future server include is non-breaking. NEVER forward it raw into
   * `BankGrammarBody.register` — sanitize against the RegisterLevel set first
   * (see `buildBankBody` in pages/Grammar.tsx) or `POST /grammar/bank` 400s.
   */
  register?: string | null;
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
  /**
   * When the user marked this pattern as known/graduated (migration 033).
   * `null` = active learning (drill pool + review queue); a timestamp =
   * retired from active learning until re-admitted.
   */
  graduated_at: string | null;
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
  /**
   * Server-derived production schedule (FU-NF-42). The submit route maps the
   * verdict → an FSRS rating, advances the production card, and returns the
   * resulting interval so the reveal can tell the learner when the pattern
   * comes back. `scheduledDays === 0` (rating `again`) means a ~10-minute
   * relearning step rather than a day-grained interval. Optional so a server
   * that predates the FU-NF-42 wire bump (or a synthesized offline-mock score)
   * still type-checks — the reveal line simply omits itself when absent.
   */
  schedule?: DrillSchedule;
}

/** Production-card schedule echoed back by the drill-submit route (FU-NF-42). */
export interface DrillSchedule {
  /** The FSRS rating the server derived from the verdict (+ pattern usage). */
  rating: FsrsRating;
  /** ISO timestamp the production card next becomes due. */
  dueAt: string;
  /**
   * Whole-day interval until the next review. `0` denotes an intra-day
   * relearning step (the route schedules it ~10 minutes out).
   */
  scheduledDays: number;
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

// ── MFA / TOTP 2FA login (PASS LOGIN — PART C) ────────────────────────────
//
// These mirror the server's wire shapes (PASS_LOGIN_CONTRACT PART B) EXACTLY.
// The server speaks snake_case on the wire; `services/auth.ts` translates to
// the camelCase in-app result types below at the boundary, the same idiom the
// rest of the service layer uses (e.g. `grammarPatternKey`).
//
// SECURITY — the wire never carries the TOTP secret in a form this client may
// persist: `challenge_token`, `secret`, and `recovery_codes` are held in
// React state ONLY (never localStorage / sessionStorage / cookies). See the
// AuthProvider + Login docstrings. The client also NEVER echoes a raw server
// error `message`; the Login/Settings error tables map `code`/`status` to
// fixed copy.

/**
 * Shared shape for the `POST /auth/login` envelope. The server discriminates
 * on `status`; only one variant carries the user, the other two carry a
 * short-lived pending challenge token (the bearer of step-1 success).
 *
 * `status: 'authenticated'` is the legacy / `MFA_REQUIRED=false` branch
 * (direct session, cookie already set). The mandatory-2FA prod posture only
 * ever returns `mfa_required` (confirmed factor exists) or
 * `enrollment_required` (no confirmed factor — first login forces enrollment).
 */
export type LoginResponse =
  | { status: 'authenticated'; user: AuthMeResponse['user'] }
  | { status: 'mfa_required'; challenge_token: string; expires_in: number }
  | { status: 'enrollment_required'; challenge_token: string; expires_in: number };

/** `POST /auth/login/totp` success envelope — the real session cookie is set. */
export interface LoginTotpResponse {
  status: 'authenticated';
  user: AuthMeResponse['user'];
}

/**
 * `POST /auth/mfa/enroll` envelope. Auth is EITHER an `enroll` challenge token
 * (the forced-enrollment login leg) OR a full session + password re-auth (the
 * Settings re-enroll leg). Returns the freshly-minted PENDING secret as a
 * base32 string (manual-entry) plus the `otpauth://` URI the client renders to
 * a QR. No session and no recovery codes are issued here — `confirm` does that.
 */
export interface MfaEnrollResponse {
  otpauth_uri: string;
  secret: string;
}

/**
 * `POST /auth/mfa/confirm` envelope. Two shapes by auth leg:
 *   - challenge leg → `status:'authenticated'` + `user` (session minted) +
 *     `recovery_codes` (shown ONCE).
 *   - session re-enroll leg → `status:'updated'` (current session kept) +
 *     `recovery_codes`.
 * `user` is therefore optional; `recovery_codes` is always present.
 */
export interface MfaConfirmResponse {
  status: 'authenticated' | 'updated';
  user?: AuthMeResponse['user'];
  recovery_codes: string[];
}

/** `POST /auth/mfa/recovery-codes/regenerate` envelope. */
export interface RegenerateRecoveryCodesResponse {
  recovery_codes: string[];
}

/** `GET /auth/mfa/status` envelope (Settings 2FA section). */
export interface MfaStatusResponse {
  enabled: boolean;
  recovery_codes_remaining: number;
}

// ── In-app (camelCase) MFA result types — what services/auth.ts returns ──

/** Discriminated `login()` result the AuthProvider branches on. */
export type LoginResult =
  | { status: 'authenticated'; user: import('../hooks/auth-context').User }
  | { status: 'mfa_required'; challengeToken: string; expiresIn: number }
  | { status: 'enrollment_required'; challengeToken: string; expiresIn: number };

/** `mfaEnroll()` result — QR source + manual-entry secret. */
export interface MfaEnrollResult {
  otpauthUri: string;
  secret: string;
}

/** `mfaConfirm()` result — optional user (challenge leg) + recovery codes. */
export interface MfaConfirmResult {
  user?: import('../hooks/auth-context').User;
  recoveryCodes: string[];
}

/** `regenerateRecoveryCodes()` result. */
export interface RecoveryCodesResult {
  recoveryCodes: string[];
}

/** `fetchMfaStatus()` result (Settings 2FA section). */
export interface MfaStatus {
  enabled: boolean;
  recoveryCodesRemaining: number;
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

// ─────────────────────────────────────────────────────────────
// Writing — TOPIK rubric grader (`POST /grade-writing`)
// ─────────────────────────────────────────────────────────────

/**
 * TOPIK II writing rubrics the grader accepts — mirrors the server's
 * `TopikRubricSchema` (server/src/services/claude/models.ts):
 *   - `topik_ii_53` — Q53, 200–300자 explanatory/description writing.
 *   - `topik_ii_54` — Q54, 600–700자 argumentative essay.
 */
export type TopikWritingRubric = 'topik_ii_53' | 'topik_ii_54';

/**
 * Estimated TOPIK II level the sample would earn — the server's closed
 * `estimatedLevel` enum, verbatim.
 */
export type WritingEstimatedLevel = 'below_L3' | 'L3' | 'L4' | 'L5' | 'L6';

/**
 * One rubric dimension's grade — mirrors the server's `DimensionScoreSchema`.
 * `maxScore` is the denominator for this dimension so the UI never hardcodes
 * per-rubric point splits.
 */
export interface WritingDimensionScore {
  score: number;
  maxScore: number;
  /** Verbatim Korean fragments cited from the sample as evidence (0..5). */
  evidence: string[];
  /** Concrete, actionable improvement notes (0..5). */
  improvements: string[];
}

/**
 * The grader's verdict — mirrors the server's `GradeResultSchema` field for
 * field. The three dimensions are the official TOPIK writing rubric axes.
 */
export interface WritingGradeResult {
  rubric: TopikWritingRubric;
  /** 내용 및 과제수행 — content and task completion. */
  content: WritingDimensionScore;
  /** 전개구조 — organization and development. */
  organization: WritingDimensionScore;
  /** 언어사용 — language use (grammar, vocab, register). */
  languageUse: WritingDimensionScore;
  /** Total score (sum of dimensions). */
  totalScore: number;
  /** Max total. */
  maxTotal: number;
  estimatedLevel: WritingEstimatedLevel;
  /** One-paragraph overall comment. */
  overallComment: string;
}

/**
 * Per-call metadata the proxy returns alongside every non-streaming result —
 * mirrors the server's `CallMetadataSchema`. The Writing screen consumes only
 * `result`, but the envelope is typed in full so the client contract matches
 * the wire shape exactly (no silent partial cast at the boundary).
 */
export interface WritingCallMetadata {
  requestId: string;
  model: 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7';
  cacheHit: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  costEstimateUsd: number;
}

/**
 * Body for `POST /grade-writing`. The route's Zod schema is `.strict()` —
 * NEVER add fields here without matching the server's `GradeSchema`
 * (server/src/routes/gradeWriting.ts), or every grade will 400:
 *   - `prompt` — REQUIRED, 1..2000. The task the learner answered.
 *   - `sample` — REQUIRED, 1..5000. The learner's Korean writing.
 *   - `rubric` — optional; server defaults to `topik_ii_54`.
 * (The edge also tolerates an optional `targetLevel` hint but does not
 * forward it, so the client intentionally omits it.)
 */
export interface GradeWritingBody {
  prompt: string;
  sample: string;
  rubric?: TopikWritingRubric;
}

/** Envelope from `POST /grade-writing` — the proxy's `ProxyResult<GradeResult>`. */
export interface GradeWritingResponse {
  result: WritingGradeResult;
  metadata: WritingCallMetadata;
}

// ── TTMIK / Iyagi audio (F-012) ───────────────────────────────────────────
//
// Wire shapes for the audio-lesson browse + read-along surface. All routes
// are GET + requireAuth (the cookie session rides via `withCredentials` on
// the axios instance, and on the `<audio>` element because the media request
// is same-origin / same-site with the API). `audioUrl` is an APP-RELATIVE
// path (e.g. `/ttmik/lessons/2/21/audio`) that streams `audio/mpeg` with
// HTTP Range support, or `null` when no audio file is mapped for the unit —
// the UI renders transcript-only in that case.

/**
 * One spoken row — the shape shared by a TTMIK lesson's `highlights` (key
 * phrases) and an Iyagi episode's `sentences` (full transcript). `korean` is
 * the primary read-along line; `english`/`romanization` are secondary.
 * `romanization`/`speaker` are optional ON THE WIRE (the server may omit
 * them or send null — both mean "absent"). `speaker` labels dialog turns
 * when `is_dialog` is set.
 */
export interface ListenSentence {
  /** 1-based position within the unit — the render order. */
  ordinal: number;
  korean: string;
  english: string | null;
  romanization?: string | null;
  speaker?: string | null;
  is_dialog: boolean;
}

/**
 * Line kinds in a TTMIK lesson's full `transcript`:
 *   - `header`       — section heading within the lesson.
 *   - `pair`         — Korean line + English translation.
 *   - `dialog`       — a dialog turn (rendered like `pair`).
 *   - `prose`        — explanatory note (usually English commentary).
 *   - `romanization` — romanized rendering of the preceding line (subtle).
 */
export type TtmikTranscriptKind =
  | 'header'
  | 'pair'
  | 'romanization'
  | 'prose'
  | 'dialog';

/** One ordered line of a TTMIK lesson's full transcript. */
export interface TtmikTranscriptLine {
  /** 1-based position within the transcript — the render order. */
  ordinal: number;
  /** `null` on `header` and English-only `prose` lines (render `english`). */
  korean: string | null;
  english: string | null;
  kind: TtmikTranscriptKind;
}

/** One TTMIK lesson row from `GET /ttmik/lessons` (ordered by level, number). */
export interface TtmikLesson {
  level: number;
  number: number;
  title: string;
  /** False when no mp3 is mapped — the browse row flags "no audio". */
  hasAudio: boolean;
}

/** Envelope for `GET /ttmik/lessons`. */
export interface TtmikLessonsResponse {
  lessons: TtmikLesson[];
}

/** Detail envelope for `GET /ttmik/lessons/:level/:number`. */
export interface TtmikLessonDetail {
  meta: TtmikLesson;
  /** App-relative audio stream path, or null when no audio is mapped. */
  audioUrl: string | null;
  /** Key phrases — the Highlights sub-tab. */
  highlights: ListenSentence[];
  /** Full ordered lesson transcript — the Transcript sub-tab. */
  transcript: TtmikTranscriptLine[];
}

/** One Iyagi episode row from `GET /iyagi/episodes` (ordered by number). */
export interface IyagiEpisode {
  number: number;
  title: string;
  /** False when no mp3 is mapped — the browse row flags "no audio". */
  hasAudio: boolean;
}

/** Envelope for `GET /iyagi/episodes`. */
export interface IyagiEpisodesResponse {
  episodes: IyagiEpisode[];
}

/** `meta` block of `GET /iyagi/episodes/:number` — the row plus hosts. */
export interface IyagiEpisodeMeta extends IyagiEpisode {
  /** Episode hosts (display-only text) — a real array on the wire. */
  hosts: string[];
}

/** Detail envelope for `GET /iyagi/episodes/:number`. */
export interface IyagiEpisodeDetail {
  meta: IyagiEpisodeMeta;
  /** App-relative audio stream path, or null when no audio is mapped. */
  audioUrl: string | null;
  /** Full ordered episode transcript. */
  sentences: ListenSentence[];
}
