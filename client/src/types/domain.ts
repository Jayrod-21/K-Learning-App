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

/** Vocab list kind — what the list contains. */
export type VocabListKind = 'vocab' | 'grammar' | 'hanja' | 'mixed';

/** Diagnostic item kind — drives the screen's render branch. `hanja-reading`
 *  / `hanja-meaning` (diagnostic-upgrade Phase A) render through the SAME
 *  `<ChoiceList>` branch as every other MC kind — they add no new render
 *  path, just a label (see `sectionLabel` in Diagnostic.tsx). `writing-
 *  production` (diagnostic-upgrade Phase B) is the ONE kind that does NOT
 *  render through `<ChoiceList>` — it has no `choices` at all, and drives a
 *  dedicated `<textarea>` branch instead (see Diagnostic.tsx's TakingBlock). */
export type DiagnosticItemKind =
  | 'cloze'
  | 'synonym'
  | 'pattern'
  | 'passage-mc'
  | 'inference'
  | 'audio-mc'
  | 'hanja-reading'
  | 'hanja-meaning'
  | 'writing-production';

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
  /**
   * F-206 — this listening question's window (ms) into its paper's
   * whole-section MP3 (the same F-119 span the mock items carry). Present
   * both-or-neither; `fetchStudyDraw` re-validates the pair off the wire
   * (finite non-negative ints, end > start) and strips anything else, so a
   * present span is always seekable.
   */
  audioStartMs?: number;
  /** End (ms, exclusive) of the question's audio window — see `audioStartMs`. */
  audioEndMs?: number;
  /**
   * F-206 — the streaming URL of this item's paper's whole-section listening
   * MP3 (`/topik/audio/<testNumber>/<1|2>`). Study draws are cross-test, so
   * each item names its OWN paper's stream (unlike the mock's single
   * envelope-level URL). Emitted by the server only for a listening item with
   * a valid span on an audio-mapped paper; the player still routes it through
   * `buildAudioSrc`'s strict allow-list before it ever reaches an `<audio>`.
   */
  audioUrl?: string;
  /**
   * F-120 — the serving URL of this question's cropped exam figure
   * (`/topik/image/<testNumber>/<1|2>/<itemNumber>`), emitted by the server
   * only for items with an image asset mapped (absent for every item until
   * the corpus backfill runs — the text description remains the fallback,
   * exactly like `imageText`). Never fed raw to an `<img>`: the renderer
   * routes it through `buildTopikImageSrc`'s strict allow-list + API-base
   * join first.
   */
  imageUrl?: string;
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
 * TOPIK I vs TOPIK II — the exam-paper discriminator (D-1). TOPIK I and
 * TOPIK II sittings SHARE every `test_number` (migration 029 widened the
 * server's natural key to `(test_number, topik_level, section)` for exactly
 * this reason), so a mock paper is never fully named by `test_number` alone.
 * Mirrors the server's `TopikLevelSchema` (routes/topik.ts).
 */
export type TopikLevel = 'TOPIK I' | 'TOPIK II';

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
  /** See `TopikItem.imageUrl` — the question's exam-figure URL (F-120). It is
   *  question content (WHAT THE EXAM SHOWS, like `hasImage`/`imageText`),
   *  never answer data, so it survives the answer strip — unlike `audioUrl`,
   *  which the mock replaces with its single envelope-level stream URL. */
  imageUrl?: string;
  /** Start (ms) of this question's window in the exam's ONE whole-section
   *  listening file (`MockTest.audioUrl`) — question metadata (timing), never
   *  answer data, so it survives the answer strip exactly like `passage`/
   *  `hasImage` (F-119). The server emits it only together with `audioEndMs`
   *  (both-or-neither — the 078 CHECK's wire mirror); `fetchMockTest` drops a
   *  half/invalid window so a span is either fully playable or absent. */
  audioStartMs?: number;
  /** End (ms, exclusive) of the question's audio window — see `audioStartMs`. */
  audioEndMs?: number;
  /** F-119 decision #2 (fix-pass S-1): the SERVER's authoritative answer to
   *  "is this item's `prompt` text the spoken transcript?" — decided in
   *  `mapRowToDTO`, where the text's column provenance is known (true only
   *  when the prompt slot fell back to a stem that carries the dialogue;
   *  false for every printed question). The timed runner hides the prompt
   *  only when this is EXACTLY `true`; `undefined` (an older server, or a
   *  malformed wire value stripped by `fetchMockTest`) fails SAFE — the
   *  prompt stays visible, keeping the item answerable. Question metadata
   *  (what kind of text the prompt is), never answer data. */
  promptIsTranscript?: boolean;
}

/** Envelope returned by `POST /topik/mock` — the answer-stripped exam payload. */
export interface MockTest {
  /** The test the server picked (or echoed) — referenced on submit. */
  sourceTest: number;
  /**
   * The paper's TOPIK level, as `resolveMockTest` resolved it server-side
   * (D-1) — echoed here so `submitMockTest` can pin the SAME paper it just
   * served, rather than letting the shared resolver's tie-break
   * (`ORDER BY topik_level DESC`) potentially re-resolve to a DIFFERENT
   * paper at grade time (fix-pass S-1 / REVIEW_topik.md).
   */
  topikLevel: TopikLevel;
  section: MockSection;
  /**
   * Streaming URL of the exam's ONE whole-section listening MP3
   * (`/topik/audio/<testNumber>/<1|2>`, F-119) when the resolved paper has
   * audio mapped, else `null` (no audio → the transcript-only rendering).
   * Each item's `audioStartMs`/`audioEndMs` window indexes into this single
   * file — the client keeps one buffered `<audio>` element and seeks per
   * question rather than fetching per-question clips.
   */
  audioUrl: string | null;
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
  /**
   * The exact paper to grade against (D-1) — echoes `MockTest.topikLevel`
   * from the fetch that served this exam. Optional on the wire (the server's
   * `resolveMockTest` still resolves a paper without it), but the client
   * always sends the level it was actually served (fix-pass S-1) so a
   * fetch/submit pair can never resolve to two DIFFERENT papers.
   */
  topikLevel?: TopikLevel;
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
  /**
   * WIRE TYPE IS STRING: the server projects the item id as `i.id::text`
   * (routes/topik.ts `MockRevealDTO.itemId: string`), matching
   * `TopikMockItem.id`. It was previously (wrongly) typed `number`, which made
   * the results screen index a `Map<number>` with a string key — every lookup
   * missed and the whole per-item review list rendered blank on real data.
   */
  itemId: string;
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
  // for forward-compat (Pass 8 wires it) even though the server omits it
  // today. `hanja` (diagnostic-upgrade Phase A) is COVERAGE-ONLY — scored and
  // displayed like the others, but excluded from the server's global θ ladder.
  key: 'reading' | 'listening' | 'writing' | 'vocab' | 'grammar' | 'hanja';
  label: string;
  kr: string;
  score: number;
  // F-011 confidence band. The server guarantees 0 ≤ scoreLow ≤ score ≤
  // scoreHigh ≤ 100; when the band is unknown (legacy snapshots, degenerate
  // stats) both equal `score`, which the UI renders as "no band".
  /** Lower edge of the confidence band, 0–100. */
  scoreLow: number;
  /** Upper edge of the confidence band, 0–100. */
  scoreHigh: number;
  note: string;
}

/** Reference line band on the SkillsCompare chart. F-002 adds L1/L2 so a
 * beginner placement has honest reference lines below the old L3 floor. */
