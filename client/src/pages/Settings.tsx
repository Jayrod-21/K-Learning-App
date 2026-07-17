/**
 * Settings screen — profile (server) · notification schedules (server) ·
 * appearance (localStorage cache + server sync).
 *
 * Phase 3a layout (F-038): every group renders inside a `CollapsibleTile`
 * that STARTS COLLAPSED — the page is a stack of four folded tiles
 * (Profile / 2FA / Notifications / Appearance) the user opens on demand.
 *
 * Device-adaptive epic, Phase D2 (fix-pass revision): at desktop (≥1024px)
 * the group stack becomes a TWO-COLUMN grid driven entirely by CSS. The
 * five groups render inside ONE always-mounted `.km-settings__grid`
 * wrapper at every width; Settings.css turns that wrapper into a row-major
 * two-column grid at ≥1024px and leaves it styleless below. There is no
 * device-class render branch, so a live resize across the breakpoint (iPad
 * rotation) can never unmount a group — the first D2 cut's branch swap
 * destroyed TwoFactorSection's shown-once recovery codes mid-setup. See
 * the layout comment in the component body for the full rationale and
 * Settings.css for the width arithmetic.
 *
 * Split substrate:
 *   - **Profile (name / email / phone)** persists to the server via
 *     `PATCH /auth/me`. Hydrates from `GET /auth/me` on mount through
 *     `useEndpointOrMock('settings:me', loadSettingsMock, { realFn: fetchMe })`.
 *     `useAuth().user` is the seeded initial value so the form never
 *     paints empty during the first network round-trip.
 *   - **Notifications (F-040)** persist to `/notifications/schedules` —
 *     per-kind timing rows (time-of-day + weekday for the weekly report),
 *     NOT the old timing-less intent booleans. The `notif` slice of
 *     `/settings/prefs` is wire-echo-only now (like the legacy palette
 *     fields): no UI reads or writes it, and (F-093) the outgoing PUT
 *     always echoes the LAST value the SERVER reported
 *     (`lastSyncedPrefsRef.current.notif`), never `settings.notif` (the
 *     localStorage-cached copy that "Reset to defaults" can independently
 *     revert) — so this screen can no longer originate a diverging write
 *     into the 018 blob's notif keys. The server's F-093 CONTRACT step has
 *     since landed: `/settings/prefs` now DERIVES `notif` from
 *     `notification_schedules` (052) on both GET and PUT responses and
 *     ignores (never persists) whatever `notif` this client sends — so the
 *     echoed slice we keep in `lastSyncedPrefsRef` is always the canonical
 *     schedule-derived view. Dropping `notif` from the outgoing PUT payload
 *     entirely is the remaining (client-side) contract step.
 *   - **Appearance** persists to `localStorage` via `useSettings()` /
 *     the theme+accent+text-size providers, with a debounced
 *     `/settings/prefs` PUT for cross-device sync.
 *   - **Uploads (F-039)**: REMOVED from Settings — the section migrates to
 *     Review→Uploads (F-057–F-059, a later group). Until that lands the
 *     upload flow is only reachable via the /uploads route directly.
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
 * Coupling note: the old Pass-2 one-way coupling (clearing profile Email/
 * Phone force-cleared `notif.channel.*`) was RETIRED with F-040 — those
 * intent booleans no longer drive anything, so mutating them on profile
 * edits would be writing to a dead store.
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
 *
 * F-128 "Seoul Day & Night" reskin: the header adopts the shared
 * `PageHubHeader` (devices #4/#2) instead of a bare `Topbar`, and every
 * group's `CollapsibleTile` now rides `surface="city"` (device #1 — Night
 * neon-signboard glow / Day hanji-paper) with a per-group `DancheongRail`
 * tone (device #2) instead of the plain `Card` shell, via `SettingsGroup`'s
 * new `tone` prop. `.km-rain-sheen` (device #8) ambient-textures the page
 * root; it's a Night-only no-op by its own CSS gate. Purely visual — this IS
 * the page that owns the theme/accent/text-size CONTROLS themselves, so
 * none of that wiring (ThemeProvider/AccentProvider/TextSizeProvider, the
 * profile PATCH, the notification-schedule PUT, or the MFA flows above)
 * changes here; only the JSX shell and co-located CSS do.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { CollapsibleTile } from '../components/CollapsibleTile';
import type { DancheongRailTone } from '../components/DancheongRail';
import { ErrorCard } from '../components/ErrorCard';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { PageHubHeader } from '../components/PageHubHeader';
import { RecoveryCodesPanel } from '../components/RecoveryCodesPanel';
import { SwatchPicker } from '../components/SwatchPicker';
import { Toggle } from '../components/Toggle';
import { useToast } from '../components/useToast';
import { useAuth } from '../hooks/useAuth';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { useSettings } from '../hooks/useSettings';
import { useTheme } from '../hooks/useTheme';
import type { ThemeMode } from '../hooks/useTheme';
import { useAccent } from '../hooks/useAccent';
import { isAccent } from '../hooks/accent-context';
import { useTextSize } from '../hooks/useTextSize';
import { isTextSize, DEFAULT_TEXT_SIZE, type TextSize } from '../hooks/text-size-context';
import { loadSeenTours } from '../hooks/tour-context';
import { useTourOptional } from '../hooks/useTour';
import { FIRST_RUN_TOUR_ID, TOURS, TOUR_IDS, isTourId } from '../lib/tours';
import {
  fetchMe,
  fetchMfaStatus,
  mfaConfirm,
  mfaEnroll,
  patchMe,
  regenerateRecoveryCodes,
} from '../services/auth';
import { navItem } from '../lib/nav';
import { otpauthUriToDataUrl } from '../lib/qr';
import {
  fetchPrefs,
  putPrefs,
  LEGACY_PALETTE_DEFAULT,
  type Prefs,
} from '../services/settings';
import {
  fetchSchedules,
  putSchedules,
  isNotificationKind,
  type NotificationKind,
  type NotificationScheduleInput,
  type NotificationSchedulesResponse,
} from '../services/notifications';
import type { User } from '../hooks/auth-context';
import type { MfaStatus, NotifPrefs } from '../types/domain';
import './Settings.css';

/**
 * Mock fallback for the `/auth/me` query — returns a user-shaped fixture so
 * the screen still renders during dev when the server route is down. The
 * Pass 2 `loadSettingsMock` returns a `Settings` shape and is unrelated to
 * the server user; we keep this Mock local to Settings.tsx because no other
 * screen needs it.
 */
/** Page eyebrow source — nav.ts owns the en/kr pair (P3b Batch A). */
const SETTINGS_NAV = navItem('settings');

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
import { ACCENT_OPTIONS } from '../lib/accent-presets';
import { TEXT_SIZE_OPTIONS } from '../lib/text-size-presets';
import {
  clampSubScale,
  DEFAULT_SETTINGS,
  LANG_SUB_SCALE_MAX,
  LANG_SUB_SCALE_MIN,
  loadSettings,
} from '../lib/settings';
import { Bilingual } from '../components/Bilingual';
import type { IconName } from '../components/Icon';
import type {
  BilingualLanguage,
  LanguageDisplayMode,
  LanguageDisplayPrefs,
  PatchAuthMeBody,
} from '../types/domain';

/**
 * Mock fallback for the `/settings/prefs` query. Returns the user's CURRENT
 * localStorage prefs after a small delay so a server-down dev session still
 * hydrates the screen with the real local choice rather than a synthetic
 * default — and the 🅂 badge then signals the fall-back honestly.
 *
 * `palette` is wire-only since the v2 flatten (no local copy exists); the
 * mock carries the wire default the way the pre-hydration PUT baseline does.
 */
async function loadPrefsMock(): Promise<Prefs> {
  await new Promise((resolve) => setTimeout(resolve, 80));
  const local = loadSettings();
  return {
    notif: local.notif,
    palette: LEGACY_PALETTE_DEFAULT,
    languageDisplay: local.languageDisplay,
    // Like the wire palette: the mock is never adopted (isMock guard), so the
    // default id is an honest stand-in for the provider-owned local value.
    textSize: DEFAULT_TEXT_SIZE,
    // Tours: the localStorage cache is the honest local value (TourProvider
    // owns it), same posture as `local.languageDisplay` above.
    toursSeen: [...loadSeenTours()].sort(),
  };
}

/** Local edit buffer for the three server-backed profile fields. */
interface ProfileBuffer {
  display_name: string;
  email: string;
  phone: string;
}

/** Per-field error map — distinct so a phone failure doesn't shadow email. */
type ProfileFieldErrors = Partial<Record<keyof ProfileBuffer, string>>;

const DEBOUNCE_MS = 600;

/**
 * Debounce for the prefs PUT. Shorter than the profile's 600ms — palette /
 * notif edits are coarse taps (no keystroke stream to coalesce), so ~400ms is
 * enough to batch a flurry of swatch clicks without feeling laggy.
 */
const PREFS_DEBOUNCE_MS = 400;

/** Fallback version when the server hasn't reported one yet. Real callers
 *  read `useAuth().user.version`; this only paints during the first
 *  paint-before-fetch window. */
const VERSION_DEFAULT = 1;

// ─────────────────────────────────────────────────────────────
// Notification schedules (F-040) — module-scope shapes
// ─────────────────────────────────────────────────────────────

/** Editable slice of one schedule row. `weekday` is carried for every kind
 *  (so a kind switch never loses the pick) but only SENT for weekly_report —
 *  the server's `.strict()` schema forbids it elsewhere. */
interface ScheduleDraft {
  /** Zero-padded 24h 'HH:MM'. */
  timeOfDay: string;
  /** 0=Sunday .. 6=Saturday. */
  weekday: number;
  enabled: boolean;
}

