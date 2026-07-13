/**
 * CollapsibleTile — disclosure toggling (click + native keyboard),
 * defaultCollapsed, the aria wiring (`aria-expanded`, `aria-controls` →
 * body id, body hidden + inert while collapsed), and the `surface` variant
 * (`'card'` default vs. `'city'`, the CityCard-backed signboard — see
 * REVIEW_batch1-fidelity.md C-1).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CollapsibleTile } from './CollapsibleTile';
import type { CollapsibleTileProps } from './CollapsibleTile';

function renderTile(
  props: Partial<
    Pick<
      CollapsibleTileProps,
      'defaultCollapsed' | 'className' | 'surface' | 'tone' | 'rail' | 'feat'
    >
  > = {},
): ReturnType<typeof render> {
  return render(
    <CollapsibleTile title="Study streak" {...props}>
      <p>BODY CONTENT</p>
    </CollapsibleTile>,
  );
}

/** The body region the header's aria-controls points at. */
function bodyRegion(): HTMLElement {
  const header = screen.getByRole('button', { name: 'Study streak' });
  const bodyId = header.getAttribute('aria-controls');
  if (bodyId === null) throw new Error('header has no aria-controls');
  const body = document.getElementById(bodyId);
  if (body === null) throw new Error('aria-controls points at nothing');
  return body;
}

describe('CollapsibleTile', () => {
  it('renders open by default: header expanded, body visible', () => {
    renderTile();

    const header = screen.getByRole('button', { name: 'Study streak' });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('BODY CONTENT')).toBeInTheDocument();
    expect(bodyRegion()).toHaveAttribute('aria-hidden', 'false');
    expect(bodyRegion()).not.toHaveAttribute('inert');
  });

  it('honors defaultCollapsed: body mounted but hidden and inert', () => {
    renderTile({ defaultCollapsed: true });

    expect(
      screen.getByRole('button', { name: 'Study streak' }),
    ).toHaveAttribute('aria-expanded', 'false');
    // Mounted (the aria-controls target must exist) but out of the
    // accessibility tree and keyboard order.
    const body = bodyRegion();
    expect(body).toHaveAttribute('aria-hidden', 'true');
    expect(body).toHaveAttribute('inert');
  });

  it('toggles closed and back open on header clicks', async () => {
    const user = userEvent.setup();
    renderTile();
    const header = screen.getByRole('button', { name: 'Study streak' });

    await user.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(bodyRegion()).toHaveAttribute('aria-hidden', 'true');

    await user.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(bodyRegion()).toHaveAttribute('aria-hidden', 'false');
  });

  it('toggles from the keyboard (native button: Space)', async () => {
    const user = userEvent.setup();
    renderTile();
    const header = screen.getByRole('button', { name: 'Study streak' });

    header.focus();
    await user.keyboard(' ');

    expect(header).toHaveAttribute('aria-expanded', 'false');
  });

  it('wires aria-controls to the body region id both ways', () => {
    renderTile();
    const header = screen.getByRole('button', { name: 'Study streak' });
    expect(header.getAttribute('aria-controls')).toBe(bodyRegion().id);
    expect(bodyRegion()).toContainElement(screen.getByText('BODY CONTENT'));
  });

  it('forwards className onto the Card root', () => {
    const { container } = renderTile({ className: 'extra-class' });
    const root = container.querySelector('.km-collapsible');
    expect(root).not.toBeNull();
    expect(root).toHaveClass('km-card', 'extra-class');
  });

  // ── surface variant (C-1 fix: a shared CityCard-backed signboard) ──

  it('defaults to the plain Card surface when `surface` is omitted (backward-compatible)', () => {
    const { container } = renderTile();
    const root = container.querySelector('.km-collapsible');
    expect(root).not.toBeNull();
    expect(root).toHaveClass('km-card');
    expect(root).not.toHaveClass('km-citycard');
  });

  it('surface="city" renders a CityCard root carrying tone/rail/feat, with identical a11y wiring', () => {
    const { container } = renderTile({
      surface: 'city',
      tone: 'blue',
      rail: true,
      feat: true,
      className: 'extra-class',
    });
    const root = container.querySelector('.km-collapsible');
    expect(root).not.toBeNull();
    expect(root).toHaveClass(
      'km-citycard',
      'km-tone--blue',
      'km-citycard--feat',
      'extra-class',
    );
    expect(root).not.toHaveClass('km-card');
    // The DancheongRail `rail` prop composes as a decorative aria-hidden
    // sibling inside the CityCard root — confirms it actually forwarded.
    expect(container.querySelector('.km-dancheong-rail')).not.toBeNull();

    // Same disclosure contract as the `card` surface.
    const header = screen.getByRole('button', { name: 'Study streak' });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('BODY CONTENT')).toBeInTheDocument();
  });

  it('surface="city" without `rail` renders no DancheongRail (rail defaults false, like CityCard)', () => {
    const { container } = renderTile({ surface: 'city' });
    expect(container.querySelector('.km-dancheong-rail')).toBeNull();
  });
});
