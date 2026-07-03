/**
 * TopikPassage — the shared reading passage a TOPIK item is asked about (B-008).
 *
 * TOPIK reading tests pose several questions about one text; the server
 * resolves that text onto `TopikItem.passage` / `TopikMockItem.passage`, and
 * this block renders it between the prompt and the choices so a fill-blank ㉠
 * or "윗글의 주제…" item is actually answerable. Used by both TOPIK surfaces
 * (Study mode and the Mock exam/review), mirroring Diagnostic's PassageCard.
 *
 * Deliberately NOT `KoreanPassage`: that component renders a tokenized
 * `ReadingPassage` (per-word Tapword glosses + per-sentence EN reveal), which
 * needs the Reading screen's popover/gloss infrastructure and would bolt a
 * translation toggle onto a timed exam. An exam passage is plain text.
 *
 * Threat model: the passage renders as a React text node, so a malicious
 * server payload becomes literal text, never markup (same posture as prompts
 * and choices — see Topik.tsx header).
 */
import type { JSX } from 'react';

export interface TopikPassageProps {
  /** The resolved passage text (server-provided, plain text). */
  text: string;
}

export function TopikPassage({ text }: TopikPassageProps): JSX.Element {
  return <div className="kr km-topik__passage">{text}</div>;
}
