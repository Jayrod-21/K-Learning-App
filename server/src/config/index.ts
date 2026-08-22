/**
 * Server configuration.
 *
 * 12-factor — every setting comes from an environment variable.
 * Loaded once at startup; Zod parses + validates + types the values.
 *
 * Secrets policy (SECURITY.md §1): no defaults for secrets, the parser throws
 * if they are absent. Connection strings are masked when logged.
 */
import { readFileSync } from 'node:fs';
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

  // Audio-upload blob store (Track A, A-3 — user-uploaded audio → Whisper).
  // Mirrors BOOK_UPLOAD_STORAGE_DIR's contract exactly: a filesystem root
  // under which each uploaded track's bytes are stored as
  // `{userId}/{uuid}.{mp3|m4a}` (one per audio_tracks row); only the RELATIVE
  // path is kept in Postgres (audio_tracks.blob_ref, migration 074). Separate
  // root + module from book pages (different content, size class, and
  // consumer — the km-worker Whisper container mounts THIS root read-only;
  // see server/src/services/audioStore.ts). In the deploy compose this is the
  // shared km_audio_uploads volume, mounted rw here and ro on the worker.
  AUDIO_UPLOAD_STORAGE_DIR: z.string().min(1).default('./var/audio-uploads'),

  // Per-FILE byte cap on a single audio upload (→ 413). 100 MiB comfortably
  // covers the corpus's largest real tracks (a 30-min 320kbps mp3 ≈ 72 MB)
  // while bounding multer's in-memory buffering per request.
  AUDIO_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),

  // Per-user DAILY cap on ENQUEUED transcription bytes (→ 429 BEFORE any
  // write). Every enqueued byte is a Whisper-CPU commitment on the worker, so
  // this — not upload count — is the cost lever (mirrors
  // UPLOAD_EXTRACT_DAILY_PAGE_CAP's posture; the ledger is
  // audio_transcription_jobs.charged_bytes, which survives track deletion —
  // migration 076 — so deleting uploads never refunds the budget). 500 MiB/day
  // ≈ a handful of hour-long files: generous for real personal use, a hard
  // wall for a runaway script.
  AUDIO_TRANSCRIBE_DAILY_BYTES_CAP: z.coerce
    .number()
    .int()
    .positive()
    .default(500 * 1024 * 1024),

  // Per-user DAILY cap on the NUMBER of audio uploads (→ 429 BEFORE any
  // write). The bytes cap above bounds Whisper-CPU cost but not ROW count: a
  // tiny-file flood (the sniff accepts a 2-byte MPEG header) would create
  // unbounded sources/tracks/pending jobs — each of which the worker must
  // claim, spawn Whisper for, and settle — while barely denting the bytes
  // budget. This is the same backstop BOOK_UPLOAD_DAILY_CAP provides for the
  // book route: generous for real personal use (50 files/day), a hard wall
  // for a runaway script. Checked in the SAME advisory-locked SELECT as the
  // bytes cap (routes/audio.ts) so neither cap can be raced past.
  AUDIO_UPLOAD_DAILY_COUNT_CAP: z.coerce.number().int().positive().default(50),

  // ---------------------------------------------------------------------------
  // Story TTS (F-210 — voice a generated story via ElevenLabs). The synthesized
  // mp3 lands in the SAME audio blob store as user uploads
  // (AUDIO_UPLOAD_STORAGE_DIR above) and streams through the existing
  // /audio/tracks/:id/stream route — no new storage or streaming knobs.
  // ---------------------------------------------------------------------------
  // ElevenLabs API key. OPTIONAL in EVERY environment — including production
  // — so story TTS can ship DORMANT without coupling unrelated deploys to a
  // vendor key: with no key the app boots normally, the routes answer
  // `ttsConfigured: false`, the enqueue POST refuses with 503
  // `tts_unavailable` before writing a job, and the keyless provider fails
  // any in-flight job with a clear "not configured" message
  // (services/tts.ts). Going live later is a Deploy/.env edit + redeploy —
  // zero code change. index.ts logs a startup warning when the key is
  // absent so a deploy that MEANT to enable TTS is diagnosable at boot.
  // Secrets policy (SECURITY.md §1): no default, and the value is never
  // logged (services/tts.ts never places it anywhere but the request
  // header). EMPTY STRING ⇒ unset: the deploy compose passes
  // `ELEVENLABS_API_KEY=${ELEVENLABS_API_KEY:-}` so the plumbing exists
  // before the key does, and docker substitutes '' while Deploy/.env leaves
  // the value blank — that must read as "dormant", never a parse failure.
  ELEVENLABS_API_KEY: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(1).optional(),
  ),

  // The ElevenLabs voice used for the v1 single-narrator read. Default is the
  // ElevenLabs premade "Rachel" voice id — multilingual-capable and present on
  // every account; the operator swaps in a preferred Korean narrator voice id
  // without a code change. (Multi-voice per `turns` is v2 — it will map
  // speakers to voice ids on top of this same provider.) Empty string ⇒ the
  // default (compose passes `${ELEVENLABS_VOICE_ID:-}` — see the key above).
  ELEVENLABS_VOICE_ID: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(1).default('21m00Tcm4TlvDq8ikWAM'),
  ),

  // Per-user DAILY cap on story-TTS ENQUEUES (→ 429 BEFORE any job row is
  // written). TTS bills per character, but a per-JOB cap is the right lever
  // here because a story body is already hard-bounded (StoryResultSchema caps
  // bodyKo at 6000 chars), so jobs/day × 6000 bounds spend; the
  // story_audio_jobs.char_count ledger still records exact usage. Failed jobs
  // count (cost control — a failed run spent quota too; 069/076's stance).
  STORY_TTS_DAILY_CAP: z.coerce.number().int().positive().default(10),

  // How often the in-server runner polls story_audio_jobs for pending work.
  // In-process (NOT the km-worker — it mounts the audio volume read-only):
  // the interval is unref'd so it never holds the process open.
  STORY_TTS_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),

  // A 'running' job older than this is presumed crashed (server restart
  // mid-synthesis) and reaped 'failed' at the next poll, un-bricking the
  // story's one-live-job slot. Sized well past the longest plausible
  // synthesis of a 6000-char body (uploadExtract.ts's STALE_RUN_MINUTES
  // posture; 'pending' is never reaped — it is the healthy backlog).
  STORY_TTS_STALE_RUN_MINUTES: z.coerce.number().int().positive().default(15),

  // ---------------------------------------------------------------------------
  // Blue/green runner gating (audit §7.2 / Phase 1.3). `index.ts` starts BOTH
  // the story-TTS and story-illustration runners UNCONDITIONALLY, in BOTH
  // colors — the stale-reap half of each tick is time-based and harmless to
  // run everywhere, but the claim+process half must run in only ONE color at
  // a time: otherwise the idle color quietly processes live jobs with the
  // PREVIOUS release's code (SKIP LOCKED keeps that from corrupting
  // anything, but it makes WHICH code served a job unpredictable). See
  // `isRunnerActiveColor` below for the mechanism.
  // ---------------------------------------------------------------------------
  // Manual kill switch, layered UNDER the automatic active-color check below.
  // Default true so any deployment that doesn't opt into DEPLOY_COLOR (local
  // dev, tests, a hypothetical single-color deploy) behaves exactly as
  // before — this flag exists for an operator who wants to force runners off
  // everywhere regardless of color (e.g. draining the queue during an
  // incident), not as the everyday gating mechanism.
  STORY_RUNNERS_ENABLED: envBool(true),

  // Which color THIS container is. Fixed for the container's lifetime — set
  // once per compose file (Deploy/docker-compose.{blue,green}.yml), the same
  // way PGAPPNAME/KIWI_URL are already hardcoded per color. Unset in every
  // non-blue/green context (local dev, tests), which is exactly the signal
  // `isRunnerActiveColor` uses to fail open.
  DEPLOY_COLOR: z.enum(['blue', 'green']).optional(),

  // Where to read the CURRENTLY active color from. A promotion
  // (azure-switch-production.sh) is a pure nginx reload with NO container
  // restart — that is what makes rollback a single reload — so which color
  // is active can change without this process ever reloading its config.
  // `loadConfig()` caches once at boot, so that fact cannot live on the
  // cached `Config`; it must be re-read from disk on every check instead.
  // azure-switch-production.sh rewrites this file atomically the moment a
  // switch's post-flip health check passes, mirroring how it already
  // persists ACTIVE_ENVIRONMENT into Deploy/.env. The default path lives
  // INSIDE a dedicated bind-mounted DIRECTORY, not a file mounted directly —
  // a single-file bind mount pins the container to the inode present at
  // container start, so it would never observe the atomic rename this file
  // is rewritten with; mounting the enclosing directory makes that rename
  // visible with no container restart. Bind-mounted read-only into both
  // colors' containers (NOT the secrets-bearing .env itself — this
  // directory holds nothing but a color name).
  ACTIVE_COLOR_FILE: z.string().min(1).default('/app/deploy/active-color.d/active-color'),

  // ---------------------------------------------------------------------------
  // Story illustrations (F-211 — AI images for generated stories, OpenAI
  // gpt-image-1). The generated images land in the SAME image blob store as
  // OCR uploads (IMAGE_STORAGE_DIR above) and serve through a byte route on
  // /reading — no new storage or nginx knobs.
  // ---------------------------------------------------------------------------
  // OpenAI API key. OPTIONAL in EVERY environment — including production — so
  // story illustrations can ship DORMANT without coupling unrelated deploys
  // to a vendor key: with no key the app boots normally, the routes answer
  // `imageGenConfigured: false`, the enqueue POST refuses with 503
  // `image_gen_unavailable` before writing a job, POST /reading/generate
  // skips the batch-at-creation enqueue, and the keyless provider fails any
  // in-flight job with a clear "not configured" message
  // (services/imageGen.ts). Going live later is a Deploy/.env edit +
  // redeploy — zero code change. index.ts logs a startup warning when the
  // key is absent so a deploy that MEANT to enable illustrations is
  // diagnosable at boot. Secrets policy (SECURITY.md §1): no default, and
  // the value is never logged (services/imageGen.ts never places it
  // anywhere but the Authorization header). EMPTY STRING ⇒ unset: the
  // deploy compose passes `OPENAI_API_KEY=${OPENAI_API_KEY:-}` so the
  // plumbing exists before the key does (ELEVENLABS_API_KEY's exact
  // preprocess).
  OPENAI_API_KEY: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(1).optional(),
  ),

  // Per-user DAILY cap on story-illustration ENQUEUES (→ 429 BEFORE any job
  // row is written). The provider bills per image, but a per-JOB cap is the
  // right lever because a job's image count is already hard-bounded
  // (STORY_IMAGE_SCENE_COUNT clamps 2-4), so jobs/day × 4 bounds spend; the
  // story_image_jobs.image_count ledger still records exact usage. Failed
  // jobs count (cost control — a failed run spent quota too; 069/076/081's
  // stance).
  STORY_IMAGE_DAILY_CAP: z.coerce.number().int().positive().default(10),

  // How often the in-server runner polls story_image_jobs for pending work.
  // In-process (the same posture as the story-TTS runner — the blob store is
  // writable only here); the interval is unref'd so it never holds the
  // process open.
  STORY_IMAGE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),

  // A 'running' job older than this is presumed crashed (server restart
  // mid-generation) and reaped 'failed' at the next poll, un-bricking the
  // story's one-live-job slot. Sized past the worst plausible run: one
  // prompt-set Claude call + 4 sequential image generations at ~90s each
  // ('pending' is never reaped — it is the healthy backlog).
  STORY_IMAGE_STALE_RUN_MINUTES: z.coerce.number().int().positive().default(20),

  // How many key-scene illustrations one job generates (the sceneCount the
  // prompt-set route is asked for). LOCKED to 2..4 (F-211's charter) — an
  // out-of-range value fails config parse at startup (bad config is a
  // deploy-time problem, SECURITY.md §1), it is never silently clamped.
  STORY_IMAGE_SCENE_COUNT: z.coerce.number().int().min(2).max(4).default(3),

  // ---------------------------------------------------------------------------
  // Reading comprehension checks (F-205 — AI-generated MC questions per
  // reading chapter, Claude proxy route 'reading_comprehension', stored in
  // reading_questions/086).
  // ---------------------------------------------------------------------------
  // Per-user DAILY cap on comprehension-question GENERATIONS (→ 429 BEFORE
  // the Claude call). Unlike the story TTS/image caps (which count their job
  // ledgers), generation here is synchronous with no jobs table — the
  // append-only claude_usage table (004) is the ledger: one row per
  // generation call, surviving regenerates (the reading_questions rows
  // themselves are replaced, so they can't count spend). A generous default:
  // a real study session generates a handful of chapters at most.
  READING_QUESTION_DAILY_CAP: z.coerce.number().int().positive().default(20),

  // How many questions one generation authors (F-205 locks 3-5; an
  // out-of-range value fails config parse at startup — bad config is a
  // deploy-time problem, never silently clamped; STORY_IMAGE_SCENE_COUNT's
  // stance).
  READING_QUESTION_COUNT: z.coerce.number().int().min(3).max(5).default(4),

  // Corpus audio root (F-012 — TTMIK/Iyagi mp3 streaming). Read-only tree the
  // audio routes stream from; DB rows store paths RELATIVE to this root (e.g.
  // 'TTMIK/이야기들/이야기/143 TTMIK Iyagi 143.mp3'). In the deploy compose this
  // is a `:ro` bind mount at /corpus; the default matches that mount so prod
  // needs no extra env. A missing dir is not a startup error — audio requests
  // simply 404 until the mount exists (routes/ttmik.ts owns the containment
  // check that keeps every resolved path inside this root).
  CORPUS_AUDIO_DIR: z.string().min(1).default('/corpus'),

  // Corpus image root (F-120 — TOPIK question-figure serving). Read-only tree
  // the image route serves from; topik_items.image_ref stores paths RELATIVE
  // to this root (migration 085 — the same contract as CORPUS_AUDIO_DIR's
  // audio_path rows). Defaults to the SAME `:ro` corpus bind mount as the
  // audio root (the crops live beside the MP3s in the one official-corpus
  // tree); a distinct variable so the two roots can be split later without a
  // code change. A missing dir is not a startup error — image requests simply
  // 404 until the files exist (services/corpusImage.ts owns the containment
  // check that keeps every resolved path inside this root).
  CORPUS_IMAGE_DIR: z.string().min(1).default('/corpus'),

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
  // The diagnostic run's OWN bucket (middleware/rateLimits.ts's diagnosticLimiter),
  // split out from RATE_LIMIT_EXPENSIVE_MAX (diagnostic-upgrade Phase A fix-pass,
  // R2 SF-1): a full run makes one route-entry hit per served item on
  // POST /diagnostic + /diagnostic/:id/next, even though most of those hits are
  // cheap DB reads (only vocab/grammar/writing generation calls Claude). Sizing
  // the SHARED expensive bucket to a full run's length would loosen abuse
  // protection for every OTHER paid-upstream route (writing gen, conversation,
  // TTS, OCR, image-gen) that shares it — so the diagnostic gets its own ceiling
  // instead. Bumped 30→45 (diagnostic-upgrade Phase C): TARGET_ITEM_COUNT grew
  // 22→30 (WEIGHTS: reading/listening/vocab/grammar 4→6 each), so a full run
  // alone now makes 30 route-entry hits (1 create + 29 /next calls) — 45 gives
  // MORE headroom than the old ratio (50% vs the old 30-for-22 sizing's ~36%),
  // rounded to a clean number rather than sized to the bare minimum.
  RATE_LIMIT_DIAGNOSTIC_MAX: z.coerce.number().int().positive().default(45),
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
  // F-210 note: ELEVENLABS_API_KEY is deliberately NOT refined to be
  // required in production — story TTS ships dormant (see the field's doc
  // comment) and a missing key must never block an unrelated deploy.
  // F-211 note: OPENAI_API_KEY takes the identical stance for the same
  // reason (story illustrations ship dormant).
});

