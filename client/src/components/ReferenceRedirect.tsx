/**
 * ReferenceRedirect — tab-aware shim for the retired Reference page
 * (Overhaul P1.2: it dissolved into the Review library, decisions D2/D3).
 *
 * The P1.1 library index deep-linked into Reference via
 * `?tab=vocab|dictionary|grammar|lists`; this shim lands each of those old
 * links on the matching `/review/*` route (mapping in
 * `lib/referenceTarget`). Lives in its own file because
 * react-refresh/only-export-components forbids defining a component inside
 * lib/redirects.tsx (which exports non-component values).
 */
import type { JSX } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { referenceTarget } from '../lib/referenceTarget';

export function ReferenceRedirect(): JSX.Element {
  const [params] = useSearchParams();
  return <Navigate to={referenceTarget(params.get('tab'))} replace />;
}
