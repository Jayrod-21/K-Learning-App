/**
 * F-220 P3 — the generated MOCK-EXAM surface's blueprint config + assembler.
 *
 * Assembles approved `generated_items` (P1 paired-stimulus groups + P2
 * single-item types + the P0 base passage-mc/audio-mc) into an
 * AUTHENTIC-SHAPED TOPIK section, following the real exam's type-block ORDER
 * (`TOPIK_STRUCTURE_ANALYSIS.md` §3/§6: every real section is a sequence of
 * contiguous type-blocks, easy-atomized-front-half → paired-stimulus-
 * back-half, not an interleaved shuffle). Behind the caller's
 * `TOPIK_MOCK_USE_GENERATED_BANK` flag (routes/topik.ts) — this module itself
 * has no flag awareness, it is only ever imported into a live request path
 * when the flag is on.
 *
 * COPYRIGHT: this assembles our OWN already-generated, original items
 * (`generated_items`, migration 101/103/105). The composition below — which
 * TYPE occupies which position, and roughly how many items per type-block —
 * mirrors the real exam's ABSTRACT structure only (a fixed, closed-set
 * directive template family per TOPIK_STRUCTURE_ANALYSIS.md §2: "Choose the
 * option matching the content" etc. are standard TOPIK testing
 * infrastructure, not creative prose); no real exam passage/question/choice
 * text is stored, drawn, or reproduced anywhere in this file.
 *
 * THIN-BANK POSTURE: every draw here can legitimately return nothing (the
 * generated bank is populated incrementally by an operator-run CLI, not
 * built out all at once). A slot the bank can't fill is simply SKIPPED —
 * `assembleGeneratedMock` never throws for a thin bank; it returns however
 * many items it could actually assemble, in blueprint order, and the caller
 * reports the real count (never pads/fabricates to a target).
 */
import { query, type Querier } from '../../db/pool.js';
import type { DiagnosticTargetLevel } from '../claude/index.js';
import {
  pickGeneratedItemOfKind,
  pickGeneratedStimulusGroupExcludingGroups,
  type GeneratedBankItem,
  type GeneratedBankSection,
  type StimulusGroupDraw,
} from '../diagnostic/generatedBank.js';

/** The generated-mock composition tier — pools `generated_items.level`
 *  differently per RECON_mock_exams.md's locked design (mirrors the real
 *  mock's `paperForBand`-style tier split): tier I is the L1/L2 beginner
 *  pool, tier II is L3/L4/L5+. Deliberately 'I'/'II', not the real mock's
 *  `'TOPIK I'|'TOPIK II'` string, so the two surfaces (and their attempt
 *  tables) can never be confused at a glance — see migration 107's header. */
export type GeneratedMockTier = 'I' | 'II';

/** The two MCQ sections the generated mock supports — mirrors the real
 *  mock's `MockSection` (writing is out of scope on both surfaces). */
export type GeneratedMockSection = 'reading' | 'listening';

const TIER_LEVEL_POOL: Readonly<Record<GeneratedMockTier, readonly DiagnosticTargetLevel[]>> = {
  I: ['L1', 'L2'],
  II: ['L3', 'L4', 'L5+'],
};

