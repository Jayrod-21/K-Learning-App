/**
 * Pino logger for the Claude proxy module.
 *
 * Why this file: we want one logger instance per module child so log
 * lines are tagged `module: 'claude'` and downstream filtering is
 * trivial. We also pre-configure redaction so the API key and any
 * field accidentally named `apiKey` / `authorization` is replaced
 * with `[REDACTED]` before serialization.
 *
 * If the consumer (B3) has its own root logger, it can pass it as
 * `parent` and we'll child-bind from it instead — keeps a single log
 * stream end-to-end. Otherwise we create a standalone instance.
 */

import pino, { type Logger, type LoggerOptions } from 'pino';
import { loadConfig } from './config';

const REDACT_PATHS = [
  // Top-level secrets
  'apiKey',
  'api_key',
  'authorization',
  'Authorization',
  'ANTHROPIC_API_KEY',
  'password',
  'password_hash',
  // Nested SDK error shapes (anthropic SDK puts headers under .response.headers)
  '*.apiKey',
  '*.api_key',
  '*.authorization',
  '*.Authorization',
  'headers.authorization',
  'headers.Authorization',
  'response.headers.authorization',
  'response.headers.Authorization',
  'request.headers.authorization',
  'request.headers.Authorization',
];

let cached: Logger | null = null;

export function getLogger(parent?: Logger): Logger {
  if (parent) {
    return parent.child({ module: 'claude' });
  }
  if (cached !== null) {
    return cached;
  }
  const cfg = loadConfig();
  const opts: LoggerOptions = {
    name: 'claude-proxy',
    level: cfg.logLevel,
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
      remove: false,
    },
    base: {
      module: 'claude',
      env: cfg.nodeEnv,
    },
    // In test we want quiet structured output; in dev pretty-print is nice
    // but we don't add the dep here. Consumers can pipe to pino-pretty.
    formatters: {
      level: (label) => ({ level: label }),
    },
  };
  cached = pino(opts);
  return cached;
}

/** Test-only: reset the memoized logger. */
export function __resetLoggerForTests(): void {
  cached = null;
}
