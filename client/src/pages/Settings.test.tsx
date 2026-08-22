/**
 * Settings page — Pass 3 wired profile + Phase 3a groups.
 *
 * Coverage:
 *   - F-038: every group is a CollapsibleTile that STARTS COLLAPSED; tests
 *     open a tile (via `expandGroup`) the way a user does before touching
 *     its controls.
 *   - Profile inputs hydrate from `fetchMe` (the explicit /auth/me probe
 *     bound through `useEndpointOrMock`).
 *   - Typing in Name triggers a debounced `patchMe` with only the changed
 *     field after 600ms.
 *   - A failing PATCH rolls the input back to the last-known-server value
 *     and surfaces an inline ErrorCard. The user can edit again to clear
 *     the error.
 *   - F-039: the Uploads section is GONE (migrates to Review→Uploads,
 *     F-057–F-059).
 *   - F-040: notification schedules hydrate from /notifications/schedules,
 *     PUT per-kind timing on change (never before hydration), and the SMS
 *     channel renders as a labelled, disabled placeholder.
 *
 * Mocking strategy: we stub `services/auth` to control fetchMe/patchMe
 * directly, and stub the in-process `useAuth` context to provide a
 * stable `user` + `refresh` without spinning up a real `<AuthProvider/>`
 * (which would need its own api.get mocks). The integration between
 * `useAuth` and `AuthProvider` has its own test in AuthProvider.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { JSX } from 'react';
import { ApiError } from '../services/api';
import type { User } from '../hooks/auth-context';
import { mockViewportWidth } from '../test/viewport';

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
    patchToursSeen: vi.fn(),
    fetchSchedules: vi.fn(),
    putSchedules: vi.fn(),
    // Tour runner spy (fix-pass SF-2): the "Help & tours" tests mount a REAL
    // TourProvider, whose replay path must reach a startable runner.
    startTour: vi.fn(),
    refresh: vi.fn(async () => undefined),
    // Context logout (the Profile group's "Log out" action). By AuthProvider
    // contract it ALWAYS resolves — the provider clears local state even when
    // the POST fails — so the default impl mirrors that.
    logout: vi.fn(async () => undefined),
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
  patchToursSeen: mocks.patchToursSeen,
  // Real constant (v2 flatten + accent sync): the wire palette echo the page
  // seeds its PUT baseline with before hydration. Mirrors the module's export.
  LEGACY_PALETTE_DEFAULT: {
    paper: 'hanji',
    accent: 'coral',
    correct: 'moss',
    wrong: 'vermilion',
  },
}));

// F-040: only the two network calls are stubbed — the kind guards/constants
// stay real so Settings.tsx narrows wire rows exactly as it will in prod.
vi.mock('../services/notifications', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../services/notifications')>();
  return {
    ...actual,
    fetchSchedules: mocks.fetchSchedules,
    putSchedules: mocks.putSchedules,
  };
});

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    status: 'authenticated' as const,
    user: mocks.currentUser,
    loading: false,
    login: vi.fn(),
    register: vi.fn(),
    logout: mocks.logout,
    refresh: mocks.refresh,
  }),
}));

// The driver.js boundary, mocked so the "Help & tours" tests can mount a
// REAL TourProvider (SF-2) without pulling the overlay engine into happy-dom.
vi.mock('../lib/tourDriver', () => ({
  startTour: mocks.startTour,
}));

// We import Settings AFTER the mocks above so the module sees them.
import Settings from './Settings';
import { AccentProvider } from '../hooks/AccentProvider';
import { TextSizeProvider } from '../hooks/TextSizeProvider';
import { SettingsProvider } from '../hooks/SettingsProvider';
import { ThemeProvider } from '../hooks/ThemeProvider';
import { TourProvider } from '../hooks/TourProvider';
import { TOURS_SEEN_STORAGE_KEY } from '../hooks/tour-context';
import { TOUR_IDS, type TourDefinition } from '../lib/tours';
import { ToastProvider } from '../components/ToastProvider';

/**
 * Settings now consumes `useTheme` (A4 theme-mode control), `useAccent`
 * (Redesign §14a accent picker), and `useToast` (A3 prefs-sync-failure
 * surface + F-040 schedule-save failures), so every render needs
 * ThemeProvider + AccentProvider + ToastProvider alongside SettingsProvider
 * (Router included to match the App.tsx tree). This helper wraps the page
 * in the same provider order App.tsx uses.
 *
 * F-023: Settings now also navigates to `/tickets` (the "Beta feedback"
 * entry point) via `useNavigate`, so the route tree carries a `/tickets`
 * probe alongside the real `Settings` route — mirrors Uploads.test.tsx's
 * ViewerProbe pattern for asserting a real navigation happened.
 */
function settingsUi(): JSX.Element {
  return (
    <MemoryRouter initialEntries={['/settings']}>
      <ThemeProvider>
        <AccentProvider>
          <TextSizeProvider>
            <ToastProvider>
              <SettingsProvider>
                <Routes>
                  <Route path="/settings" element={<Settings />} />
                  <Route
                    path="/tickets"
                    element={<div data-testid="tickets-probe">tickets</div>}
                  />
                </Routes>
              </SettingsProvider>
            </ToastProvider>
          </TextSizeProvider>
        </AccentProvider>
      </ThemeProvider>
    </MemoryRouter>
  );
}

function renderSettings(): ReturnType<typeof render> {
  return render(settingsUi());
}

/**
 * F-038: every Settings group starts COLLAPSED inside a CollapsibleTile —
 * collapsed bodies are aria-hidden + inert, so role queries can't see their
 * controls. Tests open a tile exactly the way a user does: click its header
 * disclosure button. `fireEvent` suffices (a plain synchronous button click
 * with no debounce/timer interplay).
 */
