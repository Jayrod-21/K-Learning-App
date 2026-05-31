/**
 * QR rendering helper — turns an `otpauth://` enrollment URI into a PNG data
 * URL the UI can drop into an `<img>` element.
 *
 * Why a thin wrapper and not a component library: the contract (PASS LOGIN —
 * PART C6) is explicit that we render a QR to a data URL and avoid pulling in a
 * heavy component lib. `qrcode` renders entirely client-side — the secret never
 * leaves the device to a QR service.
 *
 * SECURITY: the `otpauth://` URI embeds the (base32) TOTP secret. It is held in
 * memory, rendered locally, and never logged or persisted. Callers MUST treat
 * the resulting data URL the same way — show it, never store it.
 *
 * `errorCorrectionLevel: 'M'` (15% recovery) is the authenticator-app default
 * and keeps the QR scannable on a slightly glare-y phone photo of the screen.
 */
import QRCode from 'qrcode';

/**
 * Render `otpauthUri` to a PNG data URL. Rejects (via the returned promise) if
 * the URI is malformed or the encoder fails — the caller surfaces a fixed
 * "couldn't render the QR, use the secret below" message and never echoes the
 * raw error.
 */
export async function otpauthUriToDataUrl(otpauthUri: string): Promise<string> {
  return QRCode.toDataURL(otpauthUri, {
    errorCorrectionLevel: 'M',
    margin: 2,
    // A fixed pixel width keeps the rendered QR crisp on hi-DPI screens
    // without depending on CSS scaling of a tiny default bitmap.
    width: 220,
  });
}
