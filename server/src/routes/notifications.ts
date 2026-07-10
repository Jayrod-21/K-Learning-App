/**
 * /notifications/schedules routes — user-selectable notification timing (F-040,
 * supersedes F-006).
 *
 * The Settings screen's notification section previously stored timing-less
 * INTENT booleans inside users.preferences (migration 018 blob — "daily: true",
 * no notion of WHEN). F-040 replaces that with real schedules: for each of the
 * three notification kinds (daily_reminder / reviews_due / weekly_report) the
 * user picks a time-of-day (+ weekday for the weekly report), a time zone, and
 * a channel, persisted in notification_schedules (migration 052).
 *
 *   GET /notifications/schedules → the user's stored schedules (empty for a
 *                                  fresh user — nothing is implicitly on)
 *   PUT /notifications/schedules → upsert one or more schedules on the
 *                                  (user, kind, channel) key; echoes the full
 *                                  stored set afterwards
 *
 * SCOPE (deliberate): persistence + CRUD only. NO sender, scheduler, or worker
 * exists yet — that is a later phase, which will consume these rows and write
 * notification_deliveries. The `sms` channel is a PLACEHOLDER: accepted and
 * stored so the choice persists, never sent; responses flag such rows with
 * `placeholder: true` so the client can label them honestly.
 *
 * SECURITY (the /settings/prefs posture — low-surface, cheap, authed):
 *   - IDOR: every query is scoped to `getUserId(req)`; there is no :id in any
 *     path — the subject is always the session user — so cross-user access is
 *     structurally impossible.
 *   - Mass-assignment / unknown-key injection: the body schema is `.strict()`
 *     at every level; an unknown key, bad enum, malformed time, or unresolvable
 *     time zone is a clean 400 (validateBody) and never reaches SQL. All SQL is
 *     parameterized.
 *   - Row-count abuse: the upsert key (user_id, kind, channel) bounds a user to
 *     at most 3 kinds x 3 channels = 9 rows EVER; the payload is capped at 9
 *     entries and intra-payload duplicates are rejected, so a hostile client
 *     cannot grow the table or make ON CONFLICT touch one row twice.
 *   - Cost: no Claude, no external I/O — the standard cheap limiter suffices.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter } from '../middleware/rateLimits.js';
import { validateBody } from '../middleware/validate.js';
import { query } from '../db/pool.js';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Schema — mirrors the CHECK constraints of migration 052 exactly, so a body
// that passes validation can never trip a DB constraint (and anything the DB
// would reject is a 400 here, not a 500 there).
// ---------------------------------------------------------------------------

const ScheduleKind = z.enum(['daily_reminder', 'reviews_due', 'weekly_report']);
const ScheduleChannel = z.enum(['push', 'email', 'sms']);

/** 24h wall-clock, minute precision, zero-padded ('07:30', '23:05'). */
const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * IANA time-zone validity — the runtime's own zone database is the source of
 * truth (same engine that will localize the send later), so aliases like
 * 'Asia/Calcutta' pass where a strict Intl.supportedValuesOf lookup would not.
 * The DB cannot enforce this (a CHECK can't consult pg_timezone_names), so the
 * route is the gate.
 */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const ScheduleInputSchema = z
  .object({
    kind: ScheduleKind,
    channel: ScheduleChannel,
    timeOfDay: z
      .string()
      .regex(TIME_OF_DAY_RE, 'timeOfDay must be zero-padded 24h HH:MM'),
    tz: z
      .string()
      .min(1)
      .max(64)
      .refine(isValidTimeZone, 'tz must be a resolvable IANA time-zone name'),
    // 0=Sunday .. 6=Saturday (JS Date.getDay()); required iff weekly_report —
    // enforced by the superRefine below, mirroring the 052 CHECK.
    weekday: z.number().int().min(0).max(6).optional(),
    enabled: z.boolean(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.kind === 'weekly_report' && s.weekday === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weekday'],
        message: 'weekday is required for weekly_report',
      });
    }
    if (s.kind !== 'weekly_report' && s.weekday !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weekday'],
        message: `weekday is only valid for weekly_report, not ${s.kind}`,
      });
    }
  });

/** 3 kinds x 3 channels — a user can never legitimately send more rows. */
const MAX_SCHEDULES = 9;

