/**
 * PwaUpdatePrompt — renders a reload banner only when a waiting service worker
 * is detected, and calls updateServiceWorker(true) (skipWaiting + reload) on tap.
 * `virtual:pwa-register/react` is mocked (no SW under Vitest).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const pwa = vi.hoisted(() => ({
  useRegisterSW: vi.fn(),
  updateServiceWorker: vi.fn(),
}));
vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: pwa.useRegisterSW,
}));

import { PwaUpdatePrompt } from './PwaUpdatePrompt';

beforeEach(() => {
  pwa.useRegisterSW.mockReset();
  pwa.updateServiceWorker.mockReset();
});

describe('PwaUpdatePrompt', () => {
  it('renders nothing when no update is pending', () => {
    pwa.useRegisterSW.mockReturnValue({
      needRefresh: [false, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: pwa.updateServiceWorker,
    });
    const { container } = render(<PwaUpdatePrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the reload banner and updates on tap when a new SW is waiting', async () => {
    const user = userEvent.setup();
    pwa.useRegisterSW.mockReturnValue({
      needRefresh: [true, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: pwa.updateServiceWorker,
    });
    render(<PwaUpdatePrompt />);

    expect(
      screen.getByText('A new version is available.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(pwa.updateServiceWorker).toHaveBeenCalledWith(true);
  });
});
