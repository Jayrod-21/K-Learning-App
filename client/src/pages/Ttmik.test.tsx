/**
 * Listen page (F-012, reworked 3C-2: F-071 / F-072 / F-024; Wave-2 F-128 /
 * F-160 / F-161 / F-162) — landing tile grid, URL-addressed listings
 * windowed to 15 rows, BackButtons on nested views, detail view with a
 * PERSISTENT audio player + Highlights/Transcript sub-tabs and clickable
 * transcript words (the Read tab's tap chain).
 *
 * The four fetchers in `services/ttmik` are mocked per test; `buildAudioSrc`
 * stays REAL so the assertions cover the actual src the page hands to the
 * `<audio>` element (empty API base in the test env → app-relative path).
 * F-210: `services/reading`'s `listGeneratedAudio` is likewise mocked (the
 * landing's "Generated Audio" section fetches it; default: nothing voiced).
 * The tap chain services (lemmatize/define/enrich) are mocked as modules —
 * the page goes through `lib/tapChain.resolveWordPopover`, which calls them.
 * The audio element has no ARIA role, so identity/presence is asserted via
 * DOM queries — everything else goes through accessible surfaces.
 *
 * Layout note: jsdom computes no CSS, so "2 across" itself lives in
 * Ttmik.css (`.km-ttmik__tiles` → `repeat(2, minmax(0, 1fr))`); the tests
 * pin the structural contract that CSS keys on — the labelled tile list,
 * its class hook, and one keyboard-operable button per collection.
 *
 * F-162 note: the page's `useListScrollRestore` hook keys off the nearest
 * `.km-shell__scroll` ancestor (Shell.tsx's real scroll container — window
 * itself never scrolls). `renderPage` below wraps `<Ttmik/>` in a
 * `.km-shell__scroll` div so that ancestor genuinely exists in these tests,
 * matching the real DOM shape the hook's `closest()` call depends on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import { ToastProvider } from '../components/ToastProvider';
import { ApiError } from '../services/api';
import { lemmatize } from '../services/lemmatize';
import { defineEntry } from '../services/define';
import { enrich } from '../services/enrich';
import {
  getIyagiEpisode,
  getIyagiEpisodes,
  getTtmikLesson,
  getTtmikLessons,
  logIyagiAttempt,
  logTtmikAttempt,
} from '../services/ttmik';
import { getAudioTrack, getSharedAudio, listMyAudio } from '../services/audio';
import {
  generateStory,
  getStoryAudio,
  listGeneratedAudio,
  requestStoryAudio,
} from '../services/reading';
import type {
  GeneratedAudioItem,
  GeneratedStory,
  StoryAudio,
} from '../services/reading';
import { mineWord } from '../services/vocab';
import type {
  AudioTrackDetail,
  IyagiEpisode,
  IyagiEpisodeDetail,
  SharedAudioSource,
  TtmikLesson,
  TtmikLessonDetail,
} from '../types/domain';

vi.mock('../services/ttmik', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ttmik')>();
  return {
    ...actual,
    getTtmikLessons: vi.fn(),
    getTtmikLesson: vi.fn(),
    getIyagiEpisodes: vi.fn(),
    getIyagiEpisode: vi.fn(),
    logTtmikAttempt: vi.fn(),
    logIyagiAttempt: vi.fn(),
  };
});
vi.mock('../services/lemmatize', () => ({ lemmatize: vi.fn() }));
vi.mock('../services/define', () => ({ defineEntry: vi.fn() }));
vi.mock('../services/enrich', () => ({ enrich: vi.fn() }));
vi.mock('../services/vocab', () => ({ mineWord: vi.fn() }));
// A-4b: the My Audio tile click-through below lands on MyAudioListing, whose
// fetcher must be mocked (the deep My Audio behaviour lives in
// MyAudio.test.tsx — here we only pin the tile → ?corpus=mine navigation).
vi.mock('../services/audio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/audio')>();
  return {
    ...actual,
    uploadAudio: vi.fn(),
    listMyAudio: vi.fn(),
    getAudioTrack: vi.fn(),
    // F-207: the landing + shared views fetch the curated corpus.
    getSharedAudio: vi.fn(),
  };
});
// F-210: the landing's "Generated Audio" section fetches the voiced-story
// list; mocked so every landing test is hermetic (default: nothing voiced).
// Listen-tab story generator: the landing's creator section rides the SAME
// module — generateStory (the shared StoryGenerator panel) plus the shared
// useStoryAudio hook's getStoryAudio/requestStoryAudio pair.
vi.mock('../services/reading', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/reading')>();
  return {
    ...actual,
    listGeneratedAudio: vi.fn(),
    generateStory: vi.fn(),
    getStoryAudio: vi.fn(),
    requestStoryAudio: vi.fn(),
  };
});

// Import after the mocks so the page binds the mocked fetchers.
import Ttmik from './Ttmik';

const LESSONS: TtmikLesson[] = [
  { level: 1, number: 1, title: 'Hello / Thank you', hasAudio: true },
  { level: 1, number: 2, title: 'Yes / No', hasAudio: true },
  { level: 2, number: 21, title: 'More / -(으)ㄴ 것 같다', hasAudio: false },
];

/** F-072 fixture — 35 level-1 + 5 level-2 lessons (40 total, 3 windows). */
const MANY_LESSONS: TtmikLesson[] = [
  ...Array.from({ length: 35 }, (_, i) => ({
    level: 1,
    number: i + 1,
    title: `Beginner topic ${String(i + 1)}`,
    hasAudio: true,
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    level: 2,
    number: i + 1,
    title: `Intermediate topic ${String(i + 1)}`,
    hasAudio: true,
  })),
];

const EPISODES: IyagiEpisode[] = [
  { number: 1, title: '서울의 겨울', hasAudio: true },
  { number: 143, title: '한국의 카페 문화', hasAudio: false },
];

/** F-072 fixture — 20 episodes (one window + a 5-row remainder). */
const MANY_EPISODES: IyagiEpisode[] = Array.from({ length: 20 }, (_, i) => ({
  number: i + 1,
  title: `에피소드 주제 ${String(i + 1)}`,
  hasAudio: true,
}));

/** Highlights arrive deliberately OUT of ordinal order — the page must sort. */
const LESSON_DETAIL: TtmikLessonDetail = {
  meta: { level: 1, number: 1, title: 'Hello / Thank you', hasAudio: true },
  audioUrl: '/ttmik/lessons/1/1/audio',
  highlights: [
    {
      ordinal: 2,
      korean: '감사합니다.',
      english: 'Thank you.',
      romanization: 'gamsahamnida',
      speaker: '현우',
      is_dialog: true,
    },
    {
      ordinal: 1,
      korean: '안녕하세요.',
      english: 'Hello.',
      romanization: 'annyeonghaseyo',
      speaker: null,
      is_dialog: false,
    },
  ],
  transcript: [
    // header + English-only prose carry korean: null in the real corpus (409 +
    // 2903 rows) — NOT '' — which crashed the tokeniser. Fixtures mirror that.
    { ordinal: 1, korean: null, english: 'Greetings', kind: 'header' },
    { ordinal: 2, korean: '안녕하세요.', english: 'Hello.', kind: 'pair' },
    { ordinal: 3, korean: 'annyeonghaseyo', english: null, kind: 'romanization' },
    {
      ordinal: 4,
      korean: null,
      english: 'This greeting works at any time of day.',
      kind: 'prose',
    },
    { ordinal: 5, korean: '감사합니다.', english: 'Thank you.', kind: 'dialog' },
  ],
};

const EPISODE_DETAIL: IyagiEpisodeDetail = {
  meta: {
    number: 143,
    title: '한국의 카페 문화',
    // A REAL string[] on the wire (the old string shape crashed this view).
    hosts: ['경화', '석진'],
    hasAudio: false,
  },
  audioUrl: null,
  sentences: [
    {
      ordinal: 1,
      korean: '요즘 카페 자주 가세요?',
      english: 'Do you go to cafes often these days?',
      romanization: null,
      speaker: '경화',
      is_dialog: true,
    },
  ],
};

/**
 * F-207 fixtures — the curated shared corpus as `getSharedAudio` returns
 * it (domain shape; the service is mocked). Track ids are `id * 100 + n`
 * so a set's first track is deterministic for the player tests.
 */
function makeSharedSet(
  id: number,
  slug: string,
  title: string,
  trackCount = 2,
): SharedAudioSource {
  return {
    id,
    slug,
    title,
    kind: 'standalone_listening',
    createdAt: '2026-07-01T00:00:00Z',
    tracks: Array.from({ length: trackCount }, (_, i) => ({
      id: id * 100 + i + 1,
      trackNumber: i + 1,
      title: `${title} ${String(i + 1)}`,
      byteSize: 1_000_000,
      durationMs: 60_000,
      transcriptStatus: 'done' as const,
    })),
  };
}

