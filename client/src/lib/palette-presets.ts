/**
 * Preset shape shared by the swatch pickers.
 *
 * v2 flatten (Seoul Neon corrections): the user-changeable paper / correct /
 * wrong palette categories were REMOVED — the only appearance choices are
 * the light/dark theme (ThemeProvider) and the accent (AccentProvider +
 * `lib/accent-presets.ts`). Surfaces, type, success green (`--moss`) and
 * danger red (`--danger`) are fixed theme tokens in `styles/index.css` now;
 * nothing inline-projects them anymore.
 *
 * What survives here is only the `Preset` / `PresetMap` shape that the
 * remaining picker (`components/SwatchPicker.tsx` rendering
 * `ACCENT_OPTIONS`) consumes:
 *   - name   English label shown under the swatch
 *   - kr     Korean label shown on the right of the SwatchPicker row
 *   - swatch CSS color string painted on the round chip
 *   - vars   legacy field — no live preset declares it; kept optional so
 *            the type stays source-compatible with stored blobs' shape.
 *
 * The legacy preset IDS (`hanji`/`moss`/`vermilion`/…) still exist on the
 * WIRE: the server `/settings/prefs` PrefsSchema keeps its `palette` field
 * for back-compat with stored blobs. The client simply echoes the stored
 * palette back on PUT (see `pages/Settings.tsx`) and never renders or
 * projects it.
 */

export interface Preset {
  readonly name: string;
  readonly kr: string;
  readonly swatch: string;
  readonly vars?: Readonly<Record<string, string>>;
}

export type PresetMap = Readonly<Record<string, Preset>>;
