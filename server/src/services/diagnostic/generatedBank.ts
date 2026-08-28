/**
 * F-220 slice 1 — draw path for the generated, copyright-clean assessment-
 * item bank (`generated_items`, migration 101).
 *
 * `pickGeneratedItem` is the ONLY thing this module does: draw one
 * `status = 'approved'` row for a (section, level) cell. It is read-only
 * against `generated_items` — nothing here writes a row (that's
 * `server/src/scripts/generate-item-bank.ts`'s `--ingest` mode).
 *
 * Gating is the CALLER's job, not this function's: `routes/diagnostic.ts`
 * `buildGeneratedItem` only calls this when
 * `config.DIAGNOSTIC_USE_GENERATED_BANK` is true, and treats a `null`
 * result (bank empty/unreviewed for this cell) exactly like the flag being
 * off — fall through to the existing live Claude-generation path unchanged.
 * That fallback is what makes the default-off flag a true no-op: with the
 * flag off, this module is never imported into a live request path's
 * control flow at all.
 *
 * Returns a shape that mirrors `buildGeneratedItem`'s `ServerItem` output
 * field-for-field (minus `section`/`sourceKind`/`difficulty`, which the
 * caller already knows/computes) so the caller's mapping is a flat spread,
 * not a re-derivation.
 */
import { query, type Querier } from '../../db/pool.js';
import type { DiagnosticTargetLevel } from '../claude/index.js';

/** F-220 slice 1 wrote vocab/grammar rows; slice 2 added 'reading' — a
 *  generated, copyright-clean passage + comprehension MC item
 *  (kind='passage-mc', carries a non-null `passage`). Slice 3 adds
 *  'listening' — a generated dialogue + comprehension MC item
 *  (kind='audio-mc', carries NO passage/turns — see `GeneratedBankItem`'s
 *  doc — and is only servable once its audio is synthesized, i.e.
 *  `audio_source_id IS NOT NULL`). Still narrower than the table's full
 *  forward-compat `section` CHECK ('writing' is a later slice). */
export type GeneratedBankSection = 'vocab' | 'grammar' | 'reading' | 'listening';

const CHOICE_IDS = ['a', 'b', 'c', 'd'] as const;
type ChoiceId = (typeof CHOICE_IDS)[number];

export interface GeneratedBankChoice {
  readonly id: ChoiceId;
  readonly kr: string;
  readonly en: string;
}

/** A drawn bank item, shaped to slot directly into `ServerItem`
 *  (routes/diagnostic.ts) at the call site. */
export interface GeneratedBankItem {
  readonly id: number;
  readonly kind: string;
  readonly level: DiagnosticTargetLevel;
  /** The question stem — maps to `ServerItem.prompt`. */
  readonly prompt: string;
  /** The shared reading passage — present (non-empty) only for a
   *  section='reading' draw; `undefined` for vocab/grammar/listening (mirrors
   *  `ServerItem.passage`'s optional-field posture — `toClientItem` already
   *  forwards it verbatim when present). A listening draw NEVER carries this
   *  — the dialogue text must never reach the learner as readable text (see
   *  the module doc + routes/diagnostic.ts's listening mapping). */
  readonly passage?: string;
  /** Playable audio, present ONLY for a section='listening' draw — the
   *  `/audio/tracks/:id/stream` URL of this item's ONE synthesized dialogue
   *  blob, built here (mirrors `sourceRef`'s `bank:<id>` construction) so the
   *  caller's mapping is a flat spread. `undefined` for every other section. */
  readonly audioUrl?: string;
  readonly audioStartMs?: number;
  readonly audioEndMs?: number;
  readonly choices: readonly GeneratedBankChoice[];
  readonly correctAnswer: ChoiceId;
  readonly explain: string;
  /** `bank:<id>` — distinguishes a bank draw from a live-generation
   *  `sourceRef` (a raw vocab_entries/kgiu_entries id string) in
   *  `diagnostic_responses.item_payload` for observability/debugging. */
  readonly sourceRef: string;
}

