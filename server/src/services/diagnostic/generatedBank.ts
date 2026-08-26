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
