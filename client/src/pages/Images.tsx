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
 * Banking (FU-NF-33): tapping Add on a detected word fires `mineWord` against
 * `POST /vocab/mine`. OCR words carry a Korean surface + gloss but no `/define`
 * lookup, so they mine by lemma (`krdictEntryId` omitted → the server keys the
 * shared `user_mined` entry on `lemma-{lemma}`). The per-capture added-set
 * flips OPTIMISTICALLY so the Added pill lands instantly; a failed bank rolls
 * the word back out of the set and surfaces a non-blocking error toast — a
 * server hiccup never breaks the capture view.
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
import { Bilingual } from '../components/Bilingual';
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
import { navItem } from '../lib/nav';
import { ApiError } from '../services/api';
import { fetchImage, fetchImages, uploadImage } from '../services/images';
import { mineWord } from '../services/vocab';
import { useToast } from '../components/useToast';
import type { ImageCapture, OcrWord } from '../types/domain';

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/** Page eyebrow source — nav.ts owns the en/kr pair (P3b Batch A). */
const IMAGES_NAV = navItem('images');

/**
 * Stable per-word key inside ONE capture's word list. The wire sends NO word
 * id (`ImageWordDTO` is `kr/en/gloss/pos` only — see services/images.ts), so
 * the key is derived from what the wire actually sends: the word's position
 * in the capture's list plus its text. A capture's word list is immutable
 * once fetched, so `index:kr` is stable across re-renders and unique even
 * when the same word is detected twice in one photo. Keying on a non-existent
 * `id` (the old code) collapsed every word onto `undefined` — banking one
 * word marked ALL of them "Added" and blocked further banking.
 */