/** Every manifest slug present — all six curated tiles render. */
const SHARED_SETS: SharedAudioSource[] = [
  makeSharedSet(70, 'news-in-korean', '한국어 뉴스'),
  makeSharedSet(71, 'jindo-dog', '파란 진돗개'),
  makeSharedSet(72, 'korean-folktales', '전래 동화 모음'),
  makeSharedSet(73, 'real-life-korean-conversations-intermediate', '실전 회화'),
  makeSharedSet(74, 'easy-korean-reading-beginners', '쉬운 읽기'),
  ...Array.from({ length: 10 }, (_, i) =>
    makeSharedSet(80 + i, `ttmik-grammar-level-${String(i + 1)}`, `문법 레벨 ${String(i + 1)}`),
  ),
];

/** Track detail for shared-track player tests (folktales track 7201). */
const SHARED_TRACK_DETAIL: AudioTrackDetail = {
  track: {
    id: 7201,
    title: '전래 동화 모음 1',
    transcriptStatus: 'done',
    durationMs: 60_000,
    streamUrl: '/audio/tracks/7201/stream',
  },
  segments: [
    { segmentNumber: 1, startMs: 0, endMs: 4000, body: '옛날 옛적에.' },
  ],
};

/** F-210 fixture — two voiced stories as `listGeneratedAudio` returns them
 *  (newest first; streamUrls match the REAL `buildAudioSrc` allow-list, which
 *  stays unmocked so the src assertions cover the actual player wiring). */
const GENERATED_AUDIO: GeneratedAudioItem[] = [
  {
    id: 41,
    title: '겨울 산책',
    level: 'L4',
    streamUrl: '/audio/tracks/900/stream',
    durationMs: 204_000, // → "3:24"
  },
  {
    id: 7,
    title: '바닷가 이야기',
    level: 'L2',
    streamUrl: '/audio/tracks/901/stream',
    durationMs: 5000,
  },
];

/** Listen-tab story generator fixtures — the story the shared StoryGenerator
 *  hands back, and the audio envelopes the shared useStoryAudio machine
 *  rides. The done track's streamUrl matches the REAL buildAudioSrc
 *  allow-list (unmocked), so the src assertion covers the actual wiring. */
const CREATED_STORY: GeneratedStory = {
  id: 55,
  title: '달빛 아래 서울',
  level: 'L3',
  prompt: null,
  createdAt: '2026-08-18T00:00:00Z',
  bodyKo: '소년은 학교에 갔다.\n\n바람이 불었다.',
};

const CREATOR_AUDIO_NONE: StoryAudio = {
  status: 'none',
  jobId: null,
  error: null,
  track: null,
  segments: [],
};

const CREATOR_AUDIO_PENDING: StoryAudio = {
  status: 'pending',
  jobId: 3,
  error: null,
  track: null,
  segments: [],
};

const CREATOR_AUDIO_DONE: StoryAudio = {
  status: 'done',
  jobId: 3,
  error: null,
  track: { id: 955, streamUrl: '/audio/tracks/955/stream', durationMs: 61_000 },
  segments: [],
};

const CREATOR_AUDIO_FAILED: StoryAudio = {
  status: 'failed',
  jobId: 3,
  error: 'The voice service is unavailable right now. Try again later.',
  track: null,
  segments: [],
};

/** F-207: surfaces the router location so Read-button navigation (into the
 *  reading routes this page doesn't render) is assertable. */
function LocationProbe(): JSX.Element {
  const location = useLocation();
  return (
    <div data-testid="location">{location.pathname + location.search}</div>
  );
}

/**
 * F-162: wraps the page in a `.km-shell__scroll` div — the real ancestor
 * `useListScrollRestore` looks for via `closest()` — so the hook has
 * something genuine to find in these tests, exactly as it would inside the
 * real `Shell.tsx`.
 */
function renderPage(initialEntry = '/learn/listen'): void {
  render(
    <div className="km-shell__scroll">
      <MemoryRouter initialEntries={[initialEntry]}>
        <ToastProvider>
          <Ttmik />
          <LocationProbe />
        </ToastProvider>
      </MemoryRouter>
    </div>,
  );
}

/** The single scrollable region the F-162 tests scroll/assert against. */
function getScroller(): HTMLElement {
  const el = document.querySelector('.km-shell__scroll');
  if (el === null) throw new Error('`.km-shell__scroll` not found in test DOM');
  return el as HTMLElement;
}

/** Landing → TTMIK listing (static tiles render synchronously — the shared
 *  fetch never gates them). */
async function openTtmikListing(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.click(screen.getByRole('button', { name: /TTMIK Lessons/ }));
}

/** F-207: activate one landing carousel page via its dot (1-based) — the
 *  Progress.test goToHistoryPage idiom. The landing pager is now the
 *  ScrollSnapCarousel (native scroll-snap): every page stays exposed in the
 *  DOM (no aria-hidden/inert), so this isn't strictly required for queries
 *  anymore — tests keep it to mirror the real dot → page user flow. */
async function goToLandingPage(
  user: ReturnType<typeof userEvent.setup>,
  page: number,
): Promise<void> {
  const region = screen.getByRole('region', { name: 'Listen collections' });
  await user.click(
    within(region).getByRole('tab', { name: `Page ${String(page)} of 3` }),
  );
}

/** Landing → listing → lesson 1 detail, waiting for its header. */
async function openLessonOne(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await openTtmikListing(user);
  await user.click(
    await screen.findByRole('button', {
      name: 'Open lesson 1: Hello / Thank you (audio)',
    }),
  );
  await screen.findByText('Level 1 · Lesson 1');
}

beforeEach(() => {
  vi.mocked(getTtmikLessons).mockReset().mockResolvedValue(LESSONS);
  vi.mocked(getIyagiEpisodes).mockReset().mockResolvedValue(EPISODES);
  vi.mocked(getTtmikLesson).mockReset().mockResolvedValue(LESSON_DETAIL);
  vi.mocked(getIyagiEpisode).mockReset().mockResolvedValue(EPISODE_DETAIL);
  vi.mocked(lemmatize).mockReset();
  vi.mocked(defineEntry).mockReset();
  vi.mocked(enrich).mockReset();
  vi.mocked(mineWord).mockReset();
  vi.mocked(logTtmikAttempt).mockReset();
  vi.mocked(logIyagiAttempt).mockReset();
  vi.mocked(listMyAudio).mockReset().mockResolvedValue([]);
  vi.mocked(getSharedAudio).mockReset().mockResolvedValue(SHARED_SETS);
  vi.mocked(getAudioTrack).mockReset().mockResolvedValue(SHARED_TRACK_DETAIL);
  // F-210: default = nothing voiced yet — the landing renders the hint.
  vi.mocked(listGeneratedAudio).mockReset().mockResolvedValue([]);
  // Listen-tab story generator: nothing fires until a test clicks Generate;
  // the card's mount hydrate defaults to a fresh never-voiced envelope.
  vi.mocked(generateStory).mockReset();
  vi.mocked(getStoryAudio).mockReset().mockResolvedValue(CREATOR_AUDIO_NONE);
  vi.mocked(requestStoryAudio).mockReset();
  // F-162: each test gets a clean scroll-restore slate — a saved position
  // from one test must never leak into the next.
  window.sessionStorage.clear();
});

