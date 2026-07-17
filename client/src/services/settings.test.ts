/**
 * settings service — /settings/prefs URL/body wiring + error surface.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPrefs, patchToursSeen, putPrefs, type Prefs } from './settings';
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
  palette: { paper: 'hanji', accent: 'coral', correct: 'moss', wrong: 'vermilion' },
  languageDisplay: { mode: 'both', primary: 'ko', subScale: 0.7 },
  textSize: 'md',
  toursSeen: ['first-run'],
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

describe('patchToursSeen', () => {
  it('PATCHes /settings/prefs/tours-seen with ONLY the toursSeen field and returns the echoed prefs', async () => {
    const echoed = { ...PREFS, toursSeen: ['first-run', 'hanja'] };
    const spy = vi.spyOn(api, 'patch').mockResolvedValueOnce(echoed);

    const out = await patchToursSeen(['first-run', 'hanja']);

    expect(spy).toHaveBeenCalledWith(
      '/settings/prefs/tours-seen',
      { toursSeen: ['first-run', 'hanja'] },
      undefined,
    );
    expect(out).toEqual(echoed);
  });

  it('forwards the abort signal when given', async () => {
    const spy = vi.spyOn(api, 'patch').mockResolvedValueOnce(PREFS);
    const ctrl = new AbortController();

    await patchToursSeen(['first-run'], ctrl.signal);

    expect(spy).toHaveBeenCalledWith(
      '/settings/prefs/tours-seen',
      { toursSeen: ['first-run'] },
      { signal: ctrl.signal },
    );
  });

  it('surfaces failures as ApiError (caller treats the sync as best-effort)', async () => {
    vi.spyOn(api, 'patch').mockRejectedValueOnce(
      new ApiError('network unreachable', { status: 0, code: 'network' }),
    );

    await expect(patchToursSeen(['first-run'])).rejects.toMatchObject({
      code: 'network',
    });
  });
});
