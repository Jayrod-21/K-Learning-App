/**
 * Integration tests for the F-220 slice 1 item-bank CLI
 * (src/scripts/generate-item-bank.ts).
 *
 * Real Postgres via testcontainers (full migration chain, including
 * migration 101's `generated_items` and 006's `canonical_grammar`), driving
 * the exported seams (`parseCliArgs`, `runCount`, `runEmitBatch`,
 * `runIngest`, the seed pickers) directly — no child process. Nothing here
 * ever constructs a Claude proxy; test #1 pins that structurally.
 *
 * Coverage:
 *   - THE $0 GUARANTEE: the module source never references a live Claude
 *     proxy call.
 *   - parseCliArgs: count is the default; --emit-batch/--ingest input
 *     validation; conflicting modes / unknown flags / out-of-context flags
 *     all throw ItemBankInputError (exit 2).
 *   - COPYRIGHT: grammar seeds come from canonical_grammar.canonical_pattern
 *     ONLY — a kgiu_entries.explanation marker string never reaches the
 *     built request, and grammar seeds never carry seedEnglish.
 *   - count: enumerates the grid, zero writes.
 *   - emit-batch: well-formed work-order, correct (independently
 *     re-verifiable) prompt_hashes, zero DB writes, --section/--level/
 *     --per-cell filters respected.
 *   - ingest: writes status='draft' rows with the section<->kind contract
 *     and shuffle-consistent answer mapping enforced; rejects a bad response
 *     (wrong arity / mismatched kind) without writing; is idempotent
 *     (re-ingest = 0 new rows); rejects hash drift; an unfilled or wholly-
 *     invalid work-order is non-zero (never looks green).
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { setTestEnv } from '../services/claude/setup.js';
import { seedVocabEntry, seedKgiuEntry } from '../helpers/seed.js';
import { loadConfig } from '../../src/services/claude/config.js';
import type {
  DiagnosticItemResult,
  DiagnosticReadingItemResult,
  DiagnosticListeningItemResult,
  DiagnosticPairedReadingItemResult,
  DiagnosticPairedListeningItemResult,
} from '../../src/services/claude/models.js';
import {
  DEFAULT_PER_CELL,
  ItemBankInputError,
  LEVELS,
  SECTIONS,
  buildListeningWorkOrderRequest,
  buildPairedListeningWorkOrderRequest,
  buildPairedReadingWorkOrderRequest,
  buildReadingWorkOrderRequest,
  buildWorkOrderRequest,
  countGrammarPatternSeeds,
  countVocabSeeds,
  exitCodeFor,
  pairedReadingQuestionCountFor,
  parseCliArgs,
  pickGrammarPatternSeeds,
  pickVocabSeeds,
  rowPromptHash,
  runCount,
  runEmitBatch,
  runIngest,
  stimulusGroupIdFromHash,
  type ItemBankOptions,
  type WorkOrderFile,
  type WorkOrderItem,
} from '../../src/scripts/generate-item-bank.js';
import { READING_TOPICS, pickReadingTopics } from '../../src/scripts/readingTopics.js';

let pg: PgHandle;

beforeAll(async () => {
  pg = await startPostgres();
  setTestEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
});

afterAll(async () => {
  await stopPostgres(pg);
});

beforeEach(async () => {
  await pg.pool.query(`DELETE FROM generated_items`);
  await pg.pool.query(`DELETE FROM vocab_entries`);
  await pg.pool.query(`DELETE FROM kgiu_entries`);
  await pg.pool.query(`DELETE FROM canonical_grammar`);
});

const silent = (): void => undefined;

async function makeTmpFile(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'item-bank-test-'));
  return path.join(dir, name);
}

/** Seed a canonical_grammar row + a linked kgiu_entries row. `explanation`
 *  (when passed) plants a distinctive DARAKWON-shaped marker string on the
 *  kgiu_entries row — the COPYRIGHT tests assert it never reaches a built
 *  request. */
async function seedGrammarCell(
  pool: Pool,
  opts: {
    pattern: string;
    proficiency: 'basic' | 'L3' | 'L4' | 'L5+';
    explanation?: string;
    titleEn?: string;
  },
): Promise<{ canonicalGrammarId: number; kgiuId: number }> {
  const kgiuId = await seedKgiuEntry(pool, { pattern: opts.pattern, proficiency: opts.proficiency });
  if (opts.explanation !== undefined || opts.titleEn !== undefined) {
    await pool.query(`UPDATE kgiu_entries SET explanation = $1, title_en = $2 WHERE id = $3`, [
      opts.explanation ?? null,
      opts.titleEn ?? 'mock title',
      kgiuId,
    ]);
  }
  const cg = await pool.query<{ id: string }>(
    `INSERT INTO canonical_grammar (pattern_key, canonical_pattern) VALUES ($1, $2) RETURNING id`,
    [opts.pattern, opts.pattern],
  );
  const canonicalGrammarId = Number(cg.rows[0]!.id);
  await pool.query(`UPDATE kgiu_entries SET canonical_grammar_id = $1 WHERE id = $2`, [
    canonicalGrammarId,
    kgiuId,
  ]);
  return { canonicalGrammarId, kgiuId };
}

function makeOpts(overrides: Partial<ItemBankOptions> = {}): ItemBankOptions {
  return {
    mode: 'count',
    sections: SECTIONS,
    levels: LEVELS,
    perCell: DEFAULT_PER_CELL,
    outFile: undefined,
    inFile: undefined,
    ...overrides,
  };
}

async function generatedItemCount(): Promise<number> {
  const res = await pg.pool.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM generated_items');
  return Number(res.rows[0]!.n);
}

/** A schema-valid DiagnosticItemResult for a given section. */
function goodResponse(section: 'vocab' | 'grammar', correctKr = '정답'): DiagnosticItemResult {
  return {
    kind: section === 'grammar' ? 'pattern' : 'synonym',
    prompt: `mock ${section} prompt`,
    choices: [
      { kr: correctKr, en: 'correct' },
      { kr: '오답1', en: '' },
      { kr: '오답2', en: '' },
      { kr: '오답3', en: '' },
    ],
    answerIndex: 0,
    explain: 'mock explanation',
  };
}

/** A schema-valid DiagnosticReadingItemResult (F-220 slice 2). */
function goodReadingResponse(passage = '오늘은 날씨가 좋습니다.', correctKr = '정답'): DiagnosticReadingItemResult {
  return {
    passage,
    prompt: 'mock reading comprehension question',
    choices: [
      { kr: correctKr, en: 'correct' },
      { kr: '오답1', en: '' },
      { kr: '오답2', en: '' },
      { kr: '오답3', en: '' },
    ],
    answerIndex: 0,
    explain: 'mock explanation',
  };
}

/** A schema-valid DiagnosticListeningItemResult (F-220 slice 3). */
function goodListeningResponse(correctKr = '정답'): DiagnosticListeningItemResult {
  return {
    turns: [
      { speaker: 'narrator', gender: 'narrator', text: '두 사람이 이야기합니다.' },
      { speaker: '민수', gender: 'male', text: '오늘 날씨가 좋네요.' },
      { speaker: '지은', gender: 'female', text: '네, 정말 좋아요.' },
    ],
    prompt: 'mock listening comprehension question',
    choices: [
      { kr: correctKr, en: 'correct' },
      { kr: '오답1', en: '' },
      { kr: '오답2', en: '' },
      { kr: '오답3', en: '' },
    ],
    answerIndex: 0,
    explain: 'mock explanation',
  };
}

/** A schema-valid DiagnosticPairedReadingItemResult (F-220 P1) — `n` questions,
 *  each independent, each a distinct correctKr by default so a test can tell
 *  rows apart. */