describe('Ttmik page — landing (F-071 / F-207 swipe pages)', () => {
  it('renders the 3-page carousel with dots; page 1 carries the labelled Lessons grid', async () => {
    renderPage();

    // The carousel region + one dot per themed page (Lessons / Stories &
    // News / Yours) — the phone-home-screen structure.
    const region = screen.getByRole('region', { name: 'Listen collections' });
    const dots = within(region).getAllByRole('tab');
    expect(dots).toHaveLength(3);

    // The landing pager is the native scroll-snap track (the mobile
    // swipe-steal fix) — NOT the pointer-drag SwipeCarousel, which loses
    // the browser's touch arbitration on this vertically-scrolling page.
    expect(region.querySelector('.km-snap-carousel__track')).not.toBeNull();
    expect(region.querySelector('.km-carousel__viewport')).toBeNull();

    // Page 1's labelled grid + its CSS hook (the 2-across layout keys on
    // it) and the tour anchor.
    const grid = await screen.findByRole('list', {
      name: 'Lessons collections',
    });
    expect(grid).toHaveClass('km-ttmik__tiles');
    expect(grid).toHaveAttribute('data-tour', 'listen-collections');

    // Static tiles render immediately; curated ones once the shared fetch
    // lands. Page 1 order: TTMIK · Grammar · Iyagi · Real-Life.
    expect(
      within(grid).getByRole('button', { name: /TTMIK Lessons/ }),
    ).toBeInTheDocument();
    expect(
      await within(grid).findByRole('button', {
        name: /TTMIK Grammar Textbook/,
      }),
    ).toBeInTheDocument();
    expect(
      within(grid).getByRole('button', { name: /Iyagi Episodes/ }),
    ).toBeInTheDocument();
    expect(
      within(grid).getByRole('button', { name: /Real-Life Conversations/ }),
    ).toBeInTheDocument();
    expect(within(grid).getAllByRole('listitem')).toHaveLength(4);

    // The landing fetches ONLY the shared corpus — never the listings.
    expect(vi.mocked(getSharedAudio)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getTtmikLessons)).not.toHaveBeenCalled();
    expect(vi.mocked(getIyagiEpisodes)).not.toHaveBeenCalled();
    expect(vi.mocked(listMyAudio)).not.toHaveBeenCalled();
  });

  it('F-207: dot navigation surfaces Stories & News (4 curated tiles) and Yours (My Audio)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /TTMIK Grammar Textbook/ });

    await goToLandingPage(user, 2);
    const stories = screen.getByRole('list', {
      name: 'Stories & News collections',
    });
    expect(
      within(stories).getByRole('button', { name: /Korean Folktales/ }),
    ).toBeInTheDocument();
    expect(
      within(stories).getByRole('button', { name: /Easy Korean Reading/ }),
    ).toBeInTheDocument();
    expect(
      within(stories).getByRole('button', { name: /Blue Jindo Dog/ }),
    ).toBeInTheDocument();
    expect(
      within(stories).getByRole('button', { name: /News in Korean/ }),
    ).toBeInTheDocument();
    expect(within(stories).getAllByRole('listitem')).toHaveLength(4);

    await goToLandingPage(user, 3);
    // The Yours grid carries an explicit aria-label override — the default
    // `"${en} collections"` template would read "Yours collections".
    const yours = screen.getByRole('list', { name: 'Your audio' });
    expect(
      within(yours).getByRole('button', { name: /My Audio/ }),
    ).toBeInTheDocument();
    expect(within(yours).getAllByRole('listitem')).toHaveLength(1);
  });

  it('a tile is keyboard-operable: Enter opens the TTMIK listing', async () => {
    const user = userEvent.setup();
    renderPage();

    screen.getByRole('button', { name: /TTMIK Lessons/ }).focus();
    await user.keyboard('{Enter}');

    expect(await screen.findByText('Showing 3 of 3')).toBeInTheDocument();
    expect(vi.mocked(getTtmikLessons)).toHaveBeenCalledTimes(1);
  });

  it('the Iyagi tile opens the episodes listing', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: /Iyagi Episodes/ }));

    expect(
      await screen.findByRole('button', {
        name: 'Open episode 1: 서울의 겨울 (audio)',
      }),
    ).toBeInTheDocument();
    const ep143 = screen.getByRole('button', {
      name: 'Open episode 143: 한국의 카페 문화 (no audio)',
    });
    expect(within(ep143).getByText('No audio')).toBeInTheDocument();
  });

  it('the My Audio tile opens the My Audio listing (?corpus=mine) — S3, the only user entry point', async () => {
    const user = userEvent.setup();
    renderPage();

    // F-207: My Audio lives on the "Yours" page now — surface it first
    // (mirrors the real dot → tile flow; scroll-snap pages stay exposed).
    await goToLandingPage(user, 3);
    await user.click(screen.getByRole('button', { name: /My Audio/ }));

    // The mine listing rendered: its fetch fired and the upload control +
    // (empty-list) giwa state are on screen — both exist only under the
    // `?corpus=mine` view, so this pins the tile's navigation target.
    expect(
      await screen.findByRole('button', { name: /Upload audio/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/No audio yet\./)).toBeInTheDocument();
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(1);
    // The corpus listings did NOT fetch — the tile went to mine, not them.
    expect(vi.mocked(getTtmikLessons)).not.toHaveBeenCalled();
    expect(vi.mocked(getIyagiEpisodes)).not.toHaveBeenCalled();
  });

  it('P3b: title, nav eyebrow, and listing level headings render Korean in both-mode', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(
      screen.getByRole('heading', { level: 1, name: '듣기 · Listen' }),
    ).toBeInTheDocument();
    // Topbar eyebrow — the nav manifest pair.
    expect(screen.getByText('TTMIK · 이야기 오디오')).toBeInTheDocument();
    expect(screen.getByText('TTMIK · Iyagi audio')).toBeInTheDocument();

    await openTtmikListing(user);
    // Level group eyebrows carry their Korean halves.
    expect(await screen.findByText('레벨 1')).toBeInTheDocument();
    // The audio pills expose both languages in the accessible reading.
    expect(screen.getAllByText('오디오').length).toBeGreaterThan(0);
  });

  it('F-128: the landing tiles render as toned CityCard signboards — TTMIK blue, Iyagi mint, My Audio violet', () => {
    renderPage();

    const ttmikTile = screen
      .getByRole('button', { name: /TTMIK Lessons/ })
      .closest('.km-citycard');
    const iyagiTile = screen
      .getByRole('button', { name: /Iyagi Episodes/ })
      .closest('.km-citycard');
    // F-207: the My Audio tile sits on the off-screen "Yours" page — with
    // the scroll-snap pager it stays fully exposed in the DOM (no
    // aria-hidden), just scrolled out of view.
    const mineTile = screen
      .getByRole('button', { name: /My Audio/ })
      .closest('.km-citycard');

    expect(ttmikTile).not.toBeNull();
    expect(iyagiTile).not.toBeNull();
    expect(mineTile).not.toBeNull();
    expect(ttmikTile).toHaveClass('km-tone--blue');
    expect(iyagiTile).toHaveClass('km-tone--mint');
    expect(mineTile).toHaveClass('km-tone--violet');
    // The tiles still live inside a labelled grid — the CityCard wrapper
    // didn't replace the accessible list/listitem structure.
    const grid = screen.getByRole('list', { name: 'Lessons collections' });
    expect(within(grid).getByRole('button', { name: /TTMIK Lessons/ }))
      .toBeInTheDocument();
  });
});

describe('Ttmik page — landing "Generated Audio" section (F-210)', () => {
  it('renders each voiced story with title, level, an inline player (REAL allow-list src), and Open in reader', async () => {
    vi.mocked(listGeneratedAudio).mockResolvedValue(GENERATED_AUDIO);
    const user = userEvent.setup();
    renderPage();

    const section = await screen.findByRole('region', {
      name: /Generated Audio/,
    });
    const list = within(section).getByRole('list', {
      name: 'Generated audio',
    });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);

    // Row content: title + level pill, served order preserved (newest first
    // is the SERVER's contract — this client renders as-is).
    expect(within(rows[0]!).getByText('겨울 산책')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('L4')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('바닷가 이야기')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('L2')).toBeInTheDocument();

    // Durations render as m:ss — a padded sub-minute length and a
    // minutes-scale one, straight from durationMs.
    expect(within(rows[0]!).getByText('3:24')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('0:05')).toBeInTheDocument();

    // Inline players: src through the REAL buildAudioSrc (empty API base in
    // tests → the app-relative allow-listed byte route), with controls.
    const players = section.querySelectorAll('audio');
    expect(players).toHaveLength(2);
    expect(players[0]!.getAttribute('src')).toBe('/audio/tracks/900/stream');
    expect(players[1]!.getAttribute('src')).toBe('/audio/tracks/901/stream');
    expect(players[0]!.hasAttribute('controls')).toBe(true);

    // Open in reader → the story reader's existing deep link.
    await user.click(
      within(rows[0]!).getByRole('button', { name: 'Open 겨울 산책 in reader' }),
    );
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/learn/reading?story=41',
    );
  });

  it('a tampered off-allow-list streamUrl renders the row WITHOUT a player (never a broken one)', async () => {
    vi.mocked(listGeneratedAudio).mockResolvedValue([
      {
        id: 9,
        title: '나쁜 이야기',
        level: 'L1',
        streamUrl: 'https://evil.example/a.mp3',
        durationMs: null,
      },
    ]);
    renderPage();

    const list = await screen.findByRole('list', { name: 'Generated audio' });
    const row = within(list).getAllByRole('listitem')[0]!;
    expect(within(row).getByText('나쁜 이야기')).toBeInTheDocument();
    // buildAudioSrc rejected the src — no <audio> element at all.
    expect(row.querySelector('audio')).toBeNull();
    // A null durationMs renders NO duration text (never "0:00").
    expect(within(row).queryByText(/^\d+:\d{2}$/)).toBeNull();
    // The reader action still works for the row.
    expect(
      within(row).getByRole('button', { name: 'Open 나쁜 이야기 in reader' }),
    ).toBeInTheDocument();
  });

  it('empty state: the discoverability hint renders — no list, no player — and the carousel is untouched', async () => {
    renderPage(); // beforeEach default: nothing voiced

    expect(
      await screen.findByText(/voice a story in Reading to hear it here/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('list', { name: 'Generated audio' }),
    ).toBeNull();
    expect(document.querySelector('audio')).toBeNull();

    // Regression pin: the section never disturbs the existing landing —
    // the F-207 carousel and its Lessons grid render exactly as before.
    expect(
      screen.getByRole('region', { name: 'Listen collections' }),
    ).toBeInTheDocument();
    const grid = await screen.findByRole('list', {
      name: 'Lessons collections',
    });
    expect(
      within(grid).getByRole('button', { name: /TTMIK Lessons/ }),
    ).toBeInTheDocument();
  });

  it('fetch failure: a scoped alert with Retry — the landing is never wedged, and Retry recovers', async () => {
    vi.mocked(listGeneratedAudio)
      .mockRejectedValueOnce(
        new ApiError('boom internal', { status: 500, code: 'server_error' }),
      )
      .mockResolvedValueOnce(GENERATED_AUDIO);
    const user = userEvent.setup();
    renderPage();

    const section = await screen.findByRole('region', {
      name: /Generated Audio/,
    });
    const alert = await within(section).findByRole('alert');
    // Fixed copy, never the server's prose.
    expect(alert).not.toHaveTextContent('boom internal');

    // The carousel above rendered independently of the failed section fetch.
    expect(
      screen.getByRole('region', { name: 'Listen collections' }),
    ).toBeInTheDocument();

    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(
      await within(section).findByRole('list', { name: 'Generated audio' }),
    ).toBeInTheDocument();
    expect(vi.mocked(listGeneratedAudio)).toHaveBeenCalledTimes(2);
  });
});

