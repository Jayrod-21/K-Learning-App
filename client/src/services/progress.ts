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

/** PUT /progress/:metricType — append a snapshot. */
export async function updateMetric(
  metricType: string,
  value: UpdateMetricBody['value'],
): Promise<MetricSnapshot> {
  return api.put<MetricSnapshot>(
    `/progress/${encodeURIComponent(metricType)}`,
    { value },
  );
}

/** POST /progress/study-log — append minutes for a day. Upsert by (user, day). */
export async function logStudy(body: StudyLogBody): Promise<StudyLogResult> {
  return api.post<StudyLogResult>('/progress/study-log', body);
}
