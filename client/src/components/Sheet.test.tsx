/**
 * Sheet — Esc + backdrop close, body scroll lock + restore, open=false
 * renders nothing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sheet } from './Sheet';

afterEach(() => {
  // Defensive — RTL cleanup unmounts, but the body style hook restores on
  // unmount cleanly. Reset explicitly so a stray failure between tests
  // can't pollute later cases.
  document.body.style.overflow = '';
});

describe('Sheet', () => {
  it('renders nothing when open is false', () => {
    render(
      <Sheet open={false} onClose={() => undefined} ariaLabel="List detail">
        <div>body</div>
      </Sheet>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders a dialog with the supplied ariaLabel when open', () => {
    render(
      <Sheet open onClose={() => undefined} ariaLabel="List detail">
        <div>body content</div>
      </Sheet>,
    );
    const dialog = screen.getByRole('dialog', { name: 'List detail' });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('body content')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} ariaLabel="List detail">
        <div>body</div>
      </Sheet>,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on backdrop click', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} ariaLabel="List detail">
        <div>body</div>
      </Sheet>,
    );
    await user.click(screen.getByLabelText('Close sheet'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('locks and restores body scroll', () => {
    document.body.style.overflow = 'auto';
    const { unmount } = render(
      <Sheet open onClose={() => undefined} ariaLabel="List detail">
        <div>body</div>
      </Sheet>,
    );
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('auto');
  });
});

// ── Fix-pass batch-4: tone promotion (REVIEW_batch4-fidelity.md gap-d) ──

describe('Sheet — tone promotion', () => {
  it('omitting `tone` keeps the panel byte-identical to every pre-existing consumer (no km-tone--* class)', () => {
    render(
      <Sheet open onClose={() => undefined} ariaLabel="List detail">
        <div>body</div>
      </Sheet>,
    );
    const panel = screen.getByRole('dialog').className.split(' ');
    expect(panel).toEqual(['km-sheet__panel']);
    expect(panel.some((c) => c.startsWith('km-tone--'))).toBe(false);
  });

  it('passing `tone` adds the matching km-tone--<tone> class the panel resolves --km-tone from', () => {
    render(
      <Sheet open onClose={() => undefined} ariaLabel="List detail" tone="accent">
        <div>body</div>
      </Sheet>,
    );
    expect(screen.getByRole('dialog')).toHaveClass(
      'km-sheet__panel',
      'km-tone--accent',
    );
  });

  it('supports every DancheongRailTone value, including plain', () => {
    for (const tone of ['accent', 'blue', 'mint', 'ochre', 'plain'] as const) {
      const { unmount } = render(
        <Sheet open onClose={() => undefined} ariaLabel="List detail" tone={tone}>
          <div>body</div>
        </Sheet>,
      );
      expect(screen.getByRole('dialog')).toHaveClass(`km-tone--${tone}`);
      unmount();
    }
  });

  // jsdom does no layout/paint, so the visible Night glow / Day dancheong
  // stripe can't be asserted by rendering — pin the CSS source instead (same
  // technique as ChatFab.test.tsx's stylesheet-contract test).
  it('the shared stylesheet declares a Day dancheong top-stripe and a Night --km-tone glow for toned panels, and a plain/no-tone hairline that stays byte-identical to the pre-promotion panel', () => {
    const stylesheet = readFileSync(
      join(cwd(), 'src', 'styles', 'index.css'),
      'utf8',
    );

    const basePanel = /\.km-sheet__panel\s*\{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    expect(basePanel).toContain('border-top: 1px solid var(--line-strong);');

    const dayToned =
      /\.km-sheet__panel\.km-tone--accent,[\s\S]*?\.km-sheet__panel\.km-tone--ochre\s*\{[^}]*\}/.exec(
        stylesheet,
      )?.[0] ?? '';
    expect(dayToned).toContain('border-image: repeating-linear-gradient(');

    const nightToned =
      /\[data-theme="dark"\] \.km-sheet__panel\.km-tone--accent,[\s\S]*?\[data-theme="dark"\] \.km-sheet__panel\.km-tone--ochre\s*\{[^}]*\}/.exec(
        stylesheet,
      )?.[0] ?? '';
    expect(nightToned).toContain('var(--km-tone)');
    expect(nightToned).toMatch(/box-shadow:/);
  });
});
