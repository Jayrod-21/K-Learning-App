/**
 * settings service — /settings/prefs URL/body wiring + error surface.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPrefs, putPrefs, type Prefs } from './settings';
import { api, ApiError } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

const PREFS: Prefs = {
  notif: {
    channel: { email: true, sms: false },
    reviewsDue: true,
    daily: false,
    weekly: true,
  },
  palette: { paper: 'hanji', accent: 'vermilion', correct: 'moss', wrong: 'vermilion' },
};

describe('fetchPrefs', () => {
  it('GETs /settings/prefs and returns the body', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(PREFS);

    const out = await fetchPrefs();

    expect(spy).toHaveBeenCalledWith('/settings/prefs', undefined);
    expect(out).toEqual(PREFS);
  });

  it('forwards the abort signal when given', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(PREFS);
    const ctrl = new AbortController();

    await fetchPrefs(ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/settings/prefs', { signal: ctrl.signal });
  });

  it('surfaces a 401 as ApiError', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('unauthorized', { status: 401, code: 'unauthorized' }),
    );

    await expect(fetchPrefs()).rejects.toMatchObject({ status: 401 });
  });
});

describe('putPrefs', () => {
  it('PUTs /settings/prefs with the full prefs object', async () => {
    const spy = vi.spyOn(api, 'put').mockResolvedValueOnce(PREFS);

    const out = await putPrefs(PREFS);

    expect(spy).toHaveBeenCalledWith('/settings/prefs', PREFS, undefined);
    expect(out).toEqual(PREFS);
  });

  it('forwards the abort signal when given', async () => {
    const spy = vi.spyOn(api, 'put').mockResolvedValueOnce(PREFS);
    const ctrl = new AbortController();

    await putPrefs(PREFS, ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/settings/prefs', PREFS, {
      signal: ctrl.signal,
    });
  });

  it('surfaces a 400 (bad palette enum) as ApiError', async () => {
    vi.spyOn(api, 'put').mockRejectedValueOnce(
      new ApiError('bad request', { status: 400, code: 'validation' }),
    );

    await expect(putPrefs(PREFS)).rejects.toMatchObject({ status: 400 });
  });

  it('surfaces a network failure', async () => {
    vi.spyOn(api, 'put').mockRejectedValueOnce(
      new ApiError('network unreachable', { status: 0, code: 'network' }),
    );

    await expect(putPrefs(PREFS)).rejects.toMatchObject({ code: 'network' });
  });
});