interface GeneratedItemRow {
  readonly id: number;
  readonly kind: string;
  readonly level: string;
  readonly stem: string;
  readonly passage: string | null;
  readonly choices: ReadonlyArray<{ readonly kr: string; readonly en?: string }>;
  readonly answer_index: number;
  readonly explain: string | null;
  /** Only populated for a section='listening' row (the LEFT JOIN into
   *  audio_tracks) — the id of this item's ONE synthesized dialogue track,
   *  the stream route's path param. NULL for every other section (no join
   *  target) and for a listening row whose audio isn't synthesized yet (the
   *  WHERE clause already excludes those from ever reaching this row, but
   *  the column stays nullable at the type level for the join's sake). */
  readonly track_id: number | null;
  readonly audio_start_ms: number | null;
  readonly audio_end_ms: number | null;
}

/**
 * Draw one `status = 'approved'` item for `(section, level)`.
 *
 * `ORDER BY random() LIMIT 1` — least-used-first ordering is deferred (the
 * slice-1 brief calls plain random "fine for v1"); `ix_generated_items_draw
 * (section, level, status)` backs the WHERE, so the only unindexed cost is
 * the random-order shuffle over the (small, per-cell) approved slice.
 *
 * The `kind` predicate re-applies the SAME section<->kind contract the live
 * path enforces (routes/diagnostic.ts `buildGeneratedItem`/the reading and
 * listening draws in `buildItemForSection`: grammar items are kind
 * 'pattern', reading items are kind 'passage-mc', listening items are kind
 * 'audio-mc', vocab items are anything else) as a WHERE clause —
 * defense-in-depth so a future stray row (e.g. a hand-inserted admin fix)
 * can never surface through the draw path even if it slipped past the
 * ingest CLI's own guard.
 *
 * LISTENING (F-220 slice 3): a listening row is servable ONLY once its audio
 * is synthesized — `audio_source_id IS NOT NULL` is a HARD requirement in the
 * WHERE clause (an authored-but-silent draft row, or one whose audio_source
 * was deleted/un-cut, must never surface here — the learner cannot be handed
 * an "audio-mc" item with nothing to listen to). The row's `turns` (the
 * dialogue script) are NEVER selected — this function returns the audio
 * URL/offsets, never the transcript, so it is structurally impossible for a
 * caller to accidentally leak the dialogue text through this path.
 *
 * `exec` is injectable (defaults to the shared pool's `query`) so tests can
 * run against a per-test database without touching module-level pool state.
 *
 * Returns null when no approved (and, for listening, audio-ready) row
 * matches the cell — the caller's cue to fall through to live generation
 * (vocab/grammar) or `pickTopikRow` (reading/listening).
 */
