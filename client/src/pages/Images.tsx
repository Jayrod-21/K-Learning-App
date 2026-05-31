/**
 * Images screen — Papago-style OCR mining (Pass 8: live `/images/ocr`).
 *
 * Two view modes driven by `current` (capture id | null):
 *
 *   - LIST view (`current === null`):
 *       UploadCard (dashed border + vermilion camera circle + hidden file
 *       picker), "Or try a sample" list, "Recent captures" grid. Picking a
 *       file uploads it to `POST /images/ocr` (Claude Vision OCR); on success
 *       the new capture is prepended to the history and opened, on failure an
 *       inline `role="alert"` surfaces the server message (bad file / daily
 *       cap / upstream). An uploading state disables the card and flags
 *       `aria-busy`.
 *
 *   - CAPTURE view (`current !== null`):
 *       Back ghost + "N words detected" gold pill, the REAL photo
 *       (`<img src={cap.blobUrl}>`) — NO bounding-box overlay (locked
 *       decision: Vision returns words, not coordinates). The detected-word
 *       list is the sole "tap a word" surface: each row opens `<WordPopover>`
 *       so the gesture matches Reading, and an Add/Added toggle banks it into
 *       the per-capture session set.
 *
 * Local-only banking: the per-capture added-set + Add/Added is session state.
 * Server-side vocab-banking from OCR shares the deferred KRDICT → vocab_entries
 * mapping (FU-NF-33), so this pass does NOT write to the bank — it only tracks
 * the visual "added" state for the current session.
 *
 * Threat model:
 *   - The upload path sends a raw `File` to the server, which enforces the
 *     8 MB cap, the jpeg/png/webp mime allowlist, a magic-byte sniff, and the
 *     per-user daily Vision cap. The client's `accept="image/*"` is a
 *     convenience filter only — the browser lets other files through, and the
 *     server is authoritative. A failed upload never breaks the screen: the
 *     list stays rendered and the error shows inline with a dismiss.
 *   - All caption/word text renders as React children — XSS-safe. The server
 *     response MUST keep that contract (text, not HTML). `blobUrl` is built
 *     from the server id, never from free-form text.
 */
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
} from 'react';
import { Card } from '../components/Card';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { Pill } from '../components/Pill';
import { SealStamp } from '../components/SealStamp';
import { Topbar } from '../components/Topbar';
import { WordPopover, type WordPopoverData } from '../components/WordPopover';
import { loadImagesMock } from '../data/mocks/images';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { ApiError } from '../services/api';
import { fetchImage, fetchImages, uploadImage } from '../services/images';
import type { ImageCapture, OcrWord } from '../types/domain';

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

