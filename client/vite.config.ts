import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Vite config — mobile-first dev server. The client talks to the API server
 * cross-origin via `VITE_API_URL` (configured in `.env`). The session cookie
 * is `SameSite=Strict; HttpOnly; Secure` (set by the server), and axios is
 * configured with `withCredentials: true`, so the browser sends the cookie
 * back on every authenticated request as long as the API CORS config includes
 * the dev origin in `CLIENT_ORIGIN` and `Access-Control-Allow-Credentials`.
 *
 * No `/api` proxy here — the server mounts routes at `/auth`, `/vocab`, ...
 * directly, not under `/api`. A proxy that rewrites would just hide the real
 * URL shape from devtools without adding anything.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number.parseInt(process.env.PORT ?? '4173', 10),
    host: '0.0.0.0',
  },
});
