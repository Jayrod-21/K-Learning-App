/**
 * Legacy redirect shims — every pre-overhaul flat path must land on its
 * new namespaced home. Mounts the REAL Route elements from
 * `legacyRedirectRoutes()` (the exact ones App.tsx renders) next to stub
 * targets and walks the whole table.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LEGACY_REDIRECTS, legacyRedirectRoutes } from './redirects';

function renderAt(oldPath: string): void {
  render(
    <MemoryRouter initialEntries={[oldPath]}>
      <Routes>
        {legacyRedirectRoutes()}
        {LEGACY_REDIRECTS.map((r) => (
          <Route key={r.to} path={r.to} element={<div>AT {r.to}</div>} />
        ))}
      </Routes>
    </MemoryRouter>,
  );
}

describe('legacy redirect shims (P1.1)', () => {
  it.each(LEGACY_REDIRECTS.map((r) => [`/${r.from}`, r.to] as const))(
    'redirects %s → %s',
    (oldPath, newPath) => {
      renderAt(oldPath);
      expect(screen.getByText(`AT ${newPath}`)).toBeInTheDocument();
    },
  );

  it('covers exactly the 7 re-homed flat paths', () => {
    expect(LEGACY_REDIRECTS.map((r) => r.from).sort()).toEqual(
      ['grammar', 'hanja', 'mistakes', 'reading', 'topik', 'ttmik', 'writing'],
    );
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
});
