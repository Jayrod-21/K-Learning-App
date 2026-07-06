# Fix report — PWA auto-update (prompt + reload banner)

Review: `REVIEW_PWA_UPDATE.md` — **Approve, 0 BLOCKERs**, 1 SHOULD-FIX, 3 NITs.

| Finding | Sev | Disposition |
|---|---|---|
| `.km-pwa-update` (z-index 60) and the existing `.km-install` banner (z-index 79) sit at nearly the same fixed offset → the install banner would cover the reload prompt if both show | SHOULD-FIX | **FIXED** — the update banner now uses the same offset convention as `.km-install` (`--shell-bottomnav-h + 12px + safe-area`), `--shell-max-width` width, and **z-index 80 (> 79)** so the reload prompt is always ON TOP / never covered. `--ink-3` (highest surface) keeps it visually distinct from the install banner behind it. `index.css`. |
| Dangling `REVIEW_PF_pwa SF-1` doc reference | NIT | **FIXED** — removed from the `vite.config.ts` comment. |
| `updateServiceWorker(true)`'s boolean arg is inert in vite-plugin-pwa@1.3 (reload comes from an internal `controlling` listener) | NIT | **KEPT** — it's the documented, forward-compatible call; the reload still happens (skipWaiting → controlling → reload), and the arg is harmless. |
| `role="alert"` vs `role="status"` | NIT | **KEPT** — the banner is an actionable notification with a Reload button; `alert` is defensible. |

## Verification
- Lint clean, `tsc` clean, PWA test 2/2, production `vite build` OK (generates `sw.js` with `SKIP_WAITING` listener, no auto-skipWaiting — matches `registerType: 'prompt'`).
- 0 BLOCKERs remained; the single SHOULD-FIX resolved.
