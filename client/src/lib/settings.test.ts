/**
 * settings — pure I/O. Tests cover the behaviours the rest of the app trusts:
 *   1. `loadSettings` is total — DEFAULT_SETTINGS on missing or corrupt.
 *   2. `saveSettings` round-trips through `loadSettings`.
 *   3. Legacy `palette` keys in pre-v2 blobs are dropped, not merged
 *      (v2 flatten: the paper/correct/wrong palette feature — and its
 *      `paletteVars` projection — was removed; appearance is theme + accent).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampSubScale,
  DEFAULT_SETTINGS,
  LANG_SUB_SCALE_MAX,
  LANG_SUB_SCALE_MIN,
  SETTINGS_STORAGE_KEY,
  loadSettings,
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

  it('deep-merges partial blobs over defaults (legacy palette key dropped)', () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        name: 'Jared',
        // Pre-v2 blobs carried a palette — it must be ignored, not crash.
        palette: { paper: 'linen' },
        notif: { channel: { sms: true } },
      }),
    );
    const got = loadSettings();
    expect(got.name).toBe('Jared');
    // v2 flatten: the legacy palette key is dropped from the merged shape.
    expect('palette' in got).toBe(false);
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
    expect(got.name).toBe('Jared');
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
      languageDisplay: { mode: 'en', primary: 'en', subScale: 0.5 },
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

// v2 flatten: the `paletteVars` suite was removed with the feature — no
// inline palette projection exists anymore (appearance = theme + accent).