export async function pickGeneratedItem(
  section: GeneratedBankSection,
  level: DiagnosticTargetLevel,
  exec: Querier = query,
): Promise<GeneratedBankItem | null> {
  // 'grammar' -> exactly kind='pattern'; 'reading' -> exactly
  // kind='passage-mc'; 'listening' -> exactly kind='audio-mc' (all an
  // exact-match `=`, section is ALSO in the WHERE clause so this is never
  // ambiguous with another section's kind); 'vocab' -> anything EXCEPT
  // 'pattern' (unchanged from slice 1 — a vocab row can never legitimately
  // carry kind='passage-mc'/'audio-mc' in the first place, since the ingest
  // CLI only ever writes those kinds under section='reading'/'listening').
  const kindOp = section === 'vocab' ? '<>' : '=';
  const kindValue = section === 'reading' ? 'passage-mc' : section === 'listening' ? 'audio-mc' : 'pattern';
  // See the function doc — a listening row must have synthesized audio to be
  // servable. LEFT JOIN so vocab/grammar/reading rows (audio_source_id
  // always NULL for them) are unaffected; the extra WHERE term is a no-op
  // (`TRUE`) for every non-listening section.
  const audioReadyClause = section === 'listening' ? 'AND gi.audio_source_id IS NOT NULL' : '';
  const { rows } = await exec<GeneratedItemRow>(
    `SELECT gi.id, gi.kind, gi.level, gi.stem, gi.passage, gi.choices, gi.answer_index,
            gi.explain, at.id AS track_id, gi.audio_start_ms, gi.audio_end_ms
       FROM generated_items gi
       LEFT JOIN audio_tracks at ON at.source_id = gi.audio_source_id
      WHERE gi.section = $1
        AND gi.level = $2
        AND gi.status = 'approved'
        AND gi.kind ${kindOp} $3
        ${audioReadyClause}
      ORDER BY random()
      LIMIT 1`,
    [section, level, kindValue],
  );
  const row = rows[0];
  if (row === undefined) return null;

  const choices: GeneratedBankChoice[] = row.choices.map((c, i) => ({
    id: CHOICE_IDS[i]!,
    kr: c.kr,
    en: c.en ?? '',
  }));
  // answer_index is CHECKed 0..3 and choices is CHECKed to length 4 at the
  // schema layer (migration 101) — CHOICE_IDS[row.answer_index] is always
  // defined for any row that passed those constraints.
  const correctAnswer = CHOICE_IDS[row.answer_index]!;

  // Listening's audio fields — built here (mirrors sourceRef's `bank:<id>`
  // construction) so routes/diagnostic.ts's mapping is a flat spread. The
  // audioReadyClause above guarantees track_id/audio_start_ms/audio_end_ms
  // are all non-null for any row that reaches this point when
  // section='listening'; the `!`s are safe under that WHERE-clause proof,
  // not a runtime assumption for other sections (which never take this arm).
  const audioFields =
    section === 'listening'
      ? {
          audioUrl: `/audio/tracks/${String(row.track_id!)}/stream`,
          audioStartMs: row.audio_start_ms!,
          audioEndMs: row.audio_end_ms!,
        }
      : {};

  return {
    id: row.id,
    kind: row.kind,
    level: row.level as DiagnosticTargetLevel,
    prompt: row.stem,
    ...(row.passage !== null ? { passage: row.passage } : {}),
    ...audioFields,
    choices,
    correctAnswer,
    explain: row.explain ?? '',
    sourceRef: `bank:${String(row.id)}`,
  };
}

// -----------------------------------------------------------------------------
// F-220 P1 — pickGeneratedStimulusGroup (paired-stimulus draw)
//
// Draws ONE approved, COMPLETE stimulus group — several `generated_items`
// rows sharing one `stimulus_group_id` (migration 105): 2-3 rows carrying
// the SAME `passage` for a paired-reading group (kind='paired-passage-mc'),
// or 2 rows carrying the SAME `audio_source_id` for a paired-listening group
// (kind='paired-audio-mc'). Ships DARK in P1 — this function is fully built
// and tested here but wired into NO route/surface yet; P3 (the generated
// mock exam) is the intended caller.
//
// "COMPLETE" for a group means: every row in the group is `status =
// 'approved'` (never a mix of approved/draft/retired rows — a group is an
// atomic serving unit, not individually-approvable rows), AND, for
// paired-listening, every row already has a non-null `audio_source_id` (the
// synth CLI, scripts/synthesize-listening-audio.ts, stamps that column onto
// EVERY row in a group together in one transaction — so within one group it
// is always all-null or all-set, never partial; this HAVING clause is
// defense-in-depth against a hypothetical future writer that broke that
// invariant, mirroring pickGeneratedItem's own defense-in-depth kind checks).

/** One question within a drawn stimulus group — the SAME per-question shape
 *  `GeneratedBankItem` already uses for a standalone item's choices, just
 *  without the top-level id/kind/level/passage/audio fields (those live once
 *  on the group, not once per question). */
export interface StimulusGroupQuestion {
  readonly prompt: string;
  readonly choices: readonly GeneratedBankChoice[];
  readonly correctAnswer: ChoiceId;
  readonly explain: string;
}

