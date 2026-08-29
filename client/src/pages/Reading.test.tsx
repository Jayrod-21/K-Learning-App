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
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
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
  LibraryStorySummary,
  ReadingPosition,
  ReadingQuestion,
  StoryAudio,
  StoryImagesEnvelope,
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
  logReadingAttempt: vi.fn(),
  requestStoryAudio: vi.fn(),
  getStoryAudio: vi.fn(),
  requestStoryImages: vi.fn(),
  getStoryImages: vi.fn(),
  requestStoryExperience: vi.fn(),
  getChapterQuestions: vi.fn(),
  generateChapterQuestions: vi.fn(),
  listLibrary: vi.fn(),
  publishStory: vi.fn(),
  unpublishStory: vi.fn(),
  cloneStory: vi.fn(),
  // Module CONSTANT (not a spy): Reading.tsx maps over it to build the
  // level radiogroup, so the mock must export the real display order.
  GENERATED_STORY_LEVELS: ['L1', 'L2', 'L3', 'L4', 'L5+'] as const,
}));
const uploadsSvc = vi.hoisted(() => ({
  listUploads: vi.fn(),
  listSharedUploads: vi.fn(),
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

const COMIC_READY: BookUpload = {
  id: '77',
  title: '만화 모험',
  type: 'comic',
  status: 'ready',
  pageCount: 24,
  byteSize: 2_400_000,
  createdAt: '2026-07-01T00:00:00Z',
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

/** Two stored comprehension questions for CHAPTER_ONE (F-205). One correct
 *  option per question, at different marker positions on purpose — a test
 *  that only ever picks index 0 could pass by accident. */
const CHAPTER_QUESTIONS: ReadingQuestion[] = [
  {
    id: 501,
    questionNumber: 1,
    questionText: '소년은 어디로 갔나요?',
    options: [
      { text: '학교', correct: false },
      { text: '시장', correct: true },
      { text: '집', correct: false },
      { text: '공원', correct: false },
    ],
    explanation: '본문에 따르면 소년은 시장으로 갔습니다.',
    kind: 'comprehension',
  },
  {
    id: 502,
    questionNumber: 2,
    questionText: '소녀는 무엇을 주었나요?',
    options: [
      { text: '사과', correct: true },
      { text: '배', correct: false },
      { text: '감', correct: false },
      { text: '포도', correct: false },
    ],
    explanation: '소녀는 사과를 주었습니다.',
    kind: 'comprehension',
  },
];

/** `ComprehensionQuestion` renders `{number}. {questionText}` as sibling
 *  JSX text children inside one `<p>` — RTL's `getByText` normalizes to the
 *  element's WHOLE text content, so a query must include the numbered
 *  prefix to land a unique, exact match. */
function questionPrompt(q: ReadingQuestion): string {
  return `${String(q.questionNumber)}. ${q.questionText}`;
}

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
  // F-216 — aggregate asset statuses ride every list row.
  audioStatus: 'none',
  imageStatus: 'none',
};

// The single-story DTO carries NO aggregate statuses (list-only fields) —
// strip them rather than spread them through, mirroring the wire exactly.
const STORY_FULL: GeneratedStory = {
  id: STORY_SUMMARY.id,
  title: STORY_SUMMARY.title,
  level: STORY_SUMMARY.level,
  prompt: STORY_SUMMARY.prompt,
  createdAt: STORY_SUMMARY.createdAt,
  bodyKo: '소년은 바닷가를 걸었다.\n\n바람이 불었다.',
};

// ── F-210 story-audio envelope fixtures ──

const AUDIO_NONE: StoryAudio = {
  status: 'none',
  jobId: null,
  error: null,
  track: null,
  segments: [],
};

const AUDIO_PENDING: StoryAudio = {
  status: 'pending',
  jobId: 11,
  error: null,
  track: null,
  segments: [],
};

/** streamUrl matches the REAL `buildAudioSrc` allow-list (services/ttmik is
 *  deliberately NOT mocked — the src assertions cover the true resolver,
 *  the MyAudio.test.tsx precedent; empty API base → app-relative src). */
const AUDIO_DONE: StoryAudio = {
  status: 'done',
  jobId: 11,
  error: null,
  track: { id: 9, streamUrl: '/audio/tracks/9/stream', durationMs: 8000 },
  segments: [
    { segmentNumber: 1, startMs: 0, endMs: 4000, body: '소년은 바닷가를 걸었다.' },
    { segmentNumber: 2, startMs: 4000, endMs: 8000, body: '바람이 불었다.' },
  ],
};

/** Voiced but with NO usable timing (all-zero windows) — audio must still
 *  play, highlighting must not engage, body stays paragraph-rendered. */
const AUDIO_DONE_NO_TIMING: StoryAudio = {
  ...AUDIO_DONE,
  segments: AUDIO_DONE.segments.map((s) => ({ ...s, startMs: 0, endMs: 0 })),
};

const AUDIO_FAILED: StoryAudio = {
  status: 'failed',
  jobId: 11,
  error: 'The voice service is unavailable right now. Try again later.',
  track: null,
  segments: [],
};

/** Dormant deploy: the server reports it cannot synthesize (no TTS key) —
 *  the client renders NO audio card at all (absence, not a dead
 *  affordance). Only an EXPLICIT false hides; the other fixtures above omit
 *  the flag on purpose (older-server forward-compat keeps the feature). */
const AUDIO_NONE_UNCONFIGURED: StoryAudio = {
  ...AUDIO_NONE,
  ttsConfigured: false,
};

// ── F-211 story-images envelope fixtures ──

const IMAGES_NONE: StoryImagesEnvelope = {
  status: 'none',
  jobId: null,
  error: null,
  images: [],
  imageGenConfigured: true,
};

const IMAGES_PENDING: StoryImagesEnvelope = {
  status: 'pending',
  jobId: 31,
  error: null,
  images: [],
  imageGenConfigured: true,
};

/** blobUrls match the REAL `buildStoryImageSrc` allow-list (services/ttmik
 *  is deliberately NOT mocked — the src assertions cover the true resolver,
 *  same stance as the F-210 audio tests; empty API base → app-relative
 *  src). The `prompt` is English generation scaffolding and must NEVER
 *  surface in the DOM (alt text stays a generic ordinal). */
const IMAGES_DONE: StoryImagesEnvelope = {
  status: 'done',
  jobId: 31,
  error: null,
  images: [
    {
      imageNumber: 1,
      blobUrl: '/reading/generated/7/image/1/blob',
      prompt: 'SCAFFOLD-PROMPT-ONE: a boy on a beach, Korean webtoon style',
      width: 1024,
      height: 1024,
    },
    {
      imageNumber: 2,
      blobUrl: '/reading/generated/7/image/2/blob',
      prompt: 'SCAFFOLD-PROMPT-TWO: wind over the sea, Korean webtoon style',
      width: 1024,
      height: 1024,
    },
    {
      imageNumber: 3,
      blobUrl: '/reading/generated/7/image/3/blob',
      prompt: 'SCAFFOLD-PROMPT-THREE: dusk falling, Korean webtoon style',
      width: 1024,
      height: 1024,
    },
  ],
  imageGenConfigured: true,
};

/** One valid blob among tampered company — the off-origin absolute URL and
 *  the wrong-route path must BOTH die at the allow-list; only the valid
 *  scene renders. */
const IMAGES_DONE_TAMPERED: StoryImagesEnvelope = {
  ...IMAGES_DONE,
  images: [
    {
      imageNumber: 1,
      blobUrl: 'https://evil.example/tracker.png',
      prompt: 'p1',
      width: 1024,
      height: 1024,
    },
    {
      imageNumber: 2,
      blobUrl: '/reading/generated/7/image/2/blob',
      prompt: 'p2',
      width: 1024,
      height: 1024,
    },
    {
      imageNumber: 3,
      blobUrl: '/uploads/9/file',
      prompt: 'p3',
      width: 1024,
      height: 1024,
    },
  ],
};

const IMAGES_FAILED: StoryImagesEnvelope = {
  status: 'failed',
  jobId: 31,
  error: 'The image service is unavailable right now. Try again later.',
  images: [],
  imageGenConfigured: true,
};

/** Dormant deploy: no OpenAI image key — the client renders NO illustration
 *  UI at all (absence, not a dead affordance), even for a done envelope. */
const IMAGES_NONE_UNCONFIGURED: StoryImagesEnvelope = {
  status: 'none',
  jobId: null,
  error: null,
  images: [],
  imageGenConfigured: false,
};

const IMAGES_DONE_UNCONFIGURED: StoryImagesEnvelope = {
  ...IMAGES_DONE,
  imageGenConfigured: false,
};

/** Flag omitted entirely (defensive forward-compat) — only an EXPLICIT
 *  false hides the surface. */
const IMAGES_NONE_NO_FLAG: StoryImagesEnvelope = {
  status: 'none',
  jobId: null,
  error: null,
  images: [],
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
  readingSvc.logReadingAttempt.mockReset();
  readingSvc.requestStoryAudio.mockReset();
  readingSvc.getStoryAudio.mockReset();
  readingSvc.requestStoryImages.mockReset();
  readingSvc.getStoryImages.mockReset();
  readingSvc.requestStoryExperience.mockReset();
  readingSvc.getChapterQuestions.mockReset();
  readingSvc.generateChapterQuestions.mockReset();
  readingSvc.listLibrary.mockReset();
  readingSvc.publishStory.mockReset();
  readingSvc.unpublishStory.mockReset();
  readingSvc.cloneStory.mockReset();
  uploadsSvc.listUploads.mockReset();
  uploadsSvc.listSharedUploads.mockReset();
  uploadsSvc.getUpload.mockReset();
  tapSvc.lemmatize.mockReset();
  tapSvc.defineEntry.mockReset();
  tapSvc.enrich.mockReset();
  vocabSvc.mineWord.mockReset();

  // Safe defaults — individual tests override what they exercise. Without
  // these, an unmocked service resolves `undefined` and the component's
  // Promise chains would crash on a shape it can never receive in prod.
  uploadsSvc.listUploads.mockResolvedValue([LITERATURE_READY]);
  // F-217: default to an empty shared library so every pre-F-217 test sees
  // the exact shelf it always did (the section renders nothing when empty).
  uploadsSvc.listSharedUploads.mockResolvedValue([]);
  uploadsSvc.getUpload.mockResolvedValue(LITERATURE_READY);
  readingSvc.getReadingPosition.mockResolvedValue(null);
  readingSvc.saveReadingPosition.mockResolvedValue(SAVED_POSITION);
  // F-216: the list resolves the library ENVELOPE (rows + capability
  // flags); flags omitted here on purpose — default-shown forward-compat.
  readingSvc.listGeneratedStories.mockResolvedValue({ stories: [] });
  // F-210: the story reader hydrates audio status on mount — default to the
  // never-voiced envelope so pre-F-210 story tests see the same reader body
  // they always did (plus an inert "Generate audio" card).
  readingSvc.getStoryAudio.mockResolvedValue(AUDIO_NONE);
  // F-211: same posture for the illustration hydrate — never-illustrated,
  // configured (an inert "Generate illustrations" button; no polling).
  readingSvc.getStoryImages.mockResolvedValue(IMAGES_NONE);
  // F-205: the chapter reader's comprehension-check card hydrates on mount
  // too — default to "not generated yet" so every pre-F-205 chapter-reader
  // test sees the same reader body it always did (plus an inert "Generate
  // comprehension check" button).
  readingSvc.getChapterQuestions.mockResolvedValue([]);
  // #45: default to an empty public library so every pre-#45 test sees the
  // exact reader/tabs it always did (the Library tab renders its own empty
  // state, nothing else observes this call).
  readingSvc.listLibrary.mockResolvedValue([]);
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
    { surface: '소년은', lemma: '소년', pos: 'NNG', start: 0, end: 3 },
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

describe('Reading — Today deep link (F-183: ?chapter= with no ?book=)', () => {
  function renderReadingAt(entry: string): ReturnType<typeof render> {
    return render(
      <MemoryRouter initialEntries={[entry]}>
        <ToastProvider>
          <Reading />
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  it('opens the chapter reader directly from a bare ?chapter=ID (no ?book=, no chapter-list/upload fetch)', async () => {
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...CHAPTER_ONE, sourceUploadId: 41 },
      passages: [
        { id: 1, passageNumber: 1, body: '소년은 걸었다.', pageNumber: 1 },
      ],
    });

    renderReadingAt('/learn/reading?chapter=5');

    expect(
      await screen.findByRole('button', { name: '소년은' }),
    ).toBeInTheDocument();
    expect(readingSvc.getChapter).toHaveBeenCalledWith(
      5,
      expect.any(AbortSignal),
    );
    // The reader needs only its own chapter id — no book context was ever
    // fetched (ChapterReader reads `sourceUploadId` off the FETCHED chapter,
    // not a route param).
    expect(readingSvc.listChapters).not.toHaveBeenCalled();
    expect(uploadsSvc.getUpload).not.toHaveBeenCalled();

    // F-024: no book to Back to — the Reading root, not a chapter picker.
    expect(
      screen.getByRole('button', { name: 'Back to Reading' }),
    ).toBeInTheDocument();
  });

  it('a malformed ?chapter= (non-numeric) falls back to the Books landing, never into a fetch', async () => {
    renderReadingAt('/learn/reading?chapter=abc');

    expect(
      await screen.findByRole('button', {
        name: new RegExp(`Open ${LITERATURE_READY.title}`),
      }),
    ).toBeInTheDocument();
    expect(readingSvc.getChapter).not.toHaveBeenCalled();
  });

  it('a well-formed but nonexistent ?chapter= surfaces the honest error card — never a crash', async () => {
    readingSvc.getChapter.mockRejectedValue(
      new ApiError('not found', { status: 404, code: 'not_found' }),
    );

    renderReadingAt('/learn/reading?chapter=999999');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load this chapter/i);
  });

  it('the F-069 position auto-save and F-172 "mark as read" still work from the bare deep link', async () => {
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...CHAPTER_ONE, sourceUploadId: 41 },
      passages: [
        { id: 1, passageNumber: 1, body: '소년은 걸었다.', pageNumber: 1 },
      ],
    });
    readingSvc.logReadingAttempt.mockResolvedValue({
      id: 9,
      sourceKind: 'chapter',
      chapterId: CHAPTER_ONE.id,
      storyId: null,
      titleSnapshot: CHAPTER_ONE.title,
      passageNumber: 1,
      completedAt: '2026-07-14T00:00:00Z',
    });

    const user = userEvent.setup();
    renderReadingAt('/learn/reading?chapter=5');
    await screen.findByRole('button', { name: '소년은' });

    // Position save keys off the FETCHED chapter's own sourceUploadId, not
    // a route param that doesn't exist on this deep link.
    await waitFor(() => {
      expect(readingSvc.saveReadingPosition).toHaveBeenCalledWith(
        '41',
        { chapterId: CHAPTER_ONE.id, pageNumber: CHAPTER_ONE.startPage },
        expect.any(AbortSignal),
      );
    });

    await user.click(
      await screen.findByRole('button', { name: /mark chapter as read/i }),
    );
    await waitFor(() => {
      expect(readingSvc.logReadingAttempt).toHaveBeenCalledWith(
        { sourceKind: 'chapter', chapterId: CHAPTER_ONE.id, passageNumber: 1 },
        expect.any(AbortSignal),
      );
    });
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

  it('F-217: a 404 on the position save (non-owner reading a SHARED book) is swallowed silently — no error toast, reading continues', async () => {
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...CHAPTER_ONE, sourceUploadId: 41 },
      passages: [
        { id: 1, passageNumber: 1, body: '소년은 걸었다.', pageNumber: 1 },
      ],
    });
    // The owner-only PUT /reading/position/:uploadId 404s for a non-owner
    // on every chapter open — expected, not an error.
    readingSvc.saveReadingPosition.mockRejectedValue(
      new ApiError('not found', { status: 404, code: 'not_found' }),
    );

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    // The save was attempted (and rejected) …
    await waitFor(() => {
      expect(readingSvc.saveReadingPosition).toHaveBeenCalled();
    });
    // … but no toast fired, and the reader body is intact.
    expect(
      screen.queryByText(/couldn't save your reading position/i),
    ).not.toBeInTheDocument();
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

describe('Reading — mark chapter as read (F-172)', () => {
  beforeEach(() => {
    readingSvc.listChapters.mockResolvedValue([CHAPTER_ONE]);
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...CHAPTER_ONE, sourceUploadId: 41 },
      passages: [
        { id: 1, passageNumber: 1, body: '첫 문단.', pageNumber: 1 },
        { id: 2, passageNumber: 2, body: '둘째 문단.', pageNumber: 2 },
      ],
    });
  });

  it('logs the attempt with the last passage number, then shows a done state', async () => {
    readingSvc.logReadingAttempt.mockResolvedValue({
      id: 1,
      sourceKind: 'chapter',
      chapterId: CHAPTER_ONE.id,
      storyId: null,
      titleSnapshot: CHAPTER_ONE.title,
      passageNumber: 2,
      completedAt: '2026-07-14T00:00:00Z',
    });

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    const markButton = await screen.findByRole('button', {
      name: /mark chapter as read/i,
    });
    await user.click(markButton);

    await waitFor(() => {
      expect(readingSvc.logReadingAttempt).toHaveBeenCalledWith(
        { sourceKind: 'chapter', chapterId: CHAPTER_ONE.id, passageNumber: 2 },
        expect.any(AbortSignal),
      );
    });
    expect(
      await screen.findByRole('button', { name: /chapter read/i }),
    ).toBeInTheDocument();
  });

  it('shows a fixed error message (no server prose) when the log POST fails, and the button stays clickable', async () => {
    readingSvc.logReadingAttempt.mockRejectedValue(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    await user.click(
      await screen.findByRole('button', { name: /mark chapter as read/i }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't save/i);
    expect(alert).not.toHaveTextContent(/boom/);
    // The button itself is unaffected by the error — still offers the
    // original label, not stuck showing "Saving…".
    expect(
      screen.getByRole('button', { name: /mark chapter as read/i }),
    ).toBeInTheDocument();
  });

  it('a chapter with no passages logs with no passageNumber', async () => {
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...CHAPTER_ONE, sourceUploadId: 41 },
      passages: [],
    });
    readingSvc.logReadingAttempt.mockResolvedValue({
      id: 2,
      sourceKind: 'chapter',
      chapterId: CHAPTER_ONE.id,
      storyId: null,
      titleSnapshot: CHAPTER_ONE.title,
      passageNumber: null,
      completedAt: '2026-07-14T00:00:00Z',
    });

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    await user.click(
      await screen.findByRole('button', { name: /mark chapter as read/i }),
    );

    await waitFor(() => {
      expect(readingSvc.logReadingAttempt).toHaveBeenCalledWith(
        { sourceKind: 'chapter', chapterId: CHAPTER_ONE.id },
        expect.any(AbortSignal),
      );
    });
  });
});

