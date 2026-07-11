/**
 * LibrarySubnav — the Review-library section switcher.
 *
 * P3b: each section renders its nav-manifest en/kr pair through
 * `<Bilingual compact/>`. Coverage:
 *
 *   - all three sections render, with the BILINGUAL accessible name
 *     ("단어 · Vocabulary" — the compact sr-only reading, Korean-first
 *     default) while only the primary language is visible;
 *   - `aria-current="page"` tracks the current route;
 *   - tapping another section navigates (aria-current follows).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { LibrarySubnav } from './LibrarySubnav';

function renderAt(path: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LibrarySubnav />
    </MemoryRouter>,
  );
}

/** The text a sighted user sees (excludes the .km-sr-only duplicate). */
function visibleText(el: Element): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.km-sr-only').forEach((sr) => {
    sr.remove();
  });
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('LibrarySubnav (P3b bilingual chrome)', () => {
  it('names the landmark "Library sections" — the F-043 tab name, not the retired "Review library"', () => {
    renderAt('/review/vocab');
    // AT users navigate by this landmark name; it must match the renamed
    // Library tab, not the pre-F-043 "Review library" copy.
    expect(
      screen.getByRole('navigation', { name: 'Library sections' }),
    ).toBeInTheDocument();
  });

  it('renders the three sections with bilingual accessible names, Korean visible by default', () => {
    renderAt('/review/vocab');
    // Accessible names carry BOTH languages (compact sr-only reading);
    // visually the Korean-first default shows the Korean label alone.
    const vocab = screen.getByRole('button', { name: '단어 · Vocabulary' });
    const dict = screen.getByRole('button', { name: '전체 단어 · All Words' });
    const grammar = screen.getByRole('button', { name: '문법 · Grammar' });
    expect(visibleText(vocab)).toBe('단어');
    expect(visibleText(dict)).toBe('전체 단어');
    expect(visibleText(grammar)).toBe('문법');
  });

  it('marks only the current section with aria-current="page"', () => {
    renderAt('/review/dictionary');
    expect(
      screen.getByRole('button', { name: '전체 단어 · All Words' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(
      screen.getByRole('button', { name: '단어 · Vocabulary' }),
    ).not.toHaveAttribute('aria-current');
    expect(
      screen.getByRole('button', { name: '문법 · Grammar' }),
    ).not.toHaveAttribute('aria-current');
  });

  it('navigates on tap — aria-current follows the route', async () => {
    const user = userEvent.setup();
    renderAt('/review/vocab');
    await user.click(screen.getByRole('button', { name: '문법 · Grammar' }));
    expect(
      screen.getByRole('button', { name: '문법 · Grammar' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(
      screen.getByRole('button', { name: '단어 · Vocabulary' }),
    ).not.toHaveAttribute('aria-current');
  });
});
