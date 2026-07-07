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

  it('coerces the BIGINT id the wire delivers as a string onto the numeric contract', async () => {
    // `res.json(rows[0])` server-side returns the BIGINT `id` raw — pg
    // serialises it as a JSON STRING (no int8 parser). The declared
    // `MetricSnapshot.id: number` must be true after the service boundary.
    vi.spyOn(api, 'put').mockResolvedValueOnce({
      id: '456',
      captured_at: 'now',
    });

    const out = await updateMetric('reading_score', 87);

    expect(out.id).toBe(456);
    expect(typeof out.id).toBe('number');
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

  it('clamps minutes above the server cap (1440) so the log is never silently lost', async () => {
    // A Review tab left open >24h posts an over-cap wall-clock total; the
    // server schema (`minutes.max(1440)`) 400s it and the caller's
    // fire-and-forget catch swallows the failure — the day's study time
    // vanished. The service must clamp, not forward the raw value.
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ id: 1, minutes_studied: '1440' });

    await logStudy({ minutes: 1500, activity: 'review' });

    expect(spy).toHaveBeenCalledWith('/progress/study-log', {
      minutes: 1440,
      activity: 'review',
    });
  });

  it('floors negative minutes at 0 (server schema is nonnegative)', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ id: 1, minutes_studied: '0' });

    await logStudy({ minutes: -3, activity: 'review' });

    expect(spy).toHaveBeenCalledWith('/progress/study-log', {
      minutes: 0,
      activity: 'review',
    });
  });

  it('coerces the BIGINT id the wire delivers as a string onto the numeric contract', async () => {
    vi.spyOn(api, 'post').mockResolvedValueOnce({
      id: '123',
      minutes_studied: '12',
    });

    const out = await logStudy({ minutes: 12, activity: 'reading' });

    expect(out.id).toBe(123);
    expect(typeof out.id).toBe('number');
    // `minutes_studied` stays a string — that's the documented wire type.
    expect(out.minutes_studied).toBe('12');
  });
});