describe('Reading — comprehension check (F-205)', () => {
  beforeEach(() => {
    readingSvc.listChapters.mockResolvedValue([CHAPTER_ONE]);
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...CHAPTER_ONE, sourceUploadId: 41 },
      passages: [
        { id: 1, passageNumber: 1, body: '첫 문단.', pageNumber: 1 },
        { id: 2, passageNumber: 2, body: '둘째 문단.', pageNumber: 2 },
      ],
    });
  });

  it('renders the stored questions when present, with no generate button', async () => {
    readingSvc.getChapterQuestions.mockResolvedValue(CHAPTER_QUESTIONS);

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    expect(
      await screen.findByText(/check your understanding/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(questionPrompt(CHAPTER_QUESTIONS[0]!)),
    ).toBeInTheDocument();
    expect(
      screen.getByText(questionPrompt(CHAPTER_QUESTIONS[1]!)),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /generate comprehension check/i }),
    ).not.toBeInTheDocument();
    expect(readingSvc.getChapterQuestions).toHaveBeenCalledWith(
      CHAPTER_ONE.id,
      expect.any(AbortSignal),
    );
  });

  it('shows an explicit generate button when none exist, and calls the service on click', async () => {
    readingSvc.getChapterQuestions.mockResolvedValue([]);
    readingSvc.generateChapterQuestions.mockResolvedValue(CHAPTER_QUESTIONS);

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    const genButton = await screen.findByRole('button', {
      name: /generate comprehension check/i,
    });
    // Never auto-generated on load — the F-216 posture.
    expect(readingSvc.generateChapterQuestions).not.toHaveBeenCalled();

    await user.click(genButton);

    await waitFor(() => {
      expect(readingSvc.generateChapterQuestions).toHaveBeenCalledWith(
        CHAPTER_ONE.id,
        expect.any(AbortSignal),
      );
    });
    expect(
      await screen.findByText(questionPrompt(CHAPTER_QUESTIONS[0]!)),
    ).toBeInTheDocument();
  });

  it('a wrong pick reveals "Not quite" + the explanation (F-009 idiom)', async () => {
    readingSvc.getChapterQuestions.mockResolvedValue(CHAPTER_QUESTIONS);

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    await screen.findByText(questionPrompt(CHAPTER_QUESTIONS[0]!));
    // Q1's wrong option — index 0, '학교'.
    await user.click(screen.getByRole('radio', { name: /① 학교/ }));

    expect(await screen.findByText(/not quite/i)).toBeInTheDocument();
    expect(
      screen.getByText(CHAPTER_QUESTIONS[0]!.explanation),
    ).toBeInTheDocument();
    // A picked/revealed choice can't be re-clicked.
    expect(screen.getByRole('radio', { name: /① 학교/ })).toBeDisabled();
  });

  it('a correct pick reveals "Correct" + the explanation', async () => {
    readingSvc.getChapterQuestions.mockResolvedValue(CHAPTER_QUESTIONS);

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    await screen.findByText(questionPrompt(CHAPTER_QUESTIONS[0]!));
    // Q1's correct option — index 1, '시장'.
    await user.click(screen.getByRole('radio', { name: /② 시장/ }));

    expect(await screen.findByText(/^correct$/i)).toBeInTheDocument();
    expect(
      screen.getByText(CHAPTER_QUESTIONS[0]!.explanation),
    ).toBeInTheDocument();
  });

  it('tallies the score once every question is answered', async () => {
    readingSvc.getChapterQuestions.mockResolvedValue(CHAPTER_QUESTIONS);

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    await screen.findByText(questionPrompt(CHAPTER_QUESTIONS[0]!));
    expect(screen.queryByText(/score:/i)).not.toBeInTheDocument();

    // Q1 correct ('시장'), Q2 wrong ('배' instead of '사과') — expect 1 / 2.
    await user.click(screen.getByRole('radio', { name: /② 시장/ }));
    await screen.findByText(/^correct$/i);
    await user.click(screen.getByRole('radio', { name: /② 배/ }));

    expect(await screen.findByText(/score: 1 \/ 2/i)).toBeInTheDocument();
  });

  it('a fetch failure renders a retryable error, not a crash', async () => {
    readingSvc.getChapterQuestions.mockRejectedValue(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    const alert = await screen.findByText(/could not load the comprehension check/i);
    expect(alert).toBeInTheDocument();
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
    // The reader body around it is untouched — no crash. Passage text
    // tokenises into per-word Tapword buttons (no single element carries the
    // full sentence — see `questionPrompt`'s note), so assert on a stable
    // structural landmark instead: the passages still render as tappable
    // words, and the "mark as read" affordance is still there below the
    // failed card.
    expect(
      await screen.findByRole('button', { name: '첫' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /mark chapter as read/i }),
    ).toBeInTheDocument();
  });

  it('shows the whitelisted daily-cap message verbatim when generation is capped, and the button stays available', async () => {
    readingSvc.getChapterQuestions.mockResolvedValue([]);
    readingSvc.generateChapterQuestions.mockRejectedValue(
      new ApiError(
        'daily comprehension-check generation limit reached (5/day). Try again tomorrow.',
        { status: 429, code: 'rate_limited' },
      ),
    );

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    await user.click(
      await screen.findByRole('button', {
        name: /generate comprehension check/i,
      }),
    );

    expect(
      await screen.findByText(/daily comprehension-check generation limit reached/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /generate comprehension check/i }),
    ).toBeInTheDocument();
  });

  it('a generic (non-429) generate failure shows fixed alert copy — no server prose leak', async () => {
    readingSvc.getChapterQuestions.mockResolvedValue([]);
    readingSvc.generateChapterQuestions.mockRejectedValue(
      new ApiError('boom', { status: 502, code: 'upstream_error' }),
    );

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    await user.click(
      await screen.findByRole('button', {
        name: /generate comprehension check/i,
      }),
    );

    const alert = await screen.findByText(/could not generate the comprehension check/i);
    expect(alert).toBeInTheDocument();
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
    // The generate button stays available as the retry.
    expect(
      screen.getByRole('button', { name: /generate comprehension check/i }),
    ).toBeInTheDocument();
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

describe('Reading — Comics & Picture Books (Track P)', () => {
  it("groups a ready 'comic' upload into its own Comics & Picture Books section, not Literature/Documents", async () => {
    uploadsSvc.listUploads.mockResolvedValue([
      LITERATURE_READY,
      COMIC_READY,
      GRAMMAR_READY,
    ]);

    renderReading();

    const comics = await screen.findByRole('region', {
      name: 'Comics & Picture Books',
    });
    expect(
      within(comics).getByRole('button', {
        name: new RegExp(`Open ${COMIC_READY.title}`),
      }),
    ).toBeInTheDocument();

    // The comic sits ONLY in its own section — never in a prose section.
    const literature = screen.getByRole('region', { name: 'Literature' });
    const documents = screen.getByRole('region', { name: 'Documents' });
    expect(
      within(literature).queryByText(COMIC_READY.title),
    ).not.toBeInTheDocument();
    expect(
      within(documents).queryByText(COMIC_READY.title),
    ).not.toBeInTheDocument();
  });

  it('tapping a comic row opens the page-image viewer at /uploads/:id — never the chapter picker (?book=)', async () => {
    uploadsSvc.listUploads.mockResolvedValue([COMIC_READY]);

    const user = userEvent.setup();
    renderReadingWithViewerRoute();

    await user.click(
      await screen.findByRole('button', {
        name: new RegExp(`Open ${COMIC_READY.title}`),
      }),
    );

    // The viewer route rendered with the comic's id and NO query string —
    // the `?book=ID` chapter-picker path (which would dead-end on "no
    // chapters yet"; comics have no reading_chapters) was never taken.
    const probe = await screen.findByTestId('upload-viewer-probe');
    expect(probe.textContent).toBe(COMIC_READY.id);
    expect(readingSvc.listChapters).not.toHaveBeenCalled();
  });
});

describe('Reading — Shared Library (F-217)', () => {
  const SHARED_LIT: BookUpload = {
    id: '90',
    title: '공유 문학집',
    type: 'literature',
    status: 'ready',
    pageCount: 40,
    byteSize: 1_500_000,
    createdAt: '2026-08-01T00:00:00Z',
  };

  const SHARED_COMIC: BookUpload = {
    id: '91',
    title: '공유 만화',
    type: 'comic',
    status: 'ready',
    pageCount: 20,
    byteSize: 2_000_000,
    createdAt: '2026-08-02T00:00:00Z',
  };

  it("renders a Shared Library section BELOW the owner's sections, listing only books the user does NOT own (no double-listing)", async () => {
    uploadsSvc.listUploads.mockResolvedValue([LITERATURE_READY]);
    // The shared listing includes the caller's own shared book too (the
    // server serves one library to every account) — the shelf must de-dupe
    // it out of the Shared Library because Literature already lists it.
    uploadsSvc.listSharedUploads.mockResolvedValue([
      LITERATURE_READY,
      SHARED_LIT,
    ]);

    renderReading();

    const sharedRegion = await screen.findByRole('region', {
      name: 'Shared Library',
    });
    expect(
      within(sharedRegion).getByRole('button', {
        name: new RegExp(`Open ${SHARED_LIT.title}`),
      }),
    ).toBeInTheDocument();
    // The owned-and-shared book renders exactly once — in Literature.
    const literature = screen.getByRole('region', { name: 'Literature' });
    expect(
      within(literature).getByRole('button', {
        name: new RegExp(`Open ${LITERATURE_READY.title}`),
      }),
    ).toBeInTheDocument();
    expect(
      within(sharedRegion).queryByText(LITERATURE_READY.title),
    ).not.toBeInTheDocument();
    // Additive placement: the shared section sits BELOW the owner's.
    expect(
      literature.compareDocumentPosition(sharedRegion) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('a non-owner with ZERO uploads of their own lands on the Shared Library — not the upload prompt', async () => {
    uploadsSvc.listUploads.mockResolvedValue([]);
    uploadsSvc.listSharedUploads.mockResolvedValue([SHARED_LIT]);

    renderReading();

    expect(
      await screen.findByRole('region', { name: 'Shared Library' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/upload a book to start reading/i),
    ).not.toBeInTheDocument();
  });

  it('opening a shared LITERATURE book reaches the chapter picker WITHOUT an ErrorCard (the owner-only position 404 resolves to null)', async () => {
    uploadsSvc.listUploads.mockResolvedValue([]);
    uploadsSvc.listSharedUploads.mockResolvedValue([SHARED_LIT]);
    uploadsSvc.getUpload.mockResolvedValue(SHARED_LIT);
    readingSvc.listChapters.mockResolvedValue([CHAPTER_ONE]);
    // What the service layer NOW returns for a non-owner: getReadingPosition
    // swallows the owner-only route's 404 into null (services/reading.ts) —
    // the picker's Promise.all sees a resolved null, never a rejection.
    readingSvc.getReadingPosition.mockResolvedValue(null);

    const user = userEvent.setup();
    renderReading();

    await user.click(
      await screen.findByRole('button', {
        name: new RegExp(`Open ${SHARED_LIT.title}`),
      }),
    );

    // The chapter list rendered — no ErrorCard, and no Resume button (a
    // borrowed book starts from the beginning).
    expect(
      await screen.findByRole('button', { name: /open 해질녘/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /resume/i }),
    ).not.toBeInTheDocument();
  });

  it('a shared COMIC opens the page-image viewer at /uploads/:id — never the chapter picker', async () => {
    uploadsSvc.listUploads.mockResolvedValue([]);
    uploadsSvc.listSharedUploads.mockResolvedValue([SHARED_COMIC]);

    const user = userEvent.setup();
    renderReadingWithViewerRoute();

    await user.click(
      await screen.findByRole('button', {
        name: new RegExp(`Open ${SHARED_COMIC.title}`),
      }),
    );

    const probe = await screen.findByTestId('upload-viewer-probe');
    expect(probe.textContent).toBe(SHARED_COMIC.id);
    expect(readingSvc.listChapters).not.toHaveBeenCalled();
  });

  it("a failed shared-library fetch degrades to no section — the owner's own shelf still renders (no ErrorCard)", async () => {
    uploadsSvc.listUploads.mockResolvedValue([LITERATURE_READY]);
    uploadsSvc.listSharedUploads.mockRejectedValue(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    renderReading();

    expect(
      await screen.findByRole('region', { name: 'Literature' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Shared Library' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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
    readingSvc.listGeneratedStories.mockResolvedValue({
      stories: [STORY_SUMMARY],
    });
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
      .mockResolvedValueOnce({ stories: [STORY_SUMMARY] });

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

describe('Reading — mark story as finished (F-172)', () => {
  async function openStory(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    readingSvc.listGeneratedStories.mockResolvedValue({
      stories: [STORY_SUMMARY],
    });
    readingSvc.getGeneratedStory.mockResolvedValue(STORY_FULL);
    await user.click(await screen.findByRole('tab', { name: /AI stories/ }));
    await user.click(
      await screen.findByRole('button', { name: /Open 바닷가 마을/ }),
    );
  }

  it('logs a story-sourced attempt (no passageNumber — stories have no passage concept)', async () => {
    readingSvc.logReadingAttempt.mockResolvedValue({
      id: 3,
      sourceKind: 'story',
      chapterId: null,
      storyId: STORY_SUMMARY.id,
      titleSnapshot: STORY_SUMMARY.title,
      passageNumber: null,
      completedAt: '2026-07-14T00:00:00Z',
    });

    const user = userEvent.setup();
    renderReading();
    await openStory(user);

    await user.click(
      await screen.findByRole('button', { name: /mark story as finished/i }),
    );

    await waitFor(() => {
      expect(readingSvc.logReadingAttempt).toHaveBeenCalledWith(
        { sourceKind: 'story', storyId: STORY_SUMMARY.id },
        expect.any(AbortSignal),
      );
    });
    expect(
      await screen.findByRole('button', { name: /story finished/i }),
    ).toBeInTheDocument();
  });

  it('shows a fixed error message when the log POST fails', async () => {
    readingSvc.logReadingAttempt.mockRejectedValue(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    const user = userEvent.setup();
    renderReading();
    await openStory(user);

    await user.click(
      await screen.findByRole('button', { name: /mark story as finished/i }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't save/i);
    expect(alert).not.toHaveTextContent(/boom/);
  });
});

// F-128 ("Seoul Day & Night") reskin — structural assertions that the real
// character-device components (PageHubHeader/CityCard/DancheongRail/
// giwa+hangul-watermark) are actually rendered, mirroring the precedent set
// by `ReviewGrammar.test.tsx`'s and `Mistakes.test.tsx`'s own hub-header
// tests. F-070's translate-popup behavior itself is already covered by the
// "chapter reader" describe block above (unchanged by the reskin); these
// tests cover the NEW visual surface only.
describe('Reading — Seoul Day & Night reskin (F-128/F-129/F-131)', () => {
  it('renders the shared PageHubHeader recipe (skyline + rail + a real h1) instead of a flat Topbar', async () => {
    const { container } = renderReading();
    await screen.findByRole('button', {
      name: new RegExp(`Open ${LITERATURE_READY.title}`),
    });

    expect(
      container.querySelector('.km-hubheader__skyline'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('.km-hubheader__rail-divider'),
    ).toBeInTheDocument();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveAttribute('id', 'reading-title');
    expect(heading).toHaveTextContent(/Reading/);
  });

  it('carries the ambient rain-sheen device on the page root (device #8)', async () => {
    const { container } = renderReading();
    await screen.findByRole('button', {
      name: new RegExp(`Open ${LITERATURE_READY.title}`),
    });

    expect(container.querySelector('section.km-reading')).toHaveClass(
      'km-rain-sheen',
    );
  });

  it('shows the empty-uploads state with the giwa/hangul-watermark texture (devices #3/#6)', async () => {
    uploadsSvc.listUploads.mockResolvedValue([]);
    renderReading();

    const empty = await screen.findByText(/upload a book to start reading/i);
    const wrap = empty.closest('.km-reading__empty');
    expect(wrap).toHaveClass('km-giwa', 'km-hangul-watermark');
    expect(wrap).toHaveAttribute('data-glyph', '책');
  });

  it('renders the chapter passage reader as an accent CityCard with the editorial-serif passage-text class (device #1/#2)', async () => {
    readingSvc.listChapters.mockResolvedValue([CHAPTER_ONE]);
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...CHAPTER_ONE, sourceUploadId: 41 },
      passages: [
        { id: 1, passageNumber: 1, body: '소년은 걸었다.', pageNumber: 1 },
      ],
    });

    const user = userEvent.setup();
    const { container } = renderReading();
    await openChapterOne(user);

    const readerCard = container.querySelector('.km-reading__reader-card');
    expect(readerCard).toHaveClass('km-citycard', 'km-tone--accent');
    expect(
      readerCard?.querySelector('.km-dancheong-rail'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('.km-reading__passage-text'),
    ).toBeInTheDocument();
  });

  it('shows the no-passages empty state with the giwa/hangul-watermark texture', async () => {
    readingSvc.listChapters.mockResolvedValue([CHAPTER_ONE]);
    readingSvc.getChapter.mockResolvedValue({
      chapter: { ...CHAPTER_ONE, sourceUploadId: 41 },
      passages: [],
    });

    const user = userEvent.setup();
    renderReading();
    await openChapterOne(user);

    const text = await screen.findByText(/no passages yet for this chapter/i);
    const empty = text.closest('.km-reference__empty');
    expect(empty).toHaveClass('km-giwa', 'km-hangul-watermark');
    expect(empty).toHaveAttribute('data-glyph', '본문');
  });

  it('renders the F-069 resume callout as a blue-tone CityCard', async () => {
    readingSvc.listChapters.mockResolvedValue([
      CHAPTER_ONE,
      { id: 6, chapterNumber: 2, title: null, startPage: 3, endPage: 4 },
    ]);
    readingSvc.getReadingPosition.mockResolvedValue({
      ...SAVED_POSITION,
      chapterId: 6,
      pageNumber: 3,
    });

    const user = userEvent.setup();
    const { container } = renderReading();
    await openBook(user);
    await screen.findByRole('button', { name: /Resume — Chapter 2/ });

    const resumeCard = container.querySelector('.km-reading__resume');
    expect(resumeCard).toHaveClass('km-citycard', 'km-tone--blue');
  });

  it('shows the no-chapters empty state with the giwa/hangul-watermark texture', async () => {
    readingSvc.listChapters.mockResolvedValue([]);

    const user = userEvent.setup();
    renderReading();
    await openBook(user);

    const text = await screen.findByText(/no chapters yet for this book/i);
    const empty = text.closest('.km-reference__empty');
    expect(empty).toHaveClass('km-giwa', 'km-hangul-watermark');
    expect(empty).toHaveAttribute('data-glyph', '목차');
  });

  it('renders the F-068 story generator as a mint-tone, featured CityCard with a sparing najeon shimmer on its spark glyph', async () => {
    const user = userEvent.setup();
    const { container } = renderReading();
    await user.click(await screen.findByRole('tab', { name: /AI stories/ }));

    const genCard = container.querySelector('.km-reading__gen');
    expect(genCard).toHaveClass('km-citycard', 'km-tone--mint', 'km-citycard--feat');
    expect(
      genCard?.querySelector('.km-reading__gen-spark'),
    ).toHaveClass('km-najeon', 'km-najeon--shimmer');
  });

  it('shows the no-stories empty state with the giwa/hangul-watermark texture', async () => {
    const user = userEvent.setup();
    renderReading();
    await user.click(await screen.findByRole('tab', { name: /AI stories/ }));

    const text = await screen.findByText(/no stories yet/i);
    const empty = text.closest('.km-reference__empty');
    expect(empty).toHaveClass('km-giwa', 'km-hangul-watermark');
    expect(empty).toHaveAttribute('data-glyph', '이야기');
  });

  it('renders the story reader passage card with the same accent CityCard treatment as the chapter reader', async () => {
    readingSvc.listGeneratedStories.mockResolvedValue({
      stories: [STORY_SUMMARY],
    });
    readingSvc.getGeneratedStory.mockResolvedValue(STORY_FULL);

    const user = userEvent.setup();
    const { container } = renderReading();
    await user.click(await screen.findByRole('tab', { name: /AI stories/ }));
    await user.click(
      await screen.findByRole('button', { name: /Open 바닷가 마을/ }),
    );

    const readerCard = container.querySelector('.km-reading__reader-card');
    expect(readerCard).toHaveClass('km-citycard', 'km-tone--accent');
  });

  it('reskins the translate sheet onto the shared sheetHead/sheetBody classes, Close button in the head row', async () => {
    readingSvc.listChapters.mockResolvedValue([CHAPTER_ONE]);
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
    const head = sheet.querySelector('.km-review__sheet-head');
    expect(head).toBeInTheDocument();
    expect(
      within(head as HTMLElement).getByRole('button', { name: 'Close' }),
    ).toBeInTheDocument();
    expect(sheet.querySelector('.km-review__sheet-body')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────
// F-210 — story TTS audio + read-along highlighting
// ─────────────────────────────────────────────────────────────

describe('Reading — story TTS audio (F-210)', () => {
  /** Deep-link straight into the story reader (`?story=7`) — the audio
   *  card is a story-reader concern; no need to walk the library. */
  function renderStory(): ReturnType<typeof render> {
    readingSvc.getGeneratedStory.mockResolvedValue(STORY_FULL);
    return render(
      <MemoryRouter initialEntries={['/learn/reading?story=7']}>
        <ToastProvider>
          <Reading />
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  /** Fake-timer helper (the MyAudio.test.tsx GOTCHA applies here too:
   *  `userEvent` deadlocks against `vi.useFakeTimers()` in happy-dom, so
   *  every polling test uses `fireEvent` + `advanceTimersByTimeAsync`). */
  async function flushAsync(ms = 0): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it('an already-voiced story shows the real player on mount — no generate click, no POST', async () => {
    readingSvc.getStoryAudio.mockResolvedValue(AUDIO_DONE);

    const { container } = renderStory();

    await waitFor(() => {
      expect(container.querySelector('audio')).not.toBeNull();
    });
    // The REAL buildAudioSrc resolved the wire streamUrl (empty API base →
    // app-relative src through the allow-list).
    expect(container.querySelector('audio')).toHaveAttribute(
      'src',
      '/audio/tracks/9/stream',
    );
    expect(
      screen.queryByRole('button', { name: /Generate audio/ }),
    ).not.toBeInTheDocument();
    expect(readingSvc.requestStoryAudio).not.toHaveBeenCalled();
  });

  it('renders the voiced body as per-sentence read-along lines with tap-to-define + translate intact', async () => {
    readingSvc.getStoryAudio.mockResolvedValue(AUDIO_DONE);

    const { container } = renderStory();

    await waitFor(() => {
      expect(
        container.querySelectorAll('.km-reading__readalong-line'),
      ).toHaveLength(2);
    });
    const lines = container.querySelectorAll('.km-reading__readalong-line');
    expect(lines[0]!.textContent).toContain('소년은');
    expect(lines[1]!.textContent).toContain('바람이');
    // The per-line translate affordance survives the segment re-render —
    // ariaContext is the SEGMENT number, so the windows and the buttons
    // name the same unit.
    expect(
      screen.getByRole('button', { name: 'Translate sentence 1' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Translate sentence 2' }),
    ).toBeInTheDocument();
  });

  it('highlights the segment whose [startMs, endMs) window contains the playhead, and clears past the end', async () => {
    readingSvc.getStoryAudio.mockResolvedValue(AUDIO_DONE);

    const { container } = renderStory();
    await waitFor(() => {
      expect(container.querySelector('audio')).not.toBeNull();
    });
    const audio = container.querySelector('audio') as HTMLAudioElement;
    const lines = (): NodeListOf<Element> =>
      container.querySelectorAll('.km-reading__readalong-line');

    // 1s → 1000ms sits in segment 1's [0, 4000).
    audio.currentTime = 1;
    fireEvent.timeUpdate(audio);
    expect(lines()[0]).toHaveClass('km-reading__readalong-line--active');
    expect(lines()[0]).toHaveAttribute('aria-current', 'true');
    expect(lines()[1]).not.toHaveClass('km-reading__readalong-line--active');

    // 5s → 5000ms crosses into segment 2's [4000, 8000).
    audio.currentTime = 5;
    fireEvent.timeUpdate(audio);
    expect(lines()[1]).toHaveClass('km-reading__readalong-line--active');
    expect(lines()[0]).not.toHaveClass('km-reading__readalong-line--active');
    expect(lines()[0]).not.toHaveAttribute('aria-current');

    // 9s → past the last window: nothing highlighted (endMs exclusive).
    audio.currentTime = 9;
    fireEvent.timeUpdate(audio);
    expect(
      container.querySelector('.km-reading__readalong-line--active'),
    ).toBeNull();
  });

  it('a voiced track with all-zero timing still plays but skips read-along — paragraph body unchanged', async () => {
    readingSvc.getStoryAudio.mockResolvedValue(AUDIO_DONE_NO_TIMING);

    const { container } = renderStory();

    await waitFor(() => {
      expect(container.querySelector('audio')).not.toBeNull();
    });
    // No segment lines — the pre-F-210 paragraph rendering (and its
    // paragraph-scoped translate buttons) stands.
    expect(
      container.querySelectorAll('.km-reading__readalong-line'),
    ).toHaveLength(0);
    expect(
      screen.getByRole('button', { name: 'Translate paragraph 1' }),
    ).toBeInTheDocument();

    // And a timeupdate can never paint a highlight without windows.
    const audio = container.querySelector('audio') as HTMLAudioElement;
    audio.currentTime = 1;
    fireEvent.timeUpdate(audio);
    expect(
      container.querySelector('.km-reading__readalong-line--active'),
    ).toBeNull();
  });

  it('request → 202 → ~2s polling → done renders the player, then polling STOPS (fake timers)', async () => {
    vi.useFakeTimers();
    readingSvc.getStoryAudio
      .mockResolvedValueOnce(AUDIO_NONE) // mount hydrate
      .mockResolvedValueOnce(AUDIO_PENDING) // poll tick 1
      .mockResolvedValue(AUDIO_DONE); // poll tick 2+
    readingSvc.requestStoryAudio.mockResolvedValue(AUDIO_PENDING);

    const { container } = renderStory();
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: /Generate audio/ }));
    await flushAsync();
    expect(readingSvc.requestStoryAudio).toHaveBeenCalledTimes(1);
    expect(readingSvc.requestStoryAudio.mock.calls[0][0]).toBe(7);
    // 202 landed a pending envelope → busy state replaces the button.
    expect(screen.getByText(/Generating audio/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Generate audio/ }),
    ).not.toBeInTheDocument();

    // Tick 1 (2s): still pending — busy stays, poll count grows.
    await flushAsync(2000);
    expect(readingSvc.getStoryAudio).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Generating audio/)).toBeInTheDocument();

    // Tick 2 (2s): done — the real player mounts with the resolved src.
    await flushAsync(2000);
    expect(container.querySelector('audio')).toHaveAttribute(
      'src',
      '/audio/tracks/9/stream',
    );

    // Settled → the poll stopped itself; no further status fetches.
    await flushAsync(10_000);
    expect(readingSvc.getStoryAudio).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('a pending story resumes polling on mount, and unmount clears the interval — no late fetch', async () => {
    vi.useFakeTimers();
    readingSvc.getStoryAudio.mockResolvedValue(AUDIO_PENDING);

    const { unmount } = renderStory();
    await flushAsync();
    // Hydrate found an in-flight job (requested in an earlier session) —
    // polling engages with no click.
    expect(readingSvc.getStoryAudio).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Generating audio/)).toBeInTheDocument();

    await flushAsync(2000);
    expect(readingSvc.getStoryAudio).toHaveBeenCalledTimes(2);

    unmount();
    await flushAsync(10_000);
    expect(readingSvc.getStoryAudio).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('a failed envelope shows the server-authored error VERBATIM and "Try again" re-POSTs', async () => {
    readingSvc.getStoryAudio.mockResolvedValue(AUDIO_FAILED);
    readingSvc.requestStoryAudio.mockResolvedValue(AUDIO_PENDING);

    const user = userEvent.setup();
    renderStory();

    const alert = await screen.findByRole('alert');
    // The F-210 contract's sanctioned exception: whitelisted server copy,
    // shown untouched.
    expect(alert).toHaveTextContent(
      'The voice service is unavailable right now. Try again later.',
    );

    await user.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => {
      expect(readingSvc.requestStoryAudio).toHaveBeenCalledWith(
        7,
        expect.any(AbortSignal),
      );
    });
    // The 202 pending envelope flips the card to the busy state.
    expect(await screen.findByText(/Generating audio/)).toBeInTheDocument();
  });

  it('the daily-cap 429 (no retryAfter) shows the server message verbatim and keeps the button for tomorrow', async () => {
    readingSvc.requestStoryAudio.mockRejectedValue(
      new ApiError(
        'daily story-audio limit reached: 3 of 3 generations used today. Try again tomorrow.',
        { status: 429, code: 'rate_limited' },
      ),
    );

    const user = userEvent.setup();
    renderStory();

    await user.click(
      await screen.findByRole('button', { name: /Generate audio/ }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'daily story-audio limit reached: 3 of 3 generations used today. Try again tomorrow.',
    );
    // Not a terminal state: the button stays available (the cap resets
    // tomorrow) and is not stuck busy.
    const button = screen.getByRole('button', { name: /Generate audio/ });
    expect(button).not.toHaveAttribute('aria-disabled');
  });

  it('a short-window 429 (structured retryAfter) uses the fixed rate-limit copy — server prose never leaks', async () => {
    readingSvc.requestStoryAudio.mockRejectedValue(
      new ApiError('upstream prose that must never reach the DOM', {
        status: 429,
        code: 'rate_limited',
        retryAfter: 30,
      }),
    );

    const user = userEvent.setup();
    renderStory();

    await user.click(
      await screen.findByRole('button', { name: /Generate audio/ }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/try again in about 30 seconds/i);
    expect(alert).not.toHaveTextContent(/upstream prose/);
  });

  it('a never-settling job stops polling at the 150-tick ceiling — no unbounded fetch churn', async () => {
    vi.useFakeTimers();
    // Every status probe answers pending, forever (a stuck job).
    readingSvc.getStoryAudio.mockResolvedValue(AUDIO_PENDING);

    renderStory();
    await flushAsync();
    expect(readingSvc.getStoryAudio).toHaveBeenCalledTimes(1); // mount hydrate

    // 302s ≈ 151 interval fires: ticks 1..150 each fetch; fire 151 crosses
    // the ceiling and clears the interval WITHOUT fetching.
    await flushAsync(302_000);
    expect(readingSvc.getStoryAudio).toHaveBeenCalledTimes(151); // hydrate + 150

    // Frozen: more time buys no more fetches.
    await flushAsync(20_000);
    expect(readingSvc.getStoryAudio).toHaveBeenCalledTimes(151);
    // The last known status stays on screen (bounded churn, honest UI).
    expect(screen.getByText(/Generating audio/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('a mid-poll 404 (story deleted) is TERMINAL — polling stops immediately, no further fetches', async () => {
    vi.useFakeTimers();
    readingSvc.getStoryAudio
      .mockResolvedValueOnce(AUDIO_PENDING) // mount hydrate → polling engages
      .mockRejectedValueOnce(
        new ApiError('story not found', { status: 404, code: 'not_found' }),
      );

    renderStory();
    await flushAsync();
    expect(readingSvc.getStoryAudio).toHaveBeenCalledTimes(1);

    // Tick 1 (2s) hits the 404 → the interval clears itself.
    await flushAsync(2000);
    expect(readingSvc.getStoryAudio).toHaveBeenCalledTimes(2);

    // Dead: later ticks never fire a fetch against a route that can only
    // 404 again.
    await flushAsync(10_000);
    expect(readingSvc.getStoryAudio).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("a playback error on the <audio> element shows the \"couldn't load\" alert beside the player", async () => {
    readingSvc.getStoryAudio.mockResolvedValue(AUDIO_DONE);

    const { container } = renderStory();
    await waitFor(() => {
      expect(container.querySelector('audio')).not.toBeNull();
    });

    // The F-160 device: the element fetched its src and the bytes failed.
    fireEvent.error(container.querySelector('audio') as HTMLAudioElement);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Audio couldn't load/);
    // The player stays mounted (a retry/seek can still succeed).
    expect(container.querySelector('audio')).not.toBeNull();
  });

  it('ttsConfigured:false hides the ENTIRE audio card — no button, no dead affordance', async () => {
    readingSvc.getStoryAudio.mockResolvedValue(AUDIO_NONE_UNCONFIGURED);

    const { container } = renderStory();

    // The reader body renders as usual…
    expect(
      await screen.findByRole('button', { name: /Mark story as finished/i }),
    ).toBeInTheDocument();
    // …and once the hydrate envelope has landed, the audio card is ABSENT.
    await waitFor(() => {
      expect(readingSvc.getStoryAudio).toHaveBeenCalledTimes(1);
    });
    await act(async () => {}); // flush the envelope's setState
    expect(container.querySelector('.km-reading__audio')).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Generate audio/ }),
    ).not.toBeInTheDocument();
  });

  it('a MISSING ttsConfigured flag (older server) keeps the button — forward-compat default-true', async () => {
    // AUDIO_NONE deliberately omits the flag.
    readingSvc.getStoryAudio.mockResolvedValue(AUDIO_NONE);

    renderStory();

    expect(
      await screen.findByRole('button', { name: /Generate audio/ }),
    ).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────
// F-211 — story illustrations (request / poll / gallery)
// ─────────────────────────────────────────────────────────────

describe('Reading — story illustrations (F-211)', () => {
  /** Deep-link straight into the story reader (`?story=7`) — the
   *  illustration surface is a story-reader concern. */
  function renderStory(): ReturnType<typeof render> {
    readingSvc.getGeneratedStory.mockResolvedValue(STORY_FULL);
    return render(
      <MemoryRouter initialEntries={['/learn/reading?story=7']}>
        <ToastProvider>
          <Reading />
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  /** Fake-timer helper (the F-210 GOTCHA applies unchanged: `userEvent`
   *  deadlocks against `vi.useFakeTimers()` in happy-dom, so every polling
   *  test uses `fireEvent` + `advanceTimersByTimeAsync`). */
  async function flushAsync(ms = 0): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  // DOM-shape change (webtoon-scroll redesign): the reader no longer
  // renders the `.km-reading__images-item` gallery grid for a `done`
  // envelope (StoryIllustrations is passed `galleryWhenReady={false}`
  // there) — it interleaves the same done images as `.km-reading__panel`
  // figures between paragraphs instead. The gallery grid itself is
  // untouched and still covered by Ttmik.test.tsx (the Listen-tab created
  // -story card, which doesn't pass that prop).
  const panelImgs = (container: HTMLElement): HTMLImageElement[] =>
    Array.from(
      container.querySelectorAll<HTMLImageElement>('.km-reading__panel img'),
    );

  it('an already-illustrated story shows inline webtoon panels on mount — allow-listed srcs, lazy, generic alt, no POST, no double-rendered gallery', async () => {
    readingSvc.getStoryImages.mockResolvedValue(IMAGES_DONE);

    const { container } = renderStory();

    await waitFor(() => {
      expect(panelImgs(container)).toHaveLength(3);
    });
    const imgs = panelImgs(container);
    // The REAL buildStoryImageSrc resolved each wire blobUrl (empty API
    // base → app-relative src through the allow-list), in ordinal order.
    expect(imgs.map((img) => img.getAttribute('src'))).toEqual([
      '/reading/generated/7/image/1/blob',
      '/reading/generated/7/image/2/blob',
      '/reading/generated/7/image/3/blob',
    ]);
    // Generic ordinal alt + lazy loading + reserved dimensions on every one.
    imgs.forEach((img, i) => {
      expect(img).toHaveAttribute('alt', `Story illustration ${String(i + 1)}`);
      expect(img).toHaveAttribute('loading', 'lazy');
      expect(img).toHaveAttribute('width', '1024');
      expect(img).toHaveAttribute('height', '1024');
    });
    // The English generation scaffolding must never reach the DOM.
    expect(container.innerHTML).not.toContain('SCAFFOLD-PROMPT');
    // Already done → no affordance, no on-demand POST.
    expect(
      screen.queryByRole('button', { name: /Generate illustrations/ }),
    ).not.toBeInTheDocument();
    expect(readingSvc.requestStoryImages).not.toHaveBeenCalled();
    // `galleryWhenReady={false}` suppression: the gallery grid itself must
    // NOT also be in the tree — every done image renders exactly once
    // (inline), never twice.
    expect(container.querySelector('.km-reading__images')).toBeNull();
    expect(
      container.querySelectorAll('.km-reading__images-item'),
    ).toHaveLength(0);
  });

  it('interleaves panels between paragraphs at the computed beats (P<N fixture: 2 paragraphs, 3 images) instead of one block above the prose', async () => {
    readingSvc.getStoryImages.mockResolvedValue(IMAGES_DONE);

    const { container } = renderStory();
    await waitFor(() => {
      expect(panelImgs(container)).toHaveLength(3);
    });

    // `computePanelSlots(2, 3)` → [[0, 1], [2]]: paragraph 1 is followed by
    // images 1+2, paragraph 2 (the last) by image 3 — text always comes
    // first, and nothing sits above the whole prose card as one gallery
    // block anymore.
    const card = container.querySelector('.km-reading__reader-card');
    expect(card).not.toBeNull();
    // Filter to just the passage/panel children — `rail` also renders a
    // leading DancheongRail decoration as a CityCard child, irrelevant to
    // the text/panel interleave under test.
    const shape = Array.from(card!.children)
      .filter(
        (el) =>
          el.classList.contains('km-reading__passage') ||
          el.classList.contains('km-reading__panel'),
      )
      .map((el) =>
        el.classList.contains('km-reading__passage') ? 'text' : 'panel',
      );
    expect(shape).toEqual(['text', 'panel', 'panel', 'text', 'panel']);
  });

  it('a tampered/off-origin blobUrl dies at the allow-list — only the valid scene renders an <img>', async () => {
    readingSvc.getStoryImages.mockResolvedValue(IMAGES_DONE_TAMPERED);

    const { container } = renderStory();

    // The valid middle image survives…
    await waitFor(() => {
      expect(panelImgs(container)).toHaveLength(1);
    });
    expect(panelImgs(container)[0]).toHaveAttribute(
      'src',
      '/reading/generated/7/image/2/blob',
    );
    // …and the tampered values appear NOWHERE in the DOM.
    expect(container.innerHTML).not.toContain('evil.example');
    expect(container.innerHTML).not.toContain('/uploads/9/file');
  });

  it('imageGenConfigured:false renders NO illustration UI at all — even for a done envelope', async () => {
    readingSvc.getStoryImages.mockResolvedValue(IMAGES_DONE_UNCONFIGURED);

    const { container, unmount } = renderStory();

    // The reader body renders as usual…
    expect(
      await screen.findByRole('button', { name: /Mark story as finished/i }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(readingSvc.getStoryImages).toHaveBeenCalledTimes(1);
    });
    await act(async () => {}); // flush the envelope's setState
    // …and the ENTIRE surface is absent: no gallery, no imgs, no button.
    expect(container.querySelector('.km-reading__images')).toBeNull();
    expect(panelImgs(container)).toHaveLength(0);
    expect(
      screen.queryByRole('button', { name: /Generate illustrations/ }),
    ).not.toBeInTheDocument();

    // Same dormancy for a 'none' envelope: no dead affordance.
    unmount();
    readingSvc.getStoryImages.mockResolvedValue(IMAGES_NONE_UNCONFIGURED);
    const second = renderStory();
    expect(
      await second.findByRole('button', { name: /Mark story as finished/i }),
    ).toBeInTheDocument();
    await act(async () => {});
    expect(second.container.querySelector('.km-reading__images')).toBeNull();
    expect(
      second.queryByRole('button', { name: /Generate illustrations/ }),
    ).not.toBeInTheDocument();
    expect(second.container.querySelector('.km-reading__images-request')).toBeNull();
  });

  it('a MISSING imageGenConfigured flag keeps the button — forward-compat default-true', async () => {
    readingSvc.getStoryImages.mockResolvedValue(IMAGES_NONE_NO_FLAG);

    renderStory();

    expect(
      await screen.findByRole('button', { name: /Generate illustrations/ }),
    ).toBeInTheDocument();
  });

  it('request → 202 → ~2.5s polling → done renders the gallery, then polling STOPS (fake timers)', async () => {
    vi.useFakeTimers();
    readingSvc.getStoryImages
      .mockResolvedValueOnce(IMAGES_NONE) // mount hydrate
      .mockResolvedValueOnce(IMAGES_PENDING) // poll tick 1
      .mockResolvedValue(IMAGES_DONE); // poll tick 2+
    readingSvc.requestStoryImages.mockResolvedValue(IMAGES_PENDING);

    const { container } = renderStory();
    await flushAsync();

    fireEvent.click(
      screen.getByRole('button', { name: /Generate illustrations/ }),
    );
    await flushAsync();
    expect(readingSvc.requestStoryImages).toHaveBeenCalledTimes(1);
    expect(readingSvc.requestStoryImages.mock.calls[0][0]).toBe(7);
    // 202 landed a pending envelope → the busy status replaces the button.
    expect(screen.getByText(/Illustrating/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Generate illustrations/ }),
    ).not.toBeInTheDocument();

    // Tick 1 (2.5s): still pending — busy stays, poll count grows.
    await flushAsync(2500);
    expect(readingSvc.getStoryImages).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Illustrating/)).toBeInTheDocument();

    // Tick 2 (2.5s): done — the gallery mounts with resolved srcs.
    await flushAsync(2500);
    expect(panelImgs(container)).toHaveLength(3);
    expect(panelImgs(container)[0]).toHaveAttribute(
      'src',
      '/reading/generated/7/image/1/blob',
    );

    // Settled → the poll stopped itself; no further status fetches.
    await flushAsync(12_500);
    expect(readingSvc.getStoryImages).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('a fresh batch-at-create story resumes polling on mount, and unmount clears the interval — no late fetch', async () => {
    vi.useFakeTimers();
    readingSvc.getStoryImages.mockResolvedValue(IMAGES_PENDING);

    const { unmount } = renderStory();
    await flushAsync();
    // Hydrate found the auto-enqueued batch job — polling engages with no
    // click, behind the "Illustrating…" status.
    expect(readingSvc.getStoryImages).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Illustrating/)).toBeInTheDocument();

    await flushAsync(2500);
    expect(readingSvc.getStoryImages).toHaveBeenCalledTimes(2);

    unmount();
    await flushAsync(12_500);
    expect(readingSvc.getStoryImages).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('a failed envelope shows the server-authored error VERBATIM and "Try again" re-POSTs', async () => {
    readingSvc.getStoryImages.mockResolvedValue(IMAGES_FAILED);
    readingSvc.requestStoryImages.mockResolvedValue(IMAGES_PENDING);

    const user = userEvent.setup();
    renderStory();

    const alert = await screen.findByRole('alert');
    // Server-authored whitelisted copy, shown untouched (the F-210
    // sanctioned exception, extended to F-211).
    expect(alert).toHaveTextContent(
      'The image service is unavailable right now. Try again later.',
    );

    await user.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => {
      expect(readingSvc.requestStoryImages).toHaveBeenCalledWith(
        7,
        expect.any(AbortSignal),
      );
    });
    // The 202 pending envelope flips the surface to the busy state.
    expect(await screen.findByText(/Illustrating/)).toBeInTheDocument();
  });

  it('the daily-cap 429 (no retryAfter) shows the server message verbatim and keeps the button', async () => {
    readingSvc.requestStoryImages.mockRejectedValue(
      new ApiError(
        'daily story-image limit reached: 2 of 2 batches used today. Try again tomorrow.',
        { status: 429, code: 'rate_limited' },
      ),
    );

    const user = userEvent.setup();
    renderStory();

    await user.click(
      await screen.findByRole('button', { name: /Generate illustrations/ }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'daily story-image limit reached: 2 of 2 batches used today. Try again tomorrow.',
    );
    // Not a terminal state: the button stays available (the cap resets
    // tomorrow) and is not stuck busy.
    const button = screen.getByRole('button', {
      name: /Generate illustrations/,
    });
    expect(button).not.toHaveAttribute('aria-disabled');
  });

  it('a short-window 429 (structured retryAfter) uses the fixed rate-limit copy — server prose never leaks', async () => {
    readingSvc.requestStoryImages.mockRejectedValue(
      new ApiError('upstream prose that must never reach the DOM', {
        status: 429,
        code: 'rate_limited',
        retryAfter: 30,
      }),
    );

    const user = userEvent.setup();
    renderStory();

    await user.click(
      await screen.findByRole('button', { name: /Generate illustrations/ }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/try again in about 30 seconds/i);
    expect(alert).not.toHaveTextContent(/upstream prose/);
  });

  it('a per-image load error hides JUST that image — no broken-image frame, siblings untouched', async () => {
    readingSvc.getStoryImages.mockResolvedValue(IMAGES_DONE);

    const { container } = renderStory();
    await waitFor(() => {
      expect(panelImgs(container)).toHaveLength(3);
    });

    // The first scene's bytes fail (deleted blob / decode error).
    fireEvent.error(panelImgs(container)[0]!);

    await waitFor(() => {
      expect(panelImgs(container)).toHaveLength(2);
    });
    // The survivors keep their own srcs — absence, not reshuffling.
    expect(panelImgs(container).map((img) => img.getAttribute('src'))).toEqual([
      '/reading/generated/7/image/2/blob',
      '/reading/generated/7/image/3/blob',
    ]);
    // A load failure is cosmetic degradation, not an announced error.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a never-settling job stops polling at the 120-tick ceiling — no unbounded fetch churn', async () => {
    vi.useFakeTimers();
    // Every status probe answers pending, forever (a stuck job).
    readingSvc.getStoryImages.mockResolvedValue(IMAGES_PENDING);

    renderStory();
    await flushAsync();
    expect(readingSvc.getStoryImages).toHaveBeenCalledTimes(1); // mount hydrate

    // 302.5s ≈ 121 interval fires: ticks 1..120 each fetch; fire 121
    // crosses the ceiling and clears the interval WITHOUT fetching.
    await flushAsync(302_500);
    expect(readingSvc.getStoryImages).toHaveBeenCalledTimes(121); // hydrate + 120

    // Frozen: more time buys no more fetches.
    await flushAsync(25_000);
    expect(readingSvc.getStoryImages).toHaveBeenCalledTimes(121);
    // The last known status stays on screen (bounded churn, honest UI).
    expect(screen.getByText(/Illustrating/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('does not disturb the F-210 audio card or the story body — gallery, player, and passages coexist', async () => {
    readingSvc.getStoryImages.mockResolvedValue(IMAGES_DONE);
    readingSvc.getStoryAudio.mockResolvedValue(AUDIO_DONE);

    const { container } = renderStory();

    // Gallery AND the real audio player, side by side.
    await waitFor(() => {
      expect(panelImgs(container)).toHaveLength(3);
    });
    await waitFor(() => {
      expect(container.querySelector('audio')).not.toBeNull();
    });
    expect(container.querySelector('audio')).toHaveAttribute(
      'src',
      '/audio/tracks/9/stream',
    );
    // The voiced read-along body (and its tap/translate affordances) stands.
    expect(
      container.querySelectorAll('.km-reading__readalong-line'),
    ).toHaveLength(2);
    expect(
      screen.getByRole('button', { name: 'Translate sentence 1' }),
    ).toBeInTheDocument();
    // And the F-172 completion affordance survives below everything.
    expect(
      screen.getByRole('button', { name: /Mark story as finished/i }),
    ).toBeInTheDocument();
  });

  it('with no audio voiced, the plain paragraph body + "Generate audio" button render alongside the gallery (regression pin)', async () => {
    readingSvc.getStoryImages.mockResolvedValue(IMAGES_DONE);
    // AUDIO_NONE default from beforeEach — stated here for clarity.
    readingSvc.getStoryAudio.mockResolvedValue(AUDIO_NONE);

    const { container } = renderStory();

    await waitFor(() => {
      expect(panelImgs(container)).toHaveLength(3);
    });
    // The pre-F-211 story surface is untouched: paragraphs, translate,
    // audio affordance.
    expect(
      screen.getByRole('button', { name: 'Translate paragraph 1' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Translate paragraph 2' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Generate audio/ }),
    ).toBeInTheDocument();
  });

  it('N===0 (no done images yet): pure text, no panels anywhere in the prose', async () => {
    // IMAGES_NONE (beforeEach default) — no batch, no done images at all.
    const { container } = renderStory();

    await screen.findByRole('button', { name: /Generate illustrations/ });
    expect(container.querySelectorAll('.km-reading__panel')).toHaveLength(0);
    // The paragraphs still render normally either side of the (empty)
    // interleave.
    expect(
      screen.getByRole('button', { name: 'Translate paragraph 1' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Translate paragraph 2' }),
    ).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────
// F-216 — unified story experience (library badges + one-tap button)
// ─────────────────────────────────────────────────────────────

describe('Reading — unified story experience (F-216)', () => {
  /** Deep-link straight into the story reader (`?story=7`) — the combined
   *  button is a story-reader concern (the F-210/F-211 helper, verbatim). */
  function renderStory(): ReturnType<typeof render> {
    readingSvc.getGeneratedStory.mockResolvedValue(STORY_FULL);
    return render(
      <MemoryRouter initialEntries={['/learn/reading?story=7']}>
        <ToastProvider>
          <Reading />
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  /** Fake-timer helper (the F-210 GOTCHA applies unchanged: `userEvent`
   *  deadlocks against `vi.useFakeTimers()` in happy-dom, so polling tests
   *  use `fireEvent` + `advanceTimersByTimeAsync`). */
  async function flushAsync(ms = 0): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  /** Open the stories tab from the root (library-badge tests). */
  async function openStoriesTab(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<void> {
    await user.click(await screen.findByRole('tab', { name: /AI stories/ }));
  }

  // Three rows spanning every pip color: done=moss, pending|running=ochre,
  // failed=danger, none=muted.
  const ROW_A: GeneratedStorySummary = {
    ...STORY_SUMMARY,
    audioStatus: 'done',
    imageStatus: 'failed',
  };
  const ROW_B: GeneratedStorySummary = {
    ...STORY_SUMMARY,
    id: 8,
    title: '겨울 산책',
    audioStatus: 'running',
    imageStatus: 'none',
  };
  const ROW_C: GeneratedStorySummary = {
    ...STORY_SUMMARY,
    id: 9,
    title: '눈 오는 밤',
    audioStatus: 'pending',
    imageStatus: 'done',
  };

  it('renders per-row audio + image pips inside the row button, colored by aggregate status, with plain-language labels', async () => {
    readingSvc.listGeneratedStories.mockResolvedValue({
      stories: [ROW_A, ROW_B, ROW_C],
      ttsConfigured: true,
      imageGenConfigured: true,
    });

    const user = userEvent.setup();
    renderReading();
    await openStoriesTab(user);

    // The pips live INSIDE each row's open button — the existing
    // title/level/date layout (and the button's aria-label) is untouched.
    const rowA = await screen.findByRole('button', {
      name: /Open 바닷가 마을/,
    });
    const rowB = screen.getByRole('button', { name: /Open 겨울 산책/ });
    const rowC = screen.getByRole('button', { name: /Open 눈 오는 밤/ });

    const pip = (row: HTMLElement, label: string): HTMLElement =>
      within(row).getByLabelText(label);

    // done → moss (green), failed → danger (red).
    expect(pip(rowA, 'audio: done').getAttribute('style')).toContain(
      'var(--moss)',
    );
    expect(pip(rowA, 'image: failed').getAttribute('style')).toContain(
      'var(--danger)',
    );
    // running AND pending → ochre-ink (amber); none → paper-mute (muted).
    expect(pip(rowB, 'audio: running').getAttribute('style')).toContain(
      'var(--ochre-ink)',
    );
    expect(pip(rowB, 'image: none').getAttribute('style')).toContain(
      'var(--paper-mute)',
    );
    expect(pip(rowC, 'audio: pending').getAttribute('style')).toContain(
      'var(--ochre-ink)',
    );
    expect(pip(rowC, 'image: done').getAttribute('style')).toContain(
      'var(--moss)',
    );
    // Level pill and date survive alongside the pips.
    expect(within(rowA).getByText('L3')).toBeInTheDocument();
    expect(within(rowA).getByText('Jul 8')).toBeInTheDocument();
  });

  it('ttsConfigured:false hides every audio pip; imageGenConfigured:false hides every image pip', async () => {
    readingSvc.listGeneratedStories.mockResolvedValue({
      stories: [ROW_A],
      ttsConfigured: false,
      imageGenConfigured: true,
    });

    const user = userEvent.setup();
    const first = renderReading();
    await openStoriesTab(user);

    const rowA = await screen.findByRole('button', {
      name: /Open 바닷가 마을/,
    });
    expect(within(rowA).queryByLabelText(/^audio:/)).not.toBeInTheDocument();
    expect(within(rowA).getByLabelText('image: failed')).toBeInTheDocument();

    // Mirror: the image capability dormant instead.
    first.unmount();
    readingSvc.listGeneratedStories.mockResolvedValue({
      stories: [ROW_A],
      ttsConfigured: true,
      imageGenConfigured: false,
    });
    renderReading();
    await openStoriesTab(user);
    const rowA2 = await screen.findByRole('button', {
      name: /Open 바닷가 마을/,
    });
    expect(within(rowA2).getByLabelText('audio: done')).toBeInTheDocument();
    expect(within(rowA2).queryByLabelText(/^image:/)).not.toBeInTheDocument();
  });

  it('MISSING capability flags keep both pips — forward-compat default-shown', async () => {
    readingSvc.listGeneratedStories.mockResolvedValue({ stories: [ROW_A] });

    const user = userEvent.setup();
    renderReading();
    await openStoriesTab(user);

    const rowA = await screen.findByRole('button', {
      name: /Open 바닷가 마을/,
    });
    expect(within(rowA).getByLabelText('audio: done')).toBeInTheDocument();
    expect(within(rowA).getByLabelText('image: failed')).toBeInTheDocument();
  });

  // #45 fix-pass (client review SF-3): the owner's own list had no way to
  // tell a published story apart from a private one.
  it("a published story's row shows a 'Published' badge; a private row shows none", async () => {
    const publishedRow: GeneratedStorySummary = { ...ROW_A, isShared: true };
    const privateRow: GeneratedStorySummary = { ...ROW_B, isShared: false };
    readingSvc.listGeneratedStories.mockResolvedValue({
      stories: [publishedRow, privateRow],
    });

    const user = userEvent.setup();
    renderReading();
    await openStoriesTab(user);

    const publishedRowEl = await screen.findByRole('button', {
      name: /Open 바닷가 마을/,
    });
    const privateRowEl = screen.getByRole('button', { name: /Open 겨울 산책/ });

    expect(within(publishedRowEl).getByText('Published')).toBeInTheDocument();
    expect(within(privateRowEl).queryByText('Published')).not.toBeInTheDocument();
  });

  it('one tap → POST /experience → BOTH halves seed their polls → both settle → player + gallery, polls stop', async () => {
    vi.useFakeTimers();
    readingSvc.getStoryAudio
      .mockResolvedValueOnce(AUDIO_NONE) // mount hydrate
      .mockResolvedValue(AUDIO_DONE); // poll ticks
    readingSvc.getStoryImages
      .mockResolvedValueOnce(IMAGES_NONE) // mount hydrate
      .mockResolvedValue(IMAGES_DONE); // poll ticks
    readingSvc.requestStoryExperience.mockResolvedValue({
      audio: { ...AUDIO_PENDING, enqueueBlocked: null },
      images: { ...IMAGES_PENDING, enqueueBlocked: null },
    });

    const { container } = renderStory();
    await flushAsync();

    // Both per-asset affordances AND the combined button coexist (additive).
    expect(
      screen.getByRole('button', { name: /Generate audio/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Generate illustrations/ }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /Generate full experience/ }),
    );
    await flushAsync();
    expect(readingSvc.requestStoryExperience).toHaveBeenCalledTimes(1);
    expect(readingSvc.requestStoryExperience.mock.calls[0][0]).toBe(7);
    // Neither dedicated POST fired — ONE request covers both halves.
    expect(readingSvc.requestStoryAudio).not.toHaveBeenCalled();
    expect(readingSvc.requestStoryImages).not.toHaveBeenCalled();
    // Both seeded envelopes land pending → both busy states, at once.
    expect(screen.getByText(/Generating audio/)).toBeInTheDocument();
    expect(screen.getByText(/Illustrating/)).toBeInTheDocument();

    // Audio poll tick (2s): settles done → the real player mounts.
    await flushAsync(2000);
    expect(readingSvc.getStoryAudio).toHaveBeenCalledTimes(2);
    expect(container.querySelector('audio')).toHaveAttribute(
      'src',
      '/audio/tracks/9/stream',
    );

    // Images poll tick (2.5s): settles done → the inline webtoon panels
    // mount (DOM-shape change: the reader interleaves done images between
    // paragraphs rather than a gallery grid — see `panelImgs` above).
    await flushAsync(500);
    expect(readingSvc.getStoryImages).toHaveBeenCalledTimes(2);
    expect(
      container.querySelectorAll('.km-reading__panel img'),
    ).toHaveLength(3);

    // Both settled → both polls stopped themselves; and with both halves
    // done, the combined button is gone.
    await flushAsync(12_500);
    expect(readingSvc.getStoryAudio).toHaveBeenCalledTimes(2);
    expect(readingSvc.getStoryImages).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole('button', { name: /Generate full experience/ }),
    ).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('the in-flight guard holds: aria-disabled while requesting, a second click never double-POSTs', async () => {
    readingSvc.requestStoryExperience.mockImplementation(
      () =>
        new Promise(() => {
          /* never settles — pins the in-flight state */
        }),
    );

    renderStory();
    const button = await screen.findByRole('button', {
      name: /Generate full experience/,
    });

    fireEvent.click(button);
    const busy = await screen.findByRole('button', { name: /Requesting/ });
    expect(busy).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(busy);
    expect(readingSvc.requestStoryExperience).toHaveBeenCalledTimes(1);
  });

  it('hidden when both halves are already done — nothing left to generate', async () => {
    readingSvc.getStoryAudio.mockResolvedValue(AUDIO_DONE);
    readingSvc.getStoryImages.mockResolvedValue(IMAGES_DONE);

    const { container } = renderStory();

    await waitFor(() => {
      expect(container.querySelector('audio')).not.toBeNull();
    });
    await waitFor(() => {
      // DOM-shape change: inline webtoon panels, not the gallery grid.
      expect(
        container.querySelectorAll('.km-reading__panel img'),
      ).toHaveLength(3);
    });
    expect(
      screen.queryByRole('button', { name: /Generate full experience/ }),
    ).not.toBeInTheDocument();
  });

  it('hidden when BOTH capabilities are dormant — no dead affordance', async () => {
    readingSvc.getStoryAudio.mockResolvedValue(AUDIO_NONE_UNCONFIGURED);
    readingSvc.getStoryImages.mockResolvedValue(IMAGES_NONE_UNCONFIGURED);

    renderStory();

    expect(
      await screen.findByRole('button', { name: /Mark story as finished/i }),
    ).toBeInTheDocument();
    await act(async () => {}); // flush both hydrate envelopes' setState
    expect(
      screen.queryByRole('button', { name: /Generate full experience/ }),
    ).not.toBeInTheDocument();
  });

  it('shown when exactly one half is missing (audio done, images none) — alongside that half’s own button', async () => {
    readingSvc.getStoryAudio.mockResolvedValue(AUDIO_DONE);
    readingSvc.getStoryImages.mockResolvedValue(IMAGES_NONE);

    renderStory();

    expect(
      await screen.findByRole('button', { name: /Generate full experience/ }),
    ).toBeInTheDocument();
    // The per-asset path stays available too (additive, never replaced).
    expect(
      screen.getByRole('button', { name: /Generate illustrations/ }),
    ).toBeInTheDocument();
  });

  it('a daily-capped audio half shows the inline cap notice; the images half still enqueues and polls', async () => {
    vi.useFakeTimers();
    readingSvc.getStoryAudio.mockResolvedValue(AUDIO_NONE);
    readingSvc.getStoryImages
      .mockResolvedValueOnce(IMAGES_NONE)
      .mockResolvedValue(IMAGES_DONE);
    readingSvc.requestStoryExperience.mockResolvedValue({
      audio: { ...AUDIO_NONE, enqueueBlocked: 'daily_cap' },
      images: { ...IMAGES_PENDING, enqueueBlocked: null },
    });

    renderStory();
    await flushAsync();

    fireEvent.click(
      screen.getByRole('button', { name: /Generate full experience/ }),
    );
    await flushAsync();

    // The capped half: inline fixed copy, and its own button survives (the
    // cap resets tomorrow — not a terminal state).
    expect(
      screen.getByText('Audio: daily limit reached — try tomorrow.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Generate audio/ }),
    ).toBeInTheDocument();
    // The other half was seeded pending regardless — its poll runs.
    expect(screen.getByText(/Illustrating/)).toBeInTheDocument();
    await flushAsync(2500);
    expect(readingSvc.getStoryImages).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('a dormant audio half is silently omitted (card hides, NO notice); the images half proceeds', async () => {
    vi.useFakeTimers();
    readingSvc.getStoryAudio.mockResolvedValue(AUDIO_NONE);
    readingSvc.getStoryImages.mockResolvedValue(IMAGES_NONE);
    readingSvc.requestStoryExperience.mockResolvedValue({
      audio: { ...AUDIO_NONE_UNCONFIGURED, enqueueBlocked: 'dormant' },
      images: { ...IMAGES_PENDING, enqueueBlocked: null },
    });

    const { container } = renderStory();
    await flushAsync();

    fireEvent.click(
      screen.getByRole('button', { name: /Generate full experience/ }),
    );
    await flushAsync();

    // The seeded dormant envelope hides the whole audio card — absence,
    // and no cap/dormancy prose anywhere.
    expect(container.querySelector('.km-reading__audio')).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Generate audio/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/daily limit reached/)).not.toBeInTheDocument();
    // The images half runs regardless of its dormant sibling.
    expect(screen.getByText(/Illustrating/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('a whole-call short-window 429 renders the fixed structured copy — server prose never leaks', async () => {
    readingSvc.requestStoryExperience.mockRejectedValue(
      new ApiError('upstream prose that must never reach the DOM', {
        status: 429,
        code: 'rate_limited',
        retryAfter: 30,
      }),
    );

    const user = userEvent.setup();
    renderStory();

    await user.click(
      await screen.findByRole('button', { name: /Generate full experience/ }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/try again in about 30 seconds/i);
    expect(alert).not.toHaveTextContent(/upstream prose/);
    // The button recovers as the retry (expensive-route posture).
    expect(
      screen.getByRole('button', { name: /Generate full experience/ }),
    ).not.toHaveAttribute('aria-disabled');
  });
});

describe('Reading — public library (F-45)', () => {
  const LIBRARY_ROW: LibraryStorySummary = {
    id: 20,
    title: '공개된 이야기',
    level: 'L3',
    prompt: null,
    createdAt: '2026-08-10T00:00:00Z',
    audioStatus: 'done',
    imageStatus: 'none',
  };

  /** Switch to the Library tab from the root. */
  async function openLibraryTab(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<void> {
    await user.click(await screen.findByRole('tab', { name: /Library/ }));
  }

  function renderStoryDirect(story: GeneratedStory): ReturnType<typeof render> {
    readingSvc.getGeneratedStory.mockResolvedValue(story);
    return render(
      <MemoryRouter initialEntries={[`/learn/reading?story=${story.id}`]}>
        <ToastProvider>
          <Reading />
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  it('lists published stories on the Library tab (no owner-identifying text — the DTO carries none)', async () => {
    readingSvc.listLibrary.mockResolvedValue([LIBRARY_ROW]);

    const user = userEvent.setup();
    renderReading();
    await openLibraryTab(user);

    await waitFor(() => {
      expect(readingSvc.listLibrary).toHaveBeenCalled();
    });
    expect(
      await screen.findByRole('button', { name: /Open 공개된 이야기/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Save to my library/ }),
    ).toBeInTheDocument();
  });

  it('shows the empty-library copy when nothing has been published yet', async () => {
    readingSvc.listLibrary.mockResolvedValue([]);

    const user = userEvent.setup();
    renderReading();
    await openLibraryTab(user);

    expect(
      await screen.findByText(/no stories have been published yet/i),
    ).toBeInTheDocument();
  });

  it('shows an error card with a working retry when the library fetch fails', async () => {
    readingSvc.listLibrary
      .mockRejectedValueOnce(new ApiError('boom', { status: 500, code: 'server_error' }))
      .mockResolvedValueOnce([LIBRARY_ROW]);

    const user = userEvent.setup();
    renderReading();
    await openLibraryTab(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load the public library/i);
    expect(alert).not.toHaveTextContent(/boom/);

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(
      await screen.findByRole('button', { name: /Open 공개된 이야기/ }),
    ).toBeInTheDocument();
  });

  it('opening a library row reads the widened GET /generated/:id (same as any story)', async () => {
    readingSvc.listLibrary.mockResolvedValue([LIBRARY_ROW]);
    readingSvc.getGeneratedStory.mockResolvedValue({
      ...STORY_FULL,
      id: LIBRARY_ROW.id,
      title: LIBRARY_ROW.title,
      isOwn: false,
      isShared: true,
    });

    const user = userEvent.setup();
    renderReading();
    await openLibraryTab(user);

    await user.click(
      await screen.findByRole('button', { name: /Open 공개된 이야기/ }),
    );

    await waitFor(() => {
      expect(readingSvc.getGeneratedStory).toHaveBeenCalledWith(
        LIBRARY_ROW.id,
        expect.anything(),
      );
    });
    expect(await screen.findByText('공개된 이야기')).toBeInTheDocument();
  });

  it('"Save to my library" clones the story and navigates straight into the new copy', async () => {
    readingSvc.listLibrary.mockResolvedValue([LIBRARY_ROW]);
    const clone: GeneratedStory = {
      ...STORY_FULL,
      id: 99,
      title: '내 서재의 사본',
      isOwn: true,
      isShared: false,
    };
    readingSvc.cloneStory.mockResolvedValue(clone);
    readingSvc.getGeneratedStory.mockResolvedValue(clone);

    const user = userEvent.setup();
    renderReading();
    await openLibraryTab(user);

    await user.click(
      screen.getByRole('button', { name: /Save to my library/ }),
    );

    await waitFor(() => {
      expect(readingSvc.cloneStory).toHaveBeenCalledWith(
        LIBRARY_ROW.id,
        expect.anything(),
      );
    });
    // Landed on the CLONE's reader, not the source's.
    await waitFor(() => {
      expect(readingSvc.getGeneratedStory).toHaveBeenCalledWith(
        clone.id,
        expect.anything(),
      );
    });
    expect(await screen.findByText('내 서재의 사본')).toBeInTheDocument();
  });

  it("a surfaced clone failure shows fixed alert copy — no server prose leak", async () => {
    readingSvc.listLibrary.mockResolvedValue([LIBRARY_ROW]);
    readingSvc.cloneStory.mockRejectedValue(
      new ApiError('upstream boom', { status: 502, code: 'upstream_error' }),
    );

    const user = userEvent.setup();
    renderReading();
    await openLibraryTab(user);

    await user.click(
      screen.getByRole('button', { name: /Save to my library/ }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not save this story/i);
    expect(alert).not.toHaveTextContent(/upstream boom/);
  });

  it("the OWNER of a private story sees a 'Publish to library' control, not a clone action", async () => {
    renderStoryDirect({ ...STORY_FULL, isOwn: true, isShared: false });

    expect(
      await screen.findByRole('button', { name: /Publish to library/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Save to my library/ }),
    ).not.toBeInTheDocument();
  });

  it('publishing flips the control to Unpublish and persists the server response', async () => {
    const published: GeneratedStory = { ...STORY_FULL, isOwn: true, isShared: true };
    readingSvc.publishStory.mockResolvedValue(published);
    renderStoryDirect({ ...STORY_FULL, isOwn: true, isShared: false });

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: /Publish to library/ }),
    );

    await waitFor(() => {
      expect(readingSvc.publishStory).toHaveBeenCalledWith(
        STORY_FULL.id,
        expect.anything(),
      );
    });
    expect(
      await screen.findByRole('button', { name: /Unpublish/ }),
    ).toBeInTheDocument();
  });

  it('unpublishing flips the control back to Publish', async () => {
    const unpublished: GeneratedStory = { ...STORY_FULL, isOwn: true, isShared: false };
    readingSvc.unpublishStory.mockResolvedValue(unpublished);
    renderStoryDirect({ ...STORY_FULL, isOwn: true, isShared: true });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Unpublish/ }));

    await waitFor(() => {
      expect(readingSvc.unpublishStory).toHaveBeenCalledWith(
        STORY_FULL.id,
        expect.anything(),
      );
    });
    expect(
      await screen.findByRole('button', { name: /Publish to library/ }),
    ).toBeInTheDocument();
  });

  it("a NON-OWNER viewing a published story sees 'Save to my library', never the Publish control", async () => {
    renderStoryDirect({ ...STORY_FULL, isOwn: false, isShared: true });

    expect(
      await screen.findByRole('button', { name: /Save to my library/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Publish to library/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Unpublish/ }),
    ).not.toBeInTheDocument();
  });

  it("a non-owner's 'Save to my library' click on the reader clones and re-navigates into the copy", async () => {
    const clone: GeneratedStory = { ...STORY_FULL, id: 55, isOwn: true, isShared: false };
    readingSvc.cloneStory.mockResolvedValue(clone);
    renderStoryDirect({ ...STORY_FULL, isOwn: false, isShared: true });

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: /Save to my library/ }),
    );

    await waitFor(() => {
      expect(readingSvc.cloneStory).toHaveBeenCalledWith(
        STORY_FULL.id,
        expect.anything(),
      );
    });
    await waitFor(() => {
      expect(readingSvc.getGeneratedStory).toHaveBeenCalledWith(
        clone.id,
        expect.anything(),
      );
    });
  });

  it('a publish failure shows fixed alert copy — no server prose leak', async () => {
    readingSvc.publishStory.mockRejectedValue(
      new ApiError('db exploded', { status: 500, code: 'server_error' }),
    );
    renderStoryDirect({ ...STORY_FULL, isOwn: true, isShared: false });

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: /Publish to library/ }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't save/i);
    expect(alert).not.toHaveTextContent(/db exploded/);
  });

  it('an OWNER with isOwn omitted (older-shaped fixture) still gets the Publish control (backward-compat default)', async () => {
    const { isOwn: _drop, ...withoutIsOwn } = { ...STORY_FULL, isOwn: true };
    renderStoryDirect(withoutIsOwn as GeneratedStory);

    expect(
      await screen.findByRole('button', { name: /Publish to library/ }),
    ).toBeInTheDocument();
  });

  // #45 fix-pass (client review SF-1/SF-2): a non-owner previewing a
  // published (not-yet-cloned) story must see ONLY the read + Save-to-my-
  // library affordances — every owner-only mutation control (audio
  // generation, the combined experience button, mark-finished) POSTs to a
  // route that's owner-gated server-side and would silently 404. Before this
  // fix-pass NOTHING asserted their absence, so a future regression here
  // would have shipped unnoticed.
  describe('non-owner affordance gating (listen-via-clone boundary)', () => {
    it("a NON-OWNER viewing a published story does NOT see 'Generate audio', 'Generate full experience', or 'Mark story as finished'", async () => {
      renderStoryDirect({ ...STORY_FULL, isOwn: false, isShared: true });

      // The read surface + clone action ARE present (the story loaded).
      expect(
        await screen.findByRole('button', { name: /Save to my library/ }),
      ).toBeInTheDocument();

      // None of the owner-only mutation affordances render.
      expect(
        screen.queryByRole('button', { name: /Generate audio/ }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /Generate full experience/ }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /Mark story as finished/i }),
      ).not.toBeInTheDocument();

      // The audio hydrate still runs (read-only GET, unchanged), but its
      // masked-to-'none' result must never resurface as a request button.
      expect(readingSvc.getStoryAudio).toHaveBeenCalled();
    });

    it("the SAME story viewed by its OWNER (isOwn omitted → default true) DOES show all three affordances", async () => {
      const { isOwn: _drop, ...ownedStory } = {
        ...STORY_FULL,
        isOwn: true,
        isShared: true,
      };
      renderStoryDirect(ownedStory as GeneratedStory);

      expect(
        await screen.findByRole('button', { name: /Generate audio/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /Generate full experience/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /Mark story as finished/i }),
      ).toBeInTheDocument();
    });
  });
});