// ---------------------------------------------------------------------------
// Blueprint — the type-block sequence per tier x section.
//
// Encodes TOPIK_STRUCTURE_ANALYSIS.md §6's recommended blueprint, ADAPTED to
// the kind values the P2 generators actually write (§5/§6's gap table): every
// `kind` slot below names an EXACT `generated_items.kind` string that some
// live generator produces under section='reading'|'listening' (P0's
// passage-mc/audio-mc, or one of P2's 9 reading / 4 listening prompt-shape
// variants — see generate-item-bank.ts). Two real-taxonomy types have NO
// generator at all and are deliberately OMITTED rather than wired to a slot
// that could never fill (R2 synonym-in-context — the closest generator,
// `synonym`, writes under section='vocab', a different pool; R13
// infer-the-purpose; L1 choose-matching-picture — needs image generation,
// lowest priority per §4.3): a slot for a kind nothing ever writes would just
// silently contribute zero items every time, which is strictly worse than
// not declaring it.
//
// Each slot is either:
//   - a single-item KIND block: draw `count` DISTINCT approved items of that
//     exact kind (a repeated kind, e.g. 'audio-mc' used for multiple
//     single-clip TOPIK II listening families that share one generator, is
//     legal — `excludeIds` across the whole assembly keeps every draw
//     within one exam distinct);
//   - a PAIRED block: draw complete stimulus groups (2-3 linked questions
//     each, sharing one generated passage/audio clip — P1) until
//     `targetItems` QUESTIONS are assembled or the bank has no more eligible
//     groups at ANY level in the tier's pool.
//
// Item counts are hand-tuned to land close to the real section sizes
// (TOPIK_STRUCTURE_ANALYSIS.md §3's confirmed `topik_tests.total_questions`)
// while keeping the paired-stimulus block's share close to the real exam's
// (TOPIK II: ~40%/~60% of reading/listening; TOPIK I: ~55%/~20-43% — see §1's
// per-family "rough share" column and §3's TOPIK I closing note). These are a
// deliberate, DOCUMENTED approximation, not a literal item-number transcript
// of any real paper (which would risk reproducing real composition alongside
// content — the design intentionally mirrors structure, not a specific
// paper).
// ---------------------------------------------------------------------------

/** One position in a tier x section blueprint. */
export type MockBlueprintSlot =
  | { readonly kind: string; readonly count: number }
  | { readonly paired: true; readonly targetItems: number };

type SectionBlueprint = Readonly<Record<GeneratedMockSection, readonly MockBlueprintSlot[]>>;

export const MOCK_BLUEPRINT: Readonly<Record<GeneratedMockTier, SectionBlueprint>> = {
  II: {
    // TOPIK II reading order (§3): fill-blank -> match-content -> sentence-
    // order -> paragraph-cloze -> headline-interpret -> paragraph-cloze
    // (2nd block) -> match-content (medium) -> main-idea -> sentence-insert
    // -> paired-passage-mc (closes the section, ~40% of items). Totals 50.
    reading: [
      { kind: 'fill-blank', count: 2 },
      { kind: 'match-content', count: 4 },
      { kind: 'sentence-order', count: 3 },
      { kind: 'paragraph-cloze', count: 4 },
      { kind: 'headline-interpret', count: 3 },
      { kind: 'paragraph-cloze', count: 4 },
      { kind: 'match-content', count: 3 },
      { kind: 'main-idea', count: 4 },
      { kind: 'sentence-insert', count: 3 },
      { paired: true, targetItems: 20 },
    ],
    // TOPIK II listening order (§3): whats-next -> audio-mc (next-action) ->
    // audio-mc (content-match) -> audio-mc (main-point) -> paired-audio-mc
    // (closes the section, ~60% of items, the single largest family). Totals
    // 50. L1 (matching-picture) intentionally omitted (§4.3 — image
    // generation, lowest priority).
    listening: [
      { kind: 'whats-next', count: 5 },
      { kind: 'audio-mc', count: 5 },
      { kind: 'audio-mc', count: 5 },
      { kind: 'audio-mc', count: 5 },
      { paired: true, targetItems: 30 },
    ],
  },
  I: {
    // TOPIK I reading order (§3, compressed): topic-id -> paragraph-cloze
    // (the worked-example fill-blank block, §1's R6 row covers TOPIK I 34-39)
    // -> choose-non-match -> match-content -> main-idea -> sentence-order/
    // sentence-insert (folded singles) -> paired-passage-mc (closes the
    // section; §3 notes TOPIK I's paired-passage family is proportionally
    // LARGER than TOPIK II's — 22/40 = 55% here). Totals 40.
    reading: [
      { kind: 'topic-id', count: 3 },
      { kind: 'paragraph-cloze', count: 4 },
      { kind: 'choose-non-match', count: 3 },
      { kind: 'match-content', count: 3 },
      { kind: 'main-idea', count: 3 },
      { kind: 'sentence-order', count: 1 },
      { kind: 'sentence-insert', count: 1 },
      { paired: true, targetItems: 22 },
    ],
    // TOPIK I listening order (§3): dialogue-complete (response) ->
    // whats-next -> infer-location -> infer-topic -> audio-mc (content-match)
    // -> paired-audio-mc (closes the section). Totals 30.
    listening: [
      { kind: 'dialogue-complete', count: 4 },
      { kind: 'whats-next', count: 4 },
      { kind: 'infer-location', count: 4 },
      { kind: 'infer-topic', count: 4 },
      { kind: 'audio-mc', count: 4 },
      { paired: true, targetItems: 10 },
    ],
  },
};

