/**
 * `useToast` — read the toast context. Throws if used outside
 * `<ToastProvider/>` (mirrors `useTheme`'s missing-provider guard).
 *
 * Usage:
 *   const { toast, dismiss } = useToast();
 *   toast({ message: 'Saved on this device, sync will retry.', tone: 'info' });
 *   const id = toast({ message: 'Save failed.', action: { label: 'Retry', onClick: retry } });
 *   dismiss(id);
 */
import { useContext } from 'react';
import { ToastContext, type ToastContextValue } from './toast-context';

export type {
  ToastTone,
  ToastAction,
  ToastOptions,
  ToastContextValue,
} from './toast-context';

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used inside <ToastProvider>');
  }
  return ctx;
}
