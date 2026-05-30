/**
 * Test-app builder: a fresh Express app rebound to the test DB pool, with
 * the Claude proxy stubbed and a controllable Kiwi base URL.
 */
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { _setConfigForTesting } from '../../src/config/index.js';
import { setPoolForTesting } from '../../src/db/pool.js';
import {
  resetClaudeProxyForTesting,
  setClaudeProxy,
  type ClaudeProxy,
} from '../../src/services/claudeProxy.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import { resetKrdictReadyCache } from '../../src/routes/define.js';
import { createApp } from '../../src/app.js';

export interface TestApp {
  app: ReturnType<typeof createApp>;
  pool: Pool;
}

export interface BuildOptions {
  connectionString: string;
  kiwiUrl?: string;
  claudeProxy?: Partial<ClaudeProxy>;
}

/**
 * Construct a default stub claude proxy. Returns deterministic, schema-shaped
 * payloads so route tests can assert end-to-end behavior without touching
 * Anthropic. Tests that want failure paths pass overrides via opts.claudeProxy.
 */
export function makeStubProxy(overrides: Partial<ClaudeProxy> = {}): ClaudeProxy {
  const baseMeta = {
    model: 'claude-sonnet-4-6' as const,
    cacheHit: false,
    latencyMs: 1,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    costEstimateUsd: 0,
  };
  const stub: ClaudeProxy = {
    enrich: async (input) => ({
      result: {
        nuance: `mock nuance for ${input.lemma}`,
        usageNote: 'mock usage note',
        examples: [
          { korean: input.sourceSentence, english: 'mock 1' },
          { korean: '두 번째 예문', english: 'mock 2' },
        ],
        dontConfuseWith: [],
        proficiency: 'L3',
      },
      metadata: { ...baseMeta, requestId: randomUUID() },
    }),
    recognizeGrammarPattern: async (input) => ({
      result: {
        patternKey: '-아/어 보이다',
        patternName: 'mock pattern',
        meaning: 'mock meaning',
        usage: 'mock usage',
        examples: [
          { korean: input.fullSentence, english: 'mock 1', register: '해요체' },
          { korean: '예문 2', english: 'mock 2', register: '해요체' },
        ],
        proficiency: 'L3',
        confidence: 0.9,
        relatedPatterns: [],
      },
      metadata: { ...baseMeta, requestId: randomUUID() },
    }),
    gradeWriting: async (input) => ({
      result: {
        rubric: input.rubric,
        content: {
          score: 7,
          maxScore: 10,
          evidence: ['mock-evidence'],
          improvements: ['mock-improvement'],
        },
        organization: {
          score: 7,
          maxScore: 10,
          evidence: ['mock-evidence'],
          improvements: ['mock-improvement'],
        },
        languageUse: {
          score: 7,
          maxScore: 10,
          evidence: ['mock-evidence'],
          improvements: ['mock-improvement'],
        },
        totalScore: 21,
        maxTotal: 30,
        estimatedLevel: 'L3',
        overallComment: 'mock overall',
      },
      metadata: { ...baseMeta, requestId: randomUUID() },
    }),
    generateDiagnosticItem: async (input) => ({
      // Deterministic valid item: 4 choices, answerIndex 0, kind by section.
      // vocab → 'synonym', grammar → 'pattern'. Lets route tests exercise the
      // full serve/grade/finish flow without touching Anthropic.
      result: {
        kind: input.section === 'grammar' ? ('pattern' as const) : ('synonym' as const),
        prompt: `mock ${input.section} question for ${input.seedKorean} (${input.targetLevel})`,
        choices: [
          { kr: '정답', en: 'correct' },
          { kr: '오답 1', en: 'wrong 1' },
          { kr: '오답 2', en: 'wrong 2' },
          { kr: '오답 3', en: 'wrong 3' },
        ],
        answerIndex: 0,
        explain: 'mock explanation: the first choice is correct.',
      },
      metadata: { ...baseMeta, requestId: randomUUID() },
    }),
    generateConversation: (input) => {
      // Default stub: a deterministic single-delta stream + a complete event.
      // Tests that need failure or chunked behaviour pass an override via
      // opts.claudeProxy.generateConversation.
      const turn: import('../../src/services/claude/index.js').ConversationTurn = {
        korean: '네, 알겠어요.',
        englishNote: 'mock acknowledgement',
        vocabUsed: [],
        register: input.registerTarget ?? '해요체',
      };
      const events: import('../../src/services/claude/index.js').ConversationStreamEvent[] = [
        { type: 'start', register: turn.register },
        { type: 'delta', text: turn.korean },
        { type: 'complete', turn },
      ];
      // Async iterable returning the prebuilt events.
      const iter: AsyncIterable<
        import('../../src/services/claude/index.js').ConversationStreamEvent
      > = {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            async next() {
              if (i < events.length) {
                return { value: events[i++]!, done: false };
              }
              return {
                value: undefined as never,
                done: true,
              };
            },
          };
        },
      };
      const final: Promise<
        import('../../src/services/claude/index.js').ProxyResult<
          import('../../src/services/claude/index.js').ConversationTurn
        >
      > = Promise.resolve({
        result: turn,
        metadata: { ...baseMeta, requestId: randomUUID() },
      });
      return { events: iter, final };
    },
    evictExpiredCache: async () => 0,
  };
  // Apply per-test overrides for any specific methods.
  return { ...stub, ...overrides };
}

export function buildTestApp(opts: BuildOptions): TestApp {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.DATABASE_URL = opts.connectionString;
  process.env.KIWI_URL = opts.kiwiUrl ?? 'http://kiwi.invalid/';
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';
  process.env.SESSION_COOKIE_NAME = 'km_sid';
  process.env.SESSION_LIFETIME_DAYS = '30';
  process.env.SESSION_IDLE_TIMEOUT_DAYS = '7';
  process.env.RATE_LIMIT_WINDOW_MS = '60000';
  process.env.RATE_LIMIT_CHEAP_MAX = '120';
  process.env.RATE_LIMIT_EXPENSIVE_MAX = '20';
  process.env.RATE_LIMIT_AUTH_MAX = '5';
  process.env.LOG_LEVEL = 'silent';
  _setConfigForTesting({});

  const pool = new Pool({ connectionString: opts.connectionString, max: 5 });
  setPoolForTesting(pool);

  resetClaudeProxyForTesting();
  setClaudeProxy(makeStubProxy(opts.claudeProxy));

  resetLimiters();
  resetKrdictReadyCache();

  const app = createApp();
  return { app, pool };
}

export async function teardownTestApp(t: TestApp): Promise<void> {
  await t.pool.end().catch(() => undefined);
}
