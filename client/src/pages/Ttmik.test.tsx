/**
 * Listen page (F-012) — browse tabs, player/detail view, and read-along
 * transcript over stubbed services.
 *
 * The four fetchers in `services/ttmik` are mocked per test; `buildAudioSrc`
 * stays REAL so the assertions cover the actual src the page hands to the
 * `<audio>` element (empty API base in the test env → app-relative path).
 * The audio element has no ARIA role, so presence/absence is asserted via a
 * DOM query — everything else goes through accessible surfaces.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '../services/api';
import {
  getIyagiEpisode,
  getIyagiEpisodes,
  getTtmikLesson,
  getTtmikLessons,
} from '../services/ttmik';
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

// Import after the mock so the page binds the mocked fetchers.
import Ttmik from './Ttmik';

const LESSONS: TtmikLesson[] = [
  { level: 1, number: 1, title: 'Hello / Thank you', hasAudio: true },
  { level: 1, number: 2, title: 'Yes / No', hasAudio: true },
  { level: 2, number: 21, title: 'More / -(으)ㄴ 것 같다', hasAudio: false },
];

const EPISODES: IyagiEpisode[] = [
  { number: 1, title: '서울의 겨울', hasAudio: true },
  { number: 143, title: '한국의 카페 문화', hasAudio: false },
];

/** Sentences arrive deliberately OUT of ordinal order — the page must sort. */
const LESSON_DETAIL: TtmikLessonDetail = {
  meta: { level: 1, number: 1, title: 'Hello / Thank you', hasAudio: true },
  sentences: [
    {
      id: 12,
      ordinal: 2,
      korean: '감사합니다.',
      english: 'Thank you.',
      romanization: 'gamsahamnida',
      speaker: '현우',
      is_dialog: true,
    },
    {
      id: 11,
      ordinal: 1,
      korean: '안녕하세요.',
      english: 'Hello.',
      romanization: 'annyeonghaseyo',
      speaker: null,
      is_dialog: false,
    },
  ],
  audioUrl: '/ttmik/lessons/1/1/audio',
};

const EPISODE_DETAIL: IyagiEpisodeDetail = {
  meta: {
    number: 143,
    title: '한국의 카페 문화',
    hosts: ['경화', '석진'],
    hasAudio: false,
  },
  sentences: [
    {
      id: 31,
      ordinal: 1,
      korean: '요즘 카페 자주 가세요?',
      english: 'Do you go to cafes often these days?',
      romanization: null,
      speaker: '경화',
      is_dialog: true,
    },
  ],
  audioUrl: null,
};

function renderPage(): void {
  render(
    <MemoryRouter>
      <Ttmik />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(getTtmikLessons).mockReset().mockResolvedValue(LESSONS);
  vi.mocked(getIyagiEpisodes).mockReset().mockResolvedValue(EPISODES);
  vi.mocked(getTtmikLesson).mockReset().mockResolvedValue(LESSON_DETAIL);
  vi.mocked(getIyagiEpisode).mockReset().mockResolvedValue(EPISODE_DETAIL);
});

describe('Ttmik page — browse', () => {
  it('renders TTMIK lessons grouped by level with audio indicators', async () => {
    renderPage();

    // Level group headings appear once the list resolves.
    expect(await screen.findByText('Level 1')).toBeInTheDocument();
    expect(screen.getByText('Level 2')).toBeInTheDocument();

    // Rows are accessible buttons carrying the lesson title.
    const lesson1 = screen.getByRole('button', {
      name: 'Open lesson 1: Hello / Thank you',
    });
    expect(within(lesson1).getByText('Audio')).toBeInTheDocument();

    const lesson21 = screen.getByRole('button', {
      name: 'Open lesson 21: More / -(으)ㄴ 것 같다',
    });
    expect(within(lesson21).getByText('No audio')).toBeInTheDocument();
  });

  it('switches to the Iyagi Episodes tab and lists episodes', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Level 1');

    await user.click(screen.getByRole('tab', { name: 'Iyagi Episodes' }));

    expect(
      await screen.findByRole('button', { name: 'Open episode 1: 서울의 겨울' }),
    ).toBeInTheDocument();
    const ep143 = screen.getByRole('button', {
      name: 'Open episode 143: 한국의 카페 문화',
    });
    expect(within(ep143).getByText('No audio')).toBeInTheDocument();
  });

  it('shows the empty state when there are no lessons', async () => {
    vi.mocked(getTtmikLessons).mockResolvedValue([]);
    renderPage();

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

    expect(await screen.findByRole('alert')).toHaveTextContent(/server error/);

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Level 1')).toBeInTheDocument();
    expect(vi.mocked(getTtmikLessons)).toHaveBeenCalledTimes(2);
  });
});