describe('Ttmik page — landing story creator (Listen-tab story generator)', () => {
  /** Fake-timer helper (the MyAudio.test.tsx GOTCHA: `userEvent` deadlocks
   *  against `vi.useFakeTimers()`, so polling tests use `fireEvent` +
   *  `advanceTimersByTimeAsync`). */
  async function flushAsync(ms = 0): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  /** Drive the shared generator to a created story (real timers). */
  async function createStory(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<HTMLElement> {
    vi.mocked(generateStory).mockResolvedValue(CREATED_STORY);
    await user.click(screen.getByRole('button', { name: /Generate story/ }));
    return await screen.findByRole('group', {
      name: 'New story: 달빛 아래 서울',
    });
  }

  it('renders the SHARED StoryGenerator on the landing, between the carousel and the voiced list', () => {
    renderPage();

    const section = screen.getByRole('region', {
      name: /Create a story to listen to/,
    });
    // The shared panel's own furniture: the level radiogroup + Generate CTA.
    expect(within(section).getByRole('radiogroup')).toBeInTheDocument();
    expect(
      within(section).getByRole('radio', { name: 'L3', checked: true }),
    ).toBeInTheDocument();
    expect(
      within(section).getByRole('button', { name: /Generate story/ }),
    ).toBeInTheDocument();
    // Nothing fetched on mount — the creator is inert until clicked.
    expect(vi.mocked(generateStory)).not.toHaveBeenCalled();
    expect(vi.mocked(getStoryAudio)).not.toHaveBeenCalled();
    // The existing landing around it is untouched: carousel above, the
    // voiced Generated Audio section still below (empty-state hint here).
    expect(
      screen.getByRole('region', { name: 'Listen collections' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: /Generated Audio/ }),
    ).toBeInTheDocument();
  });

  it('onCreated shows the inline card (title + level + audio affordance) and does NOT navigate', async () => {
    const user = userEvent.setup();
    renderPage();

    const card = await createStory(user);

    // Stayed in Listen — the creator holds the story instead of routing
    // into the reader (Reading's onCreated behavior).
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/learn\/listen$/);
    expect(within(card).getByText('달빛 아래 서울')).toBeInTheDocument();
    expect(within(card).getByText('L3')).toBeInTheDocument();
    // The hydrate ('none' envelope) landed → the EXPLICIT audio affordance
    // renders; nothing was auto-voiced (the F-216 cost posture).
    expect(
      await within(card).findByRole('button', { name: /Generate audio/ }),
    ).toBeInTheDocument();
    expect(vi.mocked(requestStoryAudio)).not.toHaveBeenCalled();
    // The generate request carried the picked level and omitted the empty
    // topic (the shared panel's contract).
    expect(vi.mocked(generateStory).mock.calls[0]![0]).toEqual({ level: 'L3' });
  });

  it('Generate audio → 202 → ~2s polling → done renders an inline player with the REAL allow-listed src', async () => {
    vi.useFakeTimers();
    vi.mocked(generateStory).mockResolvedValue(CREATED_STORY);
    vi.mocked(getStoryAudio)
      .mockResolvedValueOnce(CREATOR_AUDIO_NONE) // card-mount hydrate
      .mockResolvedValueOnce(CREATOR_AUDIO_PENDING) // poll tick 1
      .mockResolvedValue(CREATOR_AUDIO_DONE); // poll tick 2+
    vi.mocked(requestStoryAudio).mockResolvedValue(CREATOR_AUDIO_PENDING);
    renderPage();
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: /Generate story/ }));
    await flushAsync();
    const card = screen.getByRole('group', { name: 'New story: 달빛 아래 서울' });

    fireEvent.click(
      within(card).getByRole('button', { name: /Generate audio/ }),
    );
    await flushAsync();
    expect(vi.mocked(requestStoryAudio)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(requestStoryAudio).mock.calls[0]![0]).toBe(55);
    // 202 landed a pending envelope → the busy status replaces the button.
    expect(within(card).getByText(/Generating audio/)).toBeInTheDocument();

    // Tick 1 (2s): still pending — the shared hook's bounded poll rides on.
    await flushAsync(2000);
    expect(within(card).getByText(/Generating audio/)).toBeInTheDocument();

    // Tick 2 (2s): done — the inline player mounts, src through the REAL
    // buildAudioSrc (empty API base → the app-relative allow-listed route).
    await flushAsync(2000);
    const player = card.querySelector('audio');
    expect(player).not.toBeNull();
    expect(player!.getAttribute('src')).toBe('/audio/tracks/955/stream');
    expect(player!.hasAttribute('controls')).toBe(true);
    vi.useRealTimers();
  });

  it('a failed envelope shows the server-authored copy VERBATIM and "Try again" re-POSTs', async () => {
    vi.mocked(getStoryAudio).mockResolvedValue(CREATOR_AUDIO_FAILED);
    vi.mocked(requestStoryAudio).mockResolvedValue(CREATOR_AUDIO_PENDING);
    const user = userEvent.setup();
    renderPage();

    const card = await createStory(user);
    const alert = await within(card).findByRole('alert');
    // The F-210 contract's sanctioned exception: whitelisted server copy,
    // shown untouched.
    expect(alert).toHaveTextContent(
      'The voice service is unavailable right now. Try again later.',
    );

    await user.click(within(card).getByRole('button', { name: /Try again/ }));
    await waitFor(() => {
      expect(vi.mocked(requestStoryAudio)).toHaveBeenCalledWith(
        55,
        expect.any(AbortSignal),
      );
    });
    expect(
      await within(card).findByText(/Generating audio/),
    ).toBeInTheDocument();
  });

  it('the daily-cap 429 (no retryAfter) shows the server message verbatim and keeps the button', async () => {
    vi.mocked(requestStoryAudio).mockRejectedValue(
      new ApiError(
        'daily story-audio limit reached: 3 of 3 generations used today. Try again tomorrow.',
        { status: 429, code: 'rate_limited' },
      ),
    );
    const user = userEvent.setup();
    renderPage();

    const card = await createStory(user);
    await user.click(
      await within(card).findByRole('button', { name: /Generate audio/ }),
    );

    const alert = await within(card).findByRole('alert');
    expect(alert).toHaveTextContent(
      'daily story-audio limit reached: 3 of 3 generations used today. Try again tomorrow.',
    );
    // Not terminal: the button stays for tomorrow and is not stuck busy.
    const button = within(card).getByRole('button', {
      name: /Generate audio/,
    });
    expect(button).not.toHaveAttribute('aria-disabled');
  });

  it('ttsConfigured:false hides the audio affordance entirely — the card still offers the reader', async () => {
    vi.mocked(getStoryAudio).mockResolvedValue({
      ...CREATOR_AUDIO_NONE,
      ttsConfigured: false,
    });
    const user = userEvent.setup();
    renderPage();

    const card = await createStory(user);
    // The hydrate settled dormant — absence, not a dead button.
    await waitFor(() => {
      expect(vi.mocked(getStoryAudio)).toHaveBeenCalled();
    });
    expect(
      within(card).queryByRole('button', { name: /Generate audio/ }),
    ).not.toBeInTheDocument();
    expect(card.querySelector('audio')).toBeNull();
    // The non-audio affordances stand.
    expect(
      within(card).getByRole('button', {
        name: 'Open 달빛 아래 서울 in reader',
      }),
    ).toBeInTheDocument();
  });

  it('"Open in reader" deep-links into the story reader (/learn/reading?story=N)', async () => {
    const user = userEvent.setup();
    renderPage();

    const card = await createStory(user);
    await user.click(
      within(card).getByRole('button', { name: 'Open 달빛 아래 서울 in reader' }),
    );
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/learn/reading?story=55',
    );
  });

  it('the existing voiced Generated Audio section still renders BELOW the creator (no regression)', async () => {
    vi.mocked(listGeneratedAudio).mockResolvedValue(GENERATED_AUDIO);
    renderPage();

    const creator = screen.getByRole('region', {
      name: /Create a story to listen to/,
    });
    const voiced = await screen.findByRole('region', {
      name: /Generated Audio/,
    });
    // Both sections coexist; the voiced list keeps its full row rendering.
    expect(
      within(voiced).getByRole('list', { name: 'Generated audio' }),
    ).toBeInTheDocument();
    expect(within(voiced).getByText('겨울 산책')).toBeInTheDocument();
    // DOM order: creator sits ABOVE the voiced section (additive layout).
    expect(
      creator.compareDocumentPosition(voiced) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('Ttmik page — TTMIK listing (F-072 window + F-024 back)', () => {
  it('renders lessons grouped by level with audio indicators', async () => {
    const user = userEvent.setup();
    renderPage();
    await openTtmikListing(user);

    // Level group headings appear once the list resolves (Korean eyebrow —
    // the English half also appears as a filter option, so it is not unique).
    expect(await screen.findByText('레벨 1')).toBeInTheDocument();
    expect(screen.getByText('레벨 2')).toBeInTheDocument();

    // Rows are accessible buttons carrying the lesson title.
    const lesson1 = screen.getByRole('button', {
      name: 'Open lesson 1: Hello / Thank you (audio)',
    });
    expect(within(lesson1).getByText('Audio')).toBeInTheDocument();

    const lesson21 = screen.getByRole('button', {
      name: 'Open lesson 21: More / -(으)ㄴ 것 같다 (no audio)',
    });
    expect(within(lesson21).getByText('No audio')).toBeInTheDocument();

    // Mutation pin (F-210): the Generated Audio section is landing-ONLY —
    // rendering it unconditionally must fail here on the listing view.
    expect(
      screen.queryByRole('region', { name: /Generated Audio/i }),
    ).toBeNull();
  });

  it('F-072: windows the listing to 15 rows and reveals 15 more per Show more', async () => {
    vi.mocked(getTtmikLessons).mockResolvedValue(MANY_LESSONS);
    const user = userEvent.setup();
    renderPage();
    await openTtmikListing(user);

    // Page one: exactly 15 rows of 40.
    expect(await screen.findByText('Showing 15 of 40')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Open lesson/ })).toHaveLength(
      15,
    );

    // The expander announces how many the next click reveals.
    await user.click(screen.getByRole('button', { name: 'Show more (15)' }));
    expect(screen.getByText('Showing 30 of 40')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Open lesson/ })).toHaveLength(
      30,
    );

    // Last window is the 10-row remainder; the exhausted control disappears.
    await user.click(screen.getByRole('button', { name: 'Show more (10)' }));
    expect(screen.getByText('Showing 40 of 40')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Open lesson/ })).toHaveLength(
      40,
    );
    expect(
      screen.queryByRole('button', { name: /Show more/ }),
    ).not.toBeInTheDocument();
  });

  it('F-072: the level filter narrows the listing AND collapses the window', async () => {
    vi.mocked(getTtmikLessons).mockResolvedValue(MANY_LESSONS);
    const user = userEvent.setup();
    renderPage();
    await openTtmikListing(user);
    await screen.findByText('Showing 15 of 40');

    // Expand to 30 first so the reset is observable.
    await user.click(screen.getByRole('button', { name: 'Show more (15)' }));
    expect(screen.getByText('Showing 30 of 40')).toBeInTheDocument();

    // Filter to level 2 — only its 5 lessons remain, no expander.
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Level · 레벨' }),
      '2',
    );
    expect(screen.getByText('Showing 5 of 5')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Open lesson/ })).toHaveLength(
      5,
    );
    expect(
      within(
        screen.getAllByRole('button', { name: /^Open lesson/ })[0]!,
      ).getByText('Intermediate topic 1'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Show more/ }),
    ).not.toBeInTheDocument();

    // Clearing the filter lands back on page ONE (15), not the previous 30 —
    // the filter change reset the window.
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Level · 레벨' }),
      '',
    );
    expect(screen.getByText('Showing 15 of 40')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Open lesson/ })).toHaveLength(
      15,
    );
  });

  it('shows the empty state when there are no lessons', async () => {
    vi.mocked(getTtmikLessons).mockResolvedValue([]);
    const user = userEvent.setup();
    renderPage();
    await openTtmikListing(user);

    expect(
      await screen.findByText('No lessons available yet.'),
    ).toBeInTheDocument();
  });

  it('surfaces a list failure as an error card with a working retry', async () => {
    const user = userEvent.setup();
    vi.mocked(getTtmikLessons)
      .mockRejectedValueOnce(
        new ApiError('server error', { status: 500, code: 'server_error' }),
      )
      .mockResolvedValueOnce(LESSONS);
    renderPage();
    await openTtmikListing(user);

    // F-UP-018 fixed-copy contract: the ErrorCard shows author-controlled
    // copy, never the server prose riding on ApiError.message.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Could not load the lessons\./);
    expect(alert).not.toHaveTextContent(/server error/);

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('레벨 1')).toBeInTheDocument();
    expect(vi.mocked(getTtmikLessons)).toHaveBeenCalledTimes(2);
  });

  it('F-024: the listing carries a BackButton to the Listen landing', async () => {
    const user = userEvent.setup();
    renderPage();
    await openTtmikListing(user);
    await screen.findByText('Showing 3 of 3');

    await user.click(screen.getByRole('button', { name: 'Back to Listen' }));

    expect(
      screen.getByRole('region', { name: 'Listen collections' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Open lesson/ }),
    ).not.toBeInTheDocument();
  });
});