export type Config = z.infer<typeof EnvSchema>;

/**
 * Whether THIS process is currently allowed to CLAIM + PROCESS story-runner
 * jobs (audio-TTS / illustration queues) — see the `DEPLOY_COLOR` /
 * `ACTIVE_COLOR_FILE` field comments above for why this cannot be a plain
 * cached config value. Deliberately takes `cfg` rather than calling
 * `loadConfig()` itself so callers pass the exact config they already
 * loaded (and so tests can pass an override without touching process.env).
 *
 * Fails OPEN (returns true) whenever the color context is unknown or the
 * active-color file can't be read: `DEPLOY_COLOR` unset means this isn't a
 * blue/green deployment at all (local dev, tests — never gate those), and a
 * missing/unreadable mount on an actual blue/green box is exactly the
 * failure SKIP LOCKED already tolerates (concurrent claiming is safe, just
 * unpredictable) — silently stalling BOTH colors' queues over a transient
 * mount hiccup would be a strictly worse outcome than the bug this exists
 * to fix.
 */
export function isRunnerActiveColor(
  cfg: Pick<Config, 'DEPLOY_COLOR' | 'ACTIVE_COLOR_FILE'>,
): boolean {
  if (cfg.DEPLOY_COLOR === undefined) return true;
  let recorded: string;
  try {
    recorded = readFileSync(cfg.ACTIVE_COLOR_FILE, 'utf8').trim();
  } catch {
    return true;
  }
  if (recorded === '') return true;
  return recorded === cfg.DEPLOY_COLOR;
}

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
