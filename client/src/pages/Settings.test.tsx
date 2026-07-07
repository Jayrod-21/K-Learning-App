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
  within,
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
    fetchMfaStatus: vi.fn(),
    mfaEnroll: vi.fn(),
    mfaConfirm: vi.fn(),
    regenerateRecoveryCodes: vi.fn(),
    fetchPrefs: vi.fn(),
    putPrefs: vi.fn(),
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
  fetchMfaStatus: mocks.fetchMfaStatus,
  mfaEnroll: mocks.mfaEnroll,
  mfaConfirm: mocks.mfaConfirm,
  regenerateRecoveryCodes: mocks.regenerateRecoveryCodes,
}));

// Deterministic QR so the re-enroll <img> renders without the real encoder.
vi.mock('../lib/qr', () => ({
  otpauthUriToDataUrl: vi.fn(async () => 'data:image/png;base64,QRTEST'),
}));

vi.mock('../services/settings', () => ({
  fetchPrefs: mocks.fetchPrefs,
  putPrefs: mocks.putPrefs,
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
import { ThemeProvider } from '../hooks/ThemeProvider';
import { ToastProvider } from '../components/ToastProvider';

/**
 * Settings now consumes `useTheme` (A4 theme-mode control) and `useToast`
 * (A3 prefs-sync-failure surface), so every render needs ThemeProvider +
 * ToastProvider in the tree alongside SettingsProvider. This helper wraps
 * the page in the same provider order App.tsx uses.
 */
function renderSettings(): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <ToastProvider>
        <SettingsProvider>
          <Settings />
        </SettingsProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
}

// ─── Lifecycle ────────────────────────────────────────────────

/** Default prefs the server hands back — matches DEFAULT_SETTINGS notif/palette
 *  so the hydration effect is a no-op for the existing profile tests. */
const DEFAULT_PREFS = {
  notif: {
    channel: { email: true, sms: false },
    reviewsDue: true,
    daily: false,
    weekly: true,
  },
  palette: { paper: 'hanji', accent: 'vermilion', correct: 'moss', wrong: 'vermilion' },
};

beforeEach(() => {
  window.localStorage.clear();
  mocks.fetchMe.mockReset();
  mocks.patchMe.mockReset();
  mocks.fetchMfaStatus.mockReset();
  mocks.fetchMfaStatus.mockResolvedValue({
    enabled: true,
    recoveryCodesRemaining: 8,
  });
  mocks.mfaEnroll.mockReset();
  mocks.mfaConfirm.mockReset();
  mocks.regenerateRecoveryCodes.mockReset();
  mocks.fetchPrefs.mockReset();
  mocks.putPrefs.mockReset();
  // Default: prefs match the local defaults → hydration is a no-op. Individual
  // prefs tests override these.
  mocks.fetchPrefs.mockResolvedValue(DEFAULT_PREFS);
  mocks.putPrefs.mockResolvedValue(DEFAULT_PREFS);
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
  // A4: ThemeProvider writes data-theme on <html>; reset between tests so a
  // theme-mode test's choice doesn't bleed into the next render.
  delete document.documentElement.dataset.theme;
});

// ─── Tests ────────────────────────────────────────────────────

describe('Settings — profile hydration', () => {
  it('renders the three groups (Profile / Notifications / Appearance)', () => {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);

    renderSettings();
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

    renderSettings();

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

    renderSettings();

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

    renderSettings();

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

    renderSettings();

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

  it('rebases the version snapshot after a 409 so the NEXT save succeeds (409-stranding fix)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // Mount hydrates version 1. The post-409 rebase refetch returns the
    // server's bumped version 2 (someone edited the profile on another
    // device) — with a changed display_name so the rebase is observable.
    mocks.fetchMe
      .mockResolvedValueOnce({
        id: 1,
        email: 'jay@example.com',
        display_name: 'Jay',
        version: 1,
      } satisfies User)
      .mockResolvedValue({
        id: 1,
        email: 'jay@example.com',
        display_name: 'Jay v2',
        version: 2,
      } satisfies User);
    // First save carries the stale version and 409s; the redo succeeds.
    mocks.patchMe
      .mockRejectedValueOnce(
        new ApiError('stale version', { status: 409, code: 'version_conflict' }),
      )
      .mockResolvedValue({
        id: 1,
        email: 'jay@example.com',
        display_name: 'Jared',
        version: 3,
      } satisfies User);

    renderSettings();
    const name = screen.getByLabelText('Name') as HTMLInputElement;
    await waitFor(() => {
      expect(name.value).toBe('Jay');
    });

    await user.clear(name);
    await user.type(name, 'Jared');
    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    // First PATCH carried the hydrated version 1 and 409'd → rollback + error.
    await waitFor(() => {
      expect(mocks.patchMe).toHaveBeenCalledTimes(1);
    });
    expect(
      (mocks.patchMe.mock.calls[0][0] as { expected_version: number })
        .expected_version,
    ).toBe(1);
    expect(
      await screen.findByText(/Saving that change failed/i),
    ).toBeInTheDocument();

    // The 409 must trigger a REAL /auth/me refetch (the meQuery this screen's
    // serverVersion syncs from) — `refresh()` alone only re-probes the auth
    // context. Pre-fix, fetchMe was never called again and every subsequent
    // save re-sent expected_version 1 and 409'd until the user left Settings.
    await waitFor(() => {
      expect(mocks.fetchMe).toHaveBeenCalledTimes(2);
    });
    // The rebased server truth lands in the (rolled-back) buffer.
    await waitFor(() => {
      expect(name.value).toBe('Jay v2');
    });

    // Redo the edit — the retry PATCH must carry the REBASED version 2.
    await user.clear(name);
    await user.type(name, 'Jared');
    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    await waitFor(() => {
      expect(mocks.patchMe).toHaveBeenCalledTimes(2);
    });
    expect(
      (mocks.patchMe.mock.calls[1][0] as { expected_version: number })
        .expected_version,
    ).toBe(2);
    // The retry succeeded — the new value sticks (no rollback this time).
    await waitFor(() => {
      expect(name.value).toBe('Jared');
    });
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

    renderSettings();

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

    renderSettings();

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

    renderSettings();

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

    renderSettings();

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

describe('Settings — prefs server-sync (Pass 9)', () => {
  it('hydrates notif + palette from the server on mount (server wins on load)', async () => {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
    // Server holds a NON-default palette → the swatch picker should adopt it.
    mocks.fetchPrefs.mockResolvedValue({
      notif: {
        channel: { email: true, sms: false },
        reviewsDue: true,
        daily: false,
        weekly: true,
      },
      palette: { paper: 'linen', accent: 'indigo', correct: 'pine', wrong: 'amber' },
    });

    renderSettings();

    // The Paper picker reflects the server's 'linen' once hydration lands.
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Linen' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });
  });

  it('debounces a putPrefs with the full prefs object on a palette change', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
    // Server prefs == defaults → mount hydration is a no-op, so the only PUT
    // is the one driven by the user's click below.
    mocks.fetchPrefs.mockResolvedValue(DEFAULT_PREFS);

    renderSettings();

    // Let the (no-op) hydration settle first so it doesn't race the change PUT.
    await waitFor(() => {
      expect(mocks.fetchPrefs).toHaveBeenCalled();
    });

    await user.click(screen.getByRole('radio', { name: 'Linen' }));

    // Nothing fires before the debounce window elapses.
    expect(mocks.putPrefs).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    await waitFor(() => {
      expect(mocks.putPrefs).toHaveBeenCalledTimes(1);
    });
    const body = mocks.putPrefs.mock.calls[0][0] as {
      notif: unknown;
      palette: { paper: string };
    };
    expect(body.palette.paper).toBe('linen');
    expect(body.notif).toBeDefined();
  });

  it('a failed putPrefs never breaks the screen — surfaces a non-blocking toast (A3)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
    mocks.fetchPrefs.mockResolvedValue(DEFAULT_PREFS);
    mocks.putPrefs.mockRejectedValue(
      new ApiError('network unreachable', { status: 0, code: 'network' }),
    );

    renderSettings();

    await waitFor(() => {
      expect(mocks.fetchPrefs).toHaveBeenCalled();
    });

    const linen = screen.getByRole('radio', { name: 'Linen' });
    await user.click(linen);
    // The local palette change still applied instantly (provider is the cache).
    expect(linen).toHaveAttribute('aria-checked', 'true');

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    // A3 ErrorCard-vs-Toast split: the sync failure is transient/background,
    // so it surfaces as a non-blocking toast (NOT an inline ErrorCard). The
    // screen is intact, the change is durable locally, and the swatch keeps
    // its selection.
    await waitFor(() => {
      expect(screen.getByText(/saved on this device/i)).toBeInTheDocument();
    });
    // It's a polite toast (role=status), not an alert/ErrorCard.
    const toast = screen.getByText(/saved on this device/i).closest('.km-toast');
    expect(toast).not.toBeNull();
    expect(linen).toHaveAttribute('aria-checked', 'true');

    // The Retry action re-attempts the PUT.
    mocks.putPrefs.mockResolvedValueOnce(DEFAULT_PREFS);
    const before = mocks.putPrefs.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(mocks.putPrefs.mock.calls.length).toBeGreaterThan(before);
    });
  });

  it('does not echo the server-hydrated prefs straight back as a PUT', async () => {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
    // Server holds non-default prefs; hydration writes them into the provider.
    mocks.fetchPrefs.mockResolvedValue({
      notif: {
        channel: { email: true, sms: false },
        reviewsDue: true,
        daily: false,
        weekly: true,
      },
      palette: { paper: 'ivory', accent: 'plum', correct: 'teal', wrong: 'slate' },
    });

    renderSettings();

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Ivory' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });

    // Even after the debounce window, the hydration write must NOT have
    // triggered an echo PUT — the change-detector keys off the synced baseline.
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(mocks.putPrefs).not.toHaveBeenCalled();
  });

  it('a swatch edit made BEFORE a slow hydration resolves is synced, then server-wins-on-load without an echo loop', async () => {
    // SF-3 (client review): pin the ordering when the user edits WHILE the server
    // hydration is still in flight. Contract A5 is explicit: "server wins on load
    // — last-writer-wins", so a late real settle is authoritative and replaces the
    // in-flight local slice. What MUST hold regardless of refactors to the
    // provider's merge semantics:
    //   1. The user's pre-hydration edit is NOT lost: it applies instantly to the
    //      provider AND debounces exactly one PUT carrying that edit (best-effort
    //      sync, durability already in localStorage).
    //   2. The late real settle wins on load: the swatch ends on the SERVER value,
    //      fully reconciled (not a half-merged state) — no crash.
    //   3. The hydration write does NOT spawn an echo PUT, and the pre-hydration
    //      edit does NOT leave a stale baseline that loops PUTs every render — so
    //      total PUTs == the single user-edit PUT, with none added by the settle.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);

    // Hold the prefs hydration open until we release it AFTER the user's click.
    let releaseHydration!: (prefs: typeof DEFAULT_PREFS) => void;
    mocks.fetchPrefs.mockReturnValue(
      new Promise<typeof DEFAULT_PREFS>((resolve) => {
        releaseHydration = resolve;
      }),
    );

    renderSettings();

    // User edits the palette (Linen) while hydration is still pending. The local
    // provider applies it instantly (offline-cache UX), and the debounce fires the
    // best-effort sync PUT for that edit.
    const linen = screen.getByRole('radio', { name: 'Linen' });
    await user.click(linen);
    expect(linen).toHaveAttribute('aria-checked', 'true');
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    // (1) The edit was synced, not lost: exactly one PUT, carrying Linen.
    await waitFor(() => {
      expect(mocks.putPrefs).toHaveBeenCalledTimes(1);
    });
    expect(
      (mocks.putPrefs.mock.calls[0][0] as { palette: { paper: string } }).palette
        .paper,
    ).toBe('linen');

    // Now the slow server settle lands holding a DIFFERENT palette (Ivory).
    await act(async () => {
      releaseHydration({
        notif: DEFAULT_PREFS.notif,
        palette: { paper: 'ivory', accent: 'plum', correct: 'teal', wrong: 'slate' },
      });
    });

    // (2) Server wins on load: the swatch reflects the server's Ivory, fully
    //     settled (not a half-merged Linen/Ivory state).
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Ivory' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });
    expect(linen).toHaveAttribute('aria-checked', 'false');

    // (3) Flush every timer: the hydration write must NOT echo a PUT, and the
    //     pre-hydration edit must NOT leave a stale baseline that loops PUTs — so
    //     the PUT count stays at the single user-edit PUT from step (1).
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(mocks.putPrefs).toHaveBeenCalledTimes(1);
  });
});

describe('Settings — theme-mode control (A4)', () => {
  it('renders Light / Dark / System as a labelled radiogroup', () => {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
    renderSettings();
    const group = screen.getByRole('radiogroup', { name: 'Theme mode' });
    expect(within(group).getByRole('radio', { name: 'Light' })).toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: 'Dark' })).toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: 'System' })).toBeInTheDocument();
  });

  it("selecting Dark sets data-theme + persists km.theme; System clears it", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
    renderSettings();

    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('km.theme')).toBe('dark');
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // System clears the explicit choice (follows OS pref thereafter).
    await user.click(screen.getByRole('radio', { name: 'System' }));
    expect(window.localStorage.getItem('km.theme')).toBeNull();
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('exposes a single roving Tab stop and moves selection with arrow keys', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
    renderSettings();

    const light = screen.getByRole('radio', { name: 'Light' });
    const dark = screen.getByRole('radio', { name: 'Dark' });
    const system = screen.getByRole('radio', { name: 'System' });

    // Roving tabindex: only the checked radio (System, the default with no
    // stored km.theme) is tabbable; the rest are removed from the Tab order.
    expect(system).toHaveAttribute('tabindex', '0');
    expect(light).toHaveAttribute('tabindex', '-1');
    expect(dark).toHaveAttribute('tabindex', '-1');

    // Focus the active radio, then drive the WAI-ARIA arrow-key contract.
    system.focus();
    expect(system).toHaveFocus();

    // ArrowRight wraps from the last option (System) back to the first (Light),
    // committing selection AND moving focus (selection follows focus).
    await user.keyboard('{ArrowRight}');
    expect(light).toHaveAttribute('aria-checked', 'true');
    expect(light).toHaveFocus();
    expect(light).toHaveAttribute('tabindex', '0');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem('km.theme')).toBe('light');

    // ArrowRight again advances Light → Dark.
    await user.keyboard('{ArrowRight}');
    expect(dark).toHaveAttribute('aria-checked', 'true');
    expect(dark).toHaveFocus();

    // ArrowLeft steps back Dark → Light.
    await user.keyboard('{ArrowLeft}');
    expect(light).toHaveAttribute('aria-checked', 'true');
    expect(light).toHaveFocus();

    // End jumps to the last option (System), clearing the stored choice.
    await user.keyboard('{End}');
    expect(system).toHaveAttribute('aria-checked', 'true');
    expect(system).toHaveFocus();
    expect(window.localStorage.getItem('km.theme')).toBeNull();

    // Home jumps to the first option (Light).
    await user.keyboard('{Home}');
    expect(light).toHaveAttribute('aria-checked', 'true');
    expect(light).toHaveFocus();
  });
});

