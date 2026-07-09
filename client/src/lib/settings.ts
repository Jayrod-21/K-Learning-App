/**
 * Settings — pure I/O for user preferences (profile + notif + languageDisplay).
 *
 * Mirrors `loadSettings` / `saveSettings` from the design handoff
 * (`Claude Design/.../shared.jsx`). Pure: no React, no DOM. The Provider
 * (`hooks/SettingsProvider.tsx`) wires these into context and persists.
 *
 * v2 flatten: the user-changeable paper/correct/wrong palette (and its
 * `paletteVars` inline-CSS projection) was removed — appearance is theme +
 * accent only, both owned by their own providers. A legacy blob's `palette`
 * key is simply dropped by the merge below; the WIRE `palette` field lives
 * on in `services/settings.ts` for server back-compat.
 *
 * Storage shape (`localStorage["km.settings"]`):
 *   JSON-serialised `Settings`. We deep-merge missing keys against
 *   `DEFAULT_SETTINGS` on load so older snapshots stay forward-compatible.
 *
 * Threat model (Pass 2 scope):
 *   - Corrupt JSON  → return DEFAULT, never throw.
 *   - Missing keys  → deep-merge so partial blobs upgrade cleanly.
 *   - Quota / DOMException on write → swallow with a `console.warn`; the
 *     in-memory state is the source of truth for the session.
 *   - Cross-tab race (two tabs writing settings) — NOT addressed here;
 *     see Pass 9 (storage event listener + last-writer-wins or merge).
 *
 * Out of scope: encryption (settings hold no secrets), schema versioning
 * (no breaking shape change yet), server sync (Pass 9 alongside auth).
 */

import type {
  BilingualLanguage,
  LanguageDisplayMode,
  LanguageDisplayPrefs,
} from '../types/domain';

/** localStorage key. Stable across releases — bump only on shape break. */
export const SETTINGS_STORAGE_KEY = 'km.settings';

// ─── Language display (Overhaul P3a) ────────────────────────────────────
// Bounds mirror the server's LanguageDisplayPrefsSchema exactly — the client
// clamps BEFORE persisting so a PUT can never carry an out-of-range subScale
// (which the server would 400).

export const LANG_SUB_SCALE_MIN = 0.4;
export const LANG_SUB_SCALE_MAX = 1.0;
export const LANG_SUB_SCALE_DEFAULT = 0.7;

/** CSS custom property (on `<html>`) the sub text sizes itself from —
 *  `.km-bilingual__sub { font-size: calc(1em * var(--lang-sub-scale)) }`. */
export const LANG_SUB_SCALE_CSS_VAR = '--lang-sub-scale';

/** Clamp an arbitrary value into the legal subScale range. Non-numeric /
 *  non-finite input falls back to the default rather than NaN-poisoning the
 *  CSS var. */
export function clampSubScale(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return LANG_SUB_SCALE_DEFAULT;
  }
  return Math.min(LANG_SUB_SCALE_MAX, Math.max(LANG_SUB_SCALE_MIN, v));
}

const LANGUAGE_DISPLAY_MODES: ReadonlyArray<LanguageDisplayMode> = [
  'en',
  'ko',
  'both',
];
const BILINGUAL_LANGUAGES: ReadonlyArray<BilingualLanguage> = ['en', 'ko'];

function isLanguageDisplayMode(v: unknown): v is LanguageDisplayMode {
  return LANGUAGE_DISPLAY_MODES.includes(v as LanguageDisplayMode);
}

function isBilingualLanguage(v: unknown): v is BilingualLanguage {
  return BILINGUAL_LANGUAGES.includes(v as BilingualLanguage);
}

export interface NotifChannelSettings {
  email: boolean;
  sms: boolean;
}

export interface NotifSettings {
  channel: NotifChannelSettings;
  reviewsDue: boolean;
  daily: boolean;
  weekly: boolean;
}

export interface Settings {
  name: string;
  email: string;
  phone: string;
  notif: NotifSettings;
  /** Bilingual-chrome rendering (P3a). Typed straight off the domain shape. */
  languageDisplay: LanguageDisplayPrefs;
}

