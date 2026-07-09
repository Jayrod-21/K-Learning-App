/**
 * Palette presets — originally ported from the design handoff
 * (`Claude Design/design_handoff_korean_master/shared.jsx`), amended by the
 * Seoul Neon redesign.
 *
 * Each preset is { name, kr, swatch, vars? }:
 *   - name   English label shown under the swatch
 *   - kr     Korean label shown on the right of the SwatchPicker row
 *   - swatch CSS color string painted on the round chip
 *   - vars   CSS custom-property overrides applied to <html> when picked
 *
 * Seoul Neon redesign notes:
 *   - The DEFAULT preset in each category (hanji / moss / vermilion-wrong)
 *     declares NO `vars`: default users render the theme-aware token blocks
 *     in index.css untouched. An inline default projection would beat both
 *     `[data-theme]` and `[data-accent]` in the cascade and freeze the app
 *     to a single theme-blind palette.
 *   - ACCENT_PRESETS no longer project at all (see `paletteVars`); the
 *     accent is a runtime `data-accent` choice (AccentProvider +
 *     `lib/accent-presets.ts`). The map survives only for the stored/synced
 *     `palette.accent` id's server-schema parity.
 *   - The remaining non-default `vars` are legacy hanji-era hexes — they
 *     still apply as explicit user overrides but predate the redesign;
 *     re-tinting them onto the Seoul palette is a PR2 follow-up.
 *
 * Categories:
 *   PAPER_PRESETS — owns the surface (ink-*) + type (paper-*) + line tokens.
 *                   This is the only category that touches surface tokens.
 *   ACCENT_PRESETS — legacy ids only (not projected; see above).
 *   CORRECT_PRESETS — owns moss + green (legacy alias for parity).
 *   WRONG_PRESETS — owns danger + danger-soft.
 */

export interface Preset {
  readonly name: string;
  readonly kr: string;
  readonly swatch: string;
  readonly vars?: Readonly<Record<string, string>>;
}

export type PresetMap = Readonly<Record<string, Preset>>;

export const PAPER_PRESETS: PresetMap = {
  // Default — no vars: surfaces come from the theme-aware token blocks in
  // index.css (daylight light / neon-night dark). Swatch shows the light bg.
  hanji: {
    name: 'Hanji',
    kr: '한지',
    swatch: '#E7ECF5',
  },
  ivory: {
    name: 'Ivory',
    kr: '상아',
    swatch: '#EFEAD9',
    vars: {
      '--ink': '#EFEAD9',
      '--ink-1': '#F7F2E3',
      '--ink-2': '#FBF7EA',
      '--ink-3': '#FFFDF3',
      '--paper': '#1B1813',
      '--paper-dim': '#4A4036',
      '--paper-mute': '#7C7058',
      '--paper-faint': '#A89B7E',
      '--line': 'rgba(27,24,19,0.10)',
      '--line-strong': 'rgba(27,24,19,0.22)',
    },
  },
  linen: {
    name: 'Linen',
    kr: '아마',
    swatch: '#E2D9C2',
    vars: {
      '--ink': '#E2D9C2',
      '--ink-1': '#ECE3CC',
      '--ink-2': '#F1E9D5',
      '--ink-3': '#F6EFDD',
      '--paper': '#1B1813',
      '--paper-dim': '#4A4036',
      '--paper-mute': '#7C7058',
      '--paper-faint': '#A89B7E',
      '--line': 'rgba(27,24,19,0.10)',
      '--line-strong': 'rgba(27,24,19,0.22)',
    },
  },
  sumi: {
    name: 'Sumi',
    kr: '먹',
    swatch: '#1E1812',
    vars: {
      '--ink': '#15110D',
      '--ink-1': '#1E1812',
      '--ink-2': '#28211A',
      '--ink-3': '#322A22',
      '--paper': '#EFE7D0',
      '--paper-dim': '#C7BCA3',
      '--paper-mute': '#8C8270',
      '--paper-faint': '#665E4E',
      '--line': 'rgba(239,231,208,0.08)',
      '--line-strong': 'rgba(239,231,208,0.18)',
    },
  },
};

/**
 * LEGACY — superseded by the runtime accent picker (Redesign §14a).
 *
 * These ids survive only because the stored settings blob and the server
 * `/settings/prefs` PrefsSchema (`AccentPreset` enum) still carry a
 * `palette.accent` field. No `vars`: the accent is never inline-projected
 * anymore — `AccentProvider` + the `[data-accent]` CSS blocks own it (see
 * `lib/accent-presets.ts` for the picker's presets).
 */
export const ACCENT_PRESETS: PresetMap = {
  vermilion: { name: 'Vermilion', kr: '단청', swatch: '#B83A2E' },
  indigo: { name: 'Indigo', kr: '청', swatch: '#2E4F70' },
  plum: { name: 'Plum', kr: '자주', swatch: '#7B3358' },
  ochre: { name: 'Ochre', kr: '황토', swatch: '#B07A1F' },
};

export const CORRECT_PRESETS: PresetMap = {
  // Default — no vars: --moss reads the theme-aware green from index.css.
  moss: {
    name: 'Moss',
    kr: '이끼',
    swatch: '#12C08A',
  },
  pine: {
    name: 'Pine',
    kr: '소나무',
    swatch: '#2E5B3E',
    vars: {
      '--moss': '#2E5B3E',
      '--moss-soft': 'rgba(46,91,62,0.10)',
      '--green': '#2E5B3E',
      '--green-light': '#4A7558',
    },
  },
  teal: {
    name: 'Teal',
    kr: '청록',
    swatch: '#2E6E66',
    vars: {
      '--moss': '#2E6E66',
      '--moss-soft': 'rgba(46,110,102,0.10)',
      '--green': '#2E6E66',
      '--green-light': '#4A8A82',
    },
  },
};

export const WRONG_PRESETS: PresetMap = {
  // Default — no vars: --danger follows the theme/accent-aware red from
  // index.css (pinned to coral red even under the blue/mint accents).
  vermilion: {
    name: 'Vermilion',
    kr: '단청',
    swatch: '#E11D48',
  },
  amber: {
    name: 'Amber',
    kr: '호박',
    swatch: '#A66A1F',
    vars: {
      '--danger': '#A66A1F',
      '--danger-soft': 'rgba(166,106,31,0.10)',
    },
  },
  slate: {
    name: 'Slate',
    kr: '슬레이트',
    swatch: '#4A4A55',
    vars: {
      '--danger': '#4A4A55',
      '--danger-soft': 'rgba(74,74,85,0.10)',
    },
  },
};
