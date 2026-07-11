/**
 * Reading — `/learn/reading`, the Phase 3C-2 Learn → Reading surface. Covers:
 *   1. Books tab (F-067) — typed sections (Literature / Dialogue /
 *      Documents), ready-only filtering, empty state, fetch error + retry.
 *   2. Chapter picker — book heading + chapter list (null-titled chapters
 *      fall back to "Chapter {n}"), F-024 BackButton, F-069 Resume button
 *      (present only when the saved position points at a LISTED chapter),
 *      fetch error + retry.
 *   3. Chapter reader — ordered, newline-preserving tappable passages; the
 *      lemmatize→define→enrich popover; the abortable "Add to bank"
 *      regression; the F-069 position auto-save (and its failure toast);
 *      the F-070 translate sheet (honest stub — no fabricated translation).
 *   4. "View original scan" deep-link (U3c) — `?page=` threading.
 *   5. Stories tab (F-068) — generator wiring (level + topic →
 *      POST /reading/generate), library list + open, empty state, error
 *      alert with no server-prose leak.
 *
 * `services/uploads` and `services/reading` are fully mocked (mirrors
 * `UploadViewer.test.tsx`'s approach) — no network, no real book content.
 * The tap chain's own services (`lemmatize`/`define`/`enrich`) and
 * `services/vocab.mineWord` are mocked the same way `Ttmik.test.tsx` and
 * `Images.test.tsx` mock them, since both readers go through the exact same
 * `lib/tapChain` + `useTapWord` stack those pages use.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useParams,
} from 'react-router-dom';
import { ToastProvider } from '../components/ToastProvider';
import { ApiError } from '../services/api';
import type {
  GeneratedStory,
  GeneratedStorySummary,
  ReadingPosition,
} from '../services/reading';
import type { BookUpload } from '../types/domain';

const readingSvc = vi.hoisted(() => ({
  listChapters: vi.fn(),
  getChapter: vi.fn(),
  getReadingPosition: vi.fn(),
  saveReadingPosition: vi.fn(),
  generateStory: vi.fn(),
  listGeneratedStories: vi.fn(),
  getGeneratedStory: vi.fn(),
  translatePassage: vi.fn(),
  // Module CONSTANT (not a spy): Reading.tsx maps over it to build the
  // level radiogroup, so the mock must export the real display order.
  GENERATED_STORY_LEVELS: ['L1', 'L2', 'L3', 'L4', 'L5+'] as const,
}));
const uploadsSvc = vi.hoisted(() => ({
  listUploads: vi.fn(),
  getUpload: vi.fn(),
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

const LITERATURE_READY: BookUpload = {
  id: '41',
  title: '소나기',
  type: 'literature',
  status: 'ready',
  pageCount: 12,
  byteSize: 900_000,
  createdAt: '2026-07-01T00:00:00Z',
};

const DIALOGUE_READY: BookUpload = {
  id: '44',
  title: '대화 연습',
  type: 'dialogue',
  status: 'ready',
  pageCount: 30,
  byteSize: 1_200_000,
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

const SAVED_POSITION: ReadingPosition = {
  sourceUploadId: 41,
  chapterId: 5,
  passageNumber: null,
  pageNumber: 1,
  updatedAt: '2026-07-08T12:00:00Z',
};

const STORY_SUMMARY: GeneratedStorySummary = {
  id: 7,
  title: '바닷가 마을',
  level: 'L3',
  prompt: null,
  createdAt: '2026-07-08T12:00:00Z',
};

const STORY_FULL: GeneratedStory = {
  ...STORY_SUMMARY,
  bodyKo: '소년은 바닷가를 걸었다.\n\n바람이 불었다.',
};

beforeEach(() => {
  readingSvc.listChapters.mockReset();
  readingSvc.getChapter.mockReset();
  readingSvc.getReadingPosition.mockReset();
  readingSvc.saveReadingPosition.mockReset();
  readingSvc.generateStory.mockReset();
  readingSvc.listGeneratedStories.mockReset();
  readingSvc.getGeneratedStory.mockReset();
  readingSvc.translatePassage.mockReset();
  uploadsSvc.listUploads.mockReset();
  uploadsSvc.getUpload.mockReset();
  tapSvc.lemmatize.mockReset();
  tapSvc.defineEntry.mockReset();
  tapSvc.enrich.mockReset();
  vocabSvc.mineWord.mockReset();

  // Safe defaults — individual tests override what they exercise. Without
  // these, an unmocked service resolves `undefined` and the component's
  // Promise chains would crash on a shape it can never receive in prod.
  uploadsSvc.listUploads.mockResolvedValue([LITERATURE_READY]);
  uploadsSvc.getUpload.mockResolvedValue(LITERATURE_READY);
  readingSvc.getReadingPosition.mockResolvedValue(null);
  readingSvc.saveReadingPosition.mockResolvedValue(SAVED_POSITION);
  readingSvc.listGeneratedStories.mockResolvedValue([]);
});

function renderReading(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/learn/reading']}>
      <ToastProvider>
        <Reading />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** Open the (only) ready literature book from the Books tab. */