function goodPairedReadingResponse(
  n: 2 | 3 = 2,
  passage = '오늘은 날씨가 맑고 따뜻합니다. 사람들이 공원에서 산책을 합니다. 어떤 사람들은 자전거를 탑니다.',
): DiagnosticPairedReadingItemResult {
  return {
    passage,
    questions: Array.from({ length: n }, (_, i) => ({
      prompt: `mock paired reading question ${String(i + 1)}`,
      choices: [
        { kr: `정답-${String(i)}`, en: 'correct' },
        { kr: '오답1', en: '' },
        { kr: '오답2', en: '' },
        { kr: '오답3', en: '' },
      ],
      answerIndex: 0,
      explain: `mock explanation ${String(i + 1)}`,
    })),
  };
}

/** A schema-valid DiagnosticPairedListeningItemResult (F-220 P1) — always
 *  exactly 2 questions (the schema's literal questionCount). */
function goodPairedListeningResponse(): DiagnosticPairedListeningItemResult {
  return {
    turns: [
      { speaker: 'narrator', gender: 'narrator', text: '두 친구가 카페에서 이야기합니다.' },
      { speaker: '민수', gender: 'male', text: '오늘 날씨가 참 좋네요.' },
      { speaker: '지은', gender: 'female', text: '네, 산책하기 좋은 날씨예요.' },
    ],
    questions: [
      {
        prompt: 'mock paired listening question 1',
        choices: [
          { kr: '정답-0', en: 'correct' },
          { kr: '오답1', en: '' },
          { kr: '오답2', en: '' },
          { kr: '오답3', en: '' },
        ],
        answerIndex: 0,
        explain: 'mock explanation 1',
      },
      {
        prompt: 'mock paired listening question 2',
        choices: [
          { kr: '정답-1', en: 'correct' },
          { kr: '오답1', en: '' },
          { kr: '오답2', en: '' },
          { kr: '오답3', en: '' },
        ],
        answerIndex: 0,
        explain: 'mock explanation 2',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. THE $0 GUARANTEE
// ---------------------------------------------------------------------------

describe('the $0 guarantee', () => {
  it('the CLI source never references a live Claude proxy call', async () => {
    const src = await readFile(
      path.join(process.cwd(), 'src/scripts/generate-item-bank.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/createClaudeProxy/);
    expect(src).not.toMatch(/getClaudeProxy/);
    expect(src).not.toMatch(/\.generateDiagnosticItem\(/);
    // F-220 slice 2: the reading branch must be equally $0 — never a live call.
    expect(src).not.toMatch(/\.generateDiagnosticReadingItem\(/);
    // F-220 slice 3: the listening SCRIPT branch is equally $0 — never a
    // live call, and this file must never IMPORT the SEPARATE, metered
    // audio-synth CLI (that tool's own $0-in-tests posture is proven in its
    // own test file — a comment naming that file, e.g. this header's own
    // docs, is fine; an `import ... from '.../synthesize-listening-audio'`
    // is not).
    expect(src).not.toMatch(/\.generateDiagnosticListeningItem\(/);
    expect(src).not.toMatch(/from ['"].*synthesize-listening-audio/);
  });
});

// ---------------------------------------------------------------------------
// 2. parseCliArgs
// ---------------------------------------------------------------------------

describe('parseCliArgs', () => {
  it('defaults to count mode with the full grid and DEFAULT_PER_CELL', () => {
    const opts = parseCliArgs([]);
    expect(opts.mode).toBe('count');
    expect(opts.sections).toEqual(SECTIONS);
    expect(opts.levels).toEqual(LEVELS);
    expect(opts.perCell).toBe(DEFAULT_PER_CELL);
  });

  it('--dry-run is an alias for --count', () => {
    expect(parseCliArgs(['--dry-run']).mode).toBe('count');
  });

  it('--section/--level/--per-cell narrow the grid', () => {
    const opts = parseCliArgs(['--section=grammar', '--level=L4', '--per-cell=7']);
    expect(opts.sections).toEqual(['grammar']);
    expect(opts.levels).toEqual(['L4']);
    expect(opts.perCell).toBe(7);
  });

  it('--emit-batch requires --out', () => {
    expect(() => parseCliArgs(['--emit-batch'])).toThrow(ItemBankInputError);
  });

  it('--emit-batch --out=<file> parses cleanly', () => {
    const opts = parseCliArgs(['--emit-batch', '--out=/tmp/x.json']);
    expect(opts.mode).toBe('emit-batch');
    expect(opts.outFile).toBe('/tmp/x.json');
  });

  it('--out only applies to --emit-batch', () => {
    expect(() => parseCliArgs(['--out=/tmp/x.json'])).toThrow(ItemBankInputError);
  });

  it('--ingest requires --in (or --ingest=<file>)', () => {
    expect(() => parseCliArgs(['--ingest'])).toThrow(ItemBankInputError);
    const opts = parseCliArgs(['--ingest=/tmp/x.json']);
    expect(opts.mode).toBe('ingest');
    expect(opts.inFile).toBe('/tmp/x.json');
  });

  it('--section/--level/--per-cell do not apply to --ingest', () => {
    expect(() => parseCliArgs(['--ingest=/tmp/x.json', '--section=vocab'])).toThrow(
      ItemBankInputError,
    );
  });

  it('conflicting modes throw', () => {
    expect(() => parseCliArgs(['--count', '--emit-batch', '--out=/tmp/x.json'])).toThrow(
      ItemBankInputError,
    );
  });

  it('unknown flags / unknown section / unknown level throw', () => {
    expect(() => parseCliArgs(['--bogus'])).toThrow(ItemBankInputError);
    // 'listening' is now valid (F-220 slice 3) — a genuinely bogus section
    // value proves the guard still works.
    expect(() => parseCliArgs(['--section=writing'])).toThrow(ItemBankInputError);
    expect(() => parseCliArgs(['--level=L9'])).toThrow(ItemBankInputError);
  });

  it('--section=reading is now valid (F-220 slice 2)', () => {
    const opts = parseCliArgs(['--section=reading']);
    expect(opts.sections).toEqual(['reading']);
  });

  it('exitCodeFor maps ItemBankInputError to 2, anything else to 1', () => {
    expect(exitCodeFor(new ItemBankInputError('x'))).toBe(2);
    expect(exitCodeFor(new Error('x'))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Copyright-clean seed enumeration
// ---------------------------------------------------------------------------

describe('copyright-clean seed enumeration', () => {
  it('pickVocabSeeds includes the copyright-safe english gloss', async () => {
    await seedVocabEntry(pg.pool, { proficiency: 'L3', korean: '사과', english: 'apple' });
    const seeds = await pickVocabSeeds(pg.pool, 'L3', 5);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.seedKorean).toBe('사과');
    expect(seeds[0]!.seedEnglish).toBe('apple');
  });

  it('pickVocabSeeds tops up from the whole pool when the targeted band is short', async () => {
    await seedVocabEntry(pg.pool, { proficiency: 'L3', korean: '단어1' });
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어2' });
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어3' });
    const seeds = await pickVocabSeeds(pg.pool, 'L3', 3);
    // Only 1 row is L3-tagged; the other 2 come from the fallback pass.
    expect(seeds).toHaveLength(3);
    expect(new Set(seeds.map((s) => s.seedRef)).size).toBe(3); // distinct
  });

  it('pickGrammarPatternSeeds returns ONLY the canonical_grammar pattern — never seedEnglish', async () => {
    const { canonicalGrammarId } = await seedGrammarCell(pg.pool, {
      pattern: '-(으)면',
      proficiency: 'L3',
      explanation: 'DARAKWON-COPYRIGHTED-PROSE-MARKER',
      titleEn: 'DARAKWON-TITLE-MARKER',
    });
    const seeds = await pickGrammarPatternSeeds(pg.pool, 'L3', 5);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.seedRef).toBe(String(canonicalGrammarId));
    expect(seeds[0]!.seedKorean).toBe('-(으)면');
    expect(seeds[0]!.seedEnglish).toBeUndefined();
  });

  it('COPYRIGHT: a kgiu_entries.explanation/title_en marker never reaches the built Claude request', async () => {
    await seedGrammarCell(pg.pool, {
      pattern: '-거든요',
      proficiency: 'L4',
      explanation: 'DARAKWON-COPYRIGHTED-PROSE-MARKER',
      titleEn: 'DARAKWON-TITLE-MARKER',
    });
    const seeds = await pickGrammarPatternSeeds(pg.pool, 'L4', 1);
    expect(seeds).toHaveLength(1);
    const cfg = loadConfig();
    const model = cfg.modelDefaults.diagnostic_item;
    const built = buildWorkOrderRequest('grammar', 'L4', seeds[0]!, model, cfg);
    expect(built).not.toBeNull();
    const serialized = JSON.stringify(built!.request);
    expect(serialized).not.toContain('DARAKWON-COPYRIGHTED-PROSE-MARKER');
    expect(serialized).not.toContain('DARAKWON-TITLE-MARKER');
    expect(serialized).toContain('-거든요'); // the pattern key itself IS sent
  });

  it('countVocabSeeds / countGrammarPatternSeeds report targeted vs total pools', async () => {
    await seedVocabEntry(pg.pool, { proficiency: 'L3', korean: 'a' });
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: 'b' });
    const vocabCount = await countVocabSeeds(pg.pool, 'L3');
    expect(vocabCount).toEqual({ targeted: 1, total: 2 });

    await seedGrammarCell(pg.pool, { pattern: '-p1', proficiency: 'L3' });
    await seedGrammarCell(pg.pool, { pattern: '-p2', proficiency: 'L4' });
    const grammarCount = await countGrammarPatternSeeds(pg.pool, 'L3');
    expect(grammarCount).toEqual({ targeted: 1, total: 2 });
  });
});

// ---------------------------------------------------------------------------
// 4. count
// ---------------------------------------------------------------------------

describe('runCount', () => {
  it('enumerates the grid and writes NOTHING', async () => {
    await seedVocabEntry(pg.pool, { proficiency: 'L3', korean: '단어' });
    await seedGrammarCell(pg.pool, { pattern: '-패턴', proficiency: 'L3' });

    const summary = await runCount(pg.pool, makeOpts({ sections: ['vocab'], levels: ['L3'], perCell: 5 }), silent);
    expect(summary.cells).toHaveLength(1);
    expect(summary.cells[0]!.availability.total).toBe(1);
    expect(summary.cells[0]!.achievable).toBe(1);
    expect(summary.totalAchievable).toBe(1);
    expect(await generatedItemCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. emit-batch
// ---------------------------------------------------------------------------

describe('runEmitBatch', () => {
  it('writes a well-formed work-order with independently-reproducible prompt_hashes; zero DB writes', async () => {
    await seedVocabEntry(pg.pool, { proficiency: 'L3', korean: '단어1', english: 'word1' });
    await seedVocabEntry(pg.pool, { proficiency: 'L3', korean: '단어2', english: 'word2' });
    const outFile = await makeTmpFile('batch.json');

    const summary = await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['vocab'], levels: ['L3'], perCell: 5, outFile }),
      silent,
    );
    expect(summary.emitted).toBe(2);

    const raw = await readFile(outFile, 'utf8');
    const file = JSON.parse(raw) as WorkOrderFile;
    expect(file.items).toHaveLength(2);
    expect(file.meta.emitted).toBe(2);

    const cfg = loadConfig();
    for (const item of file.items) {
      expect(item.section).toBe('vocab');
      expect(item.level).toBe('L3');
      expect(item.schema).toBe('DiagnosticItemResult');
      expect(item.promptHash).toMatch(/^[0-9a-f]{64}$/);
      // Recompute independently from the echoed seed — must match exactly.
      const rebuilt = buildWorkOrderRequest(
        'vocab',
        'L3',
        { seedRef: item.seedRef, seedKorean: item.seedKorean, seedEnglish: item.seedEnglish },
        file.meta.model,
        cfg,
      );
      expect(rebuilt).not.toBeNull();
      expect(rebuilt!.promptHash).toBe(item.promptHash);
    }

    expect(await generatedItemCount()).toBe(0);
  });

  it('--section/--level/--per-cell filter the emitted grid', async () => {
    await seedVocabEntry(pg.pool, { proficiency: 'L3', korean: 'v1' });
    await seedGrammarCell(pg.pool, { pattern: '-g1', proficiency: 'L4' });
    const outFile = await makeTmpFile('batch2.json');

    const summary = await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['grammar'], levels: ['L4'], perCell: 5, outFile }),
      silent,
    );
    expect(summary.emitted).toBe(1);
    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    expect(file.items).toHaveLength(1);
    expect(file.items[0]!.section).toBe('grammar');
    expect(file.items[0]!.level).toBe('L4');
  });

  it('rejects a run with no --out', async () => {
    await expect(runEmitBatch(pg.pool, makeOpts({ mode: 'emit-batch' }), silent)).rejects.toThrow(
      ItemBankInputError,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. ingest
// ---------------------------------------------------------------------------

describe('runIngest', () => {
  async function emitVocabBatch(perCell = 3): Promise<{ outFile: string; file: WorkOrderFile }> {
    await seedVocabEntry(pg.pool, { proficiency: 'L3', korean: '단어1' });
    await seedVocabEntry(pg.pool, { proficiency: 'L3', korean: '단어2' });
    await seedVocabEntry(pg.pool, { proficiency: 'L3', korean: '단어3' });
    const outFile = await makeTmpFile('emit.json');
    await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['vocab'], levels: ['L3'], perCell, outFile }),
      silent,
    );
    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    return { outFile, file };
  }

  async function writeFilled(file: WorkOrderFile, filledItems: WorkOrderItem[]): Promise<string> {
    const path_ = await makeTmpFile('filled.json');
    await writeFile(path_, JSON.stringify({ meta: file.meta, items: filledItems }, null, 2));
    return path_;
  }

  it('writes status=draft rows, section<->kind contract intact, choice/answer mapping consistent', async () => {
    const { file } = await emitVocabBatch(2);
    const filled = file.items.map((item, i) => ({
      ...item,
      response: goodResponse('vocab', `정답-${String(i)}`),
    })) as unknown as WorkOrderItem[];
    const inFile = await writeFilled(file, filled);

    const summary = await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent);
    expect(summary.written).toBe(2);
    expect(summary.skippedInvalid).toBe(0);
    expect(summary.skippedHashDrift).toBe(0);

    const rows = await pg.pool.query<{
      status: string;
      created_by: string;
      section: string;
      level: string;
      kind: string;
      choices: Array<{ kr: string; en: string }>;
      answer_index: number;
      prompt_hash: string;
    }>(`SELECT status, created_by, section, level, kind, choices, answer_index, prompt_hash
          FROM generated_items ORDER BY id`);
    expect(rows.rows).toHaveLength(2);
    for (const [i, row] of rows.rows.entries()) {
      expect(row.status).toBe('draft');
      expect(row.created_by).toBe('claude-batch');
      expect(row.section).toBe('vocab');
      expect(row.level).toBe('L3');
      expect(row.kind).toBe('synonym');
      expect(row.choices).toHaveLength(4);
      // Shuffle-consistency: whichever position the correct choice landed at,
      // that position's text is the ORIGINAL correct choice's text.
      expect(row.choices[row.answer_index]!.kr).toBe(`정답-${String(i)}`);
      expect(row.prompt_hash).toBe(file.items[i]!.promptHash);
    }
  });

  it('is idempotent: re-ingesting the same filled file writes 0 new rows', async () => {
    const { file } = await emitVocabBatch(2);
    const filled = file.items.map((item) => ({
      ...item,
      response: goodResponse('vocab'),
    })) as unknown as WorkOrderItem[];
    const inFile = await writeFilled(file, filled);

    const first = await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent);
    expect(first.written).toBe(2);
    const second = await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent);
    expect(second.written).toBe(0);
    expect(second.skippedAlreadyCached).toBe(2);
    expect(await generatedItemCount()).toBe(2);
  });

  it('rejects a malformed response (wrong choice arity) without writing', async () => {
    const { file } = await emitVocabBatch(1);
    const badResponse = { ...goodResponse('vocab'), choices: goodResponse('vocab').choices.slice(0, 3) };
    const filled = file.items.map((item) => ({ ...item, response: badResponse })) as unknown as WorkOrderItem[];
    const inFile = await writeFilled(file, filled);

    await expect(runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent)).rejects.toThrow(
      ItemBankInputError,
    );
    expect(await generatedItemCount()).toBe(0);
  });

  it('rejects a section<->kind mismatch (grammar response with a vocab kind) without writing', async () => {
    await seedGrammarCell(pg.pool, { pattern: '-패턴1', proficiency: 'L3' });
    const outFile = await makeTmpFile('emit-grammar.json');
    await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['grammar'], levels: ['L3'], perCell: 1, outFile }),
      silent,
    );
    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    // Mismatched: grammar item, but the response claims kind='synonym'.
    const mismatched = { ...file.items[0]!, response: goodResponse('vocab') } as unknown as WorkOrderItem;
    const inFile = await writeFilled(file, [mismatched]);

    await expect(runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent)).rejects.toThrow(
      ItemBankInputError,
    );
    expect(await generatedItemCount()).toBe(0);
  });

  it('hash drift (mutated promptHash) is skipped, not written', async () => {
    const { file } = await emitVocabBatch(1);
    const drifted = {
      ...file.items[0]!,
      promptHash: '0'.repeat(64),
      response: goodResponse('vocab'),
    } as unknown as WorkOrderItem;
    const inFile = await writeFilled(file, [drifted]);

    await expect(runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent)).rejects.toThrow(
      ItemBankInputError,
    );
    expect(await generatedItemCount()).toBe(0);
  });

  it('an unfilled work-order (no `response` key) is bad input (exit 2)', async () => {
    const { file } = await emitVocabBatch(1);
    const inFile = await makeTmpFile('unfilled.json');
    await writeFile(inFile, JSON.stringify(file, null, 2));

    const err = await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ItemBankInputError);
    expect(exitCodeFor(err)).toBe(2);
  });

  it('a fully-invalid work-order (0 written, 0 already-cached) is never a clean pass', async () => {
    const { file } = await emitVocabBatch(1);
    const invalid = { ...file.items[0]!, response: { bogus: true } } as unknown as WorkOrderItem;
    const inFile = await writeFilled(file, [invalid]);

    await expect(runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent)).rejects.toThrow(
      ItemBankInputError,
    );
  });

  it('an empty items:[] work-order is a clean no-op', async () => {
    const inFile = await makeTmpFile('empty.json');
    await writeFile(inFile, JSON.stringify({ meta: { model: 'claude-sonnet-4-6' }, items: [] }));
    const summary = await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent);
    expect(summary.total).toBe(0);
    expect(summary.written).toBe(0);
  });

  it('rejects --ingest with no --in', async () => {
    await expect(runIngest(pg.pool, makeOpts({ mode: 'ingest' }), silent)).rejects.toThrow(
      ItemBankInputError,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. F-220 slice 2 — reading section (topic seeding, passage emit/ingest)
// ---------------------------------------------------------------------------

describe('F-220 slice 2 — reading topics', () => {
  it('pickReadingTopics never runs short: n > list length still returns n seeds (repetition allowed)', () => {
    const seeds = pickReadingTopics('L3', READING_TOPICS.length + 5);
    expect(seeds).toHaveLength(READING_TOPICS.length + 5);
    for (const s of seeds) expect(READING_TOPICS).toContain(s.seedKorean);
  });

  it('pickReadingTopics returns DISTINCT topics for n <= list length (variety before any repeat)', () => {
    const seeds = pickReadingTopics('L3', READING_TOPICS.length);
    expect(new Set(seeds.map((s) => s.seedKorean)).size).toBe(READING_TOPICS.length);
  });

  it('COPYRIGHT: the topic list is bare concept words only — no long/prose-shaped entries', () => {
    // A sentinel that every entry is a short bare word/phrase, never a
    // paragraph of prose that could have been lifted from a corpus.
    for (const topic of READING_TOPICS) {
      expect(topic.length).toBeLessThanOrEqual(10);
    }
  });
});

describe('F-220 slice 2 — reading count/emit/ingest', () => {
  it('runCount treats reading as repetition-unbounded: achievable == perCell regardless of --per-cell', async () => {
    const summary = await runCount(
      pg.pool,
      makeOpts({ sections: ['reading'], levels: ['L3'], perCell: 5 }),
      silent,
    );
    expect(summary.cells).toHaveLength(1);
    expect(summary.cells[0]!.achievable).toBe(5);
    expect(await generatedItemCount()).toBe(0);

    const bigger = await runCount(
      pg.pool,
      makeOpts({ sections: ['reading'], levels: ['L3'], perCell: READING_TOPICS.length + 10 }),
      silent,
    );
    // Unlike vocab/grammar (capped at the real pool size), reading's
    // achievable count is NEVER capped by the topic list length.
    expect(bigger.cells[0]!.achievable).toBe(READING_TOPICS.length + 10);
  });

  it('runEmitBatch emits a reading work-order with schema=DiagnosticReadingItemResult and independently-reproducible hashes; zero DB writes', async () => {
    const outFile = await makeTmpFile('reading-batch.json');
    const summary = await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['reading'], levels: ['L3'], perCell: 4, outFile }),
      silent,
    );
    expect(summary.emitted).toBe(4);

    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    expect(file.items).toHaveLength(4);
    expect(file.meta.readingModel).toBeTruthy();

    const cfg = loadConfig();
    for (const item of file.items) {
      expect(item.section).toBe('reading');
      expect(item.level).toBe('L3');
      expect(item.schema).toBe('DiagnosticReadingItemResult');
      expect(item.seedEnglish).toBeUndefined(); // topics never carry a gloss
      expect(READING_TOPICS).toContain(item.seedKorean); // seedKorean holds the bare topic
      expect(item.promptHash).toMatch(/^[0-9a-f]{64}$/);
      const rebuilt = buildReadingWorkOrderRequest(
        'L3',
        { seedRef: item.seedRef, seedKorean: item.seedKorean },
        file.meta.readingModel,
        cfg,
      );
      expect(rebuilt).not.toBeNull();
      expect(rebuilt!.promptHash).toBe(item.promptHash);
    }
    // Distinct topics (perCell 4 <= the ~40-topic list) -> distinct hashes.
    expect(new Set(file.items.map((i) => i.promptHash)).size).toBe(4);

    expect(await generatedItemCount()).toBe(0);
  });

  it('runIngest writes reading rows with a non-null passage, kind=passage-mc, and section=reading', async () => {
    const outFile = await makeTmpFile('reading-emit.json');
    await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['reading'], levels: ['L4'], perCell: 2, outFile }),
      silent,
    );
    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    const filled = file.items.map((item, i) => ({
      ...item,
      response: goodReadingResponse(`읽기 지문 ${String(i)}입니다.`, `정답-${String(i)}`),
    })) as unknown as WorkOrderItem[];
    const inFile = await makeTmpFile('reading-filled.json');
    await writeFile(inFile, JSON.stringify({ meta: file.meta, items: filled }, null, 2));

    const summary = await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent);
    expect(summary.written).toBe(2);
    expect(summary.skippedInvalid).toBe(0);
    expect(summary.skippedHashDrift).toBe(0);

    const rows = await pg.pool.query<{
      status: string;
      section: string;
      level: string;
      kind: string;
      stem: string;
      passage: string | null;
      choices: Array<{ kr: string; en: string }>;
      answer_index: number;
    }>(
      `SELECT status, section, level, kind, stem, passage, choices, answer_index
         FROM generated_items ORDER BY id`,
    );
    expect(rows.rows).toHaveLength(2);
    for (const [i, row] of rows.rows.entries()) {
      expect(row.status).toBe('draft');
      expect(row.section).toBe('reading');
      expect(row.level).toBe('L4');
      expect(row.kind).toBe('passage-mc');
      expect(row.passage).toBe(`읽기 지문 ${String(i)}입니다.`);
      expect(row.choices[row.answer_index]!.kr).toBe(`정답-${String(i)}`);
    }
  });

  it('a vocab/grammar row written alongside reading rows still has passage=NULL', async () => {
    await seedVocabEntry(pg.pool, { proficiency: 'L3', korean: '단어' });
    const vocabOut = await makeTmpFile('mixed-vocab.json');
    await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['vocab'], levels: ['L3'], perCell: 1, outFile: vocabOut }),
      silent,
    );
    const vocabFile = JSON.parse(await readFile(vocabOut, 'utf8')) as WorkOrderFile;
    const vocabFilled = vocabFile.items.map((item) => ({
      ...item,
      response: goodResponse('vocab'),
    })) as unknown as WorkOrderItem[];
    const vocabIn = await makeTmpFile('mixed-vocab-filled.json');
    await writeFile(vocabIn, JSON.stringify({ meta: vocabFile.meta, items: vocabFilled }, null, 2));
    await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile: vocabIn }), silent);

    const readingOut = await makeTmpFile('mixed-reading.json');
    await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['reading'], levels: ['L3'], perCell: 1, outFile: readingOut }),
      silent,
    );
    const readingFile = JSON.parse(await readFile(readingOut, 'utf8')) as WorkOrderFile;
    const readingFilled = readingFile.items.map((item) => ({
      ...item,
      response: goodReadingResponse(),
    })) as unknown as WorkOrderItem[];
    const readingIn = await makeTmpFile('mixed-reading-filled.json');
    await writeFile(readingIn, JSON.stringify({ meta: readingFile.meta, items: readingFilled }, null, 2));
    await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile: readingIn }), silent);

    const rows = await pg.pool.query<{ section: string; passage: string | null }>(
      `SELECT section, passage FROM generated_items ORDER BY id`,
    );
    expect(rows.rows).toHaveLength(2);
    const vocabRow = rows.rows.find((r) => r.section === 'vocab')!;
    const readingRow = rows.rows.find((r) => r.section === 'reading')!;
    expect(vocabRow.passage).toBeNull();
    expect(readingRow.passage).not.toBeNull();
  });

  it('rejects a malformed reading response (missing passage) without writing', async () => {
    const outFile = await makeTmpFile('reading-bad.json');
    await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['reading'], levels: ['L3'], perCell: 1, outFile }),
      silent,
    );
    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    const badResponse = { ...goodReadingResponse() } as Record<string, unknown>;
    delete badResponse.passage;
    const filled = file.items.map((item) => ({ ...item, response: badResponse })) as unknown as WorkOrderItem[];
    const inFile = await makeTmpFile('reading-bad-filled.json');
    await writeFile(inFile, JSON.stringify({ meta: file.meta, items: filled }, null, 2));

    await expect(runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent)).rejects.toThrow(
      ItemBankInputError,
    );
    expect(await generatedItemCount()).toBe(0);
  });

  it('is idempotent: re-ingesting the same filled reading file writes 0 new rows', async () => {
    const outFile = await makeTmpFile('reading-idem.json');
    await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['reading'], levels: ['L3'], perCell: 1, outFile }),
      silent,
    );
    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    const filled = file.items.map((item) => ({
      ...item,
      response: goodReadingResponse(),
    })) as unknown as WorkOrderItem[];
    const inFile = await makeTmpFile('reading-idem-filled.json');
    await writeFile(inFile, JSON.stringify({ meta: file.meta, items: filled }, null, 2));

    const first = await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent);
    expect(first.written).toBe(1);
    const second = await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent);
    expect(second.written).toBe(0);
    expect(second.skippedAlreadyCached).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8. F-220 slice 3 — listening section (SAME topic seeding, turns emit/ingest)
