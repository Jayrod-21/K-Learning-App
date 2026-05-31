/**
 * Toast — one hanji-styled transient notification tile.
 *
 * Presentational only: the lifecycle (auto-dismiss timer, pause-on-hover,
 * stacking) lives in `ToastProvider`. This component renders the card and
 * wires the interaction callbacks the provider hands it.
 *
 * Tone → color + ARIA, mirroring the `ErrorCard` idiom:
 *   - `error`   → vermilion accent + `role="alert"` so AT interrupts.
 *   - `success` → moss accent + `aria-live="polite"`.
 *   - `info`    → ink accent + `aria-live="polite"`.
 *
 * A11y:
 *   - The dismiss `×` is a real, focusable `<button>` with an `aria-label`.
 *   - Hover OR keyboard focus anywhere in the toast pauses the auto-dismiss
 *     countdown (`onMouseEnter`/`onFocus` → pause, `onMouseLeave`/`onBlur` →
 *     resume), so a user reading or tabbing through the toast isn't raced by
 *     the timer.
 *   - The optional action is a real `<button>`; activating it fires the
 *     caller's handler then dismisses (the provider owns the dismiss).
 *
 * Threat model: `message` and `action.label` flow through React text
 * rendering (escaped) and are author-controlled per the `ToastOptions`
 * contract — never raw server strings. Same rule as `ErrorCard`.
 *
 * Motion: the slide/fade-in is a CSS class; the global
 * `prefers-reduced-motion` block collapses its duration to ~0ms, so the
 * toast appears instantly for users who ask for reduced motion.
 */
import type { JSX } from 'react';
import { Icon, type IconName } from './Icon';
import type { ToastRecord, ToastTone } from './toast-context';
import { cn } from '../lib/cn';

const TONE_ICON: Record<ToastTone, IconName> = {
  error: 'info',
  success: 'check',
  info: 'info',
};

const TONE_CLASS: Record<ToastTone, string> = {
  error: 'km-toast--error',
  success: 'km-toast--success',
  info: 'km-toast--info',
};

export interface ToastProps {
  toast: ToastRecord;
  /** Dismiss this toast (the × button + post-action close both call it). */
  onDismiss: (id: string) => void;
  /** Pause the auto-dismiss countdown (hover / focus enters). */
  onPause: (id: string) => void;
  /** Resume the auto-dismiss countdown (hover / focus leaves). */
  onResume: (id: string) => void;
}

export function Toast({
  toast,
  onDismiss,
  onPause,
  onResume,
}: ToastProps): JSX.Element {
  const { id, message, tone, action } = toast;

  // Errors are assertive (`role="alert"` ⇒ implicit aria-live=assertive);
  // success/info are polite. Pinned per-toast so a screen reader interrupts
  // for a failure but waits its turn for a confirmation.
  const isError = tone === 'error';

  return (
    <div
      className={cn('km-toast', TONE_CLASS[tone])}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      // Pause the countdown while the user is reading or interacting — by
      // pointer (hover) or keyboard (focus within). `onFocus`/`onBlur`
      // bubble from the child buttons, so focusing the action or the dismiss
      // ✕ also holds the timer.
      onMouseEnter={() => {
        onPause(id);
      }}
      onMouseLeave={() => {
        onResume(id);
      }}
      onFocus={() => {
        onPause(id);
      }}
      onBlur={() => {
        onResume(id);
      }}
    >
      <span className="km-toast__icon" aria-hidden="true">
        <Icon name={TONE_ICON[tone]} size={16} />
      </span>
      <p className="km-toast__message">{message}</p>
      {action ? (
        <button
          type="button"
          className="km-toast__action focusring"
          onClick={() => {
            action.onClick();
            // One action per toast — dismiss after firing so a stale toast
            // can't re-trigger the same retry.
            onDismiss(id);
          }}
        >
          {action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="km-toast__dismiss focusring"
        aria-label="Dismiss notification"
        onClick={() => {
          onDismiss(id);
        }}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
