/**
 * Server configuration.
 *
 * 12-factor — every setting comes from an environment variable.
 * Loaded once at startup; Zod parses + validates + types the values.
 *
 * Secrets policy (SECURITY.md §1): no defaults for secrets, the parser throws
 * if they are absent. Connection strings are masked when logged.
 */
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),

  // Postgres
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required (postgres://user:pass@host:5432/db)'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(5000),

  // External services
  KIWI_URL: z.string().url(),
  CLAUDE_PROXY_URL: z.string().url().optional(),

  // Session / cookie
  SESSION_COOKIE_NAME: z.string().default('km_sid'),
  SESSION_LIFETIME_DAYS: z.coerce.number().int().positive().default(30),
  SESSION_IDLE_TIMEOUT_DAYS: z.coerce.number().int().positive().default(7),

  // CORS
  CLIENT_ORIGIN: z.string().min(1, 'CLIENT_ORIGIN is required (e.g. https://app.example.com)'),

  // Rate limits (per window per IP)
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_CHEAP_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_EXPENSIVE_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),

  // Logging
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export type Config = z.infer<typeof EnvSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Fail fast — bad config is a deploy-time problem, not a request-time one.
    // We write to stderr because the logger isn't constructed yet.
    // eslint-disable-next-line no-console
    console.error('Invalid configuration:\n' + parsed.error.toString());
    throw new Error('Invalid configuration. See stderr for details.');
  }
  _config = parsed.data;
  return _config;
}

/**
 * Test-only override. Reset via `resetConfig()` between tests.
 */
export function _setConfigForTesting(overrides: Partial<Config>): Config {
  const base = _config ?? EnvSchema.parse(process.env);
  _config = { ...base, ...overrides };
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
