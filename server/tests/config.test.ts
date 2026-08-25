/**
 * Config-schema tests (F-006 fix-pass B1 + S4).
 *
 * WHY THIS FILE EXISTS: the deploy compose passes boolean flags as STRINGS
 * (`REGISTRATION_ENABLED=false`), and `z.coerce.boolean()` parses the string
 * "false" as `true` — which silently re-opened production self-signup. Every
 * boolean flag now uses the strict `envBool` parser; these tests pin that
 * behavior so a regression back to coercion FAILS loudly:
 *   - `"false"` / `"0"` / `"no"` / `"off"` → false (the compose contract);
 *   - `"true"` / `"1"` / `"yes"` / `"on"`  → true;
 *   - unset/empty → the documented default (REGISTRATION_ENABLED default-true,
 *     MFA_REQUIRED default-true, EMAIL_VERIFICATION_REQUIRED default-TRUE —
 *     the F-006 bar's "default ON" claim);
 *   - garbage → config parse FAILS at startup (fail-fast, never a guess).
 * Plus the SMTP_FROM-required-with-SMTP_HOST startup refinement.
 *
 * Pure unit tests: no DB, no app — just the Zod schema via loadConfig().
 */
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isRunnerActiveColor,
  loadConfig,
  resetConfig,
  TEST_TOTP_SECRET_ENC_KEY,
} from '../src/config/index.js';

/** The minimal REQUIRED env for a successful config parse. */
const REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  KIWI_URL: 'http://kiwi.invalid/',
  CLIENT_ORIGIN: 'http://localhost:5173',
  TOTP_SECRET_ENC_KEY: TEST_TOTP_SECRET_ENC_KEY,
};

/** Every knob these tests touch — snapshotted/restored around each test so a
 *  config test can never leak env into the rest of the suite. */
const TOUCHED_KEYS = [
  ...Object.keys(REQUIRED_ENV),
  'REGISTRATION_ENABLED',
  'MFA_REQUIRED',
  'EMAIL_VERIFICATION_REQUIRED',
  'INVITE_REQUIRED',
  'DIAGNOSTIC_USE_GENERATED_BANK',
  'SMTP_HOST',
  'SMTP_FROM',
  'SMTP_SECURE',
  'SMTP_TLS_REJECT_UNAUTHORIZED',
  'AUDIO_UPLOAD_STORAGE_DIR',
  'AUDIO_UPLOAD_MAX_BYTES',
  'AUDIO_TRANSCRIBE_DAILY_BYTES_CAP',
  'AUDIO_UPLOAD_DAILY_COUNT_CAP',
  'NODE_ENV',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'STORY_TTS_DAILY_CAP',
  'STORY_RUNNERS_ENABLED',
  'DEPLOY_COLOR',
  'ACTIVE_COLOR_FILE',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(TOUCHED_KEYS.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED_KEYS) delete process.env[k];
  Object.assign(process.env, REQUIRED_ENV);
  resetConfig();
});

