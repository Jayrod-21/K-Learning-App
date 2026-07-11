/**
 * Tickets — `/tickets`, the F-023 in-app beta feedback/ticketing surface
 * (P1 beta blocker). The server half (`server/src/routes/tickets.ts`) is
 * already deployed; this page is the client wiring against it.
 *
 * Two views behind the shared `Tabs` primitive:
 *   - **My tickets** (`GET /tickets/mine`) — the caller's own, each row
 *     carrying `version` (needed for the PATCH optimistic-concurrency
 *     contract). Title/body/status are editable inline.
 *   - **Community** (`GET /tickets/community`) — every ticket, author
 *     ANONYMIZED. Windowed client-side via `usePagination`/`ShowMore` (the
 *     feed can be long; see `COMMUNITY_FETCH_LIMIT`).
 *
 * Both lists are fetched unconditionally on mount (independent of which tab
 * is active) so switching tabs is instant and a ticket the caller filed can
 * be opened — with edit rights — from either tab (see `TicketDetail`'s
 * `canEdit` derivation below).
 *
 * Detail is a NESTED VIEW, not a separate fetch: there is no
 * `GET /tickets/:id` route, so the base ticket object is looked up from
 * whichever of the two already-loaded lists contains it (keyed by
 * `?ticket=<id>` in the URL, alongside `?tab=` so Back returns to the tab
 * the user came from — mirrors Review.tsx's list↔detail URL-state pattern).
 * Only the comment thread (`GET /tickets/:id/comments`) is fetched fresh.
 *
 * Threat model (client half — the server owns the real defenses; see
 * routes/tickets.ts's header for the full enumeration):
 *   - **Author anonymity (the whole point of F-023).** Neither
 *     `CommunityTicket` nor `TicketComment` (types/domain.ts) has an author
 *     field AT ALL — `isMine` is the only identity-adjacent signal, computed
 *     server-side against the CALLER's own id, and reveals nothing about
 *     anyone else. This page has no code path that renders an author,
 *     because there is no field here to reach for.
 *   - **Optimistic concurrency.** Editing a ticket sends `expectedVersion`;
 *     a 409 means someone (possibly the caller, in another tab/device)
 *     changed it since it was loaded. The recovery is: silently refetch the
 *     caller's fresh copy, replace the edit buffer with it, and tell the
 *     user plainly what happened — never silently discard their draft
 *     without explanation, and never blindly retry a write against a row
 *     that changed underneath it.
 *   - **IDOR.** A PATCH against a ticket that isn't the caller's own 404s
 *     server-side; this page never assumes ownership from the client side —
 *     `canEdit` is derived from whether the row actually appeared in
 *     `GET /tickets/mine`, not from any client-side guess.
 *   - **XSS / error-string leakage.** Every error surface routes through
 *     `errorMessageFor` (fixed, author-controlled copy) — raw server prose
 *     is never rendered.
 *   - **Abort.** Every list/thread fetch takes its own `AbortController`,
 *     cancelled on unmount, ticket-id change, or a superseding request
 *     (filter change, tab switch) — mirrors every other page in this app.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { BackButton } from '../components/BackButton';
import { Bilingual } from '../components/Bilingual';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ErrorCard } from '../components/ErrorCard';
import { FilterSelect } from '../components/FilterSelect';
import { Icon } from '../components/Icon';
import { Pill, type PillTone } from '../components/Pill';
import { ShowMore } from '../components/ShowMore';
import { Tabs } from '../components/Tabs';
import { Topbar } from '../components/Topbar';
import { useToast } from '../components/useToast';
import { usePagination } from '../hooks/usePagination';
import { errorMessageFor } from '../lib/errorCopy';
import { ApiError } from '../services/api';
import {
  addTicketComment,
  createTicket,
  listCommunityTickets,
  listMyTickets,
  listTicketComments,
  patchTicket,
} from '../services/tickets';
import type {
  CommunityTicket,
  OwnTicket,
  PatchTicketBody,
  TicketComment,
  TicketStatus,
  TicketType,
} from '../types/domain';
import './Tickets.css';

type TabId = 'mine' | 'community';

const TYPE_META: Record<TicketType, { en: string; kr: string; tone: PillTone }> = {
  bug: { en: 'Bug', kr: '버그', tone: 'red' },
  concern: { en: 'Concern', kr: '우려사항', tone: 'ochre' },
  suggestion: { en: 'Suggestion', kr: '제안', tone: 'default' },
  request: { en: 'Request', kr: '요청', tone: 'gold' },
};

const STATUS_META: Record<
  TicketStatus,
  { en: string; kr: string; tone: PillTone }
> = {
  open: { en: 'Open', kr: '열림', tone: 'gold' },
  in_progress: { en: 'In progress', kr: '진행 중', tone: 'ochre' },
  resolved: { en: 'Resolved', kr: '해결됨', tone: 'green' },
  closed: { en: 'Closed', kr: '닫힘', tone: 'default' },
};

const TICKET_TYPES: readonly TicketType[] = [
  'bug',
  'concern',
  'suggestion',
  'request',
];
const TICKET_STATUSES: readonly TicketStatus[] = [
  'open',
  'in_progress',
  'resolved',
  'closed',
];

/** Mirrors the server's Zod bounds (routes/tickets.ts) — a courtesy client
 *  cap so the field visibly rejects an over-length paste before the round
 *  trip, not the authority (the server re-validates regardless). */