export default function Images(): JSX.Element {
  const result = useEndpointOrMock<ImageCapture[]>('images', loadImagesMock, {
    realFn: () => fetchImages(),
  });

  const [current, setCurrent] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  // Captures created this session (uploads) live here, prepended so they win
  // over the server list. Keyed render below merges these ahead of the
  // fetched/mock captures and de-dupes by id.
  const [uploaded, setUploaded] = useState<ImageCapture[]>([]);
  // Words fetched lazily when opening a list capture whose summary carried no
  // words (the real `GET /images` list omits them — see services/images.ts).
  // Keyed by capture id; merged into the rendered capture.
  const [wordsById, setWordsById] = useState<Record<string, OcrWord[]>>({});
  // One added-set per capture — keying by capture id keeps state honest when
  // the learner ping-pongs between captures. Each value is a Set<string> of
  // OCR word ids added to the bank in the current session.
  const [addedByCapture, setAddedByCapture] = useState<
    Record<string, Set<string>>
  >({});
  const [popData, setPopData] = useState<WordPopoverData | null>(null);
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Seed `history` from the loaded captures once data arrives — the first
  // capture's id is the most-recent placeholder so the "Recent captures" grid
  // never renders empty on a fresh boot. Sync-to-external-system case (same
  // shape as AuthProvider's probe); user-pushed entries win over the seed.
  useEffect(() => {
    const captures = result.data;
    if (!captures || captures.length === 0) return;
    setHistory((prev) => (prev.length > 0 ? prev : [captures[0].id]));
  }, [result.data]);

  // Merge session uploads ahead of the loaded list, de-duping by id (an upload
  // is authoritative over a later refetch of the same capture).
  const loaded = result.data ?? [];
  const seen = new Set<string>();
  const captures: ImageCapture[] = [];
  for (const c of [...uploaded, ...loaded]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    captures.push(c);
  }

  const baseCap = current
    ? captures.find((c) => c.id === current) ?? null
    : null;
  // Overlay any lazily-fetched words onto the selected capture.
  const cap: ImageCapture | null =
    baseCap && wordsById[baseCap.id]
      ? { ...baseCap, words: wordsById[baseCap.id] }
      : baseCap;

  const pushHistory = (id: string): void => {
    setHistory((h) => (h.includes(id) ? h : [id, ...h].slice(0, 6)));
  };

  const openCapture = (capture: ImageCapture): void => {
    setCurrent(capture.id);
    pushHistory(capture.id);
    // The real list summary omits words; hydrate them lazily so the detected-
    // word list isn't empty. Mock + freshly-uploaded captures already carry
    // words, so this only fires for server-list captures we haven't expanded.
    if (capture.words.length === 0 && !wordsById[capture.id]) {
      void hydrateWords(capture.id);
    }
  };

  const hydrateWords = async (id: string): Promise<void> => {
    try {
      const full = await fetchImage(id);
      setWordsById((prev) => ({ ...prev, [id]: full.words }));
    } catch {
      // A failed hydration leaves the capture's word list empty rather than
      // breaking the view; the photo + caption still render. The user can go
      // back and reopen to retry. We deliberately don't surface a blocking
      // error here — the capture is still useful without the word list.
    }
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

  const onUpload = async (file: File): Promise<void> => {
    setUploadError(null);
    setUploading(true);
    try {
      const capture = await uploadImage(file);
      // Prepend so the new capture wins over any later refetch, then open it.
      setUploaded((prev) => [capture, ...prev.filter((c) => c.id !== capture.id)]);
      setCurrent(capture.id);
      pushHistory(capture.id);
    } catch (err) {
      setUploadError(messageForUploadError(err));
    } finally {
      setUploading(false);
    }
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
          uploading={uploading}
          uploadError={uploadError}
          onDismissError={() => {
            setUploadError(null);
          }}
          onPick={openCapture}
          onUpload={(file) => {
            void onUpload(file);
          }}
        />
      )}

      {popData ? (
        <WordPopover
          data={popData}
          onClose={() => {
            setPopData(null);
          }}
          onAdd={() => {
            // Marker — the popover's own Add button handles its visual state.
            // The per-capture added-set is driven by the row button so there's
            // a single source of truth (the visible Added pill on the row).
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * Map an `ApiError` (or unknown throw) from the upload onto a user-facing
 * message. The server's domain message rides through for known shapes; we
 * special-case the status codes the upload path produces so the copy is
 * actionable even when the server message is terse.
 */
function messageForUploadError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      return (
        err.message ||
        "You've hit today's image limit. Try again tomorrow."
      );
    }
    if (err.status === 413) {
      return 'That image is too large. Pick one under 8 MB.';
    }
    if (err.status === 400) {
      return (
        err.message ||
        'That file isn’t a supported image. Use a JPEG, PNG, or WebP.'
      );
    }
    if (err.status === 502) {
      return 'OCR is temporarily unavailable. Try again shortly.';
    }
    if (err.code === 'network') {
      return 'Network unreachable. Check your connection and try again.';
    }
    return err.message || 'Upload failed. Try again.';
  }
  return 'Upload failed. Try again.';
}

function wordToPopover(w: OcrWord): WordPopoverData {
  // `w.gloss` is the OCR-source caption (e.g. "americano coffee" from a sign).
  // We surface it as the example KR sentence to preserve provenance — the
  // learner sees the original detected phrase, not a stripped-down gloss.
  // `notes` carries the caption-source attribution.
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
  uploading,
  uploadError,
  onDismissError,
  onPick,
  onUpload,
}: {
  captures: ImageCapture[];
  history: string[];
  uploading: boolean;
  uploadError: string | null;
  onDismissError: () => void;
  onPick: (capture: ImageCapture) => void;
  onUpload: (file: File) => void;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const onFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    // Reset the input value so picking the SAME file again re-fires `change`
    // (browsers suppress an unchanged-value change event otherwise).
    e.target.value = '';
    if (file) onUpload(file);
  };

  return (
    <div className="km-images__list">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        aria-busy={uploading}
        className="km-images__upload focusring"
      >
        <span className="km-images__upload-icon" aria-hidden="true">
          {uploading ? (
            // Decorative — the busy state is announced via the button's
            // `aria-busy` + the swapped title copy, so the spinner stays
            // inside the `aria-hidden` icon wrapper.
            <span
              className="km-images__upload-spinner"
              data-testid="upload-spinner"
              style={{
                display: 'inline-block',
                width: 22,
                height: 22,
                borderRadius: '50%',
                border: '2px solid currentColor',
                borderRightColor: 'transparent',
                animation: 'km-spin 0.8s linear infinite',
              }}
            />
          ) : (
            <Icon name="camera" size={26} />
          )}
        </span>
        <div className="km-images__upload-title">
          {uploading ? 'Reading your image…' : 'Capture or upload'}
        </div>
        <p className="km-images__upload-hint">
          Photo of signage, a menu, a book page — anything with Korean text.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          aria-label="Upload an image to mine for Korean words"
          hidden
          onChange={onFileChange}
        />
      </button>

      {uploadError ? (
        <Card className="km-images__upload-error" role="alert">
          <div className="km-images__upload-error-body">
            <Icon name="info" size={16} />
            <p className="km-images__upload-error-text">{uploadError}</p>
          </div>
          <button
            type="button"
            onClick={onDismissError}
            className="km-btn km-btn--ghost km-btn--sm focusring"
          >
            Dismiss
          </button>
        </Card>
      ) : null}

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
                    onPick(c);
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
                      onPick(cap);
                    }}
                    className="km-images__recent-card focusring"
                  >
                    <ThumbCapture cap={cap} />
                    <div className="km-images__recent-meta">
                      <div className="kr km-images__recent-kr">{cap.name}</div>
                      <div className="km-images__recent-en">
                        {cap.caption_en}
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

/**
 * Thumbnail — renders the real photo when `blobUrl` is present, otherwise the
 * mock's gradient + a glimpse of its placeholder scene text. The `<img>` is
 * decorative here (the meta row carries the accessible name), so it's marked
 * `aria-hidden`.
 */
function ThumbCapture({
  cap,
  small = false,
}: {
  cap: ImageCapture;
  small?: boolean;
}): JSX.Element {
  if (cap.blobUrl) {
    return (
      <div
        className={
          'km-images__thumb' + (small ? ' km-images__thumb--small' : '')
        }
        aria-hidden="true"
      >
        <img
          src={cap.blobUrl}
          alt=""
          className="km-images__thumb-img"
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </div>
    );
  }

  // Mock fallback — render the first 2 (small) or 4 placeholder scene lines.
  const visible = (cap.scene ?? []).slice(0, small ? 2 : 4);
  return (
    <div
      className={
        'km-images__thumb' + (small ? ' km-images__thumb--small' : '')
      }
      style={cap.gradient ? { background: cap.gradient } : undefined}
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
// Capture view — real photo + detected word list (NO boxes).
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
          <Icon name="translate" size={11} /> {cap.words.length}{' '}
          {cap.words.length === 1 ? 'word' : 'words'} detected
        </Pill>
      </div>

      <Card className="km-images__capture-card">
        <div className="km-images__capture-frame">
          {cap.blobUrl ? (
            <img
              src={cap.blobUrl}
              alt={cap.caption_en}
              className="km-images__capture-img"
              style={{
                display: 'block',
                width: '100%',
                height: 'auto',
                objectFit: 'contain',
              }}
            />
          ) : (
            // Mock fallback — no real bytes, so paint the gradient + the
            // placeholder scene text the prototype shipped with.
            <div
              className="km-images__capture-placeholder"
              style={cap.gradient ? { background: cap.gradient } : undefined}
              role="img"
              aria-label={cap.caption_en}
            >
              {(cap.scene ?? []).map((line, i) => (
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
            </div>
          )}
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
        {cap.words.length === 0 ? (
          <p className="km-images__detected-empty">
            No words detected in this image.
          </p>
        ) : (
          <ul className="km-images__detected-list">
            {cap.words.map((w, i) => {
              const isAdded = added.has(w.id);
              // A1 OCR-entrance adaptation: cascade rows in 100ms apart. Cap
              // the stagger at 12 rows so a long detection list doesn't make
              // the tail rows wait (>1.2s) before appearing — past the cap
              // they all share the final delay and land together. The entrance
              // is a single brief `rise` (see index.css), reduced-motion-safe.
              const enterDelayMs = Math.min(i, 12) * 100;
              return (
                <li
                  key={w.id}
                  className="km-images__detected-row km-images__detected-row--enter"
                  style={{ animationDelay: `${String(enterDelayMs)}ms` }}
                >
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
        )}
      </Card>

      <div className="km-images__capture-cta">
        <button
          type="button"
          onClick={onAddAll}
          disabled={cap.words.length === 0}
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