export interface DiagnosticReference {
  id: 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'native';
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

/** The section a diagnostic item exercises. `hanja` (diagnostic-upgrade
 *  Phase A) is coverage-only — see `DiagnosticDimension.key`. `writing`
 *  (diagnostic-upgrade Phase B) is a FULL leveled dimension — unlike hanja,
 *  it DOES bump the server's global θ ladder. */
export type DiagnosticSection =
  | 'vocab'
  | 'grammar'
  | 'reading'
  | 'listening'
  | 'hanja'
  | 'writing';

/**
 * The proficiency band the server serves a live diagnostic item at.
 * F-002: the ladder now reaches down to L1/L2 (TOPIK I territory) instead of
 * collapsing everything below L3 — beginners get real item targeting.
 */
export type DiagnosticLevel = 'L1' | 'L2' | 'L3' | 'L4' | 'L5+';

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
  /**
   * A real, playable audio window (F-119/F-206 shape) — present only for
   * listening items whose corpus row carries a mapped span AND the parent
   * test has a mapped mp3. `audioStartMs`/`audioEndMs` travel together with
   * `audioUrl` or not at all (mirrors the server's DB invariant). When
   * absent, `audio.transcript` (if present) is the item's only content — the
   * client renders it honestly as a transcript, never a fake player.
   */
  audioUrl?: string;
  audioStartMs?: number;
  audioEndMs?: number;
  choices: DiagnosticChoice[];
}

/**
 * Server's reveal after grading one answer — the only place the key surfaces.
 *
 * The `verdict`/`summary`/`corrections`/`referenceModel*` fields (diagnostic-
 * upgrade Phase B) are present ONLY for a writing item — the server grades
 * writing via the SAME Claude pipeline (`generateGrammarDrill`/
 * `scoreGrammarDrill`) the Grammar screen's production drill uses, so this
 * reveal reuses that pipeline's own `DrillVerdict`/`DrillCorrection` types
 * rather than inventing parallel ones. `correct` still carries the same
 * pass/fail boolean for a writing item too (verdict `excellent`/`good` →
 * true), so any caller reading only `correct`/`explain` (pre-Phase-B shape)
 * still gets a sensible degraded reveal.
 */
