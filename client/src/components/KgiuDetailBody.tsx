/**
 * KgiuDetailBody — shared body of the KGIU pattern-detail Sheet (F-018).
 *
 * Renders the rich pedagogical fields of `GET /grammar/kgiu/:id`:
 * explanation prose, "Formation" conjugation bullets, "Examples"
 * (Korean + English gloss), speaker-labelled "Dialogues", and the unit
 * footer. Used by both pages/Grammar.tsx (`DetailSheet`) and the library
 * browse pages/review/ReviewGrammar.tsx (`GrammarDetailSheet`) so the two
 * detail surfaces cannot drift apart.
 *
 * Each rich section renders ONLY when its array is non-empty — the corpus
 * legitimately ships empty arrays (e.g. `dialogues` is empty on every row
 * of the current load) and an orphaned header would read as missing
 * content. All corpus strings render through React text children, so a
 * hostile corpus row cannot escape into the DOM (XSS). Element shapes are
 * re-narrowed at the wire boundary (see the SF-2 helpers below): a malformed
 * element is skipped and the rest of the sheet still renders.
 */
import type { CSSProperties, JSX } from 'react';
import { Eyebrow } from './Eyebrow';
import type {
  KgiuDialogue,
  KgiuDialogueLine,
  KgiuEntryDetail,
  KgiuExample,
} from '../types/domain';

/** Body prose — matches the explanation style both Sheets already used. */
const PROSE: CSSProperties = { fontSize: 14, color: 'var(--paper-dim)' };

/** Space between stacked sections inside the Sheet body. */
const SECTION_GAP: CSSProperties = { marginTop: 16 };

/* ---------- Defensive element-shape narrowing (REVIEW_F018 SF-2) ----------
 * The DB CHECK (`jsonb_typeof(...) = 'array'`, migration 002) pins the
 * CONTAINER type of the three rich columns but says nothing about element
 * shape — the types in domain.ts are loader-contract assertions, not
 * validations. A malformed loader row (an object in `formation_rules`, an
 * example missing `korean`, a dialogue without `lines`) must degrade to
 * "that element is skipped, the rest renders" — never crash to the app
 * ErrorBoundary. Each helper re-narrows from `unknown` at the wire boundary. */

/** Non-array container (impossible per the DB CHECK, cheap to survive) → []. */
function asArray(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}

/** Keep only plain-string elements (formation_rules). */
function stringRules(x: unknown): string[] {
  return asArray(x).filter((r): r is string => typeof r === 'string');
}

function isKgiuExample(x: unknown): x is KgiuExample {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { korean?: unknown }).korean === 'string' &&
    typeof (x as { english?: unknown }).english === 'string'
  );
}

function isKgiuDialogueLine(x: unknown): x is KgiuDialogueLine {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { speaker?: unknown }).speaker === 'string' &&
    typeof (x as { korean?: unknown }).korean === 'string' &&
    typeof (x as { english?: unknown }).english === 'string'
  );
}

/**
 * A dialogue is renderable when it is an object with an ARRAY of lines
 * (its elements are re-filtered per-line inside DialogueBlock) — a dialogue
 * missing `lines` entirely is skipped rather than throwing at `.lines.map`.
 */
function isRenderableDialogue(x: unknown): x is KgiuDialogue {
  return (
    typeof x === 'object' &&
    x !== null &&
    Array.isArray((x as { lines?: unknown }).lines)
  );
}

export interface KgiuDetailBodyProps {
  detail: KgiuEntryDetail;
}

export function KgiuDetailBody({ detail }: KgiuDetailBodyProps): JSX.Element {
  // Narrow once so section gating (`.length > 0`) sees the SURVIVING elements:
  // a section whose every element is malformed collapses to nothing rendered
  // (matching the legitimate empty-array case) instead of an orphaned header.
  const formationRules = stringRules(detail.formation_rules);
  const examples = asArray(detail.examples).filter(isKgiuExample);
  const dialogues = asArray(detail.dialogues).filter(isRenderableDialogue);

  return (
    <>
      {detail.explanation ? (
        <>
          <Eyebrow>Explanation</Eyebrow>
          <p style={PROSE}>{detail.explanation}</p>
        </>
      ) : null}

      {formationRules.length > 0 ? (
        <>
          <Eyebrow style={SECTION_GAP}>Formation</Eyebrow>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {formationRules.map((rule, i) => (
              <li key={i} style={{ ...PROSE, margin: '2px 0' }}>
                {rule}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {examples.length > 0 ? (
        <>
          <Eyebrow style={SECTION_GAP}>Examples</Eyebrow>
          <ol
            aria-label="Example sentences"
            style={{ listStyle: 'none', margin: 0, padding: 0 }}
          >
            {examples.map((ex, i) => (
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

      {dialogues.length > 0 ? (
        <>
          <Eyebrow style={SECTION_GAP}>Dialogues</Eyebrow>
          {dialogues.map((dialogue, i) => (
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
  // isRenderableDialogue pinned `lines` as an array; the ELEMENTS are still
  // unverified wire data, so drop any malformed turn instead of crashing.
  const lines = dialogue.lines.filter(isKgiuDialogueLine);
  return (
    <div style={{ marginTop: first ? 6 : 14 }}>
      {typeof dialogue.context === 'string' && dialogue.context !== '' ? (
        <p style={{ ...PROSE, fontStyle: 'italic', margin: 0 }}>
          {dialogue.context}
        </p>
      ) : null}
      <ol
        aria-label="Dialogue lines"
        style={{ listStyle: 'none', margin: 0, padding: 0 }}
      >
        {lines.map((line, i) => (
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
