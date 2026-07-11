/**
 * Listen page (F-012, reworked 3C-2: F-071 / F-072 / F-024) — landing tile
 * grid, URL-addressed listings windowed to 15 rows, BackButtons on nested
 * views, detail view with a PERSISTENT audio player + Highlights/Transcript
 * sub-tabs and clickable transcript words (the Read tab's tap chain).
 *
 * The four fetchers in `services/ttmik` are mocked per test; `buildAudioSrc`
 * stays REAL so the assertions cover the actual src the page hands to the
 * `<audio>` element (empty API base in the test env → app-relative path).
 * The tap chain services (lemmatize/define/enrich) are mocked as modules —
 * the page goes through `lib/tapChain.resolveWordPopover`, which calls them.
 * The audio element has no ARIA role, so identity/presence is asserted via
 * DOM queries — everything else goes through accessible surfaces.
 *
 * Layout note: jsdom computes no CSS, so "2 across" itself lives in
 * Ttmik.css (`.km-ttmik__tiles` → `repeat(2, minmax(0, 1fr))`); the tests
 * pin the structural contract that CSS keys on — the labelled tile list,
 * its class hook, and one keyboard-operable button per collection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
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
} from '../services/ttmik';
import { mineWord } from '../services/vocab';
import type {
  IyagiEpisode,
  IyagiEpisodeDetail,
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
  };
});
vi.mock('../services/lemmatize', () => ({ lemmatize: vi.fn() }));
vi.mock('../services/define', () => ({ defineEntry: vi.fn() }));
vi.mock('../services/enrich', () => ({ enrich: vi.fn() }));
vi.mock('../services/vocab', () => ({ mineWord: vi.fn() }));

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

function renderPage(initialEntry = '/learn/listen'): void {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <ToastProvider>
        <Ttmik />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** Landing → TTMIK listing (tiles render synchronously — no fetch first). */
async function openTtmikListing(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.click(screen.getByRole('button', { name: /TTMIK Lessons/ }));
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
});

describe('Ttmik page — landing (F-071)', () => {
  it('renders the collection tile grid — one labelled tile per collection, no list fetch', () => {
    renderPage();

    // The labelled grid list + its CSS hook (the 2-across layout keys on it).
    const grid = screen.getByRole('list', { name: 'Audio collections' });
    expect(grid).toHaveClass('km-ttmik__tiles');
    expect(within(grid).getAllByRole('listitem')).toHaveLength(2);

    // One keyboard-operable button per collection, named by its content.
    expect(
      within(grid).getByRole('button', { name: /TTMIK Lessons/ }),
    ).toBeInTheDocument();
    expect(
      within(grid).getByRole('button', { name: /Iyagi Episodes/ }),
    ).toBeInTheDocument();

    // The landing is pure navigation — neither listing fetch fires.
    expect(vi.mocked(getTtmikLessons)).not.toHaveBeenCalled();
    expect(vi.mocked(getIyagiEpisodes)).not.toHaveBeenCalled();
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
      screen.getByRole('list', { name: 'Audio collections' }),
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

  it('an unknown corpus falls back to the landing (no fetches)', () => {
    renderPage('/learn/listen?corpus=podcasts');

    expect(
      screen.getByRole('list', { name: 'Audio collections' }),
    ).toBeInTheDocument();
    expect(vi.mocked(getTtmikLessons)).not.toHaveBeenCalled();
    expect(vi.mocked(getTtmikLesson)).not.toHaveBeenCalled();
  });

  it('malformed detail numbers fall back to the listing, never into a fetch', async () => {
    renderPage('/learn/listen?corpus=ttmik&level=0&lesson=abc');

    expect(await screen.findByText('Showing 3 of 3')).toBeInTheDocument();
    expect(vi.mocked(getTtmikLesson)).not.toHaveBeenCalled();
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
      { form: '안녕하세요.', lemma: '안녕하세요', tag: 'IC', start: 0, length: 6 },
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
      { form: '안녕하세요.', lemma: '안녕하세요', tag: 'IC', start: 0, length: 6 },
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
