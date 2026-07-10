/**
 * Text-size presets (F-025) — the three sizes offered by the Settings
 * "Text size" segmented control.
 *
 * Like the accent presets these carry NO style projection: `TextSizeProvider`
 * stamps `data-text-size="sm|md|lg"` on `<html>` and the
 * `:root[data-text-size]` blocks in `styles/index.css` own the actual root
 * font-size values. The `scale` here is DOCUMENTATION of that CSS contract
 * (and the source for the picker's hint copy) — changing a size means
 * changing the CSS block, this constant, and nothing else.
 *
 * Root font-size mapping (16px browser default):
 *   sm → 93.75%  (15px)
 *   md → 100%    (16px — the size the app has always been)
 *   lg → 112.5%  (18px)
 *
 * Keyed by the `TextSize` union — ids must stay in lockstep with
 * `hooks/text-size-context.ts`, the CSS blocks, the `index.html` bootstrap,
 * and the server prefs enum.
 */
import type { TextSize } from '../hooks/text-size-context';

export interface TextSizeOption {
  /** Compact segment label shown in the control ("S" / "M" / "L"). */
  label: string;
  /** English name — the option's accessible name. */
  name: string;
  /** Korean name. */
  kr: string;
  /** Root font-size the matching `:root[data-text-size]` CSS block applies. */
  scale: string;
}

export const TEXT_SIZE_OPTIONS: Readonly<Record<TextSize, TextSizeOption>> = {
  sm: { label: 'S', name: 'Small', kr: '작게', scale: '93.75%' },
  md: { label: 'M', name: 'Medium', kr: '보통', scale: '100%' },
  lg: { label: 'L', name: 'Large', kr: '크게', scale: '112.5%' },
};