describe('Ttmik page — URL addressing (untrusted search params)', () => {
  it('deep-links straight into a lesson detail without touching the listings', async () => {
    renderPage('/learn/listen?corpus=ttmik&level=1&lesson=1');

    expect(await screen.findByText('Level 1 · Lesson 1')).toBeInTheDocument();
    expect(vi.mocked(getTtmikLesson)).toHaveBeenCalledWith(
      1,
      1,
      expect.any(AbortSignal),
    );
    expect(vi.mocked(getTtmikLessons)).not.toHaveBeenCalled();
  });

  it('an unknown corpus falls back to the landing (no listing fetches)', () => {
    renderPage('/learn/listen?corpus=podcasts');

    expect(
      screen.getByRole('region', { name: 'Listen collections' }),
    ).toBeInTheDocument();
    expect(vi.mocked(getTtmikLessons)).not.toHaveBeenCalled();
    expect(vi.mocked(getTtmikLesson)).not.toHaveBeenCalled();
  });

  it('F-207: an unknown ?set= slug falls back to the landing (closed-set narrowing, no track fetch)', () => {
    renderPage('/learn/listen?corpus=shared&set=totally-unknown-slug&track=5');

    expect(
      screen.getByRole('region', { name: 'Listen collections' }),
    ).toBeInTheDocument();
    expect(vi.mocked(getAudioTrack)).not.toHaveBeenCalled();
  });

  it('malformed detail numbers fall back to the listing, never into a fetch', async () => {
    renderPage('/learn/listen?corpus=ttmik&level=0&lesson=abc');

    expect(await screen.findByText('Showing 3 of 3')).toBeInTheDocument();
    expect(vi.mocked(getTtmikLesson)).not.toHaveBeenCalled();
  });

  it('F-183: deep-links straight into an Iyagi episode detail (Today Listening tile: corpus=iyagi&episode=N)', async () => {
    renderPage('/learn/listen?corpus=iyagi&episode=143');

    expect(await screen.findByText('Iyagi · Episode 143')).toBeInTheDocument();
    expect(vi.mocked(getIyagiEpisode)).toHaveBeenCalledWith(
      143,
      expect.any(AbortSignal),
    );
    expect(vi.mocked(getIyagiEpisodes)).not.toHaveBeenCalled();
  });

  it('F-183: a malformed ?episode= falls back to the Iyagi listing, never into a fetch', async () => {
    renderPage('/learn/listen?corpus=iyagi&episode=abc');

    expect(await screen.findByText('Showing 2 of 2')).toBeInTheDocument();
    expect(vi.mocked(getIyagiEpisode)).not.toHaveBeenCalled();
  });

  it('F-183: a well-formed but nonexistent ?episode= surfaces the honest error card — never a crash', async () => {
    vi.mocked(getIyagiEpisode).mockRejectedValue(
      new ApiError('not found', { status: 404, code: 'not_found' }),
    );

    // 4 digits — within `parsePositiveInt`'s deliberate ordinal-length cap
    // (Ttmik.tsx's own parser rejects 5+ digit corpus ordinals as malformed
    // outright, which is the PRECEDING test's case; this one exercises a
    // well-formed id that simply doesn't resolve server-side).
    renderPage('/learn/listen?corpus=iyagi&episode=9999');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load the transcript/i);
  });
});