const TITLE_MAX = 200;
const BODY_MAX = 5000;
const COMMENT_MAX = 2000;

/**
 * Community feed: fetched ONCE at this limit (the server's own per-request
 * ceiling — routes/tickets.ts `ListQuerySchema`), then windowed client-side
 * via `usePagination`/`ShowMore` — same "fetch once, paginate in the UI"
 * shape as Mistakes.tsx, not real server-side infinite scroll.
 */
const COMMUNITY_FETCH_LIMIT = 100;

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Length-capped before parseInt so a hostile mile-long digit string can't
 *  reach Number territory where precision loss lies (mirrors Review.tsx's
 *  `parseListIdParam`). */
function parseTicketIdParam(raw: string | null): number | null {
  if (raw === null || !/^\d{1,15}$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function parseTab(raw: string | null): TabId {
  return raw === 'community' ? 'community' : 'mine';
}

// ─────────────────────────────────────────────────────────────
// Pieces
// ─────────────────────────────────────────────────────────────

function TicketRow({
  ticket,
  isMine,
  onOpen,
}: {
  ticket: OwnTicket | CommunityTicket;
  isMine?: boolean;
  onOpen: () => void;
}): JSX.Element {
  const typeMeta = TYPE_META[ticket.type];
  const statusMeta = STATUS_META[ticket.status];
  return (
    <li className="km-tickets__row-wrap">
      <button
        type="button"
        className="km-tickets__row focusring"
        onClick={onOpen}
        aria-label={`View ticket: ${ticket.title}`}
      >
        <span className="km-tickets__row-main">
          <span className="km-tickets__row-title">{ticket.title}</span>
          <span className="km-tickets__row-meta">
            {formatDate(ticket.createdAt)} ·{' '}
            {ticket.commentCount === 1
              ? '1 comment'
              : `${String(ticket.commentCount)} comments`}
          </span>
        </span>
        <span className="km-tickets__row-badges">
          {isMine ? (
            <Pill tone="default">
              <Bilingual en="Yours" kr="본인" compact />
            </Pill>
          ) : null}
          <Pill tone={typeMeta.tone}>
            <Bilingual en={typeMeta.en} kr={typeMeta.kr} compact />
          </Pill>
          <Pill tone={statusMeta.tone}>
            <Bilingual en={statusMeta.en} kr={statusMeta.kr} compact />
          </Pill>
        </span>
      </button>
    </li>
  );
}

/** "File a ticket" — POST /tickets. Keeps typed values in place on a failed
 *  submit so the ErrorCard's Retry re-sends the exact same payload. */
function FileTicketForm({
  onFiled,
}: {
  onFiled: (ticket: OwnTicket) => void;
}): JSX.Element {
  const [type, setType] = useState<TicketType>('bug');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    title?: string;
    body?: string;
  }>({});
  const typeId = useId();
  const titleId = useId();
  const bodyId = useId();

  const submit = useCallback(async (): Promise<void> => {
    const titleTrim = title.trim();
    const bodyTrim = body.trim();
    const nextFieldErrors: { title?: string; body?: string } = {};
    if (titleTrim === '') {
      nextFieldErrors.title = 'Give it a short title.';
    } else if (titleTrim.length > TITLE_MAX) {
      nextFieldErrors.title = `Keep the title under ${String(TITLE_MAX)} characters.`;
    }
    if (bodyTrim === '') {
      nextFieldErrors.body = 'Describe what happened.';
    } else if (bodyTrim.length > BODY_MAX) {
      nextFieldErrors.body = `Keep the description under ${String(BODY_MAX)} characters.`;
    }
    setFieldErrors(nextFieldErrors);
    if (Object.keys(nextFieldErrors).length > 0) return;

    setSubmitting(true);
    setError(null);
    try {
      const created = await createTicket({
        type,
        title: titleTrim,
        body: bodyTrim,
      });
      onFiled(created);
      setTitle('');
      setBody('');
      setType('bug');
      setFieldErrors({});
    } catch (err) {
      setError(errorMessageFor(err, 'Could not file that ticket.'));
    } finally {
      setSubmitting(false);
    }
  }, [type, title, body, onFiled]);

  return (
    <Card className="km-tickets__file">
      <h2 className="km-eyebrow km-tickets__file-title">
        <Bilingual en="File a ticket" kr="티켓 제출" />
      </h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="km-tickets__field">
          <label htmlFor={typeId} className="km-tickets__label">
            Type
          </label>
          <select
            id={typeId}
            className="km-tickets__select focusring"
            value={type}
            onChange={(e) => {
              setType(e.target.value as TicketType);
            }}
            disabled={submitting}
          >
            {TICKET_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_META[t].en}
              </option>
            ))}
          </select>
        </div>

        <div className="km-tickets__field">
          <label htmlFor={titleId} className="km-tickets__label">
            Title
          </label>
          <input
            id={titleId}
            type="text"
            className="km-tickets__input focusring"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
            }}
            maxLength={TITLE_MAX}
            disabled={submitting}
            aria-invalid={fieldErrors.title ? true : undefined}
          />
          {fieldErrors.title ? (
            <p className="km-tickets__field-error" role="alert">
              {fieldErrors.title}
            </p>
          ) : null}
        </div>

        <div className="km-tickets__field">
          <label htmlFor={bodyId} className="km-tickets__label">
            Description
          </label>
          <textarea
            id={bodyId}
            className="kr km-tickets__textarea focusring"
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
            }}
            maxLength={BODY_MAX}
            disabled={submitting}
            aria-invalid={fieldErrors.body ? true : undefined}
          />
          {fieldErrors.body ? (
            <p className="km-tickets__field-error" role="alert">
              {fieldErrors.body}
            </p>
          ) : null}
        </div>

        {error ? (
          <ErrorCard
            message={error}
            onRetry={() => {
              void submit();
            }}
          />
        ) : null}

        <Button
          type="submit"
          variant="gold"
          fullWidth
          disabled={submitting}
          leadingIcon={<Icon name="plus" size={14} />}
        >
          <Bilingual
            en={submitting ? 'Filing…' : 'File ticket'}
            kr={submitting ? '제출 중…' : '제출'}
          />
        </Button>
      </form>
    </Card>
  );
}

