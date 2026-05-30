/**
 * `useSettings` — read the settings context.
 *
 * Throws if used outside `<SettingsProvider/>` (loud render-time error
 * beats a silent `undefined`). Mirrors the `useAuth` / `useTheme` shape.
 */
import { useContext } from 'react';
import {
  SettingsContext,
  type SettingsContextValue,
} from './settings-context';

export type { SettingsContextValue, SettingsPatch } from './settings-context';

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error('useSettings must be used inside <SettingsProvider>');
  }
  return ctx;
}
