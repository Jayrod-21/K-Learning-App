/**
 * `useTextSize` — read the text-size context. Throws if used outside
 * `<TextSizeProvider/>`.
 */
import { useContext } from 'react';
import { TextSizeContext, type TextSizeContextValue } from './text-size-context';

export type { TextSize, TextSizeContextValue } from './text-size-context';

export function useTextSize(): TextSizeContextValue {
  const ctx = useContext(TextSizeContext);
  if (!ctx) {
    throw new Error('useTextSize must be used inside <TextSizeProvider>');
  }
  return ctx;
}