afterEach(() => {
  for (const k of TOUCHED_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfig();
});

/** Parse fresh from the current process.env. */
function parse() {
  resetConfig();
  return loadConfig();
}

describe('strict boolean env flags (envBool) — the compose files pass STRINGS', () => {
  // The three security gates. Table-driven so adding a flag is one line.
  const FLAGS: { key: string; defaultValue: boolean }[] = [
    { key: 'REGISTRATION_ENABLED', defaultValue: true },
    { key: 'MFA_REQUIRED', defaultValue: true },
    { key: 'EMAIL_VERIFICATION_REQUIRED', defaultValue: true },
    { key: 'STORY_RUNNERS_ENABLED', defaultValue: true },
    // Phase 2.3 — default FALSE (opt-in, unlike the other three gates above)
    // so existing dev/test register flows keep working without provisioning
    // an invite code; prod flips it true alongside REGISTRATION_ENABLED.
    { key: 'INVITE_REQUIRED', defaultValue: false },
    // F-220 slice 1 — default FALSE (opt-in): the live diagnostic's
    // vocab/grammar generation stays byte-identical until an operator has
    // populated + approved a generated_items bank and deliberately flips
    // this on.
    { key: 'DIAGNOSTIC_USE_GENERATED_BANK', defaultValue: false },
  ];

  for (const { key, defaultValue } of FLAGS) {
    describe(key, () => {
      it(`"false" parses to false (B1 — the string the deploy compose actually passes)`, () => {
        process.env[key] = 'false';
        expect(parse()[key as 'REGISTRATION_ENABLED']).toBe(false);
      });

      it.each(['0', 'no', 'off', 'FALSE', ' false '])(
        '%j parses to false',
        (v) => {
          process.env[key] = v;
          expect(parse()[key as 'REGISTRATION_ENABLED']).toBe(false);
        },
      );

      it.each(['true', '1', 'yes', 'on', 'TRUE'])('%j parses to true', (v) => {
        process.env[key] = v;
        expect(parse()[key as 'REGISTRATION_ENABLED']).toBe(true);
      });

      it(`unset → default ${String(defaultValue)}`, () => {
        delete process.env[key];
        expect(parse()[key as 'REGISTRATION_ENABLED']).toBe(defaultValue);
      });

      it('empty string → the default (unset semantics)', () => {
        process.env[key] = '';
        expect(parse()[key as 'REGISTRATION_ENABLED']).toBe(defaultValue);
      });

      it('garbage fails config parse at startup (never a silent guess)', () => {
        process.env[key] = 'enabled';
        expect(() => parse()).toThrow(/Invalid configuration/);
      });
    });
  }
});

describe('SMTP config refinement (F-006)', () => {
  it('SMTP_HOST without SMTP_FROM fails at startup (not on first send)', () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    delete process.env.SMTP_FROM;
    expect(() => parse()).toThrow(/Invalid configuration/);
  });

  it('SMTP_HOST with SMTP_FROM parses cleanly', () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_FROM = 'noreply@example.com';
    const cfg = parse();
    expect(cfg.SMTP_HOST).toBe('smtp.example.com');
    expect(cfg.SMTP_FROM).toBe('noreply@example.com');
  });

  it('no SMTP at all parses cleanly (mock transport posture)', () => {
    const cfg = parse();
    expect(cfg.SMTP_HOST).toBeUndefined();
  });

  it('SMTP_SECURE/"false" and SMTP_TLS_REJECT_UNAUTHORIZED/"false" honor the strict parser', () => {
    process.env.SMTP_SECURE = 'false';
    process.env.SMTP_TLS_REJECT_UNAUTHORIZED = 'false';
    const cfg = parse();
    expect(cfg.SMTP_SECURE).toBe(false);
    expect(cfg.SMTP_TLS_REJECT_UNAUTHORIZED).toBe(false);
  });
});

describe('audio-upload knobs (Track A, A-3)', () => {
  it('unset → the documented defaults', () => {
    const cfg = parse();
    expect(cfg.AUDIO_UPLOAD_STORAGE_DIR).toBe('./var/audio-uploads');
    expect(cfg.AUDIO_UPLOAD_MAX_BYTES).toBe(100 * 1024 * 1024);
    expect(cfg.AUDIO_TRANSCRIBE_DAILY_BYTES_CAP).toBe(500 * 1024 * 1024);
    expect(cfg.AUDIO_UPLOAD_DAILY_COUNT_CAP).toBe(50);
  });

  it('env strings parse to typed values (the compose files pass STRINGS)', () => {
    process.env.AUDIO_UPLOAD_STORAGE_DIR = '/app/var/audio-uploads';
    process.env.AUDIO_UPLOAD_MAX_BYTES = '65536';
    process.env.AUDIO_TRANSCRIBE_DAILY_BYTES_CAP = '131072';
    process.env.AUDIO_UPLOAD_DAILY_COUNT_CAP = '3';
    const cfg = parse();
    expect(cfg.AUDIO_UPLOAD_STORAGE_DIR).toBe('/app/var/audio-uploads');
    expect(cfg.AUDIO_UPLOAD_MAX_BYTES).toBe(65_536);
    expect(cfg.AUDIO_TRANSCRIBE_DAILY_BYTES_CAP).toBe(131_072);
    expect(cfg.AUDIO_UPLOAD_DAILY_COUNT_CAP).toBe(3);
  });

  it('a non-positive or garbage byte cap fails config parse at startup', () => {
    process.env.AUDIO_UPLOAD_MAX_BYTES = '0';
    expect(() => parse()).toThrow(/Invalid configuration/);
    process.env.AUDIO_UPLOAD_MAX_BYTES = 'lots';
    expect(() => parse()).toThrow(/Invalid configuration/);
  });

  it('a non-positive or garbage upload-count cap fails config parse at startup', () => {
    process.env.AUDIO_UPLOAD_DAILY_COUNT_CAP = '0';
    expect(() => parse()).toThrow(/Invalid configuration/);
    process.env.AUDIO_UPLOAD_DAILY_COUNT_CAP = 'many';
    expect(() => parse()).toThrow(/Invalid configuration/);
  });
});

