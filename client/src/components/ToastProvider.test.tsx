/**
 * ToastProvider / useToast — verifies the global toast system:
 *   - a toast renders into the portal with tone-appropriate ARIA,
 *   - auto-dismiss fires after the duration (fake timers),
 *   - manual dismiss removes the toast,
 *   - the retry action fires the caller's handler then dismisses,
 *   - the stacking cap (3) holds with overflow queued,
 *   - hover pauses the auto-dismiss countdown,
 *   - useToast throws outside a provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX, ReactNode } from 'react';
import { ToastProvider } from './ToastProvider';
import { useToast } from './useToast';

function wrapper({ children }: { children: ReactNode }): JSX.Element {
  return <ToastProvider>{children}</ToastProvider>;
}

describe('useToast', () => {
  it('throws when used outside a ToastProvider', () => {
    // Silence the React error-boundary console noise for this expected throw.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useToast())).toThrow(
      /must be used inside <ToastProvider>/,
    );
    spy.mockRestore();
  });
});

describe('ToastProvider', () => {
  it('renders a toast with the given message', () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    act(() => {
      result.current.toast({ message: 'Saved', tone: 'success' });
    });
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('uses role=alert for errors and role=status for info/success', () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    act(() => {
      result.current.toast({ message: 'Boom', tone: 'error' });
      result.current.toast({ message: 'Heads up', tone: 'info' });
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Boom');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Heads up');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('auto-dismisses after the duration', () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useToast(), { wrapper });
      act(() => {
        result.current.toast({ message: 'Bye', tone: 'info', durationMs: 1000 });
      });
      expect(screen.getByText('Bye')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.queryByText('Bye')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not auto-dismiss a sticky toast (durationMs <= 0)', () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useToast(), { wrapper });
      act(() => {
        result.current.toast({ message: 'Stay', tone: 'error', durationMs: 0 });
      });
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByText('Stay')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dismisses manually via the × button', async () => {
    const user = userEvent.setup();
    const { result } = renderHook(() => useToast(), { wrapper });
    act(() => {
      result.current.toast({ message: 'Close me', tone: 'info', durationMs: 0 });
    });
    await user.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByText('Close me')).not.toBeInTheDocument();
  });

  it('fires the retry action then dismisses', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { result } = renderHook(() => useToast(), { wrapper });
    act(() => {
      result.current.toast({
        message: 'Failed',
        tone: 'error',
        durationMs: 0,
        action: { label: 'Retry', onClick },
      });
    });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
  });

  it('caps the visible stack at 3, queueing the rest', () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    act(() => {
      for (let i = 1; i <= 5; i += 1) {
        result.current.toast({ message: `T${String(i)}`, tone: 'info', durationMs: 0 });
      }
    });
    // Only the first 3 are visible (T1–T3); T4/T5 are queued.
    expect(screen.getByText('T1')).toBeInTheDocument();
    expect(screen.getByText('T2')).toBeInTheDocument();
    expect(screen.getByText('T3')).toBeInTheDocument();
    expect(screen.queryByText('T4')).not.toBeInTheDocument();
    expect(screen.queryByText('T5')).not.toBeInTheDocument();
  });

  it('promotes a queued toast when a visible one dismisses', () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    const ids: string[] = [];
    act(() => {
      for (let i = 1; i <= 4; i += 1) {
        ids.push(
          result.current.toast({ message: `Q${String(i)}`, tone: 'info', durationMs: 0 }),
        );
      }
    });
    expect(screen.queryByText('Q4')).not.toBeInTheDocument();
    act(() => {
      result.current.dismiss(ids[0]);
    });
    // Q4 promotes into the now-free slot.
    expect(screen.getByText('Q4')).toBeInTheDocument();
  });

  it('pauses the auto-dismiss countdown while hovered', () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useToast(), { wrapper });
      act(() => {
        result.current.toast({ message: 'Hold', tone: 'info', durationMs: 1000 });
      });
      const toastEl = screen.getByText('Hold').closest('.km-toast');
      expect(toastEl).not.toBeNull();
      // Hover before the timer elapses → countdown pauses. Use fireEvent
      // (synchronous) rather than userEvent so the assertion is deterministic
      // under fake timers — userEvent's async pointer sequence races the
      // advanceTimersByTime loop.
      act(() => {
        fireEvent.mouseEnter(toastEl as Element);
      });
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.getByText('Hold')).toBeInTheDocument();
      // Unhover → countdown resumes from the banked remainder (~1000ms left).
      act(() => {
        fireEvent.mouseLeave(toastEl as Element);
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.queryByText('Hold')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Belt-and-braces: the viewport portals to document.body. Confirm nothing
// leaks after unmount (no orphan region) so navigation-heavy sessions stay
// clean.
describe('ToastProvider portal lifecycle', () => {
  beforeEach(() => {
    // Each test gets a fresh body region implicitly via RTL cleanup.
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders no viewport region when there are no toasts', () => {
    render(
      <ToastProvider>
        <div>app</div>
      </ToastProvider>,
    );
    expect(document.querySelector('.km-toast-viewport')).toBeNull();
  });
});
