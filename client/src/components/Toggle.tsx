/**
 * Toggle — 38×22 iOS-style switch.
 *
 * Moss-green track when on, neutral track when off; cream thumb either way.
 * Used for notif preferences and the Conversation screen's "Show EN hints".
 *
 * A11y:
 *   - `role="switch"` + `aria-checked` per WAI-ARIA. Screen readers
 *     announce as "switch, on / off".
 *   - `aria-label` is required — the visible label sits next to the
 *     switch in Settings, but the switch itself needs a name for AT.
 *   - Keyboard: Space + Enter toggle (the native `<button>` semantics
 *     handle this; we don't add an extra handler).
 *
 * No I/O — no threat model.
 */
import { type ButtonHTMLAttributes, type JSX } from 'react';
import { cn } from '../lib/cn';

export interface ToggleProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'type'> {
  /** Switch state. */
  checked: boolean;
  /** Fires with the next checked state. */
  onChange: (next: boolean) => void;
  /** Accessible name for the switch. */
  ariaLabel: string;
}

export function Toggle({
  checked,
  onChange,
  ariaLabel,
  disabled,
  className,
  ...rest
}: ToggleProps): JSX.Element {
  return (
    <button
      // `type="button"` keeps it from accidentally submitting any enclosing
      // form — Toggles in Settings sit inside `<form>`s for autofill but
      // mustn't trigger submission.
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => {
        onChange(!checked);
      }}
      className={cn(
        'km-toggle focusring',
        checked && 'km-toggle--on',
        disabled && 'km-toggle--disabled',
        className,
      )}
      {...rest}
    >
      <span className="km-toggle__thumb" aria-hidden="true" />
    </button>
  );
}
