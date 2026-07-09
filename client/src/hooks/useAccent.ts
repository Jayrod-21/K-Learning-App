/**
 * `useAccent` — read the accent context. Throws if used outside
 * `<AccentProvider/>`.
 */
import { useContext } from 'react';
import { AccentContext, type AccentContextValue } from './accent-context';

export type { Accent, AccentContextValue } from './accent-context';

export function useAccent(): AccentContextValue {
  const ctx = useContext(AccentContext);
  if (!ctx) {
    throw new Error('useAccent must be used inside <AccentProvider>');
  }
  return ctx;
}
