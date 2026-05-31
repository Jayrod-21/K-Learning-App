/**
 * InstallPrompt — banner appears on a simulated `beforeinstallprompt`, Install
 * replays the stashed prompt(), Dismiss persists, and the banner stays hidden
 * when the app is already running standalone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InstallPrompt } from './InstallPrompt';

/** Build a fake `beforeinstallprompt` event with a spy `prompt()`. */
function makeBipEvent(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const event = new Event('beforeinstallprompt') as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: string; platform: string }>;
  };
  event.prompt = vi.fn().mockResolvedValue(undefined);
  event.userChoice = Promise.resolve({ outcome, platform: 'web' });
  // Spy on the real `preventDefault` rather than reassigning it, so its type
  // signature (() => void) is preserved.
  vi.spyOn(event, 'preventDefault');
  return event;
}

/** Mock matchMedia; `standalone` controls the display-mode query result. */
function mockMatchMedia(standalone: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: standalone && query.includes('standalone'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    })),
  );
}

/** Fire the captured event and let the state update flush. */
async function fireBeforeInstallPrompt(event: Event): Promise<void> {
  await act(async () => {
    window.dispatchEvent(event);
  });
}

describe('InstallPrompt', () => {
  beforeEach(() => {
    localStorage.clear();
    mockMatchMedia(false);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders nothing until beforeinstallprompt fires', () => {
    render(<InstallPrompt />);
    expect(screen.queryByLabelText(/Install Korean Master/i)).toBeNull();
  });

  it('shows the banner after a simulated beforeinstallprompt', async () => {
    const event = makeBipEvent();
    render(<InstallPrompt />);
    await fireBeforeInstallPrompt(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(screen.getByLabelText(/Install Korean Master/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /install/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /dismiss/i }),
    ).toBeInTheDocument();
  });

  it('calls the stashed prompt() and persists dismissal on Install', async () => {
    const user = userEvent.setup();
    const event = makeBipEvent('accepted');
    render(<InstallPrompt />);
    await fireBeforeInstallPrompt(event);

    await act(async () => {
      await user.click(screen.getByRole('button', { name: /install/i }));
    });

    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('km.install-dismissed')).toBe('1');
    expect(screen.queryByLabelText(/Install Korean Master/i)).toBeNull();
  });

  it('persists dismissal and hides on Dismiss', async () => {
    const user = userEvent.setup();
    const event = makeBipEvent();
    render(<InstallPrompt />);
    await fireBeforeInstallPrompt(event);

    await user.click(screen.getByRole('button', { name: /dismiss/i }));

    expect(localStorage.getItem('km.install-dismissed')).toBe('1');
    expect(screen.queryByLabelText(/Install Korean Master/i)).toBeNull();
  });

  it('stays hidden after a prior dismissal even if the event fires again', async () => {
    localStorage.setItem('km.install-dismissed', '1');
    const event = makeBipEvent();
    render(<InstallPrompt />);
    await fireBeforeInstallPrompt(event);

    expect(screen.queryByLabelText(/Install Korean Master/i)).toBeNull();
  });

  it('stays hidden when already running standalone', async () => {
    mockMatchMedia(true);
    const event = makeBipEvent();
    render(<InstallPrompt />);
    await fireBeforeInstallPrompt(event);

    expect(screen.queryByLabelText(/Install Korean Master/i)).toBeNull();
  });

  it('hides gracefully when the stashed prompt() rejects', async () => {
    const user = userEvent.setup();
    const event = makeBipEvent();
    // Simulate the native prompt rejecting (e.g. the event was already
    // consumed, or the platform refused to show it). handleInstall wraps the
    // await in try/catch + finally, so the banner must still dismiss without
    // surfacing the rejection.
    event.prompt = vi.fn().mockRejectedValue(new Error('prompt consumed'));
    render(<InstallPrompt />);
    await fireBeforeInstallPrompt(event);

    // No unhandled rejection should escape and crash the click handler.
    await act(async () => {
      await user.click(screen.getByRole('button', { name: /install/i }));
    });

    expect(event.prompt).toHaveBeenCalledTimes(1);
    // finally{} still persisted the dismissal and hid the banner.
    expect(localStorage.getItem('km.install-dismissed')).toBe('1');
    expect(screen.queryByLabelText(/Install Korean Master/i)).toBeNull();
  });

  it('tears down the banner on appinstalled', async () => {
    const event = makeBipEvent();
    render(<InstallPrompt />);
    await fireBeforeInstallPrompt(event);
    expect(screen.getByLabelText(/Install Korean Master/i)).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new Event('appinstalled'));
    });

    expect(screen.queryByLabelText(/Install Korean Master/i)).toBeNull();
  });
});
