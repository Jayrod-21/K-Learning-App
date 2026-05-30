/**
 * `useAuth` — read the auth context.
 *
 * Throws if used outside `<AuthProvider/>` (a render-time error is louder
 * and earlier than a silent undefined).
 */
import { useContext } from 'react';
import { AuthContext, type AuthContextValue } from './auth-context';

export type { User, AuthStatus, AuthContextValue } from './auth-context';

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}