function expandGroup(name: RegExp): void {
  const header = screen.getByRole('button', { name });
  if (header.getAttribute('aria-expanded') === 'false') {
    fireEvent.click(header);
  }
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
  // Fresh user — no tours seen (matches the empty localStorage the suite's
  // beforeEach clears to, so hydration stays a no-op here too).
  toursSeen: [],
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
  mocks.patchToursSeen.mockReset();
  // Server union echo: what the provider sent is what is now stored.
  mocks.patchToursSeen.mockImplementation((ids: string[]) =>
    Promise.resolve({ ...DEFAULT_PREFS, toursSeen: [...ids].sort() }),
  );
  mocks.startTour.mockReset();
  mocks.startTour.mockReturnValue({
    status: 'started',
    handle: { destroy: vi.fn() },
  });
  mocks.fetchSchedules.mockReset();
  mocks.putSchedules.mockReset();
  // Default: a fresh user — the server stores nothing until the first PUT
  // (nothing is implicitly on), so the client paints its suggested defaults.
  mocks.fetchSchedules.mockResolvedValue({ schedules: [] });
  mocks.putSchedules.mockResolvedValue({ schedules: [] });
  mocks.refresh.mockReset();
  mocks.refresh.mockResolvedValue(undefined);
  mocks.logout.mockReset();
  mocks.logout.mockResolvedValue(undefined);
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
  it('renders the visible groups (Profile / 2FA / Appearance); Notifications is gated off', () => {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);

    renderSettings();
    expect(screen.getByText('Profile')).toBeInTheDocument();
    expect(screen.getByText('Two-Factor Authentication')).toBeInTheDocument();
    expect(screen.getByText('Appearance')).toBeInTheDocument();
    // Notifications (F-040) is hidden until a delivery sender exists — the
    // schedule UI persists reminders nothing sends yet, so it is gated off
    // (NOTIFICATIONS_UI_ENABLED = false in Settings.tsx). Assert it stays out
    // of the DOM so the gate can't silently regress.
    expect(screen.queryByText('Notifications')).not.toBeInTheDocument();
  });

  it('P3b: group headings render Korean in both-mode, with 화면 표시 (not 외관)', () => {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);

    renderSettings();
    expect(screen.getByText('프로필')).toBeInTheDocument();
    // Notifications (F-040) is gated off until a delivery sender exists, so its
    // 알림 eyebrow is absent from both the group list and the topbar manifest.
    expect(screen.queryByText('알림')).not.toBeInTheDocument();
    // Glossary reconciliation: Appearance is 화면 표시 app-wide; 외관 retired.
    expect(screen.getByText('화면 표시')).toBeInTheDocument();
    expect(screen.queryByText('외관')).not.toBeInTheDocument();
    // The topbar eyebrow renders the nav manifest pair (Notifications dropped).
    expect(screen.getByText('프로필 · 화면 표시')).toBeInTheDocument();
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
    expandGroup(/Profile/);

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
    expandGroup(/Profile/);

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
    expandGroup(/Profile/);

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
    expandGroup(/Profile/);

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
    expandGroup(/Profile/);
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
    expandGroup(/Profile/);

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
    expandGroup(/Profile/);

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
    expandGroup(/Appearance/);

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

  it('F-040: the channel chips are gone and clearing Email no longer mutates the stored notif intents', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);

    // Seed a notif blob identical to the server default so hydration is a
    // no-op write-wise — any change to it after clearing Email would be the
    // retired Pass-2 coupling resurfacing.
    window.localStorage.setItem(
      'km.settings',
      JSON.stringify({
        name: '',
        email: '',
        phone: '',
        notif: DEFAULT_PREFS.notif,
        languageDisplay: DEFAULT_PREFS.languageDisplay,
      }),
    );

    renderSettings();
    expandGroup(/Profile/);

    // The old aria-pressed channel chips are gone from the page entirely.
    expect(screen.queryByText('Channels')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Email', hidden: true }),
    ).not.toBeInTheDocument();

    const emailInput = screen.getByLabelText('Email') as HTMLInputElement;
    expect(emailInput.value).toBe('jay@example.com');
    await user.clear(emailInput);
    expect(emailInput.value).toBe('');

    // Flush the provider's 200ms localStorage debounce — if the coupling
    // still existed, notif.channel.email would have been forced to false.
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    const stored = JSON.parse(
      window.localStorage.getItem('km.settings') ?? '{}',
    ) as { notif?: { channel?: { email?: boolean } } };
    expect(stored.notif?.channel?.email).toBe(true);
  });
});

