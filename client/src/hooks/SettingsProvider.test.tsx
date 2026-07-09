/**
 * SettingsProvider — wiring + side-effect tests.
 *
 *   - `useSettings` outside the Provider throws (loud failure mode).
 *   - Provider hydrates from localStorage on mount.
 *   - `updateSettings` debounces a write to localStorage.
 *   - Selected palette is applied via `setProperty` on <html>.
 *   - `resetSettings` returns to DEFAULT_SETTINGS.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { JSX } from 'react';
import { SettingsProvider } from './SettingsProvider';
import { useSettings } from './useSettings';
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  loadSettings,
} from '../lib/settings';

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('style');
});

describe('useSettings without Provider', () => {
  it('throws a clear error', () => {
    // Silence React's expected error log for this assertion.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useSettings())).toThrow(
      /useSettings must be used inside <SettingsProvider>/,
    );
    spy.mockRestore();
  });
});

describe('SettingsProvider', () => {
  it('hydrates from localStorage on mount', () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_SETTINGS, name: 'Jared' }),
    );
    const { result } = renderHook(() => useSettings(), {
      wrapper: ({ children }) => (
        <SettingsProvider>{children}</SettingsProvider>
      ),
    });
    expect(result.current.settings.name).toBe('Jared');
  });

  it('applies NO palette vars for the DEFAULT palette (Seoul Neon)', () => {
    // The default presets declare no vars — default users render the
    // theme+accent-aware token blocks from index.css untouched. Only the
    // language-display scale (its own non-palette projection) may land.
    const spy = vi.spyOn(
      document.documentElement.style,
      'setProperty',
    );
    render(
      <SettingsProvider>
        <div>app</div>
      </SettingsProvider>,
    );
    const touched = new Set(spy.mock.calls.map(([k]) => k));
    expect(touched.has('--ink')).toBe(false);
    expect(touched.has('--paper')).toBe(false);
    expect(touched.has('--vermilion')).toBe(false);
    expect(touched.has('--moss')).toBe(false);
    expect(touched.has('--danger')).toBe(false);
  });

  it('applies a stored non-default palette to documentElement on mount', () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        palette: { paper: 'linen', accent: 'plum', correct: 'pine', wrong: 'amber' },
      }),
    );
    const spy = vi.spyOn(
      document.documentElement.style,
      'setProperty',
    );
    render(
      <SettingsProvider>
        <div>app</div>
      </SettingsProvider>,
    );
    const calls = spy.mock.calls.map(([k, v]) => [k, v] as const);
    const set = new Map(calls);
    expect(set.get('--ink')).toBe('#E2D9C2');
    expect(set.get('--moss')).toBe('#2E5B3E');
    expect(set.get('--danger')).toBe('#A66A1F');
    // Accent is NEVER inline-projected — data-accent CSS owns --vermilion.
    expect(set.has('--vermilion')).toBe(false);
  });

  it('does not set tokens outside the allowlist', () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        palette: { paper: 'linen', accent: 'plum', correct: 'pine', wrong: 'amber' },
      }),
    );
    const spy = vi.spyOn(
      document.documentElement.style,
      'setProperty',
    );
    render(
      <SettingsProvider>
        <div>app</div>
      </SettingsProvider>,
    );
    for (const [key] of spy.mock.calls) {
      expect(key.startsWith('--')).toBe(true);
    }
    // No surface-only token leaks from a non-paper category — if the
    // allowlist were broken, an extraneous unknown key would appear.
    const touched = new Set(spy.mock.calls.map(([k]) => k));
    // Spot-check: --green-light comes from correct; the accent's legacy
    // --gold* tokens were removed from the allowlist and must NOT land.
    expect(touched.has('--green-light')).toBe(true);
    expect(touched.has('--gold-light')).toBe(false);
    expect(touched.has('--vermilion')).toBe(false);
  });

  it('debounces persistence and writes after 200ms', () => {
    function Probe(): JSX.Element {
      const { settings, updateSettings } = useSettings();
      return (
        <button
          type="button"
          onClick={() =>
            updateSettings({ ...settings, name: 'Jared' })
          }
        >
          set
        </button>
      );
    }
    // `userEvent` deadlocks against `vi.useFakeTimers()` in some happy-dom
    // setups (the click pipeline awaits timers that we've frozen). The
    // synchronous `fireEvent.click` is enough for state-transition tests —
    // we reserve `userEvent` for tests that exercise event-shape fidelity
    // (key sequences, modifiers, etc.).
    render(
      <SettingsProvider>
        <Probe />
      </SettingsProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'set' }));
    // Pre-debounce: nothing written yet
    expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(250);
    });
    const stored = loadSettings();
    expect(stored.name).toBe('Jared');
  });

  it('resetSettings restores defaults', () => {
    function Probe(): JSX.Element {
      const { settings, updateSettings, resetSettings } = useSettings();
      return (
        <div>
          <span data-testid="name">{settings.name}</span>
          <button
            type="button"
            onClick={() =>
              updateSettings({ ...settings, name: 'Jared' })
            }
          >
            set
          </button>
          <button type="button" onClick={resetSettings}>
            reset
          </button>
        </div>
      );
    }
    render(
      <SettingsProvider>
        <Probe />
      </SettingsProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'set' }));
    expect(screen.getByTestId('name').textContent).toBe('Jared');
    fireEvent.click(screen.getByRole('button', { name: 'reset' }));
    expect(screen.getByTestId('name').textContent).toBe('');
  });
});