type ScheduleDrafts = Record<NotificationKind, ScheduleDraft>;

/**
 * Suggested defaults painted before the user has ever stored a schedule.
 * The server holds NOTHING until the first PUT (nothing is implicitly on),
 * so these are client-side suggestions, not adopted state. Times match the
 * pre-F-040 copy (daily nudge at 08:00, weekly report on Sunday).
 */
const SCHEDULE_DEFAULTS: Readonly<Record<NotificationKind, ScheduleDraft>> = {
  daily_reminder: { timeOfDay: '08:00', weekday: 0, enabled: false },
  reviews_due: { timeOfDay: '18:00', weekday: 0, enabled: false },
  weekly_report: { timeOfDay: '09:00', weekday: 0, enabled: false },
};

/** Row order + user-facing copy for the three schedule kinds. */
const SCHEDULE_KIND_META: ReadonlyArray<{
  kind: NotificationKind;
  label: string;
  hint: string;
}> = [
  {
    kind: 'daily_reminder',
    label: 'Daily reminder',
    hint: 'A daily nudge to study.',
  },
  {
    kind: 'reviews_due',
    label: 'Reviews due',
    hint: 'When 10+ cards are ready.',
  },
  {
    kind: 'weekly_report',
    label: 'Weekly report',
    hint: 'Skills snapshot + counts.',
  },
];

/** Index = the server's weekday encoding (0=Sunday, JS `Date.getDay()`). */
const WEEKDAY_LABELS: ReadonlyArray<string> = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** Same coarse-tap debounce rationale as the prefs PUT. */
const SCHEDULES_DEBOUNCE_MS = 400;

/**
 * The device's IANA zone — the wall-clock a schedule anchors to. Resolved
 * once per session; the server re-validates against its own zone database.
 * The catch arm covers pathological embedders whose Intl lacks a zone; the
 * app's own domain makes KST the honest fallback.
 */
const DEVICE_TZ: string = (() => {
  try {
    const tz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz !== '' ? tz : 'Asia/Seoul';
  } catch {
    return 'Asia/Seoul';
  }
})();

/** Draft → wire row. Omits `weekday` (never sends `undefined`) for kinds
 *  where the server's `.strict()` schema forbids it. Always the EMAIL
 *  channel — sms is a disabled placeholder and push has no sender yet. */
function toScheduleInput(
  kind: NotificationKind,
  draft: ScheduleDraft,
): NotificationScheduleInput {
  const base = {
    kind,
    channel: 'email' as const,
    timeOfDay: draft.timeOfDay,
    tz: DEVICE_TZ,
    enabled: draft.enabled,
  };
  return kind === 'weekly_report' ? { ...base, weekday: draft.weekday } : base;
}

/** Mock fallback for the schedules query — a fresh user's honest shape
 *  (empty: nothing is implicitly on). Rows stay disabled on a mock settle,
 *  so a dev session can't fabricate edits that will never persist. */
async function loadSchedulesMock(): Promise<NotificationSchedulesResponse> {
  await new Promise((resolve) => setTimeout(resolve, 80));
  return { schedules: [] };
}

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

/**
 * Field-by-field equality for the synced prefs slices (notif +
 * languageDisplay — the wire `palette` is a passthrough echo since the v2
 * flatten and never diffs). Compared by value (not by JSON, which would be
 * sensitive to key order between a server response and a literal-built
 * object) so the change-detector never reports a spurious diff that would
 * loop a redundant PUT.
 */
function notifEqual(a: NotifPrefs, b: NotifPrefs): boolean {
  return (
    a.channel.email === b.channel.email &&
    a.channel.sms === b.channel.sms &&
    a.reviewsDue === b.reviewsDue &&
    a.daily === b.daily &&
    a.weekly === b.weekly
  );
}

function languageDisplayEqual(
  a: LanguageDisplayPrefs,
  b: LanguageDisplayPrefs,
): boolean {
  return (
    a.mode === b.mode && a.primary === b.primary && a.subScale === b.subScale
  );
}

