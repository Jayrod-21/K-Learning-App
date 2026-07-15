/**
 * UploadTypeModal — the "upload a book" flow (U1b client, PAGE-IMAGE
 * book-upload feature, `db/docs/PDF_UPLOAD_DESIGN.md` §"REVISION"). A
 * two-step `Sheet` (bottom modal — `useModalA11y` via `Sheet`, so
 * focus-trap / Esc / body-scroll-lock / focus-restore are inherited, not
 * reimplemented):
 *
 *   1. Type   — vocab / grammar / both / dialogue / literature, bilingual
 *      chips. This is what U2's extraction eventually tags the content with.
 *   2. File + title — a file picker accepting EITHER a vFlat zip export (a
 *      zip of page images — Jared's real scans) OR a plain PDF
 *      (`accept="application/pdf,application/zip,.zip,.pdf"`), plus a title
 *      field defaulting to the filename; submitting calls `uploadBook`. The
 *      server normalizes either into ordered page images before this ever
 *      reaches the viewer.
 *
 * Shared by Settings (the "Upload a book" row) and the Uploads page (its own
 * "+ Upload" entry) so both surfaces get the identical flow. On success the
 * fresh `BookUpload` is handed to the caller via `onUploaded` so it can
 * splice it into whatever list it's showing without a refetch.
 *
 * Progress: a real (up to ~300 MB) book upload can run minutes on a slow
 * connection, so the Upload button's label swaps to "Uploading… NN%" driven
 * by `uploadBook`'s `onProgress` callback (axios's real
 * `XMLHttpRequest.upload` progress, not a simulated ramp) — `role="status"
 * aria-live="polite"` on the label announces it to AT the same way the
 * static "Uploading…" text always did.
 *
 * Threat model:
 *   - `checkBookFile` is a client convenience pre-check only (see
 *     services/uploads.ts's header) — it saves the user a doomed round-trip
 *     for an obviously-wrong file, but the server's magic-byte sniff
 *     (`PK\x03\x04` zip / `%PDF-` pdf) + ~300 MiB size cap are the real
 *     defence and still run on every request. Server failures map to fixed
 *     copy via `bookUploadErrorMessage` — never echoed.
 *   - Abort discipline: the in-flight `uploadBook` call is aborted whenever
 *     the modal closes or unmounts mid-request, and every state write after
 *     the `await` is guarded on the controller's own signal, so a late
 *     settle after close/unmount is a no-op (mirrors the PATCH/prefs pattern
 *     in pages/Settings.tsx).
 */
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
} from 'react';
import { Bilingual } from './Bilingual';
import { Button } from './Button';
import { ErrorCard } from './ErrorCard';
import { Eyebrow } from './Eyebrow';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { bookUploadErrorMessage } from '../lib/errorCopy';
import { checkBookFile, uploadBook } from '../services/uploads';
import type { BookUpload, BookUploadType } from '../types/domain';

export interface UploadTypeModalProps {
  open: boolean;
  onClose: () => void;
  /** Fired with the fresh row right after a successful `POST /uploads`. */
  onUploaded: (upload: BookUpload) => void;
}

interface TypeOption {
  id: BookUploadType;
  en: string;
  kr: string;
}

const TYPE_OPTIONS: ReadonlyArray<TypeOption> = [
  { id: 'vocab', en: 'Vocabulary', kr: '단어' },
  { id: 'grammar', en: 'Grammar', kr: '문법' },
  { id: 'both', en: 'Vocab + grammar', kr: '단어 + 문법' },
  { id: 'dialogue', en: 'Dialogue', kr: '대화' },
  { id: 'literature', en: 'Literature', kr: '문학' },
];

/**
 * Matches the server's `UploadBodySchema` title cap exactly (`routes/
 * uploads.ts`'s `z.string().trim().min(1).max(200)`, backed by migration
 * 040's `ck_book_uploads_title_length` CHECK). A client-side `maxLength`
 * stops the round-trip a too-long title used to dead-end into: the field
 * previously had no cap, so a >200-char title always 400'd server-side, and
 * that 400 rendered the SAME "isn't a valid PDF" copy as an actual bad file
 * — wrong, unactionable advice for a title problem. The server remains
 * authoritative (this is UX, not the security boundary — same posture as
 * `checkBookFile`).
 */
const TITLE_MAX_LENGTH = 200;

/** Filename minus a trailing `.pdf`/`.zip` (case-insensitive) — the title default. */
function titleFromFilename(name: string): string {
  return name.replace(/\.(pdf|zip)$/i, '');
}