/** A drawn, complete stimulus group. `passage` is present ONLY for a
 *  section='reading' draw; `audioUrl`/`audioStartMs`/`audioEndMs` are
 *  present ONLY for a section='listening' draw — mirrors
 *  `GeneratedBankItem`'s optional-field posture exactly. NO-LEAK: this shape
 *  has NO field for the listening dialogue's transcript/turns — it is
 *  structurally impossible for a caller to read the spoken text through this
 *  return value; only `audioUrl` is ever exposed (see `pickGeneratedStimulusGroup`'s
 *  doc and its dedicated no-leak test). */
export interface StimulusGroupDraw {
  readonly groupId: string;
  readonly section: 'reading' | 'listening';
  readonly level: DiagnosticTargetLevel;
  readonly passage?: string;
  readonly audioUrl?: string;
  readonly audioStartMs?: number;
  readonly audioEndMs?: number;
  readonly questions: readonly StimulusGroupQuestion[];
}

interface StimulusGroupQuestionRow {
  readonly stimulus_group_ordinal: number;
  readonly stem: string;
  readonly choices: ReadonlyArray<{ readonly kr: string; readonly en?: string }>;
  readonly answer_index: number;
  readonly explain: string | null;
  readonly passage: string | null;
  /** Only selected/populated for section='listening' (the LEFT JOIN into
   *  audio_tracks) — mirrors `GeneratedItemRow.track_id`. NEVER selected:
   *  `turns` (the dialogue transcript) — see the module/function doc. */
  readonly track_id?: number | null;
  readonly audio_start_ms?: number | null;
  readonly audio_end_ms?: number | null;
}

function mapStimulusGroupQuestion(row: {
  readonly stem: string;
  readonly choices: ReadonlyArray<{ readonly kr: string; readonly en?: string }>;
  readonly answer_index: number;
  readonly explain: string | null;
}): StimulusGroupQuestion {
  const choices: GeneratedBankChoice[] = row.choices.map((c, i) => ({
    id: CHOICE_IDS[i]!,
    kr: c.kr,
    en: c.en ?? '',
  }));
  // answer_index is CHECKed 0..3 and choices is CHECKed to length 4 at the
  // schema layer (migration 101) — CHOICE_IDS[row.answer_index] is always
  // defined for any row that passed those constraints.
  const correctAnswer = CHOICE_IDS[row.answer_index]!;
  return { prompt: row.stem, choices, correctAnswer, explain: row.explain ?? '' };
}

/**
 * Draw ONE approved, complete stimulus group for `(section, level)`.
 *
 * Two-step query: (1) pick ONE eligible `stimulus_group_id` at random via a
 * GROUP BY/HAVING over the candidate rows (mirrors `pickGeneratedItem`'s
 * `ORDER BY random() LIMIT 1` posture, just applied to groups instead of
 * rows); (2) fetch every row in that ONE group, ordered by
 * `stimulus_group_ordinal`, and map each to a question. `ix_generated_items_stimulus_group`
 * (migration 105) backs step 2's lookup; `ix_generated_items_draw`
 * (section, level, status — migration 101) backs step 1's WHERE.
 *
 * NO-LEAK (listening): the SELECT list for a listening group's rows NEVER
 * includes `turns` — the dialogue transcript column simply never appears in
 * either query below, so there is no code path through which this function
 * could return it even by accident. Only `audioUrl` (built from the joined
 * `audio_tracks.id`, exactly like `pickGeneratedItem`) is ever exposed for a
 * listening draw. See `server/tests/services/diagnostic/generatedBank.test.ts`'s
 * dedicated no-leak assertion.
 *
 * `exec` is injectable (defaults to the shared pool's `query`) so tests can
 * run against a per-test database without touching module-level pool state.
 *
 * Returns null when no approved-and-complete group matches the cell.
 */
