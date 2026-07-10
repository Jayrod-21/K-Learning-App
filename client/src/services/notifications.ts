/**
 * /notifications/schedules — per-type notification timing (F-040).
 *
 * The Settings screen's notification section used to persist timing-less
 * intent booleans inside the `/settings/prefs` blob ("daily: true", no notion
 * of WHEN). F-040 supersedes that with real schedules: for each notification
 * kind the user picks a time-of-day (+ weekday for the weekly report), and the
 * row is keyed server-side on (user, kind, channel).
 *
 * Wire contract (server/src/routes/notifications.ts, locked):
 *   - `GET /notifications/schedules` → `200 { schedules: NotificationSchedule[] }`.
 *     EMPTY for a fresh user — nothing is implicitly on; the client renders its
 *     own suggested defaults until the user picks a time.
 *   - `PUT /notifications/schedules` → body `{ schedules: NotificationScheduleInput[] }`
 *     (1–9 entries, no duplicate (kind, channel) pairs — the server 400s both).
 *     Upserts on the (user, kind, channel) key and echoes the FULL stored set.
 *   - `weekday` is REQUIRED for `weekly_report` and FORBIDDEN for the other
 *     kinds (the server schema is `.strict()` + superRefined) — callers must
 *     OMIT the key entirely for non-weekly kinds, not send `undefined`.
 *   - The `sms` channel is a stored-but-never-sent PLACEHOLDER; the server
 *     flags such rows `placeholder: true` so the client can label them honestly.
 *
 * Threat model (file-scope, in addition to `services/api.ts`):
 *   - CSRF: PUT is state-changing; defended by the session cookie's
 *     `SameSite=Strict` posture (see api.ts).
 *   - Input validation: the server Zod-validates (`.strict()`) so a bad enum,
 *     malformed time, or unresolvable tz 400s at the boundary. The client
 *     trusts its TS types at the call site (Pass 3 contract) — but treats the
 *     RESPONSE's `kind`/`channel` as unvalidated strings and narrows with the
 *     guards below before adopting, so a future server-side enum extension
 *     degrades to "row ignored", never a crash.
 *   - Failure containment: callers surface `ApiError` — unlike `/settings/prefs`
 *     there is NO localStorage fallback for schedules, so the Settings screen
 *     keeps its dirty-set until a PUT succeeds and offers an explicit retry.
 */
import { api } from './api';

export const NOTIFICATION_KINDS = [
  'daily_reminder',
  'reviews_due',
  'weekly_report',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_CHANNELS = ['push', 'email', 'sms'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Narrow a wire `kind` string — see the threat model on response narrowing. */
export function isNotificationKind(value: string): value is NotificationKind {
  return (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

/** Narrow a wire `channel` string. */
export function isNotificationChannel(
  value: string,
): value is NotificationChannel {
  return (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}

/** One stored schedule as the server reports it (GET + PUT echo). `kind` and
 *  `channel` are deliberately `string` on the wire type — narrow with the
 *  guards above before treating a row as a known kind. */
export interface NotificationSchedule {
  kind: string;
  channel: string;
  /** Zero-padded 24h wall-clock, minute precision ('07:30', '23:05'). */
  timeOfDay: string;
  /** IANA time-zone name the wall-clock is anchored to. */
  tz: string;
  /** 0=Sunday .. 6=Saturday; non-null only for weekly_report. */
  weekday: number | null;
  enabled: boolean;
  /** True for the stored-but-never-sent placeholder channel (sms). */
  placeholder: boolean;
  updatedAt: string;
}

/** One schedule to upsert. `weekday` must be present iff kind is
 *  weekly_report (server `.strict()` schema — omit the key, never send
 *  `undefined`). */
export interface NotificationScheduleInput {
  kind: NotificationKind;
  channel: NotificationChannel;
  timeOfDay: string;
  tz: string;
  weekday?: number;
  enabled: boolean;
}

/** Envelope both routes speak. */
export interface NotificationSchedulesResponse {
  schedules: NotificationSchedule[];
}

/** GET /notifications/schedules → the user's stored schedules. */
export async function fetchSchedules(
  signal?: AbortSignal,
): Promise<NotificationSchedulesResponse> {
  return api.get<NotificationSchedulesResponse>(
    '/notifications/schedules',
    signal !== undefined ? { signal } : undefined,
  );
}

/**
 * PUT /notifications/schedules → upsert the given schedules and echo the full
 * stored set. Partial by design: send only the rows that changed — the server
 * upserts on (kind, channel) and leaves the rest untouched.
 */
export async function putSchedules(
  schedules: NotificationScheduleInput[],
  signal?: AbortSignal,
): Promise<NotificationSchedulesResponse> {
  return api.put<NotificationSchedulesResponse>(
    '/notifications/schedules',
    { schedules },
    signal !== undefined ? { signal } : undefined,
  );
}
