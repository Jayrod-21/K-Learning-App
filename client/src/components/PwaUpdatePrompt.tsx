/**
 * PWA update prompt.
 *
 * With `registerType: 'prompt'` (vite.config.ts) a freshly-deployed service
 * worker installs but WAITS instead of taking over silently. `useRegisterSW`
 * flips `needRefresh` to true when that happens; we render a persistent banner
 * and only call `updateServiceWorker(true)` — which `skipWaiting()`s the new SW
 * and reloads the page onto the fresh bundle — when the user taps Reload.
 *
 * This is what makes a deploy actually reachable: the old 'autoUpdate' config
 * only picked up a new build on the *next* visit, so an open tab kept serving
 * the stale bundle until a manual DevTools cache-clear.
 *
 * Renders nothing until an update is pending, so it is safe to mount at app root.
 */
import { type JSX } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

export function PwaUpdatePrompt(): JSX.Element | null {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div className="km-pwa-update" role="alert">
      <span className="km-pwa-update__text">A new version is available.</span>
      <button
        type="button"
        className="km-pwa-update__btn"
        onClick={() => {
          void updateServiceWorker(true);
        }}
      >
        Reload
      </button>
    </div>
  );
}