/** Allotted minutes per section — mirrors the real mock's client-side
 *  `SECTION_MINUTES` (MockMode.tsx): Reading 70min, Listening 60min, the same
 *  convention regardless of tier or whether the section is real or
 *  generated. The route uses this to seed a freshly-assembled attempt's
 *  `remaining_ms`. */
export const GENERATED_MOCK_SECTION_MINUTES: Readonly<Record<GeneratedMockSection, number>> = {
  reading: 70,
  listening: 60,
};

function blueprintTotalItems(slots: readonly MockBlueprintSlot[]): number {
  return slots.reduce((sum, s) => sum + ('kind' in s ? s.count : s.targetItems), 0);
}

/**
 * The level a slot draws from, per the tier's difficulty ramp: earlier slots
 * (front-half, easier real-exam positions) draw the tier pool's LOWER
 * levels; later slots (back-half, the paired-stimulus block especially) draw
 * the HIGHER levels — mirrors TOPIK_STRUCTURE_ANALYSIS.md §3's "difficulty
 * ramp correlated with item-number position" finding. `cumulativeBefore` is
 * the item count already placed ahead of this slot; `total` is the
 * blueprint's full target count.
 */
function levelForSlot(
  pool: readonly DiagnosticTargetLevel[],
  cumulativeBefore: number,
  total: number,
): DiagnosticTargetLevel {
  const frac = total > 0 ? cumulativeBefore / total : 0;
  const idx = Math.min(pool.length - 1, Math.floor(frac * pool.length));
  return pool[idx] ?? pool[0]!;
}

/** `pool` reordered to start at `preferred`, then wrap through the rest —
 *  so a draw tries the ramp-assigned level FIRST, then gracefully falls back
 *  across the tier's other levels rather than giving up (thin-bank
 *  tolerance: a bank that's well-stocked at L4 but empty at L3 should still
 *  fill an L3-ramped slot from L4 rather than skip it outright). */
function levelsFrom(
  pool: readonly DiagnosticTargetLevel[],
  preferred: DiagnosticTargetLevel,
): readonly DiagnosticTargetLevel[] {
  const startIdx = pool.indexOf(preferred);
  if (startIdx <= 0) return pool;
  return [...pool.slice(startIdx), ...pool.slice(0, startIdx)];
}

// ---------------------------------------------------------------------------
// Snapshot item shape — the ordered array persisted into
// generated_mock_attempts.item_set (migration 107). Every listening question
// (single or from a group) carries `audioUrl`/`audioStartMs`/`audioEndMs`,
// NEVER a transcript field — the underlying draws (pickGeneratedItemOfKind /
// pickGeneratedStimulusGroupExcludingGroups) are structurally incapable of
// returning the dialogue text (see generatedBank.ts's NO-LEAK docs), so
// there is no field here a caller could even mistakenly populate with it.
// ---------------------------------------------------------------------------

export type MockChoiceId = 'a' | 'b' | 'c' | 'd';

