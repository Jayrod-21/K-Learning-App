/**
 * KoreanPassage — renders a reading passage as sentences of tokens.
 *
 * Token model (see `types/domain.ts`):
 *   - Plain text token            → bare `<span>` (no affordance).
 *   - Token with `gloss`          → `<Tapword>`; click opens word popover.
 *   - Token between `g4-start`/`g4-end` → wrapped in a single grammar
 *                                    `<span class="gram-span">` highlight;
 *                                    click anywhere in the run opens the
 *                                    grammar popover with `'g4'`.
 *
 * Below each sentence: an `EN` toggle button reveals the English
 * translation. Revealed state lives in this component (a Set of
 * sentence indices) so revealing one sentence doesn't disrupt others.
 *
 * Threat model:
 *   - `tk.w` and `sent.en` are rendered as React children, so React
 *     escapes them. XSS via the token text itself is therefore not
 *     reachable. In Pass 2 the passage comes from author-controlled
 *     fixtures (`src/data/mocks/reading.ts`); if Pass 3 wires this to a
 *     user-supplied passage endpoint, the server MUST still enforce the
 *     same constraint — never render HTML inside a passage.
 *
 * @example
 *   <KoreanPassage
 *     passage={READING_PASSAGE}
 *     onOpenWord={(g) => setPop({ ...g })}
 *     onOpenGrammar={(gid) => setPop({ kind: 'grammar', ...PATTERNS[gid] })}
 *     minedIds={minedSet}
 *   />
 */
import { useState, type JSX, type ReactElement } from 'react';
import type {
  PassageGloss,
  PassageSentence,
  PassageToken,
  ReadingPassage,
} from '../types/domain';
import { Tapword } from './Tapword';

export interface KoreanPassageProps {
  /** Passage data — author-controlled in Pass 2 fixtures. */
  passage: ReadingPassage;
  /** Called when a tapword is tapped — receives the gloss payload. */
  onOpenWord: (gloss: PassageGloss) => void;
  /** Called when any token inside a grammar span is tapped. */
  onOpenGrammar: (gid: string) => void;
  /** Word kr strings the learner has already mined — drives dotted-underline. */
  minedIds: ReadonlySet<string>;
  /** When true, reveal every sentence's translation on mount. */
  showTranslation?: boolean;
}

export function KoreanPassage({
  passage,
  onOpenWord,
  onOpenGrammar,
  minedIds,
  showTranslation = false,
}: KoreanPassageProps): JSX.Element {
  // Initial revealed set mirrors the prototype: every sentence pre-revealed
  // when `showTranslation`, otherwise none.
  const [revealed, setRevealed] = useState<Set<number>>(() => {
    if (!showTranslation) return new Set();
    const all = new Set<number>();
    for (let i = 0; i < passage.sentences.length; i += 1) all.add(i);
    return all;
  });

  const toggleSent = (i: number): void => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  return (
    <div className="kr km-passage">
      {passage.sentences.map((sent, si) => (
        <Sentence
          key={si}
          sent={sent}
          si={si}
          revealed={revealed.has(si)}
          onToggle={() => {
            toggleSent(si);
          }}
          onOpenWord={onOpenWord}
          onOpenGrammar={onOpenGrammar}
          minedIds={minedIds}
        />
      ))}
    </div>
  );
}

interface SentenceProps {
  sent: PassageSentence;
  si: number;
  revealed: boolean;
  onToggle: () => void;
  onOpenWord: (gloss: PassageGloss) => void;
  onOpenGrammar: (gid: string) => void;
  minedIds: ReadonlySet<string>;
}

/**
 * Sentence — walks tokens once, batching the grammar-span run between
 * matching `*-start`/`*-end` markers into a single `<span class="gram-span">`.
 *
 * Pulled out so the per-sentence render logic stays linear; the prototype
 * inlines this but our strict TS + the explicit grammar-span keying read
 * easier as a small helper.
 */
function Sentence({
  sent,
  si,
  revealed,
  onToggle,
  onOpenWord,
  onOpenGrammar,
  minedIds,
}: SentenceProps): JSX.Element {
  const out: ReactElement[] = [];
  let spanRun: ReactElement[] = [];
  let spanGid: string | null = null;

  const flushSpan = (): void => {
    if (spanRun.length && spanGid) {
      const gid = spanGid;
      out.push(
        // Gram-span has the same gesture shape as Tapword: clickable,
        // keyboard-activatable, role=button. Without role/tabIndex/key
        // handler it would be mouse-only, breaking parity with Tapword
        // for keyboard learners.
        <span
          key={`g-${si}-${out.length}`}
          className="gram-span focusring"
          role="button"
          tabIndex={0}
          onClick={() => {
            onOpenGrammar(gid);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onOpenGrammar(gid);
            }
          }}
          aria-label={`Grammar pattern ${gid} — open`}
          title="Grammar pattern — tap to study"
        >
          {spanRun}
        </span>,
      );
      spanRun = [];
      spanGid = null;
    }
  };

  sent.tokens.forEach((tk: PassageToken, ti) => {
    const key = `t-${si}-${ti}`;
    const piece = tk.gloss ? (
      <Tapword
        key={key}
        mined={minedIds.has(tk.gloss.kr)}
        onTap={() => {
          // Type-narrow: `gloss` was truthy when we entered this branch.
          if (tk.gloss) onOpenWord(tk.gloss);
        }}
      >
        {tk.w}
      </Tapword>
    ) : (
      <span key={key}>{tk.w}</span>
    );

    // Grammar-span markers: `g4-start` opens a run, `g4-end` closes it.
    // Mid tokens just join the open run. The id prefix (`g4`) lets future
    // passes mix multiple grammar patterns in one passage without
    // ambiguity — same encoding as the design fixtures use.
    if (tk.span && tk.span.endsWith('-start')) {
      spanGid = tk.span.slice(0, -'-start'.length);
      spanRun.push(piece);
      return;
    }
    if (tk.span && tk.span.endsWith('-end')) {
      spanRun.push(piece);
      flushSpan();
      return;
    }
    if (spanGid) {
      spanRun.push(piece);
      return;
    }
    out.push(piece);
  });

  // Defensive: flush any unterminated span so a malformed fixture still
  // renders all of its tokens rather than swallowing the tail.
  flushSpan();

  return (
    <p className="km-passage__sentence">
      {out}
      <button
        type="button"
        onClick={onToggle}
        className="km-passage__en-toggle focusring"
        title={revealed ? 'Hide translation' : 'Reveal translation'}
        aria-expanded={revealed}
      >
        EN
      </button>
      {revealed ? (
        <span className="km-passage__en">{sent.en}</span>
      ) : null}
    </p>
  );
}