describe('Ttmik page — detail (player + read-along)', () => {
  it('opens a lesson: real audio element with the API-base src, transcript in ordinal order', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Level 1');

    await user.click(
      screen.getByRole('button', { name: 'Open lesson 1: Hello / Thank you' }),
    );

    // Header context for the opened lesson.
    expect(await screen.findByText('Level 1 · Lesson 1')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Hello / Thank you' }),
    ).toBeInTheDocument();

    // A REAL <audio controls> element, src = API base ('' in tests) + audioUrl.
    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio).toHaveAttribute('controls');
    expect(audio).toHaveAttribute('src', '/ttmik/lessons/1/1/audio');

    // Read-along transcript: one row per sentence, ordinal order (the wire
    // fixture is deliberately reversed), Korean + English + romanization,
    // speaker label on the dialog turn.
    const transcript = screen.getByRole('list', { name: 'Transcript' });
    const lines = within(transcript).getAllByRole('listitem');
    expect(lines).toHaveLength(2);
    expect(within(lines[0]!).getByText('안녕하세요.')).toBeInTheDocument();
    expect(within(lines[0]!).getByText('Hello.')).toBeInTheDocument();
    expect(within(lines[0]!).getByText('annyeonghaseyo')).toBeInTheDocument();
    expect(within(lines[0]!).queryByText('현우')).not.toBeInTheDocument();
    expect(within(lines[1]!).getByText('감사합니다.')).toBeInTheDocument();
    expect(within(lines[1]!).getByText('현우')).toBeInTheDocument();

    expect(vi.mocked(getTtmikLesson)).toHaveBeenCalledWith(
      1,
      1,
      expect.any(AbortSignal),
    );
  });

  it('renders transcript-only (no player, a note) when audioUrl is null', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Level 1');

    await user.click(screen.getByRole('tab', { name: 'Iyagi Episodes' }));
    await user.click(
      await screen.findByRole('button', {
        name: 'Open episode 143: 한국의 카페 문화',
      }),
    );

    expect(await screen.findByText('Iyagi · Episode 143')).toBeInTheDocument();
    // Hosts line rides the meta.
    expect(screen.getByText('경화 · 석진')).toBeInTheDocument();

    // No audio mapped → no player, a fixed note instead.
    expect(document.querySelector('audio')).toBeNull();
    expect(screen.getByRole('note')).toHaveTextContent(/No audio/);

    // The transcript still renders.
    const transcript = screen.getByRole('list', { name: 'Transcript' });
    expect(
      within(transcript).getByText('요즘 카페 자주 가세요?'),
    ).toBeInTheDocument();

    expect(vi.mocked(getIyagiEpisode)).toHaveBeenCalledWith(
      143,
      expect.any(AbortSignal),
    );
  });

  it('returns to the browse list via the Browse button', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Level 1');

    await user.click(
      screen.getByRole('button', { name: 'Open lesson 1: Hello / Thank you' }),
    );
    await screen.findByText('Level 1 · Lesson 1');

    await user.click(
      screen.getByRole('button', {
        name: 'Back to all lessons and episodes',
      }),
    );

    expect(await screen.findByText('Level 1')).toBeInTheDocument();
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
    await screen.findByText('Level 1');

    await user.click(
      screen.getByRole('button', { name: 'Open lesson 1: Hello / Thank you' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/not found/);

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Level 1 · Lesson 1')).toBeInTheDocument();
  });
});
