/**
 * clearLocalCaches — Phase 2.9 client cache-bleed fix.
 *
 * FINDING (RECON_schema.md, MED): `localStorage` keys are GLOBAL — not
 * user-scoped — and `AuthProvider.logout()` never cleared them (confirmed by
 * the pre-fix `App.logout.test.tsx`, which only asserted the in-memory React
 * state flipped to guest + a re-probe of `/auth/me`). On a SHARED browser,
 * user B signing in right after user A logs out inherits A's cached prefs
 * (theme, accent, text size, tour-seen state, notif/settings blob, grammar
 * drill cursor, install-dismissed) until each one happens to be overwritten.
 * No SECRETS are involved — the session itself is an HttpOnly cookie, never
 * touched by JS — but it is real cross-user state bleed on a shared device.
 *
 * DECISION (documented per the brief): clear-on-logout, NOT per-user
 * namespacing. Namespacing every `km.*` key by user id would also work, but
 * it's more surface (every reader/writer of every key would need to learn
 * the current user id, including code that runs before the user is known —
 * e.g. the theme/text-size bootstrap in `client/index.html`, which cannot
 * import this module) for a payoff no current requirement asks for
 * (multi-account SWITCHING on one device isn't a supported flow — Phase 2 is
 * single-account-per-browser-session). Clearing on logout is simpler and
 * correct for that shape: every `km.*` value re-fetches from the server (or
 * re-defaults) on the next login, which is cheap (a handful of small GETs)
 * against a case that only matters right after a sign-out.
 *
 * SCOPE: every key here is a genuinely PER-USER preference — confirmed by
 * the recon (RECON_schema.md) — so clearing the lot is correct, with ONE
 * deliberate exception: `km.install-dismissed` (PWA "Add to Home Screen"
 * banner dismissal) is DEVICE-scoped, not user-scoped — whether THIS BROWSER
 * has already been asked to install the app has nothing to do with who is
 * signed into it, and re-showing the install banner to user B purely because
 * user A logged out would be a regression for a decision the device already
 * made. It is deliberately excluded from the clear.
 *
 * An explicit allow-list (not a `km.` prefix scan) is used on purpose: a
 * prefix scan would also sweep any FUTURE device-scoped `km.*` key added
 * without updating this file, silently reintroducing the exact
 * "should this survive a user switch?" judgment call this module exists to
 * make explicitly, once, in one place.
 */

/**
 * Every known per-user `km.*` localStorage key, cleared on logout / session
 * loss. Keep this list in sync with every `km.*` key added elsewhere in the
 * client — see the module header for the (deliberate) exception,
 * `km.install-dismissed`.
 *
 * Sources (kept as literals, not imports, so this module has zero
 * dependencies on the context modules that own each key — a plain util any
 * auth path can call without pulling in React providers):
 *   - `km.settings`            — client/src/lib/settings.ts (SETTINGS_STORAGE_KEY)
 *   - `km.toursSeen`           — client/src/hooks/tour-context.ts (TOURS_SEEN_STORAGE_KEY)
 *   - `km.theme`               — client/src/hooks/theme-context.ts (THEME_STORAGE_KEY)
 *   - `km.accent`              — client/src/hooks/accent-context.ts (ACCENT_STORAGE_KEY)
 *   - `km.textSize`            — client/src/hooks/text-size-context.ts (TEXT_SIZE_STORAGE_KEY)
 *   - `km.grammar.drillCursor` — client/src/pages/Grammar.tsx (DRILL_CURSOR_STORAGE_KEY)
 */
const USER_SCOPED_KEYS: readonly string[] = [
  'km.settings',
  'km.toursSeen',
  'km.theme',
  'km.accent',
  'km.textSize',
  'km.grammar.drillCursor',
];

/**
 * Remove every per-user `km.*` cache key. Best-effort — wrapped in a single
 * try/catch (not per-key) since a `localStorage` failure here is uniformly
 * "storage is unavailable/blocked" (private mode, quota, a hardened browser
 * setting) and every key would fail the same way; one warn is enough
 * signal without spamming the console per key. Never throws — callers
 * (logout, the 401 session-lost path) must be able to call this
 * unconditionally without a guard.
 */
export function clearLocalCaches(): void {
  if (typeof window === 'undefined') return;
  try {
    for (const key of USER_SCOPED_KEYS) {
      window.localStorage.removeItem(key);
    }
  } catch (err) {
    console.warn('clearLocalCaches: failed to clear km.* localStorage keys', err);
  }
}
