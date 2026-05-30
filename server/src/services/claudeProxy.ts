/**
 * Claude proxy adapter — thin re-export over B4's module.
 *
 * B4 owns `src/services/claude/*`. Everything outside that tree imports
 * the proxy through THIS file so that:
 *   1. The route handlers stay decoupled from B4's internal structure.
 *   2. Tests can swap the proxy with a mock via setClaudeProxy().
 *   3. If we ever replace the Anthropic backend wholesale, only this
 *      file changes.
 *
 * Bar: "B4 module is invoked, not the Anthropic API directly" —
 * we never import `@anthropic-ai/sdk` here.
 */
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { createClaudeProxy as createClaudeProxyImpl } from './claude/index.js';
import type {
  ClaudeProxy,
  DiagnosticItemInput,
  DiagnosticItemResult,
  DrillType,
  DrillVerdict,
  EnrichmentInput,
  EnrichmentResult,
  GrammarDrillGenInput,
  GrammarDrillItem,
  GrammarDrillScore,
  GrammarDrillScoreInput,
  GrammarRecognitionInput,
  GradeInput,
  GradeResult,
  ImageOcrInput,
  ImageOcrResult,
  ImageOcrWord,
  PatternResult,
  ProxyResult,
} from './claude/index.js';

export type {
  ClaudeProxy,
  DiagnosticItemInput,
  DiagnosticItemResult,
  DrillType,
  DrillVerdict,
  EnrichmentInput,
  EnrichmentResult,
  GrammarDrillGenInput,
  GrammarDrillItem,
  GrammarDrillScore,
  GrammarDrillScoreInput,
  GrammarRecognitionInput,
  GradeInput,
  GradeResult,
  ImageOcrInput,
  ImageOcrResult,
  ImageOcrWord,
  PatternResult,
  ProxyResult,
};

let _proxy: ClaudeProxy | null = null;

/**
 * Build and install the proxy. Server startup calls this once; tests call
 * it with a mock implementation.
 */
export function setClaudeProxy(proxy: ClaudeProxy): void {
  _proxy = proxy;
}

/**
 * Construct the real proxy bound to the given pool and (optionally) logger.
 */
export function buildClaudeProxy(deps: { pool: Pool; logger?: Logger }): ClaudeProxy {
  return createClaudeProxyImpl(
    deps.logger ? { pool: deps.pool, logger: deps.logger } : { pool: deps.pool },
  );
}

export function getClaudeProxy(): ClaudeProxy {
  if (_proxy) return _proxy;
  throw new Error(
    'Claude proxy not configured. Call setClaudeProxy(buildClaudeProxy(...)) at startup.',
  );
}

export function resetClaudeProxyForTesting(): void {
  _proxy = null;
}

// Convenience for tests that want to install the real proxy.
export { createClaudeProxyImpl as createClaudeProxy };
