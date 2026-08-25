/**
 * clearLocalCaches — Phase 2.9 client cache-bleed fix.
 *
 * FINDING (RECON_schema.md, MED): `localStorage` keys are GLOBAL — not
 * user-scoped — and `AuthProvider.logout()` never cleared them (confirmed by
 * the pre-fix `App.logout.test.tsx`, which only asserted the in-memory React
 * state flipped to guest + a re-probe of `/auth/me`). On a SHARED browser,
 * user B signing in right after user A logs out inherits A's cached prefs
 * (theme, accent, text size, tour-seen state, notif/settings blob, grammar
 * drill cursor, chat sidebar state) until each one happens to be overwritten.
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
 * WHY A PREFIX SCAN + KEEP-LIST, NOT AN ENUMERATED ALLOW-LIST: this is a
 * bleed-PREVENTION control, so it must fail in the safe direction. An
 * enumerated allow-list of per-user keys fails UNSAFE — a `km.*` key added
 * elsewhere without updating this file keeps bleeding across users, silently
 * (this is exactly how the first pass missed `km.chat.sidebar-collapsed`).
 * Clearing EVERY `km.*` key except an explicit KEEP-list inverts that: a
 * new key that nobody classified is CLEARED by default (worst case a cheap
 * re-fetch/re-default on next login), never retained. The only keys that
 * must survive a user switch are genuinely DEVICE-scoped, and those are the
 * small, deliberate KEEP-list below — the "should this survive a user
 * switch?" judgment is still made explicitly, once, but now only the unusual
 * (device-scoped) answer needs an entry, and forgetting one is safe.
 *
 * The `km.` prefix is the app's own namespace (every app-owned key uses it —
 * see settings.ts, the theme/accent/text-size/tour contexts, Grammar.tsx,
 * Chat.tsx), so scanning it never touches another library's or origin's keys.
 */

/** localStorage key prefix owned by this app. */
const KM_PREFIX = 'km.';

/**
 * The ONLY `km.*` keys that must SURVIVE a user switch — genuinely
 * DEVICE-scoped, not user-scoped. Everything else under `km.` is cleared.
 *
 *   - `km.install-dismissed` — client/src/components/InstallPrompt.tsx: whether
 *     THIS BROWSER already dismissed the PWA "Add to Home Screen" banner. A
 *     property of the device, not of who is signed in — re-prompting user B to
 *     install purely because user A logged out would be a regression for a
 *     decision the device already made.
 *
 * Keep this list MINIMAL: only add a key here if it is truly device-scoped.
 * When in doubt, leave it out — it will simply be cleared (safe).
 */
const DEVICE_SCOPED_KEEP: ReadonlySet<string> = new Set<string>([
  'km.install-dismissed',
]);

/**
 * Remove every per-user `km.*` cache key (the whole `km.` namespace except the
 * device-scoped KEEP-list). Best-effort — wrapped in a single try/catch (not
 * per-key) since a `localStorage` failure here is uniformly "storage is
 * unavailable/blocked" (private mode, quota, a hardened browser setting) and
 * every access would fail the same way; one warn is enough signal without
 * spamming the console. Never throws — callers (logout, the 401 session-lost
 * path) must be able to call this unconditionally without a guard.
 */
export function clearLocalCaches(): void {
  if (typeof window === 'undefined') return;
  try {
    const store = window.localStorage;
    // Collect first, then remove — removing during the index walk shifts the
    // remaining indices and would skip keys.
    const toRemove: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key !== null && key.startsWith(KM_PREFIX) && !DEVICE_SCOPED_KEEP.has(key)) {
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      store.removeItem(key);
    }
  } catch (err) {
    console.warn('clearLocalCaches: failed to clear km.* localStorage keys', err);
  }
}
