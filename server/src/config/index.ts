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

/**
 * Strict string-boolean env parser.
 *
 * `z.coerce.boolean()` runs JS `Boolean(value)`, so the STRING "false" coerces
 * to `true` — an operator setting `FLAG=false` in a compose file would silently
 * get `true`. That is unacceptable for flags whose whole purpose is to be an
 * operator kill-switch (REGISTRATION_ENABLED, MFA_REQUIRED,
 * EMAIL_VERIFICATION_REQUIRED), so EVERY boolean flag uses this parser:
 * explicit truthy/falsy string sets, anything else fails config parse at
 * startup. `z.coerce.boolean()` is BANNED in this schema — the deploy compose
 * passes `REGISTRATION_ENABLED=false` as a string, and under coercion that
 * string re-opened production self-signup (F-006 fix-pass B1). Config tests
 * (tests/config.test.ts) pin the `"false"` → false behavior for each flag.
 */
function envBool(defaultValue: boolean) {
  return z.preprocess(
    (v) => {
      if (v === undefined || v === null || v === '') return defaultValue;
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(s)) return true;
        if (['false', '0', 'no', 'off'].includes(s)) return false;
      }
      return v; // fall through to z.boolean() → parse error (fail fast)
    },
    z.boolean(),
  );
}

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

  // Book-upload blob store (U1a — book-upload feature, page-image model).
  // Mirrors IMAGE_STORAGE_DIR's contract exactly: a filesystem root under
  // which each uploaded book's PAGE IMAGES are stored as
  // `{userId}/{uuid}.{jpg|png}` (one per book_pages row) — the original
  // zip/PDF a user uploads is normalized into pages and then discarded, never
  // itself stored. Only the RELATIVE path is kept in Postgres
  // (book_pages.blob_ref). Separate root from images (different content,
  // different retention story) but the identical save/read/traversal-guard
  // mechanism — see server/src/services/uploadStore.ts.
  BOOK_UPLOAD_STORAGE_DIR: z.string().min(1).default('./var/book-uploads'),

  // Per-user DAILY cap on book uploads. This is a personal single-user app
  // expecting a HANDFUL of books ever (~10) — the cap exists purely as an
  // abuse/runaway-script backstop, not a meaningful usage limit, so it is set
  // generously relative to expected real use. Re-uploading an EXISTING title
  // (idempotent replace) does not consume budget — only a brand-new title
  // creates a new row that counts toward this cap.
  BOOK_UPLOAD_DAILY_CAP: z.coerce.number().int().positive().default(10),

  // Per-user DAILY cap on extraction-OCR PAGES (F-108 — U2 extraction). Each
  // page in an extraction run is one Claude Vision call, so this — not a
  // per-run count — is the cost lever. Exceeding it returns 429 BEFORE any
  // upstream call (mirrors IMAGE_OCR_DAILY_CAP's posture; separate knob
  // because a book-extraction session legitimately burns more Vision calls
  // than casual photo mining). Failed runs still count: the cap is a COST
  // control and a failed run spent money too.
  UPLOAD_EXTRACT_DAILY_PAGE_CAP: z.coerce.number().int().positive().default(50),

  // Corpus audio root (F-012 — TTMIK/Iyagi mp3 streaming). Read-only tree the
  // audio routes stream from; DB rows store paths RELATIVE to this root (e.g.
  // 'TTMIK/이야기들/이야기/143 TTMIK Iyagi 143.mp3'). In the deploy compose this
  // is a `:ro` bind mount at /corpus; the default matches that mount so prod
  // needs no extra env. A missing dir is not a startup error — audio requests
  // simply 404 until the mount exists (routes/ttmik.ts owns the containment
  // check that keeps every resolved path inside this root).
  CORPUS_AUDIO_DIR: z.string().min(1).default('/corpus'),

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
  // Strict envBool: the compose files pass the STRING "false", which
  // z.coerce.boolean() silently parsed as true — leaving self-signup OPEN in
  // prod and re-arming the register-409 enumeration oracle (F-006 B1).
  REGISTRATION_ENABLED: envBool(true),

  // Mandatory-MFA enforcement (D1). Default true: every login needs a confirmed
  // TOTP, and a user without one is forced into enrollment before a session is
  // issued. Legacy/test flows that want the old direct-session behavior set
  // this false. Strict envBool — same landmine as REGISTRATION_ENABLED above.
  MFA_REQUIRED: envBool(true),

  // Per-account TOTP lockout (B-LOCK). N consecutive bad codes → locked for
  // TOTP_LOCKOUT_MINUTES. The IP authLimiter is the other half of the defense.
  TOTP_MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().default(5),
  TOTP_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  // Pending login-challenge TTL (D2). Short by design — a stolen challenge token
  // is useless after this window.
  MFA_CHALLENGE_TTL_SEC: z.coerce.number().int().positive().default(300),

  // Number of single-use recovery codes minted at enrollment-confirm / regenerate.
  RECOVERY_CODE_COUNT: z.coerce.number().int().positive().default(10),

  // ---------------------------------------------------------------------------
  // Email verification (F-006). See server SECURITY.md §19 +
  // docs/BUILD_f006_email_verification.md.
  // ---------------------------------------------------------------------------
  // The login gate: an unverified account cannot complete a password login
  // (typed `email_unverified` response). Default ON (email verification is a
  // standing deploy priority); this flag is the operator kill-switch if mail
  // delivery breaks — flipping it to false changes NOTHING else about auth.
  // Uses the strict envBool parser so `EMAIL_VERIFICATION_REQUIRED=false` in a
  // compose file actually disables it (see envBool's header).
  EMAIL_VERIFICATION_REQUIRED: envBool(true),

  // Verification-token lifetime. Short by design — the link is single-use and
  // a resend is one click, so a stolen mailbox backlog goes stale quickly.
  EMAIL_VERIFICATION_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(24),

  // Per-USER resend cooldown, enforced DB-side (latest token created_at).
  // This — not the per-IP limiter — is the real mail-bomb gate: the resend
  // endpoint always returns a generic 200 (no user enumeration), and the auth
  // limiter's skipSuccessfulRequests would therefore never count it.
  EMAIL_VERIFICATION_RESEND_COOLDOWN_SEC: z.coerce.number().int().positive().default(60),

  // ---------------------------------------------------------------------------
  // Mail transport (F-006) — provider-agnostic SMTP, NEVER a hardcoded vendor.
  // Unset SMTP_HOST ⇒ the mock/log transport (dev + tests): the message is
  // logged (including the verification URL — the dev escape hatch) and nothing
  // is sent. In production these point at Proton Mail Bridge's local SMTP
  // (127.0.0.1:1025, STARTTLS, per-Bridge credentials) — but nothing here
  // knows or cares that it's Proton; any SMTP relay works.
  // ---------------------------------------------------------------------------
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().max(65_535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  // RFC 5322 From. Required whenever SMTP_HOST is set (refined below) — the
  // sending domain's SPF/DKIM/DMARC must authorize this address or receivers
  // will spam-folder the mail (deploy note in BUILD_f006).
  SMTP_FROM: z.string().min(3).optional(),
  // true = implicit TLS (usually port 465); false = plaintext + STARTTLS
  // upgrade (587 / Proton Bridge's 1025). Strict parser — see envBool.
  SMTP_SECURE: envBool(false),
  // Proton Bridge presents a self-signed certificate on loopback; the operator
  // sets this false ONLY for such a localhost relay. Default true — never
  // silently accept a bad cert on a real network path.
  SMTP_TLS_REJECT_UNAUTHORIZED: envBool(true),

  // CORS
  CLIENT_ORIGIN: z.string().min(1, 'CLIENT_ORIGIN is required (e.g. https://app.example.com)'),

  // Rate limits (per window per IP)
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_CHEAP_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_EXPENSIVE_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
  // Audio streaming: one listening session fires many Range requests (each seek
  // = several partials), so audio gets its OWN, higher, per-user bucket rather
  // than sharing the cheap per-IP one (which it would exhaust, 429-ing unrelated
  // JSON calls). See mediaLimiter in middleware/rateLimits.
  RATE_LIMIT_MEDIA_MAX: z.coerce.number().int().positive().default(600),

  // Logging
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
}).superRefine((cfg, ctx) => {
  // A configured SMTP relay without a From address would fail on the first
  // send, at request time. Fail at startup instead (SECURITY.md §1 posture:
  // bad config is a deploy-time problem).
  if (cfg.SMTP_HOST && !cfg.SMTP_FROM) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SMTP_FROM'],
      message: 'SMTP_FROM is required when SMTP_HOST is set',
    });
  }
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
  // Re-parse process.env FRESH rather than reusing a previously-cached _config.
  // buildTestApp mutates process.env (KIWI_URL, rate-limit knobs, etc.) right
  // before calling this; reusing a stale _config as the base silently dropped
  // those new values (e.g. a per-test app pointed at a fake Kiwi server would
  // keep talking to the previous suite's KIWI_URL). The schema is still the
  // single source of truth — env flows through validation — and the explicit
  // overrides win on top.
  const base = EnvSchema.parse(process.env);
  _config = { ...base, ...overrides };
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
