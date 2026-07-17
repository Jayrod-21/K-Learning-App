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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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
  'SMTP_HOST',
  'SMTP_FROM',
  'SMTP_SECURE',
  'SMTP_TLS_REJECT_UNAUTHORIZED',
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