export function UploadTypeModal({
  open,
  onClose,
  onUploaded,
}: UploadTypeModalProps): JSX.Element {
  const [type, setType] = useState<BookUploadType | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Reset the whole flow whenever the modal closes, so re-opening always
  // starts fresh at the type step, and abort any upload still in flight.
  useEffect(() => {
    if (open) return;
    ctrlRef.current?.abort();
    setType(null);
    setFile(null);
    setTitle('');
    setTitleTouched(false);
    setError(null);
    setUploading(false);
    setUploadProgress(null);
  }, [open]);

  // Abort on unmount too — belt-and-suspenders alongside the close-driven
  // reset above, in case a parent unmounts this without flipping `open`.
  useEffect(() => {
    return () => {
      ctrlRef.current?.abort();
    };
  }, []);

  function onFileChange(e: ChangeEvent<HTMLInputElement>): void {
    const picked = e.target.files?.[0] ?? null;
    // Reset the input so picking the SAME file again still fires `change`.
    e.target.value = '';
    if (!picked) return;
    const precheck = checkBookFile(picked);
    if (precheck) {
      setError(precheck);
      return;
    }
    setError(null);
    setFile(picked);
    if (!titleTouched) setTitle(titleFromFilename(picked.name));
  }

  async function submit(): Promise<void> {
    if (!type || !file || uploading) return;
    const trimmedTitle = title.trim();
    if (trimmedTitle === '') {
      setError('Give the book a title.');
      return;
    }
    // Defense-in-depth alongside the input's `maxLength` (which stops normal
    // typing/pasting but not every programmatic path) — mirrors the
    // blank-title check above rather than letting an oversized title reach
    // the network and 400.
    if (trimmedTitle.length > TITLE_MAX_LENGTH) {
      setError(`Title is too long — ${String(TITLE_MAX_LENGTH)} characters max.`);
      return;
    }
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setUploading(true);
    // Stays `null` (renders a bare "Uploading…") until the first real
    // `onProgress` tick — before any bytes are confirmed sent (DNS/TLS/
    // connection setup) a "0%" would imply more certainty than we have.
    setUploadProgress(null);
    setError(null);
    try {
      const upload = await uploadBook(file, type, trimmedTitle, ctrl.signal, (percent) => {
        if (ctrl.signal.aborted) return;
        setUploadProgress(percent);
      });
      if (ctrl.signal.aborted) return;
      onUploaded(upload);
      onClose();
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setError(bookUploadErrorMessage(err));
    } finally {
      if (!ctrl.signal.aborted) {
        setUploading(false);
        setUploadProgress(null);
      }
    }
  }

  const step: 'type' | 'file' = type === null ? 'type' : 'file';

  return (
    <Sheet open={open} onClose={onClose} ariaLabel="Upload a book">
      <div className="km-review__sheetBody">
        <div className="km-review__sheetHead">
          <div>
            <Eyebrow>
              <Bilingual en="Upload a book" kr="책 업로드" />
            </Eyebrow>
            <div className="kr-display km-review__sheetTitle">
              {step === 'type' ? (
                <Bilingual en="What kind of content?" kr="어떤 종류인가요?" />
              ) : (
                <Bilingual en="Choose a file" kr="파일 선택" />
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close upload"
          >
            <Icon name="close" size={14} />
          </Button>
        </div>

        <hr className="hr-double km-review__sheetRule" />

        {step === 'type' ? (
          <ul className="km-resources__pick-list">
            {TYPE_OPTIONS.map((opt) => (
              <li key={opt.id}>
                <Button
                  variant="ghost"
                  size="md"
                  fullWidth
                  onClick={() => {
                    setType(opt.id);
                  }}
                >
                  <Bilingual en={opt.en} kr={opt.kr} />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setType(null);
                setError(null);
              }}
            >
              <span
                style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}
              >
                <Icon name="arrow-right" size={12} />
              </span>
              <span>
                <Bilingual en="Back" kr="뒤로" compact />
              </span>
            </Button>

            <div className="km-field" style={{ marginTop: 12 }}>
              <span className="km-field__label" id="km-upload-file-label">
                Book file
              </span>
              <p style={{ fontSize: '0.8125rem', color: 'var(--paper-dim)', margin: '2px 0 8px' }}>
                <Bilingual
                  en="Upload a scanned book (a PDF or a vFlat zip of page images)"
                  kr="스캔한 책을 업로드하세요 (PDF 또는 vFlat 페이지 이미지 zip)"
                />
              </p>
              <Button
                variant="ghost"
                size="md"
                fullWidth
                onClick={() => fileInputRef.current?.click()}
                leadingIcon={<Icon name="upload" size={14} />}
              >
                {file ? file.name : 'Choose a PDF or zip…'}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,application/zip,.zip,.pdf"
                hidden
                aria-labelledby="km-upload-file-label"
                onChange={onFileChange}
              />
            </div>

            <div className="km-field">
              <label className="km-field__label" htmlFor="km-upload-title">
                Title
              </label>
              <input
                id="km-upload-title"
                type="text"
                className="km-field__input"
                value={title}
                maxLength={TITLE_MAX_LENGTH}
                onChange={(e) => {
                  setTitleTouched(true);
                  setTitle(e.target.value);
                }}
                placeholder="Book title"
              />
            </div>

            {error ? <ErrorCard message={error} /> : null}

            <Button
              variant="gold"
              size="md"
              fullWidth
              onClick={() => {
                void submit();
              }}
              disabled={!file || title.trim() === '' || uploading}
              aria-busy={uploading}
            >
              <span role="status" aria-live="polite">
                {uploading ? (
                  <Bilingual
                    en={
                      uploadProgress !== null
                        ? `Uploading… ${String(uploadProgress)}%`
                        : 'Uploading…'
                    }
                    kr={
                      uploadProgress !== null
                        ? `업로드 중… ${String(uploadProgress)}%`
                        : '업로드 중…'
                    }
                    compact
                  />
                ) : (
                  <Bilingual en="Upload" kr="업로드" compact />
                )}
              </span>
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
