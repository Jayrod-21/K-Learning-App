/**
 * KgiuDetailBody — shared body of the KGIU pattern-detail Sheet (F-018).
 *
 * Renders the rich pedagogical fields of `GET /grammar/kgiu/:id`:
 * explanation prose, "Formation" conjugation bullets, "Examples"
 * (Korean + English gloss), speaker-labelled "Dialogues", and the unit
 * footer. Used by both pages/Grammar.tsx (`DetailSheet`) and
 * pages/Reference.tsx (`GrammarDetailSheet`) so the two detail surfaces
 * cannot drift apart.
 *
 * Each rich section renders ONLY when its array is non-empty — the corpus
 * legitimately ships empty arrays (e.g. `dialogues` is empty on every row
 * of the current load) and an orphaned header would read as missing
 * content. All corpus strings render through React text children, so a
 * hostile corpus row cannot escape into the DOM (XSS).
 */
import type { CSSProperties, JSX } from 'react';
import { Eyebrow } from './Eyebrow';
import type { KgiuDialogue, KgiuEntryDetail } from '../types/domain';

/** Body prose — matches the explanation style both Sheets already used. */
const PROSE: CSSProperties = { fontSize: 14, color: 'var(--paper-dim)' };

/** Space between stacked sections inside the Sheet body. */
const SECTION_GAP: CSSProperties = { marginTop: 16 };

export interface KgiuDetailBodyProps {
  detail: KgiuEntryDetail;
}

export function KgiuDetailBody({ detail }: KgiuDetailBodyProps): JSX.Element {
  return (
    <>
      {detail.explanation ? (
        <>
          <Eyebrow>Explanation</Eyebrow>
          <p style={PROSE}>{detail.explanation}</p>
        </>
      ) : null}

      {detail.formation_rules.length > 0 ? (
        <>
          <Eyebrow style={SECTION_GAP}>Formation</Eyebrow>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {detail.formation_rules.map((rule, i) => (
              <li key={i} style={{ ...PROSE, margin: '2px 0' }}>
                {rule}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {detail.examples.length > 0 ? (
        <>
          <Eyebrow style={SECTION_GAP}>Examples</Eyebrow>
          <ol
            aria-label="Example sentences"
            style={{ listStyle: 'none', margin: 0, padding: 0 }}
          >
            {detail.examples.map((ex, i) => (
              <li
                key={i}
                className="km-reference__row"
                style={{ padding: '8px 0' }}
              >
                <p className="kr km-reference__row-kr" style={{ margin: 0 }}>
                  {ex.korean}
                </p>
                {ex.english !== '' ? (
                  <p
                    className="km-reference__row-en"
                    style={{ margin: '2px 0 0' }}
                  >
                    {ex.english}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </>
      ) : null}

      {detail.dialogues.length > 0 ? (
        <>
          <Eyebrow style={SECTION_GAP}>Dialogues</Eyebrow>
          {detail.dialogues.map((dialogue, i) => (
            <DialogueBlock key={i} dialogue={dialogue} first={i === 0} />
          ))}
        </>
      ) : null}

      <div className="km-eyebrow" style={SECTION_GAP}>
        Unit · {detail.unit ?? '—'}
      </div>
    </>
  );
}

/**
 * One dialogue: an italic context line, then speaker-labelled turns in the
 * app's KR-prominent / EN-secondary row style (mirrors Ttmik's SentenceRow).
 * `alternatives` is intentionally not rendered — its shape is not pinned
 * down by the loader yet (see KgiuDialogue in types/domain.ts).
 */
function DialogueBlock({
  dialogue,
  first,
}: {
  dialogue: KgiuDialogue;
  first: boolean;
}): JSX.Element {
  return (
    <div style={{ marginTop: first ? 6 : 14 }}>
      {dialogue.context !== '' ? (
        <p style={{ ...PROSE, fontStyle: 'italic', margin: 0 }}>
          {dialogue.context}
        </p>
      ) : null}
      <ol
        aria-label="Dialogue lines"
        style={{ listStyle: 'none', margin: 0, padding: 0 }}
      >
        {dialogue.lines.map((line, i) => (
          <li
            key={i}
            className="km-reference__row"
            style={{ padding: '8px 0' }}
          >
            {line.speaker !== '' ? (
              <div className="km-eyebrow" style={{ marginBottom: 2 }}>
                {line.speaker}
              </div>
            ) : null}
            <p className="kr km-reference__row-kr" style={{ margin: 0 }}>
              {line.korean}
            </p>
            {line.english !== '' ? (
              <p
                className="km-reference__row-en"
                style={{ margin: '2px 0 0' }}
              >
                {line.english}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
