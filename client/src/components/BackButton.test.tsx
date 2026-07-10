/**
 * BackButton — render + accessible name (bare and labelled), explicit-route
 * navigation via `to`, history-back fallback when `to` is omitted, and
 * className forwarding. Router assertions use a `useLocation` probe inside
 * a MemoryRouter (same pattern as the other router-aware component tests).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { JSX, ReactNode } from 'react';
import { BackButton } from './BackButton';

/** Prints the current pathname so tests can assert where navigation landed. */
function LocationProbe(): JSX.Element {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderWithRouter(
  ui: ReactNode,
  {
    entries = ['/parent/child'],
    initialIndex,
  }: { entries?: string[]; initialIndex?: number } = {},
): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={initialIndex}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              {ui}
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('BackButton', () => {
  it('renders a real button named "Back" when no label is given', () => {
    renderWithRouter(<BackButton to="/parent" />);
    const button = screen.getByRole('button', { name: 'Back' });
    expect(button).toHaveAttribute('type', 'button');
  });

  it('folds the label into both the visible text and the accessible name', () => {
    renderWithRouter(<BackButton to="/vocab" label="Vocabulary" />);
    const button = screen.getByRole('button', { name: 'Back to Vocabulary' });
    expect(button).toHaveTextContent('Vocabulary');
  });

  it('navigates to the explicit parent route when `to` is set', async () => {
    const user = userEvent.setup();
    renderWithRouter(<BackButton to="/library" label="Library" />);

    await user.click(screen.getByRole('button', { name: 'Back to Library' }));

    expect(screen.getByTestId('location')).toHaveTextContent('/library');
  });

  it('falls back to history back when `to` is omitted', async () => {
    const user = userEvent.setup();
    renderWithRouter(<BackButton />, {
      entries: ['/first', '/second'],
      initialIndex: 1,
    });
    expect(screen.getByTestId('location')).toHaveTextContent('/second');

    await user.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByTestId('location')).toHaveTextContent('/first');
  });

  it('routes to the default fallback (/) instead of exiting when the page is the first history entry', async () => {
    // Deep-link scenario: the sub-page is the FIRST entry in the tab's
    // history (react-router keys it "default"), so navigate(-1) would be a
    // raw browser back out of the app. The guard must route home instead.
    const user = userEvent.setup();
    renderWithRouter(<BackButton />, { entries: ['/learn/hanja'] });
    expect(screen.getByTestId('location')).toHaveTextContent('/learn/hanja');

    await user.click(screen.getByRole('button', { name: 'Back' }));

    // Exact match — toHaveTextContent substring-matches, and "/" is a
    // substring of the buggy no-op outcome "/learn/hanja".
    expect(screen.getByTestId('location').textContent).toBe('/');
  });

  it('honours a custom fallbackTo on an empty history', async () => {
    const user = userEvent.setup();
    renderWithRouter(<BackButton fallbackTo="/review" />, {
      entries: ['/review/mistakes'],
    });

    await user.click(screen.getByRole('button', { name: 'Back' }));

    // Exact — "/review" is a substring of the buggy outcome "/review/mistakes".
    expect(screen.getByTestId('location').textContent).toBe('/review');
  });

  it('forwards className onto the button', () => {
    renderWithRouter(<BackButton to="/parent" className="extra-class" />);
    expect(screen.getByRole('button', { name: 'Back' })).toHaveClass(
      'km-backbtn',
      'extra-class',
    );
  });
});
