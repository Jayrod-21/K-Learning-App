/**
 * ErrorCard — the canonical hanji-styled inline error tile.
 *
 * Replaces four inline copies (Today, Reading, Review, Chat) that were
 * drifting on padding, copy, and retry shape. One source of truth now;
 * any future visual tweak (border tone, icon, copy) lives in one file.
 *
 * Two slots:
 *   - `message` — the human-readable line. Author-controlled / from a
 *     fixed lookup, never an echo of an untrusted server message.
 *   - `onRetry` — invoked when the user taps Retry. The parent decides
 *     what "retry" means (re-fetch via `useEndpointOrMock.refetch`, hard
 *     reload, route navigation, …). Optional — omit to suppress the
 *     button entirely (used in legitimate empty-bank states).
 *
 * A11y:
 *   - `role="alert"` so AT picks up the error on mount.
 *   - Retry button is a real `<button>`; `.focusring` gives it a visible
 *     focus indicator.
 *
 * Threat model:
 *   - The `message` flows through React text rendering — escaped. Callers
 *     MUST NOT pass untrusted server message text here (mirrors the
 *     `Login.messageFor` fixed-lookup contract).
 */
import type { JSX } from 'react';
import { Card } from './Card';
import { Button } from './Button';

export interface ErrorCardProps {
  /** Human-readable error line. Author-controlled. */
  message: string;
  /** When provided, renders a Retry button that fires this callback. */
  onRetry?: () => void;
  /** Retry button label override — defaults to "Retry". */
  retryLabel?: string;
}

export function ErrorCard({
  message,
  onRetry,
  retryLabel = 'Retry',
}: ErrorCardProps): JSX.Element {
  return (
    <Card
      variant="flat"
      role="alert"
      style={{ borderColor: 'var(--vermilion)' }}
    >
      <div className="km-eyebrow" style={{ marginBottom: 6 }}>
        Couldn&apos;t load
      </div>
      <div
        style={{ fontSize: 14, color: 'var(--paper-dim)', marginBottom: 12 }}
      >
        {message}
      </div>
      {onRetry ? (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </Card>
  );
}
