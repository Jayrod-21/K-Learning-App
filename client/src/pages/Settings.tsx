/**
 * Settings screen — profile (server) · notifications (local) · appearance (local).
 *
 * Split substrate (Pass 3 wiring):
 *   - **Profile (name / email / phone)** persists to the server via
 *     `PATCH /auth/me`. Hydrates from `GET /auth/me` on mount through
 *     `useEndpointOrMock('settings:me', loadSettingsMock, { realFn: fetchMe })`.
 *     `useAuth().user` is the seeded initial value so the form never
 *     paints empty during the first network round-trip.
 *   - **Notifications + Appearance** still persist to `localStorage` via
 *     `useSettings()` — server sync lands in Pass 9.
 *
 * Auto-save UX (profile only):
 *   - Controlled inputs feed an edit buffer.
 *   - 600ms debounce after the last keystroke fires `patchMe(diff)` with
 *     ONLY the changed fields. Longer than the SettingsProvider's 200ms
 *     localStorage debounce because this is a real network round-trip.
 *   - On success, `useAuth().refresh()` re-probes `/auth/me` so the
 *     in-memory `user` ref reflects the new server state for the rest of
 *     the app.
 *   - On failure (network, 409 email conflict, validation), the input is
 *     rolled back to the last-known-good server value and an inline
 *     `<ErrorCard/>` surfaces — the input keeps focus so the user can
 *     try again.
 *
 * One-way coupling (kept from Pass 2):
 *   - Clearing the profile Email → also clears local `notif.channel.email`.
 *   - Clearing the profile Phone → also clears local `notif.channel.sms`.
 *   - Re-typing does NOT auto-re-enable. The user opts back in explicitly.
 *
 * Threat model — Pass 3 wire-up:
 *   - **Email-change account takeover.** A hijacked session can change
 *     the account email (cookie alone authenticates the request). The
 *     cookie is `HttpOnly` + `SameSite=Strict` + per-IP rate-limited
 *     (`authLimiter`); email-verification-on-change is tracked at
 *     FU-NF-16 and shifts to defence-in-depth once it lands. Server
 *     writes an audit row on every PATCH (P3A SECURITY.md §10) so the
 *     compromise is forensically observable.
 *   - **Rate limiting** is enforced server-side. The client does not
 *     re-implement; the 600ms debounce is UX (not a security control)
 *     and a misbehaving client merely burns its own per-IP bucket.
 *   - **Optimistic rollback.** A failed save reverts the visible value
 *     to the last-known-server value, so a 409 (duplicate email)
 *     doesn't leave the form lying about its persisted state. The
 *     `ErrorCard` text is author-controlled — never an echo of the
 *     server message — closing the XSS-via-error-string vector.
 *   - **Concurrency / stale-write.** Two rapid edits in the SAME tab race
 *     locally: the latest timer wins, the previous one is cleared before it
 *     fires. Cross-tab / cross-device races (browser + phone editing the
 *     profile concurrently) are caught by optimistic concurrency: the
 *     PATCH carries `expected_version`, the server gates the UPDATE on it,
 *     a stale value 409s, and the client refetches + re-renders before the
 *     user retries the save.
 *   - **Abort on unmount.** Both the fetch (via `useEndpointOrMock`'s
 *     own controller) and the in-flight PATCH (via a local controller)
 *     are aborted on unmount. Late settles check the controller flag
 *     before touching state.
 *
 * Requires `<AuthProvider/>` AND `<SettingsProvider/>` in the tree.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { Card } from '../components/Card';
import { ErrorCard } from '../components/ErrorCard';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { SwatchPicker } from '../components/SwatchPicker';
import { Toggle } from '../components/Toggle';
import { Topbar } from '../components/Topbar';
import { useAuth } from '../hooks/useAuth';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { useSettings } from '../hooks/useSettings';
import { fetchMe, patchMe } from '../services/auth';
import type { User } from '../hooks/auth-context';

/**
 * Mock fallback for the `/auth/me` query — returns a user-shaped fixture so
 * the screen still renders during dev when the server route is down. The
 * Pass 2 `loadSettingsMock` returns a `Settings` shape and is unrelated to
 * the server user; we keep this Mock local to Settings.tsx because no other
 * screen needs it.
 */
