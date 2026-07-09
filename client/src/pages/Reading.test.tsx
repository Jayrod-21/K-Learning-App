/**
 * Reading — the `/learn/reading` U3b digitized chapter reader. Covers:
 *   1. Book-picker empty state — no ready `literature` uploads.
 *   2. Chapter-list render — one ready literature book, several chapters
 *      (including a null-titled one, which must fall back to
 *      "Chapter {n}").
 *   3. The chapter reader (level 3) — the net-new tap-to-define surface:
 *      passages render as ordered, newline-preserving tappable text, a tap
 *      runs the lemmatize→define→enrich chain and opens the popover, an
 *      empty-passages chapter shows its own empty state, and closing the
 *      popover aborts an in-flight "Add to bank" request (regression test
 *      for the missing-`AbortSignal` blocker fixed in `Reading.tsx`'s
 *      `ChapterReader.handleAdd`).
 *   4. Fetch-error states for the book and chapter pickers (`ErrorCard` +
 *      working retry).
 *
 * `services/uploads` and `services/reading` are fully mocked (mirrors
 * `UploadViewer.test.tsx`'s approach) — no network, no real book content.
 * The tap chain's own services (`lemmatize`/`define`/`enrich`) and
 * `services/vocab.mineWord` are mocked the same way `Ttmik.test.tsx` and
 * `Images.test.tsx` mock them, since `ChapterReader` goes through the exact
 * same `lib/tapChain` + `useTapWord` stack those pages use.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/ToastProvider';
import { ApiError } from '../services/api';
import type { BookUpload } from '../types/domain';

const readingSvc = vi.hoisted(() => ({
  listChapters: vi.fn(),
  getChapter: vi.fn(),
}));
const uploadsSvc = vi.hoisted(() => ({
  listUploads: vi.fn(),
}));
const tapSvc = vi.hoisted(() => ({
  lemmatize: vi.fn(),
  defineEntry: vi.fn(),
  enrich: vi.fn(),
}));
const vocabSvc = vi.hoisted(() => ({
  mineWord: vi.fn(),
}));

vi.mock('../services/reading', () => readingSvc);
vi.mock('../services/uploads', () => uploadsSvc);
vi.mock('../services/lemmatize', () => ({ lemmatize: tapSvc.lemmatize }));
vi.mock('../services/define', () => ({ defineEntry: tapSvc.defineEntry }));
vi.mock('../services/enrich', () => ({ enrich: tapSvc.enrich }));
vi.mock('../services/vocab', () => vocabSvc);

// Imported AFTER the mocks so the module under test binds the mocked services.
import Reading from './Reading';

beforeEach(() => {
  readingSvc.listChapters.mockReset();
  readingSvc.getChapter.mockReset();
  uploadsSvc.listUploads.mockReset();
  tapSvc.lemmatize.mockReset();
  tapSvc.defineEntry.mockReset();
  tapSvc.enrich.mockReset();
  vocabSvc.mineWord.mockReset();
});

const LITERATURE_READY: BookUpload = {
  id: '41',
  title: '소나기',
  type: 'literature',
  status: 'ready',
  pageCount: 12,
  byteSize: 900_000,
  createdAt: '2026-07-01T00:00:00Z',
};

const GRAMMAR_READY: BookUpload = {
  id: '42',
  title: '한국어 문법 사전',
  type: 'grammar',
  status: 'ready',
  pageCount: 200,
  byteSize: 4_000_000,
  createdAt: '2026-07-01T00:00:00Z',
};

const LITERATURE_PROCESSING: BookUpload = {
  id: '43',
  title: '아직 처리 중',
  type: 'literature',
  status: 'processing',
  byteSize: 500_000,
  createdAt: '2026-07-02T00:00:00Z',
};

function renderReading(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/learn/reading']}>
      <ToastProvider>
        <Reading />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('Reading — book-picker empty state', () => {
  it('shows the upload-a-book prompt when no ready literature uploads exist', async () => {
    // A grammar upload and a still-processing literature upload are both
    // present, but neither is a READY literature book — the picker must
    // still read as empty (the filter is `type === 'literature' && status
    // === 'ready'`, not just "any uploads exist").
    uploadsSvc.listUploads.mockResolvedValue([
      GRAMMAR_READY,
      LITERATURE_PROCESSING,
    ]);

    renderReading();

    expect(
      await screen.findByText(/upload a literature book to start reading/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /upload a book/i }),
    ).toBeInTheDocument();
    // Neither the non-literature nor the not-yet-ready upload should render
    // as an openable row.
    expect(screen.queryByText(GRAMMAR_READY.title)).not.toBeInTheDocument();
    expect(
      screen.queryByText(LITERATURE_PROCESSING.title),
    ).not.toBeInTheDocument();
  });

  it('shows the same empty state when the user has no uploads at all', async () => {
    uploadsSvc.listUploads.mockResolvedValue([]);

    renderReading();

    expect(
      await screen.findByText(/upload a literature book to start reading/i),
    ).toBeInTheDocument();
  });
});

describe('Reading — chapter list render', () => {
  it('opens a book and lists its chapters, falling back to "Chapter N" for a null title', async () => {
    uploadsSvc.listUploads.mockResolvedValue([LITERATURE_READY]);
    readingSvc.listChapters.mockResolvedValue([
      { id: 1, chapterNumber: 1, title: '소나기', startPage: 1, endPage: 8 },
      { id: 2, chapterNumber: 2, title: null, startPage: 9, endPage: null },
    ]);

    const user = userEvent.setup();
    renderReading();

    const bookRow = await screen.findByRole('button', {
      name: new RegExp(LITERATURE_READY.title),
    });
    await user.click(bookRow);

    await waitFor(() => {
      expect(readingSvc.listChapters).toHaveBeenCalledWith(
        LITERATURE_READY.id,
        expect.anything(),
      );
    });

    expect(await screen.findByText('소나기', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Chapter 2')).toBeInTheDocument();
    // The book's own title also renders as the section heading above the
    // chapter list — scope the chapter-row assertion to the list itself so
    // this doesn't collide with that heading (both text "소나기").
    expect(
      screen.getByRole('button', { name: /open 소나기/i }),
    ).toBeInTheDocument();
  });

  it('shows a "no chapters yet" message for a book with none', async () => {
    uploadsSvc.listUploads.mockResolvedValue([LITERATURE_READY]);
    readingSvc.listChapters.mockResolvedValue([]);

    const user = userEvent.setup();
    renderReading();

    const bookRow = await screen.findByRole('button', {
      name: new RegExp(LITERATURE_READY.title),
    });
    await user.click(bookRow);

    expect(
      await screen.findByText(/no chapters yet for this book/i),
    ).toBeInTheDocument();
  });
});

// A chapter title distinct from the book title (`LITERATURE_READY.title` is
// also '소나기') so `getByRole('button', { name: /open .../ })` can't collide
// between the book row and the chapter row.
const CHAPTER_ONE = {
  id: 5,
  chapterNumber: 1,
  title: '해질녘',
  startPage: 1,
  endPage: 2,
};

/** Drill from the book picker down into a chapter's reader body. */
async function openChapterOne(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  const bookRow = await screen.findByRole('button', {
    name: new RegExp(LITERATURE_READY.title),
  });
  await user.click(bookRow);
  const chapterRow = await screen.findByRole('button', {
    name: /open 해질녘/i,
  });
  await user.click(chapterRow);
}

