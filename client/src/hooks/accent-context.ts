/**
 * Accent context object + types. Kept separate from the Provider so the
 * React Refresh rule (`react-refresh/only-export-components`) stays clean
 * across both `AccentProvider.tsx` and `useAccent.ts` — the same split the
 * theme layer uses (`theme-context.ts`).
 */
import { createContext } from 'react';

/**
 * The three Seoul-neon accent presets. Each maps to a `[data-accent="…"]`
 * token block in `styles/index.css` (light + dark values), re-pointing the
 * `--vermilion` family — CTA fill, glow, soft chips — at runtime.
 */
export type Accent = 'coral' | 'blue' | 'mint';

export const ACCENTS: readonly Accent[] = ['coral', 'blue', 'mint'];

/** Default accent — Neon Coral, the palette the base token blocks carry. */
export const DEFAULT_ACCENT: Accent = 'coral';

export function isAccent(v: unknown): v is Accent {
  return ACCENTS.includes(v as Accent);
}

export interface AccentContextValue {
  /** The accent currently applied to `<html data-accent>`. */
  accent: Accent;
  /** Set + persist an accent choice (stores it in `km.accent`). */
  setAccent: (accent: Accent) => void;
}

export const AccentContext = createContext<AccentContextValue | null>(null);
export const ACCENT_STORAGE_KEY = 'km.accent';