async function openBook(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  const bookRow = await screen.findByRole('button', {
    name: new RegExp(`Open ${LITERATURE_READY.title}`),
  });
  await user.click(bookRow);
}

/** Drill from the Books tab down into chapter one's reader body. */
async function openChapterOne(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await openBook(user);
  const chapterRow = await screen.findByRole('button', {
    name: /open 해질녘/i,
  });
  await user.click(chapterRow);
}

/** Standard happy-path tap-chain mocks for '소년은' → '소년' → "boy". */
function mockTapChain(): void {
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
}

describe('Reading — Books tab, typed sections (F-067)', () => {
  it('shows the upload prompt when no READY uploads exist at all', async () => {
    // A still-processing literature upload is present, but nothing is ready
    // — the shelf must read as empty (the filter is `status === 'ready'`,
    // not just "any uploads exist").
    uploadsSvc.listUploads.mockResolvedValue([LITERATURE_PROCESSING]);

    renderReading();

    expect(
      await screen.findByText(/upload a book to start reading/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /upload a book/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(LITERATURE_PROCESSING.title),
    ).not.toBeInTheDocument();
  });

  it('groups ready uploads into Literature / Dialogue / Documents sections', async () => {
    uploadsSvc.listUploads.mockResolvedValue([
      LITERATURE_READY,
      DIALOGUE_READY,
      GRAMMAR_READY,
      LITERATURE_PROCESSING,
    ]);

    renderReading();

    // Each typed section renders with its own heading…
    const literature = await screen.findByRole('region', {
      name: 'Literature',
    });
    const dialogue = screen.getByRole('region', { name: 'Dialogue' });
    const documents = screen.getByRole('region', { name: 'Documents' });

    // …and each book sits in ITS type's section (not merely somewhere).
    expect(
      within(literature).getByRole('button', { name: /Open 소나기/ }),
    ).toBeInTheDocument();
    expect(
      within(dialogue).getByRole('button', { name: /Open 대화 연습/ }),
    ).toBeInTheDocument();
    expect(
      within(documents).getByRole('button', {
        name: /Open 한국어 문법 사전/,
      }),
    ).toBeInTheDocument();

    // The processing upload is not openable anywhere.
    expect(
      screen.queryByText(LITERATURE_PROCESSING.title),
    ).not.toBeInTheDocument();
  });

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
        name: new RegExp(`Open ${LITERATURE_READY.title}`),
      }),
    ).toBeInTheDocument();
  });
});

