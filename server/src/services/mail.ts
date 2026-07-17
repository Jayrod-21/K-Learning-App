/**
 * Mail transport (F-006) — provider-agnostic outbound email.
 *
 * Two implementations behind ONE interface, selected by config (NEVER a
 * hardcoded vendor):
 *
 *   - SMTP (nodemailer): configured entirely from env (SMTP_HOST/PORT/USER/
 *     PASS/FROM/SECURE/TLS_REJECT_UNAUTHORIZED). In this deployment the env
 *     points at Proton Mail Bridge's local SMTP endpoint, but nothing in this
 *     module knows that — any RFC-compliant relay works.
 *   - Mock/log: selected automatically when SMTP_HOST is unset (dev) and
 *     installed explicitly by tests. Logs the message and sends nothing.
 *
 * Threat model (SECURITY.md §19):
 *   - Secret leakage via logs: the SMTP implementation logs ONLY {to-domain,
 *     subject, messageId} — never the body (verification emails carry the raw
 *     single-use token in their link). The mock transport DOES log the full
 *     text body including the link: that is its purpose (the dev/operator
 *     escape hatch when no relay is configured), it is only ever selected when
 *     SMTP is unconfigured, and the fact is documented loudly here and at the
 *     call sites.
 *   - Relay hangs → request hangs: bounded connection/greeting/socket timeouts
 *     on the SMTP transport so a dead relay fails fast instead of pinning an
 *     Express handler (callers additionally treat sendMail as best-effort).
 *   - TLS downgrade: certificate validation is ON by default;
 *     SMTP_TLS_REJECT_UNAUTHORIZED=false exists solely for a LOOPBACK relay
 *     presenting a self-signed cert (Proton Bridge) and is the operator's
 *     explicit, documented opt-out.
 *   - Header injection: recipient/subject values at the call sites are
 *     server-derived (DB email, fixed subject) — no request-controlled header
 *     content. nodemailer additionally rejects newline-bearing addresses.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { loadConfig } from '../config/index.js';
import { getLogger } from '../logging.js';

export interface MailMessage {
  to: string;
  subject: string;
  /** Plaintext body — always provided (text-only clients, spam scoring). */
  text: string;
  /** HTML body — optional; falls back to text-only when omitted. */
  html?: string;
}

export interface MailTransport {
  /** Deliver one message. Rejects on transport failure — callers decide
   *  whether a failure is fatal (it never is for register/resend). */
  sendMail(msg: MailMessage): Promise<void>;
}

/** Log-only transport: dev fallback + the default under test. */
function buildMockTransport(): MailTransport {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    sendMail: async (msg: MailMessage): Promise<void> => {
      // DELIBERATE: the mock logs the full text body (it contains the
      // verification URL — the only way to complete the flow with no relay
      // configured). Selected ONLY when SMTP_HOST is unset, i.e. never in a
      // correctly-configured production deployment.
      getLogger().info(
        { event: 'mail_mock_send', to: msg.to, subject: msg.subject, text: msg.text },
        'mail (mock transport — no SMTP configured; nothing sent)',
      );
    },
  };
}

/** Real SMTP transport via nodemailer, configured from env. */
function buildSmtpTransport(): MailTransport {
  const cfg = loadConfig();
  if (!cfg.SMTP_HOST || !cfg.SMTP_FROM) {
    // Config superRefine guarantees FROM when HOST is set; this guard is for
    // programmer error (calling the builder without HOST), not operators.
    throw new Error('SMTP transport requires SMTP_HOST and SMTP_FROM');
  }
  const transporter: Transporter = nodemailer.createTransport({
    host: cfg.SMTP_HOST,
    port: cfg.SMTP_PORT,
    secure: cfg.SMTP_SECURE,
    auth:
      cfg.SMTP_USER !== undefined && cfg.SMTP_PASS !== undefined
        ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS }
        : undefined,
    tls: { rejectUnauthorized: cfg.SMTP_TLS_REJECT_UNAUTHORIZED },
    // Fail fast on a dead relay — never pin a request handler on SMTP.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  const from = cfg.SMTP_FROM;
  return {
    sendMail: async (msg: MailMessage): Promise<void> => {
      const info = (await transporter.sendMail({
        from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        ...(msg.html !== undefined ? { html: msg.html } : {}),
      })) as { messageId?: string };
      // PII posture (SECURITY.md §4.1): log the recipient DOMAIN only, never
      // the local part, and NEVER the body (it carries the raw token).
      getLogger().info(
        {
          event: 'mail_sent',
          toDomain: msg.to.split('@')[1] ?? 'unknown',
          subject: msg.subject,
          messageId: info.messageId,
        },
        'mail sent via smtp',
      );
    },
  };
}

let _transport: MailTransport | null = null;

/**
 * The process-wide mail transport. Lazy + config-driven: SMTP when SMTP_HOST
 * is configured, the log-only mock otherwise. Built on first use (NOT at
 * import) so tests that set env in buildTestApp aren't pinned by import order
 * — the same lazy discipline as middleware/rateLimits.
 */
export function getMailTransport(): MailTransport {
  if (_transport) return _transport;
  const cfg = loadConfig();
  _transport = cfg.SMTP_HOST ? buildSmtpTransport() : buildMockTransport();
  return _transport;
}

/** Install a capture/stub transport — test-only. */
export function _setMailTransportForTesting(t: MailTransport): void {
  _transport = t;
}

/** Drop the cached transport so the next call re-selects from config — test-only. */
export function _resetMailTransportForTesting(): void {
  _transport = null;
}
