/**
 * Images screen — Papago-style OCR mining.
 *
 * Two view modes driven by `current` (capture id | null):
 *
 *   - LIST view (`current === null`):
 *       UploadCard (dashed border + vermilion camera circle + hidden
 *       file picker), "Or try a sample" list, "Recent captures" grid.
 *       Per design `screens-d.jsx` UploadCard: picking ANY real file
 *       triggers the first demo capture — Pass 2 is mock-only; no
 *       upload contract yet (Pass 8 lands `POST /images/ocr`).
 *
 *   - CAPTURE view (`current !== null`):
 *       Back ghost + "N words detected" gold pill, image card with
 *       absolutely-positioned KR scene text + vermilion OCR overlay
 *       boxes that pulse on mount (staggered 100ms, single 1.6s
 *       keyframe — respects `prefers-reduced-motion`). Each box AND
 *       each detected-word row opens `<WordPopover>` so the gesture
 *       matches Reading. Once added, box turns moss-soft and the row
 *       button flips to "Added".
 *
 * Threat model:
 *   - The only real I/O surface in Pass 2 is the hidden `<input
 *     type="file">`. We don't upload anything; choosing a file just
 *     swaps `current` to a demo capture. **Pass 8 wiring will add
 *     size/MIME validation + magic-byte sniffing on the server before
 *     sending bytes to Claude Vision.** Marker comment on `onFile`.
 *   - All KR/EN/POS text renders as React children — XSS-safe. Mock
 *     fixture is author-controlled; Pass 8 server response must keep
 *     that contract (text, not HTML).
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { Card } from '../components/Card';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { Pill } from '../components/Pill';
import { SealStamp } from '../components/SealStamp';
import { Topbar } from '../components/Topbar';
import { WordPopover, type WordPopoverData } from '../components/WordPopover';
import {
  loadImagesMock,
  type ImageCapture,
  type OcrWord,
} from '../data/mocks/images';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';

export default function Images(): JSX.Element {
  const result = useEndpointOrMock<ImageCapture[]>('images', loadImagesMock);

  const [current, setCurrent] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  // One added-set per capture — keying by capture id keeps state
  // honest when the learner ping-pongs between captures without losing
  // their per-image add state. Each value is a Set<string> of OCR word
  // ids that have been added to the bank in the current session.
  const [addedByCapture, setAddedByCapture] = useState<
    Record<string, Set<string>>
  >({});
  const [popData, setPopData] = useState<WordPopoverData | null>(null);

  // Seed `history` from the loaded captures once data arrives. We use
  // the first capture's id as the most-recent placeholder so the
  // "Recent captures" grid never renders empty during a fresh boot.
  // Sync-to-external-system case (same shape as AuthProvider's probe);
  // the rule's preferred "derive in render" doesn't fit because we want
  // user-pushed history entries to win over the seed.
  useEffect(() => {
    const captures = result.data;
    if (!captures || captures.length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHistory((prev) => (prev.length > 0 ? prev : [captures[0].id]));
  }, [result.data]);

  const captures = result.data ?? [];
  const cap = current ? captures.find((c) => c.id === current) ?? null : null;

  const pushHistory = (id: string): void => {
    setHistory((h) => (h.includes(id) ? h : [id, ...h].slice(0, 6)));
  };

  const openCapture = (id: string): void => {
    setCurrent(id);
    pushHistory(id);
  };

  const addWord = (capId: string, wordId: string): void => {
    setAddedByCapture((prev) => {
      const existing = prev[capId] ?? new Set<string>();
      if (existing.has(wordId)) return prev;
      const next = new Set(existing);
      next.add(wordId);
      return { ...prev, [capId]: next };
    });
  };

  return (
    <section
      className="screen km-images"
      style={{ position: 'relative' }}
      aria-labelledby="km-images-title"
    >
      {result.isMock ? <MockBadge /> : null}
      <Topbar
        krTitle={
          <>
            이미지 <span className="km-topbar__title-en">· Images</span>
          </>
        }
        eyebrow="OCR · mine real-world Korean"
      />

      {result.loading ? (
        <Card className="km-images__skeleton" aria-busy="true">
          <Eyebrow>Loading captures</Eyebrow>
          <div className="km-images__skeleton-line" />
          <div className="km-images__skeleton-line" />
        </Card>
      ) : result.error && captures.length === 0 ? (
        <Card className="km-images__error" role="alert">
          <Eyebrow>Captures unavailable</Eyebrow>
          <p>We couldn&apos;t load your captures. Try again shortly.</p>
        </Card>
      ) : cap ? (
        <CaptureView
          cap={cap}
          added={addedByCapture[cap.id] ?? EMPTY_SET}
          onBack={() => {
            setCurrent(null);
          }}
          onOpenWord={(w) => {
            setPopData(wordToPopover(w));
          }}
          onAddOne={(wordId) => {
            addWord(cap.id, wordId);
          }}
          onAddAll={() => {
            cap.words.forEach((w) => {
              addWord(cap.id, w.id);
            });
          }}
        />
      ) : (
        <ListView
          captures={captures}
          history={history}
          onPick={openCapture}
        />
      )}

      {popData ? (
        <WordPopover
          data={popData}
          onClose={() => {
            setPopData(null);
          }}
          onAdd={() => {
            // Marker — the popover's own Add button handles the visual
            // state. We could also commit to the per-capture added-set
            // here, but routing through the row button keeps a single
            // source of truth (the visible Added pill on the row).
          }}
        />
      ) : null}
    </section>
  );
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

function wordToPopover(w: OcrWord): WordPopoverData {
  // `w.gloss` is the OCR-source caption (e.g. "americano coffee" from a
  // sign). We surface it as the example KR sentence to preserve
  // provenance — the learner sees the original detected phrase, not a
  // stripped-down English gloss. `notes` carries the caption-source
  // attribution so a future popover layout can render "seen on a menu /
  // sign" provenance without losing it.
  return {
    kr: w.kr,
    en: w.en,
    pos: w.pos,
    ex_kr: w.gloss,
    ex_en: w.en,
    notes: `Detected from image — caption "${w.gloss}".`,
  };
}

// ─────────────────────────────────────────────────────────────
// List view — Upload card + samples + recent grid.
// ─────────────────────────────────────────────────────────────
function ListView({
  captures,
  history,
  onPick,
}: {
  captures: ImageCapture[];
  history: string[];
  onPick: (id: string) => void;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Pass 2 demo flow: any real file picks the first demo capture.
  // Pass 8 replaces this with a real upload → `POST /images/ocr` →
  // server returns an `ImageCapture` shape and we open it. Size +
  // MIME + magic-byte validation belongs in the server handler, not
  // here; the client only checks `accept` to skim obviously-wrong
  // pickers but the browser will let any file through.
  const onFile = (): void => {
    const first = captures[0];
    if (first) onPick(first.id);
  };

  return (
    <div className="km-images__list">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="km-images__upload focusring"
      >
        <span className="km-images__upload-icon" aria-hidden="true">
          <Icon name="camera" size={26} />
        </span>
        <div className="km-images__upload-title">Capture or upload</div>
        <p className="km-images__upload-hint">
          Photo of signage, a menu, a book page — anything with Korean text.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={onFile}
        />
      </button>

      {captures.length > 0 ? (
        <>
          <Eyebrow className="km-images__group-eyebrow">
            Or try a sample
          </Eyebrow>
          <ul className="km-images__samples">
            {captures.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(c.id);
                  }}
                  className="km-images__sample focusring"
                >
                  <ThumbCapture cap={c} small />
                  <div className="km-images__sample-meta">
                    <div className="kr km-images__sample-kr">{c.name}</div>
                    <div className="km-images__sample-en">{c.caption_en}</div>
                  </div>
                  <Icon name="chevron-right" size={14} />
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {history.length > 0 && captures.length > 0 ? (
        <>
          <Eyebrow className="km-images__group-eyebrow">
            Recent captures
          </Eyebrow>
          <ul className="km-images__recent">
            {history.map((id) => {
              const cap = captures.find((c) => c.id === id);
              if (!cap) return null;
              return (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => {
                      onPick(id);
                    }}
                    className="km-images__recent-card focusring"
                  >
                    <ThumbCapture cap={cap} />
                    <div className="km-images__recent-meta">
                      <div className="kr km-images__recent-kr">{cap.name}</div>
                      <div className="km-images__recent-en">
                        {cap.name} · {cap.words.length} words
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function ThumbCapture({
  cap,
  small = false,
}: {
  cap: ImageCapture;
  small?: boolean;
}): JSX.Element {
  // Render only the first 2 (small) or 4 scene lines — the prototype
  // does the same so the thumb reads as "a glimpse" rather than a
  // miniature of the full sign.
  const visible = cap.scene.slice(0, small ? 2 : 4);
  return (
    <div
      className={
        'km-images__thumb' + (small ? ' km-images__thumb--small' : '')
      }
      style={{ background: cap.gradient }}
      aria-hidden="true"
    >
      {visible.map((line, i) => (
        <span
          key={`${line.text}-${String(i)}`}
          className="kr km-images__thumb-line"
          style={{
            left: `${String(line.x)}%`,
            top: `${String(line.y)}%`,
            fontSize: Math.max(6, line.size * (small ? 0.18 : 0.35)),
          }}
        >
          {line.text}
        </span>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Capture view — image + OCR boxes + detected list.
// ─────────────────────────────────────────────────────────────
function CaptureView({
  cap,
  added,
  onBack,
  onOpenWord,
  onAddOne,
  onAddAll,
}: {
  cap: ImageCapture;
  added: ReadonlySet<string>;
  onBack: () => void;
  onOpenWord: (w: OcrWord) => void;
  onAddOne: (wordId: string) => void;
  onAddAll: () => void;
}): JSX.Element {
  return (
    <div className="km-images__capture">
      <div className="km-images__capture-bar">
        <button
          type="button"
          onClick={onBack}
          className="km-btn km-btn--ghost km-btn--sm focusring"
        >
          <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
            <Icon name="arrow-right" size={12} />
          </span>
          <span>Back</span>
        </button>
        <Pill tone="gold">
          <Icon name="translate" size={11} /> {cap.words.length} words detected
        </Pill>
      </div>

      <Card className="km-images__capture-card">
        <div
          className="km-images__capture-frame"
          style={{ background: cap.gradient }}
          aria-label={cap.caption_en}
          role="img"
        >
          {cap.scene.map((line, i) => (
            <span
              key={`${line.text}-${String(i)}`}
              className="kr km-images__capture-line"
              style={{
                left: `${String(line.x)}%`,
                top: `${String(line.y)}%`,
                fontSize: line.size,
              }}
            >
              {line.text}
            </span>
          ))}
          {cap.words.map((w, i) => {
            const isAdded = added.has(w.id);
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => {
                  onOpenWord(w);
                }}
                aria-label={w.kr}
                title={`${w.kr} — ${w.en}`}
                className={
                  'km-images__ocrbox focusring' +
                  (isAdded ? ' km-images__ocrbox--added' : '')
                }
                style={{
                  left: `${String(w.box.x)}%`,
                  top: `${String(w.box.y)}%`,
                  width: `${String(w.box.w)}%`,
                  height: `${String(w.box.h)}%`,
                  // i * 100ms stagger — single 1.6s keyframe.
                  animationDelay: `${String(i * 100)}ms`,
                }}
              />
            );
          })}
        </div>
        <div className="km-images__capture-caption">
          <div>
            <div className="kr km-images__capture-caption-kr">
              {cap.caption_kr}
            </div>
            <div className="km-images__capture-caption-en">
              {cap.caption_en}
            </div>
          </div>
          <SealStamp char="譯" size="sm" />
        </div>
      </Card>

      <Eyebrow className="km-images__list-eyebrow">Detected words</Eyebrow>
      <Card className="km-images__detected">
        <ul className="km-images__detected-list">
          {cap.words.map((w) => {
            const isAdded = added.has(w.id);
            return (
              <li key={w.id} className="km-images__detected-row">
                <button
                  type="button"
                  onClick={() => {
                    onOpenWord(w);
                  }}
                  className="km-images__detected-word focusring"
                  aria-label={`Open ${w.kr}`}
                >
                  <span className="kr km-tapword km-images__detected-kr">
                    {w.kr}
                  </span>
                  <span className="km-images__detected-pos">{w.pos}</span>
                </button>
                <span className="km-images__detected-en">{w.en}</span>
                <button
                  type="button"
                  onClick={() => {
                    if (!isAdded) onAddOne(w.id);
                  }}
                  disabled={isAdded}
                  aria-pressed={isAdded}
                  className={
                    'km-images__detected-add focusring' +
                    (isAdded ? ' km-images__detected-add--on' : '')
                  }
                >
                  {isAdded ? (
                    <>
                      <Icon name="check" size={11} />
                      <span>Added</span>
                    </>
                  ) : (
                    <>
                      <Icon name="plus" size={11} />
                      <span>Add</span>
                    </>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </Card>

      <div className="km-images__capture-cta">
        <button
          type="button"
          onClick={onAddAll}
          className="km-btn km-btn--gold km-btn--md km-btn--full focusring"
        >
          Add all to bank
        </button>
        <button
          type="button"
          onClick={onBack}
          className="km-btn km-btn--ghost km-btn--md focusring"
        >
          New capture
        </button>
      </div>
    </div>
  );
}