describe('Reading — chapter reader (tap-to-define)', () => {
  it('renders a chapter\'s passages as ordered, tappable text with newlines preserved', async () => {
    uploadsSvc.listUploads.mockResolvedValue([LITERATURE_READY]);
    readingSvc.listChapters.mockResolvedValue([CHAPTER_ONE]);
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...CHAPTER_ONE, sourceUploadId: 41 },
      passages: [
        { id: 2, passageNumber: 2, body: '숨이 막혔다.', pageNumber: 2 },
        { id: 1, passageNumber: 1, body: '소년은\n걸음을 멈췄다.', pageNumber: 1 },
      ],
    });

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    // Passage 1 renders before passage 2 despite arriving out of order on
    // the wire (defensive client-side sort by passageNumber).
    const bodies = document.querySelectorAll('.km-reference__row-kr');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.textContent).toContain('소년은');
    expect(bodies[1]?.textContent).toContain('숨이');

    // Every Korean word tokenises to a tappable Tapword.
    expect(await screen.findByRole('button', { name: '소년은' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '걸음을' })).toBeInTheDocument();

    // The internal '\n' in passage 1's body survived as a real line break
    // (a <br/> between "소년은" and "걸음을 멈췄다."), not a collapsed run-on
    // line — the regression `PassageBody`'s header comment documents.
    expect(bodies[0]?.querySelector('br')).not.toBeNull();
  });

  it('shows a "no passages yet" message for a chapter with none', async () => {
    uploadsSvc.listUploads.mockResolvedValue([LITERATURE_READY]);
    readingSvc.listChapters.mockResolvedValue([CHAPTER_ONE]);
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...CHAPTER_ONE, sourceUploadId: 41 },
      passages: [],
    });

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    expect(
      await screen.findByText(/no passages yet for this chapter/i),
    ).toBeInTheDocument();
  });

  it('tapping a word runs the lemmatize→define→enrich chain and opens the popover', async () => {
    uploadsSvc.listUploads.mockResolvedValue([LITERATURE_READY]);
    readingSvc.listChapters.mockResolvedValue([CHAPTER_ONE]);
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...CHAPTER_ONE, sourceUploadId: 41 },
      passages: [{ id: 1, passageNumber: 1, body: '소년은 걸었다.', pageNumber: 1 }],
    });
    tapSvc.lemmatize.mockResolvedValue([
      { form: '소년은', lemma: '소년', tag: 'NNG', start: 0, length: 3 },
    ]);
    tapSvc.defineEntry.mockResolvedValue({
      word: '소년',
      entries: [
        {
          id: 9,
          headword: '소년',
          part_of_speech: 'n.',
          definition_korean: null,
          definition_english: 'boy',
          examples: [],
        },
      ],
    });
    tapSvc.enrich.mockResolvedValue({
      result: {
        nuance: null,
        usageNote: null,
        examples: [],
        dontConfuseWith: [],
        proficiency: 'L1',
      },
    });

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    await user.click(await screen.findByRole('button', { name: '소년은' }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('boy')).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: /Add to vocab/i }),
    ).toBeInTheDocument();
  });

  it('closing the popover aborts an in-flight "Add to bank" request (BLOCKER regression)', async () => {
    uploadsSvc.listUploads.mockResolvedValue([LITERATURE_READY]);
    readingSvc.listChapters.mockResolvedValue([CHAPTER_ONE]);
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...CHAPTER_ONE, sourceUploadId: 41 },
      passages: [{ id: 1, passageNumber: 1, body: '소년은 걸었다.', pageNumber: 1 }],
    });
    tapSvc.lemmatize.mockResolvedValue([
      { form: '소년은', lemma: '소년', tag: 'NNG', start: 0, length: 3 },
    ]);
    tapSvc.defineEntry.mockResolvedValue({
      word: '소년',
      entries: [
        {
          id: 9,
          headword: '소년',
          part_of_speech: 'n.',
          definition_korean: null,
          definition_english: 'boy',
          examples: [],
        },
      ],
    });
    tapSvc.enrich.mockResolvedValue({
      result: {
        nuance: null,
        usageNote: null,
        examples: [],
        dontConfuseWith: [],
        proficiency: 'L1',
      },
    });
    // Never resolves — lets the test observe the signal mid-flight rather
    // than racing a real resolution.
    let mineSignal: AbortSignal | undefined;
    vocabSvc.mineWord.mockImplementation(
      (_input: unknown, signal?: AbortSignal) => {
        mineSignal = signal;
        return new Promise(() => {
          /* never settles */
        });
      },
    );

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);
    await user.click(await screen.findByRole('button', { name: '소년은' }));

    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('boy');
    await user.click(
      within(dialog).getByRole('button', { name: /Add to vocab/i }),
    );

    // The fix: mineWord is called WITH an AbortSignal (the pre-fix call site
    // passed only the payload, so this specific assertion — an exact
    // 2-argument match — would fail against the un-fixed code).
    expect(vocabSvc.mineWord).toHaveBeenCalledWith(
      expect.objectContaining({ lemma: '소년' }),
      expect.any(AbortSignal),
    );
    expect(mineSignal?.aborted).toBe(false);

    // Closing the popover must abort that same signal — the un-fixed code
    // had nothing wired to abort here at all.
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(mineSignal?.aborted).toBe(true);
  });
});

