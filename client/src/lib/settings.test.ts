/**
 * settings — pure I/O. Tests cover the three behaviours the rest of the
 * app trusts:
 *   1. `loadSettings` is total — DEFAULT_SETTINGS on missing or corrupt.
 *   2. `saveSettings` round-trips through `loadSettings`.
 *   3. `paletteVars` flattens the projected presets correctly: the DEFAULT
 *      combo projects NOTHING (Seoul Neon — theme/accent-aware tokens from
 *      index.css render untouched), a non-default combo projects only its
 *      own category's keys, and the ACCENT category is never projected
 *      (the runtime `data-accent` blocks own `--vermilion`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampSubScale,
  DEFAULT_SETTINGS,
  LANG_SUB_SCALE_MAX,
  LANG_SUB_SCALE_MIN,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  paletteVars,
  saveSettings,
  type Settings,
} from './settings';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadSettings', () => {
  it('returns DEFAULT_SETTINGS when the key is absent', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns DEFAULT_SETTINGS on corrupt JSON without throwing', () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, '{not json');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns DEFAULT_SETTINGS when stored value is not an object', () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, '"hello"');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('deep-merges partial blobs over defaults', () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        name: 'Jared',
        palette: { paper: 'linen' },
        notif: { channel: { sms: true } },
      }),
    );
    const got = loadSettings();
    expect(got.name).toBe('Jared');
    expect(got.palette.paper).toBe('linen');
    // Untouched palette keys fall back to defaults
    expect(got.palette.accent).toBe(DEFAULT_SETTINGS.palette.accent);
    // Channel patched, siblings preserved
    expect(got.notif.channel.sms).toBe(true);
    expect(got.notif.channel.email).toBe(
      DEFAULT_SETTINGS.notif.channel.email,
    );
    expect(got.notif.daily).toBe(DEFAULT_SETTINGS.notif.daily);
  });

  it('drops fields with wrong types and substitutes defaults', () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        name: 42,
        notif: { daily: 'yes', channel: { email: 0 } },
      }),
    );
    const got = loadSettings();
    expect(got.name).toBe(DEFAULT_SETTINGS.name);
    expect(got.notif.daily).toBe(DEFAULT_SETTINGS.notif.daily);
    expect(got.notif.channel.email).toBe(
      DEFAULT_SETTINGS.notif.channel.email,
    );
  });
});

describe('loadSettings — languageDisplay (P3a)', () => {
  it('defaults languageDisplay when a pre-P3a blob lacks it entirely', () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ name: 'Jared', palette: { paper: 'linen' } }),
    );
    const got = loadSettings();
    expect(got.languageDisplay).toEqual({ mode: 'both', primary: 'ko', subScale: 0.7 });
    // ...and the pre-P3a fields still merged normally.
    expect(got.palette.paper).toBe('linen');
  });

  it('deep-merges a partial languageDisplay (field-by-field, not all-or-nothing)', () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ languageDisplay: { mode: 'en' } }),
    );
    const got = loadSettings();
    expect(got.languageDisplay).toEqual({ mode: 'en', primary: 'ko', subScale: 0.7 });
  });

  it('clamps an out-of-range subScale into [0.4, 1.0]', () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ languageDisplay: { mode: 'both', primary: 'en', subScale: 3 } }),
    );
    expect(loadSettings().languageDisplay).toEqual({
      mode: 'both',
      primary: 'en',
      subScale: 1.0,
    });
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ languageDisplay: { subScale: 0.1 } }),
    );
    expect(loadSettings().languageDisplay.subScale).toBe(0.4);
  });

  it('rejects bad enums / non-numeric subScale and substitutes defaults', () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        languageDisplay: { mode: 'fr', primary: 42, subScale: 'huge' },
      }),
    );
    expect(loadSettings().languageDisplay).toEqual(
      DEFAULT_SETTINGS.languageDisplay,
    );
  });
});

describe('clampSubScale', () => {
  it('passes through in-range values', () => {
    expect(clampSubScale(0.55)).toBe(0.55);
  });
  it('clamps below/above the bounds', () => {
    expect(clampSubScale(0)).toBe(LANG_SUB_SCALE_MIN);
    expect(clampSubScale(99)).toBe(LANG_SUB_SCALE_MAX);
  });
  it('falls back to the default on non-finite / non-numeric input', () => {
    expect(clampSubScale(Number.NaN)).toBe(0.7);
    expect(clampSubScale(Infinity)).toBe(0.7);
    expect(clampSubScale('0.5')).toBe(0.7);
    expect(clampSubScale(undefined)).toBe(0.7);
  });
});

describe('saveSettings', () => {
  it('round-trips through loadSettings', () => {
    const next: Settings = {
      ...DEFAULT_SETTINGS,
      name: 'Jared',
      email: 'j@example.com',
      palette: { paper: 'sumi', accent: 'plum', correct: 'pine', wrong: 'amber' },
    };
    saveSettings(next);
    expect(loadSettings()).toEqual(next);
  });

  it('swallows storage errors without throwing', () => {
    // Spy directly on the localStorage instance — happy-dom's Storage
    // doesn't dispatch through `Storage.prototype` the same way jsdom does,
    // so a prototype spy never fires.
    const spy = vi
      .spyOn(window.localStorage, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow();
    expect(spy).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

describe('paletteVars', () => {
  it('produces NO overrides for the DEFAULT combo (Seoul Neon)', () => {
    // The default presets (hanji / moss / vermilion-wrong) declare no vars:
    // default users render the theme+accent-aware token blocks in index.css
    // untouched. An inline default projection would beat [data-theme] and
    // [data-accent] in the cascade and freeze the app theme-blind.
    const vars = paletteVars(DEFAULT_SETTINGS.palette);
    expect(vars).toEqual({});
  });

  it('produces a non-default combo (linen+plum+pine+amber)', () => {
    const vars = paletteVars({
      paper: 'linen',
      accent: 'plum',
      correct: 'pine',
      wrong: 'amber',
    });
    expect(vars['--ink']).toBe('#E2D9C2');
    // Accent is NEVER projected — the data-accent CSS blocks own --vermilion.
    expect(vars['--vermilion']).toBeUndefined();
    expect(vars['--gold']).toBeUndefined();
    expect(vars['--moss']).toBe('#2E5B3E');
    expect(vars['--green']).toBe('#2E5B3E');
    expect(vars['--danger']).toBe('#A66A1F');
  });

  it('falls back to empty section when a preset id is unknown', () => {
    const vars = paletteVars({
      paper: 'bogus',
      accent: 'vermilion',
      correct: 'pine',
      wrong: 'amber',
    });
    // Paper section omitted entirely — no ink/paper keys set
    expect(vars['--ink']).toBeUndefined();
    expect(vars['--paper']).toBeUndefined();
    // Other sections still resolve
    expect(vars['--moss']).toBe('#2E5B3E');
    expect(vars['--danger']).toBe('#A66A1F');
  });

  it('later categories win for shared keys', () => {
    // The wrong category owns --danger; an accent preset never sets --danger
    // directly, but verify the ordering contract holds.
    const vars = paletteVars({
      paper: 'hanji',
      accent: 'indigo',
      correct: 'moss',
      wrong: 'slate',
    });
    expect(vars['--danger']).toBe('#4A4A55');
  });
});