export async function pickGeneratedStimulusGroup(
  section: 'reading' | 'listening',
  level: DiagnosticTargetLevel,
  exec: Querier = query,
): Promise<StimulusGroupDraw | null> {
  const kindValue = section === 'reading' ? 'paired-passage-mc' : 'paired-audio-mc';
  // Listening-only: every row in the candidate group must already have a
  // synthesized audio_source_id — see the module doc's "COMPLETE" definition.
  const audioReadyHaving =
    section === 'listening'
      ? 'AND COUNT(*) FILTER (WHERE gi.audio_source_id IS NULL) = 0'
      : '';

  const { rows: groupRows } = await exec<{ group_id: string }>(
    `SELECT gi.stimulus_group_id AS group_id
       FROM generated_items gi
      WHERE gi.section = $1
        AND gi.level = $2
        AND gi.kind = $3
        AND gi.stimulus_group_id IS NOT NULL
      GROUP BY gi.stimulus_group_id
     HAVING COUNT(*) >= 2
        AND COUNT(*) FILTER (WHERE gi.status <> 'approved') = 0
        ${audioReadyHaving}
      ORDER BY random()
      LIMIT 1`,
    [section, level, kindValue],
  );
  const groupId = groupRows[0]?.group_id;
  if (groupId === undefined) return null;

  if (section === 'reading') {
    const { rows } = await exec<StimulusGroupQuestionRow>(
      `SELECT stimulus_group_ordinal, stem, choices, answer_index, explain, passage
         FROM generated_items
        WHERE stimulus_group_id = $1
        ORDER BY stimulus_group_ordinal ASC`,
      [groupId],
    );
    const first = rows[0];
    if (first === undefined) return null;
    const questions = rows.map((r) => mapStimulusGroupQuestion(r));
    return {
      groupId,
      section: 'reading',
      level,
      ...(first.passage !== null ? { passage: first.passage } : {}),
      questions,
    };
  }

  // section === 'listening' — NEVER select `turns` here (see the doc above).
  const { rows } = await exec<StimulusGroupQuestionRow>(
    `SELECT gi.stimulus_group_ordinal, gi.stem, gi.choices, gi.answer_index, gi.explain,
            gi.passage, at.id AS track_id, gi.audio_start_ms, gi.audio_end_ms
       FROM generated_items gi
       LEFT JOIN audio_tracks at ON at.source_id = gi.audio_source_id
      WHERE gi.stimulus_group_id = $1
      ORDER BY gi.stimulus_group_ordinal ASC`,
    [groupId],
  );
  const first = rows[0];
  if (first === undefined) return null;
  const questions = rows.map((r) => mapStimulusGroupQuestion(r));
  // The group-eligibility HAVING clause above guarantees every row's
  // audio_source_id is non-null, and the synth CLI always creates the
  // audio_tracks row in the SAME transaction that sets audio_source_id — so
  // track_id/audio_start_ms/audio_end_ms are non-null here under that proof,
  // not a runtime assumption (mirrors pickGeneratedItem's identical `!`
  // usage for the same reason).
  return {
    groupId,
    section: 'listening',
    level,
    audioUrl: `/audio/tracks/${String(first.track_id!)}/stream`,
    audioStartMs: first.audio_start_ms!,
    audioEndMs: first.audio_end_ms!,
    questions,
  };
}

// -----------------------------------------------------------------------------
// F-220 P3 — kind-aware draws for the generated MOCK-EXAM surface
// (server/src/services/topik/generatedMock.ts).
//
// `pickGeneratedItem` enforces its OWN fixed section<->kind contract (exactly
// one kind per section — 'pattern' for grammar, 'passage-mc' for reading,
// 'audio-mc' for listening); the P2 single-item-type generators wrote MANY
// more kinds under 'reading'/'listening' (fill-blank, topic-id,
// match-content, …/dialogue-complete, whats-next, …) that a caller needs to
// draw BY NAME to follow a blueprint's type-block order — hence a separate,
// explicitly kind-parameterized draw rather than widening pickGeneratedItem's
// contract (which would let a diagnostic vocab/grammar draw start returning
// an arbitrary reading/listening kind, unrelated to its section's fixed
// shape). `excludeIds` lets the assembler draw the SAME kind repeatedly
// within one exam (a blueprint kind-block is usually >1 item) without
// re-serving the same row.
// -----------------------------------------------------------------------------

