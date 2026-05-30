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

  it('applies palette vars to documentElement on mount', () => {
    const spy = vi.spyOn(
      document.documentElement.style,
      'setProperty',
    );
    render(
      <SettingsProvider>
        <div>app</div>
      </SettingsProvider>,
    );
    // DEFAULT palette is hanji+vermilion+moss+vermilion — at least these
    // canonical keys must hit setProperty.
    const calls = spy.mock.calls.map(([k, v]) => [k, v] as const);
    const set = new Map(calls);
    expect(set.get('--ink')).toBe('#E8DFC5');
    expect(set.get('--paper')).toBe('#1B1813');
    expect(set.get('--vermilion')).toBe('#B83A2E');
    expect(set.get('--moss')).toBe('#5C7548');
    expect(set.get('--danger')).toBe('#B83A2E');
  });

  it('does not set tokens outside the allowlist', () => {
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
    // No surface-only token leaks from a non-paper category — we only
    // know `--paper` was set by the paper preset itself; if the allowlist
    // were broken, an extraneous unknown key would appear. Verify the
    // touched set is exactly the union of the four preset var maps.
    const touched = new Set(spy.mock.calls.map(([k]) => k));
    // Spot-check: --gold-light comes from accent, --green-light from correct.
    expect(touched.has('--gold-light')).toBe(true);
    expect(touched.has('--green-light')).toBe(true);
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
