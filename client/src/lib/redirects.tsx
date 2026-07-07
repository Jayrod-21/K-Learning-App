/**
 * Legacy redirect shims (Overhaul P1.1/P1.2) — old paths → new namespaced
 * paths, so pre-overhaul links, bookmarks, and any missed call site keep
 * working after the /learn + /review re-home.
 *
 * Data + a route factory rather than inline JSX in App.tsx so the table is
 * testable on its own (the test mounts exactly these Route elements) and
 * greppable in one place.
 *
 * Notes:
 *   - `from` paths are RELATIVE (no leading `/`) because they render nested
 *     under the Shell layout route in App.tsx alongside the real screens.
 *   - `/reading` predates the overhaul (it redirected to `/ttmik` when the
 *     Read screen was retired); it now points at the same content's new
 *     home, `/learn/listen`. The NEW Reading placeholder lives at
 *     `/learn/reading` — never reuse `/reading` for it.
 *   - `/reference` (P1.2): the Reference page dissolved into the Review
 *     library. Its shim is TAB-AWARE — the P1.1 library index linked into
 *     it via `?tab=vocab|dictionary|grammar|lists`, so each old deep link
 *     lands on the matching library route (see `referenceTarget`). The
 *     table's `to` is the tab-less fallback.
 *   - There is deliberately NO `/review` shim: `/review` is a live route
 *     again (the library index). The old flashcards intent moved to
 *     `/learn/vocab`.
 *   - `/chat` never appears here — it never moves (hard contract).
 */
import type { JSX } from 'react';
import { Navigate, Route } from 'react-router-dom';
import { ReferenceRedirect } from '../components/ReferenceRedirect';

export interface LegacyRedirect {
  /** Old path, relative to the Shell layout route (no leading slash). */
  readonly from: string;
  /** New absolute path. */
  readonly to: string;
}

export const LEGACY_REDIRECTS: ReadonlyArray<LegacyRedirect> = [
  { from: 'topik', to: '/learn/topik' },
  { from: 'ttmik', to: '/learn/listen' },
  { from: 'reading', to: '/learn/listen' },
  { from: 'grammar', to: '/learn/grammar' },
  { from: 'writing', to: '/learn/writing' },
  { from: 'hanja', to: '/learn/hanja' },
  { from: 'mistakes', to: '/review/mistakes' },
  // Tab-less fallback; the mounted element is the tab-aware
  // <ReferenceRedirect/> below.
  { from: 'reference', to: '/review/vocab' },
];

/**
 * Build the `<Route>` elements for the shim table. Returned as a plain
 * array (not a component) because `<Routes>` only accepts `<Route>`
 * children — a wrapper component would break route matching.
 */
export function legacyRedirectRoutes(): ReadonlyArray<JSX.Element> {
  return LEGACY_REDIRECTS.map((r) => (
    <Route
      key={r.from}
      path={r.from}
      element={
        r.from === 'reference' ? (
          <ReferenceRedirect />
        ) : (
          <Navigate to={r.to} replace />
        )
      }
    />
  ));
}
