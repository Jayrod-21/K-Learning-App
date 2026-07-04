/**
 * diagnostic service — URL construction, body/signal threading, pass-through
 * mapping, and error re-throw. Mirrors the plan/vocab service test style.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  answerDiagnostic,
  fetchLatestSnapshot,
  fetchTrajectory,
  finishDiagnostic,
  getHistory,
  nextDiagnostic,
  startDiagnostic,
  type FinishDiagnosticResponse,
} from './diagnostic';
import { api, ApiError } from './api';
import type {
  DiagnosticAnswerResponse,
  DiagnosticHistoryResponse,
  DiagnosticLiveItem,
  DiagnosticNextResponse,
  DiagnosticSnapshot,
  DiagnosticStartResponse,
} from '../types/domain';

afterEach(() => {
  vi.restoreAllMocks();
});

const ITEM: DiagnosticLiveItem = {
  responseId: 11,
  ordinal: 1,
  section: 'vocab',
  level: 'L4',
  kind: 'cloze',
  prompt: '회사에서 새로운 정책을 ( ) 했다.',
  choices: [
    { id: 'a', kr: '발표', en: 'announce' },
    { id: 'b', kr: '발견', en: 'discover' },
  ],
};

const START: DiagnosticStartResponse = {
  runId: 7,
  item: ITEM,
  progress: { ordinal: 1, total: 8 },
};

const ANSWER: DiagnosticAnswerResponse = {
  result: { correct: true, correctAnswer: 'a', explain: '발표하다 = to announce.' },
  done: false,
  progress: { ordinal: 1, total: 8 },
};

const NEXT: DiagnosticNextResponse = {
  next: { ...ITEM, responseId: 12, ordinal: 2 },
  progress: { ordinal: 2, total: 8 },
};

const SNAPSHOT: DiagnosticSnapshot = {
  dimensions: [
    { key: 'reading', label: 'Reading', kr: '읽기', score: 62, note: 'OK' },
    { key: 'grammar', label: 'Grammar', kr: '문법', score: 48, note: 'Gap' },
  ],
  references: [{ id: 'L4', label: 'TOPIK 4', kr: '4급', value: 55 }],
  defaultRef: 'L4',
  goals: [],
};

describe('startDiagnostic', () => {
  it('POSTs /diagnostic with an empty body and returns the start envelope', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(START);

    const res = await startDiagnostic();

    expect(spy).toHaveBeenCalledWith('/diagnostic', {}, undefined);
    expect(res.runId).toBe(7);
    expect(res.item.responseId).toBe(11);
    expect(res.progress.total).toBe(8);
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(START);
    const ctrl = new AbortController();

    await startDiagnostic(ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/diagnostic', {}, { signal: ctrl.signal });
  });

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    await expect(startDiagnostic()).rejects.toMatchObject({ status: 500 });
  });
});

describe('answerDiagnostic', () => {
  it('POSTs /diagnostic/:runId/answer with the body and returns the reveal + done flag', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(ANSWER);

    const res = await answerDiagnostic(7, {
      responseId: 11,
      picked: 'a',
      timeMs: 4200,
    });

    expect(spy).toHaveBeenCalledWith(
      '/diagnostic/7/answer',
      { responseId: 11, picked: 'a', timeMs: 4200 },
      undefined,
    );
    expect(res.result.correct).toBe(true);
    expect(res.result.correctAnswer).toBe('a');
    expect(res.done).toBe(false);
  });

  it('sends picked:null for a skip', async () => {
    const skipResponse: DiagnosticAnswerResponse = {
      result: { correct: false, correctAnswer: 'a', explain: 'x' },
      done: true,
      progress: { ordinal: 8, total: 8 },
    };
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(skipResponse);

    const res = await answerDiagnostic(7, { responseId: 18, picked: null });

    expect(spy).toHaveBeenCalledWith(
      '/diagnostic/7/answer',
      { responseId: 18, picked: null },
      undefined,
    );
    expect(res.done).toBe(true);
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(ANSWER);
    const ctrl = new AbortController();

    await answerDiagnostic(7, { responseId: 11, picked: 'a' }, ctrl.signal);

    expect(spy).toHaveBeenCalledWith(
      '/diagnostic/7/answer',
      { responseId: 11, picked: 'a' },
      { signal: ctrl.signal },
    );
  });

  it('rethrows ApiError (e.g. 409 double-answer) on failure', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('out of order', { status: 409, code: 'conflict' }),
    );

    await expect(
      answerDiagnostic(7, { responseId: 11, picked: 'a' }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('nextDiagnostic', () => {
  it('POSTs /diagnostic/:runId/next with an empty body and returns the next item', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(NEXT);

    const res = await nextDiagnostic(7);

    expect(spy).toHaveBeenCalledWith('/diagnostic/7/next', {}, undefined);
    expect(res.next?.responseId).toBe(12);
    expect(res.next?.ordinal).toBe(2);
    expect(res.progress).toEqual({ ordinal: 2, total: 8 });
  });

  it('passes through next:null (run over early / fully served)', async () => {
    const over: DiagnosticNextResponse = {
      next: null,
      progress: { ordinal: 8, total: 8 },
    };
    vi.spyOn(api, 'post').mockResolvedValueOnce(over);

    const res = await nextDiagnostic(7);

    expect(res.next).toBeNull();
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(NEXT);
    const ctrl = new AbortController();

    await nextDiagnostic(7, ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/diagnostic/7/next', {}, {
      signal: ctrl.signal,
    });
  });

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('boom', { status: 502, code: 'upstream_error' }),
    );

    await expect(nextDiagnostic(7)).rejects.toMatchObject({ status: 502 });
  });
});

describe('finishDiagnostic', () => {
  it('POSTs /diagnostic/:runId/finish and returns the snapshot envelope', async () => {
    const envelope: FinishDiagnosticResponse = { snapshot: SNAPSHOT };
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(envelope);

    const res = await finishDiagnostic(7);

    expect(spy).toHaveBeenCalledWith('/diagnostic/7/finish', {}, undefined);
    expect(res.snapshot.dimensions).toHaveLength(2);
    expect(res.snapshot.dimensions[1].key).toBe('grammar');
  });

  it('threads an AbortSignal into the request config', async () => {
    const envelope: FinishDiagnosticResponse = { snapshot: SNAPSHOT };
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(envelope);
    const ctrl = new AbortController();

    await finishDiagnostic(7, ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/diagnostic/7/finish', {}, {
      signal: ctrl.signal,
    });
  });

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    await expect(finishDiagnostic(7)).rejects.toMatchObject({ status: 500 });
  });
});

describe('fetchLatestSnapshot', () => {
  it('GETs /diagnostic/latest and returns the snapshot', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(SNAPSHOT);

    const snap = await fetchLatestSnapshot();

    expect(spy).toHaveBeenCalledWith('/diagnostic/latest', undefined);
    expect(snap.defaultRef).toBe('L4');
    expect(snap.dimensions[1].key).toBe('grammar');
  });

  it('returns an empty-dimensions snapshot unchanged (no prior run)', async () => {
    const empty: DiagnosticSnapshot = { ...SNAPSHOT, dimensions: [], goals: [] };
    vi.spyOn(api, 'get').mockResolvedValueOnce(empty);

    const snap = await fetchLatestSnapshot();

    expect(snap.dimensions).toHaveLength(0);
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(SNAPSHOT);
    const ctrl = new AbortController();

    await fetchLatestSnapshot(ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/diagnostic/latest', { signal: ctrl.signal });
  });

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    await expect(fetchLatestSnapshot()).rejects.toMatchObject({ status: 500 });
  });
});

describe('getHistory', () => {
  const HISTORY: DiagnosticHistoryResponse = {
    snapshots: [
      { ...SNAPSHOT, capturedAt: '2026-05-01T09:00:00.000Z' },
      { ...SNAPSHOT, capturedAt: '2026-06-01T09:00:00.000Z' },
    ],
  };

  it('GETs /diagnostic/history and returns the snapshots oldest→newest', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(HISTORY);

    const res = await getHistory();

    expect(spy).toHaveBeenCalledWith('/diagnostic/history', undefined);
    expect(res.snapshots).toHaveLength(2);
    expect(res.snapshots[0].capturedAt).toBe('2026-05-01T09:00:00.000Z');
    // Each entry is the /latest snapshot shape + capturedAt.
    expect(res.snapshots[0].dimensions[1].key).toBe('grammar');
    expect(res.snapshots[0].defaultRef).toBe('L4');
  });

  it('passes through an empty history (no runs yet)', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({ snapshots: [] });

    const res = await getHistory();

    expect(res.snapshots).toHaveLength(0);
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(HISTORY);
    const ctrl = new AbortController();

    await getHistory(ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/diagnostic/history', { signal: ctrl.signal });
  });

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    await expect(getHistory()).rejects.toMatchObject({ status: 500 });
  });
});

describe('fetchTrajectory', () => {
  it('GETs /diagnostic/trajectory and returns the points', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({
      points: [
        { capturedAt: '2026-01-01T00:00:00.000Z', reading: 55, grammar: 40 },
      ],
    });

    const res = await fetchTrajectory();

    expect(spy).toHaveBeenCalledWith('/diagnostic/trajectory', undefined);
    expect(res.points).toHaveLength(1);
    expect(res.points[0].reading).toBe(55);
  });

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    await expect(fetchTrajectory()).rejects.toMatchObject({ status: 500 });
  });
});