async function loadMeMock(): Promise<User> {
  // Tiny synthetic delay so the loading skeleton paints — matches the other
  // mock loaders' shape.
  await new Promise((resolve) => setTimeout(resolve, 80));
  return {
    id: 0,
    email: 'me@example.com',
    display_name: 'Jared',
    phone: '',
    version: 1,
  };
}
import { ApiError } from '../services/api';
import {
  ACCENT_PRESETS,
  CORRECT_PRESETS,
  PAPER_PRESETS,
  WRONG_PRESETS,
} from '../lib/palette-presets';
import type { IconName } from '../components/Icon';
import type { PatchAuthMeBody } from '../types/domain';

/** Local edit buffer for the three server-backed profile fields. */
interface ProfileBuffer {
  display_name: string;
  email: string;
  phone: string;
}

/** Per-field error map — distinct so a phone failure doesn't shadow email. */
type ProfileFieldErrors = Partial<Record<keyof ProfileBuffer, string>>;

const DEBOUNCE_MS = 600;

/** Fallback version when the server hasn't reported one yet. Real callers
 *  read `useAuth().user.version`; this only paints during the first
 *  paint-before-fetch window. */
const VERSION_DEFAULT = 1;

/** User → buffer projection. `undefined` server fields surface as empty strings. */
function bufferFromUser(user: User | null): ProfileBuffer {
  return {
    display_name: user?.display_name ?? '',
    email: user?.email ?? '',
    phone: user?.phone ?? '',
  };
}

/**
 * Author-controlled error copy. Never echo `err.message` — that's a server
 * string and the ErrorCard's docstring forbids untrusted text.
 */
function messageFor(err: ApiError, field: keyof ProfileBuffer): string {
  if (err.status === 409 && field === 'email') {
    return 'That email is already in use. Try a different one.';
  }
  if (err.status === 400) return 'That value was rejected. Check the format.';
  if (err.status === 401) return 'Your session expired. Sign in again.';
  if (err.status === 429) return 'Too many changes — try again in a minute.';
  if (err.status === 0 || err.code === 'network') {
    return 'Network unreachable. Your change was not saved.';
  }
  return 'Saving that change failed. Try again.';
}