export default function Settings(): JSX.Element {
  const navigate = useNavigate();
  const { user, refresh, logout } = useAuth();
  const { settings, updateSettings, resetSettings } = useSettings();
  const { mode: themeMode, setMode: setThemeMode } = useTheme();
  const { accent, setAccent } = useAccent();
  const { textSize, setTextSize } = useTextSize();
  const { toast } = useToast();

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
  }, [meQuery.loading, meQuery.isMock, meQuery.data]);

  // Stable handle on the /auth/me query's refetch, so `flushSave` can rebase
  // the version snapshot after a 409 (see the catch below) without taking a
  // dep on the whole `meQuery` result object (whose identity changes every
  // settle and would churn the callback chain).
  const refetchMe = meQuery.refetch;

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
        // the save. `refresh()` alone is NOT enough — it only re-probes the
        // AuthProvider's context `user`, while this screen's `serverVersion`
        // syncs exclusively from `meQuery.data` (see the sync effect above).
        // Without `refetchMe()` the stale snapshot would 409 every
        // subsequent save until the user left and re-entered Settings.
        // The buffer is already rolled back, so the next sync effect picks
        // up the fresh server state (profile + version) cleanly.
        if (apiErr.status === 409) {
          refetchMe();
          await refresh();
        }
      }
    },
    [refresh, refetchMe],
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
    },
    [buffer, scheduleSave, clearFieldError],
  );

  const onPhoneChange = useCallback(
    (value: string): void => {
      const next: ProfileBuffer = { ...buffer, phone: value };
      editedFieldsRef.current.add('phone');
      setBuffer(next);
      scheduleSave(next);
      clearFieldError('phone');
    },
    [buffer, scheduleSave, clearFieldError],
  );

  // ───── Preferences (notif + languageDisplay + accent) server-sync ─────
  //
  // The providers stay pure (localStorage cache + instant apply); the server
  // round-trip is owned HERE, at the screen, alongside the 🅂 badge.
  //
  //   - On mount: hydrate `/settings/prefs`. On a real (non-mock) settle that
  //     differs from the current local prefs, write it into the providers —
  //     server wins on load (last-writer-wins). This includes the ACCENT
  //     (cross-device sync): the localStorage fast-path + index.html no-flash
  //     bootstrap paint instantly, then the server's accent is adopted here if
  //     it differs (a change made on another device propagates in).
  //   - On every notif/languageDisplay/accent change: debounce a full
  //     `putPrefs`. Failure is non-fatal: localStorage already holds the
  //     change, so a failed PUT only surfaces a non-blocking toast; the screen
  //     never breaks.
  //   - Never PUT before the hydration GET settles (see the guard on the
  //     change effect) — a pre-hydration PUT would clobber the stored blob
  //     with client defaults.
  const prefsQuery = useEndpointOrMock<Prefs>('settings:prefs', loadPrefsMock, {
    realFn: fetchPrefs,
  });

  // The prefs we last reconciled with the server (hydrated value, or the body
  // of the last successful/attempted PUT). The change-driven effect compares
  // against this so a server-hydration write does NOT echo straight back as a
  // PUT, and an unchanged render never fires a redundant round-trip. Seeded to
  // the current local prefs so the first paint is a no-op. The palette's
  // `paper`/`correct`/`wrong` are wire-only (v2 flatten): they seed to the
  // server default, are overwritten by whatever the server reports on
  // hydration, then echoed verbatim on every PUT so a stored legacy palette is
  // never clobbered. `accent` is LIVE (cross-device sync): it seeds to the
  // AccentProvider's current value (localStorage fast-path) and is owned by
  // the accent picker from then on.
  // `textSize` mirrors `accent` exactly (F-025): seeded from the provider's
  // localStorage fast-path, owned by the Text size control from then on.
  // `toursSeen` is sourced LIVE from `loadSeenTours()` (the localStorage
  // store TourProvider writes synchronously) here and on every PUT below —
  // never from a hydration baseline — so a Settings-driven PUT can never
  // carry a stale tour list and wipe a tour finished after this screen
  // mounted. TourProvider is the only writer that initiates PUTs FOR the
  // field (read-merge-write), so it is deliberately absent from the
  // change-diff below.
  const lastSyncedPrefsRef = useRef<Prefs>({
    notif: settings.notif,
    palette: { ...LEGACY_PALETTE_DEFAULT, accent },
    languageDisplay: settings.languageDisplay,
    textSize,
    toursSeen: [...loadSeenTours()].sort(),
  });

  const prefsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefsCtrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (prefsTimerRef.current !== null) clearTimeout(prefsTimerRef.current);
      prefsCtrlRef.current?.abort();
    };
  }, []);

  const flushPrefs = useCallback(
    async (next: Prefs): Promise<void> => {
      prefsCtrlRef.current?.abort();
      const ctrl = new AbortController();
      prefsCtrlRef.current = ctrl;
      try {
        const stored = await putPrefs(next, ctrl.signal);
        if (ctrl.signal.aborted) return;
        // Server echoes the stored object — adopt it as the baseline so a later
        // hydration / re-render reconciles against exactly what's persisted.
        lastSyncedPrefsRef.current = stored;
      } catch (err) {
        if (ctrl.signal.aborted) return;
        // A canceled PUT (unmount / superseded keystroke) is not a real failure.
        if (err instanceof ApiError && err.code === 'canceled') return;
        // ErrorCard-vs-Toast split (PF-A A3): a prefs-sync failure is
        // transient/background — the change is ALREADY durable in localStorage
        // (the provider wrote it), so blanking part of the screen with an
        // inline ErrorCard overstates the problem. A non-blocking toast with a
        // Retry action is the right affordance: it informs without interrupting
        // and lets the user re-attempt the cross-device sync immediately.
        // Blocking full-screen LOAD failures still use ErrorCard. The message
        // is author-controlled — never an echo of the server string.
        toast({
          message:
            'Saved on this device, but syncing to your account failed. ' +
            'It will retry automatically.',
          tone: 'info',
          action: {
            label: 'Retry',
            onClick: () => {
              void flushPrefs(next);
            },
          },
        });
      }
    },
    [toast],
  );

  // Hydrate from the server. Only a real (non-mock) settle is authoritative —
  // treating the mock fall-back as server truth would clobber the user's local
  // prefs with a synthetic default the moment the server is unreachable.
  //
  // Hydration runs EXACTLY ONCE per real settle (the `hydratedRef` latch). It
  // must NOT re-fire on subsequent local edits — otherwise a stale server value
  // would clobber the user's just-made change. The current local prefs are read
  // from a ref so they don't enter the dep array and re-trigger the effect.
  const prefsHydratedRef = useRef<boolean>(false);
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  // Current accent via a ref so the hydration effect can read it without
  // re-running on every accent change (the hydrated latch would make a re-run
  // harmless, but keeping the dep list settle-driven is the cleaner contract).
  const accentRef = useRef(accent);
  useEffect(() => {
    accentRef.current = accent;
  }, [accent]);
  // Same ref discipline for the text size (F-025) — the hydration effect
  // reads the current value without re-running on every size change.
  const textSizeRef = useRef(textSize);
  useEffect(() => {
    textSizeRef.current = textSize;
  }, [textSize]);

  useEffect(() => {
    if (prefsHydratedRef.current) return;
    if (prefsQuery.loading) return;
    if (prefsQuery.isMock) return;
    const fresh = prefsQuery.data;
    if (!fresh) return;
    prefsHydratedRef.current = true;
    // P3a: `languageDisplay` is guaranteed by a P3a+ server (its schema
    // defaults the field), but guard anyway so a client deployed ahead of the
    // server during a rolling deploy hydrates the default instead of writing
    // `undefined` into the provider.
    const freshLanguageDisplay =
      fresh.languageDisplay ?? DEFAULT_SETTINGS.languageDisplay;
    // Accent cross-device sync — the server's accent is authoritative on load
    // (same server-wins-on-load posture as notif). A current server only ever
    // reports `coral|blue|mint` (its schema coerces legacy ids), but an OLD
    // server mid-rolling-deploy may still echo a legacy id — not adoptable, so
    // keep the local accent and record IT as the baseline instead.
    const localAccent = accentRef.current;
    const freshAccent = isAccent(fresh.palette.accent)
      ? fresh.palette.accent
      : localAccent;
    // Text-size cross-device sync (F-025) — same server-wins-on-load posture
    // as the accent. A pre-F-025 server omits the field entirely on GET
    // (rolling deploy), which is not adoptable: keep the local size and
    // record IT as the baseline instead.
    const localTextSize = textSizeRef.current;
    const freshTextSize = isTextSize(fresh.textSize)
      ? fresh.textSize
      : localTextSize;
    // Record what the server holds BEFORE writing it into the provider, so the
    // change-driven effect below sees no diff and skips the echo PUT. This is
    // also where the wire-only paper/correct/wrong echo values are adopted
    // (v2 flatten) and the accent baseline is pinned — the setAccent below can
    // therefore never loop a PUT.
    lastSyncedPrefsRef.current = {
      ...fresh,
      palette: { ...fresh.palette, accent: freshAccent },
      languageDisplay: freshLanguageDisplay,
      textSize: freshTextSize,
    };
    if (freshTextSize !== localTextSize) {
      // Adopt = a plain provider update (stamps `data-text-size` on <html> +
      // persists localStorage["km.textSize"]), NOT a user-initiated change:
      // the baseline above already carries the server's size, so the change
      // effect diffs to nothing — no echo PUT, no flash loop.
      setTextSize(freshTextSize);
    }
    if (freshAccent !== localAccent) {
      // Adopt = a plain provider update (stamps `data-accent` on <html> +
      // persists localStorage["km.accent"]), NOT a user-initiated change: the
      // baseline above already carries the server's accent, so the change
      // effect diffs to nothing — no echo PUT, no flash loop. The accent stays
      // an attribute; no CSS vars are projected here.
      setAccent(freshAccent);
    }
    const local = settingsRef.current;
    const samePrefs =
      notifEqual(fresh.notif, local.notif) &&
      languageDisplayEqual(freshLanguageDisplay, local.languageDisplay);
    if (samePrefs) return;
    // Sync-to-external-system case — driven by the query resolution, not by our
    // own state, so the rule's bad-loop heuristic doesn't apply. `updateSettings`
    // is the provider's setter, not a local setState, so the rule stays quiet.
    updateSettings({
      notif: fresh.notif,
      languageDisplay: freshLanguageDisplay,
    });
  }, [
    prefsQuery.loading,
    prefsQuery.isMock,
    prefsQuery.data,
    updateSettings,
    setAccent,
    setTextSize,
  ]);

  // Debounced PUT on any notif/languageDisplay/accent change. Compares against
  // the last server-reconciled snapshot so server-hydration writes and
  // unchanged renders are no-ops. The provider's localStorage write already
  // happened — this is best-effort durability on top of it. The wire palette's
  // paper/correct/wrong are echoed from the last server-reported value (v2
  // flatten: the server schema still requires them; the client never edits
  // them); `accent` carries the AccentProvider's current choice so it syncs
  // across devices.
  useEffect(() => {
    // PRE-HYDRATION PUT GUARD: never PUT before the initial GET has settled.
    // A PUT fired here would carry the seeded baselines (LEGACY_PALETTE_DEFAULT
    // + local defaults) and overwrite the server-stored blob — the known
    // palette/accent clobber. Suppress instead: the change is already durable
    // in localStorage, hydration then lands server-wins (the locked load
    // semantic), and every post-hydration change syncs normally. A mock settle
    // (server unreachable) keeps the guard closed too — a PUT could not
    // succeed anyway, and localStorage preserves the choice for the next
    // reachable session.
    if (!prefsHydratedRef.current) return;
    const last = lastSyncedPrefsRef.current;
    // F-093: `notif` is echoed from `last.notif` (the last value the SERVER
    // reported), NEVER from `settings.notif` (the client's own
    // localStorage-cached copy — "Reset to defaults" can revert it
    // independently of anything server-side). This is a transparent
    // pass-through: the client can no longer originate a value for this
    // slice, only relay what the server already said, which closes the one
    // drift vector this screen could otherwise introduce into the 018 blob.
    const current: Prefs = {
      notif: last.notif,
      palette: { ...last.palette, accent },
      languageDisplay: settings.languageDisplay,
      textSize,
      // Live localStorage read (see lastSyncedPrefsRef's comment) — always
      // the freshest set, and NOT part of the diff below: this screen only
      // ever relays the value alongside its own changes.
      toursSeen: [...loadSeenTours()].sort(),
    };
    if (
      current.palette.accent === last.palette.accent &&
      languageDisplayEqual(current.languageDisplay, last.languageDisplay) &&
      current.textSize === last.textSize
    ) {
      return;
    }
    // Mark synced eagerly: the body we're about to PUT becomes the new
    // reconciliation baseline so a failed PUT doesn't loop-retry every render.
    // localStorage still holds the change, so durability isn't lost on failure.
    lastSyncedPrefsRef.current = current;
    if (prefsTimerRef.current !== null) clearTimeout(prefsTimerRef.current);
    prefsTimerRef.current = setTimeout(() => {
      prefsTimerRef.current = null;
      void flushPrefs(current);
    }, PREFS_DEBOUNCE_MS);
    // `flushPrefs` is stable (no deps); the effect keys on the synced slices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.languageDisplay, accent, textSize]);

  // ───── Notification schedules (F-040) server-sync ─────
  //
  // Two-way sync with `/notifications/schedules`:
  //   - On mount: GET, adopt the stored EMAIL-channel rows into the drafts
  //     (exactly once, on the first REAL settle — a mock settle is never
  //     adopted). Kinds the server has never stored keep the client-side
  //     suggested defaults.
  //   - On change: debounce a PARTIAL PUT of only the dirty kinds (the route
  //     upserts per (kind, channel) row).
  //   - PUT-before-hydrate is structurally impossible: the rows render
  //     DISABLED until `schedulesHydrated` flips — unlike prefs there is no
  //     localStorage durability behind these controls, so letting the user
  //     edit un-persistable state would silently lose the choice.
  //   - No rollback dance on failure: the dirty set survives a failed PUT, so
  //     the error toast's Retry re-sends the freshest drafts.
  const schedulesQuery = useEndpointOrMock<NotificationSchedulesResponse>(
    'settings:notif-schedules',
    loadSchedulesMock,
    { realFn: fetchSchedules },
  );

  const [scheduleDrafts, setScheduleDrafts] = useState<ScheduleDrafts>(
    () => ({ ...SCHEDULE_DEFAULTS }),
  );
  const [schedulesHydrated, setSchedulesHydrated] = useState(false);
  // Ref mirror so the debounced flush reads the freshest drafts without
  // re-arming on every keystroke — same discipline as `serverProfileRef`.
  const scheduleDraftsRef = useRef<ScheduleDrafts>(scheduleDrafts);
  // Kinds edited since the last successful PUT. Survives a failed PUT (the
  // Retry path re-reads it); cleared per-kind only when the exact draft
  // object that was sent is still current (identity compare — drafts are
  // replaced immutably, so a mid-flight edit keeps its kind dirty).
  const dirtyKindsRef = useRef<Set<NotificationKind>>(
    new Set<NotificationKind>(),
  );
  const schedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedCtrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (schedTimerRef.current !== null) clearTimeout(schedTimerRef.current);
      schedCtrlRef.current?.abort();
    };
  }, []);

  // Hydrate once per real settle. Runs while the rows are still disabled, so
  // `scheduleDraftsRef.current` cannot have diverged from the defaults —
  // adopting over it never clobbers a user edit.
  useEffect(() => {
    if (schedulesHydrated) return;
    if (schedulesQuery.loading) return;
    if (schedulesQuery.isMock) return;
    const fresh = schedulesQuery.data;
    if (!fresh) return;
    const adopted: ScheduleDrafts = { ...scheduleDraftsRef.current };
    for (const row of fresh.schedules) {
      // Only the editable email rows hydrate the drafts; sms placeholder
      // rows are static UI and push has no UI yet. Unknown kinds (a future
      // server) are ignored, never a crash.
      if (row.channel !== 'email' || !isNotificationKind(row.kind)) continue;
      adopted[row.kind] = {
        timeOfDay: row.timeOfDay,
        weekday: row.weekday ?? SCHEDULE_DEFAULTS[row.kind].weekday,
        enabled: row.enabled,
      };
    }
    scheduleDraftsRef.current = adopted;
    // Sync-to-external-system case — driven by the query resolution, not by
    // our own state (same pattern as the meQuery/prefs hydration effects).
    setScheduleDrafts(adopted);
    setSchedulesHydrated(true);
  }, [
    schedulesHydrated,
    schedulesQuery.loading,
    schedulesQuery.isMock,
    schedulesQuery.data,
  ]);

  const flushSchedules = useCallback(async (): Promise<void> => {
    const kinds = Array.from(dirtyKindsRef.current);
    if (kinds.length === 0) return;
    const drafts = scheduleDraftsRef.current;
    const sent = new Map<NotificationKind, ScheduleDraft>(
      kinds.map((k) => [k, drafts[k]]),
    );
    const inputs = kinds.map((k) => toScheduleInput(k, drafts[k]));

    schedCtrlRef.current?.abort();
    const ctrl = new AbortController();
    schedCtrlRef.current = ctrl;
    try {
      await putSchedules(inputs, ctrl.signal);
      if (ctrl.signal.aborted) return;
      // Success — un-dirty each sent kind unless the user edited it again
      // while the PUT was in flight (identity compare, see dirtyKindsRef).
      for (const [k, sentDraft] of sent) {
        if (scheduleDraftsRef.current[k] === sentDraft) {
          dirtyKindsRef.current.delete(k);
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted) return;
      // A canceled PUT (unmount / superseded flush) is not a real failure —
      // a superseding flush re-sends the still-dirty kinds anyway.
      if (err instanceof ApiError && err.code === 'canceled') return;
      // Unlike prefs there is NO localStorage durability here: be explicit
      // that the change did not persist. The dirty set was kept, so Retry
      // re-sends the freshest drafts. Author-controlled copy — never an
      // echo of the server string.
      toast({
        message: 'Your notification schedule could not be saved.',
        tone: 'error',
        action: {
          label: 'Retry',
          onClick: () => {
            void flushSchedules();
          },
        },
      });
    }
  }, [toast]);

  const onScheduleChange = useCallback(
    (kind: NotificationKind, patch: Partial<ScheduleDraft>): void => {
      // Defence in depth — the rows are disabled pre-hydration, so this
      // cannot fire; the guard keeps PUT-before-hydrate impossible even if
      // a future row forgets its `disabled` prop.
      if (!schedulesHydrated) return;
      const prev = scheduleDraftsRef.current;
      const next: ScheduleDrafts = {
        ...prev,
        [kind]: { ...prev[kind], ...patch },
      };
      scheduleDraftsRef.current = next;
      setScheduleDrafts(next);
      dirtyKindsRef.current.add(kind);
      if (schedTimerRef.current !== null) clearTimeout(schedTimerRef.current);
      schedTimerRef.current = setTimeout(() => {
        schedTimerRef.current = null;
        void flushSchedules();
      }, SCHEDULES_DEBOUNCE_MS);
    },
    [schedulesHydrated, flushSchedules],
  );

  // ───── Log out (Profile group action) ─────
  //
  // `useAuth().logout` is best-effort by contract: it POSTs /auth/logout,
  // then ALWAYS clears the in-memory auth state (even when the POST fails —
  // a logout must never leave the user stuck) and re-probes. The resulting
  // `status: 'guest'` flip makes App.tsx's `RequireAuth` gate replace this
  // screen with `/login`; there is deliberately NO explicit `navigate` here,
  // so the redirect can never race or disagree with the auth state.
  // `loggingOut` single-flights the click and drives the disabled/aria-busy
  // presentation. It is never reset on the happy path because the gate
  // unmounts this page; the documented server-5xx edge (cookie survives, the
  // re-probe re-authenticates — tracked as F-201) round-trips through /login
  // back here as a fresh mount, which starts un-disabled again.
  const [loggingOut, setLoggingOut] = useState(false);
  const onLogout = useCallback((): void => {
    if (loggingOut) return;
    setLoggingOut(true);
    void logout();
  }, [loggingOut, logout]);

  // ───── Device-adaptive two-column layout (Phase D2, fix-pass revision) ─
  //
  // The five settings groups render inside ONE always-mounted wrapper
  // (`.km-settings__grid`) at every width; Settings.css lays that wrapper
  // out as a row-major two-column grid at ≥1024px and leaves it a plain,
  // styleless <div> below — visually identical to the pre-D2 stack.
  // Desktop-only because tablet's content column is only ~520px at 768px
  // (viewport − 248px sidebar rail — the D1 arithmetic in Today.css),
  // which a two-column split would carve into ~230px control stacks, well
  // below the ~295px of control width even a 375px phone gives these
  // forms. The desktop readability arithmetic lives with the CSS
  // (Settings.css, `.km-settings__grid`).
  //
  // Deliberately CSS-ONLY — no `useDeviceClass` render branch. The first
  // D2 cut swapped a two-column tree for a bare fragment at the 1024px
  // boundary; React reconciles by type, so a live crossing (iPad rotation)
  // REMOUNTED all five groups — and TwoFactorSection's freshly regenerated
  // recovery codes are held in its own state, shown once, never persisted,
  // so the remount destroyed their display AFTER the old codes were
  // already invalidated server-side (fix-pass SHOULD-FIX 1). With one
  // mounted tree the breakpoint switch is pure style recalculation:
  // component instances, their state (one-shot 2FA codes, open tiles,
  // in-flight flows), and the DOM all survive. Pinned by the
  // resize-crossing test in Settings.test.tsx.
  //
  // Row-major auto-placement keeps DOM = tab = screen-reader = VISUAL
  // reading order EXACTLY the mobile order (Profile → 2FA → Notifications
  // → Appearance → Beta feedback) in every layout. Each group element is
  // built ONCE below and rendered by the one tree, so no group's
  // props/handlers can differ between layouts.

  // ───── Profile (server-backed) ─────
  const profileGroup = (
    <SettingsGroup icon="user" eyebrow="프로필" title="Profile" tone="accent">
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
      {/* Log out — the account-level session action lives with the account
          fields. SECURITY: the button only calls `useAuth().logout`; session
          revocation + cookie clearing are the server's job (POST
          /auth/logout), local state clearing is AuthProvider's, and the
          /login redirect is RequireAuth's — see the handler comment above. */}
      <div className="km-settings__logout">
        <p className="km-settings__logout-hint">
          <Bilingual
            en="Ends your session on this device and returns you to the sign-in screen."
            kr="이 기기에서 로그아웃하고 로그인 화면으로 돌아갑니다."
          />
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={onLogout}
          disabled={loggingOut}
          aria-busy={loggingOut ? true : undefined}
        >
          <Bilingual en="Log out" kr="로그아웃" />
        </Button>
      </div>
    </SettingsGroup>
  );

  // ───── Two-Factor Authentication (server-backed) ─────
  const twoFactorGroup = <TwoFactorSection />;

  // Prefs (appearance) cross-device sync failure is surfaced via a
  // non-blocking toast (see flushPrefs) — the change is already durable in
  // localStorage, so it never blanks the screen with an inline ErrorCard.

  // ───── Notifications (F-040 — /notifications/schedules) ─────
  const notificationsGroup = (
    <SettingsGroup
      icon="bell"
      eyebrow="알림"
      title="Notifications"
      mock={schedulesQuery.isMock}
      tone="mint"
    >
      {schedulesQuery.error && schedulesQuery.data === null ? (
        // Blocking load failure → ErrorCard with a real retry (contract).
        // A mock settle is a soft state: rows render, but stay disabled.
        <ErrorCard
          message="Couldn’t load your notification schedule. Check your connection and retry."
          onRetry={() => {
            schedulesQuery.refetch();
          }}
        />
      ) : (
        <>
          <p className="km-settings__sched-note">
            Pick when each notification lands. Times follow your device time
            zone ({DEVICE_TZ}).
          </p>

          <Eyebrow className="km-settings__group-eyebrow">
            <Bilingual en="Email" kr="이메일" />
          </Eyebrow>
          {SCHEDULE_KIND_META.map(({ kind, label, hint }, i) => (
            <ScheduleRow
              key={kind}
              kind={kind}
              label={label}
              hint={hint}
              draft={scheduleDrafts[kind]}
              disabled={!schedulesHydrated}
              last={i === SCHEDULE_KIND_META.length - 1}
              onChange={onScheduleChange}
            />
          ))}

          {/* SMS placeholder (F-040) — same three types, deliberately
              inert. The server can store sms rows, but nothing sends them
              yet, so offering live controls would be a lie; a labelled
              preview is honest. */}
          <Eyebrow className="km-settings__group-eyebrow">
            <Bilingual en="SMS" kr="문자" />{' '}
            <span className="km-settings__sched-badge">Coming soon</span>
          </Eyebrow>
          <p className="km-settings__sched-note">
            SMS delivery isn’t available yet — this channel is a placeholder
            and can’t be turned on.
          </p>
          {SCHEDULE_KIND_META.map(({ kind, label, hint }, i) => (
            <ScheduleRow
              key={kind}
              kind={kind}
              label={label}
              hint={hint}
              draft={SCHEDULE_DEFAULTS[kind]}
              disabled
              placeholder
              last={i === SCHEDULE_KIND_META.length - 1}
              onChange={ignoreScheduleChange}
            />
          ))}
        </>
      )}
    </SettingsGroup>
  );

  // ───── Appearance (localStorage cache + server sync) ─────
  // Glossary reconciliation (P3b): "Appearance" is 화면 표시 app-wide
  // (nav.ts settings eyebrow agrees) — the old 외관 is retired.
  const appearanceGroup = (
    <SettingsGroup
      icon="palette"
      eyebrow="화면 표시"
      title="Appearance"
      mock={prefsQuery.isMock}
      tone="ochre"
    >
      <ThemeModeControl mode={themeMode} onSelect={setThemeMode} />
      {/* Text size (F-025) — drives TextSizeProvider, which stamps
          data-text-size on <html> and persists to km.textSize for the
          instant same-device path; the screen-level prefs sync above ALSO
          carries the pick to /settings/prefs (textSize) so it follows the
          user across devices. The :root[data-text-size] blocks in
          index.css re-point the ROOT font-size — attribute only, never an
          inline style projection. */}
      <TextSizeControl value={textSize} onSelect={setTextSize} />
      <LanguageDisplayControl
        value={settings.languageDisplay}
        onChange={(next) => {
          updateSettings((prev) => ({ ...prev, languageDisplay: next }));
        }}
      />
      {/* Accent (Redesign §14a) — the ONLY color choice (v2 flatten: the
          paper/correct/wrong palette pickers were removed; surfaces and
          the success/danger semantics are fixed theme tokens now). Drives
          AccentProvider, which stamps data-accent on <html> and persists
          to km.accent for the instant same-device path; the screen-level
          prefs sync above ALSO carries the pick to /settings/prefs
          (palette.accent) so it follows the user across devices. The
          [data-accent] token blocks in index.css re-tint the whole
          --vermilion family instantly, light AND dark — attribute only,
          never inline CSS-var projection. */}
      <SwatchPicker
        label="Accent"
        hint="Buttons, highlights, the Learn hexagon."
        presets={ACCENT_OPTIONS}
        selectedId={accent}
        last
        onSelect={(id) => {
          if (isAccent(id)) setAccent(id);
        }}
      />

      <button
        type="button"
        onClick={resetSettings}
        className="km-btn km-btn--ghost km-btn--sm focusring km-settings__reset"
      >
        <Bilingual en="Reset to defaults" kr="기본값으로" />
      </button>
    </SettingsGroup>
  );

  // ───── Beta feedback (F-023 — in-app ticketing) ─────
  // A more prominent global entry (e.g. a ChatFab-style FAB) is a
  // follow-up — ticket F-127; this Settings tile is the F-023 entry point
  // per spec.
  const feedbackGroup = (
    <SettingsGroup
      icon="chat"
      eyebrow="베타 피드백"
      title="Beta feedback"
      tone="plain"
    >
      <p className="km-settings__ticket-hint">
        <Bilingual
          en="Report a bug, a concern, a suggestion, or a request — and see what other beta testers have filed."
          kr="버그, 우려사항, 제안, 요청을 알려주세요 — 다른 베타 테스터가 남긴 내용도 볼 수 있어요."
        />
      </p>
      <Button
        variant="gold"
        size="md"
        fullWidth
        onClick={() => {
          navigate('/tickets');
        }}
      >
        <Bilingual en="Report a bug or suggestion" kr="버그 또는 제안 보내기" />
      </Button>
    </SettingsGroup>
  );

  return (
    <section
      className="screen km-settings km-rain-sheen"
      style={{ position: 'relative' }}
      aria-labelledby="km-settings-title"
    >
      {meQuery.isMock || prefsQuery.isMock || schedulesQuery.isMock ? (
        <MockBadge />
      ) : null}
      {/* F-128 devices #4/#2 — the shared hub-header recipe (batch-2
          fix-pass BLOCKER-2, components/PageHubHeader.tsx) instead of a bare
          `Topbar`. */}
      <PageHubHeader
        titleId="km-settings-title"
        eyebrow={
          <Bilingual en={SETTINGS_NAV.eyebrow} kr={SETTINGS_NAV.krEyebrow} />
        }
        heading={<Bilingual en="Settings" kr="설정" />}
      />

      {/* D2 (fix-pass revision) — ONE tree at every width. The wrapper is
          styleless below 1024px (the groups stack exactly as pre-D2) and a
          row-major two-column grid at ≥1024px (Settings.css). Never
          branch-swap this on a device class: crossing the breakpoint would
          remount the groups and wipe TwoFactorSection's shown-once
          recovery codes — see the layout comment above. */}
      <div className="km-settings__grid">
        {profileGroup}
        {twoFactorGroup}
        {notificationsGroup}
        {appearanceGroup}
        {feedbackGroup}
        {/* Help & tours (guided tutorial) — self-contained: reads the tour
            context leniently and renders nothing when Shell's TourProvider
            isn't mounted (provider-free test renders). */}
        <ToursSection />
      </div>

      <p className="km-settings__about">한국어 마스터 · v0.2</p>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Pieces
// ─────────────────────────────────────────────────────────────

/**
 * One Settings group = one `CollapsibleTile` (F-038), starting COLLAPSED.
 * The tile's header button carries the group's bilingual title (through the
 * `<Bilingual/>` primitive so the language-display setting applies) and the
 * disclosure a11y contract (aria-expanded/controls) comes from the primitive.
 *
 * F-128 reskin: `surface="city"` + `rail` (devices #1/#2) swap the old flat
 * `Card` shell for a signboard/hanji-paper surface with a leading-edge
 * DancheongRail — `tone` is a fixed per-group identity color (Profile=accent,
 * 2FA=blue, Notifications=mint, Appearance=ochre, Beta feedback=plain) so the
 * stack of groups reads as distinct sections rather than one long list, in
 * BOTH themes. Purely decorative: `CollapsibleTile`'s header/body markup and
 * disclosure a11y contract are unchanged by the surface swap (see its own
 * doc comment), so this never touches the open/close wiring any group's
 * controls sit inside.
 */
function SettingsGroup({
  icon,
  eyebrow,
  title,
  mock = false,
  tone = 'accent',
  children,
}: {
  icon: IconName;
  /** Korean group heading — renders with `title` via `<Bilingual/>`. */
  eyebrow: string;
  /** English group heading. */
  title: string;
  /** When true, this group's prefs are running off the mock fall-back (the
   *  server is unreachable). Renders a small 🅂 marker so the dev signal is
   *  honest at the group level, mirroring the corner MockBadge semantics. */
  mock?: boolean;
  /** F-128 — the group's CityCard/DancheongRail identity color. Defaults to
   *  `'accent'` (tracks the user's accent picker) for the Profile group. */
  tone?: DancheongRailTone;
  children: ReactNode;
}): JSX.Element {
  return (
    <CollapsibleTile
      className="km-settings__group"
      surface="city"
      tone={tone}
      rail
      defaultCollapsed
      title={
        <span className="km-settings__group-head">
          <span className="km-settings__group-icon" aria-hidden="true">
            <Icon name={icon} size={14} />
          </span>
          <span className="km-settings__group-title">
            <Bilingual kr={eyebrow} en={title} />
          </span>
          {mock ? (
            <span
              className="km-settings__group-mock"
              aria-label="Preferences not synced from server"
            >
              🅂
            </span>
          ) : null}
        </span>
      }
    >
      {children}
    </CollapsibleTile>
  );
}

// ─────────────────────────────────────────────────────────────
// Two-Factor Authentication (PASS LOGIN — PART C4)
// ─────────────────────────────────────────────────────────────
//
// Mandatory 2FA: there is intentionally NO disable button. The only operations
// are (a) regenerate recovery codes and (b) re-enroll the authenticator (new
// phone). Both require a password re-auth at the moment of action — the
// password is sent only with the privileged call, never stored. A lost-device
// total lockout is recovered by the operator via the `mfa-reset` CLI (noted in
// the UI), not in-app.
//
// SECURITY:
//   - The re-auth password lives in a local state field for exactly the
//     in-flight call and is cleared as soon as the modal closes. It is never
//     persisted and never sent anywhere but the privileged endpoint.
//   - The pending secret (re-enroll) + recovery codes are held in React state
//     only, shown once, never persisted (RecoveryCodesPanel + qr helper).
//   - No raw server error text is rendered: blocking loads use ErrorCard with
//     fixed copy; transient failures use the global Toast with fixed copy.

/** Author-controlled copy for a 2FA action failure — never echoes `err`. */
function mfaMessageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'That password was incorrect.';
    if (err.status === 400) return 'That code didn’t match. Try again.';
    if (err.status === 423) {
      // Surface the real lockout window when the server supplies retry_after
      // (seconds) — consistent with Login.tsx (SF1). Falls back to generic copy.
      if (typeof err.retryAfter === 'number' && err.retryAfter > 0) {
        const minutes = Math.max(1, Math.ceil(err.retryAfter / 60));
        return `Too many attempts — wait ${String(minutes)} ${
          minutes === 1 ? 'minute' : 'minutes'
        } and try again.`;
      }
      return 'Too many attempts — wait a few minutes and try again.';
    }
    if (err.status === 429) {
      return 'Too many attempts. Please wait a moment and try again.';
    }
    if (err.status === 0 || err.code === 'network') {
      return 'Network unreachable. Please try again.';
    }
  }
  return 'Something went wrong. Please try again.';
}