describe('Ttmik page — lesson detail (persistent player + sub-tabs)', () => {
  it('opens a lesson: real audio element with the API-base src, Highlights by default in ordinal order', async () => {
    const user = userEvent.setup();
    renderPage();
    await openLessonOne(user);

    expect(
      screen.getByRole('heading', { name: 'Hello / Thank you' }),
    ).toBeInTheDocument();

    // A REAL <audio controls> element, src = API base ('' in tests) + audioUrl.
    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio).toHaveAttribute('controls');
    expect(audio).toHaveAttribute('src', '/ttmik/lessons/1/1/audio');

    // Sub-tabs render under the player; Highlights is the default panel.
    expect(
      screen.getByRole('tab', { name: '하이라이트 · Highlights', selected: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: '대본 · Transcript', selected: false }),
    ).toBeInTheDocument();

    // Highlights: ordinal order (the wire fixture is deliberately reversed),
    // Korean + English, speaker label on the dialog turn.
    const highlights = screen.getByRole('list', { name: 'Highlights' });
    const rows = within(highlights).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('안녕하세요.')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Hello.')).toBeInTheDocument();
    // No romanization anywhere — the sentence's romanization field is never rendered.
    expect(within(rows[0]!).queryByText('annyeonghaseyo')).not.toBeInTheDocument();
    expect(within(rows[0]!).queryByText('현우')).not.toBeInTheDocument();
    expect(within(rows[1]!).getByText('감사합니다.')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('현우')).toBeInTheDocument();

    expect(vi.mocked(getTtmikLesson)).toHaveBeenCalledWith(
      1,
      1,
      expect.any(AbortSignal),
    );
  });

  it('a lesson with no Highlights opens on Transcript and hides the empty Highlights tab', async () => {
    // ~14% of TTMIK lessons have no Highlights but a real Transcript. Landing on
    // an empty Highlights default reads as "no content" — instead default to
    // Transcript and don't offer the empty tab.
    vi.mocked(getTtmikLesson).mockResolvedValue({
      ...LESSON_DETAIL,
      highlights: [],
    });
    const user = userEvent.setup();
    renderPage();
    await openLessonOne(user);

    expect(
      screen.getByRole('tab', { name: '대본 · Transcript', selected: true }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('tab', { name: /Highlights/ }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole('list', { name: 'Transcript' }),
    ).toBeInTheDocument();
    // The panel below must match the visible tab — the empty HighlightsPanel's
    // "No highlights yet." must never leak (the derived-tab fix means there is
    // no post-render flash showing it, unlike a set-state-in-effect).
    expect(
      screen.queryByText('No highlights yet.'),
    ).not.toBeInTheDocument();
  });

  it('a lesson with neither Highlights nor Transcript shows an empty-content note (no empty tablist)', async () => {
    vi.mocked(getTtmikLesson).mockResolvedValue({
      ...LESSON_DETAIL,
      highlights: [],
      transcript: [],
    });
    const user = userEvent.setup();
    renderPage();
    await openLessonOne(user);

    expect(
      await screen.findByText('No lesson text yet.'),
    ).toBeInTheDocument();
    // No tablist with zero tabs (ARIA-invalid) and no leaked empty panels.
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(
      screen.queryByText('No highlights yet.'),
    ).not.toBeInTheDocument();
  });

  it('keeps the SAME audio element across sub-tab switches (no remount, no refetch)', async () => {
    const user = userEvent.setup();
    renderPage();
    await openLessonOne(user);

    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();

    // Highlights → Transcript: the panel below swaps, the player does not.
    await user.click(screen.getByRole('tab', { name: '대본 · Transcript' }));
    await screen.findByRole('list', { name: 'Transcript' });
    // Identity assertion — the exact same DOM node, not an equal-looking
    // replacement. A remount would produce a new element (and reset
    // playback); toBe checks reference equality.
    expect(document.querySelector('audio')).toBe(audio);

    // And back again.
    await user.click(screen.getByRole('tab', { name: '하이라이트 · Highlights' }));
    await screen.findByRole('list', { name: 'Highlights' });
    expect(document.querySelector('audio')).toBe(audio);
    expect(audio).toHaveAttribute('src', '/ttmik/lessons/1/1/audio');

    // Both panels came from the single detail response — no extra fetch.
    expect(vi.mocked(getTtmikLesson)).toHaveBeenCalledTimes(1);
  });

  it('B-025: renders every transcript line kind: header, pair, romanization, prose, dialog', async () => {
    const user = userEvent.setup();
    renderPage();
    await openLessonOne(user);

    await user.click(screen.getByRole('tab', { name: '대본 · Transcript' }));
    const transcript = await screen.findByRole('list', { name: 'Transcript' });

    // header with korean: null → falls back to the English title, no crash.
    expect(
      within(transcript).getByRole('heading', { name: 'Greetings' }),
    ).toBeInTheDocument();
    // pair → clickable Korean + English below.
    expect(
      within(transcript).getByRole('button', { name: '안녕하세요.' }),
    ).toBeInTheDocument();
    expect(within(transcript).getByText('Hello.')).toBeInTheDocument();
    // romanization → dropped entirely (no romanization anywhere), never rendered.
    expect(within(transcript).queryByText('annyeonghaseyo')).not.toBeInTheDocument();
    // prose → explanation note.
    expect(within(transcript).getByRole('note')).toHaveTextContent(
      'This greeting works at any time of day.',
    );
    // dialog → rendered like a pair.
    expect(
      within(transcript).getByRole('button', { name: '감사합니다.' }),
    ).toBeInTheDocument();
    expect(within(transcript).getByText('Thank you.')).toBeInTheDocument();
  });

  it('tapping a Korean word runs the abortable tap chain and opens the word popover', async () => {
    vi.mocked(lemmatize).mockResolvedValue([
      { surface: '안녕하세요.', lemma: '안녕하세요', pos: 'IC', start: 0, end: 6 },
    ]);
    vi.mocked(defineEntry).mockResolvedValue({
      word: '안녕하세요',
      entries: [
        {
          id: 7,
          headword: '안녕하세요',
          part_of_speech: 'interj.',
          definition_korean: null,
          definition_english: 'hello (polite)',
          examples: [],
        },
      ],
    });
    vi.mocked(enrich).mockResolvedValue({
      result: {
        nuance: 'standard polite greeting',
        usageNote: 'Use with strangers and elders.',
        examples: [],
        dontConfuseWith: [],
        proficiency: 'L1',
      },
    });

    const user = userEvent.setup();
    renderPage();
    await openLessonOne(user);

    // Highlight Korean renders as a Tapword (role=button) via the shared
    // tokeniser — tap it.
    const highlights = screen.getByRole('list', { name: 'Highlights' });
    await user.click(
      within(highlights).getByRole('button', { name: '안녕하세요.' }),
    );

    // Popover opens as a dialog and lands the resolved definition.
    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText('hello (polite)'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: /Add to vocab/i }),
    ).toBeInTheDocument();

    // The chain ran with the popover-scoped AbortSignal at every step.
    expect(vi.mocked(lemmatize)).toHaveBeenCalledWith(
      '안녕하세요.',
      expect.any(AbortSignal),
    );
    expect(vi.mocked(defineEntry)).toHaveBeenCalledWith(
      '안녕하세요',
      expect.any(AbortSignal),
    );
    expect(vi.mocked(enrich)).toHaveBeenCalledWith(
      { lemma: '안녕하세요', sourceSentence: '안녕하세요.' },
      expect.any(AbortSignal),
    );

    // The audio element survived the whole interaction untouched.
    expect(document.querySelector('audio')).not.toBeNull();
  });

  // U3c migration guard: the page-local add-to-bank abort contract (kept
  // OUTSIDE useTapWord — see the hook's header) must survive the move off
  // the inline machine: closing the popover aborts an in-flight mine POST.
  it('closing the popover aborts an in-flight "Add to bank" request', async () => {
    vi.mocked(lemmatize).mockResolvedValue([
      { surface: '안녕하세요.', lemma: '안녕하세요', pos: 'IC', start: 0, end: 6 },
    ]);
    vi.mocked(defineEntry).mockResolvedValue({
      word: '안녕하세요',
      entries: [
        {
          id: 7,
          headword: '안녕하세요',
          part_of_speech: 'interj.',
          definition_korean: null,
          definition_english: 'hello (polite)',
          examples: [],
        },
      ],
    });
    vi.mocked(enrich).mockResolvedValue({
      result: {
        nuance: null,
        usageNote: null,
        examples: [],
        dontConfuseWith: [],
        proficiency: 'L1',
      },
    });
    // Never resolves — lets the test observe the signal mid-flight.
    let mineSignal: AbortSignal | undefined;
    vi.mocked(mineWord).mockImplementation(
      (_input: unknown, signal?: AbortSignal) => {
        mineSignal = signal;
        return new Promise(() => {
          /* never settles */
        });
      },
    );

    const user = userEvent.setup();
    renderPage();
    await openLessonOne(user);

    const highlights = screen.getByRole('list', { name: 'Highlights' });
    await user.click(
      within(highlights).getByRole('button', { name: '안녕하세요.' }),
    );
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('hello (polite)');
    await user.click(
      within(dialog).getByRole('button', { name: /Add to vocab/i }),
    );

    expect(vi.mocked(mineWord)).toHaveBeenCalledWith(
      expect.objectContaining({ lemma: '안녕하세요' }),
      expect.any(AbortSignal),
    );
    expect(mineSignal?.aborted).toBe(false);

    // Closing the popover must abort that same in-flight request.
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(mineSignal?.aborted).toBe(true);
  });

  it('F-024: the detail BackButton returns to the TTMIK listing (player unmounts)', async () => {
    const user = userEvent.setup();
    renderPage();
    await openLessonOne(user);

    await user.click(
      screen.getByRole('button', { name: 'Back to TTMIK Lessons' }),
    );

    expect(await screen.findByText('레벨 1')).toBeInTheDocument();
    expect(document.querySelector('audio')).toBeNull();
  });

  it('surfaces a detail failure as an error card with a working retry', async () => {
    const user = userEvent.setup();
    vi.mocked(getTtmikLesson)
      .mockRejectedValueOnce(
        new ApiError('not found', { status: 404, code: 'not_found' }),
      )
      .mockResolvedValueOnce(LESSON_DETAIL);
    renderPage();
    await openTtmikListing(user);

    await user.click(
      await screen.findByRole('button', {
        name: 'Open lesson 1: Hello / Thank you (audio)',
      }),
    );

    // Fixed copy — the 404's server prose ("not found") must not render.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Could not load the transcript\./);
    expect(alert).not.toHaveTextContent(/not found/);

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Level 1 · Lesson 1')).toBeInTheDocument();
  });

  it('F-160: a runtime audio load failure shows a distinct alert without unmounting the player', async () => {
    const user = userEvent.setup();
    renderPage();
    await openLessonOne(user);

    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    // No failure yet — the "no audio mapped" note and the runtime-failure
    // alert are two different states; neither shows for a healthy player.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // Simulate a genuine stream failure (network blip, 404, decode error) —
    // the element's own `error` event, not a mocked service rejection.
    fireEvent.error(audio as HTMLAudioElement);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load/i);
    // The player itself is NEVER torn down over a playback failure — same
    // DOM node, same src, so the user can still retry/seek natively.
    expect(document.querySelector('audio')).toBe(audio);
    expect(audio).toHaveAttribute('src', '/ttmik/lessons/1/1/audio');

    // Switching tabs doesn't clear (or duplicate) the alert — it isn't
    // tab-scoped, it describes the persistent player above the tabs.
    await user.click(screen.getByRole('tab', { name: '대본 · Transcript' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('Ttmik page — mark as listened (F-172)', () => {
  it('the <audio> `ended` event auto-logs a TTMIK lesson attempt', async () => {
    vi.mocked(logTtmikAttempt).mockResolvedValue({
      id: 1,
      sourceKind: 'ttmik_lesson',
      lessonId: 1,
      episodeId: null,
      titleSnapshot: 'Level 1 Lesson 1: Hello / Thank you',
      completedAt: '2026-07-14T00:00:00Z',
    });

    const user = userEvent.setup();
    renderPage();
    await openLessonOne(user);

    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    fireEvent.ended(audio as HTMLAudioElement);

    await waitFor(() => {
      expect(vi.mocked(logTtmikAttempt)).toHaveBeenCalledWith(
        1,
        1,
        expect.any(AbortSignal),
      );
    });
    expect(
      await screen.findByRole('button', { name: /marked as listened/i }),
    ).toBeInTheDocument();
  });

  it('the `ended` event never double-logs on replay (button already in its done state)', async () => {
    vi.mocked(logTtmikAttempt).mockResolvedValue({
      id: 1,
      sourceKind: 'ttmik_lesson',
      lessonId: 1,
      episodeId: null,
      titleSnapshot: 'Level 1 Lesson 1: Hello / Thank you',
      completedAt: '2026-07-14T00:00:00Z',
    });

    const user = userEvent.setup();
    renderPage();
    await openLessonOne(user);

    const audio = document.querySelector('audio') as HTMLAudioElement;
    fireEvent.ended(audio);
    await screen.findByRole('button', { name: /marked as listened/i });
    fireEvent.ended(audio); // a replay reaching the end again

    expect(vi.mocked(logTtmikAttempt)).toHaveBeenCalledTimes(1);
  });

  it('the explicit "Mark as listened" button covers a unit with no mapped audio (Iyagi 143)', async () => {
    vi.mocked(logIyagiAttempt).mockResolvedValue({
      id: 2,
      sourceKind: 'iyagi_episode',
      lessonId: null,
      episodeId: 143,
      titleSnapshot: 'Iyagi #143: 한국의 카페 문화',
      completedAt: '2026-07-14T00:00:00Z',
    });

    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Iyagi Episodes/ }));
    await user.click(
      await screen.findByRole('button', {
        name: 'Open episode 143: 한국의 카페 문화 (no audio)',
      }),
    );

    // No audio element at all — the button is the ONLY completion trigger.
    expect(document.querySelector('audio')).toBeNull();
    await user.click(
      screen.getByRole('button', { name: /mark as listened/i }),
    );

    await waitFor(() => {
      expect(vi.mocked(logIyagiAttempt)).toHaveBeenCalledWith(
        143,
        expect.any(AbortSignal),
      );
    });
    expect(
      await screen.findByRole('button', { name: /marked as listened/i }),
    ).toBeInTheDocument();
  });

  it('shows a fixed error message (no server prose) when the log POST fails', async () => {
    vi.mocked(logIyagiAttempt).mockRejectedValue(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Iyagi Episodes/ }));
    await user.click(
      await screen.findByRole('button', {
        name: 'Open episode 143: 한국의 카페 문화 (no audio)',
      }),
    );
    await user.click(
      screen.getByRole('button', { name: /mark as listened/i }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't save/i);
    expect(alert).not.toHaveTextContent(/boom/);
  });
});

describe('Ttmik page — Iyagi listing + episode detail', () => {
  it('F-072: windows the episode listing to 15 rows with a working expander', async () => {
    vi.mocked(getIyagiEpisodes).mockResolvedValue(MANY_EPISODES);
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Iyagi Episodes/ }));

    expect(await screen.findByText('Showing 15 of 20')).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: /^Open episode/ }),
    ).toHaveLength(15);

    await user.click(screen.getByRole('button', { name: 'Show more (5)' }));
    expect(screen.getByText('Showing 20 of 20')).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: /^Open episode/ }),
    ).toHaveLength(20);
    expect(
      screen.queryByRole('button', { name: /Show more/ }),
    ).not.toBeInTheDocument();
  });

  it('renders the hosts array, a no-audio note, a clickable transcript, and an F-024 back control', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Iyagi Episodes/ }));
    await user.click(
      await screen.findByRole('button', {
        name: 'Open episode 143: 한국의 카페 문화 (no audio)',
      }),
    );

    expect(await screen.findByText('Iyagi · Episode 143')).toBeInTheDocument();
    // hosts: string[] → joined display line (the old string shape crashed here).
    expect(screen.getByText('경화 · 석진')).toBeInTheDocument();

    // No audio mapped → no player, a fixed note instead.
    expect(document.querySelector('audio')).toBeNull();
    expect(screen.getByRole('note')).toHaveTextContent(/No audio/);

    // Transcript renders with the speaker label, and the Korean words are
    // tap targets (the same Read-tab tap path).
    const transcript = screen.getByRole('list', { name: 'Transcript' });
    expect(within(transcript).getByText('경화')).toBeInTheDocument();
    expect(
      within(transcript).getByRole('button', { name: '요즘' }),
    ).toBeInTheDocument();
    expect(
      within(transcript).getByRole('button', { name: '가세요?' }),
    ).toBeInTheDocument();

    expect(vi.mocked(getIyagiEpisode)).toHaveBeenCalledWith(
      143,
      expect.any(AbortSignal),
    );

    // F-024: back to the owning listing.
    await user.click(
      screen.getByRole('button', { name: 'Back to Iyagi Episodes' }),
    );
    expect(
      await screen.findByRole('button', {
        name: 'Open episode 143: 한국의 카페 문화 (no audio)',
      }),
    ).toBeInTheDocument();
  });
});

