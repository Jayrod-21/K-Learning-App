/**
 * Uploads — `/uploads`, the U1 "front door" for user-uploaded book PDFs
 * (`db/docs/PDF_UPLOAD_DESIGN.md` §"U1 → U1b client"). Lists every upload
 * (title, type, status pill, page count/size, date); tapping a row opens the
 * view-only PDF viewer at `/uploads/:id` (pages/UploadViewer.tsx); each row
 * also carries a confirm-gated delete. Reachable from Settings → Uploads
 * ("See all uploads") — and IS where that Settings screen's own "Upload a
 * book" button's result shows up.
 *
 * Threat model: all list/delete calls ride the `SameSite=Strict` session
 * cookie (services/api.ts); the server scopes every row to the caller by
 * `user_id` (IDOR-safe — routes/uploads.ts). Server error prose is never
 * echoed — `errorMessageFor` maps to fixed copy.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bilingual } from '../components/Bilingual';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ErrorCard } from '../components/ErrorCard';
import { Icon } from '../components/Icon';
import { Pill, type PillTone } from '../components/Pill';
import { Topbar } from '../components/Topbar';
import { UploadTypeModal } from '../components/UploadTypeModal';
import { useToast } from '../components/useToast';
import { errorMessageFor } from '../lib/errorCopy';
import { navItem } from '../lib/nav';
import { ApiError } from '../services/api';
import { deleteUpload, listUploads } from '../services/uploads';
import type { BookUpload, BookUploadStatus, BookUploadType } from '../types/domain';

const UPLOADS_NAV = navItem('uploads');

const STATUS_META: Record<
  BookUploadStatus,
  { en: string; kr: string; tone: PillTone }
> = {
  processing: { en: 'Processing', kr: '처리 중', tone: 'default' },
  ready: { en: 'Ready', kr: '완료', tone: 'green' },
  failed: { en: 'Failed', kr: '실패', tone: 'red' },
};

const TYPE_META: Record<BookUploadType, { en: string; kr: string }> = {
  vocab: { en: 'Vocabulary', kr: '단어' },
  grammar: { en: 'Grammar', kr: '문법' },
  both: { en: 'Vocab + grammar', kr: '단어 + 문법' },
  dialogue: { en: 'Dialogue', kr: '대화' },
  literature: { en: 'Literature', kr: '문학' },
};

function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function Uploads(): JSX.Element {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [rows, setRows] = useState<BookUpload[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  const load = useCallback((): void => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    setLoading(true);
    setError(null);
    listUploads(ctrl.signal)
      .then((data) => {
        if (ctrl.signal.aborted) return;
        setRows(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(errorMessageFor(err, 'Could not load your uploads.'));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    // `load()` is a function call, not a direct setState, so the effect
    // itself never trips `react-hooks/set-state-in-effect` (same reasoning
    // as ReviewGrammar's `load` effect).
    load();
    return () => {
      ctrlRef.current?.abort();
    };
  }, [load]);

  const remove = useCallback(
    async (upload: BookUpload): Promise<void> => {
      const ok =
        typeof window !== 'undefined'
          ? window.confirm(`Delete "${upload.title}"? This cannot be undone.`)
          : true;
      if (!ok) return;
      setPendingDeleteId(upload.id);
      try {
        await deleteUpload(upload.id);
        setRows((prev) => prev.filter((r) => r.id !== upload.id));
      } catch (err) {
        toast({
          message: errorMessageFor(err, 'Could not delete that upload.'),
          tone: 'error',
        });
      } finally {
        setPendingDeleteId(null);
      }
    },
    [toast],
  );

  return (
    <section className="screen km-uploads" aria-labelledby="km-uploads-title">
      <Topbar
        krTitle="업로드"
        title="Uploads"
        titleId="km-uploads-title"
        eyebrow={
          <Bilingual en={UPLOADS_NAV.eyebrow} kr={UPLOADS_NAV.krEyebrow} />
        }
      />

      <Button
        variant="gold"
        size="md"
        fullWidth
        leadingIcon={<Icon name="upload" size={14} />}
        onClick={() => {
          setModalOpen(true);
        }}
      >
        <Bilingual en="Upload a book" kr="책 업로드" />
      </Button>

      {loading && rows.length === 0 ? (
        <div className="km-grammar__state" role="status">
          <Bilingual en="Loading your uploads…" kr="업로드를 불러오는 중…" />
        </div>
      ) : error ? (
        <ErrorCard message={error} onRetry={load} />
      ) : rows.length === 0 ? (
        <p className="km-reference__empty">
          <Bilingual
            en="No uploads yet. Upload a scanned book PDF to get started."
            kr="아직 업로드가 없어요. 스캔한 책 PDF를 업로드해 보세요."
          />
        </p>
      ) : (
        <Card className="km-reference__list" variant="flat">
          <ul>
            {rows.map((upload) => {
              const status = STATUS_META[upload.status];
              const kind = TYPE_META[upload.type];
              const pending = pendingDeleteId === upload.id;
              return (
                <li key={upload.id} className="km-reference__row">
                  <div className="km-resources__list-row">
                    <button
                      type="button"
                      className="km-resources__list-open focusring"
                      onClick={() => {
                        navigate(`/uploads/${upload.id}`);
                      }}
                      aria-label={`View ${upload.title}`}
                    >
                      <span className="km-reference__row-en">
                        {upload.title}
                      </span>
                      <span className="km-reference__row-kr">
                        <Bilingual en={kind.en} kr={kind.kr} compact />
                      </span>
                      <Pill tone={status.tone}>
                        <Bilingual en={status.en} kr={status.kr} compact />
                      </Pill>
                      <span className="km-resources__pager-count">
                        {upload.pageCount !== undefined
                          ? `${String(upload.pageCount)} pp · `
                          : ''}
                        {formatBytes(upload.byteSize)} ·{' '}
                        {formatDate(upload.createdAt)}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void remove(upload);
                      }}
                      disabled={pending}
                      aria-label={`Delete ${upload.title}`}
                    >
                      <Icon name="trash" size={14} />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <UploadTypeModal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
        }}
        onUploaded={(upload) => {
          setRows((prev) => [upload, ...prev.filter((r) => r.id !== upload.id)]);
          toast({ message: 'Uploaded — now processing.', tone: 'success' });
        }}
      />
    </section>
  );
}
