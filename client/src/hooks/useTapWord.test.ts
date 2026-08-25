/**
 * useTapWord — the F-209 Phase 1 progressive-paint contract.
 *
 * The hook runs the tap chain as two stages: stage 1 (lemmatize → /define,
 * fast) paints the KRDICT popover and clears `popLoading`; stage 2
 * (/enrich, slow Claude) runs in the background under `popEnriching` and
 * merges its nuance/usage/extra-examples in when it lands. These tests pin:
 *
 *   1. The KRDICT gloss + example render BEFORE enrich resolves.
 *   2. Enrichment merges into the painted popover when it lands.
 *   3. A rejected enrich leaves the KRDICT popover intact — no error, no
 *      stuck spinner.
 *   4. Closing mid-enrich aborts — a late enrichment never repaints.
 *   5. Re-tapping mid-enrich aborts the old chain — no stale merge into
 *      the newer word's popover.
 *   6. A cache-fast enrich merges seamlessly (final state carries the
 *      enrichment, `popEnriching` settles false).
 *   7. Both sources failing degrades to the fixed unavailable literal with
 *      every loading flag cleared.
 *   8. The B-011 backfill: /define fails (base paints the unavailable
 *      literal) but /enrich succeeds — the merge UPGRADES the visible
 *      primary gloss to the enrichment's nuance line.
 *
 * Services are mocked (not tapChain) so the real staged chain logic runs —
 * the same integration surface the pre-F-209 behavior was defined by.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { lemmatize } from '../services/lemmatize';
import { defineEntry } from '../services/define';
import { enrich } from '../services/enrich';
import type { DefineResult, EnrichResult } from '../types/domain';
import { GLOSS_UNAVAILABLE } from '../lib/tapChain';
import { useTapWord } from './useTapWord';

vi.mock('../services/lemmatize', () => ({ lemmatize: vi.fn() }));
vi.mock('../services/define', () => ({ defineEntry: vi.fn() }));
vi.mock('../services/enrich', () => ({ enrich: vi.fn() }));

/** A hand-rolled deferred so tests control exactly when enrich settles. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function defineFor(lemma: string): DefineResult {
  return {
    word: lemma,
    entries: [
      {
        id: lemma === '먹다' ? 42 : 43,
        headword: lemma,
        part_of_speech: 'v.',
        definition_korean: null,
        definition_english: `to ${lemma}`,
        examples: [{ korean: `${lemma} 예문`, english: `${lemma} example` }],
        overridden: false,
      },
    ],
  };
}

const ENRICH_먹다: EnrichResult = {
  result: {
    nuance: 'Neutral everyday register.',
    usageNote: '드시다 is the honorific.',
    examples: [{ korean: '같이 먹어요', english: 'Let’s eat together' }],
    dontConfuseWith: [{ lemma: '마시다', distinction: 'to drink' }],
    proficiency: 'beginner',
  },
};

/** Identity lemmatizer — every surface form is its own lemma. */
function mockIdentityLemmatize(): void {
  vi.mocked(lemmatize).mockImplementation(async (raw: string) => [
    { surface: raw, lemma: raw, pos: 'VV', start: 0, end: raw.length },
  ]);
}

beforeEach(() => {
  vi.mocked(lemmatize).mockReset();
  vi.mocked(defineEntry).mockReset();
  vi.mocked(enrich).mockReset();
});

