/**
 * Text-size context object + types (F-025). Kept separate from the Provider
 * so the React Refresh rule (`react-refresh/only-export-components`) stays
 * clean across both `TextSizeProvider.tsx` and `useTextSize.ts` — the same
 * split the accent layer uses (`accent-context.ts`).
 */
import { createContext } from 'react';

/**
 * The three app-wide text sizes. Each maps to a `[data-text-size="…"]` root
 * font-size block in `styles/index.css` (sm=93.75%, md=100%, lg=112.5%), so
 * every rem-derived length in the app scales together. Extensible: adding a
 * size means a new id here, a preset in `lib/text-size-presets.ts`, a CSS
 * block, the `index.html` bootstrap allow-list, and the server enum.
 */
export type TextSize = 'sm' | 'md' | 'lg';

export const TEXT_SIZES: readonly TextSize[] = ['sm', 'md', 'lg'];

/** Default size — Medium, the 16px root the app has always rendered at.
 *  Deliberately NOT 'sm': shipping F-025 must not shrink the app for
 *  everyone; Small is an opt-in choice. */
export const DEFAULT_TEXT_SIZE: TextSize = 'md';

export function isTextSize(v: unknown): v is TextSize {
  return TEXT_SIZES.includes(v as TextSize);
}

export interface TextSizeContextValue {
  /** The size currently applied to `<html data-text-size>`. */
  textSize: TextSize;
  /** Set + persist a size choice (stores it in `km.textSize`). */
  setTextSize: (size: TextSize) => void;
}

export const TextSizeContext = createContext<TextSizeContextValue | null>(
  null,
);
export const TEXT_SIZE_STORAGE_KEY = 'km.textSize';
