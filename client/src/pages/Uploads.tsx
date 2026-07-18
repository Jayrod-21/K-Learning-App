/**
 * Uploads — `/uploads`, the U1 "front door" for user-uploaded books
 * (`db/docs/PDF_UPLOAD_DESIGN.md` §"REVISION"). Lists this user's uploads
 * (title, type, status pill, page count/size, date); tapping a row opens the
 * view-only page viewer at `/uploads/:id` (pages/UploadViewer.tsx); each row
 * also carries a confirm-gated delete. Reachable from Review → Uploads (the
 * library row — F-039 moved this area out of Settings) and from the reader's
 * "view original scan" flow; the upload modal below is where a new book
 * lands.
 *
 * Listing filter (F-058, "show only the PDF versions"): the server discards
 * the ORIGINAL zip/PDF at ingest (migration 041 — only the normalized page
 * images survive, and no source-format column exists), so "the PDF version"
 * can only honestly mean "the viewable page-image rendition" every
 * successful upload now has. `hasViewableRendition` below therefore keeps
 * rows that have pages — or are still on their way to having them
 * (`processing`) or need user attention (`failed`) — and DROPS rendition-
 * less ghosts: `ready` rows with no pages (pre-041 legacy rows whose PDF
 * blob was dropped and that were never re-uploaded). Those ghosts render a
 * viewer that can never show anything; hiding them is the filter's whole
 * value. F-058 is done-as-respecced to this viewable-rendition filter; a
 * literal source-format filter needs the server to retain `source_format`
 * first — ticket F-109.
 *
 * Threat model: all list/delete calls ride the `SameSite=Strict` session
 * cookie (services/api.ts); the server scopes every row to the caller by
 * `user_id` (IDOR-safe — routes/uploads.ts). Server error prose is never
 * echoed — `errorMessageFor` maps to fixed copy.
 *
 * F-128 "Seoul Day & Night" reskin: the header adopts the shared
 * `PageHubHeader` (devices #4/#2, `components/PageHubHeader.tsx`, batch-2
 * fix-pass BLOCKER-2) instead of a bare `Topbar`, each row is a `CityCard`
 * (device #1, `tone="plain"` + `rail`) rather than
 * a flat bordered list, and the empty state gets the `.km-giwa`/
 * `.km-hangul-watermark` texture pairing (devices #3/#6) other reskinned
 * screens use. `.km-rain-sheen` (device #8) ambient-textures the page root;
 * it's a Night-only no-op by its own CSS gate. Purely visual — none of the
 * data flow, filtering, or delete-confirmation logic above changes.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { BackButton } from '../components/BackButton';
import { Bilingual } from '../components/Bilingual';
import { Button } from '../components/Button';
import { CityCard } from '../components/CityCard';
import { ErrorCard } from '../components/ErrorCard';
import { Icon } from '../components/Icon';
import { PageHubHeader } from '../components/PageHubHeader';
import { Pill, type PillTone } from '../components/Pill';
import { UploadTypeModal } from '../components/UploadTypeModal';
import { useToast } from '../components/useToast';
import { errorMessageFor } from '../lib/errorCopy';
import { navItem } from '../lib/nav';
import { ApiError } from '../services/api';
import { deleteUpload, listUploads } from '../services/uploads';
import type { BookUpload, BookUploadStatus, BookUploadType } from '../types/domain';
import './Uploads.css';

const UPLOADS_NAV = navItem('uploads');

/** Parent-tab name source — nav.ts owns the pair (F-043: "Library"). */
const LIBRARY_NAV = navItem('review');

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
  comic: { en: 'Picture / Comic / Manga', kr: '만화 · 그림책' },
};

function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * F-058 listing filter — see the module header for the full disposition.
 * Keeps every row that has (or is on its way to / failed on the way to) a
 * viewable page-image rendition; drops `ready`-with-no-pages ghosts, which
 * have NO rendition at all (pre-041 legacy rows — their single-PDF blob was
 * dropped by the migration and tapping them opens a viewer that can never
 * render a page).
 */
function hasViewableRendition(upload: BookUpload): boolean {
  if (upload.status !== 'ready') return true;
  return upload.pageCount !== undefined && upload.pageCount > 0;
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
        setRows(data.filter(hasViewableRendition));
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
      // Destructive-action gate: if `window` is ever undefined (SSR, exotic
      // test env), fail CLOSED — an unconfirmable irreversible delete must
      // not proceed by default.
      const ok =
        typeof window !== 'undefined'
          ? window.confirm(`Delete "${upload.title}"? This cannot be undone.`)
          : false;
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
    <section
      className="screen km-uploads km-rain-sheen"
      aria-labelledby="km-uploads-title"
    >
      {/* F-024 — canonical parent is the Review library index (the row that
          links here), so an explicit `to` beats history-back: it lands right
          no matter how the user arrived (reader flow, deep link, refresh). */}
      <BackButton to="/review" label={LIBRARY_NAV.label} />

      {/* F-128 devices #4/#2 — the shared hub-header recipe (batch-2
          fix-pass BLOCKER-2, components/PageHubHeader.tsx). */}
      <PageHubHeader
        titleId="km-uploads-title"
        eyebrow={<Bilingual en={UPLOADS_NAV.eyebrow} kr={UPLOADS_NAV.krEyebrow} />}
        heading={<Bilingual en="Uploads" kr="업로드" />}
      />

      <Button
        variant="gold"
        size="md"
        fullWidth
        leadingIcon={<Icon name="upload" size={14} />}
        data-tour="uploads-new"
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
        // F-128 devices #3/#6 — the giwa roof-tile texture + a faint hangul
        // watermark dress the empty state, matching Today/Progress's empty
        // states, rather than a bare paragraph.
        <p
          className="km-reference__empty km-giwa km-hangul-watermark"
          data-glyph="책"
        >
          <Bilingual
            en="No uploads yet. Upload a scanned book (PDF or zip) to get started."
            kr="아직 업로드가 없어요. 스캔한 책(PDF 또는 zip)을 업로드해 보세요."
          />
        </p>
      ) : (
        <ul className="km-uploads__list">
          {rows.map((upload) => {
            const status = STATUS_META[upload.status];
            const kind = TYPE_META[upload.type];
            const pending = pendingDeleteId === upload.id;
            return (
              <li key={upload.id} className="km-uploads__row">
                {/* F-128 device #1/#2 — each row is its own CityCard
                    (neon signboard / hanji paper) with the leading-edge
                    DancheongRail, replacing the old single flat bordered
                    list. `tone="plain"` — an upload row carries no skill
                    color of its own. */}
                <CityCard tone="plain" rail className="km-uploads__card">
                  <div className="km-resources__list-row">
                    <button
                      type="button"
                      className="km-resources__list-open focusring"
                      onClick={() => {
                        // Guard alongside `disabled` below (belt-and-suspenders,
                        // matches the delete button's own `disabled={pending}`):
                        // without this, a click landing between "delete request
                        // sent" and "row removed from `rows`" could navigate into
                        // an id that's about to vanish server-side.
                        if (pending) return;
                        navigate(`/uploads/${upload.id}`);
                      }}
                      disabled={pending}
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
                </CityCard>
              </li>
            );
          })}
        </ul>
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
