/**
 * ReviewLibrary — the /review library index (P1.2 assembly).
 *
 * A directory page over REAL library routes: link rows navigate to
 * /review/mistakes, /review/vocab, /review/dictionary, /review/grammar;
 * the quick-launch hot-buttons jump into the LEARN flow; coming-soon rows
 * (past exams, uploads) are designed inert placeholders.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

describe('ReviewLibrary (P1.2 index)', () => {
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
    ['Vocabulary', '/review/vocab'],
    ['Dictionary', '/review/dictionary'],
    ['Grammar', '/review/grammar'],
  ])(
    'links %s to its first-class library route %s (Reference dissolved)',
    async (label, target) => {
      const user = userEvent.setup();
      renderLibrary();
      // Scope to the directory list — the quick-launch chips reuse similar
      // wording ("Vocab flashcards", "Grammar drill").
      const list = screen.getByRole('list', { name: 'Review library' });
      await user.click(
        within(list).getByRole('button', { name: new RegExp(`^${label}`) }),
      );
      expect(screen.getByTestId('location')).toHaveTextContent(target);
    },
  );

  it.each([
    ['Vocab flashcards', '/learn/vocab'],
    ['Grammar drill', '/learn/grammar'],
  ])(
    'quick-launch hot-button %s jumps into the LEARN flow at %s',
    async (label, target) => {
      const user = userEvent.setup();
      renderLibrary();
      const quick = screen.getByRole('group', { name: 'Quick launch' });
      await user.click(within(quick).getByRole('button', { name: label }));
      expect(screen.getByTestId('location')).toHaveTextContent(target);
    },
  );

  it('renders past-exams and uploads as inert "Coming soon" rows', () => {
    renderLibrary();
    expect(screen.getByText('Past TOPIK exams')).toBeInTheDocument();
    expect(screen.getByText('Uploads')).toBeInTheDocument();
    expect(screen.getAllByText('Coming soon')).toHaveLength(2);
    // Placeholders are not buttons — nothing to activate.
    expect(
      screen.queryByRole('button', { name: /Past TOPIK exams/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Uploads/ })).not.toBeInTheDocument();
  });

  it('no row points at the retired /reference page', () => {
    renderLibrary();
    // The P1.1 placeholder linked rows to /reference?tab=… — those links are
    // gone with the dissolution (the shim still redirects old bookmarks).
    for (const btn of screen.getAllByRole('button')) {
      expect(btn.getAttribute('href') ?? '').not.toContain('/reference');
    }
  });
});