describe('Ttmik page — F-162 scroll position preserved on back', () => {
  it('restores the TTMIK listing scroll position after visiting a lesson and returning', async () => {
    vi.mocked(getTtmikLessons).mockResolvedValue(MANY_LESSONS);
    const user = userEvent.setup();
    renderPage();
    await openTtmikListing(user);
    await screen.findByText('Showing 15 of 40');

    const scroller = getScroller();
    fireEvent.scroll(scroller, { target: { scrollTop: 240 } });

    await user.click(
      screen.getByRole('button', { name: 'Open lesson 1: Beginner topic 1 (audio)' }),
    );
    await screen.findByText('Level 1 · Lesson 1');
    // The listing unmounted while the detail was open — nothing in this
    // component's own state/refs could have carried the position forward;
    // only the sessionStorage-backed hook can restore it below.
    expect(screen.queryByText('Showing 15 of 40')).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Back to TTMIK Lessons' }),
    );
    await screen.findByText('Showing 15 of 40');

    expect(scroller.scrollTop).toBe(240);
  });

  it('keeps the TTMIK and Iyagi scroll positions independent (separate storage keys)', async () => {
    vi.mocked(getTtmikLessons).mockResolvedValue(MANY_LESSONS);
    vi.mocked(getIyagiEpisodes).mockResolvedValue(MANY_EPISODES);
    const user = userEvent.setup();
    renderPage();
    const scroller = getScroller();

    await openTtmikListing(user);
    await screen.findByText('Showing 15 of 40');
    fireEvent.scroll(scroller, { target: { scrollTop: 111 } });
    await user.click(screen.getByRole('button', { name: 'Back to Listen' }));

    await user.click(screen.getByRole('button', { name: /Iyagi Episodes/ }));
    await screen.findByText('Showing 15 of 20');
    // A never-before-scrolled Iyagi listing opens at the top — it does NOT
    // inherit whatever the shared scroll container was left at by TTMIK.
    expect(scroller.scrollTop).toBe(0);
    fireEvent.scroll(scroller, { target: { scrollTop: 77 } });
    await user.click(screen.getByRole('button', { name: 'Back to Listen' }));

    await openTtmikListing(user);
    await screen.findByText('Showing 15 of 40');
    expect(scroller.scrollTop).toBe(111);
  });

  it('restores the Iyagi episode listing scroll position after visiting an episode and returning', async () => {
    vi.mocked(getIyagiEpisodes).mockResolvedValue(MANY_EPISODES);
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Iyagi Episodes/ }));
    await screen.findByText('Showing 15 of 20');

    const scroller = getScroller();
    fireEvent.scroll(scroller, { target: { scrollTop: 88 } });

    await user.click(
      screen.getByRole('button', { name: /^Open episode 1:/ }),
    );
    await screen.findByText('Iyagi · Episode 143');

    await user.click(
      screen.getByRole('button', { name: 'Back to Iyagi Episodes' }),
    );
    await screen.findByText('Showing 15 of 20');

    expect(scroller.scrollTop).toBe(88);
  });
});

