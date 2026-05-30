/**
 * Sheet — Esc + backdrop close, body scroll lock + restore, open=false
 * renders nothing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
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