/** Which re-auth flow the inline panel is driving, if any. */
type MfaFlow = 'none' | 'regenerate' | 'reenroll';

function TwoFactorSection(): JSX.Element {
  const { toast } = useToast();

  // Status load. Mock fallback keeps the section rendering in a server-down
  // dev session; a real settle drives the badge.
  const statusQuery = useEndpointOrMock<MfaStatus>(
    'settings:mfa-status',
    loadMfaStatusMock,
    { realFn: fetchMfaStatus },
  );

  const [flow, setFlow] = useState<MfaFlow>('none');
  // Recovery codes to display once (after a successful regenerate / re-enroll).
  const [codes, setCodes] = useState<string[] | null>(null);

  const status = statusQuery.data;

  // Re-fetch the status (recovery-codes-remaining changes after a regenerate).
  const reloadStatus = useCallback((): void => {
    void statusQuery.refetch();
  }, [statusQuery]);

  function reset(): void {
    setFlow('none');
    setCodes(null);
  }

  // Blocking load failure → ErrorCard (per the contract). A mock settle is a
  // soft state, not a failure, so it doesn't block.
  return (
    <SettingsGroup
      icon="info"
      eyebrow="2단계 인증"
      title="Two-Factor Authentication"
      mock={statusQuery.isMock}
      tone="blue"
    >
      {statusQuery.error && !statusQuery.data ? (
        <ErrorCard
          message="Couldn’t load your 2FA status. Check your connection and retry."
          onRetry={reloadStatus}
        />
      ) : codes !== null ? (
        <RecoveryCodesPanel
          codes={codes}
          title="Your new recovery codes"
          // No app-entry ack here — the user is already signed in; a simple
          // "Done" closes the panel.
        />
      ) : (
        <>
          <div className="km-mfa__status">
            <span className="km-mfa__badge">
              <Icon name="check" size={12} />
              {status?.enabled ? 'Enabled' : 'Required'}
            </span>
            {status ? (
              <span className="km-mfa__remaining">
                {status.recoveryCodesRemaining}{' '}
                {status.recoveryCodesRemaining === 1
                  ? 'recovery code'
                  : 'recovery codes'}{' '}
                remaining
              </span>
            ) : null}
          </div>

          {flow === 'none' ? (
            <div className="km-mfa__actions">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFlow('regenerate');
                }}
              >
                Regenerate recovery codes
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFlow('reenroll');
                }}
              >
                Re-enroll authenticator (new phone)
              </Button>
            </div>
          ) : flow === 'regenerate' ? (
            <RegenerateFlow
              onCancel={reset}
              onDone={(newCodes) => {
                setCodes(newCodes);
                setFlow('none');
                reloadStatus();
                toast({ message: 'New recovery codes generated.', tone: 'success' });
              }}
              onError={(err) => {
                toast({ message: mfaMessageFor(err), tone: 'error' });
              }}
            />
          ) : (
            <ReEnrollFlow
              onCancel={reset}
              onDone={(newCodes) => {
                setCodes(newCodes);
                setFlow('none');
                reloadStatus();
                toast({
                  message: 'Authenticator re-enrolled.',
                  tone: 'success',
                });
              }}
              onError={(err) => {
                toast({ message: mfaMessageFor(err), tone: 'error' });
              }}
            />
          )}

          <p className="km-mfa__note">
            2FA is required and can’t be turned off. If you lose your
            authenticator and your recovery codes, contact the operator to reset
            it.
          </p>
        </>
      )}

      {codes !== null ? (
        <div className="km-mfa__actions">
          <Button variant="gold" size="sm" onClick={reset}>
            Done
          </Button>
        </div>
      ) : null}
    </SettingsGroup>
  );
}

