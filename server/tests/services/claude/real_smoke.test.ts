/**
 * Real-Claude smoke test (OPT-IN — never runs in CI by default).
 *
 * Exercises the Claude proxy methods against the LIVE Anthropic API, with
 * in-memory cache/usage stores so NO Postgres is needed. This is the only
 * verification of the proxy's prompt builders + parsers + Zod output schemas
 * against real model output — the route integration tests (Docker-gated) stub
 * the proxy, so they never hit a real builder/parser round-trip.
 *
 * Run:
 *   set -a; . ./.env; set +a            # loads ANTHROPIC_API_KEY (gitignored)
 *   ANTHROPIC_SMOKE=1 LOG_LEVEL=error npx vitest run tests/services/claude/real_smoke.test.ts
 *
 * Skipped unless ANTHROPIC_SMOKE=1 so a normal `vitest run` (and CI) never
 * spends tokens or requires network. Costs a handful of small calls.
 */
import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';

import { createClaudeProxy } from '../../../src/services/claude';
import { InMemoryCacheStore } from '../../../src/services/claude/cache';
import { InMemoryUsageStore } from '../../../src/services/claude/usage';
import type { RouteName } from '../../../src/services/claude/config';

const RUN = process.env.ANTHROPIC_SMOKE === '1';

// Permissive limiter — the smoke makes a few calls; no need to bucket them.
const noopLimiter = { consume: (_route: RouteName, _key: string): void => {} };

function makeProxy(): ReturnType<typeof createClaudeProxy> {
  return createClaudeProxy({
    // pool is never dereferenced because cache + usage are injected.
    pool: undefined as unknown as Pool,
    cache: new InMemoryCacheStore(),
    usage: new InMemoryUsageStore(),
    rateLimiter: noopLimiter,
  });
}

// 30s per call — Claude can be slow on a cold path; default vitest timeout is 5s.
const T = 30_000;

describe.skipIf(!RUN)('real Claude smoke', () => {
  const proxy = makeProxy();

  it('enrich → valid EnrichmentResult', async () => {
    const { result, metadata } = await proxy.enrich({
      lemma: '먹다',
      sourceSentence: '엄마가 만든 음식을 맛있게 먹었어요.',
    });
    expect(result.nuance.length).toBeGreaterThan(0);
    expect(Array.isArray(result.examples)).toBe(true);
    expect(result.proficiency).toBeTruthy();
    expect(metadata.model).toContain('claude');
    // eslint-disable-next-line no-console
    console.log('[enrich]', result.proficiency, '·', result.examples.length, 'examples');
  }, T);

  it('recognizeGrammarPattern → valid PatternResult', async () => {
    const { result } = await proxy.recognizeGrammarPattern({
      highlightSpan: '-더라도',
      fullSentence: '그 의견이 일리가 있더라도 우리는 일정대로 진행해야 한다.',
    });
    expect(result.patternKey.length).toBeGreaterThan(0);
    expect(result.meaning.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log('[recognize]', result.patternKey, '·', result.patternName);
  }, T);

  it('gradeWriting → valid GradeResult (verifies the max_score remap fix)', async () => {
    const { result } = await proxy.gradeWriting({
      rubric: 'topik_ii_54',
      sample:
        '현대 사회에서 인공지능의 발전은 우리의 삶을 크게 바꾸고 있다. 한편으로는 편리함을 주지만, ' +
        '다른 한편으로는 일자리 감소라는 문제를 낳는다. 따라서 우리는 기술의 혜택을 누리면서도 ' +
        '그 부작용에 대비하는 균형 잡힌 태도를 가져야 한다고 생각한다.',
    });
    // The bug this guards: nested dimensions must carry maxScore (camelCase),
    // not the tool's snake_case max_score. If the remap regressed, the proxy
    // would throw ClaudeOutputSchemaError before returning.
    expect(result.content.maxScore).toBeGreaterThan(0);
    expect(result.organization.maxScore).toBeGreaterThan(0);
    expect(result.languageUse.maxScore).toBeGreaterThan(0);
    expect(result.totalScore).toBeGreaterThanOrEqual(0);
    expect(result.estimatedLevel).toBeTruthy();
    // eslint-disable-next-line no-console
    console.log('[gradeWriting]', result.totalScore, '/', result.maxTotal, '→', result.estimatedLevel);
  }, 90_000); // grading a full essay against the rubric with tool-use is the slowest call

  it('generateGrammarDrill → scoreGrammarDrill round-trip (P9, cloze)', async () => {
    const item = (
      await proxy.generateGrammarDrill({
        patternKey: 'GR-deorado',
        patternDisplay: '-더라도',
        meaning: 'even if / even though',
        drillType: 'cloze',
      })
    ).result;
    expect(item.type).toBe('cloze');
    expect(item.referenceModelKr.length).toBeGreaterThan(0);
    // Build the prompt text the route would reconstruct for a cloze drill.
    const promptText =
      item.type === 'cloze' ? `${item.context}\n${item.seedKr}` : item.instruction;

    const score = (
      await proxy.scoreGrammarDrill({
        drillType: 'cloze',
        patternDisplay: '-더라도',
        promptText,
        referenceModelKr: item.referenceModelKr,
        userAnswer: '그 일이 아무리 힘들더라도 저는 끝까지 해내겠습니다.',
      })
    ).result;
    expect(score.score).toBeGreaterThanOrEqual(0);
    expect(score.score).toBeLessThanOrEqual(100);
    expect(typeof score.usesPattern).toBe('boolean');
    expect(score.verdict).toBeTruthy();
    // eslint-disable-next-line no-console
    console.log('[drill]', item.type, '· score', score.score, '· verdict', score.verdict);
  }, T);
});