describe('Reading — chapter picker', () => {
  it('opens a book and lists its chapters, falling back to "Chapter N" for a null title', async () => {
    readingSvc.listChapters.mockResolvedValue([
      { id: 1, chapterNumber: 1, title: '소나기', startPage: 1, endPage: 8 },
      { id: 2, chapterNumber: 2, title: null, startPage: 9, endPage: null },
    ]);

    const user = userEvent.setup();
    renderReading();
    await openBook(user);

    await waitFor(() => {
      expect(readingSvc.listChapters).toHaveBeenCalledWith(
        LITERATURE_READY.id,
        expect.anything(),
      );
    });
    // The picker fetches the book (title heading) and the F-069 position
    // alongside the chapter list.
    expect(uploadsSvc.getUpload).toHaveBeenCalledWith(
      LITERATURE_READY.id,
      expect.anything(),
    );
    expect(readingSvc.getReadingPosition).toHaveBeenCalledWith(
      LITERATURE_READY.id,
      expect.anything(),
    );

    expect(
      await screen.findByText('소나기', { selector: 'span' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Chapter 2')).toBeInTheDocument();
    // The book's own title also renders as the section heading above the
    // chapter list — scope the chapter-row assertion to the row button so
    // this doesn't collide with that heading (both text "소나기").
    expect(
      screen.getByRole('button', { name: /open 소나기/i }),
    ).toBeInTheDocument();

    // No saved position → no Resume button (never a fabricated resume).
    expect(
      screen.queryByRole('button', { name: /resume/i }),
    ).not.toBeInTheDocument();

    // F-024: the nested view carries a BackButton to the canonical parent;
    // clicking it returns to the typed shelf.
    await user.click(screen.getByRole('button', { name: 'Back to Reading' }));
    expect(
      await screen.findByRole('region', { name: 'Literature' }),
    ).toBeInTheDocument();
  });

  it('shows a "no chapters yet" message for a book with none', async () => {
    readingSvc.listChapters.mockResolvedValue([]);

    const user = userEvent.setup();
    renderReading();
    await openBook(user);

    expect(
      await screen.findByText(/no chapters yet for this book/i),
    ).toBeInTheDocument();
  });

  it('offers Resume when the saved position points at a listed chapter, and opens it (F-069)', async () => {
    readingSvc.listChapters.mockResolvedValue([
      CHAPTER_ONE,
      { id: 6, chapterNumber: 2, title: null, startPage: 3, endPage: 4 },
    ]);
    readingSvc.getReadingPosition.mockResolvedValue({
      ...SAVED_POSITION,
      chapterId: 6,
      pageNumber: 3,
    });
    readingSvc.getChapter.mockResolvedValue({
      chapter: {
        id: 6,
        chapterNumber: 2,
        title: null,
        startPage: 3,
        endPage: 4,
        sourceUploadId: 41,
      },
      passages: [
        { id: 1, passageNumber: 1, body: '둘째 장.', pageNumber: 3 },
      ],
    });

    const user = userEvent.setup();
    renderReading();
    await openBook(user);

    const resume = await screen.findByRole('button', {
      name: /Resume — Chapter 2/,
    });
    await user.click(resume);

    // The reader opened at the SAVED chapter, not chapter one. (The body is
    // tokenized into Tapwords, so assert on a token, not the full string.)
    await waitFor(() => {
      expect(readingSvc.getChapter).toHaveBeenCalledWith(
        6,
        expect.anything(),
      );
    });
    expect(
      await screen.findByRole('button', { name: '둘째' }),
    ).toBeInTheDocument();
  });

  it('offers no Resume for a stale position whose chapter is no longer listed (F-069)', async () => {
    readingSvc.listChapters.mockResolvedValue([CHAPTER_ONE]);
    readingSvc.getReadingPosition.mockResolvedValue({
      ...SAVED_POSITION,
      chapterId: 999, // book was re-loaded; this chapter id is gone
    });

    const user = userEvent.setup();
    renderReading();
    await openBook(user);

    expect(
      await screen.findByRole('button', { name: /open 해질녘/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /resume/i }),
    ).not.toBeInTheDocument();
  });

  it('shows an error card with a working retry when the chapter list fetch fails', async () => {
    readingSvc.listChapters
      .mockRejectedValueOnce(
        new ApiError('boom', { status: 500, code: 'server_error' }),
      )
      .mockResolvedValueOnce([CHAPTER_ONE]);

    const user = userEvent.setup();
    renderReading();
    await openBook(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load this book/i);
    expect(alert).not.toHaveTextContent(/boom/);

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(
      await screen.findByRole('button', { name: /open 해질녘/i }),
    ).toBeInTheDocument();
  });
});

describe('Reading — chapter reader (tap-to-define)', () => {
  beforeEach(() => {
    readingSvc.listChapters.mockResolvedValue([CHAPTER_ONE]);
  });

  it("renders a chapter's passages as ordered, tappable text with newlines preserved", async () => {
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
    expect(
      await screen.findByRole('button', { name: '소년은' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '걸음을' })).toBeInTheDocument();

    // The internal '\n' in passage 1's body survived as a real line break
    // (a <br/> between "소년은" and "걸음을 멈췄다."), not a collapsed run-on
    // line — the regression `PassageBody`'s header comment documents.
    expect(bodies[0]?.querySelector('br')).not.toBeNull();
  });

  it('shows a "no passages yet" message for a chapter with none', async () => {
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

  it('saves the resume position for the upload when a chapter opens (F-069)', async () => {
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...CHAPTER_ONE, sourceUploadId: 41 },
      passages: [
        { id: 1, passageNumber: 1, body: '소년은 걸었다.', pageNumber: 1 },
      ],
    });

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    // Wired to the REAL route shape: PUT /reading/position/:uploadId with
    // the chapter id + its scan start page, abortable.
    await waitFor(() => {
      expect(readingSvc.saveReadingPosition).toHaveBeenCalledWith(
        '41',
        { chapterId: CHAPTER_ONE.id, pageNumber: CHAPTER_ONE.startPage },
        expect.any(AbortSignal),
      );
    });
  });

  it('toasts fixed copy when the position save fails — reading continues (F-069)', async () => {
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...CHAPTER_ONE, sourceUploadId: 41 },
      passages: [
        { id: 1, passageNumber: 1, body: '소년은 걸었다.', pageNumber: 1 },
      ],
    });
    readingSvc.saveReadingPosition.mockRejectedValue(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    expect(
      await screen.findByText(/couldn't save your reading position/i),
    ).toBeInTheDocument();
    // The passages still render — a failed save never blocks reading.
    expect(screen.getByRole('button', { name: '소년은' })).toBeInTheDocument();
  });

  it('tapping a word runs the lemmatize→define→enrich chain and opens the popover', async () => {
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...CHAPTER_ONE, sourceUploadId: 41 },
      passages: [
        { id: 1, passageNumber: 1, body: '소년은 걸었다.', pageNumber: 1 },
      ],
    });
    mockTapChain();

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
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...CHAPTER_ONE, sourceUploadId: 41 },
      passages: [
        { id: 1, passageNumber: 1, body: '소년은 걸었다.', pageNumber: 1 },
      ],
    });
    mockTapChain();
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

    // mineWord is called WITH an AbortSignal (an exact 2-argument match —
    // a signal-less call site would fail this assertion).
    expect(vocabSvc.mineWord).toHaveBeenCalledWith(
      expect.objectContaining({ lemma: '소년' }),
      expect.any(AbortSignal),
    );
    expect(mineSignal?.aborted).toBe(false);

    // Closing the popover must abort that same signal.
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(mineSignal?.aborted).toBe(true);
  });

  it('opens the translate sheet and renders the fetched translation (F-116)', async () => {
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...CHAPTER_ONE, sourceUploadId: 41 },
      passages: [
        { id: 1, passageNumber: 1, body: '소년은 걸었다.', pageNumber: 1 },
      ],
    });
    readingSvc.translatePassage.mockResolvedValue('The boy walked.');

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    await user.click(
      await screen.findByRole('button', { name: 'Translate passage 1' }),
    );

    const sheet = screen.getByRole('dialog', { name: 'Passage translation' });
    // The selected passage is shown back…
    expect(within(sheet).getByText('소년은 걸었다.')).toBeInTheDocument();
    // …and the request went out for that exact passage, abortably.
    expect(readingSvc.translatePassage).toHaveBeenCalledWith(
      '소년은 걸었다.',
      expect.any(AbortSignal),
    );
    // …then the real translation renders (never a fabricated/stub string).
    expect(
      await within(sheet).findByText('The boy walked.'),
    ).toBeInTheDocument();
    expect(within(sheet).queryByText(/coming soon/i)).not.toBeInTheDocument();

    await user.click(within(sheet).getByRole('button', { name: 'Close' }));
    expect(
      screen.queryByRole('dialog', { name: 'Passage translation' }),
    ).not.toBeInTheDocument();
  });

  it('shows a loading state while the translation is in flight', async () => {
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...CHAPTER_ONE, sourceUploadId: 41 },
      passages: [
        { id: 1, passageNumber: 1, body: '소년은 걸었다.', pageNumber: 1 },
      ],
    });
    // Never resolves — lets the test observe the loading state mid-flight.
    readingSvc.translatePassage.mockImplementation(
      () =>
        new Promise(() => {
          /* never settles */
        }),
    );

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    await user.click(
      await screen.findByRole('button', { name: 'Translate passage 1' }),
    );

    const sheet = screen.getByRole('dialog', { name: 'Passage translation' });
    expect(within(sheet).getByText(/translating/i)).toBeInTheDocument();
  });

  it('surfaces a translation failure with a working Retry — no server prose leak (F-116)', async () => {
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...CHAPTER_ONE, sourceUploadId: 41 },
      passages: [
        { id: 1, passageNumber: 1, body: '소년은 걸었다.', pageNumber: 1 },
      ],
    });
    readingSvc.translatePassage
      .mockRejectedValueOnce(
        new ApiError('boom', { status: 502, code: 'upstream_error' }),
      )
      .mockResolvedValueOnce('The boy walked.');

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    await user.click(
      await screen.findByRole('button', { name: 'Translate passage 1' }),
    );
    const sheet = screen.getByRole('dialog', { name: 'Passage translation' });

    const alert = await within(sheet).findByRole('alert');
    expect(alert).toHaveTextContent(/could not translate this passage/i);
    expect(alert).not.toHaveTextContent(/boom/);

    await user.click(within(sheet).getByRole('button', { name: 'Retry' }));
    expect(
      await within(sheet).findByText('The boy walked.'),
    ).toBeInTheDocument();
    expect(readingSvc.translatePassage).toHaveBeenCalledTimes(2);
  });

  it('renders the structured 429 retry-after copy on a rate-limited translate call', async () => {
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...CHAPTER_ONE, sourceUploadId: 41 },
      passages: [
        { id: 1, passageNumber: 1, body: '소년은 걸었다.', pageNumber: 1 },
      ],
    });
    readingSvc.translatePassage.mockRejectedValue(
      new ApiError('rate limited', {
        status: 429,
        code: 'rate_limited',
        retryAfter: 12,
      }),
    );

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    await user.click(
      await screen.findByRole('button', { name: 'Translate passage 1' }),
    );
    const sheet = screen.getByRole('dialog', { name: 'Passage translation' });

    const alert = await within(sheet).findByRole('alert');
    expect(alert).toHaveTextContent(/try again in about 12 seconds/i);
  });

  it('closing the translate sheet aborts an in-flight request', async () => {
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...CHAPTER_ONE, sourceUploadId: 41 },
      passages: [
        { id: 1, passageNumber: 1, body: '소년은 걸었다.', pageNumber: 1 },
      ],
    });
    let translateSignal: AbortSignal | undefined;
    readingSvc.translatePassage.mockImplementation(
      (_text: string, signal?: AbortSignal) => {
        translateSignal = signal;
        return new Promise(() => {
          /* never settles */
        });
      },
    );

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    await user.click(
      await screen.findByRole('button', { name: 'Translate passage 1' }),
    );
    const sheet = screen.getByRole('dialog', { name: 'Passage translation' });
    expect(translateSignal?.aborted).toBe(false);

    await user.click(within(sheet).getByRole('button', { name: 'Close' }));
    expect(translateSignal?.aborted).toBe(true);
  });
});