describe('Ttmik page — F-207 shared curated corpus', () => {
  it('collapses the ten TTMIK Grammar sets to ONE tile that opens an ordered level list', async () => {
    const user = userEvent.setup();
    renderPage();

    // Exactly one Grammar tile across ALL carousel pages (every page is
    // exposed in the scroll-snap DOM) — never ten sibling tiles.
    await screen.findByRole('button', { name: /TTMIK Grammar Textbook/ });
    expect(
      screen.getAllByRole('button', { name: /TTMIK Grammar Textbook/ }),
    ).toHaveLength(1);

    await user.click(
      screen.getByRole('button', { name: /TTMIK Grammar Textbook/ }),
    );

    // The level list: all ten sets, in manifest (level) order.
    const list = await screen.findByRole('list', {
      name: 'Sets in TTMIK Grammar Textbook',
    });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(10);
    expect(within(rows[0]!).getByText('문법 레벨 1')).toBeInTheDocument();
    expect(within(rows[9]!).getByText('문법 레벨 10')).toBeInTheDocument();

    // A level row opens that set's track list…
    await user.click(
      within(list).getByRole('button', {
        name: 'Open set: 문법 레벨 3, 2 tracks (Ready)',
      }),
    );
    expect(
      await screen.findByRole('list', { name: 'Tracks in 문법 레벨 3' }),
    ).toBeInTheDocument();
    // …whose back control returns to the level list, not the landing.
    expect(
      screen.getByRole('button', { name: 'Back to TTMIK Grammar Textbook' }),
    ).toBeInTheDocument();
  });

  it('a curated tile opens its set: track list → track player + transcript (the My Audio flow, shared-sourced)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /TTMIK Grammar Textbook/ });

    await goToLandingPage(user, 2);
    await user.click(screen.getByRole('button', { name: /Korean Folktales/ }));

    // The set view: eyebrow from the manifest, title from the shared set,
    // numbered track rows with status pills.
    expect(await screen.findByRole('heading', { name: '전래 동화 모음' }))
      .toBeInTheDocument();
    const tracks = screen.getByRole('list', { name: 'Tracks in 전래 동화 모음' });
    expect(within(tracks).getAllByRole('listitem')).toHaveLength(2);

    // Open track 1 → the real player + transcript, via GET /audio/tracks/:id.
    await user.click(
      within(tracks).getByRole('button', {
        name: 'Open track 1: 전래 동화 모음 1 (Ready)',
      }),
    );
    expect(
      await screen.findByRole('heading', { name: '전래 동화 모음 1' }),
    ).toBeInTheDocument();
    expect(vi.mocked(getAudioTrack)).toHaveBeenCalledWith(
      7201,
      expect.any(AbortSignal),
    );
    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio).toHaveAttribute('src', '/audio/tracks/7201/stream');
    expect(screen.getByText('옛날 옛적에.')).toBeInTheDocument();
    // The curated eyebrow (its Korean half is unique on this view) — not
    // the "My Audio" default.
    expect(screen.getByText('전래 동화')).toBeInTheDocument();
    expect(screen.queryByText('내 오디오')).not.toBeInTheDocument();
    // Back returns to the owning set's track list.
    expect(
      screen.getByRole('button', { name: 'Back to Korean Folktales' }),
    ).toBeInTheDocument();
  });

  it('a titleless shared track heads "Track N" — never the "My audio" fallback', async () => {
    vi.mocked(getAudioTrack).mockResolvedValue({
      ...SHARED_TRACK_DETAIL,
      track: { ...SHARED_TRACK_DETAIL.track, title: null },
    });
    // Deep link — the number must resolve from the shared listing (the
    // track-detail wire carries none): folktales track 7201 is track 1.
    renderPage('/learn/listen?corpus=shared&set=korean-folktales&track=7201');

    expect(
      await screen.findByRole('heading', { name: 'Track 1' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('My audio')).not.toBeInTheDocument();
  });

  it('deep-links straight into a shared set (?corpus=shared&set=…) without the landing fetch chain', async () => {
    renderPage('/learn/listen?corpus=shared&set=news-in-korean');

    expect(
      await screen.findByRole('heading', { name: '한국어 뉴스' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('list', { name: 'Tracks in 한국어 뉴스' }),
    ).toBeInTheDocument();
    expect(vi.mocked(getTtmikLessons)).not.toHaveBeenCalled();
    expect(vi.mocked(listMyAudio)).not.toHaveBeenCalled();
  });

  it('a manifest slug missing from the fetch renders NO tile for it (no dead tiles)', async () => {
    vi.mocked(getSharedAudio).mockResolvedValue(
      SHARED_SETS.filter((s) => s.slug !== 'jindo-dog'),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /TTMIK Grammar Textbook/ });

    await goToLandingPage(user, 2);
    const stories = screen.getByRole('list', {
      name: 'Stories & News collections',
    });
    // The other three story tiles render; Jindo Dog is simply absent.
    expect(within(stories).getAllByRole('listitem')).toHaveLength(3);
    expect(
      screen.queryByRole('button', { name: /Blue Jindo Dog/ }),
    ).not.toBeInTheDocument();
  });

  it('offers Read only where a reading version exists, navigating to the chapter reader', async () => {
    const user = userEvent.setup();

    // Folktales pairs book_uploads id 17 → the Read action renders.
    renderPage('/learn/listen?corpus=shared&set=korean-folktales');
    await screen.findByRole('heading', { name: '전래 동화 모음' });
    await user.click(screen.getByRole('button', { name: /Read this book/ }));
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/learn/reading?book=17',
    );
  });

  it('an audio-only category (Blue Jindo Dog) renders NO Read action', async () => {
    renderPage('/learn/listen?corpus=shared&set=jindo-dog');
    await screen.findByRole('heading', { name: '파란 진돗개' });

    expect(
      screen.queryByRole('button', { name: /Read this book/ }),
    ).not.toBeInTheDocument();
  });

  it('an empty shared corpus shows the honest empty state on Stories & News — statics untouched', async () => {
    vi.mocked(getSharedAudio).mockResolvedValue([]);
    const user = userEvent.setup();
    renderPage();

    // Statics render regardless…
    expect(
      screen.getByRole('button', { name: /TTMIK Lessons/ }),
    ).toBeInTheDocument();
    // …no curated tile ever appears…
    await waitFor(() => {
      expect(vi.mocked(getSharedAudio)).toHaveBeenCalledTimes(1);
    });
    expect(
      screen.queryByRole('button', { name: /TTMIK Grammar Textbook/ }),
    ).not.toBeInTheDocument();

    // …and the curated-only page says so honestly.
    await goToLandingPage(user, 2);
    expect(
      await screen.findByText('No shared audio yet.'),
    ).toBeInTheDocument();
  });

  it('a shared-corpus fetch failure surfaces fixed-copy error + working retry on the curated page', async () => {
    vi.mocked(getSharedAudio)
      .mockRejectedValueOnce(
        new ApiError('server error', { status: 500, code: 'server_error' }),
      )
      .mockResolvedValueOnce(SHARED_SETS);
    const user = userEvent.setup();
    renderPage();

    await goToLandingPage(user, 2);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Could not load the audio library\./);
    expect(alert).not.toHaveTextContent(/server error/);

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByRole('button', { name: /Korean Folktales/ }),
    ).toBeInTheDocument();
  });

  it('a shared set the fetch no longer carries resolves to the uniform not-found state', async () => {
    vi.mocked(getSharedAudio).mockResolvedValue(
      SHARED_SETS.filter((s) => s.slug !== 'news-in-korean'),
    );
    renderPage('/learn/listen?corpus=shared&set=news-in-korean');

    expect(
      await screen.findByText("That audio set couldn't be found."),
    ).toBeInTheDocument();
  });
});
