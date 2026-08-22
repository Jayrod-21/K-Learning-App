/**
 * Test-app builder: a fresh Express app rebound to the test DB pool, with
 * the Claude proxy stubbed and a controllable Kiwi base URL.
 */
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { _setConfigForTesting, TEST_TOTP_SECRET_ENC_KEY } from '../../src/config/index.js';
import { _resetEncryptionKeyForTesting } from '../../src/crypto/encryption.js';
import { getPoolForTesting, setPoolForTesting } from '../../src/db/pool.js';
import {
  getClaudeProxyForTesting,
  resetClaudeProxyForTesting,
  setClaudeProxy,
  type ClaudeProxy,
} from '../../src/services/claudeProxy.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import { resetKrdictReadyCache } from '../../src/routes/define.js';
import { _resetMailTransportForTesting } from '../../src/services/mail.js';
import { createApp } from '../../src/app.js';

export interface TestApp {
  app: ReturnType<typeof createApp>;
  pool: Pool;
  /**
   * The pool that was installed as the global db pool BEFORE this app replaced
   * it (null if none). teardownTestApp restores it so tearing down an ephemeral
   * per-test app (e.g. one wired to a failing Claude proxy) does NOT leave the
   * shared suite app pointing at an ended pool.
   */
  previousPool: Pool | null;
  /**
   * The Claude proxy that was installed globally BEFORE this app replaced it
   * (null if none). teardownTestApp restores it so an ephemeral per-test app
   * wired to a failing/odd stub proxy does not leak that stub into the shared
   * suite app after teardown.
   */
  previousProxy: ClaudeProxy | null;
}