/**
 * Route probe standing in for `UploadViewer` — renders the matched `:id`
 * plus the query string verbatim, so the tests below assert the ACTUAL
 * navigation the scan link performs (path + `?page=` param), not an
 * implementation detail of `navigate`.
 */
function UploadViewerProbe(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  return (
    <div data-testid="upload-viewer-probe">{`${id ?? ''}${location.search}`}</div>
  );
}

/** Like `renderReading`, but with a real `/uploads/:id` route to land on. */
function renderReadingWithViewerRoute(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/learn/reading']}>
      <ToastProvider>
        <Routes>
          <Route path="/learn/reading" element={<Reading />} />
          <Route path="/uploads/:id" element={<UploadViewerProbe />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('Reading — "view original scan" deep-link (U3c)', () => {
  it('threads the chapter start_page into the scan link as ?page=N', async () => {
    const chapter = { ...CHAPTER_ONE, startPage: 5, endPage: 9 };
    readingSvc.listChapters.mockResolvedValue([chapter]);
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...chapter, sourceUploadId: 41 },
      passages: [
        { id: 1, passageNumber: 1, body: '소년은 걸었다.', pageNumber: 5 },
      ],
    });

    const user = userEvent.setup();
    renderReadingWithViewerRoute();
    await openChapterOne(user);

    await user.click(
      screen.getByRole('button', { name: /view original scan/i }),
    );

    // `startPage` IS `book_pages.page_number` (the loader wrote it as such),
    // so the value threads through unmodified — no offset correction.
    const probe = await screen.findByTestId('upload-viewer-probe');
    expect(probe.textContent).toBe('41?page=5');
  });

  it('falls back to the bare route (page 1) when start_page is null', async () => {
    const chapter = { ...CHAPTER_ONE, startPage: null, endPage: null };
    readingSvc.listChapters.mockResolvedValue([chapter]);
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...chapter, sourceUploadId: 41 },
      passages: [
        { id: 1, passageNumber: 1, body: '소년은 걸었다.', pageNumber: null },
      ],
    });

    const user = userEvent.setup();
    renderReadingWithViewerRoute();
    await openChapterOne(user);

    await user.click(
      screen.getByRole('button', { name: /view original scan/i }),
    );

    const probe = await screen.findByTestId('upload-viewer-probe');
    expect(probe.textContent).toBe('41');
  });
});