export interface DiagnosticAnswerResult {
  correct: boolean;
  /** The correct choice id, revealed only after the user answers. For a
   *  writing item this is the server's opaque sentinel — never a real MC
   *  choice id, and never rendered as one. */
  correctAnswer: string;
  explain: string;
  /** Writing items only — Claude's overall verdict bucket. */
  verdict?: DrillVerdict;
  /** Writing items only — Claude's EN feedback summary. */
  summary?: string;
  /** Writing items only — inline corrections, each citing a verbatim KR
   *  fragment. May be empty (a flawless answer). */
  corrections?: DrillCorrection[];
  /** Writing items only — the reference model sentence, revealed post-answer. */
  referenceModelKr?: string;
  /** Writing items only — English gloss of the reference model sentence. */
  referenceModelEn?: string;
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

/** One task card on the Today screen.
 *
 * Wave 2 (backend batch, TODAY_NAV_SCOPING.md B4/B5/B6) adds optional
 * deep-link fields, each populated only for the task whose `tag` names it —
 * additive so any older cached/mock fixture (with none of these fields) still
 * type-checks and renders (the tile simply has nothing to deep-link with,
 * same as before this wave). */
export interface TodayTask {
  title: string;
  mins: number;
  level: LevelLabel;
  tag: 'Reading' | 'Listening' | 'Writing';
  /** Reading only: which reading feature this task came from — `/plan.ts`
   *  now re-sources Reading from the caller's own uploaded-book chapters or
   *  AI-generated stories (not the old public TTMIK-lesson pick), so the
   *  Today tile can deep-link to the exact one shown. */
  sourceKind?: 'chapter' | 'story';
  /** Reading only, when `sourceKind === 'chapter'`: reading_chapters.id —
   *  `/learn/reading?chapter=<id>`. */
  chapterId?: number;
  /** Reading only, when `sourceKind === 'story'`: generated_stories.id —
   *  `/learn/reading?story=<id>`. */
  storyId?: number;
  /** Listening only: the corpus this episode belongs to — deep-link as
   *  `/learn/listen?corpus=<corpus>&episode=<episodeNumber>`. */
  corpus?: 'iyagi';
  /** Listening only: the episode's natural key (distinct from its internal
   *  DB id) — the player addresses episodes by this number. */
  episodeNumber?: number;
  /** Writing only: writing_prompts.id — lets Today request this EXACT bank
   *  prompt instead of a fresh random draw. */
  promptId?: number;
  /** Writing only (F-134): the full Korean prompt body of the same bank row
   *  `promptId` names — the Today tile PREVIEWS the real prompt text, and
   *  Start opens `/learn/writing?promptId=<id>` with exactly that prompt. */
  promptKr?: string;
}

/** The four dimensions the F-212 Phase-4 recommender chooses between.
 *  Writing is deliberately held out of v1 (its scoring surface is separate),
 *  so this is narrower than the full skill set the app teaches. */
export type RecommendationDimension =
  | 'reading'
  | 'listening'
  | 'vocab'
  | 'grammar';

/** Why the recommender picked this item — the dominant term of its
 *  dimension score. Drives honest client copy, never a hidden ranking. */
export type RecommendationReasonCode =
  | 'weakest_dimension'
  | 'due_backlog'
  | 'low_confidence'
  | 'exploration'
  | 'baseline';

/**
 * F-212 Phase 4 — one ranked "do this next" pick from `GET /plan/today`.
 *
 * `reasonEn`/`reasonKr` are the server-composed honest WHY (bilingual); the
 * client renders them verbatim rather than re-deriving copy that could drift
 * from the actual scoring. `exploratory` is true when the pick exists to
 * GATHER signal on a dimension we can't estimate yet — the client must frame
 * it as exploration ("let's build a read on your listening"), never as a
 * deficit claim, because no deficit has been measured.
 *
 * `deepLink` is the server's own composed target path. The client does NOT
 * navigate on it: Today.tsx builds hrefs from the structured id fields below
 * via the same `readingHref`/`listeningHref` builders every other tile uses
 * (integer ids/enums only — no free-text URL surface; see Today.tsx's threat
 * model). The field is carried through so the wire shape matches the server
 * contract and future consumers can cross-check the id-built href against it.
 *
 * The optional id fields mirror the `TodayTask` deep-link union exactly —
 * each populated only when `dimension` names it (reading → sourceKind +
 * chapterId/storyId, listening → corpus + episodeNumber). Vocab and grammar
 * carry no per-item ids in v1; their deep links are the fixed session
 * landings (`/learn/vocab?study=due`, `/learn/grammar`).
 */
export interface Recommendation {
  dimension: RecommendationDimension;
  exploratory: boolean;
  reasonCode: RecommendationReasonCode;
  reasonEn: string;
  reasonKr: string;
  /** Display label for the item's level (e.g. "L3", "L3→L4"). Looser than
   *  `LevelLabel` by contract — the recommender's target-difficulty banding
   *  may compose labels the fixed union doesn't enumerate. */
  level: string;
  deepLink: string;
  title: string;
  mins: number;
  sourceKind?: 'chapter' | 'story';
  chapterId?: number;
  storyId?: number;
  corpus?: 'iyagi';
  episodeNumber?: number;
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
 *
 * `recommendation` (F-212 Phase 4) is the evidence-driven "do this next"
 * pick. `null` at cold-start (every dimension's ability estimate is still
 * insufficient) — the screen renders NO recommendation card and the existing
 * deterministic tiles carry the day unchanged, which is the honest fallback
 * (recommending from no evidence would be a fabricated claim). `alternatives`
 * (runner-up dimensions' best items, in rank order) is optional and unused by
 * the Today card in v1 — mapped through so the domain type matches the wire.
 */
export interface TodayPlan {
  reviewCount: number;
  reading: TodayTask | null;
  listening: TodayTask | null;
  writing: TodayTask | null;
  largestGap: TodayTask['tag'] | null;
  recommendation: Recommendation | null;
  alternatives?: Recommendation[];
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
  /** Numeric `hanja_characters.id` (F-114) — the surrogate PK typed list
   *  membership (`addHanjaToList`) targets, exposed on the pool DTO so
   *  features can reference a character by id without the card-seed
   *  round-trip that used to be the only way to learn it. */
  characterId: number;
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
  /** Server-templated English status line. Still on the wire, but no longer
   *  rendered — both consumers compose a bilingual line client-side via
   *  `lib/encounteredBar.hanjaProgressSummary` (F-077). */
  note: string;
}

// ─────────────────────────────────────────────────────────────
// Settings (palette + notif intents)
// ─────────────────────────────────────────────────────────────

/** Paper preset — base surface palette family. */
export type PaperPreset = 'hanji' | 'ivory' | 'linen' | 'sumi';
/** Accent preset — the Seoul-neon accent ids (Redesign §14a), server-synced
 *  via `/settings/prefs` so the choice follows the user across devices.
 *  Structurally identical to `hooks/accent-context.ts`'s `Accent` union —
 *  keep them in lockstep. Legacy stored ids (vermilion|indigo|plum|ochre)
 *  are coerced to 'coral' by the server schema, never 400'd. */
export type AccentPreset = 'coral' | 'blue' | 'mint';
/** Text-size preset (F-025) — the app-wide root font-size scale,
 *  server-synced via `/settings/prefs` so the choice follows the user
 *  across devices. Structurally identical to `hooks/text-size-context.ts`'s
 *  `TextSize` union — keep them in lockstep. A missing/unknown stored value
 *  is coerced to 'md' by the server schema, never 400'd. */
export type TextSizePreset = 'sm' | 'md' | 'lg';
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

/** Which language(s) bilingual UI CHROME shows (Overhaul P3a).
 *  Learning content (vocab/grammar/TOPIK/dictionary/Hanja material) NEVER
 *  follows this — it is a chrome-only presentation setting. */
export type LanguageDisplayMode = 'en' | 'ko' | 'both';

/** One of the two chrome languages — the `primary` (main-text) choice. */
export type BilingualLanguage = 'en' | 'ko';

/** Guided-tour completion marks — the ids of coach-mark tours the user has
 *  finished or skipped, server-synced via `/settings/prefs` (`toursSeen`,
 *  mirrors the server `ToursSeenSchema`: bounded opaque strings). The CLOSED
 *  id set lives in `lib/tours.ts` (`TourId`); the wire deliberately carries
 *  plain strings so a build that predates a tour id tolerates (and
 *  preserves) ids persisted by a newer one. */
export type ToursSeen = string[];

/** Language-display preferences — server-synced via `/settings/prefs`
 *  (mirrors the server `LanguageDisplayPrefsSchema` exactly). */
export interface LanguageDisplayPrefs {
  /** 'en' → English-only chrome · 'ko' → Korean-only · 'both' → bilingual. */
  mode: LanguageDisplayMode;
  /** In 'both' mode: which language renders as the MAIN (larger) text. */
  primary: BilingualLanguage;
  /** In 'both' mode: the sub text's font-size scale relative to the main.
   *  Clamped to [0.4, 1.0]; default 0.7. */
  subScale: number;
}

// NOTE: the old prototype-era `Settings` interface ({name,email,phone,notif,
// palette} as one `GET /settings` payload) was deleted with its stale mock
// (`data/mocks/settings.ts`) — no such route/shape exists. Identity lives on
// `GET /auth/me`; prefs live on `GET /settings/prefs` → `{ notif, palette }`
// (see `NotifPrefs` / `PalettePrefs` above and `services/settings.ts`).

// ─────────────────────────────────────────────────────────────
// Server wire shapes (Pass 3)
// ─────────────────────────────────────────────────────────────
//
// Below are the shapes the real server endpoints emit / accept. Kept
// separate from the prototype-mirroring fixture types above so existing
// mock loaders and screens (which speak the fixture shapes) keep
// compiling. The service modules in `src/services/*` translate at the
// boundary where the in-app shape and the wire shape differ.

/** One token in a `/lemmatize` response — mirrors the km-kiwi service's
 *  `Token` model (`services/kiwi/src/kiwi_service/models.py`), passed through
 *  the server unchanged. `start`/`end` are UTF-16 code-unit offsets into the
 *  input (matching JS string indices); `end` is exclusive. */
export interface LemmaToken {
  surface: string;
  lemma: string;
  pos: string;
  start: number;
  end: number;
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

// ── Grammar mastery (F-099 — Progress page Grammar tab) ───────────────
/**
 * One banked pattern in the grammar-mastery list — the pattern's production
 * card FSRS state made human (the grammar sibling of `MasteryWord`; buckets
 * and `MasterySummary` are shared, the same 21-day mature threshold applies).
 */
export interface GrammarMasteryPattern {
  /** grammar_entries.id (the bank row, NOT a KGIU id). */
  id: number;
  /** The Hangul display form (`pattern_display`). */
  pattern: string;
  /** One-line English summary of the pattern. */
  summaryEn: string;
  bucket: MasteryBucket;
  /** FSRS memory stability in days — null when the pattern has never been
   *  drilled (no production card yet), an honest "not started". */
  stability: number | null;
  /** ISO timestamp of the next review, or null (never drilled / graduated). */
  dueAt: string | null;
}

/** Envelope for `GET /grammar/mastery`: summary + a (filtered) page. */
export interface GrammarMasteryPage {
  summary: MasterySummary;
  patterns: GrammarMasteryPattern[];
  /** Total matching the current bucket filter (for the pattern-list pager). */
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
 *   - `source_upload_id` — F-107 upload provenance: the `book_uploads.id`
 *                       the user was working from when they tapped the word
 *                       (snake_case: the wire name this concept carries
 *                       everywhere — query params, DB column). Optional; the
 *                       server 404s unless the upload belongs to the caller,
 *                       so only pass ids from the user's own uploads.
 */
export interface MineWordInput {
  lemma: string;
  english?: string;
  pos?: string;
  krdictEntryId?: number;
  source_upload_id?: number;
}

/** One saved word inside a `SavedFromUploadsGroup` (F-107/F-053). */
export interface SavedFromUploadEntry {
  id: number;
  korean: string | null;
  english: string | null;
  /** ISO timestamp of the EARLIEST save (card bank or list add). */
  savedAt: string;
}

/**
 * One upload's worth of saved vocab from `GET /vocab/saved-from-uploads`
 * (F-107) — the read behind the Review→Vocabulary "My Uploads" section
 * (F-053). Groups arrive newest-upload-first, entries newest-saved-first;
 * only uploads the caller owns can ever appear (server-enforced).
 */
export interface SavedFromUploadsGroup {
  upload: { id: number; title: string };
  entries: SavedFromUploadEntry[];
}

/** Envelope for `GET /vocab/saved-from-uploads` (F-107). */
export interface SavedFromUploadsResponse {
  groups: SavedFromUploadsGroup[];
  /**
   * The caller's FULL saved-with-provenance word count — a window count the
   * server computes BEFORE its defensive row cap, so it can exceed the sum
   * of `entries` across `groups` when `truncated` is true.
   */
  total: number;
  /**
   * True when the server's row cap (500) trimmed the response. The server
   * guarantees every group in `groups` is WHOLE — a group the cap would have
   * split mid-group is dropped entirely rather than returned looking
   * complete — so `truncated` (plus `total`) is the only signal that more
   * saves exist beyond what is shown.
   */
  truncated: boolean;
}

/** One saved grammar pattern inside a `GrammarSavedFromUploadsGroup`
 *  (F-056 — the grammar mirror of `SavedFromUploadEntry`). */
export interface GrammarSavedFromUploadEntry {
  id: number;
  /** Hangul display form (`grammar_entries.pattern_display`). */
  pattern: string;
  /** One-line English gloss (`grammar_entries.summary_en`). */
  summary: string;
  /** ISO timestamp of the save (the bank row's `created_at`). */
  savedAt: string;
}

/**
 * One upload's worth of saved grammar from `GET /grammar/saved-from-uploads`
 * (F-056) — the read behind the Review→Grammar Uploads view's saved
 * section. Groups arrive newest-upload-first, entries newest-saved-first;
 * only uploads the caller owns can ever appear (server-enforced).
 */
export interface GrammarSavedFromUploadsGroup {
  upload: { id: number; title: string };
  entries: GrammarSavedFromUploadEntry[];
}

/** Envelope for `GET /grammar/saved-from-uploads` (F-056) — same
 *  `total`/`truncated` whole-groups contract as `SavedFromUploadsResponse`
 *  (see those field docs; the grammar route mirrors the vocab one). */
export interface GrammarSavedFromUploadsResponse {
  groups: GrammarSavedFromUploadsGroup[];
  total: number;
  truncated: boolean;
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
  /**
   * Cloze presentation for this card's vocab entry (F-208). Present ⇔ the
   * entry has a pre-computed `cloze_prompts` row — that presence IS the
   * client's cloze-eligibility signal (absence ⇒ flashcard only). The server
   * folds its `cloze_*` JOIN columns into this object at the route boundary
   * (already camelCase on the wire — no snake_case mapping needed here).
   * `answer_surface` is NEVER sent with the due card; the answer is revealed
   * only by a committing response from the grade route.
   */
  cloze?: DueCardCloze;
}

/** The optional cloze presentation carried on a due card (F-208). */
export interface DueCardCloze {
  /** The example sentence with the answer span replaced by `______` (6 underscores). */
  blanked: string;
  /** English translation of the sentence, when on file. */
  english: string | null;
  // NO span offsets on the wire (fix-pass M4): blankEnd − blankStart would be
  // the answer's length — the post-wrong-attempt hint's reveal, pre-leaked.
  // The client renders the fixed-width marker and needs no offsets.
}

/**
 * Body for `POST /vocab/cards/:cardId/cloze/grade` (F-208). `answer` is
 * required unless `giveUp` is true (the server 400s otherwise); `attempt`
 * drives the hint-then-reveal flow and the committed rating (attempt 1
 * correct → 'good', attempt 2 correct → 'hard', wrong-out/give-up → 'again').
 */
export interface ClozeGradeRequest {
  answer?: string;
  expected_version: number;
  attempt: 1 | 2;
  giveUp?: boolean;
}

/** Partial hint from a NON-committing wrong-attempt-1 grade (F-208). */
export interface ClozeGradeHint {
  /** First character of the answer surface. */
  firstChar: string;
  /** Character count of the answer surface. */
  length: number;
}

/**
 * Wrong on attempt 1 without surrender — NON-committing: no FSRS write, no
 * version change, and NO answer reveal. Hint only.
 */
export interface ClozeGradeHintResponse {
  correct: false;
  hint: ClozeGradeHint;
}

/**
 * A COMMITTING grade outcome (correct on any attempt, wrong on attempt 2, or
 * give-up): the server has ALREADY advanced the same card's FSRS schedule —
 * the client must NOT also call `submitReview` for this card. Carries the
 * reveal (`answerSurface` + `fullSentence`) and the fresh version snapshot.
 */
export interface ClozeGradeCommittedResponse {
  correct: boolean;
  answerSurface: string;
  fullSentence: string;
  rating: 'good' | 'hard' | 'again';
  version: number;
  due_at: string;
  scheduled_days: number;
}

/** Union of the grade route's two 200 shapes — discriminate on `'hint' in r`. */
export type ClozeGradeResponse = ClozeGradeHintResponse | ClozeGradeCommittedResponse;

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

/**
 * Result envelope from `POST /vocab/cards/clear` — how many of the user's
 * vocab review cards were removed (soft-deleted) by the bulk clear. The
 * underlying WORDS stay saved (`vocab_entries` and list memberships are
 * never touched); only the review cards leave the queue.
 */
export interface ClearCardsResult {
  cleared: number;
}

/** Result envelope from `POST /vocab/cards/:id/reviews`. */
export interface ReviewResult {
  version: number;
  due_at: string;
  /**
   * Server-computed whole-day interval to the next review. 0 means the card
   * is on a minute-scale learning step (`again` → ~50s / under a minute,
   * `hard` on unlearned material → ~6 minutes), not "due now".
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

/**
 * Which target a list-membership row points at (migration 049's XOR — vocab /
 * grammar / hanja). F-091: the client must key rows AND issue deletes on the
 * `(item_type, entry_id)` PAIR, not `entry_id` alone — a grammar and a vocab
 * membership in the SAME list can carry the identical numeric target id
 * (they're rows in different corpus tables), so `entry_id` alone is
 * ambiguous. Optional on the wire type (not `.strict()`-required) only for
 * back-compat with a pre-091 fixture/mock that omits it; the live server
 * always sends it (`server/src/routes/vocabLists.ts`) — a caller that reads
 * it absent should default to `'vocab'` (the pre-049 shape every such row
 * actually is).
 */
export type ListEntryItemType = 'vocab' | 'grammar' | 'hanja';

/** One joined entry row inside a list's detail (entry id + the vocab columns). */
export interface VocabListEntryRow {
  entry_id: number;
  /** See {@link ListEntryItemType}. */
  item_type?: ListEntryItemType;
  position: number;
  added_at: string;
  korean: string | null;
  english: string | null;
  proficiency: string | null;
  /**
   * F-112 — the vocab entry's corpus example sentence, JOINed by the server
   * so a list-study card back is complete without a separate KRDICT lookup.
   * `undefined` against a pre-112 fixture/mock; `null` for a real row with no
   * example on file (or a non-vocab `item_type`). Render defensively against
   * both.
   */
  example_korean?: string | null;
  example_english?: string | null;
  /** Grammar-target display fields — populated only when `item_type === 'grammar'`. */
  pattern?: string | null;
  title_en?: string | null;
  /** Hanja-target display fields — populated only when `item_type === 'hanja'`. */
  hanja_char?: string | null;
  hanja_sound?: string | null;
  hanja_gloss_en?: string | null;
  hanja_level?: string | null;
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
  /** See {@link ListEntryItemType}. Always present — the server's INSERT …
   *  RETURNING always computes it, even for a legacy `entry_ids`-shaped body
   *  (every id in that shape targets vocab). */
  item_type: ListEntryItemType;
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

/**
 * One sample sentence on a KGIU entry detail (`examples[]` element).
 * Shape verified against live km-db: every element carries exactly
 * `{korean, english}` with string values (never null).
 */
export interface KgiuExample {
  korean: string;
  english: string;
}

/** One speaker turn inside a KGIU dialogue (`dialogues[].lines[]` element). */
export interface KgiuDialogueLine {
  speaker: string;
  korean: string;
  english: string;
}

/**
 * One dialogue block on a KGIU entry detail (`dialogues[]` element).
 *
 * Shape comes from the loader contract documented on
 * `db/migrations/002_darakwon_corpora.up.sql` (`kgiu_entries.dialogues`
 * column comment). The current corpus load has NO populated dialogues
 * (every row is `[]`), so unlike {@link KgiuExample} this shape is not yet
 * verified against live rows — treat it as the contract for future loads.
 */
export interface KgiuDialogue {
  context: string;
  lines: KgiuDialogueLine[];
  /** Alternative renderings — shape not pinned down by the loader yet. */
  alternatives?: unknown;
}

/**
 * Server-side KGIU entry detail (`GET /grammar/kgiu/:id`).
 *
 * The three F-018 rich fields are JSONB columns constrained `NOT NULL
 * DEFAULT '[]'` with a `jsonb_typeof(...) = 'array'` CHECK, so the wire
 * value is always an array (possibly empty) — never null/undefined.
 * The remaining JSONB columns stay `unknown` until a feature renders them.
 */
export interface KgiuEntryDetail extends KgiuEntrySummary {
  explanation: string | null;
  /** Conjugation/formation bullets. Array of plain strings. */
  formation_rules: string[];
  /** Sample sentences (intro dialog + usage examples). */
  examples: KgiuExample[];
  /** Speaker-labelled dialogues. Empty across the current corpus load. */
  dialogues: KgiuDialogue[];
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
  /**
   * Real FSRS schedule state of this pattern's grammar PRODUCTION card
   * (F-111), folded into this row rather than a dedicated endpoint (see the
   * server route's comment for the risk tradeoff). `null` means the pattern
   * has never been drilled — no production card exists yet (FU-NF-42 creates
   * one lazily on the first drill submit); an honest "not started" rather
   * than a synthesized new-card default. Non-null for every pattern that has
   * ever been drilled, whether or not it's due right now — this is what lets
   * a mastery row show real state/next-due instead of only a due-NOW badge
   * (the due-NOW signal itself still comes from `GET /vocab/cards/due`).
   */
  schedule: GrammarCardSchedule | null;
}

/**
 * Full FSRS schedule snapshot for a grammar pattern's production card
 * (F-111). Distinct from `DrillSchedule` below: that one is the ONE-TIME
 * rating+interval a drill submit just derived; this is the card's CURRENT
 * persistent state, read back on every `GET /grammar/bank`.
 */
export interface GrammarCardSchedule {
  /** Current FSRS card state — same wire values as `FsrsState`. */
  state: FsrsState;
  /** NUMERIC arrives as a string (precision-safe — mirrors `DueCard.stability`). */
  stability: string;
  /** ISO timestamp the card is next due. */
  dueAt: string;
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
   * comes back. `scheduledDays === 0` means a minute-scale learning step
   * (`again` → ~50s / under a minute, `hard` → ~6 minutes) rather than a
   * day-grained interval. Optional so a server
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
   * Whole-day interval until the next review. `0` denotes a minute-scale
   * learning step (`again` → ~50s / under a minute, `hard` → ~6 minutes).
   */
  scheduledDays: number;
}

/**
 * One row from `GET /grammar-drill/attempts` (F-110) — a SCORED practice
 * attempt only. A generated-but-never-submitted attempt (the learner hit
 * Skip) is excluded server-side, so every row here carries a real answer,
 * score, and verdict — never nulls to paper over. Snake_case mirrors
 * `BankedGrammarRow`'s convention for a direct DB-row read (as opposed to
 * `DrillItemPublic`/`DrillScore`, which are Claude JSON contracts).
 */
export interface DrillAttemptHistoryRow {
  id: number;
  pattern_key: string;
  pattern_display: string;
  drill_type: DrillType;
  user_answer: string;
  score: number;
  verdict: DrillVerdict;
  /** ISO timestamp of the submit that scored this attempt. */
  scored_at: string;
}

/** Paged envelope for `GET /grammar-drill/attempts` (F-110) — newest first. */
export interface DrillAttemptsPage {
  attempts: DrillAttemptHistoryRow[];
  /** Total SCORED attempts matching the query, for "N of total" / load-more. */
  total: number;
  limit: number;
  offset: number;
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
  /** User-set OR Claude auto-generated (F-036) title; `null` until named —
   *  the sidebar falls back to a derived snippet, then mode + date. */
  title: string | null;
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

/**
 * Optional image reference on a persisted turn (chat rework Slice 1 —
 * mirrors the server's `StoredTurnImage` in routes/conversation.ts). Present
 * only on turns created by `POST /conversation/:id/image`: the turn's
 * `content` is the OCR'd Korean text and this block carries the capture
 * linkage + the English translation. `blob_url` is a same-origin path — join
 * it onto the API base like `services/images.ts` `blobUrlFor` does before
 * using it as an `<img src>`.
 */
export interface ConversationTurnImage {
  capture_id: number;
  blob_url: string;
  caption_kr: string;
  caption_en: string;
}

/**
 * Optional document reference on a persisted turn (F-035 attach — mirrors
 * the server's `StoredTurnFile` in routes/conversation.ts). Present only on
 * turns created by `POST /conversation/:id/file`: the turn's `content` is
 * the document's (bounded) text and this block carries display metadata
 * only — `name` is a sanitized basename, never a path.
 */
export interface ConversationTurnFile {
  name: string;
  media_type: string;
  size_bytes: number;
  /** True when the stored text is a truncated excerpt of a longer document. */
  truncated: boolean;
}

/**
 * One persisted turn as the server stores it in the `messages` JSONB (the
 * server's `StoredTurn`). This is the WIRE shape `GET /conversation/:id`
 * returns — distinct from the render-side `ConversationMessage` (kr/en
 * bilingual line) the Chat screen builds. Plain text turns carry neither
 * `image` nor `file`.
 */
export interface StoredConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  sent_at: string;
  request_id?: string;
  image?: ConversationTurnImage;
  file?: ConversationTurnFile;
}

/** Payload of `GET /conversation/:id` — full history + streaming metadata. */
export interface ConversationDetail {
  id: number;
  /** User-set OR Claude auto-generated (F-036) title; `null` until named. */
  title: string | null;
  mode: string;
  target_register: string | null;
  /** Optimistic-concurrency snapshot — send as `expected_version` on the
   *  next append/stream against this conversation. */
  version: number;
  messages: StoredConversationTurn[];
  created_at: string;
  updated_at: string;
}

/** Envelope for `GET /conversation/:id`. */
export interface ConversationDetailResult {
  conversation: ConversationDetail;
}

/** Result envelope from `POST /conversation/:id/image` (201). */
export interface AppendImageTurnResult {
  version: number;
  messages: unknown;
  /** The appended user turn — always carries `image`. */
  turn: StoredConversationTurn;
}

/** Result envelope from `POST /conversation/:id/file` (201, F-035 attach). */
export interface AppendFileTurnResult {
  version: number;
  messages: unknown;
  /** The appended user turn — always carries `file`. */
  turn: StoredConversationTurn;
}

/** Result envelope from `POST /conversation/:id/name` (F-036 auto-naming). */
export interface NameConversationResult {
  title: string;
  /** `false` when the conversation was already named — the returned title
   *  is the existing one, and no Claude call was made. */
  generated: boolean;
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
    /**
     * F-006: whether the account email has been verified (derived server-side
     * from `email_verified_at`; the timestamp itself is never exposed).
     * Drives the "verify your email" banner. Optional in the wire type for
     * legacy fixtures; the server always sends it.
     */
    email_verified?: boolean;
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

// ── Email verification (F-006) ────────────────────────────────
//
// SECURITY — same posture as the MFA types above: the raw verification token
// arrives ONLY via the emailed link's URL, is relayed straight to
// `POST /auth/verify`, and is never persisted by the client. Error copy is
// mapped from `code`/`status` through fixed tables (never echoed server text).

/**
 * `POST /auth/register` envelope. Two shapes by deployment posture:
 *   - gate ON (`EMAIL_VERIFICATION_REQUIRED`, the prod default) →
 *     `status:'verification_required'` and NO session cookie — the client
 *     shows the "check your email" screen.
 *   - gate OFF → the legacy `{user}` shape with the session cookie set.
 */
export type RegisterResponse =
  | { status: 'verification_required'; user: { id: number; email: string } }
  | { status?: undefined; user: AuthMeResponse['user'] };

/** `GET|POST /auth/verify` success envelope. `already_verified` is the
 *  friendly idempotent shape (double-clicked link, replay after success). */
export interface VerifyEmailResponse {
  status: 'verified' | 'already_verified';
}

/** `POST /auth/verify/resend` envelope — deliberately a fixed generic shape
 *  in EVERY case (anti-enumeration; see the server route). */
export interface ResendVerificationResponse {
  status: 'ok';
}

/** `register()` outcome the Login screen branches on. */
export type RegisterOutcome = 'authenticated' | 'verification_required';

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
 *
 * NO `id` FIELD: the server's `ImageWordDTO` (routes/images.ts) carries
 * `kr/en/gloss/pos` only — `image_words` rows are projected WITHOUT an id.
 * The client previously declared one, keyed React rows and the "added to
 * bank" set on it, and every real word arrived with `id === undefined`, so
 * banking one word marked EVERY word "Added". UI code must derive a stable
 * per-word key from what the wire actually sends (list position + text) —
 * see `ocrWordKey` in pages/Images.tsx.
 */
export interface OcrWord {
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
 * TOPIK II writing rubrics — mirrors the server's `TopikRubricSchema`
 * (server/src/services/claude/models.ts). Scoped to the curated bank/topik-
 * mode-generation taxonomy ONLY:
 *   - `topik_ii_53` — Q53, 200–300자 explanatory/description writing.
 *   - `topik_ii_54` — Q54, 600–700자 argumentative essay.
 * Used for `WritingPromptDTO.rubric` (the bank is Q53/Q54 only today) and
 * `POST /writing/generate`'s `mode: 'topik'` rubric param. For the broader
 * GRADING taxonomy (which also accepts `free_write`), see `WritingRubric`.
 */
export type TopikWritingRubric = 'topik_ii_53' | 'topik_ii_54';

/**
 * The full GRADING rubric taxonomy — mirrors the server's
 * `WritingGradeRubricSchema` (server/src/services/claude/models.ts), widened
 * by migration 056 (F-117) to add `free_write`: a Claude-generated open-topic
 * sample (mode='general', no TOPIK rubric of its own) now grades against a
 * real free-write rubric instead of borrowing Q54's as an ill-fitting
 * stand-in. Used wherever a GRADE (input or echoed output) carries a rubric —
 * `GradeWritingBody.rubric`, `WritingGradeResult.rubric`, and the
 * `GET /writing/attempts` history DTO — as opposed to `TopikWritingRubric`,
 * which stays scoped to the curated bank/topik-generation taxonomy.
 */
export type WritingRubric = TopikWritingRubric | 'free_write';

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
 * field. The three dimensions are the official rubric axes shared by all
 * three rubrics (TOPIK II Q53/Q54, and `free_write` as of 056/F-117).
 */
export interface WritingGradeResult {
  rubric: WritingRubric;
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
 *   - `rubric` — optional; server defaults to `topik_ii_54`. As of migration
 *     056 (F-117) also accepts `free_write` for a Claude-generated open-topic
 *     sample.
 *   - `promptId` — optional (F-014); the `writing_prompts.id` of the served
 *     task so the persisted `writing_attempts` row links to its source.
 *     Omitted (never `undefined`-valued) for a promptless grade.
 * (The edge also tolerates an optional `targetLevel` hint but does not
 * forward it, so the client intentionally omits it.)
 */
export interface GradeWritingBody {
  prompt: string;
  sample: string;
  rubric?: WritingRubric;
  promptId?: number;
}

/** Envelope from `POST /grade-writing` — the proxy's `ProxyResult<GradeResult>`. */
export interface GradeWritingResponse {
  result: WritingGradeResult;
  metadata: WritingCallMetadata;
}

/**
 * One entry in the caller's graded-writing history — mirrors
 * `GET /writing/attempts`'s wire DTO (server/src/routes/writing.ts, F-106).
 * `promptId` is `null` for a Claude-generated topic (no `writing_prompts`
 * source row to link — mode='general' free-writes and mode='topik' generated
 * topics alike); non-null for a bank-drawn TOPIK prompt. `rubric` is the full
 * `WritingRubric` taxonomy (a persisted attempt may carry any of the three).
 */
export interface WritingAttemptDTO {
  id: number;
  promptId: number | null;
  rubric: WritingRubric;
  promptKr: string;
  sample: string;
  totalScore: number;
  maxTotal: number;
  estimatedLevel: WritingEstimatedLevel | null;
  /** ISO timestamp of when the grade was recorded. */
  gradedAt: string;
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

// ── My Audio (Track A — user uploads + Whisper transcripts) ──────────────
//
// Domain shapes for the `/audio` routes (server/src/routes/audio.ts):
// `POST /audio` (upload one mp3/m4a + enqueue transcription), `GET /audio`
// (this user's sources + per-track transcript status — the polling surface),
// `GET /audio/tracks/:id` (one owned track + its ordered transcript
// segments), and `GET /audio/tracks/:id/stream` (Range-capable bytes the
// `<audio>` element points at via `streamUrl`). The `GET /audio` wire is
// snake_case (mapped in services/audio.ts); the track-detail and upload
// responses are camelCase on the wire already.

/**
 * One track's transcription lifecycle (`audio_tracks.transcript_status`):
 * `pending` → enqueued for the km-worker, `running` → Whisper in progress,
 * then settles `done` (segments exist) or `failed`. The A-4b Listen UI polls
 * `GET /audio` / `GET /audio/tracks/:id` while a track is `pending`/`running`.
 * A track is PLAYABLE in every state — `streamUrl` serves the bytes whether
 * or not transcription has settled.
 */
export type AudioTranscriptStatus = 'pending' | 'running' | 'done' | 'failed';

/**
 * Which pipeline created an audio source. User uploads are always
 * `standalone_listening` (one source per upload, one track per source);
 * `paired_reader`/`topik` are the offline corpus loader's shapes.
 */
export type AudioSourceKind = 'paired_reader' | 'standalone_listening' | 'topik';

/** One track row inside a `GET /audio` source (play order = trackNumber).
 *  The wire's internal `slug` is deliberately dropped by the service mapper
 *  (no client use — the ExtractionRun field-dropping precedent). */
export interface AudioTrackSummary {
  id: number;
  trackNumber: number;
  /** Display title, or null (the detail/list UIs render fixed fallback copy). */
  title: string | null;
  byteSize: number;
  /** Milliseconds, or null until the worker measures it. */
  durationMs: number | null;
  transcriptStatus: AudioTranscriptStatus;
}

/**
 * One audio source (a set of tracks) from `GET /audio`, newest first. There
 * is deliberately NO source-level status field — the server never settles
 * `audio_sources.status` after enqueue, so per-track `transcriptStatus` is
 * the only truthful progress signal (see routes/audio.ts's AudioSourceDTO
 * note); clients derive any set-level rollup from `tracks[]`.
 */
export interface AudioSource {
  id: number;
  title: string;
  kind: AudioSourceKind;
  createdAt: string;
  /** In play order. Empty only for a (corpus edge case) trackless source. */
  tracks: AudioTrackSummary[];
}

/**
 * One curated shared source from `GET /audio/shared` (F-207). Same wire DTO
 * as `GET /audio`, but here the `slug` is KEPT by the service mapper — the
 * Listen page's curated tile manifest keys its presentation (title pair,
 * tone, icon, paired reading book) on it. Carries NO owner identity: the
 * server serves these rows cross-account and never projects user_id/email
 * (asserted by the route tests).
 */
export interface SharedAudioSource extends AudioSource {
  slug: string;
}

/** One ordered transcript line; the [startMs, endMs] window is what a future
 *  play-position highlight would key on. */
export interface AudioSegment {
  segmentNumber: number;
  startMs: number;
  endMs: number;
  body: string;
}

/** `track` block of `GET /audio/tracks/:id`. `streamUrl` is the app-relative
 *  sibling stream path (`/audio/tracks/:id/stream`) — resolved through
 *  `buildAudioSrc`'s strict allow-list before it ever reaches an `<audio>`
 *  element, exactly like the TTMIK/Iyagi `audioUrl`s. */
export interface AudioTrackMeta {
  id: number;
  title: string | null;
  transcriptStatus: AudioTranscriptStatus;
  durationMs: number | null;
  streamUrl: string;
}

/** Envelope of `GET /audio/tracks/:id`. A not-yet-transcribed track has
 *  `segments: []` — a normal state the UI polls through, never an error. */
export interface AudioTrackDetail {
  track: AudioTrackMeta;
  segments: AudioSegment[];
}

/** 201 body of `POST /audio` — the freshly created source/track/job triple.
 *  `transcriptStatus` is always `pending` at upload time. */
export interface AudioUploadResponse {
  sourceId: number;
  trackId: number;
  jobId: number;
  transcriptStatus: AudioTranscriptStatus;
}

// ─────────────────────────────────────────────────────────────
// Per-skill trend series (F-017 — Today's "Progress by skill")
// ─────────────────────────────────────────────────────────────

/** One day's data point in a skill trend series (F-017). */
export interface SeriesPoint {
  /** Calendar day, `YYYY-MM-DD` (server-local). */
  date: string;
  value: number;
}

/**
 * One skill's trend over the requested window, as the series endpoints
 * (`GET /topik/series`, `GET /vocab/series`, `GET /grammar/series`,
 * `GET /writing/series`) return it. `points` is ascending by date; days
 * without activity are absent, not zero-filled.
 *
 * `metric` names what `value` measures:
 *   - `accuracy` — percent correct that day (0–100; `unit` is `'%'`).
 *   - `count`    — how many of something (vocab reviews; `unit` is `'reviews'`).
 *   - `score`    — a graded score. Grammar scores on the server's raw scale
 *                  (`unit` is `'pts'`); Writing normalizes to percent-of-max
 *                  (`unit` is `'%'`) so Q53/30 and Q54/50 are comparable.
 *   - `none`     — CLIENT-ONLY sentinel: a skill whose fetch failed and
 *                  degraded to an honest placeholder. Never on the wire;
 *                  `points` is empty.
 */
export interface SkillSeries {
  metric: 'accuracy' | 'count' | 'score' | 'none';
  /** Display unit for `value` (`'%'`, `'reviews'`, `'pts'`, …). Empty for `none`. */
  unit: string;
  /** Ascending by `date`. */
  points: SeriesPoint[];
}

/**
 * All five skill trends the Today carousel renders, assembled by
 * `fetchSkillSeries` from the four series endpoints (F-014 gave Writing a
 * real `/writing/series` route). A skill whose route failed degrades to the
 * `metric: 'none'` placeholder — never fabricated points.
 */
export interface AllSkillSeries {
  reading: SkillSeries;
  listening: SkillSeries;
  vocab: SkillSeries;
  grammar: SkillSeries;
  writing: SkillSeries;
}

// ─────────────────────────────────────────────────────────────
// Book uploads (U1 — PDF book-upload feature)
// ─────────────────────────────────────────────────────────────
//
// A user-uploaded scanned-book PDF. U1a (server) only stores + streams the
// PDF; U2 (a later phase) OCRs/curates it and tags the resulting
// vocab/grammar/dialogue/literature rows with `source_upload_id`. See
// `db/docs/PDF_UPLOAD_DESIGN.md`. `services/uploads.ts` is the wire↔domain
// boundary (mirrors `services/images.ts`'s split for image captures).

/**
 * What kind of content this book is expected to populate once U2's
 * extraction lands. `'both'` = vocab + grammar from the same source.
 * `'comic'` (Track P) is a display-only picture/comic/manga book read as
 * page images in the upload viewer — never grammar-bearing, never
 * auto-OCR'd.
 */
export type BookUploadType =
  | 'vocab'
  | 'grammar'
  | 'both'
  | 'dialogue'
  | 'literature'
  | 'comic';

/**
 * Processing state. U1 has no extraction yet, so every upload stays
 * `processing` from the moment it lands — U2 is what eventually flips a row
 * to `ready` (or `failed` if curation errors out). The PDF itself is
 * viewable immediately regardless of status (design doc: "async — upload →
 * viewable now → structured content lands when curated").
 */
export type BookUploadStatus = 'processing' | 'ready' | 'failed';

/**
 * A user-uploaded book PDF, as `listUploads` / `getUpload` / `uploadBook`
 * (services/uploads.ts) resolve it — the in-app shape for `GET /uploads`,
 * `GET /uploads/:id`, and the `POST /uploads` response alike.
 */
export interface BookUpload {
  /** Server row id (BIGINT identity, wire string — see routes/uploads.ts). */
  id: string;
  title: string;
  type: BookUploadType;
  status: BookUploadStatus;
  /**
   * Page count, once known. The normalize-to-pages step (zip/PDF → ordered
   * page images, `book_pages`) runs synchronously at ingest (design doc
   * REVISION), so this is present as soon as `status` is `ready`; still
   * `?`-optional (rather than a fabricated 0) for a `processing`/`failed` row
   * whose `page_count` column is null.
   */
  pageCount?: number;
  byteSize: number;
  createdAt: string;
}

/**
 * One page of an upload's ordered page-image sequence (`book_pages`,
 * migration 041) — its stable DB identity (`id`) plus its current 1-based
 * DISPLAY position (`pageNumber`, matches `GET /uploads/:id/page/:n`'s `:n`).
 * The reorder tool (vFlat retakes can land out of order — see the design
 * doc's REVISION) operates on `id`; `pageNumber` is what a reorder changes.
 * `services/uploads.ts` is the wire↔domain boundary.
 */
export interface Page {
  id: string;
  pageNumber: number;
}

/**
 * One OCR extraction run's lifecycle state (F-059/F-108). `pending` is
 * reserved server-side for a future async runner — the current synchronous
 * pipeline claims straight into `running` and settles `done`/`failed`, but a
 * client can still OBSERVE `running` (a run triggered from another tab, or
 * one orphaned by a server restart until the stale-reap claims it).
 */
export type ExtractionRunStatus = 'pending' | 'running' | 'done' | 'failed';

/**
 * One OCR extraction run over an upload's page range, as `startExtraction` /
 * `listExtractions` (services/uploads.ts) resolve it — the in-app shape for
 * `POST /uploads/:id/extract` (the settled run) and `GET
 * /uploads/:id/extract` (the run history, newest first). Wire (`routes/
 * uploads.ts` → `services/uploadExtract.ts`'s `ExtractionRunDTO`) is
 * snake_case; the service maps it here. Two wire fields are deliberately
 * NOT carried across: `upload_id` (always the id the caller asked about —
 * the parent route 404s any other) and `error` (server-generated prose; the
 * app's fixed-copy rule forbids echoing it, so the client renders its own
 * copy off `status === 'failed'` instead).
 */
export interface ExtractionRun {
  id: number;
  status: ExtractionRunStatus;
  /** 1-based inclusive page range this run covered. */
  pageFrom: number;
  pageTo: number;
  pagesRequested: number;
  pagesOcred: number;
  pagesFailed: number;
  vocabInserted: number;
  grammarInserted: number;
  wordsSkipped: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** `GET /uploads/:id/extract`'s resolved envelope — the run history (newest
 *  first, server-bounded) plus the server's per-run page ceiling (the F-059
 *  button surfaces it as a "scans up to N pages at a time" hint). */
export interface ExtractionRuns {
  runs: ExtractionRun[];
  maxPagesPerRun: number;
}

// ─────────────────────────────────────────────────────────────
// Reading — U3b digitized chapter reader (`reading_chapters` /
// `reading_passages`, migration 044). Read-only: a literature `BookUpload`
// (see above) is OCR'd + curated into chapters of tappable passages.
// `services/reading.ts` is the wire↔domain boundary; unlike `BookUpload`'s
// wire-string ids, `routes/reading.ts` already returns every id as a JSON
// number (it does the BIGINT→Number conversion server-side), so no `id:
// string` split is needed here.

/**
 * One chapter of a digitized book, as the chapter-list endpoint
 * (`GET /reading/chapters?source_upload_id=`) returns it — the reader's
 * chapter selector. `title` is null for books whose chapters aren't
 * individually titled (falls back to `Chapter {chapterNumber}` in the UI).
 */
export interface ReadingChapterSummary {
  id: number;
  chapterNumber: number;
  title: string | null;
  /** 1-based page range on the original scan (`book_pages.page_number`),
   *  null until the OCR/curation pass links a chapter to its scan pages. */
  startPage: number | null;
  endPage: number | null;
}

/**
 * One chapter's full metadata, as the chapter-detail endpoint
 * (`GET /reading/chapters/:id`) returns it — adds `sourceUploadId` (the
 * owning `BookUpload.id`, as a number) over `ReadingChapterSummary`, needed
 * to link back to the original-scan viewer (`/uploads/:id`).
 */
export interface ReadingChapter extends ReadingChapterSummary {
  sourceUploadId: number;
}

/**
 * One paragraph/passage within a chapter (`reading_passages`) — the
 * reader's tap-to-define unit and the per-passage progress/graded-passage
 * reuse key (see `db/docs/U3_READER_DESIGN.md` §U3b). `body` is the OCR'd +
 * curated text and may contain internal `\n`s that the reader preserves
 * visually rather than collapsing.
 */
export interface ReadingPassage {
  id: number;
  passageNumber: number;
  body: string;
  pageNumber: number | null;
}

// ─────────────────────────────────────────────────────────────
// Tickets (F-023) — in-app beta feedback/ticketing (`server/src/routes/
// tickets.ts`, already deployed). `services/tickets.ts` is the wire↔domain
// boundary — server rows are snake_case; these are the camelCase shapes
// every consumer reads. Author identity is NEVER present on any of these
// types — the anonymity contract (F-023): `isMine` is the only
// identity-adjacent signal any list/thread carries, and it is computed
// server-side against the CALLER's own id, so it reveals nothing about any
// other author. There is no field here a UI could reach for to render an
// author even by mistake.

export type TicketType = 'bug' | 'concern' | 'suggestion' | 'request';
export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed';

/** POST /tickets body. */
export interface CreateTicketBody {
  type: TicketType;
  title: string;
  body: string;
  /**
   * F-127: the app PATH (never a label — see nav.ts `pageNameForPath`) the
   * global "!" FAB was tapped from, e.g. `/learn/writing`. Omit entirely
   * (never send an empty string) when there is no known page context —
   * mirrors the server's Zod schema (routes/tickets.ts), which stores a
   * genuine SQL NULL only when the field is absent. Client-reported UI
   * context, NOT author-identifying — orthogonal to the anonymity contract
   * this module's header describes.
   */
  sourcePage?: string;
}

/**
 * A ticket as `GET /tickets/mine` (and the POST/PATCH response) returns it —
 * the CALLER's own, carrying `version` for the PATCH optimistic-concurrency
 * contract. Only ever rendered to its owner.
 */
export interface OwnTicket {
  id: number;
  type: TicketType;
  title: string;
  body: string;
  status: TicketStatus;
  version: number;
  /** F-127: the app path this ticket was filed from, or `null` when filed
   *  without page context (pre-058 rows, or the Settings tile). Feed this
   *  PATH — not this string re-labeled by hand — into `pageNameForPath`
   *  (lib/nav.ts) to render "Reported from: <name>". */
  sourcePage: string | null;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A ticket as `GET /tickets/community` returns it — ANONYMIZED (F-023): no
 * author field exists on this type at all, by construction.
 */
export interface CommunityTicket {
  id: number;
  type: TicketType;
  title: string;
  body: string;
  status: TicketStatus;
  /** F-127: same contract as `OwnTicket.sourcePage` — a path, or `null`.
   *  Client-reported UI context, NOT author-identifying (safe on the
   *  anonymized community feed for the same reason `type`/`title` are). */
  sourcePage: string | null;
  commentCount: number;
  /** Whether the CALLER filed this ticket — reveals nothing about anyone else. */
  isMine: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * `GET /tickets/:id` — the one id-addressed ticket read. The SERVER decides
 * which shape the caller gets: the owner shape (`OwnTicket`, carrying
 * `version` and therefore edit rights) for the caller's own ticket, the
 * ANONYMIZED community shape (`CommunityTicket`, F-023) for anyone else's.
 * `kind` mirrors that server decision — client code must derive edit rights
 * from it (or from `/mine` membership), never from a client-side guess.
 */
export type TicketDetailResult =
  | { kind: 'own'; ticket: OwnTicket }
  | { kind: 'community'; ticket: CommunityTicket };

/**
 * PATCH /tickets/:id body — optimistic concurrency via `expectedVersion`
 * (mapped to the wire's `expected_version` in services/tickets.ts). A stale
 * value 409s; the caller must refetch the fresh row (`fetchTicket`) and
 * retry against its version.
 */
export interface PatchTicketBody {
  title?: string;
  body?: string;
  status?: TicketStatus;
  expectedVersion: number;
}

/** One comment in a ticket's thread — anonymized, same contract as CommunityTicket. */
export interface TicketComment {
  id: number;
  body: string;
  isMine: boolean;
  createdAt: string;
}

/** Server-side list filters shared by `/tickets/mine` and `/tickets/community`. */
export interface TicketListQuery {
  status?: TicketStatus;
  type?: TicketType;
  limit?: number;
  offset?: number;
}