/** A ticket's comment thread (`GET`/`POST /tickets/:id/comments`) — newest
 *  visible by default, "Show earlier" reveals further back. Every comment
 *  is ANONYMIZED (only `isMine`, never an author). */
function CommentThread({ ticketId }: { ticketId: number }): JSX.Element {
  const [comments, setComments] = useState<TicketComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  const load = useCallback((): void => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    setLoading(true);
    setError(null);
    listTicketComments(ticketId, { limit: 200 }, ctrl.signal)
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        setComments(rows);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(errorMessageFor(err, 'Could not load the comments.'));
        setLoading(false);
      });
  }, [ticketId]);

  useEffect(() => {
    load();
    return () => {
      ctrlRef.current?.abort();
    };
  }, [load]);

  // Server order is oldest-first (routes/tickets.ts: `ORDER BY created_at,
  // id`). Reverse for windowing so "Show earlier" reveals further BACK in
  // time (the newest N are always visible by default), then reverse the
  // visible slice back to chronological order for display.
  const newestFirst = useMemo(() => [...comments].reverse(), [comments]);
  const page = usePagination(newestFirst, {
    initial: 20,
    step: 20,
    max: 200,
  });
  const visible = useMemo(() => [...page.visible].reverse(), [page.visible]);

  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const commentFieldId = useId();

  const submit = useCallback(async (): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await addTicketComment(ticketId, trimmed);
      setComments((prev) => [...prev, created]);
      setText('');
    } catch (err) {
      setSubmitError(errorMessageFor(err, 'Could not post that comment.'));
    } finally {
      setSubmitting(false);
    }
  }, [text, ticketId]);

  return (
    <Card className="km-tickets__thread">
      <h2 className="km-eyebrow km-tickets__thread-title">
        <Bilingual en="Comments" kr="댓글" />
      </h2>

      {loading ? (
        <p role="status" className="km-tickets__state">
          Loading comments…
        </p>
      ) : error ? (
        <ErrorCard message={error} onRetry={load} />
      ) : comments.length === 0 ? (
        <p className="km-tickets__empty">
          No comments yet — be the first to reply.
        </p>
      ) : (
        <>
          <ShowMore
            canShowMore={page.canShowMore}
            onShowMore={page.showMore}
            remaining={page.remaining}
            label="Show earlier comments"
          />
          <ul className="km-tickets__comment-list">
            {visible.map((c) => (
              <li key={c.id} className="km-tickets__comment">
                <p className="km-tickets__comment-body">{c.body}</p>
                <span className="km-tickets__comment-meta">
                  {formatDateTime(c.createdAt)}
                  {c.isMine ? ' · Yours' : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <form
        className="km-tickets__comment-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor={commentFieldId} className="km-tickets__label">
          <Bilingual en="Add a comment" kr="댓글 추가" />
        </label>
        <textarea
          id={commentFieldId}
          className="kr km-tickets__textarea km-tickets__textarea--comment focusring"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
          maxLength={COMMENT_MAX}
          disabled={submitting}
        />
        {submitError ? (
          <ErrorCard
            message={submitError}
            onRetry={() => {
              void submit();
            }}
          />
        ) : null}
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          disabled={submitting || text.trim() === ''}
        >
          <Bilingual
            en={submitting ? 'Posting…' : 'Post comment'}
            kr={submitting ? '게시 중…' : '게시'}
          />
        </Button>
      </form>
    </Card>
  );
}

interface TicketDetailProps {
  ticket: OwnTicket | CommunityTicket;
  /** True iff this ticket was found in `GET /tickets/mine` — the ONLY
   *  source of edit rights (never a client-side guess; see module header). */
  canEdit: boolean;
  onTicketUpdated: (updated: OwnTicket) => void;
  /** Re-fetches just this ticket's fresh row from `/tickets/mine`
   *  (unfiltered, so a board-level status/type filter can never hide the
   *  very row a 409 needs). Returns `null` if it's genuinely gone. */
  refetchOwnTicket: (id: number) => Promise<OwnTicket | null>;
}

/** The ticket body — an editable form when `canEdit`, read-only otherwise —
 *  plus its comment thread. */
function TicketDetail({
  ticket,
  canEdit,
  onTicketUpdated,
  refetchOwnTicket,
}: TicketDetailProps): JSX.Element {
  const { toast } = useToast();
  const typeMeta = TYPE_META[ticket.type];
  const statusMeta = STATUS_META[ticket.status];
  const showsAsMine = !canEdit && 'isMine' in ticket && ticket.isMine;

  const ownVersion = canEdit ? (ticket as OwnTicket).version : undefined;
  const [editBuffer, setEditBuffer] = useState<{
    title: string;
    body: string;
    status: TicketStatus;
  }>(() => ({ title: ticket.title, body: ticket.body, status: ticket.status }));
  const [conflictNotice, setConflictNotice] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // A fresh authoritative row landed — either the caller's own successful
  // save, or a conflict-triggered reload. Reset the draft to it; any
  // in-flight save error no longer describes the current state.
  useEffect(() => {
    setEditBuffer({ title: ticket.title, body: ticket.body, status: ticket.status });
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ownVersion stands in for (title/body/status) identity; see module header.
  }, [ticket.id, ownVersion]);

  const titleId = useId();
  const bodyId = useId();
  const statusId = useId();

  const dirty =
    canEdit &&
    (editBuffer.title.trim() !== ticket.title ||
      editBuffer.body.trim() !== ticket.body ||
      editBuffer.status !== ticket.status);

  const save = useCallback(async (): Promise<void> => {
    if (!canEdit) return;
    const own = ticket as OwnTicket;
    const titleTrim = editBuffer.title.trim();
    const bodyTrim = editBuffer.body.trim();
    if (titleTrim === '' || bodyTrim === '') {
      setSaveError('Title and description can’t be empty.');
      return;
    }
    const patch: PatchTicketBody = { expectedVersion: own.version };
    if (titleTrim !== own.title) patch.title = titleTrim;
    if (bodyTrim !== own.body) patch.body = bodyTrim;
    if (editBuffer.status !== own.status) patch.status = editBuffer.status;
    if (
      patch.title === undefined &&
      patch.body === undefined &&
      patch.status === undefined
    ) {
      return;
    }

    setSaving(true);
    setSaveError(null);
    setConflictNotice(false);
    try {
      const updated = await patchTicket(own.id, patch);
      onTicketUpdated(updated);
      toast({ message: 'Saved.', tone: 'success' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Stale expected_version — the canonical recovery: pull the fresh
        // row and hand it back to the parent, which flows back down as a
        // new `ticket` prop, resetting the draft above. Never silently
        // retry against a row that just proved to be stale.
        try {
          const fresh = await refetchOwnTicket(own.id);
          if (fresh) {
            onTicketUpdated(fresh);
            setConflictNotice(true);
          } else {
            setSaveError(
              'This ticket could not be found anymore. Try reloading the page.',
            );
          }
        } catch {
          setSaveError(
            'This ticket changed elsewhere, and reloading the latest version failed. Try again.',
          );
        }
      } else {
        setSaveError(errorMessageFor(err, 'Could not save your changes.'));
      }
    } finally {
      setSaving(false);
    }
  }, [canEdit, ticket, editBuffer, onTicketUpdated, refetchOwnTicket, toast]);

  return (
    <div className="km-tickets__detail">
      <Card className="km-tickets__detail-card">
        <div className="km-tickets__detail-badges">
          <Pill tone={typeMeta.tone}>
            <Bilingual en={typeMeta.en} kr={typeMeta.kr} compact />
          </Pill>
          <Pill tone={statusMeta.tone}>
            <Bilingual en={statusMeta.en} kr={statusMeta.kr} compact />
          </Pill>
          {showsAsMine ? (
            <Pill tone="default">
              <Bilingual en="Yours" kr="본인" compact />
            </Pill>
          ) : null}
        </div>

        {canEdit ? (
          <form
            className="km-tickets__edit-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="km-tickets__field">
              <label htmlFor={titleId} className="km-tickets__label">
                Title
              </label>
              <input
                id={titleId}
                type="text"
                className="km-tickets__input focusring"
                value={editBuffer.title}
                onChange={(e) => {
                  const value = e.target.value;
                  setEditBuffer((b) => ({ ...b, title: value }));
                  setConflictNotice(false);
                }}
                maxLength={TITLE_MAX}
                disabled={saving}
              />
            </div>
            <div className="km-tickets__field">
              <label htmlFor={bodyId} className="km-tickets__label">
                Description
              </label>
              <textarea
                id={bodyId}
                className="kr km-tickets__textarea focusring"
                value={editBuffer.body}
                onChange={(e) => {
                  const value = e.target.value;
                  setEditBuffer((b) => ({ ...b, body: value }));
                  setConflictNotice(false);
                }}
                maxLength={BODY_MAX}
                disabled={saving}
              />
            </div>
            <div className="km-tickets__field">
              <label htmlFor={statusId} className="km-tickets__label">
                Status
              </label>
              <select
                id={statusId}
                className="km-tickets__select focusring"
                value={editBuffer.status}
                onChange={(e) => {
                  const value = e.target.value as TicketStatus;
                  setEditBuffer((b) => ({ ...b, status: value }));
                  setConflictNotice(false);
                }}
                disabled={saving}
              >
                {TICKET_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_META[s].en}
                  </option>
                ))}
              </select>
            </div>

            {conflictNotice ? (
              <p className="km-tickets__conflict" role="status">
                This ticket changed since you loaded it — we reloaded the
                latest version below. Review it and save again if you still
                want your edit.
              </p>
            ) : null}
            {saveError ? (
              <ErrorCard
                message={saveError}
                onRetry={() => {
                  void save();
                }}
              />
            ) : null}

            <Button type="submit" variant="gold" disabled={!dirty || saving}>
              <Bilingual
                en={saving ? 'Saving…' : 'Save'}
                kr={saving ? '저장 중…' : '저장'}
              />
            </Button>
          </form>
        ) : (
          <>
            <h2 className="km-tickets__detail-title">{ticket.title}</h2>
            <p className="kr km-tickets__detail-body">{ticket.body}</p>
          </>
        )}
      </Card>

      <CommentThread ticketId={ticket.id} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────

export default function Tickets(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();

  const tab = parseTab(searchParams.get('tab'));
  const ticketId = parseTicketIdParam(searchParams.get('ticket'));

  // Filters — local, shared by both tabs. Not part of the deep-link
  // contract (unlike tab/ticket), so a shared link never surprises the
  // recipient with someone else's filter state.
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const hasActiveFilters = statusFilter !== '' || typeFilter !== '';

  // ── My tickets ──
  const [mine, setMine] = useState<OwnTicket[]>([]);
  const [mineLoading, setMineLoading] = useState(true);
  const [mineError, setMineError] = useState<string | null>(null);
  const mineCtrlRef = useRef<AbortController | null>(null);

  const loadMine = useCallback((): void => {
    const ctrl = new AbortController();
    mineCtrlRef.current?.abort();
    mineCtrlRef.current = ctrl;
    setMineLoading(true);
    setMineError(null);
    listMyTickets(
      {
        ...(statusFilter !== ''
          ? { status: statusFilter as TicketStatus }
          : {}),
        ...(typeFilter !== '' ? { type: typeFilter as TicketType } : {}),
      },
      ctrl.signal,
    )
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        setMine(rows);
        setMineLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setMineError(errorMessageFor(err, 'Could not load your tickets.'));
        setMineLoading(false);
      });
  }, [statusFilter, typeFilter]);

  useEffect(() => {
    loadMine();
    return () => {
      mineCtrlRef.current?.abort();
    };
  }, [loadMine]);

  /** Re-fetches ONE ticket's fresh row, unfiltered — used only by the
   *  edit form's 409 recovery (see TicketDetailProps.refetchOwnTicket doc).
   *  Deliberately bypasses `statusFilter`/`typeFilter` so an active board
   *  filter can never hide the very row a stale-write recovery needs, and
   *  only patches that one row into `mine` rather than replacing the whole
   *  (possibly filtered) list. */
  const refetchOwnTicket = useCallback(
    async (id: number): Promise<OwnTicket | null> => {
      const rows = await listMyTickets();
      const fresh = rows.find((t) => t.id === id) ?? null;
      if (fresh) {
        setMine((prev) => prev.map((t) => (t.id === id ? fresh : t)));
      }
      return fresh;
    },
    [],
  );

  // ── Community ──
  const [community, setCommunity] = useState<CommunityTicket[]>([]);
  const [communityLoading, setCommunityLoading] = useState(true);
  const [communityError, setCommunityError] = useState<string | null>(null);
  const communityCtrlRef = useRef<AbortController | null>(null);

  const loadCommunity = useCallback((): void => {
    const ctrl = new AbortController();
    communityCtrlRef.current?.abort();
    communityCtrlRef.current = ctrl;
    setCommunityLoading(true);
    setCommunityError(null);
    listCommunityTickets(
      {
        limit: COMMUNITY_FETCH_LIMIT,
        ...(statusFilter !== ''
          ? { status: statusFilter as TicketStatus }
          : {}),
        ...(typeFilter !== '' ? { type: typeFilter as TicketType } : {}),
      },
      ctrl.signal,
    )
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        setCommunity(rows);
        setCommunityLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setCommunityError(
          errorMessageFor(err, 'Could not load the community feed.'),
        );
        setCommunityLoading(false);
      });
  }, [statusFilter, typeFilter]);

  useEffect(() => {
    loadCommunity();
    return () => {
      communityCtrlRef.current?.abort();
    };
  }, [loadCommunity]);

  // F-023: "the community feed may be long — window it."
  const communityPage = usePagination(community, {
    initial: 15,
    step: 15,
    max: COMMUNITY_FETCH_LIMIT,
  });

  const onStatusFilterChange = useCallback(
    (value: string): void => {
      setStatusFilter(value);
      communityPage.reset();
    },
    [communityPage],
  );
  const onTypeFilterChange = useCallback(
    (value: string): void => {
      setTypeFilter(value);
      communityPage.reset();
    },
    [communityPage],
  );

  const onTabChange = useCallback(
    (id: string): void => {
      setSearchParams({ tab: id });
    },
    [setSearchParams],
  );

  const openTicket = useCallback(
    (id: number): void => {
      const next = new URLSearchParams(searchParams);
      next.set('ticket', String(id));
      next.set('tab', tab);
      setSearchParams(next);
    },
    [searchParams, setSearchParams, tab],
  );

  const onTicketUpdated = useCallback((updated: OwnTicket): void => {
    setMine((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
  }, []);

  const onFiled = useCallback(
    (created: OwnTicket): void => {
      setMine((prev) => [created, ...prev]);
      toast({ message: 'Ticket filed.', tone: 'success' });
    },
    [toast],
  );

  // ── Detail (nested view) ──
  if (ticketId !== null) {
    const mineDetail = mine.find((t) => t.id === ticketId) ?? null;
    const communityDetail = community.find((t) => t.id === ticketId) ?? null;
    // `mine` wins when a ticket appears in both — only that copy carries
    // `version`, and therefore edit rights (see module header).
    const ticket = mineDetail ?? communityDetail;
    const backTo = `/tickets?tab=${tab}`;
    const backLabel = tab === 'mine' ? 'My tickets' : 'Community';

    return (
      <section className="screen km-tickets" aria-labelledby="km-tickets-title">
        <BackButton to={backTo} label={backLabel} />
        <Topbar
          krTitle="티켓"
          title="Ticket"
          titleId="km-tickets-title"
          eyebrow={<Bilingual en="Feedback" kr="피드백" />}
        />
        {ticket === null ? (
          mineLoading || communityLoading ? (
            <p role="status" className="km-tickets__state">
              Loading…
            </p>
          ) : (
            <Card className="km-tickets__state">
              We couldn&apos;t find that ticket.
            </Card>
          )
        ) : (
          <TicketDetail
            ticket={ticket}
            canEdit={mineDetail !== null}
            onTicketUpdated={onTicketUpdated}
            refetchOwnTicket={refetchOwnTicket}
          />
        )}
      </section>
    );
  }

  // ── List view ──
  return (
    <section className="screen km-tickets" aria-labelledby="km-tickets-title">
      <Topbar
        krTitle="베타 피드백"
        title="Beta Feedback"
        titleId="km-tickets-title"
        eyebrow={<Bilingual en="Feedback" kr="피드백" />}
      />

      <FileTicketForm onFiled={onFiled} />

      <div className="km-tickets__filters">
        <FilterSelect
          label="Filter by status"
          options={TICKET_STATUSES.map((s) => ({
            value: s,
            label: STATUS_META[s].en,
          }))}
          value={statusFilter}
          onChange={onStatusFilterChange}
        />
        <FilterSelect
          label="Filter by type"
          options={TICKET_TYPES.map((t) => ({
            value: t,
            label: TYPE_META[t].en,
          }))}
          value={typeFilter}
          onChange={onTypeFilterChange}
        />
      </div>

      <Tabs
        tabs={[
          { id: 'mine', label: <Bilingual en="My tickets" kr="내 티켓" compact /> },
          {
            id: 'community',
            label: <Bilingual en="Community" kr="커뮤니티" compact />,
          },
        ]}
        ariaLabel="Ticket views"
        active={tab}
        onChange={onTabChange}
      >
        {(activeId) =>
          activeId === 'mine' ? (
            mineLoading && mine.length === 0 ? (
              <p role="status" className="km-tickets__state">
                Loading your tickets…
              </p>
            ) : mineError ? (
              <ErrorCard message={mineError} onRetry={loadMine} />
            ) : mine.length === 0 ? (
              <p className="km-tickets__empty">
                {hasActiveFilters
                  ? 'No tickets match these filters.'
                  : 'No tickets yet — file the first one.'}
              </p>
            ) : (
              <ul className="km-tickets__list">
                {mine.map((t) => (
                  <TicketRow
                    key={t.id}
                    ticket={t}
                    onOpen={() => {
                      openTicket(t.id);
                    }}
                  />
                ))}
              </ul>
            )
          ) : communityLoading && community.length === 0 ? (
            <p role="status" className="km-tickets__state">
              Loading the community feed…
            </p>
          ) : communityError ? (
            <ErrorCard message={communityError} onRetry={loadCommunity} />
          ) : community.length === 0 ? (
            <p className="km-tickets__empty">
              {hasActiveFilters
                ? 'No tickets match these filters.'
                : 'No tickets yet — file the first one.'}
            </p>
          ) : (
            <>
              <ul className="km-tickets__list">
                {communityPage.visible.map((t) => (
                  <TicketRow
                    key={t.id}
                    ticket={t}
                    isMine={t.isMine}
                    onOpen={() => {
                      openTicket(t.id);
                    }}
                  />
                ))}
              </ul>
              <ShowMore
                canShowMore={communityPage.canShowMore}
                onShowMore={communityPage.showMore}
                remaining={communityPage.remaining}
                label="Show more tickets"
              />
            </>
          )
        }
      </Tabs>
    </section>
  );
}
