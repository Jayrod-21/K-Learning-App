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

  // Image blob store (Pass 8 — Images screen). Filesystem root under which
  // uploaded photos are stored as `{userId}/{uuid}.{ext}`. Relative paths are
  // resolved against the process CWD. Durable/offsite (S3) is deferred — see
  // SECURITY.md §16. Default keeps local dev zero-config.
  IMAGE_STORAGE_DIR: z.string().min(1).default('./var/images'),

  // Per-user DAILY cap on image-OCR uploads (the Vision-cost lever). Exceeding
  // it returns 429 before any upstream call. See SECURITY.md §16.
  IMAGE_OCR_DAILY_CAP: z.coerce.number().int().positive().default(20),

  // Session / cookie
  SESSION_COOKIE_NAME: z.string().default('km_sid'),
  SESSION_LIFETIME_DAYS: z.coerce.number().int().positive().default(30),
  SESSION_IDLE_TIMEOUT_DAYS: z.coerce.number().int().positive().default(7),

  // ---------------------------------------------------------------------------
  // Auth — login + TOTP 2FA (Pass Login). See PASS_LOGIN_CONTRACT B5.
  // ---------------------------------------------------------------------------
  // AES-256-GCM key for encrypting the TOTP factor secret at rest
  // (user_totp.secret_encrypted). REQUIRED — there is no default for a secret
  // (SECURITY.md §1). Must base64-decode to EXACTLY 32 bytes; we validate the
  // length here so a misconfigured key fails at startup, not on first enroll.
  // Generate with: `openssl rand -base64 32`. NEVER commit a real key.
  TOTP_SECRET_ENC_KEY: z
    .string()
    .min(1, 'TOTP_SECRET_ENC_KEY is required (base64 of 32 random bytes; `openssl rand -base64 32`)')
    .refine(
      (v) => {
        try {
          return Buffer.from(v, 'base64').length === 32;
        } catch {
          return false;
        }
      },
      { message: 'TOTP_SECRET_ENC_KEY must base64-decode to exactly 32 bytes' },
    ),

  // Registration gate. MUST be false in production (single-user app, seeded via
  // the seed-user CLI). Default true keeps dev/test self-service registration.
  REGISTRATION_ENABLED: z.coerce.boolean().default(true),

  // Mandatory-MFA enforcement (D1). Default true: every login needs a confirmed
  // TOTP, and a user without one is forced into enrollment before a session is
  // issued. Legacy/test flows that want the old direct-session behavior set
  // this false.
  MFA_REQUIRED: z.coerce.boolean().default(true),

  // Per-account TOTP lockout (B-LOCK). N consecutive bad codes → locked for
  // TOTP_LOCKOUT_MINUTES. The IP authLimiter is the other half of the defense.
  TOTP_MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().default(5),
  TOTP_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  // Pending login-challenge TTL (D2). Short by design — a stolen challenge token
  // is useless after this window.
  MFA_CHALLENGE_TTL_SEC: z.coerce.number().int().positive().default(300),

  // Number of single-use recovery codes minted at enrollment-confirm / regenerate.
  RECOVERY_CODE_COUNT: z.coerce.number().int().positive().default(10),

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
 * A fixed, well-known 32-byte AES key for tests ONLY. base64 of 32 bytes
 * (0x00..0x1f). This is NOT a secret — it exists so the test suite can encrypt/
 * decrypt TOTP secrets deterministically without provisioning a key. It MUST
 * NEVER be used outside tests; production loads TOTP_SECRET_ENC_KEY from the env
 * with no default (a missing key fails config parse at startup).
 */
export const TEST_TOTP_SECRET_ENC_KEY =
  Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64');

/**
 * Test-only override. Reset via `resetConfig()` between tests.
 *
 * Ensures a valid TOTP_SECRET_ENC_KEY is present before the base config is
 * parsed from `process.env`: tests don't provision a real key, so we inject the
 * fixed test key when the env lacks one. This keeps the single source of truth
 * (the Zod schema) — the key still flows through validation — while letting
 * every existing test build a valid config.
 */
export function _setConfigForTesting(overrides: Partial<Config>): Config {
  if (!process.env.TOTP_SECRET_ENC_KEY) {
    process.env.TOTP_SECRET_ENC_KEY = TEST_TOTP_SECRET_ENC_KEY;
  }
  const base = _config ?? EnvSchema.parse(process.env);
  _config = { ...base, ...overrides };
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
