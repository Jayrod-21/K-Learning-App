/**
 * RecoveryCodesPanel — the one-time display of TOTP backup recovery codes.
 *
 * Shown after enrollment, re-enrollment, or a regenerate. The plaintext codes
 * exist on the client for exactly this render — the server hashes them at rest
 * and can NEVER show them again (PASS LOGIN — security property #4). The panel
 * therefore makes saving them friction-light (copy + download) and, when used
 * to gate app entry, requires an explicit "I saved them" acknowledgement.
 *
 * SECURITY:
 *   - The `codes` are held in the parent's React state only — never
 *     localStorage. This component never persists them; the download writes a
 *     user-initiated file (their choice of where it lands) and the copy uses
 *     the clipboard the user explicitly invoked.
 *   - The Blob URL created for the download is revoked immediately after the
 *     click so it doesn't linger as a dangling in-memory reference.
 *   - No raw server text is rendered here; every string is author-controlled.
 *
 * A11y:
 *   - The codes are an ordered `<ol>` so AT announces position/count.
 *   - Copy/download are real `<button>`s; the transient "Copied" confirmation
 *     is announced via a `role="status" aria-live="polite"` region.
 *   - The acknowledgement is a native checkbox tied to its label; the
 *     continue button is disabled until it is checked, and `aria-describedby`
 *     points the button at the warning copy so the gate is explained.
 */
import { useId, useRef, useState, type JSX } from 'react';
import { Button } from './Button';

export interface RecoveryCodesPanelProps {
  /** The one-time plaintext codes. Held in the parent's memory only. */
  codes: string[];
  /**
   * Heading shown above the codes. Defaults to the enrollment phrasing;
   * Settings overrides it for the regenerate / re-enroll flows.
   */
  title?: string;
  /**
   * When provided, renders the "I saved them" acknowledgement gate + a
   * continue button that fires this callback only once the box is checked.
   * Omit (Settings regenerate, where there is no app-entry gate) to show the
   * codes with copy/download but no ack.
   */
  onAcknowledge?: () => void;
  /** Continue-button label when `onAcknowledge` is set. */
  acknowledgeLabel?: string;
}

/** Plain-text file body for the download — one code per line + a header. */
function codesToFile(codes: string[]): string {
  return (
    'Korean Master — recovery codes\n' +
    'Each code works once. Store them somewhere safe and private.\n' +
    'If you lose your authenticator AND these codes, an operator must reset 2FA.\n\n' +
    codes.join('\n') +
    '\n'
  );
}

export function RecoveryCodesPanel({
  codes,
  title = 'Save your recovery codes',
  onAcknowledge,
  acknowledgeLabel = 'I saved them — continue',
}: RecoveryCodesPanelProps): JSX.Element {
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);
  const ackId = useId();
  const warnId = useId();
  // Tracks the copied-confirmation reset timer so a rapid double-copy doesn't
  // leave a stale "Copied" hanging or fire setState after unmount.
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 2000);
    } catch {
      // Clipboard can be unavailable (insecure context, denied permission).
      // The download + manual selection are the fallback; we don't surface a
      // raw error — the codes are still on screen to copy by hand.
    }
  }

  function handleDownload(): void {
    const blob = new Blob([codesToFile(codes)], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'korean-master-recovery-codes.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke immediately — the click has already started the download, and a
    // lingering object URL is a needless in-memory reference to the secrets.
    URL.revokeObjectURL(url);
  }

  return (
    <div className="km-recovery">
      <h2 className="km-recovery__title">{title}</h2>
      <p id={warnId} className="km-recovery__warn">
        These are shown once. Each code signs you in a single time if you lose
        your authenticator. Keep them somewhere safe — they won&apos;t be shown
        again.
      </p>

      <ol className="km-recovery__codes" aria-label="Recovery codes">
        {codes.map((code, index) => (
          // Index-qualified key: recovery codes are unique by construction, but
          // an index guard keeps React stable even if a future low-entropy source
          // ever produced a duplicate (a bare `key={code}` would collide).
          <li key={`${String(index)}:${code}`} className="km-recovery__code kr">
            {code}
          </li>
        ))}
      </ol>

      <div className="km-recovery__actions">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void handleCopy();
          }}
        >
          Copy codes
        </Button>
        <Button variant="ghost" size="sm" onClick={handleDownload}>
          Download .txt
        </Button>
        <span role="status" aria-live="polite" className="km-recovery__copied">
          {copied ? 'Copied to clipboard' : ''}
        </span>
      </div>

      {onAcknowledge ? (
        <div className="km-recovery__ack">
          <label htmlFor={ackId} className="km-recovery__ack-label">
            <input
              id={ackId}
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => {
                setAcknowledged(e.target.checked);
              }}
            />
            <span>I&apos;ve saved these codes somewhere safe.</span>
          </label>
          <Button
            variant="gold"
            size="lg"
            fullWidth
            disabled={!acknowledged}
            aria-describedby={warnId}
            onClick={onAcknowledge}
          >
            {acknowledgeLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