describe('Settings — prefs server-sync (Pass 9)', () => {
  it('notif intents have no UI (F-040) but hydrate + echo verbatim through the prefs PUT', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
    // Server holds NON-default notif intents + a stored legacy palette. The
    // stored accent ('mint') is ADOPTED on hydrate, which doubles as a
    // deterministic hydration-settled marker for the pre-hydration PUT guard.
    const storedNotif = {
      channel: { email: true, sms: true },
      reviewsDue: false,
      daily: true,
      weekly: false,
    };
    const storedPalette = { paper: 'linen', accent: 'mint', correct: 'pine', wrong: 'amber' };
    mocks.fetchPrefs.mockResolvedValue({
      ...DEFAULT_PREFS,
      notif: storedNotif,
      palette: storedPalette,
    });

    renderSettings();
    await waitFor(() => {
      expect(document.documentElement.dataset.accent).toBe('mint');
    });

    // The old intent controls are gone, and the Notifications group is now
    // gated off entirely (NOTIFICATIONS_UI_ENABLED = false) until a delivery
    // sender exists — so neither the legacy "Send me"/"Channels" toggles nor
    // the F-040 schedule tile is present.
    expect(screen.queryByText('Send me')).not.toBeInTheDocument();
    expect(screen.queryByText('Channels')).not.toBeInTheDocument();
    expect(screen.queryByText('Notifications')).not.toBeInTheDocument();

    // A real Appearance change PUTs the full prefs object with the SERVER's
    // notif + palette echoed verbatim — nothing clobbered back to defaults.
    expandGroup(/Appearance/);
    await user.click(screen.getByRole('radio', { name: 'Cyber Blue' }));

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
      palette: unknown;
    };
    expect(body.notif).toEqual(storedNotif);
    expect(body.palette).toEqual({ ...storedPalette, accent: 'blue' });
  });

  it('F-093: "Reset to defaults" cannot smuggle a diverged notif into the prefs PUT', async () => {
    // resetSettings() (SettingsProvider) reverts the LOCAL `settings.notif`
    // (localStorage cache) to DEFAULT_SETTINGS.notif. Pre-F-093 the outgoing
    // PUT echoed `settings.notif` directly, so clicking Reset — an APPEARANCE
    // action with no notification UI at all (F-040 removed those toggles) —
    // would silently revert the user's server-stored notification intent as
    // a side effect. The fix always echoes `lastSyncedPrefsRef.current.notif`
    // (the last value the SERVER reported) instead, so Reset can no longer
    // touch it.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
    const storedNotif = {
      channel: { email: true, sms: true },
      reviewsDue: false,
      daily: true,
      weekly: false,
    };
    // languageDisplay mode 'en' is the deterministic hydration-settled probe
    // (same technique as "does not echo the server-hydrated prefs" above).
    mocks.fetchPrefs.mockResolvedValue({
      ...DEFAULT_PREFS,
      notif: storedNotif,
      languageDisplay: { mode: 'en', primary: 'ko', subScale: 0.7 },
    });

    renderSettings();
    expandGroup(/Appearance/);

    await waitFor(() => {
      expect(
        screen.getByRole('radio', { name: 'English' }),
      ).toHaveAttribute('aria-checked', 'true');
    });

    await user.click(screen.getByRole('button', { name: /Reset to defaults/ }));
    // Reset applies instantly to the provider (localStorage), same as any
    // other appearance change — no debounce on the reset button itself.
    expect(mocks.putPrefs).not.toHaveBeenCalled();

    // A real change (accent) fires the debounced PUT that would previously
    // have carried the just-reset (diverged) notif.
    await user.click(screen.getByRole('radio', { name: 'Cyber Blue' }));
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    await waitFor(() => {
      expect(mocks.putPrefs).toHaveBeenCalled();
    });
    const body = mocks.putPrefs.mock.calls.at(-1)?.[0] as { notif: unknown };
    // The PUT must still carry the STORED server notif — never the reset
    // default (`DEFAULT_PREFS.notif` differs from `storedNotif` on
    // sms/reviewsDue/daily/weekly, so a leak of the reset value would fail
    // this assertion).
    expect(body.notif).toEqual(storedNotif);
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
    expandGroup(/Appearance/);

    // Let hydration fully SETTLE (fetch resolve + effect commit) — the change
    // PUT is suppressed until it does (pre-hydration guard).
    await waitFor(() => {
      expect(mocks.fetchPrefs).toHaveBeenCalled();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Change probe: an accent pick (the notif toggles moved to
    // /notifications/schedules with F-040).
    const mint = screen.getByRole('radio', { name: 'Han Mint' });
    await user.click(mint);
    // The local change still applied instantly (provider is the cache).
    expect(document.documentElement.dataset.accent).toBe('mint');

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    // A3 ErrorCard-vs-Toast split: the sync failure is transient/background,
    // so it surfaces as a non-blocking toast (NOT an inline ErrorCard). The
    // screen is intact, the change is durable locally, and the pick keeps
    // its state.
    await waitFor(() => {
      expect(screen.getByText(/saved on this device/i)).toBeInTheDocument();
    });
    // It's a polite toast (role=status), not an alert/ErrorCard.
    const toast = screen.getByText(/saved on this device/i).closest('.km-toast');
    expect(toast).not.toBeNull();
    expect(mint).toHaveAttribute('aria-checked', 'true');

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
    // languageDisplay is the visible hydration probe (notif lost its UI with
    // F-040; the wire palette has been a passthrough echo since v2).
    mocks.fetchPrefs.mockResolvedValue({
      ...DEFAULT_PREFS,
      notif: { ...DEFAULT_PREFS.notif, daily: true },
      languageDisplay: { mode: 'en', primary: 'ko', subScale: 0.7 },
    });

    renderSettings();
    expandGroup(/Appearance/);

    await waitFor(() => {
      expect(
        screen.getByRole('radio', { name: 'English' }),
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
    // "server wins on load — last-writer-wins". What MUST hold now (probe is
    // the accent pick — the notif toggles moved to schedules with F-040):
    //   1. A pre-hydration edit applies instantly to the provider (offline-
    //      cache UX, durable in localStorage) but NEVER fires a PUT — a PUT at
    //      that point would carry the seeded LEGACY_PALETTE_DEFAULT/default
    //      baselines and clobber the server-stored blob.
    //   2. The late real settle wins on load: the server's accent is adopted
    //      (data-accent + km.accent) over the pre-hydration pick.
    //   3. Neither the settle nor the hydrate-adopt spawns an echo PUT — the
    //      PUT count stays at zero until a real post-hydration edit.
    //   4. A post-hydration edit saves promptly and echoes the server-stored
    //      palette (paper/correct/wrong) verbatim with the new accent —
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
    expandGroup(/Appearance/);

    // User picks an accent while hydration is still pending. The local
    // provider applies it instantly (offline-cache UX)…
    await user.click(screen.getByRole('radio', { name: 'Han Mint' }));
    expect(document.documentElement.dataset.accent).toBe('mint');

    // …but (1) the debounced PUT is SUPPRESSED — flush well past the window.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(mocks.putPrefs).not.toHaveBeenCalled();

    // Now the slow server settle lands holding a stored palette with a
    // DIFFERENT accent.
    const storedPalette = { paper: 'ivory', accent: 'blue', correct: 'teal', wrong: 'slate' };
    await act(async () => {
      releaseHydration({
        notif: DEFAULT_PREFS.notif,
        palette: storedPalette,
        languageDisplay: DEFAULT_PREFS.languageDisplay,
        textSize: DEFAULT_PREFS.textSize,
        toursSeen: DEFAULT_PREFS.toursSeen,
      });
    });

    // (2) Server wins on load: the server's accent is adopted locally over
    //     the pre-hydration pick.
    await waitFor(() => {
      expect(document.documentElement.dataset.accent).toBe('blue');
    });
    expect(window.localStorage.getItem('km.accent')).toBe('blue');

    // (3) Flush every timer: neither the hydration write nor the hydrate-adopt
    //     may spawn a PUT — the count stays at zero.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(mocks.putPrefs).not.toHaveBeenCalled();

    // (4) A post-hydration pick saves promptly and echoes the server's stored
    //     palette verbatim with the new accent.
    await user.click(screen.getByRole('radio', { name: 'Han Mint' }));
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await waitFor(() => {
      expect(mocks.putPrefs).toHaveBeenCalledTimes(1);
    });
    const body = mocks.putPrefs.mock.calls[0][0] as {
      palette: unknown;
    };
    expect(body.palette).toEqual({ ...storedPalette, accent: 'mint' });
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
    expandGroup(/Appearance/);

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
    expandGroup(/Appearance/);
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
    expandGroup(/Appearance/);
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
    expandGroup(/Appearance/);
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
    expandGroup(/Appearance/);

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
    expandGroup(/Appearance/);

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

describe('Settings — theme-mode control (A4, extended by F-132)', () => {
  it('renders Light / Dark / System / Auto as a labelled radiogroup', () => {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
    renderSettings();
    expandGroup(/Appearance/);
    const group = screen.getByRole('radiogroup', { name: 'Theme mode' });
    expect(within(group).getByRole('radio', { name: 'Light' })).toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: 'Dark' })).toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: 'System' })).toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: 'Auto' })).toBeInTheDocument();
  });

  it("selecting Auto (F-132) resolves data-theme from the local hour and persists 'auto'", async () => {
    // Daytime: 10:00 local, inside the 06:00–18:00 window → light.
    vi.setSystemTime(new Date('2026-07-14T10:00:00'));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
    renderSettings();
    expandGroup(/Appearance/);

    await user.click(screen.getByRole('radio', { name: 'Auto' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem('km.theme')).toBe('auto');
    expect(screen.getByRole('radio', { name: 'Auto' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it("selecting Auto (F-132) at a nighttime hour resolves dark", async () => {
    // Nighttime: 22:00 local, outside the window → dark.
    vi.setSystemTime(new Date('2026-07-14T22:00:00'));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
    renderSettings();
    expandGroup(/Appearance/);

    await user.click(screen.getByRole('radio', { name: 'Auto' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('km.theme')).toBe('auto');
  });

  it('a manual Dark pick after Auto overrides the clock-resolved theme (manual always wins)', async () => {
    vi.setSystemTime(new Date('2026-07-14T10:00:00')); // daytime — auto → light
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
    renderSettings();
    expandGroup(/Appearance/);

    await user.click(screen.getByRole('radio', { name: 'Auto' }));
    expect(document.documentElement.dataset.theme).toBe('light');

    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('km.theme')).toBe('dark');
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it("selecting Dark sets data-theme + persists km.theme; System clears it", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
    renderSettings();
    expandGroup(/Appearance/);

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

  it('exposes a single roving Tab stop and moves selection with arrow keys (Light/Dark/System/Auto)', async () => {
    // Pin the clock so Auto's resolved theme is deterministic (daytime → light).
    vi.setSystemTime(new Date('2026-07-14T10:00:00'));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
    renderSettings();
    expandGroup(/Appearance/);

    const light = screen.getByRole('radio', { name: 'Light' });
    const dark = screen.getByRole('radio', { name: 'Dark' });
    const system = screen.getByRole('radio', { name: 'System' });
    const auto = screen.getByRole('radio', { name: 'Auto' });

    // Roving tabindex: only the checked radio (System, the default with no
    // stored km.theme) is tabbable; the rest are removed from the Tab order.
    expect(system).toHaveAttribute('tabindex', '0');
    expect(light).toHaveAttribute('tabindex', '-1');
    expect(dark).toHaveAttribute('tabindex', '-1');
    expect(auto).toHaveAttribute('tabindex', '-1');

    // Focus the active radio, then drive the WAI-ARIA arrow-key contract.
    system.focus();
    expect(system).toHaveFocus();

    // ArrowRight advances System → Auto (the last option in the row),
    // committing selection AND moving focus (selection follows focus).
    await user.keyboard('{ArrowRight}');
    expect(auto).toHaveAttribute('aria-checked', 'true');
    expect(auto).toHaveFocus();
    expect(auto).toHaveAttribute('tabindex', '0');
    expect(document.documentElement.dataset.theme).toBe('light'); // 10:00 → daytime
    expect(window.localStorage.getItem('km.theme')).toBe('auto');

    // ArrowRight again wraps Auto → Light (back to the first option).
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

    // End jumps to the last option (Auto), storing 'auto' (not clearing it —
    // only 'system' clears the stored choice).
    await user.keyboard('{End}');
    expect(auto).toHaveAttribute('aria-checked', 'true');
    expect(auto).toHaveFocus();
    expect(window.localStorage.getItem('km.theme')).toBe('auto');

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
    expandGroup(/Two-Factor/);
    await waitFor(() => {
      expect(screen.getByText('Enabled')).toBeInTheDocument();
    });
    expect(screen.getByText(/6 recovery codes remaining/)).toBeInTheDocument();
  });

  it('has NO disable button (2FA is mandatory)', async () => {
    mocks.fetchMe.mockResolvedValue({ id: 1, email: 'jay@example.com' } satisfies User);

    renderSettings();
    await screen.findByText('Two-Factor Authentication');
    expandGroup(/Two-Factor/);

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
    expandGroup(/Two-Factor/);

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
    expandGroup(/Two-Factor/);

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
    expandGroup(/Appearance/);
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
    expandGroup(/Appearance/);
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
    expandGroup(/Appearance/);
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
    expandGroup(/Appearance/);
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
    expandGroup(/Appearance/);
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
    expandGroup(/Appearance/);
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
    expandGroup(/Appearance/);

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

// ─── Collapsible groups (F-038) ──────────────────────────────────────

describe('Settings — collapsible groups (F-038)', () => {
  function meOk(): void {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
  }

  it('every group renders collapsed: header aria-expanded=false wired to a hidden body', () => {
    meOk();
    renderSettings();
    // Notifications (F-040) is gated off until a delivery sender exists, so
    // it is intentionally absent from the rendered groups.
    for (const name of [
      /Profile/,
      /Two-Factor/,
      /Appearance/,
      /Beta feedback/,
    ]) {
      const header = screen.getByRole('button', { name });
      expect(header).toHaveAttribute('aria-expanded', 'false');
      const bodyId = header.getAttribute('aria-controls');
      expect(bodyId).not.toBeNull();
      const body = document.getElementById(bodyId ?? '');
      expect(body).not.toBeNull();
      expect(body).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('expanding the Profile tile reveals its controls; collapsing hides them again', () => {
    meOk();
    renderSettings();
    // Collapsed: the Name input is hidden from the accessibility tree
    // (aria-hidden body), so role queries can't reach it.
    expect(
      screen.queryByRole('textbox', { name: 'Name' }),
    ).not.toBeInTheDocument();

    expandGroup(/Profile/);
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Profile/ }));
    expect(
      screen.queryByRole('textbox', { name: 'Name' }),
    ).not.toBeInTheDocument();
  });

  it('the text-size control (F-025) still lives inside the Appearance tile', () => {
    meOk();
    renderSettings();
    expect(
      screen.queryByRole('radiogroup', { name: 'Text size' }),
    ).not.toBeInTheDocument();
    expandGroup(/Appearance/);
    expect(
      screen.getByRole('radiogroup', { name: 'Text size' }),
    ).toBeInTheDocument();
  });
});

// ─── Beta feedback entry point (F-023) ───────────────────────────────

describe('Settings — Beta feedback entry point (F-023)', () => {
  function meOk(): void {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
  }

  it('collapsed by default; expanding reveals the report button, which navigates to /tickets', async () => {
    meOk();
    const user = userEvent.setup();
    renderSettings();

    // Collapsed: the button is hidden from the accessibility tree.
    expect(
      screen.queryByRole('button', { name: /Report a bug or suggestion/ }),
    ).not.toBeInTheDocument();

    expandGroup(/Beta feedback/);
    const reportButton = screen.getByRole('button', {
      name: /Report a bug or suggestion/,
    });
    expect(reportButton).toBeInTheDocument();

    await user.click(reportButton);
    expect(await screen.findByTestId('tickets-probe')).toBeInTheDocument();
  });
});

// ─── Log out (Profile group action) ──────────────────────────────────

describe('Settings — Log out', () => {
  function meOk(): void {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
  }

  it('lives in the Profile tile: hidden while collapsed, revealed on expand', () => {
    meOk();
    renderSettings();

    // Collapsed: the tile body stays MOUNTED but aria-hidden + inert
    // (CollapsibleTile's contract), so the button is invisible to the
    // default role query yet reachable with `hidden: true`. Assert BOTH
    // halves — the default-query absence alone would pass vacuously even
    // if the body unmounted, and the hidden-query presence pins the
    // "hidden, not gone" mechanism.
    expect(
      screen.queryByRole('button', { name: /Log out/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Log out/, hidden: true }),
    ).toBeInTheDocument();

    expandGroup(/Profile/);
    const logoutButton = screen.getByRole('button', { name: /Log out/ });
    expect(logoutButton).toBeInTheDocument();
    expect(logoutButton).toBeEnabled();
    // The hint explains the consequence next to the control.
    expect(
      screen.getByText(/Ends your session on this device/),
    ).toBeInTheDocument();
  });

  it('clicking it calls useAuth().logout exactly once (state clear + /login redirect are AuthProvider/RequireAuth contracts)', async () => {
    meOk();
    const user = userEvent.setup();
    renderSettings();

    expandGroup(/Profile/);
    await user.click(screen.getByRole('button', { name: /Log out/ }));

    expect(mocks.logout).toHaveBeenCalledTimes(1);
    // No arguments — the context method owns the whole flow.
    expect(mocks.logout).toHaveBeenCalledWith();
  });

  it('single-flights: while the logout is in flight the button disables (aria-busy) and re-clicks do not re-fire', async () => {
    meOk();
    // Never-settling logout keeps the in-flight window open for the whole
    // test. In the real app the RequireAuth gate unmounts Settings when the
    // provider flips to guest, so "stuck disabled" is unreachable there.
    mocks.logout.mockReset();
    // Never-settling promise; typed `Promise<undefined>` to match the hoisted
    // mock's inferred return type (`vi.fn(async () => undefined)`).
    mocks.logout.mockImplementation(
      () => new Promise<undefined>(() => undefined),
    );
    const user = userEvent.setup();
    renderSettings();

    expandGroup(/Profile/);
    const logoutButton = screen.getByRole('button', { name: /Log out/ });
    await user.click(logoutButton);

    expect(logoutButton).toBeDisabled();
    expect(logoutButton).toHaveAttribute('aria-busy', 'true');

    // A second click must not re-fire. Precision on WHAT this proves:
    // fireEvent bypasses user-event's pointer-events simulation, but React
    // itself refuses to dispatch onClick on a `disabled` button — so the
    // re-fire is stopped by the `disabled` attribute before the
    // `if (loggingOut) return` closure guard is ever reached. That guard
    // stays as (unexercised) belt-and-suspenders for the sliver between
    // the first click and the disabling re-render; the protection this
    // test pins is `disabled` blocking the re-fire, and removing
    // `disabled` fails the `toBeDisabled()` assertion above.
    fireEvent.click(logoutButton);
    expect(mocks.logout).toHaveBeenCalledTimes(1);
  });
});

// ─── Uploads removal (F-039) ─────────────────────────────────────────

describe('Settings — Uploads removed (F-039)', () => {
  it('no Uploads section, upload button, or uploads link renders anywhere (even hidden)', () => {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
    renderSettings();
    // Text queries do NOT filter aria-hidden content, so these hold even
    // for collapsed tiles — the section is gone, not merely folded away.
    expect(screen.queryByText('Uploads')).not.toBeInTheDocument();
    expect(screen.queryByText('Upload a book')).not.toBeInTheDocument();
    expect(screen.queryByText('See all uploads')).not.toBeInTheDocument();
    expect(screen.queryByText('책 업로드')).not.toBeInTheDocument();
  });
});

// ─── Notification schedules (F-040) ──────────────────────────────────
//
// SKIPPED while NOTIFICATIONS_UI_ENABLED is false (Settings.tsx): the
// Notifications group is gated out of the render until a delivery sender
// exists, so the schedule tile these tests drive is not mounted. The wiring
// they cover is deliberately left intact — un-skip this block in the same
// change that flips NOTIFICATIONS_UI_ENABLED to true and ships the sender.
describe.skip('Settings — notification schedules (F-040)', () => {
  function meOk(): void {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
  }

  /** Expand the Notifications tile and wait for the schedules hydration to
   *  land (the rows are DISABLED until it does — no localStorage backs them). */
  async function openHydratedNotifications(): Promise<void> {
    expandGroup(/Notifications/);
    await waitFor(() => {
      expect(
        screen.getByRole('switch', { name: 'Daily reminder' }),
      ).toBeEnabled();
    });
  }

  it('adopts stored server schedules on load (time, weekday, enabled); sms rows never bleed in', async () => {
    meOk();
    mocks.fetchSchedules.mockResolvedValue({
      schedules: [
        {
          kind: 'daily_reminder',
          channel: 'email',
          timeOfDay: '21:30',
          tz: 'Asia/Seoul',
          weekday: null,
          enabled: true,
          placeholder: false,
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
        {
          kind: 'weekly_report',
          channel: 'email',
          timeOfDay: '07:45',
          tz: 'Asia/Seoul',
          weekday: 3,
          enabled: false,
          placeholder: false,
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
        // A stored sms row is placeholder data — it must not overwrite the
        // editable email rows OR light up the inert preview.
        {
          kind: 'daily_reminder',
          channel: 'sms',
          timeOfDay: '11:11',
          tz: 'Asia/Seoul',
          weekday: null,
          enabled: true,
          placeholder: true,
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
      ],
    });

    renderSettings();
    await openHydratedNotifications();

    // The stored email rows hydrate the controls…
    expect(
      screen.getByRole('switch', { name: 'Daily reminder' }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      (screen.getByLabelText('Daily reminder time') as HTMLInputElement).value,
    ).toBe('21:30');
    expect(
      (screen.getByLabelText('Weekly report time') as HTMLInputElement).value,
    ).toBe('07:45');
    expect(
      (screen.getByLabelText('Weekly report day') as HTMLSelectElement).value,
    ).toBe('3');
    // …a never-stored kind keeps its suggested default…
    expect(
      (screen.getByLabelText('Reviews due time') as HTMLInputElement).value,
    ).toBe('18:00');
    // …and the sms preview stays inert and unlit.
    const smsDaily = screen.getByRole('switch', {
      name: 'Daily reminder (SMS)',
    });
    expect(smsDaily).toBeDisabled();
    expect(smsDaily).toHaveAttribute('aria-checked', 'false');
  });

  it('enabling a type debounces ONE partial PUT: email channel, suggested time, device tz, no weekday', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    meOk();

    renderSettings();
    await openHydratedNotifications();

    const daily = screen.getByRole('switch', { name: 'Daily reminder' });
    await user.click(daily);
    // Optimistic locally, nothing on the wire before the debounce elapses.
    expect(daily).toHaveAttribute('aria-checked', 'true');
    expect(mocks.putSchedules).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await waitFor(() => {
      expect(mocks.putSchedules).toHaveBeenCalledTimes(1);
    });
    const rows = mocks.putSchedules.mock.calls[0][0] as Array<
      Record<string, unknown>
    >;
    expect(rows).toEqual([
      {
        kind: 'daily_reminder',
        channel: 'email',
        timeOfDay: '08:00',
        tz: expect.any(String),
        enabled: true,
      },
    ]);
    // The server's .strict() schema forbids weekday off weekly_report — the
    // key must be OMITTED, not undefined.
    expect(rows[0]).not.toHaveProperty('weekday');
  });

  it('weekly day + time edits coalesce into one PUT carrying weekday', async () => {
    meOk();

    renderSettings();
    await openHydratedNotifications();

    fireEvent.change(screen.getByLabelText('Weekly report day'), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByLabelText('Weekly report time'), {
      target: { value: '10:15' },
    });

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await waitFor(() => {
      expect(mocks.putSchedules).toHaveBeenCalledTimes(1);
    });
    expect(mocks.putSchedules.mock.calls[0][0]).toEqual([
      {
        kind: 'weekly_report',
        channel: 'email',
        timeOfDay: '10:15',
        tz: expect.any(String),
        weekday: 1,
        enabled: false,
      },
    ]);
  });

  it('edits to two kinds inside the debounce window batch into a single PUT', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    meOk();

    renderSettings();
    await openHydratedNotifications();

    await user.click(screen.getByRole('switch', { name: 'Daily reminder' }));
    await user.click(screen.getByRole('switch', { name: 'Reviews due' }));

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await waitFor(() => {
      expect(mocks.putSchedules).toHaveBeenCalledTimes(1);
    });
    const rows = mocks.putSchedules.mock.calls[0][0] as Array<{
      kind: string;
      enabled: boolean;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind).sort()).toEqual([
      'daily_reminder',
      'reviews_due',
    ]);
    expect(rows.every((r) => r.enabled)).toBe(true);
  });

  it('never PUTs before hydration — the rows are disabled until the GET settles', async () => {
    meOk();
    let releaseSchedules!: (v: { schedules: never[] }) => void;
    mocks.fetchSchedules.mockReturnValue(
      new Promise<{ schedules: never[] }>((resolve) => {
        releaseSchedules = resolve;
      }),
    );

    renderSettings();
    expandGroup(/Notifications/);

    const daily = screen.getByRole('switch', { name: 'Daily reminder' });
    expect(daily).toBeDisabled();
    expect(screen.getByLabelText('Daily reminder time')).toBeDisabled();

    // A click on the disabled switch is a no-op — nothing dirties, nothing
    // fires, even well past the debounce window.
    fireEvent.click(daily);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(mocks.putSchedules).not.toHaveBeenCalled();
    expect(daily).toHaveAttribute('aria-checked', 'false');

    // The settle unlocks the rows.
    await act(async () => {
      releaseSchedules({ schedules: [] });
    });
    await waitFor(() => {
      expect(daily).toBeEnabled();
    });
  });

  it('a failed PUT keeps the choice on screen and Retry re-sends it', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    meOk();
    mocks.putSchedules.mockRejectedValueOnce(
      new ApiError('network unreachable', { status: 0, code: 'network' }),
    );

    renderSettings();
    await openHydratedNotifications();

    const daily = screen.getByRole('switch', { name: 'Daily reminder' });
    await user.click(daily);
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    // Author-controlled failure copy; the optimistic state is NOT rolled
    // back (the dirty set keeps it pending for the retry).
    await waitFor(() => {
      expect(
        screen.getByText(/notification schedule could not be saved/i),
      ).toBeInTheDocument();
    });
    expect(daily).toHaveAttribute('aria-checked', 'true');

    // Retry re-sends the SAME still-dirty row (the default mock resolves).
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(mocks.putSchedules).toHaveBeenCalledTimes(2);
    });
    expect(mocks.putSchedules.mock.calls[1][0]).toEqual([
      expect.objectContaining({ kind: 'daily_reminder', enabled: true }),
    ]);
  });

  it('SMS renders as a labelled disabled placeholder — same three types, never interactive', async () => {
    meOk();

    renderSettings();
    await openHydratedNotifications();

    // Clearly labelled as not-live.
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
    expect(screen.getByText(/isn’t available yet/)).toBeInTheDocument();

    // All three types are offered, every control disabled.
    for (const name of [
      'Daily reminder (SMS)',
      'Reviews due (SMS)',
      'Weekly report (SMS)',
    ]) {
      expect(screen.getByRole('switch', { name })).toBeDisabled();
    }
    expect(screen.getByLabelText('Daily reminder (SMS) time')).toBeDisabled();
    expect(screen.getByLabelText('Weekly report (SMS) day')).toBeDisabled();

    // And nothing an errant click could do ever reaches the wire.
    fireEvent.click(screen.getByRole('switch', { name: 'Daily reminder (SMS)' }));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(mocks.putSchedules).not.toHaveBeenCalled();
  });
});

// F-128 "Seoul Day & Night" reskin — the header adopts the shared
// PageHubHeader (mirrors every other reskinned page's own fidelity test,
// e.g. Mistakes.test.tsx's "F-128 BLOCKER-2 fix") and every group now rides
// a CityCard signboard instead of a flat Card.
describe('Settings — F-128 reskin (shared PageHubHeader + CityCard groups)', () => {
  it('renders the shared PageHubHeader recipe (skyline + rail + a real h1) instead of a flat Topbar', () => {
    meOk();
    const { container } = renderSettings();

    expect(
      container.querySelector('.km-hubheader__skyline'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('.km-hubheader__rail-divider'),
    ).toBeInTheDocument();
    const heading = screen.getByRole('heading', {
      level: 1,
      name: '설정 · Settings',
    });
    expect(heading).toHaveAttribute('id', 'km-settings-title');
  });

  it('every group rides a CityCard signboard (surface="city") instead of a flat Card', () => {
    meOk();
    const { container } = renderSettings();

    // Profile / 2FA / Appearance / Beta feedback — four CollapsibleTile
    // groups, every one `surface="city"`. Notifications (F-040) is gated off
    // until a delivery sender exists, so it is not among them.
    const cityGroups = container.querySelectorAll(
      '.km-settings__group.km-citycard.km-collapsible',
    );
    expect(cityGroups.length).toBe(4);
  });

  it('reskinning the groups does not disturb the collapsed-by-default disclosure contract (F-038)', () => {
    meOk();
    renderSettings();

    const profileHeader = screen.getByRole('button', { name: /Profile/ });
    expect(profileHeader).toHaveAttribute('aria-expanded', 'false');
    expandGroup(/Profile/);
    expect(profileHeader).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });
});

describe('Settings — schedule field touch-target floor (S-1 fix-pass, REVIEW_batch4-cst.md)', () => {
  // jsdom does no layout, so the ~33-34px computed height this fix corrects
  // can't be measured by rendering — pin the CSS source instead (same
  // technique as ChatFab.test.tsx's stylesheet-contract test).
  it('the day/time schedule field declares a 44px min-height', () => {
    const stylesheet = readFileSync(
      join(cwd(), 'src', 'pages', 'Settings.css'),
      'utf8',
    );
    const rule = /\.km-settings__sched-field\s*\{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    expect(rule).not.toBe('');
    expect(rule).toMatch(/min-height:\s*44px/);
  });
});

function meOk(): void {
  mocks.fetchMe.mockResolvedValue({
    id: 1,
    email: 'jay@example.com',
    display_name: 'Jay',
    phone: '+15555550100',
  } satisfies User);
}

/**
 * Device-adaptive epic, Phase D2 (fix-pass revision) — the five settings
 * groups as a desktop two-column grid, driven entirely by CSS.
 *
 * The groups render inside ONE always-mounted `.km-settings__grid` wrapper
 * at EVERY width; Settings.css turns that wrapper into a row-major
 * 2-column grid at ≥1024px and leaves it styleless below. There is no
 * device-class render branch — the original D2 branch swap remounted the
 * groups on a live 1024px crossing (iPad rotation) and wiped
 * TwoFactorSection's shown-once recovery codes (fix-pass SHOULD-FIX 1) —
 * so the DOM is IDENTICAL across mobile / tablet / desktop (pinned below),
 * the no-remount property is pinned by the resize-crossing test, and the
 * layout gate itself is pinned at the CSS-source level (jsdom does no
 * layout).
 *
 * `src/test/setup.ts` installs a `matches: false` matchMedia before every
 * test (mobile-first baseline), so every test ABOVE this block already
 * exercises the same single tree at mobile. Width-specific tests stub
 * matchMedia via the SHARED `mockViewportWidth` helper
 * (src/test/viewport.ts — one canonical copy of the D1/D2 idiom, and its
 * non-width queries stay `false`, matching setup.ts's baseline).
 */
describe('Settings — device-adaptive two-column layout (Phase D2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The visible group headers, in the canonical (mobile) order. Notifications
   *  (F-040) is gated off until a delivery sender exists, so it is absent. */
  const GROUP_ORDER: ReadonlyArray<RegExp> = [
    /Profile/,
    /Two-Factor/,
    /Appearance/,
    /Beta feedback/,
  ];

  function expectGroupOrder(): void {
    // Disclosure headers in DOCUMENT order — `getAllByRole` walks the DOM,
    // so this pins reading/tab order, not just presence.
    const headerNames = screen
      .getAllByRole('button')
      .map((b) => b.textContent ?? '')
      .filter((t) =>
        GROUP_ORDER.some((re) => re.test(t)),
      );
    expect(headerNames).toHaveLength(4);
    GROUP_ORDER.forEach((re, i) => {
      expect(headerNames[i]).toMatch(re);
    });
  }

  /**
   * The single-tree contract: exactly one `.km-settings__grid` wrapper
   * whose DIRECT children are the four visible groups (they are the grid items —
   * row-major auto-placement depends on nothing else sneaking in between),
   * in the canonical mobile document order. Because the tree is the same
   * at every width, every width test asserts this same shape.
   */
  function expectSingleGridTree(container: HTMLElement): void {
    const grids = container.querySelectorAll('.km-settings__grid');
    expect(grids).toHaveLength(1);
    const children = Array.from(grids[0].children);
    expect(children).toHaveLength(4);
    children.forEach((child) => {
      expect(child.classList.contains('km-settings__group')).toBe(true);
    });
    expectGroupOrder();
  }

  it('mobile (default test matchMedia): the five groups are direct children of the one styleless grid wrapper, in order', () => {
    meOk();
    const { container } = renderSettings();
    expectSingleGridTree(container);
  });

  it('tablet (768px): IDENTICAL tree — the two-column layout is pure CSS, gated at 1024px, so the DOM never changes', () => {
    mockViewportWidth(768);
    meOk();
    const { container } = renderSettings();
    expectSingleGridTree(container);
  });

  it('desktop (1024px): IDENTICAL tree again — row-major grid placement preserves the mobile document/tab/SR order', () => {
    mockViewportWidth(1024);
    meOk();
    const { container } = renderSettings();
    expectSingleGridTree(container);
  });

  it('desktop (1440px, above the shell cap): same tree', () => {
    mockViewportWidth(1440);
    meOk();
    const { container } = renderSettings();
    expectSingleGridTree(container);
  });

  it('layout only: a group in the desktop layout keeps its full disclosure + controls behavior (F-038 contract)', () => {
    mockViewportWidth(1280);
    meOk();
    renderSettings();

    const profileHeader = screen.getByRole('button', { name: /Profile/ });
    expect(profileHeader).toHaveAttribute('aria-expanded', 'false');
    expandGroup(/Profile/);
    expect(profileHeader).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
  });

  it('resize across 1024px does NOT remount the groups — one-shot 2FA recovery codes survive an iPad rotation (fix-pass SHOULD-FIX 1)', async () => {
    // The sharpest state this page holds: freshly regenerated recovery
    // codes are kept in TwoFactorSection's own state, shown once, never
    // persisted — and the OLD codes are already invalidated server-side by
    // the time they render. The original D2 branch swap unmounted the
    // group on a live desktop↔tablet crossing and destroyed this display.
    const viewport = mockViewportWidth(1024); // desktop
    meOk();
    mocks.regenerateRecoveryCodes.mockResolvedValue({
      recoveryCodes: ['NEW11-NEW22', 'NEW33-NEW44'],
    });
    const view = render(settingsUi());
    await screen.findByText('Two-Factor Authentication');
    expandGroup(/Two-Factor/);

    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: 'Regenerate recovery codes' }),
    );
    await user.type(
      screen.getByLabelText('Confirm your password to continue'),
      'a-long-passphrase',
    );
    await user.click(screen.getByRole('button', { name: 'Regenerate codes' }));
    const codeEl = await screen.findByText('NEW11-NEW22');
    const twoFactorHeader = screen.getByRole('button', { name: /Two-Factor/ });

    // Rotate: desktop (1024px) → tablet (768px). `set` fires the matchMedia
    // change listeners exactly like a real MediaQueryList; the explicit
    // rerender then forces a top-down pass so even an implementation that
    // reads the width without subscribing would be exercised.
    act(() => {
      viewport.set(768);
    });
    view.rerender(settingsUi());

    // SAME DOM nodes ⇒ React never unmounted the group components — the
    // one-shot codes (and the open tile) survived the crossing. A remount
    // would render NEW elements, failing the identity checks even if the
    // text happened to reappear.
    expect(screen.getByText('NEW11-NEW22')).toBe(codeEl);
    expect(screen.getByText('NEW33-NEW44')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Two-Factor/ })).toBe(
      twoFactorHeader,
    );
    expect(twoFactorHeader).toHaveAttribute('aria-expanded', 'true');

    // And back up across the boundary (tablet → desktop) for good measure.
    act(() => {
      viewport.set(1280);
    });
    view.rerender(settingsUi());
    expect(screen.getByText('NEW11-NEW22')).toBe(codeEl);
  });

  it('CSS: `.km-settings__grid` is a 2-column grid gated behind the ≥1024px DESKTOP breakpoint (not 768px)', () => {
    // jsdom does no layout — pin the CSS source (same technique as the
    // touch-target test above and Today.test.tsx's D1 geometry tests). The
    // 1024px gate matters doubly now: it is the ONLY gate (no render
    // branch), and this asserts it wasn't written against the shared 768px
    // sidebar breakpoint by copy-paste.
    const stylesheet = readFileSync(
      join(cwd(), 'src', 'pages', 'Settings.css'),
      'utf8',
    );
    const mediaBlock =
      /@media \(min-width: 1024px\) \{\s*\.km-settings__grid \{[\s\S]*?\n\}/.exec(
        stylesheet,
      )?.[0] ?? '';
    expect(mediaBlock).not.toBe('');
    expect(mediaBlock).toContain('display: grid;');
    expect(mediaBlock).toContain(
      'grid-template-columns: repeat(2, minmax(0, 1fr));',
    );
    // Orphan guard: with five groups, the trailing odd group spans the full
    // row instead of stranding at half width beside a blank cell.
    expect(mediaBlock).toContain(':last-child:nth-child(odd)');
    expect(mediaBlock).toContain('grid-column: 1 / -1;');
    // And no 768px-gated rule touches the grid wrapper anywhere.
    expect(stylesheet).not.toMatch(
      /@media \(min-width: 768px\)[\s\S]{0,400}km-settings__grid/,
    );
  });
});

describe('Settings — Help & tours (fix-pass SF-2: mounted WITH a real TourProvider)', () => {
  /**
   * The 65 tests above render provider-free, so `ToursSection` returns null
   * in all of them (by design — `useTourOptional`). These tests mount the
   * REAL `TourProvider` (runner + server sync mocked at their module
   * boundaries) around the same provider stack, so the section renders and
   * the Replay / Skip-all wiring is exercised end-to-end: context → provider
   * state → localStorage + PATCH persistence.
   */
  function renderSettingsWithTours(): void {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <ThemeProvider>
          <AccentProvider>
            <TextSizeProvider>
              <ToastProvider>
                <SettingsProvider>
                  <TourProvider>
                    <Routes>
                      <Route path="/settings" element={<Settings />} />
                      <Route
                        path="/tickets"
                        element={<div data-testid="tickets-probe">tickets</div>}
                      />
                    </Routes>
                  </TourProvider>
                </SettingsProvider>
              </ToastProvider>
            </TextSizeProvider>
          </AccentProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
  }

  /** Seed the seen-set BEFORE mount (the suite's beforeEach cleared it).
   *  Also keeps the provider's auto-fire quiet: with `first-run` seen and
   *  no surface tour registered for /settings, nothing fires on its own. */
  function seedSeen(ids: readonly string[]): void {
    window.localStorage.setItem(TOURS_SEEN_STORAGE_KEY, JSON.stringify(ids));
  }

  function startedTourIds(): string[] {
    return mocks.startTour.mock.calls.map(
      (c) => (c[0] as TourDefinition).id,
    );
  }

  beforeEach(() => {
    mocks.fetchMe.mockResolvedValue({
      id: 1,
      email: 'jay@example.com',
      display_name: 'Jay',
    } satisfies User);
  });

  it('renders the section with the Replay controls and the skip-all button (null without the provider — proven by every other test in this file)', async () => {
    seedSeen([...TOUR_IDS]);
    renderSettingsWithTours();
    expandGroup(/Help & tours/);

    expect(
      screen.getByRole('button', { name: /Replay the welcome tour/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Choose a page intro to replay' }),
    ).toBeInTheDocument();
    // No pick yet → Replay is disabled (DOM value narrowing gate).
    expect(
      screen.getByRole('button', { name: /Replay$/ }),
    ).toBeDisabled();
    await act(async () => {
      vi.advanceTimersByTime(10); // settle the provider's boot fetch
    });
  });

  it('Replay re-arms an already-SEEN surface tour: picking it and clicking Replay runs it again despite its seen mark', async () => {
    seedSeen([...TOUR_IDS]); // hanja included — the tour is "used up"
    renderSettingsWithTours();
    await act(async () => {
      vi.advanceTimersByTime(10); // hydrate (all seen → no auto-fire)
    });
    expandGroup(/Help & tours/);

    fireEvent.change(
      screen.getByRole('combobox', { name: 'Choose a page intro to replay' }),
      { target: { value: 'hanja' } },
    );
    const replayBtn = screen.getByRole('button', {
      name: /Replay$/,
    });
    expect(replayBtn).toBeEnabled();
    fireEvent.click(replayBtn);

    // The provider navigates to the tour's surface first, then runs it after
    // the paint-settle delay.
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    expect(startedTourIds()).toEqual(['hanja']);
  });

  it('Replay the welcome tour re-runs first-run despite its seen mark', async () => {
    seedSeen([...TOUR_IDS]);
    renderSettingsWithTours();
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    expandGroup(/Help & tours/);

    fireEvent.click(
      screen.getByRole('button', { name: /Replay the welcome tour/ }),
    );
    // first-run replays from Today (`/`) so its chrome anchors resolve.
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    expect(startedTourIds()).toEqual(['first-run']);
  });

  it('Skip all tours marks EVERY tour seen and persists it (localStorage + field-scoped PATCH), then disables itself', async () => {
    seedSeen(['first-run']); // partial → skip-all is live, no auto-fire on /settings
    renderSettingsWithTours();
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    expandGroup(/Help & tours/);

    const skipBtn = screen.getByRole('button', { name: /Skip all tours/ });
    expect(skipBtn).toBeEnabled();
    fireEvent.click(skipBtn);

    // Same-device tier: every registered id lands in localStorage.
    await waitFor(() => {
      expect(
        JSON.parse(
          window.localStorage.getItem(TOURS_SEEN_STORAGE_KEY) ?? '[]',
        ) as string[],
      ).toEqual([...TOUR_IDS].sort());
    });
    // Cross-device tier: ONE field-scoped PATCH with the full id set — and
    // never a full-blob PUT from the tour path (S3 posture).
    await waitFor(() => {
      expect(mocks.patchToursSeen).toHaveBeenCalledTimes(1);
    });
    expect(mocks.patchToursSeen).toHaveBeenCalledWith([...TOUR_IDS].sort());
    expect(mocks.putPrefs).not.toHaveBeenCalled();

    // The control reflects the suppressed state and can't double-fire.
    const offBtn = await screen.findByRole('button', {
      name: /All tours are off/,
    });
    expect(offBtn).toBeDisabled();

    // …and the suppression is REAL: no tour ever started in this test.
    expect(mocks.startTour).not.toHaveBeenCalled();
  });
});
