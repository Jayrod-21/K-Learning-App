/**
 * useModalA11y — Tab loop both directions, Esc → onClose (no
 * stopPropagation), focus restoration on unmount.
 *
 * The hook owns three behaviours that used to be inlined in three modal
 * components. Each test pins one contract:
 *   1. Tab from the last focusable wraps to the first.
 *   2. Shift-Tab from the first focusable wraps to the last.
 *   3. Esc fires `onClose` and does NOT stop propagation, so a nested
 *      modal up the stack can also receive the press.
 *   4. Initial focus lands on the supplied `initialFocusRef` (or the
 *      first focusable when no ref is provided).
 *   5. Focus restores to the previously-active element on close.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState, type JSX } from 'react';
import { useModalA11y } from './useModalA11y';

interface HarnessProps {
  onClose: () => void;
  useInitialFocusRef?: boolean;
  outerEscHandler?: () => void;
}

function Harness({
  onClose,
  useInitialFocusRef = false,
  outerEscHandler,
}: HarnessProps): JSX.Element {
  const [open, setOpen] = useState(true);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const initialFocusRef = useRef<HTMLButtonElement | null>(null);
  useModalA11y({
    open,
    onClose: () => {
      onClose();
      setOpen(false);
    },
    containerRef,
    initialFocusRef: useInitialFocusRef ? initialFocusRef : undefined,
  });

  // Outer Esc listener — added BEFORE the hook's by virtue of being on
  // the document/body capture phase. The hook attaches at the window
  // level without `stopPropagation`, so both should fire.
  if (outerEscHandler) {
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') outerEscHandler();
      },
      { once: true },
    );
  }

  if (!open) return <button data-testid="trigger">Reopen</button>;
  return (
    <div ref={containerRef} role="dialog" aria-label="harness">
      <button>First</button>
      <button ref={initialFocusRef}>Initial</button>
      <button>Third</button>
      <button>Last</button>
    </div>
  );
}

afterEach(() => {
  document.body.style.overflow = '';
});

describe('useModalA11y', () => {
  it('autoFocuses the first focusable when no initialFocusRef is passed', () => {
    render(
      <>
        <button data-testid="trigger">Trigger</button>
        <Harness onClose={vi.fn()} />
      </>,
    );
    // First focusable inside the dialog is the "First" button.
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'First' }),
    );
  });

  it('autoFocuses the initialFocusRef when supplied', () => {
    render(
      <>
        <button data-testid="trigger">Trigger</button>
        <Harness onClose={vi.fn()} useInitialFocusRef />
      </>,
    );
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Initial' }),
    );
  });

  it('Tab from the last focusable wraps back to the first', async () => {
    const user = userEvent.setup();
    render(<Harness onClose={vi.fn()} />);
    // Send focus to Last manually.
    screen.getByRole('button', { name: 'Last' }).focus();
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'First' }),
    );
  });

  it('Shift+Tab from the first focusable wraps to the last', async () => {
    const user = userEvent.setup();
    render(<Harness onClose={vi.fn()} />);
    screen.getByRole('button', { name: 'First' }).focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Last' }),
    );
  });

  it('Esc fires onClose without stopping propagation', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const outer = vi.fn();
    render(<Harness onClose={onClose} outerEscHandler={outer} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    // The outer listener should also see the same press — no
    // stopPropagation lock-out.
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it('restores focus to the previously-active element on close', async () => {
    const user = userEvent.setup();
    // Outer button is focused before the modal opens. The hook
    // captures `document.activeElement` on its open-edge effect and
    // restores it via queueMicrotask on close.
    function Outer(): JSX.Element {
      const [showModal, setShowModal] = useState(false);
      return (
        <>
          <button
            data-testid="trigger"
            onClick={() => {
              setShowModal(true);
            }}
          >
            Open
          </button>
          {showModal ? (
            <Harness
              onClose={() => {
                setShowModal(false);
              }}
            />
          ) : null}
        </>
      );
    }
    render(<Outer />);
    const trigger = screen.getByTestId('trigger');
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    await user.click(trigger);
    // Modal now mounted; focus inside the dialog.
    expect(document.activeElement).not.toBe(trigger);
    await user.keyboard('{Escape}');
    // Wait one microtask tick — happy-dom drains them synchronously
    // between awaits, so the focus restore has fired by the time we
    // re-query.
    await Promise.resolve();
    expect(document.activeElement).toBe(trigger);
  });

  it('open=false is a no-op (no body scroll lock, no listeners)', () => {
    document.body.style.overflow = 'auto';
    function Wrap(): JSX.Element {
      const containerRef = useRef<HTMLDivElement | null>(null);
      useModalA11y({
        open: false,
        onClose: vi.fn(),
        containerRef,
      });
      return <div ref={containerRef}>closed</div>;
    }
    render(<Wrap />);
    expect(document.body.style.overflow).toBe('auto');
  });
});
