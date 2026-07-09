/**
 * SettingsProvider — wiring + side-effect tests.
 *
 *   - `useSettings` outside the Provider throws (loud failure mode).
 *   - Provider hydrates from localStorage on mount.
 *   - `updateSettings` debounces a write to localStorage.
 *   - NO palette CSS vars are ever inline-projected (v2 flatten removed the
 *     paper/correct/wrong feature — theme/accent tokens own all color).
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

  it('never inline-projects palette/theme tokens (v2 flatten)', () => {
    // The paper/correct/wrong palette feature is gone. The ONLY <html>
    // custom property the Provider may write is --lang-sub-scale — surface,
    // type, accent, success and danger tokens all come from the
    // [data-theme]/[data-accent] blocks in index.css untouched.
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
    for (const key of touched) {
      expect(key).toBe('--lang-sub-scale');
    }
  });

  it('ignores a legacy stored palette blob instead of projecting it', () => {
    // A pre-v2 localStorage blob still carries `palette` — it must neither
    // crash the merge nor reach the DOM as inline CSS variables.
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
    const touched = new Set(spy.mock.calls.map(([k]) => k));
    expect(touched.has('--ink')).toBe(false);
    expect(touched.has('--moss')).toBe(false);
    expect(touched.has('--moss-soft')).toBe(false);
    expect(touched.has('--danger')).toBe(false);
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
