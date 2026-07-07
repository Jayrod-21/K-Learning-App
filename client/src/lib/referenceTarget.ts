/**
 * referenceTarget — maps an old `/reference?tab=…` deep link onto its
 * Review-library home (Overhaul P1.2: the Reference page dissolved into
 * `/review/*`, decisions D2/D3).
 *
 * Its own module (not lib/redirects.tsx) so the ReferenceRedirect component
 * can import it without an import cycle — redirects.tsx imports that
 * component to build the shim route table.
 */
export function referenceTarget(tab: string | null): string {
  switch (tab) {
    case 'dictionary':
      return '/review/dictionary';
    case 'grammar':
      return '/review/grammar';
    case 'lists':
      // The unified My-Lists surface is the lists view of /review/vocab.
      return '/review/vocab?tab=lists';
    default:
      // Unknown/absent tabs fall back to the vocabulary page — the param
      // was always a hint, not a contract.
      return '/review/vocab';
  }
}
