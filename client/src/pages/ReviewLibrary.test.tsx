/**
 * ReviewLibrary — the /review library index placeholder (P1.1).
 *
 * A pure directory page: link rows navigate (Mistakes + the three
 * Reference tabs via ?tab=), coming-soon rows are inert stubs.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import ReviewLibrary from './ReviewLibrary';

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return (
    <div data-testid="location">
      {loc.pathname}
      {loc.search}
    </div>
  );
}

function renderLibrary(): void {
  render(
    <MemoryRouter initialEntries={['/review']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <LocationProbe />
              <ReviewLibrary />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ReviewLibrary (P1.1 placeholder index)', () => {
  it('renders the library title and all six rows', () => {
    renderLibrary();
    expect(screen.getByText('복습 · Review')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Review library' });
    expect(list.querySelectorAll('[role="listitem"]')).toHaveLength(6);
  });

  it('links Mistakes to its re-homed /review/mistakes path', async () => {
    const user = userEvent.setup();
    renderLibrary();
    await user.click(screen.getByRole('button', { name: /Mistakes/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/review/mistakes');
  });

  it.each([
    ['Vocabulary', '/reference?tab=vocab'],
    ['Grammar', '/reference?tab=grammar'],
    ['Dictionary', '/reference?tab=dictionary'],
  ])('links %s to the Reference tab deep link %s', async (label, target) => {
    const user = userEvent.setup();
    renderLibrary();
    await user.click(screen.getByRole('button', { name: new RegExp(label) }));
    expect(screen.getByTestId('location')).toHaveTextContent(target);
  });

  it('renders past-exams and uploads as inert "Coming soon" rows', () => {
    renderLibrary();
    expect(screen.getByText('Past TOPIK exams')).toBeInTheDocument();
    expect(screen.getByText('Uploads')).toBeInTheDocument();
    expect(screen.getAllByText('Coming soon')).toHaveLength(2);
    // Stubs are not buttons — nothing to activate.
    expect(
      screen.queryByRole('button', { name: /Past TOPIK exams/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Uploads/ })).not.toBeInTheDocument();
  });
});