export const DEFAULT_SETTINGS: Settings = {
  name: '',
  email: '',
  phone: '',
  notif: {
    channel: { email: true, sms: false },
    reviewsDue: true,
    daily: false,
    weekly: true,
  },
  // 'both' + Korean-first matches the previously-baked "kr · en" titles
  // exactly, so headings look unchanged at the default. BottomNav is the
  // deliberate exception: its tab labels (formerly English-only) and the
  // hexagon (formerly hardcoded "LEARN") render `compact` — primary-only —
  // so they show Korean at this default. Intended per the P3a spec.
  languageDisplay: {
    mode: 'both',
    primary: 'ko',
    subScale: LANG_SUB_SCALE_DEFAULT,
  },
};

/**
 * Type guard — narrow `unknown` to a JSON object (record).
 * Used to validate every nested branch before we read keys off it.
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pickString(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function pickBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * Merge a parsed JSON blob over `DEFAULT_SETTINGS`. Never throws.
 * Unknown fields on the blob are dropped (we only persist the documented
 * shape, so extras would just bloat the next save) — including the legacy
 * `palette` key from pre-v2 blobs.
 */
function mergeSettings(raw: unknown): Settings {
  if (!isRecord(raw)) return DEFAULT_SETTINGS;
  const notifRaw = isRecord(raw.notif) ? raw.notif : {};
  const channelRaw = isRecord(notifRaw.channel) ? notifRaw.channel : {};
  const langRaw = isRecord(raw.languageDisplay) ? raw.languageDisplay : {};
  return {
    name: pickString(raw.name, DEFAULT_SETTINGS.name),
    email: pickString(raw.email, DEFAULT_SETTINGS.email),
    phone: pickString(raw.phone, DEFAULT_SETTINGS.phone),
    notif: {
      channel: {
        email: pickBool(channelRaw.email, DEFAULT_SETTINGS.notif.channel.email),
        sms: pickBool(channelRaw.sms, DEFAULT_SETTINGS.notif.channel.sms),
      },
      reviewsDue: pickBool(notifRaw.reviewsDue, DEFAULT_SETTINGS.notif.reviewsDue),
      daily: pickBool(notifRaw.daily, DEFAULT_SETTINGS.notif.daily),
      weekly: pickBool(notifRaw.weekly, DEFAULT_SETTINGS.notif.weekly),
    },
    // P3a: a pre-P3a snapshot has no `languageDisplay` at all — every field
    // falls back to the default independently (deep-merge, not all-or-nothing),
    // and subScale additionally clamps so a hand-edited blob can't push the
    // CSS var out of range.
    languageDisplay: {
      mode: isLanguageDisplayMode(langRaw.mode)
        ? langRaw.mode
        : DEFAULT_SETTINGS.languageDisplay.mode,
      primary: isBilingualLanguage(langRaw.primary)
        ? langRaw.primary
        : DEFAULT_SETTINGS.languageDisplay.primary,
      subScale: clampSubScale(
        typeof langRaw.subScale === 'number'
          ? langRaw.subScale
          : DEFAULT_SETTINGS.languageDisplay.subScale,
      ),
    },
  };
}

/**
 * Read settings from `localStorage`. Returns `DEFAULT_SETTINGS` when the
 * key is missing, the JSON is corrupt, or storage is unavailable. Never
 * throws — the caller treats settings as always-present.
 */
export function loadSettings(): Settings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return mergeSettings(JSON.parse(raw) as unknown);
  } catch {
    // Corrupt JSON, storage disabled (private mode), or DOMException.
    // Fall back to defaults — the user can re-pick in Settings.
    return DEFAULT_SETTINGS;
  }
}

/**
 * Persist settings. Swallows quota / DOMException with a warn so the UI
 * never crashes on a doomed write; the in-memory state still applies.
 */
export function saveSettings(s: Settings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(s));
  } catch (err) {
    // Best-effort — the most common cause is QuotaExceededError from a
    // full storage in private mode. Surface so a dev sees it but do not
    // throw: the user keeps their session-local choice.
    console.warn('km.settings: failed to persist settings', err);
  }
}

// v2 flatten: `paletteVars` (the paper/correct/wrong inline-CSS projection)
// was removed with the palette feature. Appearance is theme + accent only —
// both attribute-driven (`data-theme` / `data-accent`), never inline styles.
