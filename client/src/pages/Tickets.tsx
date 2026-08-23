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
 * Detail is a NESTED VIEW keyed by `?ticket=<id>` in the URL (alongside
 * `?tab=` so Back returns to the tab the user came from — mirrors
 * Review.tsx's list↔detail URL-state pattern). The base ticket object is
 * fetched by id from `GET /tickets/:id` — the owner shape (carrying
 * `version`, i.e. edit rights) for the caller's own ticket, the anonymized
 * community shape for anyone else's — with the two already-loaded lists as
 * an instant-render fast path while that fetch is in flight. The detail
 * view deliberately does NOT depend on list membership: `/mine` and
 * `/community` are FILTERED by the board's status/type filter, so a
 * just-filed ticket can be absent from the very lists that were once the
 * only lookup source — the "file → open → not found" beta regression the
 * id-addressed fetch closes. The comment thread (`GET
 * /tickets/:id/comments`) is fetched fresh as before.
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
 *     `canEdit` is derived from the SERVER's ownership decision: either the
 *     owner-vs-anonymized shape of the `GET /tickets/:id` response, or the
 *     row's presence in `GET /tickets/mine` — never a client-side guess
 *     (in particular, never from the community feed's `isMine` flag).
 *   - **XSS / error-string leakage.** Every error surface routes through
 *     `errorMessageFor` (fixed, author-controlled copy) — raw server prose
 *     is never rendered.
 *   - **Abort.** Every list/thread fetch takes its own `AbortController`,
 *     cancelled on unmount, ticket-id change, or a superseding request
 *     (filter change, tab switch) — mirrors every other page in this app.
 *   - **F-127 (global "!" FAB → this page).** `FeedbackFab.tsx` navigates
 *     here with router state `{ compose: true, sourcePage: { path, name } }`.
 *     `sourcePage.path` is the only part that's persisted — it rides
 *     straight into `createTicket`'s `sourcePage` field, which the server
 *     bounds/validates (routes/tickets.ts) before ever reaching the DB; it
 *     is client-reported UI context, never trusted as anything more, and
 *     is NOT author-identifying (orthogonal to the anonymity contract
 *     above). `sourcePage.name` is used ONLY for this render pass's "Filing
 *     from: <name>" hint — the stored ticket re-derives its OWN display
 *     name later from the persisted path via `pageNameForPath` (lib/nav.ts),
 *     so a later nav.ts rename can't leave old tickets showing a stale
 *     label frozen at filing time.
 *
 * F-128 "Seoul Day & Night" reskin: both headers adopt the shared
 * `PageHubHeader` (devices #4/#2) instead of a bare `Topbar`; each ticket row
 * (and the detail/comment-thread cards) rides a `CityCard` (device #1 —
 * Night neon-signboard glow / Day hanji-paper, `tone="plain"` — a ticket
 * carries no skill color of its own, its Bug/Concern/Suggestion/Request and
 * Open/In-progress/Resolved/Closed identity already comes from the existing
 * `Pill`s) instead of a flat bordered list/`Card`. The file-a-ticket form
 * moves into the shared `Sheet` (a bottom-attached modal, matching the
 * km-final.html "+ New" → sheet mock) instead of always rendering inline —
 * triggered by a "New ticket" action in the header, or automatically when
 * arriving via the F-127 FAB's `compose: true` state. `.km-rain-sheen`
 * (device #8) ambient-textures both views; it's a Night-only no-op by its
 * own CSS gate. Purely visual — none of the fetch/filter/tab/edit/comment/
 * anonymity logic above changes.
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
import { useLocation, useSearchParams } from 'react-router-dom';
import { BackButton } from '../components/BackButton';
import { Bilingual } from '../components/Bilingual';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { CityCard } from '../components/CityCard';
import { ErrorCard } from '../components/ErrorCard';
import { FilterSelect } from '../components/FilterSelect';
import { Icon } from '../components/Icon';
import { PageHubHeader } from '../components/PageHubHeader';
import { Pill, type PillTone } from '../components/Pill';
import { Sheet } from '../components/Sheet';
import { ShowMore } from '../components/ShowMore';
import { Tabs } from '../components/Tabs';
import { useToast } from '../components/useToast';
import { usePagination } from '../hooks/usePagination';
import { errorMessageFor } from '../lib/errorCopy';
import { formatDate } from '../lib/formatDate';
import { pageNameForPath } from '../lib/nav';
import { parseIdParam } from '../lib/urlIdParam';
import { ApiError } from '../services/api';
import {
  addTicketComment,
  createTicket,
  fetchTicket,
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
  TicketDetailResult,
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

/** Router state `FeedbackFab.tsx` navigates here with (F-127). Both fields
 *  are optional/absent for every OTHER way of reaching this page (direct
 *  nav, the Settings tile, a bookmarked link) — this page must render
 *  correctly with neither present. */
interface TicketsLocationState {
  compose?: boolean;
  sourcePage?: { path: string; name: string };
}

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

function parseTab(raw: string | null): TabId {
  return raw === 'community' ? 'community' : 'mine';
}

// ─────────────────────────────────────────────────────────────
// Pieces
// ─────────────────────────────────────────────────────────────

/**
 * F-128 device #1/#2 — each row rides its own `CityCard` (neon signboard /
 * hanji paper) with the leading-edge `DancheongRail`, replacing the old flat
 * bordered list row. `tone="plain"` — a ticket carries no skill color of its
 * own; its type/status identity already comes from the two `Pill`s below
 * (same disposition as Uploads.tsx's rows). The button keeps its exact
 * pre-reskin markup/aria (`aria-label="View ticket: …"` is what every test
 * and the anonymity-contract queries target) — only the outer shell and the
 * button's own now-padding-less styling (Tickets.css) changed.
 */
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
      <CityCard tone="plain" rail className="km-tickets__card">
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
            {ticket.sourcePage ? (
              <span className="km-tickets__row-meta km-tickets__source-page">
                Reported from: {pageNameForPath(ticket.sourcePage)}
              </span>
            ) : null}
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
      </CityCard>
    </li>
  );
}

/**
 * "File a ticket" — POST /tickets. Keeps typed values in place on a failed
 * submit so the ErrorCard's Retry re-sends the exact same payload.
 *
 * F-128: this now lives INSIDE the shared `Sheet` (the caller wraps it), so
 * it no longer needs its own `Card` shell (the Sheet panel already is the
 * surface) or a bespoke autofocus effect: `Sheet`'s own `useModalA11y`
 * already auto-focuses the first focusable descendant on open, and moving
 * **Title** ahead of Type in the field order (visual + DOM) makes that
 * built-in behaviour land exactly where F-127's "arrive via the FAB, ready
 * to type" contract wants — whether the sheet was opened by the FAB or by
 * the header's "New ticket" button, with no extra prop needed here.
 *
 * Fix-pass batch-4 (T-1, REVIEW_batch4-cst.md): `title`/`body`/`type` are
 * now CONTROLLED props owned by the parent `Tickets` component, not local
 * state here. `Sheet` unmounts its children whenever `open=false`
 * (`Sheet.tsx`) — with local state, dismissing the sheet WITHOUT submitting
 * (Esc, backdrop click) silently destroyed whatever the learner had typed, a
 * real behavior change from the pre-reskin always-inline form (which never
 * lost a draft under any circumstance). Lifting the draft to `Tickets`
 * means it survives the sheet's own unmount/remount, so closing without
 * filing preserves the draft exactly the way a failed submit already did —
 * one consistent contract instead of two different ones depending on HOW
 * the sheet closed.
 */
function FileTicketForm({
  onFiled,
  sourcePage,
  type,
  onTypeChange,
  title,
  onTitleChange,
  body,
  onBodyChange,
}: {
  onFiled: (ticket: OwnTicket) => void;
  /** F-127: the page the global "!" FAB was tapped from, if that's how the
   *  caller arrived here. Rides into `createTicket`'s `sourcePage` field
   *  (path only — see module header on why the label isn't persisted). */
  sourcePage?: { path: string; name: string };
  /** Draft fields — lifted to `Tickets` (T-1) so a Sheet dismiss-without-
   *  submit doesn't lose them. */
  type: TicketType;
  onTypeChange: (next: TicketType) => void;
  title: string;
  onTitleChange: (next: string) => void;
  body: string;
  onBodyChange: (next: string) => void;
}): JSX.Element {
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
        ...(sourcePage !== undefined ? { sourcePage: sourcePage.path } : {}),
      });
      onFiled(created);
      // Draft lives in the parent now — clear it there too, so the NEXT
      // open (a fresh ticket) starts blank rather than replaying this one.
      onTitleChange('');
      onBodyChange('');
      onTypeChange('bug');
      setFieldErrors({});
    } catch (err) {
      setError(errorMessageFor(err, 'Could not file that ticket.'));
    } finally {
      setSubmitting(false);
    }
  }, [type, title, body, sourcePage, onFiled, onTitleChange, onBodyChange, onTypeChange]);

  return (
    <div className="km-tickets__file">
      <h2 className="km-eyebrow km-tickets__file-title">
        <Bilingual en="File a ticket" kr="티켓 제출" />
      </h2>
      {sourcePage ? (
        <p className="km-tickets__source-page km-tickets__file-source">
          Filing from: {sourcePage.name}
        </p>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {/* Title leads (see the function doc comment) — the first focusable
            field in the Sheet, so its own initial-focus effect lands here
            with no bespoke autofocus wiring needed. */}
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
              onTitleChange(e.target.value);
            }}
            maxLength={TITLE_MAX}
            disabled={submitting}
            aria-invalid={fieldErrors.title ? true : undefined}
            aria-describedby={fieldErrors.title ? `${titleId}-error` : undefined}
          />
          {fieldErrors.title ? (
            <p id={`${titleId}-error`} className="km-tickets__field-error" role="alert">
              {fieldErrors.title}
            </p>
          ) : null}
        </div>

        <div className="km-tickets__field">
          <label htmlFor={typeId} className="km-tickets__label">
            Type
          </label>
          <select
            id={typeId}
            className="km-tickets__select focusring"
            value={type}
            onChange={(e) => {
              onTypeChange(e.target.value as TicketType);
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
          <label htmlFor={bodyId} className="km-tickets__label">
            Description
          </label>
          <textarea
            id={bodyId}
            className="kr km-tickets__textarea focusring"
            value={body}
            onChange={(e) => {
              onBodyChange(e.target.value);
            }}
            maxLength={BODY_MAX}
            disabled={submitting}
            aria-invalid={fieldErrors.body ? true : undefined}
            aria-describedby={fieldErrors.body ? `${bodyId}-error` : undefined}
          />
          {fieldErrors.body ? (
            <p id={`${bodyId}-error`} className="km-tickets__field-error" role="alert">
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
    </div>
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
    // F-128 device #1 — a CityCard signboard (tone="plain", no rail: the
    // thread reads as a secondary panel under the detail card's own rail).
    <CityCard tone="plain" className="km-tickets__thread">
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
    </CityCard>
  );
}

/** `OwnTicket` is the only ticket shape that carries `version` — use that as
 *  the runtime discriminator when narrowing `OwnTicket | CommunityTicket`,
 *  rather than trusting a caller-supplied `canEdit` boolean via an unchecked
 *  `as` cast. Today the two always agree (`canEdit` is derived from the same
 *  server-decided owner shapes — the `GET /tickets/:id` owner branch and
 *  `mine`-list membership — that are the only sources of `version`; see the
 *  module header), but this makes that invariant compiler-checked instead of
 *  merely true-by-construction at the one current call site. */
function asOwnTicket(ticket: OwnTicket | CommunityTicket): OwnTicket | null {
  return 'version' in ticket ? ticket : null;
}

interface TicketDetailProps {
  ticket: OwnTicket | CommunityTicket;
  /** True iff the SERVER handed us this ticket in the owner shape — via the
   *  `GET /tickets/:id` owner branch or `GET /tickets/mine` membership, the
   *  only sources of edit rights (never a client-side guess; see module
   *  header). */
  canEdit: boolean;
  onTicketUpdated: (updated: OwnTicket) => void;
  /** Re-fetches just this ticket's fresh row via the id-addressed
   *  `GET /tickets/:id` (no board filter or list window can hide the row a
   *  409 needs). Returns `null` if it's genuinely gone. */
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

  const ownVersion = canEdit ? asOwnTicket(ticket)?.version : undefined;
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
    const own = asOwnTicket(ticket);
    if (!canEdit || !own) return;
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
      {/* F-128 device #1/#2 — the detail's primary CityCard signboard
          carries the leading-edge rail; the CommentThread below (tone
          "plain", no rail) reads as the secondary panel underneath it. */}
      <CityCard tone="plain" rail className="km-tickets__detail-card">
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

        {ticket.sourcePage ? (
          <p className="km-tickets__source-page km-tickets__detail-source">
            Reported from: {pageNameForPath(ticket.sourcePage)}
          </p>
        ) : null}

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
      </CityCard>

      <CommentThread ticketId={ticket.id} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────

export default function Tickets(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const { toast } = useToast();

  const tab = parseTab(searchParams.get('tab'));
  const ticketId = parseIdParam(searchParams.get('ticket'));

  // F-127: FeedbackFab.tsx's router state, if that's how we got here.
  // Narrowed defensively (router state is caller-controlled, not a typed
  // API response) rather than trusted with a bare `as` cast — anything
  // malformed (including an explicit `sourcePage: null`, not just a missing
  // key — `null !== undefined` in JS, so a bare `!== undefined` check alone
  // would pass through and crash reading `.path` off `null`) just falls back
  // to "no page context", the same as a plain direct navigation to
  // /tickets. Optional chaining on every step of `navState?.sourcePage?.path`
  // means a `null`/`undefined` `sourcePage` short-circuits to `undefined`
  // (never throws), so `typeof` sees "not a string" and takes the fallback
  // branch — fix-pass batch-4 BLOCKER-2 (REVIEW_batch4-cst.md).
  const navState = location.state as TicketsLocationState | null | undefined;
  const sourcePage =
    typeof navState?.sourcePage?.path === 'string' &&
    typeof navState?.sourcePage?.name === 'string'
      ? navState.sourcePage
      : undefined;
  const arriveComposing = navState?.compose === true;

  // F-128: the file-a-ticket form now lives in the shared `Sheet` (device-
  // agnostic bottom modal) instead of always rendering inline — opened by
  // the header's "New ticket" action, or automatically when the F-127 FAB's
  // `compose: true` state is what got us here. Lazy initializer: this only
  // needs to read `arriveComposing` once, on the mount this component was
  // navigated to for — a later re-render (e.g. the tab changing) must not
  // re-open a sheet the user already closed.
  const [fileOpen, setFileOpen] = useState<boolean>(() => arriveComposing);

  // T-1 fix-pass (REVIEW_batch4-cst.md): the file-a-ticket draft lives HERE,
  // not inside `FileTicketForm` — `Sheet` unmounts its children on close, so
  // local state there was silently destroyed by dismissing without
  // submitting (Esc/backdrop), unlike a failed submit (which already
  // preserved it). Lifting it up means it survives the sheet's own
  // unmount/remount; `FileTicketForm` clears it via these setters only on a
  // genuinely successful file.
  const [draftType, setDraftType] = useState<TicketType>('bug');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');

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
    // Fetch-on-mount / on-filter-change: the loader sets loading=true
    // synchronously by design (the codebase's fetch-effect convention).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadMine();
    return () => {
      mineCtrlRef.current?.abort();
    };
  }, [loadMine]);

  /** Re-fetches ONE ticket's fresh row via the id-addressed
   *  `GET /tickets/:id` — used only by the edit form's 409 recovery (see
   *  TicketDetailProps.refetchOwnTicket doc). Addressing by id means no
   *  board filter OR list pagination window can ever hide the very row a
   *  stale-write recovery needs (this used to scan an unfiltered-but-
   *  windowed `/mine` page and could miss beyond it); the fresh row is
   *  patched into `mine` in place rather than replacing the whole (possibly
   *  filtered) list. Returns `null` when the ticket is genuinely gone (404)
   *  or — unreachable today, ownership never changes — no longer the
   *  caller's own. Takes its own `AbortController` (aborting any prior
   *  in-flight recovery fetch, and on this page's unmount) — the same
   *  contract as every other fetch in this file. */
  const refetchOwnTicketCtrlRef = useRef<AbortController | null>(null);
  const refetchOwnTicket = useCallback(
    async (id: number): Promise<OwnTicket | null> => {
      const ctrl = new AbortController();
      refetchOwnTicketCtrlRef.current?.abort();
      refetchOwnTicketCtrlRef.current = ctrl;
      try {
        const result = await fetchTicket(id, ctrl.signal);
        if (result.kind !== 'own') return null;
        const fresh = result.ticket;
        setMine((prev) => prev.map((t) => (t.id === id ? fresh : t)));
        return fresh;
      } catch (err) {
        // "Gone" is an answer, not a failure — the caller renders it as
        // such; every other error still propagates to the caller's
        // retry-able error surface.
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    [],
  );

  useEffect(() => {
    return () => {
      refetchOwnTicketCtrlRef.current?.abort();
    };
  }, []);

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
    // Fetch-on-mount / on-filter-change: the loader sets loading=true
    // synchronously by design (the codebase's fetch-effect convention).
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  // ── Detail (id-addressed fetch) ──
  // The authoritative source for the nested detail view: `GET /tickets/:id`.
  // The cached `mine`/`community` rows remain an instant-render fast path,
  // but the view must never DEPEND on list membership — both lists are
  // filtered by the board's status/type filter, so a just-filed ticket can
  // be absent from them (the "file → open → not found" regression).
  const [detail, setDetail] = useState<TicketDetailResult | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailCtrlRef = useRef<AbortController | null>(null);

  const loadDetail = useCallback((id: number): void => {
    const ctrl = new AbortController();
    detailCtrlRef.current?.abort();
    detailCtrlRef.current = ctrl;
    setDetailLoading(true);
    setDetailError(null);
    fetchTicket(id, ctrl.signal)
      .then((result) => {
        if (ctrl.signal.aborted) return;
        setDetail(result);
        setDetailLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        // A 404 is an ANSWER ("no such ticket"), not a failure: leave
        // `detailError` null so the render falls through to the honest
        // not-found card instead of a retry surface that can never succeed.
        if (!(err instanceof ApiError && err.status === 404)) {
          setDetailError(errorMessageFor(err, 'Could not load that ticket.'));
        }
        setDetailLoading(false);
      });
  }, []);

  useEffect(() => {
    // A ticket-id change invalidates any previously fetched row — clear
    // BEFORE (re)fetching so ticket A's data can never render under ticket
    // B's id. Loader sets loading=true synchronously by design (the
    // codebase's fetch-effect convention).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetail(null);
    setDetailError(null);
    if (ticketId === null) return;
    loadDetail(ticketId);
    return () => {
      detailCtrlRef.current?.abort();
    };
  }, [ticketId, loadDetail]);

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

  const onTicketUpdated = useCallback(
    (updated: OwnTicket): void => {
      setMine((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      // The PATCH (or 409-recovery) response is the server's freshest word
      // on this row — and an ownership proof in itself. When it's the ticket
      // currently open, make it authoritative over the detail fetch: ABORT
      // any older in-flight `GET /tickets/:id` so a slower, pre-save
      // response can never land afterwards and snap the view back to stale
      // data, then store the saved row as the detail. This runs even when
      // the initial fetch hasn't resolved yet (`detail` still null) — the
      // exact window a previous `prev !== null` guard missed: a save that
      // outran the detail fetch was skipped here, and the late fetch then
      // overwrote the just-saved row (fix-pass F-1, REVIEW_ticket_client.md).
      // The id check keeps a save that resolves AFTER navigating to a
      // different ticket from clobbering (or aborting) the new ticket's own
      // load.
      if (updated.id === ticketId) {
        detailCtrlRef.current?.abort();
        setDetail({ kind: 'own', ticket: updated });
        setDetailLoading(false);
        setDetailError(null);
      }
    },
    [ticketId],
  );

  // F-128 — stable identity is not optional here: `Sheet`'s `useModalA11y`
  // re-arms its focus-capture/restore effect whenever `onClose`'s reference
  // changes (it's in that effect's dependency array), and this page
  // re-renders on every list/tab/filter state change while the sheet may be
  // open. An inline arrow here would retrigger that effect on each such
  // render, each time re-capturing "the element focused right now" as the
  // restore target — one of those captures can land on `<body>` before the
  // Sheet's own initial-focus effect has had a chance to move focus into
  // the form, and the later restore-on-close would then steal focus back to
  // `<body>` instead of the Title field. `useCallback` keeps the reference
  // stable across renders so the effect only re-arms on a real open/close.
  const closeFileSheet = useCallback((): void => {
    setFileOpen(false);
  }, []);

  const onFiled = useCallback(
    (created: OwnTicket): void => {
      setMine((prev) => [created, ...prev]);
      toast({ message: 'Ticket filed.', tone: 'success' });
      // F-128: the form lives in a Sheet now — a successful file closes it
      // (matching the km-final.html mock's "file → sheet closes → toast"
      // beat) instead of leaving it sitting open with a just-cleared form.
      closeFileSheet();
    },
    [closeFileSheet, toast],
  );

  // ── Detail (nested view) ──
  if (ticketId !== null) {
    const mineDetail = mine.find((t) => t.id === ticketId) ?? null;
    const communityDetail = community.find((t) => t.id === ticketId) ?? null;
    // The id-addressed fetch is authoritative (fresh, and unhideable by the
    // board filter); the cached list rows are only the instant-render fast
    // path while it's in flight. The `.ticket.id === ticketId` guard is
    // belt-and-braces — the effect above clears `detail` on every id change.
    const fetchedOwn =
      detail !== null && detail.kind === 'own' && detail.ticket.id === ticketId
        ? detail.ticket
        : null;
    const fetchedCommunity =
      detail !== null &&
      detail.kind === 'community' &&
      detail.ticket.id === ticketId
        ? detail.ticket
        : null;
    // An owner-shaped row wins over a community-shaped one — only it
    // carries `version`, and therefore edit rights. Ownership is the
    // SERVER's decision either way (the /tickets/:id owner branch, or
    // /mine membership) — never a client guess (see module header).
    const ownDetail = fetchedOwn ?? mineDetail;
    const ticket = ownDetail ?? fetchedCommunity ?? communityDetail;
    const backTo = `/tickets?tab=${tab}`;
    const backLabel = tab === 'mine' ? 'My tickets' : 'Community';

    return (
      <section
        className="screen km-tickets km-rain-sheen"
        aria-labelledby="km-tickets-title"
      >
        <BackButton to={backTo} label={backLabel} />
        {/* F-128 devices #4/#2 — the shared hub-header recipe instead of a
            bare `Topbar`. */}
        <PageHubHeader
          titleId="km-tickets-title"
          eyebrow={<Bilingual en="Feedback" kr="피드백" />}
          heading={<Bilingual en="Ticket" kr="티켓" />}
        />
        {ticket === null ? (
          detailLoading || mineLoading || communityLoading ? (
            <p role="status" className="km-tickets__state">
              Loading…
            </p>
          ) : detailError !== null ? (
            <ErrorCard
              message={detailError}
              onRetry={() => {
                loadDetail(ticketId);
              }}
            />
          ) : (
            <Card className="km-tickets__state">
              We couldn&apos;t find that ticket.
            </Card>
          )
        ) : (
          <TicketDetail
            ticket={ticket}
            canEdit={ownDetail !== null}
            onTicketUpdated={onTicketUpdated}
            refetchOwnTicket={refetchOwnTicket}
          />
        )}
      </section>
    );
  }

  // ── List view ──
  return (
    <section
      className="screen km-tickets km-rain-sheen"
      aria-labelledby="km-tickets-title"
    >
      {/* F-128 devices #4/#2 — the shared hub-header recipe instead of a
          bare `Topbar`; the "New ticket" action opens the file-a-ticket
          Sheet (device: shared `Sheet`, matching the km-final.html
          "+ New" → sheet mock) instead of an always-inline form. */}
      <PageHubHeader
        titleId="km-tickets-title"
        eyebrow={<Bilingual en="Feedback" kr="피드백" />}
        heading={<Bilingual en="Beta Feedback" kr="베타 피드백" />}
        actions={
          <Button
            variant="gold"
            size="sm"
            onClick={() => {
              setFileOpen(true);
            }}
            leadingIcon={<Icon name="plus" size={14} />}
          >
            <Bilingual en="New ticket" kr="새 티켓" />
          </Button>
        }
      />

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

      {/* Fix-pass batch-4 (REVIEW_batch4-fidelity.md gap-d): `tone="plain"`
          opts this sheet into the Seoul top-edge treatment while keeping the
          same "no skill color" restraint as this page's own `tone="plain"`
          CityCards above (a ticket carries no skill identity — Pills carry
          type/status instead). */}
      <Sheet
        open={fileOpen}
        onClose={closeFileSheet}
        ariaLabel="File a ticket"
        tone="plain"
      >
        <FileTicketForm
          onFiled={onFiled}
          sourcePage={sourcePage}
          type={draftType}
          onTypeChange={setDraftType}
          title={draftTitle}
          onTitleChange={setDraftTitle}
          body={draftBody}
          onBodyChange={setDraftBody}
        />
      </Sheet>
    </section>
  );
}
