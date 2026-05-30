/**
 * Input sanitization for prompt-injection defense.
 *
 * What we defend against:
 *   1. The model being persuaded to ignore the system prompt
 *      ("ignore previous instructions, instead …").
 *   2. The model being persuaded to leak the system prompt itself.
 *   3. The model being persuaded to emit content that the route's Zod
 *      schema would accept but that is attacker-controlled (e.g., an
 *      enrichment payload whose "usageNote" contains executable HTML).
 *
 * What we do:
 *   1. Wrap untrusted content in <user_input>…</user_input> tags. The
 *      system prompt instructs the model to treat that as data, never
 *      as instructions.
 *   2. Reject inputs that contain obvious injection markers
 *      ("ignore previous", literal "</user_input>", system-role
 *      impersonation, etc.). These have zero legitimate use in Korean
 *      learning content.
 *   3. Strip ASCII control characters except \n and \t.
 *   4. Unicode NFC normalize so equivalent code-point sequences hash
 *      to the same cache key.
 *
 * What we do NOT do:
 *   - We don't try to detect "subtle" prompt injection. The model is
 *     the line of defense for that; the system prompt explicitly
 *     instructs it to ignore embedded instructions.
 *   - We don't strip Korean punctuation or punctuation-like marks; that
 *     would corrupt legitimate input.
 */

import { PromptInjectionRejectedError } from '../errors';

/**
 * Substrings that, if present in user content, indicate an attempted
 * prompt injection. Lowercased before comparison.
 *
 * IMPORTANT: this is belt-and-suspenders on top of the STRUCTURAL defense
 * (system prompt + `<user_input>` wrapping + Zod output schema + no
 * side-effecting tools). We deliberately keep this list SHORT and
 * HIGH-PRECISION to avoid rejecting legitimate Korean learning content:
 *   - Research corpora include phrases like "human subjects" / "human:".
 *   - Business Korean includes pasted log lines / API examples with
 *     "system:", "assistant:".
 *   - The role-impersonation markers (`system:`, `assistant:`, `human:`,
 *     `### system`, `<<sys>>`) were removed because they fire on these
 *     legitimate inputs without adding security on top of the structural
 *     defense — see REVIEW_B4.md §S-2 and FIX_REPORT_B.md §B4-S2.
 *
 * Markers kept here have ZERO legitimate use in Korean-learning content:
 *   - The `<user_input>` tags themselves (would break wrapping).
 *   - Explicit "ignore/disregard/forget previous" verbs.
 *   - "you are now" / "pretend you are" jailbreak preambles.
 */
const INJECTION_MARKERS: readonly string[] = [
  '</user_input>',
  '<user_input>',
  'ignore previous',
  'ignore all previous',
  'ignore the previous',
  'disregard previous',
  'disregard all previous',
  'forget previous',
  'forget all previous',
  // Common "jailbreak" preambles
  'you are now',
  'you are no longer',
  'pretend you are',
  'act as if you',
];

// Matching control characters here is the whole point — this strips them from
// user input before it reaches the model (defense against hidden-instruction and
// terminal-escape injection). The literal control-char class is intentional.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export interface SanitizeOptions {
  /** Max length in characters. Throws ClaudeInputValidationError on overflow. */
  readonly maxLength: number;
}

/**
 * Normalize + check user-supplied text. Returns the cleaned text.
 * Throws `PromptInjectionRejectedError` if obvious injection markers
 * are present.
 */
export function sanitizeUserInput(
  raw: string,
  opts: SanitizeOptions,
): string {
  if (typeof raw !== 'string') {
    throw new PromptInjectionRejectedError('user input must be a string');
  }
  // NFC normalize first so length checks count code points consistently.
  const normalized = raw.normalize('NFC');
  if (normalized.length > opts.maxLength) {
    throw new PromptInjectionRejectedError(
      `user input exceeds max length (${normalized.length} > ${opts.maxLength})`,
    );
  }
  // Strip control characters except \n and \t. \r is collapsed to \n by
  // the regex above leaving \n intact.
  const stripped = normalized.replace(CONTROL_CHARS_REGEX, '');

  const lower = stripped.toLowerCase();
  for (const marker of INJECTION_MARKERS) {
    if (lower.includes(marker)) {
      throw new PromptInjectionRejectedError(
        `user input contains injection marker: "${marker}"`,
      );
    }
  }
  return stripped;
}

/**
 * Wrap text in <user_input>…</user_input> tags after sanitization. The
 * caller is expected to have already sanitized; this is a convenience
 * for the common case.
 *
 * If you pass an unsanitized string, the tag-collision check still
 * fires (because sanitizeUserInput rejects </user_input>) — but the
 * length cap is NOT applied here; callers must apply their own cap
 * before constructing the prompt.
 */
export function wrapUserInput(text: string): string {
  // Note: we do NOT re-sanitize here because the higher layer has already
  // done so. But we DO double-check the close tag is absent, because the
  // assembled prompt is the last line of defense before the model.
  if (text.includes('</user_input>')) {
    throw new PromptInjectionRejectedError(
      'assembled prompt would close the user_input wrapper early',
    );
  }
  return `<user_input>\n${text}\n</user_input>`;
}