describe('Reading — AI stories (F-068)', () => {
  /** Switch to the stories tab from the root. */
  async function openStoriesTab(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<void> {
    await user.click(
      await screen.findByRole('tab', { name: /AI stories/ }),
    );
  }

  it('lists the generated-story library and opens a story as tappable text', async () => {
    readingSvc.listGeneratedStories.mockResolvedValue([STORY_SUMMARY]);
    readingSvc.getGeneratedStory.mockResolvedValue(STORY_FULL);

    const user = userEvent.setup();
    renderReading();
    await openStoriesTab(user);

    await waitFor(() => {
      expect(readingSvc.listGeneratedStories).toHaveBeenCalled();
    });
    await user.click(
      await screen.findByRole('button', { name: /Open 바닷가 마을/ }),
    );

    await waitFor(() => {
      expect(readingSvc.getGeneratedStory).toHaveBeenCalledWith(
        STORY_SUMMARY.id,
        expect.anything(),
      );
    });
    // Full body renders, blank-line paragraphs split into separate blocks,
    // each tappable (the same TapKorean treatment as chapter passages) with
    // its own F-070 translate action.
    expect(
      await screen.findByRole('button', { name: '소년은' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Translate paragraph 2' }),
    ).toBeInTheDocument();
    // F-024: the story view carries a BackButton to the stories tab.
    expect(
      screen.getByRole('button', { name: 'Back to Stories' }),
    ).toBeInTheDocument();
  });

  it('shows the empty-library copy when no stories exist yet', async () => {
    const user = userEvent.setup();
    renderReading();
    await openStoriesTab(user);

    expect(
      await screen.findByText(/no stories yet/i),
    ).toBeInTheDocument();
  });

  it('generates a story with the chosen level + topic and opens it (POST /reading/generate)', async () => {
    readingSvc.generateStory.mockResolvedValue(STORY_FULL);
    readingSvc.getGeneratedStory.mockResolvedValue(STORY_FULL);

    const user = userEvent.setup();
    renderReading();
    await openStoriesTab(user);

    // Level defaults to L3; pick L2 explicitly.
    await user.click(await screen.findByRole('radio', { name: 'L2' }));
    await user.type(screen.getByLabelText(/Topic/), '바닷가');
    await user.click(
      screen.getByRole('button', { name: /Generate story/ }),
    );

    await waitFor(() => {
      expect(readingSvc.generateStory).toHaveBeenCalledWith(
        { level: 'L2', topic: '바닷가' },
        expect.any(AbortSignal),
      );
    });
    // The fresh story opens immediately (story view, full body).
    expect(await screen.findByText('바닷가 마을')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: '소년은' }),
    ).toBeInTheDocument();
  });

  it('omits an empty topic from the generate request', async () => {
    readingSvc.generateStory.mockResolvedValue(STORY_FULL);
    readingSvc.getGeneratedStory.mockResolvedValue(STORY_FULL);

    const user = userEvent.setup();
    renderReading();
    await openStoriesTab(user);

    await user.click(
      await screen.findByRole('button', { name: /Generate story/ }),
    );

    await waitFor(() => {
      expect(readingSvc.generateStory).toHaveBeenCalledWith(
        { level: 'L3' },
        expect.any(AbortSignal),
      );
    });
  });

  it('switching tabs mid-generation aborts the in-flight request (F-068)', async () => {
    // Mirrors the "Add to bank" abort regression above: never resolves, so
    // the test observes the real signal mid-flight instead of racing a
    // resolution.
    let genSignal: AbortSignal | undefined;
    readingSvc.generateStory.mockImplementation(
      (_input: unknown, signal?: AbortSignal) => {
        genSignal = signal;
        return new Promise(() => {
          /* never settles */
        });
      },
    );

    const user = userEvent.setup();
    renderReading();
    await openStoriesTab(user);

    await user.click(
      await screen.findByRole('button', { name: /Generate story/ }),
    );

    expect(readingSvc.generateStory).toHaveBeenCalledWith(
      { level: 'L3' },
      expect.any(AbortSignal),
    );
    expect(genSignal?.aborted).toBe(false);

    // `Tabs` is a render-one primitive that re-keys its panel per tab, so
    // switching away unmounts StoryGenerator outright — this must run the
    // unmount-abort cleanup rather than leaving the request to resolve
    // against a dead component.
    await user.click(screen.getByRole('tab', { name: /Books/ }));

    expect(genSignal?.aborted).toBe(true);
  });

  it('surfaces a generation failure as fixed alert copy — no server prose leak', async () => {
    readingSvc.generateStory.mockRejectedValue(
      new ApiError('boom', { status: 502, code: 'upstream_error' }),
    );

    const user = userEvent.setup();
    renderReading();
    await openStoriesTab(user);

    await user.click(
      await screen.findByRole('button', { name: /Generate story/ }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not generate a story/i);
    expect(alert).not.toHaveTextContent(/boom/);
    // The Generate button stays enabled as the retry (429/5xx are
    // first-class paths on this expensive route).
    expect(
      screen.getByRole('button', { name: /Generate story/ }),
    ).not.toHaveAttribute('aria-disabled');
  });

  it('shows an error card with a working retry when the story list fetch fails', async () => {
    readingSvc.listGeneratedStories
      .mockRejectedValueOnce(
        new ApiError('boom', { status: 500, code: 'server_error' }),
      )
      .mockResolvedValueOnce([STORY_SUMMARY]);

    const user = userEvent.setup();
    renderReading();
    await openStoriesTab(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load your stories/i);
    expect(alert).not.toHaveTextContent(/boom/);

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(
      await screen.findByRole('button', { name: /Open 바닷가 마을/ }),
    ).toBeInTheDocument();
  });
});
