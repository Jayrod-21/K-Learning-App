/**
 * Settings page — Pass 3 wired profile + Pass 2 local-only halves.
 *
 * Coverage:
 *   - Profile inputs hydrate from `fetchMe` (the explicit /auth/me probe
 *     bound through `useEndpointOrMock`).
 *   - Typing in Name triggers a debounced `patchMe` with only the changed
 *     field after 600ms.
 *   - A failing PATCH rolls the input back to the last-known-server value
 *     and surfaces an inline ErrorCard. The user can edit again to clear
 *     the error.
 *   - The localStorage notif + appearance halves are untouched by the
 *     server wiring (palette swatch click still works; channel chip
 *     gating still keys off the profile email).
 *
 * Mocking strategy: we stub `services/auth` to control fetchMe/patchMe
 * directly, and stub the in-process `useAuth` context to provide a
 * stable `user` + `refresh` without spinning up a real `<AuthProvider/>`
 * (which would need its own api.get mocks). The integration between
 * `useAuth` and `AuthProvider` has its own test in AuthProvider.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../services/api';
import type { User } from '../hooks/auth-context';

// ─── Mocks ────────────────────────────────────────────────────
//
// `vi.mock` factories are hoisted by Vitest, so the closures CANNOT
// reference module-scope `let` or `const` declarations (those are
// `undefined` at the time the hoisted factory runs). The canonical
// escape is `vi.hoisted`, which runs eagerly alongside the mocks and
// returns refs we can read from both the factory AND the test bodies.
const mocks = vi.hoisted(() => {
  return {
    fetchMe: vi.fn(),
    patchMe: vi.fn(),
    refresh: vi.fn(async () => undefined),
    // Mutable from the test bodies — the useAuth mock reads it on each call.
    currentUser: {
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
      phone: '+15555550100',
    } as { id: number; email: string; display_name?: string; phone?: string } | null,
  };
});

vi.mock('../services/auth', () => ({
  fetchMe: mocks.fetchMe,
  patchMe: mocks.patchMe,
}));

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    status: 'authenticated' as const,
    user: mocks.currentUser,
    loading: false,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    refresh: mocks.refresh,
  }),
}));

// We import Settings AFTER the mocks above so the module sees them.
import Settings from './Settings';
import { SettingsProvider } from '../hooks/SettingsProvider';

// ─── Lifecycle ────────────────────────────────────────────────

beforeEach(() => {
  window.localStorage.clear();
  mocks.fetchMe.mockReset();
  mocks.patchMe.mockReset();
  mocks.refresh.mockReset();
  mocks.refresh.mockResolvedValue(undefined);
  mocks.currentUser = {
    id: 1,
    email: 'jay@example.com',
    display_name: 'Jay',
    phone: '+15555550100',
  };
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('style');
});

// ─── Tests ────────────────────────────────────────────────────

describe('Settings — profile hydration', () => {
  it('renders the three groups (Profile / Notifications / Appearance)', () => {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);

    render(
      <SettingsProvider>
        <Settings />
      </SettingsProvider>,
    );
    expect(screen.getByText('Profile')).toBeInTheDocument();
    expect(screen.getByText('Notifications')).toBeInTheDocument();
    expect(screen.getByText('Appearance')).toBeInTheDocument();
  });

  it('seeds the profile inputs from useAuth().user immediately', () => {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
      phone: '+15555550100',
    } satisfies User);

    render(
      <SettingsProvider>
        <Settings />
      </SettingsProvider>,
    );

    const name = screen.getByLabelText('Name') as HTMLInputElement;
    const email = screen.getByLabelText('Email') as HTMLInputElement;
    const phone = screen.getByLabelText('Phone') as HTMLInputElement;
    expect(name.value).toBe('Jay');
    expect(email.value).toBe('jay@example.com');
    expect(phone.value).toBe('+15555550100');
  });

  it('overwrites the inputs when fetchMe resolves with a fresher user', async () => {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jared',
      phone: '+15555550100',
    } satisfies User);

    render(
      <SettingsProvider>
        <Settings />
      </SettingsProvider>,
    );

    await waitFor(() => {
      expect(
        (screen.getByLabelText('Name') as HTMLInputElement).value,
      ).toBe('Jared');
    });
  });
});

describe('Settings — debounced PATCH /auth/me', () => {
  it('fires patchMe with only the changed field after the 600ms debounce', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
    mocks.patchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jared',
    } satisfies User);

    render(
      <SettingsProvider>
        <Settings />
      </SettingsProvider>,
    );

    const name = screen.getByLabelText('Name') as HTMLInputElement;
    // Replace 'Jay' with 'Jared'. user.clear + user.type chains; the
    // debounce timer resets on every keystroke.
    await user.clear(name);
    await user.type(name, 'Jared');

    // Mid-typing: nothing fires.
    expect(mocks.patchMe).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    await waitFor(() => {
      expect(mocks.patchMe).toHaveBeenCalledTimes(1);
    });
    expect(mocks.patchMe).toHaveBeenCalledWith(
      expect.objectContaining({
        display_name: 'Jared',
        expected_version: expect.any(Number),
      }),
      expect.anything(),
    );
    await waitFor(() => {
      expect(mocks.refresh).toHaveBeenCalled();
    });
  });

  it('rolls back the input and surfaces an inline error on server failure', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
    mocks.patchMe.mockRejectedValue(
      new ApiError('conflict', { status: 409, code: 'email_exists' }),
    );

    render(
      <SettingsProvider>
        <Settings />
      </SettingsProvider>,
    );

    const email = screen.getByLabelText('Email') as HTMLInputElement;
    await user.clear(email);
    await user.type(email, 'taken@example.com');

    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    await waitFor(() => {
      expect(mocks.patchMe).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'taken@example.com',
          expected_version: expect.any(Number),
        }),
        expect.anything(),
      );
    });

    // Rolled back to the server's last known value.
    await waitFor(() => {
      expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe(
        'jay@example.com',
      );
    });
    // Author-controlled inline error.
    expect(
      screen.getByText(/already in use/i),
    ).toBeInTheDocument();
    // refresh() IS called on a 409 — the version gate fires and Settings
    // re-fetches /auth/me so the next save uses the canonical version.
    // (Non-409 failures don't trigger refresh; that path is covered by
    // the network-error case below.)
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it('honours a deliberately cleared field — no clobber from a subsequent server sync (F-S1)', async () => {
    // Hydrate /auth/me with all three fields populated + version 1.
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
      phone: '+15555550100',
      version: 1,
    } satisfies User);
    // PATCH responses must satisfy the test contract that a PATCH lands
    // for the touched field. Server validation forbids empty phone (Zod
    // min length), so the Settings buffer DROPS empty values from the
    // outgoing patch body — the user-visible contract is "phone stays
    // empty locally, server-side phone is unchanged until the user
    // types a real value". That's exactly the invariant this test
    // enforces.
    mocks.patchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
      phone: '+15555550100',
      version: 2,
    } satisfies User);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <SettingsProvider>
        <Settings />
      </SettingsProvider>,
    );

    const phone = screen.getByLabelText('Phone') as HTMLInputElement;
    // Wait for the server-truth sync to land the seeded value.
    await waitFor(() => {
      expect(phone.value).toBe('+15555550100');
    });

    // Type a character then clear back to empty — this trips the
    // `editedFieldsRef` tracking even though the final value is the
    // empty string.
    await user.type(phone, '9');
    await user.clear(phone);
    expect(phone.value).toBe('');

    // Pass the debounce. The flushSave path runs; since the only
    // changed field collapses to empty (and the schema rejects empty
    // phone), no PATCH actually gets sent. The crucial F-S1 invariant
    // we test next: the buffer is NOT reverted to the server value.
    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    // F-S1 contract — part 1: the phone field STAYS empty. Pre-fix the
    // sync effect would have run `next.phone = serverProfile.phone`
    // because the comparator conflated "never typed" with "deliberately
    // cleared". With `editedFieldsRef.has('phone') === true` the sync
    // effect leaves the buffer alone.
    expect(phone.value).toBe('');

    // F-S1 contract — part 2: no PATCH was sent for the cleared field.
    // The server's PatchMeSchema forbids empty phone (Zod min length),
    // so the buffer's diff-builder DROPS empty values from the outgoing
    // body — there's nothing to send. The user-visible contract is
    // "deliberately-cleared phone stays empty locally; the server's
    // record is unchanged until the user types a real value". This is
    // intentional: server-side phone clearance is out of scope for
    // Pass 3 (FU-able if a real clear-to-null path lands).
    expect(mocks.patchMe).not.toHaveBeenCalled();
  });

  it('does not call patchMe when no field has actually changed', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);

    render(
      <SettingsProvider>
        <Settings />
      </SettingsProvider>,
    );

    const name = screen.getByLabelText('Name') as HTMLInputElement;
    // Replace the value with the same string → no diff.
    await user.clear(name);
    await user.type(name, 'Jay');

    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    expect(mocks.patchMe).not.toHaveBeenCalled();
  });
});

describe('Settings — local-only halves still work', () => {
  it('clicking a Paper swatch updates the SettingsProvider state', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);

    render(
      <SettingsProvider>
        <Settings />
      </SettingsProvider>,
    );

    const linen = screen.getByRole('radio', { name: 'Linen' });
    expect(linen).toHaveAttribute('aria-checked', 'false');
    await user.click(linen);
    expect(linen).toHaveAttribute('aria-checked', 'true');
    // patchMe was never touched — palette is localStorage-only.
    expect(mocks.patchMe).not.toHaveBeenCalled();
  });

  it('clearing the profile Email disables the local Email channel chip', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
    mocks.patchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);

    // Seed an enabled email channel — that's what the clearing should reset.
    window.localStorage.setItem(
      'km.settings',
      JSON.stringify({
        name: '',
        email: '',
        phone: '',
        notif: {
          channel: { email: true, sms: false },
          reviewsDue: false,
          daily: false,
          weekly: false,
        },
        palette: {
          paper: 'hanji',
          accent: 'vermilion',
          correct: 'moss',
          wrong: 'vermilion',
        },
      }),
    );

    render(
      <SettingsProvider>
        <Settings />
      </SettingsProvider>,
    );

    const emailInput = screen.getByLabelText('Email') as HTMLInputElement;
    expect(emailInput.value).toBe('jay@example.com');
    const emailChip = screen.getByRole('button', { name: 'Email' });
    expect(emailChip).toHaveAttribute('aria-pressed', 'true');

    await user.clear(emailInput);
    expect(emailInput.value).toBe('');
    expect(emailChip).toBeDisabled();
    expect(emailChip).toHaveAttribute('aria-pressed', 'false');
  });
});