describe('useTapWord — progressive paint (F-209)', () => {
  it('paints the KRDICT gloss + example before enrich resolves, then merges the enrichment', async () => {
    mockIdentityLemmatize();
    vi.mocked(defineEntry).mockImplementation(async (lemma) => defineFor(lemma));
    const slowEnrich = deferred<EnrichResult>();
    vi.mocked(enrich).mockReturnValue(slowEnrich.promise);

    const { result } = renderHook(() => useTapWord());
    act(() => {
      result.current.onTapWord('먹다', '먹다 좋아요.');
    });

    // Stage 1 lands: KRDICT body painted, blocking spinner gone, enrich
    // still in flight (subtle affordance only).
    await waitFor(() => {
      expect(result.current.popLoading).toBe(false);
    });
    expect(result.current.popData?.kr).toBe('먹다');
    expect(result.current.popData?.en).toBe('to 먹다');
    expect(result.current.popData?.pos).toBe('v.');
    expect(result.current.popData?.ex_kr).toBe('먹다 예문');
    expect(result.current.popEnriching).toBe(true);
    expect(result.current.popData?.notes).toBeUndefined();

    // Stage 2 lands: enrichment folds in, same popover otherwise.
    act(() => {
      slowEnrich.resolve(ENRICH_먹다);
    });
    await waitFor(() => {
      expect(result.current.popEnriching).toBe(false);
    });
    expect(result.current.popData?.en).toBe('to 먹다');
    expect(result.current.popData?.notes).toBe('드시다 is the honorific.');
    expect(result.current.popData?.contrast).toBe('마시다 — to drink');
    expect(result.current.popData?.extra).toEqual([
      { kr: '같이 먹어요', en: 'Let’s eat together' },
    ]);
  });

  it('shows the blocking stub only until /define returns', async () => {
    mockIdentityLemmatize();
    const slowDefine = deferred<DefineResult>();
    vi.mocked(defineEntry).mockReturnValue(slowDefine.promise);
    vi.mocked(enrich).mockReturnValue(deferred<EnrichResult>().promise);

    const { result } = renderHook(() => useTapWord());
    act(() => {
      result.current.onTapWord('먹다', '먹다 좋아요.');
    });

    // Pre-define: the brief blocking state with the raw-word stub.
    await waitFor(() => {
      expect(result.current.popLoading).toBe(true);
    });
    expect(result.current.popData?.kr).toBe('먹다');
    expect(result.current.popData?.en).toBe('');
    expect(result.current.popEnriching).toBe(false);

    act(() => {
      slowDefine.resolve(defineFor('먹다'));
    });
    await waitFor(() => {
      expect(result.current.popLoading).toBe(false);
    });
    expect(result.current.popEnriching).toBe(true);
  });

  it('a rejected enrich leaves the KRDICT popover intact — no error, no stuck spinner', async () => {
    mockIdentityLemmatize();
    vi.mocked(defineEntry).mockImplementation(async (lemma) => defineFor(lemma));
    const slowEnrich = deferred<EnrichResult>();
    vi.mocked(enrich).mockReturnValue(slowEnrich.promise);

    const { result } = renderHook(() => useTapWord());
    act(() => {
      result.current.onTapWord('먹다', '먹다 좋아요.');
    });
    await waitFor(() => {
      expect(result.current.popLoading).toBe(false);
    });

    act(() => {
      slowEnrich.reject(new Error('claude timeout'));
    });
    await waitFor(() => {
      expect(result.current.popEnriching).toBe(false);
    });
    // KRDICT body stands, untouched — today's degrade contract.
    expect(result.current.popData?.en).toBe('to 먹다');
    expect(result.current.popData?.ex_kr).toBe('먹다 예문');
    expect(result.current.popData?.notes).toBeUndefined();
    expect(result.current.popLoading).toBe(false);
  });

  it('upgrades the unavailable gloss when define fails but enrich succeeds (B-011 backfill)', async () => {
    mockIdentityLemmatize();
    vi.mocked(defineEntry).mockRejectedValue(new Error('krdict 503'));
    const slowEnrich = deferred<EnrichResult>();
    vi.mocked(enrich).mockReturnValue(slowEnrich.promise);

    const { result } = renderHook(() => useTapWord());
    act(() => {
      result.current.onTapWord('먹다', '먹다 좋아요.');
    });

    // Stage 1 lands with no dictionary entry: the base popover paints the
    // fixed unavailable literal while enrich is still in flight.
    await waitFor(() => {
      expect(result.current.popLoading).toBe(false);
    });
    expect(result.current.popData?.kr).toBe('먹다');
    expect(result.current.popData?.en).toBe(GLOSS_UNAVAILABLE);
    expect(result.current.popData?.pos).toBe('word');
    expect(result.current.popData?.ex_kr).toBe('');
    expect(result.current.popEnriching).toBe(true);

    // Stage 2 succeeds: with no KRDICT definition, the merge upgrades the
    // visible primary gloss to the enrichment's nuance line, and the
    // enrichment example — first in line with no dictionary examples —
    // becomes the popover's primary example.
    act(() => {
      slowEnrich.resolve(ENRICH_먹다);
    });
    await waitFor(() => {
      expect(result.current.popEnriching).toBe(false);
    });
    expect(result.current.popData?.en).toBe('Neutral everyday register.');
    expect(result.current.popData?.ex_kr).toBe('같이 먹어요');
    expect(result.current.popData?.ex_en).toBe('Let’s eat together');
    expect(result.current.popData?.notes).toBe('드시다 is the honorific.');
    expect(result.current.popData?.contrast).toBe('마시다 — to drink');
    expect(result.current.popLoading).toBe(false);
  });

  it('closing mid-enrich aborts — a late enrichment never repaints', async () => {
    mockIdentityLemmatize();
    vi.mocked(defineEntry).mockImplementation(async (lemma) => defineFor(lemma));
    const slowEnrich = deferred<EnrichResult>();
    vi.mocked(enrich).mockReturnValue(slowEnrich.promise);

    const { result } = renderHook(() => useTapWord());
    act(() => {
      result.current.onTapWord('먹다', '먹다 좋아요.');
    });
    await waitFor(() => {
      expect(result.current.popEnriching).toBe(true);
    });

    act(() => {
      result.current.onClose();
    });
    expect(result.current.popData).toBeNull();
    expect(result.current.popEnriching).toBe(false);

    // The late enrichment resolves into an aborted chain — nothing paints.
    act(() => {
      slowEnrich.resolve(ENRICH_먹다);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.popData).toBeNull();
    expect(result.current.popEnriching).toBe(false);
  });

  it('re-tapping mid-enrich aborts the old chain — no stale merge into the newer word', async () => {
    mockIdentityLemmatize();
    vi.mocked(defineEntry).mockImplementation(async (lemma) => defineFor(lemma));
    const enrichA = deferred<EnrichResult>();
    const enrichB = deferred<EnrichResult>();
    vi.mocked(enrich).mockImplementation((req) =>
      req.lemma === '먹다' ? enrichA.promise : enrichB.promise,
    );

    const { result } = renderHook(() => useTapWord());
    act(() => {
      result.current.onTapWord('먹다', '먹다 좋아요.');
    });
    await waitFor(() => {
      expect(result.current.popEnriching).toBe(true);
    });

    // Newer tap on a different word while A's enrich is still in flight.
    act(() => {
      result.current.onTapWord('마시다', '물을 마시다.');
    });
    await waitFor(() => {
      expect(result.current.popData?.kr).toBe('마시다');
      expect(result.current.popLoading).toBe(false);
    });

    // A's enrichment lands late — it must NOT merge into B's popover.
    act(() => {
      enrichA.resolve(ENRICH_먹다);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.popData?.kr).toBe('마시다');
    expect(result.current.popData?.notes).toBeUndefined();
    expect(result.current.popEnriching).toBe(true); // B's enrich still going

    act(() => {
      enrichB.resolve(ENRICH_먹다);
    });
    await waitFor(() => {
      expect(result.current.popEnriching).toBe(false);
    });
    expect(result.current.popData?.kr).toBe('마시다');
    expect(result.current.popData?.notes).toBe('드시다 is the honorific.');
  });

  it('a cache-fast enrich merges seamlessly — final popover enriched, no lingering flags', async () => {
    mockIdentityLemmatize();
    vi.mocked(defineEntry).mockImplementation(async (lemma) => defineFor(lemma));
    vi.mocked(enrich).mockResolvedValue(ENRICH_먹다);

    const { result } = renderHook(() => useTapWord());
    act(() => {
      result.current.onTapWord('먹다', '먹다 좋아요.');
    });

    await waitFor(() => {
      expect(result.current.popLoading).toBe(false);
      expect(result.current.popEnriching).toBe(false);
    });
    expect(result.current.popData?.en).toBe('to 먹다');
    expect(result.current.popData?.notes).toBe('드시다 is the honorific.');
    expect(result.current.popData?.extra).toEqual([
      { kr: '같이 먹어요', en: 'Let’s eat together' },
    ]);
  });

  it('degrades to the fixed unavailable literal when both sources fail, flags cleared', async () => {
    mockIdentityLemmatize();
    vi.mocked(defineEntry).mockRejectedValue(new Error('krdict 503'));
    vi.mocked(enrich).mockRejectedValue(new Error('claude 500'));

    const { result } = renderHook(() => useTapWord());
    act(() => {
      result.current.onTapWord('먹다', '먹다 좋아요.');
    });

    await waitFor(() => {
      expect(result.current.popLoading).toBe(false);
      expect(result.current.popEnriching).toBe(false);
    });
    expect(result.current.popData?.en).toBe(GLOSS_UNAVAILABLE);
  });

  it('recomputes mined on both the base paint and the enrichment merge', async () => {
    mockIdentityLemmatize();
    vi.mocked(defineEntry).mockImplementation(async (lemma) => defineFor(lemma));
    const slowEnrich = deferred<EnrichResult>();
    vi.mocked(enrich).mockReturnValue(slowEnrich.promise);

    const minedSet = new Set<string>();
    const { result } = renderHook(() =>
      useTapWord({ isMined: (w) => minedSet.has(w) }),
    );
    act(() => {
      result.current.onTapWord('먹다', '먹다 좋아요.');
    });
    await waitFor(() => {
      expect(result.current.popLoading).toBe(false);
    });
    expect(result.current.popData?.mined).toBe(false);

    // Banked while enrich was in flight — the merge re-reads the closure.
    minedSet.add('먹다');
    act(() => {
      slowEnrich.resolve(ENRICH_먹다);
    });
    await waitFor(() => {
      expect(result.current.popEnriching).toBe(false);
    });
    expect(result.current.popData?.mined).toBe(true);
  });
});
