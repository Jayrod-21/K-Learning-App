/**
 * `useTour` — read the tour context. Throws if used outside `<TourProvider/>`
 * (the strict variant — for code that only ever renders under Shell).
 *
 * `useTourOptional` returns null instead: the Settings "Help & tours"
 * controls use it so the (large, provider-free) existing Settings test
 * suite keeps rendering the screen without a tour harness — in production
 * Shell always mounts the provider, so the controls always render.
 */
import { useContext } from 'react';
import { TourContext, type TourContextValue } from './tour-context';

export type { TourContextValue } from './tour-context';

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) {
    throw new Error('useTour must be used inside <TourProvider>');
  }
  return ctx;
}

export function useTourOptional(): TourContextValue | null {
  return useContext(TourContext);
}
