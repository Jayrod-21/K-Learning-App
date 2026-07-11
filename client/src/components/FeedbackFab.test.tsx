/**
 * FeedbackFab (F-127) — dedicated component test, addressing REVIEW_client.md
 * SHOULD-FIX #2. `Shell.test.tsx` already covers the visibility matrix and
 * the router-state hand-off (rendered as a Shell-level sibling of ChatFab);
 * this file is scoped to two things Shell.test.tsx does NOT pin:
 *
 *   1. The a11y contract in isolation — real `<button>`, correct
 *      `aria-label`, the shared `focusring` class, and native keyboard
 *      activation (Enter/Space), same convention as `HanjaCell.test.tsx`.
 *   2. The CSS placement contract — `FeedbackFab.css` is colocated (not
 *      `styles/index.css`, unlike ChatFab), so it isn't covered by
 *      ChatFab's own stylesheet-contract test. The module header's
 *      explicit claim is that the FAB sits at the OPPOSITE corner
 *      (top-right) from ChatFab (bottom-anchored) so the two never
 *      collide (see REVIEW_client.md's "Coordination Observations"). A
 *      future edit that moved this rule to `bottom` (ChatFab's zone)
 *      would silently reintroduce the overlap the header comment claims
 *      is impossible — this test would catch it.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { FeedbackFab } from './FeedbackFab';

const FAB_NAME = 'Report feedback · 피드백 보내기';

function renderFab(): void {
  render(
    <MemoryRouter initialEntries={['/progress']}>
      <FeedbackFab />
    </MemoryRouter>,
  );
}

describe('FeedbackFab — a11y contract', () => {
  it('renders a real <button> with the correct accessible name', () => {
    renderFab();
    const btn = screen.getByRole('button', { name: FAB_NAME });
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('type', 'button');
    expect(btn).toHaveAttribute('aria-label', FAB_NAME);
  });

  it('carries the shared focusring class (visible-focus token)', () => {
    renderFab();
    expect(screen.getByRole('button', { name: FAB_NAME }).className).toMatch(
      /\bfocusring\b/,
    );
  });

  it('is reachable by keyboard focus and activates on Enter', async () => {
    const user = userEvent.setup();
    renderFab();
    const btn = screen.getByRole('button', { name: FAB_NAME });

    btn.focus();
    expect(btn).toHaveFocus();
    await user.keyboard('{Enter}');

    // Native <button> keyboard handling fires the same onClick as a
    // pointer click — Tickets.tsx isn't mounted here, so the assertion is
    // on the resulting navigation (the FAB's whole job), not a mock.
    expect(screen.queryByRole('button', { name: FAB_NAME })).not.toBeInTheDocument();
  });

  it('activates on Space', async () => {
    const user = userEvent.setup();
    renderFab();
    const btn = screen.getByRole('button', { name: FAB_NAME });

    btn.focus();
    await user.keyboard(' ');

    expect(screen.queryByRole('button', { name: FAB_NAME })).not.toBeInTheDocument();
  });
});

describe('FeedbackFab — CSS placement contract (top-right, never ChatFab\'s corner)', () => {
  // happy-dom does no layout, so the actual on-screen non-overlap can't be
  // driven here (same limitation ChatFab's own stylesheet-contract test
  // works around) — pin the stylesheet's claims instead: `position: fixed`,
  // anchored from `top` (NOT `bottom`, which is ChatFab's zone in
  // styles/index.css), with a `right` offset.
  it('is anchored top-right and fixed-position — never bottom (ChatFab\'s corner)', () => {
    const stylesheet = readFileSync(
      join(cwd(), 'src', 'components', 'FeedbackFab.css'),
      'utf8',
    );
    const rule = /\.km-feedbackfab\s*\{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    expect(rule).not.toBe('');
    expect(rule).toContain('position: fixed;');
    expect(rule).toMatch(/\btop:\s*max\(/);
    expect(rule).toMatch(/\bright:\s*max\(/);
    // The whole point of the top/bottom split (per the module header) is
    // that this rule must never declare a `bottom` offset — that's
    // ChatFab's anchor, and a future edit adding one here would be exactly
    // the silent-overlap regression the header comment warns about.
    expect(rule).not.toMatch(/[^-]\bbottom:/);
  });
});