export default function Settings(): JSX.Element {
  const { user, refresh } = useAuth();
  const { settings, updateSettings, resetSettings } = useSettings();

  // Hydrate from /auth/me. Mock fallback keeps the screen rendering during
  // dev when the server route is down; `isMock` flips the corner badge.
  const meQuery = useEndpointOrMock<User>('settings:me', loadMeMock, {
    realFn: fetchMe,
  });

  // The "server truth" for the form — initialised from useAuth (already
  // hydrated by AuthProvider), then overwritten whenever the explicit
  // fetchMe in `meQuery` resolves. This is also the rollback target on a
  // PATCH failure.
  const [serverProfile, setServerProfile] = useState<ProfileBuffer>(() =>
    bufferFromUser(user),
  );

  // Local edit buffer. Diverges from `serverProfile` while the user is
  // typing; reconverges after a successful PATCH (via the `refresh()` →
  // `meQuery` re-resolution path) or rolls back on failure.
  const [buffer, setBuffer] = useState<ProfileBuffer>(() =>
    bufferFromUser(user),
  );

  // Optimistic-concurrency snapshot — the server's `users.version` as of
  // the last successful GET/PATCH. Every PATCH includes this; a stale value
  // 409s. Updated on every successful PATCH from the server's RETURNING
  // and on every `meQuery.data` settle.
  const [serverVersion, setServerVersion] = useState<number>(
    () => user?.version ?? VERSION_DEFAULT,
  );

  const [fieldErrors, setFieldErrors] = useState<ProfileFieldErrors>({});

  // F-S1 fix: distinguish "never typed" from "deliberately cleared". The
  // sync effect only overwrites fields that the user has NOT touched since
  // the last successful PATCH. Cleared on a successful flushSave so a fresh
  // server-truth landing reconciles the buffer cleanly.
  const editedFieldsRef = useRef<Set<keyof ProfileBuffer>>(
    new Set<keyof ProfileBuffer>(),
  );

  // Track the last server-confirmed buffer in a ref so the sync effect can
  // compare without taking a dep on `serverProfile` (which would re-run
  // the effect after every successful PATCH and clobber the edit buffer
  // with the same data we just sent). Refs are the canonical escape for
  // "I need the current value but don't want to re-run on its change."
  const serverProfileRef = useRef<ProfileBuffer>(serverProfile);
  useEffect(() => {
    serverProfileRef.current = serverProfile;
  }, [serverProfile]);

  // Sync server state when /auth/me resolves with a real (non-mock) User.
  // The `isMock` gate keeps the corner badge and the server-truth state
  // in sync: treating a dev fixture as last-known-good would falsely
  // satisfy rollback comparisons after a real PATCH succeeds.
  useEffect(() => {
    if (meQuery.loading) return;
    if (meQuery.isMock) return;
    const fresh = meQuery.data as User | null;
    if (!fresh) return;
    const next = bufferFromUser(fresh);
    // Sync-to-external-system case — see useEndpointOrMock for the same
    // pattern. The effect is driven by the meQuery resolution, not by
    // our own state, so the rule's bad-loop heuristic doesn't apply.
    /* eslint-disable react-hooks/set-state-in-effect */
    setServerProfile(next);
    if (typeof fresh.version === 'number') {
      setServerVersion(fresh.version);
    }
    // F-S1 fix: only overwrite buffer fields the user has NOT edited.
    // Previously the predicate compared by value (`=== ''` or `===
    // prevServer`), which conflated "never typed" with "deliberately
    // cleared" — typing then deleting back to empty would silently revert
    // to the server value. Tracking explicit touches via a ref is the
    // robust signal.
    const edited = editedFieldsRef.current;
    setBuffer((prev) => ({
      display_name: edited.has('display_name') ? prev.display_name : next.display_name,
      email: edited.has('email') ? prev.email : next.email,
      phone: edited.has('phone') ? prev.phone : next.phone,
    }));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [meQuery.loading, meQuery.isMock, meQuery.data]);

  // Debounced auto-save. Tracks the latest pending timer + the latest
  // in-flight controller so unmount / next-keystroke cancels cleanly.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveCtrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      saveCtrlRef.current?.abort();
    };
  }, []);

  const flushSave = useCallback(
    async (
      next: ProfileBuffer,
      prevServer: ProfileBuffer,
      versionSnapshot: number,
    ): Promise<void> => {
      // Build the minimal diff. Empty strings → omit (server schema treats
      // missing as no-op; empty would 400 on Zod min(1)).
      const patch: PatchAuthMeBody = { expected_version: versionSnapshot };
      const changedFields: Array<keyof ProfileBuffer> = [];
      if (next.display_name !== prevServer.display_name) {
        if (next.display_name.trim() !== '') {
          patch.display_name = next.display_name.trim();
        }
        changedFields.push('display_name');
      }
      if (next.email !== prevServer.email) {
        if (next.email.trim() !== '') patch.email = next.email.trim();
        changedFields.push('email');
      }
      if (next.phone !== prevServer.phone) {
        if (next.phone.trim() !== '') patch.phone = next.phone.trim();
        changedFields.push('phone');
      }
      if (changedFields.length === 0) return;
      // If every changed field collapsed to empty (the diff carries only
      // `expected_version` and no actual profile fields) → nothing to send.
      const keysToSend = Object.keys(patch).filter(
        (k) => k !== 'expected_version',
      );
      if (keysToSend.length === 0) return;

      saveCtrlRef.current?.abort();
      const ctrl = new AbortController();
      saveCtrlRef.current = ctrl;

      try {
        const updated = await patchMe(patch, ctrl.signal);
        if (ctrl.signal.aborted) return;
        const updatedBuf = bufferFromUser(updated);
        setServerProfile(updatedBuf);
        if (typeof updated.version === 'number') {
          setServerVersion(updated.version);
        }
        setFieldErrors({});
        // Reset the touched-set: the user's intent has just been persisted,
        // so subsequent `meQuery` settles can safely sync these fields.
        editedFieldsRef.current = new Set<keyof ProfileBuffer>();
        // Pull the rest of the app's view of `user` forward.
        await refresh();
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const apiErr =
          err instanceof ApiError
            ? err
            : new ApiError('save failed', { status: 0, code: 'unknown' });
        // Roll back the edited fields to the last-known-server values,
        // surface a per-field error. Untouched fields stay as-is.
        setBuffer((prev) => {
          const rolled: ProfileBuffer = { ...prev };
          for (const f of changedFields) rolled[f] = prevServer[f];
          return rolled;
        });
        // Drop those fields from the touched-set so the next server settle
        // can re-sync them cleanly.
        for (const f of changedFields) editedFieldsRef.current.delete(f);
        setFieldErrors((prev) => {
          const nextErrs: ProfileFieldErrors = { ...prev };
          for (const f of changedFields) nextErrs[f] = messageFor(apiErr, f);
          return nextErrs;
        });
        // On 409 (stale version), the canonical retry path is: refetch
        // /auth/me to rebase the version snapshot, then let the user redo
        // the save. We trigger the refresh here; the buffer is already
        // rolled back so the next sync effect will pick up the fresh
        // server state.
        if (apiErr.status === 409) {
          await refresh();
        }
      }
    },
    [refresh],
  );

  const scheduleSave = useCallback(
    (next: ProfileBuffer): void => {
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      const snapshot = serverProfile;
      const versionSnapshot = serverVersion;
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        void flushSave(next, snapshot, versionSnapshot);
      }, DEBOUNCE_MS);
    },
    [flushSave, serverProfile, serverVersion],
  );

  /** Drop a single field's error from the map without mutating in place. */
  const clearFieldError = useCallback(
    (field: keyof ProfileBuffer): void => {
      setFieldErrors((prev) => {
        if (!prev[field]) return prev;
        const rest: ProfileFieldErrors = { ...prev };
        delete rest[field];
        return rest;
      });
    },
    [],
  );

  // Per-field edit handlers. Each clears the field's prior error (the user
  // is actively addressing it) and schedules a debounced save against the
  // freshly-computed buffer. State updates use the imperative reads of
  // `buffer` rather than the functional form so we can pass the same
  // `next` value to `scheduleSave` without running side effects inside a
  // React state updater (which Strict Mode would otherwise double-invoke).
  const onNameChange = useCallback(
    (value: string): void => {
      const next: ProfileBuffer = { ...buffer, display_name: value };
      editedFieldsRef.current.add('display_name');
      setBuffer(next);
      scheduleSave(next);
      clearFieldError('display_name');
    },
    [buffer, scheduleSave, clearFieldError],
  );

  const onEmailChange = useCallback(
    (value: string): void => {
      const next: ProfileBuffer = { ...buffer, email: value };
      editedFieldsRef.current.add('email');
      setBuffer(next);
      scheduleSave(next);
      clearFieldError('email');
      // One-way coupling — clearing the profile email also clears the
      // local notif.channel.email. Same as Pass 2.
      if (value.trim() === '' && settings.notif.channel.email) {
        updateSettings((prev) => ({
          ...prev,
          notif: {
            ...prev.notif,
            channel: { ...prev.notif.channel, email: false },
          },
        }));
      }
    },
    [
      buffer,
      scheduleSave,
      clearFieldError,
      settings.notif.channel.email,
      updateSettings,
    ],
  );

  const onPhoneChange = useCallback(
    (value: string): void => {
      const next: ProfileBuffer = { ...buffer, phone: value };
      editedFieldsRef.current.add('phone');
      setBuffer(next);
      scheduleSave(next);
      clearFieldError('phone');
      if (value.trim() === '' && settings.notif.channel.sms) {
        updateSettings((prev) => ({
          ...prev,
          notif: {
            ...prev.notif,
            channel: { ...prev.notif.channel, sms: false },
          },
        }));
      }
    },
    [
      buffer,
      scheduleSave,
      clearFieldError,
      settings.notif.channel.sms,
      updateSettings,
    ],
  );

  return (
    <section
      className="screen km-settings"
      style={{ position: 'relative' }}
      aria-labelledby="km-settings-title"
    >
      {meQuery.isMock ? <MockBadge /> : null}
      <Topbar
        krTitle={
          <>
            설정 <span className="km-topbar__title-en">· Settings</span>
          </>
        }
        eyebrow="Profile · notifications · appearance"
      />

      {/* ───── Profile (server-backed) ───── */}
      <SettingsGroup icon="user" eyebrow="프로필" title="Profile">
        <SettingsRow
          label="Name"
          hint="Used when the tutor addresses you in chat."
          inputId="km-settings-name"
        >
          <input
            id="km-settings-name"
            type="text"
            value={buffer.display_name}
            onChange={(e) => {
              onNameChange(e.target.value);
            }}
            placeholder="Your name"
            className="kr focusring km-settings__input"
            autoComplete="name"
            aria-invalid={fieldErrors.display_name ? true : undefined}
          />
        </SettingsRow>
        {fieldErrors.display_name ? (
          <ErrorCard message={fieldErrors.display_name} />
        ) : null}
        <SettingsRow
          label="Email"
          hint="Sign-in identifier + digest target."
          inputId="km-settings-email"
        >
          <input
            id="km-settings-email"
            type="email"
            value={buffer.email}
            onChange={(e) => {
              onEmailChange(e.target.value);
            }}
            placeholder="you@example.com"
            className="focusring km-settings__input"
            autoComplete="email"
            aria-invalid={fieldErrors.email ? true : undefined}
          />
        </SettingsRow>
        {fieldErrors.email ? <ErrorCard message={fieldErrors.email} /> : null}
        <SettingsRow
          label="Phone"
          hint="For SMS reminders."
          inputId="km-settings-phone"
        >
          <input
            id="km-settings-phone"
            type="tel"
            value={buffer.phone}
            onChange={(e) => {
              onPhoneChange(e.target.value);
            }}
            placeholder="+1 555 0100"
            className="focusring km-settings__input"
            autoComplete="tel"
            aria-invalid={fieldErrors.phone ? true : undefined}
          />
        </SettingsRow>
        {fieldErrors.phone ? <ErrorCard message={fieldErrors.phone} /> : null}
      </SettingsGroup>

      {/* ───── Notifications (localStorage) ───── */}
      <SettingsGroup icon="bell" eyebrow="알림" title="Notifications">
        <Eyebrow className="km-settings__group-eyebrow">Channels</Eyebrow>
        <div className="km-settings__channels">
          <ChannelChip
            label="Email"
            icon="info"
            active={settings.notif.channel.email}
            disabled={!buffer.email}
            onToggle={() => {
              updateSettings({
                notif: {
                  ...settings.notif,
                  channel: {
                    ...settings.notif.channel,
                    email: !settings.notif.channel.email,
                  },
                },
              });
            }}
          />
          <ChannelChip
            label="SMS"
            icon="bell"
            active={settings.notif.channel.sms}
            disabled={!buffer.phone}
            onToggle={() => {
              updateSettings({
                notif: {
                  ...settings.notif,
                  channel: {
                    ...settings.notif.channel,
                    sms: !settings.notif.channel.sms,
                  },
                },
              });
            }}
          />
        </div>

        <Eyebrow className="km-settings__group-eyebrow">Send me</Eyebrow>
        <ToggleRow
          label="Reviews due"
          hint="When 10+ cards are ready."
          checked={settings.notif.reviewsDue}
          onChange={(next) => {
            updateSettings({
              notif: { ...settings.notif, reviewsDue: next },
            });
          }}
        />
        <ToggleRow
          label="Daily reminder"
          hint="A nudge at 8:00 KST."
          checked={settings.notif.daily}
          onChange={(next) => {
            updateSettings({
              notif: { ...settings.notif, daily: next },
            });
          }}
        />
        <ToggleRow
          label="Weekly report"
          hint="Sundays. Skills snapshot + counts."
          checked={settings.notif.weekly}
          last
          onChange={(next) => {
            updateSettings({
              notif: { ...settings.notif, weekly: next },
            });
          }}
        />
      </SettingsGroup>

      {/* ───── Appearance (localStorage) ───── */}
      <SettingsGroup icon="palette" eyebrow="외관" title="Appearance">
        <SwatchPicker
          label="Paper"
          hint="Background."
          presets={PAPER_PRESETS}
          selectedId={settings.palette.paper}
          onSelect={(id) => {
            updateSettings({
              palette: { ...settings.palette, paper: id },
            });
          }}
        />
        <SwatchPicker
          label="Highlight"
          hint="Accents, links, active states."
          presets={ACCENT_PRESETS}
          selectedId={settings.palette.accent}
          onSelect={(id) => {
            updateSettings({
              palette: { ...settings.palette, accent: id },
            });
          }}
        />
        <SwatchPicker
          label="Correct"
          hint="Success — answered right."
          presets={CORRECT_PRESETS}
          selectedId={settings.palette.correct}
          onSelect={(id) => {
            updateSettings({
              palette: { ...settings.palette, correct: id },
            });
          }}
        />
        <SwatchPicker
          label="Incorrect"
          hint="Wrong answers + warnings."
          presets={WRONG_PRESETS}
          selectedId={settings.palette.wrong}
          last
          onSelect={(id) => {
            updateSettings({
              palette: { ...settings.palette, wrong: id },
            });
          }}
        />

        <button
          type="button"
          onClick={resetSettings}
          className="km-btn km-btn--ghost km-btn--sm focusring km-settings__reset"
        >
          Reset to Hanji
        </button>
      </SettingsGroup>

      <p className="km-settings__about">한국어 마스터 · v0.2</p>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Pieces
// ─────────────────────────────────────────────────────────────

function SettingsGroup({
  icon,
  eyebrow,
  title,
  children,
}: {
  icon: IconName;
  eyebrow: string;
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <Card className="km-settings__group">
      <header className="km-settings__group-head">
        <span className="km-settings__group-icon" aria-hidden="true">
          <Icon name={icon} size={14} />
        </span>
        <div>
          <Eyebrow>{eyebrow}</Eyebrow>
          <div className="km-settings__group-title">{title}</div>
        </div>
      </header>
      {children}
    </Card>
  );
}

function SettingsRow({
  label,
  hint,
  inputId,
  children,
}: {
  label: string;
  hint?: string;
  inputId: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="km-settings__row">
      <div className="km-settings__row-head">
        <label htmlFor={inputId} className="km-settings__row-label">
          {label}
        </label>
        {hint ? <span className="km-settings__row-hint">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function ChannelChip({
  label,
  icon,
  active,
  disabled,
  onToggle,
}: {
  label: string;
  icon: IconName;
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={active}
      className={
        'km-settings__chanchip focusring' +
        (active ? ' km-settings__chanchip--active' : '') +
        (disabled ? ' km-settings__chanchip--disabled' : '')
      }
    >
      <Icon name={icon} size={13} />
      <span>{label}</span>
    </button>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  last = false,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  last?: boolean;
}): JSX.Element {
  return (
    <div
      className={
        'km-settings__toggle-row' +
        (last ? ' km-settings__toggle-row--last' : '')
      }
    >
      <div className="km-settings__toggle-meta">
        <div className="km-settings__toggle-label">{label}</div>
        {hint ? (
          <div className="km-settings__toggle-hint">{hint}</div>
        ) : null}
      </div>
      <Toggle checked={checked} onChange={onChange} ariaLabel={label} />
    </div>
  );
}