// ---------------------------------------------------------------------------

describe('F-220 slice 3 — listening count/emit/ingest', () => {
  it('SECTIONS includes listening and --section=listening is valid', () => {
    expect(SECTIONS).toContain('listening');
    const opts = parseCliArgs(['--section=listening']);
    expect(opts.sections).toEqual(['listening']);
  });

  it('runCount treats listening as repetition-unbounded (same topic list as reading): achievable == perCell', async () => {
    const summary = await runCount(
      pg.pool,
      makeOpts({ sections: ['listening'], levels: ['L2'], perCell: 6 }),
      silent,
    );
    expect(summary.cells).toHaveLength(1);
    expect(summary.cells[0]!.achievable).toBe(6);
    expect(await generatedItemCount()).toBe(0);
  });

  it('runEmitBatch emits a listening work-order with schema=DiagnosticListeningItemResult and independently-reproducible hashes; zero DB writes', async () => {
    const outFile = await makeTmpFile('listening-batch.json');
    const summary = await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['listening'], levels: ['L3'], perCell: 4, outFile }),
      silent,
    );
    expect(summary.emitted).toBe(4);

    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    expect(file.items).toHaveLength(4);
    expect(file.meta.listeningModel).toBeTruthy();

    const cfg = loadConfig();
    for (const item of file.items) {
      expect(item.section).toBe('listening');
      expect(item.level).toBe('L3');
      expect(item.schema).toBe('DiagnosticListeningItemResult');
      expect(item.seedEnglish).toBeUndefined(); // topics never carry a gloss
      expect(READING_TOPICS).toContain(item.seedKorean); // the SAME bare-topic list reading uses
      expect(item.promptHash).toMatch(/^[0-9a-f]{64}$/);
      const rebuilt = buildListeningWorkOrderRequest(
        'L3',
        { seedRef: item.seedRef, seedKorean: item.seedKorean },
        file.meta.listeningModel,
        cfg,
      );
      expect(rebuilt).not.toBeNull();
      expect(rebuilt!.promptHash).toBe(item.promptHash);
    }
    expect(new Set(file.items.map((i) => i.promptHash)).size).toBe(4);

    expect(await generatedItemCount()).toBe(0);
  });

  it('runIngest writes listening rows with turns landing (non-null JSONB), kind=audio-mc, section=listening, passage=NULL, audio_source_id=NULL', async () => {
    const outFile = await makeTmpFile('listening-emit.json');
    await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['listening'], levels: ['L4'], perCell: 2, outFile }),
      silent,
    );
    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    const filled = file.items.map((item, i) => ({
      ...item,
      response: goodListeningResponse(`정답-${String(i)}`),
    })) as unknown as WorkOrderItem[];
    const inFile = await makeTmpFile('listening-filled.json');
    await writeFile(inFile, JSON.stringify({ meta: file.meta, items: filled }, null, 2));

    const summary = await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent);
    expect(summary.written).toBe(2);
    expect(summary.skippedInvalid).toBe(0);
    expect(summary.skippedHashDrift).toBe(0);

    const rows = await pg.pool.query<{
      status: string;
      section: string;
      level: string;
      kind: string;
      stem: string;
      passage: string | null;
      choices: Array<{ kr: string; en: string }>;
      answer_index: number;
      turns: Array<{ speaker: string; gender: string; text: string }> | null;
      audio_source_id: string | null;
      audio_cost_estimate_usd: string | null;
      audio_synthesized_at: string | null;
    }>(
      `SELECT status, section, level, kind, stem, passage, choices, answer_index,
              turns, audio_source_id, audio_cost_estimate_usd, audio_synthesized_at
         FROM generated_items ORDER BY id`,
    );
    expect(rows.rows).toHaveLength(2);
    for (const [i, row] of rows.rows.entries()) {
      expect(row.status).toBe('draft');
      expect(row.section).toBe('listening');
      expect(row.level).toBe('L4');
      expect(row.kind).toBe('audio-mc');
      expect(row.passage).toBeNull(); // NEVER a passage for a listening row
      expect(row.audio_source_id).toBeNull(); // this CLI is the $0 script step — no audio yet
      expect(row.audio_cost_estimate_usd).toBeNull();
      expect(row.audio_synthesized_at).toBeNull();
      // turns landed as a real JSONB array — the dialogue script the synth
      // CLI will later consume.
      expect(row.turns).not.toBeNull();
      expect(row.turns).toHaveLength(3);
      expect(row.turns![0]!.speaker).toBe('narrator');
      expect(row.turns![1]!.gender).toBe('male');
      expect(row.choices[row.answer_index]!.kr).toBe(`정답-${String(i)}`);
    }
  });

  it('a reading row written alongside listening rows still has turns=NULL, and a listening row has passage=NULL', async () => {
    const readingOut = await makeTmpFile('mixed2-reading.json');
    await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['reading'], levels: ['L3'], perCell: 1, outFile: readingOut }),
      silent,
    );
    const readingFile = JSON.parse(await readFile(readingOut, 'utf8')) as WorkOrderFile;
    const readingFilled = readingFile.items.map((item) => ({
      ...item,
      response: goodReadingResponse(),
    })) as unknown as WorkOrderItem[];
    const readingIn = await makeTmpFile('mixed2-reading-filled.json');
    await writeFile(readingIn, JSON.stringify({ meta: readingFile.meta, items: readingFilled }, null, 2));
    await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile: readingIn }), silent);

    const listeningOut = await makeTmpFile('mixed2-listening.json');
    await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['listening'], levels: ['L3'], perCell: 1, outFile: listeningOut }),
      silent,
    );
    const listeningFile = JSON.parse(await readFile(listeningOut, 'utf8')) as WorkOrderFile;
    const listeningFilled = listeningFile.items.map((item) => ({
      ...item,
      response: goodListeningResponse(),
    })) as unknown as WorkOrderItem[];
    const listeningIn = await makeTmpFile('mixed2-listening-filled.json');
    await writeFile(listeningIn, JSON.stringify({ meta: listeningFile.meta, items: listeningFilled }, null, 2));
    await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile: listeningIn }), silent);

    const rows = await pg.pool.query<{ section: string; passage: string | null; turns: unknown | null }>(
      `SELECT section, passage, turns FROM generated_items ORDER BY id`,
    );
    expect(rows.rows).toHaveLength(2);
    const readingRow = rows.rows.find((r) => r.section === 'reading')!;
    const listeningRow = rows.rows.find((r) => r.section === 'listening')!;
    expect(readingRow.passage).not.toBeNull();
    expect(readingRow.turns).toBeNull();
    expect(listeningRow.passage).toBeNull();
    expect(listeningRow.turns).not.toBeNull();
  });

  it('rejects a malformed listening response (only 1 turn, below the 2-6 minimum) without writing', async () => {
    const outFile = await makeTmpFile('listening-bad.json');
    await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['listening'], levels: ['L3'], perCell: 1, outFile }),
      silent,
    );
    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    const badResponse = { ...goodListeningResponse(), turns: goodListeningResponse().turns.slice(0, 1) };
    const filled = file.items.map((item) => ({ ...item, response: badResponse })) as unknown as WorkOrderItem[];
    const inFile = await makeTmpFile('listening-bad-filled.json');
    await writeFile(inFile, JSON.stringify({ meta: file.meta, items: filled }, null, 2));

    await expect(runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent)).rejects.toThrow(
      ItemBankInputError,
    );
    expect(await generatedItemCount()).toBe(0);
  });

  it('is idempotent: re-ingesting the same filled listening file writes 0 new rows', async () => {
    const outFile = await makeTmpFile('listening-idem.json');
    await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['listening'], levels: ['L3'], perCell: 1, outFile }),
      silent,
    );
    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    const filled = file.items.map((item) => ({
      ...item,
      response: goodListeningResponse(),
    })) as unknown as WorkOrderItem[];
    const inFile = await makeTmpFile('listening-idem-filled.json');
    await writeFile(inFile, JSON.stringify({ meta: file.meta, items: filled }, null, 2));

    const first = await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent);
    expect(first.written).toBe(1);
    const second = await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent);
    expect(second.written).toBe(0);
    expect(second.skippedAlreadyCached).toBe(1);
  });
});
describe('F-220 P1 — pairedReadingQuestionCountFor / stimulusGroupIdFromHash / rowPromptHash (pure helpers)', () => {
  it('pairedReadingQuestionCountFor alternates 2, 3, 2, 3, … deterministically', () => {
    expect(pairedReadingQuestionCountFor(1)).toBe(2);
    expect(pairedReadingQuestionCountFor(2)).toBe(3);
    expect(pairedReadingQuestionCountFor(3)).toBe(2);
    expect(pairedReadingQuestionCountFor(4)).toBe(3);
  });

  it('stimulusGroupIdFromHash is a deterministic 32-char prefix of the group hash', () => {
    const hash = 'a'.repeat(64);
    expect(stimulusGroupIdFromHash(hash)).toBe('a'.repeat(32));
    expect(stimulusGroupIdFromHash(hash)).toHaveLength(32);
    // Deterministic: same input -> same output.
    expect(stimulusGroupIdFromHash(hash)).toBe(stimulusGroupIdFromHash(hash));
  });

  it('rowPromptHash is a deterministic 64-hex-char SHA-256, distinct per ordinal', () => {
    const groupHash = 'b'.repeat(64);
    const h1 = rowPromptHash(groupHash, 1);
    const h2 = rowPromptHash(groupHash, 2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h2).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toBe(h2); // per-row uniqueness — the whole point
    // Deterministic: same (groupHash, ordinal) -> same hash (idempotent retry).
    expect(rowPromptHash(groupHash, 1)).toBe(h1);
  });
});

