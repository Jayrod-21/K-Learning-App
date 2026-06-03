/**
 * vocab service — corpus + cards + lists CRUD wiring.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addListEntries,
  createList,
  deleteList,
  getDueCards,
  getEntry,
  getListDetail,
  initCards,
  listLists,
  mineWord,
  patchList,
  removeListEntry,
  searchEntries,
  searchEntriesPage,
  submitReview,
} from './vocab';
import { api, ApiError } from './api';
import type { ReviewSubmission } from '../types/domain';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('searchEntries', () => {
  it('GETs /vocab/entries with non-undefined params', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({
      entries: [],
      limit: 20,
      offset: 0,
    });

    await searchEntries({ q: '학교', corpus: 'vocab_2000_beginner' });

    expect(spy).toHaveBeenCalledWith('/vocab/entries', {
      params: { q: '학교', corpus: 'vocab_2000_beginner' },
    });
  });

  it('passes no params when opts is empty', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({
      entries: [{ id: 1, corpus: 'x', korean: 'a', english: 'b', proficiency: 'L3', theme: null }],
      limit: 20,
      offset: 0,
    });

    const entries = await searchEntries();

    expect(spy).toHaveBeenCalledWith('/vocab/entries', { params: {} });
    expect(entries).toHaveLength(1);
  });
});

describe('getEntry', () => {
  it('GETs /vocab/entries/:id', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ id: 42 });

    await getEntry(42);

    expect(spy).toHaveBeenCalledWith('/vocab/entries/42', undefined);
  });
});

describe('getDueCards', () => {
  it('passes limit when provided', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ cards: [] });

    await getDueCards(50);

    expect(spy).toHaveBeenCalledWith('/vocab/cards/due', { params: { limit: 50 } });
  });

  it('omits limit when undefined', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ cards: [] });

    await getDueCards();

    expect(spy).toHaveBeenCalledWith('/vocab/cards/due', { params: undefined });
  });

  it('maps the snake-case grammar JOIN columns onto camelCase fields (FU-NF-42)', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({
      cards: [
        {
          id: 7,
          face: 'production',
          due_at: '2026-05-30T00:00:00Z',
          stability: '3',
          difficulty: '5',
          fsrs_state: 'review',
          version: 2,
          vocab_entry_id: null,
          grammar_entry_id: 11,
          source_sentence_id: null,
          topik_item_id: null,
          grammar_pattern_display: '-더라도',
          grammar_summary_en: 'even if / even though',
          grammar_pattern_key: 'KGIU-INT-007',
        },
      ],
    });

    const [card] = await getDueCards();

    expect(card?.grammarPatternDisplay).toBe('-더라도');
    expect(card?.grammarSummaryEn).toBe('even if / even though');
    expect(card?.grammarPatternKey).toBe('KGIU-INT-007');
    // The snake-case wire keys must not leak through onto the domain shape.
    expect(card).not.toHaveProperty('grammar_pattern_display');
    expect(card).not.toHaveProperty('grammar_pattern_key');
  });

  it('leaves grammar fields absent for a vocab card (NULL JOIN columns)', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({
      cards: [
        {
          id: 1,
          face: 'recognition',
          due_at: '2026-05-30T00:00:00Z',
          stability: '0',
          difficulty: '5',
          fsrs_state: 'new',
          version: 1,
          vocab_entry_id: 9,
          grammar_entry_id: null,
          source_sentence_id: null,
          topik_item_id: null,
          grammar_pattern_display: null,
          grammar_summary_en: null,
          grammar_pattern_key: null,
        },
      ],
    });

    const [card] = await getDueCards();

    expect(card?.grammarPatternDisplay).toBeUndefined();
    expect(card?.grammarSummaryEn).toBeUndefined();
    expect(card?.grammarPatternKey).toBeUndefined();
  });
});

describe('submitReview', () => {
  it('POSTs the review and returns the envelope', async () => {
    const body: ReviewSubmission = {
      rating: 'good',
      state_before: 'new',
      stability_before: 0,
      difficulty_before: 5,
      elapsed_days_before: 0,
      state_after: 'learning',
      stability_after: 1.4,
      difficulty_after: 5,
      scheduled_days_after: 1,
      expected_version: 1,
    };
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ version: 2, due_at: '2026-05-30T00:00:00Z' });

    const got = await submitReview(99, body);

    expect(spy).toHaveBeenCalledWith('/vocab/cards/99/reviews', body);
    expect(got.version).toBe(2);
  });

  it('surfaces 409 stale version', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('stale', { status: 409, code: 'conflict' }),
    );

    await expect(
      submitReview(1, {
        rating: 'again',
        state_before: 'new',
        stability_before: 0,
        difficulty_before: 5,
        elapsed_days_before: 0,
        state_after: 'learning',
        stability_after: 1,
        difficulty_after: 5,
        scheduled_days_after: 0,
        expected_version: 99,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('initCards', () => {
  it('POSTs /vocab/cards/init with the body', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({ inserted: 7 });

    const out = await initCards({
      corpus: 'vocab_2000_beginner',
      proficiency: 'L3',
    });

    expect(spy).toHaveBeenCalledWith(
      '/vocab/cards/init',
      { corpus: 'vocab_2000_beginner', proficiency: 'L3' },
      undefined,
    );
    expect(out.inserted).toBe(7);
  });
});

describe('mineWord', () => {
  it('POSTs /vocab/mine with the input + signal and returns the envelope', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({
      entryId: 77,
      card: { id: 12, version: 1 },
    });
    const ctrl = new AbortController();

    const out = await mineWord(
      { lemma: '사과', english: 'apple', pos: 'n.', krdictEntryId: 4242 },
      ctrl.signal,
    );

    expect(spy).toHaveBeenCalledWith(
      '/vocab/mine',
      { lemma: '사과', english: 'apple', pos: 'n.', krdictEntryId: 4242 },
      { signal: ctrl.signal },
    );
    expect(out.entryId).toBe(77);
    expect(out.card).toEqual({ id: 12, version: 1 });
  });

  it('strips undefined optionals so the server never sees them (lemma-only mine)', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({
      entryId: 1,
      card: { id: 2, version: 1 },
    });

    await mineWord({ lemma: '버스' });

    expect(spy).toHaveBeenCalledWith('/vocab/mine', { lemma: '버스' }, undefined);
  });

  it('surfaces a canceled abort as a discriminable ApiError', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('request canceled', { status: 0, code: 'canceled' }),
    );

    await expect(mineWord({ lemma: '학교' })).rejects.toMatchObject({
      code: 'canceled',
    });
  });
});

describe('lists CRUD', () => {
  it('listLists unwraps `lists` (real name_kr/name_en/version shape)', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({
      lists: [
        {
          id: 1,
          name_kr: '병원 어휘',
          name_en: 'Hospital words',
          kind: 'vocab',
          version: 1,
          entry_count: 0,
          created_at: 'x',
          updated_at: 'y',
        },
      ],
      limit: 50,
      offset: 0,
    });

    const lists = await listLists();
    expect(lists).toHaveLength(1);
    expect(lists[0]?.name_kr).toBe('병원 어휘');
  });

  it('createList POSTs /vocab/lists with name_kr and unwraps the envelope', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({
      list: {
        id: 1,
        name_kr: 'New',
        name_en: null,
        kind: 'vocab',
        version: 1,
        entry_count: 0,
        created_at: 'x',
        updated_at: 'y',
      },
      appended: 0,
    });

    const res = await createList({ name_kr: 'New', kind: 'vocab' });

    expect(spy).toHaveBeenCalledWith('/vocab/lists', {
      name_kr: 'New',
      kind: 'vocab',
    });
    expect(res.list.id).toBe(1);
    expect(res.appended).toBe(0);
  });

  it('createList strips undefined optionals (no name_en / seed)', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({
      list: { id: 2 },
      appended: 0,
    });

    await createList({ name_kr: '단어장', kind: 'vocab', name_en: undefined });

    expect(spy).toHaveBeenCalledWith('/vocab/lists', {
      name_kr: '단어장',
      kind: 'vocab',
    });
  });

  it('getListDetail GETs /vocab/lists/:id (detail + entries envelope)', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({
      list: { id: 7 },
      entries: [],
      entry_limit: 100,
      entry_offset: 0,
    });

    const res = await getListDetail(7);

    expect(spy).toHaveBeenCalledWith('/vocab/lists/7', undefined);
    expect(res.entry_limit).toBe(100);
  });

  it('patchList PATCHes /vocab/lists/:id and unwraps the list', async () => {
    const spy = vi.spyOn(api, 'patch').mockResolvedValueOnce({
      list: { id: 7, name_kr: 'renamed' },
    });

    const res = await patchList(7, { name_kr: 'renamed' });

    expect(spy).toHaveBeenCalledWith('/vocab/lists/7', { name_kr: 'renamed' });
    expect(res.list.name_kr).toBe('renamed');
  });

  it('deleteList DELETEs /vocab/lists/:id', async () => {
    const spy = vi.spyOn(api, 'delete').mockResolvedValueOnce(undefined);

    await deleteList(7);

    expect(spy).toHaveBeenCalledWith('/vocab/lists/7');
  });

  it('addListEntries posts entry_ids and unwraps the appended rows', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({
      entries: [
        { entry_id: 1, position: 0, added_at: 'x' },
        { entry_id: 2, position: 1, added_at: 'x' },
      ],
    });

    const res = await addListEntries(7, [1, 2, 3]);

    expect(spy).toHaveBeenCalledWith('/vocab/lists/7/entries', {
      entry_ids: [1, 2, 3],
    });
    expect(res.entries).toHaveLength(2);
  });

  it('addListEntries surfaces a 409 duplicate as an ApiError', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('entries already in list: 1', {
        status: 409,
        code: 'conflict',
      }),
    );

    await expect(addListEntries(7, [1])).rejects.toMatchObject({ status: 409 });
  });

  it('removeListEntry DELETEs the nested route', async () => {
    const spy = vi.spyOn(api, 'delete').mockResolvedValueOnce(undefined);

    await removeListEntry(7, 99);

    expect(spy).toHaveBeenCalledWith('/vocab/lists/7/entries/99');
  });
});

describe('searchEntriesPage', () => {
  it('returns the full envelope including total', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({
      entries: [
        { id: 1, corpus: 'x', korean: '학교', english: 'school', proficiency: 'L3', theme: null },
      ],
      total: 3131,
      limit: 20,
      offset: 0,
    });

    const page = await searchEntriesPage({ q: '학교', limit: 20, offset: 0 });

    expect(spy).toHaveBeenCalledWith('/vocab/entries', {
      params: { q: '학교', limit: 20, offset: 0 },
    });
    expect(page.total).toBe(3131);
    expect(page.entries).toHaveLength(1);
  });
});

describe('error propagation', () => {
  it('searchEntries surfaces network errors', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('network unreachable', { status: 0, code: 'network' }),
    );
    await expect(searchEntries()).rejects.toMatchObject({ code: 'network' });
  });
});
