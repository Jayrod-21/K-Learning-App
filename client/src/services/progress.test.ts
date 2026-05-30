/**
 * progress service — metric snapshot + study-log wiring.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchProgress, logStudy, updateMetric } from './progress';
import { api, ApiError } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchProgress', () => {
  it('GETs /progress and returns the envelope', async () => {
    const payload = { metrics: [] };
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(payload);

    const got = await fetchProgress();

    expect(spy).toHaveBeenCalledWith('/progress');
    expect(got).toBe(payload);
  });
});

describe('updateMetric', () => {
  it('PUTs /progress/:metricType with { value } and URL-encodes the segment', async () => {
    const spy = vi.spyOn(api, 'put').mockResolvedValueOnce({ id: 1, captured_at: 'now' });

    await updateMetric('reading_score', 87);

    expect(spy).toHaveBeenCalledWith('/progress/reading_score', { value: 87 });
  });

  it('URL-encodes a metric type with unsafe chars (defence in depth)', async () => {
    const spy = vi.spyOn(api, 'put').mockResolvedValueOnce({ id: 2, captured_at: 'now' });

    await updateMetric('hangeul space', 'a');

    expect(spy).toHaveBeenCalledWith('/progress/hangeul%20space', { value: 'a' });
  });

  it('surfaces 400 from the server schema', async () => {
    vi.spyOn(api, 'put').mockRejectedValueOnce(
      new ApiError('bad metric', { status: 400, code: 'validation' }),
    );

    await expect(updateMetric('Bad-name', 1)).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('logStudy', () => {
  it('POSTs /progress/study-log with the body', async () => {
    const body = { minutes: 12, activity: 'reading' };
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ id: 99, minutes_studied: '12' });

    const out = await logStudy(body);

    expect(spy).toHaveBeenCalledWith('/progress/study-log', body);
    expect(out.minutes_studied).toBe('12');
  });

  it('surfaces network errors', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('network unreachable', { status: 0, code: 'network' }),
    );
    await expect(
      logStudy({ minutes: 1, activity: 'x' }),
    ).rejects.toMatchObject({ code: 'network' });
  });
});
