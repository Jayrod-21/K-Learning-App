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
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
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
  // Real constant (v2 flatten + accent sync): the wire palette echo the page
  // seeds its PUT baseline with before hydration. Mirrors the module's export.
  LEGACY_PALETTE_DEFAULT: {
    paper: 'hanji',
    accent: 'coral',
    correct: 'moss',
    wrong: 'vermilion',
  },
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
import { AccentProvider } from '../hooks/AccentProvider';
import { TextSizeProvider } from '../hooks/TextSizeProvider';
import { SettingsProvider } from '../hooks/SettingsProvider';
import { ThemeProvider } from '../hooks/ThemeProvider';
import { ToastProvider } from '../components/ToastProvider';

/**
 * Settings now consumes `useTheme` (A4 theme-mode control), `useAccent`
 * (Redesign §14a accent picker), `useToast` (A3 prefs-sync-failure surface
 * + U1b upload toast), and `useNavigate` (U1b "See all uploads" link), so
 * every render needs ThemeProvider + AccentProvider + ToastProvider + a
 * Router in the tree alongside SettingsProvider. This helper wraps the
 * page in the same provider order App.tsx uses.
 */
function renderSettings(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <AccentProvider>
          <TextSizeProvider>
            <ToastProvider>
              <SettingsProvider>
                <Settings />
              </SettingsProvider>
            </ToastProvider>
          </TextSizeProvider>
        </AccentProvider>
      </ThemeProvider>
    </MemoryRouter>,
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
  palette: { paper: 'hanji', accent: 'coral', correct: 'moss', wrong: 'vermilion' },
  languageDisplay: { mode: 'both', primary: 'ko', subScale: 0.7 },
  textSize: 'md',
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
  // §14a: AccentProvider writes data-accent the same way.
  delete document.documentElement.dataset.accent;
  // F-025: TextSizeProvider writes data-text-size the same way.
  delete document.documentElement.dataset.textSize;
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

  it('P3b: group headings render Korean in both-mode, with 화면 표시 (not 외관)', () => {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);

    renderSettings();
    expect(screen.getByText('프로필')).toBeInTheDocument();
    expect(screen.getByText('알림')).toBeInTheDocument();
    // Glossary reconciliation: Appearance is 화면 표시 app-wide; 외관 retired.
    expect(screen.getByText('화면 표시')).toBeInTheDocument();
    expect(screen.queryByText('외관')).not.toBeInTheDocument();
    // The topbar eyebrow renders the nav manifest pair.
    expect(screen.getByText('프로필 · 알림 · 화면 표시')).toBeInTheDocument();
  });

  it('P3b trim: the locally-cached-preferences impl-leak tooltip is gone', () => {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);

    renderSettings();
    expect(document.querySelector('[title*="locally-cached"]')).toBeNull();
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
  it('Appearance offers ONLY theme + language + Accent (v2 flatten: no Paper/Correct/Incorrect pickers)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);

    renderSettings();

    // The removed pickers must not render.
    expect(screen.queryByText('Paper')).not.toBeInTheDocument();
    expect(screen.queryByText('Correct')).not.toBeInTheDocument();
    expect(screen.queryByText('Incorrect')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Linen' })).not.toBeInTheDocument();

    // The accent picker survives and still selects locally (data-accent),
    // never touching the server profile.
    const blue = screen.getByRole('radio', { name: 'Cyber Blue' });
    expect(blue).toHaveAttribute('aria-checked', 'false');
    await user.click(blue);
    expect(blue).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.dataset.accent).toBe('blue');
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
  it('hydrates notif from the server on mount (server wins on load)', async () => {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
    // Server holds a NON-default notif pref → the toggle should adopt it.
    // (The wire `palette` is a passthrough echo since the v2 flatten — no UI
    // reflects it anymore, so notif is the hydration probe.)
    mocks.fetchPrefs.mockResolvedValue({
      ...DEFAULT_PREFS,
      notif: { ...DEFAULT_PREFS.notif, daily: true },
      palette: { paper: 'linen', accent: 'coral', correct: 'pine', wrong: 'amber' },
    });

    renderSettings();

    // The Daily toggle reflects the server's `true` once hydration lands.
    await waitFor(() => {
      expect(
        screen.getByRole('switch', { name: 'Daily reminder' }),
      ).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('debounces a putPrefs with the full prefs object on a notif change (palette echoed)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
    // Server prefs: defaults except a stored palette → mount hydration is a
    // notif/language no-op, and the PUT must echo the stored paper/correct/
    // wrong back verbatim (v2 flatten: the client never edits them). The
    // stored accent ('mint') is ADOPTED on hydrate, which doubles as a
    // deterministic hydration-settled marker for the pre-hydration PUT guard.
    const storedPalette = { paper: 'linen', accent: 'mint', correct: 'pine', wrong: 'amber' };
    mocks.fetchPrefs.mockResolvedValue({
      ...DEFAULT_PREFS,
      palette: storedPalette,
    });

    renderSettings();

    // Hydration has landed once the server accent is adopted (the PUT guard
    // stays closed until then).
    await waitFor(() => {
      expect(document.documentElement.dataset.accent).toBe('mint');
    });

    await user.click(screen.getByRole('switch', { name: 'Daily reminder' }));

    // Nothing fires before the debounce window elapses.
    expect(mocks.putPrefs).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    await waitFor(() => {
      expect(mocks.putPrefs).toHaveBeenCalledTimes(1);
    });
    const body = mocks.putPrefs.mock.calls[0][0] as {
      notif: { daily: boolean };
      palette: { paper: string };
    };
    expect(body.notif.daily).toBe(true);
    // The server's stored legacy palette is echoed, never clobbered.
    expect(body.palette).toEqual(storedPalette);
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

    // Let hydration fully SETTLE (fetch resolve + effect commit) — the change
    // PUT is suppressed until it does (pre-hydration guard).
    await waitFor(() => {
      expect(mocks.fetchPrefs).toHaveBeenCalled();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    const daily = screen.getByRole('switch', { name: 'Daily reminder' });
    await user.click(daily);
    // The local notif change still applied instantly (provider is the cache).
    expect(daily).toHaveAttribute('aria-checked', 'true');

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    // A3 ErrorCard-vs-Toast split: the sync failure is transient/background,
    // so it surfaces as a non-blocking toast (NOT an inline ErrorCard). The
    // screen is intact, the change is durable locally, and the toggle keeps
    // its state.
    await waitFor(() => {
      expect(screen.getByText(/saved on this device/i)).toBeInTheDocument();
    });
    // It's a polite toast (role=status), not an alert/ErrorCard.
    const toast = screen.getByText(/saved on this device/i).closest('.km-toast');
    expect(toast).not.toBeNull();
    expect(daily).toHaveAttribute('aria-checked', 'true');

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
      ...DEFAULT_PREFS,
      notif: { ...DEFAULT_PREFS.notif, daily: true },
      palette: { paper: 'ivory', accent: 'plum', correct: 'teal', wrong: 'slate' },
    });

    renderSettings();

    await waitFor(() => {
      expect(
        screen.getByRole('switch', { name: 'Daily reminder' }),
      ).toHaveAttribute('aria-checked', 'true');
    });

    // Even after the debounce window, the hydration write must NOT have
    // triggered an echo PUT — the change-detector keys off the synced baseline.
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(mocks.putPrefs).not.toHaveBeenCalled();
  });

  it('a pre-hydration edit never PUTs (clobber guard); server wins on load; post-hydration edits sync promptly', async () => {
    // SF-3 rework (pre-hydration PUT guard): pin the ordering when the user
    // edits WHILE the server hydration is still in flight. Contract A5 stays:
    // "server wins on load — last-writer-wins". What MUST hold now:
    //   1. A pre-hydration edit applies instantly to the provider (offline-
    //      cache UX, durable in localStorage) but NEVER fires a PUT — a PUT at
    //      that point would carry the seeded LEGACY_PALETTE_DEFAULT/default
    //      baselines and clobber the server-stored blob.
    //   2. The late real settle wins on load: the toggle ends on the SERVER
    //      value AND the server's accent is adopted (data-accent + km.accent).
    //   3. Neither the settle nor the hydrate-adopt spawns an echo PUT — the
    //      PUT count stays at zero until a real post-hydration edit.
    //   4. A post-hydration edit saves promptly and echoes the server-stored
    //      palette (paper/correct/wrong) verbatim with the adopted accent —
    //      nothing is clobbered back to defaults.
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

    // User flips Daily while hydration is still pending. The local provider
    // applies it instantly (offline-cache UX)…
    const daily = screen.getByRole('switch', { name: 'Daily reminder' });
    await user.click(daily);
    expect(daily).toHaveAttribute('aria-checked', 'true');

    // …but (1) the debounced PUT is SUPPRESSED — flush well past the window.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(mocks.putPrefs).not.toHaveBeenCalled();

    // Now the slow server settle lands holding DIFFERENT prefs (daily=false)
    // plus a stored palette with a non-default accent.
    const storedPalette = { paper: 'ivory', accent: 'mint', correct: 'teal', wrong: 'slate' };
    await act(async () => {
      releaseHydration({
        notif: DEFAULT_PREFS.notif,
        palette: storedPalette,
        languageDisplay: DEFAULT_PREFS.languageDisplay,
        textSize: DEFAULT_PREFS.textSize,
      });
    });

    // (2) Server wins on load: the toggle reflects the server's daily=false and
    //     the server's accent is adopted locally.
    await waitFor(() => {
      expect(daily).toHaveAttribute('aria-checked', 'false');
    });
    await waitFor(() => {
      expect(document.documentElement.dataset.accent).toBe('mint');
    });
    expect(window.localStorage.getItem('km.accent')).toBe('mint');

    // (3) Flush every timer: neither the hydration write nor the hydrate-adopt
    //     may spawn a PUT — the count stays at zero.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(mocks.putPrefs).not.toHaveBeenCalled();

    // (4) A post-hydration edit saves promptly and echoes the server's stored
    //     palette verbatim (adopted accent included).
    await user.click(daily);
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await waitFor(() => {
      expect(mocks.putPrefs).toHaveBeenCalledTimes(1);
    });
    const body = mocks.putPrefs.mock.calls[0][0] as {
      notif: { daily: boolean };
      palette: unknown;
    };
    expect(body.notif.daily).toBe(true);
    expect(body.palette).toEqual(storedPalette);
  });
});

describe('Settings — accent cross-device sync', () => {
  function meOk(): void {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
  }

  it('adopts the server accent on hydrate — data-accent + km.accent update, no echo PUT, no palette-var projection', async () => {
    meOk();
    // Another device stored 'blue'; this device's localStorage is empty, so
    // the fast path painted coral first.
    mocks.fetchPrefs.mockResolvedValue({
      ...DEFAULT_PREFS,
      palette: { ...DEFAULT_PREFS.palette, accent: 'blue' },
    });

    renderSettings();

    // The real settle adopts the server's accent: attribute + localStorage +
    // the picker selection all converge on 'blue'.
    await waitFor(() => {
      expect(document.documentElement.dataset.accent).toBe('blue');
    });
    expect(window.localStorage.getItem('km.accent')).toBe('blue');
    expect(screen.getByRole('radio', { name: 'Cyber Blue' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // Adopt is a local state update, NOT a user change — flush the debounce
    // window and confirm no echo PUT (no loop).
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(mocks.putPrefs).not.toHaveBeenCalled();

    // The accent is a data-accent attribute ONLY. The PR-v2 clobber bug
    // (projecting palette colors as inline CSS vars on <html>) must stay
    // dead — the only inline var the app owns is --lang-sub-scale.
    const inlineStyle = document.documentElement.getAttribute('style') ?? '';
    expect(inlineStyle).not.toContain('--vermilion');
    expect(inlineStyle).not.toContain('--paper');
    expect(inlineStyle).not.toContain('--moss');
  });

  it('a user accent pick stamps data-accent + km.accent instantly AND PUTs palette.accent (rest echoed)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    meOk();
    // Server holds 'blue' → adoption is the deterministic hydration marker.
    mocks.fetchPrefs.mockResolvedValue({
      ...DEFAULT_PREFS,
      palette: { ...DEFAULT_PREFS.palette, accent: 'blue' },
    });

    renderSettings();
    await waitFor(() => {
      expect(document.documentElement.dataset.accent).toBe('blue');
    });

    // The user picks Han Mint: the local fast path applies instantly…
    await user.click(screen.getByRole('radio', { name: 'Han Mint' }));
    expect(document.documentElement.dataset.accent).toBe('mint');
    expect(window.localStorage.getItem('km.accent')).toBe('mint');

    // …and the debounced full-object PUT carries palette.accent='mint' with
    // the server-reported paper/correct/wrong echoed verbatim.
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await waitFor(() => {
      expect(mocks.putPrefs).toHaveBeenCalledTimes(1);
    });
    const body = mocks.putPrefs.mock.calls[0][0] as {
      notif: unknown;
      palette: unknown;
    };
    expect(body.palette).toEqual({
      ...DEFAULT_PREFS.palette,
      accent: 'mint',
    });
    expect(body.notif).toEqual(DEFAULT_PREFS.notif);
  });

  it('a LEGACY accent from an old server (rolling deploy) is not adopted and never loops a PUT', async () => {
    meOk();
    mocks.fetchPrefs.mockResolvedValue({
      ...DEFAULT_PREFS,
      palette: { paper: 'ivory', accent: 'plum', correct: 'teal', wrong: 'slate' },
    });

    renderSettings();
    await waitFor(() => {
      expect(mocks.fetchPrefs).toHaveBeenCalled();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // The un-adoptable legacy id is ignored: the local accent keeps ruling the
    // attribute and localStorage stays untouched.
    expect(document.documentElement.dataset.accent).toBe('coral');
    expect(window.localStorage.getItem('km.accent')).toBeNull();

    // The baseline was pinned to the LOCAL accent, so no self-initiated
    // "correcting" PUT ever fires.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(mocks.putPrefs).not.toHaveBeenCalled();
  });
});

describe('Settings — text size (F-025 cross-device sync)', () => {
  function meOk(): void {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
  }

  it('renders an S/M/L radiogroup with real accessible names, Medium checked by default', () => {
    meOk();
    renderSettings();
    const group = screen.getByRole('radiogroup', { name: 'Text size' });
    expect(within(group).getByRole('radio', { name: 'Small' })).toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: 'Large' })).toBeInTheDocument();
    // Default = md — the CURRENT app size. Shipping F-025 must not shrink
    // the app; Small is opt-in.
    expect(within(group).getByRole('radio', { name: 'Medium' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // The glyph labels stay compact.
    expect(within(group).getByRole('radio', { name: 'Small' })).toHaveTextContent('S');
  });

  it('a user pick stamps data-text-size + km.textSize instantly AND PUTs textSize (rest echoed)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    meOk();
    // Server holds a non-default accent → adoption is the deterministic
    // hydration marker (the PUT guard stays closed until it lands).
    mocks.fetchPrefs.mockResolvedValue({
      ...DEFAULT_PREFS,
      palette: { ...DEFAULT_PREFS.palette, accent: 'blue' },
    });

    renderSettings();
    await waitFor(() => {
      expect(document.documentElement.dataset.accent).toBe('blue');
    });

    // The user picks Large: the local fast path applies instantly…
    await user.click(screen.getByRole('radio', { name: 'Large' }));
    expect(document.documentElement.dataset.textSize).toBe('lg');
    expect(window.localStorage.getItem('km.textSize')).toBe('lg');

    // …and the debounced full-object PUT carries textSize='lg' with
    // everything else echoed verbatim.
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await waitFor(() => {
      expect(mocks.putPrefs).toHaveBeenCalledTimes(1);
    });
    const body = mocks.putPrefs.mock.calls[0][0] as {
      textSize: string;
      notif: unknown;
    };
    expect(body.textSize).toBe('lg');
    expect(body.notif).toEqual(DEFAULT_PREFS.notif);
  });

  it('adopts the server textSize on hydrate — data-text-size + km.textSize update, no echo PUT', async () => {
    meOk();
    // Another device stored 'lg'; this device's localStorage is empty, so
    // the fast path painted md first.
    mocks.fetchPrefs.mockResolvedValue({ ...DEFAULT_PREFS, textSize: 'lg' });

    renderSettings();

    await waitFor(() => {
      expect(document.documentElement.dataset.textSize).toBe('lg');
    });
    expect(window.localStorage.getItem('km.textSize')).toBe('lg');
    expect(screen.getByRole('radio', { name: 'Large' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // Adopt is a local state update, NOT a user change — flush the debounce
    // window and confirm no echo PUT (no loop).
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(mocks.putPrefs).not.toHaveBeenCalled();
  });

  it('a pre-F-025 server response (no textSize field) is not adopted and never loops a PUT', async () => {
    meOk();
    // Rolling deploy: an old server omits the field entirely.
    mocks.fetchPrefs.mockResolvedValue({
      notif: DEFAULT_PREFS.notif,
      palette: DEFAULT_PREFS.palette,
      languageDisplay: DEFAULT_PREFS.languageDisplay,
    });

    renderSettings();
    await waitFor(() => {
      expect(mocks.fetchPrefs).toHaveBeenCalled();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // The missing field is ignored: the local size keeps ruling the
    // attribute and localStorage stays untouched.
    expect(document.documentElement.dataset.textSize).toBe('md');
    expect(window.localStorage.getItem('km.textSize')).toBeNull();

    // The baseline was pinned to the LOCAL size, so no self-initiated
    // "correcting" PUT ever fires.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(mocks.putPrefs).not.toHaveBeenCalled();
  });

  it('a pre-hydration pick never PUTs (clobber guard) — server wins on load', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    meOk();
    // Hold the hydration open until after the user's pick.
    let releaseHydration!: (prefs: typeof DEFAULT_PREFS) => void;
    mocks.fetchPrefs.mockReturnValue(
      new Promise<typeof DEFAULT_PREFS>((resolve) => {
        releaseHydration = resolve;
      }),
    );

    renderSettings();

    // Pick Small while hydration is in flight — instant locally…
    await user.click(screen.getByRole('radio', { name: 'Small' }));
    expect(document.documentElement.dataset.textSize).toBe('sm');
    expect(window.localStorage.getItem('km.textSize')).toBe('sm');

    // …but the debounced PUT is SUPPRESSED (it would carry seeded baselines
    // and clobber the stored blob).
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(mocks.putPrefs).not.toHaveBeenCalled();

    // The late settle lands holding 'lg' → server wins on load.
    await act(async () => {
      releaseHydration({ ...DEFAULT_PREFS, textSize: 'lg' });
    });
    await waitFor(() => {
      expect(document.documentElement.dataset.textSize).toBe('lg');
    });
    expect(window.localStorage.getItem('km.textSize')).toBe('lg');

    // Neither the settle nor the adopt spawns an echo PUT.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(mocks.putPrefs).not.toHaveBeenCalled();
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

// ─── Language display control (Overhaul P3a) ─────────────────────────

describe('Settings — language display control', () => {
  /**
   * Let the /settings/prefs hydration fully SETTLE (fetch resolve + the
   * hydration effect's commit) before interacting. Merely waiting for
   * `fetchPrefs` to have been CALLED leaves a race: server-wins-on-load can
   * land after a click and clobber the just-made change (that semantic has
   * its own dedicated palette test above; these tests are about the control).
   */
  async function flushHydration(): Promise<void> {
    await waitFor(() => {
      expect(mocks.fetchPrefs).toHaveBeenCalled();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
  }

  function meOk(): void {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
  }

  it('renders in the Appearance group with Both selected by default, revealing order + slider', () => {
    meOk();
    renderSettings();
    const group = screen.getByRole('radiogroup', { name: 'Language display' });
    const both = within(group).getByRole('radio', { name: 'Both' });
    expect(both).toHaveAttribute('aria-checked', 'true');
    expect(within(group).getByRole('radio', { name: 'English' })).toHaveAttribute('aria-checked', 'false');
    expect(within(group).getByRole('radio', { name: 'Korean' })).toHaveAttribute('aria-checked', 'false');
    // Both-only sub-controls are visible.
    expect(screen.getByRole('radiogroup', { name: 'Bilingual order' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Second language size' })).toBeInTheDocument();
  });

  it('SegmentedRadioGroup keyboard contract: roving tabindex, arrows wrap, Home/End, selection follows focus', async () => {
    // DIRECT coverage of the extracted SegmentedRadioGroup (not the separate
    // ThemeModeControl copy) via the "Language display" radiogroup it backs.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    meOk();
    renderSettings();
    await flushHydration();

    const group = screen.getByRole('radiogroup', { name: 'Language display' });
    const english = within(group).getByRole('radio', { name: 'English' });
    const korean = within(group).getByRole('radio', { name: 'Korean' });
    const both = within(group).getByRole('radio', { name: 'Both' });

    // Roving tabindex: only the selected option (Both, the default) is a
    // Tab stop; the rest are removed from the Tab order.
    expect(both).toHaveAttribute('tabindex', '0');
    expect(english).toHaveAttribute('tabindex', '-1');
    expect(korean).toHaveAttribute('tabindex', '-1');

    both.focus();
    expect(both).toHaveFocus();

    // ArrowRight WRAPS from the last option (Both) to the first (English),
    // committing selection AND moving focus (selection follows focus). The
    // roving Tab stop moves with it.
    await user.keyboard('{ArrowRight}');
    expect(english).toHaveAttribute('aria-checked', 'true');
    expect(both).toHaveAttribute('aria-checked', 'false');
    expect(english).toHaveFocus();
    expect(english).toHaveAttribute('tabindex', '0');
    expect(both).toHaveAttribute('tabindex', '-1');

    // ArrowRight advances English → Korean.
    await user.keyboard('{ArrowRight}');
    expect(korean).toHaveAttribute('aria-checked', 'true');
    expect(korean).toHaveFocus();

    // ArrowLeft steps back Korean → English…
    await user.keyboard('{ArrowLeft}');
    expect(english).toHaveAttribute('aria-checked', 'true');
    expect(english).toHaveFocus();

    // …and WRAPS backwards from the first option (English) to the last (Both).
    await user.keyboard('{ArrowLeft}');
    expect(both).toHaveAttribute('aria-checked', 'true');
    expect(both).toHaveFocus();

    // Home jumps to the first option, End to the last.
    await user.keyboard('{Home}');
    expect(english).toHaveAttribute('aria-checked', 'true');
    expect(english).toHaveFocus();
    await user.keyboard('{End}');
    expect(both).toHaveAttribute('aria-checked', 'true');
    expect(both).toHaveFocus();

    // Exactly one option is ever checked (radiogroup invariant).
    expect(
      within(group)
        .getAllByRole('radio')
        .filter((r) => r.getAttribute('aria-checked') === 'true'),
    ).toHaveLength(1);
  });

  it('selecting English hides the Both-only controls and persists mode=en', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    meOk();
    mocks.fetchPrefs.mockResolvedValue(DEFAULT_PREFS);
    renderSettings();
    await flushHydration();

    const english = screen.getByRole('radio', { name: 'English' });
    await user.click(english);
    expect(english).toHaveAttribute('aria-checked', 'true');

    // Orientation + slider are hidden when mode ≠ both.
    expect(
      screen.queryByRole('radiogroup', { name: 'Bilingual order' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('slider', { name: 'Second language size' }),
    ).not.toBeInTheDocument();

    // Debounced full-object PUT carries the new mode.
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await waitFor(() => {
      expect(mocks.putPrefs).toHaveBeenCalledTimes(1);
    });
    const body = mocks.putPrefs.mock.calls[0][0] as {
      languageDisplay: { mode: string; primary: string; subScale: number };
    };
    expect(body.languageDisplay.mode).toBe('en');
    // ...and the localStorage cache holds it too (provider is the cache).
    const stored = JSON.parse(
      window.localStorage.getItem('km.settings') ?? '{}',
    ) as { languageDisplay?: { mode?: string } };
    expect(stored.languageDisplay?.mode).toBe('en');
  });

  it('selecting Korean persists mode=ko and re-selecting Both restores the sub-controls', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    meOk();
    mocks.fetchPrefs.mockResolvedValue(DEFAULT_PREFS);
    renderSettings();
    await flushHydration();

    await user.click(screen.getByRole('radio', { name: 'Korean' }));
    expect(
      screen.queryByRole('slider', { name: 'Second language size' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Both' }));
    expect(
      screen.getByRole('slider', { name: 'Second language size' }),
    ).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await waitFor(() => {
      expect(mocks.putPrefs).toHaveBeenCalled();
    });
    const last = mocks.putPrefs.mock.calls.at(-1)?.[0] as {
      languageDisplay: { mode: string };
    };
    expect(last.languageDisplay.mode).toBe('both');
  });

  it('changing the orientation persists primary=en', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    meOk();
    mocks.fetchPrefs.mockResolvedValue(DEFAULT_PREFS);
    renderSettings();
    await flushHydration();

    const order = screen.getByRole('radiogroup', { name: 'Bilingual order' });
    const englishFirst = within(order).getByRole('radio', {
      name: 'English first',
    });
    expect(englishFirst).toHaveAttribute('aria-checked', 'false');
    await user.click(englishFirst);
    expect(englishFirst).toHaveAttribute('aria-checked', 'true');

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await waitFor(() => {
      expect(mocks.putPrefs).toHaveBeenCalledTimes(1);
    });
    const body = mocks.putPrefs.mock.calls[0][0] as {
      languageDisplay: { primary: string };
    };
    expect(body.languageDisplay.primary).toBe('en');
  });

  it('dragging the slider updates subScale, the CSS var, and persists', async () => {
    meOk();
    mocks.fetchPrefs.mockResolvedValue(DEFAULT_PREFS);
    renderSettings();
    await flushHydration();

    const slider = screen.getByRole('slider', {
      name: 'Second language size',
    }) as HTMLInputElement;
    expect(slider.value).toBe('0.7');
    // aria-valuetext is the ONLY percent surface for AT (the visible "%"
    // span is aria-hidden), so pin it at the default…
    expect(slider).toHaveAttribute('aria-valuetext', '70%');

    // fireEvent.change is the canonical way to move a range input in tests
    // (userEvent has no slider-drag primitive).
    fireEvent.change(slider, { target: { value: '0.5' } });
    expect(slider.value).toBe('0.5');
    // …and confirm it tracks the drag.
    expect(slider).toHaveAttribute('aria-valuetext', '50%');

    // The provider projects the new scale onto <html> immediately (live
    // preview path — no debounce on the visual).
    expect(
      document.documentElement.style.getPropertyValue('--lang-sub-scale'),
    ).toBe('0.5');

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await waitFor(() => {
      expect(mocks.putPrefs).toHaveBeenCalledTimes(1);
    });
    const body = mocks.putPrefs.mock.calls[0][0] as {
      languageDisplay: { subScale: number };
    };
    expect(body.languageDisplay.subScale).toBe(0.5);
  });

  it('server hydration applies a stored language display over the local default', async () => {
    meOk();
    mocks.fetchPrefs.mockResolvedValue({
      ...DEFAULT_PREFS,
      languageDisplay: { mode: 'en', primary: 'en', subScale: 0.6 },
    });
    renderSettings();

    await waitFor(() => {
      expect(
        screen.getByRole('radio', { name: 'English' }),
      ).toHaveAttribute('aria-checked', 'true');
    });
    // Hydration must not echo straight back as a PUT.
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(mocks.putPrefs).not.toHaveBeenCalled();
  });
});