// ─── Two-Factor Authentication section (PASS LOGIN — PART C4) ──

describe('Settings — Two-Factor Authentication', () => {
  it('renders the status badge + recovery-codes-remaining', async () => {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
    } satisfies User);
    mocks.fetchMfaStatus.mockResolvedValue({
      enabled: true,
      recoveryCodesRemaining: 6,
    });

    renderSettings();

    expect(
      await screen.findByText('Two-Factor Authentication'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Enabled')).toBeInTheDocument();
    });
    expect(screen.getByText(/6 recovery codes remaining/)).toBeInTheDocument();
  });

  it('has NO disable button (2FA is mandatory)', async () => {
    mocks.fetchMe.mockResolvedValue({ id: 1, email: 'jay@example.com' } satisfies User);

    renderSettings();
    await screen.findByText('Two-Factor Authentication');

    expect(
      screen.queryByRole('button', { name: /disable/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /turn off/i }),
    ).not.toBeInTheDocument();
  });

  it('regenerate: password re-auth → shows new codes once', async () => {
    mocks.fetchMe.mockResolvedValue({ id: 1, email: 'jay@example.com' } satisfies User);
    mocks.regenerateRecoveryCodes.mockResolvedValue({
      recoveryCodes: ['NEW11-NEW22', 'NEW33-NEW44'],
    });

    renderSettings();
    await screen.findByText('Two-Factor Authentication');

    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: 'Regenerate recovery codes' }),
    );
    await user.type(
      screen.getByLabelText('Confirm your password to continue'),
      'a-long-passphrase',
    );
    await user.click(screen.getByRole('button', { name: 'Regenerate codes' }));

    expect(mocks.regenerateRecoveryCodes).toHaveBeenCalledWith(
      'a-long-passphrase',
    );
    expect(await screen.findByText('NEW11-NEW22')).toBeInTheDocument();
    expect(screen.getByText('NEW33-NEW44')).toBeInTheDocument();
  });

  it('re-enroll: password → QR + manual key → confirm → new codes', async () => {
    mocks.fetchMe.mockResolvedValue({ id: 1, email: 'jay@example.com' } satisfies User);
    mocks.mfaEnroll.mockResolvedValue({
      otpauthUri: 'otpauth://totp/x?secret=NEWSEED',
      secret: 'NEWSEEDKEY',
    });
    mocks.mfaConfirm.mockResolvedValue({
      recoveryCodes: ['RE111-RE222'],
    });

    renderSettings();
    await screen.findByText('Two-Factor Authentication');

    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', {
        name: 'Re-enroll authenticator (new phone)',
      }),
    );
    await user.type(
      screen.getByLabelText('Confirm your password to set up a new authenticator'),
      'a-long-passphrase',
    );
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(mocks.mfaEnroll).toHaveBeenCalledWith({
      password: 'a-long-passphrase',
    });
    // QR + manual key render.
    expect(
      await screen.findByAltText(
        'QR code for setting up two-factor authentication',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('NEWSEEDKEY')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Authentication code'), '654321');
    await user.click(
      screen.getByRole('button', { name: 'Confirm new authenticator' }),
    );

    expect(mocks.mfaConfirm).toHaveBeenCalledWith({
      password: 'a-long-passphrase',
      code: '654321',
    });
    expect(await screen.findByText('RE111-RE222')).toBeInTheDocument();
  });
});
