/**
 * InstallPrompt — dismissible "Add to Home Screen" banner (Pass Final B3).
 *
 * Browsers that meet the install criteria fire a `beforeinstallprompt` event
 * (Chrome/Edge/Android) instead of showing native install UI. We intercept it,
 * call `preventDefault()` to suppress the browser's mini-infobar, stash the
 * event, and surface our own hanji-styled banner. Tapping Install replays the
 * stashed event's `prompt()` to show the real OS install dialog.
 *
 * The banner self-hides when:
 *   - the app is already installed / running standalone
 *     (`display-mode: standalone`, or iOS `navigator.standalone`),
 *   - the user previously dismissed it (`localStorage['km.install-dismissed']`),
 *   - or the browser never fires `beforeinstallprompt` (iOS Safari, Firefox) —
 *     in which case there is simply nothing to render. (A future iOS "tap Share
 *     → Add to Home Screen" hint is intentionally out of scope per the spec.)
 *
 * a11y: rendered as an `aria-label`led `<section>` (a labelled landmark, not a
 * modal) — it does NOT trap focus, so it never blocks the user from the app.
 * Install + Dismiss are real, focusable `<button>`s (via the shared Button).
 *
 * Mounted once at App root (see App.tsx). It renders nothing until/unless an
 * install opportunity exists, so the mount is effectively free.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { Button } from './Button';

/** localStorage key — namespaced like the app's other prefs (km.*). */
const DISMISS_KEY = 'km.install-dismissed';

/**
 * The `beforeinstallprompt` event is not in the DOM lib typings. Model the one
 * member we use plus the `userChoice` promise for completeness.
 */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms?: readonly string[];
  readonly userChoice?: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
  prompt: () => Promise<void>;
}

/** True when the app is already running as an installed PWA. */
function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const mql =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(display-mode: standalone)')
      : null;
  // `navigator.standalone` is the iOS Safari equivalent (non-standard).
  const iosStandalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return Boolean(mql?.matches) || iosStandalone;
}

/** True when the user has already dismissed the banner. Storage-safe. */
function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    // localStorage can throw in privacy mode; treat as "not dismissed" so the
    // banner can still appear, and the dismiss write below will no-op safely.
    return false;
  }
}

export function InstallPrompt(): JSX.Element | null {
  // The stashed event; presence of a value is what makes the banner eligible.
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null,
  );
  // Start hidden if already installed or previously dismissed — these are
  // evaluated once on mount and never re-open the banner on their own.
  const [hidden, setHidden] = useState<boolean>(
    () => isStandalone() || wasDismissed(),
  );

  useEffect(() => {
    if (hidden) return;

    const onBeforeInstallPrompt = (event: Event): void => {
      // Suppress the browser's default mini-infobar; we present our own UI.
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };

    // If the user installs via the browser's own menu while our banner is up,
    // tear it down so it never lingers post-install.
    const onAppInstalled = (): void => {
      setDeferred(null);
      setHidden(true);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, [hidden]);

  const persistDismiss = useCallback((): void => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Best-effort: if storage is unavailable the banner simply reappears on a
      // future visit. Hiding it for this session below still works.
    }
  }, []);

  const handleDismiss = useCallback((): void => {
    persistDismiss();
    setHidden(true);
    setDeferred(null);
  }, [persistDismiss]);

  const handleInstall = useCallback(async (): Promise<void> => {
    const event = deferred;
    if (!event) return;
    // The native prompt can only be shown once per captured event; drop our
    // reference up front so a double-tap can't call prompt() twice.
    setDeferred(null);
    try {
      await event.prompt();
      // Whatever the user chose, don't nag again — accepted installs obviously
      // shouldn't re-prompt, and an explicit "not now" deserves the same quiet.
      await event.userChoice?.catch(() => undefined);
    } catch {
      // prompt() can reject (e.g. event already consumed). Swallow — the worst
      // case is the banner closes without an install, which is acceptable.
    } finally {
      persistDismiss();
      setHidden(true);
    }
  }, [deferred, persistDismiss]);

  // Nothing to install (no event) or explicitly hidden → render nothing.
  if (hidden || !deferred) return null;

  return (
    <section
      className="km-install"
      aria-label="앱 설치 (Install Korean Master)"
    >
      <div className="km-install__body">
        <p className="km-install__title">한국어 마스터 설치</p>
        <p className="km-install__text">
          Add Korean Master to your home screen for full-screen, offline-ready
          study.
        </p>
      </div>
      <div className="km-install__actions">
        <Button variant="ghost" size="sm" onClick={handleDismiss}>
          Dismiss
        </Button>
        <Button
          variant="gold"
          size="sm"
          onClick={() => {
            void handleInstall();
          }}
        >
          Install
        </Button>
      </div>
    </section>
  );
}
