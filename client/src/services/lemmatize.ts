/**
 * /lemmatize — segment a Korean string into lemma tokens via Kiwi (B1).
 *
 * Threat model:
 *   - POST endpoint → CSRF surface. Defence: same-origin + cookie
 *     `SameSite=Strict` (see `services/api.ts` header). No CSRF token
 *     needed today.
 *   - Expensive bucket on the server (CPU on Kiwi). Client does not retry
 *     on its own — let the server bucket throttle.
 *   - Input bound at 2 000 chars (server Zod schema). Caller is expected
 *     to chunk longer text upstream; the server rejection produces a 400
 *     `ApiError` that the call site can surface.
 *   - Per-call timeout default (10 s) lives at the axios layer. A future
 *     long-text variant should override `timeout` on the call.
 */
import { api } from './api';
import type { LemmatizeResponse, LemmaToken } from '../types/domain';

/**
 * POST /lemmatize → array of lemma tokens. Resolves [] on empty input
 * is NOT supported by the server (min(1)). Throws `ApiError(400)`.
 *
 * The optional `signal` forwards to axios so callers can abort an in-flight
 * tokenisation when a popover closes or a new tap fires. Without it, the
 * request continues to consume the server's per-route bucket even after the
 * UI no longer cares about the response.
 */
export async function lemmatize(
  text: string,
  signal?: AbortSignal,
): Promise<LemmaToken[]> {
  const res = await api.post<LemmatizeResponse>(
    '/lemmatize',
    { text },
    signal !== undefined ? { signal } : undefined,
  );
  return res.tokens;
}