describe('F-220 P1 — paired-reading count/emit/ingest (grouped rows, shared passage)', () => {
  it('SECTIONS includes paired-reading and --section=paired-reading is valid', () => {
    expect(SECTIONS).toContain('paired-reading');
    const opts = parseCliArgs(['--section=paired-reading']);
    expect(opts.sections).toEqual(['paired-reading']);
  });

  it('runCount treats paired-reading as repetition-unbounded (perCell groups, not questions)', async () => {
    const summary = await runCount(
      pg.pool,
      makeOpts({ sections: ['paired-reading'], levels: ['L2'], perCell: 5 }),
      silent,
    );
    expect(summary.cells).toHaveLength(1);
    expect(summary.cells[0]!.achievable).toBe(5);
    expect(await generatedItemCount()).toBe(0);
  });

  it('runEmitBatch emits ONE work-order item PER GROUP, schema=DiagnosticPairedReadingItemResult, questionCount 2..3, independently-reproducible hashes; zero DB writes', async () => {
    const outFile = await makeTmpFile('paired-reading-batch.json');
    const summary = await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['paired-reading'], levels: ['L3'], perCell: 4, outFile }),
      silent,
    );
    expect(summary.emitted).toBe(4);

    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    expect(file.items).toHaveLength(4); // 4 GROUPS, not 4 questions
    expect(file.meta.pairedReadingModel).toBeTruthy();

    const cfg = loadConfig();
    const seenCounts = new Set<number>();
    for (const item of file.items) {
      expect(item.section).toBe('paired-reading');
      expect(item.level).toBe('L3');
      expect(item.schema).toBe('DiagnosticPairedReadingItemResult');
      expect(item.questionCount).toBeGreaterThanOrEqual(2);
      expect(item.questionCount).toBeLessThanOrEqual(3);
      seenCounts.add(item.questionCount!);
      expect(READING_TOPICS).toContain(item.seedKorean);
      expect(item.promptHash).toMatch(/^[0-9a-f]{64}$/);
      const rebuilt = buildPairedReadingWorkOrderRequest(
        'L3',
        { seedRef: item.seedRef, seedKorean: item.seedKorean },
        item.questionCount!,
        file.meta.pairedReadingModel,
        cfg,
      );
      expect(rebuilt).not.toBeNull();
      expect(rebuilt!.promptHash).toBe(item.promptHash);
    }
    // The alternating 2/3 count (pairedReadingQuestionCountFor) means a
    // 4-item batch sees BOTH sizes — proving the mix, not just one constant.
    expect(seenCounts.has(2)).toBe(true);
    expect(seenCounts.has(3)).toBe(true);
    expect(new Set(file.items.map((i) => i.promptHash)).size).toBe(4); // group hashes distinct

    expect(await generatedItemCount()).toBe(0);
  });

  it('runIngest writes N grouped rows per group: SAME passage + stimulus_group_id, distinct stimulus_group_ordinal (1..N), distinct per-row prompt_hash', async () => {
    const outFile = await makeTmpFile('paired-reading-emit.json');
    await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['paired-reading'], levels: ['L4'], perCell: 2, outFile }),
      silent,
    );
    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    const filled = file.items.map((item) => ({
      ...item,
      response: goodPairedReadingResponse(item.questionCount as 2 | 3),
    })) as unknown as WorkOrderItem[];
    const inFile = await makeTmpFile('paired-reading-filled.json');
    await writeFile(inFile, JSON.stringify({ meta: file.meta, items: filled }, null, 2));

    const summary = await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent);
    // written counts ROWS (questions), not work-order items (groups).
    const totalQuestions = file.items.reduce((sum, i) => sum + (i.questionCount ?? 0), 0);
    expect(summary.written).toBe(totalQuestions);
    expect(summary.skippedInvalid).toBe(0);
    expect(summary.skippedHashDrift).toBe(0);

    const rows = await pg.pool.query<{
      id: string;
      status: string;
      section: string;
      level: string;
      kind: string;
      stem: string;
      passage: string | null;
      choices: Array<{ kr: string; en: string }>;
      answer_index: number;
      stimulus_group_id: string | null;
      stimulus_group_ordinal: number | null;
      prompt_hash: string;
    }>(
      `SELECT id, status, section, level, kind, stem, passage, choices, answer_index,
              stimulus_group_id, stimulus_group_ordinal, prompt_hash
         FROM generated_items ORDER BY stimulus_group_id, stimulus_group_ordinal`,
    );
    expect(rows.rows).toHaveLength(totalQuestions);

    // Group by stimulus_group_id and verify each group's invariants.
    const byGroup = new Map<string, typeof rows.rows>();
    for (const row of rows.rows) {
      expect(row.stimulus_group_id).not.toBeNull();
      const list = byGroup.get(row.stimulus_group_id!) ?? [];
      list.push(row);
      byGroup.set(row.stimulus_group_id!, list);
    }
    expect(byGroup.size).toBe(file.items.length); // one group per work-order item

    for (const [, groupRows] of byGroup) {
      const passages = new Set(groupRows.map((r) => r.passage));
      expect(passages.size).toBe(1); // SAME passage denormalized onto every row
      const ordinals = groupRows.map((r) => r.stimulus_group_ordinal).sort((a, b) => a! - b!);
      expect(ordinals).toEqual(Array.from({ length: groupRows.length }, (_, i) => i + 1)); // 1..N
      const hashes = new Set(groupRows.map((r) => r.prompt_hash));
      expect(hashes.size).toBe(groupRows.length); // per-ROW-unique prompt_hash
      for (const row of groupRows) {
        expect(row.status).toBe('draft');
        expect(row.section).toBe('reading');
        expect(row.level).toBe('L4');
        expect(row.kind).toBe('paired-passage-mc');
        expect(row.passage).not.toBeNull();
      }
    }
  });

  it('is idempotent: re-ingesting the same filled paired-reading file writes 0 new rows (per-row ON CONFLICT)', async () => {
    const outFile = await makeTmpFile('paired-reading-idem.json');
    await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['paired-reading'], levels: ['L3'], perCell: 1, outFile }),
      silent,
    );
    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    const filled = file.items.map((item) => ({
      ...item,
      response: goodPairedReadingResponse(item.questionCount as 2 | 3),
    })) as unknown as WorkOrderItem[];
    const inFile = await makeTmpFile('paired-reading-idem-filled.json');
    await writeFile(inFile, JSON.stringify({ meta: file.meta, items: filled }, null, 2));

    const first = await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent);
    expect(first.written).toBeGreaterThan(0);
    const second = await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent);
    expect(second.written).toBe(0);
    expect(second.skippedAlreadyCached).toBe(first.written);
  });

  it('rejects a malformed paired-reading response (only 1 question, below the 2-question minimum) without writing', async () => {
    const outFile = await makeTmpFile('paired-reading-bad.json');
    await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['paired-reading'], levels: ['L3'], perCell: 1, outFile }),
      silent,
    );
    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    const badResponse = { ...goodPairedReadingResponse(2), questions: [goodPairedReadingResponse(2).questions[0]!] };
    const filled = file.items.map((item) => ({ ...item, response: badResponse })) as unknown as WorkOrderItem[];
    const inFile = await makeTmpFile('paired-reading-bad-filled.json');
    await writeFile(inFile, JSON.stringify({ meta: file.meta, items: filled }, null, 2));

    await expect(runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent)).rejects.toThrow(
      ItemBankInputError,
    );
    expect(await generatedItemCount()).toBe(0);
  });

  it('a work-order item missing questionCount is skipped as seed-invalid (and the run refuses to look green, mirroring an unfilled file)', async () => {
    const outFile = await makeTmpFile('paired-reading-missing-qc.json');
    await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['paired-reading'], levels: ['L3'], perCell: 1, outFile }),
      silent,
    );
    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    const filled = file.items.map((item) => {
      const { questionCount: _questionCount, ...rest } = item;
      return { ...rest, response: goodPairedReadingResponse(2) };
    }) as unknown as WorkOrderItem[];
    const inFile = await makeTmpFile('paired-reading-missing-qc-filled.json');
    await writeFile(inFile, JSON.stringify({ meta: file.meta, items: filled }, null, 2));

    // Every item in this (single-item) file skips as seed-invalid -> 0
    // written, 0 already-cached -> the same "never look green" guard that
    // fires for an unfilled work-order (generate-item-bank.ts's own doc).
    await expect(runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent)).rejects.toThrow(
      ItemBankInputError,
    );
    expect(await generatedItemCount()).toBe(0);
  });

  it('a work-order item missing questionCount is skipped as seed-invalid WITHOUT masking a sibling group that DID land', async () => {
    const outFile = await makeTmpFile('paired-reading-missing-qc-mixed.json');
    await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['paired-reading'], levels: ['L3'], perCell: 2, outFile }),
      silent,
    );
    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    expect(file.items.length).toBeGreaterThanOrEqual(2);
    const filled = file.items.map((item, i) => {
      if (i === 0) {
        // Strip questionCount from only the FIRST item — its sibling stays
        // well-formed, so the run should still land the sibling's rows.
        const { questionCount: _questionCount, ...rest } = item;
        return { ...rest, response: goodPairedReadingResponse(2) };
      }
      return { ...item, response: goodPairedReadingResponse(item.questionCount as 2 | 3) };
    }) as unknown as WorkOrderItem[];
    const inFile = await makeTmpFile('paired-reading-missing-qc-mixed-filled.json');
    await writeFile(inFile, JSON.stringify({ meta: file.meta, items: filled }, null, 2));

    const summary = await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent);
    expect(summary.skippedSeedInvalid).toBeGreaterThan(0);
    expect(summary.written).toBeGreaterThan(0);
    expect(await generatedItemCount()).toBeGreaterThan(0);
  });
});

