/**
 * readingSelection — persistence + untrusted-value validation.
 *
 * Covers the round-trip (save → load) and the storage-tamper threat model:
 * a corrupt / hostile localStorage value must degrade to `null` (default
 * load) rather than driving a malformed `/reading/units/:corpus/:unitId`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  READING_SELECTION_STORAGE_KEY,
  loadReadingSelection,
  saveReadingSelection,
} from './readingSelection';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('saveReadingSelection / loadReadingSelection', () => {
  it('round-trips a valid selection', () => {
    saveReadingSelection({ corpus: 'iyagi', unitId: 42, title: '에피소드 42' });
    expect(loadReadingSelection()).toEqual({
      corpus: 'iyagi',
      unitId: 42,
      title: '에피소드 42',
    });
  });

  it('returns null when nothing is stored', () => {
    expect(loadReadingSelection()).toBeNull();
  });
});

describe('loadReadingSelection — untrusted value validation', () => {
  it('rejects corrupt JSON', () => {
    window.localStorage.setItem(READING_SELECTION_STORAGE_KEY, '{not json');
    expect(loadReadingSelection()).toBeNull();
  });

  it('rejects an unknown corpus', () => {
    window.localStorage.setItem(
      READING_SELECTION_STORAGE_KEY,
      JSON.stringify({ corpus: 'wikipedia', unitId: 1 }),
    );
    expect(loadReadingSelection()).toBeNull();
  });

  it.each([
    ['non-integer unitId', { corpus: 'ttmik', unitId: 1.5, title: 'x' }],
    ['zero unitId', { corpus: 'ttmik', unitId: 0, title: 'x' }],
    ['negative unitId', { corpus: 'ttmik', unitId: -3, title: 'x' }],
    ['string unitId', { corpus: 'ttmik', unitId: '4', title: 'x' }],
    ['missing unitId', { corpus: 'ttmik', title: 'x' }],
    ['array, not object', [1, 2, 3]],
    ['bare number', 7],
  ])('rejects %s', (_label, value) => {
    window.localStorage.setItem(
      READING_SELECTION_STORAGE_KEY,
      JSON.stringify(value),
    );
    expect(loadReadingSelection()).toBeNull();
  });

  it('coerces a missing/garbled title to an empty string (display-only)', () => {
    window.localStorage.setItem(
      READING_SELECTION_STORAGE_KEY,
      JSON.stringify({ corpus: 'ttmik', unitId: 5, title: 99 }),
    );
    expect(loadReadingSelection()).toEqual({
      corpus: 'ttmik',
      unitId: 5,
      title: '',
    });
  });
});

describe('saveReadingSelection — failure safety', () => {
  it('swallows a storage write failure without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });

    expect(() => {
      saveReadingSelection({ corpus: 'ttmik', unitId: 1, title: 'x' });
    }).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});