/**
 * Draw one `status = 'approved'` item matching an EXACT `kind`, for
 * `(section, level)`, excluding any id already drawn into the caller's
 * in-progress assembly.
 *
 * Unlike `pickGeneratedItem`, this does NOT enforce a fixed section<->kind
 * pairing — the caller (the mock blueprint) names the exact kind it wants for
 * this slot, and the WHERE clause matches it verbatim. `section` is still
 * REQUIRED and still gates the LISTENING audio-readiness clause (a listening
 * row is only servable once `audio_source_id IS NOT NULL` — the same
 * NO-LEAK-relevant guard `pickGeneratedItem` enforces): the mock surface only
 * ever calls this with section='reading'|'listening' (never vocab/grammar —
 * GeneratedMockSection, generatedMock.ts, is a narrower union).
 *
 * NO-LEAK: mirrors `pickGeneratedItem` exactly — the SELECT list never
 * includes `turns` (the listening dialogue transcript column); only
 * `audioUrl`/`audioStartMs`/`audioEndMs` are ever returned for a listening
 * draw, so it is structurally impossible for a caller to read the spoken
 * text through this function.
 *
 * `exec` is injectable (defaults to the shared pool's `query`) so tests can
 * run against a per-test database without touching module-level pool state.
 *
 * Returns null when no eligible row matches (kind unfunded/exhausted at this
 * cell, or every match already excluded) — the caller's cue to skip this
 * slot (a thin bank yields a shorter exam, never a crash — see
 * generatedMock.ts's assembler).
 */
export async function pickGeneratedItemOfKind(
  section: GeneratedBankSection,
  level: DiagnosticTargetLevel,
  kind: string,
  excludeIds: readonly number[] = [],
  exec: Querier = query,
): Promise<GeneratedBankItem | null> {
  const audioReadyClause = section === 'listening' ? 'AND gi.audio_source_id IS NOT NULL' : '';
  // A paired-stimulus row (stimulus_group_id NOT NULL) is a member of a
  // GROUP, drawn only via pickGeneratedStimulusGroup/
  // pickGeneratedStimulusGroupExcludingGroups — never individually — so it is
  // excluded here even if its own `kind` (e.g. 'paired-passage-mc') were
  // passed by mistake, keeping the two draw paths non-overlapping.
  const { rows } = await exec<GeneratedItemRow>(
    `SELECT gi.id, gi.kind, gi.level, gi.stem, gi.passage, gi.choices, gi.answer_index,
            gi.explain, at.id AS track_id, gi.audio_start_ms, gi.audio_end_ms
       FROM generated_items gi
       LEFT JOIN audio_tracks at ON at.source_id = gi.audio_source_id
      WHERE gi.section = $1
        AND gi.level = $2
        AND gi.status = 'approved'
        AND gi.kind = $3
        AND gi.stimulus_group_id IS NULL
        AND NOT (gi.id = ANY($4::bigint[]))
        ${audioReadyClause}
      ORDER BY random()
      LIMIT 1`,
    [section, level, kind, [...excludeIds]],
  );
  const row = rows[0];
  if (row === undefined) return null;

  const choices: GeneratedBankChoice[] = row.choices.map((c, i) => ({
    id: CHOICE_IDS[i]!,
    kr: c.kr,
    en: c.en ?? '',
  }));
  const correctAnswer = CHOICE_IDS[row.answer_index]!;

  const audioFields =
    section === 'listening'
      ? {
          audioUrl: `/audio/tracks/${String(row.track_id!)}/stream`,
          audioStartMs: row.audio_start_ms!,
          audioEndMs: row.audio_end_ms!,
        }
      : {};

  return {
    id: row.id,
    kind: row.kind,
    level: row.level as DiagnosticTargetLevel,
    prompt: row.stem,
    ...(row.passage !== null ? { passage: row.passage } : {}),
    ...audioFields,
    choices,
    correctAnswer,
    explain: row.explain ?? '',
    sourceRef: `bank:${String(row.id)}`,
  };
}

