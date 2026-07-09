/**
 * Button — gold (solid accent fill + glow) primary or ghost (soft accent
 * tint) secondary.
 *
 * Pill radius — the radius/fill/glow values live in the `.km-btn*` rules
 * in styles/index.css, keyed off the runtime accent tokens. Renders a real
 * `<button>` with `type="button"` by default; setting `type="submit"` opts
 * in to form submission. Disabled state lowers opacity and removes pointer
 * events.
 */
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn';

export type ButtonVariant = 'gold' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Render an inline leading icon. Kept simple — composite layouts pass children. */
  leadingIcon?: ReactNode;
  /** Render an inline trailing icon. */
  trailingIcon?: ReactNode;
  fullWidth?: boolean;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  gold: 'km-btn--gold',
  ghost: 'km-btn--ghost',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'km-btn--sm',
  md: 'km-btn--md',
  lg: 'km-btn--lg',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = 'gold',
      size = 'md',
      leadingIcon,
      trailingIcon,
      fullWidth,
      type,
      className,
      children,
      ...rest
    },
    ref,
  ): JSX.Element {
    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        className={cn(
          'km-btn focusring',
          VARIANT_CLASS[variant],
          SIZE_CLASS[size],
          fullWidth && 'km-btn--full',
          className,
        )}
        {...rest}
      >
        {leadingIcon ? <span className="km-btn__icon">{leadingIcon}</span> : null}
        {/* Skip the label wrapper entirely for icon-only buttons so the DOM
            doesn't emit an empty `<span>` that screen readers might still
            visit. */}
        {children != null ? <span className="km-btn__label">{children}</span> : null}
        {trailingIcon ? <span className="km-btn__icon">{trailingIcon}</span> : null}
      </button>
    );
  },
);
