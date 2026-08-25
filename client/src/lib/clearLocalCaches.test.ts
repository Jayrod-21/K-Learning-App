/**
 * clearLocalCaches (Phase 2.9 client cache-bleed fix) — unit coverage.
 *
 * Coverage:
 *   - removes every documented km.* per-user key;
 *   - leaves `km.install-dismissed` (device-scoped, deliberately excluded)
 *     untouched;
 *   - leaves a non-km key untouched (must never sweep another origin's/
 *     library's storage);
 *   - never throws when localStorage.removeItem throws (private-mode /
 *     quota posture).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearLocalCaches } from './clearLocalCaches';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('clearLocalCaches', () => {
  it('removes every documented per-user km.* key', () => {
    window.localStorage.setItem('km.settings', '{"name":"A"}');
    window.localStorage.setItem('km.toursSeen', '["tour-1"]');
    window.localStorage.setItem('km.theme', 'dark');
    window.localStorage.setItem('km.accent', 'mint');
    window.localStorage.setItem('km.textSize', 'lg');
    window.localStorage.setItem('km.grammar.drillCursor', '{"index":3}');

    clearLocalCaches();

    expect(window.localStorage.getItem('km.settings')).toBeNull();
    expect(window.localStorage.getItem('km.toursSeen')).toBeNull();
    expect(window.localStorage.getItem('km.theme')).toBeNull();
    expect(window.localStorage.getItem('km.accent')).toBeNull();
    expect(window.localStorage.getItem('km.textSize')).toBeNull();
    expect(window.localStorage.getItem('km.grammar.drillCursor')).toBeNull();
  });

  it('leaves km.install-dismissed untouched (device-scoped, not per-user)', () => {
    window.localStorage.setItem('km.install-dismissed', '1');
    clearLocalCaches();
    expect(window.localStorage.getItem('km.install-dismissed')).toBe('1');
  });

  it('never touches a non-km key', () => {
    window.localStorage.setItem('some-other-lib-key', 'keep-me');
    clearLocalCaches();
    expect(window.localStorage.getItem('some-other-lib-key')).toBe('keep-me');
  });

  it('is a harmless no-op when no km.* keys are present', () => {
    expect(() => clearLocalCaches()).not.toThrow();
  });

  it('swallows a localStorage failure (private-mode / quota posture) instead of throwing', () => {
    const spy = vi
      .spyOn(window.localStorage, 'removeItem')
      .mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError');
      });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(() => clearLocalCaches()).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();

    spy.mockRestore();
  });
});
