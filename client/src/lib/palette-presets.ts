/**
 * Palette presets — ported verbatim from the design handoff
 * (`Claude Design/design_handoff_korean_master/shared.jsx`).
 *
 * Each preset is { name, kr, swatch, vars? }:
 *   - name   English label shown under the swatch
 *   - kr     Korean label shown on the right of the SwatchPicker row
 *   - swatch CSS color string painted on the round chip
 *   - vars   CSS custom-property overrides applied to <html> when picked
 *
 * Keep values verbatim. Do not "tidy" colors — the design moves through hex
 * exactly as listed here; any drift will shift accent tones.
 *
 * Categories:
 *   PAPER_PRESETS — owns the surface (ink-*) + type (paper-*) + line tokens.
 *                   This is the only category that touches surface tokens.
 *   ACCENT_PRESETS — owns vermilion + gold (legacy alias kept for parity).
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
  hanji: {
    name: 'Hanji',
    kr: '한지',
    swatch: '#E8DFC5',
    vars: {
      '--ink': '#E8DFC5',
      '--ink-1': '#F3ECD5',
      '--ink-2': '#F8F2DD',
      '--ink-3': '#FBF6E6',
      '--paper': '#1B1813',
      '--paper-dim': '#4A4036',
      '--paper-mute': '#7C7058',
      '--paper-faint': '#A89B7E',
      '--line': 'rgba(27,24,19,0.10)',
      '--line-strong': 'rgba(27,24,19,0.22)',
    },
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

export const ACCENT_PRESETS: PresetMap = {
  vermilion: {
    name: 'Vermilion',
    kr: '단청',
    swatch: '#B83A2E',
    vars: {
      '--vermilion': '#B83A2E',
      '--vermilion-soft': 'rgba(184,58,46,0.10)',
      '--gold': '#B83A2E',
      '--gold-light': '#C8503F',
      '--gold-soft': 'rgba(184,58,46,0.10)',
    },
  },
  indigo: {
    name: 'Indigo',
    kr: '청',
    swatch: '#2E4F70',
    vars: {
      '--vermilion': '#2E4F70',
      '--vermilion-soft': 'rgba(46,79,112,0.10)',
      '--gold': '#2E4F70',
      '--gold-light': '#4A6F95',
      '--gold-soft': 'rgba(46,79,112,0.10)',
    },
  },
  plum: {
    name: 'Plum',
    kr: '자주',
    swatch: '#7B3358',
    vars: {
      '--vermilion': '#7B3358',
      '--vermilion-soft': 'rgba(123,51,88,0.10)',
      '--gold': '#7B3358',
      '--gold-light': '#9A4A72',
      '--gold-soft': 'rgba(123,51,88,0.10)',
    },
  },
  ochre: {
    name: 'Ochre',
    kr: '황토',
    swatch: '#B07A1F',
    vars: {
      '--vermilion': '#B07A1F',
      '--vermilion-soft': 'rgba(176,122,31,0.10)',
      '--gold': '#B07A1F',
      '--gold-light': '#C8923C',
      '--gold-soft': 'rgba(176,122,31,0.10)',
    },
  },
};

export const CORRECT_PRESETS: PresetMap = {
  moss: {
    name: 'Moss',
    kr: '이끼',
    swatch: '#5C7548',
    vars: {
      '--moss': '#5C7548',
      '--moss-soft': 'rgba(92,117,72,0.10)',
      '--green': '#5C7548',
      '--green-light': '#6F8B5A',
    },
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
  vermilion: {
    name: 'Vermilion',
    kr: '단청',
    swatch: '#B83A2E',
    vars: {
      '--danger': '#B83A2E',
      '--danger-soft': 'rgba(184,58,46,0.10)',
    },
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