const PutSchedulesSchema = z
  .object({
    schedules: z.array(ScheduleInputSchema).min(1).max(MAX_SCHEDULES),
  })
  .strict()
  .superRefine((body, ctx) => {
    // A duplicate (kind, channel) pair in one payload would make the batch
    // upsert's ON CONFLICT touch the same row twice — a Postgres error, and an
    // ambiguous request anyway (which timing wins?). Reject it as a 400.
    const seen = new Set<string>();
    body.schedules.forEach((s, i) => {
      const key = `${s.kind}/${s.channel}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['schedules', i],
          message: `duplicate schedule for (${s.kind}, ${s.channel}) in payload`,
        });
      }
      seen.add(key);
    });
  });

type ScheduleInput = z.infer<typeof ScheduleInputSchema>;

// ---------------------------------------------------------------------------
// Serialization — one shape for GET and PUT responses.
// ---------------------------------------------------------------------------

interface ScheduleRow {
  kind: string;
  channel: string;
  time_of_day: string;
  tz: string;
  weekday: number | null;
  enabled: boolean;
  updated_at: Date;
}

interface ScheduleView {
  kind: string;
  channel: string;
  timeOfDay: string;
  tz: string;
  weekday: number | null;
  enabled: boolean;
  /** true for the stored-but-never-sent placeholder channel (sms, F-040). */
  placeholder: boolean;
  updatedAt: string;
}

function toView(r: ScheduleRow): ScheduleView {
  return {
    kind: r.kind,
    channel: r.channel,
    timeOfDay: r.time_of_day,
    tz: r.tz,
    weekday: r.weekday,
    enabled: r.enabled,
    placeholder: r.channel === 'sms',
    updatedAt: r.updated_at.toISOString(),
  };
}

/** The user's schedules, normalized (HH:MM) and deterministically ordered. */
async function selectSchedules(userId: number): Promise<ScheduleView[]> {
  const { rows } = await query<ScheduleRow>(
    `SELECT kind,
            channel,
            to_char(time_of_day, 'HH24:MI') AS time_of_day,
            tz,
            weekday,
            enabled,
            updated_at
       FROM notification_schedules
      WHERE user_id = $1
      ORDER BY kind, channel`,
    [userId],
  );
  return rows.map(toView);
}

// ---------------------------------------------------------------------------
// GET /notifications/schedules — the user's stored schedules.
// ---------------------------------------------------------------------------

router.get('/schedules', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    // Empty for a fresh user is CORRECT, not a gap: no notification is
    // implicitly on — a schedule exists only once the user has picked a time
    // (the client renders its own suggested defaults until then).
    res.status(200).json({ schedules: await selectSchedules(userId) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /notifications/schedules — upsert on the (user, kind, channel) key.
// ---------------------------------------------------------------------------

router.put(
  '/schedules',
  cheapLimiter(),
  validateBody(PutSchedulesSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { schedules } = req.body as { schedules: ScheduleInput[] };

      // One multi-row statement — the whole batch commits or aborts together
      // (no explicit transaction plumbing needed), and ON CONFLICT arbiters on
      // the 052 unique key so concurrent saves of the same schedule are
      // last-writer-wins per row, never a duplicate. The trigger bumps
      // updated_at; version increments only on the UPDATE arm (ADR-001 §D6).
      await query(
        `INSERT INTO notification_schedules
                (user_id, kind, channel, time_of_day, tz, weekday, enabled)
         SELECT $1, u.kind, u.channel, u.time_of_day::time, u.tz, u.weekday, u.enabled
           FROM unnest($2::text[], $3::text[], $4::text[], $5::text[],
                       $6::smallint[], $7::boolean[])
                AS u(kind, channel, time_of_day, tz, weekday, enabled)
         ON CONFLICT ON CONSTRAINT uq_notification_schedules_user_kind_channel
         DO UPDATE
               SET time_of_day = EXCLUDED.time_of_day,
                   tz          = EXCLUDED.tz,
                   weekday     = EXCLUDED.weekday,
                   enabled     = EXCLUDED.enabled,
                   version     = notification_schedules.version + 1`,
        [
          userId,
          schedules.map((s) => s.kind),
          schedules.map((s) => s.channel),
          schedules.map((s) => s.timeOfDay),
          schedules.map((s) => s.tz),
          schedules.map((s) => s.weekday ?? null),
          schedules.map((s) => s.enabled),
        ],
      );

      // Echo the FULL stored set (not just the touched rows) so the client can
      // replace its local state wholesale — the same confirm-what-persisted
      // posture as /settings/prefs.
      res.status(200).json({ schedules: await selectSchedules(userId) });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