describe('story TTS config (F-210) — dormant-deploy posture', () => {
  it('no ELEVENLABS_API_KEY in PRODUCTION parses cleanly — a keyless deploy must never fail at startup', () => {
    // The B1 regression pin: the key used to be refined required-in-prod,
    // which coupled every unrelated km-server deploy to a vendor key. The
    // feature now ships dormant instead (503 + ttsConfigured:false).
    process.env.NODE_ENV = 'production';
    delete process.env.ELEVENLABS_API_KEY;
    const cfg = parse();
    expect(cfg.NODE_ENV).toBe('production');
    expect(cfg.ELEVENLABS_API_KEY).toBeUndefined();
  });

  it("EMPTY string reads as unset (the compose passes `${ELEVENLABS_API_KEY:-}` → '')", () => {
    process.env.ELEVENLABS_API_KEY = '';
    process.env.ELEVENLABS_VOICE_ID = '';
    const cfg = parse();
    expect(cfg.ELEVENLABS_API_KEY).toBeUndefined();
    // Empty voice id falls back to the documented default, not ''.
    expect(cfg.ELEVENLABS_VOICE_ID).toBe('21m00Tcm4TlvDq8ikWAM');
  });

  it('a set key and voice id parse through as given', () => {
    process.env.ELEVENLABS_API_KEY = 'test-elevenlabs-key';
    process.env.ELEVENLABS_VOICE_ID = 'voice-abc';
    const cfg = parse();
    expect(cfg.ELEVENLABS_API_KEY).toBe('test-elevenlabs-key');
    expect(cfg.ELEVENLABS_VOICE_ID).toBe('voice-abc');
  });

  it('STORY_TTS_DAILY_CAP: default 10, env strings parse to numbers (the compose passes STRINGS)', () => {
    expect(parse().STORY_TTS_DAILY_CAP).toBe(10);
    process.env.STORY_TTS_DAILY_CAP = '3';
    expect(parse().STORY_TTS_DAILY_CAP).toBe(3);
  });

  it('a non-positive or garbage STORY_TTS_DAILY_CAP fails config parse at startup', () => {
    process.env.STORY_TTS_DAILY_CAP = '0';
    expect(() => parse()).toThrow(/Invalid configuration/);
    process.env.STORY_TTS_DAILY_CAP = 'unlimited';
    expect(() => parse()).toThrow(/Invalid configuration/);
  });
});

describe('isRunnerActiveColor (Phase 1.3 — blue/green story-runner gating)', () => {
  // A promotion (azure-switch-production.sh) is a pure nginx reload with no
  // container restart, so "which color is active" cannot live on the cached
  // Config — it must be read fresh from ACTIVE_COLOR_FILE on every call. Real
  // temp files (not mocked fs) so the test exercises the actual read path.
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'km-active-color-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('DEPLOY_COLOR unset (local dev / tests / non-blue-green) → always active, file never read', () => {
    // A path that does not exist would throw if it were ever read.
    expect(
      isRunnerActiveColor({
        DEPLOY_COLOR: undefined,
        ACTIVE_COLOR_FILE: path.join(tmpDir, 'does-not-exist'),
      }),
    ).toBe(true);
  });

  it('file names THIS color → active', () => {
    const file = path.join(tmpDir, 'active-color');
    writeFileSync(file, 'blue\n');
    expect(
      isRunnerActiveColor({ DEPLOY_COLOR: 'blue', ACTIVE_COLOR_FILE: file }),
    ).toBe(true);
  });

  it('file names the OTHER color → not active', () => {
    const file = path.join(tmpDir, 'active-color');
    writeFileSync(file, 'green\n');
    expect(
      isRunnerActiveColor({ DEPLOY_COLOR: 'blue', ACTIVE_COLOR_FILE: file }),
    ).toBe(false);
  });

  it('file content is trimmed (a trailing newline never causes a false mismatch)', () => {
    const file = path.join(tmpDir, 'active-color');
    writeFileSync(file, 'green\n\n');
    expect(
      isRunnerActiveColor({ DEPLOY_COLOR: 'green', ACTIVE_COLOR_FILE: file }),
    ).toBe(true);
  });

  it('missing file (DEPLOY_COLOR set but the mount is absent/unreadable) fails OPEN — never stalls both colors', () => {
    expect(
      isRunnerActiveColor({
        DEPLOY_COLOR: 'blue',
        ACTIVE_COLOR_FILE: path.join(tmpDir, 'does-not-exist'),
      }),
    ).toBe(true);
  });

  it('empty file content fails OPEN (cold-box window before the first switch)', () => {
    const file = path.join(tmpDir, 'active-color');
    writeFileSync(file, '');
    expect(
      isRunnerActiveColor({ DEPLOY_COLOR: 'blue', ACTIVE_COLOR_FILE: file }),
    ).toBe(true);
  });
});
