/**
 * Structured logging.
 *
 * Pino is fast, JSON-by-default, and supports child loggers — we use a child
 * with the correlation ID for every request. Senior-bar §"Logging" says:
 *   - No PII or secrets in logs.
 *   - Correlation IDs through every request.
 *   - INFO for milestones, DEBUG only in dev.
 */
import pino, { type Logger } from 'pino';
import { loadConfig } from './config/index.js';

let _logger: Logger | null = null;

export function getLogger(): Logger {
  if (_logger) return _logger;
  const cfg = loadConfig();
  _logger = pino({
    level: cfg.LOG_LEVEL,
    // Redact common secret-bearing fields so a misplaced object cannot leak
    // a token. Bar §"Logging" — explicit defense.
    redact: {
      paths: [
        'password',
        '*.password',
        'password_hash',
        '*.password_hash',
        'token',
        '*.token',
        'cookie',
        '*.cookie',
        'authorization',
        '*.authorization',
        'req.headers.cookie',
        'req.headers.authorization',
      ],
      remove: true,
    },
    base: {
      service: 'korean-master-api',
      env: cfg.NODE_ENV,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  return _logger;
}

export function setLoggerForTesting(l: Logger): void {
  _logger = l;
}
