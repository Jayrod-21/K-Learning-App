/**
 * Settings context object + shared types.
 *
 * Lives apart from the Provider (`SettingsProvider.tsx`) and the hook
 * (`useSettings.ts`) so each file ships only one kind of export and the
 * `react-refresh/only-export-components` rule stays clean.
 */
import { createContext } from 'react';
import type { Settings } from '../lib/settings';

/**
 * Patch shape for `updateSettings`. Either a partial object that gets
 * shallow-merged into the previous state, or a reducer function for cases
 * where the next value depends on the previous one (e.g. toggling a deep
 * boolean without clobbering siblings — caller spreads as needed).
 */
export type SettingsPatch =
  | Partial<Settings>
  | ((prev: Settings) => Settings);

export interface SettingsContextValue {
  /** Current resolved settings — always populated (defaults at minimum). */
  settings: Settings;
  /**
   * Apply a patch. Object patches are SHALLOW-merged at the top level. To
   * change something nested (e.g. `notif.daily`) pass the function form and
   * return a fully-shaped `Settings` object — this keeps the API honest
   * about which keys are being replaced.
   */
  updateSettings: (patch: SettingsPatch) => void;
  /** Reset to `DEFAULT_SETTINGS` and persist. */
  resetSettings: () => void;
}

export const SettingsContext =
  createContext<SettingsContextValue | null>(null);
