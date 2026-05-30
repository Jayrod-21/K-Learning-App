/**
 * Settings screen fixture + loader. Mirrors `DEFAULT_SETTINGS` from
 * `shared.jsx` in the design prototype — name/email/phone empty, notif off,
 * palette set to the canonical Hanji presets (vermilion + moss + vermilion).
 *
 * Real wiring (Pass 9): `GET /settings` returns this shape; `PUT /settings`
 * persists. Mirror to `localStorage["km.settings"]` for cross-device sync.
 */
import type { Settings } from '../../types/domain';
import { mockDelay } from './_delay';

export const SETTINGS_FIXTURE: Settings = {
  name: '',
  email: '',
  phone: '',
  notif: {
    channel: { email: false, sms: false },
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
};

/** Async loader — resolves with the default Settings shape. */
export async function loadSettingsMock(): Promise<Settings> {
  await mockDelay();
  return SETTINGS_FIXTURE;
}
