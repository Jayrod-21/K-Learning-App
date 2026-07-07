/**
 * Legacy redirect shims — every pre-overhaul path must land on its new
 * namespaced home. Mounts the REAL Route elements from
 * `legacyRedirectRoutes()` (the exact ones App.tsx renders) next to stub
 * targets and walks the whole table, plus the tab-aware `/reference` shim
 * (P1.2 — the Reference page dissolved into the Review library).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import { LEGACY_REDIRECTS, legacyRedirectRoutes } from './redirects';
import { referenceTarget } from './referenceTarget';

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return (
    <div data-testid="location">
      {loc.pathname}
      {loc.search}
    </div>
  );
}

function renderAt(oldPath: string): void {
  render(
    <MemoryRouter initialEntries={[oldPath]}>
      <Routes>
        {legacyRedirectRoutes()}
        {/* Catch-all probe — renders wherever the shim lands. */}
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('legacy redirect shims (P1.1/P1.2)', () => {
  it.each(
    LEGACY_REDIRECTS.filter((r) => r.from !== 'reference').map(
      (r) => [`/${r.from}`, r.to] as const,
    ),
  )('redirects %s → %s', (oldPath, newPath) => {
    renderAt(oldPath);
    expect(screen.getByTestId('location')).toHaveTextContent(newPath);
  });

  it('covers exactly the 8 re-homed paths', () => {
    expect(LEGACY_REDIRECTS.map((r) => r.from).sort()).toEqual([
      'grammar',
      'hanja',
      'mistakes',
      'reading',
      'reference',
      'topik',
      'ttmik',
      'writing',
    ]);
  });

  it('never shims /review or /chat (live routes with new/unchanged meaning)', () => {
    const froms = LEGACY_REDIRECTS.map((r) => r.from);
    expect(froms).not.toContain('review');
    expect(froms).not.toContain('chat');
  });

  it('repoints the pre-existing /reading shim at /learn/listen (not /ttmik)', () => {
    const reading = LEGACY_REDIRECTS.find((r) => r.from === 'reading');
    expect(reading?.to).toBe('/learn/listen');
  });

  describe('the /reference shim is TAB-AWARE (P1.2 dissolution)', () => {
    it.each([
      ['/reference', '/review/vocab'],
      ['/reference?tab=vocab', '/review/vocab'],
      ['/reference?tab=dictionary', '/review/dictionary'],
      ['/reference?tab=grammar', '/review/grammar'],
      ['/reference?tab=lists', '/review/vocab?tab=lists'],
      ['/reference?tab=nonsense', '/review/vocab'],
    ])('redirects %s → %s', (oldPath, newPath) => {
      renderAt(oldPath);
      expect(screen.getByTestId('location')).toHaveTextContent(newPath);
    });

    it('referenceTarget maps every old tab onto its library home', () => {
      expect(referenceTarget(null)).toBe('/review/vocab');
      expect(referenceTarget('vocab')).toBe('/review/vocab');
      expect(referenceTarget('dictionary')).toBe('/review/dictionary');
      expect(referenceTarget('grammar')).toBe('/review/grammar');
      expect(referenceTarget('lists')).toBe('/review/vocab?tab=lists');
      expect(referenceTarget('bogus')).toBe('/review/vocab');
    });
  });
});