describe('Reading — fetch error states', () => {
  it('shows an error card with a working retry when the book list fetch fails', async () => {
    uploadsSvc.listUploads
      .mockRejectedValueOnce(
        new ApiError('boom', { status: 500, code: 'server_error' }),
      )
      .mockResolvedValueOnce([LITERATURE_READY]);

    const user = userEvent.setup();
    renderReading();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load your books/i);
    // Fixed copy only — the server's message text must not leak through.
    expect(alert).not.toHaveTextContent(/boom/);

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(
      await screen.findByRole('button', {
        name: new RegExp(LITERATURE_READY.title),
      }),
    ).toBeInTheDocument();
  });

  it('shows an error card with a working retry when the chapter list fetch fails', async () => {
    uploadsSvc.listUploads.mockResolvedValue([LITERATURE_READY]);
    readingSvc.listChapters
      .mockRejectedValueOnce(
        new ApiError('boom', { status: 500, code: 'server_error' }),
      )
      .mockResolvedValueOnce([CHAPTER_ONE]);

    const user = userEvent.setup();
    renderReading();

    const bookRow = await screen.findByRole('button', {
      name: new RegExp(LITERATURE_READY.title),
    });
    await user.click(bookRow);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load the chapters/i);
    expect(alert).not.toHaveTextContent(/boom/);

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(
      await screen.findByRole('button', { name: /open 해질녘/i }),
    ).toBeInTheDocument();
  });
});