export interface BuildOptions {
  connectionString: string;
  kiwiUrl?: string;
  claudeProxy?: Partial<ClaudeProxy>;
  /**
   * Pass Login config overrides. Defaults keep the LEGACY single-step login
   * behavior (mfaRequired=false) so the pre-existing auth tests — which expect
   * /auth/login to set a session cookie directly — stay valid. The MFA test
   * suite opts into the two-step flow with `mfaRequired: true`.
   */
  mfaRequired?: boolean;
  registrationEnabled?: boolean;
  /**
   * F-006 email-verification login gate. Defaults FALSE so the pre-existing
   * suites — which register-then-use-the-session directly — stay valid; the
   * verification suite opts in. The mail transport is always reset to the
   * mock (SMTP_HOST is cleared in buildTestApp), so NO test touches real SMTP.
   */
  emailVerificationRequired?: boolean;
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
    ocrImage: async () => ({
      // Deterministic OCR result: a fixed caption + 3 content words (no boxes).
      // Lets the /images upload route test assert the persisted caption + words
      // without touching Anthropic Vision. The input (image bytes) is ignored —
      // the stub is intentionally content-independent so the test is stable.
      result: {
        caption_kr: '책상 위의 메뉴판',
        caption_en: 'a menu on the desk',
        words: [
          { kr: '메뉴', en: 'menu', gloss: 'a list of dishes', pos: 'n.' as const },
          { kr: '주문하다', en: 'to order', gloss: 'to place an order', pos: 'v.' as const },
          { kr: '맛있다', en: 'delicious', gloss: 'tastes good', pos: 'adj.' as const },
        ],
      },
      metadata: { ...baseMeta, requestId: randomUUID() },
    }),
    generateGrammarDrill: async (input) => {
      // Deterministic drill item per requested type. Includes the reference
      // model answer (the route strips it from the gen response). Lets the
      // /grammar-drill route test assert persistence + answer-stripping + the
      // type the rotation picked, without touching Anthropic.
      const common = {
        patternKey: input.patternKey,
        patternDisplay: input.patternDisplay,
        instruction: `Use ${input.patternDisplay}.`,
        referenceModelKr: '모델 답안입니다.',
        referenceModelEn: 'this is the model answer.',
      };
      const item =
        input.drillType === 'transformation'
          ? {
              ...common,
              type: 'transformation' as const,
              sourceKr: '기본 문장입니다.',
              sourceEn: 'this is the base sentence.',
            }
          : input.drillType === 'cloze'
            ? {
                ...common,
                type: 'cloze' as const,
                context: '상황 설명입니다.',
                seedKr: '문장에 ___ 들어갑니다.',
              }
            : {
                ...common,
                type: 'conversation' as const,
                scenario: '대화 상황입니다.',
                promptKr: '상대방의 말입니다.',
                promptEn: 'the interlocutor speaks.',
              };
      return { result: item, metadata: { ...baseMeta, requestId: randomUUID() } };
    },
    nameConversation: async (input) => ({
      // Deterministic content-derived title: echoes a fragment of the first
      // turn so route tests can assert the title came from CONTENT (F-036's
      // whole point — never "mode + date"). Bounded to the schema's 80 cap.
      result: {
        title: `Chat about ${input.history[0]!.content.slice(0, 40)}`.slice(0, 80),
      },
      metadata: { ...baseMeta, requestId: randomUUID() },
    }),
    scoreGrammarDrill: async (input) => {
      // Deterministic score, CONTROLLABLE per-test via a sentinel substring in
      // the learner's answer (diagnostic-upgrade Phase B needs both the
      // correct AND wrong grading paths testable without touching Anthropic —
      // the diagnostic writing branch and grammarDrill.ts's submit route both
      // exercise this same stub). Default (no sentinel) is the pre-existing
      // passing grade with one correction, unchanged for every existing
      // grammarDrill.ts test that doesn't use the sentinel.
      const isBad = input.userAnswer.includes('BAD_ANSWER_SENTINEL');
      return {
        result: isBad
          ? {
              score: 20,
              verdict: 'incorrect' as const,
              usesPattern: false,
              summary: 'mock score summary (needs work)',
              corrections: [
                { span: '___', issue: 'mock issue (bad)', fix: 'mock fix (bad)' },
              ],
            }
          : {
              score: 82,
              verdict: 'good' as const,
              usesPattern: true,
              summary: 'mock score summary',
              corrections: [
                { span: '___', issue: 'mock issue', fix: 'mock fix' },
              ],
            },
        metadata: { ...baseMeta, requestId: randomUUID() },
      };
    },
    generateWritingPrompt: async (input) => ({
      // Deterministic prompt per mode/rubric. Lets the /writing/generate route
      // test assert the wire shape without touching Anthropic. lengthHint is
      // present for topik mode and absent for general — exercising the route's
      // null coercion for the optional field.
      result:
        input.mode === 'topik'
          ? {
              promptKr: `모의 TOPIK 쓰기 과제입니다 (${input.rubric ?? 'topik_ii_54'}).`,
              promptEn: `mock TOPIK writing task (${input.rubric ?? 'topik_ii_54'}).`,
              lengthHint: (input.rubric ?? 'topik_ii_54') === 'topik_ii_53' ? '200-300자' : '600-700자',
            }
          : {
              promptKr: '모의 자유 글쓰기 주제입니다.',
              promptEn: 'mock free-write prompt.',
            },
      metadata: { ...baseMeta, requestId: randomUUID() },
    }),
    generateStory: async (input) => ({
      // Deterministic story echoing the requested level (+ topic when given).
      // Lets the /reading/generate route test assert persistence + the wire
      // shape without touching Anthropic. `turns` mirrors the F-210 prompt
      // groundwork (narrator + one character) so the route's JSONB persist +
      // DTO threading is exercised by default.
      result: {
        title: `모의 이야기 (${input.level})`,
        bodyKo:
          input.topic !== undefined
            ? `${input.topic}에 대한 모의 이야기입니다. 옛날 옛적에 이야기가 시작되었습니다.`
            : '모의 이야기입니다. 옛날 옛적에 이야기가 시작되었습니다.',
        turns: [
          { speaker: 'narrator', text: '옛날 옛적에 이야기가 시작되었습니다.', gender: 'narrator' as const },
          { speaker: '주인공', text: '"안녕하세요."', gender: 'female' as const },
        ],
      },
      metadata: { ...baseMeta, requestId: randomUUID() },
    }),
    generateStoryImagePrompts: async (input) => ({
      // Deterministic prompt set sized to the requested sceneCount — lets the
      // story-image runner tests assert per-scene generation + persistence
      // without touching Anthropic. Each scene prompt embeds the title so
      // tests can assert the story's own text reached the provider.
      result: {
        styleDirective:
          'Korean webtoon (manhwa) digital illustration style: clean expressive line art, soft cel shading',
        characters: [{ name: '주인공', description: 'a young woman in her 20s with short black hair' }],
        scenePrompts: Array.from(
          { length: input.sceneCount },
          (_, i) => `mock scene ${i + 1} prompt for ${input.title} — webtoon style, no text in image`,
        ),
      },
      metadata: { ...baseMeta, requestId: randomUUID() },
    }),
    generateReadingComprehension: async (input) => ({
      // Deterministic question set sized to the requested questionCount —
      // exactly 4 options, first one correct (the proxy Zod refine's
      // exactly-one-correct contract). The first stem embeds a prose
      // fragment so route tests can assert the chapter's own text reached
      // the generator.
      result: {
        questions: Array.from({ length: input.questionCount ?? 4 }, (_, i) => ({
          questionText:
            i === 0
              ? `이야기 질문 1: ${input.prose.slice(0, 30)}`
              : `이야기 질문 ${i + 1}: 무슨 일이 있었습니까?`,
          options: [
            { text: `정답 ${i + 1}`, correct: true },
            { text: `오답 ${i + 1}a`, correct: false },
            { text: `오답 ${i + 1}b`, correct: false },
            { text: `오답 ${i + 1}c`, correct: false },
          ],
          explanation: `정답은 "정답 ${i + 1}"입니다. Mock explanation ${i + 1}.`,
        })),
      },
      metadata: { ...baseMeta, requestId: randomUUID() },
    }),
    translatePassage: async (input) => ({
      // Deterministic mock translation echoing the source passage — lets the
      // /reading/translate route test assert the wire shape without touching
      // Anthropic.
      result: {
        translation: `[mock translation] ${input.passage}`,
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
  // The config schema requires PORT to be a positive integer. Supertest drives the
  // app in-process (it never calls listen()), so the value is unused at runtime —
  // but it must still pass validation. (Previously '0' threw "must be > 0", which
  // failed config parse for the whole single-fork test process.)
  process.env.PORT = '4000';
  process.env.DATABASE_URL = opts.connectionString;
  process.env.KIWI_URL = opts.kiwiUrl ?? 'http://kiwi.invalid/';
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';
  process.env.SESSION_COOKIE_NAME = 'km_sid';
  process.env.SESSION_LIFETIME_DAYS = '30';
  process.env.SESSION_IDLE_TIMEOUT_DAYS = '7';
  process.env.RATE_LIMIT_WINDOW_MS = '60000';
  process.env.RATE_LIMIT_CHEAP_MAX = '120';
  process.env.RATE_LIMIT_EXPENSIVE_MAX = '20';
  // Mirrors the production default (src/config/index.ts) — a full 30-item
  // diagnostic run alone makes 30 diagnosticLimiter-gated route-entry hits
  // (1 create + 29 /next calls, diagnostic-upgrade Phase C), so this must
  // stay above that floor with real headroom for retries/idempotent
  // re-serves within a single test.
  process.env.RATE_LIMIT_DIAGNOSTIC_MAX = '45';
  process.env.RATE_LIMIT_AUTH_MAX = '5';
  process.env.LOG_LEVEL = 'silent';
  // The route suite stubs the Claude proxy (`setClaudeProxy`/`makeStubProxy`)
  // so no test needs a REAL key — but a few call sites (diagnostic.ts's
  // `writingClaimTtlSeconds`, fix-pass 2 FIX A) read plain config knobs
  // (CLAUDE_TIMEOUT_MS / retry budget) straight off `services/claude/config`
  // via `loadConfig()`, which Zod-validates the WHOLE Claude env schema
  // together — including ANTHROPIC_API_KEY — even though nothing here ever
  // dials out. `??=` so a suite that wants to test the missing-key path
  // (none currently do via this helper) can still set its own value first.
  // Mirrors the same fake-but-schema-valid key `tests/services/claude/setup.ts`
  // already uses for the same reason.
  process.env.ANTHROPIC_API_KEY ??= 'sk-test-' + 'x'.repeat(30);
  // Pass Login: provision the fixed test AES key (so TOTP secrets encrypt/decrypt
  // deterministically) and default to the LEGACY single-step login so the
  // pre-existing auth tests keep their direct-session expectations. The MFA suite
  // flips mfaRequired on.
  process.env.TOTP_SECRET_ENC_KEY = TEST_TOTP_SECRET_ENC_KEY;
  // F-006: never let a host machine's SMTP env leak into tests — with
  // SMTP_HOST unset the mail module selects the log-only mock transport.
  delete process.env.SMTP_HOST;
  _setConfigForTesting({
    MFA_REQUIRED: opts.mfaRequired ?? false,
    REGISTRATION_ENABLED: opts.registrationEnabled ?? true,
    EMAIL_VERIFICATION_REQUIRED: opts.emailVerificationRequired ?? false,
  });

  // Capture the pool currently installed as the global so teardown can restore
  // it. Without this, an ephemeral per-test app's teardown (t.pool.end()) ends
  // the pool that is STILL the global _pool, breaking the shared suite app.
  const previousPool = getPoolForTesting();
  const pool = new Pool({ connectionString: opts.connectionString, max: 5 });
  setPoolForTesting(pool);

  // Capture the global proxy before replacing it, so teardown can restore it
  // (symmetric with previousPool) and an ephemeral failing-stub app cannot leak
  // its proxy into the shared suite app.
  const previousProxy = getClaudeProxyForTesting();
  resetClaudeProxyForTesting();
  setClaudeProxy(makeStubProxy(opts.claudeProxy));

  resetLimiters();
  resetKrdictReadyCache();
  // Drop any cached mail transport so this app re-selects from the CURRENT
  // config (always the mock here — SMTP_HOST cleared above). A test that
  // installs a capture transport does so AFTER building its app.
  _resetMailTransportForTesting();
  // Re-derive the AES key from the (possibly overridden) test config so a prior
  // test's key never leaks into this app instance.
  _resetEncryptionKeyForTesting();

  const app = createApp();
  return { app, pool, previousPool, previousProxy };
}

export async function teardownTestApp(t: TestApp): Promise<void> {
  // Restore the global pool + Claude proxy to whatever was installed before
  // this app, so the shared suite app keeps working after an ephemeral per-test
  // app is torn down. Only restore if WE are still the active pool (defends
  // against out-of-order teardown). Then end our own pool.
  if (t.previousPool && getPoolForTesting() === t.pool) {
    setPoolForTesting(t.previousPool);
  }
  if (t.previousProxy) {
    setClaudeProxy(t.previousProxy);
  }
  await t.pool.end().catch(() => undefined);
}
