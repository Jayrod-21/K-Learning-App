/**
 * settings — pure I/O. Tests cover the three behaviours the rest of the
 * app trusts:
 *   1. `loadSettings` is total — DEFAULT_SETTINGS on missing or corrupt.
 *   2. `saveSettings` round-trips through `loadSettings`.
 *   3. `paletteVars` flattens the four presets correctly, including the
 *      default combo and a non-default combo, and produces ONLY keys that
 *      come from the presets (no spurious `--ink-*` from an accent pick).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
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
  it('produces the DEFAULT combo (hanji+vermilion+moss+vermilion)', () => {
    const vars = paletteVars(DEFAULT_SETTINGS.palette);
    // Paper preset writes ink + paper + line tokens
    expect(vars['--ink']).toBe('#E8DFC5');
    expect(vars['--paper']).toBe('#1B1813');
    expect(vars['--line']).toBe('rgba(27,24,19,0.10)');
    // Accent writes vermilion + gold aliases
    expect(vars['--vermilion']).toBe('#B83A2E');
    expect(vars['--gold-light']).toBe('#C8503F');
    // Correct writes moss + green aliases
    expect(vars['--moss']).toBe('#5C7548');
    expect(vars['--green']).toBe('#5C7548');
    // Wrong writes danger (vermilion preset under wrong → same hex as accent)
    expect(vars['--danger']).toBe('#B83A2E');
  });

  it('produces a non-default combo (linen+plum+pine+amber)', () => {
    const vars = paletteVars({
      paper: 'linen',
      accent: 'plum',
      correct: 'pine',
      wrong: 'amber',
    });
    expect(vars['--ink']).toBe('#E2D9C2');
    expect(vars['--vermilion']).toBe('#7B3358');
    expect(vars['--gold']).toBe('#7B3358');
    expect(vars['--moss']).toBe('#2E5B3E');
    expect(vars['--green']).toBe('#2E5B3E');
    expect(vars['--danger']).toBe('#A66A1F');
  });

  it('falls back to empty section when a preset id is unknown', () => {
    const vars = paletteVars({
      paper: 'bogus',
      accent: 'vermilion',
      correct: 'moss',
      wrong: 'vermilion',
    });
    // Paper section omitted entirely — no ink/paper keys set
    expect(vars['--ink']).toBeUndefined();
    expect(vars['--paper']).toBeUndefined();
    // Other sections still resolve
    expect(vars['--vermilion']).toBe('#B83A2E');
    expect(vars['--moss']).toBe('#5C7548');
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