/**
 * Draw ONE approved, complete stimulus group for `(section, level)`,
 * excluding any group id already drawn into the caller's in-progress
 * assembly — the group-level sibling of `pickGeneratedItemOfKind`'s
 * `excludeIds`, so the mock assembler can draw MULTIPLE paired-stimulus
 * blocks across an exam without ever re-serving the same passage/dialogue.
 *
 * Identical to `pickGeneratedStimulusGroup` in every other respect (same
 * "complete group" definition, same NO-LEAK discipline — see that function's
 * doc, which this one does not repeat) — kept as a SEPARATE function rather
 * than adding an optional param to the existing one so
 * `pickGeneratedStimulusGroup`'s signature/behavior for its one existing
 * caller (diagnostic, if it ever wires this — today it wires nothing, P1
 * ships dark) stays byte-identical.
 *
 * `exec` is injectable (defaults to the shared pool's `query`) so tests can
 * run against a per-test database without touching module-level pool state.
 *
 * Returns null when no approved-and-complete, not-yet-excluded group matches.
 */
export async function pickGeneratedStimulusGroupExcludingGroups(
  section: 'reading' | 'listening',
  level: DiagnosticTargetLevel,
  excludeGroupIds: readonly string[],
  exec: Querier = query,
): Promise<StimulusGroupDraw | null> {
  const kindValue = section === 'reading' ? 'paired-passage-mc' : 'paired-audio-mc';
  const audioReadyHaving =
    section === 'listening'
      ? 'AND COUNT(*) FILTER (WHERE gi.audio_source_id IS NULL) = 0'
      : '';

  const { rows: groupRows } = await exec<{ group_id: string }>(
    `SELECT gi.stimulus_group_id AS group_id
       FROM generated_items gi
      WHERE gi.section = $1
        AND gi.level = $2
        AND gi.kind = $3
        AND gi.stimulus_group_id IS NOT NULL
        AND NOT (gi.stimulus_group_id = ANY($4::text[]))
      GROUP BY gi.stimulus_group_id
     HAVING COUNT(*) >= 2
        AND COUNT(*) FILTER (WHERE gi.status <> 'approved') = 0
        ${audioReadyHaving}
      ORDER BY random()
      LIMIT 1`,
    [section, level, kindValue, [...excludeGroupIds]],
  );
  const groupId = groupRows[0]?.group_id;
  if (groupId === undefined) return null;

  if (section === 'reading') {
    const { rows } = await exec<StimulusGroupQuestionRow>(
      `SELECT stimulus_group_ordinal, stem, choices, answer_index, explain, passage
         FROM generated_items
        WHERE stimulus_group_id = $1
        ORDER BY stimulus_group_ordinal ASC`,
      [groupId],
    );
    const first = rows[0];
    if (first === undefined) return null;
    const questions = rows.map((r) => mapStimulusGroupQuestion(r));
    return {
      groupId,
      section: 'reading',
      level,
      ...(first.passage !== null ? { passage: first.passage } : {}),
      questions,
    };
  }

  // section === 'listening' — NEVER select `turns` here (see
  // pickGeneratedStimulusGroup's doc — identical NO-LEAK reasoning).
  const { rows } = await exec<StimulusGroupQuestionRow>(
    `SELECT gi.stimulus_group_ordinal, gi.stem, gi.choices, gi.answer_index, gi.explain,
            gi.passage, at.id AS track_id, gi.audio_start_ms, gi.audio_end_ms
       FROM generated_items gi
       LEFT JOIN audio_tracks at ON at.source_id = gi.audio_source_id
      WHERE gi.stimulus_group_id = $1
      ORDER BY gi.stimulus_group_ordinal ASC`,
    [groupId],
  );
  const first = rows[0];
  if (first === undefined) return null;
  const questions = rows.map((r) => mapStimulusGroupQuestion(r));
  return {
    groupId,
    section: 'listening',
    level,
    audioUrl: `/audio/tracks/${String(first.track_id!)}/stream`,
    audioStartMs: first.audio_start_ms!,
    audioEndMs: first.audio_end_ms!,
    questions,
  };
}
