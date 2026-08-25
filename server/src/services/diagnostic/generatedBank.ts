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

/** This slice's bank only ever holds vocab/grammar rows (the CLI writes no
 *  other section yet), even though the table's `section` CHECK admits the
 *  full forward-compat set. Narrower than the table schema on purpose. */
export type GeneratedBankSection = 'vocab' | 'grammar';

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
  readonly choices: ReadonlyArray<{ readonly kr: string; readonly en?: string }>;
  readonly answer_index: number;
  readonly explain: string | null;
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
 * path enforces (routes/diagnostic.ts `buildGeneratedItem`: grammar items
 * are kind 'pattern', vocab items are anything else) as a WHERE clause —
 * defense-in-depth so a future stray row (e.g. a hand-inserted admin fix)
 * can never surface through the draw path even if it slipped past the
 * ingest CLI's own guard.
 *
 * `exec` is injectable (defaults to the shared pool's `query`) so tests can
 * run against a per-test database without touching module-level pool state.
 *
 * Returns null when no approved row matches the cell — the caller's cue to
 * fall through to live generation.
 */
export async function pickGeneratedItem(
  section: GeneratedBankSection,
  level: DiagnosticTargetLevel,
  exec: Querier = query,
): Promise<GeneratedBankItem | null> {
  const kindOp = section === 'grammar' ? '=' : '<>';
  const { rows } = await exec<GeneratedItemRow>(
    `SELECT id, kind, level, stem, choices, answer_index, explain
       FROM generated_items
      WHERE section = $1
        AND level = $2
        AND status = 'approved'
        AND kind ${kindOp} $3
      ORDER BY random()
      LIMIT 1`,
    [section, level, 'pattern'],
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

  return {
    id: row.id,
    kind: row.kind,
    level: row.level as DiagnosticTargetLevel,
    prompt: row.stem,
    choices,
    correctAnswer,
    explain: row.explain ?? '',
    sourceRef: `bank:${String(row.id)}`,
  };
}
