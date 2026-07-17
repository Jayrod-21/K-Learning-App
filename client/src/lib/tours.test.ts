/**
 * Tour registry — structural integrity of the tour data (the runner and the
 * trigger logic are covered in tourDriver/TourProvider tests):
 *   - ids are unique and the derived TOUR_IDS list matches the array,
 *   - the first-run tour exists, is path-less, and is the only path-less one,
 *   - every anchored step targets a `[data-tour="…"]` selector (the F-098
 *     contract — never a class name), and every tour has 3–9 steps with
 *     non-empty copy,
 *   - surfaceTourForPath maps every routed surface (and the /uploads/:id
 *     prefix rule) correctly.
 */
import { describe, expect, it } from 'vitest';
import {
  FIRST_RUN_TOUR_ID,
  isTourId,
  surfaceTourForPath,
  tourById,
  TOUR_IDS,
  TOURS,
} from './tours';

describe('tour registry', () => {
  it('has unique ids and a matching TOUR_IDS derivation', () => {
    expect(new Set(TOUR_IDS).size).toBe(TOURS.length);
    expect(TOUR_IDS).toEqual(TOURS.map((t) => t.id));
  });

  it('has exactly one path-less tour: the first-run tour', () => {
    const pathless = TOURS.filter((t) => t.path === null);
    expect(pathless.map((t) => t.id)).toEqual([FIRST_RUN_TOUR_ID]);
  });

  it('every tour has 3–9 steps with non-empty title/body and a label pair', () => {
    for (const t of TOURS) {
      expect(t.steps.length, t.id).toBeGreaterThanOrEqual(3);
      expect(t.steps.length, t.id).toBeLessThanOrEqual(9);
      expect(t.label, t.id).not.toBe('');
      expect(t.kr, t.id).not.toBe('');
      for (const s of t.steps) {
        expect(s.title, t.id).not.toBe('');
        expect(s.body, t.id).not.toBe('');
      }
    }
  });

  it('anchored steps target data-tour attributes, never class names (F-098)', () => {
    for (const t of TOURS) {
      for (const s of t.steps) {
        if (s.target === undefined) continue;
        expect(s.target, `${t.id}: ${s.target}`).toMatch(
          /^\[data-tour="[a-z0-9-]+"\]$/,
        );
      }
    }
  });

  it('prefix tours end their path with a slash (parent route must not match)', () => {
    for (const t of TOURS) {
      if (t.match === 'prefix') {
        expect(t.path, t.id).toMatch(/\/$/);
      }
    }
  });

  it('tourById resolves every registered id', () => {
    for (const id of TOUR_IDS) {
      expect(tourById(id).id).toBe(id);
    }
  });

  it('isTourId narrows known ids and rejects strangers', () => {
    expect(isTourId('hanja')).toBe(true);
    expect(isTourId('first-run')).toBe(true);
    expect(isTourId('not-a-tour')).toBe(false);
    expect(isTourId(42)).toBe(false);
  });

  describe('surfaceTourForPath', () => {
    it('maps each exact surface route to its tour', () => {
      expect(surfaceTourForPath('/review')?.id).toBe('library');
      expect(surfaceTourForPath('/learn/topik')?.id).toBe('topik');
      expect(surfaceTourForPath('/learn/listen')?.id).toBe('listen');
      expect(surfaceTourForPath('/learn/vocab')?.id).toBe('flashcards');
      expect(surfaceTourForPath('/learn/grammar')?.id).toBe('grammar');
      expect(surfaceTourForPath('/learn/writing')?.id).toBe('writing');
      expect(surfaceTourForPath('/learn/hanja')?.id).toBe('hanja');
      expect(surfaceTourForPath('/learn/reading')?.id).toBe('reading');
      expect(surfaceTourForPath('/uploads')?.id).toBe('uploads');
    });

    it('maps /uploads/:id (any id) to the viewer tour, not the parent', () => {
      expect(surfaceTourForPath('/uploads/42')?.id).toBe('upload-viewer');
      expect(surfaceTourForPath('/uploads/abc-def')?.id).toBe('upload-viewer');
      // The bare parent (with or without trailing slash ambiguity) is NOT
      // the viewer: exact wins, and a bare '/uploads/' has no id segment.
      expect(surfaceTourForPath('/uploads')?.id).toBe('uploads');
    });

    it('returns null for surfaces without a tour', () => {
      expect(surfaceTourForPath('/')).toBeNull();
      expect(surfaceTourForPath('/progress')).toBeNull();
      expect(surfaceTourForPath('/settings')).toBeNull();
      expect(surfaceTourForPath('/chat')).toBeNull();
      expect(surfaceTourForPath('/review/mistakes')).toBeNull();
    });
  });
});