function ocrWordKey(word: OcrWord, index: number): string {
  return `${String(index)}:${word.kr}`;
}

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
  // derived per-word keys (`ocrWordKey`) added to the bank this session —
  // the wire sends no word id to key on.
  const [addedByCapture, setAddedByCapture] = useState<
    Record<string, Set<string>>
  >({});
  const [popData, setPopData] = useState<WordPopoverData | null>(null);
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const { toast } = useToast();

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

  /**
   * Add a detected word to the bank (FU-NF-33). OCR words have no `/define`
   * lookup, so we mine by lemma (`krdictEntryId` omitted). The per-capture
   * added-set flips optimistically — the Added pill lands instantly — then
   * `mineWord` fires. A failed bank rolls the word back out of the set and
   * surfaces a non-blocking error toast so a server hiccup never breaks the
   * capture view. Already-added words short-circuit (idempotent on the UI
   * side, mirroring the server's idempotent mine). Server error text is never
   * echoed; the toast copy is fixed here.
   */
  const addWord = (capId: string, word: OcrWord, wordKey: string): void => {
    let alreadyAdded = false;
    setAddedByCapture((prev) => {
      const existing = prev[capId] ?? new Set<string>();
      if (existing.has(wordKey)) {
        alreadyAdded = true;
        return prev;
      }
      const next = new Set(existing);
      next.add(wordKey);
      return { ...prev, [capId]: next };
    });
    if (alreadyAdded) return;

    void mineWord({
      lemma: word.kr,
      ...(word.en ? { english: word.en } : {}),
      ...(word.pos ? { pos: word.pos } : {}),
    }).catch(() => {
      // Roll the optimistic flip back so the Added pill stays honest, then
      // surface a fixed, non-blocking failure notice (no server text).
      setAddedByCapture((prev) => {
        const existing = prev[capId];
        if (!existing?.has(wordKey)) return prev;
        const next = new Set(existing);
        next.delete(wordKey);
        return { ...prev, [capId]: next };
      });
      toast({ message: "Couldn't bank — try again", tone: 'error' });
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
        krTitle="이미지"
        title="Images"
        titleId="km-images-title"
        // P3b — adopts nav.ts's trimmed pair (was "OCR · mine real-world
        // Korean").
        eyebrow={
          <Bilingual en={IMAGES_NAV.eyebrow} kr={IMAGES_NAV.krEyebrow} />
        }
      />

      {result.loading ? (
        <Card className="km-images__skeleton" aria-busy="true">
          <Eyebrow>
            <Bilingual en="Loading captures" kr="캡처를 불러오는 중" />
          </Eyebrow>
          <div className="km-images__skeleton-line" />
          <div className="km-images__skeleton-line" />
        </Card>
      ) : result.error && captures.length === 0 ? (
        <Card className="km-images__error" role="alert">
          <Eyebrow>
            <Bilingual
              en="Captures unavailable"
              kr="캡처를 불러오지 못했어요"
            />
          </Eyebrow>
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
          onAddOne={(w, wordKey) => {
            addWord(cap.id, w, wordKey);
          }}
          onAddAll={() => {
            cap.words.forEach((w, i) => {
              addWord(cap.id, w, ocrWordKey(w, i));
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
 * Map an `ApiError` (or unknown throw) from the upload onto FIXED user-facing
 * copy keyed on the structured status/code (F-UP-018). Server prose on
 * `err.message` is never echoed — same contract as `lib/errorCopy` and the
 * Login/Writing messageFor lookups.
 */
function messageForUploadError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      return "You've hit today's image limit. Try again tomorrow.";
    }
    if (err.status === 413) {
      return 'That image is too large. Pick one under 8 MB.';
    }
    if (err.status === 400) {
      return 'That file isn’t a supported image. Use a JPEG, PNG, or WebP.';
    }
    if (err.status === 502) {
      return 'OCR is temporarily unavailable. Try again shortly.';
    }
    if (err.code === 'network') {
      return 'Network unreachable. Check your connection and try again.';
    }
    return 'Upload failed. Try again.';
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
          {uploading ? (
            <Bilingual en="Reading your image…" kr="이미지를 읽는 중…" />
          ) : (
            <Bilingual en="Capture or upload" kr="촬영 또는 업로드" />
          )}
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
            <Bilingual en="Dismiss" kr="닫기" compact />
          </button>
        </Card>
      ) : null}

      {captures.length > 0 ? (
        <>
          <Eyebrow className="km-images__group-eyebrow">
            <Bilingual en="Or try a sample" kr="샘플로 해 보기" />
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
            <Bilingual en="Recent captures" kr="최근 캡처" />
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
  onAddOne: (word: OcrWord, wordKey: string) => void;
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
          <span>
            <Bilingual en="Back" kr="뒤로" compact />
          </span>
        </button>
        <Pill tone="gold">
          <Icon name="translate" size={11} />{' '}
          <Bilingual
            en={`${String(cap.words.length)} ${cap.words.length === 1 ? 'word' : 'words'} detected`}
            kr={`단어 ${String(cap.words.length)}개 인식`}
            compact
          />
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

      <Eyebrow className="km-images__list-eyebrow">
        <Bilingual en="Detected words" kr="인식된 단어" />
      </Eyebrow>
      <Card className="km-images__detected">
        {cap.words.length === 0 ? (
          <p className="km-images__detected-empty">
            <Bilingual
              en="No words detected in this image."
              kr="이 이미지에서 인식된 단어가 없어요."
            />
          </p>
        ) : (
          <ul className="km-images__detected-list">
            {cap.words.map((w, i) => {
              // Derived key — the wire sends no word id (see ocrWordKey).
              const wordKey = ocrWordKey(w, i);
              const isAdded = added.has(wordKey);
              // A1 OCR-entrance adaptation: cascade rows in 100ms apart. Cap
              // the stagger at 12 rows so a long detection list doesn't make
              // the tail rows wait (>1.2s) before appearing — past the cap
              // they all share the final delay and land together. The entrance
              // is a single brief `rise` (see index.css), reduced-motion-safe.
              const enterDelayMs = Math.min(i, 12) * 100;
              return (
                <li
                  key={wordKey}
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
                      if (!isAdded) onAddOne(w, wordKey);
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
                        <span>
                          <Bilingual en="Added" kr="추가됨" compact />
                        </span>
                      </>
                    ) : (
                      <>
                        <Icon name="plus" size={11} />
                        <span>
                          <Bilingual en="Add" kr="추가" compact />
                        </span>
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
          <Bilingual en="Add all to bank" kr="모두 모음에 추가" />
        </button>
        <button
          type="button"
          onClick={onBack}
          className="km-btn km-btn--ghost km-btn--md focusring"
        >
          <Bilingual en="New capture" kr="새 캡처" />
        </button>
      </div>
    </div>
  );
}
