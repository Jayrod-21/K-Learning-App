/**
 * Accent presets — the three Seoul-neon accents offered by the Settings
 * "Accent" picker (Redesign §14a).
 *
 * Unlike the palette presets these carry NO `vars` map: the accent is not
 * projected as inline styles. `AccentProvider` stamps
 * `data-accent="coral|blue|mint"` on `<html>` and the `[data-accent]`
 * token blocks in `styles/index.css` own the actual values (light + dark
 * per accent), so the swatch here is purely the chip color shown in the
 * picker (the decorative *bright* tone of each accent).
 *
 * Keyed by the `Accent` union — ids must stay in lockstep with
 * `hooks/accent-context.ts` and the CSS blocks.
 */
import type { Accent } from '../hooks/accent-context';
import type { Preset } from './palette-presets';

export const ACCENT_OPTIONS: Readonly<Record<Accent, Preset>> = {
  coral: { name: 'Neon Coral', kr: '네온 코랄', swatch: '#FF3E6C' },
  blue: { name: 'Cyber Blue', kr: '사이버 블루', swatch: '#4F7BFF' },
  mint: { name: 'Han Mint', kr: '한 민트', swatch: '#10C79A' },
};
