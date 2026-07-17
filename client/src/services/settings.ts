/**
 * /settings/prefs — fetch + persist the user's app preferences (notif + palette).
 *
 * The profile half of Settings (name / email / phone) lives in its own columns
 * and is served by `/auth/me` (see `services/auth.ts`). This module covers ONLY
 * the preference half: the `users.preferences` JSONB blob, validated server-side
 * against the same `notif` + `palette` shape mirrored in `types/domain.ts`.
 *
 * Wire contract (Pass 9, locked):
 *   - `GET  /settings/prefs` → `200 { notif, palette }`. The server falls back
 *     to its DEFAULT_PREFS when the stored blob is empty or corrupt, so a
 *     successful GET always carries a fully-shaped `Prefs`.
 *   - `PUT  /settings/prefs` → body is the FULL `Prefs` object (last-writer-wins,
 *     no version gate); responds `200 { notif, palette }` echoing what was stored.
 *
 * Threat model (file-scope, in addition to `services/api.ts`):
 *   - CSRF: PUT is state-changing; defended by the session cookie's
 *     `SameSite=Strict` posture (see api.ts). If the cookie ever relaxes to
 *     `Lax`, add a CSRF token at the api layer, not here.
 *   - Input validation: the server Zod-validates the body (`.strict()`), so a
 *     bad enum or unknown key 400s at the boundary. The client trusts its TS
 *     types at the call site — no client-side `z.parse` (Pass 3 contract).
 *   - Failure containment: callers (the Settings screen) treat a failed PUT as
 *     non-fatal — localStorage already holds the change, so a network blip never
 *     loses the user's preference. This module simply surfaces `ApiError`.
 */
import { api } from './api';
import type {
  LanguageDisplayPrefs,
  NotifPrefs,
  PalettePrefs,
  TextSizePreset,
  ToursSeen,
} from '../types/domain';

/**
 * Preference blob persisted to `users.preferences`. Reuses the domain's
 * `NotifPrefs` / `PalettePrefs` / `LanguageDisplayPrefs` so the wire shape and
 * the in-app Settings shape stay in lockstep — the server's `PrefsSchema`
 * mirrors these exactly.
 *
 * `languageDisplay` is present on every response from a P3a+ server (its Zod
 * schema defaults the field when a pre-P3a stored blob lacks it), but the
 * hydration path still guards with a client-side default in case the client
 * ships ahead of the server during a rolling deploy.
 */
export interface Prefs {
  notif: NotifPrefs;
  /** `paper`/`correct`/`wrong` are WIRE-ONLY since the v2 flatten: those
   *  pickers were removed and nothing renders or projects the ids anymore,
   *  but the server `PrefsSchema` still requires them (back-compat with
   *  stored blobs) — the client echoes the last value the server reported,
   *  or `LEGACY_PALETTE_DEFAULT` before hydration, on every PUT.
   *  `accent` is LIVE again (accent cross-device sync): it carries the
   *  Seoul-neon accent id (`coral|blue|mint`) the AccentProvider stamps as
   *  `data-accent`. The Settings screen adopts the server's accent on
   *  hydration and PUTs the user's picks back — the value is only ever a
   *  `data-accent` attribute, never an inline CSS-var projection. */
  palette: PalettePrefs;
  languageDisplay: LanguageDisplayPrefs;
  /** App-wide text size (F-025) — the id `TextSizeProvider` stamps as
   *  `data-text-size` on `<html>` (root font-size scale). Same two-tier
   *  posture as `palette.accent`: localStorage["km.textSize"] is the
   *  same-device fast path; this field is the cross-device truth. The
   *  server enum `.catch`es a missing/unknown value to 'md', so a pre-F-025
   *  stored blob hydrates cleanly — but a pre-F-025 SERVER mid-rolling-
   *  deploy omits the field on GET, so the hydration path guards with the
   *  local value before adopting. */
  textSize: TextSizePreset;
  /** Guided-tour completion marks (tutorial tour) — same two-tier posture
   *  as `textSize`: localStorage["km.toursSeen"] is the same-device fast
   *  path (owned by `TourProvider`); this field is the cross-device truth.
   *  The server schema defaults/`.catch`es a missing or corrupt stored
   *  value to `[]`, so legacy blobs hydrate cleanly — but a pre-feature
   *  SERVER mid-rolling-deploy omits the field on GET, so readers guard
   *  with `Array.isArray` before adopting. The Settings screen sources this
   *  slice LIVE from `loadSeenTours()` on every PUT (never from its
   *  hydration baseline) so it can't clobber a tour finished after the
   *  screen mounted; `TourProvider` is the only writer that initiates a PUT
   *  *for* this field (read-merge-write). */
  toursSeen: ToursSeen;
}

/**
 * Default palette ids for the wire `palette` field (mirrors the server's
 * DEFAULT_PREFS.palette). Used only to seed the PUT baseline before the first
 * successful GET hydration; after that the client echoes the stored
 * paper/correct/wrong and owns `accent`.
 */
export const LEGACY_PALETTE_DEFAULT: PalettePrefs = {
  paper: 'hanji',
  accent: 'coral',
  correct: 'moss',
  wrong: 'vermilion',
};

/** GET /settings/prefs → the user's stored prefs (or server defaults). */
export async function fetchPrefs(signal?: AbortSignal): Promise<Prefs> {
  return api.get<Prefs>(
    '/settings/prefs',
    signal !== undefined ? { signal } : undefined,
  );
}

/**
 * PUT /settings/prefs → persist the full prefs object and echo what was stored.
 *
 * Last-writer-wins: the whole object is written every time, so a partial update
 * is the caller's responsibility (send the merged object, not a diff).
 */
export async function putPrefs(
  prefs: Prefs,
  signal?: AbortSignal,
): Promise<Prefs> {
  return api.put<Prefs>(
    '/settings/prefs',
    prefs,
    signal !== undefined ? { signal } : undefined,
  );
}