describe('F-220 P1 — paired-listening count/emit/ingest (grouped rows, shared turns, NO passage, NO audio yet)', () => {
  it('SECTIONS includes paired-listening and --section=paired-listening is valid', () => {
    expect(SECTIONS).toContain('paired-listening');
    const opts = parseCliArgs(['--section=paired-listening']);
    expect(opts.sections).toEqual(['paired-listening']);
  });

  it('runEmitBatch emits ONE work-order item PER GROUP, schema=DiagnosticPairedListeningItemResult, questionCount always 2', async () => {
    const outFile = await makeTmpFile('paired-listening-batch.json');
    const summary = await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['paired-listening'], levels: ['L3'], perCell: 3, outFile }),
      silent,
    );
    expect(summary.emitted).toBe(3);

    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    expect(file.items).toHaveLength(3);
    expect(file.meta.pairedListeningModel).toBeTruthy();

    const cfg = loadConfig();
    for (const item of file.items) {
      expect(item.section).toBe('paired-listening');
      expect(item.questionCount).toBe(2);
      expect(item.schema).toBe('DiagnosticPairedListeningItemResult');
      const rebuilt = buildPairedListeningWorkOrderRequest(
        'L3',
        { seedRef: item.seedRef, seedKorean: item.seedKorean },
        2,
        file.meta.pairedListeningModel,
        cfg,
      );
      expect(rebuilt).not.toBeNull();
      expect(rebuilt!.promptHash).toBe(item.promptHash);
    }
    expect(new Set(file.items.map((i) => i.promptHash)).size).toBe(3);
    expect(await generatedItemCount()).toBe(0);
  });

  it('runIngest writes 2 grouped rows per group: SAME turns + stimulus_group_id, kind=paired-audio-mc, passage=NULL, audio_source_id=NULL, distinct per-row prompt_hash', async () => {
    const outFile = await makeTmpFile('paired-listening-emit.json');
    await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['paired-listening'], levels: ['L3'], perCell: 2, outFile }),
      silent,
    );
    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    const filled = file.items.map((item) => ({
      ...item,
      response: goodPairedListeningResponse(),
    })) as unknown as WorkOrderItem[];
    const inFile = await makeTmpFile('paired-listening-filled.json');
    await writeFile(inFile, JSON.stringify({ meta: file.meta, items: filled }, null, 2));

    const summary = await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent);
    expect(summary.written).toBe(4); // 2 groups x 2 questions
    expect(summary.skippedInvalid).toBe(0);
    expect(summary.skippedHashDrift).toBe(0);

    const rows = await pg.pool.query<{
      status: string;
      section: string;
      kind: string;
      passage: string | null;
      turns: Array<{ speaker: string; gender: string; text: string }> | null;
      audio_source_id: string | null;
      stimulus_group_id: string | null;
      stimulus_group_ordinal: number | null;
      prompt_hash: string;
    }>(
      `SELECT status, section, kind, passage, turns, audio_source_id,
              stimulus_group_id, stimulus_group_ordinal, prompt_hash
         FROM generated_items ORDER BY stimulus_group_id, stimulus_group_ordinal`,
    );
    expect(rows.rows).toHaveLength(4);

    const byGroup = new Map<string, typeof rows.rows>();
    for (const row of rows.rows) {
      expect(row.stimulus_group_id).not.toBeNull();
      const list = byGroup.get(row.stimulus_group_id!) ?? [];
      list.push(row);
      byGroup.set(row.stimulus_group_id!, list);
    }
    expect(byGroup.size).toBe(2);

    for (const [, groupRows] of byGroup) {
      expect(groupRows).toHaveLength(2);
      const turnsSerialized = new Set(groupRows.map((r) => JSON.stringify(r.turns)));
      expect(turnsSerialized.size).toBe(1); // SAME turns denormalized onto every row
      const hashes = new Set(groupRows.map((r) => r.prompt_hash));
      expect(hashes.size).toBe(2); // per-ROW-unique prompt_hash
      for (const row of groupRows) {
        expect(row.status).toBe('draft');
        expect(row.section).toBe('listening');
        expect(row.kind).toBe('paired-audio-mc');
        expect(row.passage).toBeNull(); // NEVER a passage for a listening row
        expect(row.audio_source_id).toBeNull(); // $0 script step — no audio yet
        expect(row.turns).not.toBeNull();
      }
    }
  });

  it('is idempotent: re-ingesting the same filled paired-listening file writes 0 new rows', async () => {
    const outFile = await makeTmpFile('paired-listening-idem.json');
    await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['paired-listening'], levels: ['L3'], perCell: 1, outFile }),
      silent,
    );
    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    const filled = file.items.map((item) => ({
      ...item,
      response: goodPairedListeningResponse(),
    })) as unknown as WorkOrderItem[];
    const inFile = await makeTmpFile('paired-listening-idem-filled.json');
    await writeFile(inFile, JSON.stringify({ meta: file.meta, items: filled }, null, 2));

    const first = await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent);
    expect(first.written).toBe(2);
    const second = await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent);
    expect(second.written).toBe(0);
    expect(second.skippedAlreadyCached).toBe(2);
  });

  it('rejects a malformed paired-listening response (only 1 turn, below the 2-6 minimum) without writing', async () => {
    const outFile = await makeTmpFile('paired-listening-bad.json');
    await runEmitBatch(
      pg.pool,
      makeOpts({ mode: 'emit-batch', sections: ['paired-listening'], levels: ['L3'], perCell: 1, outFile }),
      silent,
    );
    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    const badResponse = { ...goodPairedListeningResponse(), turns: goodPairedListeningResponse().turns.slice(0, 1) };
    const filled = file.items.map((item) => ({ ...item, response: badResponse })) as unknown as WorkOrderItem[];
    const inFile = await makeTmpFile('paired-listening-bad-filled.json');
    await writeFile(inFile, JSON.stringify({ meta: file.meta, items: filled }, null, 2));

    await expect(runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent)).rejects.toThrow(
      ItemBankInputError,
    );
    expect(await generatedItemCount()).toBe(0);
  });

  it('existing single-item vocab/reading/listening ingest stays byte-identical alongside a paired batch (regression)', async () => {
    // A mixed work-order: one vocab item (slice 1), one reading item (slice
    // 2), one listening item (slice 3), one paired-reading GROUP, one
    // paired-listening GROUP — proves the pre-P1 sections are completely
    // untouched by the new branches.
    await seedVocabEntry(pg.pool, { korean: '학교', english: 'school', proficiency: 'basic' });

    const outFile = await makeTmpFile('mixed-p1-batch.json');
    await runEmitBatch(
      pg.pool,
      makeOpts({
        mode: 'emit-batch',
        sections: ['vocab', 'reading', 'listening', 'paired-reading', 'paired-listening'],
        levels: ['L3'],
        perCell: 1,
        outFile,
      }),
      silent,
    );
    const file = JSON.parse(await readFile(outFile, 'utf8')) as WorkOrderFile;
    const filled = file.items.map((item) => {
      if (item.section === 'vocab') return { ...item, response: goodResponse('vocab') };
      if (item.section === 'reading') return { ...item, response: goodReadingResponse() };
      if (item.section === 'listening') return { ...item, response: goodListeningResponse() };
      if (item.section === 'paired-reading') {
        return { ...item, response: goodPairedReadingResponse(item.questionCount as 2 | 3) };
      }
      return { ...item, response: goodPairedListeningResponse() };
    }) as unknown as WorkOrderItem[];
    const inFile = await makeTmpFile('mixed-p1-filled.json');
    await writeFile(inFile, JSON.stringify({ meta: file.meta, items: filled }, null, 2));

    await runIngest(pg.pool, makeOpts({ mode: 'ingest', inFile }), silent);

    const rows = await pg.pool.query<{ section: string; kind: string; stimulus_group_id: string | null }>(
      `SELECT section, kind, stimulus_group_id FROM generated_items ORDER BY id`,
    );
    const vocabRow = rows.rows.find((r) => r.kind === 'synonym')!;
    const readingRow = rows.rows.find((r) => r.kind === 'passage-mc')!;
    const listeningRow = rows.rows.find((r) => r.kind === 'audio-mc')!;
    expect(vocabRow.stimulus_group_id).toBeNull();
    expect(readingRow.stimulus_group_id).toBeNull();
    expect(listeningRow.stimulus_group_id).toBeNull();
    const pairedReadingRows = rows.rows.filter((r) => r.kind === 'paired-passage-mc');
    const pairedListeningRows = rows.rows.filter((r) => r.kind === 'paired-audio-mc');
    expect(pairedReadingRows.every((r) => r.stimulus_group_id !== null)).toBe(true);
    expect(pairedListeningRows.every((r) => r.stimulus_group_id !== null)).toBe(true);
    expect(pairedListeningRows).toHaveLength(2); // questionCount fixed at 2
  });
});
