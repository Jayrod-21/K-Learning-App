/**
 * hanja service — URL construction, filter/param + signal threading, envelope
 * unwrap (characters / character), and error re-throw. Mirrors the
 * topik/diagnostic service test style.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchHanjaList,
  fetchHanjaProgress,
  fetchHanjaToday,
  setHanjaState,
} from './hanja';
import { api, ApiError } from './api';
import type { Hanja, HanjaProgress } from '../types/domain';

afterEach(() => {
  vi.restoreAllMocks();
});

const CHAR: Hanja = {
  id: '學',
  ch: '學',
  sound: '학',
  gloss: '',
  en: 'learning, knowledge; school',
  level: 'L2',
  strokes: 16,
  state: 'practicing',
  note: '',
  compounds: [{ kr: '학교', han: '學校', en: 'a school', with: '校' }],
};

const PROGRESS: HanjaProgress = {
  banked: 6,
  practicing: 4,
  new: 748,
  targetL4: 300,
  encountered: 10,
  note: "You've crossed paths with 10 hanja so far.",
};

describe('fetchHanjaList', () => {
  it('GETs /hanja with no params for the whole pool and unwraps characters', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ characters: [CHAR] });

    const chars = await fetchHanjaList();

    expect(spy).toHaveBeenCalledWith('/hanja', undefined);
    expect(chars).toHaveLength(1);
    expect(chars[0]?.ch).toBe('學');
    expect(chars[0]?.compounds[0]?.han).toBe('學校');
  });

  it("treats 'all' as the whole pool — no filter param forwarded", async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ characters: [] });

    await fetchHanjaList('all');

    expect(spy).toHaveBeenCalledWith('/hanja', undefined);
  });

  it('forwards a narrowing filter as a query param', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ characters: [] });

    await fetchHanjaList('banked');

    expect(spy).toHaveBeenCalledWith('/hanja', { params: { filter: 'banked' } });
  });

  it('threads both the filter param and an AbortSignal into the request config', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ characters: [CHAR] });
    const ctrl = new AbortController();

    await fetchHanjaList('practicing', ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/hanja', {
      params: { filter: 'practicing' },
      signal: ctrl.signal,
    });
  });

  it('threads an AbortSignal alone when no filter is given', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ characters: [] });
    const ctrl = new AbortController();

    await fetchHanjaList(undefined, ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/hanja', { signal: ctrl.signal });
  });

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    await expect(fetchHanjaList()).rejects.toMatchObject({ status: 500 });
  });
});

describe('fetchHanjaToday', () => {
  it('GETs /hanja/today and unwraps the character envelope', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ character: CHAR });

    const today = await fetchHanjaToday();

    expect(spy).toHaveBeenCalledWith('/hanja/today', undefined);
    expect(today?.ch).toBe('學');
  });

  it('surfaces a null character (empty corpus) straight through', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({ character: null });

    const today = await fetchHanjaToday();

    expect(today).toBeNull();
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ character: CHAR });
    const ctrl = new AbortController();

    await fetchHanjaToday(ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/hanja/today', { signal: ctrl.signal });
  });

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('unauthorized', { status: 401, code: 'unauthorized' }),
    );

    await expect(fetchHanjaToday()).rejects.toMatchObject({ status: 401 });
  });
});

describe('fetchHanjaProgress', () => {
  it('GETs /hanja/progress and returns the body unchanged', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(PROGRESS);

    const progress = await fetchHanjaProgress();

    expect(spy).toHaveBeenCalledWith('/hanja/progress', undefined);
    expect(progress.banked).toBe(6);
    expect(progress.targetL4).toBe(300);
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(PROGRESS);
    const ctrl = new AbortController();

    await fetchHanjaProgress(ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/hanja/progress', {
      signal: ctrl.signal,
    });
  });

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('boom', { status: 503, code: 'server_error' }),
    );

    await expect(fetchHanjaProgress()).rejects.toMatchObject({ status: 503 });
  });
});

describe('setHanjaState', () => {
  it('POSTs /hanja/:char/state with the body and returns the confirmation', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ char: '學', state: 'banked' });

    const res = await setHanjaState('學', 'banked');

    expect(spy).toHaveBeenCalledWith(
      '/hanja/%E5%AD%B8/state',
      { state: 'banked' },
      undefined,
    );
    expect(res).toEqual({ char: '學', state: 'banked' });
  });

  it('URL-encodes the character as defence-in-depth', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ char: '生', state: 'practicing' });

    await setHanjaState('生', 'practicing');

    expect(spy).toHaveBeenCalledWith(
      `/hanja/${encodeURIComponent('生')}/state`,
      { state: 'practicing' },
      undefined,
    );
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ char: '學', state: 'new' });
    const ctrl = new AbortController();

    await setHanjaState('學', 'new', ctrl.signal);

    expect(spy).toHaveBeenCalledWith(
      '/hanja/%E5%AD%B8/state',
      { state: 'new' },
      { signal: ctrl.signal },
    );
  });

  it('rethrows ApiError on failure (caller decides whether to swallow)', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('bad state', { status: 400, code: 'validation' }),
    );

    await expect(setHanjaState('學', 'banked')).rejects.toMatchObject({
      status: 400,
    });
  });
});