/** Mock fallback for the MFA status query (server-down dev session). */
async function loadMfaStatusMock(): Promise<MfaStatus> {
  await new Promise((resolve) => setTimeout(resolve, 80));
  return { enabled: true, recoveryCodesRemaining: 10 };
}

/**
 * Regenerate-recovery-codes flow — a single password field. On submit it
 * re-auths and issues a fresh set; the parent shows them once.
 */
function RegenerateFlow({
  onCancel,
  onDone,
  onError,
}: {
  onCancel: () => void;
  onDone: (codes: string[]) => void;
  onError: (err: unknown) => void;
}): JSX.Element {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const pwId = useId();

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting || password === '') return;
    setSubmitting(true);
    try {
      const { recoveryCodes } = await regenerateRecoveryCodes(password);
      setPassword('');
      onDone(recoveryCodes);
    } catch (err) {
      onError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="km-mfa__reauth" onSubmit={handleSubmit} aria-busy={submitting}>
      <div className="km-field">
        <label htmlFor={pwId} className="km-field__label">
          Confirm your password to continue
        </label>
        <input
          id={pwId}
          className="km-field__input"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
        />
      </div>
      <div className="km-mfa__actions">
        <Button type="submit" variant="gold" size="sm" disabled={submitting || password === ''}>
          <span role="status" aria-live="polite">
            {submitting ? 'One moment…' : 'Regenerate codes'}
          </span>
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Re-enroll flow — password re-auth → mint a new pending secret (QR + manual
 * key) → 6-digit confirm → new recovery codes. Rotates the TOTP secret.
 */
function ReEnrollFlow({
  onCancel,
  onDone,
  onError,
}: {
  onCancel: () => void;
  onDone: (codes: string[]) => void;
  onError: (err: unknown) => void;
}): JSX.Element {
  // Two sub-steps: 're-auth' collects the password + mints the secret;
  // 'confirm' shows the QR and takes the code.
  const [step, setStep] = useState<'reauth' | 'confirm'>('reauth');
  const [password, setPassword] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const pwId = useId();
  const codeId = useId();
  const secretId = useId();

  // N4: the `mfaEnroll`/`mfaConfirm` service calls don't accept an AbortSignal,
  // so we can't cancel the in-flight request — but we MUST NOT `setState` /
  // `onError` after unmount (the modal can close mid-request). A mounted guard
  // makes every late settle a no-op, matching the abort discipline the fetch /
  // prefs paths in this file use for their cancellable requests.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleReauth(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting || password === '') return;
    setSubmitting(true);
    try {
      const { otpauthUri, secret: sec } = await mfaEnroll({ password });
      if (!mountedRef.current) return;
      setSecret(sec);
      setStep('confirm');
      try {
        const dataUrl = await otpauthUriToDataUrl(otpauthUri);
        if (!mountedRef.current) return;
        setQrDataUrl(dataUrl);
      } catch {
        if (!mountedRef.current) return;
        setQrFailed(true);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      onError(err);
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  async function handleConfirm(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting || code.trim() === '') return;
    setSubmitting(true);
    try {
      // Re-auth password is re-sent with confirm too (the server's session leg
      // accepts `{password, code}`); it's still only in memory.
      const { recoveryCodes } = await mfaConfirm({ password, code: code.trim() });
      if (!mountedRef.current) return;
      setPassword('');
      onDone(recoveryCodes);
    } catch (err) {
      if (!mountedRef.current) return;
      onError(err);
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  if (step === 'reauth') {
    return (
      <form className="km-mfa__reauth" onSubmit={handleReauth} aria-busy={submitting}>
        <div className="km-field">
          <label htmlFor={pwId} className="km-field__label">
            Confirm your password to set up a new authenticator
          </label>
          <input
            id={pwId}
            className="km-field__input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
          />
        </div>
        <div className="km-mfa__actions">
          <Button type="submit" variant="gold" size="sm" disabled={submitting || password === ''}>
            <span role="status" aria-live="polite">
              {submitting ? 'One moment…' : 'Continue'}
            </span>
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="km-mfa__reauth">
      <p className="km-mfa__note" style={{ marginTop: 0 }}>
        Scan this with your new authenticator app, then enter the 6-digit code
        it shows.
      </p>
      <div className="km-enroll__qr">
        {qrDataUrl ? (
          <img
            src={qrDataUrl}
            alt="QR code for setting up two-factor authentication"
            className="km-enroll__qr-img"
            width={220}
            height={220}
          />
        ) : qrFailed ? (
          <p className="km-field__hint">
            The QR couldn’t be drawn. Enter the setup key below instead.
          </p>
        ) : (
          <p className="km-field__hint" role="status" aria-live="polite">
            Preparing your setup code…
          </p>
        )}
      </div>
      {secret ? (
        <div className="km-enroll__secret">
          <label htmlFor={secretId} className="km-field__label">
            Or enter this setup key manually
          </label>
          <code id={secretId} className="km-enroll__secret-value">
            {secret}
          </code>
        </div>
      ) : null}
      <form onSubmit={handleConfirm} aria-busy={submitting}>
        <div className="km-field">
          <label htmlFor={codeId} className="km-field__label">
            Authentication code
          </label>
          <input
            id={codeId}
            className="km-field__input km-login__code-input"
            type="text"
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={6}
            required
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
            }}
            placeholder="000000"
          />
        </div>
        <div className="km-mfa__actions">
          <Button type="submit" variant="gold" size="sm" disabled={submitting || code.trim() === ''}>
            <span role="status" aria-live="polite">
              {submitting ? 'One moment…' : 'Confirm new authenticator'}
            </span>
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Theme-mode control (PF-A A4, extended by F-132) — Light / Dark / System /
 * Auto segmented radiogroup.
 *
 * Lives in the Appearance group above the palette swatches. Unlike the
 * palette (which persists through `km.settings` + the server `/settings/prefs`
 * sync), the light/dark mode persists through `ThemeProvider` into
 * `km.theme` — 'system' CLEARS the key and follows the OS pref live; 'auto'
 * (F-132) stores 'auto' and follows the local time-of-day boundary live
 * (Day Seoul 06:00–18:00, Night Seoul otherwise — see `resolveAutoTheme` in
 * `hooks/theme-context.ts`). The two concerns (theme mode vs. palette) are
 * deliberately separate stores.
 *
 * The button reads "Auto" — one word, matching its Light/Dark/System
 * siblings — with the time-of-day behavior spelled out in the row hint
 * below instead of crammed into the segmented label.
 *
 * Picking ANY mode here — including toggling elsewhere via `toggleTheme` —
 * is a manual choice that wins outright over whatever 'system'/'auto' would
 * otherwise resolve to; there's no separate "override" concept because the
 * modes are mutually exclusive radio options, not layered.
 *
 * A11y: a `radiogroup` of four `radio` buttons implementing the full
 * WAI-ARIA APG radio-group keyboard contract, mirroring the in-repo
 * `SwatchPicker`:
 *   - Roving tabindex — only the checked radio is tabbable (`tabIndex={0}`);
 *     the others are `-1`, so the group is a SINGLE Tab stop and Tab lands on
 *     the active mode.
 *   - Arrow Left/Right/Up/Down move between options; Home/End jump to the
 *     ends; the move wraps. Because selection follows focus, an arrow move IS
 *     the commit. Space/Enter activate the focused radio via the native
 *     `<button>` click (committing the already-focused mode — a no-op since it
 *     is the one focus is on).
 *   - `tabIndex={-1}` on the group makes the interactive-role container
 *     focusable without entering the Tab order (satisfies jsx-a11y's
 *     interactive-supports-focus rule without a second Tab stop).
 *
 * Unlike `SwatchPicker` — which separates focus from selection so an
 * arrow-sweep doesn't churn the palette `localStorage` debounce + CSS-var
 * cascade on every keypress — this control commits selection AS focus moves
 * (the standard "selection follows focus" APG variant). Switching theme mode
 * is cheap and idempotent (a single `data-theme` swap), there is no
 * per-keypress cost to avoid, and selection-follows-focus is the behaviour a
 * user expects from a small segmented Light/Dark/System/Auto control.
 */
const THEME_MODES: ReadonlyArray<{ id: ThemeMode; label: string }> = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
  { id: 'auto', label: 'Auto' },
];

function ThemeModeControl({
  mode,
  onSelect,
}: {
  mode: ThemeMode;
  onSelect: (mode: ThemeMode) => void;
}): JSX.Element {
  // Refs by id (not index) so focus management survives a future reorder of
  // THEME_MODES, matching SwatchPicker's approach.
  const optRefs = useRef<Map<ThemeMode, HTMLButtonElement>>(new Map());
  const selectedIndex = THEME_MODES.findIndex((m) => m.id === mode);

  // Commit selection to the option at `nextIndex` (wrapping) AND move DOM
  // focus to it. Selection follows focus — see the doc-comment for why this
  // diverges from SwatchPicker's separated-focus model.
  const moveTo = useCallback(
    (nextIndex: number): void => {
      const wrapped =
        (nextIndex + THEME_MODES.length) % THEME_MODES.length;
      const next = THEME_MODES[wrapped];
      if (!next) return;
      if (next.id !== mode) onSelect(next.id);
      optRefs.current.get(next.id)?.focus();
    },
    [mode, onSelect],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): void => {
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          moveTo(selectedIndex + 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          moveTo(selectedIndex - 1);
          break;
        case 'Home':
          e.preventDefault();
          moveTo(0);
          break;
        case 'End':
          e.preventDefault();
          moveTo(THEME_MODES.length - 1);
          break;
        default:
          break;
      }
    },
    [moveTo, selectedIndex],
  );

  return (
    <div className="km-settings__thememode">
      <div className="km-settings__row-head">
        <span className="km-settings__row-label">Theme</span>
        <span className="km-settings__row-hint">
          Light, dark, match your device, or Auto — Day Seoul 6am–6pm, Night
          Seoul after.
        </span>
      </div>
      <div
        className="km-settings__thememode-row"
        role="radiogroup"
        aria-label="Theme mode"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {THEME_MODES.map((m) => {
          const selected = m.id === mode;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={selected}
              // Roving tabindex: only the checked radio is a Tab stop, so the
              // group exposes a single tab entry and Tab lands on the active
              // mode (WAI-ARIA APG radio-group pattern).
              tabIndex={selected ? 0 : -1}
              ref={(el) => {
                if (el) optRefs.current.set(m.id, el);
                else optRefs.current.delete(m.id);
              }}
              onClick={() => {
                if (!selected) onSelect(m.id);
              }}
              className={
                'km-settings__thememode-opt focusring' +
                (selected ? ' km-settings__thememode-opt--active' : '')
              }
            >
              {m.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Generic 3-or-fewer-option segmented radiogroup (P3a) — the exact APG
 * roving-tabindex/selection-follows-focus contract `ThemeModeControl`
 * implements, extracted so the language-display control's two radiogroups
 * (mode + orientation) don't triplicate the keyboard handling. Reuses the
 * thememode CSS classes — they style a generic segment row, nothing
 * theme-specific. (`ThemeModeControl` itself is deliberately left untouched
 * in P3a to keep this change additive; folding it onto this is P3b cleanup.)
 */
function SegmentedRadioGroup<T extends string>({
  options,
  value,
  onSelect,
  ariaLabel,
}: {
  /** `ariaLabel` overrides an option's accessible name — for segments whose
   *  visible label is a compact glyph (the Text size control's S/M/L). */
  options: ReadonlyArray<{ id: T; label: string; ariaLabel?: string }>;
  value: T;
  onSelect: (next: T) => void;
  ariaLabel: string;
}): JSX.Element {
  // Refs by id (not index) so focus management survives an option reorder.
  const optRefs = useRef<Map<T, HTMLButtonElement>>(new Map());
  const selectedIndex = options.findIndex((o) => o.id === value);

  const moveTo = useCallback(
    (nextIndex: number): void => {
      const wrapped = (nextIndex + options.length) % options.length;
      const next = options[wrapped];
      if (!next) return;
      if (next.id !== value) onSelect(next.id);
      optRefs.current.get(next.id)?.focus();
    },
    [options, value, onSelect],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): void => {
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          moveTo(selectedIndex + 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          moveTo(selectedIndex - 1);
          break;
        case 'Home':
          e.preventDefault();
          moveTo(0);
          break;
        case 'End':
          e.preventDefault();
          moveTo(options.length - 1);
          break;
        default:
          break;
      }
    },
    [moveTo, selectedIndex, options.length],
  );

  return (
    <div
      className="km-settings__thememode-row"
      role="radiogroup"
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {options.map((o) => {
        const selected = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={o.ariaLabel}
            tabIndex={selected ? 0 : -1}
            ref={(el) => {
              if (el) optRefs.current.set(o.id, el);
              else optRefs.current.delete(o.id);
            }}
            onClick={() => {
              if (!selected) onSelect(o.id);
            }}
            className={
              'km-settings__thememode-opt focusring' +
              (selected ? ' km-settings__thememode-opt--active' : '')
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Text-size control (F-025) — the app-wide root font-size scale.
 *
 * A compact S / M / L segmented radiogroup riding `SegmentedRadioGroup`
 * (per-option `ariaLabel` gives the glyph segments real accessible names:
 * "Small" / "Medium" / "Large"). Selection goes straight to
 * `TextSizeProvider` (instant `data-text-size` stamp + km.textSize); the
 * screen-level prefs change-effect syncs it to the server like the accent.
 */
const TEXT_SIZE_CONTROL_OPTIONS: ReadonlyArray<{
  id: TextSize;
  label: string;
  ariaLabel: string;
}> = (['sm', 'md', 'lg'] as const).map((id) => ({
  id,
  label: TEXT_SIZE_OPTIONS[id].label,
  ariaLabel: TEXT_SIZE_OPTIONS[id].name,
}));

function TextSizeControl({
  value,
  onSelect,
}: {
  value: TextSize;
  onSelect: (next: TextSize) => void;
}): JSX.Element {
  return (
    // Reuses the thememode section class — like the SegmentedRadioGroup's
    // row/opt classes, it styles a generic bordered segment section, nothing
    // theme-specific (folding these onto a neutral name is P3b cleanup).
    <div className="km-settings__thememode">
      <div className="km-settings__row-head">
        <span className="km-settings__row-label">Text size</span>
        <span className="km-settings__row-hint">
          {/* Honest v1 copy: only rem-sized text follows the root scale
              today; most screens are still px-pinned until the F-086
              px→rem migration lands. Don't promise "all text". */}
          Scales the base text size. More of the app follows it as screens
          are updated.
        </span>
      </div>
      <SegmentedRadioGroup
        ariaLabel="Text size"
        options={TEXT_SIZE_CONTROL_OPTIONS}
        value={value}
        onSelect={onSelect}
      />
    </div>
  );
}

/**
 * Language-display control (Overhaul P3a) — how bilingual UI CHROME renders.
 *
 * A 3-option segmented radiogroup (English · Korean · Both). Selecting
 * **Both** reveals two sub-controls:
 *   - orientation — which language leads (`primary`);
 *   - a native `<input type="range">` sizing the secondary language
 *     (`subScale`, 0.4–1.0 in 0.05 steps) with a live sample label that
 *     resizes as you drag (the provider projects the value to
 *     `--lang-sub-scale` on every state change — no debounce on the visual).
 *
 * Persistence rides the same debounced `/settings/prefs` PUT as the palette
 * (the parent passes changes through `updateSettings`; the screen-level
 * change-effect syncs). Scope note in the hint: learning MATERIAL never
 * follows this — it is chrome-only by design.
 */
const LANGUAGE_MODE_OPTIONS: ReadonlyArray<{
  id: LanguageDisplayMode;
  label: string;
}> = [
  { id: 'en', label: 'English' },
  { id: 'ko', label: 'Korean' },
  { id: 'both', label: 'Both' },
];

const LANGUAGE_ORDER_OPTIONS: ReadonlyArray<{
  id: BilingualLanguage;
  label: string;
}> = [
  { id: 'ko', label: 'Korean first' },
  { id: 'en', label: 'English first' },
];

/** Slider granularity — coarse enough to feel like discrete steps, fine
 *  enough that the jump is never jarring. Mirrored in the server schema only
 *  as the [min, max] bounds; the step is a UX choice, not a contract. */
const LANG_SUB_SCALE_STEP = 0.05;

function LanguageDisplayControl({
  value,
  onChange,
}: {
  value: LanguageDisplayPrefs;
  onChange: (next: LanguageDisplayPrefs) => void;
}): JSX.Element {
  const sliderId = useId();
  const isBoth = value.mode === 'both';
  const pct = `${String(Math.round(value.subScale * 100))}%`;

  return (
    <div className="km-settings__langdisplay">
      <div className="km-settings__row-head">
        <span className="km-settings__row-label">Language display</span>
        <span className="km-settings__row-hint">
          How menus and titles show Korean and English. Study material always
          stays Korean.
        </span>
      </div>
      <SegmentedRadioGroup
        ariaLabel="Language display"
        options={LANGUAGE_MODE_OPTIONS}
        value={value.mode}
        onSelect={(mode) => {
          onChange({ ...value, mode });
        }}
      />

      {isBoth ? (
        <>
          <div className="km-settings__row-head km-settings__langsub-head">
            <span className="km-settings__row-label">Order</span>
            <span className="km-settings__row-hint">
              Which language leads.
            </span>
          </div>
          <SegmentedRadioGroup
            ariaLabel="Bilingual order"
            options={LANGUAGE_ORDER_OPTIONS}
            value={value.primary}
            onSelect={(primary) => {
              onChange({ ...value, primary });
            }}
          />

          <div className="km-settings__row-head km-settings__langsub-head">
            <label htmlFor={sliderId} className="km-settings__row-label">
              Second language size
            </label>
            <span className="km-settings__row-hint">
              Relative to the first language.
            </span>
          </div>
          <div className="km-settings__langslider">
            <input
              id={sliderId}
              type="range"
              min={LANG_SUB_SCALE_MIN}
              max={LANG_SUB_SCALE_MAX}
              step={LANG_SUB_SCALE_STEP}
              value={value.subScale}
              aria-valuetext={pct}
              className="focusring km-settings__slider"
              onChange={(e) => {
                onChange({
                  ...value,
                  subScale: clampSubScale(Number(e.target.value)),
                });
              }}
            />
            <span className="km-settings__slider-value" aria-hidden="true">
              {pct}
            </span>
          </div>
          {/* Live sample — a real <Bilingual/> so it tracks mode, order AND
              the CSS var as they change. Decorative duplicate of chrome text,
              hence aria-hidden. */}
          <div className="km-settings__langpreview" aria-hidden="true">
            <span className="km-settings__langpreview-caption">Preview</span>
            <span className="km-settings__langpreview-sample kr-display">
              <Bilingual kr="오늘" en="Today" />
            </span>
          </div>
        </>
      ) : null}
    </div>
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

/** No-op change handler for the static SMS placeholder rows — their controls
 *  are disabled, so this can never fire; it exists to keep the prop honest. */
function ignoreScheduleChange(): void {
  // Intentionally empty (F-040 placeholder rows are inert).
}

/**
 * One notification-schedule row (F-040): label/hint on the left; the timing
 * controls (weekday for the weekly report, time-of-day, enable switch) on
 * the right. Controls carry explicit aria-labels derived from the visible
 * row label ("Weekly report day", "Weekly report time") — the placeholder
 * variant suffixes "(SMS)" so the two channels' controls never share an
 * accessible name.
 */
function ScheduleRow({
  kind,
  label,
  hint,
  draft,
  disabled,
  last = false,
  placeholder = false,
  onChange,
}: {
  kind: NotificationKind;
  label: string;
  hint?: string;
  draft: ScheduleDraft;
  /** True until the schedules hydration lands (and always for placeholders):
   *  there is no localStorage behind these controls, so an edit that cannot
   *  PUT would be silently lost. */
  disabled: boolean;
  last?: boolean;
  /** The inert SMS-channel variant — see the F-040 placeholder note. */
  placeholder?: boolean;
  onChange: (kind: NotificationKind, patch: Partial<ScheduleDraft>) => void;
}): JSX.Element {
  const name = placeholder ? `${label} (SMS)` : label;
  return (
    <div
      className={
        'km-settings__sched-row' +
        (last ? ' km-settings__sched-row--last' : '') +
        (placeholder ? ' km-settings__sched-row--placeholder' : '')
      }
    >
      <div className="km-settings__toggle-meta">
        <div className="km-settings__toggle-label">{label}</div>
        {hint ? <div className="km-settings__toggle-hint">{hint}</div> : null}
      </div>
      <div className="km-settings__sched-controls">
        {kind === 'weekly_report' ? (
          <select
            className="km-settings__sched-field focusring"
            aria-label={`${name} day`}
            value={draft.weekday}
            disabled={disabled}
            onChange={(e) => {
              onChange(kind, { weekday: Number(e.target.value) });
            }}
          >
            {WEEKDAY_LABELS.map((day, i) => (
              <option key={day} value={i}>
                {day}
              </option>
            ))}
          </select>
        ) : null}
        <input
          type="time"
          className="km-settings__sched-field focusring"
          aria-label={`${name} time`}
          value={draft.timeOfDay}
          disabled={disabled}
          onChange={(e) => {
            // A cleared native time input reports '' — not a schedulable
            // value (the wire wants zero-padded HH:MM); keep the previous
            // time instead of sending garbage the server would 400.
            if (e.target.value === '') return;
            onChange(kind, { timeOfDay: e.target.value });
          }}
        />
        <Toggle
          checked={draft.enabled}
          disabled={disabled}
          ariaLabel={name}
          onChange={(next) => {
            onChange(kind, { enabled: next });
          }}
        />
      </div>
    </div>
  );
}

/**
 * ToursSection — the "Help & tours" group (guided tutorial):
 *   - Replay the first-run welcome tour on demand.
 *   - Replay any per-surface intro (the provider navigates to the surface
 *     first, then runs it). Prefix-matched tours (`/uploads/:id` — no
 *     static route to land on) are excluded from the picker.
 *   - "Skip all tours" — marks every registered tour seen in one write, so
 *     a beta tester can opt out of the whole system up front.
 *
 * Reads the tour context LENIENTLY (`useTourOptional`): in production Shell
 * always mounts `TourProvider`, but the existing provider-free Settings test
 * renders keep working because this section simply renders nothing then.
 */
function ToursSection(): JSX.Element | null {
  const tour = useTourOptional();
  const [pickedId, setPickedId] = useState<string>('');
  if (tour === null) return null;

  const replayable = TOURS.filter(
    (t) => t.id !== FIRST_RUN_TOUR_ID && t.match !== 'prefix',
  );
  const allSeen = TOUR_IDS.every((id) => tour.seen.has(id));

  return (
    <SettingsGroup icon="compass" eyebrow="도움말 · 투어" title="Help & tours" tone="plain">
      <p className="km-settings__ticket-hint">
        <Bilingual
          en="Short guided intros pop up the first time you open each part of the app. Replay them here, or turn them all off."
          kr="앱의 각 화면을 처음 열면 짧은 안내 투어가 나와요. 여기서 다시 보거나 모두 끌 수 있어요."
        />
      </p>
      <Button
        variant="gold"
        size="md"
        fullWidth
        onClick={() => {
          tour.replay(FIRST_RUN_TOUR_ID);
        }}
      >
        <Bilingual en="Replay the welcome tour" kr="환영 투어 다시 보기" />
      </Button>
      <div className="km-settings__tour-replay">
        <select
          className="km-field__input"
          aria-label="Choose a page intro to replay"
          value={pickedId}
          onChange={(e) => {
            setPickedId(e.target.value);
          }}
        >
          <option value="">Replay a page intro…</option>
          {replayable.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label} · {t.kr}
            </option>
          ))}
        </select>
        <Button
          variant="ghost"
          size="md"
          disabled={pickedId === ''}
          onClick={() => {
            // The option values are registry ids, but the DOM is not a
            // trusted source — narrow before handing to the provider.
            if (isTourId(pickedId)) tour.replay(pickedId);
          }}
        >
          <Bilingual en="Replay" kr="다시 보기" compact />
        </Button>
      </div>
      <button
        type="button"
        className="km-btn km-btn--ghost km-btn--sm focusring km-settings__reset"
        disabled={allSeen}
        onClick={() => {
          tour.markAllSeen();
        }}
      >
        <Bilingual
          en={allSeen ? 'All tours are off' : 'Skip all tours'}
          kr={allSeen ? '모든 투어 꺼짐' : '모든 투어 건너뛰기'}
        />
      </button>
    </SettingsGroup>
  );
}
