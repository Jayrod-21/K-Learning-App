/**
 * /progress — metric snapshots + daily study log.
 *
 * Threat model:
 *   - Auth required. Server middleware additionally rejects any body whose
 *     `user_id` field names a different user (defence in depth).
 *   - Append-only metrics: `PUT /progress/:metricType` inserts a new row,
 *     it never overwrites. A botched client retry is therefore safe-ish:
 *     duplicates won't corrupt history, but they DO double-count if the
 *     metric is summed. UI should treat the call as not-idempotent and
 *     dedupe at the call site if needed.
 *   - Study-log upsert is keyed on `(user_id, study_date)`; the same
 *     `(date, activity, minutes)` posted twice produces a single row with
 *     `minutes_studied` doubled. Client should debounce or use a single
 *     POST per session.
 *   - Date validation: server expects `YYYY-MM-DD`. The TS type is
 *     `string`; callers should format with a tested helper.
 */
import { coerceId } from '../lib/coerceId';
import { api } from './api';
import type {
  MetricSnapshot,
  ProgressResponse,
  StudyLogBody,
  StudyLogResult,
  UpdateMetricBody,
} from '../types/domain';

/** GET /progress — latest snapshot per metric. */
export async function fetchProgress(): Promise<ProgressResponse> {
  return api.get<ProgressResponse>('/progress');
}

/**
 * Server-side cap on a study-log's `minutes` (`routes/progress.ts`
 * `minutes.max(1440)` — one full day). A Review tab left open across a day
 * boundary can legitimately measure more wall-clock than that; sending it
 * raw 400s and the caller's fire-and-forget `.catch(()=>{})` swallows the
 * failure, silently losing the day's study time. Clamp at the boundary.
 */
const MAX_STUDY_MINUTES = 1440;

/** PUT /progress/:metricType — append a snapshot. */
export async function updateMetric(
  metricType: string,
  value: UpdateMetricBody['value'],
): Promise<MetricSnapshot> {
  const res = await api.put<MetricSnapshot>(
    `/progress/${encodeURIComponent(metricType)}`,
    { value },
  );
  // BIGINT `id` arrives as a JSON string (`res.json(rows[0])` raw, no int8
  // parser) — coerce onto the declared numeric type. `domain.ts` already
  // documents `minutes_studied` as a string for the same reason.
  return { ...res, id: coerceId(res.id) };
}

/** POST /progress/study-log — append minutes for a day. Upsert by (user, day). */
export async function logStudy(body: StudyLogBody): Promise<StudyLogResult> {
  const safeBody: StudyLogBody = {
    ...body,
    minutes: Math.min(Math.max(0, body.minutes), MAX_STUDY_MINUTES),
  };
  const res = await api.post<StudyLogResult>('/progress/study-log', safeBody);
  // Same BIGINT-as-string wire leak as `updateMetric` — coerce `id`.
  return { ...res, id: coerceId(res.id) };
}