export interface SnapshotMockChoice {
  readonly id: MockChoiceId;
  readonly kr: string;
  readonly en: string;
}

/** One item in the assembled, ordered snapshot. `correctChoiceId` +
 *  `explanation` are SERVER-ONLY — see `toClientMockItem` for the type-level
 *  strip that produces the wire DTO. */
export interface SnapshotMockItem {
  /** Synthetic, snapshot-scoped id — `single:<generated_items.id>` for a
   *  standalone draw, `group:<stimulus_group_id>:<1-based ordinal>` for a
   *  paired-stimulus question (which has no single generated_items row id of
   *  its own once flattened — see StimulusGroupDraw). Unique WITHIN one
   *  item_set (excludeIds/excludeGroupIds during assembly guarantee no two
   *  slots draw the same row/group), used to key `picks` and to grade. */
  readonly id: string;
  readonly kind: string;
  readonly prompt: string;
  readonly passage?: string;
  readonly audioUrl?: string;
  readonly audioStartMs?: number;
  readonly audioEndMs?: number;
  readonly choices: readonly SnapshotMockChoice[];
  readonly correctChoiceId: MockChoiceId;
  readonly explanation: string;
}

function toSnapshotSingle(item: GeneratedBankItem): SnapshotMockItem {
  return {
    id: `single:${String(item.id)}`,
    kind: item.kind,
    prompt: item.prompt,
    ...(item.passage !== undefined ? { passage: item.passage } : {}),
    ...(item.audioUrl !== undefined ? { audioUrl: item.audioUrl } : {}),
    ...(item.audioStartMs !== undefined ? { audioStartMs: item.audioStartMs } : {}),
    ...(item.audioEndMs !== undefined ? { audioEndMs: item.audioEndMs } : {}),
    choices: item.choices,
    correctChoiceId: item.correctAnswer,
    explanation: item.explain,
  };
}

/** Flatten a drawn stimulus group into its N ordered snapshot questions —
 *  every question denormalizes the group's ONE shared passage/audio window
 *  onto itself (mirrors how a real TOPIK mock item already carries its own
 *  resolved `passage` — B-008 — so the client-facing shape needs no
 *  group-awareness at all, exactly like the real mock's flat item array). */
function toSnapshotGroup(group: StimulusGroupDraw): SnapshotMockItem[] {
  return group.questions.map((q, i) => ({
    id: `group:${group.groupId}:${String(i + 1)}`,
    kind: group.section === 'reading' ? 'paired-passage-mc' : 'paired-audio-mc',
    prompt: q.prompt,
    ...(group.passage !== undefined ? { passage: group.passage } : {}),
    ...(group.audioUrl !== undefined ? { audioUrl: group.audioUrl } : {}),
    ...(group.audioStartMs !== undefined ? { audioStartMs: group.audioStartMs } : {}),
    ...(group.audioEndMs !== undefined ? { audioEndMs: group.audioEndMs } : {}),
    choices: q.choices,
    correctChoiceId: q.correctAnswer,
    explanation: q.explain,
  }));
}

/** The generated-bank section a draw reads from — mock only ever assembles
 *  'reading'/'listening' (writing is out of scope on both mock surfaces). */
function bankSectionOf(section: GeneratedMockSection): GeneratedBankSection {
  return section;
}

export interface AssembleGeneratedMockResult {
  /** The ordered, assembled snapshot — WITH server-side answers. May be
   *  SHORTER than the blueprint's target when the bank is thin at some
   *  slots; never longer, never crashes on an empty bank (returns `[]`). */
  readonly items: readonly SnapshotMockItem[];
  /** Sum of every blueprint slot's target count — for reporting "served X of
   *  Y requested" without the caller needing to re-derive the blueprint. */
  readonly requestedCount: number;
}

/**
 * Assemble one generated mock section for `(tier, section)`, following the
 * blueprint's type-block ORDER. Draws single items via `pickGeneratedItemOfKind`
 * and paired-stimulus blocks via `pickGeneratedStimulusGroupExcludingGroups`,
 * tracking every drawn item id / group id so no row or group is ever served
 * twice within one assembly.
 *
 * THIN-BANK GRACEFUL DEGRADATION: a slot that cannot be filled (kind
 * unfunded/exhausted at every level in the tier's pool) is simply skipped —
 * this function NEVER throws for a thin bank; it always returns whatever it
 * could assemble, in blueprint order, real (not padded) counts.
 *
 * `exec` is injectable (defaults to the shared pool's `query`) so tests can
 * run against a per-test database without touching module-level pool state.
 */
export async function assembleGeneratedMock(
  tier: GeneratedMockTier,
  section: GeneratedMockSection,
  exec: Querier = query,
): Promise<AssembleGeneratedMockResult> {
  const blueprint = MOCK_BLUEPRINT[tier][section];
  const pool = TIER_LEVEL_POOL[tier];
  const total = blueprintTotalItems(blueprint);
  const bankSection = bankSectionOf(section);

  const items: SnapshotMockItem[] = [];
  const usedItemIds = new Set<number>();
  const usedGroupIds = new Set<string>();
  let cumulative = 0;

  for (const slot of blueprint) {
    if ('kind' in slot) {
      const rampLevel = levelForSlot(pool, cumulative, total);
      for (let i = 0; i < slot.count; i += 1) {
        let drawn: GeneratedBankItem | null = null;
        for (const tryLevel of levelsFrom(pool, rampLevel)) {
          drawn = await pickGeneratedItemOfKind(
            bankSection,
            tryLevel,
            slot.kind,
            [...usedItemIds],
            exec,
          );
          if (drawn !== null) break;
        }
        if (drawn === null) continue; // thin bank — skip this unit, never throw.
        usedItemIds.add(drawn.id);
        items.push(toSnapshotSingle(drawn));
      }
      cumulative += slot.count;
    } else {
      const rampLevel = levelForSlot(pool, cumulative, total);
      let filled = 0;
      while (filled < slot.targetItems) {
        let group: StimulusGroupDraw | null = null;
        for (const tryLevel of levelsFrom(pool, rampLevel)) {
          group = await pickGeneratedStimulusGroupExcludingGroups(
            section,
            tryLevel,
            [...usedGroupIds],
            exec,
          );
          if (group !== null) break;
        }
        if (group === null) break; // bank exhausted at every level — stop, never crash.
        usedGroupIds.add(group.groupId);
        const snapshotQs = toSnapshotGroup(group);
        items.push(...snapshotQs);
        filled += snapshotQs.length;
      }
      cumulative += slot.targetItems;
    }
  }

  return { items, requestedCount: total };
}

// ---------------------------------------------------------------------------
// Client-safe DTO — the answer-strip (FU-NF-39's diagnostic pattern, mirrors
// routes/topik.ts's `toMockItemDTO`). TYPE-LEVEL, not a runtime delete: the
// return type Omits `correctChoiceId`/`explanation`, so a regression that
// tried to copy them onto the wire item would fail to compile.
// ---------------------------------------------------------------------------

export type GeneratedMockClientItem = Omit<SnapshotMockItem, 'correctChoiceId' | 'explanation'>;

export function toClientMockItem(item: SnapshotMockItem): GeneratedMockClientItem {
  return {
    id: item.id,
    kind: item.kind,
    prompt: item.prompt,
    ...(item.passage !== undefined ? { passage: item.passage } : {}),
    ...(item.audioUrl !== undefined ? { audioUrl: item.audioUrl } : {}),
    ...(item.audioStartMs !== undefined ? { audioStartMs: item.audioStartMs } : {}),
    ...(item.audioEndMs !== undefined ? { audioEndMs: item.audioEndMs } : {}),
    choices: item.choices,
  };
}
